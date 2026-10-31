import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const parseCsv = (text) => text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/).map((line) => line.split(','));

const runTiming = (brief) => {
  const dir = mkdtempSync(join(tmpdir(), 'linkage-timing-'));
  const csvPath = join(dir, 'timing.csv');
  const document = JSON.parse(execFileSync(process.execPath,
    ['scripts/machine-design-cli.mjs', '--brief', brief, '--with-geometry', '--linkage',
     '--plc-audit', '--linkage-timing-csv', csvPath],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
  return { document, rows: parseCsv(readFileSync(csvPath, 'utf8')) };
};

test('联动步号：stepNo 从 1 开始、连续、与时间顺序一致', () => {
  const { document } = runTiming('三工位锁螺丝机，节拍 25 件/分钟，每工位 1 个伺服拧紧轴 + 1 个气爪 + 到位检测');
  const steps = document.linkage.steps;
  assert.equal(steps.length, 6);
  assert.deepEqual(steps.map((step) => step.stepNo), [1, 2, 3, 4, 5, 6]);
  const sorted = [...steps].sort((a, b) => a.startMs - b.startMs);
  assert.deepEqual(sorted.map((step) => step.stepNo), [1, 2, 3, 4, 5, 6], '步号必须与开始时刻同序');
});

test('调试时序表：表头固定、每步一行、地址与变量都要有', () => {
  const { document, rows } = runTiming('六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅');
  assert.deepEqual(rows[0], ['步号', '执行机构', '点位', '地址', '变量', '开始ms', '结束ms', '时长ms']);

  const body = rows.slice(1);
  assert.equal(body.length, 12, '12 个动作 → 12 行');
  assert.equal(document.linkageTiming.rows, 12);
  assert.deepEqual(document.linkageTiming.unmatched, [], '每个联动点位都要能在 PLC 表里找到地址');

  for (const row of body) {
    assert.match(row[0], /^S\d+$/, `步号格式：${row[0]}`);
    assert.ok(row[2].startsWith('ST'), `点位：${row[2]}`);
    assert.match(row[3], /^[IQ]\d+\.\d+$/, `地址必须是 I/Q 形式：${row[3]}`);
    assert.ok(row[4].length > 0, '变量名不能为空');
    assert.ok(Number(row[7]) > 0, '时长必须为正');
    assert.ok(Number(row[6]) <= document.linkageTiming.cycleMs, '结束时刻不能超出循环');
  }
});

test('调试时序表：时长之和按步统计与循环时长一致（同一循环内）', () => {
  const { document, rows } = runTiming('六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅');
  const body = rows.slice(1);
  const lastEnd = Math.max(...body.map((row) => Number(row[6])));
  assert.equal(lastEnd, document.linkageTiming.cycleMs, '最后一个动作必须收到循环末尾');
  assert.ok(body.every((row) => Number(row[5]) >= 0), '开始时刻不得为负');
});
