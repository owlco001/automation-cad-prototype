import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  buildPortableProjectArchive,
  parsePortableProjectArchive,
  PORTABLE_PROJECT_ENTRIES,
  PORTABLE_PROJECT_LIMITS
} from '../../src/project-archive/archive.ts';
import { serializeAnnotation } from '../../src/cad/kinematics-ui.ts';
import { serializeDoc } from '../../src/parametric/model.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const featureTreeJson = serializeDoc({
  schemaVersion: 2,
  sourceFile: 'fixture.step',
  instances: [{
    id: 'p1',
    name: '支架',
    transform: { x: 1, y: 2, z: 3, rz: 10 },
    features: [{ id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8, centered: true } }]
  }],
  updatedAt: '2026-10-24T10:00:00.000Z'
});

const kinematicsJson = serializeAnnotation({
  version: 1,
  sourceFile: 'fixture.step',
  parts: [{
    id: 'mp-fixture',
    name: '滑台',
    meshIds: [0],
    meshNames: ['Slide'],
    center: [0, 0, 0],
    size: [10, 20, 30],
    kind: 'linear',
    axis: 'x',
    direction: 1,
    travelMm: 50,
    retractedMm: 0,
    rangeDeg: 0,
    retractedDeg: 0,
    point: 'Y0',
    role: 'extend'
  }]
});

const viewStateJson = JSON.stringify({
  schemaVersion: 1,
  position: [700, -700, 600],
  target: [0, 0, 0],
  up: [0, 0, 1],
  fovDeg: 42,
  wireframe: false
});

function sources(overrides = {}) {
  return {
    projectId: 'fixture-assembly',
    projectName: '滑台装配体',
    appVersion: '0.3.0',
    createdAt: '2026-10-24T10:00:00.000Z',
    featureTreeJson,
    kinematicsJson,
    viewStateJson,
    dependencies: [{ originalName: 'fixture.step', content: new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x00, 0xff]) }],
    ...overrides
  };
}

function rewrittenManifest(archiveBytes, mutate) {
  const zip = new AdmZip(Buffer.from(archiveBytes));
  const entry = zip.getEntry(PORTABLE_PROJECT_ENTRIES.manifest);
  assert.ok(entry);
  const manifest = JSON.parse(entry.getData().toString('utf8'));
  mutate(manifest);
  entry.setData(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return new Uint8Array(zip.toBuffer());
}

function replaceEvery(bytes, from, to) {
  const source = Buffer.from(bytes);
  const oldValue = Buffer.from(from, 'utf8');
  const newValue = Buffer.from(to, 'utf8');
  assert.equal(oldValue.length, newValue.length, 'ZIP name patch must preserve byte length');
  let cursor = 0;
  let replacements = 0;
  while (true) {
    const index = source.indexOf(oldValue, cursor);
    if (index < 0) break;
    newValue.copy(source, index);
    cursor = index + newValue.length;
    replacements += 1;
  }
  assert.equal(replacements, 2, 'expected local header and central directory names');
  return new Uint8Array(source);
}

function patchCentralUncompressedSizes(bytes, sizesByPath) {
  const source = Buffer.from(bytes);
  const eocd = source.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  const entryCount = source.readUInt16LE(eocd + 10);
  let cursor = source.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(source.readUInt32LE(cursor), 0x02014b50);
    const nameLength = source.readUInt16LE(cursor + 28);
    const extraLength = source.readUInt16LE(cursor + 30);
    const commentLength = source.readUInt16LE(cursor + 32);
    const name = source.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (sizesByPath.has(name)) source.writeUInt32LE(sizesByPath.get(name), cursor + 24);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, eocd);
  return new Uint8Array(source);
}

