import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../src/packs/registry.ts';
import { AgentTools } from '../src/agent/tools.ts';
import { createAgentCommandBus } from '../src/agent/commands.ts';
import {
  COST_TOOL_ISSUE_LIMIT,
  COST_TOOL_LINE_LIMIT,
  CostToolError,
  costRowsFromSceneBom,
  runCostTool
} from '../src/cost/agent.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;
const costCase = JSON.parse(
  readFileSync(new URL('./fixtures/cost-case.json', import.meta.url), 'utf8')
) as Record<string, any>;

const NOW = '2026-10-23T12:00:00+08:00';

function toolError(fn: () => unknown): CostToolError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CostToolError, `期望 CostToolError，实际 ${String(error)}`);
    return error;
  }
  assert.fail('期望抛出 CostToolError，但没有抛错');
}

test('run_cost_report：显式 BOM + 价格簿算出与引擎一致的合计', () => {
  const result = runCostTool({ ...costCase, pricebook: fixture, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.bomSource, 'argument');
  assert.equal(result.bomRows, costCase.bom.length);
  assert.equal(result.counts.lines, 6);
  assert.equal(result.counts.missing, 1);
  assert.equal(result.totals.grand, 1398.64);
  assert.equal(result.pricebook.label, '入参价格簿');
  assert.ok(result.pricebook.usableItems > 0);
  assert.equal(result.pricebook.exampleItems, 0);
  assert.match(result.summary, /合计/);
  assert.equal(result.truncated, false);
  assert.equal(result.lines.length, 6);
  // 缺价项必须保留原因，不能悄悄按 0 计入
  assert.deepEqual(result.missing.map((item) => item.reason), ['NO_PRICE']);
  assert.ok(result.notes.some((note) => note.includes('偏低')));
});

test('run_cost_report：缺省 bom 时回落到场景 BOM，并如实标记缺物料号', () => {
  const result = runCostTool(
    { pricebook: fixture, now: NOW },
    { sceneBom: [{ no: 1, name: '机架', spec: '40x40', qty: 1, mat: '—' }] }
  );
  assert.equal(result.bomSource, 'scene');
  assert.equal(result.bomRows, 1);
  assert.equal(result.counts.lines, 0);
  assert.equal(result.counts.missing, 1);
  assert.equal(result.missing[0]?.reason, 'NO_PART_ID');
  assert.equal(result.totals.hardware, 0);
  assert.ok(result.notes.some((note) => note.includes('简化 BOM')));
});

test('run_cost_report：场景 BOM 行规整为成本行（缺字段回落默认值）', () => {
  const rows = costRowsFromSceneBom([
    { no: 1, name: '机架', spec: 'SPCC', qty: 2, mat: '—' },
    { no: 2, spec: '无名称', qty: 0 },
    'not-a-row'
  ]);
  assert.ok(rows);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: '机架', qty: 2, spec: 'SPCC' });
  assert.equal(rows[1]?.name, '未命名零件（第 2 行）');
  assert.equal(rows[1]?.qty, 1);
  assert.equal(costRowsFromSceneBom([]), undefined);
});

test('run_cost_report：内置价格簿可注入，示例条目不计价但会被统计', () => {
  const exampleOnly = {
    schemaVersion: 1,
    currency: 'CNY',
    updatedAt: '2026-09-15T00:00:00+08:00',
    source: '示例，需替换',
    items: {
      'PART-QF': { list: 78, example: true },
      'PART-KM': { list: 120, source: '示例，需替换' }
    },
    labor: { panelWiringPerPoint: 12, terminalPerWire: 1.5, assemblyHourly: 120 },
    accessories: { dinRail35PerMeter: 18, wireDuctPerMeter: 22, wirePerMeter: { '2.5': 4.8 } }
  };
  const result = runCostTool(
    { bom: [{ partId: 'PART-QF', name: '断路器', qty: 1 }], now: NOW },
    { loadBuiltinPricebook: () => exampleOnly }
  );
  assert.equal(result.pricebook.label, '内置价格簿');
  assert.equal(result.pricebook.usableItems, 0);
  assert.equal(result.pricebook.exampleItems, 2);
  assert.equal(result.counts.lines, 0);
  assert.equal(result.counts.missing, 1);
  assert.ok(result.notes.some((note) => note.includes('示例条目')));
});

