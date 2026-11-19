# AutomationCAD 下一会话交接

更新时间：2026-11-19 10:35（**T8 CI 回填轮（本轮）**：只改本文件与 `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`，不动源码/测试、不跑构建。**当前 HEAD `dec1373` = `origin/main`（已推送，工作区干净，ahead/behind 0/0）**；四笔 `920ea07` → `b85fab5` → `8037e11` → `dec1373` 全在远端。**远端 CI 有实测结论：run `44444540414`（head `dec1373a6aa1fc3380636c9e8e4c5ab72be56212`）7/7 job success，2026-11-19 10:28–10:33 CST**：`FeatureTree real geometry (build123d)` job 真实跑了 16 层 `verify:step-tower` **17/17**（9 内核 + 8 导出边界）、8 层 **10/10**（9 内核 + 1 条导出边界 N/A），并过了 STEP 真实性门禁与 AABB↔布尔误差；`tsc + unit tests` job 跑出 **3614 tests / 3611 pass / 3 skipped / 0 fail**。链接 https://github.com/owlco001/automation-cad-prototype/actions/runs/44444540414 。**口径边界**：这个 run 验的是 `dec1373` 这棵树（docs-only，只改两份交接文档，源码/测试与 `920ea07`+`b85fab5` 一致）；**本轮之后再提交的 docs-only commit 在 push 之前没有自己的 run**。final6 本机数字保留为实测证据；「21 M + 1 ?? / 未提交 / CI 未运行」一律改作历史。上一轮 T4 的 N14 自证 27/27 记录保留，标为「N14 轮」）
项目：`owlco001/automation-cad-prototype`
工作目录：`/tmp/automation-cad-prototype`

## 当前状态（2026-11-19 · HEAD `dec1373` = `origin/main`，工作区干净；final6 本机门禁 10:04–10:10 对应源码提交 `920ea07`+`b85fab5`，文档随 `8037e11`/`dec1373` 定稿；远端 CI run `44444540414` 对 `dec1373` 7/7 全绿）

- **当前 HEAD：`dec1373`**（`docs: align handoff with committed PV board changes`）= `origin/main`，**已推送、本地与远端同点（ahead/behind 0/0）**。`git status --short` **无输出**，仓库内 `scratch/` 已删。四笔链（按提交顺序，全部已在远端）：
  - `920ea07` `feat(machine): add workpiece collision and manufacturing export boundary` —— 板进 `geometry.parts`、制造导出三层身份 + 装配件窗口、`verify-step-tower` 8 条导出边界门禁、件数注释（8 文件）；
  - `b85fab5` `fix(machine): fail closed on invalid support evidence` —— 承托/件表 fail-closed（N12/N13/N14）、`panelChannelNote` 按 claim 出文案（P2-1）、行表 dropped（P2-2）、7 文件；
  - `8037e11` `docs: record PV board export and diagnostic verification` —— 两份交接文档、`NL-AGENT.md`、`MODULE.md`、README kb 统计与 `kb/kb.json`（`KB_BUILD_OK` 13/454/434531，6 文件）；
  - `dec1373` `docs: align handoff with committed PV board changes` —— **只改两份交接文档**（`HANDOFF-NEXT-SESSION.md` + `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`，2 文件 +54/−63），不动源码/测试/kb；**远端 CI run `44444540414` 验的就是这一笔**。
- **历史（提交前快照）**：收口前是 `114e024` + **21 M + 1 ??**（`??` = 临时回执目录 `scratch/`）。那 21 个 M 已全部进上面的 `920ea07`/`b85fab5`/`8037e11` 三笔（分组见文末「文件落库情况」），`scratch/` 未入库并已删除；**不要再按「工作区 21 M 未提交」描述现状**。
- **时效已对上（保留原证据）**：源码/测试最后改动 09:42:40–09:48:06，final6 日志 10:04–10:10，晚于全部改动：`interference-states.ts` 09:42:51、`panel-channel.ts` 09:44:53、`geometry-export.ts` 09:44:21、`verify-step-tower.mjs` 09:45:36，对应测试 09:42:40–09:48:06（`panel-channel.test.mjs` 09:44:10、`verify-step-tower.test.mjs` 09:46:48、`geometry-export.test.mjs` 09:48:06）；`kb:build` 于 10:05:04 重写 `desktop/src/agent/kb/kb.json`（final6 内），该文件的最终统计随 `8037e11` 入库。**final6 就是 `920ea07`+`b85fab5` 这两笔源码的证据**；`8037e11` 只动文档与 kb，不改源码/测试，所以那些数字仍对应当前源码。final5（09:22–09:28）只作历史，不再引用。
- **门禁状态（final6 全套，10:04–10:10；对应源码提交 `920ea07`+`b85fab5`）**：targeted **205/205**、focused **370/370**、全量 **3614 tests / 3611 pass / 3 skipped / 0 fail（205,933 ms）**、`tsc --noEmit` exit 0、kb **13 docs / 454 chunks / 434,531 B**、`verify:channel` **2/8/16 各 27/27**、`verify:step-tower` 8 层 **10/10**、16 层 **17/17**、`verify:step` **7/7**（85 件，1,930,477 B）、regen **58/58**、`build:ext` **2,941,695 B / gzip 920,422 B / total 10,545,726 B**。**CI 已在远端跑通（run `44444540414`，head `dec1373a6aa`，7/7 job success，2026-11-19 10:28–10:33 CST，https://github.com/owlco001/automation-cad-prototype/actions/runs/44444540414）**：`FeatureTree real geometry (build123d)` job 里 `ci.yml:856-857` 的 16 层 / 8 层 `verify:step-tower` **确已在 CI 上真实执行并通过**（16 层 **17/17** = 9 内核 + 8 导出边界；8 层 **10/10** = 9 内核 + 1 条导出边界 N/A），该 job 还过了 STEP 真实性门禁与 AABB↔布尔误差；`tsc + unit tests` job 跑出 **3614 tests / 3611 pass / 3 skipped / 0 fail**（136.8 s，与 final6 本机 3614/3611/3/0 一致）。**`verify:channel` 仍不在 `ci.yml`**，27/27 只有本机证据。**范围**：该 run 验的是 `dec1373` 这棵树；`dec1373` 只动两份文档 → 等价于验 `920ea07`+`b85fab5` 的源码；**本轮之后再提交的 docs-only commit 在 push 前没有自己的 run**。告警只有两类、全部非致命：① 多个 job 的 `##[warning]Node.js 20 is deprecated`（`actions/checkout@v4`/`setup-python@v5`/`setup-node@v4`/`upload-artifact@v4`/`msvc-dev-cmd@v1`/`setup-micromamba@v1` 仍是 Node20 action，被强制跑在 Node24）；② Windows Qt job 里一处 `powershell is not supported`。**没有任何 `##[error]`**，job 结论不受影响；要清掉得升 action 主版本，属后续维护项，不是本次阻塞。
- **测试清单**（`grep -cE "^[[:space:]]*test\("` 静态现测，是条数不是通过数）：`panel-channel.test.mjs` **50**、`buffer-tower-channel.test.mjs` **22**、`interference-panel-diagnostics.test.mjs` **10**、`geometry-export.test.mjs` **14**、`verify-step-tower.test.mjs` **31**。本轮重跑 grep 复核：`interference-panel-diagnostics` **是 10，不是 14**（P2-1 只加了 1 条：9→10；14 是 `geometry-export` 的条数，别串）。**旧的「33 条 / 21 条 / 54/54」全部作废**：33 是更早的 panel-channel 基数，21 是更早的 buffer-tower-channel 基数，54 = 33+21 是两次错记叠出来的。
- **不许写「72 条定向全绿」**：50+22=72 只是**清单相加**。可引用的实跑是 final6 的定向集 **205/205**（这一条命令确实同时含 `panel-channel` 的 50 与 `buffer-tower-channel` 的 22，另外还有 `interference-panel-diagnostics` 10、`geometry-export` 14、`verify-step-tower` 31、`buffer-tower-model` 20、`buffer-tower-assembly` 34、`kb` 19、`kb-freshness` 2、`tool-count-doc` 3 —— 合计 205）。**报结论只报 targeted final6 = 205**，不要拿 72 说事；分文件历史实跑（50/50、22/22、10/10、105/105）只作历史。
- **P2 整改摘要（源码已改；T3 第二轮复审判定 P2-1/P2-2/P2-5 均通过，无 P0/P1）**：
  - **P2-1 回执文案**：`panelChannelNote` 不再把 `verdict` 当结论印，改印 `claim`；`claim='diagnostic-only'` 时不印 verdict，改点名 `diagnosticCode` + `invalidPartIds`，并追加「回执结论只按 claim 读」句（`interference-states.ts` 新增 `panelSupportClaimText`）。干净输入输出逐字符不变（探针核过）。测试 `interference-panel-diagnostics` 9→**10** 条（M1 夹具 + `rail-left.center[0]=NaN`，带 clean 正控）。
  - **P2-2 行表静默丢件**：`featureLocalBox` 从「减材料」与「参数读不出」都返回 `null` 改成三态 `box|none|invalid`；新增导出 `supportRowsFromConveyorPartsDetailed()` 交 `{rows, droppedPartIds}`；件表路径下 `invalidShelfIds = 行内非有限坐标 ∪ dropped` → `invalid-shelf-geometry` + `witness=null` + `feasible=false`，不再出现「witness 偏大 6.5 mm、首件静默换人、无诊断码」。`at` 不再 `Number(v)||0` 编坐标、未知 `axis` 不再默认 `z`。测试 `panel-channel` 47→**50** 条。
  - **P2-5 导出边界**：`machineExportParts` 从「`id==='workpiece-plate' && role==='workpiece'` + 来源标签」改成**三层身份**（共享件号 `WORKPIECE_PART_ID` / `role='workpiece'` / 与占位体 box 位姿同一）+ **装配件窗口**；`verify-step-tower.mjs` 新增脚本级**导出边界门禁 8 条**（走 `resolveMachineGeometry` → `machineExportParts` → `geometryToSidecarAssemblies`：导出 146 实例 == `assemblyPartCount`、不含板、件号与 `buildBufferTowerParts` 146 件逐件一致、STEP 内核输入仍 146 件），build 模式在**起内核之前**先判，`--file` 模式也判。测试 `geometry-export` 12→**14** 条、`verify-step-tower` 27→**31** 条。
  - **残留（P3，不改判；T3 第二轮复审判定 P2-1/P2-2/P2-5 通过、无新增 P0/P1，只留这三条 P3）**：① P2-2 的未知特征类型仍按「无实体」静默跳过（`featureLocalBox` 末尾 `return {kind:'none'}`，将来往联合类型加加材料特征而不改适配器就会重演旧症状）；② P2-2 的 `suppressed` 特征未跟随内核（`compileFeatureOps` 跳过、适配器不跳过 → 被抑制的坏特征判 invalid、被抑制的好特征撑大盒，方向偏保守，件表里目前没有这种件）；③ P2-5 的身份剔除本身不看 `moving`/挂轴（仅「整机信号全缺」的结构兜底会看：窗口外的件必须 `moving !== true` 且不挂任何运动轴），靠装配件窗口 + 门禁计数兜底，合成越界要同时让 `assemblyPartCount` 窗口与「`geometrySource` / `workpiecePlaceholder`」两道放行信号都失效）；另 `machine-geometry.ts:1043`/`:1126` 注疏仍写旧判据（行为已对）。
