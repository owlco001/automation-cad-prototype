import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  private readonly fetchImpl: typeof fetch;

  constructor(options: DesktopRpcProxyOptions = {}) {
    this.userDataDir = options.userDataDir ?? defaultUserDataDir();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7420;
    this.tokenFileOverride = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? 10_000;
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

  private async requestPayload(method: string, params: Record<string, unknown>): Promise<unknown> {
    const token = this.readToken();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DesktopRpcUnavailableError('连接 AutomationCAD 桌面应用超时'));
        }, this.timeoutMs);
      });
      const operation = (async (): Promise<unknown> => {
        const response = await this.fetchImpl(`http://${this.host}:${this.port}/rpc`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method,
            params
          }),
          signal: controller.signal
        });

        if (response.status === 401) {
          throw new DesktopRpcError('DESKTOP_RPC_UNAUTHORIZED', '桌面 RPC 鉴权失败，请重启 AutomationCAD 后重试');
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
        if (!isRecord(payload) || !isRecord(payload.result)) {
          throw new DesktopRpcError('DESKTOP_RPC_ERROR', '桌面 RPC 返回格式不合法');
        }
        return payload;
      })();
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof DesktopRpcUnavailableError || error instanceof DesktopRpcError) throw error;
      const aborted = isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (aborted) {
        throw new DesktopRpcUnavailableError('连接 AutomationCAD 桌面应用超时');
      }
      throw new DesktopRpcUnavailableError('无法连接 AutomationCAD 桌面应用');
    } finally {
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

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<DesktopToolResult> {
    return resultFromPayload(await this.requestPayload('tools/call', { name, arguments: args }));
  }
}
