# R11 迭代（2026-11-19）：三包落地 + 整改 + 复审

**状态：三包全部落地并整改完毕，复审「有条件通过」；`sweep` 仍 fail、`feasible=false`；4 笔已推（末笔 `1d2bad6` = `origin/main`）；CI run `44533462036` attempt1 红在 apt 基础设施、attempt2 7/7 绿；无安装包、无 Release。** 本文件是本轮完整报告；可移交摘要见 `R11-ACCEPTANCE.md`，通道口径与两条归零路线的决策书见 `R11-CHANNEL-SWEEP.md`。

- 仓库 `/tmp/automation-cad-prototype` @ `main 1d2bad6`（= `origin/main`）；工作树**干净**；R11 交付 = **4 笔已推**（`9faa2a6` / `16a48cc` / `e3dcc33` / `1d2bad6`，基线 `036b548`；合计 14 文件 = 8 改 6 新）
- 证据目录 `/root/.hermes/cache/scratch/cad-r11-final/`（`scratch/` 永不提交）
- 本机门禁数字**不是** CI 读数；CI 只给 job 级结论（§3.1）

---

## 1. 三包（按白名单互不相交，B → C → A 顺序落地）

### 包 A · 升降通道 sweep 口径收口（**判据一字未改**）

| 文件 | 内容 |
|---|---|
| `src/machine/interference-states.ts` | 新增 **opt-in** `collectChannelPairs?: boolean`（默认 `false`）：`true` 时 `states.sweep.channelPairs` 给出不截断的 suspect 对（a/b/确认级别/步数/z 带/重叠量）。默认关闭是硬约束 —— 六十对量级会把 MCP/agent 的 10 KB 工具结果顶爆、四态 summary 被裁成 preview；`src/agent/commands.ts` 未传该参数，回执逐字段不变 |
| `scripts/verify-channel.mjs` | 末段一行 `SWEEP_EVIDENCE`（`--json` 时在 `summary.sweepEvidence`）+ 3 条**正向**自证：① 去重对数由件表派生；② 全部 suspect 对含台面且 x/y 重叠独立复算一致；③ 台面外移变体归零但 `feasible` 仍 false。所有量从件表/几何派生，脚本无 405/60/42/15 常量 |
| `test/machine/buffer-tower-channel.test.mjs` | `counts` 严格 `deepEqual {total:30, positive:16, negative:14}`（不放宽成 ≥）、负向仍恰好 N1..N14、证据 3 条且不带 N 编号、17 层回归、3 处变异自证；**22 → 23 例** |
| `R11-CHANNEL-SWEEP.md`（新） | 口径钉死 + 两条归零路线的设计决策请求 + 承托判据可见/不可见边界 |

**口径修正（本轮唯一交付物的核心）**：

| 数 | 是什么 | 16 层实测 | 与层数关系 |
|---|---|---|---|
| **405** | `confirmedHits + screenHits`，**步累计** | 270 确认 + 135 待复核 | 135 个命中步 ×（**每命中步平均 2 确认 + 1 待复核**）= 405（总量口径，单步分布 0/1/2/3 次） |
| **60** | **去重后的问题对数** | 15 层 × 4 件 | `(levels − 1) × 4`，2 层 = 4 |
| **42** | **单步 `pairs`**（含 38 条已声明连接基线） | 42 = 38 + 4 | **与层数无关**（2/8/16 层都 42） |

上一轮「每命中步 3 确认 + 1 待复核」是 **135 × 4 = 540 ≠ 405**，与脚本自身的 `sumConfirmed === confirmedHits` 闭合断言矛盾，已作废（复审 A-1）。「16 层 42 对干涉」也错：42 是单步对数、其中 38 对是已声明的结构连接。

**不可归零判定**：405 不是误报，是真实几何冲突 —— 台面 x `[−1120,−800]`、y `[−540,540]`（1080 = 托板全宽，**y 向没有走廊**），伸进托板端部 230 mm / 托条 240 mm，塔身不存在能让台面从托板旁过去的通道。三条路里放宽判据/加豁免是造假（与源码明文冲突）、侧叉挪到板外使承托掉到 0（已有负例守着），只剩两条**机构变更**：台面缩回 240 mm 或每层托板开 240 宽缺口 —— 都要结构校核，且现有承托判据看不见缺口侧的悬臂/挠度。**决策书：`R11-CHANNEL-SWEEP.md` §3。**

