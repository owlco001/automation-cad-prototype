/**
 * 可复用流程模板（P7-I）
 *
 * 设计约束：
 * - 模板是纯数据：不联网、不调模型、不读写文件；工具名必须来自现有注册表；
 * - 参数模板支持 `{ from: 'context.machine.name' }` 这类占位符，执行前统一解析；
 * - 执行器只负责前置条件、逐步骤确认、失败停止与记录，具体工具调用由调用方注入，
 *   因此可在渲染层预览、在主进程执行、在单测里用假执行器验证。
 */

import { READ_ONLY_TOOLS, WRITE_TOOLS } from './router.ts';
import { formatDuration, summarizeArguments } from './feedback.ts';
import { suggestFailure } from './suggest.ts';
import { resolveIterationBudget, type IterationBudget } from './iteration-budget.ts';
import { autoVerifyTool, type ToolVerification, type VerificationChannel } from './verify.ts';
import { describeDesignReview, isDesignReview, runRecipeAggregator, type DesignReview } from './design-review.ts';

export interface RecipePlaceholder {
  from: string;
  default?: unknown;
  optional?: boolean;
}

export interface RecipeStep {
  id: string;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
  /**
   * 关键步骤：失败时即使配方是 `onError:'collect'` 也立即停止。
   * 用于「后面全无意义」的那一步（设计评审的 `get_project_context`：拿不到机型就没得评）。
   */
  critical?: boolean;
}

export interface RecipePrecondition {
  id: string;
  label: string;
  /** 点路径，例如 `context.machine.name`；也接受省略 `context.` 前缀的写法。 */
  from: string;
  /** 前置条件不满足时给用户的可执行动作。 */
  action: string;
  /** 字符串/数组/对象是否要求非空，默认 true。 */
  nonEmpty?: boolean;
  /** 数值下限（含）；仅对 number 生效。 */
  min?: number;
}

export interface Recipe {
  id: string;
  title: string;
  summary: string;
  steps: RecipeStep[];
  preconditions: RecipePrecondition[];
  estimatedSeconds: number;
  /**
   * 失败策略：
   * - `'stop'`（缺省，现有 5 个配方）：某步失败即停，保留已完成步骤；
   * - `'collect'`（设计评审）：某步失败只记录 `status/错误码/中文原因`，继续跑后续步骤，
   *   一次看完。关键步骤（`step.critical`）失败仍立即停。
   */
  onError?: 'stop' | 'collect';
  /** 汇总器 id（见 `design-review.ts#RECIPE_AGGREGATORS`）：全部步骤结束后调用，结果写 `run.aggregate`。 */
  aggregate?: string;
}

export interface RecipeContext extends Record<string, unknown> {
  domain?: 'mech' | 'elec' | null;
  view?: string | null;
  selection?: { kind: string; id: string; label: string } | null;
  machine?: { name: string; stations?: number; actuators?: number; sensors?: number } | null;
  plate?: { width: number; height: number; placed?: number; overlaps?: number } | null;
  units?: 'mm';
  recentActions?: Array<{ tool: string; summary: string; at: string }>;
  /** 当前 CAD 文件路径；由渲染层从场景 source 补齐。 */
  cadPath?: string;
  /** 当前 BOM 行；由渲染层从 `__AgentBridge.getBom()` 补齐。 */
  bom?: unknown[];
}

export interface RecipePreconditionResult {
  ok: boolean;
  missing: RecipePrecondition[];
  labels: string[];
  actions: string[];
}

export interface RecipeResolveResult {
  args: Record<string, unknown>;
  missing: string[];
}

export interface RecipeConfirmRequest {
  recipeId: string;
  recipeTitle: string;
  step: RecipeStep;
  index: number;
  total: number;
  args: Record<string, unknown>;
  tool: string;
  /** assembly=装配写，file=文件写，external=外部副作用。 */
  writeKind: 'assembly' | 'file' | 'external';
  message: string;
}

export type RecipeProgressPhase = 'start' | 'end' | 'skip';

export interface RecipeProgressEvent {
  runId: string;
  phase: RecipeProgressPhase;
  /** 1 基序号。 */
  index: number;
  total: number;
  stepId: string;
  title: string;
  tool: string;
  argsSummary: string;
  startedAt: number;
  source: 'recipe';
  elapsedMs?: number;
  ok?: boolean;
  code?: string;
  message?: string;
}

interface RecipeExecutorBase {
  execute(step: RecipeStep, index: number, signal?: AbortSignal): Promise<unknown>;
  /** 写步骤逐次确认；缺省时写步骤返回 CONFIRMATION_REQUIRED，不静默放行。 */
  confirm?(request: RecipeConfirmRequest): Promise<boolean>;
  /** confirm 的别名。 */
  confirmWrite?(request: RecipeConfirmRequest): Promise<boolean>;
  /** 步 id / 工具名 / 1 基序号；用户取消勾选的步骤会跳过且不调用工具。 */
  skipSteps?: Array<string | number>;
  /** skipSteps 的别名。 */
  skip?: Array<string | number>;
  /** 0 基步骤下标。 */
  skipIndexes?: number[];
  isSkipped?(step: RecipeStep, index: number): boolean;
  /** 显式勾选「本流程内同类操作不再询问」；默认 false，写工具仍逐次确认。 */
  rememberSameKind?: boolean;
  /** rememberSameKind 的别名。 */
  remember?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  /** now 的别名。 */
  clock?: () => number;
  onProgress?: (event: RecipeProgressEvent) => void;
  /** 0 基续跑起点：早于该下标的步骤不再执行（预算停下后续跑用）。 */
  resumeFrom?: number;
  /** 本轮最多执行几步（不含跳过）；与 `executePlan({maxSteps})` 同义，预算还会再收一次。 */
  maxSteps?: number;
  /** 迭代预算基线；缺省 6，含写步骤或步骤 ≥4 时上抬到 12。 */
  maxIterations?: number;
  /** 写后自动验证通道（与 `AgentSession` 同一个 `verify.ts#autoVerifyTool` 入口）。 */
  verifyChannel?: VerificationChannel;
}

export type RecipeExecutor = RecipeExecutorBase;
/** 便捷写法：直接传 `(step,index) => Promise` 时只执行、不提供跳过/确认配置。 */
export type RecipeExecutorInput = RecipeExecutor | ((step: RecipeStep, index: number, signal?: AbortSignal) => Promise<unknown>);

export interface RecipeStepResult {
  index: number;
  /** 1 基序号。 */
  step: number;
  stepId: string;
  title: string;
  tool: string;
  ok: boolean;
  skipped: boolean;
  code: string;
  message?: string;
  elapsedMs: number;
  args?: Record<string, unknown>;
  data?: unknown;
  suggestion?: string;
  /** 写后自动验证结论（只附字段，不改变 ok）。 */
  verification?: ToolVerification;
}

export interface RecipeError {
  code: string;
  message: string;
  missing?: string[];
  suggestions?: string[];
}

