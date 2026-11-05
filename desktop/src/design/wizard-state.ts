// 整机设计向导的纯状态层：不读写文件、不访问 DOM，便于单测与渲染层复用。
// 草稿只记录用户输入与方案引用；所有产线公式仍由 machine/synth.ts 提供。

import {
  DEFAULT_ROTATION_RANGE_DEG,
  MAX_ACTUATOR_TRAVEL_MM,
  MAX_ROTATION_RANGE_DEG,
  MIN_ACTUATOR_TRAVEL_MM,
  MIN_ROTATION_RANGE_DEG,
  validateMachineConfig
} from '../commission/machine-config.ts';
import type {
  ActuatorConfig,
  MachineConfig,
  SensorConfig
} from '../commission/machine-config.ts';
import type { Placement } from '../enclosure/layout.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { createStationIdentity, isStationIdentityList, stationIdentitiesFor } from '../machine/station-identity.ts';
import { normalizeStationGeometryLayout } from '../machine/station-layout.ts';
import type { StationCycleInput } from './station-cycle.ts';
import { syncDesignBom } from './bom-sync.ts';
import { templateFor } from '../machine/templates.ts';
import type { MachineBrief, MachineProcess, MachineVoltage } from '../machine/spec.ts';
import { findOverlaps, placementSnapshotFingerprint } from './layout.ts';

export type DesignStep = 1 | 2 | 3 | 4 | 5;
export type IncomingForm = 'bulk' | 'tray' | 'aligned' | 'reel';
export type LoadingMethod = 'manual' | 'conveyor' | 'robot';
export type DesignProcess = 'screw' | 'dispense' | 'inspection' | 'assembly' | 'packaging';

export interface DesignFootprint {
  lengthMm: number;
  widthMm: number;
}

/** 第 1 步表单；转换为 MachineBrief 后交给 synthMachine。 */
export interface MachineBriefInput {
  name: string;
  incoming: IncomingForm;
  process: DesignProcess;
  cyclePerMin: number;
  /** null = 自动推荐工位。 */
  stations: number | null;
  load: LoadingMethod;
  footprint: DesignFootprint | null;
  voltage: Extract<MachineVoltage, '220VAC' | '380VAC'>;
  brand: string | null;
}

export type ActuatorDraft = ActuatorConfig;
export type SensorDraft = SensorConfig;

/** 类型改变后清除另一运动类型的值与来源；旋转轴回到 90° 方案/系统估算。 */
export function resetActuatorTravelOnKindChange(actuator: ActuatorDraft): void {
  delete actuator.travelMm;
  delete actuator.travelSource;
  delete actuator.rotationRangeDeg;
  delete actuator.rotationRangeSource;
  if (actuator.kind === 'rotary') actuator.rotationRangeDeg = DEFAULT_ROTATION_RANGE_DEG;
}

export interface StationDraft {
  id: string;
  name: string;
  actuators: ActuatorDraft[];
  sensors: SensorDraft[];
  /** 完整工位周期输入；null/缺失均表示尚未填写，手工输入始终待实测。 */
  cycleTime?: StationCycleInput | null;
}

export interface DesignDraft {
  version: 1;
  step: DesignStep;
  brief: MachineBriefInput;
  /** 仅表示需求表单中的待应用修改；旧方案与 placements 在显式重算前保持不变。 */
  pendingBrief?: MachineBriefInput;
  candidates?: MachineDesign[];
  selectedIndex?: 0 | 1 | 2;
  design?: MachineDesign;
  /** 身份关联无法安全推断时，持久保留给工程师的处理提示。 */
  stationIdentityNotice?: string;
  stations: StationDraft[];
  placements: Placement[];
  /** 仅确认与此精确二维 placements 快照绑定；任何布局修改均须重新确认。 */
  layoutOverlapConfirmationFingerprint?: string;
  updatedAt: string;
}

export const DESIGN_STEP_LABELS: Record<DesignStep, string> = {
  1: '需求',
  2: '方案对比',
  3: '工位与元件',
  4: '布局',
  5: '校核与产出'
};

export const DESIGN_STEPS: readonly DesignStep[] = [1, 2, 3, 4, 5];

export const PROCESS_LABELS: Record<DesignProcess, string> = {
  screw: '锁螺丝',
  dispense: '点胶',
  inspection: '检测',
  assembly: '装配',
  packaging: '包装'
};

export const INCOMING_LABELS: Record<IncomingForm, string> = {
  bulk: '散料',
  tray: '托盘',
  aligned: '整列',
  reel: '卷料'
};

export const LOADING_LABELS: Record<LoadingMethod, string> = {
  manual: '人工',
  conveyor: '输送线',
  robot: '机械手'
};

