import AdmZip from 'adm-zip';
import { deserializeAnnotation } from '../cad/kinematics-ui.ts';
import { deserializeDoc } from '../parametric/model.ts';
import { createZip, normalizeZipPath, type ZipEntry } from '../shared/zip.ts';
import { sha256Hex } from '../sync/package.ts';

export const PORTABLE_PROJECT_ARCHIVE_TYPE = 'automationcad.portable-project' as const;
export const PORTABLE_PROJECT_SCHEMA_VERSION = 2 as const;
export const PORTABLE_PROJECT_CORE_SCHEMA_VERSION = 1 as const;
export const PORTABLE_PROJECT_EXCLUDED_STATE_CODES = Object.freeze([
  'feature-tree-module-disabled',
  'feature-tree-not-loaded',
  'feature-tree-source-mismatch',
  'kinematics-stable-object-binding-unavailable',
  'kinematics-not-loaded',
  'cad-view-state-unavailable'
] as const);

export const PORTABLE_PROJECT_ENTRIES = {
  manifest: 'manifest.json',
  featureTree: 'state/feature-tree.json',
  kinematics: 'state/kinematics.json',
  viewState: 'state/view-state.json'
} as const;

export const PORTABLE_PROJECT_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxManifestBytes: 1 * 1024 * 1024,
  maxStateBytes: 10 * 1024 * 1024,
  maxDependencyBytes: 200 * 1024 * 1024,
  maxTotalUncompressedBytes: 240 * 1024 * 1024,
  maxEntries: 128,
  maxDependencies: 64
} as const;

const SUPPORTED_CAD_FORMATS = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'glb']);
const UNSUPPORTED_MODULES = [
  'renderer-state-apply',
  'kinematics-cad-reimport-verification',
  'plc-factory-agent-and-enclosure-module-state',
  'parametric-generated-mesh-cache'
] as const;
const UNSUPPORTED_V1 = [
  'kinematics-mesh-index-remap',
  'renderer-state-apply',
  'plc-factory-agent-and-enclosure-module-state',
  'parametric-generated-mesh-cache'
] as const;
const INTEGRITY = {
  algorithm: 'SHA-256',
  scope: 'all declared payload entries, excluding manifest.json',
  authenticity: 'unsigned'
} as const;

type StateKind = 'featureTree' | 'kinematics' | 'viewState';
type PayloadRole = StateKind | 'cadDependency';

interface PayloadRef {
  path: string;
  sha256: string;
  size: number;
}

interface StateRef extends PayloadRef {
  schemaVersion: number;
}

export interface PortableCadDependencyRef extends PayloadRef {
  originalName: string;
  format: string;
}

export interface PortableProjectManifest {
  archiveType: typeof PORTABLE_PROJECT_ARCHIVE_TYPE;
  schemaVersion: 1 | typeof PORTABLE_PROJECT_SCHEMA_VERSION;
  coreSchemaVersion: typeof PORTABLE_PROJECT_CORE_SCHEMA_VERSION;
  appVersion: string;
  createdAt: string;
  project: { id: string; name: string; identity?: PortableProjectIdentity };
  state: {
    featureTree: StateRef | null;
    kinematics: StateRef | null;
    viewState: StateRef | null;
    omitted?: readonly string[];
  };
  dependencies: PortableCadDependencyRef[];
  integrity: typeof INTEGRITY;
  restoreMode: 'archive-api-only';
  unsupported: readonly string[];
}

export interface PortableProjectIdentity {
  sourceName: string;
  sourceSha256: string;
  sourceSize: number;
  modelObjects: Array<{ objectId: string; name: string; path: string[]; geometrySha256: string }>;
}

export interface PortableCadDependencySource {
  /** 工程中原始 CAD 文件的纯文件名；不能携带目录。 */
  originalName: string;
  content: Uint8Array;
}

export interface PortableProjectArchiveSources {
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt?: string;
  /** Optional mapping from the currently loaded CAD source; builder verifies its hash against the dependency. */
  identity?: PortableProjectIdentity;
  /** 原样保存的既有 FeatureDoc / AssemblyDoc JSON。 */
  featureTreeJson?: string;
  /** 原样保存的既有运动学标注 JSON。 */
  kinematicsJson?: string;
  /** 本档案格式 schema v2 的相机视角快照 JSON；仅候选，不在当前 UI 中应用。 */
  viewStateJson?: string;
  /** 原始 CAD 文件字节；仅接受独立文件格式，不接受需外部 sidecar 的 OBJ/GLTF。 */
  dependencies?: readonly PortableCadDependencySource[];
  /** schema v2 中未导出的应用状态原因码；不携带任意说明文本。 */
  excludedState?: readonly string[];
}

export interface PortableProjectArchive {
  bytes: Uint8Array;
  manifest: PortableProjectManifest;
  sha256: string;
}

export interface PortableProjectCandidate {
  manifest: PortableProjectManifest;
  featureTreeJson: string | null;
  kinematicsJson: string | null;
  viewStateJson: string | null;
  /** 按原文件名返回原始字节；调用方必须在单独的导入事务中再决定如何应用。 */
  dependencies: Array<{ originalName: string; format: string; content: Uint8Array }>;
}

