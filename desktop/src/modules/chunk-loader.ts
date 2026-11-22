// 渲染层的分块加载器：按需取一个可选模块的可执行分块。
//
// 来源分两级，顺序固定：
//   1. 随包清单（readManifest）里**已声明**的 id：优先，只走 readSource；
//   2. 随包清单里没有该 id 时，才查询已安装签名包端口 readInstalledSource。
// 已安装来源不会被写进随包 manifest，也不会伪造清单条目：它只作为一次性的
// 「源码 + 期望字节数/sha256/API 区间」输入，仍要过与随包分块完全相同的校验。
//
// 其余职责边界不变：
// - 只接受清单里已声明的模块 id，或已安装端口明确返回的来源；id 决定文件名，调用方不能传路径。
// - 分块源码必须与来源声明的 sha256 与字节数逐项一致，否则当作未安装。
// - 分块必须按约定自注册，且自注册的 id / API 版本要和宿主清单一致。
// - 只从注入的端口取内容：这个端口由主进程实现（本地文件或已安装包），
//   加载器自己不发任何网络请求，也不读环境变量决定来源。
// - 同一 id 只加载一次（单飞 + 缓存）；失败不缓存，下一次可重试。
//
// 关闭模块、依赖未启用、API 不兼容都在**执行代码之前**拒绝，避免先跑副作用再报错。

import {
  apiCompatible,
  findChunk,
  validateManifest,
  validateRegistration,
  type ModuleChunkEntry,
  type ModuleChunkManifest
} from './chunk-manifest.ts';

/**
 * 已安装签名包里的分块来源（主进程 `modules:installed-chunk` 的返回形状）。
 *
 * 刻意不含路径、版本或包清单：渲染层只需要可执行源码与三项校验信息。
 * `bytes` / `sha256` / `apiCompatibility` 来自已安装包的签名清单；加载器仍会自己
 * 重新编码源码并复核，不能靠端口自称「已校验」。
 */
export interface InstalledChunkSource {
  source: string;
  sha256: string;
  bytes: number;
  apiCompatibility: { min: number; max: number };
}

export interface ChunkLoadDeps {
  /** 清单来源：主进程从安装目录读取，渲染层不猜路径。 */
  readManifest(): Promise<unknown>;
  /** 读取分块源码（本地文件内容），由主进程按清单文件名解析。 */
  readSource(entry: ModuleChunkEntry): Promise<string>;
  /**
   * 可选：已安装签名包的分块来源（主进程 IPC 端口）。
   * 只在随包清单**没有**声明该 id 时调用；返回 null 表示未安装。
   * 端口抛错表示传输/读取失败，会映射为 CHUNK_UNAVAILABLE；返回的内容仍要过
   * 字节数 + sha256 + API 区间校验，不能绕过本加载器的完整性检查。
   */
  readInstalledSource?(id: string): Promise<InstalledChunkSource | null>;
  /** 校验并执行源码；实现方负责把注册回调接上（见 register 约定）。 */
  install(source: string, onRegister: (payload: unknown) => void): void;
  /** sha256 十六进制小写。 */
  sha256(text: string): Promise<string>;
  /** 宿主模块 API 版本，用于兼容区间检查。 */
  hostApiVersion: number;
  /** 模块是否已启用；传 null 表示模块不存在。 */
  moduleState(id: string): { enabled: boolean; dependencies: readonly string[] } | null;
  /** 依赖模块当前是否启用。 */
  isEnabled(id: string): boolean;
}

export interface ChunkLoadFailure {
  ok: false;
  code:
    | 'CHUNK_MANIFEST_UNAVAILABLE'
    | 'CHUNK_NOT_DECLARED'
    | 'MODULE_UNKNOWN'
    | 'MODULE_DISABLED'
    | 'MODULE_API_INCOMPATIBLE'
    | 'DEPENDENCY_DISABLED'
    | 'CHUNK_UNAVAILABLE'
    | 'CHUNK_SIZE_MISMATCH'
    | 'CHUNK_HASH_MISMATCH'
    | 'CHUNK_REGISTRATION_INVALID'
    | 'CHUNK_INSTALL_FAILED';
  message: string;
}

