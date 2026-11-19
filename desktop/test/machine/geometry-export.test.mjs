import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import {
  buildMachineSolids,
  geometryToGltf,
  geometryToSidecarAssemblies,
  geometryToStl,
  geometryTriangleCount,
  machineExportParts,
  partLocalMesh,
  partSidecarFeatures
} from '../../src/machine/geometry-export.ts';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { resolveBufferTowerModelInput } from '../../src/machine/model-builders.ts';
import { MAX_ASSEMBLY_CHUNK, compileOps, validateFeatures } from '../../src/parametric/features.ts';

const UPDATED_AT = '2026-10-24T01:00:00+08:00';

function geometryFor(brief = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服', options = {}) {
  return generateMachineGeometry(synthMachine(parseMachineBrief(brief), options));
}

test('导出 STL：二进制长度 = 84 + 50×三角形数，法向为单位向量，顶点包络 = 几何 bounds', () => {
  const geometry = geometryFor();
  const stl = geometryToStl(geometry);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const count = view.getUint32(80, true);
  assert.equal(count, geometryTriangleCount(geometry));
  assert.equal(stl.byteLength, 84 + 50 * count);
  assert.match(new TextDecoder().decode(stl.slice(0, 80)), /AutomationCAD machine-geometry design-screw-3st mm/);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t += 1) {
    const offset = 84 + t * 50;
    const n = [0, 1, 2].map((k) => view.getFloat32(offset + k * 4, true));
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-3, `第 ${t} 个三角形法向`);
    for (let v = 0; v < 3; v += 1) {
      for (let k = 0; k < 3; k += 1) {
        const value = view.getFloat32(offset + 12 + (v * 3 + k) * 4, true);
        min[k] = Math.min(min[k], value);
        max[k] = Math.max(max[k], value);
      }
    }
  }
  for (let k = 0; k < 3; k += 1) {
    // 圆柱按多边形近似，顶点只会落在 bounds 内侧。
    assert.ok(min[k] >= geometry.bounds.min[k] - 0.01 && max[k] <= geometry.bounds.max[k] + 0.01, `axis ${k}`);
  }
  // Z 由方形零件（地面立腿、门架）决定，必须精确。
  assert.ok(Math.abs(min[2] - geometry.bounds.min[2]) < 0.01);
  assert.ok(Math.abs(max[2] - geometry.bounds.max[2]) < 0.01);
});

test('导出网格：圆柱沿声明轴向，盒体 12 个三角形', () => {
  const box = partLocalMesh({ shape: { type: 'box', size: [10, 20, 30] } });
  assert.equal(box.positions.length / 9, 12);
  const cylinder = partLocalMesh({ shape: { type: 'cylinder', radius: 6, length: 45, axis: 'y' } }, 16);
  assert.equal(cylinder.positions.length / 9, 16 * 4);
  const extent = [0, 1, 2].map((k) => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = k; i < cylinder.positions.length; i += 3) {
      low = Math.min(low, cylinder.positions[i]);
      high = Math.max(high, cylinder.positions[i]);
    }
    return Math.round((high - low) * 1000) / 1000;
  });
  assert.deepEqual(extent, [12, 45, 12]);
});

