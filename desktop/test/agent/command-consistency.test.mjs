import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CommandBus, createAgentCommandBus } from '../../src/agent/commands.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { activeMachinePath, machineDesignPath, machineGeometryPaths, readActivePointer } from '../../src/machine/store.ts';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const design = (id) => synthMachine(parseMachineBrief('三工位锁螺丝机，20 件/分钟'), { id, name: id });
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'command-consistency-')); roots.push(root);
  const batches = new Map(); const calls = [];
  const bridge = { async call(method, args) {
    calls.push({ method, args });
    if (method === 'appendMachineBomRows') {
      if (options.deduplicate !== false && batches.has(args.batchId)) return { ok: true, added: 0 };
      batches.set(args.batchId, args.rows); return { ok: true, added: args.rows.length };
    }
    if (method === 'removeMachineBomRows') { batches.delete(args.batchId); return { ok: true }; }
    if (method === 'applyMachineConfig') { await options.refresh?.(args); return { ok: true }; }
    throw new Error(method);
  } };
  const bus = createAgentCommandBus({ listParts: () => [] }, bridge, {
    userDataRoot: root, exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-10-23T08:00:00Z'), buildSolids: options.buildSolids
  });
  return { root, bus, calls, batches };
}
const apply = (bus, args, signal) => bus.execute('apply_machine_design', { withGeometry: false, ...args }, signal);

test('A → B → identical A updates active; undo restores B without deleting A BOM', async () => {
  const { root, bus, batches, calls } = setup();
  const a = design('a'); const b = design('b');
  await apply(bus, { design: a }); const aText = readFileSync(machineDesignPath(root, 'a'), 'utf8');
  await apply(bus, { design: b }); const before = readFileSync(activeMachinePath(root), 'utf8');
  const result = await apply(bus, { design: a });
  assert.equal(result.ok, true); assert.equal(result.data.idempotent, true);
  assert.equal(readActivePointer(root).machineId, 'a');
  assert.equal(readFileSync(machineDesignPath(root, 'a'), 'utf8'), aText);
  assert.equal(batches.size, 2); assert.equal(result.data.bom.added, 0);
  assert.equal((await bus.undoLast()).ok, true);
  assert.equal(readFileSync(activeMachinePath(root), 'utf8'), before);
  assert.equal(calls.filter(c => c.method === 'applyMachineConfig').at(-1).args.config.id, 'b');
  assert.equal(batches.size, 2);
});

test('command bus suppresses repeat BOM append even without renderer deduplication; undo permits reapply', async () => {
  const { bus, calls } = setup({ deduplicate: false }); const d = design('tracked');
  await apply(bus, { design: d });
  const second = await apply(bus, { design: d });
  assert.equal(second.data.bom.added, 0);
  assert.equal(calls.filter(c => c.method === 'appendMachineBomRows').length, 1);
  await bus.undoLast(); await bus.undoLast();
  assert.equal((await apply(bus, { design: d })).ok, true);
  assert.equal(calls.filter(c => c.method === 'appendMachineBomRows').length, 2);
});

test('identical design fulfills newly requested BOM, PLC, geometry and solids; undo preserves original', async () => {
  let builds = 0;
  const { root, bus, batches } = setup({ buildSolids: async () => { builds++; return { ok: false, message: 'offline' }; } });
  const d = design('options');
  await apply(bus, { design: d, withBom: false });
  const original = readFileSync(machineDesignPath(root, 'options'), 'utf8');
  const result = await apply(bus, { design: d, withBom: true, withPlc: true, withGeometry: true, withSolids: true });
  assert.equal(result.ok, true); assert.ok(builds > 0);
  for (const path of [result.data.bomPath, result.data.plcPath, result.data.geometry.jsonPath]) assert.ok(existsSync(path));
  assert.equal(batches.size, 1);
  assert.equal((await bus.undoLast()).ok, true);
  assert.equal(readFileSync(machineDesignPath(root, 'options'), 'utf8'), original);
  assert.equal(existsSync(result.data.plcPath), false); assert.equal(batches.size, 0);
});

for (const phase of ['bridge', 'solids']) test(`abort during delayed ${phase} preserves committed result and undo`, async () => {
  const entered = deferred(); const pending = deferred(); const controller = new AbortController();
  const delay = async () => { entered.release(); await pending.promise; };
  const { root, bus, batches } = setup(phase === 'bridge' ? { refresh: delay } : {
    buildSolids: async () => { await delay(); return { ok: false, message: 'offline' }; }
  });
  const executing = apply(bus, { design: design(phase), ...(phase === 'solids' ? { withGeometry: true, withSolids: true } : {}) }, controller.signal);
  await entered.promise; controller.abort(); pending.release();
  const result = await executing;
  assert.equal(result.ok, true); assert.equal(result.cancellation.state, 'committed');
  assert.match(result.cancellation.message, /撤销/); assert.equal(bus.history().at(-1).ok, true);
  assert.equal(readActivePointer(root).machineId, phase);
  assert.equal((await bus.undoLast()).ok, true);
  assert.equal(existsSync(activeMachinePath(root)), false); assert.equal(batches.size, 0);
});

