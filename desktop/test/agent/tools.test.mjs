import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { agentToolTotal } from '../../test-support/agent-registry.mjs';
import { createAgentCommandBus, SIMPLE_BOM_NOTE } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS } from '../../src/agent/router.ts';

let sandbox;
let tools;
let bridge;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-tools-test-'));
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
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: { 缸径: '20 mm' } }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  bridge = {
    calls: [],
    async call(method, args) {
      this.calls.push({ method, args });
      if (method === 'getBom') return [];
      if (method === 'runInterference') {
        return {
          hits: 25,
          items: Array.from({ length: 25 }, (_value, index) => ({
            a: `A${index}`,
            b: `B${index}`,
            volume: index,
            severity: 'warning'
          }))
        };
      }
      if (method === 'insertComponent') return { ok: true, meshIndex: 0, name: args[0].model };
      if (method === 'removeComponent') return { ok: true };
      if (method === 'importPath') return { ok: true, meshCount: 1, triangleCount: 12 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  tools = new AgentTools(registry, createAgentCommandBus(registry, bridge));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test(`工具表为 ${agentToolTotal()} 个且不存在 NOT_IMPLEMENTED`, () => {
  assert.deepEqual(tools.list().map((tool) => tool.name).sort(), [
    'apply_machine_design',
    'build_canvas_assembly',
    'build_machine_model',
    'design_machine',
    'export_cost_report',
    'export_files',
    'get_bom',
    'get_project_context',
    'get_render_stats',
    'import_cad',
    'insert_component',
    'list_components',
    'place_component',
    'remove_component',
    'run_cost_report',
    'run_electrical_check',
    'run_interference_check',
    'run_plc_generate',
    'save_scene_as_project',
    'search_components',
    'search_docs',
    'suggest_kinematics',
    'undo_last',
    'update_component',
    'verify_plc_program'
  ]);
  for (const tool of tools.list()) {
    assert.doesNotMatch(JSON.stringify(tool), /NOT_IMPLEMENTED|尚未实现|未实现/);
  }
});

test('list_components 保持原有筛选行为', async () => {
  const result = await tools.call('list_components', { category: '气缸' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.components[0].model, 'MXQ20-50.stp');
});

test('import_cad 经命令总线返回网格与三角面统计', async () => {
  const result = await tools.call('import_cad', {
    path: resolve('test', 'fixtures', 'cube.stp')
  });
  assert.equal(result.ok, true);
  assert.equal(result.meshCount, 1);
  assert.equal(result.triangleCount, 12);
  assert.equal(bridge.calls.at(-1).method, 'importPath');
});

test('get_bom 空模型返回空数组与 note', async () => {
  const result = await tools.call('get_bom', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
  assert.equal(result.note, SIMPLE_BOM_NOTE);
});

test('get_render_stats 是只读工具；没有桌面缓存时明确返回 available=false', async () => {
  assert.equal(READ_ONLY_TOOLS.has('get_render_stats'), true);
  const result = await tools.call('get_render_stats', {});
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.render, null);
  assert.match(result.conclusion, /尚未收到渲染指标/);
});

test('run_interference_check 返回命中数并截断前 20 条', async () => {
  const result = await tools.call('run_interference_check', {});
  assert.equal(result.ok, true);
  assert.equal(result.hits, 25);
  assert.equal(result.items.length, 20);
});

test('insert_component 返回 meshIndex/name，undo_last 走总线撤销', async () => {
  const inserted = await tools.call('insert_component', { partId: 'MXQ20-50', name: '定位气缸' });
  assert.equal(inserted.ok, true);
  assert.equal(inserted.meshIndex, 0);
  assert.equal(inserted.name, '定位气缸');

  const undone = await tools.call('undo_last', {});
  assert.equal(undone.ok, true);
  assert.equal(undone.command, 'insert_component');
  assert.equal(bridge.calls.at(-1).method, 'removeComponent');
});

test('insert_component 对未知 partId 返回 PART_NOT_FOUND', async () => {
  const result = await tools.call('insert_component', { partId: 'NOT-EXIST' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PART_NOT_FOUND');
});
