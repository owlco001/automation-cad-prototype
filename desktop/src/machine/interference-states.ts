/**
 * 状态化干涉检查（rest / lift / sweep）。
 *
 * 为什么单独一层：现有 `run_interference_check` 只比静态位姿（rest），
 * 顶升单元升到位之后才可能撞的那几对永远查不出来 —— 等于只查了一半。
 * 这里把「同一套几何 + 不同位姿」显式算出来，数字可复算，不靠模型想象。
 *
 * 口径（与 `interference.ts` 一致，且必须一起看）：
 * - 包围盒（AABB）初筛，不是布尔交集，不能当干涉体积用；
 * - `pairs` = 重叠对数，`hits` = 其中没在 joints 里声明、需要人工确认的对数，
 *   `mm3` = 重叠体积合计（只作量级参考）。
 *
 * 行程来源：active 机型 config 轴上真实的 `travelMm`（turner-lift 由
 * `turnerLayout()` 按 `TURNER_LIFT_STROKE_MM` 写进 config），这里**不写死 60**。
 * 读不到可顶升轴就返回 `STATE_UNAVAILABLE`，不拿静态位姿冒充 lift。
 */

import type { MachineConfig } from '../commission/machine-config.ts';
import { generateMachineGeometry, type MachineGeometry } from './geometry.ts';
import { screenInterference } from './interference.ts';

export const INTERFERENCE_STATES = ['rest', 'lift', 'sweep'] as const;
export type InterferenceState = (typeof INTERFERENCE_STATES)[number];

/** 扫掠步长 mm：与 `buildLinkage` 的 tick 无关，固定 10 mm 便于逐步复核。 */
export const SWEEP_STEP_MM = 10;

const MAX_ITEMS = 10;

type Vec3 = [number, number, number];

export interface InterferenceItem {
  a: string;
  b: string;
  aName: string;
  bName: string;
  kind: string;
  overlapMm3: number;
}

export interface InterferenceStateSummary {
  pairs: number;
  hits: number;
  mm3: number;
  items: InterferenceItem[];
}

export interface SweepStepSummary extends InterferenceStateSummary {
  /** 该步的顶升位移 mm（0 就是 rest 位） */
  z: number;
}

export interface SweepStateSummary extends InterferenceStateSummary {
  step: number;
  steps: SweepStepSummary[];
}

export interface LiftAxisInfo {
  actuatorId: string;
  strokeMm: number;
  /** 单位方向向量（config.position 与几何轴同向为准，反过来就取反） */
  direction: Vec3;
  partIds: string[];
}

export interface InterferenceStatesPayload {
  ok: true;
  source: 'machine-geometry';
  partCount: number;
  lift: LiftAxisInfo | null;
  states: Record<string, InterferenceStateSummary | SweepStateSummary>;
  note: string;
}

export interface InterferenceStatesFailure {
  ok: false;
  code: 'STATE_UNAVAILABLE' | 'INVALID_ARGUMENT';
  message: string;
  hint?: string;
}

export type InterferenceStatesOutcome = InterferenceStatesPayload | InterferenceStatesFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function summarize(screen: ReturnType<typeof screenInterference>): InterferenceStateSummary {
  const items = screen.pairs.slice(0, MAX_ITEMS).map((pair) => ({
    a: String(pair.a),
    b: String(pair.b),
    aName: String(pair.aName ?? ''),
    bName: String(pair.bName ?? ''),
    kind: String(pair.kind ?? ''),
    overlapMm3: round1(Number(pair.overlapMm3) || 0)
  }));
  return {
    pairs: screen.count,
    hits: screen.suspects,
    mm3: round1(screen.pairs.reduce((sum, pair) => sum + (Number(pair.overlapMm3) || 0), 0)),
    items
  };
}

function unit(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= 0) return null;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * 找「可顶升轴」：先认 active config 里的执行机构（id=turner-lift 或名字带顶升/lift，
 * 且 travelMm > 0），再回几何的 moving 轴取 partIds / 方向。
 *
 * 任何一步缺数据都返回 null —— 宁可报 STATE_UNAVAILABLE，也不猜哪几个零件会动。
 */
