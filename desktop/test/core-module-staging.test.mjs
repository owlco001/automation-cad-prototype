import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ModuleStagingService } from '../electron/core/module-staging.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, rawValue] of entries) {
    const filename = Buffer.from(name, 'utf8');
    const data = Buffer.from(rawValue);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, filename, data]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([central, filename]));
    localOffset += localEntry.length;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBytes, end]);
}
function buildPackage(overrides = {}) {
  const moduleBytes = Buffer.from('export const inertModule = true;\n', 'utf8');
  const manifest = {
    format: 'automationcad.module-artifact',
    schemaVersion: 1,
    module: {
      id: overrides.id ?? 'plcgen',
      version: overrides.version ?? '1.0.0',
      apiCompatibility: { min: 1, max: 1 },
      dependencies: overrides.dependencies ?? [],
      requiredCapabilities: overrides.requiredCapabilities ?? []
    },
    coreApiVersion: 1,
    entry: 'module.mjs',
    files: [{ path: 'module.mjs', size: moduleBytes.length, sha256: sha256(moduleBytes) }],
    authenticity: 'unsigned',
    activation: 'blocked-until-trust-policy'
  };
  if (overrides.invalidModuleHash) manifest.files[0].sha256 = '0'.repeat(64);
  return zipStore([
    ['module.json', Buffer.from(JSON.stringify(manifest), 'utf8')],
    ['module.mjs', moduleBytes]
  ]);
}
function catalogFor(packageBytes, overrides = {}) {
  const module = {
    id: 'plcgen',
    name: 'PLC 生成模块',
    version: '1.0.0',
    coreApiVersion: 1,
    dependencies: [],
    requiredCapabilities: [],
    packageSize: packageBytes.length,
    packageSha256: sha256(packageBytes),
    authenticity: 'unsigned',
    activation: 'blocked-until-trust-policy',
    ...overrides
  };
  return { format: 'automationcad-module-catalog', schemaVersion: 1, coreApiVersion: 1, modules: [module] };
}
async function withMockFeed(t, options = {}) {
  const packageBytes = options.packageBytes ?? buildPackage();
  const catalog = options.catalog ?? catalogFor(packageBytes);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/feed/catalog.json') {
      if (options.catalogStatus) {
        response.writeHead(options.catalogStatus, options.catalogStatus === 302 ? { location: '/other' } : {});
        response.end();
        return;
      }
      const body = Buffer.from(JSON.stringify(catalog));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/feed/modules/plcgen/1.0.0.acmodule.zip') {
      response.writeHead(options.packageStatus ?? 200, { 'content-type': 'application/octet-stream', 'content-length': packageBytes.length });
      response.end(packageBytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), 'automationcad-module-staging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceUrl = `http://127.0.0.1:${address.port}/feed/`;
  const service = new ModuleStagingService({ sourceUrl, stagingDirectory: join(root, 'staged'), stagingEnabled: true, allowLoopbackForTests: true });
  return { service, requests, root, packageBytes, catalog };
}

test('生产 Core 未配置目录来源时保持空目录，不发起请求；任意 HTTP 源默认拒绝', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'automationcad-module-unconfigured-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ModuleStagingService({ stagingDirectory: join(root, 'staged'), stagingEnabled: true });
  assert.deepEqual(await service.getCatalog(), { configured: false, state: 'unconfigured', modules: [] });
  await assert.rejects(service.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_SOURCE_UNCONFIGURED' });
  assert.throws(() => new ModuleStagingService({ sourceUrl: 'http://example.invalid/feed/', stagingDirectory: join(root, 'other') }), { code: 'MODULE_SOURCE_INVALID' });
  assert.throws(() => new ModuleStagingService({ sourceUrl: 'http://127.0.0.1/feed/', stagingDirectory: join(root, 'other') }), { code: 'MODULE_SOURCE_INVALID' });
  assert.throws(() => new ModuleStagingService({ sourceUrl: null }), { code: 'MODULE_STAGE_PATH_INVALID' });
  const disabled = new ModuleStagingService({ stagingDirectory: join(root, 'disabled') });
  await assert.rejects(disabled.removeStagedModule('plcgen', '1.0.0'), { code: 'MODULE_STAGE_DISABLED' });
  await assert.rejects(disabled.listStagedModules(), { code: 'MODULE_STAGE_DISABLED' });
  assert.deepEqual(await readdir(root), []);
});

