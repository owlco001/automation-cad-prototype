// 运动学自动识别：从导入的 STEP 装配体（网格名 + 装配层级 + 几何）推测动件，产出「建议」。
// 边界：
// - 只出建议，不改任何标注；采纳必须由用户在运动学抽屉里确认（单条 acceptSuggestion 或批量 applyBatchAccept，
//   两者都要求显式 id/门槛，批量还带审计记录与快照撤销）。
// - 结果全部是启发式推测：名称关键词 / 厂商型号 / 同级归组 / 主轴分析（PCA）与同轴判断。
// - 方向向量保留真实值；标注层只支持 ±X/±Y/±Z，取最近主轴并在偏角过大时降低置信度。
// - 行程优先取型号（如 MGPM20-50 → 50 mm），其次几何估算，取不到就留 0 让用户填，不编造。
// - 采纳后的动件复用 kinematics-ui 的 MovingPart / validateDraft，校验规则与人工标注完全一致。

import {
  draftFromMeshes,
  validateDraft,
  type DraftValidation,
  type KinematicsMeshInfo,
  type KinematicsPointOption,
  type MovingPart
} from './kinematics-ui.ts';
import type { KinematicsAxisName, KinematicsKind, KinematicsRole } from './kinematics.ts';

export type Vec3 = [number, number, number];

export type MechanismCategory = 'cylinder' | 'slide' | 'gripper' | 'rotary' | 'ballscrew' | 'rail' | 'motor';

export type PartRole =
  | 'rod'
  | 'body'
  | 'table'
  | 'finger'
  | 'carriage'
  | 'rail'
  | 'screw'
  | 'nut'
  | 'shaft'
  | '';

export type StrokeSource = 'model-code' | 'catalog' | 'geometry' | 'default' | 'none';

/**
 * 批量采纳用的机构族：同一工位里同一族的建议视为一个动作组。
 * 气缸 / 滑台 / 导轨 / 丝杆常串成同一条直线驱动链（气缸推滑块），所以合成 'linear'；
 * 夹爪、旋转台、电机各自独立（它们的运动学语义不同，不能混批）。
 */
export type MechanismFamily = 'linear' | 'gripper' | 'rotary' | 'motor';

export const MECHANISM_FAMILY_LABELS: Record<MechanismFamily, string> = {
  linear: '直线驱动',
  gripper: '夹爪',
  rotary: '旋转台',
  motor: '电机'
};

export function mechanismFamily(category: MechanismCategory): MechanismFamily {
  switch (category) {
    case 'gripper':
      return 'gripper';
    case 'rotary':
      return 'rotary';
    case 'motor':
      return 'motor';
    default:
      return 'linear';
  }
}

/**
 * 稳定的机构组键（纯函数、可测、跨两次识别不变）：`锚点@机构族`。
 * 锚点优先取工位号（ST1…），没有工位才退回装配层级路径；不使用 sg-N 这类按顺序生成的 id，
 * 否则建议列表一重排，组键就漂移，批量采纳的审计记录也没法复用。
 * 为什么不在键里塞型号：同一工位的气缸 + 导轨 + 滑台就是同一条直线驱动链，
 * 拆成三组等于没减少点击；逐条门槛仍在 applyBatchAccept 里生效，误批可一键撤销。
 */
export function mechanismGroupKey(input: { station: string; category: MechanismCategory; group?: string }): string {
  const anchor = input.station.trim() || input.group?.trim() || 'ROOT';
  return `${anchor}@${mechanismFamily(input.category)}`;
}

export interface AutoKinMesh {
  /** 与 KinematicsMeshInfo.id 一致（CadViewer parts 索引）。 */
  id: number;
  name: string;
  /** 装配层级路径（根 → 父节点），来自 CadMeshData.path。 */
  path?: readonly string[] | undefined;
  center: Vec3;
  size: Vec3;
  triangles?: number;
  /** xyz 交错顶点；缺省时只用包围盒做几何判断。 */
  positions?: ArrayLike<number> | null | undefined;
}

export interface MeshShape {
  center: Vec3;
  /** 主轴（单位向量），按投影长度从大到小排列。 */
  axes: [Vec3, Vec3, Vec3];
  /** 沿 axes 的投影长度（mm）。 */
  extents: [number, number, number];
  /** 投影区间（相对 center 的标量，沿 axes[i]）。 */
  ranges: [[number, number], [number, number], [number, number]];
  elongation: number;
  flatness: number;
  /** 绕最长轴（细长件）或最短轴（扁平件）是否近似回转体。 */
  round: boolean;
  /** 绕最长轴的平均半径（mm）。 */
  radius: number;
  source: 'vertices' | 'bbox';
}

export interface NameClass {
  category: MechanismCategory | null;
  role: PartRole;
  /** 识别出的型号（如 CDJ2B16-50、MGN12、MHZ2-16D）。 */
  modelCode: string;
  /** 归组用型号系列：气缸取完整型号，导轨/滑块取 MGN12 这类系列。 */
  seriesKey: string;
  strokeMm: number | null;
  rangeDeg: number | null;
  strokeSource: StrokeSource;
  /** 导轨长度（名称中 L300 之类）。 */
  railLengthMm: number | null;
  bore: number | null;
  /** 命中的关键词，供理由文本使用。 */
  hits: string[];
}

export interface PointCandidate {
  point: string;
  role: KinematicsRole;
  actuatorName: string;
  score: number;
  reason: string;
}

export interface KinematicsSuggestion {
  id: string;
  category: MechanismCategory;
  name: string;
  /** 被移动的网格（成为 MovingPart.meshIds）。 */
  meshIds: number[];
  meshNames: string[];
  /** 机构内固定不动的网格（缸体、导轨、本体）。 */
  fixedMeshIds: number[];
  kind: KinematicsKind;
  /** 真实运动方向（单位向量）；旋转为转轴方向。 */
  directionVector: Vec3;
  axis: KinematicsAxisName;
  direction: 1 | -1;
  offAxisDeg: number;
  /** 直线行程（mm）；0 表示无法确定，采纳后需用户填写。 */
  travelMm: number;
  retractedMm: number;
  /** 旋转角度（deg）；直线为 0。 */
  rangeDeg: number;
  strokeSource: StrokeSource;
  modelCode: string;
  station: string;
  /** 稳定机构组键：`工位@机构族`，批量采纳按它归组；同一输入两次识别完全一致。 */
  groupKey: string;
  point: string;
  role: KinematicsRole | '';
  pointCandidates: PointCandidate[];
  confidence: number;
  level: 'high' | 'low';
  reasons: string[];
  reason: string;
}

export interface SkippedGroup {
  name: string;
  meshIds: number[];
  category: MechanismCategory | null;
  reason: string;
}

export interface SuggestOptions {
  pointOptions?: readonly KinematicsPointOption[];
  /** 已有动件：其网格不再出建议，其点位不再推荐。 */
  existingParts?: readonly MovingPart[];
  /** 高 / 低置信度分界，默认 0.6。 */
  minConfidence?: number;
  /** 点位推荐阈值，默认 0.5。 */
  minPointScore?: number;
}

export interface SuggestResult {
  /** 高置信度建议（≥ minConfidence）。 */
  suggestions: KinematicsSuggestion[];
  /** 低置信度建议，UI 单独折叠显示。 */
  lowConfidence: KinematicsSuggestion[];
  skipped: SkippedGroup[];
  stats: { meshes: number; classified: number; groups: number; high: number; low: number; skipped: number };
}

export interface AcceptResult {
  parts: MovingPart[];
  accepted: string[];
  missing: string[];
  validation: DraftValidation;
}

export const ROLE_LABELS: Record<Exclude<PartRole, ''>, string> = {
  rod: '活塞杆',
  body: '本体',
  table: '台面/板',
  finger: '手指',
  carriage: '滑块',
  rail: '导轨',
  screw: '丝杆',
  nut: '螺母',
  shaft: '轴'
};

export const CATEGORY_LABELS: Record<MechanismCategory, string> = {
  cylinder: '气缸',
  slide: '滑台',
  gripper: '夹爪',
  rotary: '旋转台',
  ballscrew: '丝杆模组',
  rail: '直线导轨',
  motor: '伺服电机'
};

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_POINT_SCORE = 0.5;
const STANDARD_STROKES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500];

/** SMC MHZ2 平行夹爪开闭总行程（mm），按样本表；单指行程为一半。 */
const MHZ2_STROKE: Record<number, number> = { 6: 4, 10: 4, 16: 6, 20: 10, 25: 14, 32: 22, 40: 30 };

// ---------------------------------------------------------------- 向量工具

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const round = (value: number, digits = 3): number => {
  const k = 10 ** digits;
  const out = Math.round(value * k) / k;
  return out === 0 ? 0 : out; // 去掉 -0
};
const clamp01 = (value: number): number => Math.min(0.99, Math.max(0, value));

