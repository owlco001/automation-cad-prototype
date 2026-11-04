/**
 * 自适应迭代预算 + 写后自动验证（机制层）
 *
 * 这里钉住两件事的**代码行为**，不是提示词行为：
 * 1. 只读问答 6 轮、含写工具或长计划 12 轮；到顶时给 stopped/pendingHint 而不是报错；
 *    连续只读且无新信息时提前收尾，不拖满上限。
 * 2. apply_machine_design / repair_plc_config / run_plc_generate 成功后自动调
 *    validate_machine_design，把结论附进工具回执；验证失败不影响主操作。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentSession,
  resolveIterationBudget,
  READ_ONLY_ITERATION_BUDGET,
  WRITE_ITERATION_BUDGET,
  REPEATED_READ_STEP_LIMIT
} from '../../src/agent/session.ts';
import { parseToolResultData } from '../../src/agent/guard.ts';

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function createLlm(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof response === 'function' ? await response(messages) : response;
    }
  };
}

/**
 * 假执行器：`validate` 是写后自动验证通道（对应主进程的 validateMachineDesign）。
 * 不传 validate 就等于「执行器没有验证通道」，用来钉住「不伪造已验证」。
 */
function createBus(handler, options = {}) {
  const calls = [];
  const validations = [];
  return {
    calls,
    validations,
    async execute(name, args = {}) {
      calls.push({ name, args });
      if (handler) return await handler(name, args);
      return { ok: true, data: { name, args } };
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: {} };
    },
    ...(options.validate
      ? {
          async validateMachineDesign() {
            validations.push(1);
            return await options.validate();
          }
        }
      : {})
  };
}

function createSession(llm, bus, overrides = {}) {
  return new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    offlineFallback: false,
    ...overrides
  });
}

function toolMessages(messages) {
  return messages.filter((message) => message.role === 'tool');
}

function validationOk() {
  return { ok: true, data: { ok: true, issues: [], summary: { errors: 0, warnings: 0 }, source: 'active' } };
}

function validationFailed(issues) {
  return {
    ok: true,
    data: { ok: false, issues, summary: { errors: issues.length, warnings: 0 }, source: 'active' }
  };
}

/* ------------------------------ 预算规则 ------------------------------ */

