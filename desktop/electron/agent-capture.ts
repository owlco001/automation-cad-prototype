/**
 * 主进程截图通道：给 `capture_view` 工具提供真实画面。
 *
 * 为什么要单独一层：`src/agent/self-evidence.ts` 是纯函数（可在 node 里测落盘/哈希/5 MiB 重拍），
 * 真正碰 Electron 的部分只能在这里 —— 窗口是否存在、扩展是否就绪、是否还停在首页、
 * 目标视图有没有可点的入口，全部由这一层判定并返回稳定错误码。
 *
 * 纪律：**不在首页状态下截图**。启动时 `#app` 是 inert + aria-hidden，被首页盖着，
 * 这时 capturePage 拿到的是首页那一帧 —— 那就是「拿首页截图冒充 3D 视图」，
 * 比失败更糟，所以前置检查不通过一律 `VIEW_NOT_READY`。
 */

import { nativeImage, type BrowserWindow } from 'electron';
import type { AgentCaptureView, AgentViewCapture, AgentViewCaptureRequest, AgentViewCaptureResult } from '../src/agent/self-evidence.ts';

interface WorkspaceState {
  extensionReady: boolean;
  workspaceVisible: boolean;
  activeView: string;
}

interface ViewProbe {
  ok: boolean;
  activeView: string;
  /** 该视图是否已经就绪（抽屉/菜单已打开，且有内容） */
  ready: boolean;
  missing?: string;
}

const VIEW_TIMEOUT_MS = 6_000;
const ACTION_TIMEOUT_MS = 4_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** executeJavaScript 兜底超时：渲染层卡死时不能让工具调用一直挂着。 */
async function evalJs<T>(window: BrowserWindow, expression: string, timeoutMs = VIEW_TIMEOUT_MS): Promise<T> {
  return await Promise.race([
    window.webContents.executeJavaScript(expression) as Promise<T>,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`渲染层 ${timeoutMs} ms 未响应`)), timeoutMs);
    })
  ]);
}

function notReady(hint: string, message: string): AgentViewCaptureResult {
  return { ok: false, code: 'VIEW_NOT_READY', message, hint };
}

async function readWorkspace(window: BrowserWindow): Promise<WorkspaceState> {
  return await evalJs<WorkspaceState>(
    window,
    `(() => {
      const app = document.getElementById('app');
      const home = document.querySelector('.home-root');
      const drawer = document.getElementById('machineLibraryDrawer');
      const commission = document.getElementById('commissionDrawer');
      const menu = document.getElementById('cadExportMenu');
      const activeView = !drawer || drawer.hidden
        ? (!commission || commission.hidden ? (menu && !menu.hidden ? 'exports' : '3d') : 'linkage')
        : 'library';
      return {
        extensionReady: window.__AUTOMATION_CAD_EXTENSION_READY__ === true,
        workspaceVisible: Boolean(app && app.getAttribute('aria-hidden') === null && (!home || home.hidden)),
        activeView
      };
    })()`
  );
}

/** 等某个视图就绪；返回 false 表示超时（调用方据此报 VIEW_NOT_READY，不猜）。 */
async function waitForView(window: BrowserWindow, view: AgentCaptureView, timeoutMs = ACTION_TIMEOUT_MS): Promise<ViewProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe: ViewProbe = { ok: false, activeView: '3d', ready: false };
  do {
    const state = await readWorkspace(window);
    if (view === '3d') {
      return { ok: true, activeView: '3d', ready: state.activeView === '3d' };
    }
    probe = {
      ok: true,
      activeView: state.activeView,
      ready: state.activeView === view
    };
    if (probe.ready) return probe;
    await delay(120);
  } while (Date.now() < deadline);
  return probe;
}

