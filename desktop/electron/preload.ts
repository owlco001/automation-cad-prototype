import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface OpenCadPayload {
  path: string;
  source: 'menu' | 'drop';
}

const desktopApi = {
  version: () => ipcRenderer.invoke('app:version'),
  modules: {
    syncPlcgenEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-plcgen-enabled', enabled) === true,
    syncElecValidationEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-elec-validation-enabled', enabled) === true,
    syncCostEstimationEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-cost-estimation-enabled', enabled) === true,
    syncFactoryPlcSyncEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-factory-plc-sync-enabled', enabled) === true,
    syncParametricImportEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-cad-parametric-import-enabled', enabled) === true,
    syncAgentResumeEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-agent-resume-enabled', enabled) === true,
    syncProjectPortableEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-project-portable-enabled', enabled) === true,
    syncSystemUpdateEnabled: (enabled: boolean) => ipcRenderer.sendSync('modules:sync-system-update-enabled', enabled) === true
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
  extensionBaseUrl: pathToFileURL(join(__dirname, '..', 'dist') + '/').href,
  openCadDialog: () => ipcRenderer.invoke('cad:open-dialog'),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('cad:read-file', filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  exportFile: (name: string, data: Uint8Array | string) => ipcRenderer.invoke('export:saveFile', name, data),
  projectArchive: {
    exportProject: (snapshot: unknown) => ipcRenderer.invoke('project-archive:export', snapshot),
    preview: () => ipcRenderer.invoke('project-archive:preview')
  },
  exportReport: (payload: { html: string; projectName?: string; page?: { size?: 'A3' | 'A4'; landscape?: boolean } }) => ipcRenderer.invoke('export:report', payload),
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
    ioMap: () => ipcRenderer.invoke('machine:io-map')
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
    }
  },
  parametric: {
    status: () => ipcRenderer.invoke('parametric:status'),
    start: () => ipcRenderer.invoke('parametric:start'),
    build: (doc: unknown) => ipcRenderer.invoke('parametric:build', doc),
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
