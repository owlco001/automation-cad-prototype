import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCadPreviewFile } from './cad-preview-files.mjs';
import { CoreProjectStore } from './project-store.mjs';
import { ModuleStagingService } from './module-staging.mjs';

// No production feed has been reviewed or configured; renderer input can never set this value.
const CORE_MODULE_CATALOG_SOURCE: string | null = null;

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

const APP_NAME = 'AutomationCAD Core';
const CORE_RUNTIME_SMOKE = process.argv.includes('--core-runtime-smoke');
const CORE_PREVIEW_SMOKE_FILES = process.argv
  .filter((argument) => argument.startsWith('--core-preview-smoke-file='))
  .map((argument) => argument.slice('--core-preview-smoke-file='.length));
let corePreviewSmokeIndex = 0;
const CORE_ATTACHMENT_SMOKE_FILES = process.argv
  .filter((argument) => argument.startsWith('--core-project-attachment-smoke-file='))
  .map((argument) => argument.slice('--core-project-attachment-smoke-file='.length));
let coreAttachmentSmokeIndex = 0;
app.setName(APP_NAME);

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (CORE_RUNTIME_SMOKE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-webgl');
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'automationcad-core-smoke-')));
}
if (CORE_PREVIEW_SMOKE_FILES.length > 0) {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'automationcad-core-preview-smoke-')));
}
if (CORE_ATTACHMENT_SMOKE_FILES.length > 0) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'automationcad-core-attachment-smoke-')));
}

function getCoreRuntimeStatus(): CoreRuntimeStatus {
  return {
    profile: 'core-only',
    appVersion: app.getVersion(),
    apiVersion: 1,
    optionalModules: 'not-bundled',
    installable: false,
    offlineCapability: 'project-store-local-only',
    workspaceCapability: 'local-project-store-v1',
    cadPreview: { formats: ['.stl', '.glb'], maxBytes: 33_554_432, mode: 'read-only' },
    projectAttachments: { schemaVersion: 1, formats: ['.stl', '.glb'], maxBytes: 33_554_432, storage: 'sha256-immutable', mode: 'read-only' }
  };
}

ipcMain.handle('core:status', () => getCoreRuntimeStatus());

