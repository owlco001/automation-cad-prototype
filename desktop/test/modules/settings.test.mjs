import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleManager, MODULE_SETTINGS_KEY } from '../../src/modules/registry.ts';
import { isParametricHistoryEnabled } from '../../src/modules/parametric-history-gate.ts';
import { createUndoRedoHistory } from '../../src/parametric/model.ts';

function memoryStorage(initial = null) {
  const data = new Map();
  if (initial !== null) data.set(MODULE_SETTINGS_KEY, initial);
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); }
  };
}

function idState(manager, id) {
  const state = manager.list().find((module) => module.id === id);
  assert.ok(state);
  return state;
}

test('关闭 PLC 模块持久化并在重新创建管理器后保持关闭，且不清除其它存储值', () => {
  const storage = memoryStorage();
  storage.data.set('automationcad.plcgen.history.v1', '[{"inputHash":"existing"}]');
  storage.data.set('automationcad.project.plc.v1', '{"sequence":[{"id":"existing-step"}]}');
  const manager = createModuleManager(storage);

  assert.equal(idState(manager, 'plcgen').enabled, true, '缺少覆盖项时保持旧功能默认开启');
  let notices = 0;
  const unsubscribe = manager.subscribe(() => { notices += 1; });
  manager.setEnabled('plcgen', false);
  unsubscribe();

  assert.equal(idState(manager, 'plcgen').status, 'disabled');
  assert.equal(notices, 1);
  assert.equal(storage.getItem('automationcad.plcgen.history.v1'), '[{"inputHash":"existing"}]');
  assert.equal(storage.getItem('automationcad.project.plc.v1'), '{"sequence":[{"id":"existing-step"}]}');
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { plcgen: false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'plcgen').enabled, false);
  assert.equal(idState(restarted, 'core').enabled, true);
  assert.equal(idState(restarted, 'system.update').enabled, true);
});

test('elec.validation 默认兼容旧安装；关闭/重启/重开只改开关并保留电气数据与审计历史', () => {
  const storage = memoryStorage();
  const preserved = {
    'automationcad.electrical.project.v1': JSON.stringify({ wires: [{ no: '101' }], design: 'existing' }),
    'automationcad.agent.audit.history': '[{"tool":"run_electrical_check","status":"completed"}]',
    'automationcad.electrical.library.state': '{"selected":"QF1"}',
    'automationcad.enclosure.placements.v1': '[{"id":"placed-1"}]'
  };
  for (const [key, value] of Object.entries(preserved)) storage.data.set(key, value);

  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'elec.validation').enabled, true, '未显式配置时沿用已有校验行为');
  manager.setEnabled('elec.validation', false);
  assert.equal(idState(manager, 'elec.validation').status, 'disabled');
  assert.equal(idState(manager, 'core').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'elec.validation': false }
  });
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'elec.validation').enabled, false);
  restarted.setEnabled('elec.validation', true);
  assert.equal(idState(restarted, 'elec.validation').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), { schemaVersion: 1, overrides: {} });
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);

  const legacySettings = memoryStorage(JSON.stringify({ schemaVersion: 1, overrides: { plcgen: false } }));
  assert.equal(idState(createModuleManager(legacySettings), 'elec.validation').enabled, true);
});

test('system.update 默认启用；关闭持久化并重开后恢复，且不修改其它设置', () => {
  const storage = memoryStorage();
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'system.update').enabled, true);
  assert.deepEqual(idState(manager, 'system.update').dependencies, ['core']);

  manager.setEnabled('system.update', false);
  assert.equal(idState(manager, 'system.update').status, 'disabled');
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'system.update': false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'system.update').enabled, false);
  restarted.setEnabled('system.update', true);
  assert.equal(idState(restarted, 'system.update').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), { schemaVersion: 1, overrides: {} });
});

