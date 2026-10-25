import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml,
  notify
} from '../ui/panels.ts';
import type { SyncPackageSummary, SyncPublicConfig, SyncResult, SyncUploadPayload } from './types.ts';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { PLC_TARGET_LABELS } from '../plcgen/generate.ts';
import { PLC_TARGETS, type PlcTarget } from '../plcgen/types.ts';

const SYNC_ICON = '<svg viewBox="0 0 16 16"><path d="M13.5 5.5a5.5 5.5 0 0 0-9.8-1.8L2.5 5.2"/><path d="M2.5 2.8v2.4h2.4"/><path d="M2.5 10.5a5.5 5.5 0 0 0 9.8 1.8l1.2-1.5"/><path d="M13.5 13.2v-2.4h-2.4"/></svg>';

interface SyncPanelOptions {
  buildPayload(target: PlcTarget): Promise<SyncUploadPayload>;
  getMachineContext?(): unknown;
}

interface SyncElements {
  baseUrl: HTMLInputElement;
  deviceId: HTMLInputElement;
  projectId: HTMLInputElement;
  apiKey: HTMLInputElement;
  apiKeyHint: HTMLElement;
  enabled: HTMLInputElement;
  plcTarget: HTMLSelectElement;
  save: HTMLButtonElement;
  test: HTMLButtonElement;
  upload: HTMLButtonElement;
  refresh: HTMLButtonElement;
  status: HTMLElement;
  lastResult: HTMLElement;
  packages: HTMLElement;
  candidate: HTMLElement;
}

let elements: SyncElements | null = null;
let current: SyncPublicConfig | null = null;
let busy = false;
let panelOptions: SyncPanelOptions | null = null;
let reviewCandidatePackageId: string | null = null;

function desktop() {
  return window.desktop;
}

function setStatus(message: string, kind: 'ok' | 'error' | 'warn' | 'idle' = 'idle'): void {
  if (!elements) return;
  elements.status.textContent = message;
  elements.status.classList.toggle('is-on', Boolean(message));
  elements.status.classList.toggle('is-error', kind === 'error');
  elements.status.classList.toggle('is-warn', kind === 'warn');
  if (kind !== 'idle') notify(message, kind === 'error');
}

function setBusy(next: boolean): void {
  busy = next;
  if (!elements) return;
  elements.save.disabled = next;
  elements.test.disabled = next;
  elements.refresh.disabled = next;
  elements.upload.disabled = next || !elements.enabled.checked;
  elements.plcTarget.disabled = next;
  elements.packages.querySelectorAll<HTMLButtonElement>('[data-sync-download]').forEach((button) => {
    button.disabled = next;
  });
  elements.candidate.querySelectorAll<HTMLButtonElement>('[data-sync-export]').forEach((button) => {
    button.disabled = next;
  });
}

function applyPublicConfig(config: SyncPublicConfig): void {
  current = config;
  if (!elements) return;
  elements.baseUrl.value = config.baseUrl;
  elements.deviceId.value = config.deviceId;
  elements.projectId.value = config.projectId;
  elements.enabled.checked = config.enabled;
  elements.apiKey.value = '';
  elements.apiKey.placeholder = config.hasApiKey ? '留空则保持已保存的密钥' : '输入智慧工厂设备接入密钥';
  elements.apiKeyHint.textContent = config.hasApiKey
    ? `已保存 API Key：${config.apiKeyMasked}（脱敏显示，留空保存不会覆盖）`
    : '尚未保存 API Key。填写后保存，配置文件权限为 600。';
  elements.upload.disabled = !config.enabled || busy;
}

function collectPatch(): Record<string, unknown> {
  if (!elements) return {};
  return {
    baseUrl: elements.baseUrl.value.trim(),
    deviceId: elements.deviceId.value.trim(),
    projectId: elements.projectId.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    enabled: elements.enabled.checked
  };
}

async function saveConfig(quiet = false): Promise<boolean> {
  const api = desktop();
  if (!api) {
    setStatus('智慧工厂同步仅在桌面版可用。', 'error');
    return false;
  }
  try {
    const saved = await api.sync.saveConfig(collectPatch());
    applyPublicConfig(saved);
    if (!quiet) setStatus('同步设置已保存，API Key 仅以掩码回显。', 'ok');
    return true;
  } catch (error) {
    recordDiagnosticError('SYNC_CONFIG_SAVE_FAILED', error, { site: 'desktop/src/sync/ui.ts' });
    setStatus(`保存设置失败：${errorMessage(error)}。请检查 baseUrl 与 API Key 是否为有效值。`, 'error');
    return false;
  }
}

