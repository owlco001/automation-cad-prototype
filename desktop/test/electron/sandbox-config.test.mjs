import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * 沙箱策略是"配置即安全边界"的地方，只能静态守护：
 * 任何一次为了省事把 sandbox 改回 false、或让 preload 重新 import node:path 的改动，
 * 都会让所有渲染进程悄悄退回无沙箱（Electron 45 已不再给沙箱 preload 提供 Node 内置）。
 * 真机证明在冒烟日志里（SECURITY_RENDERER_PRELOAD sandboxed=true）。
 */

const MAIN = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
const PRELOAD = readFileSync(new URL('../../electron/preload.ts', import.meta.url), 'utf8');

/** 去掉注释再断言：注释里会提到 sandbox: false / __dirname 这些"反例"字样。 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('主窗口与冒烟重开窗口都用 sandbox: true，不残留 sandbox: false', () => {
  const sandboxTrue = MAIN.match(/sandbox: true/g) ?? [];
  assert.ok(sandboxTrue.length >= 2, `期望至少 2 处 sandbox: true（主窗口 + 重开窗口），实际 ${sandboxTrue.length}`);
  const main = codeOnly(MAIN);
  assert.equal(/sandbox:\s*false/.test(main), false, 'main.ts 里不允许出现 sandbox: false');
  assert.equal(/nodeIntegration:\s*true/.test(main), false, 'nodeIntegration 必须保持 false');
  assert.ok(main.includes('contextIsolation: true'), 'contextIsolation 必须保持 true');
});

test('no-sandbox 只在 root / 显式环境变量下追加，并打 SECURITY_NO_SANDBOX', () => {
  const calls = MAIN.match(/appendSwitch\('no-sandbox'\)/g) ?? [];
  assert.equal(calls.length, 1, 'appendSwitch(\'no-sandbox\') 只允许出现在受控分支里一处');
  // 追加语句必须紧跟 if (NO_SANDBOX_REASON) 之后 200 字符内，不能被无条件执行
  assert.match(MAIN, /if \(NO_SANDBOX_REASON\) \{\s*app\.commandLine\.appendSwitch\('no-sandbox'\)/, 'no-sandbox 必须在 NO_SANDBOX_REASON 判定分支内');
  assert.ok(MAIN.includes('SECURITY_NO_SANDBOX reason='), '关沙箱必须留 SECURITY_NO_SANDBOX 日志');
  assert.ok(MAIN.includes('app.enableSandbox()'), '未关沙箱时必须进程级开启沙箱');
  assert.ok(MAIN.includes("process.platform === 'linux'") && MAIN.includes('process.getuid() === 0'), 'root 判定必须显式写出');
});

test('关闭沙箱的理由只有 root / AUTOMATIONCAD_NO_SANDBOX / ELECTRON_DISABLE_SANDBOX 三种', () => {
  const reasonFn = MAIN.match(/function sandboxDisabledReason\(\): string \| null \{[\s\S]*?\n\}/);
  assert.ok(reasonFn, '缺少 sandboxDisabledReason()');
  const body = reasonFn[0];
  assert.ok(body.includes('AUTOMATIONCAD_NO_SANDBOX'), '缺少显式排障开关');
  assert.ok(body.includes('ELECTRON_DISABLE_SANDBOX'), '缺少 Chromium 环境变量识别（npm 脚本用）');
  assert.ok(body.includes('linux-root-uid0'), '缺少 root 判定');
  // headless 不该成为关沙箱的理由：它是 CI/冒烟常态，放开等于常态无沙箱
  assert.equal(/HEADLESS|headless-/.test(body), false, 'sandboxDisabledReason 不应按 --headless-* 放宽沙箱');
});

test('preload 不含沙箱不可用的 Node 内置/全局（Electron 45 已移除）', () => {
  const code = codeOnly(PRELOAD);
  assert.equal(/from ['"]node:/.test(code), false, 'preload 不能 import node:*');
  assert.equal(/require\(['"]node:/.test(code), false, 'preload 不能 require node:*');
  assert.equal(/\b__dirname\b/.test(code), false, '沙箱 preload 没有 __dirname');
  assert.equal(/\bBuffer\b/.test(code), false, '沙箱 preload 没有 Buffer');
});

test('preload 的扩展基础地址改由主进程 additionalArguments 传入', () => {
  assert.ok(PRELOAD.includes('--cad-extension-base-url='), 'preload 必须从 argv 读取基础地址');
  assert.ok(PRELOAD.includes('process.argv'), 'preload 只能通过 process.argv（沙箱可用的最小面）取参数');
  assert.ok(MAIN.includes('additionalArguments: [`--cad-extension-base-url=${extensionBaseUrl()}`]'),
    'main.ts 必须把 app.getAppPath()/dist/ 的 file URL 传给 preload');
  assert.ok(MAIN.includes('function extensionBaseUrl()'), 'main.ts 应保留 extensionBaseUrl() 作为唯一来源');
});

test('渲染进程自报沙箱状态，主进程打 SECURITY_RENDERER_PRELOAD', () => {
  assert.ok(PRELOAD.includes('process.sandboxed === true'), 'preload 必须实测 process.sandboxed');
  assert.ok(PRELOAD.includes("'security:renderer-state'"), 'preload 必须上报沙箱状态');
  assert.ok(MAIN.includes("ipcMain.on('security:renderer-state'"), '主进程必须接收沙箱自述');
  assert.ok(MAIN.includes('SECURITY_RENDERER_PRELOAD sandboxed='), '主进程必须把沙箱自述打进日志');
});
