/**
 * STEP（ISO-10303-21）文本检查：只靠正则，不引第三方依赖。
 *
 * 为什么需要它：`npm run machine:e2e` 里的 STEP 是**桩产物**（内核桩按特征尺寸生成方块，
 * 头部/实体数/包络都跟真实 B-Rep 不是一回事）。要证明「能出 STEP」，必须打开真实内核
 * 导出的文件，数里面的实体、量它的包络。这里就是那把尺子：
 *
 *   inspectStep(text)               → 头、单位、实体计数、顶点包络
 *   aggregateInspections(list)      → 逐件导出的合计（实体数、包络并集）
 *   checkStepExport(facts, expect)  → 头部/字节数/实体数/包络/单位 五条断言
 *
 * 包络为什么按 VERTEX_POINT 引用到的 CARTESIAN_POINT 算：
 * 文件里还有大量**参考几何**的 CARTESIAN_POINT（圆柱轴心、平面参考点），它们的坐标
 * 可能落在实体之外（实测整机 STEP 全部坐标点的 Z 范围是 -497~930，而真实包络是 0~930——
 * 差出来的 -497 就是被布尔切掉的那段圆柱参考轴）。只统计 B-rep 顶点才等于真实外形；
 * 对 85 件这种以平面为主、圆柱为辅的整机，顶点包络与内核自报 bbox 完全一致（6000×1495×930）。
 */

/** 轴对齐包络（mm）。 */
export interface StepBBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface StepInspection {
  /** 头部第一行，正常为 `ISO-10303-21`（不含分号）。 */
  header: string | null;
  /** FILE_SCHEMA，例如 AUTOMOTIVE_DESIGN。 */
  schema: string | null;
  /** 长度单位：MM / CM / M / INCH；识别不出为 null。 */
  units: string | null;
  /** 文件字节数（由调用方给出；纯文本解析时为 UTF-8 字节数）。 */
  bytes: number;
  /** `#n=` 实体总数。 */
  entities: number;
  /** 实体类型 → 条数（COMPLEX 实体不计入）。 */
  counts: Record<string, number>;
  /** MANIFOLD_SOLID_BREP 条数 = 实体（Solid）个数。 */
  solids: number;
  /** CLOSED_SHELL 条数。 */
  shells: number;
  /** ADVANCED_FACE 条数。 */
  faces: number;
  /** VERTEX_POINT 条数。 */
  vertices: number;
  /** CARTESIAN_POINT 条数（含参考几何）。 */
  points: number;
  /** B-rep 顶点包络（mm）；无顶点时为 null。 */
  bbox: StepBBox | null;
  /** 全部坐标点包络（含参考几何，只用于诊断，不能当外形）。 */
  rawPointBbox: StepBBox | null;
}

export class StepInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepInspectError';
  }
}

const ENTITY_RE = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/g;
const POINT_RE = /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^()]*)\)\s*\)/g;
const VERTEX_RE = /#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;

function emptyBox(): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };
}

function finishBox(box: { min: [number, number, number]; max: [number, number, number] }): StepBBox | null {
  if (!Number.isFinite(box.min[0]) || !Number.isFinite(box.max[0])) return null;
  return {
    min: [round3(box.min[0]), round3(box.min[1]), round3(box.min[2])],
    max: [round3(box.max[0]), round3(box.max[1]), round3(box.max[2])],
    size: [round3(box.max[0] - box.min[0]), round3(box.max[1] - box.min[1]), round3(box.max[2] - box.min[2])]
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function grow(box: { min: [number, number, number]; max: [number, number, number] }, point: readonly number[]): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis];
    if (value === undefined || !Number.isFinite(value)) return;
    if (value < box.min[axis]!) box.min[axis] = value;
    if (value > box.max[axis]!) box.max[axis] = value;
  }
}