test('预算规则：纯只读问答按基线 6 轮（不传 maxIterations 也是 6）', async () => {
  assert.deepEqual(resolveIterationBudget({}), {
    base: READ_ONLY_ITERATION_BUDGET,
    effective: 6,
    reason: 'read-only'
  });
  assert.equal(READ_ONLY_ITERATION_BUDGET, 6);

  const llm = createLlm([
    { content: '', toolCalls: [toolCall('c1', 'list_components', { q: '气缸' })] },
    { content: '找到一个气缸。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus());
  const reply = await session.run('列出气缸');
  assert.equal(reply, '找到一个气缸。');
  assert.deepEqual(session.turnOutcome().budget, {
    base: 6,
    effective: 6,
    reason: 'read-only'
  });
  assert.equal(session.turnOutcome().stopped, undefined);
});

test('预算规则：出现写工具抬到 12，只读基线不动', async () => {
  assert.equal(resolveIterationBudget({ hasWrite: true }).effective, 12);
  assert.equal(resolveIterationBudget({ hasWrite: true }).reason, 'write');
  // 显式基线更小时，只抬到 12 而不是压回基线
  assert.deepEqual(resolveIterationBudget({ base: 3, hasWrite: true }), {
    base: 3,
    effective: WRITE_ITERATION_BUDGET,
    reason: 'write'
  });
  // 显式基线更大时保持用户配置（50 是 llm-config 的上限）
  assert.equal(resolveIterationBudget({ base: 20, hasWrite: true }).effective, 20);

  const llm = createLlm([
    { content: '', toolCalls: [toolCall('a1', 'apply_machine_design', { brief: '三工位锁螺丝机' })] },
    { content: '已应用。', toolCalls: [] }
  ]);
  const bus = createBus(
    async (name) => (name === 'apply_machine_design'
      ? { ok: true, data: { machineId: 'm-1', stations: 3 } }
      : { ok: true, data: {} }),
    { validate: async () => validationOk() }
  );
  const session = createSession(llm, bus);
  await session.run('把方案应用到工程');
  assert.deepEqual(session.turnOutcome().budget, { base: 6, effective: 12, reason: 'write' });
});

test('预算规则：计划 ≥4 步抬到 12，3 步仍是 6', async () => {
  assert.equal(resolveIterationBudget({ planSteps: 4 }).effective, 12);
  assert.equal(resolveIterationBudget({ planSteps: 4 }).reason, 'long-plan');
  assert.equal(resolveIterationBudget({ planSteps: 3 }).effective, 6);

  const readOnlyTurn = () =>
    createLlm([
      { content: '', toolCalls: [toolCall('c1', 'get_project_context')] },
      { content: '已读取工程上下文。', toolCalls: [] }
    ]);

  const longPlan = createSession(readOnlyTurn(), createBus(), { planSteps: 4 });
  await longPlan.run('读一下工程上下文');
  assert.deepEqual(longPlan.turnOutcome().budget, { base: 6, effective: 12, reason: 'long-plan' });

  const shortPlan = createSession(readOnlyTurn(), createBus(), { planSteps: 3 });
  await shortPlan.run('读一下工程上下文');
  assert.equal(shortPlan.turnOutcome().budget.effective, 6);
});

/* ------------------------------ 到顶收尾 ------------------------------ */

test('到顶不是报错：返回 iteration_limit + pendingHint，并说清下一句怎么继续', async () => {
  let round = 0;
  const llm = createLlm([
    () => {
      round += 1;
      return round === 1
        ? { content: '', toolCalls: [toolCall('a1', 'apply_machine_design', { brief: '三工位锁螺丝机' })] }
        // 每轮参数都不同 → 结果都不同 → 不会触发「只读无新信息」提前收尾
        : { content: '', toolCalls: [toolCall(`r${round}`, 'list_components', { q: `q${round}` })] };
    }
  ]);
  const bus = createBus(
    async (name, args) => (name === 'apply_machine_design'
      ? { ok: true, data: { machineId: 'm-1' } }
      : { ok: true, data: { name, args } }),
    { validate: async () => validationOk() }
  );
  const session = createSession(llm, bus);
  const reply = await session.run('设计并应用一台锁螺丝机，然后生成 PLC');

  const outcome = session.turnOutcome();
  assert.equal(outcome.stopped, 'iteration_limit');
  assert.equal(outcome.iterations, WRITE_ITERATION_BUDGET);
  assert.equal(outcome.budget.effective, 12);
  assert.match(outcome.pendingHint ?? '', /已应用方案但还没生成 PLC/);
  // 回复是正常答复，不是错误：带上限数字 + 可继续的提示
  assert.match(reply, /已达到最大工具调用轮数（12）/);
  assert.match(reply, /继续请说「继续」/);
  assert.doesNotMatch(reply, /^\s*(错误|失败|Error)/i);
  assert.equal(llm.calls.length, WRITE_ITERATION_BUDGET);
});

test('只读空转提前收尾：连续 3 步无新信息就停，不拖满 6 轮', async () => {
  const llm = createLlm([() => ({ content: '', toolCalls: [toolCall('same', 'get_bom')] })]);
  const bus = createBus(async () => ({ ok: true, data: { rows: [{ no: 1, name: '气缸' }] } }));
  const session = createSession(llm, bus);
  const reply = await session.run('反复读 BOM');

  const outcome = session.turnOutcome();
  assert.equal(outcome.stopped, 'repeated_reads');
  assert.equal(outcome.iterations, REPEATED_READ_STEP_LIMIT + 1);
  assert.ok(outcome.iterations < 6, `仍拖满了上限：${outcome.iterations}`);
  assert.ok(outcome.pendingHint);
  assert.match(reply, /没有返回新信息/);
  // 空转收尾不能说成「达到最大轮数」，那是另一条路径
  assert.doesNotMatch(reply, /达到最大工具调用轮数/);
  assert.equal(llm.calls.length, REPEATED_READ_STEP_LIMIT + 1);
});

/* ------------------------------ 写后自动验证 ------------------------------ */

test('apply_machine_design 成功后自动验证，回执带 verification.ok=true 且不改原字段', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('a1', 'apply_machine_design', { brief: '三工位锁螺丝机' })] },
    { content: '已应用。', toolCalls: [] }
  ]);
  const bus = createBus(
    async () => ({ ok: true, data: { machineId: 'm-1', stations: 3, sensors: 8 } }),
    { validate: async () => validationOk() }
  );
  const audit = [];
  const session = createSession(llm, bus, { audit: (record) => audit.push(record) });
  const reply = await session.run('把方案应用到工程');
  assert.equal(reply, '已应用。');

  const parsed = parseToolResultData(toolMessages(llm.calls[1]).at(-1).content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.machineId, 'm-1'); // 原有字段原样保留
  assert.equal(parsed.data.stations, 3);
  assert.equal(parsed.verification.ok, true);
  assert.equal(parsed.verification.source, 'auto');
  assert.deepEqual(parsed.verification.issues, []);
  assert.equal(bus.validations.length, 1);
  assert.equal(audit.find((entry) => entry.tool === 'apply_machine_design')?.verified, true);
});