test('导出 glTF：2.0、节点 = 零件 + 根、根节点 Z→Y 旋转、缓冲长度与 data URI 一致、extras 带运动轴', () => {
  const geometry = geometryFor();
  const gltf = geometryToGltf(geometry);
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.nodes.length, geometry.parts.length + 1);
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  assert.equal(root.children.length, geometry.parts.length);
  assert.ok(Math.abs(root.rotation[0] + Math.SQRT1_2) < 1e-9);
  assert.equal(root.extras.moving.length, geometry.moving.length);
  assert.deepEqual(root.extras.envelopeMm, geometry.envelope);
  const buffer = gltf.buffers[0];
  const decoded = Buffer.from(buffer.uri.split(',')[1], 'base64');
  assert.equal(decoded.byteLength, buffer.byteLength);
  for (const view of gltf.bufferViews) assert.ok(view.byteOffset + view.byteLength <= buffer.byteLength);
  for (const mesh of gltf.meshes) {
    const accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION];
    assert.equal(accessor.min.length, 3);
    assert.equal(accessor.count % 3, 0);
  }
  const names = gltf.nodes.slice(0, -1).map((node) => node.name);
  assert.deepEqual(names, geometry.parts.map((part) => part.id));
  const rod = gltf.nodes.find((node) => node.extras?.moving && node.name.endsWith('-table'));
  assert.ok(rod, '旋转台面应标记 moving');
  // 单位换算为米。
  const top = gltf.nodes.find((node) => node.name === 'frame-top');
  assert.equal(top.translation[2], 0.84);
});

test('sidecar 契约：分块 ≤ 50 实体、每块通过 validateFeatures、实体数 = 零件数、变换 = 零件中心', () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  assert.equal(bundle.instances, geometry.parts.length);
  assert.ok(bundle.chunks.length >= 3);
  const seen = new Set();
  for (const chunk of bundle.chunks) {
    assert.ok(chunk.instances.length <= MAX_ASSEMBLY_CHUNK);
    assert.equal(chunk.schemaVersion, 2);
    assert.deepEqual(validateFeatures(chunk), []);
    const compiled = compileOps(chunk);
    assert.equal(compiled.instances.length, chunk.instances.length);
    for (const instance of chunk.instances) {
      assert.ok(!seen.has(instance.id));
      seen.add(instance.id);
      const part = geometry.parts.find((item) => item.id === instance.id);
      assert.deepEqual([instance.transform.x, instance.transform.y, instance.transform.z, instance.transform.rz], [...part.center, part.rotationZDeg]);
    }
  }
  assert.equal(seen.size, geometry.parts.length);
  const small = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT, maxInstances: 10 });
  assert.equal(small.chunks.length, Math.ceil(geometry.parts.length / 10));
});

test('sidecar 契约：竖直圆柱 = 内接种子方块 + cylinder（精确），横轴圆柱 = 带 axis 的精确 cylinder', () => {
  const vertical = partSidecarFeatures({ name: '台面', shape: { type: 'cylinder', radius: 70, length: 12, axis: 'z' } });
  assert.equal(vertical.approximated, false);
  assert.deepEqual(vertical.features.map((feature) => feature.type), ['box', 'cylinder']);
  const seed = vertical.features[0].params;
  assert.ok(Math.hypot(seed.length / 2, seed.width / 2) < 70, '种子方块必须完全落在圆柱内');
  assert.ok(seed.height <= 12);
  assert.deepEqual(vertical.features[1].params, { diameter: 140, height: 12, at: [0, 0, 0] });
  const horizontal = partSidecarFeatures({ name: '接近开关', shape: { type: 'cylinder', radius: 6, length: 45, axis: 'y' } });
  assert.equal(horizontal.approximated, false);
  assert.equal(horizontal.features.length, 1, '横轴圆柱只发一个 cylinder，不再垫种子方块');
  const [only] = horizontal.features;
  assert.equal(only.type, 'cylinder');
  assert.equal(only.params.axis, 'y');
  assert.equal(only.params.diameter, 12);
  assert.equal(only.params.height, 45);
  assert.deepEqual(only.params.at, [0, 0, 0]);
  assert.ok(!/方棒/.test(only.name), '不再标记为方棒近似');
  const geometry = geometryFor();
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  const horizontalParts = geometry.parts.filter((part) => part.shape.type === 'cylinder' && part.shape.axis !== 'z');
  assert.ok(horizontalParts.length > 0);
  assert.deepEqual(bundle.approximated, [], '横轴圆柱已精确，不得再有近似件');
  for (const part of horizontalParts) {
    const { features, approximated } = partSidecarFeatures(part);
    assert.equal(approximated, false, part.name);
    assert.equal(features.length, 1, part.name);
    assert.equal(features[0].type, 'cylinder', part.name);
    assert.equal(features[0].params.axis, part.shape.axis, part.name);
    assert.equal(features[0].params.diameter, Math.round(part.shape.radius * 2000) / 1000, part.name);
    assert.equal(features[0].params.height, part.shape.length, part.name);
  }
});

