/**
 * 生成程序模拟执行器（P8-4）。
 *
 * 输入生成结果里的 `mapping.json` 与机型配置，在内存中按步执行：
 * - 输出动作通过 mapping 的点位/变量映射落到模拟点位；
 * - 气缸/夹爪/旋转轴按 `durationMs` 模拟到位传感器，`timeScale` 用于加速；
 * - 超时使用生成程序写入 mapping 的 `timeoutMs`（即 FC_AutoSequence 的 TimeoutTime）；
 * - 急停/安全门触发立即 SafeStop，后续步跳过，只记一条安全报警。
 *
 * 纯函数：不读写文件、不连接 PLC、不使用真实时钟，结果可逐字节复现。
 */
import type { ActuatorConfig, MachineConfig, SensorConfig } from '../commission/machine-config.ts';
import type { GeneratedFile } from './types.ts';
import type { PlcGenConfig } from './types.ts';
import { extractSafetyRefs, normalizePointKey } from './io.ts';

export interface SimStep {
  stepNo: number;
  name: string;
  actions: string[];
  waitedMs: number;
  ok: boolean;
  reason?: string;
}

export interface SimResult {
  ok: boolean;
  steps: SimStep[];
  alarms: string[];
  elapsedMs: number;
  finalOutputs: Record<string, boolean>;
}

/** 只依赖 `files`，兼容 generateProject 成功结果与导出的工程对象。 */
export interface GeneratedProjectLike {
  files: readonly GeneratedFile[];
}

/** 兼容类型别名：保留对外导出；新代码请使用 `GeneratedProjectLike`。 */
export type GeneratedProject = GeneratedProjectLike;

export interface SimulateOptions {
  /** 模拟加速倍率，默认 1；2 表示行程/等待时间减半。 */
  timeScale?: number;
  /** 在第 N 步开始前注入安全触发（1 起）；用于验证 SafeStop 中止路径。 */
  safetyTripAtStep?: number;
  /** 安全触发点位；缺省使用配置中的急停点位。 */
  safetyTripPoint?: string;
  /** 在第 N 步开始前注入传感器矛盾；用于验证报警路径。 */
  sensorConflictAtStep?: number;
  /** 矛盾执行机构 id；缺省取第一个有双传感器的执行机构。 */
  sensorConflictActuator?: string;
}

export interface SimulateInput extends SimulateOptions {
  project: GeneratedProjectLike;
  config: MachineConfig | PlcGenConfig;
}

interface MappingPoint {
  ref?: string;
  point: string;
  address?: string;
  variable?: string;
  area?: 'input' | 'output';
  station?: string;
}

interface MappingStep {
  stepNo?: number;
  name?: string;
  sets?: readonly string[];
  resets?: readonly string[];
  waits?: readonly string[];
  condition?: string;
  timeoutMs?: number;
}

interface MappingDocument {
  points: MappingPoint[];
  sequence: MappingStep[];
}

interface SensorModel {
  key: string;
  point: string;
}

interface ActuatorModel {
  actuator: ActuatorConfig;
  extendKey?: string;
  retractKey?: string;
  gripKey?: string;
  rotaryKey?: string;
  sensors: SensorModel[];
}

