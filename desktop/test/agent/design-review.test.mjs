import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateDesignReview,
  describeDesignReview,
  evidenceHasNumber,
  findHollowPhrase,
  isDesignReview,
  REVIEW_AREAS,
  summarizeDesignReview,
  verdictOf
} from '../../src/agent/design-review.ts';
import { DEFAULT_RECIPE_TOOL_NAMES, RECIPES, getRecipe, recipeRunToMarkdown, runRecipe } from '../../src/agent/recipes.ts';
import { DESIGN_REVIEW_RECIPE_ID, matchRecipeIntent } from '../../src/agent/router.ts';

// ---------------------------------------------------------------------------
// 夹具：与真实工具返回同形状（字段名取自 tools.ts / commands.ts）
// ---------------------------------------------------------------------------

const MACHINE_NAME = '光伏板转向输送机';

function contextStep(overrides = {}) {
  return {
    ok: true,
    code: 'OK',
    data: {
      ok: true,
      domain: 'mech',
      view: 'cad',
      selection: null,
      machine: { name: MACHINE_NAME, id: 'design-conveyor-1st' },
      plate: { placed: 6, width: 600, height: 400 },
      units: 'mm',
      recentActions: [],
      ...overrides
    }
  };
}

function structureStep(issues = []) {
  return {
    ok: true,
    code: 'OK',
    data: { ok: issues.length === 0, issues, summary: { errors: issues.length, warnings: 0 }, source: 'active' }
  };
}

const STATES_OK = {
  rest: { pairs: 0, hits: 0, mm3: 0 },
  lift: { pairs: 2, hits: 2, mm3: 1560 },
  sweep: { pairs: 2, hits: 2, mm3: 3120 }
};

function interferenceStep(states = { rest: { pairs: 0, hits: 0, mm3: 0 }, lift: { pairs: 0, hits: 0, mm3: 0 }, sweep: { pairs: 0, hits: 0, mm3: 0 } }) {
  return { ok: true, code: 'OK', data: { ok: true, states, partCount: 85, source: 'active-machine' } };
}

function interferenceUnavailable() {
  return {
    ok: false,
    code: 'STATE_UNAVAILABLE',
    message: '当前机型没有可顶升执行机构（turner-lift），不做 lift/sweep 检查',
    data: { ok: false, code: 'STATE_UNAVAILABLE', message: '当前机型没有可顶升执行机构（turner-lift）' }
  };
}

function electricalStep({
  error = 0,
  warning = 0,
  info = 1,
  maxPhaseCurrentA = 12.4,
  psuRequiredA = 6.2,
  psuMarginRatio = 0.38,
  breaker = { ratedA: 16, cableMm2: 2.5 }
} = {}) {
  return {
    ok: true,
    code: 'OK',
    data: {
      ok: true,
      counts: { error, warning, info },
      summary: {
        totalKw: 4.2,
        totalKva: 5.1,
        demandKw: 3.4,
        demandFactor: 0.8,
        phaseCurrentA: { L1: 12.4, L2: 11.8, L3: 12.1 },
        maxPhaseCurrentA,
        unbalanceRatio: 0.05,
        dcCurrentA: 2.1,
        psuRequiredA,
        psuMarginRatio,
        breakerSuggestion: breaker,
        findings: []
      },
      findings: [],
      truncated: false
    }
  };
}

function costStep({ missing = 0, lines = 12, grand = 12345.67, bomRows = 12, missingNames = ['气缸 MHZ2-20D'] } = {}) {
  return {
    ok: true,
    code: 'OK',
    data: {
      ok: true,
      bomSource: 'scene',
      bomRows,
      pricebook: { currency: 'CNY' },
      totals: { hardware: 10000, extras: 800, labor: 900, subtotal: 11700, markup: 400, tax: 200, freight: 45.67, grand },
      counts: { lines, missing, warnings: 0 },
      lines: [],
      missing: missingNames.slice(0, missing).map((name) => ({ name, qty: 1, reason: 'NO_PRICE' })),
      warnings: [],
      truncated: false,
      summary: '成本报告'
    }
  };
}

