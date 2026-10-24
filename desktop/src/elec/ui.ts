/**
 * 电气校验面板：把 `runElectricalCheck` 的结果搬到界面上，并支持导出 PDF。
 *
 * 数据来源通过 `window.__ElecDocProvider` 注入（原理图数据就绪后提供 ElecDocument）；
 * 未注入时面板只提示，不会伪造数据。`window.__ElecCheckPanel` 供冒烟与后续命令式调用。
 */
import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  escapeHtml,
  errorMessage,
  notify,
  type DrawerHandle
} from '../ui/panels';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { ModuleDisabledError, moduleDisabledResult } from '../modules/tool-gates.ts';
import {
  describeCheck,
  runElectricalCheck,
  type ElecCheckResult,
  type ElecDocument,
  type Finding
} from './check';
import { renderElecCheckHtml, SEVERITY_LABELS } from './report';

const CHECK_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 8.4l3.1 3.1 7-7"/><path d="M2.5 13.2h11"/></svg>';
const NO_SOURCE_HINT = '尚未接入电气数据源：请先打开含线号/负载的电气数据，或由上层注入 __ElecDocProvider';

let drawer: DrawerHandle | null = null;
let lastResult: ElecCheckResult | null = null;
let lastHtml = '';
let moduleEnabled = true;
let entryButton: HTMLButtonElement | null = null;

export interface ElecCheckPanelHandle {
  setEnabled(enabled: boolean): void;
}

interface PanelNodes {
  status: HTMLElement;
  summary: HTMLElement;
  table: HTMLElement;
  run: HTMLButtonElement;
  pdf: HTMLButtonElement;
}

let nodes: PanelNodes | null = null;

function projectInfo(): { name: string; code: string; author: string } {
  return { name: '电气原理图', code: 'ELEC-CHECK', author: 'AutomationCAD' };
}

function docFromSource(): ElecDocument | null {
  const provider = window.__ElecDocProvider;
  if (typeof provider !== 'function') return null;
  try {
    return provider() ?? null;
  } catch (error) {
    recordDiagnosticError('ELEC_DOC_PROVIDER_FAILED', error, { site: 'desktop/src/elec/ui.ts' });
    return null;
  }
}

function summaryCards(result: ElecCheckResult): string {
  const { counts, summary } = result;
  const breaker = summary.breakerSuggestion;
  const margin = summary.psuMarginRatio;
  const cards: Array<{ label: string; value: string; tone?: string }> = [
    { label: '严重', value: String(counts.error), ...(counts.error > 0 ? { tone: 'error' } : { tone: 'ok' }) },
    { label: '警告', value: String(counts.warning), ...(counts.warning > 0 ? { tone: 'warn' } : { tone: 'ok' }) },
    { label: '提示', value: String(counts.info) },
    { label: '安装容量', value: `${summary.totalKw.toFixed(2)} kW` },
    { label: '视在功率', value: `${summary.totalKva.toFixed(2)} kVA` },
    { label: '最大相电流', value: `${summary.maxPhaseCurrentA.toFixed(1)} A` },
    { label: '不平衡度', value: `${(summary.unbalanceRatio * 100).toFixed(1)} %`, ...(summary.unbalanceRatio > 0.15 ? { tone: 'warn' } : {}) },
    { label: '主断路器', value: breaker ? `${breaker.ratedA} A / ≥${breaker.cableMm2} mm²` : '—' },
    { label: '24V 余量', value: margin === null ? '未选电源' : `${(margin * 100).toFixed(1)} %`, ...(margin !== null && margin < 0.2 ? { tone: 'warn' } : {}) }
  ];
  return cards.map((card) => `<div class="acp-check-card${card.tone ? ` is-${card.tone}` : ''}">
      <span>${escapeHtml(card.label)}</span><b>${escapeHtml(card.value)}</b>
    </div>`).join('');
}

