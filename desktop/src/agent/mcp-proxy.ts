import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requiresWriteConfirmation } from './router.ts';
import { isWriteOperationId } from './write-operations.ts';
import { assertSafeApiKeyUrl } from '../shared/api-key-transport.ts';
import type { AgentToolSummary } from './tools.ts';

export interface DesktopRpcProxyOptions {
  userDataDir?: string;
  host?: string;
  port?: number;
  tokenFile?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DesktopToolResult {
  structuredContent?: unknown;
  content?: unknown;
  isError: boolean;
}

/** 桌面进程不可达：MCP 侧可据此降级到只读 registry。 */
export class DesktopRpcUnavailableError extends Error {
  readonly code = 'DESKTOP_NOT_RUNNING';

  constructor(message = '无法连接 AutomationCAD 桌面应用') {
    super(message);
    this.name = 'DesktopRpcUnavailableError';
  }
}

/** 桌面进程可达但 RPC 返回了业务或鉴权错误。 */
export class DesktopRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopRpcError';
    this.code = code;
  }
}

export class DesktopWriteOutcomeUnknownError extends Error {
  readonly code = 'WRITE_OUTCOME_UNKNOWN';

  readonly operationId: string;

  constructor(operationId: string) {
    super('未收到写操作回执。请使用原操作 ID 查询结果，不要自动重试。');
    this.operationId = operationId;
    this.name = 'DesktopWriteOutcomeUnknownError';
  }
}

export function defaultUserDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'AutomationCAD');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'AutomationCAD');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'AutomationCAD');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultFromPayload(payload: unknown): DesktopToolResult {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    const rpcError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof rpcError?.message === 'string' ? rpcError.message : '桌面 RPC 返回格式不合法';
    throw new DesktopRpcError('DESKTOP_RPC_ERROR', message);
  }
  const result = payload.result;
  let structuredContent = result.structuredContent;
  if (structuredContent === undefined && Array.isArray(result.content)) {
    const text = result.content.find((item) => isRecord(item) && item.type === 'text');
    if (isRecord(text) && typeof text.text === 'string') {
      try {
        structuredContent = JSON.parse(text.text) as unknown;
      } catch {
        structuredContent = text.text;
      }
    }
  }
  return {
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(result.content !== undefined ? { content: result.content } : {}),
    isError: result.isError === true
  };
}

export class DesktopRpcProxy {
  private readonly userDataDir: string;
  private readonly host: string;
  private readonly port: number;
  private readonly tokenFileOverride: string | undefined;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DesktopRpcProxyOptions = {}) {
    this.userDataDir = options.userDataDir ?? defaultUserDataDir();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7420;
    this.tokenFileOverride = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.writeTimeoutMs = options.timeoutMs ?? 135_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get tokenFile(): string {
    return this.tokenFileOverride ?? join(this.userDataDir, 'agent-token');
  }

  private readToken(): string {
    let token: string;
    try {
      token = readFileSync(this.tokenFile, 'utf8').trim();
    } catch {
      throw new DesktopRpcUnavailableError('连接凭据不存在：AutomationCAD 桌面应用的 agent-token（请先启动桌面应用）');
    }
    if (!token) {
      throw new DesktopRpcUnavailableError('AutomationCAD 桌面应用尚未就绪');
    }
    return token;
  }

  private async requestPayload(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; operationId?: string } = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    const token = this.readToken();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = (): void => {
      controller.abort();
      rejectCancellation?.(new DesktopRpcError('REQUEST_CANCELLED', '请求已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DesktopRpcUnavailableError('连接 AutomationCAD 桌面应用超时'));
        }, options.operationId ? this.writeTimeoutMs : this.timeoutMs);
      });
      const operation = (async (): Promise<unknown> => {
        const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
        const url = new URL(`http://${host}:${this.port}/rpc`);
        assertSafeApiKeyUrl(url, 'desktop RPC host');
        const id = randomUUID();
        const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        dispatched = true;
        const response = await this.fetchImpl(url.href, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body,
          redirect: 'error',
          signal: controller.signal
        });

        if (response.status === 401) {
          throw new DesktopRpcError('DESKTOP_RPC_UNAUTHORIZED', '桌面 RPC 鉴权失败，请重启 AutomationCAD 后重试');
        }
        if (response.status === 403) {
          throw new DesktopRpcError('DESKTOP_RPC_FORBIDDEN', '桌面 RPC 拒绝了访问');
        }
        if (!response.ok) {
          throw new DesktopRpcError('DESKTOP_RPC_HTTP_ERROR', `桌面 RPC 返回错误：HTTP ${response.status}`);
        }

        let payload: unknown;
        try {
          payload = await response.json() as unknown;
        } catch {
          throw new DesktopRpcError('DESKTOP_RPC_ERROR', '桌面 RPC 返回的不是合法 JSON');
        }
        if (isRecord(payload) && isRecord(payload.error)) {
          throw new DesktopRpcError(
            String(payload.error.code ?? 'DESKTOP_RPC_ERROR'),
            typeof payload.error.message === 'string' ? payload.error.message : '桌面 RPC 调用失败'
          );
        }
        if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== id || !isRecord(payload.result)) {
          throw new DesktopRpcError('DESKTOP_RPC_ERROR', '桌面 RPC 返回格式不合法');
        }
        return payload;
      })();
      return await Promise.race([operation, timeout, cancellation]);
    } catch (error) {
      if (dispatched && options.operationId && !(error instanceof DesktopRpcError &&
        ['DESKTOP_RPC_UNAUTHORIZED', 'DESKTOP_RPC_FORBIDDEN', '-32601', '-32602'].includes(error.code))) {
        throw new DesktopWriteOutcomeUnknownError(options.operationId);
      }
      if (error instanceof DesktopRpcUnavailableError || error instanceof DesktopRpcError) throw error;
      const aborted = isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (aborted) {
        throw new DesktopRpcUnavailableError('连接 AutomationCAD 桌面应用超时');
      }
      throw new DesktopRpcUnavailableError('无法连接 AutomationCAD 桌面应用');
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async listTools(): Promise<AgentToolSummary[]> {
    const payload = await this.requestPayload('tools/list', {});
    if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
      throw new DesktopRpcError('DESKTOP_RPC_ERROR', '桌面 RPC 工具清单格式不合法');
    }
    return payload.result.tools.flatMap((entry): AgentToolSummary[] => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.description !== 'string' || !isRecord(entry.inputSchema)) {
        return [];
      }
      return [{ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }];
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal; operationId?: string } = {}): Promise<DesktopToolResult> {
    const operationId = requiresWriteConfirmation(name) ? options.operationId ?? randomUUID() : undefined;
    if (operationId && !isWriteOperationId(operationId)) throw new DesktopRpcError('INVALID_WRITE_OPERATION_ID', '写操作 ID 格式无效');
    return resultFromPayload(await this.requestPayload('tools/call', { name, arguments: args, ...(operationId ? { operationId } : {}) }, {
      ...(options.signal ? { signal: options.signal } : {}), ...(operationId ? { operationId } : {})
    }));
  }

  async operationStatus(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!isWriteOperationId(operationId)) throw new DesktopRpcError('INVALID_WRITE_OPERATION_ID', '写操作 ID 格式无效');
    const payload = await this.requestPayload('operations/status', { operationId }, signal ? { signal } : {});
    if (!isRecord(payload) || !isRecord(payload.result)) throw new DesktopRpcError('DESKTOP_RPC_ERROR', '写操作状态格式无效');
    return payload.result;
  }
}
