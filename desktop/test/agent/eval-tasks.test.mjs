// 守住 scripts/eval-tasks.mjs 的「跳过不许静默变绿」语义。
//
// 为什么要有这条：那个脚本以前只 `if (failed > 0) exit 1`，`skipped` 不进判定——没有 build123d
// 的机器上 `TASK_EVAL_SUMMARY pass=12/13 failed=0 skipped=1` 是 exit 0，CI 一片绿，而 t12
// 「真起内核出 STEP」其实一次都没验过。这里把判定表逐行打一遍：环境门控跳过要留下清单 +
// 降级标记；**未声明的跳过（假跳过）必须红**，且回执里能看见是哪一例。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENV_SKIP_GATES,
  parseEvalArgs,
  summarizeEvalResults
} from '../../scripts/eval-tasks.mjs';

const TOTAL = 13;

/** 13 例全过的行表（t01..t13 用一个循环造，避免手抄漏一个就悄悄少一例） */
function allPassRows({ skip = null } = {}) {
  const rows = [];
  for (let index = 1; index <= TOTAL; index += 1) {
    const id = `t${String(index).padStart(2, '0')}-case`;
    if (skip && skip.index === index) {
      rows.push({ id: skip.id ?? id, status: 'skip', gate: skip.gate, reason: skip.reason ?? '测试注入', turns: 1 });
      continue;
    }
    rows.push({ id, status: 'pass', turns: 2 });
  }
  return rows;
}

function lineOf(lines, prefix) {
  return lines.find((line) => line.startsWith(prefix)) ?? null;
}

test('全过：exit 0，回执里没有跳过清单 / 降级标记', () => {
  const summary = summarizeEvalResults(allPassRows(), { total: TOTAL });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.passed, TOTAL);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.degraded, false);
  assert.equal(summary.turns, TOTAL * 2);
  assert.equal(lineOf(summary.lines, 'TASK_EVAL_SKIP_LIST'), null);
  assert.equal(lineOf(summary.lines, 'TASK_EVAL_DEGRADED'), null);
  assert.equal(lineOf(summary.lines, 'TASK_EVAL_SKIP_UNDECLARED'), null);
  assert.equal(
    lineOf(summary.lines, 'TASK_EVAL_SUMMARY'),
    `TASK_EVAL_SUMMARY pass=${TOTAL}/${TOTAL} failed=0 skipped=0 env_skipped=0 undeclared_skips=0 degraded=false turns_total=${TOTAL * 2}`
  );
  assert.match(lineOf(summary.lines, 'TASK_EVAL_VERDICT'), /^TASK_EVAL_VERDICT PASS exit=0$/);
});

test('环境门控跳过（kernel-missing）：默认 exit 0 但必须显式降级 + 列清单', () => {
  const rows = allPassRows({ skip: { index: 12, id: 't12-step-export', gate: 'kernel-missing', reason: '本机没有 build123d 内核' } });
  const summary = summarizeEvalResults(rows, { total: TOTAL });

  assert.equal(summary.exitCode, 0, '环境缺失不是代码缺陷，默认不改退出码');
  assert.equal(summary.skipped, 1);
  assert.equal(summary.envSkipped, 1);
  assert.equal(summary.passed, TOTAL - 1, '跳过不许记 pass');
  assert.deepEqual(summary.undeclaredSkips, []);
  assert.equal(summary.degraded, true);

  assert.match(lineOf(summary.lines, 'TASK_EVAL_SKIP_LIST'),
    /^TASK_EVAL_SKIP_LIST t12-step-export gate=kernel-missing reason=本机没有 build123d 内核$/);
  assert.match(lineOf(summary.lines, 'TASK_EVAL_DEGRADED'),
    /^TASK_EVAL_DEGRADED skipped=1 env_gated=1 undeclared=0 policy=fail-closed$/);
  assert.match(lineOf(summary.lines, 'TASK_EVAL_SUMMARY'),
    /skipped=1 env_skipped=1 undeclared_skips=0 degraded=true/);
  assert.match(lineOf(summary.lines, 'TASK_EVAL_VERDICT'), /PASS exit=0 degraded=true/);
});

