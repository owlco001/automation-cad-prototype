/**
 * 机台成本估算面板：价格簿 → BOM → 引擎 → 明细表 / 缺价 / 合计 → 导出 PDF / CSV。
 *
 * 数据来源：
 * - 价格簿：导入的 JSON 文件（首选）→ 注入的 `__CostPricebookProvider` → 主进程内置价格簿（packs/builtin/pricebook-cn）。
 *   内置价格簿里的条目全部带「示例」标记，引擎会排除，所以面板会明确提示需要替换为正式价目表，不伪造价格。
 * - BOM：导入的 JSON（`{bom, placements, plate, plc, options, wireSection}` 或纯数组）→ 注入的 `__CostBomProvider`。
 *
 * `window.__CostPanel` 供冒烟与后续 Agent 工具命令式调用。
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
import { computeCost, type CostBomRow, type CostInput, type CostReport } from './engine.ts';
import { isUsablePricebookItem, validatePricebook, type Pricebook } from './pricebook.ts';
import { costReportCsv, describeCost, money, renderCostReportHtml } from './report.ts';
import { bomSignatureFromRows } from '../agent/advisor.ts';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { assertBomRowCount } from '../shared/input-limits.ts';
import {
  CostEstimationModuleDisabledError,
  costEstimationDisabledResult
} from '../modules/cost-estimation-gate.ts';

const COST_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 13.5V2.5h8.2l2.8 2.8v8.2z"/><path d="M4.8 6.4h4.4M4.8 9h4.4M4.8 11.4h2.8"/><path d="M10.7 2.7v2.8h2.8"/></svg>';
const NO_PRICEBOOK_HINT = '尚未加载价格簿：请导入正式价目表 JSON，或确认桌面版内置价格簿可用';

interface PanelNodes {
  status: HTMLElement;
  source: HTMLElement;
  summary: HTMLElement;
  table: HTMLElement;
  issues: HTMLElement;
  run: HTMLButtonElement;
  loadBom: HTMLButtonElement;
  loadBook: HTMLButtonElement;
  pdf: HTMLButtonElement;
  csv: HTMLButtonElement;
}

interface BookState {
  book: Pricebook;
  label: string;
  usable: number;
  examples: number;
}

export interface CostPanelHandle {
  setEnabled(enabled: boolean): void;
}

let drawer: DrawerHandle | null = null;
let nodes: PanelNodes | null = null;
let lastReport: CostReport | null = null;
let lastHtml = '';
let lastBomSignature = '';
let lastComputedAt = '';
let bookState: BookState | null = null;
let pendingBom: Partial<CostInput> | null = null;
let bomLabel = '未载入 BOM';
let costEstimationEnabled = true;

function assertCostEstimationEnabled(): void {
  if (!costEstimationEnabled) throw new CostEstimationModuleDisabledError();
}

function projectInfo(): { name: string; code: string; author: string; currency: string } {
  return {
    name: bomLabel === '未载入 BOM' ? '机台成本估算' : bomLabel,
    code: 'COST-EST',
    author: 'AutomationCAD',
    currency: bookState?.book.currency ?? 'CNY'
  };
}

function countItems(book: Pricebook): { usable: number; examples: number } {
  let usable = 0;
  let examples = 0;
  for (const item of Object.values(book.items)) {
    if (isUsablePricebookItem(item)) usable += 1;
    else examples += 1;
  }
  return { usable, examples };
}

function setBook(book: Pricebook, label: string): BookState {
  assertCostEstimationEnabled();
  const counts = countItems(book);
  bookState = { book, label, ...counts };
  return bookState;
}

function bookSummary(): string {
  if (!bookState) return '价格簿：未加载';
  const parts = [`价格簿：${bookState.label}`, `可用 ${bookState.usable} 条`];
  if (bookState.examples > 0) parts.push(`示例 ${bookState.examples} 条（不计价）`);
  parts.push(`更新 ${bookState.book.updatedAt.slice(0, 10)}`);
  return parts.join(' · ');
}

function renderBookSource(): void {
  if (!nodes) return;
  nodes.source.textContent = bookSummary();
  nodes.source.classList.toggle('is-warn', Boolean(bookState && bookState.usable === 0));
}

async function ensureBook(): Promise<BookState> {
  assertCostEstimationEnabled();
  if (bookState) return bookState;
  const provider = window.__CostPricebookProvider;
  if (typeof provider === 'function') {
    const injected = provider();
    if (injected) return setBook(validatePricebook(injected), '注入价格簿');
  }
  const api = window.desktop?.cost;
  if (!api) throw new Error('未加载价格簿：请导入正式价目表 JSON');
  const result = await api.pricebook();
  assertCostEstimationEnabled();
  if (result.code === 'MODULE_DISABLED') throw new CostEstimationModuleDisabledError();
  if (!result.ok || !result.book) {
    throw new Error(`内置价格簿不可用：${result.message ?? '未知原因'}`);
  }
  return setBook(validatePricebook(result.book), '内置价格簿');
}

function summaryCards(report: CostReport): string {
  const { totals, lines, missing } = report;
  const cards: Array<{ label: string; value: string; tone?: string }> = [
    { label: '硬件', value: money(totals.hardware) },
    { label: '辅材', value: money(totals.extras) },
    { label: '人工', value: money(totals.labor) },
    { label: '小计', value: money(totals.subtotal) },
    { label: '加成', value: money(totals.markup) },
    { label: '税金', value: money(totals.tax) },
    { label: '运费', value: money(totals.freight) },
    { label: '合计', value: money(totals.grand), tone: 'ok' },
    { label: '缺价', value: `${missing.length} / ${lines.length + missing.length}`, ...(missing.length > 0 ? { tone: 'warn' } : { tone: 'ok' }) }
  ];
  return cards.map((card) => `<div class="acp-check-card${card.tone ? ` is-${card.tone}` : ''}">
      <span>${escapeHtml(card.label)}</span><b>${escapeHtml(card.value)}</b>
    </div>`).join('');
}

function lineRows(report: CostReport): string {
  if (report.lines.length === 0) {
    return '<div class="acp-empty">没有可计价的物料行：请先导入 BOM，或检查价格簿物料号是否与 BOM 一致。</div>';
  }
  const rows = report.lines.map((line, index) => `<tr>
      <td class="acp-check-num">${index + 1}</td>
      <td class="acp-mono">${escapeHtml(line.partId)}</td>
      <td>${escapeHtml(line.model)}</td>
      <td>${escapeHtml(line.category)}</td>
      <td class="acp-num">${line.qty}</td>
      <td class="acp-num">${money(line.unit)}</td>
      <td class="acp-num">${money(line.subtotal)}</td>
      <td class="acp-muted">${escapeHtml(line.priceSource)} · ${line.priceAgeDays} 天</td>
    </tr>`).join('');
  return `<table class="acp-check-table">
      <thead><tr><th style="width:26px">#</th><th>物料号</th><th>型号</th><th>分类</th>
        <th style="width:44px">数量</th><th style="width:72px">单价</th><th style="width:80px">小计</th><th style="width:130px">价格来源</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function issueBlocks(report: CostReport): string {
  const missing = report.missing.length === 0
    ? '<div class="acp-empty">全部物料均有价格。</div>'
    : `<ul class="acp-cost-issues">${report.missing.map((item) => `<li>
        <span class="acp-pill is-warn">${item.reason === 'NO_PRICE' ? '缺价' : '缺物料号'}</span>
        ${escapeHtml(item.name)}${item.spec ? `（${escapeHtml(item.spec)}）` : ''} × ${item.qty}
      </li>`).join('')}</ul>`;
  const warnings = report.warnings.length === 0
    ? ''
    : `<ul class="acp-cost-issues acp-cost-warn">${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  return `<div class="acp-cost-block"><h4>缺价 ${report.missing.length} 项</h4>${missing}</div>
    ${warnings ? `<div class="acp-cost-block"><h4>告警 ${report.warnings.length} 条</h4>${warnings}</div>` : ''}`;
}

function render(report: CostReport): void {
  assertCostEstimationEnabled();
  lastReport = report;
  lastHtml = renderCostReportHtml(projectInfo(), report);
  if (!nodes) return;
  const currency = bookState?.book.currency ?? 'CNY';
  nodes.status.textContent = describeCost(report, currency);
  nodes.status.classList.add('is-on');
  nodes.status.classList.toggle('is-error', report.missing.length > 0);
  nodes.summary.innerHTML = summaryCards(report);
  nodes.table.innerHTML = lineRows(report);
  nodes.issues.innerHTML = issueBlocks(report);
  nodes.pdf.disabled = report.lines.length === 0;
  nodes.csv.disabled = report.lines.length === 0;
}

function readOptions(): CostInput['options'] {
  const markup = Number(document.getElementById('costMarkup')?.getAttribute('data-value') ?? '8');
  const tax = Number(document.getElementById('costTax')?.getAttribute('data-value') ?? '13');
  const freight = Number(document.getElementById('costFreight')?.getAttribute('data-value') ?? '0');
  return {
    markupRate: Number.isFinite(markup) ? markup / 100 : 0.08,
    taxRate: Number.isFinite(tax) ? tax / 100 : 0.13,
    freight: Number.isFinite(freight) ? freight : 0
  };
}

function syncOptionValues(): void {
  for (const [id, digits] of [['costMarkup', 1], ['costTax', 1], ['costFreight', 2]] as const) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) continue;
    const raw = Number(input.value);
    input.dataset.value = Number.isFinite(raw) ? String(Number(raw.toFixed(digits))) : '0';
    input.classList.toggle('is-error', !Number.isFinite(raw) || raw < 0);
  }
}

function bomFromSource(input: Partial<CostInput> | null): CostBomRow[] | null {
  const explicit = input?.bom;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;
  const provider = window.__CostBomProvider;
  if (typeof provider === 'function') {
    const rows = provider();
    if (Array.isArray(rows) && rows.length > 0) return rows;
  }
  if (pendingBom?.bom && pendingBom.bom.length > 0) return pendingBom.bom;
  return null;
}

async function runWith(input: Partial<CostInput> | null): Promise<CostReport | { ok: false; code: 'MODULE_DISABLED'; message: string } | null> {
  if (!costEstimationEnabled) return costEstimationDisabledResult();
  try {
    const bom = bomFromSource(input);
    if (!bom) {
      notify('没有可计算的 BOM：请先导入 BOM JSON，或由上层注入 __CostBomProvider', true);
      return null;
    }
    assertBomRowCount(bom.length);
    const book = input?.pricebook ? setBook(validatePricebook(input.pricebook), '本次指定价格簿') : await ensureBook();
    if (!costEstimationEnabled) return costEstimationDisabledResult();
    renderBookSource();
    const merged: CostInput = {
      bom,
      pricebook: book.book,
      options: { ...readOptions(), ...(input?.options ?? {}) },
      now: new Date()
    };
    const placements = input?.placements ?? pendingBom?.placements;
    if (placements) merged.placements = placements;
    const plate = input?.plate ?? pendingBom?.plate;
    if (plate) merged.plate = plate;
    const plc = input?.plc ?? pendingBom?.plc;
    if (plc) merged.plc = plc;
    const overrides = input?.overrides ?? pendingBom?.overrides;
    if (overrides) merged.overrides = overrides;
    const wireSection = input?.wireSection ?? pendingBom?.wireSection;
    if (wireSection) merged.wireSection = wireSection;
    const report = computeCost(merged);
    lastBomSignature = bomSignatureFromRows(merged.bom);
    lastComputedAt = new Date().toISOString();
    render(report);
    if (book.usable === 0) {
      notify('价格簿内没有可用条目（示例条目不计价），合计将只包含人工与辅材', true);
    } else {
      notify(report.missing.length > 0
        ? `成本已计算：合计 ${money(report.totals.grand)} · ${report.missing.length} 项缺价`
        : `成本已计算：合计 ${money(report.totals.grand)}`, report.missing.length > 0);
    }
    return report;
  } catch (error) {
    if (error instanceof CostEstimationModuleDisabledError) return costEstimationDisabledResult();
    recordDiagnosticError('COST_COMPUTE_FAILED', error, { site: 'desktop/src/cost/ui.ts' });
    notify(`成本计算失败：${errorMessage(error)}。请检查 BOM 行与价格簿后重试。`, true);
    return null;
  }
}

function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);
    let settled = false;
    const done = (value: { name: string; text: string } | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => done({ name: file.name, text: String(reader.result ?? '') });
      reader.onerror = () => {
        notify(`读取文件失败：${file.name}`, true);
        done(null);
      };
      reader.readAsText(file, 'utf-8');
    });
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

async function importPricebook(): Promise<BookState | null> {
  if (!costEstimationEnabled) return null;
  const picked = await pickTextFile('.json,application/json');
  if (!picked || !costEstimationEnabled) return null;
  try {
    const book = validatePricebook(JSON.parse(picked.text) as unknown);
    const state = setBook(book, picked.name);
    renderBookSource();
    notify(`价格簿已载入：${picked.name} · 可用 ${state.usable} 条`);
    if (lastReport) await runWith(null);
    return state;
  } catch (error) {
    recordDiagnosticError('COST_PRICEBOOK_IMPORT_FAILED', error, { site: 'desktop/src/cost/ui.ts', file: picked.name });
    notify(`价格簿导入失败：${errorMessage(error)}。请确认文件是 UTF-8 JSON 且字段完整。`, true);
    return null;
  }
}

function parseBomPayload(text: string): Partial<CostInput> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`BOM 不是合法 JSON：${detail}`);
  }
  if (Array.isArray(value)) {
    assertBomRowCount(value.length);
    return { bom: value as CostBomRow[] };
  }
  if (typeof value !== 'object' || value === null) throw new Error('BOM 必须是数组或含 bom 字段的对象');
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.bom)) throw new Error('BOM 对象必须含 bom 数组');
  assertBomRowCount(source.bom.length);
  const payload: Partial<CostInput> = { bom: source.bom as CostBomRow[] };
  if (Array.isArray(source.placements)) payload.placements = source.placements as NonNullable<CostInput['placements']>;
  if (typeof source.plate === 'object' && source.plate !== null) payload.plate = source.plate as NonNullable<CostInput['plate']>;
  if (typeof source.plc === 'object' && source.plc !== null) payload.plc = source.plc as NonNullable<CostInput['plc']>;
  if (typeof source.options === 'object' && source.options !== null) payload.options = source.options as NonNullable<CostInput['options']>;
  if (typeof source.overrides === 'object' && source.overrides !== null) payload.overrides = source.overrides as NonNullable<CostInput['overrides']>;
  if (typeof source.wireSection === 'string') payload.wireSection = source.wireSection;
  return payload;
}

async function importBom(): Promise<CostReport | { ok: false; code: 'MODULE_DISABLED'; message: string } | null> {
  if (!costEstimationEnabled) return null;
  const picked = await pickTextFile('.json,application/json');
  if (!picked || !costEstimationEnabled) return null;
  try {
    pendingBom = parseBomPayload(picked.text);
    bomLabel = picked.name;
    notify(`BOM 已载入：${picked.name} · ${pendingBom.bom?.length ?? 0} 行`);
    return await runWith(pendingBom);
  } catch (error) {
    recordDiagnosticError('COST_BOM_IMPORT_FAILED', error, { site: 'desktop/src/cost/ui.ts', file: picked.name });
    notify(`BOM 导入失败：${errorMessage(error)}。请确认文件是 UTF-8 JSON 且包含 bom 数组。`, true);
    return null;
  }
}

async function exportPdf(): Promise<{ ok: boolean; path?: string; htmlPath?: string; code?: string; message?: string }> {
  if (!costEstimationEnabled) return costEstimationDisabledResult();
  if (!lastReport) throw new Error('请先计算成本再导出 PDF');
  if (!window.desktop?.cost) throw new Error('导出 PDF 仅在桌面版可用');
  const html = lastHtml || renderCostReportHtml(projectInfo(), lastReport);
  return await window.desktop.cost.exportPanelPdf({
    html,
    projectName: projectInfo().name,
    page: { size: 'A4', landscape: false }
  });
}

async function exportCsv(): Promise<{ ok?: boolean; canceled?: boolean; path?: string | null; code?: string; message?: string }> {
  if (!costEstimationEnabled) return costEstimationDisabledResult();
  if (!lastReport) throw new Error('请先计算成本再导出 CSV');
  if (!window.desktop?.cost) throw new Error('导出 CSV 仅在桌面版可用');
  const csv = costReportCsv(lastReport);
  const base = projectInfo().name.replace(/\.[^.]+$/, '') || '成本估算';
  return await window.desktop.cost.exportPanelCsv({ name: `${base}-成本.csv`, data: csv });
}

export function initCostPanel(options: { enabled?: boolean } = {}): CostPanelHandle {
  costEstimationEnabled = options.enabled ?? true;
  ensurePanelStyles();
  const entry = buildEntryButton('costEntryButton', '成本估算', COST_ICON, () => {
    if (!costEstimationEnabled) return;
    drawer?.open();
    void ensureBook().then(renderBookSource).catch((error: unknown) => {
      notify(errorMessage(error), true);
      renderBookSource();
    });
  });
  if (!entry) return { setEnabled: (enabled) => { costEstimationEnabled = enabled; } };
  entry.hidden = !costEstimationEnabled;

  drawer = createDrawer('costDrawer', '机台成本估算', '价格簿 · BOM · 人工辅材 · 加成税金');
  drawer.body.innerHTML = `
    <div class="acp-status" id="costStatus">尚未计算成本</div>
    <div class="acp-cost-source" id="costSource">价格簿：未加载</div>
    <div class="acp-cost-params">
      <label>加成率 %<input type="number" id="costMarkup" value="8" min="0" step="0.5" data-value="8"></label>
      <label>税率 %<input type="number" id="costTax" value="13" min="0" step="0.5" data-value="13"></label>
      <label>运费<input type="number" id="costFreight" value="0" min="0" step="1" data-value="0"></label>
      <label>线缆截面 mm²<input type="number" id="costWireSection" value="2.5" min="0.5" step="0.5"></label>
    </div>
    <div class="acp-check-grid" id="costSummary"></div>
    <div id="costTable"><div class="acp-empty">导入 BOM 或由上层注入数据后点击「计算成本」。</div></div>
    <div id="costIssues"></div>
    <div class="acp-note">计算口径：硬件按价格簿阶梯价（示例条目不计价），辅材按底板尺寸与布置估算导轨/线槽/线缆，人工按接线点数与装配工时计取；加成只作用于小计，税按小计 + 加成计取。结果用于设计阶段估算，不构成正式报价。</div>`;
  drawer.footer.innerHTML = `
    <button type="button" class="acp-btn acp-btn-primary" id="costRun">计算成本</button>
    <button type="button" class="acp-btn" id="costLoadBom">导入 BOM</button>
    <button type="button" class="acp-btn" id="costLoadBook">导入价格簿</button>
    <button type="button" class="acp-btn" id="costPdf" disabled>导出 PDF</button>
    <button type="button" class="acp-btn" id="costCsv" disabled>导出 CSV</button>
    <span class="acp-pill acp-row-end">纯本地计算</span>`;

  const required = <T extends HTMLElement>(id: string): T => {
    const element = drawer?.body.querySelector<T>(`#${id}`) ?? drawer?.footer.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`成本面板节点缺失：${id}`);
    return element;
  };
  const status = required<HTMLElement>('costStatus');
  const source = required<HTMLElement>('costSource');
  const summary = required<HTMLElement>('costSummary');
  const table = required<HTMLElement>('costTable');
  const issues = required<HTMLElement>('costIssues');
  const run = required<HTMLButtonElement>('costRun');
  const loadBom = required<HTMLButtonElement>('costLoadBom');
  const loadBook = required<HTMLButtonElement>('costLoadBook');
  const pdf = required<HTMLButtonElement>('costPdf');
  const csv = required<HTMLButtonElement>('costCsv');
  nodes = { status, source, summary, table, issues, run, loadBom, loadBook, pdf, csv };

  const setEnabled = (enabled: boolean): void => {
    costEstimationEnabled = enabled === true;
    entry.hidden = !costEstimationEnabled;
    if (!costEstimationEnabled) drawer?.close();
    run.disabled = !costEstimationEnabled;
    loadBom.disabled = !costEstimationEnabled;
    loadBook.disabled = !costEstimationEnabled;
    pdf.disabled = !costEstimationEnabled || !lastReport || lastReport.lines.length === 0;
    csv.disabled = !costEstimationEnabled || !lastReport || lastReport.lines.length === 0;
  };
  setEnabled(costEstimationEnabled);

  for (const id of ['costMarkup', 'costTax', 'costFreight']) {
    document.getElementById(id)?.addEventListener('change', syncOptionValues);
  }

  const withBusy = (button: HTMLButtonElement, task: () => Promise<void>): void => {
    if (!costEstimationEnabled) return;
    button.disabled = true;
    void task().finally(() => {
      setEnabled(costEstimationEnabled);
    });
  };

  run.addEventListener('click', () => withBusy(run, async () => {
    if (!costEstimationEnabled) return;
    syncOptionValues();
    const wireSection = (document.getElementById('costWireSection') as HTMLInputElement | null)?.value.trim();
    await runWith({ ...(wireSection ? { wireSection } : {}) });
  }));
  loadBom.addEventListener('click', () => withBusy(loadBom, async () => {
    await importBom();
  }));
  loadBook.addEventListener('click', () => withBusy(loadBook, async () => {
    await importPricebook();
  }));
  pdf.addEventListener('click', () => withBusy(pdf, async () => {
    try {
      const saved = await exportPdf();
      if (!saved.ok) throw new CostEstimationModuleDisabledError();
      notify(`成本报告已保存：${saved.path}`);
    } catch (error) {
      notify(`导出失败：${errorMessage(error)}`, true);
    }
  }));
  csv.addEventListener('click', () => withBusy(csv, async () => {
    try {
      const saved = await exportCsv();
      if (saved.ok === false) throw new CostEstimationModuleDisabledError();
      notify(saved.canceled ? '导出已取消' : `成本明细已保存：${saved.path}`);
    } catch (error) {
      notify(`导出失败：${errorMessage(error)}`, true);
    }
  }));

  window.__CostPanel = {
    open: () => {
      if (!costEstimationEnabled) return costEstimationDisabledResult();
      drawer?.open();
    },
    close: () => drawer?.close(),
    setPricebook: (value: unknown) => {
      assertCostEstimationEnabled();
      const state = setBook(validatePricebook(value), '脚本指定价格簿');
      renderBookSource();
      return { usable: state.usable, examples: state.examples };
    },
    loadPricebookText: (text: string, label = '文本价格簿') => {
      assertCostEstimationEnabled();
      const state = setBook(validatePricebook(JSON.parse(text) as unknown), label);
      renderBookSource();
      return { usable: state.usable, examples: state.examples };
    },
    setBom: (payload: Partial<CostInput>, label = '脚本指定 BOM') => {
      assertCostEstimationEnabled();
      if (payload.bom) assertBomRowCount(payload.bom.length);
      pendingBom = payload;
      bomLabel = label;
      return { rows: payload.bom?.length ?? 0 };
    },
    run: async (input: Partial<CostInput>) => await runWith(input),
    result: () => costEstimationEnabled ? lastReport : costEstimationDisabledResult(),
    state: () => costEstimationEnabled
      ? { hasReport: Boolean(lastReport), computedAt: lastComputedAt, bomSignature: lastBomSignature }
      : costEstimationDisabledResult(),
    html: () => costEstimationEnabled ? lastHtml : costEstimationDisabledResult(),
    csv: () => costEstimationEnabled ? (lastReport ? costReportCsv(lastReport) : '') : costEstimationDisabledResult(),
    exportPdf,
    exportCsv,
    status: () => costEstimationEnabled ? status.textContent ?? '' : costEstimationDisabledResult(),
    pricebook: () => costEstimationEnabled
      ? (bookState ? { label: bookState.label, usable: bookState.usable, examples: bookState.examples } : null)
      : costEstimationDisabledResult()
  };
  return { setEnabled };
}
