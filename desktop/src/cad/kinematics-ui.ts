// 运动学标注 UI：把 STEP 网格人工绑定到轴/行程/点位，并用滑块预览。
// 边界：机构识别在 kinematics-auto.ts，这里只展示「建议」并在用户逐条点「采纳」后加入动件列表；
// 采纳后仍需「保存标注」，校验规则与人工标注完全相同。纯函数只做数据整形、校验与姿态解算，便于单测。

import {
  axisPose,
  checkKinematics,
  type AxisPose,
  type KinematicsAxis,
  type KinematicsAxisName,
  type KinematicsCheck,
  type KinematicsDoc,
  type KinematicsIssue,
  type KinematicsKind,
  type KinematicsRole
} from './kinematics.ts';
import type { CadViewer } from './viewer';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import {
  acceptSuggestions,
  CATEGORY_LABELS,
  describeSuggestions,
  suggestKinematics,
  type AutoKinMesh,
  type KinematicsSuggestion,
  type SuggestResult
} from './kinematics-auto.ts';
import type { MachineConfig } from '../commission/machine-config.ts';

export const KINEMATICS_STORAGE_KEY = 'automationcad.kinematics.v1';
export const KINEMATICS_STORAGE_VERSION = 1;

export interface KinematicsMeshInfo {
  /** 当前 CadViewer 中的临时索引；不作为跨重导入的身份。 */
  id: number;
  /** 从源字节、装配路径、名称与几何摘要派生的候选稳定标识；歧义对象不提供此字段。 */
  stableObjectId?: string;
  name: string;
  triangles: number;
  center: [number, number, number];
  size: [number, number, number];
}

export interface MovingPart {
  id: string;
  name: string;
  meshIds: number[];
  meshNames: string[];
  /** 与 meshIds 一一对应的稳定 CAD 对象 ID；缺失时不得自动跨导入恢复。 */
  meshObjectIds?: string[];
  /** 合并后网格的包围盒中心，作为初始位置/旋转枢轴。 */
  center: [number, number, number];
  size: [number, number, number];
  kind: KinematicsKind;
  axis: KinematicsAxisName;
  direction: 1 | -1;
  /** 直线轴：行程 mm；旋转轴忽略。 */
  travelMm: number;
  /** 直线轴：缩回位置 mm。 */
  retractedMm: number;
  /** 旋转轴：有符号行程角度，-360..360 且非 0。 */
  rangeDeg: number;
  /** 旋转轴：缩回角度。 */
  retractedDeg: number;
  /** 绑定点位；空字符串表示未绑定。 */
  point: string;
  /** 点位在 MachineConfig 中对应的角色。 */
  role: KinematicsRole | '';
}

export interface KinematicsAnnotation {
  version: 1 | 2;
  sourceFile: string;
  /** v2 必填；将此标注绑定到持久工程身份。 */
  projectId?: string;
  parts: MovingPart[];
  updatedAt?: string;
}

export interface KinematicsPointOption {
  point: string;
  role: KinematicsRole;
  actuatorId: string;
  actuatorName: string;
  label: string;
}

export interface KinematicsValidateOptions {
  pointOptions?: readonly KinematicsPointOption[];
  maxTravelMm?: number;
  maxRangeDeg?: number;
  meshes?: readonly KinematicsMeshInfo[];
}

export interface DraftValidation {
  annotation: KinematicsAnnotation;
  doc: KinematicsDoc;
  check: KinematicsCheck;
  issues: KinematicsIssue[];
  errors: KinematicsIssue[];
  warnings: KinematicsIssue[];
  ok: boolean;
}

export interface SlidePose {
  percent: number;
  amount: number;
  unit: 'mm' | 'deg';
  offset: [number, number, number];
  rotationRad: number;
  source: AxisPose['source'];
}

