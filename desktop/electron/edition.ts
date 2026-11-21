import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface RuntimeIdentity {
  readonly edition: 'full' | 'core';
  readonly appName: string;
  readonly rpcPort: number;
  readonly cdpInternalPort: number;
  readonly cdpExternalPort: number;
}

const FULL: RuntimeIdentity = Object.freeze({
  edition: 'full', appName: 'AutomationCAD', rpcPort: 7420,
  cdpInternalPort: 9229, cdpExternalPort: 9222
});
const CORE: RuntimeIdentity = Object.freeze({
  edition: 'core', appName: 'AutomationCAD Core', rpcPort: 7421,
  cdpInternalPort: 9239, cdpExternalPort: 9232
});

/** Only the exact marker in the installed application's package metadata selects Core. */
function readIdentity(packagePath: string): RuntimeIdentity {
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
  } catch {
    throw new Error(`无法读取应用版本身份，已阻止启动以保护其他版本的数据：${packagePath}`);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('应用版本元数据格式无效，已阻止启动。');
  }
  const edition = (metadata as Record<string, unknown>).automationCadEdition;
  if (edition === 'core') return CORE;
  if (edition === undefined) return FULL; // Backward compatibility with existing Full packages.
  throw new Error('无法识别应用版本身份，已阻止启动以保护其他版本的数据。');
}

export function desktopRuntimeIdentity(isPackaged: boolean, appRoot: string): RuntimeIdentity {
  return isPackaged ? readIdentity(join(appRoot, 'package.json')) : FULL;
}

/** mcp.cjs is distributed under <application>/dist-electron; never consult cwd or edition env vars. */
export function mcpRuntimeConfig(bundleDirectory: string, fullUserDataDir: string): {
  identity: RuntimeIdentity;
  userDataDir: string;
} {
  const identity = readIdentity(resolve(bundleDirectory, '..', 'package.json'));
  return {
    identity,
    userDataDir: identity.edition === 'core'
      ? runtimeStoragePaths(identity, dirname(fullUserDataDir)).userData
      : fullUserDataDir
  };
}

export function runtimeStoragePaths(identity: RuntimeIdentity, appDataDirectory: string): {
  userData: string;
  sessionData: string;
} {
  const userData = join(appDataDirectory, identity.appName);
  return { userData, sessionData: identity.edition === 'core' ? join(userData, 'session') : userData };
}

/** Core deliberately has no update feed, including when a Full update config is present. */
export function editionUpdateRestriction(identity: RuntimeIdentity): { enabled: false; message: string } | null {
  return identity.edition === 'core'
    ? { enabled: false, message: 'AutomationCAD Core 不提供应用内更新；请使用独立的 Core 安装包更新。' }
    : null;
}
