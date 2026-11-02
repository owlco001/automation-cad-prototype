// 「联动可动层」：零件 id → 场景里真实网格的索引，惰性构建 + 幂等 + 位姿可写可复位。
//
// 背景（真实缺陷）：`buildMachineBody` 写完从未被调用，联动帧给的整机零件 id 在场景里
// 找不到对应网格，CI smoke 只能打 `SMOKE_LINKAGE_POSE_SKIP reason=empty_scene`。
// 这里锁住四件事：
//   1) 打开视口/面板时能建出索引（ensureMachineBody 幂等，重复调用 0 件新增）；
//   2) 复用整机模型的真实网格，不再叠一层盒子（否则整机重影、动的是盒子不是零件）；
//   3) 位移按 mm 直接写进 mesh 局部坐标（Z 向上），复位精确回到基准；
//   4) dispose 只拆自己的东西，索引清零、可重复调用。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { createScene3D } from '../../src/commission/scene3d.ts';

const config = demoMachineConfig();

/** 数一遍整机模型里的 mesh 数量：用来证明索引层没有往场景里塞新网格。 */
function countMeshes(object) {
  let count = 0;
  object.traverse((node) => {
    if (node.isMesh) count += 1;
  });
  return count;
}

test('可动层：ensureMachineBody 索引当前机型全部零件，重复调用不重复建', () => {
  const scene = createScene3D({}, config, () => 0);
  const geometry = scene.machineGeometry();
  assert.ok(geometry && geometry.parts.length > 0);

  // 开视口前还没索引：smoke 之所以报空场景，就是因为这条路径从来没被触发
  assert.equal(scene.stats().bodyParts, 0);

  const built = scene.ensureMachineBody();
  assert.ok(built > 0, 'ensureMachineBody 必须真的建出可动层');
  assert.equal(scene.stats().bodyParts, built);
  assert.equal(scene.machineBodyCount(), built);

  // 幂等：第二、第三次不新增任何条目
  assert.equal(scene.ensureMachineBody(), 0);
  assert.equal(scene.ensureMachineBody(), 0);
  assert.equal(scene.stats().bodyParts, built);

  // 每个几何零件 id 都能读回坐标（联动帧按 id 写位姿的前提）
  const positions = scene.debugPositions();
  for (const part of geometry.parts) {
    assert.ok(Array.isArray(positions[part.id]), `零件 ${part.id} 没有对应网格`);
  }
});

test('可动层：复用整机真实网格，不往场景里叠第二层盒子', () => {
  const scene = createScene3D({}, config, () => 0);
  // TS 的 private 只在类型层：这里直接拿整机模型根节点，数它下面的 mesh
  const root = scene['machine']?.root ?? null;
  assert.ok(root, '场景里应当有整机模型根节点');
  const meshesBefore = countMeshes(root);

  scene.ensureMachineBody();
  assert.equal(countMeshes(root), meshesBefore, '索引层不得新增 mesh（否则整机会重影）');

  // 静态零件的矩阵原本被 buildThreeMachine 冻结，索引后必须恢复自动更新，否则写位姿不生效
  const mesh = scene['bodyMeshes'].values().next().value?.mesh;
  assert.ok(mesh, '索引里应当有零件网格');
  assert.equal(mesh.matrixAutoUpdate, true);
  assert.equal(typeof mesh.userData.partId, 'string');
});

test('可动层：positions 键来自几何，位移按 mm 写入并精确复位', () => {
  const scene = createScene3D({}, config, () => 0);
  const geometry = scene.machineGeometry();
  assert.ok(geometry);
  scene.ensureMachineBody();

  const id = geometry.parts[0].id;
  const before = scene.debugPositions()[id];
  assert.ok(Array.isArray(before));

  const applied = scene.applyLinkagePose({ offsets: { [id]: [100, 0, 0] } });
  assert.ok(applied >= 1, '有位移帧的零件必须被计入 applied');
  const moved = scene.debugPositions()[id];
  // mm 直接叠加：100 mm 就是 100，不再乘场景缩放（乘错就是零件飞出视锥）
  assert.ok(Math.abs(moved[0] - before[0] - 100) < 1e-9);
  assert.ok(Math.abs(moved[1] - before[1]) < 1e-9);
  assert.ok(Math.abs(moved[2] - before[2]) < 1e-9);

  // 复位 = 传空位姿（offsets 空、rotZDeg 空）
  scene.applyLinkagePose({});
  const reset = scene.debugPositions()[id];
  assert.ok(Math.abs(reset[0] - before[0]) < 1e-9);
  assert.ok(Math.abs(reset[1] - before[1]) < 1e-9);
  assert.ok(Math.abs(reset[2] - before[2]) < 1e-9);
});

test('可动层：三个方向的位移都按 Z 向上口径落到 mesh 上', () => {
  const scene = createScene3D({}, config, () => 0);
  const geometry = scene.machineGeometry();
  assert.ok(geometry);
  scene.ensureMachineBody();

  const id = geometry.parts.find((part) => part.moving)?.id ?? geometry.parts[0].id;
  const before = scene.debugPositions()[id];
  scene.applyLinkagePose({ offsets: { [id]: [10, -20, 30] } });
  const moved = scene.debugPositions()[id];
  assert.ok(Math.abs(moved[0] - before[0] - 10) < 1e-9);
  assert.ok(Math.abs(moved[1] - before[1] + 20) < 1e-9);
  assert.ok(Math.abs(moved[2] - before[2] - 30) < 1e-9);

  // 复位后与建索引时完全一致（转角一起收回）
  scene.applyLinkagePose({});
  assert.deepEqual(scene.debugPositions()[id], before);
});

test('可动层：换一份零件集合会重建索引，件数不多不少', () => {
  const scene = createScene3D({}, config, () => 0);
  const parts = scene.machineBodyParts();
  assert.ok(parts.length > 5);

  assert.equal(scene.buildMachineBody(parts), parts.length);
  assert.equal(scene.buildMachineBody(parts), 0);
  assert.equal(scene.machineBodyCount(), parts.length);

  const narrowed = parts.slice(0, 5);
  assert.equal(scene.buildMachineBody(narrowed), 5);
  assert.equal(scene.machineBodyCount(), 5);

  assert.equal(scene.buildMachineBody([]), 0);
  assert.equal(scene.machineBodyCount(), 0);
});

test('可动层：dispose 清空索引，可重复调用', () => {
  const scene = createScene3D({}, config, () => 0);
  scene.ensureMachineBody();
  assert.ok(scene.stats().bodyParts > 0);
  scene.dispose();
  assert.equal(scene.stats().bodyParts, 0);
  assert.equal(scene.machineBodyCount(), 0);
  assert.doesNotThrow(() => scene.dispose());
});
