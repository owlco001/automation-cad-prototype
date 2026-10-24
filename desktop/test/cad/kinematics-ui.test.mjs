import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import {
  applySlide,
  annotationFromParts,
  createKinematicsStore,
  deserializeAnnotation,
  draftFromMesh,
  draftFromMeshes,
  KINEMATICS_STORAGE_KEY,
  pointOptionsFromMachineConfig,
  remapKinematicsAnnotation,
  roleForPoint,
  serializeAnnotation,
  validateDraft
} from '../../src/cad/kinematics-ui.ts';

const MESH_A = {
  id: 0,
  name: '底板',
  triangles: 12,
  center: [10, 20, 30],
  size: [20, 40, 60]
};
const MESH_B = {
  id: 1,
  name: '滑台',
  triangles: 24,
  center: [30, 20, 30],
  size: [20, 40, 60]
};
const POINTS = pointOptionsFromMachineConfig(demoMachineConfig());

function linearPart(overrides = {}) {
  return {
    ...draftFromMesh(MESH_A, { name: '滑台动件' }),
    kind: 'linear',
    axis: 'y',
    direction: 1,
    travelMm: 50,
    retractedMm: 5,
    point: 'Y0',
    role: 'extend',
    ...overrides
  };
}

test('运动学 UI：draftFromMesh 记录网格、中心与默认直线轴', () => {
  const part = draftFromMesh(MESH_A);
  assert.equal(part.name, '底板');
  assert.deepEqual(part.meshIds, [0]);
  assert.deepEqual(part.meshNames, ['底板']);
  assert.deepEqual(part.center, [10, 20, 30]);
  assert.equal(part.kind, 'linear');
  assert.equal(part.axis, 'z');
  assert.equal(part.travelMm, 0);
  assert.equal(part.point, '');
  assert.ok(part.id.startsWith('mp-'));
});

test('运动学 UI：多选网格合并为一个动件并计算合并包围盒中心', () => {
  const part = draftFromMeshes([MESH_A, MESH_B]);
  assert.deepEqual(part.meshIds, [0, 1]);
  assert.deepEqual(part.meshNames, ['底板', '滑台']);
  assert.deepEqual(part.center, [20, 20, 30]);
  assert.deepEqual(part.size, [40, 40, 60]);
  assert.match(part.name, /底板 等 2 件/);
});

test('运动学 UI：点位选项来自机型配置并可推断绑定角色', () => {
  assert.ok(POINTS.length >= 8);
  const extend = POINTS.find((option) => option.point === 'Y0');
  const rotate = POINTS.find((option) => option.point === 'Y12');
  assert.equal(extend?.role, 'extend');
  assert.equal(rotate?.role, 'rotate');
  assert.equal(roleForPoint(POINTS, 'y4'), 'retract');
  assert.equal(roleForPoint(POINTS, 'NOPE'), '');
  assert.deepEqual(pointOptionsFromMachineConfig(null), []);
});

test('运动学 UI：合法直线动件通过校验', () => {
  const validation = validateDraft([linearPart()], { pointOptions: POINTS, meshes: [MESH_A] });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal(validation.errors.length, 0);
  assert.equal(validation.doc.axes[0]?.travelMm, 50);
  assert.equal(validation.doc.axes[0]?.retractedMm, 5);
});

test('运动学 UI：未绑定点位的动件产生 1 条错误且保存被阻止', () => {
  const validation = validateDraft([linearPart({ point: '', role: '' })], {
    pointOptions: POINTS,
    meshes: [MESH_A]
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.length, 1);
  assert.match(validation.errors[0]?.message ?? '', /至少需要绑定一个点位/);
});

test('运动学 UI：网格缺失也会被校验捕获', () => {
  const validation = validateDraft([linearPart({ meshIds: [99] })], {
    pointOptions: POINTS,
    meshes: [MESH_A]
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((issue) => issue.code === 'part.mesh.missing'));
});

test('运动学 UI：直线滑块 0% 在缩回位，25% 位置变化大于 0', () => {
  const part = linearPart();
  const idle = applySlide(part, 0);
  const quarter = applySlide(part, 25);
  assert.equal(idle.amount, 5);
  assert.deepEqual(idle.offset, [0, 5, 0]);
  assert.ok(quarter.amount > idle.amount);
  assert.ok(Math.abs(quarter.offset[1]) > Math.abs(idle.offset[1]));
  assert.equal(quarter.source, 'extend');
});

test('运动学 UI：旋转滑块按角度插值并保留方向符号', () => {
  const part = {
    ...draftFromMesh(MESH_A, { name: '旋转台' }),
    kind: 'rotary',
    axis: 'z',
    direction: 1,
    rangeDeg: 90,
    retractedDeg: 0,
    point: 'Y12',
    role: 'rotate'
  };
  const half = applySlide(part, 50);
  assert.equal(half.unit, 'deg');
  assert.ok(Math.abs(half.amount - 45) < 1e-9);
  assert.ok(Math.abs(half.rotationRad - Math.PI / 4) < 1e-9);
  const reversed = applySlide({ ...part, direction: -1 }, 100);
  assert.ok(Math.abs(reversed.amount + 90) < 1e-9);
});

test('运动学 UI：导出 JSON 含 version/sourceFile/parts 且可读回', () => {
  const annotation = {
    version: 1,
    sourceFile: 'cube.stp',
    parts: [linearPart()]
  };
  const text = serializeAnnotation(annotation);
  assert.match(text, /"version": 1/);
  assert.match(text, /"sourceFile": "cube.stp"/);
  const parsed = deserializeAnnotation(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.annotation?.parts.length, 1);
  assert.deepEqual(parsed.annotation?.parts[0]?.meshIds, [0]);
  assert.equal(parsed.annotation?.parts[0]?.point, 'Y0');
});

test('运动学 UI：非法 JSON 与错误 version 给出中文错误', () => {
  const broken = deserializeAnnotation('{ 不是 json');
  assert.equal(broken.ok, false);
  assert.match(broken.issues[0]?.message ?? '', /不是合法 JSON/);

  const wrong = deserializeAnnotation(JSON.stringify({ version: 3, sourceFile: 'a.stp', parts: [] }));
  assert.equal(wrong.ok, false);
  assert.ok(wrong.issues.some((issue) => issue.code === 'json.version'));
});

test('运动学 UI：store 按传入项目键分桶且互不覆盖', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key)
  };
  const store = createKinematicsStore(storage);
  const cube = { version: 1, sourceFile: 'cube.stp', parts: [linearPart()] };
  const other = { version: 1, sourceFile: 'other.stp', parts: [] };
  store.set('cube.stp', cube);
  store.set('other.stp', other);
  assert.deepEqual(store.files(), ['cube.stp', 'other.stp']);
  assert.equal(store.get('cube.stp')?.parts.length, 1);
  assert.equal(store.get('other.stp')?.parts.length, 0);
  assert.equal(store.get('missing.stp'), null);
  assert.ok(memory.get(KINEMATICS_STORAGE_KEY));

  store.remove('cube.stp');
  assert.equal(store.get('cube.stp'), null);
  assert.equal(store.files().length, 1);
});

