import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IpcSenderFrameLike {
  readonly url: string;
}

export interface IpcSenderEventLike {
  readonly sender: {
    readonly id: number;
    readonly mainFrame: unknown;
    isDestroyed?: () => boolean;
  };
  readonly senderFrame: IpcSenderFrameLike | null;
}

/** 只允许应用入口 HTML；哈希/查询参数不改变其本地文件身份。 */
export function isTrustedUiUrl(candidateUrl: string, trustedUiPath: string): boolean {
  try {
    const url = new URL(candidateUrl);
    if (url.protocol !== 'file:' || url.host !== '') return false;
    return resolve(fileURLToPath(url)) === resolve(trustedUiPath);
  } catch {
    return false;
  }
}

/** IPC 必须来自当前主窗口的主 frame，且主 frame 正在显示应用入口页面。 */
export function isTrustedIpcSender(
  event: IpcSenderEventLike,
  expectedWebContentsId: number,
  trustedUiPath: string
): boolean {
  const frame = event.senderFrame;
  if (!frame || event.sender.isDestroyed?.()) return false;
  if (event.sender.id !== expectedWebContentsId || frame !== event.sender.mainFrame) return false;
  return isTrustedUiUrl(frame.url, trustedUiPath);
}
