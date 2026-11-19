// CI 严格档防回退守卫（P1）—— R10 review 整改版（P1-1 / P1-2 + 负向自证）。
//
// 事故背景：`verify-step-tower --require-full` 与 `eval:tasks --require-full` 两套严格档
// 早就实现在脚本里（verify-step-tower.mjs 的 `requireFull` → SKIP 时 exit 1；
// eval-tasks.mjs 的 `summarizeEvalResults({requireFull})` → 跳过即 exit 1），也都有单测，
// 但 **CI 侧一个字都没接**：ci.yml 里两条 `verify:step-tower` 与 `npm run eval:tasks`
// 全都不带严格档。于是「内核没装 / 件建不出来」在流水线上表现为 `STEP_VERIFY SKIP`
// 加绿灯 —— 门禁看着在，实际什么都没验。
//
// 这条测试只认**真正会被 shell 执行的那几行**（`run:` 块里、去掉注释后的命令），
// 不认 job 名、不认注释、不认日志文案。理由很直接：`# --require-full` 这种注释
// 曾经是最容易被当成「已接严格档」的假证据。
//
// R10 review 实测出的盲区（本版逐条补上，都有对抗用例钉住）：
//   B1 `--require-full=false`：脚本用 `args.includes` 精确匹配 token，带值形式等于没给，
//      而守卫原来用 `String.includes` 子串判定 → 绿。现在按 token 判，并单独判红带值/取反形式。
//   B2 job 级 `continue-on-error: true`（4 空格）：整 job 的门禁一起不阻塞，原来只查了
//      step 内 8 空格的写法。现在 job 级 / step 级（任意缩进）都查。
//   B3 `|| exit 0`、B4 `; true`：原来只匹配 `/||\s*true/`。现在把「吞退出码」的写法列成一档，
//      另加一条**规范形状**判据（见下）做兜底。
//   B5 `if: false` / `if: ${{ false }}`：步骤永不执行 = 严格档消失。现在字面恒假的 if 判红。
//
// 「规范形状」而不是 shell 解释器：门禁步骤里真正允许的只有
//   `cd desktop` / `. .venv-ft/bin/activate` / `set -o pipefail` / `export NAME=...`
// 这几行前导，加上 `npm run <verify:step-tower|eval:tasks> -- <参数>` 这一种命令形状
// （带 `env=值 cmd` 前缀也认）。除此之外的任何东西 —— `;`、`&&`、`||`、`$()`、反引号、
// 重定向、`2>&1 | tee`（除非同一步显式 `set -o pipefail`）—— 一律判红。
// 写一个 shell 解释器既不可靠也永远追不上，锁形状才守得住。
//
// 还有一个负向自证步骤（严格档必须「缺内核就红」）：本文件检查它确实存在、确实用受控
// 不存在的解释器、确实断言「非严格 exit 0 / 严格 exit 1」两臂。删掉它 → 红。
//
// 断言：
//   1. featuretree-geometry 里每条 `verify:step-tower` 都带**精确 token** `--require-full`，
//      且 16 层 / 8 层基线都在；
//   2. 存在一条严格档 `eval:tasks`，所在 job 先装了 build123d，且本步自己指向 `.venv-ft`；
//   3. unit（无内核）里不许出现严格档，非严格档必须仍在（防止「删掉」冒充「移动」）；
//   4. 门禁步骤（含 job 级）不许吞失败：continue-on-error / if 恒假 / `|| true` 家族，
//      且命令必须落在规范形状内；
//   5. 严格档负向自证步骤存在且形状正确（受控缺内核 → SKIP + exit 1）；
//   6. 预算注释覆盖新增步骤、步骤超时之和 ≤ 预算合计 ≤ job 超时。
//   7. 跑门禁的 job 必须先装 node 依赖（`npm ci` / `npm install`），且从 job 的有效步骤里
//      取**执行顺序**：没有安装步骤 → 红；装在评测之后 → 红。首跑事故：featuretree-geometry
//      只装了 build123d，eval:tasks 一 import src/shared/zip.ts 就 `Cannot find package 'adm-zip'`，
//      表现为「严格档红了」，实际是环境前置遗漏 —— 断言根本没跑到。
//   8. 真内核用例 `test/parametric/identity-export.test.mjs` 必须在**有内核**的 job
//      （featuretree-geometry）里作为独立步骤真跑，且**回执是结构化 TAP**：node 写独立文件
//      （`--test-reporter=tap --test-reporter-destination=/tmp/…`），再由
//      `scripts/verify-identity-export-tap.mjs` 解析同一个文件。该步还要：先自证 venv 里
//      真有 build123d、`set -euo pipefail`、不带任何用例过滤参数、不拿 echo/grep/`ℹ …`
//      文案当证据。只断言 `skipped 0` 的旧版已被两条实测假绿击穿（echo 伪造、过滤到零条）。
//   9. unit（无内核）里不许出现该文件名：把整文件挪进 unit 等于给主门禁压 PyPI 依赖
//      （C1 拒绝的理由），且 6 条在那边恒 SKIP，看起来「跑了」其实没跑。
//  10. 这条新步骤与旧门禁**同级**：step / job 级 `if` 恒假、`continue-on-error`、
//      `|| true` / `; true` 吞码一律判红（⑩ 复用 JOB_/STEP_IF_FALSE、
//      JOB_/STEP_CONTINUE_ON_ERROR、MASKED_EXIT 四个既有码）；并且它的每个命令行必须
//      整行落在契约形状内、按 preflight < TAP 生产者 < 消费者 执行 ——
//      `true # <真命令>` / `: # …` / `if false; then …; fi` 这类「文本里有、实际不执行」
//      的写法一律判红（fail-closed；不写 shell 解释器，只锁这一步的形状与顺序）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const CI_PATH = new URL('../../../.github/workflows/ci.yml', import.meta.url);
const CI_TEXT = readFileSync(CI_PATH, 'utf8');

const FT_JOB = 'featuretree-geometry';
const NO_KERNEL_JOB = 'unit';
const STEP_TOWER_CMD = /\bverify:step-tower\b/;
const STEP_TOWER_SCRIPT = /\bscripts\/verify-step-tower\.mjs\b/;
const EVAL_TASKS_CMD = /\beval:tasks\b/;
const STRICT_FLAG = '--require-full';

// ---------------------------------------------------------------------------
// 严格档旗标：必须是独立 token
//
// 脚本侧是 `args.includes('--require-full')`（verify-step-tower.mjs:1011,1025），
// 所以 `--require-full=false` / `--no-require-full` 都不生效。守卫必须用同一口径，
// 否则就是本轮修的那种「守卫绿、门禁空转」。前后必须是空白或行首尾。
// ---------------------------------------------------------------------------
const STRICT_TOKEN = /(?:^|\s)--require-full(?=\s|$|[;&|)])/;
/** 看着像给了严格档、实际脚本不认的写法（=值 / 取反）。 */
const STRICT_WEAK_FORMS = [
  { re: /(?:^|\s)--require-full=/, label: '--require-full=<值>（args.includes 只认裸 token）' },
  { re: /(?:^|\s)--no-require-full\b/, label: '--no-require-full' }
];
const hasStrictToken = (text) => STRICT_TOKEN.test(text);
const strictWeakForm = (text) => STRICT_WEAK_FORMS.find((f) => f.re.test(text));

// ---------------------------------------------------------------------------
// 极简 YAML 行走（不引 yaml 库：仓库测试不许多一个依赖）
//
// 只认本工作流实际用到的形状：`jobs:` 顶格、job 名 2 空格、步骤 `      - x` 6 空格、
// 步骤内部键 8 空格、`run: |` 块比键更深。注释行不参与结构判定，但仍记进 raw，
// 这样 `# --require-full` 可以被显式断言为「不算证据」。
// ---------------------------------------------------------------------------

const unquote = (s) => {
  const t = String(s).trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
};

