# R13：口径分层 / 件号源标识保真 / 真内核用例进 CI

> 范围固定为 **A1 + B①② + C2**（总管裁定，见 §7 合同索引）。
> **本机终验已过**：同一棵树、串行实跑，日志 `scratch/cad-r13-final/final-*`（`tsc` exit 0、定向 237/237、focused 431/431、全量 3834/3831/3 skip/0 fail）。
> **独立窄复核通过**（只读、不参与整改，证据 `scratch/cad-r13-final-review.md`）；最终推送与同 SHA CI 按仓库外回执认定，不预写。
> 交付 SHA / 推送 / CI 以 Git 与仓库外 readback 为准，本文不写「未提交未推送」当永久结论，也不预写成功。
> 一页回执 → [R13-ACCEPTANCE.md](R13-ACCEPTANCE.md)；下一步 → [`HANDOFF-NEXT-SESSION.md`](../../HANDOFF-NEXT-SESSION.md)。

## 0. 一句话现状

- **能力侧**：A 把「本机 8 层」与「塔产品 16 位」拆成两个具名作用域（`modelClaim` / `productClaim`），`productClaim.aligned` 恒 `false`；B 让件号在默认路径**原文**透传、在 `identityStep:true` 严格路径对填充/非法/重号早拒并点名 `instances[i]`，五个真实导出失败点统一 400 + 无 files + 清目录；C 把 6 条真内核用例挪进 FT job，用**独立 TAP 文件 + 结构校验器**取代 `grep 'skipped 0'`。
- **收口侧**：A、B、C 的 TAP 解析器独立复审通过；C 的**守卫**首轮被打回（不能鉴别 step 级 `continue-on-error` / `if:false` / 行尾注释 noop），C2 单文件整改后 16 条原反例**全红**、50 条变异全红、定向 39/39 复验（`c2-parent-check.log`）；最终独立窄复核**通过**。
- **本机终验是绿的，但首轮不是**：首轮全量 3812 / 3808 pass / 3 skip / **1 fail**（性能比 5.01x）。那次失败**原样保留**在案；最终绿只说明**未再现**，不给根因，也不写成「已修复性能问题」（§4.3）。

## 1. 能力合同

### 1.1 A｜口径分层（A1）

`desktop/scripts/pv-buffer-regenerate.mjs`

| 字段 | 合同 |
|---|---|
| `modelClaim` | `{slots:8, aligned:true\|false\|null, source:'project-parts'}`；`slots = slotsFromLayers(params.layers)`，来源是**请求参数 `params.layers`**（CLI `--layers`），**不来自几何派生、也不来自件表**。`--levels` 是 `verify:step-tower` 的参数，不是本脚本的声明源，两者不可混写 |
| `productClaim` | `{slots:16, aligned:false, basis:'cross-model-unverified', crossModelEquality:<bool\|null>, coveredBy:'verify:step-tower --levels 16', saveReloadCovered:false}` |
| `aligned` | `productClaim.aligned` **恒 false**（跨机型比较永不给 true：数值恰好相等 ≠ 塔已对齐/已覆盖）。**这不等于「所有 aligned 都是 false」**：`modelClaim.aligned` 在几何派生值 == 参数声明时为 `true`，本机 8 层实跑就是 `true` |
| `crossModelEquality` | 信息位：`fromGeometry === productSlots` 的派生值，`derived` 时 `false`、几何量不出来时 `null`。**它不作塔的可行性/覆盖门禁，也不翻转退出码**；但 `disk.slots.scopeSplit` 会核对它**必须等于派生值**（写死常量即红）→ 正确口径是「不参与塔的可行性判定，参与作用域自洽性检查」，不能写成「完全不参与任何判据」 |
| `saveReloadCovered` | 固定 `false`。塔**不在** regen 存取路径上，这是**登记**，不是覆盖 |
| 门禁口径 | `disk.slots.modelClaimAligned` 判 `slots.ok === true && modelClaim.aligned === true`（P2-1：补偿错层时乘积仍 8，必须靠 `slots.ok` 自己变红，不许搭兄弟检查的便车） |
| 兼容 | 旧 `slots.aligned` / `slots.claimed` 原样保留，口径说明放 `detail.legacyAlignedScope` |
| 计数 | regen 检查 **61 → 64**（盘上 29 条 + 累计 64）；`pv-buffer-regenerate.test.mjs` **26 → 33** |

