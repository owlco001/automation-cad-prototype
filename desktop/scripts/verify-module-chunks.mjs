// 发布门禁：确认 dist/modules 的清单与每个分块逐字节一致。
//
// 打包会把 dist/** 一起带走，分块被替换/截断/漏更新都应在打包前发现，
// 而不是等用户点开某个模块时才报「哈希不符」。
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleChunkReader } from '../electron/module-chunks.ts';
import { MODULE_API_VERSION } from '../src/modules/registry.ts';
import { apiCompatible, validateManifest } from '../src/modules/chunk-manifest.ts';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const rootDir = resolve(process.argv[2] ?? join(desktopRoot, 'dist', 'modules'));

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
