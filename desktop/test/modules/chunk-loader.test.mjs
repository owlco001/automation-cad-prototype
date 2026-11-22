// 分块加载器：先白名单与状态检查，再哈希校验，最后才执行；失败不缓存。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ModuleChunkLoader } from '../../src/modules/chunk-loader.ts';

const sha256 = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const bytesOf = (text) => new TextEncoder().encode(text).length;

/** 一个「合法分块源码」的替身：install 时按约定回调注册。 */
function fakeChunk(id, exportsValue, { apiVersion = 1 } = {}) {
  return `(function(){__register(${JSON.stringify({ id, apiVersion, exports: exportsValue })})})();`;
}

function makeLoader(overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    moduleApiVersion: 1,
    chunks: [
      { id: 'cost.estimation', apiCompatibility: { min: 1, max: 1 }, file: 'cost.estimation.js', bytes: 0, sha256: '0'.repeat(64) },
      { id: 'drawings.techdraw', apiCompatibility: { min: 1, max: 1 }, file: 'drawings.techdraw.js', bytes: 0, sha256: '0'.repeat(64) }
    ]
  };
  const sources = {
    'cost.estimation': fakeChunk('cost.estimation', { report: 'ok' }),
    'drawings.techdraw': fakeChunk('drawings.techdraw', { draw: 'ok' })
  };
  // 把清单里的字节数/哈希补成真实值（测试里用同一份源码计算）
  for (const entry of manifest.chunks) {
    const source = sources[entry.id];
    entry.bytes = bytesOf(source);
    entry.sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  }
  const state = {
    cost: { enabled: true, dependencies: ['core'] },
    drawings: { enabled: true, dependencies: ['core', 'cad.parametric-import'] }
  };
  const installed = [];
  const deps = {
    readManifest: async () => JSON.parse(JSON.stringify(manifest)),
    readSource: async (entry) => {
      const source = sources[entry.id];
      if (source === undefined) throw new Error('missing');
      return source;
    },
    install: (source, onRegister) => {
      installed.push(source);
      // 用最小解释器执行替身源码：只认 __register(payload) 约定
      const register = (payload) => onRegister(payload);
      new Function('__register', source)(register);
    },
    sha256,
    hostApiVersion: 1,
    moduleState: (id) => {
      if (id === 'cost.estimation') return state.cost;
      if (id === 'drawings.techdraw') return state.drawings;
      if (id === 'plcgen') return state.plcgen ?? null;
      return null;
    },
    isEnabled: (id) => id === 'core' || id === 'cad.parametric-import',
    ...overrides
  };
  return { loader: new ModuleChunkLoader(deps), manifest, sources, state, installed, deps };
}

test('加载成功：返回 exports，且只执行一次', async () => {
  const { loader, installed } = makeLoader();
  const first = await loader.load('cost.estimation');
  assert.equal(first.ok, true);
  assert.deepEqual(first.exports, { report: 'ok' });
  assert.equal(loader.isLoaded('cost.estimation'), true);
  assert.deepEqual(loader.loadedIds(), ['cost.estimation']);
  const second = await loader.load('cost.estimation');
  assert.equal(second.ok, true);
  assert.equal(installed.length, 1, '重复调用不应再次执行分块');
});

test('未知模块 / 未声明分块 / 模块关闭 都在执行前拒绝', async () => {
  const { loader, installed, state } = makeLoader();
  assert.equal((await loader.load('not.a.module')).code, 'MODULE_UNKNOWN');

  // 注册表里存在、但没有随包分块的模块：不能退化成"随便找个文件跑"
  state.plcgen = { enabled: true, dependencies: ['core'] };
  assert.equal((await loader.load('plcgen')).code, 'CHUNK_NOT_DECLARED');

  state.cost.enabled = false;
  assert.equal((await loader.load('cost.estimation')).code, 'MODULE_DISABLED');
  state.cost.enabled = true;

  assert.equal(installed.length, 0, '任何拒绝都不应执行分块');
});

test('依赖未启用时拒绝，并点名缺哪个依赖', async () => {
  const { loader, installed } = makeLoader({ isEnabled: (id) => id === 'core' });
  const result = await loader.load('drawings.techdraw');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEPENDENCY_DISABLED');
  assert.match(result.message, /cad\.parametric-import/);
  assert.equal(installed.length, 0);
});

test('清单不可用/版本不符时拒绝，且不执行分块', async () => {
  const broken = makeLoader({ readManifest: async () => ({ schemaVersion: 99 }) });
  const result = await broken.loader.load('cost.estimation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHUNK_MANIFEST_UNAVAILABLE');
  assert.equal(broken.installed.length, 0);

  const throwing = makeLoader({ readManifest: async () => { throw new Error('EACCES'); } });
  assert.equal((await throwing.loader.load('cost.estimation')).code, 'CHUNK_MANIFEST_UNAVAILABLE');
});

test('字节数或哈希不符时拒绝执行，并且失败不缓存（修好后可重试）', async () => {
  const mismatch = makeLoader();
  const entry = mismatch.manifest.chunks[0];
  entry.sha256 = 'f'.repeat(64);
  const failed = await mismatch.loader.load('cost.estimation');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'CHUNK_HASH_MISMATCH');
  assert.equal(mismatch.installed.length, 0);
  assert.equal(mismatch.loader.isLoaded('cost.estimation'), false, '失败不能标记为已加载');
});

test('API 区间不兼容时拒绝', async () => {
  const { loader, installed } = makeLoader({ hostApiVersion: 2 });
  const result = await loader.load('cost.estimation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODULE_API_INCOMPATIBLE');
  assert.equal(installed.length, 0);
});

test('分块自称的 id/版本与清单不符时拒绝，且不缓存', async () => {
  const lying = makeLoader();
  lying.sources['cost.estimation'] = fakeChunk('plcgen', { report: 'ok' });
  const entry = lying.manifest.chunks[0];
  entry.bytes = bytesOf(lying.sources['cost.estimation']);
  entry.sha256 = createHash('sha256').update(lying.sources['cost.estimation'], 'utf8').digest('hex');
  const result = await lying.loader.load('cost.estimation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHUNK_REGISTRATION_INVALID');
  assert.equal(lying.loader.isLoaded('cost.estimation'), false);
});

test('分块不注册或执行抛错时给出明确失败码', async () => {
  const silent = makeLoader();
  silent.sources['cost.estimation'] = '/* 什么都不做 */';
  const entry = silent.manifest.chunks[0];
  entry.bytes = bytesOf(silent.sources['cost.estimation']);
  entry.sha256 = createHash('sha256').update(silent.sources['cost.estimation'], 'utf8').digest('hex');
  assert.equal((await silent.loader.load('cost.estimation')).code, 'CHUNK_REGISTRATION_INVALID');

  const throwing = makeLoader({ install: () => { throw new Error('boom'); } });
  const thrown = await throwing.loader.load('cost.estimation');
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'CHUNK_INSTALL_FAILED');
  assert.match(thrown.message, /boom/);
});

test('同一 id 并发加载只执行一次（单飞）', async () => {
  const { loader, installed } = makeLoader();
  const results = await Promise.all([
    loader.load('cost.estimation'),
    loader.load('cost.estimation'),
    loader.load('cost.estimation')
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(installed.length, 1);
});
