// 工具数量散落在 README / NL-AGENT / MODULE.md / router 注释里，改工具时必须一起改，
// 否则文档与真实注册表脱节（本项目已漂移过一次：README 写 22，实际 25）。
//
// 本文件不再写死 25 / 12 / 13：数字全部从运行时注册表推导，文档里的每一处数字逐个核对。
// 历史里程碑行可以带 <!-- tool-count:ignore --> 跳过，但该行必须带历史标记（✅ / P7- / 已完成…），
// 防止把当前状态行标成“历史”来绕过检查。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

const registry = new AgentTools({ listParts: () => [] })
  .list()
  .map((tool) => tool.name)
  .sort();
const readOnly = [...READ_ONLY_TOOLS].sort();
const writeOnly = [...WRITE_TOOLS].sort();
const TOTAL = registry.length;
const READ_ONLY = readOnly.length;
const WRITE = writeOnly.length;

/** 「N 个工具」「N 个 AgentTool」「N 个已实现工具」「N 工具」。 */
const TOTAL_MENTION = /(\d+)\s*个?\s*(?:已实现|已注册|注册|内置)?\s*(?:工具|AgentTool)/g;
/** 「只读 R + 写 W」成对声明（+ / 、 ， 等分隔符）。 */
const SPLIT_MENTION = /只读\s*(\d+)\s*个?\s*[+＋/、，,]\s*写(?:操作|工具)?\s*(\d+)\s*个?/g;
const IGNORE_MARK = 'tool-count:ignore';
const HISTORY_CUES = ['✅', 'P7-', 'P10-', '已完成', '→'];

const DOCS = [
  'README.md',
  'docs/desktop/NL-AGENT.md',
  'desktop/src/agent/MODULE.md',
  'desktop/src/agent/router.ts'
];

/** 逐行扫描并带上 file:line；带历史标记的行跳过（标记本身也受校验）。 */
function mentions(rel, pattern) {
  const hits = [];
  read(rel)
    .split('\n')
    .forEach((row, index) => {
      const where = `${rel}:${index + 1}`;
      if (row.includes(IGNORE_MARK)) {
        assert.ok(
          HISTORY_CUES.some((cue) => row.includes(cue)),
          `${where} 用 ${IGNORE_MARK} 跳过了工具数检查，但这行不像历史里程碑（缺少 ${HISTORY_CUES.join(' / ')}）`
        );
        return;
      }
      for (const match of row.matchAll(pattern)) {
        hits.push({ where, values: match.slice(1), matched: match[0] });
      }
    });
  return hits;
}

test('注册表与读写分类一一对应（既没有漏分类的工具，也没有幽灵工具）', () => {
  assert.ok(TOTAL > 0, '注册表为空，工具数哨兵失效');
  assert.equal(new Set(registry).size, TOTAL, '注册表里有重名工具');
  assert.equal(new Set([...readOnly, ...writeOnly]).size, TOTAL, '读写分类总数与注册表不一致');
  assert.deepEqual([...readOnly, ...writeOnly].sort(), registry, '读写分类与注册表不是同一批工具（有漏分类或幽灵工具）');
  assert.equal(readOnly.filter((name) => WRITE_TOOLS.has(name)).length, 0, '只读与写分类存在交集');
  assert.equal(READ_ONLY + WRITE, TOTAL, '只读数 + 写数 不等于注册表总数');
});

test('文档里的工具总数/只读数/写数与注册表一致', () => {
  for (const rel of DOCS) {
    const totals = mentions(rel, TOTAL_MENTION);
    assert.ok(totals.length > 0, `${rel} 里找不到「${TOTAL} 个工具」的表述，改工具后请同步文档`);
    for (const hit of totals) {
      assert.equal(
        Number(hit.values[0]),
        TOTAL,
        `${hit.where} 写的是「${hit.matched}」，注册表实际 ${TOTAL} 个（只读 ${READ_ONLY} + 写 ${WRITE}）`
      );
    }

    const splits = mentions(rel, SPLIT_MENTION);
    assert.ok(splits.length > 0, `${rel} 里找不到「只读 ${READ_ONLY} + 写 ${WRITE}」的分类表述`);
    for (const hit of splits) {
      assert.deepEqual(
        [Number(hit.values[0]), Number(hit.values[1])],
        [READ_ONLY, WRITE],
        `${hit.where} 写的是「${hit.matched}」，注册表实际 只读 ${READ_ONLY} + 写 ${WRITE}`
      );
    }
  }
});

test('README 的工具清单逐个列出且不重不漏', () => {
  const line = read('README.md').split('\n').find((row) => row.startsWith('| 工具集 |'));
  assert.ok(line, 'README 里找不到「工具集」这一行');
  const listed = [...line.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), registry);
});
