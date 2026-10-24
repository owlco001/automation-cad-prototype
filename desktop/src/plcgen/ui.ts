/**
 * PLC 程序生成面板：电气域顶栏「PLC 程序」入口。
 *
 * 数据来源：`window.__PlcGenConfigProvider()`，未注入时回落到 `initPlcGenUi({ getConfig })`。
 * 面板只负责编排；生成、预检、文件树与历史去重都由可单测的纯函数完成。
 */
import plcgenStyles from './plcgen.css?inline';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { buildEntryButton, ensurePanelStyles, errorMessage, escapeHtml, notify } from '../ui/panels';
import { precheck } from './precheck.ts';
import { buildTags } from './tags.ts';
import { generateProject, type GenerateProjectSuccess, type ProjectStats } from './generate.ts';
import { summarizeVerification, verifyGenerated, type VerifyResult } from './verify.ts';
import {
  createHistoryEntry,
  mergePlcHistory,
  parsePlcHistory,
  type PlcHistoryEntry,
  type PlcHistoryFile
} from './history.ts';
import type { GeneratedFile, PlcGenConfig, PlcTarget, PrecheckResult } from './types.ts';
import {
  buildClipboardBundle,
  buildFileTree,
  countContentLines,
  contentBytes,
  defaultNamePrefix,
  formatStatsLine,
  isGenerateDisabled,
  locateIssue,
  PLC_TARGET_OPTIONS,
  previewFile,
  targetLabel
} from './view-model.ts';

const ENTRY_ID = 'plcGenEntryButton';
const OVERLAY_ID = 'plcGenOverlay';
const HISTORY_KEY = 'automationcad.plcgen.history.v1';

const ENTRY_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h11v11h-11z"/><path d="M2.5 6h11M2.5 10h11M6 2.5v11M10 2.5v11"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 16 16"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>';

interface PlcGenUiOptions {
  getConfig?: () => PlcGenConfig | null;
  enabled?: boolean;
}

