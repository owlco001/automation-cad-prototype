// 分块构建产物的行为断言：清单来自实际产物、哈希可校验、分块真的能自注册执行。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks, chunkFileName, DEFAULT_CONFIG_PATH, validateChunkConfig } from '../../scripts/build-module-chunks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '../..');
const probeConfig = resolve(desktopRoot, 'test-support/module-chunk-probe.config.json');

const tempDir = async () => await mkdtemp(join(tmpdir(), 'cad-chunks-'));

test('生产配置默认为空且合法（不能把探针/测试分块发出去）', async () => {
  const outDir = await tempDir();
  try {
    const result = await buildChunks({
      configPath: DEFAULT_CONFIG_PATH, outDir, root: desktopRoot,
      registry: MODULE_REGISTRY, moduleApiVersion: MODULE_API_VERSION
    });
    assert.deepEqual(result.manifest.chunks, []);
    const written = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(written.chunks, []);
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.moduleApiVersion, MODULE_API_VERSION);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('构建产出真实分块：清单哈希=文件哈希，且分块能自注册并执行', async () => {
  const outDir = await tempDir();
  try {
    const result = await buildChunks({
      configPath: probeConfig, outDir, root: desktopRoot,
      registry: MODULE_REGISTRY, moduleApiVersion: MODULE_API_VERSION
    });
    assert.equal(result.manifest.chunks.length, 1);
    const entry = result.manifest.chunks[0];
    assert.equal(entry.id, 'agent.resume');
    assert.equal(entry.file, chunkFileName('agent.resume'));

    const bytes = await readFile(join(outDir, entry.file));
    assert.equal(bytes.byteLength, entry.bytes, '清单字节数必须等于实际产物');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, '清单哈希必须等于实际产物');

    // 用最小宿主执行：分块必须主动调用 __cadRegisterModuleChunk，并把默认导出交出来
    const registrations = [];
    const sandbox = { __cadRegisterModuleChunk: (payload) => registrations.push(payload) };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(bytes.toString('utf8'), sandbox);
    assert.equal(registrations.length, 1, '分块必须自注册一次');
    assert.equal(registrations[0].id, 'agent.resume');
    assert.equal(registrations[0].apiVersion, MODULE_API_VERSION);
    assert.equal(registrations[0].exports.ping(1), 2, 'exports 应该可用');

    // 分块不应该把自己的 globalName 留在全局（避免污染渲染层）
    assert.equal(Object.keys(sandbox).filter((key) => key.startsWith('__cadChunk_')).length, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('配置校验：未知模块 / 核心模块 / 未实现模块 / 非法入口一律拒绝', () => {
  const registry = [
    { id: 'core', kind: 'core', implemented: true, apiCompatibility: { min: 1, max: 1 } },
    { id: 'opt', kind: 'optional', implemented: true, apiCompatibility: { min: 1, max: 1 } },
    { id: 'todo', kind: 'optional', implemented: false, apiCompatibility: { min: 1, max: 1 } }
  ];
  assert.equal(validateChunkConfig({ schemaVersion: 1, chunks: { opt: 'a.ts' } }, registry).length, 1);
  for (const [label, config] of [
    ['未知模块', { schemaVersion: 1, chunks: { nope: 'a.ts' } }],
    ['核心模块', { schemaVersion: 1, chunks: { core: 'a.ts' } }],
    ['未实现模块', { schemaVersion: 1, chunks: { todo: 'a.ts' } }],
    ['空入口', { schemaVersion: 1, chunks: { opt: '  ' } }],
    ['版本不符', { schemaVersion: 2, chunks: {} }],
    ['chunks 不是对象', { schemaVersion: 1, chunks: [] }]
  ]) {
    assert.throws(() => validateChunkConfig(config, registry), undefined, label);
  }
});

test('模块 id 不能当文件名以外的路径使用', () => {
  assert.throws(() => chunkFileName('../evil'));
  assert.throws(() => chunkFileName('a/b'));
  assert.equal(chunkFileName('cost.estimation'), 'cost.estimation.js');
});