test('cost.estimation 默认兼容启用；关闭/重启/重开仅切换状态并保留价格簿、成本数据与项目/BOM', () => {
  const storage = memoryStorage();
  const preserved = {
    'packs/builtin/pricebook-cn/pricebook.json': '{"items":{"existing":{"unitPrice":10}}}',
    'automationcad.cost.data.v1': '{"estimate":"existing"}',
    'automationcad.cost.reports.v1': '[{"path":"exports/old-cost.csv"}]',
    'automationcad.project.bom.v1': '[{"name":"existing BOM row"}]',
    'automationcad.agent.audit.history': '[{"tool":"run_cost_report","status":"completed"}]'
  };
  for (const [key, value] of Object.entries(preserved)) storage.data.set(key, value);
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'cost.estimation').enabled, true);
  assert.deepEqual(idState(manager, 'cost.estimation').dependencies, ['core']);

  manager.setEnabled('cost.estimation', false);
  assert.equal(idState(manager, 'cost.estimation').status, 'disabled');
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'cost.estimation': false }
  });
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'cost.estimation').enabled, false);
  restarted.setEnabled('cost.estimation', true);
  assert.equal(idState(restarted, 'cost.estimation').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), { schemaVersion: 1, overrides: {} });
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);
});

test('重新启用已关闭模块会清除默认态覆盖项并恢复默认状态', () => {
  const storage = memoryStorage(JSON.stringify({ schemaVersion: 1, overrides: { plcgen: false } }));
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'plcgen').enabled, false);
  manager.setEnabled('plcgen', true);
  assert.equal(idState(manager, 'plcgen').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), { schemaVersion: 1, overrides: {} });
});

test('联调 IO 测试与 PLC 程序生成可分别启停，关闭测试模块不改变 PLC 模块状态', () => {
  const storage = memoryStorage();
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'plcgen').enabled, true);
  assert.equal(idState(manager, 'commission.io-test').enabled, true);

  manager.setEnabled('commission.io-test', false);
  assert.equal(idState(manager, 'commission.io-test').enabled, false);
  assert.equal(idState(manager, 'plcgen').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'commission.io-test': false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'commission.io-test').enabled, false);
  assert.equal(idState(restarted, 'plcgen').enabled, true);
  restarted.setEnabled('plcgen', false);
  assert.equal(idState(restarted, 'commission.io-test').enabled, false);
  assert.equal(idState(restarted, 'plcgen').enabled, false);
});

test('factory.plc-sync 可独立关闭并持久化，默认设置仍兼容旧安装', () => {
  const storage = memoryStorage();
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'factory.plc-sync').enabled, true);
  manager.setEnabled('factory.plc-sync', false);
  assert.equal(idState(manager, 'factory.plc-sync').status, 'disabled');
  assert.equal(idState(manager, 'plcgen').enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'factory.plc-sync': false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'factory.plc-sync').enabled, false);
  assert.equal(idState(restarted, 'plcgen').enabled, true);
  restarted.setEnabled('factory.plc-sync', true);
  assert.equal(idState(restarted, 'factory.plc-sync').enabled, true);
});

test('关闭并重新启用参数化 CAD 模块只保存开关，不改特征树、原 CAD 与叠加体数据', () => {
  const storage = memoryStorage();
  const preserved = {
    'automationcad.parametric.v1': JSON.stringify({ version: 1, buckets: { 'fixture.step': { features: [{ id: 'f1' }] } } }),
    'automationcad.cad.original.fixture.step': 'raw-cad-reference',
    'automationcad.cad.parametric-overlay.fixture.step': 'existing-overlay'
  };
  for (const [key, value] of Object.entries(preserved)) storage.data.set(key, value);

  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'cad.parametric-import').enabled, true, '旧安装默认保持启用');
  manager.setEnabled('cad.parametric-import', false);
  assert.equal(idState(manager, 'cad.parametric-import').status, 'disabled');
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'cad.parametric-import': false }
  });

  const restarted = createModuleManager(storage);
  assert.equal(idState(restarted, 'cad.parametric-import').enabled, false);
  restarted.setEnabled('cad.parametric-import', true);
  assert.equal(idState(restarted, 'cad.parametric-import').enabled, true);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);
});

