# PV 缓存机迭代交接（软件侧）

仓库 `/tmp/automation-cad-prototype`（`main`，HEAD `411f21d` 已推送）。**工作区有未提交改动：16 M + 3 ??**（塔 B-Rep 入口 + 整机 STEP 完整性门禁 + 统一分派判据）。远端 CI run `44276548527` 是 **7/7 全 success**，但它只覆盖 `411f21d`，**不含本轮改动**；**CI 尚未跑过本轮工作区**。

> 本文标「本轮」的数字 = 当前未提交工作区（HEAD `411f21d` + 16 M + 3 ??）的本机最终实测，未提交、未推送、未上 CI。标「历史」的 = 已提交的上一轮。

## 上一轮（已提交）做了什么

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

## 本轮（未提交）做了什么

1. **塔的 B-Rep 入口接通**（S1–S4）：`MODEL_BUILDERS` 加 `buffer-tower`（参数清单与塔身上下限同源、`rangePolicy:'reject'` 越界拒绝）；`build_machine_model` 按塔建 **146 件**（`bufferTowerParamsFromConfig` + `buildBufferTowerParts`，与 `apply_machine_design` 同一份零件表）；工程保存新增 `design`（`panel/inbound/frame` 以前走 `params` 会被静默过滤）；升降轴多件化（侧叉/梳齿台面按件族全带走）。
2. **`design`/`config` 入参进命令层**：`build_machine_model` 白名单从 `process/params/name/load/brief` 扩到含 `design`/`config`，并原样透传、要求是对象、`design` 与 `config` 二选一。以前 `未知参数：design` 直接拒，「`design_machine` 出塔 → 同一份 design 去整机建模」这条链对智能体不可达。
3. **分派判据只有一份**：`isBufferTowerConfig`（`config.bufferTower.kind === 'tower'`）+ `resolveModelDispatch`，命令层/渲染层/几何层共用。只给 `design`（不写 `process`）→ 按塔建；显式 `process:'conveyor'` + 塔 design → **冲突，显式拒绝**；声明是塔却没 `bufferTower` → 拒绝。**不再有「同一份 design 出 146 件 / 29 件且 `ok:true`」。** 入口形状同口径：`design`/`config`/`design.config`/`params` 必须是非数组对象，**`process` 给了就必须是非空字符串**（`123`/`{}`/`[]`/`'   '`/`null` 以前被静默当「没写」→ 默认 conveyor 29 件且 `ok:true`，现在命令层与工具层都是 `INVALID_ARGUMENT`、bridge 0 次）。
4. **塔分支几何收尾**：整机建模的塔分支现在也走 `resolveMachineGeometry`（`towerGeometry`：`assertTowerAboveGround` 地面线守卫 + 随动件标注），并断言两条链件数一致，不一致报 `INTERNAL_ERROR`（以前绕过守卫，同一份 config 在 `design_machine` 会被拒、在这里照建照存）。
5. **整机 STEP 完整性门禁**（`desktop/scripts/verify-step-tower.mjs`，`npm run verify:step-tower`）：根因是整机级**逐件累计布尔并**丢件（16 层 146 件只出 86 实体、顶点 z 只到 3636）。`spike/build123d/app.py` 改成一次性 `fuse` + 合并后包络/体积自校验 + 失败回退 Compound；门禁按「整机 STEP 顶点包络 == 逐件 STL 顶点包络并集」判，并挂实体数与件数。CI 在 `featuretree-geometry` 里跑 16 层 + 8 层。
6. **门禁判据本轮改严**：容差**按端**取（min/max 各看自己的极值件，不再共用最大圆柱半径）、且只对**垂直于回转体轴**的方向给半径（轴向端面严格 ±1）；逐件 `solids` 缺失**判红**（不再按 1 计）；**合并回退即失败**，且 **build 模式 `merge` 元数据缺失也判红**（以前 `if (mergeMode)` 会让整条检查消失，9 项变 8 项仍全绿）；`--file` 模式默认判红（合并路径无法从裸 STEP 判别），只有显式 `--merge-manifest` 才判；`app.py` 非 perPart 时不再写 `partSolids=0`。CLI 级测试补到 6 条（`--levels` 非法 / `--file` 不存在 / 桩 STEP / manifest fuse 通过 + compound 红 / **manifest 三种形状（`{merge}` / 扁平 `{mode,fallback}` / 整份 `{stats:{merge}}`）** / 证据不合格 exit 2）。

### 本轮已跑（最终本地实测，当前未提交工作区）

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
| `npm run verify:step-tower -- --levels 16`（真内核） | **146 件，STEP 2,301,982 B，104 solids，812 faces，mode=fuse，9/9 PASS** |
| `npm run verify:step-tower -- --levels 8`（真内核） | **90 件，STEP 1,622,322 B，55 solids，538 faces，9/9 PASS** |
| `npm run verify:step`（旧 85 件整机） | **7 / 7 PASS** |
| `npm run regen:pv-buffer` | `checks=58 failed=0`，仍 8 层 90 件，scene 90/90 |
| `project-session-smoke.mjs` | `PROJECT_SESSION_SMOKE_PASS`，exit 0 |

