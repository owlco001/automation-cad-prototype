// 筛查用的候选对（broad phase）。
//
// 干涉/间距初筛本身是 O(n²)：每一对都要算三个轴的间隙。零件一多，绝大多数对
// 根本不可能产生报告，却照样要算。这里先把不可能成对的零件排除掉，只在候选
// 对上市原判定。
//
// 纪律：
// - 只做**超集**筛选：任何原本会出现在报告里的对必须仍是候选；宁可多留，不能漏。
// - 输出顺序必须是原始下标 (i<j) 的升序，与逐对枚举完全一致，否则排序后的报告
//   会因为并列项次序变化而不同。
// - 坐标非有限、阈值非正/非有限、零件过少时一律返回 null，调用方退回原来的双重
//   循环——这些边界上没有可靠的排序语义，退回是最安全的选择。

type Vec3 = [number, number, number];
interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** 小于该规模时排序/建桶的开销超过收益，直接走原路径。 */
const MIN_BROAD_PHASE_PARTS = 32;

function allFinite(bounds: ReadonlyArray<Bounds>): boolean {
  for (const box of bounds) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Number.isFinite(box.min[axis]) || !Number.isFinite(box.max[axis])) return false;
    }
  }
  return true;
}

/**
 * 按某个轴排序后扫描窗口，把候选对按「较小下标」分桶。
 *
 * @param windowEnd 给定排序后的相邻位置 (a,b)，返回是否仍在窗口内（沿主轴还能相交/贴近）
 * @param accept    窗口内的对是否可能产生报告（检查其余轴）
 */
function sweep(
  bounds: ReadonlyArray<Bounds>,
  windowEnd: (a: Bounds, b: Bounds) => boolean,
  accept: (a: Bounds, b: Bounds) => boolean
): number[][] {
  const order = bounds.map((_, index) => index);
  order.sort((left, right) => bounds[left]!.min[0] - bounds[right]!.min[0] || left - right);
  const buckets: number[][] = Array.from({ length: bounds.length }, () => []);
  for (let position = 0; position < order.length; position += 1) {
    const i = order[position]!;
    const a = bounds[i]!;
    for (let next = position + 1; next < order.length; next += 1) {
      const j = order[next]!;
      const b = bounds[j]!;
      if (!windowEnd(a, b)) break;
      if (!accept(a, b)) continue;
      const low = i < j ? i : j;
      const high = i < j ? j : i;
      buckets[low]!.push(high);
    }
  }
  for (const bucket of buckets) {
    if (bucket.length > 1) bucket.sort((left, right) => left - right);
  }
  return buckets;
}

/** 单轴穿透深度（>0 重叠，0 贴面，<0 分开）。 */
function penetration(a: Bounds, b: Bounds, axis: number): number {
  return Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!);
}

/**
 * 干涉初筛的候选对。
 *
 * 报告只可能来自两类：三轴都穿透（重叠），或两轴穿透且第三轴贴面（touching）。
 * 两者都要求至少两个轴的穿透深度大于 -EPS，因此这就是安全的超集判据。
 */
export function interferenceCandidates(
  bounds: ReadonlyArray<Bounds>,
  eps: number
): number[][] | null {
  if (bounds.length < MIN_BROAD_PHASE_PARTS) return null;
  if (!Number.isFinite(eps) || eps < 0) return null;
  if (!allFinite(bounds)) return null;
  return sweep(
    bounds,
    (a, b) => b.min[0] - a.max[0] < eps,
    (a, b) => penetration(a, b, 1) > -eps || penetration(a, b, 2) > -eps
  );
}

/**
 * 间距初筛的候选对。
 *
 * 报告条件包含「欧氏间隙 < 阈值」。任一轴的间隙一旦 ≥ 阈值，欧氏间隙必然 ≥ 阈值，
 * 那一对就不可能报告；所以「三轴间隙都 < 阈值」是安全的超集判据。
 */
export function clearanceCandidates(
  bounds: ReadonlyArray<Bounds>,
  thresholdMm: number
): number[][] | null {
  if (bounds.length < MIN_BROAD_PHASE_PARTS) return null;
  if (!Number.isFinite(thresholdMm) || thresholdMm <= 0) return null;
  if (!allFinite(bounds)) return null;
  const closer = (a: Bounds, b: Bounds, axis: number): boolean =>
    b.min[axis]! - a.max[axis]! < thresholdMm && a.min[axis]! - b.max[axis]! < thresholdMm;
  return sweep(
    bounds,
    (a, b) => b.min[0] - a.max[0] < thresholdMm,
    (a, b) => closer(a, b, 1) && closer(a, b, 2)
  );
}
