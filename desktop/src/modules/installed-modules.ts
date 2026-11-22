// 已安装的离线签名模块包 → 分块加载器可用的来源。
//
// 目录布局（与 module-package.ts 的安装结果一致）：
//   <targetRoot>/<moduleId>/<version>/manifest.json
//   <targetRoot>/<moduleId>/<version>/<清单里声明的文件>
//
// 职责边界（刻意做窄）：
// - 只读：不安装、不写盘、不联网、不调用 process.exit；所有 IO 都可注入。
// - 分块文件名只来自 manifest.json，调用方只能给 moduleId/version，不能给任意路径。
// - 清单与文件校验复用 module-package.ts 的语义：结构校验、可选的 Ed25519 验签、
//   逐文件字节数 + sha256；任一不符即视为未安装/损坏，绝不「先跑再说」。
// - 返回值里的字段刻意与 ModuleChunkEntry 对齐，让上层可以把「随包分块」和
//   「已安装分块」并列成同一张表（合并逻辑不在本文件）。
//
// 分块文件的选择约定（按优先级）：
//   1. 清单顶层 `chunk` 字段：包内相对路径，必须指向 files[] 里已声明的文件；
//      只接受版本目录根部的纯文件名，防止把任意包内文件当成分块执行。
//   2. `chunk` 缺省时，使用 `<moduleId>.js`（与 scripts/build-module-chunks.mjs 的
//      产物命名一致）。
//   3. 再缺省时，使用 `chunk.js`。
// 注意：module-package.ts 的签名清单结构目前不接受额外字段，installModulePackage()
// 因此不会写出 `chunk` 字段；本文件把 `chunk` 当作「安装布局扩展」读取。签名覆盖的
// 仍是 module-package 的规范化 payload（不含 chunk），chunk 只是指向某个已签名的
// files[] 条目，实际执行的字节仍受 signed bytes/sha256 约束。
//
// 失败码（只暴露这四个，便于上层二分「随包分块 / 已安装分块」）：
//   MODULE_NOT_INSTALLED  目录/清单不存在、清单非法、身份不符、非分块文件损坏、验签失败
//   CHUNK_MISSING         清单没有分块条目、分块文件缺失或为空
//   CHUNK_HASH_MISMATCH   分块字节数/sha256 与清单不符，或不是合法 UTF-8
//   PATH_UNSAFE           清单的 chunk / files[].path 越界或不安全

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  readFile as readNodeFile,
  readdir as readNodeReaddir
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ModuleChunkEntry } from './chunk-manifest.ts';
import {
  compareModuleVersions,
  validateModulePackageManifest,
  verifyModulePackageSignature,
  type ModulePackageDirectoryEntry,
  type ModulePackageFileEntry,
  type ModulePackageManifest
} from './module-package.ts';

export type InstalledChunkFailureCode =
  | 'MODULE_NOT_INSTALLED'
  | 'CHUNK_MISSING'
  | 'CHUNK_HASH_MISMATCH'
  | 'PATH_UNSAFE';

export interface InstalledChunkFailure {
  ok: false;
  code: InstalledChunkFailureCode;
  message: string;
}

/**
 * 一个已安装模块包中的分块来源。
 *
 * 前五个字段与 ModuleChunkEntry 完全一致，因此可以直接交给 ModuleChunkLoader，
 * 也可以与随包分块放进同一个数组；`moduleVersion` / `path` 供上层审计与二次读取。
 */
export interface InstalledModuleSource extends ModuleChunkEntry {
  moduleVersion: string;
  /** 版本目录的绝对路径（已 resolve 的 targetRoot 之下）。 */
  path: string;
}

export type InstalledChunkReadResult =
  | { ok: true; source: string }
  | InstalledChunkFailure;

/** 只读异步文件系统端口；node:fs/promises 的对应方法可直接注入。 */
export interface InstalledModuleFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<ModulePackageDirectoryEntry[]>;
}

/** 同步只读端口；仅供 createInstalledEntryResolver 的同步签名使用。 */
export interface InstalledModuleSyncFileSystem {
  readFile(path: string): Uint8Array;
  readdir(path: string): ModulePackageDirectoryEntry[];
}

