#!/usr/bin/env node
/**
 * 把整机管线（scripts/machine-design-cli.mjs + 它 import 的 src/**\/*.ts）打成**单文件** CJS，
 * 落到 desktop/vendor/pipeline/machine-design-cli.cjs，由 electron-builder 以 extraResources
 * 打进 resources/pipeline/。
 *
 * 为什么必须打包：安装包的 files 只有 dist/dist-electron/package.json，scripts/ 与 src/ 都不在里面；
 * Qt 客户端又只会 spawn 一个 node 脚本。不打包 = Qt 在客户机上根本算不出整机方案。
 *
 * 打包后两边共用同一份产物（Electron 通过 AUTOMATIONCAD_PIPELINE 指过去），
 * 不再是「Qt spawn 一遍源码、Electron 再 spawn 一遍源码」的两份计算。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const entry = join(desktopRoot, 'scripts', 'machine-design-cli.mjs');
const outdir = join(desktopRoot, 'vendor', 'pipeline');
const outfile = join(outdir, 'machine-design-cli.cjs');

/**
 * 入口脚本用 `resolve(import.meta.dirname, '..')` 定位 desktop 根，再往上一层拿 packs/builtin。
 * 打成 CJS 后没有 import.meta，且两种布局深度不同：
 *   dev      desktop/vendor/pipeline/x.cjs      → 根 = ../../..（仓库根）
 *   安装包    resources/pipeline/x.cjs           → 根 = ..（resources，extraResources 把 packs/builtin 放这儿）
 * 所以这里把表达式换成「运行时探测 `<root>/packs/builtin` 是否存在」的解析器。
 * 注意探测结果要退回两级：原脚本先 resolve(dirname,'..') 得 desktop 根，再 resolve 一次得仓库根，
 * 所以返回 `<root>/__bundle__/__desktop__`，让这两次上行正好落在 <root> 上，语义完全不变。
 */
const bundleRootPlugin = {
  name: 'qt-pipeline-bundle-root',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /machine-design-cli\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return {
        contents: wrapTopLevelAwait(source.replaceAll('import.meta.dirname', '__acadBundleDesktopRoot(__dirname)')),
        loader: 'js',
        resolveDir: dirname(args.path)
      };
    });
  }
};

/**
 * 入口脚本有 top-level await（等异步价目表），而 CJS 输出格式不支持 TLA。
 * 处理：静态 import 留在模块顶层（esbuild 会把它们编成 require），其余语句整体包进 async IIFE；
 * 未捕获的 rejection 一律 console.error + exit 1，绝不静默成功。
 */
function wrapTopLevelAwait(source) {
  const lines = source.split('\n');
  let lastImport = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^import\s/.test(lines[index])) lastImport = index;
  }
  const head = lines.slice(0, lastImport + 1).join('\n');
  const body = lines.slice(lastImport + 1).join('\n');
  return `${head}
;(async () => {
${body}
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
}

const rootResolver = `
function __acadBundleDesktopRoot(dir) {
  var path = require('node:path');
  var fs = require('node:fs');
  var candidates = [
    path.resolve(dir, '..'),
    path.resolve(dir, '..', '..', '..'),
    path.resolve(dir, '..', '..')
  ];
  for (var i = 0; i < candidates.length; i += 1) {
    if (fs.existsSync(path.join(candidates[i], 'packs', 'builtin'))) {
      return path.join(candidates[i], '__bundle__', '__desktop__');
    }
  }
  return path.resolve(dir, '..', '..');
}
`;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // 独占一份运行时：node 内置模块由 platform:'node' 自动外置；
  // 仓库内 src/**/*.ts 必须打进来，所以 external 只能是空的（没有第三方运行时依赖）。
  external: [],
  plugins: [bundleRootPlugin],
  banner: { js: rootResolver.trim() },
  logLevel: 'warning'
});

const bytes = (await stat(outfile)).size;
console.log(`BUILD_PIPELINE_OK bytes=${bytes}`);

// 打完立即自证：单文件产物真能算出整机方案。
// cycleMs 只在 --linkage 分支输出（machine-design-cli.mjs:226-247，Qt 的联动调试就吃这一段），
// 所以自检命令带上 --linkage —— 只跑 --with-geometry 时 JSON 里没有 cycleMs，别把「没跑」当「跑通」。
const brief = '两工位上下料机：气缸推料，气爪上下料';
const probe = spawnSync(process.execPath, [outfile, '--brief', brief, '--with-geometry', '--linkage'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
if (probe.status !== 0) {
  console.error(`BUILD_PIPELINE_SELFTEST_FAIL exit=${probe.status} stderr=${(probe.stderr ?? '').trim().slice(0, 400)}`);
  process.exit(1);
}
let document;
try {
  document = JSON.parse(probe.stdout);
} catch {
  console.error(`BUILD_PIPELINE_SELFTEST_FAIL 输出不是 JSON：${(probe.stdout ?? '').slice(0, 200)}`);
  process.exit(1);
}
const cycleMs = document?.linkage?.cycleMs;
if (typeof cycleMs !== 'number' || !Number.isFinite(cycleMs) || cycleMs <= 0) {
  console.error('BUILD_PIPELINE_SELFTEST_FAIL JSON 里没有有效的 linkage.cycleMs');
  process.exit(1);
}
console.log(`BUILD_PIPELINE_SELFTEST_OK cycleMs=${cycleMs} stations=${Array.isArray(document.stations) ? document.stations.length : '?'} axes=${document?.linkage?.axisCount ?? '?'}`);