test('compileOps：cylinder.axis 透传（横轴件带 axis，z 轴与缺省不写 axis）', () => {
  const doc = {
    schemaVersion: 2,
    instances: [
      {
        id: 'roller',
        name: '滚筒',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f1', type: 'cylinder', name: '筒体', params: { diameter: 50, height: 200, axis: 'y', at: [0, -60, 0] } }]
      },
      {
        id: 'shaft',
        name: '传动轴',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f2', type: 'cylinder', name: '轴', params: { diameter: 20, height: 300, axis: 'x' } }]
      },
      {
        id: 'table',
        name: '台面',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f3', type: 'cylinder', name: '台面', params: { diameter: 140, height: 12, axis: 'z', at: [0, 0, 0] } }]
      }
    ],
    updatedAt: UPDATED_AT
  };
  assert.deepEqual(validateFeatures(doc), []);
  const { instances } = compileOps(doc);
  assert.deepEqual(instances[0].ops, [{ op: 'cylinder', diameter: 50, height: 200, axis: 'y', at: [0, -60, 0] }]);
  assert.deepEqual(instances[1].ops, [{ op: 'cylinder', diameter: 20, height: 300, axis: 'x' }]);
  assert.deepEqual(instances[2].ops, [{ op: 'cylinder', diameter: 140, height: 12, at: [0, 0, 0] }], 'z 轴即内核缺省，不写 axis');
});

test('特征树：cylinder.axis 只接受 x/y/z，非法值报错而不是悄悄变成竖直圆柱', () => {
  const base = { schemaVersion: 1, updatedAt: UPDATED_AT };
  const errors = validateFeatures({ ...base, features: [{ id: 'f1', type: 'cylinder', name: '筒体', params: { diameter: 50, height: 200, axis: 'w' } }] });
  assert.ok(errors.some((message) => message.includes('axis') && message.includes('x / y / z')), errors.join('；'));
  for (const axis of ['x', 'y', 'z']) {
    const ok = validateFeatures({ ...base, features: [{ id: 'f1', type: 'cylinder', name: '筒体', params: { diameter: 50, height: 200, axis } }] });
    assert.deepEqual(ok, [], axis);
  }
});

test('网格与 STEP 口径一致：横轴圆柱的局部 bbox = [直径, 长度, 直径]（y）/ [长度, 直径, 直径]（x）', () => {
  const roller = { name: '滚筒', shape: { type: 'cylinder', radius: 40, length: 120, axis: 'y' } };
  const shaft = { name: '传动轴', shape: { type: 'cylinder', radius: 25, length: 200, axis: 'x' } };
  const measure = (part) => {
    const { positions } = partLocalMesh(part);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], positions[index + k]);
        max[k] = Math.max(max[k], positions[index + k]);
      }
    }
    return max.map((value, k) => Math.round((value - min[k]) * 10) / 10);
  };
  assert.deepEqual(measure(roller), [80, 120, 80]);
  assert.deepEqual(measure(shaft), [200, 50, 50]);
  // sidecar 特征只声明 Ø/长度/轴向，允许内核算出同一 bbox：横轴 bbox 的「长边」必须落在 axis 上
  for (const part of [roller, shaft]) {
    const [feature] = partSidecarFeatures(part).features;
    assert.equal(feature.type, 'cylinder');
    assert.equal(feature.params.axis, part.shape.axis);
    const along = { x: 0, y: 1, z: 2 }[feature.params.axis];
    const bbox = measure(part);
    assert.equal(bbox[along], part.shape.length, part.name);
    assert.deepEqual(bbox.filter((_value, k) => k !== along), [part.shape.radius * 2, part.shape.radius * 2], part.name);
  }
});

