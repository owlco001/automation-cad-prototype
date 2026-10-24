import { normalizePointKey } from '../plcgen/io.ts';

// 边界说明：STEP 导入结果只包含几何/装配信息，不包含执行机构定义与运动学。
// 本文件描述的是联调原型的“点位 → 执行机构/工位”配置映射，不代表可从任意 STEP
// 自动推导机构类型、行程或轴关系。后续若接入机器人/伺服模型，需要额外的运动学数据源。

export interface ActuatorConfig {
  id: string;
  name: string;
  kind: 'cylinder' | 'gripper' | 'rotary';
  station: string;
  extendPoint?: string;
  retractPoint?: string;
  gripPoint?: string;
  /** 旋转轴的驱动点位；true 时转到 90°，false 时回零。 */
  point?: string;
  travelMm?: number;
  durationMs?: number;
  /** 场景布局偏移；相对所属工位基座中心，单位为场景单位。 */
  position?: [number, number, number];
}

export interface SensorConfig {
  point: string;
  station: string;
  part: string;
  color?: string;
}

export interface MachineConfig {
  id: string;
  name: string;
  stations: string[];
  actuators: ActuatorConfig[];
  sensors: SensorConfig[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填参数：机型配置.${label}`);
  }
  return value.trim();
}

function optionalString(record: UnknownRecord, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`机型配置 ${label} 必须是非空字符串`);
  }
  return value.trim();
}

function positiveNumber(value: unknown, fallback: number, label: string): number {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} 必须大于 0`);
  }
  return number;
}

