// 机型配置的唯一校验源。
//
// 历史上有三处各自判断同一份方案是否合法：
//   1. commission/machine-config.ts（执行机构工位、传感器工位、点位唯一）
//   2. machine/store.ts（执行机构 id 重复、传感器 part 绑定，安全角色用另一套正则放行）
//   3. plcgen/precheck.ts（传感器绑执行机构，安全点用 safety 区引用放行）
// 结果是同一份配置「一处通过、一处拒绝」（安全传感器被 store 判非法、kind:'conveyor' 被白名单拒）。
// 现在只有这里判定：上面三处全部包一层，只保留各自的业务动作（归一化落盘 / 生成前预检追加项）。
//
// 报告约定：
//   - issue.path 相对配置对象，根为 `config`，例如 `config.actuators[1].kind`；
//   - 解析阶段的错误是「首个致命错误即停」（与改造前的抛错顺序一致），
//     跨项检查（id 重复、传感器绑定）在解析通过后全量收集，因此 ok=false 时 issues 至少 1 条；
//   - assertDesign 抛 issues[0].message，保持既有 `throw new Error(中文文案)` 的调用方式。

import { normalizePointKey } from '../plcgen/io.ts';

export const DEFAULT_ACTUATOR_TRAVEL_MM = 40;
export const MIN_ACTUATOR_TRAVEL_MM = 0.1;
export const MAX_ACTUATOR_TRAVEL_MM = 2000;
export const DEFAULT_ROTATION_RANGE_DEG = 90;
export const MIN_ROTATION_RANGE_DEG = 0.1;
export const MAX_ROTATION_RANGE_DEG = 360;

export interface ActuatorConfig {
  id: string;
  name: string;
  kind: 'cylinder' | 'gripper' | 'rotary';
  station: string;
  extendPoint?: string;
  retractPoint?: string;
  gripPoint?: string;
  /** 旋转轴的驱动点位；true 时转到 rotationRangeDeg，false 时回零。 */
  point?: string;
  travelMm?: number;
  /** 向导手工输入的直线行程来源；始终待复核，缺省表示方案/系统估算值。 */
  travelSource?: 'engineer-input';
  /** rotary 分度角；缺省按 90° 方案/系统估算。 */
  rotationRangeDeg?: number;
  /** 向导手工输入的旋转分度角来源；始终待复核，缺省表示方案/系统估算值。 */
  rotationRangeSource?: 'engineer-input';
  durationMs?: number;
  /** 场景布局偏移；相对所属工位基座中心，单位为场景单位。 */
  position?: [number, number, number];
  /** 元件库绑定；仅向导编辑使用，旧配置可缺省。 */
  model?: string;
  partId?: string;
  packId?: string;
}

export interface SensorConfig {
  point: string;
  station: string;
  part: string;
  color?: string;
  /** 元件库绑定；仅向导编辑使用，旧配置可缺省。 */
  model?: string;
  partId?: string;
  packId?: string;
}

/**
 * 输送机整机参数（`config.conveyor`）。
 *
 * 为什么写进 config 而不是只留在 design/brief 里：整机几何的唯一入口
 * `resolveMachineGeometry(config)` 只收 config，落盘的 `machine/<id>.json` 也只有
 * config + form。参数不跟着 config 走，几何就只能靠猜或者回落代理体
 * —— 那正是「同一台机器两套几何」的根源。
 *
 * 只写**能推出几何的最小集**：线体长 / 带宽是必填（有它才能参数化整机），
 * 其余缺省沿用 conveyor-assembly 的典型值；转向角可由 turner-rotary 的
 * rotationRangeDeg 反推，不必重复写（写了以它为准）。
 */
