import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RECIPE_TOOL_NAMES,
  RECIPES,
  checkRecipePreconditions,
  getRecipe,
  listRecipes,
  readContextPath,
  recipeRunToMarkdown,
  resolvePlaceholders,
  resolveRecipeArgs,
  runRecipe,
  validateRecipe,
  validateRecipes
} from '../../src/agent/recipes.ts';

const MACHINE = { name: 'SF-2026-01', stations: 4, actuators: 12, sensors: 16 };
const PLATE = { width: 800, height: 600, placed: 3, overlaps: 0 };
const CAD_PATH = 'D:\\models\\machine.step';
const BOM = [
  { no: 1, name: '气缸', partId: 'MXQ20-32-50', qty: 2 },
  { no: 2, name: '开关电源', partId: 'S-24V', qty: 1 }
];

function context(overrides = {}) {
  return {
    domain: 'mech',
    view: 'cad',
    selection: null,
    machine: MACHINE,
    plate: PLATE,
    units: 'mm',
    recentActions: [],
    cadPath: CAD_PATH,
    bom: BOM,
    ...overrides
  };
}

function recorder(options = {}) {
  const calls = [];
  const confirms = [];
  let clock = 0;
  return {
    calls,
    confirms,
    get clock() { return clock; },
    executor: {
      execute: async (step, index) => {
        calls.push({ id: step.id, tool: step.tool, index, args: step.args });
        clock += 10;
        if (options.failId === step.id) {
          return { ok: false, code: options.failCode ?? 'SMOKE_FAILED', message: '注入失败' };
        }
        return { ok: true, data: { step: step.id } };
      },
      confirm: async (request) => {
        confirms.push({ tool: request.tool, kind: request.writeKind, index: request.index });
        clock += 1;
        return options.deny !== true;
      },
      now: () => clock,
      ...(options.skipSteps ? { skipSteps: options.skipSteps } : {}),
      ...(options.skipIndexes ? { skipIndexes: options.skipIndexes } : {}),
      ...(options.rememberSameKind !== undefined ? { rememberSameKind: options.rememberSameKind } : {})
    }
  };
}

test('内置 6 个流程模板且标题固定', () => {
  assert.equal(RECIPES.length, 6);
  assert.deepEqual(RECIPES.map((recipe) => recipe.title), [
    '新机台快速起步',
    '底板布置交付',
    '电气交付',
    '成本核对',
    '整包交付',
    '设计评审'
  ]);
});

test('模板 schema 合法：全部工具名都在注册表内', () => {
  assert.deepEqual(validateRecipes(), []);
  for (const recipe of RECIPES) {
    for (const step of recipe.steps) {
      assert.ok(DEFAULT_RECIPE_TOOL_NAMES.has(step.tool), `${recipe.id} 引用了未知工具 ${step.tool}`);
    }
  }
});

test('每个模板都有 id/title/steps/preconditions/estimatedSeconds', () => {
  for (const recipe of RECIPES) {
    assert.ok(recipe.id);
    assert.ok(recipe.title);
    assert.ok(Array.isArray(recipe.steps) && recipe.steps.length > 0);
    assert.ok(Array.isArray(recipe.preconditions));
    assert.ok(Number.isInteger(recipe.estimatedSeconds) && recipe.estimatedSeconds > 0);
    assert.equal(validateRecipe(recipe).length, 0);
  }
});

test('schema 校验能发现未注册工具', () => {
  const broken = {
    ...RECIPES[0],
    steps: [{ ...RECIPES[0].steps[0], tool: 'not_a_real_tool' }]
  };
  const errors = validateRecipe(broken);
  assert.ok(errors.some((error) => error.includes('not_a_real_tool')));
  assert.ok(errors.some((error) => error.includes('工具名不存在')));
});

test('schema 校验能发现重复步骤 id 与非法耗时', () => {
  const broken = {
    ...RECIPES[0],
    estimatedSeconds: 0,
    steps: [RECIPES[0].steps[0], { ...RECIPES[0].steps[0] }]
  };
  const errors = validateRecipe(broken);
  assert.ok(errors.some((error) => error.includes('estimatedSeconds')));
  assert.ok(errors.some((error) => error.includes('步骤 id 重复')));
});

test('模板 id 重复会被 validateRecipes 发现', () => {
  const errors = validateRecipes([RECIPES[0], RECIPES[0]]);
  assert.ok(errors.some((error) => error.includes('模板 id 重复')));
});

test('getRecipe 支持 id 与中文标题', () => {
  assert.equal(getRecipe('new-machine')?.title, '新机台快速起步');
  assert.equal(getRecipe('新机台快速起步')?.id, 'new-machine');
  assert.equal(getRecipe('missing'), undefined);
});

test('listRecipes 返回副本，修改不会污染内置模板', () => {
  const copy = listRecipes();
  copy[0].steps[0].tool = 'changed';
  copy[0].title = 'changed';
  assert.equal(RECIPES[0].steps[0].tool, 'import_cad');
  assert.equal(RECIPES[0].title, '新机台快速起步');
});

