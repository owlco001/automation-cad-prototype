import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { builderArgs, createCoreConfig } from '../../scripts/dist-win-core.mjs';

const desktopRoot = fileURLToPath(new URL('../../', import.meta.url));
const configPath = fileURLToPath(new URL('../../scripts/dist-win-core.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager');
const { Platform } = require('app-builder-lib/out/core');
const fullBuild = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).build;

const resourcePath = (resource, key) => typeof resource === 'string' ? resource : resource[key] ?? '';
const isQtResource = (resource) => (
  /^vendor\/qt(?:\/|$)/i.test(resourcePath(resource, 'from').replaceAll('\\', '/').replace(/^(?:\.\/)+/, ''))
  || /^qt(?:\/|$)/i.test(resourcePath(resource, 'to').replaceAll('\\', '/').replace(/^(?:\.\/)+/, ''))
);

async function effectiveCoreConfig() {
  const config = await getConfig(desktopRoot, configPath, null);
  await validateConfiguration(config, { isEnabled: false, add() {} });
  return config;
}

test('Core builder loads its standalone effective config, excludes Qt, and preserves Full', async () => {
  const fullBefore = structuredClone(fullBuild);
  const directCore = createCoreConfig(fullBuild);
  const effectiveCore = await effectiveCoreConfig();

  assert.deepEqual(fullBuild, fullBefore, 'creating Core config must not mutate package.build');
  assert.equal(effectiveCore.extends, null);
  assert.equal(effectiveCore.appId, 'cn.automationcad.desktop.core');
  assert.equal(effectiveCore.productName, 'AutomationCAD Core');
  assert.equal(effectiveCore.executableName, 'AutomationCAD Core');
  assert.equal(effectiveCore.artifactName, 'AutomationCAD-Core-Setup-${version}.${ext}');
  assert.equal(effectiveCore.directories.output, 'release-core');
  assert.equal(effectiveCore.extraMetadata.name, 'automation-cad-desktop-core');
  assert.equal(effectiveCore.extraMetadata.automationCadEdition, 'core');
  assert.equal(effectiveCore.nsis.guid, undefined, 'Core NSIS GUID is derived from its distinct appId');
  assert.equal(effectiveCore.nsis.shortcutName, 'AutomationCAD Core');
  assert.equal(effectiveCore.nsis.uninstallDisplayName, 'AutomationCAD Core');
  assert.equal(effectiveCore.nsis.differentialPackage, false);
  assert(effectiveCore.extraResources.length > 0);
  assert(effectiveCore.extraResources.every((resource) => !isQtResource(resource)));
  assert(effectiveCore.extraResources.some((resource) => resourcePath(resource, 'to') === 'packs/builtin'));
  assert(effectiveCore.extraResources.some((resource) => resourcePath(resource, 'to') === 'pipeline'));
  assert.equal(directCore.extraResources.some(isQtResource), false);

  const fullQtResources = fullBuild.extraResources.filter(isQtResource);
  assert(fullQtResources.length > 0, 'Full retains its Qt resource');
  assert.deepEqual(fullBuild, fullBefore, 'effective Core loading must not change Full config');
  assert(fullBuild.extraResources.some(isQtResource));
});

test('Core config and CLI both disable every updater feed path', async () => {
  const effectiveCore = await effectiveCoreConfig();
  assert.equal(effectiveCore.publish, null);
  assert.equal(effectiveCore.win.publish, null);
  assert.equal(effectiveCore.nsis.publish, null);
  assert.equal(effectiveCore.generateUpdatesFilesForAllChannels, false);
  assert(builderArgs.includes('--publish'));
  assert.equal(builderArgs[builderArgs.indexOf('--publish') + 1], 'never');

  const updateConfig = await getAppUpdatePublishConfiguration({
    config: effectiveCore,
    platformSpecificBuildOptions: effectiveCore.win,
    platform: Platform.WINDOWS
  }, null, 1, false);
  assert.equal(updateConfig, null, 'PublishManager must not emit app-update.yml for Core');

  const dryRun = spawnSync(process.execPath, [configPath, '--dry-run'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.ifError(dryRun.error);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const printed = JSON.parse(dryRun.stdout);
  assert.equal(printed.config.appId, effectiveCore.appId);
  assert.deepEqual(printed.config.extraResources, effectiveCore.extraResources);
  assert.equal(printed.config.publish, null);
  assert.equal(printed.config.win.publish, null);
  assert.equal(printed.config.nsis.publish, null);
  assert.deepEqual(printed.builderArgs, builderArgs);
  assert(printed.builderArgs.includes('--publish'));
  assert.equal(printed.builderArgs[printed.builderArgs.indexOf('--publish') + 1], 'never');
});
