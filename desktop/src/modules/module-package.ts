// 离线签名模块包：清单校验、Ed25519 验签、原子安装与已安装版本读取。
//
// 设计约束（与 electron/module-chunks.ts 的读取器约定对齐）：
// - 清单是白名单：文件路径只允许包内相对 POSIX 路径，绝不接受调用方传入的任意路径。
// - 签名覆盖「除 signature 外的规范化序列化」：JSON 对象键按 UTF-16 代码单元排序，
//   数组保持原顺序，数字用 JSON.stringify 输出，字符串用 JSON.stringify 转义。因此同一份
//   清单无论属性插入顺序如何，规范化结果都完全一致；发布侧与校验侧必须调用同一个
//   canonicalModulePackagePayload()，不要各自拼 JSON。
// - 安装只写 `<targetRoot>/.staging-<random>`，逐文件校验字节数与 sha256 后，才把整个
//   暂存目录原子 rename 到 `<targetRoot>/<moduleId>/<version>`。任何一步失败都会删除暂存
//   目录；目标版本目录已存在时直接拒绝，**已有版本目录永不改动**。回滚语义就是「旧目录
//   从未被写过」：新版本要么完整出现，要么根本不出现，不存在半安装状态。
// - 不联网、不启动 Electron、不调用 process.exit；所有 IO（readFile、文件系统操作、
//   随机名）都可注入，便于测试与宿主替换。
//
// 失败码：verifyModulePackage 只返回 SIGNATURE_INVALID / MANIFEST_INVALID /
// API_INCOMPATIBLE / DEPENDENCY_UNRESOLVED / PATH_UNSAFE / SIZE_LIMIT。
// installModulePackage 在此之上还需要表达「包内容与清单不符」「目标版本已存在」
// 「文件系统操作失败」，分别为 FILE_MISMATCH / TARGET_EXISTS / IO_FAILURE。

