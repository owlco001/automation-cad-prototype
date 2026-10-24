import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CadViewer } from '../src/cad/viewer.ts';
import { closeParametricPanel, emptyBuildGuidance } from '../src/parametric/ui.ts';
import { createFeature, makeAssembly, serializeDoc } from '../src/parametric/model.ts';
import { createModuleManager, MODULE_SETTINGS_KEY } from '../src/modules/registry.ts';
import { PARAMETRIC_STORAGE_KEY } from '../src/parametric/model.ts';

function mesh(name, x = 0) {
  return {
    name,
    positions: new Float32Array([x, 0, 0, x + 10, 0, 0, x, 10, 0]),
    normals: null,
    indices: new Uint32Array([0, 1, 2])
  };
}

function importResult(data) {
  return {
    meshes: [data],
    stats: { meshCount: 1, triangleCount: 1, elapsedMs: 1, format: 'STEP' }
  };
}

function viewerWithImport(importedResult) {
  const viewer = Object.create(CadViewer.prototype);
  viewer.degraded = false;
  viewer.wireframe = false;
  viewer.planDirty = false;
  viewer.parts = [];
  viewer.modelParts = [];
  viewer.importedResult = importedResult;
  viewer.group = new THREE.Group();
  viewer.parametricOverlayGroup = new THREE.Group();
  viewer.fit = () => { viewer.fitCalled = true; };
  return viewer;
}

const EMPTY_ASSEMBLY = {
  schemaVersion: 2,
  sourceFile: 'fixture.step',
  updatedAt: '2026-10-24T00:00:00Z',
  instances: [{
    id: 'p1',
    name: '零件 1',
    transform: { x: 0, y: 0, z: 0, rz: 0 },
    features: []
  }]
};

test('有效重建输出进入独立叠加组，不替换或改写已导入 CAD', () => {
  const sourceMesh = mesh('STEP 外壳');
  const sourceResult = importResult(sourceMesh);
  const generated = importResult(mesh('参数化底板', 20));
  const viewer = viewerWithImport(sourceResult);
  const sourceObject = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  viewer.group.add(sourceObject);

  assert.equal(viewer.setParametricOverlay(generated), true);
  assert.equal(viewer.importedResult, sourceResult);
  assert.equal(viewer.group.children[0], sourceObject);
  assert.equal(viewer.parametricOverlayGroup.children.length, 1);
  assert.equal(viewer.parametricOverlayGroup.children[0].userData.parametricOverlay, true);
  assert.notEqual(
    viewer.parametricOverlayGroup.children[0].geometry.getAttribute('position').array,
    generated.meshes[0].positions,
    '叠加体使用自己的顶点数组'
  );
  assert.equal(viewer.getKinematicsMeshes().length, 1, '生成叠加体不混入原 CAD 的运动学网格');
  const exportRoot = viewer.getExportRoot();
  assert.equal(exportRoot.children.length, 1, '原 CAD 导出不包含参数化叠加体');
  assert.equal(exportRoot.children[0].name, 'STEP 外壳');
  assert.equal(viewer.fitCalled, true);
});

test('重复重建只替换参数化叠加体；显示开关不会隐藏原导入体', () => {
  const sourceResult = importResult(mesh('STEP 机架'));
  const viewer = viewerWithImport(sourceResult);
  const sourceObject = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  viewer.group.add(sourceObject);

  viewer.setParametricOverlay(importResult(mesh('第一次输出')));
  viewer.setParametricOverlay(importResult(mesh('第二次输出', 40)), { visible: false });

  assert.equal(viewer.parametricOverlayGroup.children.length, 1);
  assert.match(viewer.parametricOverlayGroup.children[0].name, /第二次输出/);
  assert.equal(viewer.hasParametricOverlay(), true);
  assert.equal(viewer.parametricOverlayVisible(), false);
  assert.equal(viewer.setParametricOverlayVisible(true), true);
  assert.equal(viewer.parametricOverlayVisible(), true);
  assert.equal(viewer.group.children[0], sourceObject);
  assert.equal(viewer.importedResult, sourceResult);
});

test('CAD 零件撤销恢复只操作原模型组，不触碰参数化叠加体', () => {
  const sourceData = mesh('STEP 零件');
  const sourceResult = importResult(sourceData);
  const viewer = viewerWithImport(sourceResult);
  const sourceObject = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  viewer.group.add(sourceObject);
  viewer.parts = [{ data: sourceData, mesh: sourceObject, triangleCount: 1 }];
  viewer.modelParts = [{ name: sourceData.name, bbox: { min: [0, 0, 0], max: [10, 10, 0] } }];
  viewer.originalGeometries = new Map();
  viewer.lodGeometries = new Map();
  viewer.selectionHelper = { visible: true };
  viewer.renderPartList = () => {};
  viewer.renderDetail = () => {};
  viewer.syncPartCount = () => {};
  viewer.rebuildPlanState = () => {};
  viewer.setParametricOverlay(importResult(mesh('新参数化实体')));
  const overlay = viewer.parametricOverlayGroup.children[0];

  const detached = viewer.detachPart(0);
  assert.ok(detached);
  assert.equal(viewer.parametricOverlayGroup.children[0], overlay);
  assert.equal(viewer.restoreDetachedPart(detached), true);
  assert.equal(viewer.group.children[0], sourceObject);
  assert.equal(viewer.parametricOverlayGroup.children[0], overlay);
  assert.equal(viewer.importedResult, sourceResult);
});

