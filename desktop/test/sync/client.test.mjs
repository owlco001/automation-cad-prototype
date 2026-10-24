import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { SyncClient } from '../../src/sync/client.ts';
import { sha256Hex } from '../../src/sync/package.ts';

function config(overrides = {}) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-design-key',
    deviceId: 'DEV-001',
    projectId: 'asm-slide-cyl',
    enabled: true,
    ...overrides
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startServer(handler) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    projectId: 'asm-slide-cyl',
    projectName: '滑台气缸装配体',
    appVersion: '0.1.0',
    createdAt: '2026-10-22T14:00:00.000Z',
    bomSha256: 'a'.repeat(64),
    files: [],
    bom: []
  };
}

test('testConnection 使用 Bearer 并验证设备图纸接口', async () => {
  let authorization = '';
  const server = await startServer((request, response) => {
    authorization = request.headers.authorization || '';
    assert.equal(request.url, '/api/v1/devices/DEV-001/drawings');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ deviceId: 'DEV-001', drawings: [] }));
  });
  try {
    const result = await new SyncClient(config({ baseUrl: server.url })).testConnection();
    assert.equal(result.ok, true);
    assert.equal(authorization, 'Bearer test-design-key');
    assert.match(result.message, /连接成功/);
  } finally {
    await server.close();
  }
});

test('同步客户端拒绝将 API Key 发往远程 HTTP，且不会调用 fetch', async () => {
  let fetchCalls = 0;
  const client = new SyncClient(config({ baseUrl: 'http://factory.example.com' }), {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('不应发起请求');
    }
  });
  const result = await client.testConnection();
  assert.equal(result.ok, false);
  assert.match(result.message, /明文传输 API Key/);
  assert.equal(fetchCalls, 0);
});

test('testConnection 对 401 与 404 返回可操作中文提示', async () => {
  let calls = 0;
  const server = await startServer((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"detail":"unauthorized"}');
    } else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"detail":"device not found"}');
    }
  });
  try {
    const client = new SyncClient(config({ baseUrl: server.url }));
    const unauthorized = await client.testConnection();
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.message, /API Key 无效/);
    assert.match(unauthorized.message, /401/);
    const missing = await client.testConnection();
    assert.equal(missing.ok, false);
    assert.match(missing.message, /机台编号 device_no DEV-001 不存在/);
    assert.match(missing.message, /404/);
  } finally {
    await server.close();
  }
});

test('请求超过 15 秒默认值之外的可注入超时返回中文错误且不抛出', async () => {
  const server = await startServer(() => new Promise(() => {}));
  try {
    const client = new SyncClient(config({ baseUrl: server.url }), { timeoutMs: 50 });
    const result = await client.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.message, /超时/);
    assert.match(result.message, /0 秒|1 秒/);
  } finally {
    await server.close();
  }
});

test('上传携带 Idempotency-Key，重复 ZIP 只入库一次并标记 duplicated', async () => {
  const packages = new Map();
  let newPackages = 0;
  let designKey = '';
  let contentType = '';
  const server = await startServer(async (request, response) => {
    await readBody(request);
    designKey = request.headers['x-design-key'] || '';
    contentType = request.headers['content-type'] || '';
    const key = request.headers['idempotency-key'] || '';
    if (packages.has(key)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ packageId: packages.get(key), version: 1, duplicated: true }));
      return;
    }
    newPackages += 1;
    const packageId = `PKG-${newPackages}`;
    packages.set(key, packageId);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ packageId, version: 1, duplicated: false }));
  });
  try {
    const client = new SyncClient(config({ baseUrl: server.url }));
    const zip = new Uint8Array([1, 2, 3, 4, 5]);
    const first = await client.uploadPackage(zip, manifest());
    const second = await client.uploadPackage(zip, manifest());
    assert.equal(first.ok, true);
    assert.equal(first.duplicated, false);
    assert.equal(first.packageId, 'PKG-1');
    assert.equal(second.ok, true);
    assert.equal(second.duplicated, true);
    assert.equal(second.packageId, 'PKG-1');
    assert.equal(newPackages, 1);
    assert.equal(designKey, 'test-design-key');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
  } finally {
    await server.close();
  }
});

test('listPackages 与 diff 解析服务端 JSON', async () => {
  const server = await startServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/api/v1/design-sync/packages?')) {
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.searchParams.get('deviceId'), 'DEV-001');
      assert.equal(url.searchParams.get('projectId'), 'asm-slide-cyl');
      response.writeHead(200);
      response.end(JSON.stringify({
        items: [{ packageId: 'PKG-1', projectId: 'asm-slide-cyl', version: 3, bomSha256: 'b'.repeat(64), createdAt: '2026-10-22T14:00:00Z', uploadedBy: 'desktop' }]
      }));
      return;
    }
    if (request.url === '/api/v1/design-sync/packages/PKG-1/diff?against=latest') {
      response.writeHead(200);
      response.end(JSON.stringify({
        base: { packageId: 'PKG-0', version: 2 },
        bomAdded: [{ no: 2, name: '气缸', spec: 'MXQ20-50', qty: 1, mat: '铝合金' }],
        bomRemoved: [],
        bomChanged: [{ no: 1, field: 'qty', from: 1, to: 2 }],
        filesAdded: ['drawing.dxf'],
        filesChanged: ['report.pdf'],
        filesRemoved: []
      }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  try {
    const client = new SyncClient(config({ baseUrl: server.url }));
    const list = await client.listPackages();
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].version, 3);
    assert.equal(list.items[0].uploadedBy, 'desktop');
    const difference = await client.diff('PKG-1');
    assert.equal(difference.ok, true);
    assert.equal(difference.diff.base.version, 2);
    assert.equal(difference.diff.bomChanged[0].field, 'qty');
    assert.deepEqual(difference.diff.filesAdded, ['drawing.dxf']);
  } finally {
    await server.close();
  }
});

test('网络不可达时返回 ok=false 且不向渲染层抛出异常', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200);
    response.end('{}');
  });
  const url = server.url;
  await server.close();
  const result = await new SyncClient(config({ baseUrl: url }), { timeoutMs: 500 }).testConnection();
  assert.equal(result.ok, false);
  assert.match(result.message, /连接智慧工厂失败/);
});

test('ZIP SHA-256 作为幂等键长度为 64', () => {
  assert.match(sha256Hex(new Uint8Array([1, 2, 3])), /^[a-f0-9]{64}$/);
});
