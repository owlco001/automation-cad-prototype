// 整机方案 → PLC 工程之间的「缺口诊断与最小补齐」。
//
// 现状（2026-10-31 实测）：`designMachineFromBrief` 生成的机型，PLC 预检**必然不过**——
// 每个工位的旋转轴都在几何/IO 里存在，但设计只给每个工位配了 1 个传感器，
// 于是 `ACTUATOR_SENSOR_MISSING` 一次报 N 条；没有安全光栅的机型还会报 `ESTOP_UNDEFINED`。
// 这不是 PLC 生成器的问题，是方案自己缺件。所以这里不「跳过预检」，只做两件事：
//   1) 把预检错误翻译成「缺什么、补什么」（每条的处置）；
//   2) 用户明确要求时（`--plc-repair`）按最小改动补齐，并如实标出「这是补齐后的方案」。
//
// 补齐只加执行机构的到位检测与一个急停回路，不动已有执行机构/点位；补完仍要重新预检。

import type { PlcGenConfig } from './types.ts';
import { precheck } from './precheck.ts';

export interface PlcGap {
  code: string;
  message: string;
  /** 建议的处置（null = 需要人来决定，工具不猜） */
  fix: PlcFix | null;
}

export type PlcFix =
  | { kind: 'add-sensor'; actuatorId: string; sensor: Record<string, unknown>; detail: string }
  | { kind: 'add-estop'; point: string; detail: string }
  | { kind: 'add-safety-door'; point: string; detail: string };

export interface PlcGapPlan {
  errors: PlcGap[];
  /** 能自动补齐的条数 */
  autoFixable: number;
}

const pointPrefix = (actuatorId: string): string =>
  actuatorId.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** 读预检错误，给出每条缺口与可执行处置 */
export function planPlcGaps(config: PlcGenConfig): PlcGapPlan {
  const result = precheck(config);
  const usedPoints = new Set((config.sensors ?? []).map((sensor) => String((sensor as { point?: string }).point ?? '')));
  const gaps: PlcGap[] = [];

  for (const error of result.errors) {
    if (error.code === 'ACTUATOR_SENSOR_MISSING') {
      const match = /\(([^)]+)\)/.exec(error.message);
      const actuatorId = match?.[1] ?? '';
      const actuator = (config.actuators ?? []).find((item) => item.id === actuatorId);
      if (!actuator) {
        gaps.push({ code: error.code, message: error.message, fix: null });
        continue;
      }
      let index = 1;
      let point = `${pointPrefix(actuatorId)}-PRX-${index}`;
      while (usedPoints.has(point)) {
        index += 1;
        point = `${pointPrefix(actuatorId)}-PRX-${index}`;
      }
      usedPoints.add(point);
      gaps.push({
        code: error.code,
        message: error.message,
        fix: {
          kind: 'add-sensor',
          actuatorId,
          sensor: {
            point,
            part: actuator.id,
            name: `${actuator.name}到位检测`,
            station: actuator.station,
            type: '接近开关'
          },
          detail: `给「${actuator.name}」补 1 个到位检测（点位 ${point}）`
        }
      });
      continue;
    }

    if (error.code === 'ESTOP_UNDEFINED') {
      gaps.push({
        code: error.code,
        message: error.message,
        fix: { kind: 'add-estop', point: 'ESTOP-1', detail: '补 1 路常闭急停回路（点位 ESTOP-1）' }
      });
      continue;
    }

    if (error.code === 'SAFETY_DOOR_UNDEFINED') {
      gaps.push({
        code: error.code,
        message: error.message,
        fix: { kind: 'add-safety-door', point: 'LIGHT-CURTAIN-1', detail: '补 1 路安全门/光栅输入（点位 LIGHT-CURTAIN-1）' }
      });
      continue;
    }

    // 其他错误（点位冲突、序列不完整等）不猜，交给用户
    gaps.push({ code: error.code, message: error.message, fix: null });
  }

  return { errors: gaps, autoFixable: gaps.filter((gap) => gap.fix !== null).length };
}

export interface PlcRepairResult {
  config: PlcGenConfig;
  applied: string[];
  /** 补齐后重新预检的结果（仍可能有 error） */
  remainingErrors: Array<{ code: string; message: string }>;
  remainingWarnings: Array<{ code: string; message: string }>;
}

/** 按缺口清单做最小补齐；不引入新执行机构、不改已有点位 */
export function repairPlcConfig(config: PlcGenConfig, plan: PlcGapPlan): PlcRepairResult {
  const next = JSON.parse(JSON.stringify(config)) as PlcGenConfig & {
    sensors?: Array<Record<string, unknown>>;
    safety?: Record<string, unknown>;
  };
  next.sensors = [...(next.sensors ?? [])];
  const applied: string[] = [];

  for (const gap of plan.errors) {
    if (!gap.fix) continue;
    if (gap.fix.kind === 'add-sensor') {
      next.sensors.push(gap.fix.sensor);
      applied.push(gap.fix.detail);
      continue;
    }
    next.safety = { ...(next.safety ?? {}) };
    if (gap.fix.kind === 'add-estop' && !('emergencyStop' in next.safety) && !('estop' in next.safety)) {
      next.safety.emergencyStop = gap.fix.point;
      applied.push(gap.fix.detail);
    }
    if (gap.fix.kind === 'add-safety-door' && !('safetyDoor' in next.safety) && !('lightCurtain' in next.safety)) {
      next.safety.safetyDoor = gap.fix.point;
      applied.push(gap.fix.detail);
    }
  }

  const check = precheck(next);
  return {
    config: next,
    applied,
    remainingErrors: check.errors.map((error) => ({ code: error.code, message: error.message })),
    remainingWarnings: check.warnings.map((warning) => ({ code: warning.code, message: warning.message }))
  };
}
