// 分块投递链路端到端：生产配置真实构建 → ModuleChunkReader（主进程）→ ModuleChunkLoader
// （渲染层）→ node:vm 执行。
//
// 既有测试分别盯「构建产物」「reader 校验」「loader 决策」三段，却没有一条把三段接起来跑
// 真实产物。接缝上的偏差（清单版本、字节/哈希口径、自注册格式、缓存）单看每一段都发现不了，
// 只会在用户点开模块时才暴露。这里按**当前生产配置** modules/chunks.json 构建到临时目录，
// 全程不读 dist/（产物可能过期或根本不存在）、不启动 Electron、不联网；临时目录在 finally 清理。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { ModuleChunkReader } from '../../electron/module-chunks.ts';
import { ModuleChunkLoader } from '../../src/modules/chunk-loader.ts';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks, DEFAULT_CONFIG_PATH } from '../../scripts/build-module-chunks.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 生产配置，不是测试探针：要验的是真会发出去的那份清单。 */
const PRODUCTION_CONFIG = DEFAULT_CONFIG_PATH;
const chunkSha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** exports 非空：对象至少要有一个导出键，其余类型必须真的能用。 */
function assertUsableExports(value, id) {
  assert.notEqual(value, undefined, `${id} 的 exports 不能是 undefined`);
  assert.notEqual(value, null, `${id} 的 exports 不能是 null`);
  if (typeof value === 'object') {
    assert.ok(Object.keys(value).length > 0, `${id} 的 exports 必须至少有一个导出`);
    return;
  }
  assert.ok(
    typeof value === 'function' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    `${id} 的 exports 必须是可用值，实际是 ${typeof value}`
  );
}

/**
 * 组一条真实链路：reader 按清单读文件，loader 校验后再用 node:vm 执行。
 *
 * install 复刻渲染层的执行条件：经典脚本作用域里只有 `__cadRegisterModuleChunk`，
 * 没有 require / import / DOM；分块必须自己按约定完成自注册。
 */
function createHarness({ rootDir, declaredIds, readSource }) {
  const installs = [];
  let manifestReads = 0;
  const definitions = new Map(MODULE_REGISTRY.map((definition) => [definition.id, definition]));
  const loader = new ModuleChunkLoader({
    readManifest: async () => {
      manifestReads += 1;
      return JSON.parse(await readFile(join(rootDir, 'manifest.json'), 'utf8'));
    },
    readSource,
    install: (source, onRegister) => {
      installs.push(source);
      const sandbox = { __cadRegisterModuleChunk: onRegister };
      sandbox.globalThis = sandbox;
      vm.runInNewContext(source, sandbox, { timeout: 5000 });
    },
    sha256: async (text) => chunkSha256(text),
    hostApiVersion: MODULE_API_VERSION,
    // 注入的模块状态：清单里声明过的模块启用；依赖是否启用按注册表里的真实依赖名回答。
    moduleState: (id) => {
      const definition = definitions.get(id);
      if (!definition || !declaredIds.has(id)) return null;
      return { enabled: true, dependencies: definition.dependencies };
    },
    isEnabled: (id) => definitions.has(id)
  });
  return {
    loader,
    installs,
    manifestReads: () => manifestReads
  };
}

/** 主进程侧端口：源码只从真实 ModuleChunkReader 取（读不到/校验失败就交付失败）。 */
function readerPort(reader) {
  return async (entry) => {
    const result = reader.read(entry.id);
    if (!result.ok) throw new Error(`${result.code}：${result.message}`);
    return result.source;
  };
}

/**
 * 直接读文件的端口（模拟主进程把文件内容交给渲染层，但不经 reader 预校验）。
 * 只用于篡改用例：reader 自己就会拒绝篡改文件，经它转发只能观察到 CHUNK_UNAVAILABLE，
 * 那样就验不到 loader 的独立复核 —— 完整性不能只由主进程负责。
 */
