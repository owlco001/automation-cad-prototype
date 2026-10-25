import { spawn } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { CORE_RUNTIME_FILES, validateCoreRuntimeDirectory } from './core-windows-nsis-contract.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const releaseRoot = resolve(root, 'release');
const args = process.argv.slice(2);
const outputArgs = args.filter((argument) => argument.startsWith('--output-dir='));
const runtimeArgs = args.filter((argument) => argument.startsWith('--runtime-dir='));
if (outputArgs.length > 1 || runtimeArgs.length > 1 || args.some((argument) => argument !== '--verify-existing' && !argument.startsWith('--output-dir=') && !argument.startsWith('--runtime-dir='))) {
  throw new Error('用法：node scripts/build-core-linux-dir.mjs [--runtime-dir=dist-core-<fresh-name>] [--output-dir=release/<fresh-name>] [--verify-existing]');
}
const runtimeDir = resolve(root, runtimeArgs[0]?.slice('--runtime-dir='.length) ?? 'dist-core');
const runtimeRelative = relative(root, runtimeDir);
if (!runtimeRelative || runtimeRelative === '..' || runtimeRelative.startsWith(`..${sep}`)) throw new Error('Core Linux runtime 必须位于 desktop/ 下。');
const outputRelative = outputArgs[0]?.slice('--output-dir='.length) ?? 'release/core-runtime-linux-unpacked';
const outputDir = resolve(root, outputRelative);
const outputWithinRelease = relative(releaseRoot, outputDir);
if (!outputWithinRelease || outputWithinRelease === '..' || outputWithinRelease.startsWith(`..${sep}`) || outputWithinRelease.includes(sep)) {
  throw new Error('Core Linux 打包输出必须是 desktop/release/ 下的新一级子目录。');
}
const expectedFiles = [...CORE_RUNTIME_FILES];
const forbiddenTokens = [
  'agent.resume',
  'plcgen',
  'elec.validation',
  'cost.estimation',
  'factory.plc-sync',
  'commission.io-test',
  'cad.parametric-import',
  'parametric.history',
  'project.portable',
  'system.update',
  'electron-updater',
  'node-opcua',
  'modbus-serial',
  'occt-import-js',
  'desktopApi',
  'openCadDialog',
  'agent:',
  'plc:',
  'plcgen:',
  'factory:',
  'sync:',
  'cost:',
  'parametric:',
  'update:',
  'packs:',
  'project-archive:'
];
function findForbiddenToken(name, text) {
  if (name === 'THREE-LICENSE.txt') return null;
  const scanText = name === 'core-viewer.js'
    ? text.replaceAll('http://www.w3.org/1999/xhtml', '').replaceAll('https://jcgt.org/published/0007/04/01/', '')
    : text;
  return forbiddenTokens.find((token) => {
    if (name === 'core-viewer.js' && token === 'update:') return false;
    return token === 'sync:' ? /(^|[^A-Za-z0-9_])sync:/u.test(scanText) : scanText.includes(token);
  }) ?? null;
}

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`此验证目标仅支持 Linux x64；当前环境为 ${process.platform}/${process.arch}`);
}
await access(runtimeDir);
validateCoreRuntimeDirectory(runtimeDir);
const stageEntries = await readdir(runtimeDir, { withFileTypes: true });
if (stageEntries.some((entry) => !entry.isFile())) throw new Error('Core runtime 必须是仅含扁平文件的目录');
const stagedFiles = stageEntries.map((entry) => entry.name).sort();
if (stagedFiles.join('\n') !== expectedFiles.join('\n')) throw new Error(`Core runtime 文件清单不匹配：${stagedFiles.join(', ')}`);
const stagePackage = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'));
if (stagePackage.main !== 'core-main.cjs' || stagePackage.name !== 'automationcad-core-runtime') {
  throw new Error('Core app metadata 的 name/main 与独立运行时契约不匹配');
}
try {
  await stat(outputDir);
  if (!process.argv.includes('--verify-existing')) {
    throw new Error(`拒绝覆盖已存在的打包输出目录：${outputDir}`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (process.argv.includes('--verify-existing')) await access(outputDir);

const electronVersion = JSON.parse(await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const builderBin = join(root, 'node_modules', '.bin', 'electron-builder');
const builderArgs = [
  '--dir',
  '--linux',
  '--x64',
  '--projectDir',
  runtimeDir,
  `--config.electronVersion=${electronVersion}`,
  '--config.appId=cn.automationcad.core.runtime',
  `--config.directories.output=${relative(runtimeDir, outputDir).split(sep).join('/')}`,
  '--config.npmRebuild=false',
  '--publish=never'
];
if (process.argv.includes('--verify-existing')) {
  console.log(`CORE_LINUX_PACKAGE_VERIFY_EXISTING appDir=${outputDir}`);
} else {
  console.log(`CORE_LINUX_PACKAGE_BUILD_START electron=${electronVersion} projectDir=${runtimeRelative}`);
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(builderBin, builderArgs, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`electron-builder 退出码：${exitCode}`);
}

const appDir = join(outputDir, 'linux-unpacked');
const executablePath = join(appDir, stagePackage.name);
const archivePath = join(appDir, 'resources', 'app.asar');
await access(executablePath);
await access(archivePath);
const packagedFiles = asar.listPackage(archivePath, { isPack: false })
  .map((name) => name.replace(/^\/+/, ''))
  .sort();
if (packagedFiles.join('\n') !== expectedFiles.join('\n')) {
  throw new Error(`Core app.asar 文件清单不匹配：${packagedFiles.join(', ')}`);
}
for (const name of packagedFiles) {
  const content = asar.extractFile(archivePath, name).toString('utf8');
  const found = findForbiddenToken(name, content);
  if (found) throw new Error(`Core app.asar 文件 ${name} 含有可选模块/API 标记：${found}`);
}
const profile = JSON.parse(asar.extractFile(archivePath, 'profile.json').toString('utf8'));
if (
  profile.profile !== 'core-only' ||
  profile.installable !== false ||
  profile.offlineCapability !== 'project-store-local-only' ||
  profile.workspaceCapability !== 'local-project-store-v1' ||
  profile.optionalRuntime !== 'not-present' ||
  profile.cadPreview?.mode !== 'read-only'
) {
  throw new Error('打包后的 Core profile 未保留未安装、离线与工作区状态声明');
}

console.log(`CORE_LINUX_PACKAGE_OK appDir=${outputDir} electron=${electronVersion} files=${packagedFiles.length} viewer=STL,GLB installable=false offline=project-store-local-only workspace=local-project-store-v1`);
