import panelStyles from './panels.css?inline';
import { syncToolMenu } from './tool-menu.ts';
import { drawerIdForEntry } from './drawer-ids.ts';
import { decideEntryBar } from './entry-bar.ts';

let stylesInjected = false;
let toastTimer = 0;

export function ensurePanelStyles(): void {
  if (stylesInjected || document.getElementById('acp-panel-styles')) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'acp-panel-styles';
  style.textContent = panelStyles;
  document.head.appendChild(style);
  stylesInjected = true;
}

/** 元素 → 句柄：`closeDrawerElement` 只拿到元素，靠这张表找回句柄上的关闭钩子。 */
const drawerHandles = new WeakMap<HTMLElement, DrawerHandle>();

function closeDrawerElement(element: HTMLElement): void {
  // 已经是收起状态就别再触发一次钩子（同一抽屉被连关两次不应该重复回调）
  const wasOpen = !element.hidden;
  element.hidden = true;
  element.classList.remove('is-open');
  // 所有关闭路径都收敛到这里：× 按钮、Esc、再点工具栏入口、被新抽屉挤掉。
  // 调用方（如智能体面板）在这里取消仍在跑的后台循环，否则面板关了场景还在动。
  if (wasOpen) drawerHandles.get(element)?.onClose?.();
}

/**
 * 收起除 keep 之外所有已打开的抽屉。
 * 所有抽屉停靠在同一个位置，同时打开只会互相遮挡，所以打开新的必须先收起旧的。
 * 返回被收起的数量，便于调用方与测试断言。
 */
export function closeOtherDrawers(keep: HTMLElement | null = null): number {
  let closed = 0;
  document.querySelectorAll<HTMLElement>('.acp-drawer').forEach((element) => {
    if (element === keep || element.hidden) return;
    closeDrawerElement(element);
    closed += 1;
  });
  return closed;
}

/**
 * 按当前可用宽度决定入口栏是「带文字」还是「只留图标」。
 * 只会切 class，不隐藏任何入口——极端窄窗口仍有横向滚动兜底。
 */
let entryBarResizeBound = false;

/** 窗口变窄/变宽时要重新判定（一次绑定，幂等）。 */
function bindEntryBarResize(): void {
  if (entryBarResizeBound) return;
  entryBarResizeBound = true;
  window.addEventListener('resize', () => syncEntryBarMode());
}

export function syncEntryBarMode(): void {
  bindEntryBarResize();
  const bar = document.querySelector<HTMLElement>('.tb-right');
  if (!bar) return;
  const buttons = Array.from(bar.querySelectorAll<HTMLElement>('.acp-entry-btn'));
  if (buttons.length === 0) return;
  // 先撤掉 compact 再量，否则会拿图标态宽度去和阈值比、class 来回抖
  bar.classList.remove('is-compact');
  const gap = 6;
  const fullWidth = buttons.reduce((sum, button) => sum + button.offsetWidth, 0) + gap * (buttons.length - 1);
  const compactNeeded = buttons.length * 32 + gap * (buttons.length - 1);
  const decision = decideEntryBar({
    needed: fullWidth,
    available: bar.clientWidth,
    compactNeeded
  });
  bar.classList.toggle('is-compact', decision.mode === 'compact');
  bar.classList.toggle('is-scrollable', decision.scrolls);
}

export function buildEntryButton(id: string, label: string, icon: string, onClick: () => void): HTMLButtonElement | null {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLButtonElement) return existing;
  const target = document.querySelector('.tb-right');
  if (!target) return null;
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.className = 'acp-entry-btn';
  button.title = label;
  button.innerHTML = `${icon}<span>${label}</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 同一个入口再点一次 = 收起当前抽屉（切换标签时上一个必须缩回，而不是层层叠加）。
    const drawerId = drawerIdForEntry(id);
    const openDrawer = drawerId ? document.getElementById(drawerId) : null;
    if (openDrawer instanceof HTMLElement && !openDrawer.hidden) {
      closeDrawerElement(openDrawer);
      return;
    }
    onClick();
  });
  target.appendChild(button);
  // 新注册的入口直接进「工具」菜单：栏上留文字按钮会把顶栏顶爆，
  // 降级成图标又认不出，所以入口统一收进菜单
  syncToolMenu();
  syncEntryBarMode();
  return button;
}

export interface DrawerHandle {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  /**
   * 抽屉被收起时调用一次（× 按钮、Esc、再点工具栏入口、被新抽屉挤掉都算）。
   * 面板只 `hidden`、不销毁 DOM，所以后台循环必须靠这个钩子自己停。
   */
  onClose?: () => void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createDrawer(id: string, title: string, subtitle: string): DrawerHandle {
  const existing = document.getElementById(id);
  const root = existing instanceof HTMLElement ? existing : document.createElement('div');
  if (!existing) {
    root.id = id;
    root.className = 'acp-drawer';
    root.hidden = true;
    root.innerHTML = `
      <header class="acp-drawer-head">
        <div>
          <h2 class="acp-drawer-title"></h2>
          <p class="acp-drawer-sub"></p>
        </div>
        <button type="button" class="acp-icon-btn" data-acp-close aria-label="关闭">×</button>
      </header>
      <div class="acp-drawer-body"></div>
      <footer class="acp-drawer-foot"></footer>`;
    document.body.appendChild(root);
  }
  const titleElement = root.querySelector<HTMLElement>('.acp-drawer-title');
  const subtitleElement = root.querySelector<HTMLElement>('.acp-drawer-sub');
  if (titleElement) titleElement.textContent = title;
  if (subtitleElement) subtitleElement.textContent = subtitle;
  const body = root.querySelector<HTMLElement>('.acp-drawer-body');
  const footer = root.querySelector<HTMLElement>('.acp-drawer-foot');
  if (!body || !footer) throw new Error(`面板结构不完整：${id}`);

  const handle: DrawerHandle = {
    root,
    body,
    footer,
    open(): void {
      closeOtherDrawers(root);
      root.hidden = false;
      root.classList.add('is-open');
    },
    close(): void {
      closeDrawerElement(root);
    },
    isOpen(): boolean {
      return !root.hidden;
    }
  };
  // 先登记再挂监听：×/Esc 的回调都走 handle.close()，钩子读的是同一份句柄
  drawerHandles.set(root, handle);
  root.querySelector('[data-acp-close]')?.addEventListener('click', () => handle.close());
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) {
      event.preventDefault();
      event.stopPropagation();
      handle.close();
    }
  }, true);

  return handle;
}

export function notify(message: string, error = false): void {
  ensurePanelStyles();
  let toast = document.getElementById('acpToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'acpToast';
    toast.className = 'acp-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('is-error', error);
  toast.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('is-on'), 3800);
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] ?? character;
  });
}