interface InternalPayload {
  path: string;
  role: PayloadRole;
  content: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${label}必须是 1–${max} 个字符的非空字符串`);
  }
  return value.trim();
}

function requireCreatedAt(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error('createdAt 必须是合法的 UTC ISO 时间');
  }
  return value;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}不是合法 JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label}必须是 JSON 对象`);
  return value;
}

function validateFeatureTreeJson(text: string): number {
  const raw = parseJsonObject(text, '特征树');
  const assembly = Array.isArray(raw.instances);
  const expectedKeys = assembly ? ['schemaVersion', 'instances', 'updatedAt'] : ['schemaVersion', 'features', 'updatedAt'];
  if (!hasExactKeys(raw, expectedKeys) && !hasExactKeys(raw, [...expectedKeys, 'sourceFile'])) {
    throw new Error('特征树含有未知字段或缺少字段');
  }
  const checkFeatures = (features: unknown, label: string): void => {
    if (!Array.isArray(features)) throw new Error(`${label}.features 必须是数组`);
    features.forEach((value, index) => {
      if (!isRecord(value) || (!hasExactKeys(value, ['id', 'type', 'name', 'params'])
        && !hasExactKeys(value, ['id', 'type', 'name', 'params', 'suppressed']))) {
        throw new Error(`${label}.features[${index}] 含有未知字段或缺少字段`);
      }
      const node = value;
      const params = node.params;
      if (!isRecord(params)) throw new Error(`${label}.features[${index}].params 必须是对象`);
      const allowedParams: Record<string, readonly string[]> = {
        box: ['length', 'width', 'height', 'centered'],
        cylinder: ['diameter', 'height', 'at'],
        holes: ['diameter', 'positions', 'depth'],
        slot: ['length', 'width'],
        fillet: ['radius', 'edges']
      };
      const allowed = typeof node.type === 'string' ? allowedParams[node.type] : undefined;
      if (!allowed || !hasOnlyKeys(params, allowed)) throw new Error(`${label}.features[${index}].params 含有未知参数或类型`);
    });
  };
  if (assembly) {
    const instances = raw.instances as unknown[];
    instances.forEach((value, index) => {
      if (!isRecord(value) || (!hasExactKeys(value, ['id', 'name', 'transform', 'features'])
        && !hasExactKeys(value, ['id', 'name', 'transform', 'features', 'partId']))) {
        throw new Error(`特征树.instances[${index}] 含有未知字段或缺少字段`);
      }
      const instance = value;
      if (!isRecord(instance.transform)
        || (!hasExactKeys(instance.transform, ['x', 'y', 'z']) && !hasExactKeys(instance.transform, ['x', 'y', 'z', 'rz']))) {
        throw new Error(`特征树.instances[${index}].transform 含有未知字段或缺少字段`);
      }
      checkFeatures(instance.features, `特征树.instances[${index}]`);
    });
  } else {
    checkFeatures(raw.features, '特征树');
  }
  const result = deserializeDoc(text);
  if (!result.ok || !result.doc) throw new Error(`特征树不受支持或结构无效：${result.errors.join('；')}`);
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error(`特征树 schema 版本不兼容：${String(schemaVersion)}`);
  return schemaVersion;
}

function validateKinematicsJson(text: string): number {
  const raw = parseJsonObject(text, '运动学标注');
  const version = raw.version;
  const topLevelKeys = version === 2 ? ['version', 'projectId', 'sourceFile', 'parts'] : ['version', 'sourceFile', 'parts'];
  if (!hasExactKeys(raw, topLevelKeys)) throw new Error('运动学标注含有未知字段或缺少字段');
  if (!Array.isArray(raw.parts)) throw new Error('运动学标注 parts 必须是数组');
  const partKeys = [
    'id', 'name', 'meshIds', 'meshNames', 'center', 'size', 'kind', 'axis', 'direction',
    'travelMm', 'retractedMm', 'rangeDeg', 'retractedDeg', 'point', 'role'
  ];
  raw.parts.forEach((value, index) => {
    const keys = version === 2 ? [...partKeys, 'meshObjectIds'] : partKeys;
    exactRecord(value, keys, `运动学标注.parts[${index}]`);
  });
  const result = deserializeAnnotation(text);
  if (!result.ok || !result.annotation) {
    throw new Error(`运动学标注不受支持或结构无效：${result.issues.map((issue) => issue.message).join('；')}`);
  }
  if (version !== 1 && version !== 2) throw new Error(`运动学标注版本不兼容：${String(version)}`);
  return version;
}