export interface MachineConveyorConfig {
  /** 线体总长 mm */
  lengthMm: number;
  /** 皮带有效宽度 mm */
  widthMm: number;
  beltHeightMm?: number;
  pulleyDiameterMm?: number;
  beltThicknessMm?: number;
  frameSectionMm?: number;
  /** 缓存层数：1 = 普通输送线；≥2 = 立体缓存 */
  layers?: number;
  layerPitchMm?: number;
  /** 转向角度：省略时由 turner-rotary 的 rotationRangeDeg 反推；0 = 不做转向 */
  turnerAngleDeg?: number;
  /** 顶升移载（直角移载）：板不转，顶升后沿 +Y 送出；与 turnerAngleDeg 互斥 */
  transferPresent?: boolean;
  /** 板材沿 X 的长度 mm（对接段宽度按它给）；省略按带宽推 */
  transferPartLengthMm?: number;
  /** 板材沿 Y 的宽度 mm（移载行程按它给）；省略按带宽推 */
  transferPartWidthMm?: number;
}

/**
 * 非执行机构驱动的扩展点位（`DO-`/`DI-` 这类握手信号）。
 *
 * 为什么要有：顶升移载要给下游一个联锁信号（`DO-TRANSFER-READY` / `DO-TRANSFER-DONE`），
 * 这类输出既不是气缸线圈也不是传感器输入。以前只能塞进某个执行机构的 point 字段，
 * 语义上就变成了「某条轴的动作点」。这里显式建模成扩展点位，io-map 里 direction/area
 * 由 area 字段给出，PLC 预检的地址/重复检查同样覆盖它（collectIoRefs 早就支持）。
 */
export interface MachineExtraIoPoint {
  point: string;
  name?: string;
  /** 缺省由点位前缀（DO/DQ→输出，其余→输入）推；与 plcgen 的 PlcIoPoint 保持同一形状 */
  area?: 'input' | 'output';
  station?: string;
  /** 用途（进 io-map 的「类型」列），如「移载就绪」「下游允许」 */
  role?: string;
  address?: string;
}

export interface MachineConfig {
  id: string;
  name: string;
  stations: string[];
  actuators: ActuatorConfig[];
  sensors: SensorConfig[];
  /** 握手/联锁扩展点位（不是执行机构线圈、也不是传感器输入）；plcgen 按同一形状读取 */
  ioPoints?: readonly MachineExtraIoPoint[];
  /** 形态 id（forms.ts），与 design.form.id 一致；输送类据此判定走参数化整机 */
  formId?: string;
  /** 输送机参数：有它才可能走参数化整机，缺省则回落工位生成器 */
  conveyor?: MachineConveyorConfig;
}

export type DesignIssueCode =
  | 'STATION_UNDEFINED'
  | 'ACTUATOR_ID_DUPLICATE'
  | 'SENSOR_UNBOUND'
  | 'POINT_DUPLICATE'
  | 'POINT_INVALID'
  | 'FORM_KIND_UNSUPPORTED'
  | 'ACTUATOR_KIND_UNSUPPORTED'
  | 'SAFETY_REF_UNDEFINED'
  | 'CONFIG_SHAPE';

export interface DesignIssue {
  code: DesignIssueCode;
  path: string;
  message: string;
  hint?: string;
}

export interface ValidateResult {
  ok: boolean;
  issues: DesignIssue[];
  config?: MachineConfig;
}

type UnknownRecord = Record<string, unknown>;

/** 安全回路传感器（急停/安全门/光栅）不属于任何工位或执行机构：它们绑的是安全回路本身。 */
const SAFETY_ROLE_RE = /急停|estop|e-stop|emergency|安全门|光栅|safety.?door|door|light.?curtain/i;

const SAFETY_REF_FIELDS = [
  'emergencyStop',
  'estop',
  'emergencyStopPoint',
  'emergencyStopPoints',
  'safetyDoor',
  'safetyDoors',
  'door',
  'safetyDoorPoint',
  'safetyDoorPoints'
] as const;

