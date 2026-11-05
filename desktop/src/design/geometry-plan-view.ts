// Read-only plan projection for the current generated MachineGeometry.
// Coordinates are world-space mm (X right, +Y up in the SVG); manual wizard placements are never inputs.
import { partBounds, type GeomPart, type MachineGeometry } from '../machine/geometry.ts';
import { motionEnvelopeColor, type MotionEnvelopeAnalysis } from './motion-envelope.ts';

export interface PlanBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
export interface GeometryPlanPart {
  id: string;
  name: string;
  role: GeomPart['role'];
  stationId?: string;
  bounds: PlanBounds;
}
export interface GeometryPlanStation {
  id: string;
  name: string;
  bounds: PlanBounds;
  partCount: number;
}
export interface GeometryPlanProjection {
  status: 'ready';
  source: 'machine-geometry.parts';
  units: 'mm';
  upAxis: 'z';
  bounds: PlanBounds;
  widthMm: number;
  depthMm: number;
  partCount: number;
  parts: GeometryPlanPart[];
  stations: GeometryPlanStation[];
}
export interface GeometryPlanBlocked {
  status: 'blocked';
  reason: string;
}
export type GeometryPlanResult = GeometryPlanProjection | GeometryPlanBlocked;

const ROLES = new Set<GeomPart['role']>(['frame', 'transfer', 'plate', 'structure', 'fixture', 'actuator', 'sensor', 'safety']);
/**
 * 平面视图只画**机台**：工件（role='workpiece'）不在 ROLES 里，投影时被过滤掉。
 * 这不是漏掉 —— 工件是料，不是设备零件；它的存在意义是参与干涉检查（见 machine-geometry）。
 */
const STATION_COLORS = ['#0f766e', '#2563eb', '#c2410c', '#7c3aed', '#4d7c0f', '#be185d', '#0369a1', '#a16207'];
const ROLE_COLORS: Record<GeomPart['role'], string> = {
  frame: '#475569',
  transfer: '#0e7490',
  plate: '#94a3b8',
  structure: '#64748b',
  fixture: '#16a34a',
  actuator: '#d97706',
  sensor: '#2563eb',
  safety: '#dc2626',
  workpiece: '#0ea5e9'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finiteVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}
function validShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'box') {
    return Array.isArray(value.size) && value.size.length === 3 && value.size.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0);
  }
  return value.type === 'cylinder' &&
    typeof value.radius === 'number' && Number.isFinite(value.radius) && value.radius > 0 &&
    typeof value.length === 'number' && Number.isFinite(value.length) && value.length > 0 &&
    (value.axis === 'x' || value.axis === 'y' || value.axis === 'z');
}
function boundsEqual(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - (expected[index] ?? Number.NaN)) <= 0.002);
}
function validateGeometry(input: unknown): string | null {
  if (!isRecord(input) || input.kind !== 'machine-geometry' || input.schemaVersion !== 1) {
    return '输入不是受支持的 MachineGeometry v1；未生成投影。';
  }
  if (input.units !== 'mm' || input.upAxis !== 'z') {
    return '几何单位或竖直轴不明确（要求 mm / Z-up）；未生成投影。';
  }
  if (input.geometryFidelity !== 'conceptual-estimate') {
    return '几何精度口径未知或不受支持；未生成投影。';
  }
  if (!Array.isArray(input.stations) || input.stations.length === 0) {
    return '几何没有有效工位映射；未生成投影。';
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    return '几何零件为空；未生成投影。';
  }
  const stationIds = new Set<string>();
  for (const station of input.stations) {
    if (!isRecord(station) || typeof station.id !== 'string' || !/^[a-z0-9-]+$/.test(station.id) ||
        typeof station.name !== 'string' || !station.name.trim() || !finiteVec3(station.origin) ||
        typeof station.rotationZDeg !== 'number' || !Number.isFinite(station.rotationZDeg) || stationIds.has(station.id)) {
      return '工位 ID、名称或世界坐标映射缺失/重复；未生成投影。';
    }
    stationIds.add(station.id);
  }
  // st1/st2 are trustworthy only as joins inside this exact geometry snapshot; they are not durable IDs across station reorder.
  const partIds = new Set<string>();
  for (const part of input.parts) {
    if (!isRecord(part) || typeof part.id !== 'string' || !/^[a-z0-9-]+$/.test(part.id) || partIds.has(part.id) ||
        typeof part.name !== 'string' || !part.name.trim() || !ROLES.has(part.role as GeomPart['role']) ||
        !validShape(part.shape) || !finiteVec3(part.center) ||
        typeof part.rotationZDeg !== 'number' || !Number.isFinite(part.rotationZDeg) || part.estimated !== true) {
      return '存在 ID、尺寸、变换或估算来源不完整的几何零件；未生成投影。';
    }
    if (['mirror', 'mirrored', 'mirrorX', 'mirrorY', 'scale', 'transform'].some((key) => key in part)) {
      return `零件 ${part.id} 含 schema v1 未声明的镜像/坐标变换；未生成投影。`;
    }
    if (part.stationId !== undefined && (typeof part.stationId !== 'string' || !stationIds.has(part.stationId))) {
      return '零件到工位的 stationId 映射无效；未生成投影。';
    }
    partIds.add(part.id);
  }
  return null;
}

