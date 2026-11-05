import type { ActuatorConfig, SensorConfig } from '../commission/machine-config.ts';
import type {
  PlcGenConfig,
  PlcIoPoint,
  PlcSafetyConfig
} from './types.ts';

export type IoArea = 'input' | 'output';

export interface ParsedPointAddress {
  area: IoArea;
  byte: number;
  bit: number;
  index: number;
  canonical: string;
  inRange: boolean;
}

export interface IoRef {
  point: string;
  /** 配置里的显式源地址（如有），仅用于映射与步序引用。 */
  sourceAddress?: string;
  area: IoArea;
  station: string;
  actuatorName?: string;
  purpose: string;
  comment: string;
  path: string;
  order: number;
}

export interface SafetyRefs {
  estop: string[];
  safetyDoor: string[];
  reset?: string;
}

type SensorExtras = SensorConfig & { role?: string; address?: string; ioAddress?: string };
type ActuatorExtras = ActuatorConfig & {
  extendAddress?: string;
  retractAddress?: string;
  gripAddress?: string;
  pointAddress?: string;
};
type ConfigExtras = PlcGenConfig & {
  safetyPoints?: readonly PlcIoPoint[];
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function isSafetyRole(value: string | undefined): 'estop' | 'door' | null {
  if (!value) return null;
  const text = normalizeText(value);
  if (/急停|estop|emergency|e-stop/.test(text)) return 'estop';
  if (/安全门|safety.?door|door|光栅|light.?curtain/.test(text)) return 'door';
  return null;
}

function safetySensorRole(sensor: SensorExtras, config: PlcGenConfig): 'estop' | 'door' | null {
  const explicit = isSafetyRole(sensor.role);
  if (explicit) return explicit;
  if (config.safety && sensorBelongsToSafety(sensor, config.safety)) {
    return sensor.part.match(/安全门|door|光栅|light.?curtain/i) ? 'door' : 'estop';
  }
  return isSafetyRole(sensor.part);
}

function asArray(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return (typeof value === 'string' ? [value] : value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sensorBelongsToSafety(sensor: SensorConfig, safety: PlcSafetyConfig): boolean {
  const point = sensor.point.trim().toUpperCase();
  const extras = sensor as SensorExtras;
  const addresses = [extras.address, extras.ioAddress]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toUpperCase());
  const refs = [
    ...asArray(safety.emergencyStop),
    ...asArray(safety.estop),
    ...asArray(safety.emergencyStopPoint),
    ...asArray(safety.emergencyStopPoints),
    ...asArray(safety.safetyDoor),
    ...asArray(safety.safetyDoors),
    ...asArray(safety.door),
    ...asArray(safety.safetyDoorPoint),
    ...asArray(safety.safetyDoorPoints)
  ];
  return refs.some((ref) => {
    const upper = ref.toUpperCase();
    return upper === point || addresses.includes(upper);
  });
}

export function extractSafetyRefs(config: PlcGenConfig): SafetyRefs {
  const safety = config.safety;
  const estop = [
    ...asArray(safety?.emergencyStop),
    ...asArray(safety?.estop),
    ...asArray(safety?.emergencyStopPoint),
    ...asArray(safety?.emergencyStopPoints),
    ...asArray(config.estopPoint),
    ...asArray(config.emergencyStop)
  ];
  const safetyDoor = [
    ...asArray(safety?.safetyDoor),
    ...asArray(safety?.safetyDoors),
    ...asArray(safety?.door),
    ...asArray(safety?.safetyDoorPoint),
    ...asArray(safety?.safetyDoorPoints),
    ...asArray(config.safetyDoorPoint),
    ...asArray(config.safetyDoor)
  ];
  for (const sensor of (config.sensors ?? []) as SensorExtras[]) {
    const role = safetySensorRole(sensor, config);
    if (role === 'estop') estop.push(sensor.point);
    if (role === 'door') safetyDoor.push(sensor.point);
  }
  const unique = (items: string[]): string[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = normalizePointKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const reset = safety?.reset?.trim();
  return {
    estop: unique(estop),
    safetyDoor: unique(safetyDoor),
    ...(reset ? { reset } : {})
  };
}

export function parsePointAddress(value: string): ParsedPointAddress | null {
  const text = value.trim().replace(/^%/, '').toUpperCase();
  let area: IoArea | null = null;
  let byte = 0;
  let bit = 0;
  let matched = false;

  let match = /^(I|Q)(\d+)\.(\d+)$/.exec(text);
  if (match) {
    area = match[1] === 'I' ? 'input' : 'output';
    byte = Number(match[2]);
    bit = Number(match[3]);
    matched = true;
  }
  if (!matched) {
    match = /^(DI|IX)(\d+)\.(\d+)$/.exec(text);
    if (match) {
      area = 'input';
      byte = Number(match[2]);
      bit = Number(match[3]);
      matched = true;
    }
  }
  if (!matched) {
    match = /^(DQ|QX|DO)(\d+)\.(\d+)$/.exec(text);
    if (match) {
      area = 'output';
      byte = Number(match[2]);
      bit = Number(match[3]);
      matched = true;
    }
  }
  if (!matched) {
    match = /^([XY])(\d+)$/.exec(text);
    if (match) {
      area = match[1] === 'X' ? 'input' : 'output';
      const index = Number(match[2]);
      byte = Math.floor(index / 8);
      bit = index % 8;
      matched = true;
    }
  }
  if (!matched) {
    match = /^(DI|IX)(\d+)$/.exec(text);
    if (match) {
      area = 'input';
      const index = Number(match[2]);
      byte = Math.floor(index / 8);
      bit = index % 8;
      matched = true;
    }
  }
  if (!matched) {
    match = /^(DQ|QX|DO)(\d+)$/.exec(text);
    if (match) {
      area = 'output';
      const index = Number(match[2]);
      byte = Math.floor(index / 8);
      bit = index % 8;
      matched = true;
    }
  }
  if (!matched || area === null) return null;

  const index = byte * 8 + bit;
  const inRange = Number.isSafeInteger(index) && index >= 0 && index < 256 && bit >= 0 && bit <= 7;
  return {
    area,
    byte,
    bit,
    index,
    canonical: `${area === 'input' ? 'I' : 'Q'}${byte}.${bit}`,
    inRange
  };
}

export function normalizePointKey(point: string): string {
  const parsed = parsePointAddress(point);
  if (parsed) return `${parsed.canonical}`;
  return `S:${point.trim().toUpperCase()}`;
}

export function pointAreaHint(point: string): IoArea | null {
  return parsePointAddress(point)?.area ?? null;
}

export function sanitizeTagName(value: string, maxLength = 32): string {
  const replaced = value.trim().replace(/[^\p{L}\p{N}_]/gu, '_');
  const text = replaced || 'Tag';
  return Array.from(text).slice(0, maxLength).join('');
}

export function comparePointLabels(left: string, right: string): number {
  const leftParts = left.toUpperCase().match(/\d+|\D+/g) ?? [left];
  const rightParts = right.toUpperCase().match(/\d+|\D+/g) ?? [right];
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftParts[index] ?? '';
    const b = rightParts[index] ?? '';
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
      continue;
    }
    return a.localeCompare(b, 'en');
  }
  return left.localeCompare(right, 'en');
}

function matchingActuator(config: PlcGenConfig, part: string): ActuatorConfig | undefined {
  const key = normalizeText(part);
  return (config.actuators ?? []).find((actuator) => (
    normalizeText(actuator.id) === key || normalizeText(actuator.name) === key
  ));
}

function sensorPurpose(sensor: SensorConfig, actuator: ActuatorConfig | undefined, config: PlcGenConfig): string {
  const role = safetySensorRole(sensor as SensorExtras, config);
  if (role === 'estop') return '急停';
  if (role === 'door') return '安全门';
  if (!actuator) return '传感器';
  const point = normalizePointKey(sensor.point);
  if (actuator.extendPoint && normalizePointKey(actuator.extendPoint) === point) return '伸出到位';
  if (actuator.retractPoint && normalizePointKey(actuator.retractPoint) === point) return '缩回到位';
  if (actuator.gripPoint && normalizePointKey(actuator.gripPoint) === point) return '夹紧到位';
  if (actuator.point && normalizePointKey(actuator.point) === point) return '角度到位';
  return '到位';
}

export function collectIoRefs(config: PlcGenConfig): IoRef[] {
  const refs: IoRef[] = [];
  const seen = new Set<string>();
  let order = 0;

  const add = (
    point: string,
    area: IoArea,
    station: string,
    purpose: string,
    comment: string,
    path: string,
    actuatorName?: string,
    sourceAddress?: string
  ): void => {
    const trimmed = point.trim();
    if (!trimmed) return;
    const key = normalizePointKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    const ref: IoRef = {
      point: trimmed,
      area,
      station: station.trim() || '未指定',
      purpose,
      comment,
      path,
      order
    };
    if (actuatorName) ref.actuatorName = actuatorName;
    if (sourceAddress?.trim()) ref.sourceAddress = sourceAddress.trim();
    refs.push(ref);
    order += 1;
  };

  for (const [index, rawSensor] of (config.sensors ?? []).entries()) {
    const sensor = rawSensor as SensorExtras;
    const actuator = matchingActuator(config, sensor.part);
    const purpose = sensorPurpose(sensor, actuator, config);
    const station = sensor.station;
    const comment = actuator
      ? `输入 ${sensor.point}；${actuator.name} ${purpose}`
      : `输入 ${sensor.point}；${sensor.part}`;
    add(
      sensor.point,
      'input',
      station,
      purpose,
      comment,
      `sensors[${index}].point`,
      actuator?.name,
      (sensor as SensorExtras).ioAddress ?? (sensor as SensorExtras).address
    );
  }

  const safetyRefs = extractSafetyRefs(config);
  for (const [index, point] of safetyRefs.estop.entries()) {
    add(point, 'input', '安全', '急停', `输入 ${point}；急停链路`, `safety.estop[${index}]`);
  }
  for (const [index, point] of safetyRefs.safetyDoor.entries()) {
    add(point, 'input', '安全', '安全门', `输入 ${point}；安全门/光栅`, `safety.safetyDoor[${index}]`);
  }
  if (safetyRefs.reset) {
    add(safetyRefs.reset, 'input', '安全', '安全复位', `输入 ${safetyRefs.reset}；安全复位`, 'safety.reset');
  }

  const extraPoints = [
    ...(config.ioPoints ?? []),
    ...((config as ConfigExtras).safetyPoints ?? [])
  ];
  for (const [index, extra] of extraPoints.entries()) {
    const area = extra.area ?? pointAreaHint(extra.address ?? extra.point);
    if (!area) continue;
    add(
      extra.point,
      area,
      extra.station ?? '扩展',
      extra.role ?? (area === 'input' ? '输入' : '输出'),
      `${area === 'input' ? '输入' : '输出'} ${extra.point}；${extra.name ?? '扩展点位'}`,
      `ioPoints[${index}].point`,
      undefined,
      extra.address
    );
  }

  for (const [actuatorIndex, rawActuator] of (config.actuators ?? []).entries()) {
    const actuator = rawActuator as ActuatorExtras;
    /**
     * `point` 字段在不同 kind 下语义不同：旋转轴是「分度」，气缸/夹爪借它表达**单点直线动作**
     *（顶升、移载这类没有伸出/缩回之分的轴）。一律写成「旋转」会让变量表长出
     *「移载工位_移载台_旋转」这种名字，而它实际是 +Y 直线移载——现场按这个名字接线必错。
     */
    const pointPurpose = actuator.kind === 'rotary' ? '旋转' : '动作';
    const fields: Array<[string | undefined, string, string]> = [
      [actuator.extendPoint, '伸出', 'extendPoint'],
      [actuator.retractPoint, '缩回', 'retractPoint'],
      [actuator.gripPoint, '夹紧', 'gripPoint'],
      [actuator.point, pointPurpose, 'point']
    ];
    for (const [point, purpose, field] of fields) {
      if (!point) continue;
      add(
        point,
        'output',
        actuator.station,
        purpose,
        `输出 ${point}；${actuator.name} ${purpose}`,
        `actuators[${actuatorIndex}].${field}`,
        actuator.name,
        field === 'extendPoint' ? actuator.extendAddress
          : field === 'retractPoint' ? actuator.retractAddress
            : field === 'gripPoint' ? actuator.gripAddress
              : actuator.pointAddress
      );
    }
  }

  const areaOrder = (area: IoArea): number => area === 'input' ? 0 : 1;
  return refs.sort((left, right) => (
    areaOrder(left.area) - areaOrder(right.area)
    || comparePointLabels(left.point, right.point)
    || left.order - right.order
  ));
}
