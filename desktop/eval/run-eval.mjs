#!/usr/bin/env node
/**
 * 离线规则路由回归：只跑 routeIntent / planTool / planToolSequence，不联网、不调模型。
 *
 * 用法：在 desktop/ 下执行 `npm run eval:agent`
 * 结果：stdout 表格 + docs/desktop/eval/latest.json（时间戳、版本、逐条明细）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTool, planToolSequence, routeIntent } from '../src/agent/router.ts';
import { AgentTools } from '../src/agent/tools.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..');
const CASES_PATH = resolve(REPO_ROOT, 'docs/desktop/eval/cases.json');
/**
 * 旧路径兼容副本（`desktop/eval/agent-cases.json`）：文档承诺「内容与 docs 版本一致」，
 * 但此前没有任何地方校验，实际已经漂了 3 条（ml05/ml06/au01）。这里做硬校验：
 * 副本存在就必须与权威集逐条相同，漂了直接失败——副本不能变成第二份真理。
 */
const LEGACY_CASES_PATH = resolve(DESKTOP_ROOT, 'eval/agent-cases.json');
const OUTPUT_PATH = resolve(REPO_ROOT, 'docs/desktop/eval/latest.json');

const REJECTION_TAGS = [
  'reject_missing_argument',
  'reject_forbidden_file',
  'reject_audit_tamper',
  'reject_dangerous_path',
  'reject_unknown_ref',
  'reject_cross_domain'
];

const INTENTS = new Set(['query', 'compute', 'modify', 'generate', 'commission', 'sync', 'out_of_scope']);
const TOOL_NAMES = new Set(new AgentTools({ listParts: () => [] }).list().map((tool) => tool.name));

const THRESHOLDS = {
  intent: 0.9,
  tools: 0.85,
  params: 0.9,
  refused: 1,
  multiStep: 0.8
};

