#!/usr/bin/env node
// 真内核 identity-export 用例的 TAP 回执校验器（R13 / P1-3）。
//
// 事故形态（R13 审查 P1-3，两条都亲跑复现过）：
//   ① `grep -q 'ℹ skipped 0' <log>` 这种断言**只看文本**：把日志行换成 `echo 'ℹ skipped 0'`
//      拿到的日志一模一样，守卫与实际执行都不再有鉴别力。
//   ② `node --test --test-name-pattern=ZZ_NOTHING_MATCHES … | tee log`：18 条（含 6 条内核）
//      全被过滤掉后，node 仍打印 `ℹ tests 1 / ℹ pass 1 / ℹ skipped 0` 并 exit 0 ——
//      「线接上了、一条都没跑」的假绿形态原样存在，`skipped 0` 断言对此完全无感。
//
// 所以本脚本只认**结构化回执**：CI 用 `--test-reporter=tap --test-reporter-destination=<独立文件>`
// 让 node 自己把测试结果写成 TAP，然后由这里解析：
//   · 结构与计数必须自洽：`1..N` 计划 == `ok/not ok` 记录数 == `# tests N`，
//     `# pass/# fail/# skipped/# todo/# cancelled` 必须与逐条记录数出来的完全一致；
//   · fail / cancelled / skip / todo 一个都不许有（`node --test` 对 skip 仍然 exit 0）；
//   · 必须有原 R12 那 6 条「内核：…」具名用例的**真实 passed 记录**（名字逐个对上，不看总数，
//     包 B 继续加用例不会红）；
//   · 文件壳子（`--test-name-pattern` 过滤到零条时 node 只吐一条「文件名」记录 + `1..1`）必拒。
// 不认识的结构一律 fail-closed（本文件只实现该用例文件实际会产生的 Node 顶层 TAP 格式），
// 需要更强的 TAP 语义请换真 TAP 解析库 —— 本仓测试不许多一个依赖。
//
// 用法：node scripts/verify-identity-export-tap.mjs <tap-file>
// 退出码：0 = 回执成立；1 = 回执不成立（逐条打印 [CODE] 理由）；2 = 用法错误 / 读不到文件。
// 输出标记（供 CI 回读）：IDENTITY_TAP_CASE / IDENTITY_TAP_SUMMARY / IDENTITY_TAP_OK / IDENTITY_TAP_FAIL。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 必须真跑通过的具名用例 —— 取自 **R12 基线**（commit a4b57e4 的
 * test/parametric/identity-export.test.mjs），这 6 条是「真起 build123d」的那一组，
 * 名字是稳定契约，不许为了过后面的用例增删而改动。
 * 这里只钉名字，不钉总条数：包 B 在本轮又加了 3 条内核用例，总数会继续变。
 */
export const REQUIRED_KERNEL_CASES = [
  '内核：默认路径不产生 identity 文件，制造 STEP 不含任何件号',
  '内核：identityStep=true 产出同目录 identity.step，件号/实体数与逐件一致',
  '内核：前置条件违规回 400（不是 ok:true，也不是 500）',
  '内核：identityStep=false / 1 / "true" 都不产出 identity（失败方向是无文件）',
  '内核：件号只打在复制体上，原始逐件形状与制造 STEP 无标签污染',
  '内核：identity 导出失败必须 400，不许 ok:true 缺 identity'
];

const HEADER = 'TAP version 13';
const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const SUMMARY_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\S.*)$/;
const PLAN_RE = /^1\.\.(\d+)$/;
const RECORD_RE = /^(not ok|ok) (\d+)(?: - (.*))?$/;
const DIRECTIVE_RE = /^(.*?)\s+#\s+(SKIP|TODO|CANCELLED)\b\s*(.*)$/;
/** 记录名像文件名：过滤到零条时 node 只吐「文件名」这一条，那是壳子不是执行证据。 */
const FILE_LIKE_RE = /(?:^|[\\/])[^\\/]+\.(?:mjs|cjs|js|ts)$/;

/**
 * 解析 TAP 文本。
 * 只认识本用例文件真实产生的形状：header、`# …` 注释（含 `# Subtest:` 与用例 stdout）、
 * `ok/not ok N - name`、零缩进的 `1..N` 计划、`# <key> <value>` 汇总、以及记录后面
 * 两空格缩进的 `---` / `...` 诊断块。其余任何一行都记 problem（fail-closed）。
 */
