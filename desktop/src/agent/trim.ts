/**
 * 工具结果裁剪（P7-E）+ 列表结果统一形状（G2）
 *
 * 三条硬约束：
 * - 列表 > 20 条：**条目一条不删**，只把条目内的长字符串按 2 KB 截断，并补
 *   `total` 与 `truncated:true`（此前按条数切前 20，导致 25 行 BOM 的消费方
 *   拿到 `{items,total,truncated}` 却按数组读 → 静默变成空数组，BOM 面板空白）；
 * - 长文本 > 2 KB：按 UTF-8 码点边界截断并附中文提示；
 * - 单个工具结果默认 ≤ 10 KB；`design_machine` 例外（64 KB），因为方案卡与
 *   「应用到工程」需要完整 config/BOM，截断后无法解析或落盘。
 *
 * 列表型工具的结果统一为 `ListResult<T> = { items, total, truncated? }`，小列表
 * 也照样返回该形状（不做「少于 20 就裸数组」的双形状）。老字段名（`rows`/`components`/
 * `hits`）作为镜像字段保留一代，消费方应改读 `items`。
 */

import { byteLength, truncateUtf8 } from './context.ts';

export const LIST_RESULT_LIMIT = 20;
export const LONG_TEXT_BYTE_LIMIT = 2048;
export const TOOL_RESULT_BYTE_LIMIT = 10 * 1024;
export const DESIGN_TOOL_RESULT_BYTE_LIMIT = 64 * 1024;

/** 工具结果上限：design_machine 需要完整方案，其余沿用 10 KB 默认值。 */
export function toolResultByteLimit(toolName?: string): number {
  return toolName === 'design_machine' ? DESIGN_TOOL_RESULT_BYTE_LIMIT : TOOL_RESULT_BYTE_LIMIT;
}

