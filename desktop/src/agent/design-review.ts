/**
 * 设计评审汇总器（第 6 个配方 `review-design` 的纯函数汇总层）
 *
 * 定位：配方本身只负责「按固定顺序把 5 个只读工具跑完」（失败用 `onError:'collect'`
 * 继续跑），本模块把 5 份工具结果折成一份可交付的评审结论：`PASS` / `WARN` / `FAIL`
 * + 4 条带数字证据的条目 + 一句摘要。不调工具、不读文件、不看 DOM，可单测。
 *
 * 判定规则（与文档一致，不模糊）：
 * 1. 任一条目 `fail` → `FAIL`；没有 fail 但有 `warn` 或 `na` → `WARN`；全 `pass` → `PASS`。
 * 2. 每条 `evidence` 必须带数字：
 *    - 结构：issues 条数 + 首个 code；
 *    - 干涉：rest/lift/sweep 各自的 hits 与 mm³；
 *    - 电气：过载（最大相电流）、压降（24V 余量）、断路器（额定/进线截面）三项实际值；
 *    - 成本：缺价条数与总价。
 *    没有数字就不算证据：该条降级为 `warn`（`fail` 保留，错误码本身已可定位），
 *    并在 `suggestion` 末尾写「需人工确认」。
 * 3. 禁止空话：`suggestion` 必须指名下一步的具体工具或字段（例：
 *    「先调 repair_plc_config(dryRun) 补齐急停/安全门」），不写「建议进一步检查」。
 *
 * 口径说明（不猜数字）：
 * - 干涉 `STATE_UNAVAILABLE`（机型没有顶升轴）记为 `na`，不算失败；证据写「states 可用 0/3」。
 * - 电气工具不计算线路压降，这里用 24V 母线余量（`psuMarginRatio`）作电压侧证据；
 *   没给 PSU 额定电流时该值为 null，条目降级 `warn` 并提示人工确认压降。
 * - 缺价（`counts.missing > 0`）只 `warn`：报价会偏，但结构/干涉/电气仍可出图。
 */

import type { RecipeStepResult } from './recipes.ts';

export type DesignReviewArea = '结构' | '干涉' | '电气' | '成本';
export type DesignReviewStatus = 'pass' | 'warn' | 'fail' | 'na';
export type DesignReviewVerdict = 'PASS' | 'WARN' | 'FAIL';

export interface DesignReviewItem {
  area: DesignReviewArea;
  status: DesignReviewStatus;
  title: string;
  /** 必须带数字；没有数字的条目会被降级。 */
  evidence: string;
  /** 必须指名下一步动作（工具名或字段路径），不写空话。 */
  suggestion: string;
}

export interface DesignReview {
  verdict: DesignReviewVerdict;
  items: DesignReviewItem[];
  summary: string;
}

/** 单步结果的只读视图（`RecipeStepResult` 的子集，便于单测直接构造）。 */
export interface ReviewStepOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  skipped?: boolean;
  data?: unknown;
}

export interface DesignReviewInput {
  context?: ReviewStepOutcome | undefined;
  structure?: ReviewStepOutcome | undefined;
  interference?: ReviewStepOutcome | undefined;
  electrical?: ReviewStepOutcome | undefined;
  cost?: ReviewStepOutcome | undefined;
}

/** 汇总器覆盖的区域与顺序（输出顺序固定，UI/报告直接照抄）。 */
export const REVIEW_AREAS: readonly DesignReviewArea[] = ['结构', '干涉', '电气', '成本'];

