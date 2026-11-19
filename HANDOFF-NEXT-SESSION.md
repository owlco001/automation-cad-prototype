# AutomationCAD 下一会话交接

更新时间：2026-11-19（**R11 收口：三包 + 整改 + 复审全部完成；4 笔已推（末笔 `1d2bad6` = `origin/main`）；CI `44533462036` 首跑红在 apt 基础设施、重跑 attempt2 7/7 绿；`sweep` 仍 fail；无安装包/Release**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 完整报告 → `docs/desktop/R11-ITERATION.md`；可移交验收记录 → `docs/desktop/R11-ACCEPTANCE.md`；
> 通道口径与两条归零路线决策书 → `docs/desktop/R11-CHANNEL-SWEEP.md`；孤儿 sidecar 治理 → `docs/desktop/SIDECAR-DOCTOR.md`。
> 不要在本文堆历史（R10 及更早见 `docs/desktop/R10-ITERATION.md`、`git show e480f57:HANDOFF-NEXT-SESSION.md`）。

## 现状

- **代码状态**：`HEAD = 1d2bad6`（= `origin/main`），**工作树干净（0 改动）**。R11 交付 = **4 笔已推**：`9faa2a6`（B 启动失败分类）→ `16a48cc`（C 孤儿 sidecar 体检/回收）→ `e3dcc33`（A 通道证据派生）→ `1d2bad6`（文档），共 14 文件（8 改 6 新）；基线 `036b548` 是 R10 收口文档提交（R10 代码 6 笔、末笔 `e1d1138` 亦在远端）。
- **三包落地并整改完毕**：A 升降通道口径收口（判据未改）、B 启动失败分类结构化透传、C 孤儿 sidecar 体检/回收；对抗审查 **P1 × 4 全闭**，复审「**有条件通过**」，余 P2 × 2 已在文档披露（§P2）。
- **门禁本机全绿、结论未变**：3750/3747/3 skip/0 fail、tsc 0、定向 91/91、focused 416/416、`verify:step` 7/7、tower 16 层 23/23 与 8 层 16/16、eval 13/13 零 skip、`verify:channel` 2/16 层各 30/30、`build:ext` exit 0、smoke `SMOKE_OK`。**但 `sweep` 仍 fail、`feasible=false`；这些是本机数字，不是 CI 读数。**
- **CI（远端，run `44533462036` @ `1d2bad6`）**：**attempt1 红** —— `Qt + OCCT 视口` job 的「安装 Qt6 + OCCT 开发包 + Xvfb」步从 `security.ubuntu.com` 取 `libocct-*` `7.9.2+dfsg-4` 连续 `503 Service Unavailable` / `Connection failed`，`E: Unable to fetch some archives` → **exit 100**；同 job 后续「配置与编译（OCCT=ON）」「OCCT 视口自检」**均 skipped（0 条断言跑到）**，其余 6 job 绿。判定**基础设施瞬时故障，不是断言红**，已重跑 → **attempt2 7/7 success**（含该 job：apt 装成、`-- OCCT AIS 视口：启用`、xvfb 视口自检通过）。**attempt1 那次红如实保留作证据，不改写成「从未红过」。**

## R11 三包（细节见 R11-ITERATION.md §1）

| 包 | 改了什么 | 关键证据 |
|---|---|---|
| **A** 通道口径 | `collectChannelPairs` **opt-in（默认 false）**、`SWEEP_EVIDENCE` 一行 JSON + 3 条正向自证、`counts` 严格 `{30,16,14}`、17 层回归 + 3 处变异自证（22→23 例） | 去重 60 = 15 层 × 4（派生一致）；口径改「每命中步 2 确认 + 1 待复核」= 135×3 = 405 |
| **B** 启动失败分类 | 新增 `parametric-start-view.ts` 纯函数（6 字段逐项搬、**剥 port/token**）；`ipc.ts` 改调用；`d.ts` 6 字段 + 联合同集；UI 收 `signal` + 文案后缀（无新 DOM） | 8 例（含「payload 无 token/port」双查）；**message 文案零变化** → `parametric-sidecar` 22/22 未改 |
| **C** 孤儿 sidecar | `sidecar-doctor.mjs`：默认 dry-run、三闸 `--kill`、**`startTicks` 身份闸**（发信号前复验）、认 `resources/parametric/app.py`（需 `--token`，`--resources-root` 可 pin）、`--min-age-min 0` 退 2 | 15 例；dry-run 列出 2 孤儿不杀；`--kill` 实测两个均回收、端口释放、复扫 0 |

