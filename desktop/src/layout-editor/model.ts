/**
 * 整机布局编辑：数据模型、选择、位姿写回与联动校验（纯函数，无 DOM / three）。
 *
 * 主数据：MachineDesign.stationGeometryLayout（按稳定工位身份保存的刚体位姿：xMm / yMm /
 * 可选 rotationZDeg）。几何永远由唯一入口 resolveMachineGeometry（输送类 = 85 件参数化整机，
 * 其余形态 = 工位生成器）→ applyStationGeometryLayout 派生（footprint.geometryForDesign），
 * 与向导俯视、3D 预览、保存工程/STL、Agent apply_machine_design 是同一条路径。
 * 本模块只产出新的 MachineDesign，不另存位姿。
 *
 * 注意：参数化整机没有工位底板（geometry.stations 为空），这类机型在本编辑器里没有可拖的工位，
 * 只有整机实体；这是「没有工位」而不是「加载失败」。
 *
 * 可编辑粒度 = 工位（stN 组）。零件与执行机构没有独立的位姿主数据（由规则引擎按工位生成），
 * 因此零件可选中查看，但移动/旋转作用于其所属工位；机架/输送等无工位零件只读。
 */
import { partBounds, type GeomPart, type MachineGeometry, type Vec3 } from '../machine/geometry.ts';
import type { MachineDesign } from '../machine/synth.ts';
import type { MachineFootprintRequirement } from '../machine/spec.ts';
import {
  normalizeStationGeometryLayout,
  normalizeStationRotationDeg,
  stationGeometryPose,
  withStationGeometryPoses,
  type StationGeometryLayout
} from '../machine/station-layout.ts';
import { stationIdentitiesFor } from '../machine/station-identity.ts';
import { assessMachineFootprint, footprintAssessmentText, generatedGeometryForDesign, geometryForDesign, type MachineFootprintAssessment } from '../design/footprint.ts';
import { analyzeConceptMotionEnvelopes, type MotionEnvelopeAlert } from '../design/motion-envelope.ts';
import { baselinePairs, bodiesFromGeometry, detectCollisions, FRAME_UNIT, refineCollision, type CollisionReport, type RefinedCollision } from './collision.ts';
import type { LayoutPose } from './numeric.ts';
import type { Rect2 } from './snap.ts';

export type { LayoutPose } from './numeric.ts';

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export interface LayoutStationUnit {
  id: string;
  index: number;
  name: string;
  identity: string;
  pose: LayoutPose;
  /** 规则引擎原始工位原点（旋转枢轴，世界 mm） */
  pivot: Vec3;
  /** 当前工位原点（世界 mm） */
  origin: Vec3;
  partIds: string[];
  bounds: Box3;
  actuators: Array<{ id: string; name: string; kind: string; model?: string; partId?: string }>;
  sensors: Array<{ point: string; model?: string; partId?: string }>;
}

export interface LayoutPartInfo {
  id: string;
  name: string;
  role: GeomPart['role'];
  unitId: string;
  actuatorId?: string;
  sensorPoint?: string;
  bounds: Box3;
  /** 形体包络尺寸（mm，未旋转的局部尺寸） */
  size: Vec3;
  center: Vec3;
  rotationZDeg: number;
  moving: boolean;
  /** 元件库绑定（来自机型配置的执行机构/传感器） */
  model?: string;
  partId?: string;
}

export interface LayoutModel {
  machineId: string;
  stations: LayoutStationUnit[];
  parts: LayoutPartInfo[];
  /** 机架/输送等无工位零件的合并 XY 包络（台面参考），没有则为 null */
  frameRect: Rect2 | null;
}

export type SelectionItem = { kind: 'station'; id: string } | { kind: 'part'; id: string };
export type SelectMode = 'station' | 'part';

function round(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function union(boxes: readonly Box3[]): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] as number, box.min[axis] as number);
      max[axis] = Math.max(max[axis] as number, box.max[axis] as number);
    }
  }
  return { min: min.map(round) as Vec3, max: max.map(round) as Vec3 };
}

export function boxToRect(box: Box3): Rect2 {
  return { minX: box.min[0], maxX: box.max[0], minY: box.min[1], maxY: box.max[1] };
}

