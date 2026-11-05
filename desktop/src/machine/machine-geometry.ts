/**
 * 整机几何的**唯一入口**：`resolveMachineGeometry(config)`。
 *
 * 背景（这次要消除的结构性问题）：同一台输送机原来有两套几何
 *   1. `geometry.ts generateMachineGeometry(config)` —— 48 件代理体（台面/立腿/工位底板/门架），
 *      被评审、三态干涉、3D 联调、STL/glTF 使用；
 *   2. `conveyor-assembly.ts buildConveyorParts(params)` —— 85 件真实结构（窄带×N、滚筒、机架、
 *      顶升单元、梳齿、转向电机），被 STEP/GLB/BOM/截图使用。
 * 两边验的不是同一台机器，于是出现「评审判 FAIL、B-Rep 判 PASS」的自相矛盾。
 *
 * 现在只有一条判定链：
 *   - config 的形态属于输送类（`formId` 落在 CONVEYOR_FORM_IDS，或 `config.conveyor`
 *     存在且能推出线体长/带宽）→ 走 `buildConveyorParts` 的参数化整机，再映射成
 *     `MachineGeometry`（件带 id/name/bbox/role，执行机构件带 actuatorId）；
 *   - 其余 10 种形态 → 原样回落 `generateMachineGeometry`，行为不变。
 *
 * 映射口径（必须写清楚，否则就是第三套几何）：
 *   - 一件 `ConveyorPart` ↔ 一件 `GeomPart`，id/name 原样保留 —— 干涉项里的 partId
 *     和 BOM/STEP 里的件号能直接对上；
 *   - `shape` 取该件所有实体特征的**并集包围盒**：全部实体特征同轴圆柱时给圆柱
 *     （半径/长度正好是包围盒），否则给长方体。所以 AABB 与真实件的外形盒一致，
 *     不会因为「按最大半尺寸取」把不对称件（电机箱 + 输出轴）放大成假重叠；
 *   - 配合面（缸体×活塞杆）在整机装配里是**同一个零件**（真机也是整件采购，
 *     B-Rep 布尔求和后就是一坨实体），所以映射后不会出现「缸体撞活塞杆」的配对，
 *     也就没有需要靠 mateReason 放行的假干涉。mateReason 规则本身未改，
 *     仍服务于把两件建成两个圆柱的几何（工位生成器 / 手写几何）；
 *   - 结构件之间的真实连接（横撑插纵梁、地脚旋入支腿、皮带绕包滚筒、导柱穿台板
 *     过孔……）由 `conveyorJoints()` 显式声明成 joints，干涉初筛据此放行；
 *     放行理由写在每条 joint 的 reason 里，可在评审结果里逐条复核。
 *
 * 诚实边界：映射件的外形是包围盒/主形体（不是 B-rep），`geometryFidelity` 仍是
 * `conceptual-estimate`；真正的实体布尔在 build123d 内核里对同一份 `buildConveyorParts`
 * 结果做（见 extension.ts 的导出链路，那边本来就用整机，未改动）。
 */

import type { MachineConfig } from './validate.ts';
import {
  DEFAULT_CONVEYOR,
  buildConveyorParts,
  conveyorBom,
  transferLayout,
  turnerLayout,
  type ConveyorPart,
  type ConveyorParams,
  type TransferLayout,
  type TurnerLayout
} from './conveyor-assembly.ts';
import {
  generateMachineGeometry,
  shapeHalfExtents,
  type GeomBomGroup,
  type GeomJoint,
  type GeomMovingAxis,
  type GeomPart,
  type GeomRole,
  type GeomShape,
  type MachineGeometry,
  type MachineGeometryOptions,
  type Vec3
} from './geometry.ts';

/** 几何来源：只有这两种，没有第三种。 */
export type MachineGeometrySource = 'conveyor-assembly' | 'station-generator';

export interface ResolvedMachineGeometry {
  geometry: MachineGeometry;
  source: MachineGeometrySource;
  /** 参与干涉/评审/3D 的几何刚体数（= geometry.parts.length，不是估算） */
  partCount: number;
  /** 整机装配件数（BOM/STEP 口径）：顶升气缸的活塞杆是按刚体拆出来的，故比 partCount 少 2 */
  assemblyPartCount: number;
  /** 为什么走这条源：给工具输出与排错用，一句话 */
  reason: string;
}

/** 输送类形态 id（forms.ts）：只有它们有参数化整机。 */
export const CONVEYOR_FORM_IDS: ReadonlySet<string> = new Set(['belt-line', 'chain-line']);

/** 输送类几何 kind（forms.ts 的 geometry.kind） */
const CONVEYOR_GEOMETRY_KINDS: ReadonlySet<string> = new Set(['conveyor']);

/** 能推出整机的形态：kind 优先（form 可能只有 kind），其次 id。 */
export function isConveyorForm(form: { id?: string | undefined; kind?: string | undefined } | null | undefined): boolean {
  if (!form) return false;
  const kind = typeof form.kind === 'string' ? form.kind : '';
  const id = typeof form.id === 'string' ? form.id : '';
  return CONVEYOR_GEOMETRY_KINDS.has(kind) || CONVEYOR_FORM_IDS.has(id);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 转向角：config.conveyor 显式给了就用它，否则从 turner-rotary 的分度角反推。 */
export function turnerAngleFromConfig(config: MachineConfig, explicit?: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(180, Math.round(explicit));
  }
  const actuators = Array.isArray(config.actuators) ? config.actuators : [];
  const rotary = actuators.find((actuator) =>
    typeof actuator?.id === 'string' && /turner-rotary|转向/i.test(`${actuator.id} ${String(actuator.name ?? '')}`)
  );
  const range = Number(rotary?.rotationRangeDeg);
  if (Number.isFinite(range) && range > 0) return Math.min(180, Math.round(range));
  return 0;
}

/**
 * 从 config 推出输送参数。缺线体长或带宽就返回 null（**回落**而不是报错）：
 * 靠猜长度生成一台「看起来对」的整机，比老老实实退回代理体更糟。
 */
