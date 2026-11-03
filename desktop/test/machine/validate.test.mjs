import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDesign,
  validateDesign,
  isSupportedFormKind
} from '../../src/machine/validate.ts';
import { validateMachineConfig } from '../../src/commission/machine-config.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';
import { precheck } from '../../src/plcgen/precheck.ts';

function baseConfig(overrides = {}) {
  return {
    id: 'm-1',
    name: '测试机型',
    stations: ['上料'],
    actuators: [
      { id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1' }
    ],
    sensors: [{ point: 'X0', station: '上料', part: 'cyl-1' }],
    ...overrides
  };
}

const codes = (result) => result.issues.map((item) => item.code);

test('统一校验：正常配置通过并补全默认行程/动作时长', () => {
  const result = validateDesign(baseConfig());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.config?.actuators[0]?.travelMm, 40);
  assert.equal(result.config?.actuators[0]?.durationMs, 400);
  assert.equal(result.config?.sensors.length, 1);
});

test('统一校验：执行机构工位不存在报 STATION_UNDEFINED', () => {
  const value = baseConfig({
    actuators: [{ id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '压装', extendPoint: 'Y0' }],
    sensors: []
  });
  const result = validateDesign(value);
  assert.equal(result.ok, false);
  assert.equal(result.config, undefined);
  assert.equal(codes(result)[0], 'STATION_UNDEFINED');
  assert.equal(result.issues[0]?.path, 'config.actuators[0].station');
  assert.match(result.issues[0]?.message ?? '', /未定义工位「压装」/);
});

test('统一校验：传感器工位不存在报 STATION_UNDEFINED', () => {
  const value = baseConfig({
    sensors: [{ point: 'X0', station: '下料', part: 'cyl-1' }]
  });
  const result = validateDesign(value);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, 'STATION_UNDEFINED');
  assert.equal(result.issues[0]?.path, 'config.sensors[0].station');
});

test('统一校验：执行机构 id 重复报 ACTUATOR_ID_DUPLICATE', () => {
  const value = baseConfig({
    actuators: [
      { id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0' },
      { id: 'cyl-1', name: '上料气缸备份', kind: 'cylinder', station: '上料', extendPoint: 'Y1' }
    ],
    sensors: []
  });
  const result = validateDesign(value);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['ACTUATOR_ID_DUPLICATE']);
  assert.equal(result.issues[0]?.path, 'config.actuators[1].id');
  assert.match(result.issues[0]?.message ?? '', /执行机构 id 重复：cyl-1/);
});

test('统一校验：传感器绑不存在的执行机构报 SENSOR_UNBOUND 且带 hint', () => {
  const value = baseConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-ghost' }
    ]
  });
  const result = validateDesign(value);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['SENSOR_UNBOUND']);
  const issue = result.issues[0];
  assert.equal(issue?.path, 'config.sensors[1].part');
  assert.match(issue?.message ?? '', /传感器「X1」引用了未定义工位或执行机构「cyl-ghost」/);
  assert.ok((issue?.hint ?? '').length > 0, 'SENSOR_UNBOUND 必须给出修正提示');
  assert.match(issue?.hint ?? '', /工位名或执行机构 id/);
  assert.throws(() => assertDesign(value), /未定义工位或执行机构「cyl-ghost」/);
});

test('统一校验：安全传感器（急停/安全门/光栅）不绑工位也通过', () => {
  const value = baseConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X6', station: '上料', part: '急停按钮' },
      { point: 'X7', station: '上料', part: '安全门开关' },
      { point: 'X8', station: '上料', part: '安全光栅' }
    ]
  });
  const result = validateDesign(value);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  // 落盘入口（store）与预检入口都不再把安全传感器判非法
  const design = validateMachineDesign({ config: value });
  assert.equal(design.config.sensors.length, 4);
  assert.equal(validateMachineConfig(value).sensors.length, 4);
  assert.ok(!precheck(value).errors.some((error) => error.code === 'SENSOR_UNBOUND'));
});

