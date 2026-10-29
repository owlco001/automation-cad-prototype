// 「一键排布合规」：解重叠 → 推间距 → 复查，必要就再来一轮。
//
// 为什么要两段循环：推间距会把件推到旁边去，可能撞出新的重叠；解重叠也可能把件推进别人的安全距离里。
// 单跑一次 `resolveConflicts` 或 `resolveClearance` 都只是「局部干净」，整机是否合规要两轮交替后复查。
// 收敛判据只有一条：未声明重叠 = 0 且间距不足 = 0。达不到就如实返回 converged:false。

import { resolveConflicts, resolveClearance } from './resolve.ts';
import { screenInterference } from './interference.ts';
import { screenClearance } from './clearance.ts';

export interface LayoutRound {
  round: number;
  suspectsBefore: number;
  clearanceBefore: number;
  overlapMoves: number;
  clearanceMoves: number;
  suspectsAfter: number;
  clearanceAfter: number;
}

export interface LayoutResult {
  parts: any[];
  rounds: LayoutRound[];
  /** 全部挪动（重叠 + 间距），顺序即执行顺序 */
  moves: Array<{ partId: string; axis: 'x' | 'y' | 'z'; delta: number; from: number[]; to: number[];
                 kind: 'overlap' | 'clearance' }>;
  suspects: number;
  clearance: number;
  clearanceMm: number;
  converged: boolean;
  stopReason?: string;
}

export interface LayoutOptions {
  clearanceMm: number;
  /** 交替轮数上限，默认 4 */
  maxRounds?: number;
}

export function resolveLayout(geometry: any, options: LayoutOptions): LayoutResult {
  const maxRounds = options.maxRounds ?? 4;
  let parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts.map((part: any) => ({ ...part })) : [];
  const rounds: LayoutRound[] = [];
  const moves: LayoutResult['moves'] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const working = { ...geometry, parts };
    const suspectsBefore = screenInterference(working).suspects;
    const clearanceBefore = screenClearance(working, { thresholdMm: options.clearanceMm }).count;

    const overlaps = resolveConflicts(working);
    parts = overlaps.parts;
    for (const move of overlaps.moves) {
      moves.push({ partId: move.partId, axis: move.axis, delta: move.delta, from: move.from, to: move.to, kind: 'overlap' });
    }

    const afterOverlap = { ...geometry, parts };
    const clearances = resolveClearance(afterOverlap, { thresholdMm: options.clearanceMm });
    parts = clearances.parts;
    for (const move of clearances.moves) {
      moves.push({ partId: move.partId, axis: move.axis, delta: move.delta, from: move.from, to: move.to, kind: 'clearance' });
    }

    const finalWorking = { ...geometry, parts };
    const suspectsAfter = screenInterference(finalWorking).suspects;
    const clearanceAfter = screenClearance(finalWorking, { thresholdMm: options.clearanceMm }).count;
    rounds.push({
      round,
      suspectsBefore,
      clearanceBefore,
      overlapMoves: overlaps.moves.length,
      clearanceMoves: clearances.moves.length,
      suspectsAfter,
      clearanceAfter
    });

    if (suspectsAfter === 0 && clearanceAfter === 0) {
      return {
        parts,
        rounds,
        moves,
        suspects: 0,
        clearance: 0,
        clearanceMm: options.clearanceMm,
        converged: true
      };
    }
  }

  const finalWorking = { ...geometry, parts };
  const suspects = screenInterference(finalWorking).suspects;
  const clearance = screenClearance(finalWorking, { thresholdMm: options.clearanceMm }).count;
  const converged = suspects === 0 && clearance === 0;
  const base = { parts, rounds, moves, suspects, clearance, clearanceMm: options.clearanceMm, converged };
  return converged
    ? base
    : { ...base, stopReason: `交替 ${maxRounds} 轮后仍有 ${suspects} 处重叠、${clearance} 处间距不足` };
}