export function conveyorParamsFromConfig(config: MachineConfig): ConveyorParams | null {
  const raw = config.conveyor;
  if (!raw || typeof raw !== 'object') return null;
  if (!isFinitePositive(raw.lengthMm) || !isFinitePositive(raw.widthMm)) return null;
  // 以典型值为基线，只覆盖 config 里真给了的字段：这样外面拿到的参数是完整、可复算的一份，
  // 具体夹紧/取整仍由 buildConveyorParts 自己的 normalizeParams 做（单一实现）。
  const overrides: Partial<ConveyorParams> = {};
  for (const key of [
    'beltHeightMm',
    'pulleyDiameterMm',
    'beltThicknessMm',
    'frameSectionMm',
    'layerPitchMm',
    'transferPartLengthMm',
    'transferPartWidthMm'
  ] as const) {
    const value = raw[key];
    if (isFinitePositive(value)) overrides[key] = value;
  }
  if (isFinitePositive(raw.layers)) overrides.layers = Math.round(raw.layers);
  if (raw.transferPresent === true) overrides.transferPresent = true;
  // 移载与转向互斥：两个都写时交给 conveyor-assembly 的护栏判（它会给出拒建理由），
  // 这里不做静默取舍——静默取舍正是「参数不生效却看不出来」的来源。
  return {
    ...DEFAULT_CONVEYOR,
    ...overrides,
    lengthMm: raw.lengthMm,
    widthMm: raw.widthMm,
    turnerAngleDeg: turnerAngleFromConfig(config, raw.turnerAngleDeg)
  };
}

/* ------------------------------------------------------------------ *
 * ConveyorPart → GeomPart
 * ------------------------------------------------------------------ */

type LocalBox = { min: Vec3; max: Vec3 };

/** 特征在零件局部坐标里的外形盒（box 居中；cylinder 按轴 + at 偏移）。 */
function featureLocalBox(node: ConveyorPart['features'][number]): { kind: 'box' | 'cylinder'; axis: 'x' | 'y' | 'z'; box: LocalBox } | null {
  const params = node.params as Record<string, unknown>;
  if (node.type === 'box') {
    const length = Number(params.length);
    const width = Number(params.width);
    const height = Number(params.height);
    if (![length, width, height].every((value) => Number.isFinite(value))) return null;
    return {
      kind: 'box',
      axis: 'z',
      box: { min: [-length / 2, -width / 2, -height / 2], max: [length / 2, width / 2, height / 2] }
    };
  }
  if (node.type === 'cylinder') {
    const radius = Number(params.diameter) / 2;
    const length = Number(params.height);
    const axis = params.axis === 'x' || params.axis === 'y' ? params.axis : 'z';
    const at = Array.isArray(params.at) ? (params.at as unknown[]).map((value) => Number(value) || 0) : [0, 0, 0];
    if (!Number.isFinite(radius) || !Number.isFinite(length) || radius <= 0 || length <= 0) return null;
    const half: Vec3 = axis === 'x' ? [length / 2, radius, radius] : axis === 'y' ? [radius, length / 2, radius] : [radius, radius, length / 2];
    const center: Vec3 = [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0];
    return {
      kind: 'cylinder',
      axis,
      box: {
        min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
        max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]]
      }
    };
  }
  return null; // holes / slot 是减材料特征，不参与外形
}

/** 零件实体特征的并集包围盒 + 「是否全部为同轴圆柱」。 */
function partSolidBox(part: ConveyorPart): { box: LocalBox; cylinders: { axis: 'x' | 'y' | 'z'; radius: number }[] } {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const cylinders: { axis: 'x' | 'y' | 'z'; radius: number }[] = [];
  let solids = 0;
  for (const node of part.features) {
    const parsed = featureLocalBox(node);
    if (!parsed) continue;
    solids += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, parsed.box.min[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, parsed.box.max[axis] ?? 0);
    }
    if (parsed.kind === 'cylinder') {
      cylinders.push({ axis: parsed.axis, radius: Number((node.params as Record<string, unknown>).diameter) / 2 });
    } else {
      cylinders.push({ axis: parsed.axis, radius: -1 }); // 有长方体特征 → 不是纯圆柱件
    }
  }
  if (solids === 0) return { box: { min: [0, 0, 0], max: [0, 0, 0] }, cylinders: [] };
  return { box: { min, max }, cylinders };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * 外形：纯圆柱件给圆柱（包围盒就是圆柱外接盒，轴向长度即盒长），其余给长方体。
 * 这样 `screenInterference` 的 AABB 与真实件一致，`exactOverlapMm3` 也能给出
 * 圆柱的解析体积（而不是把圆柱当方块算）。
 */
function shapeOf(box: LocalBox, cylinders: { axis: 'x' | 'y' | 'z'; radius: number }[]): GeomShape {
  const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const axis = cylinders[0]?.axis ?? 'z';
  const allCylinders = cylinders.length > 0 && cylinders.every((item) => item.radius > 0 && item.axis === axis);
  if (allCylinders) {
    const radius = Math.max(...cylinders.map((item) => item.radius));
    // 圆柱外接盒：两个径向尺寸都应等于 2r（不满足说明还有别的特征撑开，退回长方体）
    const radial = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
    const matches = radial.every((index) => Math.abs((size[index] ?? 0) - radius * 2) < 0.51);
    if (matches) {
      const length = axis === 'x' ? size[0] : axis === 'y' ? size[1] : size[2];
      return { type: 'cylinder', radius: round2(radius), length: round2(length), axis };
    }
  }
  return { type: 'box', size: [round2(size[0]), round2(size[1]), round2(size[2])] };
}

interface PartSemantics {
  role: GeomRole;
  bomGroup: GeomBomGroup;
  color: string;
}

const COLORS = {
  frame: '#5c646b',
  structure: '#8a949c',
  transfer: '#1f2937',
  fixture: '#f59e0b',
  actuator: '#9aa7b2',
  sensor: '#5d666e'
} as const;

/**
 * 材质 → 颜色：3D 里**不同材质必须不同色**，否则铝型材机架、Q235 加工件、45# 钢导柱
 * 在视口里是同一种灰，看图上分不出「哪件是外购钢件、哪件是铝件」。
 * 取色原则：铝浅（银灰）、Q235 深（钢灰偏蓝）、45# 更亮（亮钢）、PVC 绿（皮带一眼可辨）。
 * 与 `ConveyorMaterial` 一一对应，新增材质必须在这里给色，否则 type 检查会失败。
 */