- 硬边界：`productClaim.aligned=false` **不得**翻转 regen 退出码；「8 层 ≠ 16 位」的事实必须在回执里仍可见。

### 1.2 B｜失败清理（B①）+ 件号入口（B②）

`spike/build123d/app.py`、`desktop/src/parametric/features.ts`

| 项 | 合同 |
|---|---|
| 默认路径（件号） | 不带 `identityStep` 的请求体件号**原文**出现在 `files.parts[].id`（不 trim、不替换字符）；`features.ts` 的 `compileAssembly()` 已回到 `a4b57e4` 原值（本文件最终只剩 3 行注释，零行为 diff）；制造导出的调用与产物集合不变 |
| 默认路径（**例外，必须点明**） | 「默认路径行为逐字不变」**不成立**：本轮**明确改了失败路径** —— 五个真实导出点在异常/0 字节时改成 **400 + `hasFiles:false` + `shutil.rmtree(outdir)`**。这是本轮刻意的行为变更，不能笼统写「所有行为逐字不变」 |
| 校验与透传分口径 | `validateAssembly()` 仍**按 trim** 判空判重（校验口径未动），编译输出**原值**。两处刻意不同，靠内核入口兜，不在桌面层静默改写 |
| 严格路径（仅 `identityStep === true`） | 非字符串 / 空 / 纯空白 / **首尾填充空白** / 原样重号 → **400**，逐项**点名 `instances[i]`**，文案含「请修正源件号，内核不自动 trim」；**不自动 trim**、不落到其它层偷偷改写 |
| 放行 | 内部空格（`'tray 1'`）、非 ASCII（`'托板-01'`）、字面 `'part-1'` 一律放行，identity PRODUCT 名原文 |
| 失败路径（B①） | 五个**真实导出点**（制造 `part.step`、制造 `part.stl`、逐件 STL、`identity.step` 抛错、`identity.step` 0 字节）→ **400 + `hasFiles:false` + 隔离 `TMPDIR` 目录数不增**（`shutil.rmtree` 在 except 分支） |
| 成功路径 | **200**，产物保留在 `b123d-build-*` 目录供 client 取件（本轮**不**清理，见 §6） |
| 计数 | `identity-export` **12 → 24**（R12 原 12 条断言逐字未动）；`parametric-assembly` **25 → 26**；逐文件基数 `git show a4b57e4` 实测 |

- 硬边界：`B②` 只对 `identityStep === true` 生效；`_identity_labels` 的兜底 `if not label` 已不可达，不再出现 `part-{i+1}` 伪造件号。

### 1.3 C｜真内核用例进 FT job（C2）

`.github/workflows/ci.yml`、`desktop/scripts/verify-identity-export-tap.mjs`、`desktop/test/meta/{ci-strict-gates,identity-export-tap}.test.mjs`

| 项 | 合同 |
|---|---|
| 落点 | 只在 `featuretree-geometry` job；`unit` job 命中该文件名 **0** 次（不给 unit 装 build123d） |
| 顺序 | 在 `npm ci` 与 `pip install build123d` 之后；步骤 cwd `desktop`，`FT_PY="$PWD/../.venv-ft/bin/python"` 与同 job 其它步骤同口径 |
| venv 自证 | 先跑 `"$FT_PY" -c 'import build123d; print(...)'`，让「venv 指错」自己红，**不靠**用例文件的三级回退链兜 |
| 证据链 | `node --test --test-reporter=tap --test-reporter-destination=/tmp/identity-export.tap <file>` → `node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap`；producer/consumer **同一文件**（守卫判路径相等） |
| 校验器 | 计划 `1..N` == `ok/not ok` 记录数 == `# tests`；`pass/fail/skip/todo/cancelled` 逐项对账；记录编号连续、不重名；**6 个具名真实用例**（R12 基线 `a4b57e4` 的「内核：…」6 条）必须有 passed 记录；`tests ≤ 1` 或全为文件名记录 = 壳子必拒；未知结构 fail-closed |
| **不钉总条数** | 只钉这 6 个名字 + 计数自洽（B 已把内核用例加到 9，24 条照过） |
| 禁止 | 步骤内出现 `--test-name-pattern` / `--test-skip-pattern` / `--test-only` 即红；`echo`/`printf`/`cat`/`grep`/`ℹ …` 摘要当证据即红 |
| 预算（口径必须精确） | 该 job **step 级 `timeout-minutes` 实测合计 97 min**（10+5+10+10+12+20+10+5+5+10）；`ci.yml` 注释里写的最坏情形预算是 **102 min**；job `timeout-minutes` 是 **105**。关系是 `Σstep 97 ≤ 注释预算 102 ≤ job 105`，**不是**「实际总步骤超时从 97 涨到 102」 |
| node 口径 | `--test-reporter=tap` 顶层格式在 **v24.22.3（CI）与 v26.7.0（本机）实测一致**，两版都真文件跑过并通过校验 |

