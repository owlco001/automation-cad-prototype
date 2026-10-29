// 整机示意几何的**干涉初筛**（AABB）。
// 口径必须写死：这是先筛一遍「疑似」，不是布尔交集，不能当干涉体积用。
// 结构件之间本来就会共位（立柱插进横梁），但**只放行显式声明过的连接**（见 joints.ts），
// 没声明的重叠一律算「需人工确认」——否则真正的结构撞车会被「都是结构件」一起放行。

/** declared = 已在 joints.ts 声明过的结构连接；suspect = 没声明，需要人看 */
export type ScreenKind = 'declared' | 'suspect';

import { declaredJoints, jointKey } from './joints.ts';

export interface ScreenPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  aRole: string;
  bRole: string;
  /** declared / suspect */
  kind: ScreenKind;
  /** declared 时给出原因（如「立柱插横梁」） */
  reason?: string;
  /** 让这一对分开的最小轴向外移建议（谁动、往哪动、多少 mm） */
  suggestion?: { partId: string; axis: 'x' | 'y' | 'z'; delta: number };
  /** AABB 重叠体积（mm³），只作排序/量级参考 */
  overlapMm3: number;
  overlapBox: [number, number, number];
}

export interface ScreenResult {
  /** aabb = 轴对齐包围盒初筛；不是真实布尔交集 */
  mode: 'aabb';
  partCount: number;
  pairs: ScreenPair[];
  count: number;
  /** 按判定拆分：declared=已声明连接，suspect=需人工确认 */
  declared: number;
  suspects: number;
  /** 声明连接的数量（可能比 overlapping 的多：声明了但没重叠） */
  declaredJoints: number;
  /** generator = 由几何生成器产出；rules = 退回命名规则（老数据） */
  jointSource: 'generator' | 'rules';
  /** 全部重叠都是已声明连接时为 true */
  structuralOnly: boolean;
}

type Vec3 = [number, number, number];

/** 建议位移里预留给「刚好贴住」之外的间隙（mm） */
const GAP = 1;

function halfExtents(part: any): Vec3 {
  const shape = part.shape || {};
  if (shape.type === 'box') {
    const [x, y, z] = shape.size as Vec3;
    return [x / 2, y / 2, z / 2];
  }
  const radius = Number(shape.radius) || 0;
  const length = Number(shape.length) || 0;
  if (shape.axis === 'x') return [length / 2, radius, radius];
  if (shape.axis === 'y') return [radius, length / 2, radius];
  return [radius, radius, length / 2];
}

