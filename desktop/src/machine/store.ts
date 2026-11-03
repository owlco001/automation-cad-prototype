// 机型方案落盘与校验：负责 MachineDesign 的结构校验、id 净化、BOM 行转换，
// 以及 userData/machine 下的最小文件读写。命令总线负责编排 3D/BOM/PLC 联动。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { dirname, join } from 'node:path';
import { validateMachineConfig, type MachineConfig } from '../commission/machine-config.ts';
import { assertDesign } from './validate.ts';
import { formKindUnsupportedIssue, isSupportedFormKind } from './validate.ts';
import type { MachineBomItem, MachineCycleEstimate, MachinePowerEstimate } from './synth.ts';
import { normalizeStationGeometryLayout, type StationGeometryLayout } from './station-layout.ts';
import { baselineStationIdentities, isStationIdentityList, type StationIdentity } from './station-identity.ts';
import type { PowerResult } from './power.ts';
import type { MachineCostEstimate } from './cost-model.ts';
import { MACHINE_FORMS, type MachineFormGeometry, type MachineFormSummary } from './forms.ts';

export interface NormalizedMachineDesign {
  config: MachineConfig;
  stationIdentities: StationIdentity[];
  stationGeometryLayout?: StationGeometryLayout;
  stationGeometryWarning?: string;
  points: string[];
  cycle?: MachineCycleEstimate;
  power?: MachinePowerEstimate;
  cost?: MachineCostEstimate;
  bomDraft?: { items: MachineBomItem[] };
  warnings: string[];
  assumptions: string[];
  form?: MachineFormSummary;
}

export interface MachineBomRow {
  name: string;
  model: string;
  qty: number;
  category: string;
  note?: string;
  source: 'machine-design';
  partId?: string;
  packId?: string;
  pendingSelection?: boolean;
}

export interface ActiveMachinePointer {
  schemaVersion: 1;
  machineId: string;
  name: string;
  file: string;
  appliedAt: string;
}

export interface StoredMachineDesign extends NormalizedMachineDesign {
  schemaVersion: 1;
  kind: 'machine-design';
  id: string;
  name: string;
  appliedAt: string;
}

