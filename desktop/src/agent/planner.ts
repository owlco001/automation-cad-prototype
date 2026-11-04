/**
 * 多步规划器 + 顺序执行器（P7-C）
 *
 * 设计约束：
 * - 规划完全离线、纯函数：不联网、不调模型、不读写文件；
 * - 工具名必须来自 `tools.ts` 注册表（默认与 router.ts 的读写集合一致，
 *   集成时由调用方传入实时 `AgentTools.summaries()`）；不存在的工具只过滤、不执行；
 * - 规则不命中或置信度低于阈值时明确 refused，并给可执行建议，不硬猜；
 * - 执行器只负责顺序与失败停止，工具调用通过注入的 `execute` 回调完成，便于单测。
 */

import {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  planTool,
  splitInstructionSteps,
  type ToolPlan
} from './router.ts';
import { extractPlacementSpec, isPlacementInstruction } from './placement.ts';
import type { AgentContext } from './context.ts';
import type { ReferenceSource } from './reference.ts';
import type { ToolVerification } from './verify.ts';
import {
  cancellationText,
  summarizeArguments,
  type AgentProgressEvent,
  type CompletedStep
} from './feedback.ts';

export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  /** 只有注册表内的只读工具为 true；未知工具一律按写步骤保守处理。 */
  readOnly: boolean;
  /** 缺少的关键参数，供 UI 在卡片上直接点名。 */
  missing?: string[];
  /** 指代消解依据；UI 显示「已使用选中对象：QF1」。 */
  resolvedFrom?: ReferenceSource;
  resolvedLabel?: string;
}

export interface AgentPlan {
  steps: PlanStep[];
  /** 0–1，规则命中越完整越高；低于阈值直接 refused。 */
  confidence: number;
  refused?: boolean;
  reason?: string;
  suggestions?: string[];
  /** 被过滤的未注册工具等非致命问题。 */
  warnings?: string[];
}

export interface PlanContext {
  /** 实时工具名（通常传 AgentTools.summaries().map(t => t.name)）。 */
  tools?: string[] | Set<string>;
  /** `tools` 的别名，便于外部调用方直接用注册表快照。 */
  availableTools?: string[] | Set<string>;
  /** 设计包同步的目标机台与地址；仅在同步工具注册后写入参数。 */
  deviceId?: string;
  baseUrl?: string;
  /** 默认 0.6，测试可显式抬高以验证低置信度拒绝。 */
  minConfidence?: number;
  /** 当前 UI 上下文；用于指代消解补全参数。 */
  context?: AgentContext;
}

const DEFAULT_TOOL_NAMES = new Set([...READ_ONLY_TOOLS, ...WRITE_TOOLS]);
export const PLAN_CONFIDENCE_THRESHOLD = 0.6;

const SUGGESTIONS = [
  '查件并放置：查一下 MXQ20-32-50 气缸，放到 40, 60，然后做电气校验',
  'BOM 成本：读一下 BOM，算一下成本，然后导出 CSV 报价单',
  'CAD 校核：导入 STEP 文件后做干涉检查',
  'PLC 验证：生成 PLC 程序并模拟验证',
  '设计包：生成设计包并上传（需先注册同步工具）'
];

interface Candidate {
  steps: PlanStep[];
  confidence: number;
  warnings: string[];
}

function makeStep(
  tool: string,
  args: Record<string, unknown>,
  why: string,
  missing: string[] = []
): PlanStep {
  return {
    tool,
    args,
    why,
    readOnly: READ_ONLY_TOOLS.has(tool),
    ...(missing.length > 0 ? { missing } : {})
  };
}

function knownToolSet(context: PlanContext): Set<string> {
  const source = context.tools ?? context.availableTools;
  if (source === undefined) return new Set(DEFAULT_TOOL_NAMES);
  const names = source instanceof Set ? [...source] : source;
  return new Set(names.filter((name): name is string => typeof name === 'string' && name.length > 0));
}

function exportFormat(text: string): 'pdf' | 'csv' {
  return /csv|excel|表格/i.test(text) ? 'csv' : 'pdf';
}

