import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildDesignPackage, MAX_PLC_FILE_BYTES, PACKAGE_ENTRIES, parseDesignPackage, sha256Hex, toLocalIsoString } from '../../src/sync/package.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const bom = [
  { no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061', remark: '阳极氧化' },
  { no: 2, name: '气缸', spec: 'MXQ20-50', qty: 2, mat: '铝合金' }
];

function sources(overrides = {}) {
  return {
    projectId: 'asm-slide-cyl',
    projectName: '滑台气缸装配体',
    appVersion: '0.1.0',
    createdAt: '2026-10-22T14:00:00.000Z',
    bom,
    bomCsv: '序号,名称\r\n1,底板\r\n',
    pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    dxf: '0\nSECTION\n0\nENDSEC\n',
    ...overrides
  };
}

test('manifest 生成固定路径、大小与 SHA-256', () => {
  const built = buildDesignPackage(sources());
  assert.deepEqual(built.skipped, []);
  assert.equal(built.manifest.schemaVersion, 1);
  assert.equal(built.manifest.projectId, 'asm-slide-cyl');
  assert.equal(built.manifest.projectName, '滑台气缸装配体');
  assert.equal(built.manifest.appVersion, '0.1.0');
  assert.equal(built.manifest.createdAt, '2026-10-22T14:00:00.000Z');
  assert.deepEqual(built.manifest.files.map((file) => [file.path, file.kind]), [
    ['bom.csv', 'BOM'],
    ['report.pdf', 'PDF'],
    ['model.glb', 'GLTF'],
    ['drawing.dxf', 'DXF']
  ]);
  assert.equal(built.manifest.files[0].sha256, sha256Hex('序号,名称\r\n1,底板\r\n'));
  assert.equal(built.manifest.files[1].size, 4);
  assert.equal(built.manifest.bomSha256, built.manifest.files[0].sha256);
  assert.equal(built.manifest.bom[1].spec, 'MXQ20-50');
  assert.equal(built.manifest.bom[0].remark, '阳极氧化');
  assert.equal(built.zipSha256, createHash('sha256').update(built.zip).digest('hex'));
});

test('zip 只包含四个固定产物与 manifest.json', () => {
  const built = buildDesignPackage(sources());
  const zip = new AdmZip(Buffer.from(built.zip));
  const names = zip.getEntries().map((entry) => entry.entryName).sort();
  assert.deepEqual(names, [
    PACKAGE_ENTRIES.bom,
    PACKAGE_ENTRIES.dxf,
    PACKAGE_ENTRIES.glb,
    PACKAGE_ENTRIES.manifest,
    PACKAGE_ENTRIES.pdf
  ].sort());
  const manifestEntry = zip.getEntry(PACKAGE_ENTRIES.manifest);
  const written = JSON.parse(manifestEntry.getData().toString('utf8'));
  assert.deepEqual(written, built.manifest);
  assert.deepEqual(zip.getEntry(PACKAGE_ENTRIES.pdf).getData(), Buffer.from([0x25, 0x50, 0x44, 0x46]));
});

test('缺失或空文件被跳过并记录，仍生成有效 manifest', () => {
  const built = buildDesignPackage(sources({ glb: undefined, dxf: '' }));
  assert.deepEqual(built.skipped, ['model.glb', 'drawing.dxf']);
  assert.deepEqual(built.manifest.files.map((file) => file.path), ['bom.csv', 'report.pdf']);
  const zip = new AdmZip(Buffer.from(built.zip));
  assert.equal(zip.getEntry('model.glb'), null);
  assert.equal(zip.getEntry('drawing.dxf'), null);
});

test('全部文件缺失时拒绝打包', () => {
  assert.throws(
    () => buildDesignPackage(sources({ bomCsv: undefined, pdf: undefined, glb: undefined, dxf: undefined })),
    /导出文件不存在：BOM\/PDF\/GLB\/DXF 均无有效内容/
  );
  assert.throws(() => buildDesignPackage(sources({ projectId: '  ' })), /projectId不能为空/);
});

