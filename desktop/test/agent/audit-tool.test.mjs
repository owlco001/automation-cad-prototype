// get_recent_audit：让模型自查失败历史。
// 重点不是「能读到」，而是**读到的东西是安全的**：只留白名单参数、凭据与绝对路径再胞一遍、
// 工具返回值内容一个字都不回；同时 limit/sinceMinutes 越界要夹紧而不是报错。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS } from '../../src/agent/router.ts';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const roots = [];
const stubRegistry = { listParts: () => [] };
const stubBridge = { call: async () => ({ ok: true }) };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 一条审计行；minutesAgo 决定它落在时间窗里还是外面。 */
function entry({ minutesAgo = 1, tool = 'run_plc_generate', ok = false, code = 'ESTOP_UNDEFINED', ms = 12, args = {} } = {}) {
  return {
    at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    tool,
    ok,
    ...(code ? { code } : {}),
    elapsedMs: ms,
    args
  };
}

/** userData 根目录 + 可选的 agent-audit.jsonl / 轮转份；总线注入固定时钟。 */
function setup({ current, rotated } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-audit-tool-'));
  roots.push(root);
  const write = (name, rows) => {
    if (!rows) return;
    writeFileSync(join(root, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };
  write('agent-audit.jsonl', current);
  write('agent-audit.1.jsonl', rotated);
  const bus = createAgentCommandBus(stubRegistry, stubBridge, { userDataRoot: root, now: () => NOW });
  return { root, bus };
}

async function read(bus, args = {}) {
  const result = await bus.execute('get_recent_audit', args);
  assert.equal(result.ok, true, `命令失败：${JSON.stringify(result.error)}`);
  return result.data;
}

test('工具注册与分类：get_recent_audit 已注册且属于只读', () => {
  const names = new AgentTools({ listParts: () => [] }).list().map((tool) => tool.name);
  assert.ok(names.includes('get_recent_audit'), '注册表里没有 get_recent_audit');
  assert.ok(READ_ONLY_TOOLS.has('get_recent_audit'), 'get_recent_audit 必须是只读工具（离线通道可执行、不弹确认）');
  const tool = new AgentTools({ listParts: () => [] }).list().find((item) => item.name === 'get_recent_audit');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['limit', 'onlyFailed', 'sinceMinutes', 'tool']);
});

test('工具层直连：AgentTools → CommandBus，limit 超限夹到 50 并平铺返回 items/total/truncated', async () => {
  const rows = Array.from({ length: 55 }, (_, index) => entry({ minutesAgo: index + 1 }));
  const { bus } = setup({ current: rows });
  const tools = new AgentTools(stubRegistry, bus);
  const result = await tools.call('get_recent_audit', { limit: 200, onlyFailed: true });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 50);
  assert.equal(result.total, 55);
  assert.equal(result.truncated, true);
  assert.ok(result.window.sinceMinutes === 1440);
});

test('默认 limit=10：返回最新 10 条，total 是过滤后截断前的条数', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => entry({ minutesAgo: index + 1 }));
  const { bus } = setup({ current: rows });
  const data = await read(bus);
  assert.equal(data.items.length, 10);
  assert.equal(data.total, 12);
  assert.equal(data.truncated, true);
  // 最新在前
  assert.equal(data.items[0].ts, rows[0].at);
  assert.equal(data.items[9].ts, rows[9].at);
});

test('limit 超过 50 被夹到 50（不报错，truncated 如实置 true）', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => entry({ minutesAgo: index + 1 }));
  const { bus } = setup({ current: rows });
  const data = await read(bus, { limit: 999 });
  assert.equal(data.items.length, 50);
  assert.equal(data.total, 60);
  assert.equal(data.truncated, true);
});

test('tool 按工具名精确过滤（不做前缀/模糊匹配）', async () => {
  const rows = [
    entry({ minutesAgo: 1, tool: 'run_plc_generate' }),
    entry({ minutesAgo: 2, tool: 'run_plc_generate_v2' }),
    entry({ minutesAgo: 3, tool: 'repair_plc_config', code: 'PRECHECK_FAILED' })
  ];
  const { bus } = setup({ current: rows });
  const data = await read(bus, { tool: 'run_plc_generate', limit: 10 });
  assert.equal(data.total, 1);
  assert.deepEqual(data.items.map((item) => item.tool), ['run_plc_generate']);
});

test('onlyFailed=true 只保留 ok:false 的记录', async () => {
  const rows = [
    entry({ minutesAgo: 1, tool: 'get_bom', ok: true, code: 'OK' }),
    entry({ minutesAgo: 2, tool: 'run_plc_generate', ok: false, code: 'ESTOP_UNDEFINED' }),
    entry({ minutesAgo: 3, tool: 'repair_plc_config', ok: false, code: 'PRECHECK_FAILED' })
  ];
  const { bus } = setup({ current: rows });
  const data = await read(bus, { onlyFailed: true });
  assert.equal(data.total, 2);
  assert.deepEqual(data.items.map((item) => item.code), ['ESTOP_UNDEFINED', 'PRECHECK_FAILED']);
  const all = await read(bus);
  assert.equal(all.total, 3, '不带 onlyFailed 时成功记录也要在');
});

