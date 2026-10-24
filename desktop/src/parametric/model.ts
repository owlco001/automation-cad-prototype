// 参数化特征树的编辑与持久化纯逻辑：无 DOM、无 IPC，便于单测与 UI 复用。
import {
  ASSEMBLY_SCHEMA_VERSION,
  MAX_ASSEMBLY_INSTANCES,
  isAssemblyDoc,
  toAssembly,
  type AssemblyDoc,
  type FeatureDoc,
  type FeatureNode,
  type FeatureType,
  type InstanceTransform,
  type PartInstance
} from './features.ts';

export const PARAMETRIC_STORAGE_KEY = 'automationcad.parametric.v1';
export const PARAMETRIC_STORAGE_VERSION = 1;
export const UNTITLED_BUCKET = 'untitled';
export const DEFAULT_DEBOUNCE_MS = 300;

export type MoveDirection = 'up' | 'down';

export interface FeatureFieldSpec {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'select' | 'vector3';
  unit?: string;
  step?: number;
  min?: number;
  options?: readonly { value: string; label: string }[];
}

export interface FeatureTypeSpec {
  type: FeatureType;
  label: string;
  icon: string;
  defaultName: string;
  fields: readonly FeatureFieldSpec[];
}

export const FEATURE_SPECS: Readonly<Record<FeatureType, FeatureTypeSpec>> = {
  box: {
    type: 'box',
    label: '长方体 / 底板',
    icon: '<svg viewBox="0 0 16 16"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14"/></svg>',
    defaultName: '底板',
    fields: [
      { key: 'length', label: '长度', kind: 'number', unit: 'mm', step: 1, min: 0.01 },
      { key: 'width', label: '宽度', kind: 'number', unit: 'mm', step: 1, min: 0.01 },
      { key: 'height', label: '高度', kind: 'number', unit: 'mm', step: 1, min: 0.01 }
    ]
  },
  holes: {
    type: 'holes',
    label: '孔组',
    icon: '<svg viewBox="0 0 16 16"><circle cx="5" cy="5" r="2"/><circle cx="11" cy="5" r="2"/><circle cx="5" cy="11" r="2"/><circle cx="11" cy="11" r="2"/></svg>',
    defaultName: '安装孔',
    fields: [
      { key: 'diameter', label: '孔径', kind: 'number', unit: 'mm', step: 0.5, min: 0.01 },
      { key: 'depth', label: '深度', kind: 'text', unit: 'mm / through' }
    ]
  },
  slot: {
    type: 'slot',
    label: '腰形槽',
    icon: '<svg viewBox="0 0 16 16"><rect x="2.5" y="5.5" width="11" height="5" rx="2.5"/></svg>',
    defaultName: '腰形槽',
    fields: [
      { key: 'length', label: '长度', kind: 'number', unit: 'mm', step: 1, min: 0.01 },
      { key: 'width', label: '宽度', kind: 'number', unit: 'mm', step: 1, min: 0.01 }
    ]
  },
  fillet: {
    type: 'fillet',
    label: '圆角',
    icon: '<svg viewBox="0 0 16 16"><path d="M3 13V8a5 5 0 0 1 5-5h5"/><path d="M3 13h10"/></svg>',
    defaultName: '圆角',
    fields: [
      { key: 'radius', label: '半径', kind: 'number', unit: 'mm', step: 0.5, min: 0.01 },
      {
        key: 'edges',
        label: '边选择',
        kind: 'select',
        options: [
          { value: '|Z', label: '竖直边 |Z' },
          { value: 'all', label: '全部边' }
        ]
      }
    ]
  },
  cylinder: {
    type: 'cylinder',
    label: '圆柱 / 凸台',
    icon: '<svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="4.5" ry="2"/><path d="M3.5 4v8c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4"/></svg>',
    defaultName: '凸台',
    fields: [
      { key: 'diameter', label: '直径', kind: 'number', unit: 'mm', step: 0.5, min: 0.01 },
      { key: 'height', label: '高度', kind: 'number', unit: 'mm', step: 1, min: 0.01 },
      { key: 'at', label: '位置 X / Y / Z', kind: 'vector3', unit: 'mm', step: 1 }
    ]
  }
};

export const FEATURE_TYPES: readonly FeatureType[] = ['box', 'holes', 'slot', 'fillet', 'cylinder'];

