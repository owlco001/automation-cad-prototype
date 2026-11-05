import type {
  Issue,
  PlcGenConfig,
  PlcSequenceStep
} from './types.ts';
import {
  createRenderContext,
  formatTime,
  renderGeneratedFile,
  type GenerateInput
} from './st.ts';
import { buildSymbolMap, outputBindings, resolveSymbol, tagRef } from './symbols.ts';
import { detectHandshake, type HandshakeModel } from './handshake.ts';
import { linkageFromConfig, type LinkageDerivation } from './linkage-program.ts';

export interface SequenceStepModel {
  stepNo: number;
  name: string;
  id?: string;
  sets: string[];
  resets: string[];
  waits: string[];
  condition: string;
  timeoutMs: number;
  referencedPoints: string[];
}

export interface SequencePlan {
  steps: SequenceStepModel[];
  warnings: Issue[];
  /** 步序来源：显式 config.sequence / 由联动推出来 / 空（无执行机构可驱动）。 */
  source: SequenceSource;
  /** 联动推导明细；仅 source='linkage' 时存在。 */
  derivation?: LinkageDerivation;
}

export type SequenceSource = 'explicit' | 'linkage' | 'none';

export interface SequenceGenerateResult {
  content: string;
  steps: number;
  warnings: Issue[];
}

interface ConditionTranslation {
  expression: string;
  references: string[];
  unresolved: string[];
}

const OPERATOR_TOKENS = new Set([
  'AND', 'OR', 'NOT', 'XOR', 'MOD', 'TRUE', 'FALSE'
]);
const POINT_TOKEN = /^%?(?:[IQ]\d+\.\d+|[XY]\d+(?:\.\d+)?|DI\d+(?:\.\d+)?|DQ\d+(?:\.\d+)?)$/i;
const IDENTIFIER_TOKEN = /%?(?:[IQ]\d+\.\d+|[XY]\d+(?:\.\d+)?|DI\d+(?:\.\d+)?|DQ\d+(?:\.\d+)?)|[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff]*/gi;

function issue(code: string, message: string, path?: string): Issue {
  return path ? { code, message, path } : { code, message };
}

function asText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function appendUnique(target: string[], values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    const point = value.trim();
    if (point && !target.includes(point)) target.push(point);
  }
}

function booleanValue(value: boolean | number | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no'].includes(text)) return false;
  return undefined;
}

function actionOf(step: PlcSequenceStep): string {
  return asText(step.action ?? step.type);
}

function isWaitAction(action: string): boolean {
  return ['wait', 'expect', '等待', '确认', '检查'].includes(action);
}

function isResetAction(action: string): boolean {
  return ['reset', 'clear', '复位'].includes(action);
}

function isSetAction(action: string): boolean {
  return ['set', 'write', 'assign', 'coil', '置位', '赋值', '输出'].includes(action);
}

function translateCondition(
  text: string,
  symbols: Map<string, string>,
  warnings: Issue[],
  path: string
): ConditionTranslation {
  const references: string[] = [];
  const unresolved: string[] = [];
  const normalized = text
    .trim()
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(/&/g, ' AND ')
    .replace(/\|/g, ' OR ')
    .replace(/\s+/g, ' ');

  const expression = normalized.replace(IDENTIFIER_TOKEN, (token) => {
    const upper = token.toUpperCase();
    if (OPERATOR_TOKENS.has(upper)) return upper;
    const variable = resolveSymbol(symbols, token);
    if (variable) {
      references.push(token);
      return tagRef(variable);
    }
    if (POINT_TOKEN.test(token)) {
      references.push(token);
      unresolved.push(token);
      warnings.push(issue(
        'SEQUENCE_POINT_UNRESOLVED',
        `步序条件引用的点位 ${token} 未出现在 IO 变量表中，已保留原符号`,
        path
      ));
    }
    return token;
  });

  return { expression, references, unresolved };
}