/** Project each current primitive's world-space AABB; no canvas card or placement dimensions are consulted. */
export function projectMachineGeometryTopView(input: unknown): GeometryPlanResult {
  const invalid = validateGeometry(input);
  if (invalid) return { status: 'blocked', reason: invalid };
  const geometry = input as MachineGeometry;
  const parts: GeometryPlanPart[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const stationBounds = new Map<string, { bounds: PlanBounds; partCount: number }>();

  for (const part of geometry.parts) {
    const box = partBounds(part);
    const bounds: PlanBounds = { minX: box.min[0], maxX: box.max[0], minY: box.min[1], maxY: box.max[1] };
    if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
      return { status: 'blocked', reason: `零件 ${part.id} 的毫米包络无效；未生成投影。` };
    }
    minX = Math.min(minX, bounds.minX);
    maxX = Math.max(maxX, bounds.maxX);
    minY = Math.min(minY, bounds.minY);
    maxY = Math.max(maxY, bounds.maxY);
    minZ = Math.min(minZ, box.min[2]);
    maxZ = Math.max(maxZ, box.max[2]);
    parts.push({ id: part.id, name: part.name, role: part.role, ...(part.stationId ? { stationId: part.stationId } : {}), bounds });
    if (part.stationId) {
      const current = stationBounds.get(part.stationId);
      if (current) {
        current.bounds.minX = Math.min(current.bounds.minX, bounds.minX);
        current.bounds.maxX = Math.max(current.bounds.maxX, bounds.maxX);
        current.bounds.minY = Math.min(current.bounds.minY, bounds.minY);
        current.bounds.maxY = Math.max(current.bounds.maxY, bounds.maxY);
        current.partCount += 1;
      } else {
        stationBounds.set(part.stationId, { bounds: { ...bounds }, partCount: 1 });
      }
    }
  }

  const derivedMin = [minX, minY, minZ];
  const derivedMax = [maxX, maxY, maxZ];
  const savedBounds = geometry.bounds;
  if (!isRecord(savedBounds) || !finiteVec3(savedBounds.min) || !finiteVec3(savedBounds.max) ||
      !boundsEqual(savedBounds.min, derivedMin) || !boundsEqual(savedBounds.max, derivedMax) ||
      !finiteVec3(geometry.envelope) || !boundsEqual(geometry.envelope, derivedMax.map((value, index) => value - (derivedMin[index] ?? 0)))) {
    return { status: 'blocked', reason: '零件实际包络与几何汇总 bounds/envelope 不一致；未生成投影。' };
  }
  const bounds = { minX, maxX, minY, maxY };
  const stations: GeometryPlanStation[] = [];
  for (const station of geometry.stations) {
    const grouped = stationBounds.get(station.id);
    if (!grouped) return { status: 'blocked', reason: `工位 ${station.id} 未映射到任何几何零件；未生成投影。` };
    stations.push({ id: station.id, name: station.name, bounds: grouped.bounds, partCount: grouped.partCount });
  }
  return {
    status: 'ready',
    source: 'machine-geometry.parts',
    units: 'mm',
    upAxis: 'z',
    bounds,
    widthMm: maxX - minX,
    depthMm: maxY - minY,
    partCount: parts.length,
    parts,
    stations
  };
}