const LIST_KEYS = new Set([
  'items', 'rows', 'components', 'parts', 'files', 'results',
  'placements', 'candidates', 'warnings', 'lines', 'entries', 'tools'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface TrimmedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/**
 * 列表型工具的统一返回形状。
 *
 * 语义（容易被误读，写清楚）：
 * - `items` 永远是**全量条目**，裁剪不会删条目（删条目就是「25 行 BOM 变空数组」那类 bug 的源头）；
 * - `total` 是条目总数，正常情况下等于 `items.length`；
 * - `truncated` 为 true 表示列表超过 `LIST_RESULT_LIMIT`，条目内的长字符串已按 2 KB 截断，
 *   上层可以据此提示「结果很大，建议缩小范围」，但不能据此认为条目丢了。
 */
export interface ListResult<T> {
  items: T[];
  total: number;
  truncated?: boolean;
}

/** 把任意条目数组包成统一形状；小列表也是同一形状（不再返回裸数组）。 */
export function listResult<T>(items: readonly T[], limit = LIST_RESULT_LIMIT): ListResult<T> {
  const safeLimit = Math.max(0, Math.trunc(limit));
  return {
    items: items.slice(),
    total: items.length,
    truncated: items.length > safeLimit
  };
}

/**
 * 宽容读取列表结果：新形状 `{items,total}` → 裸数组（旧形状） → `mirrors` 里的镜像字段。
 * 都读不出来返回 null —— 调用方**不能**把 null 静默当空数组，必须报错或回落到镜像字段
 * （否则「形状变了」和「真的空」就永远分不清）。
 */
export function readListResult<T>(
  value: unknown,
  mirrors: readonly string[] = []
): ListResult<T> | null {
  if (Array.isArray(value)) return listResult(value as T[]);
  if (!isRecord(value)) return null;
  if (Array.isArray(value.items)) {
    const items = value.items as T[];
    const declared = typeof value.total === 'number' && Number.isFinite(value.total)
      ? Math.max(items.length, Math.trunc(value.total))
      : items.length;
    return { items, total: declared, truncated: value.truncated === true };
  }
  for (const key of mirrors) {
    const mirror = value[key];
    if (Array.isArray(mirror)) return listResult(mirror as T[]);
  }
  return null;
}

/** 读字符串列表（裁剪后的 {items,total} 或裸数组都认）；读不出来返回空数组，调用方自行决定是否提示。 */
export function readStringList(value: unknown): string[] {
  const items = readListResult<unknown>(value)?.items ?? [];
  return items.filter((item): item is string => typeof item === 'string');
}

function describeShape(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    return `object(keys=${Object.keys(value as Record<string, unknown>).slice(0, 6).join(',') || '空'})`;
  }
  return typeof value;
}

/**
 * 严格读取列表条目：形状不认识就抛错并带上实际形状，绝不退化成空数组。
 * 只读展示层（面板/侧栏）请用 `readListResult` 并显式处理 null。
 */
export function requireListItems<T>(
  value: unknown,
  mirrors: readonly string[] = [],
  label = '列表'
): T[] {
  const list = readListResult<T>(value, mirrors);
  if (!list) {
    throw new Error(
      `${label}结果形状不合法：期望 {items,total}、数组或 ${mirrors.length > 0 ? mirrors.join('/') : '镜像字段'}，实际 ${describeShape(value)}`
    );
  }
  return list.items;
}

/** 列表裁剪：条目一条不删，只标记 total/truncated；字符串内容由 trimValue 逐条截断。 */
export function trimListResult<T>(items: readonly T[], limit = LIST_RESULT_LIMIT): TrimmedList<T> {
  const result = listResult(items, limit);
  return { items: result.items, total: result.total, truncated: result.truncated === true };
}

export interface TrimmedText {
  text: string;
  originalBytes: number;
  truncated: boolean;
}

/** 长文本截断；提示语也计入 2 KB 预算，保证最终字节数不超限。 */
export function trimLongText(text: string, limit = LONG_TEXT_BYTE_LIMIT): TrimmedText {
  const originalBytes = byteLength(text);
  if (originalBytes <= limit) {
    return { text, originalBytes, truncated: false };
  }
  const note = `\n…（已截断，原文 ${originalBytes} 字节）`;
  const noteBytes = byteLength(note);
  const budget = Math.max(0, Math.trunc(limit) - noteBytes);
  return {
    text: `${truncateUtf8(text, budget, '')}${note}`,
    originalBytes,
    truncated: true
  };
}

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return trimLongText(value).text;
  if (Array.isArray(value)) {
    // 列表一律返回统一形状：条目一条不删，只截断条目内的长字符串。
    return { ...listResult(value.map(trimValue)) };
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && (LIST_KEYS.has(key) || key === 'data')) {
      // 列表型字段：不论条数一律统一形状（小列表也照样 {items,total}）。
      output[key] = listResult(entry.map(trimValue));
      continue;
    }
    if (Array.isArray(entry)) {
      // 非列表型数组（warnings/steps/坐标三元组…）保持数组语义；只有超长时
      // 才收敛成统一形状，且同样一条不删。
      output[key] = entry.length > LIST_RESULT_LIMIT
        ? listResult(entry.map(trimValue))
        : entry.map(trimValue);
      continue;
    }
    output[key] = trimValue(entry);
  }

  // 已经是统一形状的记录：total/truncated 以原值为准（trimValue 递归后 items 仍是全量）。
  if (Array.isArray(value.items)) {
    const items = output.items as unknown;
    const list = Array.isArray(items) ? items : (items as ListResult<unknown>).items;
    const declared = typeof value.total === 'number' && Number.isFinite(value.total)
      ? Math.max(list.length, Math.trunc(value.total))
      : list.length;
    output.items = list;
    output.total = declared;
    output.truncated = value.truncated === true || declared > LIST_RESULT_LIMIT;
    // 镜像字段（rows/components/hits…）与 items 是同一份数据时不再重复输出，
    // 否则 10 KB 预算会被同一份数据吃掉两遍。listResult 会复制数组、trimValue 又复制一遍
    // 条目，所以只能拿**原始** value.items 比对：同长度且首元素同一对象即视为同一份数据
    // （过滤/改写过就对不上，那就老实保留两份）。
    const originalItems = value.items as unknown[];
    const sameAsItems = (candidate: unknown): boolean =>
      Array.isArray(candidate) &&
      candidate.length === originalItems.length &&
      (candidate.length === 0 || candidate[0] === originalItems[0]);
    for (const key of LIST_KEYS) {
      if (key === 'items') continue;
      if (sameAsItems(value[key])) delete output[key];
    }
  }
  return output;
}

