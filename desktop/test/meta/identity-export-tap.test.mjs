// TAP 回执校验器的单测（R13 / P1-3）。
//
// 这里只认**真跑出来的** TAP：每条拒绝用例都把 node --test --test-reporter=tap 真跑一遍，
// 拿 node 自己写的文件当输入 —— 手工拼的夹具只能证明解析器「按我猜的格式」工作，
// 而本轮要堵的恰恰是「格式对但执行是假的」。
//
// 夹具测试文件与 TAP 都落在 os.tmpdir() 的临时目录里（`数据只临时scratch`），
// 不进仓库、不碰 identity-export.test.mjs（那是包 B 的）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_KERNEL_CASES, main, verifyTap } from '../../scripts/verify-identity-export-tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', 'verify-identity-export-tap.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'identity-tap-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

/** 造一个「6 条内核用例 + 2 条陪衬」的假测试文件，只用来生成真 TAP。 */
function fixtureSource({ skipIndex = null, failIndex = null, dropIndex = null } = {}) {
  const lines = ["import assert from 'node:assert/strict';", "import { test } from 'node:test';"];
  REQUIRED_KERNEL_CASES.forEach((name, i) => {
    if (i === dropIndex) return;
    const body = i === failIndex ? "assert.fail('受控失败');" : 'assert.equal(1, 1);';
    const opts = i === skipIndex ? ", { skip: '受控跳过' }" : '';
    lines.push(`test(${JSON.stringify(name)}${opts}, () => { ${body} });`);
  });
  lines.push("test('陪衬用例一', () => { assert.equal(1, 1); });");
  lines.push("test('陪衬用例二', () => { assert.equal(1, 1); });");
  return `${lines.join('\n')}\n`;
}

/** 真跑 node --test，把 TAP 写到独立文件，返回 `{ exitCode, tapPath }`。 */
function runTap(name, source, extraArgs = []) {
  const testFile = join(TMP, `${name}.test.mjs`);
  const tapPath = join(TMP, `${name}.tap`);
  writeFileSync(testFile, source, 'utf8');
  // 外层本身就跑在 node --test 里：NODE_TEST_CONTEXT 会让子进程拒绝执行文件
  // （"run() is being called recursively within a test file. skipping running files."），
  // 那样拿到的根本不是真执行结果。这里显式清掉，让子进程是一次独立真跑。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_REPORTER;
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', `--test-reporter-destination=${tapPath}`, ...extraArgs, testFile],
    { cwd: TMP, encoding: 'utf8', timeout: 120_000, env }
  );
  assert.ok(res.status === 0 || res.status === 1, `node --test 异常退出：status=${res.status} stderr=${res.stderr}`);
  const tap = readFileSync(tapPath, 'utf8');
  assert.ok(tap.startsWith('TAP version 13'), `子进程没写出 TAP：stderr=${res.stderr.slice(0, 400)}`);
  return { exitCode: res.status, tapPath, stderr: res.stderr };
}

const goodFixture = fixtureSource();

// ---------------------------------------------------------------------------
// 正控：真跑出来的 TAP 必须被接受，且逐条列出 6 条具名用例
// ---------------------------------------------------------------------------

test('正控：真跑全部通过 → 接受，并逐条打印 6 条具名内核用例的通过记录', () => {
  const { tapPath } = runTap('ok', goodFixture);
  const res = spawnSync(process.execPath, [SCRIPT, tapPath], { encoding: 'utf8' });
  assert.equal(res.status, 0, `校验器把真跑全绿的回执判红了：\n${res.stdout}${res.stderr}`);

  const caseLines = res.stdout.split('\n').filter((l) => l.startsWith('IDENTITY_TAP_CASE ok '));
  assert.equal(caseLines.length, REQUIRED_KERNEL_CASES.length, `没有逐条打印具名用例：\n${res.stdout}`);
  for (const name of REQUIRED_KERNEL_CASES) {
    assert.ok(caseLines.some((l) => l.endsWith(name)), `回读标记里缺「${name}」：\n${res.stdout}`);
  }
  assert.match(res.stdout, /IDENTITY_TAP_SUMMARY tests=8 pass=8 fail=0 skipped=0 todo=0 cancelled=0 required=6/);
  assert.match(res.stdout, /IDENTITY_TAP_OK /);
});

// ---------------------------------------------------------------------------
// 假绿形态：每一条都必须被拒（都是真命令跑出来的文件）
// ---------------------------------------------------------------------------

