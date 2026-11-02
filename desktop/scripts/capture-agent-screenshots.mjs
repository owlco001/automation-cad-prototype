// 智能体面板截图（初始 / 离线规则问答 / 审计）：起真实 Electron（xvfb + SwiftShader），
// 全部交互走真实 DOM（开抽屉、填输入框、点发送、刷审计）。
//
// 不联网、也没有模型桩：
// - 离线通道的触发条件是「模型请求失败」。这里用 net 现取一个**随即关闭**的回环端口当
//   LLM 端点，Electron 里的请求立刻 ECONNREFUSED → AgentSession.runOffline() → 规则路由
//   执行只读 search_docs。断言同时校验回执是「离线规则」（而不是在线模型）。
// - 沙箱：不写 ELECTRON_DISABLE_SANDBOX，交给 scripts/electron-run.mjs 按实际 uid 决定
//   （root 补 --no-sandbox，非 root 完全不加，CI 与生产同构）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const runner = join(here, 'electron-run.mjs');
const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}
if (!existsSync(runner)) {
  console.error(`启动器缺失：${runner}`);
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });

/** 取一个空闲回环端口后立刻关掉——之后没人监听，等于「模型不可达」。 */
function closedLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPort(new Error('回环端口分配失败'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

let child = null;
try {
  const port = await closedLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  console.log(`AGENT_SHOTS_OFFLINE_ENDPOINT ${baseUrl}（回环空端口，已关闭；不出本机）`);

  const env = {
    ...process.env,
    AUTOMATIONCAD_SCREENSHOT_DIR: outputDir,
    AUTOMATIONCAD_AGENT_OFFLINE_BASE_URL: baseUrl
  };
  // 三个 SwiftShader flag：xvfb 无 GPU，不加的话 3D 视口会退化成「WebGL 不可用」提示，
  // 还会弹出「检测到软件渲染」横幅盖住面板顶部。
  const electronArgs = [
    '--headless-agent-shots',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
  ];
  const command = existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : process.execPath;
  const args = existsSync('/usr/bin/xvfb-run')
    ? ['-a', '-s', '-screen 0 1920x1200x24', process.execPath, runner, ...electronArgs]
    : [runner, ...electronArgs];

  child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' });
  // 看门狗：三条离线查询各只等一次 ECONNREFUSED，正常 20s 内完事；卡住就强杀，别挂住 CI。
  const watchdog = setTimeout(() => {
    console.error('AGENT_SHOTS_TIMEOUT 6 分钟内未完成，强制结束');
    if (child && !child.killed) child.kill('SIGKILL');
  }, 6 * 60_000);
  child.once('exit', () => clearTimeout(watchdog));

  const code = await new Promise((resolveExit) => {
    child.on('error', (error) => {
      console.error(`截图进程启动失败：${error.message}`);
      resolveExit(1);
    });
    child.on('exit', (exitCode, signal) => {
      if (signal) {
        console.error(`截图进程被信号终止：${signal}`);
        resolveExit(1);
        return;
      }
      resolveExit(exitCode ?? 1);
    });
  });
  if (code !== 0) process.exitCode = code;
} catch (error) {
  console.error(`AGENT_SCREENSHOTS_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
}
if (process.exitCode) process.exit(process.exitCode);
