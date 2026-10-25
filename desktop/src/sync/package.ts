import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { buildMachineIoMap } from '../machine/io-map.ts';
import { validateMachineConfig, type MachineConfig } from '../commission/machine-config.ts';
import { PLC_TARGETS, type PlcTarget } from '../plcgen/types.ts';
import { PLCGEN_VERSION } from '../plcgen/st.ts';
import {
  DESIGN_MANIFEST_SCHEMA_VERSION,
  PLC_SYNC_EXTENSION_SCHEMA_VERSION,
  type DesignBomRow,
  type DesignFileEntry,
  type DesignFileKind,
  type DesignManifest,
  type DesignPlcManifest,
  type SyncImportCandidate,
  type SyncPlcFileRecord,
  type SyncPlcUploadPayload
} from './types.ts';

export const PACKAGE_ENTRIES = {
  bom: 'bom.csv',
  pdf: 'report.pdf',
  glb: 'model.glb',
  dxf: 'drawing.dxf',
  manifest: 'manifest.json',
  plcIoMap: 'plc/machine-io-map.csv'
} as const;

/** 同步服务现有 UI 限制；解析端也独立执行，不能只依赖 UI。 */
export const MAX_DESIGN_PACKAGE_BYTES = 200 * 1024 * 1024;
export const MAX_PLC_FILE_BYTES = 1024 * 1024;
export const MAX_PLC_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_PLC_PROGRAM_FILES = 10;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const PLC_PROGRAM_PATHS = [
  'plc/src/OB1_Main.st',
  'plc/src/DB_IO.st',
  'plc/src/FB_Cylinder.st',
  'plc/src/FB_Gripper.st',
  'plc/src/FB_RotaryAxis.st',
  'plc/src/FC_AutoSequence.st',
  'plc/src/FC_Alarms.st',
  'plc/src/FC_Safety.st',
  'plc/io-tags.csv',
  'plc/mapping.json'
] as const;
const PLC_PROGRAM_PATH_SET = new Set<string>(PLC_PROGRAM_PATHS);
const LEGACY_PATH_KIND: Readonly<Record<string, DesignFileKind>> = {
  [PACKAGE_ENTRIES.bom]: 'BOM',
  [PACKAGE_ENTRIES.pdf]: 'PDF',
  [PACKAGE_ENTRIES.glb]: 'GLTF',
  [PACKAGE_ENTRIES.dxf]: 'DXF'
};
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b[A-Za-z0-9_-]*(?:api[_ -]?(?:key|token|secret)|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|secret(?:[_ -]?(?:access[_ -]?)?key)?|private[_ -]?key|password|passwd|pwd|credential|authorization|token)\b\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/
];

export interface DesignPackageSources {
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt?: string;
  bom: readonly DesignBomRow[];
  bomCsv?: string | Uint8Array;
  pdf?: Uint8Array;
  glb?: Uint8Array;
  dxf?: string | Uint8Array;
  plc?: SyncPlcUploadPayload;
}

export interface DesignPackageBuild {
  zip: Uint8Array;
  manifest: DesignManifest;
  manifestJson: string;
  zipSha256: string;
  skipped: string[];
}

export interface DesignPackagePolicy {
  allowPlc?: boolean;
}

interface SourceFile {
  path: string;
  kind: DesignFileKind;
  value: string | Uint8Array | undefined;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 按运行环境时区生成带偏移的 ISO 时间，例如 2026-10-22T22:00:00+08:00。 */
export function toLocalIsoString(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('日期无效');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
  const year = String(date.getFullYear()).padStart(4, '0');
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${offset}`;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateCreatedAt(createdAt: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt)) throw new Error('createdAt 必须带时区偏移');
  if (!ISO_WITH_OFFSET.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('createdAt 必须是合法的 ISO 时间');
  }
  return createdAt;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/.test(part));
}

export function validatePlcText(value: string, path: string): Uint8Array {
  const bytes = bytesOf(value);
  if (bytes.byteLength === 0) throw new Error(`PLC 文件不能为空：${path}`);
  if (bytes.byteLength > MAX_PLC_FILE_BYTES) throw new Error(`PLC 文件超过 1 MiB 上限：${path}`);
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`PLC 文件疑似包含密钥或凭据，已拒绝打包：${path}`);
  }
  return bytes;
}

function requirePlcTarget(value: unknown): PlcTarget {
  if (typeof value !== 'string' || !PLC_TARGETS.includes(value as PlcTarget)) {
    throw new Error('PLC target 不受支持');
  }
  return value as PlcTarget;
}

function requireVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}必须是 1–64 字符的非空版本字符串`);
  }
  return value.trim();
}

