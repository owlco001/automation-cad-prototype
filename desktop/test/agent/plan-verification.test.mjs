/**
 * 计划 / 配方两条编排路径的自适应预算 + 写后自动验证 + 续跑
 *
 * 背景：`runPlan` / `runRecipe` 不经过 `AgentSession`，所以会话层的
 * 「预算上抬」与「写后自动验证」在用户点「执行计划 / 跑配方」时曾经完全没生效。
 * 这组测试锁住三件事：
 * 1. 预算与会话层同源（`session.ts#resolveIterationBudget`：只读 6 / 含写或 ≥4 步 12）；
 * 2. 写后验证与会话层同入口（`verify.ts#autoVerifyTool`），且不判步骤失败；
 * 3. 到顶停下后能从上一次的 `nextStepIndex` 继续，已完成的步骤不丢、不重跑。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentThread,
  planSignature,
  resumeRunPlan,
  resumePoint,
  runPlan
} from '../../src/agent/thread.ts';
import { runRecipe } from '../../src/agent/recipes.ts';
import { READ_ONLY_TOOLS } from '../../src/agent/router.ts';
import {
  READ_ONLY_ITERATION_BUDGET,
  WRITE_ITERATION_BUDGET
} from '../../src/agent/session.ts';

const CONTEXT = {};
const READ_TOOLS = ['get_bom', 'run_cost_report', 'get_project_context'];
const WRITE_TOOL = 'apply_machine_design';

function plan(tools) {
  return {
    confidence: 0.9,
    steps: tools.map((tool) => ({
      tool,
      args: {},
      why: `测试步骤 ${tool}`,
      readOnly: READ_ONLY_TOOLS.has(tool)
    }))
  };
}

/** 记录执行顺序的执行器；可注入单步失败。 */
function recorder(options = {}) {
  const executed = [];
  return {
    executed,
    execute: async (step, index) => {
      executed.push(index);
      if (options.failIndex === index) {
        return { ok: false, code: 'INJECTED_FAILED', message: '注入失败' };
      }
      return { ok: true, data: { index } };
    }
  };
}

function channel(result = { ok: true, issues: [] }) {
  const state = { calls: 0 };
  return {
    state,
    channel: {
      validateMachineDesign: async () => {
        state.calls += 1;
        return { ok: true, data: result };
      }
    }
  };
}

test('runPlan：含写步骤预算抬到 12，纯只读计划保持 6', async () => {
  const writeCalls = recorder();
  const writeRun = await runPlan(plan(['get_bom', WRITE_TOOL]), {
    execute: writeCalls.execute,
    confirmPlan: async () => true,
    currentContext: CONTEXT
  });
  assert.equal(writeRun.budget.base, READ_ONLY_ITERATION_BUDGET);
  assert.equal(writeRun.budget.effective, WRITE_ITERATION_BUDGET);
  assert.equal(writeRun.budget.reason, 'write');
  assert.equal(writeRun.ok, true);
  assert.equal(writeRun.iterations, 2);
  assert.equal(writeRun.stopped, undefined);
  // 没有接验证通道时不补 verification 字段，也不伪造 ok。
  assert.equal(writeRun.results[1].verification, undefined);

  const readRun = await runPlan(plan(READ_TOOLS), {
    execute: recorder().execute,
    currentContext: CONTEXT
  });
  assert.equal(readRun.budget.effective, READ_ONLY_ITERATION_BUDGET);
  assert.equal(readRun.budget.reason, 'read-only');
  assert.equal(readRun.ok, true);
});

test('runPlan：到顶返回 iteration_limit + pendingHint + nextStepIndex，已完成步骤保留', async () => {
  const steps = Array.from({ length: 15 }, () => 'get_bom');
  const run = recorder();
  const result = await runPlan(plan(steps), { execute: run.execute, currentContext: CONTEXT });

  assert.equal(result.budget.reason, 'long-plan');
  assert.equal(result.budget.effective, WRITE_ITERATION_BUDGET);
  assert.equal(result.stopped, 'iteration_limit');
  assert.equal(result.iterations, 12);
  assert.equal(result.nextStepIndex, 12);
  assert.deepEqual(run.executed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // 已完成的 12 步必须留在结果里，不是被丢弃或整体判失败。
  assert.equal(result.results.length, 12);
  assert.equal(result.results.every((item) => item.ok), true);
  assert.match(result.pendingHint, /预算上限 12/);
  assert.match(result.pendingHint, /第 13 步/);
  assert.match(result.summary, /第 13 步起未执行/);
});

test('runPlan：从 nextStepIndex 续跑能接上，不重跑已完成步骤', async () => {
  const steps = Array.from({ length: 15 }, () => 'run_cost_report');
  const thread = new AgentThread();
  const first = recorder();
  const started = await runPlan(plan(steps), {
    execute: first.execute,
    thread,
    currentContext: CONTEXT
  });
  assert.equal(started.stopped, 'iteration_limit');

  const state = thread.read();
  assert.equal(state.nextStepIndex, 12);
  assert.equal(resumePoint(plan(steps), state), 12);
  assert.equal(state.planSignature, planSignature(plan(steps)));

  const second = recorder();
  const resumed = await resumeRunPlan(plan(steps), {
    execute: second.execute,
    thread,
    currentContext: CONTEXT
  });

  assert.deepEqual(second.executed, [12, 13, 14], '只执行剩下的 3 步');
  assert.equal(resumed.resumedFrom, 12);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.stopped, undefined);
  assert.equal(resumed.results.length, 3);
  // 续跑完成后不再残留续跑位置，避免下一轮又从 12 开始。
  assert.equal(thread.read().nextStepIndex, undefined);
});