test('工程档案 round-trip 保留特征树、运动学 JSON、视角 JSON 与 CAD 原始字节', () => {
  const built = buildPortableProjectArchive(sources());
  const restored = parsePortableProjectArchive(built.bytes);

  assert.equal(restored.manifest.archiveType, 'automationcad.portable-project');
  assert.equal(restored.manifest.schemaVersion, 2);
  assert.equal(restored.manifest.coreSchemaVersion, 1);
  assert.equal(restored.manifest.project.id, 'fixture-assembly');
  assert.equal(restored.manifest.project.identity.sourceName, 'fixture.step');
  assert.equal(restored.manifest.project.identity.sourceSize, 6);
  assert.equal(restored.manifest.project.identity.modelObjects.length, 0);
  assert.equal(restored.manifest.state.featureTree.schemaVersion, 2);
  assert.equal(restored.manifest.state.kinematics.schemaVersion, 1);
  assert.equal(restored.manifest.state.viewState.schemaVersion, 1);
  assert.deepEqual(restored.manifest.state.omitted, []);
  assert.deepEqual(restored.manifest.unsupported, [
    'renderer-state-apply',
    'kinematics-cad-reimport-verification',
    'plc-factory-agent-and-enclosure-module-state',
    'parametric-generated-mesh-cache'
  ]);
  assert.equal(restored.featureTreeJson, featureTreeJson);
  assert.equal(restored.kinematicsJson, kinematicsJson);
  assert.equal(restored.viewStateJson, viewStateJson);
  assert.equal(restored.dependencies.length, 1);
  assert.equal(restored.dependencies[0].originalName, 'fixture.step');
  assert.equal(restored.dependencies[0].format, 'step');
  assert.deepEqual(restored.dependencies[0].content, new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x00, 0xff]));
});

test('仅有 CAD 原始依赖时允许打包，并按固定路径收录', () => {
  const built = buildPortableProjectArchive(sources({
    featureTreeJson: undefined,
    kinematicsJson: undefined,
    viewStateJson: undefined
  }));
  const parsed = parsePortableProjectArchive(built.bytes);
  assert.equal(parsed.manifest.state.featureTree, null);
  assert.equal(parsed.manifest.state.kinematics, null);
  assert.equal(parsed.manifest.state.viewState, null);
  assert.deepEqual(parsed.manifest.state.omitted, []);
  assert.equal(parsed.dependencies.length, 1);
});

test('档案 manifest 持久记录未收录原因码并拒绝未知原因码', () => {
  const built = buildPortableProjectArchive(sources({ excludedState: ['feature-tree-module-disabled'] }));
  const parsed = parsePortableProjectArchive(built.bytes);
  assert.deepEqual(parsed.manifest.state.omitted, ['feature-tree-module-disabled']);

  const bad = rewrittenManifest(built.bytes, (manifest) => {
    manifest.state.omitted = ['credential-exported'];
  });
  assert.throws(() => parsePortableProjectArchive(bad), /excludedState/);
});

test('旧版 FeatureDoc v1 可保留并往返，状态 schema 与 manifest 一致', () => {
  const legacyJson = JSON.stringify({
    schemaVersion: 1,
    sourceFile: 'legacy.step',
    features: [{ id: 'f1', type: 'box', name: '底板', params: { length: 100, width: 60, height: 8 } }],
    updatedAt: '2025-01-02T03:04:05.000Z'
  });
  const built = buildPortableProjectArchive(sources({
    featureTreeJson: legacyJson,
    kinematicsJson: undefined,
    viewStateJson: undefined,
    dependencies: [{ originalName: 'legacy.step', content: new Uint8Array([1, 2, 3]) }]
  }));
  const parsed = parsePortableProjectArchive(built.bytes);
  assert.equal(parsed.manifest.state.featureTree.schemaVersion, 1);
  assert.equal(parsed.featureTreeJson, legacyJson);
});