function allPassInput() {
  return {
    context: contextStep(),
    structure: structureStep([]),
    interference: interferenceStep(),
    electrical: electricalStep(),
    cost: costStep()
  };
}

// 施工：建议里必须出现的真实工具名（都来自 tools.ts 注册表）
const TOOL_MENTIONS = [
  'get_project_context',
  'validate_machine_design',
  'run_interference_check',
  'run_electrical_check',
  'run_cost_report',
  'export_cost_report',
  'run_plc_generate',
  'repair_plc_config',
  'apply_machine_design',
  'load_machine_from_library',
  'place_component',
  'update_component'
];

function assertSuggestionNamesTool(item) {
  const hit = TOOL_MENTIONS.filter((name) => item.suggestion.includes(name));
  assert.ok(hit.length > 0, `${item.area} 的 suggestion 没有指名工具：${item.suggestion}`);
  for (const name of hit) {
    assert.ok(DEFAULT_RECIPE_TOOL_NAMES.has(name), `${name} 不在工具注册表内`);
  }
}

// ---------------------------------------------------------------------------
// 1) 判定规则
// ---------------------------------------------------------------------------

test('四项全 pass → PASS，且条目顺序固定为 结构/干涉/电气/成本', () => {
  const review = summarizeDesignReview(allPassInput());
  assert.equal(review.verdict, 'PASS');
  assert.deepEqual(review.items.map((item) => item.area), [...REVIEW_AREAS]);
  assert.deepEqual(review.items.map((item) => item.status), ['pass', 'pass', 'pass', 'pass']);
  assert.equal(review.verdict, verdictOf(review.items));
  assert.match(review.summary, /设计评审 PASS/);
});

test('任一项 fail → FAIL（结构 issues 非空）', () => {
  const review = summarizeDesignReview({
    ...allPassInput(),
    structure: structureStep([
      { code: 'DUP_POINT', path: 'stations[0].sensors[0].point', message: '点位重复 X0', hint: '改点位' }
    ])
  });
  assert.equal(review.verdict, 'FAIL');
  const structure = review.items.find((item) => item.area === '结构');
  assert.equal(structure.status, 'fail');
  assert.match(structure.evidence, /issues 1 条/);
  assert.match(structure.evidence, /DUP_POINT/);
  assert.match(structure.suggestion, /validate_machine_design/);
  assert.match(review.summary, /阻断项 1 个/);
});

test('干涉有 hits → FAIL；成本缺价只 warn 不拦出图', () => {
  const hits = summarizeDesignReview({ ...allPassInput(), interference: interferenceStep(STATES_OK) });
  assert.equal(hits.verdict, 'FAIL');
  assert.equal(hits.items.find((item) => item.area === '干涉').status, 'fail');
  assert.match(hits.items.find((item) => item.area === '干涉').suggestion, /place_component/);

  const missing = summarizeDesignReview({ ...allPassInput(), cost: costStep({ missing: 3 }) });
  assert.equal(missing.verdict, 'WARN');
  assert.equal(missing.items.find((item) => item.area === '成本').status, 'warn');
  assert.match(missing.items.find((item) => item.area === '成本').evidence, /缺价 3 条/);
});

test('只有 warn / na 时 → WARN（电气 warning 与成本缺价都算待确认）', () => {
  const warnOnly = summarizeDesignReview({
    ...allPassInput(),
    electrical: electricalStep({ warning: 2 }),
    cost: costStep({ missing: 1 })
  });
  assert.equal(warnOnly.verdict, 'WARN');
  assert.equal(warnOnly.items.filter((item) => item.status === 'warn').length, 2);
  assert.match(warnOnly.summary, /待确认 2 个/);
});

