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
 * `push`（顶升移载的 +Y 送出）是**复合位姿**：先按顶升轴把升降架 + 4 段 Y 短带抬到行程顶
 * （板随之离开 X 带），再按移载轴把板沿 +Y 送到行程末端。真机就是这个顺序（顶起来再送），
 * 只按 +Y 平移而不顶升会得出一个不存在的位姿（板会从 X 带上犁过去）。没有移载轴时**不产出** push 态
 * （不退化成「等于 lift」，那正是 t05 抓到的老毛病），原因写进 `unavailable.push`，整次检查仍算成功
 * —— 否则给一台转向机做四态评审会整条降级成 N/A。
 */

import type { MachineConfig } from '../commission/machine-config.ts';
import {
  WORKPIECE_PART_ID,
  resolveMachineGeometry,
  type MachineGeometrySource
} from './machine-geometry.ts';
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
  /**
   * 工件参与的**重叠对**数（含 declared/mate）。0 不代表没查（板压在带上是贴面不是重叠），
   * 只说明这一态板没互穿任何东西；配合 workpieceTouching 一起看才是「真的查了板」。
   */
  workpiecePairs?: number;
  /** 工件参与的**贴面对**数（rest/lift 时板压在带/辊上就是这一类，不算干涉但证明它在场） */
  workpieceTouching?: number;
}

export interface SweepStepSummary extends InterferenceStateSummary {
  /** 该步的顶升位移 mm（0 就是 rest 位） */
  z: number;
}

/**
 * 返回给调用方的**紧凑**步进摘要：只保留数字，不带 items。
 *
 * 为什么：8 步各带一份 items 就有 4 KB，四态加起来直接顶过 10 KB 的工具结果上限，
 * 结果会被裁成 `{truncated, preview}` —— 数字全丢。逐步的零件对已在态级 `items` 里去重汇总。
 */
export interface CompactSweepStep {
  z: number;
  pairs: number;
  hits: number;
  screenHits: number;
  confirmedHits: number;
  mm3: number;
  mm3Confirmed: number;
  poseValidity: PoseValidity;
  workpiecePairs?: number;
  workpieceTouching?: number;
}

export interface SweepStateSummary extends InterferenceStateSummary {
  step: number;
  steps: CompactSweepStep[];
}

export interface PushStepSummary extends InterferenceStateSummary {
  /** 该步的移载位移 mm（0 = 刚顶升到位、还没开始推） */
  y: number;
}

/** push 扫掠里最严重的一步（只给一行，逐对明细在该态的 items 里） */
export interface PushWorstStep {
  /** 位移 mm */
  at: number;
  pairs: number;
  screenHits: number;
  confirmedHits: number;
  mm3: number;
  mm3Confirmed: number;
}

/**
 * push 是**扫掠态**，不是端点态。
 *
 * 为什么必须扫：板沿 +Y 穿过出料口挡边（挡边是沿 X 的一段墙，板要横穿它）。
 * 端点（y = 1180）板已经在挡边外侧，开口够不够宽根本看不出来 —— 上一轮那个
 * 「挡边扫切板角 2520 mm³」正是只在**中途**才发生。只查端点等于又回到「看起来对」。
 *
 * 为什么**不**把每一点都摊开返回：114 个位姿的完整 summary 会把工具结果顶过 10 KB 上限，
 * 结果被裁剪成 `{truncated, preview}`，「四态」直接读不到（实测就炸在这一步）。
 * 所以检查逐点做、**只回聚合量**：查了几点（samples）、有命中的几点与范围（hitSamples/hitRange）、
 * 最坏一步（worst）；逐对明细在态级 items 里（去重后 ≤10 条）。
 */