test('旧工程档案 schema v1 仍可严格解析为无稳定身份的只读候选', () => {
  const bytes = buildPortableProjectArchive(sources({ kinematicsJson: undefined, viewStateJson: undefined })).bytes;
  const legacyBytes = rewrittenManifest(bytes, (manifest) => {
    manifest.schemaVersion = 1;
    delete manifest.project.identity;
    delete manifest.state.omitted;
    manifest.unsupported = [
      'kinematics-mesh-index-remap',
      'renderer-state-apply',
      'plc-factory-agent-and-enclosure-module-state',
      'parametric-generated-mesh-cache'
    ];
  });
  const parsed = parsePortableProjectArchive(legacyBytes);
  assert.equal(parsed.manifest.schemaVersion, 1);
  assert.equal(parsed.manifest.project.identity, undefined);
  assert.equal(parsed.featureTreeJson, featureTreeJson);
});

test('无任何状态或依赖、未知 CAD 格式和多文件 OBJ/GLTF 均失败关闭', () => {
  assert.throws(() => buildPortableProjectArchive(sources({
    featureTreeJson: undefined,
    kinematicsJson: undefined,
    viewStateJson: undefined,
    dependencies: []
  })), /必须包含原始 CAD 源依赖/);
  assert.throws(() => buildPortableProjectArchive(sources({ dependencies: [{ originalName: 'model.unknown', content: new Uint8Array([1]) }] })), /不支持的 CAD 依赖格式/);
  assert.throws(() => buildPortableProjectArchive(sources({ dependencies: [{ originalName: 'assembly.obj', content: new Uint8Array([1]) }] })), /不支持的 CAD 依赖格式/);
  assert.throws(() => buildPortableProjectArchive(sources({ dependencies: [{ originalName: 'scene.gltf', content: new Uint8Array([1]) }] })), /不支持的 CAD 依赖格式/);
  assert.throws(() => buildPortableProjectArchive(sources({ dependencies: [] })), /引用的 CAD 依赖缺失/);
});

test('畸形 state、未知视角字段及不兼容状态 schema 在打包前拒绝', () => {
  assert.throws(() => buildPortableProjectArchive(sources({ featureTreeJson: '{"schemaVersion":99}' })), /schema 版本不兼容|结构无效|未知字段/);
  assert.throws(() => buildPortableProjectArchive(sources({ kinematicsJson: '{"version":9,"sourceFile":"x","parts":[]}' })), /版本不兼容|结构无效/);
  assert.throws(() => buildPortableProjectArchive(sources({ viewStateJson: JSON.stringify({ schemaVersion: 2 }) })), /含有未知字段或缺少字段/);
});

test('档案白名单拒绝未知凭据字段和本机文件路径', () => {
  const secretFeature = JSON.parse(featureTreeJson);
  secretFeature.apiKey = 'do-not-export';
  assert.throws(() => buildPortableProjectArchive(sources({ featureTreeJson: JSON.stringify(secretFeature) })), /特征树含有未知字段/);

  const secretParams = JSON.parse(featureTreeJson);
  secretParams.instances[0].features[0].params.password = 'do-not-export';
  assert.throws(() => buildPortableProjectArchive(sources({ featureTreeJson: JSON.stringify(secretParams) })), /未知参数/);

  const secretKinematics = JSON.parse(kinematicsJson);
  secretKinematics.credentials = { token: 'do-not-export' };
  assert.throws(() => buildPortableProjectArchive(sources({ kinematicsJson: JSON.stringify(secretKinematics) })), /运动学标注含有未知字段/);

  const localPathFeature = JSON.parse(featureTreeJson);
  localPathFeature.sourceFile = '/Users/example/private/fixture.step';
  assert.throws(() => buildPortableProjectArchive(sources({ featureTreeJson: JSON.stringify(localPathFeature) })), /纯文件名/);
});

test('ZIP 原始中央目录中的 traversal 路径在 AdmZip 规范化前被拒绝', () => {
  const built = buildPortableProjectArchive(sources({
    featureTreeJson: undefined,
    kinematicsJson: undefined,
    viewStateJson: undefined,
    dependencies: [{ originalName: 'xx.stp', content: new Uint8Array([1, 2, 3]) }]
  }));
  const malicious = replaceEvery(built.bytes, '0001-xx.stp', '../xxyy.stp');
  assert.throws(() => parsePortableProjectArchive(malicious), /路径不是规范格式|路径不合法/);
});

