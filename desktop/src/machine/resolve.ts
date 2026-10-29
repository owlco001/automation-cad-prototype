// 批量解开「未声明的重叠」：按便宜的先解，逐轮重算，直到没有 suspect 或轮数用尽。
//
// 口径：
// - 只动 `suspect`（没声明过的重叠）；`declared` 是设计上该相接的（立柱插横梁），动它等于改设计
// - 每轮只应用「位移最小」的那一条建议，然后整机重算 —— 一次挪多个会把彼此的影响叠加，
//   也可能把本来不重叠的件推到一起，所以必须逐轮验证
// - 有轮数上限和「没进展就停」两条保险，收敛不了要如实返回 false，不能假装解开

import { screenInterference, partBounds } from './interference.ts';
import type { ScreenPair } from './interference.ts';
import { screenClearance } from './clearance.ts';

export interface ResolveMove {
  partId: string;
  axis: 'x' | 'y' | 'z';
  delta: number;
  /** 应用这条之后还剩多少个 suspect */
  remainingAfter: number;
  /** 挪动前后的中心坐标（mm）——工程师照着改模型用，别只给增量 */
  from: number[];
  to: number[];
}

export interface ResolveResult {
  /** 新的 parts（原件不改，纯函数） */
  parts: any[];
  moves: ResolveMove[];
  /** 开始时 / 结束时未声明的重叠数 */
  before: number;
  after: number;
  iterations: number;
  converged: boolean;
  /** 因为轮数用尽或有环而停下的原因（converged 时为空） */
  stopReason?: string;
}

export interface ResolveOptions {
  maxIterations?: number;
}

const AXIS_INDEX: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 };

function applyMove(parts: any[], partId: string, axis: 'x' | 'y' | 'z', delta: number): any[] {
  const index = AXIS_INDEX[axis];
  return parts.map((part) => {
    if (String(part.id) !== partId) return part;
    const center = [...(part.center as number[])];
    center[index] = Number(center[index]) + delta;
    return { ...part, center, movedBy: [...(((part.movedBy as number[]) ?? [0, 0, 0]))].map((value, axisIndex) => (axisIndex === index ? value + delta : value)) };
  });
}

function cheapestSuspect(pairs: ScreenPair[]): ScreenPair | undefined {
  const suspects = pairs.filter((pair) => pair.kind === 'suspect' && pair.suggestion);
  suspects.sort((left, right) => Math.abs(left.suggestion!.delta) - Math.abs(right.suggestion!.delta));
  return suspects[0];
}

export function resolveConflicts(geometry: any, options: ResolveOptions = {}): ResolveResult {
  const maxIterations = options.maxIterations ?? 40;
  const joints = Array.isArray(geometry?.joints) ? geometry.joints : [];
  let parts = Array.isArray(geometry?.parts) ? geometry.parts.map((part: any) => ({ ...part })) : [];
  const before = screenInterference({ ...geometry, parts }).suspects;
  const moves: ResolveMove[] = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    const result = screenInterference({ ...geometry, parts, joints });
    if (result.suspects === 0) {
      return { parts, moves, before, after: 0, iterations, converged: true };
    }
    const pair = cheapestSuspect(result.pairs);
    if (!pair || !pair.suggestion) {
      return {
        parts,
        moves,
        before,
        after: result.suspects,
        iterations,
        converged: false,
        stopReason: '有未声明重叠但给不出建议位移（可能缺少包围盒）'
      };
    }
    const { partId, axis, delta } = pair.suggestion;
    if (!Number.isFinite(delta) || delta === 0) {
      return { parts, moves, before, after: result.suspects, iterations, converged: false, stopReason: '建议位移为 0，无法推进' };
    }
    const movedPart = parts.find((part: any) => String(part.id) === partId) as any;
    const from = [...((movedPart?.center as number[]) ?? [0, 0, 0])];
    parts = applyMove(parts, partId, axis, delta);
    const afterPart = parts.find((part: any) => String(part.id) === partId) as any;
    const to = [...((afterPart?.center as number[]) ?? [0, 0, 0])];
    iterations += 1;
    const after = screenInterference({ ...geometry, parts, joints });
    moves.push({ partId, axis, delta, remainingAfter: after.suspects, from, to });
    if (after.suspects >= result.suspects) {
      // 挪了一件但某个数没降（可能把别处推到一起了）——继续试，但要有上限
      if (iterations >= maxIterations) {
        return {
          parts,
          moves,
          before,
          after: after.suspects,
          iterations,
          converged: false,
          stopReason: `轮数用尽（${maxIterations}），仍有 ${after.suspects} 处未声明重叠`
        };
      }
    }
  }

  const final = screenInterference({ ...geometry, parts, joints });
  const converged = final.suspects === 0;
  const base = { parts, moves, before, after: final.suspects, iterations, converged };
  return converged ? base : { ...base, stopReason: `轮数用尽（${maxIterations}）` };
}


