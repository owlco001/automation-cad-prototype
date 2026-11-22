// 渲染层的分块加载器：按需取一个可选模块的可执行分块。
//
// 职责边界（刻意做窄）：
// - 只接受清单里**已声明**的模块 id；id 决定文件名，调用方不能传路径。
// - 分块源码必须与清单 sha256 与字节数逐项一致，否则当作未安装。
// - 分块必须按约定自注册，且自注册的 id / API 版本要和清单一致。
// - 只从注入的 `readSource` 取内容：这个端口由主进程实现（本地文件），
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

export interface ChunkLoadDeps {
  /** 清单来源：主进程从安装目录读取，渲染层不猜路径。 */
  readManifest(): Promise<unknown>;
  /** 读取分块源码（本地文件内容），由主进程按清单文件名解析。 */
  readSource(entry: ModuleChunkEntry): Promise<string>;
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
    if (!entry) return { ok: false, code: 'CHUNK_NOT_DECLARED', message: `该模块没有随包分块：${id}` };
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
    const validated = validateRegistration(payload, { id, moduleApiVersion: manifest.moduleApiVersion });
    if (!validated.ok) {
      return { ok: false, code: 'CHUNK_REGISTRATION_INVALID', message: validated.message };
    }
    this.loaded.set(id, validated.registration.exports);
    return { ok: true, id, exports: validated.registration.exports };
  }
}
