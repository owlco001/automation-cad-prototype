# R12 验收回执（2026-11-19）

> 用途：**可移交的一页回执**，供接手者/复审者独立核对。不复述过程、不贴日志全文、不含密钥。
> 能力合同、审查证据、边界全文 → [R12-STEP-IDENTITY.md](R12-STEP-IDENTITY.md)；下一步 → [`HANDOFF-NEXT-SESSION.md`](../../HANDOFF-NEXT-SESSION.md)。

## 1. 结论

- **本机 12 道门禁全绿、exit 0**：`tsc` / 定向 127 / focused 424 / 全量 3798 / `verify:step` 7/7 / tower 16 层 27/27 与 8 层 20/20 / `eval` 13/13 / `channel` 2·16 各 30/30 / `build:ext` / smoke / `regen` 61 / `doctor` dry-run。
- **R12 能力**：`/build` 可**选择性**多导出一份非融合 `identity.step`；build 路径门禁**强制**请求它并做原始装配树回读，追加 4 条判据。**原制造默认路径不变**（不请求则无此文件，原制造导出调用保持原样，不声明跨请求字节一致）。
- **不是制造认证**：件号 / 实体计数 / ±1 mm 网格包络对上，**只**等于导出侧身份齐全；**不证明**伴生件与融合制造 STEP 的拓扑/形状等价。
- **代码索引**：`1671f36`（P1）+ `b9f377a`（P2），共 9 文件（4 改 5 新）；`10c2224` 是 R12 之前的基线。推送及最终 HEAD 按实际 Git 状态核对，**本文所有门禁数字均为本机验证**。

## 2. 受验对象

| 项 | 值 |
|---|---|
| 仓库 / 树 | `owlco001/automation-cad-prototype` @ `/tmp/automation-cad-prototype`；受验代码内容归档于 `1671f36` / `b9f377a`，另有文档提交；交付 HEAD 以实查为准 |
| 代码提交 | `1671f36` 身份件导出（5 文件：`spike/build123d/app.py`、`electron/parametric.ts`、`identity-export.test.mjs`、2 个 STEP 夹具）；`b9f377a` 回读与门禁（4 文件：`src/cad/step-entities.ts`、`scripts/verify-step-tower.mjs`、`step-entities.test.mjs`、`verify-step-tower.test.mjs`） |
| 解释器 / 工具链 | `AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python`（build123d 0.13.0）；node v26.7.0 / tsc 5.9.3 / vite 7.3.7；cwd `desktop/` |
| 证据目录 | `/root/.hermes/cache/scratch/cad-r12-final/`（`gates-summary.json` + 逐门禁 `.log`）；**scratch 永不提交** |

## 3. 门禁读数（同树、串行、`pipefail` + `PIPESTATUS` 取真实退出码）

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0，0 诊断 |
| 定向 4 文件 | **127 / 127**（12 + 28 + 65 + 22） |
| `test:focused` | **424 / 424** |
| `npm test` | **3798 / 3795 pass / 3 skip / 0 fail**，129,159.907445 ms（基线 3750/3747/3/0，增量 **+48** = 28 + 12 + 8） |
| `verify:step` | **7 / 7**，85 件 / 89 solids / 613 faces / 6000×1495×930 |
| tower 16 层 `--require-full` | **27 / 27**；`ids 146/146`、`solids 150/150`、`unionDelta 0/0/0`、`bboxMaxDelta 0.1823 mm`、`tol 1 mm(fixed)` |
| tower 8 层 `--require-full` | **20 / 20**；`ids 90/90`、`solids 94/94`、`unionDelta 0/0/0` |
| `eval:tasks --require-full` | **13 / 13**，`skipped 0` / `degraded false` |
| `verify:channel` 2 / 16 层 | 各 **30 / 30**，0 失败 |
| `build:ext` | exit 0（total 10,551,020 B） |
| `smoke` | `SMOKE_OK`，4 条显式降级，`PLC_HISTORY_READ_FAILED=0`、`STARTUP_METRICS_ERROR=0` |
| `regen:pv-buffer` / `doctor --json` | `ok=true checks=61 failed=0`（隔离 userData）/ `scanned=347 targets=0 killed=0` |

- **增量严格对账**：28（`step-entities` 新）+ 12（`identity-export` 新）+ 8（`verify-step-tower` 追加，未删既有用例）= **48**；只有这 3 个测试文件与基线不同。
- **口径更正**：架构报告「`verify-step-tower` 基线 47」已过期，实为 **57 reported**（55 个 `test(`），不可用 `93−47` 当增量。
- smoke 的 `STARTUP_METRICS totalMs=378.7` 只从 **module evaluation** 起算，**是口径读数，不是提速证据**。

## 4. 审查闭环

- 对审 **P1 × 3 全闭**：并集**异口径**（拓扑包络 vs 网格包络，圆柱恒差 19.85 mm）→ 两侧同走 `STEP_READ_PARAMS` 网格包络；**软链/字符串归属** → realpath + 拒 identity 软链；**容差放大** → 常量 1 mm、>1 `capped`、非法值判红。复审无 P0/P1 残留，附带取证与文案条件亦已补齐。
- **M7 事实链**：初报 7/7 不实 → 复审复跑 **6/7**（M7 `GREEN`）→ 总管补 `unionDeltaMm === null` 断言 → 最终亲跑 **7/7 RED**。首轮 6/7 如实保留。

## 5. 这份回执**不**证明什么

1. **通道未通**：16 层 sweep **405 步累计（270 确认 + 135 待复核）**、去重 **60 对**、`reviewStatus=fail`、**`feasible=false`**；2 层 19 步 / 18 确认 + 9 待复核 = 27 步累计 / 去重 4 对。`30/30` 只是关系断言自证，不是结构/安全验收。
2. **真实多层取放未实现**，已有多层几何；两条归零路线只是决策书，未做机构变更与校核。
3. **结构/安全/电气/PLC 未验收**：`structure.accepted:false`、IO `null`、`executable=false`。
4. **STEP 身份只到导出侧**：不证明伴生件与制造 STEP 拓扑/形状等价；bbox 非唯一几何指纹；侧车 `box`/`cylinder` 近似不是真实特征认证。
5. **regen 有登记缺口**：`slotsFromGeometry=8` vs `claimedSlots=16`、`aligned=false`，未修。
6. **无安装包、无 Release**：`build:ext` 只是扩展产物与体积门禁。
7. **CI 以同 SHA 实跑为准**：`ci.yml` 已有 tower 16/8 `--require-full`，新身份检查随该步骤进入；channel 2/16 是独立自证；`doctor:sidecar` 不在 CI。远端 `44536871871` @ `10c2224` 7/7 是 **R12 之前**的 run。**最终判定只认 `headSha == 交付 HEAD` 的 run，按 job 级读；回执由实跑写入 `scratch/FINAL-RECEIPT.json`，本文不预写成功。**

## 6. 移交动作

1. 提交/推送：仅 `1671f36` / `b9f377a` 两笔代码 + 本轮 5 份文档；**不要 `git add -A`**，`scratch/` 永不提交，`git diff --check` 须无输出。
2. 推送后按 `headSha == HEAD` 找 run，按 job 级读；红先分「基础设施步（apt/网络）」与「断言步」，后者才看 `verify:step` 的 `code/elapsed/exitCode/stderrClass`。
3. 未完成项按危害：升降通道（405 → 0，需机构决策）→ 结构/安全/电气/PLC → STEP 逐实体身份（本轮只在**导出侧**）。