/** 两向量夹角（deg），忽略正负号（轴线意义上的夹角）。 */
export function axisAngleDeg(a: Vec3, b: Vec3): number {
  const c = Math.abs(dot(normalize(a), normalize(b)));
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

/** 点到直线（过 origin、方向 dir）的距离。 */
export function distanceToLine(point: Vec3, origin: Vec3, dir: Vec3): number {
  const d = normalize(dir);
  const v = sub(point, origin);
  const along = dot(v, d);
  return length(sub(v, scale(d, along)));
}

/** 方向向量 → 最近主轴 + 方向 + 偏角。 */
export function snapAxis(vector: Vec3): { axis: KinematicsAxisName; direction: 1 | -1; offAxisDeg: number } {
  const v = normalize(vector);
  const abs = v.map((value) => Math.abs(value));
  let index = 0;
  if (abs[1]! > abs[index]!) index = 1;
  if (abs[2]! > abs[index]!) index = 2;
  const axis: KinematicsAxisName = index === 0 ? 'x' : index === 1 ? 'y' : 'z';
  const direction: 1 | -1 = (v[index] ?? 0) < 0 ? -1 : 1;
  const offAxisDeg = round((Math.acos(Math.min(1, abs[index] ?? 0)) * 180) / Math.PI, 1);
  return { axis, direction, offAxisDeg };
}

/** 3×3 对称矩阵 Jacobi 特征分解；返回按特征值降序的特征向量。 */
function eigenSymmetric3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += a[p]![q]! ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const pairs = [0, 1, 2].map((i) => ({
    value: a[i]![i]!,
    vector: normalize([v[0]![i]!, v[1]![i]!, v[2]![i]!])
  }));
  pairs.sort((x, y) => y.value - x.value);
  return { values: pairs.map((pair) => pair.value), vectors: pairs.map((pair) => pair.vector) };
}

/** 把 PCA 轴「拉正」：接近坐标轴（< 0.5°）时直接取坐标轴，并统一成主分量为正。 */
function tidyAxis(axis: Vec3): Vec3 {
  const snapped = snapAxis(axis);
  if (snapped.offAxisDeg < 0.5) {
    const out: Vec3 = [0, 0, 0];
    out[snapped.axis === 'x' ? 0 : snapped.axis === 'y' ? 1 : 2] = 1;
    return out;
  }
  return snapped.direction === -1 ? scale(axis, -1) : axis;
}

// ---------------------------------------------------------------- 几何特征

/** 网格形状特征：主轴、投影长度、细长度、扁平度与回转体判断。 */
export function analyzeMeshShape(mesh: Pick<AutoKinMesh, 'center' | 'size' | 'positions'>): MeshShape {
  const positions = mesh.positions;
  const count = positions ? Math.floor(positions.length / 3) : 0;
  if (!positions || count < 4) return shapeFromBox(mesh.center, mesh.size);

  const center: Vec3 = [...mesh.center];
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  let mean: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    mean = [mean[0] + Number(positions[i * 3]), mean[1] + Number(positions[i * 3 + 1]), mean[2] + Number(positions[i * 3 + 2])];
  }
  mean = scale(mean, 1 / count);
  for (let i = 0; i < count; i += 1) {
    const d: Vec3 = [
      Number(positions[i * 3]) - mean[0],
      Number(positions[i * 3 + 1]) - mean[1],
      Number(positions[i * 3 + 2]) - mean[2]
    ];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) cov[r]![c]! += d[r]! * d[c]!;
  }
  const { vectors } = eigenSymmetric3(cov.map((row) => row.map((value) => value / count)));
  const axes = vectors.map(tidyAxis) as [Vec3, Vec3, Vec3];
  const ranges = axes.map(() => [Infinity, -Infinity]) as [[number, number], [number, number], [number, number]];
  for (let i = 0; i < count; i += 1) {
    const p: Vec3 = [Number(positions[i * 3]), Number(positions[i * 3 + 1]), Number(positions[i * 3 + 2])];
    const rel = sub(p, center);
    for (let k = 0; k < 3; k += 1) {
      const t = dot(rel, axes[k]!);
      ranges[k]![0] = Math.min(ranges[k]![0], t);
      ranges[k]![1] = Math.max(ranges[k]![1], t);
    }
  }
  // 按投影长度重新排序（协方差排序与投影长度在扁平件上可能不同）
  const order = [0, 1, 2].sort((x, y) => ranges[y]![1] - ranges[y]![0] - (ranges[x]![1] - ranges[x]![0]));
  const sortedAxes = order.map((k) => axes[k]!) as [Vec3, Vec3, Vec3];
  const sortedRanges = order.map((k) => ranges[k]!) as [[number, number], [number, number], [number, number]];
  const extents = sortedRanges.map(([lo, hi]) => round(hi - lo, 4)) as [number, number, number];

  const elongation = extents[0] / Math.max(extents[1], 1e-6);
  const flatness = extents[2] / Math.max(extents[1], 1e-6);
  // 回转体：细长件绕最长轴、扁平件绕最短轴看顶点径向分布与角度覆盖
  const flat = flatness < 0.6 && elongation < 1.4;
  const revolveAxis = flat ? sortedAxes[2] : sortedAxes[0];
  const radial = radialStats(positions, count, center, revolveAxis, sortedAxes);
  const majorRadial = flat ? radialStats(positions, count, center, sortedAxes[0], sortedAxes) : radial;
  return {
    center,
    axes: sortedAxes,
    extents,
    ranges: sortedRanges,
    elongation: round(elongation, 3),
    flatness: round(flatness, 3),
    round: radial.cv < 0.08 && radial.buckets >= 12,
    radius: round(majorRadial.mean, 3),
    source: 'vertices'
  };
}

function radialStats(
  positions: ArrayLike<number>,
  count: number,
  center: Vec3,
  axis: Vec3,
  basis: [Vec3, Vec3, Vec3]
): { mean: number; cv: number; buckets: number } {
  const others = basis.filter((candidate) => axisAngleDeg(candidate, axis) > 45);
  const u = others[0] ?? [1, 0, 0];
  const w = others[1] ?? [0, 1, 0];
  const radii: number[] = [];
  const buckets = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    const rel = sub([Number(positions[i * 3]), Number(positions[i * 3 + 1]), Number(positions[i * 3 + 2])], center);
    const x = dot(rel, u);
    const y = dot(rel, w);
    const r = Math.hypot(x, y);
    radii.push(r);
    if (r > 1e-6) buckets.add(Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 36) % 36);
  }
  const mean = radii.reduce((sum, r) => sum + r, 0) / Math.max(radii.length, 1);
  const variance = radii.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(radii.length, 1);
  return { mean, cv: mean > 1e-9 ? Math.sqrt(variance) / mean : 1, buckets: buckets.size };
}

function shapeFromBox(center: Vec3, size: Vec3): MeshShape {
  const basis: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  const order = [0, 1, 2].sort((x, y) => (size[y] ?? 0) - (size[x] ?? 0));
  const axes = order.map((k) => basis[k]!) as [Vec3, Vec3, Vec3];
  const extents = order.map((k) => Math.max(0, size[k] ?? 0)) as [number, number, number];
  const ranges = extents.map((e) => [-e / 2, e / 2]) as [[number, number], [number, number], [number, number]];
  return {
    center: [...center],
    axes,
    extents,
    ranges,
    elongation: round(extents[0] / Math.max(extents[1], 1e-6), 3),
    flatness: round(extents[2] / Math.max(extents[1], 1e-6), 3),
    round: false,
    radius: round(Math.max(extents[1], extents[2]) / 2, 3),
    source: 'bbox'
  };
}

/** 包围盒（世界坐标）。 */
function boxOf(mesh: Pick<AutoKinMesh, 'center' | 'size'>): { min: Vec3; max: Vec3 } {
  return {
    min: [0, 1, 2].map((k) => mesh.center[k]! - mesh.size[k]! / 2) as Vec3,
    max: [0, 1, 2].map((k) => mesh.center[k]! + mesh.size[k]! / 2) as Vec3
  };
}

/** 两包围盒间隙（各轴间隙的最大值，重叠为负）。 */
function boxGap(a: Pick<AutoKinMesh, 'center' | 'size'>, b: Pick<AutoKinMesh, 'center' | 'size'>): number {
  const A = boxOf(a);
  const B = boxOf(b);
  let gap = -Infinity;
  for (let k = 0; k < 3; k += 1) gap = Math.max(gap, Math.max(A.min[k]! - B.max[k]!, B.min[k]! - A.max[k]!));
  return gap;
}

/** 沿 dir 的投影区间（用包围盒 8 角点近似）。 */
function projectBox(mesh: Pick<AutoKinMesh, 'center' | 'size'>, dir: Vec3): [number, number] {
  const box = boxOf(mesh);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const t = dot([x, y, z], dir);
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
  }
  return [lo, hi];
}

// ---------------------------------------------------------------- 名称识别

interface CategoryRule {
  category: MechanismCategory;
  pattern: RegExp;
  label: string;
}

// 顺序有意义：夹爪/旋转/滑台/丝杆先于通用气缸，避免「手指气缸」「旋转气缸」被判成直线气缸。
const CATEGORY_RULES: CategoryRule[] = [
  { category: 'gripper', pattern: /夹爪|气爪|手指气缸|夹指气缸|gripper|(?<![A-Z])MH(?:Z|ZL|F|S|C|Y|L|K)2|(?<![A-Z])HFZ\d/i, label: '夹爪' },
  { category: 'rotary', pattern: /旋转|回转|摆动|转台|分度|rotary|rotat|turntable|indexer|(?<![A-Z])MSQ[AB]?\d|(?<![A-Z])MSU[AB]?\d|(?<![A-Z])CRB\d|(?<![A-Z])CRQ2|(?<![A-Z])HRQ\d/i, label: '旋转' },
  { category: 'slide', pattern: /滑台|气动滑台|slide\s*table|slide|(?<![A-Z])MX[QSHPJ][A-Z]?\d|(?<![A-Z])HLQ\d/i, label: '滑台' },
  { category: 'ballscrew', pattern: /丝杆|丝杠|滚珠丝|ball\s*screw|ballscrew|(?<![A-Z])SF[UKE]\d{4}/i, label: '丝杆' },
  { category: 'motor', pattern: /伺服|电机|马达|步进|servo|motor|stepper|(?<![A-Z])(?:MHMF|MSMF|MSMD|HG-KR|HG-MR|ECMA|1FK7|SGM[A-Z]{0,3})/i, label: '电机' },
  { category: 'rail', pattern: /导轨|直线导|滑轨|linear\s*guide|rail|carriage|滑块|(?<![A-Z])(?:MGN|MGW|HGR|HGH|HGW|EGR|EGH|SSR|SHS|HSR)\d/i, label: '导轨' },
  {
    category: 'cylinder',
    pattern: /气缸|油缸|推杆缸|cylinder|(?<![A-Z])CYL(?![A-Z])|(?<![A-Z])(?:CDJ2|CJ2|CDQ2|CQ2|MGP[MLA]?|CDM2|CM2|CP96|C85|MBB?|ACQ|SDA|TN|MAL|CXSM|CXS)[A-Z]{0,3}\d/i,
    label: '气缸'
  }
];

