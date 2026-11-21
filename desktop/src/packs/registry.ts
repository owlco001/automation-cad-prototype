import AdmZip from 'adm-zip';
import fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ComponentPart, PackInfo, PackManifest, PackRequirement } from '../shared/types';
import { assertPartsIntegrity } from './validate.ts';

export interface PackRegistryOptions {
  builtinDir: string;
  userDir: string;
  stateFile: string;
  /** 测试可注入读取函数，用来断言 manifest / parts.json 的实际读取次数。 */
  readTextFile?: (path: string) => string;
}

export interface PackMetrics {
  /** 累计读取并校验 parts.json 的耗时（毫秒）。 */
  packLoadMs: number;
  /** 当前缓存在内存中的元器件包数量。 */
  loadedPacks: number;
  /** 当前缓存中的元器件条目总数。 */
  partsLoaded: number;
  /** 最近一次搜索/列表耗时（毫秒）。 */
  searchMs: number;
  /** 扫描到的 manifest 数量（含价格簿）。 */
  packCount: number;
  /** 已构建的 partId 全局索引条目数；未构建时为 0。 */
  indexedParts: number;
}

interface CachedPack {
  parts: ComponentPart[];
  searchText: string[];
  loadMs: number;
}

interface PackIndexEntry {
  info: PackInfo;
  manifest?: PackManifest;
  dir: string;
  builtin: boolean;
  hasParts: boolean;
}

interface PackState {
  disabled: string[];
}

const MANIFEST_REQUIRED = ['schemaVersion', 'id', 'name', 'vendor', 'version', 'categories', 'partsCount'] as const;
const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SYMBOL_PATTERN = /^[a-z][a-z0-9]{0,7}$/;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown): PackManifest {
  if (!isRecord(value)) throw new Error('manifest.json 必须是对象');
  for (const key of MANIFEST_REQUIRED) {
    if (!(key in value)) throw new Error(`缺少必填参数：manifest.${key}`);
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new Error('manifest.schemaVersion 必须为 1 或 2');
  if (typeof value.id !== 'string' || !PACK_ID_PATTERN.test(value.id)) throw new Error('manifest.id 格式不合法');
  for (const key of ['name', 'vendor', 'version'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`manifest.${key} 必须是非空字符串`);
    }
  }
  for (const key of ['license', 'description'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`manifest.${key} 必须是字符串`);
    }
  }
  if (!Array.isArray(value.categories) || value.categories.length === 0) {
    throw new Error('manifest.categories 必须是非空字符串数组');
  }
  const categories: string[] = [];
  for (const category of value.categories) {
    if (typeof category !== 'string' || category.trim() === '') {
      throw new Error('manifest.categories 必须是非空字符串数组');
    }
    if (!categories.includes(category.trim())) categories.push(category.trim());
  }
  if (!Number.isInteger(value.partsCount) || (value.partsCount as number) < 0) {
    throw new Error('manifest.partsCount 必须是非负整数');
  }
  const keywords: string[] = [];
  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords)) throw new Error('manifest.keywords 必须是字符串数组');
    for (const keyword of value.keywords) {
      if (typeof keyword !== 'string' || keyword.trim() === '') {
        throw new Error('manifest.keywords 必须是字符串数组');
      }
      if (!keywords.includes(keyword.trim())) keywords.push(keyword.trim());
    }
  }
  const manifest: PackManifest = {
    schemaVersion: value.schemaVersion,
    id: value.id,
    name: value.name as string,
    vendor: value.vendor as string,
    version: value.version as string,
    categories,
    partsCount: value.partsCount as number
  };
  if (typeof value.license === 'string') manifest.license = value.license;
  if (typeof value.description === 'string') manifest.description = value.description;
  if (keywords.length > 0) manifest.keywords = keywords;
  if (value.partsSha256 !== undefined) {
    if (typeof value.partsSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.partsSha256)) {
      throw new Error('manifest.partsSha256 必须是 64 位十六进制 SHA-256');
    }
    manifest.partsSha256 = value.partsSha256.toLowerCase();
  }
  if (value.requires !== undefined) {
    if (!Array.isArray(value.requires)) throw new Error('manifest.requires 必须是数组');
    const requires: PackRequirement[] = [];
    value.requires.forEach((item, index) => {
      if (!isRecord(item) || typeof item.pack !== 'string' || item.pack.trim() === '' ||
          typeof item.version !== 'string' || item.version.trim() === '') {
        throw new Error(`manifest.requires[${index}] 必须是 {pack, version}`);
      }
      requires.push({ pack: item.pack.trim(), version: item.version.trim() });
    });
    if (requires.length > 0) manifest.requires = requires;
  }
  return manifest;
}

