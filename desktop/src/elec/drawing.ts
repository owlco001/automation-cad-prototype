/**
 * 多页电气图纸：ElecDesign → 电路 → ERC → 分页版面 → 线号 → 交叉引用 → 自检 → SVG（每页一张 A3）。
 *
 * 这是 extension / Agent 的唯一出图入口（renderElecDrawing）。图号、页码、页标题都由数据与分页给出；
 * 每页独立做导线/文字/符号自检，再做全局一致性（引脚只画一次、线号唯一、明细表与图面一致、交叉引用闭合），
 * 任何一项不过 → deliverable=false，标题栏写“有待处理问题”，图上打问题框。
 */

import { buildElec, type ElecBuild } from './build.ts';
import { PageCanvas, PAGE_H, PAGE_W, FRAME, CONTENT, GRID_COLS, GRID_ROWS, columnOf, resolveLabels } from './canvas.ts';
import { checkWireNumbers, type CircuitCheck, type ElecDocument, type Load, type Wire as CheckWire } from './check.ts';
import type { Circuit, CircuitDevice, ErcIssue } from './circuit.ts';
import { ercSummary, PIN, runErc } from './circuit.ts';
import type { ElecDesign } from './design.ts';
import { boxesOverlap, checkTexts, checkWiring, fitText, junctionPoints, P, textWidth, type Prim, type Pt, type TextPrim } from './geometry.ts';
import { breakerNameMismatch } from './machine-circuit.ts';
import { assignWireNoScheme, BUS_CATEGORIES, classifyNets, DEFAULT_WIRE_NO_SCHEME, describeScheme, type NetPlacement, type WireNoAdjustment, type WireNoCategory, type WireNoScheme } from './wireno.ts';
import { layoutControlPages, layoutInputPages, layoutOutputPages, layoutPowerPages, makeContext, type LayoutContext } from './pages.ts';

export interface WireRow {
  no: string;
  net: string;
  from: string;
  to: string;
  section: string;
  color: string;
  /** 起点所在“页.列” */
  ref: string;
}

export interface TerminalRow {
  strip: string;
  no: number;
  wireNo: string;
  inside: string;
  outside: string;
  purpose: string;
  ref: string;
  pe: boolean;
}

export interface DrawingBomRow {
  tag: string;
  name: string;
  model: string;
  spec: string;
  qty: number;
  ref: string;
}

export interface DrawingPage {
  index: number;
  kind: PageCanvas['kind'];
  title: string;
  svg: string;
  prims: Prim[];
  problems: string[];
}

export interface ElecDrawing {
  project: string;
  drawingNo: string;
  pages: DrawingPage[];
  /** ERC + 设计层问题 */
  issues: ErcIssue[];
  /** 图面/一致性自检问题（带页码前缀） */
  problems: string[];
  deliverable: boolean;
  /** 网络 id → 线号 */
  wireNumbers: Record<string, string>;
  /** 网络 id → 线号类别 */
  wireCategories: Record<string, WireNoCategory>;
  /** 本图使用的线号方案 */
  wireScheme: WireNoScheme;
  /** 模板产生重号、被自动加了区分后缀的网络（同时以 WIRENO_SUFFIXED 警告报告） */
  wireNoAdjusted: WireNoAdjustment[];
  wireList: WireRow[];
  terminals: TerminalRow[];
  bom: DrawingBomRow[];
  /** 电气校验面板/Agent run_electrical_check 用的数据（线号按网络、负载按电机） */
  document: ElecDocument;
  build: ElecBuild;
  /** 版面画布（符号、导线、电位断点）：测试做几何/拓扑断言、或篡改后复检用 */
  canvases: PageCanvas[];
}

export const STATUS = { ok: '校验通过', fail: '有待处理问题' } as const;

/* ------------------------------------------------------------------ 线号 */

/** 图框行号 A–F */
export function rowOf(y: number): string {
  const i = Math.min(GRID_ROWS.length - 1, Math.max(0, Math.floor((y - FRAME.y) / (FRAME.h / GRID_ROWS.length))));
  return GRID_ROWS[i] as string;
}

