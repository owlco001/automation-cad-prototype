// 已安装签名模块包 → 分块来源：真实临时目录 + 真实 Ed25519 + module-package 安装函数。
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MODULE_PACKAGE_SCHEMA_VERSION,
  canonicalModulePackagePayload,
  installModulePackage
} from '../../src/modules/module-package.ts';
import { ModuleChunkLoader } from '../../src/modules/chunk-loader.ts';
import {
  createInstalledEntryResolver,
  listInstalledChunkEntries,
  readInstalledChunkSource
} from '../../src/modules/installed-modules.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const MAX_BYTES = 1024 * 1024;
let stagingCounter = 0;

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 与构建产物相同的自注册分块；测试里由 ModuleChunkLoader 的 install 端口执行。 */
function chunkSource(id, exportsValue = { ok: true }, apiVersion = 1) {
  return `(function(){__register(${JSON.stringify({ id, apiVersion, exports: exportsValue })})})();\n`;
}

function makePackage({
  moduleId = 'cost.estimation',
  moduleVersion = '1.0.0',
  apiCompatibility = { min: 1, max: 2 },
  dependencies = [],
  files
} = {}) {
  const payload = {
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
  const canonical = canonicalModulePackagePayload(payload);
  return {
    payload,
    files,
    manifest: {
      ...payload,
      signature: sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex')
    }
  };
}

function readerFrom(files) {
  return async (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(files[path], 'utf8');
  };
}

/** 复用 module-package 的安装函数，确保测试面对的是真实安装布局与真实签名。 */
async function installPackage(root, { files, ...options } = {}) {
  const pkg = makePackage({ ...options, files });
  stagingCounter += 1;
  const result = await installModulePackage({
    manifest: pkg.manifest,
    readFile: readerFrom(pkg.files),
    targetRoot: root,
    publicKeyPem,
    hostApiVersion: 1,
    enabledModules: ['core'],
    maxBytes: MAX_BYTES,
    randomSuffix: () => `staging${stagingCounter}`
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return { ...pkg, path: result.path };
}

function manifestPath(root, moduleId, version) {
  return join(root, moduleId, version, 'manifest.json');
}

async function updateInstalledManifest(root, moduleId, version, mutate) {
  const path = manifestPath(root, moduleId, version);
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cad-installed-modules-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('正常枚举与读取：安装包分块映射为 ModuleChunkEntry，并能被 ModuleChunkLoader 执行', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id, { answer: 42 });
    await installPackage(root, {
      moduleId: id,
      files: {
        [`${id}.js`]: source,
        'lib/readme.txt': '辅助文件\n'
      }
    });

    const entries = await listInstalledChunkEntries(root, { publicKeyPem });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.id, id);
    assert.equal(entry.file, `${id}.js`);
    assert.equal(entry.bytes, Buffer.byteLength(source, 'utf8'));
    assert.equal(entry.sha256, sha256Text(source));
    assert.deepEqual(entry.apiCompatibility, { min: 1, max: 2 });
    assert.equal(entry.moduleVersion, '1.0.0');
    assert.equal(entry.path, join(root, id, '1.0.0'));

    const read = await readInstalledChunkSource(root, id, '1.0.0', { publicKeyPem });
    assert.equal(read.ok, true);
    assert.equal(read.source, source);

    const resolver = createInstalledEntryResolver({ targetRoot: root, publicKeyPem });
    assert.deepEqual(resolver(id), entry);
    assert.equal(resolver('other.module'), null);
    assert.equal(resolver('../escape'), null);
    assert.deepEqual(resolver.entries(), [entry]);

    // 真正的交付链路：loader 使用安装目录里的条目与源码，执行自注册分块。
    const readSources = [];
    const loader = new ModuleChunkLoader({
      readManifest: async () => ({ schemaVersion: 1, moduleApiVersion: 1, chunks: [entry] }),
      readSource: async (chunkEntry) => {
        // ModuleChunkEntry 只保留 id/file/bytes/sha256；版本由已安装来源解析器补回。
        const installedEntry = resolver(chunkEntry.id);
        if (!installedEntry) throw new Error('MODULE_NOT_INSTALLED');
        const result = await readInstalledChunkSource(
          root,
          installedEntry.id,
          installedEntry.moduleVersion,
          { publicKeyPem }
        );
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        readSources.push(result.source);
        return result.source;
      },
      install: (text, onRegister) => {
        new Function('__register', text)(onRegister);
      },
      sha256: async (text) => sha256Text(text),
      hostApiVersion: 1,
      moduleState: (moduleId) =>
        moduleId === id ? { enabled: true, dependencies: ['core'] } : null,
      isEnabled: (moduleId) => moduleId === 'core'
    });
    const loaded = await loader.load(id);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.deepEqual(loaded.exports, { answer: 42 });
    assert.deepEqual(readSources, [source]);
  });
});

