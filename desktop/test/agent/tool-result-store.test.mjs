// 大结果外置 + 可回取（P4）。
//
// 断言口径（都是「量出来的事实」，不是形状自证）：
// - 超过上限：完整结果落盘、回执带 resultId/bytes/hint，preview 只是前缀；
// - 分批读完拼回去与磁盘上的原文**逐字符相等**（小片时也一样，含中文/emoji）；
// - 偏移落在汉字中间不会切坏：回退到字符起点，碎片里没有 U+FFFD；
// - 不超限不落盘、同内容只落一份、id 非法/不存在/越界各有稳定错误码；
// - 清理按「最近 50 个」删最旧（mtime 显式造出来，不赌运气）；
// - 防穿越：目录里放一个指向外部 JSON 的符号链接，读回来必须是 RESULT_NOT_FOUND；
// - 会话层审计只记 resultId 与字节数（审计行里绝不能出现结果内容）。
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentSession } from '../../src/agent/session.ts';
import { CommandBus, createAgentCommandBus } from '../../src/agent/commands.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';
import { serializeToolResult, TOOL_RESULT_BYTE_LIMIT } from '../../src/agent/trim.ts';
import { formatAuditLine } from '../../src/agent/audit.ts';
import {
  RESULT_ID_PATTERN,
  RESULT_MAX_FILES,
  RESULT_PAGE_MAX,
  ToolResultError,
  ToolResultStore,
  resultStoreDir
} from '../../src/agent/tool-result-store.ts';

const TOOL_LIMIT = TOOL_RESULT_BYTE_LIMIT; // 10 KB：与工具结果进模型前的硬上限一致
const MARKER = 'SENSITIVE-MACHINE-PARAM-气缸行程60mm'; // 审计里绝不能出现的“内容”
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(tag = 'cad-results-') {
  const root = mkdtempSync(join(tmpdir(), tag));
  roots.push(root);
  return root;
}

/** 造一份真正超过 10 KB 的工具结果（中文占比高，天然覆盖多字节边界）。 */
function hugeToolResult(rows = 400) {
  return {
    ok: true,
    machine: MARKER,
    rows: Array.from({ length: rows }, (_value, index) => ({
      index,
      partId: `PART-${String(index).padStart(3, '0')}`,
      name: `第${index}工位·气缸`,
      remark: `伸出到位检测，型号 SC63X100🚀，行程 60 mm，备注一二三四五六七八九十`
    }))
  };
}

function setup(tag) {
  const root = makeRoot(tag);
  const store = new ToolResultStore({ dir: resultStoreDir(root) });
  const bus = createAgentCommandBus({}, { call: async () => ({ ok: false }) }, { userDataRoot: root });
  return { root, store, bus };
}

/** 落盘一份超限结果，返回回执与磁盘原文。 */
function offload(store, value = hugeToolResult()) {
  const serialized = serializeToolResult(value, TOOL_LIMIT, (text) => store.save(text));
  const path = join(store.dir, `${serialized.resultId}.json`);
  return { serialized, raw: readFileSync(path, 'utf8'), path };
}

/** 按 nextOffset 从头读到尾，返回拼接结果与片段数。 */
async function readAll(bus, resultId, limit, maxPages = 6000) {
  const pages = [];
  let offset;
  for (let guard = 0; guard < maxPages; guard += 1) {
    const response = await bus.execute('get_tool_result', {
      resultId,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit })
    });
    assert.equal(response.ok, true, `取回失败：${JSON.stringify(response.error)}`);
    const page = response.data;
    if (page.eof) assert.equal('nextOffset' in page, false, 'eof=true 时不允许有 nextOffset');
    pages.push(page.content);
    if (page.eof) return { text: pages.join(''), pages: pages.length };
    assert.equal(typeof page.nextOffset, 'number');
    assert.ok(page.nextOffset > (offset ?? 0), 'nextOffset 必须前进，否则会死循环');
    offset = page.nextOffset;
  }
  throw new Error(`分片读取没有收敛（>${maxPages} 片）`);
}

