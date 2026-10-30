import assert from 'node:assert/strict';
import test from 'node:test';

const { partToMember } = await import('../../src/machine/recheck.ts');

test('无转角方块：仍用 min 角对齐 + 减半尺寸的 offset', () => {
  const out = partToMember({ id: 'p', shape: { type: 'box', size: [90, 90, 12] }, center: [100, 200, 6], rotationZDeg: 0 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.member.ops, [{ op: 'box', length: 90, width: 90, height: 12 }]);
  assert.deepEqual(out.member.offset, [55, 155, 0]);
});

test('带转角方块：改为 居中 → 绕自身转 Z → 平移到实际中心', () => {
  const out = partToMember({ id: 'p', shape: { type: 'box', size: [50, 50, 312] }, center: [10, 20, 156], rotationZDeg: 60 });
  assert.equal(out.ok, true, '带转角不再判 unsupported');
  assert.deepEqual(out.member.ops, [
    { op: 'box', length: 50, width: 50, height: 312, anchor: 'center' },
    { op: 'rotate', deg: 60 },
    { op: 'move', x: 10, y: 20, z: 156 }
  ]);
  assert.deepEqual(out.member.offset, [0, 0, 0]);
});

test('转角归一化：-300° 等价于 60°', () => {
  const out = partToMember({ id: 'p', shape: { type: 'box', size: [10, 10, 10] }, center: [0, 0, 0], rotationZDeg: -300 });
  assert.equal(out.member.ops[1].deg, 60);
});

test('沿 Z 圆柱：自转不影响形状，带 rotationZDeg 也不算 unsupported', () => {
  const out = partToMember({ id: 'p', shape: { type: 'cylinder', radius: 70, length: 12, axis: 'z' }, center: [0, 0, 0], rotationZDeg: 45 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.member.ops, [{ op: 'cylinder', diameter: 140, height: 12 }]);
});

test('沿 X 圆柱：仍如实标 unsupported，不假装能复核', () => {
  const out = partToMember({ id: 'p', shape: { type: 'cylinder', radius: 10, length: 100, axis: 'x' }, center: [0, 0, 0], rotationZDeg: 0 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /沿 X 的圆柱/);
});