export interface PushStateSummary extends InterferenceStateSummary {
  step: number;
  /** 实际检查过的位姿数（每 step mm 一个，含起点与终点） */
  samples: number;
  /** 有命中（确认或待复核）的位姿数；0 = 全程干净 */
  hitSamples: number;
  /** 第一个/最后一个有命中的位姿 mm；无命中为 null */
  hitRange: [number, number] | null;
  /** 最严重的一步；全程干净时为 null */
  worst: PushWorstStep | null;
  /** 有几个位姿「工件与机构贴面」（板在场证据：板被 Y 短带托着送出去） */
  workpieceTouchingSamples?: number;
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
  /**
   * 个别随动件的拾取空行程（mm）：`{ partId: 空行程 }`（一般只有工件）。
   * 工件静止时压在带面上、而顶升面比带面低几毫米，前几毫米行程它不动 —— 见 geometry.ts 的 partPickupGapMm。
   */
  partPickupGapMm?: Record<string, number>;
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

/**
 * 工件（板）在本次检查里的身份与口径。
 *
 * 为什么单列一块：工件是**料**，不是设备零件 —— 它必须参与干涉（板能不能推出出料口是几何问题），
 * 但绝不能出现在 BOM/成本/装配件数里。把口径做进返回值，下游就不用猜「partCount 为什么比 BOM 多 1」。
 */
export interface InterferenceWorkpieceInfo {
  partId: string;
  name: string;
  /** 长×宽×厚（mm），来自机床参数（缺省 1200×800×35） */
  sizeMm: Vec3;
  /** rest / lift 两态的工件底面 z（mm）：rest 贴 X 带面，lift 抬到 Y 短带面；push = lift 位姿再沿 +Y 平移 */
  bottomZ: { rest: number; lift: number | null };
  /** push 态沿 +Y 的平移量（mm）；没有移载轴时为 null */
  pushTravelMm: number | null;
  /** 几何刚体数（partCount）**含**工件：+1 */
  countedInPartCount: true;
  /** 装配件数（BOM/STEP 口径）**不含**工件：与无工件时一致 */
  countedInAssemblyPartCount: false;
  /** BOM / 成本**不含**工件：它是被加工对象，不是采购件 */
  inBom: false;
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
  /**
   * 工件（板）占位体：本次检查里它作为普通件参与**全部**碰撞对。
   * 没有工件（非移载机型 / 调用方给的几何里没建）时为 null。
   */
  workpiece: InterferenceWorkpieceInfo | null;
  /** 要了却给不出的状态（现在只有 push）：原因写在这里，不悄悄吞掉 */
  unavailable?: Partial<Record<InterferenceState, string>>;
  states: Record<string, InterferenceStateSummary | SweepStateSummary | PushStateSummary>;
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
  options: { poseValidity: PoseValidity; movingIds?: ReadonlySet<string>; workpieceId?: string | undefined }
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
  // 工件在场证明：重叠对 + 贴面对各自的计数。板压在带上属于「贴面」，不进 pairs，
  // 所以只报 pairs 会让人以为「板上什么都没查」。
  const workpieceId = options.workpieceId;
  const involvesWorkpiece = (pair: { a: unknown; b: unknown }): boolean =>
    String(pair.a) === workpieceId || String(pair.b) === workpieceId;
  const workpiecePairs = workpieceId
    ? screen.pairs.filter((pair) => involvesWorkpiece(pair)).length
    : undefined;
  const workpieceTouching = workpieceId
    ? screen.touchingPairs.filter((pair) => involvesWorkpiece(pair)).length
    : undefined;
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
    items,
    ...(workpieceId ? { workpiecePairs: workpiecePairs ?? 0, workpieceTouching: workpieceTouching ?? 0 } : {})
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
    partIds,
    ...travelOverridesOf(axis)
  };
}

/** 轴上的「个别件拾取空行程」：只收有限非负数，脏数据一律忽略（宁可多平移，也不静默乱动）。 */
function travelOverridesOf(axis: unknown): { partPickupGapMm?: Record<string, number> } {
  if (!isRecord(axis) || !isRecord(axis.partPickupGapMm)) return {};
  const table: Record<string, number> = {};
  for (const [id, value] of Object.entries(axis.partPickupGapMm)) {
    const gap = Number(value);
    if (id.length > 0 && Number.isFinite(gap) && gap >= 0) table[id] = gap;
  }
  return Object.keys(table).length > 0 ? { partPickupGapMm: table } : {};
}

/**
 * 件在顶升轴上的实际位移（mm）= 轴位移 − 拾取空行程（不小于 0，不超过轴位移）。
 * 没有空行程的件照常按 `zMm` 平移。
 */
function liftTravelOf(axis: LiftAxisInfo, partId: string, zMm: number): number {
  const gap = axis.partPickupGapMm?.[partId];
  if (gap === undefined) return zMm;
  return Math.max(0, zMm - gap);
}

