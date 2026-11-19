# AutomationCAD 下一会话交接

更新时间：2026-11-20（**R13 本机终验与独立窄复核通过；推送与同 SHA CI 按仓库外最终回执实查**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 本轮全文 → `docs/desktop/R13-ITERATION.md`（能力合同 + 审查/整改/复审/C2 收口 + 读数 + 登记项）；一页回执 → `docs/desktop/R13-ACCEPTANCE.md`（§4 最终门禁）；
> 上一轮口径 → `docs/desktop/R12-STEP-IDENTITY.md` / `R12-ACCEPTANCE.md`；通道与归零决策 → `docs/desktop/R11-CHANNEL-SWEEP.md`。

## 现状（截至本文件写入）

- **代码索引**：基线 `a4b57e4`（R12 收口）。本轮共 15 文件：代码 **8 改 + 2 新**，文档 **3 改 + 2 新**（含 `README.md` 的测试基线数字）。**交付 HEAD / 推送 / CI 以 Git 与仓库外 readback 为准**。
  - A：`desktop/scripts/pv-buffer-regenerate.mjs` + `test/machine/pv-buffer-regenerate.test.mjs`
  - B：`spike/build123d/app.py`、`desktop/src/parametric/features.ts`、`test/parametric/identity-export.test.mjs`、`test/parametric-assembly.test.ts`
  - C：`.github/workflows/ci.yml`、`test/meta/ci-strict-gates.test.mjs` + 新 `scripts/verify-identity-export-tap.mjs`、`test/meta/identity-export-tap.test.mjs`
- **能力（A1 口径分层）**：`modelClaim{slots:8,aligned:true,source:'project-parts'}` 与 `productClaim{slots:16,aligned:false,basis:'cross-model-unverified',coveredBy:'verify:step-tower --levels 16',saveReloadCovered:false}` 并存。`modelClaim.slots` 来自**请求参数 `params.layers`**（不是 `--levels`、不是几何、不是件表）；`crossModelEquality` 是信息位，不作塔可行性门禁，只受 `scopeSplit` 的派生自洽检查。检查 61→64，单测 26→33。
- **能力（B①②）**：默认路径件号**原文**透传（`features.ts` 回到 base，只剩 3 行注释）；`identityStep === true` 严格路径对填充空白/非串/空/重号 → **400 点名 `instances[i]`**，不自动 trim；五个真实导出失败点统一 **400 + 无 files + 清目录**（**这是本轮明确的行为变更**，别写成「默认路径行为全都没变」）；成功路径保留产物。identity-export 12→24、assembly 25→26。
- **能力（C2）**：`featuretree-geometry` job 新增独立步骤 —— `.venv-ft` 自证 → `node --test --test-reporter=tap --test-reporter-destination=/tmp/identity-export.tap` → 校验器解析**同一文件**（6 个具名内核用例必有 passed 记录，**不钉总数**）。预算口径：step 级合计 **97** ≤ `ci.yml` 注释预算 **102** ≤ job **105**。
- **审查链**：首审「有条件通过」（0 P0 / 3 P1 / 4 P2）→ 三包整改 → 复审 **A / B / 解析器通过、C 守卫打回** → C2 单文件整改 → **独立窄复核通过**（50 条变异全红、39/39）。非阻断登记：`if: false # 注释` 的既有盲区与部分合法行尾注释过严判红，见最终审查报告。

## 已实跑读数（本机、同树串行；日志 `scratch/cad-r13-final/`）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断（`final-tsc.log` 0 字节） |
| 定向 8 文件（`final-targeted.log`） | **237 / 237 pass / 0 skip**，21,974.2 ms |
| `test:focused`（`final-focused.log`） | **431 / 431 pass / 0 skip**，32,005.9 ms |
| 全量（`final-fulltest.log`） | **3834 tests / 3831 pass / 3 skip / 0 fail / 0 todo**，151,870.3 ms；增量 **+36**（见下） |
| 唯一历史失败 | 性能用例 `5.01x`（首轮 3812 里那 1 条）；最终全量里**通过 = 未再现**，根因未定，不许写「已修复」 |
| `verify:step` / tower 16 / tower 8 | **7 / 7** / **27 / 27**（ids 146/146、solids 150/150、unionΔ 0/0/0、tol 1 mm）/ **20 / 20**（ids 90/90、solids 94/94） |
| `eval` / `channel` / `build:ext` / `smoke` | **13 / 13**（skipped 0） / 2·16 层各 **30/30** 但 `feasible=false`、`sweep` fail / exit 0 / `SMOKE_OK` + 4 SKIP + 2 unavailable |
| `regen` / `doctor` / TAP 链 | `ok=true checks=64 failed=0`（隔离 userData） / dry-run `scanned=350, sidecars=0`（不在 CI） / `1..24`、`IDENTITY_TAP_OK`（**本机替身 venv + node 26，≠ 远端 CI**） |