const MATERIAL_COLORS: Record<string, string> = {
  AL6063: '#b9c4cc',
  Q235: '#6d7784',
  PVC: '#2f7d4f',
  STEEL45: '#e3eaf0'
};

const SEMANTICS: Array<{ test: RegExp; role: GeomRole; bomGroup: GeomBomGroup; color: string }> = [
  { test: /^dock-sensor-/, role: 'sensor', bomGroup: 'sensor:photoelectric', color: COLORS.sensor },
  { test: /^sensor-|^layer-sensor-/, role: 'sensor', bomGroup: 'sensor:photoelectric', color: COLORS.sensor },
  // 顶升移载：气缸/推板驱动是执行机构，辊道与轴承立柱是传动件，台板/安装板是结构件
  { test: /^transfer-lift-cyl-|^transfer-push-cyl$/, role: 'actuator', bomGroup: 'actuator:cylinder', color: COLORS.actuator },
  { test: /^transfer-roller-|^dock-roller-/, role: 'transfer', bomGroup: 'structure', color: COLORS.transfer },
  { test: /^transfer-push-plate$|^transfer-push-bracket$/, role: 'fixture', bomGroup: 'structure', color: COLORS.fixture },
  { test: /^turner-lift-cyl-/, role: 'actuator', bomGroup: 'actuator:cylinder', color: COLORS.actuator },
  { test: /^turner-motor$|^gearmotor$|^lift-motor$/, role: 'actuator', bomGroup: 'actuator:rotary', color: COLORS.actuator },
  { test: /^belt-|^pulley-|^tray-roller-/, role: 'transfer', bomGroup: 'structure', color: COLORS.transfer },
  { test: /^transfer-mount-plate$|^transfer-lift-plate$|^transfer-push-beam-|^transfer-push-column-/, role: 'frame', bomGroup: 'structure', color: COLORS.frame },
  { test: /^dock-rail-|^dock-leg-/, role: 'frame', bomGroup: 'structure', color: COLORS.frame },
  { test: /^turner-finger-|^turner-table$|^turner-ring$|^turner-lift-plate$/, role: 'fixture', bomGroup: 'structure', color: COLORS.fixture },
  { test: /^rail-|^leg-|^cross-|^endplate-|^foot-/, role: 'frame', bomGroup: 'structure', color: COLORS.frame },
  { test: /^guard-/, role: 'safety', bomGroup: 'structure', color: COLORS.structure }
];

function semanticsOf(id: string): PartSemantics {
  for (const entry of SEMANTICS) {
    if (entry.test.test(id)) return { role: entry.role, bomGroup: entry.bomGroup, color: entry.color };
  }
  return { role: 'structure', bomGroup: 'structure', color: COLORS.structure };
}

/* ------------------------------------------------------------------ *
 * 运动轴
 * ------------------------------------------------------------------ */

/** 顶升随动件：台板 / 回转支承 / 转台盘 / 支撑指 + 活塞杆（缸体固定、杆随台板走）。 */
function liftPartIds(parts: readonly ConveyorPart[]): string[] {
  return parts
    .map((part) => part.id)
    .filter((id) => /^turner-lift-plate$|^turner-ring$|^turner-table$|^turner-finger-\d+$|^turner-lift-cyl-\d+$/.test(id))
    // 气缸只取活塞杆（拆件后的 `<件号>-rod`）：缸体是固定件
    .flatMap((id) => (/^turner-lift-cyl-\d+$/.test(id) ? [`${id}-rod`] : [id]));
}

/** 转向随动件：转台盘 + 支撑指（4 折对称，转 90° 后落回同一组带缝）。 */
function rotaryPartIds(parts: readonly ConveyorPart[]): string[] {
  return parts.map((part) => part.id).filter((id) => /^turner-table$|^turner-ring$|^turner-finger-\d+$/.test(id));
}

/** 顶升随动件（移载）：随动台板 + 移载辊道 + 轴承立柱 + 活塞杆。 */
function transferLiftPartIds(parts: readonly ConveyorPart[]): string[] {
  return parts
    .map((part) => part.id)
    .filter((id) => /^transfer-lift-plate$|^transfer-roller-\d+$|^transfer-roller-post-\d+$|^transfer-lift-cyl-\d+$/.test(id))
    // 气缸只取活塞杆（拆件后的 `<件号>-rod`）：缸体固定在安装板上
    .flatMap((id) => (/^transfer-lift-cyl-\d+$/.test(id) ? [`${id}-rod`] : [id]));
}

/** 移载随动件（+Y）：推板与它的小滑座。辊道只转不平移，所以不在这条轴里。 */
function transferPushPartIds(parts: readonly ConveyorPart[]): string[] {
  return parts.map((part) => part.id).filter((id) => /^transfer-push-plate$|^transfer-push-bracket$/.test(id));
}