- **门禁（现行 = final6，10:04–10:10，源码提交 `920ea07`+`b85fab5`）**：targeted **205/205**；focused **370/370**；全量 **3614 tests / 3611 pass / 3 skipped / 0 fail（205,933 ms）**；`verify:channel` **2/8/16 各 27/27**（正向 13 / 负向 14，N1..N14）、exit 0、`TOWER_CHANNEL_RESULT ok`；`verify:step-tower` 8 层 **10/10**（9 内核 + 导出边界 1 条显式 N/A）、16 层 **17/17**（9 内核 + 8 导出边界）；`verify:step` **7/7**（85 件 / 1,930,477 B）；regen **58/58**；`build:ext` **2,941,695 B / gzip 920,422 B / total 10,545,726 B**；kb **13 docs / 454 chunks / 434,531 B**；`tsc --noEmit` exit 0。**远端 CI：run `44444540414`（head `dec1373`）7/7 全绿**，CI 侧复核到全量单测 3614/3611/3/0、16 层 `verify:step-tower` 17/17、8 层 10/10；`verify:channel` 不在 CI，27/27 仍是本机证据（见上一条）。final5（09:22–09:28）那套数（362 / 168 / 3604 / 9-9 / 2,940,961 B…）只作历史。
- **四条结论限制（先钉死，别把门禁当验收）**：
  1. **`verify:channel` 是诊断脚本，不是结构/安全校验**：`feasible=false` 是真实结论（所以 exit 0）；`structure.accepted:false`、板挠度/导向/防坠/安全回路/PLC 全部**未校核**；`verified` 只说明「行表来自几何 + 碰撞集里有这块板」，**不等于 supported，也不等于通道可行**。
  2. **`sweep` 仍 fail，不得改判**：16 层 42 对 / **270 确认 + 135 待复核 = 405** 命中；塔没有升降通道（层托板整块、台面在托板投影内）。生产塔也**没有真正的多层通道**：无叉指、无分段带、板不挂轴 → rest `unsupported`（单条 1200 整带）、carried `diagnostic-only`、`feasible=false`（`load-passes-shelf` + `stroke-shortfall`）。M1 的绿只是「首层 20 mm 取放」，不是多层可行。
  3. **STEP 门禁是包络/数量级证据**：只看顶点并集、实体数与件数挂钩（16 层 floor 88 实测 104；8 层 floor 54 实测 55，**丢 1 个内部实体仍绿**）、逐件 bbox 一致、合并路径必须 `fuse`；**不是逐件身份核对、不是制造验收**。
  4. **导出边界已在 final6 实跑，但仍不是端到端内核证据**：16 层 `verify:step-tower` **17/17** = 9 项内核检查 + **8 条脚本级导出边界检查**（走 `resolveMachineGeometry` → `machineExportParts` → `geometryToSidecarAssemblies`：导出 146 实例 == `assemblyPartCount`、不含板、件号与 `buildBufferTowerParts` 146 件逐件一致、内核输入仍 146 件）；8 层 **10/10** = 9 内核 + 导出边界 1 条显式 N/A（「16 层塔专用」）。**必须区分**：这 8 条断言的是 sidecar/导出文档，**不经过内核输出、也不核对内核生成的 STEP**；内核那 9 项仍只吃 `buildBufferTowerParts()` 的 146 件表，结构上看不见板。所以「STEP 只出 146 件」= sidecar/STL/glTF 单测 + **已实跑的脚本级边界断言**，**仍不是板专属的端到端内核证明**。`--skip-if-no-kernel` 分支不打印这 8 条（该分支下「绿」不带证据）。
- **现行口径（唯一，别再用旧的「BOM/STEP/成本/容量一件不动」）**：
  - 碰撞几何（`geometry.parts` / `geometry.json` / `run_interference_check` / 通道诊断）：16 层 **147** 刚体（146 装配件 + 板），2/8 层 **49 / 91**；
  - 制造导出（STL / glTF / sidecar → STEP）：16 层 **146** 实例（2/8 层 48/90），板由 `machineExportParts()` 剔除；16 层 STL **5868** 三角形、sidecar 3 块；
  - BOM **96 行 / qty 146**、slots 16（可用 15）、包络 2430×1790×3840 —— 均未变；
  - kb：`docs=13 / chunks=454 / bytes=434,531`（limit 524,288，`truncated=0`），与 README 两处 `SMOKE_AGENT_KB_OK` 一致。
