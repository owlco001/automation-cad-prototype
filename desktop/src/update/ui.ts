import type { UpdateChannel, UpdateSnapshot } from '../../electron/update-service';

const STYLE_ID = 'automation-cad-update-style';
const BUTTON_ID = 'automationCadUpdateButton';
const DIALOG_ID = 'automationCadUpdateDialog';

export interface UpdatePanelHandle {
  setEnabled(enabled: boolean): void;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID}[hidden]{display:none!important}
    #${DIALOG_ID}{width:min(460px,calc(100vw - 32px));border:1px solid #3a4148;border-radius:12px;padding:0;background:#20252a;color:#e9eef2;box-shadow:0 24px 80px #0009}
    #${DIALOG_ID}::backdrop{background:#080a0dcc;backdrop-filter:blur(2px)}
    .ac-update-head{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 22px 14px;border-bottom:1px solid #353c42}
    .ac-update-title{font-size:16px;font-weight:650}.ac-update-sub{margin-top:5px;color:#9ba6ad;font-size:12px}
    .ac-update-close{border:0;background:transparent;color:#aeb8be;font-size:20px;cursor:pointer}
    .ac-update-body{padding:18px 22px 22px}.ac-update-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;font-size:13px}
    .ac-update-row label{color:#aeb8be}.ac-update-row select{min-width:150px;padding:7px 9px;border:1px solid #454e56;border-radius:6px;background:#171b1f;color:#eef2f4}
    .ac-update-status{min-height:42px;margin:12px 0 8px;color:#d9e1e5;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
    .ac-update-version{margin:0 0 14px;color:#aeb8be;font-size:12px}.ac-update-progress{width:100%;height:7px;margin:2px 0 7px;accent-color:#29b6a3}
    .ac-update-progress-label{min-height:17px;color:#9ba6ad;font-size:11px;text-align:right}
    .ac-update-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.ac-update-actions button{padding:8px 12px;border:1px solid #414a51;border-radius:6px;background:#282e33;color:#dce3e7;font-size:12px;cursor:pointer}
    .ac-update-actions button:hover:not(:disabled){border-color:#29b6a3;color:#fff}.ac-update-actions button:disabled{opacity:.5;cursor:not-allowed}
    .ac-update-actions .primary{border-color:#168f82;background:#127b71;color:#fff}.ac-update-actions .primary:hover:not(:disabled){background:#169486}
  `;
  document.head.appendChild(style);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function initUpdatePanel(): UpdatePanelHandle {
  const api = window.desktop?.update;
  const toolbar = document.querySelector<HTMLElement>('.tb-right');
  if (!api || !toolbar) return { setEnabled: () => undefined };

  let entry: HTMLButtonElement | null = null;
  let dialog: HTMLDialogElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let enabled = false;
  let renderState: ((state: UpdateSnapshot) => void) | null = null;

  const ensureElements = (): void => {
    if (entry && dialog) return;
    installStyles();
    entry = document.createElement('button');
    entry.id = BUTTON_ID;
    entry.type = 'button';
    entry.className = 'tbtn';
    entry.textContent = '软件更新';
    entry.title = '检查 AutomationCAD 更新';
    const domainSwitch = toolbar.querySelector<HTMLElement>('#domsw');
    toolbar.insertBefore(entry, domainSwitch ?? null);

    dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.innerHTML = `
      <header class="ac-update-head">
        <div><div class="ac-update-title">AutomationCAD 软件更新</div><div class="ac-update-sub">更新需手动下载；安装前再次确认</div></div>
        <button type="button" class="ac-update-close" aria-label="关闭">×</button>
      </header>
      <section class="ac-update-body">
        <div class="ac-update-row"><label for="acUpdateChannel">更新渠道</label><select id="acUpdateChannel"><option value="stable">稳定版 stable</option><option value="beta">测试版 beta</option></select></div>
        <div class="ac-update-version" id="acUpdateVersion"></div>
        <div class="ac-update-status" id="acUpdateStatus" role="status" aria-live="polite">正在读取更新状态…</div>
        <progress class="ac-update-progress" id="acUpdateProgress" max="100" value="0" hidden></progress>
        <div class="ac-update-progress-label" id="acUpdateProgressLabel"></div>
        <div class="ac-update-actions"><button type="button" id="acUpdateCheck">检查更新</button><button type="button" id="acUpdateDownload" class="primary" hidden>下载更新</button><button type="button" id="acUpdateInstall" class="primary" hidden>安装并重启…</button></div>
      </section>`;
    document.body.appendChild(dialog);

    const status = dialog.querySelector<HTMLElement>('#acUpdateStatus')!;
    const version = dialog.querySelector<HTMLElement>('#acUpdateVersion')!;
    const channel = dialog.querySelector<HTMLSelectElement>('#acUpdateChannel')!;
    const progress = dialog.querySelector<HTMLProgressElement>('#acUpdateProgress')!;
    const progressLabel = dialog.querySelector<HTMLElement>('#acUpdateProgressLabel')!;
    const check = dialog.querySelector<HTMLButtonElement>('#acUpdateCheck')!;
    const download = dialog.querySelector<HTMLButtonElement>('#acUpdateDownload')!;
    const install = dialog.querySelector<HTMLButtonElement>('#acUpdateInstall')!;
    const close = dialog.querySelector<HTMLButtonElement>('.ac-update-close')!;

    const render = (state: UpdateSnapshot): void => {
      channel.value = state.channel;
      version.textContent = state.availableVersion
        ? `当前版本 ${state.currentVersion} · 可用版本 ${state.availableVersion}`
        : `当前版本 ${state.currentVersion}`;
      status.textContent = state.releaseName ? `${state.message}\n${state.releaseName}` : state.message;
      const isBusy = state.status === 'checking' || state.status === 'downloading' || state.status === 'downloaded';
      channel.disabled = isBusy;
      check.disabled = isBusy || state.status === 'disabled';
      download.hidden = state.status !== 'available';
      download.disabled = state.status !== 'available';
      install.hidden = state.status !== 'downloaded';
      install.disabled = state.status !== 'downloaded';
      progress.hidden = state.status !== 'downloading';
      if (state.progress) {
        progress.value = state.progress.percent;
        progressLabel.textContent = `${state.progress.percent.toFixed(1)}% · ${formatBytes(state.progress.transferred)} / ${state.progress.total > 0 ? formatBytes(state.progress.total) : '总大小未知'}`;
      } else {
        progress.value = 0;
        progressLabel.textContent = '';
      }
    };
    renderState = render;

    entry.addEventListener('click', async () => {
      if (!enabled) return;
      try {
        render(await api.state());
        if (!dialog?.open) dialog?.showModal();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '读取更新状态失败。';
        if (!dialog?.open) dialog?.showModal();
      }
    });
    close.addEventListener('click', () => dialog?.close());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog?.close();
    });
    channel.addEventListener('change', async () => {
      if (!enabled) return;
      try {
        render(await api.setChannel(channel.value as UpdateChannel));
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '切换更新渠道失败。';
        try { render(await api.state()); } catch { /* Keep the error visible. */ }
      }
    });
    check.addEventListener('click', async () => {
      if (!enabled) return;
      check.disabled = true;
      try { render(await api.check()); }
      catch (error) { status.textContent = error instanceof Error ? error.message : '检查更新失败。'; }
    });
    download.addEventListener('click', async () => {
      if (!enabled) return;
      download.disabled = true;
      try { render(await api.download()); }
      catch (error) { status.textContent = error instanceof Error ? error.message : '下载更新失败。'; }
    });
    install.addEventListener('click', async () => {
      if (!enabled) return;
      install.disabled = true;
      try { render(await api.install()); }
      catch (error) { status.textContent = error instanceof Error ? error.message : '安装更新失败。'; }
    });
  };

  return {
    setEnabled(value: boolean): void {
      enabled = value;
      if (!value) {
        if (entry) entry.hidden = true;
        if (dialog?.open) dialog.close();
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      ensureElements();
      if (entry) entry.hidden = false;
      if (!unsubscribe) unsubscribe = api.onState((state) => renderState?.(state));
      void api.state().then((state) => renderState?.(state)).catch((error: unknown) => {
        const status = dialog?.querySelector<HTMLElement>('#acUpdateStatus');
        if (status) status.textContent = error instanceof Error ? error.message : '读取更新状态失败。';
      });
    }
  };
}
