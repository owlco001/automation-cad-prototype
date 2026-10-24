import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { READ_ONLY_TOOLS } from './router.ts';
import type { AgentPlan } from './planner.ts';

export const PLAN_CHECKPOINT_VERSION = 1 as const;
export const PLAN_CHECKPOINT_FILE = 'agent-plan-checkpoint.json';
const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_PLAN_STEPS = 200;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STEP_STATES = new Set<PlanCheckpointStepState>(['pending', 'running', 'completed', 'failed', 'uncertain']);

export type PlanCheckpointStepState = 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';

export interface PlanCheckpointStep {
  index: number;
  tool: string;
  wrote: boolean;
  state: PlanCheckpointStepState;
}

/** 仅包含恢复所需元数据；不存储计划正文、参数、结果、对话或凭据。 */
export interface PlanCheckpoint {
  version: typeof PLAN_CHECKPOINT_VERSION;
  planSignature: string;
  projectFingerprint: string;
  stepCount: number;
  cursor: number;
  steps: PlanCheckpointStep[];
  createdAt: string;
  updatedAt: string;
}

export interface LoadedPlanCheckpoint {
  checkpoint: PlanCheckpoint | null;
  error?: string;
}

export type CheckpointInspection =
  | { ok: true; cursor: number; steps: PlanCheckpointStep[]; needsReconfirmation: boolean }
  | { ok: false; reason: 'invalid' | 'signature' | 'fingerprint' | 'uncertain-write'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 严格 JSON 规范化：稳定排序对象键，拒绝不可序列化的计划参数。 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('checkpoint 参数含非有限数');
      return item;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new Error('checkpoint 参数含循环引用');
      seen.add(item);
      const output = item.map((entry) => entry === undefined ? null : normalize(entry));
      seen.delete(item);
      return output;
    }
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) throw new Error('checkpoint 参数含循环引用');
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('checkpoint 参数不是普通 JSON 对象');
      seen.add(item);
      const source = item as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) output[key] = normalize(source[key]);
      }
      seen.delete(item);
      return output;
    }
    throw new Error('checkpoint 参数不是 JSON 值');
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertNoCredentialMaterial(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{8,}/i.test(value)) {
      throw new Error('计划包含疑似 API 凭据，不能创建 checkpoint');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) assertNoCredentialMaterial(entry, seen);
    seen.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret|credential|cookie|private[_-]?key|bearer|(?:^|[_-])token(?:$|[_-]))/i.test(key)) {
      throw new Error('计划包含敏感凭据字段，不能创建 checkpoint');
    }
    assertNoCredentialMaterial(entry, seen);
  }
  seen.delete(value);
}

/** 签名只用于匹配同一份计划；持久化时仅保存其 SHA-256，不保存任何参数。 */
export function planCheckpointSignature(plan: AgentPlan): string {
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`计划步骤数必须在 1–${MAX_PLAN_STEPS} 之间`);
  }
  const identity = plan.steps.map((step) => {
    if (!step || typeof step.tool !== 'string' || !step.tool.trim()) throw new Error('计划工具名无效');
    if (!isRecord(step.args)) throw new Error('计划参数必须是普通对象');
    assertNoCredentialMaterial(step.args);
    return { tool: step.tool, args: step.args };
  });
  return sha256(canonicalJson(identity));
}

