// 多文档验收：一个服务进程里多份文档，互不影响；默认文档 demo-adapter 行为不变。
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const child = spawn(process.execPath, [resolve(here, 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
});
let log = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { log += chunk; });
let BASE = '';
for (let attempt = 0; attempt < 100 && !BASE; attempt += 1) {
  const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) BASE = `http://127.0.0.1:${match[1]}`;
  else await sleep(100);
}

let n = 0;
const failures = [];
const ok = (cond, label, extra = '') => {
  n += 1;
  if (cond) { console.log(`PASS ${n}: ${label}`); return; }
  failures.push(label);
  console.error(`FAIL ${n}: ${label} ${extra}`);
};

const req = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

const heightOf = (envelope) => envelope.doc.features.find((f) => f.id === 'f-body').params.height;

try {
  const list = await req('GET', '/v1/documents');
  ok(list.status === 200 && list.json.documents.some((d) => d.documentId === 'demo-adapter'),
    '文档列表里有默认文档 demo-adapter', JSON.stringify(list.json).slice(0, 120));

  const created = await req('POST', '/v1/documents', { documentId: 'doc-b' });
  ok(created.status === 201 && created.json.documentId === 'doc-b' && created.json.revision === 0,
    '新建文档 doc-b（revision 0）', JSON.stringify(created.json).slice(0, 120));

  const wrote = await req('POST', '/v1/operations', {
    documentId: 'doc-b', expectedRevision: 0, actor: 'manual',
    operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 30 }
  });
  ok(wrote.status === 200 && wrote.json.revision === 1 && heightOf(wrote.json) === 30,
    'doc-b 写成功（r1 / 高度 30）', JSON.stringify(wrote.json).slice(0, 100));

  const other = await req('GET', '/v1/tree?documentId=demo-adapter');
  ok(other.json.revision === 0 && heightOf(other.json) === 12,
    '默认文档完全不受影响（r0 / 高度 12）', `r=${other.json.revision} h=${heightOf(other.json)}`);

  const docB = await req('GET', '/v1/tree?documentId=doc-b');
  ok(docB.json.revision === 1 && heightOf(docB.json) === 30, '按 documentId 读到的是 doc-b 的树');

  const dup = await req('POST', '/v1/documents', { documentId: 'doc-b' });
  ok(dup.status === 409 && dup.json.error === 'DUPLICATE_ID', '重复创建同名文档 → 409', JSON.stringify(dup.json).slice(0, 90));

  const missing = await req('GET', '/v1/tree?documentId=nope');
  ok(missing.status === 404 && missing.json.error === 'DOCUMENT_NOT_FOUND', '未知文档 → 404 DOCUMENT_NOT_FOUND',
    JSON.stringify(missing.json).slice(0, 90));

  const badId = await req('POST', '/v1/documents', { documentId: 'bad id/../x' });
  ok(badId.status === 422, '非法 documentId → 422', JSON.stringify(badId.json).slice(0, 90));

  // 撤销/重做也要按文档隔离
  const undoB = await req('POST', '/v1/undo', { documentId: 'doc-b', expectedRevision: 1, actor: 'manual', steps: 1 });
  ok(undoB.status === 200 && heightOf(undoB.json) === 12 && undoB.json.documentId === 'doc-b',
    'doc-b 撤销回到 12，且包络 documentId 是 doc-b');
  const redoB = await req('POST', '/v1/redo', { documentId: 'doc-b', expectedRevision: undoB.json.revision, actor: 'manual', steps: 1 });
  ok(redoB.status === 200 && heightOf(redoB.json) === 30, 'doc-b 重做回到 30');

  const stillDefault = await req('GET', '/v1/tree');
  ok(stillDefault.json.revision === 0, '默认文档仍然是 r0（不带 documentId 的老调用不变）');
} catch (error) {
  failures.push('异常');
  console.error('MULTIDOC_TEST_FAIL', error);
} finally {
  child.kill('SIGTERM');
}

if (failures.length) {
  console.error(`失败 ${failures.length} 条：${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`MULTIDOC_OK 全部通过：${n} 条`);