test('run_cost_report：缺价格簿 / 缺 BOM 给出可操作的中文错误', () => {
  const noBook = toolError(() =>
    runCostTool({ bom: [{ name: '断路器', qty: 1 }] }, {})
  );
  assert.equal(noBook.code, 'PRICEBOOK_UNAVAILABLE');
  assert.match(noBook.message, /价格簿/);

  const brokenLoader = toolError(() =>
    runCostTool({ bom: [{ name: '断路器', qty: 1 }] }, {
      loadBuiltinPricebook: () => {
        throw new Error('文件不存在');
      }
    })
  );
  assert.equal(brokenLoader.code, 'PRICEBOOK_UNAVAILABLE');
  assert.match(brokenLoader.message, /文件不存在/);

  const noBom = toolError(() => runCostTool({ pricebook: fixture }, {}));
  assert.equal(noBom.code, 'NO_BOM');
  assert.match(noBom.message, /BOM/);

  const emptyBom = toolError(() => runCostTool({ bom: [], pricebook: fixture }, { sceneBom: [] }));
  assert.equal(emptyBom.code, 'NO_BOM');
});

test('run_cost_report：点位省略宽高时仍按坐标估算线缆', () => {
  const result = runCostTool({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    pricebook: fixture,
    placements: [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
    now: NOW
  });
  assert.ok(Number.isFinite(result.extras.wire) && result.extras.wire > 0);
});

test('run_cost_report：非法入参逐项定位到行号/字段', () => {
  const cases: Array<{ args: Record<string, unknown>; match: RegExp }> = [
    { args: { bom: 'PART-QF' }, match: /bom 必须是数组/ },
    { args: { bom: [{ name: '断路器' }] }, match: /缺少必填参数：bom\[0\]\.qty/ },
    { args: { bom: [{ name: '断路器', qty: 1.5 }] }, match: /qty 必须是正整数/ },
    { args: { bom: [{ name: '断路器', qty: 1, specs: 'x' }] }, match: /specs 必须是对象/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], placements: {} }, match: /placements 必须是数组/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], placements: [{ x: 1 }] }, match: /缺少必填参数：placements\[0\]\.x\/y/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], plate: { width: 600 } }, match: /plate 需要 width \/ height/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], plate: { width: 0, height: 100 } }, match: /必须大于 0/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], plc: { ioPoints: 8 } }, match: /plc.modules 必须是数组/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], plc: { modules: [{}] } }, match: /缺少必填参数：plc\.modules\[0\]\.partId/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], overrides: { 'PART-QF': -1 } }, match: /必须是非负有限数/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], options: 3 }, match: /options 必须是对象/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], pricebook: { schemaVersion: 2 } }, match: /价格簿不合法/ },
    { args: { bom: [{ name: '断路器', qty: 1 }], now: true }, match: /now 必须是 ISO 时间字符串/ }
  ];
  for (const { args, match } of cases) {
    const error = toolError(() => runCostTool(args, { loadBuiltinPricebook: () => fixture }));
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, match, `入参 ${JSON.stringify(args)} 的错误信息不匹配`);
  }
});

test('run_cost_report：明细与告警按上限截断并标注 truncated', () => {
  const bom = Array.from({ length: 51 }, (_, index) => ({
    name: `物料 ${index + 1}`,
    qty: 1
  }));
  const overrides: Record<string, number> = {};
  const pricedBom = bom.map((row, index) => {
    const partId = `P${index + 1}`;
    overrides[partId] = 10;
    return { ...row, partId };
  });
  const result = runCostTool({ bom: pricedBom, pricebook: fixture, overrides, now: NOW });
  assert.equal(result.counts.lines, 51);
  assert.equal(result.lines.length, COST_TOOL_LINE_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.totals.hardware, 510);

  const missingRows = Array.from({ length: COST_TOOL_ISSUE_LIMIT + 5 }, (_, index) => ({
    name: `未定价 ${index + 1}`,
    qty: 1
  }));
  const missingResult = runCostTool({ bom: missingRows, pricebook: fixture, now: NOW });
  assert.equal(missingResult.counts.missing, COST_TOOL_ISSUE_LIMIT + 5);
  assert.equal(missingResult.missing.length, COST_TOOL_ISSUE_LIMIT);
  assert.equal(missingResult.truncated, true);
});

