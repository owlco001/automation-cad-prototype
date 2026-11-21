import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { requiresWriteConfirmation } from './router.ts';
import { isWriteOperationId, WriteOperations } from './write-operations.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentTools } from './tools';
import { authorizeAgentToolCall, type ConfirmAgentToolWrite } from './policy.ts';
import type { AgentAuditRecord } from './audit.ts';
import {
  isAddressAllowed,
  isLoopbackAddress,
  normalizeRemoteAddress
} from '../shared/lan-access.ts';

export interface AgentRpcOptions {
  tools: AgentTools;
  token: string;
  version: string;
  host?: string;
  port?: number;
  confirmWrite?: ConfirmAgentToolWrite;
  lanEnabled?: boolean;
  allowlist?: string[];
  cdpPort?: number | null;
  /** 主进程缓存的最新渲染指标；/health 读取时按调用取快照。 */
  renderStats?: () => unknown;
  /** 当前视口零件清单（MCP resources 用）；主进程注入，失败返回空数组。 */
  sceneParts?: () => Promise<unknown> | unknown;
  audit?: (record: AgentAuditRecord) => void;
  /**
   * 覆盖来源地址解析。默认取 `request.socket.remoteAddress`；
   * 测试注入固定地址，避免依赖「拨号本机网卡 IP 时对端到底报什么」这种平台差异
   * （Windows 上拨自己的局域网 IP 可能被系统短路成回环）。
   */
  resolveRemoteAddress?: (request: IncomingMessage) => string | undefined;
}

export interface AgentRpcInfo {
  host: string;
  port: number;
  url: string;
  tokenFile?: string;
}

