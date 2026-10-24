import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleManager, MODULE_REGISTRY, MODULE_SETTINGS_KEY } from '../../src/modules/registry.ts';

function memoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set(MODULE_SETTINGS_KEY, initial);
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
}

function status(manager) {
  const module = manager.getStatus('project.portable');
  assert.ok(module);
  return module;
}

test('project.portable 注册为默认启用的可选内置模块，含 API、能力和 core 依赖声明', () => {
  const module = MODULE_REGISTRY.find((item) => item.id === 'project.portable');
  assert.ok(module);
  assert.equal(module.name, '可移植工程档案');
  assert.equal(module.kind, 'optional');
  assert.equal(module.version, '2.0.0');
  assert.deepEqual(module.apiCompatibility, { min: 1, max: 2 });
  assert.deepEqual(module.dependencies, ['core']);
  assert.deepEqual(module.requiredCapabilities, [
    'project.identity.stable',
    'project.archive.snapshot.export',
    'project.archive.preview',
    'project.archive.candidate-only'
  ]);
  assert.equal(module.defaultEnabled, true);
  assert.equal(module.implemented, true);
  assert.match(module.description, /不应用或覆盖当前工程/);
});

test('project.portable 可独立关闭/恢复并持久化；已有档案和项目数据不变', () => {
  const storage = memoryStorage();
  const previousArchive = Buffer.from([1, 2, 3, 4]);
  const currentProject = JSON.stringify({ id: 'current-project', state: { featureTree: ['kept'] } });
  storage.values.set('automationcad.portable.archive.fixture', previousArchive.toString('base64'));
  storage.values.set('automationcad.project.current', currentProject);

  const manager = createModuleManager(storage);
  assert.equal(status(manager).enabled, true);
  manager.setEnabled('project.portable', false);
  assert.equal(status(manager).status, 'disabled');
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), {
    schemaVersion: 1,
    overrides: { 'project.portable': false }
  });
  assert.equal(storage.getItem('automationcad.portable.archive.fixture'), previousArchive.toString('base64'));
  assert.equal(storage.getItem('automationcad.project.current'), currentProject);

  const restarted = createModuleManager(storage);
  assert.equal(status(restarted).enabled, false);
  restarted.setEnabled('project.portable', true);
  assert.equal(status(restarted).enabled, true);
  assert.deepEqual(JSON.parse(storage.getItem(MODULE_SETTINGS_KEY)), { schemaVersion: 1, overrides: {} });
  assert.equal(storage.getItem('automationcad.portable.archive.fixture'), previousArchive.toString('base64'));
  assert.equal(storage.getItem('automationcad.project.current'), currentProject);
});
