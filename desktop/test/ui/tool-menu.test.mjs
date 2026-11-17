import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planToolMenu } from '../../src/ui/tool-menu.ts';

const ALL = [
  'designWizardEntry',
  'assemblyEntryButton',
  'drawingEntryButton',
  'agentEntryButton',
  'elecLibEntryButton',
  'elecCheckEntryButton',
  'plcGenEntryButton',
  'factoryEntryButton',
  'commissionEntryButton',
  'packEntryButton',
  'canvasWorkbenchEntryButton',
  'enclosureEntryButton',
  'costEntryButton',
  'syncEntryButton',
  'moduleSettingsEntryButton',
  'measure',
  'display',
  'automationCadUpdateButton',
  'help'
];

test('全部入口：按五个工作流程分组，交付和设置入口各归其位', () => {
  const plan = planToolMenu(ALL);
  assert.deepEqual(plan.map((group) => group.title), ['设计装配', '电气设计', 'PLC与联调', '校核与交付', '设置与帮助']);
  assert.deepEqual(plan[0].keys, ['designWizardEntry', 'assemblyEntryButton', 'canvasWorkbenchEntryButton', 'agentEntryButton']);
  assert.deepEqual(plan[2].keys, ['plcGenEntryButton', 'commissionEntryButton', 'factoryEntryButton', 'syncEntryButton']);
  assert.deepEqual(plan[3].keys, ['elecCheckEntryButton', 'drawingEntryButton', 'costEntryButton', 'packEntryButton', 'measure']);
  assert.deepEqual(plan[4].keys, ['moduleSettingsEntryButton', 'display', 'automationCadUpdateButton', 'help']);
  assert.deepEqual(plan.flatMap((group) => group.keys).sort(), [...ALL].sort());
});

test('注册顺序打乱也不影响菜单顺序（不跟着注册顺序漂）', () => {
  const reversed = [...ALL].reverse();
  assert.deepEqual(planToolMenu(reversed), planToolMenu(ALL));
});

test('模块开关关掉的入口不注册 → 该组整组消失，不留空标题', () => {
  const only = ['elecLibEntryButton', 'enclosureEntryButton'];
  const plan = planToolMenu(only);
  assert.deepEqual(plan.map((group) => group.title), ['电气设计']);
  assert.deepEqual(plan[0].keys, only);
});

test('未登记的新入口进「其他」，不丢失', () => {
  const plan = planToolMenu(['elecCheckEntryButton', 'futureModuleEntry']);
  assert.deepEqual(plan.map((group) => group.title), ['校核与交付', '其他']);
  assert.deepEqual(plan[1].keys, ['futureModuleEntry']);
});

test('重复 key 只出现一次', () => {
  const plan = planToolMenu(['measure', 'measure', 'help']);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.flatMap((group) => group.keys), ['measure', 'help']);
});

test('空输入：没有任何分组', () => {
  assert.deepEqual(planToolMenu([]), []);
});
