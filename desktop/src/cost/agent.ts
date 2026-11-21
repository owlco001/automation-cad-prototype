/**
 * 成本估算的 Agent 入口（只读）。
 *
 * 面板（`ui.ts`）与这里共用同一份 `computeCost`，区别只在数据来源：
 * - 面板：导入文件 / 注入 provider / 内置价格簿；
 * - Agent：工具入参（bom、pricebook、placements…）+ 主进程注入的内置价格簿 + 当前场景 BOM。
 *
 * 输出刻意做「窄」：明细最多 50 行、缺价与告警各 20 条，其余只给数量，避免把整份报告塞进模型上下文。
 */
import type { Placement, PlateSpec } from '../enclosure/layout.ts';
import { parseCostPlacements } from './placements.ts';
import {
  computeCost,
  type CostBomRow,
  type CostInput,
  type CostOptions,
  type CostPlcSpec,
  type CostReport
} from './engine.ts';
import { isUsablePricebookItem, validatePricebook, type Pricebook } from './pricebook.ts';
import { describeCost } from './report.ts';

/** 公共工具名常量：保留对外导出，避免外部脚本引用断裂；注册处仍使用同名字面量。 */
export const COST_TOOL_NAME = 'run_cost_report';

/** 输出上限：明细 / 缺价 / 告警各截断到这里。 */
export const COST_TOOL_LINE_LIMIT = 50;
export const COST_TOOL_ISSUE_LIMIT = 20;

export interface CostToolDeps {
  /** 主进程注入的内置价格簿读取器；返回原始 JSON 或已校验对象 */
  loadBuiltinPricebook?: () => unknown;
  /** 未显式传 bom 时使用的当前场景 BOM（渲染层 getBom 的原始行） */
  sceneBom?: unknown;
}

export interface CostToolPricebookMeta {
  label: string;
  currency: string;
  updatedAt: string;
  source: string;
  usableItems: number;
  exampleItems: number;
}

export interface CostToolResult {
  ok: true;
  bomSource: 'argument' | 'scene';
  bomRows: number;
  pricebook: CostToolPricebookMeta;
  totals: CostReport['totals'];
  labor: CostReport['labor'];
  extras: CostReport['extras'];
  byCategory: CostReport['byCategory'];
  counts: { lines: number; missing: number; warnings: number };
  lines: CostReport['lines'];
  missing: CostReport['missing'];
  warnings: string[];
  truncated: boolean;
  notes: string[];
  summary: string;
}

export class CostToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CostToolError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new CostToolError(code, message);
}

function numberAt(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_ARGUMENT', `${path} 必须是数字`);
  }
  return value;
}

function textAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 入参校验：把 JSON 里的松散对象收成引擎能吃的结构，错误信息带行号便于模型自查。 */
function parseBom(value: unknown): CostBomRow[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail('INVALID_ARGUMENT', 'bom 必须是数组');
  if (value.length === 0) fail('NO_BOM', 'bom 为空：没有可计算的物料');
  return value.map((raw, index) => {
    if (!isRecord(raw)) fail('INVALID_ARGUMENT', `bom[${index}] 必须是对象`);
    const row: CostBomRow = {
      name: textAt(raw, 'name') ?? `未命名物料（bom[${index}]）`,
      qty: 1
    };
    const partId = textAt(raw, 'partId');
    if (partId !== undefined) row.partId = partId;
    const model = textAt(raw, 'model');
    if (model !== undefined) row.model = model;
    const category = textAt(raw, 'category');
    if (category !== undefined) row.category = category;
    const spec = textAt(raw, 'spec');
    if (spec !== undefined) row.spec = spec;
    const qty = numberAt(raw, 'qty', `bom[${index}].qty`);
    if (qty === undefined) {
      fail('INVALID_ARGUMENT', `缺少必填参数：bom[${index}].qty`);
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      fail('INVALID_ARGUMENT', `bom[${index}].qty 必须是正整数`);
    }
    row.qty = qty;
    const points = numberAt(raw, 'terminationPoints', `bom[${index}].terminationPoints`);
    if (points !== undefined) row.terminationPoints = points;
    const minutes = numberAt(raw, 'assemblyMinutesPerUnit', `bom[${index}].assemblyMinutesPerUnit`);
    if (minutes !== undefined) row.assemblyMinutesPerUnit = minutes;
    if (raw.specs !== undefined && raw.specs !== null) {
      if (!isRecord(raw.specs)) fail('INVALID_ARGUMENT', `bom[${index}].specs 必须是对象`);
      const specs: Record<string, string | number> = {};
      for (const [key, item] of Object.entries(raw.specs)) {
        if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
          specs[key] = item;
        }
      }
      row.specs = specs;
    }
    return row;
  });
}

