// 把「可选模块」打包成独立的经典脚本分块 + 清单（清单带逐文件 sha256）。
//
// 为什么不是 ESM 动态 import：扩展宿主是以经典脚本注入到 file:// 页面里的
// （desktop/electron/main.ts 的 did-finish-load 段），渲染进程 sandbox + contextIsolation，
// 没有可靠的模块解析器与 CSP 保证。这里沿用同一注入模型：分块是自注册的经典脚本，
// 由主进程读本地文件、校验哈希后再交给渲染层执行。
//
// 用法：
//   node scripts/build-module-chunks.mjs                 # 用 desktop/modules/chunks.json
//   node scripts/build-module-chunks.mjs --config <path> --out <dir> [--quiet]
//
// 配置格式（desktop/modules/chunks.json）：
//   { "schemaVersion": 1, "chunks": { "<moduleId>": "<entry path, desktop 相对>" } }
//
// 纪律：
// - 配置里出现的 id 必须存在于 MODULE_REGISTRY，且必须已经 implemented，否则构建失败
//   （避免做出一个永远不可能被启用的分块）。
// - 分块文件必须自注册 `window.__cadRegisterModuleChunk({ id, apiVersion, exports })`；
//   构建后会检查产物里确实带这个标记与正确 id。
// - 清单的字节数与哈希来自**实际产物**，不是配置。

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(desktopRoot, 'modules', 'chunks.json');
export const DEFAULT_OUT_DIR = join(desktopRoot, 'dist', 'modules');
const MARKER = '__cadRegisterModuleChunk';

/** 分块文件名：模块 id 本身就是白名单字符集（字母数字 . _ -），直接加 .js。 */
export function chunkFileName(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw new Error(`模块 id 不能直接当文件名：${id}`);
  return `${id}.js`;
}

function safeGlobal(id) {
  return `__cadChunk_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** 读取并校验配置：结构、重复、未知模块、未实现模块。 */
export function validateChunkConfig(raw, registry) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('分块配置必须是对象');
  if (raw.schemaVersion !== 1) throw new Error(`不支持的分块配置版本：${String(raw.schemaVersion)}`);
  const chunks = raw.chunks;
  if (!chunks || typeof chunks !== 'object' || Array.isArray(chunks)) throw new Error('chunks 必须是对象');
  const byId = new Map(registry.map((definition) => [definition.id, definition]));
  const entries = [];
  for (const [id, entry] of Object.entries(chunks)) {
    const definition = byId.get(id);
    if (!definition) throw new Error(`模块不在注册表里：${id}`);
    if (definition.kind !== 'optional') throw new Error(`核心模块不能单独分块：${id}`);
    if (!definition.implemented) throw new Error(`模块尚未实现，不能分块：${id}`);
    const normalized = typeof entry === 'string' ? { entry } : entry;
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new Error(`${id} 的分块配置必须是入口路径或 { entry, coreMustNotContain }`);
    }
    if (typeof normalized.entry !== 'string' || normalized.entry.trim() === '') {
      throw new Error(`${id} 的入口路径必须是非空字符串`);
    }
    const marker = normalized.coreMustNotContain;
    if (marker !== undefined && (typeof marker !== 'string' || marker.length < 8)) {
      throw new Error(`${id} 的 coreMustNotContain 必须是至少 8 个字符的字符串`);
    }
    entries.push({ id, entry: normalized.entry.trim(), marker, definition });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  return entries;
}

/**
 * 构建全部分块并写清单。
 * @param {{configPath?: string, outDir?: string, desktopRoot?: string, registry: readonly any[], moduleApiVersion: number, log?: (line: string) => void}} options
 */
export async function buildChunks(options) {
  const {
    configPath = DEFAULT_CONFIG_PATH,
    outDir = DEFAULT_OUT_DIR,
    root = desktopRoot,
    registry,
    moduleApiVersion,
    log = () => {}
  } = options;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const entries = validateChunkConfig(config, registry);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const chunks = [];
  for (const { id, entry, marker, definition } of entries) {
    const entryPath = resolve(root, entry);
    if (!entryPath.startsWith(resolve(root))) throw new Error(`入口越界：${entry}`);
    await stat(entryPath); // 入口不存在时立刻失败，不要产出半套分块
    const fileName = chunkFileName(id);
    const globalName = safeGlobal(id);
    await build({
      entryPoints: [entryPath],
      outfile: join(outDir, fileName),
      bundle: true,
      format: 'iife',
      globalName,
      platform: 'browser',
      target: 'chrome120',
      minify: true,
      keepNames: true,
      legalComments: 'none',
      logLevel: 'silent',
      footer: {
        js: `;(function(){var m=globalThis.${globalName};try{delete globalThis.${globalName}}catch(_){}` +
            `var x=m&&m.default!==undefined?m.default:m;` +
            `(globalThis.${MARKER}||function(){throw new Error('chunk host missing')})({id:${JSON.stringify(id)},` +
            `apiVersion:${moduleApiVersion},exports:x})})();`
      }
    });
    const bytes = await readFile(join(outDir, fileName));
    const text = bytes.toString('utf8');
    if (!text.includes(MARKER) || !text.includes(JSON.stringify(id))) {
      throw new Error(`${fileName} 没有按约定自注册（缺少 ${MARKER} 或 id）`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    chunks.push({
      id,
      apiCompatibility: { ...definition.apiCompatibility },
      file: fileName,
      bytes: bytes.byteLength,
      sha256
    });
    log(`chunk ${id} → ${fileName} (${bytes.byteLength} B, sha256 ${sha256.slice(0, 12)}…)`);
  }

  const manifest = { schemaVersion: 1, moduleApiVersion, chunks };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`manifest → manifest.json (${chunks.length} chunks)`);
  return { manifest, outDir };
}

function parseArgs(argv) {
  const options = { configPath: DEFAULT_CONFIG_PATH, outDir: DEFAULT_OUT_DIR, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--quiet') options.quiet = true;
    else if (arg === '--config') options.configPath = resolve(argv[++index] ?? '');
    else if (arg === '--out') options.outDir = resolve(argv[++index] ?? '');
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { MODULE_REGISTRY, MODULE_API_VERSION } = await import('../src/modules/registry.ts');
  const result = await buildChunks({
    configPath: options.configPath,
    outDir: options.outDir,
    registry: MODULE_REGISTRY,
    moduleApiVersion: MODULE_API_VERSION,
    log: options.quiet ? () => {} : (line) => console.log(line)
  });
  if (!options.quiet) {
    console.log(`MODULE_CHUNKS_OK chunks=${result.manifest.chunks.length} out=${result.outDir}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`MODULE_CHUNKS_FAILED ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
