// 机型几何导出：纯 TS 三角网格（离线兜底）、二进制 STL、glTF 2.0（内嵌缓冲），
// 以及与 build123d sidecar 契约兼容的装配实体列表（分块 ≤ 50 实体）。
//
// 诚实边界：
// - STL / glTF 是三角网格，圆柱按 segments 段多边形近似；不是 B-Rep，不能直接做 CAM。
// - STEP 只能经 build123d sidecar 产出；sidecar 的 box / cylinder 算子支持 axis=x/y/z，
//   因此竖直圆柱与横轴圆柱（滚筒、传动轴、光电/接近开关本体）都是精确回转体，不再退化成方棒。

import {
  ASSEMBLY_SCHEMA_VERSION,
  MAX_ASSEMBLY_CHUNK,
  type AssemblyDoc,
  type FeatureNode,
  type PartInstance
} from '../parametric/features.ts';
import type { GeomPart, MachineGeometry, Vec3 } from './geometry.ts';

export interface PartMesh {
  /** 非索引三角形顶点（局部坐标，mm），每 9 个数一个三角形。 */
  positions: number[];
  /** 与 positions 一一对应的顶点法向。 */
  normals: number[];
}

export const DEFAULT_SEGMENTS = 24;

function pushTri(mesh: PartMesh, a: Vec3, b: Vec3, c: Vec3, na: Vec3, nb: Vec3 = na, nc: Vec3 = na): void {
  mesh.positions.push(...a, ...b, ...c);
  mesh.normals.push(...na, ...nb, ...nc);
}

function boxMesh(size: Vec3): PartMesh {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const mesh: PartMesh = { positions: [], normals: [] };
  const faces: { n: Vec3; corners: Vec3[] }[] = [
    { n: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], corners: [[-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz]] },
    { n: [0, 1, 0], corners: [[hx, hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], corners: [[-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz]] }
  ];
  for (const face of faces) {
    const [a, b, c, d] = face.corners as [Vec3, Vec3, Vec3, Vec3];
    pushTri(mesh, a, b, c, face.n);
    pushTri(mesh, a, c, d, face.n);
  }
  return mesh;
}

/** 沿 Z 的圆柱，再按 axis 置换坐标。 */
function cylinderMesh(radius: number, length: number, axis: 'x' | 'y' | 'z', segments: number): PartMesh {
  const raw: PartMesh = { positions: [], normals: [] };
  const h = length / 2;
  const ring = (i: number): [number, number] => {
    const angle = (2 * Math.PI * i) / segments;
    return [Math.cos(angle), Math.sin(angle)];
  };
  for (let i = 0; i < segments; i += 1) {
    const [c0, s0] = ring(i);
    const [c1, s1] = ring(i + 1);
    const p00: Vec3 = [radius * c0, radius * s0, -h];
    const p10: Vec3 = [radius * c1, radius * s1, -h];
    const p01: Vec3 = [radius * c0, radius * s0, h];
    const p11: Vec3 = [radius * c1, radius * s1, h];
    const n0: Vec3 = [c0, s0, 0];
    const n1: Vec3 = [c1, s1, 0];
    pushTri(raw, p00, p10, p11, n0, n1, n1);
    pushTri(raw, p00, p11, p01, n0, n1, n0);
    pushTri(raw, [0, 0, h], p01, p11, [0, 0, 1]);
    pushTri(raw, [0, 0, -h], p10, p00, [0, 0, -1]);
  }
  if (axis === 'z') return raw;
  const permute = (values: number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < values.length; i += 3) {
      const x = values[i] as number;
      const y = values[i + 1] as number;
      const z = values[i + 2] as number;
      // axis=x：(x,y,z)→(z,x,y)；axis=y：(x,y,z)→(y,z,x)。两者都是保持手性的循环置换。
      if (axis === 'x') out.push(z, x, y);
      else out.push(y, z, x);
    }
    return out;
  };
  return { positions: permute(raw.positions), normals: permute(raw.normals) };
}