interface MotionEvent {
  at: number;
  order: number;
  actuator: ActuatorModel;
  target: 'extend' | 'retract' | 'both' | 'active' | 'inactive';
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_DURATION_MS = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readFile(project: GeneratedProjectLike, path: string): string | null {
  const file = project.files.find((candidate) => candidate.path === path);
  return file ? file.content : null;
}

function parseMapping(project: GeneratedProjectLike): MappingDocument {
  const content = readFile(project, 'mapping.json');
  if (content === null) throw new Error('生成结果文件不存在：mapping.json');
  const raw = JSON.parse(content) as unknown;
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.points)) {
    throw new Error('缺少必填参数：mapping.json.points');
  }
  if (!Array.isArray(record.sequence)) {
    throw new Error('缺少必填参数：mapping.json.sequence');
  }
  const points = record.points.map((value, index): MappingPoint => {
    const point = asRecord(value);
    if (!point || typeof point.point !== 'string' || !point.point.trim()) {
      throw new Error(`mapping.json points[${index}].point 无效`);
    }
    const area = point.area === 'input' || point.area === 'output' ? point.area : undefined;
    return {
      point: point.point.trim(),
      ...(typeof point.ref === 'string' ? { ref: point.ref } : {}),
      ...(typeof point.address === 'string' ? { address: point.address } : {}),
      ...(typeof point.variable === 'string' ? { variable: point.variable } : {}),
      ...(area ? { area } : {}),
      ...(typeof point.station === 'string' ? { station: point.station } : {})
    };
  });
  const sequence = record.sequence.map((value, index): MappingStep => {
    const step = asRecord(value);
    if (!step) throw new Error(`mapping.json sequence[${index}] 无效`);
    const readPoints = (key: string): string[] => {
      const list = step[key];
      if (list === undefined) return [];
      if (!Array.isArray(list)) throw new Error(`mapping.json sequence[${index}].${key} 必须是数组`);
      return list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    };
    return {
      stepNo: typeof step.stepNo === 'number' ? step.stepNo : index + 1,
      ...(typeof step.name === 'string' ? { name: step.name } : {}),
      sets: readPoints('sets'),
      resets: readPoints('resets'),
      waits: readPoints('waits'),
      ...(typeof step.condition === 'string' ? { condition: step.condition } : {}),
      ...(typeof step.timeoutMs === 'number' ? { timeoutMs: step.timeoutMs } : {})
    };
  });
  return { points, sequence };
}

function matchesActuator(sensor: SensorConfig, actuator: ActuatorConfig): boolean {
  const part = sensor.part.trim().toLowerCase();
  return part === actuator.id.trim().toLowerCase() || part === actuator.name.trim().toLowerCase();
}

function buildActuators(
  config: MachineConfig | PlcGenConfig,
  pointIndex: Map<string, MappingPoint>
): ActuatorModel[] {
  const safety = extractSafetyRefs(config as PlcGenConfig);
  const safetyKeys = new Set([...safety.estop, ...safety.safetyDoor].map((point) => normalizePointKey(point)));
  return (config.actuators ?? []).map((actuator) => {
    const sensors = (config.sensors ?? [])
      .filter((sensor) => matchesActuator(sensor, actuator))
      .filter((sensor) => !safetyKeys.has(normalizePointKey(sensor.point)))
      .map((sensor): SensorModel => ({
        key: normalizePointKey(sensor.point),
        point: pointIndex.get(normalizePointKey(sensor.point))?.point ?? sensor.point
      }));
    const keyOf = (point: string | undefined): string | undefined => {
      if (!point) return undefined;
      const key = normalizePointKey(point);
      return pointIndex.has(key) ? key : undefined;
    };
    const extendKey = keyOf(actuator.extendPoint);
    const retractKey = keyOf(actuator.retractPoint);
    const gripKey = keyOf(actuator.gripPoint);
    const rotaryKey = keyOf(actuator.point);
    return {
      actuator,
      ...(extendKey ? { extendKey } : {}),
      ...(retractKey ? { retractKey } : {}),
      ...(gripKey ? { gripKey } : {}),
      ...(rotaryKey ? { rotaryKey } : {}),
      sensors
    };
  });
}

interface ConditionContext {
  states: Map<string, boolean>;
  pointIndex: Map<string, MappingPoint>;
  variableIndex: Map<string, string>;
}

function lookupConditionKey(token: string, context: ConditionContext): string | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  const variable = context.variableIndex.get(trimmed);
  if (variable) return variable;
  for (const point of context.pointIndex.values()) {
    if (point.point === trimmed || point.address === trimmed || point.variable === trimmed) {
      return normalizePointKey(point.point);
    }
  }
  const key = normalizePointKey(trimmed);
  return context.pointIndex.has(key) ? key : undefined;
}

function tokenizeCondition(expression: string): string[] {
  const normalized = expression
    .replace(/"DB_IO"\./giu, '')
    .replace(/DB_IO\./giu, '')
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(/!/g, ' NOT ');
  const tokens = normalized.match(/\(|\)|AND|OR|NOT|TRUE|FALSE|[^\s()]+/giu) ?? [];
  return tokens;
}

