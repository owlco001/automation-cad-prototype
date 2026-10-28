// MCP ↔ 契约服务 双向验收：
//   1) MCP 写 → HTTP 读得到（Agent 改树，Qt/服务读得见）
//   2) HTTP 写 → MCP 读得到（手动改树，Agent 读得见）
// 会自己拉起服务（FT_PORT=0）与 mcp.mjs（stdio），跑完都关掉。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let failures = 0;
function ok(cond, label, extra = '') {
  if (cond) {
    console.log(`PASS: ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
}

// —— 起服务 ——
const service = spawn(process.execPath, [resolve(here, 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
});
let serviceLog = '';
service.stdout.setEncoding('utf8');
service.stdout.on('data', (chunk) => { serviceLog += chunk; });
let BASE = '';
for (let attempt = 0; attempt < 100 && !BASE; attempt += 1) {
  const match = serviceLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) BASE = `http://127.0.0.1:${match[1]}`;
  else await sleep(100);
}
if (!BASE) {
  console.error('MCP_TEST_FAIL 服务未起来', serviceLog.slice(0, 400));
  service.kill('SIGKILL');
  process.exit(1);
}

// —— 起 MCP（stdio） ——
const mcp = spawn(process.execPath, [resolve(here, 'mcp.mjs')], {
  env: { ...process.env, FT_BASE: BASE },
  stdio: ['pipe', 'pipe', 'pipe']
});
mcp.stderr.setEncoding('utf8');
mcp.stderr.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`));
const lines = createInterface({ input: mcp.stdout });
const pending = new Map();
let nextId = 1;
lines.on('line', (line) => {
  let message = null;
  try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (entry) {
    pending.delete(message.id);
    entry.resolve(message);
  }
});
function rpc(method, params, timeoutMs = 8000) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolveRpc, rejectRpc) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRpc(new Error(`MCP 响应超时：${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolveRpc(message); }
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function http(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json() };
}
const parseToolText = (message) => {
  const text = message?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return null; }
};

