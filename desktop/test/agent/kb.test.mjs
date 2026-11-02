import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import {
  KB_DOC_FILES,
  KB_MAX_BYTES,
  KB_MAX_CHUNK_CHARS,
  buildKnowledgeBase,
  chunkMarkdown,
  computeHeadingHash
} from '../../src/agent/kb/index.ts';
import {
  KB_STATS,
  SEARCH_CONTEXT_MAX_BYTES,
  searchDocs,
  tokenize
} from '../../src/agent/kb/search.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..');
const KB_PATH = resolve(DESKTOP_ROOT, 'src/agent/kb/kb.json');
const raw = readFileSync(KB_PATH, 'utf8');
const kb = JSON.parse(raw);

function docSource(path) {
  return kb.meta.sources.find((source) => source.path === path);
}

test('kb.json 已提交且体积不超过 512 KB', () => {
  assert.ok(raw.length > 0);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= KB_MAX_BYTES);
  assert.equal(kb.meta.docs, KB_DOC_FILES.length);
  assert.equal(kb.meta.sources.filter((source) => source.kind === 'doc').length, KB_DOC_FILES.length);
  assert.equal(kb.meta.chunks, kb.chunks.length);
  assert.equal(kb.meta.truncated, false);
  assert.equal(kb.meta.droppedChunks, 0);
  assert.equal(kb.meta.bytes, Buffer.byteLength(raw, 'utf8'));
});

test('BACKLOG 历史归档不进索引，且索引保留至少 5% 余量', () => {
  assert.equal(KB_DOC_FILES.includes('BACKLOG-HISTORY.md'), false);
  assert.equal(kb.meta.sources.some((source) => source.path.endsWith('BACKLOG-HISTORY.md')), false);
  const history = readFileSync(resolve(REPO_ROOT, 'docs/desktop/BACKLOG-HISTORY.md'), 'utf8');
  assert.match(history, /^## /m);
  assert.ok(kb.meta.bytes <= KB_MAX_BYTES * 0.95, `kb.json ${kb.meta.bytes} B，余量不足 5%，请把更早的迭代记录移入 BACKLOG-HISTORY.md`);
});

test('KB_STATS 与 kb.json 元数据一致', () => {
  assert.equal(KB_STATS.docs, KB_DOC_FILES.length);
  assert.equal(KB_STATS.chunks, kb.chunks.length);
  assert.equal(KB_STATS.bytes, kb.meta.bytes);
  assert.equal(KB_STATS.truncated, false);
});

test('块按 Markdown 标题切分并保留标题路径与行号', () => {
  const markdown = '# 一级\n\n## 二级\n正文 A\n\n### 三级\n正文 B\n';
  const chunks = chunkMarkdown('docs/demo.md', markdown);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '一级 > 二级');
  assert.equal(chunks[0].source, 'docs/demo.md#一级 > 二级');
  assert.equal(chunks[0].line, 4);
  assert.equal(chunks[0].text, '正文 A');
  assert.equal(chunks[1].heading, '一级 > 二级 > 三级');
  assert.equal(chunks[1].line, 7);
});

test('超过 800 字符的段落按行拆分，单行过长则硬切', () => {
  const markdown = '# 长文\n\n' + '甲'.repeat(500) + '\n\n' + '乙'.repeat(500) + '\n\n' + '丙'.repeat(2000);
  const chunks = chunkMarkdown('docs/long.md', markdown);
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) assert.ok(chunk.text.length <= KB_MAX_CHUNK_CHARS);
  assert.equal(chunks.map((chunk) => chunk.heading).every((heading) => heading === '长文'), true);
});

test('kb 中所有块不超过 800 字符且 source/line/id 合法', () => {
  const ids = new Set();
  for (const chunk of kb.chunks) {
    assert.ok(chunk.text.length > 0, chunk.id);
    assert.ok(chunk.text.length <= KB_MAX_CHUNK_CHARS, chunk.id);
    assert.ok(chunk.source.includes(chunk.file), chunk.id);
    assert.ok(Number.isInteger(chunk.line) && chunk.line >= 1, chunk.id);
    assert.equal(ids.has(chunk.id), false, `重复块 id ${chunk.id}`);
    ids.add(chunk.id);
  }
});