export function parseTap(text) {
  const problems = [];
  const push = (code, message) => problems.push({ code, message });
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  // 去掉尾部空行（node 输出以换行结尾），中间的空行算未知结构
  let end = raw.length;
  while (end > 0 && raw[end - 1].trim() === '') end -= 1;
  const lines = raw.slice(0, end);

  if (lines.length === 0) {
    push('TAP_EMPTY', 'TAP 文件是空的：node --test 一条结果都没写出来（不是「全过」，是没有回执）');
    return { problems, records: [], plans: [], summary: {}, header: null, noise: 0 };
  }
  if (lines[0] !== HEADER) {
    push(
      'TAP_HEADER',
      `第 1 行不是「${HEADER}」，而是「${lines[0].slice(0, 120)}」 —— 这不是 node 的 TAP 回执`
      + '（`echo`/`grep` 出来的摘要、spec reporter 的 `ℹ …` 日志都不算结果）'
    );
  }

  const records = [];
  const plans = [];
  const summary = {};
  let noise = 0;
  let inBlock = false;
  let blockOpenLine = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.trim() === '') {
      push('TAP_UNEXPECTED_LINE', `第 ${lineNo} 行是空行 —— 回执里出现空行说明结构不是 node 写的，fail-closed`);
      continue;
    }
    if (/^ {2,}\S/.test(line)) {
      // 诊断块内部（含失败时的 stack 续行）
      if (line === '  ---') {
        if (inBlock) push('TAP_BLOCK_UNBALANCED', `第 ${lineNo} 行又开了诊断块，上一个（第 ${blockOpenLine} 行）还没结束`);
        inBlock = true;
        blockOpenLine = lineNo;
        continue;
      }
      if (line === '  ...') {
        if (!inBlock) push('TAP_BLOCK_UNBALANCED', `第 ${lineNo} 行闭了诊断块，但没有对应的「  ---」`);
        inBlock = false;
        continue;
      }
      if (!inBlock) {
        push('TAP_UNEXPECTED_LINE', `第 ${lineNo} 行是缩进内容但不在诊断块里：「${line.slice(0, 120)}」`);
      }
      continue;
    }

    const plan = PLAN_RE.exec(line);
    if (plan) {
      plans.push({ line: lineNo, count: Number(plan[1]) });
      continue;
    }
    const rec = RECORD_RE.exec(line);
    if (rec) {
      const desc = rec[3] ?? '';
      const dir = DIRECTIVE_RE.exec(desc);
      records.push({
        line: lineNo,
        ok: rec[1] === 'ok',
        number: Number(rec[2]),
        name: (dir ? dir[1] : desc).trim(),
        directive: dir ? dir[2] : null,
        directiveReason: dir ? dir[3].trim() : ''
      });
      continue;
    }
    const sum = SUMMARY_RE.exec(line);
    if (sum) {
      if (Object.hasOwn(summary, sum[1])) {
        push('TAP_SUMMARY_DUPLICATE', `第 ${lineNo} 行重复了汇总项「${sum[1]}」（第一次在第 ${summary[sum[1]].line} 行）`);
      } else {
        summary[sum[1]] = { line: lineNo, raw: sum[2].trim() };
      }
      continue;
    }
    if (line.startsWith('#')) {
      // `# Subtest: …` 与用例 stdout（node 逐行加 `# ` 前缀）—— 保留计数，但不作为证据
      noise += 1;
      continue;
    }
    push('TAP_UNEXPECTED_LINE', `第 ${lineNo} 行看不懂（fail-closed）：「${line.slice(0, 120)}」`);
  }

  if (inBlock) push('TAP_BLOCK_UNBALANCED', `第 ${blockOpenLine} 行开的诊断块到文件结尾都没「  ...」`);
  return { problems, records, plans, summary, header: lines[0] ?? null, noise };
}

/** 把 `# <key> <value>` 转成数字；不是非负整数就记一条 problem。 */
function toCount(summary, key, push) {
  const item = summary[key];
  if (!item) {
    push('TAP_SUMMARY_MISSING', `缺汇总项「# ${key} N」 —— 没有它就无法与逐条记录对账`);
    return null;
  }
  if (!/^\d+$/.test(item.raw)) {
    push('TAP_SUMMARY_INCONSISTENT', `第 ${item.line} 行「# ${key}」的值不是非负整数：「${item.raw}」`);
    return null;
  }
  return Number(item.raw);
}

