import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTEXT_BYTE_LIMIT,
  byteLength,
  collectAgentContext,
  serializeAgentContext,
  truncateUtf8
} from '../../src/agent/context.ts';
import {
  REFERENCE_CONFIDENCE_THRESHOLD,
  describeReference,
  hasReferenceExpression,
  resolveReference
} from '../../src/agent/reference.ts';
import {
  AgentMemory,
  TOOL_MEMORY_LIMIT,
  summarizeToolArguments,
  summarizeToolCall
} from '../../src/agent/memory.ts';
import {
  LIST_RESULT_LIMIT,
  LONG_TEXT_BYTE_LIMIT,
  TOOL_RESULT_BYTE_LIMIT,
  serializeToolResult,
  trimListResult,
  trimLongText,
  trimToolResult
} from '../../src/agent/trim.ts';
import { planTool } from '../../src/agent/router.ts';
import { buildPlanPreview } from '../../src/agent/preview.ts';
import { AgentSession } from '../../src/agent/session.ts';

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const placement = (id, label, x, y) => ({ id, label, x, y, w: 30, h: 40 });

test('上下文采集：没有 UI 状态时字段全为 null，不抛错', () => {
  const context = collectAgentContext();
  assert.equal(context.domain, null);
  assert.equal(context.view, null);
  assert.equal(context.selection, null);
  assert.equal(context.machine, null);
  assert.equal(context.plate, null);
  assert.deepEqual(context.recentActions, []);
  assert.equal(context.units, 'mm');
});

test('上下文采集：单个 provider 抛错只影响该字段', () => {
  const context = collectAgentContext({
    projectContext: () => { throw new Error('DOM 没了'); },
    recentActions: () => { throw new Error('历史没了'); }
  });
  assert.equal(context.selection, null);
  assert.deepEqual(context.recentActions, []);
});

test('上下文采集：域 / 视图 / 机型 / 底板归一化', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      domain: '电气',
      view: '底板',
      machine: { id: 'm1', name: '烟包机', stations: 4, actuators: 8, sensors: 12 },
      plate: { width: 600, height: 400, placed: 3, overlaps: 1 },
      units: 'mm'
    })
  });
  assert.equal(context.domain, 'elec');
  assert.equal(context.view, '底板');
  assert.deepEqual(context.machine, { name: '烟包机', stations: 4, actuators: 8, sensors: 12 });
  assert.deepEqual(context.plate, { width: 600, height: 400, placed: 3, overlaps: 1 });
});

test('上下文采集：CAD {name,bbox} 选中归一化为 component', () => {
  const context = collectAgentContext({
    projectContext: () => ({ selection: { name: '上料气缸', bbox: [0, 0, 0, 1, 1, 1] } })
  });
  assert.deepEqual(context.selection, { kind: 'component', id: '上料气缸', label: '上料气缸' });
});

test('上下文采集：显式选中类型与 placement 列表保留', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      selection: { kind: 'placement', id: 'p1', label: 'QF1' },
      plate: {
        width: 600,
        height: 400,
        placed: 2,
        placements: [
          { id: 'p1', tag: 'QF1', x: 10, y: 20, w: 30, h: 40 },
          { id: 'p2', model: 'KM1', x: 80, y: 20, w: 30, h: 40 }
        ]
      }
    })
  });
  assert.deepEqual(context.selection, { kind: 'placement', id: 'p1', label: 'QF1' });
  assert.equal(context.placements.length, 2);
  assert.equal(context.placements[1].label, 'KM1');
  assert.equal(context.plate.placed, 2);
});

test('上下文采集：最近操作只取最后 3 条且保持时间顺序', () => {
  const context = collectAgentContext({
    projectContext: () => ({ recentActions: Array.from({ length: 5 }, (_unused, index) => ({
      tool: `tool-${index}`,
      summary: `第 ${index} 次`,
      at: `2026-10-23T00:00:0${index}Z`
    })) })
  });
  assert.deepEqual(context.recentActions.map((entry) => entry.tool), ['tool-2', 'tool-3', 'tool-4']);
});

