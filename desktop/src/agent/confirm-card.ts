// 智能体写操作 · 页面内确认卡片
//
// 背景：写工具（apply_machine_design / build_machine_model / build_canvas_assembly / export_files…）
// 原来用 Electron 原生 dialog.showMessageBox 确认。原生模态框在无人值守、远程调试（CDP）时看不见也点不到，
// 实测会把智能体卡在一个隐形窗口上十几分钟。这里改成渲染进程内的卡片：主进程发请求，卡片回答案。
//
// 确认由主进程排队；每张卡只回答本次请求，不缓存许可。

interface ConfirmRequest {
  id: string;
  tool: string;
  title?: string;
  summary: string;
  detail?: string;
  bypassNotice?: string;
  /** 多步计划：每行一条「n. 工具 参数摘要」 */
  steps?: string[];
}

const STYLE_ID = 'agent-confirm-styles';
let disposeListener: (() => void) | null = null;
let activeCard: { id: string; dismiss(): void } | null = null;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  .acw-confirm-mask { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
    background: rgba(6, 10, 16, .62); backdrop-filter: blur(2px); }
  .acw-confirm-card { width: min(620px, calc(100vw - 48px)); max-height: 80vh; display: flex; flex-direction: column;
    background: #141b24; border: 1px solid #2b3846; border-radius: 10px; box-shadow: 0 18px 48px rgba(0,0,0,.5);
    color: #dfe7f3; font: 13px/1.6 "Segoe UI", "PingFang SC", sans-serif; overflow: hidden; }
  .acw-confirm-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #232f3b; }
  .acw-confirm-head b { font-size: 14px; }
  .acw-confirm-tool { padding: 2px 8px; border-radius: 10px; background: #1d2b3a; border: 1px solid #2f4a63; color: #9cc4ff; font-family: ui-monospace, monospace; font-size: 12px; }
  .acw-confirm-body { padding: 12px 16px; overflow: auto; }
  .acw-confirm-body p { margin: 0 0 8px; color: #9aa8b8; }
  .acw-confirm-args { margin: 0; padding: 10px; border-radius: 6px; background: #0e141b; border: 1px solid #1f2a36;
    font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-all; color: #c7d3e2; max-height: 240px; overflow: auto; }
  .acw-confirm-steps { margin: 0 0 10px; padding: 0 0 0 18px; color: #c7d3e2; font-size: 12px; }
  .acw-confirm-steps li { margin: 2px 0; font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; }
  .acw-confirm-warn { margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: #3a2a1c; border: 1px solid #6a4a24; color: #ffcf8f; font-size: 12px; }
  .acw-confirm-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid #232f3b; background: #101820; }
  .acw-confirm-btn { padding: 7px 14px; border-radius: 6px; border: 1px solid #2b3846; background: #1a232e; color: #dfe7f3; cursor: pointer; font-size: 12.5px; }
  .acw-confirm-btn:hover { background: #202c39; }
  .acw-confirm-btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .acw-confirm-btn.primary:hover { background: #2b7cf5; }
  .acw-confirm-btn.danger { color: #ff9a9a; border-color: #5a2b2b; }
  .acw-confirm-hint { margin-right: auto; align-self: center; color: #7d8b9c; font-size: 11.5px; }
  `;
  document.head.appendChild(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
  );
}

function reply(id: string, allow: boolean): void {
  const api = window.desktop?.agent;
  if (!api?.replyConfirmWrite) return;
  void api.replyConfirmWrite({ id, allow });
}

function showCard(request: ConfirmRequest): void {
  ensureStyles();
  activeCard?.dismiss();
  const mask = document.createElement('div');
  mask.className = 'acw-confirm-mask';
  mask.id = 'acwConfirmMask';
  mask.innerHTML = `
    <div class="acw-confirm-card" role="dialog" aria-modal="true" aria-label="智能体写操作确认">
      <div class="acw-confirm-head">
        <b>${escapeHtml(request.title ?? '智能体请求写操作')}</b>
        <span class="acw-confirm-tool">${escapeHtml(request.tool)}</span>
      </div>
      <div class="acw-confirm-body">
        <p>${escapeHtml(request.detail ?? '该操作会修改当前装配体。')}</p>
        ${request.steps && request.steps.length > 0
          ? `<ol class="acw-confirm-steps">${request.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
          : `<pre class="acw-confirm-args">${escapeHtml(request.summary)}</pre>`}
        ${request.bypassNotice ? `<div class="acw-confirm-warn">${escapeHtml(request.bypassNotice)}</div>` : ''}
      </div>
      <div class="acw-confirm-foot">
        <span class="acw-confirm-hint">120 秒不答复按拒绝处理</span>
        <button type="button" class="acw-confirm-btn danger" data-acw="deny">拒绝</button>
        <button type="button" class="acw-confirm-btn primary" data-acw="once">${request.steps && request.steps.length > 0 ? '全部允许' : '允许一次'}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  let settled = false;
  const dismiss = (): void => {
    if (settled) return;
    settled = true;
    mask.remove();
    document.removeEventListener('keydown', onKey, true);
    if (activeCard?.id === request.id) activeCard = null;
  };
  const close = (allow: boolean): void => {
    if (settled) return;
    dismiss();
    reply(request.id, allow);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(false);
    }
  };
  activeCard = { id: request.id, dismiss };
  document.addEventListener('keydown', onKey, true);
  mask.querySelector<HTMLElement>('[data-acw="deny"]')?.addEventListener('click', () => close(false));
  mask.querySelector<HTMLElement>('[data-acw="once"]')?.addEventListener('click', () => close(true));
  mask.querySelector<HTMLElement>('[data-acw="deny"]')?.focus();
}

/** 安装监听（幂等）。必须在智能体面板初始化后调用一次。 */
export function installAgentConfirmCard(): void {
  const api = window.desktop?.agent;
  if (!api?.onConfirmWrite) return;
  if (disposeListener) return;
  disposeListener = api.onConfirmWrite((payload) => {
    if (!payload || typeof payload !== 'object') return;
    const request = payload as ConfirmRequest & { dismiss?: boolean };
    if (typeof request.id !== 'string') return;
    if (request.dismiss === true) {
      if (activeCard?.id === request.id) activeCard.dismiss();
    } else if (typeof request.tool === 'string') {
      showCard({ ...request, summary: request.summary ?? '{}' });
    }
  });
}
