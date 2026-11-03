// 机型自查 / PLC 预检缺口补齐两个智能体工具 + assumptions 超 20 条落盘（G1）。
//
// 断言口径：
// - 工具层走真实 AgentTools + CommandBus（假 bridge 只记调用），不 mock 校验与补齐逻辑；
// - validate 必须与落盘/预检同一判定源（machine/validate.ts），且永远不抛错；
// - repair 默认 dryRun：不写盘；dryRun=false 写回 match/<id>.json 并让预检归零；
// - 裁剪（trim.ts）只作用于给模型的返回，落盘数据永不裁剪：25 条 assumptions 必须原样读回。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { planTool, routeIntent } from '../../src/agent/router.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { machineDesignPath, readStoredMachineDesign } from '../../src/machine/store.ts';
import { precheck } from '../../src/plcgen/precheck.ts';
import { validateDesign } from '../../src/machine/validate.ts';

const BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cad-design-repair-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: 0 };
      if (method === 'removeMachineBomRows') return { ok: true, removed: 0 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-11-03T02:00:00.000Z')
  });
  return { root, calls, bus, tools: new AgentTools(registry, bus) };
}

/** 结构合法的最小方案：两台执行机构各有到位检测，且带急停回路。 */
function legalDesign() {
  return {
    config: {
      id: 'design-legal-2st',
      name: '两工位检测机',
      stations: ['上料', '检测'],
      actuators: [
        { id: 'st1-cyl', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'ST1-CYL-OUT', retractPoint: 'ST1-CYL-IN' },
        { id: 'st2-grip', name: '检测夹爪', kind: 'gripper', station: '检测', gripPoint: 'ST2-GRIP' }
      ],
      sensors: [
        { point: 'ST1-CYL-PRX', station: '上料', part: 'st1-cyl' },
        { point: 'ST2-GRIP-PRX', station: '检测', part: 'st2-grip' },
        { point: 'ESTOP-1', station: '检测', part: '急停' },
        { point: 'DOOR-1', station: '检测', part: '安全门' }
      ]
    },
    stations: ['上料', '检测'],
    points: ['ST1-CYL-OUT', 'ST1-CYL-IN', 'ST2-GRIP', 'ST1-CYL-PRX', 'ST2-GRIP-PRX', 'ESTOP-1', 'DOOR-1'],
    warnings: [],
    assumptions: ['结构自查用的最小方案'],
    bomDraft: { items: [] }
  };
}

/** 缺安全回路、也缺部分到位检测的方案（synth 出来的真机型就是这样）。 */
function gapDesign() {
  const design = synthMachine(parseMachineBrief(BRIEF));
  return {
    ...design,
    bomDraft: { items: [] },
    warnings: [],
    assumptions: ['方案缺安全回路与部分到位检测，用于补齐用例']
  };
}

async function applyDesign(bus, design) {
  const result = await bus.execute('apply_machine_design', {
    design,
    name: design.config.name,
    overwrite: true,
    withGeometry: false
  });
  assert.equal(result.ok, true, `落盘机型失败：${JSON.stringify(result.error ?? {})}`);
  return design.config.id;
}

function fileState(path) {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, sha: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

test('validate：合法方案返回 ok 且 issues 为空', async () => {
  const { tools, bus } = setup();
  await applyDesign(bus, legalDesign());

  const result = await tools.call('validate_machine_design', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.summary, { errors: 0, warnings: 0 });
  assert.equal(result.source, 'active');
});

test('validate：缺安全回路不影响结构结论，缺口由 repair 如实报出（各带 hint 与 path）', async () => {
  const { tools, bus } = setup();
  const design = gapDesign();
  await applyDesign(bus, design);

  // 安全回路属 PLC 预检，不在 validate 的职责内——自查不能越权把它报成结构错误。
  const validated = await tools.call('validate_machine_design', {});
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.deepEqual(validated.issues, []);

  const preview = await tools.call('repair_plc_config', {});
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.dryRun, true);
  assert.ok(preview.willAdd.length >= 2, `缺口应至少含急停与安全门：${JSON.stringify(preview.willAdd)}`);
  const kinds = new Set(preview.willAdd.map((entry) => entry.kind));
  assert.ok(kinds.has('add-estop') && kinds.has('add-safety-door'), JSON.stringify([...kinds]));
  const estop = preview.issues.find((issue) => issue.code === 'ESTOP_UNDEFINED');
  assert.ok(estop, `issues 里应有 ESTOP_UNDEFINED：${JSON.stringify(preview.issues)}`);
  assert.ok(estop.hint && estop.hint.length > 0, '缺口必须带 hint（怎么补）');
  assert.equal(typeof estop.message, 'string');
  assert.equal(preview.remainingIssues.some((issue) => issue.code === 'ESTOP_UNDEFINED'), true);
});

