// 机型库接进智能体（list / save / load / export 四工具）+ 加载后 bomDraft 回填（B4）。
//
// 断言口径：
// - 工具层走真实 AgentTools + CommandBus（假 bridge 只记调用），不 mock 机型库；
// - 库目录、active.json、导出文件都在临时 userData 里，用完删；
// - LIBRARY_EXISTS 的 hint 是硬约束：不带 overwrite 绝不覆盖，且必须告诉调用方「显式传 overwrite」。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import {
  machineBomDraftPath,
  parseMachineBomCsv,
  readActivePointer,
  readStoredMachineDesign
} from '../../src/machine/store.ts';

const BRIEF_A = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const BRIEF_B = '设计一台四工位装配机，节拍 15 件/分钟，用 400W 伺服';
const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cad-machine-library-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: 0 };
      if (method === 'removeMachineBomRows') return { ok: true, removed: 0 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-11-03T02:00:00.000Z')
  });
  return { root, calls, bus, tools: new AgentTools(registry, bus) };
}

/** 用 apply_machine_design 落一台机型，让 active.json 指向它（后续 save 缺省取 active）。 */
async function applyMachine(bus, brief) {
  const design = synthMachine(parseMachineBrief(brief));
  const result = await bus.execute('apply_machine_design', { design, name: design.config.name });
  assert.equal(result.ok, true, `落盘 ${brief} 失败：${JSON.stringify(result.error ?? {})}`);
  return design.config.id;
}

function applicationCalls(calls) {
  return calls.filter((entry) => entry.method === 'applyMachineConfig');
}

test('空机型库：list 返回空数组与 total=0，不报错', async () => {
  const { tools } = setup();
  const result = await tools.call('list_machine_library', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
});

test('保存后 list 多一条，字段与库索引一致', async () => {
  const { tools, bus } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  assert.equal((await tools.call('list_machine_library', {})).total, 0);

  const saved = await tools.call('save_machine_to_library', { version: '1.2.3' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.id, id);
  assert.equal(saved.version, '1.2.3');
  assert.equal(saved.overwritten, false);
  assert.ok(saved.sizeBytes > 0);
  assert.equal(typeof saved.sizeBytes, 'number');

  const listed = await tools.call('list_machine_library', {});
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items.map((item) => item.id), [id]);
  assert.equal(listed.items[0].version, '1.2.3');
  assert.equal(listed.items[0].source, 'local');
  for (const key of ['id', 'name', 'version', 'sizeBytes', 'source', 'updatedAt']) {
    assert.ok(key in listed.items[0], `索引项缺字段 ${key}`);
  }
});

test('重复保存不带 overwrite：LIBRARY_EXISTS + 覆盖提示，库内容不变', async () => {
  const { tools, bus } = setup();
  await applyMachine(bus, BRIEF_A);
  const first = await tools.call('save_machine_to_library', {});
  assert.equal(first.ok, true);

  const again = await tools.call('save_machine_to_library', {});
  assert.equal(again.ok, false);
  assert.equal(again.code, 'LIBRARY_EXISTS');
  assert.equal(again.hint, '同名机型已存在，确认覆盖请显式传 overwrite: true');
  assert.match(again.message, /同名|已存在|overwrite/);
  // 没被覆盖：仍是 1 条，版本还是第一次的 1.0.0
  const listed = await tools.call('list_machine_library', {});
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].version, '1.0.0');
});

test('显式 overwrite: true 才覆盖同名机型', async () => {
  const { tools, bus } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  assert.equal((await tools.call('save_machine_to_library', { version: '1.0.0' })).ok, true);

  const replaced = await tools.call('save_machine_to_library', { overwrite: true, version: '2.0.0' });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.equal(replaced.overwritten, true);
  assert.equal(replaced.version, '2.0.0');
  assert.equal(replaced.id, id);

  const listed = await tools.call('list_machine_library', {});
  assert.equal(listed.total, 1, '覆盖不该产生第二条索引');
  assert.equal(listed.items[0].version, '2.0.0');
});

test('加载：active.json 指向该机型，bridge 收到 applyMachineConfig', async () => {
  const { tools, bus, calls, root } = setup();
  const idA = await applyMachine(bus, BRIEF_A);
  await tools.call('save_machine_to_library', {});
  const idB = await applyMachine(bus, BRIEF_B);
  assert.notEqual(idA, idB);
  assert.equal(readActivePointer(root).machineId, idB);

  calls.length = 0;
  const loaded = await tools.call('load_machine_from_library', { id: idA });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.id, idA);
  assert.equal(readActivePointer(root).machineId, idA, 'active.json 必须指回被加载的机型');

  const refresh = applicationCalls(calls);
  assert.equal(refresh.length, 1, 'applyMachineConfig 必须调用恰好一次');
  assert.equal(refresh[0].args.machineId, idA);
  assert.equal(refresh[0].args.config.id, idA);

  const stored = readStoredMachineDesign(root, idA);
  assert.ok(stored);
  assert.equal(loaded.stations, stored.config.stations.length);
});