test('repair_plc_config 后自动验证：ok=false 时附 nextAction 并把审计标 verified=false', async () => {
  const issues = [
    { code: 'SAFETY_REF_UNDEFINED', path: 'sensors[3]', message: '急停回路没有绑定传感器' }
  ];
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('r1', 'repair_plc_config', { dryRun: false })] },
    { content: '已补齐。', toolCalls: [] }
  ]);
  const bus = createBus(
    async () => ({ ok: true, data: { added: [], remainingIssues: issues } }),
    { validate: async () => validationFailed(issues) }
  );
  const audit = [];
  const session = createSession(llm, bus, { audit: (record) => audit.push(record) });
  const reply = await session.run('补齐 PLC 缺口');
  assert.equal(reply, '已补齐。');

  const parsed = parseToolResultData(toolMessages(llm.calls[1]).at(-1).content);
  assert.equal(parsed.ok, true); // 主操作仍成功
  assert.equal(parsed.verification.ok, false);
  assert.equal(parsed.verification.issues.length, 1);
  assert.equal(parsed.verification.source, 'auto');
  assert.match(parsed.verification.nextAction, /补齐安全回路/);
  assert.equal(audit.find((entry) => entry.tool === 'repair_plc_config')?.verified, false);
});

test('自动验证抛错不影响主操作：verification.ok=null + error，审计不写 verified', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('p1', 'run_plc_generate', { target: 's7-1200' })] },
    { content: 'PLC 已生成。', toolCalls: [] }
  ]);
  const bus = createBus(
    async () => ({ ok: true, data: { fileCount: 11, path: 'exports/plc/x' } }),
    {
      validate: async () => {
        throw new Error('校验通道崩溃');
      }
    }
  );
  const audit = [];
  const session = createSession(llm, bus, { audit: (record) => audit.push(record) });
  const reply = await session.run('生成 PLC 程序');
  assert.equal(reply, 'PLC 已生成。');

  const parsed = parseToolResultData(toolMessages(llm.calls[1]).at(-1).content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.fileCount, 11);
  assert.equal(parsed.verification.ok, null);
  assert.match(parsed.verification.error, /校验通道崩溃/);
  assert.equal(audit.find((entry) => entry.tool === 'run_plc_generate')?.ok, true);
  assert.equal(audit.find((entry) => entry.tool === 'run_plc_generate')?.verified, undefined);
});

test('工具已自带验证结论时不重复调验证通道', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('a1', 'apply_machine_design', { brief: '二工位装配机' })] },
    { content: '已应用。', toolCalls: [] }
  ]);
  const bus = createBus(
    async () => ({
      ok: true,
      data: { machineId: 'm-2' },
      verification: { ok: true, issues: [], source: 'auto' }
    }),
    { validate: async () => validationOk() }
  );
  const session = createSession(llm, bus);
  await session.run('把方案应用到工程');
  assert.equal(bus.validations.length, 0);
  const parsed = parseToolResultData(toolMessages(llm.calls[1]).at(-1).content);
  assert.equal(parsed.verification.ok, true);
});

test('非自动验证工具不附 verification；没有验证通道时如实记 ok=null 不伪造通过', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('i1', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '已插入。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus(async () => ({ ok: true, data: { inserted: 1 } })));
  await session.run('插入一个气缸');
  const parsed = parseToolResultData(toolMessages(llm.calls[1]).at(-1).content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verification, undefined);

  // 同一个写工具在「执行器没有验证通道」时不能假装验证过
  const noChannelLlm = createLlm([
    { content: '', toolCalls: [toolCall('a1', 'apply_machine_design', { brief: '二工位装配机' })] },
    { content: '已应用。', toolCalls: [] }
  ]);
  const noChannel = createSession(
    noChannelLlm,
    createBus(async () => ({ ok: true, data: { machineId: 'm-3' } }))
  );
  await noChannel.run('把方案应用到工程');
  const unchecked = parseToolResultData(toolMessages(noChannelLlm.calls[1]).at(-1).content);
  assert.equal(unchecked.ok, true);
  assert.equal(unchecked.verification.ok, null);
  assert.match(unchecked.verification.error, /未提供 validate_machine_design 通道/);
});