export interface RecipeRunResult {
  ok: boolean;
  code: string;
  recipeId: string;
  recipeTitle: string;
  runId: string;
  results: RecipeStepResult[];
  /** 失败前已成功的步骤（跳过的不算）。 */
  completed: RecipeStepResult[];
  /** completed 的稳定别名，便于报告与冒烟统计。 */
  kept: RecipeStepResult[];
  skipped: RecipeStepResult[];
  failedStep?: RecipeStepResult;
  failedAt?: number;
  failedTool?: string;
  errorCode?: string;
  suggestion?: string;
  missing?: string[];
  suggestions?: string[];
  preconditionFailed?: boolean;
  totalMs: number;
  summary: string;
  report: string;
  error?: RecipeError;
  /** 本轮预算（与会话层 `turnOutcome().budget` 同源）。 */
  budget?: IterationBudget;
  /** 本轮实际执行（不含跳过）的步骤数。 */
  iterations?: number;
  /** 续跑起点（0 基）；非续跑时不出现。 */
  resumedFrom?: number;
  /** 预算用尽而停下；已完成的步骤保留在 results / completed 里。 */
  stopped?: 'iteration_limit';
  /** 停下时给用户的下一步说法。 */
  pendingHint?: string;
  /** 预算停下时的 0 基续跑位置（= 第一个未执行步骤）。 */
  nextStepIndex?: number;
  /** `onError:'collect'` 时收集到的失败步骤（按执行顺序，可能多条）；`'stop'` 配方为空数组/不出现。 */
  stepFailures?: RecipeStepResult[];
  /** 汇总器结论（`review-design` 为 `DesignReview`）；只有带 `aggregate` 的配方才有。 */
  aggregate?: DesignReview | unknown;
}

export const DEFAULT_RECIPE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS
]);

const CONTEXT_PREFIX = 'context.';

function placeholder(value: unknown): RecipePlaceholder | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.from !== 'string' || !record.from.trim()) return null;
  const keys = Object.keys(record);
  if (keys.some((key) => !['from', 'default', 'optional'].includes(key))) return null;
  // 线缆端点 `{from:'QF1'}` 这类普通参数没有点路径，不当作占位符。
  return record.from.includes('.') || record.from.startsWith(CONTEXT_PREFIX) ? record as unknown as RecipePlaceholder : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextRoot(ctx: RecipeContext): Record<string, unknown> {
  if (isRecord(ctx.context)) return ctx.context;
  return ctx;
}

/** 读取点路径；缺失返回 undefined（不把空字符串当成缺失）。 */
export function readContextPath(ctx: RecipeContext, path: string): unknown {
  const normalized = path.startsWith(CONTEXT_PREFIX) ? path.slice(CONTEXT_PREFIX.length) : path;
  if (!normalized) return undefined;
  let current: unknown = contextRoot(ctx);
  for (const segment of normalized.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function resolveValue(value: unknown, ctx: RecipeContext, missing: string[]): unknown {
  const spec = placeholder(value);
  if (spec) {
    const resolved = readContextPath(ctx, spec.from);
    if (resolved !== undefined && resolved !== null) return resolveValue(resolved, ctx, missing);
    if (spec.default !== undefined) return resolveValue(spec.default, ctx, missing);
    if (spec.optional !== true) missing.push(spec.from);
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => resolveValue(item, ctx, missing))
      .filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveValue(item, ctx, missing);
      if (resolved !== undefined) output[key] = resolved;
    }
    return output;
  }
  return value;
}

/** 解析单个参数模板；缺失的必填占位符会以点路径数组返回。 */
export function resolvePlaceholders(value: unknown, ctx: RecipeContext = {}): unknown {
  return resolveValue(value, ctx, []);
}

/** 解析整份 args；同时返回缺失占位符，供 UI 点名。 */
export function resolveRecipeArgs(
  template: Record<string, unknown>,
  ctx: RecipeContext = {}
): RecipeResolveResult {
  const missing: string[] = [];
  const args = resolveValue(template, ctx, missing) as Record<string, unknown>;
  return { args, missing };
}

/** 兼容别名：有些调用方更愿意把模板解析叫 resolveTemplateArgs。 */
export const resolveTemplateArgs = resolveRecipeArgs;

/** 解析单步：返回步骤副本、已解析参数与缺失占位符。 */
export function resolveRecipeStep(step: RecipeStep, ctx: RecipeContext = {}): RecipeStep & { missing: string[] } {
  const resolved = resolveRecipeArgs(step.args, ctx);
  return { ...step, args: resolved.args, missing: resolved.missing };
}

function valueMissing(value: unknown, rule: RecipePrecondition): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') {
    return rule.nonEmpty !== false && value.trim().length === 0;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return true;
    return typeof rule.min === 'number' && value < rule.min;
  }
  if (Array.isArray(value)) return rule.nonEmpty !== false && value.length === 0;
  if (isRecord(value)) return rule.nonEmpty !== false && Object.keys(value).length === 0;
  return false;
}

/** 逐条检查前置条件；不满足时返回缺什么与建议动作，不执行任何工具。 */
export function checkRecipePreconditions(recipe: Recipe, ctx: RecipeContext = {}): RecipePreconditionResult {
  const missing: RecipePrecondition[] = [];
  for (const rule of recipe.preconditions) {
    if (valueMissing(readContextPath(ctx, rule.from), rule)) missing.push(rule);
  }
  return {
    ok: missing.length === 0,
    missing,
    labels: missing.map((item) => item.label),
    actions: missing.map((item) => item.action)
  };
}

/** 别名，语义更直白。 */
export const evaluatePreconditions = checkRecipePreconditions;

