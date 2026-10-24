import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS, planTool, routeIntent } from '../../src/agent/router.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import {
  activeMachinePath,
  machineBomDraftPath,
  machineDesignPath,
  readActivePointer,
  readStoredMachineDesign,
  validateMachineDesign
} from '../../src/machine/store.ts';

const BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function designFor(options = {}) {
  return synthMachine(parseMachineBrief(options.brief ?? BRIEF), {
    ...(options.stationCount !== undefined ? { stationCount: options.stationCount } : {}),
    ...(options.id ? { id: options.id } : {}),
    ...(options.name ? { name: options.name } : {})
  });
}

function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-machine-apply-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') {
        return { ok: true, added: Array.isArray(args?.rows) ? args.rows.length : 0 };
      }
      if (method === 'removeMachineBomRows') return { ok: true, removed: 1 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-10-23T08:00:00.000Z'),
    ...(options.isModuleEnabled ? { isModuleEnabled: options.isModuleEnabled } : {}),
    ...(options.buildSolids ? { buildSolids: options.buildSolids } : {})
  });
  return { root, calls, bridge, bus, tools: new AgentTools(registry, bus) };
}

function apply(bus, args) {
  return bus.execute('apply_machine_design', args);
}

function activeText(root) {
  return readFileSync(activeMachinePath(root), 'utf8');
}

test('apply_machine_design 已注册为写工具，schema 支持 brief/design 与联动开关', () => {
  const { tools } = setup();
  const tool = tools.summaries().find((item) => item.name === 'apply_machine_design');
  assert.ok(tool);
  assert.equal(tools.list().length, 21);
  assert.equal(READ_ONLY_TOOLS.has('apply_machine_design'), false);
  assert.equal(WRITE_TOOLS.has('apply_machine_design'), true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.required, undefined);
  for (const key of ['brief', 'design', 'name', 'overwrite', 'withBom', 'withPlc']) {
    assert.ok(tool.inputSchema.properties[key], key);
  }
  assert.equal(tool.inputSchema.properties.withBom.type, 'boolean');
});

test('brief 单独使用时先 synth 再落盘，并更新 active 指针', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, { brief: BRIEF });
  assert.equal(result.ok, true);
  assert.equal(result.data.machineId, 'design-screw-3st');
  assert.equal(result.data.stations, 3);
  assert.equal(result.data.actuators, 6);
  assert.equal(result.data.sensors, 3);
  assert.ok(existsSync(result.data.designPath));
  const pointer = readActivePointer(root);
  assert.equal(pointer?.machineId, 'design-screw-3st');
  assert.equal(JSON.parse(activeText(root)).name, result.data.name);
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.kind, 'machine-design');
  assert.equal(stored.config.stations.length, 3);
});

test('design 单独使用时直接采用，不重复合成且保留 cycle/power', async () => {
  const { bus } = setup();
  const design = designFor({ id: 'line-custom', name: '自定义线体' });
  design.cycle.perMin = 42;
  const result = await apply(bus, { design });
  assert.equal(result.ok, true);
  assert.equal(result.data.machineId, 'line-custom');
  assert.equal(result.data.name, '自定义线体');
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.cycle.perMin, 42);
  assert.equal(stored.config.id, 'line-custom');
});

test('brief 与 design 同时提供返回 INVALID_ARGUMENT，不落盘', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, { brief: BRIEF, design: designFor() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /二选一/);
  assert.equal(existsSync(activeMachinePath(root)), false);
});

test('参数化 CAD 模块关闭时拒绝 withSolids，且在方案/几何落盘与 sidecar 调用前失败', async () => {
  let buildCalls = 0;
  const { root, bus, bridge } = setup({
    isModuleEnabled: (moduleId) => moduleId !== 'cad.parametric-import',
    buildSolids: async () => {
      buildCalls += 1;
      return { ok: true };
    }
  });

  const result = await apply(bus, { brief: BRIEF, withGeometry: true, withSolids: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODULE_DISABLED');
  assert.match(result.error.message, /cad\.parametric-import.*已关闭/);
  assert.equal(buildCalls, 0);
  assert.deepEqual(bridge.calls, []);
  assert.deepEqual(readdirSync(root), [], '不得写入方案、几何、BOM 或 PLC side effect 文件');
});

test('brief 与 design 都缺失返回 INVALID_ARGUMENT', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /brief 或 design/);
  assert.equal(existsSync(activeMachinePath(root)), false);
});

