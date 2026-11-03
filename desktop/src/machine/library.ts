/**
 * 机型库：`.machine.zip` 包格式与本地库（纯数据，不执行任何机型代码）。
 *
 * 为什么单独一个模块：机型模板不再是仓库里的源码/资源，而是「用户自己攒的包」。
 * 所以格式、校验、落盘都收在这里，命令行、界面和智能体共用一套口径；
 * 导入只认声明过的条目、逐条比对 SHA-256，绝不把没校验完的包留到 userData 里。
 *
 * 包结构（`schemaVersion: 1`）：
 *   manifest.json   { schemaVersion, id, name, version, createdAt, appVersion, files[], configSha256 }
 *   config.json     MachineConfig（必选）
 *   geometry.json   参数化几何/布局（可选；含 layout / form / stationIdentities）
 *   bom.csv         可选
 *   plc/**          可选，≤12 个文件，单文件 ≤1 MiB，合计 ≤8 MiB
 *   shots/**        可选，≤6 张 png/jpg，单张 ≤2 MiB
 *
 * 硬上限：整包 ≤50 MiB、条目 ≤200。
 *
 * 注意：本模块用 Node API（fs / crypto / adm-zip），只能在主进程与脚本里用，
 * 不能被渲染层 import（与 src/sync/MODULE.md 同一条约束）。
 */

import AdmZip from 'adm-zip';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { createZip } from '../shared/zip.ts';
import { validateMachineConfig, type MachineConfig } from '../commission/machine-config.ts';
import {
  activeMachinePath,
  buildMachineBomRows,
  machineBomDraftPath,
  machineDesignPath,
  machineGeometryPaths,
  readTextIfExists,
  renderMachineBomCsv,
  sanitizeMachineId,
  validateMachineDesign,
  writeStoredMachineDesign,
  writeText,
  type NormalizedMachineDesign,
  type StoredMachineDesign
} from './store.ts';

export const MACHINE_PACKAGE_SCHEMA_VERSION = 1 as const;
export const MACHINE_LIBRARY_SCHEMA_VERSION = 1 as const;

const MIB = 1024 * 1024;
const KIB = 1024;

export const MACHINE_LIBRARY_LIMITS = {
  /** 整包（压缩后）字节上限 */
  maxPackageBytes: 50 * MIB,
  /** 条目总数上限（含 manifest.json） */
  maxEntries: 200,
  /** 解压后总量上限：防 zip 炸弹 */
  maxTotalUncompressedBytes: 50 * MIB,
  maxManifestBytes: 256 * KIB,
  maxConfigBytes: 2 * MIB,
  maxGeometryBytes: 8 * MIB,
  maxBomBytes: 2 * MIB,
  maxPlcFiles: 12,
  maxPlcFileBytes: 1 * MIB,
  maxPlcTotalBytes: 8 * MIB,
  maxShotFiles: 6,
  maxShotFileBytes: 2 * MIB
} as const;

export const MACHINE_PACKAGE_PATHS = {
  manifest: 'manifest.json',
  config: 'config.json',
  geometry: 'geometry.json',
  bom: 'bom.csv'
} as const;

export type MachinePackageFileKind = 'config' | 'geometry' | 'bom' | 'plc' | 'shot';

export const MACHINE_PACKAGE_FILE_KINDS: readonly MachinePackageFileKind[] = [
  'config',
  'geometry',
  'bom',
  'plc',
  'shot'
];

export type MachineLibraryErrorCode =
  | 'LIBRARY_BAD_PATH'
  | 'LIBRARY_BAD_ZIP'
  | 'LIBRARY_EXISTS'
  | 'LIBRARY_HASH_MISMATCH'
  | 'LIBRARY_INVALID_CONFIG'
  | 'LIBRARY_IO_FAILED'
  | 'LIBRARY_NOT_FOUND'
  | 'LIBRARY_TOO_LARGE'
  | 'LIBRARY_UNSUPPORTED_SCHEMA';

export class MachineLibraryError extends Error {
  readonly code: MachineLibraryErrorCode;

  constructor(code: MachineLibraryErrorCode, message: string) {
    super(message);
    this.name = 'MachineLibraryError';
    this.code = code;
  }
}

function fail(code: MachineLibraryErrorCode, message: string): never {
  throw new MachineLibraryError(code, message);
}

export interface MachinePackageFileRef {
  path: string;
  sha256: string;
  size: number;
  kind: MachinePackageFileKind;
}

export interface MachinePackageManifest {
  schemaVersion: typeof MACHINE_PACKAGE_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  createdAt: string;
  appVersion: string;
  files: MachinePackageFileRef[];
  configSha256: string;
}

/** 机型库索引项；`catalog.json` 里存的就是这个形状。 */
export interface MachineLibraryEntry {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  sizeBytes: number;
  source: 'local' | 'remote';
}