### 1.4 刻意没加（本轮合同外）

- 无 `--require-identity` / 新 CLI 旗标；无 D（逐实体拓扑身份）、无 D-lite、无 A2（塔进 regen 存取）。
- 不改默认路径的**件号与导出调用**：制造侧 0 字节仍 `200 ok:true`、成功 temp 生命周期、默认 `part-{i+1}` 兜底、`stats.instances[].id` 的 `strip()` **一律只登记**（§6）。

## 2. 边界（任何一次都不得越过）

1. **不是性能收益**：A 只改回执口径与判据，不改制造/导出；首轮 5.01x 失败**未定根因**，最终绿只是未再现，不许当「已修复」（§4.3）。
2. **不是塔覆盖**：`saveReloadCovered:false`、塔仍不在 regen 路径；`crossModelEquality=true` 只是「本机几何数值恰好也是 16」，**不构成**塔的对齐/覆盖证据。
3. **不是拓扑等价**：R12 的边界原样有效 —— 伴生 `identity.step` 与融合制造 STEP 不是同一产物，件号/计数/±1 mm 包络对上**只**等于导出侧身份齐全。
4. **不是通道可行**：`sweep` 405 步累计（270 确认 + 135 待复核）、去重 60 对、`reviewStatus=fail`、`feasible=false`；真实多层取放未实现。`verify:channel` 2/16 层各 30/30 是尺子自证。
5. **不是结构/安全/电气/PLC 验收**：`structure.accepted:false`、IO `null`、`executable=false`；无安装包、无 Release。
6. **本机通过不等于 CI 成功**：既往 R11 收口 `10c2224` / run `44536871871`、R12 `a4b57e4` / run `44558824879` 不覆盖 R13。R13 的 CI 结论以最终提交同 SHA 的仓库外回执为准，本文不预写。

## 3. 审查 → 整改 → 复审链（真实经过，含打回）

### 3.1 首审（对抗式，只读找反例）：**有条件通过**，0 × P0 / 3 × P1 / 4 × P2

| 编号 | 包 | 一句话 |
|---|---|---|
| P1-1 | B | `features.ts:559` 的 `trim()` 作用于**默认路径**（无 `identityStep` 也 trim），违反「默认路径件号原文」 |
| P1-2 | A | `productClaim.aligned` 是跨机型比较，几何恰好 16 位时回执写出「塔产品 16 位，一致」——结论型误导 |
| P1-3 | C | 新步骤的 `skipped 0` 断言可被 `echo` 满足，也可被 `--test-name-pattern` 变成「零条执行仍全绿」 |
| P2-1 | A | `modelClaimAligned` 是乘积比较，删一层补一层的补偿错层可过（退出码仍红） |
| P2-2 | B | 失败清理用例只覆盖 1/4 失败点（红点其实在制造 STEP） |
| P2-3 | B | 制造侧 0 字节仍 `200 ok:true`（先于本轮存在，登记不改） |
| P2-4 | C | 内核回退链让「错 venv」运行时红因指向 `skipped N`（假设，未亲跑） |

首审同时亲跑确认：三包验收不变量逐条命中；`git diff -U0 | grep '^-' | grep -cE 'assert|expect\('` = **0**（无既有断言被删/改写）。

### 3.2 整改（三包互不相交）

