// 运动中会不会撞：静态布局合规 ≠ 运动过程安全。
//
// 做法：把联动时间线的每一帧套到几何上，按零件算「位移+转角后的包围盒」，
// 逐帧找相交对。这是 **AABB 扫掠初筛**，不是真实布尔——所以结论只写「疑似」，
// 并给出帧时刻、对、轴向与压入深度，供布尔复核与排布调整。
//
// 分类沿用静态干涉的口径：
//   - 同一执行机构内部（夹爪两片、转台与夹具）→ 不计（本来就是装配在一起动的）
//   - 同工位内 → 单独计数（多为夹持/贴合，属于正常）
//   - 跨工位 / 跨机架 → suspects（这才是「设计错了」）
//
// 局限（写在这里，别让结论越界）：
//   - AABB 对圆柱、斜置件会高估，必须布尔复核才算真干涉
//   - 只采样离散帧，不含加减速与超程

import type { Linkage, Pose } from './linkage.ts';
import { poseAt } from './linkage.ts';

export interface MotionSuspect {
  tMs: number;
  a: string;
  b: string;
  axis: 'x' | 'y' | 'z';
  /** 三轴里最小的重叠量（mm），越大越像真撞 */
  depthMm: number;
  scope: 'cross-station' | 'frame' | 'intra-station';
}

export interface MotionCheckResult {
  frames: number;
  parts: number;
  /** 被判过相交的对数（去重后） */
  pairs: number;
  suspects: MotionSuspect[];
  intraStation: number;
  /** 最深的一处 */
  maxDepthMm: number;
  note: string;
}

interface Box {
  id: string;
  stationId: string;
  actuatorId: string;
  min: [number, number, number];
  max: [number, number, number];
  part: any;
  center: [number, number, number];
  half: [number, number, number];
  rotZ: number;
}

const halfExtents = (part: any, extraRotDeg: number): [number, number, number] => {
  const shape = part.shape ?? {};
  const rot = ((Number(part.rotationZDeg) || 0) + extraRotDeg) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  if (shape.type === 'cylinder') {
    const r = Number(shape.radius) || 0;
    const length = Number(shape.length) || 0;
    if (String(shape.axis ?? 'z') === 'z') return [r, r, length / 2];
    if (String(shape.axis) === 'x') return [length / 2, r, r];
    return [r, length / 2, r];
  }
  const size = Array.isArray(shape.size) ? shape.size : [0, 0, 0];
  const hx = (Number(size[0]) || 0) / 2;
  const hy = (Number(size[1]) || 0) / 2;
  const hz = (Number(size[2]) || 0) / 2;
  return [hx * cos + hy * sin, hx * sin + hy * cos, hz];
};

const boxOf = (part: any, pose: Pick<Pose, 'offsets' | 'rotZDeg'>): Box => {
  const id = String(part.id);
  const offset = pose.offsets[id] ?? [0, 0, 0];
  const rotZ = pose.rotZDeg[id] ?? 0;
  const [hx, hy, hz] = halfExtents(part, rotZ);
  const center = Array.isArray(part.center) ? part.center : [0, 0, 0];
  const cx = (Number(center[0]) || 0) + offset[0];
  const cy = (Number(center[1]) || 0) + offset[1];
  const cz = (Number(center[2]) || 0) + offset[2];
  return {
    id,
    stationId: String(part.stationId ?? ''),
    actuatorId: String(part.actuatorId ?? ''),
    min: [cx - hx, cy - hy, cz - hz],
    max: [cx + hx, cy + hy, cz + hz],
    part,
    center: [Number(center[0]) || 0, Number(center[1]) || 0, Number(center[2]) || 0],
    half: [hx, hy, hz],
    rotZ
  };
};

// Reuse bounds and half extents; translation does not change the latter.
const updateBox = (box: Box, pose: Pose): void => {
  const offset = pose.offsets[box.id];
  const rotZ = pose.rotZDeg[box.id] ?? 0;
  if (!Object.is(rotZ, box.rotZ)) {
    box.half = halfExtents(box.part, rotZ);
    box.rotZ = rotZ;
  }
  for (const axis of [0, 1, 2] as const) {
    const center = box.center[axis] + (offset == null ? 0 : offset[axis]);
    box.min[axis] = center - box.half[axis];
    box.max[axis] = center + box.half[axis];
  }
};