test('本地 ISO 时间带时区偏移，默认 createdAt 也使用本地偏移', () => {
  const date = new Date(2026, 9, 22, 22, 0, 0);
  const local = toLocalIsoString(date);
  assert.match(local, /^2026-10-22T22:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(local).getTime(), date.getTime());
  const built = buildDesignPackage(sources({ createdAt: undefined }));
  assert.match(built.manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('createdAt 无时区时拒绝打包', () => {
  for (const createdAt of ['2026-10-22 22:00:00', '2026-10-22T22:00:00']) {
    assert.throws(
      () => buildDesignPackage(sources({ createdAt })),
      /createdAt 必须带时区偏移/
    );
  }
});

test('BOM 数量 1.5 被拒绝', () => {
  assert.throws(
    () => buildDesignPackage(sources({ bom: [{ ...bom[0], qty: 1.5 }] })),
    /BOM 数量必须是正整数：底板/
  );
});

test('BOM 数量字符串 "1" 被拒绝', () => {
  assert.throws(
    () => buildDesignPackage(sources({ bom: [{ ...bom[0], qty: '1' }] })),
    /BOM 数量必须是正整数：底板/
  );
});

test('合法正整数 BOM 数量通过并原样写入 manifest', () => {
  const built = buildDesignPackage(sources({ bom: [{ ...bom[0], qty: 3 }, { ...bom[1], qty: 12 }] }));
  assert.deepEqual(built.manifest.bom.map((row) => row.qty), [3, 12]);
  assert.equal(typeof built.manifest.bom[0].qty, 'number');
});


const plcProgramPaths = [
  'src/OB1_Main.st',
  'src/DB_IO.st',
  'src/FB_Cylinder.st',
  'src/FB_Gripper.st',
  'src/FB_RotaryAxis.st',
  'src/FC_AutoSequence.st',
  'src/FC_Alarms.st',
  'src/FC_Safety.st',
  'io-tags.csv',
  'mapping.json'
];

function plcPayload(config = demoMachineConfig(), overrides = {}) {
  return {
    target: 's7-1200',
    generatedVersion: '1.0.0',
    machineId: config.id,
    programFiles: plcProgramPaths.map((path) => ({
      path,
      content: path.endsWith('.json')
        ? JSON.stringify({ machineId: config.id, target: 's7-1200' })
        : `${path}\ncontent for ${config.id}\n`
    })),
    mappingCsv: buildMachineIoMap(config).csv,
    ...overrides
  };
}

function buildWithPlc(config = demoMachineConfig(), plcOverrides = {}) {
  return buildDesignPackage(sources({ plc: plcPayload(config, plcOverrides) }));
}

function mutateManifest(archiveBytes, mutate) {
  const zip = new AdmZip(Buffer.from(archiveBytes));
  const entry = zip.getEntry(PACKAGE_ENTRIES.manifest);
  assert.ok(entry);
  const manifest = JSON.parse(entry.getData().toString('utf8'));
  mutate(manifest);
  entry.setData(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return new Uint8Array(zip.toBuffer());
}

test('PLC + 机型 IO mapping 导出/解析往返校验全部哈希并要求显式应用', () => {
  const machine = demoMachineConfig();
  const built = buildWithPlc(machine);
  assert.equal(built.manifest.schemaVersion, 1);
  assert.equal(built.manifest.plc.schemaVersion, 1);
  assert.equal(built.manifest.plc.target, 's7-1200');
  assert.equal(built.manifest.plc.generatedVersion, '1.0.0');
  assert.equal(built.manifest.plc.machineId, machine.id);
  assert.equal(built.manifest.plc.programFiles.length, 10);
  assert.equal(built.manifest.plc.mapping.path, 'plc/machine-io-map.csv');
  assert.equal(built.manifest.plc.mapping.size, Buffer.byteLength(buildMachineIoMap(machine).csv));
  assert.equal(built.manifest.plc.mapping.sha256, sha256Hex(buildMachineIoMap(machine).csv));
  const parsed = parseDesignPackage(built.zip, machine);
  assert.equal(parsed.machineContextStatus, 'matched');
  assert.equal(parsed.requiresExplicitApply, true);
  assert.equal(parsed.plc.mappingCsv, buildMachineIoMap(machine).csv);
  assert.equal(parsed.plc.programFiles.length, 10);
  assert.equal(parsed.plc.programFiles.find((file) => file.path === 'src/OB1_Main.st').content, 'src/OB1_Main.st\ncontent for demo-4x3\n');
});

test('PLC 同步模块关闭时构建和候选解析均拒绝 PLC 源码与 IO mapping', () => {
  const built = buildWithPlc();
  assert.throws(
    () => buildDesignPackage(sources({ plc: plcPayload() }), { allowPlc: false }),
    /PLC 同步模块当前已关闭.*拒绝生成/
  );
  assert.throws(
    () => parseDesignPackage(built.zip, undefined, { allowPlc: false }),
    /PLC 同步模块当前已关闭.*拒绝读取或应用/
  );
});

test('PLC 同步模块关闭后普通 BOM/PDF/GLB/DXF 包仍可构建并下载解析', () => {
  const built = buildDesignPackage(sources(), { allowPlc: false });
  const parsed = parseDesignPackage(built.zip, undefined, { allowPlc: false });
  assert.equal(built.manifest.files.length, 4);
  assert.equal(Object.hasOwn(built.manifest, 'plc'), false);
  assert.equal(parsed.plc, undefined);
  assert.equal(parsed.machineContextStatus, 'not-applicable');
  assert.deepEqual(parsed.manifest.files.map((file) => file.path), [
    'bom.csv', 'report.pdf', 'model.glb', 'drawing.dxf'
  ]);
});

test('旧版 schema v1 设计包仍可解析且不需要 PLC 扩展字段', () => {
  const built = buildDesignPackage(sources());
  assert.equal(Object.hasOwn(built.manifest, 'plc'), false);
  const parsed = parseDesignPackage(built.zip);
  assert.equal(parsed.machineContextStatus, 'not-applicable');
  assert.equal(parsed.requiresExplicitApply, true);
  assert.equal(parsed.plc, undefined);
  assert.deepEqual(parsed.manifest.files.map((file) => file.path), ['bom.csv', 'report.pdf', 'model.glb', 'drawing.dxf']);
});

test('PLC manifest 声明文件缺失时拒绝候选包', () => {
  const built = buildWithPlc();
  const zip = new AdmZip(Buffer.from(built.zip));
  zip.deleteFile('plc/src/OB1_Main.st');
  assert.throws(() => parseDesignPackage(new Uint8Array(zip.toBuffer())), /缺少 manifest 声明的文件/);
});

test('PLC 文件内容篡改但未同步 SHA-256 时拒绝候选包', () => {
  const built = buildWithPlc();
  const zip = new AdmZip(Buffer.from(built.zip));
  const entry = zip.getEntry('plc/src/OB1_Main.st');
  assert.ok(entry);
  entry.setData(Buffer.from('tampered PLC source\n', 'utf8'));
  assert.throws(() => parseDesignPackage(new Uint8Array(zip.toBuffer())), /文件长度与 manifest 不一致|文件 SHA-256 与 manifest 不一致/);
});

test('PLC 单文件超过 1 MiB 上限时在创建 ZIP 前拒绝', () => {
  const plc = plcPayload();
  plc.programFiles[0].content = 'x'.repeat(MAX_PLC_FILE_BYTES + 1);
  assert.throws(() => buildDesignPackage(sources({ plc })), /PLC 文件超过 1 MiB 上限/);
});

test('PLC 多文件总量超过 8 MiB 上限时拒绝打包', () => {
  const plc = plcPayload();
  for (const file of plc.programFiles.slice(0, 9)) file.content = 'x'.repeat(MAX_PLC_FILE_BYTES);
  assert.throws(() => buildDesignPackage(sources({ plc })), /PLC 程序与 IO mapping 总大小超过 8 MiB 上限/);
});

test('PLC 路径穿越和 manifest 中的恶意路径均被拒绝', () => {
  const plc = plcPayload();
  plc.programFiles[0].path = '../escape.st';
  assert.throws(() => buildDesignPackage(sources({ plc })), /路径不在白名单中/);
  const built = buildWithPlc();
  const malformed = mutateManifest(built.zip, (manifest) => {
    manifest.plc.programFiles[0].path = '../escape.st';
  });
  assert.throws(() => parseDesignPackage(malformed), /路径不合法/);
});

test('PLC 源文件中疑似明文凭据时拒绝打包', () => {
  const plc = plcPayload();
  plc.programFiles[0].content = 'api_key = "example-token-value-12345"';
  assert.throws(() => buildDesignPackage(sources({ plc })), /疑似包含密钥或凭据/);
  plc.programFiles[0].content = 'OPENAI_API_KEY = "example-secret-value-12345"';
  assert.throws(() => buildDesignPackage(sources({ plc })), /疑似包含密钥或凭据/);
});

test('目的地没有机型上下文时仅解析候选，提供错误 IO mapping 时拒绝应用前校验', () => {
  const machine = demoMachineConfig();
  const built = buildWithPlc(machine);
  const withoutContext = parseDesignPackage(built.zip);
  assert.equal(withoutContext.machineContextStatus, 'unavailable');
  assert.equal(withoutContext.requiresExplicitApply, true);
  const differentIo = demoMachineConfig();
  differentIo.actuators[0].extendPoint = 'Y999';
  assert.throws(() => parseDesignPackage(built.zip, differentIo), /机型 IO 不匹配/);
  const differentMachine = { ...machine, id: 'another-machine' };
  assert.throws(() => parseDesignPackage(built.zip, differentMachine), /机型 IO 不匹配/);
});

test('PLC manifest 未知生成版本拒绝解析，不会产生可应用候选', () => {
  const built = buildWithPlc();
  const unsupported = mutateManifest(built.zip, (manifest) => {
    manifest.plc.generatedVersion = '9.9.9';
  });
  assert.throws(() => parseDesignPackage(unsupported), /不支持的 PLC generatedVersion/);
});
