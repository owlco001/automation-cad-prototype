import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { NsisUpdater } from 'electron-updater';
import {
  UpdateChannelService,
  assertUpdateIpcAuthorization,
  assertUpdateModuleEnabled,
  hasTrustedUpdateConfig
} from '../electron/update-service.ts';
import { createModuleManager } from '../src/modules/registry.ts';

class MockUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = false;
  channel = null;
  disableDifferentialDownload = true;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = [];
  async checkForUpdates() { this.checkCalls += 1; return {}; }
  async downloadUpdate() { this.downloadCalls += 1; return []; }
  quitAndInstall(isSilent, isForceRunAfter) { this.installCalls.push({ isSilent, isForceRunAfter }); }
}

function makeService(overrides = {}) {
  const updater = overrides.updater ?? new MockUpdater();
  const persisted = [];
  const service = new UpdateChannelService({
    updater,
    currentVersion: '0.3.0',
    channel: 'stable',
    enabled: true,
    persistChannel: (channel) => persisted.push(channel),
    ...overrides
  });
  return { service, updater, persisted };
}

function makeNsisMock({ signerResult = null } = {}) {
  const installerUrl = new URL('https://github.com/owlco001/automation-cad-prototype/releases/download/v0.3.1/AutomationCAD-Setup-0.3.1.exe');
  const fileInfo = { url: installerUrl, info: { url: installerUrl.href }, packageInfo: null };
  let fullDownloads = 0;
  const publisherChecks = [];
  const updater = Object.create(NsisUpdater.prototype);
  updater._testOnlyOptions = null;
  updater._logger = { info() {}, warn() {}, error() {} };
  updater.app = { version: '0.3.0' };
  updater.previousBlockmapBaseUrlOverride = null;
  updater.httpExecutor = {
    async downloadToBuffer() { throw new Error('mock blockmap network failure'); },
    async download(url, destination) {
      assert.equal(url.href, installerUrl.href);
      assert.equal(destination, '/mock/AutomationCAD-Setup-0.3.1.exe');
      fullDownloads += 1;
    }
  };
  updater.downloadedUpdateHelper = { cacheDir: '/mock/cache', cacheDirForPendingUpdate: '/mock/pending' };
  updater.listenerCount = () => 0;
  updater.executeDownload = async ({ task }) => task('/mock/AutomationCAD-Setup-0.3.1.exe', {}, null, async () => undefined);
  updater.configOnDisk = { value: Promise.resolve({ publisherName: ['CN=AutomationCAD, O=Example'] }) };
  updater._verifyUpdateCodeSignature = async (publishers, filePath) => {
    publisherChecks.push({ publishers, filePath });
    return signerResult;
  };
  const provider = {
    resolveFiles: () => [fileInfo],
    getBlockMapFiles: async () => [new URL('https://github.com/mock/old.blockmap'), new URL('https://github.com/mock/new.blockmap')],
    isUseMultipleRangeRequest: true
  };
  const options = {
    updateInfoAndProvider: { provider, info: { version: '0.3.1' } },
    disableWebInstaller: false,
    disableDifferentialDownload: false,
    requestHeaders: null,
    cancellationToken: null
  };
  return { updater, options, fullDownloads: () => fullDownloads, publisherChecks };
}

test('system.update 默认启用，关闭时阻止请求，重新开启后可继续', async () => {
  const storage = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const manager = createModuleManager(storage);
  const updater = new MockUpdater();
  const { service } = makeService({ updater });
  assert.equal(manager.getStatus('system.update').enabled, true);
  assert.doesNotThrow(() => assertUpdateModuleEnabled(manager.getStatus('system.update').enabled));
  await service.check();
  assert.equal(updater.checkCalls, 1);
  updater.emit('update-not-available', { version: '0.3.0' });

  manager.setEnabled('system.update', false);
  assert.throws(() => assertUpdateModuleEnabled(manager.getStatus('system.update').enabled), /MODULE_DISABLED/);
  assert.equal(JSON.parse(storage.value).overrides['system.update'], false);
  manager.setEnabled('system.update', true);
  assert.doesNotThrow(() => assertUpdateModuleEnabled(manager.getStatus('system.update').enabled));
  await service.check();
  assert.equal(updater.checkCalls, 2);
});

test('更新器默认关闭自动下载/退出安装，但保留 NSIS blockmap 差分', () => {
  const { service, updater } = makeService();
  assert.equal(service.snapshot().status, 'idle');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableDifferentialDownload, false);
  assert.throws(() => service.installAfterConfirmation(), /尚无已验证完成的更新/);
});

test('开发态与缺少受信任更新源或发布者配置的安装态都不触网', async () => {
  const dev = makeService({ enabled: false, disabledMessage: '开发态不可用' });
  assert.equal((await dev.service.check()).status, 'disabled');
  assert.equal(dev.updater.checkCalls, 0);
  const blocked = makeService({ enabled: false, disabledMessage: '缺少受信任发布者' });
  assert.equal(blocked.service.snapshot().message, '缺少受信任发布者');
  assert.equal((await blocked.service.check()).status, 'disabled');
  assert.equal(blocked.updater.checkCalls, 0);
});

