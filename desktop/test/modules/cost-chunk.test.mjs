// 成本分块的契约：临时配置构建出的真实产物必须交出 initCostPanel，并自注册正确的 id/API。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks } from '../../scripts/build-module-chunks.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('cost.estimation 分块产物交出 initCostPanel 并自注册', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'cad-cost-chunk-'));
  try {
    const configPath = join(tempRoot, 'chunks.json');
    const outDir = join(tempRoot, 'out');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      chunks: { 'cost.estimation': 'src/modules/chunks/cost-estimation.ts' }
    }), 'utf8');

    const { manifest } = await buildChunks({
      configPath,
      outDir,
      root: desktopRoot,
      registry: MODULE_REGISTRY,
      moduleApiVersion: MODULE_API_VERSION
    });
    const entry = manifest.chunks.find((chunk) => chunk.id === 'cost.estimation');
    assert.ok(entry, '临时配置必须产出 cost.estimation 分块');

    const source = await readFile(join(outDir, entry.file), 'utf8');
    const registrations = [];
    const sandbox = { __cadRegisterModuleChunk: (payload) => registrations.push(payload) };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);

    assert.equal(registrations.length, 1, '分块必须自注册一次');
    assert.equal(registrations[0].id, 'cost.estimation');
    assert.equal(registrations[0].apiVersion, MODULE_API_VERSION);
    assert.equal(typeof registrations[0].exports.initCostPanel, 'function', '分块必须导出 initCostPanel');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