const ROLE_RULES: { role: PartRole; pattern: RegExp }[] = [
  { role: 'finger', pattern: /手指|夹指|夹爪指|finger|jaw|(?<![夹气])爪(?!体)/i },
  { role: 'rod', pattern: /活塞杆|推杆|伸缩杆|piston|plunger|(?<![A-Z])rod|杆(?![体座])/i },
  { role: 'nut', pattern: /螺母|(?<![A-Z])nut(?![A-Z])/i },
  { role: 'screw', pattern: /丝杆|丝杠|screw/i },
  { role: 'carriage', pattern: /滑块|carriage|(?<![A-Z])block|slider|(?<![A-Z])(?:MGN|MGW|HG|EG)\d+[HCW](?![A-Z0-9])|(?<![A-Z])HG[HW]\d/i },
  { role: 'rail', pattern: /导轨|滑轨|(?<![A-Z])rail|(?<![A-Z])(?:MGNR|HGR|EGR)\d|(?<![A-Z])MGN\d+(?![HCW0-9])/i },
  { role: 'table', pattern: /台面|工作台|转盘|面板|(?<![A-Z])table|(?<![A-Z])top(?![A-Z])|plate|disk|disc|flange|法兰|端板|平台/i },
  { role: 'shaft', pattern: /输出轴|(?<![A-Z])shaft/i },
  { role: 'body', pattern: /缸体|缸筒|本体|主体|壳体|机身|body|housing|barrel|(?<![A-Z])tube|(?<![A-Z])base(?![A-Z])/i }
];

const CYLINDER_CODE = /(?<![A-Z0-9])(CDJ2|CJ2|CDQ2|CQ2|MGP[MLA]?|CDM2|CM2|CP96|C85|MBB?|ACQ|SDA|TN|MAL|CXSM|CXS)([A-Z]{0,3})(\d{1,3})[-xX×*](\d{1,4})/i;
const SLIDE_CODE = /(?<![A-Z0-9])(MX[QSHPJ][A-Z]?|HLQ)(\d{1,3})[A-Z]?[-xX×*](\d{1,4})/i;
const GRIPPER_CODE = /(?<![A-Z0-9])(MH(?:Z|ZL|F|S|C|Y|L|K)2|HFZ)[-]?(\d{1,3})([A-Z]*)/i;
const ROTARY_CODE = /(?<![A-Z0-9])(MSQ[AB]?|MSU[AB]?|CRB\d?[A-Z]*|CRQ2[A-Z]*|HRQ)(\d{1,3})([A-Z]*)(?:-(\d{2,3}))?/i;
const RAIL_CODE = /(?<![A-Z0-9])(MGNR|MGN|MGW|HGR|HGH|HGW|EGR|EGH|SSR|SHS|HSR)(\d{1,2})([A-Z]{0,2})/i;
const SCREW_CODE = /(?<![A-Z0-9])(SF[UKE])(\d{2})(\d{2})/i;
const RAIL_LENGTH = /(?:^|[_\-\s])L[=_]?(\d{2,4})(?![0-9])/i;
const EXPLICIT_STROKE = /(?:行程|stroke)\s*[:：=_-]?\s*(\d{1,4}(?:\.\d+)?)\s*(?:mm)?/i;
const EXPLICIT_ANGLE = /(\d{2,3})\s*(?:°|度|deg)/i;

function emptyClass(): NameClass {
  return {
    category: null,
    role: '',
    modelCode: '',
    seriesKey: '',
    strokeMm: null,
    rangeDeg: null,
    strokeSource: 'none',
    railLengthMm: null,
    bore: null,
    hits: []
  };
}

/** 名称/型号识别：类别、件角色、型号、行程。纯函数，不看几何。 */
export function classifyName(text: string): NameClass {
  const result = emptyClass();
  const source = text.trim();
  if (!source) return result;

  for (const rule of CATEGORY_RULES) {
    const match = rule.pattern.exec(source);
    if (match) {
      result.category = rule.category;
      result.hits.push(match[0]);
      break;
    }
  }
  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(source)) {
      result.role = rule.role;
      break;
    }
  }

  const cylinder = CYLINDER_CODE.exec(source);
  const slide = SLIDE_CODE.exec(source);
  const gripper = GRIPPER_CODE.exec(source);
  const rotary = ROTARY_CODE.exec(source);
  const rail = RAIL_CODE.exec(source);
  const screw = SCREW_CODE.exec(source);

  if (result.category === 'gripper' && gripper) {
    const bore = Number(gripper[2]);
    result.modelCode = gripper[0].toUpperCase();
    result.seriesKey = result.modelCode;
    result.bore = bore;
    const total = /^MHZ/i.test(gripper[1] ?? '') ? MHZ2_STROKE[bore] : undefined;
    if (total !== undefined) {
      result.strokeMm = total / 2;
      result.strokeSource = 'catalog';
    }
  } else if (result.category === 'rotary' && rotary) {
    result.modelCode = rotary[0].toUpperCase();
    result.seriesKey = result.modelCode;
    result.bore = Number(rotary[2]);
    if (rotary[4]) {
      result.rangeDeg = Number(rotary[4]);
      result.strokeSource = 'model-code';
    } else if (/^MSQ|^MSU/i.test(rotary[1] ?? '')) {
      result.rangeDeg = 180;
      result.strokeSource = 'catalog';
    }
  } else if (result.category === 'slide' && slide) {
    result.modelCode = slide[0].toUpperCase();
    result.seriesKey = result.modelCode;
    result.bore = Number(slide[2]);
    result.strokeMm = Number(slide[3]);
    result.strokeSource = 'model-code';
  } else if (result.category === 'cylinder' && cylinder) {
    result.modelCode = cylinder[0].toUpperCase();
    result.seriesKey = result.modelCode;
    result.bore = Number(cylinder[3]);
    result.strokeMm = Number(cylinder[4]);
    result.strokeSource = 'model-code';
  } else if ((result.category === 'rail' || result.role === 'rail' || result.role === 'carriage') && rail) {
    result.modelCode = rail[0].toUpperCase();
    // 导轨与滑块共用系列号（MGN12 / MGN12H → MGN12；HGR20 / HGH20CA → HG20），用于同组归并
    const family = rail[1]!.toUpperCase().replace(/^MGNR$/, 'MGN').replace(/^(HG|EG)[RHW]$/, '$1');
    result.seriesKey = `${family}${rail[2]}`;
    if (!result.category) result.category = 'rail';
  } else if (result.category === 'ballscrew' && screw) {
    result.modelCode = screw[0].toUpperCase();
    result.seriesKey = result.modelCode;
  }

  const railLength = RAIL_LENGTH.exec(source);
  if (railLength && (result.category === 'rail' || result.category === 'ballscrew' || result.role === 'rail' || result.role === 'screw')) {
    result.railLengthMm = Number(railLength[1]);
  }
  if (result.strokeMm === null && result.category !== 'rotary' && result.category !== 'motor') {
    const explicit = EXPLICIT_STROKE.exec(source);
    if (explicit) {
      result.strokeMm = Number(explicit[1]);
      result.strokeSource = 'model-code';
    }
  }
  if (result.rangeDeg === null && result.category === 'rotary') {
    const angle = EXPLICIT_ANGLE.exec(source);
    if (angle) {
      result.rangeDeg = Number(angle[1]);
      result.strokeSource = 'model-code';
    }
  }
  return result;
}

/** 工位号：ST1 / 工位1 / station1 / S1_。 */
export function stationOf(text: string): string {
  const match = /(?<![A-Z])ST[-_ ]?(\d{1,2})(?![0-9])|工位\s*(\d{1,2})|station\s*[-_ ]?(\d{1,2})/i.exec(text);
  const value = match ? match[1] ?? match[2] ?? match[3] : undefined;
  return value ? `ST${Number(value)}` : '';
}

/** 执行机构序号：A1 / _A1_ / 执行机构1。 */
function actuatorIndexOf(text: string): string {
  const match = /(?<![A-Z0-9])A(\d{1,2})(?![0-9])/i.exec(text);
  return match ? `A${Number(match[1])}` : '';
}

// ---------------------------------------------------------------- 归组

interface MeshInfo {
  mesh: AutoKinMesh;
  own: NameClass;
  inherited: NameClass;
  shape: MeshShape;
  group: string;
}

interface Cluster {
  key: string;
  group: string;
  category: MechanismCategory;
  members: MeshInfo[];
  modelCode: string;
  fromPath: boolean;
}

const ROLE_FOR_CATEGORY: Record<MechanismCategory, PartRole[]> = {
  cylinder: ['rod', 'body', 'table'],
  slide: ['table', 'body', 'carriage'],
  gripper: ['finger', 'body'],
  rotary: ['table', 'body', 'shaft'],
  ballscrew: ['nut', 'screw', 'table', 'carriage', 'body'],
  rail: ['carriage', 'rail', 'table'],
  motor: ['shaft', 'body']
};

function pathText(mesh: AutoKinMesh): string {
  return (mesh.path ?? []).join(' / ');
}

