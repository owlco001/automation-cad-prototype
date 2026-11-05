/**
 * 「转向输送机」这类口语需求的整链回归（自然语言入口 → 规则路由 → design_machine → 机型 config）。
 *
 * 为什么不只断言 router：`eval/run-eval.mjs` 只验「判得对不对」，判对了工具也可能合成出
 * 一台完全没有移载单元的机器。这里用**真 AgentSession + 真 AgentTools + 真 CommandBus**
 * （组合与 electron/ipc.ts:1463 的 agentExecutor 相同：先命令总线，未知命令回落工具层），
 * 只把模型换成「不可用」——于是走应用内的离线规则通道，句子进的是真实入口，不是旁路。
 *
 * 四条句子对应 eval 评估集 tf01–tf04，末态断言在这里钉住：
 *   tf01 必须出移载工位 + transfer-lift(Z) + transfer-push(+Y) + 两个 DO + 两个 DI，且无 turner-*；
 *   tf02 普通输送线不得长出移载；
 *   tf03 「顶升旋转 90° 转向」必须出 turner-lift + turner-rotary（两个意图能区分）；
 *   tf04 带宽 800 < 下限 1080，必须拒建并给出算式，不得静默建成。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentSession } from '../../src/agent/session.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { planTool, routeIntent } from '../../src/agent/router.ts';

const BRIEF_TRANSFER = '转向输送机，不改变板材方向，顶升后向 90° 方向输送板材，并给下游输送机一个信号';
const BRIEF_PLAIN = '普通皮带输送线';
const BRIEF_TURNER = '顶升旋转 90° 转向的输送机，带宽 1200mm，线体长 6000mm';
const BRIEF_NARROW = '加一个移载工位，带宽 800mm，线体长 6000mm';

/** 模型不可用：AgentSession 按设计回落到离线规则路由（只读工具照常执行）。 */
const offlineLlm = {
  async chat() {
    throw new Error('nl-transfer-scenario: 模型不可用，走离线规则通道');
  }
};

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'cad-nl-transfer-'));
  const bridge = {
    async call(method) {
      switch (method) {
        case 'applyMachineConfig':
        case 'markPlcGenerated':
          return { ok: true };
        case 'getPlcGenConfig':
          return null;
        case 'getProjectContext':
          return { machine: null, plate: { placed: 0, width: 600, height: 400, recentActions: [] }, bomRows: 0, hasCadModel: false };
        case 'appendMachineBomRows':
          return { ok: true, added: 0 };
        case 'removeMachineBomRows':
          return { ok: true, removed: 0 };
        default:
          return { ok: false, message: `未接的渲染层方法：${method}` };
      }
    }
  };
  const registry = { listParts: () => [] };
  const bus = createAgentCommandBus(registry, bridge, { userDataRoot: root, exportsRoot: join(root, 'exports') });
  const tools = new AgentTools(registry, bus, { userDataRoot: root });
  const executed = [];
  const executor = {
    async execute(name, args = {}, signal) {
      const result = await bus.execute(name, args, signal);
      if (!result.ok && result.error?.code === 'UNKNOWN_COMMAND' && tools.has(name)) {
        const fallback = await tools.call(name, args, signal);
        const record = fallback && typeof fallback === 'object' ? fallback : null;
        const normalized = record?.ok === false
          ? { ok: false, error: { code: record.code ?? 'TOOL_FAILED', message: record.message ?? `${name} 执行失败` } }
          : { ok: true, data: fallback };
        executed.push({ name, args, result: normalized });
        return normalized;
      }
      executed.push({ name, args, result });
      return result;
    },
    undoLast(signal) {
      return bus.undoLast(signal);
    },
    validateMachineDesign(signal) {
      return bus.execute('validate_machine_design', {}, signal);
    }
  };
  return { root, bus, tools, executor, executed };
}

