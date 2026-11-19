# R11 验收摘要（2026-11-19）

> 用途：**可移交的验收摘要**，供下一位接手者/复审者独立核对。不复述过程、不复制日志全文、不含密钥。
> 完整迭代报告见 `docs/desktop/R11-ITERATION.md`；通道口径与归零决策见 `docs/desktop/R11-CHANNEL-SWEEP.md`；下一步见 `HANDOFF-NEXT-SESSION.md`。

## 1. 结论

- **本机验收 PASS**：13 项门禁全部 `exit 0`（`tsc` / 全量 / focused / 定向 91 / `verify:step` / tower 16·8 / `eval` / `channel` 2·16 / `build:ext` / `smoke` / `doctor` dry-run 与 `--kill`）；无受控红项。
- **三包落地 + 整改闭环**：对抗审查 P1 × 4 全部闭合，复审判定「**有条件通过**」，无新 P0/P1；余 P2 × 2 已在文档层面披露（见 §5）。
- **`sweep` 仍 fail、`feasible=false`**：本轮只收口口径与证据，没有、也不可能把通道修成 0。**不得把 30/30 读成「通道已通」。**
- **已推送、CI 只到 job 级**：R11 4 笔在 `origin/main`（末笔 `1d2bad6`）；CI run `44533462036` **attempt1 红在 apt 基础设施**（`Qt + OCCT 视口` 安装步 exit 100，0 断言跑到）、**attempt2 7/7 success** 挂 `1d2bad6`。**无安装包、无 Release。** 本机 13 项数字仍是本机读数，不是 CI 读数。

## 2. 受验对象

| 项 | 值 |
|---|---|
| 仓库 / 树 | `owlco001/automation-cad-prototype` @ `/tmp/automation-cad-prototype`，`main 1d2bad6`（= `origin/main`）+ **工作树干净**；R11 交付 = 4 笔已推（`9faa2a6` / `16a48cc` / `e3dcc33` / `1d2bad6`，基线 `036b548`） |
| 包 A（5 文件） | `src/machine/interference-states.ts`、`scripts/verify-channel.mjs`、`test/machine/buffer-tower-channel.test.mjs`、`docs/desktop/{R10-ITERATION,R11-CHANNEL-SWEEP}.md` |
| 包 B（5 文件） | `electron/parametric-start-view.ts`(新)、`electron/ipc.ts`、`src/desktop-api.d.ts`、`src/parametric/ui.ts`、`test/parametric/start-view.test.mjs`(新) |
| 包 C（4 文件） | `scripts/sidecar-doctor.mjs`(新)、`package.json`、`test/meta/sidecar-doctor.test.mjs`(新)、`docs/desktop/SIDECAR-DOCTOR.md`(新) |
| 工具链 | node v26.7.0 / npm 11.19.0 / tsc 5.9.3 / vite 7.3.7，cwd = `desktop/` |
| 环境 | 容器内 root，Electron 需 `--no-sandbox`；图形门禁走 xvfb |
| 证据目录 | `/root/.hermes/cache/scratch/cad-r11-final/`（各门禁 `.log` / `doctor-*.json` / CI `ci.json`、`ci2.json`、`ci-qt-failure.log`、`ci-qt-attempt2.log`）；**scratch 永不提交** |

## 3. 门禁结果（本机实跑，同一棵树、串行）

| # | 门禁 | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | **exit 0**，0 诊断 |
| 2 | `npm test`（全量） | **3750 tests / 3747 pass / 3 skip / 0 fail**，124,349.554638 ms |
| 3 | `npm run test:focused` | **416 / 416**，0 fail，25,403.946015 ms |
| 4 | 三包定向 `node --test` | **91 / 91**（23 + 8 + 15 + 22 + 23） |
| 5 | `verify:step`（真内核） | **7 / 7**，`state=ready port=7443 wait=3266ms start=681ms`，85 件 / 1,930,477 B |
| 6 | `verify:step-tower --levels 16 --require-full` | **23 / 23**，`identity=PASS(144/144)`、`exempt=2/14`、`declared=2 undeclared=0 stale=0` |
| 7 | `verify:step-tower --levels 8 --require-full` | **16 / 16**（9 内核 + 6 身份 + 1 条边界显式 N/A） |
| 8 | `eval:tasks --require-full` | **13 / 13**，`skipped=0 env_skipped=0 undeclared_skips=0 degraded=false` |
| 9 | `verify:channel --levels 2` / `--levels 16` | **30 / 30** · **30 / 30**（正向 16 / 负向 14，N1..N14），均 exit 0；`dedupedPairs` 4 / 60 与派生值逐值相等 |
| 10 | `npm run build:ext` | **exit 0**：extension 2,946,989 B / gzip 922,141 B / wasm 7,604,031 B / total 10,551,020 B |
| 11 | Electron smoke | **`SMOKE_OK`、exit 0、0 FAIL、4 个显式 SKIP**；`STARTUP_METRICS totalMs=468.234` |
| 12 | `doctor:sidecar`（dry-run） | **2 个孤儿**（7431 / 7445，PPID=1，9h00m / 5h18m，≈894 MB），`targets=[]`、`killed=[]`、cmdline `--token <redacted>`、无裸 token |
| 13 | `doctor:sidecar --kill` | **回收成功**：两个 pid 均退出、端口释放、复扫 `sidecars=[]`，**exit 0** |

