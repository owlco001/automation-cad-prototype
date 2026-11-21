#!/usr/bin/env node
/**
 * 以「和环境相称的沙箱设置」启动 Electron。
 *
 * 背景：Chromium 对 root 的检查发生在 C++ 层（`electron_main_delegate.cc:224`），
 * 早于主进程 JS 执行，所以 `main.ts` 里的 `app.commandLine.appendSwitch('no-sandbox')`
 * 只能影响渲染层偏好，救不了 root 启动失败。要跑起来只有两条路：命令行 `--no-sandbox`
 * 或 `ELECTRON_DISABLE_SANDBOX` 环境变量。
 *
 * 但这两条都不能写死在 npm 脚本里：CI 的 runner 是非 root，写死就等于**CI 永远不锻炼沙箱**
 * （2026-11-02 的日志实证：smoke 打的是 `SECURITY_NO_SANDBOX reason=env:ELECTRON_DISABLE_SANDBOX=1`）。
 *
 * 所以这里按实际 uid 决定：
 * - root（容器 / CI 镜像 / 本机 sudo）→ 补 `--no-sandbox`，并明确打印一行，避免静默；
 * - 非 root → 不加任何开关，让主进程的 `app.enableSandbox()` 生效，CI 与生产同构。
 *
 * 用法：`xvfb-run -a node scripts/electron-run.mjs --headless-design-webgl-smoke`
 */
import electronPath from 'electron';
import { spawnOwnedProcess, stopOwnedProcess } from './lib/owned-process.mjs';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const passthrough = process.argv.slice(2);
const flags = isRoot ? ['--no-sandbox'] : [];

if (isRoot) {
  console.warn(
    'ELECTRON_RUN_NO_SANDBOX reason=linux-root-uid0 —— Chromium 拒绝以 root 无沙箱启动；' +
      '这是运行环境限制，不是产品默认行为。生产（Windows 非 root）不会走到这里。'
  );
} else {
  console.log('ELECTRON_RUN_SANDBOXED uid=' + process.getuid() + ' —— 不加任何沙箱开关，由主进程 app.enableSandbox() 接管');
}

const child = spawnOwnedProcess(electronPath, ['.', ...flags, ...passthrough], { stdio: 'inherit' });
let finishing = null;
function finish(code) {
  if (finishing) return finishing;
  finishing = (async () => {
    try { await stopOwnedProcess(child); }
    catch (error) { console.error(`ELECTRON_RUN_CLEANUP_FAILED ${error.message}`); code = 1; }
    process.exitCode = code;
  })();
  return finishing;
}
child.on('error', (error) => {
  console.error(`ELECTRON_RUN_FAILED ${error.message}`);
  void finish(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`ELECTRON_RUN_SIGNAL ${signal}`);
  void finish(signal ? 1 : code ?? 0);
});
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => { void finish(code); });
}
