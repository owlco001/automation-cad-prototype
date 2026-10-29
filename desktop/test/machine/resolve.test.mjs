// 批量解重叠的口径守卫：
// 1) 只动未声明的（suspect），已声明连接不动；
// 2) 每轮只挪一件并重算，挪完必须真的减少；
// 3) 收敛不了要如实说 false，不能假装解开。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConflicts } from '../../src/machine/resolve.ts';
import { screenInterference } from '../../src/machine/interference.ts';

function box(id, center, size, role = 'structure', rotationZDeg = 0) {
  return { id, name: id, role, shape: { type: 'box', size }, center, rotationZDeg };
}

test('两块重叠：一轮解开，结果不再有 suspect', () => {
  const geometry = {
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])]
  };
  const result = resolveConflicts(geometry);
  assert.equal(result.before, 1);
  assert.equal(result.after, 0);
  assert.equal(result.converged, true);
  assert.equal(result.moves.length, 1);
  assert.equal(screenInterference({ ...geometry, parts: result.parts }).count, 0);
});

test('挪开一件会把另一件推到一起时，要逐轮继续解（不是一次算完）', () => {
  // A 与 B 重叠、B 与 C 紧贴；把 A 往上推没问题，但空间很挤，需要多轮
  const geometry = {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [40, 0, 0], [100, 100, 100]),
      box('c', [140, 0, 0], [100, 100, 100])
    ]
  };
  const result = resolveConflicts(geometry);
  assert.ok(result.before >= 1);
  assert.equal(result.after, 0, `残留 ${result.after} 处：${JSON.stringify(result.moves)}`);
  assert.ok(result.moves.length >= 1);
});

test('已声明连接（立柱插横梁）不参与批量解', () => {
  const geometry = {
    joints: [{ a: 'frame-leg-1', b: 'frame-stringer-front', reason: '立柱插横梁' }],
    parts: [
      box('frame-leg-1', [0, 0, 0], [60, 60, 800], 'frame'),
      box('frame-stringer-front', [0, 0, 150], [400, 40, 40], 'frame')
    ]
  };
  const screened = screenInterference(geometry);
  assert.equal(screened.count, 1);
  assert.equal(screened.suspects, 0, '这一对应当被判为已声明');

  const result = resolveConflicts(geometry);
  assert.equal(result.before, 0);
  assert.equal(result.moves.length, 0, '已声明连接不该被挪');
  assert.equal(result.converged, true);
});

test('轮数上限用尽时老实返回 converged=false 并给原因', () => {
  const geometry = {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [30, 0, 0], [100, 100, 100])
    ]
  };
  const result = resolveConflicts(geometry, { maxIterations: 0 });
  assert.equal(result.converged, false);
  assert.ok(result.stopReason && result.stopReason.length > 0);
  assert.equal(result.moves.length, 0);
});

test('不修改传入的 parts（纯函数）', () => {
  const parts = [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])];
  const snapshot = JSON.stringify(parts);
  resolveConflicts({ parts });
  assert.equal(JSON.stringify(parts), snapshot);
});


test('每条调整都带挪动前后的中心坐标（工程师要照着改模型）', () => {
  const geometry = {
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])]
  };
  const result = resolveConflicts(geometry);
  assert.equal(result.moves.length, 1);
  const move = result.moves[0];
  assert.equal(move.from.length, 3);
  assert.equal(move.to.length, 3);
  assert.notDeepEqual(move.from, move.to, '挪完坐标必须变化');
  const axisIndex = ['x', 'y', 'z'].indexOf(move.axis);
  assert.ok(Math.abs(move.to[axisIndex] - move.from[axisIndex] - move.delta) < 1e-6, 'from→to 的差必须等于 delta');
  // 两块体积相同，实现按「先出现的那件」当移动件；只断言 from 是它自己的原始中心
  const expected = geometry.parts.find((part) => part.id === move.partId).center;
  assert.deepEqual(move.from, expected, 'from 必须是该件原始中心');
});
