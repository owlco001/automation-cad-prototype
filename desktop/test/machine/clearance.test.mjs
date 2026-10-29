// 间距初筛的口径：贴面不算重叠、已声明连接不参与、重叠交给干涉初筛
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenClearance } from '../../src/machine/clearance.ts';

function box(id, center, size) {
  return { id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg: 0 };
}

test('两件相隔 10 mm，阈值 20 → 报 1 处，间隙和轴都要对', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [110, 0, 0], [100, 100, 100])] };
  const result = screenClearance(geometry, { thresholdMm: 20 });
  assert.equal(result.count, 1);
  assert.equal(result.pairs[0].gapMm, 10);
  assert.equal(result.pairs[0].axis, 'x');
});

test('相隔 30 mm 超过阈值 → 不报', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [130, 0, 0], [100, 100, 100])] };
  assert.equal(screenClearance(geometry, { thresholdMm: 20 }).count, 0);
});

test('重叠的两件不算间距问题（归干涉初筛）', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])] };
  assert.equal(screenClearance(geometry, { thresholdMm: 20 }).count, 0);
});

test('已声明连接贴在一起不报（用的是 joints.ts 同一份白名单）', () => {
  const geometry = {
    parts: [
      { id: 'frame-leg-1', name: '立柱', role: 'frame', shape: { type: 'box', size: [60, 60, 800] }, center: [0, 0, 0], rotationZDeg: 0 },
      { id: 'frame-stringer-front', name: '横梁', role: 'frame', shape: { type: 'box', size: [400, 40, 40] }, center: [0, 0, 400], rotationZDeg: 0 }
    ]
  };
  assert.equal(screenClearance(geometry, { thresholdMm: 20 }).count, 0);
});

test('按间隙从小到大排，方便先处理最危险的', () => {
  const geometry = {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [115, 0, 0], [100, 100, 100]),
      box('c', [260, 0, 0], [100, 100, 100])
    ]
  };
  // a-b 隔 15，b-c 隔 45：两处都小于阈值 50，且顺序必须是 15 在前
  const result = screenClearance(geometry, { thresholdMm: 50 });
  assert.ok(result.count >= 2);
  for (let index = 1; index < result.pairs.length; index += 1) {
    assert.ok(result.pairs[index - 1].gapMm <= result.pairs[index].gapMm);
  }
});

test('斜着放的两件算真实距离（√(10²+50²)），不是最小正间隙', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [110, 150, 0], [100, 100, 100])] };
  const result = screenClearance(geometry, { thresholdMm: 60 });
  assert.equal(result.count, 1);
  const expected = Math.sqrt(10 ** 2 + 50 ** 2);
  assert.ok(Math.abs(result.pairs[0].gapMm - Math.round(expected * 100) / 100) < 0.01, `实际 ${result.pairs[0].gapMm}`);
  assert.equal(result.pairs[0].axis, 'y', 'Y 方向间隙更大，应当报 y');
});

test('贴面（间隙 ≤0.5 mm）算接触，不报成间距不足', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [100, 0, 0], [100, 100, 100])] };
  assert.equal(screenClearance(geometry, { thresholdMm: 20 }).count, 0, '紧贴的两件不该报');
  const nearly = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [100.4, 0, 0], [100, 100, 100])] };
  assert.equal(screenClearance(nearly, { thresholdMm: 20 }).count, 0, '0.4 mm 仍算接触');
  const realGap = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [103, 0, 0], [100, 100, 100])] };
  assert.equal(screenClearance(realGap, { thresholdMm: 20 }).count, 1, '3 mm 才算间距不足');
});

test('装配贴合 vs 间距问题：同站上下叠、间隙 ≤5 mm 归 contact，不计入 count', () => {
  // 底座上放台面，隔 3 mm：这类是装配贴合，不该当「间距不足」报
  const geometry = {
    parts: [
      box('st1-base', [0, 0, 0], [100, 100, 20]),
      box('st1-table', [0, 0, 23], [100, 100, 20])
    ]
  };
  const tight = screenClearance(geometry, { thresholdMm: 20 });
  assert.equal(tight.count, 0, '贴面 3 mm 应当算 contact，不算间距问题');
  assert.equal(tight.contacts, 1);

  // 隔 12 mm 就真的是间距问题了（仍在阈值内）
  const apart = {
    parts: [
      box('st1-base', [0, 0, 0], [100, 100, 20]),
      box('st1-table', [0, 0, 32], [100, 100, 20])
    ]
  };
  const loose = screenClearance(apart, { thresholdMm: 20 });
  assert.equal(loose.count, 1);
  assert.equal(loose.pairs[0].kind, 'intra');
  assert.equal(loose.contacts, 0);
});