/** 去掉件角色词与左右/序号尾缀后的名称主干，用于无型号时把同名机构的各件归到一起。 */
function nameStem(name: string): string {
  let stem = name;
  for (const rule of ROLE_RULES) stem = stem.replace(new RegExp(rule.pattern.source, 'gi'), '');
  stem = stem.replace(/[_\-\s]*(?:L|R|左|右|上|下|\d+)$/i, '');
  return stem.replace(/[_\-\s]+$/g, '').replace(/^[_\-\s]+/g, '').toLowerCase();
}

function buildClusters(infos: MeshInfo[]): { clusters: Cluster[]; loose: MeshInfo[] } {
  const clusters = new Map<string, Cluster>();
  const pending: MeshInfo[] = [];
  const addTo = (key: string, info: MeshInfo, category: MechanismCategory, modelCode: string, fromPath: boolean): void => {
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { key, group: info.group, category, members: [], modelCode, fromPath };
      clusters.set(key, cluster);
    }
    cluster.members.push(info);
    if (!cluster.modelCode && modelCode) cluster.modelCode = modelCode;
  };

  for (const info of infos) {
    const own = info.own;
    if (own.category && own.seriesKey) {
      addTo(`${info.group}#${own.seriesKey}`, info, own.category, own.modelCode, false);
    } else if (info.inherited.category && !own.category) {
      // 父节点名带类别（如子装配「ST1_CYL_A1_CDJ2B16-50」下的 body / rod）
      addTo(`${info.group}#path`, info, info.inherited.category, info.inherited.modelCode, true);
    } else if (own.category) {
      addTo(`${info.group}#${own.category}#${nameStem(info.mesh.name)}`, info, own.category, '', false);
    } else if (own.role) {
      pending.push(info);
    }
  }

  // 只有角色、没有类别的件（finger_L、活塞杆…）：并入同组内包围盒相接且角色相容的最近机构
  const loose: MeshInfo[] = [];
  for (const info of pending) {
    let best: { cluster: Cluster; gap: number } | null = null;
    for (const cluster of clusters.values()) {
      if (cluster.group !== info.group) continue;
      if (!ROLE_FOR_CATEGORY[cluster.category].includes(info.own.role)) continue;
      const gap = Math.min(...cluster.members.map((member) => boxGap(member.mesh, info.mesh)));
      const tolerance = Math.max(2, 0.1 * Math.max(...info.mesh.size));
      if (gap <= tolerance && (!best || gap < best.gap)) best = { cluster, gap };
    }
    if (best) best.cluster.members.push(info);
    else loose.push(info);
  }

  return { clusters: [...clusters.values()], loose };
}

// ---------------------------------------------------------------- 各类机构分析

interface Draft {
  category: MechanismCategory;
  name: string;
  moving: MeshInfo[];
  fixed: MeshInfo[];
  kind: KinematicsKind;
  vector: Vec3;
  travelMm: number;
  rangeDeg: number;
  strokeSource: StrokeSource;
  modelCode: string;
  score: number;
  reasons: string[];
}

interface Skip {
  skip: string;
}

function nameEvidence(cluster: Cluster, reasons: string[]): number {
  const label = CATEGORY_LABELS[cluster.category];
  if (cluster.modelCode) {
    reasons.push(`${cluster.fromPath ? '父装配' : '零件名'}含型号 ${cluster.modelCode}（${label}）`);
    return 0.35;
  }
  const hit = cluster.members.flatMap((member) => member.own.hits.concat(member.inherited.hits))[0] ?? label;
  reasons.push(`${cluster.fromPath ? '父装配名' : '零件名'}含关键词「${hit}」（${label}）`);
  return 0.25;
}

function strokeFromCluster(cluster: Cluster): { strokeMm: number | null; rangeDeg: number | null; source: StrokeSource; railLengthMm: number | null } {
  for (const member of cluster.members) {
    for (const cls of [member.own, member.inherited]) {
      if (cls.strokeMm !== null || cls.rangeDeg !== null) {
        return { strokeMm: cls.strokeMm, rangeDeg: cls.rangeDeg, source: cls.strokeSource, railLengthMm: cls.railLengthMm };
      }
    }
  }
  const railLengthMm = cluster.members.map((member) => member.own.railLengthMm ?? member.inherited.railLengthMm).find((value) => value !== null) ?? null;
  return { strokeMm: null, rangeDeg: null, source: 'none', railLengthMm };
}

function nearestStandardStroke(value: number): number {
  let best = STANDARD_STROKES[0]!;
  for (const candidate of STANDARD_STROKES) if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  return best;
}

function displayName(cluster: Cluster, station: string): string {
  const label = CATEGORY_LABELS[cluster.category];
  const tag = cluster.modelCode || cluster.members[0]?.mesh.name || label;
  return [station, label, tag].filter(Boolean).join(' ');
}

function analyzeCylinder(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  let score = nameEvidence(cluster, reasons);
  const members = cluster.members;
  let rod = members.find((member) => member.own.role === 'rod');
  let body = members.find((member) => member.own.role === 'body');
  if (members.length >= 2 && (!rod || !body)) {
    // 没写角色：最细长、半径最小的当活塞杆，体积最大的当缸体
    const byRadius = [...members].sort((a, b) => a.shape.radius - b.shape.radius);
    const byVolume = [...members].sort((a, b) => volume(b.mesh) - volume(a.mesh));
    rod = rod ?? byRadius.find((member) => member !== body);
    body = body ?? byVolume.find((member) => member !== rod);
    if (rod && body) reasons.push('未写件角色，按「最细件为活塞杆、最大件为缸体」推断');
  }
  const stroke = strokeFromCluster(cluster);

  if (!rod || !body || rod === body) {
    const only = members[0]!;
    if (only.shape.elongation < 1.3) return { skip: '气缸只有一个网格且不细长，无法判断运动方向' };
    reasons.push('缸体与活塞杆未拆分，整件按最长轴作为动件（仅供参考）');
    const travel = stroke.strokeMm ?? 0;
    if (stroke.strokeMm !== null) {
      reasons.push(`行程 ${stroke.strokeMm} mm 取自型号`);
      score += 0.1;
    } else reasons.push('行程无法从单件几何确定，请填写');
    return {
      category: 'cylinder',
      name: '',
      moving: [only],
      fixed: [],
      kind: 'linear',
      vector: only.shape.axes[0],
      travelMm: travel,
      rangeDeg: 0,
      strokeSource: stroke.strokeMm !== null ? stroke.source : 'none',
      modelCode: cluster.modelCode,
      score: score - 0.05,
      reasons
    };
  }

  const rodAxis = rod.shape.elongation >= 1.5 ? rod.shape.axes[0] : normalize(sub(rod.mesh.center, body.mesh.center));
  const bodyCross = Math.max(body.shape.extents[1], body.shape.extents[2], 1);
  const lineDistance = distanceToLine(body.mesh.center, rod.mesh.center, rodAxis);
  const bodyAxisKnown = body.shape.elongation >= 1.3;
  const angle = bodyAxisKnown ? axisAngleDeg(rodAxis, body.shape.axes[0]) : 0;
  const coaxial = lineDistance <= Math.max(2, 0.2 * bodyCross) && angle <= 8 && rod.shape.radius < body.shape.radius;
  if (coaxial) {
    score += 0.3;
    reasons.push(
      `活塞杆轴线与缸体${bodyAxisKnown ? '轴线' : '中心'}同轴（偏距 ${round(lineDistance, 1)} mm${bodyAxisKnown ? `，夹角 ${round(angle, 1)}°` : ''}）→ 沿缸轴直线运动`
    );
    if (rod.shape.round) {
      score += 0.05;
      reasons.push('活塞杆截面近似圆形');
    }
  } else {
    score -= 0.1;
    reasons.push(`活塞杆与缸体不同轴（偏距 ${round(lineDistance, 1)} mm，夹角 ${round(angle, 1)}°），方向可信度低`);
  }

  // 伸出方向：活塞杆露出缸体的一侧
  const rodRange = projectBox(rod.mesh, rodAxis);
  const bodyRange = projectBox(body.mesh, rodAxis);
  const plusOut = rodRange[1] - bodyRange[1];
  const minusOut = bodyRange[0] - rodRange[0];
  const vector = plusOut >= minusOut ? rodAxis : scale(rodAxis, -1);
  const exposure = Math.max(plusOut, minusOut);

  let travelMm = 0;
  let source: StrokeSource = 'none';
  if (stroke.strokeMm !== null) {
    travelMm = stroke.strokeMm;
    source = stroke.source;
    score += 0.15;
    reasons.push(`行程 ${travelMm} mm 取自型号 ${cluster.modelCode || ''}`.trim());
  } else {
    const rodLength = rodRange[1] - rodRange[0];
    const inside = rodLength - Math.max(0, exposure);
    const estimate = inside - 0.1 * (bodyRange[1] - bodyRange[0]);
    if (estimate > 2) {
      travelMm = nearestStandardStroke(estimate);
      source = 'geometry';
      score += 0.05;
      reasons.push(`行程按几何估算：活塞杆缸内长度约 ${round(inside, 1)} mm → 取标准行程 ${travelMm} mm，请核对`);
    } else {
      reasons.push('行程无法从几何确定，请填写');
    }
  }
  if (travelMm > 0 && exposure >= 0.8 * travelMm) {
    score -= 0.1;
    reasons.push(`活塞杆外露 ${round(exposure, 1)} mm ≥ 行程 80%，模型可能处于伸出状态，请确认缩回位`);
  }
  const moving = members.filter((member) => member !== body && member.own.role !== 'body');
  return {
    category: 'cylinder',
    name: '',
    moving,
    fixed: [body],
    kind: 'linear',
    vector,
    travelMm,
    rangeDeg: 0,
    strokeSource: source,
    modelCode: cluster.modelCode,
    score,
    reasons
  };
}