/** 单个零件的局部网格（中心在原点、未旋转）。 */
export function partLocalMesh(part: Pick<GeomPart, 'shape'>, segments = DEFAULT_SEGMENTS): PartMesh {
  if (part.shape.type === 'box') return boxMesh(part.shape.size);
  return cylinderMesh(part.shape.radius, part.shape.length, part.shape.axis, Math.max(8, Math.floor(segments)));
}

function transformPoint(part: Pick<GeomPart, 'center' | 'rotationZDeg'>, x: number, y: number, z: number): Vec3 {
  const rad = (part.rotationZDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [part.center[0] + x * cos - y * sin, part.center[1] + x * sin + y * cos, part.center[2] + z];
}

/** 零件世界坐标三角形（mm），每 9 个数一个三角形。 */
export function partWorldTriangles(part: GeomPart, segments = DEFAULT_SEGMENTS): number[] {
  const mesh = partLocalMesh(part, segments);
  const out: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    out.push(...transformPoint(part, mesh.positions[i] as number, mesh.positions[i + 1] as number, mesh.positions[i + 2] as number));
  }
  return out;
}

export function geometryTriangleCount(geometry: MachineGeometry, segments = DEFAULT_SEGMENTS): number {
  return geometry.parts.reduce((sum, part) => sum + partLocalMesh(part, segments).positions.length / 9, 0);
}