test('离线检查失败显示错误状态，不开始下载或产生安装状态', async () => {
  const updater = new MockUpdater();
  updater.checkForUpdates = async () => { updater.checkCalls += 1; throw new Error('offline ENETUNREACH'); };
  const { service } = makeService({ updater });
  const result = await service.check();
  assert.equal(result.status, 'error');
  assert.match(result.message, /offline ENETUNREACH/);
  assert.equal(updater.downloadCalls, 0);
  assert.throws(() => service.installAfterConfirmation(), /尚无已验证完成的更新/);
});

test('stable/beta 明确配置 GitHub channel，beta 不得隐式允许降级', async () => {
  const { service, updater, persisted } = makeService();
  assert.equal(updater.channel, 'latest');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  const beta = await service.setChannel('beta');
  assert.equal(beta.channel, 'beta');
  assert.equal(updater.channel, 'beta');
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.deepEqual(persisted, ['beta']);
  const stable = await service.setChannel('stable');
  assert.equal(stable.channel, 'stable');
  assert.equal(updater.channel, 'latest');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.deepEqual(persisted, ['beta', 'stable']);
  await assert.rejects(service.setChannel('nightly'), /stable 或 beta/);
});

test('更新检查只显示可用版本，不自动下载；只有明确确认才运行非静默安装', async () => {
  const { service, updater } = makeService();
  await service.check();
  assert.equal(updater.checkCalls, 1);
  assert.equal(service.snapshot().status, 'checking');
  assert.equal(updater.downloadCalls, 0);

  updater.emit('checking-for-update');
  updater.emit('update-available', { version: '0.4.0', releaseName: '修复版', releaseNotes: '改进更新器' });
  assert.equal(service.snapshot().status, 'available');
  assert.equal(service.snapshot().availableVersion, '0.4.0');
  assert.equal(service.snapshot().releaseName, '修复版');
  assert.equal(updater.downloadCalls, 0);
  assert.throws(() => service.installAfterConfirmation(), /尚无已验证完成的更新/);

  await service.download();
  assert.equal(updater.downloadCalls, 1);
  assert.equal(service.snapshot().status, 'downloading');
  updater.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 50 });
  assert.equal(service.snapshot().progress.percent, 42.5);
  updater.emit('update-downloaded', { version: '0.4.0' });
  assert.equal(service.snapshot().status, 'downloaded');
  await assert.rejects(service.setChannel('beta'), /不能切换更新渠道/);
  service.installAfterConfirmation();
  assert.deepEqual(updater.installCalls, [{ isSilent: false, isForceRunAfter: true }]);
});

test('更新错误不泄露疑似凭据，并且不进入已下载/安装状态', async () => {
  const { service, updater } = makeService();
  updater.emit('error', new Error('request failed token=abc123 https://user:password@example.invalid/feed'));
  const state = service.snapshot();
  assert.equal(state.status, 'error');
  assert.doesNotMatch(state.message, /abc123|password@example/);
  assert.match(state.message, /\[redacted\]/);
  await assert.rejects(service.download(), /没有可下载的更新/);
});

test('更新配置必须是固定 GitHub 源且含非空 publisherName；缺失签名身份 fail-closed', () => {
  const valid = [
    'provider: github',
    'owner: owlco001',
    'repo: automation-cad-prototype',
    'publisherName:',
    '  - "CN=AutomationCAD, O=Example"'
  ].join('\n');
  assert.equal(hasTrustedUpdateConfig(valid), true);
  assert.equal(hasTrustedUpdateConfig(valid.replace(/publisherName:[\s\S]*/, '')), false);
  assert.equal(hasTrustedUpdateConfig(valid.replace('provider: github', 'provider: generic')), false);
  assert.equal(hasTrustedUpdateConfig(valid.replace('  - "CN=AutomationCAD, O=Example"', '  - ""')), false);
  assert.equal(hasTrustedUpdateConfig(valid.replace('owner: owlco001', 'owner: someone-else')), false);
});

test('NSIS updater 在真实 Authenticode verifier 返回不匹配时拒绝安装器', async () => {
  const harness = makeNsisMock({ signerResult: 'mock signer mismatch' });
  await assert.rejects(
    harness.updater.doDownloadUpdate(harness.options),
    (error) => error?.code === 'ERR_UPDATER_INVALID_SIGNATURE'
  );
  assert.equal(harness.fullDownloads(), 1);
  assert.deepEqual(harness.publisherChecks, [{
    publishers: ['CN=AutomationCAD, O=Example'],
    filePath: '/mock/AutomationCAD-Setup-0.3.1.exe'
  }]);
});

test('NSIS blockmap differential失败后实际退回完整包，完整包仍走 Authenticode 校验', async () => {
  const harness = makeNsisMock();
  await harness.updater.doDownloadUpdate(harness.options);
  assert.equal(harness.fullDownloads(), 1, '差分 blockmap mock 网络错误后必须下载完整安装包');
  assert.deepEqual(harness.publisherChecks, [{
    publishers: ['CN=AutomationCAD, O=Example'],
    filePath: '/mock/AutomationCAD-Setup-0.3.1.exe'
  }]);
});

test('更新授权 IPC 仅接受存活主窗口的本地 file:// 主 frame', () => {
  const trusted = {
    mainWindowAlive: true,
    senderIsMainWindow: true,
    senderIsMainFrame: true,
    senderUsesFileUrl: true
  };
  assert.doesNotThrow(() => assertUpdateIpcAuthorization(trusted));
  for (const key of Object.keys(trusted)) {
    assert.throws(() => assertUpdateIpcAuthorization({ ...trusted, [key]: false }), /拒绝来自非主窗口/);
  }
});
