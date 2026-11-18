#!/usr/bin/env node
// 构建产物级沙箱守卫（跑在 `npm run build:ext` 之后，不读源码、只看 dist-electron）。
//
// 为什么不能照源码写断言：`scripts/build-electron.mjs` 开了 esbuild `minify:true`，
// 布尔字面量被压成 `!0` / `!1`。原来 CI 里那句 `grep "sandbox: true" dist-electron/main.cjs`
// 因此在**任何配置下都不可能匹配**（配置全对也红），等于没有任何守卫能力。
//
// 判据：凡是 webPreferences 里挂了 preload.cjs 的窗口（正常只有主窗口一个），
// 它同一个对象字面量里的 `sandbox` 必须是 true；压缩产物写成 `!0`，未压缩写成 `true`，两种都接受。
// 反例 `!1` / `false` 直接失败——这一次要能真的抓住「沙箱被关掉」。
//
// 注意：不能对全产物断言「不许出现 sandbox:!1」。`electron/diagnostics.ts` 的
// offscreen WebGL 探针窗口是故意无沙箱且不挂 preload 的，整包断言会永久误红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'dist-electron/main.cjs');

let source;
try {
  source = readFileSync(target, 'utf8');
} catch (error) {
  console.error(`SANDBOX_GUARD_FAIL 读不到产物 ${target}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// 压缩产物里主窗口那段是一条物理行：
//   webPreferences:{preload:(0,un.join)(__dirname,"preload.cjs"),contextIsolation:!0,...,sandbox:!0,...}
// 锚点 = "preload.cjs"；判定范围只往**前**看（sandbox 在同一个对象里、排在 preload 之后，
// esbuild 不重排属性），到下一个 `webPreferences:` 或下一个锚点为止——
// 这样不会把上一个/下一个窗口的 sandbox 值算到本窗口头上。
const BEFORE = 240;
const AFTER = 400;
const SANDBOX = /sandbox:\s*(!0|!1|true|false)/;

const anchors = [];
for (let at = source.indexOf('preload.cjs'); at >= 0; at = source.indexOf('preload.cjs', at + 1)) anchors.push(at);

const windows = [];
const skipped = [];
for (const at of anchors) {
  const lead = source.slice(Math.max(0, at - BEFORE), at);
  // 只认「webPreferences 里的 preload」；别处（注释、路径检查、additionalArguments）出现的字符串不算窗口
  if (!lead.includes('webPreferences')) { skipped.push(at); continue; }
  const nextAnchor = anchors.find((other) => other > at) ?? Number.POSITIVE_INFINITY;
  const tail = source.slice(at, Math.min(at + AFTER, nextAnchor));
  const nextObject = tail.indexOf('webPreferences:');
  const scope = nextObject > 0 ? tail.slice(0, nextObject) : tail;
  windows.push({ at, found: scope.match(SANDBOX)?.[1] ?? null });
}

if (windows.length === 0) {
  console.error(`SANDBOX_GUARD_FAIL 产物里找不到「webPreferences 挂 preload.cjs」的窗口（结构变了？）target=${target}`);
  process.exit(1);
}

const failures = windows
  .filter((window) => window.found === null || window.found === '!1' || window.found === 'false')
  .map((window) => ({ offset: window.at, sandbox: window.found ?? '(missing)' }));

if (failures.length > 0) {
  console.error(`SANDBOX_GUARD_FAIL ${failures.length}/${windows.length} 个 preload 窗口的 sandbox 不是 true：${JSON.stringify(failures)}`);
  console.error('修法：electron/main.ts 的 webPreferences 必须写 sandbox: true（不要改成 sandbox:false 来迁就 node 依赖）。');
  process.exit(1);
}

console.log(`SANDBOX_GUARD_OK preload_windows=${windows.length} sandbox=true target=${target}`);
if (skipped.length > 0) console.log(`SANDBOX_GUARD_NOTE 跳过了 ${skipped.length} 处非 webPreferences 的 preload.cjs 字样（不算窗口）`);