test('--require-full：装了内核的 job 里，环境门控跳过也不许算通过', () => {
  const rows = allPassRows({ skip: { index: 12, id: 't12-step-export', gate: 'kernel-missing' } });
  const summary = summarizeEvalResults(rows, { total: TOTAL, requireFull: true });
  assert.equal(summary.exitCode, 1);
  assert.match(lineOf(summary.lines, 'TASK_EVAL_REQUIRE_FULL'), /^TASK_EVAL_REQUIRE_FULL skipped=1/);
  assert.match(lineOf(summary.lines, 'TASK_EVAL_VERDICT'), /^TASK_EVAL_VERDICT FAIL exit=1/);
  assert.match(summary.reasons.join('|'), /require-full/);

  // 没跳过的全绿在 --require-full 下仍是绿
  assert.equal(summarizeEvalResults(allPassRows(), { total: TOTAL, requireFull: true }).exitCode, 0);
});

test('假跳过注入：未声明 gate / 白名单外 gate 一律 exit 1，且回执点名', () => {
  const cases = [
    ['没写 gate', { index: 5, id: 't05-interference-states', gate: undefined }],
    ['白名单外 gate', { index: 9, id: 't09-plan-budget-resume', gate: 'skipped-for-now' }],
    ['gate 不是字符串', { index: 3, id: 't03-library-roundtrip', gate: { why: 'lazy' } }]
  ];
  for (const [label, skip] of cases) {
    const summary = summarizeEvalResults(allPassRows({ skip }), { total: TOTAL });
    assert.equal(summary.exitCode, 1, `${label} 必须红`);
    assert.deepEqual(summary.undeclaredSkips, [skip.id], `${label} 必须点名这一例`);
    assert.equal(summary.skipped, 1);
    const undeclaredLine = lineOf(summary.lines, 'TASK_EVAL_SKIP_UNDECLARED');
    assert.ok(undeclaredLine, `${label} 回执里必须有 SKIP_UNDECLARED 行`);
    assert.ok(undeclaredLine.includes(skip.id), `${label} 回执必须带上用例号：${undeclaredLine}`);
    // 清单里也要能看见（gate 现场值原样打出来，不是 none）
    const listLine = lineOf(summary.lines, 'TASK_EVAL_SKIP_LIST');
    assert.ok(listLine && listLine.includes(skip.id), `${label} SKIP_LIST 必须列出这一例`);
    assert.match(lineOf(summary.lines, 'TASK_EVAL_VERDICT'), /FAIL exit=1/);
    assert.match(summary.reasons.join('|'), /undeclared_skips=/);
  }
});

test('FAIL / 未知状态都进退出码（不许出现「不是 pass 也不是 fail」的黑洞）', () => {
  const withFail = allPassRows();
  withFail[0] = { id: withFail[0].id, status: 'fail', turns: 1 };
  const failed = summarizeEvalResults(withFail, { total: TOTAL });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.failed, 1);
  assert.match(failed.reasons.join('|'), /failed=1/);

  const weird = allPassRows();
  weird[2] = { id: 't03-library-roundtrip', status: 'maybe', turns: 1 };
  const unknown = summarizeEvalResults(weird, { total: TOTAL });
  assert.equal(unknown.exitCode, 1);
  assert.match(lineOf(unknown.lines, 'TASK_EVAL_STATUS_UNKNOWN'), /t03-library-roundtrip/);

  // 空行表 = 一例都没跑：不 header 报绿，pass=0/13
  const empty = summarizeEvalResults([], { total: TOTAL });
  assert.equal(empty.exitCode, 0);
  assert.match(lineOf(empty.lines, 'TASK_EVAL_SUMMARY'), /pass=0\/13/);
});

test('ENV_SKIP_GATES 是白名单：冻住、只放环境缺失类理由', () => {
  assert.ok(Object.isFrozen(ENV_SKIP_GATES));
  assert.deepEqual([...ENV_SKIP_GATES], ['kernel-missing']);
});

test('参数解析：--require-full / --help 认识，未知选项不静默忽略', () => {
  assert.deepEqual(parseEvalArgs([]), { ok: true, options: { requireFull: false, help: false } });
  assert.equal(parseEvalArgs(['--require-full']).options.requireFull, true);
  assert.equal(parseEvalArgs(['--help']).options.help, true);
  const bad = parseEvalArgs(['--require-kernel']);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /未知选项：--require-kernel/);
});
