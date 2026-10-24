import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import {
  COMMISSION_CASES,
  COMMISSION_POINTS,
  POWER_UP_STEPS
} from '../../src/commission/standard.ts';
import {
  describeCommissionCompatibility,
  validateCommissionSteps
} from '../../src/commission/compatibility.ts';

function standardRows() {
  return COMMISSION_POINTS.map((point) => ({
    point: point.id,
    address: `${point.area === 'discrete' || point.area === 'input' ? 'I' : 'Q'}${Math.floor(point.address / 8)}.${point.address % 8}`,
    direction: point.area === 'discrete' || point.area === 'input' ? '输入' : '输出',
    ownerType: '扩展',
    owner: point.name,
    type: '标准数字量',
    station: '标准联调',
    comment: point.name
  }));
}

function resultFor(steps, rows = standardRows(), points = COMMISSION_POINTS) {
  return validateCommissionSteps(steps, rows, points);
}

function testCaseSteps(id) {
  return COMMISSION_CASES.find((entry) => entry.id === id).steps;
}

test('标准功能语义、机型映射和 PLC 点表一致时允许运行标准流程', () => {
  assert.equal(resultFor(POWER_UP_STEPS).compatible, true);
  for (const testCase of COMMISSION_CASES) {
    const result = resultFor(testCase.steps);
    assert.equal(result.compatible, true, `${testCase.name}: ${JSON.stringify(result.issues)}`);
  }
});

test('机型点位 ID 即使重合，功能语义不匹配时也禁用旧固定用例', () => {
  const rows = buildMachineIoMap(demoMachineConfig()).rows;
  const result = validateCommissionSteps(testCaseSteps('jog'), rows, COMMISSION_POINTS);
  assert.equal(result.compatible, false);
  assert.ok(result.issues.some((entry) => entry.code === 'POINT_SEMANTIC_MISMATCH'));
  assert.match(describeCommissionCompatibility(result), /已禁用该联调流程/);
  assert.match(describeCommissionCompatibility(result), /不能只复用相同 ID/);
});

test('机型映射或 PLC 点位表缺点时给出对应的可操作诊断', () => {
  const rows = standardRows().filter((row) => row.point !== 'X6');
  const points = COMMISSION_POINTS.filter((point) => point.id !== 'Y6');
  const result = validateCommissionSteps(testCaseSteps('jog'), rows, points);
  assert.ok(result.issues.some((entry) => entry.code === 'MACHINE_POINT_MISSING' && entry.point === 'X6'));
  assert.ok(result.issues.some((entry) => entry.code === 'PLC_POINT_MISSING' && entry.point === 'Y6'));
  assert.match(describeCommissionCompatibility(result), /在 PLC 点位表中添加/);
  assert.ok(result.issues.some((entry) => entry.action.includes('为该功能分配点位')));
});

test('机型 IO 点位重名、映射地址冲突和 PLC 点位 ID 重复均阻断用例', () => {
  const duplicateRows = standardRows();
  duplicateRows.push({ ...duplicateRows.find((row) => row.point === 'Y6') });
  const duplicatePointRows = validateCommissionSteps(testCaseSteps('jog'), duplicateRows, COMMISSION_POINTS);
  assert.ok(duplicatePointRows.issues.some((entry) => entry.code === 'MACHINE_POINT_DUPLICATE' && entry.point === 'Y6'));

  const conflictRows = standardRows();
  conflictRows.find((row) => row.point === 'Y7').address = conflictRows.find((row) => row.point === 'Y6').address;
  const addressConflict = validateCommissionSteps(testCaseSteps('cylinder'), conflictRows, COMMISSION_POINTS);
  assert.ok(addressConflict.issues.some((entry) => entry.code === 'MACHINE_ADDRESS_DUPLICATE'));

  const duplicatePoint = COMMISSION_POINTS.find((point) => point.id === 'Y6');
  const plcDuplicate = validateCommissionSteps(testCaseSteps('jog'), standardRows(), [...COMMISSION_POINTS, { ...duplicatePoint }]);
  assert.ok(plcDuplicate.issues.some((entry) => entry.code === 'PLC_POINT_DUPLICATE' && entry.point === 'Y6'));

  const plcAlias = validateCommissionSteps(testCaseSteps('jog'), standardRows(), [...COMMISSION_POINTS, { ...duplicatePoint, id: 'Q0.6' }]);
  assert.ok(plcAlias.issues.some((entry) => entry.code === 'PLC_POINT_DUPLICATE' && entry.point === 'Y6'));
});

test('PLC 地址冲突、数字量类型冲突、输入输出方向或读写属性冲突均阻断用例', () => {
  const points = COMMISSION_POINTS.map((point) => ({ ...point }));
  const x6 = points.find((point) => point.id === 'X6');
  const y6 = points.find((point) => point.id === 'Y6');
  x6.dataType = 'uint16';
  y6.writable = false;
  const y7 = points.find((point) => point.id === 'Y7');
  y7.address = y6.address;
  const result = resultFor(testCaseSteps('cylinder'), standardRows(), points);
  assert.ok(result.issues.some((entry) => entry.code === 'POINT_TYPE_MISMATCH' && entry.point === 'X6'));
  assert.ok(result.issues.some((entry) => entry.code === 'POINT_DIRECTION_MISMATCH' && entry.point === 'Y6'));
  assert.ok(result.issues.some((entry) => entry.code === 'PLC_ADDRESS_DUPLICATE'));
});

test('机型点位语义不匹配时提示核对物理功能，不按同名 ID 放行', () => {
  const rows = standardRows();
  const y6 = rows.find((row) => row.point === 'Y6');
  y6.comment = '输出 Y6；压装气缸 缩回';
  y6.owner = '压装气缸';
  y6.type = '气缸·缩回';
  const result = validateCommissionSteps(testCaseSteps('jog'), rows, COMMISSION_POINTS);
  assert.equal(result.compatible, false);
  const semanticIssue = result.issues.find((entry) => entry.code === 'POINT_SEMANTIC_MISMATCH' && entry.point === 'Y6');
  assert.ok(semanticIssue);
  assert.match(semanticIssue.action, /核对机型映射/);
});
