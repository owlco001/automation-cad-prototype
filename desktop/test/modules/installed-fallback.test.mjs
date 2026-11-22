// 两级来源：随包清单优先，未随包发布但已离线安装的签名包按需补位。
//
// 用模块内已有的 installModulePackage 在临时目录造出**真实签名**的已安装包（含分块文件），
// 再驱动真实 ModuleChunkLoader。已安装端口在这里是主进程 IPC 的替身：
// - 成功路径按签名清单声明的 bytes/sha256/apiCompatibility 返回源码，由 loader 独立复核；
// - 篡改用例刻意直接读磁盘文件，模拟端口交付了被改过的字节（TOCTOU / 不可信端口），
//   这样才验得到 loader 自己的 HASH/SIZE 复核，而不是被上游读取器提前拦掉。
// 全程不联网、不启动 Electron；每个临时目录都在 finally 清理。
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModuleChunkLoader } from '../../src/modules/chunk-loader.ts';
import {
  MODULE_PACKAGE_SCHEMA_VERSION,
  canonicalModulePackagePayload,
  installModulePackage
} from '../../src/modules/module-package.ts';
import { listInstalledChunkEntries } from '../../src/modules/installed-modules.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const MAX_BYTES = 1024 * 1024;
let stagingCounter = 0;

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 与构建产物相同的自注册分块；install 端口会执行它。 */
function chunkSource(id, exportsValue = { ok: true }, apiVersion = 1) {
  return `(function(){__register(${JSON.stringify({ id, apiVersion, exports: exportsValue })})})();\n`;
}

function makePackage({
  moduleId,
  moduleVersion = '1.0.0',
  apiCompatibility = { min: 1, max: 2 },
  dependencies = [],
  files
}) {
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

/** 真实安装：Ed25519 验签 + 逐文件哈希校验 + 原子 rename，与生产安装同一条代码路径。 */
async function installPackage(root, { files, hostApiVersion = 1, ...options }) {
  const pkg = makePackage({ ...options, files });
  stagingCounter += 1;
  const result = await installModulePackage({
    manifest: pkg.manifest,
    readFile: readerFrom(pkg.files),
    targetRoot: root,
    publicKeyPem,
    hostApiVersion,
    enabledModules: [],
    maxBytes: MAX_BYTES,
    randomSuffix: () => `staging${stagingCounter}`
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return { ...pkg, path: result.path };
}

/** 从已安装包读出分块条目（清单声明值），作为端口返回的期望元数据。 */
async function installedSnapshot(root, id) {
  const entries = await listInstalledChunkEntries(root, { publicKeyPem });
  const entry = entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `已安装包应提供 ${id} 的分块条目`);
  return {
    id,
    filePath: join(root, id, entry.moduleVersion, entry.file),
    sha256: entry.sha256,
    bytes: entry.bytes,
    apiCompatibility: entry.apiCompatibility
  };
}

/**
 * 主进程端口的替身：每次调用直接读磁盘，返回签名清单声明的 bytes/sha256/API 区间。
 * 未安装（snapshot 为 null 或 id 不匹配）返回 null；loader 应把它当作「未声明」。
 */
function createInstalledPort(snapshot, calls) {
  return async (id) => {
    calls.push(id);
    if (snapshot === null || id !== snapshot.id) return null;
    return {
      source: await readFile(snapshot.filePath, 'utf8'),
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      apiCompatibility: snapshot.apiCompatibility
    };
  };
}

/** 随包分块的清单条目 + 源码；随包来源的校验值同样来自真实字节。 */
function bundledRecord(id, source, apiCompatibility = { min: 1, max: 1 }) {
  return {
    entry: {
      id,
      apiCompatibility,
      file: `${id}.js`,
      bytes: Buffer.byteLength(source, 'utf8'),
      sha256: sha256Text(source)
    },
    source
  };
}

function createHarness({
  bundled = new Map(),
  installedPort,
  hostApiVersion = 1,
  moduleApiVersion = 1,
  readManifest
} = {}) {
  const manifest = {
    schemaVersion: 1,
    moduleApiVersion,
    chunks: [...bundled.values()].map((record) => record.entry)
  };
  const installs = [];
  const deps = {
    readManifest: readManifest ?? (async () => JSON.parse(JSON.stringify(manifest))),
    readSource: async (entry) => {
      const record = bundled.get(entry.id);
      if (!record) throw new Error(`随包分块不存在：${entry.id}`);
      return record.source;
    },
    install: (source, onRegister) => {
      installs.push(source);
      new Function('__register', source)(onRegister);
    },
    sha256: async (text) => sha256Text(text),
    hostApiVersion,
    moduleState: () => ({ enabled: true, dependencies: [] }),
    isEnabled: () => true
  };
  // 旧宿主没有这个端口：必须保持原有 CHUNK_NOT_DECLARED 行为。
  if (installedPort) deps.readInstalledSource = installedPort;
  return { loader: new ModuleChunkLoader(deps), manifest, installs };
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cad-installed-fallback-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('随包清单没有该 id：回落到已安装签名包并成功执行，且不伪造随包清单条目', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id, { answer: 42 });
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });
    const snapshot = await installedSnapshot(root, id);

    const calls = [];
    const { loader, manifest, installs } = createHarness({
      installedPort: createInstalledPort(snapshot, calls)
    });
    const manifestBefore = JSON.stringify(manifest);

    const result = await loader.load(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.exports, { answer: 42 });
    assert.deepEqual(calls, [id], '随包清单没有该 id 时才查询已安装来源');
    assert.equal(installs.length, 1);
    assert.equal(installs[0], source, '执行的必须是已安装包里的分块字节');
    assert.equal(loader.isLoaded(id), true);
    assert.equal(loader.exportsOf(id), result.exports);

    assert.equal(manifest.chunks.length, 0, '已安装分块不能写进随包 manifest');
    assert.equal(JSON.stringify(manifest), manifestBefore, '加载已安装分块不得改动随包清单');

    // 成功结果进入缓存：再次 load 不重复执行，也不再查询已安装端口。
    const again = await loader.load(id);
    assert.equal(again.ok, true);
    assert.equal(again.exports, result.exports);
    assert.deepEqual(calls, [id]);
    assert.equal(installs.length, 1);
  });
});

