// 从 3D 联动时间线生成 PLC 步序，并把「程序 ↔ 3D」两头对齐后对账。
//
// 背景（实测）：`design.config` 里只有执行机构与传感器，**没有 sequence**，
// 于是 FC_AutoSequence.st 生成出来是空壳——PLC 工程能编译，但不会驱动任何动作。
// 这里把 linkage（几何算出来的动作、行程、时长、IO 点号）翻成 PlcSequenceStep：
//   - 每一步的输出来自 linkage 的 io（与 3D 用的是同一批点位，不存在两套命名）
//   - 等待条件来自绑定到该执行机构的传感器（没有传感器就不写 wait，也不假装有）
//   - 超时 = 2 × 该动作时长（下限 1 s），写进程序里可查
//
// 生成后不再靠「看起来对」：`auditLinkageVsProgram` 逐条核对
// 联动用到的点在 PLC 表里、在步序里被驱动、并有等待；缺什么如实列出来。

import type { PlcGenConfig, PlcSequenceStep } from './types.ts';

export interface LinkageStepLike {
  actuatorId: string;
  stationId: string;
  kind: string;
  startMs: number;
  endMs: number;
  io: string[];
  amount: number;
  action?: string;
  direction?: string;
  /**
   * 本步的到位判据（可选）。
   * 给了就只用它；没给只接受唯一绑定传感器或唯一方向匹配传感器。
   * 多条传感器无法确认方向时拒绝转换，避免把伸出/缩回到位拼成 AND。
   */
  waitPoints?: readonly string[];
}

export interface LinkageLike {
  cycleMs: number;
  /** Conversion preserves event order only; PLC transitions use sensors, not timeline timestamps. */
  execution?: 'serial' | 'parallel';
  steps: LinkageStepLike[];
}

const ACTION_LABEL: Record<string, string> = {
  gripper: '夹紧',
  cylinder: '伸出',
  linear: '移载',
  rotary: '分度'
};

const ACTION_UNIT: Record<string, string> = {
  rotary: '°'
};

const sensorPointsOf = (config: PlcGenConfig, actuatorId: string, actuatorName?: string): string[] => {
  const points: string[] = [];
  for (const raw of config.sensors ?? []) {
    const sensor = raw as { point?: string; part?: string; role?: string };
    const part = String(sensor.part ?? '');
    if (part !== actuatorId && part !== actuatorName) continue;
    if (sensor.role === 'estop' || sensor.role === 'safetyDoor') continue;
    if (sensor.point) points.push(String(sensor.point));
  }
  return points;
};

function directionOf(value?: string): 'extend' | 'retract' | undefined {
  const text = value?.trim().toLowerCase();
  if (['extend', 'extended', 'grip', 'gripped', 'close', 'closed', 'forward', 'rotate'].includes(text ?? '')) return 'extend';
  if (['retract', 'retracted', 'release', 'released', 'open', 'opened', 'reverse'].includes(text ?? '')) return 'retract';
  return undefined;
}

function waitsForStep(config: PlcGenConfig, step: LinkageStepLike, name?: string, direction?: string): string[] {
  if (step.waitPoints !== undefined) return [...new Set(step.waitPoints.map(p => p.trim()).filter(Boolean))];
  const all = sensorPointsOf(config, step.actuatorId, name);
  if (all.length === 0) return [];
  if (all.length === 1) {
    const sensor = (config.sensors ?? []).find(s => s.point === all[0]) as { role?: string; direction?: string } | undefined;
    const sensorDirection = directionOf(sensor?.direction ?? sensor?.role);
    // A labelled opposite limit is not this action's completion signal.
    return sensorDirection && direction && sensorDirection !== direction ? [] : all;
  }
  const matches = (config.sensors ?? []).filter(raw => {
    const sensor = raw as { part?: string; point?: string; role?: string; direction?: string };
    return (sensor.part === step.actuatorId || sensor.part === name)
      && directionOf(sensor.direction ?? sensor.role) === direction && direction !== undefined;
  }).map(sensor => sensor.point).filter((p): p is string => Boolean(p));
  if (matches.length === 1) return matches;
  throw new Error(`Ambiguous wait sensors for ${step.actuatorId}; supply direction-specific waitPoints`);
}