test('统一校验：safety 区已声明的点位即使 part 写成别的也不判未绑定', () => {
  const value = baseConfig({
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X8', station: '上料', part: '未绑定' }
    ]
  });
  const result = validateDesign(value);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('统一校验：点位重复报 POINT_DUPLICATE（含 Y/Q 别名）', () => {
  const duplicated = baseConfig({
    actuators: [
      { id: 'a1', name: '气缸 1', kind: 'cylinder', station: '上料', extendPoint: 'Y0' },
      { id: 'a2', name: '气缸 2', kind: 'cylinder', station: '上料', extendPoint: 'Y0' }
    ],
    sensors: []
  });
  const first = validateDesign(duplicated);
  assert.equal(first.ok, false);
  assert.equal(first.issues[0]?.code, 'POINT_DUPLICATE');
  assert.match(first.issues[0]?.message ?? '', /点位 Y0 重复/);

  const aliased = baseConfig({
    actuators: [{ id: 'a1', name: '气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0' }],
    sensors: [{ point: 'Q0.0', station: '上料', part: 'a1' }]
  });
  const second = validateDesign(aliased);
  assert.equal(second.ok, false);
  assert.equal(second.issues[0]?.code, 'POINT_DUPLICATE');
  assert.match(second.issues[0]?.message ?? '', /别名冲突/);
});

test('统一校验：非法执行机构 kind 报 ACTUATOR_KIND_UNSUPPORTED', () => {
  const value = baseConfig({
    actuators: [{ id: 'a1', name: '皮带', kind: 'conveyor', station: '上料' }],
    sensors: []
  });
  const result = validateDesign(value);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, 'ACTUATOR_KIND_UNSUPPORTED');
  assert.equal(result.issues[0]?.path, 'config.actuators[0].kind');
  assert.throws(() => validateMachineConfig(value), /kind 必须是 cylinder、gripper 或 rotary/);
});

test('统一校验：形态几何 kind 白名单含 conveyor（store 与这里同源）', () => {
  assert.equal(isSupportedFormKind('conveyor'), true);
  assert.equal(isSupportedFormKind('dial'), true);
  assert.equal(isSupportedFormKind('belt'), false);
  assert.equal(isSupportedFormKind(undefined), false);
});

test('落盘入口：形态几何 kind 为 conveyor 的输送机方案不再被白名单拒', () => {
  const design = validateMachineDesign({
    config: baseConfig(),
    form: {
      id: 'belt-1',
      name: '皮带输送线',
      rationale: '两工位之间用皮带线转运',
      geometry: { kind: 'conveyor', conveyor: 'belt' }
    }
  });
  assert.equal(design.form?.geometry.kind, 'conveyor');
});

test('统一校验：空值/非对象输入报 CONFIG_SHAPE', () => {
  for (const value of [undefined, null, 42, 'machine', [], [baseConfig()]]) {
    const result = validateDesign(value);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(value)}`);
    assert.equal(result.issues[0]?.code, 'CONFIG_SHAPE');
    assert.equal(result.issues[0]?.path, 'config');
    assert.throws(() => assertDesign(value), /机型配置必须是对象/);
  }
  const missingStations = validateDesign(baseConfig({ stations: undefined }));
  assert.equal(missingStations.issues[0]?.code, 'CONFIG_SHAPE');
  assert.match(missingStations.issues[0]?.message ?? '', /缺少必填参数：机型配置\.stations/);

  const noSensors = validateDesign(baseConfig({ sensors: undefined }));
  assert.equal(noSensors.issues[0]?.code, 'CONFIG_SHAPE');
  assert.match(noSensors.issues[0]?.message ?? '', /缺少必填参数：机型配置\.sensors/);
});

test('三处入口对同一份配置结论一致：合法配置全通过', () => {
  const value = baseConfig({ safety: { emergencyStop: 'X8', safetyDoor: 'X9' } });

  const design = validateDesign(value);
  assert.equal(design.ok, true, JSON.stringify(design.issues));

  const normalized = validateMachineConfig(value);
  assert.deepEqual(normalized.stations, ['上料']);

  const stored = validateMachineDesign({ config: value });
  assert.equal(stored.config.sensors.length, 1);

  assert.deepEqual(precheck(value).errors, []);
});

test('三处入口对同一份配置结论一致：未绑定传感器都报 SENSOR_UNBOUND', () => {
  const value = baseConfig({
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-ghost' }
    ]
  });

  const design = validateDesign(value);
  assert.equal(design.ok, false);
  const designCodes = codes(design).filter((code) => code === 'SENSOR_UNBOUND');
  assert.equal(designCodes.length, 1);

  assert.throws(() => validateMachineConfig(value), /传感器「X1」引用了未定义工位或执行机构「cyl-ghost」/);
  assert.throws(() => validateMachineDesign({ config: value }), /未定义工位或执行机构「cyl-ghost」/);

  const precheckCodes = precheck(value).errors.map((error) => error.code);
  assert.ok(precheckCodes.includes('SENSOR_UNBOUND'), `预检也应报 SENSOR_UNBOUND，实际 ${precheckCodes.join(',')}`);
  assert.equal(precheckCodes.filter((code) => code === 'SENSOR_UNBOUND').length, 1, '同一条绑定问题只报一次');
});
