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

const boxOf = (part: any, pose: Pose): Box => {
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
    max: [cx + hx, cy + hy, cz + hz]
  };
};

const overlap = (a: Box, b: Box): { axis: 'x' | 'y' | 'z'; depth: number } | null => {
  const depths: Array<{ axis: 'x' | 'y' | 'z'; depth: number }> = [
    { axis: 'x', depth: Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) },
    { axis: 'y', depth: Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]) },
    { axis: 'z', depth: Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]) }
  ];
  if (depths.some((item) => item.depth <= 0)) return null;
  return depths.reduce((worst, item) => (item.depth < worst.depth ? item : worst));
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

  const seen = new Map<string, MotionSuspect>();
  let intraStation = 0;
  let maxDepthMm = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const tMs = Math.round((linkage.cycleMs * frame) / frameCount);
    const pose = poseAt(linkage, tMs);
    const boxes = parts.map((part) => boxOf(part, pose));
    for (let i = 0; i < boxes.length; i += 1) {
      const a = boxes[i];
      if (!a) continue;
      const aMoving = movedParts.has(a.id);
      for (let j = i + 1; j < boxes.length; j += 1) {
        const b = boxes[j];
        if (!b) continue;
        // 两边都不动 = 静态布局问题，已经由 layoutCompliance 管，这里不重复报
        if (!aMoving && !movedParts.has(b.id)) continue;
        const hit = overlap(a, b);
        if (!hit || hit.depth < minDepth) continue;
        const scope = scopeOf(a, b);
        if (scope === 'intra-station' && a.actuatorId && a.actuatorId === b.actuatorId) continue;
        const key = `${a.id}|${b.id}`;
        const previous = seen.get(key);
        if (previous && previous.depthMm >= hit.depth) continue;
        seen.set(key, { tMs, a: a.id, b: b.id, axis: hit.axis, depthMm: Math.round(hit.depth * 10) / 10, scope });
        if (scope === 'intra-station') intraStation += 1;
        maxDepthMm = Math.max(maxDepthMm, hit.depth);
      }
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