- **同一块板的判据（跨模块统一，2026-11-19 收口）**：`inCollisionSet` / `panelSourceOfGeometry` 认的是**完整工件身份** —— 同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg` 与占位体一致（转角按**周期等价**比较：`360°≡0°`、`−90°≡270°`）。同 id 的托板/夹具件、同尺寸同中心但转 90° 的件**都不算同一块板**；`rotationZDeg` 缺失/非有限数一律不算（不拿 0 顶替）。门禁里这四字段 + 同 id 托板**各有一条伪造负例**（N12，见下）。
- **坏坐标 / 无效承托的 fail-closed 处理（N13 + N14 判据，T4 轮补全；P2-2 又补了「特征参数」一侧）**：
  - **行表侧（N13）**：承托行里 `maxZ` 等为 NaN/Infinity → 该行被剔除（不进 `contacts`，**覆盖率不得被顶高**），`claim=diagnostic-only` + `diagnosticCode='invalid-support-rows'`；数字等价于删掉该行。
  - **件表/几何侧（N14，新）**：生产几何 `tray-*` 承托件 `center.x` 或 `center.z` 非有限值 → **无法判定它是否挡路**（不判可行）；blocker 仍是 `load-passes-shelf`，带 `diagnosticCode='invalid-shelf-geometry'` + `invalidShelfPartIds`（实测 `['tray-2']`），**`witness=null`**（不拿其余可读承托面顶替）、`feasible=false`；板身份与 `rowsSource='geometry'`/`mode='verified'` 原样保留。
  - **正控（同一条 N14 里）**：同一份**未污染**生产几何必须 `witness` 有值、`diagnosticCode === undefined` —— 防「本来就红」的假绿/假红。
- **N14 轮改了什么 / 跑了什么（历史 · T4 轮，源码改动 09:06–09:07，之后被 P2 整改覆盖）**：
  - `verify-channel.mjs`：新增 **N14**（克隆 `resolved.geometry` 生产几何，只把第一件 `/^tray-\d+$/` 承托件的 `center[0]`、`center[2]` 各污染一次 NaN，走真实入口 `checkPanelChannel({config, geometry})`）；计数仍由 `/^N\d/` 现算（`total=27 / positive=13 / negative=14`，不写死）；稳定 JSON 新增 `shelfFailClosed`（由 N14 实跑填入，失败回退 `{ok:false}`，不编造绿）；人读输出点名 N14。
  - `buffer-tower-channel.test.mjs`（仍是 **22 条**，未新增/删/放宽）：原「verify:channel 收录 N12/N13」那条扩成 **N12/N13/N14 三层** —— ① 行为（克隆 16 层生产几何 → `tray-*` 件 `center[0]=NaN` → `feasible=false`、`invalid-shelf-geometry`、`witness=null`、detail 命中歧义句）② 静态锚点（N14 名字、`diagnosticCode`/`witness === null` 断言本体、NaN 注入行）③ 动态变异（去掉 NaN 注入 → 脚本必须 exit 1 且失败项只有 `N14`）；计数口径断言 `{total:27, positive:13, negative:14}`、负向编号连续 **N1..N14**、`shelfFailClosed` 四字段。
  - 实跑（N14 后，2026-11-19 09:13–09:15）：`node scripts/verify-channel.mjs --levels 2/8/16`（三次 **27/27**、exit 0、`TOWER_CHANNEL_RESULT ok`）、`node --test test/machine/buffer-tower-channel.test.mjs`（**22/22**）、`npx tsc --noEmit`（EXIT=0，空输出）、`git diff --check`（空）、`node --test test/agent/kb-freshness.test.mjs test/agent/kb.test.mjs`（21/21）。**未跑**全量 `npm test`、`build:ext`、内核 STEP、regen、CI。

## 门禁验证（2026-11-19 10:04–10:10 · 当时源码树 = 今日 `920ea07`+`b85fab5`；当时工作区是 `114e024` + 21 M + 1 ??，**提交前快照**，**final6 = 整改后同一棵树全套实跑**）

三种口径，别混：「N14 轮」= 09:06 之后的 N14 补丁实际复跑（`cad-board-final4-*.log`，09:13–09:15）；「final5 轮」= 09:22–09:28 日志（`cad-board-*-final5.log`），**跑在 P2-1/P2-2/P2-5 整改（09:42–09:48）之前，只作历史**；「**final6 轮（现行）**」= 10:04–10:10 同一工作区日志（`cad-board-*-final6.log`），**晚于 09:48 最后一次源码/测试改动，是本文件所有现行数字的唯一来源**。

**另有远端复核（2026-11-19）**：run `44444540414`（head `dec1373`，10:28–10:33 CST）在 CI 上跑了 `npm test`（**3614/3611/3/0**）与 16/8 层 `verify:step-tower`（**17/17**、**10/10**），与上表 final6 本机数字一致；它验的是 `dec1373` 这棵树，本轮 docs-only 提交 push 前没有 run。

| 目标 | 命令 | 结果 | 日志 / 时效 |
|---|---|---|---|
| 通道自证 | `node scripts/verify-channel.mjs --levels 2 / 8 / 16` | 三次均 **27/27**（正向 13 / 负向 14，N1..N14）、`ok:true`、exit 0、`TOWER_CHANNEL_RESULT ok`；`production={mode:verified, rowsSource:geometry, restClaim:unsupported, carriedClaim:diagnostic-only, feasible:false, blockers:[load-passes-shelf,stroke-shortfall], m1Feasible:false}`；`shelfFailClosed={partId:tray-2, axis:x/z, diagnosticCode:invalid-shelf-geometry, witness:null, feasible:false}` | **final6 10:05:05 / 10:05:07 / 10:05:11**（`cad-board-verify-{2,8,16}-final6.log`），**同一棵树、P2 整改之后** |
| 通道接线测试 | `node --test test/machine/buffer-tower-channel.test.mjs` | **22/22**（含 N13 行为断言与 N12/N13/N14 三个变异体，各自 exit 1 且失败项编号正确；N14 带未污染几何正控） | 已含在 final6 定向集 **205/205** 内（10:04:29）；分文件 22/22 是 N14 轮 09:13 的历史记录 |
| 定向（通道 + 面板诊断 + 边界 + 塔 + kb） | 日志未记命令行（`cad-board-target-final6.log`） | **205/205 pass / 0 fail / 0 skipped，10,055 ms** | **final6 10:04:29**；构成：`panel-channel` 50 + `buffer-tower-channel` 22 + `interference-panel-diagnostics` 10 + `geometry-export` 14 + `verify-step-tower` 31 + `buffer-tower-model` 20 + `buffer-tower-assembly` 34 + `kb` 19 + `kb-freshness` 2 + `tool-count-doc` 3 = 205 |
| focused | `npm run test:focused` | **370 / 370 pass**，0 fail / 0 skipped，11.25 s | **final6 10:04:40**（`cad-board-focused-final6.log`） |
| 全量 | `npm test`（`node --test`） | **3614 tests / 3611 pass / 3 skipped / 0 fail**，**205,933 ms** | **final6 10:10:17**（`cad-board-full-final6.log`）；3 个 skip 是环境门（真 FreeCAD Python ×2、build123d ×1），`npm test` 里没有真内核算例 |
| 真内核 STEP：8 层 | `npm run verify:step-tower -- --levels 8` | 90 件 / STEP 1,622,322 B / 55 solids / 538 faces / `fuse` / **10/10**（9 内核 + 1 条导出边界显式 N/A） | **final6 10:05:23**（`cad-board-step-8-final6.log`）；导出边界那 1 条印 `levels=8 是输送基线…由 16 层档判定`，不改判 |
| 真内核 STEP：16 层 | `npm run verify:step-tower -- --levels 16` | 146 件 / STEP 2,301,982 B / 104 solids / 812 faces / `fuse` / **17/17**（9 内核 + 8 导出边界） | **final6 10:05:36**（`cad-board-step-16-final6.log`）；9 内核只证明「146 件焊成 104 solids」，导出边界 8 条是 sidecar 级断言，**不核对内核 STEP** |
| 旧整机 STEP | `npm run verify:step` | 85 件 / 1,930,477 B / 89 solids / 613 faces / `mode=build` / **7/7 PASS**、EXIT=0 | **final6 10:05:52**（`cad-board-step-final6.log`）；此前 final5 未跑 |
| regen | `npm run regen:pv-buffer` | `PV_REGEN_RESULT ok=true checks=58 failed=0`，仍 8 层 90 件，scene 90/90 | **final6 10:06:13**（`cad-board-regen-final6.log`） |
| 构建 + 体积门禁 | `npm run build:ext` | extension **2,941,695 B** / gzip **920,422 B** / wasm 7,604,031 B / total **10,545,726 B** | **final6 10:06:51**（`cad-board-build-final6.log`） |
| 类型检查 | `npx tsc --noEmit` | exit 0，0 诊断 | **final6 10:04:40**（`cad-board-tsc-final6.log`，空文件 = 无输出）；仍不覆盖 `.mjs`（`verify-step-tower.mjs` / `verify-channel.mjs`） |
| 知识库 | `npm run kb:build` | `KB_BUILD_OK docs=13 chunks=454 bytes=434531 truncated=0` | **final6 10:05:04**（`cad-board-kb-final6.log`）；这次重建确实重写了 `kb.json`；两份交接文档不在 `KB_DOC_FILES` 里 |
| CI（远端） | `gh run view 44444540414` | **success，7/7 job 全绿**：`FeatureTree real geometry (build123d)`、`tsc + unit tests`、`Electron smoke (xvfb)`、`Qt client build`、`Qt 客户端（Windows 编译）`、`Qt + OCCT（Windows 编译）`、`Qt + OCCT 视口`；head `dec1373a6aa` | **run 44444540414**，2026-11-19 10:28–10:33 CST，https://github.com/owlco001/automation-cad-prototype/actions/runs/44444540414 ；`verify:channel` **仍不在 `ci.yml`**；告警 = 多个 job 的 Node20 action 被强制跑在 Node24 + 一处 `powershell is not supported`（均非致命，无 `##[error]`） |

**仍未跑 / 不能当通过（final6 之后、CI 之后）**：
- **CI 已跑（run `44444540414`，`dec1373`，7/7 绿），但只覆盖到 `dec1373`**：本轮修改这两份文档后新提交的 commit，push 之前没有自己的 run，push 后要另查一次（见「下一会话建议顺序」第 2 条）。**本机** Electron 冒烟仍未跑（CI 的 `Electron smoke (xvfb)` job 绿，那是 CI 的 xvfb 降级渲染路径，不等于本机 GUI 冒烟）；结构/安全/电气/PLC 仍未校核。
- **导出边界已实跑（16 层 8 条全绿），但仍只是脚本级 sidecar 断言**：不经内核输出、不核对内核 STEP；内核 9 项结构上看不见板 → 「板被剔除」仍没有板专属的端到端内核证明。
- **无结构/通道结论**：`verify:channel` 是诊断脚本（`feasible=false` 而 exit 0），**不是结构/安全校验**；`sweep` 405 仍 fail（16 层 270 确认 + 135 待复核），final6 日志里每一步都还写着「真实塔 sweep 仍 fail」。

> **上一版头部（2026-11-19 口径收口轮，历史快照，勿再引用）**：那一版写的是「HEAD `114e024`、19 M + 1 ??、本轮只改源码注释/文档并重建 kb，判据代码未动」，实测只跑了 `kb:build`、kb 相关 24 pass、`buffer-tower-model`/`geometry-export` 32 pass、相邻文档测试 61 pass，**没跑 `verify:channel`**。它的口径段落（147/146、板身份五条判据）已并入上面正文；门禁数字以文首表为准。
>
> **再上一版头部（2026-11-19 早前轮，历史快照，勿再引用）**：那一版写的是 `HEAD 5885e51`、`10 M + 5 ??`、Agent 专项 26/26、focused 341/341、全量 3580 项。HEAD 在其后又落了两轮提交（`1df0d05`、`114e024`），当时工作区也变成 19 M + 1 ??（这些改动其后已落成 `920ea07`/`b85fab5`/`8037e11`），那些数字与 HEAD 都不是现状。原文保留如下，不改写：
>
> 更新时间：2026-11-19（本轮：T2 把生产塔真实板升为普通碰撞件 + `load-passes-shelf` 实测自由上升 witness；不改 sweep/support 阈值、不实现升降叉）
>
> 当前 HEAD：`5885e51`（与 `origin/main` 同点）；当前工作区有本轮未提交的 Agent 工具接线、测试与文档改动（以 `git status --short` 为准）。此前 M1 几何/诊断实现已在 `5885e51` 提交且 CI 7/7 全绿。
>
> > **当前轮实测**：Agent 专项 26/26、focused 341/341、全量 3580 项（3577 pass / 3 skip / 0 fail）、`npx tsc --noEmit` 通过。因本轮更新 `NL-AGENT.md` 与 README 索引统计，`kb:build` 已重建；提交前需再次跑与最终文档一致的 `kb:build`、focused、tsc、diff-check。当前改动尚未提交、未 push、当前 CI 尚未运行。（**历史 · 2026-11-18 那轮的状态**：此后已 push 并跑过 CI，现行结论是四笔全在远端、run `44444540414` 对 `dec1373` 7/7 绿。）

## M1「首层承托取放」纯数据概念验证（历史 · 2026-11-18 那一轮，几何实现已提交于 `5885e51`）

