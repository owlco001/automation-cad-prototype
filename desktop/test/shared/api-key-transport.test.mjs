import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeApiKeyUrl, isLoopbackHostname } from '../../src/shared/api-key-transport.ts';

test('只把明确的 localhost 与 IP 回环地址视为本机目标', () => {
  for (const host of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.255.255.255', '[::1]']) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ['factory.example.com', 'localhost.localdomain', '10.0.0.1', '192.168.1.2', '[::2]']) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test('API key URL 仅允许 HTTPS、回环与泛内网段 HTTP', () => {
  for (const value of ['https://factory.example.com/v1', 'http://localhost:8000', 'http://127.4.3.2:8000', 'http://[::1]:8000']) {
    assert.doesNotThrow(() => assertSafeApiKeyUrl(new URL(value)), value);
  }
  for (const value of ['http://factory.example.com/v1', 'http://8.8.8.8:8000', 'ftp://localhost/resource']) {
    assert.throws(() => assertSafeApiKeyUrl(new URL(value)), /明文传输 API Key|必须以 http:\/\/ 或 https:\/\/ 开头/, value);
  }
});

test('泛内网段 HTTP 放行，公网 HTTP 拒绝', () => {
  const allow = [
    'http://10.1.2.3:8000',
    'http://172.16.20.5:8000',
    'http://172.31.255.1:8000',
    'http://192.168.2.125:8000',
    'http://169.254.10.20:8000',
    'http://[fd00::1]:8000',
    'http://[fe80::1]:8000',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
  ];
  for (const value of allow) {
    assert.doesNotThrow(() => assertSafeApiKeyUrl(new URL(value)), value);
  }
  const deny = [
    'http://8.8.8.8:8000',
    'http://172.32.1.1:8000',
    'http://172.15.1.1:8000',
    'http://192.169.1.1:8000',
    'http://11.0.0.1:8000',
    'http://intranet.example.com:8000',
    'http://factory.local:8000',
    'ftp://192.168.2.125:21'
  ];
  for (const value of deny) {
    assert.throws(() => assertSafeApiKeyUrl(new URL(value)), /公网|http:\/\/ 或 https:\/\//, value);
  }
});
