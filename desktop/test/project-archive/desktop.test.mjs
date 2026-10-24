import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serializeAnnotation } from '../../src/cad/kinematics-ui.ts';
import { serializeDoc } from '../../src/parametric/model.ts';
import {
  buildPortableProjectArchive,
  parsePortableProjectArchive
} from '../../src/project-archive/archive.ts';
import {
  exportSelectedCadAsPortableArchive,
  previewSelectedPortableArchive,
  writePortableArchiveExclusively
} from '../../src/project-archive/desktop.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const cadPath = '/selected/fixture.step';
const cadBytes = new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x00, 0xff]);
const existingArchivePath = '/selected/existing.acproj';
const fixedDate = new Date('2026-10-24T10:00:00.000Z');
const projectId = 'acproj-00000000-0000-4000-8000-000000000001';

function createIo(overrides = {}) {
  const files = new Map([[cadPath, new Uint8Array(cadBytes)]]);
  const calls = { chooseCad: 0, chooseDestination: 0, chooseArchive: 0, read: 0, write: 0 };
  const io = {
    enabled: true,
    files,
    calls,
    appVersion: '0.3.0',
    now: () => fixedDate,
    createId: () => 'test-archive-id',
    isEnabled: () => io.enabled,
    chooseCadFile: async () => {
      calls.chooseCad += 1;
      return { canceled: false, path: cadPath };
    },
    chooseArchiveDestination: async () => {
      calls.chooseDestination += 1;
      return { canceled: false, path: '/selected/output.acproj' };
    },
    chooseArchiveFile: async () => {
      calls.chooseArchive += 1;
      return { canceled: false, path: existingArchivePath };
    },
    statFile: (path) => {
      const bytes = files.get(path);
      return { isFile: Boolean(bytes), size: bytes?.byteLength ?? 0 };
    },
    readFile: (path) => {
      calls.read += 1;
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing test file: ${path}`);
      return new Uint8Array(bytes);
    },
    writeFileExclusive: (path, bytes) => {
      calls.write += 1;
      if (files.has(path)) {
        const error = new Error('file already exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.set(path, new Uint8Array(bytes));
    },
    ...overrides
  };
  return io;
}

function validArchiveBytes() {
  return buildPortableProjectArchive({
    projectId: 'preview-candidate',
    projectName: '预览候选',
    appVersion: '0.3.0',
    createdAt: '2026-10-24T10:00:00.000Z',
    dependencies: [{ originalName: 'fixture.step', content: cadBytes }]
  }).bytes;
}

function validSnapshot(overrides = {}) {
  return {
    projectId,
    sourceName: 'fixture.step',
    sourceSha256: createHash('sha256').update(cadBytes).digest('hex'),
    sourceSize: cadBytes.byteLength,
    modelObjects: [],
    featureTreeJson: serializeDoc({
      schemaVersion: 2,
      sourceFile: 'fixture.step',
      instances: [{
        id: 'p1',
        name: '支架',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8, centered: true } }]
      }],
      updatedAt: '2026-10-24T10:00:00.000Z'
    }),
    kinematicsJson: serializeAnnotation({ version: 2, projectId, sourceFile: 'fixture.step', parts: [] }),
    viewStateJson: JSON.stringify({
      schemaVersion: 1, position: [700, -700, 600], target: [0, 0, 0], up: [0, 0, 1], fovDeg: 42, wireframe: false
    }),
    excludedState: [],
    ...overrides
  };
}

test('用户选择匹配来源后导出 .acproj，往返保留原始模型与状态候选但不应用当前工程', async () => {
  const io = createIo({
    chooseArchiveDestination: async (suggestedName) => {
      io.calls.chooseDestination += 1;
      assert.equal(suggestedName, 'fixture.acproj');
      return { canceled: false, path: '/selected/output' };
    }
  });
  const currentProject = JSON.stringify({ id: 'still-open', value: 17 });
  const snapshot = validSnapshot();
  const result = await exportSelectedCadAsPortableArchive(io, snapshot);

  assert.equal(result.ok, true);
  assert.equal(result.value.path, '/selected/output.acproj');
  assert.deepEqual(result.value.includedState, { featureTree: true, kinematics: true, viewState: true });
  assert.equal(result.value.dependencyName, 'fixture.step');
  assert.equal(io.calls.read, 1);
  assert.equal(io.calls.write, 1);
  const candidate = parsePortableProjectArchive(io.files.get('/selected/output.acproj'));
  assert.equal(candidate.manifest.project.id, projectId);
  assert.equal(candidate.manifest.state.featureTree.schemaVersion, 2);
  assert.equal(candidate.manifest.state.kinematics.schemaVersion, 2);
  assert.equal(candidate.manifest.state.viewState.schemaVersion, 1);
  assert.equal(candidate.featureTreeJson, snapshot.featureTreeJson);
  assert.equal(candidate.kinematicsJson, snapshot.kinematicsJson);
  assert.equal(candidate.viewStateJson, snapshot.viewStateJson);
  assert.equal(candidate.dependencies.length, 1);
  assert.equal(candidate.dependencies[0].originalName, 'fixture.step');
  assert.deepEqual(candidate.dependencies[0].content, cadBytes);
  assert.equal(currentProject, JSON.stringify({ id: 'still-open', value: 17 }));
});

test('未收录状态原因随档案往返并在只读预览中明确显示', async () => {
  const io = createIo();
  const excludedState = ['feature-tree-module-disabled', 'kinematics-not-loaded'];
  const exported = await exportSelectedCadAsPortableArchive(io, validSnapshot({ excludedState }));
  assert.equal(exported.ok, true);
  const archiveBytes = io.files.get('/selected/output.acproj');
  io.files.set(existingArchivePath, archiveBytes);

  const preview = await previewSelectedPortableArchive(io);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.value.omittedState, excludedState);

  const invalidIo = createIo();
  const invalid = await exportSelectedCadAsPortableArchive(invalidIo, validSnapshot({ excludedState: ['credential-token'] }));
  assert.equal(invalid.ok, false);
  assert.equal(invalidIo.calls.write, 0);
});

test('取消 CAD 选择或目标保存对话框均不写入文件', async () => {
  const cadCanceled = createIo();
  cadCanceled.chooseCadFile = async () => {
    cadCanceled.calls.chooseCad += 1;
    return { canceled: true };
  };
  const first = await exportSelectedCadAsPortableArchive(cadCanceled);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'CANCELED');
  assert.equal(first.stage, 'cad-selection');
  assert.equal(cadCanceled.calls.read, 0);
  assert.equal(cadCanceled.calls.write, 0);
  assert.equal(cadCanceled.calls.chooseDestination, 0);

  const saveCanceled = createIo({
    chooseArchiveDestination: async () => {
      saveCanceled.calls.chooseDestination += 1;
      return { canceled: true };
    }
  });
  const second = await exportSelectedCadAsPortableArchive(saveCanceled, validSnapshot());
  assert.equal(second.ok, false);
  assert.equal(second.code, 'CANCELED');
  assert.equal(second.stage, 'archive-destination');
  assert.equal(saveCanceled.calls.read, 1);
  assert.equal(saveCanceled.calls.write, 0);
});

test('关闭 project.portable 后不触发任何原生对话框、读取或写入', async () => {
  const io = createIo();
  io.enabled = false;
  const exportResult = await exportSelectedCadAsPortableArchive(io);
  const previewResult = await previewSelectedPortableArchive(io);
  for (const result of [exportResult, previewResult]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODULE_DISABLED');
  }
  assert.deepEqual(io.calls, { chooseCad: 0, chooseDestination: 0, chooseArchive: 0, read: 0, write: 0 });
});

test('档案预览严格校验并只返回清单摘要，不返回候选状态/依赖字节或应用到当前工程', async () => {
  const io = createIo();
  io.files.set(existingArchivePath, validArchiveBytes());
  const currentProject = { id: 'current', featureTree: ['unchanged'] };
  const before = structuredClone(currentProject);
  const result = await previewSelectedPortableArchive(io);

  assert.equal(result.ok, true);
  assert.equal(result.value.project.name, '预览候选');
  assert.equal(result.value.restoreMode, 'archive-api-only');
  assert.deepEqual(result.value.state, { featureTree: false, kinematics: false, viewState: false });
  assert.equal(result.value.dependencies.length, 1);
  assert.equal(result.value.dependencies[0].originalName, 'fixture.step');
  assert.equal(Object.hasOwn(result.value.dependencies[0], 'content'), false);
  assert.deepEqual(currentProject, before);
});

test('坏 ZIP、未知 schema 与非 .acproj 文件失败关闭，当前工程不变', async () => {
  const io = createIo();
  const currentProject = { id: 'current', state: { keep: true } };
  const before = structuredClone(currentProject);

  io.files.set(existingArchivePath, new Uint8Array([0, 1, 2, 3]));
  const corrupt = await previewSelectedPortableArchive(io);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'FAILED');
  assert.deepEqual(currentProject, before);

  const unknownVersion = buildPortableProjectArchive({
    projectId: 'old', projectName: '未知版本测试', appVersion: '0.3.0',
    createdAt: '2026-10-24T10:00:00.000Z',
    dependencies: [{ originalName: 'fixture.step', content: cadBytes }]
  });
  const zip = new AdmZip(Buffer.from(unknownVersion.bytes));
  const entry = zip.getEntry('manifest.json');
  const manifest = JSON.parse(entry.getData().toString('utf8'));
  manifest.schemaVersion = 99;
  entry.setData(Buffer.from(JSON.stringify(manifest)));
  io.files.set(existingArchivePath, new Uint8Array(zip.toBuffer()));
  const incompatible = await previewSelectedPortableArchive(io);
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.message, /schema 版本不兼容/);
  assert.deepEqual(currentProject, before);

  const wrongExtension = createIo({ chooseArchiveFile: async () => ({ canceled: false, path: '/selected/archive.zip' }) });
  const wrong = await previewSelectedPortableArchive(wrongExtension);
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /不是 \.acproj/);
  assert.equal(wrongExtension.calls.read, 0);
});

test('保存失败不会覆盖同名档案，也不会修改当前工程', async () => {
  const existingBytes = new Uint8Array([9, 8, 7, 6]);
  const io = createIo({
    chooseArchiveDestination: async () => ({ canceled: false, path: existingArchivePath }),
    writeFileExclusive: (path, bytes) => {
      io.calls.write += 1;
      assert.equal(path, existingArchivePath);
      assert.equal(bytes instanceof Uint8Array, true);
      const error = new Error('file already exists');
      error.code = 'EEXIST';
      throw error;
    }
  });
  io.files.set(existingArchivePath, existingBytes);
  const currentProject = { id: 'current', state: { untouched: true } };
  const before = structuredClone(currentProject);
  const result = await exportSelectedCadAsPortableArchive(io, validSnapshot());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAILED');
  assert.match(result.message, /already exists/);
  assert.deepEqual(io.files.get(existingArchivePath), existingBytes);
  assert.deepEqual(currentProject, before);
});

test('模块在保存对话框期间关闭时，主进程门禁阻止后续写文件', async () => {
  const io = createIo({
    chooseArchiveDestination: async () => {
      io.enabled = false;
      return { canceled: false, path: '/selected/race.acproj' };
    }
  });
  const result = await exportSelectedCadAsPortableArchive(io, validSnapshot());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODULE_DISABLED');
  assert.equal(io.calls.write, 0);
});

test('真实文件系统独占创建不会截断或覆盖已有 .acproj', () => {
  const directory = mkdtempSync(join(tmpdir(), 'automationcad-project-archive-'));
  const target = join(directory, 'existing.acproj');
  const original = Buffer.from([0x41, 0x43, 0x50, 0x52, 0x4f, 0x4a]);
  try {
    writeFileSync(target, original);
    assert.throws(() => writePortableArchiveExclusively(target, new Uint8Array([1, 2, 3])), (error) => error.code === 'EEXIST');
    assert.deepEqual(readFileSync(target), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('导出选择同名但内容不同的 CAD 原件时 SHA-256 不匹配并拒绝写入', async () => {
  const otherPath = '/other/fixture.step';
  const io = createIo({ chooseCadFile: async () => ({ canceled: false, path: otherPath }) });
  io.files.set(otherPath, new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x01, 0x02]));
  const currentProject = { id: projectId, active: true };
  const before = structuredClone(currentProject);
  const result = await exportSelectedCadAsPortableArchive(io, validSnapshot());
  assert.equal(result.ok, false);
  assert.match(result.message, /SHA-256\/大小不匹配/);
  assert.equal(io.calls.write, 0);
  assert.deepEqual(currentProject, before);
});
