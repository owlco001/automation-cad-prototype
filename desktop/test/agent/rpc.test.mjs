import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { AgentRpcServer, createAgentToken, createAgentTokenFile } from '../../src/agent/rpc.ts';

let sandbox;
let server;
let url;
let token;
let plcgenEnabled = true;
let elecValidationEnabled = true;
let costEstimationEnabled = true;

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

test('有 token 能列出 21 个工具与健康信息', async () => {
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
  assert.equal(body.result.tools.length, 21);

  const health = await fetch(`${url}/health`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.toolCount, 21);
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

test('PLC 模块关闭时隐藏工具并拒绝 MCP 风格、直接工具方法与未知别名路由', async () => {
  plcgenEnabled = false;
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listed = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' })
    });
    const listBody = await listed.json();
    const names = listBody.result.tools.map((tool) => tool.name);
    assert.equal(names.length, 19);
    assert.equal(names.includes('verify_plc_program'), false);
    assert.equal(names.includes('run_plc_generate'), false);

    for (const [id, name] of [[21, 'verify_plc_program'], [22, 'run_plc_generate']]) {
      const response = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
      });
      const body = await response.json();
      assert.equal(body.result.isError, true);
      assert.equal(body.result.structuredContent.code, 'MODULE_DISABLED');
    }

    const direct = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'verify_plc_program', params: {} })
    });
    assert.equal((await direct.json()).result.code, 'MODULE_DISABLED');

    const unknownAlias = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'verify_plc', params: {} })
    });
    assert.equal((await unknownAlias.json()).error.code, -32601);
    plcgenEnabled = true;
    const reenabled = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 25, method: 'tools/list' })
    });
    assert.equal((await reenabled.json()).result.tools.length, 21);
  } finally {
    plcgenEnabled = true;
  }
});

test('elec.validation 关闭时 RPC 隐藏校验工具、拒绝旧名称和直接方法；重新启用后恢复', async () => {
  elecValidationEnabled = false;
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listed = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' })
    });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.equal(names.includes('run_electrical_check'), false);
    assert.equal(names.length, 20);

    const oldName = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'run_electrical_check', arguments: {} } })
    });
    const oldNameBody = await oldName.json();
    assert.equal(oldNameBody.result.isError, true);
    assert.equal(oldNameBody.result.structuredContent.code, 'MODULE_DISABLED');

    const direct = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'run_electrical_check', params: {} })
    });
    assert.equal((await direct.json()).result.code, 'MODULE_DISABLED');

    elecValidationEnabled = true;
    const reenabled = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 33, method: 'tools/list' })
    });
    const reenabledBody = await reenabled.json();
    assert.equal(reenabledBody.result.tools.length, 21);
    assert.equal(reenabledBody.result.tools.some((tool) => tool.name === 'run_electrical_check'), true);
  } finally {
    elecValidationEnabled = true;
  }
});

test('cost.estimation 关闭时 RPC 隐藏成本工具并拒绝工具名/直接方法；重新启用后恢复', async () => {
  costEstimationEnabled = false;
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listed = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/list' })
    });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.equal(names.length, 19);
    assert.equal(names.includes('run_cost_report'), false);
    assert.equal(names.includes('export_cost_report'), false);
    assert.equal(names.includes('get_bom'), true);

    for (const [id, name] of [[41, 'run_cost_report'], [42, 'export_cost_report']]) {
      const called = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
      });
      const body = await called.json();
      assert.equal(body.result.isError, true);
      assert.equal(body.result.structuredContent.code, 'MODULE_DISABLED');
      const direct = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: id + 10, method: name, params: {} })
      });
      assert.equal((await direct.json()).result.code, 'MODULE_DISABLED');
    }

    costEstimationEnabled = true;
    const reenabled = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/list' })
    });
    const reenabledNames = (await reenabled.json()).result.tools.map((tool) => tool.name);
    assert.equal(reenabledNames.length, 21);
    assert.equal(reenabledNames.includes('run_cost_report'), true);
    assert.equal(reenabledNames.includes('export_cost_report'), true);
  } finally {
    costEstimationEnabled = true;
  }
});

test('Agent token 文件权限为 600（仅 POSIX；Windows 无 POSIX 位）', { skip: process.platform === 'win32' }, () => {
  const tokenDir = join(sandbox, 'agent-token-test');
  const created = createAgentTokenFile(tokenDir);
  assert.equal(statSync(created.tokenFile).mode & 0o777, 0o600);
  assert.equal(created.token.length, 43);
});
