// FeatureTree 契约服务：本地 HTTP，只监听 127.0.0.1；端口默认 18080（环境变量 FT_PORT）。
// 端点（契约第 12 节拟议接口）：
//   GET  /v1/tree?documentId=demo-adapter
//   POST /v1/operations   { documentId, expectedRevision, actor, agentId?, operation, ... }
//   GET  /v1/revisions?documentId=demo-adapter
//   POST /v1/undo          { documentId, expectedRevision, actor?, steps? }
//   GET  /v1/events?documentId=demo-adapter   (SSE，变更时推送)
import { createServer } from 'node:http';
import { Store } from './store.mjs';
import { compileOps } from './validate.mjs';

export const seedDoc = {
  schemaVersion: 1,
  material: 'steel',
  features: [
    { id: 'f-body', type: 'box', name: '90×90×12 板体', params: { length: 90, width: 90, height: 12, centered: true } },
    { id: 'f-cb-in', type: 'counterbore', name: '母件侧沉头孔 Ø5.5 / Ø8.5×5（M5）', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, depth: 'through', positions: [[-30, -30], [30, -30], [-30, 30], [30, 30]] } },
    { id: 'f-holes-out', type: 'holes', name: '子件侧孔阵列（body）', params: { diameter: 5.5, depth: 'through', positions: [[-24, -18], [24, -18], [-24, 18], [24, 18]] } },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
  ],
  updatedAt: '2026-10-28T00:00:00+08:00'
};

// ── 多文档 ──────────────────────────────────────────────────────────────
// 一个进程管多份文档：Map<documentId, Store>。默认文档仍是 demo-adapter，
// 老调用方不带 documentId 时行为完全不变（向后兼容）。
const dataDir = process.env.FT_DATA_DIR || null;
const documents = new Map();
const sseClients = new Set();

function broadcast(change) {
  const line = `data: ${JSON.stringify(change)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { /* ignore */ } }
}

async function addDocument(documentId, source = seedDoc) {
  const store = new Store(JSON.parse(JSON.stringify(source)), { dataDir, documentId });
  const restored = await store.restore();
  await store.init();
  if (restored) console.log(`已从存档恢复：${store.dataFile}（版本 r${store.revision}）`);
  if (store.restoreError) console.error(store.restoreError);
  store.onChange(broadcast);
  documents.set(documentId, store);
  return store;
}

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 装配：只存「成员 + 偏移」，几何由 sidecar fuse 出来（服务端不自己算 B-rep）
const assemblies = new Map();

async function buildAssembly(assemblyId, members) {
  const base = process.env.FT_BUILD_URL;
  if (!base) return { ok: false, message: '未配置 FT_BUILD_URL，装配需要几何 sidecar' };
  const payload = [];
  for (const member of members) {
    const store = documents.get(member.documentId);
    if (!store) return { ok: false, message: `成员文档不存在：${member.documentId}` };
    const ops = compileOps(store.doc);
    if (!ops.length) return { ok: false, message: `成员文档没有可构建几何：${member.documentId}` };
    payload.push({ ops, offset: member.offset || [0, 0, 0], rotateZ: member.rotateZ || 0 });
  }
  const response = await fetch(`${base.replace(/\/+$/, '')}/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assemblyId, members: payload }),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) return { ok: false, message: body?.message || `sidecar HTTP ${response.status}` };
  return body;
}

await addDocument('demo-adapter');