## 门禁（本机、同一棵树、串行；日志 `/root/.hermes/cache/scratch/cad-r11-final/`）

> 下表**全部是本机读数**。CI 只给 job 级结论（run `44533462036` attempt2 7/7），且**不跑** `verify:channel` / `verify:step-tower` / `doctor:sidecar`。

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断 |
| 全量 `npm test` | **3750 tests / 3747 pass / 3 skip / 0 fail / 124,349.554638 ms**（= 基线 3726 + 24：B8 + C15 + A1） |
| focused / 三包定向 | **416 / 416** · **91 / 91**（23+8+15+22+23） |
| `verify:step`（真内核） | **7 / 7**，`state=ready port=7443 wait=3266ms start=681ms` |
| `verify:step-tower` 16 层 / 8 层 | **23 / 23**（`identity=PASS(144/144)`、`exempt=2/14`）/ **16 / 16** |
| `eval:tasks --require-full` | **13 / 13**，`skipped=0 degraded=false` |
| `verify:channel --levels 2 / 16` | **30 / 30** · **30 / 30**（正向 16 / 负向 14，N1..N14），exit 0 |
| `build:ext` / smoke | **exit 0**（total 10,551,020 B）/ **`SMOKE_OK`**、0 FAIL、4 显式 SKIP、`totalMs=468.234` |
| `doctor:sidecar` | dry-run 2 孤儿（≈894 MB）；`--kill` **回收成功**（进程消失/端口释放/复扫 0），exit 0 |

### CI（远端，run `44533462036` @ `1d2bad6`）

| 次 | 结论 | 关键点 |
|---|---|---|
| attempt1 | **failure**（6/7 job 绿） | `Qt + OCCT 视口` 红在**安装步**：apt 取 `libocct-modeling-data` / `modeling-algorithms` / `ivtk-dev` / `data-exchange-dev` `7.9.2+dfsg-4` 全部 `Connection failed`（另有 `503`）→ **exit 100**；编译步、视口自检步 **skipped** |
| attempt2 | **success 7/7** | 同 job 重跑：apt 装成（`Setting up libocct-*-dev:amd64 (7.9.2+dfsg-4)`）→ `-- OCCT AIS 视口：启用` → xvfb 视口自检过；其余 6 job 与 attempt1 同 |

- **attempt1 是基础设施瞬时故障，不是断言红**：红在 apt 网络步，4/5 步 skipped，**代码与测试一条都没被执行**。证据留在 `scratch/cad-r11-final/ci-qt-failure.log`；重跑日志 `ci-qt-attempt2.log`、run JSON `ci.json` / `ci2.json`。
- **CI 覆盖范围（7 个 job）**：`tsc + unit tests`（内含 `npm test`、`eval:agent`、`eval:tasks`）、`FeatureTree real geometry (build123d)`、`Electron smoke (xvfb)`、`Qt client build`、`Qt + OCCT 视口`、`Qt 客户端（Windows 编译）`、`Qt + OCCT（Windows 编译）`。**`verify:channel` / `verify:step-tower` / `doctor:sidecar` 不在 CI 内。**
- **CI 绿不改通道结论**：`sweep` 仍 fail、`feasible=false`（见下）。

## 结论限制（任何一轮都不许越过）

