/**
 * 自适应迭代预算（机制层，P7-budget）
 *
 * 实现放在叶子模块里，`session.ts` 原样 re-export，保证：
 * - 对外 API 仍然是 `import { resolveIterationBudget } from './session.ts'`；
 * - `thread.ts` / `recipes.ts` 两条编排路径引用同一份实现，不复制规则；
 * - 渲染层（`ui.ts` → `recipes.ts`）不会因为引用 session.ts 而拉进主进程依赖。
 *
 * 纯函数，不读环境、不调工具。
 */

import type { IntentKind } from './router.ts';

/** 只读问答的默认预算：够一问一答，又不会为死循环白烧 token。 */
export const READ_ONLY_ITERATION_BUDGET = 6;

/** 含写工具或长计划时的预算：设计→自查→应用→生成 PLC→截图这类链要 10+ 步。 */
export const WRITE_ITERATION_BUDGET = 12;

/** 计划步骤达到该数量即视为长链任务（读配置→核算→落盘→生成→截图）。 */
export const LONG_PLAN_STEP_THRESHOLD = 4;

/** 与 `llm-config.ts` 的 1..50 上限保持一致。 */
export const MAX_ITERATION_BUDGET = 50;

export type IterationBudgetReason = 'read-only' | 'write' | 'long-plan' | 'commission';

export interface IterationBudgetInput {
  /** 基线预算；缺省 6（来自 options.maxIterations 时按配置走）。 */
  base?: number;
  /** 本轮已经出现写工具调用（含被拒绝的写：只要模型要写，就说明这不是一问一答）。 */
  hasWrite?: boolean;
  /** 外部规划器已知的计划步骤数；≥4 视为长链任务。 */
  planSteps?: number;
  /** 本轮路由意图；联调天然多步。 */
  intent?: IntentKind | null;
}

export interface IterationBudget {
  base: number;
  effective: number;
  reason: IterationBudgetReason;
}

/**
 * 自适应迭代预算（纯函数，便于单测）。
 *
 * 规则表：
 * | 场景                         | effective |
 * | 只读问答（无写、计划 <4 步）  | base（默认 6） |
 * | 出现写工具                   | max(base, 12) |
 * | 计划步骤 ≥4                  | max(base, 12) |
 * | 意图=联调（commission）       | max(base, 12) |
 *
 * 显式 `options.maxIterations` 仍是基线：传 3 的调用方在只读场景依然只跑 3 轮
 * （既有测试与「缩小范围」的语义都不变），只有在需要写/长链时才上抬到 12。
 */
export function resolveIterationBudget(input: IterationBudgetInput = {}): IterationBudget {
  const raw = Math.trunc(input.base ?? READ_ONLY_ITERATION_BUDGET);
  const base = Math.min(
    MAX_ITERATION_BUDGET,
    Math.max(1, Number.isFinite(raw) ? raw : READ_ONLY_ITERATION_BUDGET)
  );
  const planSteps = Math.max(0, Math.trunc(input.planSteps ?? 0));
  const escalate = (reason: IterationBudgetReason): IterationBudget => ({
    base,
    effective: Math.max(base, WRITE_ITERATION_BUDGET),
    reason
  });
  if (input.hasWrite === true) return escalate('write');
  if (planSteps >= LONG_PLAN_STEP_THRESHOLD) return escalate('long-plan');
  if (input.intent === 'commission') return escalate('commission');
  return { base, effective: base, reason: 'read-only' };
}
