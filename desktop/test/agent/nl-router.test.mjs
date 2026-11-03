import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentRegistry } from '../../test-support/agent-registry.mjs';
import {
  INTENT_LABELS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  describePlan,
  extractQuery,
  planReadOnly,
  planTool,
  planToolSequence,
  routeIntent
} from '../../src/agent/router.ts';
import { CONTEXT_BYTE_LIMIT, buildAgentContext, byteLength } from '../../src/agent/context.ts';
import {
  createAuditLog,
  formatAuditLine,
  maskSecrets,
  parseAuditLines,
  redactValue,
  summarizeAudit
} from '../../src/agent/audit.ts';
import { AgentSession } from '../../src/agent/session.ts';

test('规则路由覆盖 7 类中文意图', () => {
  const cases = [
    ['列一下所有接触器', 'query'],
    ['这台机台成本多少', 'compute'],
    ['插入一个气缸', 'modify'],
    ['导出一份 CSV 报价单', 'generate'],
    ['上电跑一遍联调序列', 'commission'],
    ['把设计包同步到智慧工厂', 'sync'],
    ['今天天气怎么样', 'out_of_scope']
  ];
  for (const [text, expected] of cases) {
    assert.equal(routeIntent(text).intent, expected, `${text} 应判为 ${expected}`);
  }
  assert.equal(Object.keys(INTENT_LABELS).length, 7);
});

test('写意图优先于查询：同一句里既有搜索又有插入', () => {
  const match = routeIntent('搜索 SMC 气缸并插入一个占位件');
  assert.equal(match.intent, 'modify');
  assert.ok(match.hits.includes('插入'));
});

test('只读计划：成本、清单、BOM、干涉、电气校验', () => {
  assert.equal(planReadOnly('这台机台成本多少')?.tool, 'run_cost_report');
  assert.equal(planReadOnly('读一下当前 BOM')?.tool, 'get_bom');
  assert.equal(planReadOnly('检查有没有干涉')?.tool, 'run_interference_check');
  assert.equal(planReadOnly('电气校验线号有没有重复')?.tool, 'run_electrical_check');
  assert.equal(planReadOnly('看下当前渲染状态和拖动帧率')?.tool, 'get_render_stats');
  const listPlan = planReadOnly('列一下所有接触器');
  assert.equal(listPlan?.tool, 'list_components');
  assert.deepEqual(listPlan?.args, { category: '接触器' });
});

test('写计划永远不会被离线通道执行', () => {
  for (const text of ['插入一个气缸', '导出一份 PDF 报价单', '撤销上一步', '导入 step 文件']) {
    assert.equal(planReadOnly(text), null, `${text} 不应产生只读计划`);
  }
  const writePlan = planTool('导出一份 CSV 报价单');
  assert.equal(writePlan?.tool, 'export_cost_report');
  assert.equal(writePlan?.readOnly, false);
  assert.deepEqual(writePlan?.args, { format: 'csv' });
  assert.equal(planTool('插入一个气缸')?.missing.includes('partId'), true);
});

test('只读/写工具清单与注册表一致且互不重叠', () => {
  const registry = agentRegistry();
  assert.equal(READ_ONLY_TOOLS.size + WRITE_TOOLS.size, registry.total);
  for (const name of registry.names) assert.ok(READ_ONLY_TOOLS.has(name) || WRITE_TOOLS.has(name), `${name} 未分类`);
  assert.equal(WRITE_TOOLS.has('place_component'), true);
  for (const name of READ_ONLY_TOOLS) assert.equal(WRITE_TOOLS.has(name), false, `${name} 同时被标为读写`);
});

test('类别同义词按最长匹配：热继电器不会被继电器抢走', () => {
  assert.deepEqual(planReadOnly('列出所有热继电器')?.args, { category: '热继电器' });
  assert.deepEqual(planReadOnly('找一下安全继电器')?.args, { category: '安全继电器' });
  assert.deepEqual(planReadOnly('有哪些开关电源')?.args, { category: '开关电源' });
});

test('搜索词抽取去掉客套话、动词与疑问词', () => {
  assert.equal(extractQuery('帮我搜一下 SMC 气缸'), 'SMC');
  assert.equal(extractQuery('查一下型号 24V 电源'), '24V');
  assert.equal(extractQuery('有哪些接触器'), '');
});

test('超纲指令不产生计划', () => {
  for (const text of ['今天天气怎么样', '你好', '讲个笑话', '']) {
    assert.equal(planReadOnly(text), null);
    assert.equal(planTool(text), null);
  }
});