export type ChunkLoadResult = { ok: true; id: string; exports: unknown } | ChunkLoadFailure;

/** 已安装来源的 API 区间校验；与 chunk-manifest 的 apiCompatible 同义，但不要求 file/bytes。 */
function isCompatibleRange(range: { min: number; max: number }, hostApiVersion: number): boolean {
  return (
    Number.isSafeInteger(range.min) &&
    Number.isSafeInteger(range.max) &&
    range.min >= 1 &&
    range.max >= range.min &&
    hostApiVersion >= range.min &&
    hostApiVersion <= range.max
  );
}

export class ModuleChunkLoader {
  private readonly deps: ChunkLoadDeps;
  private readonly loaded = new Map<string, unknown>();
  private readonly inflight = new Map<string, Promise<ChunkLoadResult>>();

  constructor(deps: ChunkLoadDeps) {
    this.deps = deps;
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  loadedIds(): string[] {
    return [...this.loaded.keys()].sort();
  }

  /** 已加载分块的 exports；未加载返回 undefined（调用方应先 load）。 */
  exportsOf(id: string): unknown {
    return this.loaded.get(id);
  }

  async load(id: string): Promise<ChunkLoadResult> {
    if (this.loaded.has(id)) return { ok: true, id, exports: this.loaded.get(id) };
    const existing = this.inflight.get(id);
    if (existing) return await existing;
    const task = this.loadOnce(id);
    this.inflight.set(id, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async loadOnce(id: string): Promise<ChunkLoadResult> {
    const state = this.deps.moduleState(id);
    if (!state) return { ok: false, code: 'MODULE_UNKNOWN', message: `未知模块：${id}` };
    if (!state.enabled) return { ok: false, code: 'MODULE_DISABLED', message: `模块已关闭：${id}` };
    const missing = state.dependencies.filter((dependency) => !this.deps.isEnabled(dependency));
    if (missing.length > 0) {
      return { ok: false, code: 'DEPENDENCY_DISABLED', message: `依赖模块未启用：${missing.join('、')}` };
    }

    let manifest: ModuleChunkManifest;
    try {
      const parsed = validateManifest(await this.deps.readManifest());
      if (!parsed.ok) {
        return { ok: false, code: 'CHUNK_MANIFEST_UNAVAILABLE', message: `分块清单不可用：${parsed.message}` };
      }
      manifest = parsed.manifest;
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_MANIFEST_UNAVAILABLE',
        message: `分块清单不可用：${error instanceof Error ? error.message : String(error)}`
      };
    }

    const entry = findChunk(manifest, id);
    // 随包清单优先：只要清单声明了该 id，无论它之后能否加载，都不再查已安装包，
    // 避免「随包版本坏了就偷偷执行另一个版本」。只有清单完全没有该 id 时才走已安装来源。
    if (entry) return await this.loadBundled(id, entry, manifest.moduleApiVersion);
    return await this.loadInstalled(id, manifest.moduleApiVersion);
  }

  private async loadBundled(
    id: string,
    entry: ModuleChunkEntry,
    moduleApiVersion: number
  ): Promise<ChunkLoadResult> {
    if (!apiCompatible(entry, this.deps.hostApiVersion)) {
      return {
        ok: false,
        code: 'MODULE_API_INCOMPATIBLE',
        message: `分块 API 区间 ${entry.apiCompatibility.min}-${entry.apiCompatibility.max} 不含宿主 ${this.deps.hostApiVersion}`
      };
    }

    let source: string;
    try {
      source = await this.deps.readSource(entry);
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_UNAVAILABLE',
        message: `分块文件不可读：${error instanceof Error ? error.message : String(error)}`
      };
    }
    const bytes = new TextEncoder().encode(source).length;
    if (bytes !== entry.bytes) {
      return { ok: false, code: 'CHUNK_SIZE_MISMATCH', message: `分块字节数不符：${bytes} ≠ ${entry.bytes}` };
    }
    const digest = await this.deps.sha256(source);
    if (digest !== entry.sha256) {
      return { ok: false, code: 'CHUNK_HASH_MISMATCH', message: '分块内容与清单哈希不符，已拒绝执行' };
    }
    return await this.installAndRegister(id, moduleApiVersion, source);
  }

  /**
   * 已安装签名包来源。返回值不进入随包 manifest，只在本函数内做校验后直接执行。
   *
   * 自注册的 API 版本仍按随包清单的 `moduleApiVersion` 校验：那是宿主当前能执行的
   * 模块 API 版本；包的 `apiCompatibility` 是另一个维度（哪些宿主版本可以安装/加载）。
   */
  private async loadInstalled(id: string, moduleApiVersion: number): Promise<ChunkLoadResult> {
    const read = this.deps.readInstalledSource;
    if (!read) {
      return { ok: false, code: 'CHUNK_NOT_DECLARED', message: `该模块没有随包分块：${id}` };
    }

    let installed: InstalledChunkSource | null;
    try {
      // 与其他端口一样以 deps 为接收者调用，避免实现方依赖 this 时行为不一致。
      installed = await read.call(this.deps, id);
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_UNAVAILABLE',
        message: `已安装分块不可读：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (!installed) {
      return {
        ok: false,
        code: 'CHUNK_NOT_DECLARED',
        message: `该模块既没有随包分块，也没有已安装签名包：${id}`
      };
    }

    const compatibility = installed.apiCompatibility;
    // 端口返回的形状也不盲信：缺少区间按「不兼容」处理，而不是抛异常绕过失败码。
    if (typeof compatibility !== 'object' || compatibility === null) {
      return {
        ok: false,
        code: 'MODULE_API_INCOMPATIBLE',
        message: '已安装分块缺少合法的 API 兼容区间'
      };
    }
    if (!isCompatibleRange(compatibility, this.deps.hostApiVersion)) {
      return {
        ok: false,
        code: 'MODULE_API_INCOMPATIBLE',
        message: `已安装分块 API 区间 ${compatibility.min}-${compatibility.max} 不含宿主 ${this.deps.hostApiVersion}`
      };
    }
    const bytes = new TextEncoder().encode(installed.source).length;
    if (!Number.isSafeInteger(installed.bytes) || bytes !== installed.bytes) {
      return {
        ok: false,
        code: 'CHUNK_SIZE_MISMATCH',
        message: `已安装分块字节数不符：${bytes} ≠ ${installed.bytes}`
      };
    }
    const digest = await this.deps.sha256(installed.source);
    if (digest !== installed.sha256) {
      return {
        ok: false,
        code: 'CHUNK_HASH_MISMATCH',
        message: '已安装分块内容与签名清单哈希不符，已拒绝执行'
      };
    }
    return await this.installAndRegister(id, moduleApiVersion, installed.source);
  }

  /** 执行已通过字节数 + sha256 校验的源码，并核对自注册身份；成功才写入缓存。 */
  private async installAndRegister(
    id: string,
    moduleApiVersion: number,
    source: string
  ): Promise<ChunkLoadResult> {
    let payload: unknown;
    let registered = false;
    try {
      this.deps.install(source, (value) => {
        if (registered) return;
        registered = true;
        payload = value;
      });
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_INSTALL_FAILED',
        message: `分块执行失败：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (!registered) {
      return { ok: false, code: 'CHUNK_REGISTRATION_INVALID', message: '分块没有自注册（可能版本不匹配）' };
    }
    const validated = validateRegistration(payload, { id, moduleApiVersion });
    if (!validated.ok) {
      return { ok: false, code: 'CHUNK_REGISTRATION_INVALID', message: validated.message };
    }
    this.loaded.set(id, validated.registration.exports);
    return { ok: true, id, exports: validated.registration.exports };
  }
}
