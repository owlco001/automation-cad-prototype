#!/usr/bin/env node
// 机型库真实往返演示：生成方案 → 入库 → 导出 .machine.zip → 删除 → 导入 → 加载。
// 用法：node --experimental-strip-types scripts/machine-library-demo.mjs [--dir <目录>]
// 只写 userData 根目录（默认系统临时目录下的 machine-library-demo），不碰仓库、不联网。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthMachine } from '../src/machine/synth.ts';
import { parseMachineBrief } from '../src/machine/spec.ts';
import { readActivePointer, readStoredMachineDesign, validateMachineDesign } from '../src/machine/store.ts';
import {
  exportPackage,
  importPackage,
  listLibrary,
  loadFromLibrary,
  machineLibraryDirectory,
  readMachinePackage,
  removeFromLibrary,
  saveToLibrary
} from '../src/machine/library.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const appVersion = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// 默认每次跑用新的临时目录：用固定目录时第二次跑会撞 LIBRARY_EXISTS（同名机型已入库），
// 演示脚本不该依赖“上次跑完删干净了”。要复用目录就显式传 --dir。
const root = resolve(argValue('--dir') ?? mkdtempSync(join(tmpdir(), 'machine-library-demo-')));
const exportDir = join(root, 'export');
mkdirSync(exportDir, { recursive: true });

const log = (...parts) => console.log(...parts);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const human = (bytes) => `${bytes} B (${(bytes / 1024).toFixed(2)} KiB)`;

function tree(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  const lines = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      lines.push(`${prefix}${name}/`);
      lines.push(...tree(full, `${prefix}  `));
    } else {
      lines.push(`${prefix}${name}  ${stat.size} B`);
    }
  }
  return lines;
}

log('=== 1. 生成机型方案 ===');
const design = validateMachineDesign(
  synthMachine(parseMachineBrief('四工位点胶机，节拍 25 件/分钟'), {})
);
const id = design.config.id;
log(`id=${id}  name=${design.config.name}  stations=${design.config.stations.length}  actuators=${design.config.actuators.length}  sensors=${design.config.sensors.length}  bom=${design.bomDraft?.items.length ?? 0}`);

log('\n=== 2. 入库（saveToLibrary，带 PLC 与截图） ===');
const saved = saveToLibrary(root, design, {
  appVersion,
  version: '1.0.0',
  plcFiles: [
    { path: 'plc/Main.st', content: 'PROGRAM Main\nEND_PROGRAM\n' },
    { path: 'plc/io-map.csv', content: 'point,address\nST1-CYL-EXTEND,I0.0\n' }
  ],
  shots: [
    {
      path: 'shots/front.png',
      // 最小 PNG 头 + 占位数据：只验格式，不是真图
      content: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 0x11)])
    }
  ]
});
log(`入库成功：${saved.entry.id} v${saved.entry.version} source=${saved.entry.source} sizeBytes=${saved.entry.sizeBytes} overwritten=${saved.overwritten}`);

log('\n=== 3. listLibrary() ===');
for (const entry of listLibrary(root)) {
  log(`  ${entry.id}  ${entry.name}  v${entry.version}  ${entry.sizeBytes} B  ${entry.source}  updatedAt=${entry.updatedAt}`);
}

log('\n=== 4. exportPackage() 导出 .machine.zip ===');
const exported = exportPackage(root, id);
const zipPath = join(exportDir, `${id}.machine.zip`);
writeFileSync(zipPath, exported);
const parsed = readMachinePackage(exported);
log(`文件：${zipPath}`);
log(`大小：${human(exported.byteLength)}`);
log(`sha256：${sha256(exported)}`);
log(`包内清单（${parsed.manifest.files.length} 个文件 + manifest.json）：`);
for (const file of parsed.manifest.files) {
  log(`  ${file.kind.padEnd(8)} ${file.path.padEnd(18)} ${String(file.size).padStart(6)} B  sha256=${file.sha256.slice(0, 16)}…`);
}
log(`configSha256=${parsed.manifest.configSha256.slice(0, 16)}…  appVersion=${parsed.manifest.appVersion}  createdAt=${parsed.manifest.createdAt}`);

log('\n=== 5. removeFromLibrary() ===');
const removed = removeFromLibrary(root, id);
log(`已删除 ${removed.id}；剩余 ${listLibrary(root).length} 个机型`);

log('\n=== 6. importPackage() 重新导入 ===');
const imported = importPackage(root, exported);
log(`导入成功：${imported.entry.id} v${imported.entry.version} source=${imported.entry.source} overwritten=${imported.overwritten}`);

log('\n=== 7. loadFromLibrary() 写回 machine/<id>.json + active.json ===');
const loaded = loadFromLibrary(root, id);
log(`designPath=${loaded.designPath}`);
log(`activePath=${loaded.activePath}`);
log(`一并落盘：${loaded.copied.map((path) => path.replace(`${root}/`, '')).join('、') || '（无）'}`);
const pointer = readActivePointer(root);
log(`active.json → machineId=${pointer?.machineId} name=${pointer?.name} file=${pointer?.file} appliedAt=${pointer?.appliedAt}`);
const reread = readStoredMachineDesign(root, id);
log(`readStoredMachineDesign 读回：name=${reread?.name} stations=${reread?.config.stations.length} 点位=${reread?.points.length} 执行机构=${reread?.config.actuators.length}`);
const configEqual = JSON.stringify(reread?.config) === JSON.stringify(design.config);
log(`config 与生成时逐字段相等：${configEqual ? '是' : '否'}`);

log('\n=== 8. 磁盘实况 ===');
log(`userData 根：${root}`);
log('machine-library/ 树：');
for (const line of tree(join(machineLibraryDirectory(root)))) log(`  ${line}`);
log('machine/ 树：');
for (const line of tree(join(root, 'machine'))) log(`  ${line}`);
log('\n导出的包（可拿去另一台机器 importPackage）：');
log(`  ${zipPath}  ${exported.byteLength} B  ${sha256(exported)}`);

if (!configEqual) {
  console.error('MACHINE_LIBRARY_DEMO_FAILED config 往返不一致');
  process.exit(1);
}
log('\nMACHINE_LIBRARY_DEMO_OK');
