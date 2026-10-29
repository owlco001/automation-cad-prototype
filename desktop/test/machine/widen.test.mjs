// 「线体加宽」的口径：工位按序号右移、机架跟着按比例拉长，站内相对位置不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { widenMachine, minWidening } from '../../src/machine/widen.ts';

function box(id, center, size) {
  return { id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg: 0 };
}

const geometry = {
  parts: [
    box('frame-top', [0, 0, 0], [1000, 100, 20]),
    box('st1-plate', [-300, 0, 100], [100, 100, 10]),
    box('st2-plate', [0, 0, 100], [100, 100, 10]),
    box('st3-plate', [300, 0, 100], [100, 100, 10])
  ]
};

test('加宽 0：零件位置和尺寸都不动', () => {
  const widened = widenMachine(geometry, 0);
  assert.deepEqual(widened.parts.map((p) => p.center), geometry.parts.map((p) => p.center));
  assert.deepEqual(widened.parts.map((p) => p.shape.size), geometry.parts.map((p) => p.shape.size));
});

test('加宽 100：站按序号右移 0/100/200，站内尺寸不变，机架被拉长', () => {
  const widened = widenMachine(geometry, 100);
  const byId = new Map(widened.parts.map((part) => [part.id, part]));
  assert.deepEqual(byId.get('st1-plate').center, [-300, 0, 100], '第 1 站不动');
  assert.deepEqual(byId.get('st2-plate').center, [100, 0, 100], '第 2 站 +100');
  assert.deepEqual(byId.get('st3-plate').center, [500, 0, 100], '第 3 站 +200');
  assert.deepEqual(byId.get('st2-plate').shape.size, [100, 100, 10], '站内板件尺寸不跟着放大');
  // 跨度 600 → 800，factor = 800/600；机架 X 尺寸必须跟着放大
  const frame = byId.get('frame-top');
  assert.ok(Math.abs(frame.shape.size[0] - 1000 * (800 / 600)) < 1e-6, `机架宽 ${frame.shape.size[0]}`);
});

test('加宽不修改入参（纯函数）', () => {
  const snapshot = JSON.stringify(geometry);
  widenMachine(geometry, 200);
  assert.equal(JSON.stringify(geometry), snapshot);
});

test('minWidening：本来就合规时返回 0，不必加宽', () => {
  const spaced = {
    parts: [
      box('frame-top', [0, 0, 0], [2000, 100, 20]),
      box('st1-plate', [-400, 0, 100], [100, 100, 10]),
      box('st2-plate', [400, 0, 100], [100, 100, 10])
    ]
  };
  const result = minWidening(spaced, { clearanceMm: 20, maxExtraMm: 400 });
  assert.equal(result.reachable, true);
  assert.equal(result.extraMm, 0);
  assert.equal(result.probes.length, 1, '第一次探测就收敛，不该继续二分');
});
