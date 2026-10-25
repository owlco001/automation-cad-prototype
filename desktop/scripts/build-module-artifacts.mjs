import { build } from 'esbuild';
import AdmZip from 'adm-zip';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCoreProfileManifest,
  createModuleArtifactManifest,
  sha256Hex,
  validateCoreProfileManifest,
  validateModuleArtifactManifest
} from './module-artifact-contract.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const outputRoot = resolve(root, 'dist-profiles');
const args = new Set(process.argv.slice(2));
const buildCore = !args.has('--modules-only');
const buildModules = !args.has('--core-only');
const { MODULE_REGISTRY } = await import('../src/modules/registry.ts');
const moduleEntries = {
  'agent.resume': ['src/modules/agent-resume-gate.ts', 'src/agent/plan-checkpoint.ts'],
  'plcgen': ['src/plcgen/index.ts'],
  'elec.validation': ['src/elec/check.ts', 'src/elec/report.ts'],
  'commission.io-test': ['src/commission/sequence.ts', 'src/commission/diagnose.ts'],
  'cad.parametric-import': ['src/parametric/model.ts'],
  'parametric.history': ['src/parametric/model.ts'],
  'factory.plc-sync': ['src/sync/plc.ts', 'src/sync/package.ts', 'src/sync/client.ts'],
  'project.portable': ['src/project-archive/archive.ts', 'src/project-archive/desktop.ts', 'src/project-archive/identity.ts'],
  'cost.estimation': ['src/cost/engine.ts', 'src/cost/report.ts', 'src/cost/export.ts'],
  'system.update': ['electron/update-service.ts', 'src/update/ui.ts']
};
const optionalDefinitions = MODULE_REGISTRY.filter((module) => module.kind === 'optional');
if (buildModules) {
  const registeredIds = optionalDefinitions.map((module) => module.id).sort();
  const buildIds = Object.keys(moduleEntries).sort();
  if (registeredIds.join('\n') !== buildIds.join('\n')) {
    throw new Error(`模块构建入口与 registry 不一致：registry=${registeredIds.join(',')} entries=${buildIds.join(',')}`);
  }
}

async function buildCoreProfile() {
  const coreDir = join(outputRoot, 'core');
  mkdirSync(coreDir, { recursive: true });
  const outfile = join(coreDir, 'extension.js');
  await build({
    entryPoints: [join(root, 'src/modules/core-runtime.ts')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'AutomationCadCore',
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    legalComments: 'none'
  });
  const code = readFileSync(outfile);
  for (const definition of optionalDefinitions) {
    if (code.includes(Buffer.from(definition.id))) {
      throw new Error(`Core-only runtime 中发现可选模块代码标识：${definition.id}`);
    }
  }
  const profile = createCoreProfileManifest(code);
  validateCoreProfileManifest(profile, code);
  writeFileSync(join(coreDir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
  return { profile: 'core-only', path: 'core', entryBytes: code.byteLength, entrySha256: profile.entrySha256 };
}

async function buildModuleArtifact(definition) {
  const id = definition.id;
  const entries = moduleEntries[id];
  if (!entries) throw new Error(`缺少模块构建入口：${id}`);
  const moduleDir = join(outputRoot, 'modules', id);
  mkdirSync(moduleDir, { recursive: true });
  const outfile = join(moduleDir, 'module.mjs');
  const plugin = {
    name: 'automationcad-module-entry',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^automationcad-module:/ }, () => ({ path: id, namespace: 'automationcad-module' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'automationcad-module' }, () => ({
        contents: entries.map((entry) => `export * from ${JSON.stringify(`./${entry}`)};`).join('\n'),
        resolveDir: root,
        loader: 'ts'
      }));
    }
  };
  await build({
    entryPoints: [`automationcad-module:${id}`],
    outfile,
    bundle: true,
    external: ['node:*'],
    mainFields: ['module', 'main'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    plugins: [plugin]
  });
  const code = readFileSync(outfile);
  const manifest = createModuleArtifactManifest(definition, code);
  writeFileSync(join(moduleDir, 'module.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = new AdmZip();
  archive.addFile('module.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  archive.addFile('module.mjs', Buffer.from(code));
  const archivePath = join(moduleDir, `${id}-${definition.version}.acmodule.zip`);
  archive.writeZip(archivePath);
  const unpacked = new AdmZip(archivePath);
  const names = unpacked.getEntries().map((entry) => entry.entryName).sort();
  if (names.join(',') !== 'module.json,module.mjs') throw new Error(`模块 ZIP 包含未声明文件：${id}`);
  const packagedManifest = JSON.parse(unpacked.getEntry('module.json').getData().toString('utf8'));
  const packagedCode = new Uint8Array(unpacked.getEntry('module.mjs').getData());
  validateModuleArtifactManifest(packagedManifest, packagedCode);
  if (packagedManifest.module.id !== id || packagedManifest.module.version !== definition.version) {
    throw new Error(`模块 ZIP 身份校验失败：${id}`);
  }
  return {
    id,
    version: definition.version,
    path: `modules/${id}/${id}-${definition.version}.acmodule.zip`,
    bytes: readFileSync(archivePath).byteLength,
    codeBytes: code.byteLength,
    codeSha256: sha256Hex(code),
    authenticity: 'unsigned',
    activation: 'blocked-until-trust-policy'
  };
}

const profiles = [];
if (buildCore) profiles.push(await buildCoreProfile());
const modules = [];
if (buildModules) {
  for (const definition of optionalDefinitions) modules.push(await buildModuleArtifact(definition));
}
const buildManifest = {
  format: 'automationcad-build-profiles',
  schemaVersion: 1,
  coreApiVersion: 1,
  profiles,
  modules,
  note: 'SHA-256 detects accidental corruption only. Artifacts are unsigned and are not downloaded, installed, or executed by this build.'
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'build-manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
console.log(`MODULE_ARTIFACTS_OK core=${profiles.length} modules=${modules.length} activation=blocked`);
