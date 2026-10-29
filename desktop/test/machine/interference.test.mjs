// 干涉初筛（AABB）的口径守卫：
// 1) 结构件共位（立柱插横梁）在示意几何里是正常的，初筛必须能识别并标出来，不能当设计缺陷；
// 2) 挪开零件之后必须真的从结果里消失，否则说明包围盒算错了（旋转/中心点错位最容易出这种事）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenInterference, partBounds } from '../../src/machine/interference.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { buildMachineCase } from '../../src/machine/case.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('声明过的连接（立柱插横梁）标 declared 并给原因，未声明的结构重叠仍然是 suspect', () => {
  const result = screenInterference({
    parts: [
      box('frame-leg-1', [0, 0, 0], [40, 40, 400], 0, 'frame'),
      box('frame-stringer-front', [10, 0, 100], [200, 40, 40], 0, 'frame'),
      box('st1-plate', [10, 0, 110], [120, 120, 10], 0, 'plate')  // 跟横梁、立柱都重叠
    ]
  });
  const declaredPair = result.pairs.find((pair) => pair.kind === 'declared');
  assert.ok(declaredPair, '立柱×横梁应被判为已声明');
  assert.equal(declaredPair.reason, '立柱插横梁');
  // 横梁 × 工位底板：结构件之间，但没声明过 → 必须报出来，不能因为「都是结构件」就放行
  const suspect = result.pairs.find((pair) => pair.a === 'frame-stringer-front' && pair.b === 'st1-plate');
  assert.ok(suspect, '未声明的结构重叠要出现');
  assert.equal(suspect.kind, 'suspect');
  assert.equal(result.declared, 1);
  assert.ok(result.suspects >= 1, `suspects=${result.suspects}`);
  assert.equal(result.structuralOnly, false);
  assert.ok(result.declaredJoints >= 1);
});

test('执行机构撞到台面时一定不是 declared（这种才要看）', () => {
  const result = screenInterference({
    parts: [
      box('frame-top', [0, 0, 0], [500, 500, 20], 0, 'frame'),
      box('st1-gripper-1-body', [0, 0, 5], [60, 60, 120], 0, 'actuator')
    ]
  });
  assert.equal(result.count, 1);
  assert.equal(result.structuralOnly, false);
  assert.equal(result.suspects, 1);
  assert.equal(result.pairs[0].bRole, 'actuator');
});


test('几何生成器自己产出 joints，初筛直接用它（不靠命名规则）', { timeout: 120_000 }, () => {
  // 用真实管线造 config：手写 config 容易漏必填字段，测出来的是假问题
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const { design } = buildMachineCase({
    brief: '四工位点胶机，节拍 25 件/分钟，每工位 1 套步进 + 1 个气爪 + 1 个到位检测',
    partsDir: resolve(repoRoot, 'packs', 'builtin')
  });
  const geometry = generateMachineGeometry(design.config, {});
  const joints = geometry.joints ?? [];
  assert.ok(joints.length > 0, '生成器应产出结构连接');
  assert.ok(joints.some((joint) => joint.reason === '立柱接台面'), '应含立柱接台面');
  assert.ok(joints.some((joint) => joint.reason === '立柱插横梁'), '应含立柱插横梁');

  const result = screenInterference(geometry);
  assert.equal(result.jointSource, 'generator');
  // 机架内部的全部重叠都必须在声明表里，不能有 frame×frame 的漏网 suspect
  const frameSuspect = result.pairs.find(
    (pair) => pair.kind === 'suspect' && pair.aRole === 'frame' && pair.bRole === 'frame'
  );
  assert.equal(frameSuspect, undefined, `有未声明的结构重叠：${frameSuspect?.a} × ${frameSuspect?.b}`);
});

test('外部 geometry 没有 joints 字段时退回命名规则，并标 jointSource=rules', () => {
  const result = screenInterference({
    parts: [
      { id: 'frame-leg-1', name: 'L', role: 'frame', shape: { type: 'box', size: [10, 10, 10] }, center: [0, 0, 0] },
      { id: 'frame-stringer-front', name: 'S', role: 'frame', shape: { type: 'box', size: [10, 10, 10] }, center: [5, 0, 0] }
    ]
  });
  assert.equal(result.jointSource, 'rules');
  assert.equal(result.declared, 1);
  assert.equal(result.pairs[0].reason, '立柱插横梁');
});

test('圆柱绕 Z 转不放大包围盒（按方块算会凭空多出 √2 倍）', () => {
  const straight = partBounds({ shape: { type: 'cylinder', radius: 50, length: 40, axis: 'z' }, center: [0, 0, 0], rotationZDeg: 0 });
  const turned = partBounds({ shape: { type: 'cylinder', radius: 50, length: 40, axis: 'z' }, center: [0, 0, 0], rotationZDeg: 60 });
  assert.equal(straight.max[0], 50);
  assert.equal(turned.max[0], 50, '旋转后 X 半宽仍应是半径');
  assert.equal(turned.max[1], 50, '旋转后 Y 半宽仍应是半径');
});
