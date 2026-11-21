import type { Placement, PlateSpec } from '../enclosure/layout.ts';
import { DEFAULTS } from './defaults.ts';
import { parseCostPlacements } from './placements.ts';
import {
  isUsablePricebookItem,
  type Pricebook,
  type PricebookAccessories,
  type PricebookItem,
  type PricebookLabor
} from './pricebook.ts';

export { DEFAULTS } from './defaults.ts';
export type {
  Pricebook,
  PricebookAccessories,
  PricebookItem,
  PricebookLabor,
  PricebookTier
} from './pricebook.ts';

export interface CostBomRow {
  partId?: string;
  name: string;
  model?: string;
  category?: string;
  spec?: string;
  /** 结构化规格，便于直接读取「接线点数」 */
  specs?: Record<string, string | number>;
  qty: number;
  /** 每件接线点数；缺省读取 specs.接线点数，再缺省按 2 */
  terminationPoints?: number;
  /** 每件装配工时（分钟）；缺省按 DEFAULTS.assemblyMinutesPerUnit */
  assemblyMinutesPerUnit?: number;
}

export interface CostPlcSpec {
  ioPoints: number;
  modules: Array<{ partId: string; qty: number }>;
}

export interface CostOptions {
  /** 加成率，0.08 表示 8% */
  markupRate?: number;
  /** 税率，0.13 表示 13% */
  taxRate?: number;
  /** 运费，固定金额 */
  freight?: number;
}

export interface CostInput {
  bom: CostBomRow[];
  placements?: Placement[];
  plate?: PlateSpec;
  plc?: CostPlcSpec;
  /** 用户价格簿（优先于内置价格簿） */
  pricebook: Pricebook;
  /** 内置价格簿，用户价格簿未命中时回退 */
  builtinPricebook?: Pricebook;
  /** 本次报价手工改价，优先级最高 */
  overrides?: Record<string, number>;
  options?: CostOptions;
  /** 计算基准时间，便于测试价格年龄 */
  now?: Date | string | number;
  /** 线缆截面档位，缺省 2.5 */
  wireSection?: string;
}

export interface CostLine {
  partId: string;
  model: string;
  category: string;
  qty: number;
  unit: number;
  subtotal: number;
  priceSource: string;
  priceAgeDays: number;
}

export type MissingReason = 'NO_PRICE' | 'NO_PART_ID';

export interface MissingCostItem {
  name: string;
  spec?: string;
  qty: number;
  reason: MissingReason;
}

export interface CostReport {
  lines: CostLine[];
  byCategory: Array<{ category: string; subtotal: number; count: number }>;
  missing: MissingCostItem[];
  labor: { wiring: number; terminals: number; assembly: number; total: number };
  extras: { dinRail: number; duct: number; wire: number };
  totals: {
    hardware: number;
    extras: number;
    labor: number;
    subtotal: number;
    markup: number;
    tax: number;
    freight: number;
    grand: number;
  };
  warnings: string[];
}

interface InternalRow {
  partId?: string;
  name: string;
  model?: string;
  category?: string;
  spec?: string;
  specs?: Record<string, string | number>;
  qty: number;
  terminationPoints?: number;
  assemblyMinutesPerUnit?: number;
}

interface PriceHit {
  item: PricebookItem;
  book: Pricebook;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 金额统一保留两位小数，避免浮点尾差进入报告。 */
export function roundMoney(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(rounded)) throw new Error('成本金额不是有限数');
  return rounded;
}

function resolveNow(now: Date | string | number | undefined): number {
  if (now === undefined) return Date.now();
  const value = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error('当前时间不合法');
  return value;
}

/** 价格年龄（自然日向下取整）；未来日期按 0 天处理。 */
export function priceAgeDays(
  updatedAt: string,
  now: Date | string | number = new Date()
): number {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) throw new Error(`价格日期不合法：${updatedAt}`);
  const days = Math.floor((resolveNow(now) - updated) / DAY_MS);
  return days > 0 ? days : 0;
}