/** 二进制 STL（mm，Z 向上）。法向由三角形绕向计算。 */
export function geometryToStl(geometry: MachineGeometry, segments = DEFAULT_SEGMENTS): Uint8Array {
  const triangles: number[] = [];
  for (const part of geometry.parts) triangles.push(...partWorldTriangles(part, segments));
  const count = triangles.length / 9;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  const header = `AutomationCAD machine-geometry ${geometry.machineId} mm`.slice(0, 80);
  for (let i = 0; i < header.length; i += 1) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, count, true);
  let offset = 84;
  for (let t = 0; t < count; t += 1) {
    const base = t * 9;
    const v = (k: number): number => triangles[base + k] as number;
    const ux = v(3) - v(0);
    const uy = v(4) - v(1);
    const uz = v(5) - v(2);
    const wx = v(6) - v(0);
    const wy = v(7) - v(1);
    const wz = v(8) - v(2);
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    for (let k = 0; k < 9; k += 1) view.setFloat32(offset + 12 + k * 4, v(k), true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return bytes;
}

function hexToLinear(hex: string): [number, number, number] {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '808080';
  const channel = (index: number): number => {
    const srgb = parseInt(value.slice(index, index + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(2), channel(4)].map((item) => Math.round(item * 10000) / 10000) as [number, number, number];
}

function base64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/**
 * glTF 2.0（.gltf，缓冲以 data URI 内嵌）。单位米、Y 向上：根节点绕 X 轴 -90°，
 * 子节点保持 Z 向上 mm 数据 × 0.001。零件元数据与运动轴写入 extras。
 */
export function geometryToGltf(geometry: MachineGeometry, segments = DEFAULT_SEGMENTS): Record<string, unknown> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const materialIndex = new Map<string, number>();
  const meshIndex = new Map<string, number>();

  const appendFloats = (values: number[]): number => {
    const array = new Float32Array(values);
    const bytes = new Uint8Array(array.buffer);
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target: 34962 });
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    return view;
  };

  for (const part of geometry.parts) {
    const shapeKey = JSON.stringify(part.shape);
    const colorKey = part.color;
    let mat = materialIndex.get(colorKey);
    if (mat === undefined) {
      mat = materials.length;
      materialIndex.set(colorKey, mat);
      materials.push({
        name: colorKey,
        pbrMetallicRoughness: { baseColorFactor: [...hexToLinear(colorKey), 1], metallicFactor: 0.3, roughnessFactor: 0.6 }
      });
    }
    const meshKey = `${shapeKey}|${mat}`;
    let meshId = meshIndex.get(meshKey);
    if (meshId === undefined) {
      const local = partLocalMesh(part, segments);
      const positions = local.positions.map((value) => value * 0.001);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k += 1) {
          const value = positions[i + k] as number;
          min[k] = Math.min(min[k] as number, value);
          max[k] = Math.max(max[k] as number, value);
        }
      }
      const posView = appendFloats(positions);
      const normView = appendFloats(local.normals);
      const posAccessor = accessors.length;
      accessors.push({ bufferView: posView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max });
      const normAccessor = accessors.length;
      accessors.push({ bufferView: normView, componentType: 5126, count: local.normals.length / 3, type: 'VEC3' });
      meshId = meshes.length;
      meshIndex.set(meshKey, meshId);
      meshes.push({ primitives: [{ attributes: { POSITION: posAccessor, NORMAL: normAccessor }, material: mat, mode: 4 }] });
    }
    const half = (part.rotationZDeg * Math.PI) / 360;
    nodes.push({
      name: part.id,
      mesh: meshId,
      translation: part.center.map((value) => Math.round(value * 1e6) / 1e9),
      ...(part.rotationZDeg !== 0 ? { rotation: [0, 0, Math.sin(half), Math.cos(half)] } : {}),
      extras: {
        name: part.name,
        role: part.role,
        material: part.material,
        bomGroup: part.bomGroup,
        ...(part.stationId ? { stationId: part.stationId } : {}),
        ...(part.actuatorId ? { actuatorId: part.actuatorId } : {}),
        ...(part.sensorPoint ? { sensorPoint: part.sensorPoint } : {}),
        ...(part.moving ? { moving: true } : {})
      }
    });
  }
  const rootIndex = nodes.length;
  nodes.push({
    name: geometry.machineId,
    rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    children: Array.from({ length: rootIndex }, (_unused, index) => index),
    extras: {
      kind: geometry.kind,
      units: 'mm (scaled to m)',
      layout: geometry.layout,
      envelopeMm: geometry.envelope,
      moving: geometry.moving
    }
  });

  const buffer = new Uint8Array(byteLength);
  let cursor = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return {
    asset: { version: '2.0', generator: 'AutomationCAD machine-geometry' },
    scene: 0,
    scenes: [{ name: geometry.name, nodes: [rootIndex] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${base64(buffer)}` }]
  };
}

// ── build123d sidecar 契约 ──────────────────────────────────────────────────

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  const result = Math.round(value * scale) / scale;
  return Object.is(result, -0) ? 0 : result;
}

/** 零件 → sidecar 特征列表（box 居中；圆柱一律精确：竖直 = 内接小方块 + cylinder，横轴 = 带 axis 的 cylinder）。 */
export function partSidecarFeatures(part: GeomPart): { features: FeatureNode[]; approximated: boolean } {
  if (part.shape.type === 'box') {
    const [length, width, height] = part.shape.size;
    return {
      features: [{ id: 'f1', type: 'box', name: part.name, params: { length, width, height, centered: true } }],
      approximated: false
    };
  }
  const { radius, length, axis } = part.shape;
  if (axis === 'z') {
    // sidecar 的 cylinder 需要先有实体：用完全包含在圆柱内的小方块做种子，并集后仍是精确圆柱。
    const seed = round(radius);
    return {
      features: [
        { id: 'f1', type: 'box', name: `${part.name}（种子）`, params: { length: seed, width: seed, height: round(length / 2), centered: true } },
        { id: 'f2', type: 'cylinder', name: part.name, params: { diameter: round(radius * 2), height: length, at: [0, 0, 0] } }
      ],
      approximated: false
    };
  }
  // 横轴（滚筒、传动轴、光电/接近开关本体）：内核 cylinder 支持 axis=x/y，按轴旋转展开后仍是精确回转体。
  // 不再用「等截面积方棒」近似（方棒边长 r√π，包围盒比真圆柱小约 11%、面数 6 而非 3）。
  // at 固定 [0,0,0]：特征在零件局部坐标系里建模，零件中心由实例 transform 摆位（与 z 轴写法一致）。
  return {
    features: [{
      id: 'f1',
      type: 'cylinder',
      name: part.name,
      params: { diameter: round(radius * 2), height: length, axis, at: [0, 0, 0] }
    }],
    approximated: false
  };
}

export interface SidecarAssemblyBundle {
  /** 每块 ≤ MAX_ASSEMBLY_CHUNK 个实体，可逐块 POST /build。 */
  chunks: AssemblyDoc[];
  instances: number;
  /**
   * 近似件 id。横轴圆柱已改精确 cylinder（axis=x/y），目前恒为空数组；
   * 字段保留是为了 commands.ts 的 «近似件 warning» 契约不回退（将来若再加近似算子仍可复用）。
   */
  approximated: string[];
}

export function geometryToSidecarAssemblies(
  geometry: MachineGeometry,
  options: { updatedAt?: string; maxInstances?: number } = {}
): SidecarAssemblyBundle {
  const max = Math.max(1, Math.min(MAX_ASSEMBLY_CHUNK, options.maxInstances ?? MAX_ASSEMBLY_CHUNK));
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const instances: PartInstance[] = [];
  const approximated: string[] = [];
  for (const part of geometry.parts) {
    const { features, approximated: approx } = partSidecarFeatures(part);
    if (approx) approximated.push(part.id);
    instances.push({
      id: part.id,
      name: part.name,
      transform: { x: part.center[0], y: part.center[1], z: part.center[2], rz: part.rotationZDeg },
      features
    });
  }
  const chunks: AssemblyDoc[] = [];
  for (let start = 0; start < instances.length; start += max) {
    chunks.push({
      schemaVersion: ASSEMBLY_SCHEMA_VERSION,
      sourceFile: `machine:${geometry.machineId}#${chunks.length + 1}`,
      instances: instances.slice(start, start + max),
      updatedAt
    });
  }
  return { chunks, instances: instances.length, approximated };
}

