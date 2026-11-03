import type {
  PlcBomInput,
  PlcBomRow,
  PlcGenConfig,
  PlcIoPoint,
  PlcSequenceStep,
  PrecheckResult,
  Issue
} from './types.ts';
import {
  extractSafetyRefs,
  normalizePointKey,
  parsePointAddress,
  pointAreaHint
} from './io.ts';
import { validateDesign, type DesignIssue } from '../machine/validate.ts';

interface PointDefinition {
  point: string;
  address?: string;
  area: 'input' | 'output';
  path: string;
  owner?: string;
}

interface AssignmentLocation {
  point: string;
  path: string;
}

const ACTUATOR_FIELDS = ['extendPoint', 'retractPoint', 'gripPoint', 'point'] as const;
const ACTUATOR_ADDRESS_FIELDS = ['extendAddress', 'retractAddress', 'gripAddress', 'pointAddress'] as const;

type SensorExtras = PlcGenConfig['sensors'][number] & { address?: string; ioAddress?: string };
type ActuatorExtras = PlcGenConfig['actuators'][number] & Record<typeof ACTUATOR_ADDRESS_FIELDS[number], string | undefined>;

function issue(code: string, message: string, path?: string): Issue {
  return path ? { code, message, path } : { code, message };
}

function normalizedName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function actuatorPoint(actuator: PlcGenConfig['actuators'][number], field: typeof ACTUATOR_FIELDS[number]): string | undefined {
  return actuator[field];
}

function actuatorPointDefinitions(config: PlcGenConfig): PointDefinition[] {
  const definitions: PointDefinition[] = [];
  for (const [index, rawActuator] of (config.actuators ?? []).entries()) {
    const actuator = rawActuator as ActuatorExtras;
    for (const [fieldIndex, field] of ACTUATOR_FIELDS.entries()) {
      const point = actuatorPoint(actuator, field);
      if (!point) continue;
      const definition: PointDefinition = {
        point,
        area: 'output',
        path: `actuators[${index}].${field}`,
        owner: actuator.id
      };
      const addressField = ACTUATOR_ADDRESS_FIELDS[fieldIndex];
      const address = addressField ? actuator[addressField] : undefined;
      if (typeof address === 'string' && address.trim()) definition.address = address.trim();
      definitions.push(definition);
    }
  }
  return definitions;
}

function sensorPointDefinitions(config: PlcGenConfig): PointDefinition[] {
  return (config.sensors ?? []).map((rawSensor, index) => {
    const sensor = rawSensor as SensorExtras;
    const definition: PointDefinition = {
      point: sensor.point,
      area: 'input',
      path: `sensors[${index}].point`,
      owner: sensor.part
    };
    const address = sensor.ioAddress ?? sensor.address;
    if (address?.trim()) definition.address = address.trim();
    return definition;
  });
}

function extraPointDefinitions(config: PlcGenConfig): PointDefinition[] {
  const extraPoints: readonly PlcIoPoint[] = config.ioPoints ?? [];
  const definitions: PointDefinition[] = [];
  for (const [index, point] of extraPoints.entries()) {
    const area = point.area ?? pointAreaHint(point.address ?? point.point);
    if (!area) continue;
    const definition: PointDefinition = { point: point.point, area, path: `ioPoints[${index}].point` };
    if (point.address?.trim()) definition.address = point.address.trim();
    definitions.push(definition);
  }
  return definitions;
}