const RECIPES: Recipe[] = [
  {
    id: 'new-machine',
    title: '新机台快速起步',
    summary: '从 CAD 导入开始，一次跑完 BOM、干涉、电气与成本，用于新机型首轮评估。',
    preconditions: [
      {
        id: 'machine',
        label: '机型配置（机台名称）',
        from: 'context.machine.name',
        action: '先在「联调 / PLC 程序」面板选择机型，或打开机型配置后重试。'
      },
      {
        id: 'cad-path',
        label: 'CAD 文件路径',
        from: 'context.cadPath',
        action: '先通过「CAD 查看」打开 STEP / IGES 文件，或把导入步骤取消勾选后从已有模型继续。'
      }
    ],
    estimatedSeconds: 45,
    steps: [
      {
        id: 'import-cad',
        title: '导入 CAD',
        tool: 'import_cad',
        args: { path: { from: 'context.cadPath', default: '' } },
        why: '导入当前机台的 STEP / IGES 模型，作为 BOM 与干涉检查的输入（需确认）。'
      },
      {
        id: 'generate-bom',
        title: '生成 BOM',
        tool: 'get_bom',
        args: {},
        why: '读取当前装配体的简化 BOM，作为电气与成本步骤的数据源。'
      },
      {
        id: 'interference',
        title: '干涉检查',
        tool: 'run_interference_check',
        args: {},
        why: '对导入后的装配体做包围盒级干涉初筛，先暴露明显碰撞。'
      },
      {
        id: 'electrical',
        title: '电气检查',
        tool: 'run_electrical_check',
        args: {},
        why: '读取当前电气文档，校验线号、功率与导线截面。'
      },
      {
        id: 'cost',
        title: '成本估算',
        tool: 'run_cost_report',
        args: {},
        why: '按 BOM、底板与价格簿估算整机硬件、辅材、人工与税。'
      }
    ]
  },
  {
    id: 'plate-delivery',
    title: '底板布置交付',
    summary: '面向电箱底板布置：先查数据缺口与未放置件，再做冲突检查并导出底板记录。',
    preconditions: [
      {
        id: 'machine',
        label: '机型配置（机台名称）',
        from: 'context.machine.name',
        action: '先在「联调 / PLC 程序」面板选择机型，确保导出文件名可追溯。'
      },
      {
        id: 'plate-width',
        label: '底板宽度',
        from: 'context.plate.width',
        action: '打开「底板布置」面板并设置底板宽度（mm）后重试。',
        min: 1
      },
      {
        id: 'plate-height',
        label: '底板高度',
        from: 'context.plate.height',
        action: '打开「底板布置」面板并设置底板高度（mm）后重试。',
        min: 1
      }
    ],
    estimatedSeconds: 20,
    steps: [
      {
        id: 'check-dimensions',
        title: '检查缺尺寸',
        tool: 'get_bom',
        args: {},
        why: '读取 BOM 行，结合元件库标记缺少外形尺寸、无法可靠放置的物料。'
      },
      {
        id: 'list-unplaced',
        title: '列出未放置件',
        tool: 'get_project_context',
        args: {},
        why: '读取底板已放置数量、重叠数与最近操作，列出尚未落到底板的物料。'
      },
      {
        id: 'plate-conflict',
        title: '底板冲突检查',
        tool: 'run_interference_check',
        args: {},
        why: '复用包围盒冲突初筛，检查底板布置中的重叠与越界候选。'
      },
      {
        id: 'export-plate',
        title: '导出底板 JSON',
        tool: 'export_files',
        args: {
          kind: 'bom',
          fileName: { from: 'context.machine.name', default: '底板布置' }
        },
        why: '把底板布置与 BOM 明细落到导出目录；布局字段同步保留在本次执行记录中（需确认）。'
      }
    ]
  },
  {
    id: 'electrical-delivery',
    title: '电气交付',
    summary: '电气合规检查、修正提示、PLC 预检、生成落盘与交付 PDF 一次串起。',
    preconditions: [
      {
        id: 'machine',
        label: '机型配置（机台名称）',
        from: 'context.machine.name',
        action: '先在「联调 / PLC 程序」面板选择机型并确认 IO 点位配置。'
      }
    ],
    estimatedSeconds: 90,
    steps: [
      {
        id: 'electrical-check',
        title: '电气合规',
        tool: 'run_electrical_check',
        args: {},
        why: '校验线号重复、载流量、断路器配合与 24V 余量，先拿到问题清单。'
      },
      {
        id: 'fix-hints',
        title: '修正提示',
        tool: 'get_project_context',
        args: {},
        why: '读取当前机型、视图与选中对象，为电气问题补上可定位的修正提示。'
      },
      {
        id: 'plc-precheck',
        title: 'PLC 预检',
        tool: 'verify_plc_program',
        args: {},
        why: '只读执行 PLC 预检与内置模拟器，确认 0 error 后再落盘。'
      },
      {
        id: 'plc-generate',
        title: '生成 PLC 并落盘',
        tool: 'run_plc_generate',
        args: {},
        why: '按当前机型生成 11 个 PLC 文件并写入 exports/plc/（需确认；预检失败不落盘）。'
      },
      {
        id: 'delivery-pdf',
        title: '导出交付 PDF',
        tool: 'export_files',
        args: {
          kind: 'pdf',
          fileName: { from: 'context.machine.name', default: '电气交付' }
        },
        why: '导出 A3 装配 / 电气交付报告，随 PLC 目录一起交付（需确认）。'
      }
    ]
  },
  {
    id: 'cost-review',
    title: '成本核对',
    summary: '读 BOM、跑成本、导出 CSV，并单独标注缺价件，适合报价前复核。',
    preconditions: [
      {
        id: 'bom',
        label: 'BOM 数据（至少 1 行）',
        from: 'context.bom',
        action: '先导入 CAD 或从底板/AI 占位件生成 BOM，再运行成本核对。'
      }
    ],
    estimatedSeconds: 30,
    steps: [
      {
        id: 'read-bom',
        title: '读 BOM',
        tool: 'get_bom',
        args: {},
        why: '读取当前 BOM，作为成本计算的唯一物料输入。'
      },
      {
        id: 'run-cost',
        title: '跑成本',
        tool: 'run_cost_report',
        args: {},
        why: '按 BOM 与价格簿计算硬件、辅材、人工、税与加成。'
      },
      {
        id: 'export-csv',
        title: '导出 CSV',
        tool: 'export_cost_report',
        args: { format: 'csv' },
        why: '把成本明细落盘为 UTF-8 BOM 的 CSV，便于 Excel 复核（需确认）。'
      },
      {
        id: 'flag-missing-price',
        title: '标注缺价件',
        tool: 'run_cost_report',
        args: {},
        why: '复用成本报告中的 missingPrices / warnings 清单，逐条标注待询价物料。'
      }
    ]
  },
  {
    id: 'full-package',
    title: '整包交付',
    summary: '把前四个流程串起来：CAD/BOM/校核/成本，导出 BOM、PDF 与 PLC 目录。',
    preconditions: [
      {
        id: 'machine',
        label: '机型配置（机台名称）',
        from: 'context.machine.name',
        action: '先在「联调 / PLC 程序」面板选择机型后重试。'
      },
      {
        id: 'plate-width',
        label: '底板宽度',
        from: 'context.plate.width',
        action: '打开「底板布置」面板并设置底板尺寸后重试。',
        min: 1
      }
    ],
    estimatedSeconds: 180,
    steps: [
      {
        id: 'import-cad',
        title: '导入 CAD',
        tool: 'import_cad',
        args: { path: { from: 'context.cadPath', default: '' } },
        why: '导入当前机台模型，作为整包交付的输入（需确认）。'
      },
      {
        id: 'generate-bom',
        title: '生成 BOM',
        tool: 'get_bom',
        args: {},
        why: '生成整包 BOM。'
      },
      {
        id: 'interference',
        title: '干涉检查',
        tool: 'run_interference_check',
        args: {},
        why: '整包交付前的机械干涉初筛。'
      },
      {
        id: 'electrical',
        title: '电气检查',
        tool: 'run_electrical_check',
        args: {},
        why: '整包交付前的电气合规检查。'
      },
      {
        id: 'cost',
        title: '成本估算',
        tool: 'run_cost_report',
        args: {},
        why: '整包交付前的成本快照。'
      },
      {
        id: 'export-bom',
        title: '导出 BOM',
        tool: 'export_files',
        args: {
          kind: 'bom',
          fileName: { from: 'context.machine.name', default: '整包' }
        },
        why: '导出 BOM CSV（需确认）。'
      },
      {
        id: 'export-pdf',
        title: '导出 PDF',
        tool: 'export_files',
        args: {
          kind: 'pdf',
          fileName: { from: 'context.machine.name', default: '整包' }
        },
        why: '导出 A3 装配报告 PDF（需确认）。'
      },
      {
        id: 'export-plc',
        title: '导出 PLC 目录',
        tool: 'run_plc_generate',
        args: {},
        why: '生成 11 个 PLC 文件并写入 exports/plc/（需确认；预检失败不落盘）。'
      }
    ]
  },
  {
    id: 'review-design',
    title: '设计评审',
    // 一句话回答「这台机器能不能出图」：一次跑完 4 项检查，由 design-review.ts 汇总成 PASS/WARN/FAIL。
    summary: '把当前机型从头到尾评一遍：结构校验、三态干涉、电气合规、成本缺价，一次看完并给出带数字证据的结论。',
    // 评审的第一步就是取上下文，所以这里不再重复声明「机型」前置条件：
    // 拿不到机型由第 1 步（critical）直接停下，避免同一个原因报两遍。
    preconditions: [],
    estimatedSeconds: 45,
    // 评审的价值在「一次看完」：中间某步失败只记录，继续跑后续步骤。
    onError: 'collect',
    aggregate: 'design-review',
    steps: [
      {
        id: 'context',
        title: '取工程上下文',
        tool: 'get_project_context',
        args: {},
        why: '拿当前机型、工位与 BOM 行数，作为后面 4 项检查的定位锚点；拿不到机型就没得评，直接停。',
        critical: true
      },
      {
        id: 'structure',
        title: '结构校验',
        tool: 'validate_machine_design',
        args: {},
        why: '与 apply_machine_design / run_plc_generate 同一份判定源，先看结构、点位唯一性、工位引用与传感器绑定。'
      },
      {
        id: 'interference',
        title: '三态干涉',
        tool: 'run_interference_check',
        args: { states: ['rest', 'lift', 'sweep'] },
        why: '静态 / 顶升到位 / 逐步顶升三态各查一遍，避免「静态没事、动起来撞」；无顶升轴时记为 N/A，不算失败。'
      },
      {
        id: 'electrical',
        title: '电气合规',
        tool: 'run_electrical_check',
        args: {},
        why: '校验线号、载流量、断路器配合与 24V 余量，取过载/压降/断路器三项实际值。'
      },
      {
        id: 'cost',
        title: '成本缺价',
        tool: 'run_cost_report',
        args: {},
        why: '只取缺价条数与总价，不导出报表：报价能不能给，看这一项。'
      }
    ]
  }
];

