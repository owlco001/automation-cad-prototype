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
//   {
//     "schemaVersion": 1,
//     "sharedExternals": { "<裸模块名>": "<__cadSharedDeps 上的键>" },
//     "chunks": { "<moduleId>": "<entry path, desktop 相对>" }
//   }
//
// 共享依赖外置：分块是独立 IIFE，默认会把 three 这类大库各打一份。`sharedExternals`
// 把这些裸导入交给 esbuild 的 external，并在分块顶部生成一段 require 垫片，从
// `globalThis.__cadSharedDeps.<键>` 取核心已经加载的同一个实例。运行时分块加载时若
// 依赖缺失会**立即抛错**（不静默用空对象），错误信息带上模块名与缺少的键。
//
// 纪律：
// - 配置里出现的 id 必须存在于 MODULE_REGISTRY，且必须已经 implemented，否则构建失败
//   （避免做出一个永远不可能被启用的分块）。
// - 分块文件必须自注册 `window.__cadRegisterModuleChunk({ id, apiVersion, exports })`；
//   构建后会检查产物里确实带这个标记与正确 id。
// - 清单的字节数与哈希来自**实际产物**，不是配置。
// - esbuild 会把分块 import 的 CSS 额外写成同基名的 `.css`（如 cost.estimation.css）。
//   分块样式在运行时由核心包内联提供，这份 CSS 不进清单也不投递，构建后按产物基名删除，
//   避免变成安装包里的死字节；删除必须留日志，不能静默。

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(desktopRoot, 'modules', 'chunks.json');
export const DEFAULT_OUT_DIR = join(desktopRoot, 'dist', 'modules');
const MARKER = '__cadRegisterModuleChunk';

/** 核心注入共享依赖时使用的全局表；与 extension.ts 的 ensureSharedModuleDeps 对齐。 */
export const SHARED_DEPS_GLOBAL = '__cadSharedDeps';

/**
 * 随包配置默认启用的共享依赖：three 已经在核心包里，分块不应再打一份。
 *
 * 这里只作为默认值的单一来源；配置显式写了 `sharedExternals` 就以配置为准
 * （传空对象即可关闭默认外置）。
 */
export const DEFAULT_SHARED_EXTERNALS = Object.freeze({ three: 'THREE' });

const SHARED_SPECIFIER = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/;
const SHARED_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 分块文件名：模块 id 本身就是白名单字符集（字母数字 . _ -），直接加 .js。 */
export function chunkFileName(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw new Error(`模块 id 不能直接当文件名：${id}`);
  return `${id}.js`;
}

