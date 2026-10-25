import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import asar from '@electron/asar';

export const CORE_RUNTIME_FILES = Object.freeze([
  'core-main.cjs',
  'core-preload.cjs',
  'core.css',
  'core.html',
  'core-viewer.js',
  'package.json',
  'profile.json',
  'THREE-LICENSE.txt',
  'renderer.js'
].sort());

export const CORE_ARTIFACT_FILES = Object.freeze(
  CORE_RUNTIME_FILES.filter((name) => name !== 'profile.json')
);

const FORBIDDEN_MARKERS = Object.freeze([
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
  'project-archive:',
  'fetch(',
  'WebSocket(',
  'http://',
  'https://'
]);

const FORBIDDEN_APP_PATHS = Object.freeze([
  'app.js',
  'dist',
  'dist-electron',
  'electrical.css',
  'electrical.js',
  'index.html',
  'packs',
  'parametric',
  'styles.css',
  'web'
]);

function assertCoreProfile(profile, context) {
  if (
    profile?.format !== 'automationcad-core-runtime-profile' ||
    profile?.schemaVersion !== 1 ||
    profile?.profile !== 'core-only' ||
    profile?.runtime !== 'separate-electron-shell' ||
    profile?.entry !== 'core-main.cjs' ||
    profile?.preload !== 'core-preload.cjs' ||
    profile?.page !== 'core.html' ||
    profile?.renderer !== 'renderer.js' ||
    profile?.optionalRuntime !== 'not-present' ||
    profile?.installable !== false ||
    profile?.authenticity !== 'unsigned-build-artifact' ||
    profile?.offlineCapability !== 'project-store-local-only' ||
    profile?.workspaceCapability !== 'local-project-store-v1' ||
    profile?.cadPreview?.formats?.join(',') !== '.stl,.glb' ||
    profile?.cadPreview?.maxBytes !== 33_554_432 ||
    profile?.cadPreview?.maxTriangles !== 500_000 ||
    profile?.cadPreview?.maxVertices !== 1_000_000 ||
    profile?.cadPreview?.mode !== 'read-only' ||
    profile?.cadPreview?.glb !== 'static-untextured-triangle-mesh-subset' ||
    !profile?.exposedBridgeMethods?.includes('openCadPreview') ||
    !profile?.exposedBridgeMethods?.includes('listProjectCadPreviews') ||
    !profile?.exposedBridgeMethods?.includes('addProjectCadPreview') ||
    !profile?.exposedBridgeMethods?.includes('openProjectCadPreview') ||
    profile?.projectAttachments?.schemaVersion !== 1 ||
    profile?.projectAttachments?.formats?.join(',') !== '.stl,.glb' ||
    profile?.projectAttachments?.maxBytes !== 33_554_432 ||
    profile?.projectAttachments?.storage !== 'sha256-immutable' ||
    profile?.projectAttachments?.mode !== 'read-only'
  ) {
    throw new Error(`${context} 中 Core profile 的边界声明不匹配或宣称可安装。`);
  }
}

function assertArtifactHashes(profile, readArtifact, context) {
  const declaredNames = Object.keys(profile.artifacts ?? {}).sort();
  if (declaredNames.join('\n') !== CORE_ARTIFACT_FILES.join('\n')) {
    throw new Error(`${context} 中 Core profile 的 artifacts 清单不匹配。`);
  }
  for (const name of CORE_ARTIFACT_FILES) {
    const bytes = readArtifact(name);
    const metadata = profile.artifacts[name];
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (metadata?.bytes !== bytes.byteLength || metadata?.sha256 !== sha256) {
      throw new Error(`${context} 中 Core 文件 ${name} 与 profile 摘要不匹配。`);
    }
    const marker = findForbiddenMarker(name, bytes.toString('utf8'));
    if (marker) throw new Error(`${context} 中 ${name} 含可选模块/API 标记：${marker}`);
  }
}

function findForbiddenMarker(name, source) {
  if (name === 'THREE-LICENSE.txt') return null;
  const scanText = name === 'core-viewer.js'
    ? source.replaceAll('http://www.w3.org/1999/xhtml', '').replaceAll('https://jcgt.org/published/0007/04/01/', '')
    : source;
  return FORBIDDEN_MARKERS.find((candidate) => {
    if (name === 'core-viewer.js' && candidate === 'update:') return false;
    return candidate === 'sync:' ? /(^|[^A-Za-z0-9_])sync:/u.test(scanText) : scanText.includes(candidate);
  }) ?? null;
}

export function validateCoreWindowsNsisConfig(config) {
  const declaredFiles = Array.isArray(config?.files)
    ? config.files.map((entry) => typeof entry === 'string' ? entry : `${entry?.from ?? ''}:${entry?.to ?? ''}`).sort()
    : [];
  if (
    config?.appId !== 'cn.automationcad.core.runtime' ||
    config?.productName !== 'AutomationCAD Core' ||
    config?.asar !== true ||
    declaredFiles.join('\n') !== CORE_RUNTIME_FILES.join('\n') ||
    config.extraResources !== undefined ||
    config.extraFiles !== undefined ||
    config.publish !== undefined ||
    config?.win?.signAndEditExecutable !== false ||
    config?.win?.target?.length !== 1 ||
    config.win.target[0].target !== 'nsis' ||
    config.win.target[0].arch?.join(',') !== 'x64' ||
    config?.nsis?.oneClick !== false ||
    config.nsis.allowToChangeInstallationDirectory !== true ||
    config.nsis.differentialPackage !== false ||
    config.nsis.artifactName !== 'AutomationCAD-Core-Setup-${version}.${ext}'
  ) {
    throw new Error('Core Windows NSIS 配置偏离独立 Core 白名单或安装器边界。');
  }
  return true;
}

