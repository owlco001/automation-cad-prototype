# R10 迭代（2026-11-19）：三份整改 + 收口报告

本文件承担两件事，别混读：

1. **第 1–3 节 = 本轮（R10）报告**：只写「改了什么、跑过什么、还缺什么」。
2. **第 4 节起 = 历史归档**：从 `HANDOFF-NEXT-SESSION.md` 里搬出来的旧大块，**压缩**成可检索摘要（不再逐字保留 371 行）。
   权威原文仍在 git 里：`git show e480f57:HANDOFF-NEXT-SESSION.md`（371 行）、
   `git show e480f57:docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`（245 行）。数字/结论按 commit 与 CI run 复核，不以本文件的转述为准。

- 仓库：`owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`
- 代码状态：`HEAD = 94ec7e6` = `origin/main`，R10 的 **4 笔已推**（`137a68d` / `0379e15` / `ba8020d` / `94ec7e6`）；工作区只剩 CI 修复两文件待提交
- 上轮远端 CI：run **`44493445997`**（head `e480f57`）**success，7/7 job**（`tsc + unit tests`、`FeatureTree real geometry (build123d)`、`Electron smoke (xvfb)`、`Qt client build`、`Qt 客户端（Windows 编译）`、`Qt + OCCT（Windows 编译）`、`Qt + OCCT 视口`）—— 只覆盖 `e480f57`
- 本轮状态：**终验已完成（12 项全 `exit 0`，见 §2）**；**CI 首跑未绿但原因是环境前置**：run `44506016602`（head `94ec7e6`）的 `featuretree-geometry`（job `135497734775`）在严格档 `eval:tasks --require-full` 上因
  `Cannot find package 'adm-zip'`（该 job 没跑 `npm ci`）失败，**一条断言都没跑到**。修复已写本机、**待重跑** —— 重跑绿之前不许写「CI 全绿」。**无安装包发版。**

## 1. 本轮三包（改了什么）

### 包 A · 严格 CI 门禁 + 严格档负向自证

- `featuretree-geometry` job（有 build123d）：`verify:step-tower --levels 16` / `--levels 8` 都加 `--require-full`
  —— SKIP 即 exit 1，不再「打一行 STEP_VERIFY SKIP 就绿」；新增 `eval:tasks --require-full` 步骤（任何跳过都算不通过）。
- 新增**严格档负向自证**步骤：受控缺内核（`AUTOMATIONCAD_PYTHON=/nonexistent/automationcad-negative-kernel/python3`，
  并清空 `AUTOMATIONCAD_PARAMETRIC_CMD`，**不卸载共享 venv**），两臂对照——松档 **exit 0**、严格档 **exit 1**；
  日志再钉 `python=$MISSING_PY`（没回退 PATH/venv）、无 `kernel port=`（真没起内核）、`"skipped":true`、`"exitCode":1`，
  且不许出现 `STEP_TOWER FAIL`（证明红的是 SKIP 而不是别的错）。缺内核时松档若不为 0，这一步也红（挡住「崩了恰好 exit 1」的假绿）。
- `unit` job **故意保持非严格**：那里没有 build123d，`t12-step-export` 恒 SKIP，加 `--require-full` 只会假红；注释已写明。
- job 预算 `timeout-minutes: 75 → 90 → 100`（步骤 budget 72 → 87 → 97，最后一段是首跑后补的 `npm ci`），加 step 必须同步改这里。
- 守卫 `desktop/test/meta/ci-strict-gates.test.mjs`（**23 条**，本轮实跑 23/23；首跑前是 21 条）：读**真** `ci.yml` / `package.json`，
  不认注释；`--require-full` 用精确 token 正则（`--require-full=false` / `--no-require-full` 单独判红）、
  `continue-on-error` / `if: false` / `|| exit 0` / 预算算术都判。

#### 包 A 追加（首跑后，2026-11-19 当天）：依赖前置

- 首跑 run `44506016602` 的实际失败：`featuretree-geometry` 只装了 build123d，**没有 node_modules**，
  `eval:tasks` import `desktop/src/shared/zip.ts` → `ERR_MODULE_NOT_FOUND: Cannot find package 'adm-zip'`。
  这是**环境前置遗漏**，不是断言红（严格档的 flag 本身没问题，没被降级、没被去掉）。
- 修复：该 job 加 `actions/setup-node@v4`（node 24，cache 指 `desktop/package-lock.json`）+ `npm ci`
  （与 `unit` job 逐字一致，`working-directory: desktop`），**放在严格评测之前**；job 超时 90→100 min。
