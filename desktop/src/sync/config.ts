import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncConfig, SyncPublicConfig } from './types.ts';
import { assertSafeApiKeyUrl } from '../shared/api-key-transport.ts';

/** deviceId 为智慧工厂侧机台编号（device_no）。 */
export const SYNC_CONFIG_DEFAULTS: SyncConfig = {
  baseUrl: '',
  apiKey: '',
  deviceId: '',
  projectId: '',
  enabled: false
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  if (!text) return '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('baseUrl 不是合法 URL，例如 https://factory.example.com');
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
  return `****${text.slice(-4)}`;
}

export function isMaskedApiKey(value: string): boolean {
  return value.includes('****') || value.includes('…');
}

export function parseSyncConfig(value: unknown): SyncConfig {
  if (!isRecord(value)) throw new Error('同步配置必须是对象');
  const baseUrl = typeof value.baseUrl === 'string' ? normalizeBaseUrl(value.baseUrl) : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : '';
  const projectId = typeof value.projectId === 'string' ? value.projectId.trim() : '';
  const enabled = value.enabled === true;
  return { baseUrl, apiKey, deviceId, projectId, enabled };
}

export function publicSyncConfig(config: SyncConfig): SyncPublicConfig {
  return {
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    projectId: config.projectId,
    enabled: config.enabled,
    hasApiKey: Boolean(config.apiKey),
    apiKeyMasked: maskApiKey(config.apiKey)
  };
}

/**
 * UI 回传的 apiKey 若为空或掩码，则保留已保存的密钥；不会把掩码写进配置文件。
 */
export function mergeSyncConfig(existing: SyncConfig, patch: unknown): SyncConfig {
  const source = isRecord(patch) ? patch : {};
  const incomingKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  const keepKey = incomingKey === '' || isMaskedApiKey(incomingKey);
  return parseSyncConfig({
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : existing.baseUrl,
    apiKey: keepKey ? existing.apiKey : incomingKey,
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : existing.deviceId,
    projectId: typeof source.projectId === 'string' ? source.projectId : existing.projectId,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : existing.enabled
  });
}

export function readSyncConfig(file: string): SyncConfig {
  if (!existsSync(file)) return { ...SYNC_CONFIG_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`同步配置 sync.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSyncConfig(parsed);
}

export function writeSyncConfig(file: string, config: SyncConfig): void {
  const normalized = parseSyncConfig(config);
  if (normalized.baseUrl) assertSafeApiKeyUrl(new URL(normalized.baseUrl));
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`保存同步配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