function buildPlcExtension(plc: SyncPlcUploadPayload, zip: AdmZip): DesignPlcManifest {
  const target = requirePlcTarget(plc.target);
  const generatedVersion = requireVersion(plc.generatedVersion, 'PLC generatedVersion');
  if (generatedVersion !== PLCGEN_VERSION) throw new Error(`不支持的 PLC generatedVersion：${generatedVersion}`);
  const machineId = requireText(plc.machineId, 'PLC machineId');
  if (machineId.length > 128 || /[\u0000-\u001f\u007f]/.test(machineId)) throw new Error('PLC machineId 格式不合法');
  if (!Array.isArray(plc.programFiles) || plc.programFiles.length !== MAX_PLC_PROGRAM_FILES) {
    throw new Error(`PLC 程序文件必须完整包含 ${MAX_PLC_PROGRAM_FILES} 个固定文件`);
  }
  const sourcePaths = new Set<string>();
  const programFiles: SyncPlcFileRecord[] = [];
  let totalBytes = 0;
  for (const file of plc.programFiles) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('PLC 程序文件记录格式不合法');
    const path = `plc/${file.path}`;
    if (!isSafeRelativePath(path) || !PLC_PROGRAM_PATH_SET.has(path)) throw new Error(`PLC 程序路径不在白名单中：${file.path}`);
    if (sourcePaths.has(path)) throw new Error(`PLC 程序路径重复：${file.path}`);
    sourcePaths.add(path);
    const bytes = validatePlcText(file.content, path);
    totalBytes += bytes.byteLength;
    const record: SyncPlcFileRecord = { path, size: bytes.byteLength, sha256: sha256Hex(bytes) };
    programFiles.push(record);
    zip.addFile(path, Buffer.from(bytes));
  }
  if (PLC_PROGRAM_PATHS.some((path) => !sourcePaths.has(path))) throw new Error('PLC 程序文件缺失固定生成产物');

  if (typeof plc.mappingCsv !== 'string') throw new Error('PLC IO mapping 必须是 CSV 文本');
  const mappingPath = PACKAGE_ENTRIES.plcIoMap;
  const mappingBytes = validatePlcText(plc.mappingCsv, mappingPath);
  totalBytes += mappingBytes.byteLength;
  if (totalBytes > MAX_PLC_TOTAL_BYTES) throw new Error('PLC 程序与 IO mapping 总大小超过 8 MiB 上限');
  const mapping: SyncPlcFileRecord = { path: mappingPath, size: mappingBytes.byteLength, sha256: sha256Hex(mappingBytes) };
  zip.addFile(mappingPath, Buffer.from(mappingBytes));

  return {
    schemaVersion: PLC_SYNC_EXTENSION_SCHEMA_VERSION,
    target,
    generatedVersion,
    machineId,
    programFiles,
    mapping
  };
}

/**
 * 打包 BOM/PDF/GLB/DXF，并可选附带严格白名单的 PLC 文本产物。
 * 顶层 schemaVersion 与原 files 不变；PLC 使用独立版本化可选扩展，旧包保持原样。
 */
