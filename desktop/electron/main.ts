import { loadMachineLinkage } from './machine-linkage.ts';
import { killActiveQt, launchQt } from './qt-client.ts';
import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  registerIpcHandlers,
  registerAgentChatIpc,
  CAD_EXTENSIONS,
  renderAssemblyReportPdf,
  renderCostReportPdf,
  disposeIpcRuntime,
  beginQtLaunchWindow
} from './ipc';
import { isTrustedUiUrl } from './security.ts';
import { PackRegistry } from '../src/packs/registry';
import { validatePackCatalog } from '../src/packs/validate';
import { AgentTools } from '../src/agent/tools';
import { planReadOnly, planTool, routeIntent } from '../src/agent/router';
import { executePlan, plan } from '../src/agent/planner';
import { AgentThread, formatThreadContext, projectFingerprint, runPlan } from '../src/agent/thread';
import {
  createPlanCheckpoint,
  inspectPlanCheckpoint,
  loadPlanCheckpoint,
  savePlanCheckpoint,
  updatePlanCheckpoint
} from '../src/agent/plan-checkpoint';
import { RECIPES, runRecipe } from '../src/agent/recipes';
import {
  buildAgentContext,
  collectAgentContext,
  emptyAgentContext,
  serializeAgentContext
} from '../src/agent/context';
import { resolveReference } from '../src/agent/reference';
import { trimListResult } from '../src/agent/trim';
import { estimateTokens, pack } from '../src/agent/budget';
import { createAuditLog, formatAuditLine, parseAuditLines, type AgentAuditRecord } from '../src/agent/audit';
import { AgentCancelledError, AgentSession } from '../src/agent/session';
import { requestWriteConfirmation } from './write-confirm.ts';
import { TurnCallDeduper } from '../src/agent/dedupe';
import { runReadOnlyBatch } from '../src/agent/parallel';
import { ToolResultCache } from '../src/agent/cache';
import { BYPASS_CONFIRMATION_NOTICE, detectBypassIntent } from '../src/agent/policy';
import { suggestFailure } from '../src/agent/suggest';
import { suggestNextActions } from '../src/agent/advisor';
import { KB_STATS } from '../src/agent/kb/search';
import { repairToolCall } from '../src/agent/repair';
import {
  AgentRpcServer,
  loadOrCreateAgentTokenFile,
  restartAgentServer,
  rotateAgentToken,
  type AgentRpcInfo
} from '../src/agent/rpc';
import type { AgentLanAccessView } from './ipc';
import { createAuditFileWriter, loadAuditRetention } from '../src/agent/audit-store';
import {
  isAddressAllowed,
  lanHost,
  readLanConfig,
  writeLanConfig,
  type LanConfig
} from '../src/shared/lan-access.ts';
import {
  isCdpForwarderActive,
  startCdpForwarder,
  stopCdpForwarder
} from './cdp-forwarder.ts';
import {
  describeRenderStats,
  normalizeRenderStats,
  type RenderStats
} from '../src/shared/render-stats.ts';
import { RendererBridge, createAgentCommandBus, type CommandBus } from '../src/agent/commands';
import { buildDesignPackage, parseDesignPackage } from '../src/sync/package';
import { describeCheck, runElectricalCheck } from '../src/elec/check';
import { computeCost, type CostInput } from '../src/cost/engine';
import { isUsablePricebookItem, validatePricebook } from '../src/cost/pricebook';
import { DEFAULT_MACHINE_PRICING, estimateCost } from '../src/machine/cost-model';
import type { ComponentPart } from '../src/shared/types';
import { planExportName } from '../src/cost/export';
import { demoMachineConfig, type ActuatorConfig, type SensorConfig } from '../src/commission/machine-config';
import { buildMachineIoMap } from '../src/machine/io-map';
import { PLCGEN_VERSION } from '../src/plcgen/st';
import { parseMachineBrief } from '../src/machine/spec';
import { TEMPLATES } from '../src/machine/templates';
import { buildClarify } from '../src/machine/clarify';
import { evaluateFlow, type FlowModel } from '../src/machine/flow';
import { MACHINE_FORMS, pickForm, validateMachineForms } from '../src/machine/forms';
import { generateSt } from '../src/plcgen/st';
import { generateProject } from '../src/plcgen/generate';
import { verifyGenerated } from '../src/plcgen/verify';
import { ParametricManager } from './parametric.ts';
import { FreecadRunner, resolveTechdrawScript } from './freecad.ts';
import { DrawingsService } from './drawings-service.ts';
import { readFreecadSettings, registerDrawingsIpc, svgToPdfWithElectron } from './drawings-ipc.ts';
import { projectsRoot } from './projects.ts';
import { PARAMETRIC_IMPORT_MODULE_ID } from '../src/modules/parametric-gate.ts';
import {
  assertUpdateIpcAuthorization,
  assertUpdateModuleEnabled,
  hasTrustedUpdateConfig,
  UpdateChannelService,
  type UpdateChannel
} from './update-service.ts';
import { captureProductScreenshots } from './screenshots';
import { captureMachineScreenshots, captureDesignWizardScreenshots } from './machine-screenshots';
import { writeLastCrash } from './crash-report.ts';
import { collectDiagnosis } from './diagnostics.ts';
import {
  buildDiagnosisReport,
  currentDiagnosticOperation,
  recentDiagnosticErrors,
  recordDiagnosticError,
  setDiagnosticOperation
} from '../src/shared/diagnostics.ts';

const HEADLESS_SMOKE = process.argv.includes('--headless-smoke');
const DIAGNOSE = process.argv.includes('--diagnose');
const HEADLESS_SCREENSHOTS = process.argv.includes('--headless-screenshots');
const HEADLESS_MACHINE_SCREENSHOTS = process.argv.includes('--headless-machine-screenshots');
/** 整机设计向导分步截图（不依赖模型桩） */
const HEADLESS_WIZARD_SHOTS = process.argv.includes('--headless-wizard-shots');
const HEADLESS_DESIGN_WEBGL_SMOKE = process.argv.includes('--headless-design-webgl-smoke');
/** 只起服务、跑外部客户端 smoke（MCP/JSON-RPC 契约）：不跑 UI 断言、不自动退出，等外部脚本杀。 */
const HEADLESS_SERVICE = process.argv.includes('--headless-service');
const HEADLESS = HEADLESS_SMOKE || HEADLESS_SCREENSHOTS || HEADLESS_MACHINE_SCREENSHOTS ||
  HEADLESS_WIZARD_SHOTS || HEADLESS_DESIGN_WEBGL_SMOKE || HEADLESS_SERVICE;
if (HEADLESS_SMOKE && HEADLESS_DESIGN_WEBGL_SMOKE) {
  console.error('SMOKE_MODE_CONFLICT --headless-smoke disables WebGL; use --headless-design-webgl-smoke alone for SwiftShader');
  process.exit(1);
}
const APP_NAME = 'AutomationCAD';
app.setName(APP_NAME);

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (HEADLESS_SMOKE) {
  app.disableHardwareAcceleration();
  // CI 的 xvfb 环境没有 GPU；显式关闭 WebGL 以稳定覆盖降级面板路径。
  app.commandLine.appendSwitch('disable-webgl');
}
if (HEADLESS_MACHINE_SCREENSHOTS) {
  // xvfb 无硬件 GPU；用 SwiftShader 软件渲染，确保 3D 联调截图来自真实 WebGL 场景。
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}
if (HEADLESS_DESIGN_WEBGL_SMOKE) {
  // 与降级 smoke 分离：不禁用硬件加速/WebGL，强制 Chromium 走 SwiftShader WebGL。
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
if (HEADLESS) {
  // 避免与开发机上正在运行的实例争抢单实例锁。
  const fixedUserData = HEADLESS_SERVICE ? process.env.AUTOMATIONCAD_SERVICE_USERDATA : '';
  const prefix = HEADLESS_DESIGN_WEBGL_SMOKE
    ? 'automationcad-design-webgl-smoke-'
    : HEADLESS_MACHINE_SCREENSHOTS
    ? 'automationcad-machine-shots-'
    : HEADLESS_SCREENSHOTS
      ? 'automationcad-shots-'
      : 'automationcad-smoke-';
  app.setPath('userData', fixedUserData && fixedUserData.trim() ? fixedUserData : mkdtempSync(join(tmpdir(), prefix)));
}

const CDP_INTERNAL_PORT = 9229;
const CDP_EXTERNAL_PORT = 9222;
const BOOT_LAN_CONFIG = readLanConfig(app.getPath('userData'));
if (!HEADLESS && !DIAGNOSE) {
  // 内部调试器始终只绑回环，便于运行中热启停转发器；对外 9222 仍由 cdp-forwarder 白名单控制。
  // Electron 会忽略 remote-debugging-address，因此不再设置该开关。
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_INTERNAL_PORT));
}

if (DIAGNOSE) {
  void runDiagnoseMode();
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    void bootstrap();
  }
}

let mainWindow: BrowserWindow | null = null;
let packRegistry: PackRegistry | null = null;
let agentServer: AgentRpcServer | null = null;
let agentTools: AgentTools | null = null;
let commandBus: CommandBus | null = null;
let parametric: ParametricManager | null = null;
let parametricImportModuleEnabled = false;
let freecadRunner: FreecadRunner | null = null;
let drawingsModuleEnabled = false;
let freecadConfiguredPath: string | null = null;
let plcgenModuleEnabled = false;
let elecValidationModuleEnabled = false;
let costEstimationModuleEnabled = false;
let factoryPlcSyncModuleEnabled = false;
let agentResumeModuleEnabled = false;
let projectPortableModuleEnabled = false;
let systemUpdateModuleEnabled = false;
let agentInfo: (AgentRpcInfo & { toolCount: number }) | { error: string } = { error: 'Agent 服务尚未启动' };
let agentToken = '';
let agentTokenFile = '';
let lanConfig: LanConfig = BOOT_LAN_CONFIG;
let lastRenderStats: RenderStats | null = null;
let cdpForwarderError: string | null = null;
let writeAgentAudit: ((record: AgentAuditRecord) => void) | null = null;

let crashHandlersInstalled = false;

function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  const userData = app.getPath('userData');
  const capture = (error: unknown, code: string): void => {
    try {
      const report = writeLastCrash(userData, {
        error,
        operation: currentDiagnosticOperation(),
        code,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        nodeVersion: process.versions.node,
        platform: process.platform
      });
      console.error(`[crash] ${report.code} operation=${report.operation} saved=${join(userData, 'diagnostics', 'last-crash.json')}`);
    } catch (writeError) {
      console.error('[crash] last-crash.json 写入失败', writeError instanceof Error ? writeError.message : String(writeError));
    }
  };
  process.on('uncaughtException', (error) => {
    capture(error, 'UNCAUGHT_EXCEPTION');
    if (app.isReady()) app.exit(1);
    else setTimeout(() => process.exit(1), 50);
  });
  process.on('unhandledRejection', (reason) => {
    capture(reason, 'UNHANDLED_REJECTION');
    recordDiagnosticError('UNHANDLED_REJECTION', reason);
  });
  app.on('child-process-gone', (_event, details) => {
    capture(new Error(`子进程退出：${details.type} ${details.reason}`), 'CHILD_PROCESS_GONE');
  });
}

async function runDiagnoseMode(): Promise<void> {
  try {
    await app.whenReady();
    installCrashHandlers();
    setDiagnosticOperation('diagnose');
    const userDataPath = app.getPath('userData');
    const report = await collectDiagnosis({
      appVersion: app.getVersion(),
      userDataPath,
      builtinDir: builtinPacksDir(),
      auditPath: join(userDataPath, 'agent-audit.jsonl')
    });
    console.log(`DIAGNOSE_OK fields=app,webgl,userDataPath,dataPack,packMetrics,packStats,kb,audit,recentErrors errors=${report.recentErrors.length}`);
    console.log(JSON.stringify(report, null, 2));
    app.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`DIAGNOSE_FAIL ${message.replace(/\bsk-[A-Za-z0-9_-]{4}[A-Za-z0-9_-]*/g, 'sk-****')}`);
    app.exit(1);
  }
}

function publicAgentInfo(): unknown {
  if ('error' in agentInfo) return agentInfo;
  const tools = agentTools?.summaries().map(({ name, description }) => ({ name, description })) ?? [];
  return {
    ...agentInfo,
    token: agentToken,
    lanEnabled: lanConfig.enabled,
    allowlist: [...lanConfig.allowlist],
    cdpPort: cdpActive() ? CDP_EXTERNAL_PORT : null,
    cdpActive: cdpActive(),
    cdpRestartRequired: lanConfig.cdpEnabled && !cdpActive(),
    lanAddress: localLanAddress(),
    toolCount: tools.length,
    tools,
    history: commandBus?.history().slice(-5) ?? []
  };
}

function cdpActive(): boolean {
  return isCdpForwarderActive();
}

/** 面板展示的内网地址：取第一个非回环 IPv4，优先常见私网段。 */
function localLanAddress(): string | null {
  const candidates: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4') continue;
      candidates.push(entry.address);
    }
  }
  const isPrivate = (address: string): boolean => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

function currentAgentInfo(): AgentRpcInfo & { toolCount?: number } {
  if (!('error' in agentInfo)) return agentInfo;
  const host = lanHost(lanConfig);
  const port = HEADLESS ? 0 : 7420;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    ...(agentTokenFile ? { tokenFile: agentTokenFile } : {}),
    ...(agentTools ? { toolCount: agentTools.list().length } : {})
  };
}

function agentLanView(ok: boolean, message?: string): AgentLanAccessView {
  const info = currentAgentInfo();
  return {
    ok,
    config: { ...lanConfig, allowlist: [...lanConfig.allowlist] },
    token: agentToken,
    info,
    cdpPort: cdpActive() || lanConfig.cdpEnabled ? CDP_EXTERNAL_PORT : null,
    cdpActive: cdpActive(),
    cdpRestartRequired: lanConfig.cdpEnabled && !cdpActive(),
    lanAddress: localLanAddress(),
    ...(cdpForwarderError ? { cdpError: cdpForwarderError } : {}),
    ...(message ? { message } : {})
  };
}

function getAgentLanAccess(): AgentLanAccessView {
  return agentLanView(true);
}

async function configureCdpForwarder(config: LanConfig): Promise<string | null> {
  cdpForwarderError = null;
  if (!config.enabled || !config.cdpEnabled) {
    await stopCdpForwarder();
    return null;
  }
  try {
    await startCdpForwarder({
      listenHost: '0.0.0.0',
      listenPort: CDP_EXTERNAL_PORT,
      targetHost: '127.0.0.1',
      targetPort: CDP_INTERNAL_PORT,
      allowlist: config.allowlist,
      onDenied: (remoteAddress) => {
        writeAgentAudit?.({
          tool: 'cdp_access_check',
          ok: false,
          code: 'LAN_NOT_ALLOWED',
          source: 'rpc',
          args: { port: CDP_EXTERNAL_PORT, targetPort: CDP_INTERNAL_PORT },
          message: `CDP 来源地址不在白名单：${remoteAddress || '(未知)'}`,
          remoteAddress,
          origin: 'lan'
        });
      },
      resolveRemoteAddress: (address) => address
    });
    return null;
  } catch (error) {
    cdpForwarderError = error instanceof Error ? error.message : String(error);
    console.error(`[cdp] ${cdpForwarderError}`);
    return cdpForwarderError;
  }
}

async function saveAgentLanAccess(patch: unknown): Promise<AgentLanAccessView> {
  try {
    const source = typeof patch === 'object' && patch !== null && !Array.isArray(patch)
      ? patch as Record<string, unknown>
      : {};
    const saved = writeLanConfig(app.getPath('userData'), {
      enabled: source.enabled === undefined ? lanConfig.enabled : source.enabled,
      allowlist: source.allowlist === undefined ? lanConfig.allowlist : source.allowlist,
      cdpEnabled: source.cdpEnabled === undefined ? lanConfig.cdpEnabled : source.cdpEnabled
    });
    lanConfig = saved;
    const cdpError = await configureCdpForwarder(saved);
    if (!agentServer || !agentTools) {
      return agentLanView(false, `Agent 服务尚未启动，配置已保存但无法立即重启监听。${cdpError ? `；${cdpError}` : ''}`);
    }
    const info = await restartAgentServer(agentServer, lanHost(saved), {
      lanEnabled: saved.enabled,
      allowlist: saved.allowlist,
      cdpPort: cdpActive() ? CDP_EXTERNAL_PORT : null
    });
    agentInfo = { ...info, toolCount: agentTools.list().length };
    const cdpMessage = cdpError
      ? `；CDP 启动失败：${cdpError}`
      : saved.cdpEnabled && saved.enabled
        ? cdpActive()
          ? `；CDP 已转发 0.0.0.0:${CDP_EXTERNAL_PORT} → 127.0.0.1:${CDP_INTERNAL_PORT}。`
          : `；CDP 转发器已启动，但内部 ${CDP_INTERNAL_PORT} 未监听；请确认应用以普通模式启动。`
        : '；CDP 已关闭。';
    const message = `已保存并重启 Agent（${info.host}:${info.port}）${cdpMessage}`;
    return agentLanView(true, message);
  } catch (error) {
    return agentLanView(false, error instanceof Error ? error.message : String(error));
  }
}

async function rotateAgentTokenAndRestart(): Promise<AgentLanAccessView> {
  try {
    if (!agentServer || !agentTools) {
      return agentLanView(false, 'Agent 服务尚未启动，无法轮换 token。');
    }
    const { token, tokenFile } = rotateAgentToken(app.getPath('userData'));
    agentToken = token;
    agentTokenFile = tokenFile;
    agentServer.setToken(token);
    const info = await restartAgentServer(agentServer, lanHost(lanConfig), {
      lanEnabled: lanConfig.enabled,
      allowlist: lanConfig.allowlist,
      cdpPort: cdpActive() ? CDP_EXTERNAL_PORT : null
    });
    agentInfo = { ...info, toolCount: agentTools.list().length };
    return agentLanView(true, '已重新生成 token；旧 token 立即失效，已连接客户端需重新配置。');
  } catch (error) {
    return agentLanView(false, `重新生成 token 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordRenderStats(value: unknown): { ok: boolean; message?: string } {
  const stats = normalizeRenderStats(value);
  if (!stats) return { ok: false, message: '渲染指标格式无效' };
  lastRenderStats = stats;
  return { ok: true };
}

function desktopRoot(): string {
  return resolve(__dirname, '..');
}

function indexHtmlPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web', 'index.html')
    : resolve(desktopRoot(), '..', 'index.html');
}

function extensionPath(): string {
  return join(app.getAppPath(), 'dist', 'extension.js');
}

function extensionBaseUrl(): string {
  return pathToFileURL(join(app.getAppPath(), 'dist') + '/').href;
}

function readDiagnosticPackVersion(): string {
  const directory = builtinPacksDir();
  if (!existsSync(directory)) return 'missing';
  const versions: string[] = [];
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const file = join(directory, name, 'manifest.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown; version?: unknown };
      versions.push(`${typeof parsed.id === 'string' ? parsed.id : name}@${typeof parsed.version === 'string' ? parsed.version : 'unknown'}`);
    } catch (error) {
      recordDiagnosticError('DIAGNOSE_PACK_READ_FAILED', error, { pack: name });
    }
  }
  return versions.length > 0 ? versions.join(', ') : 'none';
}

function readBuiltinPackVersionsFromDir(): number {
  const directory = builtinPacksDir();
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'manifest.json')))
    .length;
}

function builtinPacksDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'packs', 'builtin')
    : resolve(desktopRoot(), '..', 'packs', 'builtin');
}

/** Agent 工具 `run_cost_report` 的内置价格簿来源；与 `cost:pricebook` IPC 读同一份文件。 */
function readBuiltinPricebookRaw(): unknown {
  const pricebookPath = join(builtinPacksDir(), 'pricebook-cn', 'pricebook.json');
  if (!existsSync(pricebookPath)) throw new Error(`内置价格簿缺失：${pricebookPath}`);
  return JSON.parse(readFileSync(pricebookPath, 'utf8')) as unknown;
}

function userPacksDir(): string {
  return join(app.getPath('userData'), 'packs');
}

async function runParametricSmoke(window: BrowserWindow): Promise<void> {
  const fixture = resolve(desktopRoot(), 'test', 'fixtures', 'cube.stp');
  const moduleGate = await window.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const registry = window.__ModuleRegistry;
      const api = window.desktop?.parametric;
      const ui = window.AutomationCadParametric;
      const viewer = window.AutomationCadViewer;
      if (!registry || !api || !ui || !viewer) return { error: '模块/参数化/CAD API 缺失' };
      const moduleId = 'cad.parametric-import';
      const historyModuleId = 'parametric.history';
      if (!registry.getStatus(moduleId)?.enabled) return { error: '参数化模块默认未启用' };
      if (!registry.getStatus(historyModuleId)?.enabled) return { error: '参数化 history 模块默认未启用' };
      const treeKey = 'automationcad.parametric.v1';
      const previousTree = localStorage.getItem(treeKey);
      const savedTree = JSON.stringify({ version: 1, buckets: { 'fixture.step': { features: [{ id: 'saved-feature' }] } } });
      localStorage.setItem(treeKey, savedTree);
      registry.setEnabled(moduleId, false);
      const historyUnavailable = registry.getStatus(historyModuleId)?.status === 'unavailable';
      let historyEnableRejected = false;
      try { registry.setEnabled(historyModuleId, true); }
      catch { historyEnableRejected = true; }
      const button = document.querySelector('[data-cad-action="parametric"]');
      const hidden = button?.hidden === true && getComputedStyle(button).display === 'none';
      const status = await api.status();
      const start = await api.start();
      const build = await api.build({ schemaVersion: 1, updatedAt: '2026-10-24T00:00:00Z', features: [] });
      const uiBuild = await ui.build();
      ui.open();
      let editRejected = false;
      try { ui.setDoc({ schemaVersion: 1, updatedAt: '2026-10-24T00:00:00Z', features: [] }); }
      catch (error) { editRejected = /已关闭/.test(String(error?.message || error)); }
      const drawer = document.getElementById('cadParametricDrawer');
      const cadStats = await viewer.inspectPath(${JSON.stringify(fixture)});
      await viewer.importPath(${JSON.stringify(fixture)});
      const treePreserved = localStorage.getItem(treeKey) === savedTree;
      registry.setEnabled(moduleId, true);
      await wait(30);
      const restored = button?.hidden === false;
      const historyRestored = registry.getStatus(historyModuleId)?.enabled === true;
      const managerStatus = await api.status();
      if (previousTree === null) localStorage.removeItem(treeKey);
      else localStorage.setItem(treeKey, previousTree);
      return {
        hidden, status, start, build, uiBuild, editRejected,
        drawerHidden: !drawer || (drawer.hidden && getComputedStyle(drawer).display === 'none'),
        cadReadable: cadStats?.triangleCount === 12 && cadStats?.meshCount === 1,
        treePreserved, restored, managerStatus, historyUnavailable, historyEnableRejected, historyRestored
      };
    })()`
  ) as {
    error?: string; hidden: boolean; status: { status: string }; start: { ok: boolean; code?: string };
    build: { ok: boolean; code?: string }; uiBuild: { ok: boolean; code?: string };
    editRejected: boolean; drawerHidden: boolean; cadReadable: boolean; treePreserved: boolean;
    restored: boolean; managerStatus: { status: string };
    historyUnavailable: boolean; historyEnableRejected: boolean; historyRestored: boolean;
  };
  if (moduleGate.error || !moduleGate.hidden || moduleGate.status.status !== 'unavailable' ||
      moduleGate.start.ok || moduleGate.start.code !== 'MODULE_DISABLED' ||
      moduleGate.build.ok || moduleGate.build.code !== 'MODULE_DISABLED' ||
      moduleGate.uiBuild.ok || moduleGate.uiBuild.code !== 'MODULE_DISABLED' ||
      !moduleGate.editRejected || !moduleGate.drawerHidden || !moduleGate.cadReadable ||
      !moduleGate.treePreserved || !moduleGate.restored || moduleGate.managerStatus.status !== 'stopped' ||
      !moduleGate.historyUnavailable || !moduleGate.historyEnableRejected || !moduleGate.historyRestored) {
    throw new Error(`参数化模块关闭闭锁 smoke 失败：${JSON.stringify(moduleGate)}`);
  }
  console.log('SMOKE_PARAMETRIC_MODULE_GATE_OK ipc=blocked ui=hidden-restored cad=readable tree=preserved history=dependency-gated sidecar=stopped');
  try {
    const historyUi = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const registry = window.__ModuleRegistry;
        const ui = window.AutomationCadParametric;
        const moduleId = 'parametric.history';
        const treeKey = 'automationcad.parametric.v1';
        if (!registry || !ui || !registry.getStatus(moduleId)?.enabled) return { error: 'history module/API 未就绪' };
        const previousTree = localStorage.getItem(treeKey);
        try {
          ui.open();
          await wait(80);
          const auto = document.querySelector('[data-param-auto]');
          const addType = document.querySelector('[data-param-add-type]');
          const addButton = document.querySelector('[data-param-add]');
          const undoButton = document.querySelector('[data-param-undo]');
          const redoButton = document.querySelector('[data-param-redo]');
          if (!auto || !addType || !addButton || !undoButton || !redoButton) return { error: 'history/edit 控件缺失' };
          auto.checked = false;
          auto.dispatchEvent(new Event('change', { bubbles: true }));
          ui.setDoc({
            schemaVersion: 2,
            updatedAt: '2026-10-24T00:00:00Z',
            instances: [{
              id: 'p1', name: 'History smoke', transform: { x: 0, y: 0, z: 0, rz: 0 },
              features: [{ id: 'f1', type: 'box', name: 'Base', params: { length: 100, width: 60, height: 8 } }]
            }]
          });
          addType.value = 'box';
          addButton.click();
          const addedCount = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;
          const undoCreatedRedo = ui.undo();
          const docBeforeToggle = JSON.stringify(ui.getDoc());
          const storedBeforeToggle = localStorage.getItem(treeKey);
          const historyBeforeToggle = ui.historyState();
          const overlayBeforeToggle = ui.state().overlayVisible;
          registry.setEnabled(moduleId, false);
          await wait(20);
          const hidden = undoButton.hidden && redoButton.hidden;
          const disabled = undoButton.disabled && redoButton.disabled;
          const apiUndo = ui.undo();
          const apiRedo = ui.redo();
          undoButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          redoButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const docAfterBlockedCalls = JSON.stringify(ui.getDoc());
          const storedAfterBlockedCalls = localStorage.getItem(treeKey);
          const historyWhileDisabled = ui.historyState();
          const overlayAfterToggle = ui.state().overlayVisible;
          const noMutation = docAfterBlockedCalls === docBeforeToggle &&
            storedAfterBlockedCalls === storedBeforeToggle &&
            historyWhileDisabled.undoCount === historyBeforeToggle.undoCount &&
            historyWhileDisabled.redoCount === historyBeforeToggle.redoCount &&
            overlayAfterToggle === overlayBeforeToggle;

          registry.setEnabled(moduleId, true);
          await wait(20);
          const visibleAgain = !undoButton.hidden && !redoButton.hidden;
          const redoRestored = ui.redo();
          const restoredCount = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;

          registry.setEnabled(moduleId, false);
          await wait(20);
          addButton.click();
          const editWhileDisabled = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;
          const disabledHistoryAfterEdit = ui.historyState();
          registry.setEnabled(moduleId, true);
          await wait(20);
          const undoAfterResume = ui.undo();
          const resumedCount = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;
          const resumedState = ui.historyState();
          ui.close();
          return {
            addedCount, undoCreatedRedo, historyBeforeToggle, hidden, disabled, apiUndo, apiRedo, noMutation,
            historyWhileDisabled, visibleAgain, redoRestored, restoredCount,
            editWhileDisabled, disabledHistoryAfterEdit, undoAfterResume, resumedCount, resumedState
          };
        } finally {
          if (!registry.getStatus(moduleId)?.enabled) registry.setEnabled(moduleId, true);
          if (previousTree === null) localStorage.removeItem(treeKey);
          else localStorage.setItem(treeKey, previousTree);
        }
      })()`
    ) as {
      error?: string;
      addedCount?: number; undoCreatedRedo?: boolean;
      historyBeforeToggle?: { enabled: boolean; undoCount: number; redoCount: number };
      hidden?: boolean; disabled?: boolean; apiUndo?: boolean; apiRedo?: boolean; noMutation?: boolean;
      historyWhileDisabled?: { enabled: boolean; undoCount: number; redoCount: number };
      visibleAgain?: boolean; redoRestored?: boolean; restoredCount?: number;
      editWhileDisabled?: number; disabledHistoryAfterEdit?: { enabled: boolean; undoCount: number; redoCount: number };
      undoAfterResume?: boolean; resumedCount?: number; resumedState?: { enabled: boolean; undoCount: number; redoCount: number };
    };
    if (historyUi.error || historyUi.addedCount !== 2 || !historyUi.undoCreatedRedo ||
        historyUi.historyBeforeToggle?.enabled !== true || historyUi.historyBeforeToggle.redoCount !== 1 ||
        !historyUi.hidden || !historyUi.disabled || historyUi.apiUndo !== false || historyUi.apiRedo !== false ||
        !historyUi.noMutation || historyUi.historyWhileDisabled?.enabled !== false ||
        historyUi.historyWhileDisabled.undoCount !== historyUi.historyBeforeToggle.undoCount ||
        historyUi.historyWhileDisabled.redoCount !== historyUi.historyBeforeToggle.redoCount ||
        !historyUi.visibleAgain || !historyUi.redoRestored || historyUi.restoredCount !== 2 ||
        historyUi.editWhileDisabled !== 3 || historyUi.disabledHistoryAfterEdit?.enabled !== false ||
        !historyUi.undoAfterResume || historyUi.resumedCount !== 2 || historyUi.resumedState?.enabled !== true) {
      throw new Error(`history UI toggle failed: ${JSON.stringify(historyUi)}`);
    }
    console.log('SMOKE_PARAMETRIC_HISTORY_GATE_OK controls=hidden api=blocked tree=preserved same-session=restored editing=available');
  } catch (error) {
    throw new Error(`参数化 history UI smoke 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!process.env.AUTOMATIONCAD_PARAMETRIC_CMD) {
    console.log('SMOKE_PARAMETRIC_SIDECAR_SKIP');
    console.log('SMOKE_PARAMETRIC_UI_SKIP');
    return;
  }
  try {
    const result = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const api = window.__Parametric;
        const ui = window.AutomationCadParametric;
        const button = document.querySelector('[data-cad-action="parametric"]');
        if (!api || !ui || !button) return { error: '参数化入口缺失' };
        button.click();
        let status = await api.status();
        const deadline = Date.now() + 6000;
        while (status.status === 'stopped' || status.status === 'starting') {
          if (Date.now() > deadline) break;
          await wait(50);
          status = await api.status();
        }
        const auto = document.querySelector('[data-param-auto]');
        if (auto) {
          auto.checked = false;
          auto.dispatchEvent(new Event('change', { bubbles: true }));
        }
        ui.setDoc({
          schemaVersion: 1,
          updatedAt: '2026-10-23T12:00:00+08:00',
          features: [
            { id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8 } },
            { id: 'f2', type: 'holes', name: '安装孔', params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] } }
          ]
        });
        const build = await ui.build();
        await wait(80);
        const state = ui.state();
        const drawer = document.getElementById('cadParametricDrawer');
        const rows = document.querySelectorAll('[data-param-feature]').length;
        const oldBuildStatus = document.querySelector('[data-param-build-status]')?.textContent || '';
        const assemblyDoc = {
          schemaVersion: 2,
          updatedAt: '2026-10-23T12:00:00+08:00',
          instances: [
            {
              id: 'p1', name: '底板 A', partId: 'BASE-01',
              transform: { x: 0, y: 0, z: 0, rz: 0 },
              features: [
                { id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8 } },
                { id: 'f2', type: 'holes', name: '安装孔', params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] } }
              ]
            },
            {
              id: 'p2', name: '顶板 B', partId: 'PLATE-02',
              transform: { x: 140, y: 0, z: 0, rz: 0 },
              features: [{ id: 'f1', type: 'box', name: '顶板', params: { length: 120, width: 80, height: 8 } }]
            },
            {
              id: 'p3', name: '支架', transform: { x: 0, y: 100, z: 0, rz: 30 },
              features: [{ id: 'f1', type: 'box', name: '支架', params: { length: 60, width: 40, height: 12 } }]
            }
          ]
        };
        ui.setDoc(assemblyDoc);
        const assemblyBuild = await ui.build();
        await wait(80);
        const assemblyState = ui.state();
        const lastSuccessfulAssembly = ui.getDoc();
        const instanceRows = document.querySelectorAll('[data-param-instance]').length;
        const bomRows = document.querySelectorAll('[data-param-bom-row]').length;
        const addType = document.querySelector('[data-param-add-type]');
        const undoButton = document.querySelector('[data-param-undo]');
        const redoButton = document.querySelector('[data-param-redo]');
        if (!addType || !undoButton || !redoButton) return { error: '撤销/重做控件缺失' };
        addType.value = 'box';
        document.querySelector('[data-param-add]')?.click();
        const addState = ui.getDoc();
        const length = document.querySelector('[data-param-form] [data-param-field="length"]');
        if (!length) return { error: '新增特征参数控件缺失' };
        length.value = '121';
        length.dispatchEvent(new Event('input', { bubbles: true }));
        length.value = '122';
        length.dispatchEvent(new Event('input', { bubbles: true }));
        const editedLength = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.at(-1)?.params.length;
        undoButton.click();
        const undoLength = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.at(-1)?.params.length;
        undoButton.click();
        const undoAddCount = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;
        redoButton.click();
        const redoAddCount = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.length;
        redoButton.click();
        const redoLength = ui.getDoc().instances.find((instance) => instance.id === 'p1')?.features.at(-1)?.params.length;
        const beforeFailure = ui.getDoc();
        const failingAssembly = JSON.parse(JSON.stringify(beforeFailure));
        failingAssembly.instances[0].features[0].params.length = 999;
        const overlayBeforeFailure = ui.state().overlayVisible;
        ui.setDoc(failingAssembly);
        const failedBuild = await ui.build();
        const recovered = ui.getDoc();
        const comparable = (value) => JSON.stringify({ ...value, updatedAt: '' });
        const failureRecovered = comparable(recovered) === comparable(lastSuccessfulAssembly);
        const overlayAfterFailure = ui.state().overlayVisible;
        return {
          button: true,
          status,
          build,
          state,
          rows,
          assemblyBuild,
          assemblyState,
          instanceRows,
          bomRows,
          drawerOpen: Boolean(drawer && !drawer.hidden),
          buildStatus: oldBuildStatus,
          history: {
            addFeatures: addState.instances.find((instance) => instance.id === 'p1')?.features.length,
            editedLength,
            undoLength,
            undoAddCount,
            redoAddCount,
            redoLength
          },
          failure: {
            ok: failedBuild.ok,
            recovered: failureRecovered,
            overlayBefore: overlayBeforeFailure,
            overlayAfter: overlayAfterFailure,
            overlayUnchanged: overlayBeforeFailure === overlayAfterFailure
          }
        };
      })()`
    ) as {
      error?: string;
      button?: boolean;
      status?: { status: string; message: string; version?: string };
      build?: { ok: boolean; stats?: { faces?: number }; message?: string };
      state?: { features: number; instances?: number; bomRows?: number; status: string; statusLabel: string; stlLoaded: boolean; ghost: boolean };
      rows?: number;
      assemblyBuild?: { ok: boolean; stats?: { solids?: number; instances?: unknown[] }; message?: string };
      assemblyState?: { features: number; instances?: number; bomRows?: number; status: string };
      instanceRows?: number;
      bomRows?: number;
      drawerOpen?: boolean;
      buildStatus?: string;
      history?: { addFeatures?: number; editedLength?: unknown; undoLength?: unknown; undoAddCount?: number; redoAddCount?: number; redoLength?: unknown };
      failure?: { ok?: boolean; recovered?: boolean; overlayBefore?: boolean; overlayAfter?: boolean; overlayUnchanged?: boolean };
    };
    if (result.error || !result.button || result.status?.status !== 'ready' || !result.status.version?.endsWith('-fake')) {
      throw new Error(`参数化入口状态异常：${JSON.stringify(result)}`);
    }
    if (!result.build?.ok || result.build.stats?.faces !== 19) {
      throw new Error(`参数化构建异常：${JSON.stringify(result.build)}`);
    }
    if (!result.drawerOpen || result.rows !== 2 || result.state?.features !== 2 ||
        result.state.status !== 'ready' || result.state.statusLabel !== '就绪' ||
        !result.buildStatus?.includes('面 19') ||
        !result.buildStatus?.includes('体积 71.5 cm³')) {
      throw new Error(`参数化 UI 异常：${JSON.stringify(result)}`);
    }
    console.log('SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1');
    console.log(`SMOKE_PARAMETRIC_UI_OK features=${result.state.features} status=${result.state.status}`);
    if (!result.assemblyBuild?.ok || result.assemblyBuild.stats?.solids !== 2 ||
        result.assemblyState?.instances !== 3 || result.assemblyState.bomRows !== 3 ||
        result.instanceRows !== 3 || result.bomRows !== 3) {
      throw new Error(`参数化装配异常：${JSON.stringify({
        build: result.assemblyBuild,
        state: result.assemblyState,
        instanceRows: result.instanceRows,
        bomRows: result.bomRows
      })}`);
    }
    console.log(`SMOKE_PARAMETRIC_ASSEMBLY_OK solids=${result.assemblyBuild.stats.solids} bomRows=${result.assemblyState.bomRows}`);
    if (result.history?.addFeatures !== 3 || result.history.editedLength !== 122 ||
        result.history.undoLength !== 120 || result.history.undoAddCount !== 2 ||
        result.history.redoAddCount !== 3 || result.history.redoLength !== 122) {
      throw new Error(`参数化撤销/重做异常：${JSON.stringify(result.history)}`);
    }
    if (result.failure?.ok !== false || result.failure.recovered !== true ||
        result.failure.overlayUnchanged !== true) {
      throw new Error(`参数化失败回退异常：${JSON.stringify(result.failure)}`);
    }
    console.log('SMOKE_PARAMETRIC_HISTORY_OK add=undo=redo mergedInput=1');
    console.log(`SMOKE_PARAMETRIC_RECOVERY_OK tree=last-success overlay=unchanged visible=${result.failure.overlayAfter}`);
  } finally {
    if (parametric) await parametric.stop();
  }
}

/**
 * drawings.techdraw：模块门控（无需 FreeCAD）+ 参数化抽屉里的工程图分区；
 * 同时设置 AUTOMATIONCAD_PARAMETRIC_CMD（假内核）与 AUTOMATIONCAD_FREECAD_CMD（假/真 freecadcmd）时再跑一次出图作业。
 */
async function runDrawingsSmoke(window: BrowserWindow): Promise<void> {
  const gate = await window.webContents.executeJavaScript(`(async () => {
    const registry = window.__ModuleRegistry;
    const api = window.desktop?.drawings;
    if (!registry || !api) return { error: '工程图 API 或模块注册表缺失' };
    const enabledBefore = registry.getStatus('drawings.techdraw').enabled;
    const status = await api.freecadStatus();
    registry.setEnabled('drawings.techdraw', false);
    const blockedGenerate = await api.generate({ projectKey: 'smoke', doc: { schemaVersion: 1, features: [], updatedAt: '2026-10-26T00:00:00Z' } });
    const blockedList = await api.list('smoke');
    registry.setEnabled('drawings.techdraw', true);
    const listed = await api.list('smoke');
    return {
      enabledBefore,
      statusOk: status.ok === true,
      blockedGenerate: blockedGenerate.code,
      blockedList: blockedList.code,
      reenabled: registry.getStatus('drawings.techdraw').enabled && listed.ok === true
    };
  })()`) as { error?: string; enabledBefore?: boolean; statusOk?: boolean; blockedGenerate?: string; blockedList?: string; reenabled?: boolean };
  if (gate.error || !gate.enabledBefore || !gate.statusOk || gate.blockedGenerate !== 'MODULE_DISABLED'
    || gate.blockedList !== 'MODULE_DISABLED' || !gate.reenabled) {
    throw new Error(`工程图模块门控异常：${JSON.stringify(gate)}`);
  }
  console.log('SMOKE_DRAWINGS_MODULE_GATE_OK default=enabled ipc=MODULE_DISABLED reenabled=true');
  if (!process.env.AUTOMATIONCAD_PARAMETRIC_CMD) {
    console.log('SMOKE_DRAWINGS_UI_SKIP');
    return;
  }
  const withJob = Boolean(process.env.AUTOMATIONCAD_FREECAD_CMD);
  try {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ui = window.AutomationCadParametric;
      const drawings = window.AutomationCadDrawings;
      if (!ui || !drawings) return { error: '参数化或工程图入口缺失' };
      ui.open();
      ui.setDoc({
        schemaVersion: 2,
        updatedAt: '2026-10-26T09:00:00Z',
        instances: [
          { id: 'p1', name: '转接板', partId: 'SMOKE-ADP', transform: { x: 0, y: 0, z: 0, rz: 0 },
            features: [{ id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8 } }] },
          { id: 'p2', name: '垫块', transform: { x: 200, y: 0, z: 0, rz: 0 },
            features: [{ id: 'f1', type: 'box', name: '垫块', params: { length: 40, width: 40, height: 10 } }] }
        ]
      });
      const section = document.querySelector('#cadParametricDrawer [data-drawings-section]');
      let state = drawings.state();
      for (let i = 0; i < 100 && state && !state.freecadReason; i += 1) { await wait(100); state = drawings.state(); }
      await wait(1700);
      state = drawings.state();
      const rows = document.querySelectorAll('#cadParametricDrawer [data-dwg-part]').length;
      const hint = document.querySelector('#cadParametricDrawer [data-dwg-hint]');
      let job = null;
      if (${withJob ? 'true' : 'false'} && state?.freecadAvailable) {
        const submitted = await drawings.generate('all');
        if (!submitted.ok) return { error: '出图提交失败：' + submitted.message };
        for (let i = 0; i < 300; i += 1) {
          await wait(100);
          const current = drawings.state();
          if (current?.job && ['succeeded', 'partial', 'failed', 'cancelled', 'timeout'].includes(current.job.state)) break;
        }
        await wait(1800);
        const after = drawings.state();
        job = { state: after?.job?.state, fresh: after?.fresh, parts: after?.parts };
      }
      return {
        section: Boolean(section),
        rows,
        available: Boolean(state?.freecadAvailable),
        hintShown: Boolean(hint && !hint.hidden),
        parts: state?.parts ?? 0,
        missing: state?.missing ?? 0,
        job
      };
    })()`) as { error?: string; section?: boolean; rows?: number; available?: boolean; hintShown?: boolean; parts?: number; missing?: number; job?: { state?: string; fresh?: number; parts?: number } | null };
    if (result.error || !result.section || result.rows !== 2 || result.parts !== 2) {
      throw new Error(`工程图分区异常：${JSON.stringify(result)}`);
    }
    if (!result.available && !result.hintShown) throw new Error(`FreeCAD 不可用但没有显示安装指引：${JSON.stringify(result)}`);
    console.log(`SMOKE_DRAWINGS_UI_OK rows=${result.rows} freecad=${result.available ? 'available' : 'unavailable+hint'} missing=${result.missing}`);
    if (withJob && result.available) {
      if (result.job?.state !== 'succeeded' || result.job.fresh !== 2) throw new Error(`工程图作业异常：${JSON.stringify(result.job)}`);
      console.log(`SMOKE_DRAWINGS_JOB_OK state=${result.job.state} fresh=${result.job.fresh}`);
    } else {
      console.log('SMOKE_DRAWINGS_JOB_SKIP');
    }
  } finally {
    if (parametric) await parametric.stop();
  }
}

