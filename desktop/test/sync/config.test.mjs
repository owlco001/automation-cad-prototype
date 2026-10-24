import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  SYNC_CONFIG_DEFAULTS,
  maskApiKey,
  mergeSyncConfig,
  publicSyncConfig,
  readSyncConfig,
  writeSyncConfig
} from '../../src/sync/config.ts';

let sandbox;
let configFile;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-sync-config-'));
  configFile = join(sandbox, 'sync.json');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('配置缺失时返回安全默认值', () => {
  assert.deepEqual(readSyncConfig(configFile), {
    baseUrl: '',
    apiKey: '',
    deviceId: '',
    projectId: '',
    enabled: false
  });
});

test('API Key 脱敏只保留末四位，公开配置不含明文', () => {
  assert.equal(maskApiKey('sk-design-12345678'), '****5678');
  assert.equal(maskApiKey('abc'), '****');
  const config = { baseUrl: 'https://f.example.com', apiKey: 'secret-key-9876', deviceId: 'DEV-001', projectId: 'asm', enabled: true };
  const visible = publicSyncConfig(config);
  assert.equal(visible.apiKeyMasked, '****9876');
  assert.equal(visible.hasApiKey, true);
  assert.equal('apiKey' in visible, false);
});

test('写入 sync.json 权限为 600，读取保持原值', () => {
  const config = { baseUrl: 'http://127.0.0.1:9999/', apiKey: 'key-123456', deviceId: 'DEV-1', projectId: 'asm-1', enabled: true };
  writeSyncConfig(configFile, config);
  assert.deepEqual(readSyncConfig(configFile), { ...config, baseUrl: 'http://127.0.0.1:9999' });
  if (process.platform !== 'win32') {
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
  }
});

test('旧的远程 HTTP 同步配置仍可读取以便修正，但新写入会被拒绝', () => {
  const legacy = {
    baseUrl: 'http://factory.example.com',
    apiKey: 'legacy-secret',
    deviceId: 'DEV-1',
    projectId: 'asm',
    enabled: true
  };
  writeFileSync(configFile, JSON.stringify(legacy));
  assert.deepEqual(readSyncConfig(configFile), legacy);
  assert.throws(() => writeSyncConfig(configFile, legacy), /明文传输 API Key/);
  assert.doesNotThrow(() => writeSyncConfig(configFile, { ...legacy, baseUrl: 'http://localhost:9000' }));
});

test('空或掩码 apiKey 保存时保留原密钥，新密钥才覆盖', () => {
  const existing = { baseUrl: 'https://f.example.com', apiKey: 'old-secret', deviceId: 'DEV-1', projectId: 'asm', enabled: true };
  assert.equal(mergeSyncConfig(existing, { baseUrl: 'https://f.example.com', apiKey: '', deviceId: 'DEV-1', projectId: 'asm', enabled: true }).apiKey, 'old-secret');
  assert.equal(mergeSyncConfig(existing, { apiKey: '****cret' }).apiKey, 'old-secret');
  assert.equal(mergeSyncConfig(existing, { apiKey: 'new-secret' }).apiKey, 'new-secret');
  writeFileSync(configFile, '{bad json');
  assert.throws(() => readSyncConfig(configFile), /不是合法 JSON/);
  assert.equal(readFileSync(configFile, 'utf8'), '{bad json');
});

test('默认配置的机台编号为空，公开配置仍保持脱敏', () => {
  assert.equal(SYNC_CONFIG_DEFAULTS.deviceId, '');
  const visible = publicSyncConfig({
    baseUrl: 'https://f.example.com',
    apiKey: 'secret-key-4321',
    deviceId: 'DEV-001',
    projectId: 'asm',
    enabled: true
  });
  assert.equal(visible.deviceId, 'DEV-001');
  assert.equal(visible.apiKeyMasked, '****4321');
  assert.equal(visible.hasApiKey, true);
  assert.equal('apiKey' in visible, false);
});