/** 配方步骤 id → 区域。改配方步骤 id 必须同步这里。 */
export const REVIEW_STEP_IDS = {
  context: 'context',
  structure: 'structure',
  interference: 'interference',
  electrical: 'electrical',
  cost: 'cost'
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 只接受有限数字；其余（undefined/null/'12'）一律当缺数据，绝不猜。 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fmt(value: number | null): string {
  if (value === null) return '未给出';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function money(value: number | null): string {
  if (value === null) return '未给出';
  return `¥${value.toFixed(2)}`;
}

/** 证据里有没有数字（判定「够不够算 evidence」的唯一标准）。 */
export function evidenceHasNumber(text: string): boolean {
  return /\d/.test(text ?? '');
}

/** 空话黑名单：出现即视为没指名动作。 */
export const HOLLOW_PHRASES: readonly string[] = [
  '进一步检查',
  '进一步排查',
  '建议检查',
  '建议排查',
  '酌情处理',
  '注意观察',
  '建议关注',
  '综合考虑'
];

export function findHollowPhrase(text: string): string | null {
  const value = text ?? '';
  const hit = HOLLOW_PHRASES.find((phrase) => value.includes(phrase));
  return hit ?? null;
}

function withConfirmHint(item: DesignReviewItem, reason: string): DesignReviewItem {
  const next: DesignReviewItem = { ...item };
  if (!evidenceHasNumber(next.evidence)) {
    if (next.status === 'pass') next.status = 'warn';
    if (!next.suggestion.includes('需人工确认')) {
      next.suggestion = `${next.suggestion}；${reason}，需人工确认`;
    }
  }
  return next;
}

/**
 * 单步本身没跑出来（工具失败/被跳过）时的统一条目。
 * `fail` 保留：错误码本身就是可以定位的证据；suggestion 指向重跑该工具。
 */
function failedStepItem(
  area: DesignReviewArea,
  title: string,
  outcome: ReviewStepOutcome | undefined,
  rerun: string
): DesignReviewItem {
  if (!outcome) {
    return {
      area,
      status: 'warn',
      title,
      evidence: '0 项数据（该步未执行，未产出任何数字）',
      suggestion: `${rerun} 补齐本项，否则这条只能算未评`
    };
  }
  if (outcome.skipped === true) {
    return {
      area,
      status: 'na',
      title,
      evidence: '0 项数据（本步被用户跳过）',
      suggestion: `本步被跳过：说「评审这台机器」重跑 review-design 可补齐（${rerun}）`
    };
  }
  const code = outcome.code ?? 'TOOL_FAILED';
  const message = outcome.message ? `：${outcome.message}` : '';
  return {
    area,
    status: 'fail',
    title,
    evidence: `0 项数据（${code}${message}）`,
    suggestion: `先按 ${code} 修数据，再重跑 ${rerun}`
  };
}

function structureItem(outcome: ReviewStepOutcome | undefined, machineName: string | null): DesignReviewItem {
  const title = '机型结构与绑定';
  const payload = record(outcome?.data);
  if (!outcome || outcome.ok !== true) {
    const item = failedStepItem('结构', title, outcome, 'validate_machine_design');
    // 工具没跑出来时也把机型名带上，便于定位是哪台机器。
    item.evidence = `${item.evidence}${machineName ? `（机型 ${machineName}）` : ''}`;
    return item;
  }
  // validate_machine_design 用 ok:false + issues 表达「方案有问题」，不是工具失败。
  const issues = list(payload.issues);
  const summary = record(payload.summary);
  const errors = num(summary.errors) ?? issues.length;
  const warnings = num(summary.warnings) ?? 0;
  const first = isRecord(issues[0]) ? issues[0] : null;
  const firstCode = first && typeof first.code === 'string' ? first.code : '无';
  const firstPath = first && typeof first.path === 'string' ? first.path : '';
  const noMachine = payload.code === 'NO_MACHINE';
  const passed = payload.ok === true && issues.length === 0;
  const evidence = `issues ${issues.length} 条（errors ${errors} / warnings ${warnings}）· 首个 code ${firstCode}`
    + `${machineName ? ` · 机型 ${machineName}` : ''}`;
  if (noMachine) {
    return {
      area: '结构',
      status: 'fail',
      title,
      evidence: `issues 0 条（NO_MACHINE：当前没有 active 机型方案）${machineName ? ` · 机型 ${machineName}` : ''}`,
      suggestion: '先调 apply_machine_design 落盘当前方案（或用 load_machine_from_library 载入已有机型），再重跑 review-design'
    };
  }
  if (!passed) {
    return {
      area: '结构',
      status: 'fail',
      title,
      evidence,
      suggestion: firstPath
        ? `先按 issues[0] 的 ${firstCode} 改 ${firstPath} 对应的 config 字段，再调 apply_machine_design 落盘并重跑 validate_machine_design`
        : `先调 validate_machine_design 逐条看 issues，改完用 apply_machine_design 落盘后重跑`
    };
  }
  return {
    area: '结构',
    status: 'pass',
    title,
    evidence,
    suggestion: '结构与绑定无阻断项：进 run_plc_generate 做 PLC 轴/信号预检（本项不覆盖预检）'
  };
}

interface InterferenceStateLine {
  name: 'rest' | 'lift' | 'sweep';
  hits: number | null;
  mm3: number | null;
}

function interferenceItem(outcome: ReviewStepOutcome | undefined): DesignReviewItem {
  const title = '三态干涉（rest / lift / sweep）';
  const payload = record(outcome?.data);
  const states = record(payload.states);
  const names = ['rest', 'lift', 'sweep'] as const;
  const lines: InterferenceStateLine[] = [];
  let available = 0;
  for (const name of names) {
    const entry = record(states[name]);
    const hits = num(entry.hits);
    const mm3 = num(entry.mm3);
    lines.push({ name, hits, mm3 });
    if (hits !== null || mm3 !== null) available += 1;
  }

  // 无顶升轴：工具如实返回 STATE_UNAVAILABLE，评审记 N/A（不是失败）。
  if (payload.code === 'STATE_UNAVAILABLE' || outcome?.code === 'STATE_UNAVAILABLE') {
    return {
      area: '干涉',
      status: 'na',
      title,
      evidence: `states 可用 ${available}/3 项（STATE_UNAVAILABLE：当前机型没有可顶升轴，未拿静态位姿冒充 lift）`,
      suggestion: '当前机型没有顶升轴：要评顶升工况，先在机型 config 加 turner-lift 执行机构（含 travelMm），再跑 run_interference_check(states)'
    };
  }
  if (!outcome || outcome.ok !== true) {
    const item = failedStepItem('干涉', title, outcome, 'run_interference_check');
    return item;
  }
  if (available === 0) {
    // 工具成功了却一个状态数字都没有：降级到 warn，交给人工确认。
    return withConfirmHint({
      area: '干涉',
      status: 'warn',
      title,
      evidence: 'states 可用 0/3 项（工具未返回 hits / mm³）',
      suggestion: '重跑 run_interference_check(states:[\'rest\',\'lift\',\'sweep\']) 拿到三态数字'
    }, '干涉结果缺数字');
  }

  const evidence = lines
    .map((line) => `${line.name} ${fmt(line.hits)} hits / ${fmt(line.mm3)} mm³`)
    .join(' · ');
  const totalHits = lines.reduce((sum, line) => sum + (line.hits ?? 0), 0);
  // 最严重的那一态：mm³ 最大（缺数据按 -1 排在后面）
  const worst = lines.reduce((best, line) => ((line.mm3 ?? -1) > (best.mm3 ?? -1) ? line : best), lines[0] as InterferenceStateLine);
  if (totalHits > 0) {
    return {
      area: '干涉',
      status: 'fail',
      title,
      evidence,
      suggestion: `先处理 ${worst.name} 处干涉：用 place_component 或 update_component 调整干涉对的间距/型号，改完重跑 run_interference_check(states:['rest','lift','sweep'])`
    };
  }
  return {
    area: '干涉',
    status: 'pass',
    title,
    evidence,
    suggestion: '三态均无干涉：可继续看电气与成本，出图前跑 run_plc_generate 拿 PLC 预检'
  };
}

function electricalItem(outcome: ReviewStepOutcome | undefined): DesignReviewItem {
  const title = '电气合规（过载 / 压降 / 断路器）';
  if (!outcome || outcome.ok !== true) {
    return failedStepItem('电气', title, outcome, 'run_electrical_check');
  }
  const payload = record(outcome?.data);
  const counts = record(payload.counts);
  const summary = record(payload.summary);
  const errors = num(counts.error) ?? 0;
  const warnings = num(counts.warning) ?? 0;
  const infos = num(counts.info) ?? 0;

  const maxPhase = num(summary.maxPhaseCurrentA);
  const required = num(summary.psuRequiredA);
  const margin = num(summary.psuMarginRatio);
  const breaker = isRecord(summary.breakerSuggestion) ? summary.breakerSuggestion : null;
  const ratedA = breaker ? num(breaker.ratedA) : null;
  const cableMm2 = breaker ? num(breaker.cableMm2) : null;

  const marginPct = margin === null ? null : `${Math.round(margin * 100)}%`;
  const evidence = [
    `错误 ${errors} 条 / 警告 ${warnings} 条 / 提示 ${infos} 条`,
    `过载 最大相电流 ${fmt(maxPhase)}A`,
    `压降 24V 余量 ${marginPct ?? '未给出'}${required === null ? '' : `（需 ${fmt(required)}A）`}`,
    `断路器 ${ratedA === null ? '未给出' : `${fmt(ratedA)}A`} / 进线 ${cableMm2 === null ? '未给出' : `${fmt(cableMm2)}mm²`}`
  ].join('；');

  const missing: string[] = [];
  if (maxPhase === null) missing.push('最大相电流');
  if (margin === null) missing.push('24V 余量（未给 PSU 额定电流）');
  if (ratedA === null) missing.push('主断路器建议值');

  // 首个 error（没有 error 时取首个 warning）的 code + 位置：建议里直接指过去，别写「逐条看 findings」。
  const findings = list(payload.findings).filter(isRecord);
  const firstError = findings.find((item) => item.severity === 'error');
  const firstWarn = findings.find((item) => item.severity === 'warning');
  const lead = firstError ?? firstWarn;
  const firstFindingHint = lead && typeof lead.code === 'string'
    ? `先修 ${lead.code}${typeof lead.location === 'string' && lead.location ? `（${lead.location}）` : ''}`
    : '';

  const base: DesignReviewItem = errors > 0
    ? {
      area: '电气',
      status: 'fail',
      title,
      evidence,
      suggestion: `${firstFindingHint || '先按 run_electrical_check 的 findings 改线号/截面/断路器配合'}，改完重跑 run_electrical_check`
    }
    : warnings > 0
      ? {
        area: '电气',
        status: 'warn',
        title,
        evidence,
        suggestion: `${firstFindingHint || '先按 findings 逐条确认 warning'}，再重跑 run_electrical_check`
      }
      : {
        area: '电气',
        status: 'pass',
        title,
        evidence,
        suggestion: '电气无错误与警告：可跑 run_plc_generate 生成 PLC 目录'
      };

  if (missing.length > 0) {
    return {
      ...base,
      status: base.status === 'fail' ? 'fail' : 'warn',
      suggestion: `${base.suggestion}；缺 ${missing.join('、')}，需人工确认`
    };
  }
  return withConfirmHint(base, '电气证据缺数字');
}

function costItem(outcome: ReviewStepOutcome | undefined): DesignReviewItem {
  const title = '成本与缺价';
  if (!outcome || outcome.ok !== true) {
    return failedStepItem('成本', title, outcome, 'run_cost_report');
  }
  const payload = record(outcome?.data);
  const counts = record(payload.counts);
  const totals = record(payload.totals);
  const missing = num(counts.missing) ?? list(payload.missing).length;
  const lines = num(counts.lines) ?? list(payload.lines).length;
  const grand = num(totals.grand);
  const bomRows = num(payload.bomRows);
  const evidence = `缺价 ${missing} 条 / 明细 ${lines} 行 / BOM ${fmt(bomRows)} 行 · 总价 ${money(grand)}`;
  if (missing > 0) {
    const firstMissing = isRecord(list(payload.missing)[0]) ? list(payload.missing)[0] as Record<string, unknown> : null;
    const firstName = firstMissing && typeof firstMissing.name === 'string' ? firstMissing.name : '';
    return {
      area: '成本',
      status: 'warn',
      title,
      evidence,
      suggestion: `先补价格簿里 ${missing} 条缺价${firstName ? `（首条 ${firstName}）` : ''}，补完再跑 run_cost_report 复核，然后用 export_cost_report 出报价`
    };
  }
  return {
    area: '成本',
    status: 'pass',
    title,
    evidence,
    suggestion: '缺价 0 条：可直接 export_cost_report({format:\'csv\'}) 出报价单'
  };
}

function machineNameOf(context: ReviewStepOutcome | undefined): string | null {
  const payload = record(context?.data);
  const machine = record(payload.machine);
  const name = machine.name ?? payload.machineName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

export function verdictOf(items: DesignReviewItem[]): DesignReviewVerdict {
  if (items.some((item) => item.status === 'fail')) return 'FAIL';
  if (items.some((item) => item.status === 'warn' || item.status === 'na')) return 'WARN';
  return 'PASS';
}

const STATUS_LABEL: Record<DesignReviewStatus, string> = {
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
  na: 'N/A'
};

function summarize(items: DesignReviewItem[], verdict: DesignReviewVerdict): string {
  const order: Record<DesignReviewStatus, number> = { fail: 0, warn: 1, na: 2, pass: 3 };
  const ranked = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const failed = items.filter((item) => item.status === 'fail').map((item) => item.area);
  const warned = items.filter((item) => item.status === 'warn').map((item) => item.area);
  const na = items.filter((item) => item.status === 'na').map((item) => item.area);
  const verdictText = verdict === 'PASS'
    ? '可以出图'
    : verdict === 'WARN'
      ? '可出图但需人工确认'
      : '不可出图';
  const worst = ranked[0];
  const parts = [
    `设计评审 ${verdict}（${verdictText}）：`,
    items.map((item) => `${item.area} ${STATUS_LABEL[item.status]}`).join(' / '),
    failed.length > 0 ? `阻断项 ${failed.length} 个（${failed.join('、')}）` : '',
    warned.length > 0 ? `待确认 ${warned.length} 个（${warned.join('、')}）` : '',
    na.length > 0 ? `不适用 ${na.length} 个（${na.join('、')}）` : '',
    worst && worst.status !== 'pass' ? `先看：${worst.area}` : '',
    `共 ${items.length} 项检查`
  ].filter(Boolean);
  return parts.join('；').replace('：；', '：');
}

/**
 * 汇总器主入口（纯函数）：5 份步骤结果 → 评审结论。
 *
 * 输入缺项（undefined）按「该步未执行」记为 warn，不伪造 pass。
 */
export function summarizeDesignReview(input: DesignReviewInput): DesignReview {
  const machineName = machineNameOf(input.context);
  const items: DesignReviewItem[] = [
    structureItem(input.structure, machineName),
    interferenceItem(input.interference),
    electricalItem(input.electrical),
    costItem(input.cost)
  ];
  const verdict = verdictOf(items);
  return { verdict, items, summary: summarize(items, verdict) };
}

function outcomeOf(result: RecipeStepResult | undefined): ReviewStepOutcome | undefined {
  if (!result) return undefined;
  return {
    ok: result.ok,
    ...(result.code ? { code: result.code } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.skipped ? { skipped: true } : {}),
    ...(result.data !== undefined ? { data: result.data } : {})
  };
}

/** 工具名兜底：配方步骤 id 被改名时按工具名找回对应结果。 */
function pick(results: RecipeStepResult[], stepId: string, tool: string): RecipeStepResult | undefined {
  return results.find((item) => item.stepId === stepId) ?? results.find((item) => item.tool === tool);
}

/** 配方汇总入口：把 `runRecipe` 的步骤结果映射成汇总器输入。 */
export function aggregateDesignReview(results: RecipeStepResult[]): DesignReview {
  const list0 = Array.isArray(results) ? results : [];
  return summarizeDesignReview({
    context: outcomeOf(pick(list0, REVIEW_STEP_IDS.context, 'get_project_context')),
    structure: outcomeOf(pick(list0, REVIEW_STEP_IDS.structure, 'validate_machine_design')),
    interference: outcomeOf(pick(list0, REVIEW_STEP_IDS.interference, 'run_interference_check')),
    electrical: outcomeOf(pick(list0, REVIEW_STEP_IDS.electrical, 'run_electrical_check')),
    cost: outcomeOf(pick(list0, REVIEW_STEP_IDS.cost, 'run_cost_report'))
  });
}

/** 汇总器注册表：`Recipe.aggregate` 是这张表里的 id（纯数据模板不背函数）。 */
export const RECIPE_AGGREGATORS = {
  'design-review': aggregateDesignReview
} as const;

export type RecipeAggregatorId = keyof typeof RECIPE_AGGREGATORS;

export function runRecipeAggregator(
  id: string | undefined,
  results: RecipeStepResult[]
): unknown {
  if (!id) return undefined;
  const aggregator = (RECIPE_AGGREGATORS as Record<string, ((items: RecipeStepResult[]) => unknown) | undefined>)[id];
  if (!aggregator) return undefined;
  try {
    return aggregator(results);
  } catch (error) {
    // 汇总失败不能把已跑完的步骤一起判死：如实留一条结论。
    console.warn(`[RECIPE_AGGREGATOR_FAILED]`, { site: 'desktop/src/agent/design-review.ts:437', id }, error);
    return {
      verdict: 'WARN',
      items: [],
      summary: `汇总失败（${id}）：${error instanceof Error ? error.message : String(error)}；4 项工具结果已保留，需人工确认`
    };
  }
}

/** 报告用：把评审结论拍平成多行文本（不含空话，逐条带证据）。 */
export function describeDesignReview(review: DesignReview): string {
  const lines = [`${review.summary}`];
  for (const item of review.items) {
    lines.push(`- ${item.area}｜${STATUS_LABEL[item.status]}｜${item.title}：${item.evidence}`);
    lines.push(`  下一步：${item.suggestion}`);
  }
  return lines.join('\n');
}

/** 类型守卫：汇总器结论（用于渲染层/报告在 `unknown` 上安全取值）。 */
export function isDesignReview(value: unknown): value is DesignReview {
  if (!isRecord(value)) return false;
  if (typeof value.verdict !== 'string') return false;
  if (typeof value.summary !== 'string') return false;
  return Array.isArray(value.items);
}