export { RECIPES };

export const RECIPE_TEMPLATES = RECIPES;

const RECIPE_ALIASES: Record<string, string> = {
  'new-machine-quickstart': 'new-machine',
  'plate-layout-delivery': 'plate-delivery',
  'electrical': 'electrical-delivery',
  'cost': 'cost-review',
  'full-delivery': 'full-package',
  'review': 'review-design',
  'design-review': 'review-design'
};

export function listRecipes(): Recipe[] {
  return RECIPES.map((recipe) => ({
    ...recipe,
    steps: recipe.steps.map((step) => ({ ...step, args: { ...step.args } })),
    preconditions: recipe.preconditions.map((rule) => ({ ...rule }))
  }));
}

export function getRecipe(recipeId: string): Recipe | undefined {
  const key = String(recipeId ?? '').trim();
  if (!key) return undefined;
  const normalized = RECIPE_ALIASES[key] ?? key;
  return RECIPES.find((recipe) => recipe.id === normalized || recipe.title === key);
}

export type RecipeToolSource = ReadonlySet<string> | Iterable<string | { name?: unknown }>;

function toolSet(availableTools?: RecipeToolSource): Set<string> {
  if (availableTools === undefined) return new Set(DEFAULT_RECIPE_TOOL_NAMES);
  const names = new Set<string>();
  for (const item of availableTools) {
    if (typeof item === 'string' && item.trim()) names.add(item);
    else if (isRecord(item) && typeof item.name === 'string' && item.name.trim()) names.add(item.name);
  }
  return names;
}

