# AutomationCAD 下一会话交接

更新时间：2026-11-18（本轮：M1 承托/通道修复 + 塔 B-Rep 入口接通 + 整机 STEP 完整性门禁 + 统一分派判据）
项目：`owlco001/automation-cad-prototype`
工作目录：`/tmp/automation-cad-prototype`
当前 HEAD：`7b089a1`（与 `origin/main` 同点）；**工作区现有未提交改动：10 M + 5 ??**（M1 承托/通道这一轮 + 上一轮塔 B-Rep/STEP 门禁叠在同一工作区，清单见「未提交的文件」，`git status --short` 为准）。

> **口径**：下文凡标「本轮」的数字，都是 **HEAD `7b089a1` + 上述未提交工作区** 在本机（**node v26.7.0** / npm 11.19.0）跑出的最终实测——**未提交、未上 CI**。标「历史」的数字来自已提交的上一轮，只能当历史，不能当现状。

## M1「首层承托取放」纯数据概念验证（2026-11-18，基线 `main@7b089a1`，未提交）

> 这一节是**最新一轮**（基线 `7b089a1`）在 T3 对抗审查修完 P1、并按只读复核闭合 P1-R1/P1-R2/P2-5/P2-6 之后的实测；下面从「开始前必做」起仍是 `411f21d` 那一轮的记录，数字不要混用。

**先钉死三条口径（否则后面的数字会被误读）**

- **生产塔没变**：16 层仍是 **146 件 / 146 装配件 / `partCount` 146**，板**不在** `geometry.parts`（只挂 `workpiecePlaceholder`、`inCollisionSet:false`），升降轴只随动 `lift-platform`。
- **M1 的 152 件是 fixture-only**：只在 `test-support/m1-channel-fixture.mjs` 里（146 −1 台面 +2 叉指 +1 横梁 +4 分段带），生产建造器 `/build_machine_model` 都不会产出它。
- **生产塔的通道诊断恒 `diagnostic-only`**：`checkPanelChannel` 在「板只在 placeholder」**或**「行表不是几何给的（`rowsSource='caller'`）」时，返回 `mode='diagnostic-only'`、承托 `claim='diagnostic-only'`、`feasible=false`、`m1.feasible=false` —— 夹具的 M1 绿**不许**写成生产塔可行，调用方自带 `rows`+`pose` 也升不成 `verified`。

**本轮做了什么**

- `desktop/src/machine/panel-channel.ts`（纯函数）修 P1：
  - 板位姿**必须显式**：`resolvePanelSupport` 要求 `panel.centerXMm/centerYMm`（不再默认 0）+ `bottomZmm`；`resolveChannelFeasibility` 要求 `pose{ bottomZmm, centerXMm, centerYMm }`（与 `panel.center*` 冲突则拒绝），**不再读 `inbound.beltHeightMm` 当板底**；
  - carried 与轴绑定：carried 底面 = `pose.bottomZmm + max(0, 轴位移 − 拾取空行程)`（与 `interference-states.workpiece.bottomZ.lift` 同公式），位移/空行程来自 `carriedShiftMm`/`pickupGapMm` 或几何轴，**都没有 → 按 0 处理 + `m1.diagnosticError`，不可能报 supported**；
  - **显式位移 fail-closed（复核 P1-R1）**：`carriedShiftMm` 负值 → `INVALID_ARGUMENT`；`shift > axis.strokeMm`（或板抬 > 行程）→ `INVALID_ARGUMENT`（旧实现照收 shift=100 / 轴声明 20 并回 `carried.supported`）；几何里没有 `axis.strokeMm` 时只作诊断；空行程只能靠 M1 缺省值（`m1-default`）时同样只作诊断 —— 0 / 超行程 / 无轴证据一律不许 `supported`；
  - blockers 只留可复算事实（`load-passes-shelf` / `no-support` / `stroke-shortfall`）；净跨/走廊降级为 `designNotes`（`clear-span-conservative` / `corridor-conservative`），文案改成「当前结构参数下的保守设计余量，需结构确认」，并给出 `columnSweep`（实测柱与板 y 向重叠 0、行程内相交 0 件）；
  - 每条 `load-passes-shelf` 的 detail 从件表派生（不写「26 处 / 446 处」）；`stroke-shortfall` 标明 **M1 叉指停位口径**（现轴台面 `lift-platform` AABB **z 970..1010**，顶面 1010 / 底面 970；970 这个停位口径下不缺）；
  - `panelSourceOfGeometry` 回传 `centerXMm/centerYMm` 且占位体缺 `center` 就**不认板**；`center/size/bottomZmm` 改用严格数字判据（`typeof === 'number' && Number.isFinite`，不再 `Number()` 强转：`Number(null)===0`、`Number('')===0` 会把 `center=[null,null,917.5]` 读成 (0,0) 并谎称来自几何 —— 复核 P2-6）；新增 `liftAxisOfGeometry`；`checkPanelChannel` 现接受 `rows/pose/carriedShiftMm` 覆盖，并把非本模块的 RangeError 从 `NOT_A_TOWER` 改成 `INVALID_ARGUMENT`；
  - **`verified` 只认几何行表（复核 P1-R2）**：`rowsSource='caller'` 一律 `diagnostic-only`（夹具行表 + 生产几何 + pose 曾报 `verified`/双向 `supported`/`m1.feasible=true`，而该塔 146 件、叉指 0 件）；`resolveChannelFeasibility` 收到 `supportSource:'caller-rows'` 也强制 `diagnosticOnly`。
