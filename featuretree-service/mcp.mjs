// FeatureTree MCP 服务（stdio，JSON-RPC 2.0）：把契约服务的 HTTP 接口暴露成 MCP 工具，
// 供 MCP 客户端（Claude Desktop / Codex / 自研 agent）读写同一份特征树。
//
// 设计要点（契约 §9「MCP 与 Qt 的映射」）：
// - 这里不复制业务逻辑，所有写操作都转给 featuretree-service（乐观锁、校验、事务都在那边）；
// - 每次写都必须带 expectedRevision，冲突原样返回 409 语义，绝不自动覆盖；
// - 工具结果只回结构化数据 + 一句中文说明，不编造几何。
//
// 用法：FT_BASE=http://127.0.0.1:18080 node mcp.mjs
import { createInterface } from 'node:readline';

const BASE = (process.env.FT_BASE || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'ft_get_tree',
    description: '读取当前 FeatureTree 包络（revision / 特征 / 历史）。写之前必须先读，拿到的 revision 就是 expectedRevision。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'ft_update_params',
    description: '修改单个特征的参数（写操作，必须带 expectedRevision；只接受服务端白名单字段：length/width/height/diameter/cbDiameter/cbDepth/radius）。',
    inputSchema: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: '特征 id，如 f-body' },
        patch: { type: 'object', description: '要改的字段，如 {"height": 14}', additionalProperties: true },
        expectedRevision: { type: 'number', description: '读到的版本号' },
        agentId: { type: 'string', description: '调用方标识，写进历史留痕' }
      },
      required: ['featureId', 'patch', 'expectedRevision'],
      additionalProperties: false
    }
  },
  {
    name: 'ft_set_suppressed',
    description: '压缩/解除压缩某个特征（写操作，必须带 expectedRevision）。压缩后体积会变，服务端会真重建。',
    inputSchema: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: '特征 id，如 f-holes-out' },
        suppressed: { type: 'boolean', description: 'true=压缩，false=解除压缩' },
        expectedRevision: { type: 'number' },
        agentId: { type: 'string' }
      },
      required: ['featureId', 'suppressed', 'expectedRevision'],
      additionalProperties: false
    }
  },
  {
    name: 'ft_delete_feature',
    description: '删除特征（写操作，必须带 expectedRevision）。被其他特征引用的基体会被服务端拒绝（REFERENCE_IN_USE），不要重试同样的调用。',
    inputSchema: {
      type: 'object',
      properties: {
        featureId: { type: 'string' },
        expectedRevision: { type: 'number' },
        agentId: { type: 'string' }
      },
      required: ['featureId', 'expectedRevision'],
      additionalProperties: false
    }
  },
  {
    name: 'ft_undo',
    description: '撤销最近 N 个版本（写操作，产生新 revision，历史不删除）。',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'number' },
        steps: { type: 'number', minimum: 1 },
        agentId: { type: 'string' }
      },
      required: ['expectedRevision'],
      additionalProperties: false
    }
  },
  {
    name: 'ft_list_revisions',
    description: '读取历史记录（谁在什么时候改了什么，含指纹）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

const RESOURCES = [
  {
    uri: 'featuretree://current/tree',
    name: '当前 FeatureTree',
    description: '只读快照：当前 revision 与特征树全文',
    mimeType: 'application/json'
  }
];

async function callService(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function runTool(name, args) {
  if (name === 'ft_get_tree') {
    const { status, payload } = await callService('GET', '/v1/tree');
    if (status !== 200 || !payload) return textResult(`读取特征树失败（HTTP ${status}）`, true);
    return textResult(JSON.stringify({ revision: payload.revision, features: payload.doc.features }));
  }
  if (name === 'ft_list_revisions') {
    const { status, payload } = await callService('GET', '/v1/revisions');
    if (status !== 200 || !payload) return textResult(`读取历史失败（HTTP ${status}）`, true);
    return textResult(JSON.stringify({ revision: payload.revision, history: payload.history }));
  }
  if (name === 'ft_update_params') {
    const { status, payload } = await callService('POST', '/v1/operations', {
      documentId: 'demo-adapter',
      expectedRevision: args.expectedRevision,
      actor: 'agent',
      agentId: args.agentId || 'mcp-client',
      operation: 'updateFeatureParams',
      featureId: args.featureId,
      patch: args.patch
    });
    if (status === 200 && payload) {
      return textResult(JSON.stringify({ ok: true, revision: payload.revision, features: payload.doc.features }));
    }
    const code = payload?.error || `HTTP_${status}`;
    const hint = code === 'CONFLICT_STALE_REVISION'
      ? '版本已过期：请重新 ft_get_tree 后再提交，不要覆盖别人的修改。'
      : code === 'UNKNOWN_FIELD'
        ? '该字段不能直接改（服务端只接受 length/width/height/diameter/cbDiameter/cbDepth/radius）。'
        : '写入被拒绝，文档未改变。';
    return textResult(JSON.stringify({ ok: false, code, message: payload?.message || '', hint }), true);
  }
  if (name === 'ft_set_suppressed' || name === 'ft_delete_feature') {
    const isSuppress = name === 'ft_set_suppressed';
    const { status, payload } = await callService('POST', '/v1/operations', {
      documentId: 'demo-adapter',
      expectedRevision: args.expectedRevision,
      actor: 'agent',
      agentId: args.agentId || 'mcp-client',
      operation: isSuppress ? 'setSuppressed' : 'deleteFeature',
      featureId: args.featureId,
      ...(isSuppress ? { suppressed: args.suppressed } : {})
    });
    if (status === 200 && payload) {
      return textResult(JSON.stringify({
        ok: true,
        revision: payload.revision,
        features: payload.doc.features,
        ...(payload.geometry ? { geometry: payload.geometry } : {})
      }));
    }
    const code = payload?.error || `HTTP_${status}`;
    const hint = code === 'CONFLICT_STALE_REVISION'
      ? '版本已过期：请重新 ft_get_tree 后再提交。'
      : code === 'REFERENCE_IN_USE'
        ? '该特征被其他特征引用（如孔/沉头依赖基体），先处理引用方再删；不要原样重试。'
        : '操作被拒绝，文档未改变。';
    return textResult(JSON.stringify({ ok: false, code, message: payload?.message || '', hint }), true);
  }
  if (name === 'ft_undo') {
    const { status, payload } = await callService('POST', '/v1/undo', {
      documentId: 'demo-adapter',
      expectedRevision: args.expectedRevision,
      actor: 'agent',
      agentId: args.agentId || 'mcp-client',
      steps: args.steps ?? 1
    });
    if (status === 200 && payload) return textResult(JSON.stringify({ ok: true, revision: payload.revision, features: payload.doc.features }));
    return textResult(JSON.stringify({ ok: false, code: payload?.error || `HTTP_${status}`, message: payload?.message || '' }), true);
  }
  return textResult(`工具不存在：${name}`, true);
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request = null;
  try {
    request = JSON.parse(trimmed);
  } catch {
    replyError(null, -32700, 'JSON 解析失败');
    return;
  }
  const { id, method, params } = request || {};
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'featuretree-service', version: '0.1.0' }
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) { replyError(id, -32602, `工具不存在：${name}`); return; }
      reply(id, await runTool(name, args));
      return;
    }
    if (method === 'resources/list') { reply(id, { resources: RESOURCES }); return; }
    if (method === 'resources/read') {
      if (params?.uri !== 'featuretree://current/tree') { replyError(id, -32602, `资源不存在：${params?.uri}`); return; }
      const { status, payload } = await callService('GET', '/v1/tree');
      if (status !== 200 || !payload) { replyError(id, -32000, `读取特征树失败（HTTP ${status}）`); return; }
      reply(id, { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify({ revision: payload.revision, doc: payload.doc }) }] });
      return;
    }
    replyError(id, -32601, `方法不存在：${method}`);
  } catch (error) {
    replyError(id, -32603, `内部错误：${error instanceof Error ? error.message : String(error)}`);
  }
});

// 启动即向 stderr 打一行，便于外部脚本确认进程起来了（stdout 只走 JSON-RPC）
console.error(`featuretree-mcp ready base=${BASE}`);
