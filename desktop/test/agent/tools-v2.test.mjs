import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { agentToolTotal } from '../../test-support/agent-registry.mjs';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { AgentSession } from '../../src/agent/session.ts';

let sandbox;
let tools;
let bridge;

const PLC_CONFIG = {
  id: 'v2-machine',
  name: 'V2 测试机型',
  stations: ['上料'],
  actuators: [
    {
      id: 'cyl-1',
      name: '上料气缸',
      kind: 'cylinder',
      station: '上料',
      extendPoint: 'Y0',
      retractPoint: 'Y1',
      travelMm: 40,
      durationMs: 400
    }
  ],
  sensors: [{ point: 'X0', station: '上料', part: 'cyl-1' }],
  safety: { emergencyStop: 'X1', safetyDoor: 'X2' },
  sequence: [{ id: 's1', name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 }]
};

function failingConfig() {
  return {
    ...PLC_CONFIG,
    sensors: [{ point: 'X0', station: '上料', part: 'missing-actuator' }]
  };
}

function createFakeBridge() {
  const calls = [];
  const state = {
    plate: {
      id: 'enc-1',
      partId: 'P1',
      model: 'P1',
      x: 10,
      y: 20,
      w: 18,
      h: 60,
      tag: 'QF1',
      qty: 1,
      note: ''
    },
    bom: [{ no: 1, name: 'P1', spec: 'P1', qty: 1, mat: '—', partId: 'P1' }]
  };
  return {
    calls,
    state,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'getProjectContext') {
        return {
          domain: 'elec',
          view: 'enclosure',
          selection: null,
          machine: { id: 'demo', name: '样机', stations: 1, actuators: 2, sensors: 3 },
          plate: { width: 600, height: 800, rails: [{ id: 'rail-1', y: 100, height: 35, label: '导轨 1' }] },
          units: 'mm'
        };
      }
      if (method === 'updateComponent') {
        const source = args ?? {};
        const location = source.target === 'bom' ? 'bom' : 'plate';
        const before = location === 'plate' ? { ...state.plate } : { ...state.bom[0] };
        const updated = {
          ...before,
          ...(typeof source.model === 'string' ? { model: source.model, name: source.model } : {}),
          ...(typeof source.newPartId === 'string' ? { partId: source.newPartId } : {}),
          ...(typeof source.qty === 'number' ? { qty: source.qty } : {}),
          ...(typeof source.remark === 'string' ? { note: source.remark } : {})
        };
        if (location === 'plate' && !source.restore) state.plate = { ...updated, name: undefined };
        return {
          ok: true,
          location,
          targetRef: location === 'plate' ? state.plate.id : '1',
          before,
          updated,
          warnings: []
        };
      }
      if (method === 'removeProjectComponent') {
        if (args?.ref === 'missing' || args?.matchPartId === 'missing') {
          return { ok: false, code: 'NOT_PLACED', message: '元器件不在底板或 BOM 中' };
        }
        return {
          ok: true,
          location: args?.target === 'bom' ? 'bom' : 'plate',
          targetRef: args?.target === 'bom' ? '1' : 'enc-1',
          removed: { id: 'enc-1', model: 'P1' },
          undoToken: 'snapshot-1'
        };
      }
      if (method === 'restoreProjectComponent') return { ok: true };
      if (method === 'exportArtifact') {
        const kind = args?.kind;
        if (kind === 'glb') {
          return { ok: true, kind, data: Buffer.from([1, 2, 3, 4]).toString('base64'), encoding: 'base64', suggestedName: 'demo.glb' };
        }
        if (kind === 'pdf') return { ok: true, kind, data: '<html><body>report</body></html>', encoding: 'utf8', suggestedName: 'demo-report.pdf' };
        if (kind === 'dxf') return { ok: true, kind, data: '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n', encoding: 'utf8', suggestedName: 'demo.dxf' };
        return { ok: true, kind, data: '序号,名称\n1,P1\n', encoding: 'utf8', suggestedName: 'demo-BOM.csv' };
      }
      if (method === 'getBom') return state.bom;
      if (method === 'getPlcGenConfig') return PLC_CONFIG;
      return { ok: false, message: `unexpected ${method}` };
    }
  };
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-tools-v2-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0',
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'P1', model: 'P1', category: '断路器', dims: { w: 18, h: 60, d: 70 }, specs: {} },
    { id: 'P2', model: 'P2', category: '断路器', specs: {} },
    { id: 'P3', model: 'P3', category: '接触器', dims: { w: 45, h: 80, d: 90 }, specs: {} }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  bridge = createFakeBridge();
  tools = new AgentTools(registry, createAgentCommandBus(registry, bridge, {
    exportsRoot: join(sandbox, 'exports'),
    now: () => new Date('2026-10-23T12:00:00+08:00'),
    renderReportPdf: async () => new Uint8Array([37, 80, 68, 70, 45, 86, 50])
  }));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test(`注册表共 ${agentToolTotal()} 个工具且包含 v1 新增的 5 个`, () => {
  const names = tools.list().map((tool) => tool.name);
  assert.equal(names.length, agentToolTotal());
  for (const name of ['get_project_context', 'update_component', 'remove_component', 'run_plc_generate', 'export_files']) {
    assert.ok(names.includes(name), `缺少 ${name}`);
  }
  assert.equal(new Set(names).size, agentToolTotal());
});

