/**
 * 大工具结果外置（P4）
 *
 * 10 KB 上限存在的理由是上下文预算，不是「结果不重要」。以前超过上限只能给模型
 * 半截 `preview`，模型不知道被截了，会拿残缺数据继续推理。现在的做法：
 *
 * - 超限时把**完整结果**写到 `userData/agent-results/<sha256 前 16 位>.json`，
 *   回执里给 `resultId` + `hint`，模型据此调 `get_tool_result` 分批读回来；
 * - id 取内容哈希：同一份结果重跑只落一份文件，不会堆一堆重复；
 * - 不超限的结果**不落盘**（每个小结果都写文件既费 IO 也没有读者）。
 *
 * 三条安全约束：
 * - `resultId` 必须严格匹配 `^[a-f0-9]{16}$`；读路径 `join(dir, id + '.json')`
 *   之后再 `realpath` 比前缀，符号链接指向目录外一律当「不存在」；
 * - 磁盘占用有上限：最近 50 个文件且总量 ≤ 32 MB，超了从最旧删（写入/启动时清理）；
 * - 审计只记 `resultId` 与字节数，**不记内容**（机型参数属于现场数据）。
 *
 * 分片口径：`read` 按 UTF-8 字符边界切，偏移落在半个汉字上就回退到该字符起点
 * （宁可重叠几个字节，也不丢字节、不产生 U+FFFD）。`nextOffset` 永远落在字符
 * 边界上，分批读完拼起来与原文逐字节相等。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { join, sep } from 'node:path';

/** userData 下的目录名；IPC 与命令层都从这里取，避免两处写死字符串。 */
export const RESULT_DIR_NAME = 'agent-results';
/** resultId 的唯一合法形状：内容 sha256 的前 16 位小写十六进制。 */
export const RESULT_ID_PATTERN = /^[a-f0-9]{16}$/;
export const RESULT_MAX_FILES = 50;
export const RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const RESULT_PAGE_DEFAULT = 10 * 1024;
export const RESULT_PAGE_MAX = 16384;

const RESULT_FILE_PATTERN = /^[a-f0-9]{16}\.json$/;

export type ToolResultErrorCode = 'RESULT_NOT_FOUND' | 'RESULT_RANGE' | 'RESULT_STORE_UNAVAILABLE';

/** 取回失败：`code` 直接进工具回执，`hint` 告诉模型下一步怎么改。 */
export class ToolResultError extends Error {
  readonly code: ToolResultErrorCode;
  readonly hint: string | undefined;

  constructor(code: ToolResultErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolResultError';
    this.code = code;
    this.hint = hint;
  }
}

export interface SavedToolResult {
  resultId: string;
  /** 完整结果的 UTF-8 字节数。 */
  bytes: number;
}

export interface ToolResultPage {
  resultId: string;
  /** 文件总字节数。 */
  bytes: number;
  /** 本次实际起点（落在字符边界上，可能比请求的 offset 小 1–3 字节）。 */
  offset: number;
  /** 本次生效的分片上限（≤ RESULT_PAGE_MAX）。 */
  limit: number;
  content: string;
  eof: boolean;
  /** 下一片的起点（字符边界）；`eof=true` 时没有该字段。 */
  nextOffset?: number;
}

export interface ToolResultStoreOptions {
  /** 绝对目录：`<userData>/agent-results`。 */
  dir: string;
  maxFiles?: number;
  maxBytes?: number;
}

