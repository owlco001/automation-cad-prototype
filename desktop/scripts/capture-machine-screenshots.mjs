// 启动本地离线 OpenAI 兼容桩 + 真实 Electron（xvfb），抓取机型设计全流程截图。
// 不依赖外部模型；桩只返回一次 design_machine 工具调用和一次最终说明。
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');
const evalDir = join(repoRoot, 'docs', 'desktop', 'eval');
const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });
mkdirSync(evalDir, { recursive: true });

let requestCount = 0;
const stub = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requestCount += 1;
    let body = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasDesignToolResult = messages.some((message) => (
      message && message.role === 'tool' &&
      (message.name === 'design_machine' || String(message.content ?? '').includes('"bomDraft"'))
    ));
    console.log(`MACHINE_STUB_REQUEST n=${requestCount} messages=${messages.length} designResult=${hasDesignToolResult}`);
    const message = hasDesignToolResult
      ? {
          role: 'assistant',
          content: '已生成六工位锁螺丝机方案。方案卡包含 6 工位、12 个执行机构、7 个传感器；节拍估算 3.18 秒/件，方案功率约 2.18 kW / 3.7 A，建议 6A/3P 断路器，24V 余量 79%；成本粗估已分材料、电气、人工并标注缺价项。点击「应用到工程」可写入 3D、BOM 与 IO 点位。'
        }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_machine_case_1',
            type: 'function',
            function: {
              name: 'design_machine',
              arguments: JSON.stringify({ brief: BRIEF })
            }
          }]
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-offline-${requestCount}`,
      object: 'chat.completion',
      created: 0,
      model: 'offline-stub',
      choices: [{ index: 0, message, finish_reason: hasDesignToolResult ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
    }));
  });
});

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return rejectListen(new Error('桩服务端口分配失败'));
      resolveListen(address.port);
    });
  });
}

let child = null;
let server = null;
try {
  server = stub;
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  console.log(`MACHINE_STUB_LISTEN ${baseUrl}`);
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    AUTOMATIONCAD_SCREENSHOT_DIR: outputDir,
    AUTOMATIONCAD_EVAL_DIR: evalDir,
    AUTOMATIONCAD_STUB_BASE_URL: baseUrl
  };
  const electronArgs = ['.', '--headless-machine-screenshots'];
  const xvfbArgs = ['-a', '-s', '-screen 0 1920x1200x24', electronBin, ...electronArgs];
  const command = existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : electronBin;
  const args = command === 'xvfb-run' ? xvfbArgs : electronArgs;
  child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' });
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
  else {
    const rebuilt = spawnSync(process.execPath, [join(desktopRoot, 'scripts', 'build-machine-case.mjs')], {
      cwd: desktopRoot,
      env: process.env,
      stdio: 'inherit'
    });
    if (rebuilt.status !== 0) process.exitCode = rebuilt.status ?? 1;
  }
} catch (error) {
  console.error(`MACHINE_SCREENSHOTS_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
}
if (process.exitCode) process.exit(process.exitCode);