/** 机型形态（整线布局）几何类型白名单：唯一一份，store 的 design.form 解析也读这里。 */
export const MACHINE_FORM_GEOMETRY_KINDS = [
  'dial',
  'linear',
  'gantry',
  'dual',
  'hybrid',
  'cell',
  // forms.ts 的 belt-line 形态声明的是 kind:'conveyor'；少列它会让任何输送机方案被判非法。
  'conveyor'
] as const;

export type MachineFormGeometryKindName = (typeof MACHINE_FORM_GEOMETRY_KINDS)[number];

export function isSupportedFormKind(value: unknown): value is MachineFormGeometryKindName {
  return typeof value === 'string' && (MACHINE_FORM_GEOMETRY_KINDS as readonly string[]).includes(value);
}

export function formKindUnsupportedIssue(path = 'design.form.geometry.kind'): DesignIssue {
  return {
    code: 'FORM_KIND_UNSUPPORTED',
    path,
    message: `${path} 必须是 ${MACHINE_FORM_GEOMETRY_KINDS.join('/')}`,
    hint: '未知形态按 linear 处理会产生错误的工位排布，因此必须显式给出受支持的 kind'
  };
}

function configShapeIssue(): DesignIssue {
  return { code: 'CONFIG_SHAPE', path: 'config', message: '机型配置必须是对象' };
}

class DesignIssueError extends Error {
  readonly issue: DesignIssue;

  constructor(issue: DesignIssue) {
    super(issue.message);
    this.name = 'DesignIssueError';
    this.issue = issue;
  }
}

function fail(code: DesignIssueCode, path: string, message: string, hint?: string): never {
  throw new DesignIssueError(hint ? { code, path, message, hint } : { code, path, message });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, key: string, label: string, path: string, hint?: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CONFIG_SHAPE', path, `缺少必填参数：机型配置.${label}`, hint);
  }
  return value.trim();
}

function optionalString(
  record: UnknownRecord,
  key: string,
  label: string,
  path: string,
  code: DesignIssueCode = 'CONFIG_SHAPE'
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, path, `机型配置 ${label} 必须是非空字符串`);
  }
  return value.trim();
}

function pointString(record: UnknownRecord, key: string, label: string, path: string): string | undefined {
  return optionalString(record, key, label, path, 'POINT_INVALID');
}

function positiveNumber(value: unknown, fallback: number, label: string, path: string): number {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    fail('CONFIG_SHAPE', path, `${label} 必须大于 0`);
  }
  return number;
}

function actuatorTravel(value: unknown, id: string, path: string): number {
  const number = value === undefined ? DEFAULT_ACTUATOR_TRAVEL_MM : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    fail('CONFIG_SHAPE', path, `执行机构「${id}」行程必须是有限数`);
  }
  if (number <= 0) fail('CONFIG_SHAPE', path, `执行机构「${id}」travelMm 必须大于 0`);
  if (number < MIN_ACTUATOR_TRAVEL_MM || number > MAX_ACTUATOR_TRAVEL_MM) {
    fail('CONFIG_SHAPE', path, `执行机构「${id}」行程必须在 ${MIN_ACTUATOR_TRAVEL_MM}–${MAX_ACTUATOR_TRAVEL_MM} mm 范围内`);
  }
  return number;
}

function actuatorRotationRange(value: unknown, id: string, path: string): number {
  const number = value === undefined ? DEFAULT_ROTATION_RANGE_DEG : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    fail('CONFIG_SHAPE', path, `执行机构「${id}」旋转分度角必须是有限数`);
  }
  if (number < MIN_ROTATION_RANGE_DEG || number > MAX_ROTATION_RANGE_DEG) {
    fail('CONFIG_SHAPE', path, `执行机构「${id}」旋转分度角必须在 ${MIN_ROTATION_RANGE_DEG}–${MAX_ROTATION_RANGE_DEG}° 范围内`);
  }
  return number;
}

