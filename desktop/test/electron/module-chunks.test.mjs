// 主进程侧分块读取：白名单 + 字节数 + sha256，任一不符都不交付源码。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MODULE_API_VERSION, MODULE_REGISTRY } from '../../src/modules/registry.ts';
import { buildChunks } from '../../scripts/build-module-chunks.mjs';
import { ModuleChunkReader } from '../../electron/module-chunks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '../..');
const probeConfig = resolve(desktopRoot, 'test-support/module-chunk-probe.config.json');

async function builtChunks() {
  const outDir = await mkdtemp(join(tmpdir(), 'cad-chunk-reader-'));
  const { manifest } = await buildChunks({
    configPath: probeConfig, outDir, root: desktopRoot,
    registry: MODULE_REGISTRY, moduleApiVersion: MODULE_API_VERSION
  });
  return { outDir, manifest, entry: manifest.chunks[0] };
}

test('读取合法分块：返回源码与清单条目', async () => {
  const { outDir, entry } = await builtChunks();
  try {
    const reader = new ModuleChunkReader({ rootDir: outDir });
    const result = reader.read('agent.resume');
    assert.equal(result.ok, true);
    assert.equal(result.entry.file, entry.file);
    assert.equal(Buffer.byteLength(result.source, 'utf8'), entry.bytes);
    assert.equal(createHash('sha256').update(result.source, 'utf8').digest('hex'), entry.sha256);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('未声明 id 不交付源码', async () => {
  const { outDir } = await builtChunks();
  try {
    const reader = new ModuleChunkReader({ rootDir: outDir });
    const result = reader.read('plcgen');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CHUNK_NOT_DECLARED');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('清单缺失或损坏时不交付源码', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'cad-chunk-empty-'));
  try {
    assert.equal(new ModuleChunkReader({ rootDir: empty }).read('agent.resume').code, 'CHUNK_MANIFEST_UNAVAILABLE');
    await writeFile(join(empty, 'manifest.json'), '{ not json', 'utf8');
    assert.equal(new ModuleChunkReader({ rootDir: empty }).read('agent.resume').code, 'CHUNK_MANIFEST_UNAVAILABLE');
    await writeFile(join(empty, 'manifest.json'), JSON.stringify({ schemaVersion: 1, moduleApiVersion: 1, chunks: [{ id: 'agent.resume', apiCompatibility: { min: 1, max: 1 }, file: '../escape.js', bytes: 1, sha256: 'a'.repeat(64) }] }), 'utf8');
    assert.equal(new ModuleChunkReader({ rootDir: empty }).read('agent.resume').code, 'CHUNK_MANIFEST_UNAVAILABLE', '清单本身非法（路径穿越）应整份拒绝');
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('分块文件缺失、被篡改、字节数不符都拒绝交付', async () => {
  const { outDir, entry } = await builtChunks();
  try {
    const path = join(outDir, entry.file);
    const original = await readFile(path, 'utf8');

    await writeFile(path, `${original} /* tampered */`, 'utf8');
    assert.equal(new ModuleChunkReader({ rootDir: outDir }).read('agent.resume').code, 'CHUNK_SIZE_MISMATCH');

    // 改成同样长度但内容不同：只有哈希能发现
    const sameLength = `${original.slice(0, -1)}${original.endsWith(';') ? '!' : ';'}`;
    assert.equal(Buffer.byteLength(sameLength, 'utf8'), entry.bytes);
    await writeFile(path, sameLength, 'utf8');
    assert.equal(new ModuleChunkReader({ rootDir: outDir }).read('agent.resume').code, 'CHUNK_HASH_MISMATCH');

    await rm(path);
    assert.equal(new ModuleChunkReader({ rootDir: outDir }).read('agent.resume').code, 'CHUNK_UNAVAILABLE');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
