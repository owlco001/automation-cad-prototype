import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * 沙箱 preload 里**没有** Node 的 path/url/fs，也没有 `__dirname`、`Buffer`
 * （Electron 45 起渲染层 preload 只保留 events/timers/url 的 polyfill，且我们连这些都不用）。
 * 因此这里不能 `import 'node:path'`：扩展脚本与 wasm 的基础地址改由主进程用
 * `webPreferences.additionalArguments` 传下来（见 main.ts createWindow），取值与
 * `app.getAppPath()/dist/` 完全一致；传不进来时返回 null，渲染层已有
 * `new URL('./', window.location.href)` 兜底（desktop/src/extension.ts）。
 */
const EXTENSION_BASE_URL_ARG = '--cad-extension-base-url=';

function readExtensionBaseUrl(): string | null {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const hit = argv.find((arg) => arg.startsWith(EXTENSION_BASE_URL_ARG));
  const value = hit ? hit.slice(EXTENSION_BASE_URL_ARG.length) : '';
  return value.length > 0 ? value : null;
}

interface OpenCadPayload {
  path: string;
  source: 'menu' | 'drop';
}

const desktopApi = {
  version: () => ipcRenderer.invoke('app:version'),
  appearance: {
    get: () => ipcRenderer.invoke('appearance:get'),
    set: (config: unknown) => ipcRenderer.invoke('appearance:set', config)
  },
  modules: {
    syncPlcgenEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-plcgen-enabled', enabled) === true,
    syncElecValidationEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-elec-validation-enabled', enabled) === true,
    syncCostEstimationEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-cost-estimation-enabled', enabled) === true,
    syncFactoryPlcSyncEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-factory-plc-sync-enabled', enabled) === true,
    syncParametricImportEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-cad-parametric-import-enabled', enabled) === true,
    syncAgentResumeEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-agent-resume-enabled', enabled) === true,
    syncProjectPortableEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-project-portable-enabled', enabled) === true,
    syncSystemUpdateEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-system-update-enabled', enabled) === true,
    syncDrawingsTechdrawEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-drawings-techdraw-enabled', enabled) === true
  },
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    setChannel: (channel: 'stable' | 'beta') => ipcRenderer.invoke('update:set-channel', channel),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('update:state-changed', listener);
      return () => ipcRenderer.removeListener('update:state-changed', listener);
    }
  },
  extensionBaseUrl: readExtensionBaseUrl(),
  openCadDialog: () => ipcRenderer.invoke('cad:open-dialog'),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('cad:read-file', filePath),
  openDrawing: (filePath: string) => ipcRenderer.invoke('cad:open-drawing', filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  exportFile: (name: string, data: Uint8Array | string) => ipcRenderer.invoke('export:saveFile', name, data),
  projectArchive: {
    exportProject: (snapshot: unknown) => ipcRenderer.invoke('project-archive:export', snapshot),
    preview: () => ipcRenderer.invoke('project-archive:preview')
  },
  design: {
    settings: () => ipcRenderer.invoke('design:settings'),
    loadDraft: () => ipcRenderer.invoke('design:draft-load'),
    saveDraft: (draft: unknown) => ipcRenderer.invoke('design:draft-save', draft),
    clearDraft: () => ipcRenderer.invoke('design:draft-clear')
  },
  canvasDraft: {
    load: () => ipcRenderer.invoke('canvas:draft-load'),
    save: (draft: unknown) => ipcRenderer.invoke('canvas:draft-save', draft),
    clear: () => ipcRenderer.invoke('canvas:draft-clear')
  },
  canvasPricing: {
    load: () => ipcRenderer.invoke('canvas:pricing-load'),
    save: (book: unknown) => ipcRenderer.invoke('canvas:pricing-save', book),
    clear: () => ipcRenderer.invoke('canvas:pricing-clear')
  },
  canvasSchemes: {
    load: () => ipcRenderer.invoke('canvas:scheme-load'),
    save: (library: unknown) => ipcRenderer.invoke('canvas:scheme-save', library)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    save: (payload: unknown) => ipcRenderer.invoke('projects:save', payload),
    open: (id: string) => ipcRenderer.invoke('projects:open', id),
    saveLayout: (payload: unknown) => ipcRenderer.invoke('projects:layout-save', payload),
    remove: (id: string) => ipcRenderer.invoke('projects:delete', id)
  },
  exportReport: (payload: { html: string; projectName?: string; page?: { size?: 'A3' | 'A4'; landscape?: boolean } }) => ipcRenderer.invoke('export:report', payload),
  brepInterference: (payload: { stepPath: string; timeoutMs?: number; maxParts?: number }) =>
    ipcRenderer.invoke('interference:brep', payload),
  exportPartsCsv: (payload: { fileName?: string; suggestedName?: string; data: string; rows?: number }) =>
    ipcRenderer.invoke('export:partsCsv', payload),
  exportCostFile: (payload: {
    format: 'pdf' | 'csv';
    fileName?: string;
    overwrite?: boolean;
    data: Uint8Array | string;
    suggestedName?: string;
  }) => ipcRenderer.invoke('export:costFile', payload),
  cost: {
    pricebook: () => ipcRenderer.invoke('cost:pricebook'),
    exportPanelPdf: (payload: { html: string; projectName?: string; page?: { size?: 'A3' | 'A4'; landscape?: boolean } }) =>
      ipcRenderer.invoke('cost:exportPanelPdf', payload),
    exportPanelCsv: (payload: { name: string; data: string }) => ipcRenderer.invoke('cost:exportPanelCsv', payload)
  },
  machine: {
    active: () => ipcRenderer.invoke('machine:active'),
    ioMap: () => ipcRenderer.invoke('machine:io-map'),
    linkage: (brief: string) => ipcRenderer.invoke('machine:linkage', brief),
    plcAudit: (brief: string) => ipcRenderer.invoke('machine:plc-audit', brief)
  },
  qt: {
    // 随包 Qt 原生工作台：主进程 spawn resources/qt/automationcad-qt.exe，失败返回 { ok:false, message }
    launch: () => ipcRenderer.invoke('qt:launch'),
    // 进程后续退出由主进程 qt:exited 广播；返回取消订阅函数，组件销毁时调用避免重复提示。
    onExited: (callback: (payload: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on('qt:exited', listener);
      return () => ipcRenderer.removeListener('qt:exited', listener);
    }
  },
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    chooseZip: () => ipcRenderer.invoke('packs:choose-zip'),
    importZip: (zipPath: string) => ipcRenderer.invoke('packs:import-zip', zipPath),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('packs:set-enabled', id, enabled),
    remove: (id: string) => ipcRenderer.invoke('packs:remove', id),
    listParts: (filter?: { q?: string; category?: string; packId?: string }) => ipcRenderer.invoke('packs:list-parts', filter ?? {})
  },
  agent: {
    info: () => ipcRenderer.invoke('agent:info'),
    getLlmConfig: () => ipcRenderer.invoke('agent:llm:get'),
    saveLlmConfig: (config: unknown) => ipcRenderer.invoke('agent:llm:save', config),
    testLlm: (config?: unknown) => ipcRenderer.invoke('agent:llm:test', config),
    onConfirmWrite: (handler: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('agent:confirm-write:request', listener);
      return () => ipcRenderer.removeListener('agent:confirm-write:request', listener);
    },
    replyConfirmWrite: (payload: unknown) => ipcRenderer.send('agent:confirm-write:reply', payload),
    chat: {
      send: (text: string) => ipcRenderer.invoke('agent:chat:send', text),
      cancel: () => ipcRenderer.invoke('agent:chat:cancel'),
      history: () => ipcRenderer.invoke('agent:chat:history'),
      clear: () => ipcRenderer.invoke('agent:chat:clear')
    },
    plan: {
      execute: (payload: unknown) => ipcRenderer.invoke('agent:plan:execute', payload),
      restore: (payload: unknown) => ipcRenderer.invoke('agent:plan:checkpoint:restore', payload),
      clearCheckpoint: () => ipcRenderer.invoke('agent:plan:checkpoint:clear'),
      cancel: () => ipcRenderer.invoke('agent:plan:cancel')
    },
    recipe: {
      execute: (payload: unknown) => ipcRenderer.invoke('agent:recipe:execute', payload),
      cancel: () => ipcRenderer.invoke('agent:recipe:cancel')
    },
    onProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
      ipcRenderer.on('agent:progress', listener);
      return () => ipcRenderer.removeListener('agent:progress', listener);
    },
    audit: {
      read: () => ipcRenderer.invoke('agent:audit:read')
    },
    lan: {
      get: () => ipcRenderer.invoke('agent:lan:get'),
      save: (config: unknown) => ipcRenderer.invoke('agent:lan:save', config),
      rotateToken: () => ipcRenderer.invoke('lan:rotate-token')
    }
  },
  render: {
    stats: (stats: unknown) => ipcRenderer.invoke('render:stats', stats)
  },
  drawings: {
    freecadStatus: () => ipcRenderer.invoke('freecad:status'),
    detectFreecad: () => ipcRenderer.invoke('freecad:detect'),
    chooseFreecadPath: () => ipcRenderer.invoke('freecad:choose-path'),
    setFreecadPath: (path: string | null) => ipcRenderer.invoke('freecad:set-path', path),
    generate: (request: unknown) => ipcRenderer.invoke('drawings:generate', request),
    cancel: (jobId: string) => ipcRenderer.invoke('drawings:cancel', jobId),
    jobs: () => ipcRenderer.invoke('drawings:jobs'),
    list: (projectKey: string) => ipcRenderer.invoke('drawings:list', { projectKey }),
    open: (projectKey: string, partKey: string, format: string) => ipcRenderer.invoke('drawings:open', { projectKey, partKey, format }),
    reveal: (projectKey: string, partKey?: string) => ipcRenderer.invoke('drawings:reveal', { projectKey, partKey }),
    onJob: (callback: (snapshot: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot);
      ipcRenderer.on('drawings:job-changed', listener);
      return () => ipcRenderer.removeListener('drawings:job-changed', listener);
    }
  },
  parametric: {
    status: () => ipcRenderer.invoke('parametric:status'),
    start: () => ipcRenderer.invoke('parametric:start'),
    build: (doc: unknown, options?: { perPart?: boolean }) => ipcRenderer.invoke('parametric:build', doc, options),
    stop: () => ipcRenderer.invoke('parametric:stop'),
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('parametric:status-changed', listener);
      return () => ipcRenderer.removeListener('parametric:status-changed', listener);
    }
  },
  factory: {
    info: () => ipcRenderer.invoke('factory:info'),
    status: () => ipcRenderer.invoke('factory:status'),
    list: () => ipcRenderer.invoke('factory:list'),
    getConfig: () => ipcRenderer.invoke('factory:config'),
    connect: (config: unknown) => ipcRenderer.invoke('factory:connect', config),
    disconnect: () => ipcRenderer.invoke('factory:disconnect'),
    browse: (nodeId?: string) => ipcRenderer.invoke('factory:browse', nodeId),
    readTags: (ids: string[]) => ipcRenderer.invoke('factory:read-tags', ids),
    writeTag: (id: string, value: unknown) => ipcRenderer.invoke('factory:write-tag', id, value),
    subscribe: (ids: string[]) => ipcRenderer.invoke('factory:subscribe', ids),
    onValues: (callback: (value: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
      ipcRenderer.on('factory:values', listener);
      return () => ipcRenderer.removeListener('factory:values', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('factory:status', listener);
      return () => ipcRenderer.removeListener('factory:status', listener);
    }
  },
  plc: {
    info: () => ipcRenderer.invoke('plc:info'),
    status: () => ipcRenderer.invoke('plc:status'),
    list: () => ipcRenderer.invoke('plc:list'),
    getConfig: () => ipcRenderer.invoke('plc:config'),
    connect: (config: unknown) => ipcRenderer.invoke('plc:connect', config),
    disconnect: () => ipcRenderer.invoke('plc:disconnect'),
    read: (id: string) => ipcRenderer.invoke('plc:read', id),
    readAll: () => ipcRenderer.invoke('plc:read-all'),
    write: (id: string, value: unknown) => ipcRenderer.invoke('plc:write', id, value),
    force: (id: string, value: unknown) => ipcRenderer.invoke('plc:force', id, value),
    onValues: (callback: (values: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, values: unknown) => callback(values);
      ipcRenderer.on('plc:values', listener);
      return () => ipcRenderer.removeListener('plc:values', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('plc:status', listener);
      return () => ipcRenderer.removeListener('plc:status', listener);
    }
  },
  plcgen: {
    history: () => ipcRenderer.invoke('plcgen:history'),
    recordHistory: (entry: unknown) => ipcRenderer.invoke('plcgen:recordHistory', entry),
    exportProject: (payload: {
      machineName: string;
      namePrefix?: string;
      target?: string;
      files: Array<{ path: string; content: string }>;
    }) => ipcRenderer.invoke('plcgen:export', payload),
    openExportDir: (directory?: string) => ipcRenderer.invoke('plcgen:openExportDir', directory)
  },
  sync: {
    getConfig: () => ipcRenderer.invoke('sync:getConfig'),
    saveConfig: (config: unknown) => ipcRenderer.invoke('sync:saveConfig', config),
    test: () => ipcRenderer.invoke('sync:test'),
    upload: (payload: unknown) => ipcRenderer.invoke('sync:upload', payload),
    list: () => ipcRenderer.invoke('sync:list'),
    diff: (packageId: string) => ipcRenderer.invoke('sync:diff', packageId),
    downloadCandidate: (packageId: string, machineContext?: unknown) =>
      ipcRenderer.invoke('sync:downloadCandidate', packageId, machineContext)
  },
  onNewDesign: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:new-design', listener);
    return () => ipcRenderer.removeListener('desktop:new-design', listener);
  },
  onOpenCad: (callback: (payload: OpenCadPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: OpenCadPayload) => callback(payload);
    ipcRenderer.on('desktop:open-cad', listener);
    return () => ipcRenderer.removeListener('desktop:open-cad', listener);
  },
  onImportPack: (callback: (payload: { path: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { path: string }) => callback(payload);
    ipcRenderer.on('desktop:import-pack', listener);
    return () => ipcRenderer.removeListener('desktop:import-pack', listener);
  },
  onSetDomain: (callback: (domain: 'mech' | 'elec') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, domain: 'mech' | 'elec') => callback(domain);
    ipcRenderer.on('desktop:set-domain', listener);
    return () => ipcRenderer.removeListener('desktop:set-domain', listener);
  }
};

contextBridge.exposeInMainWorld('desktop', desktopApi);

/**
 * 机型库（`library:*`）单独一个全局，不与 `desktop` 混在一起：
 * 渲染层这里只拿到五个**动作**，没有任何 fs/path 面——导入的文件路径由主进程
 * showOpenDialog 选、字节在主进程读；导出同理走 showSaveDialog。
 * `importPackage` 只收 `{ overwrite }`，即使渲染层硬塞路径也不会被主进程采用。
 */
const machineLibraryApi = {
  list: () => ipcRenderer.invoke('library:list'),
  apply: (id: string) => ipcRenderer.invoke('library:apply', id),
  importPackage: (options?: { overwrite?: boolean }) => ipcRenderer.invoke('library:import', options ?? {}),
  exportPackage: (id: string) => ipcRenderer.invoke('library:export', id),
  remove: (id: string) => ipcRenderer.invoke('library:remove', id),
  // 远程来源/下载：只传 id，URL 与字节都在主进程里定（渲染层永远拿不到下载通道）
  sources: () => ipcRenderer.invoke('library:sources'),
  download: (sourceId: string, machineId: string) => ipcRenderer.invoke('library:download', { sourceId, machineId })
};

contextBridge.exposeInMainWorld('__machineLibrary', machineLibraryApi);

// 一次性安全自述：主进程收到后打印 SECURITY_RENDERER_PRELOAD 日志。
// 这样"沙箱是否真生效"不是靠配置推断，而是渲染进程里 preload 实测的 process.sandboxed。
ipcRenderer.send('security:renderer-state', {
  sandboxed: process.sandboxed === true,
  contextIsolated: process.contextIsolated === true,
  nodeRequire: typeof (globalThis as { require?: unknown }).require === 'function',
  // OS 级是否真关了沙箱：root/排障时 Chromium 会给渲染进程塞 --no-sandbox，沙箱 preload 也挡不住，
  // 必须和 process.sandboxed（preload 变体）分开看，日志里不能只报一个 true。
  osNoSandbox: Array.isArray(process.argv) && process.argv.includes('--no-sandbox'),
  osSandboxSwitch: Array.isArray(process.argv) && process.argv.includes('--enable-sandbox')
});