export interface AgentRpcAccessConfig {
  lanEnabled: boolean;
  allowlist: string[];
  cdpPort: number | null;
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

/** 只读资源清单（MCP resources/list）。URI 固定，读不到就是空集，不猜。 */
const RESOURCE_LIST = [
  {
    uri: 'automationcad://project/current/summary',
    name: '当前工程摘要',
    description: '设计域/视图/选中对象/机型概要/底板/单位制/最近操作（get_project_context 同源）',
    mimeType: 'application/json'
  },
  {
    uri: 'automationcad://project/current/parts',
    name: '当前视口零件清单',
    description: '零件名 + 三角面数 + 包围盒；视口为空时返回 []',
    mimeType: 'application/json'
  },
  {
    uri: 'automationcad://project/current/bom',
    name: '当前工程 BOM',
    description: '与 get_bom 工具同源；缺价/缺型号照实标注',
    mimeType: 'application/json'
  }
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CallAccess {
  remoteAddress: string;
  origin: 'local' | 'lan';
  signal: AbortSignal;
  generation: number;
}

function writeScope(access: CallAccess): string {
  return `${access.generation}:${access.remoteAddress}`;
}

export class AgentRpcServer {
  readonly tools: AgentTools;
  private readonly writeOperations = new WriteOperations();
  private authGeneration = 0;
  private generationAbort = new AbortController();
  private tokenValue: string;
  readonly version: string;
  readonly port: number;
  readonly confirmWrite: ConfirmAgentToolWrite | undefined;
  private hostValue: string;
  private lanEnabledValue: boolean;
  private allowlistValue: string[];
  private cdpPortValue: number | null;
  private readonly renderStats: (() => unknown) | undefined;
  private readonly sceneParts: (() => Promise<unknown> | unknown) | undefined;
  private readonly audit: ((record: AgentAuditRecord) => void) | undefined;
  private readonly resolveRemoteAddress: ((request: IncomingMessage) => string | undefined) | undefined;
  private server: Server | null = null;
  private actualPort = 0;
  private tokenFile: string | undefined;

  constructor(options: AgentRpcOptions) {
    this.tools = options.tools;
    this.tokenValue = options.token;
    this.version = options.version;
    this.hostValue = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7420;
    this.confirmWrite = options.confirmWrite;
    this.lanEnabledValue = options.lanEnabled === true;
    this.allowlistValue = [...(options.allowlist ?? [])];
    this.cdpPortValue = options.cdpPort ?? null;
    this.renderStats = options.renderStats;
    this.sceneParts = options.sceneParts;
    this.audit = options.audit;
    this.resolveRemoteAddress = options.resolveRemoteAddress;
  }

  get host(): string {
    return this.hostValue;
  }

  get token(): string {
    return this.tokenValue;
  }

  /** token 轮换只换鉴权值；HTTP 监听仍由 restart 负责重建。 */
  setToken(token: string): void {
    if (this.tokenValue !== token) {
      this.authGeneration += 1;
      this.generationAbort.abort();
      this.generationAbort = new AbortController();
    }
    this.tokenValue = token;
  }

  async start(tokenFile?: string): Promise<AgentRpcInfo> {
    if (this.server) return this.info(tokenFile);
    if (tokenFile !== undefined) this.tokenFile = tokenFile;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        this.server!.once('error', fail);
        this.server!.listen(this.port, this.hostValue, () => {
          this.server!.off('error', fail);
          resolve();
        });
      });
    } catch (error) {
      const server = this.server;
      this.server = null;
      this.actualPort = 0;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(agentListenError(error, this.hostValue, this.port));
    }
    const address = this.server.address() as AddressInfo;
    this.actualPort = address.port;
    return this.info(tokenFile);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.actualPort = 0;
  }

  /**
   * 关闭旧 server 后在同一端口监听新地址；失败时尝试恢复旧地址，避免把本机服务留成停止态。
   * 端口被其它进程占用时抛中文错误，由 IPC 返回 UI 展示。
   */
  async restart(host: string, access?: Partial<AgentRpcAccessConfig>): Promise<AgentRpcInfo> {
    const previousHost = this.hostValue;
    await this.stop();
    this.hostValue = host;
    if (access?.lanEnabled !== undefined) this.lanEnabledValue = access.lanEnabled;
    if (access?.allowlist !== undefined) this.allowlistValue = [...access.allowlist];
    if (access?.cdpPort !== undefined) this.cdpPortValue = access.cdpPort;
    try {
      return await this.start();
    } catch (error) {
      this.hostValue = previousHost;
      let rollback = '';
      try {
        await this.start();
      } catch (rollbackError) {
        rollback = `；恢复旧监听也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}${rollback}`);
    }
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

  private requestAccess(request: IncomingMessage): { remoteAddress: string; origin: 'local' | 'lan'; allowed: boolean } {
    const remoteAddress = normalizeRemoteAddress(
      this.resolveRemoteAddress?.(request) ?? request.socket.remoteAddress
    );
    const allowed = isAddressAllowed(remoteAddress, this.allowlistValue);
    return {
      remoteAddress,
      origin: isLoopbackAddress(remoteAddress) ? 'local' : 'lan',
      allowed
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      const access = this.requestAccess(request);
      if (!access.allowed) {
        this.audit?.({
          tool: 'lan_access_check',
          ok: false,
          code: 'LAN_NOT_ALLOWED',
          source: 'rpc',
          args: { path: url.pathname },
          message: `来源地址不在白名单：${access.remoteAddress || '(未知)'}`,
          remoteAddress: access.remoteAddress,
          origin: access.origin
        });
        sendJson(response, 403, { ok: false, error: 'LAN_NOT_ALLOWED' });
        return;
      }
      if (!tokenMatches(request.headers.authorization, this.tokenValue)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          version: this.version,
          toolCount: this.tools.list().length,
          host: this.host,
          port: this.actualPort || this.port,
          lanEnabled: this.lanEnabledValue,
          allowlist: [...this.allowlistValue],
          cdpPort: this.cdpPortValue,
          render: this.renderStats?.() ?? null
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/rpc') {
        const controller = new AbortController();
        const onDisconnect = (): void => controller.abort();
        response.once('close', onDisconnect);
        if (response.destroyed) onDisconnect();
        const requestSignal = AbortSignal.any([controller.signal, this.generationAbort.signal]);
        const callAccess = { ...access, signal: requestSignal, generation: this.authGeneration };
        try {
          const body = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body) as unknown;
          } catch {
            sendJson(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
            return;
          }
          const result = Array.isArray(parsed)
            ? await Promise.all(parsed.map((item) => this.handleRpc(item, callAccess)))
            : await this.handleRpc(parsed, callAccess);
          if (!controller.signal.aborted) sendJson(response, 200, result);
        } finally {
          response.off('close', onDisconnect);
        }
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

  private async handleRpc(
    payload: unknown,
    access: CallAccess
  ): Promise<unknown> {
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
      } else if (payload.method === 'resources/list') {
        result = { resources: RESOURCE_LIST };
      } else if (payload.method === 'resources/read') {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        result = await this.readResource(uri);
      } else if (payload.method === 'operations/status') {
        if (!isWriteOperationId(params.operationId)) throw new RpcError(-32602, '写操作 ID 格式无效');
        result = this.writeOperations.status(writeScope(access), params.operationId);
      } else if (payload.method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!this.tools.has(name)) throw new RpcError(-32601, `工具不存在：${name || '(空)'}`);
        const args = isRecord(params.arguments) ? params.arguments : {};
        let operationId: string | undefined;
        if (params.operationId !== undefined && requiresWriteConfirmation(name)) {
          if (!isWriteOperationId(params.operationId)) throw new RpcError(-32602, '写操作 ID 格式无效');
          operationId = params.operationId;
        }
        const toolResult = await this.callTool(name, args, access, operationId);
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
          structuredContent: toolResult,
          isError: isRecord(toolResult) && toolResult.ok === false
        };
      } else if (this.tools.has(payload.method)) {
        result = await this.callTool(payload.method, params, access);
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

  /**
   * MCP resources：让外部 Agent 先读后写。
   * 只暴露只读投影（工程摘要 / 零件清单 / BOM），不暴露可写句柄；读不到时如实返回空集，不编。
   */
  private async readResource(uri: string): Promise<unknown> {
    if (!RESOURCE_LIST.some((item) => item.uri === uri)) {
      throw new RpcError(-32602, `资源不存在：${uri || '(空)'}`);
    }
    let payload: unknown = null;
    if (uri === 'automationcad://project/current/summary') {
      payload = await this.tools.call('get_project_context', {});
    } else if (uri === 'automationcad://project/current/parts') {
      payload = typeof this.sceneParts === 'function' ? await this.sceneParts() : [];
    } else if (uri === 'automationcad://project/current/bom') {
      payload = await this.tools.call('get_bom', {});
    }
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload ?? null)
      }]
    };
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    access: CallAccess,
    operationId?: string
  ): Promise<unknown> {
    const started = Date.now();
    const execute = async (markExecuting: () => void) => {
      const cancelled = () => ({
        result: { ok: false, code: 'WRITE_CANCELLED', message: '写操作在执行前取消。', ...(operationId ? { operationId } : {}) },
        state: 'cancelled' as const
      });
      if (access.signal.aborted || this.authGeneration !== access.generation) return cancelled();
      const authorization = await authorizeAgentToolCall(name, args, this.confirmWrite, access.signal);
      if (access.signal.aborted || this.authGeneration !== access.generation) return cancelled();
      let result: unknown = authorization;
      if (authorization.ok) {
        markExecuting();
        // Once writing starts, do not pretend abort can roll back side effects.
        result = await this.tools.call(name, args, requiresWriteConfirmation(name) ? undefined : access.signal);
      }
      const record = isRecord(result) ? result : null;
      try {
        this.audit?.({
          tool: name,
          ok: record?.ok !== false,
          ...(typeof record?.code === 'string' ? { code: record.code } : {}),
          source: 'rpc',
          args,
          ...(typeof record?.message === 'string' ? { message: record.message } : {}),
          elapsedMs: Date.now() - started,
          remoteAddress: access.remoteAddress,
          origin: access.origin
        });
      } catch (error) {
        console.error('[AGENT_AUDIT_FAILED]', error);
      }
      return { result, state: 'finished' as const };
    };
    return operationId
      ? await this.writeOperations.run(writeScope(access), operationId, name, args, execute)
      : (await execute(() => {})).result;
  }
}