const BOM_KIND_LABEL: Record<MachineBomItem['kind'], string> = {
  actuator: '执行机构',
  sensor: '传感器',
  electrical: '电气'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 列表字段归一化：接受 `string[]`，也接受 `{items: string[]}`。
 *
 * `{items,total,truncated}` 是 `agent/trim.ts` 给模型的裁剪形状（>20 条的列表会被裁成这样）。
 * 模型把裁剪后的方案原样回填时，这里按形状归一即可，不能因此整份方案被拒——
 * 裁剪只作用于「给模型的返回」，落盘数据永不裁剪：本函数不做任何截断，只做形状归一。
 */
function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : undefined;
  if (!list || list.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return list.map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 配置中的全部点位，按执行机构字段顺序、再按传感器顺序；大小写不敏感去重。 */
export function machineConfigPoints(config: MachineConfig): string[] {
  const points: string[] = [];
  for (const actuator of config.actuators) {
    for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
      if (point) points.push(point);
    }
  }
  for (const sensor of config.sensors) points.push(sensor.point);
  return uniqueStrings(points);
}

function parseMachineForm(value: unknown): MachineFormSummary {
  if (!isRecord(value)) throw new Error('design.form 必须是对象');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : '';
  if (!id) throw new Error('design.form.id 不能为空');
  if (!name) throw new Error('design.form.name 不能为空');
  if (!rationale) throw new Error('design.form.rationale 不能为空');
  const known = MACHINE_FORMS.find((form) => form.id === id);
  let stationRange: [number, number] | undefined;
  if (value.stationRange !== undefined) {
    const raw = value.stationRange;
    if (
      !Array.isArray(raw) || raw.length !== 2 ||
      !Number.isInteger(raw[0]) || !Number.isInteger(raw[1]) ||
      raw[0] < 1 || raw[1] > 12 || raw[0] > raw[1]
    ) {
      throw new Error('design.form.stationRange 必须是 1–12 内的 [min,max] 整数区间');
    }
    stationRange = [raw[0], raw[1]];
  }
  const range = stationRange ?? known?.stationRange ?? [1, 12];
  const rawDefault = value.defaultStations;
  const defaultStations = rawDefault === undefined
    ? known?.defaultStations ?? range[0]
    : rawDefault;
  if (
    typeof defaultStations !== 'number' || !Number.isInteger(defaultStations) ||
    defaultStations < range[0] || defaultStations > range[1]
  ) {
    throw new Error(`design.form.defaultStations 必须落在 stationRange ${range[0]}–${range[1]} 内`);
  }
  const rawMax = value.maxStations;
  const maxStations = rawMax === undefined
    ? known?.maxStations ?? range[1]
    : rawMax;
  if (typeof maxStations !== 'number' || !Number.isInteger(maxStations) || maxStations !== range[1]) {
    throw new Error(`design.form.maxStations 必须等于 stationRange 上限 ${range[1]}`);
  }
  const layouts = new Set(['single', 'linear', 'dial', 'parallel', 'cell']);
  const layout = layouts.has(String(value.layout))
    ? value.layout as MachineFormSummary['layout']
    : 'linear';
  const geometryRaw = isRecord(value.geometry) ? value.geometry : {};
  const rawKind = geometryRaw.kind;
  const inferredKind = String(value.layout) === 'dial' || id.startsWith('dial-')
    ? 'dial'
    : String(value.layout) === 'cell' || id.startsWith('dual-')
      ? 'dual'
      : String(value.layout) === 'parallel' || id.startsWith('gantry-')
        ? 'gantry'
        : 'linear';
  // 白名单来自 machine/validate.ts（MACHINE_FORM_GEOMETRY_KINDS），与 forms.ts 的
  // MachineFormGeometryKind 保持同一处定义：少列 conveyor 会让任何输送机方案被判非法。
  const kind = isSupportedFormKind(rawKind)
    ? rawKind as MachineFormGeometry['kind']
    : geometryRaw.kind === undefined
      ? inferredKind
      : null;
  if (kind === null) {
    throw new Error(formKindUnsupportedIssue().message);
  }
  const geometry: MachineFormGeometry = { kind };
  if (typeof geometryRaw.lanes === 'number' && Number.isInteger(geometryRaw.lanes) && geometryRaw.lanes > 0) {
    geometry.lanes = geometryRaw.lanes;
  }
  if (typeof geometryRaw.stationsPerLane === 'number' && Number.isInteger(geometryRaw.stationsPerLane) && geometryRaw.stationsPerLane > 0) {
    geometry.stationsPerLane = geometryRaw.stationsPerLane;
  }
  if (typeof geometryRaw.axes === 'number' && Number.isInteger(geometryRaw.axes) && geometryRaw.axes > 0) {
    geometry.axes = geometryRaw.axes;
  }
  if (geometryRaw.conveyor === 'belt' || geometryRaw.conveyor === 'chain') geometry.conveyor = geometryRaw.conveyor;
  if (geometryRaw.indexer === 'cam' || geometryRaw.indexer === 'dd') geometry.indexer = geometryRaw.indexer;
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`design.form.alternatives[${index}] 必须是对象`);
      const altId = typeof entry.id === 'string' ? entry.id.trim() : '';
      const altName = typeof entry.name === 'string' ? entry.name.trim() : '';
      const difference = typeof entry.difference === 'string' ? entry.difference.trim() : '';
      if (!altId || !altName || !difference) {
        throw new Error(`design.form.alternatives[${index}] 需要 id/name/difference`);
      }
      return { id: altId, name: altName, difference };
    })
    : [];
  const score = typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : 0;
  const warning = typeof value.warning === 'string' && value.warning.trim() ? value.warning.trim() : undefined;
  return {
    id,
    name,
    rationale,
    layout,
    stationRange: [range[0], range[1]],
    defaultStations,
    maxStations,
    geometry,
    score,
    alternatives,
    ...(warning ? { warning } : {})
  };
}