> 以下是 2026-11-18 那一轮 M1 的实测记录，保留作历史；它写了当时的「本轮只增加 Agent 工具契约和文档」，那是**那一轮**的范围。现行口径（147 碰撞 / 146 制造导出）见文首「当前状态」。

**先钉死三条口径（否则后面的数字会被误读）**

- **生产建造器没变，几何层的板变了**：16 层仍是 **146 装配件 / BOM 96 行 qty 146 / slots 16（可用 15）**；板是 `geometry.parts` 里的真实 `GeomPart`（`workpiece-plate`，role=workpiece、moving=false），所以 **`partCount=147`**（= 装配件数 + 1）；`workpiecePlaceholder` 由同一件投影，`inCollisionSet` 按**完整工件身份**派生（2026-11-19 判据：同 id + `role=workpiece` + box `size`/`center`/`rotationZDeg` 与占位体一致，转角按周期等价：`360°≡0°`、`−90°≡270°`；同 id 的托板/夹具件、同尺寸同中心但转 90° 的件都不算同一块板）。升降轴只随动 `lift-platform` —— **板不随塔轴移动**。
- **M1 的 152 件是 fixture-only**：只在 `test-support/m1-channel-fixture.mjs` 里（146 −1 台面 +2 叉指 +1 横梁 +4 分段带），生产建造器 `/build_machine_model` 都不会产出它。
- **`verified` 只说明「行表来自几何 + 碰撞集里有同一工件身份的这块板（含朝向）」，不是结构可行**：生产塔现在两条都成立 → `mode='verified'`；但实测 `rest` 承托 `unsupported`（覆盖 100% 只有 1 条 1200 整带）、`carried` 是 `diagnostic-only`（板不随塔轴移动、`carriedShiftSource='missing'`）、多层 `feasible=false`，blockers = `load-passes-shelf`（带实测自由上升 witness）+ `stroke-shortfall`。板只在占位体里（哪怕自报 `inCollisionSet:true`）、parts 里只有同 id 但身份不符的件（role/size/center/rotation 任一不符）、或行表来自调用方（`rowsSource='caller'`）时仍 `diagnostic-only`；夹具的 M1 绿不许写成生产塔可行。

**本轮做了什么**

- `desktop/src/machine/panel-channel.ts`（纯函数）修 P1：
  - 板位姿**必须显式**：`resolvePanelSupport` 要求 `panel.centerXMm/centerYMm`（不再默认 0）+ `bottomZmm`；`resolveChannelFeasibility` 要求 `pose{ bottomZmm, centerXMm, centerYMm }`（与 `panel.center*` 冲突则拒绝），**不再读 `inbound.beltHeightMm` 当板底**；
  - carried 与轴绑定：carried 底面 = `pose.bottomZmm + max(0, 轴位移 − 拾取空行程)`（与 `interference-states.workpiece.bottomZ.lift` 同公式），位移/空行程来自 `carriedShiftMm`/`pickupGapMm` 或几何轴，**都没有 → 按 0 处理 + `m1.diagnosticError`，不可能报 supported**；
  - **显式位移 fail-closed（复核 P1-R1）**：`carriedShiftMm` 负值 → `INVALID_ARGUMENT`；`shift > axis.strokeMm`（或板抬 > 行程）→ `INVALID_ARGUMENT`（旧实现照收 shift=100 / 轴声明 20 并回 `carried.supported`）；几何里没有 `axis.strokeMm` 时只作诊断；空行程只能靠 M1 缺省值（`m1-default`）时同样只作诊断 —— 0 / 超行程 / 无轴证据一律不许 `supported`；
  - blockers 只留可复算事实（`load-passes-shelf` / `no-support` / `stroke-shortfall`）；净跨/走廊降级为 `designNotes`（`clear-span-conservative` / `corridor-conservative`），文案改成「当前结构参数下的保守设计余量，需结构确认」，并给出 `columnSweep`（实测柱与板 y 向重叠 0、行程内相交 0 件）；
  - 每条 `load-passes-shelf` 的 detail 从件表派生（不写「26 处」这类快照）；`stroke-shortfall` 标明 **M1 叉指停位口径**（现轴台面 `lift-platform` AABB **z 970..1010**，顶面 1010 / 底面 970；970 这个停位口径下不缺）；
  - `panelSourceOfGeometry` 回传 `centerXMm/centerYMm` 且占位体缺 `center` 就**不认板**；`center/size/bottomZmm` 改用严格数字判据（`typeof === 'number' && Number.isFinite`，不再 `Number()` 强转：`Number(null)===0`、`Number('')===0` 会把 `center=[null,null,917.5]` 读成 (0,0) 并谎称来自几何 —— 复核 P2-6）；新增 `liftAxisOfGeometry`；`checkPanelChannel` 现接受 `rows/pose/carriedShiftMm` 覆盖，并把非本模块的 RangeError 从 `NOT_A_TOWER` 改成 `INVALID_ARGUMENT`；
  - **`verified` 只认几何行表（复核 P1-R2）**：`rowsSource='caller'` 一律 `diagnostic-only`（夹具行表 + 生产几何 + pose 曾报 `verified`/双向 `supported`/`m1.feasible=true`，而该塔 146 件、叉指 0 件）；`resolveChannelFeasibility` 收到 `supportSource:'caller-rows'` 也强制 `diagnosticOnly`。
- `machine-geometry.ts`（T2 改）：`towerWorkpiecePart()` 产真实板 2278×1134×35、底面 900，push 进 `geometry.parts`；`towerWorkpiecePlaceholder(part, inCollisionSet)` 是**同一件的投影**（center/size/role/材质逐字段一致），`inCollisionSet` 由 parts 里**同一工件身份**的成员派生（同 id + role=workpiece + box size/center/rotationZDeg，转角周期等价）。~~BOM/STEP/成本/容量一件不动~~ —— **这句是错的（2026-11-19 更正）**：板确实不进 `ConveyorPart` 表，BOM（96 行 / qty 146）、成本、容量一件不动；但 STEP 由 sidecar（`geometryToSidecarAssemblies`）逐实例实体化，旧代码直接把 `geometry.parts` 全导出去，所以 STEP/STL/glTF 当时会多出一块板（147）。现口径：制造导出走 `machineExportParts()` 剔除板 → **146 instances**（16 层），碰撞几何仍是 147。
- `interference-states.ts` 只读 `panelSupport / panelFeasibility / panelChannelNote` + `requirePanel:true`，判据未改。
- **工具层已接（`src/agent/commands.ts` + `tools.ts`）**：`run_interference_check` 新增布尔 `requirePanel`，经 `run_interference` 的 states 分支透传到 `runInterferenceStates`；`requirePanel:true` 是强制校验诊断适用条件的 fail-closed 参数；缓存塔在缺省路径也会回只读诊断字段 `panelSupport`/`panelFeasibility`/`panelChannelNote`，此参数不是字段开关。几何里没有板或机型不是缓存塔回 `INVALID_ARGUMENT`（含「`requirePanel` 没给 states」也显式拒，不静默忽略）；缺省/false 与旧回执逐字节一致。口径仍由 `panel-channel.ts` 定：生产塔 `mode=verified` 只等于「几何行表 + 板在碰撞集」，承托仍是 rest `unsupported` / carried `diagnostic-only`、`feasible=false`；结果 >10 KB 时照旧走 `serializeToolResult`（preview + `resultId`，全文外置）。测试 `test/agent/interference-panel-diagnostics.test.mjs`（9 条，覆盖命令层与工具层的缺省、类型、空状态和截断契约）。
- `scripts/verify-channel.mjs` 重写为**层数无关**（件数从 `parts` 派生、只校验关系，不写 146 / 16 层 / ≥400 处），新增 4 条反例：中心偏移、位移 5、生产 placeholder、缺位姿/缺位移；**`--levels` 2..64 均 exit 0**：17 层起基线建造器的 `gearmotor|column-bl` 相交 1 对（柱截面随塔高派生 → 柱位外移）单列为 `baselineNotes`，不计入通道自证，**其余 rest/lift 命中仍判失败**，≤16 层要求全 0；断言名也改掉「真实件表首层也托不住」这种把阈值当几何事实的写法。
- 测试：`panel-channel.test.mjs` **33 条** + `buffer-tower-channel.test.mjs` **21 条**，都在 `test:focused` 里（定向复跑 **54/54 pass**；另有 `interference-states` 未挂轴、witness 删/移反例）。（2026-11-19 更正：这是 2026-11-18 那一轮的条数，只作历史；现测 `panel-channel` **50** 条、`buffer-tower-channel` **22** 条；54 = 33+21 作废，72 = 50+22 只是清单相加、**没有一条命令跑出过 72**，见文首「测试清单」。）

**实测（node v26.7.0，修复后）**