function finiteVec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${label}必须是 3 个有限数字`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function validateViewStateJson(text: string): number {
  const raw = parseJsonObject(text, '视角状态');
  if (!hasExactKeys(raw, ['schemaVersion', 'position', 'target', 'up', 'fovDeg', 'wireframe'])) {
    throw new Error('视角状态含有未知字段或缺少字段');
  }
  if (raw.schemaVersion !== 1) throw new Error(`视角状态 schema 版本不兼容：${String(raw.schemaVersion)}`);
  const position = finiteVec3(raw.position, 'position');
  const target = finiteVec3(raw.target, 'target');
  const up = finiteVec3(raw.up, 'up');
  if (Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 1e-9) {
    throw new Error('相机位置不能与观察目标重合');
  }
  if (Math.hypot(...up) < 1e-9) throw new Error('up 方向不能为零向量');
  if (typeof raw.fovDeg !== 'number' || !Number.isFinite(raw.fovDeg) || raw.fovDeg < 1 || raw.fovDeg > 179) {
    throw new Error('fovDeg 必须在 1–179 度之间');
  }
  if (typeof raw.wireframe !== 'boolean') throw new Error('wireframe 必须是布尔值');
  return 1;
}

function sourceFileFromJson(text: string | undefined, label: string): string | null {
  if (text === undefined) return null;
  const raw = parseJsonObject(text, label);
  if (raw.sourceFile === undefined || raw.sourceFile === null || raw.sourceFile === '') return null;
  if (typeof raw.sourceFile !== 'string') throw new Error(`${label} sourceFile 必须是字符串`);
  const source = raw.sourceFile.trim();
  if (!source) return null;
  if (/[\\/\u0000-\u001f\u007f]/.test(source) || source === '.' || source === '..') {
    throw new Error(`${label} sourceFile 必须是纯文件名，不能包含本地路径`);
  }
  return source;
}

function validateStateDependencies(
  featureTreeJson: string | undefined,
  kinematicsJson: string | undefined,
  dependencies: readonly { originalName: string }[]
): void {
  const available = new Set(dependencies.map((dependency) => dependency.originalName.toLowerCase()));
  for (const [label, text] of [['特征树', featureTreeJson], ['运动学标注', kinematicsJson]] as const) {
    if (text === undefined) continue;
    const sourceFile = sourceFileFromJson(text, label);
    if (!sourceFile) throw new Error(`${label}缺少 CAD sourceFile，无法安全绑定工程依赖`);
    if (!available.has(sourceFile.toLowerCase())) {
      throw new Error(`${label}引用的 CAD 依赖缺失：${sourceFile}`);
    }
  }
}

function stateBytes(value: string | undefined, label: string, validate: (text: string) => number): { bytes: Uint8Array; schemaVersion: number } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') === 0) throw new Error(`${label}不能为空`);
  const size = Buffer.byteLength(value, 'utf8');
  if (size > PORTABLE_PROJECT_LIMITS.maxStateBytes) throw new Error(`${label}超过 ${PORTABLE_PROJECT_LIMITS.maxStateBytes} 字节上限`);
  return { bytes: Buffer.from(value, 'utf8'), schemaVersion: validate(value) };
}

function validateExcludedState(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || !value.every((code) =>
    typeof code === 'string' && (PORTABLE_PROJECT_EXCLUDED_STATE_CODES as readonly string[]).includes(code)
  ) || new Set(value).size !== value.length) {
    throw new Error('excludedState 必须是唯一且受支持的状态排除原因码');
  }
  return [...value] as string[];
}

function cadFormatFromName(name: string): string {
  if (/[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
    throw new Error(`CAD 依赖必须是纯文件名：${name}`);
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) throw new Error(`CAD 依赖缺少扩展名：${name}`);
  const format = name.slice(dot + 1).toLowerCase();
  if (!SUPPORTED_CAD_FORMATS.has(format)) throw new Error(`不支持的 CAD 依赖格式：.${format}`);
  return format;
}

function validateProjectIdentity(
  value: unknown,
  dependencies: readonly PortableCadDependencyRef[],
  projectId: string
): PortableProjectIdentity {
  const raw = exactRecord(value, ['sourceName', 'sourceSha256', 'sourceSize', 'modelObjects'], 'project.identity');
  const sourceName = requireText(raw.sourceName, 'project.identity.sourceName', 240);
  cadFormatFromName(sourceName);
  if (typeof raw.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sourceSha256)) {
    throw new Error('project.identity.sourceSha256 格式错误');
  }
  if (!Number.isSafeInteger(raw.sourceSize) || (raw.sourceSize as number) <= 0) {
    throw new Error('project.identity.sourceSize 必须是正整数');
  }
  const matching = dependencies.filter((dependency) =>
    dependency.originalName.toLowerCase() === sourceName.toLowerCase()
      && dependency.sha256 === raw.sourceSha256
      && dependency.size === raw.sourceSize
  );
  if (matching.length !== 1) throw new Error('project.identity 未唯一绑定到档案中的 CAD 原始依赖');
  if (!Array.isArray(raw.modelObjects) || raw.modelObjects.length > 10_000) {
    throw new Error('project.identity.modelObjects 必须是至多 10000 项的数组');
  }
  const seen = new Set<string>();
  const modelObjects = raw.modelObjects.map((item, index) => {
    const object = exactRecord(item, ['objectId', 'name', 'path', 'geometrySha256'], `project.identity.modelObjects[${index}]`);
    if (typeof object.objectId !== 'string' || !/^cadobj-[a-f0-9]{64}$/.test(object.objectId)) {
      throw new Error(`modelObjects[${index}].objectId 格式错误`);
    }
    if (seen.has(object.objectId)) throw new Error(`modelObjects[${index}] objectId 重复`);
    seen.add(object.objectId);
    if (typeof object.geometrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(object.geometrySha256)) {
      throw new Error(`modelObjects[${index}].geometrySha256 格式错误`);
    }
    if (typeof object.name !== 'string' || object.name.length > 240 || /[\u0000-\u001f\u007f]/.test(object.name)) {
      throw new Error(`modelObjects[${index}].name 格式错误`);
    }
    if (!Array.isArray(object.path) || object.path.length > 64 || !object.path.every((segment) =>
      typeof segment === 'string' && segment.length <= 240 && !/[\\/\u0000-\u001f\u007f]/.test(segment)
    )) {
      throw new Error(`modelObjects[${index}].path 格式错误`);
    }
    const identityMaterial = JSON.stringify({
      projectId,
      sourceSha256: raw.sourceSha256,
      name: object.name,
      path: object.path,
      geometrySha256: object.geometrySha256
    });
    const expectedObjectId = `cadobj-${sha256Hex(Buffer.from(identityMaterial, 'utf8'))}`;
    if (object.objectId !== expectedObjectId) throw new Error(`modelObjects[${index}] objectId 与其 identity 字段不一致`);
    return {
      objectId: object.objectId,
      name: object.name,
      path: [...object.path] as string[],
      geometrySha256: object.geometrySha256
    };
  });
  return {
    sourceName,
    sourceSha256: raw.sourceSha256,
    sourceSize: raw.sourceSize as number,
    modelObjects
  };
}

function projectIdentityForBuild(
  identity: PortableProjectIdentity | undefined,
  dependencies: readonly PortableCadDependencyRef[],
  projectId: string
): PortableProjectIdentity {
  if (dependencies.length === 0) throw new Error('工程档案 schema v2 必须包含原始 CAD 源依赖');
  const candidate = identity ?? {
    sourceName: dependencies[0]!.originalName,
    sourceSha256: dependencies[0]!.sha256,
    sourceSize: dependencies[0]!.size,
    modelObjects: []
  };
  const checked = validateProjectIdentity(candidate, dependencies, projectId);
  if (checked.sourceSha256 !== dependencies.find((dependency) => dependency.originalName.toLowerCase() === checked.sourceName.toLowerCase())?.sha256) {
    throw new Error('project.identity 与 CAD 原始依赖 SHA-256 不一致');
  }
  return checked;
}

function safeArchiveBasename(name: string): string {
  const normalized = name.normalize('NFKC');
  const safe = normalized.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 96);
  if (!safe || safe === '.' || safe === '..') throw new Error(`CAD 文件名无法安全写入档案：${name}`);
  return safe;
}

function dependencyPath(index: number, originalName: string): string {
  return `dependencies/${String(index + 1).padStart(4, '0')}-${safeArchiveBasename(originalName)}`;
}

function ref(path: string, content: Uint8Array): PayloadRef {
  return { path, sha256: sha256Hex(content), size: content.byteLength };
}

function buildManifest(input: {
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt?: string;
  state: PortableProjectManifest['state'];
  dependencies: PortableCadDependencyRef[];
  identity: PortableProjectIdentity;
}): PortableProjectManifest {
  const projectId = requireText(input.projectId, 'projectId', 120);
  const projectName = requireText(input.projectName, 'projectName', 200);
  const appVersion = requireText(input.appVersion, 'appVersion', 80);
  const createdAt = requireCreatedAt(input.createdAt ?? new Date().toISOString());
  return {
    archiveType: PORTABLE_PROJECT_ARCHIVE_TYPE,
    schemaVersion: PORTABLE_PROJECT_SCHEMA_VERSION,
    coreSchemaVersion: PORTABLE_PROJECT_CORE_SCHEMA_VERSION,
    appVersion,
    createdAt,
    project: { id: projectId, name: projectName, identity: input.identity },
    state: input.state,
    dependencies: input.dependencies,
    integrity: INTEGRITY,
    restoreMode: 'archive-api-only',
    unsupported: [...UNSUPPORTED_MODULES]
  };
}

/**
 * 构造版本化工程 ZIP。仅进行档案层校验，不写入全局 localStorage，也不改变当前打开的工程。
 * state JSON 以原文写入；读取端校验后仍返回原始 JSON 字符串，避免归一化时静默丢字段。
 */
export function buildPortableProjectArchive(sources: PortableProjectArchiveSources): PortableProjectArchive {
  const featureTree = stateBytes(sources.featureTreeJson, '特征树', validateFeatureTreeJson);
  const kinematics = stateBytes(sources.kinematicsJson, '运动学标注', validateKinematicsJson);
  const viewState = stateBytes(sources.viewStateJson, '视角状态', validateViewStateJson);
  const rawDependencies = sources.dependencies ?? [];
  if (!Array.isArray(rawDependencies) || rawDependencies.length > PORTABLE_PROJECT_LIMITS.maxDependencies) {
    throw new Error(`CAD 依赖数量不得超过 ${PORTABLE_PROJECT_LIMITS.maxDependencies}`);
  }

  const payloads: InternalPayload[] = [];
  const state: PortableProjectManifest['state'] = {
    featureTree: null,
    kinematics: null,
    viewState: null,
    omitted: validateExcludedState(sources.excludedState ?? [])
  };
  const addState = (kind: StateKind, value: { bytes: Uint8Array; schemaVersion: number } | null, path: string): void => {
    if (!value) return;
    state[kind] = { ...ref(path, value.bytes), schemaVersion: value.schemaVersion };
    payloads.push({ path, role: kind, content: value.bytes });
  };
  addState('featureTree', featureTree, PORTABLE_PROJECT_ENTRIES.featureTree);
  addState('kinematics', kinematics, PORTABLE_PROJECT_ENTRIES.kinematics);
  addState('viewState', viewState, PORTABLE_PROJECT_ENTRIES.viewState);

  const dependencies: PortableCadDependencyRef[] = rawDependencies.map((dependency, index) => {
    if (!isRecord(dependency) || !(dependency.content instanceof Uint8Array)) {
      throw new Error(`第 ${index + 1} 个 CAD 依赖格式无效`);
    }
    const originalName = requireText(dependency.originalName, `第 ${index + 1} 个 CAD 依赖文件名`, 240);
    const format = cadFormatFromName(originalName);
    const content = new Uint8Array(dependency.content.buffer, dependency.content.byteOffset, dependency.content.byteLength);
    if (content.byteLength === 0) throw new Error(`CAD 依赖文件不能为空：${originalName}`);
    if (content.byteLength > PORTABLE_PROJECT_LIMITS.maxDependencyBytes) {
      throw new Error(`CAD 依赖文件超过 ${PORTABLE_PROJECT_LIMITS.maxDependencyBytes} 字节上限：${originalName}`);
    }
    const path = dependencyPath(index, originalName);
    const item = { ...ref(path, content), originalName, format };
    payloads.push({ path, role: 'cadDependency', content });
    return item;
  });

  validateStateDependencies(sources.featureTreeJson, sources.kinematicsJson, dependencies);
  const projectIdentity = projectIdentityForBuild(sources.identity, dependencies, sources.projectId);
  validateProjectStateBinding(sources.projectId, projectIdentity, sources.featureTreeJson, sources.kinematicsJson);

  if (payloads.length === 0) throw new Error('工程档案至少需要一个状态快照或 CAD 依赖文件');
  if (payloads.length + 1 > PORTABLE_PROJECT_LIMITS.maxEntries) throw new Error('工程档案条目过多');
  const totalBytes = payloads.reduce((sum, payload) => sum + payload.content.byteLength, 0);
  if (totalBytes > PORTABLE_PROJECT_LIMITS.maxTotalUncompressedBytes) throw new Error('工程档案解压后总大小超过上限');

  const manifest = buildManifest({
    projectId: sources.projectId,
    projectName: sources.projectName,
    appVersion: sources.appVersion,
    ...(sources.createdAt !== undefined ? { createdAt: sources.createdAt } : {}),
    state,
    dependencies,
    identity: projectIdentity
  });
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > PORTABLE_PROJECT_LIMITS.maxManifestBytes) {
    throw new Error('工程 manifest 超过大小上限');
  }
  const entries: ZipEntry[] = payloads.map((payload) => ({ path: payload.path, content: payload.content }));
  entries.push({ path: PORTABLE_PROJECT_ENTRIES.manifest, content: JSON.stringify(manifest, null, 2) });
  const bytes = createZip(entries);
  if (bytes.byteLength > PORTABLE_PROJECT_LIMITS.maxArchiveBytes) throw new Error('工程档案 ZIP 超过压缩文件大小上限');
  return { bytes, manifest, sha256: sha256Hex(bytes) };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error(`${label}结构不兼容或含未知字段`);
  return value;
}

function validatePayloadRef(value: unknown, label: string): PayloadRef {
  const raw = exactRecord(value, ['path', 'sha256', 'size'], label);
  const path = normalizeZipPath(raw.path);
  if (raw.path !== path) throw new Error(`${label}路径必须是规范相对路径`);
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error(`${label} SHA-256 格式错误`);
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) <= 0) throw new Error(`${label} size 必须是正整数`);
  return { path, sha256: raw.sha256, size: raw.size as number };
}

function validateStateRef(value: unknown, label: string, path: string, allowedSchemas: readonly number[]): StateRef | null {
  if (value === null) return null;
  const raw = exactRecord(value, ['path', 'sha256', 'size', 'schemaVersion'], label);
  const base = validatePayloadRef({ path: raw.path, sha256: raw.sha256, size: raw.size }, label);
  if (base.path !== path) throw new Error(`${label}必须位于固定路径 ${path}`);
  if (typeof raw.schemaVersion !== 'number' || !allowedSchemas.includes(raw.schemaVersion)) {
    throw new Error(`${label} schema 版本不兼容：${String(raw.schemaVersion)}`);
  }
  return { ...base, schemaVersion: raw.schemaVersion };
}

function parseManifest(text: string): PortableProjectManifest {
  const raw = parseJsonObject(text, '工程 manifest');
  exactRecord(raw, [
    'archiveType', 'schemaVersion', 'coreSchemaVersion', 'appVersion', 'createdAt', 'project',
    'state', 'dependencies', 'integrity', 'restoreMode', 'unsupported'
  ], '工程 manifest');
  if (raw.archiveType !== PORTABLE_PROJECT_ARCHIVE_TYPE) throw new Error('未知工程档案格式，已拒绝导入');
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== PORTABLE_PROJECT_SCHEMA_VERSION)
    || raw.coreSchemaVersion !== PORTABLE_PROJECT_CORE_SCHEMA_VERSION) {
    throw new Error(`工程档案 schema 版本不兼容：archive=${String(raw.schemaVersion)} core=${String(raw.coreSchemaVersion)}`);
  }
  const schemaVersion = raw.schemaVersion;
  const project = exactRecord(raw.project, schemaVersion === 1 ? ['id', 'name'] : ['id', 'name', 'identity'], 'project');
  const stateRaw = exactRecord(raw.state,
    schemaVersion === 1 ? ['featureTree', 'kinematics', 'viewState'] : ['featureTree', 'kinematics', 'viewState', 'omitted'],
    'state');
  const featureTree = validateStateRef(stateRaw.featureTree, 'featureTree', PORTABLE_PROJECT_ENTRIES.featureTree, [1, 2]);
  const kinematics = validateStateRef(
    stateRaw.kinematics,
    'kinematics',
    PORTABLE_PROJECT_ENTRIES.kinematics,
    schemaVersion === 1 ? [1] : [1, 2]
  );
  const viewState = validateStateRef(stateRaw.viewState, 'viewState', PORTABLE_PROJECT_ENTRIES.viewState, [1]);
  const omitted = schemaVersion === 1 ? [] : validateExcludedState(stateRaw.omitted);
  if (!Array.isArray(raw.dependencies) || raw.dependencies.length > PORTABLE_PROJECT_LIMITS.maxDependencies) {
    throw new Error('工程 manifest dependencies 必须是受限长度数组');
  }
  const dependencies: PortableCadDependencyRef[] = raw.dependencies.map((item, index) => {
    const dep = exactRecord(item, ['path', 'sha256', 'size', 'originalName', 'format'], `dependencies[${index}]`);
    const base = validatePayloadRef({ path: dep.path, sha256: dep.sha256, size: dep.size }, `dependencies[${index}]`);
    const originalName = requireText(dep.originalName, `dependencies[${index}].originalName`, 240);
    const format = cadFormatFromName(originalName);
    if (dep.format !== format) throw new Error(`CAD 依赖格式与原始文件名不匹配：${originalName}`);
    const expectedPath = dependencyPath(index, originalName);
    if (base.path !== expectedPath) throw new Error(`CAD 依赖路径不符合档案规范：${base.path}`);
    return { ...base, originalName, format };
  });
  const projectId = requireText(project.id, 'project.id', 120);
  const projectName = requireText(project.name, 'project.name', 200);
  const identity = schemaVersion === 1 ? undefined : validateProjectIdentity(project.identity, dependencies, projectId);

  const integrity = exactRecord(raw.integrity, ['algorithm', 'scope', 'authenticity'], 'integrity');
  if (integrity.algorithm !== INTEGRITY.algorithm || integrity.scope !== INTEGRITY.scope || integrity.authenticity !== INTEGRITY.authenticity) {
    throw new Error('工程档案完整性声明不兼容');
  }
  if (raw.restoreMode !== 'archive-api-only') throw new Error('工程档案恢复模式不兼容');
  const unsupportedExpected = schemaVersion === 1 ? UNSUPPORTED_V1 : UNSUPPORTED_MODULES;
  if (!Array.isArray(raw.unsupported) || raw.unsupported.length !== unsupportedExpected.length ||
      !raw.unsupported.every((item, index) => item === unsupportedExpected[index])) {
    throw new Error('工程档案 unsupported 能力声明不兼容');
  }
  return {
    archiveType: PORTABLE_PROJECT_ARCHIVE_TYPE,
    schemaVersion,
    coreSchemaVersion: PORTABLE_PROJECT_CORE_SCHEMA_VERSION,
    appVersion: requireText(raw.appVersion, 'appVersion', 80),
    createdAt: requireCreatedAt(raw.createdAt),
    project: {
      id: projectId,
      name: projectName,
      ...(identity ? { identity } : {})
    },
    state: { featureTree, kinematics, viewState, ...(schemaVersion === 1 ? {} : { omitted }) },
    dependencies,
    integrity: INTEGRITY,
    restoreMode: 'archive-api-only',
    unsupported: [...UNSUPPORTED_MODULES]
  };
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}不是合法 UTF-8`);
  }
}

