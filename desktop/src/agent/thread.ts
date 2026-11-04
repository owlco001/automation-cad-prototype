/**
 * 多轮会话状态与计划续跑（P7-L）
 *
 * 只保存「跨轮必需、可验证」的信息：
 * - 上一轮做了什么、成没成、被没被拒绝；
 * - 工程指纹（机型 / BOM 行数 / 底板放置数 / 是否有 CAD 模型）；
 * - 未确认的写操作；
 * - 已完成的步骤，供 `runPlan({ resumeFrom })` 跳过。
 *
 * 状态只存在当前进程内，不落盘；所有提示文本都是确定性纯函数，便于评估与冒烟。
 */

import type { AgentContext, AgentSelectionKind } from './context.ts';
import { readListResult } from './trim.ts';
import { resolveReference } from './reference.ts';
import { READ_ONLY_TOOLS, routeIntent } from './router.ts';
import type { CompletedStep } from './feedback.ts';
import { resolveIterationBudget, type IterationBudget } from './iteration-budget.ts';
import { autoVerifyTool, type VerificationChannel } from './verify.ts';
import {
  executePlan,
  type AgentPlan,
  type ExecutePlanDeps,
  type ExecutePlanResult,
  type PlanStep,
  type PlanStepResult
} from './planner.ts';

export const THREAD_SUMMARY_LIMIT = 420;

export type PendingConfirmReason = 'timeout' | 'cancelled';

/** 跨轮拒绝原因：用户拒绝 / 确认超时 / 策略拦截。 */
export type DenialReason = 'user' | 'timeout' | 'policy';

export interface ThreadDenial {
  tool: string;
  /** 规范化后的目标（优先位号）；无目标时省略。 */
  target?: string;
  at: string;
  reason: DenialReason;
  /** 发生拒绝的轮次；按需求以字符串保存，便于审计与提示直接展示。 */
  turnId: string;
}

export interface PendingConfirm {
  tool: string;
  args: Record<string, unknown>;
  /** 0 基步骤下标；对话内工具按本轮顺序。 */
  stepIndex: number;
  reason: PendingConfirmReason;
  message?: string;
}

export interface ThreadTarget {
  kind: AgentSelectionKind;
  id: string;
  label: string;
}

export interface ThreadCompletedStep {
  /** 1 基显示序号。 */
  step: number;
  /** 0 基计划下标；对话内的工具按出现顺序编号。 */
  index: number;
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  code?: string;
  wrote: boolean;
}

export interface ThreadState {
  turnId: number;
  projectFingerprint: string;
  intent: string;
  targets: string[];
  pendingConfirm?: PendingConfirm;
  /** 本会话内被拒绝/拦截的工具与目标；最多 10 条，同键后者覆盖。 */
  denials: ThreadDenial[];
  completedSteps: ThreadCompletedStep[];
  lastReplySummary: string;
  /** targets 的结构化版本，用于跨轮指代「刚才那个件」。 */
  targetRefs?: ThreadTarget[];
  /** 状态来源：对话工具调用或计划执行；防止拿对话步骤去续跑计划。 */
  source?: 'chat' | 'plan';
  /** 计划步骤签名；同一计划才允许按 completedSteps 续跑。 */
  planSignature?: string;
  /** 因迭代预算停下时记录的 0 基续跑位置；续跑用完即清。 */
  nextStepIndex?: number;
  updatedAt?: string;
}

export interface ProjectFacts {
  machine: string;
  bomRows: number;
  placements: number;
  hasCadModel: boolean;
}