try {
  await sleep(300);
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  ok(init.result?.serverInfo?.name === 'featuretree-service', 'initialize 返回 serverInfo');

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((tool) => tool.name);
  const expectedTools = ['ft_get_tree', 'ft_update_params', 'ft_set_suppressed', 'ft_delete_feature', 'ft_undo', 'ft_list_revisions'];
  ok(names.length === expectedTools.length && expectedTools.every((n) => names.includes(n)),
    'tools/list 六个工具', JSON.stringify(names));

  const tree0 = parseToolText(await rpc('tools/call', { name: 'ft_get_tree', arguments: {} }));
  ok(tree0?.revision === 0 && tree0?.features?.length === 4, 'MCP 读到初始树 revision 0 / 4 特征');

  // 1) MCP 写 → HTTP 读到（Agent 改完，Qt/服务看得见）
  const write = parseToolText(await rpc('tools/call', {
    name: 'ft_update_params',
    arguments: { featureId: 'f-body', patch: { height: 13 }, expectedRevision: 0, agentId: 'mcp-test' }
  }));
  ok(write?.ok === true && write.revision === 1, 'MCP 写入成功并返回 revision 1', JSON.stringify(write).slice(0, 120));
  const afterMcp = await http('GET', '/v1/tree');
  ok(afterMcp.json.revision === 1 && afterMcp.json.doc.features[0].params.height === 13,
    'HTTP 侧读到 MCP 的修改（height=13, revision 1）');
  ok(afterMcp.json.history.at(-1).actor === 'agent:mcp-test', '历史留痕记为 agent:mcp-test');

  // 2) HTTP 写 → MCP 读（手动改完，Agent 看得见）
  const manual = await http('POST', '/v1/operations', {
    documentId: 'demo-adapter', expectedRevision: 1, actor: 'manual',
    operation: 'updateFeatureParams', featureId: 'f-fillet', patch: { radius: 5 }
  });
  ok(manual.status === 200 && manual.json.revision === 2, 'HTTP 侧手动改圆角 → revision 2');
  const viaMcp = parseToolText(await rpc('tools/call', { name: 'ft_get_tree', arguments: {} }));
  ok(viaMcp?.revision === 2 && viaMcp.features.find((f) => f.id === 'f-fillet')?.params.radius === 5,
    'MCP 读到 HTTP 侧的修改（radius=5, revision 2）');

  // 3) 旧 revision 写入必须被拒（乐观锁在 MCP 这一层也不能绕）
  const stale = await rpc('tools/call', {
    name: 'ft_update_params',
    arguments: { featureId: 'f-body', patch: { height: 99 }, expectedRevision: 0 }
  });
  const stalePayload = parseToolText(stale);
  ok(stale.result?.isError === true && stalePayload?.code === 'CONFLICT_STALE_REVISION',
    '旧 revision 经 MCP 写入被 CONFLICT_STALE_REVISION 拒绝', JSON.stringify(stalePayload).slice(0, 140));

  // 4) 资源 + 未知工具
  const resource = await rpc('resources/read', { uri: 'featuretree://current/tree' });
  const resourceText = resource.result?.contents?.[0]?.text ?? '';
  ok(resourceText.includes('"revision":2'), 'resources/read 返回当前 revision');
  const unknown = await rpc('tools/call', { name: 'ft_nope', arguments: {} });
  // 压缩/删除：都要真走服务端，且删除被引用基体必须把 REFERENCE_IN_USE 原样报出来
  const beforeSuppress = await rpc('tools/call', { name: 'ft_get_tree', arguments: {} });
  const beforePayload = JSON.parse(beforeSuppress.result.content[0].text);
  const currentRevision = beforePayload.revision;
  const suppressed = await rpc('tools/call', {
    name: 'ft_set_suppressed',
    arguments: { featureId: 'f-holes-out', suppressed: true, expectedRevision: currentRevision, agentId: 'mcp-test' }
  });
  const suppressedPayload = JSON.parse(suppressed.result.content[0].text);
  ok(suppressedPayload.ok === true && suppressedPayload.revision === currentRevision + 1,
    'MCP 压缩孔阵列成功并推进版本', JSON.stringify(suppressedPayload).slice(0, 140));
  ok(suppressedPayload.features.find((f) => f.id === 'f-holes-out')?.suppressed === true,
    '压缩状态回读为 true');
  // 几何需要 sidecar；这个脚本只验协议与并发语义，没接 sidecar 就如实跳过体积断言
  if (suppressedPayload.geometry) {
    ok(suppressedPayload.geometry.volumeMm3 > 95000, '压缩后体积变大（真几何）', JSON.stringify(suppressedPayload.geometry));
  } else {
    console.log('SKIP: 没接 build123d sidecar，跳过体积断言（协议层已验）');
  }

  const deleteReferenced = await rpc('tools/call', {
    name: 'ft_delete_feature',
    arguments: { featureId: 'f-body', expectedRevision: suppressedPayload.revision, agentId: 'mcp-test' }
  });
  const deletePayload = JSON.parse(deleteReferenced.result.content[0].text);
  ok(deleteReferenced.result.isError === true && deletePayload.code === 'REFERENCE_IN_USE',
    'MCP 删除被引用基体返回 REFERENCE_IN_USE', JSON.stringify(deletePayload).slice(0, 160));
  ok(String(deletePayload.hint || '').includes('引用'), '拒绝时给了「先处理引用方」的提示');

  const restored = await rpc('tools/call', {
    name: 'ft_set_suppressed',
    arguments: { featureId: 'f-holes-out', suppressed: false, expectedRevision: suppressedPayload.revision, agentId: 'mcp-test' }
  });
  const restoredPayload = JSON.parse(restored.result.content[0].text);
  ok(restoredPayload.ok === true, 'MCP 解除压缩成功');
  if (restoredPayload.geometry) {
    ok(Math.abs(restoredPayload.geometry.volumeMm3 - 94166.8) <= 1, 'MCP 解除压缩后体积复原', JSON.stringify(restoredPayload.geometry));
  }

  ok(unknown.error?.code === -32602, '未知工具返回 -32602');
} catch (error) {
  failures += 1;
  console.error('MCP_TEST_FAIL', error);
} finally {
  mcp.kill('SIGTERM');
  service.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('MCP_FEATURETREE_OK 双向读写 + 乐观锁 + 资源 全部通过');
