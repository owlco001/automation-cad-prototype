/**
 * 生成即验证（P8-4）：预检 → generateProject → 内置模拟器。
 *
 * 纯函数，不落盘、不连接 PLC。有预检 error 时直接返回，不生成半套文件；
 * 生成成功后把 mapping.json 交给 simulate，返回逐步结果与失败摘要。
 */
import type { MachineConfig } from '../commission/machine-config.ts';
import type { Issue, PlcBomInput, PlcGenConfig, PlcTarget, PrecheckResult } from './types.ts';
import {
  generateProject,
  type GenerateProjectInput,
  type GenerateProjectResult,
  type GenerateProjectSuccess
} from './generate.ts';
import { simulate, type GeneratedProjectLike, type SimResult, type SimulateOptions } from './simulate.ts';

export type VerifyStage = 'precheck' | 'generate' | 'simulate' | 'done';

export interface VerifyOptions extends SimulateOptions {
  bom?: PlcBomInput;
  target?: PlcTarget;
  namePrefix?: string;
  version?: string | number;
  timeoutTimeMs?: number;
  toleranceDeg?: number;
  sequenceTimeoutMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  stage: VerifyStage;
  precheck: PrecheckResult;
  errors: Issue[];
  warnings: Issue[];
  stats?: GenerateProjectSuccess['stats'];
  simulation?: SimResult;
  project?: GeneratedProjectLike;
}

export interface VerifySummary {
  ok: boolean;
  stage: VerifyStage;
  steps: number;
  passed: number;
  alarms: string[];
  elapsedMs: number;
  precheckErrors: number;
  precheckWarnings: number;
  failure?: {
    stepNo: number;
    name: string;
    reason: string;
  };
  finalOutputs?: Record<string, boolean>;
}

type VerifySource = PlcGenConfig | GenerateProjectInput | GeneratedProjectLike;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeConfig(value: unknown): value is PlcGenConfig {
  return isRecord(value) && Array.isArray(value.actuators) && Array.isArray(value.stations);
}

function looksLikeProject(value: unknown): value is GeneratedProjectLike {
  return isRecord(value) && Array.isArray(value.files);
}

function inputOf(config: PlcGenConfig, options: VerifyOptions): GenerateProjectInput {
  const input: GenerateProjectInput = { config };
  if (options.bom !== undefined) input.bom = options.bom;
  if (options.target !== undefined) input.target = options.target;
  if (options.namePrefix !== undefined) input.namePrefix = options.namePrefix;
  if (options.version !== undefined) input.version = options.version;
  if (options.timeoutTimeMs !== undefined) input.timeoutTimeMs = options.timeoutTimeMs;
  if (options.toleranceDeg !== undefined) input.toleranceDeg = options.toleranceDeg;
  if (options.sequenceTimeoutMs !== undefined) input.sequenceTimeoutMs = options.sequenceTimeoutMs;
  return input;
}

function simulationIssues(result: SimResult): Issue[] {
  if (result.ok) return [];
  const issues: Issue[] = [];
  for (const alarm of result.alarms) {
    if (alarm.startsWith('EMPTY_SEQUENCE:')) {
      issues.push({
        code: 'SEQUENCE_EMPTY',
        message: '联调步序为空，无法验证；请至少配置一个有效步序。',
        path: 'sequence'
      });
      continue;
    }
    if (alarm.includes('mapping.json.sequence')) {
      issues.push({
        code: 'SEQUENCE_MISSING',
        message: '生成结果缺少有效的 PLC 步序，无法验证；请重新生成 PLC 项目。',
        path: 'mapping.json.sequence'
      });
      continue;
    }
    issues.push({ code: 'SIMULATION_ALARM', message: alarm });
  }
  const failed = result.steps.find((step) => !step.ok);
  if (failed) {
    issues.push({
      code: 'SIMULATION_FAILED',
      message: failed.reason ?? `第 ${failed.stepNo} 步「${failed.name}」失败`,
      path: `sequence[${failed.stepNo - 1}]`
    });
  }
  if (issues.length === 0) {
    issues.push({ code: 'SIMULATION_FAILED', message: '模拟验证未通过' });
  }
  return issues;
}

function emptySequencePrecheckFailure(
  precheck: PrecheckResult,
  sequenceEmpty: boolean
): VerifyResult | null {
  if (!sequenceEmpty) return null;
  const issue: Issue = {
    code: 'SEQUENCE_EMPTY',
    message: '联调步序为空，无法验证；请至少配置一个有效步序。',
    path: 'sequence'
  };
  const warnings = precheck.warnings.filter((warning) => warning.code !== 'SEQUENCE_EMPTY');
  const errors = [...precheck.errors, issue];
  const failedPrecheck: PrecheckResult = { errors, warnings };
  return { ok: false, stage: 'precheck', precheck: failedPrecheck, errors, warnings };
}

function precheckOf(result: GenerateProjectResult): PrecheckResult {
  return result.precheck;
}

/**
 * 验证生成程序。推荐调用：`verifyGenerated(config, { bom, timeScale })`。
 * 也接受 `verifyGenerated(project, config)`，此时跳过重新生成、直接模拟已有工程，
 * 但仍先跑预检；预检 error 直接失败。
 */
