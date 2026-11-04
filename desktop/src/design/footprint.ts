import type { MachineDesign } from '../machine/synth.ts';
import type { MachineGeometry } from '../machine/geometry.ts';
import { resolveMachineGeometry } from '../machine/machine-geometry.ts';
import { applyStationGeometryLayout } from '../machine/station-layout.ts';
import { stationIdentitiesFor } from '../machine/station-identity.ts';
import type { MachineFootprintRequirement } from '../machine/spec.ts';

export interface MachineFootprintAssessment {
  status: 'unbounded' | 'within' | 'exceeds';
  envelope: readonly [number, number];
  excess: readonly [number, number];
  requirement?: MachineFootprintRequirement;
}

function formatMm(value: number): string {
  return String(Number.isInteger(value) ? value : Number(value.toFixed(1)));
}

function validPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 规则引擎原始摆放（未应用工位位姿）；整机布局编辑器以它为基线判断「编辑引入的」干涉。 */
export function generatedGeometryForDesign(design: MachineDesign): MachineGeometry {
  // 唯一入口：输送类机型这里是 85 件参数化整机，其余形态仍是工位生成器
  return resolveMachineGeometry(design, {
    process: design.config.id.match(/design-([a-z]+)-/)?.[1] as never,
    layout: design.form.geometry.kind === 'conveyor' ? 'linear' : design.form.geometry.kind
  }).geometry;
}

/** 与 3D 预览/导出相同的几何路径，返回配置生成的估算包围盒尺寸（X 长 × Y 宽）。 */
export function geometryForDesign(design: MachineDesign): MachineGeometry {
  const generated = generatedGeometryForDesign(design);
  // 参数化整机没有工位底板（stations 为空），工位平移对它无意义
  if (generated.stations.length === 0) return generated;
  const stationIdentities = stationIdentitiesFor(design.config.id, design.config.stations.length, design.stationIdentities);
  return applyStationGeometryLayout(generated, design.stationGeometryLayout, stationIdentities);
}

/** 将几何精度口径和型号未联动警告写入设计，供候选卡、校核、保存与报告复用。 */
export function withGeometryAssessment(design: MachineDesign): MachineDesign {
  const geometry = geometryForDesign(design);
  const assumptionPrefix = 'CAD 几何假设：';
  const warningPrefix = 'CAD 几何警告：';
  const fidelityLabel = geometry.geometryFidelity === 'conceptual-estimate' ? '概念估算占位体' : geometry.geometryFidelity;
  const assumptions = design.assumptions.filter((line) =>
    !line.startsWith('CAD 几何精度：') && !line.startsWith(assumptionPrefix));
  const warnings = design.warnings.filter((line) => !line.startsWith(warningPrefix));
  assumptions.push(`CAD 几何精度：${fidelityLabel}（${geometry.geometryFidelity}）；输出零件为估算占位体。`);
  assumptions.push(...geometry.assumptions.map((line) => `${assumptionPrefix}${line}`));
  warnings.push(...geometry.warnings.map((line) => `${warningPrefix}${line}`));
  return { ...design, assumptions, warnings };
}

/** 按整机几何估算包络比较工程师的长 × 宽边界；不改动或缩放设计实体。 */
export function assessMachineFootprint(
  requirement: MachineFootprintRequirement | null | undefined,
  envelope: readonly [number, number, number] | readonly [number, number]
): MachineFootprintAssessment {
  const length = envelope[0];
  const width = envelope[1];
  if (!validPositive(length) || !validPositive(width)) {
    throw new Error('整机几何包络无效，不能判定占地限制');
  }
  if (requirement == null) {
    return { status: 'unbounded', envelope: [length, width], excess: [0, 0] };
  }
  if (!validPositive(requirement.lengthMm) || !validPositive(requirement.widthMm)) {
    throw new Error('占地限制必须是两个正数');
  }
  const excess: [number, number] = [
    Math.max(0, length - requirement.lengthMm),
    Math.max(0, width - requirement.widthMm)
  ];
  return {
    status: excess[0] > 0 || excess[1] > 0 ? 'exceeds' : 'within',
    envelope: [length, width],
    excess,
    requirement: { ...requirement }
  };
}

function excessText(assessment: MachineFootprintAssessment): string {
  const parts: string[] = [];
  if (assessment.excess[0] > 0) parts.push(`长度 ${formatMm(assessment.excess[0])} mm`);
  if (assessment.excess[1] > 0) parts.push(`宽度 ${formatMm(assessment.excess[1])} mm`);
  return parts.join('、');
}

/** 面向工程师的候选卡片和保存备注文案；超限文案明确列出超出方向和差额。 */
export function footprintAssessmentText(assessment: MachineFootprintAssessment): string {
  const estimated = `${formatMm(assessment.envelope[0])} × ${formatMm(assessment.envelope[1])} mm`;
  if (assessment.status === 'unbounded') return `未设边界 · CAD 估算占地 ${estimated}`;
  const requirement = assessment.requirement;
  if (!requirement) throw new Error('占地评估缺少需求边界');
  const limit = `${formatMm(requirement.lengthMm)} × ${formatMm(requirement.widthMm)} mm`;
  if (assessment.status === 'within') return `符合（CAD 估算） · 包络 ${estimated} / 限制 ${limit}`;
  return `超出（CAD 估算） · 包络 ${estimated} / 限制 ${limit}；超出${excessText(assessment)}`;
}

/** 将当前 CAD 几何估算评估写入既有 assumptions/warnings，确保保存后仍可追溯。 */
export function withFootprintAssessment(
  design: MachineDesign,
  assessment: MachineFootprintAssessment
): MachineDesign {
  const assumptions = design.assumptions.filter((line) => !line.startsWith('占地评估：'));
  const warnings = design.warnings.filter((line) => !line.startsWith('占地超限：'));
  const detail = footprintAssessmentText(assessment);
  assumptions.push(`占地评估：${detail}${assessment.status === 'exceeds' ? '；实体几何保持原样，未自动缩放。' : ''}`);
  if (assessment.status === 'exceeds') {
    warnings.push(`占地超限：${detail}；实体几何保持原样，需调整构型或重新确认边界。`);
  }
  return { ...design, assumptions, warnings };
}
