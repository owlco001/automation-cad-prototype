// 离线签名模块包：真实 Ed25519 密钥 + 真实临时目录，覆盖安装、篡改、路径、上限与回滚。
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdir,
  mkdir as nodeMkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as nodeRename,
  rm,
  stat as nodeStat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MODULE_PACKAGE_SCHEMA_VERSION,
  canonicalModulePackagePayload,
  installModulePackage,
  listInstalledModules,
  loadInstalledModuleVersion,
  verifyModulePackage
} from '../../src/modules/module-package.ts';

const keyPair = generateKeyPairSync('ed25519');
const privateKey = keyPair.privateKey;
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPublicKeyPem = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();

const DEFAULT_FILES = { 'index.js': 'export const answer = 42;\n' };
const DEFAULT_MAX_BYTES = 1024 * 1024;

function makePayload({
  moduleId = 'cost.estimation',
  moduleVersion = '1.0.0',
  apiCompatibility = { min: 1, max: 2 },
  dependencies = [],
  files = DEFAULT_FILES
} = {}) {
  return {
    schemaVersion: MODULE_PACKAGE_SCHEMA_VERSION,
    moduleId,
    moduleVersion,
    apiCompatibility,
    dependencies,
    files: Object.entries(files).map(([path, text]) => {
      const bytes = Buffer.from(text, 'utf8');
      return {
        path,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      };
    })
  };
}

function signPayload(payload, key = privateKey) {
  const canonical = canonicalModulePackagePayload(payload);
  return {
    ...payload,
    signature: sign(null, Buffer.from(canonical, 'utf8'), key).toString('hex')
  };
}

function makePackage({ files = DEFAULT_FILES, ...options } = {}, key = privateKey) {
  const payload = makePayload({ ...options, files });
  return { payload, files, manifest: signPayload(payload, key) };
}

function readerFrom(files) {
  return async (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(files[path], 'utf8');
  };
}

const INSTALL_DEFAULTS = {
  publicKeyPem,
  hostApiVersion: 1,
  enabledModules: ['core'],
  maxBytes: DEFAULT_MAX_BYTES,
  randomSuffix: () => 'staging123'
};

function installOptions(manifest, files, targetRoot, overrides = {}) {
  return {
    manifest,
    readFile: readerFrom(files),
    targetRoot,
    ...INSTALL_DEFAULTS,
    ...overrides
  };
}

function verifyOptions(overrides = {}) {
  return {
    publicKeyPem,
    hostApiVersion: 1,
    enabledModules: ['core'],
    maxBytes: DEFAULT_MAX_BYTES,
    ...overrides
  };
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cad-module-package-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stagingNames(root) {
  return (await readdir(root)).filter((name) => name.startsWith('.staging-'));
}

/** 与真实 fs 行为一致、但可替换单个方法的注入实现。 */
function testFileSystem(overrides = {}) {
  return {
    async mkdir(path, options) {
      await nodeMkdir(path, options);
    },
    async readFile(path) {
      return await readFile(path);
    },
    async writeFile(path, data) {
      await writeFile(path, data);
    },
    async rename(from, to) {
      await nodeRename(from, to);
    },
    async rm(path, options) {
      await rm(path, options);
    },
    async readdir(path) {
      return await readdir(path, { withFileTypes: true });
    },
    async stat(path) {
      return await nodeStat(path);
    },
    ...overrides
  };
}

test('正常安装：写入 staging 后原子落到 moduleId/version，可重新读取并列出', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage({
      files: {
        'index.js': 'export const answer = 42;\n',
        'lib/util.js': 'export const twice = (n) => n * 2;\n'
      }
    });
    const result = await installModulePackage(installOptions(pkg.manifest, pkg.files, root));
    assert.equal(result.ok, true);
    const expectedPath = join(root, 'cost.estimation', '1.0.0');
    assert.equal(result.path, expectedPath);
    assert.equal(result.moduleId, 'cost.estimation');
    assert.equal(result.moduleVersion, '1.0.0');
    assert.equal(await readFile(join(expectedPath, 'lib/util.js'), 'utf8'), pkg.files['lib/util.js']);

    const writtenManifest = JSON.parse(await readFile(join(expectedPath, 'manifest.json'), 'utf8'));
    assert.deepEqual(writtenManifest, pkg.manifest);
    assert.equal(writtenManifest.signature, pkg.manifest.signature);

    const loaded = await loadInstalledModuleVersion(root, 'cost.estimation');
    assert.ok(loaded);
    assert.equal(loaded.path, expectedPath);
    assert.deepEqual(loaded.manifest, pkg.manifest);

    const authenticated = await loadInstalledModuleVersion(root, 'cost.estimation', { publicKeyPem });
    assert.ok(authenticated, '提供正确公钥时应通过清单验签');
    assert.equal(
      await loadInstalledModuleVersion(root, 'cost.estimation', { publicKeyPem: otherPublicKeyPem }),
      null,
      '提供错误公钥时已安装清单不应通过'
    );

    const listed = await listInstalledModules(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].moduleVersion, '1.0.0');
    assert.deepEqual(await stagingNames(root), []);
  });
});