export interface AnnotationParseResult {
  ok: boolean;
  annotation: KinematicsAnnotation | null;
  issues: KinematicsIssue[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KinematicsStore {
  get(sourceFile: string): KinematicsAnnotation | null;
  set(sourceFile: string, annotation: KinematicsAnnotation): void;
  remove(sourceFile: string): void;
  files(): string[];
}

type PartOverrides = Partial<Omit<MovingPart, 'meshIds' | 'meshNames' | 'meshObjectIds' | 'center' | 'size'>>;

let partSerial = 0;

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asVec3(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [0, 0, 0];
  return [asNumber(value[0]), asNumber(value[1]), asNumber(value[2])];
}

function clonePart(part: MovingPart): MovingPart {
  return {
    ...part,
    meshIds: [...part.meshIds],
    meshNames: [...part.meshNames],
    ...(part.meshObjectIds ? { meshObjectIds: [...part.meshObjectIds] } : {}),
    center: [...part.center] as [number, number, number],
    size: [...part.size] as [number, number, number]
  };
}

function defaultRole(kind: KinematicsKind): KinematicsRole {
  return kind === 'rotary' ? 'rotate' : 'extend';
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function uniquePartId(): string {
  partSerial += 1;
  return `mp-${Date.now().toString(36)}-${partSerial}`;
}

export function emptyMovingPart(overrides: PartOverrides = {}): MovingPart {
  return {
    id: overrides.id ?? uniquePartId(),
    name: overrides.name ?? '未命名动件',
    meshIds: [],
    meshNames: [],
    center: [0, 0, 0],
    size: [0, 0, 0],
    kind: overrides.kind ?? 'linear',
    axis: overrides.axis ?? 'z',
    direction: overrides.direction ?? 1,
    travelMm: overrides.travelMm ?? 0,
    retractedMm: overrides.retractedMm ?? 0,
    rangeDeg: overrides.rangeDeg ?? 0,
    retractedDeg: overrides.retractedDeg ?? 0,
    point: overrides.point ?? '',
    role: overrides.role ?? ''
  };
}

/** 单个网格 → 动件草稿（默认直线 Z 轴，行程/点位待用户填写）。 */
export function draftFromMesh(mesh: KinematicsMeshInfo, overrides: PartOverrides = {}): MovingPart {
  return {
    ...emptyMovingPart(overrides),
    name: overrides.name ?? mesh.name,
    meshIds: [mesh.id],
    meshNames: [mesh.name],
    ...(mesh.stableObjectId ? { meshObjectIds: [mesh.stableObjectId] } : {}),
    center: [...mesh.center] as [number, number, number],
    size: [...mesh.size] as [number, number, number]
  };
}

/** 多选网格合并为一个动件，记录 meshIds 与合并包围盒中心。 */
export function draftFromMeshes(
  meshes: readonly KinematicsMeshInfo[],
  overrides: PartOverrides = {}
): MovingPart {
  if (meshes.length === 0) throw new Error('请至少选择一个网格');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let axis = 0; axis < 3; axis += 1) {
      const half = (mesh.size[axis] ?? 0) / 2;
      min[axis] = Math.min(min[axis]!, mesh.center[axis]! - half);
      max[axis] = Math.max(max[axis]!, mesh.center[axis]! + half);
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  ];
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const firstName = meshes[0]!.name;
  const name = overrides.name ?? (meshes.length === 1 ? firstName : `${firstName} 等 ${meshes.length} 件`);
  return {
    ...emptyMovingPart({ ...overrides, name }),
    meshIds: meshes.map((mesh) => mesh.id),
    meshNames: meshes.map((mesh) => mesh.name),
    ...(meshes.every((mesh) => !!mesh.stableObjectId)
      ? { meshObjectIds: meshes.map((mesh) => mesh.stableObjectId!) }
      : {}),
    center,
    size
  };
}

export function pointOptionsFromMachineConfig(config: MachineConfig | null | undefined): KinematicsPointOption[] {
  if (!config) return [];
  const options: KinematicsPointOption[] = [];
  const seen = new Set<string>();
  const add = (actuatorId: string, actuatorName: string, point: string | undefined, role: KinematicsRole, label: string): void => {
    if (!point || seen.has(point.toUpperCase())) return;
    seen.add(point.toUpperCase());
    options.push({ point, role, actuatorId, actuatorName, label: `${point} · ${actuatorName} · ${label}` });
  };
  for (const actuator of config.actuators) {
    add(actuator.id, actuator.name, actuator.extendPoint, 'extend', '伸出');
    add(actuator.id, actuator.name, actuator.retractPoint, 'retract', '缩回');
    if (actuator.kind === 'rotary') add(actuator.id, actuator.name, actuator.point, 'rotate', '旋转');
    else add(actuator.id, actuator.name, actuator.gripPoint, 'extend', '夹紧');
    if (actuator.kind !== 'rotary') add(actuator.id, actuator.name, actuator.point, 'extend', '动作');
  }
  return options;
}

export function roleForPoint(options: readonly KinematicsPointOption[], point: string): KinematicsRole | '' {
  const key = point.trim().toUpperCase();
  if (!key) return '';
  return options.find((option) => option.point.trim().toUpperCase() === key)?.role ?? '';
}

/** 把 UI 动件映射成数据层的 KinematicsAxis，供 checkKinematics/axisPose 复用。 */
export function partToAxis(part: MovingPart): KinematicsAxis {
  const point = part.point.trim();
  const role = part.role || defaultRole(part.kind);
  const bindings = point ? [{ role, point }] : [];
  const direction: 1 | -1 = part.direction === -1 ? -1 : 1;
  if (part.kind === 'rotary') {
    const sign: 1 | -1 = part.rangeDeg < 0 ? -1 : 1;
    return {
      part: part.name,
      kind: 'rotary',
      axis: part.axis,
      rangeDeg: Math.abs(part.rangeDeg),
      direction: (direction * sign) as 1 | -1,
      bindings
    };
  }
  return {
    part: part.name,
    kind: 'linear',
    axis: part.axis,
    travelMm: part.travelMm,
    retractedMm: part.retractedMm,
    direction,
    bindings
  };
}

export function annotationFromParts(sourceFile: string, parts: readonly MovingPart[], projectId?: string): KinematicsAnnotation {
  const stableBinding = !!projectId && parts.every((part) =>
    Array.isArray(part.meshObjectIds) && part.meshObjectIds.length === part.meshIds.length
      && part.meshObjectIds.every((id) => /^cadobj-[a-f0-9]{64}$/.test(id))
  );
  return {
    version: stableBinding ? 2 : 1,
    sourceFile: sourceFile.trim(),
    ...(stableBinding ? { projectId } : {}),
    parts: parts.map(clonePart)
  };
}

export interface KinematicsRemapResult {
  ok: boolean;
  annotation: KinematicsAnnotation | null;
  reason?: string;
}

/** Rebind v2 annotation references by stable object ID; legacy index-only data is never auto-applied. */
export function remapKinematicsAnnotation(
  annotation: KinematicsAnnotation,
  projectId: string,
  meshes: readonly KinematicsMeshInfo[]
): KinematicsRemapResult {
  if (annotation.version !== 2 || annotation.projectId !== projectId) {
    return { ok: false, annotation: null, reason: '运动学标注没有匹配的持久工程 ID 与稳定对象映射' };
  }
  const indexByObjectId = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const mesh of meshes) {
    const id = mesh.stableObjectId;
    if (!id) continue;
    if (indexByObjectId.has(id)) duplicates.add(id);
    else indexByObjectId.set(id, mesh.id);
  }
  if (duplicates.size > 0) for (const id of duplicates) indexByObjectId.delete(id);
  const remapped: MovingPart[] = [];
  for (const part of annotation.parts) {
    const objectIds = part.meshObjectIds;
    if (!objectIds || objectIds.length === 0 || objectIds.length !== part.meshIds.length) {
      return { ok: false, annotation: null, reason: `动件「${part.name}」缺少完整稳定对象映射` };
    }
    const nextIds = objectIds.map((id) => indexByObjectId.get(id));
    if (nextIds.some((id) => id === undefined)) {
      return { ok: false, annotation: null, reason: `动件「${part.name}」引用的 CAD 对象缺失或存在歧义` };
    }
    remapped.push({ ...clonePart(part), meshIds: nextIds as number[] });
  }
  return {
    ok: true,
    annotation: { ...annotation, sourceFile: annotation.sourceFile, projectId, parts: remapped }
  };
}

export function validateDraft(
  partsOrAnnotation: readonly MovingPart[] | KinematicsAnnotation,
  options: KinematicsValidateOptions = {}
): DraftValidation {
  const isPartArray = Array.isArray(partsOrAnnotation);
  const parts: readonly MovingPart[] = isPartArray
    ? (partsOrAnnotation as readonly MovingPart[])
    : (partsOrAnnotation as KinematicsAnnotation).parts;
  const sourceFile = isPartArray ? '' : (partsOrAnnotation as KinematicsAnnotation).sourceFile;
  const annotation = annotationFromParts(sourceFile, parts);
  const doc: KinematicsDoc = {
    schemaVersion: 1,
    units: 'mm',
    axes: parts.map(partToAxis)
  };
  const knownPoints = options.pointOptions?.map((option) => option.point);
  const check = checkKinematics(doc, {
    ...(knownPoints ? { knownPoints } : {}),
    ...(options.maxTravelMm !== undefined ? { maxTravelMm: options.maxTravelMm } : {}),
    maxRangeDeg: options.maxRangeDeg ?? 360
  });
  const issues: KinematicsIssue[] = [...check.issues];
  const meshes = options.meshes;
  if (meshes) {
    const known = new Set(meshes.map((mesh) => mesh.id));
    for (const part of parts) {
      if (part.meshIds.length === 0) {
        issues.push({ code: 'part.mesh.empty', level: 'error', message: `动件「${part.name}」没有关联网格`, part: part.name });
      } else {
        const missing = part.meshIds.filter((id) => !known.has(id));
        if (missing.length > 0) {
          issues.push({
            code: 'part.mesh.missing',
            level: 'error',
            message: `动件「${part.name}」引用了不存在的网格：${missing.join(', ')}`,
            part: part.name
          });
        }
      }
      if (part.kind === 'rotary' && Math.abs(part.retractedDeg) > 360) {
        issues.push({
          code: 'part.retractedDeg.range',
          level: 'error',
          message: `旋转动件「${part.name}」缩回角度必须在 -360° ~ 360° 之间`,
          part: part.name
        });
      }
    }
  }
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  return {
    annotation,
    doc: check.doc,
    check,
    issues,
    errors,
    warnings,
    ok: errors.length === 0
  };
}

/**
 * 滑块预览：0% = 缩回位，100% = 行程终点。
 * 直线用 axisPose 的伸缩姿态取轴单位方向；旋转用 axisPose 的角度量程做插值。
 */
export function applySlide(part: MovingPart, percent: number): SlidePose {
  const ratio = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) / 100;
  const axis = partToAxis(part);
  const direction: 1 | -1 = part.direction === -1 ? -1 : 1;
  if (part.kind === 'linear') {
    const extendPoint = part.point.trim();
    const idle = axisPose(axis, {});
    const full = axisPose(axis, extendPoint ? { [extendPoint]: true } : {});
    const from = Number.isFinite(part.retractedMm) ? part.retractedMm : 0;
    const to = Number.isFinite(part.travelMm) ? part.travelMm : from;
    const amount = from + (to - from) * ratio;
    const distance = Math.abs(full.amount - idle.amount);
    const unit: [number, number, number] =
      distance > 0 && Math.abs(full.amount) > 0
        ? [full.offset[0] / full.amount, full.offset[1] / full.amount, full.offset[2] / full.amount]
        : [0, 0, 0];
    return {
      percent: ratio * 100,
      amount,
      unit: 'mm',
      offset: [unit[0] * amount, unit[1] * amount, unit[2] * amount],
      rotationRad: 0,
      source: ratio > 0 ? 'extend' : 'idle'
    };
  }
  const rotatePoint = part.point.trim();
  const full = axisPose(axis, rotatePoint ? { [rotatePoint]: true } : {});
  const signedRange = full.rotationRad * direction * (part.rangeDeg < 0 ? -1 : 1);
  const start = Number.isFinite(part.retractedDeg) ? (part.retractedDeg * Math.PI) / 180 : 0;
  const rotationRad = start + signedRange * ratio;
  return {
    percent: ratio * 100,
    amount: (rotationRad * 180) / Math.PI,
    unit: 'deg',
    offset: [0, 0, 0],
    rotationRad,
    source: ratio > 0 ? 'rotate' : 'idle'
  };
}

