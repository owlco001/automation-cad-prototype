// 工程图分块的契约：真实产物必须交出 initDrawingsUi，且核心包不再包含它。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks, DEFAULT_CONFIG_PATH } from '../../scripts/build-module-chunks.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('drawings.techdraw 分块产物交出 initDrawingsUi 并自注册', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'cad-drawings-chunk-'));
  try {
    const { manifest } = await buildChunks({
      configPath: DEFAULT_CONFIG_PATH, outDir, root: desktopRoot,
      registry: MODULE_REGISTRY, moduleApiVersion: MODULE_API_VERSION
    });
    const entry = manifest.chunks.find((chunk) => chunk.id === 'drawings.techdraw');
    assert.ok(entry, '生产配置必须声明工程图分块');
    const source = await readFile(join(outDir, entry.file), 'utf8');
    const registrations = [];
    const sandbox = { __cadRegisterModuleChunk: (payload) => registrations.push(payload) };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, 'drawings.techdraw');
    assert.equal(registrations[0].apiVersion, MODULE_API_VERSION);
    assert.equal(typeof registrations[0].exports.initDrawingsUi, 'function', '分块必须导出 initDrawingsUi');
    // 核心包不得再包含工程图代码（标记由 modules/chunks.json 的 coreMustNotContain 声明）
    const corePath = join(desktopRoot, 'dist', 'extension.js');
    const core = await readFile(corePath, 'utf8').catch(() => null);
    if (core !== null) {
      assert.equal(core.includes('automationcad.drawings.v1'), false, '工程图代码不应回到核心包');
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
