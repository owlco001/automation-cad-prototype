// 排布求解器（阻尼版）：解决 #125/#130 暴露的「正负交替活锁」。
//
// 现象（实测）：四工位 40 mm 目标间距不收敛，`st1/st4-rotary-1-table|z` 在 ±13 mm 之间来回挪；
// 六工位 `st2-gripper-1-nest|y` 在同一轴上来回挪，位移总数 408 但布局不变。
// 根因不是"放不下"，而是**无记忆的交替投影**：这一轮"解重叠"往正推，下一轮"拉间距"往负推。
//
// 这里的三条规则：
//   1) 非对称权重：消重叠（硬）1.0，贴合目标间距（软）0.15 —— 软约束不许把硬约束顶回去；
//   2) 方向反转阻尼：本轮推力与上轮位移反号 → 步长 ×0.45（并逐步回弹，不永久锁死）；
//   3) 刚体簇：同工位叠装链作为一个整体移动，簇内相对位姿不变（不产生"自己跟自己打架"）。
//
// 纯函数：不碰 DOM、不读文件，输入输出都是数字，便于单测与回归。

export type Axis = 0 | 1 | 2;
export type Vec3 = [number, number, number];

export interface SolverCluster {
  id: string;
  /** 当前中心（mm） */
  pos: Vec3;
  /** 半尺寸（mm）：用于算净间距 */
  half: Vec3;
  /** 固定不动（机架底板 / 分度盘中心） */
  pinned?: boolean;
  /** 簇成员零件 id（仅用于报告，求解不改它们之间的相对位姿） */
  members?: string[];
}

export interface GapConstraint {
  a: string;
  b: string;
  axis: Axis;
  /** 硬约束：两簇净间距不得小于该值 */
  minClearanceMm: number;
  /** 软约束：理想间距（可缺省） */
  targetGapMm?: number;
}

export interface SolverOptions {
  maxIterations?: number;
  /** 收敛阈值（mm）：最大剩余违规量 */
  toleranceMm?: number;
  hardWeight?: number;
  softWeight?: number;
  /** 方向反转时的步长系数 */
  flipFactor?: number;
  /** 关掉阻尼，用于对照实验（证明阻尼是必要的） */
  flipDamping?: boolean;
}

export interface SolveResult {
  converged: boolean;
  iterations: number;
  /** 结束后最大违规量（mm） */
  maxViolationMm: number;
  /** 每个簇的累计位移（mm），用于判定"挪了但没变" */
  travel: Record<string, number>;
  /** 每轮的最大违规量，便于看是否在震荡 */
  history: number[];
}

const SETTLE = 1.08;
const MIN_DAMPING = 0.05;

export function solveDampedLayout(
  clusters: ReadonlyArray<SolverCluster>,
  constraints: ReadonlyArray<GapConstraint>,
  options: SolverOptions = {}
): SolveResult {
  const maxIterations = options.maxIterations ?? 60;
  const tolerance = options.toleranceMm ?? 0.05;
  const hardWeight = options.hardWeight ?? 1;
  const softWeight = options.softWeight ?? 0.15;
  const flipFactor = options.flipFactor ?? 0.45;
  const useFlipDamping = options.flipDamping ?? true;

  const state = clusters.map((cluster) => ({
    id: cluster.id,
    pos: [...cluster.pos] as Vec3,
    half: cluster.half,
    pinned: cluster.pinned === true,
    prevDelta: [0, 0, 0] as Vec3,
    damping: [1, 1, 1] as Vec3,
    travel: 0
  }));
  const byId = new Map(state.map((item) => [item.id, item]));

  const history: number[] = [];
  let lastViolation = Number.POSITIVE_INFINITY;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const forces = new Map<string, Vec3>(state.map((item) => [item.id, [0, 0, 0] as Vec3]));
    let maxViolation = 0;

    for (const constraint of constraints) {
      const a = byId.get(constraint.a);
      const b = byId.get(constraint.b);
      if (!a || !b) continue;

      const axis = constraint.axis;
      const delta = b.pos[axis] - a.pos[axis];
      const sign = delta >= 0 ? 1 : -1;
      const gap = Math.abs(delta) - (a.half[axis] + b.half[axis]);

      let correction = 0;
      if (gap < constraint.minClearanceMm) {
        const penetration = constraint.minClearanceMm - gap;
        maxViolation = Math.max(maxViolation, penetration);
        correction = sign * penetration * hardWeight;
      } else if (constraint.targetGapMm !== undefined && gap > constraint.targetGapMm) {
        const excess = gap - constraint.targetGapMm;
        // 软约束只记账一小部分，且不参与收敛判定（否则"永远差一点"= 永不收敛）
        correction = -sign * excess * softWeight;
      }
      if (Math.abs(correction) < 1e-6) continue;

      const fa = forces.get(a.id)!;
      const fb = forces.get(b.id)!;
      if (a.pinned && !b.pinned) {
        fb[axis] += correction;
      } else if (!a.pinned && b.pinned) {
        fa[axis] -= correction;
      } else if (!a.pinned && !b.pinned) {
        fa[axis] -= correction / 2;
        fb[axis] += correction / 2;
      }
    }

    history.push(Number(maxViolation.toFixed(3)));
    if (maxViolation <= tolerance) {
      return {
        converged: true,
        iterations: iteration + 1,
        maxViolationMm: Number(maxViolation.toFixed(3)),
        travel: Object.fromEntries(state.map((item) => [item.id, Number(item.travel.toFixed(2))])),
        history
      };
    }

    // 步长：方向反转就衰减，同向就慢慢回到 1.0（避免一次反转后永久龟速）
    for (const item of state) {
      if (item.pinned) continue;
      const force = forces.get(item.id)!;
      for (const axis of [0, 1, 2] as Axis[]) {
        if (Math.abs(force[axis]) < 1e-6) continue;
        if (useFlipDamping && force[axis] * item.prevDelta[axis] < 0) {
          item.damping[axis] = Math.max(MIN_DAMPING, item.damping[axis] * flipFactor);
        } else {
          item.damping[axis] = Math.min(1, item.damping[axis] * SETTLE);
        }
        const move = force[axis] * item.damping[axis];
        item.pos[axis] += move;
        item.prevDelta[axis] = move;
        item.travel += Math.abs(move);
      }
    }

    // 一点进展都没有（推不动）——直接判不收敛，别假装在算
    if (Math.abs(lastViolation - maxViolation) < 1e-9 && iteration > 4) {
      return {
        converged: false,
        iterations: iteration + 1,
        maxViolationMm: Number(maxViolation.toFixed(3)),
        travel: Object.fromEntries(state.map((item) => [item.id, Number(item.travel.toFixed(2))])),
        history
      };
    }
    lastViolation = maxViolation;
  }

  const finalViolation = history.length > 0 ? history[history.length - 1] : 0;
  return {
    converged: finalViolation <= tolerance,
    iterations: maxIterations,
    maxViolationMm: finalViolation,
    travel: Object.fromEntries(state.map((item) => [item.id, Number(item.travel.toFixed(2))])),
    history
  };
}
