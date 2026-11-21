import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

let sandbox;
let builtinDir;
let userDir;
let stateFile;

function manifest(id = 'demo-pack') {
  return {
    schemaVersion: 1,
    id,
    name: '演示包',
    vendor: '测试厂商',
    version: '1.0.0',
    description: '单元测试数据包',
    categories: ['气缸', '传感器'],
    partsCount: 2
  };
}

function parts() {
  return [
    {
      id: 'PART-001',
      model: 'PART-001.stp',
      category: '气缸',
      vendor: '测试厂商',
      specs: { 缸径: '32 mm', 行程: '50 mm' },
      price: 100
    },
    {
      id: 'PART-002',
      model: 'PART-002.stp',
      category: '传感器',
      vendor: '测试厂商',
      specs: { 类型: '磁性开关' },
      price: 50
    }
  ];
}

function writePack(dir, manifestValue, partsValue = parts()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestValue, null, 2));
  writeFileSync(join(dir, 'parts.json'), JSON.stringify(partsValue, null, 2));
}

function registry() {
  return new PackRegistry({ builtinDir, userDir, stateFile });
}


function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

function zipPath(name, entries) {
  const path = join(sandbox, name);
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.addFile(entryName, Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)));
  }
  zip.writeZip(path);
  return path;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-pack-test-'));
  builtinDir = join(sandbox, 'builtin');
  userDir = join(sandbox, 'user', 'packs');
  stateFile = join(sandbox, 'user', 'packs-state.json');
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('合法数据包通过校验并可列出条目', async () => {
  writePack(join(builtinDir, 'demo-pack'), manifest());
  const packs = await registry().scan();
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'demo-pack');
  assert.equal(packs[0].error, undefined);
  assert.equal(packs[0].partCount, 2);
  assert.equal(registry().listParts().length, 2);
  assert.equal(registry().listParts({ q: '磁性' }).length, 1);
  assert.equal(registry().listParts({ category: '气缸' }).length, 1);
});

test('symbol 合法值透传到元器件条目', async () => {
  writePack(join(builtinDir, 'symbol-pack'), manifest('symbol-pack'), [
    { id: 'KM-1', model: 'LC1D18M7C', category: '接触器', vendor: '施耐德', symbol: 'km1', specs: { 线圈电压: '220 V AC' } }
  ]);
  const parts = registry().listParts({ packId: 'symbol-pack' });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].symbol, 'km1');
});

