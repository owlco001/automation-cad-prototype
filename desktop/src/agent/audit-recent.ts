/**
 * 失败自查：把落盘的审计读成「我最近做过什么、错在哪」（只读工具 `get_recent_audit`）。
 *
 * 智能体能 validate / repair / capture_view / 记项目记忆，但看不到自己上一次为什么失败，
 * 于是会反复撞同一个错（例如再跑一遍 `run_plc_generate` 又撞 `ESTOP_UNDEFINED`）。
 * 这里把审计行压成模型能直接读的最小形状：
 *
 * - 只留 `{ts, tool, code, ms, verified?, args}`，**不返回**工具返回值内容；
 * - `args` 只保留 `memory.ts` 那份白名单字段，其余（apiKey/token/绝对路径…）直接丢弃；
 * - 白名单字段的值再过一遍 `scrubAuditText`：`sk-` / `Bearer` / 盘符与 POSIX 绝对路径 → `[已隐去]`。
 *
 * 纯函数，不碰文件系统：读文件由 `commands.ts` 调 `audit-store.readAuditEntries` 完成。
 */

import { KEY_ARGUMENTS } from './memory.ts';
import type { AgentAuditEntry } from './audit.ts';

export const RECENT_AUDIT_DEFAULTS = Object.freeze({
  limit: 10,
  maxLimit: 50,
  sinceMinutes: 1440,
  maxSinceMinutes: 10080
});

const REDACTED = '[已隐去]';

/** `sk-live-…`、`Bearer xxx`、`apiKey=…`、`X-Design-Key: …` 一律抹掉。 */
function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /((?:api[-_]?key|token|password|passwd|secret|authorization|design[-_]?key)\s*[=:]\s*)[^\s"',;}]+/gi,
      `$1${REDACTED}`
    );
}

/** Windows 盘符、UNC、POSIX 绝对路径。只匹配「像路径」的串，别把 `a/b` 这种相对路径也吃掉。 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z]:[\\/][^\s"',;]*/g,
  /\\\\[^\s"',;\\/]+\\[^\s"',;]*/g,
  /\/(?:root|home|Users|tmp|var|mnt|opt|etc|usr|srv|data|private|Volumes)\/[^\s"',;]*/g
];

/** 白名单字段的值也要再胞一遍：模型看到的是「[已隐去]」，不是密钥或本机绝对路径。 */
export function scrubAuditText(text: string): string {
  let output = scrubSecrets(text);
  for (const pattern of ABSOLUTE_PATH_PATTERNS) output = output.replace(pattern, REDACTED);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `args` 只留白名单字段；值只接受标量，字符串过 `scrubAuditText`。
 * 非白名单字段（apiKey/token/note/…）与对象/数组一律丢弃——宁可少一条线索，也不外泄。
 */
export function pickAuditArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const picked: Record<string, unknown> = {};
  for (const key of KEY_ARGUMENTS) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const text = scrubAuditText(value);
      if (text) picked[key] = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      picked[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      picked[key] = value;
      continue;
    }
    // 对象 / 数组：白名单里都是标量字段，出现复合值说明调用方塞了别的东西，丢掉。
  }
  return picked;
}

export interface RecentAuditQuery {
  limit: number;
  tool?: string;
  onlyFailed: boolean;
  sinceMinutes: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 缺省/越界一律夹到合法区间：limit 1–50（默认 10），sinceMinutes 1–10080（默认 1440）。 */
export function normalizeRecentAuditQuery(raw: unknown): RecentAuditQuery {
  const source = isRecord(raw) ? raw : {};
  const tool = typeof source.tool === 'string' ? source.tool.trim() : '';
  return {
    limit: clampInt(source.limit, RECENT_AUDIT_DEFAULTS.limit, 1, RECENT_AUDIT_DEFAULTS.maxLimit),
    ...(tool ? { tool } : {}),
    onlyFailed: source.onlyFailed === true,
    sinceMinutes: clampInt(
      source.sinceMinutes,
      RECENT_AUDIT_DEFAULTS.sinceMinutes,
      1,
      RECENT_AUDIT_DEFAULTS.maxSinceMinutes
    )
  };
}

export interface RecentAuditItem {
  ts: string;
  tool: string;
  /** `OK` 或稳定错误码（`ESTOP_UNDEFINED` / `PRECHECK_FAILED` …）。 */
  code: string;
  /** 耗时毫秒；旧记录没有该字段记 0。 */
  ms: number;
  /** 写操作自查结论；缺省表示不在自动验证范围。 */
  verified?: boolean;
  args: Record<string, unknown>;
}

export interface RecentAuditResult {
  items: RecentAuditItem[];
  /** 过滤后、截断前的总条数。 */
  total: number;
  truncated: boolean;
}

function entryTime(entry: AgentAuditEntry): number | null {
  const at = Date.parse(entry.at);
  return Number.isFinite(at) ? at : null;
}

/**
 * 过滤（时间窗 → 工具名精确 → 只看失败）→ 时间倒序 → 截到 limit。
 * 同一毫秒的多条按「后写的在前」，与界面「最新在最上」一致。
 */
export function buildRecentAudit(
  entries: readonly AgentAuditEntry[],
  query: RecentAuditQuery,
  now: Date = new Date()
): RecentAuditResult {
  const cutoff = now.getTime() - query.sinceMinutes * 60_000;
  const matched: Array<{ entry: AgentAuditEntry; at: number; index: number }> = [];
  entries.forEach((entry, index) => {
    if (typeof entry.tool !== 'string' || !entry.tool) return;
    if (query.tool && entry.tool !== query.tool) return;
    if (query.onlyFailed && entry.ok !== false) return;
    const at = entryTime(entry);
    // 时间戳损坏的记录读不出「是不是最近」，不计入（宁可少一条，也不把旧错当新错）。
    if (at === null || at < cutoff) return;
    matched.push({ entry, at, index });
  });
  matched.sort((left, right) => (right.at - left.at) || (right.index - left.index));
  const page = matched.slice(0, query.limit);
  return {
    items: page.map(({ entry }) => ({
      ts: entry.at,
      tool: entry.tool,
      code: scrubAuditText(entry.code ?? (entry.ok ? 'OK' : 'ERROR')),
      ms: typeof entry.elapsedMs === 'number' && Number.isFinite(entry.elapsedMs)
        ? Math.round(entry.elapsedMs)
        : 0,
      ...(typeof entry.verified === 'boolean' ? { verified: entry.verified } : {}),
      args: pickAuditArgs(entry.args)
    })),
    total: matched.length,
    truncated: matched.length > page.length
  };
}