/**
 * 校验并归一化 Agent 返回的 MachineDesign。
 *
 * `validateMachineConfig` 已覆盖必填字段、工位存在、点位唯一等；这里补上
 * 工位/执行机构/传感器 id 唯一、传感器 part 引用、以及 design.points 与配置
 * 点位的一致性，避免“看起来有方案、实际点表引用不存在”。
 */
export function validateMachineDesign(value: unknown): NormalizedMachineDesign {
  if (!isRecord(value)) throw new Error('design 必须是对象');
  if (!isRecord(value.config)) throw new Error('design.config 必须是对象');
  // 方案落盘走严格绑定校验（外部 IO 映射才走 validateMachineConfig 的宽松模式）
  const config = assertDesign(value.config);
  const stationIdentityMapValid = isStationIdentityList(value.stationIdentities, config.stations.length);
  const stationIdentities = stationIdentityMapValid
    ? [...(value.stationIdentities as StationIdentity[])]
    : baselineStationIdentities(config.id, config.stations.length);
  let stationGeometryLayout: StationGeometryLayout | undefined;
  let stationGeometryWarning = typeof value.stationGeometryWarning === 'string' && value.stationGeometryWarning.trim()
    ? value.stationGeometryWarning.trim().slice(0, 1000)
    : undefined;
  if (value.stationGeometryLayout !== undefined) {
    if (!stationIdentityMapValid && isRecord(value.stationGeometryLayout) && (value.stationGeometryLayout.schemaVersion === 2 || value.stationGeometryLayout.schemaVersion === 3)) {
      stationGeometryWarning = '稳定工位身份映射缺失或重复，无法安全关联已有偏移；已清除全部偏移，请重新定位工位。';
    } else {
      const resolution = normalizeStationGeometryLayout(value.stationGeometryLayout, config.stations, stationIdentities);
      stationGeometryLayout = resolution.layout;
      if (resolution.warning) stationGeometryWarning = resolution.warning;
    }
  }
  if (!stationIdentityMapValid && value.stationIdentities !== undefined && value.stationGeometryLayout === undefined) {
    stationGeometryWarning = '稳定工位身份映射无效，已为当前配置建立新身份；请检查几何平移。';
  }

  // 执行机构 id 唯一、传感器 part 绑定已在 validateMachineConfig（machine/validate.ts）判定，
  // 这里不再自己跑一套规则，避免同一份方案在本文件与预检里结论不一致。

  const configPoints = machineConfigPoints(config);
  const pointSet = new Set(configPoints.map((point) => point.toUpperCase()));
  let points = configPoints;
  if (value.points !== undefined) {
    const declared = stringArray(value.points, 'design.points');
    if (declared.length === 0) throw new Error('design.points 不能为空');
    const declaredSet = new Set<string>();
    for (const point of declared) {
      const key = point.toUpperCase();
      if (declaredSet.has(key)) throw new Error(`设计点位重复：${point}`);
      declaredSet.add(key);
      if (!pointSet.has(key)) throw new Error(`设计点位引用缺失：配置中没有点位 ${point}`);
    }
    for (const point of configPoints) {
      if (!declaredSet.has(point.toUpperCase())) throw new Error(`设计点位引用缺失：${point} 未列入 design.points`);
    }
    points = declared;
  }

  let bomDraft: { items: MachineBomItem[] } | undefined;
  if (value.bomDraft !== undefined) {
    if (!isRecord(value.bomDraft) || !Array.isArray(value.bomDraft.items)) {
      throw new Error('design.bomDraft.items 必须是数组');
    }
    const items = value.bomDraft.items.map((raw, index): MachineBomItem => {
      if (!isRecord(raw)) throw new Error(`design.bomDraft.items[${index}] 必须是对象`);
      const kind = raw.kind;
      if (kind !== 'actuator' && kind !== 'sensor' && kind !== 'electrical') {
        throw new Error(`design.bomDraft.items[${index}].kind 必须是 actuator/sensor/electrical`);
      }
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) throw new Error(`design.bomDraft.items[${index}].name 不能为空`);
      const qty = raw.qty;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
        throw new Error(`design.bomDraft.items[${index}].qty 必须是正整数`);
      }
      const item: MachineBomItem = { kind, name, qty };
      if (typeof raw.note === 'string' && raw.note.trim()) item.note = raw.note.trim();
      if (typeof raw.model === 'string' && raw.model.trim()) item.model = raw.model.trim();
      if (typeof raw.partId === 'string' && raw.partId.trim()) item.partId = raw.partId.trim();
      if (typeof raw.packId === 'string' && raw.packId.trim()) item.packId = raw.packId.trim();
      const roles = new Set(['servo', 'cylinder', 'gripper', 'rotary', 'sensor', 'safety', 'plc', 'psu', 'valve', 'other']);
      if (typeof raw.role === 'string' && roles.has(raw.role)) item.role = raw.role as NonNullable<MachineBomItem['role']>;
      if (typeof raw.ratedW === 'number' && Number.isFinite(raw.ratedW) && raw.ratedW > 0) item.ratedW = raw.ratedW;
      if (raw.pendingSelection === true) item.pendingSelection = true;
      return item;
    });
    bomDraft = { items };
  }

  const warnings = stringArray(value.warnings, 'design.warnings');
  const assumptions = stringArray(value.assumptions, 'design.assumptions');
  const form = value.form === undefined ? undefined : parseMachineForm(value.form);

  const normalized: NormalizedMachineDesign = {
    config,
    stationIdentities,
    points,
    warnings,
    assumptions,
    ...(form ? { form } : {}),
    ...(stationGeometryLayout ? { stationGeometryLayout } : {}),
    ...(stationGeometryWarning ? { stationGeometryWarning } : {})
  };
  if (isRecord(value.cycle)) {
    const perMin = value.cycle.perMin;
    const secondsPerPiece = value.cycle.secondsPerPiece;
    const bottleneck = value.cycle.bottleneck;
    if (typeof perMin !== 'number' || !Number.isFinite(perMin) || perMin <= 0) {
      throw new Error('design.cycle.perMin 必须大于 0');
    }
    if (typeof secondsPerPiece !== 'number' || !Number.isFinite(secondsPerPiece) || secondsPerPiece <= 0) {
      throw new Error('design.cycle.secondsPerPiece 必须大于 0');
    }
    if (typeof bottleneck !== 'string' || !bottleneck.trim()) {
      throw new Error('design.cycle.bottleneck 不能为空');
    }
    const optionalNumber = (key: string): number | undefined => {
      const raw = value.cycle && typeof value.cycle === 'object'
        ? (value.cycle as Record<string, unknown>)[key]
        : undefined;
      return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    };
    const estimated = optionalNumber('estimatedSecondsPerPiece') ?? secondsPerPiece;
    const baseSeconds = optionalNumber('baseSeconds') ?? 0;
    const slowestActionSeconds = optionalNumber('slowestActionSeconds') ?? Math.max(0, estimated - baseSeconds);
    const requiredParallelStations = Math.max(1, Math.trunc(optionalNumber('requiredParallelStations') ?? 1));
    const stations = normalized.config.stations.length;
    const rawMode = (value.cycle as Record<string, unknown>).mode;
    const flowModes: MachineCycleEstimate['mode'][] = ['single', 'linear', 'dial', 'parallel', 'cell'];
    const mode: MachineCycleEstimate['mode'] = rawMode === 'line'
      ? 'linear'
      : flowModes.includes(rawMode as MachineCycleEstimate['mode'])
        ? rawMode as MachineCycleEstimate['mode']
        : 'linear';
    const stationSeconds = optionalNumber('stationSeconds') ?? estimated;
    const throughputPerMin = optionalNumber('throughputPerMin')
      ?? (stationSeconds > 0 ? Math.round((60 / stationSeconds) * 100) / 100 : 0);
    const rawCycle = value.cycle as Record<string, unknown>;
    const source = rawCycle.source;
    if (source !== undefined && source !== 'model-estimate' && source !== 'engineer-input') {
      throw new Error('design.cycle.source 必须是 model-estimate/engineer-input');
    }
    let stationCycleInputs: MachineCycleEstimate['stationCycleInputs'];
    if (rawCycle.stationCycleInputs !== undefined) {
      if (!Array.isArray(rawCycle.stationCycleInputs)) throw new Error('design.cycle.stationCycleInputs 必须是数组');
      const seenStationIds = new Set<string>();
      stationCycleInputs = rawCycle.stationCycleInputs.map((raw, index) => {
        if (!isRecord(raw)) throw new Error(`design.cycle.stationCycleInputs[${index}] 必须是对象`);
        const stationId = typeof raw.stationId === 'string' ? raw.stationId.trim() : '';
        const stationName = typeof raw.stationName === 'string' ? raw.stationName.trim() : '';
        if (!stationId || !stationName || typeof raw.seconds !== 'number' || !Number.isFinite(raw.seconds) ||
            raw.source !== 'engineer-input' || raw.verification !== 'pending-measurement') {
          throw new Error(`design.cycle.stationCycleInputs[${index}] 缺少有效工位、周期或来源标识`);
        }
        if (source === 'engineer-input' && raw.seconds <= 0) {
          throw new Error(`design.cycle.stationCycleInputs[${index}].seconds 必须大于 0`);
        }
        if (source === 'engineer-input' && raw.sharedTimeConfirmed !== true) {
          throw new Error(`design.cycle.stationCycleInputs[${index}].sharedTimeConfirmed 必须为 true`);
        }
        if (!normalized.config.stations.includes(stationName)) {
          throw new Error(`design.cycle.stationCycleInputs[${index}] 工位「${stationName}」不在当前配置中`);
        }
        if (seenStationIds.has(stationId)) throw new Error(`design.cycle.stationCycleInputs 工位 id 重复：${stationId}`);
        seenStationIds.add(stationId);
        return {
          stationId,
          stationName,
          seconds: raw.seconds,
          sharedTimeConfirmed: raw.sharedTimeConfirmed === true,
          source: 'engineer-input',
          verification: 'pending-measurement'
        };
      });
      if (stationCycleInputs.length > normalized.config.stations.length) {
        throw new Error('design.cycle.stationCycleInputs 数量不能超过配置工位数');
      }
    }
    if (source === 'engineer-input') {
      const inputNames = new Set(stationCycleInputs?.map((input) => input.stationName) ?? []);
      if (
        stationCycleInputs?.length !== normalized.config.stations.length ||
        inputNames.size !== normalized.config.stations.length ||
        normalized.config.stations.some((stationName) => !inputNames.has(stationName))
      ) {
        throw new Error('工程师输入节拍必须为全部配置工位提供有效且已确认口径的周期');
      }
    }
    normalized.cycle = {
      mode,
      ...(source ? { source } : {}),
      ...(stationCycleInputs ? { stationCycleInputs } : {}),
      perMin,
      secondsPerPiece,
      stationSeconds,
      throughputPerMin,
      partsPerMinute: throughputPerMin,
      estimatedSecondsPerPiece: estimated,
      baseSeconds,
      slowestStation: Math.max(1, Math.trunc(optionalNumber('slowestStation') ?? 1)),
      slowestActionSeconds,
      requiredParallelStations,
      requiredTotalStations: Math.trunc(optionalNumber('requiredTotalStations') ?? stations * requiredParallelStations),
      meetsTarget: value.cycle.meetsTarget === true
        || (throughputPerMin > 0 ? throughputPerMin >= perMin - 1e-9 : estimated <= secondsPerPiece),
      bottleneck: bottleneck.trim()
    };
  }
  if (isRecord(value.power)) {
    const va = value.power.va;
    if (typeof va !== 'number' || !Number.isFinite(va) || va < 0) {
      throw new Error('design.power.va 必须是非负数字');
    }
    const byGroup = Array.isArray(value.power.byGroup)
      ? value.power.byGroup.map((group, index) => {
        if (!isRecord(group)) throw new Error(`design.power.byGroup[${index}] 必须是对象`);
        const name = typeof group.name === 'string' ? group.name.trim() : '';
        const groupVa = group.va;
        if (!name || typeof groupVa !== 'number' || !Number.isFinite(groupVa) || groupVa < 0) {
          throw new Error(`design.power.byGroup[${index}] 名称或 va 不合法`);
        }
        return {
          name,
          count: typeof group.count === 'number' && Number.isFinite(group.count) ? group.count : 0,
          ratedW: typeof group.ratedW === 'number' && Number.isFinite(group.ratedW) ? group.ratedW : 0,
          va: groupVa
        };
      })
      : [];
    const totalVa = typeof value.power.totalVa === 'number' && Number.isFinite(value.power.totalVa)
      ? value.power.totalVa
      : va;
    const totalKw = typeof value.power.totalKw === 'number' && Number.isFinite(value.power.totalKw)
      ? value.power.totalKw
      : 0;
    normalized.power = {
      ...(value.power as unknown as PowerResult),
      va,
      totalVa,
      totalKw,
      byGroup
    };
  }
  if (isRecord(value.cost)) {
    const cost = value.cost as Record<string, unknown>;
    for (const key of ['material', 'electrical', 'labor', 'total', 'missingCount'] as const) {
      if (typeof cost[key] !== 'number' || !Number.isFinite(cost[key] as number) || (cost[key] as number) < 0) {
        throw new Error(`design.cost.${key} 必须是非负数字`);
      }
    }
    normalized.cost = cost as unknown as MachineCostEstimate;
  }
  if (bomDraft) normalized.bomDraft = bomDraft;
  return normalized;
}

