import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CAD_PREVIEW_MAX_BYTES,
  CAD_PREVIEW_MAX_TRIANGLES,
  CorePreviewSession,
  parseCadPreview
} from '../electron/core/cad-preview-format.mjs';
import { readCadPreviewFile, validateCadPreviewExtension } from '../electron/core/cad-preview-files.mjs';

function makeBinaryStl(triangleCount = 1, { nan = false } = {}) {
  const buffer = Buffer.alloc(84 + triangleCount * 50);
  buffer.write('Core synthetic STL', 0, 'ascii');
  buffer.writeUInt32LE(triangleCount, 80);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const record = 84 + triangle * 50;
    const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = nan && triangle === 0 && vertex === 0 && axis === 0 ? Number.NaN : vertices[vertex][axis];
        buffer.writeFloatLE(value, record + 12 + vertex * 12 + axis * 4);
      }
    }
  }
  return buffer;
}

function makeGlb({ document: overrides = {}, binary = null } = {}) {
  const meshBinary = binary ?? Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const document = {
    asset: { version: '2.0', generator: 'synthetic Core fixture' },
    buffers: [{ byteLength: meshBinary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ name: 'fixture triangle', primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...overrides
  };
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binaryPadding = (4 - (meshBinary.length % 4)) % 4;
  const binaryChunk = Buffer.concat([meshBinary, Buffer.alloc(binaryPadding)]);
  const includeBinary = document.buffers?.length > 0;
  const totalLength = 12 + 8 + jsonChunk.length + (includeBinary ? 8 + binaryChunk.length : 0);
  const glb = Buffer.alloc(totalLength);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  let offset = 12;
  glb.writeUInt32LE(jsonChunk.length, offset);
  glb.writeUInt32LE(0x4e4f534a, offset + 4);
  jsonChunk.copy(glb, offset + 8);
  offset += 8 + jsonChunk.length;
  if (includeBinary) {
    glb.writeUInt32LE(binaryChunk.length, offset);
    glb.writeUInt32LE(0x004e4942, offset + 4);
    binaryChunk.copy(glb, offset + 8);
  }
  return glb;
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'core-cad-preview-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('binary and ASCII STL are parsed into bounded one-mesh preview data', () => {
  const binary = parseCadPreview(makeBinaryStl(), '.stl');
  assert.equal(binary.format, 'STL');
  assert.equal(binary.triangleCount, 1);
  assert.equal(binary.meshCount, 1);
  assert.deepEqual([...binary.meshes[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);

  const ascii = Buffer.from('solid fixture\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid fixture\n');
  assert.equal(parseCadPreview(ascii, '.stl').triangleCount, 1);
});

test('static embedded GLB triangle subset preserves primitive grouping and scene node mapping', () => {
  const model = parseCadPreview(makeGlb(), '.glb');
  assert.equal(model.format, 'GLB');
  assert.equal(model.triangleCount, 1);
  assert.equal(model.meshCount, 1);
  assert.deepEqual(model.meshGroups, [[0]]);
  assert.deepEqual(model.sceneRoots, [0]);
  assert.equal(model.nodes[0].mesh, 0);
});

test('extensions outside STL and GLB are rejected case-insensitively before parsing', () => {
  for (const extension of ['.step', '.stp', '.obj', '.gltf', '.3mf', '.zip', '.exe']) {
    assert.throws(() => parseCadPreview(makeBinaryStl(), extension), { code: 'CAD_PREVIEW_UNSUPPORTED_EXTENSION' });
  }
  assert.equal(validateCadPreviewExtension('/tmp/part.STL'), '.stl');
  for (const filename of ['/tmp/part.step', '/tmp/part.stp', '/tmp/part.obj', '/tmp/part.gltf']) {
    assert.throws(() => validateCadPreviewExtension(filename), { code: 'CAD_PREVIEW_UNSUPPORTED_EXTENSION' });
  }
});

test('STL parser rejects malformed, non-finite and over-triangle-cap input', () => {
  assert.throws(() => parseCadPreview(Buffer.alloc(8), '.stl'), /STL/);
  assert.throws(() => parseCadPreview(makeBinaryStl(1, { nan: true }), '.stl'), /坐标无效/);
  const overLimit = makeBinaryStl(CAD_PREVIEW_MAX_TRIANGLES + 1);
  assert.throws(() => parseCadPreview(overLimit, '.stl'), { code: 'CAD_PREVIEW_TOO_COMPLEX' });
});

test('GLB rejects bad headers, external buffers, bad accessors, node cycles and unsupported content', () => {
  assert.throws(() => parseCadPreview(Buffer.from('not-a-glb'), '.glb'), /GLB/);
  const externalBuffer = makeGlb({ document: { buffers: [{ uri: 'part.bin', byteLength: 36 }] } });
  assert.throws(() => parseCadPreview(externalBuffer, '.glb'), /内嵌/);
  const badAccessor = makeGlb({ document: { accessors: [{ bufferView: 0, byteOffset: 64, componentType: 5126, count: 3, type: 'VEC3' }] } });
  assert.throws(() => parseCadPreview(badAccessor, '.glb'), /越界/);
  const unsupportedExtension = makeGlb({ document: { extensionsUsed: ['KHR_draco_mesh_compression'] } });
  assert.throws(() => parseCadPreview(unsupportedExtension, '.glb'), /无扩展/);
  const textured = makeGlb({ document: { images: [{ bufferView: 0, mimeType: 'image/png' }] } });
  assert.throws(() => parseCadPreview(textured, '.glb'), /图片或纹理/);
  const animated = makeGlb({ document: { animations: [{ channels: [] }] } });
  assert.throws(() => parseCadPreview(animated, '.glb'), /无扩展/);
  const cyclicNodes = makeGlb({ document: { nodes: [{ mesh: 0, children: [1] }, { children: [0] }], scenes: [] } });
  assert.throws(() => parseCadPreview(cyclicNodes, '.glb'), /循环引用/);
});

test('GLB over-size, sparse accessors and malformed indices fail before display', () => {
  assert.throws(() => parseCadPreview(new Uint8Array(CAD_PREVIEW_MAX_BYTES + 1), '.glb'), { code: 'CAD_PREVIEW_TOO_LARGE' });
  const sparse = makeGlb({ document: { accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1 } }] } });
  assert.throws(() => parseCadPreview(sparse, '.glb'), /稀疏数据/);

  const binary = Buffer.alloc(44);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(binary, 0);
  binary.writeUInt16LE(0, 36);
  binary.writeUInt16LE(1, 38);
  binary.writeUInt16LE(3, 40);
  const badIndices = makeGlb({
    binary,
    document: {
      buffers: [{ byteLength: 42 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }]
    }
  });
  assert.throws(() => parseCadPreview(badIndices, '.glb'), /索引数组/);
});