// ---------------------------------------------------------------------------
// 间距合规：把「太近但没撞」的件沿间隙轴推开到阈值之上。
//
// 与解重叠的区别：这里不需要绕过对方边界，位移就是「阈值 − 当前间隙」，
// 方向从对方指向被挪件；逐轮重算是因为推开一件可能会挤到旁边的件。
// ---------------------------------------------------------------------------

export interface ClearanceMove extends ResolveMove {
  /** 挪完之后这一对的间隙（mm） */
  gapAfter: number;
}

export interface ClearanceResolveResult {
  parts: any[];
  moves: ClearanceMove[];
  before: number;
  after: number;
  iterations: number;
  converged: boolean;
  stopReason?: string;
  thresholdMm: number;
}

export interface ClearanceResolveOptions {
  thresholdMm: number;
  maxIterations?: number;
  /** 推到阈值之上多留一点，默认 1 mm；太小会被浮点判回临界 */
  gap?: number;
}

function bboxVolume(part: any): number {
  const bounds = partBounds(part);
  return (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2]);
}

export function resolveClearance(geometry: any, options: ClearanceResolveOptions): ClearanceResolveResult {
  const thresholdMm = options.thresholdMm;
  const margin = options.gap ?? 1;
  // 默认 200：推开一件会挤到旁边的件，实测四工位 26 处要 42 轮才清干净，40 轮不够
  const maxIterations = options.maxIterations ?? 200;
  let parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts.map((part: any) => ({ ...part })) : [];
  const before = screenClearance({ ...geometry, parts }, { thresholdMm }).count;
  const moves: ClearanceMove[] = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    const screen = screenClearance({ ...geometry, parts }, { thresholdMm });
    if (screen.count === 0) {
      return { parts, moves, before, after: 0, iterations, converged: true, thresholdMm };
    }
    const pair = screen.pairs[0];
    if (!pair) {
      return { parts, moves, before, after: screen.count, iterations, converged: false,
               stopReason: '间距初筛报了数但取不到第一对', thresholdMm };
    }
    const byId = new Map<string, any>(parts.map((part) => [String(part.id), part]));
    const left = byId.get(pair.a);
    const right = byId.get(pair.b);
    if (!left || !right) {
      return {
        parts,
        moves,
        before,
        after: screen.count,
        iterations,
        converged: false,
        stopReason: `找不到零件 ${pair.a} / ${pair.b}`,
        thresholdMm
      };
    }
    // 挪体积小的那件：治具/传感器动比门架动便宜
    const mover = bboxVolume(left) <= bboxVolume(right) ? left : right;
    const other = mover === left ? right : left;
    const axisIndex = ['x', 'y', 'z'].indexOf(pair.axis);
    const direction = (Number((mover.center as number[])[axisIndex]) >= Number((other.center as number[])[axisIndex])) ? 1 : -1;
    const delta = direction * (thresholdMm - pair.gapMm + margin);
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) {
      return {
        parts,
        moves,
        before,
        after: screen.count,
        iterations,
        converged: false,
        stopReason: '位移算出 0，无法推进',
        thresholdMm
      };
    }
    const from = [...((mover.center as number[]) ?? [0, 0, 0])];
    parts = applyMove(parts, String(mover.id), pair.axis, delta);
    const afterPart = parts.find((part: any) => String(part.id) === String(mover.id)) as any;
    const to = [...((afterPart?.center as number[]) ?? [0, 0, 0])];
    iterations += 1;
    const recheck = screenClearance({ ...geometry, parts }, { thresholdMm });
    const stillThere = recheck.pairs.find(
      (candidate) => (candidate.a === pair.a && candidate.b === pair.b) || (candidate.a === pair.b && candidate.b === pair.a)
    );
    moves.push({
      partId: String(mover.id),
      axis: pair.axis,
      delta,
      remainingAfter: recheck.count,
      from,
      to,
      gapAfter: stillThere ? stillThere.gapMm : thresholdMm
    });
  }

  const final = screenClearance({ ...geometry, parts }, { thresholdMm });
  const converged = final.count === 0;
  const base = { parts, moves, before, after: final.count, iterations, converged, thresholdMm };
  return converged ? base : { ...base, stopReason: `轮数用尽（${maxIterations}），仍有 ${final.count} 处间距不足` };
}