function readPosition(value: unknown, label: string, path: string): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    fail('CONFIG_SHAPE', path, `${label} position 必须是三个有限数字`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** 解析阶段：结构/字段/点位唯一，首个致命错误即停（与改造前抛错顺序一致）。 */
function parseConfig(value: unknown): MachineConfig {
  if (!isRecord(value)) {
    fail('CONFIG_SHAPE', 'config', '机型配置必须是对象', '配置应来自机型方案生成或向导保存，而不是字符串/数组');
  }
  const record = value;

  const rawStations = record.stations;
  if (!Array.isArray(rawStations) || rawStations.length === 0) {
    fail('CONFIG_SHAPE', 'config.stations', '缺少必填参数：机型配置.stations', '至少声明一个工位，执行机构/传感器都要挂在工位上');
  }
  const stations = rawStations.map((station, index) => {
    if (typeof station !== 'string' || station.trim() === '') {
      fail('CONFIG_SHAPE', `config.stations[${index}]`, `机型配置 stations[${index}] 必须是非空字符串`);
    }
    return station.trim();
  });
  if (new Set(stations).size !== stations.length) {
    fail('CONFIG_SHAPE', 'config.stations', '机型配置 stations 存在重复工位', '工位名是身份键，重复会导致工位身份/几何偏移错位');
  }

  const rawActuators = record.actuators;
  if (!Array.isArray(rawActuators) || rawActuators.length === 0) {
    fail('CONFIG_SHAPE', 'config.actuators', '缺少必填参数：机型配置.actuators', '没有执行机构的方案无法生成联动与 PLC 程序');
  }
  if (!Array.isArray(record.sensors)) {
    fail('CONFIG_SHAPE', 'config.sensors', '缺少必填参数：机型配置.sensors', '没有传感器时请显式给出 sensors: []');
  }

  const stationSet = new Set(stations);
  const pointSet = new Set<string>();
  const claimPoint = (point: string | undefined, path: string, source: string): void => {
    if (point === undefined) return;
    const key = normalizePointKey(point);
    if (pointSet.has(key)) {
      fail('POINT_DUPLICATE', path, `机型配置点位 ${point} 重复或与已有点位地址别名冲突（${source}）`, '同一点位只能被一个执行机构字段或传感器占用');
    }
    pointSet.add(key);
  };

  const actuators = rawActuators.map((raw, index): ActuatorConfig => {
    const path = `config.actuators[${index}]`;
    if (!isRecord(raw)) fail('CONFIG_SHAPE', path, `机型配置 actuators[${index}] 必须是对象`);
    const id = requiredString(raw, 'id', `actuators[${index}].id`, `${path}.id`, '执行机构 id 用于点位/程序关联，必须唯一且非空');
    const name = requiredString(raw, 'name', `actuators[${index}].name`, `${path}.name`);
    const kind = raw.kind;
    if (kind !== 'cylinder' && kind !== 'gripper' && kind !== 'rotary') {
      fail('ACTUATOR_KIND_UNSUPPORTED', `${path}.kind`, `执行机构「${id}」kind 必须是 cylinder、gripper 或 rotary`, '当前只支持这三类运动学与信号模板');
    }
    const station = requiredString(raw, 'station', `actuators[${index}].station`, `${path}.station`);
    if (!stationSet.has(station)) {
      fail('STATION_UNDEFINED', `${path}.station`, `执行机构「${id}」引用了未定义工位「${station}」`, '先把工位加入 stations，或把执行机构挂到已有工位');
    }

    const extendPoint = pointString(raw, 'extendPoint', `执行机构「${id}」extendPoint`, `${path}.extendPoint`);
    const retractPoint = pointString(raw, 'retractPoint', `执行机构「${id}」retractPoint`, `${path}.retractPoint`);
    const gripPoint = pointString(raw, 'gripPoint', `执行机构「${id}」gripPoint`, `${path}.gripPoint`);
    const point = pointString(raw, 'point', `执行机构「${id}」point`, `${path}.point`);
    claimPoint(extendPoint, `${path}.extendPoint`, `执行机构 ${id} extendPoint`);
    claimPoint(retractPoint, `${path}.retractPoint`, `执行机构 ${id} retractPoint`);
    claimPoint(gripPoint, `${path}.gripPoint`, `执行机构 ${id} gripPoint`);
    claimPoint(point, `${path}.point`, `执行机构 ${id} point`);

    const normalized: ActuatorConfig = {
      id,
      name,
      kind,
      station,
      durationMs: positiveNumber(raw.durationMs, 400, `执行机构「${id}」durationMs`, `${path}.durationMs`)
    };
    if (kind === 'rotary') {
      normalized.rotationRangeDeg = actuatorRotationRange(raw.rotationRangeDeg, id, `${path}.rotationRangeDeg`);
      if (raw.rotationRangeSource !== undefined) {
        if (raw.rotationRangeSource !== 'engineer-input') {
          fail('CONFIG_SHAPE', `${path}.rotationRangeSource`, `执行机构「${id}」rotationRangeSource 必须是 engineer-input`);
        }
        if (raw.rotationRangeDeg === undefined) {
          fail('CONFIG_SHAPE', `${path}.rotationRangeSource`, `执行机构「${id}」标记为工程师输入时必须显式填写 rotationRangeDeg`);
        }
        normalized.rotationRangeSource = 'engineer-input';
      }
      if (raw.travelSource !== undefined) {
        fail('CONFIG_SHAPE', `${path}.travelSource`, `执行机构「${id}」旋转轴不能携带直线行程来源 travelSource`);
      }
    } else {
      normalized.travelMm = actuatorTravel(raw.travelMm, id, `${path}.travelMm`);
      if (raw.travelSource !== undefined) {
        if (raw.travelSource !== 'engineer-input') {
          fail('CONFIG_SHAPE', `${path}.travelSource`, `执行机构「${id}」travelSource 必须是 engineer-input`);
        }
        if (raw.travelMm === undefined) {
          fail('CONFIG_SHAPE', `${path}.travelSource`, `执行机构「${id}」标记为工程师输入时必须显式填写 travelMm`);
        }
        normalized.travelSource = 'engineer-input';
      }
      if (raw.rotationRangeDeg !== undefined || raw.rotationRangeSource !== undefined) {
        fail('CONFIG_SHAPE', `${path}.rotationRangeDeg`, `执行机构「${id}」非旋转轴不能携带 rotationRangeDeg/rotationRangeSource`);
      }
    }
    if (extendPoint !== undefined) normalized.extendPoint = extendPoint;
    if (retractPoint !== undefined) normalized.retractPoint = retractPoint;
    if (gripPoint !== undefined) normalized.gripPoint = gripPoint;
    if (point !== undefined) normalized.point = point;
    const position = readPosition(raw.position, `执行机构「${id}」`, `${path}.position`);
    if (position !== undefined) normalized.position = position;
    const model = optionalString(raw, 'model', `执行机构「${id}」model`, `${path}.model`);
    const partId = optionalString(raw, 'partId', `执行机构「${id}」partId`, `${path}.partId`);
    const packId = optionalString(raw, 'packId', `执行机构「${id}」packId`, `${path}.packId`);
    if (model !== undefined) normalized.model = model;
    if (partId !== undefined) normalized.partId = partId;
    if (packId !== undefined) normalized.packId = packId;
    return normalized;
  });

  const sensors = (record.sensors as unknown[]).map((raw, index): SensorConfig => {
    const path = `config.sensors[${index}]`;
    if (!isRecord(raw)) fail('CONFIG_SHAPE', path, `机型配置 sensors[${index}] 必须是对象`);
    const point = requiredString(raw, 'point', `sensors[${index}].point`, `${path}.point`, '传感器点位是 PLC 输入地址的唯一来源');
    const station = requiredString(raw, 'station', `sensors[${index}].station`, `${path}.station`);
    const part = requiredString(raw, 'part', `sensors[${index}].part`, `${path}.part`, 'part 是「这个传感器盯的是谁」：工位名或执行机构 id');
    if (!stationSet.has(station)) {
      fail('STATION_UNDEFINED', `${path}.station`, `传感器「${point}」引用了未定义工位「${station}」`);
    }
    claimPoint(point, `${path}.point`, `传感器 ${point}`);
    const color = optionalString(raw, 'color', `传感器「${point}」color`, `${path}.color`);
    const normalized: SensorConfig = { point, station, part };
    if (color !== undefined) normalized.color = color;
    const model = optionalString(raw, 'model', `传感器「${point}」model`, `${path}.model`);
    const partId = optionalString(raw, 'partId', `传感器「${point}」partId`, `${path}.partId`);
    const packId = optionalString(raw, 'packId', `传感器「${point}」packId`, `${path}.packId`);
    if (model !== undefined) normalized.model = model;
    if (partId !== undefined) normalized.partId = partId;
    if (packId !== undefined) normalized.packId = packId;
    return normalized;
  });

  const config: MachineConfig = {
    id: requiredString(record, 'id', 'id', 'config.id'),
    name: requiredString(record, 'name', 'name', 'config.name'),
    stations,
    actuators,
    sensors
  };
  // 形态 id 与输送参数是可选的「几何推导输入」：旧方案没有它们也照样合法，
  // 只是几何会回落到工位生成器（见 machine/machine-geometry.ts 的判定）。
  const ioPoints = parseExtraIoPoints(record.ioPoints);
  if (ioPoints !== undefined) config.ioPoints = ioPoints;
  const formId = optionalString(record, 'formId', 'formId', 'config.formId');
  if (formId !== undefined) config.formId = formId;
  const conveyor = parseConveyorParams(record.conveyor);
  if (conveyor !== undefined) config.conveyor = conveyor;
  return config;
}

/** 可选数值：非有限/非正数按缺失处理（几何层自己回落典型值），不做致命判定。 */
function optionalPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 解析 `config.conveyor`。宽容口径：坏值当缺失（几何层回落典型值），
 * 但**形状错了要报**——把 `conveyor: "6000x1200"` 静默吞掉，用户会以为整机参数生效了。
 */
function parseConveyorParams(value: unknown): MachineConveyorConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fail('CONFIG_SHAPE', 'config.conveyor', 'config.conveyor 必须是对象（线体长/带宽等几何参数）');
  }
  const lengthMm = optionalPositive(value.lengthMm);
  const widthMm = optionalPositive(value.widthMm);
  if (lengthMm === undefined && widthMm === undefined) return undefined;
  const conveyor: MachineConveyorConfig = { lengthMm: lengthMm ?? 0, widthMm: widthMm ?? 0 };
  for (const key of ['beltHeightMm', 'pulleyDiameterMm', 'beltThicknessMm', 'frameSectionMm', 'layerPitchMm'] as const) {
    const parsed = optionalPositive(value[key]);
    if (parsed !== undefined) conveyor[key] = parsed;
  }
  const layers = optionalPositive(value.layers);
  if (layers !== undefined) conveyor.layers = Math.min(8, Math.max(1, Math.round(layers)));
  const turner = optionalPositive(value.turnerAngleDeg);
  if (turner !== undefined) conveyor.turnerAngleDeg = Math.min(180, Math.round(turner));
  if (value.transferPresent === true) conveyor.transferPresent = true;
  const partLength = optionalPositive(value.transferPartLengthMm);
  if (partLength !== undefined) conveyor.transferPartLengthMm = partLength;
  const partWidth = optionalPositive(value.transferPartWidthMm);
  if (partWidth !== undefined) conveyor.transferPartWidthMm = partWidth;
  return conveyor;
}

