// 机型方案合成：纯函数。输入 MachineBrief，输出可直接喂给 createScene3D 的
// MachineConfig，以及点位、节拍、功率、BOM 草案、警告与假设。
//
// 诚实边界：本文件只产出配置；三维几何由 geometry.ts 按配置生成标准件外形；功率由 power.ts
// 按元件库额定值与可配置系数估算；成本由 cost-model.ts 做方案阶段粗估。两者都不替代
// 正式电气设计、报价与节拍分析。

import type { MachineConfig } from '../commission/machine-config.ts';
import type { StationGeometryLayout } from './station-layout.ts';
import type { StationIdentity } from './station-identity.ts';
import type { ComponentPart } from '../shared/types.ts';
import type { Pricebook } from '../cost/pricebook.ts';
import { validateMachineConfig } from '../commission/machine-config.ts';
import {
  DEFAULT_NOTE_CYCLE,
  DEFAULT_NOTE_LAYOUT,
  DEFAULT_NOTE_STATIONS,
  MACHINE_DEFAULT_CYCLE_PER_MIN,
  MACHINE_STATIONS_MAX,
  MACHINE_STATIONS_MIN,
  type MachineActuatorKind,
  type MachineBrief,
  type MachineProcess,
  type MachineSensorKind,
  type MachineVoltage
} from './spec.ts';
import { DIAL_MAX_STATIONS, DIAL_PROCESSES } from './geometry.ts';
import { evaluateFlow, type FlowEvaluation, type FlowModel, type FlowOp, type MachineLayout } from './flow.ts';
import { TEMPLATES, templateFor, templateKinds } from './templates.ts';
import { conveyorParamsFromBrief, refineConveyor } from './conveyor-synth.ts';
import { turnerLayout, turnerSkipReason } from './conveyor-assembly.ts';
import {
  ACTUATOR_SECONDS,
  PROCESS_BASE_SECONDS,
  pickForm,
  summarizeForm,
  type MachineFormSummary
} from './forms.ts';
import { estimatePower, type PowerResult } from './power.ts';
import {
  DEFAULT_MACHINE_PRICING,
  estimateCost,
  type MachineCostEstimate,
  type MachinePricing
} from './cost-model.ts';

export interface MachineCycleEstimate {
  /** 布局模型：single / linear / dial / parallel / cell。 */
  mode: MachineLayout;
  /** 当前产能数字的来源；方案初算可缺省，向导校核后会明确写入。 */
  source?: 'model-estimate' | 'engineer-input';
  /** 用户输入的工位完整周期；输入值来源固定为工程师输入，需实测验证。 */
  stationCycleInputs?: MachineStationCycleInput[];
  perMin: number;
  /** 目标节拍，60 / perMin。 */
  secondsPerPiece: number;
  /** 单工位单件时间（工艺固定余量 + 该工位动作时间）。 */
  stationSeconds: number;
  /** 估算产能（件/分钟）。 */
  throughputPerMin: number;
  /** 与 throughputPerMin 同值的对外别名，供向导候选卡片直接展示。 */
  partsPerMinute: number;
  /** 兼容旧字段：单工位单件时间；parallel 下不再是整机节拍。 */
  estimatedSecondsPerPiece: number;
  baseSeconds: number;
  slowestStation: number;
  slowestActionSeconds: number;
  requiredParallelStations: number;
  /** 达标所需总工位：由 evaluateFlow 按布局公式反解。 */
  requiredTotalStations: number;
  meetsTarget: boolean;
  bottleneck: string;
}

export interface MachineStationCycleInput {
  stationId: string;
  stationName: string;
  seconds: number;
  /** 是否已确认周期包含布局相关的公共等待、移载、上下料/分度时间。 */
  sharedTimeConfirmed: boolean;
  source: 'engineer-input';
  verification: 'pending-measurement';
}

export type MachinePowerEstimate = PowerResult;

export interface MachineBomItem {
  kind: 'actuator' | 'sensor' | 'electrical';
  name: string;
  qty: number;
  /** 可选型号；方案合成默认不编造型号。 */
  model?: string;
  note?: string;
  /** 真实元件包中的 id；仅 BOM 映射后存在。 */
  partId?: string;
  /** 真实元件包 id；仅 BOM 映射后存在。 */
  packId?: string;
  /** 功率/成本分类角色。 */
  role?: 'servo' | 'cylinder' | 'gripper' | 'rotary' | 'sensor' | 'safety' | 'plc' | 'psu' | 'valve' | 'other';
  /** 单件额定有功功率（W），来自元件库时可直接复用。 */
  ratedW?: number;
  /** true 表示库内没有可选型号，需要补录后确认。 */
  pendingSelection?: boolean;
}

export interface MachineDesign {
  config: MachineConfig;
  /** 与 config.stations 当前顺序一一对应的持久工位身份；不是几何生成器临时 stN。 */
  stationIdentities?: StationIdentity[];
  /** 工程师在真实几何俯视中输入的全局 XY 工位偏移；旧设计缺省等同零偏移。 */
  stationGeometryLayout?: StationGeometryLayout;
  /** 安全清除无法可靠迁移的遗留偏移或身份映射时，供工程师界面明确提示。 */
  stationGeometryWarning?: string;
  points: string[];
  cycle: MachineCycleEstimate;
  power: MachinePowerEstimate;
  cost: MachineCostEstimate;
  bomDraft: { items: MachineBomItem[] };
  warnings: string[];
  assumptions: string[];
  /** 选中的整机形态；旧设计对象可能没有该字段。 */
  form: MachineFormSummary;
}

export interface SynthOptions {
  stationCount?: number;
  cyclePerMin?: number;
  name?: string;
  id?: string;
  /** 元件库；用于读取伺服/电源/安全光栅等额定功率。 */
  parts?: readonly ComponentPart[];
  /** 价格簿；方案阶段粗估用，缺省则尽量用元件库参考价。 */
  pricebook?: Pricebook;
  builtinPricebook?: Pricebook;
  /** userData/machine-pricing.json 解析结果。 */
  pricing?: MachinePricing;
  pricingAssumptions?: readonly string[];
  /** 供电制式；缺省沿用 brief.voltage，再缺省 380VAC。 */
  voltage?: MachineVoltage;
  /** 强制整机形态；方案对比用，仍由 synthMachine 统一计算节拍/功率/成本。 */
  formId?: string;
}

const PROCESS_LABEL: Record<MachineProcess, string> = {
  screw: '锁螺丝',
  dispense: '点胶',
  assembly: '装配',
  inspection: '检测',
  packaging: '包装',
  conveyor: '输送',
  unknown: '通用'
};

const ACTUATOR_LABEL: Record<MachineActuatorKind, string> = {
  cylinder: '气缸',
  gripper: '夹爪',
  rotary: '旋转轴'
};

const SENSOR_LABEL: Record<MachineSensorKind, string> = {
  proximity: '接近开关',
  photoelectric: '光电传感器',
  safety: '安全光栅',
  pressure: '压力传感器'
};

