// 整机示意几何的**干涉初筛**（AABB）。
// 口径必须写死：这是先筛一遍「疑似」，不是布尔交集，不能当干涉体积用。
// 结构件之间本来就会共位（立柱插进横梁），所以初筛结果要连角色一起给出来，让人判断。

export interface ScreenPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  aRole: string;
  bRole: string;
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
  /** 全部疑似对都是结构件之间（立柱/横梁/台面）时给出提示，避免被当成设计缺陷 */
  structuralOnly: boolean;
}

type Vec3 = [number, number, number];

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
  const ex = hx * cos + hy * sin;
  const ey = hx * sin + hy * cos;
  const center = part.center as Vec3;
  return {
    min: [center[0] - ex, center[1] - ey, center[2] - hz],
    max: [center[0] + ex, center[1] + ey, center[2] + hz]
  };
}

export function screenInterference(geometry: any): ScreenResult {
  const parts = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const boxes = parts.map((part: any) => ({ part, bounds: partBounds(part) }));
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
      pairs.push({
        a: boxes[i].part.id,
        b: boxes[j].part.id,
        aName: boxes[i].part.name,
        bName: boxes[j].part.name,
        aRole: boxes[i].part.role,
        bRole: boxes[j].part.role,
        overlapMm3: Math.round(dx * dy * dz * 10) / 10,
        overlapBox: [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100, Math.round(dz * 100) / 100]
      });
    }
  }
  pairs.sort((x, y) => y.overlapMm3 - x.overlapMm3);
  return {
    mode: 'aabb',
    partCount: parts.length,
    pairs,
    count: pairs.length,
    structuralOnly: pairs.length > 0 && pairs.every((pair) => pair.aRole === 'frame' && pair.bRole === 'frame')
  };
}