test('validate：传感器绑定错误返回带 path 与 hint 的 issues', async () => {
  const { tools } = setup();
  const broken = {
    config: {
      ...legalDesign().config,
      sensors: [
        { point: 'ST9-ORPHAN', station: '上料', part: '不存在的执行机构' },
        { point: 'ST1-CYL-PRX', station: '上料', part: 'st1-cyl' }
      ]
    }
  };
  const result = await tools.call('validate_machine_design', { config: broken.config });
  assert.equal(result.ok, false);
  const issue = result.issues.find((entry) => entry.code === 'SENSOR_UNBOUND');
  assert.ok(issue, JSON.stringify(result.issues));
  assert.equal(issue.path, 'config.sensors[0].part');
  assert.ok(issue.hint && issue.hint.length > 0, 'SENSOR_UNBOUND 必须带 hint');
  assert.equal(result.summary.errors, result.issues.length);
});

test('validate：非法输入不抛错，返回 CONFIG_SHAPE issues', async () => {
  const { tools } = setup();
  for (const config of ['not-a-design', 42, null, [], {}, { stations: [], actuators: [], sensors: [] }]) {
    const result = await tools.call('validate_machine_design', { config });
    assert.equal(result.ok, false, `应判非法：${JSON.stringify(config)}`);
    assert.ok(result.issues.length > 0, `非法输入必须有 issues：${JSON.stringify(config)}`);
    assert.equal(result.issues[0].code, 'CONFIG_SHAPE');
    assert.equal(result.summary.warnings, 0);
  }
});

test('validate：没有 active 机型时不报错，返回 NO_MACHINE', async () => {
  const { tools } = setup();
  const result = await tools.call('validate_machine_design', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_MACHINE');
  assert.deepEqual(result.issues, []);
});

test('repair dryRun（默认）：不写盘，文件内容与 mtime 都不变', async () => {
  const { root, tools, bus } = setup();
  const id = await applyDesign(bus, gapDesign());
  const path = machineDesignPath(root, id);
  const before = fileState(path);

  const result = await tools.call('repair_plc_config', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.added, []);
  assert.ok(result.willAdd.length > 0);
  for (const entry of result.willAdd) {
    assert.equal(typeof entry.point, 'string');
    assert.equal(typeof entry.kind, 'string');
    assert.equal(typeof entry.reason, 'string');
  }
  assert.deepEqual(fileState(path), before, 'dryRun 不得改动机型方案文件');
});

test('repair dryRun=false：写回方案，补齐后预检 0 错', async () => {
  const { root, tools, bus, calls } = setup();
  const id = await applyDesign(bus, gapDesign());
  const path = machineDesignPath(root, id);
  const before = fileState(path);

  const result = await tools.call('repair_plc_config', { dryRun: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dryRun, false);
  assert.ok(result.added.length > 0, '应如实列出补了什么');
  assert.deepEqual(result.remainingIssues, [], JSON.stringify(result.remainingIssues));

  const after = fileState(path);
  assert.notEqual(after.sha, before.sha, 'dryRun=false 必须写盘');

  const stored = readStoredMachineDesign(root, id);
  assert.ok(stored, '补齐后的方案必须还能读回');
  assert.equal(precheck(stored.config).errors.length, 0, JSON.stringify(precheck(stored.config).errors));
  assert.equal(stored.assumptions.some((line) => /PLC 预检缺口按最小改动补齐/.test(line)), true);
  // 补齐必须同步联调面板配置，否则 run_plc_generate 缺省读到的还是旧配置。
  assert.equal(calls.filter((entry) => entry.method === 'applyMachineConfig').length >= 2, true);
});

test('repair：已补齐时 willAdd/added/remainingIssues 全空且不再写盘', async () => {
  const { root, tools, bus } = setup();
  const id = await applyDesign(bus, gapDesign());
  const path = machineDesignPath(root, id);

  assert.equal((await tools.call('repair_plc_config', { dryRun: false })).ok, true);
  const settled = fileState(path);

  const again = await tools.call('repair_plc_config', { dryRun: false });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.willAdd, []);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.remainingIssues, []);
  assert.deepEqual(fileState(path), settled, '已补齐时不得重写文件');

  const preview = await tools.call('repair_plc_config', {});
  assert.deepEqual(preview.willAdd, []);
  assert.equal(preview.dryRun, true);
});

