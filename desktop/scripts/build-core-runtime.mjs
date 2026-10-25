import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const sourceDir = join(root, 'electron', 'core');
const outputArgument = process.argv.slice(2).find((argument) => argument.startsWith('--output-dir='));
if (process.argv.slice(2).length > (outputArgument ? 1 : 0)) throw new Error('用法：node scripts/build-core-runtime.mjs [--output-dir=dist-core-<fresh-name>]');
const outputDir = resolve(root, outputArgument?.slice('--output-dir='.length) ?? 'dist-core');
const relativeOutput = relative(root, outputDir);
if (outputArgument && (!relativeOutput || relativeOutput.startsWith(`..${sep}`) || relativeOutput === '..')) {
  throw new Error('显式 Core 输出目录必须位于 desktop/ 下。');
}
if (outputArgument) {
  try {
    await lstat(outputDir);
    throw new Error(`拒绝覆盖已存在的 Core runtime 输出：${outputDir}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const expectedFiles = [
  'core-main.cjs',
  'core-preload.cjs',
  'core.html',
  'core.css',
  'core-viewer.js',
  'renderer.js',
  'THREE-LICENSE.txt',
  'package.json',
  'profile.json'
].sort();
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
  'project-archive:',
  'fetch(',
  'WebSocket(',
  'http://',
  'https://'
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

await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [join(sourceDir, 'main.ts')],
  outfile: join(outputDir, 'core-main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  minify: true,
  legalComments: 'none'
});
await build({
  entryPoints: [join(sourceDir, 'preload.ts')],
  outfile: join(outputDir, 'core-preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  minify: true,
  legalComments: 'none'
});
await build({
  entryPoints: [join(sourceDir, 'renderer.ts')],
  outfile: join(outputDir, 'renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  sourcemap: false,
  minify: true,
  legalComments: 'none'
});
await build({
  entryPoints: [join(sourceDir, 'core-viewer.ts')],
  outfile: join(outputDir, 'core-viewer.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'CoreCadViewer',
  target: 'chrome120',
  sourcemap: false,
  minify: true,
  legalComments: 'none'
});
await copyFile(join(sourceDir, 'core.html'), join(outputDir, 'core.html'));
await copyFile(join(sourceDir, 'core.css'), join(outputDir, 'core.css'));
await copyFile(join(root, 'node_modules', 'three', 'LICENSE'), join(outputDir, 'THREE-LICENSE.txt'));
await writeFile(join(outputDir, 'package.json'), `${JSON.stringify({
  name: 'automationcad-core-runtime',
  productName: 'AutomationCAD Core',
  version: packageJson.version,
  private: true,
  type: 'commonjs',
  main: 'core-main.cjs',
  description: '独立 Core Electron 运行时验证包；含受限 STL/GLB 只读预览，不是生产安装包。'
}, null, 2)}\n`);

const artifactNames = expectedFiles.filter((name) => name !== 'profile.json');
const artifacts = {};
for (const name of artifactNames) {
  const bytes = await readFile(join(outputDir, name));
  artifacts[name] = {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  const text = bytes.toString('utf8');
  const found = findForbiddenToken(name, text);
  if (found) throw new Error(`Core 独立运行时产物 ${name} 包含可选模块/API 标记：${found}`);
}

const profile = {
  format: 'automationcad-core-runtime-profile',
  schemaVersion: 1,
  profile: 'core-only',
  runtime: 'separate-electron-shell',
  entry: 'core-main.cjs',
  preload: 'core-preload.cjs',
  page: 'core.html',
  renderer: 'renderer.js',
  apiVersion: 1,
  exposedBridgeMethods: ['status', 'listProjects', 'createProject', 'openProject', 'saveProject', 'listModules', 'downloadModule', 'listStagedModules', 'removeStagedModule', 'openCadPreview', 'listProjectCadPreviews', 'addProjectCadPreview', 'openProjectCadPreview'],
  cadPreview: { formats: ['.stl', '.glb'], maxBytes: 33_554_432, maxTriangles: 500_000, maxVertices: 1_000_000, mode: 'read-only', glb: 'static-untextured-triangle-mesh-subset' },
  projectAttachments: { schemaVersion: 1, formats: ['.stl', '.glb'], maxBytes: 33_554_432, storage: 'sha256-immutable', mode: 'read-only' },
  optionalRuntime: 'not-present',
  installable: false,
  offlineCapability: 'project-store-local-only',
  workspaceCapability: 'local-project-store-v1',
  authenticity: 'unsigned-build-artifact',
  artifacts
};
await writeFile(join(outputDir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listFiles(fullPath));
    else paths.push(relative(outputDir, fullPath).split(sep).join('/'));
  }
  return paths.sort();
}
const actualFiles = await listFiles(outputDir);
if (actualFiles.join('\n') !== expectedFiles.join('\n')) {
  throw new Error(`Core 独立运行时文件清单不匹配：${actualFiles.join(', ')}`);
}
for (const name of actualFiles) {
  const text = (await readFile(join(outputDir, name))).toString('utf8');
  const found = findForbiddenToken(name, text);
  if (found) throw new Error(`Core 独立运行时文件 ${name} 包含可选模块/API 标记：${found}`);
}
console.log(`CORE_RUNTIME_BUILD_OK files=${actualFiles.length} entry=core-main.cjs preload=core-preload.cjs viewer=core-viewer.js formats=stl,glb bridge=project-store-v1,module-staging-v1,cad-preview catalog=unconfigured activation=blocked optional=absent installable=false offline=project-store-local-only`);
