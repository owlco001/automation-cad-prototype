import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions, type WebContents } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { PackRegistry } from '../src/packs/registry';
import { FactoryManager } from '../src/factory/manager.ts';
import type { TagValue } from '../src/factory/types.ts';
import { PlcManager } from '../src/plc/manager.ts';
import { SyncClient } from '../src/sync/client.ts';
import { mergeSyncConfig, publicSyncConfig, readSyncConfig, writeSyncConfig } from '../src/sync/config.ts';
import { buildDesignPackage, parseDesignPackage } from '../src/sync/package.ts';
import { exportCandidateReviewFolder } from '../src/sync/candidate-review-export.ts';
import { validateMachineConfig } from '../src/commission/machine-config.ts';
import type { DesignBomRow, SyncConfig, SyncImportCandidate, SyncPlcUploadPayload, SyncUploadPayload } from '../src/sync/types.ts';
import {
  EXPORT_EXTENSIONS,
  assertAllowedTargetPath,
  ensureExportExtension,
  validateExportFileName
} from '../src/export/file';
import { CAD_EXTENSIONS, isCadExtension } from '../src/shared/cad';
import { assertCadFileSize } from '../src/shared/input-limits.ts';
import { recordDiagnosticError, setDiagnosticOperation } from '../src/shared/diagnostics.ts';
import { isUsablePricebookItem, validatePricebook } from '../src/cost/pricebook.ts';
import { CostExportError, planExportName } from '../src/cost/export.ts';
import { costEstimationDisabledResult } from '../src/modules/cost-estimation-gate.ts';
import type { AgentTools } from '../src/agent/tools.ts';
import type { CommandBus } from '../src/agent/commands.ts';
import {
  AGENT_RESUME_DISABLED_MESSAGE,
  isAgentResumeEnabled
} from '../src/modules/agent-resume-gate.ts';
import {
  isParametricImportEnabled,
  parametricModuleDisabledBuildResult,
  parametricModuleDisabledStatus
} from '../src/modules/parametric-gate.ts';
import { mergeLlmConfig, readLlmConfig, publicLlmConfig, saveLlmConfig } from '../src/agent/llm-config.ts';
import { OpenAiCompatibleClient, testLlmConnection } from '../src/agent/llm.ts';
import { AgentCancelledError, AgentSession, emptyAgentUsage } from '../src/agent/session.ts';
import { BYPASS_CONFIRMATION_NOTICE } from '../src/agent/policy.ts';
import { collectAgentContext } from '../src/agent/context.ts';
import type { AgentPlan, PlanStep } from '../src/agent/planner.ts';
import { READ_ONLY_TOOLS } from '../src/agent/router.ts';
import { AgentThread, planSignature, projectFingerprint, runPlan, type ThreadState } from '../src/agent/thread.ts';
import {
  clearPlanCheckpoint,
  createPlanCheckpoint,
  inspectPlanCheckpoint,
  isPlanCheckpointFullyCompleted,
  isProjectFingerprint,
  loadPlanCheckpoint,
  planCheckpointSignature,
  savePlanCheckpoint,
  updatePlanCheckpoint,
  updatePlanCheckpointFingerprint,
  type PlanCheckpoint,
  type PlanCheckpointStepState
} from '../src/agent/plan-checkpoint.ts';
import { runRecipe, type RecipeContext, type RecipeProgressEvent } from '../src/agent/recipes.ts';
import { createAuditLog, summarizeAudit } from '../src/agent/audit.ts';
import { createAuditFileWriter, loadAuditRetention, readAuditEntries } from '../src/agent/audit-store.ts';
import { DEFAULT_PRICING } from '../src/agent/pricing.ts';
import { AUDIT_DISPLAY_LIMIT, limitAuditEntries } from '../src/agent/audit-view.ts';
import type { AgentProgressEvent } from '../src/agent/feedback.ts';
import type { FeatureDoc } from '../src/parametric/features.ts';
import type { ParametricManager, ParametricStartInfo } from './parametric.ts';
import { createZip, normalizeZipPath, type ZipEntry } from '../src/shared/zip.ts';
import {
  exportSelectedCadAsPortableArchive,
  previewSelectedPortableArchive,
  writePortableArchiveExclusively
} from '../src/project-archive/desktop.ts';
import { isTrustedProjectArchiveRequest } from './project-archive-ipc-auth.ts';
import { planPlcExportDirectory } from '../src/plcgen/export.ts';
import { readActiveMachineDesign } from '../src/machine/store.ts';
import { buildMachineIoMap } from '../src/machine/io-map.ts';
import {
  mergePlcHistory,
  normalizeHistoryEntry,
  parsePlcHistory,
  type PlcHistoryEntry
} from '../src/plcgen/history.ts';

export interface IpcContext {
  builtinDir: string;
  userDir: string;
  stateFile: string;
  factoryConfigFile: string;
  plcConfigFile: string;
  syncConfigFile: string;
  version: string;
  mainWindowRendererUrl: string;
  getAgentInfo(): unknown;
  isMainWindowSender(sender: WebContents): boolean;
  getParametric(): ParametricManager | null;
  isParametricImportEnabled(): boolean;
  setParametricImportEnabled(enabled: boolean): void;
  isPlcgenEnabled(): boolean;
  setPlcgenEnabled(enabled: boolean): void;
  isFactoryPlcSyncEnabled(): boolean;
  setFactoryPlcSyncEnabled(enabled: boolean): void;
  isAgentResumeEnabled(): boolean;
  setAgentResumeEnabled(enabled: boolean): void;
  isProjectPortableEnabled(): boolean;
  setProjectPortableEnabled(enabled: boolean): void;
  isCostEstimationEnabled(): boolean;
  setCostEstimationEnabled(enabled: boolean): void;
  setElecValidationEnabled(enabled: boolean): void;
  setSystemUpdateEnabled(enabled: boolean): void;
}

export interface AgentChatIpcContext {
  userDataDir: string;
  getTools(): AgentTools | null;
  getBus(): CommandBus | null;
  getWindow(): BrowserWindow | null;
  isAgentResumeEnabled(): boolean;
}

export { CAD_EXTENSIONS } from '../src/shared/cad';

function exportPayload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('导出数据必须是字符串或字节数组');
}

interface ReportPageOptions {
  size: 'A3' | 'A4';
  landscape: boolean;
}