| 对象 | 实测 |
|---|---|
| 真实塔（`parts.length`=146 @16 层） | rest/lift = 0/0 pass；sweep = 270 确认 + 135 待复核 fail（与基线一致）。**≥17 层**：rest/lift 各多 1 对 `gearmotor\|column-bl`（柱截面随塔高派生 → 柱位外移，建造器问题，非通道判据，脚本单列 `baselineNotes`） |
| 真实塔承托（`mode=verified`） | rest 覆盖 100% 但只有 **1** 条接触带 → `verdict=unsupported`、`claim=unsupported`；carried 底面 = 静止底面、`claim=diagnostic-only`（板不随塔轴移动，位移来源 missing）；`workpiece.bottomZ.lift = null`（不是 3600） |
| 真实塔通道 | `feasible=false`：blockers = load-passes-shelf（witness 距板顶 98.5 / 距板底 133.5 mm、首件 tray-roller-2-in/out，由件表算）/ stroke-shortfall（缺 16.5，M1 叉指口径）；designNotes = clear-span-conservative / corridor-conservative（净跨 2000 vs 2278、走廊 135 vs 567，**非阻塞**） |
| M1 概念件表（152 机台件 + 板 = 153 刚体 / 装配 152 / 包络 2430×1790×3840） | rest/lift/sweep = **0/0/0 pass**（20 mm 段）；`mode=verified`；承托 rest **80.6%**（3 带）、carried **15.48%**（2 带）都 supported；位移 20（axis）→ 板抬 10；多层仍 false |
| 自证 23 条（**正向 12 / 负向 11**） | 正向：行程不变量、净跨关系、走廊关系、柱与板 AABB 不相交、多层不可行、单条 1200 整带 → claim 降级、件数语义、rest/lift 通道相关 0、M1 三态、M1 承托 supported、M1 多层仍 false。负向 N1–N11：板外叉 0%；缺板 → INVALID_ARGUMENT；120 宽叉 → 红且指到 lift-finger；超行程 40 → 红且含 belt-top×lift-carriage；满行程 → 红且含板/托板；非塔 → NOT_A_TOWER；**中心偏移 300 → 80.6%→72.22%**；**位移 5 → 报告 5、carried 底面不变、m1.feasible=false**；**合成旧几何（板移出 parts + 占位体伪 inCollisionSet:true）→ diagnostic-only**；缺位姿 → 拒绝；缺位移 → 不伪造绿 |
| 门禁（历史：2026-11-18 那轮 23/23） | `npm run verify:channel` → `TOWER_CHANNEL_RESULT ok`，**当轮自证 23/23（正向 12 / 负向 11）**，exit 0；`--levels 2 / 16` 同为 23/23；定向 `panel-channel` + `buffer-tower-channel` = **54/54 pass**；`npx tsc --noEmit` = 0；`git diff --check` = 0。**这一行是 2026-11-18 当轮历史，23/23 早已作废**；现行自证是 **27/27、13 正 / 14 负、N1..N14**（见文首表），`buffer-tower-channel` 现为 22/22。定向那一栏的「54/54」也是历史：**现测条数是 panel-channel 50 / buffer-tower-channel 22**（33/21 两个数本身就不对），54 与 72 都只是清单相加，**从没有一条命令跑出 72**（见文首「测试清单」） |

**CI 边界**：`verify:channel` **不在 CI**（`.github/workflows/ci.yml` 的 `npm test` 之外没有这条脚本；`verify:step-tower` 另有独立 job 步骤）；负向用例在测试文件里，所以 `npm test` 仍有覆盖，但「27/27 自证」只有本机跑过。**历史注释**：这段早前写的是「26/26 自证（2026-11-18 那轮是 23/23）」——26/26 与 23/23 都是历史小票，现行口径 27/27。

**口径更正**：架构文档写的 82.5% / 17.0% 与它自己的件表尺寸不符（`2278×914/2278×1134 = 80.61%`、`2×2000×100/2583252 = 15.48%`）。按实测记账，未改阈值；carried 只剩 0.48 个百分点余量。

**没跑**：STEP/内核（152 件未进 build123d）、`regen:pv-buffer`、全量 `npm test`、CI、Electron 冒烟。

**遗留**：M1 只证明「首层托住并抬起 10 mm」，**不是多层可行**；生产塔的板已在碰撞集里（`verified`），但**没有通道承托路径**（无叉指/无分段带/板不挂轴）：rest `unsupported`、carried `diagnostic-only`、`feasible=false`；板挠度、导向/同步、防坠/抱闸、安全回路、PLC/IO 未建未验；真实塔 sweep 仍 fail；行程缺口 16.5 mm（M1 叉指口径）未修；净跨/走廊的保守设计阻塞需结构确认。

## 开始前必做

```bash
cd /tmp/automation-cad-prototype
git status --short      # 应为空（2026-11-19 收口后工作区干净；`scratch/` 已删）
git log -5 --oneline    # 顶端是 dec1373（docs-only）；其下 8037e11 / b85fab5 / 920ea07，全部已在 origin/main
git log --oneline origin/main..HEAD   # 应为空（已同步）；只有本轮 docs 提交前会列出 1 笔
git rev-parse HEAD origin/main        # 两个 SHA 应相同：dec1373a6aa1fc3380636c9e8e4c5ab72be56212
```

`git status --short` **应为空**。若非空，先看清单再动手：可能是你自己刚跑出的临时产物；不要覆盖、不要回滚、不要 `git checkout --`。`scratch/` 这类临时回执目录可以随手删，**永远不要提交**。

> 历史：本文件早前版本这里写的是「10 M + 5 ??」「顶端 7b089a1」（2026-11-18 塔 B-Rep 轮），以及「`114e024` + 21 M + 1 ??（顶端 114e024）」（2026-11-19 提交前）。前者已被 `1df0d05`/`114e024` 超过；后者这 21 个 M 现已落成 `920ea07`/`b85fab5`/`8037e11` 三笔，`?? scratch/` 已删。都不要当现状引用。（2026-11-19 10:35 补：此后又落了 `dec1373`，四笔已全部 push，`origin/main` = `dec1373`；「未 push / CI 未运行」对现状不成立。）

## 当前远端状态

**2026-11-19 10:35 现状：本地 `main` = `origin/main` = `dec1373`**（`dec1373a6aa1fc3380636c9e8e4c5ab72be56212`，ahead/behind 0/0，**已推送**）：`920ea07`（板进碰撞几何 + 制造导出边界）→ `b85fab5`（承托/行表 fail-closed）→ `8037e11`（文档 + kb）→ `dec1373`（docs-only，只改两份交接文档）。**远端 CI run `44444540414`（head `dec1373a6aa`）7/7 全绿，2026-11-19 10:28–10:33**：https://github.com/owlco001/automation-cad-prototype/actions/runs/44444540414 。`114e024` 及更早的 CI 结论仍按「未知」记（未逐个查），不要写成绿。

**提交前快照（历史）**：收口时是 `114e024` + 21 M + 1 ??，那时这 21 个 M 不在任何 CI run 里。**现状**：它们已随 `920ea07`/`b85fab5`/`8037e11`/`dec1373` 推到远端，并已由 run `44444540414` 覆盖。下面这串是更早的推送历史（写到 `411f21d` 为止），保留原样；它之后又推了 `1df0d05`（`run_interference_check` 接 panel channel 诊断）、`114e024`、`920ea07`、`b85fab5`、`8037e11`、`dec1373`。

最后已推送提交（远端 `main` 就是这里）：

- **最近四笔（现行）**：`dec1373`（docs-only，CI `44444540414` 7/7 绿）← `8037e11`（文档 + kb）← `b85fab5`（承托/行表 fail-closed）← `920ea07`（板进碰撞几何 + 制造导出边界）

以下四行是更早的推送历史：

- `411f21d`：锁存故障期来料拒绝（`ITEM_REJECTED_FAULT`）+ 静态守卫扫三种同步子进程 API
- `65229c5`：缓存塔塔身几何 builder（fail-loud 配置、真派生储位、塔升降轴）
- `e6c1ef3`：per-station PLC 转换（并行工位联动时间线通过审计）
- `b3b13f3`：CI 沙箱守卫

**现行（2026-11-19 10:35）**：远端 `main` = `dec1373`，CI run `44444540414`（head `dec1373a6aa`）**7/7 全绿**（10:28–10:33），`featuretree-geometry` 里的 16 层 + 8 层 STEP 完整性步骤**已确认在 CI 上真实执行并通过**（16 层 17/17、8 层 10/10）；告警是多个 job 的 Node20 action 被强制跑在 Node24（`##[warning]Node.js 20 is deprecated`）加一处 `powershell is not supported`，均非致命、无 `##[error]`。**历史**：2026-11-18 那次有记录的全绿是 run `44276548527`（验 `411f21d`）；`1df0d05`/`114e024` 两笔的 CI 未单独查过，按「未知」记。

## 门禁：塔 B-Rep/STEP 轮本地实测（历史 · 2026-11-18，工作区已变，不是现状）

> 这张表是 2026-11-18 塔 B-Rep 轮在「当时那个工作区」跑出来的，留作历史。此后工作区叠加了 T2（板进 `geometry.parts`）、制造导出边界修复与 T3 门禁收口，`focused 281`、`全量 3518`、`extension 2,938,104 B` 等**都不能当 2026-11-19 工作区的实测**；现状数字只看文首「门禁验证（2026-11-19 10:04–10:10）」。表里 `9/9 PASS` 是 **P2-5 之前的脚本**（现行 final6：8 层 10/10、16 层 17/17）；16 层 `146 件 / 104 solids` 仍成立 —— 它本来就是制造导出（装配件）口径，与碰撞几何 147 不是同一套数。

**全部已跑，node v26.7.0，原始日志在 `/root/.hermes/cache/scratch/cad-brep-lastmile-{focused,tsc,build,npm-test-close}.log`, `cad-brep-final-current-kernel.log` 与 `cad-brep-final-09-project-session-smoke.log`**：