test('非法 symbol 会让数据包进入 error 且不加载条目', async () => {
  for (const symbol of ['KM1', 'km-1', 'a'.repeat(9), 42, null]) {
    const dir = join(builtinDir, 'bad-symbol');
    writePack(dir, manifest('bad-symbol'), [
      { id: 'BAD-1', model: 'BAD-1', category: '接触器', symbol, specs: {} }
    ]);
    const actual = registry();
    assert.throws(() => actual.loadPack('bad-symbol'), /symbol/, `symbol=${String(symbol)} 应被拒绝`);
    const packs = await actual.scan();
    assert.equal(packs[0].error !== undefined, true, `symbol=${String(symbol)} 应被拒绝`);
    assert.match(packs[0].error, /symbol/);
    assert.equal(actual.listParts().length, 0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空字符串 symbol 视为无符号且不写入条目', async () => {
  writePack(join(builtinDir, 'empty-symbol'), manifest('empty-symbol'), [
    { id: 'EMPTY-1', model: 'EMPTY-1', category: '按钮', symbol: '', specs: {} }
  ]);
  const [part] = registry().listParts({ packId: 'empty-symbol' });
  assert.ok(part);
  assert.equal(Object.hasOwn(part, 'symbol'), false);
});

test('manifest 缺 id 时拒绝该包', async () => {
  const bad = manifest();
  delete bad.id;
  writePack(join(builtinDir, 'bad-pack'), bad);
  const packs = await registry().scan();
  assert.equal(packs.length, 1);
  assert.match(packs[0].error, /缺少必填参数：manifest\.id/);
  assert.equal(registry().listParts().length, 0);
});

test('manifest id 与目录名不一致时拒绝该包', async () => {
  writePack(join(builtinDir, 'wrong-dir'), manifest('other-id'));
  const packs = await registry().scan();
  assert.equal(packs[0].id, 'wrong-dir');
  assert.match(packs[0].error, /不一致/);
  assert.equal(registry().listParts().length, 0);
});

test('ZIP 哈希不符时未安装，修正后可用同一 ID 重试', async () => {
  const pack = manifest('retry-pack');
  const content = JSON.stringify(parts());
  const archive = (label, hash) => zipPath(label, {
    'manifest.json': { ...pack, partsSha256: hash },
    'parts.json': content
  });
  const instance = registry();
  await assert.rejects(instance.importZip(archive('bad-hash.zip', '0'.repeat(64))), /PACK_INTEGRITY_FAILED/);
  assert.deepEqual(readdirSync(userDir), []);
  assert.deepEqual(await instance.scan(), []);
  const hash = createHash('sha256').update(content).digest('hex');
  assert.equal((await instance.importZip(archive('valid-hash.zip', hash))).id, pack.id);
  assert.equal(instance.listParts({ packId: pack.id }).length, 2);
});

test('导入包含 ../evil.txt 的 ZIP 会被拒绝且不落盘', async () => {
  const zip = join(sandbox, 'evil.zip');
  writeFileSync(zip, storedZip({
    'manifest.json': manifest('evil-pack'),
    'parts.json': parts(),
    '../evil.txt': 'bad'
  }));
  await assert.rejects(() => registry().importZip(zip), /路径穿越/);
  assert.equal(registry().listParts().length, 0);
});

test('禁用后 listParts 不再包含该包条目', async () => {
  writePack(join(userDir, 'demo-pack'), manifest());
  assert.equal(registry().listParts().length, 2);
  await registry().setEnabled('demo-pack', false);
  assert.equal(registry().listParts().length, 0);
  const packs = await registry().scan();
  assert.equal(packs[0].enabled, false);
  await registry().setEnabled('demo-pack', true);
  assert.equal(registry().listParts().length, 2);
});

test('合法 ZIP 导入到用户目录', async () => {
  const zip = zipPath('valid.zip', {
    'manifest.json': manifest('zip-pack'),
    'parts.json': parts()
  });
  const info = await registry().importZip(zip);
  assert.equal(info.id, 'zip-pack');
  assert.equal(info.builtin, false);
  assert.equal(info.partCount, 2);
  assert.equal(registry().listParts({ packId: 'zip-pack' }).length, 2);
});

test('仓库内置 smc-cn 包含 8 个真实型号', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const actualBuiltin = resolve(here, '../../../packs/builtin');
  const actual = new PackRegistry({
    builtinDir: actualBuiltin,
    userDir,
    stateFile
  });
  const packs = actual.listParts({ packId: 'smc-cn' });
  assert.equal(packs.length, 8);
  const ids = new Set(packs.map((part) => part.id));
  for (const id of ['MXQ20-50', 'MGP32-200', 'CDQ2B32-50DZ', 'MHZ2-20D', 'SY5120-5LZD', 'D-M9B', 'KQ2H06-01AS', 'AW30-03']) {
    assert.equal(ids.has(id), true, `缺少型号 ${id}`);
  }
  assert.equal(actual.listParts({ q: 'SMC', packId: 'smc-cn' }).length, 8);
});

test('仓库内置 iec-cn 规模与符号映射符合预期', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const actualBuiltin = resolve(here, '../../../packs/builtin');
  const actual = new PackRegistry({ builtinDir: actualBuiltin, userDir, stateFile });
  const parts = actual.listParts({ packId: 'iec-cn' });
  assert.ok(parts.length >= 350, `条目过少：${parts.length}`);
  const categories = new Set(parts.map((part) => part.category));
  assert.ok(categories.size >= 20, `分类过少：${categories.size}`);
  const withSymbol = parts.filter((part) => typeof part.symbol === 'string' && part.symbol !== '');
  assert.ok(withSymbol.length >= 150, `带符号元件过少：${withSymbol.length}`);
  const allowed = new Set(['a1', 'fr1', 'ka1', 'km1', 'm1', 'qf1', 'sb1', 'x1']);
  for (const part of withSymbol) assert.ok(allowed.has(part.symbol), `非法符号 ${part.id}:${part.symbol}`);
});

test('导入缺少 manifest 必填字段的 ZIP 返回具体原因', async () => {
  const bad = manifest('missing-vendor');
  delete bad.vendor;
  const zip = zipPath('missing-vendor.zip', {
    'manifest.json': bad,
    'parts.json': parts()
  });
  await assert.rejects(() => registry().importZip(zip), /缺少必填参数：manifest\.vendor/);
  assert.equal((await registry().scan()).length, 0);
});

test('导入与内置包 id 冲突的 ZIP 返回具体原因', async () => {
  writePack(join(builtinDir, 'smc-cn'), manifest('smc-cn'));
  const zip = zipPath('conflict.zip', {
    'manifest.json': manifest('smc-cn'),
    'parts.json': parts()
  });
  await assert.rejects(() => registry().importZip(zip), /数据包 id 已存在：smc-cn/);
});