export interface ThreadFinishInput {
  intent?: string;
  context?: AgentContext | null;
  completedSteps?: readonly ThreadCompletedStep[];
  reply: string;
  pendingConfirm?: PendingConfirm;
  /** 本轮结束后的完整拒绝快照；缺省时原样保留上一轮 denials。 */
  denials?: readonly ThreadDenial[];
  targetRefs?: readonly ThreadTarget[];
  source?: 'chat' | 'plan';
  planSignature?: string;
  /** 因迭代预算停下时的 0 基续跑位置；不传表示本轮没有停在中间。 */
  nextStepIndex?: number;
  now?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteCount(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.trunc(number);
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 从 AgentContext 或原始 get_project_context 数据里提取指纹四元组。 */
export function projectFacts(context: AgentContext | unknown | null | undefined): ProjectFacts {
  const source = isRecord(context) ? context : {};
  const machineRecord = isRecord(source.machine) ? source.machine : {};
  const plateRecord = isRecord(source.plate) ? source.plate : {};
  const machine = textValue(machineRecord.name) ?? textValue(machineRecord.id) ?? textValue(source.machineName) ?? '未知';
  const placements = plateRecord.placed !== undefined || source.placed !== undefined || source.placementCount !== undefined
    ? finiteCount(plateRecord.placed ?? source.placed ?? source.placementCount)
    : Array.isArray(source.placements) ? source.placements.length : 0;
  const bomContainer = source.bom ?? source.bomRows;
  const bomRows = Array.isArray(bomContainer)
    ? bomContainer.length
    : readListResult(bomContainer, ['rows'])?.items.length
      ?? finiteCount(source.bomRows ?? source.bomCount ?? source.bomLineCount);
  const hasCadModel = source.hasCadModel === true
    || source.cad === true
    || (isRecord(source.cad) && source.cad.hasModel === true)
    || (isRecord(source.scene) && finiteCount(source.scene.parts) > 0);
  return { machine, bomRows, placements, hasCadModel };
}

/** 稳定、可读、可直接做差异说明的工程指纹。 */
export function projectFingerprint(context: AgentContext | unknown | null | undefined): string {
  const facts = projectFacts(context);
  const machine = facts.machine.replace(/[;\n\r]/g, ' ').slice(0, 80) || '未知';
  return `machine=${machine};bom=${facts.bomRows};placed=${facts.placements};cad=${facts.hasCadModel ? 1 : 0}`;
}

export function parseFingerprint(fingerprint: string | null | undefined): ProjectFacts | null {
  if (typeof fingerprint !== 'string' || !fingerprint.trim()) return null;
  const match = fingerprint.match(/^machine=(.*?);bom=(\d+);placed=(\d+);cad=([01])$/);
  if (!match) return null;
  return {
    machine: match[1] || '未知',
    bomRows: Number(match[2]),
    placements: Number(match[3]),
    hasCadModel: match[4] === '1'
  };
}

/** 指纹差异；未知格式返回一条可展示的兜底说明。 */
export function fingerprintChanges(previous: string | null | undefined, current: string | null | undefined): string[] {
  if (!previous || !current || previous === current) return [];
  const before = parseFingerprint(previous);
  const after = parseFingerprint(current);
  if (!before || !after) return [`工程指纹 ${previous} → ${current}`];
  const changes: string[] = [];
  if (before.machine !== after.machine) changes.push(`机型 ${before.machine} → ${after.machine}`);
  if (before.bomRows !== after.bomRows) changes.push(`BOM 行数 ${before.bomRows} → ${after.bomRows}`);
  if (before.placements !== after.placements) changes.push(`底板放置数 ${before.placements} → ${after.placements}`);
  if (before.hasCadModel !== after.hasCadModel) {
    changes.push(`CAD 模型 ${before.hasCadModel ? '有' : '无'} → ${after.hasCadModel ? '有' : '无'}`);
  }
  return changes.length > 0 ? changes : [`工程指纹 ${previous} → ${current}`];
}

function cloneTarget(target: ThreadTarget): ThreadTarget {
  return { kind: target.kind, id: target.id, label: target.label };
}

function cloneStep(step: ThreadCompletedStep): ThreadCompletedStep {
  return {
    step: step.step,
    index: step.index,
    tool: step.tool,
    ...(step.args ? { args: { ...step.args } } : {}),
    ok: step.ok,
    ...(step.code ? { code: step.code } : {}),
    wrote: step.wrote
  };
}

function clonePending(pending: PendingConfirm | undefined): PendingConfirm | undefined {
  if (!pending) return undefined;
  return {
    tool: pending.tool,
    args: { ...pending.args },
    stepIndex: pending.stepIndex,
    reason: pending.reason,
    ...(pending.message ? { message: pending.message } : {})
  };
}

function cloneDenial(denial: ThreadDenial): ThreadDenial {
  return {
    tool: denial.tool,
    ...(denial.target ? { target: denial.target } : {}),
    at: denial.at,
    reason: denial.reason,
    turnId: denial.turnId
  };
}

const DENIAL_REASONS = new Set<DenialReason>(['user', 'timeout', 'policy']);
export const DENIAL_LIMIT = 10;

function denialTargetKey(target: string | undefined): string {
  return (target ?? '').trim().toLowerCase();
}

function isThreadDenial(value: unknown): value is ThreadDenial {
  if (!isRecord(value)) return false;
  if (typeof value.tool !== 'string' || !value.tool.trim()) return false;
  if (typeof value.at !== 'string' || !value.at.trim()) return false;
  if (typeof value.turnId !== 'string' || !value.turnId.trim()) return false;
  if (!DENIAL_REASONS.has(value.reason as DenialReason)) return false;
  return value.target === undefined || typeof value.target === 'string';
}

/**
 * 拒绝记忆的规范化入口：过滤非法项、按工具+目标去重（后者覆盖并移到末尾），
 * 最后只保留最近 `DENIAL_LIMIT` 条。目标比较忽略大小写与首尾空格。
 */
export function normalizeDenials(denials: readonly ThreadDenial[] | null | undefined): ThreadDenial[] {
  if (!Array.isArray(denials)) return [];
  const byKey = new Map<string, ThreadDenial>();
  for (const item of denials) {
    if (!isThreadDenial(item)) continue;
    const tool = item.tool.trim();
    const target = item.target?.trim();
    const denial: ThreadDenial = {
      tool,
      ...(target ? { target } : {}),
      at: item.at.trim(),
      reason: item.reason,
      turnId: item.turnId.trim()
    };
    const key = `${tool}\u0000${denialTargetKey(denial.target)}`;
    // 后出现的记录覆盖旧记录，并移动到末尾，保证“最近”顺序稳定。
    byKey.delete(key);
    byKey.set(key, denial);
  }
  return [...byKey.values()].slice(-DENIAL_LIMIT);
}

export function sameDenialTarget(left: string | undefined, right: string | undefined): boolean {
  return denialTargetKey(left) === denialTargetKey(right);
}

/** 命中同工具同目标的拒绝记录；没有则返回 null。 */
export function findDenial(
  denials: readonly ThreadDenial[] | null | undefined,
  tool: string,
  target?: string
): ThreadDenial | null {
  if (!Array.isArray(denials)) return null;
  for (let index = denials.length - 1; index >= 0; index -= 1) {
    const denial = denials[index];
    if (denial?.tool === tool && sameDenialTarget(denial.target, target)) return denial;
  }
  return null;
}

/** 删除命中记录并返回新数组；不修改调用方持有的旧数组。 */
export function removeDenial(
  denials: readonly ThreadDenial[],
  tool: string,
  target?: string
): ThreadDenial[] {
  return denials.filter((denial) => !(denial.tool === tool && sameDenialTarget(denial.target, target)));
}

const DENIAL_TARGET_KEYS = ['ref', 'designator', 'tag', 'target', 'partId', 'id', 'path', 'fileName', 'kind'] as const;

/**
 * 把工具参数里的目标归一成稳定指纹。位号 / id / 型号命中当前上下文里的放置件时，
 * 一律用位号表示，避免同一目标因参数写法不同绕过拒绝记忆。
 */
export function denialTarget(
  args: Record<string, unknown> | null | undefined,
  context?: AgentContext | null
): string | undefined {
  const source = args ?? {};
  for (const key of DENIAL_TARGET_KEYS) {
    const raw = source[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const value = raw.trim();
    const lower = value.toLowerCase();
    const placement = context?.placements?.find((item) => {
      const model = (item as unknown as Record<string, unknown>).model;
      return [item.id, item.label, model].some((candidate) =>
        typeof candidate === 'string' && candidate.trim().toLowerCase() === lower
      );
    });
    if (placement) return (placement.label || placement.id || value).trim();
    return value;
  }
  const selection = context?.selection;
  if (selection) return (selection.label || selection.id || '').trim() || undefined;
  return undefined;
}

export function cloneThreadState(state: ThreadState | null | undefined): ThreadState | null {
  if (!state) return null;
  return {
    turnId: state.turnId,
    projectFingerprint: state.projectFingerprint,
    intent: state.intent,
    targets: [...state.targets],
    ...(state.pendingConfirm ? { pendingConfirm: clonePending(state.pendingConfirm)! } : {}),
    denials: normalizeDenials(state.denials ?? []),
    completedSteps: state.completedSteps.map(cloneStep),
    lastReplySummary: state.lastReplySummary,
    ...(state.targetRefs && state.targetRefs.length > 0 ? { targetRefs: state.targetRefs.map(cloneTarget) } : {}),
    ...(state.source ? { source: state.source } : {}),
    ...(state.planSignature ? { planSignature: state.planSignature } : {}),
    ...(state.nextStepIndex !== undefined ? { nextStepIndex: state.nextStepIndex } : {}),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {})
  };
}

function clipSummary(text: string, limit = THREAD_SUMMARY_LIMIT): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...oneLine];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : oneLine;
}