原始日志：`/root/.hermes/cache/scratch/cad-brep-lastmile-{focused,tsc,build,npm-test-close,kernel-final}.log`、`cad-brep-final-09-project-session-smoke.log`。

### 本轮没跑（不许当通过）

- **CI 本轮未跑**：`featuretree-geometry` 的 16/8 层步骤从未在本轮工作区上执行过。
- 结构强度/挠度/防坠、安全回路、电气、PLC 联调——未校核/未验收。
- 所有机械 `sweep` 干涉仍 **fail**。

## 塔身几何：静态几何存在、B-Rep 核验跑通，机构/结构未验收

`config.bufferTower` 是**另一套语义**，与 `layers:8` 并列不合并：`levels=16 / slotsPerLevel=1 / slotsPerTower=16` → 塔身建造器出 **146 件 / 设计包络 [2430,1790,3840] / 柱高 3840 / 柱截面 80（反算）/ 16 层 × 1 位 / 可用储位 15 / 升降行程 2700**，`slots.fromGeometry=16 claimed=16 aligned=true`。这是**静态件表 + AABB**，不是可制造结构。

- **入口**：`design_machine` + `apply_machine_design`（`resolveMachineGeometry`），以及本轮接通的 `build_machine_model`——三条入参路径：`process:'buffer-tower'` + 扁平参数、`design`（`design.config.bufferTower` 权威）、`config`（`design.config` 简写）。
- **B-Rep/STEP（本轮真内核）**：整机建模出逐件 STL + 合并 `model.step`，门禁 `npm run verify:step-tower` 已落地。
  - 16 层：**146 件 → 2,301,982 B / 104 solids / 812 faces / mode=fuse / 9/9 PASS**；STEP 顶点包络 **2430×1770×3840**。
  - 8 层基线：**90 件 → 1,622,322 B / 55 solids / 538 faces / 9/9 PASS**。
  - **容差口径（上一版写反了，已更正）**：两个规模下逐件 STL 的 Y 上界都比 STEP 高 **19.99 mm**。这 19.99 mm 是 **Ø40 竖直（轴 Z）升降导柱的径向母线**：B-Rep 顶点只落在圆柱接缝（y=780）上，真实外形到母线（y=800），差 = 半径 20；判据只在**垂直于导柱轴**的方向（x、y）给半径 20 mm，**沿轴（Z）的端面严格 ±1 mm**（`minAllowance=[1,1,1]`、`maxAllowance=[1,20,1]`，逐端取极值件）。即「端面/平面端严格 ±1、回转体径向给半径」，不是「水平圆柱端点 20 mm 容差」。因此是「声明容差内通过」，**不能宣称逐点完全一致**，也**不是制造验收**。
  - **覆盖范围（判别力边界）**：门禁是包络/数量级证据（顶点并集、实体数与件数挂钩 0.6×下界、逐件 bbox 与内核自报一致、合并路径必须 fuse），**不是逐件身份**：内部件丢失只要不动轴极值、且丢后实体数仍在下限之上就看不见——16 层 floor=88 实测 104（可丢 16 个实体），8 层 floor=54 实测 **55**（**只丢 1 个实体仍然绿**）。实体/件数比 16 层 0.71、8 层 0.61 只是「没整层丢光」的下界。**门禁通过 ≠ 逐件身份核对、≠ 制造验收。**
  - **合并路径是硬门禁**：build 模式 `stats.merge` 缺失即判红；`compound`/`fallback:true` 即失败。`--file` 模式裸 STEP 判不了 fuse 与 compound 回退，**默认判红（未验证）**，要 PASS 必须显式 `--merge-manifest <构建期 stats.merge JSON>`（`mode` + `fallback` 布尔值）；接受的形状就是**实现并测过的那三种**：`{merge:{mode,fallback}}`、扁平 `{mode,fallback}`、整份 stats `{stats:{merge:{mode,fallback}}}`（多余键忽略）。**`--file` 不是验收模式。**
- **质量口径两条**：整机建模 = 按内核体积**折算**质量（非称重）；`design_machine`/`apply_machine_design` = `massKg:null`、`massSource:'not-measured'`，`bomDraft` 仍是 8 行底架口径、塔身 117 件只在 `bomCoverage` + `warnings` 里标注、`costScope:'base-conveyor-only'`。
- **动态干涉**：`rest` / `lift` = **pass**（38 对、0 命中）；**所有机械 `sweep` 仍 fail**（pairs 42 / hits 405 / confirmed 270 / screen 135）—— 台面在托板投影内、层托板是整块板，没有升降通道，真实机构缺口，不得改判。
- **结构**：只有屈曲手算量级，`structure.accepted:false`；柱截面 80 mm 折算后仍超许用约一成以上。静态几何「存在」≠「可承载」。