test('关闭参数化抽屉只隐藏 UI、清除待处理重建；原 CAD 与叠加体仍可见', () => {
  const sourceResult = importResult(mesh('STEP 机架'));
  const viewer = viewerWithImport(sourceResult);
  viewer.setParametricOverlay(importResult(mesh('参数化实体')));
  viewer.highlightBounds = (bounds) => { viewer.clearedHighlight = bounds === null; };
  const container = { hidden: false };
  let cleared = 0;
  let openState = true;

  closeParametricPanel(container, viewer, () => { cleared += 1; }, (open) => { openState = open; });

  assert.equal(container.hidden, true);
  assert.equal(cleared, 1);
  assert.equal(viewer.clearedHighlight, true);
  assert.equal(openState, false);
  assert.equal(viewer.importedResult, sourceResult);
  assert.equal(viewer.parametricOverlayVisible(), true);
});

test('关闭并重开参数化模块不清除已导入 CAD、现有叠加体或特征树数据', () => {
  const sourceResult = importResult(mesh('保留的 STEP 原始实体'));
  const viewer = viewerWithImport(sourceResult);
  viewer.setParametricOverlay(importResult(mesh('保留的参数化叠加实体')));
  const overlay = viewer.parametricOverlayGroup.children[0];
  const featureTree = JSON.stringify({
    version: 1,
    buckets: { 'fixture.step': { schemaVersion: 1, sourceFile: 'fixture.step', features: [{ id: 'f1', type: 'box' }] } }
  });
  const data = new Map([[PARAMETRIC_STORAGE_KEY, featureTree]]);
  const storage = {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); }
  };
  const manager = createModuleManager(storage);

  manager.setEnabled('cad.parametric-import', false);
  assert.equal(manager.getStatus('cad.parametric-import').enabled, false);
  assert.equal(viewer.importedResult, sourceResult);
  assert.equal(viewer.parametricOverlayGroup.children[0], overlay);
  assert.equal(viewer.parametricOverlayVisible(), true);
  assert.equal(storage.getItem(PARAMETRIC_STORAGE_KEY), featureTree);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)).overrides, { 'cad.parametric-import': false });

  manager.setEnabled('cad.parametric-import', true);
  assert.equal(manager.getStatus('cad.parametric-import').enabled, true);
  assert.equal(viewer.importedResult, sourceResult);
  assert.equal(viewer.parametricOverlayGroup.children[0], overlay);
  assert.equal(storage.getItem(PARAMETRIC_STORAGE_KEY), featureTree);
});

test('清空/切换 CAD 模型时会清理旧叠加体，但不会参与 CAD 数据生命周期', () => {
  const sourceResult = importResult(mesh('旧 STEP'));
  const viewer = viewerWithImport(sourceResult);
  viewer.setParametricOverlay(importResult(mesh('输出')));
  viewer.selected = 0;
  viewer.selectionHelper = null;
  viewer.featureHelper = null;
  viewer.originalGeometries = new Map();
  viewer.partsElement = { innerHTML: '' };
  viewer.disposePlanCaches = () => {};
  viewer.renderDetail = () => {};

  viewer.clearModel();

  assert.equal(viewer.importedResult, null);
  assert.equal(viewer.hasParametricOverlay(), false);
  assert.equal(viewer.parametricOverlayGroup.children.length, 0);
});

test('空特征树的重建提示明确说明 CAD 只读且要求先建立参数化实体', () => {
  const message = emptyBuildGuidance(EMPTY_ASSEMBLY, EMPTY_ASSEMBLY.sourceFile);
  assert.match(message, /只读参考体/);
  assert.match(message, /不会自动识别/);
  assert.match(message, /新增底板/);

  const withFeature = {
    ...EMPTY_ASSEMBLY,
    instances: [{ ...EMPTY_ASSEMBLY.instances[0], features: [createFeature('box')] }]
  };
  assert.equal(emptyBuildGuidance(withFeature, withFeature.sourceFile), null);
});

test('保存的特征树保留来源文件名，但不序列化导入几何', () => {
  const assembly = makeAssembly([{
    id: 'p1',
    name: '参数化底板',
    transform: { x: 0, y: 0, z: 0, rz: 0 },
    features: [createFeature('box')]
  }], { sourceFile: 'fixture.step', now: Date.parse('2026-10-24T00:00:00Z') });
  const text = serializeDoc(assembly);
  const parsed = JSON.parse(text);

  assert.equal(parsed.sourceFile, 'fixture.step');
  assert.equal(parsed.instances[0].features.length, 1);
  assert.doesNotMatch(text, /positions|normals|indices|Float32Array/);
});
