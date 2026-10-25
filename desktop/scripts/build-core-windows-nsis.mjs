import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  assertCoreWindowsNsisOutputIsFresh,
  coreWindowsNsisOutputRelativeToRuntime,
  inspectCoreWindowsPackage,
  resolveCoreWindowsNsisOutput,
  validateCoreRuntimeDirectory,
  validateCoreWindowsNsisConfig
} from './core-windows-nsis-contract.mjs';

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(scriptDir, '..');
const configPath = join(root, 'electron-builder.core.nsis.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const configPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const outputArgs = args.filter((argument) => argument.startsWith('--output-dir='));
const runtimeArgs = args.filter((argument) => argument.startsWith('--runtime-dir='));
if (outputArgs.length > 1 || runtimeArgs.length > 1 || args.some((argument) => argument !== '--check-only' && !argument.startsWith('--output-dir=') && !argument.startsWith('--runtime-dir='))) {
  throw new Error('用法：node scripts/build-core-windows-nsis.mjs [--check-only] [--runtime-dir=dist-core-<fresh-name>] [--output-dir=release/<新目录名>]');
}
if (process.platform !== 'linux' && process.platform !== 'win32') {
  throw new Error(`Windows NSIS 构建只支持 Windows/Linux 主机；当前为 ${process.platform}`);
}

const runtimeDir = resolve(root, runtimeArgs[0]?.slice('--runtime-dir='.length) ?? 'dist-core');
const runtimeRelative = relative(root, runtimeDir);
if (!runtimeRelative || runtimeRelative === '..' || runtimeRelative.startsWith(`..${sep}`)) throw new Error('Core Windows runtime 必须位于 desktop/ 下。');
const outputArgument = outputArgs[0]?.slice('--output-dir='.length) || 'release/core-runtime-windows-nsis';
const outputDir = resolveCoreWindowsNsisOutput(root, outputArgument);
validateCoreWindowsNsisConfig(config);
const runtime = validateCoreRuntimeDirectory(runtimeDir);
assertCoreWindowsNsisOutputIsFresh(outputDir);

const builderArgs = [
  '--win',
  'nsis',
  '--x64',
  '--projectDir',
  runtimeDir,
  '--config',
  configPath,
  `--config.electronVersion=${electronPackage.version}`,
  `--config.directories.output=${coreWindowsNsisOutputRelativeToRuntime(runtimeDir, outputDir)}`,
  '--publish=never'
];

if (checkOnly) {
  console.log(`CORE_WINDOWS_NSIS_PREFLIGHT_OK app=${runtime.packageJson.name} version=${configPackage.version} electron=${electronPackage.version} target=win32-x64/nsis files=${Object.keys(runtime.profile.artifacts).length + 1} output=${outputDir} action=build-not-run downloads=none`);
  process.exit(0);
}

console.log(`CORE_WINDOWS_NSIS_BUILD_START target=win32-x64/nsis projectDir=dist-core output=${outputDir} publish=never signing=disabled`);
const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules', 'electron-builder', 'cli.js'), ...builderArgs], {
    cwd: root,
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('close', (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) throw new Error(`electron-builder 退出码：${exitCode}`);

const appDir = join(outputDir, 'win-unpacked');
const installerPath = join(outputDir, `AutomationCAD-Core-Setup-${runtime.packageJson.version}.exe`);
const result = inspectCoreWindowsPackage({ appDir, installerPath });
console.log(`CORE_WINDOWS_NSIS_PACKAGE_OK target=win32-x64/nsis installer=${installerPath} installerBytes=${result.installerBytes} appDirBytes=${result.appDirBytes} appAsarBytes=${result.appAsarBytes} files=${result.appFiles} signed=false installable=false offline=project-store-local-only workspace=local-project-store-v1`);