const ACTUATOR_DURATION_MS: Record<MachineActuatorKind, number> = {
  cylinder: 400,
  gripper: 280,
  rotary: 700
};

const ACTUATOR_TRAVEL_MM: Record<MachineActuatorKind, number> = {
  cylinder: 40,
  gripper: 20,
  rotary: 90
};

const ACTUATOR_POSITION: Record<MachineActuatorKind, [number, number, number]> = {
  cylinder: [-0.72, 0.55, -0.38],
  gripper: [0.05, 0.55, -0.38],
  rotary: [0.76, 0.65, 0.35]
};

/** 转向工位：输送线上的独立工位名与两条轴的场景位置（线体中段）。 */
const TURNER_STATION_NAME = '转向工位';
const TURNER_AXIS_POSITION: [number, number, number] = [0, 0, -0.1];
/** 顶升轴：Z 向向上（场景里 +Z 就是抬升），行程即顶升高度 */
const TURNER_LIFT_POSITION: [number, number, number] = [0, 0, 0.05];

function assertStations(value: number): number {
  if (!Number.isInteger(value) || value < MACHINE_STATIONS_MIN || value > MACHINE_STATIONS_MAX) {
    throw new Error(`工位数必须是 ${MACHINE_STATIONS_MIN}–${MACHINE_STATIONS_MAX} 的整数`);
  }
  return value;
}

function assertCycle(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('节拍必须大于 0 件/分钟');
  return value;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function countKinds<T extends string>(items: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function flattened<T>(entries: readonly { kind: T; count: number }[]): T[] {
  const result: T[] = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.count; index += 1) result.push(entry.kind);
  }
  return result;
}

function distribute<T>(items: readonly T[], stations: number): T[][] {
  const buckets = Array.from({ length: stations }, () => [] as T[]);
  for (const [index, item] of items.entries()) buckets[index % stations]?.push(item);
  return buckets;
}

function stationPoints(stationIndex: number, actuatorIndex: number, kind: MachineActuatorKind): {
  extendPoint?: string;
  retractPoint?: string;
  gripPoint?: string;
  point?: string;
} {
  const prefix = `ST${stationIndex + 1}`;
  const actuator = `A${actuatorIndex}`;
  if (kind === 'cylinder') {
    return { extendPoint: `${prefix}-EXT-${actuator}`, retractPoint: `${prefix}-RET-${actuator}` };
  }
  if (kind === 'gripper') return { gripPoint: `${prefix}-GRIP-${actuator}` };
  return { point: `${prefix}-ROT-${actuator}` };
}

function sensorPoint(stationIndex: number, sensorIndex: number, kind: MachineSensorKind): string {
  const prefix = `ST${stationIndex + 1}`;
  const code: Record<MachineSensorKind, string> = {
    proximity: 'PRX',
    photoelectric: 'PHT',
    safety: 'SAFE',
    pressure: 'PRS'
  };
  return `${prefix}-${code[kind]}-S${sensorIndex}`;
}

function sensorKindFromPoint(point: string): MachineSensorKind {
  if (point.includes('-SAFE-')) return 'safety';
  if (point.includes('-PRS-')) return 'pressure';
  if (point.includes('-PHT-')) return 'photoelectric';
  return 'proximity';
}

function sanitizeId(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'machine-design';
}

function servoDetected(brief: MachineBrief): boolean {
  return brief.notes.some((note) => /伺服|步进/.test(note));
}

export interface ChooseLayoutOptions {
  /** true：多个工位重复同一道工序（复制式并行），优先于几何布局。 */
  sameProcess?: boolean;
  /** true：需求明确为单元式布局（仅显式指定时使用）。 */
  cell?: boolean;
}

/**
 * 与几何层一致的布局选择：1 工位 single；转盘适用工艺且不超过几何上限 dial；
 * 其余 linear。调用方明确知道「同工序多工位」时传 sameProcess=true 得到 parallel；
 * cell 只在显式指定时使用。
 */
export function chooseLayout(
  process: MachineProcess,
  stations: number,
  options: ChooseLayoutOptions = {}
): MachineLayout {
  if (options.cell === true) return 'cell';
  if (stations <= 1) return 'single';
  if (options.sameProcess === true) return 'parallel';
  if (DIAL_PROCESSES.has(process) && stations <= DIAL_MAX_STATIONS) return 'dial';
  return 'linear';
}

function resolveLayout(
  brief: MachineBrief,
  stations: number
): { mode: MachineLayout; fallback: boolean; inferred: string; auto: boolean } {
  const declared = brief.layout ?? 'auto';
  if (declared === 'line' || declared === 'linear') {
    return { mode: 'linear', fallback: false, inferred: '显式指定流水线布局', auto: false };
  }
  if (declared === 'parallel') {
    return { mode: 'parallel', fallback: false, inferred: '显式指定同工序并行布局', auto: false };
  }
  if (declared === 'single' || declared === 'dial' || declared === 'cell') {
    return { mode: declared, fallback: false, inferred: `显式指定 ${declared} 布局`, auto: false };
  }
  // auto：解析器通常已给出结论；手工构造的 brief 按工序链与几何规则兜底。
  const processNames = brief.processes ?? [];
  if (processNames.length >= 2) {
    return { mode: 'linear', fallback: false, inferred: `识别到多个不同工序（${processNames.join('、')}）`, auto: true };
  }
  if (stations <= 1) {
    return { mode: 'single', fallback: false, inferred: '单工位布局', auto: true };
  }
  if (brief.process === 'unknown') {
    return { mode: 'linear', fallback: true, inferred: '工艺未知，按流水线分工序兜底', auto: true };
  }
  return {
    mode: chooseLayout(brief.process, stations, { sameProcess: true }),
    fallback: false,
    inferred: `单一工艺「${processNames[0] ?? PROCESS_LABEL[brief.process]}」按同工序并行`,
    auto: true
  };
}

function templateDescription(kinds: readonly string[]): string {
  return kinds.join('、');
}

function buildBom(
  actuators: readonly MachineActuatorKind[],
  sensors: readonly MachineSensorKind[],
  servo: boolean,
  brief: MachineBrief
): { items: MachineBomItem[] } {
  const actuatorCounts = countKinds(actuators);
  const sensorCounts = countKinds(sensors);
  const items: MachineBomItem[] = [];

  for (const kind of ['cylinder', 'gripper', 'rotary'] as const) {
    const qty = actuatorCounts.get(kind) ?? 0;
    if (qty > 0) {
      const role = kind === 'rotary' && servo ? 'servo' : kind;
      items.push({ kind: 'actuator', name: ACTUATOR_LABEL[kind], qty, role, note: '型号待定，按方案数量估算' });
    }
  }
  for (const kind of ['proximity', 'photoelectric', 'safety', 'pressure'] as const) {
    const qty = sensorCounts.get(kind) ?? 0;
    if (qty > 0) {
      items.push({
        kind: 'sensor',
        name: SENSOR_LABEL[kind],
        qty,
        role: kind === 'safety' ? 'safety' : 'sensor',
        note: '型号待定，按方案数量估算'
      });
    }
  }
  if (servo) {
    items.push({
      kind: 'electrical',
      name: '伺服驱动器',
      qty: Math.max(1, actuatorCounts.get('rotary') ?? 0),
      role: 'servo',
      note: '按伺服轴数量估算，型号待定'
    });
  }
  items.push({ kind: 'electrical', name: 'PLC', qty: 1, role: 'plc', note: '按点位估算，待选型' });
  items.push({ kind: 'electrical', name: '24 V 开关电源', qty: 1, role: 'psu', note: '按 24V 负载估算，待选型' });
  const voltage = brief.voltage ? `，${brief.voltage}` : '';
  items.push({
    kind: 'electrical',
    name: '电气控制辅材（端子/线槽）',
    qty: 1,
    role: 'other',
    note: `按点位估算${voltage}，待选型`
  });
  return { items };
}

