import enclosureStyles from './enclosure.css?inline';
import { buildEntryButton, ensurePanelStyles, escapeHtml, notify } from '../ui/panels';
import {
  clampToPlate,
  findCollisions,
  placementWarnings,
  railSnapPlacement,
  railSnapY,
  rotateSize,
  snapMm,
  utilization,
  type Placement,
  type PlacementWarning,
  type PlateSpec,
  type Rail
} from './layout';

const STORE_KEY = 'automationcad.enclosure.v1';
const ENTRY_ID = 'enclosureEntryButton';
const OVERLAY_ID = 'enclosureOverlay';
const GRID_PAD = 16;
const RAIL_HEIGHT = 35;
const ELECTRICAL_PACK_PATTERN = /(^|[-_])(iec|elec|electric|电气)([-_]|$)/i;
const PART_MIME = 'application/x-automationcad-part';

const ENTRY_ICON = '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 7h12M4.5 10.2h2.2M8.4 10.2h3.1"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 16 16"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>';

interface StoredPlate {
  width: number;
  height: number;
  rails: Rail[];
}

interface StoredLayout {
  version: 1;
  plate: StoredPlate;
  placements: Placement[];
}

export interface EnclosureState {
  placed: number;
  overlap: number;
  collisions: number;
  ratio: number;
  usedMm2: number;
  plate: { width: number; height: number; rails: Rail[] };
  placements: Placement[];
  /** 当前选中 placement；未选中为 null。 */
  selected: Placement | null;
}

export interface EnclosurePlaceOptions {
  rotate?: boolean;
  railSnap?: boolean;
}

export type EnclosurePlaceOutcome =
  | { ok: true; placement: Placement; warnings: PlacementWarning[] }
  | { ok: false; code: 'PART_NOT_FOUND' | 'NO_DIMENSIONS'; message: string };

interface DragPoint {
  x: number;
  y: number;
}

type ActiveDrag =
  | { kind: 'part'; id: string; offsetX: number; offsetY: number; pointerId: number }
  | { kind: 'rail'; id: string; startPointerY: number; startRailY: number; pointerId: number };

let catalogPromise: Promise<DesktopComponentPart[]> | null = null;
let canvasInstance: EnclosureCanvas | null = null;
let overlayElement: HTMLElement | null = null;
let entryElement: HTMLButtonElement | null = null;
let initialized = false;
let paletteParts: DesktopComponentPart[] = [];
let paletteQuery = '';

function injectStyles(): void {
  if (document.getElementById('enclosure-canvas-styles')) return;
  const style = document.createElement('style');
  style.id = 'enclosure-canvas-styles';
  style.textContent = enclosureStyles;
  document.head.appendChild(style);
}

function partKey(part: DesktopComponentPart): string {
  return `${part.packId ?? ''}|${part.id}`;
}

function isElectricalPack(parts: DesktopComponentPart[]): boolean {
  if (parts.length === 0) return false;
  const id = parts[0]?.packId ?? '';
  if (ELECTRICAL_PACK_PATTERN.test(id)) return true;
  const withSymbol = parts.filter((part) => typeof part.symbol === 'string' && part.symbol !== '').length;
  return withSymbol * 2 >= parts.length;
}

function electricalParts(parts: DesktopComponentPart[]): DesktopComponentPart[] {
  const byPack = new Map<string, DesktopComponentPart[]>();
  for (const part of parts) {
    const id = part.packId ?? '';
    const list = byPack.get(id) ?? [];
    list.push(part);
    byPack.set(id, list);
  }
  const electricalPacks = new Set(
    [...byPack.entries()]
      .filter(([, list]) => isElectricalPack(list))
      .map(([id]) => id)
  );
  return parts.filter((part) => electricalPacks.has(part.packId ?? ''));
}

export async function loadEnclosureParts(): Promise<DesktopComponentPart[]> {
  if (catalogPromise) return await catalogPromise;
  const api = window.desktop;
  if (!api) return [];
  const request = api.packs.listParts().then((parts) => electricalParts(parts));
  catalogPromise = request;
  try {
    return await request;
  } catch (error) {
    catalogPromise = null;
    throw error;
  }
}

function defaultRails(width: number, height: number): Rail[] {
  const first = Math.max(40, Math.round(height * 0.2));
  const second = Math.max(first + RAIL_HEIGHT + 80, Math.round(height * 0.63));
  return [
    { id: 'rail-1', y: Math.min(first, Math.max(0, height - RAIL_HEIGHT)), height: RAIL_HEIGHT, label: '导轨 1' },
    { id: 'rail-2', y: Math.min(second, Math.max(0, height - RAIL_HEIGHT)), height: RAIL_HEIGHT, label: '导轨 2' }
  ];
}

function normalizeRails(value: unknown, width: number, height: number): Rail[] {
  if (!Array.isArray(value) || value.length < 2) return defaultRails(width, height);
  const rails: Rail[] = [];
  value.slice(0, 2).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const source = item as Record<string, unknown>;
    const y = Number(source.y);
    if (!Number.isFinite(y)) return;
    rails.push({
      id: typeof source.id === 'string' && source.id ? source.id : `rail-${index + 1}`,
      y: Math.min(Math.max(0, y), Math.max(0, height - RAIL_HEIGHT)),
      height: RAIL_HEIGHT,
      label: typeof source.label === 'string' && source.label ? source.label : `导轨 ${index + 1}`
    });
  });
  if (rails.length < 2) return defaultRails(width, height);
  return rails;
}

