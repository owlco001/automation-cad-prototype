import occtimportjs, { type OcctModule, type OcctNode } from 'occt-import-js';
import type { CadImportResult, CadMeshData } from '../shared/types';
import { readablePartNames } from './part-naming.ts';
import { occtFormatForFile } from './format.ts';
export { occtFormatForFile } from './format.ts';

export interface ParseOcctOptions {
  wasmUrl?: string;
  occt?: OcctModule;
}

let occtPromise: Promise<OcctModule> | null = null;
let occtWasmUrl: string | undefined;

function loadOcct(options: ParseOcctOptions): Promise<OcctModule> {
  if (options.occt) return Promise.resolve(options.occt);
  if (!occtPromise) {
    occtWasmUrl = options.wasmUrl;
    occtPromise = occtimportjs(
      occtWasmUrl
        ? { locateFile: (path: string) => (path.endsWith('.wasm') ? occtWasmUrl! : path) }
        : undefined
    );
  }
  return occtPromise;
}

function toFloat32Array(values: number[]): Float32Array {
  return new Float32Array(values);
}

function toIndexArray(values: number[], vertexCount: number): Uint32Array | null {
  if (values.length === 0) return null;
  const maxIndex = values.reduce((max, value) => Math.max(max, value), 0);
  const result = maxIndex > 65535 || vertexCount > 65535 ? new Uint32Array(values) : new Uint16Array(values);
  return new Uint32Array(result);
}

/**
 * 从 occt 装配树为每个网格算出层级路径（根 → 父节点名）。
 * 空名节点跳过；叶子节点名与网格同名时不重复计入。只含零件的子装配已被 occt 压平，路径只到其上一级。
 */
export function meshPathsFromRoot(root: OcctNode | undefined, meshNames: readonly string[]): (string[] | undefined)[] {
  const paths: (string[] | undefined)[] = meshNames.map(() => undefined);
  if (!root) return paths;
  const walk = (node: OcctNode, ancestors: string[], depth: number): void => {
    if (depth > 64) return;
    const name = typeof node.name === 'string' ? node.name.trim() : '';
    const here = name ? [...ancestors, name] : ancestors;
    for (const index of Array.isArray(node.meshes) ? node.meshes : []) {
      if (!Number.isInteger(index) || index < 0 || index >= paths.length) continue;
      const meshName = (meshNames[index] ?? '').trim();
      const trimmed = here.length > 0 && here[here.length - 1] === meshName ? here.slice(0, -1) : here;
      paths[index] = [...trimmed];
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, here, depth + 1);
  };
  walk(root, [], 0);
  return paths;
}

export async function parseOcctBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  options: ParseOcctOptions = {}
): Promise<CadImportResult> {
  const started = performance.now();
  const format = occtFormatForFile(fileName);
  if (!format) {
    throw new Error(`不支持的 OCCT 文件格式：${fileName}`);
  }

  const occt = await loadOcct(options);
  const bytes = new Uint8Array(buffer);
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5
  };

  let raw;
  if (format === 'step') raw = occt.ReadStepFile(bytes, params);
  else if (format === 'iges') raw = occt.ReadIgesFile(bytes, params);
  else raw = occt.ReadBrepFile(bytes, params);

  if (!raw.success) {
    throw new Error(`CAD 解析失败：${fileName}`);
  }

  // 先按网格自身顶点算包围盒：通用名（COMPOUND/SOLID/Part…）要用「序号 + 尺寸」替换成可读名
  const boxes = raw.meshes.map((mesh) => {
    const values = mesh.attributes.position.array;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < values.length; i += 3) {
      const x = values[i] ?? 0, y = values[i + 1] ?? 0, z = values[i + 2] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const finite = Number.isFinite(minX) && Number.isFinite(maxX);
    return {
      name: typeof mesh.name === 'string' ? mesh.name : '',
      sizeMm: (finite
        ? [maxX - minX, maxY - minY, maxZ - minZ]
        : [0, 0, 0]) as [number, number, number]
    };
  });
  const names = readablePartNames(boxes);

  const meshes: CadMeshData[] = raw.meshes.map((mesh, index) => {
    const positions = toFloat32Array(mesh.attributes.position.array);
    const normalValues = mesh.attributes.normal?.array;
    const normals = normalValues && normalValues.length > 0 ? toFloat32Array(normalValues) : null;
    const indices = toIndexArray(mesh.index.array, positions.length / 3);
    return {
      name: names[index] ?? `零件-${String(index + 1).padStart(2, '0')}`,
      positions,
      normals,
      indices,
      ...(mesh.color ? { color: mesh.color } : {})
    };
  });

  const paths = meshPathsFromRoot(raw.root, meshes.map((mesh) => mesh.name));
  meshes.forEach((mesh, index) => {
    const path = paths[index];
    if (path && path.length > 0) mesh.path = path;
  });

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
      format: format.toUpperCase()
    }
  };
}