/**
 * 解析扩展点位。宽容口径与 `config.conveyor` 一致：坏项丢掉（几何/PLC 侧会按缺失处理），
 * 但形状错了要报——把 `ioPoints: "DO-READY"` 静默吞掉，用户会以为信号已经进 IO 表了。
 */
function parseExtraIoPoints(value: unknown): MachineExtraIoPoint[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fail('CONFIG_SHAPE', 'config.ioPoints', 'config.ioPoints 必须是数组（每项 {point, area, name?}）');
  }
  const points: MachineExtraIoPoint[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) {
      fail('CONFIG_SHAPE', `config.ioPoints[${index}]`, `config.ioPoints[${index}] 必须是对象`);
    }
    const point = optionalString(raw, 'point', `ioPoints[${index}].point`, `config.ioPoints[${index}].point`);
    if (point === undefined) continue;
    const area = raw.area === 'input' || raw.area === 'output'
      ? raw.area
      : /^D[QO]|^Q/i.test(point) ? 'output' : 'input';
    const entry: MachineExtraIoPoint = { point, area };
    const name = optionalString(raw, 'name', `ioPoints[${index}].name`, `config.ioPoints[${index}].name`);
    if (name !== undefined) entry.name = name;
    const station = optionalString(raw, 'station', `ioPoints[${index}].station`, `config.ioPoints[${index}].station`);
    if (station !== undefined) entry.station = station;
    const role = optionalString(raw, 'role', `ioPoints[${index}].role`, `config.ioPoints[${index}].role`);
    if (role !== undefined) entry.role = role;
    const address = optionalString(raw, 'address', `ioPoints[${index}].address`, `config.ioPoints[${index}].address`);
    if (address !== undefined) entry.address = address;
    points.push(entry);
  }
  return points;
}

