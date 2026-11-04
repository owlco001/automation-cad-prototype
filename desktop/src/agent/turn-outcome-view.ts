/**
 * 收尾信息的「可点」呈现（纯函数，P5）
 *
 * 会话层 `AgentSession#turnOutcome()` 早在预算到顶时就把
 * `{iterations, budget, stopped, pendingHint}` 交出来了，但此前只有回复文字里
 * 「继续请说『继续』」这句话——界面上没有可点的东西。这里把那份结构化信息变成
 * 一行提示 + 一个【继续】按钮的 HTML 片段：
 *
 * - 不碰 DOM、不读环境、不 import 渲染层模块，`node --test` 可直接跑；
 * - `ui.ts` 只负责把字符串塞进已有的 `#agentChatFeedback`，点击走现有发送通道；
 * - `electron/ipc.ts` 用同一份规则产出 `outcome.continueHint`，界面与回执不漂移。
 *
 * 安全口径：pendingHint 来自模型（不可信），进 HTML 前逐字符转义，长度截到 200 字。
 */

/** `AgentTurnOutcome.stopped` 的两个取值；不在这里增删，避免与 session.ts 漂移。 */
export type AgentTurnStopReason = 'iteration_limit' | 'repeated_reads';

/** pendingHint 上限：够说清「下一步做什么」，又不至于把一行提示撑成一屏。 */
export const PENDING_HINT_LIMIT = 200;

/** 点【继续】时发给会话的原文（走现有 `agent:chat:send` 通道）。 */
export const AGENT_CONTINUE_ACTION = '继续';

/** 只读空转提前收尾的固定文案：不能说「达到上限」，那是另一回事。 */
export const REPEATED_READS_TEXT = '这一步没有新的结果，已停；可以缩小范围或换个问法';

/** 结构化的入参；只取需要的字段，session.ts 的 `AgentTurnOutcome` 天然兼容。 */
export interface AgentTurnOutcomeView {
  iterations?: number;
  budget?: {
    base?: number;
    effective?: number;
    reason?: string;
  } | null;
  stopped?: string | null;
  pendingHint?: string | null;
}

/** IPC 回执里的 `outcome`：字段与 `AgentTurnOutcome` 对齐，另加可照念的下一步。 */
export interface AgentChatOutcome {
  iterations: number;
  budget: { base: number; effective: number; reason: string };
  stopped?: AgentTurnStopReason;
  pendingHint?: string;
  /** 人能直接读的一行结论（与界面文案同源）。仅在 stopped 存在时出现。 */
  continueHint?: string;
  /** 点【继续】时该发的原文。仅在 stopped 存在时出现。 */
  nextAction?: string;
}

function asOutcome(value: unknown): AgentTurnOutcomeView | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AgentTurnOutcomeView)
    : null;
}

function toCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

/**
 * 按码点截断，绝不切坏中文/emoji（`slice` 按 UTF-16 码元切，会把代理对劈成半个字符）。
 * 超限时留一个省略号，总长仍然 ≤ limit。
 */
export function truncatePendingHint(text: unknown, limit = PENDING_HINT_LIMIT): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  const points = Array.from(trimmed);
  if (points.length <= limit) return points.join('');
  const keep = Math.max(0, limit - 1);
  return `${points.slice(0, keep).join('')}…`;
}

/** 预算上抬原因的人话版本：界面 tooltip 与 IPC 回执共用。 */
export function budgetReasonText(reason: unknown, budget?: { base?: number; effective?: number } | null): string {
  const base = toCount(budget?.base, 0);
  const effective = toCount(budget?.effective, base);
  switch (reason) {
    case 'write':
      return `本轮有写操作，预算上抬到 ${effective} 步`;
    case 'long-plan':
      return `计划步骤 4 步以上，预算上抬到 ${effective} 步`;
    case 'commission':
      return `联调任务天然多步，预算上抬到 ${effective} 步`;
    case 'read-only':
    default:
      return `只读问答，按基础预算 ${base} 步`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 一行纯文本结论（不含按钮）。`null` 表示「本轮正常结束，不该提示任何东西」。
 * repeated_reads 用固定文案，避免把「空转」说成「到上限」。
 */
export function turnOutcomeText(outcome: AgentTurnOutcomeView | null | undefined): string | null {
  const view = asOutcome(outcome);
  if (!view) return null;
  const stopped = view.stopped;
  if (stopped !== 'iteration_limit' && stopped !== 'repeated_reads') return null;
  if (stopped === 'repeated_reads') return REPEATED_READS_TEXT;
  const effective = toCount(view.budget?.effective, 0);
  const hint = truncatePendingHint(view.pendingHint);
  const head = effective > 0 ? `已达本轮上限（${effective} 步）` : '已达本轮上限';
  return hint ? `${head}· ${hint}` : head;
}

/**
 * 渲染成可直接塞进 `#agentChatFeedback` 的 HTML 片段。
 * 只有文本 + 一个按钮，容器与按钮都复用已有 class（`acp-plan-actions` / `acp-btn`），不新增样式。
 */
export function renderAgentTurnOutcome(outcome: AgentTurnOutcomeView | null | undefined): string | null {
  const text = turnOutcomeText(outcome);
  if (!text) return null;
  const stopped = outcome?.stopped === 'repeated_reads' ? 'repeated_reads' : 'iteration_limit';
  const title = escapeHtml(budgetReasonText(outcome?.budget?.reason, outcome?.budget));
  const action = escapeHtml(AGENT_CONTINUE_ACTION);
  return (
    `<span data-agent-continue="${stopped}" title="${title}">${escapeHtml(text)}</span>` +
    `<div class="acp-plan-actions"><button type="button" class="acp-btn acp-btn-ghost" ` +
    `data-agent-continue-send="${action}">${action}</button></div>`
  );
}

/**
 * IPC 回执用的结构化收尾信息（`agent:chat:send` 的 `outcome` 字段）。
 *
 * 规则：`continueHint` / `nextAction` 只在 `stopped` 存在时出现——正常结束的一轮
 * 不该给界面任何「继续」的暗示。旧调用方不读 `outcome` 也不受影响。
 */
export function toAgentChatOutcome(outcome: AgentTurnOutcomeView | null | undefined): AgentChatOutcome | null {
  const view = asOutcome(outcome);
  if (!view) return null;
  const base = toCount(view.budget?.base, 0);
  const effective = toCount(view.budget?.effective, base);
  const result: AgentChatOutcome = {
    iterations: toCount(view.iterations, 0),
    budget: {
      base,
      effective,
      reason: typeof view.budget?.reason === 'string' ? view.budget.reason : 'read-only'
    }
  };
  const hint = truncatePendingHint(view.pendingHint);
  if (hint) result.pendingHint = hint;
  const stopped = view.stopped;
  if (stopped !== 'iteration_limit' && stopped !== 'repeated_reads') return result;
  result.stopped = stopped;
  const text = turnOutcomeText(view);
  if (text) result.continueHint = text;
  result.nextAction = AGENT_CONTINUE_ACTION;
  return result;
}
