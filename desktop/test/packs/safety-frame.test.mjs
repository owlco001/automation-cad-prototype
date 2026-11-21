import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = resolve(here, '../../../packs/builtin');
const PARTS_PACKS = [
  'iec-cn', 'smc-cn', 'servo-cn', 'sensor-cn', 'pneumatic-cn',
  'vision-cn', 'drive-cn', 'safety-cn', 'frame-cn'
];
const SAFETY_TYPES = new Set(['curtain', 'relay', 'interlock', 'estop', 'plc']);
const FRAME_TYPES = new Set(['profile', 'bracket', 'panel', 'caster', 'foot', 'door', 'conveyor']);
const SAFETY_REQUIRED = ['type', 'pl', 'category', 'responseTimeMs', 'channels', 'voltage', '数据来源'];
const FRAME_REQUIRED = ['type', 'section', 'slot', 'weightPerMeter', 'inertia', 'loadRating', 'length', '数据来源'];
const INERTIA_UNIT = /cm⁴/;

let sandbox;
let userDir;
let stateFile;

function readPack(id) {
  return JSON.parse(readFileSync(join(builtinDir, id, 'parts.json'), 'utf8'));
}
function readManifest(id) {
  return JSON.parse(readFileSync(join(builtinDir, id, 'manifest.json'), 'utf8'));
}
function registry(options = {}) {
  return new PackRegistry({ builtinDir, userDir, stateFile, ...options });
}

const safety = readPack('safety-cn');
const frame = readPack('frame-cn');
const safetyCatalog = safety.filter((part) => !part.aliasOf);
const frameCatalog = frame.filter((part) => !part.aliasOf);
const allParts = PARTS_PACKS.flatMap((id) => readPack(id));

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-safety-frame-'));
  userDir = join(sandbox, 'packs');
  stateFile = join(sandbox, 'packs-state.json');
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('safety-cn 容量下限 ≥24 且覆盖 curtain/relay/interlock/estop/plc', () => {
  assert.ok(safetyCatalog.length >= 24, `safety-cn 仅 ${safetyCatalog.length} 条实型号`);
  const types = new Set(safetyCatalog.map((part) => part.specs.type));
  for (const type of SAFETY_TYPES) assert.ok(types.has(type), `缺少 type=${type}`);
});

test('frame-cn 容量下限 ≥26 且覆盖 profile/bracket/panel/caster/foot/door/conveyor', () => {
  assert.ok(frameCatalog.length >= 26, `frame-cn 仅 ${frameCatalog.length} 条`);
  const types = new Set(frameCatalog.map((part) => part.specs.type));
  for (const type of FRAME_TYPES) assert.ok(types.has(type), `缺少 type=${type}`);
});

test('safety-cn manifest 条目数、分类与版本一致', () => {
  const manifest = readManifest('safety-cn');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'safety-cn');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.partsCount, safety.length);
  assert.deepEqual([...manifest.categories].sort(), [...new Set(safety.map((part) => part.category))].sort());
  for (const key of ['name', 'vendor', 'license', 'description']) assert.ok(manifest[key], `缺少 manifest.${key}`);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test('frame-cn manifest 条目数、分类与版本一致', () => {
  const manifest = readManifest('frame-cn');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'frame-cn');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.partsCount, frame.length);
  assert.deepEqual([...manifest.categories].sort(), [...new Set(frame.map((part) => part.category))].sort());
  for (const key of ['name', 'vendor', 'license', 'description']) assert.ok(manifest[key], `缺少 manifest.${key}`);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test('safety-cn 实型号字段完整：PL/Cat/响应时间/通道/电压/尺寸', () => {
  for (const part of safetyCatalog) {
    assert.ok(SAFETY_TYPES.has(part.specs.type), `${part.id} type 非法：${part.specs.type}`);
    for (const key of SAFETY_REQUIRED) assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 specs.${key}`);
    assert.match(part.specs.pl, /^PL [cde]$/, `${part.id} pl 非法`);
    assert.match(part.specs.category, /^Cat [1-4]$/, `${part.id} category 非法`);
    assert.ok(Number.isFinite(part.specs.responseTimeMs) && part.specs.responseTimeMs > 0, `${part.id} responseTimeMs 非法`);
    assert.ok(Number.isInteger(part.specs.channels) && part.specs.channels > 0, `${part.id} channels 非法`);
    assert.match(part.specs.voltage, /V /, `${part.id} voltage 非法`);
    assert.ok(part.dims, `${part.id} 缺少 dims`);
    assert.ok(part.dims.source, `${part.id} dims 缺 source`);
    for (const axis of ['w', 'h', 'd']) assert.ok(part.dims[axis] > 0, `${part.id} dims.${axis} 非法`);
    assert.match(part.specs.数据来源, /官方/, `${part.id} 数据来源未标注官方`);
  }
});

test('frame-cn 字段完整：type/section/slot/米重/惯性矩/承载/length/dims', () => {
  for (const part of frameCatalog) {
    assert.ok(FRAME_TYPES.has(part.specs.type), `${part.id} type 非法：${part.specs.type}`);
    for (const key of FRAME_REQUIRED) assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 specs.${key}`);
    assert.equal(typeof part.specs.section, 'string');
    assert.ok(part.specs.section.length > 0, `${part.id} section 为空`);
    assert.ok(part.specs.slot === '' || Number.isInteger(part.specs.slot), `${part.id} slot 非法`);
    assert.ok(part.dims, `${part.id} 缺少 dims`);
    assert.ok(part.dims.source, `${part.id} dims 缺 source`);
    for (const axis of ['w', 'h', 'd']) assert.ok(part.dims[axis] > 0, `${part.id} dims.${axis} 非法`);
    assert.equal(typeof part.specs.数据来源, 'string', `${part.id} 缺少数据来源`);
  }
});