test('全部工具 schema 完整：object、additionalProperties=false、required 字段存在、中文描述', () => {
  for (const tool of tools.list()) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    const properties = tool.inputSchema.properties ?? {};
    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(Object.hasOwn(properties, key), `${tool.name}.${key} 未在 properties 中`);
    }
    assert.match(tool.description, /[\u4e00-\u9fff]/, `${tool.name} 缺少中文描述`);
    assert.doesNotMatch(JSON.stringify(tool), /NOT_IMPLEMENTED|尚未实现|未实现/);
  }
});

test('get_project_context 原样返回上下文，缺失字段为 null', async () => {
  const result = await tools.call('get_project_context', {});
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'elec');
  assert.equal(result.view, 'enclosure');
  assert.equal(result.selection, null);
  assert.equal(result.machine.name, '样机');
  assert.equal(result.plate.width, 600);
  assert.equal(result.units, 'mm');
  assert.deepEqual(result.recentActions, []);
});

test('get_project_context 最近操作来自命令总线且排除自身', async () => {
  await tools.call('get_bom', {});
  const result = await tools.call('get_project_context', {});
  assert.ok(result.recentActions.some((entry) => entry.name === 'get_bom'));
  assert.equal(result.recentActions.some((entry) => entry.name === 'get_project_context'), false);
});