function cadPath(text: string): string | undefined {
  const match = text.match(/[A-Za-z]:\\[^\s，。；;]+/);
  return match?.[0];
}

function truthyNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fromToolPlan(plan: ToolPlan, confidence: number): Candidate {
  const step: PlanStep = {
    tool: plan.tool,
    args: { ...plan.args },
    why: plan.why,
    readOnly: plan.readOnly,
    ...(plan.missing.length > 0 ? { missing: [...plan.missing] } : {}),
    ...(plan.resolvedFrom ? { resolvedFrom: plan.resolvedFrom } : {}),
    ...(plan.resolvedLabel ? { resolvedLabel: plan.resolvedLabel } : {})
  };
  return { steps: [step], confidence, warnings: [] };
}

/** 组合 1：查件 → 放置 → 电气校验。 */
function matchSearchPlaceCheck(text: string, segments: string[], context?: AgentContext): Candidate | null {
  const wantsSearch = /(?:查|搜|找|选型|选一个)/.test(text);
  const placement = isPlacementInstruction(text) || /(?:放到|放在|摆在|摆到|放置)/.test(text);
  const wantsCheck = /(?:电气校验|校验|复核|检查)/.test(text);
  if (!wantsSearch || !placement || !wantsCheck) return null;

  const spec = extractPlacementSpec(text);
  // 搜索子句要在「放到/放在」之前截断，否则整句会被 router 判成写操作。
  const searchText = text.split(/(?:放到|放在|摆在|摆到|放置到|放置在|放置)/)[0]?.trim() || text;
  const searchSegment = segments.find((segment) => /(?:查|搜|找|选)/.test(segment)) ?? searchText;
  const segmentPlan = planTool(searchSegment, context);
  const searchPlan = segmentPlan && (segmentPlan.tool === 'search_components' || segmentPlan.tool === 'list_components')
    ? segmentPlan
    : planTool(searchText, context);
  const query = typeof searchPlan?.args.q === 'string' ? searchPlan.args.q : spec.partRef;
  const category = typeof searchPlan?.args.category === 'string' ? searchPlan.args.category : undefined;
  if (!query && !category) return null;

  const searchArgs: Record<string, unknown> = {};
  if (query) searchArgs.q = query;
  if (category) searchArgs.category = category;

  const placeArgs: Record<string, unknown> = {
    rotate: spec.rotate,
    railSnap: spec.railSnap
  };
  const missing: string[] = [];
  if (spec.partRef) placeArgs.partId = spec.partRef;
  else missing.push('partId');
  if (truthyNumber(spec.x)) placeArgs.x = spec.x;
  else missing.push('x');
  if (truthyNumber(spec.y)) placeArgs.y = spec.y;
  else missing.push('y');

  const coordinate = truthyNumber(spec.x) && truthyNumber(spec.y)
    ? `${spec.x}, ${spec.y} mm`
    : '坐标待定';
  const steps = [
    makeStep(
      'search_components',
      searchArgs,
      `在元件库中搜索${query ? `「${query}」` : ''}${category ? `（${category}）` : ''}，为后续放置确定物料`
    ),
    makeStep(
      'place_component',
      placeArgs,
      `把 ${spec.partRef ?? '选中元件'} 放到底板 ${coordinate}（需确认，可撤销）`,
      missing
    ),
    makeStep('run_electrical_check', {}, '对当前电气文档做线号、功率与截面校验')
  ];

  const complete = Boolean(spec.partRef) && truthyNumber(spec.x) && truthyNumber(spec.y) && Boolean(query);
  return { steps, confidence: complete ? 0.95 : 0.78, warnings: [] };
}