function findingRows(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return '<div class="acp-empty">未发现问题：线号、功率与导线截面校验全部通过。</div>';
  }
  const rows = findings.map((item, index) => `<tr>
      <td class="acp-check-num">${index + 1}</td>
      <td><span class="acp-pill ${item.severity === 'error' ? 'is-error' : item.severity === 'warning' ? 'is-warn' : ''}">${escapeHtml(SEVERITY_LABELS[item.severity])}</span></td>
      <td><div class="acp-check-msg">${escapeHtml(item.message)}</div>
        <div class="acp-check-loc">${escapeHtml(item.location)}${item.suggestion ? ` · 建议：${escapeHtml(item.suggestion)}` : ''}</div></td>
    </tr>`).join('');
  return `<table class="acp-check-table">
      <thead><tr><th style="width:26px">#</th><th style="width:52px">级别</th><th>问题与建议</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function render(result: ElecCheckResult): void {
  lastResult = result;
  lastHtml = renderElecCheckHtml(projectInfo(), result);
  if (!nodes) return;
  nodes.status.textContent = describeCheck(result);
  nodes.status.classList.add('is-on');
  nodes.status.classList.toggle('is-error', result.counts.error > 0);
  nodes.status.classList.toggle('is-warn', result.counts.error === 0 && result.counts.warning > 0);
  nodes.summary.innerHTML = summaryCards(result);
  nodes.table.innerHTML = findingRows(result.findings);
  nodes.pdf.disabled = false;
}

async function runWith(doc: ElecDocument | null): Promise<ElecCheckResult | null> {
  if (!moduleEnabled) return null;
  if (!doc) {
    notify(NO_SOURCE_HINT, true);
    return null;
  }
  try {
    const result = runElectricalCheck(doc);
    render(result);
    notify(result.counts.error > 0
      ? `电气校验完成：${result.counts.error} 项严重问题`
      : `电气校验完成：警告 ${result.counts.warning} 项`, result.counts.error > 0);
    return result;
  } catch (error) {
    recordDiagnosticError('ELEC_CHECK_FAILED', error, { site: 'desktop/src/elec/ui.ts' });
    notify(`电气校验失败：${errorMessage(error)}。请检查电气图数据后重试。`, true);
    return null;
  }
}

async function exportPdf(): Promise<{ path: string; htmlPath: string }> {
  if (!moduleEnabled) throw new ModuleDisabledError('elec.validation');
  if (!lastResult) throw new Error('请先运行电气校验再导出 PDF');
  if (!window.desktop) throw new Error('导出 PDF 仅在桌面版可用');
  const html = lastHtml || renderElecCheckHtml(projectInfo(), lastResult);
  return await window.desktop.exportReport({ html, projectName: projectInfo().name });
}

export function initElecCheckPanel(options: { enabled?: boolean } = {}): ElecCheckPanelHandle {
  moduleEnabled = options.enabled !== false;
  ensurePanelStyles();
  entryButton = buildEntryButton('elecCheckEntryButton', '电气校验', CHECK_ICON, () => {
    if (moduleEnabled) drawer?.open();
  });
  if (!entryButton) return { setEnabled };

  drawer = createDrawer('elecCheckDrawer', '电气校验', '线号合规 · 功率统计 · 导线截面与断路器配合');
  drawer.body.innerHTML = `
    <div class="acp-status" id="elecCheckStatus">尚未运行校验</div>
    <div class="acp-check-grid" id="elecCheckSummary"></div>
    <div id="elecCheckTable"><div class="acp-empty">点击「运行校验」按当前电气数据生成问题清单。</div></div>
    <div class="acp-note">校验范围：线号缺失/格式/同网重复/跨网络重号/相线电位不符/数字跳号；按铭牌功率统计 kW·kVA、分相电流、需要系数、三相不平衡度、主断路器与进线截面；导线截面与载流量、断路器配合。结果可导出 A3 横向 PDF 报告。</div>`;
  drawer.footer.innerHTML = `
    <button type="button" class="acp-btn acp-btn-primary" id="elecCheckRun">运行校验</button>
    <button type="button" class="acp-btn" id="elecCheckPdf" disabled>导出 PDF</button>
    <span class="acp-pill acp-row-end">纯本地计算</span>`;

  const status = drawer.body.querySelector<HTMLElement>('#elecCheckStatus');
  const summary = drawer.body.querySelector<HTMLElement>('#elecCheckSummary');
  const table = drawer.body.querySelector<HTMLElement>('#elecCheckTable');
  const run = drawer.footer.querySelector<HTMLButtonElement>('#elecCheckRun');
  const pdf = drawer.footer.querySelector<HTMLButtonElement>('#elecCheckPdf');
  if (!status || !summary || !table || !run || !pdf) throw new Error('电气校验面板节点缺失');
  nodes = { status, summary, table, run, pdf };

  run.addEventListener('click', () => {
    run.disabled = true;
    void runWith(docFromSource()).finally(() => {
      run.disabled = false;
    });
  });
  pdf.addEventListener('click', () => {
    pdf.disabled = true;
    void exportPdf()
      .then((saved) => notify(`电气校验报告已保存：${saved.path}`))
      .catch((error: unknown) => notify(`导出失败：${errorMessage(error)}`, true))
      .finally(() => {
        pdf.disabled = lastResult === null;
      });
  });

  window.__ElecCheckPanel = {
    open: () => { if (moduleEnabled) drawer?.open(); },
    close: () => drawer?.close(),
    run: async (doc: ElecDocument) => moduleEnabled
      ? await runWith(doc)
      : moduleDisabledResult('elec.validation'),
    result: () => lastResult,
    html: () => lastHtml,
    exportPdf,
    status: () => status.textContent ?? ''
  };
  setEnabled(moduleEnabled);
  return { setEnabled };

  function setEnabled(enabled: boolean): void {
    moduleEnabled = enabled === true;
    if (entryButton) {
      entryButton.hidden = !moduleEnabled;
      entryButton.disabled = !moduleEnabled;
      entryButton.setAttribute('aria-disabled', String(!moduleEnabled));
    }
    if (nodes) {
      nodes.run.disabled = !moduleEnabled;
      nodes.pdf.disabled = !moduleEnabled || lastResult === null;
    }
    if (!moduleEnabled) drawer?.close();
  }
}
