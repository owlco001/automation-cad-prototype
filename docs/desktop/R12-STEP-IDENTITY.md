# R12：STEP 伴生身份件（identity.step）能力合同 + 审查证据 + 验收

> 本文一份到底：**能力合同**（它是什么、怎么开、门禁要求什么）、**审查与整改证据**（P1 × 3、变异自证）、**验收读数**（12 道门禁本机实测）。
> 简明回执见 [R12-ACCEPTANCE.md](R12-ACCEPTANCE.md)；下一步见 [`HANDOFF-NEXT-SESSION.md`](../../HANDOFF-NEXT-SESSION.md)。
> 代码索引：`1671f36`（P1：身份件导出，5 文件）+ `b9f377a`（P2：原始装配树回读与门禁，4 文件），共 9 文件（4 改 5 新）。`10c2224` 是 R12 之前的基线，不是交付 HEAD。

## 0. 一句话结论与本轮**不**声称的东西

- **能力**：`/build` 可**选择性**多导出一份非融合的 `identity.step` 伴生成物；`verify-step-tower` 的 build 路径**强制**请求它，并用 occt 原始装配树回读，出 4 条追加判据（16 层 27/27、8 层 20/20）。**原制造默认路径不变**：不请求就没有这份文件，原制造 `step`/`stl` 导出调用与默认请求字段保持原样；不声称跨请求 STEP 文件逐字节相等。
- **不声称**：伴生 `identity.step` 与融合制造 STEP **不是同一产物**。件号集合、实体计数、±1 mm 包络三者对上，**只等于「导出侧身份齐全」**，**不等于**制造 STEP 的拓扑/形状等价，**不是**制造认证、不是逐实体拓扑认证。包络是**网格**包络，bbox 不是唯一几何指纹（见 §2 第 3、4 条）。

## 1. 能力合同

### 1.1 开关（工具面）

| 项 | 合同 |
|---|---|
| 字段 | `ParametricBuildOptions.identityStep?: boolean`（`desktop/electron/parametric.ts`） |
| 生效 | **仅 `=== true`** 才进请求体；`false` / `1` / `"true"` 一律按「未要求」→ 响应 200 但**无 identity 文件** → 门禁判红。失败方向不产生假绿 |
| 默认 | 关闭。默认与 `perPart` 请求体**不含** `identityStep` 键（有测试钉住） |
| 前置 | `identityStep: true` 且缺 `instances`（空/非数组）/ `perPart !== true` / `exports` 不含 `step` → **400**，逐项点名（`identity_request_error`） |

### 1.2 产物（内核面）