import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifyEd25519Signature
} from 'node:crypto';
import {
  mkdir,
  readFile as readNodeFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile as writeNodeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MODULE_PACKAGE_SCHEMA_VERSION = 1 as const;

export interface ModulePackageFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ModulePackageApiCompatibility {
  min: number;
  max: number;
}

/** 签名覆盖的部分；`signature` 是分离字段，不参与规范化。 */
export interface ModulePackagePayload {
  schemaVersion: 1;
  moduleId: string;
  moduleVersion: string;
  apiCompatibility: ModulePackageApiCompatibility;
  dependencies: string[];
  files: ModulePackageFileEntry[];
}

export interface ModulePackageManifest extends ModulePackagePayload {
  /** Ed25519 签名，128 个十六进制字符（64 字节）。 */
  signature: string;
}

export type ModulePackageFailureCode =
  | 'SIGNATURE_INVALID'
  | 'MANIFEST_INVALID'
  | 'API_INCOMPATIBLE'
  | 'DEPENDENCY_UNRESOLVED'
  | 'PATH_UNSAFE'
  | 'SIZE_LIMIT';

/** 安装阶段额外可能出现的失败；验证阶段不会返回这些码。 */
export type ModulePackageInstallFailureCode =
  | ModulePackageFailureCode
  | 'FILE_MISMATCH'
  | 'TARGET_EXISTS'
  | 'IO_FAILURE';

export interface ModulePackageFailure<Code extends string = ModulePackageFailureCode> {
  ok: false;
  code: Code;
  message: string;
}

export interface ModulePackageVerificationSuccess {
  ok: true;
  manifest: ModulePackageManifest;
  /** 实际参与验签的规范化字符串，便于审计与复现。 */
  canonical: string;
}

export type ModulePackageVerification =
  | ModulePackageVerificationSuccess
  | ModulePackageFailure<ModulePackageFailureCode>;

export interface ModulePackageInstallSuccess {
  ok: true;
  path: string;
  moduleId: string;
  moduleVersion: string;
  manifest: ModulePackageManifest;
}

export type ModulePackageInstallResult =
  | ModulePackageInstallSuccess
  | ModulePackageFailure<ModulePackageInstallFailureCode>;

export interface VerifyModulePackageOptions {
  publicKeyPem: string;
  hostApiVersion: number;
  /** 已启用模块 id；数组、Set 等任何 Iterable 都可以。缺省视为空集合。 */
  enabledModules?: Iterable<string>;
  /** 清单 files[].bytes 之和的上限。 */
  maxBytes: number;
}

/** readFile 按清单里的包内相对路径取源内容；返回字符串时按 UTF-8 编码。 */
export type ModulePackageSourceReader = (
  path: string
) => Uint8Array | ArrayBuffer | string | Promise<Uint8Array | ArrayBuffer | string>;

/** 目录条目只需要这三个成员，Dirent 天然满足。 */
export interface ModulePackageDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ModulePackageFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readdir(path: string): Promise<ModulePackageDirectoryEntry[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface InstallModulePackageOptions extends VerifyModulePackageOptions {
  manifest: unknown;
  readFile: ModulePackageSourceReader;
  targetRoot: string;
  /** 缺省使用 node:fs/promises；测试或宿主可整体替换。 */
  fs?: ModulePackageFileSystem;
  /** 缺省使用 randomUUID() 去掉短横线；注入值必须是安全的单段文件名。 */
  randomSuffix?: () => string;
}

export interface InstalledModuleReadOptions {
  fs?: ModulePackageFileSystem;
  /**
   * 可选：提供公钥时，已安装清单的签名也必须通过。只校验哈希时不需要公钥，
   * 但那只证明「本地文件与清单一致」，不证明清单确实由发布者签名。
   */
  publicKeyPem?: string;
}

export interface LoadInstalledModuleOptions extends InstalledModuleReadOptions {
  /** 指定版本；缺省时选择通过完整性检查的最高 semver 版本。 */
  version?: string;
}

export interface InstalledModuleVersion {
  moduleId: string;
  moduleVersion: string;
  path: string;
  manifest: ModulePackageManifest;
}

const NODE_FILE_SYSTEM: ModulePackageFileSystem = {
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async readFile(path) {
    return await readNodeFile(path);
  },
  async writeFile(path, data) {
    await writeNodeFile(path, data);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async rm(path, options) {
    await rm(path, options);
  },
  async readdir(path) {
    return await readdir(path, { withFileTypes: true });
  },
  async stat(path) {
    return await stat(path);
  }
};

const ALLOWED_MANIFEST_KEYS = new Set([
  'schemaVersion',
  'moduleId',
  'moduleVersion',
  'apiCompatibility',
  'dependencies',
  'files',
  'signature'
]);
const ALLOWED_COMPATIBILITY_KEYS = new Set(['min', 'max']);
const ALLOWED_FILE_KEYS = new Set(['path', 'bytes', 'sha256']);

const SAFE_MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SAFE_STAGING_SUFFIX = /^[A-Za-z0-9_-]{1,80}$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
// semver.org 的官方正则（只匹配完整字符串，调用前还会限制长度）。
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SIGNATURE_HEX = /^[a-f0-9]{128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstUnexpectedKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function isSafeModuleId(value: string): boolean {
  return (
    SAFE_MODULE_ID.test(value) &&
    !value.endsWith('.') &&
    !WINDOWS_RESERVED_NAME.test(value)
  );
}

function isSemver(value: string): boolean {
  return value.length > 0 && value.length <= 128 && SEMVER.test(value);
}

/**
 * 校验包内相对路径。返回 null 表示安全，否则返回原因。
 * 明确拒绝：绝对路径、盘符/UNC、反斜杠、空段、`.`/`..`、控制字符、Windows 保留名、
 * 根 manifest.json（该文件由安装器写入，不能让包内容覆盖）。
 */
function packageFilePathProblem(value: string): string | null {
  if (value.length === 0 || value.length > 240) return '文件路径长度非法';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '文件路径包含控制字符';
  if (value.includes('\\')) return '文件路径不得包含反斜杠';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return '文件路径必须是包内相对路径';
  if (value.toLowerCase() === 'manifest.json') return '文件路径不得占用根 manifest.json';
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return '文件路径不得包含空段';
    if (segment === '.' || segment === '..') return '文件路径不得包含 . 或 .. 段';
    if (!SAFE_PATH_SEGMENT.test(segment)) return `文件路径段非法：${segment}`;
    if (segment.endsWith('.')) return `文件路径段不得以点结尾：${segment}`;
    if (WINDOWS_RESERVED_NAME.test(segment)) return `文件路径段是 Windows 保留名：${segment}`;
  }
  return null;
}

export interface ModulePackageManifestValidationFailure {
  ok: false;
  code: 'MANIFEST_INVALID' | 'PATH_UNSAFE';
  message: string;
}

export type ModulePackageManifestValidation =
  | { ok: true; manifest: ModulePackageManifest }
  | ModulePackageManifestValidationFailure;

/**
 * 结构校验。任何一处不合法都整份拒绝：半可信的清单比没有清单更危险。
 * 这里不验签，也不检查宿主 API/依赖/字节上限；那些属于 verifyModulePackage。
 */
export function validateModulePackageManifest(raw: unknown): ModulePackageManifestValidation {
  if (!isRecord(raw)) return { ok: false, code: 'MANIFEST_INVALID', message: '模块包清单必须是对象' };
  const unexpected = firstUnexpectedKey(raw, ALLOWED_MANIFEST_KEYS);
  if (unexpected !== null) {
    return { ok: false, code: 'MANIFEST_INVALID', message: `模块包清单包含未知字段：${unexpected}` };
  }
  if (raw.schemaVersion !== MODULE_PACKAGE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'MANIFEST_INVALID',
      message: `不支持的模块包清单版本：${String(raw.schemaVersion)}`
    };
  }
  if (typeof raw.moduleId !== 'string' || !isSafeModuleId(raw.moduleId)) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'moduleId 必须是安全的单段目录名' };
  }
  if (typeof raw.moduleVersion !== 'string' || !isSemver(raw.moduleVersion)) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'moduleVersion 必须是合法 semver' };
  }

  const compatibility = raw.apiCompatibility;
  if (!isRecord(compatibility)) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'apiCompatibility 必须是对象' };
  }
  const unexpectedCompatibility = firstUnexpectedKey(compatibility, ALLOWED_COMPATIBILITY_KEYS);
  if (unexpectedCompatibility !== null) {
    return { ok: false, code: 'MANIFEST_INVALID', message: `apiCompatibility 包含未知字段：${unexpectedCompatibility}` };
  }
  const min = compatibility.min;
  const max = compatibility.max;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    (min as number) < 1 ||
    (max as number) < (min as number)
  ) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'apiCompatibility 必须是合法的闭区间' };
  }

  if (!Array.isArray(raw.dependencies)) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'dependencies 必须是数组' };
  }
  const dependencies: string[] = [];
  for (const dependency of raw.dependencies) {
    if (typeof dependency !== 'string' || !isSafeModuleId(dependency)) {
      return { ok: false, code: 'MANIFEST_INVALID', message: 'dependencies 里有非法模块 id' };
    }
    if (dependencies.includes(dependency)) {
      return { ok: false, code: 'MANIFEST_INVALID', message: `dependencies 重复：${dependency}` };
    }
    dependencies.push(dependency);
  }

  if (!Array.isArray(raw.files)) {
    return { ok: false, code: 'MANIFEST_INVALID', message: 'files 必须是数组' };
  }
  const files: ModulePackageFileEntry[] = [];
  const seenPaths = new Set<string>();
  for (const item of raw.files) {
    if (!isRecord(item)) return { ok: false, code: 'MANIFEST_INVALID', message: 'files 条目必须是对象' };
    const unexpectedFile = firstUnexpectedKey(item, ALLOWED_FILE_KEYS);
    if (unexpectedFile !== null) {
      return { ok: false, code: 'MANIFEST_INVALID', message: `files 条目包含未知字段：${unexpectedFile}` };
    }
    if (typeof item.path !== 'string') {
      return { ok: false, code: 'MANIFEST_INVALID', message: 'files[].path 必须是字符串' };
    }
    const pathProblem = packageFilePathProblem(item.path);
    if (pathProblem !== null) {
      return { ok: false, code: 'PATH_UNSAFE', message: `${pathProblem}：${item.path}` };
    }
    if (seenPaths.has(item.path.toLowerCase())) {
      return { ok: false, code: 'MANIFEST_INVALID', message: `files 路径重复：${item.path}` };
    }
    seenPaths.add(item.path.toLowerCase());
    if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0) {
      return { ok: false, code: 'MANIFEST_INVALID', message: `${item.path} 的字节数非法` };
    }
    if (typeof item.sha256 !== 'string' || !SHA256_HEX.test(item.sha256)) {
      return { ok: false, code: 'MANIFEST_INVALID', message: `${item.path} 的 sha256 必须是 64 位小写十六进制` };
    }
    files.push({ path: item.path, bytes: item.bytes as number, sha256: item.sha256 });
  }

  if (typeof raw.signature !== 'string' || !SIGNATURE_HEX.test(raw.signature)) {
    return {
      ok: false,
      code: 'MANIFEST_INVALID',
      message: 'signature 必须是 128 个十六进制字符的 Ed25519 签名'
    };
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: MODULE_PACKAGE_SCHEMA_VERSION,
      moduleId: raw.moduleId,
      moduleVersion: raw.moduleVersion,
      apiCompatibility: { min: min as number, max: max as number },
      dependencies,
      files,
      signature: raw.signature
    }
  };
}