/** 组合 2：BOM → 成本 → 导出成本报告。 */
function matchBomCostExport(text: string): Candidate | null {
  const wantsBom = /(?:bom|物料清单|物料表)/i.test(text);
  const wantsCost = /(?:成本|费用|总价|合计|多少钱|价格)/.test(text);
  const wantsExport = /(?:导出|生成|出一份|出份|打印)/.test(text);
  if (!wantsBom || !wantsCost || !wantsExport) return null;
  const format = exportFormat(text);
  return {
    steps: [
      makeStep('get_bom', {}, '读取当前装配体的简化 BOM，作为成本计算输入'),
      makeStep('run_cost_report', {}, '按 BOM 与价格簿计算硬件、辅材、人工、税与加成'),
      makeStep(
        'export_cost_report',
        { format },
        `把成本报告落盘为 ${format.toUpperCase()}（写入 userData/exports/，需确认）`
      )
    ],
    confidence: 0.95,
    warnings: []
  };
}

/** 组合 3：导入 CAD → 干涉初筛。 */
function matchImportInterference(text: string, segments: string[], context?: AgentContext): Candidate | null {
  const wantsImport = /(?:导入|打开).*(?:cad|step|stp|iges|igs|stl|obj|gltf|glb|模型|文件)/i.test(text);
  const wantsInterference = /(?:干涉|碰撞)/.test(text);
  if (!wantsImport || !wantsInterference) return null;

  const importSegment = segments.find((segment) => /(?:导入|打开)/.test(segment)) ?? text;
  const importPlan = planTool(importSegment, context);
  const path = (typeof importPlan?.args.path === 'string' ? importPlan.args.path : undefined) ?? cadPath(text);
  const importArgs: Record<string, unknown> = path ? { path } : {};
  const warnings = /(?:受力|强度|应力)/.test(text)
    ? ['受力校核暂无注册工具，本计划只执行导入与干涉初筛']
    : [];
  return {
    steps: [
      makeStep(
        'import_cad',
        importArgs,
        path ? `导入 CAD 文件 ${path}（需确认）` : '导入 CAD 文件（需确认；缺少必填参数：本机绝对路径）',
        path ? [] : ['path']
      ),
      makeStep('run_interference_check', {}, '对导入后的装配体做包围盒级干涉初筛')
    ],
    confidence: path ? 0.93 : 0.75,
    warnings
  };
}

/** 组合 4：生成 PLC → 模拟验证（只读工具一次完成生成与模拟，不落盘）。 */
function matchPlcVerify(text: string): Candidate | null {
  const mentionsPlc = /(?:plc|程序|代码)/i.test(text);
  const wantsVerify = /(?:模拟验证|验证|模拟|自检|联调)/.test(text);
  if (!mentionsPlc || !wantsVerify) return null;
  return {
    steps: [
      makeStep(
        'verify_plc_program',
        {},
        '先预检并生成 PLC 程序，再用内置模拟器跑联调序列（只读，不落盘、不写 PLC）'
      )
    ],
    confidence: 0.9,
    warnings: []
  };
}

/** 组合 5：生成设计包 → 上传（外部副作用，需确认）。 */
function matchDesignPackageSync(text: string, context: PlanContext): Candidate | null {
  const wantsPackage = /(?:设计包|设计文件|整机包|版本包)/.test(text);
  const wantsSync = /(?:同步|上传|推送|下发)/.test(text);
  if (!wantsPackage || !wantsSync) return null;
  const args: Record<string, unknown> = {};
  if (context.deviceId) args.deviceId = context.deviceId;
  if (context.baseUrl) args.baseUrl = context.baseUrl;
  return {
    steps: [
      makeStep(
        'sync_design_package',
        args,
        '打包当前设计并上传到智慧工厂（外部副作用，需确认并核对机台编号与目标地址）'
      )
    ],
    confidence: 0.9,
    warnings: []
  };
}

/** 通用多步：按明确连接词拆句，每一句都必须能落到已注册工具上。 */
function matchGenericSequence(segments: string[], context?: AgentContext): Candidate | null {
  if (segments.length < 2) return null;
  const steps: PlanStep[] = [];
  for (const segment of segments) {
    const plan = planTool(segment, context);
    if (!plan) return null;
    steps.push(...fromToolPlan(plan, 0.78).steps);
  }
  if (steps.length < 2) return null;
  return { steps, confidence: 0.78, warnings: [] };
}

function hasMultiStepConnector(text: string): boolean {
  return /(?:然后|接着|之后|最后|并且|同时|再|并)/.test(text);
}

