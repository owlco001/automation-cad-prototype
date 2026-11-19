/**
 * M1「首层承托取放」纯数据概念验证：**承托接触断言** + **升降通道可行性判定**。
 *
 * 为什么单独一层（这是本轮唯一能把「假方案」和「真机构」分开的东西）：
 * 现有门禁只能证明「件不撞件」。A2 侧叉方案（叉臂挪到板外 y=±622）实测 rest/lift/sweep = 0/0/0，
 * 全绿 —— 可它对板是 **0% 承托**，板根本不在任何东西上。任何由 sweep 结果推导出来的
 * 「可行」都是错的。所以承托必须独立成一条会红的断言：
 *   - 件顶面贴板底 ±1 mm 才算「接触」；
 *   - 覆盖率、接触带、x 重叠三条各自判，缺一条就不算被托住。
 *
 * 第二件事是**不可行判定**：16 层 2278×1134 板走纯 Z 升降，真实成立的两条是
 * ① 承托面必然被板穿过（`load-passes-shelf`）、② 行程不变量缺口（`stroke-shortfall`）；
 * 净跨/走廊**不是**已证明的结构阻塞（审查实测：柱与板投影在 y 向不重叠，板从前后两排柱之间通过），
 * 它们只作为「当前结构参数下的保守设计阻塞」进 `designNotes`，需要结构确认，不得写成「任何整板过不去」。
 * 这个判定必须和「首层 M1 段能托住」同时出现在回执里，否则「首层绿」会被读成「多层可行」。
 * `feasible` 在 M1 口径下**恒 false**，且必须带 blockers；不许加任何参数把 false 变 true
 * （没有 reschedule/tolerance 通道）。
 *
 * **板位姿一律来自显式输入**（P1-1 的根因是这里曾用 `beltHeight` / 常量另算一份）：
 * - `pose.bottomZmm` 是板静止位姿的底面 z，**必填**，本模块不从带高推；
 * - `pose.centerXMm/centerYMm` 是板中心，**必填**，缺省 0 也算「猜」，所以直接拒绝；
 * - `carriedShiftMm`（轴位移）缺省从几何轴 `tower-lift` 的行程 + 拾取空行程推；两者都没有时按 0 处理
 *   并置 `m1.diagnosticError`，因此**缺失时不可能报 supported**；
 * - 调用方显式给的 `carriedShiftMm` 是**受控输入**，不许当「轴真的走了这么远」：
 *   ① 必须 > 0（负值 `INVALID_ARGUMENT`；0 只作诊断）；② 必须 ≤ `axis.strokeMm`（超行程/板抬超行程
 *   `INVALID_ARGUMENT`）；③ 几何里没有 `axis.strokeMm` 时只作诊断（`claim=diagnostic-only`）；
 *   ④ 拾取空行程只能靠 M1 缺省值（`m1-default`）时同样只作诊断 —— 板抬多少是按猜的空行程算的；
 * - 板在 carried 位的底面 = `pose.bottomZmm + max(0, shift − pickupGap)`，与
 *   `interference-states` 的 `workpiece.bottomZ.lift` 同一公式（轴先走空行程，板才离地）。
 *
 * **来源标注**：`supported` 一律带 `supportSource`（`fixture` / `geometry` / `conveyor-parts` /
 * `caller-rows`）与 `poseSource`。`caller-rows` 恒 `diagnostic-only`（调用方自带的行表证明不了
 * 属于本机）。生产塔的几何**现在包含板**（`geometry.parts` 里的 `workpiece-plate`，真实碰撞件），
 * 所以 `mode` 可以是 `verified` —— 但 `verified` 只说明「行表来自几何 + 碰撞集里有这块板」：
 * 该塔 rest 承托仍是 `unsupported`（单条 1200 整带）、carried 是 `diagnostic-only`（板**不随**
 * 塔轴移动，位移来源 missing）、多层 `feasible:false`。板只在 `workpiecePlaceholder` 里
 * （`parts` 里没有这块板本身：同 id + `role=workpiece` + 尺寸/中心一致 + 朝向一致，缺一即不算）时仍然只能是
 * `diagnostic-only` —— 那个 `inCollisionSet` 字段一律不信。
 *
 * **非有限坐标一律 fail-closed**：行表里任一行的 `min/max x/y/z` 不是有限值时，该行从接触判定中
 * **剔除**（既不当接触件，也不当「确认不接触」），记进 `invalidPartIds` + `diagnosticCode:
 * 'invalid-support-rows'`，并把 `diagnosticOnly` / `claim='diagnostic-only'` / `feasible=false` 钉死 ——
 * 即便其余行的几何 `verdict` 算出了 `supported`。理由：`NaN` 参与的 `>`/`<=` 比较恒 false，
 * 旧实现会把「z 读不出来」当成「顶面正好贴板底」，覆盖率与接触带被真实地顶高（P2）。
 *
 * 精度边界（写进回执，不许当验收）：
 * - 纯 AABB 承包（与 `interference.ts` 同口径），不是 B-Rep / 不是接触力学；
 * - 覆盖率按接触矩形**并集**解析计算（不是 10 mm 网格采样），所以对轴对齐矩形是精确值；
 * - 只算几何承托，不算挠度/屈曲/防坠/抱闸/导向/层定位 —— 板 35 mm 在两根 100 宽叉指上的
 *   挠度量级未校核（需 FEA/实测），所以 `supported` 只意味着「几何上贴住了」，不是「能安全承载」。
 */

import type { ConveyorPart } from './conveyor-assembly.ts';
import type { GeomPart, GeomShape, Vec3 } from './geometry.ts';
// 特征/件盒判据与 machine-geometry 共用同一份实现（T3 P1-1）：本文件不再自算局部盒。
import { inspectTransform, parsePartLocalBox, worldBoxFromLocal } from './feature-box.ts';
import {
  buildBufferTowerParts,
  bufferTowerParamsFromConfig,
  isBufferTowerConfig,
  type MachineBufferTowerConfig,
  type ResolvedBufferTowerParams
} from './buffer-tower-assembly.ts';

/* ------------------------------------------------------------------ *
 * 常量 / 阈值（一律回显，不许在调用点悄悄改）
 * ------------------------------------------------------------------ */

/**
 * 承托判定阈值。
 *
 * 为什么是这四个数（不是随手取整）：
 * - `minCoveredPct: 15`：两根 100 宽叉指（2000 长）对 2278×1134 板的覆盖是 **15.5%**
 *   （2×2000×100 / 2278×1134），实测只剩 0.5 个百分点余量。抬到 16% 就把真方案判死，
 *   所以这条阈值**不能再抬**；
 * - `minBands: 2`：单点/单条承托没有抗倾覆，且换向承托必须是两处独立接触（叉指/分段带的
 *   左右两条）。这一条能抓出「一整条 1200 宽带」这种看着覆盖 100%、实际只有一处支点的情形；
 * - `minBandOverlapXmm: 1900`：每条接触带沿板长方向要盖住 1900（板长 2278，两端各留 189）；
 * - `minContactOverlapXmm: 1500`：每个接触件自身在 x 向要 ≥1500，防止「多个窄片凑出覆盖率」。
 *
 * `contactToleranceMm: 1`：顶面与板底的高差在 ±1 mm 内才算接触（贴面只计接触，不计重叠）。
 */
export const PANEL_SUPPORT_THRESHOLDS = {
  minCoveredPct: 15,
  minBands: 2,
  minBandOverlapXmm: 1900,
  minContactOverlapXmm: 1500,
  contactToleranceMm: 1
} as const;

/**
 * M1 取放高度链（mm）。
 *
 * 叉指停位顶面 890 = 带底 896 − 6；带面 900 就是板底（第 1 层承托面）。
 * - `pickMm: 10`：890 → 900，叉指先走 10 mm 才贴到板底（轴上的 partPickupGapMm）；
 * - `transferMm: 10`：板底 900 → 910，真正把板抬起 10 mm；
 * - `segmentMm: 20`：M1 只声明 0..20 这一段（首层取放），**不是** 2700 满行程。
 */
export const M1_PICK_PLACE = { pickMm: 10, transferMm: 10, segmentMm: 20 } as const;

/**
 * 行程不变量用的两个偏置（mm）：
 * - `trayTopOffsetMm: 6.5`：第 n 层承托面 = 托板中心 `layerZ+5` + 半厚 1.5（见 buffer-tower-assembly）；
 * - `forkHomeClearanceMm: 10`：叉指停位顶面 890 到带面 900 的拾取空行程。
 * 于是 `strokeMm = (levels−1)·pitch + 6.5 + 10`：16 层 = 2716.5，而轴声明 2700 → 缺 16.5。
 */
export const TOWER_CHANNEL_STROKE = { trayTopOffsetMm: 6.5, forkHomeClearanceMm: 10 } as const;

/** 底层输送线带厚（与 `bufferTowerInboundParams` 的 beltThicknessMm=4 同口径）。 */
const TOWER_BELT_THICKNESS_MM = 4;
/** 叉指停位顶面比带底再低 6 mm（薄片贴带会在抬起 10 mm 时进带上行程带）。 */
const FORK_HOME_GAP_MM = 6;
/** 随升降轴走的件族（与 `machine-geometry.ts` 的 TOWER_LIFT_PART_PATTERNS 同口径）。 */
const LIFT_FOLLOW_PATTERN = /^lift-(platform|carriage|fork-|finger-)/;
/** 承托面/挡停件族：判「板投影内有没有承托面挡在路上」用（load-passes-shelf）。 */
const SHELF_PATTERN = /^(tray-\d+|tray-rail-|stop-|tray-roller-|layer-sensor-)/;
const EPS = 1e-6;
/**
 * 朝向等价判据（度）。绕 Z 的转角是**周期量**：360 ≡ 0、−90 ≡ 270，所以比较的是规范化后的
 * 最小夹角，不是原始数值差。板件在几何里只有整数值（生产塔 0°、夹具 0°），1e-6° 的余量只用于
 * 吸收 `round2` 之类的进位，**不**给「转了几度也算同一块」留口子。
 */
const ANGLE_EPS_DEG = 1e-6;

export type PanelChannelErrorCode = 'INVALID_ARGUMENT' | 'NOT_A_TOWER';

/**
 * 入参/前置条件不成立。**一律继承 RangeError**：调用方（工具层）用 `instanceof RangeError`
 * 区分「参数问题」与「程序缺陷」，与 `BufferTowerConfigError` 同一约定。
 */
export class PanelChannelError extends RangeError {
  readonly code: PanelChannelErrorCode;

  constructor(code: PanelChannelErrorCode, message: string) {
    super(message);
    this.name = 'PanelChannelError';
    this.code = code;
  }
}

