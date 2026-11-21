import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const actualBuiltin = resolve(here, '../../../packs/builtin');
let sandbox;
let builtinDir;
let userDir;
let stateFile;

const ALPHA_PARTS = [
  { id: 'A1', model: 'A1', category: '气缸', specs: { 缸径: '20 mm' } },
  { id: 'SHARED', model: 'SHARED', category: '气缸', specs: { 来源: 'alpha' } }
];
const BETA_PARTS = [
  { id: 'B1', model: 'B1', category: '传感器', specs: { 类型: '磁性开关' } },
  { id: 'SHARED', model: 'SHARED', category: '传感器', specs: { 来源: 'beta' } }
];

function manifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    name: `${id} 演示包`,
    vendor: '测试厂商',
    version: '1.0.0',
    license: '测试数据',
    description: '懒加载单元测试',
    categories: ['气缸', '传感器'],
    partsCount: 2,
    ...overrides
  };
}

function writePack(root, id, options = {}) {
  const dir = join(root, id);
  const parts = options.parts ?? ALPHA_PARTS;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), options.manifestRaw ?? JSON.stringify(manifest(id, {
    partsCount: options.partsCount ?? parts.length,
    ...(options.categories ? { categories: options.categories } : {}),
    ...(options.manifestOverrides ?? {})
  }), null, 2));
  writeFileSync(join(dir, 'parts.json'), options.partsRaw ?? JSON.stringify(parts, null, 2));
  return dir;
}

function countingRegistry() {
  const reads = [];
  const registry = new PackRegistry({
    builtinDir,
    userDir,
    stateFile,
    readTextFile: (path) => {
      reads.push(path);
      return readFileSync(path, 'utf8');
    }
  });
  return {
    registry,
    reads,
    partsReads: () => reads.filter((path) => path.endsWith('parts.json')).length,
    manifestReads: () => reads.filter((path) => path.endsWith('manifest.json')).length
  };
}

function realRegistry() {
  return new PackRegistry({ builtinDir: actualBuiltin, userDir, stateFile });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-pack-lazy-'));
  builtinDir = join(sandbox, 'builtin');
  userDir = join(sandbox, 'user', 'packs');
  stateFile = join(sandbox, 'user', 'packs-state.json');
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('scan 只读 manifest，不读 parts.json', async () => {
  writePack(builtinDir, 'alpha-pack', { categories: ['气缸'] });
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const counter = countingRegistry();
  const packs = await counter.registry.scan();
  assert.equal(packs.length, 2);
  assert.equal(packs.find((pack) => pack.id === 'alpha-pack').partCount, 2);
  assert.equal(counter.manifestReads(), 2);
  assert.equal(counter.partsReads(), 0);
});

test('默认读取路径可用 fs.readFileSync spy 断言 parts 读取次数', async () => {
  writePack(builtinDir, 'alpha-pack');
  const original = fs.readFileSync;
  let partsReads = 0;
  fs.readFileSync = (path, ...args) => {
    if (String(path).endsWith('parts.json')) partsReads += 1;
    return original(path, ...args);
  };
  try {
    const registry = new PackRegistry({ builtinDir, userDir, stateFile });
    await registry.scan();
    assert.equal(partsReads, 0);
    registry.listParts({ packId: 'alpha-pack' });
    assert.equal(partsReads, 1);
    registry.listParts({ packId: 'alpha-pack' });
    assert.equal(partsReads, 1);
  } finally {
    fs.readFileSync = original;
  }
});

test('重复文本搜索复用规范化文本缓存，卸载后从新包内容重建', () => {
  writePack(builtinDir, 'alpha-pack', { parts: [
    { id: 'A1', model: '导轨A1', category: '导轨', vendor: '测试厂商', specs: { 型号说明: '精密滑块' } }
  ], categories: ['导轨'] });
  const counter = countingRegistry();
  const first = counter.registry.listParts({ q: '精密滑块' });
  assert.deepEqual(first.map(part => part.id), ['A1']);
  assert.deepEqual(counter.registry.listParts({ q: '导轨a1' }).map(part => part.id), ['A1']);
  assert.equal(counter.partsReads(), 1);

  writeFileSync(join(builtinDir, 'alpha-pack', 'parts.json'), JSON.stringify([
    { id: 'A2', model: 'NEW-A2', category: '导轨', vendor: '测试厂商', specs: { 型号说明: '新型滑块' } }
  ]));
  assert.equal(counter.registry.unloadPack('alpha-pack'), true);
  assert.deepEqual(counter.registry.listParts({ q: '新型滑块' }).map(part => part.id), ['A2']);
  assert.deepEqual(counter.registry.listParts({ q: '精密滑块' }), []);
  assert.equal(counter.partsReads(), 2);
});

test('首次 listParts 才按需读取 parts.json', async () => {
  writePack(builtinDir, 'alpha-pack');
  const counter = countingRegistry();
  await counter.registry.scan();
  assert.equal(counter.partsReads(), 0);
  assert.equal(counter.registry.listParts({ category: '气缸' }).length, 2);
  assert.equal(counter.partsReads(), 1);
  assert.equal(counter.registry.isPackLoaded('alpha-pack'), true);
});

test('重复搜索命中内存缓存，不重复读文件', () => {
  writePack(builtinDir, 'alpha-pack');
  const counter = countingRegistry();
  counter.registry.listParts({ q: 'alpha' });
  counter.registry.listParts({ q: 'A1' });
  counter.registry.listParts({ packId: 'alpha-pack' });
  assert.equal(counter.partsReads(), 1);
  assert.equal(counter.registry.metrics().loadedPacks, 1);
});

test('loadPack 可显式加载，unloadPack 释放后重新加载', () => {
  writePack(builtinDir, 'alpha-pack');
  const counter = countingRegistry();
  const info = counter.registry.loadPack('alpha-pack');
  assert.equal(info.partCount, 2);
  assert.equal(counter.registry.isPackLoaded('alpha-pack'), true);
  assert.equal(counter.registry.unloadPack('alpha-pack'), true);
  assert.equal(counter.registry.unloadPack('alpha-pack'), false);
  assert.equal(counter.registry.isPackLoaded('alpha-pack'), false);
  assert.equal(counter.partsReads(), 1);
  counter.registry.loadPack('alpha-pack');
  assert.equal(counter.partsReads(), 2);
});

test('unload 不影响 manifest 索引，后续 scan 不再读 manifest', async () => {
  writePack(builtinDir, 'alpha-pack');
  const counter = countingRegistry();
  await counter.registry.scan();
  counter.registry.loadPack('alpha-pack');
  const manifestReads = counter.manifestReads();
  counter.registry.unloadPack('alpha-pack');
  const packs = await counter.registry.scan();
  assert.equal(packs.length, 1);
  assert.equal(counter.manifestReads(), manifestReads);
});

test('loadedPacks 与 partsLoaded 指标反映缓存状态', () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  assert.deepEqual(
    { loaded: registry.metrics().loadedPacks, parts: registry.metrics().partsLoaded },
    { loaded: 0, parts: 0 }
  );
  registry.listParts({ packId: 'alpha-pack' });
  assert.deepEqual(
    { loaded: registry.metrics().loadedPacks, parts: registry.metrics().partsLoaded },
    { loaded: 1, parts: 2 }
  );
  registry.listParts({ packId: 'beta-pack' });
  assert.deepEqual(
    { loaded: registry.metrics().loadedPacks, parts: registry.metrics().partsLoaded },
    { loaded: 2, parts: 4 }
  );
});