export function buildDesignPackage(sources: DesignPackageSources, policy: DesignPackagePolicy = {}): DesignPackageBuild {
  if (sources.plc && policy.allowPlc === false) {
    throw new Error('智慧工厂 PLC 同步模块当前已关闭，已拒绝生成包含 PLC 源码或 IO mapping 的设计包。');
  }
  const projectId = requireText(sources.projectId, 'projectId');
  const projectName = requireText(sources.projectName, 'projectName');
  const appVersion = requireText(sources.appVersion, 'appVersion');
  const createdAt = validateCreatedAt(sources.createdAt ?? toLocalIsoString(new Date()));
  const bom = sources.bom.map((row) => {
    if (!Number.isInteger(row.qty) || row.qty <= 0) {
      throw new Error(`BOM 数量必须是正整数：${row.name}`);
    }
    return { ...row };
  });

  const candidates: SourceFile[] = [
    { path: PACKAGE_ENTRIES.bom, kind: 'BOM', value: sources.bomCsv },
    { path: PACKAGE_ENTRIES.pdf, kind: 'PDF', value: sources.pdf },
    { path: PACKAGE_ENTRIES.glb, kind: 'GLTF', value: sources.glb },
    { path: PACKAGE_ENTRIES.dxf, kind: 'DXF', value: sources.dxf }
  ];

  const zip = new AdmZip();
  const files: DesignFileEntry[] = [];
  const skipped: string[] = [];
  let bomBytes: Uint8Array | null = null;
  let sourceBytes = 0;

  for (const candidate of candidates) {
    const bytes = candidate.value === undefined ? null : bytesOf(candidate.value);
    if (bytes === null || bytes.byteLength === 0) {
      skipped.push(candidate.path);
      continue;
    }
    sourceBytes += bytes.byteLength;
    if (sourceBytes > MAX_DESIGN_PACKAGE_BYTES) throw new Error('设计包展开后超过 200 MiB 大小上限');
    if (candidate.kind === 'BOM') bomBytes = bytes;
    const entry: DesignFileEntry = {
      path: candidate.path,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
      kind: candidate.kind
    };
    files.push(entry);
    zip.addFile(candidate.path, Buffer.from(bytes));
  }

  if (files.length === 0) throw new Error('导出文件不存在：BOM/PDF/GLB/DXF 均无有效内容');
  const plc = sources.plc ? buildPlcExtension(sources.plc, zip) : undefined;
  const plcBytes = plc ? [...plc.programFiles, plc.mapping].reduce((sum, file) => sum + file.size, 0) : 0;
  if (sourceBytes + plcBytes > MAX_DESIGN_PACKAGE_BYTES) throw new Error('设计包展开后超过 200 MiB 大小上限');
  const manifest: DesignManifest = {
    schemaVersion: DESIGN_MANIFEST_SCHEMA_VERSION,
    projectId,
    projectName,
    appVersion,
    createdAt,
    bomSha256: bomBytes ? sha256Hex(bomBytes) : '',
    files,
    bom,
    ...(plc ? { plc } : {})
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBytes = Buffer.from(manifestJson, 'utf8');
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('设计包 manifest 超过 1 MiB 大小上限');
  zip.addFile(PACKAGE_ENTRIES.manifest, manifestBytes);
  const zipBytes = new Uint8Array(zip.toBuffer());
  if (zipBytes.byteLength > MAX_DESIGN_PACKAGE_BYTES) throw new Error('设计包超过 200 MiB 大小上限');

  return {
    zip: zipBytes,
    manifest,
    manifestJson,
    zipSha256: sha256Hex(zipBytes),
    skipped
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parseFileRecord(value: unknown, label: string): SyncPlcFileRecord {
  if (!isRecord(value)) throw new Error(`${label}记录必须是对象`);
  if (typeof value.path !== 'string' || !isSafeRelativePath(value.path)) throw new Error(`${label}路径不合法`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) throw new Error(`${label}长度不合法`);
  if (!validSha256(value.sha256)) throw new Error(`${label} SHA-256 不合法`);
  return { path: value.path, size: value.size as number, sha256: value.sha256 };
}

function validateLegacyManifest(value: unknown): DesignManifest {
  if (!isRecord(value) || value.schemaVersion !== DESIGN_MANIFEST_SCHEMA_VERSION) throw new Error('manifest schemaVersion 不兼容');
  for (const field of ['projectId', 'projectName', 'appVersion', 'createdAt', 'bomSha256'] as const) {
    if (typeof value[field] !== 'string') throw new Error(`manifest.${field} 格式不合法`);
  }
  for (const field of ['projectId', 'projectName', 'appVersion'] as const) {
    if (!(value[field] as string).trim()) throw new Error(`manifest.${field} 不能为空`);
  }
  validateCreatedAt(value.createdAt as string);
  if (!Array.isArray(value.files) || !Array.isArray(value.bom)) throw new Error('manifest.files 与 manifest.bom 必须是数组');
  const seen = new Set<string>();
  const files = value.files.map((entry, index): DesignFileEntry => {
    if (!isRecord(entry)) throw new Error(`manifest.files[${index}] 必须是对象`);
    const path = entry.path;
    const kind = entry.kind;
    const size = entry.size;
    if (typeof path !== 'string' || !isSafeRelativePath(path) || path.startsWith('plc/')) throw new Error(`manifest.files[${index}] 路径不合法`);
    if (seen.has(path)) throw new Error(`manifest.files 存在重复路径：${path}`);
    seen.add(path);
    if (typeof kind !== 'string' || !['BOM', 'PDF', 'STEP', 'GLTF', 'DXF'].includes(kind)) throw new Error(`manifest.files[${index}] kind 不受支持`);
    if (!Number.isSafeInteger(size) || (size as number) <= 0 || !validSha256(entry.sha256)) throw new Error(`manifest.files[${index}] 长度或 SHA-256 不合法`);
    if (LEGACY_PATH_KIND[path] !== kind) {
      const extension = path.toLowerCase().slice(path.lastIndexOf('.') + 1);
      const allowed = kind === 'STEP' ? ['step', 'stp'].includes(extension)
        : kind === 'PDF' ? extension === 'pdf'
        : kind === 'GLTF' ? ['gltf', 'glb'].includes(extension)
        : kind === 'DXF' ? extension === 'dxf'
        : false;
      if (!allowed) throw new Error(`manifest 文件类型与路径不匹配：${path}`);
    }
    return { path, kind: kind as DesignFileKind, size: size as number, sha256: entry.sha256 as string };
  });
  if (!/^(?:|[a-f0-9]{64})$/.test(value.bomSha256 as string)) throw new Error('manifest.bomSha256 格式不合法');
  return {
    schemaVersion: DESIGN_MANIFEST_SCHEMA_VERSION,
    projectId: value.projectId as string,
    projectName: value.projectName as string,
    appVersion: value.appVersion as string,
    createdAt: value.createdAt as string,
    bomSha256: value.bomSha256 as string,
    files,
    bom: value.bom as DesignBomRow[],
    ...(value.plc === undefined ? {} : { plc: value.plc as DesignPlcManifest })
  };
}

function validatePlcManifest(value: unknown): DesignPlcManifest {
  if (!isRecord(value) || value.schemaVersion !== PLC_SYNC_EXTENSION_SCHEMA_VERSION) throw new Error('PLC manifest 扩展 schemaVersion 不兼容');
  const target = requirePlcTarget(value.target);
  const generatedVersion = requireVersion(value.generatedVersion, 'PLC generatedVersion');
  if (generatedVersion !== PLCGEN_VERSION) throw new Error(`不支持的 PLC generatedVersion：${generatedVersion}`);
  if (typeof value.machineId !== 'string' || !value.machineId.trim() || value.machineId.length > 128 || /[\u0000-\u001f\u007f]/.test(value.machineId)) {
    throw new Error('PLC manifest machineId 格式不合法');
  }
  if (!Array.isArray(value.programFiles) || value.programFiles.length !== MAX_PLC_PROGRAM_FILES) throw new Error('PLC manifest 程序文件清单不完整');
  const programFiles = value.programFiles.map((entry, index) => parseFileRecord(entry, `PLC programFiles[${index}]`));
  const seen = new Set<string>();
  for (const record of programFiles) {
    if (!PLC_PROGRAM_PATH_SET.has(record.path)) throw new Error(`PLC manifest 路径不在白名单中：${record.path}`);
    if (seen.has(record.path)) throw new Error(`PLC manifest 路径重复：${record.path}`);
    seen.add(record.path);
  }
  if (PLC_PROGRAM_PATHS.some((path) => !seen.has(path))) throw new Error('PLC manifest 缺少固定生成文件');
  const mapping = parseFileRecord(value.mapping, 'PLC mapping');
  if (mapping.path !== PACKAGE_ENTRIES.plcIoMap) throw new Error('PLC mapping 路径不受支持');
  if (seen.has(mapping.path)) throw new Error('PLC mapping 与程序清单路径冲突');
  const totalBytes = [...programFiles, mapping].reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_PLC_TOTAL_BYTES || programFiles.some((entry) => entry.size > MAX_PLC_FILE_BYTES) || mapping.size > MAX_PLC_FILE_BYTES) {
    throw new Error('PLC 程序与 IO mapping 超过大小上限');
  }
  return { schemaVersion: PLC_SYNC_EXTENSION_SCHEMA_VERSION, target, generatedVersion, machineId: value.machineId, programFiles, mapping };
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label}不是合法 UTF-8 文本`);
  }
}

function safeEntryBytes(entry: ReturnType<AdmZip['getEntries']>[number], maxBytes: number, label: string): Uint8Array {
  const declaredSize = entry.header.size;
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) throw new Error(`${label}超过大小上限`);
  let data: Buffer;
  try {
    data = entry.getData();
  } catch {
    throw new Error(`${label}无法解压`);
  }
  if (data.byteLength !== declaredSize) throw new Error(`${label}解压长度与 ZIP 目录不一致`);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * 严格解析下载的候选包，不解压到磁盘、不修改工程。提供机型上下文时重算 IO CSV 并要求
 * machineId 与 mapping SHA-256 同时一致；未提供时只返回要求后续显式应用的候选内容。
 */
export function parseDesignPackage(
  zipBytes: Uint8Array,
  machineContext?: MachineConfig | null,
  policy: DesignPackagePolicy = {}
): SyncImportCandidate {
  if (!(zipBytes instanceof Uint8Array) || zipBytes.byteLength === 0) throw new Error('设计包 ZIP 不能为空');
  if (zipBytes.byteLength > MAX_DESIGN_PACKAGE_BYTES) throw new Error('设计包超过 200 MiB 大小上限');
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength));
  } catch {
    throw new Error('设计包 ZIP 无法解析');
  }
  const entries = zip.getEntries();
  const byPath = new Map<string, (typeof entries)[number]>();
  let declaredTotal = 0;
  for (const entry of entries) {
    const path = entry.entryName;
    if (!isSafeRelativePath(path) || entry.isDirectory) throw new Error(`ZIP 条目路径不安全：${path}`);
    if (byPath.has(path)) throw new Error(`ZIP 存在重复条目：${path}`);
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`ZIP 条目长度不合法：${path}`);
    declaredTotal += size;
    if (declaredTotal > MAX_DESIGN_PACKAGE_BYTES) throw new Error('设计包解压后超过 200 MiB 大小上限');
    byPath.set(path, entry);
  }
  const manifestEntry = byPath.get(PACKAGE_ENTRIES.manifest);
  if (!manifestEntry) throw new Error('设计包缺少 manifest.json');
  const manifestBytes = safeEntryBytes(manifestEntry, MAX_MANIFEST_BYTES, 'manifest');
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(decodeUtf8(manifestBytes, 'manifest')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes('合法 UTF-8')) throw error;
    throw new Error('manifest JSON 格式不合法');
  }
  const manifest = validateLegacyManifest(rawManifest);
  if (manifest.plc !== undefined && policy.allowPlc === false) {
    throw new Error('智慧工厂 PLC 同步模块当前已关闭，已拒绝读取或应用包含 PLC 源码或 IO mapping 的设计包。');
  }
  const plc = manifest.plc === undefined ? undefined : validatePlcManifest(manifest.plc);
  if (plc) manifest.plc = plc;

  const expected = new Map<string, { size: number; sha256: string; label: string; plc: boolean }>();
  for (const record of manifest.files) expected.set(record.path, { size: record.size, sha256: record.sha256, label: record.path, plc: false });
  if (plc) {
    for (const record of plc.programFiles) expected.set(record.path, { size: record.size, sha256: record.sha256, label: record.path, plc: true });
    expected.set(plc.mapping.path, { size: plc.mapping.size, sha256: plc.mapping.sha256, label: plc.mapping.path, plc: true });
  }
  const expectedPaths = new Set([PACKAGE_ENTRIES.manifest, ...expected.keys()]);
  for (const path of byPath.keys()) if (!expectedPaths.has(path)) throw new Error(`ZIP 包含未声明或不允许的文件：${path}`);
  for (const path of expected.keys()) if (!byPath.has(path)) throw new Error(`ZIP 缺少 manifest 声明的文件：${path}`);

  let actualPlcTotal = 0;
  let bomSha256 = '';
  const parsedProgramFiles: Array<{ path: string; content: string }> = [];
  let mappingCsv = '';
  for (const [path, ref] of expected) {
    const entry = byPath.get(path)!;
    const maxBytes = ref.plc ? MAX_PLC_FILE_BYTES : MAX_DESIGN_PACKAGE_BYTES;
    const bytes = safeEntryBytes(entry, maxBytes, ref.label);
    if (bytes.byteLength !== ref.size) throw new Error(`文件长度与 manifest 不一致：${path}`);
    if (sha256Hex(bytes) !== ref.sha256) throw new Error(`文件 SHA-256 与 manifest 不一致：${path}`);
    if (ref.plc) {
      actualPlcTotal += bytes.byteLength;
      const text = decodeUtf8(bytes, path);
      validatePlcText(text, path);
      if (path === plc?.mapping.path) mappingCsv = text;
      else parsedProgramFiles.push({ path: path.slice('plc/'.length), content: text });
    }
    if (path === PACKAGE_ENTRIES.bom) bomSha256 = sha256Hex(bytes);
  }
  if (actualPlcTotal > MAX_PLC_TOTAL_BYTES) throw new Error('PLC 程序与 IO mapping 解压后超过 8 MiB 上限');
  if (bomSha256 && manifest.bomSha256 !== bomSha256) throw new Error('BOM SHA-256 与 manifest 不一致');
  if (!bomSha256 && manifest.bomSha256 !== '') throw new Error('manifest 声明 BOM SHA-256，但 ZIP 缺少 BOM 文件');

  let machineContextStatus: SyncImportCandidate['machineContextStatus'] = plc ? 'unavailable' : 'not-applicable';
  if (plc && machineContext !== undefined && machineContext !== null) {
    let current: MachineConfig;
    try {
      current = validateMachineConfig(machineContext);
    } catch (error) {
      throw new Error(`当前机型上下文无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (current.id !== plc.machineId) throw new Error(`机型 IO 不匹配：包内机型 ${plc.machineId}，当前机型 ${current.id}`);
    const currentMap = buildMachineIoMap(current).csv;
    if (sha256Hex(currentMap) !== plc.mapping.sha256) {
      throw new Error('机型 IO 不匹配：当前机型生成的 mapping 与包内记录不同');
    }
    machineContextStatus = 'matched';
  }

  return {
    manifest,
    ...(plc ? { plc: { target: plc.target, generatedVersion: plc.generatedVersion, machineId: plc.machineId, programFiles: parsedProgramFiles, mappingCsv } } : {}),
    machineContextStatus,
    requiresExplicitApply: true
  };
}