/** Event-driven serial conversion, not a clock-equivalent timeline scheduler. Overlaps are unsupported. */
export function buildSequenceFromLinkage(
  linkage: LinkageLike,
  config: PlcGenConfig,
  _options: { execution?: 'serial' } = {}
): PlcSequenceStep[] {
  const ordered = [...linkage.steps].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let endMs = -Infinity;
  for (const step of ordered) {
    if (!Number.isFinite(step.startMs) || !Number.isFinite(step.endMs) || step.startMs < 0 || step.endMs <= step.startMs) {
      throw new Error(`Invalid linkage interval for ${step.actuatorId}`);
    }
    if (step.startMs < endMs) throw new Error('Overlapping linkage timeline requires a parallel scheduler; serial PLC conversion is unsupported');
    endMs = step.endMs;
  }
  return ordered.map((step, index) => {
    const actuator = (config.actuators ?? []).find(item => item.id === step.actuatorId);
    const name = actuator?.name ?? step.actuatorId;
    const actionDirection = directionOf(step.action);
    const explicitDirection = directionOf(step.direction);
    if (step.direction && !explicitDirection) throw new Error(`Unsupported direction ${step.direction}`);
    if (actionDirection && explicitDirection && actionDirection !== explicitDirection) throw new Error(`Contradictory action/direction for ${step.actuatorId}`);
    let direction = explicitDirection ?? actionDirection;
    const drive = actuator as { extendPoint?: string; retractPoint?: string; gripPoint?: string } | undefined;
    const forward = drive?.extendPoint ?? drive?.gripPoint;
    const reverse = drive?.retractPoint;
    const io = [...new Set(step.io.map(p => p.trim()).filter(Boolean))];
    let sets = io;
    const resets: string[] = [];
    if (forward && reverse && forward === reverse) throw new Error(`Ambiguous opposed output configuration for ${step.actuatorId}`);
    if (io.length > 1) {
      if (!direction || !forward || !reverse || io.some(p => p !== forward && p !== reverse)) {
        throw new Error(`Ambiguous linkage outputs for ${step.actuatorId}; supply direction and known opposed outputs`);
      }
      sets = [direction === 'extend' ? forward : reverse];
    }
    if (sets.length !== 1) throw new Error(`Ambiguous linkage outputs for ${step.actuatorId}; exactly one drive output is required`);
    const selected = sets[0];
    if (forward && reverse && (selected === forward || selected === reverse)) {
      const selectedDirection = selected === forward ? 'extend' : 'retract';
      if (direction && direction !== selectedDirection) throw new Error(`Contradictory direction and output for ${step.actuatorId}`);
      direction = selectedDirection;
      resets.push(selected === forward ? reverse : forward);
    }
    const waits = waitsForStep(config, step, actuator?.name, direction);
    const amount = Math.round(step.amount);
    const label = `${name}${step.action ?? direction ?? ACTION_LABEL[step.kind] ?? '动作'}${amount ? ` ${amount}${ACTION_UNIT[step.kind] ?? 'mm'}` : ''}`;
    return {
      id: `S${index + 1}`, name: label,
      action: step.action ?? direction ?? (step.kind === 'gripper' ? 'grip' : step.kind === 'rotary' ? 'rotate' : 'extend'),
      points: sets, sets, resets, waits,
      timeoutMs: Math.max(1000, Math.round((step.endMs - step.startMs) * 2))
    };
  });
}

/** 执行机构上「单点驱动」的点位：一步只能置一个线圈，双线圈（伸出/缩回）不猜方向。 */
function drivePointOf(actuator: { point?: string }): string | undefined {
  const point = String(actuator.point ?? '').trim();
  return point.length > 0 ? point : undefined;
}

export interface LinkageDerivation {
  linkage: LinkageLike;
  steps: PlcSequenceStep[];
  /** 参与生成的执行机构 id */
  usedActuators: string[];
  /** 拿不到驱动点位、因此没有进步序的执行机构（如实列出，不静默） */
  skipped: Array<{ actuatorId: string; name: string; reason: string }>;
  /** 有驱动点位却没有唯一到位判据的执行机构；空 wait 会立即转移，审计必须报缺口。 */
  withoutSensor: string[];
}

