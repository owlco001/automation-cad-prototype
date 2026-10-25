import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { inflateRawSync } from 'node:zlib';

export const MODULE_CATALOG_FORMAT = 'automationcad-module-catalog';
export const MODULE_CATALOG_SCHEMA_VERSION = 1;
export const MAX_MODULE_CATALOG_BYTES = 256 * 1024;
export const MAX_MODULE_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_MODULE_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_MODULE_COUNT = 100;
export const MAX_STAGED_PACKAGE_COUNT = 100;
export const MAX_STAGED_TOTAL_BYTES = 250 * 1024 * 1024;
export const MODULE_CORE_API_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STAGING_DIRECTORY_ENTRIES = 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function validId(value) {
  return typeof value === 'string' && value.length <= 100 && ID_PATTERN.test(value);
}
function validVersion(value) {
  return typeof value === 'string' && value.length <= 80 && VERSION_PATTERN.test(value);
}
function validText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !CONTROL_PATTERN.test(value);
}
function validateLoopbackSource(url) {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}
function normalizeSource(sourceUrl, allowLoopbackForTests) {
  if (sourceUrl === null || sourceUrl === undefined) return null;
  let url;
  try { url = new URL(sourceUrl); } catch { fail('MODULE_SOURCE_INVALID', '模块目录来源配置无效。'); }
  if ((url.protocol !== 'https:' && !(allowLoopbackForTests && validateLoopbackSource(url))) ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/') ||
      url.pathname.split('/').some((part) => part === '.' || part === '..')) {
    fail('MODULE_SOURCE_INVALID', '模块目录来源必须是固定 HTTPS 来源；仅测试可使用回环 HTTP。');
  }
  return url;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function decodeZipName(bytes, utf8) {
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'ascii', { fatal: true }).decode(bytes);
  } catch {
    fail('MODULE_PACKAGE_INVALID', '模块包包含无效文件名编码。');
  }
}
function parseZipEntries(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.length) { eocd = offset; break; }
    }
  }
  if (eocd < 0 || archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0 ||
      archive.readUInt16LE(eocd + 8) !== 2 || archive.readUInt16LE(eocd + 10) !== 2 ||
      archive.readUInt16LE(eocd + 20) !== 0) {
    fail('MODULE_PACKAGE_INVALID', '模块 ZIP 目录结构不受支持。');
  }
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd || centralOffset > archive.length) {
    fail('MODULE_PACKAGE_INVALID', '模块 ZIP 中央目录边界无效。');
  }
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < 2; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) {
      fail('MODULE_PACKAGE_INVALID', '模块 ZIP 中央目录条目无效。');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || nameLength === 0 || extraLength !== 0 || commentLength !== 0 || diskStart !== 0 ||
        (flags & ~0x0800) !== 0 || (method !== 0 && method !== 8) || size > MAX_MODULE_ENTRY_BYTES ||
        compressedSize > MAX_MODULE_PACKAGE_BYTES || localOffset + 30 > centralOffset) {
      fail('MODULE_PACKAGE_INVALID', '模块 ZIP 条目超出允许范围。');
    }
    const name = decodeZipName(archive.subarray(cursor + 46, cursor + 46 + nameLength), (flags & 0x0800) !== 0);
    if (!['module.json', 'module.mjs'].includes(name) || entries.some((entry) => entry.name === name)) {
      fail('MODULE_PACKAGE_INVALID', '模块 ZIP 只能包含 module.json 和 module.mjs。');
    }
    const entry = { name, flags, method, crc, compressedSize, size, localOffset };
    entries.push(entry);
    cursor = end;
  }
  if (cursor !== eocd || entries.map((entry) => entry.name).sort().join(',') !== 'module.json,module.mjs') {
    fail('MODULE_PACKAGE_INVALID', '模块 ZIP 文件清单不符合约定。');
  }
  const localOrder = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let previousEnd = 0;
  for (const entry of localOrder) {
    const offset = entry.localOffset;
    if (offset < previousEnd || archive.readUInt32LE(offset) !== 0x04034b50) {
      fail('MODULE_PACKAGE_INVALID', '模块 ZIP 本地条目边界无效。');
    }
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const crc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = decodeZipName(archive.subarray(offset + 30, offset + 30 + nameLength), (flags & 0x0800) !== 0);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (flags !== entry.flags || method !== entry.method || crc !== entry.crc || extraLength !== 0 ||
        compressedSize !== entry.compressedSize || size !== entry.size || name !== entry.name ||
        dataStart > centralOffset || dataEnd > centralOffset) {
      fail('MODULE_PACKAGE_INVALID', '模块 ZIP 本地条目与中央目录不匹配。');
    }
    entry.dataStart = dataStart;
    entry.dataEnd = dataEnd;
    previousEnd = dataEnd;
  }
  if (localOrder.at(-1).dataEnd !== centralOffset) {
    fail('MODULE_PACKAGE_INVALID', '模块 ZIP 含有未声明数据或重叠条目。');
  }
  return entries;
}
function readZipEntry(archive, entry) {
  const compressed = archive.subarray(entry.dataStart, entry.dataEnd);
  let bytes;
  try {
    bytes = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_MODULE_ENTRY_BYTES });
  } catch {
    fail('MODULE_PACKAGE_INVALID', `模块 ZIP 条目无法安全解压：${entry.name}`);
  }
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
    fail('MODULE_PACKAGE_INVALID', `模块 ZIP 条目大小或 CRC 校验失败：${entry.name}`);
  }
  return bytes;
}
function validateModuleManifest(manifest, moduleBytes) {
  const rootKeys = ['format', 'schemaVersion', 'module', 'coreApiVersion', 'entry', 'files', 'authenticity', 'activation'];
  const moduleKeys = ['id', 'version', 'apiCompatibility', 'dependencies', 'requiredCapabilities'];
  if (!exactKeys(manifest, rootKeys) || manifest.format !== 'automationcad.module-artifact' || manifest.schemaVersion !== 1 ||
      manifest.coreApiVersion !== MODULE_CORE_API_VERSION || manifest.entry !== 'module.mjs' ||
      manifest.authenticity !== 'unsigned' || manifest.activation !== 'blocked-until-trust-policy' ||
      !exactKeys(manifest.module, moduleKeys) || !validId(manifest.module.id) || !validVersion(manifest.module.version)) {
    fail('MODULE_PACKAGE_INVALID', '模块包清单身份、格式或信任状态无效。');
  }
  const compatibility = manifest.module.apiCompatibility;
  if (!exactKeys(compatibility, ['min', 'max']) || !Number.isInteger(compatibility.min) || !Number.isInteger(compatibility.max) ||
      compatibility.min > MODULE_CORE_API_VERSION || compatibility.max < MODULE_CORE_API_VERSION || compatibility.min > compatibility.max ||
      !Array.isArray(manifest.module.dependencies) || manifest.module.dependencies.length > 100 ||
      !manifest.module.dependencies.every((item) => validId(item)) || new Set(manifest.module.dependencies).size !== manifest.module.dependencies.length ||
      !Array.isArray(manifest.module.requiredCapabilities) || manifest.module.requiredCapabilities.length > 100 ||
      !manifest.module.requiredCapabilities.every((item) => validText(item, 120)) || new Set(manifest.module.requiredCapabilities).size !== manifest.module.requiredCapabilities.length) {
    fail('MODULE_PACKAGE_INVALID', '模块 API 兼容范围、依赖或能力声明无效。');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1 || !exactKeys(manifest.files[0], ['path', 'size', 'sha256']) ||
      manifest.files[0].path !== 'module.mjs' || moduleBytes.length === 0 || moduleBytes.length > MAX_MODULE_ENTRY_BYTES ||
      manifest.files[0].size !== moduleBytes.length || !HASH_PATTERN.test(manifest.files[0].sha256) ||
      manifest.files[0].sha256 !== sha256(moduleBytes)) {
    fail('MODULE_PACKAGE_INVALID', '模块入口文件大小或 SHA-256 校验失败。');
  }
  return manifest.module;
}
function validateCatalog(catalog) {
  if (!exactKeys(catalog, ['format', 'schemaVersion', 'coreApiVersion', 'modules']) ||
      catalog.format !== MODULE_CATALOG_FORMAT || catalog.schemaVersion !== MODULE_CATALOG_SCHEMA_VERSION ||
      catalog.coreApiVersion !== MODULE_CORE_API_VERSION || !Array.isArray(catalog.modules) || catalog.modules.length > MAX_MODULE_COUNT) {
    fail('MODULE_CATALOG_INVALID', '模块目录格式、schema 或 Core API 版本不兼容。');
  }
  const seen = new Set();
  const modules = catalog.modules.map((item) => {
    if (!exactKeys(item, ['id', 'name', 'version', 'coreApiVersion', 'dependencies', 'requiredCapabilities', 'packageSize', 'packageSha256', 'authenticity', 'activation']) ||
        !validId(item.id) || !validText(item.name, 120) || !validVersion(item.version) ||
        item.coreApiVersion !== MODULE_CORE_API_VERSION || !Number.isSafeInteger(item.packageSize) ||
        !Array.isArray(item.dependencies) || item.dependencies.length > 100 || !item.dependencies.every(validId) || new Set(item.dependencies).size !== item.dependencies.length ||
        !Array.isArray(item.requiredCapabilities) || item.requiredCapabilities.length > 100 || !item.requiredCapabilities.every((value) => validText(value, 120)) || new Set(item.requiredCapabilities).size !== item.requiredCapabilities.length ||
        item.packageSize <= 0 || item.packageSize > MAX_MODULE_PACKAGE_BYTES || !HASH_PATTERN.test(item.packageSha256) ||
        item.authenticity !== 'unsigned' || item.activation !== 'blocked-until-trust-policy') {
      fail('MODULE_CATALOG_INVALID', '模块目录条目无效或超出允许范围。');
    }
    const key = `${item.id}\n${item.version}`;
    if (seen.has(key)) fail('MODULE_CATALOG_INVALID', '模块目录存在重复 ID/版本。');
    seen.add(key);
    return { ...item, dependencies: [...item.dependencies], requiredCapabilities: [...item.requiredCapabilities] };
  });
  return modules;
}
function requestBytes(url, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(url, { method: 'GET', headers: { accept: 'application/json, application/octet-stream', 'accept-encoding': 'identity' } }, (response) => {
      const status = response.statusCode ?? 0;
      const encoding = response.headers['content-encoding'];
      const lengthHeader = response.headers['content-length'];
      const expectedLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (status !== 200 || (encoding && encoding !== 'identity') ||
          (lengthHeader !== undefined && (!/^\d+$/u.test(String(lengthHeader)) || expectedLength > maxBytes))) {
        response.resume();
        reject(Object.assign(new Error('模块目录源响应状态或大小不符合策略。'), { code: 'MODULE_SOURCE_RESPONSE_INVALID' }));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          request.destroy();
          reject(Object.assign(new Error('模块目录源响应超过大小上限。'), { code: 'MODULE_SOURCE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.complete !== true || (expectedLength !== undefined && total !== expectedLength)) {
          reject(Object.assign(new Error('模块目录源响应长度不完整。'), { code: 'MODULE_SOURCE_RESPONSE_INVALID' }));
          return;
        }
        resolve(Buffer.concat(chunks, total));
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('模块目录源请求超时。'), { code: 'MODULE_SOURCE_TIMEOUT' })));
    request.on('error', reject);
    request.end();
  });
}
async function ensureSafeDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('MODULE_STAGE_PATH_INVALID', '模块暂存目录不是安全的普通目录。');
}
async function inspectStagingDirectory(directory) {
  await ensureSafeDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_STAGING_DIRECTORY_ENTRIES) fail('MODULE_STAGE_LIMIT', '模块暂存目录条目数超过上限。');
  let packageCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const isPackage = entry.name.endsWith('.acmodule.zip');
    const isTemporary = /^\.module-[0-9a-f-]{36}\.part$/u.test(entry.name);
    if (!isPackage && !isTemporary) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink() || info.size > MAX_MODULE_PACKAGE_BYTES) {
      fail('MODULE_STAGE_PATH_INVALID', '暂存目录内存在非普通文件或超限包。');
    }
    if (isPackage) packageCount += 1;
    totalBytes += info.size;
  }
  if (packageCount > MAX_STAGED_PACKAGE_COUNT || totalBytes > MAX_STAGED_TOTAL_BYTES) {
    fail('MODULE_STAGE_LIMIT', '现有模块暂存内容已超过数量或总空间上限。');
  }
  return { entries, packageCount, totalBytes };
}
async function ensureStagingCapacity(directory, incomingBytes) {
  const { entries, packageCount, totalBytes } = await inspectStagingDirectory(directory);
  if (entries.length >= MAX_STAGING_DIRECTORY_ENTRIES || packageCount >= MAX_STAGED_PACKAGE_COUNT ||
      totalBytes + incomingBytes > MAX_STAGED_TOTAL_BYTES) {
    fail('MODULE_STAGE_LIMIT', '模块暂存区已达到包数、目录条目数或 250 MiB 总空间上限。');
  }
}
async function atomicStore(directory, targetPath, bytes) {
  await ensureStagingCapacity(directory, bytes.length);
  const temporaryPath = join(directory, `.module-${randomUUID()}.part`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    try {
      const dir = await open(directory, 'r');
      await dir.sync();
      await dir.close();
    } catch { /* Directory fsync is unavailable on some supported filesystems. */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ModuleStagingService {
  #source;
  #directory;
  #stagingEnabled;
  #allowLoopbackForTests;
  #downloadLock = Promise.resolve();

  constructor({ sourceUrl = null, stagingDirectory, stagingEnabled = false, allowLoopbackForTests = false } = {}) {
    if (typeof stagingDirectory !== 'string' || stagingDirectory.length === 0) {
      fail('MODULE_STAGE_PATH_INVALID', '必须指定应用专用的模块暂存目录。');
    }
    this.#allowLoopbackForTests = allowLoopbackForTests === true;
    this.#source = normalizeSource(sourceUrl, this.#allowLoopbackForTests);
    this.#directory = resolve(stagingDirectory);
    this.#stagingEnabled = stagingEnabled === true;
  }
  #assertStagingEnabled() {
    if (!this.#stagingEnabled) fail('MODULE_STAGE_DISABLED', '模块本机暂存未启用；未访问暂存目录。');
  }

  async getCatalog() {
    if (!this.#source) return { configured: false, state: 'unconfigured', modules: [] };
    const url = new URL('catalog.json', this.#source);
    const bytes = await requestBytes(url, MAX_MODULE_CATALOG_BYTES);
    let catalog;
    try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('MODULE_CATALOG_INVALID', '模块目录不是有效的 UTF-8 JSON。'); }
    return { configured: true, state: 'ready', modules: validateCatalog(catalog) };
  }

  async downloadModule(id, version) {
    if (!validId(id) || !validVersion(version)) fail('MODULE_REQUEST_INVALID', '模块 ID 或版本格式无效。');
    this.#assertStagingEnabled();
    if (!this.#source) fail('MODULE_SOURCE_UNCONFIGURED', '尚未配置受信任的模块目录来源；没有进行网络请求。');
    return this.#withDownloadLock(() => this.#downloadModuleLocked(id, version));
  }
  async removeStagedModule(id, version) {
    if (!validId(id) || !validVersion(version)) fail('MODULE_REQUEST_INVALID', '模块 ID 或版本格式无效。');
    this.#assertStagingEnabled();
    return this.#withDownloadLock(() => this.#removeStagedModuleLocked(id, version));
  }

  async #withDownloadLock(operation) {
    const previous = this.#downloadLock;
    let release;
    this.#downloadLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async #downloadModuleLocked(id, version) {
    const catalog = await this.getCatalog();
    const item = catalog.modules.find((module) => module.id === id && module.version === version);
    if (!item) fail('MODULE_NOT_IN_CATALOG', '所选模块不在当前固定来源的有效目录中。');
    const filename = `${item.id}-${item.version}-${item.packageSha256.slice(0, 16)}.acmodule.zip`;
    const targetPath = join(this.#directory, filename);
    try {
      const info = await lstat(targetPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MODULE_PACKAGE_BYTES) {
        fail('MODULE_STAGE_PATH_INVALID', '已有暂存路径不是安全的普通模块包。');
      }
      const current = await readFile(targetPath);
      this.#validatePackage(current, item);
      return this.#stagedSummary(item);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const relativePath = `modules/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}.acmodule.zip`;
    const bytes = await requestBytes(new URL(relativePath, this.#source), item.packageSize);
    this.#validatePackage(bytes, item);
    await atomicStore(this.#directory, targetPath, bytes);
    return this.#stagedSummary(item);
  }

  async listStagedModules() {
    this.#assertStagingEnabled();
    const { entries } = await inspectStagingDirectory(this.#directory);
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.acmodule.zip')) continue;
      const match = /^([a-z0-9]+(?:[.-][a-z0-9]+)*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([a-f0-9]{16})\.acmodule\.zip$/u.exec(entry.name);
      if (!match) continue;
      const bytes = await readFile(join(this.#directory, entry.name));
      if (bytes.length > MAX_MODULE_PACKAGE_BYTES) continue;
      const actualHash = sha256(bytes);
      if (!actualHash.startsWith(match[3])) continue;
      const module = this.#validatePackage(bytes, { id: match[1], version: match[2], packageSize: bytes.length, packageSha256: actualHash, authenticity: 'unsigned', activation: 'blocked-until-trust-policy' });
      result.push({ id: module.id, version: module.version, packageSize: bytes.length, packageSha256: actualHash,
        dependencies: [...module.dependencies], requiredCapabilities: [...module.requiredCapabilities],
        authenticity: 'unsigned', activation: 'blocked-until-trust-policy' });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  }

  async #removeStagedModuleLocked(id, version) {
    const { entries } = await inspectStagingDirectory(this.#directory);
    const prefix = `${id}-${version}-`;
    const candidates = entries.filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.acmodule.zip'));
    if (candidates.length === 0) fail('MODULE_STAGED_PACKAGE_NOT_FOUND', '未找到所选 ID/版本的已验证暂存缓存包。');
    if (candidates.length !== 1) fail('MODULE_STAGED_PACKAGE_AMBIGUOUS', '所选 ID/版本对应多个缓存包；未删除任何文件。');
    const entry = candidates[0];
    const match = /^([a-z0-9]+(?:[.-][a-z0-9]+)*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([a-f0-9]{16})\.acmodule\.zip$/u.exec(entry.name);
    if (!match || match[1] !== id || match[2] !== version || !entry.isFile() || entry.isSymbolicLink()) {
      fail('MODULE_STAGE_PATH_INVALID', '所选暂存包文件名或文件类型不安全；未删除任何文件。');
    }
    const stagingDirectory = resolve(this.#directory);
    const originalDirectoryInfo = await lstat(stagingDirectory);
    if (!originalDirectoryInfo.isDirectory() || originalDirectoryInfo.isSymbolicLink()) {
      fail('MODULE_STAGE_PATH_INVALID', '模块暂存根目录不是安全的普通目录。');
    }
    const targetPath = resolve(stagingDirectory, entry.name);
    if (dirname(targetPath) !== stagingDirectory || targetPath !== join(stagingDirectory, entry.name)) {
      fail('MODULE_STAGE_PATH_INVALID', '所选暂存包路径不在固定暂存目录内。');
    }
    const originalInfo = await lstat(targetPath);
    if (!originalInfo.isFile() || originalInfo.isSymbolicLink() || originalInfo.size > MAX_MODULE_PACKAGE_BYTES) {
      fail('MODULE_STAGE_PATH_INVALID', '所选暂存包不是安全的普通文件；未删除任何文件。');
    }
    const bytes = await readFile(targetPath);
    if (bytes.length !== originalInfo.size || bytes.length > MAX_MODULE_PACKAGE_BYTES) {
      fail('MODULE_STAGE_PATH_INVALID', '所选暂存包在校验期间发生变化；未删除任何文件。');
    }
    const actualHash = sha256(bytes);
    if (!actualHash.startsWith(match[3])) fail('MODULE_PACKAGE_HASH_MISMATCH', '所选暂存包与其缓存文件名校验值不符。');
    const module = this.#validatePackage(bytes, {
      id: match[1], version: match[2], packageSize: bytes.length, packageSha256: actualHash,
      authenticity: 'unsigned', activation: 'blocked-until-trust-policy'
    });
    if (module.id !== id || module.version !== version) fail('MODULE_PACKAGE_ID_MISMATCH', '暂存包内部 ID/版本与所选项不一致。');
    const currentDirectoryInfo = await lstat(stagingDirectory);
    if (!currentDirectoryInfo.isDirectory() || currentDirectoryInfo.isSymbolicLink() ||
        currentDirectoryInfo.dev !== originalDirectoryInfo.dev || currentDirectoryInfo.ino !== originalDirectoryInfo.ino) {
      fail('MODULE_STAGE_PATH_INVALID', '模块暂存根目录在删除前发生变化；未删除任何文件。');
    }
    const currentInfo = await lstat(targetPath);
    if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || currentInfo.dev !== originalInfo.dev ||
        currentInfo.ino !== originalInfo.ino || currentInfo.size !== originalInfo.size) {
      fail('MODULE_STAGE_PATH_INVALID', '所选暂存包在删除前发生变化；未删除任何文件。');
    }
    await unlink(targetPath);
    try {
      const directoryHandle = await open(stagingDirectory, 'r');
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch { /* Directory fsync is unavailable on some supported filesystems. */ }
    return { id, version, packageSize: bytes.length, removed: true };
  }

  #validatePackage(bytes, catalogItem) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== catalogItem.packageSize || bytes.length > MAX_MODULE_PACKAGE_BYTES ||
        sha256(bytes) !== catalogItem.packageSha256) {
      fail('MODULE_PACKAGE_HASH_MISMATCH', '模块包总体大小或 SHA-256 与固定目录不匹配。');
    }
    const entries = parseZipEntries(bytes);
    const manifestBytes = readZipEntry(bytes, entries.find((entry) => entry.name === 'module.json'));
    const moduleBytes = readZipEntry(bytes, entries.find((entry) => entry.name === 'module.mjs'));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('MODULE_PACKAGE_INVALID', '模块清单超过大小上限。');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
    catch { fail('MODULE_PACKAGE_INVALID', '模块包清单不是有效的 UTF-8 JSON。'); }
    const module = validateModuleManifest(manifest, moduleBytes);
    if (module.id !== catalogItem.id || module.version !== catalogItem.version) {
      fail('MODULE_PACKAGE_ID_MISMATCH', '模块包内 ID/版本与固定目录不一致。');
    }
    if (Array.isArray(catalogItem.dependencies) &&
        (module.dependencies.slice().sort().join('\n') !== catalogItem.dependencies.slice().sort().join('\n') ||
         module.requiredCapabilities.slice().sort().join('\n') !== catalogItem.requiredCapabilities.slice().sort().join('\n'))) {
      fail('MODULE_PACKAGE_DECLARATION_MISMATCH', '模块包依赖或能力声明与固定目录不一致。');
    }
    if (manifest.authenticity !== catalogItem.authenticity || manifest.activation !== catalogItem.activation) {
      fail('MODULE_PACKAGE_INVALID', '模块包信任状态与固定目录不一致。');
    }
    return module;
  }

  #stagedSummary(item) {
    return { id: item.id, name: item.name, version: item.version, packageSize: item.packageSize,
      packageSha256: item.packageSha256, dependencies: [...item.dependencies], requiredCapabilities: [...item.requiredCapabilities],
      authenticity: 'unsigned', activation: 'blocked-until-trust-policy', staged: true };
  }
}

export function isLoopbackSourceForTests(sourceUrl) {
  try { return validateLoopbackSource(new URL(sourceUrl)); } catch { return false; }
}
