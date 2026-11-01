/**
 * Qt 工作台启动/退出的提示文案映射（纯函数）。
 *
 * 顶栏「Qt 工作台」按钮、菜单入口和主进程广播的 qt:exited 都要说人话，但三个地方
 * 各自拼接文案会飘。这里只做「payload → 提示」，不碰 DOM / electron，便于单测。
 */

/** stderr 尾巴在提示里最多保留多少字（按 Unicode 码点算，不切断代理对）。 */
export const QT_NOTICE_STDERR_LIMIT = 200;

export interface QtNotice {
  message: string;
  error: boolean;
}

/** preload `qt.launch()` 的返回值；alreadyRunning 由主进程 qt-client 透传。 */
export interface QtLaunchReply {
  ok: boolean;
  pid?: number;
  exe?: string;
  alreadyRunning?: boolean;
  message?: string;
}

/** 主进程 `qt:exited` 广播的载荷。 */
export interface QtExitPayload {
  pid?: number;
  code: number | null;
  signal?: string | null;
  stderrTail?: string;
}

const FALLBACK_LAUNCH_FAILURE = 'Qt 工作台没有启动';

/** 按码点截断，超长时补省略号，保证「前 limit 字」可被完整读出。 */
export function truncateQtStderr(text: string, limit: number = QT_NOTICE_STDERR_LIMIT): string {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return '';
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return trimmed;
  return `${chars.slice(0, limit).join('')}…`;
}

/**
 * 启动结果 → 提示。三种情况必须分得开：
 * 失败（透传完整 message）、已在运行（不谎报新开进程）、正常启动。
 */
export function qtLaunchNotice(reply: QtLaunchReply | null | undefined): QtNotice {
  if (!reply || reply.ok !== true) {
    const message = typeof reply?.message === 'string' ? reply.message.trim() : '';
    return { message: message || FALLBACK_LAUNCH_FAILURE, error: true };
  }
  if (reply.alreadyRunning === true) {
    return { message: 'Qt 工作台已在运行', error: false };
  }
  return {
    message: typeof reply.pid === 'number' ? `Qt 工作台已启动（PID ${reply.pid}）` : 'Qt 工作台已启动',
    error: false
  };
}

/**
 * 退出事件 → 提示。0 是正常收工，不打扰用户；非 0（含被信号杀掉、code 为 null）
 * 才算异常，带上 stderr 尾巴帮现场定位。
 */
export function qtExitNotice(payload: QtExitPayload | null | undefined): QtNotice | null {
  if (!payload) return null;
  const code = payload.code;
  if (code === 0) return null;
  const signal = typeof payload.signal === 'string' && payload.signal ? payload.signal : '';
  const label = typeof code === 'number'
    ? String(code)
    : signal ? `null，signal=${signal}` : 'null';
  const tail = truncateQtStderr(payload.stderrTail ?? '');
  return {
    message: tail
      ? `Qt 工作台已退出（code=${label}）：${tail}`
      : `Qt 工作台已退出（code=${label}）：没有 stderr 输出`,
    error: true
  };
}