- `machine-geometry.ts` 的 `towerWorkpiecePlaceholder()`（上一轮已落地，本轮未改）：板占位体 2278×1134×35、底面 900、`inCollisionSet:false`，**不进 `parts`**。
- `interference-states.ts` 只读 `panelSupport / panelFeasibility / panelChannelNote` + `requirePanel:true`，判据未改。
- `scripts/verify-channel.mjs` 重写为**层数无关**（件数从 `parts` 派生、只校验关系，不写 146 / 16 层 / ≥400 处），新增 4 条反例：中心偏移、位移 5、生产 placeholder、缺位姿/缺位移；**`--levels` 2..64 均 exit 0**：17 层起基线建造器的 `gearmotor|column-bl` 相交 1 对（柱截面随塔高派生 → 柱位外移）单列为 `baselineNotes`，不计入通道自证，**其余 rest/lift 命中仍判失败**，≤16 层要求全 0；断言名也改掉「真实件表首层也托不住」这种把阈值当几何事实的写法。
- 测试：`panel-channel.test.mjs` **32 条** + `buffer-tower-channel.test.mjs` **17 条**，都在 `test:focused` 里（定向复跑 **49/49 pass**）。

**实测（node v26.7.0，修复后）**

| 对象 | 实测 |
|---|---|
| 真实塔（`parts.length`=146 @16 层） | rest/lift = 0/0 pass；sweep = 270 确认 + 135 待复核 fail（与基线一致）。**≥17 层**：rest/lift 各多 1 对 `gearmotor\|column-bl`（柱截面随塔高派生 → 柱位外移，建造器问题，非通道判据，脚本单列 `baselineNotes`） |
| 真实塔承托 | rest 覆盖 100% 但只有 **1** 条接触带 → `verdict=unsupported`、`claim=diagnostic-only`；carried 底面 = 静止底面、`claim=diagnostic-only`（位移来源 missing） |
| 真实塔通道 | `feasible=false`：blockers = load-passes-shelf / stroke-shortfall（缺 16.5，M1 叉指口径）；designNotes = clear-span-conservative / corridor-conservative（净跨 2000 vs 2278、走廊 135 vs 567，**非阻塞**） |
| M1 概念件表（152 机台件 + 板 = 153 刚体 / 装配 152 / 包络 2430×1790×3840） | rest/lift/sweep = **0/0/0 pass**（20 mm 段）；`mode=verified`；承托 rest **80.6%**（3 带）、carried **15.48%**（2 带）都 supported；位移 20（axis）→ 板抬 10；多层仍 false |
| 自证 22 条（**正向 11 / 负向 11**） | 正向：行程不变量、净跨关系、走廊关系、柱与板 AABB 不相交、多层不可行、单条 1200 整带 → claim 降级、件数语义、rest/lift 通道相关 0、M1 三态、M1 承托 supported、M1 多层仍 false。负向 N1–N11：板外叉 0%；缺板 → INVALID_ARGUMENT；120 宽叉 → 红且指到 lift-finger；超行程 40 → 红且含 belt-top×lift-carriage；满行程 → 红且含板/托板；非塔 → NOT_A_TOWER；**中心偏移 300 → 80.6%→72.22%**；**位移 5 → 报告 5、carried 底面不变、m1.feasible=false**；**生产 placeholder → 无 supported claim**；缺位姿 → 拒绝；缺位移 → 不伪造绿 |
| 门禁 | `npm run verify:channel` → `TOWER_CHANNEL_RESULT ok`，自证 **22/22**（正向 11 / 负向 11），exit 0；`--levels 2 / 16 / 17 / 64` 同为 22/22、exit 0；定向 `node --test test/machine/panel-channel.test.mjs test/machine/buffer-tower-channel.test.mjs` = **49/49 pass**；`npx tsc --noEmit` = 0；`git diff --check` = 0（本机，全量 `npm test` 未跑） |

**CI 边界**：`verify:channel` **不在 CI**（`ci.yml` 只跑 `npm test`）；负向用例在测试文件里，所以 `npm test` 仍有覆盖，但「22/22 自证」只有本机跑过。

