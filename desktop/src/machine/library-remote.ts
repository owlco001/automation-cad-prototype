/**
 * 机型库远程目录（catalog）与下载。
 *
 * 为什么单独一个模块：机型库原来只有「本地导入 zip」，用户拿不到别人发布的机型。
 * 远程源一开，机型库就从「自己攒的包」变成「外部数据入口」，所以这里的每条规则都是安全线：
 *
 *   1. 来源清单 `userData/machine-library/sources.json` **默认不存在即空**，不预置任何外网地址；
 *   2. 只认 `https`（`file` 仅开发用，且该来源必须显式 `allowFile: true`），`http`/内网/回环一律拒；
 *   3. 目录本身强校验：`schemaVersion` 必须是 1；每条机型 64 位 hex SHA-256、尺寸 ≤50 MiB、
 *      `downloadUrl` 与目录同源（或该条显式 `allowCrossOrigin: true`）；总数 ≤500；
 *   4. 下载流式累计，超过 50 MiB **立刻 destroy**（不把整包收完再判）；边下边算 SHA-256，
 *      与目录声明不符直接拒（`LIBRARY_HASH_MISMATCH`）；
 *   5. 校验通过后交给 `importPackage` 做**唯一一套**严格解包（路径穿越/白名单/逐条 SHA-256/原子落盘），
 *      本模块不重复实现任何解包逻辑，也不在库目录里写临时文件——下载失败连半包都不会出现；
 *   6. 同名已存在默认拒（`LIBRARY_EXISTS`），不自动覆盖；工具层没有 `overwrite` 参数，想覆盖只能人来做；
 *   7. 目录缓存 10 分钟；拉不到时回退到旧缓存并标 `stale: true`（哈希才是完整性保证，缓存只省流量）。
 *
 * 硬边界：下载到的是**数据**，不是代码。本模块不 eval、不 import 包内容、不写注册表、不装依赖；
 * manifest 里的任何字段都不会被当成可执行入口。
 *
 * 本模块用 Node API（fs/https/crypto），只能在主进程与脚本里用，不能被渲染层 import。
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import {
  MachineLibraryError,
  importPackage,
  machineLibraryDirectory,
  machineLibraryEntryDirectory,
  MACHINE_LIBRARY_LIMITS,
  type ImportPackageResult,
  type MachineLibraryEntry
} from './library.ts';
import { sanitizeMachineId } from './store.ts';

export const MACHINE_SOURCES_SCHEMA_VERSION = 1 as const;
export const MACHINE_CATALOG_SCHEMA_VERSION = 1 as const;

const MIB = 1024 * 1024;
const KIB = 1024;

export const MACHINE_REMOTE_LIMITS = {
  /** 目录 JSON 字节上限：目录只是索引，不该比一个机型包还大 */
  maxCatalogBytes: 2 * MIB,
  /** 目录里的机型条数上限 */
  maxMachines: 500,
  /** 单个机型包下载上限（与 importPackage 的整包上限一致） */
  maxDownloadBytes: MACHINE_LIBRARY_LIMITS.maxPackageBytes,
  /** 建连超时 */
  connectTimeoutMs: 5000,
  /** 单次下载总时长 */
  totalTimeoutMs: 60000,
  /** 网络错误重试次数（只重试网络错误，校验错误一次都不重试） */
  retries: 1,
  /** 目录缓存有效期 */
  catalogCacheMs: 10 * 60 * 1000
} as const;

/* ------------------------------------------------------------------ */
/* 来源清单                                                            */
/* ------------------------------------------------------------------ */

export interface MachineSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** 排序用：数字小的在前；缺省 100 */
  priority: number;
  /** 仅开发：允许 `file:` 协议的目录与包（默认 false） */
  allowFile: boolean;
}

/** 来源 id 会拼进缓存文件名，所以只接受 `[A-Za-z0-9._-]` 且不以点开头。 */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function machineSourcesPath(userDataRoot: string): string {
  return join(machineLibraryDirectory(userDataRoot), 'sources.json');
}

export function machineCatalogCacheDirectory(userDataRoot: string): string {
  return join(machineLibraryDirectory(userDataRoot), 'sources-cache');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ------------------------------------------------------------------ */
/* URL 白名单                                                          */
/* ------------------------------------------------------------------ */

/** 内网/保留网段：出现任何一个都说明这个地址不该由客户端去拉。 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10 链路本地
  // IPv4 映射地址：::ffff:127.0.0.1 / ::ffff:10.0.0.1
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1] && isPrivateIpv4(mapped[1])) return true;
  return false;
}

function bareHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  if (lowered.startsWith('[') && lowered.endsWith(']')) return lowered.slice(1, -1);
  return lowered;
}

export interface RemoteUrlPolicy {
  /** 允许 `file:`（仅开发/测试，生产由来源的 `allowFile` 控制） */
  allowFile?: boolean;
  /** 报错文案里的字段名，例如「目录源地址」 */
  label?: string;
}