test('上下文序列化：≤1.5 KB，包含选中对象', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      domain: 'mech',
      view: '装配',
      selection: { kind: 'component', id: 'MXQ20-32-50', label: '上料气缸' },
      plate: { width: 600, height: 400, placed: 2, overlaps: 0 }
    })
  });
  const packed = serializeAgentContext(context);
  assert.equal(packed.truncated, false);
  assert.ok(packed.bytes <= CONTEXT_BYTE_LIMIT, `实际 ${packed.bytes} 字节`);
  assert.equal(byteLength(packed.text), packed.bytes);
  assert.match(packed.text, /上料气缸/);
  assert.match(packed.text, /\[工程上下文\]/);
});

test('上下文序列化：超限时先删最近操作再压长字段', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      view: '很长很长的视图名'.repeat(80),
      selection: { kind: 'placement', id: 'p1', label: 'QF1'.repeat(80) },
      plate: { width: 600, height: 400, placed: 3, overlaps: 0 },
      recentActions: Array.from({ length: 3 }, (_unused, index) => ({
        tool: `tool-${index}`,
        summary: '很长的操作摘要'.repeat(80),
        at: '2026-10-23T00:00:00Z'
      }))
    })
  });
  const packed = serializeAgentContext(context);
  assert.ok(packed.bytes <= CONTEXT_BYTE_LIMIT);
  assert.equal(packed.truncated, true);
  assert.ok(packed.droppedRecent > 0);
});

test('UTF-8 截断：不切断中文/emoji，也不产生替换字符', () => {
  const text = '中文😀abc';
  const truncated = truncateUtf8(text, 7, '');
  assert.equal(truncated, '中文');
  assert.equal(truncated.includes('\uFFFD'), false);
  assert.ok(byteLength(truncated) <= 7);
});

test('指代消解：优先选中对象，其次最近操作', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      selection: { kind: 'placement', id: 'p1', label: 'QF1' },
      recentActions: [{ tool: 'place_component', summary: '放置 KM1 [target=placement:p2:KM1]', at: 'x' }]
    })
  });
  const result = resolveReference('刚才那个改一下', context);
  assert.equal(result.target.id, 'p1');
  assert.equal(result.target.source, 'selection');
  assert.equal(result.reason, 'SELECTION');
  assert.ok(result.confidence >= REFERENCE_CONFIDENCE_THRESHOLD);
  assert.equal(describeReference(result), '已使用选中对象：QF1');
});

test('指代消解：无选中时回退到最近操作对象', () => {
  const context = collectAgentContext({
    projectContext: () => ({
      recentActions: [{ tool: 'place_component', summary: '放置 KM1 [target=placement:p2:KM1]', at: 'x' }]
    })
  });
  const result = resolveReference('刚才那个改一下', context);
  assert.equal(result.target.id, 'p2');
  assert.equal(result.target.source, 'recent');
  assert.equal(result.reason, 'RECENT_ACTION');
});

test('指代消解：没有候选对象不猜', () => {
  const result = resolveReference('这个改一下', collectAgentContext());
  assert.equal(result.target, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'NO_CANDIDATES');
});

test('指代消解：最近操作缺少对象信息时低置信度不猜', () => {
  const context = collectAgentContext({
    projectContext: () => ({ recentActions: [{ tool: 'update_component', summary: 'update_component 成功', at: 'x' }] })
  });
  const result = resolveReference('刚才那个改一下', context);
  assert.equal(result.target, null);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
  assert.ok(result.confidence < REFERENCE_CONFIDENCE_THRESHOLD);
});