test('UTF-8 BOM 与中文分块按原始字节交付，重新编码后字节数不变', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = `\uFEFF// 成本估算分块\n${chunkSource(id, { label: '成本' })}`;
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });

    const entries = await listInstalledChunkEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].bytes, Buffer.byteLength(source, 'utf8'));

    const read = await readInstalledChunkSource(root, id, '1.0.0');
    assert.equal(read.ok, true);
    assert.equal(read.source, source);
    assert.equal(
      new TextEncoder().encode(read.source).byteLength,
      entries[0].bytes,
      'loader 会按 TextEncoder 重新算字节数，BOM 不能被吞掉'
    );
  });
});

test('没有任何安装：列表为空，读取返回 MODULE_NOT_INSTALLED，resolver 返回 null', async () => {
  await withTemp(async (root) => {
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.deepEqual(await listInstalledChunkEntries(root, { publicKeyPem }), []);

    const read = await readInstalledChunkSource(root, 'cost.estimation', '1.0.0');
    assert.equal(read.ok, false);
    assert.equal(read.code, 'MODULE_NOT_INSTALLED');

    const missingRoot = join(root, 'not-created');
    assert.deepEqual(await listInstalledChunkEntries(missingRoot), []);
    assert.equal(
      (await readInstalledChunkSource(missingRoot, 'cost.estimation', '1.0.0')).code,
      'MODULE_NOT_INSTALLED'
    );

    const resolver = createInstalledEntryResolver({ targetRoot: root });
    assert.equal(resolver('cost.estimation'), null);
    assert.deepEqual(resolver.entries(), []);
  });
});

test('分块被篡改：读取返回 CHUNK_HASH_MISMATCH，列表跳过，resolver 为空', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id, { answer: 42 });
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });

    const tampered = source.replace('42', '43');
    assert.notEqual(tampered, source);
    assert.equal(Buffer.byteLength(tampered, 'utf8'), Buffer.byteLength(source, 'utf8'));
    await writeFile(join(root, id, '1.0.0', `${id}.js`), tampered, 'utf8');

    const mismatch = await readInstalledChunkSource(root, id, '1.0.0');
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'CHUNK_HASH_MISMATCH');
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(createInstalledEntryResolver({ targetRoot: root })(id), null);

    // 字节数不符同样归到 CHUNK_HASH_MISMATCH（已安装分块只有这四类失败码）。
    await writeFile(join(root, id, '1.0.0', `${id}.js`), `${source}// extra\n`, 'utf8');
    const resized = await readInstalledChunkSource(root, id, '1.0.0');
    assert.equal(resized.ok, false);
    assert.equal(resized.code, 'CHUNK_HASH_MISMATCH');
  });
});

test('清单声明路径穿越：读取返回 PATH_UNSAFE，且不会被当作已安装', async () => {
  await withTemp(async (root) => {
    const id = 'elec.validation';
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: chunkSource(id) } });
    await updateInstalledManifest(root, id, '1.0.0', (manifest) => {
      manifest.chunk = '../escape.js';
    });

    const unsafeChunk = await readInstalledChunkSource(root, id, '1.0.0', { publicKeyPem });
    assert.equal(unsafeChunk.ok, false);
    assert.equal(unsafeChunk.code, 'PATH_UNSAFE');
    assert.deepEqual(await listInstalledChunkEntries(root), []);

    // files[].path 越界与 chunk 字段越界同等处理。
    const otherId = 'plcgen';
    await installPackage(root, {
      moduleId: otherId,
      files: { [`${otherId}.js`]: chunkSource(otherId) }
    });
    await updateInstalledManifest(root, otherId, '1.0.0', (manifest) => {
      manifest.files[0].path = '../escape.js';
    });
    const unsafeFile = await readInstalledChunkSource(root, otherId, '1.0.0');
    assert.equal(unsafeFile.ok, false);
    assert.equal(unsafeFile.code, 'PATH_UNSAFE');

    // 调用方传入的 id/version 也不能穿越到安装目录之外。
    assert.equal(
      (await readInstalledChunkSource(root, '../escape', '1.0.0')).code,
      'MODULE_NOT_INSTALLED'
    );
    assert.equal(
      (await readInstalledChunkSource(root, id, '../1.0.0')).code,
      'MODULE_NOT_INSTALLED'
    );
  });
});

