export const CAD_PREVIEW_EXTENSIONS = Object.freeze(['.glb', '.stl']);
export const CAD_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
export const CAD_PREVIEW_MAX_TRIANGLES = 500_000;
export const CAD_PREVIEW_MAX_MESHES = 500;
export const CAD_PREVIEW_MAX_VERTICES = 1_000_000;
const MAX_COORDINATE = 1_000_000_000;

function fail(message, code = 'CAD_PREVIEW_PARSE_FAILED') {
  throw Object.assign(new Error(message), { code });
}

function bytesOf(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  fail('CAD 文件数据格式无效。');
}

function checkedNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE) fail(`模型坐标无效：${label}`);
  return number;
}

function checkBudget(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) fail('CAD 文件为空或大小无效。');
  if (byteLength > CAD_PREVIEW_MAX_BYTES) fail('CAD 文件超过 32 MiB 预览上限。', 'CAD_PREVIEW_TOO_LARGE');
}

function parseStl(bytes) {
  let positions;
  let triangleCount = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 84) {
    const binaryCount = view.getUint32(80, true);
    const binaryLength = 84 + binaryCount * 50;
    if (binaryLength === bytes.byteLength && binaryCount > CAD_PREVIEW_MAX_TRIANGLES) fail('STL 三角面数超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
    if (binaryCount > 0 && binaryCount <= CAD_PREVIEW_MAX_TRIANGLES && binaryLength === bytes.byteLength) {
      triangleCount = binaryCount;
      positions = new Float32Array(triangleCount * 9);
      let output = 0;
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const record = 84 + triangle * 50 + 12;
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const base = record + vertex * 12;
          for (let axis = 0; axis < 3; axis += 1) {
            positions[output] = checkedNumber(view.getFloat32(base + axis * 4, true), `STL ${triangle}:${vertex}:${axis}`);
            output += 1;
          }
        }
      }
    }
  }

  if (!positions) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('STL 既不是有效的二进制 STL，也不是 UTF-8 ASCII STL。');
    }
    const vertices = [];
    const pattern = /\bvertex\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/giu;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      vertices.push(
        checkedNumber(match[1], 'ASCII STL x'),
        checkedNumber(match[2], 'ASCII STL y'),
        checkedNumber(match[3], 'ASCII STL z')
      );
      if (vertices.length > CAD_PREVIEW_MAX_TRIANGLES * 9) fail('STL 三角面数超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
    }
    if (vertices.length === 0 || vertices.length % 9 !== 0) fail('STL 中没有完整的三角面。');
    triangleCount = vertices.length / 9;
    if (triangleCount > CAD_PREVIEW_MAX_TRIANGLES) fail('STL 三角面数超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
    positions = new Float32Array(vertices);
  }
  return {
    format: 'STL',
    meshes: [{ name: 'STL 网格', positions, normals: null, indices: null, color: null }],
    meshGroups: [],
    nodes: [],
    sceneRoots: [],
    triangleCount,
    meshCount: 1
  };
}