test('packLoadMs 与 searchMs 为可观测的非负指标', () => {
  writePack(builtinDir, 'alpha-pack');
  const registry = countingRegistry().registry;
  registry.listParts({ packId: 'alpha-pack' });
  const metrics = registry.metrics();
  assert.ok(metrics.packLoadMs >= 0);
  assert.ok(metrics.searchMs >= 0);
  assert.equal(metrics.packCount, 1);
});

test('manifest 命中不妨碍搜索其他包的型号和规格', () => {
  writePack(builtinDir, 'alpha-pack', {
    parts: [{ ...ALPHA_PARTS[0], model: 'beta-pack-model' }, { ...ALPHA_PARTS[1], specs: { 来源: 'beta-pack' } }]
  });
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const q = 'beta-pack';
  const fullScan = countingRegistry().registry.listParts().filter((part) => [
    part.id, part.model, part.category, part.vendor ?? '', part.packId, part.packName,
    ...Object.values(part.specs)
  ].join(' ').toLocaleLowerCase('zh-CN').includes(q));
  const parts = countingRegistry().registry.listParts({ q });
  assert.deepEqual(parts, fullScan);
  assert.deepEqual(parts.map((part) => [part.id, part.packId]), [
    ['A1', 'alpha-pack'], ['SHARED', 'alpha-pack'], ['B1', 'beta-pack']
  ]);
});

test('分类过滤先按 manifest.categories 排除未命中包', () => {
  writePack(builtinDir, 'alpha-pack', { categories: ['气缸'] });
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const counter = countingRegistry();
  const parts = counter.registry.listParts({ category: '传感器' });
  assert.equal(parts.length, 2);
  assert.deepEqual(counter.registry.loadedPackIds(), ['beta-pack']);
  assert.equal(counter.partsReads(), 1);
});

test('packId 过滤只读取指定包', () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const counter = countingRegistry();
  assert.equal(counter.registry.listParts({ packId: 'alpha-pack' }).length, 2);
  assert.deepEqual(counter.registry.loadedPackIds(), ['alpha-pack']);
});

