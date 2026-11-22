// 主进程侧的分块读取与校验。
//
// 渲染层是 sandbox + contextIsolation，不能自己读文件；分块必须由主进程按**清单白名单**
// 读出来、按字节校验后再交给渲染层执行。这里刻意不接收调用方给的路径：
// 只接受模块 id，文件名从清单里取，且再做一次目录包含检查。
//
// 目前只在主进程内部可用（尚未通过 IPC 暴露给渲染层），所以这条链路还没有新增
// 渲染层攻击面；接线是下一步，需连同 preload 白名单与权限一起评审。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  findChunk,
  validateManifest,
  type ModuleChunkEntry,
  type ModuleChunkManifest
} from '../src/modules/chunk-manifest.ts';

export interface ModuleChunkReaderOptions {
  /** 分块目录（打包态在 resources 下，开发态是 dist/modules）。 */
  rootDir: string;
  readText?: (path: string) => string;
  exists?: (path: string) => boolean;
}

export type ChunkReadFailure = {
  ok: false;
  code: 'CHUNK_MANIFEST_UNAVAILABLE' | 'CHUNK_NOT_DECLARED' | 'CHUNK_UNAVAILABLE' | 'CHUNK_SIZE_MISMATCH' | 'CHUNK_HASH_MISMATCH';
  message: string;
};

export type ChunkReadResult = { ok: true; entry: ModuleChunkEntry; source: string } | ChunkReadFailure;

export class ModuleChunkReader {
  private readonly rootDir: string;
  private readonly readText: (path: string) => string;
  private readonly exists: (path: string) => boolean;
  private cached: ModuleChunkManifest | null = null;

  constructor(options: ModuleChunkReaderOptions) {
    this.rootDir = resolve(options.rootDir);
    this.readText = options.readText ?? ((path) => readFileSync(path, 'utf8'));
    this.exists = options.exists ?? ((path) => existsSync(path));
  }

  get manifestPath(): string {
    return join(this.rootDir, 'manifest.json');
  }

  /** 读取并校验清单。**不缓存失败**：分块目录可能在更新过程中补齐。 */
  manifest(): { ok: true; manifest: ModuleChunkManifest } | ChunkReadFailure {
    if (this.cached) return { ok: true, manifest: this.cached };
    if (!this.exists(this.manifestPath)) {
      return { ok: false, code: 'CHUNK_MANIFEST_UNAVAILABLE', message: `分块清单不存在：${this.manifestPath}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.readText(this.manifestPath));
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_MANIFEST_UNAVAILABLE',
        message: `分块清单不可读：${error instanceof Error ? error.message : String(error)}`
      };
    }
    const validated = validateManifest(parsed);
    if (!validated.ok) return { ok: false, code: 'CHUNK_MANIFEST_UNAVAILABLE', message: `分块清单非法：${validated.message}` };
    this.cached = validated.manifest;
    return { ok: true, manifest: validated.manifest };
  }

  /** 按 id 读取并逐字节校验分块源码。 */
  read(id: string): ChunkReadResult {
    const manifest = this.manifest();
    if (!manifest.ok) return manifest;
    const entry = findChunk(manifest.manifest, id);
    if (!entry) return { ok: false, code: 'CHUNK_NOT_DECLARED', message: `该模块没有随包分块：${id}` };
    // 清单里的 file 已限定为纯文件名；这里再确认解析结果确实落在分块目录内。
    const path = resolve(this.rootDir, entry.file);
    if (path !== join(this.rootDir, entry.file)) {
      return { ok: false, code: 'CHUNK_UNAVAILABLE', message: `分块路径越界：${entry.file}` };
    }
    if (!this.exists(path)) return { ok: false, code: 'CHUNK_UNAVAILABLE', message: `分块文件缺失：${entry.file}` };
    let source: string;
    try {
      source = this.readText(path);
    } catch (error) {
      return {
        ok: false,
        code: 'CHUNK_UNAVAILABLE',
        message: `分块文件不可读：${error instanceof Error ? error.message : String(error)}`
      };
    }
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes !== entry.bytes) {
      return { ok: false, code: 'CHUNK_SIZE_MISMATCH', message: `分块字节数不符：${bytes} ≠ ${entry.bytes}` };
    }
    const digest = createHash('sha256').update(source, 'utf8').digest('hex');
    if (digest !== entry.sha256) {
      return { ok: false, code: 'CHUNK_HASH_MISMATCH', message: '分块内容与清单哈希不符，已拒绝交付' };
    }
    return { ok: true, entry, source };
  }
}