function shapeSize(part: GeomPart): Vec3 {
  if (part.shape.type === 'box') return [...part.shape.size] as Vec3;
  const d = part.shape.radius * 2;
  const l = part.shape.length;
  return part.shape.axis === 'x' ? [l, d, d] : part.shape.axis === 'y' ? [d, l, d] : [d, d, l];
}

/** 由设计与其派生几何（geometryForDesign 的结果）构建编辑模型。 */
export function buildLayoutModel(design: MachineDesign, geometry: MachineGeometry): LayoutModel {
  const identities = stationIdentitiesFor(design.config.id, design.config.stations.length, design.stationIdentities);
  const actuatorById = new Map(design.config.actuators.map((item) => [item.id, item]));
  const sensorByPoint = new Map(design.config.sensors.map((item) => [item.point, item]));
  const parts: LayoutPartInfo[] = geometry.parts.map((part) => {
    const bounds = partBounds(part);
    const actuator = part.actuatorId ? actuatorById.get(part.actuatorId) : undefined;
    const sensor = part.sensorPoint ? sensorByPoint.get(part.sensorPoint) : undefined;
    const model = actuator?.model ?? sensor?.model;
    const partId = actuator?.partId ?? sensor?.partId;
    return {
      id: part.id,
      name: part.name,
      role: part.role,
      unitId: part.stationId ?? FRAME_UNIT,
      ...(part.actuatorId ? { actuatorId: part.actuatorId } : {}),
      ...(part.sensorPoint ? { sensorPoint: part.sensorPoint } : {}),
      bounds: { min: bounds.min.map(round) as Vec3, max: bounds.max.map(round) as Vec3 },
      size: shapeSize(part),
      center: [...part.center] as Vec3,
      rotationZDeg: part.rotationZDeg,
      moving: part.moving === true,
      ...(model ? { model } : {}),
      ...(partId ? { partId } : {})
    };
  });
  const stations: LayoutStationUnit[] = geometry.stations.map((station) => {
    const pose = stationGeometryPose(design, station.id) ?? { stationIdentity: identities[station.index] ?? '', xMm: 0, yMm: 0, rotationZDeg: 0 };
    const members = parts.filter((part) => part.unitId === station.id);
    const name = design.config.stations[station.index] ?? station.name;
    return {
      id: station.id,
      index: station.index,
      name,
      identity: pose.stationIdentity,
      pose: { xMm: pose.xMm, yMm: pose.yMm, rotationZDeg: pose.rotationZDeg },
      pivot: [round(station.origin[0] - pose.xMm), round(station.origin[1] - pose.yMm), station.origin[2]],
      origin: [...station.origin] as Vec3,
      partIds: members.map((part) => part.id),
      bounds: members.length ? union(members.map((part) => part.bounds)) : { min: [...station.origin] as Vec3, max: [...station.origin] as Vec3 },
      actuators: design.config.actuators.filter((item) => item.station === name).map((item) => ({
        id: item.id, name: item.name, kind: item.kind,
        ...(item.model ? { model: item.model } : {}),
        ...(item.partId ? { partId: item.partId } : {})
      })),
      sensors: design.config.sensors.filter((item) => item.station === name).map((item) => ({
        point: item.point,
        ...(item.model ? { model: item.model } : {}),
        ...(item.partId ? { partId: item.partId } : {})
      }))
    };
  });
  const frameParts = parts.filter((part) => part.unitId === FRAME_UNIT && part.role === 'frame');
  const frameBox = frameParts.length ? union(frameParts.map((part) => part.bounds)) : null;
  return { machineId: geometry.machineId, stations, parts, frameRect: frameBox ? boxToRect(frameBox) : null };
}

/* -------------------------------------------------------------- 选择 */

function sameItem(a: SelectionItem, b: SelectionItem): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * 点击命中零件 partId 后的新选择。mode='station' 时命中工位零件选中整个工位；
 * 无工位零件（机架等）总是按零件选中（只读）。additive（Ctrl/⌘）切换该项，否则替换。
 * 点空白（partId=null）且非 additive 时清空。
 */
export function nextSelection(
  model: LayoutModel,
  current: readonly SelectionItem[],
  partId: string | null,
  options: { additive: boolean; mode: SelectMode }
): SelectionItem[] {
  if (partId === null) return options.additive ? [...current] : [];
  const part = model.parts.find((item) => item.id === partId);
  if (!part) return [...current];
  const item: SelectionItem = options.mode === 'station' && part.unitId !== FRAME_UNIT
    ? { kind: 'station', id: part.unitId }
    : { kind: 'part', id: part.id };
  if (!options.additive) return [item];
  return current.some((existing) => sameItem(existing, item))
    ? current.filter((existing) => !sameItem(existing, item))
    : [...current, item];
}