function parseCoords(raw: string): [number, number, number] | null {
  const parts = raw.split(',').map((item) => Number(item.trim()));
  if (parts.length !== 3) return null;
  const [x, y, z] = parts;
  if (x === undefined || y === undefined || z === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function parseUnits(text: string): string | null {
  // SI_UNIT(.MILLI.,.METRE.) / CONVERSION_BASED_UNIT('INCH',...)
  if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 'INCH';
  const si = /SI_UNIT\s*\(\s*(?:\.([A-Z]+)\.)?\s*,\s*\.METRE\.\s*\)/.exec(text);
  if (si) {
    const prefix = si[1] ?? '';
    if (prefix === 'MILLI') return 'MM';
    if (prefix === 'CENTI') return 'CM';
    if (prefix === '') return 'M';
    return `M·${prefix}`;
  }
  // 老式写法：.MILLIMETRE. / .METRE.
  if (/\.MILLIMETRE\./.test(text)) return 'MM';
  if (/\.CENTIMETRE\./.test(text)) return 'CM';
  return null;
}

/**
 * 解析 STEP 文本。不是 STEP（无 ISO-10303-21 头 / 无实体段）时抛 StepInspectError。
 * 只做静态解析，不校验几何有效性。
 */
export function inspectStep(text: string, bytes?: number): StepInspection {
  if (typeof text !== 'string' || text.length === 0) {
    throw new StepInspectError('STEP 内容为空');
  }
  const head = text.slice(0, 4096).trimStart();
  if (!head.startsWith('ISO-10303-21')) {
    const shown = head.slice(0, 24).replace(/\s+/g, ' ');
    throw new StepInspectError(`不是 STEP 文件：头部不是 ISO-10303-21（实际「${shown}」）`);
  }
  const counts: Record<string, number> = {};
  let entities = 0;
  for (const match of text.matchAll(ENTITY_RE)) {
    const type = match[2];
    if (!type) continue;
    entities += 1;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  if (entities === 0) {
    throw new StepInspectError('STEP 里没有任何 #n= 实体（文件被截断或只有头段）');
  }

  const all = emptyBox();
  const points = new Map<string, [number, number, number]>();
  for (const match of text.matchAll(POINT_RE)) {
    const id = match[1];
    const coords = match[2] === undefined ? null : parseCoords(match[2]);
    if (!id || !coords) continue;
    points.set(id, coords);
    grow(all, coords);
  }

  const vertexBox = emptyBox();
  let vertices = 0;
  for (const match of text.matchAll(VERTEX_RE)) {
    const pointId = match[2];
    const coords = pointId ? points.get(pointId) : undefined;
    if (!coords) continue;
    vertices += 1;
    grow(vertexBox, coords);
  }

  return {
    header: 'ISO-10303-21',
    schema: /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/.exec(text)?.[1] ?? null,
    units: parseUnits(text),
    bytes: bytes ?? Buffer.byteLength(text, 'utf8'),
    entities,
    counts,
    solids: counts.MANIFOLD_SOLID_BREP ?? 0,
    shells: counts.CLOSED_SHELL ?? 0,
    faces: counts.ADVANCED_FACE ?? 0,
    vertices,
    points: points.size,
    bbox: finishBox(vertexBox),
    rawPointBbox: finishBox(all)
  };
}

/** 逐件导出的合计：实体/面/顶点/字节相加，包络取并集。 */
export function aggregateInspections(list: readonly StepInspection[]): StepInspection {
  if (list.length === 0) throw new StepInspectError('没有可合计的 STEP');
  const counts: Record<string, number> = {};
  let entities = 0;
  let bytes = 0;
  let vertices = 0;
  let points = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const item of list) {
    entities += item.entities;
    bytes += item.bytes;
    vertices += item.vertices;
    points += item.points;
    for (const [type, value] of Object.entries(item.counts)) counts[type] = (counts[type] ?? 0) + value;
    if (!item.bbox) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = item.bbox.min[axis];
      const hi = item.bbox.max[axis];
      if (lo === undefined || hi === undefined) continue;
      if (lo < min[axis]!) min[axis] = lo;
      if (hi > max[axis]!) max[axis] = hi;
    }
  }
  const units = list.every((item) => item.units === list[0]?.units) ? list[0]?.units ?? null : null;
  return {
    header: list.every((item) => item.header === 'ISO-10303-21') ? 'ISO-10303-21' : null,
    schema: list[0]?.schema ?? null,
    units,
    bytes,
    entities,
    counts,
    solids: counts.MANIFOLD_SOLID_BREP ?? 0,
    shells: counts.CLOSED_SHELL ?? 0,
    faces: counts.ADVANCED_FACE ?? 0,
    vertices,
    points,
    bbox: finishBox({ min, max }),
    rawPointBbox: null
  };
}

export interface StepExpectation {
  /** 整机装配件数（85）。实体数按它 ±solidTolerance。 */
  parts: number;
  /** 期望包络 X×Y×Z（mm），来自同一份参数化零件表。 */
  envelopeMm: [number, number, number];
  /** 最小字节数，默认 50 KB：桩产物只有 3 KB 量级。 */
  minBytes?: number;
  /** 实体数容差，默认 5（同一零件可能被拆成多实体）。 */
  solidTolerance?: number;
  /** 包络每轴容差（mm），默认 40（圆柱顶点不在极值上）。 */
  envelopeToleranceMm?: number;
}

export interface StepCheck {
  label: string;
  ok: boolean;
  expected: string;
  actual: string;
  /** 只做展示、不参与判定（例如内核自报的包络）。 */
  note?: string;
}

export const STEP_MIN_BYTES = 50 * 1024;
export const STEP_HEADER = 'ISO-10303-21';

/**
 * 五条硬断言：头、字节数、实体数、包络、单位。
 * 任一不过 → ok:false，调用方据此 exit 1（桩产物就是死在字节数与实体数上）。
 */
export function checkStepExport(
  inspection: StepInspection,
  expectation: StepExpectation
): { ok: boolean; checks: StepCheck[] } {
  const minBytes = expectation.minBytes ?? STEP_MIN_BYTES;
  const tolerance = expectation.solidTolerance ?? 5;
  const envelopeTolerance = expectation.envelopeToleranceMm ?? 40;
  const checks: StepCheck[] = [];

  checks.push({
    label: 'STEP 头',
    ok: inspection.header === STEP_HEADER,
    expected: STEP_HEADER,
    actual: inspection.header ?? '(缺失)'
  });

  checks.push({
    label: '字节数',
    ok: inspection.bytes >= minBytes,
    expected: `≥ ${minBytes}`,
    actual: String(inspection.bytes)
  });

  const low = expectation.parts - tolerance;
  const high = expectation.parts + tolerance;
  checks.push({
    label: '实体数（MANIFOLD_SOLID_BREP）',
    ok: inspection.solids >= low && inspection.solids <= high,
    expected: `${expectation.parts} ± ${tolerance}（${low}~${high}）`,
    actual: String(inspection.solids)
  });

  const bbox = inspection.bbox;
  const envelopeOk = (() => {
    if (!bbox) return false;
    for (let axis = 0; axis < 3; axis += 1) {
      const want = expectation.envelopeMm[axis];
      const got = bbox.size[axis];
      if (want === undefined || got === undefined) return false;
      if (Math.abs(got - want) > envelopeTolerance) return false;
    }
    return true;
  })();
  const fmt = (box: StepBBox | null): string =>
    box ? box.size.map((value) => value.toFixed(1)).join('×') : '(无顶点)';
  checks.push({
    label: '包络（顶点 X×Y×Z）',
    ok: envelopeOk,
    expected: `${expectation.envelopeMm.map((value) => value.toFixed(1)).join('×')} ±${envelopeTolerance}`,
    actual: fmt(bbox)
  });

  const unitOk = inspection.units === null ? true : inspection.units === 'MM';
  checks.push({
    label: '长度单位',
    ok: unitOk,
    expected: 'MM',
    actual: inspection.units ?? '(未声明)',
    ...(inspection.units === null ? { note: '文件未声明长度单位，按 mm 惯例放行' } : {})
  });

  // 面数兜底：一个「装着整机」的实体不可能只有个位数面。
  checks.push({
    label: '面数（ADVANCED_FACE）',
    ok: inspection.faces >= expectation.parts,
    expected: `≥ ${expectation.parts}`,
    actual: String(inspection.faces)
  });

  return { ok: checks.every((check) => check.ok), checks };
}

/** 断言用的一行摘要，脚本与测试共用同一套措辞。 */
export function describeInspection(inspection: StepInspection): string {
  const bbox = inspection.bbox ? inspection.bbox.size.map((value) => value.toFixed(1)).join('×') : '(无顶点)';
  return `bytes=${inspection.bytes} entities=${inspection.entities} solids=${inspection.solids} faces=${inspection.faces} bbox=${bbox} units=${inspection.units ?? '?'}`;
}