test('关闭/恢复 parametric.history 只保存模块状态，保留项目数据与同会话 undo/redo 栈', () => {
  const storage = memoryStorage();
  const preserved = {
    'automationcad.parametric.v1': JSON.stringify({ version: 1, buckets: { 'fixture.step': { features: [{ id: 'f1' }] } } }),
    'automationcad.cad.original.fixture.step': 'raw-cad-reference',
    'automationcad.cad.parametric-overlay.fixture.step': 'existing-overlay'
  };
  for (const [key, value] of Object.entries(preserved)) storage.data.set(key, value);

  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'parametric.history').enabled, true);
  const isEnabled = () => manager.getStatus('parametric.history').enabled;
  const history = createUndoRedoHistory();
  history.push(0, { now: 0 });
  history.push(1, { now: 1 });
  let current = history.undo(2);
  const before = { current, undo: history.undoCount(), redo: history.redoCount() };
  assert.deepEqual(before, { current: 1, undo: 1, redo: 1 });

  manager.setEnabled('parametric.history', false);
  assert.equal(isParametricHistoryEnabled(isEnabled), false);
  assert.deepEqual({ current, undo: history.undoCount(), redo: history.redoCount() }, before);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'parametric.history': false }
  });

  manager.setEnabled('parametric.history', true);
  assert.equal(isParametricHistoryEnabled(isEnabled), true);
  current = history.redo(current);
  assert.equal(current, 2, '同一会话原有 redo 分支恢复后仍可继续使用');
  assert.equal(history.canUndo(), true);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((key) => [key, storage.getItem(key)])), preserved);
});

test('plcgen 被关闭时拒绝启用 factory.plc-sync，且重开 plcgen 后遵循原开关状态', () => {
  const storage = memoryStorage();
  const manager = createModuleManager(storage);
  manager.setEnabled('plcgen', false);
  assert.equal(idState(manager, 'factory.plc-sync').status, 'unavailable');
  assert.throws(() => manager.setEnabled('factory.plc-sync', true), /依赖模块/);
  manager.setEnabled('plcgen', true);
  assert.equal(idState(manager, 'factory.plc-sync').enabled, true, '未显式关闭的默认同步扩展恢复启用');
});

test('损坏设置、未知模块和非法覆盖值不启用未知功能，也不改变默认兼容状态', () => {
  const storage = memoryStorage(JSON.stringify({
    schemaVersion: 1,
    overrides: { unknownModule: true, plcgen: 'true', core: false, 'system.update': true }
  }));
  const manager = createModuleManager(storage);
  assert.equal(idState(manager, 'plcgen').enabled, true);
  assert.equal(idState(manager, 'core').enabled, true);
  assert.equal(idState(manager, 'system.update').enabled, true);
  assert.equal(manager.getStatus('unknownModule').enabled, false);

  const broken = createModuleManager({ getItem: () => '{not-json', setItem: () => { throw new Error('disk full'); } });
  assert.equal(idState(broken, 'plcgen').enabled, true);
  assert.equal(broken.persistenceAvailable(), false);
  assert.throws(() => broken.setEnabled('plcgen', false), /模块设置保存失败/);
  assert.equal(idState(broken, 'plcgen').enabled, true, '持久化失败时不提交状态变更');
  assert.equal(broken.persistenceAvailable(), false);
});

test('模块版本或依赖不可用时拒绝启用，且核心模块不可关闭', () => {
  const storage = memoryStorage(JSON.stringify({ schemaVersion: 1, overrides: { plcgen: false } }));
  const registry = [
    {
      id: 'core', name: 'core', version: '1.0.0', apiCompatibility: { min: 1, max: 1 }, dependencies: [],
      requiredCapabilities: ['workspace.project-storage', 'workspace.extension-host'], description: 'core',
      kind: 'core', defaultEnabled: true, implemented: true
    },
    {
      id: 'versioned', name: 'versioned', version: '2.0.0', apiCompatibility: { min: 2, max: 2 }, dependencies: ['core'],
      requiredCapabilities: [], description: 'versioned', kind: 'optional', defaultEnabled: false, implemented: true
    },
    {
      id: 'orphan', name: 'orphan', version: '1.0.0', apiCompatibility: { min: 1, max: 1 }, dependencies: ['missing-dependency'],
      requiredCapabilities: [], description: 'orphan', kind: 'optional', defaultEnabled: false, implemented: true
    }
  ];
  const manager = createModuleManager(storage, { registry, apiVersion: 1 });
  assert.equal(manager.getStatus('versioned').enabled, false);
  assert.match(manager.getStatus('versioned').reason, /API 不兼容/);
  assert.throws(() => manager.setEnabled('versioned', true), /API 不兼容/);
  assert.equal(manager.getStatus('orphan').enabled, false);
  assert.throws(() => manager.setEnabled('orphan', true), /依赖模块/);
  assert.throws(() => manager.setEnabled('core', false), /核心模块不能关闭/);
});
