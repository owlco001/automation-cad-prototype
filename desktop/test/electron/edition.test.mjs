import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { desktopRuntimeIdentity, editionUpdateRestriction, mcpRuntimeConfig, runtimeStoragePaths } from '../../electron/edition.ts';

const root = mkdtempSync(join(tmpdir(), 'cad-edition-'));
after(() => rmSync(root, { recursive: true, force: true }));
let index = 0;
function installation(metadata) {
  const appRoot = join(root, String(index++));
  mkdirSync(join(appRoot, 'dist-electron'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify(metadata));
  return appRoot;
}

test('only exact installed Core metadata selects Core; development always remains Full', () => {
  const appRoot = installation({ automationCadEdition: 'core' });
  const core = desktopRuntimeIdentity(true, appRoot);
  assert.equal(core.appName, 'AutomationCAD Core');
  assert.equal(core.edition, 'core');
  const dev = desktopRuntimeIdentity(false, appRoot);
  assert.equal(dev.edition, 'full');
  assert.equal(dev.appName, 'AutomationCAD');
  assert.equal(desktopRuntimeIdentity(true, installation({})).edition, 'full');
  assert.equal(desktopRuntimeIdentity(false, '/nonexistent/development').edition, 'full');
});

test('Core profile, Chromium session, RPC and CDP cannot overlap Full defaults', () => {
  const core = desktopRuntimeIdentity(true, installation({ automationCadEdition: 'core' }));
  const full = desktopRuntimeIdentity(true, installation({}));
  const appData = join(root, 'app-data');
  assert.deepEqual(runtimeStoragePaths(core, appData), {
    userData: join(appData, 'AutomationCAD Core'), sessionData: join(appData, 'AutomationCAD Core', 'session')
  });
  assert.deepEqual(runtimeStoragePaths(full, appData), {
    userData: join(appData, 'AutomationCAD'), sessionData: join(appData, 'AutomationCAD')
  });
  assert.deepEqual([full.rpcPort, full.cdpInternalPort, full.cdpExternalPort], [7420, 9229, 9222]);
  assert.deepEqual([core.rpcPort, core.cdpInternalPort, core.cdpExternalPort], [7421, 9239, 9232]);
  assert.equal(new Set([full.rpcPort, full.cdpInternalPort, full.cdpExternalPort, core.rpcPort, core.cdpInternalPort, core.cdpExternalPort]).size, 6);
  assert.equal(editionUpdateRestriction(core).enabled, false);
  assert.match(editionUpdateRestriction(core).message, /Core.*不提供应用内更新/);
  assert.equal(editionUpdateRestriction(full), null);
});

test('MCP uses bundle-adjacent metadata and the matching profile and RPC port', () => {
  const coreRoot = installation({ automationCadEdition: 'core' });
  const fullRoot = installation({});
  const fullProfile = join(root, 'app-data', 'AutomationCAD');
  const core = mcpRuntimeConfig(join(coreRoot, 'dist-electron'), fullProfile);
  assert.equal(core.userDataDir, join(root, 'app-data', 'AutomationCAD Core'));
  assert.equal(core.identity.rpcPort, 7421);
  assert.deepEqual(core.identity, desktopRuntimeIdentity(true, coreRoot));
  const full = mcpRuntimeConfig(join(fullRoot, 'dist-electron'), fullProfile);
  assert.equal(full.userDataDir, fullProfile);
  assert.equal(full.identity.rpcPort, 7420);
});

test('unreadable, malformed or unknown packaged metadata cannot fall back into Full data', () => {
  const invalid = ['core ', 'CORE', 'unknown', 'full', null, false, 1];
  for (const edition of invalid) {
    const appRoot = installation({ automationCadEdition: edition });
    assert.throws(() => desktopRuntimeIdentity(true, appRoot), /版本身份/);
    assert.throws(() => mcpRuntimeConfig(join(appRoot, 'dist-electron'), join(root, 'AutomationCAD')), /版本身份/);
  }
  for (const raw of ['{', 'null', '[]', '"core"']) {
    const appRoot = installation({});
    writeFileSync(join(appRoot, 'package.json'), raw);
    assert.throws(() => desktopRuntimeIdentity(true, appRoot));
    assert.throws(() => mcpRuntimeConfig(join(appRoot, 'dist-electron'), join(root, 'AutomationCAD')));
  }
  const missing = join(root, 'missing-package');
  assert.throws(() => desktopRuntimeIdentity(true, missing), /阻止启动/);
  assert.throws(() => mcpRuntimeConfig(join(missing, 'dist-electron'), join(root, 'AutomationCAD')), /阻止启动/);
});
