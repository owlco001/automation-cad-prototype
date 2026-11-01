import assert from 'node:assert/strict';
import test from 'node:test';
import { linkagePosition } from '../../src/commission/scene3d.ts';

test('联动位移换算：x 直映、y→-z、z→y', () => {
  const p = linkagePosition([1, 2, 3], [10, 20, 30], 0.01);
  assert.equal(p[0], 1.1);      // 1 + 10*0.01
  assert.equal(p[1], 2.3);      // 2 + 30*0.01
  assert.equal(p[2], 2.8);      // 3 - 20*0.01
});

test('没有位移帧时停在原位（不插值、不猜）', () => {
  assert.deepEqual(linkagePosition([5, -2, 7], undefined, 0.01), [5, -2, 7]);
  assert.deepEqual(linkagePosition([5, -2, 7], [0, 0, 0], 0.01), [5, -2, 7]);
});

test('短数组不产生 NaN（缺的参数按 0 处理）', () => {
  assert.deepEqual(linkagePosition([0, 0, 0], [4], 0.5), [2, 0, 0]);
});
