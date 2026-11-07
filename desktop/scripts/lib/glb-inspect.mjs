// GLB 检查：只读 JSON chunk 里的 materials，不碰二进制几何。
// 用途一：`pv-conveyor.glb` 必须带 ≥4 个材质，且 baseColorFactor 与四种材质色对应
//        （glTF 存线性值，日志里同时给回 hex 便于对照）。
// 用途二：排查「导出的 GLB 只有 1 个 material、还没有 baseColorFactor」——
//        GLTFExporter 在颜色等于纯白时会**省略** baseColorFactor，所以「无 baseColorFactor」
//        本身就是「这份材质没被上色」的证据（three 的 GLTFExporter.js:1669）。
import { MATERIAL_COLORS } from '../../src/machine/machine-geometry.ts';

/** 解析 GLB 容器 → { version, json, binLength } */
export function readGlb(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 12) throw new Error('GLB 太短');
  const magic = bytes.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`不是 GLB（magic=0x${magic.toString(16)}）`);
  const version = bytes.readUInt32LE(4);
  const length = bytes.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let binLength = 0;
  while (offset + 8 <= Math.min(length, bytes.length)) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(bytes.toString('utf8', start, start + chunkLength).replace(/\0+$/, '').trim());
    } else if (chunkType === 0x004e4942) {
      binLength = chunkLength;
    }
    offset = start + chunkLength;
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk');
  return { version, json, binLength };
}

function linearToHex(rgb) {
  const channel = (value) => {
    const clamped = Math.min(1, Math.max(0, Number(value) || 0));
    const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** GLB → 材质清单（带由 baseColorFactor 反算的 sRGB hex）。 */
export function glbMaterials(buffer) {
  const { json, binLength, version } = readGlb(buffer);
  const materials = (json.materials ?? []).map((entry, index) => {
    const pbr = entry?.pbrMetallicRoughness ?? {};
    const base = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : null;
    return {
      index,
      name: entry?.name ?? null,
      baseColorFactor: base,
      hex: base ? linearToHex(base) : null,
      metallicFactor: pbr.metallicFactor ?? null,
      roughnessFactor: pbr.roughnessFactor ?? null,
      emissiveFactor: Array.isArray(entry?.emissiveFactor) ? entry.emissiveFactor : null
    };
  });
  return { version, binLength, materials, meshes: (json.meshes ?? []).length, nodes: (json.nodes ?? []).length };
}

/** 期望的线性 baseColorFactor（sRGB hex → 线性，glTF 的存储空间）。 */
export function expectedLinearColors() {
  const channel = (srgb) => (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);
  return Object.entries(MATERIAL_COLORS).map(([material, hex]) => {
    const value = hex.replace('#', '');
    const linear = [0, 2, 4].map((index) => channel(parseInt(value.slice(index, index + 2), 16) / 255));
    return { material, hex, linear };
  });
}

/**
 * 硬闸门：≥4 个材质，且四种材质色都能在 baseColorFactor 里找到（逐分量容差）。
 * 容差默认 0.02：three 写的是 float，Color 内部再做一次线性化，误差远小于此。
 */
export function checkGlbMaterials(buffer, options = {}) {
  const tolerance = options.tolerance ?? 0.02;
  const minMaterials = options.minMaterials ?? 4;
  const { materials } = glbMaterials(buffer);
  const expected = expectedLinearColors();
  const matched = expected.map((target) => {
    const hit = materials.find((entry) => {
      const base = entry.baseColorFactor;
      if (!base) return false;
      return target.linear.every((value, index) => Math.abs((base[index] ?? 0) - value) <= tolerance);
    });
    return { ...target, found: Boolean(hit), materialIndex: hit ? hit.index : null };
  });
  return {
    ok: materials.length >= minMaterials && matched.every((entry) => entry.found),
    materials,
    matched,
    failures: [
      ...(materials.length >= minMaterials ? [] : [`材质数 ${materials.length} < ${minMaterials}`]),
      ...matched.filter((entry) => !entry.found).map((entry) => `缺材质色 ${entry.material} ${entry.hex}`)
    ],
    tolerance,
    minMaterials
  };
}

export function describeGlbMaterials(result) {
  const rows = result.materials.map((entry) => `#${entry.index}:${entry.hex ?? '(无baseColorFactor)'}${entry.baseColorFactor ? '' : '!'}`);
  return `materials=${result.materials.length} [${rows.join(' ')}] matched=${result.matched.filter((entry) => entry.found).length}/4 tol=${result.tolerance}`;
}