function conveyorMovingAxes(
  parts: readonly ConveyorPart[],
  turner: TurnerLayout | null,
  stationId: string,
  transfer: TransferLayout | null = null
): GeomMovingAxis[] {
  const axes: GeomMovingAxis[] = [];
  if (!turner && !transfer) return axes;
  if (transfer) {
    // 移载两条轴：顶升（Z）+ 移载（+Y）。3D 里先按顶升挂组、再由推板组覆盖推板两件
    //（buildThreeMachine 里同一件只能挂一个运动组，后写的胜出，与转向工位同一约定）。
    const lift = transferLiftPartIds(parts);
    if (lift.length > 0) {
      axes.push({
        actuatorId: 'transfer-lift',
        stationId,
        kind: 'linear',
        partIds: lift,
        axis: [0, 0, 1],
        pivot: [0, 0, transfer.plateCenterZ],
        strokeMm: transfer.strokeMm,
        rangeDeg: 0,
        home: 'retracted',
        durationMs: Math.round(transfer.liftSeconds * 1000),
        points: { extend: '顶升到位', retract: '顶升原位' }
      });
    }
    const push = transferPushPartIds(parts);
    if (push.length > 0) {
      axes.push({
        actuatorId: 'transfer-push',
        stationId,
        kind: 'linear',
        partIds: push,
        // 移载方向固定 +Y（板不转，整块平移到下游对接段）
        axis: [0, 1, 0],
        pivot: [0, transfer.pushPlateRestY, transfer.pushPlateCenterZ],
        strokeMm: transfer.pushStrokeMm,
        rangeDeg: 0,
        home: 'retracted',
        durationMs: Math.round(transfer.pushSeconds * 1000),
        points: { extend: '移载到位', retract: '移载回位' }
      });
    }
    return axes;
  }
  if (!turner) return axes;
  // 顺序有讲究：buildThreeMachine 里同一件只能挂一个运动组，后写的胜出。
  // 转向轴在前、顶升轴在后 —— 3D 里看到的是「台板顶着工件上升」（工位主动作），
  // 旋转在 90° 分度下落到同一组带缝，视觉上由支撑指的对称性表达。
  const rotary = rotaryPartIds(parts);
  if (rotary.length > 0) {
    axes.push({
      actuatorId: 'turner-rotary',
      stationId,
      kind: 'rotary',
      partIds: rotary,
      axis: [0, 0, 1],
      pivot: [0, 0, turner.tableCenterZ],
      strokeMm: 0,
      rangeDeg: turner.angleDeg,
      home: 'zero',
      durationMs: Math.round(turner.rotateSeconds * 1000),
      points: { point: '转向分度' }
    });
  }
  const lift = liftPartIds(parts);
  if (lift.length > 0) {
    axes.push({
      actuatorId: 'turner-lift',
      stationId,
      kind: 'linear',
      partIds: lift,
      // 几何里缸体向上伸出、config.position=[0,0,1] 同向 → 不再触发 direction-overridden
      axis: [0, 0, 1],
      pivot: [0, 0, turner.plateCenterZ],
      strokeMm: turner.strokeMm,
      rangeDeg: 0,
      home: 'retracted',
      durationMs: Math.round(turner.liftSeconds * 1000),
      points: { extend: '顶升到位', retract: '顶升回落' }
    });
  }
  return axes;
}

/* ------------------------------------------------------------------ *
 * 结构连接（joints）
 *
 * 只声明**装配上真实存在的连接**：横撑插纵梁、地脚旋入支腿、皮带绕包滚筒、
 * 导柱穿台板过孔…… 每条都带中文原因，评审里可以逐条看。
 * 不在这里的件对依然按 suspect 报出来 —— 声明表不是「全部放行」的白名单。
 * ------------------------------------------------------------------ */

const ID = {
  rail: /^rail-(left|right)$/,
  // ── 顶升移载 ──
  transferMount: /^transfer-mount-plate$/,
  transferHanger: /^transfer-hanger-\d+$/,
  transferCyl: /^transfer-lift-cyl-\d+$/,
  transferGuide: /^transfer-guide-post-\d+$/,
  transferPlate: /^transfer-lift-plate$/,
  transferRoller: /^transfer-roller-\d+$/,
  transferPost: /^transfer-roller-post-\d+$/,
  transferPushPlate: /^transfer-push-plate$/,
  transferPushBracket: /^transfer-push-bracket$/,
  transferPushCyl: /^transfer-push-cyl$/,
  transferPushBeam: /^transfer-push-beam-(left|right)$/,
  transferPushColumn: /^transfer-push-column-(left|right)$/,
  dockRail: /^dock-rail-(left|right)$/,
  dockRoller: /^dock-roller-\d+$/,
  dockLeg: /^dock-leg-\d+$/,
  dockGuard: /^dock-guard-(left|right)$/,
  dockStop: /^dock-stop$/,
  dockSensor: /^dock-sensor-(inlet|outlet)$/,
  cross: /^cross-\d+$/,
  endplate: /^endplate-(head|tail)$/,
  leg: /^leg-\d+$/,
  foot: /^foot-\d+$/,
  tension: /^tension-(left|right)$/,
  beltTop: /^belt-(top|\d+)$/,
  beltReturn: /^belt-return-/,
  pulley: /^pulley-(drive|idle|tail)(-\d+)?$/,
  gearmotor: /^gearmotor$/,
  guard: /^guard-(left|right)$/,
  sensor: /^sensor-(inlet|outlet)$/,
  column: /^column-(fl|fr|bl|br)$/,
  topBeam: /^top-beam-(front|back)$/,
  trayRail: /^tray-rail-\d+-(left|right)$/,
  tray: /^tray-\d+$/,
  trayRoller: /^tray-roller-\d+-(in|out)$/,
  stop: /^stop-\d+$/,
  layerSensor: /^layer-sensor-\d+$/,
  liftPost: /^lift-post-(left|right)$/,
  liftChain: /^lift-chain-(left|right)$/,
  liftPlatform: /^lift-platform$/,
  liftMotor: /^lift-motor$/,
  turnerBase: /^turner-base-(left|right)$/,
  turnerHanger: /^turner-hanger-\d+$/,
  turnerFrame: /^turner-lift-frame$/,
  turnerCyl: /^turner-lift-cyl-\d+$/,
  turnerGuide: /^turner-guide-post-\d+$/,
  turnerPlate: /^turner-lift-plate$/,
  turnerRing: /^turner-ring$/,
  turnerTable: /^turner-table$/,
  turnerFinger: /^turner-finger-\d+$/,
  turnerMotor: /^turner-motor$/
} as const;

interface JointRule {
  a: RegExp;
  b: RegExp;
  reason: string;
}