| 目标 | 命令 | 结果（本轮未提交工作区） |
|---|---|---|
| 定向：入口链 | `node --test test/agent/build-machine-model.test.mjs` | **14 / 14 pass**（含 `process` 非字符串/空白的命令层+工具层拒绝） |
| 定向：塔模型 | `node --test test/machine/buffer-tower-model.test.mjs` | **19 / 19 pass** |
| 定向：STEP 门禁 | `node --test test/parametric/verify-step-tower.test.mjs` | **27 / 27 pass**（含 6 条 CLI 级用例：`--levels`/缺失文件/桩 STEP/`--merge-manifest` 正反/三种 manifest 形状/证据不合格） |
| 定向：工程保存 | `node --test test/electron/projects*.test.mjs` | **29 / 29 pass** |
| focused | `npm run test:focused` | tests **281** / pass **281** / fail 0 / skipped 0，6.16 s |
| 类型检查 | `npx tsc --noEmit` | exit 0，**0 诊断** |
| 构建 + 体积门禁 | `npm run build:ext` | exit 0，extension **2,938,104 B**，gzip **918,889 B**，wasm **7,604,031 B** |
| 全量 | `timeout -k 15 900 npm test` | **3518 tests / 3515 pass / 0 fail / 3 skipped**，204.3 s |
| 真内核：16 层塔 | `npm run verify:step-tower -- --levels 16` | **146 件 / STEP 2,301,982 B / 104 solids / 812 faces / mode=fuse / 门禁 9/9 PASS** |
| 真内核：8 层基线 | `npm run verify:step-tower -- --levels 8` | **90 件 / STEP 1,622,322 B / 55 solids / 538 faces / 门禁 9/9 PASS** |
| 旧整机 STEP 门禁 | `npm run verify:step`（85 件机型） | **7 / 7 PASS**（85 件逐件覆盖、并集 6000×1495×930） |
| 重生成 | `npm run regen:pv-buffer` | `PV_REGEN_RESULT ok=true checks=58 failed=0`，仍 **8 层 90 件**，scene 90/90 |
| 会话冒烟 | `project-session-smoke.mjs` | `PROJECT_SESSION_SMOKE_CAD_PASS parts=1` + `PROJECT_SESSION_SMOKE_PASS`，exit 0 |

**仍未跑 / 不能当通过**：

- **CI 本轮未跑**：上述 16 层 + 8 层门禁只在本地真内核跑通，CI 上一次都没执行过本轮工作区。
- 结构强度/挠度/防坠、安全回路、电气、PLC 联调——**均未校核或验收**（见「尚未完成」）。
- 所有机械 `sweep` 干涉仍 **fail**（见下），不得改判。

## 缓存塔：静态几何存在，B-Rep 核验跑通，机构/结构未验

> **件数口径（2026-11-19 补记，本节其余内容仍是 2026-11-18 塔 B-Rep 轮的记录）**：本节写的「146 件」= 装配件 / BOM / 制造导出（STL / glTF / sidecar → STEP）口径，今天仍成立（板已由 `machineExportParts()` 从制造导出剔除）。**碰撞几何不是 146**：`geometry.json` / `geometry.parts` / `run_interference_check` 在 16 层是 **147** 刚体（146 装配件 + `workpiece-plate`，2/8 层 49/91）。两套数不要互相校验。

- **静态零件表（已提交，`65229c5`）**：`config.bufferTower` → 塔身建造器 → **16 层 146 件 / 设计包络 2430×1790×3840 / 柱高 3840 / 柱截面 80（按柱高反算）/ 16 层 × 1 位 / 可用储位 15 / 升降行程 2700**，`slots{fromGeometry:16, claimed:16, aligned:true}`，`source:'buffer-tower-assembly'`。这是**静态件表 + AABB**，不是可制造结构。
- **整机建模入口（本轮接通，未提交）**：`build_machine_model` 现在认塔，三条入参路径都通：
  - `process:'buffer-tower'` + 扁平塔参数（严格校验，越界**拒绝**不夹紧）；
  - `design`（`design_machine` 的产物，`design.config.bufferTower` 是权威来源）；
  - `config`（`design.config` 的简写）。
  命令层白名单已加 `design`/`config` 并原样透传（以前 `未知参数：design` 直接拒，design 权威链对智能体不可达）。塔分支出 **146 件**，并且走 `resolveMachineGeometry` 收尾（地面线守卫 + 随动件标注 + 两条链件数一致性断言）。
- **入口边界本轮收紧（`resolveModelDispatch` 一份判据，命令层/渲染层共用）**：
  - `design`/`config`/`design.config`/`params` 只要给了就必须是**非数组对象**（`design:[1,2]` 以前在脚本 API 侧 `ok:true` → 29 件输送线）；
  - `process` 必须落在 `MODEL_BUILDERS` 里（conveyor / buffer-tower）：`process:'screw'` 现在在命令层就 `INVALID_ARGUMENT`、bridge **0 次**（以前打到渲染层才报 `NO_PARAMETRIC_BUILDER`）；
  - `process` 的**形状也先判**：给了就必须是非空字符串——`process:123` / `{}` / `[]` / `true` / `'   '` / `null` 以前被静默当「没写 process」→ 按 conveyor 建 29 件且 `ok:true`；现在命令层、工具层、脚本 API（同一份 `resolveModelDispatch`）都拒成 `INVALID_ARGUMENT`，bridge **0 次**；
  - `design` 与 `config` 只能二选一（脚本 API 也拒）；
  - **塔 + `params` 双源直接拒**：塔几何只认 `design.config.bufferTower`/`config.bufferTower`，params 里的键会被静默丢掉；
  - **非塔 design/config 直接拒**（`config.conveyor{lengthMm:6000}` 以前 `ok:true` 却建默认 2000×300、无任何提示）——输送线尺寸只从 `params` 读，工具描述已写明。
- **分派判据只有一份**：`isBufferTowerConfig`（判别字段 `config.bufferTower.kind === 'tower'`）+ `resolveModelDispatch`，命令层/渲染层/几何层共用。**显式 `process:'conveyor'` + 塔 design = 冲突，显式拒绝**；只给 design 不给 process = 按塔建。不再存在「同一份 design 出 146 件 / 29 件且 `ok:true`」。
- **B-Rep / STEP（2026-11-18 那一轮真内核实测）**：整机建模出逐件 STL（146 件）+ 合并 `model.step`（生产 `ParametricManager`，一次性 `fuse`）。有效性判据是 `desktop/scripts/verify-step-tower.mjs`（`npm run verify:step-tower`）。
  - 16 层：**146 件 → STEP 2,301,982 B / 104 MANIFOLD_SOLID_BREP / 812 ADVANCED_FACE / merge mode=fuse / 9/9 PASS**。
  - 8 层基线：**90 件 → STEP 1,622,322 B / 55 solids / 538 faces / 9/9 PASS**。
  - **顶点容差必须说清（上一版把语义写反了，这里更正）**：16 层 STEP 顶点包络 **2430×1770×3840**，逐件 STL 包络 Y 上界比 STEP 高 **19.99 mm**。这 19.99 mm 来自 **Ø40 竖直（轴 Z）升降导柱的径向母线**：B-Rep 把圆柱写成「一条圆边 + 接缝顶点」，顶点只落在接缝（y=780）上，真实外形到母线（y=800），差 20 mm 就是半径。判据因此只在**垂直于导柱轴**的方向（x、y）给半径 20 mm，**沿导柱轴（Z）的端面仍严格 ±1 mm**（`minAllowance=[1,1,1]`、`maxAllowance=[1,20,1]`，按端点极值件逐端取）。一句话：**端面/平面端严格 ±1，只有回转体的径向给半径** —— 不是「水平圆柱端点 20 mm 容差」。所以这是「在声明容差内通过」，**不是逐点完全一致**；16 层与 8 层的 Y 上界差都是 19.99 mm。
  - **门禁的判别力边界（说清楚，别夸大）**：证据是（1）顶点并集、（2）实体数与件数挂钩、（3）逐件 bbox 与内核自报一致、（4）合并路径必须是 `fuse`。四条都是**包络/数量级**证据，**不是逐件身份**：内部件丢失只要不动任何轴极值、且丢掉后的实体数仍在**下限**之上，就看不见 —— 16 层 floor=`ceil(146×0.6)`=88、实测 104（可丢 16 个实体）；8 层 floor=54、实测 **55**（**只丢 1 个实体仍然绿**）。要堵这个盲区得做逐实体 bbox / 件名-件族覆盖匹配，本轮没做。**门禁通过 ≠ 逐件身份核对、≠ 制造验收。**
  - **合并路径是硬门禁（不是提示）**：build 模式必须由内核上报 `stats.merge`，**缺失即判红**（与逐件 `solids` 缺失同口径，上一版 `if (mergeMode)` 会让整条检查消失、9 项变 8 项照样全绿）；`mode=compound` 或 `fallback:true` 一律失败。`--file` 模式只读 STEP，**裸 STEP 里 fuse 与 compound 回退都是 `MANIFOLD_SOLID_BREP`，判不了**，所以默认判红并明说「合并路径未验证」；要 PASS 必须显式给 `--merge-manifest <构建期 stats.merge JSON>`（含 `mode` + `fallback` 布尔值），接受的形状就是代码实现并测过的三种：`{merge:{mode,fallback}}`、扁平的 `{mode,fallback}`、以及整份 stats `{stats:{merge:{mode,fallback}}}`（多带的键忽略）。**`--file` 不是验收模式。**
- **质量/BOM 口径分两条**（别混）：整机建模走 `conveyorBom(parts, volumes)`，给的是**按内核体积折算**的质量（不是称重）；`design_machine`/`apply_machine_design` 那边仍是 `massKg:null`、`massSource:'not-measured'`、`bomCoverage` 标注塔身 117 件不入机器 BOM、`costScope:'base-conveyor-only'`。
- 升降轴 `tower-lift`：行程 = (levels−1)×layerPitch = 2700，`strokeSource:'geometry'`。
- **动态干涉（未变，全部机械 sweep 仍 fail）**：`rest` / `lift` = **pass**（38 对、0 命中）；**`sweep` = fail**（pairs 42 / hits 405 / confirmed 270 / screen 135、`items 10`）——台面落在托板投影内、层托板是整块板，**没有升降通道**，真实机构缺口，不得改判。`push` 不适用。
- **结构**：`structure.staticOnly:true`、`structure.accepted:false`；柱截面按柱高反算 80 mm，折算板料后仍超许用约一成以上 → **未校核**。静态几何「存在」不等于「可承载」。