function safeGlobal(id) {
  return `__cadChunk_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** 千分位分组，日志里的字节数按 28,904 这种形式写，避免与 28.904 混淆。 */
function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 删除某个分块由 esbuild 附带的 CSS sidecar。
 *
 * 只按**本次产物基名**推导路径（`cost.estimation.js` → `cost.estimation.css`），
 * 不扫描目录，避免误删别人的 .css。没有 sidecar 就静默返回；存在就删除并留日志。
 */
async function dropCssSidecar(outDir, jsFileName, log) {
  const sidecarName = `${jsFileName.slice(0, -'.js'.length)}.css`;
  const sidecarPath = join(outDir, sidecarName);
  let sidecar;
  try {
    sidecar = await stat(sidecarPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!sidecar.isFile()) throw new Error(`${sidecarName} 不是普通文件，拒绝删除`);
  await rm(sidecarPath);
  log(`dropped sidecar ${sidecarName} (${groupThousands(sidecar.size)} B, inlined at runtime)`);
}

/**
 * 校验共享依赖表：键是交给 esbuild external 的裸模块名，值是 `__cadSharedDeps` 上的键。
 *
 * 缺省时启用 `DEFAULT_SHARED_EXTERNALS`（three → THREE）；显式传 `{}` 可关闭。
 * 拒绝相对路径、非法标识符与 `__proto__`，避免把分块配置变成任意模块解析入口。
 */
export function validateSharedExternals(raw) {
  const source = raw === undefined ? DEFAULT_SHARED_EXTERNALS : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('sharedExternals 必须是对象');
  }
  const externals = {};
  for (const [specifier, key] of Object.entries(source)) {
    const segments = specifier.split('/');
    if (specifier === '__proto__'
      || !SHARED_SPECIFIER.test(specifier)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`sharedExternals 的模块名不合法：${specifier}`);
    }
    if (typeof key !== 'string' || key === '__proto__' || !SHARED_KEY.test(key)) {
      throw new Error(`sharedExternals.${specifier} 必须是合法的全局键名`);
    }
    externals[specifier] = key;
  }
  return externals;
}

/**
 * 生成共享依赖垫片，并把整个分块包进一个函数作用域。
 *
 * esbuild 对 IIFE 里的 external 导入会生成 `require("three")` 调用；这里在分块顶部
 * 定义一个同名局部 `require`，从 `globalThis.__cadSharedDeps` 取核心已加载的实例。
 * 缺失时立刻抛错。用外层函数包住可以避免把 `require` 泄漏成页面全局变量。
 */
function sharedDepsBanner(sharedExternals) {
  if (Object.keys(sharedExternals).length === 0) return undefined;
  const mapping = JSON.stringify(sharedExternals);
  return '(function(){var require=(function(){var m=' + mapping + ';return function(n){' +
    "if(!Object.prototype.hasOwnProperty.call(m,n))throw new Error('未声明的共享依赖：'+n);" +
    `var d=globalThis.${SHARED_DEPS_GLOBAL};var v=d?d[m[n]]:void 0;` +
    `if(v===void 0)throw new Error('共享依赖 '+n+' 未注入（globalThis.${SHARED_DEPS_GLOBAL}.'+m[n]+'）');` +
    'return v}})();';
}

/**
 * 只把**精确匹配**的共享依赖交给运行时，子路径照常打包。
 *
 * esbuild 的 `external: ['three']` 会把 `three/addons/...` 一起外部化，但 addons
 * 的命名导出并不在 `THREE` 命名空间上；这里用插件精确匹配包名，子路径仍由 esbuild
 * 正常解析（它内部的 `from 'three'` 依旧命中共享依赖）。这样布局编辑器的
 * OrbitControls/TransformControls 随分块按需加载，不会为了共享它们把 TransformControls
 * 塞进每次启动都要加载的核心包。
 */
function sharedExternalPlugin(sharedExternals, root) {
  const names = new Set(Object.keys(sharedExternals));
  if (names.size === 0) return null;
  const requireFromRoot = createRequire(join(root, 'package.json'));
  return {
    name: 'cad-shared-externals',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (names.has(args.path)) return { path: args.path, external: true };
        for (const name of names) {
          if (args.path.startsWith(`${name}/`)) {
            return { path: requireFromRoot.resolve(args.path) };
          }
        }
        return undefined;
      });
    }
  };
}

/**
 * 分块自注册 footer。
 *
 * 有共享依赖垫片时整个产物在函数作用域里，直接引用 esbuild 的 globalName 变量；
 * 没有垫片时沿用原来的全局变量方式（并清掉 globalName，避免污染渲染层）。
 */
function chunkFooter(id, globalName, moduleApiVersion, wrapped) {
  const source = wrapped ? globalName : `globalThis.${globalName}`;
  const cleanup = wrapped ? '' : `try{delete globalThis.${globalName}}catch(_){}`;
  const register = `;(function(){var m=${source};${cleanup}` +
    `var x=m&&m.default!==undefined?m.default:m;` +
    `(globalThis.${MARKER}||function(){throw new Error('chunk host missing')})({id:${JSON.stringify(id)},` +
    `apiVersion:${moduleApiVersion},exports:x})})();`;
  return wrapped ? `${register}})();` : register;
}

/** 读取并校验配置：结构、重复、未知模块、未实现模块。 */
export function validateChunkConfig(raw, registry) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('分块配置必须是对象');
  if (raw.schemaVersion !== 1) throw new Error(`不支持的分块配置版本：${String(raw.schemaVersion)}`);
  validateSharedExternals(raw.sharedExternals);
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
  const sharedExternals = validateSharedExternals(config.sharedExternals);
  const sharedPlugin = sharedExternalPlugin(sharedExternals, root);
  const banner = sharedDepsBanner(sharedExternals);
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
      plugins: sharedPlugin === null ? [] : [sharedPlugin],
      banner: banner === undefined ? undefined : { js: banner },
      footer: { js: chunkFooter(id, globalName, moduleApiVersion, banner !== undefined) }
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
    await dropCssSidecar(outDir, fileName, log);
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