- 位置与命名：与制造 STEP **同目录**的 `identity.step`；回执 `files.identity = {path, bytes, ms}`。
- 结构：`bd.Compound(children=clones)`，根 `label='assembly'`，**无布尔** → 实体数 == 逐件合计。
- 件号：每件 `label = instance.id`（与 `files.parts[].id` 同一表达式、同一字符串，不做字符替换）；非 ASCII 走 OCCT `\X2\` 转义，回读还原。
- **顺序是判据**：制造 `step`/`stl` 全部导出后，才对 `deepcopy` 复制体打 `label`。实测制造 STEP 里 `PRODUCT` 只有 `COMPOUND`（`pollution=0`），`fuse` 不继承件号。
- fail-closed：导出抛错或文件 0 字节 → 400；**没有任何 `ok:true` 却缺 `files.identity` 的分支**。

### 1.3 门禁（`scripts/verify-step-tower.mjs`，build 路径）

- 强制请求 `{ perPart: true, identityStep: true }`；缺 `files.identity`（旧内核/未接受）、文件不存在、读不出来 → **FAIL、exit 1**，**不是 SKIP**。
- 回读口径：occt-import-js **原始 root/meshes**，**按原始装配节点实例分组**（同名兄弟节点各自成实例，不先按件号合并），**保留原始路径与名字，不重命名、不去重**。结构类失败一律红：无归属网格、网格被多节点引用、坏 indices、NaN/Infinity、深度截断、空树、伪造 raw 树。
- **追加 4 条判据**（既有 23 条（16 层）/16 条（8 层）判据一字未动，故 27/20）：
  1. **产物与回读完整性**：同目录、路径 ≠ 制造 STEP 自身、bytes 取真实文件、文本 `MANIFOLD_SOLID_BREP` 数 == 回读网格数、`Σ实体.meshCount == 回读 meshCount`（独立求和闭包，不只靠传递）；
  2. **三方件号集合**：真实件表 × `files.parts[].id` × 回读叶，`unknown` / `dup` / `pollution`（件号贴到制造 STEP 上）全为 0；
  3. **逐件实体数与包络**：总实体 == 逐件合计 == `stats.partSolids`；逐件 `meshCount == solids`；每件包络 ±1 mm；非退化；
  4. **并集核对与制造件污染**：两侧**同一份 OCCT 回读参数**（`STEP_READ_PARAMS`）取网格并集包络比对；制造侧读**真实 bytes**，回执自报 `products`/`solids` 不参与判定；制造侧导入失败 → 必红且 `unionDeltaMm === null`（不退回旧拓扑包络）。
- **容差固定 1 mm**：`ENTITY_IDENTITY_TOLERANCE_MM = 1`；CLI `--tolerance` **不继承**（只许更紧 `tightened`，>1 一律钉回 `capped`）；`NaN`/`Infinity`/负数/非数字 → `toleranceError` 非空，第 3、4 条同时红，**不静默兜底成 1 mm**。
- **归属用真实路径**：`realpathSync`（fail-soft）+ `lstatSync().isSymbolicLink()`；`identity` 路径**是符号链接即红**；`realpath` 相同（指回制造 STEP 自身）即红；字面量 `dir/./identity.step` 不假红。
- `--file` 模式：`entityIdentity = NOT-APPLICABLE`（只读一份 STEP，没有伴生成物），**不计入 ok、不是绿项、不是验收入口**，`--file` 的 23 条证据语义不变。
- 回执：一行 `STEP_TOWER_ENTITY_IDENTITY PASS|FAIL ids=… unknown=… dup=… solids=… mesh=… unionDelta=… bboxMaxDelta=… pollution=… tol=1mm(fixed)` + JSON `entityIdentity`（含 `identityBBox` / `mergedReadbackBBox` / `mergedVertexPointBBox` / `mergedReadbackMeshCount` / `mergedReadbackErrors` / `tolerance*` / 软链与归属字段）。

### 1.4 未加的东西（按合同刻意不加）

- 没有 `--require-identity` / `--identity-step` 新旗标：身份检查是 build 路径的**固有**判据，随原步骤生效。
- 没有新增 CI 步骤：新身份检查挂在 `ci.yml` **既有的** `verify:step-tower --levels 16/8 --require-full` 步骤里；`verify:channel --levels 2/16` 仍是独立的既有通道自证，不运行身份证据（见 §4.3）。

## 2. 边界：任何一次都不得越过

1. **不是拓扑/形状等价认证**：`identity.step` 是非融合 Compound，制造 STEP 是融合产物；两者**不是同一件东西**。件号 + 实体数 + ±1 mm 包络全对，**只**证明导出侧身份齐全。
2. **不是制造认证**：不认材质、面法向、可制造性、公差链；也不认证侧车里的 `box`/`cylinder` 近似**是否真是该件特征**（占位体不是制造几何）。
3. **bbox 不是唯一几何指纹**：同包络、不同内部结构仍可全绿。
4. **网格包络带偏折余量**：`bounding_box_ratio 0.001`，实测 3840 mm 塔 `bboxMaxDelta = 0.1823 mm`（<1 mm，**非零**）；再大的回转体可能 fail-closed 误红（方向安全，不会假绿）。
5. **`meshCount == 实体数` 只在受限格式成立**：compound、无布尔、root `label=assembly`、每节点 `label=件号`（实测一 solid 一 mesh）；普通 STEP 不成立。
6. **源码级伪造仍可过**：让导出侧 `label` 与几何脱钩，本层挡不住；守的是丢件、批造件号、实体搬家、贴标签、数据放大。
7. **软链判据只管 identity 侧**；构建目录整体被软链时两侧 realpath 一致，仍判绿（同一物理目录，判据自洽）。硬链接不做 inode 比较，靠内容/件号集合兜（实测贴件号的硬链接即红）。

## 3. 审查与整改（P1 × 3 全闭）

对手审查（T3）判定**有条件通过**，P1-1/P1-2/P1-3 全部真修并在真文件系统上封死，复审复跑后无 P0/P1 残留。

| 编号 | 原问题 | 修法 | 复审实测 |
|---|---|---|---|
| **P1-1** | 并集核对**混用两种口径**：制造侧取拓扑 `VERTEX_POINT` 包络，identity 侧取网格包络 → 圆柱恒差 19.85 mm（=半径），1 mm 下必红 | 两侧统一走 `STEP_READ_PARAMS` 的**网格**并集包络（新增只读 `readStepMeshEnvelope`，不复用要求身份树的 `readStepEntities`）；拓扑包络只作 `mergedVertexPointBBox` 报告 | `step.bbox` 喂 ±9999 仍 `ok:true`（判据不再吃入参）；制造侧换真 Ø40 圆柱 STEP 并伪造包络 → 红 `Δ=430/80/373 mm`；16/8 层真塔 `unionDelta=0/0/0` |
| **P1-2** | 归属只比字符串，可被同目录软链/指回自身绕过 | `realpath` + `lstat().isSymbolicLink()`；identity 侧软链即红；`normalizeStepPath` 折叠 `./`、`//`、`a/../` | 同目录软链红（`symlink=true`）、step 软链指回 identity 红（realpath 同）、另一目录软链红（`sameDir=false`）、字面量 `./` 不假红、硬链接靠件号集合红（`ids=1`） |
| **P1-3** | `--tolerance` 可把身份容差放大（20 mm 把 19.85 mm 缺口判绿） | 容差钉常量 1 mm；>1 `capped`、更紧 `tightened`、非法值判红 | `tolerance=20` → `1mm(capped)` 仍 `ok:false`；`NaN/Infinity/-1/"1"` → 红；真塔回执 `tol=1mm(fixed)`、JSON `requestedToleranceMm:1` |