function waitExpression(
  point: string,
  expect: boolean | undefined,
  symbols: Map<string, string>,
  warnings: Issue[],
  path: string
): string {
  const variable = resolveSymbol(symbols, point);
  if (!variable) {
    warnings.push(issue(
      'SEQUENCE_POINT_UNRESOLVED',
      `步序等待的点位 ${point} 未出现在 IO 变量表中，已保留原符号`,
      path
    ));
    return expect === false ? `NOT ${point}` : point;
  }
  const reference = tagRef(variable);
  return expect === false ? `NOT ${reference}` : reference;
}

function combineAnd(parts: string[]): string {
  if (parts.length === 0) return 'TRUE';
  if (parts.length === 1) return parts[0] ?? 'TRUE';
  return parts.map((part) => (/\sOR\s/.test(part) ? `(${part})` : part)).join(' AND ');
}

function normalizeTimeout(
  step: PlcSequenceStep,
  stepNo: number,
  defaultTimeoutMs: number,
  warnings: Issue[]
): number {
  const raw = step.timeoutMs ?? step.timeout;
  if (raw === undefined) return defaultTimeoutMs;
  if (Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) return raw;
  warnings.push(issue(
    'SEQUENCE_TIMEOUT_INVALID',
    `步序第 ${stepNo} 步超时 ${String(raw)} 无效，已回落默认 ${defaultTimeoutMs} ms`
  ));
  return defaultTimeoutMs;
}

/**
 * 把联调步序归一化为状态机模型；不做 IO 存在性判断（预检负责拦截）。
 *
 * 步序来源三级（顺序不可颠倒）：
 *   1. `config.sequence` / `config.steps` 显式写了 → 原样采用（老机型逐字节不变）；
 *   2. 没写但有执行机构 → `linkageFromConfig` → `buildSequenceFromLinkage` 生成步序
 *      （这就是「联动进生成路径」：以前 buildSequenceFromLinkage 只在测试里被调用，
 *      生成出来的是空壳）；
 *   3. 都没有 → 空骨架，并且**必须**带告警说明为什么空（有执行机构却没驱动点位时
 *      单独报 SEQUENCE_NOT_DERIVABLE，不允许静默生成空壳）。
 */