export function serializeAnnotation(annotation: KinematicsAnnotation): string {
  if (annotation.version === 2) {
    if (!annotation.projectId || !/^acproj-[0-9a-f-]{36}$/i.test(annotation.projectId)) {
      throw new Error('运动学标注 v2 缺少有效 projectId');
    }
    if (annotation.parts.some((part) => !part.meshObjectIds || part.meshObjectIds.length !== part.meshIds.length)) {
      throw new Error('运动学标注 v2 缺少完整稳定对象映射');
    }
  }
  return `${JSON.stringify(
    {
      version: annotation.version,
      sourceFile: annotation.sourceFile,
      ...(annotation.version === 2 ? { projectId: annotation.projectId } : {}),
      parts: annotation.parts.map((part) => ({
        id: part.id,
        name: part.name,
        meshIds: [...part.meshIds],
        meshNames: [...part.meshNames],
        ...(annotation.version === 2 ? { meshObjectIds: [...(part.meshObjectIds ?? [])] } : {}),
        center: [...part.center],
        size: [...part.size],
        kind: part.kind,
        axis: part.axis,
        direction: part.direction,
        travelMm: part.travelMm,
        retractedMm: part.retractedMm,
        rangeDeg: part.rangeDeg,
        retractedDeg: part.retractedDeg,
        point: part.point,
        role: part.role
      }))
    },
    null,
    2
  )}\n`;
}