test('安装时文件被篡改（哈希不符）→ FILE_MISMATCH，不落版本目录且无 staging', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage();
    const tampered = { ...pkg.files, 'index.js': 'export const answer = 43;\n' };
    const result = await installModulePackage(installOptions(pkg.manifest, tampered, root));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FILE_MISMATCH');
    assert.equal(await loadInstalledModuleVersion(root, 'cost.estimation'), null);
    await assert.rejects(readFile(join(root, 'cost.estimation', '1.0.0', 'index.js')), /ENOENT/);
    assert.deepEqual(await stagingNames(root), []);
  });
});

test('已安装文件被篡改后，目录名不再被当作已安装', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage({ files: { 'index.js': 'export const answer = 42;\n' } });
    const installed = await installModulePackage(installOptions(pkg.manifest, pkg.files, root));
    assert.equal(installed.ok, true);
    await writeFile(join(root, 'cost.estimation', '1.0.0', 'index.js'), 'export const answer = 43;\n', 'utf8');
    assert.equal(await loadInstalledModuleVersion(root, 'cost.estimation'), null);
    assert.deepEqual(await listInstalledModules(root), []);
  });
});

test('错误公钥 → SIGNATURE_INVALID，安装不会创建版本目录', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage();
    const verified = verifyModulePackage(pkg.manifest, verifyOptions({ publicKeyPem: otherPublicKeyPem }));
    assert.equal(verified.ok, false);
    assert.equal(verified.code, 'SIGNATURE_INVALID');

    const installed = await installModulePackage(
      installOptions(pkg.manifest, pkg.files, root, { publicKeyPem: otherPublicKeyPem })
    );
    assert.equal(installed.ok, false);
    assert.equal(installed.code, 'SIGNATURE_INVALID');
    assert.equal(await loadInstalledModuleVersion(root, 'cost.estimation'), null);
    assert.deepEqual(await stagingNames(root), []);
  });
});

test('文件缺失 → 安装失败并清理 staging；已安装后删文件 → 未安装', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage({
      files: {
        'index.js': 'export const answer = 42;\n',
        'lib/util.js': 'export const twice = (n) => n * 2;\n'
      }
    });
    const partial = { 'index.js': pkg.files['index.js'] };
    const failed = await installModulePackage(installOptions(pkg.manifest, partial, root));
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'FILE_MISMATCH');
    assert.deepEqual(await stagingNames(root), []);
    assert.equal(await loadInstalledModuleVersion(root, 'cost.estimation'), null);

    const installed = await installModulePackage(installOptions(pkg.manifest, pkg.files, root));
    assert.equal(installed.ok, true);
    await rm(join(root, 'cost.estimation', '1.0.0', 'lib/util.js'));
    assert.equal(await loadInstalledModuleVersion(root, 'cost.estimation'), null);
    assert.deepEqual(await listInstalledModules(root), []);
  });
});