export function resolveLiftAxis(config: unknown, geometry: unknown): LiftAxisInfo | null {
  const actuators = isRecord(config) && Array.isArray(config.actuators) ? config.actuators : [];
  const candidates = actuators.filter((actuator): actuator is Record<string, unknown> => {
    if (!isRecord(actuator) || typeof actuator.id !== 'string') return false;
    if (actuator.kind === 'rotary') return false;
    return actuator.id === 'turner-lift' || /lift|顶升/i.test(`${actuator.id} ${String(actuator.name ?? '')}`);
  });
  const actuator = candidates.find((item) => Number(item.travelMm) > 0);
  if (!actuator) return null;
  const strokeMm = Number(actuator.travelMm);
  if (!Number.isFinite(strokeMm) || strokeMm <= 0) return null;

  const axes = isRecord(geometry) && Array.isArray(geometry.moving) ? geometry.moving : [];
  const axis = axes.find((item) => isRecord(item) && item.actuatorId === actuator.id)
    ?? axes.find((item) => isRecord(item) && /lift|顶升/i.test(String(item.actuatorId ?? '')) && Number(item.strokeMm) > 0);
  if (!isRecord(axis) || !Array.isArray(axis.partIds)) return null;
  const partIds = axis.partIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (partIds.length === 0) return null;

  const rawAxis: Vec3 = Array.isArray(axis.axis)
    ? [Number(axis.axis[0]) || 0, Number(axis.axis[1]) || 0, Number(axis.axis[2]) || 0]
    : [0, 0, 1];
  let direction = unit(rawAxis);
  if (!direction) return null;
  // 几何里气缸的 axis 是「伸出方向」，config.position 是「动作方向」；
  // 两者反向时以 config 为准（turner-lift：position=[0,0,1]，几何 axis=[0,0,-1]）。
  const position = Array.isArray(actuator.position)
    ? [Number(actuator.position[0]) || 0, Number(actuator.position[1]) || 0, Number(actuator.position[2]) || 0] as Vec3
    : null;
  if (position && position.some((value) => value !== 0)) {
    const dot = direction[0] * position[0] + direction[1] * position[1] + direction[2] * position[2];
    if (dot < 0) direction = [-direction[0], -direction[1], -direction[2]];
  }

  return { actuatorId: String(actuator.id), strokeMm, direction, partIds };
}

/** 把指定零件沿方向平移 distance mm；其余零件原样保留（不修改入参）。 */
export function shiftParts(
  geometry: MachineGeometry,
  partIds: readonly string[],
  direction: Vec3,
  distanceMm: number
): MachineGeometry {
  const moving = new Set(partIds);
  const [dx, dy, dz] = direction;
  return {
    ...geometry,
    parts: geometry.parts.map((part) => {
      if (!moving.has(String(part.id))) return part;
      const center = Array.isArray(part.center) ? part.center : [0, 0, 0];
      return {
        ...part,
        center: [
          Number(center[0]) + dx * distanceMm,
          Number(center[1]) + dy * distanceMm,
          Number(center[2]) + dz * distanceMm
        ] as Vec3
      };
    })
  };
}

function normalizeStates(states: unknown): { ok: true; states: InterferenceState[] } | InterferenceStatesFailure {
  if (!Array.isArray(states) || states.length === 0) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'states 必须是非空数组，元素只能是 rest / lift / sweep' };
  }
  const output: InterferenceState[] = [];
  for (const raw of states) {
    if (typeof raw !== 'string' || !(INTERFERENCE_STATES as readonly string[]).includes(raw)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: `未知状态：${String(raw)}；只支持 ${INTERFERENCE_STATES.join(' / ')}` };
    }
    const state = raw as InterferenceState;
    if (!output.includes(state)) output.push(state);
  }
  return { ok: true, states: output };
}