test('多版本取最高有效版本，损坏的最高版本向下回落；按 moduleId 排序', async () => {
  await withTemp(async (root) => {
    const id = 'drawings.techdraw';
    for (const version of ['1.2.0', '1.10.0', '1.0.0']) {
      await installPackage(root, {
        moduleId: id,
        moduleVersion: version,
        files: { [`${id}.js`]: chunkSource(id, { version }) }
      });
    }
    await installPackage(root, {
      moduleId: 'zeta.module',
      files: { 'zeta.module.js': chunkSource('zeta.module') }
    });
    await installPackage(root, {
      moduleId: 'alpha.module',
      moduleVersion: '2.0.0',
      files: { 'alpha.module.js': chunkSource('alpha.module') }
    });

    let entries = await listInstalledChunkEntries(root);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.moduleVersion]),
      [
        ['alpha.module', '2.0.0'],
        ['drawings.techdraw', '1.10.0'],
        ['zeta.module', '1.0.0']
      ]
    );
    assert.equal((await readInstalledChunkSource(root, id, '1.2.0')).ok, true);

    const resolver = createInstalledEntryResolver({ targetRoot: root });
    assert.equal(resolver(id).moduleVersion, '1.10.0');

    // 最高版分块被改：列表回落到 1.2.0，显式读取 1.10.0 仍然报哈希不符。
    await writeFile(join(root, id, '1.10.0', `${id}.js`), 'tampered\n', 'utf8');
    entries = await listInstalledChunkEntries(root);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.moduleVersion]),
      [
        ['alpha.module', '2.0.0'],
        ['drawings.techdraw', '1.2.0'],
        ['zeta.module', '1.0.0']
      ]
    );
    assert.equal(
      (await readInstalledChunkSource(root, id, '1.10.0')).code,
      'CHUNK_HASH_MISMATCH'
    );
    assert.equal((await readInstalledChunkSource(root, id, '1.2.0')).ok, true);

    resolver.refresh();
    assert.equal(resolver(id).moduleVersion, '1.2.0');
  });
});

test('清单 chunk 字段优先于默认文件名，且该安装布局扩展不破坏签名校验', async () => {
  await withTemp(async (root) => {
    const id = 'factory.plc-sync';
    const defaultSource = chunkSource(id, { file: 'default' });
    const explicitSource = chunkSource(id, { file: 'bundle' });
    await installPackage(root, {
      moduleId: id,
      moduleVersion: '3.0.0',
      files: {
        [`${id}.js`]: defaultSource,
        'bundle.js': explicitSource
      }
    });

    // 没有 chunk 字段时按约定使用 <moduleId>.js。
    let entries = await listInstalledChunkEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, `${id}.js`);
    assert.equal((await readInstalledChunkSource(root, id, '3.0.0')).source, defaultSource);

    // module-package 的签名结构不接受额外字段，安装器不会写 chunk；这里模拟安装布局
    // 扩展。chunk 不参与规范化签名，因此带上 publicKeyPem 仍应通过验签。
    await updateInstalledManifest(root, id, '3.0.0', (manifest) => {
      manifest.chunk = 'bundle.js';
    });
    entries = await listInstalledChunkEntries(root, { publicKeyPem });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, 'bundle.js');
    assert.equal(entries[0].sha256, sha256Text(explicitSource));
    const read = await readInstalledChunkSource(root, id, '3.0.0', { publicKeyPem });
    assert.equal(read.ok, true);
    assert.equal(read.source, explicitSource);
  });
});