test('已安装分块被同字节篡改：CHUNK_HASH_MISMATCH，不执行、不缓存，修复后可重试', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id, { answer: 42 });
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });
    const snapshot = await installedSnapshot(root, id);

    const tampered = source.replace('42', '43');
    assert.notEqual(tampered, source, '夹具前提：内容必须真的变了');
    assert.equal(Buffer.byteLength(tampered, 'utf8'), snapshot.bytes, '夹具前提：字节数保持不变');
    assert.notEqual(sha256Text(tampered), snapshot.sha256, '夹具前提：哈希必须真的变了');
    await writeFile(snapshot.filePath, tampered, 'utf8');

    const calls = [];
    const harness = createHarness({ installedPort: createInstalledPort(snapshot, calls) });
    const failed = await harness.loader.load(id);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'CHUNK_HASH_MISMATCH');
    assert.equal(harness.installs.length, 0, '哈希不符绝不能执行');
    assert.equal(harness.loader.isLoaded(id), false, '失败不能标记为已加载');
    assert.equal(calls.length, 1);

    // 修复后同一个 loader 还能成功：证明失败结果没有被缓存。
    await writeFile(snapshot.filePath, source, 'utf8');
    const retried = await harness.loader.load(id);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.deepEqual(retried.exports, { answer: 42 });
    assert.equal(calls.length, 2, '失败后重试应重新查询已安装来源');
    assert.equal(harness.installs.length, 1);
  });
});

test('已安装分块被追加字节：CHUNK_SIZE_MISMATCH，不执行、不缓存', async () => {
  await withTemp(async (root) => {
    const id = 'elec.validation';
    const source = chunkSource(id, { issues: 0 });
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: source } });
    const snapshot = await installedSnapshot(root, id);

    const grown = `${source}// extra\n`;
    assert.notEqual(Buffer.byteLength(grown, 'utf8'), snapshot.bytes, '夹具前提：字节数必须变化');
    await writeFile(snapshot.filePath, grown, 'utf8');

    const calls = [];
    const harness = createHarness({ installedPort: createInstalledPort(snapshot, calls) });
    const failed = await harness.loader.load(id);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'CHUNK_SIZE_MISMATCH');
    assert.equal(harness.installs.length, 0, '字节数不符绝不能执行');
    assert.equal(harness.loader.isLoaded(id), false, '失败不能标记为已加载');
    assert.deepEqual(calls, [id]);
  });
});

