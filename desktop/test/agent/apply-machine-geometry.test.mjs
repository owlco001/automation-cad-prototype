import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { geometryToStl } from '../../src/machine/geometry-export.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { machineGeometryPaths } from '../../src/machine/store.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { applyStationGeometryLayout } from '../../src/machine/station-layout.ts';
import { validateFeatures } from '../../src/parametric/features.ts';

const BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-machine-geom-'));
  roots.push(root);
  const bridge = {
    async call(method, args) {
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: Array.isArray(args?.rows) ? args.rows.length : 0 };
      if (method === 'removeMachineBomRows') return { ok: true, removed: 1 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('Sat 2026-10-24 1:00 AM CST (UTC+08:00)'),
    ...(options.buildSolids ? { buildSolids: options.buildSolids } : {})
  });
  return { root, bus, tools: new AgentTools(registry, bus) };
}

test('apply 默认生成参数化几何：geometry.json / model.stl / model.gltf / sidecar-assembly.json', async () => {
  const { root, bus } = setup();
  const result = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(result.ok, true);
  const geometry = result.data.geometry;
  assert.ok(geometry);
  const paths = machineGeometryPaths(root, 'design-screw-3st');
  assert.equal(geometry.jsonPath, paths.json);
  for (const path of [paths.json, paths.stl, paths.gltf, paths.sidecar]) assert.ok(existsSync(path), path);
  assert.equal(geometry.layout, 'linear');
  assert.equal(geometry.stations, 3);
  assert.equal(geometry.movingAxes, 6);
  const stored = JSON.parse(readFileSync(paths.json, 'utf8'));
  assert.equal(stored.kind, 'machine-geometry');
  assert.equal(stored.parts.length, geometry.parts);
  assert.equal(readFileSync(paths.stl).byteLength, geometry.stlBytes);
  const gltf = JSON.parse(readFileSync(paths.gltf, 'utf8'));
  assert.equal(gltf.asset.version, '2.0');
  const sidecar = JSON.parse(readFileSync(paths.sidecar, 'utf8'));
  assert.equal(sidecar.chunks.length, geometry.sidecarChunks);
  for (const chunk of sidecar.chunks) assert.deepEqual(validateFeatures(chunk), []);
  assert.equal(geometry.solids, undefined);
});

test('Agent apply 的偏移 MachineDesign 按稳定身份导出相同的 JSON 与 STL 几何', async () => {
  const { root, bus } = setup();
  const design = synthMachine(parseMachineBrief(BRIEF));
  const identities = design.config.stations.map((_station, index) => `station:agent-offset-${index + 1}`);
  design.stationIdentities = identities;
  design.stationGeometryLayout = {
    schemaVersion: 2,
    offsets: [{ stationIdentity: identities[1], stationName: design.config.stations[1], xMm: 125, yMm: -80 }]
  };
  const result = await bus.execute('apply_machine_design', { design });
  assert.equal(result.ok, true);
  const paths = machineGeometryPaths(root, design.config.id);
  const stored = JSON.parse(readFileSync(paths.json, 'utf8'));
  const expected = applyStationGeometryLayout(
    generateMachineGeometry(design),
    design.stationGeometryLayout,
    identities
  );
  assert.deepEqual(stored, expected);
  assert.equal(Buffer.compare(readFileSync(paths.stl), Buffer.from(geometryToStl(expected))), 0);
  const shiftedPlate = stored.parts.find((part) => part.stationId === 'st2' && part.role === 'plate');
  const baselinePlate = generateMachineGeometry(design).parts.find((part) => part.stationId === 'st2' && part.role === 'plate');
  assert.deepEqual(shiftedPlate.center, [baselinePlate.center[0] + 125, baselinePlate.center[1] - 80, baselinePlate.center[2]]);
});

test('apply 撤销：几何产物随方案一起删除；覆盖时恢复旧几何', async () => {
  const { root, bus } = setup();
  const paths = machineGeometryPaths(root, 'design-screw-3st');
  const first = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(first.ok, true);
  const firstJson = readFileSync(paths.json, 'utf8');
  const second = await bus.execute('apply_machine_design', { brief: BRIEF, overwrite: true, name: '改名后的锁螺丝机' });
  assert.equal(second.ok, true);
  assert.notEqual(readFileSync(paths.json, 'utf8'), firstJson);
  assert.equal((await bus.undoLast()).ok, true);
  assert.equal(readFileSync(paths.json, 'utf8'), firstJson);
  assert.equal((await bus.undoLast()).ok, true);
  for (const path of [paths.json, paths.stl, paths.gltf, paths.sidecar]) assert.equal(existsSync(path), false, path);
});