test('get_project_context 渲染层失败映射为 RENDERER_ERROR', async () => {
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  const badTools = new AgentTools(registry, createAgentCommandBus(registry, {
    async call() { return { ok: false, message: '桥失败' }; }
  }));
  const result = await badTools.call('get_project_context', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RENDERER_ERROR');
  assert.match(result.message, /桥失败/);
});

test('update_component 缺少 partId/位号返回 INVALID_ARGUMENT', async () => {
  const result = await tools.call('update_component', { model: 'P3' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('update_component 没有任何修改项返回 INVALID_ARGUMENT', async () => {
  const result = await tools.call('update_component', { partId: 'P1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('update_component qty 非正整数返回 INVALID_ARGUMENT', async () => {
  const result = await tools.call('update_component', { ref: 'QF1', qty: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('update_component 新型号不存在返回 PART_NOT_FOUND', async () => {
  const before = bridge.calls.length;
  const result = await tools.call('update_component', { partId: 'P1', model: 'NOT-EXIST' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PART_NOT_FOUND');
  assert.equal(bridge.calls.length, before);
});

test('update_component 新件有尺寸时透传宽高且不告警', async () => {
  bridge.calls.length = 0;
  const result = await tools.call('update_component', { ref: 'QF1', model: 'P3' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  const payload = bridge.calls.find((call) => call.method === 'updateComponent')?.args;
  assert.equal(payload.model, 'P3');
  assert.equal(payload.newPartId, 'P3');
  assert.equal(payload.w, 45);
  assert.equal(payload.h, 80);
});

test('update_component 新件无尺寸时返回 NO_DIMENSIONS 告警且不传宽高', async () => {
  bridge.calls.length = 0;
  const result = await tools.call('update_component', { partId: 'P1', model: 'P2' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'NO_DIMENSIONS'));
  const payload = bridge.calls.find((call) => call.method === 'updateComponent')?.args;
  assert.equal(payload.model, 'P2');
  assert.equal(Object.hasOwn(payload, 'w'), false);
  assert.equal(Object.hasOwn(payload, 'h'), false);
});

test('update_component 只改数量/备注时不解析型号', async () => {
  bridge.calls.length = 0;
  const result = await tools.call('update_component', { partId: 'P1', qty: 3, remark: '备用' });
  assert.equal(result.ok, true);
  const payload = bridge.calls.find((call) => call.method === 'updateComponent')?.args;
  assert.equal(payload.qty, 3);
  assert.equal(payload.remark, '备用');
  assert.equal(Object.hasOwn(payload, 'model'), false);
});

test('update_component 可通过 target=bom 命中 BOM 行', async () => {
  const result = await tools.call('update_component', { target: 'bom', ref: '1', qty: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.location, 'bom');
  assert.equal(bridge.calls.at(-1).args.target, 'bom');
});

test('update_component 可撤销并回写旧型号/数量/备注', async () => {
  bridge.state.plate = {
    id: 'enc-1', partId: 'P1', model: 'P1', x: 10, y: 20, w: 18, h: 60, tag: 'QF1', qty: 1, note: ''
  };
  bridge.calls.length = 0;
  await tools.call('update_component', { partId: 'P1', qty: 4, remark: '新' });
  const undone = await tools.call('undo_last', {});
  assert.equal(undone.ok, true);
  assert.equal(undone.command, 'update_component');
  const restore = bridge.calls.filter((call) => call.method === 'updateComponent').at(-1)?.args;
  assert.equal(restore.restore, true);
  assert.equal(restore.qty, 1);
  assert.equal(restore.remark, '');
});

test('remove_component 缺少 partId/位号返回 INVALID_ARGUMENT', async () => {
  const result = await tools.call('remove_component', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('remove_component 目标不存在返回 NOT_PLACED', async () => {
  const result = await tools.call('remove_component', { ref: 'missing' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_PLACED');
});

test('remove_component 成功后 undo_last 调用恢复桥', async () => {
  bridge.calls.length = 0;
  const removed = await tools.call('remove_component', { ref: 'QF1' });
  assert.equal(removed.ok, true);
  assert.equal(removed.location, 'plate');
  const undone = await tools.call('undo_last', {});
  assert.equal(undone.ok, true);
  assert.equal(undone.command, 'remove_component');
  assert.equal(bridge.calls.at(-1).method, 'restoreProjectComponent');
  assert.equal(bridge.calls.at(-1).args[0], 'snapshot-1');
});

test('run_plc_generate 预检有 error 时返回 PRECHECK_FAILED 且不落盘', async () => {
  const root = join(sandbox, 'precheck-exports');
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  const local = new AgentTools(registry, createAgentCommandBus(registry, bridge, { exportsRoot: root }));
  const result = await local.call('run_plc_generate', { config: failingConfig() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRECHECK_FAILED');
  assert.equal(existsSync(join(root, 'plc')), false);
});

test('run_plc_generate 成功写出 11 个文件与 zip，并返回预检与清单', async () => {
  const result = await tools.call('run_plc_generate', { config: PLC_CONFIG });
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 11);
  assert.equal(result.files.length, 11);
  assert.equal(result.precheck.errors.length, 0);
  assert.ok(result.stats.tags >= 1);
  assert.match(basename(result.path), /^V2 测试机型-\d{8}-\d{4}/);
  assert.ok(result.path.startsWith(join(sandbox, 'exports', 'plc') + sep));
  assert.ok(existsSync(result.zipPath));
  assert.deepEqual(
    readdirSync(result.path).sort(),
    ['README.md', basename(result.zipPath), 'io-tags.csv', 'mapping.json', 'src'].sort()
  );
  assert.equal(readFileSync(join(result.path, 'README.md'), 'utf8').length > 0, true);
});

test('export_files 拒绝白名单外格式且不调用渲染桥', async () => {
  bridge.calls.length = 0;
  const result = await tools.call('export_files', { kind: 'step' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_FORMAT');
  assert.equal(bridge.calls.some((call) => call.method === 'exportArtifact'), false);
});

test('export_files fileName 非字符串返回 INVALID_ARGUMENT', async () => {
  const result = await tools.call('export_files', { kind: 'bom', fileName: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('export_files allowSanitize=true 时净化路径并强制 .csv', async () => {
  const result = await tools.call('export_files', {
    kind: 'bom',
    fileName: '../报价/单:2026*',
    allowSanitize: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.sanitized, true);
  assert.ok(result.path.startsWith(join(sandbox, 'exports') + sep));
  assert.match(result.fileName, /\.csv$/);
  assert.doesNotMatch(result.fileName, /[/\\:*?"<>|]/);
  assert.ok(existsSync(result.path));
});

test('export_files 同名不覆盖时追加序号，overwrite=true 直接覆盖', async () => {
  const first = await tools.call('export_files', { kind: 'bom', fileName: 'same' });
  const second = await tools.call('export_files', { kind: 'bom', fileName: 'same' });
  assert.equal(first.fileName, 'same.csv');
  assert.equal(second.fileName, 'same (1).csv');
  const third = await tools.call('export_files', { kind: 'bom', fileName: 'same', overwrite: true });
  assert.equal(third.fileName, 'same.csv');
});

test('export_files dxf 写出文本内容', async () => {
  const result = await tools.call('export_files', { kind: 'dxf', fileName: 'drawing' });
  assert.equal(result.ok, true);
  assert.match(readFileSync(result.path, 'utf8'), /SECTION/);
});

test('export_files glb 解码 base64 后按字节写盘', async () => {
  const result = await tools.call('export_files', { kind: 'glb', fileName: 'model' });
  assert.equal(result.ok, true);
  assert.deepEqual([...readFileSync(result.path)], [1, 2, 3, 4]);
});

test('export_files pdf 复用注入的 PDF 渲染管线', async () => {
  const result = await tools.call('export_files', { kind: 'pdf', fileName: 'report' });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 7);
  assert.deepEqual([...readFileSync(result.path)], [37, 80, 68, 70, 45, 86, 50]);
});

for (const name of ['update_component', 'remove_component', 'run_plc_generate', 'export_files']) {
  test(`写工具 ${name} 在确认拒绝时不执行命令`, async () => {
    const calls = [];
    let round = 0;
    const llm = {
      async chat() {
        if (round++ > 0) return { content: '已拒绝，不执行。', toolCalls: [] };
        return {
          content: '',
          toolCalls: [toolCall('deny-1', name, {
            partId: 'P1',
            model: 'P3',
            qty: 2,
            kind: 'bom',
            config: PLC_CONFIG
          })]
        };
      }
    };
    const bus = {
      async execute(command, args) {
        calls.push({ command, args });
        return { ok: true, data: {} };
      },
      async undoLast() { return { ok: true, data: {} }; }
    };
    const session = new AgentSession({
      llm,
      bus,
      confirmWrite: async () => false,
      maxIterations: 2
    });
    const reply = await session.run('执行写操作');
    const toolMessage = session.history().find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /USER_DENIED/);
    assert.match(reply, /已拒绝/);
    assert.equal(calls.length, 0);
  });
}
