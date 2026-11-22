// 把「按 id 取已校验分块源码」这一点能力交给渲染层。
//
// 收得很紧：
// - 只接受可信主窗口的主 frame（复用 isTrustedUiUrl / isTrustedIpcSender 的口径）；
// - 只接受清单里声明过的模块 id（ModuleChunkReader 只按 id 查表，不接路径）；
// - 一次调用只返回一个分块的源码，不提供目录列举、批量读取或任意路径读取。
//
// 两级来源：
// - `modules:chunk`：随包分块，从 rootDir（打包态 resources/dist/modules）读取；
// - `modules:installed-chunk`：已安装签名包，从 `<userData>/modules/<moduleId>/<version>`
//   读取，调用方只能给模块 id，版本与分块文件名都来自已安装清单。
//
// 已安装来源成功时只返回 `{ ok:true, id, source, sha256, bytes, apiCompatibility }`，
// **不返回安装路径、版本目录或包内文件路径**；失败只返回码与固定文案（底层错误里可能
// 带绝对路径，因此不透传，细节留在主进程）。
//
// 渲染层拿到源码后仍会自己复核字节数与 sha256（chunk-loader），这里是第二道校验。

import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { ModuleChunkReader } from './module-chunks.ts';
import { isTrustedIpcSender, isTrustedUiUrl } from './security.ts';
import {
  listInstalledChunkEntries,
  readInstalledChunkSource,
  type InstalledChunkFailureCode,
  type InstalledModuleReadOptions,
  type InstalledModuleSource
} from '../src/modules/installed-modules.ts';

export interface ModuleChunkIpcOptions {
  /** 分块目录：打包态 resources/dist/modules，开发态 dist/modules。 */
  rootDir: string;
  /** UI 入口路径（与其它 IPC 校验同一份）。 */
  trustedUiPath: string;
  mainWindow: () => BrowserWindow | null;
  /**
   * 已安装签名包的根目录（布局 `<root>/<moduleId>/<version>/manifest.json`）。
   *
   * 缺省由本文件推导为 `join(app.getPath('userData'), 'modules')`，并在**每次请求时**
   * 惰性求值（`app.getPath` 在 ready 之后才可用）。main.ts 目前不传这个字段，因此
   * 生产环境实际取值就是 `<userData>/modules`；只有测试或宿主需要换目录时才覆盖。
   * 刻意不读环境变量：渲染层无法影响这个取值。
   */
  installedRootDir?: string;
  /**
   * 可选：已安装包清单的 Ed25519 公钥（PEM）。提供时每个包都要求验签通过；
   * 缺省沿用 installed-modules 的语义（安装时已验签，读取时校验清单结构 + 文件哈希）。
   */
  installedPublicKeyPem?: string;
}

/** installed-modules 的失败码 → 面向渲染层的固定文案（不含任何路径）。 */
const INSTALLED_FAILURE_MESSAGES: Record<InstalledChunkFailureCode, string> = {
  MODULE_NOT_INSTALLED: '模块未安装或签名清单不可用',
  CHUNK_MISSING: '已安装包没有可用的分块文件',
  CHUNK_HASH_MISMATCH: '已安装分块的字节数或哈希与签名清单不符',
  PATH_UNSAFE: '已安装包清单包含不安全路径，已拒绝'
};

function installedFailure(code: InstalledChunkFailureCode, id: string): {
  ok: false;
  code: InstalledChunkFailureCode;
  message: string;
} {
  return { ok: false, code, message: `${INSTALLED_FAILURE_MESSAGES[code]}：${id}` };
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

  // 已安装签名包的分块：调用方只给模块 id。每次请求重新枚举（安装/卸载后无需缓存失效），
  // 版本、文件名、字节数、sha256 与 API 区间全部来自已安装包自己的签名清单。
  ipcMain.handle('modules:installed-chunk', async (event, id: unknown) => {
    requireTrusted(event);
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
      return { ok: false, code: 'MODULE_NOT_INSTALLED', message: '模块 id 非法' };
    }

    const root = options.installedRootDir ?? join(app.getPath('userData'), 'modules');
    const readOptions: InstalledModuleReadOptions =
      options.installedPublicKeyPem === undefined
        ? {}
        : { publicKeyPem: options.installedPublicKeyPem };

    let entry: InstalledModuleSource | undefined;
    try {
      const entries = await listInstalledChunkEntries(root, readOptions);
      entry = entries.find((candidate) => candidate.id === id);
    } catch {
      return installedFailure('MODULE_NOT_INSTALLED', id);
    }
    if (entry === undefined) return installedFailure('MODULE_NOT_INSTALLED', id);

    try {
      const read = await readInstalledChunkSource(root, entry.id, entry.moduleVersion, readOptions);
      if (!read.ok) return installedFailure(read.code, id);
      // 只交付执行所需的字段：不返回 entry.path / moduleVersion / file，避免把安装布局泄露给渲染层。
      return {
        ok: true,
        id: entry.id,
        source: read.source,
        sha256: entry.sha256,
        bytes: entry.bytes,
        apiCompatibility: {
          min: entry.apiCompatibility.min,
          max: entry.apiCompatibility.max
        }
      };
    } catch {
      return installedFailure('MODULE_NOT_INSTALLED', id);
    }
  });

  return () => {
    ipcMain.removeHandler('modules:manifest');
    ipcMain.removeHandler('modules:chunk');
    ipcMain.removeHandler('modules:installed-chunk');
  };
}