test('runPlan：apply 类写步骤成功后带 verification.ok=true', async () => {
  const run = recorder();
  const { channel: verifyChannel, state } = channel({ ok: true, issues: [] });
  const result = await runPlan(plan(['get_bom', WRITE_TOOL]), {
    execute: run.execute,
    confirmPlan: async () => true,
    verifyChannel,
    currentContext: CONTEXT
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].verification?.ok, true);
  assert.deepEqual(result.results[1].verification?.issues, []);
  // 只读步骤不触发自查。
  assert.equal(result.results[0].verification, undefined);
  assert.equal(state.calls, 1);
});

test('runPlan：验证抛错时步骤仍成功，verification.ok=null', async () => {
  const run = recorder();
  const result = await runPlan(plan([WRITE_TOOL]), {
    execute: run.execute,
    confirmPlan: async () => true,
    verifyChannel: {
      validateMachineDesign: async () => {
        throw new Error('validate_machine_design 崩了');
      }
    },
    currentContext: CONTEXT
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].verification?.ok, null);
  assert.match(result.results[0].verification?.error ?? '', /崩了/);
  assert.equal(result.stopped, undefined);
});

test('runPlan：自查发现问题只加提示，不把写步骤判失败', async () => {
  const run = recorder();
  const { channel: verifyChannel } = channel({
    ok: false,
    issues: [{ code: 'SAFETY_REF_UNDEFINED', message: '安全回路未定义' }]
  });
  const result = await runPlan(plan([WRITE_TOOL]), {
    execute: run.execute,
    confirmPlan: async () => true,
    verifyChannel,
    currentContext: CONTEXT
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].verification?.ok, false);
  assert.match(result.results[0].verification?.nextAction ?? '', /补齐安全回路/);
  assert.match(result.summary, /写后自查未通过/);
});

test('runRecipe：同样有预算与写后验证', async () => {
  const calls = [];
  const { channel: verifyChannel, state } = channel({ ok: true, issues: [] });
  const result = await runRecipe(
    'electrical-delivery',
    { machine: { name: 'SF-2026-01' } },
    {
      execute: async (step, index) => {
        calls.push(index);
        return { ok: true, data: { step: step.id } };
      },
      confirm: async () => true,
      verifyChannel
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.budget?.effective, WRITE_ITERATION_BUDGET);
  assert.equal(result.budget?.reason, 'write');
  assert.equal(result.iterations, 5);
  assert.equal(result.stopped, undefined);
  // 只有 run_plc_generate 属于 AUTO_VERIFY_TOOLS。
  const plcStep = result.results.find((item) => item.tool === 'run_plc_generate');
  assert.equal(plcStep?.verification?.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(result.results.filter((item) => item.verification).length, 1);
});

test('runRecipe：预算到顶保留已完成步骤，可从 nextStepIndex 续跑', async () => {
  const ctx = { machine: { name: 'SF-2026-01' } };
  const first = [];
  const truncated = await runRecipe('electrical-delivery', ctx, {
    execute: async (step, index) => {
      first.push(index);
      return { ok: true, data: { step: step.id } };
    },
    confirm: async () => true,
    maxSteps: 2
  });

  assert.deepEqual(first, [0, 1]);
  assert.equal(truncated.ok, false);
  assert.equal(truncated.code, 'ITERATION_LIMIT');
  assert.equal(truncated.stopped, 'iteration_limit');
  // 显式 maxSteps 比预算小时，budget 如实收窄成本轮真实上限，不虚报 12。
  assert.equal(truncated.budget?.effective, 2);
  assert.equal(truncated.nextStepIndex, 2);
  assert.equal(truncated.iterations, 2);
  assert.equal(truncated.results.length, 2);
  assert.equal(truncated.completed.length, 2, '已完成的步骤不能被丢掉');
  assert.equal(truncated.kept.length, 2);
  assert.equal(truncated.failedStep, undefined);
  assert.match(truncated.pendingHint, /第 3 步/);

  const second = [];
  const resumed = await runRecipe('electrical-delivery', ctx, {
    execute: async (step, index) => {
      second.push(index);
      return { ok: true, data: { step: step.id } };
    },
    confirm: async () => true,
    resumeFrom: truncated.nextStepIndex
  });

  assert.deepEqual(second, [2, 3, 4], '不重跑已完成的第 1–2 步');
  assert.equal(resumed.resumedFrom, 2);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.iterations, 3);
});

test('runRecipe：失败即停 + 保留已执行步骤的旧行为不变', async () => {
  const calls = [];
  const result = await runRecipe(
    'electrical-delivery',
    { machine: { name: 'SF-2026-01' } },
    {
      execute: async (step, index) => {
        calls.push(index);
        if (index === 2) return { ok: false, code: 'PRECHECK_FAILED', message: '预检 2 error' };
        return { ok: true, data: { step: step.id } };
      },
      confirm: async () => true
    }
  );

  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STEP_FAILED');
  assert.equal(result.errorCode, 'PRECHECK_FAILED');
  assert.equal(result.failedAt, 3);
  assert.equal(result.failedTool, 'verify_plc_program');
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.completed.map((item) => item.index), [0, 1]);
  assert.deepEqual(result.kept.map((item) => item.index), [0, 1]);
  assert.equal(result.stopped, undefined, '失败不是预算停下');
  assert.equal(result.budget?.effective, WRITE_ITERATION_BUDGET);
  assert.match(result.summary, /已停止后续 2 步/);
});