function validateParts(value: unknown, packId: string, packName: string): ComponentPart[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.parts)
      ? value.parts
      : null;
  if (!source) throw new Error('parts.json 必须是元器件数组');
  const seen = new Set<string>();
  return source.map((item, index) => {
    if (!isRecord(item)) throw new Error(`parts[${index}] 必须是对象`);
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`缺少必填参数：parts[${index}].id`);
    }
    if (seen.has(item.id)) throw new Error(`parts 中存在重复 id：${item.id}`);
    seen.add(item.id);
    if (typeof item.model !== 'string' || item.model.trim() === '') {
      throw new Error(`parts[${index}].model 必须是非空字符串`);
    }
    if (typeof item.category !== 'string' || item.category.trim() === '') {
      throw new Error(`parts[${index}].category 必须是非空字符串`);
    }
    const rawSpecs = isRecord(item.specs) ? item.specs : {};
    const specs: Record<string, string | number> = {};
    for (const [key, spec] of Object.entries(rawSpecs)) {
      if (typeof spec !== 'string' && (typeof spec !== 'number' || !Number.isFinite(spec))) {
        throw new Error(`parts[${index}].specs.${key} 必须是字符串或有限数字`);
      }
      specs[key] = spec;
    }
    if (item.price !== undefined &&
        (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0)) {
      throw new Error(`parts[${index}].price 必须是非负有限数`);
    }
    const part: ComponentPart = {
      id: item.id,
      model: item.model,
      category: item.category,
      specs,
      packId,
      packName
    };
    if (item.aliasOf !== undefined) {
      if (typeof item.aliasOf !== 'string' || item.aliasOf.trim() === '') {
        throw new Error(`parts[${index}].aliasOf 必须是非空字符串`);
      }
      part.aliasOf = item.aliasOf.trim();
    }
    if (typeof item.vendor === 'string') part.vendor = item.vendor;
    if (item.symbol !== undefined) {
      if (typeof item.symbol !== 'string' || (item.symbol !== '' && !SYMBOL_PATTERN.test(item.symbol))) {
        throw new Error(`parts[${index}].symbol 必须是 1-8 位小写字母开头的键`);
      }
      if (item.symbol !== '') part.symbol = item.symbol;
    }
    if (item.dims !== undefined) {
      if (!isRecord(item.dims) || !isPositiveNumber(item.dims.w) || !isPositiveNumber(item.dims.h) || !isPositiveNumber(item.dims.d)) {
        throw new Error(`parts[${index}].dims 必须是 {w,h,d} 正数`);
      }
      if (item.dims.source !== undefined && typeof item.dims.source !== 'string') {
        throw new Error(`parts[${index}].dims.source 必须是字符串`);
      }
      if (item.dims.estimated !== undefined && typeof item.dims.estimated !== 'boolean') {
        throw new Error(`parts[${index}].dims.estimated 必须是布尔值`);
      }
      part.dims = { w: item.dims.w, h: item.dims.h, d: item.dims.d };
      if (typeof item.dims.source === 'string') part.dims.source = item.dims.source;
      if (item.dims.estimated === true) part.dims.estimated = true;
    }
    if (item.railMount !== undefined) {
      if (typeof item.railMount !== 'boolean') throw new Error(`parts[${index}].railMount 必须是布尔值`);
      part.railMount = item.railMount;
    }
    if (item.moduleWidth !== undefined) {
      if (!isPositiveNumber(item.moduleWidth)) throw new Error(`parts[${index}].moduleWidth 必须是正数`);
      part.moduleWidth = item.moduleWidth;
    }
    if (typeof item.asset === 'string') part.asset = item.asset;
    if (typeof item.thumbnail === 'string') part.thumbnail = item.thumbnail;
    if (typeof item.price === 'number') part.price = item.price;
    return part;
  });
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeZipEntryName(name: string): string {
  if (name.includes('\\')) throw new Error(`ZIP 路径包含反斜杠，已拒绝：${name}`);
  if (name.includes('\0')) throw new Error('ZIP 路径包含非法字符');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`ZIP 包含绝对路径：${name}`);
  const normalized = name.replace(/\/+/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`ZIP 包含路径穿越：${name}`);
  }
  return normalized;
}