/** 配置里声明的安全回路点位（safety.emergencyStop / safetyDoor / 顶层 estopPoint 等）。 */
function collectSafetyRefs(value: UnknownRecord): Set<string> {
  const refs = new Set<string>();
  const add = (item: unknown): void => {
    if (typeof item === 'string') {
      if (item.trim()) refs.add(normalizePointKey(item));
      return;
    }
    if (Array.isArray(item)) for (const entry of item) add(entry);
  };
  const safety = isRecord(value.safety) ? value.safety : undefined;
  if (safety) for (const field of SAFETY_REF_FIELDS) add(safety[field]);
  add(value.estopPoint);
  add(value.emergencyStop);
  add(value.safetyDoorPoint);
  add(value.safetyDoor);
  return refs;
}

function isSafetyText(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim() !== '' && SAFETY_ROLE_RE.test(text);
}

/**
 * 安全回路传感器豁免绑定：part/role 写了急停/安全门/光栅，或点位已被 safety 区引用。
 * 这是三处旧实现豁免条件的并集，只能放宽豁免、不能收紧（否则带安全集的方案会重新被判非法）。
 */
function isSafetySensor(
  raw: UnknownRecord | undefined,
  sensor: Pick<SensorConfig, 'point' | 'part'>,
  safetyRefs: Set<string>
): boolean {
  if (isSafetyText(sensor.part)) return true;
  const role = raw?.role;
  if (isSafetyText(typeof role === 'string' ? role : undefined)) return true;
  if (safetyRefs.has(normalizePointKey(sensor.point))) return true;
  const address = raw?.ioAddress ?? raw?.address;
  return typeof address === 'string' && address.trim() !== '' && safetyRefs.has(normalizePointKey(address));
}