- 守卫新增第 ⑦ 条判据 `DEPS_INSTALL_MISSING` / `DEPS_ORDER`：从 job 的**有效步骤顺序**判，缺安装步骤 → 红；
  安装步骤排在任一 `npm run eval:tasks|verify:step-tower` 之后 → 红（不是「文本里出现过 npm ci」）。
  对抗用例 ⑲/⑳ 分别钉住两种形态，两条都进了 load-bearing 自检。

### 包 B · 逐件豁免精确化：精确 id-host + 声明件必备（名字级）

改 `desktop/scripts/verify-step-tower.mjs`（+ 用例）：

- 新增 `OCCLUSION_DECLARED_HOSTS`（`lift-chain-left→lift-post-left`、`lift-chain-right→lift-post-right`），
  **精确件号匹配**（`hasOwnProperty`，不走原型链、不做前缀/正则 —— 族前缀会让 `lift-chain-ghost-*` 自动进豁免集）。
- **双向闭合**：被包住但未声明 / 宿主不是声明的那个 / 声明了却没被包住（死条目）三种各自判红。
- **声明件存在性**（第 6 条身份检查）：`declaredPresence` 显式策略，默认 `required`（fail-closed），
  真实 CLI 两条路（build 与 `--file`）都显式传 `required`，`optional` 只给无链合成件表。
  这条堵的是「`expectedParts` 与 `parts` 同源 → 删链 + 同步改件数一路绿」：覆盖判据只能发现「表里有、STEP 里没有」。
- 身份检查 **5 → 6 项**，所以通过行会从 `8 层 13/13 / 16 层 20/20` 变成 **`8 层 16/16 / 16 层 23/23`**
  （= 9 内核 + 6 身份 + 1 条边界 N/A / + 8 条导出边界）。**已实跑确认**：8 层 16/16、16 层 23/23（见 §2）。
- 口径：这六条认证的是「**精确件号 + 合法宿主 + 声明件存在**」+「每件包络内 ≥1 个 STEP 顶点」，是**名字级**证据，
  **不是材质/拓扑/实体认证**。把任意一件改名成 `lift-chain-*` 再塞进对应导柱，本门禁照样放行（W1，已写进脚本头，不假装堵住）。
- 用例条数：`verify-step-tower.test.mjs` **实跑 57 条**（本轮 `node --test` 57/57）；静态 `grep -c` 只得 56，因为文件含动态生成子测试 —— **静态清单不能替代实跑**。

### 包 C · 启动计时口径（main-module-evaluation）+ 可选 JSON 的 ENOENT 静音

- 新增 `desktop/electron/startup-metrics.ts`（纯函数 + 注入时钟）：
  - **零点 = `createStartupRecorder()` 求值点 = main 模块求值（main-module-evaluation）**，不含 Electron bootstrap、不含 main 静态 import；
    `atMs` / `totalMs` / `sincePreviousMs` 全相对这个零点，`Σ sincePreviousMs ≈ totalMs`（差只有三位小数舍入）。
  - 回退判据用**未舍入 raw 时钟**（并行 `rawAts`），舍入只发生在写出 —— 不造「舍入导致的假回退」。
  - 阶段脊梁 `ready → window → (readyToShow | load) → extension`；`readyToShow` 与 `load` 同档，
    `readyToShow` 允许晚到（xvfb/慢首帧），但「window 之前有首帧」仍拒；空记录不许直接记后续阶段。
  - 没发生的阶段是 `null`（键必存在），不是 0；重复 mark 幂等且不再读时钟；返回冻结副本。
  - **顺序水位必须单调**：`lastRank = Math.max(lastRank, rank)`。旧写法 `lastRank = rank` 会被晚到的 `readyToShow`（rank 2）
    把水位从 3 拉回 2，于是紧随其后的 `load` 被接受 —— 回归用例见第 2 节。
- `desktop/electron/main.ts` 接线：模块作用域建 recorder，各事件里 `markStartup(...)`（try 包住、错序只打一行码），
  `readyToShow` 与 `extension` 齐了才打**唯一一行** `STARTUP_METRICS`；有界兜底（headless 4 s / 有窗口 15 s、`unref`）、
  `process.once('exit')` 补打；`--diagnose` 分支只记 ready 并显式写 trigger。