export function isProjectFingerprint(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function createPlanCheckpoint(
  plan: AgentPlan,
  projectFingerprint: string,
  now = new Date().toISOString()
): PlanCheckpoint {
  if (!isProjectFingerprint(projectFingerprint)) throw new Error('工程指纹不可验证');
  const planSignature = planCheckpointSignature(plan);
  const steps = plan.steps.map((step, index): PlanCheckpointStep => ({
    index,
    tool: step.tool,
    wrote: !READ_ONLY_TOOLS.has(step.tool),
    state: 'pending'
  }));
  return {
    version: PLAN_CHECKPOINT_VERSION,
    planSignature,
    projectFingerprint,
    stepCount: steps.length,
    cursor: 0,
    steps,
    createdAt: now,
    updatedAt: now
  };
}

export function updatePlanCheckpoint(
  checkpoint: PlanCheckpoint,
  index: number,
  state: PlanCheckpointStepState,
  now = new Date().toISOString()
): PlanCheckpoint {
  if (!Number.isInteger(index) || index < 0 || index >= checkpoint.stepCount) {
    throw new Error('checkpoint 步骤游标越界');
  }
  const steps = checkpoint.steps.map((step) => step.index === index ? { ...step, state } : { ...step });
  const cursor = steps.findIndex((step) => step.state !== 'completed');
  return {
    ...checkpoint,
    steps,
    cursor: cursor < 0 ? checkpoint.stepCount : cursor,
    updatedAt: now
  };
}

export function updatePlanCheckpointFingerprint(
  checkpoint: PlanCheckpoint,
  projectFingerprint: string,
  now = new Date().toISOString()
): PlanCheckpoint {
  if (!validateCheckpointPayload(checkpoint)) throw new Error('拒绝更新不合法的 checkpoint');
  if (!isProjectFingerprint(projectFingerprint)) throw new Error('工程指纹不可验证');
  return { ...checkpoint, projectFingerprint, updatedAt: now };
}

function validateCheckpointPayload(value: unknown): PlanCheckpoint | null {
  if (!isRecord(value) || value.version !== PLAN_CHECKPOINT_VERSION) return null;
  if (!isProjectFingerprint(value.planSignature) || !isProjectFingerprint(value.projectFingerprint)) return null;
  if (!Number.isInteger(value.stepCount) || (value.stepCount as number) < 1 || (value.stepCount as number) > MAX_PLAN_STEPS) return null;
  if (!Number.isInteger(value.cursor) || (value.cursor as number) < 0 || (value.cursor as number) > (value.stepCount as number)) return null;
  if (!Array.isArray(value.steps) || value.steps.length !== value.stepCount) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  const steps: PlanCheckpointStep[] = [];
  for (const [index, entry] of value.steps.entries()) {
    if (!isRecord(entry) || entry.index !== index || typeof entry.tool !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(entry.tool)) return null;
    if (typeof entry.wrote !== 'boolean' || entry.wrote !== !READ_ONLY_TOOLS.has(entry.tool)) return null;
    if (typeof entry.state !== 'string' || !STEP_STATES.has(entry.state as PlanCheckpointStepState)) return null;
    const state = entry.state as PlanCheckpointStepState;
    if (state === 'failed' && entry.wrote) return null;
    if (state === 'uncertain' && !entry.wrote) return null;
    steps.push({ index, tool: entry.tool, wrote: entry.wrote, state });
  }
  const firstIncomplete = steps.findIndex((step) => step.state !== 'completed');
  const expectedCursor = firstIncomplete < 0 ? steps.length : firstIncomplete;
  if (value.cursor !== expectedCursor) return null;
  // 执行器按序运行；完成记录必须是一个连续前缀，拒绝任何跳跃/伪造的游标形状。
  if (steps.some((step, index) => index < expectedCursor
      ? step.state !== 'completed'
      : index > expectedCursor && step.state !== 'pending')) return null;
  return {
    version: PLAN_CHECKPOINT_VERSION,
    planSignature: value.planSignature,
    projectFingerprint: value.projectFingerprint,
    stepCount: value.stepCount as number,
    cursor: value.cursor as number,
    steps,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

export function isPlanCheckpointFullyCompleted(value: unknown): boolean {
  const checkpoint = validateCheckpointPayload(value);
  return Boolean(checkpoint
    && checkpoint.cursor === checkpoint.stepCount
    && checkpoint.steps.every((step) => step.state === 'completed'));
}

export function inspectPlanCheckpoint(
  checkpoint: PlanCheckpoint,
  plan: AgentPlan,
  projectFingerprint: string | null
): CheckpointInspection {
  const validated = validateCheckpointPayload(checkpoint);
  if (!validated) return { ok: false, reason: 'invalid', message: '恢复记录结构或步骤游标无效' };
  let signature: string;
  try {
    signature = planCheckpointSignature(plan);
  } catch {
    return { ok: false, reason: 'invalid', message: '当前计划无法生成安全签名' };
  }
  if (validated.planSignature !== signature || validated.stepCount !== plan.steps.length) {
    return { ok: false, reason: 'signature', message: '计划签名或步骤数量已变化，不能沿用旧进度' };
  }
  if (validated.steps.some((step, index) =>
    step.tool !== plan.steps[index]?.tool || step.wrote === READ_ONLY_TOOLS.has(plan.steps[index]?.tool ?? '')
  )) {
    return { ok: false, reason: 'invalid', message: '恢复记录的工具顺序或副作用分类与当前计划不一致' };
  }
  if (!isProjectFingerprint(projectFingerprint)) {
    return { ok: false, reason: 'fingerprint', message: '当前工程指纹不可验证，已拒绝恢复' };
  }
  if (validated.projectFingerprint !== projectFingerprint) {
    return { ok: false, reason: 'fingerprint', message: '工程指纹已变化，已拒绝跨工程恢复' };
  }
  const uncertain = validated.steps.find((step) => step.wrote && (step.state === 'running' || step.state === 'uncertain'));
  if (uncertain) {
    return {
      ok: false,
      reason: 'uncertain-write',
      message: `第 ${uncertain.index + 1} 步 ${uncertain.tool} 的写入结果不确定；为避免重复副作用，必须重新规划`
    };
  }
  const steps = validated.steps.map((step) => ({
    ...step,
    // 只读步骤的运行中/失败状态可安全重试；绝不因进程退出而自动执行。
    state: step.state === 'running' || step.state === 'failed' ? 'pending' as const : step.state
  }));
  const cursor = steps.findIndex((step) => step.state !== 'completed');
  return {
    ok: true,
    cursor: cursor < 0 ? steps.length : cursor,
    steps,
    needsReconfirmation: steps.some((step) => step.index >= (cursor < 0 ? steps.length : cursor) && step.wrote)
  };
}

function checkpointFile(userDataRoot: string): string {
  return join(userDataRoot, PLAN_CHECKPOINT_FILE);
}

function envelopeFor(checkpoint: PlanCheckpoint): { payload: PlanCheckpoint; checksum: string } {
  const payload = validateCheckpointPayload(checkpoint);
  if (!payload) throw new Error('拒绝写入不合法的 checkpoint');
  return { payload, checksum: sha256(canonicalJson(payload)) };
}

/** userData 中的原子 0600 写入；文件只含版本、哈希、工具名与有限步骤状态。 */
export function savePlanCheckpoint(userDataRoot: string, checkpoint: PlanCheckpoint): void {
  const target = checkpointFile(userDataRoot);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  const serialized = `${JSON.stringify(envelopeFor(checkpoint), null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) throw new Error('checkpoint 超过大小上限');
  try {
    writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    chmodSync(target, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function loadPlanCheckpoint(userDataRoot: string): LoadedPlanCheckpoint {
  const target = checkpointFile(userDataRoot);
  if (!existsSync(target)) return { checkpoint: null };
  try {
    if (statSync(target).size > MAX_CHECKPOINT_BYTES) return { checkpoint: null, error: '恢复记录超过大小上限' };
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.payload) || typeof parsed.checksum !== 'string' || !HASH_PATTERN.test(parsed.checksum)) {
      return { checkpoint: null, error: '恢复记录外层结构无效' };
    }
    const payloadText = canonicalJson(parsed.payload);
    if (sha256(payloadText) !== parsed.checksum) return { checkpoint: null, error: '恢复记录校验失败' };
    const checkpoint = validateCheckpointPayload(parsed.payload);
    return checkpoint ? { checkpoint } : { checkpoint: null, error: '恢复记录版本、字段或游标无效' };
  } catch {
    return { checkpoint: null, error: '恢复记录损坏或无法读取' };
  }
}

export function clearPlanCheckpoint(userDataRoot: string): void {
  rmSync(checkpointFile(userDataRoot), { force: true });
}

/** 供测试与 smoke 用：校验文件确实有大小上限之外的最小元数据面。 */
export function planCheckpointSerializedSize(checkpoint: PlanCheckpoint): number {
  return Buffer.byteLength(JSON.stringify(envelopeFor(checkpoint)), 'utf8');
}