test('sinceMinutes 过滤：默认一天，显式放宽后能看到两天前的失败', async () => {
  const rows = [
    entry({ minutesAgo: 30 }),
    entry({ minutesAgo: 2 * 24 * 60, code: 'OLD_FAILURE' })
  ];
  const { bus } = setup({ current: rows });
  const fallback = await read(bus);
  assert.equal(fallback.total, 1, '默认 1440 分钟应把两天前的记录挡在外面');
  assert.deepEqual(fallback.items.map((item) => item.code), ['ESTOP_UNDEFINED']);

  const widened = await read(bus, { sinceMinutes: 5000 });
  assert.equal(widened.total, 2);
  assert.deepEqual(widened.items.map((item) => item.code), ['ESTOP_UNDEFINED', 'OLD_FAILURE']);
  assert.equal(widened.window.sinceMinutes, 5000);
});

test('读轮转份：agent-audit.1.jsonl 里的旧失败也能查到（复用 audit-store，不另写遍历）', async () => {
  const { bus } = setup({
    current: [entry({ minutesAgo: 1 })],
    rotated: [entry({ minutesAgo: 20, code: 'ROTATED_FAILURE' })]
  });
  const data = await read(bus);
  assert.equal(data.total, 2);
  assert.deepEqual(data.items.map((item) => item.code), ['ESTOP_UNDEFINED', 'ROTATED_FAILURE']);
});

test('args 只留白名单字段，并再胞一遍凭据与绝对路径', async () => {
  const rows = [
    {
      at: new Date(NOW.getTime() - 60_000).toISOString(),
      tool: 'run_plc_generate',
      ok: false,
      code: 'ESTOP_UNDEFINED',
      elapsedMs: 8,
      // 故意模拟「审计行里残留明文」：真实写入前 audit.ts 会脱敏，这里是最后一道闸。
      args: {
        partId: 'MXQ20-50',
        path: 'C:\\Users\\owl\\private\\line.stp',
        ref: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload',
        apiKey: 'sk-live-9f8e7d6c5b4a',
        token: 'tok-abc-123',
        note: 'ignore me',
        nested: { secret: 'sk-nested-0001' }
      }
    }
  ];
  const { bus } = setup({ current: rows });
  const data = await read(bus);
  const [item] = data.items;
  assert.deepEqual(Object.keys(item.args).sort(), ['partId', 'path', 'ref'], '非白名单字段必须被丢弃');
  assert.equal(item.args.partId, 'MXQ20-50');
  assert.equal(item.args.path, '[已隐去]', '盘符绝对路径必须替换');
  assert.equal(item.args.ref, 'Bearer [已隐去]');

  const serialized = JSON.stringify(data);
  for (const leak of ['sk-live', 'tok-abc-123', 'ignore me', 'sk-nested', 'C:\\\\Users', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.ok(!serialized.includes(leak), `输出里仍能看到敏感原文：${leak}`);
  }
  assert.match(serialized, /\[已隐去\]/);

  // 错误码里若被塞进绝对路径，同样要抹掉（code 也会进模型上下文）
  const leakedCode = await read(setup({
    current: [{ at: new Date(NOW.getTime() - 60_000).toISOString(), tool: 'run_plc_generate', ok: false, code: 'C:\\Users\\owl\\a.json', args: {} }]
  }).bus, {});
  assert.equal(leakedCode.items[0].code, '[已隐去]');
  // 不返回工具返回值内容，也不返回审计里的 message/remoteAddress 等字段
  assert.deepEqual(Object.keys(item).sort(), ['args', 'code', 'ms', 'tool', 'ts']);
});

test('code/ms/verified 归一：成功记录补 OK、缺耗时记 0、verified 原样透传', async () => {
  const rows = [
    { at: new Date(NOW.getTime() - 60_000).toISOString(), tool: 'apply_machine_design', ok: true, verified: false, args: {} },
    { at: new Date(NOW.getTime() - 120_000).toISOString(), tool: 'get_bom', ok: true, code: 'OK', elapsedMs: 3.6, args: {} }
  ];
  const { bus } = setup({ current: rows });
  const data = await read(bus);
  assert.deepEqual(data.items[0], { ts: rows[0].at, tool: 'apply_machine_design', code: 'OK', ms: 0, verified: false, args: {} });
  assert.equal(data.items[1].ms, 4);
});

test('审计文件不存在时返回空数组，不报错', async () => {
  const { bus } = setup();
  const data = await read(bus);
  assert.deepEqual(data.items, []);
  assert.equal(data.total, 0);
  assert.equal(data.truncated, false);
  assert.match(data.note, /没有匹配的审计记录/);
});

test('参数校验：未知参数 / 非整数 limit / 空 tool 都返回 INVALID_ARGUMENT', async () => {
  const { bus } = setup();
  for (const args of [{ days: 3 }, { limit: 2.5 }, { tool: '  ' }, { onlyFailed: 'yes' }]) {
    const result = await bus.execute('get_recent_audit', args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENT', `${JSON.stringify(args)} 应被拒绝`);
  }
});