| 包 | 整改内容 | 自报读数（复审已亲跑复核） |
|---|---|---|
| Fix-A | `productClaim.aligned` 固定 `false` + `basis:'cross-model-unverified'` + `crossModelEquality` 信息位；`modelClaimAligned` 加 `slots.ok` 前置；16 位文案删掉「一致」 | `pv-buffer` 33/33；regen `ok=true checks=64 failed=0` exit 0 |
| Fix-B | 撤销全局 trim（`features.ts` 回到 base）；入口新增首尾空白拒绝并点名 `instances[i]`；新增 5 个定点失败用例 + 成功路径可读性用例 | identity-export 24/24（skipped 0）；assembly 26/26 |
| Fix-C | FT 步骤改独立 TAP + 校验器 + 12 条解析器单测；守卫⑧重写为结构链判据并登记 `LOAD_BEARING` | 守卫+解析器 37/37（node 24 与 26 各跑一遍）；真文件 24 条回执 `IDENTITY_TAP_OK` |

### 3.3 复审：**A / B / 解析器通过；C 守卫打回**

| 项 | 判定 | 依据（复审亲跑） |
|---|---|---|
| P1-1 件号源标识保真 | **通过** | `features.ts` 去注释后与 base 逐字相同；桌面默认路径 5 个带空白件号原文透传；内核默认 HTTP 200 原样；严格路径填充空白 400 点名 |
| P1-2 `productClaim` 恒 false | **通过** | 几何恰 16 位时 `aligned=false`；补偿错层时 `modelClaimAligned` 靠 `slots.ok` 自己红（`levelsFromGeometry` 仍绿，证明是本条鉴别力） |
| P1-3 TAP 解析器 | **通过** | 27+ 组反证全中（重号/重名/同名冒充/bailout/skip/todo/cancel/壳子/伪造 stdout/注释冒充），真跑 24 条回执照收 |
| P2-2 五失败点定点 | **通过** | 每点 `hitAt` 精确命中目标 basename，400 + `hasFiles=false` + `TMPDIR` 目录不增；成功路径全可读 |
| P1-3 **守卫** | **不通过 → 阻断** | 4 个变异下守卫零 finding：step 级 `continue-on-error:true`、step 级 `if:false`、preflight 被 `true # <真命令>` 满足、生产者被 `true # …` 顶掉 |

阻断理由：`continue-on-error`/`if:false` 加在新内核步骤上 = **零条内核用例 + 流水线绿**，正是 P1-3 要根治的形态；同一份守卫对 `verify:step-tower` 的同类写法是判红的，新门禁比旧门禁弱。

### 3.4 C2 收口（单文件整改 → 本机复验 → 独立窄复核通过）

只改 `desktop/test/meta/ci-strict-gates.test.mjs`（不碰 `ci.yml`、解析器、产品代码、B 的测试）。新增判据都在 `auditGates` 的 ⑩：step 级与 job 级 `continue-on-error` / `if:false`（含 `${{ false }}` 与首行 `- if:` 变体）、该步命令的**规范形状**锁（`IDENTITY_STEP_NOOP`）、preflight < producer < consumer 的**严格顺序**（`IDENTITY_STEP_ORDER`）、吞码（`MASKED_EXIT` 扫描剥注释后的命令）、生产者/消费者 TAP 路径绑定。

| 证据 | 读数（出处） |
|---|---|
| 16 条原反例（同一批真 `ci.yml` 变异） | 整改前绿 13 / 红 3 → 整改后**红 16 / 绿 0**（`scratch/cad-r13-fix-c2/probe-before-after.log`） |
| 全量变异 | `MUTATIONS` **50** 条逐条判红、登记码零漂移、关掉登记集合后 `left=[]`（`probe-codes.log`） |
| 同族绕过 | 额外 13 条红（`bash -c` 包裹 / `|| :` / `&& false` / `(...)` / 整行注释 / `timeout` 包裹 / 双生产者 / `set +e` / 相对路径 TAP / 去 `--test-reporter=tap`）；2 条合法写法不误杀（`probe-extra-attacks.log`） |
| 基线不自伤 | 真 `ci.yml` → `findings=[]` |
| 定向复验 | 守卫 + 解析器 **39/39 pass / 0 fail / 0 skip**，2,873 ms（`scratch/cad-r13-final/c2-parent-check.log`，父会话在最终树上亲跑） |
| 断言未削弱 | `git diff -U0` 删除行 7 条（import 重排 / MASK label / 移动块 `}` / 4 条被更大集合替换的 `LOAD_BEARING`），**无 assert/expect 删除** |

