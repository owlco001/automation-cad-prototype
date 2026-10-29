// 「一键排布合规」的守卫：交替两段、收敛判据是「重叠=0 且间距=0」，达不到必须如实说。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout } from '../../src/machine/layout.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { screenClearance } from '../../src/machine/clearance.ts';

function box(id, center, size) {
  return { id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg: 0 };
}

test('既有一对重叠、又有一对太近：一轮交替后两类都为 0', () => {
  const geometry = {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [30, 0, 0], [100, 100, 100]),   // 与 a 重叠
      box('c', [145, 0, 0], [100, 100, 100])   // 与 b 相距 15 mm（<20）
    ]
  };
  assert.ok(screenInterference(geometry).suspects >= 1);
  assert.ok(screenClearance(geometry, { thresholdMm: 20 }).count >= 1);

  const result = resolveLayout(geometry, { clearanceMm: 20 });
  assert.equal(result.converged, true, result.stopReason);
  assert.equal(result.suspects, 0);
  assert.equal(result.clearance, 0);
  const finalGeometry = { ...geometry, parts: result.parts };
  assert.equal(screenInterference(finalGeometry).suspects, 0, '跑完不该还有未声明重叠');
  assert.equal(screenClearance(finalGeometry, { thresholdMm: 20 }).count, 0, '跑完不该还有间距不足');
  assert.ok(result.moves.some((move) => move.kind === 'overlap'));
  assert.ok(result.moves.some((move) => move.kind === 'clearance'));
});

test('轮数上限 0 时如实返回 converged=false，且不做任何挪动', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])] };
  const result = resolveLayout(geometry, { clearanceMm: 20, maxRounds: 0 });
  assert.equal(result.converged, false);
  assert.ok(result.stopReason);
  assert.equal(result.moves.length, 0);
  assert.equal(result.rounds.length, 0);
});

test('每轮都记录「进轮前的两类问题数」和「出轮后的两类问题数」', () => {
  const geometry = {
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])]
  };
  const result = resolveLayout(geometry, { clearanceMm: 20 });
  assert.ok(result.rounds.length >= 1);
  const first = result.rounds[0];
  assert.equal(first.round, 1);
  assert.ok(first.suspectsBefore >= 1);
  assert.equal(typeof first.clearanceBefore, 'number');
  assert.equal(first.suspectsAfter, 0);
  assert.equal(first.clearanceAfter, 0);
});

test('不修改入参（纯函数）', () => {
  const parts = [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])];
  const snapshot = JSON.stringify(parts);
  resolveLayout({ parts }, { clearanceMm: 20 });
  assert.equal(JSON.stringify(parts), snapshot);
});