function volume(mesh: AutoKinMesh): number {
  return Math.max(mesh.size[0], 0) * Math.max(mesh.size[1], 0) * Math.max(mesh.size[2], 0);
}

function analyzeSlide(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  let score = nameEvidence(cluster, reasons);
  const members = cluster.members;
  const table = members.find((member) => member.own.role === 'table' || member.own.role === 'carriage');
  const body = members.find((member) => member.own.role === 'body') ?? [...members].sort((a, b) => volume(b.mesh) - volume(a.mesh)).find((member) => member !== table);
  const stroke = strokeFromCluster(cluster);
  const reference = body ?? members[0]!;
  const axis = reference.shape.axes[0];
  let vector = axis;
  if (table && body && table !== body) {
    const offset = dot(sub(table.mesh.center, body.mesh.center), axis);
    if (offset < -0.5) vector = scale(axis, -1);
    score += 0.2;
    reasons.push('台面与本体分件，沿本体长轴直线运动');
  } else {
    score -= 0.1;
    reasons.push('台面与本体未拆分，整件按长轴作为动件（仅供参考）');
  }
  let travelMm = 0;
  let source: StrokeSource = 'none';
  if (stroke.strokeMm !== null) {
    travelMm = stroke.strokeMm;
    source = stroke.source;
    score += 0.15;
    reasons.push(`行程 ${travelMm} mm 取自型号`);
  } else if (table && body && table !== body) {
    const diff = body.shape.extents[0] - table.shape.extents[0];
    if (diff > 2) {
      travelMm = round(diff, 1);
      source = 'geometry';
      score += 0.05;
      reasons.push(`行程按几何估算：本体长 − 台面长 ≈ ${travelMm} mm`);
    }
  }
  if (travelMm === 0) reasons.push('行程无法确定，请填写');
  const moving = table && table !== body ? members.filter((member) => member !== body) : [reference];
  return {
    category: 'slide',
    name: '',
    moving,
    fixed: table && body && table !== body ? [body] : [],
    kind: 'linear',
    vector,
    travelMm,
    rangeDeg: 0,
    strokeSource: source,
    modelCode: cluster.modelCode,
    score,
    reasons
  };
}

function analyzeGripper(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  let score = nameEvidence(cluster, reasons);
  const fingers = cluster.members.filter((member) => member.own.role === 'finger');
  const body = cluster.members.find((member) => member.own.role === 'body' || member.own.role === '');
  const stroke = strokeFromCluster(cluster);
  if (fingers.length === 0) {
    if (cluster.members.length === 1) return { skip: '夹爪只有一个网格（手指未拆分），无法生成开合运动' };
    return { skip: '夹爪未识别到手指零件（名称需含 finger / jaw / 手指 / 爪）' };
  }
  const sorted = [...fingers].sort((a, b) => a.mesh.name.localeCompare(b.mesh.name));
  const first = sorted[0]!;
  let vector: Vec3;
  if (sorted.length >= 2) {
    vector = normalize(sub(sorted[1]!.mesh.center, first.mesh.center));
    score += 0.3;
    reasons.push(`两指连线为开合方向，「${first.mesh.name}」向「${sorted[1]!.mesh.name}」方向夹紧`);
    reasons.push(`对侧手指「${sorted[1]!.mesh.name}」需另行标注（同一点位只能绑定一个动件）`);
  } else if (body) {
    // 单指：去掉沿本体最短轴（通常是手指安装面法向）的分量，剩下的指向本体中心作为夹紧方向
    const toward = sub(body.mesh.center, first.mesh.center);
    const normal = body.shape.axes[2];
    const inPlane = sub(toward, scale(normal, dot(toward, normal)));
    vector = length(inPlane) > 1e-6 ? normalize(inPlane) : normalize(toward);
    score += 0.1;
    reasons.push('只找到一根手指，按手指指向本体中心推测夹紧方向');
  } else {
    return { skip: '夹爪只找到手指、缺少本体或对侧手指，无法推测开合方向' };
  }
  let travelMm = 0;
  let source: StrokeSource = 'none';
  if (stroke.strokeMm !== null) {
    travelMm = stroke.strokeMm;
    source = stroke.source;
    score += 0.1;
    reasons.push(`单指行程 ${travelMm} mm（${cluster.modelCode || '型号'} 开闭总行程 ${travelMm * 2} mm 的一半，按样本表）`);
  } else {
    reasons.push('夹爪行程无法从几何确定，请填写单指行程');
  }
  return {
    category: 'gripper',
    name: '',
    moving: [first],
    fixed: body ? [body] : [],
    kind: 'linear',
    vector,
    travelMm,
    rangeDeg: 0,
    strokeSource: source,
    modelCode: cluster.modelCode,
    score,
    reasons
  };
}

function analyzeRotary(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  let score = nameEvidence(cluster, reasons);
  const members = cluster.members;
  const table = members.find((member) => member.own.role === 'table' || member.own.role === 'shaft');
  const body = members.find((member) => member.own.role === 'body') ?? members.find((member) => member !== table);
  const stroke = strokeFromCluster(cluster);
  const target = table ?? members[0]!;
  const flat = target.shape.flatness < 0.6;
  let vector: Vec3 = flat ? target.shape.axes[2] : target.shape.axes[0];
  if (table && body && table !== body) {
    if (dot(sub(table.mesh.center, body.mesh.center), vector) < 0) vector = scale(vector, -1);
    score += 0.2;
    reasons.push(`转轴取台面「${table.mesh.name}」${flat ? '法向（最薄方向）' : '长轴'}，台面与本体分件`);
    if (target.shape.round) {
      score += 0.1;
      reasons.push('台面近似圆盘，回转特征明显');
    }
  } else {
    score -= 0.1;
    reasons.push('台面未拆分，整件绕最薄方向旋转（仅供参考）');
  }
  let rangeDeg = 90;
  let source: StrokeSource = 'default';
  if (stroke.rangeDeg !== null) {
    rangeDeg = stroke.rangeDeg;
    source = stroke.source;
    score += 0.1;
    reasons.push(source === 'catalog' ? `角度 ${rangeDeg}°（${cluster.modelCode} 标准品，按样本表）` : `角度 ${rangeDeg}° 取自名称`);
  } else {
    reasons.push('角度未知，按 90° 预填，请核对');
  }
  return {
    category: 'rotary',
    name: '',
    moving: table && table !== body ? members.filter((member) => member !== body) : [target],
    fixed: table && body && table !== body ? [body] : [],
    kind: 'rotary',
    vector,
    travelMm: 0,
    rangeDeg,
    strokeSource: source,
    modelCode: cluster.modelCode,
    score,
    reasons
  };
}