/**
 * 计算请求的状态。config 来自 active 机型（`active.json`），geometry 缺省由它生成，
 * 保证 rest/lift/sweep 三份数字比较的是同一套零件（不会一份来自场景、一份来自配置文件）。
 */
export function runInterferenceStates(input: {
  states: unknown;
  config: unknown;
  geometry?: unknown;
}): InterferenceStatesOutcome {
  const normalized = normalizeStates(input.states);
  if (!normalized.ok) return normalized;
  const states = normalized.states;

  if (!isRecord(input.config)) {
    return {
      ok: false,
      code: 'STATE_UNAVAILABLE',
      message: '读不到当前机型 config，无法按真实行程做状态化干涉检查',
      hint: '先 apply_machine_design 或 load_machine_from_library 选中一台机型'
    };
  }

  let geometry: MachineGeometry;
  if (isRecord(input.geometry) && Array.isArray(input.geometry.parts)) {
    geometry = input.geometry as unknown as MachineGeometry;
  } else {
    try {
      geometry = generateMachineGeometry(input.config as unknown as MachineConfig);
    } catch (error) {
      return {
        ok: false,
        code: 'STATE_UNAVAILABLE',
        message: `机型几何生成失败：${error instanceof Error ? error.message : String(error)}`,
        hint: '先修好机型 config（validate_machine_design）再查干涉'
      };
    }
  }

  const needLift = states.some((state) => state === 'lift' || state === 'sweep');
  const lift = needLift ? resolveLiftAxis(input.config, geometry) : null;
  if (needLift && !lift) {
    return {
      ok: false,
      code: 'STATE_UNAVAILABLE',
      message: '当前机型没有可顶升的轴（config 里找不到 travelMm > 0 的 lift/顶升执行机构，或几何里没有它的运动零件）',
      hint: '先用 design_machine 生成带转向/顶升工位的机型，或确认 turner-lift 的行程字段'
    };
  }

  const output: Record<string, InterferenceStateSummary | SweepStateSummary> = {};
  for (const state of states) {
    if (state === 'rest') {
      output.rest = summarize(screenInterference(geometry));
      continue;
    }
    if (!lift) continue; // needLift 已保证不会走到这里
    if (state === 'lift') {
      const lifted = shiftParts(geometry, lift.partIds, lift.direction, lift.strokeMm);
      output.lift = summarize(screenInterference(lifted));
      continue;
    }
    // sweep：按 10 mm 逐步顶升；行程不是 10 的整数倍时补最后一步（到位位姿也要查）
    const steps: SweepStepSummary[] = [];
    for (let z = 0; z <= lift.strokeMm + 1e-9; z += SWEEP_STEP_MM) {
      const posed = shiftParts(geometry, lift.partIds, lift.direction, z);
      steps.push({ z: round1(z), ...summarize(screenInterference(posed)) });
    }
    const lastZ = steps[steps.length - 1]?.z ?? 0;
    if (lastZ < lift.strokeMm - 1e-9) {
      const posed = shiftParts(geometry, lift.partIds, lift.direction, lift.strokeMm);
      steps.push({ z: round1(lift.strokeMm), ...summarize(screenInterference(posed)) });
    }
    output.sweep = {
      // 扫掠没有单一数字：pairs 取单步最大，hits / mm3 按步累计（每步都可能撞）
      pairs: Math.max(0, ...steps.map((step) => step.pairs)),
      hits: steps.reduce((sum, step) => sum + step.hits, 0),
      mm3: round1(steps.reduce((sum, step) => sum + step.mm3, 0)),
      items: steps.flatMap((step) => step.items).slice(0, MAX_ITEMS),
      step: SWEEP_STEP_MM,
      steps
    };
  }

  return {
    ok: true,
    source: 'machine-geometry',
    partCount: geometry.parts.length,
    lift,
    states: output,
    note: 'AABB 初筛：pairs=重叠对数，hits=需人工确认的对数（未在 joints 声明），mm3=重叠体积合计；sweep 的 hits/mm3 按步累计，pairs 取单步最大。'
  };
}