## 8 层 = 8 储位；regen 仍走 8 层（历史 · 2026-11-18 那一轮重跑过，2026-11-19 未重跑）

- `layers: 8`（`config.conveyor`）只对应 **8 个储位**（第 1 层是底层输送线），regen 固定输出 `slotsFromGeometry=8 claimedSlots=16 aligned=false`。
- `npm run regen:pv-buffer` 本轮实跑：**`checks=58 failed=0`，仍 8 层 90 件**（包络 2430×1690×2400，scene 90/90），塔**不在**该路径上。
- `PV_REGEN_NOTE` 的文案在脚本 `desktop/scripts/pv-buffer-regenerate.mjs` 里，是「16 层塔身几何已由 bufferTower 建造器生成（146 件静态件表），但不在本脚本路径上，故本报告无塔 B-Rep/STEP；本脚本不把 8 层冒充 16 位」——**这段文案与 BASELINE 注释是本轮改的**（旧文是「16 位只存在于 bufferTower 纯数据槽位模型」，且 BASELINE 还写着旧的 781,970 B / 47 实体），本轮的 `regen:pv-buffer`（`checks=58 failed=0`）就是改完之后用新脚本跑的，输出里那行 `PV_REGEN_NOTE` 已带新文案。
- regen 产出的 STEP 本轮实测：**1,622,322 B / 55 实体 / 538 advanced faces**（与 8 层基线一致）；旧的 **781,970 B / 47 实体 / 264 faces 是丢件产物（历史）**，不得再引用。

## sceneIntegrity 现状与剩余风险

现状：`desktop/src/cad/scene-integrity.ts` 是**计数等式门禁**——两个计数必须是非负整数，模型件数 == 场景件数（可选再等于期望件数），否则 `complete=false` / `assertSceneIntegrity` 抛错。UI 页脚显示 `场景完整性：90/90 件`。

剩余风险（必须一起说）：

- 只证明**件数一致**，不证明几何正确：错形状、错位置、错层级、错朝向都能 90/90 通过。
- 不证明 180 mm 层距下的 lift/sweep/push 动态干涉、结构强度、挠度、防坠。
- 计数来自 viewer 诊断聚合，历史上有过「实例重复计数」缺陷（已修）；任何新增实例化路径都要重新验证计数口径。
- 塔路径目前**没有**接 sceneIntegrity 的 146/146 断言（regen 只覆盖 8 层 90 件）。
- `complete=true` 不是「可以交付制造」的结论。

## 真实光伏缓存机设计结果（历史，未变）

独立测试 userData：`/tmp/automationcad-pv-buffer-live`（不纳入仓库，不复制密钥，不推送）

- 工程名：`PV缓存单塔8位概念验证-180`；光伏组件 2278×1134×35 mm，单件 32 kg
- 上游 12 s/件（5 件/分钟），下游 15 s/件（4 件/分钟），下游停机 120 s
- 初始库存 2、在途 1、预留 2 → 停机新增 `ceil(120/12)=10`，占用 13，需求 15 → 16 位可覆盖该窗口；正常净积料 1 件/分钟
- 有限缓存不能解决长期产能差：必须背压、上游减速或下游提速
- 旧 `/tmp/automationcad-pv-buffer-iter` 里的历史产物是 250 mm 层的旧结果，不能改参数后声称几何已更新
- 该 8 层产物当时的 STEP 是 **781,970 B / 47 实体（历史丢件产物）**；修复后的当前值是 1,622,322 B / 55 实体

## 文件落库情况（2026-11-19 收口后：21 个 M 全部已提交并推送，工作区干净）

### 四笔提交（`main` = `origin/main` = `dec1373`，**全部已 push**）

- `920ea07` `feat(machine): add workpiece collision and manufacturing export boundary`（8 文件）：`desktop/src/machine/{machine-geometry,geometry,geometry-export}.ts`、`desktop/test/machine/{geometry-export,buffer-tower-assembly,buffer-tower-model}.test.mjs`、`desktop/scripts/verify-step-tower.mjs`、`desktop/test/parametric/verify-step-tower.test.mjs`。
- `b85fab5` `fix(machine): fail closed on invalid support evidence`（7 文件）：`desktop/src/machine/{panel-channel,interference-states}.ts`、`desktop/src/agent/tools.ts`、`desktop/scripts/verify-channel.mjs`、`desktop/test/machine/{panel-channel,buffer-tower-channel}.test.mjs`、`desktop/test/agent/interference-panel-diagnostics.test.mjs`。
- `8037e11` `docs: record PV board export and diagnostic verification`（6 文件）：`HANDOFF-NEXT-SESSION.md`、`docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`、`docs/desktop/NL-AGENT.md`、`desktop/src/agent/MODULE.md`、`README.md`（kb 统计 `chunks=454`）、`desktop/src/agent/kb/kb.json`（该 commit 内重建 `KB_BUILD_OK docs=13 chunks=454 bytes=434531`）。
- `dec1373` `docs: align handoff with committed PV board changes`（2 文件，+54/−63）：`HANDOFF-NEXT-SESSION.md`、`docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md` —— **docs-only，不改源码/测试/kb**；远端 CI run `44444540414` 验的就是这一笔（7/7 绿）。

`git status --short` **无输出**；`scratch/`（临时回执目录，含 `cad-channel-*.md`、`cad-board-*.md` 等各岗报告）**未入库并已删除**。日后若再产生这类目录，照旧不要提交。

### 提交前工作区（**历史快照 · 21 M + 1 ??**，勿当现状）

- 修改（21，按 `git status --short` 顺序）：`HANDOFF-NEXT-SESSION.md`、`README.md`（kb 统计 `chunks=454`）、`desktop/scripts/verify-channel.mjs`（N12/N13/N14 门禁）、`desktop/scripts/verify-step-tower.mjs`（**P2-5：8 条导出边界证据**）、`desktop/src/agent/MODULE.md`、`desktop/src/agent/kb/kb.json`、`desktop/src/agent/tools.ts`、`desktop/src/machine/geometry-export.ts`（**P2-5：三层身份 + 装配件窗口**）、`desktop/src/machine/geometry.ts`、`desktop/src/machine/interference-states.ts`（**P2-1：`panelSupportClaimText`**）、`desktop/src/machine/machine-geometry.ts`、`desktop/src/machine/panel-channel.ts`（**P2-2：三态 + `droppedPartIds`**）、`desktop/test/agent/interference-panel-diagnostics.test.mjs`、`desktop/test/machine/buffer-tower-assembly.test.mjs`、`desktop/test/machine/buffer-tower-channel.test.mjs`、`desktop/test/machine/buffer-tower-model.test.mjs`、`desktop/test/machine/geometry-export.test.mjs`、`desktop/test/machine/panel-channel.test.mjs`、`desktop/test/parametric/verify-step-tower.test.mjs`、`docs/desktop/NL-AGENT.md`、`docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`
- 未跟踪（1）：`scratch/`（临时回执目录，已删，从未入库）

> 上面这份 21 M + 1 ?? 是提交前清单，件数当时以 `git status --short` 为准，现在**全部已入库**（21 M 分进三笔，`??` 删除）。**更早的历史快照（勿再引用）**：`19 M + 1 ??`、`10 M + 5 ??`、`6 M + 5 ??`、`16 M + 3 ??`；那些清单里的 `desktop/src/extension.ts`、`desktop/package.json`、`desktop/test/electron/projects.test.mjs` 等已随 `1df0d05` / `114e024` 提交。`desktop/scripts/verify-step-tower.mjs` 与 `desktop/test/parametric/verify-step-tower.test.mjs` 在 P2-5 时确实回到过未提交清单，现随 `920ea07` 入库。

### 上一轮（塔 B-Rep 入口 + STEP 门禁；源码改动部分已随 `18b08bb` / `7b089a1` 落地，下列清单是当轮记录，保留作历史）

- 新增：`desktop/scripts/verify-step-tower.mjs`（整机 STEP 完整性门禁）、`desktop/test/machine/buffer-tower-model.test.mjs`、`desktop/test/parametric/verify-step-tower.test.mjs`
- 修改（源码）：`desktop/src/machine/model-builders.ts`（塔注册表/严格校验/`resolveModelDispatch` 统一分派，本轮再收紧：形状/机型/双源/非塔 design 拒绝，**外加 `process` 形状：非字符串/空白/null 一律 `INVALID_ARGUMENT`，不再默认 conveyor**）、`buffer-tower-assembly.ts`（导出 `isBufferTowerConfig`）、`machine-geometry.ts`（几何入口改用同一判定；升降轴多件化）、`spec.ts`（`ModelProcess`）、`desktop/src/extension.ts`（塔分派 + 几何收尾 + design 落盘）、`desktop/electron/projects.ts`（config-only 也落盘）、`desktop/src/agent/commands.ts`（`design`/`config` 白名单与冲突拒绝；`params` 也进分派）、`desktop/src/agent/tools.ts`（schema/描述/透传）
- 修改（门禁与内核）：`spike/build123d/app.py`（一次性 fuse + 自校验 + 回退；逐件实体数）、`desktop/package.json`（`verify:step-tower`；`test:focused` 加三个新文件）、`.github/workflows/ci.yml`（featuretree-geometry job 加 16/8 层门禁；job timeout 30→60→**75**，步骤预算 72 min）
- 修改（文档/注释）：`HANDOFF-NEXT-SESSION.md`、`docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`、`docs/desktop/PV-BUFFER-SOFTWARE-IMPROVEMENTS.md`、`desktop/scripts/pv-buffer-regenerate.mjs`（`PV_REGEN_NOTE` + 实测注释）
- 测试改动：`desktop/test/agent/build-machine-model.test.mjs`（design/config 入口 + 冲突拒绝 + **`process` 非字符串/空白在命令层与工具层都拒**）、`desktop/test/machine/buffer-tower-model.test.mjs`（分派层补 `process` 形状拒绝）、`desktop/test/parametric/verify-step-tower.test.mjs`（**`--merge-manifest` 三种形状**：`{merge}` / 扁平 `{mode,fallback}` / 整份 `{stats:{merge}}`）

