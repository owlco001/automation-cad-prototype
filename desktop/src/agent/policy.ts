/**
 * 会话策略层（纯函数）
 *
 * 这里承载不能依赖提示词的硬边界：
 * 1. 绕过确认意图识别 —— 只用于收紧权限，命中后写工具仍必须确认；
 * 2. 导出目标路径判定 —— 用户给的路径不能静默改写，默认只接受纯文件名。
 * 3. MCP / JSON-RPC 写授权 —— 只有明确只读白名单可免确认，其余调用失败关闭。
 *
 * 模块自身不做 IO；对话会话与协议入口都必须显式确认后才允许执行写操作。
 */

import { requiresWriteConfirmation } from './router.ts';

export interface BypassIntent {
  bypass: true;
  phrase: string;
}

export const BYPASS_CONFIRMATION_NOTICE = '用户要求跳过确认，但写操作必须确认';

export type ConfirmAgentToolWrite = (
  name: string,
  args: Record<string, unknown>
) => Promise<boolean> | boolean;

export type ToolAuthorizationResult =
  | { ok: true }
  | { ok: false; code: 'WRITE_CONFIRMATION_REQUIRED' | 'USER_DENIED' | 'CONFIRMATION_FAILED'; message: string };

/** MCP 与 JSON-RPC 共用的写授权边界；缺回调、拒绝或回调异常均不放行。 */
export async function authorizeAgentToolCall(
  name: string,
  args: Record<string, unknown>,
  confirmWrite?: ConfirmAgentToolWrite
): Promise<ToolAuthorizationResult> {
  if (!requiresWriteConfirmation(name)) return { ok: true };
  if (typeof confirmWrite !== 'function') {
    return {
      ok: false,
      code: 'WRITE_CONFIRMATION_REQUIRED',
      message: '该工具会执行写操作，但当前入口没有桌面确认回调；未执行。'
    };
  }
  try {
    if (await confirmWrite(name, args) === true) return { ok: true };
    return { ok: false, code: 'USER_DENIED', message: '用户拒绝写操作，未执行。' };
  } catch {
    return { ok: false, code: 'CONFIRMATION_FAILED', message: '桌面确认失败，已拒绝写操作。' };
  }
}

const EXPLICIT_CONSENT_PATTERN = /同意|确认|就改|继续改|我批准/;

/**
 * 判断用户本轮是否明确同意重试此前被拒绝的操作。
 *
 * 只接受固定同意词；「继续」「好的」等模糊搭话不算授权，避免拒绝记忆被
 * 自动重试绕过。该函数只用于解除拒绝记忆，不替代写操作的确认弹窗。
 */
export function hasExplicitConsent(text: string): boolean {
  return typeof text === 'string' && EXPLICIT_CONSENT_PATTERN.test(text);
}

const BYPASS_PATTERNS: RegExp[] = [
  /别(?:再)?问(?:我)?(?:了|啦|啊)?/,
  /不(?:用|需要|必)(?:再)?(?:向我)?确认/,
  /无需(?:再)?确认/,
  /不要(?:再)?确认/,
  /跳过(?:写操作)?确认/,
  /(?:我|本人)(?:已经)?授权/,
  /别让我(?:再)?(?:点|按|点确认|确认)/,
  /直接覆盖(?:旧文件|掉)?/
];

/**
 * 识别用户是否在要求跳过确认。返回命中的原短语，供审计与确认文案引用。
 * 未命中返回 null；调用方不得把“未命中”当作任何授权。
 */
export function detectBypassIntent(text: string): BypassIntent | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const pattern of BYPASS_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return { bypass: true, phrase: match[0] };
  }
  return null;
}

const CONFIRMATION_CLAIM = /无需(?:用户)?确认|已(?:经)?自动确认|自动确认(?:完成|成功)?/g;

/** 过滤模型回复里“无需确认 / 已自动确认”等越权话术。 */
export function sanitizeConfirmationClaims(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CONFIRMATION_CLAIM, '已按规则请求确认');
}

export const ALLOWED_EXPORT_DIRECTORY = 'userData/exports/';

export type ExportPathRejection =
  | 'absolute'
  | 'drive'
  | 'unc'
  | 'traversal'
  | 'separator'
  | 'system';

export interface ExportTargetPathCheck {
  ok: boolean;
  /** 用户显式允许净化后，结果会带 sanitized:true。 */
  sanitized: boolean;
  reason?: ExportPathRejection;
  message?: string;
}

const SYSTEM_DIRECTORY = /(?:^|[\\/])(?:windows|system32|program files|programdata|etc|usr|bin|sbin|root|srv)(?:[\\/]|$)/i;
const TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

function rejected(reason: ExportPathRejection): ExportTargetPathCheck {
  return {
    ok: false,
    sanitized: false,
    reason,
    message:
      `目标路径不受支持：仅允许写入 ${ALLOWED_EXPORT_DIRECTORY}。` +
      '请只提供文件名；确需由系统净化路径时，显式传入 allowSanitize=true。'
  };
}

/**
 * 判定用户提供的导出目标。
 *
 * - 纯文件名：允许，落盘到固定导出目录；
 * - 绝对路径 / 盘符 / UNC / `../` / 相对目录 / 系统目录：默认拒绝，不静默改写；
 * - `allowSanitize=true`：显式允许净化后落盘，结果标记 sanitized。
 */
export function checkExportTargetPath(
  fileName: unknown,
  allowSanitize: unknown = false
): ExportTargetPathCheck {
  const sanitizeAllowed = allowSanitize === true;
  if (fileName === undefined || fileName === null || fileName === '') {
    return { ok: true, sanitized: sanitizeAllowed };
  }
  if (typeof fileName !== 'string') {
    return {
      ok: false,
      sanitized: false,
      reason: 'separator',
      message: 'fileName 必须是字符串'
    };
  }

  const raw = fileName.trim();
  if (!raw) return { ok: true, sanitized: sanitizeAllowed };
  if (sanitizeAllowed) return { ok: true, sanitized: true };

  if (UNC_PATH.test(raw)) return rejected('unc');
  if (WINDOWS_DRIVE.test(raw)) return rejected('drive');
  if (raw.startsWith('/')) return rejected('absolute');
  if (SYSTEM_DIRECTORY.test(raw)) return rejected('system');
  if (TRAVERSAL.test(raw)) return rejected('traversal');
  if (/[\\/]/.test(raw)) return rejected('separator');
  return { ok: true, sanitized: false };
}
