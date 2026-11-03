import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { agentToolTotal } from '../../test-support/agent-registry.mjs';
import {
  AgentRpcServer,
  createAgentToken,
  createAgentTokenFile,
  isValidAgentToken,
  loadOrCreateAgentTokenFile,
  rotateAgentToken
} from '../../src/agent/rpc.ts';

let sandbox;
let server;
let url;
let token;
let plcgenEnabled = true;
let elecValidationEnabled = true;
let costEstimationEnabled = true;

const readFileSyncText = (path) => readFileSync(path, 'utf8');

async function startWriteRpc(confirmWrite) {
  const calls = [];
  const confirmations = [];
  const summary = {
    name: 'insert_component',
    description: 'test write tool',
    inputSchema: { type: 'object', properties: {} }
  };
  const tools = {
    list: () => [summary],
    summaries: () => [summary],
    has: (name) => name === summary.name,
    async call(name, args) {
      calls.push({ name, args });
      return { ok: true, name, args };
    }
  };
  const rpcToken = createAgentToken();
  const rpc = new AgentRpcServer({
    tools,
    token: rpcToken,
    version: '0.1.0-auth-test',
    host: '127.0.0.1',
    port: 0,
    confirmWrite: async (name, args) => {
      confirmations.push({ name, args });
      return await confirmWrite(name, args);
    }
  });
  const info = await rpc.start();
  return { rpc, url: info.url, token: rpcToken, calls, confirmations };
}