async function printHtmlToPdf(
  html: string,
  page: ReportPageOptions,
  directory: string
): Promise<{ pdf: Uint8Array; htmlPath: string }> {
  if (typeof html !== 'string' || !html.trim()) throw new Error('报告 HTML 不能为空');
  if (html.length > 20 * 1024 * 1024) throw new Error('报告 HTML 超过 20MB，已拒绝导出');
  if (!html.includes('<html') || !html.includes('</html>')) throw new Error('报告 HTML 结构不完整');

  mkdirSync(directory, { recursive: true });
  const htmlPath = join(directory, 'report.html');
  writeFileSync(htmlPath, html, 'utf8');

  const reportWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try {
    reportWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    await reportWindow.loadFile(htmlPath);
    const pdf = await reportWindow.webContents.printToPDF({
      landscape: page.landscape,
      pageSize: page.size,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    if (pdf.byteLength === 0) throw new Error('PDF 打印结果为空');
    return { pdf, htmlPath };
  } catch (error) {
    throw new Error(`PDF 报告导出失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
}

async function exportReport(payload: unknown): Promise<{ path: string; htmlPath: string }> {
  const source = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  const html = source?.html;
  if (typeof html !== 'string' || !html.trim()) throw new Error('报告 HTML 不能为空');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(app.getPath('userData'), 'exports', timestamp);
  const page = typeof source?.page === 'object' && source.page !== null ? source.page as Record<string, unknown> : {};
  const { pdf, htmlPath } = await printHtmlToPdf(html, {
    size: page.size === 'A4' ? 'A4' : 'A3',
    landscape: page.landscape === undefined ? true : page.landscape === true
  }, directory);
  const pdfPath = join(directory, 'report.pdf');
  writeFileSync(pdfPath, pdf);
  return { path: pdfPath, htmlPath };
}

async function exportCostPanelPdf(
  payload: unknown,
  isEnabled: () => boolean
): Promise<{ ok: true; path: string; htmlPath: string } | { ok: false; code: string; message: string }> {
  if (!isEnabled()) return costEstimationDisabledResult();
  const source = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  if (typeof source?.html !== 'string' || !source.html.trim()) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '报告 HTML 不能为空' };
  }

  const staging = mkdtempSync(join(tmpdir(), 'automationcad-cost-panel-'));
  try {
    const page = typeof source.page === 'object' && source.page !== null ? source.page as Record<string, unknown> : {};
    const { pdf } = await printHtmlToPdf(source.html, {
      size: page.size === 'A4' ? 'A4' : 'A3',
      landscape: page.landscape === undefined ? true : page.landscape === true
    }, staging);
    if (!isEnabled()) return costEstimationDisabledResult();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportsRoot = join(app.getPath('userData'), 'exports');
    mkdirSync(exportsRoot, { recursive: true });
    const directory = mkdtempSync(join(exportsRoot, `${timestamp}-cost-panel-`));
    if (!isEnabled()) {
      rmSync(directory, { recursive: true, force: true });
      return costEstimationDisabledResult();
    }
    const htmlPath = join(directory, 'report.html');
    const pdfPath = join(directory, 'report.pdf');
    writeFileSync(htmlPath, source.html, 'utf8');
    if (!isEnabled()) {
      rmSync(directory, { recursive: true, force: true });
      return costEstimationDisabledResult();
    }
    writeFileSync(pdfPath, pdf);
    return { ok: true, path: pdfPath, htmlPath };
  } catch (error) {
    return { ok: false, code: 'WRITE_FAILED', message: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Agent 导出 PDF：复用 A4 打印管线，返回字节；临时目录用完即删。 */
export async function renderCostReportPdf(html: string): Promise<Uint8Array> {
  const root = join(app.getPath('userData'), 'exports');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, '.render-'));
  try {
    const { pdf } = await printHtmlToPdf(html, { size: 'A4', landscape: false }, directory);
    return pdf;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Agent 导出装配报告 PDF：复用 A3 横向打印管线，返回字节；临时目录用完即删。 */
export async function renderAssemblyReportPdf(html: string): Promise<Uint8Array> {
  const root = join(app.getPath('userData'), 'exports');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, '.render-'));
  try {
    const { pdf } = await printHtmlToPdf(html, { size: 'A3', landscape: true }, directory);
    return pdf;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCheckpointPlan(value: unknown, tools: AgentTools): AgentPlan {
  if (!isRecord(value) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 200) {
    throw new Error('恢复计划步骤结构无效');
  }
  const steps = value.steps.map((entry, index): PlanStep => {
    if (!isRecord(entry) || typeof entry.tool !== 'string' || !entry.tool.trim()) {
      throw new Error(`恢复计划第 ${index + 1} 步无效`);
    }
    const tool = entry.tool.trim();
    if (!tools.has(tool)) throw new Error(`恢复计划第 ${index + 1} 步工具未注册：${tool}`);
    if (entry.args !== undefined && !isRecord(entry.args)) throw new Error(`恢复计划第 ${index + 1} 步参数无效`);
    const missing = Array.isArray(entry.missing)
      ? entry.missing.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      tool,
      args: isRecord(entry.args) ? { ...entry.args } : {},
      why: typeof entry.why === 'string' ? entry.why : '',
      // 副作用分类始终来自主进程工具表，不采信 renderer 的 readOnly 布尔值。
      readOnly: READ_ONLY_TOOLS.has(tool),
      ...(missing.length > 0 ? { missing } : {})
    };
  });
  return {
    steps,
    confidence: typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? value.confidence : 0
  };
}

function costExportFailure(error: unknown): { ok: false; code: string; message: string } {
  const code = error instanceof CostExportError ? error.code : 'WRITE_FAILED';
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code,
    message: code === 'UNSUPPORTED_FORMAT' ? detail : `成本报告写入失败：${detail}`
  };
}

function syncBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label}必须是字节数组`);
}

function syncText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  return value;
}

function syncBom(value: unknown): DesignBomRow[] {
  if (!Array.isArray(value)) throw new Error('BOM 必须是数组');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`第 ${index + 1} 条 BOM 不是对象`);
    const row = entry as Record<string, unknown>;
    const no = typeof row.no === 'number' ? row.no : index + 1;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const spec = typeof row.spec === 'string' ? row.spec.trim() : '';
    const mat = typeof row.mat === 'string' ? row.mat.trim() : '';
    const qty = typeof row.qty === 'number' && Number.isFinite(row.qty) ? row.qty : 1;
    if (!name) throw new Error(`第 ${index + 1} 条 BOM 缺少名称`);
    const result: DesignBomRow = { no, name, spec, qty, mat };
    if (typeof row.remark === 'string' && row.remark.trim()) result.remark = row.remark.trim();
    return result;
  });
}

function parseSyncPlcPayload(value: unknown): SyncPlcUploadPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('PLC 同步数据必须是对象');
  const source = value as Record<string, unknown>;
  if (typeof source.target !== 'string') throw new Error('PLC target 必须是字符串');
  if (typeof source.generatedVersion !== 'string') throw new Error('PLC generatedVersion 必须是字符串');
  if (typeof source.machineId !== 'string') throw new Error('PLC machineId 必须是字符串');
  if (!Array.isArray(source.programFiles)) throw new Error('PLC programFiles 必须是数组');
  const programFiles = source.programFiles.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`PLC programFiles[${index}] 必须是对象`);
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error(`PLC programFiles[${index}] 缺少 path/content`);
    return { path: file.path, content: file.content };
  });
  if (typeof source.mappingCsv !== 'string') throw new Error('PLC mappingCsv 必须是字符串');
  return {
    target: source.target as SyncPlcUploadPayload['target'],
    generatedVersion: source.generatedVersion,
    machineId: source.machineId,
    programFiles,
    mappingCsv: source.mappingCsv
  };
}

function parseSyncPayload(value: unknown): SyncUploadPayload {
  if (typeof value !== 'object' || value === null) throw new Error('同步数据必须是对象');
  const source = value as Record<string, unknown>;
  return {
    projectName: syncText(source.projectName, 'projectName'),
    bomCsv: typeof source.bomCsv === 'string' ? source.bomCsv : syncBytes(source.bomCsv, 'bom.csv'),
    reportHtml: syncText(source.reportHtml, '报告 HTML'),
    glb: syncBytes(source.glb, 'model.glb'),
    dxf: typeof source.dxf === 'string' ? source.dxf : syncBytes(source.dxf, 'drawing.dxf'),
    bom: syncBom(source.bom),
    ...(source.plc === undefined ? {} : { plc: parseSyncPlcPayload(source.plc) })
  };
}

export function createPackRegistry(context: Pick<IpcContext, 'builtinDir' | 'userDir' | 'stateFile'>): PackRegistry {
  return new PackRegistry({
    builtinDir: context.builtinDir,
    userDir: context.userDir,
    stateFile: context.stateFile
  });
}

function plcExportRoot(): string {
  return join(app.getPath('userData'), 'exports', 'plc');
}

function plcHistoryFile(): string {
  return join(app.getPath('userData'), 'plc-gen-history.json');
}

function readPlcGenHistory(): PlcHistoryEntry[] {
  try {
    return parsePlcHistory(JSON.parse(readFileSync(plcHistoryFile(), 'utf8')));
  } catch (error) {
    recordDiagnosticError('PLC_HISTORY_READ_FAILED', error, { site: 'desktop/electron/ipc.ts' });
    return [];
  }
}