**口径更正**：架构文档写的 82.5% / 17.0% 与它自己的件表尺寸不符（`2278×914/2278×1134 = 80.61%`、`2×2000×100/2583252 = 15.48%`）。按实测记账，未改阈值；carried 只剩 0.48 个百分点余量。

**没跑**：STEP/内核（152 件未进 build123d）、`regen:pv-buffer`、全量 `npm test`、CI、Electron 冒烟。

**遗留**：M1 只证明「首层托住并抬起 10 mm」，**不是多层可行**；**生产塔没有 channel 承托路径**，其诊断恒 `diagnostic-only`；板挠度、导向/同步、防坠/抱闸、安全回路、PLC/IO 未建未验；真实塔 sweep 仍 fail；行程缺口 16.5 mm（M1 叉指口径）未修；净跨/走廊的保守设计阻塞需结构确认。

## 开始前必做

```bash
cd /tmp/automation-cad-prototype
git status --short      # 现在是 10 M + 5 ??（M1 承托/通道 + 上一轮塔 B-Rep/STEP 门禁，未提交）
git log -5 --oneline    # 顶端是 7b089a1（= origin/main）
```

`git status` 非空是**预期状态**，不是别人插队：先看清单再动手，不要回滚、不要 `git checkout --`。

## 当前远端状态

最后已推送提交（远端 `main` 就是这里）：

- `411f21d`：锁存故障期来料拒绝（`ITEM_REJECTED_FAULT`）+ 静态守卫扫三种同步子进程 API
- `65229c5`：缓存塔塔身几何 builder（fail-loud 配置、真派生储位、塔升降轴）
- `e6c1ef3`：per-station PLC 转换（并行工位联动时间线通过审计）
- `b3b13f3`：CI 沙箱守卫

远端 CI 最近一次全绿是 run `44276548527`，验的是 `411f21d`；**不包含本轮任何改动**（工作区未提交，`7b089a1` 之后的改动也没上 CI）。`featuretree-geometry` 里新增的 16 层 + 8 层 STEP 完整性步骤一次都没在 CI 上执行过。

## 本轮门禁：最终本地实测（当前未提交工作区）

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
- **B-Rep / STEP（本轮真内核实测）**：整机建模出逐件 STL（146 件）+ 合并 `model.step`（生产 `ParametricManager`，一次性 `fuse`）。有效性判据是 `desktop/scripts/verify-step-tower.mjs`（`npm run verify:step-tower`）。
  - 16 层：**146 件 → STEP 2,301,982 B / 104 MANIFOLD_SOLID_BREP / 812 ADVANCED_FACE / merge mode=fuse / 9/9 PASS**。
  - 8 层基线：**90 件 → STEP 1,622,322 B / 55 solids / 538 faces / 9/9 PASS**。
  - **顶点容差必须说清（上一版把语义写反了，这里更正）**：16 层 STEP 顶点包络 **2430×1770×3840**，逐件 STL 包络 Y 上界比 STEP 高 **19.99 mm**。这 19.99 mm 来自 **Ø40 竖直（轴 Z）升降导柱的径向母线**：B-Rep 把圆柱写成「一条圆边 + 接缝顶点」，顶点只落在接缝（y=780）上，真实外形到母线（y=800），差 20 mm 就是半径。判据因此只在**垂直于导柱轴**的方向（x、y）给半径 20 mm，**沿导柱轴（Z）的端面仍严格 ±1 mm**（`minAllowance=[1,1,1]`、`maxAllowance=[1,20,1]`，按端点极值件逐端取）。一句话：**端面/平面端严格 ±1，只有回转体的径向给半径** —— 不是「水平圆柱端点 20 mm 容差」。所以这是「在声明容差内通过」，**不是逐点完全一致**；16 层与 8 层的 Y 上界差都是 19.99 mm。
  - **门禁的判别力边界（说清楚，别夸大）**：证据是（1）顶点并集、（2）实体数与件数挂钩、（3）逐件 bbox 与内核自报一致、（4）合并路径必须是 `fuse`。四条都是**包络/数量级**证据，**不是逐件身份**：内部件丢失只要不动任何轴极值、且丢掉后的实体数仍在**下限**之上，就看不见 —— 16 层 floor=`ceil(146×0.6)`=88、实测 104（可丢 16 个实体）；8 层 floor=54、实测 **55**（**只丢 1 个实体仍然绿**）。要堵这个盲区得做逐实体 bbox / 件名-件族覆盖匹配，本轮没做。**门禁通过 ≠ 逐件身份核对、≠ 制造验收。**
  - **合并路径是硬门禁（不是提示）**：build 模式必须由内核上报 `stats.merge`，**缺失即判红**（与逐件 `solids` 缺失同口径，上一版 `if (mergeMode)` 会让整条检查消失、9 项变 8 项照样全绿）；`mode=compound` 或 `fallback:true` 一律失败。`--file` 模式只读 STEP，**裸 STEP 里 fuse 与 compound 回退都是 `MANIFOLD_SOLID_BREP`，判不了**，所以默认判红并明说「合并路径未验证」；要 PASS 必须显式给 `--merge-manifest <构建期 stats.merge JSON>`（含 `mode` + `fallback` 布尔值），接受的形状就是代码实现并测过的三种：`{merge:{mode,fallback}}`、扁平的 `{mode,fallback}`、以及整份 stats `{stats:{merge:{mode,fallback}}}`（多带的键忽略）。**`--file` 不是验收模式。**
