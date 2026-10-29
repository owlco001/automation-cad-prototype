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

/** 放不下时的补救建议：按「工位/部件族」汇总还差多少间距 */
export interface LayoutAdvice {
  /** 工位或部件族前缀，如 st2 / frame / conveyor */
  scope: string;
  /** 该 scope 里最紧的一对还差多少 mm 才到阈值 */
  shortByMm: number;
  /** 涉及的零件对（最多列 5 对，避免刷屏） */
  pairs: Array<{ a: string; b: string; gapMm: number }>;
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
  /** 没收敛时给「还差多少、要动哪个工位」，收敛时为空 */
  advice?: LayoutAdvice[];
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
  let bestTotal = Number.POSITIVE_INFINITY;
  let stallRounds = 0;

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

    // 「这轮和上轮一样」不等于卡住：20 mm 时实测是 4 → 4 → 0，中间那轮没变但下一轮清了。
    // 只有**连续两轮都没刷新最好成绩**才判空转（阈值 30 时 8 轮 1458 次位移、问题数一动不动）。
    const total = suspectsAfter + clearanceAfter;
    if (total < bestTotal) {
      bestTotal = total;
      stallRounds = 0;
    } else {
      stallRounds += 1;
    }
    if (stallRounds >= 2) {
      return {
        parts,
        rounds,
        moves,
        suspects: suspectsAfter,
        clearance: clearanceAfter,
        clearanceMm: options.clearanceMm,
        converged: false,
        stopReason: `连续 ${stallRounds} 轮没有进展（仍有 ${suspectsAfter} 处重叠、${clearanceAfter} 处间距不足）：`
                    + `这个 ${options.clearanceMm} mm 间距在当前布局下放不下，需要加宽工位或减少零件`,
        advice: buildAdvice(finalWorking, options.clearanceMm)
      };
    }

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
    : { ...base,
        stopReason: `交替 ${maxRounds} 轮后仍有 ${suspects} 处重叠、${clearance} 处间距不足`,
        advice: buildAdvice(finalWorking, options.clearanceMm) };
}


// 把「还差多少」落到具体工位上：零件 id 形如 st2-gripper-1-nest / frame-top / conveyor-motor，
// 取第一段作为 scope（st2 / frame / conveyor）。同一对跨两个 scope 时算到两个 scope 都行——
// 用户要的是「动哪一片」，不是精确归属。
function scopeOf(partId: string): string {
  const head = partId.split('-')[0] ?? partId;
  return head;
}

function buildAdvice(geometry: any, clearanceMm: number): LayoutAdvice[] {
  const screen = screenClearance(geometry, { thresholdMm: clearanceMm });
  const byScope = new Map<string, LayoutAdvice>();
  for (const pair of screen.pairs) {
    const shortByMm = Math.round((clearanceMm - pair.gapMm) * 100) / 100;
    for (const scope of new Set([scopeOf(pair.a), scopeOf(pair.b)])) {
      const existing = byScope.get(scope);
      if (!existing) {
        byScope.set(scope, { scope, shortByMm, pairs: [{ a: pair.a, b: pair.b, gapMm: pair.gapMm }] });
        continue;
      }
      existing.shortByMm = Math.max(existing.shortByMm, shortByMm);
      if (existing.pairs.length < 5) existing.pairs.push({ a: pair.a, b: pair.b, gapMm: pair.gapMm });
    }
  }
  return [...byScope.values()].sort((left, right) => right.shortByMm - left.shortByMm);
}


// 方案文件里的「合规戳」：把「按多少 mm 检查过、结论是什么」写进文档本身。
// 只写结论和阈值，不写时间戳——时间戳会让 golden 文件每次都不一样。
export interface ComplianceStamp {
  clearanceMm: number;
  converged: boolean;
  suspects: number;
  clearance: number;
  rounds: number;
  moves: number;
  advice?: LayoutAdvice[];
}

export function complianceStamp(result: LayoutResult): ComplianceStamp {
  return {
    clearanceMm: result.clearanceMm,
    converged: result.converged,
    suspects: result.suspects,
    clearance: result.clearance,
    rounds: result.rounds.length,
    moves: result.moves.length,
    ...(result.advice ? { advice: result.advice } : {})
  };
}
