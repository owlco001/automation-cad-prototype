/**
 * 「可选 JSON 文件」读取：首启不存在的文件是正常路径，**不许**升级成诊断错误。
 *
 * 只静音一种情况：`ENOENT`（文件还没写过）。其余一律留痕：
 * - 文件存在但不是合法 JSON，或注入的 parse 判定 schema 不合法 → `reason: 'invalid'` + 原始 error，
 *   调用方自己决定记什么诊断码（PLC 历史仍记 `PLC_HISTORY_READ_FAILED`，否则「静音首启」会扩大成「吞掉损坏」）。
 * - EACCES / EISDIR / EIO 等 fs 错误 → **原样抛出**，不映射成 missing/invalid，
 *   也不在这里记日志（调用方才知道该记哪个诊断码）。
 *
 * 为什么不用 `existsSync` 当守卫：它把「没权限」和「不存在」都判成 false，
 * 权限错误会被当成首启静音掉 —— 这正是要避免的吞异常。
 */
import { readFileSync } from 'node:fs';

export type OptionalJsonReason = 'ok' | 'missing' | 'invalid';

export interface OptionalJsonRead<T> {
  value: T | null;
  reason: OptionalJsonReason;
  /** 仅 `invalid` 时存在：坏 JSON 的 SyntaxError 或 parse 抛出的原错误。`missing` 不带这个字段。 */
  error?: unknown;
}

/**
 * @param filePath 目标文件
 * @param parse 把 unknown 收敛成期望形状；抛错即视为 `invalid`（schema 不合法与坏 JSON 同一档）
 */
export function readOptionalJson<T>(filePath: string, parse: (raw: unknown) => T): OptionalJsonRead<T> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      // 首启：文件还没写过。这是正常路径，静音返回，不构造 error 也不给诊断码。
      return { value: null, reason: 'missing' };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { value: null, reason: 'invalid', error };
  }

  try {
    return { value: parse(raw), reason: 'ok' };
  } catch (error) {
    return { value: null, reason: 'invalid', error };
  }
}