/**
 * 某态的位姿（与 `runInterferenceStates` 内部**同一实现**）。
 *
 * 单独导出的目的：测试/评审要能自己复算「这个态到底是哪套零件摆在哪」，而不是各写一份平移规则。
 * 以前 push 态就是这样被写出两套口径（一套顶升、一套不顶升），数字对不上却看不出来。
 */
export function poseForState(input: {
  geometry: MachineGeometry;
  state: InterferenceState;
  lift: LiftAxisInfo | null;
  push: LiftAxisInfo | null;
  /** sweep 用：顶升位移 mm（缺省 = 满行程） */
  liftMm?: number;
  /** push 用：移载位移 mm（缺省 = 满行程） */
  pushMm?: number;
}): MachineGeometry {
  const { geometry, state, lift, push } = input;
  if (state === 'rest' || !lift) return geometry;
  const zMm = input.liftMm ?? lift.strokeMm;
  const overrides: Record<string, number> = {};
  for (const partId of Object.keys(lift.partPickupGapMm ?? {})) {
    overrides[partId] = liftTravelOf(lift, partId, zMm);
  }
  const lifted = shiftParts(geometry, lift.partIds, lift.direction, zMm, overrides);
  if (state !== 'push' || !push) return lifted;
  return shiftParts(lifted, push.partIds, push.direction, input.pushMm ?? push.strokeMm);
}

/** 扫掠态的汇总口径：pairs 取单步最大，计数与体积按步累计，items 去重（同一对会在多步重叠）。 */
function aggregateSteps<T extends InterferenceStateSummary>(
  steps: readonly T[],
  workpiece: boolean
): InterferenceStateSummary {
  const total = (pick: (step: T) => number): number => round1(steps.reduce((sum, step) => sum + pick(step), 0));
  const worst: ReviewStatus = steps.some((step) => step.reviewStatus === 'fail')
    ? 'fail'
    : steps.some((step) => step.reviewStatus === 'warn') ? 'warn' : 'pass';
  return {
    pairs: Math.max(0, ...steps.map((step) => step.pairs)),
    hits: steps.reduce((sum, step) => sum + step.hits, 0),
    screenHits: steps.reduce((sum, step) => sum + step.screenHits, 0),
    confirmedHits: steps.reduce((sum, step) => sum + step.confirmedHits, 0),
    mates: steps.reduce((sum, step) => sum + step.mates, 0),
    mm3: total((step) => step.mm3),
    mm3Confirmed: total((step) => step.mm3Confirmed),
    mm3Screen: total((step) => step.mm3Screen),
    mm3Declared: total((step) => step.mm3Declared),
    reviewStatus: worst,
    poseValidity: steps.some((step) => step.poseValidity === 'direction-overridden')
      ? 'direction-overridden'
      : 'valid',
    items: dedupeItems(steps.flatMap((step) => step.items)),
    ...(workpiece ? {
      workpiecePairs: steps.reduce((sum, step) => sum + (step.workpiecePairs ?? 0), 0),
      workpieceTouching: steps.reduce((sum, step) => sum + (step.workpieceTouching ?? 0), 0)
    } : {})
  };
}