function displayWidth(value) {
  let width = 0;
  for (const char of value) {
    width += /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

function pad(value, width) {
  const source = String(value);
  const sourceWidth = displayWidth(source);
  if (sourceWidth <= width) return `${source}${' '.repeat(width - sourceWidth)}`;
  let text = '';
  let used = 0;
  for (const char of source) {
    const charWidth = displayWidth(char);
    if (used + charWidth > Math.max(0, width - 2)) break;
    text += char;
    used += charWidth;
  }
  text += '..';
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function formatRate(value) {
  return value.toFixed(2);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function argsContain(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected ?? {}).every(
    ([key, value]) => Object.hasOwn(actual, key) && JSON.stringify(actual[key]) === JSON.stringify(value)
  );
}

function expectedSteps(testCase) {
  if (Array.isArray(testCase.expect.steps) && testCase.expect.steps.length > 0) {
    return testCase.expect.steps;
  }
  return [{
    tool: testCase.expect.tool,
    argsContains: testCase.expect.argsContains ?? {},
    ...(Array.isArray(testCase.expect.missing) ? { missing: testCase.expect.missing } : {})
  }];
}

function actualPlans(testCase) {
  const steps = expectedSteps(testCase);
  if (steps.length > 1) return planToolSequence(testCase.input) ?? [];
  const plan = planTool(testCase.input);
  return plan ? [plan] : [];
}

function validateCases(cases) {
  const errors = [];
  if (!Array.isArray(cases)) return ['评估集必须是 JSON 数组'];
  if (cases.length < 40) errors.push(`评估集至少 40 条，实际 ${cases.length} 条`);

  const ids = new Set();
  const intents = new Set();
  let references = 0;
  let ambiguous = 0;
  let multiStep = 0;
  let outOfScope = 0;
  const coveredTools = new Set();
  const rejectionTags = new Set();

  for (const [index, testCase] of cases.entries()) {
    const label = testCase?.id ?? `#${index + 1}`;
    if (!testCase || typeof testCase !== 'object') {
      errors.push(`${label}: 不是对象`);
      continue;
    }
    if (typeof testCase.id !== 'string' || !testCase.id.trim()) errors.push(`${label}: 缺少 id`);
    if (ids.has(testCase.id)) errors.push(`${label}: id 重复`);
    ids.add(testCase.id);
    if (typeof testCase.input !== 'string' || !testCase.input.trim()) errors.push(`${label}: 缺少 input`);
    if (!INTENTS.has(testCase.intent)) errors.push(`${label}: 非法 intent ${testCase.intent}`);
    intents.add(testCase.intent);
    if (!testCase.expect || typeof testCase.expect !== 'object') {
      errors.push(`${label}: 缺少 expect`);
      continue;
    }
    if (!Object.hasOwn(testCase.expect, 'tool')) errors.push(`${label}: expect 缺少 tool`);
    if (testCase.expect.tool !== null && !TOOL_NAMES.has(testCase.expect.tool)) {
      errors.push(`${label}: 工具名不存在 ${testCase.expect.tool}`);
    }
    if (!testCase.expect.argsContains || typeof testCase.expect.argsContains !== 'object') {
      errors.push(`${label}: expect.argsContains 必须是对象`);
    }
    if (testCase.expect.tool !== null) coveredTools.add(testCase.expect.tool);
    if (testCase.expect.missing !== undefined && !Array.isArray(testCase.expect.missing)) {
      errors.push(`${label}: expect.missing 必须是数组`);
    }
    for (const step of testCase.expect.steps ?? []) {
      if (!TOOL_NAMES.has(step.tool)) errors.push(`${label}: steps 工具名不存在 ${step.tool}`);
      if (!step.argsContains || typeof step.argsContains !== 'object') {
        errors.push(`${label}: steps.argsContains 必须是对象`);
      }
      coveredTools.add(step.tool);
    }
    const tags = Array.isArray(testCase.tags) ? testCase.tags : [];
    if (tags.includes('reference')) references += 1;
    if (tags.includes('ambiguous')) ambiguous += 1;
    if (tags.includes('multi_step')) multiStep += 1;
    if (testCase.intent === 'out_of_scope') outOfScope += 1;
    for (const tag of REJECTION_TAGS) if (tags.includes(tag)) rejectionTags.add(tag);
  }

  if (references < 10) errors.push(`指代用例至少 10 条，实际 ${references} 条`);
  if (ambiguous < 5) errors.push(`歧义用例至少 5 条，实际 ${ambiguous} 条`);
  if (multiStep < 5) errors.push(`多步用例至少 5 条，实际 ${multiStep} 条`);
  if (outOfScope < 5) errors.push(`超纲用例至少 5 条，实际 ${outOfScope} 条`);
  if (intents.size !== INTENTS.size) {
    errors.push(`应覆盖 7 类意图，实际 ${[...intents].join(', ')}`);
  }
  for (const tool of TOOL_NAMES) {
    if (!coveredTools.has(tool)) errors.push(`评估集未覆盖工具：${tool}`);
  }
  for (const tag of REJECTION_TAGS) {
    if (!rejectionTags.has(tag)) errors.push(`评估集未覆盖拒绝场景：${tag}`);
  }
  return errors;
}

/**
 * 兼容副本必须与权威集逐条一致：只比 id 集合 + 每条 input/intent/expect，不比 note 排版。
 * 副本不存在时跳过（允许别人删掉旧路径），存在就必须同步。
 */
async function validateLegacyCopy(cases) {
  let raw;
  try {
    raw = await readFile(LEGACY_CASES_PATH, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    return [`读取失败：${error instanceof Error ? error.message : String(error)}`];
  }
  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch (error) {
    return [`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`];
  }
  if (!Array.isArray(legacy)) return ['必须是 JSON 数组'];
  const signature = (list) => JSON.stringify(
    list.map((entry) => [entry?.id, entry?.input, entry?.intent, entry?.expect])
  );
  if (signature(legacy) === signature(cases)) return [];
  const legacyIds = new Set(legacy.map((entry) => entry?.id));
  const caseIds = new Set(cases.map((entry) => entry?.id));
  const onlyLegacy = [...legacyIds].filter((id) => !caseIds.has(id));
  const onlyCases = [...caseIds].filter((id) => !legacyIds.has(id));
  return [
    `副本 ${legacy.length} 条 / 权威集 ${cases.length} 条，内容不一致；` +
      `只在副本：${onlyLegacy.join(',') || '无'}；只在权威集：${onlyCases.join(',') || '无'}；` +
      '请把 docs/desktop/eval/cases.json 整份复制过来，不要手改副本'
  ];
}

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(resolve(DESKTOP_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function evaluate(cases) {
  const details = [];
  let intentCorrect = 0;
  let toolCorrect = 0;
  let paramCorrect = 0;
  let paramApplicable = 0;
  let refused = 0;
  let outOfScopeCount = 0;
  let multiCorrect = 0;
  let multiCount = 0;

  for (const testCase of cases) {
    const expected = expectedSteps(testCase);
    const expectedIntent = testCase.intent;
    const actualIntent = routeIntent(testCase.input).intent;
    const plans = actualPlans(testCase);
    const actualTools = plans.map((plan) => plan.tool);
    const expectedTools = expected.map((step) => step.tool).filter((tool) => tool !== null);
    const isMulti = expected.length > 1;
    const expectsNoTool = expectedTools.length === 0;

    const intentOk = actualIntent === expectedIntent;
    let toolsOk;
    if (expectsNoTool) {
      toolsOk = plans.length === 0;
    } else {
      toolsOk =
        plans.length === expected.length &&
        expectedTools.every((tool, index) => actualTools[index] === tool) &&
        expected.every((step, index) => {
          if (!Array.isArray(step.missing) || step.missing.length === 0) return true;
          const actualMissing = Array.isArray(plans[index]?.missing) ? plans[index].missing : [];
          return step.missing.every((key) => actualMissing.includes(key));
        });
    }

    const hasExpectedArgs = expected.some((step) => Object.keys(step.argsContains ?? {}).length > 0);
    let paramsOk = null;
    if (hasExpectedArgs) {
      paramApplicable += 1;
      paramsOk =
        plans.length === expected.length &&
        expected.every((step, index) => argsContain(plans[index]?.args, step.argsContains));
      if (paramsOk) paramCorrect += 1;
    }

    const isOutOfScope = testCase.intent === 'out_of_scope';
    const refusedOk = !isOutOfScope || (actualIntent === 'out_of_scope' && plans.length === 0);
    if (isOutOfScope) {
      outOfScopeCount += 1;
      if (refusedOk) refused += 1;
    }

    if (isMulti) {
      multiCount += 1;
      if (intentOk && toolsOk && paramsOk !== false) multiCorrect += 1;
    }

    if (intentOk) intentCorrect += 1;
    if (toolsOk) toolCorrect += 1;

    const passed = intentOk && toolsOk && paramsOk !== false && refusedOk;
    details.push({
      id: testCase.id,
      input: testCase.input,
      tags: testCase.tags ?? [],
      note: testCase.note ?? '',
      expectedIntent,
      actualIntent,
      intentOk,
      expectedTools,
      actualTools,
      toolOk: toolsOk,
      paramsApplicable: hasExpectedArgs,
      paramsOk,
      refusedOk,
      actualPlans: plans.map((plan) => ({ tool: plan.tool, args: plan.args, readOnly: plan.readOnly, missing: plan.missing })),
      passed
    });
  }

  const metrics = {
    intent: { correct: intentCorrect, total: cases.length, rate: ratio(intentCorrect, cases.length) },
    tools: { correct: toolCorrect, total: cases.length, rate: ratio(toolCorrect, cases.length) },
    params: { correct: paramCorrect, total: paramApplicable, rate: ratio(paramCorrect, paramApplicable) },
    refused: { correct: refused, total: outOfScopeCount, rate: ratio(refused, outOfScopeCount) },
    multiStep: { correct: multiCorrect, total: multiCount, rate: ratio(multiCorrect, multiCount) }
  };

  const passed =
    metrics.intent.rate >= THRESHOLDS.intent &&
    metrics.tools.rate >= THRESHOLDS.tools &&
    metrics.params.rate >= THRESHOLDS.params &&
    metrics.refused.rate >= THRESHOLDS.refused &&
    metrics.multiStep.rate >= THRESHOLDS.multiStep;

  return { details, metrics, passed };
}

function printTable(details) {
  const widths = { id: 5, intent: 14, expected: 46, actual: 46, params: 6 };
  const header = [
    pad('ID', widths.id),
    pad('意图', widths.intent),
    pad('期望工具', widths.expected),
    pad('实际工具', widths.actual),
    pad('参数', widths.params),
    '结果'
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(displayWidth(header)));
  for (const row of details) {
    const intent = row.intentOk ? row.actualIntent : `${row.expectedIntent}>${row.actualIntent}`;
    const expected = row.expectedTools.length === 0 ? '(none)' : row.expectedTools.join(' -> ');
    const actual = row.actualTools.length === 0 ? '(none)' : row.actualTools.join(' -> ');
    const params = row.paramsOk === null ? '--' : row.paramsOk ? 'ok' : 'BAD';
    console.log([
      pad(row.id, widths.id),
      pad(intent, widths.intent),
      pad(expected, widths.expected),
      pad(actual, widths.actual),
      pad(params, widths.params),
      row.passed ? 'PASS' : 'FAIL'
    ].join('  '));
  }
}

async function main() {
  const version = await readVersion();
  const generatedAt = new Date().toISOString();
  const cases = JSON.parse(await readFile(CASES_PATH, 'utf8'));
  const validationErrors = validateCases(cases);
  if (validationErrors.length > 0) {
    throw new Error(`评估集校验失败：\n- ${validationErrors.join('\n- ')}`);
  }
  const legacyErrors = await validateLegacyCopy(cases);
  if (legacyErrors.length > 0) {
    throw new Error(`兼容副本校验失败（desktop/eval/agent-cases.json）：\n- ${legacyErrors.join('\n- ')}`);
  }

  const { details, metrics, passed } = evaluate(cases);
  const result = {
    generatedAt,
    version,
    mode: 'offline-rules',
    dataset: {
      path: 'docs/desktop/eval/cases.json',
      count: cases.length,
      references: cases.filter((entry) => entry.tags?.includes('reference')).length,
      ambiguous: cases.filter((entry) => entry.tags?.includes('ambiguous')).length,
      multiStep: cases.filter((entry) => entry.tags?.includes('multi_step')).length,
      outOfScope: cases.filter((entry) => entry.intent === 'out_of_scope').length,
      toolCoverage: [...new Set(cases.flatMap((entry) => [entry.expect?.tool, ...(entry.expect?.steps ?? []).map((step) => step.tool)]).filter(Boolean))].sort(),
      rejections: REJECTION_TAGS.filter((tag) => cases.some((entry) => entry.tags?.includes(tag)))
    },
    thresholds: THRESHOLDS,
    passed,
    metrics,
    cases: details
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`Agent 评估 · ${result.mode} · v${version} · ${generatedAt}`);
  console.log(`评估集 ${cases.length} 条：指代 ${result.dataset.references} / 歧义 ${result.dataset.ambiguous} / 多步 ${result.dataset.multiStep} / 超纲 ${result.dataset.outOfScope}`);
  console.log('');
  printTable(details);
  console.log('');
  console.log(`意图准确率   ${formatPercent(metrics.intent.rate)}  (${metrics.intent.correct}/${metrics.intent.total})  阈值 ${formatPercent(THRESHOLDS.intent)}`);
  console.log(`工具选择率   ${formatPercent(metrics.tools.rate)}  (${metrics.tools.correct}/${metrics.tools.total})  阈值 ${formatPercent(THRESHOLDS.tools)}`);
  console.log(`参数抽取率   ${formatPercent(metrics.params.rate)}  (${metrics.params.correct}/${metrics.params.total})  阈值 ${formatPercent(THRESHOLDS.params)}`);
  console.log(`超纲拒绝率   ${formatPercent(metrics.refused.rate)}  (${metrics.refused.correct}/${metrics.refused.total})  阈值 ${formatPercent(THRESHOLDS.refused)}`);
  console.log(`多步完成率   ${formatPercent(metrics.multiStep.rate)}  (${metrics.multiStep.correct}/${metrics.multiStep.total})  阈值 ${formatPercent(THRESHOLDS.multiStep)}`);
  console.log(`结果文件     docs/desktop/eval/latest.json`);

  const summary = `accuracy=${formatRate(metrics.intent.rate)} tools=${formatRate(metrics.tools.rate)} refused=${formatRate(metrics.refused.rate)}`;
  if (passed) {
    console.log(`EVAL_AGENT_OK ${summary}`);
    return;
  }

  const failed = details.filter((entry) => !entry.passed).map((entry) => `${entry.id}:${entry.input}`);
  console.error(`EVAL_AGENT_FAIL ${summary}`);
  console.error(`未通过用例：${failed.join('；')}`);
  process.exitCode = 1;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`EVAL_AGENT_FAIL ${message}`);
  try {
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(
      OUTPUT_PATH,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), version: 'unknown', mode: 'offline-rules', passed: false, error: message }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // 输出目录不可写时仍以退出码报告失败。
  }
  process.exitCode = 1;
});
