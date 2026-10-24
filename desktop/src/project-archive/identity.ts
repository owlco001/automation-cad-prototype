export const PROJECT_IDENTITY_STORAGE_KEY = 'automationcad.project-identities.v1';
export const PROJECT_IDENTITY_REGISTRY_VERSION = 1;

export interface IdentityStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CadProjectIdentity {
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  sourceSize: number;
  identityKey: string;
  persisted: boolean;
}

export type CadProjectIdentityCandidate = CadProjectIdentity;

export interface CadIdentityMesh {
  name: string;
  positions: Float32Array;
  indices: Uint32Array | null;
  path?: string[];
}

export interface CadModelObjectIdentity {
  /** Content-derived object identity. Null means the imported object is ambiguous. */
  objectId: string | null;
  name: string;
  path: string[];
  geometrySha256: string;
  ambiguous: boolean;
}

interface RegistryRecord {
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  sourceSize: number;
  createdAt: string;
}

interface Registry {
  version: 1;
  records: Record<string, RegistryRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSourceName(value: string): string {
  const normalized = value.trim().normalize('NFC');
  if (!normalized || /[\\/\u0000-\u001f\u007f]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error('CAD 来源名称必须是纯文件名');
  }
  return normalized;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function readRegistry(storage: IdentityStorageLike): Registry {
  let text: string | null;
  try {
    text = storage.getItem(PROJECT_IDENTITY_STORAGE_KEY);
  } catch {
    throw new Error('无法读取工程身份登记；为避免错配，已停止身份恢复');
  }
  if (!text) return { version: PROJECT_IDENTITY_REGISTRY_VERSION, records: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error('工程身份登记损坏；为避免错配，已停止身份恢复');
  }
  if (!isRecord(raw) || Object.keys(raw).sort().join('\0') !== 'records\0version'
    || raw.version !== PROJECT_IDENTITY_REGISTRY_VERSION || !isRecord(raw.records)
    || Object.keys(raw.records).length > 1000) {
    throw new Error('工程身份登记版本不兼容；为避免错配，已停止身份恢复');
  }
  const records: Record<string, RegistryRecord> = {};
  const projectIds = new Set<string>();
  for (const [key, value] of Object.entries(raw.records)) {
    if (!isRecord(value)
      || Object.keys(value).sort().join('\0') !== 'createdAt\0projectId\0sourceName\0sourceSha256\0sourceSize'
      || typeof value.projectId !== 'string'
      || !/^acproj-[0-9a-f-]{36}$/i.test(value.projectId)
      || typeof value.sourceName !== 'string'
      || !validSha256(value.sourceSha256)
      || !Number.isSafeInteger(value.sourceSize)
      || (value.sourceSize as number) <= 0
      || typeof value.createdAt !== 'string') {
      throw new Error('工程身份登记含无效记录；为避免错配，已停止身份恢复');
    }
    const normalizedName = normalizeSourceName(value.sourceName);
    if (normalizedName !== value.sourceName || key !== sourceIdentityKey(normalizedName, value.sourceSha256)
      || Number.isNaN(Date.parse(value.createdAt)) || projectIds.has(value.projectId)) {
      throw new Error('工程身份登记存在重复 ID 或错误来源映射；为避免错配，已停止身份恢复');
    }
    projectIds.add(value.projectId);
    records[key] = {
      projectId: value.projectId,
      sourceName: value.sourceName,
      sourceSha256: value.sourceSha256,
      sourceSize: value.sourceSize as number,
      createdAt: value.createdAt
    };
  }
  return { version: PROJECT_IDENTITY_REGISTRY_VERSION, records };
}

function uuid(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.randomUUID) throw new Error('当前运行环境无法安全生成工程 ID');
  return `acproj-${cryptoApi.randomUUID()}`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('当前运行环境不支持 SHA-256 工程身份校验');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const result = await cryptoApi.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sourceIdentityKey(name: string, sourceSha256: string): string {
  return `${encodeURIComponent(name)}:${sourceSha256}`;
}

/** Compute a stable identity without writing a new record to storage. */
export async function prepareCadProjectIdentity(
  sourceNameValue: string,
  sourceBytes: Uint8Array,
  storage: IdentityStorageLike,
  options: { now?: () => Date; createId?: () => string } = {}
): Promise<CadProjectIdentityCandidate> {
  const sourceName = normalizeSourceName(sourceNameValue);
  if (!(sourceBytes instanceof Uint8Array) || sourceBytes.byteLength <= 0) throw new Error('CAD 原始字节为空或无效');
  const sourceSha256 = await digest(sourceBytes);
  const identityKey = sourceIdentityKey(sourceName, sourceSha256);
  const registry = readRegistry(storage);
  const existing = registry.records[identityKey];
  if (existing) {
    if (existing.sourceName !== sourceName || existing.sourceSha256 !== sourceSha256 || existing.sourceSize !== sourceBytes.byteLength) {
      throw new Error('工程身份登记与当前 CAD 原件不一致；为避免错配，已停止恢复');
    }
    return {
      projectId: existing.projectId,
      sourceName,
      sourceSha256,
      sourceSize: sourceBytes.byteLength,
      identityKey,
      persisted: true
    };
  }

  const projectId = (options.createId ?? uuid)();
  if (!/^acproj-[0-9a-f-]{36}$/i.test(projectId)) throw new Error('工程 ID 生成器返回无效 ID');
  if (Object.values(registry.records).some((record) => record.projectId === projectId)) {
    throw new Error('工程 ID 与另一 CAD 来源重复；为避免状态串用，已停止身份登记');
  }
  if (Object.keys(registry.records).length >= 1000) throw new Error('工程身份登记达到安全上限，无法新增工程身份');
  return {
    projectId,
    sourceName,
    sourceSha256,
    sourceSize: sourceBytes.byteLength,
    identityKey,
    persisted: false
  };
}

/** Persist a prepared identity only after the caller has validated the CAD payload. */
export function commitCadProjectIdentity(
  candidate: CadProjectIdentityCandidate,
  storage: IdentityStorageLike,
  options: { now?: () => Date } = {}
): CadProjectIdentity {
  const sourceName = normalizeSourceName(candidate.sourceName);
  if (!validSha256(candidate.sourceSha256)
    || !Number.isSafeInteger(candidate.sourceSize)
    || candidate.sourceSize <= 0
    || candidate.identityKey !== sourceIdentityKey(sourceName, candidate.sourceSha256)
    || !/^acproj-[0-9a-f-]{36}$/i.test(candidate.projectId)
    || typeof candidate.persisted !== 'boolean') {
    throw new Error('工程身份候选无效；为避免状态错配，已停止登记');
  }
  const registry = readRegistry(storage);
  const existing = registry.records[candidate.identityKey];
  if (existing) {
    if (existing.sourceName !== sourceName
      || existing.sourceSha256 !== candidate.sourceSha256
      || existing.sourceSize !== candidate.sourceSize
      || (candidate.persisted && existing.projectId !== candidate.projectId)) {
      throw new Error('工程身份登记与当前 CAD 原件不一致；为避免错配，已停止恢复');
    }
    return { ...candidate, projectId: existing.projectId, sourceName, persisted: true };
  }
  if (Object.values(registry.records).some((record) => record.projectId === candidate.projectId)) {
    throw new Error('工程 ID 与另一 CAD 来源重复；为避免状态串用，已停止登记');
  }
  if (Object.keys(registry.records).length >= 1000) throw new Error('工程身份登记达到安全上限，无法新增工程身份');
  registry.records[candidate.identityKey] = {
    projectId: candidate.projectId,
    sourceName,
    sourceSha256: candidate.sourceSha256,
    sourceSize: candidate.sourceSize,
    createdAt: (options.now?.() ?? new Date()).toISOString()
  };
  try {
    storage.setItem(PROJECT_IDENTITY_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    throw new Error('无法保存工程身份登记；为避免使用易串用的文件名状态，已停止身份恢复');
  }
  return { ...candidate, sourceName, persisted: true };
}

/**
 * Resolve and persist a logical project ID for callers that already validated their source.
 * The original bytes are hashed; paths are intentionally not persisted or exported.
 */
export async function resolveCadProjectIdentity(
  sourceName: string,
  sourceBytes: Uint8Array,
  storage: IdentityStorageLike,
  options: { now?: () => Date; createId?: () => string } = {}
): Promise<CadProjectIdentity> {
  const candidate = await prepareCadProjectIdentity(sourceName, sourceBytes, storage, options);
  return commitCadProjectIdentity(candidate, storage, options);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Derive CAD object candidates without using array position. Duplicate identical hierarchy/name/geometry
 * records remain ambiguous instead of receiving order-dependent suffixes.
 */
export async function identifyCadModelObjects(
  projectId: string,
  sourceSha256: string,
  meshes: readonly CadIdentityMesh[]
): Promise<CadModelObjectIdentity[]> {
  if (!/^acproj-[0-9a-f-]{36}$/i.test(projectId) || !validSha256(sourceSha256)) {
    throw new Error('工程或 CAD 修订身份无效');
  }
  const records: Array<Omit<CadModelObjectIdentity, 'objectId' | 'ambiguous'> & { provisionalId: string }> = [];
  for (const mesh of meshes) {
    if (!mesh || typeof mesh.name !== 'string' || !(mesh.positions instanceof Float32Array)) {
      throw new Error('CAD 网格身份输入无效');
    }
    const path = (mesh.path ?? []).map((part) => String(part).normalize('NFC'));
    const name = mesh.name.normalize('NFC');
    const positions = new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
    const indices = mesh.indices
      ? new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)
      : new Uint8Array();
    const geometrySha256 = await digest(concat([positions, indices]));
    const identityMaterial = JSON.stringify({ projectId, sourceSha256, name, path, geometrySha256 });
    const provisionalId = `cadobj-${await digest(utf8(identityMaterial))}`;
    records.push({ provisionalId, name, path, geometrySha256 });
  }
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.provisionalId, (counts.get(record.provisionalId) ?? 0) + 1);
  return records.map((record) => {
    const ambiguous = counts.get(record.provisionalId) !== 1;
    return {
      objectId: ambiguous ? null : record.provisionalId,
      name: record.name,
      path: [...record.path],
      geometrySha256: record.geometrySha256,
      ambiguous
    };
  });
}