/** 按数量取满足条件的最高 minQty；没有命中阶梯时回落到 list。 */
export function pickTierPrice(item: PricebookItem, qty: number): number {
  let best: { minQty: number; price: number } | undefined;
  for (const tier of item.tiers ?? []) {
    if (qty >= tier.minQty && (best === undefined || tier.minQty > best.minQty)) best = tier;
  }
  return best ? best.price : item.list;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function normalizeSpecs(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | number> = {};
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec === 'string' || typeof spec === 'number') result[key] = spec;
  }
  return result;
}

function normalizeBom(input: CostInput): InternalRow[] {
  if (!Array.isArray(input.bom)) throw new Error('BOM 必须是数组');
  const rows: InternalRow[] = [];
  for (let index = 0; index < input.bom.length; index += 1) {
    const raw = input.bom[index] as unknown;
    if (!isRecord(raw)) throw new Error(`BOM 第 ${index + 1} 行必须是对象`);
    const qty = raw.qty;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
      throw new Error(`BOM 第 ${index + 1} 行数量必须是正整数`);
    }
    const row: InternalRow = {
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : '未命名物料',
      qty
    };
    if (typeof raw.partId === 'string') row.partId = raw.partId;
    if (typeof raw.model === 'string' && raw.model !== '') row.model = raw.model;
    if (typeof raw.category === 'string' && raw.category !== '') row.category = raw.category;
    if (typeof raw.spec === 'string' && raw.spec !== '') row.spec = raw.spec;
    const specs = normalizeSpecs(raw.specs);
    if (specs !== undefined) row.specs = specs;
    const points = parseOptionalNumber(raw.terminationPoints);
    if (points !== undefined) row.terminationPoints = points;
    const minutes = parseOptionalNumber(raw.assemblyMinutesPerUnit);
    if (minutes !== undefined) row.assemblyMinutesPerUnit = minutes;
    rows.push(row);
  }

  if (input.plc !== undefined) {
    if (!isRecord(input.plc) || !Array.isArray(input.plc.modules)) {
      throw new Error('PLC 配置.modules 必须是数组');
    }
    for (let index = 0; index < input.plc.modules.length; index += 1) {
      const module = input.plc.modules[index];
      if (!isRecord(module)) throw new Error(`PLC 模块第 ${index + 1} 行必须是对象`);
      const qty = module.qty;
      if (typeof qty !== 'number' || !Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
        throw new Error(`PLC 模块第 ${index + 1} 行数量必须是正整数`);
      }
      const partId = typeof module.partId === 'string' ? module.partId : '';
      rows.push({
        partId,
        name: partId.trim() === '' ? `PLC 模块 ${index + 1}` : `PLC 模块 ${partId}`,
        category: 'PLC',
        qty
      });
    }
  }
  return rows;
}

function findInBook(book: Pricebook | undefined, partId: string): PricebookItem | undefined {
  if (!book || !isRecord(book.items)) return undefined;
  const item = ownValue(book.items, partId);
  return item && isUsablePricebookItem(item) ? item : undefined;
}

function findPrice(input: CostInput, partId: string): PriceHit | undefined {
  const userItem = findInBook(input.pricebook, partId);
  if (userItem) return { item: userItem, book: input.pricebook };
  if (input.builtinPricebook) {
    const builtinItem = findInBook(input.builtinPricebook, partId);
    if (builtinItem) return { item: builtinItem, book: input.builtinPricebook };
  }
  return undefined;
}

function terminationPointsFor(row: InternalRow): number {
  const explicit = parseOptionalNumber(row.terminationPoints);
  if (explicit !== undefined) return explicit;
  const fromSpecs = parseOptionalNumber(row.specs?.['接线点数']);
  if (fromSpecs !== undefined) return fromSpecs;
  const match = row.spec?.match(/接线点数\s*[:：=]?\s*(\d+(?:\.\d+)?)/);
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULTS.defaultTerminationPoints;
}

function assemblyMinutesFor(row: InternalRow): number {
  return parseOptionalNumber(row.assemblyMinutesPerUnit) ?? DEFAULTS.assemblyMinutesPerUnit;
}