test('实体化：无内核回退 TS 网格；内核全部成功返回 STEP；任一块失败整体回退不冒充完整', async () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  const none = await buildMachineSolids(bundle, undefined);
  assert.equal(none.mode, 'mesh-fallback');
  assert.match(none.message, /回退/);

  const calls = [];
  const ok = await buildMachineSolids(bundle, async (doc) => {
    calls.push(doc.instances.length);
    return { ok: true, files: { step: { path: `/tmp/part-${calls.length}.step`, bytes: 10 } } };
  });
  assert.equal(ok.mode, 'solids');
  assert.equal(ok.built, bundle.chunks.length);
  assert.equal(ok.stepFiles.length, bundle.chunks.length);
  assert.equal(calls.reduce((sum, value) => sum + value, 0), geometry.parts.length);

  let call = 0;
  const failed = await buildMachineSolids(bundle, async () => {
    call += 1;
    if (call === 2) return { ok: false, code: 'UNAVAILABLE', message: '参数化建模内核未启动' };
    return { ok: true, files: { step: { path: '/tmp/a.step' } } };
  });
  assert.equal(failed.mode, 'mesh-fallback');
  assert.equal(failed.built, 1);
  assert.deepEqual(failed.stepFiles, []);
  assert.match(failed.message, /第 2\/\d+ 块实体化失败（参数化建模内核未启动）/);

  const thrown = await buildMachineSolids(bundle, async () => {
    throw new Error('连接被拒绝');
  });
  assert.equal(thrown.mode, 'mesh-fallback');
  assert.match(thrown.message, /连接被拒绝/);
});

// ── 失败定位上下文（P1-6）─────────────────────────────────────────────────
//
// 内核 400 只回一句 Python 异常（`too many values to unpack (expected 2)`），没有件号/块下标/op。
// 本组用例锁死「回退信息必须能定位到件」：块下标 + 全局件下标区间 + 件号清单 + op 计数，
// 且成功路径不许凭空长出失败字段（否则 agent 会把绿当红/把红当绿）。
test('失败定位 P1-6：块失败带块下标 / 件下标区间 / 件号 / op 计数；成功时不带 failedChunk', async () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  assert.ok(bundle.chunks.length >= 2);

  const ok = await buildMachineSolids(bundle, async () => ({ ok: true, files: { step: { path: '/tmp/a.step' } } }));
  assert.equal(ok.mode, 'solids');
  assert.equal(ok.failedChunk, undefined, '成功路径不许带失败字段');

  let call = 0;
  const failed = await buildMachineSolids(bundle, async () => {
    call += 1;
    if (call === 2) return { ok: false, code: 'SIDECAR_BAD_REQUEST', message: 'too many values to unpack (expected 2)' };
    return { ok: true, files: { step: { path: '/tmp/a.step' } } };
  });
  const chunk = bundle.chunks[1];
  const firstId = chunk.instances[0].id;
  const from = bundle.chunks[0].instances.length + 1;
  assert.match(failed.message, /^第 2\/\d+ 块实体化失败（too many values to unpack \(expected 2\)）/);
  assert.ok(failed.message.includes(firstId), `错误信息必须含件号（${firstId}）：${failed.message}`);
  assert.match(failed.message, new RegExp(`件 #${from}–#${from + chunk.instances.length - 1}`));
  assert.match(failed.message, /op \d+ 个（/);
  assert.match(failed.message, /maxInstances=1/, '多件块要说明怎么缩到单件');

  const located = failed.failedChunk;
  assert.equal(located.index, 2);
  assert.equal(located.total, bundle.chunks.length);
  assert.equal(located.instanceFrom, from);
  assert.equal(located.instanceTo, from + chunk.instances.length - 1);
  assert.deepEqual(located.partIds, chunk.instances.map((instance) => instance.id));
  assert.equal(located.code, 'SIDECAR_BAD_REQUEST');
  const expectedOps = {};
  for (const instance of chunk.instances) {
    for (const feature of instance.features) expectedOps[feature.type] = (expectedOps[feature.type] ?? 0) + 1;
  }
  assert.deepEqual(located.ops, expectedOps, 'op 计数必须来自这一块的真实特征，不是估的');
});

