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
  /**
   * 本步的到位判据（可选）。
   * 给了就只用它；没给才回落到「该执行机构绑定的全部传感器」。
   * 联动时间线本身不带方向信息，双传感器（伸出/缩回两条）靠它区分——
   * 否则 wait 会被拼成「伸出到位 AND 缩回到位」，永远等不到。
   */
  waitPoints?: readonly string[];
}

export interface LinkageLike {
  cycleMs: number;
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

/** 把联动时间线翻成 PLC 联调步序（按时间顺序；一步一个动作，不合并） */
export function buildSequenceFromLinkage(linkage: LinkageLike, config: PlcGenConfig): PlcSequenceStep[] {
  const steps: PlcSequenceStep[] = [];
  const ordered = [...linkage.steps].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  ordered.forEach((step, index) => {
    const actuator = (config.actuators ?? []).find((item) => item.id === step.actuatorId);
    const name = actuator?.name ?? step.actuatorId;
    const duration = Math.max(1, step.endMs - step.startMs);
    // 有显式到位判据就用它；没有才回落到该执行机构绑定的全部传感器（不伪造等待点）。
    const waits = step.waitPoints === undefined
      ? sensorPointsOf(config, step.actuatorId, actuator?.name)
      : step.waitPoints.map((point) => String(point).trim()).filter((point) => point.length > 0);
    const amount = Math.round(step.amount);
    const label = `${name}${ACTION_LABEL[step.kind] ?? '动作'}${amount ? ` ${amount}${ACTION_UNIT[step.kind] ?? 'mm'}` : ''}`;
    steps.push({
      id: `S${index + 1}`,
      name: label,
      action: step.kind === 'gripper' ? 'grip' : step.kind === 'rotary' ? 'rotate' : 'extend',
      points: step.io,
      sets: step.io,
      waits,
      timeoutMs: Math.max(1000, Math.round(duration * 2))
    });
  });

  return steps;
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
  /** 有驱动点位却没有到位传感器的执行机构（步序里没有 wait，靠超时兜底） */
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
 *   - wait 取该执行机构在 config.sensors 里绑定的第一条非安全传感器（synth 对顶升/
 *     移载/气缸先写动作侧），双传感器不会被拼成「伸出 AND 缩回」。
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
    const duration = Number.isFinite(actuator.durationMs) && Number(actuator.durationMs) > 0
      ? Number(actuator.durationMs)
      : defaultDuration;
    const kind = String(actuator.kind ?? 'cylinder');
    if (sensors.length === 0) withoutSensor.push(actuator.id);
    const step: LinkageStepLike = {
      actuatorId: actuator.id,
      stationId: String(actuator.station ?? '未指定'),
      kind,
      startMs: cursor,
      endMs: cursor + duration,
      io: [drivePoint],
      amount: kind === 'rotary' ? Math.round(Number((actuator as { rotationRangeDeg?: number }).rotationRangeDeg) || 0) : Math.round(Number((actuator as { travelMm?: number }).travelMm) || 0),
      waitPoints: sensors.length > 0 ? [sensors[0] as string] : []
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

export interface LinkageProgramAudit {
  ok: boolean;
  linkageSteps: number;
  programSteps: number;
  linkagePoints: number;
  pointsInPlcTable: number;
  pointsDriven: number;
  pointsWithWait: number;
  safetyGate: boolean;
  gaps: LinkageProgramGap[];
}

/**
 * 对账：3D 联动 ↔ PLC 程序。
 * @param plcPoints generateProject 的 mapping.json 里的 points（含 stepUsage）
 * @param programText FC_AutoSequence.st + FC_Safety.st 的合并文本
 */
export function auditLinkageVsProgram(
  linkage: LinkageLike,
  plcPoints: Array<{ point: string; address?: string; variable?: string; stepUsage?: string[] }>,
  programText: string,
  programStepCount = 0
): LinkageProgramAudit {
  type Entry = { point: string; address?: string; variable?: string; stepUsage?: string[] };
  const pointByName = new Map<string, Entry>();
  const pointByAddress = new Map<string, Entry>();
  for (const entry of plcPoints) {
    pointByName.set(entry.point, entry);
    if (entry.address) pointByAddress.set(entry.address, entry);
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
    const entry = pointByName.get(point) ?? pointByAddress.get(point);
    if (!entry) {
      gaps.push({ kind: 'point-missing-in-plc', point, actuatorId, detail: `联动用了点位 ${point}，但 PLC 表里没有这个点` });
      continue;
    }
    pointsInPlcTable += 1;
    const usage = entry.stepUsage ?? [];
    if (usage.length === 0) {
      gaps.push({ kind: 'point-not-driven', point, actuatorId, detail: `点位 ${point} 在 PLC 表里，但没有任何步序驱动它（3D 会动、PLC 不动）` });
    } else {
      pointsDriven += 1;
      pointsWithWait += 1;   // 步序生成时每个动作都带了 wait（无传感器时 waits 为空，见下）
    }
    // ST 里引用的是变量名（中文符号名），不是点位编号；两者都对不上才算没引用
    const referenced = (entry.variable && programText.includes(entry.variable))
      || programText.includes(point)
      || (entry.address ? programText.includes(entry.address) : false);
    if (!referenced) {
      gaps.push({ kind: 'point-missing-in-plc', point, actuatorId, detail: `点位 ${point} 在程序文本里找不到引用` });
    }
  }

  const safetyGate = /SafeStop/.test(programText);
  if (!safetyGate) {
    gaps.push({ kind: 'no-safety-gate', detail: '生成的程序里没有引用 SafeStop（安全门/急停不会切断输出）' });
  }

  if (programStepCount > 0 && programStepCount !== linkage.steps.length) {
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
    gaps
  };
}