- **质量/BOM 口径分两条**（别混）：整机建模走 `conveyorBom(parts, volumes)`，给的是**按内核体积折算**的质量（不是称重）；`design_machine`/`apply_machine_design` 那边仍是 `massKg:null`、`massSource:'not-measured'`、`bomCoverage` 标注塔身 117 件不入机器 BOM、`costScope:'base-conveyor-only'`。
- 升降轴 `tower-lift`：行程 = (levels−1)×layerPitch = 2700，`strokeSource:'geometry'`。
- **动态干涉（未变，全部机械 sweep 仍 fail）**：`rest` / `lift` = **pass**（38 对、0 命中）；**`sweep` = fail**（pairs 42 / hits 405 / confirmed 270 / screen 135、`items 10`）——台面落在托板投影内、层托板是整块板，**没有升降通道**，真实机构缺口，不得改判。`push` 不适用。
- **结构**：`structure.staticOnly:true`、`structure.accepted:false`；柱截面按柱高反算 80 mm，折算板料后仍超许用约一成以上 → **未校核**。静态几何「存在」不等于「可承载」。

## 8 层 = 8 储位；regen 仍走 8 层（本轮已重跑）

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

## 未提交的文件

### 当前工作区（**10 M + 5 ??**，两轮叠在一起，未提交）

- 修改（10）：`desktop/src/machine/panel-channel.ts` 之外的两轮改动都在这里 —— `desktop/src/machine/interference-states.ts`（M1 只读字段 + `requirePanel`）、`desktop/src/machine/machine-geometry.ts`（`towerWorkpiecePlaceholder` + 几何入口/升降轴多件化）、`desktop/src/machine/geometry.ts`、`desktop/src/extension.ts`（塔分派 + design 落盘）、`desktop/package.json`（`verify:channel` / `verify:step-tower` / `test:focused`）、`desktop/test/agent/build-machine-model.test.mjs`、`desktop/test/electron/projects.test.mjs`、`desktop/test/machine/buffer-tower-model.test.mjs`、`HANDOFF-NEXT-SESSION.md`、`docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`
- 新增（5）：`desktop/src/machine/panel-channel.ts`、`desktop/scripts/verify-channel.mjs`、`desktop/test-support/m1-channel-fixture.mjs`、`desktop/test/machine/panel-channel.test.mjs`、`desktop/test/machine/buffer-tower-channel.test.mjs`

> 件数以 `git status --short` 为准（写这份时实测 10 M + 5 ??）；上一版文档写的「6 M + 5 ??」「16 M + 3 ??」都是当时快照，**不要再引用**。

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

## 下一会话建议顺序

1. 读本文件 + `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`，跑 `git status` / `git log -5`。**工作区非空是本轮改动**，先确认要不要提交，不要覆盖。
2. **提交并让 CI 首跑本轮工作区**：本地门禁已全绿（focused 281、tsc 0、build 2,938,104 B/gzip 918,889 B、全量 3518/3515/0/3、16 层 9/9、8 层 9/9、verify:step 7/7、regen 58/58、smoke PASS），但 **CI 尚未跑过**；提交后确认 `featuretree-geometry` 的 16/8 层步骤首次通过，再对外说「门禁已上 CI」。
3. **设计可承载的升降通道**：让 `sweep` 的 confirmed 命中归零，再谈机构可行性；同时做**逐实体 bbox 覆盖 + 实际组件对应**的 STEP 门禁，堵内部件漏件盲区。
4. 之后才是结构/安全/电气/PLC：结构 `accepted:false`、IO 地址 `null`、`executable=false`，都未验收。
5. `npm run kb:build` 只索引 `desktop/src/agent/kb/index.ts` 里 `KB_DOC_FILES` 那 13 份文档（不含 `PV-BUFFER-*.md`）；改那 13 份中的任何一份后必须重建，否则 `test/agent/kb-freshness.test.mjs` 会失败。

## 安全与数据注意事项

不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，其中有真实智能体设计工程和模型结果；不要把其中任何密钥复制到仓库或文档。IO 草案地址为 `null` 是有意设计，必须经电气与安全工程确认后才能分配真实地址。