/** 导轨 + 滑块 / 丝杆 + 螺母：沿导轨（丝杆）长轴运动，行程 = 导轨长 − 滑块长。 */
function analyzeGuide(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  let score = nameEvidence(cluster, reasons);
  const isScrew = cluster.category === 'ballscrew';
  const guideRole: PartRole = isScrew ? 'screw' : 'rail';
  const members = cluster.members;
  const guide =
    members.find((member) => member.own.role === guideRole) ??
    [...members].sort((a, b) => b.shape.elongation - a.shape.elongation)[0]!;
  if (guide.shape.elongation < 3) return { skip: `${CATEGORY_LABELS[cluster.category]}未找到细长的${isScrew ? '丝杆' : '导轨'}件` };
  const axis = guide.shape.axes[0];
  const guideRange = projectBox(guide.mesh, axis);
  const riders = members.filter((member) => {
    if (member === guide) return false;
    const [lo, hi] = projectBox(member.mesh, axis);
    return lo >= guideRange[0] - 1 && hi <= guideRange[1] + 1 && boxGap(member.mesh, guide.mesh) <= 1;
  });
  if (riders.length === 0) {
    return { skip: `${CATEGORY_LABELS[cluster.category]}「${guide.mesh.name}」上没有找到${isScrew ? '螺母' : '滑块'}，导轨本身不动` };
  }
  score += 0.3;
  reasons.push(`${riders.map((rider) => `「${rider.mesh.name}」`).join('、')}骑在${isScrew ? '丝杆' : '导轨'}上 → 沿其长轴直线运动`);
  let lo = Infinity;
  let hi = -Infinity;
  for (const rider of riders) {
    const [a, b] = projectBox(rider.mesh, axis);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  const stroke = strokeFromCluster(cluster);
  const guideLength = stroke.railLengthMm ?? guideRange[1] - guideRange[0];
  if (stroke.railLengthMm !== null) reasons.push(`导轨长度 ${stroke.railLengthMm} mm 取自名称`);
  const full = round(guideLength - (hi - lo), 1);
  const roomPlus = round(guideRange[1] - hi, 1);
  const roomMinus = round(lo - guideRange[0], 1);
  const vector = roomPlus >= roomMinus ? axis : scale(axis, -1);
  const travelMm = Math.max(roomPlus, roomMinus);
  if (Math.min(roomPlus, roomMinus) > Math.max(2, 0.02 * full)) {
    score -= 0.05;
    reasons.push(`滑块不在行程端点：行程按当前位置到远端 ${travelMm} mm 计，全行程约 ${full} mm`);
  } else {
    const near = Math.min(roomPlus, roomMinus);
    reasons.push(
      near > 0.05
        ? `行程按滑块所在端到远端计 ≈ ${travelMm} mm（滑块距近端 ${near} mm，导轨长 − 滑块长 ≈ ${full} mm）`
        : `行程 = 导轨长 − 滑块长 ≈ ${travelMm} mm`
    );
  }
  if (!isScrew) reasons.push('导轨是被动导向件，驱动点位需按实际驱动源绑定');
  return {
    category: cluster.category,
    name: '',
    moving: riders,
    fixed: [guide],
    kind: 'linear',
    vector,
    travelMm: travelMm > 0 ? travelMm : 0,
    rangeDeg: 0,
    strokeSource: travelMm > 0 ? 'geometry' : 'none',
    modelCode: cluster.modelCode,
    score,
    reasons
  };
}

function analyzeMotor(cluster: Cluster): Draft | Skip {
  const reasons: string[] = [];
  nameEvidence(cluster, reasons);
  const target = cluster.members.find((member) => member.own.role === 'shaft') ?? cluster.members[0]!;
  const vector = target.shape.elongation >= 1.2 ? target.shape.axes[0] : target.shape.axes[2];
  reasons.push('电机本体固定，实际转动的是输出轴/负载；绕电机轴线旋转仅供参考，按 360° 预填');
  return {
    category: 'motor',
    name: '',
    moving: [target],
    fixed: [],
    kind: 'rotary',
    vector,
    travelMm: 0,
    rangeDeg: 360,
    strokeSource: 'default',
    modelCode: cluster.modelCode,
    // 电机最多给到低置信度
    score: 0.35,
    reasons
  };
}

function analyzeCluster(cluster: Cluster): Draft | Skip {
  switch (cluster.category) {
    case 'cylinder':
      return analyzeCylinder(cluster);
    case 'slide':
      return analyzeSlide(cluster);
    case 'gripper':
      return analyzeGripper(cluster);
    case 'rotary':
      return analyzeRotary(cluster);
    case 'rail':
    case 'ballscrew':
      return analyzeGuide(cluster);
    case 'motor':
      return analyzeMotor(cluster);
    default:
      return { skip: '未知机构类别' };
  }
}

// ---------------------------------------------------------------- IO 点位匹配

function pointCategory(option: KinematicsPointOption): MechanismCategory | null {
  const text = `${option.point} ${option.actuatorName} ${option.label}`;
  if (option.role === 'rotate' || /ROT|旋转|回转/i.test(text)) return 'rotary';
  if (/GRIP|CLAMP|夹爪|夹紧|手指/i.test(text)) return 'gripper';
  const cls = classifyName(option.actuatorName);
  if (cls.category) return cls.category;
  if (/EXT|RET|伸出|缩回|气缸|CYL/i.test(text)) return 'cylinder';
  return null;
}

function categoryCompatible(suggestion: MechanismCategory, point: MechanismCategory | null): boolean {
  if (point === null) return false;
  if (suggestion === point) return true;
  const linear: MechanismCategory[] = ['cylinder', 'slide', 'ballscrew', 'rail'];
  return linear.includes(suggestion) && linear.includes(point);
}

function bigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[\s_\-/·.()（）]+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const gram of A) if (B.has(gram)) common += 1;
  return (2 * common) / (A.size + B.size);
}

interface PointContext {
  category: MechanismCategory;
  kind: KinematicsKind;
  station: string;
  index: string;
  text: string;
  modelCode: string;
}

/** 单条建议 × 单个点位的匹配分（0~1）与中文理由；类型不相容为 0。 */
export function scorePointOption(context: PointContext, option: KinematicsPointOption): PointCandidate | null {
  const wantRole: KinematicsRole = context.kind === 'rotary' ? 'rotate' : 'extend';
  if (option.role !== wantRole) return null;
  const category = pointCategory(option);
  if (!categoryCompatible(context.category, category)) return null;
  const parts: string[] = [];
  let score = category === context.category ? 0.4 : 0.35;
  parts.push(category === context.category ? '类型一致' : '同为直线机构');
  const pointStation = stationOf(`${option.point} ${option.actuatorName}`);
  if (context.station && pointStation) {
    if (context.station === pointStation) {
      score += 0.3;
      parts.push(`工位 ${pointStation} 一致`);
    } else {
      score -= 0.3;
      parts.push(`工位不一致（${context.station} ≠ ${pointStation}）`);
    }
  }
  const pointIndex = actuatorIndexOf(option.point) || actuatorIndexOf(option.actuatorName);
  if (context.index && pointIndex) {
    if (context.index === pointIndex) {
      score += 0.2;
      parts.push(`编号 ${pointIndex} 一致`);
    } else {
      score -= 0.1;
    }
  }
  if (context.modelCode && option.actuatorName.toUpperCase().includes(context.modelCode)) {
    score += 0.2;
    parts.push('执行机构名含同一型号');
  }
  const similarity = dice(context.text, option.actuatorName);
  if (similarity > 0.15) {
    score += 0.15 * similarity;
    parts.push(`名称相似 ${Math.round(similarity * 100)}%`);
  }
  return {
    point: option.point,
    role: option.role,
    actuatorName: option.actuatorName,
    score: round(Math.max(0, Math.min(1, score)), 3),
    reason: parts.join('、')
  };
}

// ---------------------------------------------------------------- 主入口

/**
 * 从导入网格推测运动学建议。只读、确定性：同一输入同一输出；不修改入参。
 * 高置信度与低置信度分开返回，UI 必须让用户逐条确认后才写入标注。
 */
export function suggestKinematics(meshes: readonly AutoKinMesh[], options: SuggestOptions = {}): SuggestResult {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minPointScore = options.minPointScore ?? DEFAULT_MIN_POINT_SCORE;
  const usedMeshes = new Set<number>();
  const usedPoints = new Set<string>();
  for (const part of options.existingParts ?? []) {
    for (const id of part.meshIds) usedMeshes.add(id);
    if (part.point.trim()) usedPoints.add(part.point.trim().toUpperCase());
  }

  const infos: MeshInfo[] = meshes.map((mesh) => {
    const path = pathText(mesh);
    return {
      mesh,
      own: classifyName(mesh.name),
      inherited: classifyName((mesh.path ?? []).slice(-1)[0] ?? ''),
      shape: analyzeMeshShape(mesh),
      group: path
    };
  });
  const { clusters, loose } = buildClusters(infos);
  const skipped: SkippedGroup[] = [];
  for (const info of loose) {
    skipped.push({
      name: info.mesh.name,
      meshIds: [info.mesh.id],
      category: null,
      reason: `只识别到件角色「${info.own.role ? ROLE_LABELS[info.own.role] : '—'}」，同组内没有可归属的机构`
    });
  }

  type Pending = { draft: Draft; cluster: Cluster; station: string };
  const pending: Pending[] = [];
  for (const cluster of clusters) {
    const result = analyzeCluster(cluster);
    const meshIds = cluster.members.map((member) => member.mesh.id);
    const station = stationOf(`${cluster.group} ${cluster.members.map((member) => member.mesh.name).join(' ')}`);
    if ('skip' in result) {
      skipped.push({ name: displayName(cluster, station), meshIds, category: cluster.category, reason: result.skip });
      continue;
    }
    if (result.moving.some((member) => usedMeshes.has(member.mesh.id))) {
      skipped.push({ name: displayName(cluster, station), meshIds, category: cluster.category, reason: '网格已在现有动件中，跳过' });
      continue;
    }
    result.name = displayName(cluster, station);
    pending.push({ draft: result, cluster, station });
  }

  // 结构证据：机构位于有意义的装配层级里（父节点非空）
  for (const item of pending) {
    if (item.cluster.group && item.draft.category !== 'motor') {
      item.draft.score += 0.05;
      item.draft.reasons.push(`装配层级：${item.cluster.group}`);
    }
  }

  // 点位：全局贪心分配（分高者先得），已被现有动件占用的点位不推荐
  const candidates: { index: number; candidate: PointCandidate }[] = [];
  const perSuggestion: PointCandidate[][] = pending.map(() => []);
  pending.forEach((item, index) => {
    const context: PointContext = {
      category: item.draft.category,
      kind: item.draft.kind,
      station: item.station,
      index: actuatorIndexOf(`${item.cluster.group} ${item.cluster.members.map((member) => member.mesh.name).join(' ')}`),
      text: item.draft.name,
      modelCode: item.draft.modelCode
    };
    for (const option of options.pointOptions ?? []) {
      if (usedPoints.has(option.point.trim().toUpperCase())) continue;
      const candidate = scorePointOption(context, option);
      if (!candidate) continue;
      perSuggestion[index]!.push(candidate);
      candidates.push({ index, candidate });
    }
  });
  candidates.sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index || a.candidate.point.localeCompare(b.candidate.point));
  const assigned = new Map<number, PointCandidate>();
  const taken = new Set<string>();
  for (const { index, candidate } of candidates) {
    if (candidate.score < minPointScore || assigned.has(index)) continue;
    const key = candidate.point.trim().toUpperCase();
    if (taken.has(key)) continue;
    assigned.set(index, candidate);
    taken.add(key);
  }

  const suggestions: KinematicsSuggestion[] = pending.map((item, index) => {
    const draft = item.draft;
    const vector = normalize(draft.vector);
    const snapped = snapAxis(vector);
    const reasons = [...draft.reasons];
    let score = draft.score;
    if (snapped.offAxisDeg > 3) {
      score -= Math.min(0.3, snapped.offAxisDeg / 100);
      reasons.push(`运动方向与 ${snapped.direction < 0 ? '-' : '+'}${snapped.axis.toUpperCase()} 轴偏 ${snapped.offAxisDeg}°，标注层只支持主轴方向，已取最近主轴`);
    }
    if (draft.kind === 'linear') reasons.push('以模型当前位置为缩回位（0 mm）');
    const point = assigned.get(index);
    const list = perSuggestion[index]!.sort((a, b) => b.score - a.score).slice(0, 3);
    if (point) reasons.push(`建议绑定点位 ${point.point}（${point.reason}）`);
    else if ((options.pointOptions ?? []).length === 0) reasons.push('当前没有 IO 点位表，点位需加载机型配置后手动绑定');
    else reasons.push('IO 点位表中没有足够匹配的点位，请手动绑定');
    const confidence = round(clamp01(score), 2);
    return {
      id: `sg-${index + 1}`,
      category: draft.category,
      name: draft.name,
      meshIds: draft.moving.map((member) => member.mesh.id),
      meshNames: draft.moving.map((member) => member.mesh.name),
      fixedMeshIds: draft.fixed.map((member) => member.mesh.id),
      kind: draft.kind,
      directionVector: [round(vector[0], 4), round(vector[1], 4), round(vector[2], 4)],
      axis: snapped.axis,
      direction: snapped.direction,
      offAxisDeg: snapped.offAxisDeg,
      travelMm: draft.kind === 'linear' ? round(draft.travelMm, 2) : 0,
      retractedMm: 0,
      rangeDeg: draft.kind === 'rotary' ? draft.rangeDeg : 0,
      strokeSource: draft.strokeSource,
      modelCode: draft.modelCode,
      station: item.station,
      groupKey: mechanismGroupKey({ station: item.station, category: draft.category, group: item.cluster.group }),
      point: point?.point ?? '',
      role: point ? point.role : '',
      pointCandidates: list,
      confidence,
      level: confidence >= minConfidence ? 'high' : 'low',
      reasons,
      reason: reasons.join('；')
    };
  });

  const byConfidence = (a: KinematicsSuggestion, b: KinematicsSuggestion): number => b.confidence - a.confidence || a.id.localeCompare(b.id);
  const high = suggestions.filter((item) => item.level === 'high').sort(byConfidence);
  const low = suggestions.filter((item) => item.level === 'low').sort(byConfidence);
  const classified = infos.filter((info) => info.own.category || info.inherited.category || info.own.role).length;
  return {
    suggestions: high,
    lowConfidence: low,
    skipped,
    stats: {
      meshes: meshes.length,
      classified,
      groups: clusters.length,
      high: high.length,
      low: low.length,
      skipped: skipped.length
    }
  };
}