test('超过 10 KB：完整结果落盘，回执给 resultId + bytes + hint', () => {
  const { store } = setup();
  const value = hugeToolResult();
  const { serialized, raw, path } = offload(store, value);

  assert.equal(serialized.truncated, true);
  assert.equal(serialized.bytes <= TOOL_LIMIT, true, `回执 ${serialized.bytes} 字节超过上限`);
  assert.match(serialized.resultId, RESULT_ID_PATTERN);
  assert.equal(existsSync(path), true, '完整结果没有落盘');
  // 磁盘上是完整结果（比回执大得多），而且是合法 JSON
  assert.ok(Buffer.byteLength(raw, 'utf8') > TOOL_LIMIT * 2);
  assert.equal(serialized.fullBytes, Buffer.byteLength(raw, 'utf8'));
  // 落盘的是「裁剪后」的完整结果：rows 已统一成 {items,total,truncated}，条目一条不删
  assert.equal(JSON.parse(raw).rows.items.length, value.rows.length);
  assert.equal(JSON.parse(raw).rows.total, value.rows.length);

  const receipt = JSON.parse(serialized.text);
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.resultId, serialized.resultId);
  assert.equal(receipt.bytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(typeof receipt.preview, 'string');
  // preview 必须是完整结果的前缀（模型看到的就是前 N 字节）
  assert.equal(raw.startsWith(receipt.preview), true);
  // hint 能直接照着调：带 resultId 与 offset
  assert.match(receipt.hint, /get_tool_result/);
  assert.ok(receipt.hint.includes(serialized.resultId));
  assert.match(receipt.hint, new RegExp(`offset=${Buffer.byteLength(receipt.preview, 'utf8')}`));
});

test('分批读完拼回去：与磁盘原文逐字符相等（默认 10 KB / 片）', async () => {
  const { store, bus } = setup();
  const { serialized, raw } = offload(store);
  const { text, pages } = await readAll(bus, serialized.resultId);
  assert.ok(pages > 1, '10 KB 上限下这么大的结果必须分多片');
  assert.equal(text, raw);
  assert.equal(Buffer.from(text, 'utf8').equals(readFileSync(join(store.dir, `${serialized.resultId}.json`))), true);
});

test('小片续读也不切坏中文：碎片无 U+FFFD，拼回去仍与原文相等', async () => {
  const { store, bus } = setup();
  // 12 KB 左右就够触发分片，再把 limit 压到 7 字节，让汉字/emoji 大量落在刀口上
  const { serialized, raw } = offload(store, hugeToolResult(120));
  // limit=7：汉字 3 字节、emoji 4 字节，必然大量落在字符中间
  const { text, pages } = await readAll(bus, serialized.resultId, 7);
  assert.equal(text, raw);
  assert.ok(pages > 100, `7 字节/片 应产生很多片，实际 ${pages}`);

  // 逐片单独校验：任何一片都不能含替换字符
  const chunks = await Promise.all(
    Array.from({ length: 20 }, (_value, index) =>
      bus.execute('get_tool_result', { resultId: serialized.resultId, offset: index * 37, limit: 7 }))
  );
  for (const response of chunks) assert.equal(response.data.content.includes('\uFFFD'), false);
});

test('偏移落在汉字/emoji 中间：回退到字符起点，不产生替换字符', async () => {
  const { store, bus } = setup();
  const { serialized, path } = offload(store);
  const buffer = readFileSync(path);

  // 找一个「续字节」位置（0b10xxxxxx），即某个多字节字符的中间
  let middle = -1;
  for (let index = 1; index < buffer.length; index += 1) {
    if ((buffer[index] & 0xc0) === 0x80) {
      middle = index;
      break;
    }
  }
  assert.ok(middle > 0, '样本里应该有中文/emoji 的多字节字符');

  const response = await bus.execute('get_tool_result', { resultId: serialized.resultId, offset: middle, limit: 32 });
  assert.equal(response.ok, true);
  const page = response.data;
  assert.ok(page.offset < middle, `offset 应回退到字符起点，实际 ${page.offset} / 请求 ${middle}`);
  assert.equal(page.content.includes('\uFFFD'), false);
  // content 必须正好是文件里从 page.offset 开始的那段字节
  const slice = buffer.subarray(page.offset, page.offset + Buffer.byteLength(page.content, 'utf8'));
  assert.equal(Buffer.from(page.content, 'utf8').equals(slice), true);
});