- 口径：形状锁是**规范形状**策略（改该步 flag 顺序、换 `$RUNNER_TEMP` 之类运行期路径、加一条额外诊断命令都会判红，需要同步改 `ID_STEP_SHAPES`），与既有 `GATE_SHAPE` 同一种取舍；「`continue-on-error` → job 绿」依据 GitHub Actions 语义，本轮**没有**跑真 runner。
- **独立窄复核通过**：原阻断写法已闭，独立复跑 50/50 变异判红、39/39 定向通过（`scratch/cad-r13-final-review.md`）。非阻断登记：YAML `if: false # 注释` 是既有守卫盲区；部分消费者/pipefail 行尾注释可能过严判红。不声称通用 YAML/shell 安全证明。

## 4. 本机读数（已实跑，非计划值）

> 树：`/tmp/automation-cad-prototype`，基线 `a4b57e4`；日志 `/root/.hermes/cache/scratch/cad-r13-final/`；`scratch/` 永不提交。

### 4.1 最终树（本轮受验变更 + 文档，串行）

| 项 | 读数 | 日志 |
|---|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断（文件 0 字节） | `final-tsc.log` |
| 定向 8 文件 | **237 tests / 237 pass / 0 fail / 0 skip / 0 todo**，21,974.2 ms | `final-targeted.log` |
| `npm run test:focused` | **431 / 431 pass / 0 fail / 0 skip**，32,005.9 ms | `final-focused.log` |
| 全量 `npm test` | **3834 tests / 3831 pass / 3 skip / 0 fail / 0 todo**，151,870.3 ms | `final-fulltest.log` |

- 定向 8 文件 = `test/parametric/verify-step-tower.test.mjs`(65) + `test/parametric/identity-export.test.mjs`(24) + `test/parametric-assembly.test.ts`(26) + `test/parametric-sidecar.test.ts`(22) + `test/machine/pv-buffer-regenerate.test.mjs`(33) + `test/cad/step-entities.test.mjs`(28) + `test/meta/ci-strict-gates.test.mjs`(27) + `test/meta/identity-export-tap.test.mjs`(12) = **237**。
- **增量对账（对 R12 基线 3798 = +36，代码算得出、不靠估）**：regen **26→33**（+7）、identity-export **12→24**（+12）、parametric-assembly **25→26**（+1）、ci-strict-gates **23→27**（+4）、新文件 identity-export-tap **12**（+12）；7+12+1+4+12 = 36，3798+36 = 3834，与日志逐条一致。
- 3 个 skip 的构成（`final-fulltest.log` 逐行读）：2 条 FreeCAD 真机用例（`未设置 AUTOMATIONCAD_FREECAD_REAL`）+ 1 条「AABB 说撞、真实布尔说不撞」（`没有带 build123d 的 Python`）——与环境缺失同源，沿用 R12 的解释，非本轮新增。

### 4.2 首轮全量 preflight（整改前、同一轮并行工作树）——**原样保留**

| 项 | 读数 |
|---|---|
| 定向（`preflight-targeted.log`） | 215 / 215 pass / 0 skip |
| focused（`preflight-focused.log`） | 429 / 429 pass / 0 skip |
| 全量 `npm test`（`preflight-fulltest.log`） | **3812 tests / 3808 pass / 3 skip / 1 fail / 0 todo**，140,835.2 ms |

### 4.3 全量里唯一那次失败：性能用例（**根因未定，原失败保留**）

| 项 | 读数 |
|---|---|
| 失败用例 | `machine-geometry.test.mjs:214`「统一后的生成耗时不得高于统一前 3 倍（真实计时，宽松阈值）」 |
| 首跑实测 | `after 19.15 ms / before 3.82 ms = 5.01x`（`after < 50 ms` 的兄弟断言是**过**的） |
| 独立单跑 5 次 | `1.27x / 0.93x / 1.21x / 1.26x / 1.24x`，5/5 pass（`perf-isolated-{1..5}.log`） |
| 与最重文件同进程并发 | `0.94x`，26/26 pass |
| 最终全量里该用例 | **通过**（`final-fulltest.log` 193.7 ms） |
| 因果证据 | 该用例与本次 8 个文件**无 import 边**，`git diff` 里相关文件为空 → 没找到因果，也**没有**证明根因是并发或环境 |

- 结论口径：**「未复现」≠「已修复」**。最终全量这条是绿的，只说明未再现；**不写「已修性能问题」**，也不把首轮那次红从记录里删掉。