/**
 * 从机型配置推联动时间线：**PLC 生成路径**在没有显式 sequence 时用它。
 *
 * 为什么不是 `buildLinkage(geometry)`：几何轴的 `points` 是中文标签（"顶升到位"），
 * 不是 PLC 点位号；配置里的 `actuator.point`（ST-TRANSFER-LIFT / ST-TRANSFER-PUSH）
 * 才是变量表里那个点，两者必须同源，否则步序会引用到不存在的符号。
 *
 * 口径（一步一个向前动作，不做回程——回程由现场/操作面板决定，生成器不替人编）：
 *   - 只收有单点驱动（`actuator.point`）的执行机构；只有 extend/retract/grip 多线圈的
 *     旧式执行机构不猜方向，列进 `skipped`；
 *   - 步序按 config.actuators 顺序串行，时长取 `durationMs`（缺省 400 ms）；
 *   - wait 取唯一动作方向传感器（extend/extended 等语义角色），或唯一无反向标记的绑定传感器；
 *     多个限位无唯一方向匹配时留空并报告缺口。
 *   - 这是传感器事件步序，时间线时长只用于超时，不保证相同节拍或驻留时间。
 */
export function linkageFromConfig(
  config: PlcGenConfig,
  options: { defaultDurationMs?: number } = {}
): LinkageDerivation {
  const defaultDuration = Number.isFinite(options.defaultDurationMs) && Number(options.defaultDurationMs) > 0
    ? Number(options.defaultDurationMs)
    : 400;
  const steps: LinkageStepLike[] = [];
  const usedActuators: string[] = [];
  const skipped: LinkageDerivation['skipped'] = [];
  const withoutSensor: string[] = [];
  let cursor = 0;

  for (const rawActuator of config.actuators ?? []) {
    const actuator = rawActuator as { id: string; name?: string; kind?: string; station?: string; point?: string; durationMs?: number };
    const drivePoint = drivePointOf(actuator);
    if (!drivePoint) {
      const multi = (actuator as { extendPoint?: string; retractPoint?: string; gripPoint?: string });
      skipped.push({
        actuatorId: actuator.id,
        name: actuator.name ?? actuator.id,
        reason: multi.retractPoint
          ? '只有伸出/缩回双线圈（extendPoint/retractPoint），没有单点驱动点位，不猜方向'
          : '没有单点驱动点位（point）'
      });
      continue;
    }
    const sensors = sensorPointsOf(config, actuator.id, actuator.name);
    // This derivation's explicit contract is one forward action per single-point actuator.
    // Match semantic roles, never sensor order, point spelling or display names.
    const forwardSensors = (config.sensors ?? []).filter(raw => {
      const sensor = raw as { part?: string; point?: string; role?: string; direction?: string };
      return (sensor.part === actuator.id || sensor.part === actuator.name)
        && directionOf(sensor.direction ?? sensor.role) === 'extend';
    }).map(s => s.point).filter((p): p is string => Boolean(p));
    const uniqueSensor = sensors.length === 1
      ? (config.sensors ?? []).find(s => s.point === sensors[0]) as { role?: string; direction?: string } | undefined
      : undefined;
    const waits = forwardSensors.length === 1 ? forwardSensors
      : sensors.length === 1 && directionOf(uniqueSensor?.direction ?? uniqueSensor?.role) !== 'retract' ? sensors : [];
    const duration = Number.isFinite(actuator.durationMs) && Number(actuator.durationMs) > 0
      ? Number(actuator.durationMs)
      : defaultDuration;
    const kind = String(actuator.kind ?? 'cylinder');
    if (waits.length === 0) withoutSensor.push(actuator.id);
    const step: LinkageStepLike = {
      actuatorId: actuator.id,
      stationId: String(actuator.station ?? '未指定'),
      kind,
      direction: 'extend',
      startMs: cursor,
      endMs: cursor + duration,
      io: [drivePoint],
      amount: kind === 'rotary' ? Math.round(Number((actuator as { rotationRangeDeg?: number }).rotationRangeDeg) || 0) : Math.round(Number((actuator as { travelMm?: number }).travelMm) || 0),
      waitPoints: waits
    };
    steps.push(step);
    usedActuators.push(actuator.id);
    cursor += duration;
  }

  const linkage: LinkageLike = { cycleMs: cursor, steps };
  return { linkage, steps: buildSequenceFromLinkage(linkage, config), usedActuators, skipped, withoutSensor };
}