/** 把指定零件沿方向平移 distance mm；其余零件原样保留（不修改入参）。 */
export function shiftParts(
  geometry: MachineGeometry,
  partIds: readonly string[],
  direction: Vec3,
  distanceMm: number,
  /** 个别件的实际位移覆盖（mm）：不传就全部按 distanceMm 平移 */
  travelOverridesMm?: Record<string, number>
): MachineGeometry {
  const moving = new Set(partIds);
  const [dx, dy, dz] = direction;
  return {
    ...geometry,
    parts: geometry.parts.map((part) => {
      if (!moving.has(String(part.id))) return part;
      const distance = travelOverridesMm?.[String(part.id)] ?? distanceMm;
      const center = Array.isArray(part.center) ? part.center : [0, 0, 0];
      return {
        ...part,
        center: [
          Number(center[0]) + dx * distance,
          Number(center[1]) + dy * distance,
          Number(center[2]) + dz * distance
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
  // 于是 push 态变成「顶两次升」——上一版实测 rollers 被抬到 915 撞上推板 400000 mm³。
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
  // 工件（板）：从几何里认，不从参数里另算 —— 保证「几何里有板」=「这次检查查了板」。
  // 只认 role/id 两条，都是几何自己标的；调用方给的 geometry 里没有就是 null（退回旧口径，不假装查过）。
  const workpiecePart = geometry.parts.find(
    (part) => part.id === WORKPIECE_PART_ID || part.role === 'workpiece'
  ) ?? null;
  const workpieceId = workpiecePart ? String(workpiecePart.id) : undefined;
  const workpieceHalfZ = workpiecePart && workpiecePart.shape.type === 'box'
    ? Number(workpiecePart.shape.size[2]) / 2
    : 0;
  // 工件在顶升轴上的实际位移 = 轴行程 − 拾取空行程（带空行程的件按表算）。
  const workpieceLiftMm = lift
    ? (workpieceId !== undefined ? liftTravelOf(lift, workpieceId, lift.strokeMm) : lift.strokeMm)
    : null;
  const workpiece: InterferenceWorkpieceInfo | null = workpiecePart
    ? {
      partId: String(workpiecePart.id),
      name: String(workpiecePart.name),
      sizeMm: workpiecePart.shape.type === 'box'
        ? [Number(workpiecePart.shape.size[0]), Number(workpiecePart.shape.size[1]), Number(workpiecePart.shape.size[2])]
        : [0, 0, 0],
      bottomZ: {
        rest: round1(Number(workpiecePart.center[2]) - workpieceHalfZ),
        lift: workpieceLiftMm === null
          ? null
          : round1(Number(workpiecePart.center[2]) - workpieceHalfZ + workpieceLiftMm)
      },
      pushTravelMm: push ? push.strokeMm : null,
      countedInPartCount: true,
      countedInAssemblyPartCount: false,
      inBom: false
    }
    : null;
  for (const state of states) {
    if (state === 'rest') {
      output.rest = summarize(screenInterference(geometry), { poseValidity: 'valid', workpieceId });
      continue;
    }
    if (state === 'push') {
      if (!push) continue; // pushUnavailable 已记原因，不产出这一态（不拿 lift 冒充）
      // 复合位姿 + **沿 +Y 扫掠**：先顶升（有顶升轴才抬）再沿移载方向逐点推出。
      // 只查端点是不够的：板是横穿出料口挡边出去的，开口窄了只在**中途**撞（见 PushStateSummary）。
      const poseValidity: PoseValidity = push.directionOverridden || lift?.directionOverridden
        ? 'direction-overridden'
        : 'valid';
      const pushMovingIds = new Set<string>([...push.partIds, ...(lift?.partIds ?? [])]);
      const samples: PushStepSummary[] = [];
      const pushAt = (pushMm: number): PushStepSummary => ({
        y: round1(pushMm),
        ...summarize(
          screenInterference(poseForState({ geometry, state: 'push', lift, push, pushMm })),
          { poseValidity: pushMm === 0 ? 'valid' : poseValidity, movingIds: pushMovingIds, workpieceId }
        )
      });
      for (let y = 0; y <= push.strokeMm + 1e-9; y += SWEEP_STEP_MM) samples.push(pushAt(y));
      const lastY = samples[samples.length - 1]?.y ?? 0;
      if (lastY < push.strokeMm - 1e-9) samples.push(pushAt(push.strokeMm));
      // 逐点明细只在内部用：返回 samples / hitSamples / hitRange / worst 四个紧凑量（见 PushStateSummary）
      const hitSteps = samples.filter((step) => step.confirmedHits + step.screenHits > 0);
      const worstStep = hitSteps.reduce<PushStepSummary | null>((best, step) => {
        if (!best) return step;
        if (step.mm3Confirmed !== best.mm3Confirmed) return step.mm3Confirmed > best.mm3Confirmed ? step : best;
        return step.confirmedHits > best.confirmedHits ? step : best;
      }, null);
      const pushSummary: PushStateSummary = {
        ...aggregateSteps(samples, workpieceId !== undefined),
        step: SWEEP_STEP_MM,
        samples: samples.length,
        hitSamples: hitSteps.length,
        hitRange: hitSteps.length > 0
          ? [hitSteps[0]?.y ?? 0, hitSteps[hitSteps.length - 1]?.y ?? 0]
          : null,
        worst: worstStep
          ? {
            at: worstStep.y,
            pairs: worstStep.pairs,
            screenHits: worstStep.screenHits,
            confirmedHits: worstStep.confirmedHits,
            mm3: worstStep.mm3,
            mm3Confirmed: worstStep.mm3Confirmed
          }
          : null,
        ...(workpieceId !== undefined
          ? { workpieceTouchingSamples: samples.filter((step) => (step.workpieceTouching ?? 0) > 0).length }
          : {})
      };
      output.push = pushSummary;
      continue;
    }
    if (!lift) continue; // needLift 已保证不会走到这里
    if (state === 'lift') {
      const lifted = poseForState({ geometry, state: 'lift', lift, push });
      output.lift = summarize(screenInterference(lifted), { poseValidity: liftPose, movingIds, workpieceId });
      continue;
    }
    // sweep：按 10 mm 逐步顶升；行程不是 10 的整数倍时补最后一步（到位位姿也要查）
    const steps: SweepStepSummary[] = [];
    for (let z = 0; z <= lift.strokeMm + 1e-9; z += SWEEP_STEP_MM) {
      const posed = poseForState({ geometry, state: 'sweep', lift, push, liftMm: z });
      steps.push({ z: round1(z), ...summarize(screenInterference(posed), { poseValidity: z === 0 ? 'valid' : liftPose, movingIds, workpieceId }) });
    }
    const lastZ = steps[steps.length - 1]?.z ?? 0;
    if (lastZ < lift.strokeMm - 1e-9) {
      const posed = poseForState({ geometry, state: 'sweep', lift, push });
      steps.push({ z: round1(lift.strokeMm), ...summarize(screenInterference(posed), { poseValidity: liftPose, movingIds, workpieceId }) });
    }
    output.sweep = {
      ...aggregateSteps(steps, workpieceId !== undefined),
      step: SWEEP_STEP_MM,
      // 逐步只回数字：items 已在态级去重汇总，逐步再带一份会把四态结果顶过 10 KB 上限
      steps: steps.map((step) => ({
        z: step.z,
        pairs: step.pairs,
        hits: step.hits,
        screenHits: step.screenHits,
        confirmedHits: step.confirmedHits,
        mm3: step.mm3,
        mm3Confirmed: step.mm3Confirmed,
        poseValidity: step.poseValidity,
        ...(step.workpiecePairs === undefined ? {} : { workpiecePairs: step.workpiecePairs }),
        ...(step.workpieceTouching === undefined ? {} : { workpieceTouching: step.workpieceTouching })
      }))
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
    workpiece,
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
      + '该态只是反向平移、位姿不可达，动件相关命中一律降级为待复核。'
      + 'sweep 的计数按步累计，pairs 取单步最大；push 同样是**扫掠**（每 10 mm 一个位姿，先顶升再沿 +Y 推出），'
      + '返回 samples/hitSamples/hitRange/worst（逐点数组不回传：会把结果顶过 10 KB 上限被裁成 preview）。'
      + 'push 是可选的复合位姿；机型没有移载轴时该态不产出，原因见 unavailable.push。'
      + (workpiece
        ? `工件（${workpiece.sizeMm.join('×')} mm，partId=${workpiece.partId}）作为普通件参与全部碰撞对：`
          + `rest 底面 ${workpiece.bottomZ.rest}${workpiece.bottomZ.lift === null ? '' : `、lift 底面 ${workpiece.bottomZ.lift}`}`
          + `${workpiece.pushTravelMm === null ? '' : `、push 再沿 +Y 平移 ${workpiece.pushTravelMm}`}；`
          + '每态的 workpiecePairs（重叠对）/workpieceTouching（贴面对）是「板真的在查」的证据。'
          + '口径：partCount（几何刚体数）含它 +1，assemblyPartCount / BOM / 成本**不含**（工件是被加工对象，不是采购件）。'
        : '本次几何里没有工件占位体（非移载机型或调用方直接给了不含工件的几何）：结论只对机构件成立，'
          + '「板能不能推出出料口」不在本结果的证明范围内。')
      + `本次几何来源 geometrySource=${geometrySource}（输送类走参数化整机，其余形态走工位生成器），`
      + '结论只对这套零件表成立；和 B-Rep 结论对齐前先确认两边 assemblyPartCount 一致。'
  };
}