### 包 B · 启动失败分类透传（半透传 → 结构化）

- 新增 `electron/parametric-start-view.ts`：纯函数 `toPublicStartResult(info)` **逐项**搬 6 字段（`code/elapsedMs/exitCode/signal/stderrClass/stderrTail`，无 spread、不走 getter），**仍剥 `port/token`**；`describeStartFailure()` 格式化「分类 · 实测 ms · exit=」。
- `electron/ipc.ts` 的 `publicStart()` 改调用该纯函数（原来只搬 `ok/status/message/version`，结构化分类全丢）。
- `src/desktop-api.d.ts` 增 6 个可选字段，`code` 联合与 `ParametricStartFailureCode` **同集**；meta 例读 d.ts 文本锁契约（防手写漂移）。
- `src/parametric/ui.ts` 状态增 `stderrClass/elapsedMs/exitCode/signal`，失败时 message 后缀分类段（**不新增 DOM 节点/CSS**）；`stderrTail` 不经 UI 透出。
- 测试 `test/parametric/start-view.test.mjs` **8 例**（6 → 8），含「payload 不含 token/port」双查（键名 + 序列化）与脱敏。
- **message 文案零变化** → `test/parametric-sidecar.test.ts` 22 例**未改**且全绿。

### 包 C · 孤儿 sidecar 治理（外部脚本，启动路径零改动）

- 新增 `scripts/sidecar-doctor.mjs`：扫 `/proc/*/cmdline`，默认 **dry-run**；`--kill` 需三闸全过（`ppid===1`、`pid∉{1,自身}`、年龄 ≥ 阈值）。导纯函数 `classifySidecars` 供测试。
- **判据两种形态**：开发态 `<repoRoot>/spike/build123d/app.py`（逐段相等，不做前缀匹配）+ 打包态 `<resourcesRoot>/parametric/app.py`（额外要求 `--token` 旗标；给 `--resources-root` 时**只认**这一份，fail-closed）；端口 7400–7499；`python*` basename。
- **身份闸（pid 复用）**：record 带 `startTicks`（`/proc/<pid>/stat` 字段 22），SIGTERM 前、SIGKILL 前各重读复验，读不到 = 已退出、对不上 = pid 换人 → **一律不发信号**。
- `--min-age-min 0` **直接退 2**（0 = 关掉年龄闸，不许）；退出码 0 正常 / 1 kill 未达成 / 2 用法错。
- `package.json` 仅 +1 行；**不接 CI**，不进 `npm test` 自动分支。
- 测试 `test/meta/sidecar-doctor.test.mjs` **15 例**（8 → 15）：身份闸 4 例（含「断闸即红」对抗例）+ 打包态 3 例（两种形态 + `--resources-root` pin）。
- 文档 `SIDECAR-DOCTOR.md`（新）已与实现同步（判据/退出码/身份闸/15 例）。

---

## 2. 整改 → 复审链路

| # | 审查发现（P1） | 整改 | 复审 |
|---|---|---|---|
| A-1 | 口径分解式 540 ≠ 405（`R11-CHANNEL-SWEEP.md` 与 `R10-ITERATION.md` 同错） | 两处改为「每命中步 2 确认 + 1 待复核」，容差统一 0.05 | **通过**：17 层 288+144+基线 289 = 577、24 层 414+207+415 = 829，恒等式抽算成立 |
| A-2 | `verify-channel.mjs` filter 后断言「filter 没改变任何东西」，`--levels 17` 实测 §5 三条全红 exit 1（CI 只跑 2/16，门禁看不见） | `splitChannelPairs` 真剔除基线对、`baselineGeometry` 显式扣步数（`channelStepSums + baselineGeometry === confirmedHits/screenHits`），断言与层数无关 | **通过**：2/16/17/24 层各 30/30 exit 0；`SPLIT=false` 变异实测 exit 1 |
| C-3 | `applyKills` 只按 pid 发信号 + `/proc` 存在性判活 → pid 复用窗口内可误杀无关进程 | record 保留 `startTicks`，每次发信号前复验；判活走身份 | **通过**：残余仅「stat 读 → kill 系统调用」微秒窗（pid_max 4M 下不现实），已写入脚本头与 `SIDECAR-DOCTOR.md` |
| C-4 | 只认 `<repoRoot>/spike/...` → 打包态 `resources/parametric/app.py` 孤儿静默漏检仍 exit 0 | 认打包态形态 + `--token` 旗标 + `--resources-root` pin；fixture 覆盖两种形态与 pin（摘分支即红） | **通过**：开发态仓内无 `resources/`，`spike/build123d` 仍 exact，不误判 |
| B（P2 同批） | `describeStartFailure` 生产零调用且与 UI 后缀不同形；UI 无 `signal` | UI 收 `signal`（锁形先红后绿）、`describeStartFailure` 锁形、`--min-age-min 0` 退 2 | **通过**（8/8、15/15） |

