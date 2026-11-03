// 机型库抽屉的真机截图（docs/desktop/screenshots/24-machine-library.png）。
//
// 不加模型桩：机型库不依赖智能体。主进程侧（electron/library-screenshot.ts）先用
// saveToLibrary() 往这次 headless 的临时 userData 里预置两台机型，再通过真实 preload →
// `library:list` IPC 打开抽屉、断言两行都渲染出来，最后 capturePage 抓图。
//
// 这里（脚本侧）只负责：起 xvfb + 真 Electron，然后**独立**再验一遍产物
// （文件存在、> 150 KB、PNG 魔数），并打印 `LIBRARY_SHOT_OK bytes=… path=…`。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');
const shotPath = join(outputDir, '24-machine-library.png');
const MIN_BYTES = 150 * 1024;

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });

let child = null;
try {
  const env = {
    ...process.env,
    // root 下跑 Electron 必须关沙箱（CI 与本地都是 root）
    ELECTRON_DISABLE_SANDBOX: '1',
    AUTOMATIONCAD_SCREENSHOT_DIR: outputDir
  };
  const electronArgs = ['.', '--headless-library-shots'];
  const xvfbArgs = ['-a', '-s', '-screen 0 1920x1200x24', electronBin, ...electronArgs];
  const command = existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : electronBin;
  const args = command === 'xvfb-run' ? xvfbArgs : electronArgs;
  child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' });

  // 看门狗：整个流程 4 分钟没结束就强杀，避免 CI 步骤无限挂住
  const watchdog = setTimeout(() => {
    console.error('LIBRARY_SCREENSHOT_TIMEOUT 4 分钟内未完成，强制结束');
    if (child && !child.killed) child.kill('SIGKILL');
  }, 4 * 60_000);
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
  console.error(`LIBRARY_SCREENSHOT_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
}

// 产物自证：不信任子进程的日志，脚本自己再验一遍
if (!process.exitCode) {
  if (!existsSync(shotPath)) {
    console.error(`LIBRARY_SCREENSHOT_MISSING ${shotPath}`);
    process.exitCode = 1;
  } else {
    const png = readFileSync(shotPath);
    const bytes = statSync(shotPath).size;
    const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    if (!isPng) {
      console.error(`LIBRARY_SCREENSHOT_NOT_PNG ${shotPath}`);
      process.exitCode = 1;
    } else if (bytes <= MIN_BYTES) {
      console.error(`LIBRARY_SCREENSHOT_TOO_SMALL bytes=${bytes} 阈值=${MIN_BYTES} path=${shotPath}`);
      process.exitCode = 1;
    } else {
      const sha256 = createHash('sha256').update(png).digest('hex');
      console.log(`LIBRARY_SHOT_OK bytes=${bytes} path=${shotPath} sha256=${sha256}`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
