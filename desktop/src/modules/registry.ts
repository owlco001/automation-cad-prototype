export const MODULE_API_VERSION = 1;
export const MODULE_SETTINGS_KEY = 'automationcad.modules.v1';
export const MODULE_SETTINGS_SCHEMA_VERSION = 1;

export interface ModuleDefinition {
  id: string;
  name: string;
  version: string;
  apiCompatibility: { min: number; max: number };
  dependencies: readonly string[];
  requiredCapabilities: readonly string[];
  description: string;
  kind: 'core' | 'optional';
  defaultEnabled: boolean;
  implemented: boolean;
}

export interface ModuleStatus extends ModuleDefinition {
  status: 'enabled' | 'disabled' | 'unavailable';
  enabled: boolean;
  reason: string | null;
}

export interface ModuleSettingsRecord {
  schemaVersion: number;
  overrides: Record<string, boolean>;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ModuleManagerOptions {
  registry?: readonly ModuleDefinition[];
  apiVersion?: number;
  capabilities?: readonly string[];
}

export interface ModuleManager {
  list(): ModuleStatus[];
  getStatus(id: string): ModuleStatus;
  setEnabled(id: string, enabled: boolean): ModuleStatus[];
  subscribe(listener: (states: ModuleStatus[]) => void): () => void;
  persistenceAvailable(): boolean;
}

export const MODULE_REGISTRY: readonly ModuleDefinition[] = Object.freeze([
  Object.freeze({
    id: 'core',
    name: '核心工作区',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze([]),
    requiredCapabilities: Object.freeze(['workspace.project-storage', 'workspace.extension-host']),
    description: '提供基础工作区、项目数据持久化与内置扩展宿主；始终启用。',
    kind: 'core' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'agent.resume',
    name: 'Agent 计划跨重启恢复',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze(['agent.plan.checkpoint', 'agent.plan.cross-restart-resume']),
    description: '可选保存受限计划 checkpoint 并在重启后校验后恢复；默认启用以保持现有行为。关闭时保留旧记录但不读写或恢复，不影响普通计划执行与写操作确认。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'plcgen',
    name: 'PLC 程序校验与生成面板',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'plcgen.precheck',
      'plcgen.generate',
      'plcgen.simulate',
      'plcgen.export'
    ]),
    description: '机型 PLC 预检、ST 程序生成、模拟验证、文件预览与导出；面板、Agent/JSON-RPC/MCP 工具及底层历史写入/文件导出共用此开关。智慧工厂同步包中的 PLC 扩展由 factory.plc-sync 独立控制。关闭会隐藏工具并拒绝旧名称调用，但不会删除项目中的 PLC 数据、历史或已有导出文件。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'elec.validation',
    name: '电气规则校验与审计',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'elec.validation.rules',
      'elec.validation.panel',
      'agent.electrical-check',
      'elec.validation.report.export'
    ]),
    description: '线号、功率、导线截面与断路器规则校验、结果面板/PDF 及 Agent/MCP 查询；默认启用以保持旧行为。关闭仅停用校验与报告入口，保留原理图、元件库、底板布置、项目数据及既有 Agent 审计历史；重开后恢复。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'commission.io-test',
    name: '联调 IO 测试',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze(['commission.io-test.execute']),
    description: '6 步上电流程、3 条标准 IO 用例及失败诊断；关闭后保留 PLC 连接、断开、点位读写、实时监视与既有强制写入权限。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'cad.parametric-import',
    name: 'CAD 参数化导入与重建',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'cad.parametric.feature-tree',
      'cad.parametric.sidecar-build',
      'cad.parametric.export'
    ]),
    description: '可选的参数化特征树编辑、sidecar 重建与 STEP/STL 导出；默认启用以保持现有体验。关闭只停用参数化编辑与重建，不禁用 STEP/IGES/BREP/STL/OBJ/GLTF/GLB 的只读查看，也不删除已保存特征树、原始 CAD 文件或叠加体。未识别的 STEP 特征不会自动变成可编辑特征。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'parametric.history',
    name: '参数化特征树撤销与重做',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core', 'cad.parametric-import']),
    requiredCapabilities: Object.freeze(['cad.parametric.undo-redo']),
    description: '独立控制参数化特征树的会话内撤销/重做入口。关闭只隐藏并禁用撤销/重做控件及其程序化调用；不清空或回退特征树、不丢弃会话历史，继续编辑时仍记录历史，重新启用后可接续使用。依赖 cad.parametric-import。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'factory.plc-sync',
    name: '智慧工厂 PLC 同步扩展',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['plcgen']),
    requiredCapabilities: Object.freeze(['sync.design-package', 'machine.io-map']),
    description: '控制智慧工厂设计包中的 PLC 源码与机型 IO mapping 生成、打包、上传及候选应用；默认启用以兼容现有同步行为。关闭后 BOM/PDF/GLB/DXF 普通设计包仍可同步，既有 PLC 数据/历史与 PLC 实时连接不变。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'project.portable',
    name: '可移植工程档案',
    version: '2.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 2 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'project.identity.stable',
      'project.archive.snapshot.export',
      'project.archive.preview',
      'project.archive.candidate-only'
    ]),
    description: '默认启用。使用持久 project ID 与 CAD 原件 SHA-256 绑定 schema v2 档案，可封装当前可安全取得的特征树、稳定对象 ID 运动学标注、CAD 相机快照及原始 CAD；所选 CAD 必须与活动来源字节一致。导入严格校验后只显示候选，不应用或覆盖当前工程；CAD 重导入几何复核、相机/特征树事务应用、PLC/工厂/Agent/围栏模块状态仍不支持。关闭会隐藏入口并由主进程拒绝文件读取/写入，既有档案与项目状态保留。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'cost.estimation',
    name: '成本估算与报告',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'cost.estimation.calculate',
      'cost.estimation.panel',
      'cost.estimation.agent',
      'cost.estimation.report.export',
      'cost.estimation.pricebook.read'
    ]),
    description: '控制成本计算面板、成本 Agent/命令/RPC/MCP 与 PDF/CSV 成本报告导出。默认启用以保持现有行为；关闭后隐藏入口并由 renderer 与主进程 IPC 统一拒绝，不计算、不写成本报告，也不改 BOM、价格簿、已有成本数据或项目数据；重新启用后恢复。普通 BOM 读取、通用文件/报告导出、机电设计与其他 Agent 工具不受影响。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  }),
  Object.freeze({
    id: 'system.update',
    name: '更新通道',
    version: '1.0.0',
    apiCompatibility: Object.freeze({ min: 1, max: 1 }),
    dependencies: Object.freeze(['core']),
    requiredCapabilities: Object.freeze([
      'system.update.check',
      'system.update.download',
      'system.update.install',
      'system.update.channel',
      'system.update.state-events'
    ]),
    description: '控制 Windows NSIS stable/beta 更新面板与检查、下载、显式确认安装、渠道选择及状态事件 IPC。默认启用；关闭会隐藏面板、关闭对话框并由主进程拒绝相关 IPC。Core 始终执行更新源/Authenticode 发布者预检；SHA-512 校验与 HTTPS GitHub feed 由受信任的 electron-updater provider 保持。',
    kind: 'optional' as const,
    defaultEnabled: true,
    implemented: true
  })
]);

