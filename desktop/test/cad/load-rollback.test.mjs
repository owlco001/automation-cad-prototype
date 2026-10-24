import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CadViewer } from '../../src/cad/viewer.ts';

function meshData(name, normals) {
  return {
    name,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals,
    indices: null
  };
}

test('替换模型的网格构建失败时保留活动场景并释放暂存几何', () => {
  const viewer = Object.create(CadViewer.prototype);
  const oldGeometry = new THREE.BufferGeometry();
  const oldMesh = new THREE.Mesh(oldGeometry, new THREE.MeshStandardMaterial());
  const activeGroup = new THREE.Group();
  activeGroup.add(oldMesh);
  const oldPart = { data: meshData('已有模型', new Float32Array(9)), mesh: oldMesh, triangleCount: 1 };
  let clearCalled = false;
  viewer.degraded = false;
  viewer.wireframe = false;
  viewer.parts = [oldPart];
  viewer.group = activeGroup;
  viewer.clearModel = () => {
    clearCalled = true;
    viewer.parts = [];
  };

  const disposed = [];
  const originalCompute = THREE.BufferGeometry.prototype.computeVertexNormals;
  const originalDispose = THREE.BufferGeometry.prototype.dispose;
  THREE.BufferGeometry.prototype.computeVertexNormals = function () {
    throw new Error('injected geometry construction failure');
  };
  THREE.BufferGeometry.prototype.dispose = function () {
    disposed.push(this);
    return originalDispose.call(this);
  };

  try {
    assert.throws(() => viewer.load({
      meshes: [
        meshData('候选一', new Float32Array(9)),
        meshData('候选二', null)
      ],
      stats: { meshCount: 2, triangleCount: 2, elapsedMs: 0, format: 'test' }
    }, 'replacement.step'), /injected geometry construction failure/);
  } finally {
    THREE.BufferGeometry.prototype.computeVertexNormals = originalCompute;
    THREE.BufferGeometry.prototype.dispose = originalDispose;
  }

  assert.equal(clearCalled, false);
  assert.equal(viewer.parts[0], oldPart);
  assert.deepEqual(activeGroup.children, [oldMesh]);
  assert.equal(disposed.length, 2, 'both partially staged geometries should be disposed');
  assert.equal(disposed.includes(oldGeometry), false, 'the active geometry must not be disposed');
  oldGeometry.dispose();
  oldMesh.material.dispose();
});