- 新增 `desktop/src/shared/optional-json.ts`：**只静音 `ENOENT`**（首启文件还没写过）。
  文件在但不是合法 JSON / schema 不合法 → `reason:'invalid'` 交调用方记码；EACCES/EISDIR 等 **原样抛出**，不映射成 missing。
  刻意不用 `existsSync` 当守卫（它把「没权限」和「不存在」都判 false）。
- `desktop/electron/ipc.ts` 的 PLC 历史读取改用它：首启不再记 `PLC_HISTORY_READ_FAILED`，真损坏/权限错误照旧留痕。

## 2. 本轮实测（只有这些是跑过的）

**终验（同一棵树、串行、全部 `exit 0`；2026-11-19；日志 `/root/.hermes/cache/scratch/cad-r10-final/`）**

| 项 | 结果 | 日志 |
|---|---|---|
| 全量 `npm test` | **3717 tests / 3714 pass / 3 skip / 0 fail / 119,708.889571 ms** | `full-final.log` |
| focused | **415 / 415，13,094.827541 ms** | `focused-final.log` |
| `npx tsc --noEmit` | **exit 0**，0 诊断 | `tsc.log` |
| `npm run build:ext` | **exit 0**：extension **2,946,350 B** / gzip **921,963 B** / wasm 7,604,031 B / total 10,550,381 B | `build-ext.log` |
| Electron smoke | **`SMOKE_OK`、exit 0、23.0 s、0 FAIL、4 个明确 SKIP** | `smoke.log` |
| `verify:step-tower --levels 8 --require-full` | **16 / 16**（9 内核 + 6 身份 + 1 条边界显式 N/A） | `step-tower-8.log` |
| `verify:step-tower --levels 16 --require-full` | **23 / 23**（9 + 6 + 8） | `step-tower-16.log` |
| `verify:channel --levels 2` / `--levels 16` | **27/27 · 27/27**（正向 13 / 负向 14），`TOWER_CHANNEL_RESULT ok` | `channel-2.log` / `channel-16.log` |
| `eval:tasks --require-full` | **13 / 13 pass、skipped=0、env_skipped=0、undeclared_skips=0、degraded=false** | `eval-tasks.log` |
| `regen:pv-buffer` | **`ok=true checks=61 failed=0`**，仍 8 层 90 件、`aligned=false` | `regen-pv-buffer.log` |
| `kb:build` | **13 docs / 454 chunks / 434,531 B**（三份交接文档不在 `KB_DOC_FILES`，统计不变） | `kb-final.log` |
| 四文件定向 `node --test`（startup-metrics / optional-json / ci-strict-gates / verify-step-tower） | **105 / 105**（19 + 8 + 21 + **57**） | `node-test.log` |

- **`verify-step-tower.test.mjs` 实跑 57 条**；静态 `grep -c` 只得 56 —— 文件里有动态生成子测试，**静态清单不能替代实跑**（「56 条、57 差 1 未复核」作废）。
- **4 个 SKIP 各自带显式原因**（不是静默跳过）：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。
- **rank 水位回归自证**：旧实现隔离副本 `18 pass / 1 fail`（失败正是「非法 load 没抛」），当前源码 `19 / 19 pass` —— 真红真绿，不是只跑绿的一侧。
- **启动计时读数**：`STARTUP_METRICS totalMs=373.254`（ready 67.61 / window 131.226 / load 356.605 / readyToShow 372.3），零点 = **main 模块求值起点**，不含 Electron bootstrap 与 main 静态 import。**是口径读数，不是性能提升宣称**（无跨版本对照实验）。
- **本轮没跑**：`verify:step`（不在本轮改动面内）、远端 CI 的绿（首跑 run `44506016602` 是 adm-zip 环境前置红，修复待重跑）。**无安装包发版。**

**小修之前的旧数字（保留作演进记录，不再当结论）**：focused 415/415、全量 3716 tests / 3713 pass / 3 skip / 0 fail / 126,150 ms —— 都跑在 rank 一行小修与第 19 条测试之前，已被上表取代。

## 3. 结论限制（先钉死，任何一轮都不许越过）