test('几何指代：左边第二个按 x 升序取第二个', () => {
  const context = collectAgentContext({
    projectContext: () => ({ plate: {
      width: 600,
      height: 400,
      placements: [placement('p1', 'QF1', 200, 40), placement('p2', 'KM1', 20, 40), placement('p3', 'KA1', 80, 200)]
    } })
  });
  const result = resolveReference('左边第二个是什么型号', context);
  assert.equal(result.target.id, 'p3');
  assert.equal(result.target.label, 'KA1');
  assert.equal(result.target.source, 'geometry');
  assert.equal(result.reason, 'GEOMETRY');
});

test('几何指代：上面那个按 y 升序取最靠上的对象', () => {
  const context = collectAgentContext({
    projectContext: () => ({ plate: {
      width: 600,
      height: 400,
      placements: [placement('p1', 'QF1', 200, 120), placement('p2', 'KM1', 20, 30)]
    } })
  });
  const result = resolveReference('上面那个', context);
  assert.equal(result.target.id, 'p2');
});

test('几何指代：没有 placement 列表返回 NO_CANDIDATES', () => {
  const result = resolveReference('左边第二个', collectAgentContext({ projectContext: () => ({ view: '底板' }) }));
  assert.equal(result.target, null);
  assert.equal(result.reason, 'NO_CANDIDATES');
});

test('几何指代：序号越界返回 NO_CANDIDATES', () => {
  const context = collectAgentContext({
    projectContext: () => ({ plate: {
      width: 600,
      height: 400,
      placements: [placement('p1', 'QF1', 20, 40)]
    } })
  });
  const result = resolveReference('左边第五个', context);
  assert.equal(result.target, null);
  assert.equal(result.reason, 'NO_CANDIDATES');
});

test('非指代文本不触发消解', () => {
  const result = resolveReference('列出所有接触器', collectAgentContext());
  assert.equal(result.target, null);
  assert.equal(result.reason, 'NO_REFERENCE');
  assert.equal(hasReferenceExpression('放一个气缸'), false);
});

test('路由补全：选中对象填入 place_component 并在计划里标 resolvedFrom', () => {
  const context = collectAgentContext({
    projectContext: () => ({ selection: { kind: 'component', id: 'MXQ20-32-50', label: '上料气缸' } })
  });
  const plan = planTool('把这个放到 40, 60', context);
  assert.equal(plan.tool, 'place_component');
  assert.equal(plan.args.partId, 'MXQ20-32-50');
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.resolvedFrom, 'selection');
  assert.equal(plan.resolvedLabel, '上料气缸');
});

test('预览提示：显示「已使用选中对象：QF1」', () => {
  const context = collectAgentContext({
    projectContext: () => ({ selection: { kind: 'component', id: 'iC65N-C16-1P', label: 'QF1' } })
  });
  const preview = buildPlanPreview('把这个插入', context);
  assert.equal(preview.resolvedFrom, 'selection');
  assert.match(preview.hint, /已使用选中对象：QF1/);
});

test('会话记忆：只保留最近 5 条，顺序为旧到新', () => {
  const memory = new AgentMemory();
  for (let index = 0; index < 7; index += 1) {
    memory.record({ tool: `tool-${index}`, args: `q=${index}`, code: 'OK' });
  }
  assert.equal(memory.entries().length, TOOL_MEMORY_LIMIT);
  assert.deepEqual(memory.entries().map((entry) => entry.tool), ['tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6']);
});

test('会话记忆：提示包含工具名、关键参数与结果码，且不含敏感参数', () => {
  const entry = summarizeToolCall('search_components', { q: '接触器', apiKey: 'sk-secret' }, { ok: false, error: { code: 'NO_RESULT' } });
  const memory = new AgentMemory();
  memory.record(entry);
  const prompt = memory.prompt();
  assert.match(prompt, /\[最近工具调用\]/);
  assert.match(prompt, /search_components\(q=接触器\) → NO_RESULT/);
  assert.equal(prompt.includes('sk-secret'), false);
  assert.equal(summarizeToolArguments({ apiKey: 'x' }), '');
});

