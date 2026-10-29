// 干涉初筛（AABB）的口径守卫：
// 1) 结构件共位（立柱插横梁）在示意几何里是正常的，初筛必须能识别并标出来，不能当设计缺陷；
// 2) 挪开零件之后必须真的从结果里消失，否则说明包围盒算错了（旋转/中心点错位最容易出这种事）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenInterference, partBounds } from '../../src/machine/interference.ts';

function box(id, center, size, rotationZDeg = 0, role = 'frame') {
  return { id, name: id, role, shape: { type: 'box', size }, center, rotationZDeg };
}

test('两个重叠的块能筛出来，体积按 AABB 算', () => {
  const result = screenInterference({
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [50, 0, 0], [100, 100, 100])]
  });
  assert.equal(result.mode, 'aabb');
  assert.equal(result.count, 1);
  assert.equal(result.pairs[0].overlapMm3, 50 * 100 * 100);
  assert.deepEqual(result.pairs[0].overlapBox, [50, 100, 100]);
});

test('贴面接触（重叠 0）不算干涉', () => {
  const result = screenInterference({
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [100, 0, 0], [100, 100, 100])]
  });
  assert.equal(result.count, 0);
});

test('挪开零件后干涉消失（守住中心点/包围盒换算）', () => {
  const parts = [box('a', [0, 0, 0], [100, 100, 100]), box('b', [50, 0, 0], [100, 100, 100])];
  assert.equal(screenInterference({ parts }).count, 1);
  const moved = [parts[0], { ...parts[1], center: [500, 0, 0] }];
  assert.equal(screenInterference({ parts: moved }).count, 0);
});

test('绕 Z 转 45° 的长条，包围盒按旋转后外接尺寸算', () => {
  const bounds = partBounds(box('bar', [0, 0, 0], [100, 10, 10], 45));
  const expected = (100 / 2) * Math.cos(Math.PI / 4) + (10 / 2) * Math.sin(Math.PI / 4);
  assert.ok(Math.abs(bounds.max[0] - expected) < 1e-6, `max.x=${bounds.max[0]} expected=${expected}`);
});

test('全是结构件的疑似对要标 structuralOnly（避免被当成设计缺陷）', () => {
  const result = screenInterference({
    parts: [
      box('leg', [0, 0, 0], [50, 50, 500], 0, 'frame'),
      box('stringer', [20, 0, 200], [200, 40, 40], 0, 'frame')
    ]
  });
  assert.equal(result.count, 1);
  assert.equal(result.structuralOnly, true);
});

test('执行机构撞到台面时 structuralOnly=false（这种才要看）', () => {
  const result = screenInterference({
    parts: [
      box('table', [0, 0, 0], [500, 500, 20], 0, 'frame'),
      box('cylinder', [0, 0, 5], [60, 60, 120], 0, 'actuator')
    ]
  });
  assert.equal(result.count, 1);
  assert.equal(result.structuralOnly, false);
  assert.equal(result.pairs[0].bRole, 'actuator');
});
