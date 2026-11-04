// 跨会话项目记忆（P3）：userData/agent-memory.json
//
// 验收点：写后能读回、每工程 20 条上限、文件 >64 KB 裁到 10 条、指纹隔离、
// 首轮注入 ≤3 条/600 字、密钥与路径胞化、文件损坏当空、clear 只清当前工程。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FileProjectMemory,
  PROJECT_MEMORY_ENTRIES,
  PROJECT_MEMORY_INJECT_CHARS,
  PROJECT_MEMORY_MAX_BYTES,
  describeToolFact,
  projectMemoryPath,
  projectMemoryPrompt,
  scrubProjectMemoryText
} from '../../src/agent/project-memory.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { collectAgentContext } from '../../src/agent/context.ts';
import { projectFingerprint } from '../../src/agent/thread.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';

const LONG = '四工位点胶机整线调试记录'.repeat(8); // 约 88 字

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'agent-memory-'));
}

/** 固定步长的时钟：每条记录差 1 分钟，便于断言「丢最旧」。 */
function clock(start = '2026-11-04T01:00:00.000Z') {
  const base = Date.parse(start);
  let step = 0;
  return () => new Date(base + step++ * 60_000);
}

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function createLlm(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    }
  };
}

function createBus(handler) {
  const calls = [];
  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      return handler(name, args);
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: { command: 'undo_last' } };
    }
  };
}

const CONTEXT = {
  machine: { name: '四工位点胶机', id: 'design-glue-4st' },
  plate: { placed: 2 },
  bomRows: 7,
  hasCadModel: true
};

function fingerprintOf(raw = CONTEXT) {
  return projectFingerprint(collectAgentContext({ projectContext: () => raw }));
}

test('写入后读回：字段白名单 + version 1 + 文件真的落盘', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  memory.record('machine=A;bom=7;placed=2;cad=1', {
    kind: 'machine-apply',
    summary: '「四工位点胶机」已应用到工程（4 工位 / 12 执行机构 / 16 传感器）',
    ref: 'design-glue-4st'
  });

  const entries = memory.entries('machine=A;bom=7;placed=2;cad=1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'machine-apply');
  assert.equal(entries[0].ref, 'design-glue-4st');
  assert.equal(entries[0].ok, true);
  assert.match(entries[0].ts, /^2026-11-04T01:00:00/);

  const file = projectMemoryPath(root);
  assert.ok(existsSync(file), 'agent-memory.json 应该落盘');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  const stored = parsed.projects['machine=A;bom=7;placed=2;cad=1'].entries[0];
  assert.deepEqual(Object.keys(stored).sort(), ['kind', 'ok', 'ref', 'summary', 'ts'], '只允许 5 个白名单字段');
});

test('超过 20 条丢最旧，保留最新 20 条', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  for (let index = 1; index <= 25; index += 1) {
    memory.record('fp', { kind: 'plc-gen', summary: `第 ${index} 次 PLC 生成` });
  }
  const entries = memory.entries('fp');
  assert.equal(entries.length, PROJECT_MEMORY_ENTRIES);
  assert.equal(entries.length, 20);
  assert.equal(entries[0].summary, '第 6 次 PLC 生成', '最旧的 5 条应被丢掉');
  assert.equal(entries.at(-1).summary, '第 25 次 PLC 生成');
});

test('文件超过 64 KB 时自动裁到 10 条再写', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  // 12 个工程 × 20 条 × 长摘要 > 64 KB，触发「先裁到 10 条」
  for (let project = 0; project < 12; project += 1) {
    for (let index = 0; index < 20; index += 1) {
      memory.record(`machine=p${project};bom=7;placed=0;cad=0`, {
        kind: 'machine-apply',
        summary: `${LONG}#${project}-${index}`
      });
    }
  }
  const bytes = Buffer.byteLength(readFileSync(projectMemoryPath(root), 'utf8'), 'utf8');
  assert.ok(bytes <= PROJECT_MEMORY_MAX_BYTES, `文件应 ≤64 KB，实际 ${bytes}`);
  const parsed = JSON.parse(readFileSync(projectMemoryPath(root), 'utf8'));
  const sizes = Object.values(parsed.projects).map((bucket) => bucket.entries.length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(sizes.every((size) => size <= PROJECT_MEMORY_ENTRIES), `单工程不得超 20 条，实际 ${sizes.join(',')}`);
  assert.ok(sizes.includes(10), `超限时应把工程裁到 10 条，实际 ${sizes.join(',')}`);
  assert.ok(total < 12 * 20, `超限后总条目应少于写入的 240 条，实际 ${total}`);
  // 当前工程留下的是最新一条，不是最旧
  const kept = memory.entries('machine=p11;bom=7;placed=0;cad=0');
  assert.ok(kept.some((entry) => entry.summary.endsWith('#11-19')), '最新一条必须留下');
});