function escapeSvg(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
}
function svgNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
function mmText(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Render real component AABBs. SVG maps world +X right and world +Y up. */
export function renderGeometryTopViewSvg(
  projection: GeometryPlanProjection,
  options: { selectedStationId?: string; showMillimeterRuler?: boolean; motionAnalysis?: MotionEnvelopeAnalysis } = {}
): string {
  const motionBounds = options.motionAnalysis?.status === 'computed'
    ? options.motionAnalysis.axes.flatMap((axis) => axis.coverage === 'covered' ? axis.parts.map((part) => part.bounds) : [])
    : [];
  const viewBounds = motionBounds.reduce((bounds, motion) => ({
    minX: Math.min(bounds.minX, motion.minX), maxX: Math.max(bounds.maxX, motion.maxX),
    minY: Math.min(bounds.minY, motion.minY), maxY: Math.max(bounds.maxY, motion.maxY)
  }), { ...projection.bounds });
  const span = Math.max(viewBounds.maxX - viewBounds.minX, viewBounds.maxY - viewBounds.minY);
  const padding = span * 0.04;
  const minX = viewBounds.minX - padding;
  const maxX = viewBounds.maxX + padding;
  const minY = viewBounds.minY - padding;
  const maxY = viewBounds.maxY + padding;
  const viewWidth = maxX - minX;
  const viewHeight = maxY - minY;
  const envelope = `<rect class="geometry-plan-envelope" x="${svgNumber(projection.bounds.minX)}" y="${svgNumber(-projection.bounds.maxY)}" width="${svgNumber(projection.widthMm)}" height="${svgNumber(projection.depthMm)}" fill="none" stroke="#0f172a" stroke-width="2" vector-effect="non-scaling-stroke"><title>全部零件毫米 AABB 的并集包络</title></rect>`;
  const rulerStep = Math.max(100, Math.ceil(span / 120 / 100) * 100);
  const grid: string[] = [];
  if (options.showMillimeterRuler) {
    for (let x = Math.ceil(minX / rulerStep) * rulerStep, count = 0; x <= maxX && count < 150; x += rulerStep, count += 1) {
      grid.push(`<line x1="${svgNumber(x)}" y1="${svgNumber(-maxY)}" x2="${svgNumber(x)}" y2="${svgNumber(-minY)}" stroke="#94a3b8" stroke-opacity=".22" stroke-width=".7" vector-effect="non-scaling-stroke"/>`);
      if (count % 5 === 0) grid.push(`<text x="${svgNumber(x + rulerStep * .04)}" y="${svgNumber(-minY - rulerStep * .08)}" font-size="${svgNumber(Math.max(rulerStep * .12, 8))}" fill="#64748b">${mmText(x)} mm</text>`);
    }
    for (let y = Math.ceil(minY / rulerStep) * rulerStep, count = 0; y <= maxY && count < 150; y += rulerStep, count += 1) {
      grid.push(`<line x1="${svgNumber(minX)}" y1="${svgNumber(-y)}" x2="${svgNumber(maxX)}" y2="${svgNumber(-y)}" stroke="#94a3b8" stroke-opacity=".22" stroke-width=".7" vector-effect="non-scaling-stroke"/>`);
      if (count % 5 === 0) grid.push(`<text x="${svgNumber(minX + rulerStep * .04)}" y="${svgNumber(-y - rulerStep * .04)}" font-size="${svgNumber(Math.max(rulerStep * .12, 8))}" fill="#64748b">Y ${mmText(y)} mm</text>`);
    }
  }
  const components = projection.parts.map((part) => {
    const title = `${part.id} · ${part.name} · X ${mmText(part.bounds.minX)}–${mmText(part.bounds.maxX)} mm · Y ${mmText(part.bounds.minY)}–${mmText(part.bounds.maxY)} mm`;
    return `<rect data-geometry-part-id="${escapeSvg(part.id)}"${part.stationId ? ` data-station-id="${escapeSvg(part.stationId)}"` : ''} data-role="${part.role}" x="${svgNumber(part.bounds.minX)}" y="${svgNumber(-part.bounds.maxY)}" width="${svgNumber(part.bounds.maxX - part.bounds.minX)}" height="${svgNumber(part.bounds.maxY - part.bounds.minY)}" fill="${ROLE_COLORS[part.role]}" fill-opacity=".32" stroke="${ROLE_COLORS[part.role]}" stroke-width="1" vector-effect="non-scaling-stroke"><title>${escapeSvg(title)}</title></rect>`;
  }).join('');
  const motionEnvelopes = options.motionAnalysis?.status === 'computed'
    ? options.motionAnalysis.axes.flatMap((axis, index) => axis.coverage === 'covered' ? axis.parts.map((part) => {
      const color = motionEnvelopeColor(index);
      const title = `概念运动包络 · ${axis.actuatorId} · ${part.partName}（${part.partId}） · X ${mmText(part.bounds.minX)}–${mmText(part.bounds.maxX)} mm · Y ${mmText(part.bounds.minY)}–${mmText(part.bounds.maxY)} mm；仅提醒，非干涉/安全校核`;
      return `<rect class="geometry-plan-motion-envelope" data-geometry-motion-envelope="true" data-motion-axis-id="${escapeSvg(axis.actuatorId)}" data-motion-part-id="${escapeSvg(part.partId)}" x="${svgNumber(part.bounds.minX)}" y="${svgNumber(-part.bounds.maxY)}" width="${svgNumber(part.bounds.maxX - part.bounds.minX)}" height="${svgNumber(part.bounds.maxY - part.bounds.minY)}" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="2" stroke-dasharray="6 3" vector-effect="non-scaling-stroke"><title>${escapeSvg(title)}</title></rect>`;
    }) : []).join('')
    : '';
  const stationOutlines = projection.stations.map((station, index) => {
    const color = STATION_COLORS[index % STATION_COLORS.length] ?? '#0f766e';
    const labelSize = Math.max(span / 65, 18);
    const title = `${station.name}（${station.id}）：${station.partCount} 个实际几何零件的 AABB 并集`;
    const selected = options.selectedStationId === station.id;
    return `<g data-geometry-station-id="${escapeSvg(station.id)}"${selected ? ' data-geometry-station-selected="true"' : ''}><rect x="${svgNumber(station.bounds.minX)}" y="${svgNumber(-station.bounds.maxY)}" width="${svgNumber(station.bounds.maxX - station.bounds.minX)}" height="${svgNumber(station.bounds.maxY - station.bounds.minY)}" fill="none" stroke="${color}" stroke-width="${selected ? '3' : '1.5'}" stroke-dasharray="${svgNumber(Math.max(span / 250, 3))} ${svgNumber(Math.max(span / 180, 5))}" vector-effect="non-scaling-stroke"><title>${escapeSvg(title)}</title></rect><text x="${svgNumber(station.bounds.minX + labelSize * 0.25)}" y="${svgNumber(-station.bounds.maxY + labelSize)}" font-size="${svgNumber(labelSize)}" fill="${color}" stroke="#ffffff" stroke-width="${svgNumber(labelSize / 7)}" paint-order="stroke" vector-effect="non-scaling-stroke">${escapeSvg(station.name)}</text></g>`;
  }).join('');
  const rulerLabel = options.showMillimeterRuler ? `；可量取网格 ${rulerStep} mm/格，SVG 坐标单位为 mm` : '';
  return `<svg id="designGeometryTopView" class="design-geometry-plan-svg" viewBox="${svgNumber(minX)} ${svgNumber(-maxY)} ${svgNumber(viewWidth)} ${svgNumber(viewHeight)}" role="img" aria-label="由 ${projection.partCount} 个当前参数化几何零件毫米 AABB 导出的俯视包络；世界 X 向右、Y 向上；不含手工 placements${rulerLabel}"${options.showMillimeterRuler ? ` data-mm-grid-step="${rulerStep}"` : ''}><rect x="${svgNumber(minX)}" y="${svgNumber(-maxY)}" width="${svgNumber(viewWidth)}" height="${svgNumber(viewHeight)}" fill="#f8fafc"/>${grid.join('')}${components}${motionEnvelopes}${stationOutlines}${envelope}</svg>`;
}

export function geometryPlanRoleColor(role: GeomPart['role']): string {
  return ROLE_COLORS[role];
}
export function geometryPlanStationColor(index: number): string {
  return STATION_COLORS[index % STATION_COLORS.length] ?? '#0f766e';
}
