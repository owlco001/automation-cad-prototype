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
 *
 * `push`（顶升移载的 +Y 送出）是**复合位姿**：先按顶升轴把随动台板/辊道/推板抬到行程顶，
 * 再按移载轴把推板沿 +Y 推到行程末端。真机就是这个顺序（顶起来再推），
 * 只按 +Y 平移而不顶升会得出一个不存在的位姿（推板会穿带）。没有移载轴时**不产出** push 态
 * （不退化成「等于 lift」，那正是 t05 抓到的老毛病），原因写进 `unavailable.push`，整次检查仍算成功
 * —— 否则给一台转向机做四态评审会整条降级成 N/A。
 */

import type { MachineConfig } from '../commission/machine-config.ts';
import { resolveMachineGeometry, type MachineGeometrySource } from './machine-geometry.ts';
import type { MachineGeometry } from './geometry.ts';
import { screenInterference } from './interference.ts';

export const INTERFERENCE_STATES = ['rest', 'lift', 'sweep', 'push'] as const;
export type InterferenceState = (typeof INTERFERENCE_STATES)[number];

/** 扫掠步长 mm：与 `buildLinkage` 的 tick 无关，固定 10 mm 便于逐步复核。 */
export const SWEEP_STEP_MM = 10;

/** 认定「确认干涉」的最小体积 mm³（小于它是接触误差，不升级为确认） */
const CONFIRM_MIN_MM3 = 1;

const MAX_ITEMS = 10;

type Vec3 = [number, number, number];

export interface InterferenceItem {
  a: string;
  b: string;
  aName: string;
  bName: string;
  /** declared=已声明连接；mate=同轴嵌套配合；suspect=待复核 */
  kind: 'declared' | 'mate' | 'suspect';
  /** exact=解析式精确；aabb=只有包围盒依据 */
  confirmation: 'exact' | 'aabb';
  /** AABB 重叠体积上界（mm³） */
  overlapMm3: number;
  /** 解析式精确交集体积（mm³）；confirmation='aabb' 时 null */
  exactOverlapMm3: number | null;
  note?: string;
}

/** pass=没有待处理项；warn=只有待复核/位姿存疑；fail=有确认的实体重叠 */
export type ReviewStatus = 'pass' | 'warn' | 'fail';

/**
 * 状态位姿是否可信：
 * - valid：位移方向与几何建模的伸出方向一致；
 * - direction-overridden：两者相反，本工具按 config 方向覆盖（见 resolveLiftAxis），
 *   这一态是「反向平移」而非模型给出的到位位姿 —— 数字只作占位，不能当设计干涉结论。
 */
export type PoseValidity = 'valid' | 'direction-overridden';

export interface InterferenceStateSummary {
  pairs: number;
  /** 兼容旧口径 = screenHits + confirmedHits（需要人处理的对数） */
  hits: number;
  /** 待复核对数（只有 AABB 依据 / 位姿不可信） */
  screenHits: number;
  /** 确认干涉对数（解析式精确 + 未被位姿问题降级） */
  confirmedHits: number;
  /** 同轴嵌套配合对数（缸体×活塞杆这类，不算干涉） */
  mates: number;
  /** 全部重叠对的 AABB 上界合计（含 declared / mate），只作量级参考 */
  mm3: number;
  /** 已确认重叠的精确体积合计（mm³） */
  mm3Confirmed: number;
  /** 待复核对的重叠上界合计（mm³） */
  mm3Screen: number;
  /** 已声明连接放行的重叠体积（mm³）：声明规则可能挡掉真实互穿，列出来供复核 */
  mm3Declared: number;
  reviewStatus: ReviewStatus;
  poseValidity: PoseValidity;
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
  /** 实际施加的位移方向（已被 config 覆盖，见 resolveLiftAxis） */
  direction: Vec3;
  /** 几何里建模的伸出方向（未覆盖） */
  geometryDirection: Vec3;
  /** true = config 方向与几何伸出方向相反，本轴是「反向平移」 */
  directionOverridden: boolean;
  partIds: string[];
}

/**
 * 精度与适用范围：必须随结果一起返回，否则下游会把 screen hit 当确认干涉，
 * 或者拿本工具的数字去和另一套几何的 B-Rep 结论对撞。
 */