const PROCESSES = new Set<DesignProcess>(['screw', 'dispense', 'inspection', 'assembly', 'packaging']);
const INCOMING = new Set<IncomingForm>(['bulk', 'tray', 'aligned', 'reel']);
const LOADING = new Set<LoadingMethod>(['manual', 'conveyor', 'robot']);

/** 生成带 +08:00 偏移的 ISO 8601 时间，避免依赖运行机器时区。 */
export function shanghaiIso(date: Date = new Date()): string {
  const offsetMs = 8 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.` +
    `${pad(local.getUTCMilliseconds(), 3)}+08:00`;
}

export function emptyBrief(): MachineBriefInput {
  return {
    name: '',
    incoming: 'bulk',
    process: 'screw',
    cyclePerMin: 10,
    stations: null,
    load: 'conveyor',
    footprint: null,
    voltage: '380VAC',
    brand: null
  };
}

export function initialDraft(now: Date = new Date()): DesignDraft {
  return {
    version: 1,
    step: 1,
    brief: emptyBrief(),
    stations: [],
    placements: [],
    updatedAt: shanghaiIso(now)
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneActuator(value: ActuatorConfig): ActuatorConfig {
  return JSON.parse(JSON.stringify(value)) as ActuatorConfig;
}

function cloneSensor(value: SensorConfig): SensorConfig {
  return JSON.parse(JSON.stringify(value)) as SensorConfig;
}

/** 把向导字段翻译为 synthMachine 输入；名称/来料/上下料写入 notes，算法层不重复实现。 */
export function briefToMachineBrief(brief: MachineBriefInput): MachineBrief {
  const template = templateFor(brief.process as MachineProcess);
  const stations = brief.stations ?? template.stations;
  const notes = [
    `产品/机型：${brief.name.trim()}`,
    `来料形式：${INCOMING_LABELS[brief.incoming]}`,
    `上下料方式：${LOADING_LABELS[brief.load]}`,
    ...(brief.footprint
      ? [`占地限制：${brief.footprint.lengthMm}×${brief.footprint.widthMm} mm`]
      : ['占地限制：未填写，按方案推荐尺寸'])
  ];
  return {
    process: brief.process,
    stations,
    cyclePerMin: brief.cyclePerMin,
    layout: 'auto',
    footprint: brief.footprint ? { ...brief.footprint } : null,
    processes: [PROCESS_LABELS[brief.process]],
    actuators: [],
    sensors: [],
    brand: brief.brand?.trim() || null,
    voltage: brief.voltage,
    notes
  };
}

export function stationsFromDesign(design: MachineDesign): StationDraft[] {
  const stationIdentities = isStationIdentityList(design.stationIdentities, design.config.stations.length)
    ? design.stationIdentities
    : design.config.stations.map((_name, index) => `legacy:${encodeURIComponent(design.config.id)}:${index + 1}`);
  return design.config.stations.map((name, index) => ({
    id: stationIdentities[index] as string,
    name,
    actuators: design.config.actuators
      .filter((actuator) => actuator.station === name)
      .map(cloneActuator),
    sensors: design.config.sensors
      .filter((sensor) => sensor.station === name)
      .map(cloneSensor)
  }));
}

/** 候选方案按工位名称合并既有编辑；保留周期数值，但布局变化后需重新确认公共时间口径。 */
export function mergeStationDrafts(generated: StationDraft[], previous: StationDraft[]): { stations: StationDraft[]; kept: number } {
  const previousCounts = new Map<string, number>();
  for (const station of previous) {
    const key = station.name.trim();
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }
  const generatedCounts = new Map<string, number>();
  for (const station of generated) {
    const key = station.name.trim();
    generatedCounts.set(key, (generatedCounts.get(key) ?? 0) + 1);
  }
  const old = new Map(previous.filter((station) => previousCounts.get(station.name.trim()) === 1).map((station) => [station.name.trim(), station]));
  let kept = 0;
  const stations = generated.map((station) => {
    const key = station.name.trim();
    const existing = generatedCounts.get(key) === 1 ? old.get(key) : undefined;
    if (!existing) return station;
    kept += 1;
    return {
      ...station,
      name: existing.name,
      actuators: existing.actuators,
      sensors: existing.sensors,
      ...(existing.cycleTime === undefined
        ? {}
        : { cycleTime: existing.cycleTime === null ? null : { ...existing.cycleTime, sharedTimeConfirmed: false } })
    };
  });
  return { stations, kept };
}

/** 把第 3 步编辑结果写回 MachineDesign 的 config/points。 */
export function configFromStations(design: MachineDesign, stations: readonly StationDraft[]): MachineConfig {
  const names = stations.map((station) => station.name.trim());
  const config: MachineConfig = {
    id: design.config.id,
    name: design.config.name,
    stations: names,
    actuators: stations.flatMap((station) => station.actuators.map((actuator) => {
      const normalized = { ...cloneActuator(actuator), station: station.name.trim() };
      if (normalized.kind === 'rotary') {
        delete normalized.travelMm;
        delete normalized.travelSource;
        normalized.rotationRangeDeg ??= DEFAULT_ROTATION_RANGE_DEG;
      } else {
        delete normalized.rotationRangeDeg;
        delete normalized.rotationRangeSource;
      }
      return normalized;
    })),
    sensors: stations.flatMap((station) =>
      station.sensors.map((sensor) => ({ ...cloneSensor(sensor), station: station.name.trim() })))
  };
  // 几何推导输入（形态 id / 输送参数）不是工位派生的，但重建 config 时必须原样带上：
  // 少一个字段就会被 withStations 判成「配置变了」而清掉手工二维布局。
  // 字段顺序与 synth 产出的 config 保持一致（下游用 JSON.stringify 比对配置）。
  if (design.config.formId !== undefined) config.formId = design.config.formId;
  if (design.config.conveyor !== undefined) config.conveyor = { ...design.config.conveyor };
  return config;
}

export function pointsFromConfig(config: MachineConfig): string[] {
  const seen = new Set<string>();
  const points: string[] = [];
  const add = (point: string | undefined): void => {
    if (!point) return;
    const key = point.trim().toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    points.push(point.trim());
  };
  for (const actuator of config.actuators) {
    add(actuator.extendPoint);
    add(actuator.retractPoint);
    add(actuator.gripPoint);
    add(actuator.point);
  }
  for (const sensor of config.sensors) add(sensor.point);
  return points;
}

export function withStations(draft: DesignDraft, stations: StationDraft[], now: Date = new Date()): DesignDraft {
  const identityCounts = new Map<string, number>();
  for (const station of stations) identityCounts.set(station.id, (identityCounts.get(station.id) ?? 0) + 1);
  const duplicateIdentities = new Set([...identityCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const normalizedStations = stations.map((station) => ({
    ...station,
    id: !station.id || duplicateIdentities.has(station.id) ? createStationIdentity() : station.id
  }));
  const config = draft.design ? configFromStations(draft.design, normalizedStations) : null;
  const stationIdentities = normalizedStations.map((station) => station.id);
  const designConfigChanged = Boolean(draft.design && config && JSON.stringify(draft.design.config) !== JSON.stringify(config));
  const withoutCycleInputs = (items: readonly StationDraft[]): unknown[] => items.map(({ cycleTime: _cycleTime, ...station }) => station);
  const stationsChanged = JSON.stringify(withoutCycleInputs(draft.stations)) !== JSON.stringify(withoutCycleInputs(normalizedStations)) || designConfigChanged;
  const next: DesignDraft = {
    ...draft,
    stations: normalizedStations,
    ...(stationsChanged ? { placements: [] } : {}),
    updatedAt: shanghaiIso(now)
  };
  if (stationsChanged) delete next.layoutOverlapConfirmationFingerprint;
  if (draft.design && config) {
    const updatedDesign: MachineDesign = {
      ...draft.design,
      config,
      stationIdentities,
      points: pointsFromConfig(config)
    };
    const resolution = normalizeStationGeometryLayout(updatedDesign.stationGeometryLayout, config.stations, stationIdentities);
    if (resolution.layout) updatedDesign.stationGeometryLayout = resolution.layout;
    else delete updatedDesign.stationGeometryLayout;
    if (resolution.warning) {
      updatedDesign.stationGeometryWarning = resolution.warning;
      next.stationIdentityNotice = resolution.warning;
    } else if (draft.design.stationGeometryWarning) {
      updatedDesign.stationGeometryWarning = draft.design.stationGeometryWarning;
      next.stationIdentityNotice = draft.stationIdentityNotice ?? draft.design.stationGeometryWarning;
    } else if (draft.stationIdentityNotice) {
      next.stationIdentityNotice = draft.stationIdentityNotice;
    } else {
      delete updatedDesign.stationGeometryWarning;
      delete next.stationIdentityNotice;
    }
    if (duplicateIdentities.size > 0) {
      const warning = '检测到复制工位共用了同一身份；为避免偏移错绑，重复身份已全部重置，相关旧偏移已清除。';
      updatedDesign.stationGeometryWarning = warning;
      next.stationIdentityNotice = warning;
    } else if (normalizedStations.length > draft.stations.length) {
      next.stationIdentityNotice = '新增工位已分配独立身份；现有工位偏移按身份保留，新工位从生成器原点开始。';
    } else if (normalizedStations.length < draft.stations.length && !resolution.warning) {
      next.stationIdentityNotice = '已删除工位；其他工位偏移按稳定身份保留。';
    }
    next.design = designConfigChanged ? syncDesignBom(updatedDesign) : updatedDesign;
  }
  return next;
}

export function withPlacements(draft: DesignDraft, placements: Placement[], now: Date = new Date()): DesignDraft {
  const next = { ...draft, placements, updatedAt: shanghaiIso(now) };
  delete next.layoutOverlapConfirmationFingerprint;
  return next;
}

export function withCandidates(
  draft: DesignDraft,
  candidates: MachineDesign[],
  now: Date = new Date()
): DesignDraft {
  const limitedCandidates = candidates.slice(0, 3);
  const identityBoundCandidates = limitedCandidates.map((candidate) => {
    const bound: MachineDesign = {
      ...candidate,
      stationIdentities: Array.from({ length: candidate.config.stations.length }, () => createStationIdentity())
    };
    delete bound.stationGeometryLayout;
    delete bound.stationGeometryWarning;
    return bound;
  });
  const next: DesignDraft = {
    ...draft,
    candidates: identityBoundCandidates,
    placements: [],
    updatedAt: shanghaiIso(now)
  };
  delete next.layoutOverlapConfirmationFingerprint;
  delete next.selectedIndex;
  delete next.design;
  return next;
}

/** 暂存需求表单，不使当前方案、工位或布局失效；恢复输入到原需求时自动清除待应用值。 */
export function withPendingBrief(draft: DesignDraft, brief: MachineBriefInput, now: Date = new Date()): DesignDraft {
  const next: DesignDraft = { ...draft, updatedAt: shanghaiIso(now) };
  if (JSON.stringify(brief) === JSON.stringify(draft.brief)) {
    delete next.pendingBrief;
  } else {
    next.pendingBrief = { ...brief, footprint: brief.footprint ? { ...brief.footprint } : null };
  }
  return next;
}

/** 显式应用需求：旧候选、主方案和二维布局失效；已有编辑仅尽力合并，偏移不会跨新身份迁移。 */
export function withBrief(draft: DesignDraft, brief: MachineBriefInput, now: Date = new Date()): DesignDraft {
  const hadGeometryOffsets = (draft.design?.stationGeometryLayout?.offsets.length ?? 0) > 0;
  const next: DesignDraft = {
    ...draft,
    brief: { ...brief, footprint: brief.footprint ? { ...brief.footprint } : null },
    step: 1,
    placements: [],
    updatedAt: shanghaiIso(now)
  };
  if (hadGeometryOffsets) {
    next.stationIdentityNotice = '需求已应用并将重新计算；旧几何偏移无法证明属于新方案中的同一实体，不会按名称或序号迁移，请在新方案中重新定位。';
  }
  delete next.layoutOverlapConfirmationFingerprint;
  delete next.candidates;
  delete next.selectedIndex;
  delete next.design;
  delete next.pendingBrief;
  return next;
}

export function selectCandidate(draft: DesignDraft, index: 0 | 1 | 2, now: Date = new Date()): DesignDraft {
  const design = draft.candidates?.[index];
  if (!design) throw new Error(`候选 ${index + 1} 不存在`);
  const next: DesignDraft = {
    ...draft,
    selectedIndex: index,
    design,
    stations: stationsFromDesign(design),
    placements: [],
    updatedAt: shanghaiIso(now)
  };
  delete next.layoutOverlapConfirmationFingerprint;
  return next;
}

function sanitizeBrief(value: unknown): MachineBriefInput | null {
  if (!isRecord(value)) return null;
  const process = value.process;
  const incoming = value.incoming;
  const load = value.load;
  const voltage = value.voltage;
  if (typeof value.name !== 'string' || !PROCESSES.has(process as DesignProcess) ||
      !INCOMING.has(incoming as IncomingForm) || !LOADING.has(load as LoadingMethod) ||
      (voltage !== '220VAC' && voltage !== '380VAC') || typeof value.cyclePerMin !== 'number' || !Number.isFinite(value.cyclePerMin)) {
    return null;
  }
  const rawStations = value.stations;
  const stations = rawStations === null || rawStations === undefined
    ? null
    : typeof rawStations === 'number' && Number.isFinite(rawStations)
      ? rawStations
      : null;
  let footprint: DesignFootprint | null = null;
  if (isRecord(value.footprint) && typeof value.footprint.lengthMm === 'number' && Number.isFinite(value.footprint.lengthMm) &&
      typeof value.footprint.widthMm === 'number' && Number.isFinite(value.footprint.widthMm)) {
    footprint = { lengthMm: value.footprint.lengthMm, widthMm: value.footprint.widthMm };
  }
  const brand = typeof value.brand === 'string' && value.brand.trim() ? value.brand.trim() : null;
  return {
    name: value.name,
    incoming: incoming as IncomingForm,
    process: process as DesignProcess,
    cyclePerMin: value.cyclePerMin,
    stations,
    load: load as LoadingMethod,
    footprint,
    voltage,
    brand
  };
}

function sanitizeStations(value: unknown): StationDraft[] | null {
  if (!Array.isArray(value)) return null;
  const stations: StationDraft[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.name !== 'string') return null;
    if (!Array.isArray(raw.actuators) || !Array.isArray(raw.sensors)) return null;
    const actuators = raw.actuators.filter((item): item is ActuatorConfig =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' &&
      (item.kind === 'cylinder' || item.kind === 'gripper' || item.kind === 'rotary') &&
      typeof item.station === 'string' &&
      (item.travelMm === undefined || (typeof item.travelMm === 'number' && Number.isFinite(item.travelMm) &&
        item.travelMm >= MIN_ACTUATOR_TRAVEL_MM && item.travelMm <= MAX_ACTUATOR_TRAVEL_MM)) &&
      (item.travelSource === undefined || (item.kind !== 'rotary' && item.travelSource === 'engineer-input' && item.travelMm !== undefined)) &&
      (item.rotationRangeDeg === undefined || (typeof item.rotationRangeDeg === 'number' && Number.isFinite(item.rotationRangeDeg) &&
        item.rotationRangeDeg >= MIN_ROTATION_RANGE_DEG && item.rotationRangeDeg <= MAX_ROTATION_RANGE_DEG)) &&
      (item.rotationRangeSource === undefined || (item.kind === 'rotary' && item.rotationRangeSource === 'engineer-input' && item.rotationRangeDeg !== undefined)) &&
      (item.kind === 'rotary' || (item.rotationRangeDeg === undefined && item.rotationRangeSource === undefined)));
    const sensors = raw.sensors.filter((item): item is SensorConfig =>
      isRecord(item) && typeof item.point === 'string' && typeof item.station === 'string' &&
      typeof item.part === 'string');
    if (actuators.length !== raw.actuators.length || sensors.length !== raw.sensors.length) return null;
    const cycleTime = isRecord(raw.cycleTime) && typeof raw.cycleTime.seconds === 'number' && Number.isFinite(raw.cycleTime.seconds) &&
      raw.cycleTime.source === 'engineer-input' && raw.cycleTime.verification === 'pending-measurement'
      ? {
          seconds: raw.cycleTime.seconds,
          sharedTimeConfirmed: raw.cycleTime.sharedTimeConfirmed === true,
          source: 'engineer-input' as const,
          verification: 'pending-measurement' as const
        }
      : null;
    stations.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `station-${index + 1}`,
      name: raw.name,
      actuators: actuators.map(cloneActuator),
      sensors: sensors.map(cloneSensor),
      ...(Object.hasOwn(raw, 'cycleTime') ? { cycleTime } : {})
    });
  }
  return stations;
}

function sanitizePlacements(value: unknown): Placement[] | null {
  if (!Array.isArray(value)) return null;
  const placements: Placement[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.partId !== 'string' ||
        typeof raw.model !== 'string' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) ||
        !finitePositive(raw.w) || !finitePositive(raw.h)) {
      return null;
    }
    const placement: Placement = {
      id: raw.id,
      partId: raw.partId,
      model: raw.model,
      x: Number(raw.x),
      y: Number(raw.y),
      w: Number(raw.w),
      h: Number(raw.h)
    };
    if (typeof raw.railId === 'string') placement.railId = raw.railId;
    if (typeof raw.tag === 'string') placement.tag = raw.tag;
    if (typeof raw.note === 'string') placement.note = raw.note;
    placements.push(placement);
  }
  return placements;
}

function hasPersistedGeometryOffsets(value: unknown): boolean {
  return isRecord(value) && isRecord(value.stationGeometryLayout) && Array.isArray(value.stationGeometryLayout.offsets) &&
    value.stationGeometryLayout.offsets.length > 0;
}

function bindParsedDraftStations(
  stations: StationDraft[],
  rawDesign: Record<string, unknown>,
  design: MachineDesign
): { stations: StationDraft[]; design: MachineDesign; notice?: string } {
  const count = design.config.stations.length;
  const namesAlign = stations.length === count && stations.every((station, index) => station.name.trim() === design.config.stations[index]);
  const sourceIdentitiesValid = isStationIdentityList(rawDesign.stationIdentities, count);
  const stationIds = stations.map((station) => station.id);
  const rawIdentities = rawDesign.stationIdentities as string[] | undefined;
  const identitiesAlign = sourceIdentitiesValid && stationIds.every((identity, index) => identity === rawIdentities?.[index]);
  if (namesAlign && identitiesAlign) return { stations, design };

  // 旧草稿的 station-N 以及名称/顺序都不能证明工位连续性；创建全新身份，并清除任何可能错绑的偏移。
  const reboundStations = stations.map((station) => ({ ...station, id: createStationIdentity() }));
  const config = configFromStations(design, reboundStations);
  const rebound: MachineDesign = {
    ...design,
    config,
    stationIdentities: reboundStations.map((station) => station.id),
    points: pointsFromConfig(config)
  };
  delete rebound.stationGeometryLayout;
  const hadOffsets = hasPersistedGeometryOffsets(rawDesign);
  const notice = hadOffsets
    ? '草稿工位与保存的稳定身份无法可靠对应；未按名称或序号猜测，已清除全部几何偏移，请重新定位。'
    : !namesAlign
      ? '草稿工位列表与保存设计顺序不一致；已重新绑定当前草稿并建立新身份，未迁移任何几何偏移。'
      : design.stationGeometryWarning;
  if (notice) rebound.stationGeometryWarning = notice;
  else delete rebound.stationGeometryWarning;
  return { stations: reboundStations, design: rebound, ...(notice ? { notice } : {}) };
}

function parseDraftDesign(raw: Record<string, unknown>, allowIncompleteConfig = true): MachineDesign | null {
  // Keep this renderer-safe: machine/store.ts also imports node:fs and must not enter the UI bundle.
  // The full project/Agent path still uses validateMachineDesign; draft recovery only needs a safe config
  // snapshot plus strict, fail-closed normalization of station identities and offsets.
  if (!isRecord(raw.config) || typeof raw.config.id !== 'string' || !Array.isArray(raw.config.stations) ||
      raw.config.stations.some((name) => typeof name !== 'string')) return null;
  let config = raw.config as unknown as MachineConfig;
  try {
    config = validateMachineConfig(raw.config);
  } catch {
    if (!allowIncompleteConfig) return null;
  }
  const identityMapValid = isStationIdentityList(raw.stationIdentities, config.stations.length);
  const identities = stationIdentitiesFor(config.id, config.stations.length, raw.stationIdentities);
  const design = { ...raw, config, stationIdentities: identities } as unknown as MachineDesign;
  if (!allowIncompleteConfig && (!Array.isArray(raw.points) || !isRecord(raw.bomDraft) || !Array.isArray(raw.bomDraft.items) ||
      !Array.isArray(raw.warnings) || !Array.isArray(raw.assumptions))) return null;
  if (raw.stationGeometryLayout !== undefined) {
    if (!identityMapValid && isRecord(raw.stationGeometryLayout) && (raw.stationGeometryLayout.schemaVersion === 2 || raw.stationGeometryLayout.schemaVersion === 3)) {
      delete design.stationGeometryLayout;
      design.stationGeometryWarning = '稳定工位身份映射缺失或重复，无法安全关联已有偏移；已清除全部偏移，请重新定位工位。';
      return design;
    }
    try {
      const layout = normalizeStationGeometryLayout(raw.stationGeometryLayout, config.stations, identities);
      if (layout.layout) design.stationGeometryLayout = layout.layout;
      else delete design.stationGeometryLayout;
      if (layout.warning) design.stationGeometryWarning = layout.warning;
    } catch {
      delete design.stationGeometryLayout;
      design.stationGeometryWarning = '草稿几何偏移格式或身份映射无效；未猜测工位对应关系，已清除偏移，请重新定位。';
    }
  } else if (!identityMapValid && raw.stationIdentities !== undefined) {
    design.stationGeometryWarning = '稳定工位身份映射无效；已为当前配置建立新身份，请检查几何平移。';
  }
  return design;
}

/**
 * 草稿 JSON 解析。任何结构损坏都回落到全新第 1 步，避免半损坏状态把
 * 向导带到一个无法继续的步骤；稳定身份不一致时保留编辑内容，但清除不可信偏移。
 */
export function parseDesignDraft(value: unknown, now: Date = new Date()): DesignDraft {
  if (!isRecord(value) || value.version !== 1) return initialDraft(now);
  const step = value.step;
  if (!DESIGN_STEPS.includes(step as DesignStep)) return initialDraft(now);
  const brief = sanitizeBrief(value.brief);
  const pendingBrief = value.pendingBrief === undefined ? undefined : sanitizeBrief(value.pendingBrief);
  const stations = sanitizeStations(value.stations);
  const placements = sanitizePlacements(value.placements);
  if (!brief || (value.pendingBrief !== undefined && !pendingBrief) || !stations || !placements || typeof value.updatedAt !== 'string') return initialDraft(now);
  let candidates: MachineDesign[] | undefined;
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates) || value.candidates.length !== 3 ||
        value.candidates.some((item) => !isRecord(item))) {
      return initialDraft(now);
    }
    try {
      candidates = value.candidates.map((item) => {
        const design = parseDraftDesign(item, false);
        if (!design) throw new Error('候选设计无效');
        return design;
      });
    } catch {
      return initialDraft(now);
    }
  }
  const selected = value.selectedIndex;
  const selectedIndex = selected === 0 || selected === 1 || selected === 2 ? selected : undefined;
  let design: MachineDesign | undefined;
  let parsedStations = stations;
  let stationIdentityNotice = typeof value.stationIdentityNotice === 'string' && value.stationIdentityNotice.trim()
    ? value.stationIdentityNotice.trim().slice(0, 1000)
    : undefined;
  if (isRecord(value.design)) {
    try {
      design = parseDraftDesign(value.design) ?? undefined;
      if (!design) return initialDraft(now);
      const rebound = bindParsedDraftStations(stations, value.design, design);
      parsedStations = rebound.stations;
      design = rebound.design;
      stationIdentityNotice = rebound.notice ?? design.stationGeometryWarning ?? stationIdentityNotice;
    } catch {
      return initialDraft(now);
    }
  }
  const draft: DesignDraft = {
    version: 1,
    step: step as DesignStep,
    brief,
    ...(pendingBrief ? { pendingBrief } : {}),
    ...(stationIdentityNotice ? { stationIdentityNotice } : {}),
    stations: parsedStations,
    placements,
    updatedAt: value.updatedAt
  };
  if (typeof value.layoutOverlapConfirmationFingerprint === 'string' &&
      value.layoutOverlapConfirmationFingerprint === placementSnapshotFingerprint(placements)) {
    draft.layoutOverlapConfirmationFingerprint = value.layoutOverlapConfirmationFingerprint;
  }
  if (candidates) draft.candidates = candidates;
  if (selectedIndex !== undefined) draft.selectedIndex = selectedIndex;
  if (design) draft.design = design;
  if ((step as number) >= 2 && (!candidates || candidates.length !== 3)) return initialDraft(now);
  if ((step as number) >= 3 && (!design || selectedIndex === undefined)) return initialDraft(now);
  if ((step as number) >= 5 && !design) return initialDraft(now);
  return draft;
}

function normalizedPoint(point: string): string {
  return point.trim().toUpperCase();
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 每一步的中文校验错误；空数组表示可前进。 */
export function validateStep(draft: DesignDraft): string[] {
  const errors: string[] = [];
  const brief = draft.brief;
  if (!nonEmpty(brief.name)) errors.push('产品/机型名称不能为空');
  if (!PROCESSES.has(brief.process)) errors.push('请选择有效工艺类型');
  if (!finitePositive(brief.cyclePerMin)) errors.push('目标产能必须大于 0 件/分钟');
  if (brief.stations !== null && (!Number.isInteger(brief.stations) || brief.stations < 1 || brief.stations > 12)) {
    errors.push('期望工位数必须是 1–12 的整数，或留空自动推荐');
  }
  if (brief.footprint && (!finitePositive(brief.footprint.lengthMm) || !finitePositive(brief.footprint.widthMm))) {
    errors.push('占地长和宽必须大于 0 mm，或同时留空');
  }
  if (!INCOMING.has(brief.incoming)) errors.push('请选择来料形式');
  if (!LOADING.has(brief.load)) errors.push('请选择上下料方式');
  if (brief.voltage !== '220VAC' && brief.voltage !== '380VAC') errors.push('请选择供电制式');

  if (draft.step >= 2) {
    const candidates = draft.candidates ?? [];
    if (candidates.length !== 3) errors.push('方案对比必须有 3 个候选');
    const ids = new Set(candidates.map((candidate) => candidate.form?.id ?? ''));
    if (candidates.length === 3 && ids.size !== 3) errors.push('3 个候选的整机形态必须互不相同');
    if (draft.selectedIndex === undefined || !candidates[draft.selectedIndex]) errors.push('请选择一个候选方案作为主方案');
    if (!draft.design) errors.push('尚未生成主方案');
  }

  if (draft.step >= 3) {
    if (draft.stations.length === 0) errors.push('至少需要 1 个工位');
    const stationNames = draft.stations.map((station) => station.name.trim());
    if (stationNames.some((name) => !name)) errors.push('工位名称不能为空');
    if (new Set(stationNames).size !== stationNames.length) errors.push('工位名称不能重复');
    const stationIds = draft.stations.map((station) => station.id);
    if (stationIds.some((id) => !id.trim()) || new Set(stationIds).size !== stationIds.length) {
      errors.push('工位稳定身份缺失或重复；请勿复制旧身份，重新添加工位以生成独立身份');
    }
    const points = new Set<string>();
    for (const station of draft.stations) {
      for (const actuator of station.actuators) {
        if (!actuator.name.trim()) errors.push(`工位「${station.name}」的执行机构名称不能为空`);
        if (actuator.kind === 'rotary') {
          if (actuator.travelSource !== undefined || actuator.rotationRangeSource === 'engineer-input' && actuator.rotationRangeDeg === undefined ||
              actuator.rotationRangeDeg !== undefined && (!Number.isFinite(actuator.rotationRangeDeg) || actuator.rotationRangeDeg < MIN_ROTATION_RANGE_DEG || actuator.rotationRangeDeg > MAX_ROTATION_RANGE_DEG)) {
            errors.push(`工位「${station.name}」的执行机构「${actuator.name}」旋转分度角必须是 ${MIN_ROTATION_RANGE_DEG}–${MAX_ROTATION_RANGE_DEG}° 的有限数，且不能沿用直线行程来源`);
          }
        } else if (actuator.rotationRangeDeg !== undefined || actuator.rotationRangeSource !== undefined) {
          errors.push(`工位「${station.name}」的执行机构「${actuator.name}」不能携带旋转轴分度角`);
        } else if (actuator.travelSource === 'engineer-input' && actuator.travelMm === undefined ||
            actuator.travelMm !== undefined && (!Number.isFinite(actuator.travelMm) || actuator.travelMm < MIN_ACTUATOR_TRAVEL_MM || actuator.travelMm > MAX_ACTUATOR_TRAVEL_MM)) {
          errors.push(`工位「${station.name}」的执行机构「${actuator.name}」行程必须是 ${MIN_ACTUATOR_TRAVEL_MM}–${MAX_ACTUATOR_TRAVEL_MM} mm 的有限数`);
        }
        // 直线轴（气缸/夹爪借 point 表达单点动作）不能标成「旋转」，否则报错文案会误导
        const pointLabel = actuator.kind === 'rotary' ? '旋转' : '动作';
        for (const [label, point] of [
          ['伸出', actuator.extendPoint],
          ['缩回', actuator.retractPoint],
          ['夹紧', actuator.gripPoint],
          [pointLabel, actuator.point]
        ] as const) {
          if (!point) continue;
          const key = normalizedPoint(point);
          if (points.has(key)) errors.push(`点位「${point}」重复（${station.name}·${actuator.name} ${label}）`);
          points.add(key);
        }
      }
      for (const sensor of station.sensors) {
        if (!sensor.point.trim()) errors.push(`工位「${station.name}」的传感器点位不能为空`);
        const key = normalizedPoint(sensor.point);
        if (points.has(key)) errors.push(`点位「${sensor.point}」重复（${station.name} 传感器）`);
        points.add(key);
      }
    }
  }

  if (draft.step >= 4) {
    if (draft.placements.filter((placement) => placement.id.startsWith('station:')).length === 0) {
      errors.push('布局至少放置 1 个工位');
    }
    if (findOverlaps(draft.placements).length > 0 &&
        draft.layoutOverlapConfirmationFingerprint !== placementSnapshotFingerprint(draft.placements)) {
      errors.push('布局存在二维重叠冲突，请核对冲突对象并确认当前布局后再继续');
    }
  }
  return [...new Set(errors)];
}

export function canAdvance(draft: DesignDraft): boolean {
  return validateStep(draft).length === 0;
}

/** 推进到下一步；当前步校验失败时抛出中文错误，调用方应先展示 validateStep。 */
export function nextStep(draft: DesignDraft, now: Date = new Date()): DesignDraft {
  const errors = validateStep(draft);
  if (errors.length > 0) throw new Error(errors.join('；'));
  if (draft.step >= 5) return draft;
  return { ...draft, step: (draft.step + 1) as DesignStep, updatedAt: shanghaiIso(now) };
}

export function prevStep(draft: DesignDraft, now: Date = new Date()): DesignDraft {
  if (draft.step <= 1) return draft;
  return { ...draft, step: (draft.step - 1) as DesignStep, updatedAt: shanghaiIso(now) };
}