/**
 * 远程地址白名单。**先判协议再判主机**：协议不对的地址连解析都不该继续。
 *
 * 拒：http / ftp / data / 带账号密码的 URL / 非绝对 file 路径 / localhost / 内网与保留 IP。
 * Node 的 WHATWG URL 会把 `https://2130706433`、`https://0x7f.1` 归一成 `127.0.0.1`，
 * 所以这里只需要看归一化之后的 hostname。
 */
export function assertRemoteUrl(value: unknown, policy: RemoteUrlPolicy = {}): URL {
  const label = policy.label ?? '地址';
  if (typeof value !== 'string' || !value.trim()) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}必须是非空字符串`);
  }
  if (value.trim() !== value) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}不能有首尾空白：${JSON.stringify(value)}`);
  }
  if (value.length > 2048) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}过长（${value.length} > 2048）`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}含控制字符`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}不是合法 URL：${value}`);
  }
  if (url.username || url.password) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}不得内嵌账号密码`);
  }

  if (url.protocol === 'file:') {
    if (policy.allowFile !== true) {
      throw new MachineLibraryError(
        'LIBRARY_URL_REJECTED',
        `${label}是 file: 协议；file 只用于开发/测试，必须在该来源显式 allowFile: true`,
        '生产环境请改用 https 目录源'
      );
    }
    if (url.host && url.host !== 'localhost') {
      throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}不得使用 file:// 主机的 UNC 共享路径：${value}`);
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}不是合法的本地文件 URL：${value}`);
    }
    if (!isAbsolute(filePath) || !filePath.trim()) {
      throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}必须是绝对路径：${value}`);
    }
    return url;
  }

  if (url.protocol !== 'https:') {
    throw new MachineLibraryError(
      'LIBRARY_URL_REJECTED',
      `${label}只允许 https（实际 ${url.protocol.replace(':', '')}）：${value}`,
      '把来源改成 https 地址；本机开发可用 file: + allowFile: true'
    );
  }
  const host = bareHostname(url.hostname);
  if (!host) throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}缺少主机名：${value}`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new MachineLibraryError('LIBRARY_URL_REJECTED', `${label}指向本机/内网域名（${host}），已拒绝`);
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new MachineLibraryError(
      'LIBRARY_URL_REJECTED',
      `${label}指向内网或保留地址（${host}），已拒绝`,
      '目录源必须是公网 https 地址'
    );
  }
  // 公网 IP 直写也拒：机型库只认域名（走 DNS + TLS SNI），避免把目录源钉死在某个 IP 上，
  // 也避免「域名解析到内网」之外的第二种绕法。
  if (isIP(host) !== 0) {
    throw new MachineLibraryError(
      'LIBRARY_URL_REJECTED',
      `${label}不允许直接用 IP 地址（${host}），请改用域名`,
      '目录源写成 https://machines.example.com/... 这种域名形式'
    );
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* sources.json                                                        */
/* ------------------------------------------------------------------ */

function normalizeSource(raw: unknown, index: number): MachineSource {
  const label = `sources[${index}]`;
  if (!isRecord(raw)) throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `${label} 必须是对象`);
  const id = raw.id;
  if (typeof id !== 'string' || !SOURCE_ID_PATTERN.test(id)) {
    throw new MachineLibraryError(
      'LIBRARY_SOURCE_INVALID',
      `${label}.id 不合法（只允许字母/数字/._-，≤32 字符，且不以点开头）：${String(id)}`
    );
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const enabled = raw.enabled === undefined ? true : raw.enabled === true;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `${label}.enabled 必须是布尔值`);
  }
  const allowFile = raw.allowFile === true;
  if (raw.allowFile !== undefined && typeof raw.allowFile !== 'boolean') {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `${label}.allowFile 必须是布尔值`);
  }
  const priorityRaw = raw.priority;
  if (priorityRaw !== undefined && (typeof priorityRaw !== 'number' || !Number.isFinite(priorityRaw))) {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `${label}.priority 必须是数字`);
  }
  // 地址在读取时就校验：坏地址不该等到用户点「下载」才报。
  assertRemoteUrl(raw.url, { allowFile, label: `${label}.url` });
  return {
    id,
    name,
    url: (raw.url as string).trim(),
    enabled,
    priority: typeof priorityRaw === 'number' ? priorityRaw : 100,
    allowFile
  };
}

/**
 * 读来源清单。文件不存在 = 空清单（默认不预置任何外网地址，也不替用户创建文件）；
 * 文件存在但内容坏 = 报错（静默当成「没有来源」会把配置错误藏起来）。
 */
export function readMachineSources(userDataRoot: string): MachineSource[] {
  const path = machineSourcesPath(userDataRoot);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new MachineLibraryError(
      'LIBRARY_IO_FAILED',
      `来源清单读取失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new MachineLibraryError(
      'LIBRARY_SOURCE_INVALID',
      `sources.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', 'sources.json 必须是对象');
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== MACHINE_SOURCES_SCHEMA_VERSION) {
    throw new MachineLibraryError(
      'LIBRARY_UNSUPPORTED_SCHEMA',
      `sources.json schemaVersion=${String(parsed.schemaVersion)} 不受支持（只认 ${MACHINE_SOURCES_SCHEMA_VERSION}）`
    );
  }
  const rawSources = parsed.sources;
  if (rawSources === undefined) return [];
  if (!Array.isArray(rawSources)) throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', 'sources.json 的 sources 必须是数组');
  if (rawSources.length > 20) {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `来源过多（${rawSources.length} > 20）`);
  }
  const sources = rawSources.map((raw, index) => normalizeSource(raw, index));
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) {
      throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `来源 id 重复：${source.id}`);
    }
    seen.add(source.id);
  }
  return sources.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

/** 写来源清单（设置界面/测试/排障脚本用；工具层不暴露写来源）。 */
export function writeMachineSources(userDataRoot: string, sources: readonly unknown[]): MachineSource[] {
  const normalized = sources.map((raw, index) => normalizeSource(raw, index));
  const seen = new Set<string>();
  for (const source of normalized) {
    if (seen.has(source.id)) throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `来源 id 重复：${source.id}`);
    seen.add(source.id);
  }
  const path = machineSourcesPath(userDataRoot);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: MACHINE_SOURCES_SCHEMA_VERSION, sources: normalized }, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new MachineLibraryError(
      'LIBRARY_IO_FAILED',
      `来源清单写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* 目录（catalog）                                                      */
/* ------------------------------------------------------------------ */

export interface RemoteCatalogMachine {
  id: string;
  name: string;
  version: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  minAppVersion?: string;
  tags?: string[];
  /** 允许 downloadUrl 与目录不同源（默认不允许） */
  allowCrossOrigin: boolean;
}

export interface RemoteCatalog {
  schemaVersion: typeof MACHINE_CATALOG_SCHEMA_VERSION;
  machines: RemoteCatalogMachine[];
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label} 必须是非空字符串`);
  }
  return value.trim();
}

function sameFileDirectory(left: URL, right: URL): boolean {
  try {
    return dirname(fileURLToPath(left)) === dirname(fileURLToPath(right));
  } catch {
    return false;
  }
}

function assertDownloadCanFollow(catalogUrl: URL, downloadUrl: URL, allowCrossOrigin: boolean, label: string): void {
  const catalogIsFile = catalogUrl.protocol === 'file:';
  const downloadIsFile = downloadUrl.protocol === 'file:';
  if (catalogIsFile || downloadIsFile) {
    if (!catalogIsFile || !downloadIsFile || !sameFileDirectory(catalogUrl, downloadUrl)) {
      throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label} 与目录不是同一目录下的 file 路径`);
    }
    return;
  }
  if (catalogUrl.origin === downloadUrl.origin) return;
  if (allowCrossOrigin) return;
  throw new MachineLibraryError(
    'LIBRARY_CATALOG_INVALID',
    `${label} 与目录不同源（目录 ${catalogUrl.origin}，包 ${downloadUrl.origin}）；如确需跨源，该条必须显式 allowCrossOrigin: true`
  );
}