/** 结构化裁剪（不修改入参）。列表/长文本规则见模块头。 */
export function trimToolResult(value: unknown): unknown {
  if (Array.isArray(value)) return trimValue(value);
  return trimValue(value);
}

export interface SerializedToolResult {
  text: string;
  bytes: number;
  truncated: boolean;
  /** 超限且已外置时的内容 id（16 位 hex）；正常结果没有该字段。 */
  resultId?: string;
  /** 外置的完整结果字节数；与 `resultId` 同时出现。 */
  fullBytes?: number;
}

/** 一份外置结果的回执信息（由 store 返回）。 */
export interface OffloadedToolResult {
  resultId: string;
  bytes: number;
}

/**
 * 超限结果外置回调：`text` 是**完整**结果 JSON（未受 maxBytes 限制），
 * 返回 null 表示这次没外置（没有 userData 目录 / 写盘失败），回执退回纯 preview。
 */
export type ToolResultOffload = (text: string) => OffloadedToolResult | null;

/** 给模型的下一步指令：必须能照着直接调，不能只说「结果被截断了」。 */
function offloadHint(stored: OffloadedToolResult, previewBytes: number): string {
  const kb = (stored.bytes / 1024).toFixed(1);
  const nextOffset = Math.min(previewBytes, Math.max(0, stored.bytes - 1));
  return `完整结果 ${kb} KB（${stored.bytes} 字节），这里的 preview 只是前 ${previewBytes} 字节；`
    + `调 get_tool_result(resultId="${stored.resultId}", offset=${nextOffset}) 继续读，每次最多 16384 字节，eof=true 即读完`;
}

function fallbackText(
  value: unknown,
  text: string,
  maxBytes: number,
  stored: OffloadedToolResult | null
): string {
  const ok = isRecord(value) && typeof value.ok === 'boolean' ? value.ok : undefined;
  const note = stored
    ? '结果超过单次上限，已截断；完整内容已落盘，按 hint 里的 offset 分批回取即可。'
    : '结果超过 10 KB，已截断；请缩小查询范围或分页读取。';
  const base: Record<string, unknown> = {
    ...(ok === undefined ? {} : { ok }),
    truncated: true,
    note,
    ...(stored ? { resultId: stored.resultId, bytes: stored.bytes } : {})
  };
  const build = (preview: string): string => JSON.stringify({
    ...base,
    ...(stored ? { hint: offloadHint(stored, byteLength(preview)) } : {}),
    preview
  });
  let budget = Math.max(0, maxBytes - byteLength(build('')) - 2);
  for (;;) {
    const preview = truncateUtf8(text, budget, '');
    const candidate = build(preview);
    const excess = byteLength(candidate) - maxBytes;
    if (excess <= 0 || budget === 0) return candidate;
    budget = Math.max(0, budget - excess - 8);
  }
}

/**
 * 工具结果 → 模型上下文文本。先做列表/长文本裁剪，再保证 JSON ≤ 10 KB。
 * 超限时保留 `ok` 状态并给出 `preview`，不把半截 JSON 交给模型；
 * 传了 `offload` 就把**完整结果**外置，回执补 `resultId/bytes/hint` 供模型回取。
 */
export function serializeToolResult(
  value: unknown,
  maxBytes = TOOL_RESULT_BYTE_LIMIT,
  offload?: ToolResultOffload
): SerializedToolResult {
  const limit = Math.max(256, Math.trunc(maxBytes));
  let text: string;
  try {
    text = JSON.stringify(trimToolResult(value));
  } catch {
    text = JSON.stringify({ ok: false, code: 'RESULT_NOT_SERIALIZABLE', message: '工具结果无法序列化' });
  }
  if (typeof text !== 'string') text = JSON.stringify({ ok: false, code: 'RESULT_NOT_SERIALIZABLE', message: '工具结果无法序列化' });
  const bytes = byteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  let stored: OffloadedToolResult | null = null;
  if (offload) {
    try {
      stored = offload(text);
    } catch {
      // 外置失败不影响对话：退回纯 preview（至少模型知道被截断了）。
      stored = null;
    }
  }
  const fallback = fallbackText(value, text, limit, stored);
  return {
    text: fallback,
    bytes: byteLength(fallback),
    truncated: true,
    ...(stored ? { resultId: stored.resultId, fullBytes: stored.bytes } : {})
  };
}