### 4.4 稳定业务门禁（本机终验，逐条真跑，汇总见 `partial-gates-summary.json`）

| 门禁 | 读数 |
|---|---|
| `verify:step` | **7 / 7**；85 件 / 89 solids / 613 faces / 6000×1495×930（`geometry-step.log`） |
| `verify-step-tower --levels 16 --require-full` | **27 / 27**；`ids 146/146`、`solids 150/150`、`unionDelta 0/0/0`、`bboxMaxDelta 0.1823 mm`、`pollution 0`、`tol 1 mm(fixed)`（`tower16-final.log`） |
| `verify-step-tower --levels 8 --require-full` | **20 / 20**；`ids 90/90`、`solids 94/94`（`tower8-final.log`） |
| `eval:tasks --require-full` | **13 / 13**、`skipped 0`、`degraded false`、exit 0（`eval-final.log`） |
| `verify:channel --levels 2 / 16` | 各 **30/30**（正向 16 / 负向 14，N1..N14）；**同时** `reviewStatus=fail`、`feasible=false`（16 层 sweepSteps 271 / confirmedHits 270 / screenHits 135 / 去重 60 对）——自证通过 ≠ 通道可行（`channel{2,16}-final.log`） |
| `build:ext` | exit 0（内含 `tsc --noEmit`）：extension 2,946,989 B / gzip 922,141 B / wasm 7,604,031 B（`build-final.log`） |
| `smoke` | `SMOKE_OK`，**4 条显式 SKIP**（parametric sidecar / parametric UI / drawings UI / placeholder dims `reason=no-webgl`）+ **2 条 unavailable**（design viewport fallback、canvas PIP），SwiftShader 软件渲染（`smoke-final.log`） |
| `regen:pv-buffer`（隔离 userData） | `ok=true checks=64 failed=0`，exit 0；90 件、包络 2430×1690×2400、STEP 1,622,322 B；JSON 实读复算一致（`regen-final.log`） |
| `doctor:sidecar --json` | dry-run，exit 0，`scanned=350 / sidecars=0 / killed=0`；**不在 CI**，只能按本机读数引用（`doctor-final.log`） |
| CI 形状 TAP 链 | 真文件 `1..24`、24 条记录、`pass=24 / fail=0 / skip=0 / todo=0`、6 个具名内核用例全 ok、校验器 `IDENTITY_TAP_OK`（`identity-tap-final.log`）。**但 venv 是本机替身 `ft-venv-shim` + node v26，≠ 远端 `.venv-ft` + node 24 → 不等于 CI 已验** |

- 9 个关键源文件（`app.py`、`features.ts`、`electron/parametric.ts`、`step-entities.ts`、`pv-buffer-regenerate.mjs`、`verify-identity-export-tap.mjs`、`verify-step-tower.mjs`、`verify-step-export.mjs`、`ci.yml`）**门禁前后哈希逐字相同**（`partial-gates-summary.json` 的 `sourceHashesChangedDuringRun: []`）。
- 这些都是本机同树串行读数，**不构成 CI 证据**。

## 5. 终验状态

| 项 | 状态 |
|---|---|
| `tsc` / 定向 / focused / 全量 | **已在本轮最终树实跑**（§4.1），读数见日志 |
| 稳定业务门禁 11 条 | **已实跑，raw exit 全 0**（§4.4） |
| CI | 只认 `headSha == 交付 HEAD` 的最终实跑回执，按 job 级读；回执写**仓库外** `scratch/FINAL-RECEIPT.json`，不为记录 CI 再推一笔 |
| 提交 / 推送 | 以 Git 为准（`git status` / `git log` 实查）。白名单逐个 `git add`，禁 `git add -A`，`scratch/` 永不提交 |
| **独立窄复核（C2 守卫）** | **通过**，50/50 变异判红、39/39 定向通过；非阻断登记与证据见 §3.4 |

## 6. 登记项（本轮**不修**，勿当已验证）