- **全量增量可对账**：3750 = 基线 3726 + **24**（B 8 + C 15 + A 1）；focused 415 → **416** 是同一笔 +1。
- 4 个 SKIP 均为显式原因：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。
- 启动计时：`totalMs=468.234`，零点 = **main 模块求值起点**（不含 Electron bootstrap 与 main 静态 import），`Σ sincePreviousMs ≈ totalMs`；**是口径读数，不是性能结论**（无跨版本对照）。
- 以上 13 项**不经 CI**（其中 `verify:channel` / `verify:step-tower` / `doctor:sidecar` 完全不在 CI 内）；CI 的结论见 §3.1，只有 job 级。

### 3.1 CI（远端，run `44533462036` @ `1d2bad6`）

| 次 | 结论 | 关键点 |
|---|---|---|
| attempt1 | **failure**（6/7 job 绿） | `Qt + OCCT 视口`：步 3「安装 Qt6 + OCCT 开发包 + Xvfb」apt 取 `libocct-* 7.9.2+dfsg-4` 全部 `Connection failed` + 多次 `503 Service Unavailable` → **exit 100**；步 4/5（OCCT 编译、视口自检）**skipped** |
| attempt2 | **success 7/7** | 同 job 重跑：apt 装成 → `-- OCCT AIS 视口：启用` → xvfb 视口自检过；其余 6 job 同 attempt1 |

- **attempt1 是基础设施瞬时故障，不是断言红**：红在 apt 网络步，**0 条断言被执行**。**这条红保留作证据，不得写成「从未红过」或「一次就绿」。**
- attempt2 的绿只挂 `1d2bad6`；CI 7 job = `tsc + unit tests`（含 `npm test`、`eval:tasks`）、`FeatureTree real geometry`、`Electron smoke`、`Qt client build`、`Qt + OCCT 视口`、两个 Windows 编译。

## 4. 这份验收**不**证明什么

1. **升降通道未通**：`sweep` 仍 fail —— 16 层 **270 确认 + 135 待复核 = 405 步累计**（去重 **60 对**，全为 `lift-platform` × 托板族），`reviewStatus=fail`。`verify:channel` 是**诊断脚本**，30/30 是**尺子自证**，不是结构/安全验收。
2. **真实塔 `feasible=false`**：blockers 仍 `load-passes-shelf` + `stroke-shortfall`；rest `unsupported`、carried `diagnostic-only`。外移变体归零（0+0 / pass）但 `feasible` 仍 false —— **归零 ≠ 可行**。
3. **两条归零路未实施**：台面缩回 240 mm / 托板开 240 缺口都是**机构变更 + 结构校核**（前者承托带宽与抗倾覆、后者 349 mm 悬臂与断辊），且 gap ≥240 与现有 `minBandOverlapXmm=1900` 冲突窗 80 mm；本轮只出决策书。
4. **STEP 只到名字/包络级**：每件包络内 ≥1 个 B-Rep 顶点 + 精确件号/宿主/声明件存在，**不是逐实体身份，不是制造验收**。
5. **结构/安全/电气/PLC 全未做**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO 地址 `null`、`executable=false`。
6. **CI 只是 job 级绿，覆盖不到通道尺子**：`44533462036` attempt2 7/7 只说明该 SHA 上 `tsc + unit`、`eval:tasks`、smoke、Qt 各平台编译、OCCT 视口自检这些 job 通过；**同 run 的 attempt1 红过**（apt 503，0 断言跑到，已重跑）；CI 不跑 `verify:channel` / `verify:step-tower` / `doctor:sidecar`，§3 的 13 项仍是本机读数。**CI 绿不改 `sweep` fail / `feasible=false`。**
7. **无安装包**：`build:ext` 只是扩展产物与体积门禁，不是发行包；未签名、未打 tag、无 Release。

## 5. 已知 P2（放行，不再改）

1. `applyKills` 的「`/proc` stat 读 → `kill` 系统调用」微秒窗：身份闸已把窗口压到微秒级（pid_max=4M 下复用不现实），脚本头与 `SIDECAR-DOCTOR.md` 均已披露。
2. `--resources-root` 写错时 **dry-run 仍 `exit 0` 静默零命中**（只有 `--kill` 校验路径）：`SIDECAR-DOCTOR.md` 已写明「先看 `scanned` / `sidecars` 计数再判空」。

## 6. 移交动作

1. **提交/推送已完成**：R11 4 笔在 `origin/main`（`9faa2a6` / `16a48cc` / `e3dcc33` / `1d2bad6`），工作树干净。后续若再改，仍按 §2 白名单逐个 add；**不要 `git add -A`**，`scratch/` 永不提交。
2. **CI 已出结论**：`44533462036` attempt2 **7/7 success**（attempt1 红在 apt 安装步，见 §1/§3.1/§4.6）；重跑只认 `headSha = $(git rev-parse HEAD)` 的 run；再红先分「基础设施步（apt/网络）」与「断言步」，后者才看 `verify:step` 的 `code/elapsed/exitCode/stderrClass/stderr 尾`。
3. 未完成项按危害：升降通道（`sweep` 405→0，需机构决策）→ 结构/安全/电气/PLC → STEP 逐实体身份。