test('指代词不进入搜索词，歧义指令不猜工具', () => {
  assert.deepEqual(planReadOnly('左边第二个空开是什么型号')?.args, { category: '断路器' });
  assert.deepEqual(planReadOnly('这台机台有几个气缸')?.args, { category: '气缸' });
  assert.equal(extractQuery('刚才那个接触器'), '');

  for (const text of ['把它改一下', '查一下那个', '左边那个换掉', '再算一遍', '那个东西多少钱']) {
    assert.equal(planTool(text), null, `${text} 应追问而不是调用工具`);
  }
});

test('联调/同步未注册工具时不误落到元件搜索', () => {
  for (const text of ['上电跑一遍联调序列', '查一下当前报警并给故障诊断', '把设计包同步到智慧工厂', '上传设计包并查看版本对比']) {
    assert.equal(planTool(text), null, `${text} 不应产生工具计划`);
  }
});

test('多步指令按顺序规划，任一步缺失则整单不执行', () => {
  const steps = planToolSequence('先查一下 SMC 气缸，再算一下整机成本');
  assert.deepEqual(steps?.map((step) => step.tool), ['search_components', 'run_cost_report']);
  assert.deepEqual(steps?.[0]?.args, { q: 'SMC', category: '气缸' });

  const writeSteps = planToolSequence('查一下 SMC 气缸并插入到 2 号工位');
  assert.deepEqual(writeSteps?.map((step) => step.tool), ['search_components', 'insert_component']);
  assert.equal(writeSteps?.[1]?.missing.includes('partId'), true);

  assert.equal(planToolSequence('读一下当前 BOM，然后讲个笑话'), null);
});

test('写操作参数抽取：物料号与 CAD 路径', () => {
  assert.deepEqual(planTool('插入物料号 LC1D09 的接触器')?.args, { partId: 'LC1D09' });
  assert.equal(planTool('插入一个气缸')?.missing.includes('partId'), true);
  assert.deepEqual(planTool('导入 step 文件 D:\\fixtures\\station.step')?.args, {
    path: 'D:\\fixtures\\station.step'
  });
});

test('计划描述为中文且写操作有标注', () => {
  const readPlan = planReadOnly('这台机台成本多少');
  assert.match(describePlan(readPlan), /成本/);
  assert.match(describePlan(planTool('插入一个气缸')), /写操作/);
});

test('上下文裁剪：超出 2 KB 时先删描述再删工具', () => {
  const tools = Array.from({ length: 300 }, (_unused, index) => ({
    name: `tool_${index}`,
    description: '很长的工具说明'.repeat(8)
  }));
  const packed = buildAgentContext({ tools, recent: [{ name: 'a', ok: true }] });
  assert.ok(packed.bytes <= CONTEXT_BYTE_LIMIT, `实际 ${packed.bytes} 字节`);
  assert.equal(packed.truncated, true);
  assert.ok(packed.droppedTools > 0);
  assert.ok(packed.text.startsWith('[工程上下文]'));
});

test('上下文裁剪：小上下文不丢信息', () => {
  const packed = buildAgentContext({
    tools: [{ name: 'get_bom', description: '读取 BOM' }],
    project: '烟包机',
    deviceNo: 'SF-01',
    selection: { id: 'iC65N-C16-1P', tag: 'QF1' }
  });
  assert.equal(packed.truncated, false);
  assert.equal(packed.droppedTools, 0);
  assert.match(packed.text, /QF1/);
  assert.match(packed.text, /get_bom/);
  assert.equal(byteLength(packed.text), packed.bytes);
});

test('审计脱敏：sk-、Bearer、token 字段与参数名都不能落原文', () => {
  assert.equal(maskSecrets('sk-live-abcdef123456').includes('abcdef123456'), false);
  assert.equal(maskSecrets('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'), false);
  assert.equal(maskSecrets('api_key=plain-secret-value').includes('plain-secret-value'), false);
  const redacted = redactValue({ apiKey: 'sk-live-abcdef123456', nested: { token: 'tp-1234567890' }, q: '接触器' }) ;
  assert.equal(JSON.stringify(redacted).includes('abcdef123456'), false);
  assert.equal(JSON.stringify(redacted).includes('1234567890'), false);
  assert.equal(redacted.q, '接触器');
});

