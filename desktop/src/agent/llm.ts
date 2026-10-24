import type { AgentToolSummary } from './tools.ts';
import { normalizeBaseUrl } from './llm-config.ts';
import type { AgentLlmConfig } from './llm-config.ts';
import { assertSafeApiKeyUrl } from '../shared/api-key-transport.ts';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmChatResponse {
  content: string;
  toolCalls: LlmToolCall[];
  /** 端点回传的 usage；部分兼容端点不回传，由会话层回落为估算。 */
  usage?: LlmUsage;
}

export interface LlmClient {
  chat(messages: LlmMessage[]): Promise<LlmChatResponse>;
}

export interface AgentLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  tools: AgentToolSummary[] | (() => AgentToolSummary[]);
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 是否发送 response_format=json_object（端点不支持时自动降级重试一次）。 */
  responseFormat?: boolean;
}

export class LlmError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(code: string, message: string, options: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
  }
}

function isUnsupportedResponseFormat(error: unknown): boolean {
  if (!(error instanceof LlmError) || error.code !== 'LLM_HTTP_ERROR') return false;
  if (error.status !== 400 && error.status !== 404 && error.status !== 422 && error.status !== 500) return false;
  const text = `${error.message} ${error.detail ?? ''}`;
  return /response[_-]?format|unsupported|not support|unknown (?:parameter|field)|invalid (?:parameter|request)/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => isRecord(item) && typeof item.text === 'string' ? item.text : '')
      .join('');
  }
  return '';
}

export function toOpenAiTools(tools: AgentToolSummary[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function usageNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

function parseUsage(value: unknown): LlmUsage | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = usageNumber(value.prompt_tokens ?? value.promptTokens);
  const completionTokens = usageNumber(value.completion_tokens ?? value.completionTokens);
  const totalTokens = usageNumber(value.total_tokens ?? value.totalTokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function parseToolCalls(message: Record<string, unknown>): LlmToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  const result: LlmToolCall[] = [];
  message.tool_calls.forEach((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.function)) return;
    const name = typeof raw.function.name === 'string' ? raw.function.name : '';
    if (!name) return;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `call_${index + 1}`;
    const rawArguments = raw.function.arguments;
    const args = typeof rawArguments === 'string'
      ? rawArguments
      : rawArguments === undefined
        ? '{}'
        : JSON.stringify(rawArguments);
    result.push({ id, type: 'function', function: { name, arguments: args } });
  });
  return result;
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly getTools: () => AgentToolSummary[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private responseFormat: boolean;

  constructor(options: AgentLlmOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    assertSafeApiKeyUrl(new URL(this.baseUrl));
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.getTools = typeof options.tools === 'function' ? options.tools : () => options.tools as AgentToolSummary[];
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.responseFormat = options.responseFormat !== false;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const label = this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)} 秒` : `${this.timeoutMs} 毫秒`;
        reject(new LlmError('LLM_TIMEOUT', `LLM 请求超时（${label}）`));
      }, this.timeoutMs);
    });

    const operation = (async (): Promise<unknown> => {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 800);
        } catch {
          detail = '';
        }
        throw new LlmError('LLM_HTTP_ERROR', `模型服务返回错误：HTTP ${response.status}${statusText}`, {
          status: response.status,
          ...(detail ? { detail } : {})
        });
      }
      try {
        return await response.json() as unknown;
      } catch {
        throw new LlmError('LLM_INVALID_RESPONSE', '模型服务返回的不是合法 JSON');
      }
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const aborted = isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (aborted) {
        const label = this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)} 秒` : `${this.timeoutMs} 毫秒`;
        throw new LlmError('LLM_TIMEOUT', `LLM 请求超时（${label}）`);
      }
      throw new LlmError('LLM_REQUEST_FAILED', `LLM 请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async chat(messages: LlmMessage[]): Promise<LlmChatResponse> {
    const tools = toOpenAiTools(this.getTools());
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    };
    if (this.responseFormat && tools.length > 0) {
      body.response_format = { type: 'json_object' };
    }
    let payload: unknown;
    try {
      payload = await this.post(body);
    } catch (error) {
      if (this.responseFormat && tools.length > 0 && isUnsupportedResponseFormat(error)) {
        this.responseFormat = false;
        delete body.response_format;
        payload = await this.post(body);
      } else {
        throw error;
      }
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
      throw new LlmError('LLM_INVALID_RESPONSE', '模型服务响应字段不存在：choices');
    }
    const message = isRecord(payload.choices[0].message) ? payload.choices[0].message : {};
    const usage = parseUsage(payload.usage);
    return {
      content: contentText(message.content).trim(),
      toolCalls: parseToolCalls(message),
      ...(usage ? { usage } : {})
    };
  }

  async ping(): Promise<string> {
    const payload = await this.post({
      model: this.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8
    });
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
      throw new LlmError('LLM_INVALID_RESPONSE', '模型服务响应字段不存在：choices');
    }
    const message = isRecord(payload.choices[0].message) ? payload.choices[0].message : {};
    return contentText(message.content).trim();
  }
}

export async function testLlmConnection(
  config: AgentLlmConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ ok: boolean; message: string; model: string }> {
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      tools: [],
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {})
    });
    const reply = await client.ping();
    return {
      ok: true,
      message: reply ? `连接成功：${reply}` : '连接成功',
      model: config.model
    };
  } catch (error) {
    return {
      ok: false,
      message: `测试连接失败：${error instanceof Error ? error.message : String(error)}`,
      model: config.model
    };
  }
}