/** 文件名净化：保留中英文/数字/._-，去掉路径分隔、控制字符与连续点。 */
export function sanitizeMachineId(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  let id = raw
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
  if (!id) id = 'machine';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) id = `machine-${id}`;
  return id;
}

export function machineDirectory(userDataRoot: string): string {
  return join(userDataRoot, 'machine');
}

export function machineDesignPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), `${sanitizeMachineId(machineId)}.json`);
}

export function machineBomDraftPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), sanitizeMachineId(machineId), 'bom-draft.csv');
}

/** 参数化几何产物目录：machine/<id>/（与 bom-draft.csv 同目录）。 */
export function machineGeometryPaths(userDataRoot: string, machineId: string): {
  json: string;
  stl: string;
  gltf: string;
  sidecar: string;
  solidsDir: string;
} {
  const dir = join(machineDirectory(userDataRoot), sanitizeMachineId(machineId));
  return {
    json: join(dir, 'geometry.json'),
    stl: join(dir, 'model.stl'),
    gltf: join(dir, 'model.gltf'),
    sidecar: join(dir, 'sidecar-assembly.json'),
    solidsDir: join(dir, 'solids')
  };
}

/** 读取任意文件为 base64（用于撤销快照，兼容二进制 STL/STEP）；不存在返回 null。 */
export function readBase64IfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path).toString('base64') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_BINARY_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function restoreBase64(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeBytes(path, Buffer.from(previous, 'base64'));
}

