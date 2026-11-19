/**
 * 启动失败的「渲染层可见视图」——纯函数，不 import electron / node:*。
 *
 * 背景：`parametric.ts` 的 `ParametricStartInfo` 里早就有 6 个机器可判的失败证据
 * （`code` / `elapsedMs` / `exitCode` / `signal` / `stderrClass` / `stderrTail`），
 * 但 `ipc.ts` 的旧 `publicStart()` 只搬 `ok/status/message/version`，UI 只能从
 * message 里那句 `code=2 signal=无，启动后 96 ms` 反推，分不清 argparse / 缺包 /
 * 占端口（分类只在 `stderrClass` 里）。这里把 6 个字段显式搬到公开结果，仍然剥掉
 * `port` / `token`。
 *
 * 两条纪律：
 *   1) 逐项赋值，不 spread —— tsconfig 开了 `exactOptionalPropertyTypes`，展开
 *      `Partial<...>` 会把 `code?: X` 变成 `X | undefined`（同 `parametric.ts:1024` 的注释）。
 *   2) 出口再过一遍 token 脱敏 —— `parametric.ts` 的环形缓存已按 token 完整/分片/
 *      截断替换成 `[REDACTED]`；这里是最后一道闸，路径变了也不会把 token 带进渲染层。
 */

import type {
  ParametricStartFailureCode,
  ParametricStartInfo,
  ParametricStderrClass
} from './parametric.ts';

/**
 * `parametric:start` 的公开结果：`ParametricStartInfo` 去掉 `port`/`token`，
 * 6 个失败证据字段逐项保留（不新增、不改名，渲染层契约见 `src/desktop-api.d.ts`）。
 */
export interface PublicParametricStartResult {
  ok: boolean;
  status: ParametricStartInfo['status'];
  message: string;
  version?: string;
  code?: ParametricStartFailureCode;
  /** 实测启动耗时（launch 开始 → ready 或失败定性），ms。 */
  elapsedMs?: number;
  /** 子进程自己的 exit code（早退场景）；spawn 失败或无 exit 时为 null。 */
  exitCode?: number | null;
  /** 终止信号（SIGKILL/SIGTERM…），正常 exit 为 null。 */
  signal?: string | null;
  /** stderr 结构化分类。 */
  stderrClass?: ParametricStderrClass;
  /** 已脱敏的 stderr 尾部，≤ 4 KB。 */
  stderrTail?: string;
}

/**
 * 短于这个长度的 token 不参与替换：token 是 32 字节 base64url，太短的串替换会误伤正常 stderr。
 */
const MIN_TOKEN_REDACT_LENGTH = 8;

function redactToken(text: string, token: string | null): string {
  if (!token || token.length < MIN_TOKEN_REDACT_LENGTH) return text;
  return text.split(token).join('[REDACTED]');
}

/**
 * `ParametricStartInfo` → 公开结果。6 字段逐项赋值，`port`/`token` 在这一层就不存在。
 */
export function toPublicStartResult(info: ParametricStartInfo): PublicParametricStartResult {
  const token = typeof info.token === 'string' ? info.token : null;
  const result: PublicParametricStartResult = {
    ok: info.ok,
    status: info.status,
    message: redactToken(info.message, token)
  };
  // 与旧 `publicStart()` 的 truthy 判断一致：空 version 不出现。
  if (info.version) result.version = info.version;
  if (info.code !== undefined) result.code = info.code;
  if (info.elapsedMs !== undefined) result.elapsedMs = info.elapsedMs;
  if (info.exitCode !== undefined) result.exitCode = info.exitCode;
  if (info.signal !== undefined) result.signal = info.signal;
  if (info.stderrClass !== undefined) result.stderrClass = info.stderrClass;
  if (info.stderrTail !== undefined) result.stderrTail = redactToken(info.stderrTail, token);
  return result;
}

/**
 * 失败分类的一行摘要，形如 `分类=argparse · 实测 96 ms · exit=2`。
 *
 * 只列真正拿到的证据；成功结果或没有任何证据时返回空串（调用方据此决定不追加后缀），
 * 所以 UI 上的 message 文案在旧路径下逐字不变。
 */
export function describeStartFailure(info: PublicParametricStartResult): string {
  if (info.ok) return '';
  const parts: string[] = [];
  if (info.stderrClass !== undefined) parts.push(`分类=${info.stderrClass}`);
  if (info.elapsedMs !== undefined) parts.push(`实测 ${info.elapsedMs} ms`);
  if (info.signal !== undefined && info.signal !== null) parts.push(`signal=${info.signal}`);
  else if (info.exitCode !== undefined && info.exitCode !== null) parts.push(`exit=${info.exitCode}`);
  return parts.join(' · ');
}