/** 建议 → 标注 UI 的 MovingPart（复用 draftFromMeshes，保证包围盒中心/网格引用口径一致）。 */
export function suggestionToMovingPart(suggestion: KinematicsSuggestion, meshes: readonly (AutoKinMesh | KinematicsMeshInfo)[]): MovingPart {
  const infos: KinematicsMeshInfo[] = suggestion.meshIds
    .map((id) => meshes.find((mesh) => mesh.id === id))
    .filter((mesh): mesh is AutoKinMesh | KinematicsMeshInfo => mesh !== undefined)
    .map((mesh) => ({
      id: mesh.id,
      name: mesh.name,
      triangles: mesh.triangles ?? 0,
      center: [...mesh.center] as Vec3,
      size: [...mesh.size] as Vec3
    }));
  if (infos.length === 0) throw new Error(`建议「${suggestion.name}」引用的网格不存在`);
  return draftFromMeshes(infos, {
    name: suggestion.name,
    kind: suggestion.kind,
    axis: suggestion.axis,
    direction: suggestion.direction,
    travelMm: suggestion.kind === 'linear' ? suggestion.travelMm : 0,
    retractedMm: suggestion.kind === 'linear' ? suggestion.retractedMm : 0,
    rangeDeg: suggestion.kind === 'rotary' ? suggestion.rangeDeg : 0,
    retractedDeg: 0,
    point: suggestion.point,
    role: suggestion.role
  });
}

/**
 * 用户确认后才调用：把指定 id 的建议加入动件列表并跑与人工标注相同的 validateDraft。
 * 不在 ids 里的建议一律不动；重名动件自动加序号。
 */
export function acceptSuggestions(
  parts: readonly MovingPart[],
  pool: readonly KinematicsSuggestion[],
  ids: readonly string[],
  meshes: readonly (AutoKinMesh | KinematicsMeshInfo)[],
  options: { pointOptions?: readonly KinematicsPointOption[] } = {}
): AcceptResult {
  const next = parts.map((part) => ({ ...part }));
  const accepted: string[] = [];
  const missing: string[] = [];
  const names = new Set(next.map((part) => part.name.trim().toLowerCase()));
  for (const id of ids) {
    const suggestion = pool.find((item) => item.id === id);
    if (!suggestion) {
      missing.push(id);
      continue;
    }
    const part = suggestionToMovingPart(suggestion, meshes);
    let name = part.name;
    let serial = 2;
    while (names.has(name.trim().toLowerCase())) {
      name = `${part.name} ${serial}`;
      serial += 1;
    }
    names.add(name.trim().toLowerCase());
    next.push({ ...part, name });
    accepted.push(id);
  }
  const meshInfos: KinematicsMeshInfo[] = meshes.map((mesh) => ({
    id: mesh.id,
    name: mesh.name,
    triangles: mesh.triangles ?? 0,
    center: [...mesh.center] as Vec3,
    size: [...mesh.size] as Vec3
  }));
  const validation = validateDraft(next, {
    ...(options.pointOptions ? { pointOptions: options.pointOptions } : {}),
    meshes: meshInfos
  });
  return { parts: next, accepted, missing, validation };
}

// ---------------------------------------------------------------- 批量采纳

/**
 * 批量采纳的三道门槛（逐条判定；L1「采纳全部高置信」与 L2「按机构归组」共用同一套）。
 *
 * 1) 置信度 ≥ 0.8。为什么不是 0.9：读 suggestKinematics 的加分上限可知，
 *    气缸（型号 0.35 + 同轴 0.30 + 圆截面 0.05 + 型号行程 0.15 + 装配层级 0.05）= 0.90 已是天花板，
 *    旋转台/夹爪（型号 0.35 + 分件 0.20/0.30 + 0.10 + 样本角度/行程 0.10 + 层级 0.05）= 0.80，
 *    滑台封顶 0.75、导轨 0.70（行程只能几何估算）、电机写死 0.35。
 *    0.9 等于只放行「气缸 + 型号行程」，六工位机上通常 0~2 条，批量按钮基本是死的；
 *    0.8 才是「型号/样本表行程 + 结构证据齐全」的那一档，比 DEFAULT_MIN_CONFIDENCE(0.6) 高一整档，
 *    并且把导轨、滑台、电机全挡在外面。
 * 2) 行程来源必须是 model-code / catalog。geometry 是按包围盒反推的估算，default 是「角度未知按 90°/360° 预填」，
 *    none 是没行程——这三种采纳后都要人工改；批量改 12 条的错误成本远高于逐条点。
 *    这条比置信度更硬：100% 置信的几何估算照样拒绝（见单测「批量门槛：置信度 / 行程来源 / 偏角三条互相独立」）。
 * 3) 方向明确：offAxisDeg ≤ 5°。引擎在偏角 > 3° 时按 0.3/100° 扣分，但扣分封顶 0.3，
 *    一条 0.9 的建议偏 30° 也只扣到 0.6，仍停在 high 分界上；批量必须显式看偏角，不能指望分数兜住。
 */
export const BATCH_MIN_CONFIDENCE = 0.8;
export const BATCH_MAX_OFF_AXIS_DEG = 5;
export const BATCH_STROKE_SOURCES: readonly StrokeSource[] = ['model-code', 'catalog'];

export const STROKE_SOURCE_LABELS: Record<StrokeSource, string> = {
  'model-code': '行程取自型号',
  catalog: '行程取自样本表',
  geometry: '行程为几何估算（需人工核对）',
  default: '行程/角度为默认预填值',
  none: '行程未确定'
};

export interface BatchGateOptions {
  minConfidence?: number;
  maxOffAxisDeg?: number;
  strokeSources?: readonly StrokeSource[];
}

export interface BatchGate {
  ok: boolean;
  /** 不通过时给用户看的中文原因；通过为空串。 */
  reason: string;
}

/** 单条建议能不能进批量采纳；纯函数，UI 按钮计数与采纳前复检共用这一处判定。 */
export function batchGate(suggestion: KinematicsSuggestion, options: BatchGateOptions = {}): BatchGate {
  const minConfidence = options.minConfidence ?? BATCH_MIN_CONFIDENCE;
  const maxOffAxis = options.maxOffAxisDeg ?? BATCH_MAX_OFF_AXIS_DEG;
  const sources = options.strokeSources ?? BATCH_STROKE_SOURCES;
  if (suggestion.category === 'motor') {
    return { ok: false, reason: '伺服电机按 360° 预填，仅供参考，不参与批量采纳' };
  }
  if (suggestion.confidence < minConfidence) {
    return {
      ok: false,
      reason: `置信度 ${Math.round(suggestion.confidence * 100)}% 低于批量门槛 ${Math.round(minConfidence * 100)}%`
    };
  }
  if (!sources.includes(suggestion.strokeSource)) {
    return { ok: false, reason: `${STROKE_SOURCE_LABELS[suggestion.strokeSource]}，批量采纳只接受型号或样本表行程` };
  }
  if (suggestion.offAxisDeg > maxOffAxis) {
    return { ok: false, reason: `方向偏离主轴 ${suggestion.offAxisDeg}°，已回落最近主轴，方向不可信` };
  }
  if (suggestion.kind === 'linear' && !(suggestion.travelMm > 0)) {
    return { ok: false, reason: '行程为 0，需人工填写' };
  }
  if (suggestion.kind === 'rotary' && !(suggestion.rangeDeg > 0)) {
    return { ok: false, reason: '角度为 0，需人工填写' };
  }
  if (suggestion.meshIds.length === 0) {
    return { ok: false, reason: '没有可移动的网格' };
  }
  return { ok: true, reason: '' };
}

