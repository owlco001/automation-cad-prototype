import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLinkageView } from '../../src/machine/linkage-view.ts';

test('正常联动：结论行与节拍按循环时间算', () => {
  const view = formatLinkageView({
    cycleMs: 1890,
    axes: [{ id: 'st1-gripper-1', point: 'ST1-GRIP-A1' }, { id: 'st1-rotary-1', point: 'ST1-ROT-A1' }],
    steps: [
      { stepNo: 1, actuator: 'st1-gripper-1', point: 'ST1-GRIP-A1', startMs: 0, durationMs: 280 },
      { stepNo: 2, actuator: 'st1-rotary-1', point: 'ST1-ROT-A1', startMs: 280, durationMs: 400 }
    ]
  });
  assert.equal(view.headline, '2 轴 / 2 步 / 循环 1.89 s');
  assert.equal(view.steps[0].stepNo, 1);
  assert.equal(view.steps[1].endMs, 680);
  const beat = view.lines.find((line) => line.label === '节拍');
  assert.equal(beat.value, '31.7 件/分钟');   // 60000/1890
  assert.deepEqual(view.warnings, []);
});

test('缺循环时间：如实说无法播放，不拿 0 当节拍', () => {
  const view = formatLinkageView({ axes: [{ id: 'a' }], steps: [] });
  assert.match(view.headline, /缺循环时间/);
  assert.equal(view.lines.find((l) => l.label === '节拍').value, '—');
  assert.ok(view.warnings.some((w) => w.includes('没有步序')));
});

test('轴没点位要点名（播放不会驱动它）', () => {
  const view = formatLinkageView({ cycleMs: 1000, axes: [{ id: 'st2-rotary' }, { id: 'ok', point: 'P1' }], steps: [] });
  assert.ok(view.warnings.some((w) => w.includes('st2-rotary')));
});

test('endMs 缺失时按 start+duration 兜底', () => {
  const view = formatLinkageView({ cycleMs: 1000, axes: [], steps: [{ startMs: 100, durationMs: 50 }] });
  assert.equal(view.steps[0].endMs, 150);
  assert.equal(view.steps[0].stepNo, 1);
});

test('真实 CLI 形状：axisCount / actuatorId / io[] / endMs（不是 axes/actuator/point）', () => {
  const view = formatLinkageView({
    axisCount: 12,
    stepCount: 2,
    cycleMs: 1890,
    cycleMsSource: 'throughput',
    steps: [
      { stepNo: 1, actuatorId: 'st1-gripper-1', stationId: 'st1', kind: 'gripper', startMs: 0, endMs: 280, io: ['ST1-GRIP-A1'], amount: 20 },
      { stepNo: 2, actuatorId: 'st2-gripper-1', stationId: 'st2', kind: 'gripper', startMs: 182, endMs: 462, io: ['ST2-GRIP-A1'], amount: 20 }
    ],
    frames: [{ tMs: 236, offsets: { 'st1-gripper-1-jaw-l': [-3.1, 0, 0] }, rotZDeg: {} }]
  });
  assert.equal(view.headline, '12 轴 / 2 步 / 循环 1.89 s');
  assert.equal(view.lines.find((l) => l.label === '运动轴').value, '12 个');
  assert.equal(view.steps[0].actuator, 'st1-gripper-1');
  assert.equal(view.steps[0].point, 'ST1-GRIP-A1');
  assert.equal(view.steps[0].durationMs, 280);
  assert.equal(view.steps[1].endMs, 462);
  assert.deepEqual(view.warnings, []);
});