function failureMessage(result: SyncResult, fallbackStage: '打包' | '连接' | '上传' | '解析'): string {
  const stage = result.stage ?? fallbackStage;
  const message = result.message?.trim() || '未知错误';
  return message.includes('失败：') ? message : `${stage}失败：${message}`;
}

async function testConnection(): Promise<void> {
  const api = desktop();
  if (!api || busy) return;
  if (!(await saveConfig(true))) return;
  setBusy(true);
  setStatus('正在测试 baseUrl、机台编号 device_no 与 API Key…', 'idle');
  try {
    const result = await api.sync.test();
    if (!result.ok) {
      const message = result.message ?? '未知错误';
      setStatus(message.includes('失败：') ? message : `连接失败：${message}`, 'error');
      return;
    }
    setStatus(result.message ?? '连接成功，设备图纸接口可用。', 'ok');
  } catch (error) {
    setStatus(`连接失败：${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

function renderLastResult(text: string, ok: boolean): void {
  if (!elements) return;
  const time = new Date().toLocaleString('zh-CN');
  elements.lastResult.innerHTML = `<span class="acp-pill ${ok ? 'is-ok' : 'is-error'}">${ok ? '成功' : '失败'}</span>
    <span class="acp-pill">${escapeHtml(time)}</span>
    <div class="acp-sync-result-text">${escapeHtml(text)}</div>`;
}

function renderPackages(items: readonly SyncPackageSummary[]): void {
  if (!elements) return;
  if (items.length === 0) {
    elements.packages.innerHTML = '<div class="acp-empty">服务端尚无设计包。完成一次「立即同步」后会出现在这里。</div>';
    return;
  }
  elements.packages.innerHTML = items.map((item) => `<div class="acp-pack-row acp-sync-package">
    <div class="acp-pack-main">
      <div>
        <div class="acp-pack-name">v${escapeHtml(String(item.version))} · ${escapeHtml(item.packageId)}</div>
        <div class="acp-pack-meta">${escapeHtml(item.projectId)} · ${escapeHtml(item.createdAt)}
          ${item.uploadedBy ? ` · ${escapeHtml(item.uploadedBy)}` : ''}<br>BOM ${escapeHtml(item.bomSha256.slice(0, 12))}…</div>
      </div>
    </div>
    <button type="button" class="acp-btn acp-btn-ghost" data-sync-download="${escapeHtml(item.packageId)}">下载并校验候选</button>
  </div>`).join('');
}

async function downloadCandidate(packageId: string): Promise<void> {
  const api = desktop();
  if (!api || busy || !packageId) return;
  reviewCandidatePackageId = null;
  setBusy(true);
  elements!.candidate.textContent = `正在下载并校验 ${packageId}…`;
  try {
    const result = await api.sync.downloadCandidate(packageId, panelOptions?.getMachineContext?.());
    if (!result.ok || !result.candidate) {
      const message = result.message ?? '服务端候选无法校验';
      elements!.candidate.innerHTML = `<span class="acp-pill is-error">候选已拒绝</span><div>${escapeHtml(message)}</div>`;
      setStatus(`下载候选失败：${message}`, 'error');
      return;
    }
    const manifest = result.candidate.manifest && typeof result.candidate.manifest === 'object'
      ? result.candidate.manifest as Record<string, unknown>
      : {};
    const projectName = typeof manifest.projectName === 'string' ? manifest.projectName : '未命名工程';
    const plc = result.candidate.plc;
    reviewCandidatePackageId = plc ? packageId : null;
    const lines = [
      `工程：${projectName}`,
      `大小：${result.bytes ?? 0} bytes · SHA-256 ${result.sha256 ?? '—'}`,
      `机型上下文：${result.candidate.machineContextStatus}`,
      plc ? `PLC：${plc.target} · machine=${plc.machineId} · ${plc.programFiles.length} 个程序文件 · 生成器 ${plc.generatedVersion}` : 'PLC：无 PLC 扩展'
    ];
    const reviewAction = plc
      ? `<div class="acp-row" style="margin-top:10px"><button type="button" class="acp-btn acp-btn-ghost" data-sync-export="${escapeHtml(packageId)}">导出为新的本地审阅副本</button></div>
        <div>导出只包含白名单 ST、io-tags.csv 与 mapping.json；不导出机型 IO mapping CSV。</div>
        <div>这是本地审阅副本，不是安装或应用；不会执行 ST、修改/覆盖当前工程、上传文件或连接 PLC。</div>`
      : '';
    elements!.candidate.innerHTML = `<span class="acp-pill is-ok">下载并校验通过 · 只读候选</span>
      <div>${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      <div>显式应用要求：${result.candidate.requiresExplicitApply ? '是' : '未知'}</div>
      <div>候选解析不会执行 ST、写入本地文件或覆盖当前工程。</div>${reviewAction}</div>`;
    setStatus(`设计包 ${packageId} 已校验为只读候选；可选择显式导出本地审阅副本，不会应用到工程。`, 'ok');
  } catch (error) {
    const message = errorMessage(error);
    elements!.candidate.innerHTML = `<span class="acp-pill is-error">候选已拒绝</span><div>${escapeHtml(message)}</div>`;
    setStatus(`下载候选失败：${message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshPackages(quiet = false, force = false): Promise<void> {
  const api = desktop();
  if (!api || (busy && !force)) return;
  try {
    const result = await api.sync.list();
    if (!result.ok) {
      renderPackages([]);
      if (!quiet) setStatus(`读取设计包列表失败：${result.message ?? '未知错误'}`, 'warn');
      return;
    }
    renderPackages(result.items ?? []);
    if (!quiet) setStatus(`已刷新，最近 ${result.items?.length ?? 0} 个设计包。`, 'ok');
  } catch (error) {
    renderPackages([]);
    if (!quiet) setStatus(`读取设计包列表失败：${errorMessage(error)}`, 'warn');
  }
}

async function uploadNow(): Promise<void> {
  const api = desktop();
  if (!api || busy) return;
  if (!elements?.enabled.checked) {
    setStatus('上传失败：请先打开「启用智慧工厂同步」并保存设置。', 'error');
    return;
  }
  if (!(await saveConfig(true))) return;
  if (!current?.hasApiKey) {
    setStatus('连接失败：尚未保存 API Key。', 'error');
    return;
  }

  setBusy(true);
  try {
    setStatus('正在生成 PDF / GLB / DXF / BOM；若启用了 PLC 同步扩展，会附带 PLC 与机型 IO mapping…', 'idle');
    let payload: SyncUploadPayload;
    try {
      payload = await panelOptions!.buildPayload(elements!.plcTarget.value as PlcTarget);
    } catch (error) {
      setStatus(`打包失败：${errorMessage(error)}`, 'error');
      renderLastResult(`打包失败：${errorMessage(error)}`, false);
      return;
    }

    setStatus('正在验证智慧工厂连接…', 'idle');
    const connection = await api.sync.test();
    if (!connection.ok) {
      const detail = connection.message ?? '未知错误';
      const message = detail.includes('失败：') ? detail : `连接失败：${detail}`;
      setStatus(message, 'error');
      renderLastResult(message, false);
      return;
    }

    setStatus('正在打包并上传设计包（≤200MB）…', 'idle');
    const result = await api.sync.upload(payload);
    if (!result.ok) {
      const message = failureMessage(result, '上传');
      setStatus(message, 'error');
      renderLastResult(message, false);
      return;
    }
    if (!result.packageId) {
      const message = '解析失败：服务端未返回 packageId';
      setStatus(message, 'error');
      renderLastResult(message, false);
      return;
    }
    const summary = `packageId=${result.packageId} · version=${result.version ?? '—'} · ${result.duplicated ? '命中幂等（重复包）' : '新包已入库'}${result.message ? ` · ${result.message}` : ''}`;
    setStatus(`同步成功：${summary}`, result.duplicated ? 'warn' : 'ok');
    renderLastResult(summary, true);
    void refreshPackages(true, true);
  } catch (error) {
    const message = `上传失败：${errorMessage(error)}`;
    setStatus(message, 'error');
    renderLastResult(message, false);
  } finally {
    setBusy(false);
  }
}

async function loadConfig(): Promise<void> {
  const api = desktop();
  if (!api) {
    setStatus('智慧工厂同步仅在桌面版可用。', 'error');
    return;
  }
  try {
    applyPublicConfig(await api.sync.getConfig());
  } catch (error) {
    setStatus(`读取同步配置失败：${errorMessage(error)}`, 'error');
  }
}

export function initSyncPanel(options: SyncPanelOptions): void {
  ensurePanelStyles();
  panelOptions = options;
  const entry = buildEntryButton('syncEntryButton', '智慧工厂', SYNC_ICON, () => {
    drawer.open();
    void loadConfig();
  });
  if (!entry) return;
  const drawer = createDrawer('syncDrawer', '智慧工厂同步', '设计包上传 · 手动触发 · X-Design-Key');
  const plcTargetOptions = PLC_TARGETS.map((target) =>
    `<option value="${escapeHtml(target)}"${target === 'generic' ? ' selected' : ''}>${escapeHtml(PLC_TARGET_LABELS[target])}</option>`
  ).join('');
  drawer.body.innerHTML = `
    <div class="acp-status" id="syncStatusBar"></div>
    <div class="acp-section-title"><span>接入设置</span><b>design-sync v1</b></div>
    <div class="acp-field">
      <span>baseUrl</span>
      <input class="acp-input" id="syncBaseUrl" placeholder="https://factory.example.com" autocomplete="off">
    </div>
    <div class="acp-row">
      <div class="acp-field" style="flex:1;min-width:0">
        <span>机台编号（device_no）</span>
        <input class="acp-input" id="syncDeviceId" placeholder="DEV-001" autocomplete="off">
      </div>
      <div class="acp-field" style="flex:1;min-width:0">
        <span>projectId</span>
        <input class="acp-input" id="syncProjectId" placeholder="asm-slide-cyl" autocomplete="off">
      </div>
    </div>
    <div class="acp-field">
      <span>apiKey（设备接入密钥）</span>
      <input class="acp-input" id="syncApiKey" type="password" placeholder="输入智慧工厂设备接入密钥" autocomplete="new-password">
    </div>
    <div class="acp-note" id="syncApiKeyHint">尚未保存 API Key。配置文件位于 userData/sync.json，权限 600。</div>
    <label class="acp-switch" style="margin:10px 0 12px"><input type="checkbox" id="syncEnabled">启用智慧工厂同步（本版本仅手动上传）</label>
    <div class="acp-field">
      <span>目标 PLC 平台</span>
      <select class="acp-input" id="syncPlcTarget" aria-describedby="syncPlcTargetHint">${plcTargetOptions}</select>
      <div class="acp-note" id="syncPlcTargetHint">仅在 factory.plc-sync 启用时生效；关闭时不会生成 PLC 程序或 IO mapping。</div>
    </div>
    <div class="acp-row">
      <button type="button" class="acp-btn" id="syncSave">保存设置</button>
      <button type="button" class="acp-btn" id="syncTest">测试连接</button>
      <button type="button" class="acp-btn acp-btn-primary" id="syncUpload" disabled>立即同步</button>
      <button type="button" class="acp-btn acp-btn-ghost" id="syncRefreshList">刷新列表</button>
    </div>
    <div class="acp-section-title"><span>最近同步结果</span><b>手动触发</b></div>
    <div class="acp-note" id="syncLastResult">尚无同步记录。点击「立即同步」先生成导出物，再打包并上传。</div>
    <div class="acp-section-title"><span>最近设计包</span><b>20</b></div>
    <div id="syncPackages"><div class="acp-empty">打开面板后点击「刷新列表」读取服务端设计包。</div></div>
    <div class="acp-section-title"><span>下载候选（只读）</span><b>本地审阅导出</b></div>
    <div class="acp-note" id="syncCandidate">选择一个设计包下载并校验。候选仅展示摘要；成功后可显式导出新建的本地审阅副本，不提供安装、应用或恢复操作。</div>
    <div class="acp-note">本地审阅导出由主进程弹出父文件夹选择器，只写入新的唯一目录；不会执行 ST、写入或覆盖当前工程、上传候选或连接 PLC。机型 IO mapping CSV 暂不导出，等待安全持久化口径确定。</div>
    <div class="acp-note">流程：生成 PDF / GLB / DXF / BOM；仅在「factory.plc-sync」启用且 plcgen 可用时附带 PLC ST 与机型 IO mapping → 校验路径、大小、机型与 SHA-256 → ZIP → 上传。关闭 PLC 同步扩展后，普通设计包仍可上传/下载；含 PLC 的下载候选会被拒绝，不会自动覆盖工程或后台同步。</div>`;
  drawer.footer.innerHTML = '<span class="acp-pill">15 秒超时</span><span class="acp-pill">Idempotency-Key = ZIP SHA-256</span><span class="acp-pill">API Key 脱敏</span>';

  const baseUrl = drawer.body.querySelector<HTMLInputElement>('#syncBaseUrl');
  const deviceId = drawer.body.querySelector<HTMLInputElement>('#syncDeviceId');
  const projectId = drawer.body.querySelector<HTMLInputElement>('#syncProjectId');
  const apiKey = drawer.body.querySelector<HTMLInputElement>('#syncApiKey');
  const apiKeyHint = drawer.body.querySelector<HTMLElement>('#syncApiKeyHint');
  const enabled = drawer.body.querySelector<HTMLInputElement>('#syncEnabled');
  const plcTarget = drawer.body.querySelector<HTMLSelectElement>('#syncPlcTarget');
  const save = drawer.body.querySelector<HTMLButtonElement>('#syncSave');
  const test = drawer.body.querySelector<HTMLButtonElement>('#syncTest');
  const upload = drawer.body.querySelector<HTMLButtonElement>('#syncUpload');
  const refresh = drawer.body.querySelector<HTMLButtonElement>('#syncRefreshList');
  const status = drawer.body.querySelector<HTMLElement>('#syncStatusBar');
  const lastResult = drawer.body.querySelector<HTMLElement>('#syncLastResult');
  const packages = drawer.body.querySelector<HTMLElement>('#syncPackages');
  const candidate = drawer.body.querySelector<HTMLElement>('#syncCandidate');
  if (!baseUrl || !deviceId || !projectId || !apiKey || !apiKeyHint || !enabled || !plcTarget || !save || !test || !upload ||
      !refresh || !status || !lastResult || !packages || !candidate) {
    throw new Error('智慧工厂同步面板节点缺失');
  }
  elements = { baseUrl, deviceId, projectId, apiKey, apiKeyHint, enabled, plcTarget, save, test, upload, refresh, status, lastResult, packages, candidate };
  save.addEventListener('click', () => void saveConfig());
  test.addEventListener('click', () => void testConnection());
  upload.addEventListener('click', () => void uploadNow());
  refresh.addEventListener('click', () => void refreshPackages());
  packages.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>('[data-sync-download]');
    if (!button || !packages.contains(button)) return;
    void downloadCandidate(button.dataset.syncDownload ?? '');
  });
  candidate.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>('[data-sync-export]');
    if (!button || !candidate.contains(button)) return;
    void exportCandidateReview(button.dataset.syncExport ?? '');
  });
  enabled.addEventListener('change', () => {
    if (elements) elements.upload.disabled = !elements.enabled.checked || busy;
  });
}

async function exportCandidateReview(packageId: string): Promise<void> {
  const api = desktop();
  if (!api || busy || !packageId || packageId !== reviewCandidatePackageId) return;
  setBusy(true);
  setStatus('请在主进程打开的系统对话框中选择审阅导出的父文件夹…', 'idle');
  try {
    const result = await api.sync.exportCandidateReview(packageId);
    if (!result.ok) {
      setStatus(`本地审阅导出失败：${result.message ?? '未知错误'}`, 'error');
      return;
    }
    if (result.canceled) {
      setStatus('已取消本地审阅导出；没有创建文件夹。', 'warn');
      return;
    }
    const folderName = result.folderName ?? 'PLC 审阅目录';
    setStatus(`已创建新的本地审阅副本「${folderName}」（${result.fileCount ?? 0} 个文件）；未安装或应用。`, 'ok');
  } catch (error) {
    setStatus(`本地审阅导出失败：${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}