function validatePlaceholders(value: unknown, where: string, errors: string[]): void {
  const spec = placeholder(value);
  if (spec) {
    if (!spec.from.trim()) errors.push(`${where}: 占位符 from 不能为空`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePlaceholders(item, `${where}[${index}]`, errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) validatePlaceholders(item, `${where}.${key}`, errors);
  }
}

/** 返回中文错误列表；空数组表示模板合法。 */
export function validateRecipe(
  recipe: Recipe,
  availableTools: RecipeToolSource = DEFAULT_RECIPE_TOOL_NAMES
): string[] {
  const errors: string[] = [];
  const tools = toolSet(availableTools);
  if (!recipe || typeof recipe !== 'object') return ['模板必须是对象'];
  if (typeof recipe.id !== 'string' || !recipe.id.trim()) errors.push('缺少 id');
  if (typeof recipe.title !== 'string' || !recipe.title.trim()) errors.push(`${recipe.id || '模板'} 缺少 title`);
  if (typeof recipe.summary !== 'string' || !recipe.summary.trim()) errors.push(`${recipe.id || '模板'} 缺少 summary`);
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) errors.push(`${recipe.id || '模板'} 至少需要 1 个步骤`);
  if (!Array.isArray(recipe.preconditions)) errors.push(`${recipe.id || '模板'} preconditions 必须是数组`);
  if (typeof recipe.estimatedSeconds !== 'number' || !Number.isFinite(recipe.estimatedSeconds) || recipe.estimatedSeconds <= 0) {
    errors.push(`${recipe.id || '模板'} estimatedSeconds 必须是正数`);
  }
  const stepIds = new Set<string>();
  for (const [index, step] of (recipe.steps ?? []).entries()) {
    const label = `${recipe.id || '模板'} 第 ${index + 1} 步`;
    if (!step || typeof step !== 'object') {
      errors.push(`${label}: 不是对象`);
      continue;
    }
    if (typeof step.id !== 'string' || !step.id.trim()) errors.push(`${label}: 缺少 id`);
    else if (stepIds.has(step.id)) errors.push(`${label}: 步骤 id 重复 ${step.id}`);
    else stepIds.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim()) errors.push(`${label}: 缺少 title`);
    if (typeof step.tool !== 'string' || !step.tool.trim()) errors.push(`${label}: 缺少 tool`);
    else if (!tools.has(step.tool)) errors.push(`${label}: 工具名不存在 ${step.tool}`);
    if (!isRecord(step.args)) errors.push(`${label}: args 必须是对象`);
    else validatePlaceholders(step.args, `${label}.args`, errors);
    if (typeof step.why !== 'string' || !step.why.trim()) errors.push(`${label}: 缺少 why`);
  }
  for (const [index, rule] of (recipe.preconditions ?? []).entries()) {
    const label = `${recipe.id || '模板'} 前置条件 ${index + 1}`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${label}: 不是对象`);
      continue;
    }
    if (typeof rule.id !== 'string' || !rule.id.trim()) errors.push(`${label}: 缺少 id`);
    if (typeof rule.label !== 'string' || !rule.label.trim()) errors.push(`${label}: 缺少 label`);
    if (typeof rule.from !== 'string' || !rule.from.trim()) errors.push(`${label}: 缺少 from`);
    if (typeof rule.action !== 'string' || !rule.action.trim()) errors.push(`${label}: 缺少 action`);
  }
  return errors;
}

export function validateRecipes(
  recipes: Recipe[] = RECIPES,
  availableTools: RecipeToolSource = DEFAULT_RECIPE_TOOL_NAMES
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const recipe of recipes) {
    if (ids.has(recipe.id)) errors.push(`模板 id 重复: ${recipe.id}`);
    ids.add(recipe.id);
    errors.push(...validateRecipe(recipe, availableTools));
  }
  return errors;
}

function writeKind(tool: string): 'assembly' | 'file' | 'external' {
  if (tool === 'run_plc_generate' || tool === 'export_files' || tool === 'export_cost_report' || tool === 'import_cad') {
    return 'file';
  }
  if (tool === 'sync_design_package' || tool === 'start_commission') return 'external';
  return 'assembly';
}

function normalizeToolResult(raw: unknown): { ok: boolean; code: string; message?: string; data?: unknown } {
  if (isRecord(raw)) {
    const nestedError = isRecord(raw.error) ? raw.error : null;
    const ok = raw.ok === undefined ? !nestedError : raw.ok === true;
    const code = ok
      ? (typeof raw.code === 'string' ? raw.code : 'OK')
      : (typeof raw.code === 'string'
        ? raw.code
        : nestedError && typeof nestedError.code === 'string' ? nestedError.code : 'TOOL_FAILED');
    const message = typeof raw.message === 'string'
      ? raw.message
      : nestedError && typeof nestedError.message === 'string' ? nestedError.message : undefined;
    return { ok, code, ...(message ? { message } : {}), data: raw.data !== undefined ? raw.data : raw };
  }
  if (raw === false) return { ok: false, code: 'TOOL_FAILED', message: '工具返回 false' };
  return { ok: true, code: 'OK', ...(raw === undefined ? {} : { data: raw }) };
}

function stepResult(input: {
  step: RecipeStep;
  index: number;
  ok: boolean;
  skipped?: boolean;
  code: string;
  elapsedMs: number;
  message?: string;
  args?: Record<string, unknown>;
  data?: unknown;
}): RecipeStepResult {
  return {
    index: input.index,
    step: input.index + 1,
    stepId: input.step.id,
    title: input.step.title,
    tool: input.step.tool,
    ok: input.ok,
    skipped: input.skipped === true,
    code: input.code,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ...(input.message ? { message: input.message } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.data !== undefined ? { data: input.data } : {})
  };
}

function shouldSkip(step: RecipeStep, index: number, executor: RecipeExecutor): boolean {
  try {
    if (executor.isSkipped?.(step, index)) return true;
  } catch (error) {
    // 选择器异常按「未跳过」处理，避免静默漏步骤。
    console.warn(`[RECIPE_SELECTOR_SKIP_CHECK_FAILED]`, { site: 'desktop/src/agent/recipes.ts:788' }, error);
  }
  const skipSteps = [
    ...(Array.isArray(executor.skipSteps) ? executor.skipSteps : []),
    ...(Array.isArray(executor.skip) ? executor.skip : [])
  ].map((value) => String(value));
  if (skipSteps.includes(step.id) || skipSteps.includes(step.tool) || skipSteps.includes(String(index + 1))) return true;
  const skipIndexes = Array.isArray(executor.skipIndexes) ? executor.skipIndexes : [];
  return skipIndexes.includes(index);
}

function abortResult(
  recipe: Recipe,
  runId: string,
  startedAt: number,
  now: () => number,
  results: RecipeStepResult[],
  completed: RecipeStepResult[],
  skipped: RecipeStepResult[]
): RecipeRunResult {
  const totalMs = Math.max(0, now() - startedAt);
  return {
    ok: false,
    code: 'CANCELLED',
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    runId,
    results,
    completed,
    kept: completed,
    skipped,
    totalMs,
    summary: `流程「${recipe.title}」已取消；已完成 ${completed.length} 步${completed.length > 0 ? `：${completed.map((item) => item.title).join('、')}` : ''}。`,
    report: `流程「${recipe.title}」已取消，未继续执行后续步骤。`,
    error: { code: 'CANCELLED', message: '用户取消流程' }
  };
}

function failedRun(
  recipe: Recipe,
  runId: string,
  totalMs: number,
  results: RecipeStepResult[],
  completed: RecipeStepResult[],
  skipped: RecipeStepResult[],
  failed: RecipeStepResult,
  errorCode: string
): RecipeRunResult {
  const advice = suggestFailure({
    code: errorCode,
    ...(failed.message ? { message: failed.message } : {}),
    tool: failed.tool,
    args: failed.args ?? {}
  });
  failed.suggestion = advice.advice;
  const remaining = Math.max(0, recipe.steps.length - results.length);
  const completedText = completed.length > 0
    ? `已完成清单：${completed.map((item) => `第 ${item.step} 步「${item.title}」（${item.tool}）`).join('、')}。`
    : '已完成清单：无（第一步即失败）。';
  const summary = `第 ${failed.step} 步「${failed.title}」（${failed.tool}）失败（${errorCode}）${failed.message ? `：${failed.message}` : ''}；已停止后续 ${remaining} 步。${completedText}`;
  const report = [
    `流程「${recipe.title}」执行失败。`,
    `失败步骤：第 ${failed.step} 步「${failed.title}」（${failed.tool}）`,
    `错误码：${errorCode}`,
    failed.message ? `错误信息：${failed.message}` : '',
    `建议：${advice.advice}`,
    advice.alternatives.length > 0 ? `可选动作：${advice.alternatives.slice(0, 3).join(' / ')}` : '',
    completedText,
    skipped.length > 0 ? `已跳过：${skipped.map((item) => item.title).join('、')}。` : ''
  ].filter(Boolean).join('\n');
  return {
    ok: false,
    code: 'STEP_FAILED',
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    runId,
    results,
    completed,
    kept: completed,
    skipped,
    failedStep: failed,
    failedAt: failed.step,
    failedTool: failed.tool,
    errorCode,
    suggestion: advice.advice,
    totalMs,
    summary,
    report,
    error: { code: errorCode, message: failed.message ?? summary }
  };
}

/**
 * `onError:'collect'` 的收尾：所有步骤都跑过了（含失败的那些）。
 *
 * 语义：`ok:true` 表示「流程跑完了」，不等于「每步都成功」——失败步骤留在
 * `results` / `stepFailures` 里，最终结论由汇总器（`aggregate`）给出。
 * 这与 `'stop'` 配方的 `failedRun` 刻意区分：那里 `ok:false` + `failedStep` 是「流程中断」。
 */
function collectRun(
  recipe: Recipe,
  runId: string,
  totalMs: number,
  results: RecipeStepResult[],
  completed: RecipeStepResult[],
  skipped: RecipeStepResult[],
  failures: RecipeStepResult[]
): RecipeRunResult {
  for (const failure of failures) {
    if (!failure.suggestion) {
      const advice = suggestFailure({
        code: failure.code,
        ...(failure.message ? { message: failure.message } : {}),
        tool: failure.tool,
        args: failure.args ?? {}
      });
      failure.suggestion = advice.advice;
    }
  }
  const failedText = failures.length > 0
    ? failures.map((item) => `第 ${item.step} 步「${item.title}」（${item.tool}）${item.code}`
      + `${item.code === 'STATE_UNAVAILABLE' ? '，评审记 N/A' : ''}`).join('、')
    : '';
  const summary = failures.length > 0
    ? `流程「${recipe.title}」已跑完 ${results.length}/${recipe.steps.length} 步（一次看完）：${failures.length} 步失败——${failedText}；其余 ${completed.length} 步结果已保留。`
    : `流程「${recipe.title}」已完成 ${completed.length}/${recipe.steps.length} 步；总耗时 ${formatDuration(totalMs)}。`;
  const report = [
    `流程「${recipe.title}」执行完毕（collect 策略：单步失败不中断）。`,
    `步骤：${results.map((item) => `第 ${item.step} 步「${item.title}」（${item.tool}，${item.ok ? '成功' : `失败 ${item.code}`}${item.skipped ? '，跳过' : ''}）`).join('、') || '无'}`,
    failedText ? `失败（未中断）：${failedText}` : '失败：无',
    skipped.length > 0 ? `跳过：${skipped.map((item) => `第 ${item.step} 步「${item.title}」`).join('、')}` : '',
    `总耗时：${formatDuration(totalMs)}`
  ].filter(Boolean).join('\n');
  return {
    ok: true,
    code: failures.length > 0 ? 'COLLECTED_WITH_ERRORS' : 'OK',
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    runId,
    results,
    completed,
    kept: completed,
    skipped,
    stepFailures: failures,
    totalMs,
    summary,
    report
  };
}

/**
 * 汇总接线：全部步骤跑完后调用配方声明的汇总器（纯函数，不调工具）。
 * 结论同时写进 `aggregate` 字段与 `summary` / `report`，UI 与导出的 Markdown 都不用改渲染逻辑。
 */
function attachAggregate(recipe: Recipe, output: RecipeRunResult): RecipeRunResult {
  if (!recipe.aggregate || output.ok !== true) return output;
  const aggregate = runRecipeAggregator(recipe.aggregate, output.results);
  if (aggregate === undefined) return output;
  if (!isDesignReview(aggregate)) return { ...output, aggregate };
  const review: DesignReview = aggregate;
  return {
    ...output,
    aggregate: review,
    summary: `${review.summary}｜${output.summary}`,
    report: `${output.report}\n\n## 评审结论\n\n${describeDesignReview(review)}`
  };
}

