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
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  { re: /(?:^|[;&])\s*(?:true|:)\s*(?:$|[;&#])/, label: '; true' },
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
  }
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
  { mutation: 'deleteDepsInstall', codes: ['DEPS_INSTALL_MISSING'] },
  { mutation: 'installAfterEval', codes: ['DEPS_ORDER'] },
  { mutation: 'deleteKernelInstall', codes: ['KERNEL_PRECEDES'] },
  // 挪进 unit 时插在最前面（checkout 之前），于是顺带触发「安装依赖排在门禁之后」—— 第三码是真实发现，不是噪声
  { mutation: 'moveStrictToUnit', codes: ['UNIT_STRICT_FORBIDDEN', 'KERNEL_PRECEDES', 'DEPS_ORDER'] },
  { mutation: 'deleteStrictEvalStep', codes: ['STRICT_EVAL_MISSING'] }
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