async function postRpc(target, authToken, payload) {
  const response = await fetch(`${target}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-rpc-test-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0', categories: ['气缸'], partsCount: 1,
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  token = createAgentToken();
  server = new AgentRpcServer({
    tools: new AgentTools(registry, undefined, {
      isModuleEnabled: (id) => id === 'plcgen' ? plcgenEnabled : id === 'elec.validation' ? elecValidationEnabled : id === 'cost.estimation' ? costEstimationEnabled : false
    }),
    token,
    version: '0.1.0-test',
    host: '127.0.0.1',
    port: 0
  });
  const info = await server.start();
  url = info.url;
});

after(async () => {
  await server.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

test('无 token 访问返回 401', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(response.status, 401);
});

test('错误 token 访问返回 401', async () => {
  const response = await fetch(`${url}/health`, {
    headers: { authorization: 'Bearer wrong-token' }
  });
  assert.equal(response.status, 401);
});

test(`有 token 能列出 ${agentToolTotal()} 个工具与健康信息`, async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.tools.length, agentToolTotal());

  const health = await fetch(`${url}/health`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.toolCount, agentToolTotal());
  assert.equal(healthBody.version, '0.1.0-test');
});

test('未知工具返回 -32601', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} }
    })
  });
  const body = await response.json();
  assert.equal(body.error.code, -32601);
});

test('有 token 能调用 list_components', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_components', arguments: {} }
    })
  });
  const body = await response.json();
  assert.equal(body.result.structuredContent.count, 1);
  assert.equal(body.result.isError, false);
});

test('JSON-RPC 写工具缺少桌面确认回调时默认拒绝', async () => {
  const body = await postRpc(url, token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'insert_component', arguments: { partId: 'MXQ20-50' } }
  });
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.code, 'WRITE_CONFIRMATION_REQUIRED');
});

test('JSON-RPC tools/call 与直接工具方法共用授权回调，拒绝不执行、明确批准才执行', async () => {
  const denied = await startWriteRpc(async () => false);
  try {
    const standard = await postRpc(denied.url, denied.token, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'insert_component', arguments: { partId: 'MXQ20-50' } }
    });
    const direct = await postRpc(denied.url, denied.token, {
      jsonrpc: '2.0',
      id: 7,
      method: 'insert_component',
      params: { partId: 'MXQ20-50' }
    });
    assert.equal(standard.result.structuredContent.code, 'USER_DENIED');
    assert.equal(direct.result.code, 'USER_DENIED');
    assert.equal(denied.confirmations.length, 2);
    assert.equal(denied.calls.length, 0);
  } finally {
    await denied.rpc.stop();
  }

  const allowed = await startWriteRpc(async () => true);
  try {
    const standard = await postRpc(allowed.url, allowed.token, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'insert_component', arguments: { partId: 'MXQ20-50' } }
    });
    const direct = await postRpc(allowed.url, allowed.token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'insert_component',
      params: { partId: 'LC1D09' }
    });
    assert.equal(standard.result.structuredContent.ok, true);
    assert.equal(direct.result.ok, true);
    assert.deepEqual(allowed.calls.map(({ args }) => args.partId), ['MXQ20-50', 'LC1D09']);
    assert.equal(allowed.confirmations.length, 2);
  } finally {
    await allowed.rpc.stop();
  }
});

test('Agent token 文件权限为 600（仅 POSIX；Windows 无 POSIX 位）', { skip: process.platform === 'win32' }, () => {
  const tokenDir = join(sandbox, 'agent-token-test');
  const created = createAgentTokenFile(tokenDir);
  assert.equal(statSync(created.tokenFile).mode & 0o777, 0o600);
  assert.equal(created.token.length, 48);
  assert.match(created.token, /^[A-Za-z0-9]{48}$/);
});

test('token 持久化：合法文件重启复用，损坏文件重建', () => {
  const tokenDir = join(sandbox, 'agent-token-reuse');
  const first = loadOrCreateAgentTokenFile(tokenDir);
  assert.equal(isValidAgentToken(first.token), true);
  const second = loadOrCreateAgentTokenFile(tokenDir);
  assert.equal(second.token, first.token);
  assert.equal(second.tokenFile, first.tokenFile);

  const brokenDir = join(sandbox, 'agent-token-broken');
  mkdirSync(brokenDir, { recursive: true });
  const brokenFile = join(brokenDir, 'agent-token');
  writeFileSync(brokenFile, 'too-short', { encoding: 'utf8', mode: 0o600 });
  const rebuilt = loadOrCreateAgentTokenFile(brokenDir);
  assert.equal(isValidAgentToken(rebuilt.token), true);
  assert.equal(readFileSyncText(rebuilt.tokenFile), rebuilt.token);
});

test('rotate 后旧 token 401、新 token 200', async () => {
  const tokenDir = join(sandbox, 'agent-token-rotate');
  const initial = loadOrCreateAgentTokenFile(tokenDir);
  const summary = {
    name: 'list_components',
    description: 'test read tool',
    inputSchema: { type: 'object', properties: {} }
  };
  const rpc = new AgentRpcServer({
    tools: {
      list: () => [summary],
      summaries: () => [summary],
      has: () => true,
      call: async () => ({ ok: true })
    },
    token: initial.token,
    version: '0.1.0-rotate-test',
    host: '127.0.0.1',
    port: 0
  });
  const info = await rpc.start();
  try {
    const before = await fetch(`${info.url}/health`, {
      headers: { authorization: `Bearer ${initial.token}` }
    });
    assert.equal(before.status, 200);
    const rotated = rotateAgentToken(tokenDir);
    assert.notEqual(rotated.token, initial.token);
    assert.equal(readFileSyncText(rotated.tokenFile), rotated.token);
    rpc.setToken(rotated.token);
    const oldToken = await fetch(`${info.url}/health`, {
      headers: { authorization: `Bearer ${initial.token}` }
    });
    assert.equal(oldToken.status, 401);
    const newToken = await fetch(`${info.url}/health`, {
      headers: { authorization: `Bearer ${rotated.token}` }
    });
    assert.equal(newToken.status, 200);
  } finally {
    await rpc.stop();
  }
});

test('MCP resources：list 出三个只读资源，read 返回 contents', async () => {
  const listBody = await postRpc(url, token, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
  const uris = listBody.result.resources.map((item) => item.uri);
  assert.deepEqual(uris, [
    'automationcad://project/current/summary',
    'automationcad://project/current/parts',
    'automationcad://project/current/bom'
  ]);

  const summary = await postRpc(url, token, {
    jsonrpc: '2.0', id: 2, method: 'resources/read',
    params: { uri: 'automationcad://project/current/summary' }
  });
  assert.equal(summary.result.contents[0].mimeType, 'application/json');
  assert.equal(typeof JSON.parse(summary.result.contents[0].text), 'object');

  const parts = await postRpc(url, token, {
    jsonrpc: '2.0', id: 3, method: 'resources/read',
    params: { uri: 'automationcad://project/current/parts' }
  });
  assert.deepEqual(JSON.parse(parts.result.contents[0].text), [], '没注入 sceneParts 时返回空集，不编造');
});

test('MCP resources：未知 uri 返回 -32602，不读本地文件', async () => {
  const body = await postRpc(url, token, {
    jsonrpc: '2.0', id: 9, method: 'resources/read',
    params: { uri: 'file:///etc/passwd' }
  });
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /资源不存在/);
});