export interface LinkageProgramGap {
  kind: 'point-missing-in-plc' | 'point-not-driven' | 'no-wait' | 'no-safety-gate' | 'step-count-mismatch';
  point?: string;
  actuatorId?: string;
  detail: string;
}

export interface LinkageAuditPoint {
  point: string;
  address?: string;
  variable?: string;
  stepUsage?: readonly (string | { stepNo: number; usage: 'set' | 'reset' | 'condition' })[];
}

export interface LinkageAuditStep {
  stepNo?: number;
  sets?: readonly string[];
  resets?: readonly string[];
  waits?: readonly string[];
  condition?: string;
}

export interface LinkageAuditOptions {
  programStepCount?: number;
  sequence?: readonly LinkageAuditStep[];
  /** Trusted generator evidence, supplied by the caller; reset coverage is still checked. */
  safety?: { verified: boolean; resetPoints: readonly string[] };
}

export interface LinkageProgramAudit {
  ok: boolean;
  linkageSteps: number;
  programSteps: number;
  linkagePoints: number;
  pointsInPlcTable: number;
  pointsDriven: number;
  pointsWithWait: number;
  safetyGate: boolean;
  safetyVerification: 'structured' | 'generated-assignments' | 'unverified';
  limitations: string[];
  gaps: LinkageProgramGap[];
}

/**
 * 对账：3D 联动 ↔ PLC 程序。
 * @param plcPoints generateProject 的 mapping.json 里的 points（含 stepUsage）
 * @param programText FC_AutoSequence.st + FC_Safety.st 的合并文本
 */
