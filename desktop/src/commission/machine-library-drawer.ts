/**
 * 机型库入口 + 抽屉外壳（DOM 部分）。
 *
 * 为什么单独一个文件：`machine-library-panel.ts` 是纯渲染（可被 node --test 直接加载），
 * 这里才 import `ui/panels`（带 `?inline` 样式）把抽屉、入口按钮、toast 接起来。
 * 业务动作（导入/导出/删除/加载）全在 panel 的 `bindMachineLibraryPanel` 里，本文件只做装配。
 */

import { buildEntryButton, createDrawer, ensurePanelStyles, errorMessage, notify } from '../ui/panels';
import {
  MACHINE_LIBRARY_STYLES,
  bindMachineLibraryPanel,
  type LibraryFailure,
  type MachineLibraryClient,
  type MachineLibraryEntryView
} from './machine-library-panel.ts';

const ENTRY_ID = 'machineLibraryEntryButton';
const DRAWER_ID = 'machineLibraryDrawer';

const LIBRARY_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><path d="M4.5 2.5v11M11.5 2.5v11"/></svg>';

const UNAVAILABLE: LibraryFailure = {
  ok: false,
  code: 'LIBRARY_IO_FAILED',
  message: '机型库仅在桌面版可用',
  hint: '请在 AutomationCAD 桌面客户端里打开机型库'
};

/** preload 暴露的 `window.__machineLibrary`；网页版（无 preload）走 UNAVAILABLE。 */
function resolveClient(): MachineLibraryClient {
  const api = window.__machineLibrary;
  if (!api) {
    return {
      list: async () => UNAVAILABLE,
      apply: async () => UNAVAILABLE,
      importPackage: async () => UNAVAILABLE,
      exportPackage: async () => UNAVAILABLE,
      remove: async () => UNAVAILABLE,
      sources: async () => UNAVAILABLE,
      download: async () => UNAVAILABLE
    };
  }
  return {
    list: () => api.list(),
    apply: (id) => api.apply(id),
    importPackage: (options) => api.importPackage(options ?? {}),
    exportPackage: (id) => api.exportPackage(id),
    remove: (id) => api.remove(id),
    // 远程来源/下载：只传 id；URL 与字节都在主进程，渲染层没有下载通道
    ...(api.sources ? { sources: () => api.sources!() } : {}),
    ...(api.download ? { download: (sourceId, machineId) => api.download!(sourceId, machineId) } : {})
  };
}

export interface MachineLibraryPanelOptions {
  /**
   * 加载成功后把 design 应用回当前工程（3D 视图 / BOM / 电气）。
   * 抛错由面板转成界面文案，不会打断「库已加载」这个事实。
   */
  onApplied(design: unknown, entry: MachineLibraryEntryView): void;
  client?: MachineLibraryClient;
}

export interface MachineLibraryUiHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 重新拉列表并重绘（截图脚本 / 外部自检用） */
  refresh(): Promise<void>;
}

let stylesInjected = false;

function ensureStyles(): void {
  ensurePanelStyles();
  if (stylesInjected || document.getElementById('machine-library-styles')) return;
  const style = document.createElement('style');
  style.id = 'machine-library-styles';
  style.textContent = MACHINE_LIBRARY_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

export function initMachineLibraryPanel(options: MachineLibraryPanelOptions): MachineLibraryUiHandle | null {
  ensureStyles();
  let panel: ReturnType<typeof bindMachineLibraryPanel> | null = null;
  let drawerHandle: ReturnType<typeof createDrawer> | null = null;

  const openDrawer = (): void => {
    drawerHandle?.open();
    void panel?.refresh();
  };

  const entry = buildEntryButton(ENTRY_ID, '机型库', LIBRARY_ICON, openDrawer);
  if (!entry) return null;
  // 截图脚本与外部自检的稳定锚点（入口可能被 «工具» 菜单收走，无法按位置点）
  entry.dataset.machineLibraryOpen = '';

  const drawer = createDrawer(DRAWER_ID, '机型库', '本机机型模板 · 导入 / 导出 .machine.zip · 远程来源按需下载 · 加载即替换当前方案');
  drawerHandle = drawer;
  drawer.root.classList.add('machine-library-drawer');
  drawer.body.innerHTML = '';
  drawer.footer.innerHTML = '<span class="acp-pill">包内逐条 SHA-256 校验</span>'
    + '<span class="acp-pill">整包 ≤ 50 MiB</span>'
    + '<span class="acp-pill">文件选择在主进程</span>';

  panel = bindMachineLibraryPanel({
    root: drawer.body,
    client: options.client ?? resolveClient(),
    notify: (message, error) => notify(message, error === true),
    onApplied: (design, entryRow) => {
      // 库里的包已经落盘到 machine/<id>.json 了：这里只把「刷新工程失败」的干净文案
      // 交给 panel 统一展示（panel 会标成「已加载到库，但应用到当前工程失败」），不重复 toast。
      try {
        options.onApplied(design, entryRow);
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    }
  });

  return {
    open: openDrawer,
    close: () => drawerHandle?.close(),
    isOpen: () => drawerHandle?.isOpen() === true,
    refresh: async () => {
      await panel?.refresh();
    }
  };
}
