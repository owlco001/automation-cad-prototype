import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectStatusLabels } from '../../src/ui/project-status.ts';

test('工程状态清楚区分未打开、导入未保存与持久工程', () => {
  const base = { name: '', stage: 'empty', geometry: 'none', saveText: '', saveError: false };
  assert.deepEqual(projectStatusLabels(base), { title: '未打开工程', stage: '开始设计', geometry: '尚无模型' });
  assert.equal(projectStatusLabels({ ...base, name: ' frame.step ', stage: 'import', geometry: 'imported-model' }).stage, '导入模型 · 未存为工程');
  const saved = projectStatusLabels({ ...base, name: '设备工程', stage: 'project', geometry: 'concept-placeholder' });
  assert.equal(saved.title, '设备工程');
  assert.match(saved.geometry, /概念占位体.*需复核/);
});