test('干涉 STATE_UNAVAILABLE → na，且单独出现时不致 FAIL', () => {
  const review = summarizeDesignReview({ ...allPassInput(), interference: interferenceUnavailable() });
  const item = review.items.find((row) => row.area === '干涉');
  assert.equal(item.status, 'na');
  assert.equal(review.verdict, 'WARN');
  assert.match(item.evidence, /states 可用 0\/3 项/);
  assert.match(item.evidence, /STATE_UNAVAILABLE/);
  assert.match(item.suggestion, /run_interference_check/);
  assert.doesNotMatch(review.summary, /阻断项/);
});

// ---------------------------------------------------------------------------
// 2) 证据：必须是数字（快照）
// ---------------------------------------------------------------------------

test('evidence 是带数字的快照：结构 issues 条数 / 干涉三态 hits 与 mm³ / 电气三项值 / 成本缺价与总价', () => {
  const review = summarizeDesignReview({ ...allPassInput(), interference: interferenceStep(STATES_OK) });
  const byArea = Object.fromEntries(review.items.map((item) => [item.area, item.evidence]));
  assert.equal(byArea['结构'], `issues 0 条（errors 0 / warnings 0）· 首个 code 无 · 机型 ${MACHINE_NAME}`);
  assert.equal(byArea['干涉'], 'rest 0 hits / 0 mm³ · lift 2 hits / 1560 mm³ · sweep 2 hits / 3120 mm³');
  assert.equal(
    byArea['电气'],
    '错误 0 条 / 警告 0 条 / 提示 1 条；过载 最大相电流 12.4A；压降 24V 余量 38%（需 6.2A）；断路器 16A / 进线 2.5mm²'
  );
  assert.equal(byArea['成本'], '缺价 0 条 / 明细 12 行 / BOM 12 行 · 总价 ¥12345.67');
  for (const item of review.items) {
    assert.ok(evidenceHasNumber(item.evidence), `${item.area} 的证据没有数字：${item.evidence}`);
  }
});

test('证据里没有数字时降级为 warn 并写「需人工确认」（不伪造 pass）', () => {
  // 电气：没给 PSU 额定 → 24V 余量为 null；没给断路器建议 → 断路器项缺失
  const review = summarizeDesignReview({
    ...allPassInput(),
    electrical: electricalStep({ psuMarginRatio: null, psuRequiredA: null, breaker: null })
  });
  const item = review.items.find((row) => row.area === '电气');
  assert.equal(item.status, 'warn');
  assert.match(item.suggestion, /需人工确认/);
  assert.match(item.evidence, /24V 余量 未给出/);
  assert.equal(review.verdict, 'WARN');
});

// ---------------------------------------------------------------------------
// 3) 建议：必须指名动作，不许空话
// ---------------------------------------------------------------------------

test('每条 suggestion 都指名具体工具，且不含「进一步检查」这类空话', () => {
  const inputs = [
    allPassInput(),
    { ...allPassInput(), electrical: electricalStep({ error: 2 }) },
    { ...allPassInput(), interference: interferenceUnavailable() },
    { ...allPassInput(), cost: costStep({ missing: 2 }) },
    { ...allPassInput(), structure: structureStep([{ code: 'NO_STATION', path: 'stations', message: '缺工位' }]) }
  ];
  for (const input of inputs) {
    const review = summarizeDesignReview(input);
    for (const item of review.items) {
      assertSuggestionNamesTool(item);
      assert.equal(findHollowPhrase(item.suggestion), null, `空话：${item.suggestion}`);
      assert.equal(findHollowPhrase(item.evidence), null, `空话：${item.evidence}`);
    }
    assert.equal(findHollowPhrase(review.summary), null, `摘要含空话：${review.summary}`);
    assert.equal(findHollowPhrase(describeDesignReview(review)), null);
  }
});

// ---------------------------------------------------------------------------
// 4) 执行器：collect 策略 vs stop 策略
// ---------------------------------------------------------------------------