export interface InterferencePrecision {
  /** 初筛方式：AABB */
  screen: 'aabb';
  /** 确认方式：解析式原始体求交（不是布尔的边角/曲面情形） */
  confirm: 'analytic-primitive';
  /** 本次算的是哪套几何：参数化整机 / 工位生成器代理体（唯一入口 resolveMachineGeometry 决定） */
  geometry: MachineGeometrySource;
  /** 只有包围盒依据的情形（会被降级为 screen hit） */
  aabbOnly: string[];
}

export interface InterferenceStatesPayload {
  ok: true;
  source: 'machine-geometry';
  /** 几何来源：参数化整机（输送类）或工位生成器（其余形态） */
  geometrySource: MachineGeometrySource;
  /** 几何刚体数（参与干涉计算的实际件数） */
  partCount: number;
  /** 整机装配件数（BOM/STEP 口径）；活塞杆按刚体拆出时会比 partCount 少几件 */
  assemblyPartCount: number;
  lift: LiftAxisInfo | null;
  /** 移载轴（+Y）；机型没有移载工位时为 null */
  push: LiftAxisInfo | null;
  /** 要了却给不出的状态（现在只有 push）：原因写在这里，不悄悄吞掉 */
  unavailable?: Partial<Record<InterferenceState, string>>;
  states: Record<string, InterferenceStateSummary | SweepStateSummary>;
  /** 全部状态里最差的一档：fail > warn > pass */
  reviewStatus: ReviewStatus;
  precision: InterferencePrecision;
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

/** sweep 逐行拼接 items 会重复（同一对在多个高度都重叠），按 零件对+判定 去重。 */
function dedupeItems(items: InterferenceItem[]): InterferenceItem[] {
  const seen = new Set<string>();
  const output: InterferenceItem[] = [];
  for (const item of items) {
    const key = `${item.a}|${item.b}|${item.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= MAX_ITEMS) break;
  }
  return output;
}

function summarize(
  screen: ReturnType<typeof screenInterference>,
  options: { poseValidity: PoseValidity; movingIds?: ReadonlySet<string> }
): InterferenceStateSummary {
  const overridden = options.poseValidity === 'direction-overridden';
  const moving = options.movingIds ?? new Set<string>();
  // 位姿是「反向平移」时，动件相关的重叠只是位移占位的产物，一律降级为待复核：
  // 否则 +z 平移会把活塞杆推进缸体，报出一堆模型里根本不存在的干涉。
  const taintedByPose = (pair: { a: string; b: string }): boolean =>
    overridden && (moving.has(String(pair.a)) || moving.has(String(pair.b)));
  const confirmedPairs = screen.pairs.filter(
    (pair) => pair.classification === 'suspect'
      && pair.confirmation === 'exact'
      && (pair.exactOverlapMm3 ?? 0) > CONFIRM_MIN_MM3
      && !taintedByPose(pair)
  );
  const screenPairs = screen.pairs.filter(
    (pair) => pair.classification === 'suspect' && !confirmedPairs.includes(pair)
  );
  const items = screen.pairs
    .filter((pair) => pair.classification !== 'declared')
    .slice(0, MAX_ITEMS)
    .map((pair) => ({
      a: String(pair.a),
      b: String(pair.b),
      aName: String(pair.aName ?? ''),
      bName: String(pair.bName ?? ''),
      kind: pair.classification,
      confirmation: pair.confirmation,
      overlapMm3: round1(Number(pair.overlapMm3) || 0),
      exactOverlapMm3: pair.exactOverlapMm3 === null ? null : round1(Number(pair.exactOverlapMm3) || 0),
      ...(pair.note ? { note: pair.note } : {})
    }));
  const sumOf = (list: typeof screen.pairs, pick: (pair: (typeof screen.pairs)[number]) => number): number =>
    round1(list.reduce((total, pair) => total + pick(pair), 0));
  const confirmedHits = confirmedPairs.length;
  const screenHits = screenPairs.length;
  return {
    pairs: screen.count,
    hits: confirmedHits + screenHits,
    screenHits,
    confirmedHits,
    mates: screen.mates,
    mm3: sumOf(screen.pairs, (pair) => Number(pair.overlapMm3) || 0),
    mm3Confirmed: sumOf(confirmedPairs, (pair) => Number(pair.exactOverlapMm3) || 0),
    mm3Screen: sumOf(screenPairs, (pair) => Number(pair.overlapMm3) || 0),
    mm3Declared: round1(screen.declaredMm3),
    reviewStatus: confirmedHits > 0 ? 'fail' : overridden || screenHits > 0 ? 'warn' : 'pass',
    poseValidity: options.poseValidity,
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
  const geometryDirection: Vec3 = [...direction];
  let directionOverridden = false;
  if (position && position.some((value) => value !== 0)) {
    const dot = direction[0] * position[0] + direction[1] * position[1] + direction[2] * position[2];
    if (dot < 0) {
      // 归一化 -0：三个分量里 x/y 反向后会是 -0，JSON 里看着像另一回事
      direction = [-direction[0] + 0, -direction[1] + 0, -direction[2] + 0];
      // 覆盖方向不是免费的：+z 会把「朝下伸出的压机」反向平移，活塞杆被推进缸体。
      // 记下来，状态化检查要把这一态的命中降级（见 summarize 的 poseValidity）。
      directionOverridden = true;
    }
  }

  return {
    actuatorId: String(actuator.id),
    strokeMm,
    direction,
    geometryDirection,
    directionOverridden,
    partIds
  };
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

/**
 * 找「可移载轴」：id=transfer-push（或名字带移载/push）且 travelMm > 0，
 * 方向上认 config.position 的 Y 分量；几何里没有它的运动零件就返回 null。
 */
export function resolvePushAxis(config: unknown, geometry: unknown): LiftAxisInfo | null {
  const actuators = isRecord(config) && Array.isArray(config.actuators) ? config.actuators : [];
  // 先认 id：顶升轴的名字里也带「移载」（移载工位顶升台），只按名字找会把 +Y 轴认成顶升轴，
  // 于是 push 态变成「顶两次升」——实测 rollers 被抬到 915 撞上推板 400000 mm³。
  const candidates = actuators.filter((item): item is Record<string, unknown> => (
    isRecord(item) && typeof item.id === 'string' && item.kind !== 'rotary' && Number(item.travelMm) > 0
  ));
  const actuator = candidates.find((item) => item.id === 'transfer-push')
    ?? candidates.find((item) => /push|移载/i.test(`${String(item.id)} ${String(item.name ?? '')}`)
      && !/lift|顶升|turn/i.test(`${String(item.id)} ${String(item.name ?? '')}`));
  if (!actuator) return null;
  const strokeMm = Number(actuator.travelMm);
  if (!Number.isFinite(strokeMm) || strokeMm <= 0) return null;
  const axes = isRecord(geometry) && Array.isArray(geometry.moving) ? geometry.moving : [];
  const axis = axes.find((item) => isRecord(item) && item.actuatorId === actuator.id);
  if (!isRecord(axis) || !Array.isArray(axis.partIds)) return null;
  const partIds = axis.partIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (partIds.length === 0) return null;
  const rawAxis: Vec3 = Array.isArray(axis.axis)
    ? [Number(axis.axis[0]) || 0, Number(axis.axis[1]) || 0, Number(axis.axis[2]) || 0]
    : [0, 1, 0];
  let direction = unit(rawAxis);
  if (!direction) return null;
  const position = Array.isArray(actuator.position)
    ? [Number(actuator.position[0]) || 0, Number(actuator.position[1]) || 0, Number(actuator.position[2]) || 0] as Vec3
    : null;
  const geometryDirection: Vec3 = [...direction];
  let directionOverridden = false;
  if (position && position.some((value) => value !== 0)) {
    const dot = direction[0] * position[0] + direction[1] * position[1] + direction[2] * position[2];
    if (dot < 0) {
      direction = [-direction[0] + 0, -direction[1] + 0, -direction[2] + 0];
      directionOverridden = true;
    }
  }
  return {
    actuatorId: String(actuator.id),
    strokeMm,
    direction,
    geometryDirection,
    directionOverridden,
    partIds
  };
}

function normalizeStates(states: unknown): { ok: true; states: InterferenceState[] } | InterferenceStatesFailure {
  if (!Array.isArray(states) || states.length === 0) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'states 必须是非空数组，元素只能是 rest / lift / sweep / push' };
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
  let geometrySource: MachineGeometrySource = 'station-generator';
  if (isRecord(input.geometry) && Array.isArray(input.geometry.parts)) {
    // 调用方直接给了几何：来源按几何自带的标注（没标注就按工位生成器代理体处理）。
    // 这个字段存在的目的就是让下游知道「别拿两套几何的数字对撞」。
    geometry = input.geometry as unknown as MachineGeometry;
    geometrySource = geometry.geometrySource === 'conveyor-assembly' ? 'conveyor-assembly' : 'station-generator';
  } else {
    try {
      const resolved = resolveMachineGeometry(input.config as unknown as MachineConfig);
      geometry = resolved.geometry;
      geometrySource = resolved.source;
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
  const needPush = states.some((state) => state === 'push');
  const lift = needLift || needPush ? resolveLiftAxis(input.config, geometry) : null;
  if (needLift && !lift) {
    return {
      ok: false,
      code: 'STATE_UNAVAILABLE',
      message: '当前机型没有可顶升的轴（config 里找不到 travelMm > 0 的 lift/顶升执行机构，或几何里没有它的运动零件）',
      hint: '先用 design_machine 生成带转向/顶升工位的机型，或确认 turner-lift 的行程字段'
    };
  }
  const push = needPush ? resolvePushAxis(input.config, geometry) : null;
  // push 是**可选**状态：没有移载轴的机型（转向线、普通输送线、压机…）不该因为「要了 push」就整次检查失败——
  // 那会让「四态评审」在非移载机型上整条降级成 N/A。这里照样**不**产出 push 态（绝不拿 lift 位姿冒充），
  // 只把原因写进 unavailable，由调用方显示「push 不适用」。
  const pushUnavailable = needPush && !push
    ? '当前机型没有可移载的轴（config 里找不到 travelMm > 0 的 transfer-push/移载执行机构，或几何里没有它的运动零件）'
    : null;

  const output: Record<string, InterferenceStateSummary | SweepStateSummary> = {};
  const movingIds = new Set<string>(lift?.partIds ?? []);
  const liftPose: PoseValidity = lift?.directionOverridden ? 'direction-overridden' : 'valid';
  for (const state of states) {
    if (state === 'rest') {
      output.rest = summarize(screenInterference(geometry), { poseValidity: 'valid' });
      continue;
    }
    if (state === 'push') {
      if (!push) continue; // pushUnavailable 已记原因，不产出这一态（不拿 lift 冒充）
      // 复合位姿：先顶升（有顶升轴才抬）再沿移载方向推出。姿态不可信时（方向被 config 覆盖）
      // 该态同样降级为待复核，与 lift 同一口径。
      const liftedPose = lift ? shiftParts(geometry, lift.partIds, lift.direction, lift.strokeMm) : geometry;
      const pushed = shiftParts(liftedPose, push.partIds, push.direction, push.strokeMm);
      const poseValidity: PoseValidity = push.directionOverridden || lift?.directionOverridden
        ? 'direction-overridden'
        : 'valid';
      const pushMovingIds = new Set<string>([...push.partIds, ...(lift?.partIds ?? [])]);
      output.push = summarize(screenInterference(pushed), { poseValidity, movingIds: pushMovingIds });
      continue;
    }
    if (!lift) continue; // needLift 已保证不会走到这里
    if (state === 'lift') {
      const lifted = shiftParts(geometry, lift.partIds, lift.direction, lift.strokeMm);
      output.lift = summarize(screenInterference(lifted), { poseValidity: liftPose, movingIds });
      continue;
    }
    // sweep：按 10 mm 逐步顶升；行程不是 10 的整数倍时补最后一步（到位位姿也要查）
    const steps: SweepStepSummary[] = [];
    for (let z = 0; z <= lift.strokeMm + 1e-9; z += SWEEP_STEP_MM) {
      const posed = shiftParts(geometry, lift.partIds, lift.direction, z);
      steps.push({ z: round1(z), ...summarize(screenInterference(posed), { poseValidity: z === 0 ? 'valid' : liftPose, movingIds }) });
    }
    const lastZ = steps[steps.length - 1]?.z ?? 0;
    if (lastZ < lift.strokeMm - 1e-9) {
      const posed = shiftParts(geometry, lift.partIds, lift.direction, lift.strokeMm);
      steps.push({ z: round1(lift.strokeMm), ...summarize(screenInterference(posed), { poseValidity: liftPose, movingIds }) });
    }
    const confirmedHits = steps.reduce((sum, step) => sum + step.confirmedHits, 0);
    output.sweep = {
      // 扫掠没有单一数字：pairs 取单步最大，其余按步累计（每步都可能撞）
      pairs: Math.max(0, ...steps.map((step) => step.pairs)),
      hits: steps.reduce((sum, step) => sum + step.hits, 0),
      screenHits: steps.reduce((sum, step) => sum + step.screenHits, 0),
      confirmedHits,
      mates: steps.reduce((sum, step) => sum + step.mates, 0),
      mm3: round1(steps.reduce((sum, step) => sum + step.mm3, 0)),
      mm3Confirmed: round1(steps.reduce((sum, step) => sum + step.mm3Confirmed, 0)),
      mm3Screen: round1(steps.reduce((sum, step) => sum + step.mm3Screen, 0)),
      mm3Declared: round1(steps.reduce((sum, step) => sum + step.mm3Declared, 0)),
      reviewStatus: steps.some((step) => step.reviewStatus === 'fail')
        ? 'fail'
        : steps.some((step) => step.reviewStatus === 'warn') ? 'warn' : 'pass',
      poseValidity: steps.some((step) => step.poseValidity === 'direction-overridden') ? 'direction-overridden' : 'valid',
      items: dedupeItems(steps.flatMap((step) => step.items)),
      step: SWEEP_STEP_MM,
      steps
    };
  }

  const rank: Record<ReviewStatus, number> = { fail: 2, warn: 1, pass: 0 };
  const reviewStatus = Object.values(output).reduce<ReviewStatus>(
    (worst, entry) => (rank[entry.reviewStatus] > rank[worst] ? entry.reviewStatus : worst),
    'pass'
  );

  return {
    ok: true,
    source: 'machine-geometry',
    geometrySource,
    partCount: geometry.parts.length,
    assemblyPartCount: geometry.assemblyPartCount ?? geometry.parts.length,
    lift,
    push,
    ...(pushUnavailable ? { unavailable: { push: pushUnavailable } } : {}),
    states: output,
    reviewStatus,
    precision: {
      screen: 'aabb',
      confirm: 'analytic-primitive',
      geometry: geometrySource,
      aabbOnly: [
        '绕 Z 旋转的长方体（包围盒会放大到 √2 倍）',
        '圆柱压长方体边角（圆不完整落在盒内）',
        '圆柱轴线不共线（只有同轴圆柱能解析求交）'
      ]
    },
    note: 'AABB 初筛 + 解析式确认：declared=已声明连接，mate=同轴嵌套配合（缸体×活塞杆这类，实体布尔必然重叠但不是设计干涉），'
      + 'suspect=待复核；suspect 再分 confirmedHits（解析式精确，可判 FAIL）与 screenHits（只有包围盒依据，只判 WARN）。'
      + 'mm3=pairs 的 AABB 上界合计（含 declared/mate，只作量级参考），mm3Confirmed/mm3Screen 是分开的真实口径。'
      + 'lift/sweep 按 config 的 travelMm 平移；若 config 方向与几何建模的伸出方向相反（poseValidity=direction-overridden），'
      + '该态只是反向平移、位姿不可达，动件相关命中一律降级为待复核。sweep 的计数按步累计，pairs 取单步最大。'
      + 'push 是可选的复合位姿（先顶升、再沿 +Y 推出）；机型没有移载轴时该态不产出，原因见 unavailable.push。'
      + `本次几何来源 geometrySource=${geometrySource}（输送类走参数化整机，其余形态走工位生成器），`
      + '结论只对这套零件表成立；和 B-Rep 结论对齐前先确认两边 assemblyPartCount 一致。'
  };
}