export interface MachinePackage {
  manifest: MachinePackageManifest;
  config: MachineConfig;
  /** 已逐条校验过 SHA-256 的文件内容，键为包内相对路径 */
  files: Map<string, Buffer>;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Of(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('LIBRARY_BAD_ZIP', `${label}不是合法 UTF-8`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail('LIBRARY_BAD_ZIP', `manifest.${label} 必须是非空字符串`);
  }
  return value.trim();
}

/**
 * 包内条目路径白名单校验（先于 ZIP 库解析调用：adm-zip 会把 `../a` 归一化成 `a`，
 * 只看它给的 entryName 会漏掉穿越条目）。
 */
export function assertMachinePackagePath(value: string): void {
  if (typeof value !== 'string' || !value) fail('LIBRARY_BAD_PATH', 'ZIP 条目路径为空');
  if (value.trim() !== value) fail('LIBRARY_BAD_PATH', `ZIP 条目路径含首尾空白：${JSON.stringify(value)}`);
  if (value.includes('\\')) fail('LIBRARY_BAD_PATH', `ZIP 条目路径不得使用反斜线：${value}`);
  if (/^[A-Za-z]:/.test(value)) fail('LIBRARY_BAD_PATH', `ZIP 条目路径不得带盘符：${value}`);
  if (value.startsWith('/')) fail('LIBRARY_BAD_PATH', `ZIP 条目路径必须是相对路径：${value}`);
  if (value.startsWith('//')) fail('LIBRARY_BAD_PATH', `ZIP 条目路径不得使用 UNC 路径：${value}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) fail('LIBRARY_BAD_PATH', `ZIP 条目路径含控制字符：${value}`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail('LIBRARY_BAD_PATH', `ZIP 条目路径含路径穿越或空段：${value}`);
  }
  if (value.length > 200) fail('LIBRARY_BAD_PATH', `ZIP 条目路径过长：${value.slice(0, 40)}…`);
}

function kindOfPath(path: string): MachinePackageFileKind | null {
  if (path === MACHINE_PACKAGE_PATHS.config) return 'config';
  if (path === MACHINE_PACKAGE_PATHS.geometry) return 'geometry';
  if (path === MACHINE_PACKAGE_PATHS.bom) return 'bom';
  if (/^plc\/[A-Za-z0-9._-]+$/.test(path)) return 'plc';
  if (/^shots\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(path)) return 'shot';
  return null;
}

function perFileLimit(kind: MachinePackageFileKind): number {
  switch (kind) {
    case 'config': return MACHINE_LIBRARY_LIMITS.maxConfigBytes;
    case 'geometry': return MACHINE_LIBRARY_LIMITS.maxGeometryBytes;
    case 'bom': return MACHINE_LIBRARY_LIMITS.maxBomBytes;
    case 'plc': return MACHINE_LIBRARY_LIMITS.maxPlcFileBytes;
    case 'shot': return MACHINE_LIBRARY_LIMITS.maxShotFileBytes;
  }
}

/* ------------------------------------------------------------------ */
/* ZIP 原始中央目录扫描                                                */
/* ------------------------------------------------------------------ */

interface RawZipEntry {
  path: string;
  size: number;
  compressedSize: number;
}

/**
 * 在交给 adm-zip 之前扫原始中央目录：条目名、大小、ZIP64/多卷/加密标志。
 * 路径穿越必须在这一层拦，晚一步名字就被归一化掉了。
 */
function scanRawZipDirectory(bytes: Buffer): RawZipEntry[] {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const minOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  const eocdOffset = bytes.lastIndexOf(eocdSignature);
  if (eocdOffset < 0 || eocdOffset < minOffset || eocdOffset + 22 > bytes.byteLength) {
    fail('LIBRARY_BAD_ZIP', '不是有效的 .machine.zip（缺少 ZIP 结束目录）');
  }
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) {
    fail('LIBRARY_BAD_ZIP', 'ZIP 结束目录之后还有额外数据，已拒绝导入');
  }
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const directoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const directorySize = bytes.readUInt32LE(eocdOffset + 12);
  const directoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) {
    fail('LIBRARY_BAD_ZIP', '多卷 .machine.zip 不受支持');
  }
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail('LIBRARY_BAD_ZIP', 'ZIP64 机型包不受支持');
  }
  if (totalEntries === 0) fail('LIBRARY_BAD_ZIP', '机型包是空的（没有任何条目）');
  if (totalEntries > MACHINE_LIBRARY_LIMITS.maxEntries) {
    fail('LIBRARY_TOO_LARGE', `机型包条目过多：${totalEntries} > ${MACHINE_LIBRARY_LIMITS.maxEntries}`);
  }
  if (directoryOffset + directorySize !== eocdOffset) {
    fail('LIBRARY_BAD_ZIP', 'ZIP 中央目录位置或长度不合法');
  }

  const entries: RawZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocdOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail('LIBRARY_BAD_ZIP', 'ZIP 中央目录记录损坏');
    }
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
      fail('LIBRARY_BAD_ZIP', 'ZIP 中央目录大小字段无效或使用不支持的 ZIP64');
    }
    if (diskStart !== 0) fail('LIBRARY_BAD_ZIP', '多卷 .machine.zip 不受支持');
    if ((flags & 1) !== 0) fail('LIBRARY_BAD_ZIP', '机型包含加密条目，已拒绝导入');
    if ((flags & ~0x080e) !== 0) fail('LIBRARY_BAD_ZIP', '机型包含不支持的 ZIP 标志位');
    if (method !== 0 && method !== 8) fail('LIBRARY_BAD_ZIP', `ZIP 压缩方法不受支持：${method}`);
    const rawName = decodeUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength), 'ZIP 条目路径');
    assertMachinePackagePath(rawName);
    const folded = rawName.toLowerCase();
    if (seen.has(folded)) fail('LIBRARY_BAD_ZIP', `ZIP 条目重复或存在大小写别名：${rawName}`);
    seen.add(folded);
    expandedBytes += size;
    if (expandedBytes > MACHINE_LIBRARY_LIMITS.maxTotalUncompressedBytes) {
      fail('LIBRARY_TOO_LARGE', '机型包解压后总大小超过 50 MiB 上限');
    }
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail('LIBRARY_BAD_ZIP', `ZIP 本地文件头损坏：${rawName}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const localName = decodeUtf8(bytes.subarray(localNameStart, localNameStart + localNameLength), 'ZIP 本地条目路径');
    if (localName !== rawName || localFlags !== flags || localMethod !== method || dataStart + compressedSize > directoryOffset) {
      fail('LIBRARY_BAD_ZIP', `ZIP 本地文件头与中央目录不匹配：${rawName}`);
    }
    entries.push({ path: rawName, size, compressedSize });
    cursor = recordEnd;
  }
  if (cursor !== directoryOffset + directorySize) {
    fail('LIBRARY_BAD_ZIP', 'ZIP 中央目录条目数与长度不匹配');
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* manifest 解析与校验                                                 */
/* ------------------------------------------------------------------ */

function sha256Field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail('LIBRARY_BAD_ZIP', `manifest.${label} 必须是 64 位小写十六进制 SHA-256`);
  }
  return value;
}

export function validateMachinePackageManifest(value: unknown): MachinePackageManifest {
  if (!isRecord(value)) fail('LIBRARY_BAD_ZIP', 'manifest.json 必须是对象');
  const rawVersion = value.schemaVersion;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    fail('LIBRARY_UNSUPPORTED_SCHEMA', 'manifest.schemaVersion 缺失或不是整数，已拒绝导入');
  }
  if (rawVersion !== MACHINE_PACKAGE_SCHEMA_VERSION) {
    fail(
      'LIBRARY_UNSUPPORTED_SCHEMA',
      `机型包 schemaVersion=${rawVersion} 不受支持（本机只认 ${MACHINE_PACKAGE_SCHEMA_VERSION}），请升级软件或换包`
    );
  }
  const id = nonEmptyString(value.id, 'id');
  if (sanitizeMachineId(id) !== id) {
    fail('LIBRARY_BAD_ZIP', `manifest.id 不合法（含路径/控制字符或需要净化）：${id}`);
  }
  const name = nonEmptyString(value.name, 'name');
  const version = nonEmptyString(value.version, 'version');
  const appVersion = nonEmptyString(value.appVersion, 'appVersion');
  const createdAtRaw = nonEmptyString(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(createdAtRaw))) {
    fail('LIBRARY_BAD_ZIP', `manifest.createdAt 不是可解析的时间：${createdAtRaw}`);
  }
  const configSha256 = sha256Field(value.configSha256, 'configSha256');
  if (!Array.isArray(value.files)) fail('LIBRARY_BAD_ZIP', 'manifest.files 必须是数组');
  if (value.files.length === 0) fail('LIBRARY_BAD_ZIP', 'manifest.files 不能为空（至少要 config.json）');

  const files: MachinePackageFileRef[] = [];
  const seen = new Set<string>();
  let plcCount = 0;
  let plcTotal = 0;
  let shotCount = 0;
  let configCount = 0;
  for (const [index, raw] of value.files.entries()) {
    if (!isRecord(raw)) fail('LIBRARY_BAD_ZIP', `manifest.files[${index}] 必须是对象`);
    const path = nonEmptyString(raw.path, `files[${index}].path`);
    assertMachinePackagePath(path);
    if (path === MACHINE_PACKAGE_PATHS.manifest) {
      fail('LIBRARY_BAD_ZIP', 'manifest.json 不能列在自己的 files 里');
    }
    const folded = path.toLowerCase();
    if (seen.has(folded)) fail('LIBRARY_BAD_ZIP', `manifest 声明重复路径：${path}`);
    seen.add(folded);
    const expectedKind = kindOfPath(path);
    if (!expectedKind) {
      fail('LIBRARY_BAD_PATH', `manifest 声明了白名单之外的路径：${path}`);
    }
    if (raw.kind !== expectedKind) {
      fail('LIBRARY_BAD_ZIP', `manifest 中 ${path} 的 kind 应为 ${expectedKind}，实际 ${String(raw.kind)}`);
    }
    const size = raw.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      fail('LIBRARY_BAD_ZIP', `manifest 中 ${path} 的 size 无效`);
    }
    if (size > perFileLimit(expectedKind)) {
      fail(
        'LIBRARY_TOO_LARGE',
        `${path} 超过单文件上限（${size} > ${perFileLimit(expectedKind)} 字节）`
      );
    }
    if (expectedKind === 'config') {
      configCount += 1;
      if (configCount > 1) fail('LIBRARY_BAD_ZIP', 'manifest 只能声明一个 config.json');
    }
    if (expectedKind === 'plc') {
      plcCount += 1;
      plcTotal += size;
      if (plcCount > MACHINE_LIBRARY_LIMITS.maxPlcFiles) {
        fail('LIBRARY_TOO_LARGE', `plc/ 最多 ${MACHINE_LIBRARY_LIMITS.maxPlcFiles} 个文件，包里有 ${plcCount} 个`);
      }
      if (plcTotal > MACHINE_LIBRARY_LIMITS.maxPlcTotalBytes) {
        fail('LIBRARY_TOO_LARGE', `plc/ 合计超过 ${MACHINE_LIBRARY_LIMITS.maxPlcTotalBytes / MIB} MiB 上限`);
      }
    }
    if (expectedKind === 'shot') {
      shotCount += 1;
      if (shotCount > MACHINE_LIBRARY_LIMITS.maxShotFiles) {
        fail('LIBRARY_TOO_LARGE', `shots/ 最多 ${MACHINE_LIBRARY_LIMITS.maxShotFiles} 张，包里有 ${shotCount} 张`);
      }
    }
    files.push({ path, sha256: sha256Field(raw.sha256, `files[${index}].sha256`), size, kind: expectedKind });
  }
  if (configCount !== 1) fail('LIBRARY_BAD_ZIP', '机型包缺少 config.json');
  const configRef = files.find((file) => file.kind === 'config');
  if (!configRef || configRef.sha256 !== configSha256) {
    fail('LIBRARY_HASH_MISMATCH', 'manifest.configSha256 与 config.json 条目的 sha256 不一致');
  }

  return {
    schemaVersion: MACHINE_PACKAGE_SCHEMA_VERSION,
    id,
    name,
    version,
    createdAt: createdAtRaw,
    appVersion,
    files,
    configSha256
  };
}