const TYPE_SET = new Set<string>(FEATURE_TYPES);

export const PARAMETRIC_HISTORY_LIMIT = 100;
export const PARAMETRIC_HISTORY_MERGE_WINDOW_MS = 900;

export interface UndoRedoHistory<T> {
  push(state: T, options?: { mergeKey?: string; now?: number }): void;
  undo(current: T): T | null;
  redo(current: T): T | null;
  clear(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoCount(): number;
  redoCount(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

/**
 * JSON-safe in-memory history. A merge key coalesces rapid edits to the same
 * control; every non-merged push starts a new undo point and drops redo.
 */
export function createUndoRedoHistory<T>(options: {
  limit?: number;
  mergeWindowMs?: number;
} = {}): UndoRedoHistory<T> {
  const limit = Math.max(1, Math.floor(options.limit ?? PARAMETRIC_HISTORY_LIMIT));
  const mergeWindowMs = Math.max(0, options.mergeWindowMs ?? PARAMETRIC_HISTORY_MERGE_WINDOW_MS);
  const past: T[] = [];
  const future: T[] = [];
  let lastMergeKey: string | null = null;
  let lastMergeAt = Number.NEGATIVE_INFINITY;

  const trimPast = (): void => {
    if (past.length > limit) past.splice(0, past.length - limit);
  };

  return {
    push(state, pushOptions = {}): void {
      const now = pushOptions.now ?? Date.now();
      const mergeKey = pushOptions.mergeKey ?? null;
      const merge = mergeKey !== null && mergeKey === lastMergeKey &&
        now >= lastMergeAt && now - lastMergeAt <= mergeWindowMs;
      if (!merge) {
        past.push(clone(state));
        trimPast();
      }
      future.length = 0;
      lastMergeKey = mergeKey;
      lastMergeAt = mergeKey === null ? Number.NEGATIVE_INFINITY : now;
    },
    undo(current): T | null {
      const state = past.pop();
      if (state === undefined) return null;
      future.push(clone(current));
      lastMergeKey = null;
      lastMergeAt = Number.NEGATIVE_INFINITY;
      return clone(state);
    },
    redo(current): T | null {
      const state = future.pop();
      if (state === undefined) return null;
      past.push(clone(current));
      trimPast();
      lastMergeKey = null;
      lastMergeAt = Number.NEGATIVE_INFINITY;
      return clone(state);
    },
    clear(): void {
      past.length = 0;
      future.length = 0;
      lastMergeKey = null;
      lastMergeAt = Number.NEGATIVE_INFINITY;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoCount: () => past.length,
    redoCount: () => future.length
  };
}

function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function touch(doc: FeatureDoc, now: number): FeatureDoc {
  return { ...doc, updatedAt: timestamp(now) };
}

/** localStorage 分桶键：无来源文件时统一落到 untitled。 */
export function storageBucketKey(sourceFile?: string | null): string {
  const value = typeof sourceFile === 'string' ? sourceFile.trim() : '';
  return value || UNTITLED_BUCKET;
}

export function nextFeatureId(features: readonly FeatureNode[]): string {
  let max = 0;
  for (const feature of features) {
    const match = /^f(\d+)$/.exec(feature.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `f${max + 1}`;
}

function defaultParams(type: FeatureType): Record<string, unknown> {
  switch (type) {
    case 'box':
      return { length: 120, width: 80, height: 8, centered: true };
    case 'cylinder':
      return { diameter: 20, height: 10, at: [0, 0, 8] };
    case 'holes':
      return { diameter: 6, positions: [[-40, 0], [40, 0]], depth: 'through' };
    case 'slot':
      return { length: 50, width: 18 };
    case 'fillet':
      return { radius: 3, edges: '|Z' };
  }
}

function defaultName(type: FeatureType, features: readonly FeatureNode[]): string {
  const spec = FEATURE_SPECS[type];
  const count = features.filter((feature) => feature.type === type).length + 1;
  return count === 1 ? spec.defaultName : `${spec.defaultName} ${count}`;
}

export function createFeature(
  type: FeatureType,
  features: readonly FeatureNode[] = [],
  overrides: Partial<Pick<FeatureNode, 'name' | 'params' | 'suppressed'>> = {}
): FeatureNode {
  return {
    id: nextFeatureId(features),
    type,
    name: overrides.name ?? defaultName(type, features),
    params: clone(overrides.params ?? defaultParams(type)),
    ...(overrides.suppressed !== undefined ? { suppressed: overrides.suppressed } : {})
  };
}

export function makeDoc(
  features: readonly FeatureNode[] = [],
  options: { sourceFile?: string; now?: number } = {}
): FeatureDoc {
  return {
    schemaVersion: 1,
    ...(options.sourceFile?.trim() ? { sourceFile: options.sourceFile.trim() } : {}),
    features: features.map((feature) => clone(feature)),
    updatedAt: timestamp(options.now ?? Date.now())
  };
}

export function emptyInstance(id = 'p1', index = 1): PartInstance {
  const feature = createFeature('box', []);
  return {
    id,
    name: `零件 ${index}`,
    transform: { x: 0, y: 0, z: 0, rz: 0 },
    features: [feature]
  };
}

export function makeAssembly(
  instances: readonly PartInstance[] = [emptyInstance()],
  options: { sourceFile?: string; now?: number } = {}
): AssemblyDoc {
  return {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    ...(options.sourceFile?.trim() ? { sourceFile: options.sourceFile.trim() } : {}),
    instances: instances.map((instance) => clone(instance)),
    updatedAt: timestamp(options.now ?? Date.now())
  };
}

/** 兼容入口：保留对外导出；新代码请直接使用 `toAssembly`。 */
export function assemblyFromDoc(doc: FeatureDoc | AssemblyDoc): AssemblyDoc {
  return toAssembly(doc);
}

export function nextInstanceId(instances: readonly PartInstance[]): string {
  let max = 0;
  for (const instance of instances) {
    const match = /^p(\d+)$/.exec(instance.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `p${max + 1}`;
}

export function instanceFeatures(assembly: AssemblyDoc): FeatureNode[] {
  return assembly.instances.flatMap((instance) => instance.features);
}

function touchAssembly(assembly: AssemblyDoc, now: number): AssemblyDoc {
  return { ...assembly, updatedAt: timestamp(now) };
}

export function addInstance(
  assembly: AssemblyDoc,
  options: { now?: number; name?: string; partId?: string } = {}
): { assembly: AssemblyDoc; instance: PartInstance } {
  if (assembly.instances.length >= MAX_ASSEMBLY_INSTANCES) {
    throw new Error(`装配最多支持 ${MAX_ASSEMBLY_INSTANCES} 个实体`);
  }
  const index = assembly.instances.length + 1;
  const instance = emptyInstance(nextInstanceId(assembly.instances), index);
  if (options.name?.trim()) instance.name = options.name.trim();
  if (options.partId?.trim()) instance.partId = options.partId.trim();
  return {
    assembly: touchAssembly({ ...assembly, instances: [...assembly.instances, instance] }, options.now ?? Date.now()),
    instance
  };
}

/** 至少保留一个实体；删除不存在或最后一个实体时只更新时间戳。 */
export function removeInstance(assembly: AssemblyDoc, id: string, now = Date.now()): AssemblyDoc {
  if (assembly.instances.length <= 1) return touchAssembly(assembly, now);
  return touchAssembly({
    ...assembly,
    instances: assembly.instances.filter((instance) => instance.id !== id)
  }, now);
}

export function renameInstance(assembly: AssemblyDoc, id: string, name: string, now = Date.now()): AssemblyDoc {
  const trimmed = name.trim() || '未命名';
  return touchAssembly({
    ...assembly,
    instances: assembly.instances.map((instance) =>
      instance.id === id ? { ...instance, name: trimmed } : instance
    )
  }, now);
}

export function setInstancePartId(assembly: AssemblyDoc, id: string, partId: string, now = Date.now()): AssemblyDoc {
  const trimmed = partId.trim();
  return touchAssembly({
    ...assembly,
    instances: assembly.instances.map((instance) => {
      if (instance.id !== id) return instance;
      if (!trimmed) {
        const { partId: _removed, ...rest } = instance;
        return rest;
      }
      return { ...instance, partId: trimmed };
    })
  }, now);
}

export function updateInstanceTransform(
  assembly: AssemblyDoc,
  id: string,
  patch: Partial<InstanceTransform>,
  now = Date.now()
): AssemblyDoc {
  return touchAssembly({
    ...assembly,
    instances: assembly.instances.map((instance) =>
      instance.id === id
        ? { ...instance, transform: { ...instance.transform, ...patch } }
        : instance
    )
  }, now);
}

/** 兼容入口：保留对外导出；当前 UI 通过特征编辑函数间接更新实体特征。 */
export function setInstanceFeatures(
  assembly: AssemblyDoc,
  id: string,
  features: readonly FeatureNode[],
  now = Date.now()
): AssemblyDoc {
  return touchAssembly({
    ...assembly,
    instances: assembly.instances.map((instance) =>
      instance.id === id ? { ...instance, features: features.map((feature) => clone(feature)) } : instance
    )
  }, now);
}

export function addFeature(
  doc: FeatureDoc,
  type: FeatureType,
  options: { now?: number; overrides?: Partial<Pick<FeatureNode, 'name' | 'params' | 'suppressed'>> } = {}
): { doc: FeatureDoc; feature: FeatureNode } {
  const feature = createFeature(type, doc.features, options.overrides);
  return { doc: touch({ ...doc, features: [...doc.features, feature] }, options.now ?? Date.now()), feature };
}

export function removeFeature(doc: FeatureDoc, id: string, now = Date.now()): FeatureDoc {
  return touch({ ...doc, features: doc.features.filter((feature) => feature.id !== id) }, now);
}

/** 上移/下移；越界返回原顺序但更新时间戳。 */
export function moveFeature(doc: FeatureDoc, id: string, direction: MoveDirection, now = Date.now()): FeatureDoc {
  const index = doc.features.findIndex((feature) => feature.id === id);
  if (index < 0) return touch(doc, now);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= doc.features.length) return touch(doc, now);
  const features = [...doc.features];
  const current = features[index];
  const other = features[target];
  if (!current || !other) return touch(doc, now);
  features[index] = other;
  features[target] = current;
  return touch({ ...doc, features }, now);
}

export function setSuppressed(doc: FeatureDoc, id: string, suppressed: boolean, now = Date.now()): FeatureDoc {
  return touch({
    ...doc,
    features: doc.features.map((feature) => {
      if (feature.id !== id) return feature;
      if (suppressed) return { ...feature, suppressed: true };
      const { suppressed: _removed, ...rest } = feature;
      return rest;
    })
  }, now);
}

export function toggleSuppressed(doc: FeatureDoc, id: string, now = Date.now()): FeatureDoc {
  const feature = doc.features.find((item) => item.id === id);
  return setSuppressed(doc, id, feature?.suppressed !== true, now);
}

export function renameFeature(doc: FeatureDoc, id: string, name: string, now = Date.now()): FeatureDoc {
  const trimmed = name.trim() || '未命名';
  return touch({
    ...doc,
    features: doc.features.map((feature) => feature.id === id ? { ...feature, name: trimmed } : feature)
  }, now);
}

/** 浅合并参数；数组按值拷贝，避免 UI 输入直接改写文档。 */
export function updateParams(
  doc: FeatureDoc,
  id: string,
  patch: Record<string, unknown>,
  now = Date.now()
): FeatureDoc {
  return touch({
    ...doc,
    features: doc.features.map((feature) =>
      feature.id === id
        ? { ...feature, params: { ...feature.params, ...clone(patch) } }
        : feature
    )
  }, now);
}

export function findFeature(doc: FeatureDoc, id: string | null): FeatureNode | null {
  if (!id) return null;
  return doc.features.find((feature) => feature.id === id) ?? null;
}

export interface DebouncePlan {
  scheduled: boolean;
  waitMs: number;
  dueAt: number;
}

/** 300 ms 防抖计划；纯函数，定时器由调用方负责。 */
export function debouncePlan(
  lastChangeAt: number,
  now: number,
  options: { delayMs?: number; enabled?: boolean } = {}
): DebouncePlan {
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_DEBOUNCE_MS);
  if (options.enabled === false) return { scheduled: false, waitMs: 0, dueAt: now };
  const elapsed = Math.max(0, now - lastChangeAt);
  const waitMs = Math.max(0, delayMs - elapsed);
  return {
    scheduled: waitMs > 0,
    waitMs,
    dueAt: lastChangeAt + delayMs
  };
}

export interface BuildStatsLike {
  faces?: unknown;
  volumeMm3?: unknown;
  bbox?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 底部状态：`重建 50 ms · 面 19 · 体积 71.5 cm³`。 */
export function formatBuildStatus(buildMs?: number, stats?: BuildStatsLike | null): string {
  const faces = finite(stats?.faces);
  const volume = finite(stats?.volumeMm3);
  const parts: string[] = [];
  const ms = finite(buildMs);
  if (ms !== null) parts.push(`重建 ${Math.round(ms)} ms`);
  if (faces !== null) parts.push(`面 ${Math.round(faces)}`);
  if (volume !== null) parts.push(`体积 ${(volume / 1000).toFixed(1)} cm³`);
  return parts.length > 0 ? parts.join(' · ') : '尚未重建';
}

export type FeatureBounds = { min: [number, number, number]; max: [number, number, number] };

function numeric(value: unknown): number | null {
  return finite(value);
}

function vector(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (numeric(x) === null || numeric(y) === null || numeric(z) === null) return null;
  return [x as number, y as number, z as number];
}

function plateThickness(doc: FeatureDoc | undefined): number {
  let thickness = 0;
  for (const feature of doc?.features ?? []) {
    if (feature.type !== 'box' || feature.suppressed === true) continue;
    const height = numeric(feature.params.height);
    if (height !== null && height > 0) {
      thickness = thickness === 0 ? height : Math.min(thickness, height);
    }
  }
  return thickness;
}

/** 特征的大致包围盒，用于在视口里高亮（不是精确 B-rep 结果）。 */
export function featureBounds(node: FeatureNode, doc?: FeatureDoc): FeatureBounds | null {
  const params = node.params;
  const thickness = plateThickness(doc) || 8;
  if (node.type === 'box') {
    const length = numeric(params.length);
    const width = numeric(params.width);
    const height = numeric(params.height);
    if (length === null || width === null || height === null) return null;
    const centered = params.centered !== false;
    const minX = centered ? -length / 2 : 0;
    const minY = centered ? -width / 2 : 0;
    return {
      min: [minX, minY, 0],
      max: [minX + length, minY + width, height]
    };
  }
  if (node.type === 'cylinder') {
    const diameter = numeric(params.diameter);
    const height = numeric(params.height);
    if (diameter === null || height === null) return null;
    const at = vector(params.at) ?? [0, 0, 0];
    return {
      min: [at[0] - diameter / 2, at[1] - diameter / 2, at[2]],
      max: [at[0] + diameter / 2, at[1] + diameter / 2, at[2] + height]
    };
  }
  if (node.type === 'holes') {
    const diameter = numeric(params.diameter);
    const positions = Array.isArray(params.positions) ? params.positions : [];
    if (diameter === null || positions.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of positions) {
      if (!Array.isArray(item) || item.length < 2) return null;
      const x = numeric(item[0]);
      const y = numeric(item[1]);
      if (x === null || y === null) return null;
      minX = Math.min(minX, x - diameter / 2);
      minY = Math.min(minY, y - diameter / 2);
      maxX = Math.max(maxX, x + diameter / 2);
      maxY = Math.max(maxY, y + diameter / 2);
    }
    if (!Number.isFinite(minX)) return null;
    return { min: [minX, minY, 0], max: [maxX, maxY, thickness] };
  }
  if (node.type === 'slot') {
    const length = numeric(params.length);
    const width = numeric(params.width);
    if (length === null || width === null) return null;
    return {
      min: [-length / 2, -width / 2, 0],
      max: [length / 2, width / 2, thickness]
    };
  }
  return null;
}

/** 选中 fillet 等无独立实体时，回退到整棵树的包围盒。 */
export function docBounds(doc: FeatureDoc): FeatureBounds | null {
  let result: FeatureBounds | null = null;
  for (const feature of doc.features) {
    if (feature.suppressed === true) continue;
    const bounds = featureBounds(feature, doc);
    if (!bounds) continue;
    if (!result) {
      result = { min: [...bounds.min], max: [...bounds.max] };
    } else {
      for (let axis = 0; axis < 3; axis += 1) {
        result.min[axis] = Math.min(result.min[axis]!, bounds.min[axis]!);
        result.max[axis] = Math.max(result.max[axis]!, bounds.max[axis]!);
      }
    }
  }
  return result;
}

export function serializeDoc(doc: FeatureDoc | AssemblyDoc): string {
  return JSON.stringify(doc, null, 2);
}

export interface DeserializeResult {
  ok: boolean;
  doc: FeatureDoc | AssemblyDoc | null;
  errors: string[];
}

function parseFeatureNodes(
  rawFeatures: unknown[],
  errors: string[],
  prefix = ''
): FeatureNode[] {
  const features: FeatureNode[] = [];
  rawFeatures.forEach((value, index) => {
    const label = `${prefix}第 ${index + 1} 个特征`;
    if (!isRecord(value)) {
      errors.push(`${label}必须是对象`);
      return;
    }
    if (typeof value.id !== 'string' || !value.id.trim()) errors.push(`缺少必填参数：${label}.id`);
    if (typeof value.type !== 'string' || !TYPE_SET.has(value.type)) {
      errors.push(`${label}类型无效`);
      return;
    }
    if (typeof value.name !== 'string' || !value.name.trim()) errors.push(`缺少必填参数：${label}.name`);
    if (!isRecord(value.params)) errors.push(`${label} params 必须是对象`);
    features.push({
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `f${index + 1}`,
      type: value.type as FeatureType,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '未命名',
      params: clone(isRecord(value.params) ? value.params : {}),
      ...(value.suppressed === true ? { suppressed: true } : {})
    });
  });
  return features;
}

function parseAssembly(raw: Record<string, unknown>, errors: string[]): AssemblyDoc | null {
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== ASSEMBLY_SCHEMA_VERSION) {
    errors.push('schemaVersion 必须为 1 或 2');
  }
  if (typeof raw.updatedAt !== 'string' || !raw.updatedAt.trim()) errors.push('缺少必填参数：updatedAt');
  if (raw.sourceFile !== undefined && typeof raw.sourceFile !== 'string') errors.push('sourceFile 必须是字符串');
  if (!Array.isArray(raw.instances)) {
    errors.push('instances 必须是数组');
    return null;
  }
  if (raw.instances.length === 0) errors.push('装配为空，至少需要一个实体');
  if (raw.instances.length > MAX_ASSEMBLY_INSTANCES) {
    errors.push(`装配最多支持 ${MAX_ASSEMBLY_INSTANCES} 个实体（当前 ${raw.instances.length} 个）`);
  }
  const instances: PartInstance[] = [];
  raw.instances.forEach((value, index) => {
    const label = `第 ${index + 1} 个实体`;
    if (!isRecord(value)) {
      errors.push(`${label}必须是对象`);
      return;
    }
    if (typeof value.id !== 'string' || !value.id.trim()) errors.push(`缺少必填参数：${label}.id`);
    if (typeof value.name !== 'string' || !value.name.trim()) errors.push(`缺少必填参数：${label}.name`);
    if (value.partId !== undefined && typeof value.partId !== 'string') errors.push(`${label} partId 必须是字符串`);
    const transform = isRecord(value.transform) ? value.transform : null;
    if (!transform) errors.push(`${label} transform 必须是对象`);
    const x = transform?.x;
    const y = transform?.y;
    const z = transform?.z;
    const rz = transform?.rz;
    if (typeof x !== 'number' || !Number.isFinite(x) ||
        typeof y !== 'number' || !Number.isFinite(y) ||
        typeof z !== 'number' || !Number.isFinite(z) ||
        (rz !== undefined && (typeof rz !== 'number' || !Number.isFinite(rz)))) {
      errors.push(`${label} transform 必须包含数字 x / y / z（rz 可省略，省略按 0）`);
    }
    if (!Array.isArray(value.features)) {
      errors.push(`${label} features 必须是数组`);
      return;
    }
    const features = parseFeatureNodes(value.features, errors, `${label}：`);
    instances.push({
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `p${index + 1}`,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `零件 ${index + 1}`,
      ...(typeof value.partId === 'string' && value.partId.trim() ? { partId: value.partId.trim() } : {}),
      transform: {
        x: typeof x === 'number' && Number.isFinite(x) ? x : 0,
        y: typeof y === 'number' && Number.isFinite(y) ? y : 0,
        z: typeof z === 'number' && Number.isFinite(z) ? z : 0,
        rz: typeof rz === 'number' && Number.isFinite(rz) ? rz : 0
      },
      features
    });
  });
  if (errors.length > 0) return null;
  return {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    ...(typeof raw.sourceFile === 'string' && raw.sourceFile.trim() ? { sourceFile: raw.sourceFile.trim() } : {}),
    instances,
    updatedAt: raw.updatedAt as string
  };
}

/** 结构校验，不要求参数已全部合法（载入后可继续编辑）。 */
export function deserializeDoc(text: string, now = Date.now()): DeserializeResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, doc: null, errors: ['特征树 JSON 解析失败，请检查文件内容'] };
  }
  if (!isRecord(raw)) return { ok: false, doc: null, errors: ['特征树必须是 JSON 对象'] };
  if (Array.isArray(raw.instances)) {
    const assembly = parseAssembly(raw, errors);
    return errors.length > 0 || !assembly
      ? { ok: false, doc: null, errors }
      : { ok: true, doc: assembly, errors: [] };
  }
  if (raw.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!Array.isArray(raw.features)) errors.push('features 必须是数组');
  if (typeof raw.updatedAt !== 'string' || !raw.updatedAt.trim()) errors.push('缺少必填参数：updatedAt');
  if (raw.sourceFile !== undefined && typeof raw.sourceFile !== 'string') errors.push('sourceFile 必须是字符串');
  const features: FeatureNode[] = [];
  if (Array.isArray(raw.features)) {
    features.push(...parseFeatureNodes(raw.features, errors));
  }
  if (errors.length > 0) return { ok: false, doc: null, errors };
  const doc: FeatureDoc = {
    schemaVersion: 1,
    ...(typeof raw.sourceFile === 'string' && raw.sourceFile.trim() ? { sourceFile: raw.sourceFile.trim() } : {}),
    features,
    updatedAt: raw.updatedAt as string
  };
  return { ok: true, doc, errors: [] };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ParametricBucket {
  version: 1;
  buckets: Record<string, FeatureDoc | AssemblyDoc>;
}

function emptyBucket(): ParametricBucket {
  return { version: PARAMETRIC_STORAGE_VERSION, buckets: {} };
}

function readBucket(storage: StorageLike): ParametricBucket {
  try {
    const text = storage.getItem(PARAMETRIC_STORAGE_KEY);
    if (!text) return emptyBucket();
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.version !== PARAMETRIC_STORAGE_VERSION || !isRecord(parsed.buckets)) {
      return emptyBucket();
    }
    return { version: 1, buckets: parsed.buckets as Record<string, FeatureDoc | AssemblyDoc> };
  } catch {
    return emptyBucket();
  }
}

export interface ParametricStore {
  get(sourceFile?: string | null): FeatureDoc | AssemblyDoc | null;
  set(sourceFile: string | null | undefined, doc: FeatureDoc | AssemblyDoc): void;
  remove(sourceFile?: string | null): void;
  files(): string[];
}

/** 单键 `automationcad.parametric.v1`，内部按 sourceFile 分桶。 */
export function createParametricStore(storage: StorageLike): ParametricStore {
  return {
    get(sourceFile?: string | null): FeatureDoc | AssemblyDoc | null {
      const key = storageBucketKey(sourceFile);
      const entry = readBucket(storage).buckets[key];
      if (!entry || (isAssemblyDoc(entry) ? !Array.isArray(entry.instances) : !Array.isArray(entry.features))) {
        return null;
      }
      return clone(entry);
    },
    set(sourceFile: string | null | undefined, doc: FeatureDoc | AssemblyDoc): void {
      const key = storageBucketKey(sourceFile);
      const bucket = readBucket(storage);
      bucket.buckets[key] = clone(doc);
      storage.setItem(PARAMETRIC_STORAGE_KEY, JSON.stringify(bucket));
    },
    remove(sourceFile?: string | null): void {
      const key = storageBucketKey(sourceFile);
      const bucket = readBucket(storage);
      delete bucket.buckets[key];
      storage.setItem(PARAMETRIC_STORAGE_KEY, JSON.stringify(bucket));
    },
    files(): string[] {
      return Object.keys(readBucket(storage).buckets).sort();
    }
  };
}
