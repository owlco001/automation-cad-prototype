import type { CorePreviewModel } from './cad-preview-format.mjs';

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
type CoreCadPreviewResult = { cancelled: true } | {
  cancelled: false;
  name: string;
  extension: '.stl' | '.glb';
  byteLength: number;
  bytes: Uint8Array;
};
interface CoreProject {
  format: 'automationcad-core-project';
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
}
interface CoreProjectSummary { id: string; name: string; updatedAt: string }
interface CoreProjectSaveInput { id: string; name: string; notes: string }
interface CoreProjectCadPreviewAttachment { sha256: string; extension: '.stl' | '.glb'; name: string; byteLength: number; addedAt: string }
type CoreProjectCadPreviewAddResult = { cancelled: true } | { cancelled: false; attachment: CoreProjectCadPreviewAttachment };
interface CoreModuleCatalogEntry {
  id: string;
  name: string;
  version: string;
  coreApiVersion: 1;
  dependencies: string[];
  requiredCapabilities: string[];
  packageSize: number;
  packageSha256: string;
  authenticity: 'unsigned';
  activation: 'blocked-until-trust-policy';
}
interface CoreModuleCatalogResult { configured: boolean; state: 'unconfigured' | 'ready'; modules: CoreModuleCatalogEntry[] }
interface CoreStagedModuleSummary {
  id: string;
  version: string;
  dependencies: string[];
  requiredCapabilities: string[];
  packageSize: number;
  packageSha256: string;
  authenticity: 'unsigned';
  activation: 'blocked-until-trust-policy';
}
interface CoreModuleDownloadResult extends CoreStagedModuleSummary { name: string; staged: true }
interface CoreModuleRemovalResult { id: string; version: string; packageSize: number; removed: true }

declare global {
  interface Window {
    coreRuntime: {
      status(): Promise<CoreRuntimeStatus>;
      listProjects(): Promise<CoreProjectSummary[]>;
      createProject(name: string): Promise<CoreProject>;
      openProject(id: string): Promise<CoreProject>;
      saveProject(project: CoreProjectSaveInput): Promise<CoreProject>;
      listProjectCadPreviews(projectId: string): Promise<CoreProjectCadPreviewAttachment[]>;
      addProjectCadPreview(projectId: string): Promise<CoreProjectCadPreviewAddResult>;
      openProjectCadPreview(projectId: string, sha256: string): Promise<CoreProjectCadPreviewAttachment & { bytes: Uint8Array }>;
      listModules(): Promise<CoreModuleCatalogResult>;
      downloadModule(id: string, version: string): Promise<CoreModuleDownloadResult>;
      listStagedModules(): Promise<CoreStagedModuleSummary[]>;
      removeStagedModule(id: string, version: string): Promise<CoreModuleRemovalResult>;
      openCadPreview(): Promise<CoreCadPreviewResult>;
    };
    CoreCadViewer: {
      parseCadPreview(bytes: Uint8Array, extension: string): CorePreviewModel;
      createCadViewport(container: HTMLElement): {
        load(model: CorePreviewModel): { format: string; meshCount: number; triangleCount: number; bounds: [number, number, number] };
        summary(): { format: string; meshCount: number; triangleCount: number; bounds: [number, number, number] } | null;
        resetView(): void;
        dispose(): void;
      };
    };
  }
}

export {};