test('run_cost_report：工具 schema 完整且允许仅带 bom', () => {
  const registry = new PackRegistry({
    builtinDir: join(tmpdir(), 'cad-cost-agent-empty-builtin'),
    userDir: join(tmpdir(), 'cad-cost-agent-empty-user'),
    stateFile: join(tmpdir(), 'cad-cost-agent-empty-state.json')
  });
  const tools = new AgentTools(registry);
  const summary = tools.summaries().find((tool) => tool.name === 'run_cost_report');
  assert.ok(summary);
  assert.match(summary.description, /成本/);
  assert.equal(summary.inputSchema.type, 'object');
  assert.deepEqual(summary.inputSchema.properties.bom.items.required, ['name', 'qty']);
  assert.deepEqual(summary.inputSchema.properties.placements.items.required, ['x', 'y']);
  assert.deepEqual(summary.inputSchema.properties.plc.required, ['modules']);
  assert.equal(summary.inputSchema.required, undefined);
});

let sandbox = '';
let bus: ReturnType<typeof createAgentCommandBus>;
let tools: AgentTools;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-cost-agent-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0',
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  const bridge = {
    async call<T>(method: string): Promise<T> {
      if (method === 'getBom') {
        return [{ no: 1, name: '机架', spec: '40x40', qty: 1, mat: '—' }] as unknown as T;
      }
      return { ok: false, message: `不应调用渲染桥：${method}` } as unknown as T;
    }
  };
  bus = createAgentCommandBus(registry, bridge, { loadBuiltinPricebook: () => fixture });
  tools = new AgentTools(registry, bus);
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('命令 run_cost_report：走命令总线并返回紧凑结果', async () => {
  const result = await bus.execute('run_cost_report', { ...costCase, now: NOW });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, any>;
  assert.equal(data.bomSource, 'argument');
  assert.equal(data.counts.lines, 6);
  assert.equal(data.totals.grand, 1398.64);
  assert.ok(Array.isArray(data.lines));
  assert.equal(data.pricebook.label, '内置价格簿');
});

test('命令 run_cost_report：未传 bom 时读当前场景 BOM 而非报错', async () => {
  const result = await bus.execute('run_cost_report', { now: NOW });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, any>;
  assert.equal(data.bomSource, 'scene');
  assert.equal(data.counts.missing, 1);
  assert.equal(data.missing[0].reason, 'NO_PART_ID');
});

test('命令 run_cost_report：错误码透传到命令层', async () => {
  const result = await bus.execute('run_cost_report', { bom: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ARGUMENT');
  assert.match(result.error?.message ?? '', /bom 必须是数组/);

  const noBook = await bus.execute('run_cost_report', { bom: [{ name: '断路器', qty: 1 }], pricebook: null });
  // bus 注入了内置价格簿，因此 pricebook:null 会回落到内置价格簿并成功
  assert.equal(noBook.ok, true);
});

test('Agent 工具 run_cost_report：返回 totals/counts/notes 且不泄露整份报告', async () => {
  const result = (await tools.call('run_cost_report', { ...costCase, now: NOW })) as Record<string, any>;
  assert.equal(result.ok, true);
  assert.equal(result.counts.lines, 6);
  assert.equal(result.totals.grand, 1398.64);
  assert.ok(Array.isArray(result.notes));
  assert.ok(Array.isArray(result.byCategory));
  assert.ok(result.lines.length <= COST_TOOL_LINE_LIMIT);

  const bad = (await tools.call('run_cost_report', { bom: [{ name: '断路器' }] })) as Record<string, any>;
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGUMENT');
});