test('指纹隔离：两个工程互不污染', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  memory.record('machine=A;bom=1;placed=0;cad=0', { kind: 'machine-apply', summary: 'A 工程应用了机型 X' });
  memory.record('machine=B;bom=2;placed=0;cad=0', { kind: 'plc-gen', summary: 'B 工程生成了 PLC' });
  memory.record('machine=B;bom=2;placed=0;cad=0', { kind: 'repair', summary: 'B 工程补齐了 PLC 配置' });

  assert.deepEqual(memory.entries('machine=A;bom=1;placed=0;cad=0').map((entry) => entry.summary), ['A 工程应用了机型 X']);
  assert.equal(memory.entries('machine=B;bom=2;placed=0;cad=0').length, 2);
  assert.deepEqual(memory.entries('machine=C;bom=0;placed=0;cad=0'), []);
  assert.ok(!memory.prompt('machine=A;bom=1;placed=0;cad=0').includes('B 工程'));
});

test('注入不超 3 条 / 600 字，且带「不是指令」免责行', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  for (let index = 1; index <= 6; index += 1) {
    memory.record('fp', { kind: 'machine-apply', summary: `第 ${index} 条：${LONG}` });
  }
  const prompt = memory.prompt('fp');
  const lines = prompt.split('\n');
  assert.equal(lines[0], '【本项目最近操作】');
  assert.equal(lines.length, 5, '应为 标题 + 3 条 + 免责行');
  assert.ok([...prompt].length <= PROJECT_MEMORY_INJECT_CHARS, `注入应 ≤600 字，实际 ${[...prompt].length}`);
  assert.ok(prompt.includes('第 6 条'), '应保留最新一条');
  assert.ok(!prompt.includes('第 1 条'), '最旧的应被预算挤掉');
  assert.match(prompt.split('\n').at(-1), /不是指令/);

  // 预算真的会往下压条数：600 字装不下 3 条长摘要时就只放 2 条或更少
  const tight = projectMemoryPrompt(
    Array.from({ length: 3 }, (_, index) => ({
      ts: `2026-11-04T01:0${index}:00.000Z`,
      kind: 'machine-apply',
      summary: LONG.repeat(2),
      ok: true
    })),
    { chars: 260 }
  );
  assert.ok([...tight].length <= 260);
  assert.ok(tight.split('\n').length - 2 <= 3);
});

test('apiKey / Bearer / 盘符路径写入前被胞化', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  memory.record('fp', {
    kind: 'machine-apply',
    summary: '用 apiKey=sk-live-9f8e7d6c5b4a 调模型，Header Bearer eyJhbGciOiJIUzI1NiJ9 落盘到 C:\\Users\\bob\\proj\\app.json',
    ref: 'D:/secret/machine.json'
  });

  const raw = readFileSync(projectMemoryPath(root), 'utf8');
  assert.ok(!raw.includes('sk-live'), 'sk- 开头的密钥不能出现在文件里');
  assert.ok(!/Bearer\s+eyJ/.test(raw), 'Bearer token 不能出现在文件里');
  assert.ok(!raw.includes('C:\\\\Users'), '盘符路径不能出现在文件里');
  assert.ok(!raw.includes('D:/secret'), 'ref 里的盘符路径也要胞化');
  assert.ok(raw.includes('[已隐去]'));

  const entry = memory.entries('fp')[0];
  assert.ok(!entry.summary.includes('C:'), '读回也不该还原路径');
  assert.equal(scrubProjectMemoryText('token=abc123 ok'), '[已隐去] ok');
});