test('失败定位 P1-6：单件块给单下标（不给区间/缩块提示），原异常文本不被吞', async () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const single = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT, maxInstances: 1 });
  const target = 7;
  let call = 0;
  const failed = await buildMachineSolids(single, async () => {
    call += 1;
    if (call === target) throw new Error('连接被拒绝');
    return { ok: true, files: { step: { path: '/tmp/a.step' } } };
  });
  const id = single.chunks[target - 1].instances[0].id;
  assert.equal(failed.failedChunk.index, target);
  assert.equal(failed.failedChunk.instanceFrom, target);
  assert.equal(failed.failedChunk.instanceTo, target);
  assert.match(failed.message, new RegExp(`件 #${target}（件号 ${id}`));
  assert.match(failed.message, /连接被拒绝/);
  assert.ok(!failed.message.includes('maxInstances=1'), '单件块不该再让调用方缩块');
});

test('失败定位 P1-6：sidecar 特征派生异常带件号 + 下标，原错误挂在 cause 上', () => {
  const geometry = geometryFor();
  const broken = { ...geometry, parts: [geometry.parts[0], { ...geometry.parts[1], shape: { type: 'box' } }] };
  const secondId = geometry.parts[1].id;
  assert.throws(
    () => geometryToSidecarAssemblies(broken, { updatedAt: UPDATED_AT }),
    (error) => {
      assert.match(error.message, /^件 #2（件号 /);
      assert.ok(error.message.includes(secondId), `错误信息必须含件号（${secondId}）：${error.message}`);
      assert.match(error.message, /派生 sidecar 特征失败/);
      assert.ok(error.cause instanceof Error, '原异常必须保留在 cause 上，便于回到原始栈');
      return true;
    }
  );
});

// ── 制造导出 vs 碰撞几何：缓存塔板件（review P1） ────────────────────────────
//
// 口径：缓存塔的板（`workpiece-plate` / `role=workpiece`）是**碰撞与工艺占位刚体**，
// 不是要制造的机加件。它在 `geometry.parts` 里（147 刚体 = 146 装配件 + 1 板），参与
// rest/lift/sweep 与 `run_interference_check`；但 STL / glTF / sidecar（→ STEP）必须只出
// 装配件表（48/90/146）。输送线的工件板不属于这个口径，仍照旧导出。
const TOWER_CASES = [
  { levels: 2, assemblyParts: 48 },
  { levels: 8, assemblyParts: 90 },
  { levels: 16, assemblyParts: 146 }
];

function towerGeometry(levels) {
  const resolved = resolveBufferTowerModelInput({ params: { levels } });
  assert.equal(resolved.ok, true, resolved.message);
  return resolveMachineGeometry({
    id: `buffer-tower-${levels}l`,
    name: `缓存塔 ${levels} 层`,
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    bufferTower: resolved.config
  }).geometry;
}

/** 制造件集按件累加的三角形数（不走导出过滤，用来对照）。 */
function rawTriangleCount(geometry) {
  return geometry.parts.reduce((sum, part) => sum + partLocalMesh(part).positions.length / 9, 0);
}

test('缓存塔制造导出剔除板件：sidecar/STL/glTF 只出 48/90/146 装配件，碰撞几何仍是 49/91/147', () => {
  for (const { levels, assemblyParts } of TOWER_CASES) {
    const geometry = towerGeometry(levels);
    const label = `${levels} 层`;
    assert.equal(geometry.geometrySource, 'buffer-tower-assembly', label);
    // 碰撞几何：板是真刚体，看得见、参与碰撞（49/91/147）
    assert.equal(geometry.parts.length, assemblyParts + 1, `${label} 碰撞刚体数`);
    assert.equal(geometry.assemblyPartCount, assemblyParts, `${label} 装配件数`);
    const plate = geometry.parts.find((part) => part.id === 'workpiece-plate');
    assert.ok(plate, `${label} 几何里必须有板`);
    assert.equal(plate.role, 'workpiece');
    assert.equal(plate.moving, false);
    assert.equal(partLocalMesh(plate).positions.length / 9, 12, `${label} 板是盒体（12 三角形）`);
    assert.equal(geometry.workpiecePlaceholder?.id, 'workpiece-plate', `${label} 占位体由同一件投影`);
    assert.equal(geometry.workpiecePlaceholder?.inCollisionSet, true, `${label} 板在碰撞集里`);

    // 制造件集：板不在其中
    const exportParts = machineExportParts(geometry);
    assert.equal(exportParts.length, assemblyParts, `${label} 制造件数`);
    assert.ok(!exportParts.some((part) => part.id === 'workpiece-plate'), `${label} 制造件集不含板`);
    assert.equal(rawTriangleCount(geometry), geometryTriangleCount(geometry) + 12, `${label} 板贡献的 12 个三角形不在导出里`);

    // sidecar（→ STEP）：实例 = 装配件数，id 不含板
    const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
    assert.equal(bundle.instances, assemblyParts, `${label} sidecar 实体数`);
    const instances = bundle.chunks.flatMap((chunk) => chunk.instances);
    assert.equal(instances.length, assemblyParts, `${label} 分块实体总数`);
    assert.ok(!instances.some((instance) => instance.id === 'workpiece-plate'), `${label} sidecar 不含板`);
    assert.ok(instances.every((instance) => instance.features.length > 0), `${label} 每件都有特征`);

    // STL：count = 导出件三角形和（不含板盒），长度公式一致
    const stl = geometryToStl(geometry);
    const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const count = view.getUint32(80, true);
    assert.equal(count, geometryTriangleCount(geometry), `${label} STL 三角形数 = 导出口径`);
    assert.equal(count, rawTriangleCount(geometry) - 12, `${label} STL 不含板盒`);
    assert.equal(stl.byteLength, 84 + 50 * count, `${label} STL 字节长度`);

    // glTF：节点名不含板、根子节点数 = 装配件数、三角形总数与导出口径一致
    const gltf = geometryToGltf(geometry);
    assert.equal(gltf.nodes.length, assemblyParts + 1, `${label} glTF = 零件节点 + 根`);
    const nodeNames = gltf.nodes.slice(0, -1).map((node) => node.name);
    assert.ok(!nodeNames.includes('workpiece-plate'), `${label} glTF 节点不含板`);
    assert.equal(nodeNames.length, assemblyParts, `${label} glTF 零件节点数`);
    assert.equal(gltf.nodes[gltf.scenes[0].nodes[0]].children.length, assemblyParts, `${label} 根子节点数`);
    const gltfTriangles = gltf.nodes.slice(0, -1).reduce((sum, node) => {
      const accessor = gltf.accessors[gltf.meshes[node.mesh].primitives[0].attributes.POSITION];
      return sum + accessor.count / 3;
    }, 0);
    assert.equal(gltfTriangles, geometryTriangleCount(geometry), `${label} glTF 三角形数`);

    // 导出不改碰撞几何本身
    assert.equal(geometry.parts.length, assemblyParts + 1, `${label} 导出后 parts 仍是碰撞口径`);
  }
});

test('塔的板单件导出（parts:[plate]）不被静默滤掉：单件 STL 仍是 12 三角形', () => {
  const geometry = towerGeometry(16);
  const plate = geometry.parts.find((part) => part.id === 'workpiece-plate');
  assert.ok(plate);
  const single = { ...geometry, parts: [plate] };
  assert.deepEqual(machineExportParts(single), [plate], '单件调用必须原样返回（过滤只认塔整机）');
  const stl = geometryToStl(single);
  const count = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
  assert.equal(count, 12, '单件板 STL 必须是那块板本身，不是空文件');
  const gltf = geometryToGltf(single);
  assert.deepEqual(gltf.nodes.slice(0, -1).map((node) => node.name), ['workpiece-plate']);
  assert.equal(geometryToSidecarAssemblies(single, { updatedAt: UPDATED_AT }).instances, 1);
});

test('输送线工件板不属于塔口径：照旧进 STL/glTF/sidecar（件集原样返回）', () => {
  const geometry = resolveMachineGeometry({
    id: 'transfer-workpiece',
    name: '顶升移载输送机',
    stations: ['工位1', '移载工位'],
    actuators: [],
    sensors: [],
    formId: 'belt-line',
    conveyor: {
      lengthMm: 3000,
      widthMm: 1200,
      transferPresent: true,
      transferPartLengthMm: 1200,
      transferPartWidthMm: 800
    }
  }).geometry;
  assert.equal(geometry.geometrySource, 'conveyor-assembly');
  const plate = geometry.parts.find((part) => part.role === 'workpiece');
  assert.ok(plate, '移载线的几何里必须有工件板');
  assert.equal(machineExportParts(geometry), geometry.parts, '非塔几何必须原样返回同一数组（导出逐字节不变）');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  assert.equal(bundle.instances, geometry.parts.length, '输送线 sidecar 仍按全部几何刚体出');
  const ids = bundle.chunks.flatMap((chunk) => chunk.instances.map((instance) => instance.id));
  assert.ok(ids.includes('workpiece-plate'), '输送线板仍照旧导出');
  const stl = geometryToStl(geometry);
  const count = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
  assert.equal(count, geometryTriangleCount(geometry));
  assert.equal(count, rawTriangleCount(geometry), '输送线 STL 仍含板（与改动前同一口径）');
  const gltf = geometryToGltf(geometry);
  assert.ok(gltf.nodes.slice(0, -1).some((node) => node.name === 'workpiece-plate'), '输送线 glTF 仍含板节点');
});

// ── 回归 P2-5：板件判据的变异自证 ────────────────────────────────────────────
//
// 修复前的判据是 `id === 'workpiece-plate' && role === 'workpiece'` + `geometrySource ===
// 'buffer-tower-assembly'`：两个条件任一漂移，板就静默回流到 STL/glTF/sidecar（147 件）。
// 现在判据是「共享件号 / role / 占位体位姿」三层身份 + 装配件窗口，来源标签只作兜底。
// 这些变异体必须**仍然只出 146 件**；任何一条变红，说明边界又押回了单个字面量。
// 每个变异体只改一层信号（或叠加几层），不改碰撞几何件数与位姿。
const PLATE_MUTATIONS = [
  {
    label: '只改件号（占位体保持原名）',
    mutate: (g) => ({ ...g, parts: g.parts.map((part) => (part.role === 'workpiece' ? { ...part, id: 'panel-x' } : part)) })
  },
  {
    label: '件号与占位体一起改',
    mutate: (g) => ({
      ...g,
      parts: g.parts.map((part) => (part.role === 'workpiece' ? { ...part, id: 'panel-x' } : part)),
      workpiecePlaceholder: { ...g.workpiecePlaceholder, id: 'panel-x' }
    })
  },
  { label: '只改来源标签（station-generator）', mutate: (g) => ({ ...g, geometrySource: 'station-generator' }) },
  {
    label: '件号 + 来源一起改',
    mutate: (g) => ({
      ...g,
      geometrySource: 'station-generator',
      parts: g.parts.map((part) => (part.role === 'workpiece' ? { ...part, id: 'panel-x' } : part))
    })
  },
  {
    label: '件号 + role + 来源一起改',
    mutate: (g) => ({
      ...g,
      geometrySource: 'station-generator',
      parts: g.parts.map((part) => (part.role === 'workpiece' ? { ...part, id: 'panel-x', role: 'frame' } : part))
    })
  },
  {
    label: '占位体被剥掉 + 件号 + 来源一起改',
    mutate: (g) => ({
      ...g,
      geometrySource: 'station-generator',
      workpiecePlaceholder: undefined,
      parts: g.parts.map((part) => (part.role === 'workpiece' ? { ...part, id: 'panel-x' } : part))
    })
  }
];

test('回归 P2-5：改件号/来源/role 都不能让板静默回流（导出必须仍是 146 件）', () => {
  const geometry = towerGeometry(16);
  const assemblyParts = geometry.assemblyPartCount;
  assert.equal(assemblyParts, 146);
  assert.equal(geometry.parts.length, 147, '碰撞几何仍是 146 装配 + 1 块板');
  assert.equal(machineExportParts(geometry).length, assemblyParts);
  const baselineTriangles = geometryTriangleCount(geometry);

  for (const { label, mutate } of PLATE_MUTATIONS) {
    const mutated = mutate(geometry);
    // 碰撞几何不许被导出判据改掉（147 仍在）
    assert.equal(mutated.parts.length, 147, `${label}：碰撞刚体数不变`);
    const exportParts = machineExportParts(mutated);
    assert.equal(exportParts.length, assemblyParts, `${label}：制造导出必须仍是 146 件（147 就是边界漂了）`);
    assert.ok(
      exportParts.every((part) => part.id !== 'workpiece-plate' && part.role !== 'workpiece'),
      `${label}：导出件集里不许有工件板`
    );
    assert.equal(
      new Set(exportParts.map((part) => part.id)).size,
      assemblyParts,
      `${label}：导出件号唯一（不许拿别的件顶数）`
    );

    const bundle = geometryToSidecarAssemblies(mutated, { updatedAt: UPDATED_AT });
    assert.equal(bundle.instances, assemblyParts, `${label}：sidecar 实例数（⇒ STEP）必须仍是 146`);
    assert.ok(
      !bundle.chunks.flatMap((chunk) => chunk.instances).some((instance) => instance.id === 'workpiece-plate'),
      `${label}：sidecar 不含工件板`
    );

    const stl = geometryToStl(mutated);
    const count = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
    assert.equal(count, baselineTriangles, `${label}：STL 三角形数与干净塔逐项相等`);
    assert.equal(geometryToGltf(mutated).nodes.length, assemblyParts + 1, `${label}：glTF 节点 = 零件 + 根`);
    assert.equal(geometryTriangleCount(mutated), baselineTriangles, `${label}：导出口径三角形数不变`);
  }
});

test('回归 P2-5：判据不是「id 前缀」——位姿不符的件留在导出里、位姿相同的板才剔除', () => {
  const geometry = towerGeometry(16);
  const plate = geometry.parts.find((part) => part.role === 'workpiece');
  assert.ok(plate);
  // 真板改名 + 改 role（只剩位姿与占位体对得上），另加一件同尺寸、中心偏 1mm 的「像板件」
  const disguised = { ...plate, id: 'panel-x', role: 'frame' };
  const shifted = { ...plate, id: 'panel-y', role: 'frame', center: [0, 0, plate.center[2] + 1] };
  const mutated = {
    ...geometry,
    parts: [...geometry.parts.slice(0, 146), disguised, shifted],
    workpiecePlaceholder: { ...geometry.workpiecePlaceholder, id: 'panel-x' }
  };
  const exportParts = machineExportParts(mutated);
  assert.equal(exportParts.length, 147, '只剔位姿同一的那件（146 装配 + 1 件位姿不符的像板件）');
  assert.ok(exportParts.some((part) => part.id === 'panel-y'), '位姿不符的件必须留在制造件集里（不许按 id/role 一刀切）');
  assert.ok(!exportParts.some((part) => part.id === 'panel-x'), '位姿与占位体同一的板必须剔除（id/role 都被改名也一样）');
});
