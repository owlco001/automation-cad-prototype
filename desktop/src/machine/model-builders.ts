/**
 * 整机模型构建器注册表。
 *
 * 目的：智能体只看到一个工具 `build_machine_model`，机型差异由这里的映射决定；
 * 以后加链板线/滚筒线/转盘机只是加一条映射，不新增工具。
 *
 * 两种引擎：
 * - `parametric`：按尺寸生成参数化装配，交 build123d 内核布尔求并 + 逐件导出 STEP/STL，
 *   拿到真实体积/质量/包围盒（适合按尺寸驱动的整机，如皮带输送线）。
 * - `rules`：几何由 machine/geometry.ts 按「工位 + 机构」规则摆放（现有五类工艺走这条），
 *   速度快、带特征树，但模型是标准件外形占位，不进内核。
 */

import type { MachineProcess } from './spec.ts';
import { DEFAULT_CONVEYOR, type ConveyorParams } from './conveyor-assembly.ts';

export type ModelEngine = 'parametric' | 'rules';

export interface ModelParamSpec {
  name: string;
  label: string;
  /** 默认值（mm / 无量纲） */
  defaultValue: number;
  min: number;
  max: number;
  unit: string;
}

export interface ModelBuilder {
  process: MachineProcess;
  engine: ModelEngine;
  label: string;
  /** 该机型可调参数；工具描述与参数校验都用它 */
  params: ModelParamSpec[];
  /** rules 引擎暂无独立构建器时给出的替代指引 */
  hint?: string;
}

const CONVEYOR_PARAMS: ModelParamSpec[] = [
  { name: 'lengthMm', label: '线体总长', defaultValue: DEFAULT_CONVEYOR.lengthMm, min: 400, max: 12000, unit: 'mm' },
  { name: 'widthMm', label: '皮带有效宽度', defaultValue: DEFAULT_CONVEYOR.widthMm, min: 100, max: 1200, unit: 'mm' },
  { name: 'beltHeightMm', label: '皮带面高度', defaultValue: DEFAULT_CONVEYOR.beltHeightMm, min: 300, max: 1400, unit: 'mm' },
  { name: 'pulleyDiameterMm', label: '滚筒直径', defaultValue: DEFAULT_CONVEYOR.pulleyDiameterMm, min: 20, max: 200, unit: 'mm' },
  { name: 'beltThicknessMm', label: '皮带厚度', defaultValue: DEFAULT_CONVEYOR.beltThicknessMm, min: 1, max: 20, unit: 'mm' },
  { name: 'frameSectionMm', label: '型材截面', defaultValue: DEFAULT_CONVEYOR.frameSectionMm, min: 20, max: 100, unit: 'mm' },
  { name: 'layers', label: '缓存层数（1=普通线体，≥2=立体缓存）', defaultValue: DEFAULT_CONVEYOR.layers, min: 1, max: 8, unit: '层' },
  { name: 'layerPitchMm', label: '层间距', defaultValue: DEFAULT_CONVEYOR.layerPitchMm, min: 250, max: 900, unit: 'mm' },
  // 转向工位：0 = 不做；45/90/180 = 线体中段把工件就地旋转多少度
  { name: 'turnerAngleDeg', label: '转向角度（0=不做转向工位，90=旋转 90°）', defaultValue: DEFAULT_CONVEYOR.turnerAngleDeg, min: 0, max: 180, unit: '°' },
  // 顶升移载（直角移载）：板宽 > 0 才建移载单元（没板宽就没法算移载行程）。
  // 用板宽当开关而不是再加一个 0/1 开关：行程本来就是「板宽 + 结构间隙 + 余量」，
  // 没有板宽这个单元根本算不出来，给 0 就是「不做」。
  { name: 'transferPartWidthMm', label: '移载板宽（0=不做顶升移载；>0 建直角移载单元）', defaultValue: 0, min: 0, max: 1200, unit: 'mm' },
  { name: 'transferPartLengthMm', label: '移载板长（决定下游对接段宽度，0=按带宽推）', defaultValue: 0, min: 0, max: 4000, unit: 'mm' }
];

