import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const root = join(testDir, '..');
const coreDir = join(root, 'electron', 'core');
const read = (name) => readFileSync(join(coreDir, name), 'utf8');
const forbidden = [
  'agent.resume', 'plcgen', 'elec.validation', 'cost.estimation',
  'factory.plc-sync', 'commission.io-test', 'cad.parametric-import',
  'parametric.history', 'project.portable', 'system.update',
  'electron-updater', 'node-opcua', 'modbus-serial', 'occt-import-js',
  'desktopApi', 'openCadDialog', 'agent:', 'plc:', 'plcgen:', 'factory:',
  'sync:', 'cost:', 'parametric:', 'update:', 'packs:', 'project-archive:',
  'fetch(', 'WebSocket(', 'http://', 'https://'
];

function importedSpecifiers(source) {
  return [...source.matchAll(/\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

test('Core main 仅静态依赖 Electron、Node 内置模块与本地项目存储', () => {
  const imports = importedSpecifiers(read('main.ts')).sort();
  assert.deepEqual(imports, ['./cad-preview-files.mjs', './module-staging.mjs', './project-store.mjs', 'electron', 'node:fs', 'node:os', 'node:path', 'node:url']);
  assert.match(read('main.ts'), /ipcMain\.handle\('core:status'/);
  for (const channel of ['core:projects:list', 'core:projects:create', 'core:projects:open', 'core:projects:save', 'core:projects:attachments:list', 'core:projects:attachments:add', 'core:projects:attachments:open', 'core:cad-preview:open', 'core:modules:catalog', 'core:modules:download', 'core:modules:remove-staged', 'core:modules:staged']) {
    assert.ok(read('main.ts').includes(`'${channel}'`), `缺少 allowlisted IPC ${channel}`);
  }
  assert.match(read('main.ts'), /event\.senderFrame\?\.url !== expectedPageUrl/);
  assert.match(read('main.ts'), /ipcMain\.handle\('core:modules:remove-staged', \(event, id: unknown, version: unknown\) => \{\s*assertTrustedCoreSender\(event\);\s*return getModuleStagingService\(\)\.removeStagedModule\(id, version\);/);
  assert.match(read('main.ts'), /sandbox:\s*true/);
  assert.match(read('main.ts'), /nodeIntegration:\s*false/);
  assert.match(read('main.ts'), /dialog\.showOpenDialog\(owner,\s*\{[\s\S]*properties:\s*\['openFile'\][\s\S]*extensions:\s*\['stl', 'glb'\]/);
  assert.match(read('main.ts'), /const file = await readCadPreviewFile\(filePath\)/);
  assert.match(read('main.ts'), /assertTrustedCoreSender\(event\);\s*let filePath/s);
});

test('Core preload 只暴露受限项目和模块操作，不提供路径或通用 IPC', () => {
  const source = read('preload.ts');
  assert.deepEqual(importedSpecifiers(source).sort(), ['./module-staging.mjs', './project-store.mjs', 'electron']);
  assert.match(source, /Object\.freeze\(\{\s*status:/);
  assert.match(source, /exposeInMainWorld\('coreRuntime',\s*coreRuntime\)/);
  const channels = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(channels, ['core:cad-preview:open', 'core:modules:catalog', 'core:modules:download', 'core:modules:remove-staged', 'core:modules:staged', 'core:projects:attachments:add', 'core:projects:attachments:list', 'core:projects:attachments:open', 'core:projects:create', 'core:projects:list', 'core:projects:open', 'core:projects:save', 'core:status']);
  assert.match(source, /openCadPreview:.*core:cad-preview:open/);
  assert.match(source, /addProjectCadPreview:.*core:projects:attachments:add/);
  assert.match(source, /openProjectCadPreview:.*core:projects:attachments:open/);
  assert.doesNotMatch(source, /ipcRenderer\.(?:send|sendSync|on)\(/);
  assert.doesNotMatch(source, /(?:filePath|directoryPath|arbitraryPath|readFile|writeFile)/i);
  assert.doesNotMatch(source, /(?:url|sourceUrl|fetch|http|https|path)/i);
});

test('Core renderer、HTML/CSS 与项目存储不引用完整版资源或网络能力', () => {
  const renderer = read('renderer.ts');
  const html = read('core.html');
  const projectStore = read('project-store.mjs');
  const moduleStaging = read('module-staging.mjs');
  assert.deepEqual(importedSpecifiers(renderer), ['./cad-preview-format.mjs']);
  assert.match(html, /src="\.\/renderer\.js"/);
  assert.match(html, /src="\.\/core-viewer\.js"/);
  assert.match(html, /href="\.\/core\.css"/);
  assert.match(html, /Content-Security-Policy[^>]*connect-src 'none'/);
  assert.match(html, /id="cad-preview-panel"/);
  assert.match(html, /id="open-cad-preview"/);
  assert.doesNotMatch(html, /(?:\.\.\/index\.html|app\.js|electrical\.js|styles\.css|electron\/preload)/);
  assert.match(renderer, /removeStagedModule\(module\.id, module\.version\)/);
  assert.match(renderer, /清理缓存包/);
  assert.match(renderer, /这不是模块卸载/);
  assert.match(html, /不解压、不运行、不安装或激活/);
  for (const [name, source] of [['main.ts', read('main.ts')], ['preload.ts', read('preload.ts')], ['renderer.ts', renderer], ['core-viewer.ts', read('core-viewer.ts')], ['cad-preview-format.mjs', read('cad-preview-format.mjs')], ['cad-preview-files.mjs', read('cad-preview-files.mjs')], ['core.html', html], ['core.css', read('core.css')], ['project-store.mjs', projectStore], ['module-staging.mjs', moduleStaging]]) {
    for (const token of forbidden) assert.equal(source.includes(token), false, `${name} 含可选标记 ${token}`);
  }
  assert.match(projectStore, /PROJECT_FORMAT = 'automationcad-core-project'/);
  assert.match(projectStore, /SCHEMA_VERSION = 1/);
  assert.match(projectStore, /await fileHandle\.sync\(\)/);
  assert.match(projectStore, /await this\.#replaceFile\(temporaryPath, targetPath\)/);
  assert.match(moduleStaging, /MAX_MODULE_CATALOG_BYTES = 256 \* 1024/);
  assert.match(moduleStaging, /MAX_MODULE_PACKAGE_BYTES = 50 \* 1024 \* 1024/);
  assert.match(moduleStaging, /MAX_STAGED_TOTAL_BYTES = 250 \* 1024 \* 1024/);
  assert.match(moduleStaging, /MAX_STAGED_PACKAGE_COUNT = 100/);
  assert.match(moduleStaging, /activation: 'blocked-until-trust-policy'/);
  assert.doesNotMatch(moduleStaging, /extractAllTo|eval\(|import\(.*module\.mjs/s);
});

test('Core 状态只声明本地项目存储可离线，不宣称完整工作区或安装器已验收', () => {
  const main = read('main.ts');
  const renderer = read('renderer.ts');
  assert.match(main, /optionalModules:\s*'not-bundled'/);
  assert.match(main, /installable:\s*false/);
  assert.match(main, /offlineCapability:\s*'project-store-local-only'/);
  assert.match(main, /workspaceCapability:\s*'local-project-store-v1'/);
  assert.match(main, /projectAttachments:\s*\{ schemaVersion: 1, formats: \['\.stl', '\.glb'\], maxBytes: 33_554_432, storage: 'sha256-immutable', mode: 'read-only' \}/);
  assert.match(main, /cadPreview:\s*\{ formats: \['\.stl', '\.glb'\], maxBytes: 33_554_432, mode: 'read-only' \}/);
  assert.match(renderer, /status\.workspaceCapability/);
  assert.match(renderer, /CoreCadViewer\.parseCadPreview/);
  assert.match(renderer, /当前预览保持不变/);
  assert.match(read('main.ts'), /CORE_MODULE_CATALOG_SOURCE: string \| null = null/);
  assert.match(read('core.html'), /不代表 CAD 建模/);
});