- 增量对账：**+36** = regen +7（26→33）+ identity-export +12（12→24）+ assembly +1（25→26）+ ci-strict-gates +4（23→27）+ 新 TAP 12；3798+36 = **3834**。
- 3 个 skip 都是环境缺失类（2 条 FreeCAD 未设 `AUTOMATIONCAD_FREECAD_REAL`、1 条 AABB/布尔对比无 build123d 的 Python），沿用 R12 解释。

## 最终核对

- **独立窄复核通过**，证据 `scratch/cad-r13-final-review.md`；本机全量已过，但仍保留首次性能失败与未定根因。
- CI：只认最终回执内 `headSha == 交付 HEAD` 的 run，按 job 级读；已核既往 R11 `10c2224`/run `44536871871`、R12 `a4b57e4`/run `44558824879` 都不是 R13。

## 下一会话顺序

1. 先读三份：`R13-ITERATION.md` §3/§4/§5、`R13-ACCEPTANCE.md` §4、`scratch/cad-r13-rereview.md` §4.2（守卫缺口的 4 个变异）。
2. `git status -sb` / `git log --oneline -5`：确认当前交付 HEAD 与远端 SHA，不把 R12 基线当 R13 最新提交。**不要 `git checkout --`、不要 `git stash`、不要 amend**。
3. 需要再改源码/测试时，按 `R13-ITERATION.md` §8 同树串行整轮重跑（定向 8 文件 → `tsc` → focused → 全量 → 业务门禁逐条 → regen → doctor → TAP 链）。
4. 按白名单**逐个** `git add`（A 2 / B 4 / C 2 + 2 新 + 文档），**`git add -A` 禁用**，`scratch/` 永不提交，提交后 `git diff --check` 无输出。
5. 推送后找同 SHA run，按 job 级读；回执写**仓库外** `scratch/FINAL-RECEIPT.json`，**不为记录 CI 再推一笔**。
6. 之后才是老欠账：通道**拍板**（405 → 0，需机构决策）→ 结构/安全/电气/PLC → 制造 0 字节 / 成功 temp 生命周期 → STEP 逐实体拓扑身份（D，本轮不纳）。

## 结论限制（任何一轮都不许越过）

1. **不是性能收益**：A 只改回执口径与判据；5.01x 未定根因，最终绿 ≠ 已修复。
2. **不是塔覆盖**：`productClaim.aligned` 恒 false、`basis:'cross-model-unverified'`、`saveReloadCovered:false`；`crossModelEquality=true` 只是「本机几何数值恰好也是 16」；A2（塔进 regen 存取）**延期**。
3. **不是拓扑等价**：伴生 `identity.step` 与融合制造 STEP 不是同一产物；件号/计数/±1 mm 包络对上只等于导出侧身份齐全（R12 边界原样有效）。
4. **不是通道/结构可行**：`sweep` 405 步累计（270 确认 + 135 待复核）、去重 60 对、`reviewStatus=fail`、`feasible=false`；真实多层取放未实现；`structure.accepted:false`、IO `null`、`executable=false`；无安装包、无 Release。
5. **不是覆盖完整**：C 只钉 6 个具名内核用例 + 计数自洽；删掉别的内核用例不会红。
6. **D / D-lite 不纳本轮**：D 的判据在产物层没有定义域（融合抹平归属）；D-lite 待 146 件真塔面数探针成立后再议。

## 文档与 KB / 安全

- 本轮四份文档（`R13-ITERATION.md`、`R13-ACCEPTANCE.md`、`HANDOFF-NEXT-SESSION.md`、`PV-BUFFER-ITERATION-HANDOFF.md`）**都不在 `KB_DOC_FILES`**（`desktop/src/agent/kb/index.ts`，13 份）→ 改它们**不需要** `kb:build`，统计仍 13/454/434,531；`README.md` 也不在 KB 名单里，改它不触发 `kb-freshness`。
- 不删除/覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`；不把其中密钥复制进仓库或文档。IO 草案地址 `null` 是有意设计。
- `doctor:sidecar` **不在 CI**，只能按本机读数引用；怀疑残留 sidecar 先跑 `npm run doctor:sidecar -- --json` 看 `scanned`/`sidecars`，再决定 `--kill`（默认 dry-run）。
- 失败点用例自己建隔离 `TMPDIR`（前提是「目录数不增」这条断言可信）：不要为省事把它指到共享目录，否则别人的残留会让 `newDirs=[]` 变成噪声。