let mainWindow: BrowserWindow | null = null;
let projectStore: CoreProjectStore | null = null;
let moduleStagingService: ModuleStagingService | null = null;
function getProjectStore(): CoreProjectStore {
  projectStore ??= new CoreProjectStore(join(app.getPath('userData'), 'projects'));
  return projectStore;
}
function getModuleStagingService(): ModuleStagingService {
  moduleStagingService ??= new ModuleStagingService({
    sourceUrl: CORE_MODULE_CATALOG_SOURCE,
    stagingDirectory: join(app.getPath('userData'), 'module-staging'),
    stagingEnabled: true
  });
  return moduleStagingService;
}
function assertTrustedCoreSender(event: { sender: BrowserWindow['webContents']; senderFrame: { url: string } | null }): void {
  const expectedPageUrl = pathToFileURL(join(__dirname, 'core.html')).href;
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame?.url !== expectedPageUrl) {
    throw new Error('Core 项目操作来源无效。');
  }
}
ipcMain.handle('core:projects:list', (event) => {
  assertTrustedCoreSender(event);
  return getProjectStore().list();
});
ipcMain.handle('core:projects:create', (event, name: unknown) => {
  assertTrustedCoreSender(event);
  return getProjectStore().create(name as string);
});
ipcMain.handle('core:projects:open', (event, id: unknown) => {
  assertTrustedCoreSender(event);
  return getProjectStore().open(id as string);
});
ipcMain.handle('core:projects:save', (event, input: unknown) => {
  assertTrustedCoreSender(event);
  return getProjectStore().save(input as { id: string; name: string; notes: string });
});
ipcMain.handle('core:projects:attachments:list', async (event, projectId: unknown) => {
  assertTrustedCoreSender(event);
  return getProjectStore().listCadPreviewAttachments(projectId as string);
});
ipcMain.handle('core:projects:attachments:add', async (event, projectId: unknown) => {
  assertTrustedCoreSender(event);
  const id = projectId as string;
  await getProjectStore().open(id);
  let filePath: string | undefined;
  if (CORE_ATTACHMENT_SMOKE_FILES.length > 0) {
    filePath = CORE_ATTACHMENT_SMOKE_FILES[coreAttachmentSmokeIndex++];
    if (!filePath) return { cancelled: true };
  } else {
    const owner = mainWindow;
    if (!owner || owner.isDestroyed()) throw new Error('Core 窗口已关闭。');
    const selection = await dialog.showOpenDialog(owner, {
      title: '添加只读 CAD 预览附件',
      properties: ['openFile'],
      filters: [{ name: 'CAD 网格模型', extensions: ['stl', 'glb'] }]
    });
    assertTrustedCoreSender(event);
    if (selection.canceled || selection.filePaths.length === 0) return { cancelled: true };
    filePath = selection.filePaths[0];
  }
  if (!filePath) return { cancelled: true };
  const file = await readCadPreviewFile(filePath);
  assertTrustedCoreSender(event);
  const attachment = await getProjectStore().addCadPreviewAttachment(id, file.name, file.extension, file.bytes);
  assertTrustedCoreSender(event);
  return { cancelled: false, attachment };
});
ipcMain.handle('core:projects:attachments:open', async (event, projectId: unknown, sha256: unknown) => {
  assertTrustedCoreSender(event);
  const attachment = await getProjectStore().openCadPreviewAttachment(projectId as string, sha256 as string);
  assertTrustedCoreSender(event);
  return attachment;
});
ipcMain.handle('core:cad-preview:open', async (event) => {
  assertTrustedCoreSender(event);
  let filePath: string | undefined;
  if (CORE_PREVIEW_SMOKE_FILES.length > 0) {
    filePath = CORE_PREVIEW_SMOKE_FILES[corePreviewSmokeIndex++];
    if (!filePath) return { cancelled: true };
  } else {
    const owner = mainWindow;
    if (!owner || owner.isDestroyed()) throw new Error('Core 窗口已关闭。');
    const selection = await dialog.showOpenDialog(owner, {
      title: '只读打开 CAD 网格模型',
      properties: ['openFile'],
      filters: [{ name: 'CAD 网格模型', extensions: ['stl', 'glb'] }]
    });
    assertTrustedCoreSender(event);
    if (selection.canceled || selection.filePaths.length === 0) return { cancelled: true };
    filePath = selection.filePaths[0];
  }
  if (!filePath) return { cancelled: true };
  const file = await readCadPreviewFile(filePath);
  assertTrustedCoreSender(event);
  return file;
});
ipcMain.handle('core:modules:catalog', (event) => {
  assertTrustedCoreSender(event);
  return getModuleStagingService().getCatalog();
});
ipcMain.handle('core:modules:download', (event, id: unknown, version: unknown) => {
  assertTrustedCoreSender(event);
  return getModuleStagingService().downloadModule(id, version);
});
ipcMain.handle('core:modules:remove-staged', (event, id: unknown, version: unknown) => {
  assertTrustedCoreSender(event);
  return getModuleStagingService().removeStagedModule(id, version);
});
ipcMain.handle('core:modules:staged', (event) => {
  assertTrustedCoreSender(event);
  return getModuleStagingService().listStagedModules();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void bootstrap().catch((error: unknown) => {
    console.error('CORE_RUNTIME_STARTUP_FAIL', error instanceof Error ? error.stack ?? error.message : String(error));
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      mainWindow.on('closed', () => { mainWindow = null; });
    }
  });
  await mainWindow.loadFile(join(__dirname, 'core.html'));
  if (CORE_RUNTIME_SMOKE) await verifyCoreRuntimeSmoke();
  if (CORE_PREVIEW_SMOKE_FILES.length > 0) await verifyCorePreviewSmoke();
  if (CORE_ATTACHMENT_SMOKE_FILES.length > 0) await verifyCoreProjectAttachmentSmoke();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#f4f6f8',
    show: !CORE_RUNTIME_SMOKE,
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, 'core-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  const localPageUrl = pathToFileURL(join(__dirname, 'core.html')).href;
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== localPageUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

async function verifyCoreRuntimeSmoke(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Core 主窗口未创建');
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const status = await window.coreRuntime.status();
    const moduleCatalog = await window.coreRuntime.listModules();
    const stagedModules = await window.coreRuntime.listStagedModules();
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Core workspace UI operation timed out');
    };
    await waitFor(() => document.querySelector('#module-status')?.textContent === '模块目录未配置；未发起网络请求。');
    const expectedName = 'Core smoke project';
    document.querySelector('#new-project-name').value = expectedName;
    document.querySelector('#create-project-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('#workspace-status')?.textContent?.startsWith('已创建'));
    const projectName = document.querySelector('#project-name');
    const projectNotes = document.querySelector('#project-notes');
    projectName.value = expectedName + ' saved';
    projectNotes.value = 'local smoke data';
    document.querySelector('#save-project').click();
    await waitFor(() => document.querySelector('#workspace-status')?.textContent?.startsWith('已保存'));
    const summaries = await window.coreRuntime.listProjects();
    const summary = summaries.find((item) => item.name === expectedName + ' saved');
    if (!summary) throw new Error('Core workspace UI did not persist the new project');
    projectName.value = 'unsaved value';
    projectNotes.value = 'unsaved value';
    const projectButton = [...document.querySelectorAll('#project-list button')]
      .find((button) => button.querySelector('strong')?.textContent === summary.name);
    if (!projectButton) throw new Error('Core workspace UI did not render the saved project');
    projectButton.click();
    await waitFor(() => document.querySelector('#workspace-status')?.textContent?.startsWith('已打开'));
    const reopened = await window.coreRuntime.openProject(summary.id);
    return {
      title: document.title,
      ready: document.body.dataset.coreRuntimeReady === 'true',
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      status,
      moduleCatalog,
      stagedModules,
      moduleStatus: document.querySelector('#module-status')?.textContent ?? '',
      moduleChoices: document.querySelectorAll('#module-list input[type="checkbox"]').length,
      urlInputs: document.querySelectorAll('input[type="url"]').length,
      moduleDownloadDisabled: document.querySelector('#download-selected-modules')?.disabled === true,
      projectRoundTrip: reopened.name === expectedName + ' saved' && reopened.notes === 'local smoke data'
        && projectName.value === reopened.name && projectNotes.value === reopened.notes,
      bridgeKeys: Object.keys(window.coreRuntime).sort(),
      legacyBridgePresent: typeof window.desktop !== 'undefined',
      nodeRequirePresent: typeof window.require !== 'undefined',
      nodeProcessPresent: typeof window.process !== 'undefined'
    };
  })()`);
  const expectedHeading = 'Core 本地工作区';
  if (
    result.title !== 'AutomationCAD Core' ||
    result.ready !== true ||
    result.heading !== expectedHeading ||
    result.status?.profile !== 'core-only' ||
    result.status?.apiVersion !== 1 ||
    result.status?.optionalModules !== 'not-bundled' ||
    result.status?.installable !== false ||
    result.status?.offlineCapability !== 'project-store-local-only' ||
    result.status?.workspaceCapability !== 'local-project-store-v1' ||
    result.status?.projectAttachments?.schemaVersion !== 1 ||
    result.status?.projectAttachments?.storage !== 'sha256-immutable' ||
    result.bridgeKeys.join(',') !== 'addProjectCadPreview,createProject,downloadModule,listModules,listProjectCadPreviews,listProjects,listStagedModules,openCadPreview,openProject,openProjectCadPreview,removeStagedModule,saveProject,status' ||
    result.moduleCatalog?.configured !== false || result.moduleCatalog?.state !== 'unconfigured' ||
    result.moduleCatalog?.modules?.length !== 0 || !Array.isArray(result.stagedModules) || result.stagedModules.length !== 0 ||
    result.moduleStatus !== '模块目录未配置；未发起网络请求。' || result.moduleChoices !== 0 || result.urlInputs !== 0 || !result.moduleDownloadDisabled ||
    result.projectRoundTrip !== true ||
    result.legacyBridgePresent || result.nodeRequirePresent || result.nodeProcessPresent
  ) {
    throw new Error(`Core 独立运行时 smoke 失败：${JSON.stringify(result)}`);
  }
  console.log('CORE_RUNTIME_SMOKE_OK profile=core-only bridge=project-store-v1,module-staging-v1 optional=absent catalog=unconfigured activation=blocked installable=false offline=project-store-local-only');
  setTimeout(() => app.exit(0), 50);
}

async function verifyCorePreviewSmoke(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Core CAD 预览 smoke 缺少主窗口。');
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('Core CAD preview UI operation timed out');
    };
    const panel = document.querySelector('#cad-preview-panel');
    const status = document.querySelector('#cad-preview-status');
    const open = document.querySelector('#open-cad-preview');
    if (!panel || !status || !open || document.body.dataset.coreRuntimeReady !== 'true') throw new Error('Core CAD preview UI did not become ready');
    open.click();
    await waitFor(() => panel.dataset.previewState === 'ready');
    const initial = {
      name: panel.dataset.fileName,
      format: panel.dataset.format,
      meshes: panel.dataset.meshCount,
      triangles: panel.dataset.triangleCount,
      canvas: panel.querySelectorAll('canvas').length,
      canvasWidth: panel.querySelector('canvas')?.width ?? 0,
      mode: status.dataset.kind
    };
    const failures = [];
    const failureCount = ${Math.max(CORE_PREVIEW_SMOKE_FILES.length - 1, 0)};
    for (let attempt = 0; attempt < failureCount; attempt += 1) {
      open.click();
      await waitFor(() => panel.dataset.previewState === 'loading');
      await waitFor(() => panel.dataset.previewState === 'error');
      failures.push({
        name: panel.dataset.fileName,
        format: panel.dataset.format,
        meshes: panel.dataset.meshCount,
        triangles: panel.dataset.triangleCount,
        canvas: panel.querySelectorAll('canvas').length,
        status: status.textContent
      });
    }
    const externalResources = performance.getEntriesByType('resource')
      .filter((entry) => !entry.name.startsWith('file:') && !entry.name.startsWith('data:'))
      .map((entry) => entry.name);
    return { initial, failures, externalResources };
  })()`) as {
    initial: { name?: string; format?: string; meshes?: string; triangles?: string; canvas?: number; canvasWidth?: number; mode?: string };
    failures: Array<{ name?: string; format?: string; meshes?: string; triangles?: string; canvas?: number; status?: string }>;
    externalResources: string[];
  };
  const initial = result.initial;
  const failuresPreserved = (result.failures ?? []).every((failure) =>
    failure.name === initial.name && failure.format === initial.format && failure.meshes === initial.meshes &&
    failure.triangles === initial.triangles && failure.canvas === initial.canvas && failure.status?.startsWith('打开失败：')
  );
  if (
    result.initial?.mode !== 'ready' ||
    !['STL', 'GLB'].includes(result.initial?.format ?? '') ||
    result.initial?.meshes !== '1' || result.initial?.triangles !== '1' ||
    result.initial?.canvas !== 1 || (result.initial?.canvasWidth ?? 0) < 1 ||
    !failuresPreserved || (result.failures?.length ?? 0) !== Math.max(CORE_PREVIEW_SMOKE_FILES.length - 1, 0) ||
    result.externalResources?.length !== 0 ||
    (CORE_PREVIEW_SMOKE_FILES.slice(1).some((filePath) => filePath.toLowerCase().endsWith('.stp')) &&
      !result.failures?.some((failure) => failure.status?.includes('仅支持 STL 与 GLB 格式')))
  ) {
    throw new Error(`Core packaged CAD preview smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(`CORE_CAD_PREVIEW_PACKAGE_SMOKE_OK format=${initial.format} triangles=${initial.triangles} canvas=${initial.canvas} failedReplacements=${result.failures.length} preserved=${failuresPreserved} externalRequests=${result.externalResources.length} installable=false`);
  setTimeout(() => app.exit(0), 50);
}

async function verifyCoreProjectAttachmentSmoke(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || CORE_ATTACHMENT_SMOKE_FILES.length < 2) {
    throw new Error('Core 项目附件 smoke 缺少主窗口或有效/畸形 fixture。');
  }
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Core project attachment UI operation timed out: ' + JSON.stringify({
        workspace: document.querySelector('#workspace-status')?.textContent,
        cad: document.querySelector('#cad-preview-status')?.textContent,
        projectId: document.querySelector('#cad-project-current')?.dataset.projectId,
        addDisabled: document.querySelector('#add-project-cad-attachment')?.disabled,
        attachmentCount: document.querySelector('#project-cad-attachment-list')?.children.length
      }));
    };
    if (document.body.dataset.coreRuntimeReady !== 'true') throw new Error('Core project attachment UI did not become ready');
    const initiallyDisabled = document.querySelector('#add-project-cad-attachment')?.disabled === true;
    document.querySelector('#new-project-name').value = 'Core attachment smoke project';
    document.querySelector('#create-project-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('#workspace-status')?.textContent?.startsWith('已创建'));
    const projectId = document.querySelector('#cad-project-current')?.dataset.projectId;
    const add = document.querySelector('#add-project-cad-attachment');
    const panel = document.querySelector('#cad-preview-panel');
    const previewStatus = document.querySelector('#cad-preview-status');
    if (!projectId || !add || !panel || !previewStatus || add.disabled) throw new Error('Core did not require and display a selected project');
    add.click();
    await waitFor(() => document.querySelector('#project-cad-attachment-list')?.children.length === 1
      || document.querySelector('#cad-preview-status')?.textContent?.startsWith('添加附件失败：'));
    if (!previewStatus.textContent?.startsWith('已添加')) throw new Error('Core attachment add failed in UI: ' + previewStatus.textContent);
    const attachmentButton = document.querySelector('#project-cad-attachment-list button');
    const attachment = await window.coreRuntime.listProjectCadPreviews(projectId);
    if (!attachmentButton || attachment.length !== 1) throw new Error('Core did not persist one project attachment');
    attachmentButton.click();
    await waitFor(() => panel.dataset.previewState === 'ready'
      && previewStatus.textContent?.startsWith('已从项目附件打开'));
    const reopened = {
      fileName: panel.dataset.fileName,
      format: panel.dataset.format,
      triangles: panel.dataset.triangleCount,
      canvas: panel.querySelectorAll('canvas').length,
      status: previewStatus.textContent
    };
    add.click();
    await waitFor(() => previewStatus.textContent?.startsWith('添加附件失败：'));
    const afterFailure = await window.coreRuntime.listProjectCadPreviews(projectId);
    const project = await window.coreRuntime.openProject(projectId);
    const externalResources = performance.getEntriesByType('resource')
      .filter((entry) => !entry.name.startsWith('file:') && !entry.name.startsWith('data:'))
      .map((entry) => entry.name);
    return {
      projectId,
      attachment: attachment[0],
      reopened,
      countAfterParseFailure: afterFailure.length,
      metadataPreserved: project.name === 'Core attachment smoke project' && project.notes === '',
      addDisabledWithoutProject: initiallyDisabled,
      externalResources
    };
  })()`);
  const attachment = result.attachment as { sha256?: string; extension?: string; byteLength?: number; name?: string };
  const reopened = result.reopened as { fileName?: string; format?: string; triangles?: string; canvas?: number; status?: string };
  if (
    typeof result.projectId !== 'string' || !/^[0-9a-f-]{36}$/u.test(result.projectId) ||
    !attachment || !/^[0-9a-f]{64}$/u.test(attachment.sha256 ?? '') || attachment.extension !== '.stl' ||
    (attachment.byteLength ?? 0) <= 0 || !attachment.name?.endsWith('.stl') ||
    reopened.fileName !== attachment.name || reopened.format !== 'STL' || reopened.triangles !== '1' ||
    reopened.canvas !== 1 || !reopened.status?.startsWith('已从项目附件打开') ||
    result.countAfterParseFailure !== 1 || result.metadataPreserved !== true ||
    result.addDisabledWithoutProject !== true || result.externalResources?.length !== 0
  ) {
    throw new Error(`Core packaged project attachment smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(`CORE_PROJECT_ATTACHMENT_PACKAGE_SMOKE_OK added=1 reopened=true parseRejected=true preserved=true externalRequests=${result.externalResources.length} installable=false`);
  setTimeout(() => app.exit(0), 50);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