const JOINT_RULES: readonly JointRule[] = [
  // ── 机架：纵梁 / 横撑 / 端板 / 支腿 / 地脚 ──
  { a: ID.rail, b: ID.cross, reason: '横撑两端靠角件与螺栓固定在纵梁内侧（型材 T 槽连接）' },
  { a: ID.rail, b: ID.endplate, reason: '头尾端板贴纵梁端面用螺栓固定（滚筒轴承座安装面）' },
  { a: ID.rail, b: ID.leg, reason: '支腿顶板与纵梁底面贴合，角件 + 螺栓固定' },
  { a: ID.rail, b: ID.tension, reason: '尾部张紧滑座骑在纵梁上，沿纵梁滑动调张紧' },
  { a: ID.leg, b: ID.foot, reason: '可调地脚螺杆旋入支腿底面螺纹孔' },
  { a: ID.leg, b: ID.tension, reason: '张紧调节螺杆旋入支腿上的 M10 螺纹孔（滑座本身骑在纵梁上）' },
  { a: ID.leg, b: ID.cross, reason: '下横撑与支腿用角件连接（同一安装节点）' },
  { a: ID.cross, b: ID.gearmotor, reason: '减速电机安装座固定在横撑/纵梁外侧，输出轴插入滚筒轴端' },
  { a: ID.rail, b: ID.gearmotor, reason: '减速电机用安装法兰夹在纵梁外侧（留 5 mm 安装面间隙）' },
  { a: ID.leg, b: ID.gearmotor, reason: '减速电机安装座与支腿共用尾部安装节点' },
  { a: ID.guard, b: ID.rail, reason: '侧挡边支架固定在纵梁上沿' },
  { a: ID.sensor, b: ID.rail, reason: '光电支架夹在纵梁外侧' },
  // ── 输送面：皮带 / 滚筒 ──
  { a: ID.beltTop, b: ID.pulley, reason: '皮带上行程绕包头尾滚筒（包角处切向接触）' },
  { a: ID.beltReturn, b: ID.pulley, reason: '皮带回程绕包头尾滚筒（包角处切向接触）' },
  { a: ID.tension, b: ID.pulley, reason: '尾部张紧滑座夹持尾滚筒轴承座（螺杆推拉调张紧）' },
  // ── 立体缓存：立柱 / 顶部横梁 / 托架层 ──
  { a: ID.column, b: ID.topBeam, reason: '顶部横梁与立柱端面用角件连成门架' },
  { a: ID.column, b: ID.rail, reason: '缓存立柱坐在纵梁外侧的安装板上' },
  { a: ID.column, b: ID.trayRail, reason: '托条两端搭在缓存立柱上（层高由立柱孔位决定）' },
  { a: ID.trayRail, b: ID.tray, reason: '托板放在两根托条上（留 5 mm 装配间隙）' },
  { a: ID.tray, b: ID.trayRoller, reason: '层内传动辊装在托板缺口处' },
  { a: ID.tray, b: ID.stop, reason: '层挡停板用螺栓固定在托板上' },
  { a: ID.column, b: ID.layerSensor, reason: '层到位光电支架夹在立柱上' },
  { a: ID.liftPost, b: ID.rail, reason: '升降导柱下端固定在纵梁上的安装座' },
  { a: ID.liftPost, b: ID.liftChain, reason: '升降链条沿导柱布置（链轮挂在导柱顶端）' },
  { a: ID.liftPost, b: ID.liftPlatform, reason: '升降台沿两根导柱上下滑动（导套配合）' },
  { a: ID.liftChain, b: ID.liftPlatform, reason: '升降台由两侧链条牵引' },
  { a: ID.column, b: ID.liftMotor, reason: '升降减速电机挂在立柱外侧（留 5 mm 安装面）' },
  // ── 转向工位：底座框架 / 下沉框架 / 顶升气缸 / 导柱 / 台板 / 回转支承 / 转台盘 / 支撑指 ──
  { a: ID.turnerBase, b: ID.rail, reason: '底座框架坐在两侧纵梁上沿（螺栓固定）' },
  { a: ID.turnerBase, b: ID.turnerHanger, reason: '吊柱上端焊在底座框架上' },
  { a: ID.turnerHanger, b: ID.rail, reason: '吊柱上端挂在纵梁内侧（角件固定）' },
  { a: ID.turnerHanger, b: ID.turnerFrame, reason: '吊柱下端与下沉底盘焊接（底盘吊在纵梁下方）' },
  { a: ID.turnerFrame, b: ID.turnerCyl, reason: '顶升气缸法兰坐在下沉底盘上（螺栓固定）' },
  { a: ID.turnerFrame, b: ID.turnerGuide, reason: '升降导向柱下端装在底盘上' },
  { a: ID.turnerFrame, b: ID.turnerMotor, reason: '转向减速电机坐在底盘上（不随台板升降）' },
  { a: ID.turnerGuide, b: ID.turnerPlate, reason: '导向柱穿过台板 φ26 过孔（滑动配合，孔径比柱径大 4 mm）' },
  { a: ID.turnerPlate, b: ID.turnerCyl, reason: '顶升气缸活塞杆顶住台板底面（推力面）' },
  { a: ID.turnerPlate, b: ID.turnerRing, reason: '回转支承外圈用螺栓固定在升降台板上' },
  { a: ID.turnerRing, b: ID.turnerTable, reason: '转台盘坐在回转支承内圈上（随内圈转动）' },
  { a: ID.turnerTable, b: ID.turnerFinger, reason: '支撑指立柱装在转台盘上（4 折对称，穿带缝升降）' },
  { a: ID.turnerPlate, b: ID.turnerFinger, reason: '支撑指立柱穿过台板定位孔，随台板一起升降' },
  { a: ID.turnerMotor, b: ID.turnerTable, reason: '转向电机输出轴与转台盘同轴（齿轮/联轴器传动）' },
  // ── 顶升移载：安装板 / 气缸 / 导柱 / 台板 / 辊道 / 推板 / 对接段 ──
  { a: ID.transferMount, b: ID.transferHanger, reason: '吊柱下端与安装板焊接（安装板吊在纵梁之间）' },
  { a: ID.transferHanger, b: ID.rail, reason: '吊柱上端挂在纵梁内侧面（角件固定）' },
  { a: ID.transferMount, b: ID.transferCyl, reason: '顶升气缸法兰坐在安装板上（螺栓固定）' },
  { a: ID.transferMount, b: ID.transferGuide, reason: '导向柱下端装在安装板上' },
  { a: ID.transferCyl, b: ID.transferPlate, reason: '顶升气缸活塞杆顶住随动台板底面（推力面）' },
  { a: ID.transferGuide, b: ID.transferPlate, reason: '导向柱穿过随动台板 φ26 过孔（滑动配合，孔径比柱径大 4 mm）' },
  { a: ID.transferPlate, b: ID.transferPost, reason: '轴承立柱立在随动台板顶面（螺栓固定），把辊道托到辊心高度' },
  { a: ID.transferPost, b: ID.transferRoller, reason: '移载辊的轴颈装在轴承立柱上（辊只转不平移）' },
  { a: ID.transferPushPlate, b: ID.transferPushBracket, reason: '推板焊在滑座前端（滑座跟着无杆气缸的滑块走）' },
  { a: ID.transferPushBracket, b: ID.transferPushCyl, reason: '滑座与无杆气缸滑块刚性连接' },
  { a: ID.transferPushCyl, b: ID.transferPushBeam, reason: '无杆气缸两端法兰抱在两侧横梁上' },
  { a: ID.transferPushBeam, b: ID.transferPushColumn, reason: '横梁坐在立柱顶面（螺栓固定）' },
  { a: ID.dockRail, b: ID.dockRoller, reason: '对接段输送辊的轴承座装在两侧纵梁上' },
  { a: ID.dockRail, b: ID.dockLeg, reason: '对接段支腿顶板与纵梁底面贴合' },
  { a: ID.dockRail, b: ID.dockGuard, reason: '对接段挡边支架固定在纵梁上沿' },
  { a: ID.dockGuard, b: ID.dockStop, reason: '挡停板两端与挡边螺栓连接（同一端部安装节点）' },
  { a: ID.dockRail, b: ID.dockSensor, reason: '对接段光电支架夹在纵梁外侧' }
];

