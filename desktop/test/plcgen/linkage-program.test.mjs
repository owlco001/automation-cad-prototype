import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const { planPlcGaps, repairPlcConfig } = await import('../../src/plcgen/machine-gaps.ts');
const { buildSequenceFromLinkage, auditLinkageVsProgram } = await import('../../src/plcgen/linkage-program.ts');

const baseConfig = () => ({
  id: 'unit',
  name: '单元机',
  stations: [{ id: 'st1', name: '工位1' }],
  actuators: [
    { id: 'st1-grip', name: '工位1夹爪1', station: '工位1', type: 'gripper', extendPoint: 'ST1-GRIP-A1', retractPoint: 'ST1-GRIP-A2' },
    { id: 'st1-rot', name: '工位1旋转轴2', station: '工位1', type: 'rotary', extendPoint: 'ST1-ROT-A1', retractPoint: 'ST1-ROT-A2' }
  ],
  sensors: [
    { point: 'ST1-PRX-1', part: 'st1-grip', name: '夹爪到位' }
  ]
});

test('缺口诊断：缺传感器的执行机构给出「补哪个点、补到谁身上」', () => {
  const plan = planPlcGaps(baseConfig());
  const missing = plan.errors.filter((gap) => gap.code === 'ACTUATOR_SENSOR_MISSING');
  assert.equal(missing.length, 1, '只应报 st1-rot 缺传感器');
  assert.match(missing[0].message, /旋转轴2/);
  assert.equal(missing[0].fix.kind, 'add-sensor');
  assert.equal(missing[0].fix.sensor.part, 'st1-rot');
  assert.equal(missing[0].fix.sensor.point, 'ST1-ROT-PRX-1');
});

test('补齐后重新预检：传感器缺口补上、急停与安全门一并补齐，补完不再报这三类', () => {
  const plan = planPlcGaps(baseConfig());
  const repair = repairPlcConfig(baseConfig(), plan);
  // 这份配置同时缺：1 个执行机构传感器 + 急停回路 + 安全门回路
  assert.equal(repair.applied.length, 3);
  assert.equal(repair.config.sensors.length, 2);
  for (const code of ['ACTUATOR_SENSOR_MISSING', 'ESTOP_UNDEFINED', 'SAFETY_DOOR_UNDEFINED']) {
    assert.ok(!repair.remainingErrors.some((error) => error.code === code), `${code} 应该已被补齐`);
  }
});

test('补齐是幂等的：同一份配置补两次不会长出重复传感器', () => {
  const first = repairPlcConfig(baseConfig(), planPlcGaps(baseConfig()));
  const second = repairPlcConfig(first.config, planPlcGaps(first.config));
  assert.equal(second.applied.length, 0, '已经补过的配置不应再补');
  assert.equal(second.config.sensors.length, first.config.sensors.length);
});

const linkage = () => ({
  cycleMs: 1200,
  steps: [
    { actuatorId: 'st1-grip', stationId: 'st1', kind: 'gripper', startMs: 0, endMs: 200, io: ['ST1-GRIP-A1'], amount: 20 },
    { actuatorId: 'st1-rot', stationId: 'st1', kind: 'rotary', startMs: 200, endMs: 600, io: ['ST1-ROT-A2'], amount: 90 }
  ]
});

test('步序生成：一步一个动作、输出来自联动、超时 = 2×时长（下限 1 s）', () => {
  const config = repairPlcConfig(baseConfig(), planPlcGaps(baseConfig())).config;
  const steps = buildSequenceFromLinkage(linkage(), config);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0].sets, ['ST1-GRIP-A1']);
  assert.equal(steps[0].timeoutMs, 1000, '200 ms × 2 = 400 → 下限 1000');
  assert.equal(steps[1].timeoutMs, 1000, '400 ms × 2 = 800 → 下限 1000');
  // 有传感器的执行机构必须带等待，没传感器的不能编一个
  assert.deepEqual(steps[0].waits, ['ST1-PRX-1']);
  assert.deepEqual(steps[1].waits, ['ST1-ROT-PRX-1']);
});