test('回环 mock 目录允许按 ID/版本下载并校验、原子暂存，但绝不解包或激活', async (t) => {
  const { service, requests, root, packageBytes } = await withMockFeed(t);
  const catalog = await service.getCatalog();
  assert.equal(catalog.configured, true);
  assert.equal(catalog.state, 'ready');
  assert.equal(catalog.modules.length, 1);
  assert.equal(catalog.modules[0].id, 'plcgen');
  const downloaded = await service.downloadModule('plcgen', '1.0.0');
  assert.deepEqual(requests, ['/feed/catalog.json', '/feed/catalog.json', '/feed/modules/plcgen/1.0.0.acmodule.zip']);
  assert.equal(downloaded.staged, true);
  assert.equal(downloaded.authenticity, 'unsigned');
  assert.equal(downloaded.activation, 'blocked-until-trust-policy');
  assert.deepEqual(downloaded.dependencies, []);
  assert.deepEqual(downloaded.requiredCapabilities, []);
  assert.deepEqual(await service.listStagedModules(), [{
    id: 'plcgen', version: '1.0.0', packageSize: packageBytes.length,
    packageSha256: sha256(packageBytes), dependencies: [], requiredCapabilities: [],
    authenticity: 'unsigned', activation: 'blocked-until-trust-policy'
  }]);
  const stagedDir = join(root, 'staged');
  const files = await readdir(stagedDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^plcgen-1\.0\.0-[a-f0-9]{16}\.acmodule\.zip$/u);
  assert.deepEqual(await readFile(join(stagedDir, files[0])), packageBytes);
  assert.equal(files.some((name) => name.endsWith('.mjs') || name === 'module.json'), false);
  assert.equal((await service.downloadModule('plcgen', '1.0.0')).staged, true);
  assert.equal((await readdir(stagedDir)).length, 1);
});