test('withGeometry=false 不生成几何；withSolids 需要 withGeometry', async () => {
  const { root, bus } = setup();
  const result = await bus.execute('apply_machine_design', { brief: BRIEF, withGeometry: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.geometry, undefined);
  assert.equal(existsSync(machineGeometryPaths(root, 'design-screw-3st').stl), false);
  const bad = await bus.execute('apply_machine_design', { brief: BRIEF, overwrite: true, withGeometry: false, withSolids: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_ARGUMENT');
});

test('withSolids：内核不可用时回退 TS 网格并给 warning；可用时复制 STEP 到 solids/', async () => {
  const offline = setup();
  const fallback = await offline.bus.execute('apply_machine_design', { brief: BRIEF, withSolids: true });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.data.geometry.solids.mode, 'mesh-fallback');
  assert.ok(fallback.data.warnings.some((warning) => /回退为 TS 网格/.test(warning)));
  assert.ok(existsSync(fallback.data.geometry.stlPath));

  const scratch = mkdtempSync(join(tmpdir(), 'cad-fake-step-'));
  roots.push(scratch);
  const docs = [];
  const online = setup({
    buildSolids: async (doc) => {
      docs.push(doc);
      const path = join(scratch, `chunk-${docs.length}.step`);
      writeFileSync(path, `ISO-10303-21; chunk ${docs.length}`);
      return { ok: true, files: { step: { path, bytes: 30 } } };
    }
  });
  const solid = await online.bus.execute('apply_machine_design', { brief: BRIEF, withSolids: true });
  assert.equal(solid.ok, true);
  const solids = solid.data.geometry.solids;
  assert.equal(solids.mode, 'solids');
  assert.equal(solids.stepPaths.length, docs.length);
  assert.equal(docs.length, solid.data.geometry.sidecarChunks);
  for (const doc of docs) assert.deepEqual(validateFeatures(doc), []);
  assert.match(readFileSync(solids.stepPaths[0], 'utf8'), /ISO-10303-21; chunk 1/);
  assert.equal((await online.bus.undoLast()).ok, true);
  for (const path of solids.stepPaths) assert.equal(existsSync(path), false, path);
});

test('工具层：schema 含 withGeometry/withSolids 且拒绝非布尔；design_machine 返回几何摘要', async () => {
  const { tools } = setup();
  const tool = tools.summaries().find((item) => item.name === 'apply_machine_design');
  assert.equal(tool.inputSchema.properties.withGeometry.type, 'boolean');
  assert.equal(tool.inputSchema.properties.withSolids.type, 'boolean');
  const rejected = await tools.call('apply_machine_design', { brief: BRIEF, withGeometry: 'yes' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INVALID_ARGUMENT');
  const designed = await tools.call('design_machine', { brief: BRIEF });
  assert.equal(designed.ok, true);
  assert.equal(designed.geometry.layout, 'linear');
  assert.equal(designed.geometry.stations, 3);
  assert.equal(designed.geometry.movingAxes, 6);
  assert.equal(designed.geometry.envelopeMm.length, 3);
  assert.ok(designed.geometry.envelopeMm.every((value) => value > 0));
  assert.ok(designed.summary.length <= 600);
});

test('withSolids：清掉上一次遗留的 part-N.step（撤销可恢复），近似件清零且不再有方棒 warning', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cad-fake-step-'));
  roots.push(scratch);
  let chunk = 0;
  const { root, bus } = setup({
    buildSolids: async () => {
      chunk += 1;
      const path = join(scratch, `chunk-${chunk}.step`);
      writeFileSync(path, `ISO-10303-21; chunk ${chunk}`);
      return { ok: true, files: { step: { path, bytes: 30 } } };
    }
  });
  const paths = machineGeometryPaths(root, 'design-screw-3st');
  mkdirSync(paths.solidsDir, { recursive: true });
  const stale = join(paths.solidsDir, 'part-9.step');
  writeFileSync(stale, 'ISO-10303-21; 上一次的旧块');
  const result = await bus.execute('apply_machine_design', { brief: BRIEF, withSolids: true });
  assert.equal(result.ok, true);
  const solids = result.data.geometry.solids;
  assert.equal(solids.mode, 'solids');
  assert.equal(existsSync(stale), false, '旧分块应被清理');
  for (const path of solids.stepPaths) assert.ok(existsSync(path), path);
  // 横轴圆柱改精确 cylinder 后：contract 字段保留但恒为 0，且不得再出现方棒近似 warning
  const approximated = result.data.geometry.approximatedIds;
  assert.ok(Array.isArray(approximated));
  assert.equal(approximated.length, 0, '横轴滚筒/传动轴已精确，不再有近似件');
  assert.equal(result.data.geometry.approximated, 0);
  assert.ok(!result.data.warnings.some((warning) => /等截面方棒近似/.test(warning)), result.data.warnings.join('；'));
  // 撤销：清掉的旧块按快照恢复，本次新写入的 STEP 被删除
  assert.equal((await bus.undoLast()).ok, true);
  assert.ok(existsSync(stale), '撤销应恢复旧分块');
  for (const path of solids.stepPaths) assert.equal(existsSync(path), false, path);
  assert.equal(readFileSync(stale, 'utf8'), 'ISO-10303-21; 上一次的旧块');
});