test('审计写入与解析：NDJSON 一行一条，坏行跳过', () => {
  const lines = [];
  const log = createAuditLog({ write: (line) => lines.push(line) });
  log.record({ tool: 'run_cost_report', ok: true, source: 'offline', args: { apiKey: 'sk-live-abcdef123456' } });
  log.record({ tool: 'get_bom', ok: false, code: 'BOOM' });
  assert.equal(lines.length, 2);

  const parsed = parseAuditLines(`${lines.join('\n')}\n不是 JSON\n`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].tool, 'run_cost_report');
  assert.equal(parsed[0].source, 'offline');
  assert.equal(parsed[1].ok, false);

  const summary = summarizeAudit(parsed);
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.tools.get_bom, 1);
});

test('审计写入失败不影响主流程', () => {
  const errors = [];
  const log = createAuditLog({ write: () => { throw new Error('磁盘满'); }, onError: (error) => errors.push(error) });
  assert.doesNotThrow(() => log.record({ tool: 'get_bom', ok: true }));
  assert.equal(errors.length, 1);
  assert.equal(log.entries.length, 0);
});

test('审计行时间可注入，便于回归比对', () => {
  const line = formatAuditLine({ tool: 'get_bom', ok: true }, new Date('2026-10-23T00:00:00.000Z'));
  assert.equal(JSON.parse(line).at, '2026-10-23T00:00:00.000Z');
});

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function createBus(handler) {
  const calls = [];
  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      if (handler) return await handler(name, args);
      return { ok: true, data: { name, args } };
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: { command: 'insert_component' } };
    }
  };
}

test('模型不可用时自动降级到只读规则路由并写审计', async () => {
  const llm = { async chat() { throw new Error('fetch failed'); } };
  const bus = createBus(async () => ({ ok: true, data: { totals: { grand: 1398.64 } } }));
  const audit = [];
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => false,
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('这台机台成本多少');
  assert.match(reply, /离线规则路由/);
  assert.match(reply, /1398.64/);
  assert.deepEqual(bus.calls, [{ name: 'run_cost_report', args: {} }]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].source, 'offline');
  assert.equal(audit[0].ok, true);
});

test('离线问答：工具层结果（无 data 字段）也要把命中来源写进回答', async () => {
  // search_docs 这类工具层工具由 agentExecutor 兜底返回 {ok, query, hits}，没有 data。
  // 回归：只序列化 result.data 会让离线文档问答只剩「已执行」而看不到 source/heading。
  const llm = { async chat() { throw new Error('fetch failed'); } };
  const bus = createBus(async () => ({
    ok: true,
    query: 'D2 决策',
    hits: [{ source: 'docs/desktop/NL-AGENT.md', heading: '4.1 本地知识检索', snippet: '离线 RAG', score: 3.2 }]
  }));
  const session = new AgentSession({ llm, bus, confirmWrite: async () => false });
  const reply = await session.run('D2 是什么决策');
  assert.match(reply, /离线规则路由/);
  assert.deepEqual(bus.calls, [{ name: 'search_docs', args: { query: 'D2 决策' } }]);
  assert.match(reply, /docs\/desktop\/NL-AGENT\.md/);
  assert.match(reply, /"heading":"4.1 本地知识检索"/);
  assert.equal(session.mode(), 'offline');
});

test('模型不可用且指令是写操作时明确拒绝，不执行命令', async () => {
  const llm = { async chat() { throw new Error('网络不可达'); } };
  const bus = createBus();
  const session = new AgentSession({ llm, bus, confirmWrite: async () => true });
  await assert.rejects(() => session.run('插入一个气缸'), /网络不可达/);
  assert.equal(bus.calls.length, 0);
});

test('模型正常时审计记录 llm 来源与结果码', async () => {
  const llm = {
    async chat() {
      return { content: '', toolCalls: [toolCall('call-1', 'get_bom')] };
    }
  };
  const responses = [
    { content: '', toolCalls: [toolCall('call-1', 'get_bom')] },
    { content: 'BOM 已读取。', toolCalls: [] }
  ];
  let index = 0;
  llm.chat = async () => responses[Math.min(index++, responses.length - 1)];
  const bus = createBus(async () => ({ ok: false, error: { code: 'BOOM', message: '失败' } }));
  const audit = [];
  const session = new AgentSession({ llm, bus, confirmWrite: async () => true, audit: (record) => audit.push(record) });
  const reply = await session.run('读一下 BOM');
  assert.equal(reply, 'BOM 已读取。');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].source, 'llm');
  assert.equal(audit[0].code, 'BOOM');
});