export interface InstalledModuleReadOptions {
  fs?: InstalledModuleFileSystem;
  /**
   * 可选：同时要求已安装清单的 Ed25519 签名有效。
   * 不提供时只校验「本地文件与清单一致」，与 module-package.ts 的读取语义一致。
   */
  publicKeyPem?: string;
}

export interface InstalledEntryResolverOptions {
  targetRoot: string;
  /**
   * 同步文件系统端口；缺省使用 node:fs。
   * resolver 的调用签名是同步的，因此这里只能注入同步端口，不能注入 Promise 端口。
   */
  syncFs?: InstalledModuleSyncFileSystem;
  publicKeyPem?: string;
}

/**
 * 同步解析器：首次调用时扫描并缓存，安装/卸载后调用 refresh()。
 * `entries()` 返回最近一次扫描的快照（未扫描时为空数组）。
 */
export interface InstalledEntryResolver {
  (id: string): InstalledModuleSource | null;
  refresh(): InstalledModuleSource[];
  entries(): readonly InstalledModuleSource[];
}

const MANIFEST_FILE = 'manifest.json';
const CHUNK_FIELD = 'chunk';
const DEFAULT_CHUNK_FALLBACK = 'chunk.js';

const SAFE_MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** 与 chunk-manifest.ts 的 SAFE_FILE 相同：分块必须是纯文件名，不能带路径。 */
const SAFE_CHUNK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
// semver.org 官方正则；只做目录名筛选，真正的排序复用 compareModuleVersions。
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NODE_FILE_SYSTEM: InstalledModuleFileSystem = {
  async readFile(path) {
    return await readNodeFile(path);
  },
  async readdir(path) {
    return await readNodeReaddir(path, { withFileTypes: true });
  }
};

const NODE_SYNC_FILE_SYSTEM: InstalledModuleSyncFileSystem = {
  readFile(path) {
    return readFileSync(path);
  },
  readdir(path) {
    return readdirSync(path, { withFileTypes: true });
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeModuleId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_MODULE_ID.test(value) &&
    !value.endsWith('.') &&
    !WINDOWS_RESERVED_NAME.test(value)
  );
}

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && SEMVER.test(value);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 分块源码必须能原样往返成同一串字节：ModuleChunkLoader 会重新编码 source 再比字节数。
 * 使用 ignoreBOM: true 保留 UTF-8 BOM（默认 TextDecoder 会把它吃掉，导致往返少 3 字节）。
 */
function decodeChunkSource(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (new TextEncoder().encode(text).byteLength !== bytes.byteLength) {
    throw new Error('分块 UTF-8 往返字节数不一致');
  }
  return text;
}

function failure(code: InstalledChunkFailureCode, message: string): InstalledChunkFailure {
  return { ok: false, code, message };
}

/**
 * 校验 chunk 字段里的包内相对路径，规则与 module-package.ts 的 files[].path 一致。
 * 返回 null 表示安全，否则返回原因。这里单独实现是因为 module-package 没有导出该函数，
 * 而 chunk 字段不属于它的已签名结构，必须先于结构校验单独判断。
 */
function packageRelativePathProblem(value: string): string | null {
  if (value.length === 0 || value.length > 240) return '分块路径长度非法';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '分块路径包含控制字符';
  if (value.includes('\\')) return '分块路径不得包含反斜杠';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return '分块路径必须是包内相对路径';
  if (value.toLowerCase() === MANIFEST_FILE) return '分块路径不得占用根 manifest.json';
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return '分块路径不得包含空段';
    if (segment === '.' || segment === '..') return '分块路径不得包含 . 或 .. 段';
    if (!SAFE_PATH_SEGMENT.test(segment)) return `分块路径段非法：${segment}`;
    if (segment.endsWith('.')) return `分块路径段不得以点结尾：${segment}`;
    if (WINDOWS_RESERVED_NAME.test(segment)) return `分块路径段是 Windows 保留名：${segment}`;
  }
  return null;
}

