import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classifyUpdateRelease,
  validateUpdateReleasePreflight,
  verifyUpdateReleaseArtifacts
} from '../scripts/update-release-preflight.mjs';

const VALID_BUILD_CONFIG = {
  win: { verifyUpdateCodeSignature: true },
  nsis: { differentialPackage: true },
  publish: { provider: 'github', owner: 'owlco001', repo: 'automation-cad-prototype', channel: 'latest' }
};

function makeReleaseFixture(t, channel = 'stable') {
  const root = mkdtempSync(join(tmpdir(), 'automationcad-update-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unpacked = join(root, 'win-unpacked', 'resources');
  mkdirSync(unpacked, { recursive: true });
  const version = channel === 'beta' ? '1.2.3-beta.1' : '1.2.3';
  const installer = `AutomationCAD-Setup-${version}.exe`;
  const installerBytes = Buffer.from('mock installer');
  const installerSha512 = createHash('sha512').update(installerBytes).digest('base64');
  writeFileSync(join(root, installer), installerBytes);
  writeFileSync(join(root, `${installer}.blockmap`), 'mock blockmap');
  writeFileSync(join(root, channel === 'beta' ? 'beta.yml' : 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${installerSha512}\n    size: ${installerBytes.length}\n`);
  writeFileSync(join(unpacked, 'app-update.yml'), 'provider: github\nowner: owlco001\nrepo: automation-cad-prototype\npublisherName:\n  - "CN=AutomationCAD, O=Example"\n');
  return root;
}

function verifyFixture(root, channel = 'stable', expectedVersion = channel === 'beta' ? '1.2.3-beta.1' : '1.2.3') {
  return verifyUpdateReleaseArtifacts({ releaseDir: root, channel, expectedVersion });
}

test('发行 tag 只映射 stable 正式版与 beta 预发布版', () => {
  assert.deepEqual(classifyUpdateRelease('v1.2.3', '1.2.3'), { channel: 'stable', publishChannel: 'latest', prerelease: false });
  assert.deepEqual(classifyUpdateRelease('v1.2.4-beta.2', '1.2.4-beta.2'), { channel: 'beta', publishChannel: 'beta', prerelease: true });
  assert.throws(() => classifyUpdateRelease('v1.2.3-alpha.1', '1.2.3-alpha.1'), /只允许 stable/);
  assert.throws(() => classifyUpdateRelease('v1.2.4', '1.2.3'), /版本 .* 不一致/);
});

test('tag 生产发行缺少证书或密码时安全阻断', () => {
  assert.throws(() => validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: '', certificatePassword: '', buildConfig: VALID_BUILD_CONFIG
  }), /发行阻断.*CSC_LINK, CSC_KEY_PASSWORD/);
  assert.deepEqual(validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: 'provided-by-secret', certificatePassword: 'provided-by-secret', buildConfig: VALID_BUILD_CONFIG
  }), { channel: 'stable', publishChannel: 'latest', prerelease: false });
});

test('tag 生产发行配置必须启用签名校验/差分包且固定在预期 GitHub source', () => {
  assert.throws(() => validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: 'mock', certificatePassword: 'mock',
    buildConfig: { ...VALID_BUILD_CONFIG, win: { verifyUpdateCodeSignature: false } }
  }), /verifyUpdateCodeSignature/);
  assert.throws(() => validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: 'mock', certificatePassword: 'mock',
    buildConfig: { ...VALID_BUILD_CONFIG, nsis: { differentialPackage: false } }
  }), /differentialPackage/);
  assert.throws(() => validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: 'mock', certificatePassword: 'mock',
    buildConfig: { ...VALID_BUILD_CONFIG, publish: { ...VALID_BUILD_CONFIG.publish, repo: 'other-repo' } }
  }), /GitHub 仓库/);
  assert.throws(() => validateUpdateReleasePreflight({
    tagName: 'v1.2.3', appVersion: '1.2.3', certificate: 'mock', certificatePassword: 'mock',
    buildConfig: { ...VALID_BUILD_CONFIG, win: { ...VALID_BUILD_CONFIG.win, publish: { channel: 'latest' } } }
  }), /build\.publish 根级/);
});

test('release artifacts 必须含目标渠道清单、SHA-512、blockmap 和 publisherName', (t) => {
  for (const channel of ['stable', 'beta']) {
    const root = makeReleaseFixture(t, channel);
    const result = verifyFixture(root, channel);
    assert.equal(result.metadata, channel === 'beta' ? 'beta.yml' : 'latest.yml');
    assert.equal(result.blockmap, true);
    assert.equal(result.publisherName, true);
    assert.equal(result.sha512, true);
    assert.equal(result.size, true);
    assert.equal(result.version, channel === 'beta' ? '1.2.3-beta.1' : '1.2.3');
  }
});

test('release artifacts 缺签名身份、SHA-512、清单或 blockmap 时拒绝', (t) => {
  const noPublisher = makeReleaseFixture(t);
  writeFileSync(join(noPublisher, 'win-unpacked', 'resources', 'app-update.yml'), 'provider: github\nowner: owlco001\nrepo: automation-cad-prototype\npublisherName: []\n');
  assert.throws(() => verifyFixture(noPublisher), /publisherName/);

  const noHash = makeReleaseFixture(t);
  writeFileSync(join(noHash, 'latest.yml'), 'version: 1.2.3\nfiles:\n  - url: AutomationCAD-Setup-1.2.3.exe\n    size: 14\n');
  assert.throws(() => verifyFixture(noHash), /SHA-512/);

  const noMap = makeReleaseFixture(t);
  rmSync(join(noMap, 'AutomationCAD-Setup-1.2.3.exe.blockmap'));
  assert.throws(() => verifyFixture(noMap), /blockmap/);

  const noBetaManifest = makeReleaseFixture(t);
  assert.throws(() => verifyFixture(noBetaManifest, 'beta'), /beta.yml/);
});

test('release artifacts 必须与实际安装器版本、引用、大小和 SHA-512 一致', (t) => {
  const wrongVersion = makeReleaseFixture(t);
  assert.throws(() => verifyFixture(wrongVersion, 'stable', '1.2.4'), /版本 1\.2\.3 与 package\.json 版本 1\.2\.4 不一致/);

  const wrongReference = makeReleaseFixture(t);
  writeFileSync(join(wrongReference, 'latest.yml'), 'version: 1.2.3\nfiles:\n  - url: AutomationCAD-Setup-1.2.4.exe\n    sha512: invalid\n    size: 14\n');
  assert.throws(() => verifyFixture(wrongReference), /未引用实际安装器/);

  const wrongHash = makeReleaseFixture(t);
  writeFileSync(join(wrongHash, 'latest.yml'), 'version: 1.2.3\nfiles:\n  - url: AutomationCAD-Setup-1.2.3.exe\n    sha512: invalid\n    size: 14\n');
  assert.throws(() => verifyFixture(wrongHash), /SHA-512 与实际文件不一致/);

  const wrongSize = makeReleaseFixture(t);
  writeFileSync(join(wrongSize, 'latest.yml'), 'version: 1.2.3\nfiles:\n  - url: AutomationCAD-Setup-1.2.3.exe\n    sha512: unused\n    size: 999\n');
  assert.throws(() => verifyFixture(wrongSize), /size 与实际文件不一致/);
});