/* ------------------------------------------------------------------ */
/* 读包                                                                */
/* ------------------------------------------------------------------ */

function verifyPayload(
  manifest: MachinePackageManifest,
  read: (path: string) => Buffer
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const ref of manifest.files) {
    let data: Buffer;
    try {
      data = read(ref.path);
    } catch (error) {
      if (error instanceof MachineLibraryError) throw error;
      fail('LIBRARY_BAD_ZIP', `ZIP 条目无法解压：${ref.path}`);
    }
    if (data.byteLength !== ref.size) {
      fail(
        'LIBRARY_HASH_MISMATCH',
        `${ref.path} 大小与 manifest 不符（${data.byteLength} ≠ ${ref.size} 字节）`
      );
    }
    const digest = sha256Of(data);
    if (digest !== ref.sha256) {
      fail('LIBRARY_HASH_MISMATCH', `${ref.path} SHA-256 校验失败（manifest 声明 ${ref.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
    }
    if (ref.kind === 'config' && digest !== manifest.configSha256) {
      fail('LIBRARY_HASH_MISMATCH', 'config.json 与 manifest.configSha256 不一致');
    }
    if (ref.kind === 'shot') {
      const isPng = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
      const isJpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      if (!isPng && !isJpeg) fail('LIBRARY_BAD_ZIP', `截图 ${ref.path} 不是 PNG/JPEG 内容`);
    }
    files.set(ref.path, data);
  }
  return files;
}

function parseConfigFile(files: Map<string, Buffer>, manifest: MachinePackageManifest): MachineConfig {
  const bytes = files.get(MACHINE_PACKAGE_PATHS.config);
  if (!bytes) fail('LIBRARY_BAD_ZIP', '机型包缺少 config.json');
  const text = decodeUtf8(bytes, 'config.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    fail('LIBRARY_INVALID_CONFIG', `config.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  let config: MachineConfig;
  try {
    config = validateMachineConfig(parsed);
  } catch (error) {
    fail('LIBRARY_INVALID_CONFIG', `config.json 不是合法的机型配置：${error instanceof Error ? error.message : String(error)}`);
  }
  if (sanitizeMachineId(config.id) !== manifest.id) {
    fail(
      'LIBRARY_INVALID_CONFIG',
      `config.id（${config.id}）与 manifest.id（${manifest.id}）不一致，已拒绝导入`
    );
  }
  return config;
}

/**
 * 严格解析一个 `.machine.zip`：原始目录扫描 → 清单 → 条目白名单 → 逐条 SHA-256 → 配置校验。
 * 任何一步不过都抛 `MachineLibraryError`，调用方拿不到半成品。
 */
export function readMachinePackage(value: Uint8Array | Buffer): MachinePackage {
  if (!(value instanceof Uint8Array) || value.byteLength < 4) {
    fail('LIBRARY_BAD_ZIP', '机型包不是有效 ZIP');
  }
  if (value.byteLength > MACHINE_LIBRARY_LIMITS.maxPackageBytes) {
    fail(
      'LIBRARY_TOO_LARGE',
      `机型包 ${value.byteLength} 字节，超过 ${MACHINE_LIBRARY_LIMITS.maxPackageBytes / MIB} MiB 上限`
    );
  }
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    fail('LIBRARY_BAD_ZIP', '未知机型包格式（不是 ZIP），已拒绝导入');
  }

  const rawEntries = scanRawZipDirectory(bytes);
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    fail('LIBRARY_BAD_ZIP', '机型包 ZIP 结构损坏');
  }
  let entries: AdmZip.IZipEntry[];
  try {
    entries = zip.getEntries();
  } catch {
    fail('LIBRARY_BAD_ZIP', '机型包 ZIP 目录损坏');
  }
  if (entries.length !== rawEntries.length) {
    fail('LIBRARY_BAD_ZIP', 'ZIP 库解析条目数与原始中央目录不一致');
  }
  const byPath = new Map<string, AdmZip.IZipEntry>();
  for (const entry of entries) {
    // adm-zip 可能把名字归一化，这里必须与原始中央目录逐字对上。
    if (!rawEntries.some((raw) => raw.path === entry.entryName)) {
      fail('LIBRARY_BAD_ZIP', `ZIP 库解析的条目路径与原始中央目录不一致：${entry.entryName}`);
    }
    byPath.set(entry.entryName, entry);
  }

  const manifestEntry = byPath.get(MACHINE_PACKAGE_PATHS.manifest);
  if (!manifestEntry) fail('LIBRARY_BAD_ZIP', '机型包缺少 manifest.json');
  if (manifestEntry.header.size > MACHINE_LIBRARY_LIMITS.maxManifestBytes) {
    fail('LIBRARY_TOO_LARGE', 'manifest.json 超过 256 KiB 上限');
  }
  const manifestText = decodeUtf8(manifestEntry.getData(), 'manifest.json');
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText) as unknown;
  } catch (error) {
    fail('LIBRARY_BAD_ZIP', `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateMachinePackageManifest(rawManifest);

  const declared = new Set([MACHINE_PACKAGE_PATHS.manifest, ...manifest.files.map((file) => file.path)]);
  for (const path of byPath.keys()) {
    if (!declared.has(path)) fail('LIBRARY_BAD_ZIP', `机型包含未声明条目：${path}`);
  }
  if (byPath.size !== declared.size) {
    const missing = [...declared].filter((path) => !byPath.has(path));
    fail('LIBRARY_BAD_ZIP', `机型包缺少 manifest 声明的条目：${missing.join('、')}`);
  }

  const files = verifyPayload(manifest, (path) => {
    const entry = byPath.get(path);
    if (!entry) fail('LIBRARY_BAD_ZIP', `机型包缺少声明文件：${path}`);
    if (entry.header.size !== undefined) {
      const ref = manifest.files.find((file) => file.path === path);
      if (ref && entry.header.size !== ref.size) {
        fail('LIBRARY_HASH_MISMATCH', `${path} 的 ZIP 头大小与 manifest 不符（${entry.header.size} ≠ ${ref.size} 字节）`);
      }
    }
    return entry.getData();
  });
  const config = parseConfigFile(files, manifest);
  return { manifest, config, files };
}

/* ------------------------------------------------------------------ */
/* 打包                                                                */
/* ------------------------------------------------------------------ */

export interface MachinePackageSourceFile {
  /** 包内路径，例如 `plc/Main.st`、`shots/front.png` */
  path: string;
  content: string | Uint8Array;
}

export interface BuildMachinePackageOptions {
  version?: string;
  appVersion?: string;
  createdAt?: Date;
  plcFiles?: readonly MachinePackageSourceFile[];
  shots?: readonly MachinePackageSourceFile[];
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

/** 从一个已校验的机型方案生成 `.machine.zip` 字节（纯函数，不落盘）。 */
export function buildMachinePackage(
  design: NormalizedMachineDesign,
  options: BuildMachinePackageOptions = {}
): Buffer {
  const config = validateMachineConfig(design.config);
  const now = options.createdAt ?? new Date();
  const id = sanitizeMachineId(config.id);
  if (sanitizeMachineId(id) !== id) fail('LIBRARY_BAD_ZIP', `机型 id 不合法：${config.id}`);

  const payload: Array<{ path: string; content: Buffer; kind: MachinePackageFileKind }> = [];
  payload.push({
    path: MACHINE_PACKAGE_PATHS.config,
    content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'),
    kind: 'config'
  });

  const geometryDoc: Record<string, unknown> = { schemaVersion: 1 };
  if (design.stationGeometryLayout) geometryDoc.layout = design.stationGeometryLayout;
  if (design.form) geometryDoc.form = design.form;
  // stationIdentities 是可选字段（synthMachine 出来的方案不带），缺了就当空数组；
  // 早期版本这里直接 .length，任何没带该字段的方案都会在入库时抛 TypeError。
  const stationIdentities = Array.isArray(design.stationIdentities) ? design.stationIdentities : [];
  if (stationIdentities.length > 0) geometryDoc.stationIdentities = stationIdentities;
  if (design.stationGeometryLayout || design.form) {
    payload.push({
      path: MACHINE_PACKAGE_PATHS.geometry,
      content: Buffer.from(`${JSON.stringify(geometryDoc, null, 2)}\n`, 'utf8'),
      kind: 'geometry'
    });
  }

  const bomItems = design.bomDraft?.items ?? [];
  if (bomItems.length > 0) {
    payload.push({
      path: MACHINE_PACKAGE_PATHS.bom,
      content: Buffer.from(renderMachineBomCsv(buildMachineBomRows(design)), 'utf8'),
      kind: 'bom'
    });
  }

  for (const file of options.plcFiles ?? []) {
    assertMachinePackagePath(file.path);
    if (kindOfPath(file.path) !== 'plc') fail('LIBRARY_BAD_PATH', `PLC 文件路径不合法：${file.path}`);
    payload.push({ path: file.path, content: toBuffer(file.content), kind: 'plc' });
  }
  for (const file of options.shots ?? []) {
    assertMachinePackagePath(file.path);
    if (kindOfPath(file.path) !== 'shot') fail('LIBRARY_BAD_PATH', `截图路径不合法（只收 shots/*.png|jpg）：${file.path}`);
    payload.push({ path: file.path, content: toBuffer(file.content), kind: 'shot' });
  }

  const refs: MachinePackageFileRef[] = payload.map((file) => ({
    path: file.path,
    sha256: sha256Of(file.content),
    size: file.content.byteLength,
    kind: file.kind
  }));
  const configRef = refs.find((ref) => ref.kind === 'config');
  if (!configRef) fail('LIBRARY_BAD_ZIP', '机型包缺少 config.json');

  const manifest: MachinePackageManifest = {
    schemaVersion: MACHINE_PACKAGE_SCHEMA_VERSION,
    id,
    name: config.name,
    version: options.version ?? '1.0.0',
    createdAt: now.toISOString(),
    appVersion: options.appVersion ?? 'unknown',
    files: refs,
    configSha256: configRef.sha256
  };
  // 先自校验一遍清单，避免把不合规的包写出去。
  validateMachinePackageManifest(manifest);

  const entries = [
    { path: MACHINE_PACKAGE_PATHS.manifest, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...payload.map((file) => ({ path: file.path, content: file.content }))
  ];
  if (entries.length > MACHINE_LIBRARY_LIMITS.maxEntries) {
    fail('LIBRARY_TOO_LARGE', `机型包条目过多：${entries.length}`);
  }
  return createZip(entries);
}

/* ------------------------------------------------------------------ */
/* 本地库目录与索引                                                    */
/* ------------------------------------------------------------------ */

export function machineLibraryDirectory(userDataRoot: string): string {
  return join(userDataRoot, 'machine-library');
}

export function machineLibraryCatalogPath(userDataRoot: string): string {
  return join(machineLibraryDirectory(userDataRoot), 'catalog.json');
}

export function machineLibraryEntryDirectory(userDataRoot: string, id: string): string {
  const safeId = sanitizeMachineId(id);
  if (safeId !== id) fail('LIBRARY_BAD_PATH', `机型 id 不合法：${id}`);
  return join(machineLibraryDirectory(userDataRoot), safeId);
}

interface LibraryCatalogFile {
  schemaVersion: typeof MACHINE_LIBRARY_SCHEMA_VERSION;
  entries: MachineLibraryEntry[];
}

function readCatalogFile(userDataRoot: string): MachineLibraryEntry[] {
  const path = machineLibraryCatalogPath(userDataRoot);
  const text = readTextIfExists(path);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    const entries: MachineLibraryEntry[] = [];
    for (const raw of parsed.entries) {
      if (!isRecord(raw)) continue;
      if (typeof raw.id !== 'string') continue;
      const id = raw.id;
      if (sanitizeMachineId(id) !== id) continue;
      entries.push({
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
        version: typeof raw.version === 'string' ? raw.version : '1.0.0',
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
        source: raw.source === 'local' ? 'local' : 'remote'
      });
    }
    return entries;
  } catch (error) {
    recordDiagnosticError('MACHINE_LIBRARY_CATALOG_PARSE_FAILED', error, {
      site: 'desktop/src/machine/library.ts',
      file: 'catalog.json'
    });
    return [];
  }
}

function writeCatalogFile(userDataRoot: string, entries: readonly MachineLibraryEntry[]): void {
  const path = machineLibraryCatalogPath(userDataRoot);
  const payload: LibraryCatalogFile = {
    schemaVersion: MACHINE_LIBRARY_SCHEMA_VERSION,
    entries: [...entries].sort((left, right) => left.id.localeCompare(right.id))
  };
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    mkdirSync(machineLibraryDirectory(userDataRoot), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    fail('LIBRARY_IO_FAILED', `机型库索引写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function directorySize(directory: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += readFileSync(full).byteLength;
    } catch {
      /* 读不到就不计入体积，不影响索引正确性 */
    }
  }
  return total;
}

/** 从 `<id>/manifest.json` 复原一条索引项；目录损坏返回 null。 */
function entryFromDirectory(directory: string): MachineLibraryEntry | null {
  const text = readTextIfExists(join(directory, 'manifest.json'));
  if (!text) return null;
  try {
    const manifest = validateMachinePackageManifest(JSON.parse(text) as unknown);
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      updatedAt: manifest.createdAt,
      sizeBytes: directorySize(directory),
      source: 'local'
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_LIBRARY_ENTRY_PARSE_FAILED', error, {
      site: 'desktop/src/machine/library.ts',
      directory: directory.split(sep).pop() ?? ''
    });
    return null;
  }
}

/**
 * 索引与磁盘对账：目录被手工删掉就从索引里去掉，目录在索引里没有就补上。
 * 索引损坏时按目录重建（不然一次写坏就整个库都读不出来）。
 */
function reconcileCatalog(userDataRoot: string): MachineLibraryEntry[] {
  const root = machineLibraryDirectory(userDataRoot);
  const stored = new Map(readCatalogFile(userDataRoot).map((entry) => [entry.id, entry]));
  const found = new Map<string, MachineLibraryEntry>();
  if (existsSync(root)) {
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const entry = entryFromDirectory(join(root, dirent.name));
      if (!entry || entry.id !== dirent.name) continue;
      const previous = stored.get(entry.id);
      found.set(entry.id, {
        ...entry,
        source: previous ? previous.source : 'local',
        updatedAt: previous?.updatedAt && previous.version === entry.version && previous.sizeBytes === entry.sizeBytes
          ? previous.updatedAt
          : entry.updatedAt
      });
    }
  }
  const changed = found.size !== stored.size || [...found].some(([id, entry]) => {
    const previous = stored.get(id);
    return !previous || previous.version !== entry.version || previous.sizeBytes !== entry.sizeBytes || previous.name !== entry.name;
  });
  const entries = [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (changed) {
    try {
      writeCatalogFile(userDataRoot, entries);
    } catch (error) {
      // 索引只是缓存，写不进去也不该让「读库」失败。
      if (!(error instanceof MachineLibraryError)) throw error;
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* 本地库操作                                                          */
/* ------------------------------------------------------------------ */

/** 列出本地机型库，按 id 升序（实际展示顺序由界面决定）。 */
export function listLibrary(userDataRoot: string): MachineLibraryEntry[] {
  return reconcileCatalog(userDataRoot).sort((left, right) => left.id.localeCompare(right.id));
}

export interface ImportPackageOptions {
  /** 同 id 已存在时是否覆盖；默认 false（必须显式给 true） */
  overwrite?: boolean;
  /** local = 本机保存（saveToLibrary），remote = 外部导入 */
  source?: 'local' | 'remote';
  now?: Date;
}

export interface ImportPackageResult {
  entry: MachineLibraryEntry;
  overwritten: boolean;
}

function writePayloadToDirectory(directory: string, pkg: MachinePackage, manifestText: string): void {
  writeFileSync(join(directory, MACHINE_PACKAGE_PATHS.manifest), manifestText, 'utf8');
  for (const [path, content] of pkg.files) {
    const target = resolve(directory, ...path.split('/'));
    if (!target.startsWith(`${resolve(directory)}${sep}`)) {
      fail('LIBRARY_BAD_PATH', `解析后的落盘路径越出机型目录：${path}`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * 导入一个机型包：先解到 `machine-library/.tmp-<uuid>/`，全部校验通过后原子改名。
 * 任何失败都不会在库目录里留下半包。
 */
export function importPackage(
  userDataRoot: string,
  value: Uint8Array | Buffer,
  options: ImportPackageOptions = {}
): ImportPackageResult {
  const pkg = readMachinePackage(value);
  const { manifest } = pkg;
  const root = machineLibraryDirectory(userDataRoot);
  const target = machineLibraryEntryDirectory(userDataRoot, manifest.id);
  const overwrite = options.overwrite === true;
  const existed = existsSync(target);
  if (existed && !overwrite) {
    fail(
      'LIBRARY_EXISTS',
      `机型库里已有 ${manifest.id}（${manifest.name}）；如需覆盖请显式传 overwrite=true`
    );
  }

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    fail('LIBRARY_IO_FAILED', `机型库目录创建失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const temp = join(root, `.tmp-${randomUUID()}`);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    mkdirSync(temp, { recursive: true });
    writePayloadToDirectory(temp, pkg, manifestText);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (error instanceof MachineLibraryError) throw error;
    fail('LIBRARY_IO_FAILED', `机型包落盘失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let backup: string | null = null;
  try {
    if (existed) {
      backup = join(root, `.old-${randomUUID()}`);
      renameSync(target, backup);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (backup) {
      try {
        renameSync(backup, target);
      } catch (restoreError) {
        recordDiagnosticError('MACHINE_LIBRARY_RESTORE_FAILED', restoreError, {
          site: 'desktop/src/machine/library.ts',
          machineId: manifest.id
        });
      }
    }
    if (error instanceof MachineLibraryError) throw error;
    fail('LIBRARY_IO_FAILED', `机型包入库失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (backup) rmSync(backup, { recursive: true, force: true });

  const entry: MachineLibraryEntry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    updatedAt: (options.now ?? new Date()).toISOString(),
    sizeBytes: directorySize(target),
    source: options.source ?? 'remote'
  };
  const entries = reconcileCatalog(userDataRoot).filter((item) => item.id !== entry.id);
  entries.push(entry);
  writeCatalogFile(userDataRoot, entries);
  return { entry, overwritten: existed };
}

/** 把当前方案存进本地库（先打包再走同一套导入校验）。 */
export function saveToLibrary(
  userDataRoot: string,
  design: NormalizedMachineDesign,
  options: BuildMachinePackageOptions & ImportPackageOptions = {}
): ImportPackageResult {
  const bytes = buildMachinePackage(design, options);
  return importPackage(userDataRoot, bytes, {
    overwrite: options.overwrite === true,
    source: 'local',
    ...(options.now ? { now: options.now } : {})
  });
}

/** 读库里的一个包，并校验它与 manifest 一致（被手工改过就报 LIBRARY_HASH_MISMATCH）。 */
export function readLibraryPackage(userDataRoot: string, id: string): { pkg: MachinePackage; manifestText: string } {
  const directory = machineLibraryEntryDirectory(userDataRoot, id);
  if (!existsSync(directory)) fail('LIBRARY_NOT_FOUND', `机型库里没有 ${id}`);
  const manifestText = readTextIfExists(join(directory, 'manifest.json'));
  if (!manifestText) fail('LIBRARY_NOT_FOUND', `机型目录 ${id} 缺少 manifest.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText) as unknown;
  } catch (error) {
    fail('LIBRARY_BAD_ZIP', `机型 ${id} 的 manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateMachinePackageManifest(raw);
  if (manifest.id !== sanitizeMachineId(id)) {
    fail('LIBRARY_BAD_ZIP', `机型 ${id} 目录里的 manifest.id 是 ${manifest.id}，与目录名不一致`);
  }
  const files = verifyPayload(manifest, (path) => {
    try {
      return readFileSync(join(directory, ...path.split('/')));
    } catch {
      fail('LIBRARY_NOT_FOUND', `机型 ${id} 缺少文件：${path}`);
    }
  });
  const config = parseConfigFile(files, manifest);
  return { pkg: { manifest, config, files }, manifestText };
}

/** 导出成可分享的 `.machine.zip` 字节。 */
export function exportPackage(userDataRoot: string, id: string): Buffer {
  const { pkg, manifestText } = readLibraryPackage(userDataRoot, id);
  const entries = [
    { path: MACHINE_PACKAGE_PATHS.manifest, content: manifestText },
    ...[...pkg.files].map(([path, content]) => ({ path, content }))
  ];
  return createZip(entries);
}

export function removeFromLibrary(userDataRoot: string, id: string): MachineLibraryEntry {
  const directory = machineLibraryEntryDirectory(userDataRoot, id);
  if (!existsSync(directory)) fail('LIBRARY_NOT_FOUND', `机型库里没有 ${id}`);
  const entry = reconcileCatalog(userDataRoot).find((item) => item.id === id);
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    fail('LIBRARY_IO_FAILED', `机型 ${id} 删除失败：${error instanceof Error ? error.message : String(error)}`);
  }
  writeCatalogFile(userDataRoot, reconcileCatalog(userDataRoot).filter((item) => item.id !== id));
  return entry ?? {
    id,
    name: id,
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    sizeBytes: 0,
    source: 'remote'
  };
}

export interface LoadFromLibraryResult {
  entry: MachineLibraryEntry;
  design: StoredMachineDesign;
  designPath: string;
  activePath: string;
  /** 一并落盘的附属文件（geometry.json / bom-draft.csv），按实际存在列出 */
  copied: string[];
}

/**
 * 从库里加载：写回 `userData/machine/<id>.json` 并把 active.json 指过去（复用 store 的落盘逻辑），
 * 几何与 BOM 草稿按现有路径一并落到 `machine/<id>/`。
 */
export function loadFromLibrary(
  userDataRoot: string,
  id: string,
  options: { now?: Date } = {}
): LoadFromLibraryResult {
  const { pkg } = readLibraryPackage(userDataRoot, id);
  const { manifest, config, files } = pkg;
  const geometryBytes = files.get(MACHINE_PACKAGE_PATHS.geometry);
  let geometryDoc: Record<string, unknown> | null = null;
  if (geometryBytes) {
    try {
      const parsed = JSON.parse(decodeUtf8(geometryBytes, 'geometry.json')) as unknown;
      geometryDoc = isRecord(parsed) ? parsed : null;
    } catch (error) {
      if (error instanceof MachineLibraryError) throw error;
      fail('LIBRARY_BAD_ZIP', `机型 ${id} 的 geometry.json 不是合法 JSON`);
    }
  }

  const designInput: Record<string, unknown> = { config };
  if (geometryDoc?.layout !== undefined) designInput.stationGeometryLayout = geometryDoc.layout;
  if (geometryDoc?.form !== undefined) designInput.form = geometryDoc.form;
  if (geometryDoc?.stationIdentities !== undefined) designInput.stationIdentities = geometryDoc.stationIdentities;

  let design: NormalizedMachineDesign;
  try {
    design = validateMachineDesign(designInput);
  } catch (error) {
    fail('LIBRARY_INVALID_CONFIG', `机型 ${id} 无法还原成方案：${error instanceof Error ? error.message : String(error)}`);
  }
  // config 原样保留（包里的 config.json 就是事实源），只把 id 钉回 manifest.id
  design.config.id = manifest.id;

  let stored: StoredMachineDesign;
  const copied: string[] = [];
  try {
    stored = writeStoredMachineDesign(userDataRoot, design, (options.now ?? new Date()).toISOString());
    if (geometryBytes) {
      const geometryPath = machineGeometryPaths(userDataRoot, id).json;
      writeText(geometryPath, geometryBytes.toString('utf8'));
      copied.push(geometryPath);
    }
    const bomBytes = files.get(MACHINE_PACKAGE_PATHS.bom);
    if (bomBytes) {
      const bomPath = machineBomDraftPath(userDataRoot, id);
      writeText(bomPath, bomBytes.toString('utf8'));
      copied.push(bomPath);
    }
  } catch (error) {
    fail('LIBRARY_IO_FAILED', `机型 ${id} 加载失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const entry = reconcileCatalog(userDataRoot).find((item) => item.id === id);
  return {
    entry: entry ?? {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      updatedAt: manifest.createdAt,
      sizeBytes: directorySize(machineLibraryEntryDirectory(userDataRoot, id)),
      source: 'remote'
    },
    design: stored,
    designPath: machineDesignPath(userDataRoot, id),
    activePath: activeMachinePath(userDataRoot),
    copied
  };
}

/** 工具层统一错误出口：把任何异常折成 `{ok:false, code, message}`。 */
export function serializeMachineLibraryError(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof MachineLibraryError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'LIBRARY_IO_FAILED',
    message: error instanceof Error ? error.message : String(error)
  };
}