function definitionPoints(config: PlcGenConfig): PointDefinition[] {
  const definitions = [...sensorPointDefinitions(config), ...actuatorPointDefinitions(config), ...extraPointDefinitions(config)];
  const known = new Set(definitions.flatMap((definition) => (
    definition.address
      ? [normalizePointKey(definition.point), normalizePointKey(definition.address)]
      : [normalizePointKey(definition.point)]
  )));
  const safety = extractSafetyRefs(config);
  for (const [index, point] of safety.estop.entries()) {
    const key = normalizePointKey(point);
    if (known.has(key)) continue;
    known.add(key);
    definitions.push({ point, area: 'input', path: `safety.estop[${index}]`, owner: 'safety-estop' });
  }
  for (const [index, point] of safety.safetyDoor.entries()) {
    const key = normalizePointKey(point);
    if (known.has(key)) continue;
    known.add(key);
    definitions.push({ point, area: 'input', path: `safety.safetyDoor[${index}]`, owner: 'safety-door' });
  }
  if (safety.reset) {
    const key = normalizePointKey(safety.reset);
    if (!known.has(key)) {
      known.add(key);
      definitions.push({ point: safety.reset, area: 'input', path: 'safety.reset', owner: 'safety-reset' });
    }
  }
  return definitions;
}

function checkAddresses(definitions: PointDefinition[], errors: Issue[]): void {
  for (const definition of definitions) {
    const parsed = parsePointAddress(definition.address ?? definition.point);
    if (parsed && !parsed.inRange) {
      errors.push(issue(
        'ADDRESS_OUT_OF_RANGE',
        `点位 ${definition.point}${definition.address ? `（${definition.address}）` : ''} 地址越界：I/Q 区各限 256 点（I0.0~I31.7、Q0.0~Q31.7）`,
        definition.path
      ));
    }
  }

  const groups = new Map<string, PointDefinition[]>();
  for (const definition of definitions) {
    const key = normalizePointKey(definition.address ?? definition.point);
    const group = groups.get(key) ?? [];
    group.push(definition);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const labels = [...new Set(group.map((item) => (
      item.address && item.address.trim().toUpperCase() !== item.point.trim().toUpperCase()
        ? `${item.point}(${item.address})`
        : item.point
    ).trim().toUpperCase()))];
    const addressText = key.startsWith('S:') ? group[0]?.point ?? key.slice(2) : key;
    errors.push(issue(
      'ADDRESS_DUPLICATE',
      `点位地址重复：${labels.join('、')} 均使用 ${addressText}（${group.length} 处定义）`,
      group[1]?.path
    ));
  }

  for (const area of ['input', 'output'] as const) {
    const unique = new Set(
      definitions.filter((definition) => definition.area === area).map((definition) => normalizePointKey(definition.address ?? definition.point))
    );
    if (unique.size > 256) {
      errors.push(issue(
        'ADDRESS_OUT_OF_RANGE',
        `${area === 'input' ? 'I' : 'Q'} 区共 ${unique.size} 个点位，超过 256 点上限`
      ));
    }
  }
}