/**
 * 中文多步指令 → 有序工具计划。纯规则、确定性输出。
 * 返回 refused 时 steps 必为空，调用方不得执行任何工具。
 */
export function plan(input: string, context: PlanContext = {}): AgentPlan {
  const text = (input ?? '').trim();
  const threshold = Number.isFinite(context.minConfidence ?? PLAN_CONFIDENCE_THRESHOLD)
    ? Math.max(0, Math.min(1, context.minConfidence ?? PLAN_CONFIDENCE_THRESHOLD))
    : PLAN_CONFIDENCE_THRESHOLD;
  if (!text) {
    return {
      steps: [],
      confidence: 0,
      refused: true,
      reason: '输入为空',
      suggestions: SUGGESTIONS
    };
  }

  const segments = splitInstructionSteps(text);
  const candidate =
    matchSearchPlaceCheck(text, segments, context.context) ??
    matchBomCostExport(text) ??
    matchImportInterference(text, segments, context.context) ??
    matchPlcVerify(text) ??
    matchDesignPackageSync(text, context) ??
    matchGenericSequence(segments, context.context);

  let steps: PlanStep[];
  let confidence: number;
  let warnings: string[] = [];
  if (candidate) {
    steps = candidate.steps;
    confidence = candidate.confidence;
    warnings = [...candidate.warnings];
  } else {
    const single = planTool(text, context.context);
    if (!single) {
      return {
        steps: [],
        confidence: 0.2,
        refused: true,
        reason: '没有匹配到可执行规则，已拒绝猜测',
        suggestions: SUGGESTIONS,
        ...(hasMultiStepConnector(text)
          ? { warnings: ['多步指令中有子句无法映射到已注册工具，整单不执行'] }
          : {})
      };
    }
    const converted = fromToolPlan(single, single.readOnly ? 0.8 : 0.75);
    steps = converted.steps;
    confidence = converted.confidence;
  }

  const known = knownToolSet(context);
  const kept: PlanStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (known.has(step.tool)) {
      kept.push(step);
    } else {
      warnings.push(`忽略未注册工具 ${step.tool}（第 ${index + 1} 步）`);
    }
  }

  const rounded = Math.round(confidence * 100) / 100;
  if (rounded < threshold) {
    return {
      steps: [],
      confidence: rounded,
      refused: true,
      reason: `置信度 ${rounded.toFixed(2)} 低于阈值 ${threshold.toFixed(2)}`,
      suggestions: SUGGESTIONS,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }
  if (kept.length === 0) {
    return {
      steps: [],
      confidence: rounded,
      refused: true,
      reason: warnings.length > 0 ? '计划中的工具均未注册，已拒绝执行' : '没有可执行步骤',
      suggestions: SUGGESTIONS,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  return {
    steps: kept,
    confidence: rounded,
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export type { ToolPlan };

export interface ConfirmPlanRequest {
  message: string;
  /** 本轮实际将执行的步骤（逐步执行时可能只有一个）。 */
  steps: PlanStep[];
  /** 本轮写步骤在 steps 中的下标（0 基）。 */
  writeIndexes: number[];
  /** 完整计划总步数，便于文案说清「这 N 步」。 */
  totalSteps: number;
}

export interface PlanStepResult {
  /** 在完整计划中的 0 基下标。 */
  index: number;
  /** 给人看的 1 基步骤号。 */
  step: number;
  tool: string;
  ok: boolean;
  code: string;
  message?: string;
  elapsedMs: number;
  data?: unknown;
  /** 写后自动验证结论（只附字段，不改变 ok）。 */
  verification?: ToolVerification;
}

export interface ExecutePlanDeps {
  execute(step: PlanStep, index: number, signal?: AbortSignal): Promise<unknown> | unknown;
  /** 存在写步骤时调用一次；返回 false / 抛错都按取消处理。 */
  confirmPlan?(request: ConfirmPlanRequest): Promise<boolean> | boolean;
  /**
   * 写后自动验证钩子：步骤成功后调用一次，返回的结论原样附到该步骤结果上。
   * `raw` 是 `execute` 的原始返回值（用于识别工具自带的验证结论）。
   * 钩子抛错只记 `verification` 为 null，不影响步骤成败。
   */
  verify?(step: PlanStep, raw: unknown, signal?: AbortSignal): Promise<ToolVerification | null> | ToolVerification | null;
  /** 注入时钟，测试可给固定序列。 */
  now?(): number;
  /** 逐步执行：从完整计划的第 startAt 步开始（0 基）。 */
  startAt?: number;
  /** 最多执行几步；默认执行到结尾。 */
  maxSteps?: number;
  /** 中断当前计划；已完成的步骤仍会返回。 */
  signal?: AbortSignal;
  /** 步骤开始/结束事件，供侧栏显示进度与秒表。 */
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface ExecutePlanResult {
  ok: boolean;
  /** 本轮是否需要确认（只读计划为 false）。 */
  confirmationRequired: boolean;
  /** 需要确认时是否得到允许；只读计划视为已确认。 */
  confirmed: boolean;
  /**
   * 确认阶段的结果：allowed / denied / timeout / aborted / unavailable / error。
   * 多轮续跑据此区分「用户明确拒绝」与「确认超时/取消」。
   */
  confirmOutcome?: 'allowed' | 'denied' | 'timeout' | 'aborted' | 'unavailable' | 'error';
  cancelled?: boolean;
  refused?: boolean;
  /** 失败步骤的 1 基序号。 */
  failedAt?: number;
  /** 失败步骤的 0 基下标。 */
  failedIndex?: number;
  failedTool?: string;
  results: PlanStepResult[];
  totalMs: number;
  summary: string;
  undoHint?: string;
}

interface NormalizedResult {
  ok: boolean;
  code: string;
  message?: string;
  data?: unknown;
}

const UNDOABLE_WRITE_TOOLS = new Set([
  'apply_machine_design',
  'insert_component',
  'place_component',
  'update_component',
  'remove_component'
]);

class PlanAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'PlanAborted';
  }
}

function withAbort<T>(promise: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const value = Promise.resolve(promise);
  if (!signal) return value;
  if (signal.aborted) return Promise.reject(new PlanAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PlanAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToolResult(raw: unknown): NormalizedResult {
  if (isRecord(raw)) {
    const nestedError = isRecord(raw.error) ? raw.error : null;
    const ok = raw.ok === undefined ? !nestedError : raw.ok === true;
    const code = ok
      ? (typeof raw.code === 'string' ? raw.code : 'OK')
      : (typeof raw.code === 'string' ? raw.code : (nestedError && typeof nestedError.code === 'string' ? nestedError.code : 'TOOL_FAILED'));
    const message = typeof raw.message === 'string'
      ? raw.message
      : (nestedError && typeof nestedError.message === 'string' ? nestedError.message : undefined);
    return {
      ok,
      code,
      ...(message ? { message } : {}),
      data: raw.data !== undefined ? raw.data : raw
    };
  }
  if (raw === false) return { ok: false, code: 'TOOL_FAILED', message: '工具返回 false' };
  return { ok: true, code: 'OK', ...(raw === undefined ? {} : { data: raw }) };
}

function receiptSummary(results: PlanStepResult[], total: number, fail?: PlanStepResult): string {
  const success = results.filter((result) => result.ok).length;
  if (fail) {
    const remaining = Math.max(0, total - results.length);
    return `第 ${fail.step} 步 ${fail.tool} 失败（${fail.code}）${fail.message ? `：${fail.message}` : ''}；已停止后续 ${remaining} 步（成功 ${success}/${results.length}）`;
  }
  return `已完成 ${success}/${results.length} 步`;
}

/**
 * 顺序执行计划：只读直接跑；有写步骤时先汇总并请求一次确认。
 * 任一步失败立即停止，不执行后续步骤。
 */
export async function executePlan(plan: AgentPlan, deps: ExecutePlanDeps): Promise<ExecutePlanResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);
  const runId = `plan-${startedAt}`;
  const emit = (event: AgentProgressEvent): void => {
    try {
      deps.onProgress?.(event);
    } catch (error) {
      // 进度展示失败不能影响计划执行。
      console.warn(`[PLAN_PROGRESS_UI_FAILED]`, { site: 'desktop/src/agent/planner.ts:541' }, error);
    }
  };

  if (plan.refused || plan.steps.length === 0) {
    return {
      ok: false,
      confirmationRequired: false,
      confirmed: false,
      refused: true,
      results: [],
      totalMs: elapsed(),
      summary: plan.reason ? `计划已拒绝：${plan.reason}` : '计划为空，未执行任何工具'
    };
  }

  const startAt = Math.max(0, Math.min(plan.steps.length, Math.trunc(deps.startAt ?? 0)));
  const requested = Number.isFinite(deps.maxSteps) ? Math.max(1, Math.trunc(deps.maxSteps!)) : plan.steps.length - startAt;
  const end = Math.min(plan.steps.length, startAt + requested);
  const selected: Array<{ step: PlanStep; index: number }> = [];
  for (let index = startAt; index < end; index += 1) selected.push({ step: plan.steps[index]!, index });
  if (selected.length === 0) {
    return {
      ok: true,
      confirmationRequired: false,
      confirmed: true,
      results: [],
      totalMs: elapsed(),
      summary: '该计划没有待执行步骤'
    };
  }

  const writeIndexes = selected
    .filter(({ step }) => !READ_ONLY_TOOLS.has(step.tool))
    .map(({ index }) => index - startAt);
  const confirmationRequired = writeIndexes.length > 0;
  let confirmed = true;
  const completed: CompletedStep[] = [];
  const results: PlanStepResult[] = [];
  const undoHint = (): string | undefined => completed.some((item) => item.ok && item.wrote && UNDOABLE_WRITE_TOOLS.has(item.tool))
    ? '已执行的装配写操作可用 undo_last 回退'
    : undefined;
  const cancelledResult = (
    currentTool?: string,
    currentToolMayWrite = false,
    confirmOutcome?: ExecutePlanResult['confirmOutcome']
  ): ExecutePlanResult => {
    const summary = cancellationText({
      completed,
      ...(currentTool ? { currentTool } : {}),
      currentToolMayWrite
    });
    const hint = undoHint();
    return {
      ok: false,
      confirmationRequired,
      confirmed,
      cancelled: true,
      results,
      totalMs: elapsed(),
      summary,
      ...(confirmOutcome ? { confirmOutcome } : {}),
      ...(hint ? { undoHint: hint } : {})
    };
  };

  if (deps.signal?.aborted) return cancelledResult();
  if (confirmationRequired) {
    const writeSteps = selected.filter(({ step }) => !READ_ONLY_TOOLS.has(step.tool));
    const message = `我准备做这 ${selected.length} 步：${selected
      .map(({ step }, index) => `${index + 1}. ${step.tool}`)
      .join('；')}。其中 ${writeSteps.length} 步为写操作，是否继续？`;
    if (!deps.confirmPlan) {
      return {
        ok: false,
        confirmationRequired,
        confirmed: false,
        cancelled: true,
        confirmOutcome: 'unavailable',
        results: [],
        totalMs: elapsed(),
        summary: '写步骤需要确认，但缺少必填参数：确认回调，已取消'
      };
    }
    try {
      confirmed = await withAbort(deps.confirmPlan({
        message,
        steps: selected.map(({ step }) => step),
        writeIndexes,
        totalSteps: plan.steps.length
      }), deps.signal);
    } catch (error) {
      if (error instanceof PlanAborted) return cancelledResult(undefined, false, 'aborted');
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /timeout|timed out|超时|ETIMEDOUT/i.test(message);
      return {
        ok: false,
        confirmationRequired,
        confirmed: false,
        cancelled: true,
        confirmOutcome: timeout ? 'timeout' : 'error',
        results: [],
        totalMs: elapsed(),
        summary: `确认失败：${message}，已取消`
      };
    }
    if (!confirmed) {
      return {
        ok: false,
        confirmationRequired,
        confirmed: false,
        cancelled: true,
        confirmOutcome: 'denied',
        results: [],
        totalMs: elapsed(),
        summary: '已取消：用户拒绝执行该计划'
      };
    }
    if (deps.signal?.aborted) return cancelledResult();
  }

  let undoAvailable = false;
  let failed: PlanStepResult | undefined;
  for (const [position, { step, index }] of selected.entries()) {
    if (deps.signal?.aborted) return cancelledResult();
    const stepStarted = now();
    const argsSummary = summarizeArguments(step.args);
    emit({
      runId,
      phase: 'start',
      index: position + 1,
      total: selected.length,
      tool: step.tool,
      argsSummary,
      startedAt: stepStarted,
      callId: `plan:${index}`,
      source: 'plan'
    });
    let outcome: NormalizedResult;
    let rawResult: unknown;
    try {
      rawResult = await withAbort(deps.execute(step, index, deps.signal), deps.signal);
      outcome = normalizeToolResult(rawResult);
    } catch (error) {
      if (error instanceof PlanAborted) {
        emit({
          runId,
          phase: 'end',
          index: position + 1,
          total: selected.length,
          tool: step.tool,
          argsSummary,
          startedAt: stepStarted,
          callId: `plan:${index}`,
          elapsedMs: Math.max(0, now() - stepStarted),
          ok: false,
          code: 'CANCELLED',
          message: '已取消',
          source: 'plan'
        });
        return cancelledResult(step.tool, !READ_ONLY_TOOLS.has(step.tool));
      }
      outcome = {
        ok: false,
        code: 'TOOL_EXCEPTION',
        message: error instanceof Error ? error.message : String(error)
      };
    }
    const result: PlanStepResult = {
      index,
      step: index + 1,
      tool: step.tool,
      ok: outcome.ok,
      code: outcome.code,
      ...(outcome.message ? { message: outcome.message } : {}),
      elapsedMs: Math.max(0, now() - stepStarted),
      ...(outcome.data !== undefined ? { data: outcome.data } : {})
    };
    // 写后自动验证：只给成功步骤补一次自查，钩子失效/抛错都不改步骤结论。
    if (outcome.ok && deps.verify) {
      try {
        const verification = await deps.verify(step, rawResult, deps.signal);
        if (verification) result.verification = verification;
      } catch (error) {
        console.warn(`[PLAN_VERIFY_HOOK_FAILED]`, { site: 'desktop/src/agent/planner.ts:721' }, error);
      }
    }
    results.push(result);
    completed.push({
      step: index + 1,
      tool: step.tool,
      ok: outcome.ok,
      code: outcome.code,
      wrote: outcome.ok && !READ_ONLY_TOOLS.has(step.tool)
    });
    emit({
      runId,
      phase: 'end',
      index: position + 1,
      total: selected.length,
      tool: step.tool,
      argsSummary,
      startedAt: stepStarted,
      callId: `plan:${index}`,
      elapsedMs: result.elapsedMs,
      ok: outcome.ok,
      code: outcome.code,
      ...(outcome.message ? { message: outcome.message } : {}),
      source: 'plan'
    });
    if (!outcome.ok) {
      failed = result;
      break;
    }
    if (!READ_ONLY_TOOLS.has(step.tool) && UNDOABLE_WRITE_TOOLS.has(step.tool)) undoAvailable = true;
  }

  return {
    ok: !failed,
    confirmationRequired,
    confirmed,
    ...(confirmationRequired && confirmed ? { confirmOutcome: 'allowed' as const } : {}),
    ...(failed
      ? { failedAt: failed.step, failedIndex: failed.index, failedTool: failed.tool }
      : {}),
    results,
    totalMs: elapsed(),
    summary: receiptSummary(results, selected.length, failed),
    ...(undoAvailable ? { undoHint: '已执行的装配写操作可用 undo_last 回退' } : {})
  };
}

/** 计划卡片用的一行参数摘要。 */
export function describePlanStep(step: PlanStep): string {
  const args = Object.keys(step.args).length > 0 ? JSON.stringify(step.args) : '无参数';
  return `${step.tool} ${args}`;
}
