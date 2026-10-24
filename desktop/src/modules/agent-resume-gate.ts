export const AGENT_RESUME_MODULE_ID = 'agent.resume';

export const AGENT_RESUME_DISABLED_MESSAGE =
  '功能模块「agent.resume」当前已关闭；普通 Agent 计划仍可执行，但跨重启 checkpoint 不会创建、读取或恢复。已有恢复记录会保留，重新启用后可再次校验。';

/** Resume 专用路径必须显式提供已验证状态；缺失或异常均 fail-closed。 */
export function isAgentResumeEnabled(read: (() => unknown) | undefined): boolean {
  if (typeof read !== 'function') return false;
  try {
    return read() === true;
  } catch {
    return false;
  }
}