test('PLC write failure compensates new design, active, BOM and existing PLC bytes', async () => {
  const { root, bus, batches } = setup();
  await apply(bus, { design: design('previous') });
  const before = readFileSync(activeMachinePath(root), 'utf8');
  // A regular file blocks mkdir for this PLC output, after design/active/BOM have been written.
  mkdirSync(join(root, 'exports'), { recursive: true }); writeFileSync(join(root, 'exports', 'plc'), 'keep');
  const result = await apply(bus, { design: design('failed'), withPlc: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'WRITE_FAILED');
  assert.equal(readFileSync(activeMachinePath(root), 'utf8'), before);
  assert.equal(existsSync(machineDesignPath(root, 'failed')), false);
  assert.equal(existsSync(join(root, 'machine', 'failed', 'bom-draft.csv')), false);
  assert.equal(readFileSync(join(root, 'exports', 'plc'), 'utf8'), 'keep'); assert.equal(batches.size, 1);
  assert.equal((await bus.undoLast()).ok, true); assert.equal(existsSync(activeMachinePath(root)), false);
});

test('partial active pointer write failure restores overwritten design bytes', async () => {
  const { root, bus } = setup(); const d = design('same');
  await apply(bus, { design: d }); const before = readFileSync(machineDesignPath(root, 'same'), 'utf8');
  const active = activeMachinePath(root); rmSync(active); mkdirSync(active);
  const changed = structuredClone(d); changed.config.name = 'changed';
  const result = await apply(bus, { design: changed, overwrite: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'WRITE_FAILED');
  assert.equal(readFileSync(machineDesignPath(root, 'same'), 'utf8'), before);
  assert.equal(existsSync(active), true);
});

test('geometry write failure restores prior PLC bytes and preserves a deduplicated BOM batch', async () => {
  const { root, bus, batches } = setup(); const d = design('existing');
  const first = await apply(bus, { design: d, withPlc: true });
  const pointer = readFileSync(activeMachinePath(root), 'utf8');
  writeFileSync(first.data.plcPath, 'custom PLC mapping');
  const paths = machineGeometryPaths(root, 'existing');
  // The first geometry file is written before the blocked STL target fails.
  writeFileSync(paths.json, 'previous geometry'); mkdirSync(paths.stl);
  const result = await apply(bus, { design: d, withPlc: true, withGeometry: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'WRITE_FAILED');
  assert.equal(readFileSync(activeMachinePath(root), 'utf8'), pointer);
  assert.equal(readFileSync(first.data.plcPath, 'utf8'), 'custom PLC mapping');
  assert.equal(readFileSync(paths.json, 'utf8'), 'previous geometry');
  assert.equal(batches.size, 1);
});

test('injected STEP copy failure compensates geometry, PLC, design and BOM', async () => {
  const { root, bus, batches } = setup({
    buildSolids: async () => ({ ok: true, files: { step: { path: '/missing-command-consistency.step', bytes: 10 } } })
  });
  const result = await apply(bus, { design: design('copy-fails'), withPlc: true, withGeometry: true, withSolids: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'WRITE_FAILED');
  assert.match(result.error.message, /STEP/);
  assert.equal(existsSync(activeMachinePath(root)), false);
  assert.equal(existsSync(machineDesignPath(root, 'copy-fails')), false);
  assert.equal(existsSync(machineGeometryPaths(root, 'copy-fails').json), false);
  assert.equal(existsSync(join(root, 'exports', 'plc', 'copy-fails', 'io-map.csv')), false);
  assert.equal(batches.size, 0); assert.equal((await bus.undoLast()).error.code, 'NOTHING_TO_UNDO');
});

test('bus pre-aborted command is never run', async () => {
  const controller = new AbortController(); controller.abort(); let ran = false;
  const bus = new CommandBus({ registry: { listParts: () => [] }, bridge: { call: async () => null } });
  bus.register({ name: 'skip', async run() { ran = true; return { ok: true }; } });
  const result = await bus.execute('skip', {}, controller.signal);
  assert.equal(result.error.code, 'CANCELLED'); assert.equal(ran, false);
  assert.match(result.error.message, /未执行/);
});

test('bus reports actual error after abort, never claims command was unexecuted', async () => {
  const controller = new AbortController();
  const bus = new CommandBus({ registry: { listParts: () => [] }, bridge: { call: async () => null } });
  bus.register({ name: 'fails', async run() { controller.abort(); throw new Error('mutation failed'); } });
  const result = await bus.execute('fails', {}, controller.signal);
  assert.equal(result.error.code, 'COMMAND_FAILED'); assert.match(result.error.message, /mutation failed/);
});
