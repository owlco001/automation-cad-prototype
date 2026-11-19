# PV 缓存机迭代交接（软件侧）

## 当前状态速览（2026-11-19 · **R10：5 笔已推 `9409f3e`；sidecar 修复已提交 `e1d1138` 未推送；CI 第二跑仍红（早退、真因未证）；4 份文档待提交**）

> 本节只放**当前**状态。完整报告与此前各轮数字 → `docs/desktop/R10-ITERATION.md`；
> 下面从「P2 整改（历史）」起的各节是**历史记录，原样保留、不逐段改写**（旧数字仍是那一轮的实测，只是不再是现状）。

- **代码状态**：`HEAD = e1d1138`（`fix(parametric): diagnose sidecar exits and preserve launch state`，**本机**），**领先 `origin/main@9409f3e` 一笔（未推）**。R10 代码共 **6 笔**：**5 笔已推**
  （`137a68d` / `0379e15` / `ba8020d` / `94ec7e6` / `9409f3e`），第 6 笔 `e1d1138` 含包 D 的 4 文件（`electron/parametric.ts`、`scripts/{fake-parametric-sidecar,verify-step-export}.mjs`、`test/parametric-sidecar.test.ts`，+604/−32）**已提交、待推送**；工作区只剩 **4 份交接文档**待提交。
  上轮远端 CI run **`44493445997`**（head `e480f57`）success 7/7 —— 只覆盖 `e480f57`。
- **本轮 CI 两次都未绿，原因不同**：首跑 run `44506016602`（head `94ec7e6`）是 `featuretree-geometry` job 没跑 `npm ci`，
  `eval:tasks` import `adm-zip` 即 `ERR_MODULE_NOT_FOUND`，**一条断言都没跑到**（已由 `9409f3e` 修）；
  第二跑 run `44508941094`（job `135507781027`，head `9409f3e`）依赖/装配/体积都过，红在 `verify:step` —— sidecar 起来后
  **约 0.36 s 自行退出**（端口 7440/7435），旧实现误报成「健康检查在 3 秒内未通过」，**具体真因未证**（旧代码丢弃 stderr，无 traceback）。
  因此**不能写「CI 已绿」，也不能写「改动全未提交」**（5 笔在远端 + `e1d1138` 已提交本机、仅 4 份文档未提交）；**无安装包发版**。
- **本轮四包**（细节见 R10 报告 §1）：① **严格 CI + 负向自证**（`--require-full`、受控缺内核两臂、job 预算 100 min、守卫 ⑦ 依赖前置）；
  ② **逐件豁免精确化**（`OCCLUSION_DECLARED_HOSTS` 精确件号→唯一宿主、双向闭合、声明件 `required`、身份检查 5→6 项，名字级非实体认证）；
  ③ **启动计时口径**（`startup-metrics.ts` 零点 = main 模块求值 + `optional-json.ts` 只静音 `ENOENT`）；
  ④ **包 D（已提交 `e1d1138`，未推送）** sidecar 错误诊断 —— `waitHealthy` 三态 `ready/exited/timeout`、早退报 `code/signal/实测 ms`、stderr 4 KB 尾缓存全 `[REDACTED]`、`classifySidecarStderr()` 八类、`verify:step` 失败带证据、**启动期不抢跑重启**（`launchActiveSeq` 作用域）；P1 复审通过。
- **门禁状态（本机实测，包 D 之后，日志 `/root/.hermes/cache/scratch/cad-r10-final/*final2.log`）**：全量 **3726 tests / 3723 pass / 3 skip / 0 fail（120,598.912448 ms）**、`tsc` exit 0、`build:ext` exit 0（extension 2,946,350 B / gzip 921,963 B）、`verify:step` **7/7**（`start=559 ms`）、`verify:step-tower` **16 层 23/23**、`eval:tasks --require-full` **13/13（skipped=0）**、`parametric-sidecar` **22/22**、`ci-strict-gates` **23/23**。
  **包 D 之前同树实跑、本轮未重跑**：focused **415/415**、smoke **`SMOKE_OK`**（0 FAIL / 4 个显式 SKIP）、`verify:step-tower` 8 层 **16/16**、`verify:channel` 2/16 层各 **27/27**、`regen` **61/61**、kb **13/454/434,531**。**均为本机读数，不是 CI 读数。**
- **启动计时**：`STARTUP_METRICS totalMs=373.254`，零点 = main 模块求值起点 —— 是**口径读数**，不是性能提升宣称。
- **测试清单（静态 `grep -cE "^[[:space:]]*test\("` 现测，条数不是通过数）**：`panel-channel` **50**、`buffer-tower-channel` **22**、`interference-panel-diagnostics` **10**、`geometry-export` **17**、`verify-step-tower` **56**（静态；**实跑 57/57**）、`pv-buffer-regenerate` **26**、`eval-tasks` **7**、`startup-metrics` **19**、`ci-strict-gates` **23**、`optional-json` **8**、`parametric-sidecar` **22**（包 D 后 15→22）。
  **旧的 33 / 21 / 54 / 46 全部作废**；也不许写「72 条定向全绿」（50+22 只是清单相加）。
- **判据与 fail-closed（现行，未改动）**：`inCollisionSet` / `panelSourceOfGeometry` 认**完整工件身份**（同 id + `role=workpiece` + `size`/`center`/`rotationZDeg` 一致，转角周期等价；同 id 托板/夹具、转 90° 的件都不算；`rotationZDeg` 非有限不算）。坏坐标：承托**行**非有限 → 该行剔除、`diagnostic-only` + `invalid-support-rows`（N13）；承托**面几何**非有限 → 不判可行、`witness=null` + `invalid-shelf-geometry`（N14，带未污染正控）；特征参数坏 → 并进同一码（`droppedPartIds`）。判据统一在 `feature-box.ts`。
- **边界不变**：塔仍**没有真实多层升降通道**（层托板整块、台面在托板投影内），**`sweep` 405 = 270 确认 + 135 待复核仍 fail，本轮未复跑、不得改判**；`structure.accepted:false`、挠度/导向/防坠/安全回路/PLC 全未校核；`mode=verified` 只等于「行表来自几何 + 碰撞集里有同一工件身份的板」，**不等于可行**；`verify:channel` 是诊断脚本（`feasible=false` 仍 exit 0）。**没有通道/结构结论。**

## P2 整改（历史 · 2026-11-19 T3 复审后，落在 `920ea07`/`b85fab5`；源码现行，但整树证据已被本轮六笔叠加）

T3 第二轮复审判定 **P2-1 / P2-2 / P2-5 均通过，无新增 P0/P1**；三份整改的源码/测试改动落在 09:42:40–09:48:06，当时由 final6（10:04–10:10）全树复跑。**下表与「整改期实跑」列保留作历史证据**；现行整树证据是本轮 16:44–16:51（focused 405/405、全量 3659、`verify:step-tower` 13/13 与 20/20）。