test('failed parse does not commit or replace the previous in-memory preview model', () => {
  let commits = 0;
  const session = new CorePreviewSession(() => { commits += 1; });
  const original = session.open(makeBinaryStl(), '.stl');
  assert.equal(session.current, original);
  assert.throws(() => session.open(Buffer.from('broken'), '.glb'));
  assert.equal(session.current, original);
  assert.equal(commits, 1);
});

test('native file helper accepts the exact byte ceiling and rejects over-limit, empty, non-file and unsupported paths', async () => {
  await withTempDirectory(async (directory) => {
    const exactPath = join(directory, 'exact.glb');
    const exact = await open(exactPath, 'w');
    await exact.truncate(CAD_PREVIEW_MAX_BYTES);
    await exact.close();
    const loaded = await readCadPreviewFile(exactPath);
    assert.equal(loaded.cancelled, false);
    assert.equal(loaded.byteLength, CAD_PREVIEW_MAX_BYTES);
    assert.equal(loaded.extension, '.glb');

    const tooLargePath = join(directory, 'large.stl');
    const tooLarge = await open(tooLargePath, 'w');
    await tooLarge.truncate(CAD_PREVIEW_MAX_BYTES + 1);
    await tooLarge.close();
    await assert.rejects(readCadPreviewFile(tooLargePath), { code: 'CAD_PREVIEW_TOO_LARGE' });

    const emptyPath = join(directory, 'empty.stl');
    await writeFile(emptyPath, '');
    await assert.rejects(readCadPreviewFile(emptyPath), { code: 'CAD_PREVIEW_EMPTY_FILE' });
    await assert.rejects(readCadPreviewFile(join(directory, 'part.stp')), { code: 'CAD_PREVIEW_UNSUPPORTED_EXTENSION' });

    const directoryPath = join(directory, 'folder.stl');
    await mkdir(directoryPath);
    await assert.rejects(readCadPreviewFile(directoryPath), { code: 'CAD_PREVIEW_NOT_REGULAR_FILE' });
  });
});

test('native file helper refuses symlinked CAD paths', async (t) => {
  await withTempDirectory(async (directory) => {
    const source = join(directory, 'source.stl');
    const link = join(directory, 'linked.stl');
    await writeFile(source, makeBinaryStl());
    try {
      await symlink(source, link);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('当前运行环境不允许创建符号链接');
      throw error;
    }
    await assert.rejects(readCadPreviewFile(link), { code: 'CAD_PREVIEW_NOT_REGULAR_FILE' });
  });
});