test('并发下载串行复用同一个缓存包；暂存总量超过 250 MiB 时拒绝继续写入', async (t) => {
  const concurrent = await withMockFeed(t);
  const results = await Promise.all([
    concurrent.service.downloadModule('plcgen', '1.0.0'),
    concurrent.service.downloadModule('plcgen', '1.0.0')
  ]);
  assert.equal(results.length, 2);
  assert.equal(concurrent.requests.filter((url) => url.endsWith('.acmodule.zip')).length, 1);

  const limited = await withMockFeed(t);
  const stagedDir = join(limited.root, 'staged');
  await mkdir(stagedDir, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    const handle = await open(join(stagedDir, `reserved-${index}.acmodule.zip`), 'wx', 0o600);
    await handle.truncate(50 * 1024 * 1024);
    await handle.close();
  }
  const stalePart = await open(join(stagedDir, '.module-00000000-0000-4000-8000-000000000000.part'), 'wx', 0o600);
  await stalePart.truncate(50 * 1024 * 1024);
  await stalePart.close();
  await assert.rejects(limited.service.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_STAGE_LIMIT' });
  assert.equal((await readdir(stagedDir)).length, 5);
});

test('不接受目录任意 URL 字段、重复 ID/版本、错误身份、版本或损坏包', async (t) => {
  const bytes = buildPackage();
  const malformedCatalogs = [
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], url: 'http://127.0.0.1/evil' }] },
    { ...catalogFor(bytes), modules: [catalogFor(bytes).modules[0], catalogFor(bytes).modules[0]] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], packageSize: 0 }] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], packageSize: 50 * 1024 * 1024 + 1 }] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], dependencies: ['../escape'] }] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], requiredCapabilities: ['unsafe', 'unsafe'] }] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], activation: 'enabled' }] },
    { ...catalogFor(bytes), modules: [{ ...catalogFor(bytes).modules[0], version: '../1.0.0' }] }
  ];
  for (const catalog of malformedCatalogs) {
    const { service } = await withMockFeed(t, { catalog });
    await assert.rejects(service.getCatalog(), { code: 'MODULE_CATALOG_INVALID' });
  }
  const wrongIdPackage = buildPackage({ id: 'elec.validation' });
  const { service: wrongIdService } = await withMockFeed(t, { packageBytes: wrongIdPackage });
  await assert.rejects(wrongIdService.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_ID_MISMATCH' });
  const badHashPackage = buildPackage({ invalidModuleHash: true });
  const { service: badHashService } = await withMockFeed(t, { packageBytes: badHashPackage });
  await assert.rejects(badHashService.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_INVALID' });
  const declarationPackage = buildPackage({ dependencies: ['plcgen'], requiredCapabilities: ['plcgen.generate'] });
  const declarationCatalog = catalogFor(declarationPackage);
  declarationCatalog.modules[0].requiredCapabilities = [];
  const { service: declarationService } = await withMockFeed(t, { packageBytes: declarationPackage, catalog: declarationCatalog });
  await assert.rejects(declarationService.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_DECLARATION_MISMATCH' });
});

test('目录与包下载拒绝重定向、损坏 ZIP、ID 注入和总体哈希不匹配', async (t) => {
  const { service: redirectService, requests } = await withMockFeed(t, { catalogStatus: 302 });
  await assert.rejects(redirectService.getCatalog(), { code: 'MODULE_SOURCE_RESPONSE_INVALID' });
  assert.deepEqual(requests, ['/feed/catalog.json']);
  await assert.rejects(redirectService.downloadModule('../escape', '1.0.0'), { code: 'MODULE_REQUEST_INVALID' });

  const invalidZip = Buffer.from('not-a-zip');
  const { service: zipService } = await withMockFeed(t, { packageBytes: invalidZip });
  await assert.rejects(zipService.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_INVALID' });

  const packageBytes = buildPackage();
  const tamperedCatalog = catalogFor(packageBytes, { packageSha256: '0'.repeat(64) });
  const { service: hashService } = await withMockFeed(t, { packageBytes, catalog: tamperedCatalog });
  await assert.rejects(hashService.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_HASH_MISMATCH' });
});

test('按 ID/版本清理单个已验证 ZIP 缓存；保留其他包、项目外文件与不激活边界且不访问网络', async (t) => {
  const { service, requests, root, packageBytes } = await withMockFeed(t);
  const downloaded = await service.downloadModule('plcgen', '1.0.0');
  assert.equal(downloaded.activation, 'blocked-until-trust-policy');
  const stagedDir = join(root, 'staged');
  const otherBytes = buildPackage({ id: 'safety-cn', version: '2.0.0' });
  const otherName = `safety-cn-2.0.0-${sha256(otherBytes).slice(0, 16)}.acmodule.zip`;
  await writeFile(join(stagedDir, otherName), otherBytes, { flag: 'wx', mode: 0o600 });
  const unrelatedPath = join(stagedDir, 'keep-note.txt');
  const unrelatedBytes = Buffer.from('not a module package');
  await writeFile(unrelatedPath, unrelatedBytes, { flag: 'wx', mode: 0o600 });
  const projectDataPath = join(root, 'project-data.json');
  const projectData = Buffer.from('{"project":"untouched"}');
  await writeFile(projectDataPath, projectData, { flag: 'wx', mode: 0o600 });
  const selectedName = (await readdir(stagedDir)).find((name) => name.startsWith('plcgen-1.0.0-'));
  assert.ok(selectedName);
  const selectedPath = join(stagedDir, selectedName);
  assert.deepEqual(await readFile(selectedPath), packageBytes);
  const requestCount = requests.length;

  const result = await service.removeStagedModule('plcgen', '1.0.0');

  assert.deepEqual(result, { id: 'plcgen', version: '1.0.0', packageSize: packageBytes.length, removed: true });
  assert.deepEqual(requests.length, requestCount);
  await assert.rejects(readFile(selectedPath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(stagedDir, otherName)), otherBytes);
  assert.deepEqual(await readFile(unrelatedPath), unrelatedBytes);
  assert.deepEqual(await readFile(projectDataPath), projectData);
  assert.deepEqual(await service.listStagedModules(), [{
    id: 'safety-cn', version: '2.0.0', packageSize: otherBytes.length,
    packageSha256: sha256(otherBytes), dependencies: [], requiredCapabilities: [],
    authenticity: 'unsigned', activation: 'blocked-until-trust-policy'
  }]);
});

test('拒绝路径遍历、未知 ID/版本和符号链接清理，不改变任何其他文件', async (t) => {
  const { service, requests, root, packageBytes } = await withMockFeed(t);
  await service.downloadModule('plcgen', '1.0.0');
  const stagedDir = join(root, 'staged');
  const selectedName = (await readdir(stagedDir))[0];
  const selectedPath = join(stagedDir, selectedName);
  const sentinelPath = join(root, 'outside-sentinel.bin');
  const sentinel = Buffer.from('must never be deleted or changed');
  await writeFile(sentinelPath, sentinel, { flag: 'wx', mode: 0o600 });
  const before = await readFile(selectedPath);
  const requestCount = requests.length;
  await assert.rejects(service.removeStagedModule('../escape', '1.0.0'), { code: 'MODULE_REQUEST_INVALID' });
  await assert.rejects(service.removeStagedModule('plcgen', '../1.0.0'), { code: 'MODULE_REQUEST_INVALID' });
  await assert.rejects(service.removeStagedModule('plcgen', '2.0.0'), { code: 'MODULE_STAGED_PACKAGE_NOT_FOUND' });
  assert.deepEqual(await readFile(selectedPath), before);
  assert.deepEqual(await readFile(sentinelPath), sentinel);
  assert.deepEqual(requests.length, requestCount);

  const symlinkRoot = join(root, 'symlink-case');
  const symlinkStaging = join(symlinkRoot, 'module-staging');
  await mkdir(symlinkStaging, { recursive: true });
  const linkName = `plcgen-1.0.0-${sha256(packageBytes).slice(0, 16)}.acmodule.zip`;
  const linkPath = join(symlinkStaging, linkName);
  await symlink(sentinelPath, linkPath);
  const keepPath = join(symlinkStaging, 'keep.txt');
  const keepBytes = Buffer.from('keep this staged directory entry');
  await writeFile(keepPath, keepBytes, { flag: 'wx', mode: 0o600 });
  const symlinkService = new ModuleStagingService({ stagingDirectory: symlinkStaging, stagingEnabled: true });
  await assert.rejects(symlinkService.removeStagedModule('plcgen', '1.0.0'), { code: 'MODULE_STAGE_PATH_INVALID' });
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(sentinelPath), sentinel);
  assert.deepEqual(await readFile(keepPath), keepBytes);
  assert.deepEqual((await readdir(symlinkStaging)).sort(), [linkName, 'keep.txt'].sort());
  assert.equal(dirname(linkPath), symlinkStaging);
});

test('模块包必须只有允许的两个 ZIP 条目并且不支持解压炸弹或超额文件', async (t) => {
  const moduleBytes = Buffer.from('export const inertModule = true;\n');
  const manifest = {
    format: 'automationcad.module-artifact', schemaVersion: 1,
    module: { id: 'plcgen', version: '1.0.0', apiCompatibility: { min: 1, max: 1 }, dependencies: [], requiredCapabilities: [] },
    coreApiVersion: 1, entry: 'module.mjs',
    files: [{ path: 'module.mjs', size: moduleBytes.length, sha256: sha256(moduleBytes) }],
    authenticity: 'unsigned', activation: 'blocked-until-trust-policy'
  };
  const packageBytes = zipStore([
    ['module.json', Buffer.from(JSON.stringify(manifest))],
    ['module.mjs', moduleBytes],
    ['extra.txt', Buffer.from('unexpected')]
  ]);
  const { service } = await withMockFeed(t, { packageBytes });
  await assert.rejects(service.downloadModule('plcgen', '1.0.0'), { code: 'MODULE_PACKAGE_INVALID' });
});