function executorWith({ failId = null, failCode = 'RENDERER_ERROR' } = {}) {
  const calls = [];
  let clock = 0;
  const payloads = {
    context: contextStep().data,
    structure: structureStep([]).data,
    interference: interferenceStep().data,
    electrical: electricalStep().data,
    cost: costStep().data
  };
  return {
    calls,
    execute: async (step) => {
      calls.push({ id: step.id, tool: step.tool, args: step.args });
      clock += 5;
      if (step.id === failId) return { ok: false, code: failCode, message: '注入失败' };
      return { ok: true, code: 'OK', data: payloads[step.id] };
    },
    now: () => clock
  };
}

test('onError:collect —— 中间步骤失败仍继续跑，后续结果存在且汇总为 FAIL', async () => {
  const exec = executorWith({ failId: 'electrical' });
  const run = await runRecipe('review-design', {}, exec);
  assert.deepEqual(exec.calls.map((call) => call.id), ['context', 'structure', 'interference', 'electrical', 'cost']);
  assert.equal(run.results.length, 5);
  assert.equal(run.ok, true, '跑完了整条流程');
  assert.equal(run.code, 'COLLECTED_WITH_ERRORS');
  const electrical = run.results.find((item) => item.stepId === 'electrical');
  assert.equal(electrical.ok, false);
  assert.equal(electrical.code, 'RENDERER_ERROR');
  assert.match(electrical.message, /注入失败/);
  assert.ok(electrical.suggestion, '失败步骤要带中文下一步');
  const cost = run.results.find((item) => item.stepId === 'cost');
  assert.equal(cost.ok, true, '后续步骤必须真的执行了');
  assert.equal(run.completed.length, 4);
  assert.deepEqual(run.stepFailures.map((item) => item.stepId), ['electrical']);
  assert.equal(run.failedStep, undefined, 'collect 不把流程判成中断');
  const review = run.aggregate;
  assert.ok(isDesignReview(review));
  assert.equal(review.verdict, 'FAIL');
  assert.equal(review.items.length, 4);
  assert.match(run.summary, /设计评审 FAIL/);
  assert.match(run.report, /## 评审结论/);
  assert.match(run.summary, /已跑完 5\/5 步/);
});

test('collect 下三态干涉 STATE_UNAVAILABLE 记为 N/A，不把整份评审判成 FAIL', async () => {
  const exec = {
    calls: [],
    execute: async (step) => {
      exec.calls.push(step.id);
      if (step.id === 'interference') return interferenceUnavailable();
      if (step.id === 'structure') return { ok: true, code: 'OK', data: structureStep([]).data };
      if (step.id === 'electrical') return { ok: true, code: 'OK', data: electricalStep().data };
      if (step.id === 'cost') return { ok: true, code: 'OK', data: costStep().data };
      return { ok: true, code: 'OK', data: contextStep().data };
    },
    now: () => 0
  };
  const run = await runRecipe('review-design', {}, exec);
  assert.deepEqual(exec.calls, ['context', 'structure', 'interference', 'electrical', 'cost']);
  assert.equal(run.aggregate.verdict, 'WARN');
  assert.equal(run.aggregate.items.find((item) => item.area === '干涉').status, 'na');
  assert.match(run.report, /评审记 N\/A/);
});

test('get_project_context 失败（critical）立即停：只跑 1 步、不产出汇总', async () => {
  const exec = executorWith({ failId: 'context' });
  const run = await runRecipe('review-design', {}, exec);
  assert.deepEqual(exec.calls.map((call) => call.id), ['context']);
  assert.equal(run.ok, false);
  assert.equal(run.code, 'STEP_FAILED');
  assert.equal(run.errorCode, 'RENDERER_ERROR');
  assert.equal(run.failedStep.stepId, 'context');
  assert.equal(run.results.length, 1);
  assert.equal(run.aggregate, undefined);
});

test('现有 5 个配方仍是失败即停（onError 未声明 / 显式 stop）', () => {
  const ids = ['new-machine', 'plate-delivery', 'electrical-delivery', 'cost-review', 'full-package'];
  assert.equal(RECIPES.length, 6);
  for (const id of ids) {
    const recipe = getRecipe(id);
    assert.ok(recipe, `缺少配方 ${id}`);
    assert.notEqual(recipe.onError, 'collect', `${id} 不能改成 collect`);
    assert.equal(recipe.aggregate, undefined, `${id} 不应挂汇总器`);
  }
  assert.equal(getRecipe('review-design').onError, 'collect');
  assert.equal(getRecipe('review-design').aggregate, 'design-review');
  assert.equal(getRecipe('review-design').steps.length, 5);
  assert.equal(getRecipe('review-design').steps[0].critical, true);
  assert.deepEqual(getRecipe('review-design').steps[2].args, { states: ['rest', 'lift', 'sweep'] });
  // 别名
  assert.equal(getRecipe('design-review').id, 'review-design');
  assert.equal(getRecipe('review').id, 'review-design');
});

test('stop 配方行为不变：电气交付中间步骤失败即停并保留已完成', async () => {
  const calls = [];
  const run = await runRecipe('electrical-delivery', { machine: { name: 'M' } }, {
    execute: async (step) => {
      calls.push(step.id);
      if (step.id === 'fix-hints') return { ok: false, code: 'RENDERER_ERROR', message: '注入失败' };
      return { ok: true, code: 'OK', data: { ok: true } };
    },
    now: () => 0
  });
  assert.deepEqual(calls, ['electrical-check', 'fix-hints']);
  assert.equal(run.ok, false);
  assert.equal(run.code, 'STEP_FAILED');
  assert.equal(run.completed.length, 1);
  assert.equal(run.aggregate, undefined);
});

// ---------------------------------------------------------------------------
// 5) 汇总入口与报告
// ---------------------------------------------------------------------------

test('aggregateDesignReview 按步骤 id 取数；缺项按「未执行」记 warn，不伪造 pass', () => {
  const review = aggregateDesignReview([
    { index: 0, step: 1, stepId: 'context', title: '取工程上下文', tool: 'get_project_context', ok: true, skipped: false, code: 'OK', elapsedMs: 1, data: contextStep().data },
    { index: 1, step: 2, stepId: 'structure', title: '结构校验', tool: 'validate_machine_design', ok: true, skipped: false, code: 'OK', elapsedMs: 1, data: structureStep([]).data }
  ]);
  assert.equal(review.items.find((item) => item.area === '结构').status, 'pass');
  assert.equal(review.items.find((item) => item.area === '干涉').status, 'warn');
  assert.match(review.items.find((item) => item.area === '干涉').evidence, /0 项数据/);
  assert.equal(review.verdict, 'WARN');
});

test('评审结论能进 Markdown 执行记录（评审结论段 + 每条证据）', async () => {
  const run = await runRecipe('review-design', {}, executorWith({ failId: 'cost' }));
  const markdown = recipeRunToMarkdown(run);
  assert.match(markdown, /## 评审结论/);
  assert.match(markdown, /\| 区域 \| 状态 \| 证据 \| 下一步 \|/);
  assert.match(markdown, /缺价|0 项数据/);
  assert.match(markdown, /设计评审 FAIL/);
});

test('router 意图：「评审这台机器 / 能不能出图 / 有没有问题」命中评审配方，机型自查仍走单工具', () => {
  for (const text of [
    '帮我评审这台机器',
    '把整机评审一遍',
    '这台机能不能出图',
    '这台机能不能交付',
    '这台机器有没有问题'
  ]) {
    assert.equal(matchRecipeIntent(text), DESIGN_REVIEW_RECIPE_ID, `${text} 应命中评审配方`);
  }
  // 边界：单域/单工具说法不抢
  for (const text of ['机型方案有没有问题', '校验机型方案', '成本评估', '列一下所有接触器', '今天天气怎么样']) {
    assert.equal(matchRecipeIntent(text), null, `${text} 不应命中评审配方`);
  }
  assert.equal(getRecipe(matchRecipeIntent('帮我评审这台机器')).id, 'review-design');
});