function buildSummary(design: MachineDesign): string {
  const { config, cycle, power, warnings } = design;
  const actuatorCounts = countKinds(config.actuators.map((actuator) => actuator.kind));
  const sensorCounts = countKinds(config.sensors.map((sensor) => sensorKindFromPoint(sensor.point)));
  const actuatorText = (['cylinder', 'gripper', 'rotary'] as const)
    .filter((kind) => (actuatorCounts.get(kind) ?? 0) > 0)
    .map((kind) => `${ACTUATOR_LABEL[kind]} ${actuatorCounts.get(kind) ?? 0}`)
    .join('、');
  const sensorText = (['proximity', 'photoelectric', 'safety', 'pressure'] as const)
    .filter((kind) => (sensorCounts.get(kind) ?? 0) > 0)
    .map((kind) => `${SENSOR_LABEL[kind]} ${sensorCounts.get(kind) ?? 0}`)
    .join('、');
  const risk = warnings.length > 0 ? warnings.join('；') : '未发现明显参数冲突，仍需人工确认选型与安全。';
  const text = [
    `机型方案：${config.name}`,
    `整机形态：${design.form.name}（${design.form.id}）`,
    `工位：${config.stations.length} 个；执行机构：${config.actuators.length} 个（${actuatorText || '无'}）；传感器：${config.sensors.length} 个（${sensorText || '无'}）`,
    `节拍：目标 ${cycle.perMin} 件/分钟（${cycle.secondsPerPiece.toFixed(2)} 秒/件）；估算 ${cycle.throughputPerMin.toFixed(2)} 件/分钟（单工位 ${cycle.stationSeconds.toFixed(2)} 秒/件）；瓶颈：${cycle.bottleneck}`,
    `功率：${power.totalKw.toFixed(2)} kW / ${power.currentA.toFixed(1)} A / 断路器 ${power.breakerSuggestion.rating} A ${power.breakerSuggestion.poles}P` +
      `${power.dc24 ? ` / 24V 余量 ${power.dc24.marginPct}%` : ''}（方案估算）`,
    `风险：${risk}`,
    '说明：三维几何为按配置生成的标准件外形，功率与节拍均为估算，需人工确认。'
  ].join('\n');
  return text.length <= 600 ? text : `${text.slice(0, 597)}...`;
}


/**
 * 输送机修正：通用合成器按「工位机构时间」推节拍、按执行机构功率累加，
 * 对皮带线是错的。这里覆盖节拍（线速 ÷ 间距）、驱动选型（阻力 × 线速）与 BOM 结构件，
 * 并把公式逐条写进 assumptions。
 */