export interface PlcGenUiHandle {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

interface PanelNodes {
  overlay: HTMLElement;
  machineMeta: HTMLElement;
  target: HTMLSelectElement;
  prefix: HTMLInputElement;
  precheck: HTMLButtonElement;
  simulate: HTMLButtonElement;
  generate: HTMLButtonElement;
  status: HTMLElement;
  issueCount: HTMLElement;
  issues: HTMLElement;
  mechanisms: HTMLElement;
  fileCount: HTMLElement;
  fileTree: HTMLElement;
  previewPath: HTMLElement;
  previewMeta: HTMLElement;
  preview: HTMLElement;
  copyFile: HTMLButtonElement;
  history: HTMLElement;
  stats: HTMLElement;
  exportPath: HTMLElement;
  exportZip: HTMLButtonElement;
  copyAll: HTMLButtonElement;
  openDir: HTMLButtonElement;
}

let initialized = false;
let options: PlcGenUiOptions = {};
let moduleEnabled = true;
let entryElement: HTMLButtonElement | null = null;
let nodes: PanelNodes | null = null;
let config: PlcGenConfig | null = null;
let lastConfigId = '';
let lastPrecheck: PrecheckResult | null = null;
let lastFiles: GeneratedFile[] = [];
let lastStats: ProjectStats | null = null;
let lastGeneratedAt = '';
let generatedInSession = false;
let exportPath = '';
let selectedFile: string | null = null;
let viewingHistory = false;
let history: PlcHistoryEntry[] = [];
let generating = false;
let lastVerify: VerifyResult | null = null;
let highlightedActuatorId = '';

function injectStyles(): void {
  ensurePanelStyles();
  if (document.getElementById('plcgen-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'plcgen-panel-styles';
  style.textContent = plcgenStyles;
  document.head.appendChild(style);
}

function resolveConfig(): PlcGenConfig | null {
  const provider = window.__PlcGenConfigProvider;
  if (typeof provider === 'function') {
    try {
      return provider() ?? null;
    } catch (error) {
      recordDiagnosticError('PLCGEN_CONFIG_PROVIDER_FAILED', error, { site: 'desktop/src/plcgen/ui.ts', source: 'window' });
      return null;
    }
  }
  try {
    return options.getConfig?.() ?? null;
  } catch (error) {
    recordDiagnosticError('PLCGEN_CONFIG_PROVIDER_FAILED', error, { site: 'desktop/src/plcgen/ui.ts', source: 'options' });
    return null;
  }
}

function currentTarget(): PlcTarget {
  const value = nodes?.target.value;
  return PLC_TARGET_OPTIONS.some((option) => option.id === value) ? value as PlcTarget : 'generic';
}

function currentPrefix(): string {
  return nodes?.prefix.value.trim() || defaultNamePrefix(config);
}

function setStatus(message: string, tone: 'ok' | 'warn' | 'error' | 'idle' = 'idle'): void {
  if (!nodes) return;
  nodes.status.textContent = message;
  nodes.status.classList.toggle('is-on', Boolean(message));
  nodes.status.classList.toggle('is-ok', tone === 'ok');
  nodes.status.classList.toggle('is-warn', tone === 'warn');
  nodes.status.classList.toggle('is-error', tone === 'error');
}

function refreshActionButtons(): void {
  if (!nodes) return;
  nodes.generate.disabled = isGenerateDisabled({
    hasConfig: Boolean(config),
    precheck: lastPrecheck,
    generating
  });
  nodes.precheck.disabled = !config || generating;
  nodes.simulate.disabled = !config || generating;
  nodes.exportZip.disabled = lastFiles.length === 0 || viewingHistory;
  nodes.copyAll.disabled = lastFiles.length === 0;
  nodes.openDir.disabled = false;
}

function renderMachine(): void {
  if (!nodes) return;
  if (!config) {
    nodes.machineMeta.innerHTML = '<span class="plc-machine-name">未加载机型配置</span><span class="plc-muted">请先完成机型 / 联调配置，或注入 __PlcGenConfigProvider</span>';
    nodes.mechanisms.innerHTML = '<div class="plc-empty">未加载机型配置，无法定位机构。</div>';
    nodes.prefix.value = 'PLC';
    return;
  }
  let points = 0;
  try {
    points = buildTags(config).rows.length;
  } catch {
    points = 0;
  }
  const stations = config.stations?.length ?? 0;
  const actuators = config.actuators?.length ?? 0;
  nodes.machineMeta.innerHTML = `
    <span class="plc-machine-name">${escapeHtml(config.name || config.id || '未命名机型')}</span>
    <span class="plc-machine-code">${escapeHtml(config.id || '—')}</span>
    <span class="plc-machine-scale"><b>${stations}</b> 工位 · <b>${actuators}</b> 执行机构 · <b>${points}</b> 点位</span>`;

  const actuatorsList = config.actuators ?? [];
  nodes.mechanisms.innerHTML = actuatorsList.length === 0
    ? '<div class="plc-empty">机型没有执行机构。</div>'
    : actuatorsList.map((actuator) => `
      <button type="button" class="plc-mech${actuator.id === highlightedActuatorId ? ' is-target' : ''}" data-plc-mech-id="${escapeHtml(actuator.id)}" title="点击高亮">
        <b>${escapeHtml(actuator.name)}</b>
        <span>${escapeHtml(actuator.station)} · ${escapeHtml(actuator.kind)}</span>
      </button>`).join('');
  nodes.mechanisms.querySelectorAll<HTMLElement>('[data-plc-mech-id]').forEach((element) => {
    element.addEventListener('click', () => {
      highlightedActuatorId = element.dataset.plcMechId ?? '';
      renderMachine();
    });
  });

  if (config.id && config.id !== lastConfigId) {
    nodes.prefix.value = defaultNamePrefix(config);
    lastConfigId = config.id;
  }
}

function issueLocationText(issue: Parameters<typeof locateIssue>[0]): string {
  if (!config) return '';
  const location = locateIssue(issue, config);
  if (!location) return '';
  if (location.actuatorName) return `定位：${location.actuatorName}`;
  if (location.station) return `定位：${location.station}`;
  return '';
}

function renderPrecheck(): void {
  if (!nodes) return;
  if (!lastPrecheck) {
    nodes.issues.innerHTML = '<div class="plc-empty">点击「预检」检查地址、传感器绑定、安全件与步序引用。</div>';
    nodes.issueCount.textContent = '未运行';
    refreshActionButtons();
    return;
  }
  const errors = lastPrecheck.errors;
  const warnings = lastPrecheck.warnings;
  nodes.issueCount.textContent = `${errors.length} 错误 · ${warnings.length} 警告`;
  if (errors.length === 0 && warnings.length === 0) {
    nodes.issues.innerHTML = '<div class="plc-empty is-ok">预检通过：没有发现问题。</div>';
  } else {
    const rows = [
      ...errors.map((issue) => ({ issue, level: 'error' as const })),
      ...warnings.map((issue) => ({ issue, level: 'warning' as const }))
    ];
    nodes.issues.innerHTML = rows.map(({ issue, level }, index) => `
      <button type="button" class="plc-issue is-${level}" data-plc-issue="${index}">
        <span class="plc-pill is-${level === 'error' ? 'error' : 'warn'}">${level === 'error' ? '错误' : '警告'}</span>
        <span class="plc-issue-body">
          <b>${escapeHtml(issue.code)}</b>
          <span>${escapeHtml(issue.message)}</span>
          ${issue.path ? `<code>${escapeHtml(issue.path)}</code>` : ''}
          ${issueLocationText(issue) ? `<em>${escapeHtml(issueLocationText(issue))}</em>` : ''}
        </span>
      </button>`).join('');
    nodes.issues.querySelectorAll<HTMLElement>('[data-plc-issue]').forEach((element) => {
      element.addEventListener('click', () => {
        const index = Number(element.dataset.plcIssue);
        const row = rows[index];
        if (!row || !config) return;
        const location = locateIssue(row.issue, config);
        if (!location) {
          notify('该问题没有关联到具体机构，请按问题路径检查配置。', true);
          return;
        }
        highlightedActuatorId = location.actuatorId ?? '';
        renderMachine();
        const target = location.actuatorId
          ? nodes?.mechanisms.querySelector<HTMLElement>(`[data-plc-mech-id="${CSS.escape(location.actuatorId)}"]`)
          : nodes?.mechanisms;
        target?.scrollIntoView({ block: 'nearest' });
        notify(location.actuatorName ? `已定位到执行机构：${location.actuatorName}` : `已定位到工位：${location.station ?? '未知'}`);
      });
    });
  }
  refreshActionButtons();
}

function renderStats(elapsedMs: number): void {
  if (!nodes) return;
  nodes.stats.textContent = lastStats
    ? formatStatsLine(lastStats, elapsedMs)
    : '尚未生成';
}

function selectFile(path: string): void {
  if (!nodes) return;
  selectedFile = path;
  const file = lastFiles.find((candidate) => candidate.path === path);
  if (!file) {
    nodes.previewPath.textContent = path;
    nodes.previewMeta.textContent = '历史记录仅保留文件清单';
    nodes.preview.textContent = `文件：${path}\n\n历史记录未保存文件正文，重新生成后可查看前 200 行预览。`;
    return;
  }
  const preview = previewFile(file);
  nodes.previewPath.textContent = preview.path;
  nodes.previewMeta.textContent = `${preview.totalLines} 行 · ${contentBytes(file.content)} B${preview.truncated ? ' · 已截断' : ''}`;
  nodes.preview.textContent = preview.text;
  nodes.copyFile.disabled = false;
  nodes.fileTree.querySelectorAll<HTMLElement>('[data-plc-file]').forEach((element) => {
    element.classList.toggle('is-selected', element.dataset.plcFile === path);
  });
}

function renderFiles(files: readonly GeneratedFile[]): void {
  if (!nodes) return;
  nodes.fileCount.textContent = `${files.length} 个文件`;
  if (files.length === 0) {
    nodes.fileTree.innerHTML = '<div class="plc-empty">生成成功后在这里显示文件树。</div>';
    nodes.previewPath.textContent = '选择文件预览';
    nodes.previewMeta.textContent = '';
    nodes.preview.textContent = '尚未生成文件。';
    nodes.copyFile.disabled = true;
    return;
  }
  const tree = buildFileTree(files);
  nodes.fileTree.innerHTML = tree.map((row) => row.kind === 'dir'
    ? `<div class="plc-tree-row is-dir" style="--depth:${row.depth}"><span class="plc-tree-icon">▸</span><span class="plc-tree-name">${escapeHtml(row.name)}/</span></div>`
    : `<button type="button" class="plc-tree-row is-file" data-plc-file="${escapeHtml(row.path)}" style="--depth:${row.depth}">
        <span class="plc-tree-icon">·</span>
        <span class="plc-tree-name">${escapeHtml(row.name)}</span>
        <span class="plc-tree-meta">${row.lines} 行 · ${row.bytes} B</span>
      </button>`).join('');
  nodes.fileTree.querySelectorAll<HTMLElement>('[data-plc-file]').forEach((element) => {
    element.addEventListener('click', () => selectFile(element.dataset.plcFile ?? ''));
  });
  const preferred = files.find((file) => file.path === 'README.md') ?? files[0];
  if (preferred) selectFile(preferred.path);
  nodes.copyFile.disabled = false;
}

function historyFiles(entry: PlcHistoryEntry): PlcHistoryFile[] {
  return entry.fileList.length > 0 ? entry.fileList : [];
}

function renderHistory(): void {
  if (!nodes) return;
  if (history.length === 0) {
    nodes.history.innerHTML = '<div class="plc-empty">还没有生成记录。</div>';
    return;
  }
  nodes.history.innerHTML = history.map((entry, index) => `
    <button type="button" class="plc-history-row" data-plc-history="${index}" title="查看文件清单">
      <span class="plc-history-time">${escapeHtml(formatTime(entry.at))}</span>
      <code>${escapeHtml(entry.inputHash)}</code>
      <span>${entry.files} 个文件</span>
      <span class="plc-pill">${escapeHtml(targetLabel(entry.target))}</span>
    </button>`).join('');
  nodes.history.querySelectorAll<HTMLElement>('[data-plc-history]').forEach((element) => {
    element.addEventListener('click', () => {
      const entry = history[Number(element.dataset.plcHistory)];
      if (entry) showHistoryFiles(entry);
    });
  });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function showHistoryFiles(entry: PlcHistoryEntry): void {
  if (!nodes) return;
  viewingHistory = true;
  const files = historyFiles(entry);
  nodes.fileCount.textContent = `历史 · ${entry.files} 个文件`;
  nodes.fileTree.innerHTML = files.length === 0
    ? '<div class="plc-empty">该历史记录没有文件清单。</div>'
    : files.map((file) => {
        const depth = Math.max(0, file.path.split('/').length - 1);
        return `<button type="button" class="plc-tree-row is-file" data-plc-history-file="${escapeHtml(file.path)}" style="--depth:${depth}">
          <span class="plc-tree-icon">·</span>
          <span class="plc-tree-name">${escapeHtml(file.path.split('/').at(-1) ?? file.path)}</span>
          <span class="plc-tree-meta">${file.lines} 行 · ${file.bytes} B</span>
        </button>`;
      }).join('');
  nodes.previewPath.textContent = `历史 · ${entry.inputHash}`;
  nodes.previewMeta.textContent = `${formatTime(entry.at)} · ${entry.files} 个文件`;
  nodes.preview.textContent = `最近一次生成：${formatTime(entry.at)}\ninputHash：${entry.inputHash}\n目标：${targetLabel(entry.target)}\n命名前缀：${entry.namePrefix || '—'}\n\n文件清单：\n${files.map((file) => `- ${file.path}（${file.lines} 行 · ${file.bytes} B）`).join('\n') || '- （无）'}`;
  nodes.fileTree.querySelectorAll<HTMLElement>('[data-plc-history-file]').forEach((element) => {
    element.addEventListener('click', () => {
      const path = element.dataset.plcHistoryFile ?? '';
      nodes!.previewPath.textContent = path;
      nodes!.previewMeta.textContent = '历史记录仅保留文件清单';
      nodes!.preview.textContent = `文件：${path}\n\n历史记录未保存文件正文，重新生成后可查看前 200 行预览。`;
    });
  });
  refreshActionButtons();
}

async function runPrecheck(): Promise<PrecheckResult | null> {
  if (!moduleEnabled) return null;
  if (!config) {
    lastPrecheck = null;
    renderPrecheck();
    setStatus('未加载机型配置，无法执行预检。', 'warn');
    return null;
  }
  try {
    lastPrecheck = precheck(config);
    renderPrecheck();
    if (lastPrecheck.errors.length > 0) {
      setStatus(`预检发现 ${lastPrecheck.errors.length} 个错误，生成已禁用。`, 'error');
    } else if (lastPrecheck.warnings.length > 0) {
      setStatus(`预检通过，${lastPrecheck.warnings.length} 条警告。`, 'warn');
    } else {
      setStatus('预检通过：可以生成。', 'ok');
    }
    return lastPrecheck;
  } catch (error) {
    recordDiagnosticError('PLCGEN_PRECHECK_FAILED', error, { site: 'desktop/src/plcgen/ui.ts' });
    lastPrecheck = null;
    renderPrecheck();
    setStatus(`预检失败：${errorMessage(error)}`, 'error');
    notify(`预检失败：${errorMessage(error)}。请检查点位与表达式配置后重试。`, true);
    return null;
  }
}

async function recordHistory(entry: PlcHistoryEntry): Promise<void> {
  history = parsePlcHistory(mergePlcHistory(history, entry, 10));
  renderHistory();
  const api = window.desktop?.plcgen;
  if (api) {
    try {
      history = parsePlcHistory(await api.recordHistory(entry));
      renderHistory();
      return;
    } catch (error) {
      // 主进程不可写时仍保留当前会话历史。
      console.warn(`[PLCGEN_HISTORY_MAIN_WRITE_FAILED]`, { site: 'desktop/src/plcgen/ui.ts:400' }, error);
    }
  }
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    // localStorage 不可用时只保留当前会话。
    console.warn(`[PLCGEN_HISTORY_LOCALSTORAGE_WRITE_FAILED]`, { site: 'desktop/src/plcgen/ui.ts:406' }, error);
  }
}

async function loadHistory(): Promise<void> {
  const api = window.desktop?.plcgen;
  if (api) {
    try {
      history = parsePlcHistory(await api.history());
      renderHistory();
      return;
    } catch (error) {
      // 回落到 localStorage。
      console.warn(`[PLCGEN_HISTORY_LOCALSTORAGE_READ_FAILED]`, { site: 'desktop/src/plcgen/ui.ts:418' }, error);
    }
  }
  try {
    history = parsePlcHistory(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]'));
  } catch {
    history = [];
  }
  renderHistory();
}

async function runSimulate(): Promise<VerifyResult | null> {
  if (!moduleEnabled) return null;
  if (!config || generating) return null;
  generating = true;
  refreshActionButtons();
  nodes?.simulate.classList.add('is-busy');
  setStatus('正在预检、生成并模拟执行联调序列…', 'idle');
  try {
    const result = verifyGenerated(config, {
      target: currentTarget(),
      namePrefix: currentPrefix(),
      sequenceTimeoutMs: 5000
    });
    lastVerify = result;
    if (result.precheck.errors.length > 0) {
      lastPrecheck = result.precheck;
      renderPrecheck();
    }
    const summary = summarizeVerification(result);
    if (result.ok) {
      const message = `模拟验证通过：${summary.passed}/${summary.steps} 步 · ${summary.elapsedMs} ms · 报警 ${summary.alarms.length}`;
      setStatus(message, 'ok');
      notify(message);
    } else {
      const sequenceError = result.errors.find((error) =>
        error.code === 'SEQUENCE_EMPTY' || error.code === 'SEQUENCE_MISSING'
      );
      const reason = summary.failure?.reason
        ?? sequenceError?.message
        ?? result.errors[0]?.message
        ?? `预检 ${result.precheck.errors.length} 个错误`;
      const message = `模拟验证失败：${reason}`;
      setStatus(message, 'error');
      notify(message, true);
    }
    return result;
  } catch (error) {
    recordDiagnosticError('PLCGEN_SIMULATION_FAILED', error, { site: 'desktop/src/plcgen/ui.ts' });
    setStatus(`模拟验证失败：${errorMessage(error)}`, 'error');
    notify(`模拟验证失败：${errorMessage(error)}。请检查点位映射与梯形图条件后重试。`, true);
    return null;
  } finally {
    generating = false;
    nodes?.simulate.classList.remove('is-busy');
    refreshActionButtons();
  }
}

async function runGenerate(): Promise<GenerateProjectSuccess | null> {
  if (!moduleEnabled) return null;
  if (!config || generating) return null;
  if (!lastPrecheck) await runPrecheck();
  if (isGenerateDisabled({ hasConfig: Boolean(config), precheck: lastPrecheck })) {
    notify('预检存在错误，请先修正后再生成。', true);
    return null;
  }
  generating = true;
  refreshActionButtons();
  nodes?.generate.classList.add('is-busy');
  setStatus('正在生成 ST 程序与变量表…', 'idle');
  const started = performance.now();
  try {
    const target = currentTarget();
    const namePrefix = currentPrefix();
    const result = generateProject({ config, target, namePrefix, sequenceTimeoutMs: 5000 });
    const elapsed = performance.now() - started;
    if (!result.ok) {
      lastPrecheck = result.precheck;
      renderPrecheck();
      setStatus(`生成被预检拦截：${result.errors.length} 个错误。`, 'error');
      notify('生成被预检拦截，请先修复问题。', true);
      return null;
    }
    lastPrecheck = result.precheck;
    lastFiles = result.files;
    lastStats = result.stats;
    lastGeneratedAt = new Date().toISOString();
    generatedInSession = true;
    exportPath = '';
    viewingHistory = false;
    if (nodes) nodes.exportPath.textContent = '';
    renderPrecheck();
    renderFiles(result.files);
    renderStats(elapsed);
    setStatus(`生成完成：${result.stats.files} 个文件，${result.stats.tags} 个变量。`, 'ok');

    const fileList = result.files.map((file) => ({
      path: file.path,
      lines: countContentLines(file.content),
      bytes: contentBytes(file.content)
    }));
    await recordHistory(createHistoryEntry({
      inputHash: result.stats.inputHash,
      target,
      namePrefix,
      at: lastGeneratedAt,
      files: fileList
    }));
    refreshActionButtons();
    notify(`已生成 ${result.stats.files} 个 PLC 文件`);
    return result;
  } catch (error) {
    recordDiagnosticError('PLCGEN_GENERATE_FAILED', error, { site: 'desktop/src/plcgen/ui.ts' });
    setStatus(`生成失败：${errorMessage(error)}`, 'error');
    notify(`生成失败：${errorMessage(error)}。请先通过预检，或检查导出目录权限。`, true);
    return null;
  } finally {
    generating = false;
    nodes?.generate.classList.remove('is-busy');
    refreshActionButtons();
  }
}

async function exportZip(): Promise<{ ok: boolean; path?: string; zipPath?: string; message?: string }> {
  if (!moduleEnabled) throw new Error('PLC 程序模块已关闭');
  if (lastFiles.length === 0) throw new Error('请先生成 PLC 文件');
  if (!config) throw new Error('未加载机型配置');
  const api = window.desktop?.plcgen;
  if (!api) throw new Error('导出 zip 仅在桌面版可用');
  const result = await api.exportProject({
    machineName: config.name || config.id || 'PLC',
    namePrefix: currentPrefix(),
    target: currentTarget(),
    files: lastFiles
  });
  if (!result.ok) throw new Error(result.message || 'PLC 导出失败');
  exportPath = result.path ?? '';
  if (nodes) {
    nodes.exportPath.textContent = exportPath ? `已导出：${exportPath}` : '';
    nodes.exportPath.title = exportPath;
  }
  setStatus(`已导出 ${lastFiles.length} 个文件到 ${exportPath}`, 'ok');
  notify(`PLC 已导出：${exportPath || result.zipPath || ''}`);
  return result;
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    notify(`${label}已复制`);
  } catch (error) {
    notify(`复制失败：${errorMessage(error)}`, true);
  }
}

async function openExportDir(): Promise<void> {
  if (!moduleEnabled) {
    notify('PLC 程序模块已关闭', true);
    return;
  }
  const api = window.desktop?.plcgen;
  if (!api) {
    notify('打开导出目录仅在桌面版可用', true);
    return;
  }
  try {
    const result = await api.openExportDir(exportPath || undefined);
    if (!result.ok) throw new Error(result.message || '无法打开导出目录');
    notify(`已打开导出目录：${result.path}`);
  } catch (error) {
    notify(`打开导出目录失败：${errorMessage(error)}`, true);
  }
}

function close(): void {
  if (!nodes) return;
  const wasOpen = !nodes.overlay.hidden;
  nodes.overlay.hidden = true;
  entryElement?.classList.remove('is-active');
  if (wasOpen) entryElement?.focus();
}

function open(): void {
  if (!moduleEnabled) return;
  buildOverlay();
  if (!nodes) return;
  window.AutomationCadViewer?.close();
  document.querySelectorAll<HTMLElement>('.acp-drawer.is-open').forEach((drawer) => {
    drawer.hidden = true;
    drawer.classList.remove('is-open');
  });
  const enclosure = document.getElementById('enclosureOverlay');
  if (enclosure) enclosure.hidden = true;
  nodes.overlay.hidden = false;
  entryElement?.classList.add('is-active');

  config = resolveConfig();
  lastPrecheck = null;
  lastVerify = null;
  lastFiles = [];
  lastStats = null;
  lastGeneratedAt = '';
  exportPath = '';
  selectedFile = null;
  viewingHistory = false;
  nodes.exportPath.textContent = '';
  renderMachine();
  renderFiles([]);
  renderStats(0);
  renderPrecheck();
  renderHistory();
  if (config) {
    void runPrecheck();
  } else {
    setStatus('未加载机型配置：请先完成机型 / 联调配置。', 'warn');
  }
  void loadHistory();
}

function buildOverlay(): void {
  if (nodes) return;
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'plc-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <header class="plc-topbar">
      <div class="plc-brand">
        <div class="plc-brand-mark">${ENTRY_ICON}</div>
        <div>
          <div class="plc-brand-title">PLC 程序生成</div>
          <div class="plc-brand-sub">预检 · IEC 61131-3 ST · 变量表 · 导出 zip</div>
        </div>
      </div>
      <div class="plc-machine-meta" id="plcMachineMeta"></div>
      <div class="plc-top-actions">
        <span class="plc-pill">电气域</span>
        <button type="button" class="plc-btn plc-btn-ghost" id="plcClose">${CLOSE_ICON}<span>关闭</span></button>
      </div>
    </header>
    <main class="plc-main">
      <section class="plc-side">
        <div class="plc-section-title">生成配置 <b>目标 / 前缀</b></div>
        <div class="plc-config-grid">
          <label>目标平台
            <select id="plcTarget" class="plc-input">
              ${PLC_TARGET_OPTIONS.map((option) => `<option value="${option.id}">${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
          <label>命名前缀
            <input id="plcPrefix" class="plc-input" type="text" maxlength="40" autocomplete="off" aria-label="命名前缀">
          </label>
        </div>
        <div class="plc-actions">
          <button type="button" class="plc-btn" id="plcPrecheck">预检</button>
          <button type="button" class="plc-btn" id="plcSimulate" disabled>模拟验证</button>
          <button type="button" class="plc-btn plc-btn-primary" id="plcGenerate" disabled>生成</button>
        </div>
        <div class="plc-status" id="plcStatus"></div>

        <div class="plc-section-title">预检结果 <b id="plcIssueCount">未运行</b></div>
        <div class="plc-issues" id="plcIssues"></div>

        <div class="plc-section-title">机构定位 <b>点击问题可高亮</b></div>
        <div class="plc-mechs" id="plcMechanisms"></div>
      </section>
      <section class="plc-files">
        <div class="plc-section-title">生成文件 <b id="plcFileCount">0 个文件</b></div>
        <div class="plc-tree" id="plcFileTree"><div class="plc-empty">生成成功后在这里显示文件树。</div></div>
      </section>
      <section class="plc-preview">
        <div class="plc-preview-head">
          <div class="plc-preview-title">
            <b id="plcPreviewPath">选择文件预览</b>
            <span id="plcPreviewMeta"></span>
          </div>
          <button type="button" class="plc-btn plc-btn-ghost" id="plcCopyFile" disabled>复制文件</button>
        </div>
        <pre class="plc-preview-body" id="plcPreviewBody">尚未生成文件。</pre>
      </section>
    </main>
    <section class="plc-history-wrap">
      <div class="plc-section-title">生成历史 <b>最近 10 次 · 点击回看文件清单</b></div>
      <div class="plc-history" id="plcHistory"></div>
    </section>
    <footer class="plc-footer">
      <span class="plc-stats" id="plcStats">尚未生成</span>
      <span class="plc-footer-spacer"></span>
      <span class="plc-export-path" id="plcExportPath" title=""></span>
      <button type="button" class="plc-btn" id="plcExportZip" disabled>导出 zip</button>
      <button type="button" class="plc-btn" id="plcCopyAll" disabled>复制全部</button>
      <button type="button" class="plc-btn plc-btn-ghost" id="plcOpenDir">打开导出目录</button>
    </footer>`;
  document.body.appendChild(overlay);

  const query = <T extends HTMLElement>(selector: string): T => {
    const element = overlay.querySelector<T>(selector);
    if (!element) throw new Error(`PLC 面板节点缺失：${selector}`);
    return element;
  };
  nodes = {
    overlay,
    machineMeta: query('#plcMachineMeta'),
    target: query<HTMLSelectElement>('#plcTarget'),
    prefix: query<HTMLInputElement>('#plcPrefix'),
    precheck: query<HTMLButtonElement>('#plcPrecheck'),
    simulate: query<HTMLButtonElement>('#plcSimulate'),
    generate: query<HTMLButtonElement>('#plcGenerate'),
    status: query('#plcStatus'),
    issueCount: query('#plcIssueCount'),
    issues: query('#plcIssues'),
    mechanisms: query('#plcMechanisms'),
    fileCount: query('#plcFileCount'),
    fileTree: query('#plcFileTree'),
    previewPath: query('#plcPreviewPath'),
    previewMeta: query('#plcPreviewMeta'),
    preview: query('#plcPreviewBody'),
    copyFile: query<HTMLButtonElement>('#plcCopyFile'),
    history: query('#plcHistory'),
    stats: query('#plcStats'),
    exportPath: query('#plcExportPath'),
    exportZip: query<HTMLButtonElement>('#plcExportZip'),
    copyAll: query<HTMLButtonElement>('#plcCopyAll'),
    openDir: query<HTMLButtonElement>('#plcOpenDir')
  };

  query<HTMLButtonElement>('#plcClose').addEventListener('click', close);
  nodes.precheck.addEventListener('click', () => void runPrecheck());
  nodes.simulate.addEventListener('click', () => void runSimulate());
  nodes.generate.addEventListener('click', () => void runGenerate());
  nodes.exportZip.addEventListener('click', () => {
    void exportZip().catch((error: unknown) => notify(`导出失败：${errorMessage(error)}`, true));
  });
  nodes.copyFile.addEventListener('click', () => {
    const file = lastFiles.find((candidate) => candidate.path === selectedFile);
    if (file) void copyText(file.content, `文件 ${file.path} `);
  });
  nodes.copyAll.addEventListener('click', () => {
    if (lastFiles.length > 0) void copyText(buildClipboardBundle(lastFiles), '全部文件');
  });
  nodes.openDir.addEventListener('click', () => void openExportDir());
  nodes.target.addEventListener('change', invalidateGeneration);
  nodes.prefix.addEventListener('input', invalidateGeneration);
}

function invalidateGeneration(): void {
  if (lastFiles.length === 0) return;
  lastFiles = [];
  lastStats = null;
  lastVerify = null;
  exportPath = '';
  viewingHistory = false;
  if (nodes) {
    nodes.exportPath.textContent = '';
    renderFiles([]);
    renderStats(0);
    setStatus('生成配置已变更，请重新生成。', 'warn');
  }
  refreshActionButtons();
}

function setEntryVisibility(): void {
  if (!entryElement) return;
  const activeDomain = document.querySelector<HTMLElement>('.domsw-btn.is-active')?.dataset.domain;
  const domain = document.body.dataset.domain ?? activeDomain ?? 'mech';
  entryElement.hidden = !moduleEnabled || domain !== 'elec';
}
export function initPlcGenUi(uiOptions: PlcGenUiOptions = {}): PlcGenUiHandle {
  if (initialized) {
    return { setEnabled: setModuleEnabled, isEnabled: () => moduleEnabled };
  }
  initialized = true;
  options = uiOptions;
  moduleEnabled = uiOptions.enabled ?? true;
  injectStyles();
  entryElement = buildEntryButton(ENTRY_ID, 'PLC 程序', ENTRY_ICON, open);
  entryElement?.classList.add('plc-entry-btn');
  setEntryVisibility();

  const domainSwitch = document.getElementById('domsw');
  if (domainSwitch) {
    new MutationObserver(setEntryVisibility).observe(domainSwitch, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-domain']
    });
  }
  new MutationObserver(setEntryVisibility).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-domain']
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#cadEntryButton')) close();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (nodes && !nodes.overlay.hidden && event.key === 'Escape') close();
  }, true);

  window.__PlcGenPanel = {
    open,
    close,
    hasConfig: () => Boolean(config),
    precheck: runPrecheck,
    simulate: runSimulate,
    generate: runGenerate,
    exportZip,
    openExportDir,
    history: () => history,
    files: () => lastFiles,
    status: () => nodes?.stats.textContent ?? '',
    uiState: () => ({
      open: Boolean(nodes && !nodes.overlay.hidden),
      hasConfig: Boolean(config),
      generateDisabled: nodes ? nodes.generate.disabled : true,
      simulateDisabled: nodes ? nodes.simulate.disabled : true,
      generated: generatedInSession,
      generatedAt: lastGeneratedAt,
      verifyOk: lastVerify ? lastVerify.ok : null,
      verifySteps: lastVerify?.simulation?.steps.length ?? 0,
      verifyAlarms: lastVerify?.simulation?.alarms.length ?? 0,
      files: lastFiles.length,
      treeRows: lastFiles.length > 0 ? buildFileTree(lastFiles).length : 0,
      history: history.length,
      previewPath: selectedFile,
      precheckErrors: lastPrecheck?.errors.length ?? -1,
      enabled: moduleEnabled,
      stats: nodes?.stats.textContent ?? ''
    })
  };
  setEntryVisibility();
  return { setEnabled: setModuleEnabled, isEnabled: () => moduleEnabled };
}

function setModuleEnabled(enabled: boolean): void {
  moduleEnabled = enabled;
  if (!enabled) close();
  setEntryVisibility();
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `open`。 */
export const openPlcGen = open;
/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `close`。 */
export const closePlcGen = close;