function parseGlb(bytes) {
  if (bytes.byteLength < 20) fail('GLB 文件头或 JSON 块不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    fail('仅支持长度有效的 glTF 2.0 二进制 GLB。');
  }

  let cursor = 12;
  let jsonBytes = null;
  let binBytes = null;
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) fail('GLB 块头不完整。');
    const chunkLength = view.getUint32(cursor, true);
    const chunkType = view.getUint32(cursor + 4, true);
    const chunkStart = cursor + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkLength === 0 || chunkLength % 4 !== 0 || chunkEnd > bytes.byteLength) fail('GLB 块长度无效。');
    if (chunkType === 0x4e4f534a && jsonBytes === null && cursor === 12) {
      jsonBytes = bytes.subarray(chunkStart, chunkEnd);
    } else if (chunkType === 0x004e4942 && jsonBytes !== null && binBytes === null) {
      binBytes = bytes.subarray(chunkStart, chunkEnd);
    } else {
      fail('GLB 含不支持或重复的块。');
    }
    cursor = chunkEnd;
  }
  if (cursor !== bytes.byteLength || jsonBytes === null) fail('GLB JSON 块缺失。');

  let document;
  try {
    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes).replace(/[\u0000 ]+$/u, '');
    document = JSON.parse(jsonText);
  } catch {
    fail('GLB JSON 块无效。');
  }
  if (!document || typeof document !== 'object' || document.asset?.version !== '2.0') fail('GLB 资产声明不是 glTF 2.0。');
  for (const field of ['extensionsUsed', 'extensionsRequired', 'animations', 'skins', 'textures']) {
    if (document[field] !== undefined && (!Array.isArray(document[field]) || document[field].length > 0)) {
      fail('Core 预览仅支持无扩展、无动画/蒙皮/纹理的静态网格 GLB。');
    }
  }
  if (document.extensionsRequired?.length > 0) {
    fail('Core 预览仅支持无扩展、无动画和无蒙皮的静态网格 GLB。');
  }

  const buffers = document.buffers ?? [];
  if (!Array.isArray(buffers) || buffers.length > 1) fail('GLB 仅支持单个内嵌二进制缓冲区。');
  let bin = new Uint8Array(0);
  if (buffers.length === 1) {
    const buffer = buffers[0];
    if (!buffer || Object.hasOwn(buffer, 'uri') || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength <= 0 || !binBytes || buffer.byteLength > binBytes.byteLength || binBytes.byteLength - buffer.byteLength > 3) {
      fail('GLB 缓冲区必须内嵌于文件且长度有效。');
    }
    bin = binBytes.subarray(0, buffer.byteLength);
  } else if (binBytes && binBytes.byteLength > 0) {
    fail('GLB 含未声明的二进制块。');
  }

  const imageList = document.images ?? [];
  if (!Array.isArray(imageList) || imageList.length > 0) {
    fail('Core 预览不加载 GLB 图片或纹理，仅显示几何与基础颜色。');
  }

  const bufferViews = document.bufferViews ?? [];
  if (!Array.isArray(bufferViews)) fail('GLB bufferView 清单无效。');
  for (const bufferView of bufferViews) {
    const offset = bufferView?.byteOffset ?? 0;
    if (!bufferView || bufferView.buffer !== 0 || !Number.isSafeInteger(offset) || !Number.isSafeInteger(bufferView.byteLength) || offset < 0 || bufferView.byteLength <= 0 || offset + bufferView.byteLength > bin.byteLength) {
      fail('GLB bufferView 越界或引用无效缓冲区。');
    }
  }

  const accessors = document.accessors ?? [];
  if (!Array.isArray(accessors)) fail('GLB accessor 清单无效。');
  const componentsByType = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function readAccessor(index, expectedType, componentTypes) {
    if (!Number.isInteger(index) || index < 0 || index >= accessors.length) fail('GLB primitive 引用了不存在的 accessor。');
    const accessor = accessors[index];
    const componentCount = componentsByType[accessor?.type];
    const componentType = accessor?.componentType;
    if (!accessor || accessor.sparse || accessor.normalized === true || accessor.type !== expectedType || !componentTypes.includes(componentType) || !Number.isSafeInteger(accessor.count) || accessor.count <= 0) {
      fail('GLB accessor 类型、稀疏数据或数量不受支持。');
    }
    const bufferViewIndex = accessor.bufferView;
    if (!Number.isInteger(bufferViewIndex) || bufferViewIndex < 0 || bufferViewIndex >= bufferViews.length) fail('GLB accessor 缺少有效 bufferView。');
    const bufferView = bufferViews[bufferViewIndex];
    const componentBytes = componentType === 5126 || componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1;
    const elementBytes = componentBytes * componentCount;
    const stride = bufferView.byteStride ?? elementBytes;
    const viewOffset = bufferView.byteOffset ?? 0;
    const accessorOffset = accessor.byteOffset ?? 0;
    if (!Number.isSafeInteger(stride) || stride < elementBytes || stride > 252 || stride % componentBytes !== 0 || !Number.isSafeInteger(accessorOffset) || accessorOffset < 0 || (viewOffset + accessorOffset) % componentBytes !== 0) {
      fail('GLB accessor 对齐或步长无效。');
    }
    const end = viewOffset + accessorOffset + (accessor.count - 1) * stride + elementBytes;
    if (end > viewOffset + bufferView.byteLength || end > bin.byteLength) fail('GLB accessor 数据越界。');
    const output = expectedType === 'SCALAR' ? new Uint32Array(accessor.count) : new Float32Array(accessor.count * componentCount);
    const reader = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let item = 0; item < accessor.count; item += 1) {
      const itemOffset = viewOffset + accessorOffset + item * stride;
      for (let component = 0; component < componentCount; component += 1) {
        const position = itemOffset + component * componentBytes;
        let value;
        if (componentType === 5126) value = reader.getFloat32(position, true);
        else if (componentType === 5125) value = reader.getUint32(position, true);
        else if (componentType === 5123) value = reader.getUint16(position, true);
        else value = reader.getUint8(position);
        if (expectedType !== 'SCALAR') value = checkedNumber(value, `GLB accessor ${index}`);
        output[item * componentCount + component] = value;
      }
    }
    return { values: output, count: accessor.count };
  }

  const meshDefinitions = document.meshes ?? [];
  if (!Array.isArray(meshDefinitions) || meshDefinitions.length === 0 || meshDefinitions.length > CAD_PREVIEW_MAX_MESHES) fail('GLB 网格数量为空或超过预览上限。');
  const meshes = [];
  const meshGroups = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  for (let meshIndex = 0; meshIndex < meshDefinitions.length; meshIndex += 1) {
    const definition = meshDefinitions[meshIndex];
    if (!definition || !Array.isArray(definition.primitives) || definition.primitives.length === 0) fail('GLB 网格不含可预览 primitive。');
    const group = [];
    for (let primitiveIndex = 0; primitiveIndex < definition.primitives.length; primitiveIndex += 1) {
      const primitive = definition.primitives[primitiveIndex];
      if (!primitive || (primitive.mode !== undefined && primitive.mode !== 4) || !primitive.attributes || typeof primitive.attributes !== 'object') {
        fail('Core 预览仅支持三角面 GLB primitive。');
      }
      if (primitive.targets !== undefined || Object.keys(primitive.attributes).some((attribute) => !['POSITION', 'NORMAL'].includes(attribute))) {
        fail('Core 预览仅支持 POSITION 与可选 NORMAL 属性，不支持 morph targets。');
      }
      const positionAccessor = readAccessor(primitive.attributes.POSITION, 'VEC3', [5126]);
      const positions = positionAccessor.values;
      totalVertices += positionAccessor.count;
      if (totalVertices > CAD_PREVIEW_MAX_VERTICES) fail('GLB 顶点数量超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
      let normals = null;
      if (primitive.attributes.NORMAL !== undefined) {
        const normalAccessor = readAccessor(primitive.attributes.NORMAL, 'VEC3', [5126]);
        if (normalAccessor.count !== positionAccessor.count) fail('GLB 法线与顶点数量不一致。');
        normals = normalAccessor.values;
      }
      let indices = null;
      let primitiveTriangles;
      if (primitive.indices !== undefined) {
        const indexAccessor = readAccessor(primitive.indices, 'SCALAR', [5121, 5123, 5125]);
        indices = indexAccessor.values;
        if (indices.length % 3 !== 0 || indices.some((value) => value >= positionAccessor.count)) fail('GLB 索引数组无效或不成完整三角面。');
        primitiveTriangles = indices.length / 3;
      } else {
        if (positionAccessor.count % 3 !== 0) fail('GLB 非索引网格的顶点数不成完整三角面。');
        primitiveTriangles = positionAccessor.count / 3;
      }
      totalTriangles += primitiveTriangles;
      if (totalTriangles > CAD_PREVIEW_MAX_TRIANGLES) fail('GLB 三角面数超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
      let color = null;
      if (primitive.material !== undefined && (!Number.isInteger(primitive.material) || !Array.isArray(document.materials) || primitive.material < 0 || primitive.material >= document.materials.length)) fail('GLB material 引用无效。');
      const material = primitive.material === undefined ? null : document.materials[primitive.material];
      if (material !== null && (!material || typeof material !== 'object')) fail('GLB material 数据无效。');
      const baseColor = material?.pbrMetallicRoughness?.baseColorFactor;
      if (baseColor !== undefined && (!Array.isArray(baseColor) || baseColor.length !== 4 || baseColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) fail('GLB 基础颜色因子无效。');
      const factor = document.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor;
      if (Array.isArray(factor) && factor.length >= 3 && factor.slice(0, 3).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        color = factor.slice(0, 3);
      }
      group.push(meshes.length);
      meshes.push({
        name: `${typeof definition.name === 'string' && definition.name ? definition.name : `GLB 网格 ${meshIndex + 1}`}${definition.primitives.length > 1 ? ` · ${primitiveIndex + 1}` : ''}`,
        positions,
        normals,
        indices,
        color
      });
      if (meshes.length > CAD_PREVIEW_MAX_MESHES) fail('GLB primitive 数量超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
    }
    meshGroups.push(group);
  }

  const nodeDefinitions = document.nodes ?? [];
  if (!Array.isArray(nodeDefinitions) || nodeDefinitions.length > 5_000) fail('GLB node 清单无效或超过预览上限。');
  const nodes = nodeDefinitions.map((node, index) => {
    if (!node || (node.mesh !== undefined && (!Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= meshDefinitions.length)) || (node.children !== undefined && (!Array.isArray(node.children) || node.children.some((child) => !Number.isInteger(child) || child < 0 || child >= nodeDefinitions.length))) || node.weights !== undefined) {
      fail(`GLB node ${index} 引用无效。`);
    }
    if (node.matrix !== undefined) {
      if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)) fail(`GLB node ${index} matrix 无效。`);
      if (Math.abs(node.matrix[3]) > 1e-8 || Math.abs(node.matrix[7]) > 1e-8 || Math.abs(node.matrix[11]) > 1e-8 || Math.abs(node.matrix[15] - 1) > 1e-8) fail(`GLB node ${index} matrix 不是有效仿射变换。`);
      if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) fail(`GLB node ${index} 同时含 matrix 与 TRS。`);
    }
    const vector = (value, length, label, fallback) => {
      if (value === undefined) return fallback;
      if (!Array.isArray(value) || value.length !== length || value.some((component) => !Number.isFinite(component) || Math.abs(component) > MAX_COORDINATE)) fail(`GLB node ${index} ${label} 无效。`);
      return value;
    };
    const translation = vector(node.translation, 3, 'translation', [0, 0, 0]);
    const rotation = vector(node.rotation, 4, 'rotation', [0, 0, 0, 1]);
    const scale = vector(node.scale, 3, 'scale', [1, 1, 1]);
    if (Math.hypot(...rotation) < 1e-8) fail(`GLB node ${index} rotation 无效。`);
    return {
      name: typeof node.name === 'string' ? node.name : `节点 ${index + 1}`,
      ...(node.mesh === undefined ? {} : { mesh: node.mesh }),
      children: node.children ?? [],
      ...(node.matrix ? { matrix: node.matrix } : { translation, rotation, scale })
    };
  });

  let parentCounts = new Uint8Array(nodes.length);
  for (const node of nodes) {
    if (node.children.length > 5_000) fail('GLB node 子级数量超过上限。');
    for (const child of node.children) {
      parentCounts[child] += 1;
      if (parentCounts[child] > 1) fail('GLB node 不能由多个父节点共享。');
    }
  }
  const sceneDefinitions = document.scenes ?? [];
  if (!Array.isArray(sceneDefinitions)) fail('GLB scene 清单无效。');
  let sceneRoots = [];
  if (nodes.length > 0) {
    if (sceneDefinitions.length > 0) {
      const selectedScene = document.scene ?? 0;
      const selected = sceneDefinitions[selectedScene];
      if (!selected || !Array.isArray(selected.nodes) || selected.nodes.some((node) => !Number.isInteger(node) || node < 0 || node >= nodes.length || parentCounts[node] !== 0)) fail('GLB 默认 scene 根节点无效。');
      sceneRoots = selected.nodes;
    } else {
      sceneRoots = nodes.map((_node, index) => index).filter((index) => parentCounts[index] === 0);
    }
    const state = new Uint8Array(nodes.length);
    function inspectNode(index, depth = 0) {
      if (depth > 512) fail('GLB node 层级超过预览上限。');
      if (state[index] === 1) fail('GLB node 图存在循环引用。');
      if (state[index] === 2) return;
      state[index] = 1;
      for (const child of nodes[index].children) inspectNode(child, depth + 1);
      state[index] = 2;
    }
    nodes.forEach((_node, index) => inspectNode(index));
    let sceneTriangles = 0;
    let sceneDraws = 0;
    function account(index, depth = 0) {
      if (depth > 512) fail('GLB scene 层级超过预览上限。');
      const node = nodes[index];
      if (node.mesh !== undefined) {
        for (const meshIndex of meshGroups[node.mesh] ?? []) {
          const selectedMesh = meshes[meshIndex];
          if (!selectedMesh) fail('GLB 网格引用无法解析。');
          const count = selectedMesh.indices ? selectedMesh.indices.length / 3 : selectedMesh.positions.length / 9;
          sceneTriangles += count;
          sceneDraws += 1;
          if (sceneTriangles > CAD_PREVIEW_MAX_TRIANGLES || sceneDraws > CAD_PREVIEW_MAX_MESHES) fail('GLB 场景实例化后的复杂度超过预览上限。', 'CAD_PREVIEW_TOO_COMPLEX');
        }
      }
      for (const child of node.children) account(child, depth + 1);
    }
    sceneRoots.forEach(account);
    if (sceneRoots.length === 0 || sceneTriangles === 0) fail('GLB 默认 scene 中没有可显示的三角网格。');
    totalTriangles = sceneTriangles;
  }
  if (nodes.length === 0 && totalTriangles === 0) fail('GLB 中没有可显示的三角网格。');

  return {
    format: 'GLB',
    meshes,
    meshGroups,
    nodes,
    sceneRoots,
    triangleCount: totalTriangles,
    meshCount: nodes.length > 0
      ? nodes.reduce((count, node) => count + (node.mesh === undefined ? 0 : meshDefinitions[node.mesh].primitives.length), 0)
      : meshes.length
  };
}

export function parseCadPreview(input, extension) {
  const bytes = bytesOf(input);
  checkBudget(bytes.byteLength);
  const normalizedExtension = typeof extension === 'string' ? extension.toLowerCase() : '';
  if (!CAD_PREVIEW_EXTENSIONS.includes(normalizedExtension)) fail('Core 只读预览仅支持 STL 与 GLB 文件。', 'CAD_PREVIEW_UNSUPPORTED_EXTENSION');
  if (normalizedExtension === '.stl') return parseStl(bytes);
  return parseGlb(bytes);
}

export class CorePreviewSession {
  #current = null;
  #commit;

  constructor(commit) {
    if (typeof commit !== 'function') throw new TypeError('CorePreviewSession requires a commit callback.');
    this.#commit = commit;
  }

  get current() {
    return this.#current;
  }

  open(input, extension) {
    const candidate = parseCadPreview(input, extension);
    this.#commit(candidate);
    this.#current = candidate;
    return candidate;
  }
}
