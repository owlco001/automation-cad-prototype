import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const readFullBuild = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build;

export const builderArgs = Object.freeze(['--config', scriptPath, '--win', 'nsis', '--x64', '--publish', 'never']);

export function createCoreConfig(fullBuild) {
  const config = structuredClone(fullBuild);
  // Give the builder a standalone config; overlaying package.build would merge its Qt resource back in.
  config.extends = null;
  config.appId = 'cn.automationcad.desktop.core';
  config.productName = 'AutomationCAD Core';
  config.executableName = 'AutomationCAD Core';
  config.artifactName = 'AutomationCAD-Core-Setup-${version}.${ext}';
  config.directories = { ...config.directories, output: 'release-core' };
  config.extraMetadata = {
    ...config.extraMetadata,
    name: 'automation-cad-desktop-core',
    automationCadEdition: 'core'
  };
  config.extraResources = config.extraResources.filter((entry) => {
    const from = typeof entry === 'string' ? entry : entry.from;
    const to = typeof entry === 'string' ? '' : entry.to;
    const clean = (value) => (value ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    return !/^vendor\/qt(?:\/|$)/i.test(clean(from)) && !/^qt(?:\/|$)/i.test(clean(to));
  });
  config.publish = null;
  config.generateUpdatesFilesForAllChannels = false;
  delete config.releaseInfo;
  config.win = { ...config.win, publish: null };
  config.nsis = {
    ...config.nsis,
    artifactName: config.artifactName,
    shortcutName: 'AutomationCAD Core',
    uninstallDisplayName: 'AutomationCAD Core',
    publish: null,
    differentialPackage: false
  };
  delete config.nsis.guid; // NSIS derives its independent installer GUID from the Core appId.
  return config;
}

// electron-builder loads the same file via --config, without merging package.build.
export default function coreConfig() {
  return createCoreConfig(readFullBuild());
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: desktopRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args[0]} failed (${result.signal ?? result.status})`);
}

function main(args) {
  if (args.length === 1 && args[0] === '--dry-run') {
    console.log(JSON.stringify({ config: coreConfig(), builderArgs }, null, 2));
    return;
  }
  if (args.length !== 0) throw new Error('Usage: npm run dist:win:core -- [--dry-run]');
  const require = createRequire(import.meta.url);
  const builder = require.resolve('electron-builder/cli.js');
  // Like dist:win, package an existing build:ext. These steps use local inputs only.
  runNode(['scripts/build-pipeline.mjs']);
  runNode(['scripts/vendor-dwg.mjs']);
  runNode([builder, ...builderArgs]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