function applyConveyorRefinement(
  design: MachineDesign,
  brief: MachineBrief,
  warnings: string[],
  assumptions: string[]
): void {
  const ref = refineConveyor({
    ...(brief.conveyor ? { conveyor: brief.conveyor } : {}),
    cyclePerMin: brief.cyclePerMin
  });
  assumptions.push(...ref.assumptions);

  // 转向工位：从 config 里找到顶升轴与回转轴（synthMachine 已加好），
  // 节拍按「顶升 + 旋转 + 回落」三段之和封顶——顶升轴 duration 已经含举升 + 回落两趟
  const turnerAxis = design.config.actuators.find((actuator) => actuator.id === 'turner-rotary');
  const turnerLiftAxis = design.config.actuators.find((actuator) => actuator.id === 'turner-lift');
  const turnerAngle = turnerAxis?.rotationRangeDeg ?? 0;
  const turnerSeconds = turnerAxis
    ? ((turnerAxis.durationMs ?? 0) + (turnerLiftAxis?.durationMs ?? 0)) / 1000
    : 0;
  const turnerCapacity = turnerSeconds > 0 ? Math.round((60 / turnerSeconds) * 100) / 100 : Infinity;

  const beltThroughput = ref.estimate.throughputPerMin;
  const targetPerMin = brief.cyclePerMin ?? beltThroughput;
  // 光伏板必须逐件转过 90°，转台是串行工位：产能 = min(线速产能, 60 / 转向时间)
  const throughput = Math.min(beltThroughput, turnerCapacity);
  const meetsTarget = throughput + 1e-9 >= targetPerMin;
  const turnerLimited = turnerSeconds > 0 && turnerCapacity < beltThroughput;
  design.cycle.perMin = targetPerMin;
  design.cycle.throughputPerMin = throughput;
  design.cycle.partsPerMinute = throughput;
  design.cycle.secondsPerPiece = round(60 / targetPerMin);
  design.cycle.stationSeconds = round(60 / throughput);
  design.cycle.estimatedSecondsPerPiece = design.cycle.stationSeconds;
  design.cycle.slowestStation = 0;
  design.cycle.slowestActionSeconds = round(turnerSeconds);
  design.cycle.requiredParallelStations = Math.max(1, Math.ceil(targetPerMin / throughput));
  design.cycle.requiredTotalStations = design.cycle.requiredParallelStations;
  design.cycle.meetsTarget = meetsTarget;
  design.cycle.mode = 'linear';
  design.cycle.bottleneck =
    `线速 ${ref.speedMps} m/s ÷ 工件间距 ${ref.estimate.pitchMm} mm → ${beltThroughput} 件/分钟` +
    (turnerSeconds > 0
      ? `；转向工位每件 ${turnerSeconds} s（顶升+旋转 ${turnerAngle}°+回落）→ ${turnerCapacity} 件/分钟` +
        `${turnerLimited ? '（转向为瓶颈）' : '（不构成瓶颈）'}，取小值 ${throughput} 件/分钟`
      : '') +
    `（目标 ${targetPerMin} 件/分钟${meetsTarget ? '，满足' : '，未达标'}）；输送线没有工位节拍，产能靠提速或减小间距。`;
  if (turnerLimited && !meetsTarget) {
    warnings.push(
      `节拍瓶颈在转向工位：${turnerAngle}° 转向一次 ${turnerSeconds} s，只有 ${turnerCapacity} 件/分钟，` +
        `低于目标 ${targetPerMin} 件/分钟；需要提高回转速度（${turnerAngle}° 建议 ≤ ${round(60 / targetPerMin, 2)} s）或加双工位转台。`
    );
  }
  if (!meetsTarget && !turnerLimited) {
    warnings.push(
      `产能不足：线速 ${ref.speedMps} m/s、间距 ${ref.estimate.pitchMm} mm 只有 ${throughput} 件/分钟，` +
      `低于目标 ${targetPerMin} 件/分钟；需要把线速提到 ${round((targetPerMin * ref.estimate.pitchMm) / 60_000, 2)} m/s 或减小工件间距。`
    );
  }

  // BOM：把「旋转轴」占位换成输送机结构件与驱动
  const before = design.bomDraft.items.length;
  // 只清掉通用模型的「旋转轴」占位行（伺服驱动行保留）：转向工位的回转轴另有专行
  design.bomDraft.items = design.bomDraft.items.filter(
    (item) => item.role !== 'rotary' && !(item.kind === 'actuator' && item.name === '旋转轴')
  );
  const removed = before - design.bomDraft.items.length;
  const params = ref.estimate.params;
  design.bomDraft.items.push(
    {
      kind: 'actuator',
      name: `皮带输送线体（L${params.lengthMm}×B${params.widthMm}）`,
      qty: 1,
      note: '侧梁/横撑/支腿/端板/滚筒/皮带/侧挡边，几何由参数化内核生成',
      role: 'other'
    },
    {
      kind: 'actuator',
      name: `减速电机 ${ref.estimate.motorW} W（i=18，输出约 76 rpm）`,
      qty: 1,
      note: `驱动阻力 ${ref.estimate.forceN} N，滚筒扭矩 ${ref.estimate.torqueNm} N·m`,
      role: 'other',
      ratedW: ref.estimate.motorW
    },
    {
      kind: 'actuator',
      name: '尾部张紧滑座 + M10 调节螺杆',
      qty: 2,
      note: `行程 ±30 mm，按中心距 0.5%~1% 初张（约 ${Math.round(params.lengthMm * 0.005)}~${Math.round(params.lengthMm * 0.01)} mm）`,
      role: 'other'
    },
    {
      kind: 'actuator',
      name: '可调地脚 M10',
      qty: 4,
      note: '机架找平与地面固定',
      role: 'other'
    }
  );

  // 转向工位 BOM：按 conveyorBom() 的口径归并（同类同规格合一行），成品件与加工件分行。
  // 顶升旋转单元 = 底座框架 + 下沉框架 + 2 顶升气缸 + 4 导向柱 + 台板 + 回转支承 + 转台盘
  // + 9 支撑指 + 转向电机；皮带改成 6 条窄带（每带 1 条行程 + 1 条回程、各 1 套滚筒）。
  if (turnerAxis) {
    const layout = turnerLayout({ ...params, turnerAngleDeg: turnerAngle });
    if (layout) {
      design.bomDraft.items.push(
        {
          kind: 'actuator',
          name: `转向工位底座框架 ${Math.round(layout.beamLengthMm)}×${layout.beamWidthMm}×${layout.beamThicknessMm}`,
          qty: 2,
          note: '自制加工件：两根纵向梁坐在两侧纵梁上沿，吊住顶升下沉框架',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `顶升下沉框架底盘 ${Math.round(layout.frameBaseLengthMm)}×${Math.round(layout.frameBaseWidthMm)}×12 + 4 吊柱`,
          qty: 1,
          note: '自制加工件：气缸/导向柱/转向电机的安装基面，装在纵梁内侧（不占带面）',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `顶升气缸 φ${layout.cylBodyDiameterMm}×56（行程 ${layout.strokeMm}）`,
          qty: 2,
          note: `竖直直线轴 turner-lift：顶升 ${layout.strokeMm} mm，两缸同步，带磁性开关（上/下两个到位点）`,
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `升降导向柱 φ${layout.guideDiameterMm}×${Math.round(layout.guideTopZ - layout.guideBottomZ)}`,
          qty: 4,
          note: '外购成品件：45# 镀铬光轴 + 自润滑导套，四角布置，抗偏载',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `升降台板 ${layout.plateLengthMm}×${layout.plateWidthMm}×${layout.plateThicknessMm}`,
          qty: 1,
          note: `自制加工件：四角开 φ${layout.guideDiameterMm + 4} 导向过孔，全程在皮带面以下升降（行程 ${layout.strokeMm} mm）`,
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `回转支承环 φ${layout.ringDiameterMm}/φ${layout.ringBoreMm}×${layout.ringHeightMm}`,
          qty: 1,
          note: '外购成品件：薄壁回转支承，外圈坐升降台板、内圈随转台盘（原型不建齿圈）',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `转向转台盘 φ${layout.tableDiameterMm}×${layout.tableThicknessMm}`,
          qty: 1,
          note: '自制加工件：圆盘整个待在带面以下（顶升到位时盘顶 844 < 带底 846），不穿带面',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `转向支撑指 ${layout.fingerWidthMm}×${layout.fingerWidthMm} + φ20×55`,
          qty: layout.fingerCenters.length,
          note: `自制加工件：指宽 ${layout.fingerWidthMm} < 带间间隙 ${Math.round(layout.beltGapMm)}，从带缝穿过顶升；9 只按 4 折对称布置，转 90° 后落点仍是同一组带缝`,
          role: 'other'
        },
        {
          kind: 'actuator',
          name: `窄带并联 ${layout.beltCount} × ${layout.beltWidthMm} mm（带缝 ${Math.round(layout.beltGapMm)}）`,
          qty: 1,
          note: 'PVC 窄带整条连续（不为转向断开），每条一套主动/从动滚筒，可用公共轴；工件全程不离开输送面',
          role: 'other'
        },
        {
          kind: 'actuator',
          name: '转向减速电机 0.75 kW（i=180，输出约 8 rpm）',
          qty: 1,
          note: `${layout.angleDeg}° 分度 ${layout.rotateSeconds} s；整段动作 ${layout.actionSeconds} s = 顶升 ${layout.liftSeconds / 2} + 旋转 ${layout.rotateSeconds} + 回落 ${layout.liftSeconds / 2}（点位 ST-TURN-ROT）`,
          role: 'other',
          ratedW: 750
        }
      );
    }
  }
  if (removed > 0) {
    assumptions.push(`BOM 已把通用模型的 ${removed} 行「旋转轴」替换为输送机结构件、减速电机与张紧组件。`);
  }
  assumptions.push(
    `整机几何：调用 conveyor-assembly 生成参数化装配（${
      turnerAxis
        ? '窄带并联线体 + 顶升旋转单元（底座框架/下沉框架/2 顶升气缸/4 导向柱/台板/回转支承/转台盘/9 支撑指/转向电机）'
        : '单段线体'
    }；` +
      `零件总数随线体长度变化（横撑数 = 长度/500+1），以建模回传为准），由 build123d 内核布尔求并并导出 STEP/STL。`
  );

  // 工件长边 > 转台盘直径：旋转 90° 后两端会悬出，必须靠支撑指 + 真空吸盘或加托板
  if (turnerAxis) {
    const layout = turnerLayout({ ...params, turnerAngleDeg: turnerAngle });
    const partLength = brief.workpiece?.lengthMm ?? 0;
    if (layout && partLength > layout.tableDiameterMm) {
      const overhang = Math.round((partLength - layout.tableDiameterMm) / 2);
      warnings.push(
        `工件长边 ${Math.round(partLength)} mm 大于转台盘直径 φ${layout.tableDiameterMm} mm：旋转 ${turnerAngle}° 后两端各悬出约 ${overhang} mm，` +
          `由 ${layout.fingerCenters.length} 只支撑指（4 折对称）托住板心、板件自身刚性承担悬出段；` +
          '若工件易变形，需在支撑指上加真空吸盘或另加托板（原型不建模吸盘）。'
      );
    }
  }
}

