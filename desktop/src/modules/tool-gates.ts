export type ModuleEnabledReader = (moduleId: string) => boolean;

/** Agent 外部工具到可选模块的归属；未列入的工具不受本模块开关影响。 */
export const AGENT_TOOL_MODULES: Readonly<Record<string, string>> = Object.freeze({
  run_cost_report: 'cost.estimation',
  export_cost_report: 'cost.estimation',
  run_electrical_check: 'elec.validation',
  verify_plc_program: 'plcgen',
  run_plc_generate: 'plcgen'
});

/** Agent 命令总线的归属映射，防止对话/计划绕过工具包装器直接执行。 */
export const AGENT_COMMAND_MODULES: Readonly<Record<string, string>> = Object.freeze({
  run_cost_report: 'cost.estimation',
  export_cost_report: 'cost.estimation',
  run_electrical_check: 'elec.validation',
  verify_plc_program: 'plcgen',
  run_plc_generate: 'plcgen'
});

/** 未提供状态源时保持旧调用约定；状态读取异常则按关闭处理。 */
export function moduleIsEnabled(moduleId: string, read?: ModuleEnabledReader): boolean {
  if (!read) return true;
  try {
    return read(moduleId) === true;
  } catch {
    return false;
  }
}

export class ModuleDisabledError extends Error {
  readonly code = 'MODULE_DISABLED' as const;

  constructor(moduleId: string) {
    super(`功能模块「${moduleId}」当前已关闭；启用该模块后才能调用此功能。`);
    this.name = 'ModuleDisabledError';
  }
}

export function requireModuleEnabled(moduleId: string, enabled: boolean): void {
  if (!enabled) throw new ModuleDisabledError(moduleId);
}

export function moduleDisabledResult(moduleId: string): { ok: false; code: 'MODULE_DISABLED'; message: string } {
  return { ok: false, code: 'MODULE_DISABLED', message: new ModuleDisabledError(moduleId).message };
}
