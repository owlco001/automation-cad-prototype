// 方案阶段成本粗估：机械件 + 电气件 + 人工/调试。
//
// 与 `cost/engine.ts` 的分工：
// - 本文件面向「刚合成出来的机型方案」，BOM 可能只有型号或待选型，允许缺价；
// - 这里不含报价加成、税率、运费、线缆/线槽长度与端子接线工时；
// - 正式报价仍应走 `cost/engine.ts` 的价格簿、阶梯价、缺价清单与导出流程。
// 因此 total 只能用于方案比较，不是对外报价。

import type { ComponentPart } from '../shared/types.ts';
import {
  isUsablePricebookItem,
  isStalePricebookItem,
  type Pricebook,
  type PricebookItem
} from '../cost/pricebook.ts';

export type MachinePowerRole =
  | 'servo'
  | 'cylinder'
  | 'gripper'
  | 'rotary'
  /** 输送线驱动电机（减速电机）：传动件，成本口径按机械件。 */
  | 'drive'
  | 'sensor'
  | 'safety'
  | 'plc'
  | 'psu'
  | 'valve'
  | 'other';

export interface MachinePricing {
  power: {
    simultaneity: number;
    loadFactor: number;
    efficiency: number;
    cosPhi: number;
  };
  labor: {
    ratePerHour: number;
    mechanicalHoursPerStation: number;
    electricalHoursPerStation: number;
    debugHoursPerStation: number;
  };
}

export const DEFAULT_MACHINE_PRICING: MachinePricing = {
  power: {
    simultaneity: 0.7,
    loadFactor: 0.6,
    efficiency: 0.9,
    cosPhi: 0.9
  },
  labor: {
    ratePerHour: 120,
    mechanicalHoursPerStation: 8,
    electricalHoursPerStation: 6,
    debugHoursPerStation: 4
  }
};

export const MACHINE_PRICING_FILE = 'machine-pricing.json';
export const MACHINE_PRICING_DEFAULT_NOTE = '工程默认值，非官方报价';

/**
 * 「未读取到用户参数文件」时的统一说明。UI 方案卡与 Agent 工具必须产出完全相同的
 * 文案，否则同一 brief 的两条路径会得到不同的 assumptions（一致性测试会红）。
 */
export function defaultPricingAssumptions(providedUserDir: boolean): string[] {
  return [
    providedUserDir
      ? '未找到 machine-pricing.json，功率系数与工时单价使用默认值。'
      : '未提供用户数据目录，功率系数与工时单价使用默认值。',
    `默认系数：Ks=${DEFAULT_MACHINE_PRICING.power.simultaneity}、Kf=${DEFAULT_MACHINE_PRICING.power.loadFactor}、` +
      `η=${DEFAULT_MACHINE_PRICING.power.efficiency}、cosφ=${DEFAULT_MACHINE_PRICING.power.cosPhi}；` +
      `工时单价 ${DEFAULT_MACHINE_PRICING.labor.ratePerHour} 元/h（${MACHINE_PRICING_DEFAULT_NOTE}）。`
  ];
}

export interface MachinePricingLoad {
  pricing: MachinePricing;
  source: 'file' | 'defaults';
  path: string;
  assumptions: string[];
  warnings: string[];
}

