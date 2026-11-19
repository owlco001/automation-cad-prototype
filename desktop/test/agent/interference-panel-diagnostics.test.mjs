/**
 * 承托/通道诊断接进 agent 工具层（run_interference → run_interference_check）。
 *
 * 守的是什么：
 * 1. `requirePanel` 必须真的**穿过**工具层 → 命令层 → `runInterferenceStates`。只测
 *    `panel-channel.ts` 绿、命令层把参数丢掉，是这条链路最容易「看起来接好了」的假绿；
 *    本文件用「非塔 / 无板必须 INVALID_ARGUMENT」来证明它没被吞（命令层若不下发，
 *    这两种机型会照旧返回 ok:true —— 见 §「缺省不变」用例的对照断言）。
 * 2. 塔 config 走 **active 设计**（readActiveMachineDesign → resolveMachineGeometry 的塔分派），
 *    回执同时带 panelSupport / panelFeasibility / panelChannelNote，且 `feasible=false` 有 blockers。
 * 3. 口径不许写歪：生产塔的几何**包含真实板**（`geometry.parts` 里的 workpiece-plate），所以
 *    `mode` 可以是 `verified`；但 verified 只说明「行表来自几何 + 板在碰撞集」，不是结构可行——
 *    rest 仍 `unsupported`（单条整带）、carried 仍 `diagnostic-only`（板不随塔轴移动）、`feasible=false`。本文件不出现
 *    「结构可行」这种结论 —— 诊断读数不是结构验收。
 * 4. requirePanel 缺省（或 false）时回执与旧行为逐字节一致（老调用方不受影响）。
 * 4b. requirePanel 只认布尔：`'true'`/`1`/`{}` 在**命令层与工具层**都 INVALID_ARGUMENT
 *    （命令层曾用 `=== true` 判定，直接把非布尔吞成旧行为）；`states:[]`+requirePanel
 *    同理不许退化成绿。
 * 5. 结果大小截断规则仍适用：该回执本身 >10 KB，走 `serializeToolResult` 会被截成
 *    preview + resultId（外置全文仍含三个 panel 字段，`get_tool_result` 可取回）。
 * 6. 回执文案与结构化结论同源：`panelChannelNote` 只印 `claim`。承托行坐标非有限值时
 *    `verdict` 仍可能算出 supported，但 `claim` 已降级成 diagnostic-only —— 文案里
 *    绝不许出现 `rest supported` 这种读法（N13 在 `runInterferenceStates` 这一层的回归）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { TOOL_RESULT_BYTE_LIMIT, serializeToolResult, trimToolResult } from '../../src/agent/trim.ts';
import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { validateMachineDesign, writeStoredMachineDesign } from '../../src/machine/store.ts';
import { m1ChannelFixture, m1TowerConfig } from '../../test-support/m1-channel-fixture.mjs';

const roots = [];
const registry = { listParts: () => [] };
/** 任何 bridge 调用都算失败：位姿化检查不许偷偷去渲染层要静态位姿。 */
const bridge = {
  calls: [],
  async call(method) {
    bridge.calls.push(method);
    return { ok: false, message: `unexpected ${method}` };
  }
};

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 把一份 config 走 validateMachineDesign + writeStoredMachineDesign 落成 active 机型。 */
function setup(config) {
  const root = mkdtempSync(join(tmpdir(), 'cad-agent-channel-'));
  roots.push(root);
  bridge.calls.length = 0;
  const bus = createAgentCommandBus(registry, bridge, { userDataRoot: root });
  const tools = new AgentTools(registry, bus);
  writeStoredMachineDesign(root, validateMachineDesign({ config }));
  return { root, bus, tools };
}

/** 16 层缓存塔：stations/ioPoints 只为过方案校验，几何仍由 config.bufferTower 派生。 */
const towerConfig = () => ({
  ...m1TowerConfig(16),
  id: 'agent-channel-tower',
  stations: ['进出料'],
  ioPoints: [{ point: 'DI-TOWER-LIFT-LEVEL', area: 'input' }]
});

