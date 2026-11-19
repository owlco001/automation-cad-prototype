# AutomationCAD 下一会话交接

更新时间：2026-11-19（**R10：5 笔已推 `9409f3e`；sidecar 修复已提交 `e1d1138` 但尚未推送；CI 第二跑仍红 = 启动早退、真因未证；工作区只剩 4 份文档待提交**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 本轮完整报告 → `docs/desktop/R10-ITERATION.md`；可移交验收记录 → `docs/desktop/R10-ACCEPTANCE.md`；PV 侧软件口径 → `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`。
> 不要再往本文件堆历史（旧 371 行原文见 `git show e480f57:HANDOFF-NEXT-SESSION.md`）。

## 现状（三句）

- **代码状态**：`HEAD = e1d1138`（本机，领先 `origin/main@9409f3e` 一笔）。R10 代码共 **6 笔**：其中 **5 笔已推**（`137a68d` 严格档 + 负向自证 → `0379e15` 豁免精确化 → `ba8020d` 启动计时 + ENOENT 静音 → `94ec7e6` 文档收口 → `9409f3e` CI 依赖前置），第 6 笔 `e1d1138`（sidecar 早退诊断 + 启动竞态，4 文件 +604/−32）**已提交、尚未推送**。
- **CI 两次都未绿，原因不同**：
  ① 首跑 run `44506016602`（head `94ec7e6`）：`featuretree-geometry` job 没跑 `npm ci`，`eval:tasks` import `adm-zip` 即 `ERR_MODULE_NOT_FOUND`，**一条断言都没跑到**；已由 `9409f3e` 修（setup-node 24 + `npm ci` 放在评测前、job 100 min、守卫 ⑦ 判依赖前置/顺序）。
  ② 第二跑 run `44508941094`（job `135507781027`，head `9409f3e`）：`npm ci`、装配与体积步骤**都过了**，红在 `verify:step` —— sidecar 起来后**约 0.36 s 自行退出**（探测两个端口 7440/7435），旧实现把这次死亡上报成「健康检查在 3 秒内未通过」。**具体真因（Python 为何退出）仍未证**：旧代码 `child.stderr?.resume()` 吞掉全部 stderr，日志里没有任何 traceback；**不许把 0.36 s 读成内核慢**（本机 `start=559 ms`，预算 90/120 s）。
- **所以既不能写「CI 已绿」，也不能写「改动全未提交」**：5 笔在远端，sidecar 修复**已提交为 `e1d1138`**（`parametric.ts`、`fake-parametric-sidecar.mjs`、`verify-step-export.mjs`、`test/parametric-sidecar.test.ts`，+604/−32）但**尚未推送**；工作区现在只剩 **4 份交接文档**的改动。**没有安装包发版。**

## 包 D 修复（代码已提交 `e1d1138`；待推送 / CI）

| 项 | 改了什么 | 证据 |
|---|---|---|
| **错误诊断** | `waitHealthy` 三态 `ready / exited / timeout`；早退报 `code/signal/实测 ms`，超时用实值（不再写死「3 秒」）；stderr 4 KB 环形尾缓存，token 完整/分片/截断残片全 `[REDACTED]`；`classifySidecarStderr()` 分 `argparse / missing-module / address-in-use / permission-denied / out-of-memory / traceback / empty / unknown`；`ParametricStartInfo` 增 `elapsedMs/exitCode/signal/stderrClass/stderrTail` | 新增 6 例先红后绿（旧实现 0/6）；`verify:step` 失败路径实测带 `code/elapsed/stderrClass`，仍 exit 1 |
| **启动期竞态** | `handleExit` 在启动期只记证据、不重启（一次 `start()` 只一个端口、一份结论）；`launchActiveSeq` 按 launch 作用域，`finally` 只清自己一代；ready 后崩溃仍自动重启一次 | 「stop 后立刻重启」用例：旧实现 spawns=3 / 终态 `crashed` 必红，新实现 spawns=2 / `unavailable` 绿；**P1 复审通过**（独立 probe 复跑一致） |
| **verify 脚本** | 启动失败打印 `code status elapsed exitCode signal stderrClass` + 脱敏 stderr 尾；`start()` 抛错不丢 code（`START_THREW`）；`waitKernelReady` 回报实测 `wait=…ms`；**阈值与重试未改** | 假 python exit 2 → `EXIT=1` 且证据完整；真内核仍 7/7 |

**确定性 bug（机制已实测，但不是这次 CI 红的已证根因）**：`--token` 与值分行传时，以 `-` 开头的 token 被 Python argparse 当选项名 → `exit 2`（真 `app.py`：分行 **exit 2** / `--token=<值>` **exit 0 并正常监听**；`parse_args()` 在任何 import/绑端口之前，所以症状必然是「~100 ms 自己退出」）。随机 43 字符 base64url 单个以 `-` 开头概率 1/64，**同一 job 两次都踩到 ≈2.6e-4，偏低**；原 stderr 已丢、无法回看 ⇒ 只能记「机制成立 + 签名一致」，**不得写成 CI 那次红的结论**，运行器侧瞬时故障仍并列可能。本次修的是**下次失败一定看得见**（`exited` 不再被误报成超时）。