function checkActuatorPoints(config: PlcGenConfig, errors: Issue[]): void {
  const groups = new Map<string, Array<{ point: string; path: string; actuatorId: string; actuatorIndex: number }>>();
  for (const [index, rawActuator] of (config.actuators ?? []).entries()) {
    const actuator = rawActuator as ActuatorExtras;
    for (const field of ACTUATOR_FIELDS) {
      const point = actuatorPoint(actuator, field);
      if (!point) continue;
      const key = normalizePointKey(point);
      const group = groups.get(key) ?? [];
      group.push({ point, path: `actuators[${index}].${field}`, actuatorId: actuator.id, actuatorIndex: index });
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const actuatorIds = [...new Set(group.map((item) => item.actuatorId))];
    if (actuatorIds.length < 2) continue;
    errors.push(issue(
      'POINT_MULTI_ACTUATOR',
      `点位 ${group[0]?.point} 被多个执行机构占用：${actuatorIds.join('、')}`,
      group[1]?.path
    ));
  }
}

/**
 * 传感器绑定（part 指向哪个工位/执行机构）只在 machine/validate.ts 判定一次，
 * 这里把它的 SENSOR_UNBOUND 结论并入预检，再补预检自己的「执行机构是否有到位传感器」检查。
 */
function checkActuatorSensors(config: PlcGenConfig, unbound: readonly DesignIssue[], errors: Issue[]): void {
  const unboundPaths = new Set<string>();
  for (const item of unbound) {
    const path = item.path.replace(/^config\./, '');
    unboundPaths.add(path);
    errors.push(issue(item.code, item.message, path));
  }

  const safetyPoints = new Set<string>();
  const safety = extractSafetyRefs(config);
  for (const point of [...safety.estop, ...safety.safetyDoor]) safetyPoints.add(normalizePointKey(point));

  const bound = new Map<string, number>();
  for (const [index, rawSensor] of (config.sensors ?? []).entries()) {
    const sensor = rawSensor as SensorExtras;
    if (unboundPaths.has(`sensors[${index}].part`)) continue;
    const address = sensor.ioAddress ?? sensor.address;
    if (safetyPoints.has(normalizePointKey(sensor.point)) || (address && safetyPoints.has(normalizePointKey(address)))) continue;
    const part = normalizedName(sensor.part);
    const actuator = (config.actuators ?? []).find((candidate) => (
      normalizedName(candidate.id) === part || normalizedName(candidate.name) === part
    ));
    // 绑到「工位」而非具体执行机构的传感器已由 validateDesign 判为合法，只是不计入到位传感器。
    if (!actuator) continue;
    bound.set(actuator.id, (bound.get(actuator.id) ?? 0) + 1);
  }

  for (const [index, actuator] of (config.actuators ?? []).entries()) {
    if ((bound.get(actuator.id) ?? 0) === 0) {
      errors.push(issue(
        'ACTUATOR_SENSOR_MISSING',
        `执行机构「${actuator.name}」(${actuator.id}) 未配到位传感器`,
        `actuators[${index}]`
      ));
    }
  }
}

function stepPointRefs(step: PlcSequenceStep): Array<{ point: string; field: string }> {
  const refs: Array<{ point: string; field: string }> = [];
  if (step.point) refs.push({ point: step.point, field: 'point' });
  for (const field of ['points', 'setPoints', 'resetPoints', 'waitPoints', 'sets', 'resets', 'waits'] as const) {
    for (const point of step[field] ?? []) refs.push({ point, field });
  }
  if (step.condition) {
    const pattern = /%?(?:[IQ]\d+\.\d+|[XY]\d+|DI\d+(?:\.\d+)?|DQ\d+(?:\.\d+)?|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
    for (const match of step.condition.match(pattern) ?? []) {
      if (/^(?:TRUE|FALSE|AND|OR|NOT|XOR|MOD)$/i.test(match)) continue;
      refs.push({ point: match, field: 'condition' });
    }
  }
  return refs;
}

function sequencePointIssues(config: PlcGenConfig, known: Set<string>, errors: Issue[]): void {
  const sequences: Array<{ steps: readonly PlcSequenceStep[]; name: string }> = [];
  if (config.sequence) sequences.push({ steps: config.sequence, name: 'sequence' });
  if (config.steps) sequences.push({ steps: config.steps, name: 'steps' });

  for (const sequence of sequences) {
    for (const [stepIndex, step] of sequence.steps.entries()) {
      const checked = new Set<string>();
      for (const ref of stepPointRefs(step)) {
        const key = normalizePointKey(ref.point);
        if (known.has(key) || checked.has(`${ref.field}:${key}`)) continue;
        checked.add(`${ref.field}:${key}`);
        errors.push(issue(
          'SEQUENCE_POINT_NOT_FOUND',
          `步序「${step.name ?? step.id ?? stepIndex + 1}」引用了不存在的点位 ${ref.point}`,
          `${sequence.name}[${stepIndex}].${ref.field}`
        ));
      }
    }
  }
}

function isOutputAssignment(step: PlcSequenceStep): boolean {
  const action = normalizedName(step.action ?? step.type);
  return ['set', 'reset', 'write', 'assign', 'coil', '置位', '复位', '赋值'].includes(action);
}

function checkDoubleCoil(config: PlcGenConfig, errors: Issue[]): void {
  const outputKeys = new Set(
    definitionPoints(config)
      .filter((definition) => definition.area === 'output')
      .map((definition) => normalizePointKey(definition.point))
  );
  const assignments = new Map<string, AssignmentLocation[]>();
  const add = (point: string, path: string): void => {
    const isOutput = pointAreaHint(point) === 'output' || outputKeys.has(normalizePointKey(point));
    if (!isOutput) return;
    const key = normalizePointKey(point);
    const locations = assignments.get(key) ?? [];
    locations.push({ point, path });
    assignments.set(key, locations);
  };

  const sequences: Array<{ steps: readonly PlcSequenceStep[]; name: string }> = [];
  if (config.sequence) sequences.push({ steps: config.sequence, name: 'sequence' });
  if (config.steps) sequences.push({ steps: config.steps, name: 'steps' });
  for (const sequence of sequences) {
    for (const [stepIndex, step] of sequence.steps.entries()) {
      if (!isOutputAssignment(step)) continue;
      if (step.point) add(step.point, `${sequence.name}[${stepIndex}].point`);
      for (const [pointIndex, point] of (step.points ?? []).entries()) {
        add(point, `${sequence.name}[${stepIndex}].points[${pointIndex}]`);
      }
      for (const [pointIndex, point] of (step.setPoints ?? []).entries()) {
        add(point, `${sequence.name}[${stepIndex}].setPoints[${pointIndex}]`);
      }
      for (const [pointIndex, point] of (step.resetPoints ?? []).entries()) {
        add(point, `${sequence.name}[${stepIndex}].resetPoints[${pointIndex}]`);
      }
      for (const [pointIndex, point] of (step.sets ?? []).entries()) {
        add(point, `${sequence.name}[${stepIndex}].sets[${pointIndex}]`);
      }
      for (const [pointIndex, point] of (step.resets ?? []).entries()) {
        add(point, `${sequence.name}[${stepIndex}].resets[${pointIndex}]`);
      }
    }
  }

  for (const locations of assignments.values()) {
    if (locations.length < 2) continue;
    const paths = locations.map((location) => location.path);
    errors.push(issue(
      'DOUBLE_COIL',
      `双线圈：输出点 ${locations[0]?.point} 被多处赋值（${paths.join('、')}）`,
      paths[1]
    ));
  }
}

function numberField(row: PlcBomRow, key: keyof PlcBomRow): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bomRows(bom: PlcBomInput): PlcBomRow[] {
  if (Array.isArray(bom)) return [...bom];
  const record = bom as Exclude<PlcBomInput, readonly PlcBomRow[]>;
  const plcRows = record.plc?.modules ?? [];
  const synthetic: PlcBomRow[] = [];
  if (plcRows.length === 0 && record.plc) {
    const inputPoints = record.plc.inputPoints;
    const outputPoints = record.plc.outputPoints;
    const points = record.plc.points ?? record.plc.ioPoints;
    if (inputPoints !== undefined || outputPoints !== undefined || points !== undefined) {
      synthetic.push({
        name: 'PLC',
        ...(inputPoints !== undefined ? { inputPoints } : {}),
        ...(outputPoints !== undefined ? { outputPoints } : {}),
        ...(points !== undefined ? { points } : {})
      });
    }
  }
  return [
    ...(record.rows ?? []),
    ...(record.bom ?? []),
    ...(record.modules ?? []),
    ...(record.plcModules ?? []),
    ...(record.items ?? []),
    ...plcRows,
    ...synthetic
  ];
}

function parseBomTextPoints(text: string): { input: number; output: number; total: number } {
  let input = 0;
  let output = 0;
  let total = 0;
  const combined = /(\d+)\s*(?:DI|数字量输入)\s*[/／,、]\s*(\d+)\s*(?:DO|数字量输出)/i.exec(text);
  if (combined) {
    input = Number(combined[1]);
    output = Number(combined[2]);
  } else {
    const reverse = /(\d+)\s*(?:DO|数字量输出)\s*[/／,、]\s*(\d+)\s*(?:DI|数字量输入)/i.exec(text);
    if (reverse) {
      output = Number(reverse[1]);
      input = Number(reverse[2]);
    }
  }
  if (input === 0 && output === 0) {
    const prefixed = /(?:DI|数字量输入)\s*(\d+)\s*[/／,、]\s*(?:DO|数字量输出)\s*(\d+)/i.exec(text);
    if (prefixed) {
      input = Number(prefixed[1]);
      output = Number(prefixed[2]);
    }
  }
  if (input === 0 && output === 0) {
    // 入口/出口写法：8 IN / 6 OUT、8 入 / 6 出
    const io = /(\d+)\s*(?:IN|入)\s*[/／,、]\s*(\d+)\s*(?:OUT|出)/i.exec(text);
    if (io) {
      input = Number(io[1]);
      output = Number(io[2]);
    }
  }
  if (input === 0 && output === 0) {
    // 按出现顺序：「输入8 输出6」「DI:8 DO:6」
    const ordered = /(?:输入|\bDI\b)\s*[:：=]?\s*(\d+)[\s\S]*?(?:输出|\bDO\b)\s*[:：=]?\s*(\d+)/i.exec(text);
    if (ordered) {
      input = Number(ordered[1]);
      output = Number(ordered[2]);
    }
  }
  if (input === 0) {
    // 8×DI / 8 x DI
    const timesInput = /(\d+)\s*[×xX*]\s*(?:DI|数字量输入)/i.exec(text);
    if (timesInput) input = Number(timesInput[1]);
  }
  if (output === 0) {
    const timesOutput = /(\d+)\s*[×xX*]\s*(?:DO|数字量输出)/i.exec(text);
    if (timesOutput) output = Number(timesOutput[1]);
  }
  if (input === 0) {
    const match = /(\d+)\s*(?:DI|数字量输入|输入点|输入通道)/i.exec(text);
    if (match) input = Number(match[1]);
  }
  if (output === 0) {
    const match = /(\d+)\s*(?:DO|数字量输出|输出点|输出通道)/i.exec(text);
    if (match) output = Number(match[1]);
  }
  const fallback = /(\d+)\s*(?:点|通道|路)/.exec(text);
  if (fallback) total = Number(fallback[1]);
  if (input === 0 && output === 0 && total === 0) {
    const ioMatch = /(?:io|i\/o)\s*[:：=]?\s*(\d+)|(\d+)\s*(?:io|i\/o)/i.exec(text);
    if (ioMatch) total = Number(ioMatch[1] ?? ioMatch[2]);
  }
  return { input, output, total };
}

function checkBomCapacity(config: PlcGenConfig, bom: PlcBomInput | undefined, errors: Issue[], warnings: Issue[]): void {
  if (bom === undefined) return;
  const rows = bomRows(bom);
  if (rows.length === 0) return;

  const used = definitionPoints(config);
  const usedInputs = new Set(used.filter((point) => point.area === 'input').map((point) => normalizePointKey(point.address ?? point.point))).size;
  const usedOutputs = new Set(used.filter((point) => point.area === 'output').map((point) => normalizePointKey(point.address ?? point.point))).size;

  let inputCapacity = 0;
  let outputCapacity = 0;
  let totalCapacity = 0;
  let hasCapacity = false;
  let hasDirectionalCapacity = false;
  let suspectedPlcWithoutPoints = false;

  for (const [index, row] of rows.entries()) {
    const text = [row.name, row.model, row.spec, row.partId, row.note, row.category, row.kind, row.material]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');
    const explicitInput = numberField(row, 'inputPoints') ?? numberField(row, 'diPoints')
      ?? numberField(row, 'inputCount') ?? numberField(row, 'di');
    const explicitOutput = numberField(row, 'outputPoints') ?? numberField(row, 'doPoints')
      ?? numberField(row, 'outputCount') ?? numberField(row, 'do');
    const generic = numberField(row, 'points') ?? numberField(row, 'ioPoints') ?? numberField(row, 'ioCount');
    const parsed = parseBomTextPoints(text);
    const looksPlc = explicitInput !== undefined || explicitOutput !== undefined || generic !== undefined
      || /plc|cpu|io|i\/o|模块|数字量|\bdi\b|\bdo\b|输入|输出/i.test(text);
    const inputPoints = explicitInput ?? parsed.input;
    const outputPoints = explicitOutput ?? parsed.output;
    const totalPoints = generic ?? parsed.total;
    if (!looksPlc && inputPoints === 0 && outputPoints === 0 && totalPoints === 0) continue;
    const quantity = (row.quantity ?? row.qty ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      warnings.push(issue('BOM_INVALID_QUANTITY', `BOM 第 ${index + 1} 行数量无效，点数校验已忽略该行`));
      continue;
    }
    if (inputPoints === 0 && outputPoints === 0 && totalPoints === 0) {
      if (looksPlc) suspectedPlcWithoutPoints = true;
      continue;
    }
    hasCapacity = true;
    if (explicitInput !== undefined || explicitOutput !== undefined || parsed.input > 0 || parsed.output > 0) {
      hasDirectionalCapacity = true;
    }
    inputCapacity += inputPoints * quantity;
    outputCapacity += outputPoints * quantity;
    totalCapacity += totalPoints * quantity;
  }

  if (!hasCapacity) {
    if (suspectedPlcWithoutPoints) {
      warnings.push(issue('BOM_PLC_POINTS_UNKNOWN', 'BOM 中有 PLC/IO 模块，但未提供可解析的点数（如 16DI/16DO 或 inputPoints/outputPoints），无法校验点数容量'));
    }
    return;
  }

  if (hasDirectionalCapacity && inputCapacity < usedInputs) {
    errors.push(issue(
      'BOM_PLC_INPUT_POINTS_INSUFFICIENT',
      `BOM 中 PLC 模块输入点数不足：可用 ${inputCapacity} 点，实际使用 ${usedInputs} 点`
    ));
  }
  if (hasDirectionalCapacity && outputCapacity < usedOutputs) {
    errors.push(issue(
      'BOM_PLC_OUTPUT_POINTS_INSUFFICIENT',
      `BOM 中 PLC 模块输出点数不足：可用 ${outputCapacity} 点，实际使用 ${usedOutputs} 点`
    ));
  }
  if (totalCapacity > 0 && totalCapacity < usedInputs + usedOutputs) {
    errors.push(issue(
      'BOM_PLC_POINTS_INSUFFICIENT',
      `BOM 中 PLC 模块总点数不足：可用 ${totalCapacity} 点，实际使用 ${usedInputs + usedOutputs} 点`
    ));
  }
}

/**
 * 预检全部生成前置条件。所有规则都会执行，错误按检查项全量返回，不遇错即停。
 */
export function precheck(config: PlcGenConfig, bom?: PlcBomInput): PrecheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const definitions = definitionPoints(config);
  const known = new Set(definitions.flatMap((definition) => (
    definition.address
      ? [normalizePointKey(definition.point), normalizePointKey(definition.address)]
      : [normalizePointKey(definition.point)]
  )));

  checkAddresses(definitions, errors);
  checkActuatorPoints(config, errors);
  // 绑定规则只认 validateDesign 的结论（与方案落盘校验同源），预检不再自己跑一套正则。
  const sensorBinding = validateDesign(config).issues.filter((item) => item.code === 'SENSOR_UNBOUND');
  checkActuatorSensors(config, sensorBinding, errors);

  const safety = extractSafetyRefs(config);
  if (safety.estop.length === 0) {
    errors.push(issue('ESTOP_UNDEFINED', '急停回路未定义：请在 safety.emergencyStop / safety.estop 指定急停点位，或为传感器设置 role=estop'));
  }
  if (safety.safetyDoor.length === 0) {
    errors.push(issue('SAFETY_DOOR_UNDEFINED', '安全门未定义：请在 safety.safetyDoor 指定安全门/光栅点位，或为传感器设置 role=safetyDoor'));
  }

  sequencePointIssues(config, known, errors);
  checkDoubleCoil(config, errors);
  checkBomCapacity(config, bom, errors, warnings);

  return { errors, warnings };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `precheck`。 */
export const precheckMachineConfig = precheck;
export const runPrecheck = precheck;
