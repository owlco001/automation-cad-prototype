import {
  PLC_AREAS,
  PLC_DATA_TYPES,
  PLC_KINDS,
  type PlcArea,
  type PlcConfig,
  type PlcDataType,
  type PlcKind,
  type PlcPoint,
  type PlcValue,
  type SimRule
} from './types.ts';
import { validatePlcValue } from './value.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePoint(value: unknown, index: number): PlcPoint {
  if (!isRecord(value)) throw new Error(`第 ${index + 1} 个点位必须是对象`);
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) throw new Error(`缺少必填参数：points[${index}].id`);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) throw new Error(`缺少必填参数：点位「${id}」的名称`);
  const area = value.area;
  if (typeof area !== 'string' || !PLC_AREAS.includes(area as PlcArea)) {
    throw new Error(`点位「${id}」的 area 必须是 ${PLC_AREAS.join('/')}`);
  }
  const dataType = value.dataType;
  if (typeof dataType !== 'string' || !PLC_DATA_TYPES.includes(dataType as PlcDataType)) {
    throw new Error(`点位「${id}」的 dataType 必须是 ${PLC_DATA_TYPES.join('/')}`);
  }
  const address = value.address;
  if (typeof address !== 'number' || !Number.isInteger(address) || address < 0 || address > 65535) {
    throw new Error(`点位「${id}」的地址必须是 0 ~ 65535 的整数`);
  }
  if ((area === 'coil' || area === 'discrete') && dataType !== 'bool') {
    throw new Error(`点位「${id}」位于 ${area} 区，数据类型必须是 bool`);
  }
  if ((area === 'holding' || area === 'input') && dataType === 'bool') {
    throw new Error(`点位「${id}」位于 ${area} 区，数据类型必须是 int16 或 uint16`);
  }
  if (value.writable === true && area !== 'coil' && area !== 'holding') {
    throw new Error(`点位「${id}」位于 ${area} 区，不可写`);
  }
  const point: PlcPoint = {
    id,
    name,
    area: area as PlcArea,
    address,
    dataType: dataType as PlcDataType
  };
  if (value.writable === true) point.writable = true;
  if (typeof value.unit === 'string' && value.unit.trim()) point.unit = value.unit.trim();
  return point;
}

function parseRule(value: unknown, index: number): SimRule {
  if (!isRecord(value)) throw new Error(`第 ${index + 1} 条逻辑规则必须是对象`);
  const target = typeof value.target === 'string' ? value.target.trim() : '';
  if (!target) throw new Error(`缺少必填参数：rules[${index}].target`);
  const type = value.type ?? 'expr';
  if (type === 'expr') {
    if (typeof value.expr !== 'string' || !value.expr.trim()) throw new Error(`缺少必填参数：rules[${index}].expr`);
    return { target, type: 'expr', expr: value.expr.trim() };
  }
  if (type === 'latch') {
    if (typeof value.set !== 'string' || !value.set.trim() || typeof value.reset !== 'string' || !value.reset.trim()) {
      throw new Error(`缺少必填参数：rules[${index}].set/reset`);
    }
    return { target, type: 'latch', set: value.set.trim(), reset: value.reset.trim() };
  }
  if (type === 'timer') {
    if (typeof value.when !== 'string' || !value.when.trim()) throw new Error(`缺少必填参数：rules[${index}].when`);
    if (typeof value.delayMs !== 'number' || !Number.isFinite(value.delayMs) || value.delayMs < 0) {
      throw new Error(`第 ${index + 1} 条定时器规则的 delayMs 必须是非负数字`);
    }
    return { target, type: 'timer', when: value.when.trim(), delayMs: value.delayMs };
  }
  throw new Error(`第 ${index + 1} 条逻辑规则类型不支持：${String(type)}`);
}

export function parsePlcConfig(value: unknown): PlcConfig {
  if (!isRecord(value)) throw new Error('PLC 配置必须是对象');
  const kind = value.kind;
  if (typeof kind !== 'string' || !PLC_KINDS.includes(kind as PlcKind)) {
    throw new Error(`不支持的 PLC 适配器类型：${String(kind ?? '(空)')}`);
  }
  if (!Array.isArray(value.points) || value.points.length === 0) throw new Error('PLC 点位表不能为空');
  const points = value.points.map(parsePoint);
  const ids = new Set<string>();
  for (const point of points) {
    if (ids.has(point.id)) throw new Error(`点位 id 重复：${point.id}`);
    ids.add(point.id);
  }
  const config: PlcConfig = { kind: kind as PlcKind, points };
  if (typeof value.host === 'string' && value.host.trim()) config.host = value.host.trim();
  if (value.port !== undefined) {
    if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error('PLC 端口必须是 1 ~ 65535 的整数');
    }
    config.port = value.port;
  }
  if (value.unitId !== undefined) {
    if (typeof value.unitId !== 'number' || !Number.isInteger(value.unitId) || value.unitId < 0 || value.unitId > 255) {
      throw new Error('PLC 站号 unitId 必须是 0 ~ 255 的整数');
    }
    config.unitId = value.unitId;
  }
  if (value.pollMs !== undefined) {
    if (typeof value.pollMs !== 'number' || !Number.isInteger(value.pollMs) || value.pollMs < 50 || value.pollMs > 60000) {
      throw new Error('PLC 轮询周期 pollMs 必须是 50 ~ 60000 的整数');
    }
    config.pollMs = value.pollMs;
  }
  if (kind === 'modbus') {
    if (!config.host) throw new Error('缺少必填参数：host');
    if (!config.port) throw new Error('缺少必填参数：port');
  }
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) throw new Error('仿真逻辑规则必须是数组');
    config.rules = value.rules.map(parseRule);
  }
  if (value.initialValues !== undefined) {
    if (!isRecord(value.initialValues)) throw new Error('仿真初始值必须是对象');
    const initial: Record<string, PlcValue> = {};
    for (const [id, raw] of Object.entries(value.initialValues)) {
      if (!ids.has(id)) throw new Error(`仿真初始值引用了不存在的点位：${id}`);
      const point = points.find((entry) => entry.id === id);
      if (!point) continue;
      initial[id] = validatePlcValue(point, raw);
    }
    config.initialValues = initial;
  }
  return config;
}

export function publicPlcConfig(config: PlcConfig): PlcConfig {
  return {
    ...config,
    points: config.points.map((point) => ({ ...point })),
    ...(config.rules ? { rules: config.rules.map((rule) => ({ ...rule })) } : {}),
    ...(config.initialValues ? { initialValues: { ...config.initialValues } } : {})
  };
}