export function activeMachinePath(userDataRoot: string): string {
  return join(machineDirectory(userDataRoot), 'active.json');
}

export function readTextIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_TEXT_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function restoreText(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeText(path, previous);
}

export function readActivePointer(userDataRoot: string): ActiveMachinePointer | null {
  const text = readTextIfExists(activeMachinePath(userDataRoot));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const machineId = typeof parsed.machineId === 'string' ? sanitizeMachineId(parsed.machineId) : '';
    if (!machineId) return null;
    const name = typeof parsed.name === 'string' ? parsed.name : machineId;
    const appliedAt = typeof parsed.appliedAt === 'string' ? parsed.appliedAt : '';
    return {
      schemaVersion: 1,
      machineId,
      name,
      file: `machine/${machineId}.json`,
      appliedAt
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_ACTIVE_POINTER_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts' });
    return null;
  }
}

export function writeActivePointer(userDataRoot: string, pointer: ActiveMachinePointer): void {
  writeText(activeMachinePath(userDataRoot), `${JSON.stringify(pointer, null, 2)}\n`);
}

export function readStoredMachineDesign(userDataRoot: string, machineId: string): StoredMachineDesign | null {
  const text = readTextIfExists(machineDesignPath(userDataRoot, machineId));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const design = validateMachineDesign(parsed);
    return {
      ...design,
      schemaVersion: 1,
      kind: 'machine-design',
      id: sanitizeMachineId(typeof parsed.id === 'string' ? parsed.id : machineId),
      name: design.config.name,
      appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : ''
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_DESIGN_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts', machineId });
    return null;
  }
}

