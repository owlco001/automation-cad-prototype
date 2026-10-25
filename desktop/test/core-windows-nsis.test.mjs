import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import asar from '@electron/asar';
import { test } from 'node:test';
import {
  CORE_ARTIFACT_FILES,
  CORE_RUNTIME_FILES,
  assertCoreWindowsNsisOutputIsFresh,
  inspectCoreWindowsPackage,
  resolveCoreWindowsNsisOutput,
  validateCoreRuntimeDirectory,
  validateCoreWindowsNsisConfig
} from '../scripts/core-windows-nsis-contract.mjs';

const testDir = new URL('.', import.meta.url);
const configUrl = new URL('../electron-builder.core.nsis.json', testDir);
const config = JSON.parse(await readFile(configUrl, 'utf8'));
const baseFiles = {
  'core-main.cjs': 'const coreMain = true;\n',
  'core-preload.cjs': 'const corePreload = true;\n',
  'core.css': 'body { color: #222; }\n',
  'core.html': '<!doctype html><title>Core</title>\n',
  'core-viewer.js': 'globalThis.CoreCadViewer = {};\n',
  'renderer.js': 'document.body.dataset.ready = "true";\n',
  'THREE-LICENSE.txt': 'Three.js MIT License\n',
  'package.json': `${JSON.stringify({
    name: 'automationcad-core-runtime',
    productName: 'AutomationCAD Core',
    version: '0.3.0',
    type: 'commonjs',
    main: 'core-main.cjs'
  }, null, 2)}\n`
};

async function writeRuntimeFiles(directory, overrides = {}) {
  await mkdir(directory, { recursive: true });
  const files = { ...baseFiles, ...overrides };
  const artifacts = {};
  for (const name of CORE_ARTIFACT_FILES) {
    const content = Buffer.from(files[name]);
    artifacts[name] = {
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex')
    };
  }
  files['profile.json'] = `${JSON.stringify({
    format: 'automationcad-core-runtime-profile',
    schemaVersion: 1,
    profile: 'core-only',
    runtime: 'separate-electron-shell',
    entry: 'core-main.cjs',
    preload: 'core-preload.cjs',
    page: 'core.html',
    renderer: 'renderer.js',
    exposedBridgeMethods: ['status', 'openCadPreview', 'listProjectCadPreviews', 'addProjectCadPreview', 'openProjectCadPreview'],
    cadPreview: { formats: ['.stl', '.glb'], maxBytes: 33_554_432, maxTriangles: 500_000, maxVertices: 1_000_000, mode: 'read-only', glb: 'static-untextured-triangle-mesh-subset' },
    projectAttachments: { schemaVersion: 1, formats: ['.stl', '.glb'], maxBytes: 33_554_432, storage: 'sha256-immutable', mode: 'read-only' },
    optionalRuntime: 'not-present',
    installable: false,
    authenticity: 'unsigned-build-artifact',
    offlineCapability: 'project-store-local-only',
    workspaceCapability: 'local-project-store-v1',
    artifacts
  }, null, 2)}\n`;
  for (const name of CORE_RUNTIME_FILES) await writeFile(join(directory, name), files[name]);
  return files;
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'core-windows-nsis-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Core Windows NSIS 配置只允许九个独立运行时文件且不签名、不发布', () => {
  assert.deepEqual([...CORE_RUNTIME_FILES], [
    'THREE-LICENSE.txt', 'core-main.cjs', 'core-preload.cjs', 'core-viewer.js',
    'core.css', 'core.html', 'package.json', 'profile.json', 'renderer.js'
  ]);
  assert.equal(validateCoreWindowsNsisConfig(config), true);
  assert.equal(config.win.target[0].target, 'nsis');
  assert.deepEqual(config.win.target[0].arch, ['x64']);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.differentialPackage, false);
  for (const unsafe of [
    { ...config, extraResources: [{ from: '../packs/builtin', to: 'packs/builtin' }] },
    { ...config, publish: { provider: 'github' } },
    { ...config, files: [...config.files, 'web/**/*'] },
    { ...config, win: { ...config.win, signAndEditExecutable: true } },
    { ...config, nsis: { ...config.nsis, differentialPackage: true } }
  ]) assert.throws(() => validateCoreWindowsNsisConfig(unsafe), /独立 Core 白名单/);
});