| 项 | 改了什么 | 测试变化 | 整改期实跑（零散证据；final6 已全树复跑） |
|---|---|---|---|
| **P2-1** 回执文案把 `verdict` 当结论 | `panelChannelNote` 改印 `claim`（新增 `panelSupportClaimText`）；`diagnostic-only` 时不印 verdict，点名 `diagnosticCode` + `invalidPartIds`，并加「只按 claim 读」句 | `interference-panel-diagnostics` 9→**10** | 该文件 10/10；三文件合跑 79/79（当时 `panel-channel` 47 条）；生产塔 note 与干净 M1 note 探针对比（干净逐字符不变） |
| **P2-2** `ConveyorPart` 行表在 fail-closed 前静默丢件 | `featureLocalBox` 三态 `box\|none\|invalid`；新导出 `supportRowsFromConveyorPartsDetailed()` → `{rows, droppedPartIds}`；`invalidShelfIds = 行内非有限 ∪ dropped` → `invalid-shelf-geometry` + `witness=null`；`at` 不再 `Number(v)\|\|0`、未知 `axis` 不再默认 `z` | `panel-channel` 47→**50** | `panel-channel` 50/50；`buffer-tower-channel` 22/22；`verify:channel --levels 2` 27/27；`tsc --noEmit` exit 0 |
| **P2-5** 导出边界押在字面量 + 来源标签上 | `machineExportParts` 改三层身份（共享件号 `WORKPIECE_PART_ID` / role / 与占位体 box 位姿同一，任一命中）+ 装配件窗口（`parts.length > assemblyPartCount`）；来源标签降级为整机放行信号（与 `workpiecePlaceholder` 投影二者有其一即可，都缺才走「窗口外全是静止不挂轴的板」结构兜底）；`verify-step-tower` 新增**导出边界门禁 8 条**（146 实例 == `assemblyPartCount`、不含板、件号与 146 件表逐件一致、内核输入仍 146），build 起内核前先判，`--file` 模式也判 | `geometry-export` 12→**14**、`verify-step-tower` 27→**31** | 两文件 45/45；塔相关 7 文件 147/147；`tsc --noEmit` exit 0；CLI `--file` 桩 STEP 回执 `exportBoundary.ok=true`（整体仍 exit 1，桩本身不合格）；`--skip-if-no-kernel` 路径先判边界后 SKIP |

**残留限制（历史 · 2026-11-19 17:05，T9 轮口径；R10 的当前状态只看文首）**：
1. **CI 已跑，覆盖 `1c803f6`**：run `44491644544` 7/7 绿，`featuretree-geometry` job 里 `ci.yml:856-857` 的 16/8 层 `verify:step-tower` **已真实执行**（16 层 20/20、8 层 13/13），**新增的 `verify:channel --levels 2 / 16` 也已执行并通过**（`fa7e215` 加的 step），`tsc + unit tests` job 绿。**尚未覆盖**：本轮之后提交的 docs-only commit 在 push 前没有自己的 run。**仍未接严格档**：两个 `verify:step-tower` step 与 `eval:tasks` 都没带 `--require-full`（SKIP / `degraded=true` 在 CI 上仍算绿）。告警只有两类、均非致命：多个 job 的 `##[warning]Node.js 20 is deprecated`、Windows Qt job 里一处 `powershell is not supported`；**无 `##[error]`**。
2. **导出边界已实跑，但仍不是板专属的端到端内核证明**：内核 9 项检查吃 `buildBufferTowerParts()` 的 146 件表与焊出的 solids，结构上看不见板；8 条导出边界走 `resolveMachineGeometry` → `machineExportParts` → `geometryToSidecarAssemblies`（**脚本级、不经内核输出、不核对内核 STEP**）。本轮 16 层 `verify:step-tower` **20/20** = 9 内核 + 3 逐件身份 + 8 边界；8 层 **13/13** = 9 内核 + 3 逐件身份 + 1 条显式 N/A；`--skip-if-no-kernel` 分支这些都不打印（该分支「绿」不带证据）。所以「STEP 只出 146 件」是 sidecar/STL/glTF 单测 + 已实跑的脚本级断言，**不是端到端内核证明**。
3. **无结构/通道结论**：`feasible=false`、`sweep` 405、`structure.accepted:false`；`verify:channel` 是诊断脚本（`feasible=false` 而 exit 0），N1..N14 是「尺子自证」，不是结构验收——上 CI 也不改变这一点。
4. **P3 残留（本轮更新）**：①「未知特征类型静默当无实体」与「`suppressed` 未跟随内核」**已由 `f81b697` 关掉**（`unknown-feature-type` → `INVALID_PART_GEOMETRY`；`suppressed === true` 两侧跳过）；②「`machine-geometry.ts:1043`/`:1126` 注疏仍写旧判据」**作废** —— 现文已是「碰撞刚体 = 件表 + 1 块板 / 导出件集 48/90/146」；③ 仍剩：P2-5 身份剔除本身不看 `moving`/挂轴（只有「整机信号全缺」的结构兜底会看：窗口外件必须 `moving !== true` 且不挂运动轴）；**豁免上限是比例（≤10%）**，16 层余 12 / 8 层余 7 件可在「被严格包住」名义下静默丢；`no-solid-feature` 两侧政策不同（`machine-geometry` 抛、`panel-channel` 不成行不记 `dropped`，有意）。

## 本轮六笔（2026-11-19 T9 优化轮，`afe65a9` → `1c803f6`，全部已 push）

| 提交 | 内容 | 对本文件口径的影响 |
|---|---|---|
| `afe65a9` 逐件 STEP 身份 | `verify-step-tower` 新增三条证据：**逐件 B-Rep 占位覆盖**（16 层 144/144、8 层 88/88，每件 ≥1 个 STEP 顶点落在自己包络内 ±1 mm）、**被包住件豁免上限**（按 entries 计数、宿主必须非豁免、每轴尺寸比 ≥1.05、≤ 件数×10%：16 层 2/14、8 层 2/9）、**件表件号唯一性**；`--file` + `--require-full` 互斥 exit 2 | 「丢 1 个内部实体仍绿」**不再是必然**；门禁 17/17→**20/20**、10/10→**13/13**；16 层 104 solids / 8 层 55 solids 数量级判据不变 |
| `f81b697` feature box 合一 + 坏件 fail-closed | 新增 `src/machine/feature-box.ts`（`parsePartLocalBox`/`parseFeatureBox`/`rotateAboutZ`/`worldBoxFromLocal`/`inspectTransform`）；`machine-geometry`/`panel-channel` 只留消费政策；结构级坏件 → `malformed-part`/`malformed-feature` → `INVALID_ARGUMENT`；未知类型 → `unknown-feature-type`；`suppressed` 跟随内核跳过 | 关掉旧 P3 两条（未知类型、suppressed）；通道不再因单件坏结构整表中断 |
| `0cb7e1a` 储位派生 + eval 跳过计数 | `pv-buffer-regenerate` 从工程件表派生储位（`source:project-parts`、`fromGeometry/levelsFromGeometry/slotsPerLevel/towers`、逐层 trace），regen 检查 58→**61**；`eval-tasks` 区分环境 gate 跳过与未声明跳过（后者 exit 1），`TASK_EVAL_DEGRADED` + `degraded=true` | 「8 层 ≠ 16 位」现在是几何派生出的真结论（8 vs claimed 16，`aligned=false`） |
| `fa7e215` sidecar 错误索引 + `verify:channel` 进 CI | 制造导出错误带**块下标 / 全局实例下标 / 件号清单 / op 序列**（内核不在本仓，只贴确定已知的坐标）；`ci.yml` 的 `featuretree-geometry` job 新增 `verify:channel --levels 2 / 16` | 文档里「`verify:channel` 不在 CI」作废 |
| `faf2665` cli 用例记忆化 | `cli.test.mjs` 昂贵求解参数集并行预跑 + 结果记忆化；单文件 130.1 s→**35.7 s**，全量 205.9 s→**116.7 s** | 全量测试墙钟数字整体换新；小用例单条会慢 40–150%（并行抢 CPU，净赚） |
| `1c803f6` 重建 kb | 只改 `kb.json`，统计不变 13/454/434531 | 无 |

## 制造导出边界（2026-11-19；源码提交 `920ea07`，本轮 `fa7e215` 补错误索引）

**一句话：碰撞几何含板，制造导出不含板。** T2 把真实板（`workpiece-plate`、`role=workpiece`）放进 `geometry.parts` 后，`geometry.parts` 与制造导出同源，STL / glTF / sidecar（→STEP）会多出一件非机加件。已修：`geometry-export.ts` 新增唯一入口 `machineExportParts(geometry)`，判据分三层（作用域 → 板身份 → 整机放行信号），**不再押在「字面量 id + role + 来源标签」上**：