test('随包清单里有同 id：优先随包来源，已安装端口调用 0 次', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const bundledSource = chunkSource(id, { answer: 7 });
    const installedSource = chunkSource(id, { answer: 42 });
    // 已安装包确实存在且完整；只要随包清单声明了该 id，它就不该被查询。
    await installPackage(root, { moduleId: id, files: { [`${id}.js`]: installedSource } });
    const snapshot = await installedSnapshot(root, id);

    const calls = [];
    const harness = createHarness({
      bundled: new Map([[id, bundledRecord(id, bundledSource)]]),
      installedPort: createInstalledPort(snapshot, calls)
    });
    const result = await harness.loader.load(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.exports, { answer: 7 }, '必须执行随包来源，而不是已安装包');
    assert.deepEqual(calls, [], '随包清单已声明时不得调用已安装端口');
    assert.equal(calls.length, 0, '已安装端口调用次数必须是 0');
    assert.equal(harness.installs.length, 1);
    assert.equal(harness.installs[0], bundledSource);
  });
});

test('两级来源都没有：保持 CHUNK_NOT_DECLARED（含没有安装端口的旧宿主）', async () => {
  const id = 'cost.estimation';

  const calls = [];
  const harness = createHarness({ installedPort: createInstalledPort(null, calls) });
  const result = await harness.loader.load(id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHUNK_NOT_DECLARED');
  assert.deepEqual(calls, [id], '没有随包分块时才查询已安装来源');
  assert.equal(harness.installs.length, 0);
  assert.equal(harness.loader.isLoaded(id), false);

  // 兼容旧宿主：根本没有 readInstalledSource 端口时也必须保持原失败码。
  const legacy = createHarness();
  const legacyResult = await legacy.loader.load(id);
  assert.equal(legacyResult.ok, false);
  assert.equal(legacyResult.code, 'CHUNK_NOT_DECLARED');
  assert.equal(legacy.installs.length, 0);
});

test('已安装来源 API 区间不含宿主：MODULE_API_INCOMPATIBLE，不执行', async () => {
  await withTemp(async (root) => {
    const id = 'cost.estimation';
    const source = chunkSource(id, { answer: 42 });
    // 安装时宿主是 API 2，包声明 [2,3]；加载时宿主是 API 1。
    await installPackage(root, {
      moduleId: id,
      apiCompatibility: { min: 2, max: 3 },
      hostApiVersion: 2,
      files: { [`${id}.js`]: source }
    });
    const snapshot = await installedSnapshot(root, id);
    assert.deepEqual(snapshot.apiCompatibility, { min: 2, max: 3 });

    const calls = [];
    const harness = createHarness({
      installedPort: createInstalledPort(snapshot, calls),
      hostApiVersion: 1
    });
    const result = await harness.loader.load(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODULE_API_INCOMPATIBLE');
    assert.equal(harness.installs.length, 0);
    assert.equal(harness.loader.isLoaded(id), false);
    assert.deepEqual(calls, [id]);
  });
});

test('已安装端口抛错：CHUNK_UNAVAILABLE，不误报成功或哈希失败', async () => {
  const calls = [];
  const harness = createHarness({
    installedPort: async (id) => {
      calls.push(id);
      throw new Error('ipc transport failed');
    }
  });
  const result = await harness.loader.load('cost.estimation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHUNK_UNAVAILABLE');
  assert.match(result.message, /ipc transport failed/);
  assert.equal(harness.installs.length, 0);
  assert.deepEqual(calls, ['cost.estimation']);
});

test('随包清单本身不可用：不尝试已安装来源，避免清单损坏时偷偷换版本', async () => {
  const calls = [];
  const harness = createHarness({
    readManifest: async () => ({ schemaVersion: 99 }),
    installedPort: createInstalledPort(null, calls)
  });
  const result = await harness.loader.load('cost.estimation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHUNK_MANIFEST_UNAVAILABLE');
  assert.deepEqual(calls, []);
  assert.equal(harness.installs.length, 0);
});