/** 走一次真实入口：一句话 → 一轮会话 → 取 design_machine 的 config。 */
async function runSentence(text) {
  const h = createHarness();
  try {
    const session = new AgentSession({ llm: offlineLlm, bus: h.executor, confirmWrite: async () => false });
    const reply = await session.run(text);
    const design = h.executed.find((step) => step.name === 'design_machine');
    assert.ok(design, `句子「${text}」没有走到 design_machine，实际执行：${h.executed.map((s) => s.name).join(',') || '(无)'}`);
    assert.equal(design.result.ok, true, `design_machine 返回失败：${design.result.error?.message ?? ''}`);
    assert.equal(session.replyMode, 'offline', '模型不可用时应走离线规则通道');
    const { config, warnings = [], assumptions = [] } = design.result.data.design;
    return { config, reply, warnings, assumptions, executed: h.executed };
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
}

const axisIds = (config) => config.actuators.map((axis) => axis.id);
const sensorPoints = (config) => config.sensors.map((sensor) => sensor.point);

test('tf01 口语「转向输送机，不转板，顶升后向 90° 输送并给下游信号」→ 顶升移载（不是转向）', async () => {
  const { config } = await runSentence(BRIEF_TRANSFER);

  assert.equal(routeIntent(BRIEF_TRANSFER).intent, 'generate', '无「设计」动词的机型描述句应判生成意图');
  assert.equal(planTool(BRIEF_TRANSFER)?.tool, 'design_machine');

  // 工位
  assert.ok(config.stations.includes('移载工位'), `工位缺移载工位：${config.stations.join(',')}`);
  assert.ok(!config.stations.includes('转向工位'), `不应有转向工位：${config.stations.join(',')}`);

  // 轴：Z 顶升 + Y 移载，且没有回转轴
  const ids = axisIds(config);
  assert.ok(ids.includes('transfer-lift'), `缺 transfer-lift：${ids.join(',')}`);
  assert.ok(ids.includes('transfer-push'), `缺 transfer-push：${ids.join(',')}`);
  assert.ok(!ids.includes('turner-rotary'), `不应出现 turner-rotary：${ids.join(',')}`);
  assert.ok(!ids.includes('turner-lift'), `不应出现 turner-lift：${ids.join(',')}`);
  const lift = config.actuators.find((axis) => axis.id === 'transfer-lift');
  const push = config.actuators.find((axis) => axis.id === 'transfer-push');
  assert.deepEqual(lift.position, [0, 0, 0.05], '顶升轴是 +Z');
  assert.deepEqual(push.position, [0, 0.05, 0], '移载轴必须是 +Y（不是 X 也不是旋转）');
  assert.ok(push.travelMm >= 1060, `移载行程应 ≥ 板宽 + 结构间隙，实际 ${push.travelMm}`);
  assert.equal(lift.kind, 'cylinder');
  assert.equal(push.kind, 'cylinder');
  assert.equal(push.rotationRangeDeg, undefined, '移载轴不是旋转轴，不能带 rotationRangeDeg');

  // 信号：两个 DO 扩展点位 + 两个 DI 回读
  const ioIds = (config.ioPoints ?? []).map((point) => point.point);
  assert.ok(ioIds.includes('DO-TRANSFER-READY'), `ioPoints 缺 DO-TRANSFER-READY：${ioIds.join(',')}`);
  assert.ok(ioIds.includes('DO-TRANSFER-DONE'), `ioPoints 缺 DO-TRANSFER-DONE：${ioIds.join(',')}`);
  assert.ok(sensorPoints(config).includes('DI-DOWNSTREAM-ALLOW'), '传感器缺 DI-DOWNSTREAM-ALLOW');
  assert.ok(sensorPoints(config).includes('DI-TRANSFER-END'), '传感器缺 DI-TRANSFER-END');
  // 唯一剩下的 rotary 轴是模板对「减速电机驱动滚筒」的既有表达，不在转向工位上
  for (const axis of config.actuators.filter((item) => item.kind === 'rotary')) {
    assert.ok(!/转向/.test(axis.station), `转向工位上不应有旋转轴：${axis.id}`);
  }
});

test('tf02 负向：普通皮带输送线不长移载轴', async () => {
  const { config } = await runSentence(BRIEF_PLAIN);
  const ids = axisIds(config);
  assert.ok(!ids.includes('transfer-lift'), `普通输送线不应有顶升轴：${ids.join(',')}`);
  assert.ok(!ids.includes('transfer-push'), `普通输送线不应有移载轴：${ids.join(',')}`);
  assert.ok(!config.stations.includes('移载工位'), `普通输送线不应有移载工位：${config.stations.join(',')}`);
  assert.equal(config.ioPoints, undefined, '普通输送线不应有移载握手点位');
  assert.ok(!sensorPoints(config).includes('DI-DOWNSTREAM-ALLOW'));
});

test('tf03 负向交叉：「顶升旋转 90° 转向」出转向工位，不出移载', async () => {
  const { config } = await runSentence(BRIEF_TURNER);
  const ids = axisIds(config);
  assert.ok(ids.includes('turner-lift'), `转向工位应有顶升轴：${ids.join(',')}`);
  assert.ok(ids.includes('turner-rotary'), `转向工位应有回转轴：${ids.join(',')}`);
  const rotary = config.actuators.find((axis) => axis.id === 'turner-rotary');
  assert.equal(rotary.rotationRangeDeg, 90, '回转轴角度来自需求（90°）');
  assert.ok(!ids.includes('transfer-push'), `转向不应被判成移载：${ids.join(',')}`);
  assert.ok(!config.stations.includes('移载工位'), '转向机型不应有移载工位');
});

test('tf04 负向：带宽 800 < 移载下限 1080，必须拒建并给算式', async () => {
  const { config, warnings } = await runSentence(BRIEF_NARROW);
  const ids = axisIds(config);
  assert.ok(!ids.includes('transfer-lift'), `不该静默建成顶升轴：${ids.join(',')}`);
  assert.ok(!ids.includes('transfer-push'), `不该静默建成移载轴：${ids.join(',')}`);
  assert.ok(!config.stations.includes('移载工位'), '不该静默建成移载工位');
  // 拒建理由必须是算式（1080 = 2×(440 + 80 + 20)），不是一句「已忽略」
  const text = warnings.join('\n');
  assert.match(text, /顶升移载/, '警告没有点名被拒的机构');
  assert.match(text, /1080/, '拒建理由里没有最小带宽 1080');
  assert.match(text, /440/, '拒建理由里没有台板半宽下限 440');
  assert.match(text, /800 mm < 顶升移载所需最小 1080 mm/, `拒建文案不是带宽对比：${text}`);
});