function lower(value: string): string {
  return value.toLocaleLowerCase('zh-CN');
}

function searchTextForParts(parts: ComponentPart[]): string[] {
  return parts.map((part) => lower([
    part.id, part.model, part.category, part.vendor ?? '', part.packId ?? '', part.packName ?? '',
    ...Object.values(part.specs).map(String)
  ].join(' ')));
}

export class PackRegistry {
  private readonly builtinDir: string;
  private readonly userDir: string;
  private readonly stateFile: string;
  private readonly readTextFile: (path: string) => string;
  private index: PackIndexEntry[] | null = null;
  private readonly loadedPacks = new Map<string, CachedPack>();
  private partIndex: Map<string, ComponentPart> | null = null;
  private totalPackLoadMs = 0;
  private lastSearchMs = 0;

  constructor(options: PackRegistryOptions) {
    this.builtinDir = resolve(options.builtinDir);
    this.userDir = resolve(options.userDir);
    this.stateFile = resolve(options.stateFile);
    // 默认走 fs 对象的运行时属性，便于测试在构造前用 spy 替换 readFileSync。
    this.readTextFile = options.readTextFile ?? ((path) => fs.readFileSync(path, 'utf8'));
  }

  async scan(): Promise<PackInfo[]> {
    return this.scanSync();
  }

  /** 只读 manifest 的包索引；首次访问时建立，之后复用。 */
  private scanSync(): PackInfo[] {
    return this.ensureIndex().map((entry) => this.infoSnapshot(entry));
  }

  /** 首次访问时读取 parts.json 并缓存。 */
  loadPack(id: string): PackInfo {
    const entry = this.requireEntry(id);
    if (entry.info.error) throw new Error(entry.info.error);
    if (!entry.hasParts) throw new Error(`数据包不包含 parts.json：${id}`);
    if (!entry.info.enabled) throw new Error(`数据包已禁用：${id}`);
    this.loadEntry(entry);
    return this.infoSnapshot(entry);
  }

  /** 释放单包 parts.json 内存缓存（不影响 manifest 索引）。 */
  unloadPack(id: string): boolean {
    const removed = this.loadedPacks.delete(id);
    const entry = this.index?.find((candidate) => candidate.info.id === id);
    if (entry?.manifest) entry.info.partCount = entry.manifest.partsCount;
    if (removed) this.partIndex = null;
    return removed;
  }

  isPackLoaded(id: string): boolean {
    return this.loadedPacks.has(id);
  }

  loadedPackIds(): string[] {
    return Array.from(this.loadedPacks.keys()).sort();
  }

  /** 按 partId 懒建全局索引；内置包优先，重复 id 只保留首个。别名会解析到目标型号。 */
  getPartById(id: string): ComponentPart | undefined {
    const index = this.ensurePartIndex();
    let part = index.get(id);
    const seen = new Set<string>([id]);
    while (part?.aliasOf) {
      if (seen.has(part.aliasOf)) return undefined;
      seen.add(part.aliasOf);
      part = index.get(part.aliasOf);
      if (!part) return undefined;
    }
    return part;
  }