interface RawZipEntry {
  path: string;
  size: number;
  compressedSize: number;
  flags: number;
  method: number;
  localOffset: number;
}

/** 在 ZIP 库可能规范化 entryName 之前，检查中央目录原始路径与大小字段。 */
function scanRawZipDirectory(bytes: Buffer, limits: typeof PORTABLE_PROJECT_LIMITS): RawZipEntry[] {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const minOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  const eocdOffset = bytes.lastIndexOf(eocdSignature);
  if (eocdOffset < minOffset || eocdOffset < 0 || eocdOffset + 22 > bytes.byteLength) {
    throw new Error('工程档案缺少有效 ZIP 结束目录');
  }
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) throw new Error('ZIP 结束目录后含有额外数据');
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const directoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const directorySize = bytes.readUInt32LE(eocdOffset + 12);
  const directoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) throw new Error('多卷 ZIP 不受支持');
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 工程档案版本不受支持');
  }
  if (totalEntries === 0 || totalEntries > limits.maxEntries) throw new Error('工程档案 ZIP 条目数量超出限制或为空');
  if (directoryOffset + directorySize !== eocdOffset) throw new Error('ZIP 中央目录位置或长度不合法');

  const entries: RawZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocdOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录记录损坏');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > eocdOffset || size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP 中央目录大小字段无效或使用不支持的 ZIP64');
    }
    if (diskStart !== 0) throw new Error('多卷 ZIP 不受支持');
    if ((flags & 1) !== 0 || (flags & ~0x080e) !== 0) throw new Error('加密或含不支持标志的 ZIP 条目不受支持');
    if (method !== 0 && method !== 8) throw new Error(`ZIP 压缩方法不受支持：${method}`);
    const rawName = decodeUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength), 'ZIP 条目路径');
    const normalized = normalizeZipPath(rawName);
    if (normalized !== rawName) throw new Error(`ZIP 条目路径不是规范格式：${rawName}`);
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) throw new Error(`ZIP 条目重复或存在大小写别名：${rawName}`);
    seen.add(folded);
    if (size > limits.maxDependencyBytes) throw new Error(`ZIP 条目超过单文件上限：${rawName}`);
    expandedBytes += size;
    if (expandedBytes > limits.maxTotalUncompressedBytes) throw new Error('工程档案解压后总大小超过上限');
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏：${rawName}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const localName = decodeUtf8(bytes.subarray(localNameStart, localNameStart + localNameLength), 'ZIP 本地条目路径');
    if (localName !== rawName || localFlags !== flags || localMethod !== method || dataStart + compressedSize > directoryOffset) {
      throw new Error(`ZIP 本地文件头与中央目录不匹配：${rawName}`);
    }
    entries.push({ path: normalized, size, compressedSize, flags, method, localOffset });
    cursor = recordEnd;
  }
  if (cursor !== directoryOffset + directorySize) throw new Error('ZIP 中央目录条目数与长度不匹配');
  return entries;
}