/** 相邻布置元件中心点的曼哈顿距离 × 折损系数，单根最少 0.3 m。 */
export function estimateCableMeters(placements: readonly Placement[]): number {
  const checked = parseCostPlacements(placements, 'normalized');
  let meters = 0;
  for (let index = 1; index < checked.length; index += 1) {
    const previous = checked[index - 1]!;
    const current = checked[index]!;
    const dx = current.x + current.w / 2 - (previous.x + previous.w / 2);
    const dy = current.y + current.h / 2 - (previous.y + previous.h / 2);
    const distanceMm = Math.abs(dx) + Math.abs(dy);
    meters += Math.max(DEFAULTS.minCableMeters, (distanceMm * DEFAULTS.cableWasteFactor) / 1000);
  }
  return Number(meters.toFixed(6));
}

/** 导轨总长：rails 数量 × 底板宽；未提供 rails 时默认 2 根。 */
export function estimateDinRailMeters(plate: PlateSpec | undefined): number {
  if (!plate) return 0;
  const width = nonNegative(plate.width, 0);
  const count = Array.isArray(plate.rails) && plate.rails.length > 0
    ? plate.rails.length
    : DEFAULTS.defaultRailCount;
  return (width * count) / 1000;
}

/** 线槽按底板周长估算。 */
export function estimateDuctMeters(plate: PlateSpec | undefined): number {
  if (!plate) return 0;
  const width = nonNegative(plate.width, 0);
  const height = nonNegative(plate.height, 0);
  return ((width + height) * 2) / 1000;
}

function laborRates(book: Pricebook): PricebookLabor {
  const raw = book.labor as PricebookLabor | undefined;
  return {
    panelWiringPerPoint: nonNegative(raw?.panelWiringPerPoint, DEFAULTS.labor.panelWiringPerPoint),
    terminalPerWire: nonNegative(raw?.terminalPerWire, DEFAULTS.labor.terminalPerWire),
    assemblyHourly: nonNegative(raw?.assemblyHourly, DEFAULTS.labor.assemblyHourly)
  };
}

function accessoryRates(book: Pricebook): PricebookAccessories {
  const raw = book.accessories as PricebookAccessories | undefined;
  const wirePerMeter: Record<string, number> = { ...DEFAULTS.accessories.wirePerMeter };
  if (isRecord(raw?.wirePerMeter)) {
    for (const [section, price] of Object.entries(raw.wirePerMeter)) {
      if (typeof price === 'number' && Number.isFinite(price) && price >= 0) wirePerMeter[section] = price;
    }
  }
  return {
    dinRail35PerMeter: nonNegative(raw?.dinRail35PerMeter, DEFAULTS.accessories.dinRail35PerMeter),
    wireDuctPerMeter: nonNegative(raw?.wireDuctPerMeter, DEFAULTS.accessories.wireDuctPerMeter),
    wirePerMeter
  };
}

function categoryOf(row: InternalRow, item: PricebookItem | undefined): string {
  if (row.category) return row.category;
  if (item?.category) return item.category;
  return '未分类';
}

/**
 * 计算整机硬件成本。
 *
 * 价格优先级：本次 overrides > 用户价格簿 > 内置价格簿 > 缺价。
 * 加成、税、运费只进入 totals，不改变任何单行价格。
 */