/** 选择集对应的可编辑工位（零件映射到其所属工位，去重保持顺序；机架零件不可编辑）。 */
export function editableStations(model: LayoutModel, selection: readonly SelectionItem[]): string[] {
  const ids: string[] = [];
  for (const item of selection) {
    const id = item.kind === 'station' ? item.id : model.parts.find((part) => part.id === item.id)?.unitId;
    if (id && id !== FRAME_UNIT && model.stations.some((station) => station.id === id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 选择集中的全部零件（工位展开为其零件），用于高亮。 */
export function selectedPartIds(model: LayoutModel, selection: readonly SelectionItem[]): string[] {
  const ids = new Set<string>();
  for (const item of selection) {
    if (item.kind === 'part') ids.add(item.id);
    else model.stations.find((station) => station.id === item.id)?.partIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

export interface PropertyView {
  title: string;
  count: number;
  rows: Array<{ label: string; value: string }>;
  /** 单个可编辑工位时可直接输入的位姿 */
  editable: { stationId: string; pose: LayoutPose } | null;
  note: string;
}

function mm(value: number): string {
  return `${round(value)}`;
}

function sizeText(box: Box3): string {
  return `${mm(box.max[0] - box.min[0])} × ${mm(box.max[1] - box.min[1])} × ${mm(box.max[2] - box.min[2])} mm`;
}

/** 属性面板：名称、partId、位置、旋转、尺寸包络。 */
export function describeSelection(model: LayoutModel, selection: readonly SelectionItem[]): PropertyView {
  if (selection.length === 0) {
    return { title: '未选择', count: 0, rows: [], editable: null, note: '点选零件或工位；Ctrl/⌘ 多选；Shift 拖拽框选。' };
  }
  if (selection.length > 1) {
    const stations = editableStations(model, selection);
    const boxes = selectedPartIds(model, selection).map((id) => model.parts.find((part) => part.id === id)?.bounds).filter((box): box is Box3 => Boolean(box));
    const box = boxes.length ? union(boxes) : null;
    return {
      title: `已选 ${selection.length} 项`,
      count: selection.length,
      rows: [
        { label: '可移动工位', value: stations.length ? stations.map((id) => model.stations.find((station) => station.id === id)?.name ?? id).join('、') : '无（仅机架零件）' },
        ...(box ? [{ label: '合并包络', value: sizeText(box) }, { label: '包络范围 X', value: `${mm(box.min[0])} ～ ${mm(box.max[0])} mm` }, { label: '包络范围 Y', value: `${mm(box.min[1])} ～ ${mm(box.max[1])} mm` }] : [])
      ],
      editable: null,
      note: '多选可整体拖动/旋转，或使用对齐、分布、阵列排布。'
    };
  }
  const item = selection[0] as SelectionItem;
  if (item.kind === 'station') {
    const station = model.stations.find((entry) => entry.id === item.id);
    if (!station) return { title: '对象已不存在', count: 1, rows: [], editable: null, note: '' };
    const models = station.actuators.map((actuator) => actuator.model ? `${actuator.name}：${actuator.model}` : null).filter(Boolean) as string[];
    const partIds = [...station.actuators.map((actuator) => actuator.partId), ...station.sensors.map((sensor) => sensor.partId)].filter(Boolean) as string[];
    return {
      title: `工位 · ${station.name}`,
      count: 1,
      rows: [
        { label: '几何编号', value: `${station.id}（内部临时编号）` },
        { label: '稳定身份', value: station.identity },
        { label: 'partId', value: partIds.length ? partIds.join('、') : '—（未绑定元件库）' },
        { label: '型号', value: models.length ? models.join('；') : '待选型' },
        { label: '位置偏移（主数据）', value: `X ${mm(station.pose.xMm)} · Y ${mm(station.pose.yMm)} mm` },
        { label: '工位原点（世界）', value: `X ${mm(station.origin[0])} · Y ${mm(station.origin[1])} · Z ${mm(station.origin[2])} mm` },
        { label: '旋转 RZ', value: `${round(station.pose.rotationZDeg)}°` },
        { label: '尺寸包络', value: sizeText(station.bounds) },
        { label: '零件数', value: `${station.partIds.length}（${station.actuators.length} 机构 / ${station.sensors.length} 传感）` }
      ],
      editable: { stationId: station.id, pose: { ...station.pose } },
      note: '位置为相对规则引擎原始摆放的刚体偏移；旋转绕原始工位原点。'
    };
  }
  const part = model.parts.find((entry) => entry.id === item.id);
  if (!part) return { title: '对象已不存在', count: 1, rows: [], editable: null, note: '' };
  const station = model.stations.find((entry) => entry.id === part.unitId);
  return {
    title: `零件 · ${part.name}`,
    count: 1,
    rows: [
      { label: '零件 ID', value: part.id },
      { label: 'partId', value: part.partId ?? '—（概念占位体）' },
      { label: '型号', value: part.model ?? '—' },
      { label: '所属', value: station ? `工位 ${station.name}` : '机架 / 公共结构（只读）' },
      { label: '中心（世界）', value: `X ${mm(part.center[0])} · Y ${mm(part.center[1])} · Z ${mm(part.center[2])} mm` },
      { label: '旋转 RZ', value: `${round(part.rotationZDeg)}°` },
      { label: '形体尺寸', value: `${mm(part.size[0])} × ${mm(part.size[1])} × ${mm(part.size[2])} mm` },
      { label: '世界包络', value: sizeText(part.bounds) }
    ],
    editable: station ? { stationId: station.id, pose: { ...station.pose } } : null,
    note: station
      ? '零件没有独立位姿主数据：移动/旋转作用于所属工位整体。'
      : '机架与公共结构由规则引擎按整机生成，布局编辑中只读。'
  };
}

/* -------------------------------------------------------------- 位姿运算 */

/**
 * 多选整体变换：以选择中心 center 为枢轴转 dθ 并平移 (dx, dy)，返回每个工位的新位姿。
 * 工位世界原点 O = pivot + t；新 O' = center + R(dθ)(O − center) + d；t' = O' − pivot；θ' = θ + dθ。
 */
export function composeGroupTransform(
  stations: ReadonlyArray<Pick<LayoutStationUnit, 'id' | 'pivot' | 'pose'>>,
  center: readonly [number, number],
  delta: { dx: number; dy: number; dRotationZDeg: number }
): Map<string, LayoutPose> {
  const rad = delta.dRotationZDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const result = new Map<string, LayoutPose>();
  for (const station of stations) {
    const ox = station.pivot[0] + station.pose.xMm - center[0];
    const oy = station.pivot[1] + station.pose.yMm - center[1];
    const nx = center[0] + ox * cos - oy * sin + delta.dx;
    const ny = center[1] + ox * sin + oy * cos + delta.dy;
    result.set(station.id, {
      xMm: round(nx - station.pivot[0]),
      yMm: round(ny - station.pivot[1]),
      rotationZDeg: normalizeStationRotationDeg(station.pose.rotationZDeg + delta.dRotationZDeg)
    });
  }
  return result;
}

/** 把位姿表写回 MachineDesign（同一撤销步）；BOM / 配置 / 其它字段原样保留。 */
export function writeStationPoses(design: MachineDesign, poses: ReadonlyMap<string, LayoutPose>): MachineDesign {
  if (poses.size === 0) return design;
  const geometry = geometryForDesign(design);
  return withStationGeometryPoses(design, geometry, [...poses].map(([stationId, pose]) => ({
    stationId,
    xMm: pose.xMm,
    yMm: pose.yMm,
    rotationZDeg: pose.rotationZDeg
  })));
}

/** 拖动预览：不写主数据，返回候选设计派生的几何（与最终写回完全同一路径）。 */
export function previewGeometry(design: MachineDesign, poses: ReadonlyMap<string, LayoutPose>): MachineGeometry {
  return geometryForDesign(writeStationPoses(design, poses));
}

/* -------------------------------------------------------------- 撤销快照 */

export interface LayoutSnapshot {
  configId: string;
  formId: string;
  stationIdentities: string[];
  layout: StationGeometryLayout | null;
}

export function layoutSnapshot(design: MachineDesign): LayoutSnapshot {
  return {
    configId: design.config.id,
    formId: design.form.id,
    stationIdentities: stationIdentitiesFor(design.config.id, design.config.stations.length, design.stationIdentities),
    layout: design.stationGeometryLayout ? JSON.parse(JSON.stringify(design.stationGeometryLayout)) as StationGeometryLayout : null
  };
}

export function sameLayoutSnapshot(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 把撤销/重做快照写回设计。快照只在同一方案、同一组稳定身份上有效；否则返回 null
 * （调用方作废布局历史，不按名称或序号猜测）。
 */
export function applyLayoutSnapshot(design: MachineDesign, snapshot: unknown): MachineDesign | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Partial<LayoutSnapshot>;
  if (value.configId !== design.config.id || value.formId !== design.form.id || !Array.isArray(value.stationIdentities)) return null;
  const identities = stationIdentitiesFor(design.config.id, design.config.stations.length, design.stationIdentities);
  if (identities.length !== value.stationIdentities.length || identities.some((identity, index) => identity !== value.stationIdentities?.[index])) return null;
  const next: MachineDesign = { ...design, stationIdentities: identities };
  if (value.layout === null || value.layout === undefined) {
    delete next.stationGeometryLayout;
    return next;
  }
  const resolved = normalizeStationGeometryLayout(value.layout, design.config.stations, identities);
  if (resolved.layout) next.stationGeometryLayout = resolved.layout;
  else delete next.stationGeometryLayout;
  return next;
}

/* -------------------------------------------------------------- 联动校验 */

export interface LayoutCheckItem {
  severity: 'error' | 'warning' | 'info' | 'pass';
  title: string;
  detail: string;
  unitIds: string[];
  partIds: string[];
}

export interface LayoutChecks {
  items: LayoutCheckItem[];
  collisions: CollisionReport;
  motionAlerts: MotionEnvelopeAlert[];
  motionStatus: 'computed' | 'blocked';
  footprint: MachineFootprintAssessment | null;
  /** 红色标记的工位 / 零件（包络干涉 + 运动包络新增告警） */
  redUnits: string[];
  redParts: string[];
}

function motionKey(alert: MotionEnvelopeAlert): string {
  return `${alert.moving.partId}|${alert.other.partId}`;
}

/**
 * 编辑后联动校验：包络级碰撞（相对规则引擎基线只报新增）、运动包络扫掠告警（同样去基线）、
 * 工位是否超出机架台面、占地需求。不改 review 结果；review 的签名包含 stationGeometryLayout，
 * 位姿一变第 5 步「一键校核」即判为过期，需要工程师重新运行。
 */
export function runLayoutChecks(
  design: MachineDesign,
  options: { footprintRequirement?: MachineFootprintRequirement | null; geometry?: MachineGeometry } = {}
): LayoutChecks {
  const geometry = options.geometry ?? geometryForDesign(design);
  const generated = generatedGeometryForDesign(design);
  const baseline = baselinePairs(bodiesFromGeometry(generated));
  const collisions = detectCollisions(bodiesFromGeometry(geometry), { baseline });
  const unitOf = new Map(geometry.parts.map((part) => [part.id, part.stationId ?? FRAME_UNIT]));
  const items: LayoutCheckItem[] = [];
  const stationName = (id: string): string => id === FRAME_UNIT ? '机架/公共结构' : (geometry.stations.find((station) => station.id === id)?.name ?? id);

  if (collisions.pairs.length) {
    for (const pair of collisions.pairs.slice(0, 20)) {
      items.push({
        severity: 'error',
        title: `包络干涉：${pair.aName} ↔ ${pair.bName}`,
        detail: `${stationName(pair.aUnit)} 与 ${stationName(pair.bUnit)} 的零件包络重叠，AABB 交集约 ${Math.round(pair.aabbOverlapMm3)} mm³（上界；包络级，非实体求交）。`,
        unitIds: [pair.aUnit, pair.bUnit].filter((id) => id !== FRAME_UNIT),
        partIds: [pair.a, pair.b]
      });
    }
    if (collisions.pairs.length > 20) {
      items.push({ severity: 'error', title: `另有 ${collisions.pairs.length - 20} 处包络干涉`, detail: '列表仅显示前 20 处（按交集体积排序）。', unitIds: [], partIds: [] });
    }
  } else {
    items.push({ severity: 'pass', title: '未发现编辑引入的包络干涉', detail: `OBB 包络检测 ${collisions.checkedBodies} 件${collisions.baselineSkipped ? `；规则引擎原始摆放已有 ${collisions.baselineSkipped} 处重叠不重复提示` : ''}。`, unitIds: [], partIds: [] });
  }

  const motion = analyzeConceptMotionEnvelopes(geometry);
  let motionAlerts: MotionEnvelopeAlert[] = [];
  if (motion.status === 'computed') {
    const base = analyzeConceptMotionEnvelopes(generated);
    const baseKeys = new Set(base.status === 'computed' ? base.alerts.map(motionKey) : []);
    motionAlerts = motion.alerts.filter((alert) => !baseKeys.has(motionKey(alert)) &&
      unitOf.get(alert.moving.partId) !== unitOf.get(alert.other.partId));
    for (const alert of motionAlerts.slice(0, 10)) {
      items.push({
        severity: 'warning',
        title: `运动包络冲突：${alert.moving.partName} ↔ ${alert.other.partName}`,
        detail: `${alert.moving.actuatorId} 行程扫掠包络与 ${stationName(unitOf.get(alert.other.partId) ?? FRAME_UNIT)} 的 ${alert.other.partName} 重叠（XY 扫掠 AABB × Z 区间，概念提醒）。`,
        unitIds: [unitOf.get(alert.moving.partId), unitOf.get(alert.other.partId)].filter((id): id is string => Boolean(id) && id !== FRAME_UNIT),
        partIds: [alert.moving.partId, alert.other.partId]
      });
    }
    if (motionAlerts.length === 0) items.push({ severity: 'pass', title: '运动包络无新增冲突', detail: '按当前几何的执行机构行程扫掠检查。', unitIds: [], partIds: [] });
  } else {
    items.push({ severity: 'info', title: '运动包络未计算', detail: motion.reason, unitIds: [], partIds: [] });
  }

  const model = buildLayoutModel(design, geometry);
  if (model.frameRect) {
    const frame = model.frameRect;
    for (const station of model.stations) {
      const plate = geometry.parts.find((part) => part.stationId === station.id && part.role === 'plate');
      const box = plate ? partBounds(plate) : station.bounds;
      if (box.min[0] < frame.minX - 0.01 || box.max[0] > frame.maxX + 0.01 || box.min[1] < frame.minY - 0.01 || box.max[1] > frame.maxY + 0.01) {
        items.push({ severity: 'warning', title: `工位超出机架台面：${station.name}`, detail: `底板包络 X ${round(box.min[0])}～${round(box.max[0])}、Y ${round(box.min[1])}～${round(box.max[1])} mm 超出机架 X ${round(frame.minX)}～${round(frame.maxX)}、Y ${round(frame.minY)}～${round(frame.maxY)} mm；机架不随工位自动加长。`, unitIds: [station.id], partIds: plate ? [plate.id] : [] });
      }
    }
  }

  let footprint: MachineFootprintAssessment | null = null;
  try {
    footprint = assessMachineFootprint(options.footprintRequirement ?? null, geometry.envelope);
    items.push({ severity: footprint.status === 'exceeds' ? 'warning' : 'info', title: '占地评估', detail: footprintAssessmentText(footprint), unitIds: [], partIds: [] });
  } catch (error) {
    items.push({ severity: 'warning', title: '占地评估失败', detail: error instanceof Error ? error.message : String(error), unitIds: [], partIds: [] });
  }

  const red = items.filter((item) => item.severity === 'error' || item.severity === 'warning');
  return {
    items,
    collisions,
    motionAlerts,
    motionStatus: motion.status,
    footprint,
    redUnits: [...new Set(red.flatMap((item) => item.unitIds))].sort(),
    redParts: [...new Set([...collisions.partIds, ...motionAlerts.flatMap((alert) => [alert.moving.partId, alert.other.partId])])].sort()
  };
}

/**
 * 松手后精检：对包络级命中的每一对做截面多边形求交（盒-盒精确）。只在编辑结束后调用；
 * 不依赖 build123d sidecar（sidecar 目前没有布尔求交接口），结果标注精度口径。
 */
export function refineLayoutCollisions(geometry: MachineGeometry, report: CollisionReport): RefinedCollision[] {
  const bodies = new Map(bodiesFromGeometry(geometry).map((body) => [body.id, body]));
  return report.pairs.flatMap((pair) => {
    const a = bodies.get(pair.a);
    const b = bodies.get(pair.b);
    return a && b ? [refineCollision(a, b)] : [];
  });
}
