/**
 * 会话内工具记忆（P7-E）
 *
 * 只保留最近 5 次工具调用摘要（工具名、关键参数、结果码），滚动覆盖旧记录；
 * 仅存在于当前 `AgentSession` 内存中，不落盘、不上传、不进入审计之外的任何通道。
 */

export const TOOL_MEMORY_LIMIT = 5;

export interface ToolMemoryEntry {
  tool: string;
  /** 只包含白名单关键参数，避免把密钥/大对象带进提示。 */
  args: string;
  /** `OK` 或稳定错误码（如 `USER_DENIED` / `NO_RESULT`）。 */
  code: string;
}

/** 只保留白名单关键参数，避免把密钥/大对象带进提示。 */
export const KEY_ARGUMENTS = [
  'partId', 'ref', 'q', 'category', 'path', 'format',
  'model', 'qty', 'x', 'y', 'rotate', 'railSnap'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return '';
  const chars = [...text];
  return chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : text;
}

/** 抽取关键参数，按固定顺序拼接；没有关键参数时返回 `()`。 */
export function summarizeToolArguments(args: unknown): string {
  if (!isRecord(args)) return '';
  const parts: string[] = [];
  for (const key of KEY_ARGUMENTS) {
    if (!(key in args) || args[key] === undefined) continue;
    parts.push(`${key}=${compact(args[key])}`);
  }
  const text = parts.join(',');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function resultCode(result: unknown): string {
  if (!isRecord(result)) return 'UNKNOWN';
  if (result.ok === true) return 'OK';
  if (result.ok === false) {
    if (isRecord(result.error)) {
      const code = result.error.code;
      return typeof code === 'string' && code ? code : 'ERROR';
    }
    const code = result.code;
    return typeof code === 'string' && code ? code : 'ERROR';
  }
  return 'OK';
}

export function summarizeToolCall(tool: string, args: unknown, result: unknown): ToolMemoryEntry {
  return {
    tool: tool.trim() || 'unknown',
    args: summarizeToolArguments(args),
    code: resultCode(result)
  };
}

export class AgentMemory {
  private readonly limit: number;
  private items: ToolMemoryEntry[] = [];

  constructor(limit = TOOL_MEMORY_LIMIT) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  record(entry: ToolMemoryEntry): void {
    this.items.push({
      tool: entry.tool.trim() || 'unknown',
      args: entry.args,
      code: entry.code
    });
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  entries(): ToolMemoryEntry[] {
    return this.items.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.items = [];
  }

  /** 放在系统提示末尾；没有记录时返回空串。 */
  prompt(): string {
    if (this.items.length === 0) return '';
    const lines = ['[最近工具调用]'];
    for (const [index, entry] of this.items.entries()) {
      const args = entry.args ? `(${entry.args})` : '()';
      lines.push(`${index + 1}. ${entry.tool}${args} → ${entry.code}`);
    }
    return lines.join('\n');
  }
}

export function memoryPrompt(entries: readonly ToolMemoryEntry[]): string {
  const memory = new AgentMemory(Math.max(1, entries.length));
  for (const entry of entries) memory.record(entry);
  return memory.prompt();
}