test('文档块 source 同时包含文件与标题路径', () => {
  const hit = kb.chunks.find((chunk) => chunk.file === 'docs/desktop/NL-AGENT.md' && chunk.heading.includes('工具清单'));
  assert.ok(hit);
  assert.match(hit.source, /^docs\/desktop\/NL-AGENT\.md#.+/);
  assert.equal(hit.source, `docs/desktop/NL-AGENT.md#${hit.heading}`);
});

test('中文按 2-gram、英文/数字按词切分', () => {
  const tokens = tokenize('底板画布 D2 干涉');
  assert.ok(tokens.includes('底板'));
  assert.ok(tokens.includes('板画'));
  assert.ok(tokens.includes('画布'));
  assert.ok(tokens.includes('d2'));
  assert.ok(tokens.includes('干涉'));
  assert.equal(tokens.includes('底'), false);
});

test('检索「导轨」命中且排名第一包含关键词', () => {
  const hits = searchDocs('导轨');
  assert.equal(hits.length, 3);
  assert.ok(hits[0].snippet.includes('导轨') || hits[0].heading.includes('导轨'));
  assert.ok(hits[0].source.startsWith('docs/desktop/'));
});

test('检索「干涉」命中文档', () => {
  const hits = searchDocs('干涉');
  assert.equal(hits.length, 3);
  assert.ok(hits.some((hit) => hit.snippet.includes('干涉')));
});

test('检索「D2」命中决策相关文档', () => {
  const hits = searchDocs('D2', 5);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((hit) => hit.snippet.includes('D2') || hit.heading.includes('D2')));
  assert.ok(hits.every((hit) => hit.score > 0));
});

test('无命中原样返回空数组，不做相近词硬凑', () => {
  assert.deepEqual(searchDocs('量子纠缠火箭发动机'), []);
  assert.deepEqual(searchDocs(''), []);
  assert.deepEqual(searchDocs('   '), []);
});

test('默认 top 3 且按分数降序', () => {
  const hits = searchDocs('导轨');
  assert.equal(hits.length, 3);
  for (let index = 1; index < hits.length; index += 1) {
    assert.ok(hits[index - 1].score >= hits[index].score);
  }
});

test('limit 限制为 1–5，默认 3', () => {
  assert.equal(searchDocs('导轨', 1).length, 1);
  assert.ok(searchDocs('导轨', 99).length <= 5);
  assert.ok(searchDocs('导轨', 0).length <= 3);
  assert.equal(searchDocs('导轨').length, 3);
});

test('单次注入上下文不超过 2 KB', () => {
  const hits = searchDocs('底板画布怎么放导轨 干涉 成本 尺寸 决策 文档 限制');
  assert.ok(hits.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ hits }), 'utf8') <= SEARCH_CONTEXT_MAX_BYTES);
  for (const hit of hits) assert.ok(hit.snippet.length <= 244);
});

test('截图文件名进入索引且可检索', () => {
  const shots = kb.chunks.filter((chunk) => chunk.file.startsWith('docs/desktop/screenshots/'));
  assert.ok(shots.length >= 14);
  assert.ok(shots.some((chunk) => chunk.file.endsWith('09-agent.png')));
  assert.equal(docSource('docs/desktop/screenshots')?.kind, 'screenshot');
});

test('元件库分类名进入索引且可检索', () => {
  const categoryChunk = kb.chunks.find((chunk) => chunk.file === 'packs/builtin/iec-cn/parts.json');
  assert.ok(categoryChunk);
  assert.ok(categoryChunk.text.includes('断路器'));
  const hits = searchDocs('识别与视觉');
  assert.ok(hits.some((hit) => hit.source.includes('packs/builtin/')));
});

test('kb.json 与源文件标题 hash 同步（改 md 忘记重建会被发现）', () => {
  const rebuilt = buildKnowledgeBase({ repoRoot: REPO_ROOT, generatedAt: 'sync-check' });
  for (const path of KB_DOC_FILES) {
    const expectedPath = `docs/desktop/${path}`;
    const committed = docSource(expectedPath);
    const current = rebuilt.meta.sources.find((source) => source.path === expectedPath);
    assert.ok(committed, `kb.json 缺少 ${expectedPath}`);
    assert.ok(current, `当前文档缺少 ${expectedPath}`);
    assert.equal(committed.headingHash, current.headingHash, `${expectedPath} 标题已变，请运行 npm run kb:build`);
    const markdown = readFileSync(resolve(REPO_ROOT, expectedPath), 'utf8');
    assert.equal(committed.headingHash, computeHeadingHash(markdown));
  }
});

test('search_docs 工具返回 hits 且校验参数', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const summary = tools.summaries().find((tool) => tool.name === 'search_docs');
  assert.ok(summary);
  assert.equal(summary.inputSchema.required.includes('query'), true);
  assert.equal(summary.inputSchema.properties.limit.minimum, 1);
  assert.equal(summary.inputSchema.properties.limit.maximum, 5);

  const result = await tools.call('search_docs', { query: 'D2', limit: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 1);
  assert.equal(typeof result.hits[0].source, 'string');
  assert.equal(typeof result.hits[0].heading, 'string');
  assert.equal(typeof result.hits[0].snippet, 'string');

  const missing = await tools.call('search_docs', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_ARGUMENT');
  const badLimit = await tools.call('search_docs', { query: '导轨', limit: 6 });
  assert.equal(badLimit.ok, false);
  assert.equal(badLimit.code, 'INVALID_ARGUMENT');
});
