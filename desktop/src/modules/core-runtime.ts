interface CoreStatus {
  id: 'core';
  name: string;
  version: string;
  apiCompatibility: { min: number; max: number };
  dependencies: string[];
  requiredCapabilities: string[];
  description: string;
  kind: 'core';
  defaultEnabled: true;
  implemented: true;
  status: 'enabled';
  enabled: true;
  reason: null;
}
interface UnavailableStatus {
  id: string;
  name: string;
  version: 'not-installed';
  apiCompatibility: { min: 1; max: 1 };
  dependencies: string[];
  requiredCapabilities: string[];
  description: string;
  kind: 'optional';
  defaultEnabled: false;
  implemented: false;
  status: 'unavailable';
  enabled: false;
  reason: string;
}
interface CoreRegistryApi {
  list(): CoreStatus[];
  getStatus(id: string): CoreStatus | UnavailableStatus;
  setEnabled(id: string, enabled: boolean): CoreStatus[];
}

(() => {
  const core: CoreStatus = Object.freeze({
    id: 'core',
    name: 'Core 注册表占位',
    version: '1.0.0',
    apiCompatibility: { min: 1, max: 1 },
    dependencies: [],
    requiredCapabilities: [],
    description: '仅用于验证 Core registry 与可选模块拒绝路径；不提供可用工作区功能。',
    kind: 'core',
    defaultEnabled: true,
    implemented: true,
    status: 'enabled',
    enabled: true,
    reason: null
  });
  const unavailable = (id: string): UnavailableStatus => ({
    id,
    name: id,
    version: 'not-installed',
    apiCompatibility: { min: 1, max: 1 },
    dependencies: [],
    requiredCapabilities: [],
    description: '',
    kind: 'optional',
    defaultEnabled: false,
    implemented: false,
    status: 'unavailable',
    enabled: false,
    reason: '此 Core-only 构建未包含该可选模块；模块信任策略就绪前不会执行模块代码。'
  });
  const api: CoreRegistryApi = Object.freeze({
    list: () => [core],
    getStatus: (id: string) => id === 'core' ? core : unavailable(id),
    setEnabled: (id: string, enabled: boolean) => {
      if (id !== 'core') throw new Error(`Core-only 构建未安装模块：${id}`);
      if (enabled !== true) throw new Error('核心模块不能关闭');
      return [core];
    }
  });
  Object.defineProperty(window, '__ModuleRegistry', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false
  });
  Object.defineProperty(window, '__CoreOnlyRuntime', {
    value: Object.freeze({
      profile: 'core-only',
      apiVersion: 1,
      installable: false,
      offlineCapability: 'unverified',
      installedModules: ['core']
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