test('步序生成：执行机构没有传感器时 waits 为空，不伪造等待点', () => {
  const config = JSON.parse(JSON.stringify(baseConfig()));
  config.sensors = [];
  const steps = buildSequenceFromLinkage(linkage(), config);
  assert.deepEqual(steps[0].waits, []);
  assert.deepEqual(steps[1].waits, []);
});

test('对账：点位不在 PLC 表里 / 没被步序驱动 / 程序没引用 / 没有安全门 都要如实报', () => {
  const audit = auditLinkageVsProgram(linkage(), [
    { point: 'ST1-GRIP-A1', address: 'Q0.0', variable: '工位1_夹爪_伸出', stepUsage: ['S1'] }
    // ST1-ROT-A2 完全缺席
  ], 'CASE 1: 工位1_夹爪_伸出 := TRUE;', 1);

  assert.equal(audit.ok, false);
  assert.equal(audit.pointsInPlcTable, 1);
  assert.equal(audit.pointsDriven, 1);
  assert.equal(audit.safetyGate, false);
  const kinds = audit.gaps.map((gap) => gap.kind);
  assert.ok(kinds.includes('point-missing-in-plc'), '缺 ST1-ROT-A2 要报');
  assert.ok(kinds.includes('no-safety-gate'), '没有 SafeStop 要报');
  assert.ok(kinds.includes('step-count-mismatch'), '1 步 vs 2 个动作要报');
});

test('对账：点位在表里但 stepUsage 为空 → 「3D 会动、PLC 不动」', () => {
  const audit = auditLinkageVsProgram(linkage(), [
    { point: 'ST1-GRIP-A1', variable: 'A', stepUsage: [] },
    { point: 'ST1-ROT-A2', variable: 'B', stepUsage: [] }
  ], 'SafeStop', 2);
  const notDriven = audit.gaps.filter((gap) => gap.kind === 'point-not-driven');
  assert.equal(notDriven.length, 2);
});

const runAudit = (brief) => JSON.parse(execFileSync(process.execPath,
  ['scripts/machine-design-cli.mjs', '--brief', brief, '--with-geometry', '--plc-audit'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })).plcAudit;

test('整机端到端：三工位 —— 5 处缺口全部可补、PLC 工程 11 文件、6 步、6/6 点位被驱动', () => {
  const audit = runAudit('三工位锁螺丝机，节拍 25 件/分钟，每工位 1 个伺服拧紧轴 + 1 个气爪 + 到位检测');
  assert.equal(audit.gapsFound, 5);
  assert.equal(audit.autoFixable, 5);
  assert.equal(audit.applied.length, 5);
  assert.deepEqual(audit.remainingErrors, []);
  assert.equal(audit.generated, true);
  assert.equal(audit.files, 11);
  assert.equal(audit.sequenceSteps, 6);
  assert.equal(audit.audit.linkageSteps, 6);
  assert.equal(audit.audit.pointsInPlcTable, 6);
  assert.equal(audit.audit.pointsDriven, 6);
  assert.equal(audit.audit.safetyGate, true);
  assert.equal(audit.audit.ok, true);
});

test('整机端到端：六工位 —— 8 处缺口、12 步、12/12 点位被驱动、0 处对账缺口', () => {
  const audit = runAudit('六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅');
  assert.equal(audit.gapsFound, 8);
  assert.equal(audit.applied.length, 8);
  assert.equal(audit.sequenceSteps, 12);
  assert.equal(audit.plcPoints, 27);
  assert.equal(audit.audit.pointsInPlcTable, 12);
  assert.equal(audit.audit.pointsDriven, 12);
  assert.equal(audit.audit.gaps.length, 0, JSON.stringify(audit.audit.gaps));
});
