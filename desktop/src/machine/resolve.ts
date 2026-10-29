// 批量解开「未声明的重叠」：按便宜的先解，逐轮重算，直到没有 suspect 或轮数用尽。
//
// 口径：
// - 只动 `suspect`（没声明过的重叠）；`declared` 是设计上该相接的（立柱插横梁），动它等于改设计
// - 每轮只应用「位移最小」的那一条建议，然后整机重算 —— 一次挪多个会把彼此的影响叠加，
//   也可能把本来不重叠的件推到一起，所以必须逐轮验证
// - 有轮数上限和「没进展就停」两条保险，收敛不了要如实返回 false，不能假装解开

import { screenInterference } from './interference.ts';
import type { ScreenPair } from './interference.ts';

export interface ResolveMove {
  partId: string;
  axis: 'x' | 'y' | 'z';
  delta: number;
  /** 应用这条之后还剩多少个 suspect */
  remainingAfter: number;
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
    parts = applyMove(parts, partId, axis, delta);
    iterations += 1;
    const after = screenInterference({ ...geometry, parts, joints });
    moves.push({ partId, axis, delta, remainingAfter: after.suspects });
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
