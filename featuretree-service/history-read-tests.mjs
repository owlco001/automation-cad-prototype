// 轻量树读取与历史分页的行为验收（真起 HTTP 服务，FT_PORT=0）。
//
// 重点：默认响应必须与原来完全一致 —— Qt 客户端和 MCP 都按「整段 history」在消费；
// 新能力只在显式传参时生效。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let child;
let base;

const json = async (path, init) => {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json() };
};
const edit = (revision, height) => json('/v1/operations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    documentId: 'demo-adapter', expectedRevision: revision, actor: 'manual',
    operation: 'updateFeatureParams', featureId: 'f-body', patch: { height }
  })
});

before(async () => {
  child = spawn(process.execPath, [resolve(here, 'server.mjs')], {
    env: { ...process.env, FT_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) base = match[0];
    else await sleep(100);
  }
  if (!base) throw new Error(`服务未起来：${log.slice(0, 200)}`);
  // 造出可观察的历史长度
  for (let index = 0; index < 7; index += 1) {
    const result = await edit(index, 12 + index);
    assert.equal(result.status, 200);
  }
});

after(async () => {
  if (!child) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) return;
    await sleep(50);
  }
  child.kill('SIGKILL');
});

test('默认 /v1/tree 仍是完整包络（含 history，且没有 historyOmitted）', async () => {
  const { status, body } = await json('/v1/tree');
  assert.equal(status, 200);
  assert.equal(body.revision, 7);
  assert.equal(body.history.length, 7);
  assert.equal(Object.hasOwn(body, 'historyOmitted'), false);
  assert.equal(body.undoDepth, 7);
});

test('includeHistory=0 返回同样的树，但不带 history 并显式标注', async () => {
  const full = await json('/v1/tree');
  const light = await json('/v1/tree?includeHistory=0');
  assert.equal(light.status, 200);
  assert.deepEqual(light.body.doc, full.body.doc);
  assert.equal(light.body.revision, full.body.revision);
  assert.equal(light.body.undoDepth, full.body.undoDepth);
  assert.equal(light.body.redoDepth, full.body.redoDepth);
  assert.deepEqual(light.body.geometry, full.body.geometry);
  assert.equal(Object.hasOwn(light.body, 'history'), false);
  assert.equal(light.body.historyOmitted, true);
  const lightBytes = Buffer.byteLength(JSON.stringify(light.body));
  const fullBytes = Buffer.byteLength(JSON.stringify(full.body));
  assert.ok(lightBytes < fullBytes, `轻量响应应更小：${lightBytes} vs ${fullBytes}`);
});

test('includeHistory 只接受 0/1，其他取值 422', async () => {
  for (const raw of ['2', 'yes', '', '0.0']) {
    const { status, body } = await json(`/v1/tree?includeHistory=${raw}`);
    assert.equal(status, 422, `includeHistory=${raw}`);
    assert.equal(body.error, 'VALIDATION_FAILED');
  }
  assert.equal((await json('/v1/tree?includeHistory=1')).status, 200);
});

test('默认 /v1/revisions 仍是整段历史（不带分页字段）', async () => {
  const { status, body } = await json('/v1/revisions');
  assert.equal(status, 200);
  assert.equal(body.revision, 7);
  assert.equal(body.history.length, 7);
  assert.equal(Object.hasOwn(body, 'entries'), false);
});

test('分页窗口连续、不重叠、可拼接出完整历史', async () => {
  const pages = [];
  let offset = 0;
  for (;;) {
    const { status, body } = await json(`/v1/revisions?limit=3&offset=${offset}`);
    assert.equal(status, 200);
    assert.equal(body.total, 7);
    assert.ok(body.entries.length > 0, '每一页都应有内容');
    pages.push(...body.entries);
    if (body.nextOffset === null) break;
    assert.equal(body.nextOffset, offset + body.entries.length);
    offset = body.nextOffset;
  }
  const full = await json('/v1/revisions');
  assert.deepEqual(pages, full.body.history, '分页拼接结果必须与整段历史完全一致');
});

test('offset 越界返回空页而不是报错；边界页仍带 nextOffset', async () => {
  const beyond = await json('/v1/revisions?limit=5&offset=99');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.entries, []);
  assert.equal(beyond.body.nextOffset, null);
  assert.equal(beyond.body.total, 7);

  const firstPage = await json('/v1/revisions?limit=5&offset=0');
  assert.equal(firstPage.body.entries.length, 5);
  assert.equal(firstPage.body.nextOffset, 5);
  const lastPage = await json('/v1/revisions?limit=5&offset=5');
  assert.equal(lastPage.body.entries.length, 2);
  assert.equal(lastPage.body.nextOffset, null);
});

test('非法分页参数 422（含 offset 单独出现）', async () => {
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=2', 'limit=3&offset=-1', 'limit=3&offset=x']) {
    const { status, body } = await json(`/v1/revisions?${query}`);
    assert.equal(status, 422, query);
    assert.equal(body.error, 'VALIDATION_FAILED', query);
  }
  assert.equal((await json('/v1/revisions?limit=500')).status, 200);
});