/** 把包内相对路径解析到 baseDir 内，并做一次目录包含检查（双保险）。 */
function resolveInside(baseDir: string, relativePath: string): string | null {
  const target = join(baseDir, ...relativePath.split('/'));
  const rel = relative(resolve(baseDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

function resolveVersionDirectory(root: string, moduleId: string, version: string): string | null {
  const base = resolve(root);
  const target = resolve(base, moduleId, version);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

interface ManifestInspection {
  ok: true;
  manifest: ModulePackageManifest;
  chunk: ModulePackageFileEntry;
  chunkPath: string;
}

type ManifestInspectionResult = ManifestInspection | InstalledChunkFailure;

/**
 * 解析 manifest.json（JSON 对象），剥离安装布局扩展 `chunk` 后交给 module-package
 * 做严格的签名结构校验，再按约定选出分块文件条目。
 *
 * 先处理 chunk 路径安全，再校验结构：这样「清单声明 chunk: '../x'」会得到 PATH_UNSAFE，
 * 而不是被未知字段规则吞成 MANIFEST_INVALID（后者在本文件里映射为 MODULE_NOT_INSTALLED）。
 */
function inspectManifest(raw: unknown, moduleId: string, version: string): ManifestInspectionResult {
  if (!isRecord(raw)) return failure('MODULE_NOT_INSTALLED', '已安装清单必须是对象');

  let declaredChunk: string | null = null;
  if (Object.hasOwn(raw, CHUNK_FIELD)) {
    const value = raw[CHUNK_FIELD];
    if (typeof value !== 'string') {
      return failure('MODULE_NOT_INSTALLED', '已安装清单的 chunk 字段必须是字符串');
    }
    const pathProblem = packageRelativePathProblem(value);
    if (pathProblem !== null) return failure('PATH_UNSAFE', `${pathProblem}：${value}`);
    declaredChunk = value;
  }

  // `chunk` 不属于 module-package 的签名结构；剥掉后再校验，额外未知字段仍会被拒绝。
  const signedRaw = { ...raw };
  delete signedRaw[CHUNK_FIELD];
  const validated = validateModulePackageManifest(signedRaw);
  if (!validated.ok) {
    if (validated.code === 'PATH_UNSAFE') return failure('PATH_UNSAFE', validated.message);
    return failure('MODULE_NOT_INSTALLED', `已安装清单非法：${validated.message}`);
  }
  const manifest = validated.manifest;
  // 目录名不是身份：清单里的 id/version 必须与所在目录完全一致。
  if (manifest.moduleId !== moduleId || manifest.moduleVersion !== version) {
    return failure('MODULE_NOT_INSTALLED', '已安装目录名与清单身份不一致');
  }

  let chunkPath: string;
  if (declaredChunk !== null) {
    chunkPath = declaredChunk;
  } else {
    const conventional = `${moduleId}.js`;
    if (manifest.files.some((file) => file.path === conventional)) chunkPath = conventional;
    else chunkPath = DEFAULT_CHUNK_FALLBACK;
  }

  // ModuleChunkEntry.file 的约定是纯文件名；嵌套路径会在合并进分块清单时失真，直接拒绝。
  if (!SAFE_CHUNK_FILE.test(chunkPath)) {
    return failure(
      'CHUNK_MISSING',
      declaredChunk === null
        ? `清单没有 ${moduleId}.js 或 ${DEFAULT_CHUNK_FALLBACK}，且默认分块文件名不合法：${chunkPath}`
        : `chunk 必须是版本目录根部的纯文件名：${chunkPath}`
    );
  }

  const chunk = manifest.files.find((file) => file.path === chunkPath);
  if (chunk === undefined) {
    return failure('CHUNK_MISSING', `清单未声明分块文件：${chunkPath}`);
  }
  if (chunk.bytes < 1) {
    return failure('CHUNK_MISSING', `清单声明的分块文件为空：${chunkPath}`);
  }
  return { ok: true, manifest, chunk, chunkPath };
}

function makeSource(
  manifest: ModulePackageManifest,
  chunk: ModulePackageFileEntry,
  versionDir: string
): InstalledModuleSource {
  return {
    id: manifest.moduleId,
    apiCompatibility: { min: manifest.apiCompatibility.min, max: manifest.apiCompatibility.max },
    file: chunk.path,
    bytes: chunk.bytes,
    sha256: chunk.sha256,
    moduleVersion: manifest.moduleVersion,
    path: versionDir
  };
}

type VersionInspection = { ok: true; entry: InstalledModuleSource; source: string } | InstalledChunkFailure;

/** 读取 manifest.json 文本并解析；任何 IO/JSON 错误都只有「未安装」这一种语义。 */
async function readManifestJson(
  fs: InstalledModuleFileSystem,
  manifestPath: string
): Promise<unknown> {
  const bytes = await fs.readFile(manifestPath);
  return JSON.parse(decodeUtf8(bytes));
}

function readManifestJsonSync(fs: InstalledModuleSyncFileSystem, manifestPath: string): unknown {
  const bytes = fs.readFile(manifestPath);
  return JSON.parse(decodeUtf8(bytes));
}

async function inspectInstalledVersion(
  fs: InstalledModuleFileSystem,
  root: string,
  moduleId: string,
  version: string,
  publicKeyPem: string | undefined
): Promise<VersionInspection> {
  if (!isSafeModuleId(moduleId) || !isSemver(version)) {
    return failure('MODULE_NOT_INSTALLED', `模块或版本标识非法：${moduleId}@${version}`);
  }
  const versionDir = resolveVersionDirectory(root, moduleId, version);
  if (versionDir === null) return failure('MODULE_NOT_INSTALLED', `版本目录越界：${moduleId}@${version}`);

  let rawManifest: unknown;
  try {
    rawManifest = await readManifestJson(fs, join(versionDir, MANIFEST_FILE));
  } catch (error) {
    return failure(
      'MODULE_NOT_INSTALLED',
      `已安装清单不可读：${moduleId}@${version}：${errorMessage(error)}`
    );
  }
  const inspected = inspectManifest(rawManifest, moduleId, version);
  if (!inspected.ok) return inspected;
  if (publicKeyPem !== undefined && !verifyModulePackageSignature(inspected.manifest, publicKeyPem)) {
    return failure('MODULE_NOT_INSTALLED', `已安装清单签名无效：${moduleId}@${version}`);
  }

  let source: string | null = null;
  for (const file of inspected.manifest.files) {
    const filePath = resolveInside(versionDir, file.path);
    if (filePath === null) return failure('PATH_UNSAFE', `清单文件路径越界：${file.path}`);

    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if (file.path === inspected.chunkPath) {
        return failure('CHUNK_MISSING', `分块文件缺失：${file.path}：${errorMessage(error)}`);
      }
      return failure(
        'MODULE_NOT_INSTALLED',
        `已安装包文件不可读：${file.path}：${errorMessage(error)}`
      );
    }

    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
      if (file.path === inspected.chunkPath) {
        return failure(
          'CHUNK_HASH_MISMATCH',
          `分块字节数或 sha256 与清单不符：${file.path}（${bytes.byteLength} ≠ ${file.bytes}）`
        );
      }
      return failure('MODULE_NOT_INSTALLED', `已安装包文件与清单不符：${file.path}`);
    }

    if (file.path === inspected.chunkPath) {
      try {
        source = decodeChunkSource(bytes);
      } catch {
        return failure('CHUNK_HASH_MISMATCH', `分块不是合法 UTF-8，已拒绝交付：${file.path}`);
      }
    }
  }

  if (source === null) return failure('CHUNK_MISSING', `分块文件未被读取：${inspected.chunkPath}`);
  return {
    ok: true,
    entry: makeSource(inspected.manifest, inspected.chunk, versionDir),
    source
  };
}

function inspectInstalledVersionSync(
  fs: InstalledModuleSyncFileSystem,
  root: string,
  moduleId: string,
  version: string,
  publicKeyPem: string | undefined
): VersionInspection {
  if (!isSafeModuleId(moduleId) || !isSemver(version)) {
    return failure('MODULE_NOT_INSTALLED', `模块或版本标识非法：${moduleId}@${version}`);
  }
  const versionDir = resolveVersionDirectory(root, moduleId, version);
  if (versionDir === null) return failure('MODULE_NOT_INSTALLED', `版本目录越界：${moduleId}@${version}`);

  let rawManifest: unknown;
  try {
    rawManifest = readManifestJsonSync(fs, join(versionDir, MANIFEST_FILE));
  } catch (error) {
    return failure(
      'MODULE_NOT_INSTALLED',
      `已安装清单不可读：${moduleId}@${version}：${errorMessage(error)}`
    );
  }
  const inspected = inspectManifest(rawManifest, moduleId, version);
  if (!inspected.ok) return inspected;
  if (publicKeyPem !== undefined && !verifyModulePackageSignature(inspected.manifest, publicKeyPem)) {
    return failure('MODULE_NOT_INSTALLED', `已安装清单签名无效：${moduleId}@${version}`);
  }

  let source: string | null = null;
  for (const file of inspected.manifest.files) {
    const filePath = resolveInside(versionDir, file.path);
    if (filePath === null) return failure('PATH_UNSAFE', `清单文件路径越界：${file.path}`);

    let bytes: Uint8Array;
    try {
      bytes = fs.readFile(filePath);
    } catch (error) {
      if (file.path === inspected.chunkPath) {
        return failure('CHUNK_MISSING', `分块文件缺失：${file.path}：${errorMessage(error)}`);
      }
      return failure(
        'MODULE_NOT_INSTALLED',
        `已安装包文件不可读：${file.path}：${errorMessage(error)}`
      );
    }

    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
      if (file.path === inspected.chunkPath) {
        return failure(
          'CHUNK_HASH_MISMATCH',
          `分块字节数或 sha256 与清单不符：${file.path}（${bytes.byteLength} ≠ ${file.bytes}）`
        );
      }
      return failure('MODULE_NOT_INSTALLED', `已安装包文件与清单不符：${file.path}`);
    }

    if (file.path === inspected.chunkPath) {
      try {
        source = decodeChunkSource(bytes);
      } catch {
        return failure('CHUNK_HASH_MISMATCH', `分块不是合法 UTF-8，已拒绝交付：${file.path}`);
      }
    }
  }

  if (source === null) return failure('CHUNK_MISSING', `分块文件未被读取：${inspected.chunkPath}`);
  return {
    ok: true,
    entry: makeSource(inspected.manifest, inspected.chunk, versionDir),
    source
  };
}

async function listVersionDirectoryNames(
  fs: InstalledModuleFileSystem,
  moduleDir: string
): Promise<string[]> {
  let entries: ModulePackageDirectoryEntry[];
  try {
    entries = await fs.readdir(moduleDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSemver(entry.name))
    .map((entry) => entry.name);
}

function listVersionDirectoryNamesSync(
  fs: InstalledModuleSyncFileSystem,
  moduleDir: string
): string[] {
  let entries: ModulePackageDirectoryEntry[];
  try {
    entries = fs.readdir(moduleDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSemver(entry.name))
    .map((entry) => entry.name);
}

function sortSources(entries: InstalledModuleSource[]): InstalledModuleSource[] {
  entries.sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return compareModuleVersions(left.moduleVersion, right.moduleVersion);
  });
  return entries;
}

/**
 * 读取单个已安装分块并逐字节校验。
 *
 * 成功时只返回 `{ ok: true, source }`；`source` 是 UTF-8 文本，字节数与 sha256 都与清单
 * 一致，可直接交给 ModuleChunkLoader。失败码见文件头。整包所有声明文件都会校验：
 * 已安装包只要有一个文件被删/被改，就不再被视为「已安装」，避免执行一个不完整的包。
 */
export async function readInstalledChunkSource(
  targetRoot: string,
  moduleId: string,
  version: string,
  options: InstalledModuleReadOptions = {}
): Promise<InstalledChunkReadResult> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const root = resolve(targetRoot);
  const inspected = await inspectInstalledVersion(fs, root, moduleId, version, options.publicKeyPem);
  if (!inspected.ok) return inspected;
  return { ok: true, source: inspected.source };
}