/** 只解析 AND/OR/NOT/括号与点位/变量引用；未知符号按 FALSE 处理。 */
function evaluateCondition(expression: string | undefined, context: ConditionContext): boolean {
  if (!expression || !expression.trim()) return true;
  const tokens = tokenizeCondition(expression);
  if (tokens.length === 0) return true;
  let cursor = 0;

  const peek = (): string | undefined => tokens[cursor];
  const take = (): string => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error('条件表达式不完整');
    cursor += 1;
    return token;
  };

  const parsePrimary = (): boolean => {
    const token = take();
    if (token === '(') {
      const value = parseOr();
      if (take() !== ')') throw new Error('条件表达式缺少右括号');
      return value;
    }
    const upper = token.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    const key = lookupConditionKey(token, context);
    return key ? context.states.get(key) === true : false;
  };

  const parseUnary = (): boolean => {
    if (peek()?.toUpperCase() === 'NOT') {
      take();
      return !parseUnary();
    }
    return parsePrimary();
  };

  const parseAnd = (): boolean => {
    let value = parseUnary();
    while (peek()?.toUpperCase() === 'AND' || peek() === '&&') {
      take();
      const right = parseUnary();
      value = value && right;
    }
    return value;
  };

  function parseOr(): boolean {
    let value = parseAnd();
    while (peek()?.toUpperCase() === 'OR' || peek() === '||') {
      take();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  try {
    const value = parseOr();
    if (cursor !== tokens.length) return false;
    return value;
  } catch (error) {
    // 表达式语法不合法按 false 处理；配置预检会单独报告表达式错误。
    console.debug('[PLC_EXPRESSION_PARSE_FALLBACK]', { site: 'desktop/src/plcgen/simulate.ts' }, error);
    return false;
  }
}

function durationOf(actuator: ActuatorConfig): number {
  return typeof actuator.durationMs === 'number' && Number.isFinite(actuator.durationMs) && actuator.durationMs > 0
    ? actuator.durationMs
    : DEFAULT_DURATION_MS;
}

function timeoutOf(step: MappingStep): number {
  return typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs) && step.timeoutMs > 0
    ? step.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function outputKeyOf(
  token: string,
  pointIndex: Map<string, MappingPoint>,
  variableIndex: Map<string, string>
): string | undefined {
  const variable = variableIndex.get(token.trim());
  if (variable) return variable;
  for (const point of pointIndex.values()) {
    if (point.point === token || point.address === token || point.variable === token) {
      return normalizePointKey(point.point);
    }
  }
  const key = normalizePointKey(token);
  return pointIndex.has(key) ? key : undefined;
}

function failureResult(message: string): SimResult {
  return {
    ok: false,
    steps: [],
    alarms: [`MAPPING_ERROR:${message}`],
    elapsedMs: 0,
    finalOutputs: {}
  };
}

function normalizeOptions(options: SimulateOptions): Required<Pick<SimulateOptions, 'timeScale'>> & SimulateOptions {
  const timeScale = typeof options.timeScale === 'number' && Number.isFinite(options.timeScale) && options.timeScale > 0
    ? options.timeScale
    : 1;
  return { ...options, timeScale };
}

/**
 * 执行一次生成程序的模拟验证。超时/安全触发会让后续步继续以“已跳过”条目出现，
 * 便于 UI 与报告一眼看出执行到哪里；`ok=false`。
 */
export function simulate(input: SimulateInput): SimResult;
export function simulate(
  project: GeneratedProjectLike,
  config: MachineConfig | PlcGenConfig,
  options?: SimulateOptions
): SimResult;
export function simulate(
  inputOrProject: SimulateInput | GeneratedProjectLike,
  maybeConfig?: MachineConfig | PlcGenConfig,
  maybeOptions?: SimulateOptions
): SimResult {
  const raw = 'project' in inputOrProject && 'config' in inputOrProject
    ? inputOrProject as SimulateInput
    : {
        project: inputOrProject as GeneratedProjectLike,
        config: maybeConfig as MachineConfig | PlcGenConfig,
        ...(maybeOptions ?? {})
      };
  if (!raw.config) return failureResult('缺少必填参数：机型配置');
  const options = normalizeOptions(raw);
  let mapping: MappingDocument;
  try {
    mapping = parseMapping(raw.project);
  } catch (error) {
    return failureResult(error instanceof Error ? error.message : String(error));
  }

  const pointIndex = new Map<string, MappingPoint>();
  const variableIndex = new Map<string, string>();
  for (const point of mapping.points) {
    pointIndex.set(normalizePointKey(point.point), point);
    if (point.address) pointIndex.set(normalizePointKey(point.address), point);
    if (point.variable) variableIndex.set(point.variable, normalizePointKey(point.point));
  }

  const actuators = buildActuators(raw.config, pointIndex);
  const actuatorById = new Map(actuators.map((model) => [model.actuator.id, model]));
  const actuatorByOutput = new Map<string, ActuatorModel>();
  for (const model of actuators) {
    for (const key of [model.extendKey, model.retractKey, model.gripKey, model.rotaryKey]) {
      if (key) actuatorByOutput.set(key, model);
    }
  }

  const states = new Map<string, boolean>();
  for (const point of mapping.points) states.set(normalizePointKey(point.point), false);
  const safety = extractSafetyRefs(raw.config as PlcGenConfig);
  const estopKeys = new Set(safety.estop.map((point) => normalizePointKey(point)));
  const doorKeys = new Set(safety.safetyDoor.map((point) => normalizePointKey(point)));
  for (const key of [...estopKeys, ...doorKeys]) states.set(key, true);

  const context: ConditionContext = { states, pointIndex, variableIndex };
  const outputPoints = mapping.points.filter((point) => point.area === 'output');
  const outputKeys = outputPoints.map((point) => normalizePointKey(point.point));
  const initialOutputs = new Map<string, boolean>(outputKeys.map((key) => [key, false]));
  const outputs = initialOutputs;
  const alarms: string[] = [];
  const addAlarm = (message: string): void => {
    if (!alarms.includes(message)) alarms.push(message);
  };

  if (mapping.sequence.length === 0) {
    addAlarm('EMPTY_SEQUENCE:联调步序为空，无法进行模拟验证');
  }

  const checkSensorConflicts = (): void => {
    for (const model of actuators) {
      if (model.sensors.length < 2) continue;
      const first = model.sensors[0];
      const second = model.sensors[1];
      if (!first || !second) continue;
      if (states.get(first.key) === true && states.get(second.key) === true) {
        addAlarm(`SENSOR_CONFLICT:${model.actuator.name}(${model.actuator.id}) 伸出与缩回传感器同时为 1`);
      }
    }
  };

  const pointNameOf = (key: string): string => pointIndex.get(key)?.point ?? key;
  const sensorNameOf = (model: ActuatorModel, index: number): string =>
    model.sensors[index]?.point ?? `#${index + 1}`;

  const timeScale = options.timeScale;
  let clock = 0;
  let eventOrder = 0;
  let events: MotionEvent[] = [];
  const steps: SimStep[] = [];

  const scheduleMotion = (
    model: ActuatorModel,
    target: MotionEvent['target'],
    at: number,
    logs: string[]
  ): void => {
    events = events.filter((event) => event.actuator !== model);
    events.push({ at, order: eventOrder++, actuator: model, target });
    const duration = Math.round(durationOf(model.actuator) / timeScale);
    const label = target === 'both' ? '伸出+缩回（矛盾）'
      : target === 'extend' ? '伸出'
        : target === 'retract' ? '缩回'
          : target === 'active' ? '动作'
            : '复位';
    logs.push(`启动 ${model.actuator.name} → ${label}（${duration} ms）`);
  };

  const applyMotion = (event: MotionEvent, logs: string[]): void => {
    const model = event.actuator;
    const target = event.target;
    const setSensor = (index: number, value: boolean): void => {
      const sensor = model.sensors[index];
      if (!sensor) return;
      if (states.get(sensor.key) === value) return;
      states.set(sensor.key, value);
      logs.push(`到位 ${sensorNameOf(model, index)} := ${value ? 'TRUE' : 'FALSE'}`);
    };
    if (model.actuator.kind === 'cylinder') {
      if (target === 'both') {
        setSensor(0, true);
        setSensor(1, true);
      } else if (target === 'extend') {
        setSensor(0, true);
        if (model.sensors.length > 1) setSensor(1, false);
      } else if (target === 'retract') {
        if (model.sensors.length > 1) setSensor(1, true);
        setSensor(0, false);
      }
    } else {
      setSensor(0, target === 'active');
    }
    checkSensorConflicts();
  };

  const applyActions = (step: MappingStep, logs: string[]): boolean => {
    let safetyTrip = false;
    const write = (point: string, value: boolean): void => {
      const key = outputKeyOf(point, pointIndex, variableIndex);
      if (!key) {
        logs.push(`${point} := ${value ? 'TRUE' : 'FALSE'}（未映射）`);
        return;
      }
      logs.push(`${pointNameOf(key)} := ${value ? 'TRUE' : 'FALSE'}`);
      if (estopKeys.has(key) || doorKeys.has(key)) {
        if (!value) safetyTrip = true;
        states.set(key, value);
        return;
      }
      if (pointIndex.get(key)?.area === 'output') outputs.set(key, value);
      states.set(key, value);
    };
    for (const point of step.sets ?? []) write(point, true);
    for (const point of step.resets ?? []) write(point, false);

    const touched = new Set<ActuatorModel>();
    for (const point of [...(step.sets ?? []), ...(step.resets ?? [])]) {
      const key = outputKeyOf(point, pointIndex, variableIndex);
      const model = key ? actuatorByOutput.get(key) : undefined;
      if (model) touched.add(model);
    }
    for (const model of touched) {
      let target: MotionEvent['target'] | null = null;
      if (model.actuator.kind === 'cylinder') {
        const extended = model.extendKey ? outputs.get(model.extendKey) === true : false;
        const retracted = model.retractKey ? outputs.get(model.retractKey) === true : false;
        if (extended && retracted) target = 'both';
        else if (extended) target = 'extend';
        else if (retracted) target = 'retract';
      } else if (model.gripKey || model.rotaryKey) {
        const key = model.gripKey ?? model.rotaryKey;
        target = key && outputs.get(key) === true ? 'active' : 'inactive';
      }
      if (target) {
        const duration = durationOf(model.actuator) / timeScale;
        scheduleMotion(model, target, clock + duration, logs);
      }
    }
    return safetyTrip;
  };

  const conditionSatisfied = (step: MappingStep): boolean =>
    evaluateCondition(step.condition, context);

  const waitForCondition = (
    step: MappingStep,
    start: number,
    logs: string[]
  ): { ok: boolean; at: number; timeout: boolean } => {
    const timeout = timeoutOf(step);
    const deadline = start + timeout;
    if (conditionSatisfied(step)) return { ok: true, at: start, timeout: false };
    while (true) {
      const pending = events
        .filter((event) => event.at <= deadline)
        .sort((left, right) => left.at - right.at || left.order - right.order);
      const next = pending[0];
      if (!next) return { ok: false, at: deadline, timeout: true };
      clock = next.at;
      events = events.filter((event) => event !== next);
      applyMotion(next, logs);
      if (conditionSatisfied(step)) return { ok: true, at: clock, timeout: false };
      if (clock >= deadline) return { ok: false, at: deadline, timeout: true };
    }
  };

  const skipRemaining = (fromIndex: number, reason: string): void => {
    for (const step of mapping.sequence.slice(fromIndex)) {
      steps.push({
        stepNo: step.stepNo ?? steps.length + 1,
        name: step.name ?? `步骤 ${step.stepNo ?? steps.length + 1}`,
        actions: [],
        waitedMs: 0,
        ok: false,
        reason
      });
    }
  };

  const tripSafety = (point: string | undefined, reason: string, stepNo: number | null): void => {
    for (const key of outputKeys) outputs.set(key, false);
    const label = point ? `${reason} ${point}` : reason;
    addAlarm(`SAFE_STOP:${label}`);
    if (stepNo !== null) {
      steps.push({
        stepNo,
        name: `步骤 ${stepNo}`,
        actions: ['SafeStop：复位全部输出'],
        waitedMs: 0,
        ok: false,
        reason: `安全触发（${label}），SafeStop 中止序列`
      });
    }
  };

  // 传感器矛盾注入：把指定执行机构的前两路到位同时置 1。
  const injectSensorConflict = (): void => {
    const conflictModel = options.sensorConflictActuator
      ? actuatorById.get(options.sensorConflictActuator)
      : actuators.find((model) => model.sensors.length >= 2);
    if (conflictModel && conflictModel.sensors.length >= 2) {
      const first = conflictModel.sensors[0];
      const second = conflictModel.sensors[1];
      if (first && second) {
        states.set(first.key, true);
        states.set(second.key, true);
        addAlarm(`SENSOR_CONFLICT:${conflictModel.actuator.name}(${conflictModel.actuator.id}) 伸出与缩回传感器同时为 1`);
      }
    }
  };

  for (const [index, step] of mapping.sequence.entries()) {
    const stepNo = step.stepNo ?? index + 1;
    const name = step.name ?? `步骤 ${stepNo}`;
    const start = clock;
    const logs: string[] = [];

    // 注入的安全触发先于任何动作，模拟现场急停/开门。
    if (options.safetyTripAtStep === stepNo) {
      const point = options.safetyTripPoint ?? safety.estop[0] ?? safety.safetyDoor[0];
      tripSafety(point, '安全触发', stepNo);
      const entry = steps[steps.length - 1];
      if (entry) {
        entry.name = name;
        entry.reason = `安全触发（${point ?? '急停/安全门'}），SafeStop 中止序列`;
      }
      skipRemaining(index + 1, '安全停止后跳过');
      clock = start;
      break;
    }

    if (options.sensorConflictAtStep === stepNo) injectSensorConflict();

    // 生成的步序若显式断开安全输入，同样立即 SafeStop。
    const actionTrip = applyActions(step, logs);
    if (actionTrip) {
      const point = [...estopKeys, ...doorKeys].find((key) => states.get(key) === false);
      for (const key of outputKeys) outputs.set(key, false);
      events = [];
      addAlarm(`SAFE_STOP:${point ? `安全回路断开 ${pointNameOf(point)}` : '安全回路断开'}`);
      steps.push({
        stepNo,
        name,
        actions: [...logs, 'SafeStop：复位全部输出'],
        waitedMs: 0,
        ok: false,
        reason: `安全触发（${point ? pointNameOf(point) : '急停/安全门'}），SafeStop 中止序列`
      });
      skipRemaining(index + 1, '安全停止后跳过');
      clock = start;
      break;
    }

    const outcome = waitForCondition(step, start, logs);
    if (outcome.ok) {
      steps.push({
        stepNo,
        name,
        actions: logs,
        waitedMs: Math.max(0, Math.round(outcome.at - start)),
        ok: true
      });
      continue;
    }

    const timeout = timeoutOf(step);
    logs.push(`等待超时（${timeout} ms）`);
    addAlarm(`SEQ_TIMEOUT:第 ${stepNo} 步「${name}」等待超时（${timeout} ms）`);
    // 生成的 FC_AutoSequence 在超时后进入 STEP_ERROR 并复位全部输出。
    for (const key of outputKeys) outputs.set(key, false);
    events = [];
    steps.push({
      stepNo,
      name,
      actions: [...logs, 'StepError：复位全部输出'],
      waitedMs: timeout,
      ok: false,
      reason: `第 ${stepNo} 步「${name}」超时：等待条件在 ${timeout} ms 内未满足`
    });
    skipRemaining(index + 1, `第 ${stepNo} 步超时，序列已中止`);
    clock = outcome.at;
    break;
  }

  const finalOutputs: Record<string, boolean> = {};
  for (const point of outputPoints) {
    const key = normalizePointKey(point.point);
    finalOutputs[point.point] = outputs.get(key) === true;
  }

  // 空序列不能靠 every() 的空集合语义误判为验证通过。
  const ok = mapping.sequence.length > 0 && alarms.length === 0 && steps.every((step) => step.ok);
  return {
    ok,
    steps,
    alarms,
    elapsedMs: Math.max(0, Math.round(clock)),
    finalOutputs
  };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `simulate`。 */
export const simulateGeneratedProject = simulate;