**新增守卫**：`Σ实体.meshCount != 回读 meshCount` 独立判红（E9 型单点伪造不再只靠传递闭包）。

**M7 变异的事实链（如实保留，不倒写）**：
初报「7/7 全红」**不实** → 复审用同一 harness（副本与仓库四文件 `diff -q` 全同）复跑得 **6/7**，`M7`（导入失败退回拓扑包络）显示 `GREEN(未命中)`：缺边红靠错误串，`unionDeltaMm` 变成 `[0,0,0]` 无人断言 → 总管补 `unionDeltaMm === null` 断言并显式传入可用旧包络后，最终亲跑 **7/7 RED**（`cad-r12-final/mutations-final.log`）。结论：M7 是**证据/守卫缺口**补齐，不是门禁漏洞修补；首轮 6/7 的事实保留在案。

## 4. 验收（本机、同树、串行）

### 4.1 十二道门禁

| # | 门禁 | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | exit 0，0 诊断 |
| 2 | 定向 4 文件（`identity-export` / `step-entities` / `verify-step-tower` / `parametric-sidecar`） | **127 / 127**（12 + 28 + 65 + 22） |
| 3 | `npm run test:focused` | **424 / 424** |
| 4 | `npm test` | **3798 tests / 3795 pass / 3 skip / 0 fail / 0 todo**，129,159.907445 ms |
| 5 | `npm run verify:step`（真内核） | **7 / 7**，85 件 / 89 solids / 613 faces / 6000×1495×930 |
| 6 | `verify-step-tower --levels 16 --require-full` | **27 / 27**；`ids 146/146`、`solids 150/150`、`unionDelta 0/0/0`、`bboxMaxDelta 0.1823 mm`、`tol 1 mm(fixed)`、`pollution 0` |
| 7 | `verify-step-tower --levels 8 --require-full` | **20 / 20**；`ids 90/90`、`solids 94/94`、`unionDelta 0/0/0`、`bboxMaxDelta 0.1823 mm` |
| 8 | `eval:tasks --require-full` | **13 / 13**，`skipped 0` / `degraded false` |
| 9 | `verify:channel --levels 2` / `16` | 各 **30 / 30**，0 失败（**只是关系断言**，见 §5） |
| 10 | `npm run build:ext` | exit 0（tsc 0 + vite 303 modules；total 10,551,020 B） |
| 11 | `npm run smoke`（构建后） | `SMOKE_OK`，**4 条显式降级**，`PLC_HISTORY_READ_FAILED=0`、`STARTUP_METRICS_ERROR=0` |
| 12 | `regen:pv-buffer` / `doctor:sidecar --json`（dry-run） | regen `ok=true checks=61 failed=0`（隔离 userData）；doctor `scanned=347 targets=0 killed=0` |

- smoke 的 `STARTUP_METRICS totalMs=378.7` 只覆盖 **module evaluation 起点**（不含 Electron bootstrap 与静态 import），**是口径读数，不是提速证据**。
- 3 条 skip 与基线同源：2 条 `未设置 AUTOMATIONCAD_FREECAD_REAL`，1 条布尔探针（该用例自检解释器，不认 `AUTOMATIONCAD_PYTHON`）——**非本轮增量**。

### 4.2 全量增量对账

基线 **3750 / 3747 / 3 / 0** → 本轮 **3798 / 3795 / 3 / 0**，增量 tests **+48**、pass **+48**、skip 不变。