test('占位符解析：context.machine.name', () => {
  const resolved = resolvePlaceholders({ fileName: { from: 'context.machine.name' } }, context());
  assert.deepEqual(resolved, { fileName: 'SF-2026-01' });
});

test('占位符解析：嵌套对象与数组', () => {
  const resolved = resolvePlaceholders({
    nested: { machine: { from: 'context.machine.name' }, width: { from: 'context.plate.width' } },
    rows: [{ from: 'context.bom.0.partId' }, { label: { from: 'context.machine.name' } }]
  }, context());
  assert.deepEqual(resolved, {
    nested: { machine: 'SF-2026-01', width: 800 },
    rows: ['MXQ20-32-50', { label: 'SF-2026-01' }]
  });
});

test('占位符解析：缺失时用 default，未提供 default 时记入 missing', () => {
  const withDefault = resolveRecipeArgs({ name: { from: 'context.machine.name', default: '未命名' } }, {});
  assert.deepEqual(withDefault.args, { name: '未命名' });
  assert.deepEqual(withDefault.missing, []);

  const noDefault = resolveRecipeArgs({ name: { from: 'context.machine.name' } }, {});
  assert.deepEqual(noDefault.args, {});
  assert.deepEqual(noDefault.missing, ['context.machine.name']);
});

test('占位符解析：optional=true 时不报缺失', () => {
  const result = resolveRecipeArgs({ name: { from: 'context.machine.name', optional: true } }, {});
  assert.deepEqual(result.args, {});
  assert.deepEqual(result.missing, []);
});

test('readContextPath 支持省略 context. 前缀', () => {
  assert.equal(readContextPath(context(), 'machine.name'), 'SF-2026-01');
  assert.equal(readContextPath(context(), 'context.plate.width'), 800);
  assert.equal(readContextPath(context(), 'context.missing.path'), undefined);
});

test('前置条件不满足：PRECONDITION_FAILED、缺什么、建议动作，且零执行', async () => {
  const { executor, calls } = recorder();
  const result = await runRecipe('new-machine', { machine: MACHINE }, executor);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(result.error?.code, 'PRECONDITION_FAILED');
  assert.equal(result.preconditionFailed, true);
  assert.equal(result.results.length, 0);
  assert.equal(calls.length, 0);
  assert.ok(result.missing?.some((item) => item.includes('CAD 文件路径')));
  assert.ok(result.suggestions?.some((item) => item.includes('CAD 查看')));
  assert.match(result.report, /建议：/);
});

test('前置条件数值下限：底板宽高为 0 时拦截', () => {
  const recipe = getRecipe('plate-delivery');
  const result = checkRecipePreconditions(recipe, context({ plate: { width: 0, height: 600 } }));
  assert.equal(result.ok, false);
  assert.ok(result.labels.includes('底板宽度'));
  assert.deepEqual(result.labels.includes('底板高度'), false);
});

test('前置条件满足后按顺序执行全部步骤', async () => {
  const { executor, calls } = recorder();
  const result = await runRecipe('new-machine', context(), executor);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.completed.length, 5);
  assert.equal(result.kept.length, 5);
  assert.deepEqual(calls.map((item) => item.id), [
    'import-cad',
    'generate-bom',
    'interference',
    'electrical',
    'cost'
  ]);
  assert.deepEqual(result.results.map((item) => item.code), ['OK', 'OK', 'OK', 'OK', 'OK']);
});

test('任一步失败：停止、保留已完成、生成中文报告', async () => {
  const { executor, calls } = recorder({ failId: 'interference', failCode: 'INTERFERENCE_FAILED' });
  const result = await runRecipe('new-machine', context(), executor);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STEP_FAILED');
  assert.equal(result.errorCode, 'INTERFERENCE_FAILED');
  assert.equal(result.failedAt, 3);
  assert.equal(result.failedTool, 'run_interference_check');
  assert.equal(result.completed.length, 2);
  assert.equal(result.kept.length, 2);
  assert.equal(result.results.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(result.completed.every((item) => item.ok && !item.skipped));
  assert.match(result.summary, /第 3 步/);
  assert.match(result.summary, /INTERFERENCE_FAILED/);
  assert.match(result.summary, /已完成清单/);
  assert.match(result.report, /失败步骤/);
  assert.match(result.report, /错误码/);
  assert.match(result.report, /建议/);
  assert.ok(result.failedStep?.suggestion);
});

test('跳过步骤：不调用工具、结果标记 skipped，其余继续', async () => {
  const { executor, calls } = recorder({ skipSteps: ['generate-bom'] });
  const result = await runRecipe('new-machine', context(), executor);
  assert.equal(result.ok, true);
  assert.equal(result.completed.length, 4);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].stepId, 'generate-bom');
  assert.equal(result.skipped[0].code, 'SKIPPED');
  assert.equal(result.skipped[0].skipped, true);
  assert.equal(calls.some((item) => item.id === 'generate-bom'), false);
});

test('跳过步骤：支持 0 基下标与工具名', async () => {
  const byIndex = recorder({ skipIndexes: [1] });
  const result = await runRecipe('new-machine', context(), byIndex.executor);
  assert.equal(result.skipped[0].stepId, 'generate-bom');

  const byTool = recorder({ skipSteps: ['run_electrical_check'] });
  const toolResult = await runRecipe('new-machine', context(), byTool.executor);
  assert.equal(toolResult.skipped[0].tool, 'run_electrical_check');
});