export function verifyGenerated(
  source: VerifySource,
  configOrOptions?: PlcGenConfig | VerifyOptions
): VerifyResult {
  let config: PlcGenConfig | null = null;
  let providedProject: GeneratedProjectLike | null = null;
  let options: VerifyOptions = {};

  if (looksLikeProject(source)) {
    providedProject = source;
    if (looksLikeConfig(configOrOptions)) config = configOrOptions;
    else if (isRecord(configOrOptions)) options = configOrOptions as VerifyOptions;
  } else if (isRecord(source) && looksLikeConfig(source.config)) {
    config = source.config as PlcGenConfig;
    const candidate = source as GenerateProjectInput;
    if (candidate.bom !== undefined) options.bom = candidate.bom;
    if (candidate.target !== undefined) options.target = candidate.target;
    if (candidate.namePrefix !== undefined) options.namePrefix = candidate.namePrefix;
    if (candidate.version !== undefined) options.version = candidate.version;
    if (candidate.timeoutTimeMs !== undefined) options.timeoutTimeMs = candidate.timeoutTimeMs;
    if (candidate.toleranceDeg !== undefined) options.toleranceDeg = candidate.toleranceDeg;
    if (candidate.sequenceTimeoutMs !== undefined) options.sequenceTimeoutMs = candidate.sequenceTimeoutMs;
    const shared = candidate as unknown as Record<string, unknown>;
    if (typeof shared.timeScale === 'number') options.timeScale = shared.timeScale;
    if (typeof shared.safetyTripAtStep === 'number') options.safetyTripAtStep = shared.safetyTripAtStep;
    if (typeof shared.safetyTripPoint === 'string') options.safetyTripPoint = shared.safetyTripPoint;
    if (typeof shared.sensorConflictAtStep === 'number') options.sensorConflictAtStep = shared.sensorConflictAtStep;
    if (typeof shared.sensorConflictActuator === 'string') options.sensorConflictActuator = shared.sensorConflictActuator;
    if (isRecord(configOrOptions) && !looksLikeConfig(configOrOptions)) {
      options = { ...options, ...(configOrOptions as VerifyOptions) };
    }
  } else if (looksLikeConfig(source)) {
    config = source;
    if (isRecord(configOrOptions) && !looksLikeConfig(configOrOptions)) {
      options = configOrOptions as VerifyOptions;
    } else if (looksLikeConfig(configOrOptions)) {
      // `verifyGenerated(config, config)` 没有意义，按选项缺省处理。
      config = source;
    }
  }

  if (!config) {
    const precheck: PrecheckResult = {
      errors: [{ code: 'CONFIG_MISSING', message: '验证需要 PlcGenConfig（含 stations/actuators/sensors）' }],
      warnings: []
    };
    return {
      ok: false,
      stage: 'precheck',
      precheck,
      errors: precheck.errors,
      warnings: []
    };
  }

  if (providedProject) {
    const generatedCheck = generateProject(inputOf(config, options));
    const check = generatedCheck.precheck;
    if (check.errors.length > 0) {
      return {
        ok: false,
        stage: 'precheck',
        precheck: check,
        errors: check.errors,
        warnings: check.warnings
      };
    }
    const emptySequenceFailure = emptySequencePrecheckFailure(
      check,
      generatedCheck.ok && generatedCheck.stats.sequenceEmpty
    );
    if (emptySequenceFailure) return emptySequenceFailure;
    const simulation = simulate({ project: providedProject, config, ...options });
    const errors = simulationIssues(simulation);
    return {
      ok: simulation.ok,
      stage: simulation.ok ? 'done' : 'simulate',
      precheck: check,
      errors,
      warnings: check.warnings,
      simulation,
      project: providedProject
    };
  }

  const generated = generateProject(inputOf(config, options));
  if (!generated.ok) {
    return {
      ok: false,
      stage: 'precheck',
      precheck: precheckOf(generated),
      errors: generated.errors,
      warnings: generated.precheck.warnings
    };
  }

  const emptySequenceFailure = emptySequencePrecheckFailure(
    generated.precheck,
    generated.stats.sequenceEmpty
  );
  if (emptySequenceFailure) return emptySequenceFailure;

  const simulation = simulate({ project: generated, config, ...options });
  const errors = simulationIssues(simulation);
  const result: VerifyResult = {
    ok: simulation.ok,
    stage: simulation.ok ? 'done' : 'simulate',
    precheck: generated.precheck,
    errors,
    warnings: generated.warnings,
    stats: generated.stats,
    simulation,
    project: generated
  };
  return result;
}

/** Agent / UI 用的窄摘要：不回传 11 个文件正文。 */
export function summarizeVerification(result: VerifyResult): VerifySummary {
  const simulation = result.simulation;
  const steps = simulation?.steps.length ?? result.stats?.steps ?? 0;
  const passed = simulation?.steps.filter((step) => step.ok).length ?? 0;
  const failed = simulation?.steps.find((step) => !step.ok);
  const summary: VerifySummary = {
    ok: result.ok,
    stage: result.stage,
    steps,
    passed,
    alarms: simulation?.alarms ?? [],
    elapsedMs: simulation?.elapsedMs ?? 0,
    precheckErrors: result.precheck.errors.length,
    precheckWarnings: result.precheck.warnings.length
  };
  if (failed) {
    summary.failure = {
      stepNo: failed.stepNo,
      name: failed.name,
      reason: failed.reason ?? '未说明原因'
    };
  }
  if (simulation) summary.finalOutputs = simulation.finalOutputs;
  return summary;
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `verifyGenerated`。 */
export const runPlcVerification = verifyGenerated;
