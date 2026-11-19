# AutomationCAD 下一会话交接

更新时间：2026-11-19（**R12 收口：STEP 伴生身份件 + 原始装配树回读门禁；本机 12 道门禁全绿；通道仍 fail、无安装包/Release**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 完整口径 → `docs/desktop/R12-STEP-IDENTITY.md`（能力合同 + 审查证据 + 验收）；一页回执 → `docs/desktop/R12-ACCEPTANCE.md`；
> 通道口径与归零决策 → `docs/desktop/R11-CHANNEL-SWEEP.md`；孤儿 sidecar → `docs/desktop/SIDECAR-DOCTOR.md`。
> 不要在本文堆历史（R11 及更早见 `docs/desktop/R11-ITERATION.md`、`R10-ITERATION.md`）。

## 现状

- **代码索引**：R12 = 两笔 **`1671f36`**（P1，身份件导出，5 文件）+ **`b9f377a`**（P2，原始装配树回读与门禁，4 文件），共 9 文件（4 改 5 新）；**`10c2224`** 是 R12 之前的基线。**`b9f377a` 不是最终 HEAD**：本轮另有 5 份文档随后的提交，交付 HEAD 以 `git rev-parse HEAD` 实查为准，推送状态以 `git status -sb` / `git log origin/main..HEAD` 实查为准。
- **能力**：`/build` 可**选择性**多导出一份非融合 `identity.step`（默认关闭；`identityStep === true` 且 `perPart` + 非空 `instances` + `exports` 含 `step` 才生效）。**原制造默认路径不变**：不请求就没有这份文件，原制造导出调用与默认请求字段保持原样；不声称跨请求文件逐字节一致。
- **门禁**：`verify-step-tower` 的 build 路径**强制**请求它，按 occt **原始装配节点实例**回读（不重命名、不去重），追加 4 条判据（产物完整性 / 三方件号集合 / 逐件实体数与包络 / 并集核对与污染）。容差**固定 1 mm**（`--tolerance` 不继承），两侧**同一份 OCCT 网格口径**，归属走 **realpath + 拒 identity 软链**；`--file` 模式 `entityIdentity = NOT_APPLICABLE`（不计入 ok、非验收）。
- **审查**：P1 × 3（异口径 / 软链 / 容差放大）**全闭**；M7 变异初报 7/7 不实 → 复审复跑 6/7 → 补 `unionDeltaMm === null` 断言 → 最终亲跑 7/7（首轮 6/7 保留在案）。

## 门禁（本机、同一棵树、串行；日志 `scratch/cad-r12-final/`）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断 |
| 定向 4 文件 | **127 / 127**（identity-export 12 + step-entities 28 + verify-step-tower 65 + parametric-sidecar 22） |
| `test:focused` | **424 / 424** |
| 全量 `npm test` | **3798 tests / 3795 pass / 3 skip / 0 fail / 0 todo**，129,159.907445 ms（基线 3750/3747/3/0 → 增量 **+48** = 28 + 12 + 8） |
| `verify:step`（真内核） | **7 / 7**，85 件 / 89 solids / 613 faces / 6000×1495×930 |
| `verify-step-tower` 16 层 / 8 层 | **27 / 27**（`ids 146/146`、`solids 150/150`）/ **20 / 20**（`ids 90/90`、`solids 94/94`）；两档 `unionDelta 0/0/0`、`bboxMaxDelta 0.1823 mm`、`tol 1 mm(fixed)`、`pollution 0` |
| `eval:tasks --require-full` | **13 / 13**，`skipped 0` / `degraded false` |
| `verify:channel --levels 2 / 16` | 各 **30 / 30**（只证明关系断言） |
| `build:ext` / `smoke` | **exit 0**（total 10,551,020 B）/ `SMOKE_OK`、4 条显式降级、0 FAIL |
| `regen:pv-buffer` / `doctor:sidecar` | `ok=true checks=61 failed=0`（`slots 8` vs `claimed 16` 仍未解决）/ dry-run `scanned=347 targets=0 killed=0` |

- **口径更正**：`verify-step-tower` 基线是 **57 reported**（55 个 `test(`），架构文档里「基线 47」已过期，不可用 `93−47` 当增量。
- smoke 的 `STARTUP_METRICS totalMs=378.7` 只从 **module evaluation** 起算 —— 口径读数，**不可宣称提速**。

## CI 与回执