const TARGET_ARG_KEYS = ['ref', 'designator', 'tag', 'partId', 'model', 'newModel'] as const;

/** 从上下文选中对象和已完成步骤的参数里收集「上一轮涉及对象」。 */
export function collectThreadTargets(
  context: AgentContext | null | undefined,
  completed: readonly ThreadCompletedStep[] = []
): ThreadTarget[] {
  const output: ThreadTarget[] = [];
  const seen = new Set<string>();
  const push = (target: ThreadTarget): void => {
    const label = target.label || target.id;
    const key = `${target.kind}:${target.id}:${label}`;
    if (!target.id || seen.has(key)) return;
    seen.add(key);
    output.push({ kind: target.kind, id: target.id, label });
  };
  if (context?.selection) {
    push({ kind: context.selection.kind, id: context.selection.id, label: context.selection.label });
  }
  for (const step of completed) {
    for (const key of TARGET_ARG_KEYS) {
      const raw = step.args?.[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const label = raw.trim();
      const existing = context?.placements?.find((item) => item.id === label || item.label === label);
      push({ kind: 'placement', id: existing?.id ?? label, label: existing?.label ?? label });
      break;
    }
  }
  return output.slice(0, 6);
}

function targetSummary(targets: readonly ThreadTarget[]): string[] {
  const labels: string[] = [];
  for (const target of targets) {
    const label = target.label || target.id;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * 每轮结束后由会话或计划执行器写入。turnId 自增；旧状态只影响 id 与 targets 合并。
 */
export class AgentThread {
  private state: ThreadState | null = null;

  read(): ThreadState | null {
    return cloneThreadState(this.state);
  }

  write(state: ThreadState): ThreadState {
    this.state = cloneThreadState(state);
    return this.read()!;
  }

  clear(): void {
    this.state = null;
  }

  finish(input: ThreadFinishInput): ThreadState {
    // 状态只在一轮内有效；调用方必须在下一轮开始前读取上一轮状态。
    const previous = this.state;
    const turnId = (previous?.turnId ?? 0) + 1;
    const targetRefs = input.targetRefs
      ? input.targetRefs.slice(0, 6).map(cloneTarget)
      : collectThreadTargets(input.context, input.completedSteps ?? []);
    const mergedTargets = [...new Set([...(previous?.targets ?? []), ...targetSummary(targetRefs)])].slice(-8);
    const completedSteps = (input.completedSteps ?? []).map(cloneStep);
    const denials = input.denials !== undefined
      ? normalizeDenials(input.denials)
      : normalizeDenials(previous?.denials ?? []);
    const state: ThreadState = {
      turnId,
      projectFingerprint: projectFingerprint(input.context ?? null),
      intent: input.intent ?? '',
      targets: mergedTargets.length > 0 ? mergedTargets : [...(previous?.targets ?? [])],
      ...(input.pendingConfirm ? { pendingConfirm: clonePending(input.pendingConfirm)! } : {}),
      denials: denials.map(cloneDenial),
      completedSteps,
      lastReplySummary: clipSummary(input.reply),
      ...(targetRefs.length > 0 ? { targetRefs } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.planSignature ? { planSignature: input.planSignature } : {}),
      ...(input.nextStepIndex !== undefined ? { nextStepIndex: input.nextStepIndex } : {}),
      updatedAt: input.now ?? new Date().toISOString()
    };
    this.state = state;
    return cloneThreadState(state)!;
  }
}

export interface ThreadTurnStart {
  previous: ThreadState | null;
  turnId: number;
}

/** 下一轮开始时读取旧状态并分配 turnId；不会清空，结束后统一 `finish` 覆盖。 */
export function beginTurn(thread: AgentThread): ThreadTurnStart {
  const previous = thread.read();
  return { previous, turnId: (previous?.turnId ?? 0) + 1 };
}

function describeSteps(steps: readonly ThreadCompletedStep[]): string {
  return steps.map((step) => {
    const outcome = step.ok ? '成功' : `失败 ${step.code ?? 'FAILED'}`;
    const write = step.wrote ? '写' : '只读';
    return `第 ${step.step} 步 ${step.tool}（${outcome}，${write}）`;
  }).join('、');
}

function pendingText(pending: PendingConfirm): string {
  const args = Object.keys(pending.args).length > 0 ? JSON.stringify(pending.args) : '无参数';
  const reason = pending.reason === 'timeout' ? '确认超时' : '确认被取消';
  return `${pending.tool} ${args}（${reason}）`;
}

function denialLabel(denial: ThreadDenial): string {
  const reason = denial.reason === 'user' ? '用户拒绝' : denial.reason === 'policy' ? '策略拦截' : '确认超时';
  const target = denial.target ? `(${denial.target})` : '';
  return `${denial.tool}${target}（${reason}，第 ${denial.turnId} 轮）`;
}

/** 下一轮提示里的跨轮拒绝段落；纯函数，便于测试精确文案。 */
export function formatDenialPrompt(denials: readonly ThreadDenial[] | null | undefined): string[] {
  const normalized = normalizeDenials(denials ?? []);
  if (normalized.length === 0) return [];
  const permanent = normalized.filter((denial) => denial.reason !== 'timeout');
  const timeouts = normalized.filter((denial) => denial.reason === 'timeout');
  const lines: string[] = [];
  if (permanent.length > 0) {
    lines.push(`本会话已被拒绝：${permanent.map(denialLabel).join('；')}。`);
    lines.push('除非用户明确说『我同意/现在就改』，不得再次调用同一工具同一目标。');
  }
  if (timeouts.length > 0) {
    lines.push(`本会话曾有确认超时：${timeouts.map(denialLabel).join('；')}。超时不是永久拒绝，重试前必须先向用户说明并取得确认。`);
  }
  return lines;
}

/**
 * 下一轮系统提示。没有上一轮状态时返回空串；指纹变化时固定出现
 * 「工程已变化，不要沿用旧结论」。
 */
export function formatThreadContext(
  previous: ThreadState | null | undefined,
  currentContext?: AgentContext | null
): string {
  if (!previous) return '';
  const lines = ['[上一轮会话]'];
  lines.push(`第 ${previous.turnId} 轮 · 意图 ${previous.intent || '未知'} · 涉及对象 ${previous.targets.length > 0 ? previous.targets.join('、') : '无'}`);
  const unfinished = Boolean(previous.pendingConfirm) || previous.completedSteps.some((step) => !step.ok);
  lines.push(`上一轮结果：${unfinished ? '未完成' : '已完成'}`);
  if (previous.completedSteps.length > 0) {
    const denied = previous.completedSteps.filter((step) => step.code === 'USER_DENIED');
    const failed = previous.completedSteps.filter((step) => !step.ok && step.code !== 'USER_DENIED');
    lines.push(`完成情况：${describeSteps(previous.completedSteps)}`);
    if (denied.length > 0) {
      lines.push(`用户已拒绝：${denied.map((step) => step.tool).join('、')}。不要自动重试，除非本轮用户明确要求重新执行。`);
    }
    if (failed.length > 0) {
      lines.push(`失败步骤：${failed.map((step) => `${step.tool}（${step.code ?? 'FAILED'}）`).join('、')}。不要声称已完成。`);
    }
  } else {
    lines.push('完成情况：上一轮没有已完成的步骤。');
  }
  if (previous.pendingConfirm) {
    lines.push(`未确认操作：${pendingText(previous.pendingConfirm)}。下一轮必须先问用户「是否继续上次未确认的操作」，用户明确同意前不得执行，也不得自动重试。`);
  }
  const denialLines = formatDenialPrompt(previous.denials ?? []);
  if (denialLines.length > 0) {
    lines.push('[跨轮拒绝记忆]');
    lines.push(...denialLines);
  }
  if (currentContext) {
    const current = projectFingerprint(currentContext);
    const changes = fingerprintChanges(previous.projectFingerprint, current);
    if (changes.length > 0) {
      lines.push(`工程已变化，不要沿用旧结论（${changes.join('；')}）。需要重新读取工程上下文后再决定。`);
    } else {
      lines.push('工程指纹：与上一轮一致。');
    }
  }
  lines.push('若用户说「继续 / 接着上次」，仅在工程指纹一致时从已完成步骤之后继续；指纹不同则要求先重跑前置步骤。');
  if (previous.targets.length > 0) {
    lines.push(`跨轮指代：「刚才那个件 / 它」默认指 ${previous.targets.join('、')}；若当前选中对象不同，以当前选中为准。`);
  }
  if (previous.lastReplySummary) lines.push(`上一轮回复摘要：${previous.lastReplySummary}`);
  return lines.join('\n');
}

const THREAD_REFERENCE = /(?:刚才|刚刚|上一个|上一件|那个件|同一件|它)/;

/**
 * 上下文里没有选中对象、最近操作也不足以指代时，把上一轮目标补成一条
 * 合成的最近操作，让 `resolveReference` 能解析「刚才那个件」。
 */
export function augmentContextWithThreadReference(
  text: string,
  context: AgentContext,
  previous: ThreadState | null | undefined
): AgentContext {
  if (!previous?.targetRefs?.length || !THREAD_REFERENCE.test(text)) return context;
  if (context.selection) return context;
  const target = previous.targetRefs[previous.targetRefs.length - 1];
  if (!target) return context;
  const marker = `[target=${target.kind}:${target.id}:${target.label}]`;
  const already = context.recentActions.some((action) => action.summary.includes(marker));
  if (already) return context;
  const synthetic = {
    tool: 'thread_target',
    summary: `上一轮目标 ${target.label || target.id} ${marker}`,
    at: new Date().toISOString()
  };
  return { ...context, recentActions: [...context.recentActions.slice(-2), synthetic] };
}

/** 「刚才那个件」的确定性解析入口（供测试与调用方复用）。 */
export function resolveThreadReference(
  text: string,
  context: AgentContext,
  previous: ThreadState | null | undefined
): ReturnType<typeof resolveReference> {
  return resolveReference(text, augmentContextWithThreadReference(text, context, previous));
}

/** 计划步骤签名：工具名 + 参数；用于确认续跑的是同一份计划。 */
export function planSignature(plan: AgentPlan): string {
  return plan.steps.map((step) => `${step.tool}:${JSON.stringify(step.args)}`).join('|');
}

export interface RunPlanOptions extends ExecutePlanDeps {
  /** 0 基续跑起点；本轮会跳过该点及之后已完成且成功的步骤。 */
  resumeFrom?: number;
  /** 上一轮状态；缺省读取 `thread.read()`。 */
  previous?: ThreadState | null;
  /** 当前工程上下文，用于指纹比对与状态写入。 */
  currentContext?: AgentContext | null;
  /** 传入后自动写回本轮状态。 */
  thread?: AgentThread;
  /** 状态里的意图；缺省按上一步骤推断。 */
  intent?: string;
  userText?: string;
  /**
   * 写后自动验证通道（与 `AgentSession` 同一个 `verify.ts#autoVerifyTool` 入口）。
   * 不传表示前端没有接验证能力：不补 verification 字段，也不伪造结论。
   */
  verifyChannel?: VerificationChannel;
  /** 迭代预算基线；缺省 6，含写步骤或步骤 ≥4 时上抬到 12。 */
  maxIterations?: number;
}

export interface RunPlanResult extends ExecutePlanResult {
  resumedFrom?: number;
  skippedSteps?: number;
  stale?: boolean;
  changed?: string[];
  /** 本轮预算（含上抬原因），与会话层 `turnOutcome().budget` 同源。 */
  budget?: IterationBudget;
  /** 本轮实际执行（不含续跑跳过）的步骤数。 */
  iterations?: number;
  /** 预算用尽而停下；已完成的步骤保留在 results / 线程状态里。 */
  stopped?: 'iteration_limit';
  /** 停下时给用户的下一步说法。 */
  pendingHint?: string;
  /** 预算停下时的 0 基续跑位置（= 第一个未执行步骤）。 */
  nextStepIndex?: number;
}

function completedIndexes(steps: readonly ThreadCompletedStep[]): Set<number> {
  const done = new Set<number>();
  for (const step of steps) {
    if (step.ok) done.add(step.index);
  }
  return done;
}

/** 第一个尚未成功完成的步骤下标；`from` 为下限。 */
export function nextIncompleteStep(
  completed: readonly ThreadCompletedStep[],
  total: number,
  from = 0
): number {
  const done = completedIndexes(completed);
  const start = Math.max(0, Math.min(total, Math.trunc(from)));
  for (let index = start; index < total; index += 1) {
    if (!done.has(index)) return index;
  }
  return total;
}

function planStepToThread(step: PlanStep, index: number, ok: boolean, code?: string): ThreadCompletedStep {
  return {
    step: index + 1,
    index,
    tool: step.tool,
    args: { ...step.args },
    ok,
    ...(code ? { code } : {}),
    wrote: ok && !step.readOnly
  };
}

function resultStepToThread(result: PlanStepResult, step: PlanStep | undefined): ThreadCompletedStep {
  return {
    step: result.step,
    index: result.index,
    tool: result.tool,
    ...(step ? { args: { ...step.args } } : {}),
    ok: result.ok,
    ...(result.code ? { code: result.code } : {}),
    wrote: result.ok && result.index >= 0 && !(step?.readOnly ?? false)
  };
}

function mergeThreadSteps(
  previous: readonly ThreadCompletedStep[],
  current: readonly ThreadCompletedStep[]
): ThreadCompletedStep[] {
  const byIndex = new Map<number, ThreadCompletedStep>();
  for (const step of previous) byIndex.set(step.index, cloneStep(step));
  for (const step of current) byIndex.set(step.index, cloneStep(step));
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

function planPending(
  plan: AgentPlan,
  result: ExecutePlanResult,
  startAt: number
): PendingConfirm | undefined {
  if (!result.cancelled) return undefined;
  if (result.confirmOutcome !== 'timeout' && result.confirmOutcome !== 'aborted') return undefined;
  const completed = result.results.map((item) => item.index);
  let index = startAt;
  while (index < plan.steps.length && completed.includes(index)) index += 1;
  const step = plan.steps[index];
  if (!step) return undefined;
  return {
    tool: step.tool,
    args: { ...step.args },
    stepIndex: index,
    reason: result.confirmOutcome === 'timeout' ? 'timeout' : 'cancelled',
    ...(result.summary ? { message: result.summary } : {})
  };
}

function refusal(
  summary: string,
  extra: { stale?: boolean; changed?: string[] }
): RunPlanResult {
  const result: RunPlanResult = {
    ok: false,
    confirmationRequired: false,
    confirmed: false,
    refused: true,
    results: [],
    totalMs: 0,
    summary,
    ...(extra.stale ? { stale: true } : {}),
    ...(extra.changed && extra.changed.length > 0 ? { changed: extra.changed } : {})
  };
  return result;
}

/** 预算用尽时的下一步说法：必须能照说，且点明从第几步接着跑。 */
export function iterationLimitHint(
  nextStepIndex: number,
  totalSteps: number,
  budget: IterationBudget,
  iterations: number
): string {
  const remaining = Math.max(0, totalSteps - nextStepIndex);
  return `本轮已执行 ${iterations} 步，达到预算上限 ${budget.effective}（原因 ${budget.reason}）；`
    + `还剩 ${remaining} 步未执行，说「继续」会从第 ${nextStepIndex + 1} 步接着跑`;
}

/** 计划里是否有写步骤（未知工具按写步骤处理，与计划卡片一致）。 */
export function planHasWrite(plan: AgentPlan): boolean {
  return plan.steps.some((step) => !READ_ONLY_TOOLS.has(step.tool));
}

/**
 * 带跨轮续跑的计划执行器。
 *
 * - 不传 `resumeFrom`：等价于 `executePlan`，另外套一层自适应预算；
 * - 传 `resumeFrom`：要求上一轮状态存在；指纹不同直接拒绝且不执行任何工具；
 * - 指纹一致时从 `resumeFrom` 起跳过已成功完成的步骤；
 * - 预算用尽：返回 `stopped:'iteration_limit'` + `pendingHint` + `nextStepIndex`，
 *   已完成的步骤保留在 `results` 和线程状态里，可直接 `resumeRunPlan` 接着跑。
 */
export async function runPlan(plan: AgentPlan, options: RunPlanOptions): Promise<RunPlanResult> {
  const {
    resumeFrom,
    previous: providedPrevious,
    currentContext,
    thread,
    intent,
    userText,
    verifyChannel,
    maxIterations,
    ...deps
  } = options;
  const previous = providedPrevious === undefined ? (thread?.read() ?? null) : providedPrevious;
  const projectChanged = Boolean(
    previous && currentContext && fingerprintChanges(previous.projectFingerprint, projectFingerprint(currentContext)).length > 0
  );
  const changed = previous && currentContext
    ? fingerprintChanges(previous.projectFingerprint, projectFingerprint(currentContext))
    : [];

  let startAt: number | undefined = deps.startAt;
  let skippedSteps = 0;
  if (resumeFrom !== undefined) {
    if (!previous) {
      return refusal('没有可续跑的上一次计划状态；请先重新执行前置步骤。', {});
    }
    if (projectChanged) {
      return refusal(
        `工程已变化（${changed.join('；')}），不能从第 ${Math.max(1, Math.trunc(resumeFrom) + 1)} 步续跑；请重跑前置步骤。`,
        { stale: true, changed }
      );
    }
    if (previous.source === 'chat') {
      return refusal('上一轮是对话工具调用，不是可续跑的计划；请重新生成计划。', {});
    }
    if (previous.planSignature && previous.planSignature !== planSignature(plan)) {
      return refusal('计划步骤已变化，不能沿用上一轮的完成记录；请重跑前置步骤。', {});
    }
    const resumeAt = Math.max(0, Math.min(plan.steps.length, Math.trunc(resumeFrom)));
    startAt = nextIncompleteStep(previous.completedSteps, plan.steps.length, resumeAt);
    skippedSteps = Math.max(0, startAt - resumeAt);
  }

  if (plan.steps.length === 0) {
    const result = await executePlan(plan, deps);
    return { ...result, ...(startAt !== undefined ? { resumedFrom: startAt, skippedSteps } : {}) };
  }

  const effectiveStart = Math.max(0, Math.min(plan.steps.length, Math.trunc(startAt ?? 0)));
  if (resumeFrom !== undefined && effectiveStart >= plan.steps.length) {
    return {
      ok: true,
      confirmationRequired: false,
      confirmed: true,
      results: [],
      totalMs: 0,
      summary: '上次计划已全部完成，无需续跑',
      resumedFrom: effectiveStart,
      skippedSteps: Math.max(0, effectiveStart - Math.max(0, Math.trunc(resumeFrom)))
    };
  }

  // 自适应预算：与会话层同一实现（iteration-budget.ts，session.ts re-export），不在这里另写规则。
  const totalSteps = plan.steps.length;
  const remaining = Math.max(0, totalSteps - effectiveStart);
  const resolved = resolveIterationBudget({
    ...(maxIterations !== undefined ? { base: maxIterations } : {}),
    hasWrite: planHasWrite(plan),
    planSteps: totalSteps
  });
  // 调用方显式给的 maxSteps 比预算更小时，本轮真实上限就是 maxSteps：如实写进 budget，
  // 否则会报「预算 12」却只跑 1 步，验收时对不上。
  const explicitMax = Number.isFinite(deps.maxSteps) ? Math.max(1, Math.trunc(deps.maxSteps!)) : null;
  const budget: IterationBudget = explicitMax !== null && explicitMax < resolved.effective
    ? { ...resolved, effective: explicitMax }
    : resolved;
  const allowance = Math.max(1, Math.min(remaining, budget.effective));
  const truncated = allowance < remaining;

  const result = await executePlan(plan, {
    ...deps,
    ...(startAt !== undefined ? { startAt } : {}),
    maxSteps: allowance,
    ...(verifyChannel
      ? { verify: (step: PlanStep, raw: unknown, signal?: AbortSignal) => autoVerifyTool(verifyChannel, step.tool, raw, signal) }
      : {})
  });

  const iterations = result.results.length;
  const stoppedAtBudget = truncated
    && !result.cancelled
    && result.failedIndex === undefined
    && iterations >= allowance;
  const nextStepIndex = stoppedAtBudget ? effectiveStart + iterations : undefined;
  const stoppedFields = nextStepIndex !== undefined
    ? {
        stopped: 'iteration_limit' as const,
        pendingHint: iterationLimitHint(nextStepIndex, totalSteps, budget, iterations),
        nextStepIndex
      }
    : {};
  const verificationNote = verificationFailedNote(result.results);
  const summary = [
    result.summary + (nextStepIndex !== undefined
      ? `（本轮预算 ${budget.effective} 步已用尽，第 ${nextStepIndex + 1} 步起未执行）`
      : ''),
    verificationNote
  ].filter(Boolean).join('；');

  if (thread) {
    const currentSteps = result.results.map((item) => resultStepToThread(item, plan.steps[item.index]));
    const completed = resumeFrom !== undefined && previous
      ? mergeThreadSteps(previous.completedSteps, currentSteps)
      : currentSteps;
    const pending = planPending(plan, result, effectiveStart);
    thread.finish({
      ...(intent ? { intent } : previous?.intent ? { intent: previous.intent } : { intent: userText ? routeIntent(userText).intent : 'plan' }),
      ...(currentContext ? { context: currentContext } : {}),
      completedSteps: completed,
      reply: summary,
      source: 'plan',
      planSignature: planSignature(plan),
      ...(pending ? { pendingConfirm: pending } : {}),
      ...(nextStepIndex !== undefined ? { nextStepIndex } : {})
    });
  }

  return {
    ...result,
    summary,
    budget,
    iterations,
    ...stoppedFields,
    ...(resumeFrom !== undefined ? { resumedFrom: effectiveStart, skippedSteps } : {})
  };
}

/** 写后自查未通过的一行说明（只在真发现问题时出现，正常计划摘要不变）。 */
function verificationFailedNote(results: readonly PlanStepResult[]): string {
  const failed = results.filter((item) => item.verification?.ok === false);
  if (failed.length === 0) return '';
  return `写后自查未通过：${failed
    .map((item) => `第 ${item.step} 步 ${item.tool}${item.verification?.nextAction ? `（${item.verification.nextAction}）` : ''}`)
    .join('、')}`;
}

/**
 * 从上一轮状态续跑计划的最小入口：优先用 `nextStepIndex`（预算停下处），
 * 回落到「第一个未成功的步骤」。没有上一轮状态时返回拒绝结果。
 */
export async function resumeRunPlan(plan: AgentPlan, options: RunPlanOptions): Promise<RunPlanResult> {
  const previous = options.previous === undefined ? (options.thread?.read() ?? null) : options.previous;
  if (!previous) {
    return refusal('没有可续跑的上一次计划状态；请先重新执行前置步骤。', {});
  }
  const from = resumePoint(plan, previous);
  return runPlan(plan, { ...options, previous, resumeFrom: from });
}

/** 续跑起点：预算记录优先，其次第一个未成功步骤。 */
export function resumePoint(plan: AgentPlan, state: ThreadState | null | undefined): number {
  if (!state) return 0;
  if (state.nextStepIndex !== undefined) {
    return Math.max(0, Math.min(plan.steps.length, Math.trunc(state.nextStepIndex)));
  }
  return nextIncompleteStep(state.completedSteps, plan.steps.length, 0);
}

/** 给 IPC / 评估脚本用：把对话里的 CompletedStep 转成线程步骤。 */
export function completedToThreadSteps(steps: readonly CompletedStep[]): ThreadCompletedStep[] {
  return steps.map((step, index) => ({
    step: index + 1,
    index,
    tool: step.tool,
    ...(step.args ? { args: { ...step.args } } : {}),
    ok: step.ok,
    ...(step.code ? { code: step.code } : {}),
    wrote: step.wrote
  }));
}