const scopeOf = (a: Box, b: Box): MotionSuspect['scope'] => {
  if (a.actuatorId && a.actuatorId === b.actuatorId) return 'intra-station';   // 同一机构内部，调用方会丢掉
  const sa = a.stationId;
  const sb = b.stationId;
  if (sa && sb && sa === sb) return 'intra-station';
  if (!sa || !sb) return 'frame';
  return 'cross-station';
};

/**
 * @param frameCount 采样帧数（默认取联动帧数；60 帧 ≈ 每 30 ms 一个姿态）
 * @param minDepthMm 小于该深度不算（默认 1 mm，滤掉数值噪声与贴合）
 */
export function checkMotionEnvelope(
  geometry: any,
  linkage: Linkage,
  options: { frameCount?: number; minDepthMm?: number } = {}
): MotionCheckResult {
  const parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const frameCount = Math.max(8, Math.min(240, options.frameCount ?? 60));
  const minDepth = options.minDepthMm ?? 1;
  const movedParts = new Set<string>();
  for (const axis of linkage.axes) for (const partId of axis.partIds) movedParts.add(partId);

  const boxes = parts.map((part) => boxOf(part, { offsets: {}, rotZDeg: {} }));
  const movingIndices: number[] = [];
  boxes.forEach((box, index) => { if (movedParts.has(box.id)) movingIndices.push(index); });
  // Jaws can name parts outside partIds: they affect bounds, but must not change
  // the original partIds-only eligibility rule for collision pairs.
  const posedParts = new Set([...movedParts].map(String));
  for (const axis of linkage.axes) {
    for (const jaw of Array.isArray(axis.jaws) ? axis.jaws : []) posedParts.add(String(jaw.partId));
  }
  const changingBoxes = boxes.filter((box) => posedParts.has(box.id));
  const candidates: Array<{ a: Box; b: Box; scope: MotionSuspect['scope']; key: string }> = [];
  let nextMoving = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    if (!a) continue;
    while (nextMoving < movingIndices.length && movingIndices[nextMoving]! <= i) nextMoving += 1;
    const addPair = (j: number): void => {
      const b = boxes[j];
      if (!b || (a.actuatorId && a.actuatorId === b.actuatorId)) return;
      candidates.push({ a, b, scope: scopeOf(a, b), key: `${a.id}|${b.id}` });
    };
    // Enumerate only moving-vs-other pairs, in the original i<j order. This
    // also preserves Map insertion order when the final stable sort has ties.
    if (movedParts.has(a.id)) {
      for (let j = i + 1; j < boxes.length; j += 1) addPair(j);
    } else {
      for (let m = nextMoving; m < movingIndices.length; m += 1) addPair(movingIndices[m]!);
    }
  }

  const seen = new Map<string, MotionSuspect>();
  let maxDepthMm = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const tMs = Math.round((linkage.cycleMs * frame) / frameCount);
    const pose = poseAt(linkage, tMs);
    for (const box of changingBoxes) updateBox(box, pose);
    for (const { a, b, scope, key } of candidates) {
      const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
      const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
      const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
      if (dx <= 0 || dy <= 0 || dz <= 0) continue;
      // Strict comparisons retain x/y/z tie priority and the old NaN behavior.
      let depth = dx;
      let axis: MotionSuspect['axis'] = 'x';
      if (dy < depth) { depth = dy; axis = 'y'; }
      if (dz < depth) { depth = dz; axis = 'z'; }
      if (depth < minDepth) continue;
      const previous = seen.get(key);
      // Compare the previously rounded value against the new raw depth.
      if (previous && previous.depthMm >= depth) continue;
      seen.set(key, { tMs, a: a.id, b: b.id, axis, depthMm: Math.round(depth * 10) / 10, scope });
      maxDepthMm = Math.max(maxDepthMm, depth);
    }
  }

  const all = [...seen.values()].sort((left, right) => right.depthMm - left.depthMm);
  const suspects = all.filter((item) => item.scope !== 'intra-station');
  return {
    frames: frameCount,
    parts: parts.length,
    pairs: all.length,
    suspects,
    intraStation: all.length - suspects.length,
    maxDepthMm: Math.round(maxDepthMm * 10) / 10,
    note: 'AABB 扫掠初筛：只说明「疑似」，要确认必须做真实布尔；不含加减速与超程。'
  };
}
