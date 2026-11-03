// G2：列表型工具统一形状 {items,total,truncated}。
//
// 这条 bug 是真实踩过的：25 行 BOM 时 trim.ts 把数组切成 {items,total,truncated}，
// 消费方还在 `Array.isArray(...)`，于是「25 行」静默变成「空数组」，面板一片空白，
// 而工具本身、单测、eval 全绿。这里逐条盯住：
//   - 统一形状对小列表也成立（不做双形状）；
//   - 超长列表只截字符串、不删条目；
//   - 消费方（thread/projectFacts、工具层）拿到 25 行能读出 25 行；
//   - 形状真不认识时抛错/返回 null，绝不静默当空数组。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import {
  LIST_RESULT_LIMIT,
  listResult,
  readListResult,
  requireListItems,
  serializeToolResult,
  trimListResult,
  trimToolResult
} from '../../src/agent/trim.ts';
import { projectFacts } from '../../src/agent/thread.ts';

const BOM_ROWS = 25;

function bomRows(count = BOM_ROWS) {
  return Array.from({ length: count }, (_unused, index) => ({
    partId: `P${index}`,
    name: `零件-${index}`,
    qty: 1,
    remark: ''
  }));
}

let sandbox;
let tools;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-list-result-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0',
    categories: ['气缸'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: { 缸径: '20 mm' } }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  const userDataRoot = join(sandbox, 'userData');
  mkdirSync(join(userDataRoot, 'machine-library'), { recursive: true });
  const bridge = {
    async call(method) {
      if (method === 'getBom') return bomRows();
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  tools = new AgentTools(registry, createAgentCommandBus(registry, bridge, { userDataRoot }));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('listResult：小列表也是 {items,total,truncated:false}，不再返回裸数组', () => {
  const small = listResult([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(Object.keys(small).sort(), ['items', 'total', 'truncated']);
  assert.equal(small.items.length, 2);
  assert.equal(small.total, 2);
  assert.equal(small.truncated, false);
  assert.equal(Array.isArray(small), false);
});

test('listResult：超过 20 条只标记 truncated，条目一条不删', () => {
  const many = trimListResult(bomRows(BOM_ROWS));
  assert.equal(many.items.length, BOM_ROWS);
  assert.equal(many.total, BOM_ROWS);
  assert.equal(many.truncated, true);
  assert.equal(many.items.at(-1).partId, `P${BOM_ROWS - 1}`);
  assert.equal(LIST_RESULT_LIMIT, 20);
});

test('readListResult：新形状 / 裸数组 / 镜像字段都能读，形状不认识返回 null', () => {
  const rows = bomRows(3);
  assert.deepEqual(readListResult({ items: rows, total: 3 })?.items, rows);
  assert.deepEqual(readListResult(rows)?.items, rows);
  assert.deepEqual(readListResult({ rows }, ['rows'])?.items, rows);
  assert.equal(readListResult({ count: 3, components: 'nope' }, ['rows']), null);
  assert.equal(readListResult('25 行', ['rows']), null);
  // total 比 items 长时以 total 为准（代表上游显式声明了总数）
  assert.equal(readListResult({ items: rows, total: 9 })?.total, 9);
});

test('requireListItems：形状不认识时抛错并带出实际形状，不当空数组', () => {
  assert.throws(
    () => requireListItems({ count: 0 }, ['rows'], 'BOM'),
    /BOM结果形状不合法.*object\(keys=count\)/
  );
  assert.deepEqual(requireListItems({ rows: bomRows(2) }, ['rows']).length, 2);
});

test('消费方：projectFacts 从统一形状的 BOM 读出 25 行（不是 0）', () => {
  const facts = projectFacts({ bom: { items: bomRows(), total: BOM_ROWS, truncated: true } });
  assert.equal(facts.bomRows, BOM_ROWS);
  // 老形状（裸数组 / 明细镜像）继续可用
  assert.equal(projectFacts({ bom: bomRows() }).bomRows, BOM_ROWS);
});

test('工具层：get_bom 25 行 → items 全 25、total 25、rows 镜像仍是数组', async () => {
  const result = await tools.call('get_bom', {});
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.items), true);
  assert.equal(result.items.length, BOM_ROWS);
  assert.equal(result.total, BOM_ROWS);
  assert.equal(result.truncated, true);
  assert.equal(Array.isArray(result.rows), true, 'rows 兼容镜像必须还是数组');
  assert.equal(result.rows.length, BOM_ROWS);
});

test('工具层：小列表与空列表同样是统一形状（不做双形状）', async () => {
  const components = await tools.call('list_components', { category: '气缸' });
  assert.equal(components.items.length, 1);
  assert.equal(components.total, 1);
  assert.equal(components.truncated, false);
  assert.equal(components.components.length, 1, 'components 兼容镜像保留');

  const library = await tools.call('list_machine_library', {});
  assert.equal(library.ok, true);
  assert.deepEqual(library.items, []);
  assert.equal(library.total, 0);
  assert.equal(library.truncated, false);
});

test('工具层：search_docs 命中统一形状且 hits 镜像保留', async () => {
  const result = await tools.call('search_docs', { query: 'D2', limit: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.items[0].source, result.hits[0].source);
});

test('模型上下文：25 行 BOM 序列化后仍是 25 条，且镜像不重复占字节', async () => {
  const result = await tools.call('get_bom', {});
  const serialized = serializeToolResult(result);
  assert.equal(serialized.truncated, false);
  const parsed = JSON.parse(serialized.text);
  assert.equal(parsed.items.length, BOM_ROWS);
  assert.equal(parsed.total, BOM_ROWS);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.rows, undefined, '与 items 同一份数据的镜像不再重复输出');
  assert.equal(parsed.items.at(-1).partId, `P${BOM_ROWS - 1}`);
});

test('裁剪不改变条目内容：长字符串按 2 KB 截断但条目保留', () => {
  const rows = bomRows(BOM_ROWS);
  rows[0].remark = '中'.repeat(3000);
  const trimmed = trimToolResult({ ok: true, data: { rows } });
  assert.equal(trimmed.data.rows.items.length, BOM_ROWS);
  assert.match(trimmed.data.rows.items[0].remark, /已截断/);
  assert.equal(trimmed.data.rows.items[1].partId, 'P1');
  assert.equal(trimmed.data.rows.items.at(-1).partId, `P${BOM_ROWS - 1}`);
  assert.equal(trimmed.data.rows.total, BOM_ROWS);
});