test('design.config 缺失或校验失败返回 INVALID_ARGUMENT', async () => {
  const { root, bus } = setup();
  const bad = designFor();
  bad.config.actuators = [];
  const result = await apply(bus, { design: bad });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /机型方案校验失败/);
  assert.equal(existsSync(activeMachinePath(root)), false);
  assert.throws(() => validateMachineDesign({}), /design.config/);
});

test('执行机构 id 重复被拒绝', async () => {
  const { bus } = setup();
  const design = designFor();
  design.config.actuators[1].id = design.config.actuators[0].id;
  const result = await apply(bus, { design });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /执行机构 id 重复/);
});

test('传感器点位与执行机构点位重复被拒绝', async () => {
  const { bus } = setup();
  const design = designFor();
  design.config.sensors[0].point = design.config.actuators[0].point;
  const result = await apply(bus, { design });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /点位 .*重复/);
});

test('design.points 缺少配置点位时返回点位引用缺失', async () => {
  const { bus } = setup();
  const design = designFor();
  design.points = design.points.slice(1);
  const result = await apply(bus, { design });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /设计点位引用缺失/);
});

test('传感器 part 引用不存在的工位/执行机构时被拒绝', async () => {
  const { bus } = setup();
  const design = designFor();
  design.config.sensors[0].part = '不存在的气缸';
  const result = await apply(bus, { design });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /未定义工位或执行机构/);
});

test('同名文件默认返回 FILE_EXISTS，且不改变 active 指针', async () => {
  const { root, bus } = setup();
  const first = await apply(bus, { design: designFor({ id: 'line-a', name: 'A' }) });
  assert.equal(first.ok, true);
  const before = activeText(root);
  const second = await apply(bus, { design: designFor({ id: 'line-a', name: 'B' }) });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'FILE_EXISTS');
  assert.equal(activeText(root), before);
  const stored = JSON.parse(readFileSync(machineDesignPath(root, 'line-a'), 'utf8'));
  assert.equal(stored.name, 'A');
});

test('overwrite=true 才覆盖同名文件', async () => {
  const { root, bus } = setup();
  await apply(bus, { design: designFor({ id: 'line-a', name: 'A' }) });
  const second = await apply(bus, { design: designFor({ id: 'line-a', name: 'B' }), overwrite: true });
  assert.equal(second.ok, true);
  const stored = JSON.parse(readFileSync(machineDesignPath(root, 'line-a'), 'utf8'));
  assert.equal(stored.name, 'B');
  assert.equal(readActivePointer(root)?.name, 'B');
});

test('active 指针包含 machineId/name/file/appliedAt', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, { design: designFor({ id: 'line-a', name: 'Line A' }) });
  const pointer = JSON.parse(activeText(root));
  assert.deepEqual(Object.keys(pointer).sort(), ['appliedAt', 'file', 'machineId', 'name', 'schemaVersion']);
  assert.equal(pointer.machineId, result.data.machineId);
  assert.equal(pointer.name, 'Line A');
  assert.equal(pointer.file, 'machine/line-a.json');
  assert.match(pointer.appliedAt, /^2026-10-23T08:00:00/);
});

test('成功后调用渲染桥 applyMachineConfig，返回统计与 warnings', async () => {
  const { calls, bus } = setup();
  const result = await apply(bus, { design: designFor() });
  assert.equal(result.ok, true);
  assert.equal(result.data.sceneRefreshed, true);
  assert.ok(Array.isArray(result.data.warnings));
  assert.ok(result.data.warnings.some((warning) => /形态选型.*缺口/.test(warning)));
  const refresh = calls.find((call) => call.method === 'applyMachineConfig');
  assert.ok(refresh);
  assert.equal(refresh.args.config.stations.length, 3);
});

test('withBom 默认 true：追加行数等于 bomDraft，并写 bom-draft.csv', async () => {
  const { root, calls, bus } = setup();
  const design = designFor();
  const result = await apply(bus, { design });
  assert.equal(result.ok, true);
  assert.equal(result.data.bom.count, design.bomDraft.items.length);
  assert.equal(result.data.bom.count, design.bomDraft.items.length);
  assert.equal(result.data.bom.source, 'machine-design');
  assert.ok(existsSync(result.data.bomPath));
  assert.equal(result.data.bomPath, machineBomDraftPath(root, result.data.machineId));
  const appended = calls.find((call) => call.method === 'appendMachineBomRows');
  assert.equal(appended.args.rows.length, design.bomDraft.items.length);
  assert.ok(appended.args.rows.every((row) => row.source === 'machine-design'));
  assert.ok(appended.args.rows.every((row) => row.spec === '模型待定'));
  const csv = readFileSync(result.data.bomPath, 'utf8');
  assert.match(csv, /machine-design/);
  assert.equal(csv.trim().split(/\r?\n/).length, design.bomDraft.items.length + 1);
});