test('铝型材米重 kg/m 与惯性矩 cm⁴ 单位统一，且有厂商技术页出处', () => {
  const profiles = frameCatalog.filter((part) => part.specs.type === 'profile');
  assert.equal(profiles.length, 5);
  for (const part of profiles) {
    assert.ok(Number.isFinite(part.specs.weightPerMeter) && part.specs.weightPerMeter > 0, `${part.id} 米重非法`);
    assert.match(part.specs.inertia, INERTIA_UNIT, `${part.id} 惯性矩单位不是 cm⁴`);
    assert.match(part.specs.inertia, /Ix [\d.]+ \/ Iy [\d.]+ cm⁴/, `${part.id} 惯性矩格式非法`);
    assert.equal(part.specs.length, 6000);
    assert.match(part.specs.数据来源, /官方/);
    assert.notEqual(part.specs.数据来源, '未核实');
  }
});

test('脚轮/地脚承载为 kg 数值且覆盖 100/300/600 等级', () => {
  const support = frameCatalog.filter((part) => ['caster', 'foot'].includes(part.specs.type));
  for (const part of support) {
    assert.ok(Number.isFinite(part.specs.loadRating) && part.specs.loadRating > 0, `${part.id} 承载非法`);
    assert.match(part.specs.数据来源, /官方/);
  }
  const ratings = support.map((part) => part.specs.loadRating);
  for (const rating of [100, 300, 600]) assert.ok(ratings.includes(rating), `缺少 ${rating} kg 档`);
});

test('查不到的结构参数留空且数据来源标注未核实', () => {
  for (const part of frameCatalog) {
    if (part.specs.type === 'profile') continue;
    const blank = ['weightPerMeter', 'inertia', 'loadRating'].filter((key) => part.specs[key] === '');
    if (blank.length > 0) {
      assert.match(part.specs.数据来源, /未核实/, `${part.id} 留空字段未标注未核实：${blank.join(',')}`);
    }
  }
});

test('跨 10 包 id 全局唯一（含 alias）', () => {
  const seen = new Map();
  for (const id of PARTS_PACKS) {
    for (const part of readPack(id)) {
      assert.equal(seen.has(part.id), false, `${part.id} 冲突：${seen.get(part.id)} / ${id}`);
      seen.set(part.id, id);
    }
  }
  assert.equal(seen.size, allParts.length);
  assert.equal(seen.size, 617);
});

test('非 alias 型号跨包不重复', () => {
  const seen = new Map();
  for (const id of PARTS_PACKS) {
    for (const part of readPack(id)) {
      if (part.aliasOf) continue;
      assert.equal(seen.has(part.model), false, `${part.model} 重复：${seen.get(part.model)} / ${id}`);
      seen.set(part.model, id);
    }
  }
  assert.equal(seen.size, 612);
});

test('aliasOf 目标存在且无自指/环，alias 不进入列表', () => {
  const byId = new Map(allParts.map((part) => [part.id, part]));
  let aliasCount = 0;
  for (const part of allParts.filter((item) => item.aliasOf)) {
    aliasCount += 1;
    assert.deepEqual(Object.keys(part.specs), ['数据来源'], `${part.id} 不应重复登记目标型号参数`);
    assert.notEqual(part.aliasOf, part.id, `${part.id} 自指`);
    const seen = new Set([part.id]);
    let targetId = part.aliasOf;
    while (targetId) {
      assert.equal(seen.has(targetId), false, `${part.id} alias 成环：${targetId}`);
      seen.add(targetId);
      const target = byId.get(targetId);
      assert.ok(target, `${part.id} alias 目标不存在：${targetId}`);
      targetId = target.aliasOf;
    }
  }
  assert.equal(aliasCount, 5);
  const instance = registry();
  const listed = instance.listParts({ packId: 'safety-cn' });
  assert.equal(listed.length, safetyCatalog.length);
  assert.equal(listed.some((part) => part.aliasOf), false);
});