export function synthMachine(brief: MachineBrief, options: SynthOptions = {}): MachineDesign {
  const requestedStations = assertStations(options.stationCount ?? brief.stations);
  const cyclePerMin = assertCycle(options.cyclePerMin ?? brief.cyclePerMin ?? MACHINE_DEFAULT_CYCLE_PER_MIN);
  const process = brief.process;
  const formPick = pickForm(brief, TEMPLATES, {
    stationCount: requestedStations,
    cyclePerMin,
    ...(options.formId ? { formId: options.formId } : {})
  });
  const stations = formPick.stations;
  const resolvedLayout = resolveLayout(brief, requestedStations);
  const selectedForm = formPick.form;
  const layout = {
    ...resolvedLayout,
    mode: resolvedLayout.mode === 'single' ? resolvedLayout.mode : selectedForm.layout
  };
  const form = summarizeForm(formPick);
  const template = templateFor(process);
  const templateActuatorKinds = templateKinds(template.actuators);
  const templateSensorKinds = templateKinds(template.sensors);
  const servo = servoDetected(brief);
  const warnings: string[] = [];
  const assumptions: string[] = [
    `整机形态：${selectedForm.name}（${selectedForm.id}）——${selectedForm.rationale}`,
    '功率按 power.ts 统一模型估算：优先取元件库额定功率，同时系数/负载率/效率/功率因数逐条写入 assumptions；不是实测功率或短路计算。',
    '成本按 cost-model.ts 做方案阶段粗估：机械/电气/人工分项，缺价行不进入合计，不替代正式报价。',
    '节拍按 evaluateFlow 模型估算（single / linear / dial / parallel / cell），由工位、工序时间与布局公式求值；均未计入上下料、通讯、人工干预与调试损失。',
    '三维几何由配置按规则生成标准件外形（机架、工位底板、门架、气缸/夹爪/旋转台、传感器、输送线或分度转盘，单位 mm），不包含结构强度、干涉与真实运动学校核。'
  ];
  if (brief.footprint && Number.isFinite(brief.footprint.lengthMm) && brief.footprint.lengthMm > 0 &&
      Number.isFinite(brief.footprint.widthMm) && brief.footprint.widthMm > 0) {
    assumptions.push(
      `占地需求已结构化记录：长度 ≤ ${brief.footprint.lengthMm} mm、宽度 ≤ ${brief.footprint.widthMm} mm；` +
      '须与完整整机实际几何包络复核，超限只提示，不自动缩放实体。'
    );
  }

  if (stations !== requestedStations) {
    const [min, max] = selectedForm.stationRange;
    assumptions.push(
      `工位数夹紧：需求 ${requestedStations} 工位超出形态 ${selectedForm.name}（${selectedForm.id}）的 ${min}–${max} 工位能力，` +
      `实际按 ${stations} 工位生成；差额需非标设计或拆分机台。`
    );
  }

  if (layout.auto) {
    assumptions.push(`布局自动推断为 ${layout.mode}：${layout.inferred}。`);
  }
  if (layout.mode === 'linear') {
    const chain = brief.processes?.length ? brief.processes.join(' → ') : '多道工序';
    assumptions.push(`布局按流水线估算（linear）：工序按 ${chain} 分工位，整线产能 = 60 / 最慢工位时间，建议复制瓶颈工序。`);
  } else if (layout.mode === 'dial') {
    assumptions.push(`布局按转盘分度估算（dial）：各工位同时作业，节拍 = 最慢工位时间 + 分度时间；indexSeconds 采用形态默认 ${selectedForm.indexSeconds ?? 0.6} 秒/次。`);
  } else if (layout.mode === 'cell') {
    const lanes = selectedForm.geometry.lanes ?? 1;
    assumptions.push(
      '布局按单元式估算（cell）：组内工位串行、组间并行，' +
      (lanes > 1
        ? `${lanes} 条轨道并行，节拍 = (最慢工位时间 + 转移时间) / ${lanes}。`
        : '节拍 = 最慢组时间 + 转移时间。')
    );
  } else if (layout.mode === 'single') {
    assumptions.push('布局按单工位估算（single）：一个工位完成全部工序，节拍 = 各工序时间之和。');
  } else if (brief.notes.includes(DEFAULT_NOTE_LAYOUT) || layout.fallback) {
    assumptions.push('未识别布局，按同工序并行估算；如实际为流水线，请显式指定 layout=line。');
  } else {
    assumptions.push(`布局按同工序并行估算（parallel）：${stations} 个工位执行同一工艺「${PROCESS_LABEL[process]}」，整机产能 = 工位数 / 单工位时间 × 60。`);
  }

  if (process === 'unknown') {
    warnings.push('未识别工艺：已按通用工艺模板（每工位 1 气缸 + 1 接近开关）合成，请确认工艺类型。');
    assumptions.push('未识别工艺，按 通用 模板补全动作与检测。');
  }
  if (options.stationCount === undefined && brief.notes.includes(DEFAULT_NOTE_STATIONS)) {
    warnings.push(`未提供工位数：已按缺省值 ${stations} 工位合成，请确认实际工位数。`);
    assumptions.push(`工位数缺省为 ${stations}。`);
  }
  if (options.stationCount === undefined) {
    const invalidStationNote = brief.notes.find((note) => /^工位数\s*\d+\s*(?:无效|超出)/.test(note));
    if (invalidStationNote) {
      warnings.push(invalidStationNote);
      assumptions.push(`${invalidStationNote}；实际按 ${stations} 工位生成，差额需非标设计或拆分机台。`);
    }
  }
  if (options.cyclePerMin === undefined && brief.cyclePerMin === null) {
    warnings.push(`未提供节拍：已按缺省值 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟（${(60 / MACHINE_DEFAULT_CYCLE_PER_MIN).toFixed(1)} 秒/件）估算，请确认目标产能。`);
    assumptions.push(`节拍缺省为 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟。`);
  }
  if (brief.notes.includes(DEFAULT_NOTE_CYCLE) && brief.cyclePerMin !== null) {
    // 理论上不会同时出现；保留显式标记的防御分支，避免外部构造的 brief 丢失缺省说明。
    assumptions.push('brief 标记了节拍缺省，但已提供 cyclePerMin；以 cyclePerMin 为准。');
  }
  if ((layout.fallback || brief.notes.includes(DEFAULT_NOTE_LAYOUT)) && stations > 1) {
    warnings.push('未识别布局：已按同工序并行估算；如实际为流水线，请在需求中写明「流水线/线体/产线」或显式指定 layout。');
  }

  let actuatorKinds = flattened(brief.actuators);
  let actuatorSource = 'brief';
  if (actuatorKinds.length === 0) {
    actuatorKinds = Array.from({ length: stations }, () => templateActuatorKinds).flat();
    actuatorSource = 'template';
    assumptions.push(`未指定执行机构，按 ${template.label} 模板补全（每工位：${templateDescription(template.actuators.map((entry) => ACTUATOR_LABEL[entry.kind]))}）。`);
  }

  let actuatorBuckets = distribute(actuatorKinds, stations);
  const emptyActuatorStations = actuatorBuckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.length === 0);
  if (emptyActuatorStations.length > 0) {
    const fillKind = templateActuatorKinds[0] ?? 'cylinder';
    for (const { bucket } of emptyActuatorStations) bucket.push(fillKind);
    actuatorBuckets = actuatorBuckets;
    warnings.push(
      `执行机构数量不足：${emptyActuatorStations.length} 个工位没有动作，已补 ${ACTUATOR_LABEL[fillKind]}；建议至少为每工位配置 1 个动作。`
    );
  }

  // 大件告警：模板几何按标准小件排，工件超过 1.5m 时包络/工位间距必须按工件重做
  const workpiece = brief.workpiece;
  const bigPart = Math.max(workpiece?.lengthMm ?? 0, workpiece?.widthMm ?? 0);
  if (bigPart >= 1500) {
    warnings.push(
      `工件 ${workpiece?.lengthMm ?? '?'}×${workpiece?.widthMm ?? '?'} mm 属于大件：模板工位间距与机架包络按标准小件排，` +
        '不含大件夹持/缓存空间，方案包络不能作为占地与验收依据；需按工件尺寸重做输送段与缓存工位。'
    );
  }

  let sensorKinds = flattened(brief.sensors);
  let sensorSource = 'brief';
  if (sensorKinds.length === 0) {
    sensorKinds = Array.from({ length: stations }, () => templateSensorKinds).flat();
    sensorSource = 'template';
    assumptions.push(`未指定传感器，按 ${template.label} 模板补全（每工位：${templateDescription(template.sensors.map((entry) => SENSOR_LABEL[entry.kind]))}）。`);
  }

  let sensorBuckets = distribute(sensorKinds, stations);
  const emptySensorStations = sensorBuckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.length === 0);
  if (emptySensorStations.length > 0) {
    for (const { bucket } of emptySensorStations) bucket.push('proximity');
    sensorBuckets = sensorBuckets;
    warnings.push(
      `传感器数量不足：${emptySensorStations.length} 个工位没有到位检测，已补接近开关；建议每工位至少 1 个到位检测。`
    );
  }

  const stationNames = Array.from({ length: stations }, (_unused, index) => `工位${index + 1}`);
  /**
   * 转向工位（需求「把光伏板旋转 90° 改变方向」）。
   *
   * 只对单层输送线成立：立体缓存的中段被升降机构占着，两套机构抢同一个空间，
   * 这时如实不加工位、只给 warning，不假装做了转向。
   */
  const turnerAngleDeg = process === 'conveyor' && brief.turner?.present ? brief.turner.angleDeg : 0;
  const turnerParams = {
    ...conveyorParamsFromBrief(brief.conveyor),
    layers: brief.conveyor?.layers ?? 1,
    turnerAngleDeg
  };
  const turnerPlan = turnerAngleDeg > 0 ? turnerLayout(turnerParams) : null;
  const turnerBlockedReason = turnerAngleDeg > 0 && !turnerPlan ? turnerSkipReason(turnerParams) : null;
  if (turnerBlockedReason) {
    warnings.push(`需求要求转向工位，但本方案不做：${turnerBlockedReason}。`);
    assumptions.push(`转向需求已记录（旋转 ${turnerAngleDeg}°），但几何未建转向工位：${turnerBlockedReason}。`);
  }
  if (turnerPlan) stationNames.push(TURNER_STATION_NAME);
  const actuators: MachineConfig['actuators'] = [];
  const sensors: MachineConfig['sensors'] = [];
  const points: string[] = [];

  for (const [stationIndex, station] of stationNames.entries()) {
    const kinds = actuatorBuckets[stationIndex] ?? [];
    const actuatorIds: string[] = [];
    for (const [offset, kind] of kinds.entries()) {
      const actuatorIndex = offset + 1;
      const id = `st${stationIndex + 1}-${kind}-${actuatorIndex}`;
      const pointFields = stationPoints(stationIndex, actuatorIndex, kind);
      const actuator = {
        id,
        name: `${station}${ACTUATOR_LABEL[kind]}${actuatorIndex}`,
        kind,
        station,
        travelMm: ACTUATOR_TRAVEL_MM[kind],
        durationMs: ACTUATOR_DURATION_MS[kind],
        position: ACTUATOR_POSITION[kind],
        ...pointFields
      } satisfies MachineConfig['actuators'][number];
      actuators.push(actuator);
      actuatorIds.push(id);
      for (const point of [pointFields.extendPoint, pointFields.retractPoint, pointFields.gripPoint, pointFields.point]) {
        if (point !== undefined) points.push(point);
      }
    }

    const stationSensorKinds = sensorBuckets[stationIndex] ?? [];
    for (const [offset, kind] of stationSensorKinds.entries()) {
      const point = sensorPoint(stationIndex, offset + 1, kind);
      sensors.push({
        point,
        station,
        part: actuatorIds[0] ?? station,
        ...(kind === 'safety' ? { color: '#ef4444' } : {})
      });
      points.push(point);
    }
  }

  // 转向工位：两条轴（顶升 + 旋转）都进 config.actuators → 自动进 BOM / PLC io-map / 联动时间线。
  // 顺序是「顶升 → 旋转 → 回落」：顶升轴 durationMs 含举升与回落两趟（气缸往返），
  // 旋转轴只算分度；两段相加就是工位时间（见 applyConveyorRefinement）。
  if (turnerPlan) {
    const liftPoint = 'ST-TURN-LIFT';
    const turnerPoint = 'ST-TURN-ROT';
    actuators.push({
      id: 'turner-lift',
      name: `${TURNER_STATION_NAME}顶升台`,
      // 本域执行机构只有 cylinder/gripper/rotary 三种，顶升气缸就是 Z 向直线轴：
      // kind=cylinder + travelMm + position[2]=1（向上），语义上是线性轴而不是夹爪/旋转
      kind: 'cylinder',
      station: TURNER_STATION_NAME,
      point: liftPoint,
      travelMm: turnerPlan.strokeMm,
      durationMs: Math.round(turnerPlan.liftSeconds * 1000),
      position: TURNER_LIFT_POSITION
    });
    actuators.push({
      id: 'turner-rotary',
      name: `${TURNER_STATION_NAME}回转台`,
      kind: 'rotary',
      station: TURNER_STATION_NAME,
      point: turnerPoint,
      rotationRangeDeg: turnerPlan.angleDeg,
      durationMs: Math.round(turnerPlan.rotateSeconds * 1000),
      position: TURNER_AXIS_POSITION
    });
    for (const point of [liftPoint, turnerPoint]) if (!points.includes(point)) points.push(point);

    // 四个到位信号（两条轴各两个），part 必须绑到对应执行机构 id，否则 PLC 预检会报
    // ACTUATOR_SENSOR_MISSING（precheck.ts: 每条执行机构至少一个绑定传感器）：
    //   台面在下 / 顶升到位 → turner-lift；旋转原点 / 旋转到位 → turner-rotary
    const turnerSensors = [
      ['ST-TURN-LIFT-HOME', '顶升原位（台面在下）', 'turner-lift'],
      ['ST-TURN-LIFT-POS', `顶升 ${turnerPlan.strokeMm} mm 到位`, 'turner-lift'],
      ['ST-TURN-ROT-HOME', '旋转原点', 'turner-rotary'],
      ['ST-TURN-ROT-POS', `转 ${turnerPlan.angleDeg}° 到位`, 'turner-rotary']
    ] as const;
    for (const [point, , part] of turnerSensors) {
      sensors.push({ point, station: TURNER_STATION_NAME, part });
      if (!points.includes(point)) points.push(point);
    }
    // 四个信号合成一条 assumption：trim.ts 会把 >20 条的数组裁成 {items,total,truncated}，
    // 一旦 assumptions 超 20 条，方案卡「应用到工程」会因为「必须是字符串数组」被拒
    assumptions.push(
      `转向工位四个到位信号：${turnerSensors.map(([point, label, part]) => `${label} ${point}→${part}`).join('、')}。`
    );
    assumptions.push(
      `转向工位：线体中段加顶升旋转单元（升降台板 ${turnerPlan.plateLengthMm}×${turnerPlan.plateWidthMm} + 回转支承 ` +
        `φ${turnerPlan.ringDiameterMm}×${turnerPlan.ringHeightMm} + 转台盘 φ${turnerPlan.tableDiameterMm}），` +
        `顶升 ${turnerPlan.strokeMm} mm → 旋转 ${turnerPlan.angleDeg}° → 回落；两条轴 turner-lift（点位 ${liftPoint}）/ ` +
        `turner-rotary（点位 ${turnerPoint}），合计 ${turnerPlan.actionSeconds} s/件，已计入工位时间。`
    );
    assumptions.push(
      `输送面改成 ${turnerPlan.beltCount} 条 ${turnerPlan.beltWidthMm} mm 窄带并联（带缝 ${Math.round(turnerPlan.beltGapMm)} mm），` +
        `窄带整条连续、不因转向断开：${turnerPlan.fingerCenters.length} 只支撑指（指宽 ${turnerPlan.fingerWidthMm} < 带缝）从带缝穿过顶升，` +
        '工件全程不离开输送面；会转的回转支承/转台盘/升降台板都待在带面以下（顶升到位时盘顶仍低于带底），不为转台开口。' +
        `每带一套主动/从动滚筒（可共用通轴，BOM 按 ${turnerPlan.beltCount} 套估），主驱动仍按 1 套减速电机估，多带同步需人工确认。`
    );
  }

  const config = validateMachineConfig({
    id: options.id ? sanitizeId(options.id) : `design-${process}-${stations}st`,
    name: options.name ?? `${stations} 工位${PROCESS_LABEL[process]}机（方案草案）`,
    stations: stationNames,
    actuators,
    sensors
  });

  const baseSeconds = PROCESS_BASE_SECONDS[process];
  const stationWork = actuatorBuckets.map((kinds, stationIndex) => {
    const actionSeconds = kinds.reduce((sum, kind) => sum + ACTUATOR_SECONDS[kind], 0);
    const stationKind = kinds.reduce<MachineActuatorKind | null>((best, kind) => {
      if (!best) return kind;
      return ACTUATOR_SECONDS[kind] > ACTUATOR_SECONDS[best] ? kind : best;
    }, null) ?? 'cylinder';
    return { stationIndex, seconds: baseSeconds + actionSeconds, kind: stationKind };
  });
  const processChain = brief.processes?.length ? brief.processes : [PROCESS_LABEL[process]];
  const stationOps: FlowOp[] = stationWork.map((work) => ({
    id: `st${work.stationIndex + 1}-op`,
    name: processChain[work.stationIndex % processChain.length] ?? PROCESS_LABEL[process],
    seconds: work.seconds,
    station: work.stationIndex
  }));

  let flowOps: FlowOp[] = stationOps;
  let copies: number | undefined;
  if (layout.mode === 'parallel') {
    // 并行布局下每个副本执行同一套完整工序；合成器用各工位的最大作业时间代表一套副本。
    const fullSetSeconds = stationWork.reduce((max, work) => Math.max(max, work.seconds), 0);
    flowOps = [{
      id: 'parallel-full-set',
      name: processChain.join(' + '),
      seconds: fullSetSeconds,
      station: 0
    }];
    copies = stations;
  }

  const flowModel: FlowModel = {
    layout: layout.mode,
    stations,
    ops: flowOps,
    targetPerMin: cyclePerMin,
    ...(copies === undefined ? {} : { copies }),
    ...(selectedForm.geometry.lanes === undefined ? {} : { lanes: selectedForm.geometry.lanes }),
    ...(selectedForm.indexSeconds === undefined ? {} : { indexSeconds: selectedForm.indexSeconds }),
    ...(selectedForm.transferSeconds === undefined ? {} : { transferSeconds: selectedForm.transferSeconds })
  };
  const evaluation: FlowEvaluation = evaluateFlow(flowModel);
  for (const note of evaluation.notes) assumptions.push(`产能模型：${note}`);

  const secondsPerPiece = round(60 / cyclePerMin);
  const stationSeconds = round(evaluation.stationSecondsMax, 3);
  const throughputPerMin = round(evaluation.throughputPerMin, 2);
  const meetsTarget = evaluation.meetsTarget === true;
  const requiredTotalStations = Number.isFinite(evaluation.requiredStations)
    ? evaluation.requiredStations
    : 0;
  const requiredParallelStations = layout.mode === 'parallel'
    ? requiredTotalStations
    : Math.max(1, Math.ceil(requiredTotalStations / stations));
  const bottleneckStation = (evaluation.bottleneck?.station ?? 0) + 1;
  const bottleneckWork = stationWork[evaluation.bottleneck?.station ?? 0]
    ?? stationWork[0]
    ?? { stationIndex: 0, seconds: stationSeconds, kind: templateActuatorKinds[0] ?? 'cylinder' };
  const stationLabel = `工艺固定 ${baseSeconds.toFixed(2)}s + ${ACTUATOR_LABEL[bottleneckWork.kind]} ${ACTUATOR_SECONDS[bottleneckWork.kind].toFixed(2)}s`;
  let bottleneck: string;

  if (layout.mode === 'parallel') {
    const margin = throughputPerMin / cyclePerMin;
    bottleneck =
      `单工位 ${stationSeconds.toFixed(2)} 秒/件，${stations} 工位并行 → ${throughputPerMin.toFixed(2)} 件/分钟` +
      `（${stationLabel}；目标 ${cyclePerMin} 件/分钟${meetsTarget ? `，余量 ${margin.toFixed(2)} 倍` : '，未达标'}）`;
    if (!meetsTarget) {
      warnings.push(
        `节拍瓶颈（并行同工序）：单工位估算 ${stationSeconds.toFixed(2)} 秒/件，超过目标 ${secondsPerPiece.toFixed(2)} 秒/件；` +
        `${stations} 工位并行产能 ${throughputPerMin.toFixed(2)} 件/分钟，低于目标 ${cyclePerMin} 件/分钟；` +
        `建议总工位 ≥ ${requiredTotalStations}（每道工序并行工位 ≥ ${requiredParallelStations}）。`
      );
    }
  } else if (layout.mode === 'linear') {
    bottleneck =
      `流水线最慢工序为工位${bottleneckStation}，单件 ${stationSeconds.toFixed(2)} 秒 → ${throughputPerMin.toFixed(2)} 件/分钟` +
      `（${stationLabel}；目标 ${cyclePerMin} 件/分钟${meetsTarget ? '，满足' : '，未达标'}）`;
    if (!meetsTarget) {
      warnings.push(
        `流水线节拍瓶颈：工位${bottleneckStation} 估算 ${stationSeconds.toFixed(2)} 秒/件，超过目标 ${secondsPerPiece.toFixed(2)} 秒/件；` +
        `整线产能 ${throughputPerMin.toFixed(2)} 件/分钟，低于目标 ${cyclePerMin} 件/分钟；` +
        `建议复制瓶颈工序，每道工序并行工位 ≥ ${requiredParallelStations}（总工位 ≥ ${requiredTotalStations}）。`
      );
    }
  } else {
    const indexSeconds = flowModel.indexSeconds ?? 0.6;
    const modeLabel: Record<Exclude<MachineLayout, 'parallel' | 'linear'>, string> = {
      single: '单工位',
      dial: '转盘分度',
      cell: '单元布局'
    };
    const extra = layout.mode === 'dial'
      ? `，含分度 ${indexSeconds.toFixed(2)} 秒`
      : layout.mode === 'cell'
        ? `，${flowModel.lanes ?? 1} 轨并行`
        : '';
    bottleneck =
      `${modeLabel[layout.mode]}：最慢工位${bottleneckStation} 单件 ${stationSeconds.toFixed(2)} 秒${extra} → ` +
      `${throughputPerMin.toFixed(2)} 件/分钟（${stationLabel}；目标 ${cyclePerMin} 件/分钟${meetsTarget ? '，满足' : '，未达标'}）`;
    if (!meetsTarget) {
      warnings.push(
        `节拍瓶颈（${layout.mode}）：工位${bottleneckStation} 估算 ${stationSeconds.toFixed(2)} 秒/件，超过目标 ${secondsPerPiece.toFixed(2)} 秒/件；` +
        `当前产能 ${throughputPerMin.toFixed(2)} 件/分钟，低于目标 ${cyclePerMin} 件/分钟；` +
        (Number.isFinite(evaluation.requiredStations)
          ? `建议总工位 ≥ ${requiredTotalStations}（每道工序并行工位 ≥ ${requiredParallelStations}）。`
          : '当前布局的固定分度/转移时间已超过目标节拍，仅靠增加工位无法达标。')
      );
    }
  }

  if (formPick.warning) warnings.push(`形态选型：${formPick.warning}`);

  if (servo) {
    assumptions.push('检测到伺服/步进驱动：按旋转轴建模；功率优先取元件库伺服额定功率，未选型时按类别默认值并告警。');
  }
  if (brief.brand) assumptions.push(`品牌按需求中的「${brief.brand}」记录，具体型号待选型。`);
  if (brief.voltage) assumptions.push(`供电按需求中的 ${brief.voltage} 记录，未做容量与保护校验。`);
  if (actuatorSource === 'brief') assumptions.push('执行机构按需求数量均分到各工位。');
  if (sensorSource === 'brief') assumptions.push('传感器按需求数量均分到各工位。');

  const finalActuatorKinds = actuatorBuckets.flat();
  const finalSensorKinds = sensorBuckets.flat();
  const bomDraft = buildBom(finalActuatorKinds, finalSensorKinds, servo, brief);
  const pricing = options.pricing ?? DEFAULT_MACHINE_PRICING;
  const design = {
    config,
    points,
    cycle: {
      mode: layout.mode,
      perMin: cyclePerMin,
      secondsPerPiece,
      stationSeconds,
      throughputPerMin,
      partsPerMinute: throughputPerMin,
      estimatedSecondsPerPiece: stationSeconds,
      baseSeconds,
      slowestStation: bottleneckStation,
      slowestActionSeconds: round(Math.max(0, stationSeconds - baseSeconds)),
      requiredParallelStations,
      requiredTotalStations,
      meetsTarget,
      bottleneck
    },
    power: {} as PowerResult,
    cost: {} as MachineCostEstimate,
    bomDraft,
    warnings,
    assumptions,
    form
  } as MachineDesign;
  design.power = estimatePower(design, {
    ...(options.parts ? { parts: options.parts } : {}),
    servo,
    voltage: options.voltage ?? brief.voltage ?? '380VAC',
    simultaneity: pricing.power.simultaneity,
    loadFactor: pricing.power.loadFactor,
    efficiency: pricing.power.efficiency,
    cosPhi: pricing.power.cosPhi,
    ...(options.pricingAssumptions ? { assumptions: options.pricingAssumptions } : {})
  });
  if (process === 'conveyor') applyConveyorRefinement(design, brief, warnings, assumptions);
  design.cost = estimateCost(design, {
    ...(options.parts ? { parts: options.parts } : {}),
    ...(options.pricebook ? { pricebook: options.pricebook } : {}),
    ...(options.builtinPricebook ? { builtinPricebook: options.builtinPricebook } : {}),
    pricing,
    ...(options.pricingAssumptions ? { pricingAssumptions: options.pricingAssumptions } : {})
  });
  return design;
}

/** 给 Agent 工具用的中文摘要；≤600 字，包含工位/机构/传感器/节拍/功率/风险。 */
export function summarizeMachineDesign(design: MachineDesign): string {
  return buildSummary(design);
}