/**
 * 规范化序列化（确定性）：对象键一律按 UTF-16 代码单元升序排列，数组保持原顺序，
 * 字符串/数字用 JSON.stringify，跳过值为 undefined 的对象属性。只序列化已知字段，
 * 所以 `signature` 与任何额外字段都不会进入签名内容。
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('规范化序列化不接受非有限数');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`规范化序列化不支持的类型：${typeof value}`);
}

/** 发布侧签名与校验侧验签必须共用这个函数。 */
export function canonicalModulePackagePayload(payload: ModulePackagePayload): string {
  return canonicalJson({
    schemaVersion: payload.schemaVersion,
    moduleId: payload.moduleId,
    moduleVersion: payload.moduleVersion,
    apiCompatibility: {
      min: payload.apiCompatibility.min,
      max: payload.apiCompatibility.max
    },
    dependencies: payload.dependencies.map((id) => id),
    files: payload.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256
    }))
  });
}

/** Ed25519 验签；任何格式/密钥错误都当作签名无效。 */
export function verifyModulePackageSignature(manifest: ModulePackageManifest, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const canonical = canonicalModulePackagePayload(manifest);
    return verifyEd25519Signature(
      null,
      Buffer.from(canonical, 'utf8'),
      key,
      Buffer.from(manifest.signature, 'hex')
    );
  } catch {
    return false;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeSourceBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('readFile 必须返回 Uint8Array、ArrayBuffer 或 string');
}

