import { isIP } from 'node:net';

/** 明确识别本机回环主机名与地址；不尝试解析任意 DNS 名称。 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith('127.');
  return version === 6 && normalized === '::1';
}

/**
 * 私有网络（RFC1918 / 链路本地 / 唯一本地 IPv6）允许 HTTP。
 * 只认字面 IP，不做 DNS 反查，避免把外网主机名伪装成内网。
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const version = isIP(normalized);
  if (version === 4) {
    const parts = normalized.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 链路本地
    return false;
  }
  if (version === 6) {
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80');
  }
  return false;
}

/**
 * 按既定要求：泛内网段（私有 IP / 回环 / 链路本地）允许 HTTP；只有公网远程服务强制 HTTPS。
 * 不含 API Key 的调用不受此限制；此函数只在携带密钥的端点被调用。
 */
export function assertSafeApiKeyUrl(url: URL, field = 'baseUrl'): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} 必须以 http:// 或 https:// 开头`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && !isPrivateNetworkHost(url.hostname)) {
    throw new Error(
      `${field} 使用公网 HTTP 会明文传输 API Key；公网服务必须使用 HTTPS。` +
      '泛内网段（10/8、172.16/12、192.168/16、169.254、IPv6 ULA/链路本地）与回环允许 HTTP。'
    );
  }
}
