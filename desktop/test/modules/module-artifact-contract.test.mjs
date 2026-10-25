import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCoreProfileManifest,
  createModuleArtifactManifest,
  validateCoreProfileManifest,
  validateModuleArtifactManifest
} from '../../scripts/module-artifact-contract.mjs';

const definition = {
  id: 'factory.plc-sync',
  version: '1.0.0',
  apiCompatibility: { min: 1, max: 1 },
  dependencies: ['plcgen'],
  requiredCapabilities: ['sync.design-package', 'machine.io-map']
};
const code = new TextEncoder().encode('export function buildCandidate() { return null; }');

test('Core registry stub 不得宣称可安装或已验收离线能力', () => {
  const profile = createCoreProfileManifest(code);
  assert.equal(profile.profile, 'core-only');
  assert.equal(profile.installable, false);
  assert.equal(profile.offlineCapability, 'unverified');
  assert.equal(validateCoreProfileManifest(profile, code), true);
  assert.throws(() => validateCoreProfileManifest({ ...profile, installable: true }, code), /不得声明可安装或已验收离线能力/);
  assert.throws(() => validateCoreProfileManifest({ ...profile, offlineCapability: 'verified' }, code), /不得声明可安装或已验收离线能力/);
  assert.throws(() => validateCoreProfileManifest({ ...profile, entrySha256: '0'.repeat(64) }, code), /SHA-256 不匹配/);
});

test('模块构建清单绑定 Core API、依赖、能力与模块代码摘要', () => {
  const manifest = createModuleArtifactManifest(definition, code);
  assert.equal(manifest.format, 'automationcad.module-artifact');
  assert.equal(manifest.module.id, definition.id);
  assert.deepEqual(manifest.module.dependencies, ['plcgen']);
  assert.deepEqual(manifest.module.requiredCapabilities, ['sync.design-package', 'machine.io-map']);
  assert.equal(manifest.files[0].size, code.byteLength);
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateModuleArtifactManifest(manifest, code), true);
});

test('篡改代码、入口路径或 API 范围时 fail-closed', () => {
  const manifest = createModuleArtifactManifest(definition, code);
  assert.throws(() => validateModuleArtifactManifest(manifest, new TextEncoder().encode('tampered')), /大小或 SHA-256/);
  assert.throws(() => validateModuleArtifactManifest({ ...manifest, entry: '../escape.js' }, code), /入口、Core API/);
  assert.throws(() => validateModuleArtifactManifest({ ...manifest, module: { ...manifest.module, apiCompatibility: { min: 3, max: 1 } } }, code), /API 兼容范围/);
});

test('没有签名信任策略时模块包清单必须保持未激活', () => {
  const manifest = createModuleArtifactManifest(definition, code);
  assert.equal(manifest.authenticity, 'unsigned');
  assert.equal(manifest.activation, 'blocked-until-trust-policy');
  assert.throws(() => validateModuleArtifactManifest({ ...manifest, activation: 'enabled' }, code), /未签名模块必须保持未激活/);
});