function sourceByteLength(bytes: Uint8Array): number {
  return bytes.byteLength;
}

/**
 * 验证清单：结构 → 路径安全（在结构校验里）→ 签名 → API 区间 → 依赖 → 字节上限。
 * 不读包内文件；文件内容由 installModulePackage 逐文件校验。
 */
export function verifyModulePackage(
  raw: unknown,
  options: VerifyModulePackageOptions
): ModulePackageVerification {
  const validated = validateModulePackageManifest(raw);
  if (!validated.ok) return validated;
  const manifest = validated.manifest;
  const canonical = canonicalModulePackagePayload(manifest);

  if (!verifyModulePackageSignature(manifest, options.publicKeyPem)) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: '模块包清单签名无效' };
  }

  if (
    !Number.isSafeInteger(options.hostApiVersion) ||
    options.hostApiVersion < 1 ||
    options.hostApiVersion < manifest.apiCompatibility.min ||
    options.hostApiVersion > manifest.apiCompatibility.max
  ) {
    return {
      ok: false,
      code: 'API_INCOMPATIBLE',
      message: `宿主模块 API ${String(options.hostApiVersion)} 不在 ${manifest.apiCompatibility.min}-${manifest.apiCompatibility.max} 区间内`
    };
  }

  const enabled = new Set(options.enabledModules ?? []);
  const missing = manifest.dependencies.filter((dependency) => !enabled.has(dependency));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'DEPENDENCY_UNRESOLVED',
      message: `依赖未启用或未安装：${missing.join(', ')}`
    };
  }

  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    return { ok: false, code: 'SIZE_LIMIT', message: 'maxBytes 必须是非负安全整数' };
  }
  let totalBytes = 0;
  for (const file of manifest.files) {
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxBytes) {
      return {
        ok: false,
        code: 'SIZE_LIMIT',
        message: `模块包声明字节数超过上限 ${options.maxBytes}`
      };
    }
  }

  return { ok: true, manifest, canonical };
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function pathExists(fs: ModulePackageFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** 把清单相对路径解析到 baseDir 内，并做一次目录包含检查（双保险）。 */
function resolvePackageFile(baseDir: string, filePath: string): string {
  const target = join(baseDir, ...filePath.split('/'));
  const rel = relative(resolve(baseDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`包内路径越界：${filePath}`);
  }
  return target;
}

function defaultRandomSuffix(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * 安装模块包。
 *
 * 回滚语义（重要）：旧版本目录从始至终只读。所有新内容先写入 targetRoot 下的
 * `.staging-<random>`，逐文件按字节数 + sha256 校验，全部成功后再原子 rename 到
 * `<targetRoot>/<moduleId>/<version>`。任一步失败都会递归删除暂存目录；如果目标版本
 * 目录已经存在，则直接返回 TARGET_EXISTS，绝不覆盖、合并或清理它。
 *
 * 并发说明：rename 前会再次检查目标不存在，但「检查 + rename」不构成跨进程原子锁；
 * 多进程同时安装同一版本应由上层安装锁串行化。即便竞争，函数也只会整体替换一个空目录，
 * 不会写入已有版本目录内的任何文件。
 */
export async function installModulePackage(
  options: InstallModulePackageOptions
): Promise<ModulePackageInstallResult> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const readSource = options.readFile;
  const makeRandomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  const verification = verifyModulePackage(options.manifest, options);
  if (!verification.ok) return verification;

  const manifest = verification.manifest;
  const targetRoot = resolve(options.targetRoot);
  const moduleDir = join(targetRoot, manifest.moduleId);
  const targetDir = join(moduleDir, manifest.moduleVersion);
  let stagingDir: string | null = null;
  let stagingCreated = false;

  const cleanupStaging = async (): Promise<string | null> => {
    const dir = stagingDir;
    if (!stagingCreated || dir === null) return null;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      stagingCreated = false;
      stagingDir = null;
      return null;
    } catch (error) {
      return `暂存目录清理失败（${dir}）：${errorMessage(error)}`;
    }
  };

  const fail = async (
    code: ModulePackageInstallFailureCode,
    message: string
  ): Promise<ModulePackageFailure<ModulePackageInstallFailureCode>> => {
    const cleanupError = await cleanupStaging();
    if (cleanupError !== null) {
      return { ok: false, code: 'IO_FAILURE', message: `${message}；${cleanupError}` };
    }
    return { ok: false, code, message };
  };

  try {
    await fs.mkdir(targetRoot, { recursive: true });
    if (await pathExists(fs, targetDir)) {
      return await fail('TARGET_EXISTS', `目标版本目录已存在，拒绝覆盖：${targetDir}`);
    }

    let suffix: string;
    try {
      suffix = makeRandomSuffix();
    } catch (error) {
      return await fail('IO_FAILURE', `生成暂存目录名失败：${errorMessage(error)}`);
    }
    if (typeof suffix !== 'string' || !SAFE_STAGING_SUFFIX.test(suffix)) {
      return await fail('IO_FAILURE', '暂存目录随机名必须是安全的单段文件名');
    }
    stagingDir = join(targetRoot, `.staging-${suffix}`);
    try {
      // 非递归创建：已存在就失败，绝不把内容写进别人的暂存目录。
      await fs.mkdir(stagingDir, { recursive: false });
      stagingCreated = true;
    } catch (error) {
      stagingDir = null;
      return await fail('IO_FAILURE', `创建暂存目录失败：${errorMessage(error)}`);
    }

    for (const file of manifest.files) {
      let raw: Uint8Array | ArrayBuffer | string;
      try {
        raw = await readSource(file.path);
      } catch (error) {
        return await fail('FILE_MISMATCH', `读取包内文件失败：${file.path}：${errorMessage(error)}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = normalizeSourceBytes(raw);
      } catch (error) {
        return await fail('FILE_MISMATCH', `包内文件类型非法：${file.path}：${errorMessage(error)}`);
      }
      if (sourceByteLength(bytes) !== file.bytes) {
        return await fail(
          'FILE_MISMATCH',
          `包内文件字节数不符：${file.path}（${sourceByteLength(bytes)} ≠ ${file.bytes}）`
        );
      }
      if (sha256Hex(bytes) !== file.sha256) {
        return await fail('FILE_MISMATCH', `包内文件 sha256 不符：${file.path}`);
      }
      const writePath = resolvePackageFile(stagingDir, file.path);
      await fs.mkdir(dirname(writePath), { recursive: true });
      await fs.writeFile(writePath, bytes);
    }

    const installedManifest = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(join(stagingDir, 'manifest.json'), installedManifest);

    await fs.mkdir(moduleDir, { recursive: true });
    if (await pathExists(fs, targetDir)) {
      return await fail('TARGET_EXISTS', `目标版本目录已存在，拒绝覆盖：${targetDir}`);
    }
    await fs.rename(stagingDir, targetDir);
    stagingCreated = false;
    stagingDir = null;
    return {
      ok: true,
      path: targetDir,
      moduleId: manifest.moduleId,
      moduleVersion: manifest.moduleVersion,
      manifest
    };
  } catch (error) {
    return await fail('IO_FAILURE', `安装模块包失败：${errorMessage(error)}`);
  }
}

interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  const [, major = '0', minor = '0', patch = '0', prereleaseText] = match;
  return {
    major,
    minor,
    patch,
    prerelease: prereleaseText === undefined ? [] : prereleaseText.split('.')
  };
}

function compareNumericIdentifier(a: string, b: string): number {
  // semver 不允许数字标识符带前导零，因此先比长度再比字典序等价于比数值。
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** semver 优先级比较（不含 build metadata，符合 semver 规范）。 */
export function compareModuleVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return a < b ? -1 : a > b ? 1 : 0;
  let compared = compareNumericIdentifier(left.major, right.major);
  if (compared !== 0) return compared;
  compared = compareNumericIdentifier(left.minor, right.minor);
  if (compared !== 0) return compared;
  compared = compareNumericIdentifier(left.patch, right.patch);
  if (compared !== 0) return compared;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aId = left.prerelease[index];
    const bId = right.prerelease[index];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    if (aId === bId) continue;
    const aNumeric = /^\d+$/.test(aId);
    const bNumeric = /^\d+$/.test(bId);
    if (aNumeric && bNumeric) return compareNumericIdentifier(aId, bId);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aId < bId ? -1 : 1;
  }
  return 0;
}

async function listVersionDirectoryNames(
  fs: ModulePackageFileSystem,
  moduleDir: string
): Promise<string[]> {
  let entries: ModulePackageDirectoryEntry[];
  try {
    entries = await fs.readdir(moduleDir);
  } catch {
    return [];
  }
  const versions: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSemver(entry.name)) continue;
    versions.push(entry.name);
  }
  return versions;
}

async function readInstalledVersion(
  fs: ModulePackageFileSystem,
  root: string,
  requestedModuleId: string,
  moduleVersion: string,
  publicKeyPem?: string
): Promise<InstalledModuleVersion | null> {
  const versionDir = join(root, requestedModuleId, moduleVersion);
  let manifestText: string;
  try {
    manifestText = new TextDecoder('utf-8', { fatal: true }).decode(
      await fs.readFile(join(versionDir, 'manifest.json'))
    );
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }
  const validated = validateModulePackageManifest(parsed);
  if (!validated.ok) return null;
  const manifest = validated.manifest;
  // 目录名不是身份：清单里的 id/version 必须与所在目录完全一致。
  if (manifest.moduleId !== requestedModuleId || manifest.moduleVersion !== moduleVersion) return null;
  if (publicKeyPem !== undefined && !verifyModulePackageSignature(manifest, publicKeyPem)) return null;

  for (const file of manifest.files) {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(resolvePackageFile(versionDir, file.path));
    } catch {
      return null;
    }
    if (bytes.byteLength !== file.bytes) return null;
    if (sha256Hex(bytes) !== file.sha256) return null;
  }

  return {
    moduleId: manifest.moduleId,
    moduleVersion: manifest.moduleVersion,
    path: versionDir,
    manifest
  };
}

/**
 * 读取某个模块的已安装版本。
 * - 不指定 version 时，按 semver 从高到低找第一个「manifest.json 存在且所有声明文件
 *   的字节数/sha256 都匹配」的目录；损坏的最高版本会被跳过。
 * - 目录名存在、甚至清单存在，但任一文件缺失或哈希不符，都视为未安装并返回 null。
 * - 可选 publicKeyPem 会额外要求清单签名有效（离线安装后仍可验证发布者身份）。
 */
export async function loadInstalledModuleVersion(
  targetRoot: string,
  moduleId: string,
  options: LoadInstalledModuleOptions = {}
): Promise<InstalledModuleVersion | null> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  if (!isSafeModuleId(moduleId)) return null;
  const root = resolve(targetRoot);
  const moduleDir = join(root, moduleId);

  let versions: string[];
  if (options.version !== undefined) {
    if (!isSemver(options.version)) return null;
    versions = [options.version];
  } else {
    versions = await listVersionDirectoryNames(fs, moduleDir);
    versions.sort((a, b) => compareModuleVersions(b, a));
  }

  for (const version of versions) {
    const installed = await readInstalledVersion(fs, root, moduleId, version, options.publicKeyPem);
    if (installed !== null) return installed;
  }
  return null;
}

/**
 * 列出 targetRoot 下所有通过完整性检查的已安装版本，按 moduleId、semver 升序返回。
 * 只认清单与文件哈希；空目录、只有目录名、缺文件、篡改文件、非法清单都会被跳过。
 */
export async function listInstalledModules(
  targetRoot: string,
  options: InstalledModuleReadOptions = {}
): Promise<InstalledModuleVersion[]> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const root = resolve(targetRoot);
  let entries: ModulePackageDirectoryEntry[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const installed: InstalledModuleVersion[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeModuleId(entry.name)) continue;
    const versions = await listVersionDirectoryNames(fs, join(root, entry.name));
    versions.sort(compareModuleVersions);
    for (const version of versions) {
      const found = await readInstalledVersion(fs, root, entry.name, version, options.publicKeyPem);
      if (found !== null) installed.push(found);
    }
  }

  installed.sort((a, b) => {
    if (a.moduleId !== b.moduleId) return a.moduleId < b.moduleId ? -1 : 1;
    return compareModuleVersions(a.moduleVersion, b.moduleVersion);
  });
  return installed;
}