/** 绕 Z 旋转后的轴对齐包围盒（mm）。 */
export function partBounds(part: any): { min: Vec3; max: Vec3 } {
  const [hx, hy, hz] = halfExtents(part);
  const rad = ((Number(part.rotationZDeg) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const isCylinder = part?.shape?.type === 'cylinder';
  // 圆柱绕自身 Z 轴转，包围盒不变。按「旋转的方块」算会把半径方向放大到 √2 倍，
  // 从而凭空造出一堆假重叠（实测六工位机里 12 对就是这么来的）。
  const ex = isCylinder ? hx : hx * cos + hy * sin;
  const ey = isCylinder ? hy : hx * sin + hy * cos;
  const center = part.center as Vec3;
  return {
    min: [center[0] - ex, center[1] - ey, center[2] - hz],
    max: [center[0] + ex, center[1] + ey, center[2] + hz]
  };
}

function extentVolume(part: any): number {
  const [hx, hy, hz] = halfExtents(part);
  return hx * hy * hz * 8;
}

export interface ScreenOptions {
  /**
   * 已由真实布尔确认「AABB 误报」的对（`jointKey(a,b)`），初筛直接跳过。
   * 只该放进来**复核过**的对：没复核过的照旧算 suspect，不能靠猜。
   */
  ignorePairs?: string[];
}

export function screenInterference(geometry: any, options: ScreenOptions = {}): ScreenResult {
  const ignored = new Set(options.ignorePairs ?? []);
  const parts = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const boxes = parts.map((part: any) => ({ part, bounds: partBounds(part) }));
  // 优先用生成器自己产出的 joints（几何=唯一事实来源）；
  // 老数据/外部 geometry 没有 joints 字段时，退回按命名规则的表，并在结果里标出来源。
  const generatorJoints = Array.isArray(geometry?.joints) ? geometry.joints : [];
  const declared = new Map<string, string>();
  for (const joint of declaredJoints(parts)) {
    declared.set(jointKey(joint.a, joint.b), joint.reason);
  }
  for (const joint of generatorJoints) {
    if (typeof joint?.a !== 'string' || typeof joint?.b !== 'string') continue;
    declared.set(jointKey(joint.a, joint.b), String(joint.reason ?? '生成器声明的结构连接'));
  }
  const jointSource = generatorJoints.length > 0 ? 'generator' : 'rules';
  const pairs: ScreenPair[] = [];
  const EPS = 0.5;  // mm：小于这个量的接触（贴面/装配面）不算
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].bounds;
      const b = boxes[j].bounds;
      const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
      const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
      const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
      if (dx <= EPS || dy <= EPS || dz <= EPS) continue;
      if (ignored.has(jointKey(String(boxes[i].part.id), String(boxes[j].part.id)))) continue;
      const reason = declared.get(jointKey(String(boxes[i].part.id), String(boxes[j].part.id)));
      // 分开代价最小的方案：逐轴算「往 + / 往 -」各自要挪多远，取全局最小。
      // 注意不能直接拿重叠量当位移：移动件一旦越过对方边界，所需位移会比重叠量更大
      //（实测下横梁 40mm 重叠却要挪 51mm 才真的分开）。
      const iPart = boxes[i].part;
      const jPart = boxes[j].part;
      const iVolume = extentVolume(iPart);
      const jVolume = extentVolume(jPart);
      const mover = iVolume <= jVolume ? iPart : jPart;
      const other = iVolume <= jVolume ? jPart : iPart;
      const moverBounds = partBounds(mover);
      const otherBounds = partBounds(other);
      // 逐个下标取用会命中 noUncheckedIndexedAccess（number | undefined），摊平成数组再索引
      const moverMin: number[] = [...moverBounds.min];
      const moverMax: number[] = [...moverBounds.max];
      const otherMin: number[] = [...otherBounds.min];
      const otherMax: number[] = [...otherBounds.max];
      let bestAxis: 'x' | 'y' | 'z' = 'x';
      let bestDelta = Number.POSITIVE_INFINITY;
      (['x', 'y', 'z'] as const).forEach((axis, index) => {
        const plus = (otherMax[index] ?? 0) - (moverMin[index] ?? 0) + GAP;
        const minus = (moverMax[index] ?? 0) - (otherMin[index] ?? 0) + GAP;
        if (plus < bestDelta) {
          bestDelta = plus;
          bestAxis = axis;
        }
        if (minus < bestDelta) {
          bestDelta = minus;
          bestAxis = axis;
        }
      });
      const axisIndex = bestAxis === 'x' ? 0 : bestAxis === 'y' ? 1 : 2;
      // 方向：优先「往远离对方中心的那一侧」
      const centerGap = Number(mover.center[axisIndex]) - Number(other.center[axisIndex]);
      const sign = centerGap > 0 ? 1 : centerGap < 0 ? -1 : 1;
      const plusNeed = (otherMax[axisIndex] ?? 0) - (moverMin[axisIndex] ?? 0) + GAP;
      const minusNeed = (moverMax[axisIndex] ?? 0) - (otherMin[axisIndex] ?? 0) + GAP;
      const delta = sign > 0 ? plusNeed : -minusNeed;
      const suggestion = {
        partId: String(mover.id),
        axis: bestAxis,
        delta: Math.round(delta * 10) / 10
      };
      pairs.push({
        kind: reason ? 'declared' : 'suspect',
        ...(reason ? { reason } : {}),
        a: boxes[i].part.id,
        b: boxes[j].part.id,
        aName: boxes[i].part.name,
        bName: boxes[j].part.name,
        aRole: boxes[i].part.role,
        bRole: boxes[j].part.role,
        suggestion,
        overlapMm3: Math.round(dx * dy * dz * 10) / 10,
        overlapBox: [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100, Math.round(dz * 100) / 100]
      });
    }
  }
  // 需人工确认的排前面：结构共位是常态，先看 suspect 才有意义
  pairs.sort((x, y) => (x.kind === y.kind ? y.overlapMm3 - x.overlapMm3 : x.kind === 'suspect' ? -1 : 1));
  const suspects = pairs.filter((pair) => pair.kind === 'suspect').length;
  return {
    mode: 'aabb',
    partCount: parts.length,
    pairs,
    count: pairs.length,
    declared: pairs.length - suspects,
    suspects,
    declaredJoints: declared.size,
    jointSource,
    structuralOnly: pairs.length > 0 && suspects === 0
  };
}
