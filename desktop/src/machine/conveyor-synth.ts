/**
 * 输送机方案修正：把「按工位机构推节拍/功率」的通用模型换成输送线的真实算法。
 *
 * 通用合成器把输送机当成 1 个旋转轴 + 2 个光电，用工艺固定时间推节拍（10 件/分起步），
 * 对皮带线是错的：产能由**线速 ÷ 工件间距**决定，驱动功率由**摩擦 + 加速阻力 × 线速**决定。
 * 这里在 synthMachine 收尾阶段覆盖这几项，并把公式和取值全部写进 assumptions。
 */

import type { ConveyorSpec } from './spec.ts';
import { DEFAULT_CONVEYOR, type ConveyorParams } from './conveyor-assembly.ts';

export interface ConveyorDriveEstimate {
  params: ConveyorParams;
  /** 皮带自身质量（上下两行程，kg） */
  beltMassKg: number;
  /** 摩擦阻力（N） */
  frictionN: number;
  /** 启动加速阻力（N） */
  accelN: number;
  /** 合计所需牵引力（N） */
  forceN: number;
  /** 计算功率（W，已除以效率） */
  powerW: number;
  /** 选型电机功率（W，含余量并向上取标准档） */
  motorW: number;
  /** 滚筒扭矩（N·m） */
  torqueNm: number;
  /** 工件间距（mm） */
  pitchMm: number;
  /** 由线速与间距推出的产能（件/分钟） */
  throughputPerMin: number;
  /** 一条皮带上同时在线的工件数 */
  piecesInLine: number;
}

const FRICTION_MU = 0.3;
const MECH_EFFICIENCY = 0.8;
const ACCEL_MPS2 = 1;
const MOTOR_MARGIN = 2;
const MOTOR_STEPS_W = [40, 60, 90, 120, 180, 250, 370, 550] as const;
const PVC_DENSITY_KG_PER_MM3 = 1.4e-6;

export function conveyorParamsFromBrief(spec: ConveyorSpec | undefined): ConveyorParams {
  return {
    lengthMm: spec?.lengthMm ?? DEFAULT_CONVEYOR.lengthMm,
    widthMm: spec?.widthMm ?? DEFAULT_CONVEYOR.widthMm,
    beltHeightMm: DEFAULT_CONVEYOR.beltHeightMm,
    pulleyDiameterMm: DEFAULT_CONVEYOR.pulleyDiameterMm,
    beltThicknessMm: DEFAULT_CONVEYOR.beltThicknessMm,
    frameSectionMm: DEFAULT_CONVEYOR.frameSectionMm
  };
}

/** 工件间距：未给定按「带宽 × 1.0，且不小于 200 mm」取，避免把工件挤在一起。 */
export function pitchForWidth(widthMm: number): number {
  return Math.max(200, Math.round(widthMm));
}

export function estimateConveyorDrive(params: ConveyorParams, options: {
  speedMps?: number | null;
  loadKg?: number | null;
} = {}): ConveyorDriveEstimate {
  const speed = options.speedMps && options.speedMps > 0 ? options.speedMps : 0.2;
  const loadKg = options.loadKg && options.loadKg > 0 ? options.loadKg : 5;
  const pitchMm = pitchForWidth(params.widthMm);

  const beltVolumeMm3 = 2 * (params.lengthMm - 40) * params.widthMm * params.beltThicknessMm;
  const beltMassKg = beltVolumeMm3 * PVC_DENSITY_KG_PER_MM3;
  const movingMassKg = beltMassKg + loadKg;

  const frictionN = movingMassKg * 9.81 * FRICTION_MU;
  const accelN = movingMassKg * ACCEL_MPS2;
  const forceN = frictionN + accelN;
  const powerW = (forceN * speed) / MECH_EFFICIENCY;
  const requiredW = powerW * MOTOR_MARGIN;
  const motorW = MOTOR_STEPS_W.find((step) => step >= requiredW) ?? MOTOR_STEPS_W[MOTOR_STEPS_W.length - 1] ?? 370;
  const pulleyRadiusM = params.pulleyDiameterMm / 2 / 1000;
  const torqueNm = forceN * pulleyRadiusM;

  const throughputPerMin = (speed * 60_000) / pitchMm;
  const piecesInLine = Math.max(1, Math.floor(params.lengthMm / pitchMm));

  return {
    params,
    beltMassKg: round(beltMassKg, 2),
    frictionN: round(frictionN, 1),
    accelN: round(accelN, 1),
    forceN: round(forceN, 1),
    powerW: round(powerW, 1),
    motorW,
    torqueNm: round(torqueNm, 2),
    pitchMm,
    throughputPerMin: round(throughputPerMin, 2),
    piecesInLine
  };
}

export interface ConveyorRefinement {
  estimate: ConveyorDriveEstimate;
  speedMps: number;
  loadKg: number;
  /** 面向用户的一句话驱动选型结论 */
  summary: string;
  assumptions: string[];
}

/**
 * 生成输送机专属的节拍/驱动结论与假设说明。
 * 只返回数据，不直接改 design——由 synth.ts 决定怎么落到 cycle 与 assumptions。
 */
export function refineConveyor(brief: { conveyor?: ConveyorSpec; cyclePerMin: number | null }): ConveyorRefinement {
  const spec = brief.conveyor;
  const params = conveyorParamsFromBrief(spec);
  const speedMps = spec?.speedMps ?? 0.2;
  const loadKg = spec?.loadKg ?? 5;
  const estimate = estimateConveyorDrive(params, { speedMps, loadKg });
  const assumptions = [
    `输送机参数：线体长 ${params.lengthMm} mm、带宽 ${params.widthMm} mm、皮带面高 ${params.beltHeightMm} mm、滚筒 φ${params.pulleyDiameterMm} mm` +
      (spec?.lengthMm && spec?.widthMm ? '（来自需求）' : '（未写全，缺的项按典型值）'),
    `产能由线速决定：${speedMps} m/s ÷ 工件间距 ${estimate.pitchMm} mm → ${estimate.throughputPerMin} 件/分钟；` +
      '与工位机构动作时间无关，换线速即换产能。',
    `驱动阻力：皮带 ${estimate.beltMassKg} kg + 工件 ${loadKg} kg，摩擦 μ=${FRICTION_MU} → ${estimate.frictionN} N；` +
      `启动加速 a=${ACCEL_MPS2} m/s² → ${estimate.accelN} N；合计 ${estimate.forceN} N。`,
    `驱动功率：P = F·v / η = ${estimate.forceN} × ${speedMps} / ${MECH_EFFICIENCY} = ${estimate.powerW} W；` +
      `乘 ${MOTOR_MARGIN} 倍余量后选 ${estimate.motorW} W 减速电机，滚筒扭矩 ${estimate.torqueNm} N·m。`,
    '三维模型不走代理体：由 conveyor-assembly 生成整机参数化装配（零件数随线体长度与是否带转向工位变化），交给 build123d 内核布尔求并并导出 STEP/STL。'
  ];
  const summary = `驱动 ${estimate.motorW} W（需 ${estimate.powerW} W，F=${estimate.forceN} N）· 产能 ${estimate.throughputPerMin} 件/分（${speedMps} m/s，间距 ${estimate.pitchMm} mm）`;
  return { estimate, speedMps, loadKg, summary, assumptions };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
