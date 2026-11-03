// 外部客户端契约 smoke：起一个只跑服务的 Electron（--headless-service），
// 用真实 Bearer token 走 7420 的 MCP/JSON-RPC，验证外部客户端看到的东西没坏。
//
// 覆盖：未授权 401、tools/list 数量与关键工具、resources/list 三个 URI、
// resources/read 摘要、未知 URI 的 -32602、未知方法的 -32601，以及只读工具真调用。
// 不覆盖写操作的页面卡片确认（要等人点，120s 超时按拒绝）——那部分由 UI 冒烟覆盖。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentTools } from '../src/agent/tools.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
/** 工具数从注册表推导：加工具不用再回来改这个脚本（与 test/agent/tool-count-doc 同一口径）。 */
const EXPECTED_TOOL_COUNT = new AgentTools({ listParts: () => [] }).list().length;
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
/** 端口不写死：LAN 关闭时 agent 服务用随机端口，日志里有 [agent] http://127.0.0.1:PORT 这一行。 */
let endpoint = process.env.AUTOMATIONCAD_RPC_URL ?? '';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`MCP_SMOKE_OK ${name}${detail === undefined ? '' : ' ' + detail}`);
    return;
  }
  failures.push(`${name}: ${detail ?? '断言失败'}`);
  console.error(`MCP_SMOKE_FAIL ${name}${detail === undefined ? '' : ' ' + detail}`);
}

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}

const userData = mkdtempSync(join(tmpdir(), 'automationcad-mcp-smoke-'));
const env = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  AUTOMATIONCAD_SERVICE_USERDATA: userData
};
const child = spawn(electronBin, ['.', '--headless-service'], {
  cwd: desktopRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', (chunk) => { childLog += String(chunk); });
child.stderr.on('data', (chunk) => { childLog += String(chunk); });

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const match = childLog.match(/\[agent\] (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return `${match[1]}/rpc`;
    await sleep(250);
  }
  throw new Error('等待 agent 服务地址超时');
}

async function token() {
  const file = join(userData, 'agent-token');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    }
    await sleep(250);
  }
  throw new Error('等待 agent-token 超时');
}

async function rpc(method, params, { authorized = true, token: bearer = '' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authorized) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    signal: AbortSignal.timeout(20_000)
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

let exitCode = 0;
try {
  const bearer = await token();
  endpoint = await waitForEndpoint();
  console.log(`MCP_SMOKE_ENDPOINT ${endpoint}`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await rpc('tools/list', undefined, { token: bearer });
      if (probe.status === 200) break;
    } catch { /* 服务还没起来 */ }
    await sleep(500);
  }

  // 渲染层就绪前工具会被模块开关挡掉（cost/elec/plc 三组默认关闭，等界面加载完模块设置才开），
  // 所以先等 summary 资源可用，再断言工具数量，否则会误判成「工具丢了」。
  let rendererReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const probe = await rpc('resources/read', { uri: 'automationcad://project/current/summary' }, { token: bearer });
      const text = probe.body?.result?.contents?.[0]?.text ?? '';
      if (text.includes('"ok":true')) { rendererReady = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  check('渲染层就绪', rendererReady);

  const unauthorized = await rpc('tools/list', undefined, { authorized: false });
  check('unauthorized', unauthorized.status === 401, `status=${unauthorized.status}`);

  // 模块开关可能略晚于 summary 可用，给 10s 让工具全部注册
  let toolList = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await rpc('tools/list', undefined, { token: bearer });
    toolList = Array.isArray(response.body?.result?.tools) ? response.body.result.tools : [];
    if (toolList.length >= EXPECTED_TOOL_COUNT) break;
    await sleep(250);
  }
  const tools = { status: toolList.length > 0 ? 200 : 0 };
  check('tools/list', tools.status === 200 && toolList.length === EXPECTED_TOOL_COUNT,
    `count=${toolList.length} names=${toolList.map((tool) => tool.name).join(',')}`);
  for (const name of ['get_bom', 'build_canvas_assembly', 'save_scene_as_project', 'build_machine_model']) {
    check(`tool:${name}`, toolList.some((tool) => tool.name === name));
  }

  const resources = await rpc('resources/list', undefined, { token: bearer });
  const uris = (resources.body?.result?.resources ?? []).map((item) => item.uri);
  check('resources/list', uris.length === 3 && uris.every((uri) => uri.startsWith('automationcad://project/current/')),
    JSON.stringify(uris));

  const summary = await rpc('resources/read', { uri: 'automationcad://project/current/summary' }, { token: bearer });
  const summaryText = summary.body?.result?.contents?.[0]?.text ?? '';
  check('resources/read summary', summaryText.includes('"ok":true'), summaryText.slice(0, 80));

  const badResource = await rpc('resources/read', { uri: 'file:///etc/passwd' }, { token: bearer });
  check('resources/read 拒绝任意路径', badResource.body?.error?.code === -32602, JSON.stringify(badResource.body?.error));

  const unknownMethod = await rpc('does/not/exist', undefined, { token: bearer });
  check('未知方法', unknownMethod.body?.error?.code === -32601, JSON.stringify(unknownMethod.body?.error));

  const bom = await rpc('tools/call', { name: 'get_bom', arguments: {} }, { token: bearer });
  check('tools/call get_bom', bom.status === 200 && bom.body?.result !== undefined, `status=${bom.status}`);
} catch (error) {
  failures.push(`异常：${error instanceof Error ? error.message : String(error)}`);
  console.error('MCP_SMOKE_FAIL exception', error);
} finally {
  child.kill('SIGTERM');
  await sleep(600);
  if (!child.killed) child.kill('SIGKILL');
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}

if (failures.length > 0) {
  console.error('MCP_SMOKE_FAILED', failures.join(' | '));
  console.error('--- electron log tail ---');
  console.error(childLog.slice(-2000));
  exitCode = 1;
} else {
  console.log('MCP_SMOKE_DONE');
}
process.exit(exitCode);