/** 某对零件是否属于已声明的装配连接；不属于返回 null（交回干涉初筛判 suspect）。 */
export function conveyorJointReason(a: string, b: string): string | null {
  for (const rule of JOINT_RULES) {
    if ((rule.a.test(a) && rule.b.test(b)) || (rule.a.test(b) && rule.b.test(a))) return rule.reason;
  }
  return null;
}

/** 零件在世界坐标里的外形盒（并集包围盒 + 绕 Z 旋转后的中心偏移）。 */
export function partWorldBounds(part: ConveyorPart): { min: Vec3; max: Vec3; center: Vec3; half: Vec3 } {
  const { box } = partSolidBox(part);
  const rz = part.transform.rz ?? 0;
  const local: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const rotated = rotateLocal(local, rz);
  const hx = (box.max[0] - box.min[0]) / 2;
  const hy = (box.max[1] - box.min[1]) / 2;
  const rad = (rz * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // 绕 Z 旋转后的世界 AABB（与 interference.partBounds 同口径；rz=0 时就是原尺寸）
  const half: Vec3 = [hx * cos + hy * sin, hx * sin + hy * cos, (box.max[2] - box.min[2]) / 2];
  const center: Vec3 = [part.transform.x + rotated[0], part.transform.y + rotated[1], part.transform.z + local[2]];
  return {
    min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
    center,
    half
  };
}

/** 整机装配里所有真实连接（每对只出一条；只出「装配上确实相接」的对）。 */
export function conveyorJoints(parts: readonly ConveyorPart[]): GeomJoint[] {
  // 只声明**几何上确实相接**的件对：按外形盒判定（含 1 mm 装配容差）。
  // 不按 id 规则全量铺开 —— 全量声明等于给所有同名件族开后门，真互穿会被一起放行。
  const boxes = parts.map(partWorldBounds);
  const touches = (a: number, b: number): boolean => {
    const boxA = boxes[a];
    const boxB = boxes[b];
    if (!boxA || !boxB) return false;
    for (let axis = 0; axis < 3; axis += 1) {
      const overlap = Math.min(boxA.max[axis] ?? 0, boxB.max[axis] ?? 0) - Math.max(boxA.min[axis] ?? 0, boxB.min[axis] ?? 0);
      if (overlap < -1) return false;
    }
    return true;
  };
  const joints: GeomJoint[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const a = parts[i]?.id;
      const b = parts[j]?.id;
      if (!a || !b) continue;
      if (!touches(i, j)) continue;
      const reason = conveyorJointReason(a, b);
      if (reason) joints.push({ a, b, reason });
    }
  }
  return joints;
}

/* ------------------------------------------------------------------ *
 * 映射 + 整机几何
 * ------------------------------------------------------------------ */

export interface ConveyorGeometryOptions {
  /** 运动轴挂在哪个工位名下；参数化整机没有工位底板，缺省空串 */
  stationId?: string;
}

/**
 * 一件（或拆成两件）映射结果。为什么会「一式两件」：
 *
 * 顶升气缸在整机 BOM 里是一件（真机整件采购，B-Rep 布尔求并后也是一坨实体），
 * 但**几何上缸体与活塞杆是两个刚体**：顶升时只有活塞杆随台板走、缸体不动。
 * 把两者放进一件，rest/lift 两态的重叠就完全一样 —— 三态检查退化成复制静态位姿
 * （eval t05 直接判 FAIL），行程也表达不出来。所以这一对按刚体拆开：
 * 缸体沿用原件号，活塞杆用 `<件号>-rod`，两件同属 turner-lift 执行机构，
 * 配合面交给干涉层的 mateReason 判定（同轴嵌套，不是设计干涉）。
 */
export interface MappedSolid {
  id: string;
  name: string;
  shape: GeomShape;
  center: Vec3;
  /** 来自哪个整机装配件（BOM/STEP 按它归属） */
  parentId: string;
  /** 是否随顶升轴运动 */
  moving: boolean;
}