const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      // 超限要明确回 413：旧实现直接 destroy，promise 永不 settle，服务端留下悬挂请求
      if (size > MAX_BODY_BYTES) { fail(new PayloadTooLarge(`请求体超过 ${MAX_BODY_BYTES} 字节`)); return; }
      s += c;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', (error) => fail(error));
  });
}
// 错误码 → HTTP 状态（契约 §13 只定错误码，HTTP 映射在这里集中一处）
function errorStatus(code) {
  if (code === 'REDO_EMPTY') return 409;
  if (code === 'CONFLICT_STALE_REVISION' || code === 'REFERENCE_IN_USE') return 409;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  return 422;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function documentIdOf(url, body) {
  const fromQuery = url.searchParams.get('documentId');
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  if (body && typeof body.documentId === 'string' && body.documentId.trim()) return body.documentId.trim();
  return 'demo-adapter';
}

/** 取文档；不存在时直接回 404，返回 null 让调用方 return。 */
function requireDocument(url, body, res) {
  const id = documentIdOf(url, body);
  const store = documents.get(id);
  if (!store) {
    send(res, 404, { error: 'DOCUMENT_NOT_FOUND', message: `文档不存在：${id}` });
    return null;
  }
  return store;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/v1/documents') {
      return send(res, 200, {
        documents: [...documents.entries()].map(([documentId, store]) => ({
          documentId,
          revision: store.revision,
          features: store.doc.features.length,
          material: store.doc.material || 'steel'
        }))
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/documents') {
      const body = await readBody(req);
      const rawId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
      const documentId = rawId || `doc-${Date.now().toString(36)}`;
      if (!DOCUMENT_ID_PATTERN.test(documentId)) {
        return send(res, 422, { error: 'VALIDATION_FAILED', message: 'documentId 只能包含字母数字与 . _ -，且不超过 64 字符' });
      }
      if (documents.has(documentId)) {
        return send(res, 409, { error: 'DUPLICATE_ID', message: `文档已存在：${documentId}` });
      }
      const store = await addDocument(documentId);
      return send(res, 201, { documentId, revision: store.revision, envelope: store.envelope() });
    }
    if (req.method === 'POST' && url.pathname === '/v1/assemblies') {
      const body = await readBody(req);
      const assemblyId = typeof body.documentId === 'string' && body.documentId.trim() ? body.documentId.trim() : `asm-${Date.now().toString(36)}`;
      if (!DOCUMENT_ID_PATTERN.test(assemblyId)) {
        return send(res, 422, { error: 'VALIDATION_FAILED', message: 'assemblyId 只能包含字母数字与 . _ -，且不超过 64 字符' });
      }
      const members = Array.isArray(body.members) ? body.members : [];
      if (members.length < 2) {
        return send(res, 422, { error: 'VALIDATION_FAILED', message: '装配至少需要两个成员（单件请直接用文档）' });
      }
      for (const member of members) {
        if (!member || typeof member.documentId !== 'string' || !documents.has(member.documentId)) {
          return send(res, 422, { error: 'VALIDATION_FAILED', message: `成员文档不存在：${member?.documentId}` });
        }
        if (member.offset && (!Array.isArray(member.offset) || member.offset.length !== 3 || member.offset.some((v) => typeof v !== 'number'))) {
          return send(res, 422, { error: 'VALIDATION_FAILED', message: '成员 offset 必须是 [x, y, z] 三个数字（mm）' });
        }
        if (member.rotateZ !== undefined && typeof member.rotateZ !== 'number') {
          return send(res, 422, { error: 'VALIDATION_FAILED', message: '成员 rotateZ 必须是角度数字（度，绕自身 Z 轴）' });
        }
      }
      const built = await buildAssembly(assemblyId, members);
      if (!built.ok) return send(res, 422, { error: 'REBUILD_FAILED', message: built.message });
      const record = {
        assemblyId,
        members: members.map((member) => ({
          documentId: member.documentId,
          revision: documents.get(member.documentId).revision,
          offset: member.offset || [0, 0, 0],
          rotateZ: member.rotateZ || 0
        })),
        geometry: {
          volumeMm3: built.volumeMm3,
          bboxMm: built.bboxMm,
          massKg: built.massKg,
          kernel: built.kernel
        },
        stlUrl: `/v1/assemblies/${encodeURIComponent(assemblyId)}/geometry.stl`
      };
      assemblies.set(assemblyId, record);
      return send(res, 201, record);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/assemblies/')) {
      const rest = url.pathname.slice('/v1/assemblies/'.length);
      if (rest.endsWith('/geometry.stl')) {
        const assemblyId = decodeURIComponent(rest.slice(0, -'/geometry.stl'.length));
        if (!assemblies.has(assemblyId)) return send(res, 404, { error: 'NOT_FOUND', message: `装配不存在：${assemblyId}` });
        const base = process.env.FT_BUILD_URL;
        if (!base) return send(res, 404, { error: 'NOT_FOUND', message: '未配置 FT_BUILD_URL' });
        const upstream = await fetch(`${base.replace(/\/+$/, '')}/stl?assemblyId=${encodeURIComponent(assemblyId)}`,
          { signal: AbortSignal.timeout(30_000) });
        if (!upstream.ok) return send(res, 502, { error: 'GEOMETRY_UNAVAILABLE', message: `sidecar HTTP ${upstream.status}` });
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, { 'Content-Type': 'model/stl', 'Content-Length': buffer.length });
        return res.end(buffer);
      }
      const assemblyId = decodeURIComponent(rest);
      const record = assemblies.get(assemblyId);
      if (!record) return send(res, 404, { error: 'NOT_FOUND', message: `装配不存在：${assemblyId}` });
      return send(res, 200, record);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/assemblies/') && url.pathname.endsWith('/interference')) {
      const assemblyId = decodeURIComponent(url.pathname.slice('/v1/assemblies/'.length, -'/interference'.length));
      const record = assemblies.get(assemblyId);
      if (!record) return send(res, 404, { error: 'NOT_FOUND', message: `装配不存在：${assemblyId}` });
      const base = process.env.FT_BUILD_URL;
      if (!base) return send(res, 422, { error: 'REBUILD_FAILED', message: '未配置 FT_BUILD_URL，干涉检查需要几何 sidecar' });
      const members = [];
      for (const member of record.members) {
        const store = documents.get(member.documentId);
        if (!store) return send(res, 422, { error: 'VALIDATION_FAILED', message: `成员文档已不存在：${member.documentId}` });
        members.push({ ops: compileOps(store.doc), offset: member.offset, rotateZ: member.rotateZ || 0 });
      }
      const response = await fetch(`${base.replace(/\/+$/, '')}/interfere`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members }),
        signal: AbortSignal.timeout(60_000)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) return send(res, 422, { error: 'REBUILD_FAILED', message: body?.message || `sidecar HTTP ${response.status}` });
      return send(res, 200, {
        assemblyId,
        checked: body.checked,
        // 给客户端一个能直接读的中文结论，避免把「0 对」当成检查失败
        summary: body.pairs.length ? `${body.pairs.length} 对成员存在实体干涉` : '未发现实体干涉',
        pairs: body.pairs.map((pair) => ({
          ...pair,
          aId: record.members[pair.a]?.documentId,
          bId: record.members[pair.b]?.documentId
        }))
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/assemblies') {
      return send(res, 200, { assemblies: [...assemblies.values()] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/tree') {
      const doc = requireDocument(url, null, res);
      if (!doc) return undefined;
      // sidecar 晚于服务起来时（build123d 首次 import 慢），这里补一次重建，别让界面永远「没有几何」
      if (!doc.geometry) await doc.retryInit();
      return send(res, 200, doc.envelope());
    }
    if (req.method === 'GET' && url.pathname === '/v1/geometry.stl') {
      // 透传 sidecar 的二进制 STL：客户端只渲染，不参与建模
      const base = process.env.FT_BUILD_URL;
      if (!base) return send(res, 404, { error: 'NOT_FOUND', message: '未配置 FT_BUILD_URL，没有可导出的几何' });
      const upstream = await fetch(`${base.replace(/\/+$/, '')}/stl?documentId=${encodeURIComponent(documentIdOf(url, null))}`,
        { signal: AbortSignal.timeout(20_000) });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return send(res, upstream.status === 409 ? 409 : 502, { error: 'GEOMETRY_UNAVAILABLE', message: detail.slice(0, 200) });
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'model/stl', 'Content-Length': buffer.length });
      return res.end(buffer);
    }
    if (req.method === 'GET' && url.pathname === '/v1/revisions') {
      const doc = requireDocument(url, null, res);
      if (!doc) return undefined;
      return send(res, 200, { documentId: doc.documentId, revision: doc.revision, history: doc.history });
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const helloDoc = documents.get(documentIdOf(url, null));
      res.write(`data: ${JSON.stringify({ documentId: helloDoc ? helloDoc.documentId : 'demo-adapter', revision: helloDoc ? helloDoc.revision : 0, hello: true })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/operations') {
      const body = await readBody(req);
      const doc = requireDocument(url, body, res);
      if (!doc) return undefined;
      const out = await doc.applyOperation(body);
      if (out.error) return send(res, errorStatus(out.error), out);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/v1/redo') {
      const body = await readBody(req);
      const doc = requireDocument(url, body, res);
      if (!doc) return undefined;
      const out = await doc.redo(body.expectedRevision, body.actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual', body.steps ?? 1);
      if (out.error) return send(res, errorStatus(out.error), out);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/v1/undo') {
      const body = await readBody(req);
      const doc = requireDocument(url, body, res);
      if (!doc) return undefined;
      const out = await doc.undo(body.expectedRevision, body.actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual', body.steps ?? 1);
      if (out.error) return send(res, errorStatus(out.error), out);
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'NOT_FOUND', message: `未知路径：${url.pathname}` });
  } catch (e) {
    if (e instanceof PayloadTooLarge) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: e.message });
    return send(res, 400, { error: 'VALIDATION_FAILED', message: e.message });
  }
});

// FT_PORT=0 让系统分配端口，测试脚本据此并行/避免占用固定端口。
const requestedPort = Number(process.env.FT_PORT ?? 18080);
server.listen(requestedPort, '127.0.0.1', () => {
  const actual = server.address();
  const port = typeof actual === 'object' && actual ? actual.port : requestedPort;
  console.log(`FeatureTree 服务已启动：http://127.0.0.1:${port}（仅本地回环）`);
});