test('重复 ZIP entry（即使 ZIP 库会覆盖同名 entry）被拒绝', () => {
  const built = buildPortableProjectArchive(sources({
    featureTreeJson: undefined,
    kinematicsJson: undefined,
    viewStateJson: undefined,
    dependencies: [
      { originalName: 'one.stp', content: new Uint8Array([1]) },
      { originalName: 'two.stp', content: new Uint8Array([2]) }
    ]
  }));
  const malicious = replaceEvery(built.bytes, '0002-two.stp', '0001-one.stp');
  assert.throws(() => parsePortableProjectArchive(malicious), /重复|条目数与原始中央目录/);
});

test('缺失依赖、未声明额外文件和哈希损坏均拒绝导入', () => {
  const built = buildPortableProjectArchive(sources());
  const dependencyPath = built.manifest.dependencies[0].path;

  const missing = new AdmZip(Buffer.from(built.bytes));
  missing.deleteFile(dependencyPath);
  assert.throws(() => parsePortableProjectArchive(new Uint8Array(missing.toBuffer())), /未声明条目|缺失依赖文件/);

  const unlistedDependency = new AdmZip(Buffer.from(built.bytes));
  unlistedDependency.deleteFile(dependencyPath);
  const unlistedManifest = unlistedDependency.getEntry(PORTABLE_PROJECT_ENTRIES.manifest);
  const unlistedValue = JSON.parse(unlistedManifest.getData().toString('utf8'));
  unlistedValue.dependencies = [];
  unlistedManifest.setData(Buffer.from(JSON.stringify(unlistedValue), 'utf8'));
  assert.throws(() => parsePortableProjectArchive(new Uint8Array(unlistedDependency.toBuffer())), /project\.identity.*依赖/);

  const extra = new AdmZip(Buffer.from(built.bytes));
  extra.addFile('unexpected.bin', Buffer.from([9]));
  assert.throws(() => parsePortableProjectArchive(new Uint8Array(extra.toBuffer())), /未声明条目/);

  const corrupt = new AdmZip(Buffer.from(built.bytes));
  corrupt.getEntry(dependencyPath).setData(Buffer.from('tampered'));
  assert.throws(() => parsePortableProjectArchive(new Uint8Array(corrupt.toBuffer())), /大小不匹配|SHA-256 校验失败/);
});

test('未知 archive type、未知 archive/core schema 和未声明模块状态均失败关闭', () => {
  const built = buildPortableProjectArchive(sources());
  assert.throws(() => parsePortableProjectArchive(rewrittenManifest(built.bytes, (manifest) => { manifest.archiveType = 'unknown.format'; })), /未知工程档案格式/);
  assert.throws(() => parsePortableProjectArchive(rewrittenManifest(built.bytes, (manifest) => { manifest.schemaVersion = 0; })), /schema 版本不兼容/);
  assert.throws(() => parsePortableProjectArchive(rewrittenManifest(built.bytes, (manifest) => { manifest.schemaVersion = 99; })), /schema 版本不兼容/);
  assert.throws(() => parsePortableProjectArchive(rewrittenManifest(built.bytes, (manifest) => { manifest.coreSchemaVersion = 99; })), /schema 版本不兼容/);
  assert.throws(() => parsePortableProjectArchive(rewrittenManifest(built.bytes, (manifest) => { manifest.unsupported.push('new-module'); })), /unsupported 能力声明不兼容/);
});

