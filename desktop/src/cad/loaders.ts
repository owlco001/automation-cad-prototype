import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CadImportResult, CadMeshData } from '../shared/types';

function attributeArray(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const result = new Float32Array(attribute.count * attribute.itemSize);
  for (let i = 0; i < attribute.count; i += 1) {
    result[i * attribute.itemSize] = attribute.getX(i);
    if (attribute.itemSize > 1) result[i * attribute.itemSize + 1] = attribute.getY(i);
    if (attribute.itemSize > 2) result[i * attribute.itemSize + 2] = attribute.getZ(i);
    if (attribute.itemSize > 3) result[i * attribute.itemSize + 3] = attribute.getW(i);
  }
  return result;
}

function materialColor(object: THREE.Object3D): [number, number, number] | undefined {
  const material = (object as THREE.Mesh).material;
  const first = Array.isArray(material) ? material[0] : material;
  if (first && 'color' in first && first.color instanceof THREE.Color) {
    return [first.color.r, first.color.g, first.color.b];
  }
  return undefined;
}

function objectToMeshes(root: THREE.Object3D, fallbackName: string): CadMeshData[] {
  root.updateMatrixWorld(true);
  const meshes: CadMeshData[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const position = geometry.getAttribute('position');
    if (!position) return;
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const indices = index ? new Uint32Array(Array.from(index.array, (value) => Number(value))) : null;
    const color = materialColor(object);
    meshes.push({
      name: object.name || geometry.name || `${fallbackName} ${meshes.length + 1}`,
      positions: attributeArray(position),
      normals: normal ? attributeArray(normal) : null,
      indices,
      ...(color ? { color } : {})
    });
    geometry.dispose();
  });
  return meshes;
}

function finish(meshes: CadMeshData[], format: string, started: number): CadImportResult {
  if (meshes.length === 0) throw new Error('文件中没有可显示的网格');
  const triangleCount = meshes.reduce((sum, mesh) => {
    if (mesh.indices) return sum + Math.floor(mesh.indices.length / 3);
    return sum + Math.floor(mesh.positions.length / 9);
  }, 0);
  return {
    meshes,
    stats: {
      meshCount: meshes.length,
      triangleCount,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      format
    }
  };
}

async function parseGltf(buffer: ArrayBuffer, name: string): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  return await new Promise<THREE.Object3D>((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (gltf) => resolve(gltf.scene),
      (error) => reject(error instanceof Error ? error : new Error(String(error)))
    );
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GLTF/GLB 加载失败（${name}）：${message}`);
  });
}

/**
 * 把多份标准格式（STL/OBJ/GLTF）合并成一个导入结果：每份保留为独立网格，
 * 零件树、干涉检查、运动学标注都按「零件」看待。
 *
 * 参数化内核逐件导出的 28 个 STL 就走这里装配成整机。
 *
 * `color` 是调用方按「件 → 材质」查出来的材质标识色（线性 RGB）。STL 没有颜色通道，
 * 不在这里喂进来的话，视口和 GLB 导出都只能退回灰色默认色板
 * （`load-candidate` 的 DEFAULT_COLORS），整机看起来就是一坨灰。
 */
export async function parseStandardCadBuffers(
  items: ReadonlyArray<{ buffer: ArrayBuffer; name: string; color?: [number, number, number] }>,
  formatLabel = 'STL'
): Promise<CadImportResult> {
  const started = performance.now();
  const meshes: CadImportResult['meshes'] = [];
  let triangleCount = 0;
  for (const item of items) {
    // name 是显示名（如「侧纵梁（操作侧）」），格式判定需要带扩展名
    const probe = /\.[a-z0-9]{1,5}$/i.test(item.name) ? item.name : `${item.name}.stl`;
    const single = await parseStandardCadBuffer(item.buffer, probe);
    for (const mesh of single.meshes) {
      meshes.push({
        ...mesh,
        name: item.name,
        ...(item.color ? { color: [...item.color] as [number, number, number] } : {})
      });
    }
    triangleCount += single.stats.triangleCount;
  }
  return {
    meshes,
    stats: {
      meshCount: meshes.length,
      triangleCount,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      format: formatLabel
    }
  };
}

export async function parseStandardCadBuffer(buffer: ArrayBuffer, fileName: string): Promise<CadImportResult> {
  const started = performance.now();
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const root = new THREE.Mesh(geometry);
    root.name = fileName;
    const result = finish(objectToMeshes(root, fileName), 'STL', started);
    geometry.dispose();
    return result;
  }
  if (ext === 'obj') {
    const text = new TextDecoder('utf-8').decode(buffer);
    const object = new OBJLoader().parse(text);
    return finish(objectToMeshes(object, fileName), 'OBJ', started);
  }
  if (ext === 'gltf' || ext === 'glb') {
    const scene = await parseGltf(buffer, fileName);
    return finish(objectToMeshes(scene, fileName), ext.toUpperCase(), started);
  }
  throw new Error(`不支持的 CAD 格式：${fileName}`);
}
