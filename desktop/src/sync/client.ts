import { sha256Hex } from './package.ts';
import { normalizeBaseUrl } from './config.ts';
import { assertSafeApiKeyUrl } from '../shared/api-key-transport.ts';
import type {
  DesignDiff,
  DesignManifest,
  SyncConfig,
  SyncDiffResult,
  SyncDownloadResult,
  SyncListResult,
  SyncPackageSummary,
  SyncResult
} from './types.ts';

export const SYNC_TIMEOUT_MS = 15_000;

export interface SyncClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

class SyncTimeoutError extends Error {
  constructor() {
    super('请求超时');
    this.name = 'SyncTimeoutError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requireConfig(config: SyncConfig): void {
  if (!config.baseUrl.trim()) throw new Error('请先填写智慧工厂 baseUrl');
  assertSafeApiKeyUrl(new URL(normalizeBaseUrl(config.baseUrl)));
  if (!config.deviceId.trim()) throw new Error('请先填写机台编号 device_no');
  if (!config.apiKey.trim()) throw new Error('请先填写 apiKey');
}

function timeoutMessage(label: string, timeoutMs: number): string {
  return `${label}超时（${Math.round(timeoutMs / 1000)} 秒），请检查 baseUrl、网络代理与防火墙`;
}

function networkMessage(label: string, error: unknown, timeoutMs: number): string {
  if (error instanceof SyncTimeoutError) return timeoutMessage(label, timeoutMs);
  const cause = error instanceof Error && 'cause' in error && error.cause
    ? `：${readableError(error.cause)}`
    : '';
  return `${label}失败：${readableError(error)}${cause}`;
}

function statusMessage(label: string, status: number, body: string): string {
  const detail = body.trim().slice(0, 300);
  const suffix = detail ? `（服务端：${detail}）` : '';
  if (status === 401 || status === 403) {
    return `${label}失败：设计密钥无效或权限不足（${status}），请在智慧工厂管理台检查接入密钥${suffix}`;
  }
  if (status === 404) return `${label}失败：接口或机台不存在（404），请检查 baseUrl 与机台编号 device_no${suffix}`;
  if (status === 409) return `${label}失败：同指纹设计包正在处理中（409），请稍后重试${suffix}`;
  if (status === 413) return `${label}失败：设计包超过服务端大小限制（413）${suffix}`;
  if (status >= 500) return `${label}失败：智慧工厂服务异常（${status}），请稍后重试${suffix}`;
  return `${label}失败：HTTP ${status}${suffix}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    console.warn('[SYNC_RESPONSE_BODY_READ_FAILED]', { site: 'desktop/src/sync/client.ts' }, error);
    return '';
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`下载设计包超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 大小上限`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`下载设计包超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 大小上限`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`下载设计包超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 大小上限`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('服务端响应不是合法 JSON');
  }
}

export class SyncClient {
  private readonly config: SyncConfig;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SyncConfig, options: SyncClientOptions = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async request(url: string, init: RequestInit, label: string): Promise<Response> {
    assertSafeApiKeyUrl(new URL(url));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new SyncTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<SyncResult> {
    try {
      requireConfig(this.config);
      const response = await this.request(
        this.url(`/api/v1/devices/${encodeURIComponent(this.config.deviceId)}/drawings`),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: 'application/json' }
        },
        '连接智慧工厂'
      );
      if (response.status === 200) {
        return { ok: true, message: '连接成功，设备图纸接口可用' };
      }
      const body = await safeText(response);
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          message: `连接失败：API Key 无效或没有设备权限（${response.status}），请在管理台重新生成接入密钥`
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          message: `连接失败：机台编号 device_no ${this.config.deviceId} 不存在或无图纸数据（404），请检查机台编号 device_no 与 baseUrl`
        };
      }
      return { ok: false, message: statusMessage('连接智慧工厂', response.status, body) };
    } catch (error) {
      if (error instanceof SyncTimeoutError) {
        return { ok: false, message: timeoutMessage('连接智慧工厂', this.timeoutMs) };
      }
      return { ok: false, message: networkMessage('连接智慧工厂', error, this.timeoutMs) };
    }
  }

  async uploadPackage(zip: Uint8Array, manifest: DesignManifest): Promise<SyncResult> {
    try {
      requireConfig(this.config);
      if (!(zip instanceof Uint8Array) || zip.byteLength === 0) return { ok: false, message: '设计包 ZIP 不能为空' };
      if (zip.byteLength > MAX_DESIGN_PACKAGE_BYTES) return { ok: false, message: '设计包超过 200 MiB 大小上限', stage: '打包', code: 'PACKAGE_TOO_LARGE' };
      if (!manifest || manifest.schemaVersion !== 1) return { ok: false, message: 'manifest schemaVersion 必须为 1' };

      const idempotencyKey = sha256Hex(zip);
      const uploadBytes = new ArrayBuffer(zip.byteLength);
      new Uint8Array(uploadBytes).set(zip);
      const form = new FormData();
      form.append('deviceId', this.config.deviceId);
      form.append('manifest', JSON.stringify(manifest));
      form.append('file', new Blob([uploadBytes], { type: 'application/zip' }), 'design-package.zip');

      const response = await this.request(
        this.url('/api/v1/design-sync/packages'),
        {
          method: 'POST',
          headers: {
            'X-Design-Key': this.config.apiKey,
            'Idempotency-Key': idempotencyKey,
            Accept: 'application/json'
          },
          body: form
        },
        '上传设计包'
      );
      const text = await safeText(response);
      if (response.status !== 200 && response.status !== 201) {
        return {
          ok: false,
          message: statusMessage('上传设计包', response.status, text),
          stage: '上传',
          code: 'UPLOAD_FAILED'
        };
      }
      let payload: unknown;
      try {
        payload = parseJson(text);
      } catch (error) {
        return {
          ok: false,
          message: `解析上传响应失败：${readableError(error)}`,
          stage: '解析',
          code: 'UPLOAD_PARSE_FAILED'
        };
      }
      if (!isRecord(payload)) {
        return {
          ok: false,
          message: '解析上传响应失败：响应不是对象',
          stage: '解析',
          code: 'UPLOAD_PARSE_FAILED'
        };
      }
      const packageId = typeof payload.packageId === 'string' ? payload.packageId : '';
      const version = typeof payload.version === 'number' ? payload.version : undefined;
      const duplicated = response.status === 200 || payload.duplicated === true;
      if (!packageId) {
        return {
          ok: false,
          message: '解析上传响应失败：缺少必填参数：packageId',
          stage: '解析',
          code: 'UPLOAD_PARSE_FAILED'
        };
      }
      return {
        ok: true,
        packageId,
        ...(version === undefined ? {} : { version }),
        duplicated,
        message: duplicated ? '服务端已存在相同设计包，已命中幂等' : '设计包上传成功'
      };
    } catch (error) {
      if (error instanceof SyncTimeoutError) {
        return {
          ok: false,
          message: timeoutMessage('上传设计包', this.timeoutMs),
          stage: '上传',
          code: 'UPLOAD_FAILED'
        };
      }
      return {
        ok: false,
        message: networkMessage('上传设计包', error, this.timeoutMs),
        stage: '上传',
        code: 'UPLOAD_FAILED'
      };
    }
  }

  async listPackages(): Promise<SyncListResult> {
    try {
      requireConfig(this.config);
      const query = new URLSearchParams({
        deviceId: this.config.deviceId,
        projectId: this.config.projectId,
        limit: '20'
      });
      const response = await this.request(
        this.url(`/api/v1/design-sync/packages?${query.toString()}`),
        {
          method: 'GET',
          headers: { 'X-Design-Key': this.config.apiKey, Accept: 'application/json' }
        },
        '读取设计包列表'
      );
      const text = await safeText(response);
      if (response.status !== 200) {
        return {
          ok: false,
          message: statusMessage('读取设计包列表', response.status, text),
          stage: '列表',
          code: 'LIST_FAILED'
        };
      }
      const payload = parseJson(text);
      if (!isRecord(payload) || !Array.isArray(payload.items)) {
        return {
          ok: false,
          message: '解析设计包列表失败：响应字段不存在：items',
          stage: '列表',
          code: 'LIST_PARSE_FAILED'
        };
      }
      const items: SyncPackageSummary[] = [];
      payload.items.forEach((entry) => {
        if (!isRecord(entry)) return;
        const packageId = typeof entry.packageId === 'string' ? entry.packageId : '';
        const projectId = typeof entry.projectId === 'string' ? entry.projectId : '';
        const version = typeof entry.version === 'number' ? entry.version : 0;
        const bomSha256 = typeof entry.bomSha256 === 'string' ? entry.bomSha256 : '';
        const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
        if (!packageId) return;
        items.push({
          packageId,
          projectId,
          version,
          bomSha256,
          createdAt,
          ...(typeof entry.uploadedBy === 'string' ? { uploadedBy: entry.uploadedBy } : {})
        });
      });
      return { ok: true, items };
    } catch (error) {
      if (error instanceof SyncTimeoutError) {
        return {
          ok: false,
          message: timeoutMessage('读取设计包列表', this.timeoutMs),
          stage: '列表',
          code: 'LIST_FAILED'
        };
      }
      return {
        ok: false,
        message: networkMessage('读取设计包列表', error, this.timeoutMs),
        stage: '列表',
        code: 'LIST_FAILED'
      };
    }
  }

  async diff(packageId: string): Promise<SyncDiffResult> {
    try {
      requireConfig(this.config);
      if (!packageId.trim()) return { ok: false, message: '请提供 packageId' };
      const response = await this.request(
        this.url(`/api/v1/design-sync/packages/${encodeURIComponent(packageId)}/diff?against=latest`),
        {
          method: 'GET',
          headers: { 'X-Design-Key': this.config.apiKey, Accept: 'application/json' }
        },
        '读取设计包差异'
      );
      const text = await safeText(response);
      if (response.status !== 200) {
        return {
          ok: false,
          message: statusMessage('读取设计包差异', response.status, text),
          stage: '比对',
          code: 'DIFF_FAILED'
        };
      }
      const payload = parseJson(text);
      if (!isRecord(payload)) {
        return {
          ok: false,
          message: '解析差异响应失败：响应不是对象',
          stage: '比对',
          code: 'DIFF_PARSE_FAILED'
        };
      }
      const base = isRecord(payload.base) ? payload.base : {};
      const diff: DesignDiff = {
        base: {
          packageId: typeof base.packageId === 'string' ? base.packageId : '',
          version: typeof base.version === 'number' ? base.version : 0
        },
        bomAdded: Array.isArray(payload.bomAdded) ? payload.bomAdded as DesignDiff['bomAdded'] : [],
        bomRemoved: Array.isArray(payload.bomRemoved) ? payload.bomRemoved as DesignDiff['bomRemoved'] : [],
        bomChanged: Array.isArray(payload.bomChanged) ? payload.bomChanged as DesignDiff['bomChanged'] : [],
        filesAdded: Array.isArray(payload.filesAdded) ? payload.filesAdded.filter((item): item is string => typeof item === 'string') : [],
        filesChanged: Array.isArray(payload.filesChanged) ? payload.filesChanged.filter((item): item is string => typeof item === 'string') : [],
        filesRemoved: Array.isArray(payload.filesRemoved) ? payload.filesRemoved.filter((item): item is string => typeof item === 'string') : []
      };
      return { ok: true, diff };
    } catch (error) {
      if (error instanceof SyncTimeoutError) {
        return {
          ok: false,
          message: timeoutMessage('读取设计包差异', this.timeoutMs),
          stage: '比对',
          code: 'DIFF_FAILED'
        };
      }
      return {
        ok: false,
        message: networkMessage('读取设计包差异', error, this.timeoutMs),
        stage: '比对',
        code: 'DIFF_FAILED'
      };
    }
  }

  async downloadPackage(packageId: string): Promise<SyncDownloadResult> {
    try {
      requireConfig(this.config);
      if (!packageId.trim()) {
        return { ok: false, message: '请提供 packageId', stage: '下载', code: 'DOWNLOAD_FAILED' };
      }
      const response = await this.request(
        this.url(`/api/v1/design-sync/packages/${encodeURIComponent(packageId)}/download`),
        {
          method: 'GET',
          headers: { 'X-Design-Key': this.config.apiKey, Accept: 'application/zip' }
        },
        '下载设计包'
      );
      if (response.status !== 200) {
        const body = await safeText(response);
        return {
          ok: false,
          message: statusMessage('下载设计包', response.status, body),
          stage: '下载',
          code: 'DOWNLOAD_FAILED'
        };
      }
      const zip = await readBoundedBytes(response, MAX_DESIGN_PACKAGE_BYTES);
      if (zip.byteLength === 0) {
        return {
          ok: false,
          message: '下载设计包失败：服务端返回空文件',
          stage: '下载',
          code: 'DOWNLOAD_FAILED'
        };
      }
      const etag = (response.headers.get('etag') ?? '').replace(/^"|"$/g, '');
      return {
        ok: true,
        zip,
        bytes: zip.byteLength,
        sha256: sha256Hex(zip),
        ...(etag ? { etag } : {})
      };
    } catch (error) {
      if (error instanceof SyncTimeoutError) {
        return {
          ok: false,
          message: timeoutMessage('下载设计包', this.timeoutMs),
          stage: '下载',
          code: 'DOWNLOAD_FAILED'
        };
      }
      return {
        ok: false,
        message: networkMessage('下载设计包', error, this.timeoutMs),
        stage: '下载',
        code: 'DOWNLOAD_FAILED'
      };
    }
  }
}