export function deserializeAnnotation(text: string): AnnotationParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    const issue: KinematicsIssue = { code: 'json.invalid', level: 'error', message: '运动学标注不是合法 JSON' };
    return { ok: false, annotation: null, issues: [issue] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const issue: KinematicsIssue = { code: 'json.shape', level: 'error', message: '运动学标注必须是对象' };
    return { ok: false, annotation: null, issues: [issue] };
  }
  const record = raw as Record<string, unknown>;
  const issues: KinematicsIssue[] = [];
  if (record.version !== 1 && record.version !== 2) {
    issues.push({ code: 'json.version', level: 'error', message: '运动学标注 version 必须为 1 或 2' });
  }
  if (record.version === 2 && (typeof record.projectId !== 'string' || !/^acproj-[0-9a-f-]{36}$/i.test(record.projectId))) {
    issues.push({ code: 'json.projectId', level: 'error', message: '运动学标注 v2 缺少有效 projectId' });
  }
  if (typeof record.sourceFile !== 'string') {
    issues.push({ code: 'json.sourceFile', level: 'error', message: '缺少必填参数：sourceFile' });
  }
  if (!Array.isArray(record.parts)) {
    issues.push({ code: 'json.parts', level: 'error', message: '缺少必填参数：parts' });
    return { ok: false, annotation: null, issues };
  }
  const parts: MovingPart[] = [];
  record.parts.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({ code: 'part.invalid', level: 'error', message: `parts[${index}] 必须是对象` });
      return;
    }
    const rawPart = item as Record<string, unknown>;
    const kind = rawPart.kind;
    const axis = rawPart.axis;
    if (kind !== 'linear' && kind !== 'rotary') {
      issues.push({ code: 'part.kind', level: 'error', message: `parts[${index}] 的 kind 必须是 linear 或 rotary` });
    }
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      issues.push({ code: 'part.axis', level: 'error', message: `parts[${index}] 的 axis 必须是 x、y 或 z` });
    }
    const name = typeof rawPart.name === 'string' ? rawPart.name.trim() : '';
    if (!name) issues.push({ code: 'part.name', level: 'error', message: `缺少必填参数：parts[${index}].name` });
    const meshIds = Array.isArray(rawPart.meshIds)
      ? rawPart.meshIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : [];
    if (!Array.isArray(rawPart.meshIds) || meshIds.length === 0) {
      issues.push({ code: 'part.meshIds', level: 'error', message: `缺少必填参数：动件「${name || index + 1}」的 meshIds` });
    }
    const meshObjectIds = Array.isArray(rawPart.meshObjectIds)
      ? rawPart.meshObjectIds.filter((id): id is string => typeof id === 'string' && /^cadobj-[a-f0-9]{64}$/.test(id))
      : [];
    if (record.version === 2 && (!Array.isArray(rawPart.meshObjectIds)
      || meshObjectIds.length !== meshIds.length
      || meshObjectIds.length === 0)) {
      issues.push({ code: 'part.meshObjectIds', level: 'error', message: `运动学标注 v2 的动件「${name || index + 1}」缺少完整稳定对象 ID` });
    }
    const direction = rawPart.direction === -1 ? -1 : 1;
    const role = rawPart.role;
    parts.push({
      id: typeof rawPart.id === 'string' && rawPart.id.trim() ? rawPart.id : `mp-import-${index + 1}`,
      name: name || `未命名动件 ${index + 1}`,
      meshIds,
      meshNames: Array.isArray(rawPart.meshNames)
        ? rawPart.meshNames.filter((entry): entry is string => typeof entry === 'string')
        : [],
      ...(record.version === 2 ? { meshObjectIds } : {}),
      center: asVec3(rawPart.center),
      size: asVec3(rawPart.size),
      kind: kind === 'rotary' ? 'rotary' : 'linear',
      axis: axis === 'x' || axis === 'y' ? axis : 'z',
      direction,
      travelMm: asNumber(rawPart.travelMm),
      retractedMm: asNumber(rawPart.retractedMm),
      rangeDeg: asNumber(rawPart.rangeDeg),
      retractedDeg: asNumber(rawPart.retractedDeg),
      point: typeof rawPart.point === 'string' ? rawPart.point.trim() : '',
      role: role === 'extend' || role === 'retract' || role === 'rotate' ? role : ''
    });
  });
  const annotation: KinematicsAnnotation = {
    version: record.version === 2 ? 2 : 1,
    sourceFile: typeof record.sourceFile === 'string' ? record.sourceFile : '',
    ...(record.version === 2 && typeof record.projectId === 'string' ? { projectId: record.projectId } : {}),
    parts
  };
  return { ok: issues.length === 0, annotation, issues };
}

interface KinematicsBucket {
  version: 1;
  files: Record<string, KinematicsAnnotation>;
}

function emptyBucket(): KinematicsBucket {
  return { version: 1, files: {} };
}

function readBucket(store: StorageLike): KinematicsBucket {
  try {
    const text = store.getItem(KINEMATICS_STORAGE_KEY);
    if (!text) return emptyBucket();
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyBucket();
    const record = parsed as Record<string, unknown>;
    if (record.version !== KINEMATICS_STORAGE_VERSION || typeof record.files !== 'object' || record.files === null) {
      return emptyBucket();
    }
    return { version: 1, files: record.files as Record<string, KinematicsAnnotation> };
  } catch {
    return emptyBucket();
  }
}

function fileKey(sourceFile: string): string {
  return sourceFile.trim();
}

/** 按文件名分桶的 localStorage 封装；测试可注入内存 StorageLike。 */
export function createKinematicsStore(storage: StorageLike): KinematicsStore {
  return {
    get(sourceFile: string): KinematicsAnnotation | null {
      const key = fileKey(sourceFile);
      if (!key) return null;
      const entry = readBucket(storage).files[key];
      if (!entry || !Array.isArray(entry.parts)) return null;
      const version = entry.version === 2 ? 2 : 1;
      return {
        ...entry,
        version,
        sourceFile: typeof entry.sourceFile === 'string' ? entry.sourceFile : key,
        ...(version === 2 && typeof entry.projectId === 'string' ? { projectId: entry.projectId } : {}),
        parts: entry.parts.map(clonePart)
      };
    },
    set(sourceFile: string, annotation: KinematicsAnnotation): void {
      const key = fileKey(sourceFile);
      if (!key) throw new Error('保存运动学标注前需要先导入 CAD 文件');
      const bucket = readBucket(storage);
      bucket.files[key] = {
        ...annotation,
        version: annotation.version,
        sourceFile: annotation.sourceFile,
        ...(annotation.version === 2 ? { projectId: annotation.projectId } : {}),
        parts: annotation.parts.map(clonePart)
      };
      storage.setItem(KINEMATICS_STORAGE_KEY, JSON.stringify(bucket));
    },
    remove(sourceFile: string): void {
      const key = fileKey(sourceFile);
      if (!key) return;
      const bucket = readBucket(storage);
      delete bucket.files[key];
      storage.setItem(KINEMATICS_STORAGE_KEY, JSON.stringify(bucket));
    },
    files(): string[] {
      return Object.keys(readBucket(storage).files).sort();
    }
  };
}

export interface KinematicsUiOptions {
  container: HTMLElement;
  viewer: CadViewer;
  getPointOptions: () => readonly KinematicsPointOption[];
  onChange?: (annotation: KinematicsAnnotation, validation: DraftValidation) => void;
  onOpenChange?: (open: boolean) => void;
  storage?: StorageLike;
  notify?: (message: string, error?: boolean) => void;
  /** 自动识别用几何（网格 + 装配路径 + 顶点）；缺省时不显示识别结果。 */
  getGeometry?: () => readonly AutoKinMesh[];
}

export interface KinematicsUiState {
  sourceFile: string;
  meshes: KinematicsMeshInfo[];
  /** 网格树里当前勾选的网格（供 Agent 上下文采集）。 */
  selectedMeshes: KinematicsMeshInfo[];
  parts: MovingPart[];
  errors: number;
  warnings: number;
  ok: boolean;
  /** 待确认的自动识别建议（高 / 低置信度）。 */
  suggestions: { high: number; low: number; skipped: number };
}

export interface KinematicsUiHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  setSource(sourceFile: string, meshes: readonly KinematicsMeshInfo[], projectId?: string, projectStorageKey?: string): void;
  getAnnotation(): KinematicsAnnotation;
  getValidation(): DraftValidation;
  addMovingPart(meshIds: readonly number[], name?: string): string;
  updatePart(id: string, patch: Partial<MovingPart>): void;
  slide(id: string, percent: number): SlidePose | null;
  save(): boolean;
  state(): KinematicsUiState;
  /** 重新识别并刷新建议列表；只展示，不写入动件。 */
  suggest(): SuggestResult;
  /** 当前建议（含已忽略/已采纳后的剩余项）。 */
  suggestions(): SuggestResult;
  /** 用户确认采纳一条建议：加入动件列表（未保存），返回新动件 id；找不到返回 null。 */
  acceptSuggestion(id: string): string | null;
  dismissSuggestion(id: string): void;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] ?? character;
  });
}

