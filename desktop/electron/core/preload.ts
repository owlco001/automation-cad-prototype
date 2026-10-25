import { contextBridge, ipcRenderer } from 'electron';
import type { CoreProject, CoreProjectCadPreviewAttachment, CoreProjectCadPreviewAttachmentFile, CoreProjectSaveInput, CoreProjectSummary } from './project-store.mjs';
import type { CoreModuleCatalogResult, CoreModuleDownloadResult, CoreModuleRemovalResult, CoreStagedModuleSummary } from './module-staging.mjs';

type CoreCadPreviewResult = {
  cancelled: true;
} | {
  cancelled: false;
  name: string;
  extension: '.stl' | '.glb';
  byteLength: number;
  bytes: Uint8Array;
}
type CoreProjectCadPreviewAddResult = { cancelled: true } | { cancelled: false; attachment: CoreProjectCadPreviewAttachment };

interface CoreRuntimeStatus {
  profile: 'core-only';
  appVersion: string;
  apiVersion: 1;
  optionalModules: 'not-bundled';
  installable: false;
  offlineCapability: 'project-store-local-only';
  workspaceCapability: 'local-project-store-v1';
  cadPreview: { formats: ['.stl', '.glb']; maxBytes: 33_554_432; mode: 'read-only' };
  projectAttachments: { schemaVersion: 1; formats: ['.stl', '.glb']; maxBytes: 33_554_432; storage: 'sha256-immutable'; mode: 'read-only' };
}

const coreRuntime = Object.freeze({
  status: (): Promise<CoreRuntimeStatus> => ipcRenderer.invoke('core:status'),
  listProjects: (): Promise<CoreProjectSummary[]> => ipcRenderer.invoke('core:projects:list'),
  createProject: (name: string): Promise<CoreProject> => ipcRenderer.invoke('core:projects:create', name),
  openProject: (id: string): Promise<CoreProject> => ipcRenderer.invoke('core:projects:open', id),
  saveProject: (project: CoreProjectSaveInput): Promise<CoreProject> => ipcRenderer.invoke('core:projects:save', project),
  listProjectCadPreviews: (projectId: string): Promise<CoreProjectCadPreviewAttachment[]> => ipcRenderer.invoke('core:projects:attachments:list', projectId),
  addProjectCadPreview: (projectId: string): Promise<CoreProjectCadPreviewAddResult> => ipcRenderer.invoke('core:projects:attachments:add', projectId),
  openProjectCadPreview: (projectId: string, sha256: string): Promise<CoreProjectCadPreviewAttachmentFile> => ipcRenderer.invoke('core:projects:attachments:open', projectId, sha256),
  listModules: (): Promise<CoreModuleCatalogResult> => ipcRenderer.invoke('core:modules:catalog'),
  downloadModule: (id: string, version: string): Promise<CoreModuleDownloadResult> => ipcRenderer.invoke('core:modules:download', id, version),
  listStagedModules: (): Promise<CoreStagedModuleSummary[]> => ipcRenderer.invoke('core:modules:staged'),
  removeStagedModule: (id: string, version: string): Promise<CoreModuleRemovalResult> => ipcRenderer.invoke('core:modules:remove-staged', id, version),
  openCadPreview: (): Promise<CoreCadPreviewResult> => ipcRenderer.invoke('core:cad-preview:open')
});

contextBridge.exposeInMainWorld('coreRuntime', coreRuntime);