function readStoredLayout(): StoredLayout {
  const width = 600;
  const height = 800;
  const fallback: StoredLayout = {
    version: 1,
    plate: { width, height, rails: defaultRails(width, height) },
    placements: []
  };
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const source = parsed as Record<string, unknown>;
    const plate = source.plate && typeof source.plate === 'object' ? source.plate as Record<string, unknown> : {};
    const w = Number(plate.width);
    const h = Number(plate.height);
    const plateWidth = Number.isFinite(w) && w >= 100 && w <= 3000 ? Math.round(w) : width;
    const plateHeight = Number.isFinite(h) && h >= 100 && h <= 3000 ? Math.round(h) : height;
    const rails = normalizeRails(plate.rails, plateWidth, plateHeight);
    const placements = Array.isArray(source.placements)
      ? source.placements.filter((item): item is Placement => {
          if (!item || typeof item !== 'object') return false;
          const p = item as Record<string, unknown>;
          return typeof p.id === 'string' && typeof p.partId === 'string' && typeof p.model === 'string' &&
            Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) &&
            Number.isFinite(Number(p.w)) && Number.isFinite(Number(p.h)) &&
            Number(p.w) > 0 && Number(p.h) > 0;
        }).map((item) => clampToPlate({
          id: item.id,
          partId: item.partId,
          model: item.model,
          x: Number(item.x),
          y: Number(item.y),
          w: Number(item.w),
          h: Number(item.h),
          ...(typeof (item as Placement).railId === 'string' ? { railId: (item as Placement).railId } : {}),
          ...(typeof (item as Placement).tag === 'string' ? { tag: (item as Placement).tag } : {}),
          ...(Number.isInteger(Number((item as Placement).qty)) && Number((item as Placement).qty) > 0
            ? { qty: Number((item as Placement).qty) }
            : {}),
          ...(typeof (item as Placement).note === 'string' ? { note: (item as Placement).note } : {})
        }, { width: plateWidth, height: plateHeight, rails }))
      : [];
    return {
      version: 1,
      plate: { width: plateWidth, height: plateHeight, rails },
      placements
    };
  } catch {
    return fallback;
  }
}

function modelLabel(placement: Placement): string {
  if (placement.w > 60) return placement.model;
  const token = placement.model.trim().split(/\s+/)[0] ?? placement.model;
  return token.length > 10 ? `${token.slice(0, 9)}…` : token;
}

function svgText(value: string): string {
  return escapeHtml(value);
}

export class EnclosureCanvas {
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly widthInput: HTMLInputElement;
  private readonly heightInput: HTMLInputElement;
  private readonly placedValue: HTMLElement;
  private readonly ratioValue: HTMLElement;
  private readonly collisionValue: HTMLElement;
  private readonly selectedValue: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly scaleButtons: HTMLButtonElement[];
  private readonly resizeObserver: ResizeObserver | null;
  private plate: PlateSpec;
  private placements: Placement[];
  private selectedId: string | null = null;
  private activeDrag: ActiveDrag | null = null;
  private dragDirty = false;
  private dragRenderFrame: number | null = null;
  private activationFrame: number | null = null;
  private disposed = false;
  private readonly events = new AbortController();
  private zoom = 1;
  private sequence = 0;
  private active = false;

  constructor(host: HTMLElement) {
    const stored = readStoredLayout();
    this.plate = stored.plate;
    this.placements = stored.placements;

    host.innerHTML = `
      <div class="enc-canvas" id="encCanvasRoot">
        <div class="enc-toolbar" role="toolbar" aria-label="底板布置工具">
          <div class="enc-tool-group">
            <span>底板</span>
            <input class="enc-num" id="encPlateWidth" type="number" min="100" max="3000" step="10" aria-label="底板宽度 mm">
            <span>×</span>
            <input class="enc-num" id="encPlateHeight" type="number" min="100" max="3000" step="10" aria-label="底板高度 mm">
            <span>mm</span>
          </div>
          <div class="enc-tool-group">
            <span>缩放</span>
            <div class="enc-zoom" role="group" aria-label="缩放比例">
              <button type="button" data-enc-zoom="0.5">0.5×</button>
              <button type="button" data-enc-zoom="1" class="is-active">1×</button>
              <button type="button" data-enc-zoom="2">2×</button>
            </div>
          </div>
          <div class="enc-tool-group is-end">
            <span class="enc-hint">拖入元件 · 拖动导轨 · Delete 删除 · R 旋转</span>
            <button type="button" class="enc-btn enc-btn-danger" id="encClear">清空</button>
            <button type="button" class="enc-btn enc-btn-primary" id="encExport">${ENTRY_ICON}<span>导出 JSON</span></button>
          </div>
        </div>
        <div class="enc-viewport" id="encViewport" tabindex="0" aria-label="电箱底板画布">
          <svg class="enc-svg" id="encSvg" role="img" aria-label="电箱底板布局图"></svg>
          <div class="enc-empty" id="encEmpty">从左侧拖入带外形尺寸的电气元件</div>
        </div>
        <footer class="enc-status" id="encStatus">
          <span>已放置 <b id="encPlaced">0</b></span>
          <span>利用率 <b id="encRatio">0.0%</b></span>
          <span>冲突 <b id="encCollisions">0</b> 处</span>
          <span class="enc-status-spacer"></span>
          <span id="encSelected">未选中</span>
          <span class="enc-status-key">1 mm 吸附 · 浅色图纸</span>
        </footer>
      </div>`;

    this.root = this.required(host, '#encCanvasRoot');
    this.viewport = this.required(host, '#encViewport');
    this.svg = host.querySelector<SVGSVGElement>('#encSvg') ?? this.missing('encSvg');
    this.widthInput = host.querySelector<HTMLInputElement>('#encPlateWidth') ?? this.missing('encPlateWidth');
    this.heightInput = host.querySelector<HTMLInputElement>('#encPlateHeight') ?? this.missing('encPlateHeight');
    this.placedValue = this.required(host, '#encPlaced');
    this.ratioValue = this.required(host, '#encRatio');
    this.collisionValue = this.required(host, '#encCollisions');
    this.selectedValue = this.required(host, '#encSelected');
    this.emptyHint = this.required(host, '#encEmpty');
    this.scaleButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-enc-zoom]')];

