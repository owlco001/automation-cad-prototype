import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { AGENT_COMMAND_MODULES, AGENT_TOOL_MODULES, moduleIsEnabled } from '../../src/modules/tool-gates.ts';

let sandbox;
let registry;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-agent-module-gate-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0', categories: ['气缸'], partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([]));
  registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('PLC 与电气 Agent 工具名/命令映射到各自模块；未知模块/状态读取异常均关闭', () => {
  assert.deepEqual(Object.keys(AGENT_TOOL_MODULES).sort(), ['export_cost_report', 'run_cost_report', 'run_electrical_check', 'run_plc_generate', 'verify_plc_program']);
  assert.deepEqual(Object.keys(AGENT_COMMAND_MODULES).sort(), ['export_cost_report', 'run_cost_report', 'run_electrical_check', 'run_plc_generate', 'verify_plc_program']);
  assert.equal(AGENT_TOOL_MODULES.run_cost_report, 'cost.estimation');
  assert.equal(AGENT_COMMAND_MODULES.run_cost_report, 'cost.estimation');
  assert.equal(AGENT_TOOL_MODULES.export_cost_report, 'cost.estimation');
  assert.equal(AGENT_COMMAND_MODULES.export_cost_report, 'cost.estimation');
  assert.equal(AGENT_TOOL_MODULES.run_electrical_check, 'elec.validation');
  assert.equal(AGENT_COMMAND_MODULES.run_electrical_check, 'elec.validation');
  assert.equal(AGENT_TOOL_MODULES.verify_plc_program, 'plcgen');
  assert.equal(AGENT_TOOL_MODULES.run_plc_generate, 'plcgen');
  assert.equal(moduleIsEnabled('unknown-module', () => false), false);
  assert.equal(moduleIsEnabled('plcgen', () => { throw new Error('state unavailable'); }), false);
});