test('列表裁剪：20 条不截断，21 条一条不删只标 total/truncated', () => {
  const twenty = trimListResult(Array.from({ length: LIST_RESULT_LIMIT }, (_unused, index) => index));
  assert.equal(twenty.items.length, 20);
  assert.equal(twenty.truncated, false);
  const twentyOne = trimListResult(Array.from({ length: 21 }, (_unused, index) => index));
  // G2：条目一条都不许丢（旧实现切前 20，25 行 BOM 的消费方就拿到空数组）。
  assert.equal(twentyOne.items.length, 21);
  assert.equal(twentyOne.total, 21);
  assert.equal(twentyOne.truncated, true);
  assert.deepEqual(twentyOne.items, Array.from({ length: 21 }, (_unused, index) => index));
});

test('长文本裁剪：≤2 KB，附中文提示且不破坏字符', () => {
  const trimmed = trimLongText('中'.repeat(1000));
  assert.equal(trimmed.truncated, true);
  assert.ok(byteLength(trimmed.text) <= LONG_TEXT_BYTE_LIMIT);
  assert.match(trimmed.text, /已截断/);
  assert.equal(trimmed.text.includes('\uFFFD'), false);
});

test('工具结果裁剪：嵌套列表超过 20 条也一条不删', () => {
  const result = trimToolResult({ ok: true, data: { rows: Array.from({ length: 25 }, (_unused, index) => ({ index })) } });
  assert.equal(result.data.rows.items.length, 25);
  assert.equal(result.data.rows.total, 25);
  assert.equal(result.data.rows.truncated, true);
  assert.deepEqual(
    result.data.rows.items.map((row) => row.index),
    Array.from({ length: 25 }, (_unused, index) => index)
  );
});

test('工具结果序列化：>10 KB 时给 preview，最终不超过 10 KB', () => {
  const huge = { ok: true, ...Object.fromEntries(Array.from({ length: 8 }, (_unused, index) => [`field${index}`, '中'.repeat(2000)])) };
  const serialized = serializeToolResult(huge);
  assert.equal(serialized.truncated, true);
  assert.ok(serialized.bytes <= TOOL_RESULT_BYTE_LIMIT);
  const parsed = JSON.parse(serialized.text);
  assert.equal(parsed.truncated, true);
  assert.equal(typeof parsed.preview, 'string');
});

test('会话注入：系统提示包含上下文快照，工具调用后末尾追加记忆', async () => {
  const calls = [];
  let index = 0;
  const responses = [
    { content: '', toolCalls: [toolCall('c1', 'list_components', { category: '接触器' })] },
    { content: '完成', toolCalls: [] }
  ];
  const llm = {
    async chat(messages) {
      calls.push(messages);
      return responses[Math.min(index++, responses.length - 1)];
    }
  };
  const bus = {
    async execute() { return { ok: true, data: { count: 1 } }; },
    async undoLast() { return { ok: true, data: {} }; }
  };
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    contextProvider: () => collectAgentContext({
      projectContext: () => ({ selection: { kind: 'component', id: 'MXQ20', label: '上料气缸' } })
    })
  });
  await session.run('列出接触器');
  assert.match(calls[0][0].content, /\[工程上下文\]/);
  assert.match(calls[0][0].content, /上料气缸/);
  assert.match(calls[1][0].content, /\[最近工具调用\]/);
  assert.match(calls[1][0].content, /list_components\(category=接触器\) → OK/);
});

test('会话注入：上下文采集抛错不影响对话', async () => {
  const session = new AgentSession({
    llm: { async chat() { return { content: '好的', toolCalls: [] }; } },
    bus: { async execute() { return { ok: true }; }, async undoLast() { return { ok: true }; } },
    confirmWrite: async () => false,
    contextProvider: () => { throw new Error('UI 状态不可用'); }
  });
  assert.equal(await session.run('你好'), '好的');
});
