// 机型库：包格式 + 本地库的严格校验。
// 为什么这么较真：机型包是「从外面拿进来的数据」，一旦放过穿越条目/篡改载荷/半包落盘，
// 用户机器上就会出现一份来路不明的机型方案；这里每条断言都盯一个拒绝理由。
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import {
  readStoredMachineDesign,
  validateMachineDesign
} from '../../src/machine/store.ts';
import {
  MACHINE_LIBRARY_LIMITS,
  MachineLibraryError,
  buildMachinePackage,
  exportPackage,
  importPackage,
  listLibrary,
  loadFromLibrary,
  machineLibraryDirectory,
  readMachinePackage,
  removeFromLibrary,
  saveToLibrary
} from '../../src/machine/library.ts';

const BRIEF = '四工位点胶机，节拍 25 件/分钟';
const APP_VERSION = '0.6.3';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'machine-library-test-'));
}

function sampleDesign(brief = BRIEF) {
  return validateMachineDesign(synthMachine(parseMachineBrief(brief), {}));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 手写 store 方式 ZIP：保留原始条目名（adm-zip 写盘时会把 `../x` 归一化，构造不出穿越样例）。 */
function buildStoredZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const body = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 在保留原 manifest 的前提下重组 zip，用来构造「只有一处不对」的攻击包。 */
function rewriteZip(bytes, { replace = {}, add = [], drop = [] } = {}) {
  const zip = new AdmZip(bytes);
  const entries = [];
  for (const entry of zip.getEntries()) {
    if (drop.includes(entry.entryName)) continue;
    entries.push({ name: entry.entryName, data: replace[entry.entryName] ?? entry.getData() });
  }
  for (const extra of add) entries.push(extra);
  return buildStoredZip(entries);
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MachineLibraryError, `应当抛 MachineLibraryError，实际 ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code, `错误码不对：${error.code} / ${error.message}`);
    assert.match(error.message, /[\u4e00-\u9fa5]/, '消息必须是中文');
    return error;
  }
  assert.fail(`应当抛 ${code}，但没有抛错`);
}

function assertNoResidue(root, id) {
  const libraryRoot = machineLibraryDirectory(root);
  if (!existsSync(libraryRoot)) return;
  const leftovers = readdirSync(libraryRoot).filter((name) => name.startsWith('.tmp-') || name.startsWith('.old-'));
  assert.deepEqual(leftovers, [], `库目录里残留了临时目录：${leftovers.join('、')}`);
  assert.equal(existsSync(join(libraryRoot, id)), false, `失败的导入留下了 ${id} 目录`);
}

test('往返：保存 → 列表 → 导出 → 删除 → 导入 → 加载，config 逐字段相等', () => {
  const root = freshRoot();
  const design = sampleDesign();
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

  const saved = saveToLibrary(root, design, {
    appVersion: APP_VERSION,
    version: '1.2.3',
    now: new Date('2026-01-02T03:04:05.000Z'),
    plcFiles: [
      { path: 'plc/Main.st', content: 'PROGRAM Main\nEND_PROGRAM\n' },
      { path: 'plc/io-map.csv', content: 'point,address\nX0,I0.0\n' }
    ],
    shots: [{ path: 'shots/front.png', content: pngBytes }]
  });
  assert.equal(saved.overwritten, false);
  assert.equal(saved.entry.id, design.config.id);
  assert.equal(saved.entry.version, '1.2.3');
  assert.equal(saved.entry.source, 'local');
  assert.ok(saved.entry.sizeBytes > 0);

  const listed = listLibrary(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, design.config.id);
  assert.equal(listed[0].version, '1.2.3');
  assert.equal(listed[0].source, 'local');

  const exported = exportPackage(root, design.config.id);
  assert.ok(exported.byteLength > 500, `导出的包太小：${exported.byteLength}`);
  const exportedNames = new AdmZip(exported).getEntries().map((entry) => entry.entryName).sort();
  assert.deepEqual(exportedNames, ['bom.csv', 'config.json', 'geometry.json', 'manifest.json', 'plc/Main.st', 'plc/io-map.csv', 'shots/front.png']);

  const parsed = readMachinePackage(exported);
  assert.deepEqual(parsed.config, design.config, 'config 必须逐字段相等');
  assert.equal(parsed.manifest.configSha256, sha256(parsed.files.get('config.json')));
  assert.equal(parsed.manifest.files.find((file) => file.kind === 'config').size, parsed.files.get('config.json').byteLength);

  removeFromLibrary(root, design.config.id);
  assert.deepEqual(listLibrary(root), []);
  assert.equal(existsSync(join(machineLibraryDirectory(root), design.config.id)), false);

  const imported = importPackage(root, exported);
  assert.equal(imported.overwritten, false);
  assert.equal(imported.entry.source, 'remote');
  assert.deepEqual(readMachinePackage(exportPackage(root, design.config.id)).config, design.config);

  const loaded = loadFromLibrary(root, design.config.id, { now: new Date('2026-01-02T04:00:00.000Z') });
  assert.deepEqual(loaded.design.config, design.config, '加载回来的 config 必须逐字段相等');
  assert.deepEqual(loaded.design.stationIdentities, design.stationIdentities, '工位身份映射要一起还原');
  assert.equal(loaded.design.appliedAt, '2026-01-02T04:00:00.000Z');

  const pointer = JSON.parse(readFileSync(join(root, 'machine', 'active.json'), 'utf8'));
  assert.equal(pointer.machineId, design.config.id);
  assert.equal(pointer.file, `machine/${design.config.id}.json`);
  const reread = readStoredMachineDesign(root, design.config.id);
  assert.deepEqual(reread.config, design.config, 'machine/<id>.json 必须能被 store 读回');
  assert.equal(loaded.designPath, join(root, 'machine', `${design.config.id}.json`));
  assert.equal(loaded.activePath, join(root, 'machine', 'active.json'));
  assert.ok(loaded.copied.some((path) => path.endsWith('geometry.json')), '几何要一并落到 machine/<id>/');
  assert.ok(existsSync(join(root, 'machine', design.config.id, 'bom-draft.csv')), 'BOM 草稿要一并落盘');
  assert.equal(readFileSync(join(root, 'machine', design.config.id, 'bom-draft.csv'), 'utf8'), parsed.files.get('bom.csv').toString('utf8'));

  rmSync(root, { recursive: true, force: true });
});

test('SHA-256 篡改被拒，且库里不留半个包', () => {
  const root = freshRoot();
  const design = sampleDesign();
  const bytes = buildMachinePackage(design, { appVersion: APP_VERSION });
  const tampered = rewriteZip(bytes, {
    replace: { 'config.json': Buffer.from('{"id":"design-dispense-4st","name":"偷改的方案"}\n') }
  });
  const error = expectCode(() => importPackage(root, tampered), 'LIBRARY_HASH_MISMATCH');
  assert.match(error.message, /config\.json/);
  assertNoResidue(root, design.config.id);

  // 只改字节不改大小：同样要在哈希上暴露
  const original = new AdmZip(bytes).getEntry('geometry.json').getData();
  const mutated = Buffer.from(original);
  mutated[mutated.length - 2] = mutated[mutated.length - 2] === 0x20 ? 0x21 : 0x20;
  expectCode(
    () => importPackage(root, rewriteZip(bytes, { replace: { 'geometry.json': mutated } })),
    'LIBRARY_HASH_MISMATCH'
  );
  assertNoResidue(root, design.config.id);
  assert.deepEqual(listLibrary(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('路径穿越条目被拒（../evil.json、绝对路径、盘符、UNC、反斜线）', () => {
  const root = freshRoot();
  const design = sampleDesign();
  const bytes = buildMachinePackage(design, { appVersion: APP_VERSION });

  const cases = [
    '../evil.json',
    '/etc/passwd',
    'C:/windows/system32/evil.json',
    '//server/share/evil.json',
    'plc/../../evil.json'
  ];
  for (const name of cases) {
    const attack = rewriteZip(bytes, { add: [{ name, data: Buffer.from('{"pwned":true}') }] });
    const error = expectCode(() => importPackage(root, attack), 'LIBRARY_BAD_PATH');
    assert.match(error.message, /路径|穿越|相对/);
    assertNoResidue(root, design.config.id);
  }
  // 反斜线需要手写中央目录（adm-zip 会在读的时候把 \\ 换成 /）
  const backslash = buildStoredZip([
    { name: 'manifest.json', data: new AdmZip(bytes).getEntry('manifest.json').getData() },
    { name: 'config.json', data: new AdmZip(bytes).getEntry('config.json').getData() },
    { name: 'plc\\evil.st', data: Buffer.from('x') }
  ]);
  expectCode(() => importPackage(root, backslash), 'LIBRARY_BAD_PATH');
  assertNoResidue(root, design.config.id);
  assert.deepEqual(listLibrary(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('未声明条目 / 缺 manifest / 空包 / 非法 ZIP 都进不来', () => {
  const root = freshRoot();
  const design = sampleDesign();
  const bytes = buildMachinePackage(design, { appVersion: APP_VERSION });

  expectCode(
    () => importPackage(root, rewriteZip(bytes, { add: [{ name: 'notes.txt', data: Buffer.from('hi') }] })),
    'LIBRARY_BAD_ZIP'
  );
  const onlyConfig = buildStoredZip([
    { name: 'config.json', data: new AdmZip(bytes).getEntry('config.json').getData() }
  ]);
  expectCode(() => importPackage(root, onlyConfig), 'LIBRARY_BAD_ZIP');
  expectCode(() => importPackage(root, new AdmZip().toBuffer()), 'LIBRARY_BAD_ZIP');
  expectCode(() => importPackage(root, Buffer.from('not a zip at all')), 'LIBRARY_BAD_ZIP');
  expectCode(
    () => importPackage(root, rewriteZip(bytes, { drop: ['geometry.json'] })),
    'LIBRARY_BAD_ZIP'
  );
  assertNoResidue(root, design.config.id);
  assert.deepEqual(listLibrary(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('超限被拒：整包 >50 MiB、plc 13 个、plc 单文件 >1 MiB', () => {
  const root = freshRoot();
  const design = sampleDesign();

  expectCode(
    () => importPackage(root, Buffer.alloc(MACHINE_LIBRARY_LIMITS.maxPackageBytes + 1)),
    'LIBRARY_TOO_LARGE'
  );

  const tooManyPlc = Array.from({ length: MACHINE_LIBRARY_LIMITS.maxPlcFiles + 1 }, (_, index) => ({
    path: `plc/p${index}.st`,
    content: 'PROGRAM P\nEND_PROGRAM\n'
  }));
  const countError = expectCode(
    () => saveToLibrary(root, design, { appVersion: APP_VERSION, plcFiles: tooManyPlc }),
    'LIBRARY_TOO_LARGE'
  );
  assert.match(countError.message, /plc/);

  const bigPlc = [{ path: 'plc/big.st', content: Buffer.alloc(MACHINE_LIBRARY_LIMITS.maxPlcFileBytes + 1, 0x41) }];
  const sizeError = expectCode(
    () => saveToLibrary(root, design, { appVersion: APP_VERSION, plcFiles: bigPlc }),
    'LIBRARY_TOO_LARGE'
  );
  assert.match(sizeError.message, /上限/);

  const bigShot = [{ path: 'shots/big.png', content: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(MACHINE_LIBRARY_LIMITS.maxShotFileBytes, 0)]) }];
  expectCode(() => saveToLibrary(root, design, { appVersion: APP_VERSION, shots: bigShot }), 'LIBRARY_TOO_LARGE');

  assertNoResidue(root, design.config.id);
  assert.deepEqual(listLibrary(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('schemaVersion 不支持被拒（v2 不认，不会「尽力解析」）', () => {
  const root = freshRoot();
  const design = sampleDesign();
  const bytes = buildMachinePackage(design, { appVersion: APP_VERSION });
  const manifest = JSON.parse(new AdmZip(bytes).getEntry('manifest.json').getData().toString('utf8'));
  const bumped = JSON.stringify({ ...manifest, schemaVersion: 2 }, null, 2);
  const error = expectCode(
    () => importPackage(root, rewriteZip(bytes, { replace: { 'manifest.json': Buffer.from(bumped) } })),
    'LIBRARY_UNSUPPORTED_SCHEMA'
  );
  assert.match(error.message, /schemaVersion=2/);
  assertNoResidue(root, design.config.id);
  rmSync(root, { recursive: true, force: true });
});

test('同 id 默认拒绝覆盖，overwrite=true 才替换', () => {
  const root = freshRoot();
  const design = sampleDesign();
  saveToLibrary(root, design, { appVersion: APP_VERSION });
  const bytes = buildMachinePackage(design, { appVersion: APP_VERSION, version: '2.0.0' });

  const error = expectCode(() => importPackage(root, bytes), 'LIBRARY_EXISTS');
  assert.match(error.message, /overwrite=true/);
  assert.equal(listLibrary(root)[0].version, '1.0.0');

  const overwritten = importPackage(root, bytes, { overwrite: true });
  assert.equal(overwritten.overwritten, true);
  assert.equal(overwritten.entry.version, '2.0.0');
  assert.equal(listLibrary(root).length, 1);
  assert.equal(listLibrary(root)[0].version, '2.0.0');
  assert.deepEqual(
    readdirSync(machineLibraryDirectory(root)).filter((name) => name.startsWith('.')),
    [],
    '覆盖成功后不留临时/备份目录'
  );

  // saveToLibrary 走同一套：默认也不覆盖
  expectCode(() => saveToLibrary(root, design, { appVersion: APP_VERSION }), 'LIBRARY_EXISTS');
  assert.equal(saveToLibrary(root, design, { appVersion: APP_VERSION, overwrite: true }).overwritten, true);
  rmSync(root, { recursive: true, force: true });
});

test('删除 / 导出 / 加载不存在的 id 报 LIBRARY_NOT_FOUND', () => {
  const root = freshRoot();
  expectCode(() => removeFromLibrary(root, 'no-such-machine'), 'LIBRARY_NOT_FOUND');
  expectCode(() => exportPackage(root, 'no-such-machine'), 'LIBRARY_NOT_FOUND');
  expectCode(() => loadFromLibrary(root, 'no-such-machine'), 'LIBRARY_NOT_FOUND');
  expectCode(() => exportPackage(root, '../etc'), 'LIBRARY_BAD_PATH');
  rmSync(root, { recursive: true, force: true });
});

test('导出字节可直接再导入（跨机器分享的最小闭环）', () => {
  const root = freshRoot();
  const design = sampleDesign();
  saveToLibrary(root, design, { appVersion: APP_VERSION });
  const bytes = exportPackage(root, design.config.id);

  const other = freshRoot();
  const imported = importPackage(other, bytes, { overwrite: true });
  assert.equal(imported.entry.id, design.config.id);
  const loaded = loadFromLibrary(other, design.config.id);
  assert.deepEqual(loaded.design.config, design.config);
  const reread = readStoredMachineDesign(other, design.config.id);
  assert.equal(reread.name, design.config.name);
  assert.equal(reread.config.stations.length, design.config.stations.length);
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test('库里被手工改过的机型：导出即报 LIBRARY_HASH_MISMATCH（不把坏数据再发出去）', () => {
  const root = freshRoot();
  const design = sampleDesign();
  saveToLibrary(root, design, { appVersion: APP_VERSION });
  const configPath = join(machineLibraryDirectory(root), design.config.id, 'config.json');
  const original = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, original.replace('"name"', '"name"').replace(/\n$/, '\n'), 'utf8');
  assert.doesNotThrow(() => exportPackage(root, design.config.id));

  writeFileSync(configPath, original.replace(/4 工位点胶机/g, '被改过的机器'), 'utf8');
  expectCode(() => exportPackage(root, design.config.id), 'LIBRARY_HASH_MISMATCH');
  expectCode(() => loadFromLibrary(root, design.config.id), 'LIBRARY_HASH_MISMATCH');
  rmSync(root, { recursive: true, force: true });
});

test('索引可自愈：目录还在、catalog.json 被删/写坏也能列出来', () => {
  const root = freshRoot();
  const design = sampleDesign();
  saveToLibrary(root, design, { appVersion: APP_VERSION });
  const catalogPath = join(machineLibraryDirectory(root), 'catalog.json');
  rmSync(catalogPath);
  assert.deepEqual(listLibrary(root).map((entry) => entry.id), [design.config.id]);
  assert.ok(existsSync(catalogPath), '列表时应把索引重建出来');
  writeFileSync(catalogPath, '{ broken', 'utf8');
  assert.deepEqual(listLibrary(root).map((entry) => entry.id), [design.config.id]);
  rmSync(root, { recursive: true, force: true });
});

test('没有 stationIdentities 的方案也能入库（可选字段不能当必填）', () => {
  // 回归：buildMachinePackage 早期直接读 design.stationIdentities.length，
  // 未经 validateMachineDesign 的原始方案（智能体/脚本直接产出）入库时抛 TypeError。
  const root = freshRoot();
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，节拍 12 件/分钟'), {});
  assert.equal(design.stationIdentities, undefined, '未经 store 归一化的方案确实没有工位身份');
  const saved = saveToLibrary(root, design, { appVersion: APP_VERSION });
  assert.equal(saved.entry.id, design.config.id);
  const payload = readMachinePackage(exportPackage(root, saved.entry.id));
  assert.equal(payload.config.id, design.config.id);
  // 这个方案有 form（没有 layout），所以 geometry.json 存在；但没有工位身份就不该写空数组进包
  const geometry = [...payload.files.entries()].find(([path]) => path.endsWith('geometry.json'));
  if (geometry) {
    const doc = JSON.parse(geometry[1].toString('utf8'));
    assert.equal(doc.stationIdentities, undefined, '没有工位身份就不该在包里写一个空数组');
  }
  rmSync(root, { recursive: true, force: true });
});

test('同一机型重复导出字节稳定（包哈希可用于去重/校验）', () => {
  // 回归：ZIP 头里的 DOS 时间默认是「打包那一刻」，隔两秒再导出 sha256 就变。
  const root = freshRoot();
  const design = sampleDesign();
  const saved = saveToLibrary(root, design, { appVersion: APP_VERSION });
  const first = exportPackage(root, saved.entry.id);
  const second = exportPackage(root, saved.entry.id);
  assert.equal(sha256(first), sha256(second));
  rmSync(root, { recursive: true, force: true });
});

test('G3：传感器绑了不存在的执行机构 → 导入被严格校验拒绝，带 path 与 hint', () => {
  // 宽松的 validateMachineConfig 只查结构（现场 IO 映射表里的 part 常常是「主回路反馈」这类信号名），
  // 机型包是「方案」，必须过 validateDesign 严格模式，否则坏方案能进库、被 apply、被生成 PLC。
  const root = freshRoot();
  const design = sampleDesign();
  const sensors = design.config.sensors;
  assert.ok(sensors.length > 0, '样例方案应当有传感器');
  const brokenConfig = {
    ...design.config,
    sensors: sensors.map((sensor, index) =>
      index === 0 ? { ...sensor, part: '不存在的执行机构' } : sensor
    )
  };

  // 打包用宽松校验（buildMachinePackage 走 validateMachineConfig），所以包里确实带着坏配置。
  const brokenPackage = buildMachinePackage({ ...design, config: brokenConfig });
  expectCode(() => readMachinePackage(brokenPackage), 'LIBRARY_INVALID_CONFIG');
  const error = expectCode(() => importPackage(root, brokenPackage), 'LIBRARY_INVALID_CONFIG');
  assert.match(error.message, /config\.sensors\[0\]\.part/, `消息必须带 path：${error.message}`);
  assert.match(error.message, /SENSOR_UNBOUND/);
  assert.equal(error.hint, '把 part 改成已定义的工位名或执行机构 id；急停/安全门/光栅等安全传感器可不绑定工位');
  assertNoResidue(root, design.config.id);
  assert.deepEqual(listLibrary(root), [], '被拒的包不能在库里留下任何条目');

  // 合法包仍然能导入（严格校验只挡真错误）
  const good = saveToLibrary(root, design, { appVersion: APP_VERSION });
  assert.equal(good.entry.id, design.config.id);
  assert.deepEqual(listLibrary(root).map((entry) => entry.id), [design.config.id]);
  rmSync(root, { recursive: true, force: true });
});