const value = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Core renderer 缺少页面节点：${id}`);
  return element;
};

let currentProject: CoreProject | null = null;
let projectSummaries: CoreProjectSummary[] = [];
let projectCadPreviews: CoreProjectCadPreviewAttachment[] = [];
let moduleCatalog: CoreModuleCatalogResult | null = null;
let stagedModules: CoreStagedModuleSummary[] = [];
let busy = false;
let moduleBusy = false;
let cadPreviewBusy = false;
let cadViewport: ReturnType<typeof window.CoreCadViewer.createCadViewport> | null = null;

function setWorkspaceStatus(message: string, kind: 'ready' | 'error' | 'neutral' = 'neutral'): void {
  const status = value('workspace-status');
  status.textContent = message;
  status.classList.toggle('is-ready', kind === 'ready');
  status.classList.toggle('is-error', kind === 'error');
}
function setModuleStatus(message: string, kind: 'ready' | 'error' | 'neutral' = 'neutral'): void {
  const status = value('module-status');
  status.textContent = message;
  status.classList.toggle('is-ready', kind === 'ready');
  status.classList.toggle('is-error', kind === 'error');
}
function setCadPreviewStatus(message: string, kind: 'ready' | 'error' | 'neutral' = 'neutral'): void {
  const status = value('cad-preview-status');
  status.textContent = message;
  status.dataset.kind = kind;
  status.classList.toggle('is-ready', kind === 'ready');
  status.classList.toggle('is-error', kind === 'error');
}
async function openCadPreview(): Promise<void> {
  if (cadPreviewBusy || !cadViewport) return;
  const panel = value('cad-preview-panel');
  const button = value('open-cad-preview') as HTMLButtonElement;
  cadPreviewBusy = true;
  button.disabled = true;
  panel.dataset.previewState = 'loading';
  setCadPreviewStatus('请选择本机 STL 或 GLB 文件…');
  try {
    const selection = await window.coreRuntime.openCadPreview();
    if (selection.cancelled) {
      panel.dataset.previewState = cadViewport.summary() ? 'ready' : 'idle';
      setCadPreviewStatus('已取消选择；当前模型未更改。');
      return;
    }
    if (selection.byteLength !== selection.bytes.byteLength || selection.byteLength > 33_554_432) {
      throw new Error('主进程返回的 CAD 文件长度或大小无效。');
    }
    const candidate = window.CoreCadViewer.parseCadPreview(selection.bytes, selection.extension);
    const summary = cadViewport.load(candidate);
    panel.dataset.previewState = 'ready';
    panel.dataset.fileName = selection.name;
    panel.dataset.format = summary.format;
    panel.dataset.meshCount = String(summary.meshCount);
    panel.dataset.triangleCount = String(summary.triangleCount);
    value('cad-preview-file').textContent = selection.name;
    value('cad-preview-summary').textContent = `${summary.meshCount.toLocaleString('zh-CN')} 个网格 · ${summary.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
      `${summary.bounds.map((dimension) => dimension.toFixed(3)).join(' × ')} · ${summary.format}`;
    setCadPreviewStatus(`已加载「${selection.name}」；模型仅在内存中显示，未写入或修改文件。`, 'ready');
  } catch (error) {
    panel.dataset.previewState = 'error';
    setCadPreviewStatus(`打开失败：${errorMessage(error)} 当前预览保持不变。`, 'error');
  } finally {
    cadPreviewBusy = false;
    button.disabled = false;
  }
}
function renderProjectCadPreviews(): void {
  const list = value('project-cad-attachment-list');
  const empty = value('empty-project-cad-attachments');
  const current = value('cad-project-current');
  const addButton = value('add-project-cad-attachment') as HTMLButtonElement;
  current.dataset.projectId = currentProject?.id ?? '';
  current.textContent = currentProject
    ? `当前项目：${currentProject.name} · ${currentProject.id}`
    : '当前未选择项目；请先新建项目或从本机项目列表明确打开一个项目。';
  addButton.disabled = busy || !currentProject;
  list.replaceChildren();
  empty.hidden = projectCadPreviews.length > 0;
  empty.textContent = currentProject ? '当前项目还没有 CAD 预览附件。' : '先明确打开或新建一个项目，再添加附件。';
  for (const attachment of projectCadPreviews) {
    const item = document.createElement('li');
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = attachment.name;
    const metadata = document.createElement('small');
    metadata.textContent = `${attachment.extension.toUpperCase()} · ${formatBytes(attachment.byteLength)} · SHA-256 ${attachment.sha256.slice(0, 12)}…`;
    details.append(name, metadata);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'button';
    preview.textContent = '预览';
    preview.dataset.attachmentSha256 = attachment.sha256;
    preview.setAttribute('aria-label', `预览项目附件 ${attachment.name}`);
    preview.disabled = busy;
    preview.addEventListener('click', () => { void openProjectCadPreview(attachment); });
    item.append(details, preview);
    list.append(item);
  }
}
async function refreshProjectCadPreviews(projectId: string): Promise<void> {
  projectCadPreviews = await window.coreRuntime.listProjectCadPreviews(projectId);
  renderProjectCadPreviews();
}
async function addProjectCadPreview(): Promise<void> {
  if (busy) return;
  if (!currentProject) {
    setCadPreviewStatus('请先新建项目或从本机项目列表明确打开一个项目，再添加附件。');
    return;
  }
  const project = currentProject;
  setBusy(true);
  setCadPreviewStatus('请从系统文件对话框选择 STL 或 GLB；原文件不会被修改。');
  try {
    const result = await window.coreRuntime.addProjectCadPreview(project.id);
    if (result.cancelled) {
      setCadPreviewStatus('已取消添加；项目附件未更改。');
      return;
    }
    await refreshProjectCadPreviews(project.id);
    setCadPreviewStatus(`已添加「${result.attachment.name}」为项目「${project.name}」的只读附件；原文件未修改。`, 'ready');
  } catch (error) {
    projectCadPreviews = await window.coreRuntime.listProjectCadPreviews(project.id).catch(() => projectCadPreviews);
    renderProjectCadPreviews();
    setCadPreviewStatus(`添加附件失败：${errorMessage(error)} 项目附件列表保持不变。`, 'error');
  } finally {
    setBusy(false);
  }
}
async function openProjectCadPreview(attachment: CoreProjectCadPreviewAttachment): Promise<void> {
  if (busy || !currentProject || !cadViewport) return;
  const project = currentProject;
  const panel = value('cad-preview-panel');
  setBusy(true);
  panel.dataset.previewState = 'loading';
  setCadPreviewStatus(`正在从项目「${project.name}」读取只读附件…`);
  try {
    const stored = await window.coreRuntime.openProjectCadPreview(project.id, attachment.sha256);
    if (stored.sha256 !== attachment.sha256 || stored.extension !== attachment.extension
      || stored.byteLength !== stored.bytes.byteLength || stored.byteLength > 33_554_432) {
      throw new Error('附件索引、内容摘要或文件长度不匹配。');
    }
    const candidate = window.CoreCadViewer.parseCadPreview(stored.bytes, stored.extension);
    const summary = cadViewport.load(candidate);
    panel.dataset.previewState = 'ready';
    panel.dataset.fileName = stored.name;
    panel.dataset.format = summary.format;
    panel.dataset.meshCount = String(summary.meshCount);
    panel.dataset.triangleCount = String(summary.triangleCount);
    value('cad-preview-file').textContent = stored.name;
    value('cad-preview-summary').textContent = `${summary.meshCount.toLocaleString('zh-CN')} 个网格 · ${summary.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
      `${summary.bounds.map((dimension) => dimension.toFixed(3)).join(' × ')} · ${summary.format} · 项目附件`;
    setCadPreviewStatus(`已从项目附件打开「${stored.name}」；只读显示，不修改或删除附件。`, 'ready');
  } catch (error) {
    panel.dataset.previewState = 'error';
    setCadPreviewStatus(`打开项目附件失败：${errorMessage(error)} 当前预览保持不变。`, 'error');
  } finally {
    setBusy(false);
  }
}
function setBusy(nextBusy: boolean): void {
  busy = nextBusy;
  (value('create-project-button') as HTMLButtonElement).disabled = nextBusy;
  (value('new-project-name') as HTMLInputElement).disabled = nextBusy;
  (value('save-project') as HTMLButtonElement).disabled = nextBusy || !currentProject;
  for (const button of value('project-list').querySelectorAll('button')) {
    (button as HTMLButtonElement).disabled = nextBusy;
  }
  renderProjectCadPreviews();
}
function renderProjectList(): void {
  const list = value('project-list');
  const empty = value('empty-projects');
  list.replaceChildren();
  empty.hidden = projectSummaries.length > 0;
  for (const project of projectSummaries) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(currentProject?.id === project.id));
    const name = document.createElement('strong');
    name.textContent = project.name;
    const updated = document.createElement('small');
    updated.textContent = new Date(project.updatedAt).toLocaleString();
    button.append(name, updated);
    button.addEventListener('click', () => { void openProject(project.id); });
    item.append(button);
    list.append(item);
  }
}
function setCurrentProject(project: CoreProject): void {
  currentProject = project;
  projectCadPreviews = [];
  (value('project-name') as HTMLInputElement).value = project.name;
  (value('project-notes') as HTMLTextAreaElement).value = project.notes;
  (value('project-name') as HTMLInputElement).disabled = false;
  (value('project-notes') as HTMLTextAreaElement).disabled = false;
  value('project-updated').textContent = `上次保存：${new Date(project.updatedAt).toLocaleString()}`;
  (value('save-project') as HTMLButtonElement).disabled = busy;
  renderProjectList();
  renderProjectCadPreviews();
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
async function refreshProjectList(): Promise<void> {
  projectSummaries = await window.coreRuntime.listProjects();
  renderProjectList();
}
async function openProject(id: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  setWorkspaceStatus('正在打开项目…');
  try {
    const project = await window.coreRuntime.openProject(id);
    setCurrentProject(project);
    await refreshProjectList();
    try {
      await refreshProjectCadPreviews(project.id);
    } catch (error) {
      projectCadPreviews = [];
      renderProjectCadPreviews();
      setCadPreviewStatus(`读取项目附件列表失败：${errorMessage(error)}`, 'error');
    }
    setWorkspaceStatus(`已打开「${project.name}」。`, 'ready');
  } catch (error) {
    setWorkspaceStatus(`打开失败：${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}
async function createProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (busy) return;
  const nameInput = value('new-project-name') as HTMLInputElement;
  setBusy(true);
  setWorkspaceStatus('正在创建本地项目…');
  try {
    const project = await window.coreRuntime.createProject(nameInput.value);
    nameInput.value = '';
    setCurrentProject(project);
    await refreshProjectList();
    await refreshProjectCadPreviews(project.id);
    setWorkspaceStatus(`已创建「${project.name}」，内容保存在本机。`, 'ready');
  } catch (error) {
    setWorkspaceStatus(`创建失败：${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}
async function saveProject(): Promise<void> {
  if (busy || !currentProject) return;
  const request: CoreProjectSaveInput = {
    id: currentProject.id,
    name: (value('project-name') as HTMLInputElement).value,
    notes: (value('project-notes') as HTMLTextAreaElement).value
  };
  setBusy(true);
  setWorkspaceStatus('正在原子保存…');
  try {
    const project = await window.coreRuntime.saveProject(request);
    setCurrentProject(project);
    await refreshProjectList();
    setWorkspaceStatus(`已保存「${project.name}」。`, 'ready');
  } catch (error) {
    setWorkspaceStatus(`保存失败：${errorMessage(error)} 当前编辑内容仍保留在页面中。`, 'error');
  } finally {
    setBusy(false);
  }
}
function updateDownloadButton(): void {
  const selected = [...value('module-list').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .some((checkbox) => checkbox.checked);
  (value('download-selected-modules') as HTMLButtonElement).disabled = moduleBusy || !selected;
  (value('refresh-modules') as HTMLButtonElement).disabled = moduleBusy;
}
function renderStagedModules(): void {
  const list = value('staged-module-list');
  const empty = value('empty-staged-modules');
  list.replaceChildren();
  empty.hidden = stagedModules.length > 0;
  for (const module of stagedModules) {
    const item = document.createElement('li');
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = `${module.id} · ${module.version}`;
    const detail = document.createElement('small');
    detail.textContent = `${formatBytes(module.packageSize)} · 未签名、不可信 · 激活被阻止`;
    const declarations = document.createElement('small');
    declarations.textContent = `依赖：${module.dependencies.join('、') || '无'} · 声明能力：${module.requiredCapabilities.join('、') || '无'}`;
    copy.append(heading, detail, declarations);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button';
    remove.textContent = '清理缓存包';
    remove.setAttribute('aria-label', `删除已下载缓存包 ${module.id} ${module.version}`);
    remove.disabled = moduleBusy;
    remove.addEventListener('click', () => { void removeStagedModule(module); });
    item.append(copy, remove);
    list.append(item);
  }
}
function renderModuleCatalog(): void {
  const list = value('module-list');
  const empty = value('empty-modules');
  list.replaceChildren();
  const entries = moduleCatalog?.modules ?? [];
  empty.hidden = entries.length > 0;
  if (moduleCatalog?.configured === false) {
    empty.textContent = '尚未配置经审核的固定模块目录来源；当前没有可下载模块。';
  } else {
    empty.textContent = entries.length ? '' : '目录中没有可选模块。';
  }
  for (const module of entries) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'module-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.moduleId = module.id;
    checkbox.dataset.moduleVersion = module.version;
    checkbox.disabled = moduleBusy;
    checkbox.addEventListener('change', updateDownloadButton);
    const copy = document.createElement('span');
    const heading = document.createElement('strong');
    heading.textContent = module.name;
    const detail = document.createElement('small');
    detail.textContent = `${module.id} · ${module.version} · ${formatBytes(module.packageSize)} · Core API ${module.coreApiVersion}`;
    const declarations = document.createElement('small');
    declarations.textContent = `依赖：${module.dependencies.join('、') || '无'} · 声明能力：${module.requiredCapabilities.join('、') || '无'}`;
    const trust = document.createElement('small');
    trust.className = 'module-trust';
    trust.textContent = '未签名 · 不可信 · 下载仅暂存，激活被阻止';
    copy.append(heading, detail, declarations, trust);
    label.append(checkbox, copy);
    item.append(label);
    list.append(item);
  }
  updateDownloadButton();
}
async function refreshModules(): Promise<void> {
  if (moduleBusy) return;
  moduleBusy = true;
  updateDownloadButton();
  setModuleStatus('正在读取固定来源的模块目录…');
  try {
    moduleCatalog = await window.coreRuntime.listModules();
    stagedModules = await window.coreRuntime.listStagedModules();
    renderModuleCatalog();
    renderStagedModules();
    if (!moduleCatalog.configured) setModuleStatus('模块目录未配置；未发起网络请求。', 'neutral');
    else setModuleStatus(`目录已加载：${moduleCatalog.modules.length} 个未签名模块仅可下载暂存。`, 'ready');
  } catch (error) {
    setModuleStatus(`读取模块目录失败：${errorMessage(error)}`, 'error');
  } finally {
    moduleBusy = false;
    renderModuleCatalog();
  }
}
async function downloadSelectedModules(): Promise<void> {
  if (moduleBusy) return;
  const selected = [...value('module-list').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => ({ id: checkbox.dataset.moduleId ?? '', version: checkbox.dataset.moduleVersion ?? '' }));
  if (selected.length === 0) {
    setModuleStatus('请先选择模块。');
    return;
  }
  moduleBusy = true;
  renderModuleCatalog();
  const succeeded: string[] = [];
  try {
    for (const module of selected) {
      const result = await window.coreRuntime.downloadModule(module.id, module.version);
      succeeded.push(`${result.id}@${result.version}`);
    }
    stagedModules = await window.coreRuntime.listStagedModules();
    renderStagedModules();
    setModuleStatus(`已将 ${succeeded.join('、')} 下载到本机暂存区；未解包、安装或激活。`, 'ready');
  } catch (error) {
    stagedModules = await window.coreRuntime.listStagedModules().catch(() => stagedModules);
    renderStagedModules();
    const done = succeeded.length ? `已暂存 ${succeeded.join('、')}；` : '';
    setModuleStatus(`${done}下载失败：${errorMessage(error)}`, 'error');
  } finally {
    moduleBusy = false;
    renderModuleCatalog();
  }
}
async function removeStagedModule(module: CoreStagedModuleSummary): Promise<void> {
  if (moduleBusy) return;
  const identity = `${module.id}@${module.version}`;
  if (!window.confirm(`仅删除本机暂存的缓存 ZIP「${identity}」。这不是模块卸载，不会修改项目数据或其他暂存包。未签名模块仍保持不可信且激活被阻止。继续？`)) return;
  moduleBusy = true;
  renderModuleCatalog();
  renderStagedModules();
  setModuleStatus(`正在清理 ${identity} 的下载缓存包…`);
  try {
    const result = await window.coreRuntime.removeStagedModule(module.id, module.version);
    stagedModules = await window.coreRuntime.listStagedModules();
    renderStagedModules();
    setModuleStatus(`已删除 ${result.id}@${result.version} 的暂存缓存 ZIP；这不是模块卸载，项目和其他缓存包均未更改。`, 'ready');
  } catch (error) {
    stagedModules = await window.coreRuntime.listStagedModules().catch(() => stagedModules);
    renderStagedModules();
    setModuleStatus(`缓存清理失败：${errorMessage(error)}`, 'error');
  } finally {
    moduleBusy = false;
    renderModuleCatalog();
    renderStagedModules();
  }
}
async function renderCoreStatus(): Promise<void> {
  try {
    const status = await window.coreRuntime.status();
    value('app-version').textContent = status.appVersion;
    value('runtime-profile').textContent = status.profile;
    value('optional-modules').textContent = status.optionalModules;
    value('offline-capability').textContent = status.offlineCapability;
    value('installability').textContent = status.installable ? '已验收' : '未声明可安装';
    value('workspace-capability').textContent = status.workspaceCapability;
    value('cad-preview-capability').textContent = `${status.cadPreview.formats.join(' / ')} · 只读 · 项目附件索引 v${status.projectAttachments.schemaVersion}`;
    document.body.dataset.coreRuntimeReady = 'true';
    const startup = value('startup-status');
    startup.textContent = '本地 Core 已启动';
    startup.classList.add('is-ready');
    await refreshProjectList();
    setWorkspaceStatus('就绪。项目仅保存在此设备。');
    await refreshModules();
  } catch (error) {
    const startup = value('startup-status');
    startup.textContent = `启动/存储读取失败：${errorMessage(error)}`;
    startup.classList.add('is-error');
    setWorkspaceStatus('未能读取本地项目存储。', 'error');
  }
}

value('create-project-form').addEventListener('submit', (event) => { void createProject(event as SubmitEvent); });
value('save-project').addEventListener('click', () => { void saveProject(); });
value('refresh-modules').addEventListener('click', () => { void refreshModules(); });
value('download-selected-modules').addEventListener('click', () => { void downloadSelectedModules(); });
value('open-cad-preview').addEventListener('click', () => { void openCadPreview(); });
value('add-project-cad-attachment').addEventListener('click', () => { void addProjectCadPreview(); });
value('reset-cad-preview-view').addEventListener('click', () => cadViewport?.resetView());
try {
  cadViewport = window.CoreCadViewer.createCadViewport(value('cad-preview-view'));
  setCadPreviewStatus('预览就绪。文件只在本机读取，并在内存中显示。');
} catch (error) {
  (value('open-cad-preview') as HTMLButtonElement).disabled = true;
  setCadPreviewStatus(`当前环境无法创建 3D 视口：${errorMessage(error)}`, 'error');
}
window.addEventListener('beforeunload', () => cadViewport?.dispose(), { once: true });
void renderCoreStatus();
