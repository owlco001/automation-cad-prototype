# R13 验收回执（2026-11-20）

> 用途：**可移交的一页回执**，供接手者/复审者独立核对。不复述过程、不贴日志全文、不含密钥。
> 能力合同、审查证据、登记项全文 → [R13-ITERATION.md](R13-ITERATION.md)；下一步 → [`HANDOFF-NEXT-SESSION.md`](../../HANDOFF-NEXT-SESSION.md)。
> **本机终验与独立窄复核均通过**（日志 `scratch/cad-r13-final/final-*`；独立结论 `scratch/cad-r13-final-review.md`）。CI / 交付 SHA 按最终提交的远端实跑回执认定，不预写。

## 1. 结论（本机能说的）

- **能力已落地**：A 口径分层、B 件号源标识保真 + 五失败点清理、C2 真内核用例进 FT job（独立 TAP + 结构校验器）。受验改动共 15 文件（8 代码修改 + 2 新代码文件 + 3 文档修改含 README 测试基线 + 2 新文档），基线 `a4b57e4`（R12 收口）；交付提交与推送以 Git 实查为准。
- **本机终验绿**：`tsc` exit 0；定向 8 文件 **237/237**（0 skip）；`test:focused` **431/431**（0 skip）；全量 **3834 / 3831 pass / 3 skip / 0 fail / 0 todo**，151,870.3 ms。稳定业务门禁 11 条 raw exit 全 0。
- **首轮不是绿的，原样保留**：3812 / 3808 / 3 / **1 fail**（性能比 5.01x）。最终全量这条用例是绿的 = **未再现**，**不给根因、不写成已修复**。
- **审查链真实经过**：首审「有条件通过」（0 P0 / 3 P1 / 4 P2）→ 三包整改 → 复审 **A / B / 解析器通过、C 守卫打回** → C2 单文件整改（16 条原反例全红、50 条变异全红、定向 39/39）→ **独立窄复核通过**。非阻断边界：YAML 条件 `if: false # 注释` 仍有既有守卫盲区；消费者/pipefail 行尾注释可能过严判红。不是通用 YAML/shell 安全证明。

## 2. 受验对象

| 项 | 值 |
|---|---|
| 仓库 / 树 | `owlco001/automation-cad-prototype` @ `/tmp/automation-cad-prototype` |
| 代码基线 | `a4b57e4`（R12 文档收口） |
| 改动面 | A：`scripts/pv-buffer-regenerate.mjs` + 其测试；B：`spike/build123d/app.py`、`src/parametric/features.ts`、`test/parametric/identity-export.test.mjs`、`test/parametric-assembly.test.ts`；C：`.github/workflows/ci.yml`、`test/meta/ci-strict-gates.test.mjs` + 新 `scripts/verify-identity-export-tap.mjs`、`test/meta/identity-export-tap.test.mjs` |
| 解释器 / 工具链 | `AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python`（build123d 0.13.0）；node v26.7.0（CI 为 v24.22.3，TAP 格式两版实测一致）；cwd `desktop/` |
| 证据目录 | `/root/.hermes/cache/scratch/cad-r13-final/`；合同/审查/整改自报 `scratch/cad-r13-{task-contract,review,rereview,fix-a,fix-b,fix-c,fix-c2}.md`；**scratch 永不提交** |

## 3. 本机终验读数（已实跑，命令与日志可复现）