## 8 层 ≠ 16 位

`layers:8` 的几何只有 **8 个储位**（第 1 层是底层输送线），regen 固定输出 `slotsFromGeometry=8 claimedSlots=16 aligned=false`，`npm run regen:pv-buffer` **仍是 8 层 90 件**（包络 [2430,1690,2400]），塔**不在** regen 路径上。

- 本轮 regen 已重跑：**`checks=58 failed=0`，8 层 90 件，scene 90/90**；产出的 STEP 为 **1,622,322 B / 55 实体 / 538 advanced faces**（与 8 层基线一致）。旧的 781,970 B / 47 实体 / 264 faces 是**历史丢件产物**，不要引用。
- `PV_REGEN_NOTE` 文案在脚本 `desktop/scripts/pv-buffer-regenerate.mjs` 内：「16 层塔身几何已由 bufferTower 建造器生成（146 件静态件表），但不在本脚本路径上，故本报告无塔 B-Rep/STEP；本脚本不把 8 层冒充 16 位」。**这段文案与 `BASELINE` 注释是本轮改的**（旧文是「16 位只存在于 bufferTower 纯数据槽位模型」，BASELINE 里还写着旧的 781,970 B / 47 实体）；本轮的 `regen:pv-buffer`（`checks=58 failed=0`）是在改完之后跑的，输出那行 `PV_REGEN_NOTE` 已带新文案。

## sceneIntegrity 现状与剩余风险

现状：计数等式门禁。两个计数必须是非负整数，模型件数 == 场景件数（可再要求等于期望件数），否则 `complete=false`（`assertSceneIntegrity` 抛错）。UI 页脚显示 `场景完整性：90/90 件`。

剩余风险：

- 只证明件数一致，**不证明几何正确**：错形状、错位置、错层高、错朝向都能 90/90 通过。
- 不证明 180 mm 层距下的 lift/sweep/push 动态干涉、结构强度、挠度、防坠。
- 计数来自 viewer 诊断聚合，历史上出现过实例重复计数（已修）；新增实例化路径必须重跑 `test/cad/scene-integrity.test.mjs` 与 regen 的 90/90 断言。
- 塔的 146 件没有对应的 sceneIntegrity 断言（regen 只覆盖 8 层）。
- STEP 门禁是**包络级**：丢的是内部件且不影响任何轴极值时仍可能漏（需逐实体 bbox 覆盖 + 实际组件对应，未做）。
- `complete=true` 不是「可以交付制造」的结论。

## 不要宣称的东西

- 不要说「缓存机已实现」：现有的是纯数据状态机 + 逻辑 IO 草案（地址 `null`，`executable=false`）。
- 不要说「塔已出 B-Rep 并已验收」：STEP 出口已通，门禁已落地并在**本地真内核 9/9 通过**；但只到包络级、容差 19.99/20 mm、**不是逐点完全一致、不是制造验收**，且 **CI 未跑过**。可以说的是「16 层塔身静态几何 146 件、整机建模入口接通、STEP 完整性门禁本地 9/9」。
- 不要说「动态干涉/强度已校核」：静态 AABB 命中不等于制造碰撞结论；塔的 `sweep` 仍是 fail。
- 不要说「结构/安全/电气/PLC 已验收」：结构只有屈曲手算、`accepted:false`；IO 地址全 `null`、`executable=false`；无 PLC 程序、无安全回路。
- 不要用 focused 的子集结果替代全量结论，也不要把旧迭代的 250 mm 产物当成 180 mm 结果，更不要把 regen 的 8 层 90 件当成塔。
- 不要引用 781,970 B / 47 实体那组 STEP 数字（历史丢件产物），也不要拿上一轮的 221 / 3463 / 2 927 156 B 当本轮现状。

## 下一步建议

1. **提交 + CI 首跑**：本地门禁已全绿（见上表），提交推送后确认 `featuretree-geometry` 的 16/8 层步骤在 CI 上首次通过——这一步没做之前，只能说「本地通过」。
2. **设计可承载的升降通道**：托板开口/梳齿/避让，让 `sweep` 的 405 命中归零，再谈机构可行性。
3. **堵 STEP 内部件盲区**：逐实体 bbox 覆盖匹配 + 按实际组件对应关系（件名/件族 → 实体）判门禁，而不是只数整机实体总数。
4. 结构/安全/电气/PLC 校核与验收；接现场前补计数器同步入口（故障期拒绝已有 `ITEM_REJECTED_FAULT`）。
5. `npm run kb:build` 只索引 `KB_DOC_FILES` 里那 13 份文档（本文件不在其中）；改了那 13 份要重建，否则 `test/agent/kb-freshness.test.mjs` 失败。
6. 始终保持有界跑法：`timeout -k 15 600 npm test`；不要把无界等待当通过。
