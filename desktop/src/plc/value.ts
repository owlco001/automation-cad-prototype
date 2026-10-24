import type { PlcPoint, PlcValue } from './types.ts';

/** 校验可写入/用于仿真初始状态的值，保证 int16/uint16 与寄存器范围一致。 */
export function validatePlcValue(
  point: Pick<PlcPoint, 'id' | 'dataType'>,
  value: unknown
): PlcValue {
  if (point.dataType === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`点位「${point.id}」需要布尔值`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`点位「${point.id}」需要整数`);
  }
  if (point.dataType === 'int16' && (value < -32768 || value > 32767)) {
    throw new Error(`点位「${point.id}」超出 int16 范围（-32768 ~ 32767）`);
  }
  if (point.dataType === 'uint16' && (value < 0 || value > 65535)) {
    throw new Error(`点位「${point.id}」超出 uint16 范围（0 ~ 65535）`);
  }
  return value;
}