async function runHeadlessDesignWebglSmoke(window: BrowserWindow): Promise<void> {
  try {
    const fixturePath = resolve(desktopRoot(), 'test', 'fixtures', 'cube.stp');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const bridgeReady = () => Boolean(window.__AgentBridge?.ready?.());
      for (let attempt = 0; attempt < 100 && !bridgeReady(); attempt += 1) await wait(50);
      if (!bridgeReady() || !window.desktop?.design || !window.desktop?.projects) {
        throw new Error('桌面工程 API / AgentBridge 未就绪');
      }
      const fixtureBytes = await window.desktop.readFileBuffer(${JSON.stringify(fixturePath)});
      const fixture = new File([fixtureBytes], 'cube.stp', { type: 'application/octet-stream' });
      const transfer = new DataTransfer();
      transfer.items.add(fixture);
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      let seedParts = 0;
      for (let attempt = 0; attempt < 120 && seedParts === 0; attempt += 1) {
        await wait(100);
        seedParts = window.__AgentBridge.getScene().parts?.length ?? 0;
      }
      if (seedParts < 1 || !document.getElementById('cadFileInfo')?.textContent?.includes('cube.stp')) {
        throw new Error('真实 CAD 拖放导入 fixture 未载入：' + JSON.stringify({ seedParts, fileInfo: document.getElementById('cadFileInfo')?.textContent ?? '' }));
      }
      await window.desktop.design.clearDraft();
      const entry = document.getElementById('designWizardEntry');
      if (!entry) throw new Error('五步设计向导入口缺失');
      entry.click();
      await wait(500);
      const root = document.getElementById('designWizard');
      if (!root || root.hidden) throw new Error('五步设计向导未打开');
      const next = () => {
        const button = root.querySelector('[data-action="next"]');
        if (!button || button.disabled) throw new Error('向导下一步不可用：' + root.querySelector('.design-content')?.textContent);
        button.click();
      };
      const set = (name, value) => {
        const field = root.querySelector('[name="' + name + '"]');
        if (!field) throw new Error('向导输入项缺失：' + name);
        field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('name', 'Smoke WebGL 工程');
      set('stations', '3');
      set('cyclePerMin', '10');
      set('lengthMm', '2400');
      set('widthMm', '1600');
      next();
      let candidateCount = 0;
      for (let attempt = 0; attempt < 80 && candidateCount === 0; attempt += 1) {
        await wait(100);
        candidateCount = root.querySelectorAll('[data-candidate]').length;
      }
      if (candidateCount !== 3) throw new Error('向导候选未生成：' + candidateCount);
      root.querySelector('[data-preview="0"]')?.click();
      await wait(80);
      root.querySelector('#designPreviewClose')?.click();
      next();
      await wait(120);
      const station = root.querySelectorAll('[data-station]')[2];
      if (!station) throw new Error('向导第三工位缺失');
      station.click();
      root.querySelector('[data-action="add-actuator"]')?.click();
      await wait(60);
      next();
      await wait(120);
      const placements = root.querySelectorAll('[data-placement]').length;
      if (placements < 1) throw new Error('向导没有生成可保存的 2D 布局');
      const layoutMetrics = root.querySelector('.design-layout-tools')?.textContent ?? '';
      const layoutSemantics = root.querySelector('.design-layout-semantics')?.textContent ?? '';
      if (!layoutMetrics.includes('示意卡片占画布比例') || layoutMetrics.includes('利用率') ||
          !layoutSemantics.includes('重叠矩形可能重复计入') ||
          !layoutSemantics.includes('不代表组件实际外形、安装包络或三维几何')) {
        throw new Error('向导布局文案未清楚区分示意卡片与物理尺寸：' + JSON.stringify({ layoutMetrics, layoutSemantics }));
      }
      next();
      await wait(100);
      root.querySelector('[data-action="run-review"]')?.click();
      await wait(180);
      const saveButton = root.querySelector('[data-action="save-project"]');
      if (!saveButton || saveButton.disabled) {
        throw new Error('设计工程未通过保存门槛：' + root.querySelector('.design-content')?.textContent);
      }
      saveButton.click();
      let saved = null;
      for (let attempt = 0; attempt < 80 && !saved; attempt += 1) {
        await wait(100);
        saved = (await window.desktop.projects.list()).find((project) => project.name === 'Smoke WebGL 工程') ?? null;
      }
      if (!saved?.id || !saved.design) throw new Error('向导工程未保存或缺少 design 数据');
      const openResult = await window.desktop.projects.open(saved.id);
      const partPaths = openResult?.partPaths?.length ?? 0;
      if (!openResult?.ok || partPaths < 1) throw new Error('projects:open IPC 未返回逐件 STL：' + (openResult?.message ?? partPaths));

      const menu = document.getElementById('cadProjectMenu');
      if (menu?.hidden) document.querySelector('[data-project-menu-toggle]')?.click();
      let projectRow = null;
      for (let attempt = 0; attempt < 50 && !projectRow; attempt += 1) {
        projectRow = [...document.querySelectorAll('[data-project-open]')].find((row) => row.dataset.projectOpen === saved.id) ?? null;
        if (!projectRow) await wait(100);
      }
      if (!projectRow) throw new Error('工程菜单未显示刚保存的工程');
      const layoutButton = projectRow.querySelector('[data-project-layout]');
      if (!layoutButton) throw new Error('工程菜单缺少已保存布局编辑入口');
      layoutButton.click();
      const layoutDialog = document.getElementById('cadSavedProjectLayout');
      for (let attempt = 0; attempt < 50 && !layoutDialog?.open; attempt += 1) await wait(50);
      if (!layoutDialog?.open) throw new Error('已保存工程布局编辑器未打开');
      const layoutEditorSemantics = layoutDialog.querySelector('.cad-project-layout-safety')?.textContent ?? '';
      if (!layoutEditorSemantics.includes('矩形宽高是示意卡片尺寸') ||
          !layoutEditorSemantics.includes('毫米坐标只表示二维预排布') ||
          !layoutEditorSemantics.includes('不代表组件实际外形、安装包络或三维几何')) {
        throw new Error('已保存工程布局编辑器缺少示意卡片/二维预排布说明：' + layoutEditorSemantics);
      }
      layoutDialog.querySelector('[data-project-layout-close]')?.click();
      for (let attempt = 0; attempt < 50 && layoutDialog.open; attempt += 1) await wait(50);
      if (menu?.hidden) document.querySelector('[data-project-menu-toggle]')?.click();
      projectRow = [...document.querySelectorAll('[data-project-open]')].find((row) => row.dataset.projectOpen === saved.id) ?? null;
      if (!projectRow) throw new Error('关闭布局编辑器后工程菜单未恢复');
      projectRow.click();

      let scene = { parts: [] };
      let treeRows = 0;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await wait(250);
        scene = window.__AgentBridge.getScene();
        treeRows = document.querySelectorAll('#cadParts .cad-part-row').length;
        if (scene?.parts?.length >= partPaths && treeRows >= partPaths) break;
      }
      const fallback = document.getElementById('cadWebglFallback');
      const canvas = document.querySelector('#cadHost canvas');
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? null;
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl
        ? String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
        : '';
      const notice = document.getElementById('cadNotice')?.textContent ?? '';
      const noticeIsError = Boolean(document.getElementById('cadNotice')?.classList.contains('is-error'));
      const menuMeta = projectRow.querySelector('.cad-project-meta')?.textContent ?? '';
      const partCount = Number(document.getElementById('cadPartCount')?.textContent ?? 0);
      if (fallback) throw new Error('SwiftShader WebGL 未启用，Viewer 进入降级视图：' + fallback.textContent);
      if (!gl || !/SwiftShader/i.test(renderer)) throw new Error('没有确认 SwiftShader WebGL context：' + JSON.stringify({ hasCanvas: Boolean(canvas), hasContext: Boolean(gl), renderer }));
      if (!scene?.parts?.length || scene.parts.length !== partPaths || treeRows !== scene.parts.length || partCount !== scene.parts.length) {
        throw new Error('工程重开后 scene / 零件树数量不一致：' + JSON.stringify({ scene: scene?.parts?.length ?? 0, partPaths, treeRows, partCount }));
      }
      if (!notice.includes('概念估算占位体') || !notice.includes('非型号级 CAD') || noticeIsError) {
        throw new Error('工程载入提示缺失或标为错误：' + JSON.stringify({ notice, noticeIsError }));
      }
      if (!menuMeta.includes('设计向导概念估算占位体')) throw new Error('工程菜单未标明概念估算占位体：' + menuMeta);

      // 占位盒必须按数据包外形建（有 WebGL 的路径才测得了）：插 → 量 bbox → 删
      const dimsCheck = await (async () => {
        const inserted = await window.__AgentBridge.insertComponent({
          id: 'iC65N-C16-1P',
          model: 'SMOKE-DIMS',
          category: '断路器',
          dimsMm: { w: 18, h: 85, d: 78.5 }
        });
        if (!inserted?.ok) return { ok: false, message: inserted?.message || 'insertComponent 失败' };
        const parts = window.__AgentBridge.getScene().parts || [];
        const part = parts.find((item) => item && item.name === 'SMOKE-DIMS');
        if (!part || !part.bbox) return { ok: false, message: '插入后 scene 里找不到 SMOKE-DIMS' };
        // bbox 有两种形状：数组 [x,y,z]（getSceneParts）或 {x,y,z}（three Box3 直出）
        const axis = (point, key, index) => Array.isArray(point) ? point[index] : point?.[key];
        const min = part.bbox.min ?? part.bbox[0];
        const max = part.bbox.max ?? part.bbox[1];
        const size = {
          w: Math.abs(axis(max, 'x', 0) - axis(min, 'x', 0)),
          h: Math.abs(axis(max, 'y', 1) - axis(min, 'y', 1)),
          d: Math.abs(axis(max, 'z', 2) - axis(min, 'z', 2)),
          y: axis(min, 'y', 1)
        };
        if (typeof inserted.meshIndex === 'number') await window.__AgentBridge.removeComponent(inserted.meshIndex);
        return { ok: true, size };
      })();
      if (!dimsCheck.ok) throw new Error('占位盒尺寸断言失败：' + dimsCheck.message);
      const nearDims = (value, expect) => typeof value === 'number' && Math.abs(value - expect) <= 0.5;
      if (!nearDims(dimsCheck.size.w, 18) || !nearDims(dimsCheck.size.h, 85) ||
          !nearDims(dimsCheck.size.d, 78.5) || Math.abs(dimsCheck.size.y) > 0.5) {
        throw new Error('占位盒尺寸不符：' + JSON.stringify(dimsCheck.size));
      }
      return { renderer, seedParts, sceneParts: scene.parts.length, partPaths, treeRows, partCount, notice, menuMeta, placements, layoutMetrics, layoutSemantics, layoutEditorSemantics, dims: dimsCheck.size, step: root.querySelector('.design-steps li.active')?.dataset.step ?? '' };
    })()`);
    console.log(`SMOKE_DESIGN_WEBGL_OK renderer=${result.renderer} seed=STEP_fixture:${result.seedParts} scene=${result.sceneParts} partPaths=${result.partPaths} tree=${result.treeRows} cadPartCount=${result.partCount} placements=${result.placements}`);
    console.log(`SMOKE_PLACEHOLDER_DIMS_OK w=${result.dims.w} h=${result.dims.h} d=${result.dims.d} y=${result.dims.y}`);
    console.log('SMOKE_DESIGN_LAYOUT_SEMANTICS_OK wizard=symbolic-card saved-project=symbolic-card');
    // 3D 联动位姿：桥在整机场景建好后注册。这里用真实零件 id 施加 +100 mm 位移，
    // 再读回坐标，断言它真的动了——只调函数不算证据。
    const pose = await window.webContents.executeJavaScript(`(async () => {
      const snap = window.__cadLinkageDebugSnapshot;
      if (typeof snap !== 'function') return { ok: false, reason: 'no_scene' };
      const before = snap();
      const ids = before ? Object.keys(before) : [];
      if (ids.length === 0) return { ok: false, reason: 'empty_scene' };
      const id = ids[0];
      if (typeof window.__cadApplyLinkagePose !== 'function') return { ok: false, reason: 'bridge_missing' };
      window.__cadApplyLinkagePose({ offsets: { [id]: [100, 0, 0] } });
      const after = snap();
      return { ok: true, id, before: before[id], after: after[id] };
    })()`);
    if (!pose?.ok) {
      console.log(`SMOKE_LINKAGE_POSE_SKIP reason=${pose?.reason ?? 'unknown'}`);
    } else {
      const dx = Number(pose.after?.[0] ?? 0) - Number(pose.before?.[0] ?? 0);
      if (!(dx > 0)) throw new Error(`联动位姿没有生效：${pose.id} dx=${dx}`);
      console.log(`SMOKE_LINKAGE_POSE_OK id=${pose.id} dx=${dx.toFixed(3)}`);
    }
    console.log(`SMOKE_DESIGN_WEBGL_NOTICE ${result.notice}`);
  } catch (error) {
    console.error('SMOKE_DESIGN_WEBGL_FAIL', error);
    if (parametric) await parametric.stop();
    setTimeout(() => app.exit(1), 100);
    return;
  }
  if (parametric) await parametric.stop();
  setTimeout(() => app.exit(0), 100);
}

function createWindow(): BrowserWindow {
  const trustedUiPath = indexHtmlPath();
  const isTrustedNavigation = (url: string): boolean => isTrustedUiUrl(url, trustedUiPath);
  const window = new BrowserWindow({
    width: HEADLESS_SCREENSHOTS || HEADLESS_MACHINE_SCREENSHOTS || HEADLESS_DESIGN_WEBGL_SMOKE ? 1600 : 1440,
    height: HEADLESS_SCREENSHOTS || HEADLESS_MACHINE_SCREENSHOTS || HEADLESS_DESIGN_WEBGL_SMOKE ? 1000 : 900,
    useContentSize: HEADLESS_SCREENSHOTS || HEADLESS_MACHINE_SCREENSHOTS || HEADLESS_DESIGN_WEBGL_SMOKE,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#1E2124',
    show: !HEADLESS_SMOKE,
    title: 'AutomationCAD · 非标自动化整机设计',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    const error = new Error(`渲染进程退出：${details.reason} (exitCode=${details.exitCode})`);
    recordDiagnosticError('RENDERER_PROCESS_GONE', error, { reason: details.reason, exitCode: details.exitCode });
    try {
      writeLastCrash(app.getPath('userData'), {
        error,
        operation: currentDiagnosticOperation(),
        code: 'RENDERER_PROCESS_GONE',
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        nodeVersion: process.versions.node,
        platform: process.platform
      });
    } catch (writeError) {
      console.error('[crash] 渲染进程崩溃报告写入失败', writeError instanceof Error ? writeError.message : String(writeError));
    }
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedNavigation(event.url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('did-finish-load', async () => {
    try {
      const scriptUrl = pathToFileURL(extensionPath()).href;
      await window.webContents.executeJavaScript(
        `(() => {
          if (document.getElementById('automation-cad-extension')) return;
          const script = document.createElement('script');
          script.id = 'automation-cad-extension';
          script.src = ${JSON.stringify(scriptUrl)};
          document.body.appendChild(script);
        })()`
      );
    } catch (error) {
      recordDiagnosticError('EXTENSION_INJECT_FAILED', error);
      console.error('[desktop] 扩展脚本注入失败', error);
    }
      if (HEADLESS_WIZARD_SHOTS) {
        const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
          ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
          : resolve(desktopRoot(), '..', 'docs', 'desktop', 'screenshots');
        try {
          const result = await captureDesignWizardScreenshots(window, { outputDir });
          if (parametric) await parametric.stop();
          setTimeout(() => app.exit(result.failed > 0 ? 1 : 0), 100);
        } catch (error) {
          console.error('SMOKE_WIZARD_SHOTS_FAIL', error);
          if (parametric) await parametric.stop();
          setTimeout(() => app.exit(1), 100);
        }
        return;
      }
      if (HEADLESS_MACHINE_SCREENSHOTS) {
        const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
          ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
          : resolve(desktopRoot(), '..', 'docs', 'desktop', 'screenshots');
        try {
          const result = await captureMachineScreenshots(window, { outputDir });
          if (parametric) await parametric.stop();
          setTimeout(() => app.exit(result.failed > 0 ? 1 : 0), 100);
        } catch (error) {
          console.error('SMOKE_MACHINE_SHOTS_FAIL', error);
          if (parametric) await parametric.stop();
          setTimeout(() => app.exit(1), 100);
        }
        return;
      }
      if (HEADLESS_SCREENSHOTS) {
      const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
        ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
        : resolve(desktopRoot(), '..', 'docs', 'desktop', 'screenshots');
      try {
        const result = await captureProductScreenshots(window, {
          outputDir,
          fixtureDir: resolve(desktopRoot(), 'test', 'fixtures')
        });
        if (parametric) await parametric.stop();
        setTimeout(() => app.exit(result.failed > 0 ? 1 : 0), 100);
      } catch (error) {
        console.error('SMOKE_SHOTS_FAIL', error);
        if (parametric) await parametric.stop();
        setTimeout(() => app.exit(1), 100);
      }
      return;
    }
    if (HEADLESS_DESIGN_WEBGL_SMOKE) {
      await runHeadlessDesignWebglSmoke(window);
      return;
    }
    if (HEADLESS_SERVICE) {
      // 外部客户端 smoke（scripts/smoke-mcp.mjs）自己决定何时结束进程
      console.log('SERVICE_READY');
      return;
    }
    if (HEADLESS_SMOKE) {
      try {
        const generated = generateSt({ config: demoMachineConfig() });
        const repeated = generateSt({ config: demoMachineConfig() });
        if (
          generated.stats.files !== 5 ||
          generated.stats.tags !== 32 ||
          !/^[a-f0-9]{12}$/.test(generated.stats.inputHash) ||
          JSON.stringify(generated.files) !== JSON.stringify(repeated.files)
        ) {
          console.error('SMOKE_FAIL plcgen', JSON.stringify(generated.stats));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_OK files=${generated.stats.files} tags=${generated.stats.tags}`);

        const demo = demoMachineConfig();
        const cylindersByStation = new Map(
          demo.actuators
            .filter((actuator) => actuator.kind === 'cylinder')
            .map((actuator) => [actuator.station, actuator.id])
        );
        const projectConfig = {
          ...demo,
          safety: { emergencyStop: 'X100', safetyDoor: 'X101' },
          sensors: demo.sensors.map((sensor) => {
            const cylinder = cylindersByStation.get(sensor.station);
            return sensor.part === sensor.station && cylinder ? { ...sensor, part: cylinder } : sensor;
          }),
          sequence: [
            { id: 'smoke-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
            { id: 'smoke-2', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 1000 }
          ]
        };
        const project = generateProject({ config: projectConfig });
        const repeatedProject = generateProject({ config: projectConfig });
        if (
          !project.ok ||
          project.stats.files !== 11 ||
          project.stats.steps !== 2 ||
          JSON.stringify(project.files) !== JSON.stringify(repeatedProject.ok ? repeatedProject.files : [])
        ) {
          console.error('SMOKE_FAIL plcgen_project', JSON.stringify(project.ok ? project.stats : project.errors));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_SEQ_OK files=${project.stats.files} steps=${project.stats.steps}`);

        const simConfig = {
          ...projectConfig,
          sequence: [
            { id: 'sim-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 2000 },
            { id: 'sim-2', name: '压装气缸伸出', action: 'set', point: 'Y1', condition: 'X4', timeoutMs: 2000 },
            { id: 'sim-3', name: '锁付气缸伸出', action: 'set', point: 'Y2', condition: 'X8', timeoutMs: 2000 },
            { id: 'sim-4', name: '下料气缸伸出', action: 'set', point: 'Y3', condition: 'X12', timeoutMs: 2000 },
            { id: 'sim-5', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 2000 },
            { id: 'sim-6', name: '压装夹爪夹紧', action: 'set', point: 'Y9', condition: 'X5', timeoutMs: 2000 }
          ]
        };
        const verified = verifyGenerated(simConfig);
        if (
          !verified.ok ||
          verified.simulation?.steps.length !== 6 ||
          verified.simulation.alarms.length !== 0
        ) {
          console.error('SMOKE_FAIL plcgen_sim', JSON.stringify({
            ok: verified.ok,
            stage: verified.stage,
            steps: verified.simulation?.steps.length ?? 0,
            alarms: verified.simulation?.alarms ?? [],
            errors: verified.errors
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_SIM_OK steps=${verified.simulation.steps.length} ok=1 alarms=${verified.simulation.alarms.length}`);
      } catch (error) {
        console.error('SMOKE_FAIL plcgen_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      let extensionReady = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        extensionReady = await window.webContents.executeJavaScript('window.__AUTOMATION_CAD_EXTENSION_READY__ === true');
        if (extensionReady) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      if (!extensionReady) {
        console.error('SMOKE_FAIL extension_not_ready');
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const demo = demoMachineConfig();
        const cylindersByStation = new Map(
          demo.actuators
            .filter((actuator) => actuator.kind === 'cylinder')
            .map((actuator) => [actuator.station, actuator.id])
        );
        const plcUiConfig = {
          ...demo,
          safety: { emergencyStop: 'X100', safetyDoor: 'X101' },
          sensors: demo.sensors.map((sensor) => {
            const cylinder = cylindersByStation.get(sensor.station);
            return sensor.part === sensor.station && cylinder ? { ...sensor, part: cylinder } : sensor;
          }),
          sequence: [
            { id: 'smoke-ui-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
            { id: 'smoke-ui-2', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 1000 }
          ]
        };
        const plcUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const config = ${JSON.stringify(plcUiConfig)};
            window.__PlcGenConfigProvider = () => config;
            window.ElecDomain?.setDomain('elec');
            await wait(30);
            const entry = document.getElementById('plcGenEntryButton');
            if (!entry) return { error: 'PLC 程序入口缺失' };
            if (entry.hidden) return { error: 'PLC 程序入口在电气域不可见' };
            entry.click();
            await wait(60);
            const panel = window.__PlcGenPanel;
            if (!panel) return { error: 'PLC 面板 API 缺失' };
            if (!panel.hasConfig()) return { skip: true };
            const pre = await panel.precheck();
            if (!pre) return { error: '预检未返回结果' };
            const before = panel.uiState();
            await panel.generate();
            await wait(40);
            const after = panel.uiState();
            const verify = await panel.simulate();
            const simulateButton = Boolean(document.getElementById('plcSimulate'));
            const exported = await panel.exportZip();
            await wait(20);
            return {
              preErrors: pre.errors.length,
              defaultEnabled: before.enabled === true,
              beforeDisabled: before.generateDisabled,
              files: after.files,
              history: after.history,
              treeRows: after.treeRows,
              previewPath: after.previewPath,
              stats: after.stats,
              simulateButton,
              verifyOk: verify ? verify.ok : null,
              exportOk: exported.ok,
              exportPath: exported.path || '',
              zipPath: exported.zipPath || ''
            };
          })()`
        ) as {
          error?: string;
          skip?: boolean;
          preErrors?: number;
          defaultEnabled?: boolean;
          beforeDisabled?: boolean;
          files?: number;
          history?: number;
          treeRows?: number;
          previewPath?: string | null;
          stats?: string;
          simulateButton?: boolean;
          verifyOk?: boolean | null;
          exportOk?: boolean;
          exportPath?: string;
          zipPath?: string;
        };
        if (plcUi.error) {
          console.error('SMOKE_FAIL plcgen_ui', plcUi.error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        if (plcUi.skip) {
          console.log('SMOKE_PLCGEN_UI_SKIP no_machine_config');
        } else if (
          plcUi.preErrors !== 0 ||
          plcUi.defaultEnabled !== true ||
          plcUi.beforeDisabled !== false ||
          plcUi.files !== 11 ||
          plcUi.history !== 1 ||
          (plcUi.treeRows ?? 0) < 12 ||
          plcUi.previewPath !== 'README.md' ||
          !plcUi.stats?.includes('11 个文件 · 变量') ||
          plcUi.simulateButton !== true ||
          plcUi.verifyOk !== true ||
          !plcUi.exportOk ||
          !plcUi.exportPath || !existsSync(plcUi.exportPath) ||
          !plcUi.zipPath || !existsSync(plcUi.zipPath)
        ) {
          console.error('SMOKE_FAIL plcgen_ui', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        } else {
          console.log(`SMOKE_PLCGEN_UI_OK files=${plcUi.files} history=${plcUi.history}`);
        }
      } catch (error) {
        console.error('SMOKE_FAIL plcgen_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const moduleUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const registry = window.__ModuleRegistry;
            const panel = window.__PlcGenPanel;
            const settingsEntry = document.getElementById('moduleSettingsEntryButton');
            if (!registry || !panel || !settingsEntry) return { error: '模块注册表、PLC 面板或设置入口缺失' };
            const modules = registry.list();
            const core = registry.getStatus('core');
            const plc = registry.getStatus('plcgen');
            const ioTest = registry.getStatus('commission.io-test');
            const parametricHistory = registry.getStatus('parametric.history');
            const plcSync = registry.getStatus('factory.plc-sync');
            const agentResume = registry.getStatus('agent.resume');
            const portable = registry.getStatus('project.portable');
            const update = registry.getStatus('system.update');
            const updateButton = document.getElementById('automationCadUpdateButton');
            if (!core.enabled || !plc.enabled || !ioTest.enabled || !parametricHistory.enabled || !plcSync.enabled || !agentResume.enabled || !portable.enabled || !update.enabled || update.status !== 'enabled' || !updateButton || updateButton.hidden) {
              return { error: '模块默认状态、依赖或 system.update UI 异常', core, plc, ioTest, parametricHistory, plcSync, agentResume, portable, update, updateButton: Boolean(updateButton) };
            }
            const config = window.__PlcGenConfigProvider?.();
            settingsEntry.click();
            await wait(20);
            const drawer = document.getElementById('moduleSettingsDrawer');
            const metadataVisible = drawer && !drawer.hidden && drawer.textContent.includes('API')
              && drawer.textContent.includes('所需能力') && drawer.textContent.includes('PLC 程序校验与生成')
              && drawer.textContent.includes('联调 IO 测试') && drawer.textContent.includes('智慧工厂 PLC 同步扩展')
              && drawer.textContent.includes('参数化特征树撤销与重做')
              && drawer.textContent.includes('可移植工程档案')
              && drawer.textContent.includes('project.archive.preview')
              && drawer.textContent.includes('Agent 计划跨重启恢复')
              && drawer.textContent.includes('agent.plan.cross-restart-resume')
              && drawer.textContent.includes('更新通道') && drawer.textContent.includes('system.update.install')
              && Boolean(drawer.querySelector('[data-module-toggle="parametric.history"]'))
              && Boolean(drawer.querySelector('[data-module-toggle="project.portable"]'))
              && Boolean(drawer.querySelector('[data-module-toggle="agent.resume"]'))
              && Boolean(drawer.querySelector('[data-module-toggle="system.update"]'));
            if (!metadataVisible) return { error: '模块设置未展示版本/API/能力信息' };
            const updateToggle = drawer.querySelector('[data-module-toggle="system.update"]');
            const updateDialog = document.getElementById('automationCadUpdateDialog');
            if (!updateToggle || !updateDialog) return { error: 'system.update 开关或对话框缺失' };
            updateButton.click();
            await wait(30);
            const updateDialogOpened = updateDialog.open;
            updateToggle.checked = false;
            updateToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const updateDisabled = registry.getStatus('system.update').status === 'disabled'
              && updateButton.hidden && !updateDialog.open;
            const updateIpcError = await window.desktop.update.state().then(() => '', (error) => String(error?.message ?? error));
            const updateIpcDenied = updateIpcError.includes('MODULE_DISABLED');
            const updateToggleAgain = drawer.querySelector('[data-module-toggle="system.update"]');
            if (!updateToggleAgain) return { error: '关闭后无法取得 system.update 开关' };
            updateToggleAgain.checked = true;
            updateToggleAgain.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const updateRestored = registry.getStatus('system.update').enabled && !updateButton.hidden;
            const updateStateAfterRestore = await window.desktop.update.state();
            const updateRuntimeStillFailClosed = updateStateAfterRestore.status === 'disabled';
            const resumeToggle = drawer.querySelector('[data-module-toggle="agent.resume"]');
            if (!resumeToggle) return { error: '模块设置中未显示 Agent 恢复开关' };
            resumeToggle.checked = false;
            resumeToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const resumeDisabled = registry.getStatus('agent.resume').status === 'disabled';
            const resumeToggleAgain = drawer.querySelector('[data-module-toggle="agent.resume"]');
            if (!resumeToggleAgain) return { error: '关闭后无法取得 Agent 恢复开关' };
            resumeToggleAgain.checked = true;
            resumeToggleAgain.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const resumeRestored = registry.getStatus('agent.resume').enabled;
            const syncToggle = drawer.querySelector('[data-module-toggle="factory.plc-sync"]');
            if (!syncToggle) return { error: '模块设置中未显示独立 PLC 同步开关' };
            syncToggle.checked = false;
            syncToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const independentlyDisabled = registry.getStatus('factory.plc-sync').status === 'disabled'
              && registry.getStatus('plcgen').enabled;
            const syncToggleAgain = drawer.querySelector('[data-module-toggle="factory.plc-sync"]');
            if (!syncToggleAgain) return { error: '关闭后无法取得 PLC 同步模块开关' };
            syncToggleAgain.checked = true;
            syncToggleAgain.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const syncRestored = registry.getStatus('factory.plc-sync').enabled;
            const portableToggle = drawer.querySelector('[data-module-toggle="project.portable"]');
            const portableActions = Array.from(document.querySelectorAll('[data-project-archive-entry]'));
            if (!portableToggle || portableActions.length !== 3) return { error: '工程档案模块开关或菜单入口缺失' };
            portableToggle.checked = false;
            portableToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const portableDenied = await window.desktop.projectArchive.preview();
            const portableDisabled = registry.getStatus('project.portable').status === 'disabled'
              && portableActions.every((entry) => entry.hidden)
              && portableDenied?.ok === false && portableDenied?.code === 'MODULE_DISABLED';
            const portableToggleAgain = drawer.querySelector('[data-module-toggle="project.portable"]');
            if (!portableToggleAgain) return { error: '关闭后无法取得工程档案模块开关' };
            portableToggleAgain.checked = true;
            portableToggleAgain.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const portableRestored = registry.getStatus('project.portable').enabled
              && portableActions.every((entry) => !entry.hidden);
            panel.open();
            await wait(20);
            settingsEntry.click();
            await wait(20);
            const toggle = drawer?.querySelector('[data-module-toggle="plcgen"]');
            if (!toggle || drawer?.hidden) return { error: '模块设置中未显示 PLC 开关' };
            const generated = await panel.generate();
            if (!generated) return { error: '模块关闭前未能生成 PLC 文件' };
            const before = JSON.stringify({
              sequence: config?.sequence ?? null,
              history: panel.history(),
              files: panel.files().map((file) => file.path)
            });
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const afterDisable = JSON.stringify({
              sequence: config?.sequence ?? null,
              history: panel.history(),
              files: panel.files().map((file) => file.path)
            });
            const disabledApi = await panel.precheck();
            panel.open();
            const exportError = await panel.exportZip().then(() => '').catch((error) => error.message);
            const hidden = document.getElementById('plcGenEntryButton')?.hidden
              && document.getElementById('plcGenOverlay')?.hidden;
            const plcSyncUnavailableWithDependency = registry.getStatus('factory.plc-sync').status === 'unavailable';
            const disabled = !registry.getStatus('plcgen').enabled && panel.uiState().enabled === false
              && plcSyncUnavailableWithDependency && disabledApi === null && !panel.uiState().open && exportError.includes('已关闭');
            const toggleAgain = drawer.querySelector('[data-module-toggle="plcgen"]');
            if (!toggleAgain) return { error: '关闭后无法取得 PLC 模块开关' };
            toggleAgain.checked = true;
            toggleAgain.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            const restored = registry.getStatus('plcgen').enabled
              && !document.getElementById('plcGenEntryButton')?.hidden
              && panel.uiState().enabled === true;
            return {
              modules: modules.length,
              historyRegistered: modules.some((module) => module.id === 'parametric.history'),
              metadataVisible,
              updateDialogOpened,
              updateDisabled,
              updateIpcDenied,
              updateRestored,
              updateRuntimeStillFailClosed,
              resumeDisabled,
              resumeRestored,
              independentlyDisabled,
              syncRestored,
              portableDisabled,
              portableRestored,
              disabled,
              hidden: Boolean(hidden),
              dataPreserved: before === afterDisable,
              restored: Boolean(restored),
              updateVersion: update.version
            };
          })()`
        ) as {
          error?: string;
          modules?: number;
          historyRegistered?: boolean;
          metadataVisible?: boolean;
          updateDialogOpened?: boolean;
          updateDisabled?: boolean;
          updateIpcDenied?: boolean;
          updateRestored?: boolean;
          updateRuntimeStillFailClosed?: boolean;
          resumeDisabled?: boolean;
          resumeRestored?: boolean;
          independentlyDisabled?: boolean;
          syncRestored?: boolean;
          portableDisabled?: boolean;
          portableRestored?: boolean;
          disabled?: boolean;
          hidden?: boolean;
          dataPreserved?: boolean;
          restored?: boolean;
          updateVersion?: string;
        };
        if (moduleUi.error || !moduleUi.historyRegistered || !moduleUi.metadataVisible || !moduleUi.updateDialogOpened || !moduleUi.updateDisabled || !moduleUi.updateIpcDenied || !moduleUi.updateRestored || !moduleUi.updateRuntimeStillFailClosed || !moduleUi.resumeDisabled || !moduleUi.resumeRestored || !moduleUi.independentlyDisabled || !moduleUi.syncRestored || !moduleUi.portableDisabled || !moduleUi.portableRestored || !moduleUi.disabled || !moduleUi.hidden || !moduleUi.dataPreserved || !moduleUi.restored || moduleUi.updateVersion !== '1.0.0') {
          console.error('SMOKE_FAIL modules_ui', JSON.stringify(moduleUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_MODULE_UI_OK modules=${moduleUi.modules} plc=toggle plcSync=independent portable=toggle+ipc-gated system.update=toggle+ipc-gated data=preserved`);
      } catch (error) {
        console.error('SMOKE_FAIL modules_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      const fixture = resolve(desktopRoot(), 'test', 'fixtures', 'cube.stp');
      if (existsSync(fixture)) {
        try {
          const stats = await window.webContents.executeJavaScript(
            `window.AutomationCadViewer.inspectPath(${JSON.stringify(fixture)})`
          ) as { triangleCount: number; meshCount: number };
          if (stats.triangleCount !== 12 || stats.meshCount !== 1) {
            console.error('SMOKE_FAIL cad_stats', JSON.stringify(stats));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_CAD_OK triangles=${stats.triangleCount} meshes=${stats.meshCount}`);
        } catch (error) {
          console.error('SMOKE_FAIL cad_parse', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      if (existsSync(fixture)) {
        try {
          const rendered = await window.webContents.executeJavaScript(
            `(async () => {
              window.AutomationCadViewer.open();
              await window.AutomationCadViewer.importPath(${JSON.stringify(fixture)});
              const fallback = document.getElementById('cadWebglFallback');
              return fallback ? {
                text: fallback.innerText || fallback.textContent || '',
                meshCount: Number(fallback.dataset.meshCount || 0),
                triangleCount: Number(fallback.dataset.triangleCount || 0),
                bounds: fallback.querySelector('[data-cad-fallback="bounds"]')?.textContent || ''
              } : null;
            })()`
          ) as { text: string; meshCount: number; triangleCount: number; bounds: string } | null;
          if (!rendered) {
            console.error('SMOKE_FAIL webgl_fallback_missing');
            setTimeout(() => app.exit(1), 100);
            return;
          }
          if (!rendered.text.includes('当前环境不支持 WebGL，无法显示 3D 模型') ||
              rendered.meshCount !== 1 || rendered.triangleCount !== 12) {
            console.error('SMOKE_FAIL webgl_fallback', JSON.stringify(rendered));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_WEBGL_FALLBACK_OK meshes=${rendered.meshCount} triangles=${rendered.triangleCount} bounds=${rendered.bounds}`);
        } catch (error) {
          console.error('SMOKE_FAIL webgl_fallback_import', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      if (existsSync(fixture)) {
        try {
          const kin = await window.webContents.executeJavaScript(
            `(async () => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const handle = window.AutomationCadKinematics;
              if (!handle) return { error: '运动学标注入口缺失' };
              handle.open();
              await wait(40);
              const initial = handle.state();
              const meshId = initial.meshes[0]?.id;
              if (meshId === undefined) return { error: '未枚举到 STEP 网格', meshes: initial.meshes.length };
              const first = handle.addMovingPart([meshId], '立方体-A');
              handle.updatePart(first, { kind: 'linear', axis: 'z', direction: 1, travelMm: 50, retractedMm: 0, point: 'Y0' });
              const second = handle.addMovingPart([meshId], '立方体-B');
              handle.updatePart(second, { kind: 'linear', axis: 'x', direction: 1, travelMm: 30, retractedMm: 0, point: '', role: '' });
              const state = handle.state();
              const pose = handle.slide(first, 25);
              await wait(30);
              const cards = document.querySelectorAll('[data-kin-part]').length;
              const alert = document.querySelector('[data-kin-alert]')?.textContent || '';
              const slider = document.querySelector('[data-kin-part="' + first + '"] [data-kin-slide]');
              const distance = pose ? Math.hypot(...pose.offset) : 0;
              const mode = window.__Commission3D?.kinematicsMode?.() ?? null;
              return {
                parts: state.parts.length,
                errors: state.errors,
                warnings: state.warnings,
                cards,
                alert,
                slider: Number(slider?.value ?? -1),
                distance,
                mode: mode?.mode || '',
                modeBar: document.getElementById('commission3dMode')?.textContent || ''
              };
            })()`
          ) as {
            error?: string;
            parts: number;
            errors: number;
            warnings: number;
            cards: number;
            alert: string;
            slider: number;
            distance: number;
            mode: string;
            modeBar: string;
          };
          if (kin.error || kin.parts !== 2 || kin.errors !== 1 || kin.cards !== 2 ||
              !kin.alert.includes('1 项未通过') || kin.slider !== 25 || !(kin.distance > 0) ||
              kin.mode !== 'config' || !kin.modeBar.includes('配置驱动')) {
            console.error('SMOKE_FAIL kinematics_ui', JSON.stringify(kin));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_KINEMATICS_UI_OK parts=${kin.parts} errors=${kin.errors} slide=${kin.slider}`);
        } catch (error) {
          console.error('SMOKE_FAIL kinematics_ui_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      const autoFixture = resolve(desktopRoot(), 'test', 'fixtures', 'kinematics-assembly.stp');
      if (existsSync(fixture) && existsSync(autoFixture)) {
        try {
          const auto = await window.webContents.executeJavaScript(
            `(async () => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const handle = window.AutomationCadKinematics;
              if (!handle || typeof handle.suggestions !== 'function') return { error: '自动识别入口缺失' };
              await window.AutomationCadViewer.importPath(${JSON.stringify(autoFixture)});
              handle.open();
              await wait(40);
              const before = handle.state();
              const result = handle.suggestions();
              const cards = document.querySelectorAll('[data-kin-suggest-id]').length;
              const lowCards = document.querySelectorAll('[data-kin-suggests-low] [data-kin-suggest-id]').length;
              const cylinder = result.suggestions.find((item) => item.category === 'cylinder');
              if (!cylinder) return { error: '未识别到气缸', high: result.suggestions.length, low: result.lowConfidence.length };
              const partId = handle.acceptSuggestion(cylinder.id);
              const accepted = handle.state();
              handle.updatePart(partId, { point: 'Y0' });
              const bound = handle.state();
              await window.AutomationCadViewer.importPath(${JSON.stringify(fixture)});
              await wait(20);
              return {
                meshes: before.meshes.length,
                partsBefore: before.parts.length,
                high: result.suggestions.length,
                low: result.lowConfidence.length,
                cards,
                lowCards,
                cylinderAxis: cylinder.axis,
                cylinderTravel: cylinder.travelMm,
                cylinderConfidence: cylinder.confidence,
                acceptedParts: accepted.parts.length,
                remainingHigh: accepted.suggestions.high,
                boundErrors: bound.errors,
                restoredMeshes: handle.state().meshes.length
              };
            })()`
          ) as {
            error?: string;
            meshes: number;
            partsBefore: number;
            high: number;
            low: number;
            cards: number;
            lowCards: number;
            cylinderAxis: string;
            cylinderTravel: number;
            cylinderConfidence: number;
            acceptedParts: number;
            remainingHigh: number;
            boundErrors: number;
            restoredMeshes: number;
          };
          if (auto.error || auto.meshes !== 11 || auto.partsBefore !== 0 || auto.high !== 4 || auto.low !== 1 ||
              auto.cards !== 5 || auto.lowCards !== 1 || auto.cylinderAxis !== 'x' || auto.cylinderTravel !== 50 ||
              !(auto.cylinderConfidence >= 0.6) || auto.acceptedParts !== 1 || auto.remainingHigh !== 3 ||
              auto.boundErrors !== 0 || auto.restoredMeshes !== 1) {
            console.error('SMOKE_FAIL kinematics_auto', JSON.stringify(auto));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_KINEMATICS_AUTO_OK high=${auto.high} low=${auto.low} accepted=${auto.acceptedParts} autoApplied=${auto.partsBefore}`);
          // Agent 工具 suggest_kinematics：经命令总线 → 渲染桥，只给建议，不改动件列表。
          if (!commandBus) throw new Error('命令总线尚未就绪');
          const partsBeforeAgent = await window.webContents.executeJavaScript(
            `(async () => {
              await window.AutomationCadViewer.importPath(${JSON.stringify(autoFixture)});
              await new Promise((resolve) => setTimeout(resolve, 20));
              return window.AutomationCadKinematics.state().parts.length;
            })()`
          ) as number;
          const agentKin = await commandBus.execute('suggest_kinematics', {});
          const agentData = (agentKin.ok ? agentKin.data : {}) as { meshes?: number; suggestions?: unknown[]; lowConfidence?: unknown[] };
          const partsAfterAgent = await window.webContents.executeJavaScript(
            `(async () => {
              const count = window.AutomationCadKinematics.state().parts.length;
              await window.AutomationCadViewer.importPath(${JSON.stringify(fixture)});
              await new Promise((resolve) => setTimeout(resolve, 20));
              return count;
            })()`
          ) as number;
          if (!agentKin.ok || agentData.meshes !== 11 || agentData.suggestions?.length !== 4 ||
              agentData.lowConfidence?.length !== 1 || partsAfterAgent !== partsBeforeAgent) {
            console.error('SMOKE_FAIL agent_kinematics', JSON.stringify({ ok: agentKin.ok, agentData, partsBeforeAgent, partsAfterAgent }));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_AGENT_KINEMATICS_OK high=${agentData.suggestions.length} low=${agentData.lowConfidence.length} written=${partsAfterAgent - partsBeforeAgent}`);
        } catch (error) {
          console.error('SMOKE_FAIL kinematics_auto_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      if (existsSync(fixture)) {
        try {
          const mech = await window.webContents.executeJavaScript(
            `(() => {
              const hits = window.AutomationCadViewer.runInterference([
                { name: 'Fixture-A', bbox: { min: [0, 0, 0], max: [100, 100, 100] } },
                { name: 'Fixture-B', bbox: { min: [90, 90, 90], max: [190, 190, 190] } }
              ]);
              return { hits: hits.length, overlap: hits[0]?.overlap || null, severity: hits[0]?.severity || null };
            })()`
          ) as { hits: number; overlap: [number, number, number] | null; severity: string | null };
          if (mech.hits < 1 || !mech.overlap || mech.overlap.some((value) => Math.abs(value - 10) > 0.01)) {
            console.error('SMOKE_FAIL mech', JSON.stringify(mech));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_MECH_OK hits=${mech.hits}`);
        } catch (error) {
          console.error('SMOKE_FAIL mech_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const exported = await window.webContents.executeJavaScript(
            `(async () => {
              const csv = await window.AutomationCadViewer.exportData('csv');
              const dxf = await window.AutomationCadViewer.exportData('dxf');
              const xlsx = await window.AutomationCadViewer.exportData('xlsx');
              const glb = await window.AutomationCadViewer.exportMesh('glb');
              const obj = await window.AutomationCadViewer.exportMesh('obj');
              return { csv: csv.size, dxf: dxf.size, xlsx: xlsx.size, glb: glb.size, obj: obj.size };
            })()`
          ) as { csv: number; dxf: number; xlsx: number; glb: number; obj: number };
          if (!(exported.csv > 0) || !(exported.dxf > 0) || !(exported.xlsx > 0) ||
              !(exported.glb > 0) || !(exported.obj > 0)) {
            console.error('SMOKE_FAIL export', JSON.stringify(exported));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log('SMOKE_EXPORT_OK csv=1 dxf=1');
          console.log(`SMOKE_EXPORT_ASSETS_OK xlsx=${exported.xlsx} glb=${exported.glb} obj=${exported.obj}`);
        } catch (error) {
          console.error('SMOKE_FAIL export_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const pdf = await window.webContents.executeJavaScript(
            `window.AutomationCadViewer.exportReportPdf()`
          ) as { path: string; htmlPath: string };
          if (!pdf || !existsSync(pdf.path) || !pdf.path.endsWith('report.pdf')) {
            console.error('SMOKE_FAIL pdf', JSON.stringify(pdf));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_PDF_OK path=${pdf.path}`);
        } catch (error) {
          console.error('SMOKE_FAIL pdf_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const mechUi = await window.webContents.executeJavaScript(
            `(() => {
              const rootTab = document.getElementById('cadStressRootTab');
              window.AutomationCadViewer.open();
              document.querySelector('[data-cad-side="stress"]')?.click();
              const calculators = document.querySelectorAll('#cadStressPane .cad-calc').length;
              const results = document.querySelectorAll('#cadStressPane .cad-calc-result').length;
              const inspector = Boolean(document.getElementById('cadInterferencePanel'));
              window.AutomationCadViewer.close();
              return { rootTab: Boolean(rootTab), calculators, results, inspector };
            })()`
          ) as { rootTab: boolean; calculators: number; results: number; inspector: boolean };
          if (!mechUi.rootTab || mechUi.calculators !== 3 || mechUi.results !== 3 || !mechUi.inspector) {
            console.error('SMOKE_FAIL mech_ui', JSON.stringify(mechUi));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log('SMOKE_MECH_UI_OK rootTab=1 calculators=3 inspector=1');
        } catch (error) {
          console.error('SMOKE_FAIL mech_ui_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      try {
        const ui = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            window.AutomationCadViewer.close();
            const factoryEntry = document.getElementById('factoryEntryButton');
            const packEntry = document.getElementById('packEntryButton');
            if (!factoryEntry || !packEntry) return { error: '扩展入口按钮缺失' };

            factoryEntry.click();
            await wait(120);
            const kind = document.getElementById('factoryKind');
            kind.value = 'demo';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('factoryConnect').click();
            await wait(700);
            const stations = document.querySelectorAll('#factoryStations .acp-station').length;
            const tags = document.querySelectorAll('#factoryStations .acp-tag').length;
            const factoryStatus = document.getElementById('factoryStatusBar')?.textContent || '';
            document.getElementById('factoryDisconnect').click();
            await wait(200);

            packEntry.click();
            await wait(350);
            const packRows = document.querySelectorAll('#packList .acp-pack-row').length;
            const search = document.getElementById('packSearch');
            search.value = 'SMC';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(450);
            const partRows = document.querySelectorAll('#packResults [data-part-row]').length;
            document.querySelector('#packResults [data-insert-part]')?.click();
            const overlay = JSON.parse(localStorage.getItem('automationcad.parts.overlay.v1') || '{"parts":[]}');
            return {
              stations,
              tags,
              factoryStatus,
              packRows,
              partRows,
              overlayCount: Array.isArray(overlay.parts) ? overlay.parts.length : 0
            };
          })()`
        ) as {
          error?: string;
          stations: number;
          tags: number;
          factoryStatus: string;
          packRows: number;
          partRows: number;
          overlayCount: number;
        };
        if (ui.error || ui.stations !== 2 || ui.tags !== 8 || !ui.factoryStatus.includes('已连接：demo') ||
            ui.packRows < 1 || ui.partRows < 1 || ui.overlayCount < 1) {
          console.error('SMOKE_FAIL ui', JSON.stringify(ui));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_UI_OK stations=${ui.stations} tags=${ui.tags} packs=${ui.packRows} parts=${ui.partRows} overlay=${ui.overlayCount}`);
      } catch (error) {
        console.error('SMOKE_FAIL ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const elecLib = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('elecLibEntryButton');
            if (!entry) return { error: '电气元件入口按钮缺失' };
            entry.click();
            let ready = false;
            for (let attempt = 0; attempt < 50; attempt += 1) {
              await wait(100);
              const state = document.getElementById('elecLibResults')?.dataset.ready;
              if (state === '1') { ready = true; break; }
              if (state === 'error') break;
            }
            const results = document.getElementById('elecLibResults');
            if (!ready || !results) {
              return { error: document.getElementById('elecLibStatus')?.textContent || '电气元件面板加载超时' };
            }
            const parts = Number(results.dataset.parts || 0);
            const categories = Number(results.dataset.categories || 0);
            const symbols = Number(results.dataset.symbols || 0);
            const rows = document.querySelectorAll('#elecLibResults [data-elec-part]').length;
            const contactor = Array.from(document.querySelectorAll('#elecLibCategories [data-elec-category]'))
              .find((button) => (button.textContent || '').startsWith('接触器'));
            contactor?.click();
            await wait(60);
            const contactorRows = document.querySelectorAll('#elecLibResults [data-elec-part]').length;
            const beforePlaced = document.querySelectorAll('#elPlaceLayer .esym').length;
            document.querySelector('#elecLibResults [data-elec-insert]:not([disabled])')?.click();
            await wait(120);
            const placedLayer = document.querySelectorAll('#elPlaceLayer .esym');
            const placedTag = placedLayer[placedLayer.length - 1]?.dataset.tag || '';
            const placed = placedLayer.length - beforePlaced;
            window.ElecDomain?.setDomain('mech');
            await wait(60);
            return { parts, categories, symbols, rows, contactorRows, placed, placedTag };
          })()`
        ) as { error?: string; parts: number; categories: number; symbols: number; rows: number; contactorRows: number; placed: number; placedTag: string };
        if (elecLib.error || elecLib.parts < 350 || elecLib.categories < 20 || elecLib.rows !== elecLib.parts || elecLib.contactorRows < 10 || elecLib.placed !== 1 || !elecLib.placedTag) {
          console.error('SMOKE_FAIL elec_lib', JSON.stringify(elecLib));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_LIB_OK parts=${elecLib.parts} categories=${elecLib.categories} symbols=${elecLib.symbols}`);
      } catch (error) {
        console.error('SMOKE_FAIL elec_lib_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const enclosure = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__Enclosure;
            if (!api) return { error: '底板布置 API 缺失' };
            const first = await api.add('iC65N-C16-1P', 120, 180);
            const second = await api.add('iC65N-C16-1P', 126, 180);
            const state = api.state();
            api.close();
            return {
              added: Boolean(first && second),
              placed: state?.placed || 0,
              overlap: state?.overlap || 0,
              ratio: state?.ratio || 0,
              status: document.getElementById('encStatus')?.textContent || ''
            };
          })()`
        ) as { error?: string; added: boolean; placed: number; overlap: number; ratio: number; status: string };
        if (enclosure.error || !enclosure.added || enclosure.placed !== 2 || enclosure.overlap !== 1 || !(enclosure.ratio > 0) || !enclosure.status.includes('已放置')) {
          console.error('SMOKE_FAIL enclosure_canvas', JSON.stringify(enclosure));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1 ratio>0');
      } catch (error) {
        console.error('SMOKE_FAIL enclosure_canvas_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // P7-B：Agent 单步放置 + 撤销。走真实命令总线与 __Enclosure，不模拟几何。
        if (!commandBus) throw new Error('命令总线尚未就绪');
        const cleared = await window.webContents.executeJavaScript(
          `(() => { window.__Enclosure?.clear(); return window.__Enclosure?.state()?.placed ?? -1; })()`
        ) as number;
        const placed = await commandBus.execute('place_component', {
          partId: 'iC65N-C16-1P',
          x: 12,
          y: 40,
          rotate: false,
          railSnap: true
        });
        const placementId = placed.ok && placed.data && typeof placed.data === 'object'
          ? (placed.data as Record<string, unknown>).placementId
          : null;
        const afterPlace = await window.webContents.executeJavaScript(
          `(() => {
            const state = window.__Enclosure?.state();
            const item = state?.placements?.[0];
            return {
              placed: state?.placed ?? -1,
              x: item?.x ?? -1,
              y: item?.y ?? -1,
              w: item?.w ?? -1,
              h: item?.h ?? -1,
              railId: item?.railId ?? ''
            };
          })()`
        ) as { placed: number; x: number; y: number; w: number; h: number; railId: string };
        const undone = await commandBus.undoLast();
        const removed = undone.ok && undone.data && typeof undone.data === 'object'
          ? (undone.data as Record<string, unknown>).removed
          : null;
        const afterUndo = await window.webContents.executeJavaScript(
          `(() => window.__Enclosure?.state()?.placed ?? -1)()`
        ) as number;
        if (
          cleared !== 0 || !placed.ok || typeof placementId !== 'string' ||
          afterPlace.placed !== 1 || afterPlace.w !== 18 || afterPlace.h !== 85 ||
          !afterPlace.railId || !undone.ok || removed !== placementId || afterUndo !== 0
        ) {
          console.error('SMOKE_FAIL agent_place', JSON.stringify({
            cleared, placed, placementId, afterPlace, undone, removed, afterUndo
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_PLACE_OK placed=${afterPlace.placed} undo=${removed ? 1 : 0}`);
        // 占位盒尺寸：插带 dims 的器件后，3D 包围盒必须等于数据包外形（不是固定 20mm 方块）
        {
          const degraded = await window.webContents.executeJavaScript(
            `(() => window.__AgentBridge?.getScene?.().degraded === true)()`
          ) as boolean;
          const inserted = await commandBus.execute('insert_component', { partId: 'iC65N-C16-1P' });
          const measured = await window.webContents.executeJavaScript(
            `(() => {
              const parts = window.__AgentBridge?.getScene?.().parts ?? [];
              const part = parts.find((item) => item && item.name === 'iC65N 1P C16');
              if (!part || !part.bbox) return null;
              const [min, max] = part.bbox;
              return {
                w: Math.abs(max[0] - min[0]),
                h: Math.abs(max[1] - min[1]),
                d: Math.abs(max[2] - min[2]),
                y: min[1]
              };
            })()`
          ) as { w: number; h: number; d: number; y: number } | null;
          const insertError = !inserted.ok && inserted.error
            ? String((inserted.error as { message?: unknown }).message ?? '')
            : '';
          if (!inserted.ok && (degraded || insertError.includes('WebGL'))) {
            // 纯降级 smoke（无 WebGL）里没有 3D 视口，插入必然失败；这条断言只在有 WebGL 时生效
            console.log('SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl');
          } else {
            const near = (value: number | undefined, expect: number): boolean =>
              typeof value === 'number' && Math.abs(value - expect) <= 0.5;
            if (!inserted.ok || !measured || !near(measured.w, 18) || !near(measured.h, 85) ||
                !near(measured.d, 78.5) || Math.abs(measured.y) > 0.5) {
              console.error('SMOKE_FAIL placeholder_dims', JSON.stringify({ inserted, measured }));
              setTimeout(() => app.exit(1), 100);
              return;
            }
            console.log(`SMOKE_PLACEHOLDER_DIMS_OK w=${measured.w} h=${measured.h} d=${measured.d} y=${measured.y}`);
            if (inserted.ok && inserted.data && typeof inserted.data === 'object') {
              const meshIndex = (inserted.data as Record<string, unknown>).meshIndex;
              if (typeof meshIndex === 'number') {
                await window.webContents.executeJavaScript(
                  `(() => window.__AgentBridge?.removeComponent?.(${JSON.stringify(meshIndex)}))()`
                );
              }
            }
          }
        }
      } catch (error) {
        console.error('SMOKE_FAIL agent_place_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 电气校验规则引擎：用一段含跨网络重号 + 截面不足的样例电路自检。
        const result = runElectricalCheck({
          wires: [
            { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
            { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' },
            { no: 'L1', net: 'n3', potential: 'L2', from: 'QF1:1', to: 'KM1:3' }
          ],
          loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }],
          circuits: [{ wireNo: '101', currentA: 40, sectionMm2: 4 }],
          options: { demandFactor: 0.8 }
        });
        const codes = result.findings.map((item) => item.code);
        if (result.findings.length < 1 || result.counts.error < 1 ||
            !codes.includes('WIRE_NO_CROSS_NET') || !codes.includes('WIRE_SECTION_UNDER') ||
            result.summary.breakerSuggestion?.ratedA !== 16) {
          console.error('SMOKE_FAIL elec_check', JSON.stringify({ codes, counts: result.counts, summary: result.summary }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_CHECK_OK findings=${result.findings.length} errors=${result.counts.error} ${describeCheck(result)}`);
      } catch (error) {
        console.error('SMOKE_FAIL elec_check_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 电气校验面板：入口打开 → 运行样例 → 渲染问题表 → 导出 PDF。
        const elecUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__ElecCheckPanel;
            const entry = document.getElementById('elecCheckEntryButton');
            if (!api || !entry) return { error: '电气校验面板缺失' };
            entry.click();
            const drawer = document.getElementById('elecCheckDrawer');
            const opened = Boolean(drawer && !drawer.hidden);
            const result = await api.run({
              wires: [
                { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
                { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' },
                { no: '', net: 'n3', potential: 'L2', from: 'QF2:2', to: 'KM1:3' }
              ],
              loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }],
              circuits: [{ wireNo: '101', currentA: 40, sectionMm2: 4 }],
              options: { demandFactor: 0.8 }
            });
            if (!result) return { error: '校验未返回结果' };
            const rows = document.querySelectorAll('#elecCheckTable tbody tr').length;
            const cards = document.querySelectorAll('#elecCheckSummary .acp-check-card').length;
            const status = document.getElementById('elecCheckStatus')?.textContent || '';
            const html = api.html();
            const pdf = await api.exportPdf();
            api.close();
            return {
              opened,
              rows,
              cards,
              status,
              findings: result.findings.length,
              errors: result.counts.error,
              pdfPath: pdf.path,
              htmlSize: html.length,
              hasReport: html.includes('电气校验报告') && html.includes('校验问题明细')
            };
          })()`
        ) as {
          error?: string; opened: boolean; rows: number; cards: number; status: string;
          findings: number; errors: number; pdfPath: string; htmlSize: number; hasReport: boolean;
        };
        if (elecUi.error || !elecUi.opened || elecUi.cards !== 9 || elecUi.errors < 1 ||
            elecUi.rows !== elecUi.findings || !elecUi.status.includes('电气校验：错误') ||
            !elecUi.hasReport || !(elecUi.htmlSize > 1000) ||
            !elecUi.pdfPath || !elecUi.pdfPath.endsWith('report.pdf')) {
          console.error('SMOKE_FAIL elec_check_ui', JSON.stringify(elecUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_CHECK_UI_OK rows=${elecUi.rows} cards=${elecUi.cards} pdf=${elecUi.pdfPath.endsWith('report.pdf')}`);

        const electricalDoc = {
          wires: [{ no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' }]
        };
        const auditPath = join(app.getPath('userData'), 'agent-audit.jsonl');
        const auditBefore = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : null;
        const disabledUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__ElecCheckPanel;
            const entry = document.getElementById('elecCheckEntryButton');
            const drawer = document.getElementById('elecCheckDrawer');
            const otherStorage = () => JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
              .filter((key) => key && key !== 'automationcad.modules.v1').sort()
              .map((key) => [key, localStorage.getItem(key)]));
            const preservedBefore = otherStorage();
            window.__ModuleRegistry.setEnabled('elec.validation', false);
            const run = await api.run(${JSON.stringify(electricalDoc)});
            let pdfCode = '';
            try { await api.exportPdf(); } catch (error) { pdfCode = error?.code || ''; }
            return {
              disabled: window.__ModuleRegistry.getStatus('elec.validation').enabled === false,
              hidden: Boolean(entry?.hidden && drawer?.hidden),
              runCode: run?.code || '',
              pdfCode,
              runButtonDisabled: Boolean(document.getElementById('elecCheckRun')?.disabled),
              dataPreserved: preservedBefore === otherStorage()
            };
          })()`
        ) as {
          disabled: boolean; hidden: boolean; runCode: string; pdfCode: string;
          runButtonDisabled: boolean; dataPreserved: boolean;
        };
        const toolDenied = await agentTools?.call('run_electrical_check', electricalDoc) as
          { ok?: boolean; code?: string } | undefined;
        const commandDenied = await commandBus?.execute('run_electrical_check', electricalDoc);
        const disabledToolsHidden = !(agentTools?.summaries() ?? []).some((tool) => tool.name === 'run_electrical_check');
        const auditAfter = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : null;
        const enabledUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__ElecCheckPanel;
            window.__ModuleRegistry.setEnabled('elec.validation', true);
            const entry = document.getElementById('elecCheckEntryButton');
            api.open();
            const opened = Boolean(document.getElementById('elecCheckDrawer') && !document.getElementById('elecCheckDrawer').hidden);
            const result = await api.run(${JSON.stringify(electricalDoc)});
            api.close();
            return { enabled: window.__ModuleRegistry.getStatus('elec.validation').enabled, visible: entry?.hidden === false, opened, ok: result?.counts?.error === 0 };
          })()`
        ) as { enabled: boolean; visible: boolean; opened: boolean; ok: boolean };
        const toolRestored = await agentTools?.call('run_electrical_check', electricalDoc) as
          { ok?: boolean; counts?: { error?: number } } | undefined;
        const commandRestored = await commandBus?.execute('run_electrical_check', electricalDoc);
        if (!disabledUi.disabled || !disabledUi.hidden || disabledUi.runCode !== 'MODULE_DISABLED' ||
            disabledUi.pdfCode !== 'MODULE_DISABLED' || !disabledUi.runButtonDisabled || !disabledUi.dataPreserved ||
            toolDenied?.ok !== false || toolDenied.code !== 'MODULE_DISABLED' ||
            commandDenied?.ok !== false || commandDenied.error?.code !== 'MODULE_DISABLED' || !disabledToolsHidden ||
            auditBefore !== auditAfter || !enabledUi.enabled || !enabledUi.visible || !enabledUi.opened || !enabledUi.ok ||
            toolRestored?.ok !== true || toolRestored.counts?.error !== 0 ||
            commandRestored?.ok !== true || !commandRestored.data ||
            (commandRestored.data as { counts?: { error?: number } }).counts?.error !== 0) {
          console.error('SMOKE_FAIL elec_validation_module_gate', JSON.stringify({
            disabledUi, toolDenied, commandDenied, disabledToolsHidden, auditPreserved: auditBefore === auditAfter,
            enabledUi, toolRestored, commandRestored
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_ELEC_VALIDATION_MODULE_OK renderer=MODULE_DISABLED main=MODULE_DISABLED mcp=dynamic data=audit=preserved reenabled=true');
      } catch (error) {
        console.error('SMOKE_FAIL elec_check_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const syncUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('syncEntryButton');
            if (!entry) return { error: '智慧工厂入口按钮缺失' };
            entry.click();
            await wait(120);
            const ids = ['syncBaseUrl', 'syncDeviceId', 'syncProjectId', 'syncApiKey', 'syncEnabled', 'syncTest', 'syncUpload', 'syncLastResult'];
            const missing = ids.filter((id) => !document.getElementById(id));
            const apiKeyType = document.getElementById('syncApiKey')?.getAttribute('type') || '';
            const enabledType = document.getElementById('syncEnabled')?.getAttribute('type') || '';
            const drawer = document.getElementById('syncDrawer');
            return {
              missing,
              apiKeyType,
              enabledType,
              visible: Boolean(drawer && !drawer.hidden),
              fields: ids.length
            };
          })()`
        ) as { error?: string; missing: string[]; apiKeyType: string; enabledType: string; visible: boolean; fields: number };
        if (syncUi.error || syncUi.missing.length > 0 || syncUi.apiKeyType !== 'password' ||
            syncUi.enabledType !== 'checkbox' || !syncUi.visible) {
          console.error('SMOKE_FAIL sync_ui', JSON.stringify(syncUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_SYNC_UI_OK fields=${syncUi.fields} apiKey=password enabled=checkbox`);
      } catch (error) {
        console.error('SMOKE_FAIL sync_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const syncExportsDir = join(app.getPath('userData'), 'exports');
        const syncExportEntriesBefore = existsSync(syncExportsDir) ? readdirSync(syncExportsDir).sort() : [];
        const moduleGate = await window.webContents.executeJavaScript(
          `(async () => {
            const setEnabled = window.__ModuleRegistry?.setEnabled;
            if (typeof setEnabled !== 'function' || !window.desktop) return { error: '模块设置 API 或 preload 不可用' };
            setEnabled('factory.plc-sync', false);
            let plcSyncDenied;
            let ordinarySync;
            try {
              plcSyncDenied = await window.desktop.sync.upload({
                projectName: 'disabled-plc-sync', bomCsv: '序号,名称\\n1,底板\\n',
                reportHtml: '<html><body>ordinary report</body></html>', glb: new Uint8Array([1]),
                dxf: '0\\nSECTION\\n0\\nENDSEC\\n', bom: [{ no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL' }],
                plc: { target: 'generic', generatedVersion: '1.0.0', machineId: 'smoke', programFiles: [], mappingCsv: 'must not be generated' }
              });
              ordinarySync = await window.desktop.sync.upload({
                projectName: 'ordinary-sync', bomCsv: '序号,名称\\n1,底板\\n',
                reportHtml: '<html><body>ordinary report</body></html>', glb: new Uint8Array([1]),
                dxf: '0\\nSECTION\\n0\\nENDSEC\\n', bom: [{ no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL' }]
              });
            } finally {
              setEnabled('factory.plc-sync', true);
            }
            const factoryPlcSyncGate = {
              plcSyncDenied,
              ordinarySync
            };
            const historyBefore = await window.desktop.plcgen.history();
            setEnabled('plcgen', false);
            try {
              const sync = await window.desktop.sync.upload({ plc: {} });
              const historyWrite = await window.desktop.plcgen.recordHistory({
                at: '2000-01-01T00:00:00.000Z', inputHash: 'module-disabled-smoke-history',
                files: 1, target: 'generic', namePrefix: '', fileList: []
              });
              const exported = await window.desktop.plcgen.exportProject({
                machineName: 'module-disabled-smoke',
                files: [{ path: 'blocked.st', content: 'should not be written' }]
              });
              const historyAfter = await window.desktop.plcgen.history();
              return { sync, historyWrite, historyBefore, historyAfter, exported, factoryPlcSyncGate };
            } finally {
              setEnabled('plcgen', true);
            }
          })()`
        ) as {
          error?: string;
          factoryPlcSyncGate?: {
            plcSyncDenied?: { ok?: boolean; code?: string };
            ordinarySync?: { ok?: boolean; code?: string; stage?: string; message?: string };
            noFilesWritten?: boolean;
          };
          sync?: { ok?: boolean; code?: string };
          historyWrite?: { ok?: boolean; code?: string } | unknown[];
          historyBefore?: unknown[];
          historyAfter?: unknown[];
          exported?: { ok?: boolean; code?: string; path?: string; zipPath?: string };
        };
        if (moduleGate.factoryPlcSyncGate) {
          const syncExportEntriesAfter = existsSync(syncExportsDir) ? readdirSync(syncExportsDir).sort() : [];
          moduleGate.factoryPlcSyncGate.noFilesWritten = JSON.stringify(syncExportEntriesBefore) === JSON.stringify(syncExportEntriesAfter);
        }
        if (moduleGate.error || moduleGate.factoryPlcSyncGate?.plcSyncDenied?.ok !== false ||
            moduleGate.factoryPlcSyncGate.plcSyncDenied.code !== 'MODULE_DISABLED' ||
            moduleGate.factoryPlcSyncGate.ordinarySync?.stage !== '上传' ||
            moduleGate.factoryPlcSyncGate.ordinarySync.code === 'MODULE_DISABLED' ||
            !moduleGate.factoryPlcSyncGate.noFilesWritten ||
            moduleGate.sync?.ok !== false || moduleGate.sync.code !== 'MODULE_DISABLED' ||
            !moduleGate.historyWrite || Array.isArray(moduleGate.historyWrite) ||
            moduleGate.historyWrite.code !== 'MODULE_DISABLED' ||
            JSON.stringify(moduleGate.historyBefore) !== JSON.stringify(moduleGate.historyAfter) ||
            moduleGate.exported?.ok !== false || moduleGate.exported.code !== 'MODULE_DISABLED' ||
            moduleGate.exported.path || moduleGate.exported.zipPath) {
          console.error('SMOKE_FAIL module_gate_ipc', JSON.stringify(moduleGate));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_MODULE_GATE_IPC_OK plcSync=MODULE_DISABLED ordinary=allowed plcgen=MODULE_DISABLED history=MODULE_DISABLED export=MODULE_DISABLED writes=0');
      } catch (error) {
        console.error('SMOKE_FAIL module_gate_ipc_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const smokeMachine = {
          id: 'smoke-plc-machine',
          name: 'PLC 同步冒烟机型',
          stations: ['工位 1'],
          actuators: [{ id: 'smoke-cylinder', name: '测试气缸', kind: 'cylinder' as const, station: '工位 1', extendPoint: 'Y0', retractPoint: 'Y1' }],
          sensors: [
            { point: 'X0', station: '工位 1', part: 'smoke-cylinder' },
            { point: 'X1', station: '工位 1', part: 'smoke-cylinder' }
          ],
          safety: { emergencyStop: 'X2', safetyDoor: 'X3' }
        };
        const generatedPlc = generateProject({ config: smokeMachine, target: 'generic' });
        if (!generatedPlc.ok) throw new Error(`PLC smoke 预检失败：${generatedPlc.errors.map((issue) => issue.message).join('；')}`);
        const built = buildDesignPackage({
          projectId: 'smoke-project',
          projectName: '冒烟测试装配体',
          appVersion: app.getVersion(),
          createdAt: '2026-10-22T14:00:00.000Z',
          bom: [{ no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061' }],
          bomCsv: '序号,名称\r\n1,底板\r\n',
          pdf: new TextEncoder().encode('%PDF-1.4 smoke'),
          glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
          dxf: '0\nSECTION\n0\nENDSEC\n',
          plc: {
            target: 'generic',
            generatedVersion: PLCGEN_VERSION,
            machineId: smokeMachine.id,
            programFiles: generatedPlc.files.filter((file) => file.path !== 'README.md').map((file) => ({ path: file.path, content: file.content })),
            mappingCsv: buildMachineIoMap(smokeMachine).csv
          }
        });
        const parsedCandidate = parseDesignPackage(built.zip);
        if (built.manifest.files.length !== 4 || built.manifest.plc?.programFiles.length !== 10 ||
            parsedCandidate.machineContextStatus !== 'unavailable' || parsedCandidate.requiresExplicitApply !== true ||
            !/^[a-f0-9]{64}$/.test(built.manifest.bomSha256)) {
          console.error('SMOKE_FAIL sync_package', JSON.stringify({ files: built.manifest.files.length, plcFiles: built.manifest.plc?.programFiles.length, machineStatus: parsedCandidate.machineContextStatus, sha: built.manifest.bomSha256 }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_SYNC_PACKAGE_OK files=${built.manifest.files.length} plcFiles=${built.manifest.plc.programFiles.length} machine=candidate sha=1`);
      } catch (error) {
        console.error('SMOKE_FAIL sync_package_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const plcUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('commissionEntryButton');
            if (!entry) return { error: '联调入口按钮缺失' };
            entry.click();
            await wait(150);
            const kind = document.getElementById('commissionKind');
            kind.value = 'sim';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('commissionConnect').click();
            await wait(450);
            const pointRows = document.querySelectorAll('#commissionPoints tr[data-plc-point]').length;
            const monitorRows = document.querySelectorAll('#commissionMonitor tr[data-monitor-point]').length;
            const machine3d = document.getElementById('commission3dMachine')?.textContent || '';
            const lamp = document.getElementById('commissionLamp')?.dataset.state || '';
            const connectText = document.getElementById('commissionStatusText')?.textContent || '';
            if (pointRows !== 28 || monitorRows !== 28 || lamp !== 'connected' || !connectText.includes('已连接')) {
              return { error: 'PLC 连接或点位表异常', pointRows, monitorRows, lamp, connectText };
            }
            if (!machine3d.includes('4 工位') || !machine3d.includes('12 执行机构') || !machine3d.includes('16 传感器')) {
              return { error: '3D 机型摘要异常', machine3d };
            }

            const initiallyBlocked = document.getElementById('commissionPowerRun')?.disabled
              && document.getElementById('commissionPowerStep')?.disabled
              && [...document.querySelectorAll('#commissionCases [data-run-case]')].every((button) => button.disabled);
            const initialWarning = document.querySelector('.commission-map-warning')?.textContent || '';
            if (!initiallyBlocked || !initialWarning.includes('用途与标准用例不符')) {
              return { error: '机型 IO 不匹配时未禁用固定点位流程', initiallyBlocked, initialWarning };
            }
            const rejectedCase = await window.AutomationCadCommission.runCase('jog');
            if (rejectedCase !== false) return { error: '机型 IO 不匹配时 API 仍允许运行用例' };

            const stations = ['上料', '压装', '锁付', '下料'];
            const outputNames = [
              '主回路接触器 KM1', '24V 电源输出', 'PLC RUN 输出', '气源电磁阀',
              '回原点输出', '就绪指示灯', '滑台前进电磁阀 YV1', '滑台后退电磁阀 YV2',
              '急停测试继电器 KA1', '辅助输出 9', '辅助输出 10', '辅助输出 11'
            ];
            const inputNames = [
              '主回路反馈', '24V 电源反馈', 'PLC RUN 反馈', '气源压力开关', '原点到位',
              'PLC 就绪反馈', '滑台前进到位', '滑台后退到位', '安全门闭合', '急停链路断开',
              '急停复位', '气源低压报警', '伺服就绪', '伺服报警', '报警锁存', '备用输入'
            ];
            window.AutomationCadCommission.setMachineConfig({
              id: 'smoke-commission-map',
              name: '联调映射兼容样机',
              stations,
              actuators: outputNames.map((name, index) => ({
                id: 'smoke-actuator-' + index,
                name,
                kind: 'cylinder',
                station: stations[index % stations.length],
                extendPoint: 'Y' + index
              })),
              sensors: inputNames.map((part, index) => ({
                point: 'X' + index,
                station: stations[index % stations.length],
                part
              }))
            });
            if (document.getElementById('commissionPowerRun')?.disabled) {
              return { error: '兼容 IO 映射仍被禁用', warning: document.querySelector('.commission-map-warning')?.textContent || '' };
            }

            document.getElementById('commissionPowerRun').click();
            let powerText = '';
            for (let attempt = 0; attempt < 80; attempt += 1) {
              await wait(100);
              powerText = document.getElementById('commissionPowerSummary')?.textContent || '';
              if (powerText.includes('6/6 通过')) break;
            }
            if (!powerText.includes('6/6 通过')) return { error: '上电流程未全部通过', powerText };

            document.getElementById('commissionCasesRun').click();
            let casePass = 0;
            for (let attempt = 0; attempt < 80; attempt += 1) {
              await wait(100);
              casePass = document.querySelectorAll('#commissionCases .commission-badge.pass').length;
              if (casePass === 3) break;
            }
            const caseRows = document.querySelectorAll('#commissionCaseResults tr[data-case-id]').length;
            const failRows = document.querySelectorAll('#commissionCaseResults .commission-badge.fail').length;
            const exportButton = Boolean(document.getElementById('commissionExport'));
            let pdfPath = '';
            try {
              const pdf = await window.AutomationCadViewer.exportReportPdf();
              pdfPath = pdf.path;
            } catch (error) {
              return { error: '联调报告 PDF 导出失败：' + String(error) };
            }
            const stats3d = window.__Commission3D?.stats?.() ?? null;
            await window.desktop.plc.force('X6', false);
            const failedCase = await window.AutomationCadCommission.runCase('jog');
            await wait(150);
            const diagCodes = window.__Commission3D?.lastDiagnosis?.().length ?? 0;
            const diagCards = document.querySelectorAll('#commissionDiagnosis .commission-diagnosis-card').length;
            const moduleRegistry = window.__ModuleRegistry;
            const ioTestWasEnabled = moduleRegistry?.getStatus('commission.io-test')?.enabled === true;
            if (!ioTestWasEnabled) return { error: 'IO 测试模块未按默认值启用' };
            moduleRegistry.setEnabled('commission.io-test', false);
            const hiddenTestArea = document.querySelector('[data-commission-io-test]')?.hidden === true;
            const blockedPowerUp = await window.AutomationCadCommission.runPowerUp();
            const liveStatus = await window.desktop.plc.status();
            const connectionPreserved = liveStatus?.ok && liveStatus.data?.status === 'connected';
            const liveRead = await window.desktop.plc.readAll();
            const independentRead = liveRead?.ok && Object.keys(liveRead.data ?? {}).length === 28;
            await window.desktop.plc.disconnect();
            const savedPlc = await window.desktop.plc.getConfig();
            const independentConnect = savedPlc?.ok && savedPlc.data
              ? await window.desktop.plc.connect(savedPlc.data)
              : { ok: false, message: '未能读取仿真 PLC 配置' };
            const independentConnected = independentConnect?.ok === true && independentConnect?.data?.status === 'connected';
            if (independentConnected) await window.desktop.plc.disconnect();
            if (ioTestWasEnabled) moduleRegistry.setEnabled('commission.io-test', true);
            return { pointRows, monitorRows, machine3d, powerText, casePass, caseRows, failRows, exportButton, pdfPath, stats3d, failedCase, diagCodes, diagCards, hiddenTestArea, blockedPowerUp, connectionPreserved, independentRead, independentConnected };
          })()`
        ) as {
          error?: string;
          pointRows: number;
          monitorRows: number;
          machine3d: string;
          powerText: string;
          casePass: number;
          caseRows: number;
          failRows: number;
          exportButton: boolean;
          pdfPath: string;
          stats3d: {
            frames: number;
            ticks: number;
            parts: number;
            stations: number;
            sensors: number;
            actuators: number;
          } | null;
          failedCase: boolean;
          diagCodes: number;
          diagCards: number;
          hiddenTestArea?: boolean;
          blockedPowerUp?: boolean;
          connectionPreserved?: boolean;
          independentRead?: boolean;
          independentConnected?: boolean;
        };
        if (plcUi.error || plcUi.pointRows !== 28 || plcUi.monitorRows !== 28) {
          console.error('SMOKE_FAIL plc', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLC_OK points=${plcUi.pointRows}`);
        if (!plcUi.powerText.includes('6/6 通过') || plcUi.casePass !== 3 || plcUi.failRows !== 0) {
          console.error('SMOKE_FAIL commission', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_COMMISSION_OK steps=6 passed=6');
        if (plcUi.caseRows < 18 || !plcUi.exportButton) {
          console.error('SMOKE_FAIL commission_ui', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_UI_OK cases=3 monitor=${plcUi.monitorRows} results=${plcUi.caseRows}`);
        if (!plcUi.pdfPath || !existsSync(plcUi.pdfPath)) {
          console.error('SMOKE_FAIL commission_pdf', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_PDF_OK path=${plcUi.pdfPath}`);
        if (!plcUi.stats3d || plcUi.stats3d.frames < 3 || plcUi.stats3d.ticks < 3 || plcUi.stats3d.parts < 16) {
          console.error('SMOKE_FAIL commission_3d', JSON.stringify(plcUi.stats3d));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_3D_OK ticks=${plcUi.stats3d.ticks} parts=${plcUi.stats3d.parts}`);
        if (
          plcUi.stats3d.stations !== 4 ||
          plcUi.stats3d.actuators !== 12 ||
          plcUi.stats3d.sensors !== 16 ||
          plcUi.stats3d.parts < 16 ||
          plcUi.stats3d.ticks < 10
        ) {
          console.error('SMOKE_FAIL commission_3d_scale', JSON.stringify(plcUi.stats3d));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_3D_SCALE_OK stations=${plcUi.stats3d.stations} actuators=${plcUi.stats3d.actuators} sensors=${plcUi.stats3d.sensors} parts=${plcUi.stats3d.parts} ticks=${plcUi.stats3d.ticks}`);
        if (plcUi.failedCase !== false || plcUi.diagCodes < 1 || plcUi.diagCards < 1) {
          console.error('SMOKE_FAIL diagnose', JSON.stringify({ failedCase: plcUi.failedCase, diagCodes: plcUi.diagCodes, diagCards: plcUi.diagCards }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_DIAGNOSE_OK codes=${plcUi.diagCodes}`);
        if (plcUi.hiddenTestArea !== true || plcUi.blockedPowerUp !== false || plcUi.connectionPreserved !== true ||
            plcUi.independentRead !== true || plcUi.independentConnected !== true) {
          console.error('SMOKE_FAIL commission_module_boundary', JSON.stringify({
            hiddenTestArea: plcUi.hiddenTestArea,
            blockedPowerUp: plcUi.blockedPowerUp,
            connectionPreserved: plcUi.connectionPreserved,
            independentRead: plcUi.independentRead,
            independentConnected: plcUi.independentConnected
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_COMMISSION_MODULE_BOUNDARY_OK tests=MODULE_DISABLED livePlc=preserved/read/reconnected');
      } catch (error) {
        console.error('SMOKE_FAIL commission_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const activeTools = agentTools;
        if (!activeTools) throw new Error('Agent 工具尚未启动');
        const summaries = activeTools.summaries();
        if (
          summaries.length !== 25 ||
          !summaries.some((tool) => tool.name === 'design_machine') ||
          !summaries.some((tool) => tool.name === 'suggest_kinematics') ||
          !summaries.some((tool) => tool.name === 'apply_machine_design') ||
          !summaries.some((tool) => tool.name === 'build_canvas_assembly') ||
          !summaries.some((tool) => tool.name === 'save_scene_as_project') ||
          !summaries.some((tool) => tool.name === 'search_docs') ||
          !summaries.some((tool) => tool.name === 'run_electrical_check') ||
          !summaries.some((tool) => tool.name === 'run_cost_report') ||
          !summaries.some((tool) => tool.name === 'export_cost_report') ||
          !summaries.some((tool) => tool.name === 'place_component') ||
          !summaries.some((tool) => tool.name === 'verify_plc_program') ||
          !summaries.some((tool) => tool.name === 'get_project_context') ||
          !summaries.some((tool) => tool.name === 'get_render_stats') ||
          !summaries.some((tool) => tool.name === 'update_component') ||
          !summaries.some((tool) => tool.name === 'remove_component') ||
          !summaries.some((tool) => tool.name === 'run_plc_generate') ||
          !summaries.some((tool) => tool.name === 'export_files')
        ) {
          console.error('SMOKE_FAIL agent_tools', JSON.stringify(summaries.map((tool) => tool.name)));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_TOOLS_OK tools=${summaries.length} implemented=${summaries.length}`);
        console.log(`SMOKE_AGENT_TOOLS_V2 tools=${summaries.length}`);

        const machineDesign = await activeTools.call('design_machine', {
          brief: '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服',
          stationCount: 3
        }) as {
          ok?: boolean;
          design?: {
            config?: { stations?: unknown[]; actuators?: unknown[]; sensors?: unknown[] };
            cycle?: { perMin?: number; secondsPerPiece?: number };
            power?: {
              totalKw?: number;
              currentA?: number;
              breakerSuggestion?: { rating?: number; poles?: number };
              dc24?: { marginPct?: number } | null;
            };
            cost?: { total?: number; missingCount?: number; material?: number; electrical?: number; labor?: number };
            warnings?: string[];
            form?: { id?: string; stationRange?: number[] };
            assumptions?: unknown[];
          };
          summary?: string;
          message?: string;
        };
        if (
          !machineDesign.ok ||
          machineDesign.design?.config?.stations?.length !== 3 ||
          machineDesign.design?.config?.actuators?.length !== 6 ||
          machineDesign.design?.config?.sensors?.length !== 3 ||
          machineDesign.design?.cycle?.perMin !== 20 ||
          machineDesign.design?.cycle?.secondsPerPiece !== 3 ||
          !(Number(machineDesign.design?.power?.totalKw) > 0) ||
          !(Number(machineDesign.design?.power?.currentA) > 0) ||
          !(Number(machineDesign.design?.power?.breakerSuggestion?.rating) > 0) ||
          !(Number(machineDesign.design?.cost?.total) > 0) ||
          typeof machineDesign.design?.cost?.missingCount !== 'number' ||
          machineDesign.design?.warnings?.length !== 2 ||
          !machineDesign.design?.warnings?.some((warning: string) => /形态选型/.test(warning)) ||
          machineDesign.design?.form?.id !== 'linear-4' ||
          !(Number(machineDesign.design?.form?.stationRange?.[0]) <= 3 &&
            Number(machineDesign.design?.form?.stationRange?.[1]) >= 3) ||
          !Array.isArray(machineDesign.design?.assumptions) ||
          typeof machineDesign.summary !== 'string' ||
          machineDesign.summary.length > 600
        ) {
          console.error('SMOKE_FAIL machine_design', JSON.stringify(machineDesign));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=2 form=linear-4');
        console.log(
          `SMOKE_MACHINE_POWER_OK kw=${machineDesign.design.power?.totalKw} ` +
          `a=${machineDesign.design.power?.currentA} breaker=${machineDesign.design.power?.breakerSuggestion?.rating}`
        );
        console.log(
          `SMOKE_MACHINE_COST_OK total=${machineDesign.design.cost?.total} missing=${machineDesign.design.cost?.missingCount}`
        );

        const cycleDesign = await activeTools.call('design_machine', {
          brief: '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅'
        }) as {
          ok?: boolean;
          design?: {
            cycle?: {
              mode?: string;
              stationSeconds?: number;
              throughputPerMin?: number;
              meetsTarget?: boolean;
            };
          };
        };
        const cycle = cycleDesign.design?.cycle;
        if (
          !cycleDesign.ok ||
          cycle?.mode !== 'cell' ||
          cycle?.stationSeconds !== 3.18 ||
          Math.round(Number(cycle?.throughputPerMin)) !== 32 ||
          cycle?.meetsTarget !== true
        ) {
          console.error('SMOKE_FAIL machine_cycle', JSON.stringify(cycleDesign));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_MACHINE_CYCLE_OK mode=${cycle.mode} throughput=${Math.round(Number(cycle.throughputPerMin))} meets=${cycle.meetsTarget ? 1 : 0}`);

        const flowModels: FlowModel[] = [
          {
            layout: 'parallel',
            stations: 6,
            copies: 6,
            targetPerMin: 20,
            ops: [{ id: 'screw', name: '锁螺丝', seconds: 3.18, station: 0 }]
          },
          {
            layout: 'dial',
            stations: 3,
            indexSeconds: 0.6,
            targetPerMin: 20,
            ops: [
              { id: 'dial-load', name: '上料', seconds: 2.5, station: 0 },
              { id: 'dial-dispense', name: '点胶', seconds: 3, station: 1 },
              { id: 'dial-unload', name: '下料', seconds: 1.8, station: 2 }
            ]
          },
          {
            layout: 'linear',
            stations: 5,
            transferSeconds: 1.5,
            targetPerMin: 12,
            ops: [
              { id: 'line-load', name: '上料', seconds: 2, station: 0 },
              { id: 'line-press', name: '压装', seconds: 3.5, station: 1 },
              { id: 'line-screw', name: '锁螺丝', seconds: 2.5, station: 2 },
              { id: 'line-inspect', name: '检测', seconds: 4, station: 3 },
              { id: 'line-unload', name: '下料', seconds: 1.5, station: 4 }
            ]
          },
          {
            layout: 'single',
            stations: 1,
            targetPerMin: 12,
            ops: [
              { id: 'single-load', name: '上料', seconds: 1.5, station: 0 },
              { id: 'single-inspect', name: '检测', seconds: 2, station: 0 },
              { id: 'single-unload', name: '下料', seconds: 0.5, station: 0 }
            ]
          },
          {
            layout: 'cell',
            stations: 4,
            transferSeconds: 0.8,
            targetPerMin: 12,
            ops: [
              { id: 'cell-a1', name: '上料', seconds: 1.2, station: 0 },
              { id: 'cell-a2', name: '锁螺丝', seconds: 1.8, station: 0 },
              { id: 'cell-b1', name: '检测', seconds: 1.5, station: 1 },
              { id: 'cell-b2', name: '下料', seconds: 2.2, station: 1 }
            ]
          },
          {
            layout: 'parallel',
            stations: 2,
            copies: 2,
            targetPerMin: 30,
            ops: [{ id: 'parallel-dispense', name: '点胶', seconds: 2.8, station: 0 }]
          }
        ];
        const flowEvaluations = flowModels.map((model) => evaluateFlow(model));
        const flowModes = new Set(flowEvaluations.map((entry) => entry.mode));
        const flowOk = flowEvaluations.length === 6
          && flowModes.size === 5
          && flowEvaluations.every((entry) => Number.isFinite(entry.cycleSeconds) && entry.cycleSeconds > 0);
        if (!flowOk) {
          console.error('SMOKE_FAIL flow_engine', JSON.stringify(flowEvaluations.map((entry) => ({ mode: entry.mode, cycle: entry.cycleSeconds }))));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_FLOW_ENGINE_OK modes=${flowModes.size} archetypes=${flowEvaluations.length}`);

        const templateCount = Object.keys(TEMPLATES).length;
        const clarify = buildClarify(parseMachineBrief('随便设计一台检测机'));
        if (templateCount !== 6 || clarify.question === null || clarify.needs.length !== 2) {
          console.error('SMOKE_FAIL machine_templates', JSON.stringify({ templateCount, clarify }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_MACHINE_TEMPLATES_OK templates=6 clarify=1 multi=1');

        const formBrief = parseMachineBrief('十二工位转盘检测机，20 件/分钟');
        const formPick = pickForm(formBrief, TEMPLATES);
        const formErrors = validateMachineForms();
        if (
          MACHINE_FORMS.length !== 12 ||
          formErrors.length > 0 ||
          formPick.form.id !== 'dial-12' ||
          formPick.form.stationRange[0] > 12 ||
          formPick.form.stationRange[1] < 12 ||
          formPick.stations !== 12 ||
          formPick.evaluation.meetsTarget !== true
        ) {
          console.error('SMOKE_FAIL machine_forms', JSON.stringify({ forms: MACHINE_FORMS.length, formErrors, picked: formPick.form.id }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_MACHINE_FORMS_OK forms=12 picked=dial-12 meets=1');

        const applied = await activeTools.call('apply_machine_design', {
          brief: '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服',
          withPlc: true
        }) as {
          ok?: boolean;
          machineId?: string;
          stations?: number;
          actuators?: number;
          sensors?: number;
          bom?: { count?: number };
          bomPath?: string;
          plcPath?: string;
          designPath?: string;
          geometry?: {
            layout?: string;
            parts?: number;
            movingAxes?: number;
            envelopeMm?: number[];
            stlPath?: string;
            gltfPath?: string;
            jsonPath?: string;
            sidecarPath?: string;
            sidecarChunks?: number;
          };
          message?: string;
        };
        const appliedScene = await window.webContents.executeJavaScript(
          'window.__Commission3D?.stats?.()?.stations ?? -1'
        ) as number;
        const appliedGeometry = await window.webContents.executeJavaScript(
          '(() => { const s = window.__Commission3D?.stats?.(); return s ? { parts: s.geometryParts, layout: s.layout, envelope: s.envelopeMm } : null; })()'
        ) as { parts?: number; layout?: string; envelope?: number[] } | null;
        if (
          !applied.ok ||
          applied.stations !== 3 ||
          applied.actuators !== 6 ||
          applied.sensors !== 3 ||
          applied.bom?.count !== 7 ||
          !applied.bomPath || !existsSync(applied.bomPath) ||
          !applied.plcPath || !existsSync(applied.plcPath) ||
          !applied.designPath || !existsSync(applied.designPath) ||
          appliedScene !== 3
        ) {
          console.error('SMOKE_FAIL machine_apply', JSON.stringify({ ...applied, appliedScene }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        const machineGeometry = applied.geometry;
        if (
          !machineGeometry ||
          machineGeometry.layout !== 'linear' ||
          !(Number(machineGeometry.parts) > 0) ||
          machineGeometry.movingAxes !== 6 ||
          !machineGeometry.stlPath || !existsSync(machineGeometry.stlPath) ||
          !machineGeometry.gltfPath || !existsSync(machineGeometry.gltfPath) ||
          !machineGeometry.jsonPath || !existsSync(machineGeometry.jsonPath) ||
          !machineGeometry.sidecarPath || !existsSync(machineGeometry.sidecarPath) ||
          appliedGeometry?.parts !== machineGeometry.parts ||
          appliedGeometry?.layout !== 'linear'
        ) {
          console.error('SMOKE_FAIL machine_geometry', JSON.stringify({ geometry: machineGeometry, appliedGeometry }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        const undone = await activeTools.call('undo_last', {}) as {
          ok?: boolean;
          command?: string;
          message?: string;
        };
        const restoredScene = await window.webContents.executeJavaScript(
          'window.__Commission3D?.stats?.()?.stations ?? -1'
        ) as number;
        if (!undone.ok || undone.command !== 'apply_machine_design' || restoredScene !== 4) {
          console.error('SMOKE_FAIL machine_apply_undo', JSON.stringify({ undone, restoredScene }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        if (existsSync(machineGeometry.stlPath)) {
          console.error('SMOKE_FAIL machine_geometry_undo', JSON.stringify({ stlPath: machineGeometry.stlPath }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_MACHINE_APPLY_OK machine=${applied.machineId} stations=3 bom=7 undo=1`);
        console.log(`SMOKE_MACHINE_GEOMETRY_OK layout=${machineGeometry.layout} parts=${machineGeometry.parts} axes=${machineGeometry.movingAxes} envelope=${(machineGeometry.envelopeMm ?? []).map((value) => Math.round(value)).join('x')} chunks=${machineGeometry.sidecarChunks} scene=${appliedGeometry?.parts}`);

        // 几何联动（Electron 端与 Qt 同源）：时间线 + 帧 + 运动包络
        try {
          const linkage = await loadMachineLinkage(app.getAppPath(), '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅', 120);
          const io = linkage.io ?? {};
          const motion = linkage.motion ?? {};
          if (!linkage.steps?.length || !linkage.frames?.length) {
            console.error('SMOKE_FAIL machine_linkage', JSON.stringify({ steps: linkage.steps?.length, frames: linkage.frames?.length }));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_MACHINE_LINKAGE_OK axes=${linkage.axisCount} steps=${linkage.steps.length} cycleMs=${linkage.cycleMs} frames=${linkage.frames.length} ioMissing=${(io.missing ?? []).length} motionSuspects=${(motion.suspects ?? []).length} intra=${motion.intraStation ?? 0}`);
        } catch (error) {
          console.error('SMOKE_FAIL machine_linkage', error instanceof Error ? error.message : String(error));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const kbResult = await activeTools.call('search_docs', { query: 'D2', limit: 1 }) as {
          ok?: boolean;
          hits?: Array<{ source?: string; heading?: string; snippet?: string }>;
        };
        if (!kbResult?.ok || kbResult.hits?.length !== 1 || !kbResult.hits[0]?.source?.includes('docs/desktop/')) {
          console.error('SMOKE_FAIL agent_kb', JSON.stringify(kbResult));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_KB_OK docs=${KB_STATS.docs} chunks=${KB_STATS.chunks} query=D2 hits=${kbResult.hits.length}`);

        const bridgeState = await window.webContents.executeJavaScript(
          `(() => {
            const bridge = window.__AgentBridge;
            if (!bridge) return { ready: false, scene: 0, bom: 0, error: 'missing_bridge' };
            const scene = bridge.getScene();
            const bom = bridge.getBom();
            return {
              ready: bridge.ready() === true,
              scene: Array.isArray(scene?.parts) ? 1 : 0,
              bom: Array.isArray(bom) ? 1 : 0,
              plc: typeof bridge.getPlcGenConfig === 'function' && bridge.getPlcGenConfig() ? 1 : 0,
              error: (scene && scene.message) || (bom && bom.message) || ''
            };
          })()`
        ) as { ready: boolean; scene: number; bom: number; plc: number; error?: string };
        if (!bridgeState.ready || bridgeState.scene !== 1 || bridgeState.bom !== 1 || bridgeState.plc !== 1) {
          console.error('SMOKE_FAIL agent_bridge', JSON.stringify(bridgeState));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_BRIDGE_OK scene=${bridgeState.scene} bom=${bridgeState.bom}`);

        const chatUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('agentEntryButton');
            if (!entry) return { error: '智能体入口按钮缺失' };
            entry.click();
            let fields = 0;
            let log = 0;
            for (let attempt = 0; attempt < 50; attempt += 1) {
              await wait(100);
              const drawer = document.getElementById('agentDrawer');
              fields = drawer?.querySelectorAll('.acp-field').length || 0;
              log = drawer?.querySelectorAll('.acp-chat-log').length || 0;
              if (fields === 12 && log === 1) break;
            }
            const drawer = document.getElementById('agentDrawer');
            return {
              fields,
              log,
              send: Boolean(document.getElementById('agentChatSend')),
              input: Boolean(document.getElementById('agentChatInput')),
              apiKeyPassword: document.getElementById('agentLlmApiKey')?.type === 'password',
              uiScale: Boolean(document.getElementById('agentUiScale')),
              renderQuality: Boolean(document.getElementById('agentRenderQuality')),
              lanAllowlist: Boolean(document.getElementById('agentLanAllowlist')),
              cdpSwitch: Boolean(document.getElementById('agentCdpEnabled')),
              visible: Boolean(drawer && !drawer.hidden)
            };
          })()`
        ) as {
          error?: string;
          fields: number;
          log: number;
          send: boolean;
          input: boolean;
          apiKeyPassword: boolean;
          uiScale: boolean;
          renderQuality: boolean;
          lanAllowlist: boolean;
          cdpSwitch: boolean;
          visible: boolean;
        };
        if (chatUi.error || chatUi.fields !== 12 || chatUi.log !== 1 ||
            !chatUi.send || !chatUi.input || !chatUi.apiKeyPassword || !chatUi.visible ||
            !chatUi.uiScale || !chatUi.renderQuality || !chatUi.lanAllowlist || !chatUi.cdpSwitch) {
          console.error('SMOKE_FAIL agent_chat_ui', JSON.stringify(chatUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_CHAT_UI_OK fields=${chatUi.fields} log=${chatUi.log}`);

        // P7-I：流程下拉、步骤预览与「开始 / 导出执行记录」按钮。
        const recipeUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const select = document.getElementById('agentRecipeSelect');
            const panel = document.getElementById('agentRecipePanel');
            if (!select || !panel) return { error: 'missing_recipe_panel' };
            const options = select.querySelectorAll('option').length;
            const before = panel.querySelectorAll('.acp-recipe-step').length;
            select.value = 'cost-review';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(80);
            const after = panel.querySelectorAll('.acp-recipe-step').length;
            return {
              options,
              before,
              after,
              start: Boolean(document.getElementById('agentRecipeStart')),
              exportButton: Boolean(document.getElementById('agentRecipeExport')),
              preconditions: panel.querySelectorAll('.acp-recipe-pre').length,
              remember: document.getElementById('agentRecipeRemember')?.checked === false
            };
          })()`
        ) as {
          error?: string;
          options: number;
          before: number;
          after: number;
          start: boolean;
          exportButton: boolean;
          preconditions: number;
          remember: boolean;
        };
        if (
          recipeUi.error || recipeUi.options !== 5 || recipeUi.before !== 5 ||
          recipeUi.after !== 4 || !recipeUi.start || !recipeUi.exportButton ||
          recipeUi.preconditions !== 1 || !recipeUi.remember
        ) {
          console.error('SMOKE_FAIL agent_recipe_ui', JSON.stringify(recipeUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_RECIPE_UI_OK recipes=${recipeUi.options} steps=${recipeUi.before}`);

        // P7-A-2：侧栏计划预览（只读可离线 / 写操作需联网）+ 审计面板
        const auditUiFile = join(app.getPath('userData'), 'agent-audit.jsonl');
        appendFileSync(
          auditUiFile,
          `${formatAuditLine({ tool: 'run_cost_report', ok: true, source: 'offline' })}\n` +
          `${formatAuditLine({ tool: 'export_cost_report', ok: false, code: 'USER_DENIED', source: 'llm' })}\n`,
          'utf8'
        );

        const readonlyUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const box = document.getElementById('agentPlanPreview');
            if (!input || !box) return { error: 'missing_preview' };
            const sceneParts = () => {
              const scene = window.__AgentBridge?.getScene?.();
              return Array.isArray(scene?.parts) ? scene.parts.length : -1;
            };
            const before = sceneParts();
            const type = async (text) => {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(80);
              return {
                tool: box.dataset.tool || '',
                readOnly: box.dataset.readOnly || '',
                offline: box.dataset.offline || '',
                title: document.getElementById('agentPlanTitle')?.textContent || '',
                hint: document.getElementById('agentPlanHint')?.textContent || ''
              };
            };
            const read = await type('列一下所有接触器');
            const write = await type('插入一个气缸');
            const after = sceneParts();
            document.getElementById('agentAuditRefresh')?.click();
            let rows = 0;
            let summary = '';
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await wait(100);
              rows = document.querySelectorAll('#agentAuditList .acp-audit-row').length;
              summary = document.getElementById('agentAuditSummary')?.textContent || '';
              if (rows >= 2) break;
            }
            const firstRow = document.querySelector('#agentAuditList .acp-audit-row')?.textContent || '';
            return { before, after, read, write, rows, summary, firstRow };
          })()`
        ) as {
          error?: string;
          before: number;
          after: number;
          read: { tool: string; readOnly: string; offline: string; title: string; hint: string };
          write: { tool: string; readOnly: string; offline: string; title: string; hint: string };
          rows: number;
          summary: string;
          firstRow: string;
        };
        if (
          readonlyUi.error ||
          readonlyUi.read?.tool !== 'list_components' ||
          readonlyUi.read?.readOnly !== '1' ||
          readonlyUi.read?.offline !== '1' ||
          readonlyUi.write?.tool !== 'insert_component' ||
          readonlyUi.write?.readOnly !== '0' ||
          readonlyUi.write?.offline !== '0' ||
          !readonlyUi.write?.hint.includes('partId') ||
          readonlyUi.rows < 2 ||
          !readonlyUi.summary.includes('共 2 条') ||
          readonlyUi.before !== readonlyUi.after
        ) {
          console.error('SMOKE_FAIL agent_readonly_ui', JSON.stringify(readonlyUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=${readonlyUi.rows} summary=ok scene=${readonlyUi.after}`);

        // 迭代：审计轮转——审计面板经 agent:audit:read 同时读到轮转文件 agent-audit.1.jsonl
        appendFileSync(
          join(app.getPath('userData'), 'agent-audit.1.jsonl'),
          `${formatAuditLine({ tool: 'get_bom', ok: true, source: 'offline' }, new Date(Date.now() - 60_000))}\n{坏行\n`,
          'utf8'
        );
        const rotatedUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            document.getElementById('agentAuditRefresh')?.click();
            let rows = 0;
            let summary = '';
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await wait(100);
              rows = document.querySelectorAll('#agentAuditList .acp-audit-row').length;
              summary = document.getElementById('agentAuditSummary')?.textContent || '';
              if (summary.includes('共 3 条')) break;
            }
            return { rows, summary };
          })()`
        ) as { rows: number; summary: string };
        if (rotatedUi.rows < 3 || !rotatedUi.summary.includes('共 3 条')) {
          console.error('SMOKE_FAIL agent_audit_rotated', JSON.stringify(rotatedUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_AUDIT_ROTATED_OK rows=${rotatedUi.rows} files=2`);

        // P7-C：多步计划卡片 + 顺序执行 + 写步骤一次确认
        const planUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const card = document.getElementById('agentPlanCard');
            if (!input || !card) return { error: 'missing_plan_card' };
            input.value = '读一下当前 BOM，算一下成本，然后导出 CSV 报价单';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(120);
            return {
              hidden: card.hidden === true,
              steps: card.querySelectorAll('.acp-plan-step').length,
              tools: Array.from(card.querySelectorAll('.acp-plan-step')).map((node) => node.dataset.tool || ''),
              runAll: Boolean(document.getElementById('agentPlanRunAll')),
              runStep: Boolean(document.getElementById('agentPlanRunStep')),
              cancel: Boolean(document.getElementById('agentPlanCancel')),
              meta: document.getElementById('agentPlanCardMeta')?.textContent || ''
            };
          })()`
        ) as {
          error?: string;
          hidden: boolean;
          steps: number;
          tools: string[];
          runAll: boolean;
          runStep: boolean;
          cancel: boolean;
          meta: string;
        };
        if (
          planUi.error ||
          planUi.hidden ||
          planUi.steps !== 3 ||
          planUi.tools.join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          !planUi.runAll || !planUi.runStep || !planUi.cancel ||
          !planUi.meta.includes('3 步')
        ) {
          console.error('SMOKE_FAIL agent_plan_ui', JSON.stringify(planUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const planRunUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const card = document.getElementById('agentPlanCard');
            if (!input || !card) return { error: 'missing_plan_card' };
            input.value = '读一下当前 BOM，然后查一下 24V 开关电源';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            const steps = card.querySelectorAll('.acp-plan-step').length;
            document.getElementById('agentPlanRunAll')?.click();
            let done = 0;
            let failed = 0;
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await wait(100);
              done = card.querySelectorAll('.acp-plan-step.is-done').length;
              failed = card.querySelectorAll('.acp-plan-step.is-fail').length;
              if (done + failed >= steps && steps > 0) break;
            }
            return {
              steps,
              done,
              failed,
              feedback: document.getElementById('agentPlanFeedback')?.textContent || ''
            };
          })()`
        ) as { error?: string; steps: number; done: number; failed: number; feedback: string };
        if (planRunUi.error || planRunUi.steps !== 2 || planRunUi.done !== 2 || planRunUi.failed !== 0) {
          console.error('SMOKE_FAIL agent_plan_run_ui', JSON.stringify(planRunUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const planned = plan('读一下当前 BOM，算一下成本，然后导出 CSV 报价单');
        let planConfirms = 0;
        const planTools: string[] = [];
        const planResult = await executePlan(planned, {
          confirmPlan: async (request) => {
            planConfirms += 1;
            return request.steps.length === 3 && request.writeIndexes.length === 1;
          },
          execute: async (step) => {
            planTools.push(step.tool);
            if (step.tool === 'export_cost_report') {
              // 冒烟不落盘：写步骤只验证执行器顺序与确认，不制造临时文件。
              return { ok: true, data: { simulated: true, format: step.args.format } };
            }
            if (!agentTools) return { ok: false, code: 'AGENT_UNAVAILABLE', message: '工具未启动' };
            return await agentTools.call(step.tool, step.args);
          }
        });
        if (
          planned.steps.length !== 3 ||
          planned.steps.map((step) => step.tool).join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          planConfirms !== 1 ||
          planTools.join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          !planResult.ok ||
          !planResult.confirmationRequired ||
          !planResult.confirmed ||
          planResult.results.length !== 3 ||
          planResult.results.some((item) => !item.ok)
        ) {
          console.error('SMOKE_FAIL agent_plan', JSON.stringify({
            steps: planned.steps.map((step) => step.tool),
            planConfirms,
            planTools,
            planResult
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_PLAN_OK steps=${planned.steps.length} confirm=${planConfirms}`);

        // P7-I：流程模板执行——5 个模板、5 步流程、第 3 步注入失败、保留前 2 步。
        const recipeSmoke = await runRecipe('new-machine', {
          machine: { name: 'SF-2026-01' },
          cadPath: 'D:\\models\\smoke.step'
        }, {
          confirm: async () => true,
          execute: async (step) => {
            if (step.id === 'interference') {
              return { ok: false, code: 'SMOKE_INJECTED', message: '冒烟注入失败' };
            }
            return { ok: true, data: { smoke: step.id } };
          }
        });
        const recipeFailed = recipeSmoke.results.filter((item) => !item.ok && !item.skipped).length;
        if (
          RECIPES.length !== 5 ||
          (RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0) !== 5 ||
          recipeSmoke.ok ||
          recipeFailed !== 1 ||
          recipeSmoke.kept.length !== 2
        ) {
          console.error('SMOKE_FAIL agent_recipe', JSON.stringify({
            recipes: RECIPES.length,
            steps: (RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0),
            failed: recipeFailed,
            kept: recipeSmoke.kept.length,
            summary: recipeSmoke.summary
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_RECIPE_OK recipes=${RECIPES.length} steps=${(RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0)} failed=${recipeFailed} kept=${recipeSmoke.kept.length}`);

        // P7-A：离线规则路由 + 上下文裁剪 + 审计脱敏（无网络也必须是真实覆盖）
        const nlSamples = [
          '列一下所有接触器',
          '搜一下 SMC 气缸',
          '读一下当前 BOM',
          '这台机台成本多少',
          '检查有没有干涉',
          '电气校验线号有没有重复',
          '上电跑一遍联调序列',
          '把设计包同步到智慧工厂',
          '导出报价单 CSV',
          '插入一个气缸',
          '今天天气怎么样'
        ];
        const intents = nlSamples.map((sample) => routeIntent(sample));
        const intentKinds = new Set(intents.map((item) => item.intent));
        const readOnlyPlans = nlSamples
          .map((sample) => ({ sample, plan: planTool(sample), readOnly: planReadOnly(sample) }))
          .filter((item) => item.plan !== null);
        const leakedWrite = nlSamples.filter((sample) => {
          const plan = planTool(sample);
          return plan !== null && !plan.readOnly && planReadOnly(sample) !== null;
        });
        const costPlan = planReadOnly('这台机台成本多少');
        const listPlan = planReadOnly('列一下所有接触器');
        if (
          intentKinds.size !== 7 ||
          leakedWrite.length > 0 ||
          readOnlyPlans.length < 8 ||
          costPlan?.tool !== 'run_cost_report' ||
          listPlan?.tool !== 'list_components' ||
          listPlan.args.category !== '接触器'
        ) {
          console.error('SMOKE_FAIL agent_nl_router', JSON.stringify({
            intents: Array.from(intentKinds),
            leakedWrite,
            plans: readOnlyPlans.map((item) => `${item.sample}->${item.plan?.tool}`)
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const packed = buildAgentContext({
          project: '烟包机',
          deviceNo: 'SF-2026-01',
          domain: '电气',
          view: '底板',
          selection: { id: 'iC65N-C16-1P', tag: 'QF1' },
          recent: Array.from({ length: 6 }, (_unused, index) => ({ name: `op-${index}`, ok: index % 2 === 0 })),
          tools: (agentTools?.summaries() ?? []).map((tool) => ({ name: tool.name, description: tool.description }))
        });
        if (packed.bytes > 2048 || packed.toolCount === 0) {
          console.error('SMOKE_FAIL agent_context', JSON.stringify({ bytes: packed.bytes, tools: packed.toolCount }));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const uiContext = collectAgentContext({
          projectContext: () => ({
            domain: 'elec',
            view: '底板',
            selection: { kind: 'placement', id: 'p1', label: 'QF1' },
            machine: { name: '烟包机', stations: 4, actuators: 8, sensors: 12 },
            plate: {
              width: 600,
              height: 400,
              placed: 3,
              overlaps: 0,
              placements: [
                { id: 'p1', tag: 'QF1', model: 'iC65N-C16-1P', x: 200, y: 40, w: 36, h: 80 },
                { id: 'p2', tag: 'KM1', model: 'LC1D09', x: 20, y: 40, w: 45, h: 80 },
                { id: 'p3', tag: 'KA1', model: 'RXM2AB2BD', x: 80, y: 200, w: 30, h: 60 }
              ]
            },
            units: 'mm'
          }),
          recentActions: () => [
            { tool: 'search_components', summary: 'search_components 成功', at: '2026-10-23T00:00:01Z' },
            { tool: 'get_bom', summary: 'get_bom 成功', at: '2026-10-23T00:00:02Z' },
            { tool: 'run_cost_report', summary: 'run_cost_report 成功', at: '2026-10-23T00:00:03Z' },
            { tool: 'place_component', summary: 'place_component 成功 [target=placement:p1:QF1]', at: '2026-10-23T00:00:04Z' }
          ]
        }, () => '2026-10-23T00:00:05Z');
        const serializedContext = serializeAgentContext(uiContext);
        const deictic = resolveReference('把它改一下', uiContext);
        const geometry = resolveReference('左边第二个', uiContext);
        const trimmed = trimListResult(Array.from({ length: 25 }, (_unused, index) => ({ index })));
        if (
          serializedContext.bytes > 1536 ||
          uiContext.selection === null ||
          uiContext.recentActions.length !== 3 ||
          deictic.target?.id !== 'p1' ||
          geometry.target?.id !== 'p3' ||
          trimmed.items.length !== 20 ||
          trimmed.total !== 25 ||
          !trimmed.truncated
        ) {
          console.error('SMOKE_FAIL agent_context_snapshot', JSON.stringify({
            bytes: serializedContext.bytes,
            selection: uiContext.selection,
            recent: uiContext.recentActions.length,
            deictic,
            geometry,
            trimmed: { items: trimmed.items.length, total: trimmed.total, truncated: trimmed.truncated }
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_AGENT_CONTEXT_OK selection=1 recent=3');

        // 上下文预算：长列表先首尾收敛、history 先丢、system 永不裁。
        const budgetPayload = {
          system: '你是 AutomationCAD 的桌面智能体。所有写操作必须先确认。',
          selection: '选中：QF1（iC65N-C16-1P）\n机型：烟包机 · 4 工位',
          memory: '最近工具调用：get_bom → OK',
          docs: Array.from({ length: 24 }, (_unused, index) => `doc-${index}: 文档摘要 ${'说明'.repeat(18)}`),
          toolResults: Array.from({ length: 36 }, (_unused, index) => `tool-${index}: ${'结果'.repeat(22)}`),
          history: Array.from({ length: 40 }, (_unused, index) => `turn-${index}: 历史消息 ${'上下文'.repeat(16)}`)
        };
        const budgeted = pack(budgetPayload, {
          total: 420,
          caps: { history: 160, docs: 140, toolResults: 180 },
          listHead: 5,
          listTail: 5
        });
        const budgetSampleTokens = estimateTokens(`${'中文上下文'.repeat(20)}${'token budget '.repeat(20)}`);
        const budgetHasSystem = budgeted.text.includes('所有写操作必须先确认');
        const budgetDropSections = budgeted.dropped.map((entry) => entry.section);
        if (
          budgeted.used > 420 ||
          !budgetHasSystem ||
          budgeted.dropped.length === 0 ||
          budgetDropSections.indexOf('history') === -1 ||
          budgeted.docsSources < 0 ||
          budgetSampleTokens <= 0
        ) {
          console.error('SMOKE_FAIL agent_budget', JSON.stringify({
            used: budgeted.used,
            docsSources: budgeted.docsSources,
            system: budgetHasSystem,
            dropped: budgeted.dropped
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_BUDGET_OK used=${budgeted.used} dropped=${budgeted.dropped.length} tokens=${budgetSampleTokens}`);

        // P7-L：多轮状态、续跑跳过、工程变化拒续跑（3 轮状态写入）。
        const threadSmoke = new AgentThread();
        threadSmoke.write({
          turnId: 1,
          projectFingerprint: projectFingerprint(uiContext),
          intent: 'modify',
          targets: ['QF1'],
          denials: [],
          completedSteps: [{ step: 1, index: 0, tool: 'get_bom', ok: true, wrote: false }],
          lastReplySummary: '已读取 BOM'
        });
        const threadPlan = plan('读一下 BOM，算一下成本，然后导出 CSV 报价单');
        const smokeResumeRuns: number[] = [];
        const smokeResume = await runPlan(threadPlan, {
          resumeFrom: 0,
          previous: threadSmoke.read(),
          currentContext: uiContext,
          thread: threadSmoke,
          confirmPlan: async () => true,
          execute: async (step, index) => {
            smokeResumeRuns.push(index);
            return { ok: true, data: { tool: step.tool } };
          }
        });
        const smokeChangedContext = {
          ...uiContext,
          machine: { ...uiContext.machine!, name: '装盒机' },
          bomRows: 7
        };
        let smokeStaleRuns = 0;
        const smokeStale = await runPlan(threadPlan, {
          resumeFrom: 0,
          previous: threadSmoke.read(),
          currentContext: smokeChangedContext,
          execute: async () => {
            smokeStaleRuns += 1;
            return { ok: true };
          }
        });
        threadSmoke.finish({
          intent: 'modify',
          context: uiContext,
          completedSteps: [],
          reply: '已读取上一轮状态'
        });
        const smokeThreadPrompt = formatThreadContext(threadSmoke.read(), smokeChangedContext);
        const smokeTurns = threadSmoke.read()?.turnId ?? 0;
        if (
          smokeResume.resumedFrom !== 1 ||
          smokeResume.skippedSteps !== 1 ||
          smokeResumeRuns.join(',') !== '1,2' ||
          smokeStale.stale !== true ||
          smokeStaleRuns !== 0 ||
          !smokeThreadPrompt.includes('工程已变化，不要沿用旧结论') ||
          smokeTurns !== 3
        ) {
          console.error('SMOKE_FAIL agent_thread', JSON.stringify({
            resumedFrom: smokeResume.resumedFrom,
            skippedSteps: smokeResume.skippedSteps,
            resumed: smokeResumeRuns,
            stale: smokeStale.stale,
            staleRuns: smokeStaleRuns,
            turns: smokeTurns,
            prompt: smokeThreadPrompt
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1');

        // P2：跨进程计划 checkpoint 序列化与已完成写步骤去重。
        const checkpointDir = mkdtempSync(join(tmpdir(), 'automationcad-agent-plan-checkpoint-'));
        try {
          const checkpointWriteStep = {
            tool: 'update_component',
            args: { ref: 'QF1', patch: { model: 'A' } },
            why: '写',
            readOnly: false
          };
          const checkpointPlan = {
            steps: [
              checkpointWriteStep,
              { tool: 'get_bom', args: {}, why: '读', readOnly: true }
            ],
            confidence: 1
          };
          let checkpoint = createPlanCheckpoint(checkpointPlan, 'c'.repeat(64));
          checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed');
          savePlanCheckpoint(checkpointDir, checkpoint);
          const reloaded = loadPlanCheckpoint(checkpointDir).checkpoint;
          const recovered = reloaded ? inspectPlanCheckpoint(reloaded, checkpointPlan, 'c'.repeat(64)) : null;
          const replayed = recovered?.ok === true
            ? recovered.steps.slice(recovered.cursor).some((step) => step.index === 0)
            : true;
          let interruptedWrite = createPlanCheckpoint({ steps: [checkpointWriteStep], confidence: 1 }, 'c'.repeat(64));
          interruptedWrite = updatePlanCheckpoint(interruptedWrite, 0, 'running');
          const uncertain = inspectPlanCheckpoint(interruptedWrite, { steps: [checkpointWriteStep], confidence: 1 }, 'c'.repeat(64));
          if (!recovered?.ok || recovered.cursor !== 1 || recovered.steps[0]?.state !== 'completed' || replayed || uncertain.ok) {
            throw new Error('completed write replay or uncertain write resume was not blocked');
          }
          console.log('SMOKE_AGENT_PLAN_CHECKPOINT_OK cursor=1 completed_write=1 uncertain_write=blocked');
        } finally {
          rmSync(checkpointDir, { recursive: true, force: true });
        }

        // agent.resume 关闭时 IPC 不读写旧 checkpoint，但普通计划和写确认继续工作。
        const resumeCheckpointPath = join(app.getPath('userData'), 'agent-plan-checkpoint.json');
        const resumeCheckpointSentinel = '{"corrupt":"preserve-while-agent-resume-disabled"}';
        const resumeGatePlan = {
          steps: [{ tool: 'get_project_context', args: {}, why: '只读 gate smoke', readOnly: true }],
          confidence: 1
        };
        const resumeWritePlan = {
          steps: [{
            tool: 'update_component',
            args: { ref: '__agent_resume_smoke_missing_component__', patch: { model: 'smoke' } },
            why: '确认回调 smoke',
            readOnly: false
          }],
          confidence: 1
        };
        writeFileSync(resumeCheckpointPath, resumeCheckpointSentinel, { mode: 0o600 });
        const previousAutoConfirm = process.env.AUTOMATIONCAD_AUTOCONFIRM;
        process.env.AUTOMATIONCAD_AUTOCONFIRM = '1';
        try {
          const disabledGate = await window.webContents.executeJavaScript(
            `(async () => {
              const registry = window.__ModuleRegistry;
              registry.setEnabled('agent.resume', false);
              const restoreOff = await window.desktop.agent.plan.restore({ plan: ${JSON.stringify(resumeGatePlan)} });
              const clearOff = await window.desktop.agent.plan.clearCheckpoint();
              const ordinary = await window.desktop.agent.plan.execute({ plan: ${JSON.stringify(resumeGatePlan)} });
              const write = await window.desktop.agent.plan.execute({ plan: ${JSON.stringify(resumeWritePlan)} });
              return {
                disabled: registry.getStatus('agent.resume').status === 'disabled'
                && restoreOff.disabled === true && restoreOff.available === false
                && clearOff.ok === false && clearOff.code === 'MODULE_DISABLED',
                ordinaryPlanOk: ordinary.ok === true && ordinary.results?.some((step) => step.ok === true) === true,
                writeConfirmations: write.confirmations ?? 0
              };
            })()`
          ) as {
            disabled: boolean;
            ordinaryPlanOk: boolean;
            writeConfirmations: number;
          };
          const filePreserved = readFileSync(resumeCheckpointPath, 'utf8') === resumeCheckpointSentinel;
          if (!disabledGate.disabled || !filePreserved || !disabledGate.ordinaryPlanOk || disabledGate.writeConfirmations !== 1) {
            throw new Error(`Agent resume disabled boundary failed: ${JSON.stringify({ ...disabledGate, filePreserved })}`);
          }
          rmSync(resumeCheckpointPath, { force: true });
          const noCheckpointPlan = await window.webContents.executeJavaScript(
            `window.desktop.agent.plan.execute({ plan: ${JSON.stringify(resumeGatePlan)} })`
          ) as { ok: boolean };
          const newCheckpointNotCreated = noCheckpointPlan.ok === true && !existsSync(resumeCheckpointPath);
          if (!newCheckpointNotCreated) throw new Error('agent.resume 关闭时普通计划创建了 checkpoint');
          // 再放回旧损坏记录，验证重新启用后仍由正常恢复校验拒绝。
          writeFileSync(resumeCheckpointPath, resumeCheckpointSentinel, { mode: 0o600 });
          const reenabledGate = await window.webContents.executeJavaScript(
            `(async () => {
              const registry = window.__ModuleRegistry;
              registry.setEnabled('agent.resume', true);
              const restored = await window.desktop.agent.plan.restore({ plan: ${JSON.stringify(resumeGatePlan)} });
              const cleanup = await window.desktop.agent.plan.clearCheckpoint();
              return {
                validated: registry.getStatus('agent.resume').enabled
                  && restored.available === true && restored.blocked === true,
                cleanupOk: cleanup.ok === true
              };
            })()`
          ) as { validated: boolean; cleanupOk: boolean };
          if (!reenabledGate.validated || !reenabledGate.cleanupOk) {
            throw new Error(`Agent resume re-enable validation failed: ${JSON.stringify(reenabledGate)}`);
          }
          console.log('SMOKE_AGENT_RESUME_MODULE_OK disabled=blocked file=preserved ordinary=ok write-confirmation=1 reenabled=validated');
        } finally {
          await window.webContents.executeJavaScript("window.__ModuleRegistry?.setEnabled('agent.resume', true)").catch(() => undefined);
          if (previousAutoConfirm === undefined) delete process.env.AUTOMATIONCAD_AUTOCONFIRM;
          else process.env.AUTOMATIONCAD_AUTOCONFIRM = previousAutoConfirm;
          rmSync(resumeCheckpointPath, { force: true });
        }

        // P7-N：去重 / 只读并行 / 会话缓存
        const smokeDedupe = new TurnCallDeduper({ isWrite: () => false });
        const smokeDedupeDecisions = smokeDedupe.plan([
          { tool: 'search_components', args: { q: 'SMC' } },
          { tool: 'search_components', args: { q: ' SMC ' } },
          { tool: 'search_components', args: { q: 'SMC' } }
        ]);
        const dedupeCount = smokeDedupeDecisions.filter((decision) => decision.action === 'reuse').length;
        const parallelSummary = await runReadOnlyBatch([0, 1], async (item) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return item;
        }, { concurrency: 3 });
        const smokeCache = new ToolResultCache({ now: () => 1_000 });
        smokeCache.set('get_bom', {}, 'machine=smoke;bom=1;placed=0;cad=0', { ok: true, data: { rows: 1 } });
        const cacheCount = smokeCache.get('get_bom', {}, 'machine=smoke;bom=1;placed=0;cad=0').hit ? 1 : 0;
        if (dedupeCount !== 2 || parallelSummary.maxConcurrency !== 2 || cacheCount !== 1) {
          console.error('SMOKE_FAIL agent_efficiency', JSON.stringify({
            dedupe: dedupeCount,
            parallel: parallelSummary.maxConcurrency,
            cache: cacheCount
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_EFFICIENCY_OK dedupe=${dedupeCount} parallel=${parallelSummary.maxConcurrency} cache=${cacheCount}`);

        const auditPath = join(app.getPath('userData'), 'agent-audit-smoke.jsonl');
        const auditLog = createAuditLog({ write: (line) => appendFileSync(auditPath, `${line}\n`, 'utf8') });
        auditLog.record({ tool: 'run_cost_report', ok: true, source: 'offline', args: { bom: [], apiKey: 'sk-live-abcdef123456' }, docsSources: 2 });
        auditLog.record({ tool: 'search_components', ok: false, code: 'NO_RESULT', source: 'llm', args: { q: '接触器' }, promptTokens: 120, completionTokens: 34, estimated: false });
        auditLog.record({ tool: 'export_cost_report', ok: true, source: 'llm', args: { format: 'csv', token: 'tp-9f8e7d6c5b4a' } });
        const auditRaw = readFileSync(auditPath, 'utf8');
        const auditEntries = parseAuditLines(auditRaw);
        if (auditEntries.length !== 3 || auditRaw.includes('abcdef123456') || auditRaw.includes('9f8e7d6c5b4a')) {
          console.error('SMOKE_FAIL agent_audit', JSON.stringify({ count: auditEntries.length, leaked: true }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_NL_OK intents=${intentKinds.size} tools=${summaries.length} audit=${auditEntries.length} ctx=${packed.bytes}`);

        // P7-F：执行进度、失败建议、取消与审计面板数据源
        const uxProgress: Array<{ phase: string; index: number; total: number; tool: string; argsSummary: string }> = [];
        let uxTurn = 0;
        const uxLlm = {
          async chat() {
            uxTurn += 1;
            if (uxTurn === 1) {
              return {
                content: '',
                toolCalls: [
                  { id: 'ux-1', type: 'function' as const, function: { name: 'search_components', arguments: JSON.stringify({ q: 'SMC', apiKey: 'sk-live-ux-secret' }) } },
                  { id: 'ux-2', type: 'function' as const, function: { name: 'get_bom', arguments: '{}' } },
                  { id: 'ux-3', type: 'function' as const, function: { name: 'run_electrical_check', arguments: '{}' } }
                ]
              };
            }
            return { content: '三步完成', toolCalls: [] };
          }
        };
        const uxBus = {
          async execute(name: string) {
            return { ok: true, data: { name } };
          },
          async undoLast() {
            return { ok: true, data: {} };
          }
        };
        const uxAudit = createAuditLog({ write: () => {} });
        const uxSession = new AgentSession({
          llm: uxLlm,
          bus: uxBus,
          confirmWrite: async () => true,
          audit: (record) => uxAudit.record(record)
        });
        const uxReply = await uxSession.run('执行三步', {
          runId: 'smoke-ux',
          onProgress: (event) => uxProgress.push({
            phase: event.phase,
            index: event.index,
            total: event.total,
            tool: event.tool,
            argsSummary: event.argsSummary
          })
        });
        const uxStarts = uxProgress.filter((event) => event.phase === 'start');
        const uxEnds = uxProgress.filter((event) => event.phase === 'end');

        const uxController = new AbortController();
        const uxCancelSession = new AgentSession({
          llm: {
            async chat() {
              return {
                content: '',
                toolCalls: [{ id: 'ux-cancel', type: 'function' as const, function: { name: 'get_bom', arguments: '{}' } }]
              };
            }
          },
          bus: {
            async execute() {
              return await new Promise(() => {});
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          confirmWrite: async () => true
        });
        const uxCancelRun = uxCancelSession.run('取消', { signal: uxController.signal, runId: 'smoke-cancel' });
        setTimeout(() => uxController.abort(), 15);
        let uxCancelOk = 0;
        try {
          await uxCancelRun;
        } catch (error) {
          if (error instanceof AgentCancelledError && /已取消，未写入任何更改/.test(error.message)) uxCancelOk = 1;
        }
        const uxSuggestion = suggestFailure({ code: 'PART_NOT_FOUND', args: { model: 'MXQ99' }, tool: 'update_component' });
        if (
          uxReply !== '三步完成' ||
          uxStarts.length !== 3 ||
          uxEnds.length !== 3 ||
          uxStarts.some((event) => event.total !== 3 || !event.argsSummary) ||
          uxStarts[0]?.argsSummary.includes('ux-secret') ||
          uxAudit.entries.length !== 3 ||
          uxCancelOk !== 1 ||
          !uxSuggestion.advice.includes('search_components')
        ) {
          console.error('SMOKE_FAIL agent_ux', JSON.stringify({
            reply: uxReply,
            starts: uxStarts.length,
            ends: uxEnds.length,
            audit: uxAudit.entries.length,
            cancel: uxCancelOk
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_UX_OK steps=${uxStarts.length} audit=${uxAudit.entries.length} cancel=${uxCancelOk}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const advisorContext = {
          ...emptyAgentContext(),
          domain: 'mech' as const,
          plate: { width: 600, height: 400, placed: 7, overlaps: 3 }
        };
        const suggestions = suggestNextActions(advisorContext, {
          bomRows: 12,
          unplaced: 1,
          conflicts: null,
          missingDimensions: 5,
          hasCadModel: true,
          elecCheckPassed: true,
          elecIssueCount: 0,
          costStale: false,
          plcGenerated: false
        });
        if (
          suggestions.length !== 3 ||
          suggestions[0]?.id !== 'overlap' ||
          suggestions.some((suggestion) => !suggestion.why || !/\d/.test(suggestion.why))
        ) {
          console.error('SMOKE_FAIL agent_advisor', JSON.stringify(suggestions.map((suggestion) => ({
            id: suggestion.id,
            why: suggestion.why
          }))));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_ADVISOR_OK suggestions=${suggestions.length} top=${suggestions[0]?.id}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_advisor_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const repairSchema = {
          type: 'object',
          properties: {
            q: { type: 'string' },
            x: { type: 'number' },
            qty: { type: 'integer' },
            enabled: { type: 'boolean' }
          },
          additionalProperties: false
        };
        const repairCases = [
          { raw: '```json\n{"q":"SMC"}\n```', expect: true },
          { raw: '结果如下：{"q":"SMC"} 请执行', expect: true },
          { raw: "{'q':'SMC'}", expect: true },
          { raw: '{"q":"SMC",}', expect: true },
          { raw: '{"q":"SMC" // 型号\n}', expect: true },
          { raw: '{"x":"120mm"}', expect: true },
          { raw: '{"q":"SMC"', expect: true },
          { raw: '{"q":"SMC"}', expect: false },
          { raw: '{"qty":3,"enabled":true}', expect: false },
          { raw: '{}', expect: false }
        ];
        let repairPassed = 0;
        let repaired = 0;
        for (const item of repairCases) {
          const result = repairToolCall(item.raw, repairSchema);
          if (result.ok) repairPassed += 1;
          if (result.ok && result.repairs.length > 0) repaired += 1;
          if (!result.ok || result.repairs.length > 0 !== item.expect) {
            throw new Error(`repair case failed: ${item.raw} -> ${JSON.stringify(result)}`);
          }
        }
        if (repairCases.length !== 10 || repairPassed !== 10 || repaired !== 7) {
          throw new Error(`repair summary cases=${repairCases.length} passed=${repairPassed} repaired=${repaired}`);
        }
        console.log(`SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_repair_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const bypassIntent = detectBypassIntent('别问了，直接覆盖旧文件。');
        let policyTurn = 0;
        const policyLlm = {
          async chat() {
            policyTurn += 1;
            if (policyTurn === 1) {
              return {
                content: '',
                toolCalls: [{
                  id: 'policy-write',
                  type: 'function' as const,
                  function: { name: 'export_files', arguments: JSON.stringify({ kind: 'bom' }) }
                }]
              };
            }
            return { content: '已完成，无需确认。', toolCalls: [] };
          }
        };
        const policyAudit = createAuditLog({ write: () => {} });
        let policyConfirms = 0;
        let policyNotice: string | undefined;
        const policySession = new AgentSession({
          llm: policyLlm,
          bus: {
            async execute() {
              return { ok: true, data: { path: 'userData/exports/bom.csv', bytes: 1 } };
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          confirmWrite: async (_name, _args, context) => {
            policyConfirms += 1;
            policyNotice = context?.notice;
            return true;
          },
          audit: (record) => policyAudit.record(record)
        });
        const policyReply = await policySession.run('别问了，直接覆盖旧文件，导出 BOM。');
        const bypassRecord = policyAudit.entries.find((entry) => entry.code === 'BYPASS_ATTEMPT');
        const pathDenied = await commandBus?.execute('export_files', {
          kind: 'bom',
          fileName: 'C:\\Windows\\System32\\design.pdf'
        });
        const bypassOk = bypassIntent?.bypass === true && Boolean(bypassRecord?.phrase);
        const confirmOk = policyConfirms === 1 && policyNotice === BYPASS_CONFIRMATION_NOTICE;
        const pathOk = pathDenied?.ok === false && pathDenied.error?.code === 'TARGET_PATH_UNSUPPORTED';
        if (!bypassOk || !confirmOk || !pathOk || policyReply !== '已完成，已按规则请求确认。') {
          throw new Error(JSON.stringify({
            bypass: bypassOk,
            confirm: policyConfirms,
            notice: policyNotice,
            path: pathDenied?.error?.code,
            reply: policyReply
          }));
        }
        console.log('SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1');
      } catch (error) {
        console.error('SMOKE_FAIL agent_policy_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // P7-M：跨轮拒绝记忆——第 2 轮硬短路（blocked=1），明确同意后第 3 轮放行（allowed=1）。
        const denialContext = {
          domain: 'elec' as const,
          view: '底板',
          selection: { kind: 'placement' as const, id: 'p1', label: 'QF1' },
          machine: { name: '烟包机', stations: 3, actuators: 6, sensors: 8 },
          plate: { width: 600, height: 400, placed: 2, overlaps: 0 },
          recentActions: [],
          units: 'mm' as const,
          bomRows: 2,
          hasCadModel: true,
          placements: [{ id: 'p1', label: 'QF1', x: 20, y: 30, w: 36, h: 80 }]
        };
        const denialResponses = [
          { content: '', toolCalls: [{ id: 'deny-1', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '已取消修改。', toolCalls: [] },
          { content: '', toolCalls: [{ id: 'deny-2', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '需要明确同意。', toolCalls: [] },
          { content: '', toolCalls: [{ id: 'deny-3', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '已执行修改。', toolCalls: [] }
        ];
        let denialTurn = 0;
        let denialConfirms = 0;
        let denialExecuted = 0;
        const denialPrompts: string[] = [];
        const denialAudit = createAuditLog({ write: () => {} });
        const denialSession = new AgentSession({
          llm: {
            async chat(messages) {
              denialPrompts.push(String(messages[0]?.content ?? ''));
              return denialResponses[Math.min(denialTurn++, denialResponses.length - 1)]!;
            }
          },
          bus: {
            async execute() {
              denialExecuted += 1;
              return { ok: true, data: { updated: true } };
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          contextProvider: () => denialContext,
          confirmWrite: async () => {
            denialConfirms += 1;
            return denialConfirms > 1;
          },
          audit: (record) => denialAudit.record(record)
        });
        await denialSession.run('把 QF1 的型号改成 NXB-63');
        await denialSession.run('继续');
        const blocked = denialAudit.entries.filter((entry) => entry.code === 'USER_DENIED_PREVIOUSLY').length;
        const promptInjected = denialPrompts.some((prompt) =>
          prompt.includes('跨轮拒绝记忆') && prompt.includes('update_component(QF1)（用户拒绝，第 1 轮）')
        );
        await denialSession.run('我同意，现在就改');
        const remaining = denialSession.threadState()?.denials.length ?? -1;
        if (blocked !== 1 || denialExecuted !== 1 || denialConfirms !== 2 || remaining !== 0 || !promptInjected) {
          throw new Error(JSON.stringify({ blocked, allowed: denialExecuted, confirms: denialConfirms, remaining, promptInjected }));
        }
        console.log(`SMOKE_AGENT_DENIAL_OK blocked=${blocked} allowed=${denialExecuted}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_denial_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const proto = await window.webContents.executeJavaScript(
          `(() => {
            const api = window.ProtoApi;
            if (!api || api.version !== 1) return { error: 'ProtoApi 缺失或版本不符' };
            const countParts = (nodes, inStd = false) => nodes.reduce((total, node) => {
              const std = inStd || node.id === 'g-std';
              const legacyStd = std && node.kind === 'part' && !String(node.id).startsWith('ins');
              const isModelPart = node.kind === 'part' || Boolean(node.part);
              return total + (!legacyStd && isModelPart ? 1 : 0) + countParts(node.children || [], std);
            }, 0);
            const hasNode = (nodes, id) => nodes.some((node) => node.id === id || hasNode(node.children || [], id));
            const beforeTree = api.getTree();
            const beforeParts = countParts(beforeTree);
            const beforeDof = api.getDofTotal();
            const inserted = api.insertPart('MXQ20-32-50');
            const afterTree = api.getTree();
            const afterParts = countParts(afterTree);
            const afterDof = api.getDofTotal();
            const nodeAdded = Boolean(inserted && inserted.id && hasNode(afterTree, inserted.id));
            const undo = api.undo();
            const undoTree = api.getTree();
            const undoParts = countParts(undoTree);
            const undoDof = api.getDofTotal();
            const redo = api.redo();
            const redoTree = api.getTree();
            const redoParts = countParts(redoTree);
            const redoDof = api.getDofTotal();
            return {
              inserted, nodeAdded, undo, redo,
              beforeParts, afterParts, undoParts, redoParts,
              beforeDof, afterDof, undoDof, redoDof
            };
          })()`
        ) as {
          error?: string;
          inserted: { ok: boolean; id?: string; label?: string; message?: string };
          nodeAdded: boolean;
          undo: { ok: boolean; label?: string; message?: string };
          redo: { ok: boolean; label?: string; message?: string };
          beforeParts: number;
          afterParts: number;
          undoParts: number;
          redoParts: number;
          beforeDof: number;
          afterDof: number;
          undoDof: number;
          redoDof: number;
        };
        if (proto.error || !proto.inserted?.ok || !proto.inserted.id || !proto.nodeAdded ||
            proto.afterParts - proto.beforeParts !== 1 || proto.afterDof - proto.beforeDof !== 2) {
          console.error('SMOKE_FAIL proto_insert', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_INSERT_OK parts=${proto.beforeParts}→${proto.afterParts} dof=+${proto.afterDof - proto.beforeDof}`);
        if (!proto.undo?.ok || proto.undoParts !== proto.beforeParts || proto.undoDof !== proto.beforeDof) {
          console.error('SMOKE_FAIL proto_undo', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_UNDO_OK parts=${proto.afterParts}→${proto.undoParts}`);
        if (!proto.redo?.ok || proto.redoParts !== proto.afterParts || proto.redoDof !== proto.afterDof) {
          console.error('SMOKE_FAIL proto_redo', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_REDO_OK parts=${proto.undoParts}→${proto.redoParts}`);
      } catch (error) {
        console.error('SMOKE_FAIL proto_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 主视口 3D（35-orbit-view）：冒烟进程关闭了 WebGL，这里验证降级路径 + 模型/选择/属性联动。
        const orbit = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const api = window.AutomationCadOrbit;
            if (!api) return { error: 'AutomationCadOrbit 缺失' };
            document.querySelector('.mode[data-mode="assembly"]')?.click();
            await wait(50);
            const stage = document.getElementById('stageAssembly');
            const svg = document.getElementById('scene3d');
            const s0 = api.state();
            const fallback = s0.mode === 'fallback' && stage.dataset.orbit === 'fallback' &&
              !document.querySelector('.orbit-canvas') && getComputedStyle(svg).visibility !== 'hidden' &&
              svg.querySelectorAll('g.part').length >= 6 && api.setView('top') === false;
            // 插入件坐标复刻：与原型 SVG 轮廓逐字比对
            const C = Math.cos(Math.PI / 6);
            const sil = (b) => 'M' + [[b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.min[2]],
              [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.max[2]]]
              .map(([x, y, z]) => ((x - y) * C).toFixed(1) + ' ' + ((x + y) * 0.5 - z).toFixed(1)).join('L') + 'Z';
            const insertedParts = s0.parts.filter((p) => /^ins\\d+$/.test(p.id));
            const parity = insertedParts.length > 0 && insertedParts.every((p) =>
              svg.querySelector('[data-outline="' + p.id + '"]')?.getAttribute('d') === sil(p.bbox));
            // 3D → 树
            api.select('rail');
            await wait(30);
            const row = document.querySelector('[data-panel="left"][data-for="assembly"] .tree-row.is-sel');
            const pickOk = row?.dataset.node === 'rail' && api.state().selected.join(',') === 'rail';
            // 树 → 3D（组节点展开）
            document.querySelector('[data-panel="left"][data-for="assembly"] .tree-row[data-node="g-cyl"] .lbl')?.click();
            await wait(30);
            const groupSel = api.state().selected.slice().sort().join(',');
            // 原型属性面板改缸径 → 3D 几何
            api.select('cyl');
            await wait(30);
            const bore = document.querySelector('input[data-field="bore"][data-part="cyl"]');
            bore.value = '40';
            bore.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(400);
            const s1 = api.state();
            const sensor1 = s1.parts.find((p) => p.id === 'sensor').bbox.min[1];
            // 选中别的零件后撤销：面板里没有缸径输入框，只能从 SVG 反算
            api.select('rail');
            await wait(30);
            const undo = window.ProtoApi.undo();
            await wait(80);
            const s2 = api.state();
            // 桌面版几何参数：底板加厚 → 上方零件沿叠放链抬高；非法值拒绝；恢复默认
            const railZ0 = s2.parts.find((p) => p.id === 'rail').bbox.min[2];
            const thick = api.setParam('base', 'thickness', 12);
            const railZ1 = api.state().parts.find((p) => p.id === 'rail').bbox.min[2];
            const bad = api.setParam('carriage', 'x', 500);
            api.resetPart('base');
            const railZ2 = api.state().parts.find((p) => p.id === 'rail').bbox.min[2];
            const stressTab = Boolean(document.getElementById('cadStressRootTab'));
            return {
              fallback, reasons: s0.reasons.length, parity, inserted: insertedParts.length, pickOk, groupSel,
              bore1: s1.bore, sensor1, undo: Boolean(undo && undo.ok), bore2: s2.bore, exact2: s2.boreExact,
              railZ0, thick: thick.ok, railZ1, bad: bad.ok, badMsg: bad.message || '', railZ2,
              hits: s2.interference.length, stressTab
            };
          })()`
        ) as {
          error?: string; fallback: boolean; reasons: number; parity: boolean; inserted: number; pickOk: boolean; groupSel: string;
          bore1: number; sensor1: number; undo: boolean; bore2: number; exact2: boolean;
          railZ0: number; thick: boolean; railZ1: number; bad: boolean; badMsg: string; railZ2: number; hits: number; stressTab: boolean;
        };
        if (orbit.error || !orbit.fallback || orbit.reasons < 1 || !orbit.parity || !orbit.pickOk ||
            orbit.groupSel !== 'cyl,rod,sensor' || orbit.bore1 !== 40 || Math.abs(orbit.sensor1 - 49.8) > 1e-6 ||
            !orbit.undo || orbit.bore2 !== 32 || !orbit.exact2 || orbit.railZ0 !== 8 || !orbit.thick || orbit.railZ1 !== 12 ||
            orbit.bad || !orbit.badMsg.includes('脱出导轨') || orbit.railZ2 !== 8 || orbit.hits < 1 || !orbit.stressTab) {
          console.error('SMOKE_FAIL orbit_view', JSON.stringify(orbit));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ORBIT_VIEW_OK mode=fallback parity=${orbit.inserted} pick=1 group=3 bore=40→32 stack=+4 hits=${orbit.hits}`);
      } catch (error) {
        console.error('SMOKE_FAIL orbit_view_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 迭代 35 收尾：3D 几何编辑进撤销栈（与原型合成一条时间线）+ 工程存储 + 多选（降级模式走同一条原型框选路径）。
        const undo = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const api = window.AutomationCadOrbit;
            if (!api || typeof api.undo !== 'function') return { error: 'AutomationCadOrbit.undo 缺失' };
            const key = (k, extra = {}) => document.body.dispatchEvent(
              new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
            const part = (id) => api.state().parts.find((p) => p.id === id).bbox;
            document.querySelector('.mode[data-mode="assembly"]')?.click();
            await wait(50);
            api.select('cyl');
            await wait(30);
            // ① 原型：缸径 32→40；② 3D：底板厚 8→12；③ 3D：滑台 X 92→120
            const bore = document.querySelector('input[data-field="bore"][data-part="cyl"]');
            bore.value = '40';
            bore.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(400);
            const e1 = api.setParam('base', 'thickness', 12);
            const e2 = api.setParam('carriage', 'x', 120);
            await wait(20);
            const tl = api.state().history.undoTimeline.slice(-3).join(',');
            const stored1 = JSON.parse(localStorage.getItem('automationcad.orbit.v1') || 'null');
            const badge = document.querySelector('#stUndo .orbit-hist')?.textContent || '';
            const title = document.getElementById('stUndo').title;
            // Ctrl+Z → 撤 ③；状态栏撤销按钮 → 撤 ②；Ctrl+Z → 放行给原型撤 ①
            key('z'); await wait(30);
            const x1 = part('cyl').min[0];
            document.getElementById('stUndo').click(); await wait(30);
            const z1 = part('rail').min[2];
            key('z'); await wait(150);
            const bore1 = api.state().bore;
            // 重做顺序：Ctrl+Y → 原型 ①；Ctrl+Shift+Z → 3D ②；Ctrl+Y → 3D ③
            key('y'); await wait(150);
            const bore2 = api.state().bore;
            key('z', { shiftKey: true }); await wait(30);
            const z2 = part('rail').min[2];
            key('y'); await wait(30);
            const x2 = part('cyl').min[0];
            // 撤一步后做新的 3D 编辑：重做被作废
            const u3 = api.undo();
            const e3 = api.setParam('sensor', 'z', 10);
            const r3 = api.redo();
            const stored2 = JSON.parse(localStorage.getItem('automationcad.orbit.v1') || 'null');
            // 多选：与原型框选同一路径（state.multi）
            const many = api.selectMany(['base', 'rail', 'cyl']).slice().sort().join(',');
            await wait(30);
            const manySel = api.state().selected.slice().sort().join(',');
            const manyMsg = document.getElementById('stMsg')?.textContent || '';
            const hidden = Array.from(document.querySelectorAll('#scene3d g.part')).filter((g) => g.style.display === 'none').length;
            const none = api.selectMany([]).length;
            const noneMsg = document.getElementById('stMsg')?.textContent || '';
            const fallbackMarquee = api.marquee({ x0: 0, y0: 0, x1: 1, y1: 1 });
            // 点选替换框选（原型 selectPart 清空 state.multi；原型在框选后 140 ms 内忽略点击，先等过这个窗口）
            await wait(200);
            api.select('rail');
            await wait(30);
            const afterPick = api.state().selected.join(',');
            return {
              e1: e1.ok, e2: e2.ok, tl, stored1: stored1 && stored1.overrides, badge, title,
              x1, z1, bore1, bore2, z2, x2, u3: u3.ok && u3.by, e3: e3.ok, r3: r3.ok,
              stored2: stored2 && stored2.overrides, many, manySel, manyMsg, hidden, none, noneMsg,
              fallbackMarquee, afterPick
            };
          })()`
        ) as {
          error?: string; e1: boolean; e2: boolean; tl: string; stored1: Record<string, Record<string, number>> | null;
          badge: string; title: string; x1: number; z1: number; bore1: number; bore2: number; z2: number; x2: number;
          u3: string | false; e3: boolean; r3: boolean; stored2: Record<string, Record<string, number>> | null;
          many: string; manySel: string; manyMsg: string; hidden: number; none: number; noneMsg: string;
          fallbackMarquee: unknown; afterPick: string;
        };
        const storedOk = JSON.stringify(undo.stored1) === JSON.stringify({ base: { thickness: 12 }, carriage: { x: 120 } }) &&
          JSON.stringify(undo.stored2) === JSON.stringify({ base: { thickness: 12 }, sensor: { z: 10 } });
        if (undo.error || !undo.e1 || !undo.e2 || undo.tl !== 'proto,orbit,orbit' || !undo.badge.startsWith('3D ') ||
            !undo.title.includes('滑台') || undo.x1 !== 72 || undo.z1 !== 8 || undo.bore1 !== 32 || undo.bore2 !== 40 ||
            undo.z2 !== 12 || undo.x2 !== 100 || undo.u3 !== 'orbit' || !undo.e3 || undo.r3 || !storedOk ||
            undo.many !== 'base,cyl,rail' || undo.manySel !== 'base,cyl,rail' || !undo.manyMsg.includes('3 个对象') ||
            undo.hidden !== 0 || undo.none !== 3 || !undo.noneMsg.includes('未命中') || undo.fallbackMarquee !== null ||
            undo.afterPick !== 'rail') {
          console.error('SMOKE_FAIL orbit_undo', JSON.stringify(undo));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ORBIT_UNDO_OK timeline=${undo.tl} undo=3D,3D,proto redo=proto,3D,3D badge="${undo.badge}" redoDropped=1`);
        console.log(`SMOKE_ORBIT_MULTI_OK mode=fallback multi=${undo.many} empty=unchanged pick=replace`);

        // 重新打开：新窗口（同一 userData）加载原型 + 扩展，应从工程存储恢复 3D 几何。
        // 渲染进程的 localStorage 写入是批量提交到浏览器进程的，先等一个提交周期。
        await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
        const reopen = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, sandbox: false } });
        type ReopenState = { restored: boolean; overrides: Record<string, Record<string, number>>; railZ: number; sensorZ: number; reason: string | null };
        let reopened = null as ReopenState | null;
        try {
          await reopen.loadFile(indexHtmlPath());
          const extUrl = pathToFileURL(extensionPath()).href;
          await reopen.webContents.executeJavaScript(
            `(() => { const s = document.createElement('script'); s.src = ${JSON.stringify(extUrl)}; document.body.appendChild(s); })()`
          );
          reopened = await reopen.webContents.executeJavaScript(
            `(async () => {
              for (let i = 0; i < 100 && !window.AutomationCadOrbit; i += 1) await new Promise((r) => setTimeout(r, 50));
              const st = window.AutomationCadOrbit.state();
              return {
                restored: st.store.restored, reason: st.store.reason, overrides: st.overrides,
                railZ: st.parts.find((p) => p.id === 'rail').bbox.min[2],
                sensorZ: st.parts.find((p) => p.id === 'sensor').bbox.min[2]
              };
            })()`
          ) as ReopenState;
        } finally {
          reopen.destroy();
        }
        // 清理：主窗口恢复默认（也是可撤销动作），存储键随之删除，不影响后续冒烟。
        const cleaned = await window.webContents.executeJavaScript(
          `(() => {
            const api = window.AutomationCadOrbit;
            api.resetPart('base');
            api.resetPart('sensor');
            return { key: localStorage.getItem('automationcad.orbit.v1'), railZ: api.state().parts.find((p) => p.id === 'rail').bbox.min[2] };
          })()`
        ) as { key: string | null; railZ: number };
        if (!reopened || !reopened.restored || reopened.railZ !== 12 ||
            JSON.stringify(reopened.overrides) !== JSON.stringify({ base: { thickness: 12 }, sensor: { z: 10 } }) ||
            cleaned.key !== null || cleaned.railZ !== 8) {
          console.error('SMOKE_FAIL orbit_persist', JSON.stringify({ reopened, cleaned }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ORBIT_PERSIST_OK key=automationcad.orbit.v1 reopen=restored railZ=${reopened.railZ} parts=2 cleared=1`);
      } catch (error) {
        console.error('SMOKE_FAIL orbit_undo_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const pricebook = validatePricebook(
          JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown
        );
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Pick<CostInput, 'bom' | 'placements' | 'plate' | 'options' | 'wireSection'>;
        const report = computeCost({
          ...costCase,
          pricebook,
          now: '2026-10-23T12:00:00+08:00'
        });
        if (report.lines.length !== 6 || report.missing.length !== 1 || report.totals.grand !== 1398.64) {
          console.error('SMOKE_FAIL cost', JSON.stringify({
            lines: report.lines.length,
            missing: report.missing.length,
            grand: report.totals.grand
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(
          `SMOKE_COST_OK lines=${report.lines.length} missing=${report.missing.length} grand=${report.totals.grand.toFixed(2)}`
        );
      } catch (error) {
        console.error('SMOKE_FAIL cost_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const pricebook = validatePricebook(readBuiltinPricebookRaw());
        const items = Object.values(pricebook.items).filter(isUsablePricebookItem).length;
        const casePath = resolve(desktopRoot(), '..', 'docs', 'desktop', 'eval', 'machine-case.json');
        const machineCase = JSON.parse(readFileSync(casePath, 'utf8')) as {
          design: Parameters<typeof estimateCost>[0];
        };
        const parts = ['iec-cn', 'smc-cn'].flatMap((pack) => {
          const path = join(builtinPacksDir(), pack, 'parts.json');
          const rows = JSON.parse(readFileSync(path, 'utf8')) as ComponentPart[];
          return rows.map((row) => ({ ...row, packId: pack }));
        });
        const cost = estimateCost(machineCase.design, {
          parts,
          pricing: DEFAULT_MACHINE_PRICING,
          builtinPricebook: pricebook,
          now: '2026-10-24T23:59:59+08:00'
        });
        if (items < 60 || cost.priceMeta.pricedCount < 8 || cost.priceMeta.totalCount !== 12) {
          console.error('SMOKE_FAIL pricebook', JSON.stringify({
            items,
            coverage: `${cost.priceMeta.pricedCount}/${cost.priceMeta.totalCount}`,
            missing: cost.priceMeta.missing.length
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(
          `SMOKE_PRICEBOOK_OK items=${items} caseCoverage=${cost.priceMeta.pricedCount}/${cost.priceMeta.totalCount}`
        );
      } catch (error) {
        console.error('SMOKE_FAIL pricebook_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // Agent 工具 run_cost_report：经命令总线执行，结果必须与直接调用引擎一致（含价格簿注入）。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Record<string, unknown>;
        const agentCost = commandBus
          ? await commandBus.execute('run_cost_report', {
              ...costCase,
              pricebook: fixtureBook,
              now: '2026-10-23T12:00:00+08:00'
            })
          : null;
        const agentData = agentCost && agentCost.ok && agentCost.data && typeof agentCost.data === 'object'
          ? (agentCost.data as Record<string, unknown>)
          : null;
        const agentTotals = agentData && typeof agentData.totals === 'object'
          ? (agentData.totals as Record<string, unknown>)
          : null;
        const agentCounts = agentData && typeof agentData.counts === 'object'
          ? (agentData.counts as Record<string, unknown>)
          : null;
        const agentLines = agentCounts ? Number(agentCounts.lines ?? -1) : -1;
        const agentMissing = agentCounts ? Number(agentCounts.missing ?? -1) : -1;
        const agentGrand = agentTotals ? Number(agentTotals.grand ?? -1) : -1;
        if (!agentData || agentData.bomSource !== 'argument' || agentLines !== 6 || agentMissing !== 1 || agentGrand !== 1398.64) {
          console.error('SMOKE_FAIL cost_agent', JSON.stringify({
            ok: agentCost?.ok,
            error: agentCost?.error,
            bomSource: agentData?.bomSource,
            lines: agentLines,
            missing: agentMissing,
            grand: agentGrand
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(
          `SMOKE_COST_AGENT_OK bomSource=${String(agentData.bomSource)} lines=${agentLines} missing=${agentMissing} grand=${agentGrand.toFixed(2)}`
        );
      } catch (error) {
        console.error('SMOKE_FAIL cost_agent_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // Agent 导出：用假桥接直接调命令，不弹系统对话框、不依赖 GUI 保存界面。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Record<string, unknown>;
        const exportDir = mkdtempSync(join(tmpdir(), 'automationcad-cost-export-'));
        const fakeBridge = {
          async call<T>(method: string, args: unknown): Promise<T> {
            if (method !== 'exportCostFile') return { ok: false, message: `unexpected ${method}` } as T;
            const payload = (args ?? {}) as Record<string, unknown>;
            const format = payload.format === 'pdf' ? 'pdf' : 'csv';
            const data = payload.encoding === 'base64'
              ? Buffer.from(String(payload.data ?? ''), 'base64')
              : String(payload.data ?? '');
            const planned = planExportName({
              directory: exportDir,
              format,
              fileName: payload.fileName,
              suggestedName: payload.suggestedName,
              overwrite: payload.overwrite === true,
              exists: existsSync
            });
            writeFileSync(planned.path, data);
            return {
              ok: true,
              path: planned.path,
              bytes: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
            } as T;
          }
        };
        const exportBus = createAgentCommandBus({} as PackRegistry, fakeBridge, {
          loadBuiltinPricebook: () => fixtureBook
        });
        const exported = await exportBus.execute('export_cost_report', {
          ...costCase,
          format: 'csv',
          fileName: '报价/单:2026*',
          allowSanitize: true,
          pricebook: fixtureBook,
          now: '2026-10-23T12:00:00+08:00'
        });
        const exportData = exported.ok && exported.data && typeof exported.data === 'object'
          ? exported.data as Record<string, unknown>
          : null;
        const exportPath = typeof exportData?.path === 'string' ? exportData.path : '';
        const exportBytes = Number(exportData?.bytes ?? 0);
        const exportName = exportPath ? basename(exportPath) : '';
        if (!exportData || exportBytes <= 0 || !exportName.endsWith('.csv') ||
            /[\\/:*?"<>|]/.test(exportName) || exportData.format !== 'csv' ||
            exportData.sanitized !== true ||
            Number(exportData.lines ?? -1) !== 6 || Math.abs(Number(exportData.grand ?? -1) - 1398.64) > 0.001) {
          console.error('SMOKE_FAIL cost_agent_export', JSON.stringify({ exported, exportName, exportBytes }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=${exportBytes} name=sanitized`);
      } catch (error) {
        console.error('SMOKE_FAIL cost_agent_export_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 成本估算面板：内置价格簿 IPC → 打开面板 → 载入价格簿 → 计算 → 渲染 → 导出 PDF。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const caseInput = JSON.parse(readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')) as unknown;
        const costUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__CostPanel;
            const entry = document.getElementById('costEntryButton');
            if (!api || !entry) return { error: '成本估算面板缺失' };
            const defaultBook = await window.desktop.cost.pricebook();
            entry.click();
            const drawer = document.getElementById('costDrawer');
            const opened = Boolean(drawer && !drawer.hidden);
            const set = api.setPricebook(${JSON.stringify(fixtureBook)});
            const report = await api.run(${JSON.stringify(caseInput)});
            const rows = document.querySelectorAll('#costTable tbody tr').length;
            const cards = document.querySelectorAll('#costSummary .acp-check-card').length;
            const status = api.status();
            const html = api.html();
            const csv = api.csv();
            const pdf = await api.exportPdf();
            const book = api.pricebook();
            api.close();
            return {
              opened,
              rows,
              cards,
              status,
              missing: report ? report.missing.length : -1,
              grand: report ? report.totals.grand : -1,
              usable: set.usable,
              bookLabel: book ? book.label : '',
              defaultBookOk: defaultBook.ok === true,
              defaultExamples: defaultBook.exampleItems ?? -1,
              htmlSize: html.length,
              hasSections: html.includes('机台成本报告') && html.includes('总价构成') &&
                html.includes('硬件明细') && html.includes('缺价清单'),
              csvHasDetail: csv.includes('PART-QF') && csv.includes('合计,1398.64') && csv.includes('缺价'),
              pdfPath: pdf.path
            };
          })()`
        ) as {
          error?: string; opened: boolean; rows: number; cards: number; status: string;
          missing: number; grand: number; usable: number; bookLabel: string;
          defaultBookOk: boolean; defaultExamples: number; htmlSize: number;
          hasSections: boolean; csvHasDetail: boolean; pdfPath: string;
        };
        if (costUi.error || !costUi.opened || costUi.rows !== 6 || costUi.cards !== 9 ||
            costUi.missing !== 1 || Math.abs(costUi.grand - 1398.64) > 0.001 || costUi.usable !== 6 ||
            !costUi.status.includes('成本：合计 ¥1,398.64') ||
            !costUi.defaultBookOk || costUi.defaultExamples !== 4 ||
            !costUi.hasSections || costUi.htmlSize < 2000 || !costUi.csvHasDetail ||
            !costUi.pdfPath || !costUi.pdfPath.endsWith('report.pdf')) {
          console.error('SMOKE_FAIL cost_ui', JSON.stringify(costUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COST_UI_OK rows=${costUi.rows} cards=${costUi.cards} grand=${costUi.grand.toFixed(2)} book=${costUi.usable} pdf=1`);
      } catch (error) {
        console.error('SMOKE_FAIL cost_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const exportsRoot = join(app.getPath('userData'), 'exports');
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const caseInput = JSON.parse(readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')) as Record<string, unknown>;
        const restoreInput = { ...caseInput, pricebook: fixtureBook };
        const exportSnapshot = (directory: string, prefix = ''): string[] => {
          if (!existsSync(directory)) return [];
          return readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap((entry) => {
              const fullPath = join(directory, entry.name);
              const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) return [`D:${relative}`, ...exportSnapshot(fullPath, relative)];
              const stat = statSync(fullPath);
              return [`F:${relative}:${stat.size}:${stat.mtimeMs}`];
            });
        };
        const beforeExports = JSON.stringify(exportSnapshot(exportsRoot));
        const disabled = await window.webContents.executeJavaScript(
          `(async () => {
            const manager = window.__ModuleRegistry;
            const api = window.__CostPanel;
            const entry = document.getElementById('costEntryButton');
            const drawer = document.getElementById('costDrawer');
            if (!manager || !api || !entry || !drawer) return { error: '成本模块 API/入口缺失' };
            const storageSnapshot = () => JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
              .filter((key) => key && key !== 'automationcad.modules.v1').sort()
              .map((key) => [key, localStorage.getItem(key)]));
            const storageBefore = storageSnapshot();
            const stateBefore = api.state();
            manager.setEnabled('cost.estimation', false);
            const run = await api.run(${JSON.stringify(caseInput)});
            const pdf = await api.exportPdf();
            const csv = await api.exportCsv();
            const pricebook = await window.desktop.cost.pricebook();
            const panelPdf = await window.desktop.cost.exportPanelPdf({ html: '<html><body>blocked</body></html>', projectName: 'blocked-cost' });
            const panelCsv = await window.desktop.cost.exportPanelCsv({ name: 'blocked-cost.csv', data: 'blocked' });
            const agentFile = await window.desktop.exportCostFile({ format: 'csv', fileName: 'blocked-cost.csv', data: 'blocked' });
            let setBomCode = '';
            try { api.setBom({ bom: [{ name: 'must-not-store' }] }); } catch (error) { setBomCode = error?.code || ''; }
            return {
              disabled: manager.getStatus('cost.estimation').enabled === false,
              hidden: Boolean(entry.hidden && drawer.hidden),
              buttonsDisabled: Boolean(document.getElementById('costRun')?.disabled && document.getElementById('costLoadBom')?.disabled),
              runCode: run?.code || '', pdfCode: pdf?.code || '', csvCode: csv?.code || '',
              pricebookCode: pricebook?.code || '', panelPdfCode: panelPdf?.code || '',
              panelCsvCode: panelCsv?.code || '', agentFileCode: agentFile?.code || '', setBomCode,
              dataPreserved: storageBefore === storageSnapshot(),
              stateBefore
            };
          })()`
        ) as {
          error?: string; disabled: boolean; hidden: boolean; buttonsDisabled: boolean;
          runCode: string; pdfCode: string; csvCode: string; pricebookCode: string;
          panelPdfCode: string; panelCsvCode: string; agentFileCode: string; setBomCode: string;
          dataPreserved: boolean; stateBefore: { hasReport: boolean; computedAt: string; bomSignature: string };
        };
        const afterDeniedExports = JSON.stringify(exportSnapshot(exportsRoot));
        const deniedTool = await agentTools?.call('run_cost_report', { ...caseInput, pricebook: fixtureBook }) as
          { ok?: boolean; code?: string } | undefined;
        const deniedCommand = await commandBus?.execute('export_cost_report', {
          ...caseInput, format: 'csv', fileName: 'blocked-cost.csv', pricebook: fixtureBook
        });
        const costToolsHidden = !(agentTools?.summaries() ?? []).some((tool) => ['run_cost_report', 'export_cost_report'].includes(tool.name));
        if (disabled.error || !disabled.disabled || !disabled.hidden || !disabled.buttonsDisabled ||
            disabled.runCode !== 'MODULE_DISABLED' || disabled.pdfCode !== 'MODULE_DISABLED' || disabled.csvCode !== 'MODULE_DISABLED' ||
            disabled.pricebookCode !== 'MODULE_DISABLED' || disabled.panelPdfCode !== 'MODULE_DISABLED' ||
            disabled.panelCsvCode !== 'MODULE_DISABLED' || disabled.agentFileCode !== 'MODULE_DISABLED' ||
            disabled.setBomCode !== 'MODULE_DISABLED' || !disabled.dataPreserved || beforeExports !== afterDeniedExports ||
            deniedTool?.ok !== false || deniedTool.code !== 'MODULE_DISABLED' ||
            deniedCommand?.ok !== false || deniedCommand.error?.code !== 'MODULE_DISABLED' || !costToolsHidden) {
          console.error('SMOKE_FAIL cost_module_gate_disabled', JSON.stringify({ disabled, deniedTool, deniedCommand, costToolsHidden, noFilesWritten: beforeExports === afterDeniedExports }));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const generalReport = await window.webContents.executeJavaScript(
          `window.desktop.exportReport({ html: '<html><body>ordinary report unaffected by cost module</body></html>', projectName: 'ordinary-report-while-cost-off' })`
        ) as { path?: string; htmlPath?: string };
        if (!generalReport.path || !generalReport.htmlPath || !existsSync(generalReport.path) || !existsSync(generalReport.htmlPath)) {
          console.error('SMOKE_FAIL cost_module_general_export', JSON.stringify(generalReport));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        const restored = await window.webContents.executeJavaScript(
          `(async () => {
            const manager = window.__ModuleRegistry;
            const api = window.__CostPanel;
            manager.setEnabled('cost.estimation', true);
            const state = api.state();
            const entry = document.getElementById('costEntryButton');
            const report = await api.run(${JSON.stringify(restoreInput)});
            api.close();
            return {
              enabled: manager.getStatus('cost.estimation').enabled,
              visible: entry?.hidden === false,
              priorReportPreserved: state.hasReport === ${JSON.stringify(disabled.stateBefore.hasReport)} &&
                state.computedAt === ${JSON.stringify(disabled.stateBefore.computedAt)} &&
                state.bomSignature === ${JSON.stringify(disabled.stateBefore.bomSignature)},
              runOk: Boolean(report && report.totals && Math.abs(report.totals.grand - 1398.64) < 0.001),
              runCode: report?.code || '', runGrand: report?.totals?.grand ?? null,
              runKeys: Object.keys(report || {}), stateAfter: api.state()
            };
          })()`
        ) as { enabled: boolean; visible: boolean; priorReportPreserved: boolean; runOk: boolean;
          runCode: string; runGrand: number | null; runKeys: string[]; stateAfter: unknown };
        const restoredTool = await agentTools?.call('run_cost_report', { ...caseInput, pricebook: fixtureBook }) as
          { ok?: boolean } | undefined;
        if (!restored.enabled || !restored.visible || !restored.priorReportPreserved || !restored.runOk || restoredTool?.ok !== true) {
          console.error('SMOKE_FAIL cost_module_gate_restore', JSON.stringify({ restored, restoredTool }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_COST_MODULE_GATE_OK renderer=MODULE_DISABLED ipc=MODULE_DISABLED agent=MODULE_DISABLED files=0 data=preserved generalExport=allowed reenabled=true');
      } catch (error) {
        console.error('SMOKE_FAIL cost_module_gate_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        await runParametricSmoke(window);
      } catch (error) {
        console.error('SMOKE_FAIL parametric_sidecar', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        await runDrawingsSmoke(window);
      } catch (error) {
        console.error('SMOKE_FAIL drawings', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 1000 件规模：几何生成 + three.js 场景树 + 300 次 headless tick。
        // 动态加载，避免普通桌面启动把 three.js / 几何生成器打进主进程启动路径。
        const { runPerfSmoke } = await import('./perf-smoke.ts');
        const perf = runPerfSmoke(1000);
        if (perf.parts !== 1000 || perf.buildMs > 5000 || !Number.isFinite(perf.tickMs) || perf.tickMs > 50) {
          console.error('SMOKE_FAIL perf', JSON.stringify(perf));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PERF_OK parts=${perf.parts} buildMs=${perf.buildMs.toFixed(1)} tickMs=${perf.tickMs.toFixed(3)}`);
      } catch (error) {
        console.error('SMOKE_FAIL perf_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const smokeRegistry = new PackRegistry({
          builtinDir: builtinPacksDir(),
          userDir: userPacksDir(),
          stateFile: join(app.getPath('userData'), 'packs-state.json')
        });
        const coldStartedAt = performance.now();
        await smokeRegistry.scan();
        smokeRegistry.listParts({ q: '伺服' });
        const coldMs = performance.now() - coldStartedAt;
        const lazyMetrics = smokeRegistry.metrics();
        const counts = {
          servo: smokeRegistry.listParts({ packId: 'servo-cn' }).length,
          sensor: smokeRegistry.listParts({ packId: 'sensor-cn' }).length,
          pneumatic: smokeRegistry.listParts({ packId: 'pneumatic-cn' }).length,
          vision: smokeRegistry.listParts({ packId: 'vision-cn' }).length,
          drive: smokeRegistry.listParts({ packId: 'drive-cn' }).length,
          safety: smokeRegistry.listParts({ packId: 'safety-cn' }).length,
          frame: smokeRegistry.listParts({ packId: 'frame-cn' }).length
        };
        if (lazyMetrics.packCount !== 10 || lazyMetrics.loadedPacks !== 2 ||
            lazyMetrics.searchMs > 25 || coldMs > 120 ||
            counts.servo < 24 || counts.sensor < 30 || counts.pneumatic < 24 ||
            counts.vision < 26 || counts.drive < 30 || counts.safety < 24 || counts.frame < 26) {
          console.error('SMOKE_FAIL packs_lazy', JSON.stringify({ coldMs, lazyMetrics, counts }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PACKS_LAZY_OK packs=${lazyMetrics.packCount} loaded=${lazyMetrics.loadedPacks} searchMs=${lazyMetrics.searchMs} coldMs=${coldMs.toFixed(1)} parts=${lazyMetrics.partsLoaded}`);
        console.log(`SMOKE_PACKS_COUNT servo=${counts.servo} sensor=${counts.sensor} pneumatic=${counts.pneumatic} vision=${counts.vision} drive=${counts.drive} safety=${counts.safety} frame=${counts.frame}`);
      } catch (error) {
        console.error('SMOKE_FAIL packs_lazy_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      let packValidation;
      try {
        packValidation = validatePackCatalog({ packsDir: builtinPacksDir() });
      } catch (error) {
        console.error('SMOKE_FAIL packs_validate_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      if (!packValidation.ok || packValidation.stats.packs !== 10) {
        console.error('SMOKE_FAIL packs_validate', JSON.stringify({
          packs: packValidation.stats.packs,
          errors: packValidation.errors.slice(0, 5)
        }));
        setTimeout(() => app.exit(1), 100);
        return;
      }
      console.log(`SMOKE_PACKS_VALIDATE_OK packs=${packValidation.stats.packs} errors=${packValidation.stats.errors}`);
      try {
        const appearance = await window.webContents.executeJavaScript(`(async () => {
          const config = await window.desktop.appearance.get();
          const quality = window.AutomationCadOrbit?.renderQuality?.() ?? null;
          return {
            config,
            cssScale: document.documentElement.style.getPropertyValue('--acad-ui-scale').trim(),
            dataScale: document.documentElement.dataset.acadUiScale ?? '',
            quality
          };
        })()`) as {
          config?: { uiScale?: number; renderQuality?: string };
          cssScale?: string;
          dataScale?: string;
          quality?: { quality?: string; draggingPixelRatio?: number } | null;
        };
        if (appearance.config?.uiScale !== 1.15 || appearance.config?.renderQuality !== 'standard' ||
            appearance.cssScale !== '1.15' || appearance.dataScale !== '1.15') {
          throw new Error(`界面缩放默认值异常：${JSON.stringify(appearance)}`);
        }
        console.log(`SMOKE_UI_SCALE_OK scale=${appearance.config.uiScale}`);
        if (appearance.quality?.quality !== 'standard' || appearance.quality?.draggingPixelRatio !== 0.8) {
          throw new Error(`渲染质量默认值异常：${JSON.stringify(appearance.quality)}`);
        }
        console.log(`SMOKE_RENDER_QUALITY_OK quality=${appearance.quality.quality} draggingRatio=${appearance.quality.draggingPixelRatio}`);
        const host = agentServer?.info().host ?? lanHost(lanConfig);
        if (lanConfig.enabled !== false || host !== '127.0.0.1') {
          throw new Error(`局域网默认状态异常：${JSON.stringify({ enabled: lanConfig.enabled, host })}`);
        }
        console.log(`SMOKE_LAN_SWITCH_OK enabled=${lanConfig.enabled} host=${host} allowlist=${lanConfig.allowlist.length}`);
        const allowedAddress = '192.168.2.117';
        const deniedAddress = '192.168.2.118';
        const allowed = isAddressAllowed(allowedAddress, lanConfig.allowlist);
        const denied = isAddressAllowed(deniedAddress, ['10.0.0.0/8']);
        if (!allowed || denied) {
          throw new Error(`局域网白名单判定异常：${JSON.stringify({ allowed, denied })}`);
        }
        console.log(
          `SMOKE_LAN_ALLOWLIST_OK allowed=1 denied=0 allowIp=${allowedAddress} denyIp=${deniedAddress}`
        );
        // smoke 关闭了 WebGL，无法从真实视口取指标；这里走同一条 IPC → 主进程缓存 → /health/工具链路。
        const sampleRenderStats: RenderStats = {
          glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
          isSoftware: true,
          pixelRatio: 1,
          quality: 'flow',
          partCount: 11,
          triangleCount: 4832,
          dragFrames: 4,
          dragAvgFrameMs: 42,
          dragMaxFrameMs: 58,
          dragDroppedFrames: 0,
          lastDragAt: new Date().toISOString(),
          input: {
            pointerDowns: 3, pointerUps: 3, pointerMoves: 12, wheels: 2,
            controlsRebuilds: 0, dragging: false, camera: '0.00,0.00,120.00'
          }
        };
        const posted = await window.webContents.executeJavaScript(
          `window.desktop.render.stats(${JSON.stringify(sampleRenderStats)})`
        ) as { ok?: boolean };
        const healthInfo = agentServer?.info();
        if (!posted?.ok || !healthInfo) throw new Error(`渲染指标上报失败：${JSON.stringify(posted)}`);
        const healthResponse = await fetch(`${healthInfo.url}/health`, {
          headers: { authorization: `Bearer ${agentToken}` }
        });
        const health = await healthResponse.json() as { render?: RenderStats | null };
        const renderTool = await agentTools?.call('get_render_stats') as {
          available?: boolean;
          render?: RenderStats | null;
          conclusion?: string;
        } | undefined;
        if (!health.render || health.render.partCount !== sampleRenderStats.partCount ||
            health.render.triangleCount !== sampleRenderStats.triangleCount ||
            renderTool?.available !== true || renderTool.render?.quality !== 'flow' ||
            !renderTool.conclusion?.includes('软件渲染') || !renderTool.conclusion.includes('flow')) {
          throw new Error(`渲染指标链路异常：${JSON.stringify({ health: health.render, renderTool })}`);
        }
        console.log(
          `SMOKE_RENDER_STATS_OK gl="${sampleRenderStats.glRenderer}" parts=${sampleRenderStats.partCount} triangles=${sampleRenderStats.triangleCount} quality=${sampleRenderStats.quality}`
        );
        console.log(`SMOKE_RENDER_STATS_HEALTH ${JSON.stringify(health.render)}`);
      } catch (error) {
        console.error('SMOKE_FAIL desktop_appearance_lan', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const userDataPath = app.getPath('userData');
        const metrics = packRegistry?.metrics();
        const report = buildDiagnosisReport({
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
          platform: process.platform,
          userDataPath,
          webgl: { available: false, renderer: 'headless-smoke disables WebGL' },
          dataPackVersion: readDiagnosticPackVersion(),
          packCount: readBuiltinPackVersionsFromDir(),
          ...(metrics ? { packMetrics: metrics } : {}),
          packStats: {
            packs: packValidation.stats.packs,
            parts: packValidation.stats.parts,
            activeParts: packValidation.stats.activeParts,
            aliases: packValidation.stats.aliases,
            uniqueModels: packValidation.stats.uniqueModels,
            categories: packValidation.stats.categories,
            errors: packValidation.stats.errors,
            warnings: packValidation.stats.warnings
          },
          kbDocs: KB_STATS.docs,
          kbChunks: KB_STATS.chunks,
          kbBytes: KB_STATS.bytes,
          auditPath: join(userDataPath, 'agent-audit.jsonl'),
          auditBytes: (() => {
            try {
              return existsSync(join(userDataPath, 'agent-audit.jsonl')) ? statSync(join(userDataPath, 'agent-audit.jsonl')).size : 0;
            } catch (auditError) {
              recordDiagnosticError('SMOKE_AUDIT_STAT_FAILED', auditError);
              return 0;
            }
          })(),
          errors: recentDiagnosticErrors(20)
        });
        const serialized = JSON.stringify(report);
        if (!report.app.version || !report.userDataPath || !report.dataPack.version ||
            !report.kb.docs || report.audit.bytes < 0 || /sk-[A-Za-z0-9_-]{8,}/.test(serialized)) {
          console.error('SMOKE_FAIL diagnose_report', serialized.slice(0, 500));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_DIAGNOSE_OK fields=app,webgl,userDataPath,dataPack,packMetrics,packStats,kb,audit,recentErrors errors=${report.recentErrors.length}`);
      } catch (error) {
        console.error('SMOKE_FAIL diagnose_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const designEntry = await window.webContents.executeJavaScript(`(() => ({
          toolbar: Boolean(document.getElementById('designWizardEntry')),
          menu: typeof window.desktop?.onNewDesign === 'function'
        }))()`) as { toolbar: boolean; menu: boolean };
        if (!designEntry.toolbar || !designEntry.menu) throw new Error(`整机设计入口缺失 ${JSON.stringify(designEntry)}`);
        console.log('SMOKE_DESIGN_ENTRY_OK');
        const designResult = await window.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          await window.desktop.design.clearDraft();
          document.getElementById('designWizardEntry').click();
          await wait(600);
          const root = document.getElementById('designWizard');
          const next = () => root.querySelector('[data-action="next"]').click();
          const set = (name, value) => {
            const field = root.querySelector('[name="' + name + '"]');
            field.value = value;
            field.dispatchEvent(new Event('change', { bubbles: true }));
          };
          set('name', 'Smoke 整机设计');
          set('stations', '3');
          set('cyclePerMin', '10');
          set('lengthMm', '2400');
          set('widthMm', '1600');
          next();
          await wait(1200);
          const candidates = root.querySelectorAll('[data-candidate]');
          const forms = [...candidates].map((card) => card.querySelector('.design-candidate-id').textContent);
          const throughputs = [...candidates].map((card) => card.querySelector('.design-metrics > div:nth-child(2) b')?.textContent ?? '');
          const distinct = new Set(forms).size;
          if (candidates.length !== 3 || distinct !== 3 || throughputs.some((value) => !value)) throw new Error('候选生成失败 cards=' + candidates.length + ' forms=' + JSON.stringify(forms) + ' 提示=' + (document.getElementById('cadNotice')?.textContent ?? '(无)'));
          root.querySelector('[data-preview="0"]').click();
          await wait(80);
          root.querySelector('#designPreviewClose').click();
          next();
          await wait(120);
          const steps = root.querySelectorAll('.design-steps li').length;
          if (steps !== 5) throw new Error('向导步骤数错误 ' + steps);
          root.querySelectorAll('[data-station]')[2].click();
          await wait(60);
          root.querySelector('[data-action="add-actuator"]').click();
          await wait(60);
          const pointInputs = [...root.querySelectorAll('[data-actuator][data-key="extendPoint"]')].map((input) => input.value);
          const st3 = pointInputs.filter((value) => value.startsWith('ST3-EXT'));
          if (st3.length !== 1) throw new Error('点位自动分配异常 points=' + JSON.stringify(pointInputs));
          next();
          await wait(120);
          const placements = root.querySelectorAll('[data-placement]').length;
          const overlaps = root.querySelectorAll('.design-placement.overlap').length;
          const layoutText = root.querySelector('.design-layout-tools').textContent;
          next();
          await wait(100);
          root.querySelector('[data-action="run-review"]').click();
          await wait(150);
          const reviewText = root.querySelector('.design-content').textContent;
          const step5 = root.querySelector('.design-steps li.active').dataset.step;
          const canSave = !root.querySelector('[data-action="save-project"]').disabled;
          if (canSave) {
            root.querySelector('[data-action="save-project"]').click();
            await wait(2000);
          }
          // 保存后要解析 61 个 STL 并载入主视口，软件渲染下可能超过 2s，轮询等待
          let scenePartCount = 0;
          let sceneTrianglesZero = false;
          for (let i = 0; i < 60 && scenePartCount < 1; i += 1) {
            await wait(250);
            const parts = window.__AgentBridge.getScene().parts ?? [];
            scenePartCount = parts.length;
            sceneTrianglesZero = parts.length > 0 && parts.every((part) => part.triangles === 0);
          }
          const fallback = document.getElementById('cadWebglFallback');
          const saved = (await window.desktop.projects.list()).find((project) => project.name === 'Smoke 整机设计');
          const projectRow = [...document.querySelectorAll('[data-project-open]')].find((entry) => entry.dataset.projectOpen === saved?.id);
          return {
            steps, count: candidates.length, distinct, forms, throughputs,
            placements, overlaps, layoutText, reviewText, step5, canSave,
            saved: saved?.id || null, hasDesign: Boolean(saved?.design),
            draft: (await window.desktop.design.loadDraft()).draft,
            rootHidden: root.hidden,
            scene: scenePartCount,
            sceneTrianglesZero,
            degraded: Boolean(fallback),
            fallbackText: fallback?.textContent ?? '',
            fallbackMeshCount: Number(fallback?.querySelector('[data-cad-fallback="meshes"]')?.textContent ?? 0),
            fallbackTitle: fallback?.querySelector('.cad-fallback-title')?.textContent ?? '',
            projectMenuMeta: projectRow?.querySelector('.cad-project-meta')?.textContent ?? '',
            partPaths: (await window.desktop.projects.open(saved.id)).partPaths?.length ?? -1,
            bridgeReady: window.__AgentBridge.ready(),
            notice: document.getElementById('cadNotice')?.textContent ?? '',
            partCountText: document.getElementById('cadPartCount')?.textContent ?? ''
          };
        })()`) as {
          steps: number; count: number; distinct: number; forms: string[]; throughputs: string[];
          placements: number; overlaps: number; layoutText: string; reviewText: string; step5: string;
          canSave: boolean; saved: string | null; hasDesign: boolean; draft: unknown; rootHidden: boolean; scene: number; sceneTrianglesZero: boolean; degraded: boolean; fallbackText: string; fallbackMeshCount: number; fallbackTitle: string; projectMenuMeta: string; partCountText: string; notice: string; partPaths: number; bridgeReady: boolean;
        };
        if (designResult.steps !== 5 || designResult.step5 !== '5') throw new Error(`五步 UI 未走完 ${JSON.stringify(designResult)}`);
        console.log(`SMOKE_DESIGN_WIZARD_OK steps=${designResult.steps}`);
        if (designResult.count !== 3 || designResult.distinct !== 3) throw new Error('候选 smoke 断言失败');
        console.log(`SMOKE_DESIGN_CANDIDATES_OK count=${designResult.count} distinct=${designResult.distinct}`);
        console.log(`SMOKE_DESIGN_CANDIDATE_DATA ${designResult.forms.map((form, index) => `${form}:${designResult.throughputs[index]}`).join(' ')}`);
        if (designResult.placements < 1) throw new Error(`布局没有元素 ${JSON.stringify(designResult)}`);
        console.log(`SMOKE_DESIGN_LAYOUT_OK placements=${designResult.placements} overlaps=${designResult.overlaps}`);
        if (designResult.degraded) {
          if (designResult.scene !== designResult.partPaths || !designResult.sceneTrianglesZero || designResult.fallbackMeshCount !== designResult.partPaths || !designResult.fallbackTitle.includes('无法显示 3D 模型') || !designResult.fallbackText.includes('3D 渲染已停用') || !designResult.notice.includes('概念估算占位体') || !designResult.notice.includes('这不是 B-rep 精检或工程签核') || !designResult.reviewText.includes('不是 B-rep 精检、型号级实体验证或工程签核') || !designResult.projectMenuMeta.includes('设计向导概念估算占位体') || !designResult.projectMenuMeta.includes('非 B-rep 精检或工程签核')) {
            throw new Error(`WebGL 降级时应保留零件元数据、标记渲染停用并保留非签核提示：${JSON.stringify(designResult)}`);
          }
          console.log(`SMOKE_DESIGN_VIEWPORT_FALLBACK_OK scene=${designResult.scene} triangles=0 parsedMeshes=${designResult.fallbackMeshCount} viewport=unavailable`);
        } else {
          if (designResult.scene < 1) throw new Error(`已保存工程打开后主视口为空：AgentBridge scene=${designResult.scene}, partCount=${designResult.partCountText}`);
          if (!designResult.notice.includes('概念估算占位体') || !designResult.projectMenuMeta.includes('设计向导概念估算占位体')) throw new Error(`设计向导几何类型提示缺失：${JSON.stringify({ notice: designResult.notice, projectMenuMeta: designResult.projectMenuMeta })}`);
          console.log(`SMOKE_DESIGN_SCENE_BRIDGE_OK parts=${designResult.scene} type=concept-placeholder`);
        }
        if (!designResult.canSave || !designResult.saved || !designResult.hasDesign || designResult.draft !== null || !designResult.rootHidden || !Number(designResult.partCountText || 0) || designResult.partPaths < 1) {
          throw new Error(`设计工程保存/重载失败 ${JSON.stringify(designResult)}`);
        }
        console.log(`SMOKE_DESIGN_SAVE_OK project=${designResult.saved}`);
      } catch (error) {
        console.error('SMOKE_FAIL design_wizard', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }

      // ---- 画布工作台（P2）：拓扑 / 转接板闭环 / 2D 正交 / 导出 ----
      try {
        const canvas = (await window.webContents.executeJavaScript(
          'window.__CanvasWorkbench && window.__CanvasWorkbench.selfTest()'
        )) as null | {
          nodes: number;
          edges: number;
          mismatchBefore: number;
          mismatchAfterInsert: number;
          adaptersAfterInsert: number;
          mismatchAfterAll: number;
          adapterBridgesMatch: boolean;
          stations: number;
          artboards: number;
          ganttRows: number;
          cycleSeconds: number;
          unitsPerHour: number;
          pendingQuote: number;
          exportLengths: {
            json: number;
            build123d: number;
            plc: number;
            bom: number;
            dxf: number;
            layoutDxf: number;
            report: number;
          };
          pipStatus: string;
          pipBoxes: number;
          modelCheck: string;
          dimensions: number;
          adapterModelDoc: number;
          undoRestoredMismatch: number;
          redoRestoredAdapters: number;
        };
        if (!canvas) throw new Error('画布工作台未挂载（window.__CanvasWorkbench 缺失）');
        if (canvas.nodes < 2 || canvas.edges < 1) throw new Error(`画布拓扑为空 ${JSON.stringify(canvas)}`);
        if (canvas.mismatchBefore < 1) throw new Error(`演示拓扑应至少 1 条端口不匹配 ${JSON.stringify(canvas)}`);
        console.log(`SMOKE_CANVAS_TOPOLOGY_OK nodes=${canvas.nodes} edges=${canvas.edges} mismatched=${canvas.mismatchBefore}`);
        if (canvas.mismatchAfterInsert < 0 || canvas.adaptersAfterInsert < 1 || !canvas.adapterBridgesMatch || canvas.mismatchAfterAll !== 0) {
          throw new Error(`转接板闭环失败 ${JSON.stringify(canvas)}`);
        }
        console.log(`SMOKE_CANVAS_ADAPTER_OK mismatch=${canvas.mismatchBefore}->${canvas.mismatchAfterInsert} adapters=${canvas.adaptersAfterInsert} bridges=match`);
        if (canvas.undoRestoredMismatch !== canvas.mismatchBefore || canvas.redoRestoredAdapters !== 1) {
          throw new Error(`撤销/重做没有回放正确状态 ${JSON.stringify(canvas)}`);
        }
        console.log(`SMOKE_CANVAS_UNDO_OK undo_mismatch=${canvas.undoRestoredMismatch} redo_adapters=${canvas.redoRestoredAdapters}`);
        if (canvas.stations < canvas.nodes) throw new Error(`2D 正交站点数不足 ${JSON.stringify(canvas)}`);
        console.log(`SMOKE_CANVAS_ORTHO_OK stations=${canvas.stations} artboards=${canvas.artboards} gantt=${canvas.ganttRows}`);
        if (canvas.pipStatus !== 'ready' && canvas.pipStatus !== 'unavailable') {
          throw new Error(`3D 预览状态异常 ${JSON.stringify(canvas)}`);
        }
        if (canvas.pipBoxes < 1) throw new Error(`3D 预览没有盒子 ${JSON.stringify(canvas)}`);
        if (!(canvas.dimensions > 0)) throw new Error(`2D 尺寸链没有渲染 ${JSON.stringify(canvas)}`);
        if (!canvas.modelCheck || canvas.modelCheck.length < 10) {
          throw new Error(`3D 尺寸核对说明没有渲染 ${JSON.stringify(canvas)}`);
        }
        console.log(`SMOKE_CANVAS_PIP_OK boxes=${canvas.pipBoxes} status=${canvas.pipStatus} modelCheck=${canvas.modelCheck.length} dims=${canvas.dimensions}`);
        if (canvas.adapterModelDoc < 1) throw new Error(`转接板没有可建模的特征树 ${JSON.stringify(canvas)}`);
        console.log(`SMOKE_CANVAS_ADAPTER_MODEL_OK docs=${canvas.adapterModelDoc}`);
        if (
          canvas.exportLengths.json < 200 ||
          canvas.exportLengths.build123d < 200 ||
          canvas.exportLengths.plc < 200 ||
          canvas.exportLengths.bom < 80 ||
          canvas.exportLengths.dxf < 500 ||
          canvas.exportLengths.layoutDxf < 500 ||
          canvas.exportLengths.report < 300
        ) {
          throw new Error(`导出文本为空 ${JSON.stringify(canvas.exportLengths)}`);
        }
        if (!(canvas.cycleSeconds > 0) || !(canvas.unitsPerHour > 0)) throw new Error(`CT/UPH 异常 ${JSON.stringify(canvas)}`);
        console.log(`SMOKE_CANVAS_EXPORT_OK json=${canvas.exportLengths.json} build123d=${canvas.exportLengths.build123d} plc=${canvas.exportLengths.plc} bom=${canvas.exportLengths.bom} dxf=${canvas.exportLengths.dxf} layoutDxf=${canvas.exportLengths.layoutDxf} report=${canvas.exportLengths.report} ct=${canvas.cycleSeconds}s uph=${canvas.unitsPerHour} pendingQuote=${canvas.pendingQuote}`);
      } catch (error) {
        console.error('SMOKE_FAIL canvas_workbench', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }

      console.log('SMOKE_OK');
      setTimeout(() => app.quit(), 100);
    }
  });

  void window.loadFile(trustedUiPath);
  buildMenu(window);
  return window;
}

async function chooseCadFile(window: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: '打开 CAD 文件',
    properties: ['openFile'],
    filters: [
      { name: 'CAD 文件', extensions: CAD_EXTENSIONS.map((ext) => ext.slice(1)) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** 主进程侧的第三条入口（菜单直接调，不经过渲染进程）：拉起随包 Qt 原生工作台。 */
async function openQtWorkbench(window: BrowserWindow): Promise<void> {
  // launchQt 是 PromiseLike：await 后才拿到 900ms 观察窗的最终结论，
  // 否则「进程起来又秒退」会被当成功、菜单入口一个提示都不弹。
  // 观察窗内也开了广播抑制：失败由这里弹框说清楚，别再叠一条 toast。
  const endLaunchWindow = beginQtLaunchWindow();
  try {
    const result = await launchQt({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: app.getAppPath(),
      electronExePath: process.execPath,
      env: process.env,
      onExit: (info) => {
        // Qt 是 GUI 子系统程序：缺 DLL 时窗口不出现、stdout 为空，只有退出码+stderr 能解释「点了没反应」
        if (info.code === 0 || DIAGNOSE) return;
        console.error(`[qt] ${info.message}`);
      }
    });
    if (result.ok || window.isDestroyed()) return;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Qt 工作台',
      message: 'Qt 工作台没有启动',
      detail: result.message,
      buttons: ['知道了'],
      noLink: true
    });
  } finally {
    endLaunchWindow();
  }
}

function buildMenu(window: BrowserWindow): void {
  const send = (channel: string, payload?: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建设计', accelerator: 'CmdOrCtrl+N', click: () => send('desktop:new-design') },
        { type: 'separator' },
        {
          label: '打开 CAD…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const filePath = await chooseCadFile(window);
            if (filePath) send('desktop:open-cad', { path: filePath, source: 'menu' });
          }
        },
        {
          label: '导入数据包…',
          click: async () => {
            const result = await dialog.showOpenDialog(window, {
              title: '导入数据包',
              properties: ['openFile'],
              filters: [{ name: '数据包 ZIP', extensions: ['zip'] }]
            });
            if (!result.canceled && result.filePaths[0]) {
              send('desktop:import-pack', { path: result.filePaths[0] });
            }
          }
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '机械', accelerator: 'CmdOrCtrl+Alt+1', click: () => send('desktop:set-domain', 'mech') },
        { label: '电气', accelerator: 'CmdOrCtrl+Alt+2', click: () => send('desktop:set-domain', 'elec') }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '打开 Qt 工作台（OCCT 视口）',
          click: () => {
            void openQtWorkbench(window);
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 AutomationCAD',
          click: () => {
            void dialog.showMessageBox(window, {
              type: 'info',
              title: '关于 AutomationCAD',
              message: 'AutomationCAD 0.1.0',
              detail: 'Windows 11 桌面版首个可运行版本\nCAD 轻量化查看 · 数据包 · Agent 接口骨架',
              buttons: ['确定']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startAgent(
  registry: PackRegistry,
  commands: CommandBus,
  options: { userDataRoot: string; loadBuiltinPricebook: () => unknown; isModuleEnabled: (moduleId: string) => boolean }
): Promise<void> {
  const { token, tokenFile } = loadOrCreateAgentTokenFile(app.getPath('userData'));
  agentToken = token;
  agentTokenFile = tokenFile;
  lanConfig = readLanConfig(app.getPath('userData'));
  const tools = new AgentTools(registry, commands, { ...options, getRenderStats: () => lastRenderStats });
  agentTools = tools;
  commandBus = commands;
  const writeAudit = createAuditFileWriter(join(app.getPath('userData'), 'agent-audit.jsonl'), {
    retention: loadAuditRetention(app.getPath('userData')),
    onError: (error) => console.warn('[agent-audit] 轮转/清理失败', error instanceof Error ? error.message : String(error))
  });
  writeAgentAudit = (record) => writeAudit(formatAuditLine(record));
  // 先起转发器，构造 RPC 时 cdpPort 才能反映本轮真实状态。
  const cdpError = await configureCdpForwarder(lanConfig);
  if (cdpError) console.error(`[cdp] 未启动：${cdpError}`);
  agentServer = new AgentRpcServer({
    tools,
    token,
    version: app.getVersion(),
    host: lanHost(lanConfig),
    port: HEADLESS ? 0 : 7420,
    lanEnabled: lanConfig.enabled,
    allowlist: lanConfig.allowlist,
    cdpPort: cdpActive() ? CDP_EXTERNAL_PORT : null,
    renderStats: () => lastRenderStats,
    // MCP resources: 当前视口零件清单（渲染进程是唯一真源，读不到就返回空集）
    sceneParts: async () => {
      const window = mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return [];
      try {
        const parts = await window.webContents.executeJavaScript(
          'window.__AgentBridge?.getSceneParts?.() ?? []'
        );
        return Array.isArray(parts) ? parts : [];
      } catch {
        return [];
      }
    },
    audit: (record) => writeAudit(formatAuditLine(record)),
    // 外部客户端（MCP / JSON-RPC）也走页面内卡片：原生模态在无人值守/远程调试下点不到
    confirmWrite: async (name, args) => await requestWriteConfirmation(mainWindow, {
      tool: name,
      args,
      detail: 'MCP/JSON-RPC 客户端请求写操作，可能修改当前工程、导入模型或写入文件；允许仅对本次调用生效。',
      title: '外部客户端请求写操作'
    })
  });
  try {
    const info = await agentServer.start(tokenFile);
    agentInfo = { ...info, toolCount: tools.list().length };
    console.log(`[agent] ${info.url} · tools=${tools.list().length} · lan=${lanConfig.enabled ? 'on' : 'off'} · token=${tokenFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentInfo = { error: `Agent 服务启动失败：${message}` };
    console.error('[agent] 启动失败', error);
  }
}

function readUpdateChannelPreference(filePath: string): UpdateChannel {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as { channel?: unknown };
    return value.channel === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}

function persistUpdateChannelPreference(filePath: string, channel: UpdateChannel): void {
  writeFileSync(filePath, JSON.stringify({ channel, updatedAt: new Date().toISOString() }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}

/** Core security check: this runs even when the optional system.update module is off. */
function updateRuntimeAvailability(): { enabled: boolean; message: string } {
  if (!app.isPackaged) {
    return { enabled: false, message: '开发态不会查询更新；仅打包的 Windows NSIS 安装版启用更新。' };
  }
  if (process.platform !== 'win32') {
    return { enabled: false, message: '当前平台不提供 Windows NSIS 应用内更新。' };
  }
  const configPath = join(process.resourcesPath, 'app-update.yml');
  try {
    if (!existsSync(configPath) || !hasTrustedUpdateConfig(readFileSync(configPath, 'utf8'))) {
      return {
        enabled: false,
        message: '此安装包缺少受信任的 GitHub 更新源或 Authenticode 发布者信息，已阻止联网更新。请从可信安装包重新安装。'
      };
    }
  } catch {
    return { enabled: false, message: '无法验证安装包的更新源与签名配置，已阻止联网更新。' };
  }
  return { enabled: true, message: '' };
}

function assertTrustedUpdateSender(event: IpcMainInvokeEvent): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const senderUrl = event.senderFrame?.url ?? '';
  assertUpdateIpcAuthorization({
    mainWindowAlive: Boolean(mainWindow && !mainWindow.isDestroyed()),
    senderIsMainWindow: Boolean(mainWindow && senderWindow === mainWindow),
    senderIsMainFrame: Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame),
    senderUsesFileUrl: senderUrl.startsWith('file://')
  });
}

function registerUpdateIpcHandlers(service: UpdateChannelService): void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    assertTrustedUpdateSender(event);
    assertUpdateModuleEnabled(systemUpdateModuleEnabled);
  };
  ipcMain.handle('update:state', (event) => {
    authorize(event);
    return service.snapshot();
  });
  ipcMain.handle('update:set-channel', async (event, channel: unknown) => {
    authorize(event);
    return await service.setChannel(channel);
  });
  ipcMain.handle('update:check', async (event) => {
    authorize(event);
    return await service.check();
  });
  ipcMain.handle('update:download', async (event) => {
    authorize(event);
    return await service.download();
  });
  ipcMain.handle('update:install', async (event) => {
    authorize(event);
    const state = service.snapshot();
    if (state.status !== 'downloaded') throw new Error('尚无已验证完成的更新可安装。');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error('找不到更新确认窗口。');
    const result = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: '安装 AutomationCAD 更新',
      message: `确认安装版本 ${state.availableVersion ?? '新版本'} 并重启应用？`,
      detail: '应用将退出并运行 NSIS 更新安装程序。只有确认后才会安装，不会静默安装。',
      buttons: ['安装并重启', '稍后'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (result.response !== 0) return service.snapshot();
    return service.installAfterConfirmation();
  });
}

async function bootstrap(): Promise<void> {
  installCrashHandlers();
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();

  const updateChannelFile = join(app.getPath('userData'), 'update-preferences.json');
  const updateAvailability = updateRuntimeAvailability();
  const updateService = new UpdateChannelService({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    channel: readUpdateChannelPreference(updateChannelFile),
    enabled: updateAvailability.enabled,
    disabledMessage: updateAvailability.message,
    persistChannel: (channel) => persistUpdateChannelPreference(updateChannelFile, channel),
    onState: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:state-changed', snapshot);
      }
    }
  });
  registerUpdateIpcHandlers(updateService);

  parametric = new ParametricManager({
    appRoot: resolve(desktopRoot(), '..'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    isEnabled: () => parametricImportModuleEnabled
  });

  const registry = registerIpcHandlers({
    builtinDir: builtinPacksDir(),
    userDir: userPacksDir(),
    stateFile: join(app.getPath('userData'), 'packs-state.json'),
    factoryConfigFile: join(app.getPath('userData'), 'factory.json'),
    plcConfigFile: join(app.getPath('userData'), 'plc.json'),
    syncConfigFile: join(app.getPath('userData'), 'sync.json'),
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    trustedUiPath: indexHtmlPath(),
    getWindow: () => mainWindow,
    getAgentInfo: publicAgentInfo,
    isMainWindowSender: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    getParametric: () => parametric,
    isParametricImportEnabled: () => parametricImportModuleEnabled,
    setParametricImportEnabled: (enabled) => {
      parametricImportModuleEnabled = enabled === true;
      if (!parametricImportModuleEnabled && parametric) {
        void parametric.stop().catch((error: unknown) => {
          console.warn('[modules] 参数化内核停止失败', error instanceof Error ? error.message : String(error));
        });
      }
    },
    isPlcgenEnabled: () => plcgenModuleEnabled,
    setPlcgenEnabled: (enabled) => { plcgenModuleEnabled = enabled; },
    isFactoryPlcSyncEnabled: () => factoryPlcSyncModuleEnabled,
    setFactoryPlcSyncEnabled: (enabled) => { factoryPlcSyncModuleEnabled = enabled; },
    isAgentResumeEnabled: () => agentResumeModuleEnabled,
    setAgentResumeEnabled: (enabled) => { agentResumeModuleEnabled = enabled; },
    isProjectPortableEnabled: () => projectPortableModuleEnabled,
    setProjectPortableEnabled: (enabled) => { projectPortableModuleEnabled = enabled; },
    isCostEstimationEnabled: () => costEstimationModuleEnabled,
    setCostEstimationEnabled: (enabled) => { costEstimationModuleEnabled = enabled === true; },
    setElecValidationEnabled: (enabled) => { elecValidationModuleEnabled = enabled === true; },
    setSystemUpdateEnabled: (enabled) => { systemUpdateModuleEnabled = enabled === true; }
  });

  // FreeCAD 后台任务（可选组件）：未安装只禁用工程图等任务，不影响建模；探测延迟到首次查询。
  const freecadSettingsFile = join(app.getPath('userData'), 'freecad.json');
  freecadConfiguredPath = readFreecadSettings(freecadSettingsFile).path;
  freecadRunner = new FreecadRunner({
    resolveScript: () => resolveTechdrawScript({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: resolve(desktopRoot(), '..')
    }),
    getConfiguredPath: () => freecadConfiguredPath,
    tempRoot: join(app.getPath('temp'), 'automationcad-freecad'),
    svgToPdf: svgToPdfWithElectron
  });
  const drawingsService = new DrawingsService({
    userDataDir: app.getPath('userData'),
    projectsRoot: projectsRoot(app.getPath('userData')),
    runner: freecadRunner,
    isEnabled: () => drawingsModuleEnabled,
    // 逐件 STEP：特征树是唯一主数据，现场让 build123d sidecar 导出单件（零件自身坐标系）
    buildStep: async (doc) => {
      if (!parametricImportModuleEnabled) throw new Error('参数化模块已关闭，无法导出零件 STEP');
      const manager = parametric;
      if (!manager) throw new Error('参数化建模内核不可用');
      const started = await manager.start();
      if (!started.ok) throw new Error(started.message);
      const built = await manager.build(doc);
      if (!built.ok) throw new Error(built.message ?? '建模失败');
      const step = built.files?.step;
      const path = step && typeof step === 'object' ? (step as { path?: unknown }).path : null;
      if (typeof path !== 'string' || !path) throw new Error('内核未返回 STEP 文件');
      return path;
    }
  });
  registerDrawingsIpc({
    getWindow: () => mainWindow,
    trustedUiPath: indexHtmlPath(),
    runner: freecadRunner,
    service: drawingsService,
    settingsFile: freecadSettingsFile,
    isEnabled: () => drawingsModuleEnabled,
    setEnabled: (enabled) => { drawingsModuleEnabled = enabled === true; },
    setConfiguredPath: (path) => { freecadConfiguredPath = path; }
  });

  packRegistry = registry;
  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });

  commandBus = createAgentCommandBus(registry, new RendererBridge(() => mainWindow), {
    isModuleEnabled: (moduleId) => moduleId === 'plcgen' ? plcgenModuleEnabled
      : moduleId === 'elec.validation' ? elecValidationModuleEnabled
        : moduleId === 'cost.estimation' ? costEstimationModuleEnabled
        : moduleId === PARAMETRIC_IMPORT_MODULE_ID ? parametricImportModuleEnabled : false,
    loadBuiltinPricebook: readBuiltinPricebookRaw,
    renderCostPdf: renderCostReportPdf,
    renderReportPdf: renderAssemblyReportPdf,
    exportsRoot: join(app.getPath('userData'), 'exports'),
    userDataRoot: app.getPath('userData'),
    // 机型几何实体化：只在内核已就绪时调用，不为此隐式拉起 400 MB 的 Python 进程。
    buildSolids: async (doc) => {
      if (!parametricImportModuleEnabled) {
        return { ok: false, code: 'MODULE_DISABLED', message: '功能模块「cad.parametric-import」当前已关闭；启用后才能生成参数化实体。CAD 只读查看仍可使用。' };
      }
      const manager = parametric;
      if (!manager || manager.status().status !== 'ready') {
        return { ok: false, code: 'UNAVAILABLE', message: '参数化建模内核未启动' };
      }
      return manager.build(doc);
    }
  });
  await startAgent(registry, commandBus, {
    userDataRoot: app.getPath('userData'),
    loadBuiltinPricebook: readBuiltinPricebookRaw,
    isModuleEnabled: (moduleId) => moduleId === 'plcgen' ? plcgenModuleEnabled
      : moduleId === 'elec.validation' ? elecValidationModuleEnabled
        : moduleId === 'cost.estimation' ? costEstimationModuleEnabled
        : moduleId === PARAMETRIC_IMPORT_MODULE_ID ? parametricImportModuleEnabled : false
  });
  registerAgentChatIpc({
    userDataDir: app.getPath('userData'),
    getTools: () => agentTools,
    getBus: () => commandBus,
    getWindow: () => mainWindow,
    trustedUiPath: indexHtmlPath(),
    isAgentResumeEnabled: () => agentResumeModuleEnabled,
    getLanAccess: getAgentLanAccess,
    saveLanAccess: saveAgentLanAccess,
    rotateToken: rotateAgentTokenAndRestart,
    recordRenderStats
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}

app.on('window-all-closed', () => {
  // --diagnose 会临时创建隐藏窗口探测 WebGL；窗口关闭不能把诊断进程提前带走。
  if (DIAGNOSE) return;
  if (process.platform !== 'darwin') app.quit();
});

let quitAfterParametricStop = false;
app.on('will-quit', () => {
  // 随包 Qt 是长驻子进程：Electron 退出时它不会自己走。win32 用 taskkill /T 连子孙进程一起收，
  // 否则用户下次启动会留一堆看不见的 automationcad-qt.exe 占着 OCCT 显存。
  killActiveQt();
});
app.on('before-quit', (event) => {
  if (agentServer) void agentServer.stop();
  void stopCdpForwarder();
  void disposeIpcRuntime();
  if (freecadRunner) {
    const runner = freecadRunner;
    freecadRunner = null;
    void runner.dispose();
  }
  if (!parametric || parametric.status().status === 'stopped') return;
  if (quitAfterParametricStop) return;
  event.preventDefault();
  quitAfterParametricStop = true;
  const manager = parametric;
  parametric = null;
  void manager.stop().finally(() => app.quit());
});