test('目录存在但清单非法时不视为已安装', async () => {
  await withTemp(async (root) => {
    const ghostDir = join(root, 'ghost.module', '9.9.9');
    await mkdir(ghostDir, { recursive: true });

    // 只有目录，没有清单。
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(
      (await readInstalledChunkSource(root, 'ghost.module', '9.9.9')).code,
      'MODULE_NOT_INSTALLED'
    );

    // 清单不是 JSON。
    await writeFile(join(ghostDir, 'manifest.json'), '{ not json', 'utf8');
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(
      (await readInstalledChunkSource(root, 'ghost.module', '9.9.9')).code,
      'MODULE_NOT_INSTALLED'
    );

    // 目录名与清单身份不一致。
    const mismatched = makePackage({
      moduleId: 'other.module',
      moduleVersion: '9.9.9',
      files: { 'other.module.js': chunkSource('other.module') }
    });
    await writeFile(join(ghostDir, 'manifest.json'), JSON.stringify(mismatched.manifest), 'utf8');
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(
      (await readInstalledChunkSource(root, 'ghost.module', '9.9.9')).code,
      'MODULE_NOT_INSTALLED'
    );

    // 清单合法但声明文件缺失：目录名存在也不等于已安装。
    const onlyManifest = makePackage({
      moduleId: 'ghost.module',
      moduleVersion: '9.9.9',
      files: { 'ghost.module.js': chunkSource('ghost.module') }
    });
    await writeFile(
      join(ghostDir, 'manifest.json'),
      `${JSON.stringify(onlyManifest.manifest, null, 2)}\n`,
      'utf8'
    );
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(
      (await readInstalledChunkSource(root, 'ghost.module', '9.9.9')).code,
      'CHUNK_MISSING'
    );

    // 安装器的 staging 目录不是模块。
    await mkdir(join(root, '.staging-deadbeef'), { recursive: true });
    assert.deepEqual(await listInstalledChunkEntries(root), []);
    assert.equal(createInstalledEntryResolver({ targetRoot: root })('ghost.module'), null);
  });
});

test('缺分块、非分块文件损坏、无分块声明分别返回 CHUNK_MISSING / MODULE_NOT_INSTALLED / CHUNK_MISSING', async () => {
  await withTemp(async (root) => {
    const missingId = 'cost.estimation';
    await installPackage(root, {
      moduleId: missingId,
      files: { [`${missingId}.js`]: chunkSource(missingId) }
    });
    await rm(join(root, missingId, '1.0.0', `${missingId}.js`));
    assert.equal(
      (await readInstalledChunkSource(root, missingId, '1.0.0')).code,
      'CHUNK_MISSING'
    );

    const corruptId = 'elec.validation';
    const corruptSource = chunkSource(corruptId);
    await installPackage(root, {
      moduleId: corruptId,
      files: {
        [`${corruptId}.js`]: corruptSource,
        'lib/helper.txt': 'helper\n'
      }
    });
    await writeFile(join(root, corruptId, '1.0.0', 'lib/helper.txt'), 'tampered\n', 'utf8');
    const corrupt = await readInstalledChunkSource(root, corruptId, '1.0.0');
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.code, 'MODULE_NOT_INSTALLED');

    const noChunkId = 'plcgen';
    await installPackage(root, {
      moduleId: noChunkId,
      files: { 'readme.txt': '没有分块声明\n' }
    });
    assert.equal(
      (await readInstalledChunkSource(root, noChunkId, '1.0.0')).code,
      'CHUNK_MISSING'
    );
    assert.deepEqual((await listInstalledChunkEntries(root)).map((entry) => entry.id), []);
  });
});

test('IO 可注入：异步 fs 与同步 resolver 端口都能替换', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id);
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });

    let asyncReads = 0;
    let asyncLists = 0;
    const asyncFs = {
      async readFile(path) {
        asyncReads += 1;
        return await readFile(path);
      },
      async readdir(path) {
        asyncLists += 1;
        return await readdir(path, { withFileTypes: true });
      }
    };
    const entries = await listInstalledChunkEntries(root, { fs: asyncFs });
    assert.equal(entries.length, 1);
    assert.equal((await readInstalledChunkSource(root, id, '1.0.0', { fs: asyncFs })).ok, true);
    assert.ok(asyncReads > 0);
    assert.ok(asyncLists > 0);

    let syncReads = 0;
    const syncFs = {
      readFile(path) {
        syncReads += 1;
        return readFileSync(path);
      },
      readdir(path) {
        return readdirSync(path, { withFileTypes: true });
      }
    };
    const resolver = createInstalledEntryResolver({ targetRoot: root, syncFs });
    assert.equal(resolver(id).id, id);
    assert.ok(syncReads > 0);
  });
});