/**
 * 把已校验的机型方案写成 `machine/<id>.json` 并把 active 指针指过去，返回落盘文档。
 * 与 apply_machine_design 的落盘口径一致（同一份 JSON 缩进、同一个 active 指针形状），
 * 供机型库加载等「方案已经校验完、只剩写盘」的场景复用。
 */
export function writeStoredMachineDesign(
  userDataRoot: string,
  design: NormalizedMachineDesign,
  appliedAt: string = new Date().toISOString()
): StoredMachineDesign {
  const machineId = sanitizeMachineId(design.config.id);
  const stored: StoredMachineDesign = {
    ...design,
    config: { ...design.config, id: machineId },
    schemaVersion: 1,
    kind: 'machine-design',
    id: machineId,
    name: design.config.name,
    appliedAt
  };
  writeText(machineDesignPath(userDataRoot, machineId), `${JSON.stringify(stored, null, 2)}\n`);
  writeActivePointer(userDataRoot, {
    schemaVersion: 1,
    machineId,
    name: stored.name,
    file: `machine/${machineId}.json`,
    appliedAt
  });
  return stored;
}

export function readActiveMachineDesign(userDataRoot: string): StoredMachineDesign | null {
  const pointer = readActivePointer(userDataRoot);
  if (!pointer) return null;
  return readStoredMachineDesign(userDataRoot, pointer.machineId);
}


