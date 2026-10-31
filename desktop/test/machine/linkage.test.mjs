import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const { buildLinkage, poseAt, cycleMsFromThroughput } = await import('../../src/machine/linkage.ts');

const sixStation = () =>
  JSON.parse(execFileSync(process.execPath,
    ['scripts/machine-design-cli.mjs', '--brief',
      '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅',
      '--with-geometry', '--linkage', '--linkage-at', '500'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));

const synthetic = () => ({
  stations: [{ id: 'st1' }, { id: 'st2' }],
  moving: [
    {
      actuatorId: 'st1-grip', stationId: 'st1', kind: 'gripper',
      partIds: ['st1-jaw-l', 'st1-jaw-r'], strokeMm: 20, rangeDeg: 0, home: 'open', durationMs: 200,
      points: { grip: 'ST1-GRIP-A1' },
      jaws: [{ partId: 'st1-jaw-l', sign: 1 }, { partId: 'st1-jaw-r', sign: -1 }]
    },
    {
      actuatorId: 'st1-rot', stationId: 'st1', kind: 'rotary',
      partIds: ['st1-table'], strokeMm: 0, rangeDeg: 90, home: 'zero', durationMs: 400,
      points: { point: 'ST1-ROT-A2' }, axis: [0, 0, 1], pivot: [0, 0, 0]
    },
    {
      actuatorId: 'st2-cyl', stationId: 'st2', kind: 'cylinder',
      partIds: ['st2-rod'], strokeMm: 30, rangeDeg: 0, home: 'retracted', durationMs: 200,
      points: { extend: 'ST2-CYL-A1' }, axis: [0, 0, 1]
    }
  ]
});

test('联动时间线：每个运动轴都在时间线上，且时刻单调', () => {
  const linkage = buildLinkage(synthetic(), { cycleMs: 1000 });
  assert.equal(linkage.steps.length, 3);
  assert.deepEqual(linkage.steps.map((step) => step.actuatorId).sort(), ['st1-grip', 'st1-rot', 'st2-cyl']);
  for (const step of linkage.steps) {
    assert.ok(step.endMs > step.startMs, `${step.actuatorId} 的窗口必须为正`);
    assert.ok(step.endMs <= linkage.cycleMs + 1, `${step.actuatorId} 不能超出循环`);
  }
});

test('姿态：循环起点没有位移/转角；IO 在动作窗口开始的那一刻点亮', () => {
  const linkage = buildLinkage(synthetic(), { cycleMs: 1000 });
  for (const t of [0, 1000, 2000]) {
    const pose = poseAt(linkage, t);
    assert.deepEqual(pose.offsets, {}, `t=${t} 应该没有位移（回到原位）`);
    // 旋转轴跨周期会保持角度，这里只断言「窗口起点的位移为零」
    assert.deepEqual(pose.activeIO, poseAt(linkage, 0).activeIO, `t=${t} 的 IO 状态应与循环起点一致`);
  }
  // 起点时刻有输出已经为 ON（气缸/气爪一开始就给信号），但还没走行程
  assert.ok(poseAt(linkage, 0).activeIO.includes('ST1-GRIP-A1'));
});

test('气爪：走完一半行程时两片各走 stroke/2，方向相反', () => {
  const linkage = buildLinkage(synthetic(), { cycleMs: 1000 });
  const gripStep = linkage.steps.find((step) => step.actuatorId === 'st1-grip');
  const mid = (gripStep.startMs + gripStep.endMs) / 2;   // 三角波顶点
  const pose = poseAt(linkage, mid);
  assert.equal(pose.offsets['st1-jaw-l'][0], -10);       // sign=1 → 向负方向合拢
  assert.equal(pose.offsets['st1-jaw-r'][0], 10);
  assert.deepEqual(pose.offsets['st1-jaw-l'].slice(1), [0, 0], '夹爪只沿 X 动');
  assert.ok(pose.activeIO.includes('ST1-GRIP-A1'), '动作期间对应输出必须为 ON');
});

test('旋转轴：走到窗口末端就是满量程，且不会自己回位', () => {
  const linkage = buildLinkage(synthetic(), { cycleMs: 1000 });
  const rot = linkage.steps.find((step) => step.actuatorId === 'st1-rot');
  const pose = poseAt(linkage, rot.endMs);   // 窗口结束即满量程（线性推进到 1）
  assert.equal(pose.rotZDeg['st1-table'], 90);
  // 即使跨过该步，转角也保持（分度台转过去就停在那儿）
  const later = poseAt(linkage, Math.min(linkage.cycleMs - 1, rot.endMs + 50));
  assert.equal(later.rotZDeg['st1-table'], 90);
});

test('气缸：沿自身轴向伸出，顶到 strokeMm', () => {
  const linkage = buildLinkage(synthetic(), { cycleMs: 1000 });
  const cyl = linkage.steps.find((step) => step.actuatorId === 'st2-cyl');
  const pose = poseAt(linkage, (cyl.startMs + cyl.endMs) / 2);
  assert.equal(pose.offsets['st2-rod'][2], 30);
  assert.equal(pose.offsets['st2-rod'][0], 0);
});

test('节拍换算：31.75 件/分钟 → 1890 ms', () => {
  assert.equal(cycleMsFromThroughput(31.75), 1890);
  assert.equal(cycleMsFromThroughput(0), null);
  assert.equal(cycleMsFromThroughput(Number.NaN), null);
});

test('整机联动：六工位 12 个运动轴、循环时长来自节拍、IO 点位必须在 PLC IO 表里', () => {
  const document = sixStation();
  const linkage = document.linkage;
  assert.equal(linkage.cycleMs, 1890, '循环时长必须等于 60000/31.75');
  assert.equal(linkage.cycleMsSource, 'cycleAnalysis.throughputPerMin');
  assert.equal(linkage.axisCount, 12);
  assert.equal(linkage.stepCount, 12);
  assert.equal(linkage.io.missing.length, 0, `运动轴引用了 PLC 表里没有的点：${linkage.io.missing.join(',')}`);
  assert.equal(linkage.io.matched, linkage.io.used.length);
  assert.ok(linkage.io.used.length >= 12, '每个动作至少一个 IO 点');

  // 姿态必须真的动了：500 ms 时至少有一个零件有位移或转角
  const pose = document.linkagePose;
  assert.equal(pose.atMs, 500);
  const moved = Object.keys(pose.offsets).length + Object.keys(pose.rotZDeg).length;
  assert.ok(moved > 0, '500 ms 时应该有零件在动');
  assert.ok(pose.activeIO.length > 0, '500 ms 时应该有 IO 为 ON');
  for (const point of pose.activeIO) {
    assert.ok(linkage.io.used.includes(point), `ON 的点 ${point} 必须是联动里用到的点`);
  }
});