function readPosition(value: unknown, label: string): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error(`${label} position 必须是三个有限数字`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function validateMachineConfig(value: unknown): MachineConfig {
  if (!isRecord(value)) throw new Error('机型配置必须是对象');

  if (!Array.isArray(value.stations) || value.stations.length === 0) {
    throw new Error('缺少必填参数：机型配置.stations');
  }
  const stations = value.stations.map((station, index) => {
    if (typeof station !== 'string' || station.trim() === '') {
      throw new Error(`机型配置 stations[${index}] 必须是非空字符串`);
    }
    return station.trim();
  });
  if (new Set(stations).size !== stations.length) throw new Error('机型配置 stations 存在重复工位');

  if (!Array.isArray(value.actuators) || value.actuators.length === 0) {
    throw new Error('缺少必填参数：机型配置.actuators');
  }
  if (!Array.isArray(value.sensors)) throw new Error('缺少必填参数：机型配置.sensors');

  const stationSet = new Set(stations);
  const pointSet = new Set<string>();
  const claimPoint = (point: string | undefined, source: string): void => {
    if (point === undefined) return;
    const key = normalizePointKey(point);
    if (pointSet.has(key)) throw new Error(`机型配置点位 ${point} 重复或与已有点位地址别名冲突（${source}）`);
    pointSet.add(key);
  };

  const actuators = value.actuators.map((raw, index): ActuatorConfig => {
    if (!isRecord(raw)) throw new Error(`机型配置 actuators[${index}] 必须是对象`);
    const id = requiredString(raw, 'id', `actuators[${index}].id`);
    const name = requiredString(raw, 'name', `actuators[${index}].name`);
    const kind = raw.kind;
    if (kind !== 'cylinder' && kind !== 'gripper' && kind !== 'rotary') {
      throw new Error(`执行机构「${id}」kind 必须是 cylinder、gripper 或 rotary`);
    }
    const station = requiredString(raw, 'station', `actuators[${index}].station`);
    if (!stationSet.has(station)) throw new Error(`执行机构「${id}」引用了未定义工位「${station}」`);

    const extendPoint = optionalString(raw, 'extendPoint', `执行机构「${id}」extendPoint`);
    const retractPoint = optionalString(raw, 'retractPoint', `执行机构「${id}」retractPoint`);
    const gripPoint = optionalString(raw, 'gripPoint', `执行机构「${id}」gripPoint`);
    const point = optionalString(raw, 'point', `执行机构「${id}」point`);
    claimPoint(extendPoint, `执行机构 ${id} extendPoint`);
    claimPoint(retractPoint, `执行机构 ${id} retractPoint`);
    claimPoint(gripPoint, `执行机构 ${id} gripPoint`);
    claimPoint(point, `执行机构 ${id} point`);

    const normalized: ActuatorConfig = {
      id,
      name,
      kind,
      station,
      travelMm: positiveNumber(raw.travelMm, 40, `执行机构「${id}」travelMm`),
      durationMs: positiveNumber(raw.durationMs, 400, `执行机构「${id}」durationMs`)
    };
    if (extendPoint !== undefined) normalized.extendPoint = extendPoint;
    if (retractPoint !== undefined) normalized.retractPoint = retractPoint;
    if (gripPoint !== undefined) normalized.gripPoint = gripPoint;
    if (point !== undefined) normalized.point = point;
    const position = readPosition(raw.position, `执行机构「${id}」`);
    if (position !== undefined) normalized.position = position;
    return normalized;
  });

  const sensors = value.sensors.map((raw, index): SensorConfig => {
    if (!isRecord(raw)) throw new Error(`机型配置 sensors[${index}] 必须是对象`);
    const point = requiredString(raw, 'point', `sensors[${index}].point`);
    const station = requiredString(raw, 'station', `sensors[${index}].station`);
    const part = requiredString(raw, 'part', `sensors[${index}].part`);
    if (!stationSet.has(station)) throw new Error(`传感器「${point}」引用了未定义工位「${station}」`);
    claimPoint(point, `传感器 ${point}`);
    const color = optionalString(raw, 'color', `传感器「${point}」color`);
    const normalized: SensorConfig = { point, station, part };
    if (color !== undefined) normalized.color = color;
    return normalized;
  });

  return {
    id: requiredString(value, 'id', 'id'),
    name: requiredString(value, 'name', 'name'),
    stations,
    actuators,
    sensors
  };
}

export function demoMachineConfig(): MachineConfig {
  const stations = ['上料', '压装', '锁付', '下料'];
  const sensorColors = ['#2dd4bf', '#60a5fa', '#f59e0b', '#a78bfa'];
  const actuators: ActuatorConfig[] = [];
  const sensors: SensorConfig[] = [];

  for (const [index, station] of stations.entries()) {
    const prefix = `station-${index + 1}`;
    const cylinderId = `${prefix}-cylinder`;
    const gripperId = `${prefix}-gripper`;
    const rotaryId = `${prefix}-rotary`;
    actuators.push(
      {
        id: cylinderId,
        name: `${station}气缸`,
        kind: 'cylinder',
        station,
        extendPoint: `Y${index}`,
        retractPoint: `Y${index + 4}`,
        travelMm: 40,
        durationMs: 400,
        position: [-0.72, 0.55, -0.38]
      },
      {
        id: gripperId,
        name: `${station}夹爪`,
        kind: 'gripper',
        station,
        gripPoint: `Y${index + 8}`,
        durationMs: 280,
        position: [0.05, 0.55, -0.38]
      },
      {
        id: rotaryId,
        name: `${station}旋转台`,
        kind: 'rotary',
        station,
        point: `Y${index + 12}`,
        durationMs: 520,
        position: [0.76, 0.65, 0.35]
      }
    );

    const parts: [string, string, string, string] = [cylinderId, gripperId, rotaryId, station];
    for (let offset = 0; offset < 4; offset += 1) {
      sensors.push({
        point: `X${index * 4 + offset}`,
        station,
        part: parts[offset] ?? station,
        color: sensorColors[index] ?? '#2dd4bf'
      });
    }
  }

  return validateMachineConfig({
    id: 'demo-4x3',
    name: '4 工位通用联调样机',
    stations,
    actuators,
    sensors
  });
}