1. **升降通道未通**：`sweep` 仍 **fail** —— 16 层 **270 确认 + 135 待复核 = 405 步累计**，**去重 60 对**（全是 `lift-platform` × 托板族），`reviewStatus=fail`，**`feasible=false`**。
2. **归零路径未实施**：台面缩回 240 mm / 托板开 240 缺口都是**机构变更 + 结构校核**（缺口 ≥240 与 `minBandOverlapXmm=1900` 冲突窗 80 mm），本轮只出决策书。**外移变体归零但 `feasible` 仍 false → 归零 ≠ 可行。**
3. **承托结论不变**：rest `unsupported`、carried `diagnostic-only`；`verify:channel` 30/30 是**尺子自证**（诊断脚本，`feasible=false` 仍 exit 0），不是结构/安全验收。
4. **STEP 只到名字/包络级**：每件包络内 ≥1 顶点 + 精确件号/宿主/声明件存在，**不是逐实体身份，不是制造验收**。
5. **结构/安全/电气/PLC 未做**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO `null`、`executable=false`。
6. **CI 只有 job 级绿，不是通道证据**：`44533462036` attempt2 7/7 挂在 `1d2bad6`，但**同一个 run 的 attempt1 红过**（apt 503，0 断言跑到）；CI 不跑 `verify:channel` / `verify:step-tower` / `doctor:sidecar`，这几项只能按本机读数引用。**无安装包、无 Release**：`build:ext` 只是扩展产物与体积门禁，未签名、未打 tag、无 Release。

## P2（放行，不再改代码）

- `applyKills` 的 `/proc` stat → `kill` 微秒窗：身份闸已压到微秒级，脚本头与 `SIDECAR-DOCTOR.md` 已披露。
- `--resources-root` 写错时 **dry-run 仍 exit 0 静默零命中**（只 `--kill` 校验）：文档已写「先看 `scanned` / `sidecars` 计数再判空」。

## 下一会话顺序

1. `git status --short`（应为空）/ `git log --oneline -4` → 确认 `HEAD = origin/main = 1d2bad6`、R11 四笔都在远端。**不要 `git checkout --`、不要 `git stash`、不要 amend**：改历史会让 attempt2 的绿与这个 SHA 脱钩。
2. 提交/推送已收口（`9faa2a6` / `16a48cc` / `e3dcc33` / `1d2bad6`）。后续若再改代码/测试，仍按白名单逐个 add（A/B/C 三包 + 文档），**`git add -A` 禁用，`scratch/` 永不提交**；提交后 `git diff --check` 无输出。
3. CI 已有结论：run `44533462036` **attempt2 7/7**（attempt1 红在 apt，见上）。重跑用 `gh run rerun 44533462036`，只认 `headSha = $(git rev-parse HEAD)` 的 run。**再红先分「基础设施步（apt/网络）」和「断言步」**——本轮 attempt1 就是前者；断言红才看 `verify:step` 打的 `code/elapsed/exitCode/stderrClass/stderr 尾`（R10 包 D 就是为这条），不要先改测试。
4. 任何再次改源码/测试后按此顺序整轮重跑（同树、串行）：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   node --test test/machine/buffer-tower-channel.test.mjs test/parametric/start-view.test.mjs \
     test/meta/sidecar-doctor.test.mjs test/parametric-sidecar.test.ts test/meta/ci-strict-gates.test.mjs  # 91
   npx tsc --noEmit                                                   # exit 0
   npm run test:focused                                               # 416/416
   timeout -k 15 900 npm test                                         # 3750/3747/3/0
   npm run verify:step && npm run verify:step-tower -- --levels 16 --require-full
   npm run verify:step-tower -- --levels 8 --require-full
   npm run eval:tasks -- --require-full
   AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python npm run verify:channel -- --levels 2
   AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python npm run verify:channel -- --levels 16
   npm run build:ext && npm run smoke && npm run doctor:sidecar
   ```
5. 之后才是老欠账：升降通道**拍板**（路线 ①缩回 240 / ②开 240 缺口，见 `R11-CHANNEL-SWEEP.md` §3，需结构校核）→ 结构/安全/电气/PLC → STEP 逐实体身份。

## 文档与 KB / 安全

- R11 这几份文档**都不在 `KB_DOC_FILES`**（`src/agent/kb/index.ts`，13 份）→ 改它们**不需要** `kb:build`，统计仍 13/454/434,531；改那 13 份中的任何一份必须重建，否则 `test/agent/kb-freshness.test.mjs` 会红。
- 不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，不要把其中密钥复制进仓库或文档。IO 草案地址 `null` 是有意设计。
- 孤儿 sidecar 已回收（原 2040641/7431、2114164/7445）；以后怀疑残留先 `npm run doctor:sidecar -- --json` 看，再决定 `--kill`。