async function switchView(window: BrowserWindow, view: AgentCaptureView): Promise<AgentViewCaptureResult> {
  if (view === '3d') {
    // 截图前把会盖住视口的抽屉/菜单收掉，否则「3d」截到的是机型库或导出菜单
    await evalJs(
      window,
      `(() => {
        document.querySelectorAll('#machineLibraryDrawer [data-acp-close], #commissionDrawer [data-acp-close]')
          .forEach((button) => { if (!button.closest('[hidden]')) button.click(); });
        const menu = document.getElementById('cadExportMenu');
        if (menu) menu.hidden = true;
        return true;
      })()`
    );
    const probe = await waitForView(window, '3d', ACTION_TIMEOUT_MS);
    if (!probe.ready) {
      return notReady('先关闭机型库/联调抽屉或导出菜单，等 3D 视口露出来再截图', '3D 视图没有露出（仍被其他面板遮挡）');
    }
    return { ok: true, png: new Uint8Array() };
  }

  if (view === 'library') {
    await evalJs(
      window,
      `(() => {
        const drawer = document.getElementById('machineLibraryDrawer');
        if (drawer && !drawer.hidden) return 'already';
        const entry = document.querySelector('[data-machine-library-open]');
        if (!entry) return 'missing-entry';
        entry.click();
        return 'clicked';
      })()`
    );
    const probe = await waitForView(window, 'library');
    if (!probe.ready) {
      return notReady('当前界面没有「机型库」入口，或抽屉没有打开', '机型库视图不可用');
    }
    return { ok: true, png: new Uint8Array() };
  }

  if (view === 'linkage') {
    await evalJs(
      window,
      `(() => {
        const drawer = document.getElementById('commissionDrawer');
        if (drawer && !drawer.hidden) return 'already';
        const entry = document.getElementById('commissionEntryButton');
        if (!entry) return 'missing-entry';
        entry.click();
        return 'clicked';
      })()`
    );
    const probe = await waitForView(window, 'linkage');
    if (!probe.ready) {
      return notReady('顶部「联调」入口缺失，或联调抽屉没有打开', '联动调试视图不可用');
    }
    return { ok: true, png: new Uint8Array() };
  }

  // exports：顶部「导出」下拉菜单，菜单里有真实按钮才算就绪
  const clicked = await evalJs<string>(
    window,
    `(() => {
      const menu = document.getElementById('cadExportMenu');
      if (menu && !menu.hidden && menu.querySelectorAll('[data-export]').length > 0) return 'already';
      const trigger = document.querySelector('[data-cad-action="export-menu"]');
      if (!trigger) return 'missing-entry';
      trigger.click();
      return 'clicked';
    })()`
  );
  if (clicked === 'missing-entry') {
    return notReady('顶部工具条没有「导出」按钮（可能还没打开 CAD 工作区）', '导出视图不可用');
  }
  const probe = await waitForView(window, 'exports');
  if (!probe.ready) {
    return notReady('导出菜单没有展开，或菜单里没有导出项', '导出视图不可用');
  }
  return { ok: true, png: new Uint8Array() };
}

async function settle(window: BrowserWindow, extraMs = 260): Promise<void> {
  await evalJs(
    window,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      setTimeout(resolve, ${Math.max(0, Math.round(extraMs))})
    )))`,
    ACTION_TIMEOUT_MS
  );
}

/**
 * 构造注入给命令总线的截图通道。
 * `getWindow` 每次现取（窗口可能重建），不要在闭包里抓死。
 */
export function createAgentViewCapture(getWindow: () => BrowserWindow | null): AgentViewCapture {
  return async (request: AgentViewCaptureRequest): Promise<AgentViewCaptureResult> => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return notReady('先启动并打开 AutomationCAD 主窗口，再调用 capture_view', '没有可截图的桌面窗口');
    }

    let state: WorkspaceState;
    try {
      state = await readWorkspace(window);
    } catch (error) {
      return notReady('窗口还在加载；等首页出现并进入经典原型界面后再试', `渲染层未响应：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!state.extensionReady) {
      return notReady('等桌面扩展就绪（首页出现）后再试', '桌面扩展尚未就绪');
    }
    if (!state.workspaceVisible) {
      // 这里就是「不拿首页截图冒充」的闸门
      return notReady('先点首页的「进入经典原型界面」，等 3D 工作区可见再截图', '页面仍停在首页（#app 仍 inert），拒绝截首页充数');
    }

    const switched = await switchView(window, request.view);
    if (!switched.ok) return switched;

    const size = window.getContentSize();
    const originalWidth = size[0] ?? 1600;
    const originalHeight = size[1] ?? 1000;
    try {
      try {
        window.setContentSize(request.width, request.height);
      } catch {
        // 全屏/最大化时 setContentSize 会抛；按当前尺寸截，返回值以实际像素为准
      }
      if (!window.isVisible()) window.showInactive();
      window.webContents.invalidate();
      await delay(220);
      await settle(window, 240);

      // 抓图前再核一次：切视图/等帧期间用户可能又点回首页，这时必须拒绝
      const finalState = await readWorkspace(window);
      if (!finalState.workspaceVisible || finalState.activeView !== request.view) {
        return notReady(
          '截图前画面又变了（回到首页或视图被切换）；请保持目标视图打开后重试',
          finalState.workspaceVisible ? `截图前视图不是 ${request.view}` : '截图前页面回到了首页'
        );
      }

      const image = await window.webContents.capturePage();
      const png = image.toPNG();
      if (!png || png.length === 0) {
        return notReady('窗口可能被最小化或被完全遮挡；显示窗口后重试', 'capturePage 返回空图');
      }
      const actual = nativeImage.createFromBuffer(png).getSize();
      return {
        ok: true,
        png: new Uint8Array(png),
        width: actual.width || request.width,
        height: actual.height || request.height
      };
    } catch (error) {
      return notReady('窗口不可捕获；确认应用窗口可见且未最小化后重试', `截图失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        window.setContentSize(originalWidth, originalHeight);
      } catch {
        // 还原失败不影响已产出的截图
      }
    }
  };
}