test('不超限的结果不落盘，也不带 resultId', () => {
  const { store } = setup();
  const small = { ok: true, items: [{ partId: 'P-1', name: '气缸' }], total: 1 };
  const serialized = serializeToolResult(small, TOOL_LIMIT, (text) => store.save(text));
  assert.equal(serialized.truncated, false);
  assert.equal(serialized.resultId, undefined);
  assert.equal(existsSync(store.dir), false, '没有超限时连目录都不该创建');
  assert.equal(store.stats().files, 0);
});

test('非法/不存在的 resultId → RESULT_NOT_FOUND（带 hint）', async () => {
  const { store, bus } = setup();
  offload(store);

  // 空值属于「少传参数」，由命令层判 INVALID_ARGUMENT；形状不对/不存在归 RESULT_NOT_FOUND。
  for (const resultId of ['not-a-hash', '0123456789ABCDEF', '../etc/passwd', '0123456789abcde', 'a/b/../cdef0123']) {
    const response = await bus.execute('get_tool_result', { resultId });
    assert.equal(response.ok, false, `${resultId || '（空）'} 不该被接受`);
    assert.equal(response.error.code, 'RESULT_NOT_FOUND');
    assert.equal(typeof response.error.hint, 'string');
  }
  // 形状合法但文件不存在（可复现的 16 位 hex）
  const missing = await bus.execute('get_tool_result', { resultId: 'abcdef0123456789' });
  assert.equal(missing.error.code, 'RESULT_NOT_FOUND');
  assert.match(missing.error.hint, /重新执行原工具|清理/);

  // store 层也直接抛带 code 的错误（命令层只是映射）
  assert.throws(
    () => store.read({ resultId: '0123456789abcdef' }),
    (error) => error instanceof ToolResultError && error.code === 'RESULT_NOT_FOUND'
  );
});