**结论：P1 × 4 全闭，无新 P0/P1；余 P2 × 2，均已在文档层面写明限制**：
1. `applyKills` 的 stat→kill 微秒窗（接受，文档已披露）；
2. `--resources-root` 写错时 **dry-run 仍 exit 0 静默零命中**（只有 `--kill` 才校验路径）—— 已在 `SIDECAR-DOCTOR.md` 明确「先看 `scanned/sidecars` 计数再判空」。

---

## 3. 本轮实测（本机、同一棵树、串行；日志 `scratch/cad-r11-final/`）

| 项 | 结果 | 日志 |
|---|---|---|
| `npx tsc --noEmit` | **exit 0**，0 诊断 | `tsc.log`（0 B） |
| 全量 `npm test` | **3750 tests / 3747 pass / 3 skip / 0 fail / 124,349.554638 ms** | `full.log` |
| `test:focused` | **416 / 416，0 fail，25,403.946015 ms** | `focused.log` |
| 三包定向（23 + 8 + 15 + 22 + 23） | **91 / 91**（`buffer-tower-channel` 23、`start-view` 8、`sidecar-doctor` 15、`parametric-sidecar` 22、`ci-strict-gates` 23） | `focused-tests.log` |
| `verify:step`（真内核） | **7 / 7**，`state=ready port=7443 wait=3266ms start=681ms`，85 件 / 1,930,477 B | `step.log` |
| `verify:step-tower --levels 16 --require-full` | **23 / 23**，`identity=PASS(144/144)`、`exempt=2/14`、`declared=2 undeclared=0 stale=0` | `tower16.log` |
| `verify:step-tower --levels 8 --require-full` | **16 / 16**，`identity=PASS(88/88)`、`exempt=2/9` | `tower8.log` |
| `eval:tasks --require-full` | **13 / 13**，`skipped=0 env_skipped=0 undeclared_skips=0 degraded=false`，13.4 s | `eval.log` |
| `verify:channel --levels 2` / `--levels 16` | **30 / 30**（正向 16 / 负向 14，N1..N14）、**exit 0** | `channel2.log` / `channel16.log` |
| `npm run build:ext` | **exit 0**：extension 2,946,989 B / gzip 922,141 B / wasm 7,604,031 B / total 10,551,020 B | `build-ext.log` |
| Electron smoke | **`SMOKE_OK`、exit 0、0 FAIL、4 个显式 SKIP**，`STARTUP_METRICS totalMs=468.234` | `smoke.log` |
| `doctor:sidecar`（dry-run） | 列出 **2 个孤儿**（7431 / 7445，9h00m / 5h18m，≈894 MB），`targets=[]` 不杀、无裸 token | `doctor-dryrun.json` |
| `doctor:sidecar --kill` | **两个孤儿均已退出**（进程消失 / 端口释放 / 复扫 0 命中），**exit 0** | `doctor-kill.log` / `doctor-after.json` |

- 全量 **3750 = 基线 3726 + 24 增量**（B 8 + C 15 + A 1），不是「测试变多变绿」的口径漂移。
- `STARTUP_METRICS totalMs=468.234` 零点仍 = **main 模块求值起点**，不含 Electron bootstrap 与静态 import；是**口径读数**，不是性能提升宣称（无跨版本对照）。
- 4 个 SKIP 均带原因：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。

### 3.1 CI（远端，run `44533462036` @ `1d2bad6`）