function successRun(
  recipe: Recipe,
  runId: string,
  totalMs: number,
  results: RecipeStepResult[],
  completed: RecipeStepResult[],
  skipped: RecipeStepResult[]
): RecipeRunResult {
  const skippedText = skipped.length > 0 ? `，跳过 ${skipped.length} 步` : '';
  const unverified = results
    .filter((item) => item.verification?.ok === false)
    .map((item) => `第 ${item.step} 步 ${item.tool}${item.verification?.nextAction ? `（${item.verification.nextAction}）` : ''}`);
  const summary = `流程「${recipe.title}」已完成 ${completed.length}/${recipe.steps.length} 步${skippedText}；总耗时 ${formatDuration(totalMs)}。`
    + (unverified.length > 0 ? `写后自查未通过：${unverified.join('、')}。` : '');
  const report = [
    `流程「${recipe.title}」执行成功。`,
    `完成：${completed.map((item) => `第 ${item.step} 步「${item.title}」（${item.tool}，${formatDuration(item.elapsedMs)}）`).join('、') || '无'}`,
    skipped.length > 0 ? `跳过：${skipped.map((item) => `第 ${item.step} 步「${item.title}」`).join('、')}` : '',
    `总耗时：${formatDuration(totalMs)}`
  ].filter(Boolean).join('\n');
  return {
    ok: true,
    code: 'OK',
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    runId,
    results,
    completed,
    kept: completed,
    skipped,
    totalMs,
    summary,
    report
  };
}

/**
 * 预算用尽时的收尾：已执行的步骤全部保留，明确告诉用户下一步从哪继续。
 * 不作为「失败」处理（没有 failedStep），但 `ok:false`，因为流程没跑完。
 */
function budgetStop(
  recipe: Recipe,
  runId: string,
  totalMs: number,
  results: RecipeStepResult[],
  completed: RecipeStepResult[],
  skipped: RecipeStepResult[],
  budget: IterationBudget,
  executed: number,
  nextStepIndex: number
): RecipeRunResult {
  const remaining = Math.max(0, recipe.steps.length - nextStepIndex);
  const pendingHint = `本轮已执行 ${executed} 步，达到预算上限 ${budget.effective}（原因 ${budget.reason}）；`
    + `还剩 ${remaining} 步未执行，说「继续」会从第 ${nextStepIndex + 1} 步接着跑`;
  const summary = `流程「${recipe.title}」执行到预算上限：本轮完成 ${completed.length} 步，第 ${nextStepIndex + 1} 步起未执行（共 ${recipe.steps.length} 步）。`;
  const completedText = completed.length > 0
    ? `已完成清单：${completed.map((item) => `第 ${item.step} 步「${item.title}」（${item.tool}）`).join('、')}。`
    : '已完成清单：无。';
  const report = [
    summary,
    `下一步：${pendingHint}`,
    completedText,
    skipped.length > 0 ? `已跳过：${skipped.map((item) => item.title).join('、')}。` : ''
  ].filter(Boolean).join('\n');
  return {
    ok: false,
    code: 'ITERATION_LIMIT',
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    runId,
    results,
    completed,
    kept: completed,
    skipped,
    totalMs,
    budget,
    iterations: executed,
    stopped: 'iteration_limit',
    pendingHint,
    nextStepIndex,
    summary,
    report,
    error: { code: 'ITERATION_LIMIT', message: summary }
  };
}