test('withBom=false 时不追加、不写 BOM 草稿文件', async () => {
  const { root, calls, bus } = setup();
  const result = await apply(bus, { design: designFor({ id: 'no-bom' }), withBom: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.bom, undefined);
  assert.equal(result.data.bomPath, undefined);
  assert.equal(calls.some((call) => call.method === 'appendMachineBomRows'), false);
  assert.equal(existsSync(machineBomDraftPath(root, 'no-bom')), false);
});

test('withPlc 默认 false：不生成 io-map.csv', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, { design: designFor({ id: 'no-plc' }) });
  assert.equal(result.ok, true);
  assert.equal(result.data.plcPath, undefined);
  assert.equal(existsSync(join(root, 'exports', 'plc', 'no-plc', 'io-map.csv')), false);
});

test('withPlc=true 生成 io-map.csv，点位齐全', async () => {
  const { bus } = setup();
  const design = designFor({ id: 'plc-line' });
  const result = await apply(bus, { design, withPlc: true });
  assert.equal(result.ok, true);
  assert.ok(result.data.plcPath.endsWith(join('exports', 'plc', 'plc-line', 'io-map.csv')));
  assert.ok(existsSync(result.data.plcPath));
  const csv = readFileSync(result.data.plcPath, 'utf8');
  for (const point of design.points) assert.ok(csv.includes(point), point);
  assert.equal(csv.trim().split(/\r?\n/).length, design.points.length + 1);
  assert.equal(result.data.plc.points, design.points.length);
});

test('io-map.csv 标注执行机构/传感器归属与类型', async () => {
  const { bus } = setup();
  const result = await apply(bus, { design: designFor({ id: 'plc-owner' }), withPlc: true });
  const csv = readFileSync(result.data.plcPath, 'utf8');
  assert.match(csv, /执行机构/);
  assert.match(csv, /传感器/);
  assert.match(csv, /气缸|夹爪|旋转轴/);
  assert.match(csv, /接近开关|压力传感器|光电传感器|安全光栅/);
});

test('undo_last 恢复上一个 active 配置', async () => {
  const { root, calls, tools } = setup();
  await tools.call('apply_machine_design', { design: designFor({ id: 'line-a', name: 'A' }) });
  await tools.call('apply_machine_design', { design: designFor({ id: 'line-b', name: 'B' }) });
  assert.equal(readActivePointer(root)?.machineId, 'line-b');
  const undone = await tools.call('undo_last', {});
  assert.equal(undone.ok, true);
  assert.equal(undone.command, 'apply_machine_design');
  assert.equal(readActivePointer(root)?.machineId, 'line-a');
  const lastRefresh = calls.filter((call) => call.method === 'applyMachineConfig').at(-1);
  assert.equal(lastRefresh.args.config.name, 'A');
  assert.equal(existsSync(machineDesignPath(root, 'line-b')), false);
});

test('首次应用后撤销：删除 active 指针并恢复默认样机', async () => {
  const { root, calls, bus } = setup();
  await apply(bus, { design: designFor({ id: 'first-line' }) });
  const undone = await bus.undoLast();
  assert.equal(undone.ok, true);
  assert.equal(existsSync(activeMachinePath(root)), false);
  const lastRefresh = calls.filter((call) => call.method === 'applyMachineConfig').at(-1);
  assert.equal(lastRefresh.args.config, null);
});

test('撤销只移除本批次 BOM 行，并恢复 BOM 草稿文件', async () => {
  const { root, calls, bus } = setup();
  const first = await apply(bus, { design: designFor({ id: 'bom-line' }) });
  const bomBefore = readFileSync(first.data.bomPath, 'utf8');
  await bus.undoLast();
  const remove = calls.find((call) => call.method === 'removeMachineBomRows');
  assert.ok(remove);
  assert.match(remove.args.batchId, /^machine-bom-line-/);
  assert.equal(existsSync(first.data.bomPath), false);
  assert.ok(bomBefore.includes('machine-design'));
});

test('overwrite 同名文件后撤销恢复旧文件内容', async () => {
  const { root, bus } = setup();
  await apply(bus, { design: designFor({ id: 'same-line', name: 'Old' }) });
  const oldText = readFileSync(machineDesignPath(root, 'same-line'), 'utf8');
  await apply(bus, { design: designFor({ id: 'same-line', name: 'New' }), overwrite: true });
  await bus.undoLast();
  assert.equal(readFileSync(machineDesignPath(root, 'same-line'), 'utf8'), oldText);
  assert.equal(readActivePointer(root)?.name, 'Old');
});

