import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { agentRegistry, agentToolTotal } from '../../test-support/agent-registry.mjs';
import { buildMcpServer } from '../../src/agent/mcp.ts';
import { DesktopRpcUnavailableError } from '../../src/agent/mcp-proxy.ts';

let sandbox;
let client;
let server;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-mcp-test-'));
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
  const tools = new AgentTools(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = buildMcpServer(tools, { name: 'automation-cad-test', version: '0.1.0-test' });
  client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

test(`MCP server 通过 in-memory transport 列出 ${agentToolTotal()} 个复用工具`, async () => {
  const result = await client.listTools();
  // 不写死名单：与注册表逐一比对（MCP 只是复用同一注册表，不能多发也不能漏发）；
  // 再加一遍关键工具点名，防止「两边一起变空」这种自证。
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), agentRegistry().names);
  for (const name of [
    'apply_machine_design',
    'list_machine_library',
    'save_machine_to_library',
    'load_machine_from_library',
    'export_machine_package',
    'verify_plc_program'
  ]) {
    assert.ok(result.tools.some((tool) => tool.name === name), `MCP 少了工具 ${name}`);
  }
  for (const tool of result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('MCP 工具调用直接复用 AgentTools 结果', async () => {
  const result = await client.callTool({ name: 'list_components', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.components[0].id, 'MXQ20-50');
});

test('MCP 未知工具返回 isError', async () => {
  const result = await client.callTool({ name: 'not_a_tool', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未知工具/);
});

test('MCP 代理断开后，已知写工具走桌面路由、未分类写工具在本地回退失败关闭', async () => {
  let executions = 0;
  const summaries = ['apply_machine_design', 'future_write'].map((name) => ({
    name,
    description: 'test write tool',
    inputSchema: { type: 'object', properties: {} }
  }));
  const tools = {
    summaries: () => summaries,
    has: (name) => summaries.some((tool) => tool.name === name),
    async call() {
      executions += 1;
      return { ok: true };
    }
  };
  const unavailableProxy = {
    async callTool() {
      throw new DesktopRpcUnavailableError();
    }
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fallbackServer = buildMcpServer(
    tools,
    { name: 'mcp-fallback-auth-test', version: '0.1.0-test' },
    { proxy: unavailableProxy }
  );
  const fallbackClient = new Client({ name: 'mcp-fallback-auth-client', version: '1.0.0' });
  await fallbackServer.connect(serverTransport);
  await fallbackClient.connect(clientTransport);
  try {
    for (const name of ['apply_machine_design', 'future_write']) {
      const result = await fallbackClient.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      const expectedCode = name === 'apply_machine_design'
        ? 'DESKTOP_NOT_RUNNING'
        : 'WRITE_CONFIRMATION_REQUIRED';
      assert.equal(result.structuredContent.code, expectedCode, name);
    }
    assert.equal(executions, 0);
  } finally {
    await fallbackClient.close();
    await fallbackServer.close();
  }
});