/** 内容 sha256 前 16 位；同一份结果永远同一个 id。 */
export function resultIdFor(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** `<userData>/agent-results`；非绝对路径原样拼，由调用方保证 userData 是绝对路径。 */
export function resultStoreDir(userDataRoot: string): string {
  return join(userDataRoot, RESULT_DIR_NAME);
}

/**
 * 把 `offset` 回退到所在 UTF-8 字符的起始字节。
 * 调用方手填的偏移（例如照抄 hint 里的 `offset=10240`）可能正好落在汉字中间。
 */
function alignToCharStart(buffer: Buffer, offset: number): number {
  let start = offset;
  while (start > 0 && start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start -= 1;
  return start;
}

/** 从 `offset` 起最多 `limit` 字节，且终点落在字符边界上（0b10xxxxxx 是续字节）。 */
function pageEnd(buffer: Buffer, offset: number, limit: number): number {
  let end = Math.min(buffer.length, offset + limit);
  while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  if (end === offset && end < buffer.length) {
    // limit 小于单个字符的字节数：宁可超一个字符，也不能让 nextOffset 原地卡死。
    end = offset + 1;
    while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end += 1;
  }
  return end;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

export class ToolResultStore {
  readonly dir: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(options: ToolResultStoreOptions) {
    this.dir = options.dir;
    this.maxFiles = positiveInt(options.maxFiles ?? RESULT_MAX_FILES, RESULT_MAX_FILES);
    this.maxBytes = positiveInt(options.maxBytes ?? RESULT_MAX_BYTES, RESULT_MAX_BYTES);
  }

  /** 落盘完整结果并返回 id；同内容已存在时只刷新 mtime（避免被当成最旧清掉）。 */
  save(text: string): SavedToolResult {
    const resultId = resultIdFor(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${resultId}.json`);
    if (existsSync(path)) {
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {
        // 刷 mtime 失败只影响 LRU 顺序，不影响读取。
      }
    } else {
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
    }
    this.prune(path);
    return { resultId, bytes };
  }

  /**
   * 按字节偏移取回一片；`content` 一定落在 UTF-8 字符边界上。
   * 非法 id / 不存在 → RESULT_NOT_FOUND；offset 越界 → RESULT_RANGE。
   */
  read(request: { resultId: string; offset?: number; limit?: number }): ToolResultPage {
    const resultId = (request.resultId ?? '').trim();
    if (!RESULT_ID_PATTERN.test(resultId)) {
      throw new ToolResultError(
        'RESULT_NOT_FOUND',
        `resultId 不合法：${resultId || '（空）'}`,
        'resultId 取截断回执里的 16 位小写十六进制，原样传入即可'
      );
    }
    const path = this.resolve(resultId);
    if (!path) {
      throw new ToolResultError(
        'RESULT_NOT_FOUND',
        `找不到结果 ${resultId}（可能已被清理）`,
        '只有最近 50 个 / 32 MB 内的结果保留；重新执行原工具即可再生成一份'
      );
    }
    const buffer = readFileSync(path);
    const bytes = buffer.length;
    const requested = typeof request.offset === 'number' && Number.isFinite(request.offset)
      ? Math.trunc(request.offset)
      : 0;
    if (requested < 0 || requested > bytes) {
      throw new ToolResultError(
        'RESULT_RANGE',
        `offset ${requested} 超出范围（0–${bytes}）`,
        `offset 取 0–${bytes}；分批读请从回执的 nextOffset 续读`
      );
    }
    const limit = Math.min(RESULT_PAGE_MAX, positiveInt(request.limit ?? RESULT_PAGE_DEFAULT, RESULT_PAGE_DEFAULT));
    const offset = alignToCharStart(buffer, requested);
    const end = pageEnd(buffer, offset, limit);
    const content = buffer.toString('utf8', offset, end);
    const eof = end >= bytes;
    return {
      resultId,
      bytes,
      offset,
      limit,
      content,
      eof,
      ...(eof ? {} : { nextOffset: end })
    };
  }

  /**
   * 清理到「最近 maxFiles 个且 ≤ maxBytes」；写盘后与启动时各调一次。
   * `keep` 是刚写完的那一份：同一毫秒内连写多份时 mtime 分不出先后，
   * 必须显式钉住「刚写的不能被自己删掉」。
   */
  prune(keep?: string): { removed: number; kept: number; bytes: number } {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { removed: 0, kept: 0, bytes: 0 };
    }
    const files = names
      .filter((name) => RESULT_FILE_PATTERN.test(name))
      .map((name) => {
        const path = join(this.dir, name);
        try {
          const info = statSync(path);
          return { path, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; size: number; mtimeMs: number } => entry !== null)
      .sort((left, right) => {
        if (keep) {
          if (left.path === keep) return -1;
          if (right.path === keep) return 1;
        }
        return right.mtimeMs - left.mtimeMs;
      });
    let kept = 0;
    let total = 0;
    let removed = 0;
    for (const file of files) {
      const overCount = kept >= this.maxFiles;
      // 最新的一份即使自己就超过总量上限也留着，否则会出现「刚写完就被删」。
      const overBytes = kept > 0 && total + file.size > this.maxBytes;
      if (overCount || overBytes) {
        try {
          unlinkSync(file.path);
          removed += 1;
        } catch {
          // 删不掉就留着；下一轮再试，绝不让清理失败打断工具调用。
        }
        continue;
      }
      kept += 1;
      total += file.size;
    }
    return { removed, kept, bytes: total };
  }

  /** 当前占用（诊断/测试用）。 */
  stats(): { files: number; bytes: number } {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { files: 0, bytes: 0 };
    }
    let files = 0;
    let bytes = 0;
    for (const name of names) {
      if (!RESULT_FILE_PATTERN.test(name)) continue;
      try {
        bytes += statSync(join(this.dir, name)).size;
        files += 1;
      } catch {
        // 并发删除导致的 stat 失败忽略。
      }
    }
    return { files, bytes };
  }

  /** id → 真实文件路径；前缀校验失败（含符号链接逃逸）一律返回 null。 */
  private resolve(resultId: string): string | null {
    const candidate = join(this.dir, `${resultId}.json`);
    if (!existsSync(candidate)) return null;
    let real: string;
    let root: string;
    try {
      real = realpathSync(candidate);
      root = realpathSync(this.dir);
    } catch {
      return null;
    }
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return real.startsWith(prefix) ? real : null;
  }
}