test('跨包同 id 只返回一次且优先内置包', () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(userDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  const parts = registry.listParts();
  assert.equal(parts.filter((part) => part.id === 'SHARED').length, 1);
  assert.equal(parts.find((part) => part.id === 'SHARED').packId, 'alpha-pack');
  assert.equal(parts.length, 3);
});

test('禁用并卸载内置包后用户包可补位同 id 条目', async () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(userDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  registry.listParts();
  await registry.setEnabled('alpha-pack', false);
  registry.unloadPack('alpha-pack');
  const parts = registry.listParts();
  assert.equal(parts.find((part) => part.id === 'SHARED').packId, 'beta-pack');
});

test('getPartById 懒建全局索引', () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(userDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const counter = countingRegistry();
  assert.equal(counter.partsReads(), 0);
  assert.equal(counter.registry.getPartIndexSize(), 0);
  assert.equal(counter.registry.getPartById('B1').packId, 'beta-pack');
  assert.equal(counter.registry.metrics().loadedPacks, 2);
  assert.equal(counter.registry.getPartIndexSize(), 3);
  assert.equal(counter.registry.getPartById('missing'), undefined);
});

test('全局索引中的重复 id 保留内置包', () => {
  writePack(builtinDir, 'alpha-pack');
  writePack(userDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  assert.equal(registry.getPartById('SHARED').packId, 'alpha-pack');
  assert.equal(registry.getPartIndexSize(), 3);
});

test('unload 会使全局索引失效，再次查询重建', () => {
  writePack(builtinDir, 'alpha-pack');
  const registry = countingRegistry().registry;
  registry.getPartById('A1');
  assert.equal(registry.getPartIndexSize(), 2);
  registry.unloadPack('alpha-pack');
  assert.equal(registry.getPartIndexSize(), 0);
  assert.equal(registry.getPartById('A1').packId, 'alpha-pack');
  assert.equal(registry.getPartIndexSize(), 2);
});

test('manifest 缺 categories 时拒绝该包且不读 parts', async () => {
  const bad = manifest('alpha-pack');
  delete bad.categories;
  writePack(builtinDir, 'alpha-pack', { manifestRaw: JSON.stringify(bad) });
  const counter = countingRegistry();
  const packs = await counter.registry.scan();
  assert.match(packs[0].error, /categories/);
  assert.equal(counter.registry.listParts().length, 0);
  assert.equal(counter.partsReads(), 0);
});

test('manifest 的 partsCount 非法时拒绝该包', async () => {
  writePack(builtinDir, 'alpha-pack', { partsCount: -1 });
  const registry = countingRegistry().registry;
  const packs = await registry.scan();
  assert.match(packs[0].error, /partsCount/);
});

test('坏 JSON manifest 被拒绝且不影响其他包', async () => {
  writePack(builtinDir, 'alpha-pack', { manifestRaw: '{ bad json' });
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  const packs = await registry.scan();
  assert.equal(packs.length, 2);
  assert.match(packs.find((pack) => pack.id === 'alpha-pack').error, /JSON/);
  assert.equal(registry.listParts().length, 2);
});

test('坏 parts.json 被标记 error，其他包继续可用', async () => {
  writePack(builtinDir, 'alpha-pack', { partsRaw: '{ bad parts' });
  writePack(builtinDir, 'beta-pack', { parts: BETA_PARTS, categories: ['传感器'] });
  const registry = countingRegistry().registry;
  assert.equal(registry.listParts().length, 2);
  const packs = await registry.scan();
  assert.match(packs.find((pack) => pack.id === 'alpha-pack').error, /JSON/);
  assert.equal(registry.isPackLoaded('alpha-pack'), false);
});

test('partsCount 与实际条目不一致时，加载后以实际值为准', async () => {
  writePack(builtinDir, 'alpha-pack', { partsCount: 1 });
  const registry = countingRegistry().registry;
  assert.equal((await registry.scan())[0].partCount, 1);
  assert.equal(registry.loadPack('alpha-pack').partCount, 2);
  assert.equal((await registry.scan())[0].partCount, 2);
});

test('dims.source 与 estimated 透传到条目', () => {
  const parts = [{
    id: 'D1', model: 'D1', category: '传感器', specs: {},
    dims: { w: 10, h: 20, d: 30, source: '厂商数据表 官方', estimated: true }
  }];
  writePack(builtinDir, 'alpha-pack', { parts, categories: ['传感器'] });
  const [part] = countingRegistry().registry.listParts();
  assert.equal(part.dims.source, '厂商数据表 官方');
  assert.equal(part.dims.estimated, true);
});

test('单个内置包 parts.json 不超过 400 KB', () => {
  for (const id of ['iec-cn', 'smc-cn', 'servo-cn', 'sensor-cn', 'pneumatic-cn', 'vision-cn', 'drive-cn', 'safety-cn', 'frame-cn']) {
    const bytes = statSync(join(actualBuiltin, id, 'parts.json')).size;
    assert.ok(bytes <= 400 * 1024, `${id} 超过 400 KB：${bytes}`);
  }
});

test('新增包容量下限：servo 24 / sensor 30 / pneumatic 24', () => {
  const registry = realRegistry();
  assert.ok(registry.listParts({ packId: 'servo-cn' }).length >= 24);
  assert.ok(registry.listParts({ packId: 'sensor-cn' }).length >= 30);
  assert.ok(registry.listParts({ packId: 'pneumatic-cn' }).length >= 24);
});

test('新增三个包的 id 全局唯一', () => {
  const seen = new Map();
  for (const id of ['servo-cn', 'sensor-cn', 'pneumatic-cn']) {
    const parts = JSON.parse(readFileSync(join(actualBuiltin, id, 'parts.json'), 'utf8'));
    for (const part of parts) {
      assert.equal(seen.has(part.id), false, `${part.id} 冲突：${seen.get(part.id)} / ${id}`);
      seen.set(part.id, id);
    }
  }
});

test('伺服包字段完整且尺寸带 source', () => {
  const parts = JSON.parse(readFileSync(join(actualBuiltin, 'servo-cn', 'parts.json'), 'utf8'));
  for (const part of parts) {
    for (const key of ['ratedW', 'voltage', 'encoder', 'flange', 'brake', '数据来源']) {
      assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 ${key}`);
    }
    if (part.dims) assert.ok(part.dims.source, `${part.id} dims 缺 source`);
  }
});

test('传感器包字段完整且尺寸带 source', () => {
  const parts = JSON.parse(readFileSync(join(actualBuiltin, 'sensor-cn', 'parts.json'), 'utf8'));
  for (const part of parts) {
    for (const key of ['type', 'sensing', 'voltage', 'output', 'range', 'connection', '数据来源']) {
      assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 ${key}`);
    }
    if (part.dims) assert.ok(part.dims.source, `${part.id} dims 缺 source`);
  }
});

