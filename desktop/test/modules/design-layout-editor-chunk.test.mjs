// 布局编辑分块的契约：临时配置构建出的真实产物必须交出 openLayoutEditor/setLayoutEditorEnabled，
// 自注册正确的 id/API，并且核心源码与重建后的核心包里不再保留该 UI 的稳定标识。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as THREE from 'three';
import test from 'node:test';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks } from '../../scripts/build-module-chunks.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 只属于整机布局 3D 编辑器工具栏的元素属性；不用短分词，避免核心包偶然命中。 */
const MARKER = 'data-le-array-pitch';

test('design.layout-editor 分块产物交出 openLayoutEditor 并自注册，核心源码不再含 UI 标记', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'cad-layout-editor-chunk-'));
  try {
    const configPath = join(tempRoot, 'chunks.json');
    const outDir = join(tempRoot, 'out');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      chunks: { 'design.layout-editor': 'src/modules/chunks/design-layout-editor.ts' }
    }), 'utf8');

    const { manifest } = await buildChunks({
      configPath,
      outDir,
      root: desktopRoot,
      registry: MODULE_REGISTRY,
      moduleApiVersion: MODULE_API_VERSION
    });
    const entry = manifest.chunks.find((chunk) => chunk.id === 'design.layout-editor');
    assert.ok(entry, '临时配置必须产出 design.layout-editor 分块');

    const source = await readFile(join(outDir, entry.file), 'utf8');
    assert.ok(source.includes(MARKER), `分块必须真的包含布局编辑 UI（标记 ${MARKER}）`);
    const coreSource = await readFile(join(desktopRoot, 'src/extension.ts'), 'utf8');
    assert.equal(coreSource.includes(MARKER), false, `核心源码不得再包含布局编辑 UI 标记 ${MARKER}`);
    // 产物存在时也重核一次：源码干净但 bundle 里残留旧代码，同样算迁移失败。
    const coreBundle = await readFile(join(desktopRoot, 'dist', 'extension.js'), 'utf8').catch(() => null);
    if (coreBundle !== null) {
      assert.equal(coreBundle.includes(MARKER), false, `重建后的核心包不得包含布局编辑 UI 标记 ${MARKER}`);
    }

    const registrations = [];
    const sandbox = { __cadRegisterModuleChunk: (payload) => registrations.push(payload), __cadSharedDeps: { THREE } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);

    assert.equal(registrations.length, 1, '分块必须自注册一次');
    assert.equal(registrations[0].id, 'design.layout-editor');
    assert.equal(registrations[0].apiVersion, MODULE_API_VERSION);
    assert.equal(typeof registrations[0].exports.openLayoutEditor, 'function', '分块必须导出 openLayoutEditor');
    assert.equal(
      typeof registrations[0].exports.setLayoutEditorEnabled,
      'function',
      '分块必须导出 setLayoutEditorEnabled'
    );
    assert.ok(entry.bytes > 0, '分块字节数必须为正数');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
