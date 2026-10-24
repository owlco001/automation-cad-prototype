import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlcConfig } from '../../src/plc/config.ts';

function registerPoint(id, dataType) {
  return { id, name: id, area: 'holding', address: 0, dataType };
}

function parseInitial(point, value) {
  return parsePlcConfig({
    kind: 'sim',
    points: [point],
    initialValues: { [point.id]: value }
  });
}

test('PLC 配置接受 int16 与 uint16 初始值的完整范围端点', () => {
  const config = parsePlcConfig({
    kind: 'sim',
    points: [registerPoint('S_MIN', 'int16'), registerPoint('S_MAX', 'int16'),
      registerPoint('U_MIN', 'uint16'), registerPoint('U_MAX', 'uint16')],
    initialValues: { S_MIN: -32768, S_MAX: 32767, U_MIN: 0, U_MAX: 65535 }
  });
  assert.deepEqual(config.initialValues, {
    S_MIN: -32768,
    S_MAX: 32767,
    U_MIN: 0,
    U_MAX: 65535
  });
});

test('PLC 配置在解析阶段拒绝越界的 int16/uint16 初始值', () => {
  for (const [dataType, value, range] of [
    ['int16', -32769, '-32768 ~ 32767'],
    ['int16', 32768, '-32768 ~ 32767'],
    ['uint16', -1, '0 ~ 65535'],
    ['uint16', 65536, '0 ~ 65535']
  ]) {
    const point = registerPoint('R0', dataType);
    assert.throws(
      () => parseInitial(point, value),
      (error) => error instanceof Error
        && error.message.includes(`点位「R0」超出 ${dataType} 范围（${range}）`)
    );
  }
});

test('PLC 配置仍拒绝非整数寄存器初始值', () => {
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseInitial(registerPoint('R0', 'int16'), value), /点位「R0」需要整数/);
  }
});
