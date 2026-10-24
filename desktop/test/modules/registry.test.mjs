import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODULE_API_VERSION,
  MODULE_REGISTRY,
  createModuleManager,
  resolveModuleStates
} from '../../src/modules/registry.ts';
import { isParametricHistoryEnabled } from '../../src/modules/parametric-history-gate.ts';

function find(states, id) {
  const state = states.find((module) => module.id === id);
  assert.ok(state, `missing module ${id}`);
  return state;
}

const memoryStorage = () => {
  const data = new Map();
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); }
  };
};

test('注册表描述 core、PLC、电气校验、参数化 CAD/history、联调与系统更新模块', () => {
  const modules = MODULE_REGISTRY;
  const core = modules.find((module) => module.id === 'core');
  const plc = modules.find((module) => module.id === 'plcgen');
  const elecValidation = modules.find((module) => module.id === 'elec.validation');
  const ioTest = modules.find((module) => module.id === 'commission.io-test');
  const parametric = modules.find((module) => module.id === 'cad.parametric-import');
  const parametricHistory = modules.find((module) => module.id === 'parametric.history');
  const plcSync = modules.find((module) => module.id === 'factory.plc-sync');
  const update = modules.find((module) => module.id === 'system.update');
  const costEstimation = modules.find((module) => module.id === 'cost.estimation');
  assert.ok(core);
  assert.ok(plc);
  assert.ok(elecValidation);
  assert.ok(ioTest);
  assert.ok(parametric);
  assert.ok(parametricHistory);
  assert.ok(plcSync);
  assert.ok(update);
  assert.ok(costEstimation);
  for (const module of modules) {
    assert.equal(typeof module.version, 'string');
    assert.ok(module.apiCompatibility.min <= module.apiCompatibility.max);
    assert.ok(Array.isArray(module.dependencies));
    assert.ok(Array.isArray(module.requiredCapabilities));
    assert.ok(module.description);
  }
  assert.equal(core.kind, 'core');
  assert.equal(plc.kind, 'optional');
  assert.equal(plc.defaultEnabled, true);
  assert.deepEqual(plc.dependencies, ['core']);
  assert.equal(elecValidation.kind, 'optional');
  assert.equal(elecValidation.version, '1.0.0');
  assert.equal(elecValidation.defaultEnabled, true);
  assert.deepEqual(elecValidation.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(elecValidation.dependencies, ['core']);
  assert.deepEqual(elecValidation.requiredCapabilities, [
    'elec.validation.rules', 'elec.validation.panel', 'agent.electrical-check', 'elec.validation.report.export'
  ]);
  assert.match(elecValidation.description, /既有 Agent 审计历史/);
  assert.equal(ioTest.kind, 'optional');
  assert.equal(ioTest.defaultEnabled, true);
  assert.deepEqual(ioTest.dependencies, ['core']);
  assert.deepEqual(ioTest.requiredCapabilities, ['commission.io-test.execute']);
  assert.match(ioTest.description, /保留 PLC 连接、断开、点位读写、实时监视/);
  assert.notEqual(ioTest.id, plc.id);
  assert.equal(parametric.kind, 'optional');
  assert.equal(parametric.version, '1.0.0');
  assert.equal(parametric.defaultEnabled, true);
  assert.deepEqual(parametric.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(parametric.dependencies, ['core']);
  assert.deepEqual(parametric.requiredCapabilities, [
    'cad.parametric.feature-tree', 'cad.parametric.sidecar-build', 'cad.parametric.export'
  ]);
  assert.match(parametric.description, /关闭只停用参数化编辑与重建/);
  assert.match(parametric.description, /只读查看/);
  assert.match(parametric.description, /不会自动变成可编辑特征/);
  assert.equal(parametricHistory.kind, 'optional');
  assert.equal(parametricHistory.version, '1.0.0');
  assert.equal(parametricHistory.defaultEnabled, true);
  assert.deepEqual(parametricHistory.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(parametricHistory.dependencies, ['core', 'cad.parametric-import']);
  assert.deepEqual(parametricHistory.requiredCapabilities, ['cad.parametric.undo-redo']);
  assert.match(parametricHistory.description, /不清空或回退特征树/);
  assert.match(parametricHistory.description, /继续编辑时仍记录历史/);
  assert.equal(plcSync.kind, 'optional');
  assert.equal(plcSync.defaultEnabled, true);
  assert.deepEqual(plcSync.dependencies, ['plcgen']);
  assert.deepEqual(plcSync.requiredCapabilities, ['sync.design-package', 'machine.io-map']);
  assert.match(plcSync.description, /BOM\/PDF\/GLB\/DXF 普通设计包仍可同步/);
  assert.equal(costEstimation.kind, 'optional');
  assert.equal(costEstimation.version, '1.0.0');
  assert.equal(costEstimation.defaultEnabled, true);
  assert.deepEqual(costEstimation.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(costEstimation.dependencies, ['core']);
  assert.deepEqual(costEstimation.requiredCapabilities, [
    'cost.estimation.calculate', 'cost.estimation.panel', 'cost.estimation.agent',
    'cost.estimation.report.export', 'cost.estimation.pricebook.read'
  ]);
  assert.match(costEstimation.description, /已有成本数据/);
  assert.match(costEstimation.description, /普通 BOM 读取/);
  assert.equal(update.implemented, true);
  assert.equal(update.version, '1.0.0');
  assert.equal(update.defaultEnabled, true);
  assert.deepEqual(update.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(update.dependencies, ['core']);
  assert.deepEqual(update.requiredCapabilities, [
    'system.update.check', 'system.update.download', 'system.update.install',
    'system.update.channel', 'system.update.state-events'
  ]);
  assert.match(update.description, /关闭会隐藏面板/);
  assert.match(update.description, /主进程拒绝相关 IPC/);
  assert.match(update.description, /SHA-512 校验/);
});

test('默认启用已实现模块以保持旧体验，系统更新模块依赖 core 且可用', () => {
  const states = resolveModuleStates();
  assert.equal(find(states, 'core').enabled, true);
  assert.equal(find(states, 'plcgen').enabled, true);
  assert.equal(find(states, 'elec.validation').enabled, true);
  assert.equal(find(states, 'cost.estimation').enabled, true);
  assert.equal(find(states, 'cost.estimation').status, 'enabled');
  assert.equal(find(states, 'elec.validation').status, 'enabled');
  assert.deepEqual(find(states, 'elec.validation').dependencies, ['core']);
  assert.equal(find(states, 'commission.io-test').enabled, true);
  assert.equal(find(states, 'cad.parametric-import').enabled, true);
  assert.equal(find(states, 'parametric.history').enabled, true);
  assert.equal(find(states, 'factory.plc-sync').enabled, true);
  assert.equal(find(states, 'system.update').enabled, true);
  assert.equal(find(states, 'system.update').status, 'enabled');
  assert.equal(find(states, 'system.update').reason, null);
  assert.deepEqual(find(states, 'system.update').dependencies, ['core']);
});

test('plcgen 关闭时 factory.plc-sync 自动不可用且不能启用', () => {
  const states = resolveModuleStates({ overrides: { plcgen: false, 'factory.plc-sync': true } });
  assert.equal(find(states, 'plcgen').status, 'disabled');
  assert.equal(find(states, 'factory.plc-sync').status, 'unavailable');
  assert.equal(find(states, 'factory.plc-sync').enabled, false);
  assert.match(find(states, 'factory.plc-sync').reason, /依赖模块「PLC 程序校验与生成面板」(?:未启用|不可用)/);
  const manager = createModuleManager(memoryStorage());
  manager.setEnabled('plcgen', false);
  assert.equal(find(manager.list(), 'factory.plc-sync').status, 'unavailable');
  assert.throws(() => manager.setEnabled('factory.plc-sync', true), /依赖模块/);
});

test('缺少通用同步或 machine IO map 能力时 factory.plc-sync 不可用', () => {
  const capabilities = [
    'workspace.project-storage', 'workspace.extension-host',
    'plcgen.precheck', 'plcgen.generate', 'plcgen.simulate', 'plcgen.export',
    'commission.io-test.execute', 'sync.design-package'
  ];
  const state = resolveModuleStates({ capabilities }).find((module) => module.id === 'factory.plc-sync');
  assert.equal(state.status, 'unavailable');
  assert.match(state.reason, /缺少所需能力：machine\.io-map/);
});

test('缺少电气规则校验能力时 elec.validation 不可用', () => {
  const state = find(resolveModuleStates({ capabilities: ['workspace.project-storage', 'workspace.extension-host'] }), 'elec.validation');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.enabled, false);
  assert.match(state.reason, /elec\.validation\.rules/);
});

test('未知 API、缺失能力、缺失或未启用依赖均失败关闭', () => {
  const apiModule = {
    id: 'api-next', name: 'API next', version: '1.0.0', apiCompatibility: { min: 2, max: 3 },
    dependencies: ['core'], requiredCapabilities: [], description: 'test', kind: 'optional', defaultEnabled: true, implemented: true
  };
  const needsCapability = {
    ...apiModule, id: 'needs-capability', apiCompatibility: { min: 1, max: 1 }, requiredCapabilities: ['hardware.new']
  };
  const hasMissingDependency = {
    ...apiModule, id: 'missing-dependency', apiCompatibility: { min: 1, max: 1 }, dependencies: ['not-registered']
  };
  const inactiveDependency = {
    ...apiModule, id: 'inactive-dependency', apiCompatibility: { min: 1, max: 1 }, dependencies: ['optional-base']
  };
  const optionalBase = {
    ...apiModule, id: 'optional-base', apiCompatibility: { min: 1, max: 1 }, dependencies: [], defaultEnabled: false
  };
  const states = resolveModuleStates({
    registry: [MODULE_REGISTRY[0], apiModule, needsCapability, hasMissingDependency, optionalBase, inactiveDependency],
    apiVersion: MODULE_API_VERSION,
    capabilities: ['workspace.project-storage', 'workspace.extension-host']
  });
  assert.equal(find(states, 'api-next').status, 'unavailable');
  assert.match(find(states, 'api-next').reason, /API 不兼容/);
  assert.equal(find(states, 'needs-capability').enabled, false);
  assert.match(find(states, 'needs-capability').reason, /缺少所需能力/);
  assert.equal(find(states, 'missing-dependency').enabled, false);
  assert.match(find(states, 'missing-dependency').reason, /依赖模块/);
  assert.equal(find(states, 'inactive-dependency').enabled, false);
  assert.match(find(states, 'inactive-dependency').reason, /依赖模块/);
});

test('未知模块状态不可用且无法通过状态接口启用', () => {
  const manager = createModuleManager(memoryStorage());
  const unknown = manager.getStatus('not-a-module');
  assert.equal(unknown.enabled, false);
  assert.equal(unknown.status, 'unavailable');
  assert.match(unknown.reason, /未知模块 ID/);
  assert.throws(() => manager.setEnabled('not-a-module', true), /未知模块 ID/);
  assert.throws(() => manager.setEnabled('core', false), /核心模块不能关闭/);
});

test('parametric.history 依赖参数化导入；父模块关闭时无论子模块覆盖值如何都不可用', () => {
  const states = resolveModuleStates({ overrides: { 'cad.parametric-import': false, 'parametric.history': false } });
  assert.equal(find(states, 'parametric.history').status, 'unavailable');
  assert.match(find(states, 'parametric.history').reason, /依赖模块/);

  const manager = createModuleManager(memoryStorage());
  manager.setEnabled('cad.parametric-import', false);
  assert.equal(manager.getStatus('parametric.history').status, 'unavailable');
  assert.throws(() => manager.setEnabled('parametric.history', true), /依赖模块/);
  manager.setEnabled('cad.parametric-import', true);
  assert.equal(manager.getStatus('parametric.history').enabled, true);

  manager.setEnabled('parametric.history', false);
  manager.setEnabled('cad.parametric-import', false);
  assert.equal(manager.getStatus('parametric.history').status, 'unavailable');
  manager.setEnabled('cad.parametric-import', true);
  assert.equal(manager.getStatus('parametric.history').status, 'disabled');
});

test('history gate 对旧调用方保持默认开启，读取异常时失败关闭', () => {
  assert.equal(isParametricHistoryEnabled(undefined), true);
  assert.equal(isParametricHistoryEnabled(() => true), true);
  assert.equal(isParametricHistoryEnabled(() => false), false);
  assert.equal(isParametricHistoryEnabled(() => { throw new Error('state unavailable'); }), false);
});