/**
 * 强校验目录 JSON。宁可整份拒，也不接受「部分条目能用」——一条来路不明的下载地址就是一条后门。
 */
export function parseMachineCatalog(value: unknown, options: { catalogUrl: string | URL; allowFile?: boolean }): RemoteCatalog {
  const catalogUrl = options.catalogUrl instanceof URL
    ? options.catalogUrl
    : assertRemoteUrl(options.catalogUrl, { allowFile: options.allowFile === true, label: '目录地址' });
  if (!isRecord(value)) throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', '目录必须是 JSON 对象');
  const version = value.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new MachineLibraryError('LIBRARY_UNSUPPORTED_SCHEMA', '目录缺少整数 schemaVersion，已拒绝');
  }
  if (version !== MACHINE_CATALOG_SCHEMA_VERSION) {
    throw new MachineLibraryError(
      'LIBRARY_UNSUPPORTED_SCHEMA',
      `目录 schemaVersion=${version} 不受支持（本机只认 ${MACHINE_CATALOG_SCHEMA_VERSION}），请升级软件`
    );
  }
  if (!Array.isArray(value.machines)) throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', '目录 machines 必须是数组');
  if (value.machines.length > MACHINE_REMOTE_LIMITS.maxMachines) {
    throw new MachineLibraryError(
      'LIBRARY_CATALOG_INVALID',
      `目录机型过多：${value.machines.length} > ${MACHINE_REMOTE_LIMITS.maxMachines}`
    );
  }
  const machines: RemoteCatalogMachine[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.machines.entries()) {
    const label = `machines[${index}]`;
    if (!isRecord(raw)) throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label} 必须是对象`);
    const idRaw = nonEmpty(raw.id, `${label}.id`);
    const id = sanitizeMachineId(idRaw);
    if (id !== idRaw) {
      throw new MachineLibraryError(
        'LIBRARY_CATALOG_INVALID',
        `${label}.id 不合法（含路径/控制字符或需要净化）：${idRaw}`
      );
    }
    if (seen.has(id)) throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `目录里机型 id 重复：${id}`);
    seen.add(id);
    const name = nonEmpty(raw.name, `${label}.name`);
    const versionText = nonEmpty(raw.version, `${label}.version`);
    const sizeBytes = raw.sizeBytes;
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label}.sizeBytes 必须是正整数`);
    }
    if (sizeBytes > MACHINE_REMOTE_LIMITS.maxDownloadBytes) {
      throw new MachineLibraryError(
        'LIBRARY_CATALOG_INVALID',
        `${label}.sizeBytes ${sizeBytes} 超过下载上限 ${MACHINE_REMOTE_LIMITS.maxDownloadBytes} 字节`
      );
    }
    // 只收满 64 位小写 hex：短摘要（16/32 位）没法逐字节比对，等于给不了完整性保证，
    // 「≥16 位」这道下限在实现上直接取满长度。
    if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
      throw new MachineLibraryError(
        'LIBRARY_CATALOG_INVALID',
        `${label}.sha256 必须是 64 位小写十六进制 SHA-256（至少 16 位且可逐字节比对）`
      );
    }
    const downloadUrlText = nonEmpty(raw.downloadUrl, `${label}.downloadUrl`);
    const downloadUrl = assertRemoteUrl(downloadUrlText, {
      allowFile: options.allowFile === true,
      label: `${label}.downloadUrl`
    });
    const allowCrossOrigin = raw.allowCrossOrigin === true;
    assertDownloadCanFollow(catalogUrl, downloadUrl, allowCrossOrigin, `${label}.downloadUrl`);
    if (raw.minAppVersion !== undefined && (typeof raw.minAppVersion !== 'string' || !raw.minAppVersion.trim())) {
      throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label}.minAppVersion 必须是非空字符串`);
    }
    if (raw.tags !== undefined) {
      if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
        throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', `${label}.tags 必须是字符串数组`);
      }
    }
    machines.push({
      id,
      name,
      version: versionText,
      sizeBytes,
      sha256: raw.sha256,
      downloadUrl: downloadUrl.toString(),
      allowCrossOrigin,
      ...(typeof raw.minAppVersion === 'string' ? { minAppVersion: raw.minAppVersion.trim() } : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags.map((tag) => String(tag).trim()) } : {})
    });
  }
  return { schemaVersion: MACHINE_CATALOG_SCHEMA_VERSION, machines };
}

/* ------------------------------------------------------------------ */
/* 传输（默认 https / file；测试注入）                                  */
/* ------------------------------------------------------------------ */

export interface RemoteTransportRequest {
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxBytes: number;
  accept: string;
}

/** 打开一个字节流。实现必须自己处理建连超时；读取侧由 `readCapped` 兜总时长与大小。 */
export interface RemoteTransport {
  open(url: URL, request: RemoteTransportRequest): Promise<Readable>;
}

export const nodeRemoteTransport: RemoteTransport = {
  async open(url, request) {
    if (url.protocol === 'file:') {
      // 开发用：直接读本地文件，交给下游同一套上限/哈希校验。
      return createReadStream(fileURLToPath(url));
    }
    return await new Promise<Readable>((resolve, reject) => {
      const req = httpsGet(
        url,
        {
          timeout: request.connectTimeoutMs,
          headers: { accept: request.accept, 'user-agent': 'AutomationCAD/machine-library' }
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.resume();
            reject(new MachineLibraryError('LIBRARY_NETWORK_FAILED', `远程源返回 HTTP ${status}（${url.origin}）`));
            return;
          }
          const declared = Number(response.headers['content-length'] ?? '');
          if (Number.isFinite(declared) && declared > request.maxBytes) {
            response.destroy();
            reject(
              new MachineLibraryError(
                'LIBRARY_TOO_LARGE',
                `远程内容声明 ${declared} 字节，超过 ${request.maxBytes} 字节上限`
              )
            );
            return;
          }
          resolve(response);
        }
      );
      req.on('timeout', () => {
        req.destroy(new MachineLibraryError('LIBRARY_TIMEOUT', `连接超时（${request.connectTimeoutMs} ms）`));
      });
      req.on('error', (error: unknown) => {
        reject(
          error instanceof MachineLibraryError
            ? error
            : new MachineLibraryError(
                'LIBRARY_NETWORK_FAILED',
                `网络错误：${error instanceof Error ? error.message : String(error)}`
              )
        );
      });
    });
  }
};

/** 边读边计数：超限立刻 destroy（不把大包收完再判），超时也 destroy。 */
function readCapped(stream: Readable, options: { maxBytes: number; timeoutMs: number; label: string }): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (error: MachineLibraryError | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(value ?? Buffer.alloc(0));
    };

    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > options.maxBytes) {
        settle(
          new MachineLibraryError(
            'LIBRARY_TOO_LARGE',
            `${options.label}超过 ${Math.round(options.maxBytes / MIB)} MiB 上限（已读到 ${size} 字节），下载已中止`
          )
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => settle(null, Buffer.concat(chunks, size));
    const onError = (error: unknown): void => {
      settle(
        error instanceof MachineLibraryError
          ? error
          : new MachineLibraryError(
              'LIBRARY_NETWORK_FAILED',
              `${options.label}读取失败：${error instanceof Error ? error.message : String(error)}`
            )
      );
    };

    timer = setTimeout(() => {
      settle(new MachineLibraryError('LIBRARY_TIMEOUT', `${options.label}超时（${options.timeoutMs} ms），下载已中止`));
    }, options.timeoutMs);
    timer.unref?.();

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** 只有网络/超时/IO 类错误值得重试；哈希不符、超限、目录不合法重试也没用。 */
const RETRYABLE_CODES = new Set(['LIBRARY_NETWORK_FAILED', 'LIBRARY_TIMEOUT', 'LIBRARY_IO_FAILED']);

export function isRetryableRemoteError(error: unknown): boolean {
  return error instanceof MachineLibraryError && RETRYABLE_CODES.has(error.code);
}

async function withNetworkRetry<T>(task: () => Promise<T>, retries: number): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      if (attempt > retries || !isRetryableRemoteError(error)) throw error;
      recordDiagnosticError('MACHINE_SOURCE_RETRY', error, { site: 'desktop/src/machine/library-remote.ts', attempt });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 目录缓存与拉取                                                      */
/* ------------------------------------------------------------------ */

interface CatalogCacheFile {
  schemaVersion: typeof MACHINE_SOURCES_SCHEMA_VERSION;
  sourceId: string;
  url: string;
  fetchedAt: string;
  catalog: RemoteCatalog;
}

function catalogCachePath(userDataRoot: string, sourceId: string): string {
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `来源 id 不合法：${sourceId}`);
  }
  return join(machineCatalogCacheDirectory(userDataRoot), `${sourceId}.json`);
}

function readCatalogCache(userDataRoot: string, source: MachineSource): CatalogCacheFile | null {
  const path = catalogCachePath(userDataRoot, source.id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.sourceId !== source.id || parsed.url !== source.url) return null;
    if (typeof parsed.fetchedAt !== 'string' || !Number.isFinite(Date.parse(parsed.fetchedAt))) return null;
    const catalog = parseMachineCatalog(parsed.catalog, { catalogUrl: source.url, allowFile: source.allowFile });
    return {
      schemaVersion: MACHINE_SOURCES_SCHEMA_VERSION,
      sourceId: source.id,
      url: source.url,
      fetchedAt: parsed.fetchedAt,
      catalog
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_SOURCE_CACHE_INVALID', error, {
      site: 'desktop/src/machine/library-remote.ts',
      sourceId: source.id
    });
    return null;
  }
}

function writeCatalogCache(userDataRoot: string, source: MachineSource, catalog: RemoteCatalog, fetchedAt: string): void {
  const path = catalogCachePath(userDataRoot, source.id);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload: CatalogCacheFile = {
    schemaVersion: MACHINE_SOURCES_SCHEMA_VERSION,
    sourceId: source.id,
    url: source.url,
    fetchedAt,
    catalog
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    recordDiagnosticError('MACHINE_SOURCE_CACHE_WRITE_FAILED', error, {
      site: 'desktop/src/machine/library-remote.ts',
      sourceId: source.id
    });
  }
}

export interface CatalogFetchOptions {
  transport?: RemoteTransport;
  now?: () => number;
  cacheTtlMs?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** 测试用：false 时不读缓存（强制走网络） */
  useCache?: boolean;
}

export interface CatalogFetchResult {
  catalog: RemoteCatalog;
  /** true = 网络失败，用的是过期缓存 */
  stale: boolean;
  fromCache: boolean;
  fetchedAt: string;
  attempts: number;
}

function decodeCatalogText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MachineLibraryError('LIBRARY_CATALOG_INVALID', '目录不是合法 UTF-8');
  }
}

/**
 * 拉一份目录（10 分钟内走缓存）。网络/校验失败时：
 * - 有缓存 → 返回缓存并标 `stale: true`（哈希才是完整性保证，旧目录只是可能少几台）；
 * - 没缓存 → 原样抛出第一手错误（不回退成空列表，免得界面显示「没有可下载机型」）。
 */
export async function fetchMachineCatalog(
  userDataRoot: string,
  source: MachineSource,
  options: CatalogFetchOptions = {}
): Promise<CatalogFetchResult> {
  if (!source.enabled) {
    throw new MachineLibraryError('LIBRARY_SOURCE_DISABLED', `来源「${source.name}」（${source.id}）未启用`);
  }
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? MACHINE_REMOTE_LIMITS.catalogCacheMs;
  // 缓存始终读出来：`useCache:false` 只是**跳过新鲜度短路**（强制走一次网络），
  // 网络失败时仍然要能回退到它并标 stale —— 否则「强制刷新」会把兜底路径也一起关掉。
  const cached = readCatalogCache(userDataRoot, source);
  if (cached && options.useCache !== false) {
    const age = now() - Date.parse(cached.fetchedAt);
    if (age >= 0 && age < cacheTtlMs) {
      return { catalog: cached.catalog, stale: false, fromCache: true, fetchedAt: cached.fetchedAt, attempts: 0 };
    }
  }

  const catalogUrl = assertRemoteUrl(source.url, { allowFile: source.allowFile, label: '目录源地址' });
  const transport = options.transport ?? nodeRemoteTransport;
  const connectTimeoutMs = options.connectTimeoutMs ?? MACHINE_REMOTE_LIMITS.connectTimeoutMs;
  const totalTimeoutMs = options.totalTimeoutMs ?? MACHINE_REMOTE_LIMITS.totalTimeoutMs;

  let attempts = 0;
  try {
    const bytes = await withNetworkRetry(async () => {
      attempts += 1;
      const stream = await transport.open(catalogUrl, {
        connectTimeoutMs,
        totalTimeoutMs,
        maxBytes: MACHINE_REMOTE_LIMITS.maxCatalogBytes,
        accept: 'application/json'
      });
      return await readCapped(stream, { maxBytes: MACHINE_REMOTE_LIMITS.maxCatalogBytes, timeoutMs: totalTimeoutMs, label: '目录' });
    }, MACHINE_REMOTE_LIMITS.retries);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeCatalogText(bytes)) as unknown;
    } catch (error) {
      if (error instanceof MachineLibraryError) throw error;
      throw new MachineLibraryError(
        'LIBRARY_CATALOG_INVALID',
        `目录不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
      );
    }
    const catalog = parseMachineCatalog(parsed, { catalogUrl, allowFile: source.allowFile });
    const fetchedAt = new Date(now()).toISOString();
    writeCatalogCache(userDataRoot, source, catalog, fetchedAt);
    return { catalog, stale: false, fromCache: false, fetchedAt, attempts };
  } catch (error) {
    if (cached) {
      recordDiagnosticError('MACHINE_SOURCE_STALE_FALLBACK', error, {
        site: 'desktop/src/machine/library-remote.ts',
        sourceId: source.id
      });
      return { catalog: cached.catalog, stale: true, fromCache: true, fetchedAt: cached.fetchedAt, attempts };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 下载与入库                                                          */
/* ------------------------------------------------------------------ */

export interface ListSourcesOptions extends CatalogFetchOptions {}

export interface MachineSourceStatus {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  allowFile: boolean;
  /** 目录拉到了（含 stale）就是 online */
  online: boolean;
  stale: boolean;
  machineCount: number;
  fetchedAt: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface RemoteMachineListEntry extends RemoteCatalogMachine {
  sourceId: string;
  sourceName: string;
  /** true = 目录来自过期缓存 */
  stale: boolean;
  /** 本机库已有同一 id（界面据此禁用「下载」） */
  installed: boolean;
}

export interface ListSourcesResult {
  sources: MachineSourceStatus[];
  machines: RemoteMachineListEntry[];
  /** 至少一个来源用了过期缓存 */
  stale: boolean;
}

/**
 * 列出来源与各自目录里的可下载机型（只读工具的后端）。
 *
 * 单个来源失败不影响其它来源：失败只落在该来源的 `online:false` + `errorCode`，
 * 因为「某个源挂了」不该让用户看不到另一个源里能下的机型。
 */
export async function listMachineSources(
  userDataRoot: string,
  options: ListSourcesOptions = {}
): Promise<ListSourcesResult> {
  const sources = readMachineSources(userDataRoot);
  const statuses: MachineSourceStatus[] = [];
  const machines: RemoteMachineListEntry[] = [];
  let anyStale = false;

  for (const source of sources) {
    if (!source.enabled) {
      statuses.push({
        id: source.id,
        name: source.name,
        url: source.url,
        enabled: false,
        allowFile: source.allowFile,
        online: false,
        stale: false,
        machineCount: 0,
        fetchedAt: null
      });
      continue;
    }
    try {
      const result = await fetchMachineCatalog(userDataRoot, source, options);
      if (result.stale) anyStale = true;
      statuses.push({
        id: source.id,
        name: source.name,
        url: source.url,
        enabled: true,
        allowFile: source.allowFile,
        online: true,
        stale: result.stale,
        machineCount: result.catalog.machines.length,
        fetchedAt: result.fetchedAt
      });
      for (const machine of result.catalog.machines) {
        machines.push({
          ...machine,
          sourceId: source.id,
          sourceName: source.name,
          stale: result.stale,
          installed: existsSync(machineLibraryEntryDirectory(userDataRoot, machine.id))
        });
      }
    } catch (error) {
      const code = error instanceof MachineLibraryError ? error.code : 'LIBRARY_NETWORK_FAILED';
      statuses.push({
        id: source.id,
        name: source.name,
        url: source.url,
        enabled: true,
        allowFile: source.allowFile,
        online: false,
        stale: false,
        machineCount: 0,
        fetchedAt: null,
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { sources: statuses, machines, stale: anyStale };
}

export interface DownloadMachineOptions extends CatalogFetchOptions {
  /** 测试/界面用：下载进度回调（只报累计字节，不吐包内容） */
  onProgress?: (receivedBytes: number) => void;
}

export interface DownloadMachineResult {
  entry: MachineLibraryEntry;
  machine: RemoteCatalogMachine;
  source: { id: string; name: string };
  bytes: number;
  sha256: string;
  stale: boolean;
  attempts: number;
  overwritten: boolean;
}

/** 从来源里挑一条机型；先按 id 精确匹配，不做模糊/前缀匹配（避免下错机器）。 */
function findCatalogMachine(catalog: RemoteCatalog, machineId: string): RemoteCatalogMachine {
  const found = catalog.machines.find((machine) => machine.id === machineId);
  if (!found) {
    throw new MachineLibraryError(
      'LIBRARY_MACHINE_NOT_IN_CATALOG',
      `来源目录里没有机型 ${machineId}`,
      '先用 list_machine_sources 查看目录里的机型 id 与来源'
    );
  }
  return found;
}

/**
 * 下载一台机型并入库。
 *
 * 顺序是有意的：先查本地是否已有（不发一个字节的请求）→ 取目录 → 下载（限流+限时+重试一次）
 * → 比 SHA-256 → 交给 `importPackage`（唯一一套严格解包与原子落盘）。
 * 任何一步失败都不会在 `machine-library/<id>/` 留下东西，也不会覆盖已有同名机型。
 */
export async function downloadMachine(
  userDataRoot: string,
  sourceId: string,
  machineId: string,
  options: DownloadMachineOptions = {}
): Promise<DownloadMachineResult> {
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) {
    throw new MachineLibraryError('LIBRARY_SOURCE_INVALID', `来源 id 不合法：${String(sourceId)}`);
  }
  if (typeof machineId !== 'string' || !machineId) {
    throw new MachineLibraryError('LIBRARY_BAD_PATH', '机型 id 不能为空');
  }
  const safeId = sanitizeMachineId(machineId);
  if (safeId !== machineId) {
    throw new MachineLibraryError('LIBRARY_BAD_PATH', `机型 id 不合法（含路径/控制字符或需要净化）：${machineId}`);
  }

  const sources = readMachineSources(userDataRoot);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new MachineLibraryError(
      'LIBRARY_SOURCE_INVALID',
      `没有来源 ${sourceId}`,
      '先在 userData/machine-library/sources.json 里配置来源（或用 list_machine_sources 看已有来源）'
    );
  }
  if (!source.enabled) {
    throw new MachineLibraryError('LIBRARY_SOURCE_DISABLED', `来源「${source.name}」未启用，无法下载`);
  }

  // 同名机型已存在：直接拒，连目录都不拉——覆盖是破坏性操作，必须由人显式决定。
  if (existsSync(machineLibraryEntryDirectory(userDataRoot, machineId))) {
    throw new MachineLibraryError(
      'LIBRARY_EXISTS',
      `机型库里已有 ${machineId}；远程下载不会自动覆盖`,
      '先在机型库抽屉里删除旧机型，或换一个 id 下载'
    );
  }

  const catalogResult = await fetchMachineCatalog(userDataRoot, source, options);
  const machine = findCatalogMachine(catalogResult.catalog, machineId);
  const downloadUrl = assertRemoteUrl(machine.downloadUrl, {
    allowFile: source.allowFile,
    label: `机型 ${machine.id} 的 downloadUrl`
  });
  assertDownloadCanFollow(
    assertRemoteUrl(source.url, { allowFile: source.allowFile, label: '目录源地址' }),
    downloadUrl,
    machine.allowCrossOrigin,
    `机型 ${machine.id} 的 downloadUrl`
  );

  const transport = options.transport ?? nodeRemoteTransport;
  const connectTimeoutMs = options.connectTimeoutMs ?? MACHINE_REMOTE_LIMITS.connectTimeoutMs;
  const totalTimeoutMs = options.totalTimeoutMs ?? MACHINE_REMOTE_LIMITS.totalTimeoutMs;
  let attempts = 0;
  const bytes = await withNetworkRetry(async () => {
    attempts += 1;
    const stream = await transport.open(downloadUrl, {
      connectTimeoutMs,
      totalTimeoutMs,
      maxBytes: MACHINE_REMOTE_LIMITS.maxDownloadBytes,
      accept: 'application/zip'
    });
    return await readCapped(stream, {
      maxBytes: MACHINE_REMOTE_LIMITS.maxDownloadBytes,
      timeoutMs: totalTimeoutMs,
      label: `机型 ${machine.id} 下载`
    });
  }, MACHINE_REMOTE_LIMITS.retries);

  const digest = sha256Hex(bytes);
  if (digest !== machine.sha256) {
    // 校验错误不重试：重试一个被篡改/替换的包只会再拿一次错的东西。
    throw new MachineLibraryError(
      'LIBRARY_HASH_MISMATCH',
      `机型 ${machine.id} 的 SHA-256 与目录不符（目录 ${machine.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已拒绝入库`,
      '可能是目录过期或包被替换；请刷新目录后重试'
    );
  }

  let imported: ImportPackageResult;
  try {
    imported = importPackage(userDataRoot, bytes, {
      overwrite: false,
      source: 'remote',
      ...(options.now ? { now: new Date(options.now()) } : {})
    });
  } catch (error) {
    // 下载内容本身就不合规（结构/白名单/配置）：如实说是包的问题，不是网络问题。
    if (error instanceof MachineLibraryError) throw error;
    throw new MachineLibraryError(
      'LIBRARY_IO_FAILED',
      `机型 ${machine.id} 入库失败：${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    entry: imported.entry,
    machine,
    source: { id: source.id, name: source.name },
    bytes: bytes.byteLength,
    sha256: digest,
    stale: catalogResult.stale,
    attempts,
    overwritten: imported.overwritten
  };
}