export function buildSequencePlan(input: GenerateInput): SequencePlan {
  const ctx = createRenderContext(input);
  const config: PlcGenConfig = ctx.config;
  const configured: readonly PlcSequenceStep[] = config.sequence ?? config.steps ?? [];
  const warnings: Issue[] = [];
  let source: SequenceSource = 'explicit';
  let derivation: LinkageDerivation | undefined;
  let rawSteps: readonly PlcSequenceStep[] = configured;

  if (configured.length === 0) {
    derivation = linkageFromConfig(config);
    if (derivation.steps.length > 0) {
      source = 'linkage';
      rawSteps = derivation.steps;
    } else {
      source = 'none';
    }
  }

  if (rawSteps.length === 0) {
    const actuators = (config.actuators ?? []).length;
    warnings.push(issue('SEQUENCE_EMPTY', '联调步序为空，FC_AutoSequence 仅生成空状态机骨架'));
    if (actuators > 0) {
      const skipped = (derivation?.skipped ?? []).map((item) => `${item.name}(${item.actuatorId})：${item.reason}`).join('；');
      warnings.push(issue(
        'SEQUENCE_NOT_DERIVABLE',
        `${actuators} 个执行机构一个步序都没能生成：${skipped || '没有可用的驱动点位'}。`
          + '空骨架不会驱动任何动作；补齐单点驱动（actuator.point）或显式 sequence 后重新生成'
      ));
    }
    return { steps: [], warnings, source };
  }

  if (derivation) {
    if (derivation.skipped.length > 0) {
      warnings.push(issue(
        'SEQUENCE_ACTUATOR_SKIPPED',
        `以下执行机构没有单点驱动点位，未生成步序：${derivation.skipped.map((item) => `${item.name}(${item.actuatorId})`).join('、')}`
      ));
    }
    if (derivation.withoutSensor.length > 0) {
      warnings.push(issue(
        'SEQUENCE_STEP_NO_WAIT',
        `以下执行机构的步序没有到位判据（超时兜底）：${derivation.withoutSensor.join('、')}`
      ));
    }
  }

  const symbols = buildSymbolMap(config);
  const steps = rawSteps.map((step, index): SequenceStepModel => {
    const stepNo = index + 1;
    const path = `sequence[${index}]`;
    const action = actionOf(step);
    const waitAction = isWaitAction(action);
    const resetAction = isResetAction(action);
    const setAction = isSetAction(action);
    const sets: string[] = [];
    const resets: string[] = [];
    const waits: string[] = [];
    const referencedPoints: string[] = [];

    appendUnique(sets, step.setPoints);
    appendUnique(sets, step.sets);
    appendUnique(resets, step.resetPoints);
    appendUnique(resets, step.resets);
    appendUnique(waits, step.waitPoints);
    appendUnique(waits, step.waits);

    if (waitAction) {
      if (step.point) appendUnique(waits, [step.point]);
      appendUnique(waits, step.points);
    } else if (resetAction) {
      if (step.point) appendUnique(resets, [step.point]);
      appendUnique(resets, step.points);
    } else if (setAction || step.point || step.points) {
      const value = booleanValue(step.value);
      const target = value === false ? resets : sets;
      if (step.point) appendUnique(target, [step.point]);
      appendUnique(target, step.points);
    }

    for (const point of [...sets, ...resets, ...waits]) {
      if (!referencedPoints.includes(point)) referencedPoints.push(point);
    }

    const conditionParts: string[] = [];
    const expected = booleanValue(step.expect);
    if (waits.length > 0) {
      conditionParts.push(combineAnd(waits.map((point) => (
        waitExpression(point, expected, symbols, warnings, `${path}.waitPoints`)
      ))));
    }
    if (step.condition?.trim()) {
      const translated = translateCondition(step.condition, symbols, warnings, `${path}.condition`);
      conditionParts.push(/\sOR\s/.test(translated.expression) ? `(${translated.expression})` : translated.expression);
      for (const ref of translated.references) {
        if (!referencedPoints.includes(ref)) referencedPoints.push(ref);
      }
    }

    const condition = combineAnd(conditionParts);
    if (condition === 'TRUE') {
      warnings.push(issue(
        'SEQUENCE_NO_CONDITION',
        `步序第 ${stepNo} 步没有转移条件，将立即跳到下一步`,
        path
      ));
    }

    for (const point of sets) {
      if (resets.includes(point)) {
        warnings.push(issue(
          'SEQUENCE_POINT_CONFLICT',
          `步序第 ${stepNo} 步同时对点位 ${point} 置位与复位，复位优先生效`,
          path
        ));
      }
    }

    const model: SequenceStepModel = {
      stepNo,
      name: (step.name ?? step.id ?? `步骤 ${stepNo}`).trim() || `步骤 ${stepNo}`,
      sets,
      resets,
      waits,
      condition,
      timeoutMs: normalizeTimeout(step, stepNo, ctx.sequenceTimeoutMs, warnings),
      referencedPoints
    };
    if (step.id?.trim()) model.id = step.id.trim();
    return model;
  });

  return { steps, warnings, source, ...(derivation ? { derivation } : {}) };
}

function buildOutputRefs(config: PlcGenConfig): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const binding of outputBindings(config)) {
    if (seen.has(binding.row.name)) continue;
    seen.add(binding.row.name);
    refs.push(tagRef(binding.row.name));
  }
  return refs;
}

export interface HandshakeRender {
  readyRefs: string[];
  doneRefs: string[];
  /** 下游允许的表达式（多个通道按「与」串，保守）；没有 ALLOW 信号时为 null。 */
  allowExpr: string | null;
  /** 到位判据表达式；没有 END 信号时为 null。 */
  endExpr: string | null;
}

/** 握手渲染输入：只在这里把变量名翻成 `"DB_IO".<名字>`，渲染与对账共用同一口径。 */
export function handshakeRenderOf(model: HandshakeModel): HandshakeRender | null {
  if (!model.present) return null;
  const ref = (signal: { variable: string }): string => tagRef(signal.variable);
  return {
    readyRefs: model.ready.map(ref),
    doneRefs: model.done.map(ref),
    allowExpr: model.allow.length > 0 ? model.allow.map(ref).join(' AND ') : null,
    endExpr: model.end.length > 0 ? model.end.map(ref).join(' AND ') : null
  };
}

