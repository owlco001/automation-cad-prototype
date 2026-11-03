/**
 * 机型库 IPC 的**纯**逻辑（主进程 handler 与单测共用，不 import electron、不碰 fs）。
 *
 * 为什么单独一层：`library:*` 的入参全部来自渲染进程，`id` 会被拿去拼库目录路径，
 * 所以「渲染层传来什么算合法」必须是一个可单测的纯函数，而不是散在 handler 里的 if。
 *
 * 约定：
 * - 校验口径与 `store.ts` 的 `sanitizeMachineId` **完全一致**：净化前后必须逐字相等，
 *   所以 `..`、`/`、`\`、盘符、绝对路径、控制字符、首尾 `.`/`-`/`_`、Windows 保留名
 *   都会被拒（净化会改写它们，改写即不等于原值）。
 * - 失败一律折成 `{ ok:false, code, message, hint? }`：原始异常（含堆栈）只进主进程诊断日志，
 *   渲染层只拿到统一文案，避免把内部路径/堆栈漏到界面。
 */

import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { MACHINE_LIBRARY_HINTS, MachineLibraryError, serializeMachineLibraryError } from './library.ts';
import { sanitizeMachineId } from './store.ts';

export interface MachineLibraryIpcFailure {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

export interface MachineLibraryIpcOkId {
  ok: true;
  id: string;
}

/** id 最大长度与 `sanitizeMachineId` 的截断上限一致（超长 id 一定是被改写过的）。 */
export const MACHINE_LIBRARY_MAX_ID_LENGTH = 64;

const FAILURE_HINT: Record<string, string> = {
  LIBRARY_IO_FAILED: '重试一次；仍然失败请查看诊断日志（帮助 → 诊断报告）'
};

function rejectId(message: string): MachineLibraryIpcFailure {
  const hint = MACHINE_LIBRARY_HINTS.LIBRARY_BAD_PATH;
  return { ok: false, code: 'LIBRARY_BAD_PATH', message, ...(hint ? { hint } : {}) };
}

/**
 * 渲染层传来的机型 id 是否可以直接拼进库目录。
 *
 * 拒绝顺序是先「明显非法」（类型/绝对路径/穿越/控制字符），最后才是与
 * `sanitizeMachineId` 的不动点比对——两条都对上才放行；只过其中一条都是漏洞。
 */
export function validateLibraryId(value: unknown): MachineLibraryIpcOkId | MachineLibraryIpcFailure {
  if (typeof value !== 'string') return rejectId('机型 id 必须是字符串');
  if (!value) return rejectId('机型 id 不能为空');
  if (value.trim() !== value) return rejectId('机型 id 不能有首尾空白');
  if (value.length > MACHINE_LIBRARY_MAX_ID_LENGTH) {
    return rejectId(`机型 id 过长（${value.length} > ${MACHINE_LIBRARY_MAX_ID_LENGTH}）`);
  }
  if (value.includes('/') || value.includes('\\')) return rejectId(`机型 id 不能包含路径分隔符：${value}`);
  if (value.includes('..')) return rejectId(`机型 id 不能包含 ..：${value}`);
  if (value.startsWith('.')) return rejectId(`机型 id 不能以 . 开头：${value}`);
  if (/^[A-Za-z]:/.test(value)) return rejectId(`机型 id 不能带盘符：${value}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return rejectId('机型 id 不能包含控制字符');
  if (value === '.' || value === '..') return rejectId('机型 id 不能是 . 或 ..');
  // 最后一道：净化不动点。斜杠/控制字符上面已拦，这里兜的是「首尾 ._-、保留名、
  // 非法字符、超长截断、NFKC 差异」等只能靠净化器本身判定的情况。
  if (sanitizeMachineId(value) !== value) {
    return rejectId(`机型 id 不合法（含非法字符、需要净化，或与库文件命名规则不一致）：${value}`);
  }
  return { ok: true, id: value };
}

/** 与 `validateLibraryId` 同一口径的布尔版（渲染层禁用按钮用，不构造错误对象）。 */
export function isLibraryIdSafe(value: unknown): boolean {
  return validateLibraryId(value).ok === true;
}

/**
 * 把任何异常折成渲染层可用的失败结果。
 *
 * `MachineLibraryError` 直接沿用 `serializeMachineLibraryError`（code 语义不变、hint 保留）；
 * 其它异常说明有未预期的坏情况：细节（含堆栈）只进诊断环形缓冲，界面拿到固定文案。
 */
export function machineLibraryFailure(error: unknown): MachineLibraryIpcFailure {
  if (error instanceof MachineLibraryError) return serializeMachineLibraryError(error);
  recordDiagnosticError('MACHINE_LIBRARY_IPC_FAILED', error, { site: 'desktop/src/machine/library-ipc.ts' });
  return {
    ok: false,
    code: 'LIBRARY_IO_FAILED',
    message: '机型库操作失败，请重试；若持续失败请查看诊断报告',
    hint: FAILURE_HINT.LIBRARY_IO_FAILED as string
  };
}