export const MODEL_BUILDERS: Partial<Record<MachineProcess, ModelBuilder>> = {
  conveyor: {
    process: 'conveyor',
    engine: 'parametric',
    label: '输送线 / 立体缓存（参数化内核：逐件真实零件 → STEP/STL；layers≥2 出多层缓存）',
    params: CONVEYOR_PARAMS
  }
};

/** 只做规则几何、没有参数化构建器的工艺：给出替代入口，避免工具假装能建。 */
export const RULES_ONLY_PROCESSES: MachineProcess[] = ['screw', 'dispense', 'assembly', 'inspection', 'packaging'];

export function pickModelBuilder(process: string | null | undefined): ModelBuilder | null {
  if (!process) return null;
  return MODEL_BUILDERS[process as MachineProcess] ?? null;
}

export interface NormalizedModelParams {
  ok: boolean;
  /** 夹紧/补默认后的参数（仅 build 支持的键） */
  params: Record<string, number>;
  message?: string;
  /** 被忽略的未知键，回给调用方而不是静默丢弃 */
  ignored: string[];
}

/** 参数校验：未知键要报出来；数字越界夹到区间并在 message 里说明。 */
export function normalizeModelParams(builder: ModelBuilder, input: unknown): NormalizedModelParams {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const params: Record<string, number> = {};
  const ignored: string[] = [];
  const notes: string[] = [];
  const known = new Set(builder.params.map((spec) => spec.name));

  for (const key of Object.keys(source)) {
    if (!known.has(key)) ignored.push(key);
  }

  for (const spec of builder.params) {
    const raw = source[spec.name];
    if (raw === undefined || raw === null) {
      params[spec.name] = spec.defaultValue;
      continue;
    }
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, params: {}, ignored, message: `${spec.label}（${spec.name}）必须是数字` };
    }
    if (value < spec.min || value > spec.max) {
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      notes.push(`${spec.label} ${value} ${spec.unit} 超出 ${spec.min}~${spec.max}，按 ${clamped} 处理`);
      params[spec.name] = clamped;
      continue;
    }
    params[spec.name] = value;
  }

  if (ignored.length > 0) notes.push(`忽略未知参数：${ignored.join('、')}`);
  return {
    ok: true,
    params,
    ignored,
    ...(notes.length > 0 ? { message: notes.join('；') } : {})
  };
}

/** 渲染端把参数喂给零件生成器时用的类型收窄。 */
export function toConveyorParams(params: Record<string, number>): ConveyorParams {
  return {
    lengthMm: params.lengthMm ?? DEFAULT_CONVEYOR.lengthMm,
    widthMm: params.widthMm ?? DEFAULT_CONVEYOR.widthMm,
    beltHeightMm: params.beltHeightMm ?? DEFAULT_CONVEYOR.beltHeightMm,
    pulleyDiameterMm: params.pulleyDiameterMm ?? DEFAULT_CONVEYOR.pulleyDiameterMm,
    beltThicknessMm: params.beltThicknessMm ?? DEFAULT_CONVEYOR.beltThicknessMm,
    frameSectionMm: params.frameSectionMm ?? DEFAULT_CONVEYOR.frameSectionMm,
    layers: params.layers ?? DEFAULT_CONVEYOR.layers,
    layerPitchMm: params.layerPitchMm ?? DEFAULT_CONVEYOR.layerPitchMm,
    turnerAngleDeg: params.turnerAngleDeg ?? DEFAULT_CONVEYOR.turnerAngleDeg,
    transferPartWidthMm: params.transferPartWidthMm ?? 0,
    transferPartLengthMm: params.transferPartLengthMm ?? 0
  };
}
