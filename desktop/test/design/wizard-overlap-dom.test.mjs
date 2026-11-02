import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDir = path.join(desktopDir, 'test-fixtures', 'wizard-overlap-electron');
const viteBin = path.join(desktopDir, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = path.join(desktopDir, 'node_modules', '.bin', 'electron');
const xvfbRun = '/usr/bin/xvfb-run';

// Windows 上没有 xvfb，spawn 会直接 ENOENT；不留假绿也不删用例：
// Windows 上显式 skip 并说明覆盖来源，Linux smoke job 仍跑这条真实 DOM 回归。
const domSkipReason = process.platform === 'win32'
  ? 'Windows CI 无 xvfb；Electron DOM 回归由 Linux smoke job 覆盖'
  : false;

test('真实 Electron DOM：布局重叠确认与越界阻断回归', { timeout: 120_000, skip: domSkipReason }, async (t) => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: desktopDir,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let viteOutput = '';
  vite.stdout.setEncoding('utf8').on('data', (chunk) => { viteOutput += chunk; });
  vite.stderr.setEncoding('utf8').on('data', (chunk) => { viteOutput += chunk; });
  t.after(() => stop(vite));

  await waitForHttp(`${baseUrl}/test-fixtures/wizard-overlap-electron/index.html`, vite, () => viteOutput);

  const electron = spawn(xvfbRun, [
    '-a',
    electronBin,
    path.join(fixtureDir, 'main.cjs'),
    `${baseUrl}/test-fixtures/wizard-overlap-electron/index.html`
  ], {
    cwd: desktopDir,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let electronOutput = '';
  electron.stdout.setEncoding('utf8').on('data', (chunk) => { electronOutput += chunk; });
  electron.stderr.setEncoding('utf8').on('data', (chunk) => { electronOutput += chunk; });
  t.after(() => stop(electron));

  const { code, signal } = await waitForExit(electron, 90_000, () => electronOutput);
  assert.equal(code, 0, `Electron DOM 回归测试失败（signal=${signal}）。\n${electronOutput}\nVite:\n${viteOutput}`);
  assert.match(electronOutput, /DOM_REGRESSION_RESULT .*"passed":9/,
    `Electron fixture 未报告九项通过。\n${electronOutput}`);
  console.log(electronOutput.trim());
});

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 Vite 测试端口');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHttp(url, child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite 提前退出：\n${getOutput()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Vite 尚未开始监听。 */ }
    await delay(100);
  }
  throw new Error(`等待 Vite 超时：\n${getOutput()}`);
}

function waitForExit(child, timeoutMs, getOutput) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Electron DOM 回归测试超时。\n${getOutput()}`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