/** 当前场景的简化 BOM（{no,name,spec,qty,mat}）→ 成本行；没有 partId，引擎会如实计入「缺物料号」。 */
export function costRowsFromSceneBom(value: unknown): CostBomRow[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const rows: CostBomRow[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) continue;
    const name = textAt(raw, 'name') ?? `未命名零件（第 ${index + 1} 行）`;
    const qtyValue = raw.qty;
    const qty = typeof qtyValue === 'number' && Number.isFinite(qtyValue) && qtyValue > 0
      ? Math.max(1, Math.round(qtyValue))
      : 1;
    const row: CostBomRow = { name, qty };
    const spec = textAt(raw, 'spec');
    if (spec !== undefined) row.spec = spec;
    const partId = textAt(raw, 'partId');
    if (partId !== undefined) row.partId = partId;
    rows.push(row);
  }
  return rows.length > 0 ? rows : undefined;
}

function parsePlacements(value: unknown): Placement[] | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return parseCostPlacements(value, 'point');
  } catch (error) {
    fail('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
  }
}

function parsePlate(value: unknown): PlateSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail('INVALID_ARGUMENT', 'plate 必须是对象');
  const width = numberAt(value, 'width', 'plate.width');
  const height = numberAt(value, 'height', 'plate.height');
  if (width === undefined || height === undefined) {
    fail('INVALID_ARGUMENT', 'plate 需要 width / height（毫米）');
  }
  if (width <= 0 || height <= 0) fail('INVALID_ARGUMENT', 'plate 的 width / height 必须大于 0');
  const rails: PlateSpec['rails'] = [];
  if (value.rails !== undefined && value.rails !== null) {
    if (!Array.isArray(value.rails)) fail('INVALID_ARGUMENT', 'plate.rails 必须是数组');
    for (const [index, raw] of value.rails.entries()) {
      if (!isRecord(raw)) fail('INVALID_ARGUMENT', `plate.rails[${index}] 必须是对象`);
      rails.push({
        id: textAt(raw, 'id') ?? `r${index + 1}`,
        y: numberAt(raw, 'y', `plate.rails[${index}].y`) ?? 0,
        height: numberAt(raw, 'height', `plate.rails[${index}].height`) ?? 0,
        label: textAt(raw, 'label') ?? `导轨 ${index + 1}`
      });
    }
  }
  return { width, height, rails };
}

function parsePlc(value: unknown): CostPlcSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail('INVALID_ARGUMENT', 'plc 必须是对象');
  if (!Array.isArray(value.modules)) fail('INVALID_ARGUMENT', 'plc.modules 必须是数组');
  const modules = value.modules.map((raw, index) => {
    if (!isRecord(raw)) fail('INVALID_ARGUMENT', `plc.modules[${index}] 必须是对象`);
    const partId = textAt(raw, 'partId');
    if (partId === undefined) fail('INVALID_ARGUMENT', `缺少必填参数：plc.modules[${index}].partId`);
    const qty = numberAt(raw, 'qty', `plc.modules[${index}].qty`) ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) {
      fail('INVALID_ARGUMENT', `plc.modules[${index}].qty 必须是正整数`);
    }
    return { partId, qty };
  });
  return { ioPoints: numberAt(value, 'ioPoints', 'plc.ioPoints') ?? 0, modules };
}

function parseOverrides(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail('INVALID_ARGUMENT', 'overrides 必须是对象');
  const overrides: Record<string, number> = {};
  for (const [partId, price] of Object.entries(value)) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      fail('INVALID_ARGUMENT', `overrides.${partId} 必须是非负有限数`);
    }
    overrides[partId] = price;
  }
  return overrides;
}

function parseOptions(value: unknown): CostOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail('INVALID_ARGUMENT', 'options 必须是对象');
  const options: CostOptions = {};
  for (const key of ['markupRate', 'taxRate', 'freight'] as const) {
    const parsed = numberAt(value, key, `options.${key}`);
    if (parsed === undefined) continue;
    if (parsed < 0) fail('INVALID_ARGUMENT', `options.${key} 必须是非负数`);
    options[key] = parsed;
  }
  return options;
}

function pricebookMeta(book: Pricebook, label: string): CostToolPricebookMeta {
  let usableItems = 0;
  let exampleItems = 0;
  for (const item of Object.values(book.items)) {
    if (isUsablePricebookItem(item)) usableItems += 1;
    else exampleItems += 1;
  }
  return {
    label,
    currency: book.currency,
    updatedAt: book.updatedAt,
    source: book.source,
    usableItems,
    exampleItems
  };
}