    this.widthInput.value = String(this.plate.width);
    this.heightInput.value = String(this.plate.height);

    const signal = this.events.signal;
    host.querySelector<HTMLButtonElement>('#encClear')?.addEventListener('click', () => this.clear(), { signal });
    host.querySelector<HTMLButtonElement>('#encExport')?.addEventListener('click', () => this.exportJson(), { signal });
    this.widthInput.addEventListener('change', () => this.applySizeInput(), { signal });
    this.heightInput.addEventListener('change', () => this.applySizeInput(), { signal });
    for (const button of this.scaleButtons) {
      button.addEventListener('click', () => this.setZoom(Number(button.dataset.encZoom)), { signal });
    }

    this.svg.addEventListener('pointerdown', this.onPointerDown, { signal });
    this.svg.addEventListener('pointermove', this.onPointerMove, { signal });
    this.svg.addEventListener('pointerup', this.onPointerUp, { signal });
    this.svg.addEventListener('pointercancel', this.onPointerCancel, { signal });
    this.svg.addEventListener('lostpointercapture', this.onPointerCancel, { signal });
    const capture = { capture: true, signal };
    window.addEventListener('keydown', this.onKeyDown, capture);
    window.addEventListener('drop', this.onWindowDrop, capture);
    window.addEventListener('dragover', this.onWindowDragOver, capture);
    window.addEventListener('dragleave', this.onWindowDragLeave, capture);
    window.addEventListener('dragend', this.onWindowDragLeave, capture);

    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.fit())
      : null;
    this.resizeObserver?.observe(this.viewport);
    this.render();
    this.fit();
  }

  private missing(id: string): never {
    throw new Error(`底板画布节点缺失：${id}`);
  }

  private required(host: HTMLElement, selector: string): HTMLElement {
    const element = host.querySelector<HTMLElement>(selector);
    if (!element) this.missing(selector);
    return element;
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (this.activationFrame !== null) window.cancelAnimationFrame(this.activationFrame);
    this.activationFrame = null;
    this.active = active;
    if (active) {
      this.fit();
      this.activationFrame = window.requestAnimationFrame(() => {
        this.activationFrame = null;
        this.fit();
        this.viewport.focus({ preventScroll: true });
      });
    } else {
      this.finishDrag();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.setActive(false);
    this.disposed = true;
    this.events.abort();
    this.resizeObserver?.disconnect();
  }

  fit(): void {
    const width = this.plate.width + GRID_PAD * 2;
    const height = this.plate.height + GRID_PAD * 2;
    const availableWidth = Math.max(80, this.viewport.clientWidth - 38);
    const availableHeight = Math.max(80, this.viewport.clientHeight - 38);
    const fitScale = Math.min(availableWidth / width, availableHeight / height);
    this.svg.style.width = `${Math.max(60, width * fitScale * this.zoom)}px`;
    this.svg.style.height = `${Math.max(60, height * fitScale * this.zoom)}px`;
  }

  private setZoom(value: number): void {
    if (![0.5, 1, 2].includes(value)) return;
    this.zoom = value;
    for (const button of this.scaleButtons) {
      button.classList.toggle('is-active', Number(button.dataset.encZoom) === value);
    }
    this.fit();
  }

  private applySizeInput(): void {
    const width = this.sanitizeSize(this.widthInput.value, this.plate.width);
    const height = this.sanitizeSize(this.heightInput.value, this.plate.height);
    this.widthInput.value = String(width);
    this.heightInput.value = String(height);
    if (width === this.plate.width && height === this.plate.height) return;
    this.plate = {
      width,
      height,
      rails: this.plate.rails.map((rail, index) => ({
        ...rail,
        id: rail.id || `rail-${index + 1}`,
        y: Math.min(Math.max(0, rail.y), Math.max(0, height - rail.height))
      }))
    };
    this.placements = this.placements.map((placement) => clampToPlate(placement, this.plate));
    this.sync();
    this.render();
    this.fit();
  }

  private sanitizeSize(value: string, fallback: number): number {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(3000, Math.max(100, parsed));
  }

  private nextId(): string {
    this.sequence += 1;
    return `enc-${Date.now().toString(36)}-${this.sequence}`;
  }

  async addPart(partId: string, x?: number, y?: number): Promise<Placement | null> {
    const outcome = await this.placePart(partId, x, y);
    if (!outcome.ok) {
      notify(outcome.message, true);
      return null;
    }
    return { ...outcome.placement };
  }

  async placePart(
    partId: string,
    x?: number,
    y?: number,
    options: EnclosurePlaceOptions = {}
  ): Promise<EnclosurePlaceOutcome> {
    const parts = await loadEnclosureParts();
    const part = parts.find((item) => partKey(item) === partId || item.id === partId);
    if (!part) {
      return { ok: false, code: 'PART_NOT_FOUND', message: `元器件不存在：${partId}` };
    }
    const dims = part.dims;
    if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
      return {
        ok: false,
        code: 'NO_DIMENSIONS',
        message: `元件 ${part.model} 缺少外形尺寸，无法放置到底板`
      };
    }

    const size = options.rotate === true ? rotateSize(dims.w, dims.h) : { w: dims.w, h: dims.h };
    let left = x;
    let top = y;
    if (left === undefined || top === undefined) {
      const auto = this.autoPosition(part, size.w, size.h);
      left = auto.x;
      top = auto.y;
    }

    let placement: Placement = {
      id: this.nextId(),
      partId: part.id,
      model: part.model,
      x: snapMm(left),
      y: snapMm(top),
      w: size.w,
      h: size.h
    };
    if (part.railMount && options.railSnap !== false) {
      const snap = railSnapPlacement(this.plate, placement);
      if (snap) {
        placement.y = snap.y;
        placement.railId = snap.railId;
      }
    }
    const intended = placement;
    placement = clampToPlate(placement, this.plate);
    const warnings = placementWarnings(this.placements, placement, this.plate, intended);
    this.placements.push(placement);
    this.selectedId = placement.id;
    this.sync();
    this.render();
    return { ok: true, placement: { ...placement }, warnings };
  }

  private autoPosition(part: DesktopComponentPart, width: number, height: number): { x: number; y: number } {
    if (part.railMount) {
      const rail = this.plate.rails[0];
      if (rail) {
        const right = this.placements
          .filter((item) => item.railId === rail.id)
          .reduce((max, item) => Math.max(max, item.x + item.w), 0);
        const x = right > 0 ? right + 10 : 20;
        const y = railSnapY(rail, height);
        return clampToPlate({ id: 'preview', partId: part.id, model: part.model, x, y, w: width, h: height }, this.plate);
      }
    }
    for (let y = 20; y <= this.plate.height - height; y += 10) {
      for (let x = 20; x <= this.plate.width - width; x += 10) {
        const candidate: Placement = { id: 'preview', partId: part.id, model: part.model, x, y, w: width, h: height };
        if (this.placements.every((item) => !this.intersects(candidate, item))) return { x, y };
      }
    }
    return { x: 20, y: 20 };
  }

  private intersects(a: Placement, b: Placement): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  clear(): void {
    this.finishDrag();
    this.placements = [];
    this.selectedId = null;
    this.sync();
    this.render();
  }

  private deleteSelected(): void {
    if (!this.selectedId) return;
    this.placements = this.placements.filter((item) => item.id !== this.selectedId);
    this.selectedId = null;
    this.sync();
    this.render();
  }

  /** 按放置 id 移除（Agent 撤销用），返回是否真的删掉了。 */
  removePlacement(id: string): boolean {
    const index = this.placements.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.placements.splice(index, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.sync();
    this.render();
    return true;
  }

  /** 按放置 id 更新型号/数量/备注/尺寸（Agent update_component 用）。 */
  updatePlacement(id: string, patch: Partial<Placement>): Placement | null {
    const index = this.placements.findIndex((item) => item.id === id);
    const current = index >= 0 ? this.placements[index] : undefined;
    if (!current) return null;
    const next: Placement = {
      ...current,
      ...(typeof patch.partId === 'string' && patch.partId.trim() ? { partId: patch.partId.trim() } : {}),
      ...(typeof patch.model === 'string' && patch.model.trim() ? { model: patch.model.trim() } : {}),
      ...(Number.isFinite(patch.w) && Number(patch.w) > 0 ? { w: Number(patch.w) } : {}),
      ...(Number.isFinite(patch.h) && Number(patch.h) > 0 ? { h: Number(patch.h) } : {}),
      ...(Number.isInteger(patch.qty) && Number(patch.qty) > 0 ? { qty: Number(patch.qty) } : {}),
      ...(typeof patch.note === 'string' ? { note: patch.note } : {}),
      ...(typeof patch.tag === 'string' && patch.tag.trim() ? { tag: patch.tag.trim() } : {})
    };
    this.placements[index] = clampToPlate(next, this.plate);
    this.selectedId = id;
    this.sync();
    this.render();
    return { ...this.placements[index]! };
  }

  /** 撤销移除时按快照恢复，保持原 id / 坐标 / 尺寸。 */
  restorePlacement(record: Placement): boolean {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) return false;
    if (this.placements.some((item) => item.id === record.id)) return false;
    const restored = clampToPlate({
      id: record.id,
      partId: record.partId,
      model: record.model,
      x: Number(record.x),
      y: Number(record.y),
      w: Number(record.w),
      h: Number(record.h),
      ...(typeof record.railId === 'string' ? { railId: record.railId } : {}),
      ...(typeof record.tag === 'string' ? { tag: record.tag } : {}),
      ...(Number.isInteger(record.qty) && Number(record.qty) > 0 ? { qty: Number(record.qty) } : {}),
      ...(typeof record.note === 'string' ? { note: record.note } : {})
    }, this.plate);
    this.placements.push(restored);
    this.selectedId = restored.id;
    this.sync();
    this.render();
    return true;
  }

  private rotateSelected(): void {
    if (!this.selectedId) return;
    const index = this.placements.findIndex((item) => item.id === this.selectedId);
    const current = this.placements[index];
    if (!current) return;
    let rotated: Placement = { ...current, w: current.h, h: current.w };
    if (rotated.railId) {
      const rail = this.plate.rails.find((item) => item.id === rotated.railId);
      if (rail) rotated.y = railSnapY(rail, rotated.h);
    }
    rotated = clampToPlate(rotated, this.plate);
    this.placements[index] = rotated;
    this.sync();
    this.render();
  }

  exportJson(): void {
    const payload: StoredLayout = {
      version: 1,
      plate: {
        width: this.plate.width,
        height: this.plate.height,
        rails: this.plate.rails.map((rail) => ({ ...rail }))
      },
      placements: this.placements.map((item) => ({ ...item }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `enclosure-${this.plate.width}x${this.plate.height}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  state(): EnclosureState {
    const collisions = findCollisions(this.placements);
    const usage = utilization(this.placements, this.plate);
    const selected = this.selectedId
      ? this.placements.find((item) => item.id === this.selectedId) ?? null
      : null;
    return {
      placed: this.placements.length,
      overlap: collisions.length,
      collisions: collisions.length,
      ratio: usage.ratio,
      usedMm2: usage.usedMm2,
      plate: {
        width: this.plate.width,
        height: this.plate.height,
        rails: this.plate.rails.map((rail) => ({ ...rail }))
      },
      placements: this.placements.map((item) => ({ ...item })),
      selected: selected ? { ...selected } : null
    };
  }

  private sync(): void {
    const stored: StoredLayout = {
      version: 1,
      plate: {
        width: this.plate.width,
        height: this.plate.height,
        rails: this.plate.rails.map((rail) => ({ ...rail }))
      },
      placements: this.placements.map((item) => ({ ...item }))
    };
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(stored));
    } catch (error) {
      // localStorage 不可用时不影响当前画布，仅失去刷新恢复能力。
      console.warn(`[ENCLOSURE_LOCALSTORAGE_FAILED]`, { site: 'desktop/src/enclosure/canvas.ts:636' }, error);
    }
  }

  private collisions(): Array<[string, string]> {
    return findCollisions(this.placements);
  }

  private render(): void {
    if (this.dragRenderFrame !== null) window.cancelAnimationFrame(this.dragRenderFrame);
    this.dragRenderFrame = null;
    const collisions = this.collisions();
    const collisionIds = new Set<string>();
    for (const [a, b] of collisions) {
      collisionIds.add(a);
      collisionIds.add(b);
    }
    const usage = utilization(this.placements, this.plate);
    const selected = this.placements.find((item) => item.id === this.selectedId);

    this.root.dataset.placed = String(this.placements.length);
    this.root.dataset.collisions = String(collisions.length);
    this.root.dataset.ratio = usage.ratio.toFixed(6);
    this.placedValue.textContent = String(this.placements.length);
    this.ratioValue.textContent = `${(usage.ratio * 100).toFixed(1)}%`;
    this.collisionValue.textContent = String(collisions.length);
    this.collisionValue.classList.toggle('is-error', collisions.length > 0);
    this.collisionValue.classList.toggle('is-ok', collisions.length === 0);
    this.selectedValue.textContent = selected
      ? `${selected.model} · X ${selected.x.toFixed(1)} / Y ${selected.y.toFixed(1)} mm`
      : '未选中';
    this.emptyHint.hidden = this.placements.length > 0;

    const pad = GRID_PAD;
    this.svg.setAttribute('viewBox', `${-pad} ${-pad} ${this.plate.width + pad * 2} ${this.plate.height + pad * 2}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const railMarkup = this.plate.rails.map((rail) => `
      <g class="enc-rail-group" data-enc-rail="${svgText(rail.id)}">
        <rect class="enc-rail" x="0" y="${rail.y}" width="${this.plate.width}" height="${rail.height}"></rect>
        <line class="enc-rail-line" x1="0" y1="${rail.y + 2}" x2="${this.plate.width}" y2="${rail.y + 2}"></line>
        <line class="enc-rail-line" x1="0" y1="${rail.y + rail.height - 2}" x2="${this.plate.width}" y2="${rail.y + rail.height - 2}"></line>
        <text class="enc-rail-label" x="5" y="${rail.y + rail.height / 2 + 3}">${svgText(rail.label)} · 35 mm</text>
      </g>`).join('');

    const placementMarkup = this.placements.map((placement) => {
      const isCollision = collisionIds.has(placement.id);
      const isSelected = placement.id === this.selectedId;
      const label = modelLabel(placement);
      const showSub = placement.w > 34 && placement.h > 22;
      const badgeX = Math.max(3.5, placement.w - 4);
      const collisionBadge = isCollision
        ? `<circle class="enc-badge" cx="${badgeX}" cy="4" r="3.4"></circle>
           <text class="enc-badge-text" x="${badgeX}" y="5.7">!</text>`
        : '';
      return `<g class="enc-part" data-enc-part="${svgText(placement.id)}" data-selected="${isSelected ? '1' : '0'}" data-collision="${isCollision ? '1' : '0'}" transform="translate(${placement.x} ${placement.y})">
        <rect class="enc-body" x="0" y="0" width="${placement.w}" height="${placement.h}" rx="0.8"></rect>
        <text class="enc-model" x="2.4" y="${showSub ? placement.h / 2 - 0.5 : placement.h / 2 + 1.1}">${svgText(label)}</text>
        ${showSub ? `<text class="enc-sub" x="2.4" y="${placement.h / 2 + 4.2}">${placement.w}×${placement.h} mm</text>` : ''}
        ${collisionBadge}
      </g>`;
    }).join('');

    this.svg.innerHTML = `
      <defs>
        <pattern id="encGridMinor" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#e4e6e7" stroke-width="0.12" vector-effect="non-scaling-stroke"></path>
        </pattern>
        <pattern id="encGridMajor" width="10" height="10" patternUnits="userSpaceOnUse">
          <rect width="10" height="10" fill="url(#encGridMinor)"></rect>
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#c9cdd0" stroke-width="0.32" vector-effect="non-scaling-stroke"></path>
        </pattern>
      </defs>
      <rect class="enc-paper" x="0" y="0" width="${this.plate.width}" height="${this.plate.height}"></rect>
      <rect class="enc-grid-major" x="0" y="0" width="${this.plate.width}" height="${this.plate.height}"></rect>
      ${railMarkup}
      <g class="enc-placements">${placementMarkup}</g>
      <g class="enc-dimensions">
        <line class="enc-axis" x1="0" y1="${this.plate.height + 8}" x2="${this.plate.width}" y2="${this.plate.height + 8}"></line>
        <text class="enc-dim" x="${this.plate.width / 2}" y="${this.plate.height + 13}" text-anchor="middle">${this.plate.width} mm</text>
        <text class="enc-dim" x="${-8}" y="${this.plate.height / 2}" text-anchor="middle" transform="rotate(-90 ${-8} ${this.plate.height / 2})">${this.plate.height} mm</text>
        <text class="enc-dim" x="2" y="${-7}">0,0</text>
      </g>
      ${this.placements.length === 0 ? `<text class="enc-empty-hint" x="${this.plate.width / 2}" y="${this.plate.height / 2}">拖入元件开始布置</text>` : ''}`;
  }

  private pointFrom(event: PointerEvent | DragEvent): DragPoint {
    const point = this.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || this.disposed || event.button !== 0 || this.activeDrag) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const coordinate = this.pointFrom(event);

    const railNode = target.closest<SVGElement>('[data-enc-rail]');
    if (railNode) {
      const id = railNode.getAttribute('data-enc-rail');
      const rail = id ? this.plate.rails.find((item) => item.id === id) : undefined;
      if (!rail) return;
      this.activeDrag = {
        kind: 'rail',
        id: rail.id,
        startPointerY: coordinate.y,
        startRailY: rail.y,
        pointerId: event.pointerId
      };
      this.svg.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const partNode = target.closest<SVGElement>('[data-enc-part]');
    if (partNode) {
      const id = partNode.getAttribute('data-enc-part');
      const placement = id ? this.placements.find((item) => item.id === id) : undefined;
      if (!placement) return;
      this.selectedId = placement.id;
      this.activeDrag = {
        kind: 'part',
        id: placement.id,
        offsetX: coordinate.x - placement.x,
        offsetY: coordinate.y - placement.y,
        pointerId: event.pointerId
      };
      this.svg.setPointerCapture(event.pointerId);
      this.render();
      event.preventDefault();
      return;
    }

    if (this.selectedId) {
      this.selectedId = null;
      this.render();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.activeDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const coordinate = this.pointFrom(event);
    if (drag.kind === 'part') {
      const index = this.placements.findIndex((item) => item.id === drag.id);
      const current = this.placements[index];
      if (!current) return;
      const next = clampToPlate({
        ...current,
        x: snapMm(coordinate.x - drag.offsetX),
        y: snapMm(coordinate.y - drag.offsetY)
      }, this.plate);
      if (next.x === current.x && next.y === current.y) return;
      this.placements[index] = next;
    } else {
      const index = this.plate.rails.findIndex((item) => item.id === drag.id);
      const rail = this.plate.rails[index];
      if (!rail) return;
      const nextY = Math.min(
        Math.max(0, snapMm(drag.startRailY + coordinate.y - drag.startPointerY)),
        Math.max(0, this.plate.height - rail.height)
      );
      const delta = nextY - rail.y;
      if (delta === 0) return;
      this.plate.rails[index] = { ...rail, y: nextY };
      this.placements = this.placements.map((placement) => {
        if (placement.railId !== rail.id) return placement;
        return clampToPlate({ ...placement, y: snapMm(placement.y + delta) }, this.plate);
      });
    }
    this.dragDirty = true;
    if (this.dragRenderFrame === null) {
      this.dragRenderFrame = window.requestAnimationFrame(() => {
        this.dragRenderFrame = null;
        this.render();
      });
    }
    event.preventDefault();
  };

  private finishDrag(): void {
    const drag = this.activeDrag;
    this.activeDrag = null;
    if (this.dragRenderFrame !== null) this.render();
    if (this.dragDirty) {
      this.dragDirty = false;
      this.sync();
    }
    if (drag && this.svg.hasPointerCapture(drag.pointerId)) this.svg.releasePointerCapture(drag.pointerId);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.activeDrag || this.activeDrag.pointerId !== event.pointerId) return;
    this.onPointerMove(event);
    this.finishDrag();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.activeDrag || this.activeDrag.pointerId !== event.pointerId) return;
    this.finishDrag();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.selectedId) return;
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (!this.selectedId) return;
      event.preventDefault();
      this.rotateSelected();
    }
  };

  private readonly onWindowDragOver = (event: DragEvent): void => {
    if (!this.active) return;
    if (!this.hasPartPayload(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.viewport.classList.add('is-drop');
  };

  private readonly onWindowDragLeave = (): void => {
    this.viewport.classList.remove('is-drop');
  };

  private readonly onWindowDrop = (event: DragEvent): void => {
    const id = this.readPartPayload(event.dataTransfer);
    if (!id) return;
    if (!this.active) {
      const target = event.target;
      if (target instanceof Element && target.closest(`#${ENTRY_ID}`)) {
        event.preventDefault();
        event.stopPropagation();
        void addPartToEnclosure(id);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.viewport.classList.remove('is-drop');
    const point = this.pointFrom(event);
    const dims = this.dimsForCachedPart(id);
    const x = dims ? point.x - dims.w / 2 : point.x;
    const y = dims ? point.y - dims.h / 2 : point.y;
    void this.addPart(id, x, y);
  };

  private hasPartPayload(data: DataTransfer | null): boolean {
    if (!data) return false;
    return [...data.types].includes(PART_MIME) || [...data.types].includes('text/plain');
  }

  private readPartPayload(data: DataTransfer | null): string {
    if (!data) return '';
    return (data.getData(PART_MIME) || data.getData('text/plain') || '').trim();
  }

  private dimsForCachedPart(id: string): { w: number; h: number } | null {
    void loadEnclosureParts().then((parts) => {
      const part = parts.find((item) => partKey(item) === id || item.id === id);
      if (part?.dims) paletteParts = parts;
    }).catch(() => undefined);
    const part = paletteParts.find((item) => partKey(item) === id || item.id === id);
    return part?.dims ? { w: part.dims.w, h: part.dims.h } : null;
  }
}

function setEntryVisibility(): void {
  if (!entryElement) return;
  const activeDomain = document.querySelector<HTMLElement>('.domsw-btn.is-active')?.dataset.domain;
  const domain = document.body.dataset.domain ?? activeDomain ?? 'mech';
  entryElement.hidden = domain !== 'elec';
}

function buildOverlay(): void {
  if (overlayElement) return;
  overlayElement = document.createElement('div');
  overlayElement.id = OVERLAY_ID;
  overlayElement.className = 'enc-overlay';
  overlayElement.hidden = true;
  overlayElement.innerHTML = `
    <header class="enc-topbar">
      <div class="enc-brand">
        <div class="enc-brand-mark">${ENTRY_ICON}</div>
        <div>
          <div class="enc-brand-title">电箱底板布置</div>
          <div class="enc-brand-sub">真实毫米 · 1 mm 吸附 · 双 35 mm DIN 导轨</div>
        </div>
      </div>
      <div class="enc-top-actions">
        <span class="enc-mode-pill">电气域</span>
        <button type="button" class="enc-btn enc-btn-ghost" id="encClose">${CLOSE_ICON}<span>关闭</span></button>
      </div>
    </header>
    <main class="enc-main">
      <aside class="enc-library" aria-label="电气元件库">
        <div class="enc-lib-head"><span>电气元件</span><b id="encLibCount">0 个可布置</b></div>
        <div class="enc-lib-search"><input id="encLibSearch" type="search" placeholder="搜索型号 / 厂商 / 分类…" autocomplete="off"></div>
        <div class="enc-lib-list" id="encLibList"><div class="enc-lib-empty">打开后按需加载元件尺寸…</div></div>
        <div class="enc-lib-note">仅显示带外形尺寸（dims.w/h）的元件。拖到右侧白纸画布即可放置；导轨安装件会自动吸到最近导轨。</div>
      </aside>
      <section class="enc-stage" id="encStage"></section>
    </main>`;
  document.body.appendChild(overlayElement);
  const stage = overlayElement.querySelector<HTMLElement>('#encStage');
  if (!stage) throw new Error('底板覆盖层节点缺失：encStage');
  canvasInstance = new EnclosureCanvas(stage);
  overlayElement.querySelector('#encClose')?.addEventListener('click', closeEnclosure);
  const search = overlayElement.querySelector<HTMLInputElement>('#encLibSearch');
  search?.addEventListener('input', () => {
    paletteQuery = search.value.trim();
    renderPalette();
  });
}

function renderPalette(): void {
  if (!overlayElement) return;
  const list = overlayElement.querySelector<HTMLElement>('#encLibList');
  const count = overlayElement.querySelector<HTMLElement>('#encLibCount');
  if (!list || !count) return;
  const parts = paletteParts.filter((part) => part.dims && part.dims.w > 0 && part.dims.h > 0);
  const needle = paletteQuery.toLocaleLowerCase('zh-CN');
  const filtered = needle
    ? parts.filter((part) => [part.id, part.model, part.vendor ?? '', part.category].join(' ').toLocaleLowerCase('zh-CN').includes(needle))
    : parts;
  count.textContent = `${filtered.length} / ${parts.length} 个可布置`;
  if (filtered.length === 0) {
    list.innerHTML = `<div class="enc-lib-empty">${parts.length === 0 ? '没有带外形尺寸的电气元件。' : '没有匹配的元件。'}</div>`;
    return;
  }
  list.innerHTML = filtered.map((part) => {
    const dims = part.dims;
    if (!dims) return '';
    return `<div class="enc-lib-row" draggable="true" data-enc-lib-part="${svgText(partKey(part))}" title="拖到右侧画布">
      <div>
        <div class="enc-lib-model">${svgText(part.model)}</div>
        <div class="enc-lib-meta">${svgText(part.vendor || '未知厂商')} · ${svgText(part.category)}${part.railMount ? ' · 导轨' : ''}</div>
      </div>
      <div class="enc-lib-dims">${dims.w}×${dims.h}</div>
    </div>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('[data-enc-lib-part]').forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      const id = row.dataset.encLibPart ?? '';
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(PART_MIME, id);
      event.dataTransfer.setData('text/plain', id);
    });
    row.addEventListener('dragend', () => canvasInstance?.setActive(true));
    row.addEventListener('dblclick', () => {
      const id = row.dataset.encLibPart ?? '';
      if (id) void addPartToEnclosure(id);
    });
  });
}

async function refreshPalette(): Promise<void> {
  if (!overlayElement) return;
  const list = overlayElement.querySelector<HTMLElement>('#encLibList');
  if (list) list.innerHTML = '<div class="enc-lib-empty">正在读取电气元件包…</div>';
  try {
    paletteParts = await loadEnclosureParts();
    renderPalette();
  } catch (error) {
    if (list) list.innerHTML = `<div class="enc-lib-empty">元件库加载失败：${svgText(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

export function openEnclosure(): void {
  buildOverlay();
  if (!overlayElement) return;
  window.AutomationCadViewer?.close();
  document.querySelectorAll<HTMLElement>('.acp-drawer.is-open').forEach((drawer) => {
    drawer.hidden = true;
    drawer.classList.remove('is-open');
  });
  overlayElement.hidden = false;
  entryElement?.classList.add('is-active');
  canvasInstance?.setActive(true);
  void refreshPalette();
}

export function closeEnclosure(): void {
  if (!overlayElement) return;
  const wasOpen = !overlayElement.hidden;
  overlayElement.hidden = true;
  entryElement?.classList.remove('is-active');
  canvasInstance?.setActive(false);
  if (wasOpen) entryElement?.focus();
}

export function isEnclosureOpen(): boolean {
  return Boolean(overlayElement && !overlayElement.hidden);
}

export async function placePartInEnclosure(
  partId: string,
  x?: number,
  y?: number,
  options: EnclosurePlaceOptions = {}
): Promise<EnclosurePlaceOutcome> {
  initEnclosureUi();
  openEnclosure();
  if (!canvasInstance) {
    return { ok: false, code: 'PART_NOT_FOUND', message: '底板画布尚未就绪' };
  }
  const outcome = await canvasInstance.placePart(partId, x, y, options);
  if (outcome.ok) notify(`已放入底板：${outcome.placement.model}`, false);
  return outcome;
}

export async function addPartToEnclosure(partId: string, x?: number, y?: number): Promise<Placement | null> {
  const outcome = await placePartInEnclosure(partId, x, y);
  return outcome.ok ? outcome.placement : null;
}

export function removeEnclosurePart(placementId: string): { ok: boolean; message?: string } {
  if (!canvasInstance) return { ok: false, message: '底板画布尚未就绪' };
  if (!canvasInstance.removePlacement(placementId)) {
    return { ok: false, message: `底板元件不存在：${placementId}` };
  }
  return { ok: true };
}

export function updateEnclosurePlacement(
  placementId: string,
  patch: Partial<Placement>
): { ok: true; placement: Placement } | { ok: false; code: 'NOT_PLACED'; message: string } {
  if (!canvasInstance) return { ok: false, code: 'NOT_PLACED', message: '底板画布尚未就绪' };
  const placement = canvasInstance.updatePlacement(placementId, patch);
  if (!placement) {
    return { ok: false, code: 'NOT_PLACED', message: `底板元件不存在：${placementId}` };
  }
  return { ok: true, placement };
}

export function restoreEnclosurePlacement(placement: Placement): boolean {
  return canvasInstance?.restorePlacement(placement) ?? false;
}

export function enclosureState(): EnclosureState | null {
  return canvasInstance?.state() ?? null;
}

export function initEnclosureUi(): void {
  if (initialized) return;
  initialized = true;
  ensurePanelStyles();
  injectStyles();
  buildOverlay();

  entryElement = buildEntryButton(ENTRY_ID, '底板布置', ENTRY_ICON, openEnclosure);
  entryElement?.classList.add('enc-entry-btn');
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
    if (target instanceof Element && target.closest('#cadEntryButton')) closeEnclosure();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (isEnclosureOpen() && event.key === 'Escape') closeEnclosure();
    if (isEnclosureOpen() && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') closeEnclosure();
  }, true);

  const dropTarget = entryElement;
  if (dropTarget) {
    dropTarget.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      if ([...event.dataTransfer.types].includes(PART_MIME) || [...event.dataTransfer.types].includes('text/plain')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    dropTarget.addEventListener('drop', (event) => {
      const id = (event.dataTransfer?.getData(PART_MIME) || event.dataTransfer?.getData('text/plain') || '').trim();
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      void addPartToEnclosure(id);
    });
  }

  window.__Enclosure = {
    add: (partId: string, x?: number, y?: number) => addPartToEnclosure(partId, x, y),
    place: (partId: string, x?: number, y?: number, options?: EnclosurePlaceOptions) =>
      placePartInEnclosure(partId, x, y, options),
    remove: (placementId: string) => removeEnclosurePart(placementId),
    update: (placementId: string, patch: Partial<Placement>) => updateEnclosurePlacement(placementId, patch),
    restore: (placement: Placement) => restoreEnclosurePlacement(placement),
    state: () => enclosureState(),
    open: openEnclosure,
    close: closeEnclosure,
    clear: () => canvasInstance?.clear()
  };
}
