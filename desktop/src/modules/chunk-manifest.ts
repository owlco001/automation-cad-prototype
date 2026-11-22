// 模块代码分块：清单校验与完整性检查（纯函数，可在 Node 与渲染层共用）。
//
// 设计约束（与现有 Electron 架构对齐）：
// - 扩展宿主以**经典脚本**注入，渲染进程 sandbox + contextIsolation，因此分块不能靠
//   `import()` 拉远端 URL，只能是「本地文件 + 校验 + 注入」。
// - 清单随安装包一起发布，属于可信输入；分块文件必须逐字节校验 sha256，校验失败当作
//   未安装处理，绝不"先跑再说"。
// - 未知 id、路径穿越、未声明的分块一律拒绝：清单是白名单，不是提示。

export interface ModuleChunkEntry {
  id: string;
  apiCompatibility: { min: number; max: number };
  file: string;
  bytes: number;
  sha256: string;
}

export interface ModuleChunkManifest {
  schemaVersion: number;
  moduleApiVersion: number;
  chunks: ModuleChunkEntry[];
}

export const MODULE_CHUNK_SCHEMA_VERSION = 1;
/** 分块文件名只允许「字母数字 . _ -」，不接受任何路径分隔符。 */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验清单结构。任何一处不合法都整份拒绝：半可信的清单比没有清单更危险
 * （会让人以为某些分块"已经过校验"）。
 */
export function validateManifest(raw: unknown):
  { ok: true; manifest: ModuleChunkManifest } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: '分块清单必须是对象' };
  if (raw.schemaVersion !== MODULE_CHUNK_SCHEMA_VERSION) {
    return { ok: false, message: `不支持的分块清单版本：${String(raw.schemaVersion)}` };
  }
  if (!Number.isSafeInteger(raw.moduleApiVersion) || (raw.moduleApiVersion as number) < 1) {
    return { ok: false, message: 'moduleApiVersion 必须是正整数' };
  }
  if (!Array.isArray(raw.chunks)) return { ok: false, message: 'chunks 必须是数组' };
  const seen = new Set<string>();
  const chunks: ModuleChunkEntry[] = [];
  for (const item of raw.chunks) {
    if (!isRecord(item)) return { ok: false, message: '分块条目必须是对象' };
    const id = item.id;
    const file = item.file;
    const bytes = item.bytes;
    const sha256 = item.sha256;
    const compatibility = item.apiCompatibility;
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
      return { ok: false, message: '分块 id 非法' };
    }
    if (seen.has(id)) return { ok: false, message: `分块 id 重复：${id}` };
    seen.add(id);
    if (!isRecord(compatibility)) return { ok: false, message: `${id} 缺少 apiCompatibility` };
    const min = compatibility.min;
    const max = compatibility.max;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || (min as number) < 1 || (max as number) < (min as number)) {
      return { ok: false, message: `${id} 的 apiCompatibility 非法` };
    }
    if (typeof file !== 'string' || !SAFE_FILE.test(file)) {
      return { ok: false, message: `${id} 的 file 必须是纯文件名` };
    }
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 1) {
      return { ok: false, message: `${id} 的字节数非法` };
    }
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      return { ok: false, message: `${id} 的 sha256 必须是 64 位小写十六进制` };
    }
    chunks.push({
      id,
      apiCompatibility: { min: min as number, max: max as number },
      file,
      bytes: bytes as number,
      sha256
    });
  }
  return { ok: true, manifest: { schemaVersion: MODULE_CHUNK_SCHEMA_VERSION, moduleApiVersion: raw.moduleApiVersion as number, chunks } };
}

export function findChunk(manifest: ModuleChunkManifest, id: string): ModuleChunkEntry | undefined {
  return manifest.chunks.find((entry) => entry.id === id);
}

/** 宿主模块 API 是否落在分块的兼容区间内。 */
export function apiCompatible(entry: ModuleChunkEntry, hostApiVersion: number): boolean {
  return hostApiVersion >= entry.apiCompatibility.min && hostApiVersion <= entry.apiCompatibility.max;
}

/**
 * 分块自注册格式（构建产物必须严格照此生成）：
 *   window.__cadRegisterModuleChunk({ id, apiVersion, exports })
 * 校验的是「注册声明」与清单是否一致，而不是信任分块自称的身份。
 */
export interface ChunkRegistration {
  id: string;
  apiVersion: number;
  exports: unknown;
}

export function validateRegistration(payload: unknown, expected: { id: string; moduleApiVersion: number }):
  { ok: true; registration: ChunkRegistration } | { ok: false; message: string } {
  if (!isRecord(payload)) return { ok: false, message: '分块没有注册任何内容' };
  if (payload.id !== expected.id) {
    return { ok: false, message: `分块声称的 id 与清单不一致：${String(payload.id)} ≠ ${expected.id}` };
  }
  if (payload.apiVersion !== expected.moduleApiVersion) {
    return { ok: false, message: `分块 API 版本与清单不一致：${String(payload.apiVersion)} ≠ ${expected.moduleApiVersion}` };
  }
  if (!('exports' in payload)) return { ok: false, message: '分块注册缺少 exports' };
  return { ok: true, registration: { id: expected.id, apiVersion: expected.moduleApiVersion, exports: payload.exports } };
}