| 项 | 读数 | 日志 / 时点 |
|---|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断（文件 0 字节） | `final-tsc.log` |
| 定向 8 文件 | **237 / 237 pass / 0 fail / 0 skip**，21,974.2 ms | `final-targeted.log` |
| `npm run test:focused` | **431 / 431 pass / 0 fail / 0 skip**，32,005.9 ms | `final-focused.log` |
| 全量 `npm test` | **3834 / 3831 pass / 3 skip / 0 fail / 0 todo**，151,870.3 ms | `final-fulltest.log` |
| 增量对账 | **+36** = regen 26→33(+7) + identity-export 12→24(+12) + assembly 25→26(+1) + ci-strict-gates 23→27(+4) + 新 TAP 12；3798+36 = 3834 | `git show a4b57e4` 基数 + 日志 |
| 3 个 skip | 2 条 FreeCAD（未设 `AUTOMATIONCAD_FREECAD_REAL`）+ 1 条 AABB/布尔对比（无 build123d 的 Python），环境缺失类，沿用 R12 解释 | `final-fulltest.log` |
| `verify:step` | **7 / 7**（85 件 / 89 solids / 613 faces / 6000×1495×930） | `geometry-step.log` |
| `verify-step-tower` 16 / 8 层 | **27 / 27**（ids 146/146、solids 150/150、unionΔ 0/0/0、bboxMaxΔ 0.1823 mm、tol 1 mm）/ **20 / 20**（ids 90/90、solids 94/94） | `tower{16,8}-final.log` |
| `eval:tasks --require-full` | **13 / 13**、`skipped 0`、`degraded false`、exit 0 | `eval-final.log` |
| `verify:channel` 2 / 16 层 | 各 **30/30** 自证；**同时** `reviewStatus=fail`、`feasible=false` | `channel{2,16}-final.log` |
| `build:ext` / `smoke` | exit 0（ext 2,946,989 B / gzip 922,141 B）；`SMOKE_OK` + 4 SKIP + 2 unavailable | `build-final.log` / `smoke-final.log` |
| `regen:pv-buffer` / `doctor` | `ok=true checks=64 failed=0`（隔离 userData）；doctor dry-run `scanned=350 / sidecars=0 / killed=0`（**不在 CI**） | `regen-final.log` / `doctor-final.log` |
| C2 守卫自证 | 16 条原反例整改前绿 13 → 整改后**红 16**；50 条变异全红；守卫+解析器 **39/39** | `scratch/cad-r13-fix-c2/`、`c2-parent-check.log` |
| CI 形状 TAP 链 | `1..24`、24 条、pass 24 / fail 0 / skip 0、6 个具名内核用例 ok、`IDENTITY_TAP_OK`——**本机替身 venv（`ft-venv-shim`）+ node 26，不等于远端 CI** | `identity-tap-final.log` |

- 9 个关键源文件门禁前后哈希逐字相同（`partial-gates-summary.json`）。
- 全表是本机同树串行读数，**不是 CI 读数**。

## 4. 最终门禁

| 门禁 | 读数 |
|---|---|
| 定向（最终树） | **237 / 237**，0 skip（`final-targeted.log`） |
| `test:focused`（最终树） | **431 / 431**，0 skip（`final-focused.log`） |
| 全量 `npm test`（最终树） | **3834 / 3831 / 3 skip / 0 fail / 0 todo**，151,870.3 ms（`final-fulltest.log`）；首轮那次 5.01x 失败仍在案（R13-ITERATION.md §4.3），未给根因 |
| C 守卫（C2 整改后） | 16 条原反例全红 + 50 条变异全红 + 39/39 定向（`c2-parent-check.log`） |
| 提交 / 推送 | 以 Git 实查为准：白名单逐个 `git add`（禁 `git add -A`，`scratch/` 永不提交），交付 HEAD 以 `git rev-parse HEAD` 记录 |
| CI | 以仓库外最终回执的同 SHA 实跑为准，不借用旧 run 放行；已核既往 R11 `10c2224`/run `44536871871`、R12 `a4b57e4`/run `44558824879` 都不是 R13 的 CI |
| 独立窄复核（C2 守卫，只读、未参与整改） | **通过**：原阻断写法已闭；50/50 变异实跑判红、39/39 定向通过；登记的非阻断边界见 §1；证据 `scratch/cad-r13-final-review.md` |

## 5. CI 约定（不预写成功）