export interface SolidBuildResult {
  ok: boolean;
  code?: string;
  message?: string;
  files?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

export interface MachineSolidsReport {
  mode: 'solids' | 'mesh-fallback';
  chunks: number;
  built: number;
  /** 每块 sidecar 返回的 STEP 临时文件路径（成功时）。 */
  stepFiles: string[];
  message: string;
}

/**
 * 有 sidecar 时逐块实体化；任一块失败或 sidecar 不可用即整体回退到 TS 网格（STL/glTF 已另行生成），
 * 不把部分实体结果冒充完整整机。
 */
export async function buildMachineSolids(
  bundle: SidecarAssemblyBundle,
  build: ((doc: AssemblyDoc) => Promise<SolidBuildResult>) | undefined
): Promise<MachineSolidsReport> {
  if (!build) {
    return { mode: 'mesh-fallback', chunks: bundle.chunks.length, built: 0, stepFiles: [], message: '参数化建模内核未接入，已回退为 TS 网格（STL/glTF）' };
  }
  const stepFiles: string[] = [];
  for (const [index, chunk] of bundle.chunks.entries()) {
    let result: SolidBuildResult;
    try {
      result = await build(chunk);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      return {
        mode: 'mesh-fallback',
        chunks: bundle.chunks.length,
        built: index,
        stepFiles: [],
        message: `第 ${index + 1}/${bundle.chunks.length} 块实体化失败（${result.message ?? result.code ?? '未知原因'}），已回退为 TS 网格（STL/glTF）`
      };
    }
    const step = result.files?.step;
    const path = step && typeof step === 'object' && typeof (step as { path?: unknown }).path === 'string'
      ? (step as { path: string }).path
      : null;
    if (path) stepFiles.push(path);
  }
  return {
    mode: 'solids',
    chunks: bundle.chunks.length,
    built: bundle.chunks.length,
    stepFiles,
    message: `已经 build123d 实体化 ${bundle.chunks.length} 块（${bundle.instances} 个实体）`
  };
}