/**
 * 校验 TAP 回执，返回 `{ ok, problems, report }`。
 * `report` 里有解析出来的计数与「6 条具名用例各自的通过记录」，给 CLI 打印用。
 */
export function verifyTap(text) {
  const parsed = parseTap(text);
  const problems = [...parsed.problems];
  const push = (code, message) => problems.push({ code, message });
  const { records, plans, summary } = parsed;

  // ① 逐条记录：编号连续、名字不重复、不许 fail
  records.forEach((r, idx) => {
    if (r.number !== idx + 1) {
      push('TAP_RECORD_NUMBERING', `第 ${r.line} 行记录编号是 ${r.number}，按顺序应为 ${idx + 1}（计划与记录对不上）`);
    }
    if (r.name === '') push('TAP_RECORD_NAME', `第 ${r.line} 行的记录没有用例名 —— 无法据此认定是哪条用例跑了`);
    if (!r.ok) {
      push('TAP_NOT_OK', `第 ${r.line} 行「not ok ${r.number} - ${r.name}」：有失败用例${r.directive ? `（# ${r.directive}）` : ''}`);
    }
    if (r.directive === 'SKIP') {
      push('TAP_SKIPPED', `第 ${r.line} 行「${r.name}」被跳过（# SKIP ${r.directiveReason}）—— 跳过不是通过，内核没跑不能算验过`);
    }
    if (r.directive === 'TODO') {
      push('TAP_TODO', `第 ${r.line} 行「${r.name}」标了 # TODO —— TODO 不是通过记录`);
    }
    if (r.directive === 'CANCELLED') {
      push('TAP_CANCELLED', `第 ${r.line} 行「${r.name}」标了 # CANCELLED —— 被取消的用例不算跑过`);
    }
  });
  const seen = new Map();
  for (const r of records) {
    if (seen.has(r.name)) {
      push('TAP_DUPLICATE_CASE', `用例名「${r.name}」出现两次（第 ${seen.get(r.name)} 行与第 ${r.line} 行）—— 重名会让「必须有这一条」的判据失真`);
    } else {
      seen.set(r.name, r.line);
    }
  }

  // ② 计划：本格式下正好一条顶层计划，且必须等于记录数。
  //    过滤到零条时 node 会吐 `1..0` + 一条文件名记录 + `1..1`（两条计划）—— 这里必拒。
  if (plans.length === 0) {
    push('TAP_PLAN', '没有任何 `1..N` 计划行 —— node 的 TAP 回执必定有，缺了就不是完整回执');
  } else if (plans.length > 1) {
    push(
      'TAP_PLAN',
      `有 ${plans.length} 条计划行（第 ${plans.map((p) => `${p.line}:1..${p.count}`).join('、')}）—— `
      + '本格式只允许一条顶层计划；多条说明嵌套/壳子结构，无法与记录对账'
    );
  } else if (plans[0].count !== records.length) {
    push('TAP_PLAN', `计划是 1..${plans[0].count}（第 ${plans[0].line} 行），实际只有 ${records.length} 条记录`);
  }

  // ③ 汇总必须自洽：`# tests/pass/fail/skipped/todo/cancelled` 全部要与记录数出来的相同
  const counts = {
    total: records.length,
    pass: records.filter((r) => r.ok && !r.directive).length,
    fail: records.filter((r) => !r.ok && !r.directive).length,
    skipped: records.filter((r) => r.directive === 'SKIP').length,
    todo: records.filter((r) => r.directive === 'TODO').length,
    cancelled: records.filter((r) => r.directive === 'CANCELLED').length
  };
  const claimed = {};
  for (const key of SUMMARY_KEYS) claimed[key] = toCount(summary, key, push);
  const durationItem = summary.duration_ms;
  if (!durationItem) push('TAP_SUMMARY_MISSING', '缺汇总项「# duration_ms」 —— node 的 TAP 回执一定带它');
  else if (!/^\d+(?:\.\d+)?$/.test(durationItem.raw)) {
    push('TAP_SUMMARY_INCONSISTENT', `第 ${durationItem.line} 行 duration_ms 不是数字：「${durationItem.raw}」`);
  }
  const expect = { tests: counts.total, pass: counts.pass, fail: counts.fail, skipped: counts.skipped, todo: counts.todo, cancelled: counts.cancelled };
  for (const [key, want] of Object.entries(expect)) {
    const got = claimed[key];
    if (got === null || got === undefined) continue;
    if (got !== want) {
      push(
        'TAP_SUMMARY_INCONSISTENT',
        `汇总「# ${key} ${got}」与逐条记录数出来的 ${want} 不一致 —— 摘要不是这次执行的真实结果`
      );
    }
  }
  if (claimed.fail !== null && claimed.fail !== undefined) {
    if (claimed.fail > 0) push('TAP_NOT_OK', `汇总「# fail ${claimed.fail}」：有失败用例`);
  }
  for (const key of ['skipped', 'todo', 'cancelled']) {
    const got = claimed[key];
    if (got) push(`TAP_${key.toUpperCase()}`, `汇总「# ${key} ${got}」：本门禁要求 ${key} = 0`);
  }

  // ④ 文件壳子：零条执行时 node 只留一条「文件名」记录（tests=1），那不是执行证据
  if (records.length <= 1) {
    push(
      'TAP_SHELL_ONLY',
      `回执里只有 ${records.length} 条记录${records.length === 1 ? `（「${records[0].name}」）` : ''} —— `
      + '这是 tests=1 的文件壳子（`--test-name-pattern` 过滤到零条时就是这样），不是「全部通过」'
    );
  } else if (records.every((r) => FILE_LIKE_RE.test(r.name))) {
    push('TAP_SHELL_ONLY', '回执里每条记录都是文件名 —— 只有文件级结果，没有一条真用例结果');
  }

  // ⑤ 具名契约：原 R12 的 6 条内核用例必须各有一条**真实通过**记录
  const required = [];
  for (const name of REQUIRED_KERNEL_CASES) {
    const hits = records.filter((r) => r.name === name);
    if (hits.length === 0) {
      push('TAP_REQUIRED_MISSING', `回执里没有「${name}」—— 这条内核用例这次没跑（过滤/跳过/改名都算没跑）`);
      required.push({ name, ok: false, detail: 'missing' });
      continue;
    }
    const good = hits.find((r) => r.ok && !r.directive);
    if (!good) {
      const bad = hits[0];
      push(
        'TAP_REQUIRED_NOT_PASSED',
        `「${name}」没有通过记录：第 ${bad.line} 行是「${bad.ok ? 'ok' : 'not ok'}${bad.directive ? ` # ${bad.directive}` : ''}」`
      );
      required.push({ name, ok: false, detail: 'not-passed' });
      continue;
    }
    required.push({ name, ok: true, number: good.number, line: good.line });
  }

  return {
    ok: problems.length === 0,
    problems,
    report: { counts, claimed, plans, records: records.length, required, noise: parsed.noise }
  };
}

const LABEL = '[verify-identity-export-tap]';

/** CLI 主体：打印可回读的标记，返回退出码。 */
export function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file || argv.length > 1) {
    process.stderr.write(`${LABEL} 用法：node scripts/verify-identity-export-tap.mjs <tap-file>\n`);
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`${LABEL} 读不到 TAP 文件「${file}」：${err.message}\n`);
    return 2;
  }

  const { ok, problems, report } = verifyTap(text);
  process.stdout.write(`${LABEL} 文件 ${file}\n`);
  if (!ok) {
    process.stdout.write(`${LABEL} 记录 ${report.records} 条，问题 ${problems.length} 条：\n`);
    for (const p of problems) process.stdout.write(`  - [${p.code}] ${p.message}\n`);
    process.stdout.write(`IDENTITY_TAP_FAIL file=${file} problems=${problems.length}\n`);
    return 1;
  }

  const c = report.counts;
  process.stdout.write(`${LABEL} 结构：${HEADER} / 计划 1..${c.total} / 记录 ${c.total} 条\n`);
  process.stdout.write(
    `${LABEL} 汇总：tests=${c.total} pass=${c.pass} fail=${c.fail} skipped=${c.skipped} todo=${c.todo} cancelled=${c.cancelled}`
    + '（与逐条记录一致）\n'
  );
  for (const r of report.required) {
    process.stdout.write(`IDENTITY_TAP_CASE ok #${r.number} ${r.name}\n`);
  }
  process.stdout.write(
    `IDENTITY_TAP_SUMMARY tests=${c.total} pass=${c.pass} fail=${c.fail} skipped=${c.skipped} todo=${c.todo} `
    + `cancelled=${c.cancelled} required=${report.required.length}\n`
  );
  process.stdout.write(`IDENTITY_TAP_OK file=${file}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