/** 用于幂等判断的稳定内容（不含 appliedAt，避免重复执行被误判为变更）。 */
export function machineDesignContent(design: NormalizedMachineDesign): string {
  return JSON.stringify({
    config: design.config,
    points: design.points,
    cycle: design.cycle ?? null,
    power: design.power ?? null,
    cost: design.cost ?? null,
    bomDraft: design.bomDraft ?? null,
    warnings: design.warnings,
    assumptions: design.assumptions,
    form: design.form ?? null,
    stationGeometryLayout: design.stationGeometryLayout ?? null
  });
}

export function buildMachineBomRows(design: NormalizedMachineDesign): MachineBomRow[] {
  const items = design.bomDraft?.items ?? [];
  return items.map((item): MachineBomRow => {
    const row: MachineBomRow = {
      name: item.name,
      model: item.model?.trim() || '模型待定',
      qty: item.qty,
      category: BOM_KIND_LABEL[item.kind],
      source: 'machine-design'
    };
    if (item.note) row.note = item.note;
    if (item.partId) row.partId = item.partId;
    if (item.packId) row.packId = item.packId;
    if (item.pendingSelection === true) row.pendingSelection = true;
    return row;
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const MACHINE_BOM_CSV_HEADER = ['序号', '名称', '型号', '数量', '分类', '来源包', '来源', '待选型', '备注'] as const;

export function renderMachineBomCsv(rows: readonly MachineBomRow[]): string {
  const lines = [
    [...MACHINE_BOM_CSV_HEADER].map(csvCell).join(','),
    ...rows.map((row, index) => [
      index + 1,
      row.name,
      row.model,
      row.qty,
      row.category,
      row.packId ?? '',
      row.source,
      row.pendingSelection ? '是' : '否',
      row.note ?? ''
    ].map(csvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

const BOM_KIND_BY_LABEL: Record<string, MachineBomItem['kind']> = {
  [BOM_KIND_LABEL.actuator]: 'actuator',
  [BOM_KIND_LABEL.sensor]: 'sensor',
  [BOM_KIND_LABEL.electrical]: 'electrical'
};

/** CSV 单元格解析：只处理 renderMachineBomCsv 会产出的引号转义（"" → "）。 */
function parseCsvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * `bom.csv` → `bomDraft.items` 的反向解析（机型库加载用，B4）。
 *
 * 列头以 `MACHINE_BOM_CSV_HEADER` 为准，按列名取数而不是按位置，列顺序将来变了也不会错位。
 * 已知损失：该 CSV 没有物料号/role/额定功率列，往返后 `partId` 无法复原（`run_cost_report`
 * 会按缺物料号处理，不会伪造型号）；`型号` 列是 `模型待定` 时按缺省处理。
 * 行结构不合法一律抛错，让调用方（`loadFromLibrary`）转成 `LIBRARY_INVALID_CONFIG`，
 * 不静默跳过行——少一行 BOM 比报错更难查。
 */
export function parseMachineBomCsv(text: string): MachineBomItem[] {
  const rows = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const headerLine = rows[0] ?? '';
  const header = parseCsvCells(headerLine).map((cell) => cell.trim());
  const columnIndex = (name: string): number => header.indexOf(name);
  for (const required of ['名称', '型号', '数量', '分类']) {
    if (columnIndex(required) < 0) throw new Error(`bom.csv 缺少必需列「${required}」`);
  }
  const cellOf = (cells: string[], name: string): string => {
    const index = columnIndex(name);
    return index >= 0 && index < cells.length ? (cells[index] ?? '').trim() : '';
  };
  const items: MachineBomItem[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rows[rowIndex];
    if (!line || !line.trim()) continue;
    const where = `bom.csv 第 ${rowIndex + 1} 行`;
    const cells = parseCsvCells(line);
    if (cells.length !== header.length) {
      throw new Error(`${where}列数不符（${cells.length} ≠ 表头 ${header.length}）`);
    }
    const name = cellOf(cells, '名称');
    if (!name) throw new Error(`${where}缺少名称`);
    const qty = Number(cellOf(cells, '数量'));
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`${where}数量必须是正整数`);
    const label = cellOf(cells, '分类');
    const kind = BOM_KIND_BY_LABEL[label];
    if (!kind) throw new Error(`${where}分类「${label}」不在执行机构/传感器/电气之内`);
    const item: MachineBomItem = { kind, name, qty };
    const model = cellOf(cells, '型号');
    if (model && model !== '模型待定') item.model = model;
    const packId = cellOf(cells, '来源包');
    if (packId) item.packId = packId;
    if (cellOf(cells, '待选型') === '是') item.pendingSelection = true;
    const note = cellOf(cells, '备注');
    if (note) item.note = note;
    items.push(item);
  }
  return items;
}
