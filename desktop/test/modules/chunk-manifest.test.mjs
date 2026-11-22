// 分块清单校验的口径：清单是白名单，任何一处不合法整份拒绝。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODULE_CHUNK_SCHEMA_VERSION,
  apiCompatible,
  findChunk,
  validateManifest,
  validateRegistration
} from '../../src/modules/chunk-manifest.ts';

const ENTRY = {
  id: 'cost.estimation',
  apiCompatibility: { min: 1, max: 2 },
  file: 'cost.estimation.js',
  bytes: 1024,
  sha256: 'a'.repeat(64)
};
const manifest = () => ({
  schemaVersion: MODULE_CHUNK_SCHEMA_VERSION,
  moduleApiVersion: 1,
  chunks: [{ ...ENTRY }]
});

test('合法清单通过并按原样保留条目', () => {
  const result = validateManifest(manifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.chunks, [ENTRY]);
});

test('结构/版本/字段非法一律整份拒绝', () => {
  const cases = [
    ['非对象', 'nope'],
    ['版本不符', { ...manifest(), schemaVersion: 2 }],
    ['moduleApiVersion 非法', { ...manifest(), moduleApiVersion: 0 }],
    ['chunks 不是数组', { ...manifest(), chunks: {} }],
    ['条目不是对象', { ...manifest(), chunks: ['x'] }],
    ['id 为空', { ...manifest(), chunks: [{ ...ENTRY, id: '' }] }],
    ['id 重复', { ...manifest(), chunks: [{ ...ENTRY }, { ...ENTRY }] }],
    ['缺 apiCompatibility', { ...manifest(), chunks: [{ ...ENTRY, apiCompatibility: undefined }] }],
    ['apiCompatibility 反向', { ...manifest(), chunks: [{ ...ENTRY, apiCompatibility: { min: 2, max: 1 } }] }],
    ['文件名带路径', { ...manifest(), chunks: [{ ...ENTRY, file: '../evil.js' }] }],
    ['字节数非法', { ...manifest(), chunks: [{ ...ENTRY, bytes: 0 }] }],
    ['哈希不是 64 位十六进制', { ...manifest(), chunks: [{ ...ENTRY, sha256: 'ZZZ' }] }]
  ];
  for (const [label, raw] of cases) {
    const result = validateManifest(raw);
    assert.equal(result.ok, false, label);
    assert.ok(result.message.length > 0, label);
  }
});

test('findChunk 按 id 精确匹配；apiCompatible 是闭区间', () => {
  const result = validateManifest(manifest());
  assert.equal(result.ok, true);
  const parsed = result.manifest;
  assert.equal(findChunk(parsed, 'cost.estimation')?.file, 'cost.estimation.js');
  assert.equal(findChunk(parsed, 'cost'), undefined);
  const entry = parsed.chunks[0];
  assert.equal(apiCompatible(entry, 1), true);
  assert.equal(apiCompatible(entry, 2), true);
  assert.equal(apiCompatible(entry, 3), false);
  assert.equal(apiCompatible(entry, 0), false);
});

test('自注册必须与清单一致的 id 与 API 版本，且带 exports', () => {
  const expected = { id: 'cost.estimation', moduleApiVersion: 1 };
  const ok = validateRegistration({ id: 'cost.estimation', apiVersion: 1, exports: { a: 1 } }, expected);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.registration.exports, { a: 1 });

  const bad = [
    ['没有注册内容', undefined],
    ['id 不符', { id: 'plcgen', apiVersion: 1, exports: {} }],
    ['API 版本不符', { id: 'cost.estimation', apiVersion: 2, exports: {} }],
    ['缺 exports', { id: 'cost.estimation', apiVersion: 1 }]
  ];
  for (const [label, payload] of bad) {
    assert.equal(validateRegistration(payload, expected).ok, false, label);
  }
});
