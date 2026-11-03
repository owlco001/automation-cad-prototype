import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { agentToolTotal } from '../../test-support/agent-registry.mjs';
import { READ_ONLY_TOOLS, planReadOnly, planTool, routeIntent } from '../../src/agent/router.ts';

const tools = new AgentTools({ listParts: () => [] });
const BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';

test('design_machine 已注册且为只读工具', () => {
  assert.equal(tools.has('design_machine'), true);
  assert.equal(READ_ONLY_TOOLS.has('design_machine'), true);
  assert.equal(tools.list().length, agentToolTotal());
});

test('design_machine schema：brief 必填，stationCount 1–12，cyclePerMin > 0', () => {
  const schema = tools.summaries().find((tool) => tool.name === 'design_machine')?.inputSchema;
  assert.ok(schema);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['brief']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.brief.type, 'string');
  assert.equal(schema.properties.stationCount.type, 'integer');
  assert.equal(schema.properties.stationCount.minimum, 1);
  assert.equal(schema.properties.stationCount.maximum, 12);
  assert.equal(schema.properties.cyclePerMin.type, 'number');
  assert.equal(schema.properties.cyclePerMin.exclusiveMinimum, 0);
});

test('design_machine 空 brief 返回 INVALID_ARGUMENT', async () => {
  for (const brief of ['', '   ', 42]) {
    const result = await tools.call('design_machine', { brief });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGUMENT');
  }
});

test('design_machine 工位数超范围或非整数时报错', async () => {
  for (const stationCount of [0, 13, 2.5, '3']) {
    const result = await tools.call('design_machine', { brief: BRIEF, stationCount });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.match(result.message, /stationCount/);
  }
});

test('design_machine 节拍非正数时报错', async () => {
  for (const cyclePerMin of [0, -1, Number.NaN, '20']) {
    const result = await tools.call('design_machine', { brief: BRIEF, cyclePerMin });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.match(result.message, /cyclePerMin/);
  }
});

test('design_machine 返回 config/cycle/power/bomDraft/warnings/assumptions 与摘要', async () => {
  const result = await tools.call('design_machine', { brief: BRIEF, stationCount: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.design.config.stations.length, 3);
  assert.equal(result.design.config.actuators.length, 6);
  assert.equal(result.design.config.sensors.length, 3);
  assert.equal(result.design.cycle.perMin, 20);
  assert.equal(result.design.cycle.secondsPerPiece, 3);
  assert.ok(result.design.power.va > 0);
  assert.ok(result.design.bomDraft.items.length > 0);
  assert.ok(result.design.warnings.some((warning) => /形态选型.*缺口/.test(warning)));
  assert.equal(result.design.form.id, 'linear-4');
  assert.deepEqual(result.design.form.stationRange, [2, 4]);
  assert.equal(result.design.form.defaultStations, 4);
  assert.ok(result.design.assumptions.length >= 3);
  assert.ok(result.summary.length <= 600);
  assert.match(result.summary, /3/);
  assert.match(result.summary, /20 件\/分钟/);
});

test('design_machine 覆盖参数优先于 brief', async () => {
  const result = await tools.call('design_machine', {
    brief: '设计一台四工位装配线，12 件/分钟',
    stationCount: 2,
    cyclePerMin: 30
  });
  assert.equal(result.ok, true);
  assert.equal(result.design.config.stations.length, 2);
  assert.equal(result.design.cycle.perMin, 30);
});

test('design_machine 返回追问元数据：完整需求为空，信息不足最多 2 项', async () => {
  const complete = await tools.call('design_machine', { brief: BRIEF });
  assert.deepEqual(complete.needs, []);
  assert.equal(complete.question, null);

  const vague = await tools.call('design_machine', { brief: '随便设计一台检测机' });
  assert.deepEqual(vague.needs, ['stations', 'cycle']);
  assert.equal(typeof vague.question, 'string');
  assert.match(vague.question, /默认按 2 工位生成/);
  assert.equal(vague.design.config.stations.length, 2);
});

test('design_machine 缺执行机构时使用工艺模板并在 assumptions 说明', async () => {
  const result = await tools.call('design_machine', { brief: '两工位包装机，15 件/分钟' });
  assert.equal(result.ok, true);
  assert.equal(result.design.config.sensors.length, 2);
  assert.ok(result.design.assumptions.some((line) => line.includes('按 包装 模板补全')));
});

test('design_machine 五类模板都能通过工具层生成且 sensors/actuators 非空', async () => {
  const briefs = [
    '两工位锁螺丝机，20 件/分钟',
    '两工位点胶机，18 件/分钟',
    '两工位装配线，12 件/分钟',
    '两工位检测机，30 件/分钟',
    '两工位包装机，15 件/分钟'
  ];
  for (const brief of briefs) {
    const result = await tools.call('design_machine', { brief });
    assert.equal(result.ok, true, brief);
    assert.ok(result.design.config.actuators.length >= 2, brief);
    assert.ok(result.design.config.sensors.length >= 2, brief);
    assert.deepEqual(result.needs, [], brief);
  }
});

test('design_machine 的覆盖参数会消除对应追问项', async () => {
  const result = await tools.call('design_machine', {
    brief: '帮我设计一台机器',
    stationCount: 3,
    cyclePerMin: 18
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.needs, ['process']);
  assert.match(result.question, /哪类工艺/);
  assert.doesNotMatch(result.question, /几个工位|目标节拍/);
  assert.equal(result.design.config.stations.length, 3);
  assert.equal(result.design.cycle.perMin, 18);
});

test('离线路由把机型设计请求映射到 design_machine（只读）', () => {
  const match = routeIntent(BRIEF);
  assert.equal(match.intent, 'generate');
  const plan = planTool(BRIEF);
  assert.equal(plan?.tool, 'design_machine');
  assert.equal(plan?.readOnly, true);
  assert.deepEqual(plan?.args, { brief: BRIEF });
  assert.equal(planReadOnly(BRIEF)?.tool, 'design_machine');
});

test('机型设计请求不会被误判为超纲或写操作', () => {
  for (const text of [
    '做一台两工位点胶机，3 秒一件',
    '设计一条四工位装配线，带安全光栅',
    '设计一台检测机，六个工位，节拍 30 件/分钟'
  ]) {
    assert.equal(routeIntent(text).intent, 'generate', text);
    assert.equal(planTool(text)?.tool, 'design_machine', text);
    assert.equal(planReadOnly(text)?.tool, 'design_machine', text);
  }
});

test('design_machine 不调用命令总线、不落盘', async () => {
  let calls = 0;
  const bus = {
    async execute() { calls += 1; return { ok: true, data: {} }; },
    async undoLast() { calls += 1; return { ok: true, data: {} }; }
  };
  const local = new AgentTools({ listParts: () => [] }, bus);
  const result = await local.call('design_machine', { brief: BRIEF });
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});
