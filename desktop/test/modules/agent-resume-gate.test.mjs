import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleManager, MODULE_SETTINGS_KEY } from '../../src/modules/registry.ts';
import {
  AGENT_RESUME_DISABLED_MESSAGE,
  AGENT_RESUME_MODULE_ID,
  isAgentResumeEnabled
} from '../../src/modules/agent-resume-gate.ts';
import { executePlan } from '../../src/agent/planner.ts';

function memoryStorage(initial = null) {
  const data = new Map();
  if (initial !== null) data.set(MODULE_SETTINGS_KEY, initial);
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); }
  };
}

test('agent.resume 是依赖 core 的 API v1 可选模块，默认开启并声明专用能力', () => {
  const manager = createModuleManager(memoryStorage());
  const module = manager.getStatus(AGENT_RESUME_MODULE_ID);
  assert.equal(module.id, 'agent.resume');
  assert.equal(module.version, '1.0.0');
  assert.deepEqual(module.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(module.dependencies, ['core']);
  assert.deepEqual(module.requiredCapabilities, ['agent.plan.checkpoint', 'agent.plan.cross-restart-resume']);
  assert.equal(module.kind, 'optional');
  assert.equal(module.defaultEnabled, true);
  assert.equal(module.implemented, true);
  assert.equal(module.status, 'enabled');
});

test('关闭和重新启用只改模块设置；旧 checkpoint sentinel 始终保留', () => {
  const storage = memoryStorage();
  const checkpoint = '{"sentinel":"existing-checkpoint-must-remain-untouched"}';
  storage.data.set('agent-plan-checkpoint.json', checkpoint);
  const manager = createModuleManager(storage);

  assert.equal(manager.getStatus('agent.resume').enabled, true);
  manager.setEnabled('agent.resume', false);
  assert.equal(manager.getStatus('agent.resume').status, 'disabled');
  assert.equal(storage.getItem('agent-plan-checkpoint.json'), checkpoint);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'agent.resume': false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(restarted.getStatus('agent.resume').enabled, false);
  assert.equal(storage.getItem('agent-plan-checkpoint.json'), checkpoint);
  restarted.setEnabled('agent.resume', true);
  assert.equal(restarted.getStatus('agent.resume').enabled, true);
  assert.equal(storage.getItem('agent-plan-checkpoint.json'), checkpoint);
});

test('缺少 resume 专用 capability 时不可用且拒绝启用', () => {
  const manager = createModuleManager(memoryStorage(), {
    capabilities: ['workspace.project-storage', 'workspace.extension-host', 'agent.plan.checkpoint']
  });
  const state = manager.getStatus('agent.resume');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.enabled, false);
  assert.match(state.reason, /agent\.plan\.cross-restart-resume/);
  assert.throws(() => manager.setEnabled('agent.resume', true), /缺少所需能力/);
});

test('resume gate 对缺失、异常或非 true 状态 fail-closed', () => {
  assert.equal(isAgentResumeEnabled(undefined), false);
  assert.equal(isAgentResumeEnabled(() => { throw new Error('status unavailable'); }), false);
  assert.equal(isAgentResumeEnabled(() => 1), false);
  assert.equal(isAgentResumeEnabled(() => false), false);
  assert.equal(isAgentResumeEnabled(() => true), true);
  assert.match(AGENT_RESUME_DISABLED_MESSAGE, /普通 Agent 计划仍可执行/);
});

test('关闭 agent.resume 不影响普通计划执行及写操作确认回调', async () => {
  const manager = createModuleManager(memoryStorage());
  manager.setEnabled('agent.resume', false);
  let confirmations = 0;
  let executions = 0;
  const result = await executePlan({
    steps: [{ tool: 'update_component', args: { ref: 'QF1', patch: { model: 'A' } }, why: '修改元件', readOnly: false }],
    confidence: 1
  }, {
    execute: async () => { executions += 1; return { ok: true }; },
    confirmPlan: async () => { confirmations += 1; return true; }
  });
  assert.equal(result.ok, true);
  assert.equal(confirmations, 1);
  assert.equal(executions, 1);
  assert.equal(manager.getStatus('agent.resume').enabled, false);
});