/** 把一件整机零件拆成几何刚体：默认 1:1，只有「同轴双径圆柱」按缸体/活塞杆拆两件。 */
function mappedSolids(part: ConveyorPart): MappedSolid[] {
  const features = part.features
    .map((node) => ({ node, parsed: featureLocalBox(node) }))
    .filter((entry): entry is { node: ConveyorPart['features'][number]; parsed: NonNullable<ReturnType<typeof featureLocalBox>> } => entry.parsed !== null);

  // 只认「全部实体特征都是同轴 Z 向圆柱、且恰好两种直径」的件（顶升气缸就是这一种）。
  const allZCylinders = features.length >= 2
    && features.every(({ parsed }) => parsed.kind === 'cylinder' && parsed.axis === 'z');
  const coaxial = allZCylinders && features.every(({ parsed }) => {
    const centerX = (parsed.box.min[0] + parsed.box.max[0]) / 2;
    const centerY = (parsed.box.min[1] + parsed.box.max[1]) / 2;
    return Math.abs(centerX) < 0.51 && Math.abs(centerY) < 0.51;
  });
  const radii = new Set(features.map(({ node }) => Number((node.params as Record<string, unknown>).diameter)));
  if (coaxial && radii.size === 2) {
    const sorted = [...radii].sort((a, b) => b - a);
    const bodyDiameter = sorted[0] ?? 0;
    const rodDiameter = sorted[1] ?? 0;
    const pick = (diameter: number) => features.filter(({ node }) => Number((node.params as Record<string, unknown>).diameter) === diameter);
    const bodyBox = unionBox(pick(bodyDiameter).map((entry) => entry.parsed.box));
    const rodBox = unionBox(pick(rodDiameter).map((entry) => entry.parsed.box));
    const base = part.transform;
    return [
      {
        id: part.id,
        name: part.name,
        shape: { type: 'cylinder', radius: round2(bodyDiameter / 2), length: round2(bodyBox.max[2] - bodyBox.min[2]), axis: 'z' },
        center: [round2(base.x), round2(base.y), round2(base.z + (bodyBox.min[2] + bodyBox.max[2]) / 2)],
        parentId: part.id,
        moving: false
      },
      {
        id: `${part.id}-rod`,
        name: `${part.name} 活塞杆`,
        shape: { type: 'cylinder', radius: round2(rodDiameter / 2), length: round2(rodBox.max[2] - rodBox.min[2]), axis: 'z' },
        center: [round2(base.x), round2(base.y), round2(base.z + (rodBox.min[2] + rodBox.max[2]) / 2)],
        parentId: part.id,
        moving: true
      }
    ];
  }

  const { box, cylinders } = partSolidBox(part);
  const bounds = partWorldBounds(part);
  return [{
    id: part.id,
    name: part.name,
    shape: shapeOf(box, cylinders),
    center: [round2(bounds.center[0]), round2(bounds.center[1]), round2(bounds.center[2])],
    parentId: part.id,
    moving: false
  }];
}

function unionBox(boxes: LocalBox[]): LocalBox {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, box.min[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, box.max[axis] ?? 0);
    }
  }
  return { min, max };
}

/** 参数化整机 → MachineGeometry（同一份零件表；缸体/活塞杆按刚体拆两件）。 */
export function conveyorGeometryFromParts(
  parts: readonly ConveyorPart[],
  config: MachineConfig,
  params: ConveyorParams,
  options: ConveyorGeometryOptions = {}
): MachineGeometry {
  const stationId = options.stationId ?? '';
  const turner = turnerLayout(params);
  const transfer = transferLayout(params);
  const axes = conveyorMovingAxes(parts, turner, stationId, transfer);
  const liftIds = new Set(liftPartIds(parts));
  const rotaryIds = new Set(rotaryPartIds(parts));
  const transferLiftIds = new Set(transferLiftPartIds(parts));
  const transferPushIds = new Set(transferPushPartIds(parts));
  const solids = parts.flatMap(mappedSolids);
  const materialOf = new Map(parts.map((part) => [part.id, part.material]));

  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const geometryParts: GeomPart[] = solids.map((solid) => {
    const lift = solid.moving || liftIds.has(solid.id) || transferLiftIds.has(solid.id);
    const semantics = semanticsOf(solid.parentId);
    const actuatorId = transferLiftIds.has(solid.id)
      ? 'transfer-lift'
      : transferPushIds.has(solid.id)
        ? 'transfer-push'
        : lift
          ? 'turner-lift'
          : rotaryIds.has(solid.id)
            ? 'turner-rotary'
            : actuatorOfPart(solid.parentId);
    const geomPart: GeomPart = {
      id: solid.id,
      name: solid.name,
      role: semantics.role,
      shape: solid.shape,
      center: solid.center,
      rotationZDeg: 0,
      // 材质定色：视口里铝件 / Q235 件 / 45# 钢件 / PVC 皮带必须一眼能分开
      color: MATERIAL_COLORS[materialOf.get(solid.parentId) ?? ''] ?? semantics.color,
      material: materialOf.get(solid.parentId) ?? 'Q235',
      bomGroup: semantics.bomGroup,
      ...(actuatorId ? { actuatorId } : {}),
      ...(lift ? { moving: true as const } : {})
    };
    const half = shapeHalfExtents(solid.shape);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, (solid.center[axis] ?? 0) - (half[axis] ?? 0));
      max[axis] = Math.max(max[axis] ?? -Infinity, (solid.center[axis] ?? 0) + (half[axis] ?? 0));
    }
    return geomPart;
  });

  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  const envelope: Vec3 = [round2(max[0] - min[0]), round2(max[1] - min[1]), round2(max[2] - min[2])];
  const bom = conveyorBom(parts).map((row) => ({
    name: row.name,
    spec: row.spec,
    qty: row.qty,
    material: row.material
  }));

  return {
    schemaVersion: 1,
    kind: 'machine-geometry',
    machineId: config.id,
    name: config.name,
    units: 'mm',
    upAxis: 'z',
    geometrySource: 'conveyor-assembly',
    // 装配件数与几何刚体数分开报：85 件装配 + 2 根活塞杆 = 87 个刚体（见 mappedSolids）
    assemblyPartCount: parts.length,
    // 件的外形是参数化整机零件的包围盒/主形体（不是 B-rep）；实体布尔在 build123d 内核里对
    // 同一份 buildConveyorParts 结果做，两边零件表一致。
    geometryFidelity: 'conceptual-estimate',
    process: 'conveyor',
    layout: 'linear',
    envelope,
    bounds: { min, max },
    tableHeight: params.beltHeightMm ?? 850,
    // 参数化整机没有工位底板/门架：stations 为空，工位信息仍在 config.stations 里。
    stations: [],
    parts: geometryParts,
    moving: axes,
    joints: conveyorJoints(parts),
    structureBom: bom,
    assumptions: [
      `几何来源：conveyor-assembly 参数化整机（${parts.length} 件），与 STEP/GLB/BOM 同一份零件表`,
      `输送参数：线体长 ${params.lengthMm} mm、带宽 ${params.widthMm} mm、皮带面高 ${params.beltHeightMm ?? 850} mm` +
        `${turner ? `、转向工位 ${turner.angleDeg}°（顶升行程 ${turner.strokeMm} mm、${turner.beltCount} 条窄带并联）` : ''}` +
        `${transfer ? `、顶升移载（顶升 ${transfer.strokeMm} mm + 沿 +Y 移载 ${transfer.pushStrokeMm} mm、${transfer.beltCount} 条窄带并联、下游对接段 ${Math.round(transfer.dockWidthMm)}×${Math.round(transfer.dockLengthMm)} mm）` : ''}`,
      '零件外形取参数化件的并集包围盒（纯圆柱件给圆柱），是代理体而不是 B-rep；'
        + '实体布尔干涉在 build123d 内核里对同一份零件表做，本模块只做 AABB 初筛与解析式确认'
    ],
    warnings: []
  };
}