## 终验实测（本机、同一棵树、串行；日志 `/root/.hermes/cache/scratch/cad-r10-final/*final2.log`）

| 项 | 现行结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断（`tsc-final2.log`） |
| 全量 `npm test` | **3726 tests / 3723 pass / 3 skip / 0 fail / 120,598.912448 ms**（`full-final2.log`） |
| `npm run build:ext` | **exit 0**：extension 2,946,350 B / gzip 921,963 B / wasm 7,604,031 B / total 10,550,381 B（`build-final2.log`） |
| `verify:step`（真内核） | **7/7**，`state=ready port=7449 wait=3212ms start=559ms`（`step-final2.log`） |
| `verify:step-tower --levels 16 --require-full` | **23/23**，`identity=PASS(144/144)`、`exempt=2/14`、`declared=2 undeclared=0 stale=0`（`step16-final2.log`） |
| `eval:tasks --require-full` | **13/13**，`skipped=0 env_skipped=0 undeclared_skips=0 degraded=false`（`eval-final2.log`） |
| `parametric-sidecar.test.ts` / `ci-strict-gates.test.mjs` | **22/22** / **23/23** |

- 本轮**未重跑**（上一轮同树实跑，改动后再引用需整轮重跑）：focused 415/415、smoke `SMOKE_OK`（0 FAIL / 4 个显式 SKIP）、`verify:channel` 2/16 层各 27/27、8 层 16/16、`regen` 61/61、kb 13/454/434,531。
- 旧数字（3719/3716/117,094 ms、3717/3714/119,708 ms、3716/3713/126,150 ms）保留在 R10 报告作演进记录，**不再当结论**；本机数字一律不是 CI 读数。

## 结论限制（任何一轮都不许越过）

1. 真实塔 **`feasible=false`**（`load-passes-shelf` + `stroke-shortfall`）；`verify:channel` 是诊断脚本，27/27 是尺子自证，不是结构/安全校验。
2. **`sweep` 405 命中仍 fail，本轮未复跑**（16 层 42 对 / 270 确认 + 135 待复核），不得改判。
3. **结构/安全/电气/PLC 未做**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO 地址 `null`、`executable=false`。
4. **占位顶点 ≠ 实体认证**：STEP 门禁只到「每件包络内 ≥1 个 B-Rep 顶点」+ 名字级声明，不是逐面/逐实体身份，不是制造验收。

## 下一会话顺序

1. `git status --short` / `git log --oneline -5` → 确认 `HEAD = e1d1138`（领先 `origin/main@9409f3e` 一笔）、工作区只有 **4 份文档**；**不要 `git checkout --`、不要 amend `e1d1138`、不要重排已推送历史**。
2. 只 add 这 4 份文档并提交（例如 `docs: record sidecar fix commit and pending push`）→ `git push origin main`：这一次 push 同时带走代码 `e1d1138` 与文档 → `git rev-parse HEAD` 记 SHA。
3. `gh run list --limit 3` → 确认**新 run**（push 后产生的那一个）的 `headSha` 等于该 SHA → `gh run watch <id>`；**CI 结论只挂这个新 run**（`44506016602` 缺 `npm ci`、`44508941094` sidecar 早退，都只作已知问题证据）。此刻**仍不得写「CI 已绿」**。
4. 任何再次改源码/测试后按此顺序整轮重跑（同会话、同树、串行）：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   node --test test/parametric-sidecar.test.ts test/meta/ci-strict-gates.test.mjs   # 22 / 23
   npx tsc --noEmit                                                                 # exit 0
   npm run test:focused                                                             # 415/415
   timeout -k 15 900 npm test                                                       # 3726/3723/3/0
   npm run verify:step && npm run verify:step-tower -- --levels 16 --require-full   # 7/7 · 23/23
   npm run eval:tasks -- --require-full                                             # 13/13 skipped=0
   npm run build:ext && npm run smoke                                               # exit 0 / SMOKE_OK
   git diff --check                                                                 # 无输出
   ```
5. 之后才是老欠账：升降通道（`sweep` 405→0）、逐实体 STEP 身份、结构/安全/电气/PLC。

落库只 add 白名单文件：**现在只剩 4 份文档** —— `HANDOFF-NEXT-SESSION.md`、`docs/desktop/{R10-ITERATION,R10-ACCEPTANCE,PV-BUFFER-ITERATION-HANDOFF}.md`；代码 4 文件（`desktop/electron/parametric.ts`、`desktop/scripts/{fake-parametric-sidecar,verify-step-export}.mjs`、`desktop/test/parametric-sidecar.test.ts`）已随 `e1d1138` 入库，**不要再加、不要重复提交**。**`scratch/` 永不提交，`git add -A` 禁用。**

## 文档与 KB / 安全

- 上述四份交接文档**都不在 `KB_DOC_FILES`**（`desktop/src/agent/kb/index.ts` 13 份）→ 改它们**不需要** `kb:build`，统计仍 13/454/434,531；改那 13 份中的任何一份必须重建，否则 `test/agent/kb-freshness.test.mjs` 会红。
- 不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，不要把其中密钥复制进仓库或文档。IO 草案地址 `null` 是有意设计。