  getPartIndexSize(): number {
    return this.partIndex?.size ?? 0;
  }

  metrics(): PackMetrics {
    let partsLoaded = 0;
    for (const cached of this.loadedPacks.values()) partsLoaded += cached.parts.length;
    return {
      packLoadMs: Math.round(this.totalPackLoadMs * 1000) / 1000,
      loadedPacks: this.loadedPacks.size,
      partsLoaded,
      searchMs: Math.round(this.lastSearchMs * 1000) / 1000,
      packCount: this.index?.length ?? 0,
      indexedParts: this.partIndex?.size ?? 0
    };
  }

  listParts(filter: { q?: string; category?: string; packId?: string } = {}): ComponentPart[] {
    const startedAt = performance.now();
    const q = filter.q?.trim() ? lower(filter.q.trim()) : '';
    const category = filter.category?.trim() ? lower(filter.category.trim()) : '';
    let entries = this.ensureIndex().filter((entry) => entry.hasParts && entry.info.enabled && !entry.info.error);
    if (filter.packId) entries = entries.filter((entry) => entry.info.id === filter.packId);
    if (category) {
      entries = entries.filter((entry) => {
        const categories = entry.manifest?.categories ?? [];
        return categories.length === 0 || categories.some((item) => lower(item) === category);
      });
    }
    // Manifest metadata is not exhaustive for model/spec text. Keep catalog
    // order so text search preserves the same duplicate-ID precedence.
    const result: ComponentPart[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      let parts: ComponentPart[];
      let searchText: string[];
      try {
        parts = this.loadEntry(entry);
        searchText = this.loadedPacks.get(entry.info.id)?.searchText ?? [];
      } catch {
        continue;
      }
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        if (part.aliasOf) continue;
        if (seen.has(part.id)) continue;
        seen.add(part.id);
        if (category && lower(part.category) !== category) continue;
        if (q && !searchText[index]!.includes(q)) continue;
        result.push(part);
      }
    }
    this.lastSearchMs = performance.now() - startedAt;
    return result;
  }

  async importZip(zipPath: string): Promise<PackInfo> {
    const absoluteZip = resolve(zipPath);
    if (!existsSync(absoluteZip) || !statSync(absoluteZip).isFile()) throw new Error(`ZIP 文件不存在：${zipPath}`);
    const zip = new AdmZip(absoluteZip);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    for (const entry of entries) safeZipEntryName(entry.entryName);

    const manifestEntries = entries.filter((entry) => {
      const parts = safeZipEntryName(entry.entryName).split('/');
      return parts[parts.length - 1] === 'manifest.json' && parts.length <= 2;
    });
    if (manifestEntries.length !== 1) throw new Error('ZIP 根目录必须包含唯一的 manifest.json');
    const manifestEntry = manifestEntries[0]!;
    const manifestName = safeZipEntryName(manifestEntry.entryName);
    const rootPrefix = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : '';
    const rootFolder = rootPrefix ? rootPrefix.slice(0, -1) : '';
    const manifest = validateManifest(JSON.parse(manifestEntry.getData().toString('utf8')) as unknown);
    if (rootFolder && rootFolder !== manifest.id) {
      throw new Error(`manifest.id (${manifest.id}) 与 ZIP 根目录名 (${rootFolder}) 不一致`);
    }
    if (!entries.some((entry) => safeZipEntryName(entry.entryName) === `${rootPrefix}parts.json`)) {
      throw new Error('ZIP 条目不存在：parts.json');
    }

    const target = join(this.userDir, manifest.id);
    if (existsSync(target) || existsSync(join(this.builtinDir, manifest.id))) {
      throw new Error(`数据包 id 已存在：${manifest.id}`);
    }

    mkdirSync(this.userDir, { recursive: true });
    const tempDir = join(this.userDir, `.import-${manifest.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: false });
    let staged: PackIndexEntry;
    let parts: ComponentPart[];
    let searchText: string[];
    let partsLoadMs = 0;
    try {
      for (const entry of entries) {
        const safeName = safeZipEntryName(entry.entryName);
        if (rootPrefix) {
          if (!safeName.startsWith(rootPrefix)) throw new Error(`ZIP 文件不在包根目录内：${entry.entryName}`);
        }
        const relativeName = safeName.slice(rootPrefix.length);
        if (!relativeName) continue;
        const destination = resolve(tempDir, relativeName);
        if (!isPathInside(tempDir, destination)) throw new Error(`ZIP 路径穿越：${entry.entryName}`);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, entry.getData());
      }
      if (!existsSync(join(tempDir, 'manifest.json')) || !existsSync(join(tempDir, 'parts.json'))) {
        throw new Error('ZIP 条目不存在：manifest.json 或 parts.json');
      }
      staged = this.readManifestDirectory(tempDir, manifest.id, false, new Set(this.readState().disabled));
      if (!staged.manifest || staged.info.error) throw new Error(staged.info.error ?? 'ZIP manifest 无效');
      const partsStartedAt = performance.now();
      parts = this.readEntryParts(staged.dir, staged.manifest);
      if (parts.length === 0) throw new Error('parts.json 不能为空');
      searchText = searchTextForParts(parts);
      partsLoadMs = performance.now() - partsStartedAt;
      renameSync(tempDir, target);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    this.invalidateIndex(manifest.id);
    this.cacheEntryParts(staged, parts, searchText, partsLoadMs);
    return this.infoSnapshot({ ...staged, dir: target, info: { ...staged.info, path: target } });
  }

  async setEnabled(id: string, on: boolean): Promise<void> {
    const allIds = new Set(this.ensureIndex().map((entry) => entry.info.id));
    if (!allIds.has(id)) throw new Error(`数据包不存在：${id}`);
    const state = this.readState();
    const disabled = new Set(state.disabled);
    if (on) disabled.delete(id);
    else disabled.add(id);
    this.writeState({ disabled: Array.from(disabled).sort() });
    this.invalidateIndex(id);
  }

  async remove(id: string): Promise<void> {
    if (existsSync(join(this.builtinDir, id))) throw new Error('内置数据包不可删除');
    const target = join(this.userDir, id);
    if (!existsSync(target)) throw new Error(`用户数据包不存在：${id}`);
    rmSync(target, { recursive: true, force: true });
    const disabled = this.readState().disabled.filter((packId) => packId !== id);
    this.writeState({ disabled });
    this.invalidateIndex(id);
  }

  private invalidateIndex(unloadId?: string): void {
    if (unloadId) this.loadedPacks.delete(unloadId);
    this.partIndex = null;
    this.index = null;
  }

  private ensureIndex(): PackIndexEntry[] {
    if (this.index) return this.index;
    const disabled = new Set(this.readState().disabled);
    const byId = new Map<string, PackIndexEntry>();
    for (const [root, builtin] of [
      [this.builtinDir, true],
      [this.userDir, false]
    ] as const) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const loaded = this.readManifestDirectory(join(root, entry.name), entry.name, builtin, disabled);
        if (!byId.has(loaded.info.id)) byId.set(loaded.info.id, loaded);
      }
    }
    this.index = Array.from(byId.values());
    return this.index;
  }

  private readManifestDirectory(
    dir: string,
    directoryName: string,
    builtin: boolean,
    disabled: Set<string>
  ): PackIndexEntry {
    const hasParts = existsSync(join(dir, 'parts.json'));
    const fallback: PackInfo = {
      id: directoryName,
      name: directoryName,
      vendor: '',
      version: '',
      enabled: !disabled.has(directoryName),
      builtin,
      path: dir,
      partCount: 0,
      categories: []
    };
    try {
      const manifest = validateManifest(JSON.parse(this.readTextFile(join(dir, 'manifest.json'))) as unknown);
      if (manifest.id !== directoryName) {
        throw new Error(`manifest.id (${manifest.id}) 与目录名 (${directoryName}) 不一致`);
      }
      return {
        manifest,
        dir,
        builtin,
        hasParts,
        info: {
          id: manifest.id,
          name: manifest.name,
          vendor: manifest.vendor,
          version: manifest.version,
          ...(manifest.description ? { description: manifest.description } : {}),
          ...(manifest.license ? { license: manifest.license } : {}),
          enabled: !disabled.has(manifest.id),
          builtin,
          path: dir,
          partCount: manifest.partsCount,
          categories: [...manifest.categories],
          ...(manifest.keywords ? { keywords: [...manifest.keywords] } : {})
        }
      };
    } catch (error) {
      return {
        dir,
        builtin,
        hasParts,
        info: {
          ...fallback,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private requireEntry(id: string): PackIndexEntry {
    const entry = this.ensureIndex().find((candidate) => candidate.info.id === id);
    if (!entry) throw new Error(`数据包不存在：${id}`);
    return entry;
  }

  private loadEntry(entry: PackIndexEntry): ComponentPart[] {
    const cached = this.loadedPacks.get(entry.info.id);
    if (cached) return cached.parts;
    if (!entry.manifest) throw new Error(entry.info.error ?? `数据包 manifest 无效：${entry.info.id}`);
    const startedAt = performance.now();
    try {
      const raw = this.readTextFile(join(entry.dir, 'parts.json'));
      assertPartsIntegrity(raw, entry.manifest.partsSha256, entry.manifest.id);
      const parts = validateParts(JSON.parse(raw) as unknown, entry.manifest.id, entry.manifest.name);
      this.cacheEntryParts(entry, parts, searchTextForParts(parts), performance.now() - startedAt);
      return parts;
    } catch (error) {
      entry.info.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private readEntryParts(dir: string, manifest: PackManifest): ComponentPart[] {
    const raw = this.readTextFile(join(dir, 'parts.json'));
    assertPartsIntegrity(raw, manifest.partsSha256, manifest.id);
    return validateParts(JSON.parse(raw) as unknown, manifest.id, manifest.name);
  }

  private cacheEntryParts(entry: PackIndexEntry, parts: ComponentPart[], searchText: string[], loadMs: number): void {
    this.loadedPacks.set(entry.info.id, { parts, searchText, loadMs });
    entry.info.partCount = parts.length;
    this.totalPackLoadMs += loadMs;
    this.partIndex = null;
  }

  private ensurePartIndex(): Map<string, ComponentPart> {
    if (this.partIndex) return this.partIndex;
    const index = new Map<string, ComponentPart>();
    for (const entry of this.ensureIndex()) {
      if (!entry.hasParts || !entry.info.enabled || entry.info.error) continue;
      let parts: ComponentPart[];
      try {
        parts = this.loadEntry(entry);
      } catch {
        continue;
      }
      for (const part of parts) {
        if (!index.has(part.id)) index.set(part.id, part);
      }
    }
    this.partIndex = index;
    return index;
  }

  private infoSnapshot(entry: PackIndexEntry): PackInfo {
    const cached = this.loadedPacks.get(entry.info.id);
    return {
      ...entry.info,
      partCount: cached ? cached.parts.length : entry.info.partCount,
      categories: [...entry.info.categories],
      ...(entry.info.keywords ? { keywords: [...entry.info.keywords] } : {})
    };
  }

  private readState(): PackState {
    try {
      const value = JSON.parse(this.readTextFile(this.stateFile)) as unknown;
      if (!isRecord(value) || !Array.isArray(value.disabled)) return { disabled: [] };
      return { disabled: value.disabled.filter((item): item is string => typeof item === 'string') };
    } catch (error) {
      if (existsSync(this.stateFile)) {
        console.warn('[packs] 读取启停状态失败，按全部启用处理', error);
      }
      return { disabled: [] };
    }
  }

  private writeState(state: PackState): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.stateFile);
  }
}

export { validateManifest, validateParts };
