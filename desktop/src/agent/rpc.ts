import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentTools } from './tools';
import { authorizeAgentToolCall, type ConfirmAgentToolWrite } from './policy.ts';

export interface AgentRpcOptions {
  tools: AgentTools;
  token: string;
  version: string;
  host?: string;
  port?: number;
  confirmWrite?: ConfirmAgentToolWrite;
}

export interface AgentRpcInfo {
  host: string;
  port: number;
  url: string;
  tokenFile?: string;
}

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RpcError(-32600, '请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AgentRpcServer {
  readonly tools: AgentTools;
  readonly token: string;
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly confirmWrite: ConfirmAgentToolWrite | undefined;
  private server: Server | null = null;
  private actualPort = 0;
  private tokenFile: string | undefined;

  constructor(options: AgentRpcOptions) {
    this.tools = options.tools;
    this.token = options.token;
    this.version = options.version;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7420;
    this.confirmWrite = options.confirmWrite;
  }

  async start(tokenFile?: string): Promise<AgentRpcInfo> {
    if (this.server) return this.info(tokenFile);
    this.tokenFile = tokenFile;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.actualPort = address.port;
    return this.info(tokenFile);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  info(tokenFile?: string): AgentRpcInfo {
    const file = tokenFile ?? this.tokenFile;
    return {
      host: this.host,
      port: this.actualPort || this.port,
      url: `http://${this.host}:${this.actualPort || this.port}`,
      ...(file ? { tokenFile: file } : {})
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      if (!tokenMatches(request.headers.authorization, this.token)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          version: this.version,
          toolCount: this.tools.list().length,
          tools: this.tools.list().map((tool) => tool.name)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/rpc') {
        const body = await readBody(request);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          sendJson(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
          return;
        }
        if (Array.isArray(parsed)) {
          const results = await Promise.all(parsed.map((item) => this.handleRpc(item)));
          sendJson(response, 200, results);
          return;
        }
        sendJson(response, 200, await this.handleRpc(parsed));
        return;
      }

      sendJson(response, 404, { ok: false, error: '接口不存在' });
    } catch (error) {
      const status = error instanceof RpcError && error.code === -32600 ? 413 : 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleRpc(payload: unknown): Promise<unknown> {
    const id = isRecord(payload) && (payload.id === null || typeof payload.id === 'string' || typeof payload.id === 'number')
      ? payload.id
      : null;
    if (!isRecord(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: '请求格式不合法' } };
    }
    try {
      const params = isRecord(payload.params) ? payload.params : {};
      let result: unknown;
      if (payload.method === 'tools/list') {
        result = { tools: this.tools.summaries() };
      } else if (payload.method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!this.tools.has(name)) throw new RpcError(-32601, `工具不存在：${name || '(空)'}`);
        const args = isRecord(params.arguments) ? params.arguments : {};
        const toolResult = await this.callTool(name, args);
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
          structuredContent: toolResult,
          isError: isRecord(toolResult) && toolResult.ok === false
        };
      } else if (this.tools.has(payload.method)) {
        result = await this.callTool(payload.method, params);
      } else {
        throw new RpcError(-32601, `方法不存在：${payload.method}`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const rpcError = error instanceof RpcError
        ? error
        : new RpcError(-32000, error instanceof Error ? error.message : String(error));
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data !== undefined ? { data: rpcError.data } : {})
        }
      };
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const authorization = await authorizeAgentToolCall(name, args, this.confirmWrite);
    if (!authorization.ok) return authorization;
    return await this.tools.call(name, args);
  }
}

export function createAgentToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createAgentTokenFile(userDataDir: string): { token: string; tokenFile: string } {
  const token = createAgentToken();
  const tokenFile = join(userDataDir, 'agent-token');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return { token, tokenFile };
}