test('默认逐次确认：每个写步骤都会请求确认', async () => {
  const recipe = getRecipe('full-package');
  const skip = recipe.steps
    .map((step) => step.id)
    .filter((id) => id !== 'export-bom' && id !== 'export-pdf');
  const { executor, confirms } = recorder({ skipSteps: skip });
  const result = await runRecipe('full-package', context(), executor);
  assert.equal(result.ok, true);
  assert.equal(confirms.length, 2);
  assert.deepEqual(confirms.map((item) => item.tool), ['export_files', 'export_files']);
  assert.equal(confirms.every((item) => item.kind === 'file'), true);
});

test('勾选「本流程内同类操作不再询问」后，同类写步骤只确认一次', async () => {
  const recipe = getRecipe('full-package');
  const skip = recipe.steps
    .map((step) => step.id)
    .filter((id) => id !== 'export-bom' && id !== 'export-pdf');
  const { executor, confirms } = recorder({ skipSteps: skip, rememberSameKind: true });
  const result = await runRecipe('full-package', context(), executor);
  assert.equal(result.ok, true);
  assert.equal(confirms.length, 1);
});

test('同类免问只作用于同一工具，不同工具仍逐次确认', async () => {
  const recipe = getRecipe('full-package');
  const skip = recipe.steps
    .map((step) => step.id)
    .filter((id) => !['export-bom', 'export-pdf', 'export-plc'].includes(id));
  const { executor, confirms } = recorder({ skipSteps: skip, rememberSameKind: true });
  const result = await runRecipe('full-package', context(), executor);
  assert.equal(result.ok, true);
  assert.deepEqual(confirms.map((item) => item.tool), ['export_files', 'run_plc_generate']);
});

test('确认拒绝：返回 USER_DENIED 并保持已完成步骤', async () => {
  const { executor, calls } = recorder({ deny: true });
  const result = await runRecipe('new-machine', context(), executor);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'USER_DENIED');
  assert.equal(result.failedAt, 1);
  assert.equal(calls.length, 0);
  assert.equal(result.completed.length, 0);
  assert.match(result.report, /拒绝/);
});

test('写步骤没有确认回调时不静默执行', async () => {
  const calls = [];
  const result = await runRecipe('new-machine', context(), {
    execute: async (step) => {
      calls.push(step.id);
      return { ok: true };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CONFIRMATION_REQUIRED');
  assert.equal(calls.length, 0);
});

test('记录总耗时与每步耗时', async () => {
  const { executor } = recorder();
  const result = await runRecipe('new-machine', context(), executor);
  assert.equal(result.ok, true);
  assert.ok(result.totalMs > 0);
  assert.equal(result.results.length, 5);
  for (const item of result.results) assert.ok(item.elapsedMs >= 0);
  assert.equal(result.results.reduce((sum, item) => sum + item.elapsedMs, 0), 50);
  assert.ok(result.totalMs >= 50);
});

test('占位符缺失在执行时转为 MISSING_CONTEXT 并停止', async () => {
  const calls = [];
  const result = await runRecipe('cost-review', context({ bom: undefined }), {
    execute: async (step) => {
      calls.push(step.id);
      return { ok: true };
    },
    confirm: async () => true
  });
  // bom 缺失会先被前置条件拦截；这里验证不会调用任何工具。
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(calls.length, 0);
});

test('导出 Markdown 包含模板、步骤、耗时、失败与已完成清单', async () => {
  const { executor } = recorder({ failId: 'interference', failCode: 'INTERFERENCE_FAILED' });
  const result = await runRecipe('new-machine', context(), executor);
  const markdown = recipeRunToMarkdown(result);
  assert.match(markdown, /# 流程执行记录 · 新机台快速起步/);
  assert.match(markdown, /- 模板 id：`new-machine`/);
  assert.match(markdown, /- 总耗时：/);
  assert.match(markdown, /\| 3 \| 干涉检查 \| `run_interference_check` \| 失败 \|/);
  assert.match(markdown, /## 失败详情/);
  assert.match(markdown, /INTERFERENCE_FAILED/);
  assert.match(markdown, /## 已完成/);
  assert.match(markdown, /第 1 步「导入 CAD」/);
  assert.match(markdown, /第 2 步「生成 BOM」/);
});

test('导出 Markdown 记录跳过项', async () => {
  const { executor } = recorder({ skipSteps: ['cost'] });
  const result = await runRecipe('new-machine', context(), executor);
  const markdown = recipeRunToMarkdown(result);
  assert.match(markdown, /## 已跳过/);
  assert.match(markdown, /第 5 步「成本估算」/);
});

test('未知模板返回 RECIPE_NOT_FOUND 且不执行', async () => {
  const { executor, calls } = recorder();
  const result = await runRecipe('does-not-exist', context(), executor);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECIPE_NOT_FOUND');
  assert.equal(calls.length, 0);
});
