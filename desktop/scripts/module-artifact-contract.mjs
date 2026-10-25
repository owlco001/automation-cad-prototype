import { createHash } from 'node:crypto';

export const MODULE_ARTIFACT_FORMAT = 'automationcad.module-artifact';
export const MODULE_ARTIFACT_SCHEMA_VERSION = 1;
export const MODULE_ARTIFACT_ENTRY = 'module.mjs';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createCoreProfileManifest(entryBytes) {
  if (!(entryBytes instanceof Uint8Array) || entryBytes.byteLength === 0) {
    throw new Error('Core renderer registry 产物不能为空');
  }
  const manifest = {
    format: 'automationcad-install-profile',
    schemaVersion: 1,
    profile: 'core-only',
    coreApiVersion: 1,
    entry: 'extension.js',
    installedModules: ['core'],
    installable: false,
    offlineCapability: 'unverified',
    optionalRuntime: 'not-present',
    entrySha256: sha256Hex(entryBytes),
    authenticity: 'unsigned-build-artifact'
  };
  validateCoreProfileManifest(manifest, entryBytes);
  return manifest;
}

export function validateCoreProfileManifest(manifest, entryBytes) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.format !== 'automationcad-install-profile' || manifest.schemaVersion !== 1 ||
      manifest.profile !== 'core-only' || manifest.coreApiVersion !== 1 || manifest.entry !== 'extension.js' ||
      !Array.isArray(manifest.installedModules) || manifest.installedModules.length !== 1 ||
      manifest.installedModules[0] !== 'core' || manifest.optionalRuntime !== 'not-present') {
    throw new Error('Core renderer registry profile 清单不兼容');
  }
  if (manifest.installable !== false || manifest.offlineCapability !== 'unverified' ||
      manifest.authenticity !== 'unsigned-build-artifact') {
    throw new Error('Core renderer registry 产物不得声明可安装或已验收离线能力');
  }
  if (!(entryBytes instanceof Uint8Array) || entryBytes.byteLength === 0 ||
      manifest.entrySha256 !== sha256Hex(entryBytes)) {
    throw new Error('Core renderer registry 产物 SHA-256 不匹配');
  }
  return true;
}

export function createModuleArtifactManifest(definition, codeBytes) {
  if (!definition || typeof definition.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(definition.id)) {
    throw new Error('模块 ID 格式不合法');
  }
  if (typeof definition.version !== 'string' || !definition.version.trim()) {
    throw new Error('模块版本不能为空');
  }
  if (!(codeBytes instanceof Uint8Array) || codeBytes.byteLength === 0) {
    throw new Error('模块构建产物不能为空');
  }
  const manifest = {
    format: MODULE_ARTIFACT_FORMAT,
    schemaVersion: MODULE_ARTIFACT_SCHEMA_VERSION,
    module: {
      id: definition.id,
      version: definition.version,
      apiCompatibility: { ...definition.apiCompatibility },
      dependencies: [...definition.dependencies],
      requiredCapabilities: [...definition.requiredCapabilities]
    },
    coreApiVersion: 1,
    entry: MODULE_ARTIFACT_ENTRY,
    files: [{ path: MODULE_ARTIFACT_ENTRY, size: codeBytes.byteLength, sha256: sha256Hex(codeBytes) }],
    authenticity: 'unsigned',
    activation: 'blocked-until-trust-policy'
  };
  validateModuleArtifactManifest(manifest, codeBytes);
  return manifest;
}

export function validateModuleArtifactManifest(manifest, codeBytes) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('模块清单必须是对象');
  }
  if (manifest.format !== MODULE_ARTIFACT_FORMAT || manifest.schemaVersion !== MODULE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error('模块清单格式或 schema 版本不兼容');
  }
  const module = manifest.module;
  if (!module || typeof module.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(module.id) ||
      typeof module.version !== 'string' || !module.version.trim()) {
    throw new Error('模块身份或版本不合法');
  }
  if (!module.apiCompatibility || !Number.isInteger(module.apiCompatibility.min) ||
      !Number.isInteger(module.apiCompatibility.max) || module.apiCompatibility.min > module.apiCompatibility.max) {
    throw new Error('模块 API 兼容范围不合法');
  }
  if (!Array.isArray(module.dependencies) || !module.dependencies.every((value) => typeof value === 'string') ||
      !Array.isArray(module.requiredCapabilities) || !module.requiredCapabilities.every((value) => typeof value === 'string')) {
    throw new Error('模块依赖或权限能力清单不合法');
  }
  if (manifest.coreApiVersion !== 1 || manifest.entry !== MODULE_ARTIFACT_ENTRY || !Array.isArray(manifest.files) ||
      manifest.files.length !== 1 || manifest.files[0]?.path !== MODULE_ARTIFACT_ENTRY) {
    throw new Error('模块入口、Core API 或文件清单不兼容');
  }
  if (!(codeBytes instanceof Uint8Array) || codeBytes.byteLength === 0 || manifest.files[0].size !== codeBytes.byteLength ||
      manifest.files[0].sha256 !== sha256Hex(codeBytes)) {
    throw new Error('模块构建产物大小或 SHA-256 不匹配');
  }
  if (manifest.authenticity !== 'unsigned' || manifest.activation !== 'blocked-until-trust-policy') {
    throw new Error('未签名模块必须保持未激活状态');
  }
  return true;
}