- `ci.yml` **已有**（R12 未加步骤）：`verify:step-tower --levels 16 / 8 --require-full`、`verify:channel --levels 2 / 16`、`verify:step`、`eval:tasks --require-full`、`npm test`。**新身份检查随既有 tower 步骤进入 CI**，channel 仍独立自证；**`doctor:sidecar` 不在 CI**，只能按本机读数引用。
- 远端基线已证：run **`44536871871` @ `10c2224` = 7/7 success** —— 那是 **R12 之前**的 run，**不是 R12 的 CI**。
- **约定**：上表全部是本机读数。最终判定只认 `headSha == 交付 HEAD` 的 run，按 **job 级**读；红先分「基础设施步（apt/网络）」与「断言步」，后者才看 `verify:step` 的 `code/elapsed/exitCode/stderrClass`。回执由实跑写入 `scratch/FINAL-RECEIPT.json`，**任何文档都不预写 CI 成功**。

## 结论限制（任何一轮都不许越过）

1. **STEP 身份只到导出侧**：件号集合 + 实体计数 + ±1 mm 网格包络对上，**不等于**伴生 `identity.step` 与融合制造 STEP 的拓扑/形状等价；bbox 不是唯一几何指纹，网格偏折随 bbox（实测 0.1823 mm，<1 mm 非零）。**不是制造认证、不是逐实体拓扑认证。**
2. **升降通道未通**：16 层 sweep **405 = 270 确认 + 135 待复核**、**去重 60 对**、`reviewStatus=fail`、**`feasible=false`**（blockers `load-passes-shelf` + `stroke-shortfall`，行程缺 16.5 mm）；2 层 19 步 / 18 确认 + 9 待复核 = 27 步累计 / 去重 4 对。`30/30` 是尺子自证，不是结构/安全验收。
3. **真实多层取放未实现**，已有多层几何；两条归零路线（缩回 240 / 开 240 缺口）只是决策书，需机构变更 + 结构校核。
4. **结构/安全/电气/PLC 未验收**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO `null`、`executable=false`；侧车 `box`/`cylinder` 近似**不是**真实特征认证。
5. **regen 有登记缺口**：`slotsFromGeometry=8` vs `claimedSlots=16`、`aligned=false`，只覆盖 8 储位 / 90 件缓存样机。
6. **无安装包、无 Release**：`build:ext` 只是扩展产物与体积门禁，未签名、未打 tag。

## 下一会话顺序

1. `git status -sb` / `git log --oneline -4` → 确认交付 HEAD 与推送状态。**不要 `git checkout --`、不要 `git stash`、不要 amend**：改历史会让已证 run 与 SHA 脱钩。
2. 提交按白名单逐个 add（R12 九文件 + 本轮 5 份文档：`HANDOFF-NEXT-SESSION.md`、`docs/desktop/{R12-STEP-IDENTITY,R12-ACCEPTANCE,PV-BUFFER-ITERATION-HANDOFF}.md`、`README.md`），**`git add -A` 禁用，`scratch/` 永不提交**；提交后 `git diff --check` 无输出。
3. 任何再改源码/测试后按此顺序整轮重跑（同树、串行）：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   export AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python
   node --test test/parametric/identity-export.test.mjs test/cad/step-entities.test.mjs \
     test/parametric/verify-step-tower.test.mjs test/parametric-sidecar.test.ts   # 127
   npx tsc --noEmit && npm run test:focused && npm test                            # 0 / 424 / 3798
   npm run verify:step && npm run verify:step-tower -- --levels 16 --require-full
   npm run verify:step-tower -- --levels 8 --require-full && npm run eval:tasks -- --require-full
   npm run verify:channel -- --levels 2 && npm run verify:channel -- --levels 16
   npm run build:ext && npm run smoke && npm run regen:pv-buffer && npm run doctor:sidecar -- --json
   ```
4. 推送后按 `headSha == HEAD` 找 run，按 job 级读；回执写 `scratch/FINAL-RECEIPT.json`。
5. 之后才是老欠账：升降通道**拍板**（缩回 240 / 开 240 缺口，需结构校核）→ 结构/安全/电气/PLC → STEP 逐实体**拓扑**身份（本轮只做导出侧）。

## 文档与 KB / 安全

- R11/R12 这几份文档**都不在 `KB_DOC_FILES`**（`src/agent/kb/index.ts`，13 份）→ 改它们**不需要** `kb:build`，统计仍 13/454/434,531；改那 13 份中的任何一份必须重建，否则 `test/agent/kb-freshness.test.mjs` 会红。
- 不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，不要把其中密钥复制进仓库或文档。IO 草案地址 `null` 是有意设计。
- 怀疑残留 sidecar 先 `npm run doctor:sidecar -- --json` 看 `scanned` / `sidecars` 计数，再决定 `--kill`（默认 dry-run）。