function fail(code: PanelChannelErrorCode, message: string): never {
  throw new PanelChannelError(code, message);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

function requireFinite(value: unknown, label: string, options: { positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_ARGUMENT', `${label} 必须是有限数字（收到 ${JSON.stringify(value)}）`);
  }
  if (options.positive && value <= 0) {
    fail('INVALID_ARGUMENT', `${label} 必须大于 0（收到 ${value}）：尺寸/底面一律不夹紧，也不猜默认值`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 严格「是有限数字」判据（**不**做 `Number()` 强转）。
 *
 * 为什么不用 `Number.isFinite(Number(v))`：`Number(null) === 0`、`Number('') === 0`、
 * `Number('917.5') === 917.5`，于是 `center=[null,null,917.5]` 会被读成中心 (0,0)，
 * 回执还写「来自几何」—— 那正是「拿 0 顶替」的假阳性形状（P2-6）。
 */
function isStrictFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 两个绕 Z 转角的最小夹角（度，取值 −180..180）。用于「朝向是否等价」的判定：
 * 360 ≡ 0、−90 ≡ 270 都必须在同一边，否则一个 `rotationZDeg: 360` 的件会被误判成另一个朝向。
 */
function rotationDiffDeg(a: number, b: number): number {
  const diff = (((a - b) % 360) + 360) % 360;
  return diff > 180 ? diff - 360 : diff;
}

/**
 * 判定 `geometry.parts` 里的某件**就是占位体声明的那块板**。
 *
 * 四条必须同时成立：件号完全相同、`role === 'workpiece'`、box 的 `size` 与 `center` 与占位体在
 * ±EPS 内一致、绕 Z 转角与占位体声明的板朝向等价。只比 id 是不够的（P2-1）：把占位体 id 写成
 * `tray-2` 时，`parts` 里真有同 id 的托板，于是 `inCollisionSet` 被顶成 true，而位姿仍来自板占位体
 * —— 同 id 的托条/夹具件不是这块板。
 *
 * 为什么要比朝向：`size` 是**局部**尺寸，中心也是同一个点，所以「同中心、同尺寸、绕 Z 转 90°」的件
 * 在四条旧判据下逐项相等，但它的实际占位是 1134×2278（x/y 互换），与板不是同一个刚体位姿 ——
 * 拿它冒充就等于「碰撞集里有块板」而真正被 sweep 的是另一块。转角还必须是**有限数**：
 * `undefined`/`NaN`/`'90'` 都不是可核对的朝向，一律不算（不拿 0 顶替）。
 */
function isSamePlateMember(
  candidate: unknown,
  id: string,
  size: Vec3,
  center: Vec3,
  rotationZDeg: number
): boolean {
  if (!isRecord(candidate) || candidate.id !== id) return false;
  if (candidate.role !== 'workpiece') return false;
  const shape = candidate.shape;
  if (!isRecord(shape) || shape.type !== 'box') return false;
  const rawSize = shape.size;
  const rawCenter = candidate.center;
  if (!(Array.isArray(rawSize) && rawSize.length === 3 && rawSize.every(isStrictFiniteNumber))) return false;
  if (!(Array.isArray(rawCenter) && rawCenter.length === 3 && rawCenter.every(isStrictFiniteNumber))) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs((rawSize[axis] as number) - (size[axis] as number)) > EPS) return false;
    if (Math.abs((rawCenter[axis] as number) - (center[axis] as number)) > EPS) return false;
  }
  // 朝向：必须是有限数字（`Number(null) === 0` 之类的强转会把「没声明」变成 0，这里不转），
  // 且与占位体声明的板朝向在 ANGLE_EPS_DEG 内等价（周期量比较，360 与 0 同向）。
  if (!isStrictFiniteNumber(candidate.rotationZDeg)) return false;
  return Math.abs(rotationDiffDeg(candidate.rotationZDeg, rotationZDeg)) <= ANGLE_EPS_DEG;
}

/* ------------------------------------------------------------------ *
 * 板 / 支撑面
 * ------------------------------------------------------------------ */

export interface PanelSpec {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  /**
   * 板中心相对整机原点的偏移（mm）。
   *
   * 这两个字段**不许当装饰**：`resolvePanelSupport` 会原样回显 `panelCenterMm` 并据此算投影，
   * `resolveChannelFeasibility` 要求由 `pose` 显式给出（与这里冲突则拒绝），
   * `panelSourceOfGeometry` 从几何里读 `placeholder.center[0..1]` 填进来。
   */
  centerXMm?: number;
  centerYMm?: number;
}

/** 行表来源声明：`supported` 必须带它，否则「支持」无法溯源。 */
export type PanelSupportSource = 'fixture' | 'geometry' | 'conveyor-parts' | 'caller-rows';

/**
 * 板位姿（**三个数都由调用方显式给出**）。
 *
 * 为什么不做缺省：P1-1 的根因就是「函数内部按 `inbound.beltHeightMm` 和常量另算一份板位姿」，
 * 于是占位体抬高 100 mm、横向偏 500 mm 时回执照样回绿。缺省一旦存在，这条路就会再长回来。
 */
export interface PanelPoseInput {
  bottomZmm: number;
  centerXMm: number;
  centerYMm: number;
}

/**
 * 一条「承托面」的 AABB 行。
 *
 * 为什么不让纯函数直接吃 `ConveyorPart`/`GeomPart`：绑定包络盒算法会把纯函数和几何生成器
 * 焊在一起，测试就得先建整机。这里只收已经算好的盒（`supportRowsFromConveyorParts` /
 * `supportRowsFromGeometryParts` 是唯一两个适配器，二者对同一件表必须给出同一组盒 ——
 * 由 `buffer-tower-channel.test.mjs` 逐件断言）。
 */
export interface PanelSupportPart {
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface PanelSupportContact {
  partId: string;
  overlapXmm: number;
  overlapYmm: number;
  areaMm2: number;
}

/** 接触带（y 向并集的一段）：判「≥2 条带」与「每条带 x 重叠 ≥1900」。 */
export interface PanelSupportBand {
  fromMm: number;
  toMm: number;
  widthMm: number;
  /** 该带内所有接触件在 x 方向的并集长度（mm） */
  overlapXmm: number;
  partIds: string[];
}

export interface PanelSupportReport {
  pose: 'rest-on-level' | 'carried';
  panelBottomZmm: number;
  /** 支撑件相对静止位姿的 z 平移（M1 carried = pick+transfer = 20） */
  poseShiftMm: number;
  /** 板中心（原样回显：覆盖率随它变，不许在回执里看不见） */
  panelCenterMm: { xMm: number; yMm: number };
  panelAreaMm2: number;
  coveredAreaMm2: number;
  coveredPct: number;
  bandsY: PanelSupportBand[];
  contacts: PanelSupportContact[];
  /**
   * 纯几何判决。**`diagnosticOnly` 时它仍照实算**（测量值不是假的），
   * 但能不能当「承托证据」看 `claim`。
   */
  verdict: 'supported' | 'unsupported';
  /**
   * 可引用性：`supported` / `unsupported` 是几何结论；`diagnostic-only` 表示本次测量残缺，
   * `verdict` 只能当诊断、不得当证据。两类起因：
   * ① 行表来自调用方 / 板只是占位体（`diagnosticOnly=true` 入参）；
   * ② 行表里有**坐标非有限值**的承托行（`invalidPartIds` 点名）：这些行已从计算中剔除，
   *    剩余行的数字可能凑出 `verdict='supported'`，但缺的那几行谁也不知道托没托住。
   */
  claim: 'supported' | 'unsupported' | 'diagnostic-only';
  /** 行表来源（调用方声明的标签；`fixture` = 测试夹具件表，不是生产塔） */
  supportSource: PanelSupportSource;
  /** 板位姿从哪读来的（原样透出，便于复核） */
  poseSource: string;
  /** true = 本次不是承托证据（板不在碰撞件集，或行表来自调用方） */
  diagnosticOnly: boolean;
  /** 每条判据的实测/阈值（含未满足的那几条），给回执与复核用 */
  reasons: string[];
  /** 阈值原样回显：调用方不许猜用的是什么口径 */
  thresholds: typeof PANEL_SUPPORT_THRESHOLDS;
  toleranceMm: number;
  /** 参与判定的件数（已按 filter/pose 处理，且**已剔除坐标非有限值的行**） */
  supportPartCount: number;
  /**
   * 坐标读不出来的行（`min/max x/y/z` 任一不是有限值）。这些行**不参与**接触判定，
   * 但它们在场就说明本次测量残缺：`claim` 必为 `diagnostic-only`，`diagnosticCode`
   * 见 reasons 里的 `invalid-support-rows`。
   */
  invalidPartIds: string[];
  /** 有非有限坐标行时的稳定诊断码（干净输入不出现） */
  diagnosticCode?: 'invalid-support-rows';
}

function panelFootprint(panel: PanelSpec): { minX: number; maxX: number; minY: number; maxY: number } {
  const length = requireFinite(panel?.lengthMm, 'panel.lengthMm', { positive: true });
  const width = requireFinite(panel?.widthMm, 'panel.widthMm', { positive: true });
  requireFinite(panel?.thicknessMm, 'panel.thicknessMm', { positive: true });
  // 板中心**必须显式**：缺省 0 也是「猜」（旧实现就是这么把 +500 偏移吃掉的）
  const cx = requireFinite(panel.centerXMm, 'panel.centerXMm（板中心必须显式给出，不默认 0）');
  const cy = requireFinite(panel.centerYMm, 'panel.centerYMm（板中心必须显式给出，不默认 0）');
  return { minX: cx - length / 2, maxX: cx + length / 2, minY: cy - width / 2, maxY: cy + width / 2 };
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

/**
 * 一行的六个坐标是否全部为有限值。
 *
 * 单独判这一条的原因：`NaN` 进 `overlap1d`/比较会得到 `false`，于是「读不出坐标」和
 * 「确实不重叠」在布尔上无法区分 —— 承托面候选必须先按这条截住，再谈重叠（P2-3）。
 */
function hasFiniteBox(row: PanelSupportPart): boolean {
  return [row.minX, row.maxX, row.minY, row.maxY, row.minZ, row.maxZ].every(isStrictFiniteNumber);
}

/** 一维区间并集长度。 */
function unionLength(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([from, to]) => to - from > EPS)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursorFrom: number | null = null;
  let cursorTo = 0;
  for (const [from, to] of sorted) {
    if (cursorFrom === null) {
      cursorFrom = from;
      cursorTo = to;
      continue;
    }
    if (from <= cursorTo + EPS) {
      cursorTo = Math.max(cursorTo, to);
      continue;
    }
    total += cursorTo - cursorFrom;
    cursorFrom = from;
    cursorTo = to;
  }
  if (cursorFrom !== null) total += cursorTo - cursorFrom;
  return total;
}

/**
 * 承托判定（**纯函数**，不依赖内核/Electron/文件系统）。
 *
 * 接触口径：件的 **顶面** 与板底的高差绝对值 ≤ tolerance（缺省 1 mm），且 x-y 投影与板投影有面积重叠。
 * 重叠只计「贴面」，所以穿透件（顶面高于板底 +1mm）**不算**承托 —— 那会把「插进板里」当成托住。
 *
 * 覆盖率用 y 向切片 + x 向区间并集解析求交（对轴对齐矩形精确），不是网格估计。
 */
export function resolvePanelSupport(input: {
  parts: readonly PanelSupportPart[];
  panel: PanelSpec;
  /** 板底 z（mm）：接触面由输入提供，本函数不去猜 */
  bottomZmm: number;
  pose: 'rest-on-level' | 'carried';
  /** 支撑件相对静止位姿的 z 平移（mm），只用于回显 */
  poseShiftMm?: number;
  toleranceMm?: number;
  filter?: (id: string) => boolean;
  /** 行表来源声明（缺省 `caller-rows`）：`fixture` 的 supported 不许当生产结论引用 */
  supportSource?: PanelSupportSource;
  /** 位姿来源说明（原样回显，例：`geometry.workpiecePlaceholder.bottomZmm`） */
  poseSource?: string;
  /** true = 板只是占位体、行表不含生产承托路径 → 判决降级成 `diagnostic-only` */
  diagnosticOnly?: boolean;
}): PanelSupportReport {
  const panel = input.panel;
  const footprint = panelFootprint(panel);
  const bottomZ = requireFinite(input.bottomZmm, 'bottomZmm');
  const requestedDiagnosticOnly = input.diagnosticOnly === true;
  const supportSource = input.supportSource ?? 'caller-rows';
  const poseSource = input.poseSource ?? 'input.bottomZmm';
  const tolerance = input.toleranceMm === undefined
    ? PANEL_SUPPORT_THRESHOLDS.contactToleranceMm
    : requireFinite(input.toleranceMm, 'toleranceMm');
  if (tolerance < 0) fail('INVALID_ARGUMENT', `toleranceMm 不得为负（收到 ${tolerance}）`);
  if (!Array.isArray(input.parts)) fail('INVALID_ARGUMENT', 'parts 必须是数组（空数组可以，但不是缺省）');

  const contacts: PanelSupportContact[] = [];
  /** 坐标读不出来的行（已从接触判定剔除）：它们在场就把 claim 压成 diagnostic-only */
  const invalidParts: string[] = [];
  let consideredParts = 0;
  for (const part of input.parts) {
    if (!part || typeof part.id !== 'string') fail('INVALID_ARGUMENT', 'parts 里每一行都必须有 string 类型的 id');
    if (input.filter && !input.filter(part.id)) continue;
    // 非有限坐标的行**必须在接触判定之前截住**（P2 fail-open）：
    // `Math.abs(NaN - bottomZ) > tolerance` 求值为 false（NaN 比较恒 false），旧实现于是把
    // 「z 读不出来」当成「顶面正好贴在板底」，而它的 x/y 重叠与面积都是有限正数 —— 覆盖率与
    // 接触带被真实地顶高，可能把 unsupported 顶成 supported，回执里看不出异常。
    // 这里一律：该行不进 contacts（既不算接触件，也不算「确认不接触」），另记 invalidParts。
    if (!hasFiniteBox(part)) {
      invalidParts.push(part.id);
      continue;
    }
    consideredParts += 1;
    // 只有顶面贴板底才算接触：低于板底（gap 大）与高于板底（穿透）都不算
    if (Math.abs(part.maxZ - bottomZ) > tolerance) continue;
    const overlapX = overlap1d(part.minX, part.maxX, footprint.minX, footprint.maxX);
    const overlapY = overlap1d(part.minY, part.maxY, footprint.minY, footprint.maxY);
    if (overlapX <= EPS || overlapY <= EPS) continue;
    contacts.push({
      partId: part.id,
      overlapXmm: round2(overlapX),
      overlapYmm: round2(overlapY),
      areaMm2: round2(overlapX * overlapY)
    });
  }

  // 接触带：把接触的 y 区间（先裁到板投影内）并起来
  const yIntervals: Array<{ from: number; to: number; partId: string; overlapX: number }> = [];
  for (const contact of contacts) {
    const part = input.parts.find((row) => row.id === contact.partId);
    if (!part) continue;
    const from = Math.max(part.minY, footprint.minY);
    const to = Math.min(part.maxY, footprint.maxY);
    if (to - from <= EPS) continue;
    yIntervals.push({ from, to, partId: part.id, overlapX: contact.overlapXmm });
  }
  yIntervals.sort((a, b) => a.from - b.from);
  const bands: PanelSupportBand[] = [];
  for (const interval of yIntervals) {
    const last = bands[bands.length - 1];
    if (last && interval.from <= last.toMm + EPS) {
      last.toMm = Math.max(last.toMm, round2(interval.to));
      last.widthMm = round2(last.toMm - last.fromMm);
      last.partIds.push(interval.partId);
      last.overlapXmm = round2(unionLength(
        last.partIds.map((id) => {
          const row = input.parts.find((candidate) => candidate.id === id);
          return [Math.max(row?.minX ?? 0, footprint.minX), Math.min(row?.maxX ?? 0, footprint.maxX)] as const;
        })
      ));
      continue;
    }
    bands.push({
      fromMm: round2(interval.from),
      toMm: round2(interval.to),
      widthMm: round2(interval.to - interval.from),
      overlapXmm: round2(Math.min(interval.overlapX, footprint.maxX - footprint.minX)),
      partIds: [interval.partId]
    });
  }

  // 覆盖率（并集面积，解析）：按所有接触的 y 端点切片，每片求 x 并集
  const ys = new Set<number>();
  for (const interval of yIntervals) {
    ys.add(round4(interval.from));
    ys.add(round4(interval.to));
  }
  const yBreaks = [...ys].sort((a, b) => a - b);
  let coveredArea = 0;
  for (let index = 0; index + 1 < yBreaks.length; index += 1) {
    const from = yBreaks[index] ?? 0;
    const to = yBreaks[index + 1] ?? 0;
    if (to - from <= EPS) continue;
    const mid = (from + to) / 2;
    const xs: Array<readonly [number, number]> = [];
    for (const interval of yIntervals) {
      if (interval.from - EPS > mid || interval.to + EPS < mid) continue;
      const row = input.parts.find((candidate) => candidate.id === interval.partId);
      if (!row) continue;
      xs.push([Math.max(row.minX, footprint.minX), Math.min(row.maxX, footprint.maxX)]);
    }
    coveredArea += unionLength(xs) * (to - from);
  }
  const panelArea = (footprint.maxX - footprint.minX) * (footprint.maxY - footprint.minY);
  const coveredPct = panelArea > 0 ? round2((coveredArea / panelArea) * 100) : 0;

  const thresholds = PANEL_SUPPORT_THRESHOLDS;
  const bandOverlaps = bands.map((band) => band.overlapXmm);
  const minBandOverlap = bandOverlaps.length === 0 ? 0 : Math.min(...bandOverlaps);
  const minContactOverlap = contacts.length === 0 ? 0 : Math.min(...contacts.map((contact) => contact.overlapXmm));
  const coveredOk = coveredPct >= thresholds.minCoveredPct;
  const bandsOk = bands.length >= thresholds.minBands;
  const bandOverlapOk = bands.length > 0 && minBandOverlap >= thresholds.minBandOverlapXmm;
  const contactOverlapOk = contacts.length > 0 && minContactOverlap >= thresholds.minContactOverlapXmm;
  const verdict = coveredOk && bandsOk && bandOverlapOk && contactOverlapOk ? 'supported' : 'unsupported';
  // 测量残缺（有非有限坐标行）时 verdict 照实算 —— 但**不可引用**，即便它算出了 supported。
  // 注意这里是「或」，不是「覆盖入参」：调用方说 diagnosticOnly=false 也压不回 supported。
  const invalidRows = invalidParts.length > 0;
  const diagnosticOnly = requestedDiagnosticOnly || invalidRows;
  const claim: PanelSupportReport['claim'] = diagnosticOnly ? 'diagnostic-only' : verdict;

  const reasons: string[] = [
    `覆盖率 ${coveredPct}%（阈值 ≥${thresholds.minCoveredPct}%）→ ${coveredOk ? '满足' : '不满足'}，`
      + `接触面积 ${round2(coveredArea)} / 板投影 ${round2(panelArea)} mm²`,
    `接触带 ${bands.length} 条（阈值 ≥${thresholds.minBands}）→ ${bandsOk ? '满足' : '不满足'}`
      + `${bands.length > 0 ? `，y 向 ${bands.map((band) => `[${band.fromMm},${band.toMm}]`).join(' ')}` : ''}`,
    `每条带 x 重叠 ${bandOverlaps.length > 0 ? bandOverlaps.join('/') : '—'}（阈值 ≥${thresholds.minBandOverlapXmm}）`
      + ` → ${bandOverlapOk ? '满足' : '不满足'}`,
    `每个接触 x 重叠 ${contacts.length > 0 ? contacts.map((contact) => contact.overlapXmm).join('/') : '—'}`
      + `（阈值 ≥${thresholds.minContactOverlapXmm}）→ ${contactOverlapOk ? '满足' : '不满足'}`
  ];
  if (contacts.length === 0) {
    reasons.unshift(
      `没有任何件的顶面贴在板底 ${round2(bottomZ)} ±${tolerance} mm 内`
        + `（参与判定 ${consideredParts} 件）：板未被承托`
    );
  } else if (verdict === 'unsupported') {
    reasons.push('承托条件缺一即判 unsupported：覆盖率/接触带数量/x 重叠是三条独立条件，不许相互替代');
  }
  if (invalidRows) {
    const listed = invalidParts.slice(0, 6).join('/') + (invalidParts.length > 6 ? '…' : '');
    // 单独一条、单独一句：这是本次不可引用的**根因**，不许混在「覆盖率不满足」里被误读成测量结论
    reasons.unshift(
      `invalid-support-rows：行表里有 ${invalidParts.length} 件（${listed}）的 min/max x/y/z 不是有限值，`
        + '已从接触判定中剔除（既不算接触件，也不算「确认不接触」——读不出坐标的件可能正贴在板底，也可能挡住板）；'
        + `本次判决只覆盖其余 ${consideredParts} 件：几何 verdict=${verdict}，但缺少那 ${invalidParts.length} 件的读数，`
        + 'claim 只能是 diagnostic-only，不得当「能托住板」的证据'
    );
  }
  if (diagnosticOnly) {
    reasons.push(invalidRows
      ? 'diagnostic-only（invalid-support-rows）：起因是行表里有坐标非有限值的行，不是「板不在碰撞件集」'
        + '也不是「行表来自调用方」—— 数字残缺 ≠ 承托结论；补齐这些件的坐标后重算才能给 claim'
      : 'diagnosticOnly：板不在碰撞件集（parts 里没有这块板本身：同 id + role=workpiece + 尺寸/中心/朝向一致）'
        + '或行表来自调用方，'
        + '本报告只能当诊断，claim=diagnostic-only —— 不得当成「生产塔能托住板」的证据');
  }

  return {
    pose: input.pose,
    panelBottomZmm: round2(bottomZ),
    poseShiftMm: round2(input.poseShiftMm ?? 0),
    panelCenterMm: {
      xMm: round2(panel.centerXMm === undefined ? 0 : Number(panel.centerXMm)),
      yMm: round2(panel.centerYMm === undefined ? 0 : Number(panel.centerYMm))
    },
    panelAreaMm2: round2(panelArea),
    coveredAreaMm2: round2(coveredArea),
    coveredPct,
    bandsY: bands,
    contacts,
    verdict,
    claim,
    supportSource,
    poseSource,
    diagnosticOnly,
    reasons,
    thresholds,
    toleranceMm: tolerance,
    supportPartCount: consideredParts,
    invalidPartIds: invalidParts,
    ...(invalidRows ? { diagnosticCode: 'invalid-support-rows' as const } : {})
  };
}

/* ------------------------------------------------------------------ *
 * 适配器：ConveyorPart / GeomPart → 承托面盒
 * ------------------------------------------------------------------ */

/*
 * 单条特征 / 单件的局部盒判据**不在本文件里**：走 `feature-box.ts` 的 `parsePartLocalBox`，
 * 世界盒换算（rotateAboutZ + worldBoxFromLocal）**也不在本文件里**：同一份实现由
 * `machine-geometry.ts`（碰撞/包络/3D）与本文件（承托面行表）共用（review P2 第二轮
 * 把两份手写 `rotate2` / `rotateLocal` 合成一份 —— 真件表 `rz≠0` 的件为 0，分开写漂移了
 * 也没有用例会断）。
 * 抽走之前两处各写一套，同一个件表会给出相反结论（未知类型这边当"无外形"跳过、
 * 那边抛 INVALID_PART_GEOMETRY；suppressed 这边根本没读），见 T3 复审 P1-1。
 * 本文件只剩"遇到坏输入怎么办"：整件剔除并记 `droppedPartIds` → `invalid-shelf-geometry`
 * （逐件剔除，**不中断整张行表** —— 结构级坏件也一样）。
 */

/** `supportRowsFromConveyorPartsDetailed` 的结果：行表 + **量不出盒**的件号 */
export interface SupportRowsFromConveyorPartsResult {
  rows: PanelSupportPart[];
  /**
   * 量不出包围盒、**已剔除**的件号：特征参数读不出（非有限 / 退化 / 未知类型 / 轴向不认识 /
   * `at` 读不出）—— 判据与 `machine-geometry` 抛 `INVALID_PART_GEOMETRY` 是**同一份实现**
   * （`feature-box.ts`），所以「这边剔了」和「那边抛了」是同一组件。
   * **唯一例外**：整件没有实体外形（`no-solid-feature`，全是减材料/压缩特征）不进这里 ——
   * 它不是坏输入、也不是承托面，只是不成行（几何侧要当碰撞体，故那边抛）。
   * 调用方（`resolveChannelFeasibility`）必须把它当 `invalid-shelf-geometry` 处理，不许当「这件不存在」。
   */
  droppedPartIds: string[];
}

/**
 * `ConveyorPart → 承托面盒`（实体特征并集包围盒 + 绕 Z 旋转后的 AABB）。
 * 局部盒与世界盒换算**都不是**本文件算的：`parsePartLocalBox` / `worldBoxFromLocal`
 * （`feature-box.ts`）与 `machine-geometry.partWorldBounds` 是同一段代码；
 * 这里只做落位（`round2`）与随动位移（`shiftMm`）这两条**消费政策**。
 * 三条可证实的约束（都有用例，不靠措辞）：
 *   - `buffer-tower-channel.test.mjs`「逐件盒一致」：同一件表，两处逐件 min/max 相等；
 *   - `buffer-tower-model.test.mjs`「交叉一致性」：同一组坏特征，两处都判坏（且原因码相同）；
 *   - 本文件不再读 `node.type` 做政策判断 —— 减材料白名单只在 `feature-box.ts` 定义一次。
 * **例外只有一条**：整件没有实体外形（`no-solid-feature`）时本文件不成行、不记 dropped，
 * 几何侧仍抛 —— 那条在 `buffer-tower-model.test.mjs` 里也被显式断言，不是"漏了"。
 *
 * 返回 `{ rows, droppedPartIds }`：`droppedPartIds` 是「参数坏、量不出盒」被剔除的件，
 * 调用方拿它置 `invalid-shelf-geometry`。只想要行表的老调用方用下面的
 * `supportRowsFromConveyorParts`（等价于 `.rows`）。
 */
export function supportRowsFromConveyorPartsDetailed(
  parts: readonly ConveyorPart[],
  options: { shiftMm?: number; excludeIds?: readonly string[] } = {}
): SupportRowsFromConveyorPartsResult {
  const shift = options.shiftMm ?? 0;
  const exclude = new Set(options.excludeIds ?? []);
  const rows: PanelSupportPart[] = [];
  const droppedPartIds: string[] = [];
  for (const part of parts) {
    if (exclude.has(part.id)) continue;
    // 与 machine-geometry 同一份判据（含未知类型 / suppressed / 退化零盒 / NaN 参数）。
    // 一件里有一条实体特征量不出盒 → 整件都量不出（不许拿其余特征拼一个偏小的盒）。
    const local = parsePartLocalBox(part.features);
    if (local.kind === 'invalid') {
      // **唯一的政策差异**（有意保留，已用例锁死）：「整件没有实体外形」不是坏输入 ——
      // 它本来就不是承托面，不成行、不记 dropped。几何侧不同：那种件还要当碰撞体，量不出盒就必须抛。
      if (local.fault === 'no-solid-feature') continue;
      droppedPartIds.push(part.id);
      continue;
    }
    // 结构级坏件（review P2 第二轮）：transform 缺字段时旧代码读 `part.transform.rz` 抛 TypeError，
    // 整张行表中断。这里是逐件诊断通道，政策是「只剔这一件」，与几何侧的抛错同义。
    const transform = inspectTransform(part.transform);
    if (!transform.ok) {
      droppedPartIds.push(part.id);
      continue;
    }
    const { min, max } = local;
    const world = worldBoxFromLocal(transform.transform, { min, max });
    const dz = LIFT_FOLLOW_PATTERN.test(part.id) ? shift : 0;
    rows.push({
      id: part.id,
      minX: round2(world.min[0]),
      maxX: round2(world.max[0]),
      minY: round2(world.min[1]),
      maxY: round2(world.max[1]),
      minZ: round2(world.min[2] + dz),
      maxZ: round2(world.max[2] + dz)
    });
  }
  return { rows, droppedPartIds };
}

/**
 * 只要行表的老入口（`verify-channel` / 逐件盒一致性用例用）。
 * **诊断不能走这条**：`rows` 里看不到「量不出盒被剔除」的件（与"本来就不成行"的件一样缺席），
 * 判据一侧要用 `supportRowsFromConveyorPartsDetailed` 拿 `droppedPartIds`。
 */
export function supportRowsFromConveyorParts(
  parts: readonly ConveyorPart[],
  options: { shiftMm?: number; excludeIds?: readonly string[] } = {}
): PanelSupportPart[] {
  return supportRowsFromConveyorPartsDetailed(parts, options).rows;
}

function shapeHalf(shape: GeomShape): Vec3 {
  if (shape.type === 'box') return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
  const radius = shape.radius;
  const halfLength = shape.length / 2;
  return shape.axis === 'x'
    ? [halfLength, radius, radius]
    : shape.axis === 'y' ? [radius, halfLength, radius] : [radius, radius, halfLength];
}

/** `GeomPart → 承托面盒`（塔的分派路径用这个：干涉回执拿的是 `geometry.parts`）。 */
export function supportRowsFromGeometryParts(
  parts: readonly GeomPart[],
  options: { shiftMm?: number; excludeIds?: readonly string[] } = {}
): PanelSupportPart[] {
  const shift = options.shiftMm ?? 0;
  const exclude = new Set(options.excludeIds ?? []);
  const rows: PanelSupportPart[] = [];
  for (const part of parts) {
    if (exclude.has(part.id)) continue;
    const half = shapeHalf(part.shape);
    const rz = Number(part.rotationZDeg) || 0;
    const rad = (rz * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const wx = half[0] * cos + half[1] * sin;
    const wy = half[0] * sin + half[1] * cos;
    const center = part.center;
    const dz = LIFT_FOLLOW_PATTERN.test(part.id) ? shift : 0;
    rows.push({
      id: String(part.id),
      minX: round2(Number(center[0]) - wx),
      maxX: round2(Number(center[0]) + wx),
      minY: round2(Number(center[1]) - wy),
      maxY: round2(Number(center[1]) + wy),
      minZ: round2(Number(center[2]) - half[2] + dz),
      maxZ: round2(Number(center[2]) + half[2] + dz)
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 通道可行性
 * ------------------------------------------------------------------ */

/**
 * 能进 `blockers` 的三条（都是几何/行程事实，可复算）：
 * - `load-passes-shelf`：板投影内的承托面必然被纯 Z 升降穿过（命题，见架构文档 §6）；
 * - `no-support`：levels≥2 却找不到承托面（建造器缺陷，不是可行）；
 * - `stroke-shortfall`：轴声明行程 < M1 叉指口径到位所需。
 *
 * **净跨 / 走廊不在其中**：审查实测立柱与板的 y 向投影不重叠（板从前后两排立柱之间穿过），
 * AABB 没有证明「任何整板过不去」。它们降级为 `designNotes`，口径是「当前结构参数下的保守
 * 设计阻塞，需结构确认」。
 */
export type ChannelBlockerReason = 'load-passes-shelf' | 'no-support' | 'stroke-shortfall';

export type ChannelDesignNoteReason = 'clear-span-conservative' | 'corridor-conservative';

/**
 * `load-passes-shelf` 的**实测自由上升 witness**（可选字段，不是新 reason）。
 *
 * 全部由实际板位姿 + 承托件表 + 每层几何坐标算出，**不许写死 98.5 / 133.5 / 89**：
 * - `measuredFreeRiseFromPanelTopMm`：板**顶面**到最低遮挡件 `minZ` 的自由上升（16 层实测 98.5）；
 * - `measuredFreeRiseFromPanelBottomMm`：板**底面**到同一处的自由上升（16 层实测 133.5 = 98.5 + 板厚）；
 * - `firstObstructionPartIds`：`minZ` 与最低值相等的那些件（16 层是 `tray-roller-2-in/out`）；
 * - `firstObstructionZBand`：这些件的 z 区间。
 *
 * 件表一变（删/移动第 2 层第一处遮挡）这些值必须跟着变；算不出有限值时为 `null`，
 * 由调用方当诊断处理，**不许**回一个假绿的数字。
 *
 * **量到哪儿**：两个数都是量到遮挡件的 `minZ`（**底面 / 下表面**），不是量到承托面顶面。
 * 所以「距板顶 98.5」与「第 2 层承托面顶面 1080」不是同一个点，不能互相验算。
 *
 * `caliber` 明写行表口径：`geometry` = 行表由几何/件表派生（解析 AABB 读数），
 * `caller-rows` = 行表由调用方直接给出（证明不了属于本机）。它不是 10 mm 步长 sweep 的
 * 采样结果，两个口径不能混着报。
 */
export interface ChannelBlockerWitness {
  caliber: 'geometry' | 'caller-rows';
  measuredFreeRiseFromPanelTopMm: number;
  measuredFreeRiseFromPanelBottomMm: number;
  firstObstructionPartIds: string[];
  firstObstructionZBand: [number, number];
  note: string;
}

/**
 * `load-passes-shelf` 上的**诊断标记**（可选字段，不是新 reason、不改 feasibility 判据）。
 *
 * `invalid-shelf-geometry`：件表里有承托面候选无法判定是否挡路，两条来源都要标记：
 * ① 行在、但 min/max x/y/z 非有限值（NaN/Infinity）；
 * ② 行根本不在 —— 件的实体特征参数非有限/退化，量不出包围盒，适配器把它从行表剔除
 *    （`supportRowsFromConveyorPartsDetailed().droppedPartIds`；只影响件表路径，几何行表不受此途）。
 * 两者一律按「不可排除挡路」处理：witness 置 `null`、在 detail 里点名。绝不因为 NaN 在 x/y
 * 重叠里被算成「不重叠」、或因为行被删掉，就把它静默丢掉（那会让自由上升数字偏大 = fail-open）。
 */
export type ChannelBlockerDiagnosticCode = 'invalid-shelf-geometry';

export interface ChannelBlocker {
  /** 撞到第几层的承托面（与层无关时为 null） */
  level: number | null;
  partIds: string[];
  zBand: [number, number];
  reason: ChannelBlockerReason;
  /** 带数字的说明（例：板 2278 需穿过 tray-2-m） */
  detail: string;
  /** 仅 `load-passes-shelf`：实测自由上升 witness（算不出时为 null，不当绿用） */
  witness?: ChannelBlockerWitness | null;
  /** 仅 `load-passes-shelf`：件表里有无法判读的承托面候选时置 `invalid-shelf-geometry` */
  diagnosticCode?: ChannelBlockerDiagnosticCode;
  /**
   * 触发 `invalid-shelf-geometry` 的件号：坐标非有限值（行还在），或特征参数非有限/退化成
   * 无法量出包围盒、行被适配器剔除（件表路径）。两种都无法判定是否挡路。
   */
  invalidShelfPartIds?: string[];
}

/** 保守设计余量：**不是**已证明的阻塞，回执与文档都不得写成「过不去」。 */
export interface ChannelDesignNote {
  reason: ChannelDesignNoteReason;
  measuredMm: number;
  comparedToMm: number;
  /** 余量（正 = measured 比 compared 富余，负 = 差多少） */
  marginMm: number;
  detail: string;
}

/** 立柱与板投影的实测关系（判「净跨/走廊」到底是不是几何阻塞用）。 */
export interface ChannelColumnSweep {
  columnPartIds: string[];
  /** 柱与板投影在 x 向的最大重叠（mm） */
  xOverlapMm: number;
  /** 柱与板投影在 y 向的最大重叠（mm；0 = 板从两排柱之间通过） */
  yOverlapMm: number;
  /** 行程内与板体 AABB 真相交的柱（实测为空） */
  intersectingPartIds: string[];
  note: string;
}

export interface ChannelFeasibility {
  ok: true;
  /** true = 本回执不作为「通道可行/承托可用」的证据（板不在碰撞件集 / caller rows） */
  diagnosticOnly: boolean;
  panel: { lengthMm: number; widthMm: number; thicknessMm: number; massKg: number };
  /** 板位姿（显式输入，原样回显）与来源 */
  pose: { bottomZmm: number; centerXMm: number; centerYMm: number; source: string };
  levels: number;
  pitchMm: number;
  /**
   * 行程不变量（**M1 叉指停位口径**）：`(levels−1)·pitch + 6.5 + 10`；
   * 声明值 = `(levels−1)·pitch`。换回现轴台面停位（`lift-platform` AABB z 970..1010，底面 970）时并不缺，缺口只在换 M1 叉指后成立。
   */
  stroke: { declaredMm: number; requiredMm: number; shortfallMm: number; formula: string; caliber: string };
  /**
   * 立柱净跨（**保守读法，不是阻塞**）。
   * - `xClearMm` 按两侧立柱**外侧面**之间的距离计（2×1000=2000）—— 最宽松的读法；
   * - `xClearInnerMm` 是**真正的净跨**（立柱内侧面之间，1840）。
   * 两种读法都 < 板长 2278，但板并不沿 X 走、且在柱 y 带内侧（见 `columnSweep`），
   * 所以这条只进 `designNotes`。
   */
  clearSpan: {
    xClearMm: number;
    xClearInnerMm: number;
    requiredMm: number;
    shortfallMm: number;
    shortfallInnerMm: number;
  };
  /** 竖向走廊：立柱内侧面到托板边的自由宽度 vs 板半宽（同样是保守设计口径） */
  corridor: { corridorMm: number; halfWidthMm: number; shortfallMm: number };
  columnSweep: ChannelColumnSweep;
  pickPlace: {
    homeTopZmm: number;
    pickMm: number;
    transferMm: number;
    segmentMm: number;
    panelBottomZmm: { rest: number; lifted: number };
  };
  panelSupport: { rest: PanelSupportReport; carried: PanelSupportReport };
  /**
   * 首层 M1 段（0..20 mm）的结论：**只有这一段的绿是绿的**。
   * `feasible` 为 true 只说明「首层能托住并抬起 10 mm」，不说明任何一层以上能存。
   */
  m1: {
    segmentMm: number;
    restSupported: boolean;
    carriedSupported: boolean;
    /** 轴位移（mm）与其来源：input / axis / missing */
    carriedShiftMm: number;
    carriedShiftSource: 'input' | 'axis' | 'missing';
    pickupGapMm: number;
    pickupGapSource: 'input' | 'axis' | 'm1-default';
    /** 板在 carried 位相对静止位的抬高量 = max(0, shift − pickupGap) */
    boardLiftMm: number;
    /** 非 null = 这一段不能判绿的原因（缺位移 / 位移小于空行程） */
    diagnosticError: string | null;
    feasible: boolean;
    note: string;
  };
  /** 多层通道可行性。本期恒 false，且必须带 blockers —— 不许被局部 M1 绿覆盖 */
  feasible: boolean;
  blockers: ChannelBlocker[];
  /** 保守设计阻塞（净跨/走廊）：需要结构确认，**不是** AABB 证明的「过不去」 */
  designNotes: ChannelDesignNote[];
  note: string;
  thresholds: typeof PANEL_SUPPORT_THRESHOLDS;
}

function towerParamsOf(config: unknown): ResolvedBufferTowerParams {
  if (!isRecord(config)) fail('INVALID_ARGUMENT', 'config 必须是对象（缓存塔机型 config）');
  const raw = config.bufferTower;
  if (!isBufferTowerConfig(raw)) {
    fail('NOT_A_TOWER', 'config.bufferTower.kind 不是 tower：升降通道判定只对缓存塔成立（不从 formId/conveyor 猜）');
  }
  return bufferTowerParamsFromConfig({ bufferTower: raw as MachineBufferTowerConfig });
}

/** 从件号里读层号：`tray-3` / `tray-rail-3-left` / `stop-3` / `tray-roller-3-in` / `layer-sensor-3`。 */
function levelOfPart(id: string): number | null {
  const match = /^(?:tray|stop|layer-sensor)(?:-rail|-roller)?-(\d+)/.exec(id);
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isFinite(level) && level > 0 ? level : null;
}

/**
 * 通道可行性（**纯函数**）：行程/净跨/走廊/承托 + blockers + 保守设计 notes。
 *
 * `blockers` 只收**能复算的几何/行程事实**（承托面挡路、行程缺口）；净跨/走廊是保守设计口径，
 * 进 `designNotes`。审查实测：立柱内侧面 y=±675、板 y 半宽 567 → 两者投影**不重叠**，
 * 板是从前后两排立柱之间穿过去的（`columnSweep.yOverlapMm = 0`、`intersectingPartIds = []`），
 * 所以写「任何整板都过不去」是可证伪的假话，本函数不再这么说。
 *
 * 板位姿（`pose`）**必须显式传入**：底面 z 与中心 x/y 一律不在这里推、也不夹紧。
 */
export function resolveChannelFeasibility(input: {
  config: unknown;
  /** 件表（缺省按 config 现构造塔件表）；纯数据，不碰内核 */
  parts?: readonly ConveyorPart[];
  /** 已算好的承托面行（给了它就不再看 parts，用于几何分派路径） */
  rows?: readonly PanelSupportPart[];
  panel?: PanelSpec;
  /**
   * 板静止位姿。**必填**：`bottomZmm` 不许由 `inbound.beltHeightMm` 顶替，
   * `centerXMm/centerYMm` 不许缺省成 0（缺省 0 也是猜，直接拒绝）。
   */
  pose: PanelPoseInput;
  /** 位姿来源说明（回执原样透出；例：`geometry.workpiecePlaceholder`） */
  poseSource?: string;
  /** 轴位移（mm，含拾取空行程）；缺省从 `axis.strokeMm` 推，两者都没有时按 0 处理并置诊断错误 */
  carriedShiftMm?: number;
  /** 拾取空行程（mm，轴走这么多板才离地）；缺省从 `axis.pickupGapMm` 推，再缺省按 M1 值并标注 */
  pickupGapMm?: number;
  /** 几何轴信息：位移/空行程的来源（`checkPanelChannel` 从 `geometry.moving` 读） */
  axis?: { strokeMm?: number; pickupGapMm?: number };
  /** 行表来源声明（缺省 `conveyor-parts`） */
  supportSource?: PanelSupportSource;
  /** true = 本次不作为可行性/承托证据（板不在碰撞件集 / caller rows），强制 `feasible=false` */
  diagnosticOnly?: boolean;
}): ChannelFeasibility {
  const params = towerParamsOf(input.config);
  // caller-rows 一律只作诊断：调用方自带的行表无法证明「这些承托面就是这台机器上的件」，
  // 哪怕同一次调用还给了 pose 也不能升成证据（P1-R2 的入口）。
  const diagnosticOnly = input.diagnosticOnly === true || input.supportSource === 'caller-rows';
  const supportSource = input.supportSource ?? 'conveyor-parts';

  // ---- 板位姿：只用显式输入 ----
  const poseIn = input.pose;
  if (!isRecord(poseIn)) {
    fail('INVALID_ARGUMENT', 'pose 必填且必须是 { bottomZmm, centerXMm, centerYMm }：'
      + '板位姿不许从 beltHeight / 常量另推一份（P1-1 的根因）');
  }
  const bottomZ = requireFinite(poseIn.bottomZmm, 'pose.bottomZmm');
  const centerX = requireFinite(poseIn.centerXMm, 'pose.centerXMm');
  const centerY = requireFinite(poseIn.centerYMm, 'pose.centerYMm');
  const declaredPanel: PanelSpec = input.panel ?? {
    lengthMm: params.panel.lengthMm,
    widthMm: params.panel.widthMm,
    thicknessMm: params.panel.thicknessMm
  };
  // panel 自带的中心与 pose 冲突时**拒绝**，不静默择优
  for (const [key, actual, given] of [
    ['centerXMm', declaredPanel.centerXMm, centerX],
    ['centerYMm', declaredPanel.centerYMm, centerY]
  ] as const) {
    if (actual !== undefined && Math.abs(requireFinite(actual, `panel.${key}`) - given) > 1e-6) {
      fail('INVALID_ARGUMENT', `panel.${key}=${actual} 与 pose.${key}=${given} 冲突：`
        + '板位姿只允许有一个来源，请删掉 panel 里的中心或让两者一致');
    }
  }
  const panel: PanelSpec = { ...declaredPanel, centerXMm: centerX, centerYMm: centerY };

  // 行表来源：调用方行表原样用；件表路径要同时拿「因特征参数坏而量不出盒、被剔除」的件号
  // —— 那些件在 rows 里不存在，只看 rows 会把它们当「件表里没这件」（最终复审 P2-2）。
  let rows: readonly PanelSupportPart[];
  let droppedUnboundedIds: string[];
  if (input.rows) {
    rows = input.rows;
    droppedUnboundedIds = [];
  } else {
    const derived = supportRowsFromConveyorPartsDetailed(input.parts ?? buildBufferTowerParts(params));
    rows = derived.rows;
    droppedUnboundedIds = derived.droppedPartIds;
  }

  // ---- 轴位移与拾取空行程（carried 结论必须与轴行程同源）----
  const axisStroke = input.axis?.strokeMm !== undefined && Number.isFinite(input.axis.strokeMm)
    ? input.axis.strokeMm
    : undefined;
  let shiftSource: 'input' | 'axis' | 'missing';
  let shift: number;
  if (input.carriedShiftMm !== undefined) {
    shift = requireFinite(input.carriedShiftMm, 'carriedShiftMm');
    // 位移必须是「抬升方向」的正量：负值不是证据（板底公式只有 max(0, 位移 − 空行程) 这一条）
    if (shift < 0) {
      fail('INVALID_ARGUMENT', `carriedShiftMm=${shift} 为负：位移是轴把工件抬起的方向量，`
        + '负值不构成位移证据（不许靠夹紧/取绝对值把它算成抬起）');
    }
    shiftSource = 'input';
  } else if (axisStroke !== undefined) {
    shift = requireFinite(axisStroke, 'axis.strokeMm');
    shiftSource = 'axis';
  } else {
    shift = 0;
    shiftSource = 'missing';
  }
  let pickupGap: number;
  let pickupGapSource: 'input' | 'axis' | 'm1-default';
  if (input.pickupGapMm !== undefined) {
    pickupGap = requireFinite(input.pickupGapMm, 'pickupGapMm');
    pickupGapSource = 'input';
  } else if (input.axis?.pickupGapMm !== undefined && Number.isFinite(input.axis.pickupGapMm)) {
    pickupGap = Number(input.axis.pickupGapMm);
    pickupGapSource = 'axis';
  } else {
    pickupGap = M1_PICK_PLACE.pickMm;
    pickupGapSource = 'm1-default';
  }
  if (pickupGap < 0) fail('INVALID_ARGUMENT', `拾取空行程不得为负（收到 ${pickupGap}）`);
  // 与 interference-states 的 workpiece.bottomZ.lift 同一公式：轴先走空行程，板才离地
  const boardLift = round2(Math.max(0, shift - pickupGap));
  const carriedBottomZ = round2(bottomZ + boardLift);
  // fail-closed：位移/板抬不许超过轴自述行程。超了就是「拿一条轴没有的位移算抬起」——
  // 旧实现照收 carriedShiftMm=100（轴声明 20）并回 carried.supported，这正是 P1-1 的假阳性入口。
  if (axisStroke !== undefined && (shift > axisStroke + EPS || boardLift > axisStroke + EPS)) {
    fail('INVALID_ARGUMENT',
      `位移 ${round2(shift)}（板抬 ${boardLift}）超出轴自述行程 axis.strokeMm=${axisStroke}：`
      + '位移与来源声明不一致，不许按「能抬起」算；要么把位移收回到行程内，'
      + '要么先修轴声明（不许在判据里容忍越界）');
  }

  const panelTopZ = round2(bottomZ + panel.thicknessMm);
  const declared = params.liftTravelMm;
  const required = round2(
    (params.levels - 1) * params.layerPitchMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm + TOWER_CHANNEL_STROKE.forkHomeClearanceMm
  );
  const strokeShortfall = round2(required - declared);

  // 立柱净跨：外侧面读法（2000）与内侧面读法（1840）都回执
  const columns = rows.filter((row) => /^column-/.test(row.id));
  const leftOuter = columns.length > 0 ? Math.max(...columns.map((row) => Math.abs(row.minX))) : 0;
  const rightInner = columns.length > 0 ? Math.min(...columns.filter((row) => row.minX >= 0).map((row) => row.minX)) : 0;
  const leftInner = columns.length > 0 ? Math.max(...columns.filter((row) => row.maxX <= 0).map((row) => row.maxX)) : 0;
  const xClear = round2(2 * leftOuter);
  const xClearInner = round2(Math.abs(rightInner - leftInner));
  const trayRows = rows.filter((row) => /^tray-\d+$/.test(row.id));
  const trayHalfWidth = trayRows.length > 0
    ? Math.max(...trayRows.map((row) => Math.abs(row.maxY)))
    : round2((params.inbound.widthMm * 0.9) / 2);
  const columnInnerY = columns.length > 0
    ? Math.min(...columns.map((row) => Math.abs(row.maxY)))
    : 0;
  const corridor = round2(columnInnerY - trayHalfWidth);
  const halfWidth = round2(panel.widthMm / 2);

  // 柱与板投影的真实关系（判「净跨/走廊」是否成立为阻塞的唯一依据）
  const footprintForColumns = panelFootprint(panel);
  const columnZBand: [number, number] = [bottomZ, round2(params.topLayerZMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm + panel.thicknessMm)];
  const columnXOverlaps = columns.map((row) => overlap1d(row.minX, row.maxX, footprintForColumns.minX, footprintForColumns.maxX));
  const columnYOverlaps = columns.map((row) => overlap1d(row.minY, row.maxY, footprintForColumns.minY, footprintForColumns.maxY));
  const intersectingColumns = columns.filter((row) => (
    overlap1d(row.minX, row.maxX, footprintForColumns.minX, footprintForColumns.maxX) > EPS
    && overlap1d(row.minY, row.maxY, footprintForColumns.minY, footprintForColumns.maxY) > EPS
    && overlap1d(row.minZ, row.maxZ, columnZBand[0], columnZBand[1]) > EPS
  ));
  const columnSweep: ChannelColumnSweep = {
    columnPartIds: columns.map((row) => row.id),
    xOverlapMm: round2(columnXOverlaps.length > 0 ? Math.max(...columnXOverlaps) : 0),
    yOverlapMm: round2(columnYOverlaps.length > 0 ? Math.max(...columnYOverlaps) : 0),
    intersectingPartIds: intersectingColumns.map((row) => row.id),
    note: columns.length === 0
      ? '件表里没有 column-* 件：净跨/走廊不成立，不据此下任何阻塞结论'
      : intersectingColumns.length === 0
        ? `立柱与板体在行程内 AABB 不相交（y 向重叠 ${round2(Math.max(...columnYOverlaps))} mm）：`
          + '板从两排立柱之间通过，净跨/走廊不是已证明的阻塞'
        : `立柱与板体 AABB 相交 ${intersectingColumns.length} 件：这才是结构阻塞（需另立 blocker 并复核）`
  };

  // carried 什么时候不算证据（顺序即优先级：越靠前越说明「这条位移本身站不住」）
  const shiftDiagnostic: string | null = shiftSource === 'missing'
    ? 'carriedShiftMm 缺失（既没显式给，几何轴也没给）：按 0 mm 处理，carried 结论不可为 supported'
    : shiftSource === 'input' && axisStroke === undefined
      // 调用方自带位移，但几何里没有「这条轴走多远」的证据：位移与来源声明对不上
      ? `调用方给了 carriedShiftMm=${round2(shift)}，但几何轴没有 strokeMm（这台机器没有这个位移的证据）：`
        + 'carried 只作诊断（claim=diagnostic-only），不得当「轴真的抬了板」的结论'
      : shift <= EPS
        ? `位移 ${round2(shift)}（来源 ${shiftSource}）不大于 0：板没有被抬起（carried 底面 ${carriedBottomZ} 与静止位一致），`
          + 'carried 不可判 supported'
        : boardLift <= EPS
          ? `轴位移 ${shift} 不大于拾取空行程 ${pickupGap}：板没有被抬起（carried 底面 ${carriedBottomZ} 与静止位一致），`
            + 'carried 不可判 supported'
          : pickupGapSource === 'm1-default'
            ? `拾取空行程用了 M1 缺省值 ${pickupGap}（轴/调用方都没给）：板抬 ${boardLift} 是按猜的空行程算出来的，`
              + 'carried 只作诊断（claim=diagnostic-only）'
            : null;

  const supportRest = resolvePanelSupport({
    parts: rows,
    panel,
    bottomZmm: bottomZ,
    pose: 'rest-on-level',
    poseShiftMm: 0,
    supportSource,
    poseSource: input.poseSource ?? 'input.pose.bottomZmm',
    diagnosticOnly
  });
  const carriedRows: PanelSupportPart[] = rows.map((row) => (
    LIFT_FOLLOW_PATTERN.test(row.id)
      ? { ...row, minZ: round2(row.minZ + shift), maxZ: round2(row.maxZ + shift) }
      : row
  ));
  const supportCarried = resolvePanelSupport({
    parts: carriedRows,
    panel,
    bottomZmm: carriedBottomZ,
    pose: 'carried',
    poseShiftMm: shift,
    supportSource,
    poseSource: input.poseSource ?? 'input.pose.bottomZmm',
    // 位移缺失 / 板没离地 / 空行程是猜的：这一态不能算「被托住」的证据
    diagnosticOnly: diagnosticOnly || shiftDiagnostic !== null
  });

  // 板投影内的承托面（承托件 + 挡停 + 层辊 + 层光电）：纯 Z 升降必然穿过
  const footprint = panelFootprint(panel);
  const topShelfTargetZ = round2(params.topLayerZMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm);
  // 承托面候选先按件族取，**再把坐标非有限值的候选单独截住**（P2-3）。
  // 顺序有意义：NaN 一旦落进 `overlap1d` 就得到 NaN，`NaN > EPS` 是 false，这件会被当成
  // 「与板投影不重叠」静默丢出 shelves —— 最低遮挡换人，自由上升反而变大（105 而不是 98.5），
  // 是 fail-open。所以先认「读不出坐标」的候选，再谈 x/y 重叠。
  const shelfCandidates = rows.filter((candidate) => SHELF_PATTERN.test(candidate.id));
  const invalidShelfRows = shelfCandidates.filter((candidate) => !hasFiniteBox(candidate));
  const shelves = shelfCandidates.filter((row) => {
    if (!hasFiniteBox(row)) return false;
    if (row.maxZ <= panelTopZ + EPS) return false; // 在板顶以下的不挡上行
    if (row.maxZ > params.topLayerZMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm + EPS) return false; // 顶层以上不挡
    return overlap1d(row.minX, row.maxX, footprint.minX, footprint.maxX) > EPS
      && overlap1d(row.minY, row.maxY, footprint.minY, footprint.maxY) > EPS;
  });
  // 两条漏口都要并进同一份「无法判定是否挡路」清单（P2-3 + 最终复审 P2-2）：
  // ① 行在、但 x/y/z 非有限值（几何行表路径）；
  // ② 行根本不在，因为件的实体特征参数非有限/退化，适配器量不出包围盒（件表路径）——
  //    只看 `rows` 会把这件读成「件表里没有这件」，最低遮挡换人、witness 偏大且无诊断码。
  // 件表路径下「有实体特征但参数坏」的件一律进清单：哪怕它不是承托件族的候选，
  // 它同样可能才是最底层的那件，宁可 fail-closed 也不拿其余件的数字顶替。
  const invalidShelfIds = [...new Set([
    ...invalidShelfRows.map((row) => row.id),
    ...droppedUnboundedIds
  ])];
  const invalidShelfGeometry = invalidShelfIds.length > 0;
  const shelfIds = shelves.map((row) => row.id).slice(0, 6);
  const shelfLevels = [...new Set(shelves
    .map((row) => levelOfPart(row.id))
    .filter((level): level is number => level !== null))].sort((a, b) => a - b);
  const invalidShelfLevels = [...new Set(invalidShelfIds
    .map((id) => levelOfPart(id))
    .filter((level): level is number => level !== null))].sort((a, b) => a - b);
  const shelfLevel = shelfLevels[0] ?? invalidShelfLevels[0] ?? null;
  const shelfZBand: [number, number] = shelves.length > 0
    ? [round2(Math.min(...shelves.map((row) => row.maxZ))), round2(Math.max(...shelves.map((row) => row.minZ)))]
    : [0, 0];
  // 口径必须跟着行表来源走：caller-rows 的行表不是这台机器的几何，标签不许写「几何口径」（P2-2）。
  const witnessCaliber: ChannelBlockerWitness['caliber'] = supportSource === 'caller-rows' ? 'caller-rows' : 'geometry';
  const witnessCaliberText = witnessCaliber === 'caller-rows' ? '调用方行表口径' : '几何解析口径';
  // 实测自由上升 witness：从**这件表**的最低遮挡件 minZ 反算，不用任何写死的 98.5/133.5/89。
  // 板顶→遮挡 = minZ - (bottomZ + 板厚)，板底→遮挡 = minZ - bottomZ；两者差一个板厚，是两个口径。
  const shelfWitness: ChannelBlockerWitness | null = (() => {
    if (shelves.length === 0) return null;
    // 有读不出坐标的承托面候选时一律 null：那件可能才是最低遮挡，拿其余件的最小值冒充就是 fail-open
    if (invalidShelfGeometry) return null;
    const lowerZ = shelves.map((row) => row.minZ);
    if (lowerZ.length === 0 || !lowerZ.every((value) => Number.isFinite(value))) return null;
    const firstZ = Math.min(...lowerZ);
    if (!Number.isFinite(firstZ)) return null;
    const firstRows = shelves.filter((row) => Math.abs(row.minZ - firstZ) <= EPS);
    const firstMaxZ = Math.max(...firstRows.map((row) => row.maxZ));
    if (!Number.isFinite(firstMaxZ)) return null;
    return {
      caliber: witnessCaliber,
      // 已与板顶/板底相交时自由上升就是 0（不是负值）；这是「件表自相矛盾」的下限，不静默给绿
      measuredFreeRiseFromPanelTopMm: round2(Math.max(0, firstZ - panelTopZ)),
      measuredFreeRiseFromPanelBottomMm: round2(Math.max(0, firstZ - bottomZ)),
      firstObstructionPartIds: firstRows.map((row) => row.id).sort(),
      firstObstructionZBand: [round2(firstZ), round2(firstMaxZ)],
      note: `${witnessCaliberText}：AABB 最低遮挡件 **minZ（底面）**，不是 10 mm 步长 sweep 采样；`
        + `板顶/板底两个口径都量到同一个 minZ，相差 ${panel.thicknessMm} mm 板厚（不是量到承托面顶面）`
    };
  })();

  const blockers: ChannelBlocker[] = [];
  if (shelves.length > 0 || invalidShelfGeometry) {
    // 数字全部从件表派生：不写死「2 层 26 处」这类实测快照（件表一变就不符）
    const detailHead = shelves.length > 0
      ? `板 ${panel.lengthMm}×${panel.widthMm} 只做纯 Z 升降：第 ${shelfLevel ?? 2} 层承托面（顶面 ${shelfZBand[0]}）`
        + `在板投影内，板从 ${round2(bottomZ)} 抬到第 ${params.levels} 层 ${topShelfTargetZ} 必穿过它；`
        + `本件表在板投影内、板顶以上的承托面共 ${shelves.length} 件（涉及 ${shelfLevels.length} 层，件号前 ${shelfIds.length} 见 partIds）；`
      : `件表里有 ${invalidShelfIds.length} 件承托面候选（${invalidShelfIds.join('/')}）的坐标或特征参数不是有限值`
        + '（件表路径下量不出包围盒的件已从行表剔除，不当作「件表里没有这件」），'
        + '无法判定它们是否在板投影内、板顶以上：按「不可排除挡路」处理（既不声明可行，也不声明 no-support）；';
    const detailWitness = shelfWitness
      ? `实测自由上升（${witnessCaliberText}）：距板顶 ${shelfWitness.measuredFreeRiseFromPanelTopMm} mm、`
        + `距板底 ${shelfWitness.measuredFreeRiseFromPanelBottomMm} mm（两个数都量到遮挡件 **minZ 底面**`
        + ` = ${shelfWitness.firstObstructionZBand[0]}，不是量到第 ${shelfLevel ?? 2} 层承托面顶面 ${shelfZBand[0]}；`
        + `两者差 ${panel.thicknessMm} mm 板厚），首件 ${shelfWitness.firstObstructionPartIds.join('/')}`
      : invalidShelfGeometry
        ? `实测自由上升按 null 处理（invalid-shelf-geometry）：${invalidShelfIds.join('/')} 的 x/y/z 有非有限值`
          + '或特征参数非有限值（量不出包围盒），'
          + '无法量到遮挡件 minZ 底面；不拿其余件的数字顶替，也不当作可行依据'
        : '实测自由上升量无法从件表无歧义确定（坐标不是有限值）：此项只作诊断，不当作可行依据';
    blockers.push({
      level: shelfLevel,
      partIds: shelves.length > 0 ? shelfIds : invalidShelfIds.slice(0, 6),
      // 有可读承托面时给它的 z 区间；只有读不出坐标的候选时给「板要走的行程带」，不编一个承托面 z
      zBand: shelves.length > 0 ? shelfZBand : [round2(bottomZ), topShelfTargetZ],
      reason: 'load-passes-shelf',
      detail: detailHead + detailWitness,
      witness: shelfWitness,
      ...(invalidShelfGeometry
        ? { diagnosticCode: 'invalid-shelf-geometry' as const, invalidShelfPartIds: invalidShelfIds }
        : {})
    });
  } else if (params.levels > 1) {
    // 逻辑上不该走到这里（levels≥2 必有托板），但宁可报 no-support 也不静默放行
    blockers.push({
      level: 2,
      partIds: [],
      zBand: [round2(bottomZ), params.topLayerZMm],
      reason: 'no-support',
      detail: `件表里找不到第 2 层以上的承托面：${params.levels} 层塔却没有可承托的件（建造器缺陷，不是可行）`
    });
  }
  if (strokeShortfall > EPS) {
    blockers.push({
      level: params.levels,
      partIds: ['tower-lift'],
      zBand: [round2(bottomZ), round2(bottomZ + required)],
      reason: 'stroke-shortfall',
      detail: `轴声明行程 ${declared}，到位需要 ${required}（差额 ${strokeShortfall}）：`
        + `顶层承托面 ${round2(params.topLayerZMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm)} 落不到。`
        + `口径为 **M1 叉指停位**（叉指顶面 ${round2(bottomZ - TOWER_BELT_THICKNESS_MM - FORK_HOME_GAP_MM)} = 带底 ${round2(bottomZ - TOWER_BELT_THICKNESS_MM)} − ${FORK_HOME_GAP_MM}）；`
        + `现轴台面停位在该口径之上，换 M1 叉指才缺这 ${strokeShortfall} mm —— 不得读成现轴缺陷`
    });
  }

  // 净跨 / 走廊：**降级为保守设计 notes**（实测柱与板投影 y 向不重叠，AABB 没证明过不去）
  const designNotes: ChannelDesignNote[] = [];
  if (panel.lengthMm > xClear + EPS) {
    designNotes.push({
      reason: 'clear-span-conservative',
      measuredMm: xClear,
      comparedToMm: panel.lengthMm,
      marginMm: round2(xClear - panel.lengthMm),
      detail: `立柱净跨 ${xClear}（外侧面口径）/ ${xClearInner}（内侧面口径）< 板长 ${panel.lengthMm}`
        + `（缺 ${round2(panel.lengthMm - xClear)} / ${round2(panel.lengthMm - xClearInner)}）：`
        + `这是**当前结构参数下的保守设计余量**，需要结构确认；AABB 没有证明板与柱体相交——`
        + `板在 ${panel.widthMm / 2} 半宽内、柱内侧面在 y=±${columnInnerY}，两者 y 向重叠 ${columnSweep.yOverlapMm} mm`
    });
  }
  if (halfWidth > corridor + EPS) {
    designNotes.push({
      reason: 'corridor-conservative',
      measuredMm: corridor,
      comparedToMm: halfWidth,
      marginMm: round2(corridor - halfWidth),
      detail: `立柱内侧面到托板边的竖向走廊 ${corridor} < 板半宽 ${halfWidth}（缺 ${round2(halfWidth - corridor)}）：`
        + `同样是保守设计口径（拿「托板边到柱内侧」比「板半宽」，量纲与几何对象不同），`
        + `板边距柱面还有 ${columnSweep.yOverlapMm === 0 ? `≥${round2(columnInnerY - panel.widthMm / 2)}` : columnSweep.yOverlapMm} mm 净距；需结构确认，不是阻塞`
    });
  }

  const m1Feasible = supportRest.claim === 'supported'
    && supportCarried.claim === 'supported'
    && shiftDiagnostic === null
    && !diagnosticOnly;
  // 「读不出坐标的承托行」让承托测量残缺：这时 feasible 也不许绿，否则会出现
  // 「rest claim=diagnostic-only 但 feasible=true」这种自相矛盾的回执（claim 与可行判定同源）。
  const invalidSupportRows = supportRest.invalidPartIds.length > 0
    || supportCarried.invalidPartIds.length > 0;
  const invalidSupportIds = [...new Set([
    ...supportRest.invalidPartIds,
    ...supportCarried.invalidPartIds
  ])];

  return {
    ok: true,
    diagnosticOnly,
    panel: {
      lengthMm: panel.lengthMm,
      widthMm: panel.widthMm,
      thicknessMm: panel.thicknessMm,
      massKg: params.panel.massKg
    },
    pose: {
      bottomZmm: round2(bottomZ),
      centerXMm: round2(centerX),
      centerYMm: round2(centerY),
      source: input.poseSource ?? 'input.pose'
    },
    levels: params.levels,
    pitchMm: params.layerPitchMm,
    stroke: {
      declaredMm: declared,
      requiredMm: required,
      shortfallMm: strokeShortfall,
      formula: `(levels−1)×pitch + trayTopOffset(${TOWER_CHANNEL_STROKE.trayTopOffsetMm}) + forkHomeClearance(${TOWER_CHANNEL_STROKE.forkHomeClearanceMm})`
        + ` = ${params.levels - 1}×${params.layerPitchMm} + ${TOWER_CHANNEL_STROKE.trayTopOffsetMm} + ${TOWER_CHANNEL_STROKE.forkHomeClearanceMm} = ${required}`,
      caliber: `M1 叉指停位口径：叉指顶面 ${round2(bottomZ - TOWER_BELT_THICKNESS_MM - FORK_HOME_GAP_MM)}、`
        + `拾取空行程 ${TOWER_CHANNEL_STROKE.forkHomeClearanceMm}；现轴台面 AABB 为 z 970..1010（顶面 1010）不在本口径内`
    },
    clearSpan: {
      xClearMm: xClear,
      xClearInnerMm: xClearInner,
      requiredMm: panel.lengthMm,
      shortfallMm: round2(panel.lengthMm - xClear),
      shortfallInnerMm: round2(panel.lengthMm - xClearInner)
    },
    corridor: { corridorMm: corridor, halfWidthMm: halfWidth, shortfallMm: round2(halfWidth - corridor) },
    columnSweep,
    pickPlace: {
      homeTopZmm: round2(bottomZ - TOWER_BELT_THICKNESS_MM - FORK_HOME_GAP_MM),
      pickMm: M1_PICK_PLACE.pickMm,
      transferMm: M1_PICK_PLACE.transferMm,
      segmentMm: M1_PICK_PLACE.segmentMm,
      panelBottomZmm: { rest: round2(bottomZ), lifted: carriedBottomZ }
    },
    panelSupport: { rest: supportRest, carried: supportCarried },
    m1: {
      segmentMm: M1_PICK_PLACE.segmentMm,
      // 用 claim 而不是 verdict：diagnostic-only 的「supported」不算这一段成立
      restSupported: supportRest.claim === 'supported',
      carriedSupported: supportCarried.claim === 'supported',
      carriedShiftMm: round2(shift),
      carriedShiftSource: shiftSource,
      pickupGapMm: round2(pickupGap),
      pickupGapSource,
      boardLiftMm: boardLift,
      diagnosticError: shiftDiagnostic,
      feasible: m1Feasible,
      note: '首层 M1 段（0..20 mm）只证明「板被真实托住并抬起 10 mm」；它不证明一层以上能存，'
        + '也不证明结构/防坠/导向可用。多层结论看 blockers 与 feasible。'
        + `carried 底面 ${carriedBottomZ} = 静止 ${round2(bottomZ)} + max(0, 位移 ${round2(shift)} − 空行程 ${round2(pickupGap)})，`
        + '与 interference-states 的 workpiece.bottomZ.lift 同一公式'
    },
    feasible: blockers.length === 0 && !diagnosticOnly && !invalidSupportRows,
    blockers,
    designNotes,
    note: (diagnosticOnly
      ? supportSource === 'caller-rows'
        ? 'diagnosticOnly（caller-rows）：行表是调用方给的，不是这台机器的几何 —— 无法证明这些承托面属于本机，'
          + '承托数字只能当诊断，claim=diagnostic-only，feasible / m1.feasible 恒 false。'
          + '要可引用只能走「几何行表」这条路（`resolveChannelFeasibility` 不接调用方自带的行表当证据）。'
        : 'diagnosticOnly：板不在碰撞件集（`geometry.parts` 里没有同 id 件，或只有占位体）——'
          + '判据是「同 id + role=workpiece + size/center 与占位体一致 + rotationZDeg 与占位体声明的板朝向一致」，'
          + '同 id 的托板/夹具件、同中心同尺寸但绕 Z 转 90° 的件都不算；'
          + '占位体自带的 inCollisionSet 也不参与判定；件表里也没有把板挂进升降轴。'
          + '本回执的承托数字只能当诊断，feasible 恒 false。'
      : '')
      + (invalidSupportRows
        ? `invalid-support-rows：行表里有 ${invalidSupportIds.length} 件（${invalidSupportIds.slice(0, 6).join('/')}）`
          + '的 min/max x/y/z 不是有限值，已从接触判定中剔除；承托测量残缺 → rest/carried claim 只能是 '
          + 'diagnostic-only、feasible / m1.feasible 恒 false（不是「托不住」，也不是「能托住」）。'
        : '')
      + `不可行判定依据两条可复算的事实（不是缺参数）：`
      + `① 承托面必然被板穿过（板投影内的第 ${shelfLevel ?? 2} 层承托面，纯 Z 上升必穿过`
      + `${shelfWitness
        ? `；实测自由上升 距板顶 ${shelfWitness.measuredFreeRiseFromPanelTopMm} mm / 距板底 ${shelfWitness.measuredFreeRiseFromPanelBottomMm} mm`
          + `（均量到遮挡件 minZ 底面），首件 ${shelfWitness.firstObstructionPartIds.join('/')}`
        : invalidShelfGeometry
          ? `；自由上升量无法无歧义确定：件表里有 ${invalidShelfIds.length} 件承托面候选坐标/特征参数非有限值（invalid-shelf-geometry）`
          : '；自由上升量无法无歧义确定'}）；`
      + `② 行程不变量：声明 ${declared} 少于 M1 叉指口径所需 ${required}（缺 ${strokeShortfall}）。`
      + `净跨 ${xClear} < 板长 ${panel.lengthMm}、走廊 ${corridor} < 板半宽 ${halfWidth} 只作保守设计 notes：`
      + `实测柱与板体 AABB 在行程内不相交（y 向重叠 ${columnSweep.yOverlapMm} mm），`
      + `不得据此断言整板无法通过，需结构确认。`
      + '局部 M1 绿（首层 rest/carried 都 supported）不得读成「多层可行」',
    thresholds: PANEL_SUPPORT_THRESHOLDS
  };
}

/* ------------------------------------------------------------------ *
 * 板占位体识别 + 生产入口（只读检查）
 * ------------------------------------------------------------------ */

/** 板占位体的唯一件号（与 `machine-geometry.WORKPIECE_PART_ID` 同口径）。 */
export const PANEL_PART_ID = 'workpiece-plate';

export interface PanelSource {
  id: string;
  name: string;
  panel: PanelSpec;
  /** 静止位姿的板底 z（mm） */
  bottomZmm: number;
  /** 板中心 x / y（mm，同样来自几何，不再另推 0） */
  centerXMm: number;
  centerYMm: number;
  /**
   * 板是否在碰撞件表（parts）里：**只由 parts 里真正的同一块板决定** —— 件号完全相同、
   * `role==='workpiece'`、box `size`/`center` 与占位体在 ±EPS 内一致、`rotationZDeg` 有限且与
   * 占位体声明的板朝向等价（±1e-6°，周期量比较），**四条缺一即 false**。朝向这一条挡的是
   * 「同中心、同尺寸、绕 Z 转 90°」的件：局部 size 一样，实际占位却是 x/y 互换的另一块。
   * `workpiecePlaceholder` 自带的同名字段不参与判定；false = 只做承托诊断，不参与 AABB 判据。
   */
  inCollisionSet: boolean;
  /** 位姿从几何的哪一处读来的（回执原样透出） */
  poseSource: string;
}

/**
 * 从几何里认「板」：先认显式占位体（`geometry.workpiecePlaceholder`，由真实件投影），
 * 再认碰撞件表里 role/id 命中者（转移工位的老口径）。
 *
 * 位姿（`bottomZmm` + `centerXMm/centerYMm`）一律从几何读：占位体缺 `center` 就**不认**这块板
 * （返回 null → 调用方报 INVALID_ARGUMENT），不拿 0 顶替 —— 那正是 P1-1 的老毛病。
 *
 * 为什么要单独导出：`checkPanelChannel` 的前置条件就是「几何里真的有板」——
 * 没有板时**必须**报 INVALID_ARGUMENT，不许拿「没查到」当通过（N5）。
 */
export function panelSourceOfGeometry(geometry: unknown): PanelSource | null {
  if (!isRecord(geometry) || !Array.isArray(geometry.parts)) return null;
  const placeholder = isRecord(geometry.workpiecePlaceholder) ? geometry.workpiecePlaceholder : null;
  if (placeholder) {
    const size = placeholder.sizeMm;
    const center = placeholder.center;
    if (!(Array.isArray(size) && size.length === 3 && Array.isArray(center) && center.length === 3)) {
      // 占位体存在但形状/位姿不全：不认这块板（不拿 0 顶替，也不让 parts 里的别的件冒充）
      return null;
    }
    // 严格数字判据：`Number(null) === 0`、`Number('') === 0`、`Number('917.5') === 917.5`，
    // 拿 Number() 做「是不是数」的判据会把 null/'' 变成 0 并声称 poseSource 来自几何（P2-6）。
    if (![size[0], size[1], size[2], center[0], center[1], center[2]]
      .every(isStrictFiniteNumber)) {
      return null;
    }
    const lengthMm = size[0] as number;
    const widthMm = size[1] as number;
    const thickness = size[2] as number;
    const centerX = center[0] as number;
    const centerY = center[1] as number;
    if (!(lengthMm > 0 && widthMm > 0 && thickness > 0)) return null;
    const explicitBottomZ = placeholder.bottomZmm;
    if (explicitBottomZ !== undefined && !isStrictFiniteNumber(explicitBottomZ)) return null;
    const bottomZ = explicitBottomZ === undefined
      ? center[2] - thickness / 2
      : explicitBottomZ as number;
    if (!Number.isFinite(bottomZ)) return null;
    // `inCollisionSet` 只由**真实 parts 里这块板本身**决定：占位体自己写的 flag 一律不信，
    // 而且不是「同 id 就算」—— 还要 role==='workpiece' 且 box 尺寸/中心与占位体一致（±EPS）。
    // 同 id 的托板/夹具件（`tray-2` 之类）不许把 flag 顶成 true（P2-1）。
    const placeholderId = String(placeholder.id ?? PANEL_PART_ID);
    const placeholderSize: Vec3 = [lengthMm, widthMm, thickness];
    const placeholderCenter: Vec3 = [centerX, centerY, center[2] as number];
    // 板朝向：占位体是同**一件板**的投影，它声明的 `rotationZDeg` 就是这块板应有的朝向
    // （生产塔 `towerWorkpiecePart` 显式给 0°；夹具/转移工位的板件同样 0°）。
    // 字段缺失（老几何/手写占位体）按平放 0° 期望，仍要求候选件是真的 0°，而不是「随便转多少都行」；
    // 给了但不是有限数（NaN / Infinity / '90'）= 无法核对朝向，直接不认这块板（不拿 0 顶替）。
    const placeholderRotationRaw = placeholder.rotationZDeg;
    if (placeholderRotationRaw !== undefined && !isStrictFiniteNumber(placeholderRotationRaw)) return null;
    const placeholderRotationDeg = placeholderRotationRaw === undefined ? 0 : placeholderRotationRaw;
    const inCollisionSet = (geometry.parts as unknown[]).some((candidate) => (
      isSamePlateMember(candidate, placeholderId, placeholderSize, placeholderCenter, placeholderRotationDeg)
    ));
    return {
      id: placeholderId,
      name: String(placeholder.name ?? '工件（板件占位体）'),
      panel: {
        lengthMm,
        widthMm,
        thicknessMm: thickness,
        centerXMm: round2(centerX),
        centerYMm: round2(centerY)
      },
      bottomZmm: round2(bottomZ),
      centerXMm: round2(centerX),
      centerYMm: round2(centerY),
      inCollisionSet,
      poseSource: 'geometry.workpiecePlaceholder（center[0..1] + bottomZmm；inCollisionSet 按 parts 里'
        + '同 id + role=workpiece + size/center 与占位体一致、且 rotationZDeg 与占位体声明的板朝向等价的件派生）'
    };
  }
  const part = (geometry.parts as unknown[]).find((candidate): candidate is GeomPart => (
    isRecord(candidate) && (candidate.id === PANEL_PART_ID || candidate.role === 'workpiece')
  ));
  if (!part) return null;
  const shape = part.shape;
  if (shape.type !== 'box') return null;
  const rawSize = shape.size;
  if (!(Array.isArray(rawSize) && rawSize.length === 3 && rawSize.every(isStrictFiniteNumber))) return null;
  const size: Vec3 = [rawSize[0] as number, rawSize[1] as number, rawSize[2] as number];
  if (!(size[0] > 0 && size[1] > 0 && size[2] > 0)) return null;
  const rawCenter = part.center;
  if (!(Array.isArray(rawCenter) && rawCenter.length === 3 && rawCenter.slice(0, 2).every(isStrictFiniteNumber)
    && isStrictFiniteNumber(rawCenter[2]))) {
    return null;
  }
  const centerX = rawCenter[0] as number;
  const centerY = rawCenter[1] as number;
  return {
    id: String(part.id),
    name: String(part.name),
    panel: {
      lengthMm: size[0],
      widthMm: size[1],
      thicknessMm: size[2],
      centerXMm: round2(centerX),
      centerYMm: round2(centerY)
    },
    bottomZmm: round2(Number(part.center[2]) - size[2] / 2),
    centerXMm: round2(centerX),
    centerYMm: round2(centerY),
    inCollisionSet: true,
    poseSource: 'geometry.parts[workpiece].center'
  };
}

/**
 * 从几何里读升降轴的位移/拾取空行程（`checkPanelChannel` 唯一允许的轴来源）。
 *
 * **板必须在这条轴的 `partIds` 里**才返回位移：塔轴（`tower-lift`，partIds 只有
 * `lift-platform`）只带台面，把它的 2700 当成板的位移会得出一个不存在的 carried 位姿
 * （板底凭空 +2690）。板没挂轴时返回 `null` → 调用方按「位移缺失」处理（carried 只能诊断），
 * 不夹紧、不借用别条轴的行程。
 */
export function liftAxisOfGeometry(
  geometry: unknown,
  panelPartId: string
): { strokeMm?: number; pickupGapMm?: number; actuatorId?: string } | null {
  if (!isRecord(geometry) || !Array.isArray(geometry.moving)) return null;
  for (const entry of geometry.moving) {
    if (!isRecord(entry) || !Array.isArray(entry.partIds)) continue;
    const partIds = entry.partIds.map((id) => String(id));
    const actuatorId = entry.actuatorId === undefined ? undefined : String(entry.actuatorId);
    const isLift = actuatorId === 'tower-lift' || partIds.some((id) => LIFT_FOLLOW_PATTERN.test(id));
    if (!isLift) continue;
    // 轴找到了，但板不随它走：没有「板被抬起」的位移证据（不许把轴的行程当成板的位移）
    if (!partIds.includes(panelPartId)) continue;
    const strokeMm = Number(entry.strokeMm);
    const gapTable = isRecord(entry.partPickupGapMm) ? entry.partPickupGapMm : null;
    const gapRaw = gapTable && gapTable[panelPartId] !== undefined ? Number(gapTable[panelPartId]) : undefined;
    return {
      ...(Number.isFinite(strokeMm) ? { strokeMm } : {}),
      ...(gapRaw !== undefined && Number.isFinite(gapRaw) ? { pickupGapMm: gapRaw } : {}),
      ...(actuatorId === undefined ? {} : { actuatorId })
    };
  }
  return null;
}

export interface PanelChannelCheck {
  ok: true;
  /**
   * `diagnostic-only` = 本次不作可行性/承托证据。两种入口：
   * - 板**不在** `geometry.parts`（只有 `workpiecePlaceholder`，或占位体自报 `inCollisionSet:true`
   *   但 parts 里没有这块板本身）—— 判据是「同 id + `role=workpiece` + box `size`/`center` 与
   *   占位体一致（±EPS）+ `rotationZDeg` 与占位体声明的板朝向等价」，字段按 parts 里真正的板派生，
   *   不信手写 flag、也不认同 id 的非板件、也不认同中心同尺寸但转 90° 的件；
   * - `rowsSource='caller'`：行表是调用方给的，证明不了「这些承托面属于这台机器」。
   * 要转成 `verified` 只有一条路：不传 `rows`，让本函数从 `geometry.parts` 读行表，且板在碰撞件表里。
   * `verified` 只覆盖这两条，**不是**结构可行/承载认证。
   */
  mode: 'diagnostic-only' | 'verified';
  /** 板从哪来：只读占位体 / 碰撞件表 */
  panelSource: PanelSource;
  /** 行表从哪来：几何件表 / 调用方显式给的行 */
  rowsSource: 'geometry' | 'caller';
  /** 板位姿与实际使用的来源（不写死 900/0） */
  pose: { bottomZmm: number; centerXMm: number; centerYMm: number; source: string };
  panelSupport: { rest: PanelSupportReport; carried: PanelSupportReport };
  feasibility: ChannelFeasibility;
  note: string;
}

export interface PanelChannelCheckFailure {
  ok: false;
  code: PanelChannelErrorCode;
  message: string;
  hint?: string;
}

export type PanelChannelOutcome = PanelChannelCheck | PanelChannelCheckFailure;

/**
 * 生产入口（**只读**）：对一台缓存塔的几何做「承托 + 通道」检查。
 *
 * 前置条件（缺一即失败，不许空输入绿）：
 * - geometry 必须是带 parts 的整机几何；
 * - 几何里必须有板的**位姿**（`workpiecePlaceholder.center` 或 role/id 命中的件）—— N5；
 * - config 必须是缓存塔（`config.bufferTower.kind === 'tower'`）。
 *
 * **默认口径是「诊断」，不是「验收」**：只有「行表来自几何 + 板在碰撞件表里」才返回 `verified`。
 * 生产塔现在两条都成立（板是 `geometry.parts` 里的真实 `GeomPart`），所以 `mode='verified'` ——
 * 但它的承托结论仍是 `rest:unsupported`（单条 1200 整带）、`carried:diagnostic-only`
 * （板不随塔轴移动，位移来源 missing）、`feasibility.feasible:false`
 * （`load-passes-shelf` + `stroke-shortfall`）。**`verified` 不是结构可行/承载认证。**
 * 板只在占位体里（parts 里没有这块板本身，哪怕占位体写 `inCollisionSet:true`）或行表来自调用方时，
 * 一律返回 `mode:'diagnostic-only'`、`claim:'diagnostic-only'`、`feasible:false`。
 *
 * 不启动内核、不读文件、不改任何既有判据：本函数只做纯几何读数。
 */
export function checkPanelChannel(input: {
  config: unknown;
  geometry: unknown;
  /** 显式给的真实承托行表（缺省从 geometry.parts 读） */
  rows?: readonly PanelSupportPart[];
  /** 显式给的真实板位姿（缺省从几何里的板件/占位体读） */
  pose?: PanelPoseInput;
  /** 显式给轴位移；缺省从几何的升降轴读（板没挂进轴时不给） */
  carriedShiftMm?: number;
  pickupGapMm?: number;
}): PanelChannelOutcome {
  if (!isRecord(input.geometry) || !Array.isArray(input.geometry.parts)) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: 'geometry 必须是带 parts 的整机几何：缺几何就判不了承托（不做「空输入 → 通过」）',
      hint: '先 resolveMachineGeometry(config) 或从场景取几何，再查通道'
    };
  }
  const source = panelSourceOfGeometry(input.geometry);
  if (!source) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '几何里没有板的位姿（workpiecePlaceholder 缺 center / 无 role=workpiece 的件）：'
        + '「没查到板」不等于「板没被托住」，本检查必须拒绝，不能返回绿',
      hint: '几何里没有可识别的板占位体时不会返回承托结论；需要板件时先重建包含板占位体的几何，再执行诊断'
    };
  }
  const rowsSource: 'geometry' | 'caller' = input.rows ? 'caller' : 'geometry';
  const rows = input.rows ?? supportRowsFromGeometryParts(input.geometry.parts as GeomPart[], { excludeIds: [source.id] });
  const pose: PanelPoseInput = input.pose ?? {
    bottomZmm: source.bottomZmm,
    centerXMm: source.centerXMm,
    centerYMm: source.centerYMm
  };
  const poseSource = input.pose ? 'caller.pose（显式传入）' : source.poseSource;
  // verified 只认「行表来自几何 且 板在碰撞件表里」这两条同源证据：
  // - `rowsSource='caller'` 一律 diagnostic-only：调用方自带的行表证明不了「这些承托面属于这台机器」，
  //   哪怕同一次调用还给了 pose（P1-R2：夹具行表 + 生产几何曾报 verified/supported）；
  // - 板不在 parts（只有占位体、哪怕自报 inCollisionSet:true）即便配了 caller rows/pose 也不升级。
  const diagnosticOnly = rowsSource !== 'geometry' || !source.inCollisionSet;
  const axis = diagnosticOnly ? null : liftAxisOfGeometry(input.geometry, source.id);

  let feasibility: ChannelFeasibility;
  try {
    feasibility = resolveChannelFeasibility({
      config: input.config,
      rows,
      // 只传尺寸：中心由 pose 唯一提供（两者都带中心会互相冲突，见 resolveChannelFeasibility 的冲突拒绝）
      panel: {
        lengthMm: source.panel.lengthMm,
        widthMm: source.panel.widthMm,
        thicknessMm: source.panel.thicknessMm
      },
      pose,
      poseSource,
      ...(input.carriedShiftMm === undefined ? {} : { carriedShiftMm: input.carriedShiftMm }),
      ...(input.pickupGapMm === undefined ? {} : { pickupGapMm: input.pickupGapMm }),
      ...(axis
        ? {
          axis: {
            ...(axis.strokeMm === undefined ? {} : { strokeMm: axis.strokeMm }),
            ...(axis.pickupGapMm === undefined ? {} : { pickupGapMm: axis.pickupGapMm })
          }
        }
        : {}),
      supportSource: rowsSource === 'caller' ? 'caller-rows' : 'geometry',
      diagnosticOnly
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        ok: false,
        // 只把本模块自己的错误码透出去：别的 RangeError（塔参数校验等）不再冒充 NOT_A_TOWER
        code: error instanceof PanelChannelError ? error.code : 'INVALID_ARGUMENT',
        message: error.message
      };
    }
    throw error;
  }
  return {
    ok: true,
    mode: diagnosticOnly ? 'diagnostic-only' : 'verified',
    panelSource: source,
    rowsSource,
    pose: {
      bottomZmm: feasibility.pose.bottomZmm,
      centerXMm: feasibility.pose.centerXMm,
      centerYMm: feasibility.pose.centerYMm,
      source: feasibility.pose.source
    },
    panelSupport: feasibility.panelSupport,
    feasibility,
    note: diagnosticOnly
      ? rowsSource === 'caller'
        ? 'diagnosticOnly（caller-rows）：调用方给了 rows —— 行表来源不是几何，无法证明这些承托面属于这台机器。'
          + '承托数字只作诊断，claim=diagnostic-only、feasible/m1.feasible 恒 false；'
          + '要可引用只能让本函数从 geometry.parts 读行表（不传 rows），且板必须在碰撞件表里'
        : 'diagnosticOnly（板不在碰撞件集）：geometry.parts 里没有同 id 的板件 —— 只看占位体/占位体自报的 '
          + 'inCollisionSet 不算证据（判据是同 id + role=workpiece + size/center 与占位体一致 + rotationZDeg 朝向一致；'
          + '该字段按 parts 里真正的板派生，不认手写值，同 id 的托板/夹具件与转 90° 的同尺寸件也不算）。'
          + '承托数字只作诊断，claim=diagnostic-only，feasible 恒 false；'
          + '调用方自带 rows/pose 也升不成证据（verified 只认几何行表 + 碰撞集里的板）'
      : '只读检查（verified）：只说明「行表来自几何 + 碰撞集里有这块板」，不是结构可行/承载认证；'
        + `行表来源 ${rowsSource}、位姿来源 ${feasibility.pose.source}；`
        + `rest=${feasibility.panelSupport.rest.claim}（${feasibility.panelSupport.rest.coveredPct}%、`
        + `${feasibility.panelSupport.rest.bandsY.length} 带）、carried=${feasibility.panelSupport.carried.claim}`
        + `（位移来源 ${feasibility.m1.carriedShiftSource}：板不随塔轴移动时 carried 只能是诊断）；`
        + '`feasibility.feasible=false` 是「多层通道不成立」'
        + (feasibility.panelSupport.rest.invalidPartIds.length > 0
          || feasibility.panelSupport.carried.invalidPartIds.length > 0
          ? `；**注意**：行表里有 ${new Set([
            ...feasibility.panelSupport.rest.invalidPartIds,
            ...feasibility.panelSupport.carried.invalidPartIds
          ]).size} 件坐标非有限值（invalid-support-rows），承托 claim 已降为 diagnostic-only —— 那不是「托不住」，`
            + '是「读不全」'
          : '')
  };
}
