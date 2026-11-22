// 发布门禁：确认 dist/modules 的清单与每个分块逐字节一致。
//
// 打包会把 dist/** 一起带走，分块被替换/截断/漏更新都应在打包前发现，
// 而不是等用户点开某个模块时才报「哈希不符」。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleChunkReader } from '../electron/module-chunks.ts';
import { MODULE_API_VERSION } from '../src/modules/registry.ts';
import { apiCompatible, validateManifest } from '../src/modules/chunk-manifest.ts';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const coreIndex = args.indexOf('--core');
const corePath = coreIndex >= 0 ? resolve(args[coreIndex + 1] ?? '') : join(desktopRoot, 'dist', 'extension.js');
const rootArg = args.find((value) => !value.startsWith('--') && value !== args[coreIndex + 1]);
const rootDir = resolve(rootArg ?? join(desktopRoot, 'dist', 'modules'));

const reader = new ModuleChunkReader({ rootDir });
const loaded = reader.manifest();
if (!loaded.ok) {
  console.error(`MODULE_CHUNKS_VERIFY_FAILED ${loaded.code} ${loaded.message}`);
  process.exitCode = 1;
} else {
  const checked = validateManifest(loaded.manifest);
  if (!checked.ok) {
    console.error(`MODULE_CHUNKS_VERIFY_FAILED ${checked.message}`);
    process.exitCode = 1;
  } else {
    const problems = [];
    // 核心包不得包含分块专属标记：代码悄悄回到核心包时立刻红。
    const configPath = join(desktopRoot, 'modules', 'chunks.json');
    const markers = {};
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      for (const [id, entry] of Object.entries(config.chunks ?? {})) {
        if (entry && typeof entry === 'object' && typeof entry.coreMustNotContain === 'string') {
          markers[id] = entry.coreMustNotContain;
        }
      }
    } catch (error) {
      problems.push(`分块配置不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    let coreText = '';
    try {
      coreText = readFileSync(corePath, 'utf8');
    } catch {
      problems.push(`核心包不可读（先跑 build:ext）：${corePath}`);
    }
    for (const [id, marker] of Object.entries(markers)) {
      if (coreText.includes(marker)) problems.push(`${id} 的代码仍在核心包里（命中 ${marker}）`);
    }
    if (checked.manifest.moduleApiVersion !== MODULE_API_VERSION) {
      problems.push(`清单 moduleApiVersion=${checked.manifest.moduleApiVersion} 与宿主 ${MODULE_API_VERSION} 不一致`);
    }
    for (const entry of checked.manifest.chunks) {
      if (!apiCompatible(entry, MODULE_API_VERSION)) problems.push(`${entry.id} 的 API 区间不含宿主版本`);
      const result = reader.read(entry.id);
      if (!result.ok) problems.push(`${entry.id}: ${result.code} ${result.message}`);
      else console.log(`MODULE_CHUNK_OK ${entry.id} ${entry.file} ${entry.bytes}B ${entry.sha256.slice(0, 12)}…`);
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`MODULE_CHUNKS_VERIFY_FAILED ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`MODULE_CHUNKS_VERIFIED chunks=${checked.manifest.chunks.length} root=${rootDir}`);
    }
  }
}