test('气动包字段完整且尺寸带 source', () => {
  const parts = JSON.parse(readFileSync(join(actualBuiltin, 'pneumatic-cn', 'parts.json'), 'utf8'));
  for (const part of parts) {
    for (const key of ['bore', 'stroke', 'action', 'voltage', 'port', '数据来源']) {
      assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 ${key}`);
    }
    if (part.dims) assert.ok(part.dims.source, `${part.id} dims 缺 source`);
  }
});

test('manifest 分类与包内实际分类一致', () => {
  for (const id of ['servo-cn', 'sensor-cn', 'pneumatic-cn']) {
    const manifestValue = JSON.parse(readFileSync(join(actualBuiltin, id, 'manifest.json'), 'utf8'));
    const parts = JSON.parse(readFileSync(join(actualBuiltin, id, 'parts.json'), 'utf8'));
    const actual = [...new Set(parts.map((part) => part.category))].sort();
    assert.deepEqual([...manifestValue.categories].sort(), actual, `${id} 分类不一致`);
    assert.equal(manifestValue.partsCount, parts.length, `${id} partsCount 不一致`);
    for (const key of ['id', 'name', 'version', 'vendor', 'license', 'description', 'partsCount', 'categories']) {
      assert.ok(Object.hasOwn(manifestValue, key), `${id} manifest 缺少 ${key}`);
    }
  }
});

test('所有新增分类都归入既有分类', () => {
  const allowed = new Set(['伺服', '步进', '传感器', '气缸', '气爪', '电磁阀', '气源处理', '气动接头']);
  for (const id of ['servo-cn', 'sensor-cn', 'pneumatic-cn']) {
    const parts = JSON.parse(readFileSync(join(actualBuiltin, id, 'parts.json'), 'utf8'));
    for (const part of parts) assert.ok(allowed.has(part.category), `${part.id} 分类非法：${part.category}`);
  }
});

test('冷启动到可搜索不超过 120 ms', async () => {
  const registry = realRegistry();
  const startedAt = performance.now();
  await registry.scan();
  const parts = registry.listParts({ q: '伺服' });
  const coldMs = performance.now() - startedAt;
  assert.ok(parts.length > 0);
  assert.ok(coldMs <= 120, `冷启动 ${coldMs.toFixed(1)} ms > 120 ms`);
});

test('10 个包全量命中搜索不超过 25 ms', () => {
  const registry = realRegistry();
  registry.listParts();
  const startedAt = performance.now();
  const parts = registry.listParts();
  const searchMs = performance.now() - startedAt;
  assert.ok(parts.length >= 600);
  assert.ok(searchMs <= 25, `全量搜索 ${searchMs.toFixed(1)} ms > 25 ms`);
});