## 尚未完成的关键工作

### 设计/几何

- **升降通道（`sweep` 转绿的唯一路径）**：层托板整块板 + 台面在托板投影内，必须设计**可承载的升降通道**（托板开口/梳齿/伸缩叉避让），再用 `sweep` 复验 405→0；在此之前 sweep fail 是事实。
- **STEP 内部件漏件盲区**：现在门禁只看整机顶点并集与实体/件数比，**内部件丢失且不动轴极值时仍可能漏**。要做**逐实体 bbox 覆盖匹配**（每个零件在 STEP 里找到对应实体/位置），并按**实际组件对应关系**（件名/件族 → 实体）做门禁，而不是只数总数。
- 塔身 BOM/成本接生成器（117 件只在 `bomCoverage` + `design.warnings` 里标注）
- 双塔真实结构与镜像几何、托盘几何、空托盘回流、伸缩叉、丝杠、导轨、抱闸、防坠
- 塔的 146 件没有 sceneIntegrity 断言

### 校核

- 结构强度、挠度、防坠、链条/丝杠载荷——目前只有屈曲手算量级，`structure.accepted:false`；塔几何「静态存在」「B-Rep 核验跑通」都不等于可承载
- `sweep` 现为 fail，不得改判
- 双塔同时进出、汇流争用、空托盘回流后的真实吞吐
- 静态 AABB 命中必须拆分 `mates`/`confirmedHits`，不能直接当制造碰撞结论

### 电气/安全/PLC

- 完整 IO（16 位到位检测、升降/叉原点与限位）；IO 草案地址仍为 `null`、`executable=false`
- PLC 程序与真实硬件联调；计数器同步/对齐入口
- 双通道急停、安全门、光幕、安全继电器/安全控制器——普通 DI 不能替代
- **结构、安全、电气、PLC 均未验收**

### 软件一致性

- P3-1：已修 —— `sync-subprocess-scan.mjs` 扫 `execFileSync|spawnSync|execSync`，剥注释、排除字符串/属性
- P3-4：已修（范围限 `design_machine`）—— 内部异常回 `INTERNAL_ERROR`，只有 `RangeError` 才回 `INVALID_ARGUMENT`
- `sceneIntegrity` 仍是计数门禁，可继续纳入交付门禁，但不要当成几何正确性证据
- `pv-buffer-regenerate.mjs` 的 `slotsFromGeometry` 仍是 `(layers)=>layers` 参数回声（塔路径才是从零件表派生），门禁脚本核不到「整层丢失」，属既有已知项
- **`invalid-shelf-geometry`（witness 侧）已由 N14 收口**：`verify:channel` 的 N14 覆盖「生产几何 `tray-*` 件 `center.x/z=NaN` → `witness=null` + `diagnosticCode='invalid-shelf-geometry'` + `feasible=false`」，并带未污染几何正控；`panel-channel.test.mjs` 的单元级 NaN（minX/center[2]）断言仍在。边界：N14 只测**承托件中心**两个轴，未覆盖「件尺寸/旋转非有限」「承托面 role 被改」这类组合；`buffer-tower-channel` 的静态断言只钉 N14 名字与三处断言本体，脚本若整段重写仍需人工复核。

## 下一会话建议顺序

1. 读本文件 + `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`，跑 `git status` / `git log --oneline origin/main..HEAD` / `git rev-parse HEAD origin/main`。**HEAD 是 `dec1373`（docs-only），已与 `origin/main` 同步（ahead/behind 0/0），工作区干净**。四笔（`920ea07` → `b85fab5` → `8037e11` → `dec1373`）都已 push，**远端 CI run `44444540414` 对 `dec1373` 7/7 绿**（`FeatureTree` 的 16 层 17/17、8 层 10/10，`tsc + unit tests` 的 3614/3611/3/0）。不要再当成「待提交 / 未推送工作区」；不要改写或重排这四笔历史（已推送，重排要 force push），也不要 `git checkout --`。
2. **门禁已跑完且已提交（final6，10:04–10:10，对应源码提交 `920ea07`+`b85fab5`）**：targeted 205/205、focused 370/370、全量 3614（3611 pass / 3 skip / 0 fail，205,933 ms）、tsc exit 0、kb 13/454/434,531、`verify:channel` 2/8/16 各 27/27、`verify:step-tower` 8 层 10/10 / 16 层 17/17、`verify:step` 7/7、regen 58/58、`build:ext` 2,941,695 B / gzip 920,422 B。**不要重跑 final6**：`8037e11` 与 `dec1373` 只动文档与 `kb.json`，不改源码/测试，这些数字仍对应当前源码；远端 run `44444540414` 已用另一台机器交叉复核到全量 3614/3611/3/0、16 层 17/17、8 层 10/10。只有你改了源码/测试才必须整轮重跑（顺序照抄下面），并在跑完后把文首「当前状态」与本表换成**新**日志：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   node --test test/machine/buffer-tower-channel.test.mjs         # 清单 22
   node --test test/machine/panel-channel.test.mjs                # 清单 50
   node --test test/agent/interference-panel-diagnostics.test.mjs  # 清单 10
   node --test test/machine/geometry-export.test.mjs test/parametric/verify-step-tower.test.mjs
   node scripts/verify-channel.mjs --levels 2 / 8 / 16             # 三次 27/27、exit 0
   npx tsc --noEmit
   npm run test:focused                                            # final6 = 370
   timeout -k 15 900 npm test                                      # final6 = 3614
   npm run build:ext                                               # 记 extension/gzip 字节
   npm run verify:step-tower -- --levels 16                        # 应打印 9 内核 + 导出边界 8 = 17/17
   npm run verify:step-tower -- --levels 8                         # 9 内核 + 导出边界 N/A = 10/10
   npm run verify:step                                             # 85 件
   npm run regen:pv-buffer
   npm run kb:build                                                # 两份交接文档不在 KB_DOC_FILES，统计预期不变
   git diff --check                                                # 必须无输出
   ```
   **四笔已经提交并推送（`920ea07` / `b85fab5` / `8037e11` / `dec1373`），不要重做提交、不要重排已推送历史**；落库分组见文末「文件落库情况」。**本文件这一轮只改两份文档 → 改完提交并 push，再对新 SHA 查一次 CI**（新提交在 push 前没有 run）：
   ```bash
   cd /tmp/automation-cad-prototype
   git status --short                     # 应只有这两份文档是 M
   git add HANDOFF-NEXT-SESSION.md docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md
   git commit -m "docs: backfill remote CI result for dec1373"
   git push origin main
   git rev-parse HEAD                     # 记下新 SHA
   gh run list --limit 3                  # 新 run 的 headSha 必须等于这个 SHA
   gh run watch <run-id>                  # 盯到结束；失败就按日志修，不要猜
   ```
   **已验基线（`dec1373`，run `44444540414`，7/7 绿）三件事都成立**：① `npm test` 全绿（3614/3611/3/0）；② `featuretree-geometry` 的 16 层 / 8 层 STEP 步骤（`ci.yml` 第 856–857 行）真实执行并通过（16 层 17/17、8 层 10/10）；③ `verify:channel` **不在 CI**，它只有本机 27/27 这一份证据。新提交若只动文档，预期与 `44444540414` 相同；若 CI 红了，先看是哪一步、修完再 push，别把红说成绿。
3. **补覆盖盲区（N12/N13/N14 已补齐；导出边界 P2-5 已在 final6 实跑）**：`machine-geometry.ts`（`towerWorkpiecePart` 注释、几何 assumptions）与 `geometry.ts`（`workpiecePlaceholder`）已改成「碰撞刚体 = 装配件+1；BOM 96/qty146、制造导出 STL/glTF/sidecar→STEP = `ConveyorPart` 48/90/146，板由 `machineExportParts` 排除；成本/容量不变」（`machine-geometry.ts:1043`/`:1126` 两处提示串仍是旧措辞，P3）。`verify-channel` 的 N12 覆盖同 id 托板 + role/size/center/`rotationZDeg=90°`（**五维都有门禁**），N13/N14 覆盖坏坐标。**导出边界现在是实跑证据**（16 层 17/17 含 8 条、8 层 10/10 含 1 条 N/A），但它是 sidecar 级断言、**不核对内核 STEP**；仍缺「逐实体 bbox 覆盖 + 实际组件对应」这类能堵内部件漏件的 STEP 断言。
4. **设计可承载的升降通道**：让 `sweep` 的 confirmed 命中归零，再谈机构可行性；同时做**逐实体 bbox 覆盖 + 实际组件对应**的 STEP 门禁，堵内部件漏件盲区。
5. 之后才是结构/安全/电气/PLC：结构 `accepted:false`、IO 地址 `null`、`executable=false`，都未验收。
6. `npm run kb:build` 只索引 `desktop/src/agent/kb/index.ts` 里 `KB_DOC_FILES` 那 13 份文档（不含 `PV-BUFFER-*.md`）；改那 13 份中的任何一份后必须重建，否则 `test/agent/kb-freshness.test.mjs` 会失败。

## 安全与数据注意事项

不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，其中有真实智能体设计工程和模型结果；不要把其中任何密钥复制到仓库或文档。IO 草案地址为 `null` 是有意设计，必须经电气与安全工程确认后才能分配真实地址。