test('路径安全：../x、绝对路径、反斜杠、空段 → PATH_UNSAFE，且不写盘', async () => {
  await withTemp(async (root) => {
    const unsafePaths = [
      '../escape.js',
      'lib/../../escape.js',
      '/etc/passwd',
      'C:\\Windows\\evil.js',
      'a//b.js',
      './a.js',
      'manifest.json'
    ];
    for (const path of unsafePaths) {
      const pkg = makePackage({ files: { [path]: 'payload' } });
      const verified = verifyModulePackage(pkg.manifest, verifyOptions());
      assert.equal(verified.ok, false, path);
      assert.equal(verified.code, 'PATH_UNSAFE', path);

      const installed = await installModulePackage(installOptions(pkg.manifest, pkg.files, root));
      assert.equal(installed.ok, false, path);
      assert.equal(installed.code, 'PATH_UNSAFE', path);
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('超过声明字节上限 → SIZE_LIMIT；恰好等于上限允许', async () => {
  await withTemp(async (root) => {
    const pkg = makePackage({ files: { 'a.js': '12345', 'b.js': '67890' } });
    const tooSmall = verifyModulePackage(pkg.manifest, verifyOptions({ maxBytes: 9 }));
    assert.equal(tooSmall.ok, false);
    assert.equal(tooSmall.code, 'SIZE_LIMIT');

    const exact = verifyModulePackage(pkg.manifest, verifyOptions({ maxBytes: 10 }));
    assert.equal(exact.ok, true);

    const installed = await installModulePackage(
      installOptions(pkg.manifest, pkg.files, root, { maxBytes: 9 })
    );
    assert.equal(installed.ok, false);
    assert.equal(installed.code, 'SIZE_LIMIT');
    assert.deepEqual(await readdir(root), []);
  });
});

test('API 区间不含宿主版本 → API_INCOMPATIBLE', () => {
  const pkg = makePackage({ apiCompatibility: { min: 2, max: 3 } });
  assert.equal(verifyModulePackage(pkg.manifest, verifyOptions({ hostApiVersion: 1 })).code, 'API_INCOMPATIBLE');
  assert.equal(verifyModulePackage(pkg.manifest, verifyOptions({ hostApiVersion: 2 })).ok, true);
  assert.equal(verifyModulePackage(pkg.manifest, verifyOptions({ hostApiVersion: 3 })).ok, true);
  assert.equal(verifyModulePackage(pkg.manifest, verifyOptions({ hostApiVersion: 4 })).code, 'API_INCOMPATIBLE');
});

test('依赖缺失 → DEPENDENCY_UNRESOLVED 并点名缺失项', () => {
  const pkg = makePackage({ dependencies: ['core', 'cad.parametric-import'] });
  const missing = verifyModulePackage(pkg.manifest, verifyOptions({ enabledModules: ['core'] }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DEPENDENCY_UNRESOLVED');
  assert.match(missing.message, /cad\.parametric-import/);

  const resolved = verifyModulePackage(
    pkg.manifest,
    verifyOptions({ enabledModules: new Set(['core', 'cad.parametric-import']) })
  );
  assert.equal(resolved.ok, true);
});

test('安装失败后旧版本完好且无 staging 残留；已存在版本永不覆盖', async () => {
  await withTemp(async (root) => {
    const v1 = makePackage({
      moduleVersion: '1.0.0',
      files: { 'index.js': 'export const version = "1.0.0";\n' }
    });
    const first = await installModulePackage(installOptions(v1.manifest, v1.files, root));
    assert.equal(first.ok, true);
    const v1File = join(root, 'cost.estimation', '1.0.0', 'index.js');
    const v1Manifest = join(root, 'cost.estimation', '1.0.0', 'manifest.json');
    const v1Content = await readFile(v1File, 'utf8');
    const v1ManifestText = await readFile(v1Manifest, 'utf8');

    const v11 = makePackage({
      moduleVersion: '1.1.0',
      files: {
        'index.js': 'export const version = "1.1.0";\n',
        'lib/extra.js': 'export const extra = true;\n'
      }
    });
    // 暂存目录创建后才读文件；缺一个文件时必须在 rename 前失败并清理。
    const failed = await installModulePackage(
      installOptions(v11.manifest, { 'index.js': v11.files['index.js'] }, root)
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'FILE_MISMATCH');
    assert.equal(await readFile(v1File, 'utf8'), v1Content);
    assert.equal(await readFile(v1Manifest, 'utf8'), v1ManifestText);
    await assert.rejects(readFile(join(root, 'cost.estimation', '1.1.0', 'index.js')), /ENOENT/);
    assert.deepEqual(await stagingNames(root), []);

    // 同版本重装即使内容已被篡改，也应在读取前就拒绝，旧目录一个字节都不动。
    const overwrite = await installModulePackage(
      installOptions(v1.manifest, { 'index.js': 'tampered\n' }, root)
    );
    assert.equal(overwrite.ok, false);
    assert.equal(overwrite.code, 'TARGET_EXISTS');
    assert.equal(await readFile(v1File, 'utf8'), v1Content);

    const loaded = await loadInstalledModuleVersion(root, 'cost.estimation');
    assert.equal(loaded.moduleVersion, '1.0.0');
    assert.deepEqual(
      (await listInstalledModules(root)).map((item) => item.moduleVersion),
      ['1.0.0']
    );
  });
});

test('原子 rename 失败 → IO_FAILURE，旧版本完好且暂存被清理', async () => {
  await withTemp(async (root) => {
    const v1 = makePackage({ moduleVersion: '1.0.0' });
    assert.equal((await installModulePackage(installOptions(v1.manifest, v1.files, root))).ok, true);
    const oldFile = join(root, 'cost.estimation', '1.0.0', 'index.js');
    const oldContent = await readFile(oldFile, 'utf8');

    const v11 = makePackage({
      moduleVersion: '1.1.0',
      files: { 'index.js': 'export const version = 11;\n' }
    });
    const failingFs = testFileSystem({
      async rename() {
        throw Object.assign(new Error('模拟 rename 失败'), { code: 'EIO' });
      }
    });
    const failed = await installModulePackage(
      installOptions(v11.manifest, v11.files, root, { fs: failingFs })
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'IO_FAILURE');
    assert.equal(await readFile(oldFile, 'utf8'), oldContent);
    assert.deepEqual(await stagingNames(root), []);
    await assert.rejects(readFile(join(root, 'cost.estimation', '1.1.0', 'index.js')), /ENOENT/);
    assert.equal((await loadInstalledModuleVersion(root, 'cost.estimation')).moduleVersion, '1.0.0');
  });
});

test('manifest 键顺序变化仍能验签（规范化按 key 排序）', () => {
  const pkg = makePackage({
    files: {
      'index.js': 'export const answer = 42;\n',
      'lib/util.js': 'export const twice = (n) => n * 2;\n'
    }
  });
  const original = canonicalModulePackagePayload(pkg.payload);
  const reordered = {
    signature: pkg.manifest.signature,
    files: pkg.manifest.files.map((file) => ({
      sha256: file.sha256,
      bytes: file.bytes,
      path: file.path
    })),
    dependencies: [...pkg.manifest.dependencies],
    apiCompatibility: {
      max: pkg.manifest.apiCompatibility.max,
      min: pkg.manifest.apiCompatibility.min
    },
    moduleVersion: pkg.manifest.moduleVersion,
    moduleId: pkg.manifest.moduleId,
    schemaVersion: pkg.manifest.schemaVersion
  };

  const verified = verifyModulePackage(reordered, verifyOptions());
  assert.equal(verified.ok, true);
  assert.equal(verified.canonical, original);

  const tampered = { ...reordered, moduleVersion: '1.0.1' };
  const rejected = verifyModulePackage(tampered, verifyOptions());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SIGNATURE_INVALID');
});

test('目录名存在不等于已安装：缺 manifest / 缺文件 / 损坏清单都跳过', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, 'ghost.module', '9.9.9'), { recursive: true });
    assert.equal(await loadInstalledModuleVersion(root, 'ghost.module'), null);
    assert.deepEqual(await listInstalledModules(root), []);

    const pkg = makePackage({
      moduleId: 'ghost.module',
      moduleVersion: '9.9.9',
      files: { 'index.js': 'module.exports = 1;\n' }
    });
    const ghostManifest = join(root, 'ghost.module', '9.9.9', 'manifest.json');
    await writeFile(ghostManifest, JSON.stringify(pkg.manifest), 'utf8');
    // 只有清单、没有声明文件：仍不算安装。
    assert.equal(await loadInstalledModuleVersion(root, 'ghost.module'), null);
    assert.deepEqual(await listInstalledModules(root), []);

    await writeFile(ghostManifest, '{ not json', 'utf8');
    assert.equal(await loadInstalledModuleVersion(root, 'ghost.module'), null);

    // 目录名与清单里的 moduleId 不一致：不算安装。
    const mismatched = makePackage({
      moduleId: 'other.module',
      moduleVersion: '9.9.9',
      files: { 'index.js': 'module.exports = 2;\n' }
    });
    await writeFile(ghostManifest, JSON.stringify(mismatched.manifest), 'utf8');
    assert.equal(await loadInstalledModuleVersion(root, 'ghost.module'), null);

    await mkdir(join(root, '.staging-deadbeef'), { recursive: true });
    assert.deepEqual(await listInstalledModules(root), []);
  });
});

test('多版本：load 选最高有效版本，list 按 semver 排序，损坏版本被跳过', async () => {
  await withTemp(async (root) => {
    for (const version of ['1.2.0', '1.10.0', '1.0.0']) {
      const pkg = makePackage({
        moduleVersion: version,
        files: { 'index.js': `export const version = ${JSON.stringify(version)};\n` }
      });
      const installed = await installModulePackage(installOptions(pkg.manifest, pkg.files, root));
      assert.equal(installed.ok, true, version);
    }

    assert.deepEqual(
      (await listInstalledModules(root)).map((item) => item.moduleVersion),
      ['1.0.0', '1.2.0', '1.10.0']
    );
    assert.equal((await loadInstalledModuleVersion(root, 'cost.estimation')).moduleVersion, '1.10.0');

    await writeFile(join(root, 'cost.estimation', '1.10.0', 'index.js'), 'tampered\n', 'utf8');
    assert.equal((await loadInstalledModuleVersion(root, 'cost.estimation')).moduleVersion, '1.2.0');
    assert.deepEqual(
      (await listInstalledModules(root)).map((item) => item.moduleVersion),
      ['1.0.0', '1.2.0']
    );
  });
});

test('清单结构非法 → MANIFEST_INVALID（版本 / semver / 重复路径 / 哈希 / 签名 / 未知字段）', () => {
  const pkg = makePackage();
  const firstFile = pkg.manifest.files[0];
  const cases = [
    ['非对象', 'nope'],
    ['schemaVersion 不符', { ...pkg.manifest, schemaVersion: 2 }],
    ['moduleVersion 不是 semver', { ...pkg.manifest, moduleVersion: '1.0' }],
    ['文件路径重复', { ...pkg.manifest, files: [firstFile, { ...firstFile }] }],
    ['sha256 不是小写十六进制', { ...pkg.manifest, files: [{ ...firstFile, sha256: 'A'.repeat(64) }] }],
    ['signature 不是 128 个十六进制字符', { ...pkg.manifest, signature: 'A'.repeat(128) }],
    ['未知字段', { ...pkg.manifest, extra: true }]
  ];
  for (const [label, manifest] of cases) {
    const result = verifyModulePackage(manifest, verifyOptions());
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'MANIFEST_INVALID', label);
  }
});