function resolvePricebook(
  raw: unknown,
  deps: CostToolDeps
): { book: Pricebook; label: string } {
  if (raw !== undefined && raw !== null) {
    try {
      return { book: validatePricebook(raw), label: '入参价格簿' };
    } catch (error) {
      fail(
        'INVALID_ARGUMENT',
        `价格簿不合法：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (deps.loadBuiltinPricebook) {
    let loaded: unknown;
    try {
      loaded = deps.loadBuiltinPricebook();
    } catch (error) {
      fail(
        'PRICEBOOK_UNAVAILABLE',
        `内置价格簿不可用：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (loaded !== undefined && loaded !== null) {
      try {
        return { book: validatePricebook(loaded), label: '内置价格簿' };
      } catch (error) {
        fail(
          'PRICEBOOK_UNAVAILABLE',
          `内置价格簿不合法：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return fail('PRICEBOOK_UNAVAILABLE', '缺少必填参数：pricebook（请传入 pricebook，或确认桌面版内置价格簿可用）');
}

export interface CostReportComputation {
  /** 完整报告；面板、窄输出与落盘导出共用同一份对象。 */
  report: CostReport;
  pricebook: CostToolPricebookMeta;
  bomSource: 'argument' | 'scene';
  bomRows: number;
  notes: string[];
}

/**
 * 取数 + 校验 + 计算的唯一入口。
 *
 * `runCostTool`（只读摘要）与 `buildCostExport`（PDF/CSV 落盘）都从这里拿 `CostReport`，
 * 避免出现「问答一个数、导出另一个数」。
 *
 * 价格优先级与面板一致：`overrides` > 入参价格簿 > 内置价格簿 > 缺价（进 missing，不写成 0）。
 */
export function computeCostReport(
  args: Record<string, unknown>,
  deps: CostToolDeps = {}
): CostReportComputation {
  if (!isRecord(args)) fail('INVALID_ARGUMENT', '工具入参必须是对象');

  const explicitBom = parseBom(args.bom);
  const sceneBom = costRowsFromSceneBom(deps.sceneBom);
  const bom = explicitBom ?? sceneBom;
  const bomSource: 'argument' | 'scene' = explicitBom ? 'argument' : 'scene';
  if (!bom) {
    fail('NO_BOM', '没有可计算的 BOM：请传入 bom 数组，或在桌面应用中先打开装配体');
  }

  const { book, label } = resolvePricebook(args.pricebook, deps);
  const meta = pricebookMeta(book, label);

  const input: CostInput = { bom, pricebook: book };
  const placements = parsePlacements(args.placements);
  if (placements) input.placements = placements;
  const plate = parsePlate(args.plate);
  if (plate) input.plate = plate;
  const plc = parsePlc(args.plc);
  if (plc) input.plc = plc;
  const overrides = parseOverrides(args.overrides);
  if (overrides) input.overrides = overrides;
  const options = parseOptions(args.options);
  if (options) input.options = options;
  const wireSection = textAt(args, 'wireSection');
  if (wireSection !== undefined) input.wireSection = wireSection;
  if (args.now !== undefined && args.now !== null) {
    if (typeof args.now !== 'string' && typeof args.now !== 'number') {
      fail('INVALID_ARGUMENT', 'now 必须是 ISO 时间字符串或毫秒时间戳');
    }
    input.now = args.now;
  }

  let report: CostReport;
  try {
    report = computeCost(input);
  } catch (error) {
    fail('COST_FAILED', `成本计算失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const notes: string[] = [];
  if (bomSource === 'scene') {
    notes.push('BOM 来自当前 CAD 场景（简化 BOM）：零件没有物料号，需人工映射 partId 后才能计价。');
  }
  if (meta.usableItems === 0 && meta.exampleItems > 0) {
    notes.push(`价格簿内 ${meta.exampleItems} 条均为示例条目（不计价），合计只含人工与辅材。`);
  }
  if (report.missing.length > 0) {
    notes.push(`有 ${report.missing.length} 项物料未计价，合计偏低，不要当作报价单使用。`);
  }

  return { report, pricebook: meta, bomSource, bomRows: bom.length, notes };
}

/**
 * 执行成本报告（只读，无副作用）。
 *
 * 输出刻意收窄，详见文件头注释；完整报告只用于本地导出，不回灌给模型。
 */
export function runCostTool(args: Record<string, unknown>, deps: CostToolDeps = {}): CostToolResult {
  const computation = computeCostReport(args, deps);
  const { report, pricebook: meta, bomSource, bomRows, notes } = computation;

  const lines = report.lines.slice(0, COST_TOOL_LINE_LIMIT);
  const missing = report.missing.slice(0, COST_TOOL_ISSUE_LIMIT);
  const warnings = report.warnings.slice(0, COST_TOOL_ISSUE_LIMIT);

  return {
    ok: true,
    bomSource,
    bomRows,
    pricebook: meta,
    totals: report.totals,
    labor: report.labor,
    extras: report.extras,
    byCategory: report.byCategory,
    counts: {
      lines: report.lines.length,
      missing: report.missing.length,
      warnings: report.warnings.length
    },
    lines,
    missing,
    warnings,
    truncated:
      report.lines.length > lines.length ||
      report.missing.length > missing.length ||
      report.warnings.length > warnings.length,
    notes,
    summary: describeCost(report, meta.currency)
  };
}