function renderStateMachine(
  plan: SequencePlan,
  config: PlcGenConfig,
  sequenceTimeout: string,
  hs: HandshakeRender | null = null
): string[] {
  const symbols = buildSymbolMap(config);
  const lines: string[] = [];
  const outputs = buildOutputRefs(config);
  const resetOutputs = outputs.map((reference) => `        ${reference} := FALSE;`);

  lines.push('_AbortEdge(CLK := Abort);');
  if (hs) lines.push('_StartEdge(CLK := Start);');
  const doneLatch = hs !== null && hs.doneRefs.length > 0;
  lines.push('');
  lines.push('// 中止或安全停止均回到 Step0，空步只保留待机状态。');
  lines.push('IF _AbortEdge.Q OR SafeStop THEN');
  lines.push('    StepNo := STEP_IDLE;');
  lines.push('    SeqTimeout := FALSE;');
  lines.push('    StepErrorCode := 16#0000;');
  if (doneLatch) lines.push('    _HandshakeDone := FALSE;   // 安全停止/中止：握手完成位一并清掉');
  lines.push('    _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
  lines.push('END_IF;', '');
  lines.push('CASE StepNo OF');
  lines.push('    STEP_IDLE:');
  lines.push('        // 待机：所有输出复位，等待启动。');
  lines.push(...resetOutputs);
  lines.push('        SeqTimeout := FALSE;');
  lines.push('        StepErrorCode := 16#0000;');
  lines.push('        _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
  if (hs) {
    // 启动互锁：只在下游允许时接受启动沿；ALLOW 掉线就不启动（停在待机位等许可）。
    if (hs.allowExpr) {
      lines.push('        _StartInhibit := NOT ' + hs.allowExpr + ';');
    }
    lines.push(`        IF _StartEdge.Q AND NOT SafeStop AND NOT Abort${hs.allowExpr ? ` AND ${hs.allowExpr}` : ''} THEN`);
    if (doneLatch) lines.push('            _HandshakeDone := FALSE;');
    lines.push(`            StepNo := ${plan.steps.length > 0 ? 1 : 'STEP_IDLE'};`);
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        END_IF;');
  } else {
    lines.push('        IF Start AND NOT SafeStop AND NOT Abort THEN');
    lines.push(`            StepNo := ${plan.steps.length > 0 ? 1 : 'STEP_IDLE'};`);
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        END_IF;');
  }

  if (plan.steps.length === 0) {
    lines.push('        (* 联调步序为空：未生成转移动画分支。 *)');
  }

  const lastStepNo = plan.steps.length;
  for (const step of plan.steps) {
    const last = step.stepNo === lastStepNo;
    const next = last ? (doneLatch ? 'STEP_HANDSHAKE' : 0) : step.stepNo + 1;
    const timeout = formatTime(step.timeoutMs);
    // 最后一步同时受「到位信号」约束：移载到位（END）之前不许进握手状态。
    let condition = step.condition;
    if (hs?.endExpr && last && !condition.includes(hs.endExpr)) {
      condition = condition === 'TRUE' ? hs.endExpr : `${condition} AND ${hs.endExpr}`;
    }
    lines.push('');
    lines.push(`    ${step.stepNo}:`);
    lines.push(`        // ${step.name}`);
    for (const point of step.sets) {
      const variable = resolveSymbol(symbols, point);
      if (variable) lines.push(`        ${tagRef(variable)} := TRUE;`);
    }
    for (const point of step.resets) {
      const variable = resolveSymbol(symbols, point);
      if (variable) lines.push(`        ${tagRef(variable)} := FALSE;`);
    }
    lines.push(`        _StepTimer(IN := TRUE, PT := ${timeout});`);
    lines.push(`        IF ${condition} THEN`);
    lines.push(`            StepNo := ${next};`);
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        ELSIF _StepTimer.Q THEN');
    lines.push('            StepNo := STEP_ERROR;');
    lines.push('            SeqTimeout := TRUE;');
    lines.push('            StepErrorCode := 16#8101;');
    lines.push('            AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;');
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        END_IF;');
  }

  lines.push('');
  if (doneLatch) {
    lines.push('    STEP_HANDSHAKE:');
    lines.push('        // 移载完成握手：只有到位信号为 1 才置完成位，不用定时器猜「大概到了」。');
    lines.push('        StepNo := STEP_IDLE;');
    if (hs && hs.endExpr) {
      lines.push(`        IF ${hs.endExpr} THEN`);
      lines.push('            _HandshakeDone := TRUE;');
      lines.push('        END_IF;');
    } else {
      lines.push('        // 没配到位信号：序列走完即视为完成（如实写在这里，不假装有判据）。');
      lines.push('        _HandshakeDone := TRUE;');
    }
    lines.push('');
  }
  lines.push('    STEP_ERROR:');
  lines.push('        // StepError：超时锁存，报警字已写入，等待 Abort 复位。');
  lines.push('        SeqTimeout := TRUE;');
  lines.push(...resetOutputs);
  lines.push('    ELSE');
  lines.push('        StepNo := STEP_ERROR;');
  lines.push('        SeqTimeout := TRUE;');
  lines.push('END_CASE;');
  if (hs) {
    lines.push('');
    lines.push('// 联锁握手输出放在 CASE 之后：否则 IDLE/ERROR 分支的「输出全复位」会每扫描把完成位写回 FALSE。');
    for (const reference of hs.readyRefs) {
      lines.push(`// 就绪 = 无安全停止、无序列报警、停在待机步（与下游 ALLOW 无关：ready 是「我能接」，allow 是「你可以给」）。`);
      lines.push(`${reference} := NOT SafeStop AND NOT SeqTimeout AND (AlarmWord = 16#0000) AND (StepNo = STEP_IDLE);`);
    }
    for (const reference of hs.doneRefs) {
      lines.push(`${reference} := _HandshakeDone;`);
    }
  }
  return lines;
}

export function generateSequence(input: GenerateInput): SequenceGenerateResult {
  const ctx = createRenderContext(input);
  const plan = buildSequencePlan(input);
  const handshake = detectHandshake(ctx.config);
  const hs = handshakeRenderOf(handshake);
  const warnings = [...plan.warnings, ...handshake.warnings];
  const hsVars: string[] = [];
  if (hs) {
    hsVars.push('    _StartEdge : R_TRIG;');
    if (hs.doneRefs.length > 0) hsVars.push('    _HandshakeDone : BOOL;');
    if (hs.allowExpr) hsVars.push('    _StartInhibit : BOOL;');
  }
  const body: string[] = [
    'FUNCTION FC_AutoSequence : VOID',
    'VAR_INPUT',
    '    Start : BOOL;',
    '    Abort : BOOL;',
    '    SafeStop : BOOL;',
    'END_VAR',
    'VAR_OUTPUT',
    '    StepNo : INT;',
    '    SeqTimeout : BOOL;',
    '    StepErrorCode : WORD;',
    'END_VAR',
    'VAR_IN_OUT',
    '    AlarmWord : WORD;',
    'END_VAR',
    'VAR',
    '    _StepTimer : TON;',
    '    _AbortEdge : R_TRIG;',
    ...hsVars,
    'END_VAR',
    'VAR CONSTANT',
    '    STEP_IDLE : INT := 0;',
    '    STEP_ERROR : INT := 99;',
    ...(hs && hs.doneRefs.length > 0 ? ['    STEP_HANDSHAKE : INT := 90;'] : []),
    '    ALARM_SEQ_TIMEOUT : WORD := 16#8101;',
    'END_VAR',
    ''
  ];
  body.push(...renderStateMachine(plan, ctx.config, ctx.sequenceTimeout, hs));
  body.push('');
  const content = renderGeneratedFile(ctx, 'src/FC_AutoSequence.st', body.join('\n'));
  return { content, steps: plan.steps.length, warnings };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `generateSequence`。 */
export const generateAutoSequence = generateSequence;