test('limit 超过 16384 被夹到上限；offset 越界 → RESULT_RANGE', async () => {
  const { store, bus } = setup();
  const { serialized, raw } = offload(store);

  const clamped = await bus.execute('get_tool_result', { resultId: serialized.resultId, limit: 999_999 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.data.limit, RESULT_PAGE_MAX);
  assert.equal(clamped.data.limit, 16384);
  assert.equal(Buffer.byteLength(clamped.data.content, 'utf8') <= RESULT_PAGE_MAX, true);

  const atEnd = await bus.execute('get_tool_result', { resultId: serialized.resultId, offset: Buffer.byteLength(raw, 'utf8') });
  assert.equal(atEnd.ok, true);
  assert.equal(atEnd.data.content, '');
  assert.equal(atEnd.data.eof, true);

  const beyond = await bus.execute('get_tool_result', {
    resultId: serialized.resultId,
    offset: Buffer.byteLength(raw, 'utf8') + 1
  });
  assert.equal(beyond.ok, false);
  assert.equal(beyond.error.code, 'RESULT_RANGE');
  assert.equal(typeof beyond.error.hint, 'string');
});

test('清理只保留最近 50 个（按 mtime 删最旧）', () => {
  const { root } = setup();
  const total = RESULT_MAX_FILES + 10;
  // 写入时用「不清理」的配额，把 60 份都留在盘上；再用默认配额的实例执行清理，
  // 这样测到的是默认策略（50 个）而不是把 maxFiles 一起改了。
  const writer = new ToolResultStore({ dir: resultStoreDir(root), maxFiles: total });
  const now = Date.now();
  const saved = [];
  for (let index = 0; index < total; index += 1) {
    // 内容各不相同 → id 不同；文本固定长度，避免触发 maxBytes 分支
    const text = JSON.stringify({ index, fill: 'x'.repeat(64) });
    const { resultId } = writer.save(text);
    const path = join(writer.dir, `${resultId}.json`);
    // 显式造 mtime：index 越小越旧，不赌文件系统时间精度
    const stamp = (now - (total - index) * 60_000) / 1000;
    utimesSync(path, stamp, stamp);
    saved.push({ resultId, path });
  }
  assert.equal(writer.stats().files, total, '先确认 60 份都写进去了');

  const store = new ToolResultStore({ dir: resultStoreDir(root) });
  const pruned = store.prune();
  assert.equal(pruned.kept, RESULT_MAX_FILES);
  assert.equal(pruned.removed, 10);
  const after = store.stats();
  assert.equal(after.files, RESULT_MAX_FILES);

  // 最旧的 10 个被删，最新的 50 个还在
  for (const [index, entry] of saved.entries()) {
    assert.equal(existsSync(entry.path), index >= 10, `index=${index} 的保留状态不对`);
  }
  assert.ok(after.bytes <= 32 * 1024 * 1024);
});

test('总量上限：超过 maxBytes 也按最旧删除（32 MB 分支的小尺寸等价验证）', () => {
  const { root } = setup();
  const writer = new ToolResultStore({ dir: resultStoreDir(root), maxBytes: 500 });
  const now = Date.now();
  const saved = [];
  for (let index = 0; index < 10; index += 1) {
    const text = JSON.stringify({ index, fill: 'y'.repeat(60) }); // 每份 ~85 字节
    const { resultId } = writer.save(text);
    const path = join(writer.dir, `${resultId}.json`);
    const stamp = (now - (10 - index) * 60_000) / 1000;
    utimesSync(path, stamp, stamp);
    saved.push(path);
  }
  const pruned = writer.prune();
  assert.ok(pruned.bytes <= 500, `清理后仍占 ${pruned.bytes} 字节`);
  assert.ok(pruned.kept >= 1 && pruned.kept < 10, `应删到配额内，实际保留 ${pruned.kept}`);
  assert.equal(existsSync(saved[0]), false, '最旧的一份应被删掉');
  assert.equal(existsSync(saved.at(-1)), true, '最新的一份必须留着');
});

test('同内容重复调用只落一份，且能正常读回', async () => {
  const { store, bus } = setup();
  const value = hugeToolResult();
  const first = offload(store, value).serialized;
  const second = offload(store, value).serialized;

  assert.equal(first.resultId, second.resultId);
  assert.equal(store.stats().files, 1);
  assert.deepEqual(readdirSync(store.dir), [`${first.resultId}.json`]);

  const { text } = await readAll(bus, second.resultId);
  assert.equal(text, readFileSync(join(store.dir, `${first.resultId}.json`), 'utf8'));
});

test('防路径穿越：目录内指向外部的符号链接 → RESULT_NOT_FOUND', () => {
  const { root, store } = setup();
  const outside = join(root, 'outside.json');
  writeFileSync(outside, JSON.stringify({ secret: '不应被读到' }), 'utf8');
  mkdirSync(store.dir, { recursive: true });
  const id = 'deadbeefdeadbeef';
  symlinkSync(outside, join(store.dir, `${id}.json`));

  assert.throws(
    () => store.read({ resultId: id }),
    (error) => error instanceof ToolResultError && error.code === 'RESULT_NOT_FOUND'
  );
});

test('命令层参数校验：空 resultId / 未知参数 / 非整数 offset → INVALID_ARGUMENT', async () => {
  const { store, bus } = setup();
  const { serialized } = offload(store);

  const empty = await bus.execute('get_tool_result', {});
  assert.equal(empty.error.code, 'INVALID_ARGUMENT');
  assert.match(empty.error.hint ?? '', /resultId/);

  const unknown = await bus.execute('get_tool_result', { resultId: serialized.resultId, path: '/etc/passwd' });
  assert.equal(unknown.error.code, 'INVALID_ARGUMENT');
  assert.match(unknown.error.message, /未知参数/);

  const badOffset = await bus.execute('get_tool_result', { resultId: serialized.resultId, offset: 1.5 });
  assert.equal(badOffset.error.code, 'INVALID_ARGUMENT');

  const negative = await bus.execute('get_tool_result', { resultId: serialized.resultId, offset: -1 });
  assert.equal(negative.error.code, 'INVALID_ARGUMENT');
});

test('工具层：get_tool_result 已注册为只读，回执形状与 store 一致', async () => {
  const { root } = setup();
  const store = new ToolResultStore({ dir: resultStoreDir(root) });
  const bus = createAgentCommandBus({}, { call: async () => ({ ok: false }) }, { userDataRoot: root });
  const tools = new AgentTools({ listParts: () => [] }, bus);

  assert.equal(tools.has('get_tool_result'), true);
  assert.equal(READ_ONLY_TOOLS.has('get_tool_result'), true);
  assert.equal(WRITE_TOOLS.has('get_tool_result'), false);
  assert.equal(tools.list().length, READ_ONLY_TOOLS.size + WRITE_TOOLS.size);

  const { serialized } = offload(store);
  const result = await tools.call('get_tool_result', { resultId: serialized.resultId, limit: 256 });
  assert.equal(result.ok, true);
  assert.equal(result.resultId, serialized.resultId);
  assert.equal(result.limit, 256);
  assert.equal(typeof result.content, 'string');
  assert.equal(result.eof, false);
  assert.equal(result.offset, 0);
  assert.match(result.note, /offset=/);

  const invalid = await tools.call('get_tool_result', {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_ARGUMENT');
});

test('会话层：超限结果外置后审计只记 resultId 与字节数，不记内容', async () => {
  const { root } = setup();
  const store = new ToolResultStore({ dir: resultStoreDir(root) });
  const payload = hugeToolResult(500);
  const bus = new CommandBus({ registry: {}, bridge: { call: async () => ({ ok: true }) } });
  bus.register({ name: 'get_bom', async run() { return { ok: true, data: payload }; } });

  let round = 0;
  const llm = {
    async chat() {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'call-bom',
            type: 'function',
            function: { name: 'get_bom', arguments: '{}' }
          }]
        };
      }
      return { content: '已读取完整结果。', toolCalls: [] };
    }
  };
  const audits = [];
  const session = new AgentSession({
    llm,
    bus,
    audit: (record) => audits.push(record),
    resultStore: store,
    maxIterations: 3
  });
  const reply = await session.run('把 BOM 拿来');
  assert.equal(reply, '已读取完整结果。');

  const offloaded = audits.filter((record) => record.code === 'TOOL_RESULT_OFFLOADED');
  assert.equal(offloaded.length, 1, `应有一条外置审计，实际 ${JSON.stringify(audits.map((a) => a.code))}`);
  const record = offloaded[0];
  assert.equal(record.tool, 'get_bom');
  assert.match(record.resultId, RESULT_ID_PATTERN);
  assert.ok(record.resultBytes > TOOL_LIMIT);
  assert.equal(store.stats().files, 1);

  // 落盘的审计行里只有 id 与字节数，没有结果内容
  const line = formatAuditLine(record);
  assert.ok(line.includes(record.resultId));
  assert.ok(line.includes(String(record.resultBytes)));
  assert.equal(line.includes(MARKER), false, '审计里不允许出现结果内容');
  assert.equal(line.includes('SC63X100'), false);

  // 模型拿到的是可回取的 preview，而不是「不知道被截了」的半截数据
  const toolMessage = session.history().find((message) => message.role === 'tool');
  assert.ok(toolMessage, '应有一条 tool 消息');
  assert.ok(toolMessage.content.includes(record.resultId));
  assert.match(toolMessage.content, /get_tool_result/);
});