/** 普通输送线（无 transferPart → 几何里没有板）。 */
const conveyorConfig = () => ({
  id: 'agent-channel-belt',
  name: '无板输送线',
  stations: ['上料'],
  actuators: [],
  sensors: [],
  formId: 'belt-line',
  conveyor: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 1 },
  ioPoints: [{ point: 'DI-IN-01', area: 'input' }]
});

/** 带移载工件的输送线：几何里有板，但不是缓存塔（没有升降通道）。 */
const conveyorWithPanelConfig = () => ({
  ...conveyorConfig(),
  id: 'agent-channel-belt-panel',
  name: '带板输送线',
  conveyor: {
    lengthMm: 2400,
    widthMm: 1200,
    beltHeightMm: 900,
    layers: 1,
    transferPartLengthMm: 1200,
    transferPartWidthMm: 800,
    transferPartThicknessMm: 35
  }
});

const toolOf = (tools) => tools.list().find((tool) => tool.name === 'run_interference_check');

test('塔 config 经 active 设计 + requirePanel：回执含 panelSupport/panelFeasibility，feasible=false 且有 blockers', async () => {
  const { bus } = setup(towerConfig());
  const result = await bus.execute('run_interference', { states: ['rest'], requirePanel: true });
  assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
  const data = result.data;
  assert.equal(data.ok, true, JSON.stringify(data).slice(0, 300));
  assert.equal(data.geometrySource, 'buffer-tower-assembly');
  assert.equal(data.partCount, 147, '几何刚体 = 146 装配件 + 板');
  assert.equal(data.assemblyPartCount, 146, '装配件数/BOM/STEP 口径不含板');

  assert.ok(data.panelSupport, 'requirePanel=true 必须交出承托断言');
  assert.ok(data.panelFeasibility, 'requirePanel=true 必须交出通道可行性');
  assert.equal(typeof data.panelChannelNote, 'string');
  assert.match(data.panelChannelNote, /多层通道 feasible=false/);

  // 生产塔：板在碰撞集里 → rest 判决是 verified 口径的 unsupported（单条 1200 整带）；
  // carried 缺板的位移证据（板不随塔轴移动）→ diagnostic-only
  assert.equal(data.panelSupport.rest.claim, 'unsupported');
  assert.equal(data.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(data.panelSupport.rest.verdict, 'unsupported');
  assert.equal(data.panelFeasibility.m1.carriedShiftSource, 'missing');

  assert.equal(data.panelFeasibility.feasible, false, '多层通道不可行是结论，不是失败');
  assert.equal(data.panelFeasibility.diagnosticOnly, false, 'verified ≠ 可行；它只说明行表来自几何 + 板在碰撞集');
  const reasons = data.panelFeasibility.blockers.map((blocker) => blocker.reason);
  assert.ok(reasons.length >= 1, `blockers 不能为空：${JSON.stringify(reasons)}`);
  for (const reason of ['load-passes-shelf', 'stroke-shortfall']) {
    assert.ok(reasons.includes(reason), `缺 blocker ${reason}（实际 ${reasons.join('/')}）`);
  }
  // 净跨/走廊只是保守设计 notes；把「不许断言整板过不去」写进回执文案
  assert.deepEqual(
    data.panelFeasibility.designNotes.map((note) => note.reason),
    ['clear-span-conservative', 'corridor-conservative']
  );
  assert.match(data.panelFeasibility.note, /实测自由上升/, 'note 必须带从件表算出的自由上升');
  assert.match(data.panelFeasibility.note, /不得读成「多层可行」/);
  assert.match(data.panelChannelNote, /verified/, '回执必须自报 mode');
  assert.match(data.panelChannelNote, /不是结构可行/, 'verified 不许写成结构结论');
  assert.match(data.panelFeasibility.note, /不得读成「多层可行」|不得据此断言整板无法通过/);
});

test('承托行坐标非有限值：panelChannelNote 只印 claim=diagnostic-only，不许把 verdict 印成承托结论', () => {
  const fixture = m1ChannelFixture();
  // 正控：同一份 M1 夹具在干净输入下 rest/carried 都是 claim=supported —— 否则下面
  // 「文案里不许出现 supported」可能只是碰巧本来就 unsupported，测不出这次降级。
  const clean = runInterferenceStates({
    states: ['rest', 'lift'],
    config: fixture.config,
    geometry: fixture.geometry,
    requirePanel: true
  });
  assert.equal(clean.ok, true, JSON.stringify(clean).slice(0, 300));
  assert.equal(clean.panelSupport.rest.claim, 'supported');
  assert.equal(clean.panelSupport.carried.claim, 'supported');
  assert.match(clean.panelChannelNote, /rest supported/);
  assert.match(clean.panelChannelNote, /carried supported/);

  // 把一条**真实接触行**的 x 中心改成 NaN：该行被剔除后其余行仍能凑出 verdict=supported，
  // 但 claim 必须降级成 diagnostic-only（N13 的 fail-closed 语义）。
  const geometry = structuredClone(fixture.geometry);
  const poisoned = 'rail-left';
  const row = geometry.parts.find((part) => part.id === poisoned);
  assert.ok(row, `M1 夹具里必须有承托行 ${poisoned}`);
  row.center = [NaN, row.center[1], row.center[2]];

  const dirty = runInterferenceStates({
    states: ['rest', 'lift'],
    config: fixture.config,
    geometry,
    requirePanel: true
  });
  assert.equal(dirty.ok, true, JSON.stringify(dirty).slice(0, 300));
  assert.equal(dirty.partCount, geometry.parts.length, '坏一行不改几何刚体数');

  // 结构化结论是文案的对照基准：claim 已降级、diagnosticCode/invalidPartIds 点名坏行，
  // 而 verdict 照实算成 supported —— 这正是文案不能直接印 verdict 的原因。
  for (const pose of ['rest', 'carried']) {
    const report = dirty.panelSupport[pose];
    assert.equal(report.claim, 'diagnostic-only', `${pose} claim 必须降级`);
    assert.equal(report.diagnosticCode, 'invalid-support-rows', `${pose} 必须带诊断码`);
    assert.deepEqual(report.invalidPartIds, [poisoned], `${pose} 必须点名坏行`);
    assert.equal(report.verdict, 'supported', `${pose} verdict 是几何读数（照实算，但不可引用）`);
  }
  assert.equal(dirty.panelFeasibility.feasible, false);
  assert.equal(dirty.panelFeasibility.m1.feasible, false);
  assert.equal(dirty.panelFeasibility.m1.restSupported, false);
  assert.equal(dirty.panelFeasibility.m1.carriedSupported, false);

  const note = dirty.panelChannelNote;
  assert.equal(typeof note, 'string');
  assert.match(note, /diagnostic-only/, '回执必须自报 claim');
  assert.match(note, /invalid-support-rows/, '回执必须点名诊断码');
  assert.match(note, new RegExp(poisoned), '回执必须点名坏行');
  assert.doesNotMatch(note, /supported/,
    `claim=diagnostic-only 时整段文案都不许出现 supported（会被读成承托成立）：${note}`);
  assert.doesNotMatch(note, /rest supported|carried supported/);
});

test('工具层透传：schema 有 requirePanel，handler 回执与命令层逐字段一致（三键原样）', async () => {
  const { bus, tools } = setup(towerConfig());
  const schema = toolOf(tools).inputSchema;
  assert.equal(schema.properties.requirePanel?.type, 'boolean');
  const description = String(schema.properties.requirePanel?.description ?? '');
  assert.match(description, /承托|通道/);
  assert.match(description, /diagnostic-only/);
  assert.match(description, /verified/, '必须点明 verified 的口径');
  assert.match(description, /不是可行性|不是结构结论/, 'verified 不许写成结构结论');
  assert.doesNotMatch(description, /结构可行/, 'schema 文案不许把诊断写成结构结论');

  const viaTool = await tools.call('run_interference_check', { states: ['rest'], requirePanel: true });
  const viaCommand = await bus.execute('run_interference', { states: ['rest'], requirePanel: true });
  assert.deepEqual(viaTool, viaCommand.data, '工具层只是透传：不许挑字段、不许改口径');

  // 契约字段（消费方按这些名字读，缺一个就是没接上）
  for (const key of ['panelSupport', 'panelFeasibility', 'panelChannelNote']) {
    assert.ok(key in viaTool, `回执缺契约字段 ${key}`);
  }
  for (const key of ['rest', 'carried']) assert.ok(key in viaTool.panelSupport, `panelSupport 缺 ${key}`);
  for (const key of ['feasible', 'blockers', 'diagnosticOnly', 'note', 'm1']) {
    assert.ok(key in viaTool.panelFeasibility, `panelFeasibility 缺 ${key}`);
  }
  assert.equal(viaTool.panelFeasibility.feasible, false);
  assert.equal(viaTool.panelFeasibility.m1.feasible, false, '生产塔首层也不成立（夹具才是 M1 绿）');
});

test('非塔机型 + requirePanel：INVALID_ARGUMENT（命令层与工具层同一结论，不许降级成绿）', async () => {
  const { bus, tools } = setup(conveyorWithPanelConfig());
  const viaCommand = await bus.execute('run_interference', { states: ['rest'], requirePanel: true });
  const viaTool = await tools.call('run_interference_check', { states: ['rest'], requirePanel: true });
  for (const data of [viaCommand.data, viaTool]) {
    assert.equal(data.ok, false);
    assert.equal(data.code, 'INVALID_ARGUMENT');
    assert.match(String(data.message), /只对缓存塔成立/);
  }
});

test('几何里没有板 + requirePanel：INVALID_ARGUMENT（「没查到」不等于「被托住」）', async () => {
  const { bus, tools } = setup(conveyorConfig());
  const viaCommand = await bus.execute('run_interference', { states: ['rest'], requirePanel: true });
  const viaTool = await tools.call('run_interference_check', { states: ['rest'], requirePanel: true });
  for (const data of [viaCommand.data, viaTool]) {
    assert.equal(data.ok, false);
    assert.equal(data.code, 'INVALID_ARGUMENT');
    assert.match(String(data.message), /没有板占位体/);
  }
});

test('requirePanel 缺省 / false：旧行为逐字节不变（非塔照旧 ok，塔回执同形）', async () => {
  const belt = setup(conveyorWithPanelConfig());
  const legacy = await belt.bus.execute('run_interference', { states: ['rest'] });
  assert.equal(legacy.data.ok, true, '不带 requirePanel：非塔机型仍是原来的位姿化检查');
  const explicitFalse = await belt.bus.execute('run_interference', { states: ['rest'], requirePanel: false });
  assert.equal(JSON.stringify(explicitFalse.data), JSON.stringify(legacy.data), 'false 必须等价于不传');

  const tower = setup(towerConfig());
  const withoutFlag = await tower.bus.execute('run_interference', { states: ['rest'] });
  const withFalse = await tower.bus.execute('run_interference', { states: ['rest'], requirePanel: false });
  assert.equal(withoutFlag.data.ok, true);
  assert.equal(withFalse.data.ok, true);
  assert.equal(JSON.stringify(withFalse.data), JSON.stringify(withoutFlag.data));
  // 塔本来就会回 panel 字段（只读诊断），缺省路径不许因此变成失败
  assert.equal(typeof withoutFlag.data.panelChannelNote, 'string');
});

test('requirePanel 没有 states：命令层与工具层都拒绝，不许静默忽略', async () => {
  const { bus, tools } = setup(towerConfig());
  const viaCommand = await bus.execute('run_interference', { requirePanel: true });
  assert.equal(viaCommand.data.ok, false);
  assert.equal(viaCommand.data.code, 'INVALID_ARGUMENT');
  assert.match(String(viaCommand.data.message), /同时传 states|只在位姿化检查/);

  const viaTool = await tools.call('run_interference_check', { requirePanel: true });
  assert.equal(viaTool.ok, false);
  assert.equal(viaTool.code, 'INVALID_ARGUMENT');
  assert.equal(bridge.calls.length, 0, '两种入口都不许打到渲染层拿静态位姿');
});

test('requirePanel 非布尔：命令层与工具层都 INVALID_ARGUMENT（不把 "true"/1/{} 当 true）', async () => {
  const { bus, tools } = setup(towerConfig());
  for (const bad of ['true', 1, {}, null]) {
    const label = `requirePanel=${JSON.stringify(bad)}`;
    // 命令层：直接 bus.execute 的脚本/IPC/eval 绕过工具层，这里以前用 `=== true` 判定，
    // 非布尔就悄悄落回旧行为（ok:true）—— 那条口子必须在命令层自己也堵上。
    const viaCommand = await bus.execute('run_interference', { states: ['rest'], requirePanel: bad });
    assert.equal(viaCommand.data.ok, false, `命令层 ${label} 应当被拒绝，不许静默当旧行为`);
    assert.equal(viaCommand.data.code, 'INVALID_ARGUMENT');
    assert.match(String(viaCommand.data.message), /requirePanel 必须是布尔值/);

    // 工具层：同一句话、同一个码 —— 两层口径漂移进不了 focused 就是漏洞。
    const viaTool = await tools.call('run_interference_check', { states: ['rest'], requirePanel: bad });
    assert.equal(viaTool.ok, false, `工具层 ${label} 应当被拒绝`);
    assert.equal(viaTool.code, 'INVALID_ARGUMENT');
    assert.equal(viaTool.message, viaCommand.data.message, `${label}: 两层拒绝文案必须一致`);
  }
  assert.equal(bridge.calls.length, 0, '非布尔不许被当成 false 落到渲染层静态位姿');
});

test('states 是空数组 + requirePanel:true：INVALID_ARGUMENT（空数组不等于「没给」，也不等于「查过了」）', async () => {
  const { bus, tools } = setup(towerConfig());
  // 空数组会进 states 分支（guard 只查 null/undefined），必须由下游非空校验兜住，
  // 不许退化成「一个状态都没查」的 ok:true —— 那等于「没查 = 没顶住」。
  const viaCommand = await bus.execute('run_interference', { states: [], requirePanel: true });
  assert.equal(viaCommand.data.ok, false, '空 states + requirePanel 不许返回绿');
  assert.equal(viaCommand.data.code, 'INVALID_ARGUMENT');
  assert.match(String(viaCommand.data.message), /非空数组/);

  const viaTool = await tools.call('run_interference_check', { states: [], requirePanel: true });
  assert.equal(viaTool.ok, false);
  assert.equal(viaTool.code, 'INVALID_ARGUMENT');
  assert.equal(viaTool.message, viaCommand.data.message);
  assert.equal(bridge.calls.length, 0, '两种入口都不许打到渲染层拿静态位姿');
});

test('结果大小截断规则仍适用：10 KB 上限截成 preview+resultId，外置全文仍含三个 panel 字段', async () => {
  const { tools } = setup(towerConfig());
  const result = await tools.call('run_interference_check', { states: ['rest'], requirePanel: true });
  assert.equal(result.ok, true);

  let offloaded = null;
  const serialized = serializeToolResult(result, TOOL_RESULT_BYTE_LIMIT, (text) => {
    offloaded = text;
    return { resultId: '0123456789abcdef', bytes: Buffer.byteLength(text, 'utf8') };
  });
  assert.equal(serialized.truncated, true, '带 panel 诊断的回执已超过 10 KB，必须照旧被截');
  assert.equal(serialized.resultId, '0123456789abcdef');
  assert.ok(serialized.bytes <= TOOL_RESULT_BYTE_LIMIT, `回执 ${serialized.bytes}B 超过上限`);
  assert.match(serialized.text, /"ok":true/);

  assert.ok(offloaded, '外置全文必须落盘（否则面板字段就只能看 preview 残片）');
  for (const key of ['panelSupport', 'panelFeasibility', 'panelChannelNote']) {
    assert.ok(offloaded.includes(`"${key}"`), `外置全文缺 ${key}`);
  }
  // 截断前后同源：preview 是这份完整结果的前缀裁剪，不是另一份回执
  const trimmedJson = JSON.stringify(trimToolResult(result));
  assert.equal(offloaded, trimmedJson, '外置内容必须与工具结果按生产裁剪规则序列化后的完整 JSON 一致');
  assert.notEqual(serialized.text, trimmedJson, '模型回执应是 preview，不能误当完整结果');
});