/**
 * 枚举所有通过完整性检查、且能找到分块条目的已安装模块。
 *
 * - 每个模块只返回一个条目：semver 最高、能通过完整性检查并解析出分块条目的版本；
 *   更高的版本不可用（损坏、缺文件或没有分块条目）时按 semver 向下回落。
 * - 排序：moduleId 升序；同一模块内再按 semver 升序（每个模块只有一个条目）。
 * - 空目录、只有目录名、清单非法、缺文件、哈希不符、没有分块声明都会被跳过。
 */
export async function listInstalledChunkEntries(
  targetRoot: string,
  options: InstalledModuleReadOptions = {}
): Promise<InstalledModuleSource[]> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const root = resolve(targetRoot);

  let moduleEntries: ModulePackageDirectoryEntry[];
  try {
    moduleEntries = await fs.readdir(root);
  } catch {
    return [];
  }

  const found: InstalledModuleSource[] = [];
  for (const moduleEntry of moduleEntries) {
    if (!moduleEntry.isDirectory() || !isSafeModuleId(moduleEntry.name)) continue;
    const versions = await listVersionDirectoryNames(fs, join(root, moduleEntry.name));
    versions.sort((left, right) => compareModuleVersions(right, left));
    for (const version of versions) {
      const inspected = await inspectInstalledVersion(
        fs,
        root,
        moduleEntry.name,
        version,
        options.publicKeyPem
      );
      if (inspected.ok) {
        found.push(inspected.entry);
        break;
      }
    }
  }
  return sortSources(found);
}