/** 执行流程：前置条件 → 可跳过步骤 → 写步骤逐次确认 → 失败停止并保留已完成。 */
export async function runRecipe(
  recipeId: string,
  ctx: RecipeContext = {},
  executor: RecipeExecutorInput
): Promise<RecipeRunResult> {
  const exec: RecipeExecutor = typeof executor === 'function'
    ? { execute: executor }
    : (executor ?? { execute: async () => ({ ok: false, code: 'EXECUTOR_MISSING', message: '流程执行器缺失' }) });
  const recipe = getRecipe(recipeId);
  const now = exec.now ?? exec.clock ?? (() => Date.now());
  const startedAt = now();
  const runId = `recipe-${recipe?.id ?? String(recipeId ?? 'unknown')}-${startedAt}`;
  if (!recipe) {
    return {
      ok: false,
      code: 'RECIPE_NOT_FOUND',
      recipeId: String(recipeId ?? ''),
      recipeTitle: '',
      runId,
      results: [],
      completed: [],
      kept: [],
      skipped: [],
      totalMs: 0,
      summary: `流程模板不存在：${recipeId}`,
      report: `流程模板不存在：${recipeId}`,
      error: { code: 'RECIPE_NOT_FOUND', message: `流程模板不存在：${recipeId}` }
    };
  }

  const pre = checkRecipePreconditions(recipe, ctx);
  if (!pre.ok) {
    const summary = `流程「${recipe.title}」前置条件未满足，未执行任何步骤。缺少：${pre.labels.join('、')}。`;
    return {
      ok: false,
      code: 'PRECONDITION_FAILED',
      recipeId: recipe.id,
      recipeTitle: recipe.title,
      runId,
      results: [],
      completed: [],
      kept: [],
      skipped: [],
      missing: pre.labels,
      suggestions: pre.actions,
      preconditionFailed: true,
      totalMs: Math.max(0, now() - startedAt),
      summary,
      report: [summary, ...pre.actions.map((action) => `建议：${action}`)].join('\n'),
      error: {
        code: 'PRECONDITION_FAILED',
        message: summary,
        missing: pre.labels,
        suggestions: pre.actions
      }
    };
  }

  const results: RecipeStepResult[] = [];
  const completed: RecipeStepResult[] = [];
  const skipped: RecipeStepResult[] = [];
  const failures: RecipeStepResult[] = [];
  const suppressed = new Set<string>();
  const emit = (event: RecipeProgressEvent): void => {
    try {
      exec.onProgress?.(event);
    } catch (error) {
      // 进度展示失败不能阻断流程。
      console.warn(`[RECIPE_PROGRESS_UI_FAILED]`, { site: 'desktop/src/agent/recipes.ts:979' }, error);
    }
  };

  // 自适应预算：与会话层同一实现（session.ts#resolveIterationBudget）。
  const startAt = Math.max(0, Math.min(recipe.steps.length, Math.trunc(exec.resumeFrom ?? 0)));
  const resolved = resolveIterationBudget({
    ...(exec.maxIterations !== undefined ? { base: exec.maxIterations } : {}),
    hasWrite: recipe.steps.some((step) => !READ_ONLY_TOOLS.has(step.tool)),
    planSteps: recipe.steps.length
  });
  // 显式 maxSteps 更小时，本轮真实上限就是它：budget.effective 如实收窄。
  const explicitMax = Number.isFinite(exec.maxSteps) ? Math.max(1, Math.trunc(exec.maxSteps!)) : null;
  const budget: IterationBudget = explicitMax !== null && explicitMax < resolved.effective
    ? { ...resolved, effective: explicitMax }
    : resolved;
  const cap = budget.effective;
  let executed = 0;
  const withRunMeta = (output: RecipeRunResult): RecipeRunResult => ({
    ...output,
    budget,
    iterations: executed,
    ...(startAt > 0 ? { resumedFrom: startAt } : {})
  });
  const elapsedNow = (): number => Math.max(0, now() - startedAt);
  const fail = (failed: RecipeStepResult, code: string): RecipeRunResult =>
    withRunMeta(failedRun(recipe, runId, elapsedNow(), results, completed, skipped, failed, code));
  const abort = (): RecipeRunResult =>
    withRunMeta(abortResult(recipe, runId, startedAt, now, results, completed, skipped));

  for (const [index, step] of recipe.steps.entries()) {
    if (exec.signal?.aborted) {
      return abort();
    }
    // 续跑：早于续跑起点的步骤本轮不重复执行。
    if (index < startAt) continue;
    if (executed >= cap) {
      return budgetStop(recipe, runId, elapsedNow(), results, completed, skipped, budget, executed, index);
    }

    if (shouldSkip(step, index, exec)) {
      const result = stepResult({
        step,
        index,
        ok: true,
        skipped: true,
        code: 'SKIPPED',
        elapsedMs: 0,
        message: '用户取消勾选，本步未执行'
      });
      results.push(result);
      skipped.push(result);
      emit({
        runId,
        phase: 'skip',
        index: index + 1,
        total: recipe.steps.length,
        stepId: step.id,
        title: step.title,
        tool: step.tool,
        argsSummary: '已跳过',
        startedAt: now(),
        source: 'recipe',
        elapsedMs: 0,
        ok: true,
        code: 'SKIPPED'
      });
      continue;
    }

    const resolved = resolveRecipeArgs(step.args, ctx);
    const argsSummary = summarizeArguments(resolved.args);
    if (resolved.missing.length > 0) {
      const failed = stepResult({
        step,
        index,
        ok: false,
        code: 'MISSING_CONTEXT',
        elapsedMs: 0,
        message: `缺少上下文：${resolved.missing.join('、')}`,
        args: resolved.args
      });
      results.push(failed);
      emit({
        runId,
        phase: 'end',
        index: index + 1,
        total: recipe.steps.length,
        stepId: step.id,
        title: step.title,
        tool: step.tool,
        argsSummary,
        startedAt: now(),
        source: 'recipe',
        elapsedMs: 0,
        ok: false,
        code: 'MISSING_CONTEXT',
        ...(failed.message ? { message: failed.message } : {})
      });
      if (recipe.onError === 'collect' && step.critical !== true) {
        failures.push(failed);
        continue;
      }
      return fail(failed, 'MISSING_CONTEXT');
    }

    if (!READ_ONLY_TOOLS.has(step.tool)) {
      const kind = writeKind(step.tool);
      if (!suppressed.has(step.tool)) {
        const confirm = exec.confirm ?? exec.confirmWrite;
        if (!confirm) {
          const failed = stepResult({
            step,
            index,
            ok: false,
            code: 'CONFIRMATION_REQUIRED',
            elapsedMs: 0,
            message: '写步骤需要确认，但执行器没有提供确认回调',
            args: resolved.args
          });
          results.push(failed);
          return fail(failed, 'CONFIRMATION_REQUIRED');
        }
        const message = `流程「${recipe.title}」第 ${index + 1}/${recipe.steps.length} 步：${step.title}（${step.tool}），是否允许？`;
        let allowed = false;
        try {
          allowed = await confirm({
            recipeId: recipe.id,
            recipeTitle: recipe.title,
            step,
            index,
            total: recipe.steps.length,
            args: resolved.args,
            tool: step.tool,
            writeKind: kind,
            message
          });
        } catch (error) {
          const failed = stepResult({
            step,
            index,
            ok: false,
            code: 'CONFIRM_FAILED',
            elapsedMs: 0,
            message: `确认失败：${error instanceof Error ? error.message : String(error)}`,
            args: resolved.args
          });
          results.push(failed);
          return fail(failed, 'CONFIRM_FAILED');
        }
        if (!allowed) {
          const failed = stepResult({
            step,
            index,
            ok: false,
            code: 'USER_DENIED',
            elapsedMs: 0,
            message: '用户在确认弹窗中选择了拒绝，本步未执行',
            args: resolved.args
          });
          results.push(failed);
          return fail(failed, 'USER_DENIED');
        }
        if (exec.rememberSameKind === true || exec.remember === true) {
          suppressed.add(step.tool);
        }
      }
    }

    const stepStarted = now();
    emit({
      runId,
      phase: 'start',
      index: index + 1,
      total: recipe.steps.length,
      stepId: step.id,
      title: step.title,
      tool: step.tool,
      argsSummary,
      startedAt: stepStarted,
      source: 'recipe'
    });
    let outcome: { ok: boolean; code: string; message?: string; data?: unknown };
    let rawResult: unknown;
    try {
      rawResult = await exec.execute({ ...step, args: resolved.args }, index, exec.signal);
      outcome = normalizeToolResult(rawResult);
    } catch (error) {
      outcome = {
        ok: false,
        code: 'TOOL_EXCEPTION',
        message: error instanceof Error ? error.message : String(error)
      };
    }
    const elapsedMs = Math.max(0, now() - stepStarted);
    const result = stepResult({
      step,
      index,
      ok: outcome.ok,
      code: outcome.code,
      elapsedMs,
      ...(outcome.message ? { message: outcome.message } : {}),
      args: resolved.args,
      ...(outcome.data !== undefined ? { data: outcome.data } : {})
    });
    results.push(result);
    if (outcome.ok) executed += 1;
    // 写后自动验证：与 AgentSession 同一入口；验证没跑通只记 ok:null，不判步骤失败。
    if (outcome.ok && exec.verifyChannel) {
      try {
        const verification = await autoVerifyTool(
          exec.verifyChannel,
          step.tool,
          isRecord(rawResult) ? rawResult : { ok: true, data: outcome.data },
          exec.signal
        );
        if (verification) result.verification = verification;
      } catch (error) {
        console.warn(`[RECIPE_VERIFY_HOOK_FAILED]`, { site: 'desktop/src/agent/recipes.ts:1200' }, error);
      }
    }
    emit({
      runId,
      phase: 'end',
      index: index + 1,
      total: recipe.steps.length,
      stepId: step.id,
      title: step.title,
      tool: step.tool,
      argsSummary,
      startedAt: stepStarted,
      source: 'recipe',
      elapsedMs: result.elapsedMs,
      ok: result.ok,
      code: result.code,
      ...(result.message ? { message: result.message } : {})
    });
    if (!outcome.ok) {
      // collect 策略：非关键步骤失败只记录（错误码 + 中文原因），继续跑后续步骤——评审要一次看完。
      // 关键步骤（如 get_project_context：拿不到机型后面全无意义）与 'stop' 配方仍立即停。
      if (recipe.onError === 'collect' && step.critical !== true) {
        failures.push(result);
        continue;
      }
      return fail(result, outcome.code);
    }
    completed.push(result);
  }

  const totalMs = elapsedNow();
  return withRunMeta(attachAggregate(
    recipe,
    failures.length > 0
      ? collectRun(recipe, runId, totalMs, results, completed, skipped, failures)
      : successRun(recipe, runId, totalMs, results, completed, skipped)
  ));
}