export function resolveCoreWindowsNsisOutput(root, outputArgument = 'release/core-runtime-windows-nsis') {
  const absoluteRoot = resolve(root);
  const releaseRoot = resolve(absoluteRoot, 'release');
  const outputDir = resolve(absoluteRoot, outputArgument);
  const relativeOutput = relative(releaseRoot, outputDir);
  if (
    outputDir === releaseRoot ||
    !outputDir.startsWith(`${releaseRoot}${sep}`) ||
    relativeOutput.includes(sep) ||
    (lstatSync(releaseRoot, { throwIfNoEntry: false })?.isSymbolicLink() ?? false)
  ) {
    throw new Error('Core Windows NSIS 输出必须是 desktop/release/ 下的新一级子目录，且不能经由符号链接。');
  }
  return outputDir;
}

export function assertCoreWindowsNsisOutputIsFresh(outputDir) {
  try {
    const existing = lstatSync(outputDir);
    const kind = existing.isDirectory() ? '目录' : '路径';
    throw new Error(`拒绝覆盖已存在的 Core Windows NSIS 输出${kind}：${outputDir}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function validateCoreRuntimeDirectory(runtimeDir) {
  const entries = readdirSync(runtimeDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('dist-core 必须是只含扁平 Core runtime 文件的目录。');
  }
  const actualFiles = entries.map((entry) => entry.name).sort();
  if (actualFiles.join('\n') !== CORE_RUNTIME_FILES.join('\n')) {
    throw new Error(`dist-core 文件清单不匹配：${actualFiles.join(', ')}`);
  }
  const packageJson = JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8'));
  if (
    packageJson.name !== 'automationcad-core-runtime' ||
    packageJson.productName !== 'AutomationCAD Core' ||
    packageJson.main !== 'core-main.cjs' ||
    packageJson.type !== 'commonjs'
  ) {
    throw new Error('dist-core package metadata 与独立 Core 运行时不匹配。');
  }
  const profile = JSON.parse(readFileSync(join(runtimeDir, 'profile.json'), 'utf8'));
  assertCoreProfile(profile, 'dist-core');
  assertArtifactHashes(profile, (name) => readFileSync(join(runtimeDir, name)), 'dist-core');
  return { packageJson, profile };
}

export function inspectCoreWindowsPackage({ appDir, installerPath }) {
  const appDirStat = statSync(appDir);
  if (!appDirStat.isDirectory()) throw new Error(`Windows unpacked app 不是目录：${appDir}`);
  assertNoForbiddenAppPaths(appDir);
  const archivePath = join(appDir, 'resources', 'app.asar');
  const archiveFiles = asar.listPackage(archivePath, { isPack: false })
    .map((name) => name.replace(/^\/+/, ''))
    .sort();
  if (archiveFiles.join('\n') !== CORE_RUNTIME_FILES.join('\n')) {
    throw new Error(`Windows app.asar 文件清单不匹配：${archiveFiles.join(', ')}`);
  }
  const readArtifact = (name) => asar.extractFile(archivePath, name);
  const packageJson = JSON.parse(readArtifact('package.json').toString('utf8'));
  if (
    packageJson.name !== 'automationcad-core-runtime' ||
    packageJson.productName !== 'AutomationCAD Core' ||
    packageJson.main !== 'core-main.cjs'
  ) {
    throw new Error('Windows app.asar 中的 package metadata 与 Core 入口不匹配。');
  }
  const profile = JSON.parse(readArtifact('profile.json').toString('utf8'));
  assertCoreProfile(profile, 'Windows app.asar');
  assertArtifactHashes(profile, readArtifact, 'Windows app.asar');

  const installerStat = statSync(installerPath);
  if (!installerStat.isFile() || installerStat.size <= 0 || !installerPath.toLowerCase().endsWith('.exe')) {
    throw new Error(`NSIS installer 不存在、为空或不是 EXE：${installerPath}`);
  }
  return {
    installerBytes: installerStat.size,
    appDirBytes: directoryBytes(appDir),
    appAsarBytes: statSync(archivePath).size,
    appFiles: archiveFiles.length,
    appVersion: packageJson.version
  };
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(fullPath);
    else if (entry.isFile()) total += statSync(fullPath).size;
  }
  return total;
}

function assertNoForbiddenAppPaths(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (FORBIDDEN_APP_PATHS.includes(entry.name)) {
      throw new Error(`Windows unpacked app 中出现完整版资源：${entry.name}`);
    }
    if (entry.isDirectory()) assertNoForbiddenAppPaths(join(directory, entry.name));
  }
}

export function coreWindowsNsisOutputRelativeToRuntime(runtimeDir, outputDir) {
  return relative(runtimeDir, outputDir).split(sep).join('/');
}