| 来源 | 增量 |
|---|---|
| `test/cad/step-entities.test.mjs`（新） | 28 |
| `test/parametric/identity-export.test.mjs`（新） | 12 |
| `test/parametric/verify-step-tower.test.mjs`（追加，未删既有用例） | 8 |
| 合计 | **48** |

- 只有这 3 个测试文件与基线不同（另 2 个新文件是 STEP 夹具），其余测试文件逐字未动 → 增量可完全归因。
- **口径更正**：早前架构报告里「`verify-step-tower` 基线 47」**已过期**，实际基线是 **57 reported**（55 个 `test(`）；因此不能用 `93 − 47` 当增量。定向 127 = 28 + 12 + 65 + 22，与 93（=28+65）不冲突，只是统计口不同。

### 4.3 CI 与回执约定

- `ci.yml` **已有**（R12 未新增步骤）：`verify:step-tower --levels 16 / 8 --require-full`、`verify:channel --levels 2 / 16`、`verify:step`、`eval:tasks --require-full`、`npm test`。本轮的新检查**随这些原步骤**进入 CI；`doctor:sidecar` **不在 CI 内**（只能按本机读数引用）。
- 远端基线已证：run `44536871871` @ `10c2224` = **success 7/7**。**但那是 R12 之前的 run，不是 R12 的 CI。**
- 本文所有数字**均为本机验证**。最终判定只认 `headSha == 交付 HEAD` 的 run，按 job 级读；回执由实跑写入 `scratch/FINAL-RECEIPT.json`，**本文不预写成功**。

## 5. 未解决 / 未做（原样保留，不许改判）

1. **升降通道仍未通**：2 层 sweep 19 步 / 9 命中步 / 18 确认 + 9 待复核 = 27 步累计 / 去重 4 对；16 层 **271 步 / 135 命中步 / 270 确认 + 135 待复核 = 405 步累计 / 去重 60 对**，`reviewStatus=fail`，`feasible=false`，blockers `load-passes-shelf` + `stroke-shortfall`（行程缺 16.5 mm）。**30/30 是尺子自证，不是通道可行、不是结构验收。**
2. **真实多层取放未实现**：已有多层几何，但层托板整块、台面在托板投影内；归零路线（缩回 240 / 开 240 缺口）只是决策书，未做机构变更与校核。
3. **结构/安全/电气/PLC 未验收**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO `null`、`executable=false`。
4. **regen 覆盖不全**：`slotsFromGeometry=8` vs `claimedSlots=16`、`aligned=false`，仍是**显式登记、未修**的缺口（只覆盖 8 储位/90 件缓存样机）。
5. **无安装包、无 Release**：`build:ext` 只是扩展产物与体积门禁，未签名、未打 tag。
6. **最终补修变异集覆盖 7 条针对性反例**，不构成纯函数全域证明；P1/P2 更早的定向反例见各自分报告，不混作同一统计口径。
7. **未验证**：Windows 路径分隔符与网络盘/权限异常下的 realpath；检查与读取之间的并发换文件竞态。

## 6. 复跑与证据索引

```bash
cd /tmp/automation-cad-prototype/desktop
export AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python
node --test test/parametric/identity-export.test.mjs test/cad/step-entities.test.mjs \
  test/parametric/verify-step-tower.test.mjs test/parametric-sidecar.test.ts   # 127
npx tsc --noEmit                                                                 # 0
npm run test:focused                                                             # 424
npm test                                                                         # 3798/3795/3/0
npm run verify:step                                                              # 7/7
npm run verify:step-tower -- --levels 16 --require-full --json                   # 27/27
npm run verify:step-tower -- --levels 8  --require-full --json                   # 20/20
node scripts/verify-step-tower.mjs --file test/fixtures/step-stub-3kb.step --levels 16 --json
                                                                                 # exit 1；entityIdentity=NOT-APPLICABLE
```

- 汇总：`/root/.hermes/cache/scratch/cad-r12-final/gates-summary.json`（12 门禁，逐条 raw 日志路径）。
- 日志：同目录 `01-tsc.log` … `12-doctor-sidecar.log`、`tower16-final.log`、`tower8-final.log`、`mutations-final.log`、`review-conditions-tests.log`。
- 分报告：`cad-r12-p1.md`（导出）、`cad-r12-p2.md`（回读与门禁）、`cad-r12-c7-fix.md`（同口径/realpath/容差）、`cad-r12-rereview.md`（P1 复核 + M7 分歧）、`cad-r12-acceptance.md`（终验原始记录）。
- 这几份文档**不在 `KB_DOC_FILES`**（13 份）→ 改它们**不需要** `kb:build`；改那 13 份中的任一份必须重建，否则 `test/agent/kb-freshness.test.mjs` 会红。
