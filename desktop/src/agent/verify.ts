/**
 * 写后自动验证（机制层，P7-verify）
 *
 * 提示词里写「方案自查用 validate_machine_design」只能靠模型自觉；这里把同一件事
 * 做成机制：写工具成功后由会话层再调一次只读自查，把结论附进工具回执。
 *
 * 三条硬约束：
 * - 只附字段，不改原有字段：`verification?: { ok, issues, source:'auto', nextAction?, error? }`；
 * - 自动验证失败（抛错 / 命令失败）记 `ok:null + error`，**不把主操作判失败**；
 * - 工具自己已经返回了验证结论（`verification` 或 `{ok,issues}`）时不重复调。
 *
 * 本模块是纯函数，不读文件、不调工具；执行权在 session.ts。
 */

import type { CommandResult } from './commands.ts';

/** 写操作后需要机制层复查的写工具。 */
export const AUTO_VERIFY_TOOLS: ReadonlySet<string> = new Set([
  'apply_machine_design',
  'repair_plc_config',
  'run_plc_generate'
]);

export interface ToolVerification {
  /** true=通过；false=方案有问题；null=自动验证本身没跑通（不代表主操作失败）。 */
  ok: boolean | null;
  issues: unknown[];
  source: 'auto';
  /** ok=false 时的下一步动作，可直接照说（如「说『补齐安全回路』可自动修复」）。 */
  nextAction?: string;
  /** ok=null 时的原因（抛错/命令失败）。 */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueCode(issue: unknown): string {
  if (!isRecord(issue)) return '';
  return typeof issue.code === 'string' ? issue.code : '';
}

/**
 * 按 validate.ts 的问题码给下一步动作。
 *
 * 只承诺 repair_plc_config 真能补的两类（到位检测 / 安全回路）；其余结构性问题
 * 由模型看 issues 修正或重新 design_machine，不能糊成一句「可自动修复」。
 */
export function nextActionForDesignIssues(issues: readonly unknown[]): string {
  const codes = new Set(issues.map(issueCode));
  if (codes.has('SAFETY_REF_UNDEFINED')) return '说「补齐安全回路」可自动修复';
  if (codes.has('SENSOR_UNBOUND')) return '说「补齐到位检测」可自动修复';
  if (codes.size > 0) return '按 issues 修正方案，或说「重新生成机型方案」后再验证';
  return '说「重新验证机型方案」可复查';
}

/**
 * 从工具结果里读出「工具自己已经做过的验证」；没有则返回 null（调用方去补一次自查）。
 *
 * 认两种形状：
 * - `{verification:{ok,issues,…}}`：工具已经附过验证结论；
 * - `{ok, data:{ok, issues:[…]}}`：validate 同源的自查结果（如 validate_machine_design 本体）。
 */
export function inlineVerification(result: CommandResult): ToolVerification | null {
  if (!isRecord(result)) return null;
  const existing = (result as Record<string, unknown>).verification;
  if (isRecord(existing)) {
    const ok = existing.ok === true ? true : existing.ok === false ? false : null;
    const issues = Array.isArray(existing.issues) ? existing.issues : [];
    return {
      ok,
      issues,
      source: 'auto',
      ...(typeof existing.nextAction === 'string' ? { nextAction: existing.nextAction } : ok === false ? { nextAction: nextActionForDesignIssues(issues) } : {}),
      ...(typeof existing.error === 'string' ? { error: existing.error } : {})
    };
  }
  const data = result.data;
  if (!isRecord(data) || !Array.isArray(data.issues)) return null;
  const ok = data.ok === true;
  return {
    ok,
    issues: data.issues,
    source: 'auto',
    ...(ok ? {} : { nextAction: nextActionForDesignIssues(data.issues) })
  };
}

/** 把验证结论附到工具回执上；原字段一个不动。 */
export function withVerification(result: CommandResult, verification: ToolVerification): CommandResult {
  const base: Record<string, unknown> = isRecord(result) ? { ...result } : { ok: true, data: result };
  return { ...base, verification } as CommandResult;
}

/**
 * 验证通道（结构化的 `AgentCommandExecutor` 最小面）。
 *
 * 会话层传的是整个执行器 bus；计划 / 配方编排层没有 bus 时由调用方注入实现同一方法的对象。
 * 只要求一个只读方法，避免三条路径各写一套「再自查一次」。
 */
export interface VerificationChannel {
  validateMachineDesign?(signal?: AbortSignal): Promise<CommandResult>;
}

/**
 * 写后自动验证的统一入口：会话层、`runPlan`、`runRecipe` 都走这里。
 *
 * - 工具不在 `AUTO_VERIFY_TOOLS` 里 → `null`（不附字段）；
 * - 主操作没成功 → `null`（失败不补验证）；
 * - 工具自己已经给过结论 → 直接沿用（不重复调）；
 * - 通道缺失 → `ok:null + error`（说清是「没跑」而不是「通过」）；
 * - 通道抛错 / 返回失败 → `ok:null + error`，绝不把主操作判失败。
 *
 * `channel` 传 null/undefined 表示调用方没有接验证能力：返回 `null`，不伪造结论。
 */
export async function autoVerifyTool(
  channel: VerificationChannel | null | undefined,
  tool: string,
  result: unknown,
  signal?: AbortSignal
): Promise<ToolVerification | null> {
  if (!channel) return null;
  if (!AUTO_VERIFY_TOOLS.has(tool)) return null;
  if (!isRecord(result) || result.ok !== true) return null;
  const inline = inlineVerification(result as unknown as CommandResult);
  if (inline) return inline;
  const verify = channel.validateMachineDesign;
  if (typeof verify !== 'function') {
    return {
      ok: null,
      issues: [],
      source: 'auto',
      error: '执行器未提供 validate_machine_design 通道，未执行自动验证'
    };
  }
  try {
    const checked = await verify.call(channel, signal);
    if (!checked || checked.ok !== true) {
      return {
        ok: null,
        issues: [],
        source: 'auto',
        error: checked?.error?.message ?? 'validate_machine_design 未返回结果'
      };
    }
    const data = isRecord(checked.data) ? checked.data : {};
    const issues = Array.isArray(data.issues) ? data.issues : [];
    const ok = data.ok === true;
    return ok
      ? { ok, issues, source: 'auto' }
      : { ok, issues, source: 'auto', nextAction: nextActionForDesignIssues(issues) };
  } catch (error) {
    return {
      ok: null,
      issues: [],
      source: 'auto',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
