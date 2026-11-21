import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { ConfirmationQueue } from '../src/agent/confirmation-queue.ts';
import { isTrustedIpcSender, isTrustedUiUrl } from './security.ts';

export const WRITE_CONFIRM_TIMEOUT_MS = 120_000;
export const WRITE_CONFIRM_TIMEOUT_CODE = 'CONFIRMATION_TIMEOUT' as const;

export interface WriteConfirmRequest {
  trustedUiPath: string;
  signal?: AbortSignal;
  tool: string;
  args: unknown;
  detail?: string;
  bypassNotice?: string;
  title?: string;
  steps?: string[];
}

type ConfirmationResult = { allow: boolean; reason: 'allowed' | 'denied' | 'timeout' | 'unavailable' };
const queues = new WeakMap<BrowserWindow, ConfirmationQueue>();
const unavailable: ConfirmationResult = { allow: false, reason: 'unavailable' };

export async function requestWriteConfirmation(
  window: BrowserWindow | null,
  request: WriteConfirmRequest
): Promise<boolean> {
  return (await requestWriteConfirmationResult(window, request)).allow;
}

export async function requestWriteConfirmationResult(
  window: BrowserWindow | null,
  request: WriteConfirmRequest
): Promise<ConfirmationResult> {
  if (!window || window.isDestroyed() || request.signal?.aborted) return unavailable;
  const contents = window.webContents;
  const frame = contents.mainFrame;
  if (contents.isDestroyed() || !frame || !isTrustedUiUrl(frame.url, request.trustedUiPath)) return unavailable;
  const lifetime = new AbortController();
  const deadline = AbortSignal.timeout(WRITE_CONFIRM_TIMEOUT_MS);
  const signal = AbortSignal.any([deadline, lifetime.signal, ...(request.signal ? [request.signal] : [])]);
  const invalidate = (): void => lifetime.abort();
  const onNavigation = (event: Electron.Event & { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (event.isMainFrame && !event.isSameDocument) invalidate();
  };
  contents.on('did-start-navigation', onNavigation);
  contents.once('render-process-gone', invalidate);
  contents.once('destroyed', invalidate);
  try {
    let queue = queues.get(window);
    if (!queue) {
      queue = new ConfirmationQueue();
      queues.set(window, queue);
    }
    const result = await queue.submit(signal, unavailable, () => {
      if (contents.isDestroyed() || contents.mainFrame !== frame || !isTrustedUiUrl(frame.url, request.trustedUiPath)) {
        return Promise.resolve(unavailable);
      }
      const id = randomUUID();
      const serialized = JSON.stringify(request.args ?? {});
      const summary = serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized;
      return new Promise<ConfirmationResult>((resolve) => {
        let settled = false;
        const finish = (value: ConfirmationResult): void => {
          if (settled) return;
          settled = true;
          ipcMain.removeListener('agent:confirm-write:reply', onReply);
          signal.removeEventListener('abort', onAbort);
          if (!contents.isDestroyed() && !lifetime.signal.aborted) {
            try { contents.send('agent:confirm-write:request', { id, dismiss: true }); } catch { /* window closed */ }
          }
          resolve(value);
        };
        const onAbort = (): void => finish(unavailable);
        const onReply = (event: Electron.IpcMainEvent, payload: unknown): void => {
          if (signal.aborted || contents.isDestroyed() || event.senderFrame !== frame ||
              !isTrustedIpcSender(event, contents.id, request.trustedUiPath)) return;
          if (typeof payload !== 'object' || payload === null) return;
          const record = payload as { id?: unknown; allow?: unknown };
          if (record.id !== id || typeof record.allow !== 'boolean') return;
          finish({ allow: record.allow, reason: record.allow ? 'allowed' : 'denied' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        ipcMain.on('agent:confirm-write:reply', onReply);
        try {
          contents.send('agent:confirm-write:request', {
            id,
            tool: request.tool,
            summary,
            detail: request.detail ?? '该操作会修改当前装配体。',
            bypassNotice: request.bypassNotice,
            title: request.title ?? '智能体请求写操作',
            ...(request.steps?.length ? { steps: request.steps } : {})
          });
        } catch {
          finish(unavailable);
        }
      });
    });
    return result.reason === 'unavailable' && deadline.aborted ? { allow: false, reason: 'timeout' } : result;
  } finally {
    contents.removeListener('did-start-navigation', onNavigation);
    contents.removeListener('render-process-gone', invalidate);
    contents.removeListener('destroyed', invalidate);
  }
}