/**
 * 严格验证 ZIP 与所有 SHA-256，并只返回未应用到当前工程的候选载荷。
 * 拒绝路径穿越、重复/别名路径、额外条目、缺失依赖、超限、未知格式和 schema。
 */
export function parsePortableProjectArchive(value: Uint8Array): PortableProjectCandidate {
  const limits = PORTABLE_PROJECT_LIMITS;
  if (!(value instanceof Uint8Array) || value.byteLength < 4) throw new Error('工程档案不是有效 ZIP');
  if (value.byteLength > limits.maxArchiveBytes) throw new Error('工程档案 ZIP 超过压缩文件大小上限');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('未知工程档案格式，已拒绝导入');
  const rawEntries = scanRawZipDirectory(bytes, limits);

  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new Error('工程档案 ZIP 结构损坏');
  }
  let entries: ReturnType<AdmZip['getEntries']>;
  try {
    entries = zip.getEntries();
  } catch {
    throw new Error('工程档案 ZIP 目录损坏');
  }
  if (entries.length !== rawEntries.length) throw new Error('ZIP 库解析条目数与原始中央目录不一致');

  const rawByPath = new Map(rawEntries.map((entry) => [entry.path, entry]));
  const byPath = new Map<string, (typeof entries)[number]>();
  const canonicalNames = new Set<string>();
  let declaredExpandedBytes = 0;
  for (const entry of entries) {
    const rawEntry = rawByPath.get(entry.entryName);
    if (!rawEntry || entry.entryName !== rawEntry.path) throw new Error('ZIP 库解析的路径与原始中央目录不一致');
    const rawName = entry.entryName;
    const normalized = normalizeZipPath(rawName);
    if (normalized !== rawName) throw new Error(`ZIP 条目路径不是规范格式：${rawName}`);
    const folded = normalized.toLowerCase();
    if (canonicalNames.has(folded)) throw new Error(`ZIP 条目重复或存在大小写别名：${rawName}`);
    canonicalNames.add(folded);
    const header = entry.header as unknown as { size?: unknown; flags?: unknown };
    if (typeof header.flags === 'number' && (header.flags & 1) !== 0) throw new Error(`ZIP 加密条目不受支持：${rawName}`);
    if (typeof header.size !== 'number' || !Number.isSafeInteger(header.size) || header.size < 0) throw new Error(`ZIP 条目大小无效：${rawName}`);
    if (header.size > limits.maxDependencyBytes) throw new Error(`ZIP 条目超过单文件上限：${rawName}`);
    declaredExpandedBytes += header.size;
    if (declaredExpandedBytes > limits.maxTotalUncompressedBytes) throw new Error('工程档案解压后总大小超过上限');
    byPath.set(normalized, entry);
  }

  const manifestEntry = byPath.get(PORTABLE_PROJECT_ENTRIES.manifest);
  if (!manifestEntry) throw new Error('工程档案缺少 manifest.json');
  if (manifestEntry.header.size > limits.maxManifestBytes) throw new Error('工程 manifest 超过大小上限');
  let manifestText: string;
  try {
    manifestText = decodeUtf8(manifestEntry.getData(), '工程 manifest');
  } catch (error) {
    throw error instanceof Error ? error : new Error('工程 manifest 无法读取');
  }
  const manifest = parseManifest(manifestText);

  const expected = new Map<string, { ref: PayloadRef; role: PayloadRole }>();
  const addExpected = (refValue: PayloadRef | null, role: PayloadRole): void => {
    if (!refValue) return;
    if (expected.has(refValue.path)) throw new Error(`manifest 声明重复路径：${refValue.path}`);
    const perFileLimit = role === 'cadDependency' ? limits.maxDependencyBytes : limits.maxStateBytes;
    if (refValue.size > perFileLimit) throw new Error(`manifest 声明文件超过大小上限：${refValue.path}`);
    expected.set(refValue.path, { ref: refValue, role });
  };
  addExpected(manifest.state.featureTree, 'featureTree');
  addExpected(manifest.state.kinematics, 'kinematics');
  addExpected(manifest.state.viewState, 'viewState');
  manifest.dependencies.forEach((dependency) => addExpected(dependency, 'cadDependency'));

  const expectedPaths = new Set([PORTABLE_PROJECT_ENTRIES.manifest, ...expected.keys()]);
  if (byPath.size !== expectedPaths.size || [...byPath.keys()].some((path) => !expectedPaths.has(path))) {
    throw new Error('工程 ZIP 包含未声明条目，或 manifest 引用了缺失依赖');
  }
  if (expected.size === 0) throw new Error('工程档案没有可恢复状态或 CAD 依赖');

  const verified = new Map<string, Uint8Array>();
  for (const [path, item] of expected) {
    const entry = byPath.get(path);
    if (!entry) throw new Error(`工程档案缺少依赖文件：${path}`);
    if (entry.header.size !== item.ref.size) throw new Error(`文件大小不匹配：${path}`);
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new Error(`ZIP 条目无法解压：${path}`);
    }
    if (data.byteLength !== item.ref.size) throw new Error(`解压大小不匹配：${path}`);
    if (sha256Hex(data) !== item.ref.sha256) throw new Error(`SHA-256 校验失败：${path}`);
    verified.set(path, new Uint8Array(data));
  }

  const readState = (stateRef: StateRef | null, label: string, validate: (text: string) => number): string | null => {
    if (!stateRef) return null;
    const text = decodeUtf8(verified.get(stateRef.path)!, label);
    const schemaVersion = validate(text);
    if (schemaVersion !== stateRef.schemaVersion) throw new Error(`${label} schema 版本与 manifest 不匹配`);
    return text;
  };
  const featureTreeJson = readState(manifest.state.featureTree, '特征树', validateFeatureTreeJson);
  const kinematicsJson = readState(manifest.state.kinematics, '运动学标注', validateKinematicsJson);
  const viewStateJson = readState(manifest.state.viewState, '视角状态', validateViewStateJson);
  validateStateDependencies(featureTreeJson ?? undefined, kinematicsJson ?? undefined, manifest.dependencies);
  if (manifest.project.identity) {
    validateProjectStateBinding(
      manifest.project.id,
      manifest.project.identity,
      featureTreeJson ?? undefined,
      kinematicsJson ?? undefined
    );
  }
  const dependencies = manifest.dependencies.map((dependency) => ({
    originalName: dependency.originalName,
    format: dependency.format,
    content: new Uint8Array(verified.get(dependency.path)!)
  }));
  return { manifest, featureTreeJson, kinematicsJson, viewStateJson, dependencies };
}