test('路径净化：id 中的 ../ 与绝对路径不会逃出 machine 目录', async () => {
  const { root, bus } = setup();
  const design = designFor();
  design.config.id = '../../evil/line';
  const result = await apply(bus, { design });
  assert.equal(result.ok, true);
  assert.equal(result.data.machineId, 'evil-line');
  assert.equal(resolve(result.data.designPath).startsWith(resolve(root, 'machine')), true);
  assert.equal(result.data.designPath.includes('..'), false);
  assert.equal(result.data.machineId.includes('/'), false);
  assert.equal(readActivePointer(root)?.machineId, 'evil-line');
});

test('确认被拒绝时不执行写命令，也不落盘', async () => {
  const { root } = setup();
  let first = true;
  const llm = {
    async chat() {
      if (first) {
        first = false;
        return {
          content: '',
          toolCalls: [{
            id: 'call-apply',
            type: 'function',
            function: { name: 'apply_machine_design', arguments: JSON.stringify({ brief: BRIEF }) }
          }]
        };
      }
      return { content: '已取消。', toolCalls: [] };
    }
  };
  const calls = [];
  const bridge = {
    async call(method) {
      calls.push(method);
      return { ok: true };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, { userDataRoot: root });
  const session = new AgentSession({ llm, bus, confirmWrite: async () => false, maxIterations: 3 });
  const reply = await session.run('把机型方案应用到工程');
  assert.equal(reply, '已取消。');
  assert.equal(existsSync(activeMachinePath(root)), false);
  assert.equal(existsSync(join(root, 'machine')), false);
  assert.equal(calls.length, 0);
});

test('离线路由识别机型落盘并输出 apply_machine_design', () => {
  const match = routeIntent('把当前机型方案落地到工程并生成 BOM');
  assert.equal(match.intent, 'modify');
  const plan = planTool('把当前机型方案落地到工程并生成 BOM');
  assert.equal(plan?.tool, 'apply_machine_design');
  assert.equal(plan?.readOnly, false);
  assert.equal(plan?.args.withBom, true);
  assert.deepEqual(plan?.missing, ['design']);
  assert.equal(planTool('把机型方案写入工程并生成 PLC 点位映射')?.args.withPlc, true);
});

test('落盘时把 form.id 写进 machine json，可复现形态', async () => {
  const { bus } = setup();
  const result = await apply(bus, { brief: '六工位转盘锁螺丝机，10 件/分钟' });
  assert.equal(result.ok, true);
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.form.id, 'dial-6');
  assert.equal(stored.form.geometry.kind, 'dial');
  assert.equal(stored.form.name, '六工位转盘机');
  assert.equal(result.data.geometry.layout, 'dial');
});

test('machine json 保存 form.stationRange，重载后仍是同一形态', async () => {
  const { root, bus } = setup();
  const result = await apply(bus, { brief: '六工位锁螺丝机，节拍 10 件/分钟' });
  assert.equal(result.ok, true);
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.form.id, 'dial-6');
  assert.deepEqual(stored.form.stationRange, [2, 6]);
  const reloaded = readStoredMachineDesign(root, result.data.machineId);
  assert.ok(reloaded);
  assert.equal(reloaded.form.id, 'dial-6');
  assert.deepEqual(reloaded.form.stationRange, [2, 6]);
  assert.equal(reloaded.form.defaultStations, 6);
});

test('apply 的 design 入参保留 form 并传给几何', async () => {
  const { bus } = setup();
  const design = designFor({ brief: '两工位点胶机，18 件/分钟', id: 'gantry-form' });
  assert.equal(design.form.id, 'gantry-2');
  const result = await apply(bus, { design });
  assert.equal(result.ok, true);
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.form.id, 'gantry-2');
  assert.equal(result.data.geometry.layout, 'gantry');
});

test('design.form 仅含 id/name/rationale/alternatives 时也能落盘并按 id 推断几何', async () => {
  const { bus } = setup();
  const design = designFor({ brief: '六工位转盘锁螺丝机，10 件/分钟', id: 'dial-min-form' });
  design.form = {
    id: 'dial-6',
    name: '六工位转盘机',
    rationale: '测试用最小 form 记录',
    alternatives: []
  };
  const result = await apply(bus, { design });
  assert.equal(result.ok, true);
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.equal(stored.form.id, 'dial-6');
  assert.equal(stored.form.geometry.kind, 'dial');
  assert.equal(result.data.geometry.layout, 'dial');
});