1. **作用域 = 装配件窗口**：`assemblyPartCount` 是非负整数且 `parts.length > assemblyPartCount` 才进入判据，否则原样返回同一数组 —— 单件导出（`parts:[part]`，wizard 逐件 STL）与没有多余刚体的几何都落在这里，不过滤。输送线（`conveyor-assembly`）**会**有 3 件窗口外刚体（2 个传感器件 + 移载板），但两道判据都不成立：没有整机身份信号（来源不是塔、也没有 `workpiecePlaceholder` 投影），结构兜底也过不了（窗口外不全是板，且移载板 `moving:true` 挂在移载轴上）→ 原样返回同一数组，导出逐字节不变（`geometry-export.test.mjs` 有断言）。
2. **板判据 = 三层身份任一命中**（`isWorkpiecePlatePart`）：共享件号 `id === WORKPIECE_PART_ID`（`'workpiece-plate'`）、`role === 'workpiece'`、或与 `geometry.workpiecePlaceholder` 的 box `size`/`center`/`rotationZDeg` 位姿同一（转角按周期等价、带 EPS 容差）。三层里任一信号单独漂移都拦不住剔除。
3. **真正动手剔除还要一条整机级身份信号**：`geometrySource === 'buffer-tower-assembly'` **或**存在 `workpiecePlaceholder` 投影；两者都缺时只走**结构兜底** —— 窗口外多出来的件必须全部是同一块**静止、不挂运动轴**的工件板，拿不出这种形状就原样返回（绝不按位置整段裁件）。过滤后件数没变也返回原数组。

`geometry-export.test.mjs` 的 17 条里有针对这套判据的变异自证：改件号/改 role/去来源标签后导出必须仍是 146 件；与占位体位姿差 1 mm 的「像板件」必须留在导出里；**本轮 `fa7e215` 又加了错误索引**：sidecar 派生失败时错误里带「第 n/m 块 · 全局实例下标 · 件号清单 · op 序列」，agent 不必拿一句 `too many values to unpack` 去猜。

| 口径 | 16 层 | 8 层 | 2 层 |
|---|---|---|---|
| `geometry.parts` / `geometry.json` / `run_interference_check`（碰撞） | **147** | 91 | 49 |
| `assemblyPartCount`（BOM 96 行 / qty **146**） | 146 | 90 | 48 |
| sidecar 实例（→ STEP 实体上限） | **146**（3 块） | 90 | 48 |
| STL 三角形 | 5868 | 3180 | 1164 |
| glTF 件节点 | 146（无板） | 90 | 48 |

实测方式：真实生产管线 `resolveMachineGeometry(config)` + `geometryToStl` / `geometryToGltf` / `geometryToSidecarAssemblies`，2026-11-19 逐层（2/8/16）复算；sidecar 块数 1/2/3。

**不要再说「BOM/STEP/成本/容量一件不动」**：BOM（96 行 qty 146）/成本/容量确实不变；STEP/STL/glTF 在修复前会多一块板（147 instances / 5880 三角形 / 多一个 glTF 节点），修复后是 146。**导出边界的脚本级覆盖是 2026-11-19 P2-5 补的，逐件身份是本轮 `afe65a9` 补的**：`verify:step-tower` 现有 **8 条导出边界**（146 实例 == `assemblyPartCount`、不含板、件号与 `buildBufferTowerParts` 146 件逐件一致、sidecar 实例 146、内核输入仍 146 件）+ **3 条逐件身份**（占位覆盖 / 豁免上限 / 件号唯一）。build 模式在起内核之前先判、`--file` 模式也判。**本轮已实跑**：16 层 **20/20**（9 内核 + 3 身份 + 8 边界，16:47:46）、8 层 **13/13**（9 内核 + 3 身份 + 边界 1 条显式记「16 层塔专用」N/A，16:47:33）；`--skip-if-no-kernel` 分支不打印这些。**但这 8 条断言的是 sidecar/导出文档，不经过内核输出、也不核对内核 STEP**；内核那 9 项仍只看 `buildBufferTowerParts()` 的 146 件表与焊出的 solids，**结构上看不见板** → 「STEP 只出 146」= sidecar/STL/glTF 单测 + 已实跑的脚本级边界断言，**仍不是板专属的端到端内核证据**。**CI 侧复核（run `44491644544`）**：`featuretree-geometry` job 已把 16 层 20/20 与 8 层 13/13 跑到远端，日志逐条打印「导出件数 == assemblyPartCount 146」「导出件号 == STEP 件表 146 件、唯一 146、缺 0」「sidecar 实例 146」，所以这套脚本级断言在 CI 上确实存在并执行；结论边界不变 —— 仍是 sidecar 级证据，不核对内核 STEP。

**同一块板的判据（2026-11-19 收口）**：`inCollisionSet` / `panelSourceOfGeometry` 认完整工件身份 —— 同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg` 与占位体一致（转角按周期等价，`360°≡0°`、`−90°≡270°`）。同 id 的托板/夹具件、同尺寸同中心但转 90° 的件都不算同一块板；`rotationZDeg` 缺失/非有限数不算（不拿 0 顶替）。`mode=verified` 的前提是这套身份判据成立，不是「parts 里有同 id 件」。

> 以下各节是 2026-11-18 / 11-19 早前轮次的原文记录，**保留不改写**。那一版头部写的是「HEAD `7b089a1`，与 `origin/main` 同点；工作区 10 M + 5 ??」，这句话今天不成立：当时 HEAD 已是 `8037e11`（本地，领先 `origin/main@114e024` 三笔：`920ea07`/`b85fab5`/`8037e11`），工作区干净。更早那版还写过「21 M + 1 ?? 未提交」，那是提交前快照，21 个 M 现已全部入库。（2026-11-19 10:35 补记：此后又落了 `dec1373`，四笔均已推送，run `44444540414` 7/7 绿。**17:05 再补**：此后又推了六笔到 `1c803f6`，run `44491644544` 7/7 绿，16 层 20/20、8 层 13/13、`verify:channel` 已进 CI。）文中「装配件数/BOM/STEP/成本/容量不变」之类句子的 STEP 部分，一律以本节表格为准；文中出现的测试条数（如 33/21/54）与门禁数字（23/23 等）都是那一轮的历史，现测清单见文首。

## M1「首层承托取放」：纯数据概念验证（2026-11-18，基线 `main@7b089a1`，未提交）

> 本节是**后来一轮**的实测记录（基线 `7b089a1`，工作区未提交）。它在 T3 对抗审查后修过两轮：先修 P1-1/P1-2/P1-3，再按只读复核闭合 P1-R1（shift 无上界）、P1-R2（`verified` 不校验行表来源）、P2-5（台面停位口径）、P2-6（`Number(null)→0`）。**下表是两轮修完之后的实测**；下文其余章节仍是 `411f21d` 那一轮的记录，数字不要混用。

**这个 M1 到底是什么（先看这条，免得被数字误导）**

- **生产建造器没有变，但几何层的板变了（T2 窄实现）**：`buildBufferTowerParts` / `buffer-tower-assembly.ts` 一个字未改，16 层仍是 **146 装配件 / BOM 96 行 qty 146 / slots 16（可用 15）**；板现在是 `geometry.parts` 里的真实 `GeomPart`（`workpiece-plate`，role=workpiece、moving=false），所以 **`partCount = 147`**（= 装配件数 + 1），`workpiecePlaceholder` 由同一件投影、`inCollisionSet` 按**完整工件身份**派生（2026-11-19 判据：同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg` 与占位体一致，转角按周期等价：`360°≡0°`；同 id 的托板/夹具件、同尺寸同中心但转 90° 的件都不算同一块板）。升降轴仍只随动 `lift-platform`（2700）——**板不随塔轴移动**。
- **M1 的 152 件只存在于夹具**（`desktop/test-support/m1-channel-fixture.mjs`：146 −1 台面 +2 叉指 +1 横梁 +4 分段带）：**fixture-only**，生产建造器不会产出这套件表，`build_machine_model buffer-tower` 也不会。
- 因此「M1 首层能托住并抬起 10 mm」这条绿只能引用为**概念验证**；生产塔现在的 `mode=verified` 只说明「行表来自几何 + 碰撞集里有同一工件身份的这块板（含朝向）」：`rest` 仍 `unsupported`（单条 1200 整带）、`carried` 仍 `diagnostic-only`（板不随塔轴移动、位移来源 `missing`）、多层 `feasible=false`（`load-passes-shelf` + `stroke-shortfall`）。**`verified` 不是结构可行，也不是承载认证**。