function validateProjectStateBinding(
  projectId: string,
  identity: PortableProjectIdentity,
  featureTreeJson: string | undefined,
  kinematicsJson: string | undefined
): void {
  if (featureTreeJson) {
    const feature = parseJsonObject(featureTreeJson, '特征树');
    if (feature.projectId !== undefined && feature.projectId !== projectId) {
      throw new Error('特征树 projectId 与档案工程 ID 不匹配');
    }
    const sourceName = sourceFileFromJson(featureTreeJson, '特征树');
    if (sourceName && sourceName.toLowerCase() !== identity.sourceName.toLowerCase()) {
      throw new Error('特征树引用的 CAD 源与 project.identity 不匹配');
    }
  }
  if (!kinematicsJson) return;
  const annotation = parseJsonObject(kinematicsJson, '运动学标注');
  const sourceName = sourceFileFromJson(kinematicsJson, '运动学标注');
  if (sourceName && sourceName.toLowerCase() !== identity.sourceName.toLowerCase()) {
    throw new Error('运动学标注引用的 CAD 源与 project.identity 不匹配');
  }
  if (annotation.version !== 2) return;
  if (annotation.projectId !== projectId) throw new Error('运动学标注 projectId 与档案工程 ID 不匹配');
  const available = new Set(identity.modelObjects.map((object) => object.objectId));
  if (!Array.isArray(annotation.parts)) throw new Error('运动学标注 parts 结构无效');
  for (const [partIndex, rawPart] of annotation.parts.entries()) {
    if (!isRecord(rawPart) || !Array.isArray(rawPart.meshObjectIds)) throw new Error(`运动学 parts[${partIndex}] 缺少稳定对象 ID`);
    for (const objectId of rawPart.meshObjectIds) {
      if (typeof objectId !== 'string' || !available.has(objectId)) {
        throw new Error(`运动学 parts[${partIndex}] 引用了缺失或歧义的 CAD 对象`);
      }
    }
  }
}
