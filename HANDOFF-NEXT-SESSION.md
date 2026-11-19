# AutomationCAD 下一会话交接

更新时间：2026-11-19（**R11 收口：三包 + 整改 + 复审全部完成，14 文件在工作树未提交；`sweep` 仍 fail；无 CI、无发版**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 完整报告 → `docs/desktop/R11-ITERATION.md`；可移交验收记录 → `docs/desktop/R11-ACCEPTANCE.md`；
> 通道口径与两条归零路线决策书 → `docs/desktop/R11-CHANNEL-SWEEP.md`；孤儿 sidecar 治理 → `docs/desktop/SIDECAR-DOCTOR.md`。
> 不要在本文堆历史（R10 及更早见 `docs/desktop/R10-ITERATION.md`、`git show e480f57:HANDOFF-NEXT-SESSION.md`）。

## 现状（三句）

- **代码状态**：`HEAD = 036b548`（= `origin/main`），**工作树 14 个文件未提交（8 改 6 新）** —— 这就是 R11 的全部交付，全部未推送、**无 CI run**。R10 的 6 笔（末笔 `e1d1138`）已在远端，不含本轮内容。
- **三包落地并整改完毕**：A 升降通道口径收口（判据未改）、B 启动失败分类结构化透传、C 孤儿 sidecar 体检/回收；对抗审查 **P1 × 4 全闭**，复审「**有条件通过**」，余 P2 × 2 已在文档披露（§P2）。
- **门禁本机全绿、结论未变**：3750/3747/3 skip/0 fail、tsc 0、定向 91/91、focused 416/416、`verify:step` 7/7、tower 16 层 23/23 与 8 层 16/16、eval 13/13 零 skip、`verify:channel` 2/16 层各 30/30、`build:ext` exit 0、smoke `SMOKE_OK`。**但 `sweep` 仍 fail、`feasible=false`；本机数字不是 CI 读数。**

## R11 三包（细节见 R11-ITERATION.md §1）

| 包 | 改了什么 | 关键证据 |
|---|---|---|
| **A** 通道口径 | `collectChannelPairs` **opt-in（默认 false）**、`SWEEP_EVIDENCE` 一行 JSON + 3 条正向自证、`counts` 严格 `{30,16,14}`、17 层回归 + 3 处变异自证（22→23 例） | 去重 60 = 15 层 × 4（派生一致）；口径改「每命中步 2 确认 + 1 待复核」= 135×3 = 405 |
| **B** 启动失败分类 | 新增 `parametric-start-view.ts` 纯函数（6 字段逐项搬、**剥 port/token**）；`ipc.ts` 改调用；`d.ts` 6 字段 + 联合同集；UI 收 `signal` + 文案后缀（无新 DOM） | 8 例（含「payload 无 token/port」双查）；**message 文案零变化** → `parametric-sidecar` 22/22 未改 |
| **C** 孤儿 sidecar | `sidecar-doctor.mjs`：默认 dry-run、三闸 `--kill`、**`startTicks` 身份闸**（发信号前复验）、认 `resources/parametric/app.py`（需 `--token`，`--resources-root` 可 pin）、`--min-age-min 0` 退 2 | 15 例；dry-run 列出 2 孤儿不杀；`--kill` 实测两个均回收、端口释放、复扫 0 |

## 门禁（本机、同一棵树、串行；日志 `/root/.hermes/cache/scratch/cad-r11-final/`）

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

## 结论限制（任何一轮都不许越过）

1. **升降通道未通**：`sweep` 仍 **fail** —— 16 层 **270 确认 + 135 待复核 = 405 步累计**，**去重 60 对**（全是 `lift-platform` × 托板族），`reviewStatus=fail`，**`feasible=false`**。
2. **归零路径未实施**：台面缩回 240 mm / 托板开 240 缺口都是**机构变更 + 结构校核**（缺口 ≥240 与 `minBandOverlapXmm=1900` 冲突窗 80 mm），本轮只出决策书。**外移变体归零但 `feasible` 仍 false → 归零 ≠ 可行。**
3. **承托结论不变**：rest `unsupported`、carried `diagnostic-only`；`verify:channel` 30/30 是**尺子自证**（诊断脚本，`feasible=false` 仍 exit 0），不是结构/安全验收。
4. **STEP 只到名字/包络级**：每件包络内 ≥1 顶点 + 精确件号/宿主/声明件存在，**不是逐实体身份，不是制造验收**。
5. **结构/安全/电气/PLC 未做**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO `null`、`executable=false`。
6. **无安装包、无 Release、无 CI 读数**：14 文件未提交未推送；本机数字一律不是 CI 证据。

## P2（放行，不再改代码）

- `applyKills` 的 `/proc` stat → `kill` 微秒窗：身份闸已压到微秒级，脚本头与 `SIDECAR-DOCTOR.md` 已披露。
- `--resources-root` 写错时 **dry-run 仍 exit 0 静默零命中**（只 `--kill` 校验）：文档已写「先看 `scanned` / `sidecars` 计数再判空」。

## 下一会话顺序

1. `git status --short` / `git log --oneline -3` → 确认工作树仍是**14 个 R11 文件**、`HEAD = origin/main = 036b548`。**不要 `git checkout --`、不要 `git stash`、不要 amend**（14 文件是唯一交付物）。
2. **先要授权再提交**：按白名单逐个 add（A/B/C 三包 + 4 份文档 + 2 份新文档），**`git add -A` 禁用，`scratch/` 永不提交**；提交后 `git diff --check` 无输出。
3. push 后才有 CI：`gh run list --limit 3` 取 `headSha = $(git rev-parse HEAD)` 的 run → `gh run watch <id>`。**出绿前一律写「无 CI 读数」**；若红，先看 `verify:step` 打的 `code/elapsed/exitCode/stderrClass/stderr 尾`（R10 包 D 就是为这条），不要先改测试。
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
