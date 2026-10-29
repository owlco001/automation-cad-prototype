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
  /** 最紧那一对是沿哪个轴太近（整站挪要沿这个轴，不能一律往 +X） */
  axis: 'x' | 'y' | 'z';
  /** 该往正方向还是负方向推（选「推完不撞别处」的那一侧） */
  direction: 1 | -1;
  /**
   * 这几对是不是都发生在同一个 scope 内部。
   * 是的话整站挪**无效**——整个工位一起动，工位内部的相对距离一点没变
   * （实测四工位 st1 的 37 mm 全是 `st1-rotary-1-base × st1-rotary-1-table` 这类内部间距）。
   */
  intraScope: boolean;
  /**
   * 照这个建议挪完，会不会撞出新的重叠（初筛对数）。
   * 大于 0 说明「怎么推都要撞」——那就别给按钮，改成说清楚。
   */
  overlapsAfter: number;
  /** 能不能直接执行（intraScope 或 overlapsAfter>0 时都不能） */
  actionable: boolean;
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

export function buildAdvice(geometry: any, clearanceMm: number): LayoutAdvice[] {
  const parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const screen = screenClearance({ ...geometry, parts }, { thresholdMm: clearanceMm });
  const byScope = new Map<string, LayoutAdvice>();
  for (const pair of screen.pairs) {
    const shortByMm = Math.round((clearanceMm - pair.gapMm) * 100) / 100;
    for (const scope of new Set([scopeOf(pair.a), scopeOf(pair.b)])) {
      const existing = byScope.get(scope);
      if (!existing) {
        byScope.set(scope, { scope, shortByMm, axis: pair.axis, direction: 1,
                             intraScope: scopeOf(pair.a) === scopeOf(pair.b),
                             overlapsAfter: 0, actionable: true,
                             pairs: [{ a: pair.a, b: pair.b, gapMm: pair.gapMm }] });
        continue;
      }
      if (shortByMm > existing.shortByMm) {
        existing.shortByMm = shortByMm;
        existing.axis = pair.axis;
      }
      if (scopeOf(pair.a) !== scopeOf(pair.b)) existing.intraScope = false;
      if (existing.pairs.length < 5) existing.pairs.push({ a: pair.a, b: pair.b, gapMm: pair.gapMm });
    }
  }

  // 方向不能拍脑袋：整站往 +Z 推 37 mm 可能正好顶进门架（实测四工位把间距问题从 4 处推到 34 处）。
  // 这里把「这个 scope 沿候选轴 ±长度」各试一遍，只做筛查（不解），挑撞得最少的那一侧。
  const scopeIds = new Map<string, string[]>();
  for (const part of parts) {
    const scope = scopeOf(String(part.id ?? ''));
    const list = scopeIds.get(scope) ?? [];
    list.push(String(part.id));
    scopeIds.set(scope, list);
  }
  for (const item of byScope.values()) {
    const ids = new Set(scopeIds.get(item.scope) ?? []);
    if (ids.size === 0) continue;
    // 工位内部的间距：整站挪不改变相对位置，别给误导性的方向
    if (item.intraScope) {
      item.actionable = false;
      continue;
    }
    let bestCost = Number.POSITIVE_INFINITY;
    let bestAxis: 'x' | 'y' | 'z' = item.axis;
    let bestDirection: 1 | -1 = 1;
    const axes: Array<'x' | 'y' | 'z'> = [item.axis, ...(['x', 'y', 'z'] as const).filter((a) => a !== item.axis)];
    for (const axis of axes) {
      for (const direction of [1, -1] as const) {
        const shifted = parts.map((part: any) => {
          if (!ids.has(String(part.id ?? ''))) return part;
          const center = [...(part.center as number[])];
          const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          center[index] = Number(center[index]) + direction * item.shortByMm;
          return { ...part, center };
        });
        const trial = { ...geometry, parts: shifted };
        const overlapCount = screenInterference(trial).suspects;
        const stillShort = screenClearance(trial, { thresholdMm: clearanceMm }).count;
        // 重叠比「还没推够」更糟：重叠按 10 倍计权
        const cost = overlapCount * 10 + stillShort;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestDirection = direction;
        }
      }
    }
    item.axis = bestAxis;
    item.direction = bestDirection;
    // bestCost 里重叠按 10 倍计权，这里把重叠部分还原出来
    item.overlapsAfter = Math.floor(bestCost / 10);
    // 推哪儿都要撞（比如工位夹在两台机器之间）：不给按钮，避免「点了更糟」
    item.actionable = item.overlapsAfter === 0;
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


// 「这台机器最大能做到多大间距」：二分探阈值，找到还能排得开的最大值。
//
// 为什么值得做：用户提「按 30 mm 查」时，光说「放不下」没用，得知道「25 能、30 不能」才有决策价值。
// 口径与排布合规完全一致（同一套 AABB 初筛 + 交替求解），只是在阈值上二分。
// 假设可行性对阈值单调（间距要求越高越难），这是工程近似——探测结果会一并返回，便于人工复核。
export interface FeasibleClearanceResult {
  /** 可行的最大间距（mm）；0 表示连 minMm 都放不下 */
  feasibleMm: number;
  /** 二分过程，便于人工复核「为什么不是 30」 */
  probes: Array<{ mm: number; converged: boolean; rounds: number; moves: number }>;
  minMm: number;
  maxMm: number;
}

export interface FeasibleClearanceOptions {
  minMm?: number;
  maxMm?: number;
  /** 二分精度（mm），默认 1 */
  stepMm?: number;
}

function probe(geometry: any, mm: number): { converged: boolean; rounds: number; moves: number } {
  const result = resolveLayout(geometry, { clearanceMm: mm, maxRounds: 4 });
  return { converged: result.converged, rounds: result.rounds.length, moves: result.moves.length };
}

export function maxFeasibleClearance(geometry: any, options: FeasibleClearanceOptions = {}): FeasibleClearanceResult {
  const minMm = options.minMm ?? 1;
  const maxMm = options.maxMm ?? 60;
  const stepMm = options.stepMm ?? 1;
  const probes: FeasibleClearanceResult['probes'] = [];

  const lowest = probe(geometry, minMm);
  probes.push({ mm: minMm, ...lowest });
  if (!lowest.converged) return { feasibleMm: 0, probes, minMm, maxMm };
  if (minMm >= maxMm) return { feasibleMm: minMm, probes, minMm, maxMm };

  const highest = probe(geometry, maxMm);
  probes.push({ mm: maxMm, ...highest });
  if (highest.converged) return { feasibleMm: maxMm, probes, minMm, maxMm };

  let low = minMm;
  let high = maxMm;
  while (high - low > stepMm) {
    const mid = Math.round((low + high) / 2);
    if (mid <= low || mid >= high) break;
    const result = probe(geometry, mid);
    probes.push({ mm: mid, ...result });
    if (result.converged) low = mid;
    else high = mid;
  }
  return { feasibleMm: low, probes, minMm, maxMm };
}
