// 把「按 id 取已校验分块源码」这一点能力交给渲染层。
//
// 收得很紧：
// - 只接受可信主窗口的主 frame（复用 isTrustedUiUrl / isTrustedIpcSender 的口径）；
// - 只接受清单里声明过的模块 id（ModuleChunkReader 只按 id 查表，不接路径）；
// - 一次调用只返回一个分块的源码，不提供目录列举、批量读取或任意路径读取。
//
// 渲染层拿到源码后仍会自己复核字节数与 sha256（chunk-loader），这里是第二道校验。

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { ModuleChunkReader } from './module-chunks.ts';
import { isTrustedIpcSender, isTrustedUiUrl } from './security.ts';

export interface ModuleChunkIpcOptions {
  /** 分块目录：打包态 resources/dist/modules，开发态 dist/modules。 */
  rootDir: string;
  /** UI 入口路径（与其它 IPC 校验同一份）。 */
  trustedUiPath: string;
  mainWindow: () => BrowserWindow | null;
}

export function registerModuleChunkIpc(options: ModuleChunkIpcOptions): () => void {
  const reader = new ModuleChunkReader({ rootDir: options.rootDir });
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    const window = options.mainWindow();
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用');
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow !== window) throw new Error('拒绝：不是主窗口发起的请求');
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) throw new Error('拒绝：只接受主 frame');
    if (!isTrustedUiUrl(frame.url, options.trustedUiPath)) throw new Error('拒绝：来源不可信');
    if (!isTrustedIpcSender(event, window.webContents.id, options.trustedUiPath)) throw new Error('拒绝：发送方不可信');
  };
  ipcMain.handle('modules:manifest', (event) => {
    requireTrusted(event);
    const loaded = reader.manifest();
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
    return { ok: true, manifest: loaded.manifest };
  });
  ipcMain.handle('modules:chunk', (event, id: unknown) => {
    requireTrusted(event);
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
      return { ok: false, code: 'CHUNK_NOT_DECLARED', message: '模块 id 非法' };
    }
    const result = reader.read(id);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, id, source: result.source, sha256: result.entry.sha256, bytes: result.entry.bytes };
  });
  return () => {
    ipcMain.removeHandler('modules:manifest');
    ipcMain.removeHandler('modules:chunk');
  };
}