test('压缩包、单条目和解压总大小上限均在解压前检查', () => {
  const built = buildPortableProjectArchive(sources());
  const tooLargeArchive = new Uint8Array(PORTABLE_PROJECT_LIMITS.maxArchiveBytes + 1);
  assert.throws(() => parsePortableProjectArchive(tooLargeArchive), /压缩文件大小上限/);

  const dependencyPath = built.manifest.dependencies[0].path;
  const tooLargeEntry = patchCentralUncompressedSizes(built.bytes, new Map([
    [dependencyPath, PORTABLE_PROJECT_LIMITS.maxDependencyBytes + 1]
  ]));
  assert.throws(() => parsePortableProjectArchive(tooLargeEntry), /单文件上限/);

  const perState = 80 * 1024 * 1024;
  const tooLargeTotal = patchCentralUncompressedSizes(built.bytes, new Map([
    [PORTABLE_PROJECT_ENTRIES.featureTree, perState],
    [PORTABLE_PROJECT_ENTRIES.kinematics, perState],
    [PORTABLE_PROJECT_ENTRIES.viewState, perState]
  ]));
  assert.throws(() => parsePortableProjectArchive(tooLargeTotal), /解压后总大小超过上限/);
});

test('档案解析只返回候选数据，未知或损坏 ZIP 不生成或覆盖当前工程', () => {
  const built = buildPortableProjectArchive(sources());
  const before = parsePortableProjectArchive(built.bytes);
  assert.throws(() => parsePortableProjectArchive(new Uint8Array([0, 1, 2, 3, 4])), /未知工程档案格式|ZIP/);
  const after = parsePortableProjectArchive(built.bytes);
  assert.deepEqual(after, before);
  assert.equal(after.manifest.restoreMode, 'archive-api-only');
});

test('schema v2 校验稳定 CAD 对象映射与运动学引用，拒绝伪造或缺失对象', () => {
  const projectId = 'acproj-00000000-0000-4000-8000-000000000001';
  const cad = new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x00, 0xff]);
  const sourceSha256 = createHash('sha256').update(cad).digest('hex');
  const geometrySha256 = createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex');
  const name = 'Slide';
  const path = ['Assembly'];
  const objectId = `cadobj-${createHash('sha256').update(JSON.stringify({ projectId, sourceSha256, name, path, geometrySha256 })).digest('hex')}`;
  const identity = {
    sourceName: 'fixture.step', sourceSha256, sourceSize: cad.byteLength,
    modelObjects: [{ objectId, name, path, geometrySha256 }]
  };
  const annotation = serializeAnnotation({
    version: 2,
    projectId,
    sourceFile: 'fixture.step',
    parts: [{
      id: 'mp-fixture', name: '滑台', meshIds: [0], meshNames: [name], meshObjectIds: [objectId],
      center: [0, 0, 0], size: [10, 20, 30], kind: 'linear', axis: 'x', direction: 1,
      travelMm: 50, retractedMm: 0, rangeDeg: 0, retractedDeg: 0, point: 'Y0', role: 'extend'
    }]
  });
  const makeSources = (identityValue, annotationValue) => sources({
    projectId,
    identity: identityValue,
    kinematicsJson: annotationValue,
    featureTreeJson: undefined,
    viewStateJson: undefined,
    dependencies: [{ originalName: 'fixture.step', content: cad }]
  });
  const parsed = parsePortableProjectArchive(buildPortableProjectArchive(makeSources(identity, annotation)).bytes);
  assert.equal(parsed.manifest.project.identity.modelObjects[0].objectId, objectId);
  assert.equal(parsed.kinematicsJson, annotation);

  assert.throws(() => buildPortableProjectArchive(makeSources({
    ...identity, modelObjects: [{ ...identity.modelObjects[0], objectId: `cadobj-${'f'.repeat(64)}` }]
  }, annotation)), /objectId 与其 identity 字段不一致/);
  const missingObjectAnnotation = annotation.replace(objectId, `cadobj-${'e'.repeat(64)}`);
  assert.throws(() => buildPortableProjectArchive(makeSources(identity, missingObjectAnnotation)), /引用了缺失或歧义的 CAD 对象/);
});