function listInstalledChunkEntriesSync(
  fs: InstalledModuleSyncFileSystem,
  root: string,
  publicKeyPem: string | undefined
): InstalledModuleSource[] {
  let moduleEntries: ModulePackageDirectoryEntry[];
  try {
    moduleEntries = fs.readdir(root);
  } catch {
    return [];
  }

  const found: InstalledModuleSource[] = [];
  for (const moduleEntry of moduleEntries) {
    if (!moduleEntry.isDirectory() || !isSafeModuleId(moduleEntry.name)) continue;
    const versions = listVersionDirectoryNamesSync(fs, join(root, moduleEntry.name));
    versions.sort((left, right) => compareModuleVersions(right, left));
    for (const version of versions) {
      const inspected = inspectInstalledVersionSync(
        fs,
        root,
        moduleEntry.name,
        version,
        publicKeyPem
      );
      if (inspected.ok) {
        found.push(inspected.entry);
        break;
      }
    }
  }
  return sortSources(found);
}

/**
 * 构造 `(id) => entry | null` 的同步解析器，供上层把「随包分块」与「已安装分块」
 * 合并成两级来源（合并逻辑不在本文件）。
 *
 * 为什么是同步：上层合并时通常需要在一次判断里同时查两张表，返回 Promise 会把
 * 「查表」变成异步状态机。resolver 首次调用时同步扫描并缓存；安装/卸载新包后调用
 * `refresh()`。扫描失败（目录不可读等）按空表处理，未知 id 返回 null。
 */
export function createInstalledEntryResolver(
  options: InstalledEntryResolverOptions
): InstalledEntryResolver {
  const fs = options.syncFs ?? NODE_SYNC_FILE_SYSTEM;
  const root = resolve(options.targetRoot);
  let snapshot: InstalledModuleSource[] | null = null;
  const byId = new Map<string, InstalledModuleSource>();

  const scan = (): InstalledModuleSource[] => {
    const found = listInstalledChunkEntriesSync(fs, root, options.publicKeyPem);
    snapshot = found;
    byId.clear();
    for (const entry of found) byId.set(entry.id, entry);
    return [...found];
  };

  const resolver = ((id: string): InstalledModuleSource | null => {
    if (!isSafeModuleId(id)) return null;
    if (snapshot === null) scan();
    return byId.get(id) ?? null;
  }) as InstalledEntryResolver;

  resolver.refresh = scan;
  resolver.entries = () => (snapshot === null ? [] : [...snapshot]);
  return resolver;
}