/** 零件 id → 是否为执行机构件（无运动轴的电机/气缸） */
function actuatorOfPart(id: string): string | undefined {
  if (/^gearmotor$/.test(id)) return 'conveyor-drive';
  if (/^turner-motor$|^lift-motor$/.test(id)) return 'lift-motor';
  if (/^turner-lift-cyl-/.test(id)) return 'turner-lift';
  // 移载：气缸固定件与推板驱动归到对应轴（随动件在上面按 id 集单独判定，优先）
  if (/^transfer-lift-cyl-/.test(id)) return 'transfer-lift';
  if (/^transfer-push-/.test(id)) return 'transfer-push';
  return undefined;
}

function rotateLocal(center: Vec3, rz: number): [number, number] {
  if (!Number.isFinite(rz) || Math.abs(rz) < 1e-9) return [center[0], center[1]];
  const rad = (rz * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [center[0] * cos - center[1] * sin, center[0] * sin + center[1] * cos];
}

/* ------------------------------------------------------------------ *
 * 唯一入口
 * ------------------------------------------------------------------ */

/** 与 generateMachineGeometry 相同的入参口径：config 或「带 config 的方案对象」。 */
export type MachineGeometryInput = MachineConfig | {
  config: MachineConfig;
  form?: { id?: unknown; geometry?: { kind?: unknown } } | undefined;
};

function isDesignLike(value: MachineGeometryInput): value is { config: MachineConfig; form?: { id?: unknown; geometry?: { kind?: unknown } } } {
  return typeof value === 'object' && value !== null && 'config' in value && typeof (value as { config: unknown }).config === 'object';
}

/**
 * 整机几何的唯一入口。
 *
 * 入参与 `generateMachineGeometry` 一致：可以给 `MachineConfig`，也可以给带 `config` 的
 * 方案对象（`design`），此时 `form.id / form.geometry.kind` 参与输送类判定。
 *
 * 判定（一条链，不做二次猜测）：
 *   1. 形态属于输送类（`form.id` ∈ CONVEYOR_FORM_IDS 或 `form.geometry.kind === 'conveyor'`；
 *      老方案没写形态时退回看 config.conveyor）**并且**能推出线体长/带宽
 *      → `buildConveyorParts` + 映射成 MachineGeometry；
 *   2. 其余（含「形态是输送类但缺线体长/带宽」）→ `generateMachineGeometry`，10 种形态行为不变。
 *      形态明确是非输送类时，config 里即使带了 conveyor 参数也不改道（那是脏数据）。
 */
export function resolveMachineGeometry(
  input: MachineGeometryInput,
  options: MachineGeometryOptions = {}
): ResolvedMachineGeometry {
  const designLike = isDesignLike(input)
    ? (input as { config: MachineConfig; form?: { id?: unknown; geometry?: { kind?: unknown } } })
    : null;
  const config: MachineConfig = designLike ? designLike.config : (input as MachineConfig);
  const form = designLike?.form;
  const formId = (typeof form?.id === 'string' && form.id) || config.formId;
  const formKind = typeof form?.geometry?.kind === 'string' ? form.geometry.kind : undefined;
  const hasFormHint = Boolean(formKind || formId);
  // 判定：形态属于输送类（或老方案根本没写形态，只能靠参数认），**并且**能推出线体长/带宽。
  // 形态明确是非输送类时，即使 config 里带了 conveyor 参数也不改道 —— 那是脏数据，不是输送线。
  const conveyorLike = isConveyorForm({ id: formId, kind: formKind })
    || (!hasFormHint && config.conveyor !== undefined && config.conveyor !== null);
  if (conveyorLike) {
    const params = conveyorParamsFromConfig(config);
    if (params) {
      const parts = buildConveyorParts(params);
      const geometry = conveyorGeometryFromParts(parts, config, params);
      return {
        geometry,
        source: 'conveyor-assembly',
        partCount: geometry.parts.length,
        assemblyPartCount: parts.length,
        reason: `输送类机型（${formKind ?? formId ?? 'config.conveyor'}）：按 ${params.lengthMm}×${params.widthMm} mm 生成参数化整机，${geometry.parts.length} 件`
      };
    }
    // 形态是输送类但推不出线体长/带宽：回落代理体，并在 assumptions 里说清楚为什么
    const fallback = generateMachineGeometry(input as Parameters<typeof generateMachineGeometry>[0], options);
    return {
      geometry: {
        ...fallback,
        geometrySource: 'station-generator',
        assumptions: [
          ...fallback.assumptions,
          config.conveyor
            ? `config.conveyor 缺线体长/带宽（lengthMm=${String(config.conveyor.lengthMm)}、widthMm=${String(config.conveyor.widthMm)}），`
              + '无法参数化整机，已回落到工位生成器代理体'
            : '输送类形态缺 config.conveyor（线体长/带宽），无法参数化整机，已回落到工位生成器代理体；'
              + '重新跑 design_machine / apply_machine_design 会把参数写进 config'
        ]
      },
      source: 'station-generator',
      partCount: fallback.parts.length,
      assemblyPartCount: fallback.parts.length,
      reason: '输送类形态但缺线体长/带宽：回落到工位生成器（不猜尺寸）'
    };
  }
  const geometry = generateMachineGeometry(input as Parameters<typeof generateMachineGeometry>[0], options);
  return {
    geometry: { ...geometry, geometrySource: 'station-generator' },
    source: 'station-generator',
    partCount: geometry.parts.length,
    assemblyPartCount: geometry.parts.length,
    reason: `非输送类形态（${config.formId ?? '未标注'}）：沿用整机几何生成器`
  };
}