function readId(raw: UnknownRecord): string | undefined {
  const id = raw.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * 跨项检查：执行机构 id 唯一、传感器 part 绑定。
 * 直接读原始输入而不是归一化结果，因此解析阶段就失败时结论同样可见（预检要一次报全），
 * 并且两个入口看到的是同一份规则。
 */
/**
 * `requirePartBinding`：传感器 part 是否必须绑到工位/执行机构。
 * - 方案（design/apply/PLC）走严格模式（默认 true）：part 必须是工位名或执行机构 id。
 * - 外部 IO 映射导入（联调面板 setMachineConfig）走宽松模式：现场点位表里的 part 往往是
 *   「主回路反馈」这类信号名，既不是工位也不是执行机构；这类配置以前也从没校验过 part
 *   （旧的 machine-config.ts 只校验 station），放宽是为了保持既有行为、不是新增豁免。
 */
export interface ValidateOptions { requirePartBinding?: boolean }

function crossCheck(value: UnknownRecord, options: ValidateOptions = {}): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const rawActuators = Array.isArray(value.actuators) ? value.actuators : [];
  const actuatorIds = new Set<string>();
  for (const [index, raw] of rawActuators.entries()) {
    if (!isRecord(raw)) continue;
    const id = readId(raw);
    if (id === undefined) continue;
    if (actuatorIds.has(id)) {
      issues.push({
        code: 'ACTUATOR_ID_DUPLICATE',
        path: `config.actuators[${index}].id`,
        message: `执行机构 id 重复：${id}`,
        hint: '重复 id 会让点位归属和 PLC 程序互相覆盖，请给每个执行机构唯一的 id'
      });
      continue;
    }
    actuatorIds.add(id);
  }

  const rawStations = Array.isArray(value.stations) ? value.stations : [];
  const stationSet = new Set<string>();
  for (const station of rawStations) {
    if (typeof station === 'string' && station.trim() !== '') stationSet.add(station.trim());
  }
  // 工位表本身缺失时不做绑定判断：解析阶段已经报了 CONFIG_SHAPE，再报一遍只会是噪音。
  if (stationSet.size === 0) return issues;

  const safetyRefs = collectSafetyRefs(value);
  const rawSensors = Array.isArray(value.sensors) ? value.sensors : [];
  for (const [index, raw] of rawSensors.entries()) {
    if (!isRecord(raw)) continue;
    const point = typeof raw.point === 'string' ? raw.point.trim() : '';
    const part = typeof raw.part === 'string' ? raw.part.trim() : '';
    if (point === '' || part === '') continue;
    if (isSafetySensor(raw, { point, part }, safetyRefs)) continue;
    if (stationSet.has(part) || actuatorIds.has(part)) continue;
    if (options.requirePartBinding === false) continue;
    issues.push({
      code: 'SENSOR_UNBOUND',
      path: `config.sensors[${index}].part`,
      message: `传感器「${point}」引用了未定义工位或执行机构「${part}」`,
      hint: '把 part 改成已定义的工位名或执行机构 id；急停/安全门/光栅等安全传感器可不绑定工位'
    });
  }
  return issues;
}

/** 校验并归一化机型配置；不抛错，结论全在返回值里。 */
export function validateDesign(value: unknown, options: ValidateOptions = {}): ValidateResult {
  const issues: DesignIssue[] = [];
  let config: MachineConfig | undefined;
  try {
    config = parseConfig(value);
  } catch (error) {
    if (!(error instanceof DesignIssueError)) throw error;
    issues.push(error.issue);
  }
  if (isRecord(value)) issues.push(...crossCheck(value, options));
  if (issues.length > 0 || config === undefined) {
    return issues.length > 0 ? { ok: false, issues } : { ok: false, issues: [configShapeIssue()] };
  }
  return { ok: true, issues: [], config };
}

/** 校验并归一化机型配置；ok=false 时抛 issues[0].message（保持既有调用方式）。 */
export function assertDesign(value: unknown, options: ValidateOptions = {}): MachineConfig {
  const result = validateDesign(value, options);
  const config = result.config;
  if (!result.ok || config === undefined) {
    throw new Error(result.issues[0]?.message ?? '机型配置不合法');
  }
  return config;
}