test('G1：25 条 assumptions 的方案能落盘，并原样读回 25 条（落盘不裁剪）', async () => {
  const { root, bus } = setup();
  const design = synthMachine(parseMachineBrief(BRIEF));
  const assumptions = Array.from({ length: 25 }, (_, index) => `假设 ${index + 1}：按模板取值，待现场复核。`);
  const result = await bus.execute('apply_machine_design', {
    design: { ...design, assumptions, bomDraft: { items: [] }, warnings: [] },
    name: design.config.name,
    withGeometry: false
  });
  assert.equal(result.ok, true, `25 条 assumptions 不应让 apply 失败：${JSON.stringify(result.error ?? {})}`);

  const stored = readStoredMachineDesign(root, design.config.id);
  assert.ok(stored);
  assert.equal(stored.assumptions.length, 25);
  assert.deepEqual(stored.assumptions, assumptions);
  assert.equal(existsSync(machineDesignPath(root, design.config.id)), true);
});

test('G1：模型回填裁剪形状 {items,total,truncated} 也能落盘（形状归一，不截断）', async () => {
  const { root, bus } = setup();
  const design = synthMachine(parseMachineBrief(BRIEF));
  const assumptions = Array.from({ length: 20 }, (_, index) => `裁剪后的假设 ${index + 1}`);
  const result = await bus.execute('apply_machine_design', {
    design: {
      ...design,
      assumptions: { items: assumptions, total: 25, truncated: true },
      warnings: [],
      bomDraft: { items: [] }
    },
    name: design.config.name,
    withGeometry: false
  });
  assert.equal(result.ok, true, `裁剪形状不应被拒：${JSON.stringify(result.error ?? {})}`);
  const stored = readStoredMachineDesign(root, design.config.id);
  assert.ok(stored);
  assert.deepEqual(stored.assumptions, assumptions);
});

test('路由：自查/补齐/写回/PLC 生成四类意图都判到对的工具与读写属性', () => {
  const validatePlan = planTool('检查当前机型方案是否合法');
  assert.equal(validatePlan?.tool, 'validate_machine_design');
  assert.equal(validatePlan?.readOnly, true);
  assert.equal(routeIntent('检查当前机型方案是否合法').intent, 'query');

  const previewPlan = planTool('PLC 预检缺安全回路，先看看要补什么');
  assert.equal(previewPlan?.tool, 'repair_plc_config');
  assert.equal(previewPlan?.readOnly, false);
  assert.equal(previewPlan?.args.dryRun, true);
  assert.equal(routeIntent('PLC 预检缺安全回路，先看看要补什么').intent, 'modify');

  const writePlan = planTool('确认补齐 PLC 预检缺口');
  assert.equal(writePlan?.tool, 'repair_plc_config');
  assert.equal(writePlan?.args.dryRun, false);

  const generatePlan = planTool('生成 PLC 程序');
  assert.equal(generatePlan?.tool, 'run_plc_generate', '补齐规则不得抢走生成 PLC');
});

test('validateDesign 与 repair 的判定同源：合法方案预检也不因结构被拒', () => {
  const design = legalDesign();
  assert.equal(validateDesign(design.config).ok, true);
  assert.deepEqual(precheck(design.config).errors.map((issue) => issue.code), []);
});