test('Core Windows 输出只能位于 release 下，且拒绝覆盖任何已有路径', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(join(root, 'release'));
    assert.equal(resolveCoreWindowsNsisOutput(root), join(root, 'release', 'core-runtime-windows-nsis'));
    assert.throws(() => resolveCoreWindowsNsisOutput(root, 'release'), /一级子目录/);
    assert.throws(() => resolveCoreWindowsNsisOutput(root, 'release/../outside'), /一级子目录/);
    const existing = join(root, 'release', 'already-there');
    await mkdir(existing);
    assert.throws(() => assertCoreWindowsNsisOutputIsFresh(existing), /拒绝覆盖/);
    assert.doesNotThrow(() => assertCoreWindowsNsisOutputIsFresh(join(root, 'release', 'new-output')));
  });
});

test('dist-core 必须是精确清单、Core profile 与逐文件摘要一致', async () => {
  await withTempDirectory(async (root) => {
    const runtimeDir = join(root, 'dist-core');
    await writeRuntimeFiles(runtimeDir);
    assert.equal(validateCoreRuntimeDirectory(runtimeDir).profile.installable, false);
    await writeFile(join(runtimeDir, 'optional-module.js'), 'not allowed');
    assert.throws(() => validateCoreRuntimeDirectory(runtimeDir), /文件清单不匹配/);
    await rm(join(runtimeDir, 'optional-module.js'));
    const profile = JSON.parse(await readFile(join(runtimeDir, 'profile.json'), 'utf8'));
    profile.installable = true;
    await writeFile(join(runtimeDir, 'profile.json'), `${JSON.stringify(profile)}\n`);
    assert.throws(() => validateCoreRuntimeDirectory(runtimeDir), /边界声明不匹配/);
  });
});

test('Windows app.asar 实检只接受 Core 文件与 profile 内容，不接受完整版或可选代码', async () => {
  await withTempDirectory(async (root) => {
    const appDir = join(root, 'win-unpacked');
    const resourcesDir = join(appDir, 'resources');
    const sourceDir = join(root, 'asar-source');
    await mkdir(resourcesDir, { recursive: true });
    await writeRuntimeFiles(sourceDir);
    const archivePath = join(resourcesDir, 'app.asar');
    const archiveStream = await asar.createPackage(sourceDir, archivePath);
    await finished(archiveStream);
    const installerPath = join(root, 'AutomationCAD-Core-Setup-0.3.0.exe');
    await writeFile(installerPath, Buffer.from('test installer placeholder'));
    const inspected = inspectCoreWindowsPackage({ appDir, installerPath });
    assert.equal(inspected.appFiles, CORE_RUNTIME_FILES.length);
    assert.equal(inspected.appVersion, '0.3.0');
    assert.ok(inspected.appAsarBytes > 0);
    assert.ok(inspected.installerBytes > 0);

    const badAppDir = join(root, 'bad-win-unpacked');
    const badResourcesDir = join(badAppDir, 'resources');
    const extraSource = join(root, 'bad-asar-source');
    const extraFiles = await writeRuntimeFiles(extraSource, { 'core-main.cjs': 'const optional = "plcgen";\n' });
    await mkdir(badResourcesDir, { recursive: true });
    await writeFile(join(extraSource, 'unused.txt'), 'extra');
    const badArchive = join(badResourcesDir, 'app.asar');
    const badStream = await asar.createPackage(extraSource, badArchive);
    await finished(badStream);
    assert.ok(asar.listPackage(badArchive, { isPack: false }).some((name) => name.endsWith('/unused.txt')));
    assert.equal(JSON.parse(asar.extractFile(badArchive, 'package.json').toString('utf8')).name, 'automationcad-core-runtime');
    assert.throws(() => inspectCoreWindowsPackage({ appDir: badAppDir, installerPath }), /文件清单不匹配/);

    const forbiddenAppDir = join(root, 'forbidden-win-unpacked');
    const forbiddenResourcesDir = join(forbiddenAppDir, 'resources');
    await mkdir(forbiddenResourcesDir, { recursive: true });
    const forbiddenSource = join(root, 'forbidden-asar-source');
    await writeRuntimeFiles(forbiddenSource, { 'core-main.cjs': extraFiles['core-main.cjs'] });
    const forbiddenArchive = join(forbiddenResourcesDir, 'app.asar');
    const forbiddenStream = await asar.createPackage(forbiddenSource, forbiddenArchive);
    await finished(forbiddenStream);
    assert.throws(() => inspectCoreWindowsPackage({ appDir: forbiddenAppDir, installerPath }), /可选模块\/API 标记/);
  });
});