const RUNTIME_CAPABILITIES = Object.freeze([
  'workspace.project-storage',
  'workspace.extension-host',
  'agent.plan.checkpoint',
  'agent.plan.cross-restart-resume',
  'plcgen.precheck',
  'plcgen.generate',
  'plcgen.simulate',
  'plcgen.export',
  'elec.validation.rules',
  'elec.validation.panel',
  'agent.electrical-check',
  'elec.validation.report.export',
  'commission.io-test.execute',
  'cad.parametric.feature-tree',
  'cad.parametric.sidecar-build',
  'cad.parametric.export',
  'cad.parametric.undo-redo',
  'sync.design-package',
  'machine.io-map',
  'project.identity.stable',
  'project.archive.snapshot.export',
  'project.archive.preview',
  'project.archive.candidate-only',
  'cost.estimation.calculate',
  'cost.estimation.panel',
  'cost.estimation.agent',
  'cost.estimation.report.export',
  'cost.estimation.pricebook.read',
  'system.update.check',
  'system.update.download',
  'system.update.install',
  'system.update.channel',
  'system.update.state-events'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModuleSettings(value: unknown): ModuleSettingsRecord {
  if (!isRecord(value) || value.schemaVersion !== MODULE_SETTINGS_SCHEMA_VERSION || !isRecord(value.overrides)) {
    return { schemaVersion: MODULE_SETTINGS_SCHEMA_VERSION, overrides: {} };
  }
  const knownIds = new Set(MODULE_REGISTRY.map((module) => module.id));
  const overrides: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(value.overrides)) {
    if (knownIds.has(id) && typeof enabled === 'boolean') overrides[id] = enabled;
  }
  return { schemaVersion: MODULE_SETTINGS_SCHEMA_VERSION, overrides };
}

export function resolveModuleStates(input: {
  registry?: readonly ModuleDefinition[];
  overrides?: Readonly<Record<string, boolean>>;
  apiVersion?: number;
  capabilities?: readonly string[];
} = {}): ModuleStatus[] {
  const registry = input.registry ?? MODULE_REGISTRY;
  const overrides = input.overrides ?? {};
  const apiVersion = input.apiVersion ?? MODULE_API_VERSION;
  const capabilities = new Set(input.capabilities ?? RUNTIME_CAPABILITIES);
  const byId = new Map(registry.map((module) => [module.id, module]));
  const cache = new Map<string, ModuleStatus>();
  const visiting = new Set<string>();

  const unavailable = (definition: ModuleDefinition, reason: string): ModuleStatus => ({
    ...definition,
    status: 'unavailable',
    enabled: false,
    reason
  });

  const resolve = (id: string): ModuleStatus | null => {
    const cached = cache.get(id);
    if (cached) return cached;
    const definition = byId.get(id);
    if (!definition) return null;
    if (visiting.has(id)) return unavailable(definition, `检测到循环依赖：${id}`);
    visiting.add(id);

    let result: ModuleStatus;
    if (!definition.implemented) {
      result = unavailable(definition, '功能尚未接入');
    } else if (
      !Number.isInteger(definition.apiCompatibility.min) ||
      !Number.isInteger(definition.apiCompatibility.max) ||
      definition.apiCompatibility.min > definition.apiCompatibility.max ||
      apiVersion < definition.apiCompatibility.min ||
      apiVersion > definition.apiCompatibility.max
    ) {
      result = unavailable(definition, `模块 API 不兼容：需要 ${definition.apiCompatibility.min}–${definition.apiCompatibility.max}，当前 ${apiVersion}`);
    } else {
      const missing = definition.requiredCapabilities.filter((capability) => !capabilities.has(capability));
      if (missing.length > 0) {
        result = unavailable(definition, `缺少所需能力：${missing.join('、')}`);
      } else if (definition.kind === 'core' && definition.id === 'core') {
        result = { ...definition, status: 'enabled', enabled: true, reason: null };
      } else {
        const missingDependency = definition.dependencies.find((dependency) => {
          const dependencyState = resolve(dependency);
          return !dependencyState?.enabled;
        });
        if (missingDependency) {
          const dependency = byId.get(missingDependency);
          const dependencyState = resolve(missingDependency);
          result = unavailable(
            definition,
            dependencyState?.reason
              ? `依赖模块「${dependency?.name ?? missingDependency}」不可用：${dependencyState.reason}`
              : `依赖模块「${dependency?.name ?? missingDependency}」未启用`
          );
        } else if (overrides[id] ?? definition.defaultEnabled) {
          result = { ...definition, status: 'enabled', enabled: true, reason: null };
        } else {
          result = { ...definition, status: 'disabled', enabled: false, reason: '用户已关闭此模块' };
        }
      }
    }

    visiting.delete(id);
    cache.set(id, result);
    return result;
  };

  return registry.map((module) => resolve(module.id) ?? unavailable(module, '模块状态无法解析'));
}

export function createModuleManager(
  storage: KeyValueStorage,
  options: ModuleManagerOptions = {}
): ModuleManager {
  const registry = options.registry ?? MODULE_REGISTRY;
  const apiVersion = options.apiVersion ?? MODULE_API_VERSION;
  const capabilities = options.capabilities ?? RUNTIME_CAPABILITIES;
  const knownIds = new Set(registry.map((module) => module.id));
  const listeners = new Set<(states: ModuleStatus[]) => void>();
  let overrides: Record<string, boolean> = {};
  let persistenceWorks = true;

  try {
    const raw = storage.getItem(MODULE_SETTINGS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.schemaVersion === MODULE_SETTINGS_SCHEMA_VERSION && isRecord(parsed.overrides)) {
        for (const [id, enabled] of Object.entries(parsed.overrides)) {
          if (knownIds.has(id) && typeof enabled === 'boolean') overrides[id] = enabled;
        }
      }
    }
  } catch {
    persistenceWorks = false;
    overrides = {};
  }

  const list = (): ModuleStatus[] => resolveModuleStates({ registry, overrides, apiVersion, capabilities });
  const getStatus = (id: string): ModuleStatus => {
    const definition = registry.find((module) => module.id === id);
    if (!definition) {
      return {
        id,
        name: id,
        version: 'unknown',
        apiCompatibility: { min: apiVersion, max: apiVersion },
        dependencies: [],
        requiredCapabilities: [],
        description: '',
        kind: 'optional',
        defaultEnabled: false,
        implemented: false,
        status: 'unavailable',
        enabled: false,
        reason: `未知模块 ID：${id}`
      };
    }
    return list().find((module) => module.id === id)!;
  };

  return {
    list,
    getStatus,
    setEnabled(id: string, enabled: boolean): ModuleStatus[] {
      if (typeof enabled !== 'boolean') throw new Error('模块启用状态必须是布尔值');
      const definition = registry.find((module) => module.id === id);
      if (!definition) throw new Error(`未知模块 ID：${id}`);
      if (definition.kind === 'core' && !enabled) throw new Error('核心模块不能关闭');
      const next = { ...overrides };
      if (enabled === definition.defaultEnabled) delete next[id];
      else next[id] = enabled;
      const candidate = resolveModuleStates({ registry, overrides: next, apiVersion, capabilities });
      const target = candidate.find((module) => module.id === id);
      if (enabled && !target?.enabled) throw new Error(target?.reason ?? '模块不可用，已拒绝启用');
      if (!storage || typeof storage.setItem !== 'function') throw new Error('模块设置存储不可用，无法保存变更');
      try {
        storage.setItem(MODULE_SETTINGS_KEY, JSON.stringify({
          schemaVersion: MODULE_SETTINGS_SCHEMA_VERSION,
          overrides: next
        } satisfies ModuleSettingsRecord));
      } catch (error) {
        persistenceWorks = false;
        throw new Error(`模块设置保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
      overrides = next;
      persistenceWorks = true;
      const states = list();
      for (const listener of listeners) listener(states);
      return states;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    persistenceAvailable(): boolean {
      return persistenceWorks;
    }
  };
}