function agentListenError(error: unknown, host: string, port: number): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'EADDRINUSE') {
    return `Agent 端口被占用：${host}:${port} 无法监听。请关闭占用 ${port} 端口的程序后重试。`;
  }
  return `Agent 服务启动失败（${host}:${port}）：${detail}`;
}

/** 主进程热重启入口；保留显式函数名，方便测试与 UI 调用链定位。 */
export async function restartAgentServer(
  server: AgentRpcServer,
  host: string,
  access?: Partial<AgentRpcAccessConfig>
): Promise<AgentRpcInfo> {
  return await server.restart(host, access);
}

export function createAgentToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  while (token.length < 48) {
    for (const byte of randomBytes(48)) {
      // 248 = 62 * 4：拒绝采样，避免 256 % 62 带来的字符分布偏斜。
      if (byte >= 248) continue;
      token += alphabet[byte % alphabet.length];
      if (token.length === 48) break;
    }
  }
  return token;
}

export const AGENT_TOKEN_PATTERN = /^[A-Za-z0-9]{48}$/;

export function isValidAgentToken(value: unknown): value is string {
  return typeof value === 'string' && AGENT_TOKEN_PATTERN.test(value);
}

function agentTokenPath(userDataDir: string): string {
  return join(userDataDir, 'agent-token');
}

/** 原子写 0600：临时文件 + rename，避免进程在写一半时留下半截 token。 */
function writeAgentTokenFile(userDataDir: string, token: string): string {
  const tokenFile = join(userDataDir, 'agent-token');
  mkdirSync(userDataDir, { recursive: true });
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, token, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, tokenFile);
    chmodSync(tokenFile, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`写入 Agent token 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return tokenFile;
}

/** 启动时优先复用合法 token；文件缺失/损坏时重建，重启不再让已连接的客户端失效。 */
export function loadOrCreateAgentTokenFile(userDataDir: string): { token: string; tokenFile: string } {
  const tokenFile = agentTokenPath(userDataDir);
  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      if (isValidAgentToken(token)) {
        try { chmodSync(tokenFile, 0o600); } catch { /* Windows/受管目录可能拒绝 chmod，不影响鉴权 */ }
        return { token, tokenFile };
      }
    } catch {
      // 读失败按损坏处理，下面重建。
    }
  }
  const token = createAgentToken();
  return { token, tokenFile: writeAgentTokenFile(userDataDir, token) };
}

/** 面板「重新生成 token」入口：强制换新并返回，旧 token 立即失效。 */
export function rotateAgentToken(userDataDir: string): { token: string; tokenFile: string } {
  const token = createAgentToken();
  return { token, tokenFile: writeAgentTokenFile(userDataDir, token) };
}

/** 兼容旧测试/调用：总是生成新 token。主进程启动改用 loadOrCreateAgentTokenFile。 */
export function createAgentTokenFile(userDataDir: string): { token: string; tokenFile: string } {
  const token = createAgentToken();
  return { token, tokenFile: writeAgentTokenFile(userDataDir, token) };
}