function statusText(result: RecipeStepResult): string {
  if (result.skipped) return '跳过';
  return result.ok ? '成功' : '失败';
}

/** 导出 Markdown 执行记录；供侧栏「导出本次执行记录」与单测共用。 */
export function recipeRunToMarkdown(result: RecipeRunResult): string {
  const lines: string[] = [
    `# 流程执行记录 · ${result.recipeTitle || result.recipeId}`,
    '',
    `- 模板 id：\`${result.recipeId}\``,
    `- 运行 id：\`${result.runId}\``,
    `- 状态：${result.ok ? '成功' : result.preconditionFailed ? '前置条件未满足' : '失败'}`,
    `- 总耗时：${formatDuration(result.totalMs)}`,
    `- 摘要：${result.summary}`,
    ''
  ];
  if (result.preconditionFailed) {
    lines.push('## 前置条件', '');
    for (const missing of result.missing ?? []) lines.push(`- 缺少：${missing}`);
    for (const action of result.suggestions ?? []) lines.push(`- 建议：${action}`);
    lines.push('');
  }
  lines.push('## 步骤', '', '| # | 步骤 | 工具 | 状态 | 耗时 | 结果码 |', '|---|---|---|---|---|---|');
  for (const item of result.results) {
    lines.push(`| ${item.step} | ${item.title} | \`${item.tool}\` | ${statusText(item)} | ${formatDuration(item.elapsedMs)} | ${item.code} |`);
  }
  if (result.results.length === 0) lines.push('| — | 未执行 | — | — | — | — |');
  lines.push('');
  if (result.failedStep) {
    lines.push('## 失败详情', '');
    lines.push(`- 失败步骤：第 ${result.failedStep.step} 步「${result.failedStep.title}」（\`${result.failedStep.tool}\`）`);
    lines.push(`- 错误码：${result.errorCode ?? result.failedStep.code}`);
    if (result.failedStep.message) lines.push(`- 错误信息：${result.failedStep.message}`);
    if (result.suggestion) lines.push(`- 建议：${result.suggestion}`);
    lines.push('');
  }
  if (isDesignReview(result.aggregate)) {
    lines.push('## 评审结论', '');
    lines.push(`- 结论：**${result.aggregate.verdict}**`);
    lines.push(`- 摘要：${result.aggregate.summary}`);
    lines.push('', '| 区域 | 状态 | 证据 | 下一步 |', '|---|---|---|---|');
    for (const item of result.aggregate.items) {
      lines.push(`| ${item.area} | ${item.status} | ${item.evidence} | ${item.suggestion} |`);
    }
    lines.push('');
  }
  lines.push('## 已完成清单', '');
  if (result.completed.length === 0) {
    lines.push('- 无');
  } else {
    for (const item of result.completed) {
      lines.push(`- [x] 第 ${item.step} 步「${item.title}」（\`${item.tool}\`，${formatDuration(item.elapsedMs)}）`);
    }
  }
  lines.push('');
  if (result.skipped.length > 0) {
    lines.push('## 已跳过', '');
    for (const item of result.skipped) lines.push(`- [ ] 第 ${item.step} 步「${item.title}」（\`${item.tool}\`）`);
    lines.push('');
  }
  lines.push('## 明细', '');
  for (const item of result.results) {
    lines.push(`### 第 ${item.step} 步 · ${item.title}`);
    lines.push('');
    lines.push(`- 工具：\`${item.tool}\``);
    lines.push(`- 状态：${statusText(item)}（${item.code}）`);
    lines.push(`- 耗时：${formatDuration(item.elapsedMs)}`);
    if (item.args) lines.push(`- 参数：${summarizeArguments(item.args, 240)}`);
    if (item.message) lines.push(`- 说明：${item.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

export const exportRecipeMarkdown = recipeRunToMarkdown;
export const recipeToMarkdown = recipeRunToMarkdown;
export const formatRecipeReport = (result: RecipeRunResult): string => result.report;