function filePort(rootDir) {
  return async (entry) => readFile(join(rootDir, entry.file), 'utf8');
}

test('分块投递链路：生产配置 → 真实产物 → reader → loader → vm', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'cad-chunk-delivery-'));
  const outDir = join(workDir, 'modules');
  try {
    assert.ok(
      PRODUCTION_CONFIG.endsWith(join('modules', 'chunks.json')),
      `必须用生产配置 modules/chunks.json 构建，实际是 ${PRODUCTION_CONFIG}`
    );
    const config = JSON.parse(await readFile(PRODUCTION_CONFIG, 'utf8'));
    const declaredFromConfig = Object.keys(config.chunks ?? {}).sort();
    assert.ok(declaredFromConfig.length > 0, '生产配置应至少声明一个已迁出的分块');

    const { manifest } = await buildChunks({
      configPath: PRODUCTION_CONFIG,
      outDir,
      root: desktopRoot,
      registry: MODULE_REGISTRY,
      moduleApiVersion: MODULE_API_VERSION
    });
    assert.equal(manifest.moduleApiVersion, MODULE_API_VERSION, '清单 API 版本必须等于宿主版本');
    const declaredIds = new Set(manifest.chunks.map((entry) => entry.id));
    assert.deepEqual([...declaredIds].sort(), declaredFromConfig, '构建清单必须与生产配置声明的分块一一对应');

    const reader = new ModuleChunkReader({ rootDir: outDir });
    const loadedManifest = reader.manifest();
    assert.equal(loadedManifest.ok, true, '临时目录里应有可校验的分块清单');
    assert.deepEqual(loadedManifest.manifest.chunks.map((entry) => entry.id).sort(), [...declaredIds].sort());

    await t.test('每个已声明分块都能加载成功、exports 非空', async () => {
      const { loader, installs } = createHarness({ rootDir: outDir, declaredIds, readSource: readerPort(reader) });
      assert.equal(installs.length, 0, '加载前不应执行任何分块');

      for (const entry of manifest.chunks) {
        // 先确认 reader 与磁盘内容逐字节一致，再把同一份源码交给 loader。
        const onDisk = await readFile(join(outDir, entry.file), 'utf8');
        const read = reader.read(entry.id);
        assert.equal(read.ok, true, `${entry.id} 读取失败：${read.code ?? ''} ${read.message ?? ''}`);
        assert.equal(read.source, onDisk, `${entry.id} 的 reader 源码必须与产物文件一致`);
        assert.equal(Buffer.byteLength(read.source, 'utf8'), entry.bytes);
        assert.equal(chunkSha256(read.source), entry.sha256);

        const result = await loader.load(entry.id);
        assert.equal(result.ok, true, `${entry.id} 加载失败：${result.code ?? ''} ${result.message ?? ''}`);
        assert.equal(result.id, entry.id);
        assertUsableExports(result.exports, entry.id);
        assert.equal(loader.isLoaded(entry.id), true);
        assert.equal(loader.exportsOf(entry.id), result.exports, 'exportsOf 应返回同一份 exports');
      }

      assert.equal(installs.length, manifest.chunks.length, '每个分块应恰好执行一次');
      assert.deepEqual(loader.loadedIds(), [...declaredIds].sort());
    });

    await t.test('第二次 load 命中缓存、不重复 install', async () => {
      const { loader, installs, manifestReads } = createHarness({ rootDir: outDir, declaredIds, readSource: readerPort(reader) });
      const firstExports = new Map();
      for (const entry of manifest.chunks) {
        const result = await loader.load(entry.id);
        assert.equal(result.ok, true, `${entry.id} 首次加载失败：${result.code ?? ''} ${result.message ?? ''}`);
        firstExports.set(entry.id, result.exports);
      }
      const installedOnce = installs.length;
      const readsOnce = manifestReads();
      assert.equal(installedOnce, manifest.chunks.length);

      for (const entry of manifest.chunks) {
        const again = await loader.load(entry.id);
        assert.equal(again.ok, true);
        assert.equal(again.exports, firstExports.get(entry.id), `${entry.id} 第二次 load 应命中缓存并交回同一份 exports`);
      }
      assert.equal(installs.length, installedOnce, '第二次 load 不应再次 install');
      assert.equal(manifestReads(), readsOnce, '第二次 load 走缓存，不应再读清单');
    });

    await t.test('篡改产物：loader 拒绝执行，reader 报出与字节关系相符的失败码', async () => {
      const target = manifest.chunks.find((entry) => entry.id === 'drawings.techdraw') ?? manifest.chunks[0];
      assert.ok(target, '至少要有一个分块可篡改');
      const tamperedDir = join(workDir, 'tampered');
      await cp(outDir, tamperedDir, { recursive: true });
      const tamperedPath = join(tamperedDir, target.file);
      const original = await readFile(tamperedPath, 'utf8');

      // 同字节数篡改：字节数校验会通过，只有 sha256 能发现 —— 两边都必须是 HASH_MISMATCH。
      const marker = '__cadRegisterModuleChunk';
      assert.ok(original.includes(marker), '产物必须包含自注册标记');
      const sameLength = original.replace(marker, '__cadRegisterModuleChunK');
      assert.notEqual(sameLength, original, '夹具前提：内容必须真的变了');
      assert.equal(Buffer.byteLength(sameLength, 'utf8'), target.bytes, '夹具前提：字节数保持不变');
      assert.notEqual(chunkSha256(sameLength), target.sha256, '夹具前提：哈希必须真的变了');
      await writeFile(tamperedPath, sameLength, 'utf8');

      const tamperedReader = new ModuleChunkReader({ rootDir: tamperedDir });
      const read = tamperedReader.read(target.id);
      assert.equal(read.ok, false);
      assert.equal(read.code, 'CHUNK_HASH_MISMATCH', `字节数没变，reader 只应报哈希不符，实际是 ${read.code}`);

      const hashHarness = createHarness({ rootDir: tamperedDir, declaredIds, readSource: filePort(tamperedDir) });
      const hashResult = await hashHarness.loader.load(target.id);
      assert.equal(hashResult.ok, false);
      assert.equal(hashResult.code, 'CHUNK_HASH_MISMATCH', `loader 应拒绝哈希不符的分块，实际是 ${hashResult.code}`);
      assert.equal(hashHarness.installs.length, 0, '哈希不符时分块绝不能被执行');
      assert.equal(hashHarness.loader.isLoaded(target.id), false, '失败不能标记为已加载');

      // 追加字节篡改：字节数先不符，两边都应报 SIZE_MISMATCH，不需要再走到哈希。
      const grown = `${original}\n`;
      assert.notEqual(Buffer.byteLength(grown, 'utf8'), target.bytes, '夹具前提：字节数必须变化');
      await writeFile(tamperedPath, grown, 'utf8');
      const sizeRead = new ModuleChunkReader({ rootDir: tamperedDir }).read(target.id);
      assert.equal(sizeRead.ok, false);
      assert.equal(sizeRead.code, 'CHUNK_SIZE_MISMATCH', `字节数不符时 reader 应报 SIZE，实际是 ${sizeRead.code}`);

      const sizeHarness = createHarness({ rootDir: tamperedDir, declaredIds, readSource: filePort(tamperedDir) });
      const sizeResult = await sizeHarness.loader.load(target.id);
      assert.equal(sizeResult.ok, false);
      assert.equal(sizeResult.code, 'CHUNK_SIZE_MISMATCH', `字节数不符时 loader 应报 SIZE，实际是 ${sizeResult.code}`);
      assert.equal(sizeHarness.installs.length, 0, '字节数不符时分块绝不能被执行');
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