test('alias 解析到 iec-cn 已登记型号', () => {
  const instance = registry();
  const cases = [
    ['SAFE-ALIAS-PNOZ-S3', 'PNOZ-s3-750103', 'iec-cn'],
    ['SAFE-ALIAS-PNOZ-S4', 'PNOZ-s4-750104', 'iec-cn'],
    ['SAFE-ALIAS-XPSAC', 'XPSAC5121', 'iec-cn'],
    ['SAFE-ALIAS-3SK1111', '3SK1111-1AB30', 'iec-cn'],
    ['SAFE-ALIAS-NP2-BS542', 'NP2-BS542', 'iec-cn']
  ];
  for (const [aliasId, targetId, packId] of cases) {
    const resolved = instance.getPartById(aliasId);
    assert.equal(resolved?.id, targetId, `${aliasId} 未解析到 ${targetId}`);
    assert.equal(resolved?.packId, packId);
  }
  assert.equal(instance.getPartById('SAFE-ALIAS-MISSING'), undefined);
});

test('两包不录入价格', () => {
  for (const part of [...safety, ...frame]) {
    assert.equal(Object.hasOwn(part, 'price'), false, `${part.id} 不应有 price`);
    assert.equal(Object.hasOwn(part.specs, '价格'), false, `${part.id} 不应有 specs.价格`);
  }
});

test('safety-cn / frame-cn 单包不超过 400 KB', () => {
  for (const id of ['safety-cn', 'frame-cn']) {
    const bytes = statSync(join(builtinDir, id, 'parts.json')).size;
    assert.ok(bytes <= 400 * 1024, `${id} 超过 400 KB：${bytes}`);
  }
});

test('scan 只读 10 个 manifest，不读 parts.json', async () => {
  const reads = [];
  const instance = registry({
    readTextFile: (path) => {
      reads.push(path);
      return readFileSync(path, 'utf8');
    }
  });
  const packs = await instance.scan();
  assert.equal(packs.length, 10);
  assert.equal(new Set(packs.map((pack) => pack.id)).size, 10);
  assert.equal(reads.filter((path) => path.endsWith('manifest.json')).length, 10);
  assert.equal(reads.filter((path) => path.endsWith('parts.json')).length, 0);
});

test('packId 过滤只加载目标新包', () => {
  const safetyRegistry = registry();
  assert.equal(safetyRegistry.listParts({ packId: 'safety-cn' }).length, safetyCatalog.length);
  assert.deepEqual(safetyRegistry.loadedPackIds(), ['safety-cn']);
  const frameRegistry = registry();
  assert.equal(frameRegistry.listParts({ packId: 'frame-cn' }).length, frameCatalog.length);
  assert.deepEqual(frameRegistry.loadedPackIds(), ['frame-cn']);
});

test('全库搜索能命中新增型号', () => {
  const instance = registry();
  assert.deepEqual(instance.listParts({ q: 'F3SG-4PGA0240-14' }).map((part) => part.id), ['F3SG-4PGA0240-14']);
  assert.deepEqual(instance.listParts({ q: 'P10-4590' }).map((part) => part.id), ['APAS-P10-4590']);
});

test('分类聚合只加载对应包', () => {
  const safetyRegistry = registry();
  const curtains = safetyRegistry.listParts({ category: '安全光栅' });
  assert.equal(curtains.length, 11);
  assert.equal(curtains.every((part) => part.specs.type === 'curtain'), true);
  assert.deepEqual(safetyRegistry.loadedPackIds(), ['safety-cn']);
  const frameRegistry = registry();
  const profiles = frameRegistry.listParts({ category: '工业铝型材' });
  assert.equal(profiles.length, 5);
  assert.equal(profiles.every((part) => part.specs.type === 'profile'), true);
  assert.deepEqual(frameRegistry.loadedPackIds(), ['frame-cn']);
});

test('全库聚合 612 条且扫描到 10 包', () => {
  const instance = registry();
  const all = instance.listParts();
  assert.equal(all.length, 612);
  assert.equal(new Set(all.map((part) => part.id)).size, 612);
  for (const category of ['安全光栅', '安全继电器', '安全门锁', '急停', '安全PLC', '工业铝型材', '连接件', '防护板材', '脚轮与地脚', '门与把手', '输送段']) {
    assert.ok(all.some((part) => part.category === category), `缺少分类 ${category}`);
  }
  assert.equal(instance.metrics().loadedPacks, 9);
  assert.equal(instance.metrics().packCount, 10);
  assert.equal(instance.metrics().partsLoaded, 617);
});