test('零执行：--test-name-pattern 过滤到零条（node 仍 exit 0、tests=1 文件壳子）→ 必拒', () => {
  const { exitCode, tapPath } = runTap('filtered', goodFixture, ['--test-name-pattern=ZZ_NOTHING_MATCHES']);
  assert.equal(exitCode, 0, '前提变了：node 对「一条都没跑到」不再是 exit 0，本用例要重写');
  const tap = readFileSync(tapPath, 'utf8');
  assert.match(tap, /1\.\.0/, '前提变了：过滤到零条时不再吐 `1..0` 壳子');
  assert.match(tap, /# tests 1\n/, '前提变了：过滤到零条时 `# tests` 不再是 1');

  const { ok, problems } = verifyTap(tap);
  assert.equal(ok, false, '零执行的 TAP 被当成通过了 —— 这正是要堵的假绿');
  const codes = problems.map((p) => p.code);
  assert.ok(codes.includes('TAP_SHELL_ONLY'), `没报文件壳子：${codes.join(', ')}`);
  assert.ok(codes.includes('TAP_REQUIRED_MISSING'), `没报缺具名用例：${codes.join(', ')}`);

  const res = spawnSync(process.execPath, [SCRIPT, tapPath], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'CLI 对零执行回执没返回 1');
  assert.match(res.stdout, /IDENTITY_TAP_FAIL /);
});

test('skip：真跑出一条 SKIP（node 仍 exit 0）→ 必拒', () => {
  const { exitCode, tapPath } = runTap('skip', fixtureSource({ skipIndex: 1 }));
  assert.equal(exitCode, 0, '前提变了：有 skip 时 node 不再 exit 0');
  const tap = readFileSync(tapPath, 'utf8');
  assert.match(tap, /# SKIP /, '前提变了：TAP 里没有 SKIP 指令行');
  assert.match(tap, /# skipped 1\n/);

  const { ok, problems } = verifyTap(tap);
  assert.equal(ok, false, '带 skip 的回执被当成通过了');
  const codes = problems.map((p) => p.code);
  assert.ok(codes.includes('TAP_SKIPPED'), `没报 skip：${codes.join(', ')}`);
  assert.ok(codes.includes('TAP_REQUIRED_NOT_PASSED'), `没报「那条具名用例没有通过记录」：${codes.join(', ')}`);
});

test('fail：真跑出一条失败 → 必拒，且理由点名用例', () => {
  const { exitCode, tapPath } = runTap('fail', fixtureSource({ failIndex: 1 }));
  assert.equal(exitCode, 1, '前提变了：有失败时 node 不再 exit 1');
  const tap = readFileSync(tapPath, 'utf8');
  assert.match(tap, /not ok 2 - /);
  const { ok, problems } = verifyTap(tap);
  assert.equal(ok, false, '带失败的 TAP 被当成通过了');
  const msgs = problems.map((p) => p.message);
  assert.ok(problems.some((p) => p.code === 'TAP_NOT_OK'), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.includes(REQUIRED_KERNEL_CASES[1])), `失败理由没点名那条内核用例：\n${msgs.join('\n')}`);
});

test('缺具名用例：真跑里少了一条 R12 内核用例 → 必拒', () => {
  const { tapPath } = runTap('missing', fixtureSource({ dropIndex: 4 }));
  const tap = readFileSync(tapPath, 'utf8');
  assert.ok(!tap.includes(REQUIRED_KERNEL_CASES[4]), '夹具没删掉那条用例');
  const { ok, problems } = verifyTap(tap);
  assert.equal(ok, false, '少一条内核用例仍被判通过');
  assert.ok(
    problems.some((p) => p.code === 'TAP_REQUIRED_MISSING' && p.message.includes(REQUIRED_KERNEL_CASES[4])),
    problems.map((p) => `[${p.code}] ${p.message}`).join('\n')
  );
  // 其它 5 条仍然在，说明拒绝理由是「缺这一条」而不是整份回执解析失败
  const otherMissing = problems.filter((p) => p.code === 'TAP_REQUIRED_MISSING');
  assert.equal(otherMissing.length, 1, `只该缺 1 条，实际 ${otherMissing.length} 条`);
});

// ---------------------------------------------------------------------------
// 伪造回执：echo 摘要 / 手改汇总 / 未知结构
// ---------------------------------------------------------------------------

test('echo 假摘要：`echo "ℹ skipped 0"` 造出来的「日志」→ 必拒（不是 TAP，也没有用例记录）', () => {
  const fake = join(TMP, 'echo-fake.log');
  writeFileSync(fake, "ℹ tests 18\nℹ pass 18\nℹ fail 0\nℹ skipped 0\n", 'utf8');
  const { ok, problems } = verifyTap(readFileSync(fake, 'utf8'));
  assert.equal(ok, false, 'echo 出来的 spec 摘要被当成了回执');
  assert.ok(problems.some((p) => p.code === 'TAP_HEADER'), problems.map((p) => p.code).join(', '));
  const res = spawnSync(process.execPath, [SCRIPT, fake], { encoding: 'utf8' });
  assert.equal(res.status, 1);
});

test('伪造汇总：把真 TAP 的 `# pass` 改成 99（与实际记录不一致）→ 必拒', () => {
  const { tapPath } = runTap('forged', goodFixture);
  const forged = readFileSync(tapPath, 'utf8').replace('# pass 8', '# pass 99');
  assert.match(forged, /# pass 99/);
  const { ok, problems } = verifyTap(forged);
  assert.equal(ok, false, '汇总与逐条记录不一致时仍被判通过');
  assert.ok(
    problems.some((p) => p.code === 'TAP_SUMMARY_INCONSISTENT' && p.message.includes('pass')),
    problems.map((p) => `[${p.code}] ${p.message}`).join('\n')
  );
});

test('伪造汇总：删掉 `# skipped` 汇总行（想靠「没这条」混过去）→ 必拒', () => {
  const { tapPath } = runTap('forged2', goodFixture);
  const forged = readFileSync(tapPath, 'utf8').replace('# skipped 0\n', '');
  const { ok, problems } = verifyTap(forged);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.code === 'TAP_SUMMARY_MISSING'));
});

test('未知结构 fail-closed：多余的行 / 空行 / 计划对不上 / 重名 / TODO / CANCELLED', () => {
  const { tapPath } = runTap('struct', goodFixture);
  const base = readFileSync(tapPath, 'utf8');

  const cases = [
    ['多一行垃圾', base.replace('# tests 8', 'not a tap line\n# tests 8'), 'TAP_UNEXPECTED_LINE'],
    ['中间空行', base.replace('# tests 8', '\n# tests 8'), 'TAP_UNEXPECTED_LINE'],
    ['计划 1..99', base.replace(/\n1\.\.8\n/, '\n1..99\n'), 'TAP_PLAN'],
    ['删掉计划', base.replace(/\n1\.\.8\n/, '\n'), 'TAP_PLAN'],
    ['同名用例重复', base.replace('ok 7 - 陪衬用例一', 'ok 7 - 陪衬用例一\nok 7 - 陪衬用例一'), 'TAP_DUPLICATE_CASE'],
    ['TODO 指令', base.replace('ok 8 - 陪衬用例二', 'ok 8 - 陪衬用例二 # TODO 受控'), 'TAP_TODO'],
    ['CANCELLED 指令', base.replace('ok 8 - 陪衬用例二', 'ok 8 - 陪衬用例二 # CANCELLED'), 'TAP_CANCELLED'],
    ['诊断块不闭合', base.replace(/\n  \.\.\.\n/, '\n'), 'TAP_BLOCK_UNBALANCED']
  ];
  for (const [label, text, code] of cases) {
    assert.notEqual(text, base, `夹具没改动：${label}`);
    const { ok, problems } = verifyTap(text);
    assert.equal(ok, false, `${label} 没被拒`);
    assert.ok(problems.some((p) => p.code === code), `${label} 没报 ${code}：${problems.map((p) => p.code).join(', ')}`);
  }
});

test('tests=1 文件壳子：只有一条「文件名」记录 → 必拒（哪怕计数自洽）', () => {
  const shell = [
    'TAP version 13',
    '1..0',
    '# Subtest: test/parametric/identity-export.test.mjs',
    'ok 1 - test/parametric/identity-export.test.mjs',
    '  ---',
    "  type: 'test'",
    '  ...',
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 100'
  ].join('\n');
  const { ok, problems } = verifyTap(shell);
  assert.equal(ok, false, '计数自洽的文件壳子被当成通过');
  assert.ok(problems.some((p) => p.code === 'TAP_SHELL_ONLY'));
});

// ---------------------------------------------------------------------------
// CLI 契约
// ---------------------------------------------------------------------------

test('CLI：无参数 / 文件不存在 → 退出码 2（用法错误，不与「回执不成立」混）', () => {
  const noArg = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noArg.status, 2, noArg.stderr);
  const missing = spawnSync(process.execPath, [SCRIPT, join(TMP, 'nope.tap')], { encoding: 'utf8' });
  assert.equal(missing.status, 2, missing.stderr);
});

test('main() 可被直接调用（main guard：被 import 时不自动跑 CLI）', () => {
  const { tapPath } = runTap('direct', goodFixture);
  assert.equal(main([tapPath]), 0);
  assert.equal(main([join(TMP, 'nope.tap')]), 2);
});