function axisValue(part: MovingPart): string {
  return `${part.direction === -1 ? '-' : '+'}${part.axis.toUpperCase()}`;
}

function parseAxisValue(value: string): { axis: KinematicsAxisName; direction: 1 | -1 } {
  const normalized = value.trim().toUpperCase();
  const axis = normalized.replace(/[+-]/g, '').toLowerCase();
  return {
    axis: axis === 'x' || axis === 'y' ? axis : 'z',
    direction: normalized.startsWith('-') ? -1 : 1
  };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (error) {
    console.debug('[KINEMATICS_STORAGE_UNAVAILABLE]', { site: 'desktop/src/cad/kinematics-ui.ts' }, error);
    return null;
  }
}

export function initKinematicsUi(options: KinematicsUiOptions): KinematicsUiHandle {
  const storage = options.storage ?? defaultStorage();
  const store = storage ? createKinematicsStore(storage) : null;
  const { container, viewer } = options;
  let sourceFile = '';
  let projectId = '';
  let storageKey = '';
  let meshes: KinematicsMeshInfo[] = [];
  let parts: MovingPart[] = [];
  let selected = new Set<number>();
  const slides = new Map<string, number>();
  let validation: DraftValidation = validateDraft([], { meshes: [] });
  const emptySuggest = (): SuggestResult => ({
    suggestions: [],
    lowConfidence: [],
    skipped: [],
    stats: { meshes: 0, classified: 0, groups: 0, high: 0, low: 0, skipped: 0 }
  });
  let suggestResult: SuggestResult = emptySuggest();

  container.classList.add('cad-kinematics-drawer');
  container.innerHTML = `
    <header class="cad-kin-head">
      <div class="cad-kin-title">
        <b>运动学标注</b>
        <span data-kin-source>未加载文件</span>
      </div>
      <button type="button" class="cad-kin-icon" data-kin-close aria-label="收起运动学标注">×</button>
    </header>
    <div class="cad-kin-body">
      <div class="cad-kin-alert" data-kin-alert hidden></div>
      <section class="cad-kin-section">
        <div class="cad-kin-section-head"><span>网格树</span><b data-kin-mesh-count>0</b></div>
        <div class="cad-kin-meshes" data-kin-meshes></div>
        <div class="cad-kin-actions">
          <button type="button" class="cad-btn cad-btn-primary" data-kin-add disabled>设为动件</button>
          <button type="button" class="cad-btn" data-kin-clear>清空选择</button>
        </div>
      </section>
      <section class="cad-kin-section" data-kin-suggest-section>
        <div class="cad-kin-section-head"><span>自动识别建议</span><b data-kin-suggest-count>0</b></div>
        <div class="cad-kin-actions">
          <button type="button" class="cad-btn" data-kin-suggest>识别动件</button>
        </div>
        <div class="cad-kin-hint cad-kin-suggest-note" data-kin-suggest-note>建议不会自动写入：逐条「采纳」后进入动件列表，仍需校验通过并保存。</div>
        <div class="cad-kin-suggests" data-kin-suggests></div>
        <details class="cad-kin-suggest-low" data-kin-suggest-low hidden>
          <summary>低置信度建议 <b data-kin-suggest-low-count>0</b></summary>
          <div class="cad-kin-suggests" data-kin-suggests-low></div>
        </details>
      </section>
      <section class="cad-kin-section">
        <div class="cad-kin-section-head"><span>动件列表</span><b data-kin-part-count>0</b></div>
        <div class="cad-kin-parts" data-kin-parts></div>
      </section>
      <section class="cad-kin-section">
        <div class="cad-kin-section-head"><span>校验</span><b data-kin-issue-count>0</b></div>
        <div class="cad-kin-issues" data-kin-issues></div>
      </section>
    </div>
    <footer class="cad-kin-foot">
      <button type="button" class="cad-btn cad-btn-primary" data-kin-save disabled>保存标注</button>
      <button type="button" class="cad-btn" data-kin-export>导出 JSON</button>
      <button type="button" class="cad-btn" data-kin-import>导入 JSON</button>
      <input type="file" accept="application/json,.json" data-kin-file hidden>
    </footer>`;

  const query = <T extends HTMLElement>(selector: string): T => {
    const node = container.querySelector<T>(selector);
    if (!node) throw new Error(`运动学标注节点缺失：${selector}`);
    return node;
  };
  const sourceLabel = query<HTMLElement>('[data-kin-source]');
  const alert = query<HTMLElement>('[data-kin-alert]');
  const meshList = query<HTMLElement>('[data-kin-meshes]');
  const meshCount = query<HTMLElement>('[data-kin-mesh-count]');
  const partList = query<HTMLElement>('[data-kin-parts]');
  const partCount = query<HTMLElement>('[data-kin-part-count]');
  const issueList = query<HTMLElement>('[data-kin-issues]');
  const issueCount = query<HTMLElement>('[data-kin-issue-count]');
  const addButton = query<HTMLButtonElement>('[data-kin-add]');
  const saveButton = query<HTMLButtonElement>('[data-kin-save]');
  const fileInput = query<HTMLInputElement>('[data-kin-file]');
  const suggestCount = query<HTMLElement>('[data-kin-suggest-count]');
  const suggestNote = query<HTMLElement>('[data-kin-suggest-note]');
  const suggestList = query<HTMLElement>('[data-kin-suggests]');
  const suggestLow = query<HTMLDetailsElement>('[data-kin-suggest-low]');
  const suggestLowCount = query<HTMLElement>('[data-kin-suggest-low-count]');
  const suggestLowList = query<HTMLElement>('[data-kin-suggests-low]');

  const notify = (message: string, error = false): void => options.notify?.(message, error);

  const pointOptions = (): readonly KinematicsPointOption[] => options.getPointOptions();

  const annotation = (): KinematicsAnnotation => {
    const current = annotationFromParts(sourceFile, parts, projectId || undefined);
    return current.parts.length > 0 ? { ...current, updatedAt: new Date().toISOString() } : current;
  };

  const emit = (): void => {
    options.onChange?.(annotation(), validation);
  };

  const applyPose = (part: MovingPart, percent: number): SlidePose => {
    const pose = applySlide(part, percent);
    viewer.setKinematicsPose(part.meshIds, { offset: pose.offset, rotationRad: pose.rotationRad, axis: part.axis }, part.center);
    return pose;
  };

  const currentValidation = (): DraftValidation =>
    validateDraft(parts, { pointOptions: pointOptions(), meshes });

  const refreshValidation = (): void => {
    validation = currentValidation();
    if (validation.errors.length > 0) {
      alert.hidden = false;
      alert.dataset.state = 'error';
      alert.textContent = `${validation.errors.length} 项未通过，无法保存`;
    } else if (validation.warnings.length > 0) {
      alert.hidden = false;
      alert.dataset.state = 'warn';
      alert.textContent = `${validation.warnings.length} 项警告，可保存但建议确认`;
    } else {
      alert.hidden = true;
      alert.textContent = '';
      delete alert.dataset.state;
    }
    saveButton.disabled = !validation.ok;
    issueCount.textContent = String(validation.issues.length);
    issueList.innerHTML =
      validation.issues.length === 0
        ? '<div class="cad-kin-empty">标注自洽，可保存。</div>'
        : validation.issues
            .map(
              (issue) => `<div class="cad-kin-issue" data-level="${issue.level}">
                <b>${issue.level === 'error' ? '错误' : '警告'}</b>
                <span>${escapeHtml(issue.message)}</span>
              </div>`
            )
            .join('');
    emit();
  };

  const partCard = (part: MovingPart): string => {
    const isRotary = part.kind === 'rotary';
    const strokeLabel = isRotary ? '行程角度' : '行程';
    const strokeUnit = isRotary ? '°' : 'mm';
    const retractLabel = isRotary ? '缩回角度' : '缩回位置';
    const optionsHtml = pointOptions()
      .map(
        (option) =>
          `<option value="${escapeHtml(option.point)}"${option.point.toUpperCase() === part.point.toUpperCase() ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
      )
      .join('');
    const emptyHint =
      pointOptions().length === 0
        ? '<div class="cad-kin-hint">先在联调里加载机型配置，才有可绑定的点位。</div>'
        : '';
    return `<article class="cad-kin-card" data-kin-part="${escapeHtml(part.id)}">
      <header class="cad-kin-card-head">
        <input class="cad-kin-name" data-kin-field="name" value="${escapeHtml(part.name)}" aria-label="动件名称">
        <button type="button" class="cad-kin-del" data-kin-delete aria-label="删除动件">删除</button>
      </header>
      <div class="cad-kin-meta">网格 ${part.meshIds.length} 个 · ${escapeHtml(part.meshNames.join('、') || '—')}</div>
      <div class="cad-kin-grid">
        <label class="cad-kin-field"><span>轴类型</span><select data-kin-field="kind">
          <option value="linear"${!isRotary ? ' selected' : ''}>直线</option>
          <option value="rotary"${isRotary ? ' selected' : ''}>旋转</option>
        </select></label>
        <label class="cad-kin-field"><span>轴方向</span><select data-kin-field="axis">
          ${['+X', '-X', '+Y', '-Y', '+Z', '-Z']
            .map((value) => `<option value="${value}"${axisValue(part) === value ? ' selected' : ''}>${value}</option>`)
            .join('')}
        </select></label>
        <label class="cad-kin-field"><span>${strokeLabel} (${strokeUnit})</span><input type="number" step="0.1" data-kin-field="${isRotary ? 'rangeDeg' : 'travelMm'}" value="${isRotary ? part.rangeDeg : part.travelMm}"></label>
        <label class="cad-kin-field"><span>${retractLabel} (${strokeUnit})</span><input type="number" step="0.1" data-kin-field="${isRotary ? 'retractedDeg' : 'retractedMm'}" value="${isRotary ? part.retractedDeg : part.retractedMm}"></label>
        <label class="cad-kin-field cad-kin-field-wide"><span>绑定点位</span><select data-kin-field="point">
          <option value="">未绑定</option>
          ${optionsHtml}
        </select></label>
      </div>
      ${emptyHint}
      <div class="cad-kin-slide">
        <input type="range" min="0" max="100" step="1" value="${slides.get(part.id) ?? 0}" data-kin-slide aria-label="${escapeHtml(part.name)} 行程预览">
        <output data-kin-output>${Math.round(slides.get(part.id) ?? 0)}%</output>
        <button type="button" class="cad-kin-reset" data-kin-reset>复位</button>
      </div>
    </article>`;
  };

  const renderMeshes = (): void => {
    meshCount.textContent = String(meshes.length);
    meshList.innerHTML =
      meshes.length === 0
        ? '<div class="cad-kin-empty">先导入 STEP 装配体，网格会列在这里。</div>'
        : meshes
            .map(
              (mesh) => `<label class="cad-kin-mesh">
                <input type="checkbox" data-kin-mesh="${mesh.id}"${selected.has(mesh.id) ? ' checked' : ''}>
                <span class="cad-kin-mesh-name">${escapeHtml(mesh.name)}</span>
                <span class="cad-kin-mesh-tris">${mesh.triangles.toLocaleString('zh-CN')} 面</span>
              </label>`
            )
            .join('');
    addButton.disabled = selected.size === 0;
  };

  const renderParts = (): void => {
    partCount.textContent = String(parts.length);
    partList.innerHTML =
      parts.length === 0
        ? '<div class="cad-kin-empty">在网格树中多选网格，点击「设为动件」开始标注。</div>'
        : parts.map(partCard).join('');
    for (const part of parts) applyPose(part, slides.get(part.id) ?? 0);
  };

  const suggestionCard = (item: KinematicsSuggestion): string => {
    const motion =
      item.kind === 'rotary'
        ? `旋转 · 绕 ${item.direction < 0 ? '-' : '+'}${item.axis.toUpperCase()} · ${item.rangeDeg}°`
        : `直线 · ${item.direction < 0 ? '-' : '+'}${item.axis.toUpperCase()} · 行程 ${item.travelMm > 0 ? `${item.travelMm} mm` : '待填写'} · 缩回 ${item.retractedMm} mm`;
    const vector = item.directionVector.map((value) => value.toFixed(2)).join(', ');
    return `<article class="cad-kin-suggest" data-kin-suggest-id="${escapeHtml(item.id)}" data-level="${item.level}">
      <header class="cad-kin-suggest-head">
        <b>${escapeHtml(item.name)}</b>
        <span class="cad-kin-suggest-conf" title="置信度">${Math.round(item.confidence * 100)}%</span>
      </header>
      <div class="cad-kin-meta">${escapeHtml(CATEGORY_LABELS[item.category])} · ${escapeHtml(motion)} · 方向 (${vector})</div>
      <div class="cad-kin-meta">动件网格：${escapeHtml(item.meshNames.join('、'))} · 点位：${escapeHtml(item.point || '未匹配')}</div>
      <p class="cad-kin-suggest-reason">${escapeHtml(item.reason)}</p>
      <div class="cad-kin-actions">
        <button type="button" class="cad-btn cad-btn-primary" data-kin-accept>采纳</button>
        <button type="button" class="cad-btn" data-kin-dismiss>忽略</button>
      </div>
    </article>`;
  };

  const renderSuggestions = (): void => {
    const high = suggestResult.suggestions;
    const low = suggestResult.lowConfidence;
    suggestCount.textContent = String(high.length + low.length);
    suggestList.innerHTML =
      high.length === 0
        ? `<div class="cad-kin-empty">${options.getGeometry ? (meshes.length === 0 ? '导入 STEP 装配体后会自动识别气缸、滑台、夹爪、旋转台、导轨等动件。' : '没有高置信度建议。') : '当前环境未提供几何数据，无法自动识别。'}</div>`
        : high.map(suggestionCard).join('');
    suggestLow.hidden = low.length === 0;
    suggestLowCount.textContent = String(low.length);
    suggestLowList.innerHTML = low.map(suggestionCard).join('');
    suggestNote.textContent =
      high.length + low.length > 0
        ? `${describeSuggestions(suggestResult)}。采纳后进入动件列表，仍需校验通过并保存。`
        : '建议不会自动写入：逐条「采纳」后进入动件列表，仍需校验通过并保存。';
  };

  const runSuggest = (): SuggestResult => {
    const geometry = options.getGeometry?.() ?? [];
    suggestResult =
      geometry.length === 0 ? emptySuggest() : suggestKinematics(geometry, { pointOptions: pointOptions(), existingParts: parts });
    renderSuggestions();
    return suggestResult;
  };

  const dropSuggestion = (id: string): void => {
    suggestResult = {
      ...suggestResult,
      suggestions: suggestResult.suggestions.filter((item) => item.id !== id),
      lowConfidence: suggestResult.lowConfidence.filter((item) => item.id !== id)
    };
    suggestResult.stats = { ...suggestResult.stats, high: suggestResult.suggestions.length, low: suggestResult.lowConfidence.length };
  };

  const acceptSuggestion = (id: string): string | null => {
    const pool = [...suggestResult.suggestions, ...suggestResult.lowConfidence];
    const geometry = options.getGeometry?.() ?? meshes;
    const result = acceptSuggestions(parts, pool, [id], geometry, { pointOptions: pointOptions() });
    if (result.accepted.length === 0) return null;
    const added = result.parts[result.parts.length - 1]!;
    parts.push(added);
    dropSuggestion(id);
    renderAll();
    notify(`已采纳建议「${added.name}」，校验通过后请点「保存标注」`);
    return added.id;
  };

  const renderAll = (): void => {
    sourceLabel.textContent = sourceFile || '未加载文件';
    renderMeshes();
    renderSuggestions();
    renderParts();
    refreshValidation();
  };

  const partById = (id: string): MovingPart | undefined => parts.find((part) => part.id === id);

  const uniqueName = (base: string): string => {
    let name = base.trim() || '动件';
    let index = 2;
    while (parts.some((part) => part.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      name = `${base.trim() || '动件'} ${index}`;
      index += 1;
    }
    return name;
  };

  const addMovingPart = (meshIds: readonly number[], name?: string): string => {
    const selectedMeshes = meshes.filter((mesh) => meshIds.includes(mesh.id));
    if (selectedMeshes.length === 0) throw new Error('请选择至少一个有效网格');
    const draft = draftFromMeshes(selectedMeshes, { name: uniqueName(name ?? selectedMeshes[0]!.name) });
    if (!draft.id.startsWith('mp-')) draft.id = uniquePartId();
    parts.push(draft);
    selected = new Set();
    renderAll();
    return draft.id;
  };

  const updatePart = (id: string, patch: Partial<MovingPart>): void => {
    const index = parts.findIndex((part) => part.id === id);
    if (index < 0) return;
    const current = parts[index]!;
    const next: MovingPart = { ...current, ...patch };
    if (patch.point !== undefined) next.point = patch.point.trim();
    if (patch.point !== undefined && patch.role === undefined) next.role = roleForPoint(pointOptions(), next.point);
    if (patch.kind !== undefined && patch.role === undefined) next.role = roleForPoint(pointOptions(), next.point) || defaultRole(next.kind);
    parts[index] = next;
  };

  const readField = (part: MovingPart, field: string, raw: string): void => {
    if (field === 'name') {
      part.name = raw;
      return;
    }
    if (field === 'kind') {
      part.kind = raw === 'rotary' ? 'rotary' : 'linear';
      return;
    }
    if (field === 'axis') {
      const parsed = parseAxisValue(raw);
      part.axis = parsed.axis;
      part.direction = parsed.direction;
      return;
    }
    if (field === 'point') {
      part.point = raw.trim();
      part.role = roleForPoint(pointOptions(), part.point);
      return;
    }
    const value = Number(raw);
    if (field === 'travelMm') part.travelMm = value;
    else if (field === 'retractedMm') part.retractedMm = value;
    else if (field === 'rangeDeg') part.rangeDeg = value;
    else if (field === 'retractedDeg') part.retractedDeg = value;
  };

  const slide = (id: string, percent: number): SlidePose | null => {
    const part = partById(id);
    if (!part) return null;
    const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    slides.set(id, clamped);
    const card = partList.querySelector<HTMLElement>(`[data-kin-part="${id}"]`);
    const slider = card?.querySelector<HTMLInputElement>('[data-kin-slide]');
    const output = card?.querySelector<HTMLElement>('[data-kin-output]');
    if (slider && document.activeElement !== slider) slider.value = String(clamped);
    if (output) output.textContent = `${Math.round(clamped)}%`;
    return applyPose(part, clamped);
  };

  const save = (): boolean => {
    validation = currentValidation();
    refreshValidation();
    if (!validation.ok) {
      notify(`${validation.errors.length} 项未通过，无法保存`, true);
      return false;
    }
    if (!sourceFile) {
      notify('请先导入 CAD 文件，再保存运动学标注', true);
      return false;
    }
    if (!store) {
      notify('当前环境不支持 localStorage，无法保存', true);
      return false;
    }
    try {
      store.set(storageKey || sourceFile, annotation());
      notify(`运动学标注已保存：${sourceFile}`);
      emit();
      return true;
    } catch (error) {
      recordDiagnosticError('KINEMATICS_SAVE_FAILED', error, { site: 'desktop/src/cad/kinematics-ui.ts' });
      notify(`保存失败：${error instanceof Error ? error.message : String(error)}。请检查浏览器存储空间后重试。`, true);
      return false;
    }
  };

  addButton.addEventListener('click', () => {
    try {
      addMovingPart([...selected]);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  });
  query<HTMLButtonElement>('[data-kin-clear]').addEventListener('click', () => {
    selected.clear();
    renderMeshes();
  });
  query<HTMLButtonElement>('[data-kin-close]').addEventListener('click', () => {
    container.hidden = true;
    options.onOpenChange?.(false);
  });
  saveButton.addEventListener('click', save);
  query<HTMLButtonElement>('[data-kin-suggest]').addEventListener('click', () => {
    const result = runSuggest();
    notify(describeSuggestions(result));
  });
  const onSuggestClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-kin-suggest-id]');
    const id = card?.dataset.kinSuggestId;
    if (!id) return;
    if (target.closest('[data-kin-accept]')) {
      try {
        acceptSuggestion(id);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
      }
    } else if (target.closest('[data-kin-dismiss]')) {
      dropSuggestion(id);
      renderSuggestions();
    }
  };
  suggestList.addEventListener('click', onSuggestClick);
  suggestLowList.addEventListener('click', onSuggestClick);
  query<HTMLButtonElement>('[data-kin-export]').addEventListener('click', () => {
    const blob = new Blob([serializeAnnotation(annotation())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(sourceFile || 'kinematics').replace(/\.[^.]+$/, '')}.kinematics.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify('运动学标注 JSON 已导出');
  });
  query<HTMLButtonElement>('[data-kin-import]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void file.text().then((text) => {
      const parsed = deserializeAnnotation(text);
      if (!parsed.ok || !parsed.annotation) {
        notify(parsed.issues[0]?.message ?? '导入失败', true);
        return;
      }
      if (!projectId || parsed.annotation.version !== 2) {
        notify('旧版运动学 JSON 仅含导入索引，无法安全绑定到当前 CAD；候选未应用，原状态未改动。', true);
        return;
      }
      const remapped = remapKinematicsAnnotation(parsed.annotation, projectId, meshes);
      if (!remapped.ok || !remapped.annotation) {
        notify(`运动学候选未应用：${remapped.reason ?? '稳定对象映射失败'}`, true);
        return;
      }
      parts = remapped.annotation.parts;
      sourceFile = remapped.annotation.sourceFile || sourceFile;
      slides.clear();
      renderAll();
      notify(`已导入 ${parts.length} 个动件；稳定对象映射已校验`);
    });
  });

  meshList.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-kin-mesh]');
    if (!input) return;
    const id = Number(input.dataset.kinMesh);
    if (input.checked) selected.add(id);
    else selected.delete(id);
    addButton.disabled = selected.size === 0;
  });

  partList.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-kin-part]');
    const part = card ? partById(card.dataset.kinPart ?? '') : undefined;
    if (!card || !part) return;
    if (target.matches('[data-kin-slide]')) {
      const slider = target as HTMLInputElement;
      slide(part.id, Number(slider.value));
      return;
    }
    const field = target.dataset.kinField;
    if (!field) return;
    readField(part, field, (target as HTMLInputElement).value);
    refreshValidation();
  });

  partList.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    const field = target.dataset.kinField;
    if (!field || field === 'name' || !['kind', 'axis', 'point'].includes(field)) return;
    const card = target.closest<HTMLElement>('[data-kin-part]');
    const part = card ? partById(card.dataset.kinPart ?? '') : undefined;
    if (!part) return;
    readField(part, field, (target as HTMLInputElement).value);
    renderAll();
  });

  partList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-kin-part]');
    const part = card ? partById(card.dataset.kinPart ?? '') : undefined;
    if (!card || !part) return;
    if (target.closest('[data-kin-delete]')) {
      viewer.resetKinematics(part.meshIds);
      parts = parts.filter((entry) => entry.id !== part.id);
      slides.delete(part.id);
      renderAll();
      return;
    }
    if (target.closest('[data-kin-reset]')) {
      slide(part.id, 0);
    }
  });

  const handle: KinematicsUiHandle = {
    open(): void {
      container.hidden = false;
      options.onOpenChange?.(true);
    },
    close(): void {
      container.hidden = true;
      options.onOpenChange?.(false);
    },
    isOpen(): boolean {
      return !container.hidden;
    },
    setSource(nextSourceFile: string, nextMeshes: readonly KinematicsMeshInfo[], nextProjectId?: string, nextStorageKey?: string): void {
      sourceFile = nextSourceFile.trim();
      projectId = nextProjectId?.trim() ?? '';
      storageKey = nextStorageKey?.trim() || projectId || `session:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      meshes = nextMeshes.map((mesh) => ({
        ...mesh,
        center: [...mesh.center] as [number, number, number],
        size: [...mesh.size] as [number, number, number]
      }));
      selected = new Set();
      slides.clear();
      const saved = store?.get(storageKey) ?? null;
      if (!saved) {
        parts = [];
      } else if (saved.version === 2 && saved.projectId === projectId) {
        const remapped = remapKinematicsAnnotation(saved, projectId, meshes);
        parts = remapped.ok && remapped.annotation ? remapped.annotation.parts.map(clonePart) : [];
        if (!remapped.ok) notify(`未自动恢复运动学标注：${remapped.reason ?? '稳定对象映射失败'}。本地候选仍保留。`, true);
      } else {
        parts = [];
        notify('检测到旧版索引式运动学数据；为避免网格错绑，未自动恢复，原始本地记录仍保留。', true);
      }
      suggestResult = emptySuggest();
      if (options.getGeometry && meshes.length > 0) {
        try {
          runSuggest();
        } catch (error) {
          // 识别失败只影响建议列表，不影响人工标注
          console.warn('[kinematics] 自动识别失败', error);
          suggestResult = emptySuggest();
        }
      }
      renderAll();
    },
    getAnnotation: annotation,
    getValidation: () => validation,
    addMovingPart,
    updatePart(id: string, patch: Partial<MovingPart>): void {
      updatePart(id, patch);
      renderAll();
    },
    slide(id: string, percent: number): SlidePose | null {
      const part = partById(id);
      if (!part) return null;
      updatePart(id, {});
      return slide(id, percent);
    },
    save,
    state(): KinematicsUiState {
      return {
        sourceFile,
        meshes: meshes.map((mesh) => ({ ...mesh, center: [...mesh.center], size: [...mesh.size] })),
        selectedMeshes: meshes
          .filter((mesh) => selected.has(mesh.id))
          .map((mesh) => ({ ...mesh, center: [...mesh.center], size: [...mesh.size] })),
        parts: parts.map(clonePart),
        errors: validation.errors.length,
        warnings: validation.warnings.length,
        ok: validation.ok,
        suggestions: {
          high: suggestResult.suggestions.length,
          low: suggestResult.lowConfidence.length,
          skipped: suggestResult.skipped.length
        }
      };
    },
    suggest: runSuggest,
    suggestions: () => suggestResult,
    acceptSuggestion,
    dismissSuggestion(id: string): void {
      dropSuggestion(id);
      renderSuggestions();
    }
  };

  return handle;
}