| 限制 | 事实 |
|---|---|
| 真实塔不可行 | `verify:channel` 的生产塔 `feasible=false`（blockers = `load-passes-shelf` + `stroke-shortfall`），rest `unsupported`、carried `diagnostic-only`。它是**诊断脚本**（`feasible=false` 仍 exit 0），不是结构/安全校验。 |
| `sweep` 仍 fail | 16 层 42 对 / 270 确认 + 135 待复核 = **405** 命中，塔没有升降通道。**本轮未复跑**，数字沿用，不得改判。 |
| 结构/安全/电气/PLC 未做 | `structure.accepted:false`、板挠度/导向/防坠/安全回路全未校核；IO 地址 `null`、`executable=false`；无 PLC 程序与联调。 |
| 占位顶点 ≠ 实体认证 | STEP 门禁只到「每件包络内 ≥1 个 B-Rep 顶点」+ 名字级声明；不是逐面/逐实体身份，不是制造验收。 |

另：4 笔已推 `94ec7e6`，但 run `44506016602` 在该 SHA 上是**红的**（`featuretree-geometry` 没跑 `npm ci` → `Cannot find package 'adm-zip'`，断言未执行）。
CI 结论只能挂在**补完依赖前置之后那一次** run 的 `headSha` 上；上轮 run `44493445997` 只覆盖 `e480f57`。

## 4. 历史归档（T9 及更早，压缩；权威见 git）

### 4.1 提交线（到基线 `e480f57` 为止）

| commit | 内容 |
|---|---|
| `e480f57` | docs：记录优化轮门禁、清掉过期声明（CI run `44493445997` 7/7 绿，head 就是它） |
| `1c803f6` | `chore: rebuild kb index after machine refactor`（只动 `kb.json`，统计不变 13/454/434531） |
| `faf2665` | `perf(test)`：`cli.test.mjs` 昂贵求解并行预跑 + 记忆化，该文件 130.1 s→35.7 s，全量 205.9 s→116.7 s |
| `fa7e215` | `feat(ci)`：制造导出错误带块/实例下标与件号清单；`ci.yml` 新增 `verify:channel --levels 2 / 16` |
| `0cb7e1a` | `feat(gates)`：regen 储位改从工程件表派生（检查 58→61）；`eval-tasks` 区分环境 gate 跳过与未声明跳过（后者 exit 1） |
| `f81b697` | `refactor(machine)`：`feature-box.ts` 判据合一；结构级坏件 `malformed-part`/`malformed-feature` → `INVALID_PART_GEOMETRY` → `INVALID_ARGUMENT`；未知特征类型 `unknown-feature-type`；`suppressed` 跟随内核 |
| `afe65a9` | `feat(verify)`：逐件 B-Rep 占位覆盖 + 被包住件豁免上限 + 件号唯一性（`--file`/`--require-full` 互斥 exit 2） |
| `920ea07` / `b85fab5` / `8037e11` / `dec1373` | 板进碰撞几何 + 制造导出边界；承托/行表 fail-closed（P2-1/P2-2/P2-5）；文档 + kb；docs-only（CI run `44444540414` 7/7 绿） |
| `65229c5` / `411f21d` / `e6c1ef3` / `b3b13f3` / `18b08bb` / `7b089a1` / `1df0d05` / `114e024` | 更早：塔身建造器、锁存故障期来料拒绝、per-station PLC、CI 沙箱守卫、塔 B-Rep 入口与 STEP 门禁、`run_interference_check` 接通道诊断 |

### 4.2 T9 轮的门禁数字（历史，已被 R10 的 focused 415 / 全量 3716 取代）

focused **405/405**（12,282 ms）、全量 **3659 tests / 3656 pass / 3 skip / 0 fail（116,728 ms）**、`tsc --noEmit` exit 0、
kb **13 docs / 454 chunks / 434,531 B**、`verify:channel` 2 层 / 16 层各 **27/27**（正向 13 / 负向 14，N1..N14）、
`verify:step-tower` 8 层 **13/13** / 16 层 **20/20**、`verify:step` **7/7**（85 件 / 1,930,477 B）、regen **61/61**、
`build:ext` **2,946,350 B / gzip 921,963 B / total 10,550,381 B**；本机 Electron 冒烟 `SMOKE_OK`、exit 0、27.6 s、0 FAIL、3 SKIP。
更早的 final6（370 / 3614 / 10-10 / 17-17 / 58 / 2,941,695 B）与 final5 全部作废，只作历史。

### 4.3 跨模块口径（现行，别用旧说法覆盖）

- **碰撞几何 ≠ 制造导出**：`geometry.parts` / `geometry.json` / `run_interference_check` / 通道诊断在 16 层是 **147** 刚体
  （146 装配件 + `workpiece-plate`），2/8 层 49/91；制造导出（STL / glTF / sidecar → STEP）是 **146**（2/8 层 48/90），
  板由 `machineExportParts()` 剔除。两种数不许互相校验。