/** 把文本拆成 job / step 结构，并给每步算出「真正会被执行」的命令行。 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  let step = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const isComment = raw.trim().startsWith('#');

    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      job = null;
      step = null;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(raw) && !isComment) break; // 出了 jobs: 段

    let m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(raw);
    if (m) {
      job = { name: m[1], line: i + 1, endLine: lines.length, steps: [], lines: [] };
      jobs.set(job.name, job);
      step = null;
      continue;
    }
    if (!job) continue;
    job.lines.push({ line: i + 1, text: raw });
    if (isComment) {
      if (step) step.raw.push({ line: i + 1, text: raw, comment: true });
      continue;
    }

    m = /^ {6}- (.*)$/.exec(raw);
    if (m) {
      step = { line: i + 1, endLine: lines.length, head: m[1], raw: [], name: null, timeoutMinutes: null };
      job.steps.push(step);
      const nm = /^name:\s*(.+)$/.exec(m[1]);
      if (nm) step.name = unquote(nm[1]);
      continue;
    }
    if (!step) continue;
    step.raw.push({ line: i + 1, text: raw, comment: false });
    const nm = /^ {8}name:\s*(.+)$/.exec(raw);
    if (nm && step.name === null) step.name = unquote(nm[1]);
    const to = /^ {8}timeout-minutes:\s*(\d+)\s*$/.exec(raw);
    if (to) step.timeoutMinutes = Number(to[1]);
  }

  const jobList = [...jobs.values()];
  for (let j = 0; j < jobList.length; j += 1) {
    const cur = jobList[j];
    cur.endLine = jobList[j + 1] ? jobList[j + 1].line - 1 : lines.length;
    for (let s = 0; s < cur.steps.length; s += 1) {
      cur.steps[s].endLine = cur.steps[s + 1] ? cur.steps[s + 1].line - 1 : cur.endLine;
      cur.steps[s].job = cur.name;
    }
  }

  // 抽取 run: 命令（注释行剔除 —— 注释不是命令，这是本文件存在的理由之一）
  //
  // 续行（行尾 `\`）在这里先拼回一行：这是**词法**归一，不是 shell 解释。
  // 不拼的话，一条命令被拆成两行就能绕过 token 判定和形状判定（例如
  // `... --levels 16 \` + `--require-full=false`）。
  for (const cur of jobList) {
    for (const st of cur.steps) {
      st.commands = [];
      let runIndent = null;
      let buffer = null;
      const push = (cmd) => {
        if (buffer === null) buffer = { line: cmd.line, text: cmd.text };
        else buffer.text = `${buffer.text} ${cmd.text}`;
        if (buffer.text.endsWith('\\')) {
          buffer.text = buffer.text.slice(0, -1).trimEnd();
          return; // 还没结束，等下一行
        }
        st.commands.push({ line: buffer.line, text: buffer.text });
        buffer = null;
      };
      for (const row of st.raw) {
        if (row.comment) continue;
        if (runIndent === null) {
          const block = /^( {8})run:\s*[|>][-+]?\s*$/.exec(row.text);
          if (block) {
            runIndent = 8;
            continue;
          }
          const inline = /^ {8}run:\s+(.+)$/.exec(row.text);
          if (inline) {
            const cmd = inline[1].trim();
            if (cmd && !cmd.startsWith('#')) st.commands.push({ line: row.line, text: cmd });
          }
          continue;
        }
        const indent = /^( *)\S/.exec(row.text)?.[1].length ?? 0;
        if (indent <= runIndent) {
          if (buffer !== null) {
            st.commands.push({ line: buffer.line, text: buffer.text });
            buffer = null;
          }
          runIndent = null;
          continue;
        }
        const cmd = row.text.trim();
        if (cmd && !cmd.startsWith('#')) push({ line: row.line, text: cmd });
      }
      if (buffer !== null) {
        st.commands.push({ line: buffer.line, text: buffer.text });
      }
    }
  }
  return { jobs, jobList, lines };
}

const JOB_TIMEOUT_RE = /^ {4}timeout-minutes:\s*(\d+)\s*$/m;

// ---------------------------------------------------------------------------
// 吞失败 / 恒假条件：判据都是「字面写法」，不做表达式求值
// ---------------------------------------------------------------------------

/** `|| true` 家族：失败被替换成 0。 */
const MASK_PATTERNS = [
  { re: /\|\|\s*true\b/, label: '|| true' },
  { re: /\|\|\s*:\s*(?:$|[;&#])/, label: '|| :' },
  { re: /\|\|\s*exit\s+0\b/, label: '|| exit 0' },
  { re: /\|\|\s*(?:echo|printf|cat)\b/, label: '|| echo/printf/cat（失败被替换成 0）' },
  { re: /(?:^|[;&])\s*(?:true|:)\s*(?:$|[;&#])/, label: '; true / 裸 true、: 顶掉命令' },
  { re: /(?:^|[;&])\s*exit\s+0\b/, label: '; exit 0' },
  { re: /^\s*set\s+\+e\b/, label: 'set +e' }
];
const maskOf = (text) => MASK_PATTERNS.find((p) => p.re.test(text));

/**
 * if 条件是否「字面恒假」。只认显而易见的形式（不写表达式求值器）：
 * false / 'false' / 0 / !true / ${{ false }} / false && …
 * 复杂表达式不在判据内 —— 这一点写在报告里，不装作覆盖了。
 */
function isConstantFalse(condition) {
  let c = String(condition ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(c);
  if (wrapped) c = wrapped[1].trim();
  const flat = c.replace(/\s+/g, ' ');
  if (/^(?:false|0|!true|! 1|!1|!)$/i.test(flat)) return true;
  if (/^false\s*&&/.test(flat) || /&&\s*false$/.test(flat)) return true;
  if (/^!\(\s*true\s*\)$/.test(flat)) return true;
  return false;
}

/** continue-on-error 的值：只有显式 false 才算「不遮」。 */
const isFalseish = (value) => {
  const v = String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(v);
  const flat = (wrapped ? wrapped[1] : v).trim().toLowerCase();
  return flat === 'false' || flat === '0';
};

// ---------------------------------------------------------------------------
// 规范形状：门禁步骤只允许这几种行
// ---------------------------------------------------------------------------

const SAFE_ARG = String.raw`[A-Za-z0-9_.:\/-]+`;
const ENV_ASSIGN = String.raw`[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.:\/-]+)`;
const TOOL_CMD = String.raw`npm run (?:verify:step-tower|eval:tasks)`;

// 「是不是真的在执行门禁工具」按**命令开头**判，不是按文本里出现过 eval:tasks 判：
// 摘要步骤里有一句 `echo '### eval:tasks'`，按子串判会把它当成门禁步骤，
// 于是汇总用的 grep/echo 全被形状判据扫成红（旧版对它有 `|| true` 之类才是真问题）。
const TOOL_RUN_RE = new RegExp(String.raw`^(?:export\s+)?(?:${ENV_ASSIGN}\s+)*(?:${TOOL_CMD})\b`);
const isToolCmd = (text) => TOOL_RUN_RE.test(text);
const isTowerCmd = (text) => isToolCmd(text) && STEP_TOWER_CMD.test(text);
const isEvalCmd = (text) => isToolCmd(text) && EVAL_TASKS_CMD.test(text);
/** 唯一允许的门禁命令形状（可带 env= 前缀）。 */
const GATE_SHAPE = new RegExp(
  String.raw`^(?:export\s+)?(?:${ENV_ASSIGN}\s+)*(?:${TOOL_CMD})(?:\s+--(?:\s+${SAFE_ARG})+)?$`
);
/** 唯一允许的管道形状：`2>&1 | tee <file>`，且同一步必须 `set -o pipefail`。 */
const TEE_SHAPE = new RegExp(
  String.raw`^(?:${TOOL_CMD})(?:\s+--(?:\s+${SAFE_ARG})+)?\s+2>&1\s+\|\s+tee\s+[A-Za-z0-9_.:\/-]+$`
);
const PREAMBLE_SHAPES = [
  /^cd desktop$/,
  /^(?:\.|source)\s+[A-Za-z0-9_.:\/-]+\/activate$/,
  /^set -o pipefail$/,
  new RegExp(String.raw`^export ${ENV_ASSIGN}$`)
];
/** 命令替换 / 反引号：形状判据之外的显式一档（判红了才好解释）。 */
const SUBSTITUTION_RE = /`|\$\(/;
/** 装 node 依赖：只认命令开头（`# npm ci` 注释、`echo npm ci` 都不算）。 */
const INSTALL_CMD_RE = /^npm\s+(?:ci|install)(?:\s|$)/;
const isInstallCommand = (text) => INSTALL_CMD_RE.test(text);

// ---------------------------------------------------------------------------
// 真内核 identity-export 用例（R13 / C2）
//
// 事故形态：这 6 条在 unit job 里恒 SKIP（runner 没 build123d），而唯一装了内核的
// featuretree-geometry job **没有任何 node --test 步骤** → 这 6 条在 CI 一处都没跑。
// 判据同样只认命令：注释里写「这里跑了 identity-export」不顶用。
// ---------------------------------------------------------------------------
const IDENTITY_EXPORT_FILE = 'test/parametric/identity-export.test.mjs';
/** 真跑该文件的命令：`node --test … identity-export.test.mjs`。 */
const isIdentityExportRun = (text) => /\bnode\s+--test\b/.test(text) && text.includes(IDENTITY_EXPORT_FILE);
/** TAP 回执校验器（本包新增，独占文件）。 */
const IDENTITY_VERIFIER = 'scripts/verify-identity-export-tap.mjs';
const IDENTITY_VERIFIER_RE = /\bnode\s+scripts\/verify-identity-export-tap\.mjs\s+(\S+)\s*$/;
/** 结构化回执：node 自己把结果写成 TAP（不再是给人看的 spec 日志）。 */
const TAP_REPORTER_RE = /(?:^|\s)--test-reporter=tap(?:\s|$)/;
const TAP_DEST_RE = /(?:^|\s)--test-reporter-destination=(\S+)/;
/** 用例过滤：任何一种都能把整文件过滤成「零条执行仍 exit 0」。 */
const FILTER_FLAGS = [
  { re: /--test-name-pattern\b/, label: '--test-name-pattern' },
  { re: /--test-only\b/, label: '--test-only' },
  { re: /--test-skip-pattern\b/, label: '--test-skip-pattern' }
];
/**
 * 「拿文本当证据」的写法：R13 审查实测两条都能假绿 ——
 *   ① `echo 'ℹ skipped 0'`：不读日志、不证明任何东西；
 *   ② `grep -q 'ℹ skipped 0' <log>`：`--test-name-pattern` 过滤掉全部用例后 node 仍打印
 *      `ℹ tests 1 / ℹ pass 1 / ℹ skipped 0` 并 exit 0，grep 照样命中。
 * 所以回执只能来自 TAP 解析器，这一步里出现 echo/printf/cat/grep 或 `ℹ …` 摘要文案一律判红。
 */
const FAKE_PROOF_RES = [
  { re: /^(?:echo|printf|cat|grep)\b/, label: 'echo/printf/cat/grep（拿文本冒充执行结果）' },
  { re: /ℹ (?:tests|pass|fail|skipped|suites|cancelled|todo|duration_ms)\b/, label: '`ℹ …` 摘要文案（spec reporter 的日志行）' }
];

// ---------------------------------------------------------------------------
// 这一步的**契约形状**（R13 复审 §4.2 整改）
//
// 复审实测的四个绿：step 级 `continue-on-error: true`、step 级 `if: false`（新步骤
// 不在 ④ 的判据作用域内，那两个码只绑 `isToolCmd`），以及
//   `"$FT_PY" -c '…'` / 生产者行 被 `true # <真命令>` / `: # …` / `if false; then …; fi`
// 顶掉（判据是全文子串正则，行尾注释和恒假分支都能满足它）。
//
// 这里不写 shell 解释器，只锁**这一条步骤的契约**：每个命令行必须整行落进下面六种
// 形状之一（行首锚定 + 全行匹配），并且必须 preflight < 生产者 < 消费者。条件/循环
// 控制语句、`true`/`:` 这类 noop 天然落不进这六种形状 —— fail-closed，不需要额外
// 枚举每一个 shell 关键字（这一步本来就只有顺序执行，用不到任何控制流）。
// ---------------------------------------------------------------------------

/**
 * 去掉行尾 shell 注释（引号内的 `#` 原样保留）。
 *
 * 只做「引号状态机 + 第一个引号外的 `#`」，不是词法分析器：它的唯一职责是让
 * `true # <真命令>` 不再靠注释里的文本满足任何判据。引号内的 Python 代码
 * （含 `;`）因此一字不动 —— 本文件从不在引号内切分命令。
 */
function stripShellComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 预检：必须是**这一行**在直接调用刚取到的解释器（行首锚定，行尾锚定）。 */
const ID_PREFLIGHT_CMD = /^"\$FT_PY"\s+-c\s+'(?=[^']*\bimport\s+build123d\b)[^']*'$/;
/** 生产者：必须由 `AUTOMATIONCAD_PYTHON="$FT_PY"` 起头，把 TAP 写进**绝对路径**文件。 */
const ID_PRODUCER_CMD = new RegExp(
  '^AUTOMATIONCAD_PYTHON="\\$FT_PY"\\s+node\\s+--test\\s+--test-reporter=tap'
  + '\\s+--test-reporter-destination=(\\/\\S+)\\s+'
  + `${escapeRe(IDENTITY_EXPORT_FILE)}$`
);
/** 消费者：必须是 `node <校验器> <绝对路径>`，不多不少。 */
const ID_CONSUMER_CMD = new RegExp(`^node\\s+${escapeRe(IDENTITY_VERIFIER)}\\s+(\\/\\S+)$`);

/** 这一步允许的六种行；`role` 参与顺序判据（preflight < producer < consumer）。 */
const ID_STEP_SHAPES = [
  { re: /^cd desktop$/, label: 'cd desktop' },
  { re: /^set -euo pipefail$/, label: 'set -euo pipefail' },
  { re: /^FT_PY="\$PWD\/\.\.\/\.venv-ft\/bin\/python"$/, label: 'FT_PY="$PWD/../.venv-ft/bin/python"' },
  { re: ID_PREFLIGHT_CMD, label: '预检「"$FT_PY" -c \'… import build123d …\'」', role: 'preflight' },
  {
    re: ID_PRODUCER_CMD,
    label: '生产者「AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-reporter=tap '
      + `--test-reporter-destination=/tmp/… ${IDENTITY_EXPORT_FILE}」`,
    role: 'producer'
  },
  { re: ID_CONSUMER_CMD, label: `消费者「node ${IDENTITY_VERIFIER} /tmp/…」`, role: 'consumer' }
];
const ID_STEP_SHAPE_HINT = ID_STEP_SHAPES.map((s) => `「${s.label}」`).join(' / ');
const ID_ROLE_LABEL = { preflight: 'venv 预检（preflight）', producer: 'TAP 生产者（producer）', consumer: 'TAP 消费者（consumer）' };

// ---------------------------------------------------------------------------
// 负向自证步骤的形状（严格档必须「缺内核就红」，且不许真去卸载共享 venv）
//
// 受控缺内核 = 指向一个绝对不存在的解释器：parametric.ts 的 resolvePython() 对绝对路径
// 只做 existsSync + 可执行判定，不存在就返回 null，**不会**回退到 PATH 里的 python3 或
// 任何 venv（parametric.ts:243-245）；commandSpec() 拿到 null 就 failStart（:593-596）。
// AUTOMATIONCAD_PARAMETRIC_CMD 必须清掉，因为它优先级高于 python 解析（:683）。
// ---------------------------------------------------------------------------
const NEG_PY_LINE = /^MISSING_PY=\/nonexistent\/[A-Za-z0-9_.:\/-]+$/;
const NEG_REQUIRED = [
  { re: /--skip-if-no-kernel /, label: '--skip-if-no-kernel（要走 SKIP 分支而不是 FAIL）' },
  { re: /AUTOMATIONCAD_PYTHON="\$MISSING_PY"/, label: 'AUTOMATIONCAD_PYTHON="$MISSING_PY"（受控解释器）' },
  { re: /AUTOMATIONCAD_PARAMETRIC_CMD= /, label: 'AUTOMATIONCAD_PARAMETRIC_CMD= （压掉优先级更高的旁路）' },
  { re: /--json/, label: '--json（回执里要有 skipped/exitCode 可断言）' }
];

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * 对任意 ci.yml 文本做门禁审计。
 * 返回 `{ findings: [{ code, message }] }`；`disable` 用来关掉单条判据 —— 只为让
 * 「删掉这条 check，对应的变异就会变绿」这件事可以被测试证明（不是给生产用的开关）。
 */
function auditGates(text, { disable = [] } = {}) {
  const off = new Set(disable);
  const { jobs, jobList } = parseWorkflow(text);
  const findings = [];
  const add = (code, message) => {
    if (off.has(code)) return;
    findings.push({ code, message });
  };

  const cmds = (job) => job.steps.flatMap((st) => st.commands.map((c) => ({ ...c, step: st })));
  const strictEvalSteps = [];
  for (const j of jobList) {
    for (const st of j.steps) {
      if (st.commands.some((c) => isEvalCmd(c.text) && hasStrictToken(c.text))) {
        strictEvalSteps.push({ job: j, step: st });
      }
    }
  }

  // ① featuretree-geometry：每条 verify:step-tower 都必须带精确 token，且 16/8 层都在
  const ft = jobs.get(FT_JOB);
  if (!ft) {
    add('FT_JOB_MISSING', `找不到 job「${FT_JOB}」：有 build123d 的 job 是严格档唯一的合法落点`);
  } else {
    const towerCmds = cmds(ft).filter((c) => isTowerCmd(c.text));
    if (towerCmds.length < 2) {
      add('TOWER_COUNT', `job「${FT_JOB}」里 verify:step-tower 只有 ${towerCmds.length} 条，16 层 + 8 层基线都要跑`);
    }
    for (const c of towerCmds) {
      const weak = strictWeakForm(c.text);
      if (weak) {
        add(
          'STRICT_FLAG_WEAK_FORM',
          `${FT_JOB}:${c.line} \`${c.text}\` 的严格档是 ${weak.label} —— `
          + 'verify-step-tower 用 args.includes 精确匹配 token，这种写法等于没给严格档（守卫以前被子串判定放过）'
        );
      } else if (!hasStrictToken(c.text)) {
        add(
          'STRICT_FLAG_MISSING',
          `${FT_JOB}:${c.line} \`${c.text}\` 缺 ${STRICT_FLAG} —— `
          + '没装内核/件建不出来时脚本只会打印 STEP_VERIFY SKIP 并 exit 0，门禁等于空转'
        );
      }
    }
    const levels = new Set();
    for (const c of towerCmds) {
      for (const m of c.text.matchAll(/--levels\s+(\d+)/g)) levels.add(Number(m[1]));
    }
    for (const need of [16, 8]) {
      if (!levels.has(need)) add('LEVELS_BASELINE', `job「${FT_JOB}」缺少 --levels ${need} 的缓存塔基线`);
    }
    // 「换成 --skip-if-no-kernel 保证绿」也是回退：SKIP 模式不许单独出现在这条门禁里
    for (const c of towerCmds) {
      if (c.text.includes('--skip-if-no-kernel') && !hasStrictToken(c.text)) {
        add('SKIP_SWAP', `${FT_JOB}:${c.line} 用 --skip-if-no-kernel 换绿灯（严格档必须同时在）`);
      }
    }
  }

  // ② 严格档 eval:tasks 必须存在、必须在「先装了内核」的 job 里、自己也要指向该内核
  if (strictEvalSteps.length === 0) {
    add('STRICT_EVAL_MISSING', `整份 ci.yml 找不到带 ${STRICT_FLAG} 的 eval:tasks：t12-step-export 在 runner 上会恒 SKIP 而流水线仍绿`);
  } else if (strictEvalSteps.length > 1) {
    add(
      'STRICT_EVAL_DUPLICATE',
      `带 ${STRICT_FLAG} 的 eval:tasks 出现 ${strictEvalSteps.length} 次（`
      + strictEvalSteps.map((s) => `${s.job.name}:${s.step.line}`).join(', ')
      + '），严格档只该在有一个装内核的 job 里跑'
    );
  }
  for (const { job, step } of strictEvalSteps) {
    const kernelIdx = job.steps.findIndex((st) => st.commands.some((c) => /pip\s+install/.test(c.text) && /build123d/.test(c.text)));
    const stepIdx = job.steps.indexOf(step);
    if (kernelIdx < 0) {
      add('KERNEL_PRECEDES', `${job.name}:${step.line} 跑 eval:tasks 严格档，但该 job 里没有任何「安装 build123d」的步骤（无内核 job 里严格档 = 必然假红）`);
    } else if (kernelIdx > stepIdx) {
      add('KERNEL_PRECEDES', `${job.name}:${step.line} 严格档排在装内核（第 ${job.steps[kernelIdx].line} 行）之前，跑起来内核还不存在`);
    }
    const selfUsesKernel = step.commands.some(
      (c) => /AUTOMATIONCAD_PYTHON=.*\.venv-ft/.test(c.text) || /\.venv-ft\/bin\/activate/.test(c.text)
    );
    if (!selfUsesKernel) {
      add('SELF_KERNEL', `${job.name}:${step.line} 严格档没有指向 .venv-ft 的内核（AUTOMATIONCAD_PYTHON / activate），等于赌 runner 上恰好有 build123d`);
    }
  }

  // ③ unit（无内核）：不许出现严格档；非严格档必须仍在（防止「删掉」冒充「移动」）
  const unit = jobs.get(NO_KERNEL_JOB);
  if (!unit) {
    add('UNIT_JOB_MISSING', `找不到 job「${NO_KERNEL_JOB}」：无内核 job 是「严格档不许落地」的反面基准`);
  } else {
    const unitEval = cmds(unit).filter((c) => isEvalCmd(c.text));
    for (const c of unitEval) {
      if (hasStrictToken(c.text)) {
        add(
          'UNIT_STRICT_FORBIDDEN',
          `${NO_KERNEL_JOB}:${c.line} \`${c.text}\` —— 严格档不许在无内核 job 里跑：`
          + '该 job 的 t12-step-export 恒 SKIP，加了严格档只会假红'
        );
      }
    }
    if (!unitEval.some((c) => !hasStrictToken(c.text))) {
      add('UNIT_LOOSE_MISSING', `job「${NO_KERNEL_JOB}」里的非严格 eval:tasks 不见了：末态断言被删而不是被移动`);
    }
  }

  // ④ 门禁步骤（以及它所在的 job）：不许吞失败，命令必须落在规范形状内
  for (const j of jobList) {
    const gateSteps = j.steps.filter((st) => st.commands.some((c) => isToolCmd(c.text)));
    if (gateSteps.length === 0) continue;

    // job 级（4 空格）：一个 continue-on-error / 恒假 if 就能让整 job 的门禁全部不阻塞
    for (const row of j.lines) {
      const key = /^ {4}(continue-on-error|if):\s*(.+?)\s*$/.exec(row.text);
      if (!key) continue;
      if (key[1] === 'continue-on-error' && !isFalseish(key[2])) {
        add('JOB_CONTINUE_ON_ERROR', `${j.name} 第 ${row.line} 行是 job 级 continue-on-error: ${key[2]} —— 整 job（含全部门禁）都不阻塞，一个 4 空格改动就能让严格档消失`);
      }
      if (key[1] === 'if' && isConstantFalse(key[2])) {
        add('JOB_IF_FALSE', `${j.name} 第 ${row.line} 行是 job 级 if: ${key[2]} —— 整个 job 永不执行，门禁全没了`);
      }
    }

    for (const st of gateSteps) {
      // step 级 if（任意缩进）
      for (const row of st.raw) {
        const m = /^\s*if:\s*(.+?)\s*$/.exec(row.text);
        if (!m) continue;
        if (isConstantFalse(m[1])) {
          add('STEP_IF_FALSE', `${j.name}:${row.line} 门禁步骤的 if: ${m[1]} 恒假 —— 这一步永不执行，严格档等于没接`);
        }
      }
      // step 级 continue-on-error（任意缩进，值不是显式 false 就判红）
      for (const row of st.raw) {
        const m = /^\s*continue-on-error:\s*(.+?)\s*$/.exec(row.text);
        if (!m) continue;
        if (!isFalseish(m[1])) {
          add('STEP_CONTINUE_ON_ERROR', `${j.name}:${row.line} 门禁步骤标了 continue-on-error: ${m[1]}（失败不阻塞 = 没门禁）`);
        }
      }
      // 吞退出码 + 规范形状
      const hasPipefail = st.commands.some((c) => /^set -o pipefail$/.test(c.text));
      for (const c of st.commands) {
        const mask = maskOf(c.text);
        if (mask) add('MASKED_EXIT', `${j.name}:${c.line} 门禁命令带「${mask.label}」（失败被吞，等于没门禁）`);
        if (SUBSTITUTION_RE.test(c.text)) {
          add('NON_CANONICAL_SHAPE', `${j.name}:${c.line} 门禁步骤出现命令替换/反引号 \`${c.text}\` —— 不在允许形状内（不对 shell 做解释，一律判红）`);
          continue;
        }
        const isTool = isToolCmd(c.text);
        const ok = isTool
          ? (GATE_SHAPE.test(c.text) || (TEE_SHAPE.test(c.text) && hasPipefail))
          : PREAMBLE_SHAPES.some((re) => re.test(c.text));
        if (!ok) {
          add(
            'NON_CANONICAL_SHAPE',
            `${j.name}:${c.line} \`${c.text}\` 不在门禁步骤的规范形状内 —— `
            + (isTool
              ? '只允许 `npm run <verify:step-tower|eval:tasks> -- <参数>`（可带 NAME=值 前缀）；带 `;`/`&&`/`||`/重定向/`=` 参数的写法一律判红'
              : '前导只允许 `cd desktop` / `. .venv-ft/bin/activate` / `set -o pipefail` / `export NAME=值`')
          );
        }
      }
    }
  }

  // ⑤ 负向自证步骤：严格档必须「缺内核就红」，而且不许真去卸载共享 venv
  if (ft && !off.has('NEG_SELFPROOF_MISSING')) {
    const candidates = ft.steps.filter((st) => st.commands.some((c) => STEP_TOWER_SCRIPT.test(c.text)));
    const problem = (() => {
      if (candidates.length === 0) return '没有这条步骤：严格档只有「有内核时绿」的正向证据，缺「缺内核必红」的负向证据';
      if (candidates.length > 1) return `有 ${candidates.length} 条步骤在跑 verify-step-tower.mjs，形状判据不知道看哪一条`;
      const st = candidates[0];
      const arms = st.commands.filter((c) => STEP_TOWER_SCRIPT.test(c.text));
      if (arms.length !== 2) return `应有两臂（非严格 / 严格），实际 ${arms.length} 条`;
      const strictArms = arms.filter((c) => hasStrictToken(c.text));
      if (strictArms.length !== 1) return `两臂里必须正好一条带 ${STRICT_FLAG}（实际 ${strictArms.length} 条）`;
      for (const arm of arms) {
        for (const need of NEG_REQUIRED) {
          if (!need.re.test(arm.text)) return `第 ${arm.line} 行缺 ${need.label}`;
        }
      }
      if (typeof st.timeoutMinutes !== 'number') {
        return '这一步没有 timeout-minutes：预算注释里的 5 min 就只是散文，算不进步骤合计';
      }
      if (!st.commands.some((c) => NEG_PY_LINE.test(c.text))) {
        return '缺 `MISSING_PY=/nonexistent/...`：受控缺内核必须是绝对不存在路径（不许卸载共享 .venv-ft，也不许靠改 PATH 赌）';
      }
      const joined = st.commands.map((c) => c.text).join('\n');
      if (!/test "\$LOOSE" -eq 0/.test(joined)) return '缺 `test "$LOOSE" -eq 0`：非严格臂必须自证 SKIP 仍按旧约定 exit 0（同时挡住「崩了恰好 exit 1」）';
      if (!/test "\$STRICT" -eq 1/.test(joined)) return '缺 `test "$STRICT" -eq 1`：严格臂必须断言 exit 1';
      for (const needle of ['python=$MISSING_PY', 'SKIP 内核未跑', '"skipped":true', '"exitCode":1']) {
        if (!joined.includes(needle)) return `缺日志断言「${needle}」（要证明真用了受控解释器、真走了 SKIP 分支）`;
      }
      for (const c of st.commands) {
        const mask = maskOf(c.text);
        if (mask) return `第 ${c.line} 行带「${mask.label}」—— 负向自证自己也被吞掉了`;
      }
      return null;
    })();
    if (problem) add('NEG_SELFPROOF_MISSING', `${FT_JOB} 的严格档负向自证不成立：${problem}`);
  }

  // ⑥ 预算 / 步骤超时 / job 超时不许互相打脸（加 step 必须同步预算）
  if (ft) {
    const jobTimeout = JOB_TIMEOUT_RE.exec(ft.lines.map((r) => r.text).join('\n'))?.[1];
    const stepTimeouts = ft.steps.map((st) => st.timeoutMinutes).filter((n) => typeof n === 'number');
    const sumSteps = stepTimeouts.reduce((a, b) => a + b, 0);
    const budgetLine = ft.lines.find((r) => r.text.includes('步骤预算'));
    const budgetBlock = budgetLine
      ? [budgetLine, ...ft.lines.slice(ft.lines.indexOf(budgetLine) + 1, ft.lines.indexOf(budgetLine) + 4)]
      : [];
    const budgetTotal = budgetBlock.map((r) => /= (\d+) min/.exec(r.text)?.[1]).filter(Boolean).map(Number)[0];
    if (!budgetLine) {
      add('BUDGET_MISSING', `${FT_JOB} 缺「步骤预算」注释：步骤一多就又回到「job 超时先掐断、红但原因误导」`);
    } else if (budgetTotal === undefined) {
      add('BUDGET_MISSING', `${FT_JOB} 的步骤预算注释里没有「= N min」合计`);
    } else {
      if (budgetTotal < sumSteps) {
        add('BUDGET_TOO_SMALL', `${FT_JOB} 预算注释合计 ${budgetTotal} min < 步骤 timeout-minutes 之和 ${sumSteps} min`);
      }
      // 「加了 step 必须同步预算」：预算条目必须是「<名字> <数字>」，不是散文里提一嘴
      if (!budgetBlock.some((r) => /负向自证\s+\d+/.test(r.text))) {
        add('BUDGET_ITEM_MISSING', `${FT_JOB} 的步骤预算注释没有把「严格档负向自证」算进去 —— 加了 step 就必须同步预算与守卫`);
      }
      if (!jobTimeout) {
        add('JOB_TIMEOUT_MISSING', `${FT_JOB} 缺 job 级 timeout-minutes`);
      } else if (Number(jobTimeout) < budgetTotal) {
        add('JOB_TIMEOUT_LOW', `${FT_JOB} job 超时 ${jobTimeout} min < 预算合计 ${budgetTotal} min（最后一步会被掐断，红但原因误导）`);
      }
    }
  }

  // ⑦ 依赖前置：跑 npm 门禁的 job 必须**先**装 node 依赖
  //
  // 首跑事故（featuretree-geometry）：只装了 build123d，没有 npm ci，eval:tasks 一 import
  // desktop/src/shared/zip.ts 就 `ERR_MODULE_NOT_FOUND: Cannot find package 'adm-zip'` ——
  // 严格档是「红了」，但一条断言都没跑到，红的理由只会把人往断言上带。
  //
  // 判据是**执行顺序**，不是「文本里出现过 npm ci」：`# npm ci` 注释、装在评测之后的步骤
  // 都不算数。顺序从 parseWorkflow() 拆出来的步骤数组里取，和 shell 实际执行顺序一致
  // （除了 `if:` 恒假，那由 ④ 单独判）。
  const isInstallStep = (st) => st.commands.some((c) => INSTALL_CMD_RE.test(c.text));
  for (const j of jobList) {
    const gateIdx = j.steps.findIndex((st) => st.commands.some((c) => isToolCmd(c.text)));
    if (gateIdx < 0) continue;
    const installIdx = j.steps.findIndex(isInstallStep);
    if (installIdx < 0) {
      add(
        'DEPS_INSTALL_MISSING',
        `${j.name} 第 ${j.steps[gateIdx].line} 行起跑 npm 门禁，但该 job 里没有 npm ci / npm install 步骤 —— `
        + 'runner 上 node_modules 不存在，首跑实测是 `Cannot find package \'adm-zip\'`（环境前置遗漏，不是断言失败）'
      );
    } else if (installIdx > gateIdx) {
      add(
        'DEPS_ORDER',
        `${j.name} 的安装依赖落在第 ${j.steps[installIdx].line} 行，晚于第 ${j.steps[gateIdx].line} 行的第一条门禁命令 —— `
        + '顺序反了等于没装（门禁跑的时候 node_modules 还不存在）'
      );
    }
  }

  // ⑧ 真内核 identity-export 用例：有内核的 job 必须真跑，且回执必须是**结构化 TAP**
  //
  // C2 之前这份文件的真内核用例在 CI **一处都没跑**：unit 里恒 SKIP（runner 没 build123d），
  // 而唯一装了内核的 featuretree-geometry 里没有任何 node --test 步骤。
  // P1-3 之前那条「真跑」步骤只断言 `grep -q 'ℹ skipped 0'`，被两条实测假绿击穿：
  //   · `echo 'ℹ skipped 0'` 能满足它（不读日志、不证明任何事）；
  //   · `--test-name-pattern=ZZ` 过滤掉全部用例后 node 仍打印 `ℹ tests 1 / ℹ pass 1 /
  //     ℹ skipped 0` 并 exit 0 —— 「线接上了、一条都没跑」。
  // 现在的判据是一条链，缺一环就红：
  //   producer：`node --test --test-reporter=tap --test-reporter-destination=<独立文件>`
  //   consumer：`node scripts/verify-identity-export-tap.mjs <同一个文件>`
  //   · 必须先证明 venv 里真有内核（`"$FT_PY" -c 'import build123d…'`）——用例文件自带
  //     AUTOMATIONCAD_PYTHON → /root/.venvs → python3 三级回退，指错了也会静默落到别处；
  //   · `set -euo pipefail`（没有它，前面命令失败还能走到最后一行）；
  //   · 不许任何 `--test-name-pattern/--test-only/--test-skip-pattern`；
  //   · 不许拿 echo/grep/`ℹ …` 文案当证据（那正是被击穿的两条）。
  // 用例条数一个字都不钉（B 还在加），「必须真跑过」由校验器按具名契约判。
  if (ft) {
    const identitySteps = ft.steps.filter((st) => st.commands.some((c) => isIdentityExportRun(c.text)));
    const structural = (() => {
      if (identitySteps.length === 0) {
        return `没有任何步骤跑 ${IDENTITY_EXPORT_FILE} —— 那几条真内核用例在 CI 一处都不跑（unit 里恒 SKIP，本 job 又不跑）`;
      }
      if (identitySteps.length > 1) {
        return `有 ${identitySteps.length} 条步骤在跑 ${IDENTITY_EXPORT_FILE}（第 ${identitySteps.map((s) => s.line).join(', ')} 行），判据不知道看哪一条`;
      }
      const st = identitySteps[0];
      const runCmds = st.commands.filter((c) => isIdentityExportRun(c.text));
      const run = runCmds[0];
      if (!TAP_REPORTER_RE.test(run.text)) {
        return `第 ${run.line} 行没有 --test-reporter=tap —— 不给结构化回执，就只能拿文本（echo/grep）当证据，那两条已被实测击穿`;
      }
      const dest = TAP_DEST_RE.exec(run.text)?.[1];
      if (!dest) {
        return `第 ${run.line} 行没有 --test-reporter-destination=<独立文件> —— 结果没有落到可校验的独立文件里`;
      }
      if (!dest.startsWith('/')) {
        return `TAP 输出文件是相对路径「${dest}」—— 必须是仓库外的独立绝对路径（/tmp/…），否则会被当成仓库产物提交`;
      }
      if (!st.commands.some((c) => IDENTITY_VERIFIER_RE.test(c.text))) {
        return `没有跑 ${IDENTITY_VERIFIER} —— node 写了 TAP 却没人校验，等于回执没人看`;
      }
      if (!st.commands.some((c) => /^set -euo pipefail$/.test(c.text))) {
        return '缺 `set -euo pipefail` —— node 那条命令失败时后面还会继续跑，最后以校验器/最后一行为准就假绿了';
      }
      const venvLine = st.commands.find((c) => /^FT_PY="/.test(c.text));
      if (!venvLine || !/\.venv-ft\/bin\/python/.test(venvLine.text)) {
        return '没有 `FT_PY=…/.venv-ft/bin/python` —— 不许赌 runner 上恰好有 build123d';
      }
      if (!st.commands.some((c) => /"\$FT_PY"\s+-c\s+['"][^'"]*import build123d/.test(c.text))) {
        return '没有先 `"$FT_PY" -c "import build123d…"` —— 用例文件有三级回退，venv 指错时它会静默落到别处，'
          + '红因就变成「skipped N」而不是「venv 指错」';
      }
      if (!/AUTOMATIONCAD_PYTHON="\$FT_PY"/.test(run.text)) {
        return `第 ${run.line} 行的 AUTOMATIONCAD_PYTHON 不是刚验证过的 "$FT_PY" —— 证明的和用的可能不是同一个解释器`;
      }
      if (typeof st.timeoutMinutes !== 'number') {
        return '这一步没有 timeout-minutes：预算注释里的 5 min 只是散文，算不进步骤合计（⑥）';
      }
      // 前置顺序：npm ci 与 build123d 都必须在**这一步之前**（判执行顺序，不看文本里有没有）
      const stIdx = ft.steps.indexOf(st);
      const npmIdx = ft.steps.findIndex((s) => s.commands.some((c) => INSTALL_CMD_RE.test(c.text)));
      const kernelIdx = ft.steps.findIndex((s) => s.commands.some((c) => /pip\s+install/.test(c.text) && /build123d/.test(c.text)));
      if (npmIdx < 0 || npmIdx > stIdx) {
        return 'npm ci 不在这条步骤之前 —— node_modules 不存在时 node --test 连文件都加载不起来，红因与断言无关';
      }
      if (kernelIdx < 0 || kernelIdx > stIdx) {
        return '「安装 build123d」不在这条步骤之前 —— 跑的时候 .venv-ft 还不存在，前置证明会直接红';
      }
      return null;
    })();
    if (structural) add('FT_IDENTITY_EXPORT_MISSING', `${FT_JOB} 的真内核 identity-export 用例不成立：${structural}`);

    const st = identitySteps.length === 1 ? identitySteps[0] : null;
    if (st) {
      for (const c of st.commands) {
        const flag = FILTER_FLAGS.find((f) => f.re.test(c.text));
        if (flag) {
          add(
            'IDENTITY_TAP_FILTER_FORBIDDEN',
            `${FT_JOB}:${c.line} 的 \`${c.text}\` 带 ${flag.label} —— 过滤到零条时 node 仍 exit 0，`
            + '「零条执行仍全绿」正是这条门禁要堵的形态（实测：18 条全被过滤后 tests 1 / pass 1 / skipped 0）'
          );
        }
        const fake = FAKE_PROOF_RES.find((f) => f.re.test(c.text));
        if (fake) {
          add(
            'IDENTITY_TAP_FAKE_PROOF',
            `${FT_JOB}:${c.line} 的 \`${c.text}\` 是${fake.label} —— 回执只能来自 TAP 解析器，`
            + '`echo "ℹ skipped 0"` 与 `grep -q "ℹ skipped 0"` 都已被实测证明可以为零执行背书'
          );
        }
      }
      // producer / consumer 必须指向**同一个**文件：两处各写各的路径时，校验器读的是上一次的旧回执
      const dest = st.commands.map((c) => TAP_DEST_RE.exec(c.text)?.[1]).find(Boolean);
      const consumed = st.commands.map((c) => IDENTITY_VERIFIER_RE.exec(c.text)?.[1]).find(Boolean);
      if (dest && consumed && dest !== consumed) {
        add(
          'IDENTITY_TAP_UNBOUND',
          `${FT_JOB}: 写回执的是「${dest}」，校验器读的是「${consumed}」—— 生产者与消费者没绑在同一个文件上，`
          + '校验器可能在校验上一次（或别人的）回执'
        );
      }
    }
  }

  // ⑨ unit（无内核）：不许出现该文件名 —— 挪错方向 = 给主门禁压 PyPI 依赖，且那 6 条在
  // 那边恒 SKIP（看起来跑了、其实一条都没跑）。和 ③ 是同一条思路的反面基准。
  if (unit) {
    for (const c of cmds(unit)) {
      if (!c.text.includes(IDENTITY_EXPORT_FILE)) continue;
      add(
        'UNIT_IDENTITY_EXPORT_FORBIDDEN',
        `${NO_KERNEL_JOB}:${c.line} \`${c.text}\` 在无内核 job 里跑 ${IDENTITY_EXPORT_FILE} —— `
        + `那 6 条在这里恒 SKIP（看着跑了、其实没跑），要真跑请放 ${FT_JOB}（那里有 .venv-ft）`
      );
    }
  }

  // ⑩ 内核 identity-export / TAP 步骤：禁用、吞码、noop 与执行顺序（R13 复审 §4.2）
  //
  // 复审实测的四个绿全部落在这一条步骤上：
  //   · step 级 `continue-on-error: true` → 步骤失败不阻塞 job，内核零证据而流水线绿；
  //   · step 级 `if: false` → 这一步永不执行，等于没接；
  //   · `"$FT_PY" -c '…'` / 生产者行 被 `true # <真命令>`、`: # …`、`if false; then …; fi` 满足；
  //   · 校验器排在生产者之前、生产者/消费者挂 `|| true` / `; true`（吞码）。
  // 根因：④ 的判据对象只取 `isToolCmd`（verify:step-tower / eval:tasks），新加的内核
  // 步骤不在作用域内；而 ⑧ 的命令判据是「文本里出现过」，行尾注释与恒假分支都能满足。
  // 这里的三类判据都**复用既有码**（JOB_/STEP_IF_FALSE、JOB_/STEP_CONTINUE_ON_ERROR、
  // MASKED_EXIT），只新增两个位置明确的码：IDENTITY_STEP_NOOP（不是实际执行命令）与
  // IDENTITY_STEP_ORDER（preflight < 生产者 < 消费者 不成立）。
  const identityGovSteps = [];
  for (const j of jobList) {
    for (const st of j.steps) {
      if (st.commands.some((c) => isIdentityExportRun(c.text) || IDENTITY_VERIFIER_RE.test(c.text))) {
        identityGovSteps.push({ job: j, step: st });
      }
    }
  }
  for (const { job: j, step: st } of identityGovSteps) {
    // job 级条件对**每一个**步骤生效：这一条步骤所在的 job 被禁用/不阻塞，同样等于没接。
    // （④ 只在「有 npm 门禁步骤」的 job 里查这两种键，新步骤可能落在别的 job 里。）
    for (const row of j.lines) {
      const key = /^ {4}(continue-on-error|if):\s*(.+?)\s*$/.exec(row.text);
      if (!key) continue;
      if (key[1] === 'continue-on-error' && !isFalseish(key[2])) {
        add(
          'JOB_CONTINUE_ON_ERROR',
          `${j.name} 第 ${row.line} 行是 job 级 continue-on-error: ${key[2]} —— 内核 identity-export 步骤（第 ${st.line} 行起）`
          + '同样被摘掉阻塞，job 绿而内核零证据'
        );
      }
      if (key[1] === 'if' && isConstantFalse(key[2])) {
        add('JOB_IF_FALSE', `${j.name} 第 ${row.line} 行是 job 级 if: ${key[2]} —— 整个 job 永不执行，内核 identity-export 步骤也一并消失`);
      }
    }
    // step 级 if / continue-on-error（任意缩进；值不是显式 false 就判红）
    // 也查**首行**写法 `- if: false`（那一行不在 st.raw 里，是 step.head）
    for (const row of [{ line: st.line, text: st.head }, ...st.raw]) {
      const m = /^\s*if:\s*(.+?)\s*$/.exec(row.text);
      if (m && isConstantFalse(m[1])) {
        add('STEP_IF_FALSE', `${j.name}:${row.line} 内核 identity-export 步骤的 if: ${m[1]} 恒假 —— 这一步永不执行，TAP 生产者与校验器一起消失`);
      }
      const ce = /^\s*continue-on-error:\s*(.+?)\s*$/.exec(row.text);
      if (ce && !isFalseish(ce[1])) {
        add(
          'STEP_CONTINUE_ON_ERROR',
          `${j.name}:${row.line} 内核 identity-export 步骤标了 continue-on-error: ${ce[1]}`
          + '（失败不阻塞 = 这一步没有门禁作用，且 100% 零内核证据仍绿）'
        );
      }
    }
    // 吞退出码 + 契约形状（注释先剥掉：`true # <真命令>` 不许靠注释满足任何判据）
    const roleAt = { preflight: [], producer: [], consumer: [] };
    for (let ci = 0; ci < st.commands.length; ci += 1) {
      const c = st.commands[ci];
      const bare = stripShellComment(c.text);
      // 只判「剥掉注释后的命令」：注释里提一句 `|| true` 不是吞码（整行注释本来就不进 commands）
      const mask = maskOf(bare);
      if (mask) {
        add('MASKED_EXIT', `${j.name}:${c.line} 内核 identity-export 步骤的命令带「${mask.label}」（失败被吞，等于没门禁）`);
      }
      const shape = ID_STEP_SHAPES.find((s) => s.re.test(bare));
      if (!shape) {
        add(
          'IDENTITY_STEP_NOOP',
          `${j.name}:${c.line} \`${c.text}\` 不是这一步契约内的实际执行命令 —— 该步只允许 ${ID_STEP_SHAPE_HINT}；`
          + '`true` / `:` / 行尾注释冒充 / `if …; then …; fi` 这类条件或循环控制语句一律判红（fail-closed，不做 shell 解释）'
        );
        continue;
      }
      if (shape.role) roleAt[shape.role].push({ idx: ci, line: c.line });
    }
    // 顺序：preflight < 生产者 < 消费者，且三者各一条。
    // 消费者在前 = 校验的是上一次（或别人的）回执；生产者在前 = 内核没证明就开跑。
    for (const role of ['preflight', 'producer', 'consumer']) {
      const hits = roleAt[role];
      if (hits.length === 0) {
        add(
          'IDENTITY_STEP_ORDER',
          `${j.name}:${st.line} 起的这一步缺 ${ID_ROLE_LABEL[role]} —— 形态上「有」，但没有一行是它的实际执行命令`
        );
      } else if (hits.length > 1) {
        add(
          'IDENTITY_STEP_ORDER',
          `${j.name}:${st.line} 起的这一步有 ${hits.length} 条 ${ID_ROLE_LABEL[role]}（第 ${hits.map((h) => h.line).join(', ')} 行），判据不知道看哪一条`
        );
      }
    }
    const one = (role) => (roleAt[role].length === 1 ? roleAt[role][0] : null);
    const pre = one('preflight');
    const prod = one('producer');
    const cons = one('consumer');
    if (pre && prod && prod.idx < pre.idx) {
      add(
        'IDENTITY_STEP_ORDER',
        `${j.name}:${prod.line} 的 TAP 生产者排在 ${pre.line} 的 venv 预检之前 —— 生产者会先用一个没证明过的解释器跑出回执，预检就不再是前置条件`
      );
    }
    if (prod && cons && cons.idx < prod.idx) {
      add(
        'IDENTITY_STEP_ORDER',
        `${j.name}:${cons.line} 的 TAP 校验器排在 ${prod.line} 的生产者之前 —— 校验器读不到本步的回执（同机残留时会校验上一次的）`
      );
    }
    // 生产者写、消费者读必须是同一个绝对路径（⑧ 的 IDENTITY_TAP_UNBOUND 是同一件事的另一半）。
    const destOf = (roleHit, re) => (roleHit ? re.exec(stripShellComment(st.commands[roleHit.idx].text))?.[1] : undefined);
    const destProduced = destOf(prod, ID_PRODUCER_CMD);
    const destConsumed = destOf(cons, ID_CONSUMER_CMD);
    if (destProduced && destConsumed && destProduced !== destConsumed) {
      add(
        'IDENTITY_TAP_UNBOUND',
        `${j.name}: 生产者写「${destProduced}」，校验器读「${destConsumed}」—— 回执与校验没绑在同一个文件上`
      );
    }
  }

  return { findings };
}

/** 兼容旧用例：只要失败理由（字符串数组）。空数组 = 通过。 */
function auditStrictGates(text) {
  return auditGates(text).findings.map((f) => f.message);
}

const fail = (findings) => assert.deepEqual(findings, [], `严格档门禁不成立：\n- ${findings.join('\n- ')}`);

// ---------------------------------------------------------------------------
// 正控：真 ci.yml 必须过
// ---------------------------------------------------------------------------

test('真 ci.yml：三处严格档齐活（16 层 / 8 层 step-tower + 带内核的 eval:tasks）', () => {
  fail(auditStrictGates(CI_TEXT));
});

test('真 ci.yml：unit 里仍是「非严格」eval:tasks —— 严格档不许挪进无内核 job', () => {
  const { jobs } = parseWorkflow(CI_TEXT);
  const unit = jobs.get(NO_KERNEL_JOB);
  assert.ok(unit, `ci.yml 里找不到 ${NO_KERNEL_JOB} job`);
  const evalCmds = unit.steps.flatMap((st) => st.commands).filter((c) => isEvalCmd(c.text));
  assert.ok(evalCmds.length > 0, 'unit job 里没有 eval:tasks 了');
  for (const c of evalCmds) {
    assert.ok(!hasStrictToken(c.text), `unit:${c.line} 出现严格档：${c.text}`);
  }
});

// ---------------------------------------------------------------------------
// 对抗用例：守卫必须真的会红（每条都改文本，不碰磁盘）
// ---------------------------------------------------------------------------

/** 按行号范围删掉一段（1-based，含首含尾）。 */
function cutLines(text, fromLine, toLine) {
  const ls = text.split('\n');
  ls.splice(fromLine - 1, toLine - fromLine + 1);
  return ls.join('\n');
}

/** 在指定行（1-based）之前插入一段文本。 */
function insertBefore(text, line, block) {
  const ls = text.split('\n');
  ls.splice(line - 1, 0, ...block.split('\n'));
  return ls.join('\n');
}

const strictEvalStep = (text) => {
  const { jobList } = parseWorkflow(text);
  for (const j of jobList) {
    for (const st of j.steps) {
      if (st.commands.some((c) => isEvalCmd(c.text) && hasStrictToken(c.text))) return { job: j, step: st };
    }
  }
  throw new Error('夹具里没有严格档 eval:tasks 步骤');
};

const ftJob = (text) => {
  const job = parseWorkflow(text).jobs.get(FT_JOB);
  assert.ok(job, `夹具里找不到 ${FT_JOB} job`);
  return job;
};

/** 把 FT job 里第一条/第 N 条 verify:step-tower 的命令行整体替换。 */
function replaceTowerLine(text, from, to) {
  const mutated = text.replace(from, to);
  assert.ok(mutated !== text, `夹具没改动：找不到「${from}」`);
  return mutated;
}

/** 跑 identity-export.test.mjs 的那一条步骤（夹具定位用）。 */
function identityStep(text) {
  const job = ftJob(text);
  const st = job.steps.find((s) => s.commands.some((c) => isIdentityExportRun(c.text)));
  assert.ok(st, '夹具前提：featuretree-geometry 里应有跑 identity-export.test.mjs 的步骤');
  return st;
}

/** 整行替换（命中不了就直接失败，避免夹具静默失效让用例变绿）。 */
function replaceLine(text, from, to) {
  assert.ok(text.includes(from), `夹具没改动：找不到「${from.trim().slice(0, 60)}」`);
  return text.replace(from, to);
}

// ci.yml 里这条步骤的三个关键命令行（逐字复制，改动会被夹具断言挡住）
const ID_PRE_LINE = '          "$FT_PY" -c \'import build123d; print("IDENTITY_KERNEL_OK", build123d.__version__)\'';
const ID_PROD_LINE = '          AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-reporter=tap --test-reporter-destination=/tmp/identity-export.tap test/parametric/identity-export.test.mjs';
const ID_CONS_LINE = '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap';

// 变异体登记表：key 给单条用例用，也供「删掉 check → 用例变绿」的自检用。
const MUTATIONS = {
  dropStrict16: (t) => replaceTowerLine(t, /(npm run verify:step-tower -- --levels 16)(\s*--require-full)?/, '$1'),
  strictEqualsFalse: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full=false'
  ),
  strictSuffix: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full-checked'
  ),
  strictNegated: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --no-require-full'
  ),
  skipSwap: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --skip-if-no-kernel'
  ),
  orTrue: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full || true'
  ),
  orExit0: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full || exit 0'
  ),
  semicolonTrue: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full; true'
  ),
  stepIfFalse: (t) => {
    const job = ftJob(t);
    const gate = job.steps.find((st) => st.commands.some((c) => STEP_TOWER_CMD.test(c.text)));
    assert.ok(gate, '夹具前提：FT job 里应有 step-tower 步骤');
    return insertBefore(t, gate.line + 1, '        if: false');
  },
  stepIfFalseExpr: (t) => {
    const job = ftJob(t);
    const gate = job.steps.find((st) => st.commands.some((c) => STEP_TOWER_CMD.test(c.text)));
    assert.ok(gate, '夹具前提：FT job 里应有 step-tower 步骤');
    return insertBefore(t, gate.line + 1, '        if: ${{ false }}');
  },
  stepContinueOnError: (t) => {
    const job = ftJob(t);
    const gate = job.steps.find((st) => st.commands.some((c) => STEP_TOWER_CMD.test(c.text)));
    assert.ok(gate, '夹具前提：FT job 里应有 step-tower 步骤');
    return insertBefore(t, gate.line + 1, '        continue-on-error: true');
  },
  jobContinueOnError: (t) => {
    const job = ftJob(t);
    return insertBefore(t, job.line + 1, '    continue-on-error: true');
  },
  jobIfFalse: (t) => {
    const job = ftJob(t);
    return insertBefore(t, job.line + 1, '    if: false');
  },
  substitution: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full $(true)'
  ),
  backtickArgs: (t) => replaceTowerLine(
    t,
    'npm run verify:step-tower -- --levels 16 --require-full',
    'npm run verify:step-tower -- --levels 16 --require-full `echo 1`'
  ),
  deleteNegativeProof: (t) => {
    const job = ftJob(t);
    const neg = job.steps.find((st) => st.commands.some((c) => STEP_TOWER_SCRIPT.test(c.text)));
    assert.ok(neg, '夹具前提：ci.yml 里应有严格档负向自证步骤');
    return cutLines(t, neg.line, neg.endLine);
  },
  budgetDrift: (t) => {
    const mutated = t
      .replace('+ 严格档负向自证 5 ', '')
      .replace('= 97 min', '= 92 min');
    assert.ok(mutated !== t, '夹具前提：预算注释里应有「+ 严格档负向自证 5」与「= 97 min」');
    return mutated;
  },
  // 首跑事故（adm-zip）的两条变异：缺安装 / 安装顺序反了。
  // 两者都只改「job 的有效步骤」，不改注释 —— 守卫读的是步骤顺序，不是文本。
  deleteDepsInstall: (t) => {
    const job = ftJob(t);
    const st = job.steps.find((s) => s.commands.some((c) => isInstallCommand(c.text)));
    assert.ok(st, '夹具前提：featuretree-geometry 里应有 npm ci 安装步骤');
    return cutLines(t, st.line, st.endLine);
  },
  installAfterEval: (t) => {
    const job = ftJob(t);
    const st = job.steps.find((s) => s.commands.some((c) => isInstallCommand(c.text)));
    assert.ok(st, '夹具前提：featuretree-geometry 里应有 npm ci 安装步骤');
    const block = t.split('\n').slice(st.line - 1, st.endLine).join('\n');
    const cut = cutLines(t, st.line, st.endLine);
    // 行号在 cut 之后全变了：重新解析，把安装块插到严格评测步骤之后
    const evalStep = strictEvalStep(cut).step;
    return insertBefore(cut, evalStep.endLine + 1, block);
  },
  jobTimeoutLow: (t) => {
    const marker = `  ${FT_JOB}:`;
    const at = t.indexOf(marker);
    assert.ok(at > 0, '夹具前提：ci.yml 里有 featuretree-geometry job');
    const mutated = t.slice(0, at) + t.slice(at).replace(/(\n    timeout-minutes: )\d+(\n    steps:)/, '$140$2');
    assert.ok(mutated !== t, '夹具没改动：找不到 featuretree-geometry 的 job 级超时？');
    return mutated;
  },
  deleteKernelInstall: (t) => {
    const { job } = strictEvalStep(t);
    const installStep = job.steps.find((st) => st.commands.some((c) => /pip\s+install/.test(c.text) && /build123d/.test(c.text)));
    assert.ok(installStep, '夹具前提：featuretree job 里应有装 build123d 的步骤');
    return cutLines(t, installStep.line, installStep.endLine);
  },
  moveStrictToUnit: (t) => {
    const { step } = strictEvalStep(t);
    const block = t.split('\n').slice(step.line - 1, step.endLine).join('\n');
    return insertBefore(cutLines(t, step.line, step.endLine), parseWorkflow(t).jobs.get(NO_KERNEL_JOB).steps[0].line, block);
  },
  deleteStrictEvalStep: (t) => {
    const { step } = strictEvalStep(t);
    return cutLines(t, step.line, step.endLine);
  },
  // R13 / C2 + P1-3：真内核 identity-export 用例的回退与假绿形态
  //   ① 整步删掉（回到「CI 一处都不跑」）；
  //   ② venv 指向改掉（赌 runner 上有 build123d）；
  //   ③ 删掉校验器（node 写了 TAP 没人读）；
  //   ④ 校验器换成 `echo 'IDENTITY_TAP_OK'`（不读回执的假证据）；
  //   ⑤ 校验器换成上一版的 `grep -q 'ℹ skipped 0'`（被零执行击穿的那条）；
  //   ⑥ 生产者与消费者指向不同文件（校验器读上一次的回执）；
  //   ⑦ 加 `--test-name-pattern`（过滤到零条仍 exit 0）；
  //   ⑧ 删掉「venv 里真有内核」的前置证明（指错了会静默落到三级回退的别的 python）；
  //   ⑨ 把 `set -euo pipefail` 降级成 `set -o pipefail`；
  //   ⑩ 挪进无内核的 unit（方向错：把 PyPI 依赖压回主门禁）。
  deleteIdentityExportStep: (t) => {
    const job = ftJob(t);
    const st = job.steps.find((s) => s.commands.some((c) => isIdentityExportRun(c.text)));
    assert.ok(st, '夹具前提：featuretree-geometry 里应有跑 identity-export.test.mjs 的步骤');
    return cutLines(t, st.line, st.endLine);
  },
  identityExportNoKernel: (t) => {
    const from = '          FT_PY="$PWD/../.venv-ft/bin/python"\n';
    const mutated = t.replace(from, '          FT_PY="/usr/bin/python3"\n');
    assert.ok(mutated !== t, '夹具没改动：找不到 FT_PY 指向 .venv-ft 的那一行');
    return mutated;
  },
  identityTapNoVerifier: (t) => {
    const from = '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap\n';
    const mutated = t.replace(from, '');
    assert.ok(mutated !== t, '夹具没改动：找不到校验器那一行');
    return mutated;
  },
  identityTapEchoVerifier: (t) => {
    const from = '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap\n';
    const mutated = t.replace(from, "          echo 'IDENTITY_TAP_OK'\n");
    assert.ok(mutated !== t, '夹具没改动：找不到校验器那一行');
    return mutated;
  },
  identityTapGrepOldAssertion: (t) => {
    const from = '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap\n';
    const mutated = t.replace(from, "          grep -q 'ℹ skipped 0' /tmp/identity-export.log\n");
    assert.ok(mutated !== t, '夹具没改动：找不到校验器那一行');
    return mutated;
  },
  identityTapSplitFile: (t) => {
    const from = '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap\n';
    const mutated = t.replace(from, '          node scripts/verify-identity-export-tap.mjs /tmp/identity-export-old.tap\n');
    assert.ok(mutated !== t, '夹具没改动：找不到校验器那一行');
    return mutated;
  },
  identityTapFiltered: (t) => {
    const from = '          AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-reporter=tap';
    const mutated = t.replace(from, '          AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-name-pattern=ZZ_NOTHING_MATCHES --test-reporter=tap');
    assert.ok(mutated !== t, '夹具没改动：找不到身份用例的 node --test 行');
    return mutated;
  },
  identityTapNoKernelProof: (t) => {
    const ls = t.split('\n');
    const idx = ls.findIndex((l) => /\$FT_PY"\s+-c\s+'import build123d/.test(l));
    assert.ok(idx >= 0, '夹具没改动：找不到「venv 里真有内核」的前置证明那一行');
    ls.splice(idx, 1);
    return ls.join('\n');
  },
  identityTapBeforeInstall: (t) => {
    const job = ftJob(t);
    const st = job.steps.find((s) => s.commands.some((c) => isIdentityExportRun(c.text)));
    assert.ok(st, '夹具前提：featuretree-geometry 里应有跑 identity-export.test.mjs 的步骤');
    const npmStep = job.steps.find((s) => s.commands.some((c) => isInstallCommand(c.text)));
    assert.ok(npmStep && npmStep.line < st.line, '夹具前提：npm ci 原本在身份用例之前');
    const block = t.split('\n').slice(st.line - 1, st.endLine).join('\n');
    const cut = cutLines(t, st.line, st.endLine);
    return insertBefore(cut, npmStep.line, block);
  },
  identityTapWeakPipefail: (t) => {
    const from = '          set -euo pipefail\n';
    const mutated = t.replace(from, '          set -o pipefail\n');
    assert.ok(mutated !== t, '夹具没改动：找不到 set -euo pipefail');
    return mutated;
  },
  moveIdentityExportToUnit: (t) => {
    const job = ftJob(t);
    const st = job.steps.find((s) => s.commands.some((c) => isIdentityExportRun(c.text)));
    assert.ok(st, '夹具前提：featuretree-geometry 里应有跑 identity-export.test.mjs 的步骤');
    const block = t.split('\n').slice(st.line - 1, st.endLine).join('\n');
    const cut = cutLines(t, st.line, st.endLine);
    // 行号在 cut 之后全变了：重解析，插到 unit 的 npm ci **之后**（只留身份判据，
    // 不顺带触发 DEPS_ORDER —— 那条已由对抗⑳ 单独钉住）
    const unitJob = parseWorkflow(cut).jobs.get(NO_KERNEL_JOB);
    assert.ok(unitJob, '夹具前提：ci.yml 里有 unit job');
    const installStep = unitJob.steps.find((s) => s.commands.some((c) => isInstallCommand(c.text)));
    assert.ok(installStep, '夹具前提：unit 里应有 npm ci 步骤');
    return insertBefore(cut, installStep.endLine + 1, block);
  },
  // -------------------------------------------------------------------------
  // R13 复审 §4.2：新内核步骤的「禁用 / 吞码 / noop / 顺序」
  //
  // 这 12 条全部是**真实 ci.yml 文本**上的最小变异，跑的是同一份 auditGates；
  // 复审实测前 6 条里除 job 级那两条外全绿（new step 不在 ④ 的作用域内，
  // 且 preflight/生产者的判据是全文子串，行尾注释与恒假分支都能满足）。
  // -------------------------------------------------------------------------
  // ① 一 disable：step 级 continue-on-error
  identityStepContinueOnError: (t) => insertBefore(t, identityStep(t).line + 1, '        continue-on-error: true'),
  // ② 一 disable：step 级 if: false（含表达式写法、含 `- if: false` 首行写法）
  identityStepIfFalse: (t) => insertBefore(t, identityStep(t).line + 1, '        if: false'),
  identityStepIfFalseExpr: (t) => insertBefore(t, identityStep(t).line + 1, '        if: ${{ false }}'),
  identityStepIfFalseHead: (t) => replaceLine(
    t,
    '      - name: 内核 identity-export 用例（真跑 + TAP 回执结构校验）',
    '      - if: false\n        name: 内核 identity-export 用例（真跑 + TAP 回执结构校验）'
  ),
  // ③ 一 disable：job 级条件（对每个步骤都生效，包括这条内核步骤）
  identityJobIfFalse: (t) => insertBefore(t, ftJob(t).line + 1, '    if: ${{ false }}'),
  identityJobContinueOnError: (t) => insertBefore(t, ftJob(t).line + 1, '    continue-on-error: true'),
  // ④ preflight 被 noop 顶掉：`true # <真命令>` / `: # <真命令>`
  identityPreflightNoopTrue: (t) => replaceLine(t, ID_PRE_LINE, `          true # ${ID_PRE_LINE.trim()}`),
  identityPreflightNoopColon: (t) => replaceLine(t, ID_PRE_LINE, `          : # ${ID_PRE_LINE.trim()}`),
  // ⑤ preflight 被恒假分支包起来（单行 / 换行两种，都不许靠行内锚定假装执行）
  identityPreflightFalseInline: (t) => replaceLine(t, ID_PRE_LINE, `          if false; then ${ID_PRE_LINE.trim()}; fi`),
  identityPreflightFalseBlock: (t) => replaceLine(t, ID_PRE_LINE, `          if false; then\n${ID_PRE_LINE}\n          fi`),
  // ⑥ 生产者被 noop 顶掉（`true # <真命令>`：字符串里还写着 node --test …）
  identityProducerNoop: (t) => replaceLine(t, ID_PROD_LINE, `          true # ${ID_PROD_LINE.trim()}`),
  // ⑦ 生产者/消费者吞退出码
  identityProducerOrTrue: (t) => replaceLine(t, ID_PROD_LINE, `${ID_PROD_LINE} || true`),
  identityProducerSemicolonTrue: (t) => replaceLine(t, ID_PROD_LINE, `${ID_PROD_LINE}; true`),
  identityConsumerOrTrue: (t) => replaceLine(t, ID_CONS_LINE, `${ID_CONS_LINE} || true`),
  // ⑧ 顺序：校验器先于生产者 / preflight 后于生产者
  identityConsumerBeforeProducer: (t) => replaceLine(t, `${ID_PROD_LINE}\n${ID_CONS_LINE}`, `${ID_CONS_LINE}\n${ID_PROD_LINE}`),
  identityPreflightAfterProducer: (t) => replaceLine(t, `${ID_PRE_LINE}\n${ID_PROD_LINE}`, `${ID_PROD_LINE}\n${ID_PRE_LINE}`)
};

const codes = (text, opts) => auditGates(text, opts).findings.map((f) => f.code);
const messages = (text, opts) => auditGates(text, opts).findings.map((f) => f.message);

test('对抗①：删掉任一条 --require-full → 红，并点名 job/行号', () => {
  const mutated = MUTATIONS.dropStrict16(CI_TEXT);
  const findings = messages(mutated);
  assert.ok(findings.length > 0, '删掉 16 层的 --require-full 后守卫仍然绿：这条守卫是空转的');
  assert.ok(
    findings.some((f) => f.includes(FT_JOB) && /缺 --require-full/.test(f)),
    `失败理由没有点名 ${FT_JOB} 缺严格档：\n- ${findings.join('\n- ')}`
  );
});

test('对抗②：把严格档 eval:tasks 挪进无内核的 unit → 红，理由点名 unit', () => {
  const { job } = strictEvalStep(CI_TEXT);
  const moved = MUTATIONS.moveStrictToUnit(CI_TEXT);

  // 先确认「挪过去」之后解析器真的看见它在 unit 里（否则红得没有意义）
  const relocated = strictEvalStep(moved);
  assert.equal(relocated.job.name, NO_KERNEL_JOB, '移动夹具没把严格档放进 unit');

  const findings = messages(moved);
  assert.ok(findings.length > 0, '严格档挪进无内核 job 后守卫仍然绿');
  assert.ok(
    findings.some((f) => f.startsWith(NO_KERNEL_JOB) && /严格档不许在无内核 job/.test(f)),
    `失败理由没有说清「严格档不许在无内核 job 里跑」：\n- ${findings.join('\n- ')}`
  );
  assert.notEqual(job.name, NO_KERNEL_JOB);
});

test('对抗③：只写注释 # --require-full 不算证据 → 红', () => {
  // 步骤名/注释里都留着 --require-full，唯独 run 命令里没有
  const mutated = CI_TEXT
    .replace(/(npm run verify:step-tower -- --levels 16)(\s*--require-full)?/, '$1')
    .replace(/(npm run verify:step-tower -- --levels 8)(\s*--require-full)?/, '$1')
    .replace(/\n(\s*)npm run verify:step-tower/g, '\n$1# 严格档见注释 --require-full\n$1npm run verify:step-tower');
  assert.ok(mutated.includes('# 严格档见注释 --require-full'), '夹具没插入注释');
  const findings = messages(mutated);
  assert.ok(findings.length > 0, '注释里出现 --require-full 就让守卫变绿：守卫读的是文本不是命令');
  assert.ok(
    findings.filter((f) => /缺 --require-full/.test(f)).length >= 2,
    `两条 step-tower 都该因「缺严格档」被判红：\n- ${findings.join('\n- ')}`
  );
});

test('对抗④：删掉严格档 eval:tasks 整步 → 红（不许「删掉冒充保留」）', () => {
  const findings = messages(MUTATIONS.deleteStrictEvalStep(CI_TEXT));
  assert.ok(findings.some((f) => /找不到带 --require-full 的 eval:tasks/.test(f)), `删掉严格档后守卫仍然绿：\n- ${findings.join('\n- ')}`);
});

test('对抗⑤：严格档前没有 build123d 安装（内核前置被删）→ 红', () => {
  const findings = messages(MUTATIONS.deleteKernelInstall(CI_TEXT));
  assert.ok(
    findings.some((f) => /没有任何「安装 build123d」的步骤/.test(f)),
    `删掉装内核步骤后守卫仍然绿：\n- ${findings.join('\n- ')}`
  );
});

test('对抗⑥：严格档改用 --skip-if-no-kernel 换绿 → 红', () => {
  const findings = messages(MUTATIONS.skipSwap(CI_TEXT));
  assert.ok(findings.some((f) => /skip-if-no-kernel 换绿灯/.test(f)), `换成 skip 模式后守卫仍然绿：\n- ${findings.join('\n- ')}`);
});

test('对抗⑦：门禁步骤挂 || true → 红', () => {
  const findings = messages(MUTATIONS.orTrue(CI_TEXT));
  assert.ok(findings.some((f) => /\|\| true/.test(f)), `挂上 || true 后守卫仍然绿：\n- ${findings.join('\n- ')}`);
});

test('对抗⑧：job 超时压到步骤合计之下（预算与超时打架）→ 红', () => {
  // 历史上 60 < 62：最后一步在跑完断言前被掐断，「红但原因误导」。
  const findings = messages(MUTATIONS.jobTimeoutLow(CI_TEXT));
  assert.ok(findings.length > 0, 'job 超时小于步骤合计时守卫仍然绿');
  assert.ok(
    findings.some((f) => /job 超时 \d+ min < 预算合计/.test(f)),
    `失败理由没说清「job 超时会先掐断最后一步」：\n- ${findings.join('\n- ')}`
  );
});

// ---------------------------------------------------------------------------
// R10 review 新补的对抗用例（B1 / B2 / B3 / B4 / B5 + 负向自证 + 预算联动）
// ---------------------------------------------------------------------------

test('对抗⑨：--require-full=false（子串能过、脚本不认）→ 红，且单独点名「带值形式」', () => {
  const mutated = MUTATIONS.strictEqualsFalse(CI_TEXT);
  assert.ok(mutated.includes('--require-full=false'), '夹具没改动：没造出 =false 形式');
  const found = codes(mutated);
  assert.ok(found.includes('STRICT_FLAG_WEAK_FORM'), `带值形式没被单独判红：${found.join(', ')}`);
  assert.ok(!messages(mutated).some((f) => f.includes('缺 --require-full') && f.includes('levels 16')), '带值形式不该只报「缺」——要指出它看着像给了');
});

test('对抗⑩：--no-require-full（取反形式）→ 红', () => {
  const found = codes(MUTATIONS.strictNegated(CI_TEXT));
  assert.ok(found.includes('STRICT_FLAG_WEAK_FORM'), `取反形式没被判红：${found.join(', ')}`);
});

test('对抗⑱：--require-full-checked（同名不同 token，子串判定会放过）→ 红', () => {
  // 这条专门钉「token 精确」而不是「子串包含」：脚本 args.includes('--require-full')
  // 不认 --require-full-checked，但 `text.includes('--require-full')` 会认 —— 正是 review B1 的形态。
  const mutated = MUTATIONS.strictSuffix(CI_TEXT);
  assert.ok(mutated.includes('--require-full-checked'));
  const findings = messages(mutated);
  assert.ok(
    findings.some((f) => /缺 --require-full/.test(f) && f.includes('levels 16')),
    `同名不同 token 没被判红（说明判据还是子串）：\n- ${findings.join('\n- ')}`
  );
});

test('对抗⑪：job 级 continue-on-error: true（4 空格，整 job 不阻塞）→ 红', () => {
  const mutated = MUTATIONS.jobContinueOnError(CI_TEXT);
  const job = ftJob(mutated);
  // 夹具自检：这一行真的是 job 级（4 空格，落在 job 头与第一个 step 之间）
  const line = job.lines.find((r) => /^ {4}continue-on-error: true$/.test(r.text));
  assert.ok(line, '夹具没把 continue-on-error 插到 job 级（4 空格）');
  const found = codes(mutated);
  assert.ok(found.includes('JOB_CONTINUE_ON_ERROR'), `job 级 continue-on-error 没判红：${found.join(', ')}`);
});

test('对抗⑫：job 级 / step 级 if: false 与 ${{ false }}（步骤永不存在）→ 红', () => {
  for (const [name, mutate] of [
    ['step if: false', MUTATIONS.stepIfFalse],
    ['step if: ${{ false }}', MUTATIONS.stepIfFalseExpr],
    ['job if: false', MUTATIONS.jobIfFalse]
  ]) {
    const found = codes(mutate(CI_TEXT));
    assert.ok(
      found.includes('STEP_IF_FALSE') || found.includes('JOB_IF_FALSE'),
      `${name} 没判红：${found.join(', ')}`
    );
  }
});

test('对抗⑬：step 级 continue-on-error: true（8 空格）→ 红', () => {
  const found = codes(MUTATIONS.stepContinueOnError(CI_TEXT));
  assert.ok(found.includes('STEP_CONTINUE_ON_ERROR'), `step 级 continue-on-error 没判红：${found.join(', ')}`);
});

test('对抗⑭：|| exit 0 与 ; true（比 || true 更常见）→ 红', () => {
  for (const [name, mutate, label] of [
    ['|| exit 0', MUTATIONS.orExit0, /\|\| exit 0/],
    ['; true', MUTATIONS.semicolonTrue, /; true/]
  ]) {
    const findings = messages(mutate(CI_TEXT));
    assert.ok(findings.some((f) => label.test(f)), `${name} 没判红：\n- ${findings.join('\n- ')}`);
  }
});

test('对抗⑮：命令替换 / 反引号（形状之外）→ 红，理由说「不做 shell 解释」', () => {
  for (const [name, mutate] of [['$(true)', MUTATIONS.substitution], ['`echo 1`', MUTATIONS.backtickArgs]]) {
    const findings = messages(mutate(CI_TEXT));
    assert.ok(
      findings.some((f) => /不在允许形状内/.test(f)),
      `${name} 没被判红：\n- ${findings.join('\n- ')}`
    );
  }
});

test('对抗⑯：删掉严格档负向自证步骤 → 红（严格档只剩「有内核时绿」）', () => {
  const found = codes(MUTATIONS.deleteNegativeProof(CI_TEXT));
  assert.ok(found.includes('NEG_SELFPROOF_MISSING'), `删掉负向自证后守卫仍然绿：${found.join(', ')}`);
});

test('对抗⑰：预算注释退回旧口径（新 step 没进预算）→ 红', () => {
  const found = codes(MUTATIONS.budgetDrift(CI_TEXT));
  assert.ok(found.includes('BUDGET_ITEM_MISSING'), `加了 step 却不同步预算，守卫没红：${found.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 首跑事故（R10 之后第一次跑 CI）：严格档红了，但不是断言红
//
// featuretree-geometry 只装了 build123d，没有 npm ci，eval:tasks 一 import
// desktop/src/shared/zip.ts 就 `Cannot find package 'adm-zip'`。两条对抗用例分别钉住
// 「没装依赖」与「装得太晚」—— 判据取自 job 的有效步骤顺序，不是文本子串。
// ---------------------------------------------------------------------------

test('对抗⑲：门禁 job 没装 node 依赖（只装内核）→ 红，点名缺 npm ci', () => {
  const mutated = MUTATIONS.deleteDepsInstall(CI_TEXT);
  // 夹具自检：解析器真的看不见安装步骤了（注释里若还留着 npm ci 也不许顶替）
  const job = ftJob(mutated);
  assert.ok(
    !job.steps.some((st) => st.commands.some((c) => isInstallCommand(c.text))),
    '夹具没删掉安装步骤，下面的断言就没有意义'
  );
  const findings = messages(mutated);
  assert.ok(
    findings.some((f) => f.startsWith(FT_JOB) && /没有 npm ci \/ npm install/.test(f)),
    `缺 npm ci 没被判红（或没点名 job）：\n- ${findings.join('\n- ')}`
  );
});

test('对抗⑳：安装依赖排在严格评测之后 → 红（判执行顺序，不看子串）', () => {
  const mutated = MUTATIONS.installAfterEval(CI_TEXT);
  const { job, step: evalStep } = strictEvalStep(mutated);
  const installIdx = job.steps.findIndex((st) => st.commands.some((c) => isInstallCommand(c.text)));
  const evalIdx = job.steps.indexOf(evalStep);
  // 夹具自检：「npm ci」这段文本还在、步骤也在，只有顺序变了 —— 正是子串判据抓不到的形态
  assert.ok(installIdx >= 0, '夹具把安装步骤挪丢了');
  assert.ok(evalIdx >= 0 && evalIdx < installIdx, `夹具没把安装挪到评测之后（eval=${evalIdx}, install=${installIdx}）`);
  const found = codes(mutated);
  assert.ok(
    found.includes('DEPS_ORDER'),
    `装在评测之后没被判红（说明判据是子串不是顺序）：${found.join(', ')}`
  );
  assert.ok(!found.includes('DEPS_INSTALL_MISSING'), '安装步骤还在，不该报「缺依赖」——这条用例要的是顺序判据');
});

// ---------------------------------------------------------------------------
// R13 / C2：真内核 identity-export 用例（unit 里恒 SKIP，别再让它「一处都不跑」）
//
// 事故形态（CI run 44558824879 实测）：unit job 日志里 `# 内核不可用：…身份导出未验证`、
// `ℹ skipped 9`；而唯一装了 build123d 的 featuretree-geometry 里**没有任何 node --test 步骤**
// → test/parametric/identity-export.test.mjs 的真内核用例在 CI 一处都没跑。
// 两条守卫：⑧ FT 必须真跑，回执走独立 TAP 文件并由 scripts/verify-identity-export-tap.mjs
// 解析（P1-3：旧的 `skipped 0` 断言被 echo 伪造与「过滤到零条」两条实测击穿）；⑨ unit 里不许出现该文件名。
// 两条都**不**断言用例条数 —— 用例会继续加（R13 包 B 就在加），数目是那把尺子自己的事。
// ---------------------------------------------------------------------------

test('守卫⑧：FT job 必须真跑 identity-export.test.mjs，回执走独立 TAP 并由校验器解析', () => {
  // 正控：真 ci.yml 里这一条必须成立
  const { jobs } = parseWorkflow(CI_TEXT);
  const steps = jobs.get(FT_JOB).steps.filter((st) => st.commands.some((c) => isIdentityExportRun(c.text)));
  assert.equal(steps.length, 1, `真 ci.yml 里 ${FT_JOB} 应正好有 1 条跑 ${IDENTITY_EXPORT_FILE} 的步骤（实际 ${steps.length} 条）`);
  const st = steps[0];
  const run = st.commands.find((c) => isIdentityExportRun(c.text));
  // producer：结构化回执写进独立文件
  assert.match(run.text, TAP_REPORTER_RE, '这一步没开 --test-reporter=tap：回执只能是结构化 TAP，不能是给人看的日志');
  const dest = TAP_DEST_RE.exec(run.text)?.[1];
  assert.ok(dest, `这一步没有 --test-reporter-destination=<独立文件>：${run.text}`);
  assert.ok(dest.startsWith('/'), `TAP 输出路径应是绝对路径（实际「${dest}」）`);
  // consumer：校验器读的是**同一个**文件
  const verifier = st.commands.find((c) => IDENTITY_VERIFIER_RE.test(c.text));
  assert.ok(verifier, `这一步没有跑 ${IDENTITY_VERIFIER}：写了 TAP 却没人校验`);
  assert.equal(IDENTITY_VERIFIER_RE.exec(verifier.text)[1], dest, '生产者与消费者指向的不是同一个文件');
  // venv 自证 + 严失败
  assert.ok(st.commands.some((c) => /^set -euo pipefail$/.test(c.text)), '缺 set -euo pipefail');
  assert.ok(
    st.commands.some((c) => /"\$FT_PY"\s+-c\s+['"][^'"]*import build123d/.test(c.text)),
    '缺「venv 里真有 build123d」的前置证明：用例文件有三级回退，指错了会静默落到别处'
  );
  assert.equal(st.timeoutMinutes, 5, '这一步的 timeout-minutes 应为 5（预算注释里的条目靠它对账）');
  // 过滤参数与「拿文本当证据」都不许出现在这一步
  for (const c of st.commands) {
    for (const flag of FILTER_FLAGS) {
      assert.ok(!flag.re.test(c.text), `这一步带了 ${flag.label}：过滤到零条时 node 仍 exit 0`);
    }
    for (const fake of FAKE_PROOF_RES) {
      assert.ok(!fake.re.test(c.text), `这一步出现${fake.label}：回执只能来自 TAP 解析器`);
    }
  }
  // 校验器本身必须真实存在（不是 ci.yml 里写了个不存在的脚本）
  assert.ok(
    existsSync(new URL('../../scripts/verify-identity-export-tap.mjs', import.meta.url)),
    'scripts/verify-identity-export-tap.mjs 不存在'
  );

  // 对抗：每一种回退 / 假绿都必须判红，且红因点名对应的判据
  for (const [name, mutate, code] of [
    ['整步删掉', MUTATIONS.deleteIdentityExportStep, 'FT_IDENTITY_EXPORT_MISSING'],
    ['venv 指向改成 runner 的 python3', MUTATIONS.identityExportNoKernel, 'FT_IDENTITY_EXPORT_MISSING'],
    ['删掉 TAP 校验器', MUTATIONS.identityTapNoVerifier, 'FT_IDENTITY_EXPORT_MISSING'],
    ['校验器换成 echo', MUTATIONS.identityTapEchoVerifier, 'IDENTITY_TAP_FAKE_PROOF'],
    ['校验器退回 grep skipped 0', MUTATIONS.identityTapGrepOldAssertion, 'IDENTITY_TAP_FAKE_PROOF'],
    ['生产者/消费者指向不同文件', MUTATIONS.identityTapSplitFile, 'IDENTITY_TAP_UNBOUND'],
    ['加 --test-name-pattern', MUTATIONS.identityTapFiltered, 'IDENTITY_TAP_FILTER_FORBIDDEN'],
    ['删掉 venv 内核前置证明', MUTATIONS.identityTapNoKernelProof, 'FT_IDENTITY_EXPORT_MISSING'],
    ['set -euo pipefail 降级', MUTATIONS.identityTapWeakPipefail, 'FT_IDENTITY_EXPORT_MISSING'],
    ['挪到 npm ci 之前', MUTATIONS.identityTapBeforeInstall, 'FT_IDENTITY_EXPORT_MISSING']
  ]) {
    const mutated = mutate(CI_TEXT);
    const found = codes(mutated);
    assert.ok(found.includes(code), `${name} 没被判红 ${code}（实际 ${found.join(', ')}）`);
  }
});

test('守卫⑨：unit（无内核）里不许出现 identity-export.test.mjs 文件名', () => {
  const m = codes(MUTATIONS.moveIdentityExportToUnit(CI_TEXT));
  assert.ok(m.includes('UNIT_IDENTITY_EXPORT_FORBIDDEN'), `挪进 unit 没被判红：${m.join(', ')}`);
  assert.ok(m.includes('FT_IDENTITY_EXPORT_MISSING'), `挪走之后 FT 那边也没被判红：${m.join(', ')}`);
  // 反向对照组：真 ci.yml 的 unit 里既没有这个文件名，也没有因为这个报红
  const unitCmds = parseWorkflow(CI_TEXT).jobs.get(NO_KERNEL_JOB).steps.flatMap((s) => s.commands);
  assert.equal(unitCmds.filter((c) => c.text.includes(IDENTITY_EXPORT_FILE)).length, 0, 'unit 里出现了 identity-export.test.mjs');
  assert.ok(!codes(CI_TEXT).includes('UNIT_IDENTITY_EXPORT_FORBIDDEN'), '真 ci.yml 的 unit 被判红了');
});

// ---------------------------------------------------------------------------
// R13 复审 §4.2：新内核步骤的「禁用 / 吞码 / noop / 顺序」
//
// 复审用未改动的 auditGates 对真 ci.yml 做变异，实测四个绿：
//   · step 级 `continue-on-error: true`（失败不阻塞 → job 绿、内核零证据）
//   · step 级 `if: false`（这一步永不执行）
//   · preflight 被 `true # <真命令>` / `: # …` / `if false; then …; fi` 满足
//   · 生产者被 `true # <真命令>` 顶掉（注释里还写着 node --test …）
// 根因是 ④ 的判据只绑 `isToolCmd`，新步骤不在作用域内；且命令判据是全文子串。
// ⑩ 用「契约形状 + 严格顺序」补上，并把 `continue-on-error`/`if`/`MASKED_EXIT`
// 的扫描对象扩到这条步骤（含 job 级继承）。下面每条都是一次真实文本变异。
// 用例条数不钉（B 还在加用例），只钉「这一步必须真跑且不被一键禁用」。
// ---------------------------------------------------------------------------

/** 这 16 条反例：每条都必须判红，且红因点名 job。 */
const IDENTITY_STEP_COUNTEREXAMPLES = [
  'identityStepContinueOnError',
  'identityStepIfFalse',
  'identityStepIfFalseExpr',
  'identityStepIfFalseHead',
  'identityJobIfFalse',
  'identityJobContinueOnError',
  'identityPreflightNoopTrue',
  'identityPreflightNoopColon',
  'identityPreflightFalseInline',
  'identityPreflightFalseBlock',
  'identityProducerNoop',
  'identityProducerOrTrue',
  'identityProducerSemicolonTrue',
  'identityConsumerOrTrue',
  'identityConsumerBeforeProducer',
  'identityPreflightAfterProducer'
];

test('守卫⑩：内核 identity 步骤不可被一键禁用 / 不可被 noop 冒充 / 顺序不可反 → 16 条反例全红', () => {
  // 正控一：真 ci.yml 上一条 finding 都没有（⑩ 不是把正常写法判红）
  assert.deepEqual(codes(CI_TEXT), [], '真 ci.yml 被判红了');
  const st = identityStep(CI_TEXT);
  for (const c of st.commands) {
    const bare = stripShellComment(c.text);
    assert.ok(
      ID_STEP_SHAPES.some((s) => s.re.test(bare)),
      `真 ci.yml 的 \`${c.text}\` 不在这一步的契约形状内（形状写得过窄会把正确写法判红）`
    );
  }

  // 正控二：引号内的 Python 分号与 `#` 不许被误杀（`;` 是 shell 分隔符，但引号内不是）
  const pyLine = `"$FT_PY" -c 'import build123d; print("a # b; c")'`;
  assert.equal(stripShellComment(pyLine), pyLine, 'stripShellComment 切掉了引号内的 `#`');
  assert.ok(ID_PREFLIGHT_CMD.test(pyLine), '预检形状把带 Python 分号的合法行判红了');
  assert.equal(stripShellComment('true # node --test x'), 'true', '行尾注释没被剥掉');
  assert.ok(!ID_PRODUCER_CMD.test(stripShellComment(`true # ${ID_PROD_LINE.trim()}`)), '带注释的 noop 仍满足了生产者形状');

  // 反例：逐个变异必须判红，红因点名 job，且判据集合与 LOAD_BEARING 登记一致
  for (const name of IDENTITY_STEP_COUNTEREXAMPLES) {
    const entry = LOAD_BEARING.find((e) => e.mutation === name);
    assert.ok(entry, `${name} 没登记进 LOAD_BEARING`);
    const mutated = MUTATIONS[name](CI_TEXT);
    const found = codes(mutated);
    const msgs = messages(mutated);
    assert.ok(found.length > 0, `${name}：守卫仍然绿 —— 这正是复审实测的假绿形态`);
    for (const code of entry.codes) {
      assert.ok(found.includes(code), `${name}：没判红 ${code}（实际判据 [${[...new Set(found)].join(', ')}]）`);
    }
    assert.ok(
      msgs.some((m) => m.includes(FT_JOB)),
      `${name}：红因没有点名 ${FT_JOB}：\n- ${msgs.join('\n- ')}`
    );
  }
});

test('守卫⑩（job 级继承）：内核步骤落在没有 npm 门禁的 job 里，job 级 if/continue-on-error 同样判红', () => {
  // ④ 只在「有 npm 门禁步骤」的 job 里查 job 级 if / continue-on-error；⑩ 的对象是
  // 「跑内核用例的步骤」，所以即使那个 job 里一条 verify:step-tower 都没有，也必须判红。
  const stub = (extraJobKey, extraStepKey) => `jobs:
  ${FT_JOB}:
    runs-on: ubuntu-latest
${extraJobKey}
    steps:
      - name: 内核 identity-export 用例（真跑 + TAP 回执结构校验）
${extraStepKey}
        timeout-minutes: 5
        run: |
          cd desktop
          set -euo pipefail
          FT_PY="$PWD/../.venv-ft/bin/python"
          "$FT_PY" -c 'import build123d'
          AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-reporter=tap --test-reporter-destination=/tmp/identity-export.tap test/parametric/identity-export.test.mjs
          node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap
`;

  // 正控：这条 job 里没有任何 npm 门禁步骤，⑩ 也该认这条步骤且不误报
  const clean = codes(stub('', ''));
  for (const c of ['JOB_IF_FALSE', 'JOB_CONTINUE_ON_ERROR', 'STEP_IF_FALSE', 'STEP_CONTINUE_ON_ERROR', 'IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT']) {
    assert.ok(!clean.includes(c), `干净夹具被判红 ${c}：${clean.join(', ')}`);
  }

  for (const [name, extraJob, extraStep, want] of [
    ['job if: false', '    if: false', '', 'JOB_IF_FALSE'],
    ['job if: ${{ false }}', '    if: ${{ false }}', '', 'JOB_IF_FALSE'],
    ['job continue-on-error: true', '    continue-on-error: true', '', 'JOB_CONTINUE_ON_ERROR'],
    ['step if: false', '', '        if: false', 'STEP_IF_FALSE'],
    ['step continue-on-error: true', '', '        continue-on-error: true', 'STEP_CONTINUE_ON_ERROR']
  ]) {
    const found = codes(stub(extraJob, extraStep));
    assert.ok(found.includes(want), `${name}（该 job 无 npm 门禁步骤）没判红 ${want}：${found.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// 守卫自检：每条判据都是 load-bearing（删掉它，对应的变异就会变绿 → 这里红）
//
// 这是「删除守卫必红」的可执行证据：不是断言注释里写了什么，而是断言
// 「关掉这条 check，配对的那条变异就不再被判红」—— 说明红是它判的，不是别处顺手判的。
// ---------------------------------------------------------------------------
// 每条变异**只由这些判据**判红（集合相等，多一条少一条都会让自检红）：
// 这是「删掉判据 → 配对的对抗用例必红」的可执行证据 —— 关掉这个集合，变异就完全变绿。
// 一条变异挂两个 code 的地方是刻意的双保险（吞退出码既能被 mask 判据抓到、也逃不过
// 规范形状判据），但两边都删才会真变绿，所以必须成组登记。
const LOAD_BEARING = [
  { mutation: 'dropStrict16', codes: ['STRICT_FLAG_MISSING'] },
  { mutation: 'strictSuffix', codes: ['STRICT_FLAG_MISSING'] },
  { mutation: 'strictNegated', codes: ['STRICT_FLAG_WEAK_FORM'] },
  { mutation: 'strictEqualsFalse', codes: ['STRICT_FLAG_WEAK_FORM', 'NON_CANONICAL_SHAPE'] },
  { mutation: 'skipSwap', codes: ['SKIP_SWAP', 'STRICT_FLAG_MISSING'] },
  { mutation: 'orTrue', codes: ['MASKED_EXIT', 'NON_CANONICAL_SHAPE'] },
  { mutation: 'orExit0', codes: ['MASKED_EXIT', 'NON_CANONICAL_SHAPE'] },
  { mutation: 'semicolonTrue', codes: ['MASKED_EXIT', 'NON_CANONICAL_SHAPE'] },
  { mutation: 'substitution', codes: ['NON_CANONICAL_SHAPE'] },
  { mutation: 'backtickArgs', codes: ['NON_CANONICAL_SHAPE'] },
  { mutation: 'stepIfFalse', codes: ['STEP_IF_FALSE'] },
  { mutation: 'stepIfFalseExpr', codes: ['STEP_IF_FALSE'] },
  { mutation: 'jobIfFalse', codes: ['JOB_IF_FALSE'] },
  { mutation: 'stepContinueOnError', codes: ['STEP_CONTINUE_ON_ERROR'] },
  { mutation: 'jobContinueOnError', codes: ['JOB_CONTINUE_ON_ERROR'] },
  { mutation: 'deleteNegativeProof', codes: ['NEG_SELFPROOF_MISSING'] },
  { mutation: 'budgetDrift', codes: ['BUDGET_ITEM_MISSING'] },
  { mutation: 'jobTimeoutLow', codes: ['JOB_TIMEOUT_LOW'] },
  // 这三条现在还会连带触发 ⑧ 的前置顺序判据（身份用例排在 npm ci / 装内核之后）：
  // 删掉安装步骤、或把安装挪到评测之后，身份用例同样会变成「跑的时候还没有 node_modules/内核」。
  { mutation: 'deleteDepsInstall', codes: ['DEPS_INSTALL_MISSING', 'FT_IDENTITY_EXPORT_MISSING'] },
  { mutation: 'installAfterEval', codes: ['DEPS_ORDER', 'FT_IDENTITY_EXPORT_MISSING'] },
  { mutation: 'deleteKernelInstall', codes: ['KERNEL_PRECEDES', 'FT_IDENTITY_EXPORT_MISSING'] },
  // 挪进 unit 时插在最前面（checkout 之前），于是顺带触发「安装依赖排在门禁之后」—— 第三码是真实发现，不是噪声
  { mutation: 'moveStrictToUnit', codes: ['UNIT_STRICT_FORBIDDEN', 'KERNEL_PRECEDES', 'DEPS_ORDER'] },
  { mutation: 'deleteStrictEvalStep', codes: ['STRICT_EVAL_MISSING'] },
  // R13 / C2 + P1-3：真内核用例的守卫⑧⑨（删掉对应判据，这些变异必须完全变绿）
  { mutation: 'deleteIdentityExportStep', codes: ['FT_IDENTITY_EXPORT_MISSING'] },
  // 下面几条除 ⑧ 的形态判据外，还会被 ⑩ 的契约形状/顺序判据抓到（这正是加固点：
  // 「改掉这一行」「删掉这一行」「拿 noop 顶掉这一行」都判红，且两条判据各自独立成立）
  { mutation: 'identityExportNoKernel', codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_NOOP'] },
  { mutation: 'identityTapNoVerifier', codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_ORDER'] },
  { mutation: 'identityTapNoKernelProof', codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_ORDER'] },
  { mutation: 'identityTapWeakPipefail', codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_NOOP'] },
  { mutation: 'identityTapBeforeInstall', codes: ['FT_IDENTITY_EXPORT_MISSING'] },
  {
    mutation: 'identityTapEchoVerifier',
    codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'IDENTITY_TAP_FAKE_PROOF']
  },
  {
    mutation: 'identityTapGrepOldAssertion',
    codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'IDENTITY_TAP_FAKE_PROOF']
  },
  { mutation: 'identityTapSplitFile', codes: ['IDENTITY_TAP_UNBOUND'] },
  {
    mutation: 'identityTapFiltered',
    codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'IDENTITY_TAP_FILTER_FORBIDDEN']
  },
  { mutation: 'moveIdentityExportToUnit', codes: ['FT_IDENTITY_EXPORT_MISSING', 'UNIT_IDENTITY_EXPORT_FORBIDDEN'] },
  // R13 复审 §4.2 的四个实测绿 + 同族形态：⑩ 的「禁用 / 吞码 / noop / 顺序」判据逐个撑住
  // 一条变异（关掉该集合 → 完全变绿，见自检）。
  { mutation: 'identityStepContinueOnError', codes: ['STEP_CONTINUE_ON_ERROR'] },
  { mutation: 'identityStepIfFalse', codes: ['STEP_IF_FALSE'] },
  { mutation: 'identityStepIfFalseExpr', codes: ['STEP_IF_FALSE'] },
  { mutation: 'identityStepIfFalseHead', codes: ['STEP_IF_FALSE'] },
  { mutation: 'identityJobIfFalse', codes: ['JOB_IF_FALSE'] },
  { mutation: 'identityJobContinueOnError', codes: ['JOB_CONTINUE_ON_ERROR'] },
  // `true # <真命令>` / `: # <真命令>`：注释里还写着真命令，实际什么都不跑
  { mutation: 'identityPreflightNoopTrue', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT'] },
  { mutation: 'identityPreflightNoopColon', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT'] },
  // 恒假分支：单行时预检形状也一起消失；换行块时真命令行还在，靠「控制语句不在契约形状内」判红
  { mutation: 'identityPreflightFalseInline', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER'] },
  { mutation: 'identityPreflightFalseBlock', codes: ['IDENTITY_STEP_NOOP'] },
  { mutation: 'identityProducerNoop', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT'] },
  { mutation: 'identityProducerOrTrue', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT'] },
  { mutation: 'identityProducerSemicolonTrue', codes: ['IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT'] },
  {
    mutation: 'identityConsumerOrTrue',
    codes: ['FT_IDENTITY_EXPORT_MISSING', 'IDENTITY_STEP_NOOP', 'IDENTITY_STEP_ORDER', 'MASKED_EXIT']
  },
  { mutation: 'identityConsumerBeforeProducer', codes: ['IDENTITY_STEP_ORDER'] },
  { mutation: 'identityPreflightAfterProducer', codes: ['IDENTITY_STEP_ORDER'] }
];

test('守卫自检：每条判据都 load-bearing（删掉它 → 配对的变异完全变绿 → 这条自检红）', () => {
  const dead = [];
  for (const { mutation, codes: expected } of LOAD_BEARING) {
    const mutated = MUTATIONS[mutation](CI_TEXT);
    const actual = [...new Set(codes(mutated))].sort();
    const want = [...new Set(expected)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      dead.push(`${mutation}: 判据集合是 [${actual.join(', ')}]，登记的是 [${want.join(', ')}] —— 要么配对用例不再是这条 check 判的，要么多出一条没登记的兜底`);
      continue;
    }
    // 关键断言：把登记的判据全部关掉，这条变异必须**完全不红**。
    // 如果还红，说明顶上还有别的判据在保它 —— 那「删掉这条 check 必红」这句话就不成立。
    const left = auditGates(mutated, { disable: want }).findings;
    if (left.length > 0) {
      dead.push(`${mutation}: 关掉 [${want.join(', ')}] 后仍有 ${left.length} 条判红（${[...new Set(left.map((f) => f.code))].join(', ')}）—— 配对用例不是这条 check 撑住的`);
    }
  }
  assert.deepEqual(dead, [], `有判据不 load-bearing：\n- ${dead.join('\n- ')}`);
});