**做了什么（只动纯几何 API 与既有状态内部接线，不改任何干涉判据）**

1. 新增 `desktop/src/machine/panel-channel.ts`（纯函数，无内核）：
   - `resolvePanelSupport`：只有「件顶面贴板底 ±1 mm」才算接触；输出 `coveredPct / bandsY / contacts / verdict`，覆盖率按接触矩形**并集**解析计算（不是 10 mm 网格）；判据四条且阈值随回执回显（`≥15% / ≥2 带 / 带 x≥1900 / contact x≥1500`）。**板位姿三个数（`bottomZmm` + `centerXMm/centerYMm`）必须显式传入**，缺中心直接 `INVALID_ARGUMENT`（不默认 0），并回显 `panelCenterMm / poseSource / supportSource / claim`。
   - `resolveChannelFeasibility`：`pose` 必填（`bottomZmm/centerXMm/centerYMm`，与 `panel.center*` 冲突则拒绝）；carried 底面 = `pose.bottomZmm + max(0, 轴位移 − 拾取空行程)`，与 `interference-states` 的 `workpiece.bottomZ.lift` **同一公式**；轴位移/空行程来自 `carriedShiftMm`/`pickupGapMm` 或几何轴 `tower-lift`，两者都没有则按 0 处理并置 `m1.diagnosticError`（**缺失时不可能报 supported**）。**显式 `carriedShiftMm` 是受控输入（P1-R1）**：负值 `INVALID_ARGUMENT`、`shift > axis.strokeMm`（或板抬 > 行程）`INVALID_ARGUMENT`；几何没有 `axis.strokeMm` 时只作诊断；空行程只能靠 M1 缺省值时也只作诊断 —— 0/超行程/无轴证据都不许升成 `supported`。
   - `checkPanelChannel`：返回 `mode: 'diagnostic-only' | 'verified'`。**`verified` 只认两条证据：行表来自 geometry + 板在碰撞件集（parts 里有同一工件身份的件：同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg` 与占位体一致，转角周期等价）**：`rowsSource='caller'` 一律 `diagnostic-only`（调用方自带的行表证明不了属于本机，哪怕同时给 `pose`）；板只在占位体里（哪怕占位体自报 `inCollisionSet:true`）、或 parts 里只有同 id 但身份不符的件（role/size/center/rotation 任一不符）也是 `diagnostic-only`。生产塔现在两条都成立 → `verified`，但 `feasibility.feasible=false`、`rest claim='unsupported'`、`carried claim='diagnostic-only'`（板不挂轴）、`m1.feasible=false`。
2. `machine-geometry.ts` 的 `towerWorkpiecePart()` / `towerWorkpiecePlaceholder()`（T2 改）：真实板 2278×1134×35、底面 900 进 `geometry.parts`；占位体是**同一件的投影**（center/size 逐字段一致），`inCollisionSet` 由「parts 里有同一工件身份的成员」派生（2026-11-19 判据：同 id + role=workpiece + box size/center/rotationZDeg，转角周期等价；16 层为 true）。~~装配件数/BOM/STEP/成本/容量不变~~ —— **2026-11-19 更正**：装配件数 / BOM（96 行 qty 146）/ 成本 / 容量不变；STEP 由 sidecar 逐实例实体化，旧代码从 `geometry.parts` 全量导出，会多出板（147 instances）。现由 `machineExportParts()` 剔除 → 制造导出 **146**，碰撞几何 **147**（见文首表格）。
3. `interference-states.ts` 只读字段 `panelSupport / panelFeasibility / panelChannelNote` + `requirePanel:true`（缺板/非塔 → `INVALID_ARGUMENT`），判据未改。
4. `desktop/scripts/verify-channel.mjs`（`npm run verify:channel`）重写为**层数无关**：件数从 `parts` 派生、行程/净跨/走廊只校验关系，不再写 146 / 16 层 / ≥400 处；新增 4 条反例（中心偏移、位移 5、生产 placeholder、缺位移/缺位姿）。**`--levels` 2..64 全部 exit 0**：17 层起基线建造器会让 `gearmotor|column-bl` 相交 1 对（柱截面随塔高派生 → 柱位外移，`buffer-tower-assembly.ts` 的「往里收一个柱位」只在 ≤16 层成立），脚本把它单列为 `baselineNotes`、不计入通道自证，但**除这一族之外的任何 rest/lift 命中仍判失败**；≤16 层要求全 0。
5. 测试：`test/machine/panel-channel.test.mjs`（**33 条**）、`test/machine/buffer-tower-channel.test.mjs`（**21 条**），均加进 `test:focused`。其中 P1-R1/R2 的 fail-closed 有 4 条单测（位移 100 / 21 / 负值 → 拒；无 `axis.strokeMm` → 诊断；空行程 M1 缺省 → 诊断；caller rows → `diagnostic-only`），`panelSourceOfGeometry` 的 `center/size` 严格数字判据单列 1 条。（2026-11-19 更正：33/21 是那一轮的记法、本身也不准；现测 `panel-channel` 是 50 条、`buffer-tower-channel` 是 22 条 —— 见文首「测试清单」。不要拿 33 当基数算「这轮加了几条」。）

**两条阻塞 vs 两条保守设计口径（P1-3 的修正）**

| 项 | 结论 | 依据（实测） |
|---|---|---|
| 承托面挡路 `load-passes-shelf` | **成立**——板投影内的第 2 层承托面，纯 Z 上升必穿过 | 16 层件表：板投影内、板顶以上承托面 **89 件 / 15 层**（数字随件表派生，不写快照） |
| 行程缺口 `stroke-shortfall` | **成立**，但口径是 **M1 叉指停位** | `required = (levels−1)·pitch + 6.5 + 10`；16 层 2700 → 2716.5（缺 16.5）。现轴台面 `lift-platform` 实测 AABB **z 970..1010**（顶面 1010、底面 970），该停位口径下并不缺，**不得读成现轴缺陷** |
| 净跨 `2000 < 2278` | **降级为 `designNotes`（保守设计余量，需结构确认）** | 立柱内侧面 y=±675、板 y 半宽 567 → **y 向重叠 0 mm**；行程内柱与板体 AABB **相交 0 件**；板是从前后两排立柱之间穿过去的。**不得写成「任何整板过不去」** |
| 走廊 `135 < 板半宽 567` | **降级为 `designNotes`** | 同上口径问题（拿「托板边到柱内侧」比「板半宽」，量纲与对象不同）；板边距柱面仍有 ≥108 mm 净距 |

**实测（本机 node v26.7.0，`npm run verify:channel` + `npm run test:focused`，修复后）**

| 对象 | 实测 |
|---|---|
| 真实塔件表（`parts.length` = 146 @16 层） | `rest` = 38 对 / 0 命中 / pass；`lift` 同；`sweep` = pairs 42 / confirmed **270** / screen **135** / fail（与基线一致，判据未放宽） |
| 真实塔承托（`mode=verified`，板在碰撞集） | `rest` 覆盖 **100%** / 1 条接触带 → `verdict=unsupported`、`claim=unsupported`（不分诊断）；`carried` 底面 = 静止底面（**不编 910/3600**）、`claim=diagnostic-only`（板不随塔轴移动、位移来源 `missing`，`m1.diagnosticError` 有原因） |
| 真实塔通道 | `feasible=false`；blockers = `load-passes-shelf`（witness：距板顶 **98.5** / 距板底 **133.5** mm，首件 `tray-roller-2-in/out`，由件表算、删/移第一处遮挡即变）/ `stroke-shortfall`；designNotes = `clear-span-conservative` / `corridor-conservative` |
| M1 概念件表（夹具 152 机台件 + 板 = 153 刚体 / 装配 152 / 包络 2430×1790×3840） | `rest` / `lift` / `sweep` = **0 / 0 / 0 pass**（20 mm 段）；`mode=verified`、`supportSource=geometry`；承托 `rest` **80.6%**（3 带）supported、`carried` **15.48%**（2 带）supported；位移 **20（来源 axis）→ 板抬 10**；多层仍 `feasible=false` |
| 自证 23 条（**正向 12 / 负向 11**，`verify:channel`） | 正向 = 行程不变量、净跨关系、走廊关系、柱与板 AABB 不相交、多层不可行（blockers 白名单）、自由上升 witness（由件表最低遮挡件派生）、单条 1200 整带 → claim 降级、几何件数语义（装配件 + 1）、rest/lift 通道相关命中 0、M1 三态、M1 承托 supported、M1 多层仍 false。负向（N1–N11）= 叉在板外 → 承托 0%/contacts []；缺板 → `INVALID_ARGUMENT`；叉宽 120 > 缝 110 → sweep 红且 blamed 指到 `lift-finger`；超行程 40 → blamed 含 `belt-top×lift-carriage`；满行程 → sweep 红且 blamed 含板/托板；非塔 → `NOT_A_TOWER`；**中心偏移 300 → 覆盖率 80.6%→72.22%**；**位移 5 → 报告 5、carried 底面不变、m1.feasible=false**；**合成旧几何（板移出 parts、占位体伪 `inCollisionSet:true`）→ diagnostic-only**；缺位姿 → 拒绝；缺位移 → 不伪造绿 |
| 门禁 | `npm run verify:channel` → `TOWER_CHANNEL_RESULT ok`，自证 **23/23**（正向 12 / 负向 11），exit 0；`--levels 2 / 16` 同为 23/23、exit 0（17 层起多一行 `baselineNotes`：`gearmotor|column-bl` 基线重叠，非通道判据）；定向 `node --test test/machine/panel-channel.test.mjs test/machine/buffer-tower-channel.test.mjs` = **54/54 pass**；`npx tsc --noEmit` = 0；`git diff --check` = 0（均本机，全量 `npm test` 未跑）。（2026-11-19 更正：两份文件现测是 50 + 22 = 72 条，`54/54` 与 `72` 都只是清单相加；没有任何一次运行在这棵树上把两份一起跑出 72，可引用的只有 50/50、22/22 两次分文件实跑。见文首「测试清单」。） |

**口径更正（必须一起读）**：架构文档 §4 写的 82.5% / 17.0% 与它自己的件表尺寸不符——`2278×914 / 2278×1134 = 80.61%`、`2×2000×100 / 2583252 = 15.48%`。本轮按**实测**记账，**没有为了对齐文档改阈值**；`carried` 只剩 0.48 个百分点余量，所以这条 15% 阈值不能再抬。

**CI 边界（2026-11-19 17:05 补记：以下「不在 CI」是 2026-11-18 的状态，已过时）**：`fa7e215` 已把 `verify:channel --levels 2 / 16` 加进 `ci.yml` 的 `featuretree-geometry` job，run `44491644544` 该 step 已 ✓。原文保留：`npm run verify:channel` **不在 CI 里**（`.github/workflows/ci.yml` 只跑 `npm test`）；负向用例在测试文件里，所以 `npm test` 覆盖仍然存在，但「22/22 自证」这条只有本机跑过。（历史数字：现为 **27/27**；`npm test` 在 CI 上 2026-11-19 已跑，本机同树 3659/3656/3/0。）

**本轮没跑**（历史 · 2026-11-18 那一轮）：STEP / 内核（152 件没进 build123d，`verify:step-tower` 仍是 146 件基线）、`regen:pv-buffer`、全量 `npm test`、CI、Electron 冒烟。**现状（2026-11-19 17:05）**：这些后来都跑过 —— 内核 8/16 层（本轮 13/13、20/20）、regen（61/61）、全量（3659/3656/3/0）、CI（run `44491644544` 7/7）、**本机 Electron 冒烟（`SMOKE_OK`、exit 0、27.6 s、0 FAIL、3 SKIP）**。

**遗留（都在本节范围内未解决）**：M1 只证明「首层托住并抬起 10 mm」，**不是多层可行**；生产塔的板已在碰撞集里（`mode=verified`），但**没有通道承托路径**（无叉指/无分段带/板不挂轴）：`rest unsupported`、`carried diagnostic-only`、`feasible=false`；板挠度、导向/同步、防坠/抱闸、安全回路、PLC/IO 全部未建未验；真实塔 `sweep` 仍 fail；行程缺口 16.5 mm（M1 叉指口径）未修；净跨/走廊的「保守设计阻塞」需要结构专业确认，本仓库只提供 AABB 读数。

## 上一轮（已提交；历史 · 2026-11-17/18 期间）做了什么

1. 新增 `desktop/src/machine/buffer-tower-assembly.ts`：`config.bufferTower` 塔身建造器，容量身份与几何入参分离、fail-loud 不夹紧、储位由零件表真派生、塔升降轴 `tower-lift`（行程 2700，`strokeSource:'geometry'`）。
2. `buffer-control.ts`：锁存故障期来料改为回 `ITEM_REJECTED_FAULT`（不进队但给拒绝事件），重复件号仍 `ITEM_REJECTED_DUPLICATE`。
3. `test/machine/sync-subprocess-scan.mjs`：静态守卫从只匹配 `execFileSync(` 改为扫 `execFileSync|spawnSync|execSync`，剥注释、排除字符串/属性，主断言与负例共用同一函数；`design_machine` 的 CLI 错误分流补 `NOT_IMPLEMENTED` / `INTERNAL_ERROR`。
4. 串行跑完 focused → tsc → build:ext → 全量 test → regen → project-session-smoke；更新交接文档。

### 上一轮实测（已提交，历史数字）

| 步骤 | 命令 | exit | 关键数字 |
|---|---|---:|---|
| focused | `npm run test:focused` | 0 | **221 / 221** pass，0 fail，5.75 s |
| 类型检查 | `npx tsc --noEmit` | 0 | 0 诊断 |
| 构建 + 体积门禁 | `npm run build:ext` | 0 | extension **2 927 156 B**，gzip **914 998 B**，wasm 7 604 031 B |
| 全量 | `timeout -k 15 600 npm test` | 0（复跑） | **3463 tests / 3460 pass / 0 fail / 3 skipped**，201.8 s |
| 重生成 | `npm run regen:pv-buffer` | 0 | `PV_REGEN_RESULT ok=true checks=58 failed=0`，**8 层 90 件**真几何 |
| 会话冒烟 | `project-session-smoke.mjs` | 0 | `PROJECT_SESSION_SMOKE_CAD_PASS parts=1` + `PROJECT_SESSION_SMOKE_PASS` |

这些数字是**上一轮**的历史，本轮已全部重跑（新值见下）。

## 塔 B-Rep 入口那一轮（历史 · 2026-11-18，当时未提交，多数已随 `18b08bb`/`7b089a1` 落地）做了什么

1. **塔的 B-Rep 入口接通**（S1–S4）：`MODEL_BUILDERS` 加 `buffer-tower`（参数清单与塔身上下限同源、`rangePolicy:'reject'` 越界拒绝）；`build_machine_model` 按塔建 **146 件**（`bufferTowerParamsFromConfig` + `buildBufferTowerParts`，与 `apply_machine_design` 同一份零件表）；工程保存新增 `design`（`panel/inbound/frame` 以前走 `params` 会被静默过滤）；升降轴多件化（侧叉/梳齿台面按件族全带走）。
2. **`design`/`config` 入参进命令层**：`build_machine_model` 白名单从 `process/params/name/load/brief` 扩到含 `design`/`config`，并原样透传、要求是对象、`design` 与 `config` 二选一。以前 `未知参数：design` 直接拒，「`design_machine` 出塔 → 同一份 design 去整机建模」这条链对智能体不可达。
3. **分派判据只有一份**：`isBufferTowerConfig`（`config.bufferTower.kind === 'tower'`）+ `resolveModelDispatch`，命令层/渲染层/几何层共用。只给 `design`（不写 `process`）→ 按塔建；显式 `process:'conveyor'` + 塔 design → **冲突，显式拒绝**；声明是塔却没 `bufferTower` → 拒绝。**不再有「同一份 design 出 146 件 / 29 件且 `ok:true`」。** 入口形状同口径：`design`/`config`/`design.config`/`params` 必须是非数组对象，**`process` 给了就必须是非空字符串**（`123`/`{}`/`[]`/`'   '`/`null` 以前被静默当「没写」→ 默认 conveyor 29 件且 `ok:true`，现在命令层与工具层都是 `INVALID_ARGUMENT`、bridge 0 次）。
4. **塔分支几何收尾**：整机建模的塔分支现在也走 `resolveMachineGeometry`（`towerGeometry`：`assertTowerAboveGround` 地面线守卫 + 随动件标注），并断言两条链件数一致，不一致报 `INTERNAL_ERROR`（以前绕过守卫，同一份 config 在 `design_machine` 会被拒、在这里照建照存）。
5. **整机 STEP 完整性门禁**（`desktop/scripts/verify-step-tower.mjs`，`npm run verify:step-tower`）：根因是整机级**逐件累计布尔并**丢件（16 层 146 件只出 86 实体、顶点 z 只到 3636）。`spike/build123d/app.py` 改成一次性 `fuse` + 合并后包络/体积自校验 + 失败回退 Compound；门禁按「整机 STEP 顶点包络 == 逐件 STL 顶点包络并集」判，并挂实体数与件数。CI 在 `featuretree-geometry` 里跑 16 层 + 8 层。
6. **门禁判据本轮改严**：容差**按端**取（min/max 各看自己的极值件，不再共用最大圆柱半径）、且只对**垂直于回转体轴**的方向给半径（轴向端面严格 ±1）；逐件 `solids` 缺失**判红**（不再按 1 计）；**合并回退即失败**，且 **build 模式 `merge` 元数据缺失也判红**（以前 `if (mergeMode)` 会让整条检查消失，9 项变 8 项仍全绿）；`--file` 模式默认判红（合并路径无法从裸 STEP 判别），只有显式 `--merge-manifest` 才判；`app.py` 非 perPart 时不再写 `partSolids=0`。CLI 级测试补到 6 条（`--levels` 非法 / `--file` 不存在 / 桩 STEP / manifest fuse 通过 + compound 红 / **manifest 三种形状（`{merge}` / 扁平 `{mode,fallback}` / 整份 `{stats:{merge}}`）** / 证据不合格 exit 2）。

### 那一轮已跑（历史 · 2026-11-18 当时的本地实测；工作区今天已不同，不是现状）

| 目标 | 结果 |
|---|---|
| `test/agent/build-machine-model.test.mjs` | 14 / 14 pass（含 design/config 透传、冲突/缺失/形状拒绝、非塔 design 与双源拒绝、不支持机型命令层拒、**`process` 非字符串/空白在命令层与工具层都拒**） |
| `test/machine/buffer-tower-model.test.mjs` | 19 / 19 pass（含分派判据、分派层形状/双源/机型拒绝、**`process` 形状拒绝（数字/对象/数组/空串/空白/null）**、146 件、保存往返、升降轴、源码接线） |
| `test/parametric/verify-step-tower.test.mjs` | 27 / 27 pass（含按端容差负例、solids 缺失、merge 缺失/复合回退即失败、file 模式 merge 未验证判红、6 条 CLI 用例含 **manifest 三种形状**） |
| `test/electron/projects*.test.mjs` | 29 / 29 pass |
| `npm run test:focused` | **281 / 281 pass**，0 fail，0 skip，6.16 s |
| `npx tsc --noEmit` | exit 0，**0 诊断** |
| `npm run build:ext` | exit 0，extension **2,938,104 B**，gzip **918,889 B**，wasm **7,604,031 B** |
| `timeout -k 15 900 npm test` | **3518 tests / 3515 pass / 0 fail / 3 skipped**，204.3 s |
| `npm run verify:step-tower -- --levels 16`（真内核，2026-11-18 那一轮） | **146 件，STEP 2,301,982 B，104 solids，812 faces，mode=fuse，9/9 PASS** |
| `npm run verify:step-tower -- --levels 8`（真内核） | **90 件，STEP 1,622,322 B，55 solids，538 faces，9/9 PASS** |
| `npm run verify:step`（旧 85 件整机） | **7 / 7 PASS** |
| `npm run regen:pv-buffer` | `checks=58 failed=0`，仍 8 层 90 件，scene 90/90 |
| `project-session-smoke.mjs` | `PROJECT_SESSION_SMOKE_PASS`，exit 0 |

原始日志：`/root/.hermes/cache/scratch/cad-brep-lastmile-{focused,tsc,build,npm-test-close,kernel-final}.log`、`cad-brep-final-09-project-session-smoke.log`。

### 那一轮没跑（历史 · 2026-11-18 那一轮；该结论对 `1c803f6` 早已不成立）

- **（历史）CI 当时未跑**：`featuretree-geometry` 的 16/8 层步骤从未在那个工作区上执行过。**现状**：`1c803f6` 的 run `44491644544` 已 7/7 绿，16/8 层步骤在 CI 上真实执行（16 层 20/20、8 层 13/13）。
- 结构强度/挠度/防坠、安全回路、电气、PLC 联调——未校核/未验收。
- 所有机械 `sweep` 干涉仍 **fail**。

## 塔身几何：静态几何存在、B-Rep 核验跑通，机构/结构未验收

> **件数口径（2026-11-19 补记，本节其余内容沿用 2026-11-18 记录）**：本节「146 件」= 装配件 / BOM / 制造导出（STL / glTF / sidecar → STEP）口径，今天仍成立；**碰撞几何是 147**（`geometry.json` / `geometry.parts`，2/8 层 49/91）。`verify:step-tower` 的「146 件 → 104 solids」是制造导出计数，不是碰撞刚体数。

`config.bufferTower` 是**另一套语义**，与 `layers:8` 并列不合并：`levels=16 / slotsPerLevel=1 / slotsPerTower=16` → 塔身建造器出 **146 件 / 设计包络 [2430,1790,3840] / 柱高 3840 / 柱截面 80（反算）/ 16 层 × 1 位 / 可用储位 15 / 升降行程 2700**，`slots.fromGeometry=16 claimed=16 aligned=true`。这是**静态件表 + AABB**，不是可制造结构。

- **入口**：`design_machine` + `apply_machine_design`（`resolveMachineGeometry`），以及本轮接通的 `build_machine_model`——三条入参路径：`process:'buffer-tower'` + 扁平参数、`design`（`design.config.bufferTower` 权威）、`config`（`design.config` 简写）。
- **B-Rep/STEP（2026-11-18 那一轮真内核）**：整机建模出逐件 STL + 合并 `model.step`，门禁 `npm run verify:step-tower` 已落地。
  - 16 层：**146 件 → 2,301,982 B / 104 solids / 812 faces / mode=fuse / 9/9 PASS**；STEP 顶点包络 **2430×1770×3840**。（**现行脚本已改为 16 层 20/20（9 内核 + 3 逐件身份 + 8 导出边界）、8 层 13/13（9 内核 + 3 身份 + 边界 N/A），见文首**）
  - 8 层基线：**90 件 → 1,622,322 B / 55 solids / 538 faces / 9/9 PASS**。
  - **容差口径（上一版写反了，已更正）**：两个规模下逐件 STL 的 Y 上界都比 STEP 高 **19.99 mm**。这 19.99 mm 是 **Ø40 竖直（轴 Z）升降导柱的径向母线**：B-Rep 顶点只落在圆柱接缝（y=780）上，真实外形到母线（y=800），差 = 半径 20；判据只在**垂直于导柱轴**的方向（x、y）给半径 20 mm，**沿轴（Z）的端面严格 ±1 mm**（`minAllowance=[1,1,1]`、`maxAllowance=[1,20,1]`，逐端取极值件）。即「端面/平面端严格 ±1、回转体径向给半径」，不是「水平圆柱端点 20 mm 容差」。因此是「声明容差内通过」，**不能宣称逐点完全一致**，也**不是制造验收**。
  - **覆盖范围（判别力边界）**：门禁是包络/数量级证据（顶点并集、实体数与件数挂钩 0.6×下界、逐件 bbox 与内核自报一致、合并路径必须 fuse），**不是逐件身份**：内部件丢失只要不动轴极值、且丢后实体数仍在下限之上就看不见——16 层 floor=88 实测 104（可丢 16 个实体），8 层 floor=54 实测 **55**（**只丢 1 个实体仍然绿**）。实体/件数比 16 层 0.71、8 层 0.61 只是「没整层丢光」的下界。**门禁通过 ≠ 逐件身份核对、≠ 制造验收。**（**2026-11-19 17:05 补记**：`afe65a9` 已加逐件 B-Rep 占位覆盖 + 被包住件豁免上限 + 件号唯一性，「丢 1 个实体仍绿」不再必然；但仍只到「≥1 顶点」级，比例豁免仍可吞 ≤10%。）
  - **合并路径是硬门禁**：build 模式 `stats.merge` 缺失即判红；`compound`/`fallback:true` 即失败。`--file` 模式裸 STEP 判不了 fuse 与 compound 回退，**默认判红（未验证）**，要 PASS 必须显式 `--merge-manifest <构建期 stats.merge JSON>`（`mode` + `fallback` 布尔值）；接受的形状就是**实现并测过的那三种**：`{merge:{mode,fallback}}`、扁平 `{mode,fallback}`、整份 stats `{stats:{merge:{mode,fallback}}}`（多余键忽略）。**`--file` 不是验收模式。**
- **质量口径两条**：整机建模 = 按内核体积**折算**质量（非称重）；`design_machine`/`apply_machine_design` = `massKg:null`、`massSource:'not-measured'`，`bomDraft` 仍是 8 行底架口径、塔身 117 件只在 `bomCoverage` + `warnings` 里标注、`costScope:'base-conveyor-only'`。
- **动态干涉**：`rest` / `lift` = **pass**（38 对、0 命中）；**所有机械 `sweep` 仍 fail**（pairs 42 / hits 405 / confirmed 270 / screen 135）—— 台面在托板投影内、层托板是整块板，没有升降通道，真实机构缺口，不得改判。
- **结构**：只有屈曲手算量级，`structure.accepted:false`；柱截面 80 mm 折算后仍超许用约一成以上。静态几何「存在」≠「可承载」。

## 8 层 ≠ 16 位

`layers:8` 的几何只有 **8 个储位**（第 1 层是底层输送线）。**`0cb7e1a` 之后储位不再靠 `(layers)=>layers` 回声**：regen 从工程件表派生（`source:project-parts`、`fromGeometry=8`、`levelsFromGeometry=8`、`slotsPerLevel=1`、`towers=1`、逐层 trace），输出 `claimedSlots=16 aligned=false` —— 这是几何与声明真比较后的结论。`npm run regen:pv-buffer` **仍是 8 层 90 件**（包络 [2430,1690,2400]），塔**不在** regen 路径上。

- 本轮 regen 已重跑：**`checks=61 failed=0`，8 层 90 件，scene 90/90**；产出的 STEP 为 **1,622,322 B / 55 实体 / 538 advanced faces**（与 8 层基线一致）。旧的 781,970 B / 47 实体 / 264 faces 是**历史丢件产物**，不要引用。
- `PV_REGEN_NOTE` 文案在脚本 `desktop/scripts/pv-buffer-regenerate.mjs` 内：「16 层塔身几何已由 bufferTower 建造器生成（146 件静态件表），但不在本脚本路径上，故本报告无塔 B-Rep/STEP；本脚本不把 8 层冒充 16 位」。**这段文案与 `BASELINE` 注释是 2026-11-18 那轮改的**（旧文是「16 位只存在于 bufferTower 纯数据槽位模型」，BASELINE 里还写着旧的 781,970 B / 47 实体）；本轮 `checks=61` 的实跑（`cad-opt-gate-regen.log`，16:48:24）输出里那行 `PV_REGEN_NOTE` 已带新文案与逐层 trace。

## sceneIntegrity 现状与剩余风险

现状：计数等式门禁。两个计数必须是非负整数，模型件数 == 场景件数（可再要求等于期望件数），否则 `complete=false`（`assertSceneIntegrity` 抛错）。UI 页脚显示 `场景完整性：90/90 件`。

剩余风险：

- 只证明件数一致，**不证明几何正确**：错形状、错位置、错层高、错朝向都能 90/90 通过。
- 不证明 180 mm 层距下的 lift/sweep/push 动态干涉、结构强度、挠度、防坠。
- 计数来自 viewer 诊断聚合，历史上出现过实例重复计数（已修）；新增实例化路径必须重跑 `test/cad/scene-integrity.test.mjs` 与 regen 的 90/90 断言。
- 塔的 146 件没有对应的 sceneIntegrity 断言（regen 只覆盖 8 层）。
- STEP 门禁已有**逐件占位覆盖**（本轮 `afe65a9`：非被包住件每件至少 1 个整机 STEP 顶点落在自己包络内 ±1 mm），但仍是**顶点级、不是面级/实体级身份**，且比例豁免（≤10%）仍可静默吞件（16 层余 12、8 层余 7）。
- `complete=true` 不是「可以交付制造」的结论。

## 不要宣称的东西

- 不要说「缓存机已实现」：现有的是纯数据状态机 + 逻辑 IO 草案（地址 `null`，`executable=false`）。
- 不要说「塔已出 B-Rep 并已验收」：STEP 出口已通，门禁已落地并在**局部真内核 8/16 层实跑**（本轮 16:47：8 层 **13/13**、16 层 **20/20** = 9 内核 + 3 逐件身份 + 8 条导出边界）；但逐件身份只到「≥1 个顶点落在包络内」、容差 19.99/20 mm、**不是逐点/逐面完全一致、不是制造验收**。**CI 已跑过**（run `44491644544`，`1c803f6`，7/7 绿，16 层 20/20 + 8 层 13/13 在远端复核），同样只到包络/顶点/导出边界级，不改变这条限制。可以说的是「16 层塔身静态几何 146 件、整机建模入口接通、STEP 门禁本地与 CI 上都是 8 层 13/13、16 层 20/20（含 3 条逐件身份 + 8 条脚本级导出边界）」。同理**不要写「导出边界已由内核门禁验证」**：那 8 条是 sidecar 级断言，不经内核输出。
- **不要写「`verify:channel` 不在 CI」**（`fa7e215` 之后它就在 `featuretree-geometry` job 里跑 2/16 两档），也**不要写「本机 Electron 冒烟未跑」**（2026-11-19 本机实跑 `SMOKE_OK`、exit 0、27.6 s、0 FAIL）。反过来也**不要写「`verify:channel` 已在 CI 上验证结构可行」**：它仍是诊断脚本，`feasible=false` 与 `sweep` 405 不变。
- 不要说「动态干涉/强度已校核」：静态 AABB 命中不等于制造碰撞结论；塔的 `sweep` 仍是 fail。
- 不要说「结构/安全/电气/PLC 已验收」：结构只有屈曲手算、`accepted:false`；IO 地址全 `null`、`executable=false`；无 PLC 程序、无安全回路。
- 不要用 focused 的子集结果替代全量结论，也不要把旧迭代的 250 mm 产物当成 180 mm 结果，更不要把 regen 的 8 层 90 件当成塔。
- 不要引用 781,970 B / 47 实体那组 STEP 数字（历史丢件产物），也不要拿上一轮的 221 / 3463 / 2 927 156 B 当本轮现状。
- 不要说「BOM/STEP 一件不动」：BOM/成本/容量不变是真的，制造导出件集也确实等于装配件数（146），但**碰撞几何是 147**（含板），修复前 STEP/STL/glTF 还真的多出过这块板。说件数时必须点名口径（碰撞 / 制造导出）。

## 下一步建议

> **注意：本节是 T9 轮写的建议**（对应 `1c803f6` / run `44491644544`），保留原文不改数字。
> 文中第 1 条的「门禁已跑完、六笔已推送 / CI 通过」只对 `1c803f6` 的 run `44491644544` 成立，不是现状 —— **R10 的两次 run（`44506016602`、`44508941094`）都红**，见文首。
> R10 轮的当前状态与终验顺序见文首、`HANDOFF-NEXT-SESSION.md` 与 `docs/desktop/R10-ITERATION.md` §2。

1. **门禁已跑完、六笔已推送、CI 已绿**（本轮 16:44–16:51 对应 `1c803f6`；远端 run `44491644544` 对 `1c803f6` 7/7 绿）：focused 405/405、全量 3659（3656 pass / 3 skip / 0 fail，116,728 ms）、tsc exit 0、kb 13/454/434,531、`verify:channel` 2/16 各 27/27、`verify:step-tower` 8 层 13/13 / 16 层 20/20、`verify:step` 7/7、regen 61/61、`build:ext` 2,946,350 B / gzip 921,963 B。**这些不需要重跑**（`1c803f6` 只动 `kb.json`；CI 已独立复核到同一棵树的门禁步骤）；**只有改了源码/测试才必须整轮重跑**，命令照抄、全部在**同一次会话、同一棵树**上跑完：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   node --test test/machine/buffer-tower-channel.test.mjs            # 清单 22
   node --test test/machine/panel-channel.test.mjs                   # 清单 50
   node --test test/agent/interference-panel-diagnostics.test.mjs     # 清单 10（不是 14）
   node --test test/machine/geometry-export.test.mjs test/parametric/verify-step-tower.test.mjs
   node scripts/verify-channel.mjs --levels 2 / 16                    # 两次 27/27、TOWER_CHANNEL_RESULT ok（CI 同档）
   npx tsc --noEmit
   npm run test:focused                                               # 本轮 = 405
   timeout -k 15 900 npm test                                         # 本轮 = 3659（3656/3/0）
   npm run build:ext                                                  # 记录 extension/gzip 字节数（本轮 2,946,350 / 921,963）
   npm run verify:step-tower -- --levels 16                           # 9 内核 + 3 身份 + 8 边界 = 20/20
   npm run verify:step-tower -- --levels 8                            # 9 内核 + 3 身份 + 边界 N/A = 13/13
   npm run verify:step                                                # 85 件，7/7
   npm run regen:pv-buffer                                            # 本轮 = 61 checks
   npm run kb:build                                                   # 本文件不在 KB_DOC_FILES，统计不变
   git diff --check                                                   # 必须无输出
   ```
   跑完**只把实测值写回文首「当前状态速览」**（注明时间、日志文件名），不要顺手改历史段落。**六笔提交已落库并推送**（`afe65a9` 逐件 STEP 身份、`f81b697` feature box 合一、`0cb7e1a` 储位派生 + eval 跳过、`fa7e215` sidecar 错误索引 + channel 进 CI、`faf2665` cli 记忆化、`1c803f6` 重建 kb；分组见 `HANDOFF-NEXT-SESSION.md`「文件落库情况」），不用重做提交、不要重排已推送历史，也不要 `git add -A`；`scratch/` 下 `cad-opt-*` 报告与日志永不提交。**下一步**：本文件改完后只 add 这两份文档 → 提交 → `git push origin main` → `git rev-parse HEAD` 记 SHA → `gh run list --limit 3` 确认新 run 的 `headSha` 等于它 → `gh run watch <run-id>`。**已验基线**：`1c803f6` / run `44491644544` 7/7 绿，`featuretree-geometry` 的 16/8 层步骤（`ci.yml:856-857`）真实通过（16 层 20/20、8 层 13/13），**`verify:channel --levels 2/16` 也已在 CI 里跑过**。
2. **补覆盖盲区**：`machine-geometry.ts` 与 `geometry.ts` 的注释/assumptions 已是「碰撞刚体 = 装配件+1；BOM 96/qty146、制造导出 STL/glTF/sidecar→STEP = `ConveyorPart` 48/90/146，板由 `machineExportParts` 排除；成本/容量不变」，`machine-geometry.ts:1043`/`:1126` **也已改好（旧 P3 作废）**。`verify-channel` 的 N12 已覆盖同 id 托板 + role/size/center/`rotationZDeg=90°`（**五维都有门禁**），N13/N14 覆盖坏坐标与承托面几何 fail-closed。**导出边界已实跑**（16 层 20/20 含 8 条、8 层 13/13 含 1 条 N/A，build 起内核前先判、`--file` 也判），但它是 sidecar 级断言、**不走内核输出**；本轮补的逐件身份只到「≥1 顶点」，仍缺「逐实体 bbox / 件族对应」与豁免绝对上限。**另：`ci.yml` 的 `verify:step-tower` 与 `eval:tasks` 仍未带 `--require-full`**，SKIP / `degraded=true` 在 CI 上仍算绿。
3. **设计可承载的升降通道**：托板开口/梳齿/避让，让 `sweep` 的 405 命中归零，再谈机构可行性。
4. **堵 STEP 内部件盲区（剩余部分）**：本轮已有逐件占位覆盖（≥1 顶点 + 豁免上限 + 件号唯一），下一步是**逐实体 bbox / 面级匹配 + 件名-件族对应**，并给豁免加绝对上限（真机实测 2 件），把「≤10% 静默丢件」关掉。
5. 结构/安全/电气/PLC 校核与验收；接现场前补计数器同步入口（故障期拒绝已有 `ITEM_REJECTED_FAULT`）。
6. `npm run kb:build` 只索引 `KB_DOC_FILES` 里那 13 份文档（本文件不在其中）；改了那 13 份要重建，否则 `test/agent/kb-freshness.test.mjs` 失败。
7. 始终保持有界跑法：`timeout -k 15 600 npm test`；不要把无界等待当通过。
