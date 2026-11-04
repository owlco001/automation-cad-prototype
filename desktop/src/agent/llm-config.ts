import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeApiKeyUrl } from '../shared/api-key-transport.ts';

export interface AgentLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  /**
   * 单轮工具调用上限。设计类任务（查库 → 核算 → 出 BOM → 导成本）很容易超 12 次，
   * 原来硬编码 12 会在关键步骤前把额度用光，模型只能交半成品。
   */
  maxToolCalls: number;
  /**
   * 截图回灌策略（`capture_view` 之后是否把压缩图发给模型）：
   * - `off`：永不发图，截图只回文本；
   * - `auto`：首次尝试带图，服务端拒收图片后本会话永久降级；
   * - `on`：强制带图，但被拒仍走降级重试，不把请求弄挂。
   */
  vision: VisionMode;
}

/** 视觉自检开关；字段落在 `agent-llm.json`，默认 `auto`。 */
export type VisionMode = 'auto' | 'on' | 'off';

export const VISION_MODES: readonly VisionMode[] = ['auto', 'on', 'off'];
export const DEFAULT_VISION_MODE: VisionMode = 'auto';

export function isVisionMode(value: unknown): value is VisionMode {
  return typeof value === 'string' && (VISION_MODES as readonly string[]).includes(value);
}

export function parseVisionMode(value: unknown): VisionMode {
  if (value === undefined) return DEFAULT_VISION_MODE;
  if (!isVisionMode(value)) {
    throw new Error(`vision 必须是 ${VISION_MODES.join(' / ')} 之一`);
  }
  return value;
}

export interface AgentLlmPublicConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  maxToolCalls: number;
  vision: VisionMode;
  hasApiKey: boolean;
}

export const LLM_CONFIG_FILENAME = 'agent-llm.json';

export const DEFAULT_LLM_CONFIG: AgentLlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  /**
   * 设计类任务（查库 → 选型 → 核算 → 出 BOM → 成本）实测 14 轮仍不够
   * （光伏缓存堆叠机：30+ 次工具调用、2 次建模写操作）；默认给到上限。
   */
  maxIterations: 50,
  maxToolCalls: 200,
  vision: DEFAULT_VISION_MODE
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function llmConfigPath(userDataDir: string): string {
  return join(userDataDir, LLM_CONFIG_FILENAME);
}

export function normalizeBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('baseUrl 不是合法 URL，例如 https://api.openai.com/v1');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl 必须以 http:// 或 https:// 开头');
  }
  return text;
}

export function maskApiKey(apiKey: string): string {
  const text = apiKey.trim();
  if (!text) return '';
  if (text.length <= 4) return '****';
  const prefix = text.startsWith('sk-') ? 'sk-' : text.slice(0, Math.min(3, text.length - 4));
  return `${prefix}****${text.slice(-4)}`;
}

export function isMaskedApiKey(value: string): boolean {
  return value.includes('****') || value.includes('…');
}

function parseMaxToolCalls(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    throw new Error('maxToolCalls 必须是 1 到 200 之间的整数');
  }
  return number;
}

function parseMaxIterations(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) {
    throw new Error('maxIterations 必须是 1 到 50 之间的整数');
  }
  return number;
}

export function normalizeLlmConfig(value: unknown): AgentLlmConfig {
  const source = isRecord(value) ? value : {};
  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim()
    ? normalizeBaseUrl(source.baseUrl)
    : DEFAULT_LLM_CONFIG.baseUrl;
  const model = typeof source.model === 'string' && source.model.trim()
    ? source.model.trim()
    : DEFAULT_LLM_CONFIG.model;
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  return {
    baseUrl,
    apiKey,
    model,
    maxIterations: parseMaxIterations(source.maxIterations, DEFAULT_LLM_CONFIG.maxIterations),
    maxToolCalls: parseMaxToolCalls(source.maxToolCalls, DEFAULT_LLM_CONFIG.maxToolCalls),
    vision: parseVisionMode(source.vision)
  };
}

export function publicLlmConfig(config: AgentLlmConfig): AgentLlmPublicConfig {
  return {
    baseUrl: config.baseUrl,
    apiKey: maskApiKey(config.apiKey),
    model: config.model,
    maxIterations: config.maxIterations,
    maxToolCalls: config.maxToolCalls,
    vision: config.vision,
    hasApiKey: Boolean(config.apiKey)
  };
}

/** UI 回传的 apiKey 若为空或掩码，则保留已保存的密钥。 */
export function mergeLlmConfig(existing: AgentLlmConfig, patch: unknown): AgentLlmConfig {
  const source = isRecord(patch) ? patch : {};
  const incomingKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  const keepKey = incomingKey === '' || isMaskedApiKey(incomingKey);
  return normalizeLlmConfig({
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : existing.baseUrl,
    apiKey: keepKey ? existing.apiKey : incomingKey,
    model: typeof source.model === 'string' ? source.model : existing.model,
    maxIterations: source.maxIterations === undefined ? existing.maxIterations : source.maxIterations,
    // 没传 vision 就沿用已保存的值：设置面板不会因为少一个字段把用户的开关重置回 auto。
    vision: source.vision === undefined ? existing.vision : source.vision
  });
}

export function readLlmConfig(userDataDir: string): AgentLlmConfig {
  const file = llmConfigPath(userDataDir);
  if (!existsSync(file)) return { ...DEFAULT_LLM_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`模型配置 agent-llm.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeLlmConfig(parsed);
}

export function writeLlmConfig(userDataDir: string, config: AgentLlmConfig): AgentLlmConfig {
  const normalized = normalizeLlmConfig(config);
  assertSafeApiKeyUrl(new URL(normalized.baseUrl));
  mkdirSync(userDataDir, { recursive: true });
  const file = llmConfigPath(userDataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`保存模型配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

export function saveLlmConfig(userDataDir: string, patch: unknown): AgentLlmConfig {
  const existing = readLlmConfig(userDataDir);
  return writeLlmConfig(userDataDir, mergeLlmConfig(existing, patch));
}