export interface BatchSkip {
  id: string;
  name: string;
  reason: string;
}

export interface BatchSelection {
  /** 可批量采纳的建议 id，保持传入顺序。 */
  ids: string[];
  /** 被门槛挡下的建议及原因，UI 需原样展示，不做静默丢弃。 */
  skipped: BatchSkip[];
}

export function selectBatchEligible(
  suggestions: readonly KinematicsSuggestion[],
  options: BatchGateOptions = {}
): BatchSelection {
  const ids: string[] = [];
  const skipped: BatchSkip[] = [];
  for (const suggestion of suggestions) {
    const gate = batchGate(suggestion, options);
    if (gate.ok) ids.push(suggestion.id);
    else skipped.push({ id: suggestion.id, name: suggestion.name, reason: gate.reason });
  }
  return { ids, skipped };
}

export interface MechanismSuggestionGroup {
  /** 稳定组键（`工位@机构族`）。 */
  key: string;
  /** 给用户看的组名，如「ST2 夹爪」。 */
  label: string;
  family: MechanismFamily;
  station: string;
  suggestions: KinematicsSuggestion[];
  /** 组内通过批量门槛的 id。 */
  eligibleIds: string[];
  skipped: BatchSkip[];
  /** 组内固定件（缸体 / 导轨），只供 UI 展示，不写入动件。 */
  fixedMeshIds: number[];
}

/** 按 groupKey 归组；键相同的建议一次点完，顺序按 key 稳定排序（不依赖建议排序）。 */
export function groupSuggestionsByMechanism(
  suggestions: readonly KinematicsSuggestion[],
  options: BatchGateOptions = {}
): MechanismSuggestionGroup[] {
  const groups = new Map<string, MechanismSuggestionGroup>();
  for (const suggestion of suggestions) {
    const key = suggestion.groupKey;
    let group = groups.get(key);
    if (!group) {
      const family = mechanismFamily(suggestion.category);
      group = {
        key,
        family,
        station: suggestion.station,
        label: `${suggestion.station ? `${suggestion.station} ` : ''}${MECHANISM_FAMILY_LABELS[family]}`,
        suggestions: [],
        eligibleIds: [],
        skipped: [],
        fixedMeshIds: []
      };
      groups.set(key, group);
    }
    group.suggestions.push(suggestion);
    const gate = batchGate(suggestion, options);
    if (gate.ok) group.eligibleIds.push(suggestion.id);
    else group.skipped.push({ id: suggestion.id, name: suggestion.name, reason: gate.reason });
    for (const id of suggestion.fixedMeshIds) {
      if (!group.fixedMeshIds.includes(id)) group.fixedMeshIds.push(id);
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function cloneMovingPart(part: MovingPart): MovingPart {
  return {
    ...part,
    meshIds: [...part.meshIds],
    meshNames: [...part.meshNames],
    ...(part.meshObjectIds ? { meshObjectIds: [...part.meshObjectIds] } : {}),
    center: [...part.center] as [number, number, number],
    size: [...part.size] as [number, number, number]
  };
}

function toMeshInfos(meshes: readonly (AutoKinMesh | KinematicsMeshInfo)[]): KinematicsMeshInfo[] {
  return meshes.map((mesh) => ({
    id: mesh.id,
    name: mesh.name,
    triangles: mesh.triangles ?? 0,
    center: [...mesh.center] as [number, number, number],
    size: [...mesh.size] as [number, number, number]
  }));
}

export interface BatchAcceptAudit {
  /** 记录号；默认 `ba-<scope>-<时间戳>`，也可由调用方指定（测试/重放用）。 */
  recordId: string;
  at: string;
  scope: 'high-confidence' | 'mechanism';
  /** 中文摘要，如「采纳全部高置信 3 条」「ST1 直线驱动 2 条」。 */
  label: string;
  suggestionIds: string[];
  addedPartIds: string[];
  addedNames: string[];
  beforeCount: number;
  afterCount: number;
  /** 采纳前动件快照（深拷贝）；撤销按它精确还原，不是「删掉新加的那几条」这种近似。 */
  before: MovingPart[];
}

export interface BatchAcceptOptions {
  pointOptions?: readonly KinematicsPointOption[];
  scope: BatchAcceptAudit['scope'];
  label: string;
  /**
   * 批量结果不得比采纳前新增校验错误，默认 true（全有或全无）。
   * 这条是「不能半途而废」的兜底：批量塞进去一条缺点位 / 行程非法的动件时整批回滚，
   * 不会留下「前 5 条进去了、第 6 条炸了」的半成品状态。
   */
  rejectNewErrors?: boolean;
  gate?: BatchGateOptions;
  at?: string;
  recordId?: string;
}

export interface BatchAcceptOutcome {
  ok: boolean;
  /** ok=false 时等于采纳前状态（深拷贝），调用方可以无条件用它对回本地 parts。 */
  parts: MovingPart[];
  audit: BatchAcceptAudit | null;
  acceptedIds: string[];
  skipped: BatchSkip[];
  missingIds: string[];
  error: string;
  validation: DraftValidation;
}

/**
 * 批量采纳：逐条过门槛 → 一次性走 acceptSuggestions（同一套校验规则）→ 失败/新增错误则整批回滚。
 * 不修改入参；成功时返回新数组 + 一条可撤销审计记录。
 */
export function applyBatchAccept(
  parts: readonly MovingPart[],
  pool: readonly KinematicsSuggestion[],
  ids: readonly string[],
  meshes: readonly (AutoKinMesh | KinematicsMeshInfo)[],
  options: BatchAcceptOptions
): BatchAcceptOutcome {
  const before = parts.map(cloneMovingPart);
  const pointOptions = options.pointOptions ?? [];
  const validationOptions = {
    ...(pointOptions.length > 0 ? { pointOptions } : {}),
    meshes: toMeshInfos(meshes)
  };
  const baseValidation = validateDraft(before, validationOptions);
  const at = options.at ?? new Date().toISOString();
  const rejectNewErrors = options.rejectNewErrors ?? true;
  const requested = [...new Set(ids)];
  const missingIds: string[] = [];
  const picked: KinematicsSuggestion[] = [];
  for (const id of requested) {
    const suggestion = pool.find((item) => item.id === id);
    if (suggestion) picked.push(suggestion);
    else missingIds.push(id);
  }
  const selection = selectBatchEligible(picked, options.gate);
  const rollback = (error: string, validation: DraftValidation = baseValidation): BatchAcceptOutcome => ({
    ok: false,
    parts: before.map(cloneMovingPart),
    audit: null,
    acceptedIds: [],
    skipped: selection.skipped,
    missingIds,
    error,
    validation
  });
  if (requested.length === 0) return rollback('没有传入要批量采纳的建议');
  if (selection.ids.length === 0) return rollback('没有满足批量条件的建议（需高置信 + 型号/样本表行程 + 方向明确）');
  let accepted: AcceptResult;
  try {
    accepted = acceptSuggestions(before, pool, selection.ids, meshes, pointOptions.length > 0 ? { pointOptions } : {});
  } catch (error) {
    return rollback(`批量采纳失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (rejectNewErrors && accepted.validation.errors.length > baseValidation.errors.length) {
    const first = accepted.validation.errors[0];
    return rollback(
      `批量采纳会让校验错误从 ${baseValidation.errors.length} 增至 ${accepted.validation.errors.length}` +
        `${first ? `（${first.message}）` : ''}，已整批回滚`,
      accepted.validation
    );
  }
  const added = accepted.parts.slice(before.length);
  const audit: BatchAcceptAudit = {
    recordId: options.recordId ?? `ba-${options.scope}-${at}`,
    at,
    scope: options.scope,
    label: options.label,
    suggestionIds: [...selection.ids],
    addedPartIds: added.map((part) => part.id),
    addedNames: added.map((part) => part.name),
    beforeCount: before.length,
    afterCount: accepted.parts.length,
    before: before.map(cloneMovingPart)
  };
  return {
    ok: true,
    parts: accepted.parts.map(cloneMovingPart),
    audit,
    acceptedIds: [...selection.ids],
    skipped: selection.skipped,
    missingIds,
    error: '',
    validation: accepted.validation
  };
}

export interface BatchUndoOutcome {
  ok: boolean;
  parts: MovingPart[];
  removedIds: string[];
  reason: string;
}

/**
 * 撤销一次批量采纳：用审计记录里的快照还原（总数、每条字段逐一相同）。
 * 若批量采纳后用户手动删/改了那批动件，则拒绝撤销并说明原因——不做「猜用户想回到哪」的还原。
 */
export function undoBatchAccept(parts: readonly MovingPart[], audit: BatchAcceptAudit): BatchUndoOutcome {
  const missing = audit.addedPartIds.filter((id) => !parts.some((part) => part.id === id));
  if (missing.length > 0) {
    return {
      ok: false,
      parts: parts.map(cloneMovingPart),
      removedIds: [],
      reason: `批量采纳后的动件已被删除或替换（${missing.join('、')}），无法精确撤销`
    };
  }
  return { ok: true, parts: audit.before.map(cloneMovingPart), removedIds: [...audit.addedPartIds], reason: '' };
}

/** 中文一句话概要，供 UI 状态行 / 冒烟输出。 */
export function describeSuggestions(result: SuggestResult): string {
  const { stats } = result;
  if (stats.high + stats.low === 0) return `未识别到动件（${stats.meshes} 个网格，${stats.skipped} 组跳过）`;
  return `识别到 ${stats.high} 条高置信度、${stats.low} 条低置信度建议（${stats.meshes} 个网格，${stats.skipped} 组跳过），需逐条确认后才写入标注`;
}