1. **制造侧 0 字节仍 `200 ok:true`**（`stepBytes 0`，本轮实测复现）：身份侧有「空文件=失败」，制造 STEP/STL 没有；下游 `disk.stepHeader`/`stepBrep` 会红。已在用例里钉成现状。
2. **成功路径 temp 生命周期未修**：每次成功留 1 个 `b123d-build-*`；需要协议层配合（`outDir`/`release`），**不要**用「自动删历史 temp」凑结论。
3. **默认路径 `part-{i+1}` 分件兜底仍在**（`app.py`）：只在「无 `identityStep` 且件号为空」时可能触发，严格路径已被入口拦住；本轮要求默认路径件号原文，故不动。
4. **默认路径 `stats.instances[].id` 仍按 `strip()`**：与 `files.parts[].id` 的原文在带空白件号时是两套字符串，属既有行为。
5. **塔未进 regen 存取**（`saveReloadCovered:false`）；**A2 延期**（等机构/容量口径拍板）。
6. **D / D-lite 不纳入本轮**：D 的判据在产物层没有定义域（融合抹平归属）；D-lite 待 146 件真塔面数探针成立后再议。
7. 通道/结构/安装包口径沿用 R11/R12：`sweep` 405 fail、`feasible=false`、真实多层取放未实现、结构安全 PLC 未验收、无安装包无 Release。

## 7. 指挥链索引（合同与证据）

- 执行合同：`scratch/cad-r13-task-contract.md`（含 T3 后追加裁定，优先级高于侦察建议）。**scratch 永不提交**，本文件只引用其结论，不复制原文。
- 首审：`scratch/cad-r13-review.md`；复审：`scratch/cad-r13-rereview.md`；整改自报：`scratch/cad-r13-fix-{a,b,c}.md`、**C2：`scratch/cad-r13-fix-c2.md`**；架构：`scratch/cad-r13-architecture.md`。
- 探针与变异副本：`scratch/cad-r13-review/`、`scratch/cad-r13-rereview/`、`scratch/cad-r13-fix-c2/`、`scratch/cad-r13-final-review/`。
- 本轮日志：`scratch/cad-r13-final/`（`final-{tsc,targeted,focused,fulltest}.log`、`fix-*.log`、`preflight-*.log`、`perf-isolated-*.log`、`tower{16,8}-final.log`、`eval-final.log`、`channel{2,16}-final.log`、`build-final.log`、`smoke-final.log`、`regen-final.log`、`doctor-final.log`、`identity-tap-final.log`、`c2-parent-check.log`、`partial-gates-summary.json`）。

## 8. 复跑顺序（同树串行；命令逐条照抄，别把门禁合成一行）

```bash
cd /tmp/automation-cad-prototype/desktop
export AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python
export TMPDIR=/root/.hermes/cache/scratch

# 1) 定向 8 文件（实测 237）
node --test \
  test/parametric/verify-step-tower.test.mjs \
  test/parametric/identity-export.test.mjs \
  test/parametric-assembly.test.ts \
  test/parametric-sidecar.test.ts \
  test/machine/pv-buffer-regenerate.test.mjs \
  test/cad/step-entities.test.mjs \
  test/meta/ci-strict-gates.test.mjs \
  test/meta/identity-export-tap.test.mjs

# 2) 类型 + focused + 全量（有界跑法，别无界等待）
npx tsc --noEmit
npm run test:focused
timeout -k 15 900 npm test

# 3) 业务门禁（每条独立跑，读数各自对日志）
npm run verify:step
npm run verify:step-tower -- --levels 16 --require-full
npm run verify:step-tower -- --levels 8 --require-full
npm run eval:tasks -- --require-full
npm run verify:channel -- --levels 2
npm run verify:channel -- --levels 16
npm run build:ext
npm run smoke
npm run regen:pv-buffer -- --user-data <隔离目录>
npm run doctor:sidecar -- --json        # 不在 CI，dry-run

# 4) CI 形状 TAP（本机替身 venv，≠ 远端 CI）
"$FT_PY" -c 'import build123d; print("IDENTITY_KERNEL_OK", build123d.__version__)'
AUTOMATIONCAD_PYTHON="$FT_PY" node --test --test-reporter=tap \
  --test-reporter-destination=/tmp/identity-export.tap test/parametric/identity-export.test.mjs
node scripts/verify-identity-export-tap.mjs /tmp/identity-export.tap
```

- CI 侧只看新步骤：`featuretree-geometry` 的「内核 identity-export 用例（真跑 + TAP 回执结构校验）」；`doctor:sidecar` **不在 CI**。
- 文档不在 `KB_DOC_FILES`（`desktop/src/agent/kb/index.ts` 的 13 份）→ 改本文**不需要** `kb:build`，统计仍 13/454/434,531。