test('加载未知机型：LIBRARY_NOT_FOUND + 查库提示，active 不变', async () => {
  const { tools, bus, root } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  const result = await tools.call('load_machine_from_library', { id: 'not-in-library' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LIBRARY_NOT_FOUND');
  assert.match(result.hint ?? '', /list_machine_library/);
  assert.equal(readActivePointer(root).machineId, id, '失败时不能动 active.json');
});

test('导出：默认路径落盘，二次导出 sha256 相同', async () => {
  const { tools, bus, root } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  await tools.call('save_machine_to_library', {});

  const first = await tools.call('export_machine_package', { id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.path, resolve(root, 'exports', 'machines', `${id}.machine.zip`));
  assert.equal(existsSync(first.path), true);
  assert.equal(readFileSync(first.path).byteLength, first.bytes);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);

  const digest = createHash('sha256').update(readFileSync(first.path)).digest('hex');
  assert.equal(first.sha256, digest, '返回的 sha256 必须是落盘文件的摘要');

  const second = await tools.call('export_machine_package', { id });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.path, first.path);
  assert.equal(second.sha256, first.sha256, '同一机型二次导出必须字节一致');
});

test('导出目标路径越界被拒：相对 ../ 与 exports 外绝对路径都不落盘', async () => {
  const { tools, bus, root } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  await tools.call('save_machine_to_library', {});

  const escape = await tools.call('export_machine_package', { id, targetPath: '../../escaped.machine.zip' });
  assert.equal(escape.ok, false);
  assert.equal(escape.code, 'LIBRARY_BAD_PATH');
  assert.equal(existsSync(resolve(root, '..', '..', 'escaped.machine.zip')), false);

  const absoluteOutside = `/${['tmp', 'machine-outside'].join('/')}/x.machine.zip`;
  const outside = await tools.call('export_machine_package', { id, targetPath: absoluteOutside });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'LIBRARY_BAD_PATH');
  assert.equal(existsSync(absoluteOutside), false);

  // exports 之内的显式相对路径是允许的（不能把整类显式路径都拒掉）
  const inside = await tools.call('export_machine_package', { id, targetPath: 'shared/copy' });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.equal(inside.path, resolve(root, 'exports', 'shared', 'copy.machine.zip'));
  assert.equal(existsSync(inside.path), true);
});

test('BOM 往返：bom.csv 解析回 bomDraft.items，行数与保存前一致（B4）', async () => {
  const { tools, bus, root } = setup();
  const id = await applyMachine(bus, BRIEF_A);
  const before = readStoredMachineDesign(root, id);
  const beforeRows = before.bomDraft?.items.length ?? 0;
  assert.ok(beforeRows > 0, '样机方案应带 BOM 草稿，否则往返断言没有意义');

  await tools.call('save_machine_to_library', {});
  // 模拟「这台机器被删掉、只剩库里的包」：清掉方案文件后从库加载
  rmSync(join(root, 'machine', `${id}.json`), { force: true });
  assert.equal(readStoredMachineDesign(root, id), null);

  const loaded = await tools.call('load_machine_from_library', { id });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.parts, beforeRows, '工具返回的 parts 应等于 BOM 行数');

  const after = readStoredMachineDesign(root, id);
  assert.ok(after);
  assert.equal(after.bomDraft?.items.length, beforeRows, '加载后 bomDraft.items 不能为空');

  // bom-draft.csv 与解析结果同源：行数一致，字段能对上
  const csv = readFileSync(machineBomDraftPath(root, id), 'utf8');
  const parsed = parseMachineBomCsv(csv);
  assert.equal(parsed.length, beforeRows);
  assert.deepEqual(
    after.bomDraft.items.map((item) => [item.kind, item.name, item.qty]),
    parsed.map((item) => [item.kind, item.name, item.qty])
  );
  const kinds = new Set(after.bomDraft.items.map((item) => item.kind));
  for (const kind of kinds) assert.ok(['actuator', 'sensor', 'electrical'].includes(kind));
});

test('读写分类：list 只读，其余三个写（写操作必须走确认）', () => {
  assert.equal(READ_ONLY_TOOLS.has('list_machine_library'), true);
  for (const name of ['save_machine_to_library', 'load_machine_from_library', 'export_machine_package']) {
    assert.equal(WRITE_TOOLS.has(name), true, `${name} 必须归到写工具`);
    assert.equal(READ_ONLY_TOOLS.has(name), false, `${name} 不能同时是只读`);
  }
});

test('入参校验：缺 id / 类型不对一律 INVALID_ARGUMENT，不触库', async () => {
  const { tools } = setup();
  const missingId = await tools.call('load_machine_from_library', {});
  assert.equal(missingId.code, 'INVALID_ARGUMENT');
  const badType = await tools.call('export_machine_package', { id: 'x', targetPath: 42 });
  assert.equal(badType.code, 'INVALID_ARGUMENT');
  const badOverwrite = await tools.call('save_machine_to_library', { overwrite: 'yes' });
  assert.equal(badOverwrite.code, 'INVALID_ARGUMENT');
  assert.equal((await tools.call('list_machine_library', {})).total, 0);
});