- 本轮**唯一**新增 CI 面：`featuretree-geometry` job 的「内核 identity-export 用例（真跑 + TAP 回执结构校验）」——`.venv-ft` 自证 → `node --test --test-reporter=tap --test-reporter-destination=/tmp/identity-export.tap` → 校验器解析同一文件。`unit` job 命中该文件名 **0** 次（不给 unit 装 build123d）。
- 预算（精确口径）：该 job **step 级 `timeout-minutes` 合计 97 min** ≤ `ci.yml` 注释预算 **102 min** ≤ job `timeout-minutes` **105**；新步骤自身 5 min。**不是**「实际总步骤超时从 97 涨到 102」。
- **判定只认 `headSha == 交付 HEAD` 的 run，按 job 级读**：红先分「基础设施步（apt/网络/pip）」与「断言步」，后者才看步骤的 `code/exitCode/stderr`。
- `doctor:sidecar` **不在 CI**（只能按本机读数引用）。
- 回执由实跑写入**仓库外** `scratch/FINAL-RECEIPT.json`，**不制造提交循环**（不为记录 CI 结果再推一笔）。

## 6. 这份回执**不**证明什么

1. **不证明性能更好**：A 只改回执口径与判据；5.01x 那次失败未定根因，最终绿只等于「未再现」。
2. **不证明塔已对齐/已覆盖**：`productClaim.aligned` 恒 `false`、`basis:'cross-model-unverified'`、`saveReloadCovered:false`；`crossModelEquality` 只是信息位（不作塔可行性门禁，仅受 `scopeSplit` 的派生自洽检查）。注意：**`modelClaim.aligned` 可以为 `true`**（8 层几何派生 == 参数声明），别把「恒 false」扩写成「所有 aligned 都 false」。
3. **不证明拓扑等价**：R12 的边界原样有效 —— 伴生 `identity.step` 与融合制造 STEP 不是同一产物，件号/计数/±1 mm 包络对上只等于「导出侧身份齐全」。
4. **不证明通道/结构可行**：`sweep` 405 步累计（270 确认 + 135 待复核）、去重 60 对、`reviewStatus=fail`、`feasible=false`；真实多层取放未实现；`structure.accepted:false`、IO `null`、`executable=false`。
5. **不证明可交付安装**：无安装包、无 Release、未签名。
6. **不证明登记项已修**：制造侧 0 字节仍 `200 ok:true`、成功路径 temp 未清理、默认 `part-{i+1}` 兜底与 `stats.instances[].id` 的 `strip()` 都是**现状登记**（详见 R13-ITERATION.md §6）。
7. **不证明覆盖完整**：C 的 TAP 校验器只钉 6 个具名内核用例 + 计数自洽，**不钉总数**；删掉别的内核用例不会被它察觉。
8. **`modelClaim.slots` 的语义别写错**：它来自**请求参数 `params.layers`**（CLI `--layers`），不来自 `--levels`、不来自几何、也不来自件表。

## 7. 移交动作

1. 读 §4 的终验与独立窄复核结论；任何再次变更源码/测试后，都按 R13-ITERATION.md §8 重新验收，不复用旧树结果。
2. 提交：按白名单**逐个** `git add`（A 2 / B 4 / C 2 + 2 新 + 本轮文档含 `HANDOFF-NEXT-SESSION.md`、`docs/desktop/{R13-ITERATION,R13-ACCEPTANCE,PV-BUFFER-ITERATION-HANDOFF}.md`、`README.md` 的测试基线数字），**`git add -A` 禁用**，`scratch/` 永不提交，`git diff --check` 须无输出。
3. 推送后找 `headSha == HEAD` 的 run，按 job 级读；回执写 `scratch/FINAL-RECEIPT.json`（仓库外）。
4. 未完成项按危害排序：通道（405 → 0，需机构决策）→ 结构/安全/电气/PLC → 制造 0 字节 / temp 生命周期 → 逐实体拓扑身份（D，本轮不纳）。
