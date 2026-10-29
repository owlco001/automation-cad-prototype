// 安全间距初筛：不重叠、但间隙小于阈值的零件对。
//
// 口径与干涉一致：都是 AABB 近似，只能说「疑似太近」，不是真实距离场。
// 已声明连接（立柱插横梁）本来就要贴在一起，不参与间距判断。

import { partBounds } from './interference.ts';
import { declaredJoints, jointKey } from './joints.ts';

/**
 * contact = 同一工位内、沿 Z 上下叠着、间隙 ≤ 5 mm：多半是装配贴合（底座上放台面），
 *           该在 joints 里声明成结构连接，不该当「间距不足」；
 * intra   = 同一工位内部；
 * cross   = 跨工位。
 * 这是**启发式分类**，不是几何定理——贴面 5 mm 以内也可能真的需要间隙。
 */
export type ClearanceKind = 'contact' | 'intra' | 'cross';

export interface ClearancePair {
  a: string;
  b: string;
  kind: ClearanceKind;
  /** 两件 AABB 之间的真实距离（mm）：三个轴上的正间隙平方和开根 */
  gapMm: number;
  /** 哪个轴贡献的间隙最大（决定往哪边看） */
  axis: 'x' | 'y' | 'z';
  /** 两件最近的轴对齐距离，便于人工复核 */
  detail: string;
}

export interface ClearanceResult {
  thresholdMm: number;
  /** 真正要处理的间距问题数（不含 contact） */
  count: number;
  pairs: ClearancePair[];
  /** 被归为「装配贴合」的对数，单独计数，不计入 count */
  contacts: number;
}

const AXES: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];

function gapOnAxis(left: any, right: any, axis: number): number {
  const a = partBounds(left);
  const b = partBounds(right);
  // 分离量：>0 表示这个轴上有间隙，<0 表示重叠
  const forward = (b.min[axis] ?? 0) - (a.max[axis] ?? 0);
  const backward = (a.min[axis] ?? 0) - (b.max[axis] ?? 0);
  return Math.max(forward, backward);
}

export function screenClearance(geometry: any, options: { thresholdMm?: number } = {}): ClearanceResult {
  const thresholdMm = options.thresholdMm ?? 20;
  const parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts : [];
  // 与干涉初筛共用同一份白名单（joints.ts 的 138 条），不是另起一套判断，
  // 否则贴面连接（立柱插横梁、工位底板接台面）会全被当成「间距 0」报出来。
  const declared = new Set<string>();
  for (const joint of declaredJoints(parts)) {
    declared.add(jointKey(joint.a, joint.b));
  }

  const pairs: ClearancePair[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const left = parts[i];
      const right = parts[j];
      const leftId = String(left?.id ?? '');
      const rightId = String(right?.id ?? '');
      if (!leftId || !rightId) continue;
      if (declared.has(`${leftId}|${rightId}`)) continue;

      // 三轴间隙：只要有一个轴分开了，两件就没重叠
      const gaps = [gapOnAxis(left, right, 0), gapOnAxis(left, right, 1), gapOnAxis(left, right, 2)];
      if (Math.max(...gaps) < 0) continue; // 有重叠 → 归干涉初筛管，不在这里重复报

      // AABB 之间的真实距离：只算分离轴，平方和开根。
      // 不能取「最小正间隙」——斜着放的两件，X 隔 10、Y 隔 50，实际距离是 √(10²+50²)=51，不是 10。
      const positive: number[] = gaps.map((gap) => Math.max(0, gap));
      const gapMm = Math.sqrt((positive[0] ?? 0) ** 2 + (positive[1] ?? 0) ** 2 + (positive[2] ?? 0) ** 2);
      let axisIndex = 0;
      for (let index = 1; index < 3; index += 1) {
        if ((positive[index] ?? 0) > (positive[axisIndex] ?? 0)) axisIndex = index;
      }
      // 贴面（≤0.5 mm）算接触，不算「间距不足」：结构件本来就是压在一起的，
      // 把它报成间距问题只会淹没真正需要看的间隙。口径与干涉初筛的贴面容差一致。
      if (gapMm <= 0.5) continue;
      if (gapMm >= thresholdMm) continue;
      const axisName = AXES[axisIndex] ?? 'x';
      const sameScope = leftId.split('-')[0] === rightId.split('-')[0];
      const kind: ClearanceKind = !sameScope
        ? 'cross'
        : (axisName === 'z' && gapMm <= 5 ? 'contact' : 'intra');
      pairs.push({
        a: leftId,
        b: rightId,
        kind,
        gapMm: Math.round(gapMm * 100) / 100,
        axis: axisName,
        detail: `沿 ${axisName.toUpperCase()} 间隙 ${gapMm.toFixed(1)} mm`
      });
    }
  }

  const contacts = pairs.filter((pair) => pair.kind === 'contact').length;
  const violations = pairs.filter((pair) => pair.kind !== 'contact');
  violations.sort((left, right) => left.gapMm - right.gapMm);
  return { thresholdMm, count: violations.length, pairs: violations, contacts };
}
