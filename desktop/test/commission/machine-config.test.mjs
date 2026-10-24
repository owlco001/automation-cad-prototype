import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMachineConfig, validateMachineConfig } from '../../src/commission/machine-config.ts';

function minimalConfig(overrides = {}) {
  return {
    id: 'test-machine',
    name: '测试机型',
    stations: ['上料'],
    actuators: [
      {
        id: 'station-1-cylinder',
        name: '上料气缸',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0',
        retractPoint: 'Y4'
      }
    ],
    sensors: [{ point: 'X0', station: '上料', part: 'station-1-cylinder' }],
    ...overrides
  };
}

test('机型配置：合法配置补全默认行程和动作时长', () => {
  const config = validateMachineConfig(minimalConfig());
  assert.equal(config.actuators[0]?.travelMm, 40);
  assert.equal(config.actuators[0]?.durationMs, 400);
  assert.deepEqual(config.stations, ['上料']);
});

test('机型配置：缺少 stations 抛出中文错误', () => {
  assert.throws(() => validateMachineConfig(minimalConfig({ stations: undefined })), /缺少必填参数：机型配置\.stations/);
});

test('机型配置：缺少 actuators 抛出中文错误', () => {
  assert.throws(() => validateMachineConfig(minimalConfig({ actuators: undefined })), /缺少必填参数：机型配置\.actuators/);
});

test('机型配置：点位重复抛出中文错误', () => {
  const value = minimalConfig({
    actuators: [
      {
        id: 'a1',
        name: '气缸 1',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0'
      },
      {
        id: 'a2',
        name: '气缸 2',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0'
      }
    ],
    sensors: []
  });
  assert.throws(() => validateMachineConfig(value), /点位 Y0 重复/);
});

test('机型配置：Y 点与 Q 字节位别名重复时在 IO 收集前报错', () => {
  const value = minimalConfig({
    actuators: [{ id: 'a1', name: '气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0' }],
    sensors: [{ point: 'Q0.0', station: '上料', part: '输出别名' }]
  });
  assert.throws(() => validateMachineConfig(value), /别名冲突/);
});

test('机型配置：执行机构引用未定义工位抛出中文错误', () => {
  const value = minimalConfig();
  value.actuators[0].station = '压装';
  assert.throws(() => validateMachineConfig(value), /未定义工位「压装」/);
});

test('机型配置：传感器引用未定义工位抛出中文错误', () => {
  const value = minimalConfig();
  value.sensors[0].station = '下料';
  assert.throws(() => validateMachineConfig(value), /未定义工位「下料」/);
});

test('机型配置：travelMm 小于等于 0 抛出中文错误', () => {
  const value = minimalConfig();
  value.actuators[0].travelMm = 0;
  assert.throws(() => validateMachineConfig(value), /travelMm 必须大于 0/);
});

test('demo 机型：4 工位、12 执行机构、16 传感器且点位唯一', () => {
  const config = demoMachineConfig();
  assert.equal(config.stations.length, 4);
  assert.equal(config.actuators.length, 12);
  assert.equal(config.sensors.length, 16);
  assert.deepEqual(config.stations, ['上料', '压装', '锁付', '下料']);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'cylinder').length, 4);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'gripper').length, 4);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'rotary').length, 4);
  assert.equal(new Set(config.sensors.map((sensor) => sensor.point)).size, 16);
});