test('运动学 UI：store 遇到损坏数据时按空桶处理', () => {
  const storage = {
    getItem: () => '{ broken bucket',
    setItem: () => {},
    removeItem: () => {}
  };
  const store = createKinematicsStore(storage);
  assert.equal(store.get('cube.stp'), null);
  assert.deepEqual(store.files(), []);
});

test('运动学 v2：stable object IDs round-trip 并在导入顺序改变后重映射', () => {
  const projectId = 'acproj-00000000-0000-4000-8000-000000000001';
  const objectA = `cadobj-${'a'.repeat(64)}`;
  const objectB = `cadobj-${'b'.repeat(64)}`;
  const sourceMeshes = [
    { ...MESH_A, stableObjectId: objectA },
    { ...MESH_B, id: 1, stableObjectId: objectB }
  ];
  const part = draftFromMeshes(sourceMeshes, { name: '装配动件' });
  part.point = 'Y0';
  part.role = 'extend';
  part.travelMm = 30;
  const annotation = annotationFromParts('fixture.step', [part], projectId);
  assert.equal(annotation.version, 2);
  const parsed = deserializeAnnotation(serializeAnnotation(annotation));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  const reordered = [
    { ...MESH_B, id: 0, stableObjectId: objectB },
    { ...MESH_A, id: 1, stableObjectId: objectA }
  ];
  const mapped = remapKinematicsAnnotation(parsed.annotation, projectId, reordered);
  assert.equal(mapped.ok, true, mapped.reason);
  assert.deepEqual(mapped.annotation.parts[0].meshIds, [1, 0]);
  assert.deepEqual(mapped.annotation.parts[0].meshObjectIds, [objectA, objectB]);
});

test('运动学 v2：工程 ID 不匹配、缺失或歧义对象均失败关闭', () => {
  const projectId = 'acproj-00000000-0000-4000-8000-000000000001';
  const objectA = `cadobj-${'a'.repeat(64)}`;
  const part = draftFromMesh({ ...MESH_A, stableObjectId: objectA });
  part.point = 'Y0';
  part.role = 'extend';
  part.travelMm = 30;
  const annotation = annotationFromParts('fixture.step', [part], projectId);
  assert.equal(remapKinematicsAnnotation(annotation, 'acproj-00000000-0000-4000-8000-000000000002', [MESH_A]).ok, false);
  assert.equal(remapKinematicsAnnotation(annotation, projectId, [MESH_A]).ok, false);
  assert.equal(remapKinematicsAnnotation(annotation, projectId, [
    { ...MESH_A, stableObjectId: objectA },
    { ...MESH_B, id: 1, stableObjectId: objectA }
  ]).ok, false);
  assert.equal(remapKinematicsAnnotation({ version: 1, sourceFile: 'fixture.step', parts: [part] }, projectId, [MESH_A]).ok, false);
});

test('运动学 store：同名 CAD 的不同 project ID 不共享标注', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key)
  };
  const store = createKinematicsStore(storage);
  const projectA = 'acproj-00000000-0000-4000-8000-000000000001';
  const projectB = 'acproj-00000000-0000-4000-8000-000000000002';
  store.set(projectA, { version: 1, sourceFile: 'fixture.step', parts: [linearPart()] });
  store.set(projectB, { version: 1, sourceFile: 'fixture.step', parts: [] });
  assert.equal(store.get(projectA).parts.length, 1);
  assert.equal(store.get(projectB).parts.length, 0);
});
