import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const { checkMotionEnvelope } = await import('../../src/machine/motion-envelope.ts');

const rotaryLinkage = () => ({
  cycleMs: 1000,
  defaultDurationMs: 400,
  centers: { arm: [100, 0, 0] },
  axes: [{
    actuatorId: 'st1-rot', stationId: 'st1', kind: 'rotary',
    partIds: ['arm'], strokeMm: 0, rangeDeg: 90, home: 'zero', durationMs: 400,
    points: { point: 'ST1-ROT-A1' }, axis: [0, 0, 1], pivot: [0, 0, 0]
  }],
  steps: [{
    stepNo: 1, actuatorId: 'st1-rot', stationId: 'st1', kind: 'rotary',
    startMs: 0, endMs: 400, io: ['ST1-ROT-A1'], amount: 90
  }]
});

const geometryWith = (parts) => ({ parts });

test('旋转扫掠：转臂扫到邻站零件必须报「跨工位疑似碰撞」', () => {
  const geometry = geometryWith([
    { id: 'arm', stationId: 'st1', actuatorId: 'st1-rot', shape: { type: 'box', size: [200, 20, 20] }, center: [100, 0, 0] },
    { id: 'neighbor', stationId: 'st2', shape: { type: 'box', size: [20, 200, 20] }, center: [0, 120, 0] }
  ]);
  const result = checkMotionEnvelope(geometry, rotaryLinkage());
  const cross = result.suspects.filter((item) => item.scope === 'cross-station');
  assert.equal(cross.length, 1, '应当报 1 处跨工位碰撞');
  assert.equal(cross[0].a, 'arm');
  assert.equal(cross[0].b, 'neighbor');
  assert.ok(cross[0].depthMm > 1, `压入深度应可量化：${cross[0].depthMm}`);
  assert.match(result.note, /AABB/, '结论必须写明是 AABB 初筛');
  assert.match(result.note, /布尔/, '结论必须写明要布尔复核');
});

test('转臂够不到邻站时不得误报', () => {
  const geometry = geometryWith([
    { id: 'arm', stationId: 'st1', actuatorId: 'st1-rot', shape: { type: 'box', size: [200, 20, 20] }, center: [100, 0, 0] },
    { id: 'far', stationId: 'st2', shape: { type: 'box', size: [20, 200, 20] }, center: [0, 400, 0] }
  ]);
  const result = checkMotionEnvelope(geometry, rotaryLinkage());
  assert.equal(result.suspects.length, 0);
});

test('两个都不动的零件重叠：属于静态布局问题，不在运动包络里重复报', () => {
  const geometry = geometryWith([
    { id: 'a', stationId: 'st2', shape: { type: 'box', size: [20, 20, 20] }, center: [0, 0, 0] },
    { id: 'b', stationId: 'st2', shape: { type: 'box', size: [20, 20, 20] }, center: [5, 0, 0] }
  ]);
  const emptyLinkage = { cycleMs: 1000, defaultDurationMs: 400, centers: {}, axes: [], steps: [] };
  const result = checkMotionEnvelope(geometry, emptyLinkage);
  assert.equal(result.pairs, 0, '没有动作就没有运动包络，静态重叠不在此列');
});

test('同一执行机构内部（夹爪与自身爪片）不算 suspect', () => {
  const linkage = {
    cycleMs: 1000,
    defaultDurationMs: 200,
    centers: { 'jaw-l': [10, 0, 0], 'jaw-r': [-10, 0, 0] },
    axes: [{
      actuatorId: 'grip', stationId: 'st1', kind: 'gripper', partIds: ['jaw-l', 'jaw-r'],
      strokeMm: 20, rangeDeg: 0, home: 'open', durationMs: 200, points: { grip: 'ST1-GRIP-A1' },
      jaws: [{ partId: 'jaw-l', sign: 1 }, { partId: 'jaw-r', sign: -1 }]
    }],
    steps: [{ stepNo: 1, actuatorId: 'grip', stationId: 'st1', kind: 'gripper', startMs: 0, endMs: 200, io: ['ST1-GRIP-A1'], amount: 20 }]
  };
  const geometry = geometryWith([
    { id: 'jaw-l', stationId: 'st1', actuatorId: 'grip', shape: { type: 'box', size: [10, 10, 10] }, center: [10, 0, 0] },
    { id: 'jaw-r', stationId: 'st1', actuatorId: 'grip', shape: { type: 'box', size: [10, 10, 10] }, center: [-10, 0, 0] }
  ]);
  const result = checkMotionEnvelope(geometry, linkage);
  assert.equal(result.suspects.length, 0);
});

test('整机实测：六工位 60 帧扫掠 —— 无跨工位疑似碰撞，同工位 4 对接触', () => {
  const document = JSON.parse(execFileSync(process.execPath,
    ['scripts/machine-design-cli.mjs', '--brief',
      '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅',
      '--with-geometry', '--motion-check'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })).motionCheck;

  assert.equal(document.frames, 60);
  assert.equal(document.parts, 105);
  assert.equal(document.suspects.length, 0, JSON.stringify(document.suspects.slice(0, 3)));
  assert.equal(document.intraStation, 4);
  assert.ok(document.maxDepthMm > 0, '同工位接触也要量出深度');
  assert.match(document.note, /疑似/);
});