test('cost.estimation 关闭时隐藏并拒绝两种成本入口，保护 BOM/通用导出且重新启用恢复', async () => {
  const enabled = { value: false };
  const bridgeCalls = [];
  let pricebookLoads = 0;
  let pdfRenders = 0;
  const pricebook = JSON.parse(readFileSync(new URL('../fixtures/pricebook.json', import.meta.url), 'utf8'));
  const costCase = JSON.parse(readFileSync(new URL('../fixtures/cost-case.json', import.meta.url), 'utf8'));
  const bridge = {
    async call(method, args) {
      bridgeCalls.push({ method, args });
      if (method === 'getBom') return [];
      if (method === 'getScene') return null;
      if (method === 'exportCostFile') return { ok: true, path: '/fake/cost.csv', bytes: 10 };
      return { ok: true };
    }
  };
  const isModuleEnabled = (id) => id === 'cost.estimation' ? enabled.value : true;
  const exportRoot = join(sandbox, 'cost-closed-export-root');
  const bus = createAgentCommandBus(registry, bridge, {
    isModuleEnabled,
    exportsRoot: exportRoot,
    loadBuiltinPricebook: () => { pricebookLoads += 1; return pricebook; },
    renderCostPdf: async () => { pdfRenders += 1; return new Uint8Array([37, 80, 68, 70]); }
  });
  const tools = new AgentTools(registry, bus, { isModuleEnabled });
  const listed = tools.summaries().map((tool) => tool.name);
  assert.equal(listed.includes('run_cost_report'), false);
  assert.equal(listed.includes('export_cost_report'), false);
  for (const unaffected of ['get_bom', 'export_files', 'design_machine', 'list_components']) {
    assert.equal(listed.includes(unaffected), true, `${unaffected} 不受成本开关影响`);
  }
  for (const name of ['run_cost_report', 'export_cost_report']) {
    assert.equal(tools.has(name), true, '旧工具名仍可识别并明确拒绝');
    const toolResult = await tools.call(name, { ...costCase, pricebook, format: 'csv', fileName: '../must-not-write.csv' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, 'MODULE_DISABLED');
    const commandResult = await bus.execute(name, { ...costCase, pricebook, format: 'csv' });
    assert.equal(commandResult.ok, false);
    assert.equal(commandResult.error.code, 'MODULE_DISABLED');
  }
  assert.deepEqual(bridgeCalls, [], '关闭时不读取 BOM/价格簿、不渲染 PDF、不落盘');
  assert.equal(pricebookLoads, 0);
  assert.equal(pdfRenders, 0);
  assert.equal(existsSync(exportRoot), false);

  enabled.value = true;
  assert.equal(tools.summaries().some((tool) => tool.name === 'run_cost_report'), true);
  assert.equal(tools.summaries().some((tool) => tool.name === 'export_cost_report'), true);
  const restored = await tools.call('run_cost_report', { ...costCase, pricebook });
  assert.equal(restored.ok, true);
  const exported = await tools.call('export_cost_report', { ...costCase, format: 'csv', fileName: 'restored.csv', pricebook });
  assert.equal(exported.ok, true);
  assert.ok(bridgeCalls.some((call) => call.method === 'exportCostFile'));
});

test('elec.validation 关闭时隐藏工具并拒绝 Agent/命令直调；重开后规则校验恢复', async () => {
  const enabled = { value: false };
  const bridgeCalls = [];
  const bridge = { async call(method, args) { bridgeCalls.push({ method, args }); return { ok: true }; } };
  const isModuleEnabled = (id) => id === 'elec.validation' ? enabled.value : true;
  const bus = createAgentCommandBus(registry, bridge, { isModuleEnabled });
  const tools = new AgentTools(registry, bus, { isModuleEnabled });
  const doc = { wires: [{ no: '101', net: 'n1', potential: 'L1', from: 'QF1', to: 'KM1' }] };

  assert.equal(tools.summaries().some((tool) => tool.name === 'run_electrical_check'), false);
  for (const unaffected of ['list_components', 'insert_component', 'place_component', 'run_plc_generate']) {
    assert.equal(tools.summaries().some((tool) => tool.name === unaffected), true, `${unaffected} 不受电气开关影响`);
  }
  assert.equal(tools.has('run_electrical_check'), true, '旧工具名仍识别并明确拒绝');
  const toolDenied = await tools.call('run_electrical_check', doc);
  assert.equal(toolDenied.ok, false);
  assert.equal(toolDenied.code, 'MODULE_DISABLED');
  const commandDenied = await bus.execute('run_electrical_check', doc);
  assert.equal(commandDenied.ok, false);
  assert.equal(commandDenied.error.code, 'MODULE_DISABLED');
  for (const alias of ['electrical_check', 'check_electrical', 'run_electrical_validation']) {
    await assert.rejects(() => tools.call(alias, doc), /工具不存在/);
    assert.equal((await bus.execute(alias, doc)).error.code, 'UNKNOWN_COMMAND');
  }
  assert.deepEqual(bridgeCalls, [], '门禁前无 renderer IPC 或其它副作用');

  enabled.value = true;
  assert.equal(tools.summaries().some((tool) => tool.name === 'run_electrical_check'), true);
  const restored = await tools.call('run_electrical_check', doc);
  assert.equal(restored.ok, true);
  assert.equal(restored.counts.error, 0);
  const commandRestored = await bus.execute('run_electrical_check', doc);
  assert.equal(commandRestored.ok, true);
  assert.equal(commandRestored.data.counts.error, 0);
});

test('关闭模块动态隐藏工具名，旧名称调用和命令别名均在副作用前失败关闭', async () => {
  const enabled = { value: false };
  const bridgeCalls = [];
  const bridge = { async call(method, args) { bridgeCalls.push({ method, args }); return { ok: true }; } };
  const exportRoot = join(sandbox, 'exports-closed');
  const isModuleEnabled = (id) => id === 'plcgen' && enabled.value;
  const bus = createAgentCommandBus(registry, bridge, { exportsRoot: exportRoot, isModuleEnabled });
  const tools = new AgentTools(registry, bus, { isModuleEnabled });

  const listed = tools.summaries().map((tool) => tool.name);
  assert.equal(listed.includes('verify_plc_program'), false);
  assert.equal(listed.includes('run_plc_generate'), false);
  assert.equal(tools.has('verify_plc_program'), true, '隐藏的旧名称仍可识别并给出明确拒绝');
  assert.equal(tools.has('run_plc_generate'), true);

  for (const name of ['verify_plc_program', 'run_plc_generate']) {
    const result = await tools.call(name, { config: { id: 'must-not-run' } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODULE_DISABLED');
  }
  for (const alias of ['verify_plc', 'plc_generate']) {
    await assert.rejects(() => tools.call(alias, {}), /工具不存在/);
  }

  for (const name of ['verify_plc_program', 'run_plc_generate']) {
    const result = await bus.execute(name, { config: { id: 'must-not-run' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MODULE_DISABLED');
  }
  assert.deepEqual(bridgeCalls, []);
  assert.equal(existsSync(exportRoot), false, '关闭时没有创建导出目录或文件');

  enabled.value = true;
  assert.equal(tools.summaries().some((tool) => tool.name === 'verify_plc_program'), true);
  assert.equal(tools.summaries().some((tool) => tool.name === 'run_plc_generate'), true);
});

function toolCall(name) {
  return { id: 'plc-write', type: 'function', function: { name, arguments: '{}' } };
}

test('启用 PLC 后 run_plc_generate 仍执行原写操作确认，不绕过拒绝或二次授权', async () => {
  for (const approved of [false, true]) {
    const llmCalls = [];
    let responseIndex = 0;
    const llm = {
      async chat(messages) {
        llmCalls.push(messages);
        responseIndex += 1;
        return responseIndex === 1
          ? { content: '', toolCalls: [toolCall('run_plc_generate')] }
          : { content: '完成。', toolCalls: [] };
      }
    };
    const executeCalls = [];
    const bus = {
      async execute(name, args) { executeCalls.push({ name, args }); return { ok: true, data: { generated: true } }; },
      async undoLast() { return { ok: false, error: { code: 'NOTHING_TO_UNDO', message: '无' } }; }
    };
    const prompts = [];
    const session = new AgentSession({
      llm,
      bus,
      confirmWrite: async (name, args) => { prompts.push({ name, args }); return approved; }
    });
    await session.run('生成 PLC 程序');
    assert.deepEqual(prompts, [{ name: 'run_plc_generate', args: {} }]);
    assert.equal(executeCalls.length, approved ? 1 : 0);
    assert.equal(llmCalls.length, 2);
  }
});