| 次 | 结论 | 关键点 |
|---|---|---|
| attempt1 | **failure**（6/7 job 绿） | `Qt + OCCT 视口`（job `135592595132`）红在步 3「安装 Qt6 + OCCT 开发包 + Xvfb」：`security.ubuntu.com` 取 `libocct-modeling-data` / `libocct-modeling-algorithms` / `libocct-ivtk-dev` / `libocct-data-exchange-dev` `7.9.2+dfsg-4` 全部 `Connection failed`（另有多次 `503 Service Unavailable`），`E: Unable to fetch some archives` → **exit 100**；步 4「配置与编译（OCCT=ON）」、步 5「OCCT 视口自检（xvfb）」**skipped** |
| attempt2 | **success 7/7** | 同 job 重跑（job `135600296583`，13:39:45→13:42:04）：apt 装成（`Setting up libocct-*-dev:amd64 (7.9.2+dfsg-4)`）→ `-- OCCT AIS 视口：启用` → xvfb 视口自检通过；其余 6 job 同 attempt1 |

- **attempt1 是基础设施瞬时故障，不是断言红**：红在 apt 网络步，编译步与自检步 skipped，**代码/测试一条都没被执行**。日志 `ci-qt-failure.log`；**这条红如实保留作证据，不得改写成「从未红过」或「CI 一次就绿」。**
- attempt2 的绿**只挂 `1d2bad6`**。CI 的 7 个 job：`tsc + unit tests`（内含 `npm test`、`eval:agent`、`eval:tasks`）、`FeatureTree real geometry (build123d)`、`Electron smoke (xvfb)`、`Qt client build`、`Qt + OCCT 视口`、`Qt 客户端（Windows 编译）`、`Qt + OCCT（Windows 编译）`。
- **CI 不跑 `verify:channel` / `verify:step-tower` / `doctor:sidecar`** → §3 表里这些数字仍只能按本机读数引用。
- **CI 绿不改通道结论**：`sweep` 仍 fail、`feasible=false`（§4）。

---

## 4. 结论边界（任何一轮都不许越过）

1. **升降通道未通**：`sweep` 仍 **fail**（16 层 270 确认 + 135 待复核 = 405 **步累计**，去重 60 对，全部为台面 × 托板族），塔身没有升降通道。
2. **`feasible=false`**，blockers 仍 `load-passes-shelf` + `stroke-shortfall`；`verify:channel` 是**诊断脚本**（`feasible=false` 仍 exit 0），30/30 是**尺子自证**，不是结构/安全验收。
3. **两条归零路未实施**：缩回 240 mm / 开 240 缺口都是机构变更 + 结构校核，本轮只出决策书；且「归零 ≠ 可行」已由外移变体实测（0+0 / pass，`feasible` 仍 false）。
4. **承托结论不变**：rest `unsupported`、carried `diagnostic-only`；27→30 条只说明尺子更细，不改变承托判定。
5. **STEP 只到名字/包络级**：每件包络内 ≥1 个 B-Rep 顶点 + 精确件号/宿主/声明件存在，**不是逐面/逐实体身份，不是制造验收**；`structure.accepted:false`、IO `null`、`executable=false` 未动。
6. **CI 只有 job 级绿，且不覆盖通道尺子**：`44533462036` attempt2 7/7 挂 `1d2bad6`，但**同 run 的 attempt1 红过**（apt 503，0 断言跑到，已重跑）；`verify:channel` / `verify:step-tower` / `doctor:sidecar` 不在 CI 内。**无安装包、无 Release**：`build:ext` 只是扩展产物与体积门禁，未签名、未打 tag。

## 5. 未做 / 下一轮

- 提交/推送/CI 已收口：4 笔在 `origin/main`，CI `44533462036` attempt2 7/7（attempt1 红在 apt 网络步，见 §3.1）；再改代码后重跑，判定口径不变（只认 `headSha = $(git rev-parse HEAD)` 的 run）。
- 升降通道归零：等老王拍板路线 ①/② 并补结构校核（承托判据看不见的部分：悬臂挠度/扭转、缺口局部刚度、断辊）。
- 结构/安全/电气/PLC、STEP 逐实体身份 —— 仍未动。
- `--resources-root` 写错时 dry-run 静默零命中（P2，文档已披露，未改代码）。