export function auditLinkageVsProgram(
  linkage: LinkageLike,
  plcPoints: readonly LinkageAuditPoint[],
  programText: string,
  countOrOptions: number | LinkageAuditOptions = 0,
  metadata?: readonly LinkageAuditStep[] | LinkageAuditOptions
): LinkageProgramAudit {
  const extra: LinkageAuditOptions = Array.isArray(metadata)
    ? { sequence: metadata }
    : (metadata as LinkageAuditOptions | undefined) ?? {};
  const options: LinkageAuditOptions = typeof countOrOptions === 'number'
    ? { ...extra, programStepCount: countOrOptions }
    : { ...extra, ...countOrOptions };
  const sequence = options.sequence;
  const programStepCount = options.programStepCount ?? sequence?.length ?? 0;
  // Comments cannot establish references, drive assignments, or safety behavior.
  const source = programText.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\n\r]*/g, '');
  const key = (value: string) => value.trim().replace(/^%/, '').toUpperCase();
  const pointByName = new Map<string, LinkageAuditPoint>();
  const pointByAddress = new Map<string, LinkageAuditPoint>();
  for (const entry of plcPoints) {
    pointByName.set(key(entry.point), entry);
    if (entry.variable) pointByName.set(key(entry.variable), entry);
    if (entry.address) pointByAddress.set(key(entry.address), entry);
  }

  const gaps: LinkageProgramGap[] = [];
  const used = new Map<string, string>();   // point → actuatorId
  for (const step of linkage.steps) {
    for (const point of step.io) used.set(point, step.actuatorId);
  }

  let pointsInPlcTable = 0;
  let pointsDriven = 0;
  let pointsWithWait = 0;

  for (const [point, actuatorId] of used) {
    const entry = pointByName.get(key(point)) ?? pointByAddress.get(key(point));
    if (!entry) {
      gaps.push({ kind: 'point-missing-in-plc', point, actuatorId, detail: `联动用了点位 ${point}，但 PLC 表里没有这个点` });
      continue;
    }
    pointsInPlcTable += 1;
    const aliases = [entry.point, entry.variable, entry.address].filter((p): p is string => Boolean(p)).map(key);
    const includesPoint = (values: readonly string[] | undefined) => values?.some(p => aliases.includes(key(p))) ?? false;
    const usage = entry.stepUsage ?? [];
    const setUsage = usage.filter(u => typeof u === 'string' || u.usage === 'set');
    const drivingSteps = sequence?.filter(s => includesPoint(s.sets) && !includesPoint(s.resets));
    const driven = sequence === undefined ? setUsage.length > 0 : (drivingSteps?.length ?? 0) > 0;
    if (!driven) {
      gaps.push({ kind: 'point-not-driven', point, actuatorId, detail: `点位 ${point} 没有已验证的步序置位；condition/reset 引用不算驱动` });
    } else {
      pointsDriven += 1;
      // A wait is evidence only when it belongs to every step that actually energizes this output.
      const withWait = drivingSteps && drivingSteps.length > 0 && drivingSteps.every(s =>
        (s.waits?.some(p => p.trim().length > 0) ?? false)
        && !/^(?:TRUE|1)$/i.test(s.condition?.trim() ?? '')
      );
      if (withWait) pointsWithWait += 1;
      else gaps.push({ kind: 'no-wait', point, actuatorId, detail: sequence === undefined
        ? `点位 ${point} 缺少生成步序元数据，到位等待未验证`
        : `点位 ${point} 至少一个驱动步没有实际到位等待（立即转移或仅条件引用不算 wait）` });
    }
    const referenced = (entry.variable && source.includes(entry.variable))
      || source.includes(point)
      || (entry.address ? source.includes(entry.address) : false);
    if (!referenced) {
      gaps.push({ kind: 'point-missing-in-plc', point, actuatorId, detail: `点位 ${point} 在程序文本里找不到引用` });
    }
  }

  const resetReferences = new Set<string>();
  // Recognize only the generator's flat unconditional reset block, never nested/conditional assignments.
  for (const block of source.matchAll(/\bIF\s+SafeStop\s+THEN\s+([\s\S]*?)\bEND_IF\s*;/gi)) {
    const body = block[1] ?? '';
    const assignment = /(?:"DB_IO"\.)?([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff]*)\s*:=\s*FALSE\s*;/gi;
    const references = [...body.matchAll(assignment)].map(m => key(m[1] ?? ''));
    if (references.length > 0 && body.replace(assignment, '').trim() === '') {
      for (const reference of references) resetReferences.add(reference);
    }
  }
  const covers = (references: ReadonlySet<string>) => used.size > 0 && [...used.keys()].every(point => {
    const entry = pointByName.get(key(point)) ?? pointByAddress.get(key(point));
    return entry && [entry.point, entry.address, entry.variable].some(p => p && references.has(key(p)));
  });
  const structured = options.safety?.verified === true && covers(new Set(options.safety.resetPoints.map(key)));
  const assignments = covers(resetReferences);
  const safetyGate = structured || assignments;
  const safetyVerification = structured ? 'structured' : assignments ? 'generated-assignments' : 'unverified';
  if (!safetyGate) {
    gaps.push({ kind: 'no-safety-gate', detail: '安全输出切断未验证：缺少结构化复位覆盖或严格的 SafeStop 输出复位赋值；注释/声明不构成安全门证据' });
  }

  if (programStepCount !== linkage.steps.length || (sequence !== undefined && sequence.length !== programStepCount)) {
    gaps.push({
      kind: 'step-count-mismatch',
      detail: `联动有 ${linkage.steps.length} 个动作，PLC 步序有 ${programStepCount} 步（应一一对应）`
    });
  }

  return {
    ok: gaps.length === 0,
    linkageSteps: linkage.steps.length,
    programSteps: programStepCount,
    linkagePoints: used.size,
    pointsInPlcTable,
    pointsDriven,
    pointsWithWait,
    safetyGate,
    safetyVerification,
    limitations: ['PLC conversion is event-driven; timeline timestamps, dwell times and cycle duration are not verified.',
      ...(sequence === undefined ? ['Generated sequence metadata missing: waits cannot be verified.'] : []),
      'Safety reset coverage is a static check, not verification of wiring, scan call order or a certified safety system.'],
    gaps
  };
}