const FORM_LAYOUT_FACTOR: Record<string, number> = {
  single: 1,
  linear: 1.1,
  dial: 1.15,
  parallel: 1.05,
  cell: 1.2
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fraction(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

/** 解析参数文件；非法值逐项回退默认值并给 warning，不因一个字段失败整份文件。 */
export function parseMachinePricing(value: unknown): {
  pricing: MachinePricing;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = isRecord(value) ? value : {};
  if (!isRecord(value)) warnings.push('machine-pricing.json 顶层必须是对象，已全部回落默认值。');
  const power = isRecord(root.power) ? root.power : {};
  const labor = isRecord(root.labor) ? root.labor : {};
  const pick = (record: Record<string, unknown>, key: string, fallback: number, kind: 'positive' | 'fraction'): number => {
    const raw = record[key];
    if (raw === undefined) return fallback;
    const parsed = kind === 'fraction' ? fraction(raw, Number.NaN) : positive(raw, Number.NaN);
    if (!Number.isFinite(parsed)) {
      warnings.push(`machine-pricing.json 的 ${key} 非法（需要 ${kind === 'fraction' ? '0–1' : '正数'}），已回落默认 ${fallback}。`);
      return fallback;
    }
    return parsed;
  };
  const pricing: MachinePricing = {
    power: {
      simultaneity: pick(power, 'simultaneity', DEFAULT_MACHINE_PRICING.power.simultaneity, 'fraction'),
      loadFactor: pick(power, 'loadFactor', DEFAULT_MACHINE_PRICING.power.loadFactor, 'fraction'),
      efficiency: pick(power, 'efficiency', DEFAULT_MACHINE_PRICING.power.efficiency, 'fraction'),
      cosPhi: pick(power, 'cosPhi', DEFAULT_MACHINE_PRICING.power.cosPhi, 'fraction')
    },
    labor: {
      ratePerHour: pick(labor, 'ratePerHour', DEFAULT_MACHINE_PRICING.labor.ratePerHour, 'positive'),
      mechanicalHoursPerStation: pick(
        labor,
        'mechanicalHoursPerStation',
        DEFAULT_MACHINE_PRICING.labor.mechanicalHoursPerStation,
        'positive'
      ),
      electricalHoursPerStation: pick(
        labor,
        'electricalHoursPerStation',
        DEFAULT_MACHINE_PRICING.labor.electricalHoursPerStation,
        'positive'
      ),
      debugHoursPerStation: pick(
        labor,
        'debugHoursPerStation',
        DEFAULT_MACHINE_PRICING.labor.debugHoursPerStation,
        'positive'
      )
    }
  };
  return { pricing, warnings };
}

export interface CostBomItemLike {
  kind: 'actuator' | 'sensor' | 'electrical';
  name: string;
  model?: string;
  qty: number;
  partId?: string;
  packId?: string;
  note?: string;
  pendingSelection?: boolean;
  role?: MachinePowerRole;
}

export interface CostDesignSource {
  config: {
    stations?: readonly unknown[];
    actuators?: readonly unknown[];
    sensors?: readonly unknown[];
  };
  form?: { id?: string; name?: string; layout?: string };
  bomDraft?: { items?: readonly CostBomItemLike[] };
}

export interface CostEstimateOptions {
  parts?: readonly ComponentPart[];
  pricebook?: Pricebook;
  builtinPricebook?: Pricebook;
  pricing?: MachinePricing;
  /** 参数文件/默认值来源说明，原样并入 assumptions。 */
  pricingAssumptions?: readonly string[];
  /** 强制覆盖工位数（缺省取 config.stations.length）。 */
  stationCount?: number;
  /** 价格过期判定基准；缺省当前时间。 */
  now?: Date | string | number;
}

export interface CostEstimateLine {
  name: string;
  model?: string;
  partId?: string;
  category: '机械件' | '电气件';
  qty: number;
  unit: number;
  subtotal: number;
  priceSource: '价格簿' | '元件库参考价' | '缺失' | '伺服配套补齐';
}

export interface CostPriceMetaItem {
  partId?: string;
  name: string;
}

export interface CostPriceMetaStale extends CostPriceMetaItem {
  checkedAt: string;
}

export interface CostPriceMeta {
  coveragePct: number;
  pricedCount: number;
  totalCount: number;
  missing: CostPriceMetaItem[];
  stale: CostPriceMetaStale[];
  unknownSource: CostPriceMetaItem[];
}

export interface MachineCostEstimate {
  material: number;
  electrical: number;
  labor: number;
  total: number;
  missingCount: number;
  priceMeta: CostPriceMeta;
  byCategory: Array<{ category: '机械件' | '电气件'; subtotal: number; count: number; missing: number }>;
  assumptions: string[];
  warnings: string[];
  lines: CostEstimateLine[];
  laborDetail: {
    stations: number;
    hourlyRate: number;
    hoursPerStation: number;
    formFactor: number;
    hours: number;
  };
  /** 与正式报价引擎的边界说明。 */
  boundary: string;
}

const SERVO_DRIVE_ID = 'SV660PS5R5I';
const SERVO_MOTOR_ID = 'MS1H1-75B30CB';
const SERVO_DRIVE_PACK = 'iec-cn';
const SERVO_MOTOR_PACK = 'iec-cn';

const ELECTRICAL_NAME = /伺服|PLC|电源|断路器|继电器|光栅|传感器|电磁阀|按钮|端子|接触器|变频器|编码器/;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isElectrical(item: CostBomItemLike): boolean {
  if (item.kind === 'electrical' || item.kind === 'sensor') return true;
  if (item.role && ['servo', 'sensor', 'safety', 'plc', 'psu', 'valve'].includes(item.role)) return true;
  return ELECTRICAL_NAME.test(item.name);
}

function findPart(
  parts: readonly ComponentPart[] | undefined,
  id: string | undefined,
  packId?: string
): ComponentPart | undefined {
  if (!parts || !id) return undefined;
  return parts.find((part) => part.id === id && (packId === undefined || part.packId === packId));
}

function pickTier(item: PricebookItem, qty: number): number {
  let best: PricebookItem['tiers'] extends readonly (infer T)[] | undefined ? T | undefined : never;
  for (const tier of item.tiers ?? []) {
    if (qty >= tier.minQty && (!best || tier.minQty > best.minQty)) best = tier;
  }
  return best ? best.price : item.list;
}

function priceFromBook(
  book: Pricebook | undefined,
  partId: string | undefined,
  qty: number
): { unit: number; item: PricebookItem } | null {
  if (!book || !partId) return null;
  const item = book.items[partId];
  if (!item || !isUsablePricebookItem(item)) return null;
  return { unit: pickTier(item, qty), item };
}

function priceFor(
  item: CostBomItemLike,
  parts: readonly ComponentPart[] | undefined,
  pricebook: Pricebook | undefined,
  builtinPricebook: Pricebook | undefined
): { unit: number | null; source: CostEstimateLine['priceSource']; item?: PricebookItem } {
  const fromUser = priceFromBook(pricebook, item.partId, item.qty);
  if (fromUser !== null) return { unit: fromUser.unit, source: '价格簿', item: fromUser.item };
  const fromBuiltin = priceFromBook(builtinPricebook, item.partId, item.qty);
  if (fromBuiltin !== null) return { unit: fromBuiltin.unit, source: '价格簿', item: fromBuiltin.item };
  const part = findPart(parts, item.partId, item.packId);
  if (part && typeof part.price === 'number' && Number.isFinite(part.price) && part.price >= 0) {
    return { unit: part.price, source: '元件库参考价' };
  }
  return { unit: null, source: '缺失' };
}

function servoPairItems(items: readonly CostBomItemLike[]): CostBomItemLike[] {
  const drive = items.find((item) => /伺服驱动器/.test(item.name));
  const motor = items.find((item) => /伺服电机/.test(item.name));
  if (!drive && !motor) return items as CostBomItemLike[];
  const result = [...items];
  if (!drive && motor) {
    result.push({
      kind: 'actuator',
      name: '伺服驱动器',
      qty: motor.qty,
      partId: SERVO_DRIVE_ID,
      packId: SERVO_DRIVE_PACK,
      role: 'servo',
      note: '伺服按驱动器 + 电机成对计价，方案未列驱动器时自动补齐'
    });
  }
  if (!motor && drive) {
    result.push({
      kind: 'actuator',
      name: '伺服电机',
      qty: drive.qty,
      partId: SERVO_MOTOR_ID,
      packId: SERVO_MOTOR_PACK,
      role: 'servo',
      note: '伺服按驱动器 + 电机成对计价，方案未列电机时自动补齐'
    });
  }
  return result;
}

/**
 * 方案阶段成本粗估。缺价行不猜价格，只计入 missingCount；伺服缺少驱动器或
 * 电机时按同数量补齐另一件，避免「成对设备只报一半」。
 */
export function estimateCost(
  design: CostDesignSource,
  options: CostEstimateOptions = {}
): MachineCostEstimate {
  const pricing = options.pricing ?? DEFAULT_MACHINE_PRICING;
  const now = options.now ?? new Date();
  const items = servoPairItems(design.bomDraft?.items ?? []);
  const lines: CostEstimateLine[] = [];
  const missingNames: string[] = [];
  const missingMeta: CostPriceMeta['missing'] = [];
  const staleMeta: CostPriceMeta['stale'] = [];
  const unknownSourceMeta: CostPriceMeta['unknownSource'] = [];
  const byCategory = new Map<'机械件' | '电气件', { subtotal: number; count: number; missing: number }>();

  for (const item of items) {
    const category: '机械件' | '电气件' = isElectrical(item) ? '电气件' : '机械件';
    const bucket = byCategory.get(category) ?? { subtotal: 0, count: 0, missing: 0 };
    bucket.count += 1;
    const price = priceFor(item, options.parts, options.pricebook, options.builtinPricebook);
    if (price.unit === null) {
      bucket.missing += 1;
      missingNames.push(`${item.name}${item.model ? `（${item.model}）` : ''} × ${item.qty}`);
      missingMeta.push({
        ...(item.partId ? { partId: item.partId } : {}),
        name: item.name
      });
      lines.push({
        name: item.name,
        ...(item.model ? { model: item.model } : {}),
        ...(item.partId ? { partId: item.partId } : {}),
        category,
        qty: item.qty,
        unit: 0,
        subtotal: 0,
        priceSource: '缺失'
      });
    } else {
      const subtotal = roundMoney(price.unit * item.qty);
      bucket.subtotal = roundMoney(bucket.subtotal + subtotal);
      if (price.item) {
        const meta = {
          ...(item.partId ? { partId: item.partId } : {}),
          name: item.name
        };
        if (!price.item.sourceType || !price.item.checkedAt) {
          unknownSourceMeta.push(meta);
        } else if (isStalePricebookItem(price.item, now)) {
          staleMeta.push({ ...meta, checkedAt: price.item.checkedAt });
        }
      }
      lines.push({
        name: item.name,
        ...(item.model ? { model: item.model } : {}),
        ...(item.partId ? { partId: item.partId } : {}),
        category,
        qty: item.qty,
        unit: roundMoney(price.unit),
        subtotal,
        priceSource: price.source
      });
    }
    byCategory.set(category, bucket);
  }

  const material = byCategory.get('机械件')?.subtotal ?? 0;
  const electrical = byCategory.get('电气件')?.subtotal ?? 0;
  const stations = options.stationCount
    ?? (Array.isArray(design.config.stations) ? design.config.stations.length : 0);
  const layout = design.form?.layout ?? 'linear';
  const formFactor = FORM_LAYOUT_FACTOR[layout] ?? 1;
  const hoursPerStation =
    pricing.labor.mechanicalHoursPerStation +
    pricing.labor.electricalHoursPerStation +
    pricing.labor.debugHoursPerStation;
  const hours = stations * hoursPerStation * formFactor;
  const labor = roundMoney(hours * pricing.labor.ratePerHour);
  const missingCount = lines.filter((line) => line.priceSource === '缺失').length;
  const totalCount = lines.length;
  const pricedCount = totalCount - missingCount;
  const priceMeta: CostPriceMeta = {
    coveragePct: totalCount === 0 ? 0 : Math.round((pricedCount / totalCount) * 1000) / 10,
    pricedCount,
    totalCount,
    missing: missingMeta,
    stale: staleMeta,
    unknownSource: unknownSourceMeta
  };
  const total = roundMoney(material + electrical + labor);
  const assumptions = [
    '方案阶段粗估：用于方案比较与预算区间，不替代正式报价。',
    '机械件 = 价格簿单价 × 数量；价格簿未命中时使用元件库参考价，仍无价则计入缺价。',
    '电气件 = 元件库/价格簿单价 × 数量；伺服按驱动器 + 电机成对计价，缺一件时按同数量补齐。',
    `人工/调试 = ${stations} 工位 × (机械 ${pricing.labor.mechanicalHoursPerStation} h + ` +
    `电气 ${pricing.labor.electricalHoursPerStation} h + 调试 ${pricing.labor.debugHoursPerStation} h) ` +
    `× 形态系数 ${formFactor}（${layout}）× ${pricing.labor.ratePerHour} 元/h = ${labor} 元。`,
    '缺价行不猜价格、不计入合计；missingCount 为缺价 BOM 行数，需补价格簿或询价。',
    ...(options.pricingAssumptions ?? [])
  ];
  const warnings: string[] = [];
  if (missingCount > 0) {
    warnings.push(`有 ${missingCount} 行缺价，未计入合计：${missingNames.join('；')}`);
  }
  if (staleMeta.length > 0) {
    warnings.push(`有 ${staleMeta.length} 行价格超过 180 天，可能已过期：${staleMeta
      .map((entry) => `${entry.name}（${entry.checkedAt}）`)
      .join('；')}`);
  }
  if (unknownSourceMeta.length > 0) {
    warnings.push(`有 ${unknownSourceMeta.length} 行价格来源不明（旧版价格簿缺少 sourceType/checkedAt）：${unknownSourceMeta
      .map((entry) => entry.name)
      .join('；')}`);
  }
  if (options.pricebook === undefined && options.builtinPricebook === undefined) {
    warnings.push('未提供价格簿，本次仅使用元件库参考价，其余行均计为缺价。');
  }
  if (stations <= 0) warnings.push('方案没有工位数，人工/调试估算为 0。');

  return {
    material,
    electrical,
    labor,
    total,
    missingCount,
    priceMeta,
    byCategory: (['机械件', '电气件'] as const).map((category) => ({
      category,
      subtotal: byCategory.get(category)?.subtotal ?? 0,
      count: byCategory.get(category)?.count ?? 0,
      missing: byCategory.get(category)?.missing ?? 0
    })),
    assumptions,
    warnings,
    lines,
    laborDetail: { stations, hourlyRate: pricing.labor.ratePerHour, hoursPerStation, formFactor, hours },
    boundary:
      '方案阶段粗估：不含报价加成、税率、运费、线缆/线槽与端子接线工时，' +
      '不替代 cost/engine.ts 的正式报价计算。'
  };
}