/** 网络首次出现位置，按“页 → 列（x）→ 行（y）”阅读顺序；没画出来的网络不在里面 */
export function netReadingOrder(pages: readonly PageCanvas[], circuit: Circuit): NetPlacement[] {
  const known = new Set(circuit.nets.map((net) => net.id));
  const seen = new Set<string>();
  const out: NetPlacement[] = [];
  for (const page of pages) {
    const order = page.wires
      .map((wire) => ({ net: wire.net, x: Math.min(...wire.points.map((p) => p[0])), y: Math.min(...wire.points.map((p) => p[1])) }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    for (const item of order) {
      if (seen.has(item.net) || !known.has(item.net)) continue;
      seen.add(item.net);
      out.push({ net: item.net, page: page.index, col: columnOf(item.x), row: rowOf(item.y) });
    }
  }
  return out;
}

/**
 * 线号分配（规则见 wireno.ts 的线号方案；check.ts 按同一方案校验）：
 *  - 缺省方案“数字连续”：L1/L2/L3/N/PE、24V、0V 固定，其余网络 101 起按“页 → 列 → 行”阅读顺序连续编号；
 *  - 同一网络（含经端子进出柜的两侧）同一线号；不同网络若模板产生重号，后出现的自动加区分后缀并报告。
 */
export function assignWireNumbers(pages: readonly PageCanvas[], build: Pick<ElecBuild, 'circuit' | 'plan'>, scheme: WireNoScheme = DEFAULT_WIRE_NO_SCHEME): ReturnType<typeof assignWireNoScheme> {
  return assignWireNoScheme(build.circuit, classifyNets(build.circuit, build.plan), netReadingOrder(pages, build.circuit), scheme);
}

/** 沿导线找线号位置：竖线写在右/左侧，横线写在上/下方，优先线段中部 */
function wireNoCandidates(points: readonly Pt[], value: string, net: string): TextPrim[][] {
  const size = 2.2;
  const w = textWidth(value, size);
  const out: Array<{ d: number; t: TextPrim }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] as Pt;
    const b = points[i + 1] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (Math.abs(a[0] - b[0]) < 1e-6) {
      const y1 = Math.min(a[1], b[1]);
      const y2 = Math.max(a[1], b[1]);
      const mid = (y1 + y2) / 2;
      if (y2 - y1 < size + 1.6) {
        // 短线：线号以线段中点为中心，允许探出线段（仍须不压任何笔画）
        if (y2 - y1 < 1.5) continue;
        out.push({ d: 5, t: P.text(a[0] + 0.8, mid + size * 0.35, value, size, 'start', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
        out.push({ d: 5.5, t: P.text(a[0] - 0.8, mid + size * 0.35, value, size, 'end', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
        continue;
      }
      for (let y = y1 + size + 0.6; y <= y2 - 0.6; y += 1.2) {
        const d = Math.abs(y - size * 0.3 - mid);
        out.push({ d, t: P.text(a[0] + 0.8, y, value, size, 'start', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
        out.push({ d: d + 0.5, t: P.text(a[0] - 0.8, y, value, size, 'end', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
      }
    } else if (Math.abs(a[1] - b[1]) < 1e-6) {
      const x1 = Math.min(a[0], b[0]);
      const x2 = Math.max(a[0], b[0]);
      if (x2 - x1 < w + 2) continue;
      const mid = (x1 + x2) / 2;
      for (let x = x1 + w / 2 + 1; x <= x2 - w / 2 - 1; x += 1.5) {
        const d = Math.abs(x - mid);
        out.push({ d, t: P.text(x, a[1] - 0.8, value, size, 'middle', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
        out.push({ d: d + 0.5, t: P.text(x, a[1] + 2.6, value, size, 'middle', 'it-s wn', 'text', { owner: net, role: 'wire-no' }) });
      }
    }
    void len;
  }
  const flat = out.sort((p, q) => p.d - q.d).slice(0, 60).map((item) => [item.t]);
  // 兜底：水平写放不下的长线号（如 1.3.4、2L2），沿竖线竖写（自下而上），排在所有水平候选之后
  const rotated: Array<{ d: number; t: TextPrim }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] as Pt;
    const b = points[i + 1] as Pt;
    if (Math.abs(a[0] - b[0]) > 1e-6) continue;
    const y1 = Math.min(a[1], b[1]);
    const y2 = Math.max(a[1], b[1]);
    const mid = (y1 + y2) / 2;
    const ys = y2 - y1 >= w + 1.2 ? Array.from({ length: Math.floor((y2 - y1 - w - 1.2) / 1.2) + 1 }, (_, k) => y1 + 0.6 + w / 2 + k * 1.2) : [mid];
    for (const y of ys) {
      const d = Math.abs(y - mid);
      const right = { ...P.text(a[0] + 0.5 + 0.8 * size, y, value, size, 'middle', 'it-s wn', 'text', { owner: net, role: 'wire-no' }), rot: 90 as const };
      const left = { ...P.text(a[0] - 0.5 - 0.22 * size, y, value, size, 'middle', 'it-s wn', 'text', { owner: net, role: 'wire-no' }), rot: 90 as const };
      rotated.push({ d, t: right }, { d: d + 0.5, t: left });
    }
  }
  return [...flat, ...rotated.sort((p, q) => p.d - q.d).slice(0, 40).map((item) => [item.t])];
}

/* ------------------------------------------------------------------ 图框 */

function frameprims(page: PageCanvas, project: string, drawingNo: string, total: number): Prim[] {
  const out: Prim[] = [];
  out.push(P.rect(6, 6, PAGE_W - 12, PAGE_H - 12, 'frame'));
  out.push(P.rect(FRAME.x, FRAME.y, FRAME.w, FRAME.h, 'frame'));
  // 列号 1…8（上下边带），行号 A…F（左右边带）
  const colW = FRAME.w / GRID_COLS;
  for (let i = 0; i < GRID_COLS; i += 1) {
    const x = FRAME.x + colW * i;
    if (i > 0) {
      out.push(P.line(x, 6, x, FRAME.y, 'frame', 'ic ic-t'));
      out.push(P.line(x, FRAME.y + FRAME.h, x, PAGE_H - 6, 'frame', 'ic ic-t'));
    }
    out.push(P.text(x + colW / 2, 9.1, String(i + 1), 2.4, 'middle', 'it-s', 'frame', { role: 'grid' }));
    out.push(P.text(x + colW / 2, PAGE_H - 7.1, String(i + 1), 2.4, 'middle', 'it-s', 'frame', { role: 'grid' }));
  }
  const rowH = FRAME.h / GRID_ROWS.length;
  GRID_ROWS.forEach((row, i) => {
    const y = FRAME.y + rowH * i;
    if (i > 0) {
      out.push(P.line(6, y, FRAME.x, y, 'frame', 'ic ic-t'));
      out.push(P.line(FRAME.x + FRAME.w, y, PAGE_W - 6, y, 'frame', 'ic ic-t'));
    }
    out.push(P.text(8, y + rowH / 2 + 0.9, row, 2.4, 'middle', 'it-s', 'frame', { role: 'grid' }));
    out.push(P.text(PAGE_W - 8, y + rowH / 2 + 0.9, row, 2.4, 'middle', 'it-s', 'frame', { role: 'grid' }));
  });
  const right = `${drawingNo} · 第 ${page.index}/${total} 页`;
  const rightW = textWidth(right, 3);
  out.push(P.text(PAGE_W - 14, 19.6, right, 3, 'end', 'it-s', 'frame'));
  out.push(P.text(14, 20, fitText(`${project} · ${page.title}`, FRAME.w - 12 - rightW - 8, 4.6), 4.6, 'start', 'it-t', 'frame'));
  out.push(P.line(FRAME.x, 240, FRAME.x + FRAME.w, 240, 'frame', 'ic ic-t'));
  return out;
}

function titleBlock(project: string, drawingNo: string, page: PageCanvas, total: number, status: string, date: string, designer: string): Prim[] {
  const x = 288;
  const y = 242;
  const w = 122;
  const h = 45;
  const out: Prim[] = [];
  const L = (x1: number, y1: number, x2: number, y2: number, cls = 'ic ic-t'): void => {
    out.push(P.line(x1, y1, x2, y2, 'title', cls));
  };
  const label = (tx: number, ty: number, value: string): void => {
    out.push(P.text(tx, ty, value, 2.8, 'start', 'it-s', 'title'));
  };
  const value = (tx: number, ty: number, v: string, maxW: number, cls = 'it'): void => {
    out.push(P.text(tx, ty, fitText(v, maxW, 3.4), 3.4, 'start', cls, 'title'));
  };
  out.push(P.rect(x, y, w, h, 'title'));
  L(x, y + 12, x + w, y + 12, 'ic');
  L(x, y + 22, x + w, y + 22);
  L(x, y + 32, x + w, y + 32);
  L(x + 58, y + 12, x + 58, y + 22);
  L(x + 90, y + 12, x + 90, y + 22);
  L(x + 58, y + 22, x + 58, y + 32);
  L(x + 80, y + 32, x + 80, y + h);
  const noW = textWidth(drawingNo, 3.8);
  out.push(P.text(x + w - 3, y + 5.4, drawingNo, 3.8, 'end', 'it', 'title'));
  out.push(P.text(x + 3, y + 5.4, fitText(`${project} · 电气原理图`, w - noW - 9, 3.8), 3.8, 'start', 'it-b', 'title'));
  out.push(P.text(x + 3, y + 10, fitText(page.title, w - 6, 2.8), 2.8, 'start', 'it-s', 'title'));
  label(x + 3, y + 18.4, '图号');
  value(x + 13, y + 18.6, drawingNo, 43);
  label(x + 61, y + 18.4, '页');
  value(x + 67, y + 18.6, `${page.index} / ${total}`, 21);
  label(x + 93, y + 18.4, '幅面');
  value(x + 103, y + 18.6, 'A3', 17);
  label(x + 3, y + 28.4, '设计');
  value(x + 13, y + 28.6, designer, 43, 'it-t');
  label(x + 61, y + 28.4, '日期');
  value(x + 71, y + 28.6, date, 49);
  label(x + 3, y + 40, '状态');
  value(x + 13, y + 40.2, status, 64, 'it-t');
  label(x + 83, y + 37.6, '比例 1:1');
  label(x + 83, y + 42.4, '单位 mm');
  return out;
}

function notesBlock(lines: readonly string[]): Prim[] {
  const out: Prim[] = [];
  const shown = lines.slice(0, 10);
  out.push(P.text(14, 245, '说明', 2.9, 'start', 'it-t', 'text', { role: 'notes' }));
  shown.forEach((line, i) => {
    const col = i < 5 ? 0 : 1;
    const row = i % 5;
    const x = 14 + col * 136;
    out.push(P.text(x, 249.4 + row * 3.6, fitText(`${i + 1}. ${line}`, 132, 2.4), 2.4, 'start', 'it-s', 'text', { role: 'notes' }));
  });
  return out;
}

function issuePanel(lines: readonly string[]): Prim[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, 8);
  const x = 14;
  const w = 200;
  const h = 7 + shown.length * 4;
  const y = 236 - h;
  const out: Prim[] = [P.rect(x, y, w, h, 'frame', 'ic', { fill: '#fff' })];
  out.push(P.text(x + 2.5, y + 5, `出图前校验：${lines.length} 项待处理`, 3.4, 'start', 'it-t', 'frame'));
  shown.forEach((item, index) => {
    out.push(P.text(x + 2.5, y + 9.4 + index * 4, fitText(item, w - 5, 2.5), 2.5, 'start', 'it-s', 'frame'));
  });
  return out;
}

/* ------------------------------------------------------------------ 表格页 */

interface TableColumn<T> {
  title: string;
  w: number;
  get: (row: T) => string;
  align?: 'start' | 'end';
}

const TABLE_ROWS = 44;

function tablePages<T>(kind: PageCanvas['kind'], title: string, rows: readonly T[], columns: readonly TableColumn<T>[]): PageCanvas[] {
  const pages: PageCanvas[] = [];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += TABLE_ROWS) chunks.push(rows.slice(i, i + TABLE_ROWS));
  if (chunks.length === 0) chunks.push([]);
  chunks.forEach((chunk, pi) => {
    const page = new PageCanvas(kind, chunks.length > 1 ? `${title}（${pi + 1}/${chunks.length}）` : title);
    const x = 14;
    const y = 28;
    const hh = 5.6;
    const rh = 4.6;
    const size = 2.6;
    const w = columns.reduce((sum, col) => sum + col.w, 0);
    const h = hh + Math.max(1, chunk.length) * rh;
    page.statics.push(P.rect(x, y, w, h, 'table'));
    page.statics.push(P.line(x, y + hh, x + w, y + hh, 'table', 'ic ic-t'));
    let cx = x;
    columns.forEach((col, index) => {
      if (index > 0) page.statics.push(P.line(cx, y, cx, y + h, 'table', 'ic ic-t'));
      const tx = col.align === 'end' ? cx + col.w - 1.6 : cx + 1.6;
      page.statics.push(P.text(tx, y + hh - 1.5, col.title, 2.8, col.align ?? 'start', 'it-s', 'table'));
      chunk.forEach((row, r) => {
        const value = fitText(col.get(row), col.w - 3.2, size);
        page.statics.push(P.text(tx, y + hh + r * rh + rh / 2 + size * 0.36, value, size, col.align ?? 'start', 'it-s', 'table'));
      });
      cx += col.w;
    });
    chunk.forEach((_, r) => {
      if (r > 0) page.statics.push(P.line(x, y + hh + r * rh, x + w, y + hh + r * rh, 'table', 'ic ic-t'));
    });
    pages.push(page);
  });
  return pages;
}

/* ------------------------------------------------------------------ SVG */

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const n = (value: number): string => (Math.round(value * 100) / 100).toString();

function primSvg(p: Prim): string {
  switch (p.t) {
    case 'line':
      return `<line class="${p.cls}" x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}"/>`;
    case 'rect':
      return `<rect class="${p.cls}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${p.fill ? ` style="fill:${p.fill}"` : ''}/>`;
    case 'circle':
      return p.filled
        ? `<circle class="if" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"/>`
        : `<circle class="${p.cls}" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"/>`;
    case 'path':
      return `<path class="${p.cls}" d="${p.d}"/>`;
    case 'text':
      return `<text class="${p.cls}" x="${n(p.x)}" y="${n(p.y)}" text-anchor="${p.anchor}"${p.rot === 90 ? ` transform="rotate(-90 ${n(p.x)} ${n(p.y)})"` : ''} style="font-size:${n(p.size)}px">${esc(p.value)}</text>`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ 主流程 */

export interface DrawingOptions {
  date?: string;
  designer?: string;
  /** 线号方案；缺省“数字连续” */
  wireScheme?: WireNoScheme;
}

const tagOf = (pin: string): string => pin.slice(0, pin.lastIndexOf(':'));

export function renderElecDrawing(design: ElecDesign, options: DrawingOptions = {}): ElecDrawing {
  const build = buildElec(design);
  const { circuit, plan } = build;
  const issues: ErcIssue[] = [
    ...build.issues.map((issue) => ({ severity: issue.severity, code: issue.code, message: issue.message })),
    ...runErc(circuit)
  ];
  const ctx: LayoutContext = makeContext(build);
  layoutPowerPages(ctx);
  layoutControlPages(ctx);
  layoutInputPages(ctx);
  layoutOutputPages(ctx);
  const schematic = ctx.pages;
  schematic.forEach((page, i) => {
    page.index = i + 1;
  });
  const deviceByTag = new Map(circuit.devices.map((device) => [device.tag, device]));

  /* ---------- 线号 ---------- */
  const wireScheme = options.wireScheme ?? DEFAULT_WIRE_NO_SCHEME;
  const assignment = assignWireNumbers(schematic, build, wireScheme);
  const wireNumbers = assignment.numbers;
  const wireCategories = assignment.categories;
  const busNets = new Set(Object.entries(wireCategories).filter(([, category]) => BUS_CATEGORIES.has(category)).map(([net]) => net));
  if (assignment.adjusted.length > 0) {
    const sample = assignment.adjusted.slice(0, 6).map((item) => `${item.base}→${item.no}`).join('、');
    issues.push({
      severity: 'warning',
      code: 'WIRENO_SUFFIXED',
      message: `线号模板产生重号 ${assignment.adjusted.length} 处，已自动加区分后缀：${sample}${assignment.adjusted.length > 6 ? '…' : ''}`
    });
  }

  /* ---------- 引脚位置（全局） ---------- */
  const pinAt = new Map<string, { page: number; pt: Pt }>();
  const drawnTwice: string[] = [];
  for (const page of schematic) {
    for (const symbol of page.symbols) {
      for (const [pin, pt] of Object.entries(symbol.pins)) {
        const key = PIN(symbol.tag, pin);
        if (pinAt.has(key)) drawnTwice.push(key);
        else pinAt.set(key, { page: page.index, pt });
      }
    }
  }
  const refOfPin = (pin: string): string => {
    const at = pinAt.get(pin);
    return at ? `${at.page}.${columnOf(at.pt[0])}` : '?';
  };
  const netPages = new Map<string, Set<number>>();
  for (const page of schematic) {
    for (const wire of page.wires) {
      const set = netPages.get(wire.net) ?? new Set<number>();
      set.add(page.index);
      netPages.set(wire.net, set);
    }
  }

  /* ---------- 线号与交叉引用文字请求 ---------- */
  for (const page of schematic) {
    const seen = new Set<string>();
    for (const wire of page.wires) {
      const no = wireNumbers[wire.net];
      if (!no || busNets.has(wire.net)) continue;
      seen.add(wire.net);
      page.label({ candidates: wireNoCandidates(wire.points, no, wire.net), what: `线号 ${no}`, optional: true });
    }
    for (const stub of page.stubs) {
      if (stub.kind === 'supply') continue;
      const pagesOfNet = [...(netPages.get(stub.net) ?? [])].filter((index) => index !== page.index).sort((a, b) => a - b);
      const backward = stub.side === 'above' || stub.side === 'below' ? stub.at[0] < 20 : stub.side === 'left';
      const target = backward ? (pagesOfNet.filter((index) => index < page.index).pop() ?? pagesOfNet[0]) : (pagesOfNet.find((index) => index > page.index) ?? pagesOfNet[0]);
      if (target === undefined) {
        page.problems.push(`[XREF_DANGLING] 网络 ${wireNumbers[stub.net] ?? stub.net} 在本页留了出口，但别的页没有它`);
        continue;
      }
      const targetPage = schematic[target - 1] as PageCanvas;
      const back = targetPage.stubs.find((item) => item.net === stub.net && item.kind !== 'supply') ?? targetPage.stubs.find((item) => item.net === stub.net);
      const firstWire = targetPage.wires.find((item) => item.net === stub.net);
      const col = back ? columnOf(back.at[0]) : firstWire ? columnOf(firstWire.points[0]?.[0] ?? 0) : 1;
      const text = `${stub.prefix ? `${stub.prefix} ` : ''}${backward ? '←' : '→'}/${target}.${col}`;
      const size = 2.3;
      const [x, y] = stub.at;
      const cands: TextPrim[][] = [];
      const mk = (tx: number, ty: number, anchor: 'start' | 'middle' | 'end'): TextPrim[] => [P.text(tx, ty, text, size, anchor, 'it-s', 'text', { owner: stub.net, role: 'xref' })];
      if (stub.side === 'above') for (const dx of [0.6, 4, 8, 12]) cands.push(mk(x + dx, y - 1, 'start'));
      if (stub.side === 'above' && x > 300) for (const dx of [0.6, 4]) cands.push(mk(x - dx, y - 1, 'end'));
      if (stub.side === 'below') for (const dy of [3.2, 6]) cands.push(mk(x + 0.6, y + dy, 'start'), mk(x, y + dy, 'middle'));
      if (stub.side === 'right') for (const dy of [0.8, -1.2, 3]) cands.push(mk(x + 1.2, y + dy, 'start'));
      cands.push(mk(x + 1, y - 1.2, 'start'), mk(x + 1, y + 3.2, 'start'), mk(x - 1, y - 1.2, 'end'));
      page.label({ candidates: cands, what: `交叉引用 ${text}` });
    }
    void seen;
  }

  /* ---------- 表格 ---------- */
  const designDate = options.date ?? build.design.date ?? '';
  const designer = options.designer ?? build.design.designer ?? '软件自动生成';
  const terminals = buildTerminalRows(circuit, wireNumbers, plan.terminalOf, refOfPin);
  const wireList = buildWireList(circuit, wireNumbers, pinAt, refOfPin, plan.terminalOf, assignment.rank);
  const pinName = (pin: string): string => {
    const device = deviceByTag.get(tagOf(pin));
    if (device?.terminal) return `${device.terminal.strip}:${device.terminal.no}`;
    return `${device?.displayTag ?? tagOf(pin)}:${pin.slice(pin.lastIndexOf(':') + 1)}`;
  };
  void pinName;
  const terminalPages = tablePages<TerminalRow>('terminals', `端子表 ${'-X1'}`, terminals, [
    { title: '端子', w: 22, get: (row) => `${row.strip}:${row.no}` },
    { title: '线号', w: 18, get: (row) => row.wireNo },
    { title: '柜内侧', w: 70, get: (row) => row.inside },
    { title: '现场侧', w: 56, get: (row) => row.outside },
    { title: '现场元件 / 用途', w: 110, get: (row) => row.purpose },
    { title: '类型', w: 30, get: (row) => (row.pe ? 'PE 端子' : '通用端子') },
    { title: '图纸位置', w: 24, get: (row) => row.ref }
  ]);
  const wirePages = tablePages<WireRow>('wires', '导线表', wireList, [
    { title: '线号', w: 20, get: (row) => row.no },
    { title: '起点', w: 76, get: (row) => row.from },
    { title: '终点', w: 76, get: (row) => row.to },
    { title: '截面', w: 26, get: (row) => row.section },
    { title: '颜色', w: 24, get: (row) => row.color },
    { title: '起点位置', w: 26, get: (row) => row.ref }
  ]);
  const bom = buildBom(circuit, ctx);
  const bomPages = tablePages<DrawingBomRow>('bom', '元件明细表', bom, [
    { title: '代号', w: 24, get: (row) => row.tag },
    { title: '名称', w: 52, get: (row) => row.name },
    { title: '型号', w: 64, get: (row) => row.model },
    { title: '规格', w: 120, get: (row) => row.spec },
    { title: '数量', w: 16, get: (row) => String(row.qty), align: 'end' },
    { title: '位置', w: 22, get: (row) => row.ref }
  ]);
  const all = [...schematic, ...terminalPages, ...wirePages, ...bomPages];
  all.forEach((page, i) => {
    page.index = i + 1;
  });
  const total = all.length;

  /* ---------- 摆文字 + 每页自检 ---------- */
  const { project, drawingNo } = build.design;
  const notes = [
    `数据来源：${build.design.source}`,
    `线号：${describeScheme(wireScheme)}`,
    '交叉引用“/页.列”；端子 -X1 按现场元件顺序自动编号；型号为估算初选，订货前核对样本',
    ...build.design.notes
  ];
  const pageNotes = (page: PageCanvas): string[] => (page.index === 1 ? notes : notes.slice(1, 3));
  const problems: string[] = [];
  const frames = new Map<PageCanvas, Prim[]>();
  for (const page of all) {
    const frame = [...frameprims(page, project, drawingNo, total), ...notesBlock(pageNotes(page))];
    const probe = titleBlock(project, drawingNo, page, total, STATUS.fail, designDate, designer);
    const pinPoints = page.symbols.flatMap((symbol) => Object.values(symbol.pins));
    const dots = junctionPoints(page.wires, pinPoints).map(([x, y]) => P.circle(x, y, 0.75, 'dot', 'if', { filled: true }));
    resolveLabels(page, [...frame, ...probe, ...dots]);
    frames.set(page, [...frame, ...dots]);
    // 文字自检（含表格、标题栏两种状态）
    const textProblems = checkTexts([...page.statics, ...frame, ...probe, ...wirePrims(page), ...page.prims], { x: 6, y: 6, w: PAGE_W - 12, h: PAGE_H - 12 });
    page.problems.push(...textProblems);
    if (page.kind === 'power' || page.kind === 'control' || page.kind === 'input' || page.kind === 'output') {
      page.problems.push(...checkPage(page, circuit, wireNumbers, busNets));
    }
    problems.push(...page.problems.map((problem) => `第 ${page.index} 页 ${problem}`));
  }

  /* ---------- 全局一致性 ---------- */
  for (const device of circuit.devices) {
    const missing = device.pins.filter((pin) => !pinAt.has(PIN(device.tag, pin)));
    if (missing.length === device.pins.length) problems.push(`[DEVICE_NOT_PLACED] ${device.tag}（${device.name}）没有画到图上`);
    else for (const pin of missing) problems.push(`[PIN_NOT_DRAWN] ${device.tag} 的引脚 ${pin} 没有画出来`);
  }
  for (const key of drawnTwice) problems.push(`[PIN_DRAWN_TWICE] ${key} 在图上画了两次`);
  for (const [net, pages] of netPages) {
    if (pages.size < 2) continue;
    for (const index of pages) {
      const page = all[index - 1] as PageCanvas;
      if (!page.stubs.some((stub) => stub.net === net)) {
        problems.push(`第 ${index} 页 [XREF_MISSING] 网络 ${wireNumbers[net] ?? net} 跨页但本页没有电位断点`);
      }
    }
  }
  const drawnTags = new Set(all.flatMap((page) => page.prims.filter((p): p is TextPrim => p.t === 'text' && p.role === 'tag').map((p) => p.value)));
  for (const row of bom) {
    if (!drawnTags.has(row.tag)) problems.push(`[BOM_NOT_DRAWN] 明细表里有 ${row.tag}（${row.name}），图上没有画出位号`);
  }
  for (const device of circuit.devices.filter((item) => item.kind === 'breaker')) {
    const why = breakerNameMismatch(device.name, device.model);
    if (why) problems.push(`[BOM_NAME_MODEL] ${device.tag} ${why}`);
  }
  const document = buildDocument(build, wireNumbers, pinAt, wireCategories, wireScheme);
  for (const finding of checkWireNumbers(document.wires ?? [], wireScheme)) {
    problems.push(`[WIRENO_RULE] ${finding.code} ${finding.message}`);
  }
  const uniq = new Map<string, string>();
  for (const [net, no] of Object.entries(wireNumbers)) {
    const key = no.toUpperCase();
    const other = uniq.get(key);
    if (other) problems.push(`[WIRENO_DUPLICATE] 线号 ${no} 同时用于 ${other} 与 ${net}`);
    else uniq.set(key, net);
  }

  const summary = ercSummary(issues);
  const deliverable = summary.errors === 0 && problems.length === 0;
  const status = deliverable ? (summary.warnings > 0 ? `${STATUS.ok}（${summary.warnings} 条提示）` : STATUS.ok) : STATUS.fail;
  const panelLines = [
    ...issues.filter((issue) => issue.severity === 'error').map((issue) => `[${issue.code}] ${issue.message}`),
    ...problems
  ];

  const pages: DrawingPage[] = all.map((page) => {
    const prims = [...page.statics, ...(frames.get(page) ?? []), ...wirePrims(page), ...page.prims, ...titleBlock(project, drawingNo, page, total, status, designDate, designer)];
    const panel = page.index === 1 ? issuePanel(panelLines) : [];
    const out: string[] = [];
    out.push('<defs><pattern id="elGrid" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M4 0H0V4" class="ic-grid"/></pattern></defs>');
    out.push(`<rect x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" fill="#fff"/>`);
    out.push(`<rect x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" fill="url(#elGrid)"/>`);
    for (const p of [...prims, ...panel]) out.push(primSvg(p));
    return { index: page.index, kind: page.kind, title: page.title, svg: out.join(''), prims, problems: [...page.problems] };
  });

  return {
    project,
    drawingNo,
    pages,
    issues,
    problems,
    deliverable,
    wireNumbers,
    wireCategories,
    wireScheme,
    wireNoAdjusted: assignment.adjusted,
    wireList,
    terminals,
    bom,
    document,
    build,
    canvases: all
  };
}

function wirePrims(page: PageCanvas): Prim[] {
  const out: Prim[] = [];
  for (const wire of page.wires) {
    for (let i = 0; i < wire.points.length - 1; i += 1) {
      const a = wire.points[i] as Pt;
      const b = wire.points[i + 1] as Pt;
      out.push(P.line(a[0], a[1], b[0], b[1], 'wire', 'ic', { owner: wire.net }));
    }
  }
  return out;
}

/** 单页导线/符号自检：本页子电路（本页画出的引脚 + 电位断点）对本页导线 */
const BUS_LABELS = new Set(['L1', 'L2', 'L3', 'N', 'PE', '+24V', '0V']);

export function checkPage(
  page: PageCanvas,
  circuit: Circuit,
  wireNumbers: Record<string, string>,
  busNets: ReadonlySet<string> = new Set(circuit.nets.filter((net) => BUS_LABELS.has(net.label ?? '')).map((net) => net.id))
): string[] {
  const problems: string[] = [];
  const devices: CircuitDevice[] = [];
  for (const device of circuit.devices) {
    const drawn = page.pinsDrawn.get(device.tag);
    if (!drawn) continue;
    devices.push({ ...device, pins: device.pins.filter((pin) => drawn.has(pin)) });
  }
  const pinSet = new Set(devices.flatMap((device) => device.pins.map((pin) => PIN(device.tag, pin))));
  const nets = circuit.nets
    .map((net) => ({ ...net, pins: net.pins.filter((pin) => pinSet.has(pin)) }))
    .filter((net) => net.pins.length > 0);
  // 电位断点当作单脚伪元件挂在网络上：出口导线不算悬空，且必须与本页其余部分连通
  const placed = page.symbols.map((symbol) => ({ tag: symbol.tag, pins: symbol.pins, box: symbol.box }));
  page.stubs.forEach((stub, i) => {
    const tag = `~XREF${i}`;
    devices.push({ tag, kind: 'module', name: '电位断点', model: '', spec: '', pins: ['x'] });
    placed.push({ tag, pins: { x: stub.at }, box: { x: stub.at[0], y: stub.at[1], w: 0, h: 0 } });
    const net = nets.find((item) => item.id === stub.net);
    if (net) net.pins.push(PIN(tag, 'x'));
    else nets.push({ id: stub.net, pins: [PIN(tag, 'x')] });
  });
  const sub: Circuit = { devices, nets, supply: circuit.supply };
  problems.push(...checkWiring(sub, page.wires, placed));
  for (let i = 0; i < page.symbols.length; i += 1) {
    const a = page.symbols[i];
    if (!a) continue;
    for (let j = i + 1; j < page.symbols.length; j += 1) {
      const b = page.symbols[j];
      if (b && boxesOverlap(a.box, b.box)) problems.push(`[SYMBOL_OVERLAP] 符号重叠：${a.tag} 与 ${b.tag}`);
    }
    const box = a.box;
    if (box.x < CONTENT.x || box.y < CONTENT.y || box.x + box.w > CONTENT.x + CONTENT.w || box.y + box.h > CONTENT.y + CONTENT.h) {
      problems.push(`[SYMBOL_OUT_OF_FRAME] 符号超出绘图区：${a.tag}`);
    }
  }
  // 每个非母线网络在本页至少标一次线号
  const labelled = new Set(page.prims.filter((p) => p.t === 'text' && p.role === 'wire-no').map((p) => p.owner));
  for (const net of new Set(page.wires.map((wire) => wire.net))) {
    if (busNets.has(net) || labelled.has(net)) continue;
    problems.push(`[WIRENO_MISSING] 网络 ${wireNumbers[net] ?? net} 在本页没有线号标注`);
  }
  return [...new Set(problems)];
}

/* ------------------------------------------------------------------ 导出数据 */

function category(circuit: Circuit, netId: string): { section: string; color: string; potential: string } {
  const net = circuit.nets.find((item) => item.id === netId);
  const label = net?.label ?? '';
  if (label === 'PE') return { section: '1.5 mm²', color: 'GNYE', potential: 'PE' };
  if (label === 'N' || /-N$/.test(netId)) return { section: '1.5 mm²', color: 'BU', potential: 'N' };
  if (['L1', 'L2', 'L3'].includes(label)) return { section: '1.5 mm²', color: 'BK', potential: label };
  if (/^BUS-|^B\d+-/.test(netId)) return { section: '1.5 mm²', color: 'BK', potential: 'AC380' };
  if (label === '+24V') return { section: '0.75 mm²', color: 'DBU', potential: '24V' };
  if (label === '0V') return { section: '0.75 mm²', color: 'DBU/WH', potential: '0V' };
  return { section: '0.75 mm²', color: 'DBU', potential: 'DC24' };
}

function buildWireList(
  circuit: Circuit,
  numbers: Record<string, string>,
  pinAt: Map<string, { page: number; pt: Pt }>,
  refOfPin: (pin: string) => string,
  terminalOf: Record<string, string>,
  rank: Record<string, number>
): WireRow[] {
  const rows: WireRow[] = [];
  const deviceByTag = new Map(circuit.devices.map((device) => [device.tag, device]));
  const name = (pin: string): string => {
    const device = deviceByTag.get(tagOf(pin));
    if (device?.terminal) return `${device.terminal.strip}:${device.terminal.no}`;
    return `${device?.displayTag ?? tagOf(pin)}:${pin.slice(pin.lastIndexOf(':') + 1)}`;
  };
  const order = (pin: string): [number, number, number] => {
    const at = pinAt.get(pin);
    return at ? [at.page, at.pt[0], at.pt[1]] : [999, 0, 0];
  };
  const cmp = (a: string, b: string): number => {
    const p = order(a);
    const q = order(b);
    return p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
  };
  for (const net of circuit.nets) {
    const no = numbers[net.id] ?? '';
    const cat = category(circuit, net.id);
    const field = net.pins.filter((pin) => {
      const device = deviceByTag.get(tagOf(pin));
      return Boolean(device?.field) || (device?.kind === 'terminal' && pin.endsWith(':o'));
    });
    const cabinet = net.pins.filter((pin) => !field.includes(pin)).sort(cmp);
    const push = (a: string, b: string): void => {
      rows.push({ no, net: net.id, from: name(a), to: name(b), section: cat.section, color: cat.color, ref: refOfPin(a) });
    };
    for (let i = 0; i < cabinet.length - 1; i += 1) push(cabinet[i] as string, cabinet[i + 1] as string);
    const terminalsOut = field.filter((pin) => deviceByTag.get(tagOf(pin))?.kind === 'terminal');
    const fieldPins = field.filter((pin) => deviceByTag.get(tagOf(pin))?.kind !== 'terminal');
    if (terminalsOut.length > 0) {
      // 每个端子外侧接它对应的现场引脚
      for (const out of terminalsOut) {
        const tag = tagOf(out);
        const target = fieldPins.find((pin) => terminalOf[pin] === tag);
        if (target) push(out, target);
      }
    } else {
      const sorted = [...fieldPins].sort(cmp);
      for (let i = 0; i < sorted.length - 1; i += 1) push(sorted[i] as string, sorted[i + 1] as string);
    }
  }
  // 线号分配顺序：母线在前，其余按阅读顺序（数字连续方案下即线号从小到大）
  return rows.sort((a, b) => (rank[a.net] ?? 1e9) - (rank[b.net] ?? 1e9));
}

function buildTerminalRows(
  circuit: Circuit,
  numbers: Record<string, string>,
  terminalOf: Record<string, string>,
  refOfPin: (pin: string) => string
): TerminalRow[] {
  const deviceByTag = new Map(circuit.devices.map((device) => [device.tag, device]));
  const rows: TerminalRow[] = [];
  for (const [fieldPin, tag] of Object.entries(terminalOf)) {
    const terminal = deviceByTag.get(tag);
    if (!terminal?.terminal) continue;
    const net = circuit.nets.find((item) => item.pins.includes(fieldPin));
    const insidePins = (net?.pins ?? []).filter((pin) => {
      const device = deviceByTag.get(tagOf(pin));
      return device && !device.field && device.kind !== 'terminal';
    });
    const field = deviceByTag.get(tagOf(fieldPin));
    const pinName = (pin: string): string => {
      const device = deviceByTag.get(tagOf(pin));
      return `${device?.displayTag ?? tagOf(pin)}:${pin.slice(pin.lastIndexOf(':') + 1)}`;
    };
    rows.push({
      strip: terminal.terminal.strip,
      no: terminal.terminal.no,
      wireNo: net ? numbers[net.id] ?? '' : '',
      inside: insidePins.length > 0 ? insidePins.slice(0, 2).map(pinName).join('、') + (insidePins.length > 2 ? ` 等 ${insidePins.length} 处` : '') : '（PE 汇流排）',
      outside: pinName(fieldPin),
      purpose: [field?.name, field?.purpose].filter(Boolean).join(' · '),
      ref: refOfPin(PIN(tag, 'i')),
      pe: Boolean(terminal.terminal.pe)
    });
  }
  return rows.sort((a, b) => a.no - b.no);
}

function buildBom(circuit: Circuit, ctx: LayoutContext): DrawingBomRow[] {
  const rows = new Map<string, DrawingBomRow>();
  const terminals = circuit.devices.filter((device) => device.kind === 'terminal');
  for (const device of circuit.devices) {
    if (device.kind === 'terminal') continue;
    const tag = device.displayTag ?? device.tag;
    const primary = !device.displayTag || device.displayTag === device.tag;
    const existing = rows.get(tag);
    if (!existing) rows.set(tag, { tag, name: device.name, model: device.model, spec: device.spec, qty: 1, ref: ctx.refOf(device.tag).slice(1) });
    else if (primary) {
      existing.name = device.name;
      existing.model = device.model;
      existing.spec = device.spec;
      existing.ref = ctx.refOf(device.tag).slice(1);
    }
  }
  if (terminals.length > 0) {
    const strip = terminals[0]?.displayTag ?? '-X1';
    const pe = terminals.filter((device) => device.terminal?.pe).length;
    rows.set(strip, {
      tag: strip,
      name: '端子排',
      model: pe > 0 ? 'UK2.5B / UKT2.5-PE' : 'UK2.5B',
      spec: `${terminals.length} 位（通用 ${terminals.length - pe}，PE ${pe}）· 详见端子表`,
      qty: 1,
      ref: ctx.refOf(terminals[0]?.tag ?? '').slice(1)
    });
  }
  return [...rows.values()];
}

function buildDocument(
  build: ElecBuild,
  numbers: Record<string, string>,
  pinAt: Map<string, { page: number; pt: Pt }>,
  categories: Record<string, WireNoCategory>,
  wireScheme: WireNoScheme
): ElecDocument {
  const { circuit, design } = build;
  const wires: CheckWire[] = circuit.nets.map((net) => {
    const sorted = [...net.pins].sort((a, b) => (pinAt.get(a)?.page ?? 99) - (pinAt.get(b)?.page ?? 99));
    return {
      no: numbers[net.id] ?? '',
      net: net.id,
      potential: category(circuit, net.id).potential,
      from: sorted[0] ?? net.id,
      to: sorted.length > 1 ? (sorted[sorted.length - 1] as string) : (sorted[0] ?? net.id),
      ...(categories[net.id] ? { category: categories[net.id] as WireNoCategory } : {})
    };
  });
  const loads: Load[] = [];
  for (const branch of build.plan.branches) {
    if (branch.kind === 'psu' || !branch.motor) continue;
    const motor = circuit.devices.find((device) => device.tag === branch.motor);
    const spec = design.motors.find((item) => (item.purpose ?? item.name) === branch.purpose);
    const kw = spec?.powerKw ?? Number(/([\d.]+) kW/.exec(motor?.spec ?? '')?.[1] ?? 0);
    loads.push({ tag: branch.motor, powerKw: kw, phase: branch.kind === 'servo' ? (branch.phase ?? 'L1') : '3P' });
  }
  if (design.psu.watts) loads.push({ tag: '-G1', powerKw: design.psu.watts / 1000, phase: 'L1' });
  /*
   * 回路校验数据：只列「断路器 + 导线」已成对选出的回路。
   * breakerA 与 sectionMm2 由 selection.ts 同一套关系给出，因此天然满足 ampacity ≥ breakerA；
   * 校验器仍按原规则独立复核（BREAKER_OVERSIZE 不放软）。
   */
  const circuits: CircuitCheck[] = [];
  const pushCircuit = (wireNet: string | undefined, breakerA: number, sectionMm2: number | null, currentA: number): void => {
    if (!wireNet || sectionMm2 === null || !(currentA > 0)) return;
    const wireNo = numbers[wireNet];
    if (!wireNo) return;
    circuits.push({ wireNo, currentA: Math.round(currentA * 10) / 10, sectionMm2, breakerA });
  };
  for (const branch of build.plan.branches) {
    const outNet = circuit.nets.find((net) => net.pins.includes(`${branch.breaker}:2`));
    pushCircuit(outNet?.id, branch.breakerA, branch.sectionMm2, branch.currentA);
  }
  pushCircuit('BUS-L1', build.plan.mainFeed.breakerA, build.plan.mainFeed.sectionMm2, build.plan.mainFeed.currentA);
  return { wires, loads, circuits, wireScheme, options: { ...(design.psu.watts ? { psuRatedA: Math.round((design.psu.watts / 24) * 10) / 10 } : {}) } };
}

export { textWidth };
