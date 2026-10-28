// FeatureTree 契约服务：本地 HTTP，只监听 127.0.0.1；端口默认 18080（环境变量 FT_PORT）。
// 端点（契约第 12 节拟议接口）：
//   GET  /v1/tree?documentId=demo-adapter
//   POST /v1/operations   { documentId, expectedRevision, actor, agentId?, operation, ... }
//   GET  /v1/revisions?documentId=demo-adapter
//   POST /v1/undo          { documentId, expectedRevision, actor?, steps? }
//   GET  /v1/events?documentId=demo-adapter   (SSE，变更时推送)
import { createServer } from 'node:http';
import { Store } from './store.mjs';

export const seedDoc = {
  schemaVersion: 1,
  features: [
    { id: 'f-body', type: 'box', name: '90×90×12 板体', params: { length: 90, width: 90, height: 12, centered: true } },
    { id: 'f-cb-in', type: 'counterbore', name: '母件侧沉头孔 Ø5.5 / Ø8.5×5（M5）', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, depth: 'through', positions: [[-30, -30], [30, -30], [-30, 30], [30, 30]] } },
    { id: 'f-holes-out', type: 'holes', name: '子件侧孔阵列（body）', params: { diameter: 5.5, depth: 'through', positions: [[-24, -18], [24, -18], [-24, 18], [24, 18]] } },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
  ],
  updatedAt: '2026-10-28T00:00:00+08:00'
};

const store = new Store(seedDoc, { dataDir: process.env.FT_DATA_DIR });
// 有 FT_DATA_DIR 就先恢复存档（版本/历史/快照），再按恢复后的树重建几何；
// 不设就是一个进程内的内存态（默认行为，契约 §15.1 的持久化方案还没拍板）。
const restored = await store.restore();
await store.init();
if (restored) console.log(`已从存档恢复：${store.dataFile}（版本 r${store.revision}）`);
if (store.restoreError) console.error(store.restoreError);
const sseClients = new Set();
store.onChange((change) => {
  const line = `data: ${JSON.stringify(change)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { /* ignore */ } }
});

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/v1/tree') {
      // sidecar 晚于服务起来时（build123d 首次 import 慢），这里补一次重建，别让界面永远「没有几何」
      if (!store.geometry) await store.retryInit();
      return send(res, 200, store.envelope());
    }
    if (req.method === 'GET' && url.pathname === '/v1/geometry.stl') {
      // 透传 sidecar 的二进制 STL：客户端只渲染，不参与建模
      const base = process.env.FT_BUILD_URL;
      if (!base) return send(res, 404, { error: 'NOT_FOUND', message: '未配置 FT_BUILD_URL，没有可导出的几何' });
      const upstream = await fetch(`${base.replace(/\/+$/, '')}/stl`, { signal: AbortSignal.timeout(20_000) });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return send(res, upstream.status === 409 ? 409 : 502, { error: 'GEOMETRY_UNAVAILABLE', message: detail.slice(0, 200) });
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'model/stl', 'Content-Length': buffer.length });
      return res.end(buffer);
    }
    if (req.method === 'GET' && url.pathname === '/v1/revisions') return send(res, 200, { documentId: 'demo-adapter', revision: store.revision, history: store.history });
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ documentId: 'demo-adapter', revision: store.revision, hello: true })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/operations') {
      const body = await readBody(req);
      const out = await store.applyOperation(body);
      if (out.error) return send(res, errorStatus(out.error), out);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/v1/redo') {
      const body = await readBody(req);
      const out = await store.redo(body.expectedRevision, body.actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual', body.steps ?? 1);
      if (out.error) return send(res, errorStatus(out.error), out);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/v1/undo') {
      const body = await readBody(req);
      const out = await store.undo(body.expectedRevision, body.actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual', body.steps ?? 1);
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
