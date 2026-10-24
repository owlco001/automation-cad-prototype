import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalJson,
  createPlanCheckpoint,
  inspectPlanCheckpoint,
  isPlanCheckpointFullyCompleted,
  loadPlanCheckpoint,
  savePlanCheckpoint,
  updatePlanCheckpoint,
  updatePlanCheckpointFingerprint
} from '../../src/agent/plan-checkpoint.ts';

const projectA = 'a'.repeat(64);
const projectB = 'b'.repeat(64);

function plan(overrides = {}) {
  return {
    steps: [
      { tool: 'update_component', args: { ref: 'QF1', patch: { model: 'A' } }, why: '写入', readOnly: true },
      { tool: 'get_bom', args: {}, why: '读取', readOnly: false }
    ],
    confidence: 1,
    ...overrides
  };
}

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'agent-plan-checkpoint-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function resignEnvelope(file) {
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  envelope.checksum = createHash('sha256').update(canonicalJson(envelope.payload), 'utf8').digest('hex');
  writeFileSync(file, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
}

test('跨重启 round-trip 保留已完成写步骤，并只从下一未完成游标恢复', () => withTempDir((root) => {
  const current = plan();
  let checkpoint = createPlanCheckpoint(current, projectA, '2026-10-24T00:00:00.000Z');
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed', '2026-10-24T00:00:01.000Z');
  savePlanCheckpoint(root, checkpoint);

  // 模拟新进程重新加载，而不是复用原内存对象。
  const loaded = loadPlanCheckpoint(root);
  assert.equal(loaded.error, undefined);
  assert.ok(loaded.checkpoint);
  const restored = inspectPlanCheckpoint(loaded.checkpoint, current, projectA);
  assert.equal(restored.ok, true);
  assert.equal(restored.cursor, 1);
  assert.equal(restored.steps[0].state, 'completed');
  assert.equal(restored.steps[0].wrote, true);
  assert.equal(restored.needsReconfirmation, false);

  const invoked = [];
  for (let index = restored.cursor; index < restored.steps.length; index += 1) {
    if (restored.steps[index].state !== 'completed') invoked.push(index);
  }
  assert.deepEqual(invoked, [1], '已完成写步骤不得因重启重复调用');
}));

test('写操作成功后以写后工程摘要提交，重启比对当前工程并跳过该写步骤', () => {
  const current = plan();
  let checkpoint = createPlanCheckpoint(current, projectA);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'running');
  checkpoint = updatePlanCheckpointFingerprint(checkpoint, projectB);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed');

  const restored = inspectPlanCheckpoint(checkpoint, current, projectB);
  assert.equal(restored.ok, true);
  assert.equal(restored.cursor, 1);
  assert.equal(restored.steps[0].state, 'completed');
  assert.equal(inspectPlanCheckpoint(checkpoint, current, projectA).ok, false);
});

test('只有连续全部完成的 checkpoint 可安全被独立新计划替换', () => {
  let checkpoint = createPlanCheckpoint(plan(), projectA);
  assert.equal(isPlanCheckpointFullyCompleted(checkpoint), false);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed');
  assert.equal(isPlanCheckpointFullyCompleted(checkpoint), false);
  checkpoint = updatePlanCheckpoint(checkpoint, 1, 'completed');
  assert.equal(isPlanCheckpointFullyCompleted(checkpoint), true);
  assert.equal(isPlanCheckpointFullyCompleted({ ...checkpoint, cursor: 0 }), false);
});

test('签名变化、工程指纹变化或缺失时拒绝恢复', () => {
  let checkpoint = createPlanCheckpoint(plan(), projectA);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed');
  assert.equal(inspectPlanCheckpoint(checkpoint, plan({ steps: [
    ...plan().steps,
    { tool: 'get_bom', args: { q: 'changed' }, why: '不同计划', readOnly: true }
  ] }), projectA).ok, false);
  assert.equal(inspectPlanCheckpoint(checkpoint, plan(), projectB).ok, false);
  assert.equal(inspectPlanCheckpoint(checkpoint, plan(), null).ok, false);
});

test('未完成写步骤在恢复后保持待执行且明确要求再次授权', () => {
  let checkpoint = createPlanCheckpoint(plan(), projectA);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'completed');
  const restored = inspectPlanCheckpoint(checkpoint, plan(), projectA);
  assert.equal(restored.ok, true);
  assert.equal(restored.cursor, 1);
  assert.equal(restored.steps[1].state, 'pending');
  assert.equal(restored.steps[1].wrote, false);

  const writePlan = { steps: [plan().steps[0]], confidence: 1 };
  const pendingWrite = inspectPlanCheckpoint(createPlanCheckpoint(writePlan, projectA), writePlan, projectA);
  assert.equal(pendingWrite.ok, true);
  assert.equal(pendingWrite.cursor, 0);
  assert.equal(pendingWrite.needsReconfirmation, true);
});

test('崩溃时仍 running 的写步骤被标记为不确定并要求重新规划', () => {
  const writePlan = { steps: [plan().steps[0]], confidence: 1 };
  let checkpoint = createPlanCheckpoint(writePlan, projectA);
  checkpoint = updatePlanCheckpoint(checkpoint, 0, 'running');
  const restored = inspectPlanCheckpoint(checkpoint, writePlan, projectA);
  assert.equal(restored.ok, false);
  assert.equal(restored.reason, 'uncertain-write');
  assert.match(restored.message, /重新规划/);
});

test('损坏 JSON、校验和错误与合法校验和下的未知 schema 都 fail-closed', () => withTempDir((root) => {
  const current = plan();
  const checkpoint = createPlanCheckpoint(current, projectA);
  savePlanCheckpoint(root, checkpoint);
  const file = join(root, 'agent-plan-checkpoint.json');

  writeFileSync(file, '{truncated', 'utf8');
  assert.equal(loadPlanCheckpoint(root).checkpoint, null);
  assert.ok(loadPlanCheckpoint(root).error);

  savePlanCheckpoint(root, checkpoint);
  const tampered = JSON.parse(readFileSync(file, 'utf8'));
  tampered.payload.cursor = 1;
  writeFileSync(file, JSON.stringify(tampered), 'utf8');
  assert.match(loadPlanCheckpoint(root).error, /校验/);

  savePlanCheckpoint(root, checkpoint);
  const unsupported = JSON.parse(readFileSync(file, 'utf8'));
  unsupported.payload.version = 99;
  writeFileSync(file, JSON.stringify(unsupported), 'utf8');
  resignEnvelope(file);
  assert.match(loadPlanCheckpoint(root).error, /版本/);
}));

test('checkpoint 不包含原始计划参数，含 API key 或工具凭据的计划会被拒绝持久化', () => withTempDir((root) => {
  const sensitivePlan = {
    steps: [{
      tool: 'update_component',
      args: { apiKey: 'checkpoint-secret-api-key', token: 'checkpoint-secret-token', ref: 'QF1' },
      why: 'test',
      readOnly: true
    }],
    confidence: 1
  };
  savePlanCheckpoint(root, createPlanCheckpoint(plan(), projectA));
  const serialized = readFileSync(join(root, 'agent-plan-checkpoint.json'), 'utf8');
  assert.doesNotMatch(serialized, /QF1/);
  assert.match(serialized, /planSignature/);
  assert.match(serialized, /projectFingerprint/);
  assert.throws(() => createPlanCheckpoint(sensitivePlan, projectA), /敏感凭据/);
  assert.doesNotMatch(serialized, /checkpoint-secret-api-key|checkpoint-secret-token/);
}));
