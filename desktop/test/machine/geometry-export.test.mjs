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
  partLocalMesh,
  partSidecarFeatures
} from '../../src/machine/geometry-export.ts';
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