export function computeCost(input: CostInput): CostReport {
  if (!input || typeof input !== 'object') throw new Error('成本输入必须是对象');
  if (!input.pricebook || typeof input.pricebook !== 'object') {
    throw new Error('缺少必填参数：价格簿');
  }

  const rows = normalizeBom(input);
  const nowMs = resolveNow(input.now);
  const lines: CostLine[] = [];
  const missing: MissingCostItem[] = [];
  const warningList: string[] = [];
  let terminationPoints = 0;
  let assemblyMinutes = 0;

  for (const row of rows) {
    terminationPoints += terminationPointsFor(row) * row.qty;
    assemblyMinutes += assemblyMinutesFor(row) * row.qty;

    const partId = row.partId?.trim() ?? '';
    if (partId === '') {
      const item: MissingCostItem = { name: row.name, qty: row.qty, reason: 'NO_PART_ID' };
      if (row.spec) item.spec = row.spec;
      missing.push(item);
      warningList.push(`缺价：${row.name}（NO_PART_ID，无 partId）`);
      continue;
    }

    const override = ownValue(input.overrides, partId);
    if (override !== undefined) {
      if (typeof override !== 'number' || !Number.isFinite(override) || override < 0) {
        throw new Error(`项目覆盖价必须是非负有限数：${partId}`);
      }
      lines.push({
        partId,
        model: row.model ?? row.name,
        category: categoryOf(row, undefined),
        qty: row.qty,
        unit: override,
        subtotal: roundMoney(override * row.qty),
        priceSource: '项目覆盖',
        priceAgeDays: 0
      });
      continue;
    }

    const hit = findPrice(input, partId);
    if (!hit) {
      const item: MissingCostItem = { name: row.name, qty: row.qty, reason: 'NO_PRICE' };
      if (row.spec) item.spec = row.spec;
      missing.push(item);
      warningList.push(`缺价：${row.name}（NO_PRICE）`);
      continue;
    }

    const unit = pickTierPrice(hit.item, row.qty);
    const ageDays = priceAgeDays(hit.item.updatedAt ?? hit.book.updatedAt, nowMs);
    if (ageDays > DEFAULTS.priceMaxAgeDays) {
      warningList.push(`价格过期：${partId}（${ageDays} 天）`);
    }
    lines.push({
      partId,
      model: row.model ?? hit.item.model ?? row.name,
      category: categoryOf(row, hit.item),
      qty: row.qty,
      unit,
      subtotal: roundMoney(unit * row.qty),
      priceSource: hit.item.source ?? hit.book.source,
      priceAgeDays: ageDays
    });
  }

  const rates = laborRates(input.pricebook);
  const savings = accessoryRates(input.pricebook);
  const wiring = roundMoney(terminationPoints * rates.panelWiringPerPoint);
  const terminals = roundMoney(terminationPoints * rates.terminalPerWire);
  const assembly = roundMoney((assemblyMinutes / 60) * rates.assemblyHourly);
  const laborTotal = roundMoney(wiring + terminals + assembly);

  const wireSection = input.wireSection ?? DEFAULTS.defaultWireSection;
  const cableMeters = estimateCableMeters(input.placements ?? []);
  const wireRate = savings.wirePerMeter[wireSection] ?? 0;
  const wire = roundMoney(cableMeters * wireRate);
  const dinRail = roundMoney(estimateDinRailMeters(input.plate) * savings.dinRail35PerMeter);
  const duct = roundMoney(estimateDuctMeters(input.plate) * savings.wireDuctPerMeter);
  if (rows.length > 0 && (input.placements?.length ?? 0) < 2) {
    warningList.push('无布置数据，无法估算线缆');
  }

  const categoryMap = new Map<string, { subtotal: number; count: number }>();
  for (const line of lines) {
    const entry = categoryMap.get(line.category) ?? { subtotal: 0, count: 0 };
    entry.subtotal += line.subtotal;
    entry.count += 1;
    categoryMap.set(line.category, entry);
  }
  const byCategory = [...categoryMap.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([category, entry]) => ({
      category,
      subtotal: roundMoney(entry.subtotal),
      count: entry.count
    }));

  const hardware = roundMoney(lines.reduce((sum, line) => sum + line.subtotal, 0));
  const extras = roundMoney(dinRail + duct + wire);
  const subtotal = roundMoney(hardware + extras + laborTotal);

  const options = input.options ?? {};
  const markupRate = options.markupRate ?? 0;
  const taxRate = options.taxRate ?? 0;
  const freightValue = options.freight ?? 0;
  for (const [name, value] of [
    ['markupRate', markupRate],
    ['taxRate', taxRate],
    ['freight', freightValue]
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} 必须是非负有限数`);
    }
  }
  const markup = roundMoney(subtotal * markupRate);
  const tax = roundMoney((subtotal + markup) * taxRate);
  const freight = roundMoney(freightValue);
  const grand = roundMoney(subtotal + markup + tax + freight);

  return {
    lines,
    byCategory,
    missing,
    labor: { wiring, terminals, assembly, total: laborTotal },
    extras: { dinRail, duct, wire },
    totals: {
      hardware,
      extras,
      labor: laborTotal,
      subtotal,
      markup,
      tax,
      freight,
      grand
    },
    warnings: [...new Set(warningList)]
  };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `computeCost`。 */
export const calculateCost = computeCost;
/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `computeCost`。 */
export const runCostReport = computeCost;