function writePlcGenHistory(history: PlcHistoryEntry[]): void {
  mkdirSync(dirname(plcHistoryFile()), { recursive: true });
  writeFileSync(plcHistoryFile(), `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

function plcExportFiles(value: unknown): ZipEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('PLC 导出缺少文件');
  if (value.length > 200) throw new Error('PLC 导出文件过多');
  let total = 0;
  const entries = value.map((item, index): ZipEntry => {
    if (typeof item !== 'object' || item === null) throw new Error(`PLC 导出文件 ${index + 1} 格式不合法`);
    const source = item as Record<string, unknown>;
    const path = normalizeZipPath(source.path);
    if (typeof source.content !== 'string') throw new Error(`PLC 导出文件 ${path} 缺少正文`);
    total += Buffer.byteLength(source.content, 'utf8');
    return { path, content: source.content };
  });
  if (total > 20 * 1024 * 1024) throw new Error('PLC 导出正文超过 20MB');
  return entries;
}

function plcExportFailure(error: unknown): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'PLC_EXPORT_FAILED',
    message: error instanceof Error ? error.message : String(error)
  };
}

let ipcRuntime: { factory: FactoryManager; plc: PlcManager } | null = null;

/** 退出前由主进程调用；断开工厂/PLC 网络与定时器。 */
export async function disposeIpcRuntime(): Promise<void> {
  const runtime = ipcRuntime;
  ipcRuntime = null;
  if (!runtime) return;
  await Promise.allSettled([runtime.factory.dispose(), runtime.plc.dispose()]);
}

export function registerIpcHandlers(context: IpcContext): PackRegistry {
  const registry = createPackRegistry(context);
  const factory = new FactoryManager({ configFile: context.factoryConfigFile });
  const plc = new PlcManager({ configFile: context.plcConfigFile });
  ipcRuntime = { factory, plc };
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  factory.on('status', (status: unknown) => broadcast('factory:status', status));
  factory.on('values', (value: TagValue) => broadcast('factory:values', value));
  plc.on('status', (status: unknown) => broadcast('plc:status', status));
  plc.on('values', (values: unknown) => broadcast('plc:values', values));

  ipcMain.handle('app:version', () => ({
    app: context.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }));

  ipcMain.on('modules:sync-plcgen-enabled', (event, enabled: unknown) => {
    const trustedWindow = BrowserWindow.getAllWindows().some((window) =>
      !window.isDestroyed() && window.webContents === event.sender
    );
    if (!trustedWindow || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setPlcgenEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-elec-validation-enabled', (event, enabled: unknown) => {
    const frame = event.senderFrame;
    const trustedMainFrame = Boolean(frame && frame === event.sender.mainFrame && frame.url.startsWith('file://'));
    if (!context.isMainWindowSender(event.sender) || !trustedMainFrame || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setElecValidationEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-cost-estimation-enabled', (event, enabled: unknown) => {
    const frame = event.senderFrame;
    const trustedMainFrame = Boolean(frame && frame === event.sender.mainFrame && frame.url.startsWith('file://'));
    if (!context.isMainWindowSender(event.sender) || !trustedMainFrame || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setCostEstimationEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-factory-plc-sync-enabled', (event, enabled: unknown) => {
    const trustedWindow = BrowserWindow.getAllWindows().some((window) =>
      !window.isDestroyed() && window.webContents === event.sender
    );
    if (!trustedWindow || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setFactoryPlcSyncEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-cad-parametric-import-enabled', (event, enabled: unknown) => {
    const trustedWindow = BrowserWindow.getAllWindows().some((window) =>
      !window.isDestroyed() && window.webContents === event.sender
    );
    if (!trustedWindow || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setParametricImportEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-agent-resume-enabled', (event, enabled: unknown) => {
    const trustedWindow = BrowserWindow.getAllWindows().some((window) =>
      !window.isDestroyed() && window.webContents === event.sender
    );
    if (!trustedWindow || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setAgentResumeEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-project-portable-enabled', (event, enabled: unknown) => {
    const trustedWindow = BrowserWindow.getAllWindows().some((window) =>
      !window.isDestroyed() && window.webContents === event.sender
    );
    if (!trustedWindow || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setProjectPortableEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.on('modules:sync-system-update-enabled', (event, enabled: unknown) => {
    const frame = event.senderFrame;
    const trustedMainFrame = Boolean(frame && frame === event.sender.mainFrame && frame.url.startsWith('file://'));
    if (!context.isMainWindowSender(event.sender) || !trustedMainFrame || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setSystemUpdateEnabled(enabled);
    event.returnValue = true;
  });

  ipcMain.handle('export:saveFile', async (_event, name: unknown, data: unknown) => {
    const validated = validateExportFileName(name);
    const content = exportPayload(data);
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: '导出文件',
      defaultPath: validated.name,
      filters: [
        { name: '导出文件', extensions: EXPORT_EXTENSIONS.map((extension) => extension.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true, path: null };
    const target = ensureExportExtension(result.filePath, validated.extension);
    assertAllowedTargetPath(target);
    writeFileSync(target, content);
    return { canceled: false, path: target };
  });

  const chooseProjectArchiveOpenFile = async (
    title: string,
    filters: NonNullable<OpenDialogOptions['filters']>
  ): Promise<{ canceled: true } | { canceled: false; path: string }> => {
    const options: OpenDialogOptions = { title, properties: ['openFile'], filters };
    const window = BrowserWindow.getFocusedWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    return result.canceled || !path ? { canceled: true } : { canceled: false, path };
  };

  const createProjectArchiveDependencies = () => ({
    isEnabled: context.isProjectPortableEnabled,
    chooseCadFile: () => chooseProjectArchiveOpenFile('选择要收录的 CAD 原件', [
      { name: '支持的单文件 CAD', extensions: ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'glb'] },
      { name: '所有文件', extensions: ['*'] }
    ]),
    chooseArchiveDestination: async (suggestedName: string) => {
      const options = {
        title: '保存 CAD 原件工程档案',
        defaultPath: suggestedName,
        filters: [{ name: 'AutomationCAD 工程档案', extensions: ['acproj'] }]
      };
      const window = BrowserWindow.getFocusedWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath
        ? { canceled: true as const }
        : { canceled: false as const, path: result.filePath };
    },
    chooseArchiveFile: () => chooseProjectArchiveOpenFile('选择要校验与预览的工程档案', [
      { name: 'AutomationCAD 工程档案', extensions: ['acproj'] },
      { name: '所有文件', extensions: ['*'] }
    ]),
    statFile: (path: string) => {
      if (!existsSync(path)) return { isFile: false, size: 0 };
      const info = statSync(path);
      return { isFile: info.isFile(), size: info.size };
    },
    readFile: (path: string) => readFileSync(path),
    writeFileExclusive: writePortableArchiveExclusively,
    appVersion: context.version
  });

  ipcMain.handle('project-archive:export', async (event, snapshot: unknown) => {
    const trustedRequest = isTrustedProjectArchiveRequest(
      context.isMainWindowSender(event.sender),
      event.sender,
      event.senderFrame,
      context.mainWindowRendererUrl
    );
    if (!trustedRequest) return { ok: false, code: 'FAILED', message: '拒绝非应用窗口的工程档案请求。' };
    return await exportSelectedCadAsPortableArchive(createProjectArchiveDependencies(), snapshot);
  });

  ipcMain.handle('project-archive:preview', async (event) => {
    const trustedRequest = isTrustedProjectArchiveRequest(
      context.isMainWindowSender(event.sender),
      event.sender,
      event.senderFrame,
      context.mainWindowRendererUrl
    );
    if (!trustedRequest) return { ok: false, code: 'FAILED', message: '拒绝非应用窗口的工程档案请求。' };
    return await previewSelectedPortableArchive(createProjectArchiveDependencies());
  });

  ipcMain.handle('export:report', async (_event, payload: unknown) => await exportReport(payload));

  ipcMain.handle('cost:exportPanelPdf', async (_event, payload: unknown) =>
    await exportCostPanelPdf(payload, context.isCostEstimationEnabled));

  ipcMain.handle('cost:exportPanelCsv', async (event, payload: unknown) => {
    if (!context.isCostEstimationEnabled()) return costEstimationDisabledResult();
    const trustedMainFrame = Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith('file://'));
    if (!context.isMainWindowSender(event.sender) || !trustedMainFrame) {
      return { ok: false, code: 'FORBIDDEN', message: '拒绝非应用窗口的成本报告请求。' };
    }
    try {
      if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.data !== 'string' || !payload.data) {
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'CSV 导出参数不合法或内容为空。' };
      }
      const validated = validateExportFileName(payload.name);
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: '导出成本明细 CSV',
        defaultPath: validated.name,
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }, { name: '所有文件', extensions: ['*'] }]
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true, path: null };
      if (!context.isCostEstimationEnabled()) return costEstimationDisabledResult();
      const target = ensureExportExtension(result.filePath, '.csv');
      assertAllowedTargetPath(target);
      writeFileSync(target, payload.data, 'utf8');
      return { ok: true, canceled: false, path: target };
    } catch (error) {
      return { ok: false, code: 'WRITE_FAILED', message: `成本报告写入失败：${error instanceof Error ? error.message : String(error)}` };
    }
  });

  // Agent 成本报告落盘：目录固定 userData/exports，不接受调用方传入路径，也不弹系统对话框。
  ipcMain.handle('export:costFile', async (_event, payload: unknown) => {
    try {
      if (!context.isCostEstimationEnabled()) return costEstimationDisabledResult();
      if (!isRecord(payload)) throw new Error('导出参数必须是对象');
      const format = payload.format;
      if (format !== 'pdf' && format !== 'csv') {
        throw new CostExportError('UNSUPPORTED_FORMAT', '导出格式仅支持 pdf 或 csv');
      }
      let data = payload.data;
      if (payload.encoding === 'base64') {
        if (typeof data !== 'string' || !data) throw new Error('导出数据不能为空');
        data = Buffer.from(data, 'base64');
      }
      const content = exportPayload(data);
      if (typeof content === 'string' && content.length === 0) throw new Error('导出数据不能为空');
      if (content instanceof Uint8Array && content.byteLength === 0) throw new Error('导出数据不能为空');

      const directory = join(app.getPath('userData'), 'exports');
      mkdirSync(directory, { recursive: true });
      const planned = planExportName({
        directory,
        format,
        fileName: payload.fileName,
        suggestedName: payload.suggestedName,
        overwrite: payload.overwrite === true,
        exists: existsSync
      });
      writeFileSync(planned.path, content);
      const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
      return { ok: true, path: planned.path, bytes };
    } catch (error) {
      return costExportFailure(error);
    }
  });

  // PLC 生成历史与导出：目录固定 userData/exports/plc，不接受任意绝对路径。
  ipcMain.handle('plcgen:history', () => readPlcGenHistory());

  ipcMain.handle('plcgen:recordHistory', (_event, value: unknown) => {
    if (!context.isPlcgenEnabled()) {
      return { ok: false, code: 'MODULE_DISABLED', message: 'PLC 模块当前已关闭，已拒绝写入生成历史。' };
    }
    const entry = normalizeHistoryEntry(value);
    if (!entry) throw new Error('PLC 生成历史条目格式不合法');
    const next = parsePlcHistory(mergePlcHistory(readPlcGenHistory(), entry));
    writePlcGenHistory(next);
    return next;
  });

  ipcMain.handle('plcgen:export', (_event, payload: unknown) => {
    if (!context.isPlcgenEnabled()) {
      return { ok: false, code: 'MODULE_DISABLED', message: 'PLC 模块当前已关闭，已拒绝导出文件。' };
    }
    try {
      if (!isRecord(payload)) throw new Error('PLC 导出参数必须是对象');
      const files = plcExportFiles(payload.files);
      const plan = planPlcExportDirectory({
        exportsRoot: plcExportRoot(),
        machineName: payload.machineName,
        now: new Date(),
        exists: existsSync
      });
      mkdirSync(plan.path, { recursive: true });
      for (const file of files) {
        const target = resolve(plan.path, file.path);
        if (!target.startsWith(resolve(plan.path) + sep)) throw new Error(`PLC 导出路径越界：${file.path}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      const zip = createZip(files);
      writeFileSync(plan.zipPath, zip);
      return {
        ok: true,
        path: plan.path,
        zipPath: plan.zipPath,
        bytes: zip.byteLength,
        files: files.length
      };
    } catch (error) {
      return plcExportFailure(error);
    }
  });

  ipcMain.handle('plcgen:openExportDir', async (_event, value: unknown) => {
    try {
      const root = resolve(plcExportRoot());
      const target = typeof value === 'string' && value.trim() ? resolve(value) : root;
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error('只能打开 PLC 导出目录内的路径');
      }
      mkdirSync(target, { recursive: true });
      const message = await shell.openPath(target);
      return message ? { ok: false, path: target, message } : { ok: true, path: target };
    } catch (error) {
      return {
        ok: false,
        path: typeof value === 'string' ? value : '',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('cad:open-dialog', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: '打开 CAD 文件',
      properties: ['openFile'],
      filters: [
        { name: 'CAD 文件', extensions: CAD_EXTENSIONS.map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('cad:read-file', (_event, filePath: unknown) => {
    setDiagnosticOperation('cad:read-file');
    try {
      if (typeof filePath !== 'string' || !filePath) throw new Error('缺少文件路径');
      if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`文件不存在：${filePath}`);
      const ext = extname(filePath).toLowerCase();
      if (!isCadExtension(ext)) throw new Error(`不支持的 CAD 扩展名：${ext || '(无)'}`);
      const size = statSync(filePath).size;
      // 在 readFileSync 之前拒绝超大文件，避免主进程一次性分配数百 MB。
      assertCadFileSize(filePath, size);
      setDiagnosticOperation(`cad:read-file:${ext.slice(1)}`);
      return readFileSync(filePath);
    } catch (error) {
      recordDiagnosticError('CAD_READ_FAILED', error, {
        extension: typeof filePath === 'string' ? extname(filePath).toLowerCase() : '',
        fileName: typeof filePath === 'string' ? filePath.split(/[\\/]/).pop() ?? '' : ''
      });
      throw error;
    }
  });

  // 成本估算的内置价格簿：只读，返回校验后的价格簿与条目统计（示例条目不计价）。
  ipcMain.handle('cost:pricebook', () => {
    if (!context.isCostEstimationEnabled()) return costEstimationDisabledResult();
    const pricebookPath = join(context.builtinDir, 'pricebook-cn', 'pricebook.json');
    if (!existsSync(pricebookPath)) {
      return { ok: false, message: `内置价格簿缺失：${pricebookPath}` };
    }
    try {
      const book = validatePricebook(JSON.parse(readFileSync(pricebookPath, 'utf8')) as unknown);
      const items = Object.values(book.items);
      const usableItems = items.filter((item) => isUsablePricebookItem(item)).length;
      return {
        ok: true,
        book,
        path: pricebookPath,
        currency: book.currency,
        updatedAt: book.updatedAt,
        usableItems,
        exampleItems: items.length - usableItems
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('packs:list', async () => await registry.scan());
  ipcMain.handle('packs:import-zip', async (_event, zipPath: unknown) => {
    if (typeof zipPath !== 'string' || !zipPath) throw new Error('缺少 ZIP 路径');
    return await registry.importZip(zipPath);
  });
  ipcMain.handle('packs:set-enabled', async (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('参数不合法');
    await registry.setEnabled(id, enabled);
    return { ok: true };
  });
  ipcMain.handle('packs:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('参数不合法');
    await registry.remove(id);
    return { ok: true };
  });
  ipcMain.handle('packs:list-parts', (_event, filter: unknown) => {
    const source = typeof filter === 'object' && filter !== null ? filter as Record<string, unknown> : {};
    return registry.listParts({
      ...(typeof source.q === 'string' ? { q: source.q } : {}),
      ...(typeof source.category === 'string' ? { category: source.category } : {}),
      ...(typeof source.packId === 'string' ? { packId: source.packId } : {})
    });
  });

  ipcMain.handle('packs:choose-zip', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: '导入数据包',
      properties: ['openFile'],
      filters: [{ name: '数据包 ZIP', extensions: ['zip'] }]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('agent:info', () => context.getAgentInfo());

  const getParametric = (): ParametricManager | null => context.getParametric();
  const unavailableStatus = { status: 'unavailable' as const, message: '参数化建模内核不可用' };
  const parametricEnabled = (): boolean => isParametricImportEnabled(context.isParametricImportEnabled);
  const publicStart = (info: ParametricStartInfo): Omit<ParametricStartInfo, 'port' | 'token'> => ({
    ok: info.ok,
    status: info.status,
    message: info.message,
    ...(info.version ? { version: info.version } : {})
  });
  const parametric = getParametric();
  parametric?.onStatus((state) => broadcast('parametric:status-changed', state));
  ipcMain.handle('parametric:status', () => {
    if (!parametricEnabled()) return parametricModuleDisabledStatus();
    return getParametric()?.status() ?? unavailableStatus;
  });
  ipcMain.handle('parametric:start', async () => {
    if (!parametricEnabled()) {
      return { ok: false, code: 'MODULE_DISABLED' as const, ...parametricModuleDisabledStatus() };
    }
    const manager = getParametric();
    if (!manager) return { ok: false, status: 'unavailable', message: unavailableStatus.message };
    return publicStart(await manager.start());
  });
  ipcMain.handle('parametric:build', async (_event, doc: unknown) => {
    if (!parametricEnabled()) return parametricModuleDisabledBuildResult();
    const manager = getParametric();
    if (!manager) return { ok: false, code: 'UNAVAILABLE', message: unavailableStatus.message };
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { ok: false, code: 'BUILD_FAILED', message: '特征树必须是对象' };
    }
    return await manager.build(doc as FeatureDoc);
  });
  ipcMain.handle('parametric:stop', async () => {
    const manager = getParametric();
    if (!manager) return unavailableStatus;
    await manager.stop();
    return manager.status();
  });

  ipcMain.handle('factory:info', () => ({ ok: true, adapters: factory.list(), status: factory.getStatus() }));
  ipcMain.handle('factory:list', () => ({ ok: true, data: factory.list() }));
  ipcMain.handle('factory:status', () => ({ ok: true, data: factory.getStatus() }));
  ipcMain.handle('factory:config', () => factory.getConfig());
  ipcMain.handle('factory:connect', (_event, config: unknown) => factory.connect(config));
  ipcMain.handle('factory:disconnect', () => factory.disconnect());
  ipcMain.handle('factory:browse', (_event, nodeId: unknown) => {
    if (nodeId !== undefined && typeof nodeId !== 'string') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'nodeId 必须是字符串' };
    }
    return factory.browse(nodeId);
  });
  ipcMain.handle('factory:read-tags', (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是数组' };
    return factory.readTags(ids);
  });
  ipcMain.handle('factory:write-tag', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    return factory.writeTag(id, value);
  });
  ipcMain.handle('factory:subscribe', (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是数组' };
    return factory.subscribe(ids, (value) => broadcast('factory:values', value));
  });

  ipcMain.handle('plc:info', () => ({ ok: true, adapters: plc.list(), status: plc.getStatus() }));
  ipcMain.handle('plc:list', () => ({ ok: true, data: plc.list() }));
  ipcMain.handle('plc:status', () => ({ ok: true, data: plc.getStatus() }));
  ipcMain.handle('plc:config', () => plc.getConfig());
  ipcMain.handle('plc:connect', (_event, config: unknown) => plc.connect(config));
  ipcMain.handle('plc:disconnect', () => plc.disconnect());
  ipcMain.handle('plc:read', (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    return plc.read(id);
  });
  ipcMain.handle('plc:read-all', () => plc.readAll());
  ipcMain.handle('plc:write', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (typeof value !== 'boolean' && typeof value !== 'number') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    }
    return plc.write(id, value);
  });
  ipcMain.handle('plc:force', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (typeof value !== 'boolean' && typeof value !== 'number') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    }
    return plc.force(id, value);
  });

  const syncConfig = (): SyncConfig => readSyncConfig(context.syncConfigFile);
  const syncClient = (config: SyncConfig): SyncClient => new SyncClient(config);
  const syncPlcEnabled = (): boolean => context.isPlcgenEnabled() && context.isFactoryPlcSyncEnabled();
  let lastPlcReviewCandidate: { packageId: string; candidate: SyncImportCandidate; expiresAt: number } | null = null;

  ipcMain.handle('sync:getConfig', () => publicSyncConfig(syncConfig()));
  ipcMain.handle('sync:saveConfig', (_event, patch: unknown) => {
    const next = mergeSyncConfig(syncConfig(), patch);
    writeSyncConfig(context.syncConfigFile, next);
    return publicSyncConfig(next);
  });
  ipcMain.handle('sync:test', async () => {
    try {
      return await syncClient(syncConfig()).testConnection();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:list', async () => {
    try {
      return await syncClient(syncConfig()).listPackages();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:diff', async (_event, packageId: unknown) => {
    if (typeof packageId !== 'string' || !packageId.trim()) {
      return { ok: false, message: '缺少 packageId' };
    }
    try {
      return await syncClient(syncConfig()).diff(packageId);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:downloadCandidate', async (_event, packageId: unknown, machineContext: unknown) => {
    if (typeof packageId !== 'string' || !packageId.trim()) {
      return { ok: false, stage: '下载', code: 'DOWNLOAD_FAILED', message: '缺少 packageId' };
    }
    lastPlcReviewCandidate = null;
    let currentMachine: ReturnType<typeof validateMachineConfig> | undefined;
    if (machineContext !== undefined && machineContext !== null) {
      try {
        currentMachine = validateMachineConfig(machineContext);
      } catch (error) {
        return {
          ok: false,
          stage: '解析',
          code: 'INVALID_MACHINE_CONTEXT',
          message: `当前机型上下文无效：${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    try {
      const downloaded = await syncClient(syncConfig()).downloadPackage(packageId);
      if (!downloaded.ok) return downloaded;
      try {
        const candidate = parseDesignPackage(downloaded.zip, currentMachine, { allowPlc: syncPlcEnabled() });
        if (candidate.plc && syncPlcEnabled()) {
          lastPlcReviewCandidate = { packageId, candidate, expiresAt: Date.now() + 15 * 60 * 1000 };
        }
        return {
          ok: true,
          candidate,
          bytes: downloaded.bytes,
          sha256: downloaded.sha256,
          ...(downloaded.etag ? { etag: downloaded.etag } : {})
        };
      } catch (error) {
        return {
          ok: false,
          stage: '解析',
          code: 'PACKAGE_VALIDATION_FAILED',
          message: `下载包校验失败，未写入本地工程：${error instanceof Error ? error.message : String(error)}`
        };
      }
    } catch (error) {
      return {
        ok: false,
        stage: '下载',
        code: 'DOWNLOAD_FAILED',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle('sync:exportCandidateReview', async (event, packageId: unknown) => {
    const trustedRequest = isTrustedProjectArchiveRequest(
      context.isMainWindowSender(event.sender),
      event.sender,
      event.senderFrame,
      context.mainWindowRendererUrl
    );
    if (!trustedRequest) return { ok: false, code: 'FORBIDDEN', message: '拒绝非应用主窗口的 PLC 审阅导出请求。' };
    if (!syncPlcEnabled()) return { ok: false, code: 'MODULE_DISABLED', message: 'PLC 同步或生成模块已关闭，已拒绝审阅导出。' };
    if (typeof packageId !== 'string' || !packageId.trim()) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少 packageId。' };
    }
    const cached = lastPlcReviewCandidate;
    if (!cached || cached.packageId !== packageId || cached.expiresAt <= Date.now() || !cached.candidate.plc) {
      return { ok: false, code: 'CANDIDATE_UNAVAILABLE', message: '没有可导出的近期已校验 PLC 候选；请重新下载并校验。' };
    }
    try {
      const options: OpenDialogOptions = {
        title: '选择本地 PLC 候选审阅导出的父文件夹',
        properties: ['openDirectory']
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
      if (!syncPlcEnabled()) return { ok: false, code: 'MODULE_DISABLED', message: 'PLC 同步或生成模块已关闭，已拒绝审阅导出。' };
      if (lastPlcReviewCandidate !== cached || cached.expiresAt <= Date.now()) {
        return { ok: false, code: 'CANDIDATE_UNAVAILABLE', message: '候选已过期或已被替换；请重新下载并校验。' };
      }
      const exported = exportCandidateReviewFolder(picked.filePaths[0], packageId, cached.candidate);
      return { ok: true, canceled: false, folderName: exported.folderName, fileCount: exported.fileCount };
    } catch (error) {
      return { ok: false, code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:upload', async (_event, value: unknown) => {
    if (isRecord(value) && value.plc !== undefined && !syncPlcEnabled()) {
      return {
        ok: false,
        stage: '打包',
        code: 'MODULE_DISABLED',
        message: '智慧工厂 PLC 同步模块或 PLC 生成模块当前已关闭，已拒绝生成或上传包含 PLC 源码/IO mapping 的同步包。'
      };
    }
    let payload: SyncUploadPayload;
    try {
      payload = parseSyncPayload(value);
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    let config: SyncConfig;
    try {
      config = syncConfig();
    } catch (error) {
      return {
        ok: false,
        stage: '连接',
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (!config.enabled) {
      return { ok: false, stage: '上传', message: '智慧工厂同步未启用，请先在设置中打开启用开关' };
    }
    if (!config.baseUrl || !config.deviceId || !config.projectId) {
      return { ok: false, stage: '连接', message: '请先完整填写 baseUrl、deviceId、projectId 与 apiKey' };
    }

    let pdf: Uint8Array;
    try {
      const report = await exportReport({ html: payload.reportHtml, projectName: payload.projectName });
      pdf = new Uint8Array(readFileSync(report.path));
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：PDF 报告生成失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (payload.plc && !syncPlcEnabled()) {
      return {
        ok: false,
        stage: '打包',
        code: 'MODULE_DISABLED',
        message: '智慧工厂 PLC 同步模块或 PLC 生成模块已关闭，已拒绝继续生成/上传 PLC 内容。'
      };
    }

    let built: ReturnType<typeof buildDesignPackage>;
    try {
      built = buildDesignPackage({
        projectId: config.projectId,
        projectName: payload.projectName,
        appVersion: context.version,
        bom: payload.bom,
        bomCsv: payload.bomCsv,
        pdf,
        glb: payload.glb,
        dxf: payload.dxf,
        ...(payload.plc ? { plc: payload.plc } : {})
      }, { allowPlc: syncPlcEnabled() });
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (payload.plc && !syncPlcEnabled()) {
      return {
        ok: false,
        stage: '上传',
        code: 'MODULE_DISABLED',
        message: '智慧工厂 PLC 同步模块或 PLC 生成模块已关闭，已拒绝上传 PLC 内容。'
      };
    }

    let result: Awaited<ReturnType<SyncClient['uploadPackage']>>;
    try {
      result = await syncClient(config).uploadPackage(built.zip, built.manifest);
    } catch (error) {
      return {
        ok: false,
        stage: '上传',
        message: `上传失败：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (result.ok && built.skipped.length > 0) {
      const skipped = `未包含缺失文件：${built.skipped.join('、')}`;
      return { ...result, message: result.message ? `${result.message}；${skipped}` : skipped };
    }
    return result;
  });

  app.on('before-quit', () => {
    void factory.disconnect();
    void plc.disconnect();
  });

  return registry;
}

export function registerAgentChatIpc(context: AgentChatIpcContext): void {
  let session: AgentSession | null = null;
  const thread = new AgentThread();
  let activeChat: AbortController | null = null;
  let activePlan: AbortController | null = null;
  let activeRecipe: AbortController | null = null;
  const canUsePlanResume = (): boolean => isAgentResumeEnabled(() => context.isAgentResumeEnabled());

  // 审计写入：超过 maxBytes 轮转为 agent-audit.N.jsonl，并按保留期清理；
  // 参数来自 userData/agent-audit-retention.json（可选，缺省 5 MB × 5 份 × 90 天）。
  const agentAuditWriter = (): ((line: string) => void) => createAuditFileWriter(
    join(context.userDataDir, 'agent-audit.jsonl'),
    {
      retention: loadAuditRetention(context.userDataDir),
      onError: (error) => console.warn('[agent-audit] 轮转/清理失败', error instanceof Error ? error.message : error)
    }
  );

  const currentProjectCheckpointFingerprint = async (): Promise<string | null> => {
    const window = context.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    try {
      const value = await window.webContents.executeJavaScript(
        'window.__AgentBridge?.getProjectCheckpointFingerprint?.() ?? null'
      );
      return isProjectFingerprint(value) ? value : null;
    } catch {
      return null;
    }
  };

  const planCheckpointRefusal = (summary: string) => ({
    ok: false,
    confirmationRequired: false,
    confirmed: false,
    refused: true,
    results: [],
    totalMs: 0,
    summary
  });

  const clearSession = (): void => {
    session = null;
    thread.clear();
  };

  const getSession = (): AgentSession => {
    if (session) return session;
    const tools = context.getTools();
    const bus = context.getBus();
    if (!tools || !bus) throw new Error('智能体服务尚未启动');
    const config = readLlmConfig(context.userDataDir);
    if (!config.apiKey) throw new Error('请先在模型设置中填写 API Key');
    const llm = new OpenAiCompatibleClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      tools: () => tools.summaries()
    });
    const audit = createAuditLog({ write: agentAuditWriter() });
    // 智能体工具层包含只读的 design_machine / search_* 等纯工具，它们不在
    // CommandBus 中注册。对话执行先走命令总线，未知命令再回退到工具层。
    const agentExecutor = {
      async execute(name: string, args?: Record<string, unknown>, signal?: AbortSignal) {
        const result = await bus.execute(name, args, signal);
        if (!result.ok && result.error?.code === 'UNKNOWN_COMMAND' && tools.has(name)) {
          const fallback = await tools.call(name, args ?? {}, signal);
          const record = typeof fallback === 'object' && fallback !== null
            ? fallback as Record<string, unknown>
            : null;
          if (record?.ok === false) {
            return {
              ok: false as const,
              error: {
                code: typeof record.code === 'string' ? record.code : 'TOOL_FAILED',
                message: typeof record.message === 'string' ? record.message : `${name} 执行失败`
              }
            };
          }
          // 工具层结果已经是 { ok, design/... } 形态；直接返回，避免再包一层
          // data 导致渲染层的机型方案卡无法解析。
          return fallback as { ok: boolean; data?: unknown };
        }
        return result;
      },
      undoLast(signal?: AbortSignal) {
        return bus.undoLast(signal);
      }
    };
    session = new AgentSession({
      llm,
      bus: agentExecutor,
      maxIterations: config.maxIterations,
      thread,
      model: config.model,
      pricing: DEFAULT_PRICING,
      toolSchemas: (name) => tools.summaries().find((tool) => tool.name === name)?.inputSchema,
      audit: (record) => audit.record(record),
      contextProvider: async () => {
        try {
          const result = await bus.execute('get_project_context');
          if (!result.ok) return null;
          return collectAgentContext({ projectContext: () => result.data });
        } catch (error) {
          recordDiagnosticError('AGENT_CONTEXT_FAILED', error, { site: 'desktop/electron/ipc.ts' });
          return null;
        }
      },
      confirmWrite: async (name, args, confirmContext) => {
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const serialized = JSON.stringify(args);
        const summary = serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized;
        const bypassNotice = confirmContext?.bypass
          ? (confirmContext.notice ?? BYPASS_CONFIRMATION_NOTICE)
          : '';
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: '智能体写操作确认',
          message: `智能体请求执行 ${name}，参数：${summary}，是否允许？${bypassNotice ? `（${bypassNotice}）` : ''}`,
          detail: bypassNotice ? `该操作会修改当前装配体。${bypassNotice}。` : '该操作会修改当前装配体。',
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return result.response === 0;
      }
    });
    return session;
  };

  ipcMain.handle('agent:llm:get', () => publicLlmConfig(readLlmConfig(context.userDataDir)));

  // 当前工程机型：只读 active 指针，供渲染层启动时恢复 3D 配置。
  ipcMain.handle('machine:active', () => {
    try {
      const design = readActiveMachineDesign(context.userDataDir);
      return design
        ? { ok: true, design }
        : { ok: true, design: null };
    } catch (error) {
      return { ok: false, design: null, message: error instanceof Error ? error.message : String(error) };
    }
  });

  // 当前机型 → PLC IO 点位。只读当前 active 方案，供 CAD 侧栏预览。
  ipcMain.handle('machine:io-map', () => {
    try {
      const design = readActiveMachineDesign(context.userDataDir);
      if (!design) return { ok: false, message: '尚未应用机型方案', rows: [], csv: '' };
      const ioMap = buildMachineIoMap(design.config);
      return {
        ok: true,
        machine: {
          id: design.id,
          name: design.name,
          stations: design.config.stations.length,
          actuators: design.config.actuators.length,
          sensors: design.config.sensors.length
        },
        rows: ioMap.rows,
        csv: ioMap.csv
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), rows: [], csv: '' };
    }
  });

  ipcMain.handle('agent:llm:save', (_event, patch: unknown) => {
    const saved = saveLlmConfig(context.userDataDir, patch);
    clearSession();
    return publicLlmConfig(saved);
  });

  ipcMain.handle('agent:llm:test', async (_event, patch: unknown) => {
    let config: ReturnType<typeof readLlmConfig>;
    try {
      const existing = readLlmConfig(context.userDataDir);
      config = patch === undefined ? existing : mergeLlmConfig(existing, patch);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!config.apiKey) return { ok: false, message: '请先在模型设置中填写 API Key' };
    return await testLlmConnection(config);
  });

  ipcMain.handle('agent:chat:history', () => ({ ok: true, messages: session?.history() ?? [] }));

  // 审计只读接口：最近 200 条，凭据已在写入前脱敏；更早记录用 total/dropped 如实回报。
  ipcMain.handle('agent:audit:read', () => {
    const file = join(context.userDataDir, 'agent-audit.jsonl');
    try {
      // 当前文件 + 轮转份数（agent-audit.N.jsonl）一起读；面板仍只显示最近 200 条，total/summary 覆盖全部保留份数。
      const { entries: all, files } = readAuditEntries(file, loadAuditRetention(context.userDataDir));
      if (files.length === 0) {
        return { ok: true, entries: [], total: 0, dropped: 0, files: 0, summary: summarizeAudit([]) };
      }
      const limited = limitAuditEntries(all, AUDIT_DISPLAY_LIMIT);
      return { ok: true, ...limited, files: files.length, summary: summarizeAudit(all) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('agent:chat:clear', () => {
    clearSession();
    return { ok: true, messages: [] };
  });

  ipcMain.handle('agent:plan:checkpoint:clear', () => {
    if (!canUsePlanResume()) {
      return { ok: false, code: 'MODULE_DISABLED', message: AGENT_RESUME_DISABLED_MESSAGE };
    }
    try {
      clearPlanCheckpoint(context.userDataDir);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('agent:plan:checkpoint:restore', async (_event, payload: unknown) => {
    if (!canUsePlanResume()) {
      return { ok: true, available: false, disabled: true, message: AGENT_RESUME_DISABLED_MESSAGE };
    }
    const tools = context.getTools();
    if (!tools) return { ok: false, available: false, message: '智能体服务尚未启动' };
    let plan: AgentPlan;
    try {
      if (!isRecord(payload)) throw new Error('恢复请求无效');
      plan = parseCheckpointPlan(payload.plan, tools);
      planCheckpointSignature(plan);
    } catch (error) {
      return { ok: false, available: false, message: error instanceof Error ? error.message : String(error) };
    }

    const loaded = loadPlanCheckpoint(context.userDataDir);
    if (!loaded.checkpoint) {
      return loaded.error
        ? { ok: true, available: true, blocked: true, message: `${loaded.error}；请丢弃旧进度后重新规划` }
        : { ok: true, available: false };
    }
    const fingerprint = await currentProjectCheckpointFingerprint();
    if (!canUsePlanResume()) {
      return { ok: true, available: false, disabled: true, message: AGENT_RESUME_DISABLED_MESSAGE };
    }
    const inspection = inspectPlanCheckpoint(loaded.checkpoint, plan, fingerprint);
    if (!inspection.ok) {
      if (isPlanCheckpointFullyCompleted(loaded.checkpoint)
          && (inspection.reason === 'signature' || inspection.reason === 'fingerprint')) {
        return { ok: true, available: false };
      }
      return {
        ok: true,
        available: true,
        blocked: true,
        requiresReplan: inspection.reason === 'uncertain-write' || inspection.reason === 'fingerprint',
        message: `${inspection.message}；请丢弃旧进度后重新规划`
      };
    }
    return {
      ok: true,
      available: true,
      blocked: false,
      cursor: inspection.cursor,
      steps: inspection.steps.map(({ index, tool, wrote, state }) => ({ index, tool, wrote, state })),
      needsReconfirmation: inspection.needsReconfirmation
    };
  });

  // P7-C：计划执行。规划在渲染层离线完成；主进程只接受已注册工具并再次校验。
  ipcMain.handle('agent:plan:execute', async (event, payload: unknown) => {
    const tools = context.getTools();
    const bus = context.getBus();
    if (!tools || !bus) {
      return {
        ok: false,
        confirmationRequired: false,
        confirmed: false,
        refused: true,
        results: [],
        totalMs: 0,
        summary: '智能体服务尚未启动'
      };
    }

    let plan: AgentPlan;
    let startAt: number | undefined;
    let maxSteps: number | undefined;
    let resumeFrom: number | undefined;
    let explicitResumeRequest = false;
    try {
      if (typeof payload !== 'object' || payload === null) throw new Error('计划参数必须是对象');
      const source = payload as Record<string, unknown>;
      const rawPlan = source.plan;
      if (typeof rawPlan !== 'object' || rawPlan === null) throw new Error('缺少计划');
      const planRecord = rawPlan as Record<string, unknown>;
      if (!Array.isArray(planRecord.steps) || planRecord.steps.length < 1 || planRecord.steps.length > 200) {
        throw new Error('计划步骤数必须在 1–200 之间');
      }
      const steps: PlanStep[] = planRecord.steps.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new Error(`第 ${index + 1} 步不是对象`);
        const step = entry as Record<string, unknown>;
        const tool = typeof step.tool === 'string' ? step.tool.trim() : '';
        if (!tool) throw new Error(`第 ${index + 1} 步缺少工具名`);
        if (!tools.has(tool)) throw new Error(`第 ${index + 1} 步工具未注册：${tool}`);
        const args = typeof step.args === 'object' && step.args !== null && !Array.isArray(step.args)
          ? { ...(step.args as Record<string, unknown>) }
          : {};
        const missing = Array.isArray(step.missing)
          ? step.missing.filter((value): value is string => typeof value === 'string')
          : undefined;
        return {
          tool,
          args,
          why: typeof step.why === 'string' ? step.why : '',
          readOnly: READ_ONLY_TOOLS.has(tool),
          ...(missing && missing.length > 0 ? { missing } : {})
        };
      });
      const confidence = typeof planRecord.confidence === 'number' && Number.isFinite(planRecord.confidence)
        ? planRecord.confidence
        : 0;
      const suggestions = Array.isArray(planRecord.suggestions)
        ? planRecord.suggestions.filter((value): value is string => typeof value === 'string')
        : undefined;
      const warnings = Array.isArray(planRecord.warnings)
        ? planRecord.warnings.filter((value): value is string => typeof value === 'string')
        : undefined;
      plan = {
        steps,
        confidence,
        ...(planRecord.refused === true ? { refused: true } : {}),
        ...(typeof planRecord.reason === 'string' ? { reason: planRecord.reason } : {}),
        ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
        ...(warnings && warnings.length > 0 ? { warnings } : {})
      };
      startAt = typeof source.startAt === 'number' && Number.isFinite(source.startAt)
        ? Math.max(0, Math.trunc(source.startAt))
        : undefined;
      maxSteps = typeof source.maxSteps === 'number' && Number.isFinite(source.maxSteps)
        ? Math.max(1, Math.trunc(source.maxSteps))
        : undefined;
      const rawResume = source.resumeFrom !== undefined
        ? source.resumeFrom
        : source.resume === true ? 0 : undefined;
      explicitResumeRequest = source.resumeFrom !== undefined || source.resume === true;
      resumeFrom = typeof rawResume === 'number' && Number.isFinite(rawResume)
        ? Math.max(0, Math.trunc(rawResume))
        : undefined;
    } catch (error) {
      return {
        ok: false,
        confirmationRequired: false,
        confirmed: false,
        refused: true,
        results: [],
        totalMs: 0,
        summary: `计划无效：${error instanceof Error ? error.message : String(error)}`
      };
    }

    const audit = createAuditLog({ write: agentAuditWriter() });
    let confirmCount = 0;
    const controller = new AbortController();
    const emitProgress = (progress: AgentProgressEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
    };
    let currentContext = null;
    try {
      const project = await bus.execute('get_project_context');
      if (project.ok) currentContext = collectAgentContext({ projectContext: () => project.data });
    } catch {
      currentContext = null;
    }
    const requestedStartAt = resumeFrom ?? startAt ?? 0;
    const resumeEnabledAtStart = canUsePlanResume();
    if (explicitResumeRequest && !resumeEnabledAtStart) {
      return planCheckpointRefusal(AGENT_RESUME_DISABLED_MESSAGE);
    }
    let checkpoint: PlanCheckpoint | null = null;
    if (resumeEnabledAtStart && canUsePlanResume()) {
      if (!currentContext) {
        return planCheckpointRefusal('当前工程上下文不可用，不能安全校验计划恢复；请检查工程并重试');
      }
      const strongFingerprint = await currentProjectCheckpointFingerprint();
      if (!canUsePlanResume()) {
        if (explicitResumeRequest) return planCheckpointRefusal(AGENT_RESUME_DISABLED_MESSAGE);
      } else {
        if (!strongFingerprint) {
          return planCheckpointRefusal('当前工程无法生成可靠上下文指纹，计划未执行；请重新规划并在工程状态可读取后重试');
        }
        if (startAt !== undefined && resumeFrom !== undefined && startAt !== resumeFrom) {
          return planCheckpointRefusal('计划游标参数冲突，已拒绝跳过步骤');
        }
        const loadedCheckpoint = loadPlanCheckpoint(context.userDataDir);
        if (loadedCheckpoint.error) {
          return planCheckpointRefusal(`${loadedCheckpoint.error}；请丢弃损坏的恢复记录后重新规划`);
        }
        if (loadedCheckpoint.checkpoint) {
          const inspection = inspectPlanCheckpoint(loadedCheckpoint.checkpoint, plan, strongFingerprint);
          const mayReplaceCompleted = requestedStartAt === 0
            && isPlanCheckpointFullyCompleted(loadedCheckpoint.checkpoint)
            && !inspection.ok
            && (inspection.reason === 'signature' || inspection.reason === 'fingerprint');
          if (mayReplaceCompleted) {
            try {
              checkpoint = createPlanCheckpoint(plan, strongFingerprint);
              savePlanCheckpoint(context.userDataDir, checkpoint);
            } catch (error) {
              return planCheckpointRefusal(`无法替换已完成计划 checkpoint：${error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            if (!inspection.ok) return planCheckpointRefusal(`${inspection.message}；请丢弃旧进度后重新规划`);
            if (requestedStartAt !== inspection.cursor) {
              return planCheckpointRefusal(
                inspection.cursor > 0 && requestedStartAt === 0
                  ? '检测到同一计划已有完成步骤；请先恢复并核对进度，不能从第一步重新执行'
                  : `计划游标与已保存进度不一致（应为第 ${inspection.cursor + 1} 步），已拒绝执行`
              );
            }
            checkpoint = {
              ...loadedCheckpoint.checkpoint,
              cursor: inspection.cursor,
              steps: inspection.steps,
              updatedAt: new Date().toISOString()
            };
            try {
              // 只读中断可安全重试；将其运行中/失败状态归一为 pending 后再落盘。
              savePlanCheckpoint(context.userDataDir, checkpoint);
            } catch {
              return planCheckpointRefusal('无法安全保存恢复进度，计划未执行；请检查应用数据目录后重新规划');
            }
            if (requestedStartAt > 0) {
              const previous: ThreadState = {
                turnId: (thread.read()?.turnId ?? 0) + 1,
                projectFingerprint: projectFingerprint(currentContext),
                intent: '计划跨重启恢复',
                targets: [],
                denials: [],
                completedSteps: inspection.steps
                  .filter((step) => step.state === 'completed')
                  .map((step) => ({
                    step: step.index + 1,
                    index: step.index,
                    tool: step.tool,
                    ok: true,
                    wrote: step.wrote
                  })),
                lastReplySummary: '已从安全 checkpoint 恢复完成步骤',
                source: 'plan',
                planSignature: planSignature(plan),
                updatedAt: checkpoint.updatedAt
              };
              thread.write(previous);
            }
          }
        } else {
          if (requestedStartAt > 0) return planCheckpointRefusal('找不到匹配的恢复记录，已拒绝跳过步骤；请重新规划');
          try {
            checkpoint = createPlanCheckpoint(plan, strongFingerprint);
            // 先持久化 pending 游标；后续每个工具调用还会在执行前再次原子落盘。
            savePlanCheckpoint(context.userDataDir, checkpoint);
          } catch (error) {
            return planCheckpointRefusal(`无法初始化安全恢复记录：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } else if (explicitResumeRequest) {
      return planCheckpointRefusal(AGENT_RESUME_DISABLED_MESSAGE);
    }
    activePlan = controller;
    const result = await runPlan(plan, {
      ...(startAt !== undefined ? { startAt } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      ...(currentContext ? { currentContext } : {}),
      thread,
      userText: '计划执行',
      signal: controller.signal,
      onProgress: emitProgress,
      confirmPlan: async (request) => {
        confirmCount += 1;
        if (process.env.AUTOMATIONCAD_AUTOCONFIRM === '1') return true;
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const detail = request.steps
          .map((step, index) => `${index + 1}. ${step.tool} ${JSON.stringify(step.args)}`)
          .join('\n');
        const response = await dialog.showMessageBox(window, {
          type: 'question',
          title: '智能体多步计划确认',
          message: request.message,
          detail: detail.length > 1200 ? `${detail.slice(0, 1200)}…` : detail,
          buttons: ['全部允许', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return response.response === 0;
      },
      execute: async (step, stepIndex, signal) => {
        const stepStarted = Date.now();
        const recordOutcome = (value: unknown): void => {
          const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
          const hasNestedError = Boolean(record && record.error !== undefined && record.error !== null);
          const ok = record ? (record.ok === undefined ? !hasNestedError : record.ok === true) : value !== false;
          const code = record && typeof record.code === 'string'
            ? record.code
            : record && typeof record.error === 'object' && record.error !== null && typeof (record.error as Record<string, unknown>).code === 'string'
              ? String((record.error as Record<string, unknown>).code)
              : undefined;
          audit.record({
            tool: step.tool,
            ok,
            source: 'plan',
            args: step.args,
            elapsedMs: Math.max(0, Date.now() - stepStarted),
            ...(code ? { code } : {})
          });
        };
        const checkpointStep = checkpoint && canUsePlanResume() ? checkpoint.steps[stepIndex] : undefined;
        if (checkpointStep && checkpoint) {
          if (checkpointStep.tool !== step.tool || checkpointStep.wrote === READ_ONLY_TOOLS.has(step.tool)) {
            throw new Error('checkpoint 步骤与主进程执行计划不一致；已阻止工具调用');
          }
          // 先落盘 running；若进程在副作用后、完成回执前退出，恢复时按 uncertain 写步骤 fail-closed。
          checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, 'running');
          savePlanCheckpoint(context.userDataDir, checkpoint);
        }
        let outcome: unknown;
        try {
          outcome = await tools.call(step.tool, step.args, signal);
        } catch (error) {
          if (checkpointStep && checkpoint && canUsePlanResume()) {
            checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, checkpointStep.wrote ? 'uncertain' : 'failed');
            savePlanCheckpoint(context.userDataDir, checkpoint);
          }
          throw error;
        }
        if (!checkpointStep || !checkpoint || !canUsePlanResume()) {
          recordOutcome(outcome);
          return outcome;
        }
        const initialRecord = typeof outcome === 'object' && outcome !== null
          ? outcome as Record<string, unknown>
          : null;
        const initialHasError = Boolean(initialRecord && initialRecord.error !== undefined && initialRecord.error !== null);
        const initialOk = initialRecord
          ? (initialRecord.ok === undefined ? !initialHasError : initialRecord.ok === true)
          : outcome !== false;
        if (initialOk) {
          const postFingerprint = await currentProjectCheckpointFingerprint();
          if (!canUsePlanResume()) {
            recordOutcome(outcome);
            return outcome;
          }
          if (!postFingerprint) {
            checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, checkpointStep.wrote ? 'uncertain' : 'failed');
            outcome = {
              ok: false,
              code: 'CHECKPOINT_FINGERPRINT_UNAVAILABLE',
              message: '工具完成后无法验证工程摘要；计划已停止，需检查工程并重新规划'
            };
          } else if (checkpointStep.wrote) {
            // 写步骤可能正常改变工程内容；把写后摘要与完成回执原子提交，供下次启动匹配。
            checkpoint = updatePlanCheckpointFingerprint(checkpoint, postFingerprint);
            checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, 'completed');
          } else if (postFingerprint !== checkpoint.projectFingerprint) {
            checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, 'failed');
            outcome = {
              ok: false,
              code: 'PROJECT_CHANGED_DURING_PLAN',
              message: '只读步骤期间工程状态发生变化；计划已停止，请重新规划'
            };
          } else {
            checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, 'completed');
          }
        } else {
          checkpoint = updatePlanCheckpoint(checkpoint, stepIndex, checkpointStep.wrote ? 'uncertain' : 'failed');
        }
        // 持久化失败时，磁盘仍保留 running；写步骤恢复会要求重新规划而不是重放。
        if (canUsePlanResume()) savePlanCheckpoint(context.userDataDir, checkpoint);
        recordOutcome(outcome);
        return outcome;
      }
    });
    if (activePlan === controller) activePlan = null;
    return { ...result, confirmations: confirmCount };
  });

  // P7-I：流程模板执行。模板与占位符在共享模块中解析，主进程只负责逐步骤确认、审计与进度。
  ipcMain.handle('agent:recipe:execute', async (event, payload: unknown) => {
    const tools = context.getTools();
    const bus = context.getBus();
    let recipeId = '';
    if (!tools || !bus) {
      return {
        ok: false,
        code: 'AGENT_UNAVAILABLE',
        recipeId,
        recipeTitle: '',
        runId: '',
        results: [],
        completed: [],
        kept: [],
        skipped: [],
        totalMs: 0,
        summary: '智能体服务尚未启动',
        report: '智能体服务尚未启动，未执行任何步骤。',
        error: { code: 'AGENT_UNAVAILABLE', message: '智能体服务尚未启动' }
      };
    }

    let ctx: RecipeContext = {};
    let skipSteps: string[] = [];
    let rememberSameKind = false;
    try {
      if (typeof payload !== 'object' || payload === null) throw new Error('流程参数必须是对象');
      const source = payload as Record<string, unknown>;
      recipeId = typeof source.recipeId === 'string' ? source.recipeId.trim() : '';
      if (!recipeId) throw new Error('缺少 recipeId');
      if (source.context !== undefined) {
        if (typeof source.context !== 'object' || source.context === null || Array.isArray(source.context)) {
          throw new Error('context 必须是对象');
        }
        ctx = { ...(source.context as Record<string, unknown>) } as RecipeContext;
      }
      skipSteps = Array.isArray(source.skipSteps)
        ? source.skipSteps.filter((value): value is string => typeof value === 'string')
        : [];
      rememberSameKind = source.rememberSameKind === true;
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_ARGUMENT',
        recipeId,
        recipeTitle: '',
        runId: '',
        results: [],
        completed: [],
        kept: [],
        skipped: [],
        totalMs: 0,
        summary: `流程参数无效：${error instanceof Error ? error.message : String(error)}`,
        report: `流程参数无效：${error instanceof Error ? error.message : String(error)}`,
        error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) }
      };
    }

    if (Object.keys(ctx).length === 0) {
      try {
        const project = await bus.execute('get_project_context');
        if (project.ok) {
          ctx = { ...collectAgentContext({ projectContext: () => project.data }) } as RecipeContext;
        }
      } catch {
        ctx = {};
      }
    }
    if (!Array.isArray(ctx.bom)) {
      try {
        const bom = await bus.execute('get_bom');
        if (bom.ok && Array.isArray(bom.data)) ctx.bom = bom.data;
      } catch (error) {
        // BOM 只影响成本流程前置条件；读取失败时让前置条件如实拦截。
        console.warn(`[COST_BOM_PRECHECK_READ_FAILED]`, { site: 'desktop/electron/ipc.ts:1155' }, error);
      }
    }

    const audit = createAuditLog({ write: agentAuditWriter() });
    let confirmCount = 0;
    const controller = new AbortController();
    activeRecipe = controller;
    const emitProgress = (progress: RecipeProgressEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
    };
    const result = await runRecipe(recipeId, ctx, {
      signal: controller.signal,
      skipSteps,
      rememberSameKind,
      onProgress: emitProgress,
      confirm: async (request) => {
        confirmCount += 1;
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const detail = `${request.tool} ${JSON.stringify(request.args)}`;
        const response = await dialog.showMessageBox(window, {
          type: 'question',
          title: '流程写操作确认',
          message: request.message,
          detail: detail.length > 1200 ? `${detail.slice(0, 1200)}…` : detail,
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return response.response === 0;
      },
      execute: async (step, _index, signal) => {
        const stepStarted = Date.now();
        const outcome = await tools.call(step.tool, step.args, signal);
        const record = typeof outcome === 'object' && outcome !== null
          ? outcome as Record<string, unknown>
          : null;
        const ok = record ? record.ok !== false : true;
        const code = record && typeof record.code === 'string'
          ? record.code
          : record && typeof record.error === 'object' && record.error !== null && typeof (record.error as Record<string, unknown>).code === 'string'
            ? String((record.error as Record<string, unknown>).code)
            : undefined;
        audit.record({
          tool: step.tool,
          ok,
          source: 'recipe',
          args: step.args,
          elapsedMs: Math.max(0, Date.now() - stepStarted),
          ...(code ? { code } : {})
        });
        return outcome;
      }
    });
    if (activeRecipe === controller) activeRecipe = null;
    return { ...result, confirmations: confirmCount };
  });

  ipcMain.handle('agent:chat:cancel', () => {
    if (!activeChat) return { ok: true, cancelled: false, message: '当前没有执行中的对话' };
    activeChat.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:plan:cancel', () => {
    if (!activePlan) return { ok: true, cancelled: false, message: '当前没有执行中的计划' };
    activePlan.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:recipe:cancel', () => {
    if (!activeRecipe) return { ok: true, cancelled: false, message: '当前没有执行中的流程' };
    activeRecipe.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:chat:send', async (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, message: '请输入要发送给智能体的内容', tokens: session?.usage() ?? emptyAgentUsage(), messages: session?.history() ?? [] };
    }
    if (text.length > 20_000) {
      return { ok: false, message: '消息过长，请控制在 20000 字以内', tokens: session?.usage() ?? emptyAgentUsage(), messages: session?.history() ?? [] };
    }
    try {
      const current = getSession();
      const started = Date.now();
      const controller = new AbortController();
      activeChat = controller;
      const runId = `chat-${started}-${Math.random().toString(36).slice(2, 8)}`;
      const emitProgress = (progress: AgentProgressEvent): void => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
      };
      const reply = await current.run(text, {
        signal: controller.signal,
        onProgress: emitProgress,
        runId
      });
      if (activeChat === controller) activeChat = null;
      return {
        ok: true,
        reply,
        mode: current.mode(),
        elapsedMs: Math.max(0, Date.now() - started),
        tokens: current.usage(),
        messages: current.history()
      };
    } catch (error) {
      if (activeChat) {
        activeChat = null;
      }
      if (error instanceof AgentCancelledError) {
        return {
          ok: false,
          cancelled: true,
          message: error.message,
          completedSteps: error.completedSteps,
          elapsedMs: 0,
          tokens: session?.usage() ?? emptyAgentUsage(),
          messages: session?.history() ?? []
        };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        tokens: session?.usage() ?? emptyAgentUsage(),
        messages: session?.history() ?? []
      };
    }
  });
}