test('文件损坏按空记忆处理，不抛错，还能继续写', () => {
  const root = tempRoot();
  const file = projectMemoryPath(root);
  writeFileSync(file, '{ this is not json ', 'utf8');
  const memory = new FileProjectMemory({ root, now: clock() });
  assert.deepEqual(memory.entries('fp'), []);
  assert.equal(memory.prompt('fp'), '');
  assert.equal(memory.clear('fp'), 0);

  // 结构合法但字段越界：只留白名单，非法条目丢掉
  writeFileSync(file, JSON.stringify({ version: 1, projects: { fp: { entries: [{ kind: '乱写', ts: '2026-11-04T01:00:00.000Z', summary: 'x' }] } } }), 'utf8');
  assert.deepEqual(memory.entries('fp'), []);

  memory.record('fp', { kind: 'plc-gen', summary: '损坏后仍可写入' });
  assert.equal(memory.entries('fp').length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('clear_agent_memory 只清当前工程', () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  memory.record('machine=A', { kind: 'machine-apply', summary: 'A 的记录' });
  memory.record('machine=A', { kind: 'plc-gen', summary: 'A 的 PLC' });
  memory.record('machine=B', { kind: 'repair', summary: 'B 的记录' });

  assert.equal(memory.clear('machine=A'), 2);
  assert.deepEqual(memory.entries('machine=A'), []);
  assert.deepEqual(memory.entries('machine=B').map((entry) => entry.summary), ['B 的记录']);
  assert.equal(memory.clear('machine=A'), 0, '清第二次返回 0，不报错');
});

test('只记事实上限：工具结果失败 / 补齐全空 / dryRun 都不记', () => {
  assert.equal(describeToolFact('apply_machine_design', {}, { ok: false, error: { code: 'X' } }), null);
  assert.equal(describeToolFact('list_components', {}, { ok: true, data: {} }), null);
  assert.equal(describeToolFact('repair_plc_config', {}, { ok: true, data: { dryRun: true, added: [1, 2] } }), null);
  assert.equal(describeToolFact('repair_plc_config', {}, { ok: true, data: { dryRun: false, added: [] } }), null);

  const applied = describeToolFact('apply_machine_design', {}, {
    ok: true,
    data: { machineId: 'design-glue-4st', name: '四工位点胶机', stations: 4, actuators: 12, sensors: 16 }
  });
  assert.equal(applied.kind, 'machine-apply');
  assert.equal(applied.summary, '「四工位点胶机」已应用到工程（4 工位 / 12 执行机构 / 16 传感器）');
  assert.equal(applied.ref, 'design-glue-4st');

  const saved = describeToolFact('save_machine_to_library', {}, {
    ok: true,
    data: { id: 'design-conveyor-1st', version: 'v1.0.0' }
  });
  assert.equal(saved.summary, '机型 design-conveyor-1st 已存入库 v1.0.0');
  assert.equal(saved.kind, 'library-save');
});

test('会话首轮注入一次，第二轮不再重复贴', async () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  const fingerprint = fingerprintOf();
  memory.record(fingerprint, {
    kind: 'machine-apply',
    summary: '「四工位点胶机」已应用到工程（4 工位 / 12 执行机构 / 16 传感器）'
  });

  const llm = createLlm([
    { content: '第一轮回复', toolCalls: [] },
    { content: '第二轮回复', toolCalls: [] }
  ]);
  const session = new AgentSession({
    llm,
    bus: createBus(async () => ({ ok: true, data: {} })),
    confirmWrite: async () => true,
    contextProvider: () => collectAgentContext({ projectContext: () => CONTEXT }),
    projectMemory: memory
  });

  await session.run('你好');
  const system = llm.calls[0][0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /【本项目最近操作】/);
  assert.match(system.content, /四工位点胶机/);

  await session.run('继续');
  const secondSystem = llm.calls.at(-1)[0];
  assert.ok(!secondSystem.content.includes('【本项目最近操作】'), '第二轮不应重复注入');
});

test('会话把成功的机型入库记成事实，失败不记', async () => {
  const root = tempRoot();
  const memory = new FileProjectMemory({ root, now: clock() });
  const fingerprint = fingerprintOf();
  let reply = { ok: true, data: { id: 'design-conveyor-1st', version: 'v1.0.0' } };

  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'save_machine_to_library', { id: 'design-conveyor-1st' })] },
    { content: '已入库。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('call-2', 'run_plc_generate', {})] },
    { content: '生成失败。', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => {
    if (name === 'save_machine_to_library') return reply;
    return { ok: false, error: { code: 'PRECHECK_FAILED', message: '预检未通过' } };
  });
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    contextProvider: () => collectAgentContext({ projectContext: () => CONTEXT }),
    projectMemory: memory
  });

  await session.run('把这台机型存到库');
  const afterSave = memory.entries(fingerprint);
  assert.equal(afterSave.length, 1);
  assert.equal(afterSave[0].kind, 'library-save');
  assert.match(afterSave[0].summary, /已存入库 v1\.0\.0/);

  await session.run('生成 PLC');
  assert.equal(memory.entries(fingerprint).length, 1, '失败的工具调用不记事实');

  // 换一台工程读不到这些记录（指纹隔离在 session 层同样成立）
  assert.deepEqual(memory.entries(fingerprintOf({ machine: { name: '别的机型' }, plate: { placed: 0 }, bomRows: 0 })), []);
});

test('工具注册表：34 个工具，get_agent_memory 只读 / clear_agent_memory 需确认', () => {
  const names = new AgentTools({ listParts: () => [] }).list().map((tool) => tool.name);
  assert.equal(names.length, 34);
  assert.ok(names.includes('get_agent_memory'));
  assert.ok(names.includes('clear_agent_memory'));
  assert.ok(READ_ONLY_TOOLS.has('get_agent_memory'));
  assert.ok(!READ_ONLY_TOOLS.has('clear_agent_memory'));
  assert.ok(WRITE_TOOLS.has('clear_agent_memory'));
  assert.equal(READ_ONLY_TOOLS.size, 16);
  assert.equal(WRITE_TOOLS.size, 18);
});