- BOM **96 行 / qty 146**、slots 16（可用 15）、包络 2430×1790×3840、16 层 STL 5868 三角形、sidecar 3 块 —— 均未变。
  「BOM/STEP/成本/容量一件不动」这句里 **STEP 部分是错的**：修复前导出会多一块板。
- **同一块板的判据**：`inCollisionSet` / `panelSourceOfGeometry` 认同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg`
  与占位体一致（转角周期等价：`360°≡0°`、`−90°≡270°`）；同 id 托板/夹具件、同尺寸同中心转 90° 的件都不算；
  `rotationZDeg` 缺失/非有限不算（不拿 0 顶替）。`mode=verified` 只等于「行表来自几何 + 碰撞集里有这块板」。
- 坏坐标 fail-closed：承托**行**非有限 → 该行剔除、`diagnostic-only` + `invalid-support-rows`（N13）；
  承托**面几何**非有限 → 不判可行、`witness=null` + `invalid-shelf-geometry`（N14，带未污染正控）。
- `no-solid-feature` 两侧政策不同（有意）：`machine-geometry` 抛，`panel-channel` 不成行也不记 `dropped`。
- regen 仍走 **8 层 90 件**（包络 2430×1690×2400），`claimedSlots=16 / aligned=false` 是几何与声明真比较的结论；
  塔不在该路径上。旧 781,970 B / 47 实体是丢件产物，永不引用。

### 4.4 STEP 门禁的判别力边界（历史 + 现行）

- 老判据只有包络/数量级：顶点并集、实体数下限（16 层 floor 88 实测 104；8 层 floor 54 实测 55 —— **丢 1 个内部实体仍绿**）、
  逐件 bbox、合并路径必须 `fuse`（`compound`/`fallback:true` 失败；`--file` 裸 STEP 默认判红，必须给 `--merge-manifest`，
  接受 `{merge}` / 扁平 `{mode,fallback}` / `{stats:{merge}}` 三种形状）。
- `afe65a9` 起加逐件占位覆盖（16 层 144/144、8 层 88/88）+ 豁免上限 + 件号唯一；**R10 包 B** 再把豁免改成
  「声明表 + 双向闭合 + 声明件必备」，10% 比例上限与每轴 1.05 降为第二道闸（不再单独决定通过）。
  仍未做：逐实体 bbox / 面级匹配 / 件族对应。
- 容差口径：只对垂直于导柱轴的方向给半径 20 mm（Ø40 导柱母线），轴向端面严格 ±1 mm
  （`minAllowance=[1,1,1]`、`maxAllowance=[1,20,1]`，逐端取极值件）。16/8 层 Y 上界差都是 19.99 mm。

### 4.5 仍未完成（按危害排序，跨轮不变）

1. **升降通道**：层托板整块 + 台面在托板投影内 → `sweep` 405 命中的唯一出路是设计可承载通道（托板开口/梳齿/避让），
   复验到 0 之前 `sweep` fail 是事实。
2. **结构/安全/电气/PLC**：结构只有屈曲手算量级；双通道急停、安全门、光幕、安全继电器未建；IO 地址 `null`。
3. **STEP 逐实体身份**：占位顶点只到「≥1 顶点」，需要逐实体 bbox / 件族对应；豁免虽已改成声明表，仍非实体认证。
4. **`featuretree-geometry` job 仍无 `actions/setup-node`**（存量）：node 取镜像默认值；若 <22.18，严格档与负向自证两臂都会非零 → 步骤红（fail-closed，不会假绿），正确修法是加 setup-node 并同步改预算。
5. 塔的 146 件没有 sceneIntegrity 断言；`sceneIntegrity` 只是计数等式门禁，不证明几何正确。
6. 降级回执可能早于真实首帧（headless 兜底 4 s 到点后打 `degraded=missing:readyToShow`）：那是设计取舍，别把那条行当「首帧没发生」的结论。

### 4.6 安全与数据

不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`（真实智能体设计工程与模型结果）；
不把其中任何密钥复制进仓库或文档。IO 草案地址为 `null` 是有意设计，必须经电气与安全工程确认后才能分配真实地址。
`scratch/` 下的各岗报告与日志（`cad-opt-*.md`、`cad-r10-*.md`、`*-gate-*.log`）**永不提交**。
