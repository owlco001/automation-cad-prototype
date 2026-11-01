# 更新日志

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [0.5.1] - 2026-11-01

### Fixed · 联动调试（3D 步序播放）

- 播放改为单例控制器：切机型卡片、重绘消息区、关闭抽屉（× 按钮 / Esc / 再点工具栏入口）都会先取消上一轮播放，不再出现「面板已经关了、3D 里的机器还在动」而按钮整段 disabled、用户无从停止的情况。
- 相邻帧之间按 `min(300ms, 帧间隔)` 做线性插值（`offsets` 与 `rotZDeg` 同步），末帧精确落在目标位姿；短步长不再瞬移。
- 播放回调抛错不再把单例卡死（停止播放并释放单例，可立即重新开播），错误经 `onError` 上报，不吞。

### Fixed · 布尔复核（B-Rep 复核链路）

- Sidecar 的错误信息统一脱敏：token 原文、base64/base64url 变体、≥6 字符前缀、`Authorization` 头名与长随机串都会被抹掉。此前 `payload.message` 没过脱敏，sidecar 回显请求头时 token 会原样进入 CI 日志、`case.json` 与 Qt 弹窗。
- 401/403 文案点名 `FT_BUILD_TOKEN` 并给出「核对 sidecar `--token`」的可操作提示；非 JSON 响应报出「含 HTTP 状态 + 脱敏摘要」的可读错误，不再是裸 `SyntaxError`；JSON 合法但不是对象时文案改为「响应不是预期的 JSON 对象」。
- 中途失败不再丢弃已完成的对：`available:false` 也按已完成结果计数，CLI 以 `BOOLEAN_RECHECK_PARTIAL` 打印已完成明细后再以退出码 1 结束（退出码语义不变）。

### Fixed · Windows Qt 打包（CI）

- `windeployqt` 不再剔除 VC++ 运行时，并在打包后校验 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` 真的落地，缺一个直接失败。
- 第三方运行库 `tbb12` / `tbbmalloc` / `freetype` / `zlib` / `libpng16` 真实 `Copy-Item` 进产物目录并回验（原来只 `Write-Host` 打印，纯净 Windows 机启动会 `0xc0000135`）；`freetype` / `libpng16` / `zlib` 缺失直接失败。
- OCCT 8.0 的 STEP 库名改为兼容 `TKXDESTEP` / `TKDESTEP` / `TKDE` 与 7.x 的 `TKSTEP*`，且一个都没命中就失败（原来按 7.7 旧名匹配 + `Test-Path` 静默跳过，打出的包可能没有 STEP 读写库）。
- 核心 OCCT 白名单缺任一库即失败；补上 `qt-client` 显式链接的 `TKSTL` / `TKDESTL`。

### Changed · 排布求解器

- 阻尼求解器接线尝试经审查后回滚，未合入：该版采纳判据把「未声明重叠」按 1:1 折成间距缺口，收益全部来自拿重叠换间距（改回硬约束后六工位 5 个阈值输出逐位退回原位），活锁只是换了个零件。阈值口径与重启门槛已写入 `docs/desktop/BACKLOG.md`。

## [0.5.0] - 2026-10-27

### Added · 缓存机台与 Qt 原生客户端（2026-10-29）

- `build_machine_model` 增加 `brief` 参数：一句中文需求（"立体缓存机台：3 层缓存、每层 4 个储位，线体长 3000mm、带宽 1200mm、层间距 400mm"）直接出整机。`detectBufferLayers()` 用负向后顾读层数，避免"12 层"被读成 2 层。
- 立体缓存机型：`layers ≥ 2` 时按层生成托条/托板/传动辊/挡停/到位光电，外加一套升降机构，不再把缓存机台画成单层输送线。
- 工程自动入库：`build_machine_model` 成功后写 `userData/projects/<id>/`（`project.json` + `model.step` + `model.stl` + 逐件 `parts/NN-*.stl`），CAD 顶栏下拉可直接重开。
- Qt 原生客户端接上 OCCT AIS 视口（MSVC 2022 + Qt 6.8.3 + OCCT 7.9.3），README 补了 Windows 安装/构建/运行全过程，含 `occt --no-deps` 与运行时 DLL 两个坑。

### Fixed · 缓存机台整机

- 装配实体上限 50 → 200，单次布尔仍按 50 分块（`MAX_ASSEMBLY_CHUNK`），3 层 56 件不再被拦。
- 内核建模超时 30s → 180s，渲染桥对 `buildMachineModel` 单独给 240s 预算（原来 10s 直接判 `RENDERER_TIMEOUT`）。
- 参数脏值（`11-128` 这类）只保留有限数字；存工程时带上场景可信质量；内核冷启动健康检查 3s → 90s；STL 导出用 mkstemp 避免 Windows 返回 0 字节。

### Fixed · Qt 客户端

- 加载几何崩溃 `0xC0000005`：`loadFromUrl` 的 lambda 读成员 `m_pending` 而不是连接时的 reply，两次请求交错时拿到未结束的新 reply，旧 reply 成了野指针。改为捕获 reply + 同 URL 去重、换 URL 排队（顺带解决 `abort()` 同步发信号导致的挂死）。
- 视口纯黑：Windows 上 `Aspect_NeutralWindow` 建不出 GL 上下文，改用 `WNT_Window`；Qt 侧让出绘制权（`WA_PaintOnScreen` + `paintEngine()` 返回 `nullptr`），否则 backing store 会盖掉 GL 画面。
- 自检/CI 挂死：offscreen 平台没有 HWND，改走 STL 视口；`watch.mjs` / `sse.mjs` 在 Windows 上不再强制 offscreen。


### Added · CI 与文档守卫

- 新增 `.github/workflows/ci.yml`（push main + pull_request）：`npm ci` → `tsc --noEmit` → `npm test` → `packs:validate` → `eval:agent` → `agent:report`。此前只有一个手动触发的 windows-build，PR 合并前没有自动验证。
- 新增 `test/agent/tool-count-doc.test.mjs`：工具注册表必须与 READ_ONLY/WRITE 分类一一对应，且 README / NL-AGENT / MODULE.md / router 注释里的工具数量、README 工具清单必须一致。
- 新增 `test/agent/kb-freshness.test.mjs`：现场重建知识索引并与提交版逐块比对，改文档忘记 `npm run kb:build` 会直接失败。

### Fixed · 离线规则路由

- `build_canvas_assembly` / `save_scene_as_project` 之前既没有离线规则也没有评估用例，`npm run eval:agent` 一直是红的。补规则（必须写在意图门与 `build_machine_model` 之前）+ generate 意图词 + 2 条用例，评估集 109 → 111 条，`accuracy/tools/refused` 全 1.00。

### Fixed · 机型四张截图其实是同一张首页

- 症状：15/16/17/18 字节完全相同，而 DOM 断言全过。真因是流程从首页开始、始终没离开首页（在首页遮罩下操作）。
- 修法：流程开头先点 `.home-link` 离开首页；抓图改走 `ffmpeg -f x11grab` 抓 X 服务器像素（`capture-machine-screenshots.mjs` 提供 `/shot` 旁路，主进程传窗口矩形与 `XAUTHORITY`）；保留 sha256 去重守卫。
- 结果：四张图各不相同（344,689 / 377,971 / 135,247 / 125,528 字节，色数 6,893 / 12,036 / 2,871 / 3,032）。

### Fixed · 工程视图只保留一套零件列表

- CAD 覆盖层打开时隐藏经典结构树（`body.cad-overlay-open`），关闭后恢复，避免两处搜索来回切。

### Fixed · 文档数字与真实注册表对齐

- 工具数 22/21 → **25（只读 12 + 写 13）**；README 工具集补上漏掉的 3 个工具；kb chunks 354 → 348。


### Added · 整机设计五步向导（`desktop/src/design/`）

需求解析 → 3 套候选方案对比 → 工位与元件 → 毫米级布局 → 选型/干涉校核并保存工程；顶栏「整机设计」与文件菜单「新建设计」入口，草稿可续（`userData/design-draft.json`）。smoke：`SMOKE_DESIGN_ENTRY_OK` / `_WIZARD_OK` / `_CANDIDATES_OK` / `_LAYOUT_OK` / `_SAVE_OK`。

### Fixed · 降级渲染路径的零件计数

`CadViewer.getSceneParts()` 在无 three 网格（软件渲染/WebGL 降级）时回退 `modelParts`，修「保存工程后 `__AgentBridge.getScene().parts` 为 0」——Agent 的 `get_bom` / `get_project_context` 不再把已打开工程当空；smoke 不再打 `SMOKE_DESIGN_SCENE_BRIDGE_WARN`。

### Fixed · 评估集覆盖与知识索引

- `docs/desktop/eval/cases.json` 补 `build_machine_model` 用例（bm01/bm02），评估集 102 → 109 条，`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- `MODULES.md` 迭代明细压成能力目录后重建 `kb.json`（390185 → 383228 B，恢复 5% 余量），修 `kb.json 与源文件标题 hash 同步` 用例。

## [0.4.9] - 2026-10-25

### Added · 电气出图引擎（模型 → ERC → 拓扑布局 → 渲染）

不再为某台机器手写绘图函数，也不再"画完再肉眼检查"：

- `elec/circuit.ts`：电路模型（元件 + 引脚 + 网络）与 **ERC** 规则——引脚悬空/多网、相间短接、电机无热继、热继常闭不在线圈回路、线圈无驱动/无停止、24V 无熔断、传感器三线缺相、PLC 的 L+/M 未供电。线圈驱动用**网络回溯**判定（从 +24V 走到线圈 A1，路径上是否真有常开/常闭），不按位号猜。
- `elec/machine-circuit.ts`：机型描述 → 电路，机型无关（电机 + 传感 + 起停 + PLC IO）；换机器只换参数。
- `elec/layout.ts`：**拓扑驱动的梯形布局**——从 +24V 沿网络走，同一网络多条支路通向同一后继网络就画成并联（上下两行），其余串联；行宽超限自动换行；最后两两重叠检测 + 图框越界检测。
- `elec/sheet.ts`：渲染 A3 单页（图框、三相主回路、控制梯形、PLC/传感器/指示灯接线、元件表、标题栏）；**ERC 有 error 或布局有重叠时，图上直接打出问题清单，`deliverable=false`**，不再输出一张"看起来完整"的图。
- CAD 视图点「电气」→ 引擎出图 → `ElecDomain.setSchematic()` 注入；不可交付时同时弹提示。
- 删除了上一版只服务输送机的 `conveyorControlSVG`/`applyMachine` 分支，shell 只负责显示。
- 测试 +7（`elec/engine.test.mjs`：三相不短接、ERC 能抓漏驱动/漏热继/传感器缺电、布局零重叠、元件变多自动换行、deliverable 判定、转义）。

### Fixed · 电气图按 EL-001 的绘制函数参数化（此前自绘方框图不合理）

第一版电气图是我自己拼的 SVG（方框代符号、导线直连），审查后确认不合规，改为**复用 EL-001 的绘制代码**、只把数据参数化：

- `MACHINE` 参数对象：QF1/KM1/FR1 型号、电机功率、工程名、图号、页码、元件表行；`ElecDomain.applyMachine()` 换数据后重绘同一套符号。
- 主回路按 EL-001 原样：三极断路器带机械联动虚线 + 端子号 1/2·3/4·5/6，接触器主触头、热继双金属符号、电机圆内星点（不再用横跨三相的母线，那是三相短接）。
- 控制回路改成正确的起保停：`+24V → FU1 → SB1(NC) → SB3(NC) → [SB2(NO) ∥ KM1 辅助 13/14] → FR1 95/96 → KM1 线圈 → 0V`；自锁改用 KM1 自身辅助触点（原来的 KA1 只有触点没有线圈，逻辑不成立），FR1 的 95/96 已串入线圈回路（原来过载切不断）。
- 补齐此前缺的：FU1 熔断器符号、PLC 的 L+ 与 M 供电、光电三线制（棕 +24V / 蓝 0V / 黑 DI）、HL1 灯符号与 Q0.0 接线、PLC 型号改为 CPU 1214C。
- 热继选型加 0.1–0.16 A 等小电流档，整定值夹到所选档范围内（原来 0.04 kW 会选 0.63–1 A 档却标 0.1 A 整定，自相矛盾）。
- 元件明细表行数自适应压缩，不再把最后一行裁掉（FU1 曾因此在表里消失）。
- 测试：`elec/protection.test.mjs` 8 条（含整定值落在档位区间、取消 KA1、保留 FU1）。

### Added · 电气原理图由工程 BOM 生成（不再固定示例柜）

- 新增 `src/elec/schematic.ts`：按驱动功率与传感器清单生成 A3 单页原理图——主回路（L1/L2/L3 → QF1 → KM1 → FR1 → M1 + PE）、控制回路（24V/0V、急停/启动/停止、KA1 自锁、KM1 线圈、传感输入）、IO 点位表、元件表、标题栏；断路器/接触器/热继按电流档位选型，估算项在元件表里打 `*`。
- 从 CAD 视图点「电气」时先出图再切域：驱动用 `estimateConveyorDrive`（阻力/功率/扭矩同一套公式），转速按 `n = 60v/(πD)`，传感器从零件清单里的光电支架推。
- 电气域 `ElecDomain.setSchematic()` 替换 `#elSheet` 并把页浏览器、页属性（图号 EL-CV-001 / 来源=工程名）同步过来；示例的 12 页目录不再冒充。
- 修 SVG 可见性：图框/器件框原先误用 `.if`（实心填充），整张纸被刷黑；改为描边。
- 测试 +6（选型档位、图纸含位号不含示例、IO 地址唯一、元件表完整性、无急停机型、注入转义）。

### Fixed · 选工程后应直接进 CAD 视图，且 CAD 视图能回到电气侧

- 选工程成功后强制把 CAD 覆盖层推到前台（`AutomationCadProjects.show()`），不再停在外壳的演示画布。
- 外壳的演示 3D（示例滑台气缸）被工程卡片替换：工程名 / 零件数 / 总质量 / 包络 / 保存时间 + 「在 CAD 视图中打开」；左侧结构树换成该工程的 29 件零件清单，避免"选了输送机还是气缸"。
- 覆盖层顶栏新增「机械 / 电气」域切换：原先是全屏覆盖层，电气的入口被挡死。点「电气」→ 关闭覆盖层 → `ElecDomain.setDomain('elec')` → 派发 `automation-cad-domain` 事件把当前工程带过去（外壳状态栏显示「已切到电气域 · 上下文：…」）。
- 已知未打通：电气侧原理图仍是示例柜（滑台气缸控制柜），没有按输送机 BOM/IO 重新生成——下一步要做 BOM→IO→原理图的联动，而不是只切工作区。

### Added · 工程库：顶栏「文件」下拉列出已保存整机，生成即可重开

- 主进程新增 `electron/projects.ts`：一个工程 = `userData/projects/<id>/`（`project.json` + `model.step` + `model.stl` + `parts/NN-*.stl`），同名覆盖不堆副本，名字里的路径字符会被清理，损坏的 `project.json` 不会冒充工程。
- IPC 与 preload 暴露 `projects.list/save/open/remove`（4 个未签名接口不进智能体工具面）。
- **`build_machine_model` 生成后自动存成工程**：整机出现在外壳顶栏文件名右侧的下拉里（`已保存工程 · N`，带零件数/质量/包络/时间），点一下就用逐件 STL 重新装配回视口，零件树与干涉检查照旧可用。
- 外壳 `app.js` 的 `#fileBtn` 原本只弹一句 `toast('文件：新建 / 打开 / 另存为 / 导出')`，现在接成真实菜单；CAD 覆盖层顶栏也加了同一个下拉。
- 测试 +8（工程库：保存/覆盖/清理残留/重新打开/名字逃逸/损坏文件/倒序/删除），全量 1930/1926/0/4。

### Added · 通用整机建模工具 `build_machine_model` + `MODEL_BUILDERS` 注册表

- **工具与机型解耦**：智能体只有一个 `build_machine_model`，机型由 `machine/model-builders.ts` 的注册表分派；新增链板线/滚筒线/转盘机只加一条映射，不新增工具。
- **内核逐件导出**：`/build` 新增 `perPart`，装配体按件导出 STL 并回传每件体积、包围盒（体积/质量来自内核，不估算）。2.4 m 输送线实测 29 件、STEP 917 KB、STL 747 KB。
- **零件树**：逐件 STL 经 `parseStandardCadBuffers` 合并成一个导入结果，视口里是 29 个独立零件（可选中、可做干涉检查、可标运动学），而不是一个合并网格。
- 参数校验：未知键回传、越界夹紧并写 `warnings`、非数字直接拒绝；没有参数化构建器的工艺显式返回 `NO_PARAMETRIC_BUILDER` 并指路 `apply_machine_design`，不伪造模型。
- `describeScene()` 增加 `batches`（实例化批次）与 `hiddenParts`：零件被合并进 InstancedMesh 时原始 mesh 会隐藏，避免再次误判成"模型不见了"。
- **干涉检查在真实零件上跑通**，并据此修掉四处布局碰撞（都有回归测试）：横撑插端板 153600 mm³、横撑穿回程皮带 64000 mm³、滚筒埋端板 47985 mm³、电机箱压纵梁 128000 mm³；剩 30 条是"横撑进纵梁""滑座跨纵梁"这类结构连接处的包围盒假阳性，需要实体级检测才能进一步区分。
- 实测（2.4 m×400 mm）：29 件 / 5 个实体 / 包络 2450×670×930 / 85.41 kg / BOM 15 行。

### Fixed · 3D 视口「模型看不见 / 只剩线框」

- **视锥平面提取错误**：`viewer.ts` 的 Gribb–Hartmann 提取把近、左平面都直接写成 `row3`，远平面写成 `-row2`，没有做行加减，得到一个畸形的视锥；结果整机被判为「视锥外」，被 `applyRenderOps` 设成 `visible=false`，屏幕上只剩包围盒的青色边线，看起来就是"线框模型"。改为标准公式（left=row3+row0 … far=row3−row2），并抽成纯函数 `frustumPlanesFromClipElements` + 6 条单测（相机背后、near/far 之外、横向偏出、大球相交、平面归一化与互异）。
- 修复后同一台 2 m 皮带输送机：覆盖率 0.729、LOD0、14,904 三角面全部进入渲染计划，实体正常着色显示。
- **新增渲染诊断** `window.AutomationCadViewer.describeScene()`：返回线框开关、材质（color/opacity/金属度/法向）、光照、相机、以及**最近一帧渲染计划**（哪些零件被剔除、覆盖率、LOD、包围球），以后这类"看不见"的问题不用再靠截图猜。同时暴露 `toggleWireframe()`。

## [0.4.8] - 2026-10-25

### Added · 输送机（工艺 + 真实几何）

- **工艺与形态**：`MachineProcess` 新增 `conveyor`；需求解析认「输送机/输送线/皮带线/传送带」，并抽取总长/带宽/线速/工件重量（支持 2m、250mm/s 等单位）；新增形态 `belt-line`（单线体、1 工位）与工艺模板（驱动滚筒按旋转轴 + 进出料光电×2）。
- **节拍与功率按输送线算**：产能 = 线速 ÷ 工件间距（0.2 m/s、间距 300 mm → 40 件/分），驱动功率 = (摩擦 + 加速) × 线速 ÷ 效率，按 2 倍余量选标准档（5 kg 工件、0.2 m/s → 40 W，扭矩 1 N·m）；公式写进 assumptions，目标节拍高于线速时给出提速建议。
- **BOM 结构件**：把通用模型的「旋转轴」占位替换为输送线体、减速电机、张紧滑座、可调地脚；左右件合并成一行。
- **真实几何走内核**：新增 `conveyor-assembly.ts` 生成 28 个零件（纵梁/横撑/支腿/地脚/端板/滚筒/皮带/挡边/减速电机/张紧/光电）的参数化装配，交给 build123d 布尔求并，导出 STEP/STL 并载入视口。2 m × 300 mm 实测：28 件 → 5 实体、14,904 面、STEP 882 KB、整机 71.1 kg。

### Fixed · 参数化内核

- **横轴圆柱**：`cylinder` 操作支持 `axis: x|y|z`（滚筒、螺杆这类横轴零件原来只能竖着建）。
- **回转体起手**：`cylinder` 可作为零件的第一个操作（原来必须先有实体，销轴/滚筒无法单独建）。
- **解释器选择**：打包版只认 PATH 上的 python，而 build123d 常装在 venv 里 → 内核报 `No module named 'build123d'`。现在会扫描 PATH 与常见 venv，并且**实际 import 一次**验证（有个 venv 装了 build123d 但 Pillow 坏了，只看目录会选错）。

## [0.4.7] - 2026-10-25

### Added · 装配 / 图纸

- **标准件可视化装配**：顶部「装配」入口，从 617 件库里拖标准件进 3D，松手贴合命中面并沿法向对齐；代理体尺寸由 `specs` 解析（导轨/丝杠/气缸/减速机/型材…），解析不到的字段标「估」并染橙色。`window.AutomationCadAssembly` 暴露 state/placeAt/remove/clear。
- **DXF / DWG 图纸**：顶部「图纸」入口，DXF 直读（LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE/ELLIPSE/SPLINE/INSERT 递归展开），DWG 经 LibreDWG WASM 转 DXF 后同样渲染成 Z=0 线框底图；相机 near/far 按图纸尺度放宽（默认 far=100m，公里级图纸会被裁掉）。打开对话框、拖放、agent `importPath` 三条入口都已路由。
- **DWG 转换器随包分发**：`resources/dwg/libredwg-web`（GPL-3.0），见 `THIRD-PARTY-NOTICES.md`；没有转换器时给出 ODA / dwg2dxf / 另存 DXF 三条可执行路径。

### Changed · 智能体

- **单轮工具调用上限可配置**：原先硬编码 12 次，设计类任务（查库 → 核算 → BOM → 成本 → 导出）在关键步骤前就被 `TOO_MANY_TOOL_CALLS` 掐断，模型只能交半成品。现在 `agent-llm.json` 支持 `maxToolCalls`（1~200，默认 24），实测 30 次时一轮跑满 15 次调用无拒绝，只读工具去重仍生效。

### Fixed · PLC

- **只读点位可写**：`manager.write` 原先不校验点位，写输入区（discrete/input）会被仿真器接受、被 Modbus 从站忽略，调用方却以为写成功。现在返回 `READ_ONLY_POINT` / `POINT_NOT_FOUND`；`force` 仍允许强制输入区（现场调试），但点位必须存在。
- 新增 3 条 manager 测试（只读区、不存在点位、强制输入区）。

## [0.4.6] - 2026-10-25

### Fixed · 3D 视口交互（真机连续反馈）

- **点击选中失效**：0.4.3 引入的 window 级 `pointerup` 兜底在捕获阶段先清掉了按下状态，画布自身的抬起处理拿不到，点击判定直接 return（悬停高亮走 `pointermove`，所以只有点击坏）。改为只清理画布外的残留状态。
- **点击后滚轮失效 / 不按键也跟动**：OrbitControls 把"正在拖动"记在私有 state，`onMouseWheel` 与 `onPointerDown` 遇到 `state !== NONE` 都直接 return。一旦漏掉一次 `pointerup`，滚轮缩放与新的按下全部失效、移动鼠标却继续旋转。现在在每轮抬起事件派发结束后检查：若仍处于拖动中即判定漏事件，结束拖动并重建控制器（相机与 target 保持不变）；窗口失焦、指针在画布外移动时同样自愈。
- **3D 画布不再被外部框选抢指针**：原型的框选绑定会在父元素 `#stageAssembly` 上 `setPointerCapture`，与画布上的 OrbitControls 争抢同一个指针；现在 3D 画布及其内部元素一律不接管。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1849 总计 / 1845 通过 / 0 失败 / 4 跳过**。
- 点击选中在 dev 实例经 CDP 实测：点击不同位置分别选中 `CYL-032-050` / `CAR-32` / `BASE-01`。

## [0.4.3] - 2026-10-25

### Fixed · 拖动交互"不跟手"（真机反馈）

- **拖动状态永久卡死**：`endDrag()` 把 `dragging = false` 放在 200 ms 定时器里，pointerup 一旦没落到当前 canvas（拖动中重建渲染器就会换掉 canvas），状态永不落地 —— 表现为**按住拖动没反应、松手后画面才跟着走**，且像素比永久停在 0.8 拖动档（实测 `drawingBuffer/CSS = 0.799` 长期不变）。现在 `endDrag()` 同步落下状态，定时器只负责质量回升。
- **指针抬起兜底**：新增 window 级 `pointerup` / `pointercancel` / `blur` 监听与 `setPointerCapture`，画布外抬起、系统取消、窗口失焦都能正常结束拖动；`beginDrag()` 遇到上一次未收敛的状态先自愈。
- **拖动中不再重建渲染器**：`rebuildRenderer()` 在拖动期间直接返回，避免换 canvas 丢掉 OrbitControls 的指针状态。
- **渲染队列看门狗**：页面被遮挡/最小化时 rAF 不触发，`renderQueued` 会永久为 true，之后所有渲染请求被丢弃（画面像卡住）。超过 500 ms 视为失效帧，允许后续请求重新排队。

### Fixed · 渲染指标可信度

- 拖动帧统计只在**窗口可见且间隔 ≤250 ms** 时计入，遮挡/最小化/系统挂起造成的数秒空档单独记 `dragDroppedFrames`；`<5` 帧时明确输出「样本不足，不下帧率结论」。此前会把正常画面报成「平均 7813.9 ms/帧，拖动会明显不跟手」。

### Fixed · 顶部入口抽屉

- 工厂 / 联调 / 数据包 / 成本估算 / 模块设置等入口原先**可同时打开并全部叠在同一位置**（实测 4 个同时可见，且点同一入口不会关闭）。现在抽屉互斥打开，同一入口再点一次收起。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1847 总计 / 1843 通过 / 0 失败 / 4 跳过**（`0600` 权限断言，Windows 无 POSIX 位）。
- 抽屉行为在 dev 实例经 CDP 实测：连续切换 8 次，每次都只保留 1 个抽屉。
- `npm run smoke:win`：`SMOKE_OK`，退出码 0。

## [0.4.2] - 2026-10-25

### Fixed · 联机调试与渲染可观测性

- **CDP 内网可达**：Electron 会忽略 `--remote-debugging-address=0.0.0.0`，实际只绑回环。改为普通启动常驻 `127.0.0.1:9229`，白名单开关命中来源后再由 `cdp-forwarder` 转发到 `0.0.0.0:9222`；未命中来源返回拒绝并写审计 `cdp_access_check`。支持运行中热启停，不必重启进程。
- **token 生命周期**：启动复用已有 token（原实现每次启动重写，重启一次就得重新取 token）；文件损坏时重建；面板提供显式「重新生成」，旧 token 立即失效。
- **渲染指标**：新增 `get_render_stats` 只读工具（工具数 21 → 22），暴露渲染器字符串、是否软件渲染、像素比、质量档、零件/三角面数与拖动帧时间（均值/峰值/时间戳），同一份数据进 `/health.render`；检测到 SwiftShader 等软件渲染时自动降到 `flow` 档。

### Added · 跨平台验证

- `npm run smoke:win` / `npm run diagnose:win`：Windows 本地 headless 入口（关闭 GPU 走 SwiftShader），使「无 WebGL 降级面板」这条断言在 Windows 开发机上也能被真实覆盖；README 补对应说明。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1842 总计 / 1838 通过 / 0 失败 / 4 跳过**（4 条是 `0600` 文件权限断言，Windows 无 POSIX 位；Linux 上为 1842/1842）；`build:ext` 通过。
- Windows 实跑 `npm run smoke:win`：**85 条 `SMOKE_*_OK` + `SMOKE_OK`**，退出码 0；`SMOKE_RENDER_STATS_OK gl="ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" parts=11 triangles=4832 quality=flow`，拖动平均 42 ms/帧。

## [0.4.1] - 2026-10-25

### Added · 桌面可用性

- **界面缩放**：智能体面板新增 6 档缩放（100%–150%），默认 **115%**（原 UI 偏小）；注入式 `html { zoom }` 实现，不改根目录原型样式；切换即生效并联动 3D 视口 resize；持久化 `userData/appearance.json`。
- **3D 渲染质量**：`flow / standard / high` 三档（像素比上限 1.0 / 1.5 / 2.0）；拖动旋转期间固定降采样到 0.8、松手 200 ms 恢复；启用 `powerPreference: high-performance`；零件数 > 1500 自动降级为 flow。
- **局域网联调（默认关闭）**：开关打开后 Agent JSON-RPC 绑 `0.0.0.0:7420`，来源必须先过 CIDR/单 IP 白名单再看 Bearer token，未命中返回 403 `LAN_NOT_ALLOWED` 并写审计；远程写操作仍弹本机确认框；`/health` 不返回 token。
- **远程调试 CDP（默认关闭）**：开关打开后下次启动监听 `0.0.0.0:9222`，面板显示端口、需重启状态与高风险警告。
- **联调探测脚本** `desktop/scripts/lan-debug-probe.mjs`：依次校验 `/health`、`tools/list` 与只读 `list_components`，成功输出 `LAN_DEBUG_OK`。

### Verification

- `npx tsc --noEmit` 0 错误；`npm test` **1831/1831**；`build:ext` 通过；`SMOKE_OK`（含 `SMOKE_UI_SCALE_OK` / `SMOKE_RENDER_QUALITY_OK` / `SMOKE_LAN_SWITCH_OK` / `SMOKE_LAN_ALLOWLIST_OK`）；`EVAL_AGENT_OK 1.00`。

## [0.4.0] - 2026-10-25

> 已发布：GitHub Release `v0.4.0`，Windows 安装包 `AutomationCAD-Setup-0.4.0.exe`（NSIS，未签名，约 130 MB），由 `windows-build` 在 `windows-latest` 上构建（1810 单测 / 0 失败）。

### Added · 可选模块门控与工程安全（PR #9）

- **模块 registry + 运行时启停**：8 个可选模块（`cost.estimation`、`elec.validation`、`plcgen`、`parametric.import`、`factory.plc-sync`、`agent.resume`、`project.portable`、`system.update`）统一注册，默认全启用；门控只隐藏/禁用对应入口与 Agent 工具，不卸载代码。`ipcMain.on('modules:sync-*')` 同步通道在 `createWindow()` 之前注册。
- **工程档案（project archive）**：`.acproj` v2 打包/预览/导入，导入走临时目录 + 校验 + 原子替换。
- **CAD 导入事务回滚**：导入失败回滚到导入前状态，不留半成品装配体。
- **更新通道**：`update-service` 支持 `latest.yml` + blockmap 的检查/下载/安装路径（未做真实签名与跨版本升级验收）。
- **PLC 校验补强**：数值范围与空序列校验，空序列不再生成空程序。
- 107 个文件、+11693/−442。

### Security

- **Agent IPC 传输安全（PR #6）**：所有 `ipcMain.handle` 走可信 sender 校验（`isTrustedIpcSender`），渲染层 URL 白名单（`isTrustedUiUrl`），MCP/RPC 写操作统一授权（`authorizeAgentToolCall`），API Key 传输策略 `assertSafeApiKeyUrl` 泛内网段放行 HTTP（10/8、172.16/12、192.168/16、169.254、IPv6 ULA/链路本地），仅公网强制 HTTPS。
- 设计包同步限制单包体积（`MAX_DESIGN_PACKAGE_BYTES`），`.acproj` 导入做路径穿越与大小校验。

### Added · 机型设计与元件库（迭代 37–48）

- 整机形态库扩到 **11 种**（工艺 × 布局 × 机型），选型优先级为「工位覆盖 → 产能达标 → 工艺适配 → 布局偏好（仅同分）→ 占地」，候选产能夹紧到自身工位范围，禁止越界形态凭虚高吞吐入选。
- 统一功率/成本模型：按实际选型额定功率 × 同时系数 0.7 / 负载率 0.6 / 效率 0.9 / cosφ 0.9 计算 kW、VA、计算电流、断路器建议与 24V 余量；成本分项与缺价计数进入方案卡。
- 元件库扩到 **9 个内置包 / 617 型号**（新增 `vision-cn`、`drive-cn`、`safety-cn`、`frame-cn`），保留按需懒加载：启动只读 manifest，命中包才读 `parts.json`，`partsSha256` 校验完整性。
- 价格簿扩到真实分销价条目，案例 BOM 覆盖率提升；缺价项照实计入「待询价」，示例价自动排除。

### Fixed

- **Windows CRLF 检出不误判 integrity**：Windows runner 的 `core.autocrlf=true` 会把 `packs/builtin/*/parts.json` 检出为 CRLF，而 `manifest.partsSha256` 按 LF 计算，导致 `PACK_INTEGRITY_FAILED` 使全部内置包加载失败（CI 18 个用例红）。`assertPartsIntegrity` 与 `scripts/pack-stats.mjs` 统一 `CRLF→LF` 后再取 SHA-256，并新增根目录 `.gitattributes` 对文本文件强制 `eol=lf`；新增回归用例覆盖 CRLF 字符串与 Buffer（`ba5787a`）。

## [0.3.0] - 2026-10-23

> 已发布：GitHub Release `v0.3.0`，Windows 安装包 `AutomationCAD-Setup-0.3.0.exe`（NSIS，未签名，129 MB），由 `windows-build` 手动触发在 `windows-latest` 上构建（1248 单测 / 0 失败）。

> 说明：能力条目均附真实提交号；本次发版追加的整机 3D 能力见下方「Added · 整机 3D」。

### Added · 整机 3D（迭代 34–36，PR #4）

- 机型方案生成参数化整机几何：`machine/geometry.ts` 由 `MachineConfig` 生成 mm 级整机（机架、工位、气缸、夹爪、转台、传感器、光栅、输送线）与运动轴元数据，导出 STL / glTF / build123d sidecar 清单，STEP 由内核实体化（`bd5adc1`）。
- 主视图可旋转 three.js 3D：`src/orbit/` 注入扩展提供旋转/缩放/平移、六向标准视图、透视↔正交、剖切、树↔3D 双向选择与属性实时改几何，无 WebGL 时回退原型 SVG，原型 `index.html` / `app.js` / `styles.css` 零改动（`5fb16f9`）。
- STEP 装配体运动件自动识别：按零件名/型号、装配层级与几何推断轴向、行程、置信度与中文理由，只出建议、逐条采纳才写标注（`bcef010`）。
- Agent 只读工具 `suggest_kinematics`（工具数 20 → 21），命令 → 渲染桥 → 标注抽屉，`applied=false` 从不写标注（`310f164`）。
- KB 容量治理：BACKLOG 历史归档不入索引，`kb.json` 约 408 KB → 363 KB，新增「索引留 ≥5% 余量」守卫（`310f164`）。

### Fixed · 合并前复查

- STEP 实体化把水平圆柱按等截面方棒近似时写中文 warning 点名零件并透出 `approximatedIds`；`solids/` 上一次遗留的 `part-N.step` 先入撤销快照再清理（`192983e`）。
- Windows CI 上 4 条平台脆弱断言（文件名时间戳写死 `+08:00`、`/tmp` 路径、sidecar 脚本分隔符正则）改为时区/分隔符无关（`823caf4`）。

### Added

- 电气元件库扩展至 371 型号 / 26 分类，并补充 191 个可核实的真实外形尺寸与导轨 / 模数信息（`e6f354f`、`31530ac`、`acca35a`、`9e9cabd`、`d8e12c5`、`d5713b6`、`337559b`、`7cc1e86`、`cb9c5d3`、`8729688`）。
- 电箱底板真实尺寸画布：毫米坐标、1 mm 吸附、35 mm 导轨、重叠标红、利用率统计、JSON 导出（`df8f1a2`、`b4bf1a1`）。
- 电气合规校验：线号合规、功率统计、导线截面与断路器配合校验，配套 9 卡面板、A3 PDF 报告与 Agent 工具 `run_electrical_check`（`5352832`、`652e031`）。
- STEP 运动学标注：动件 / 轴类型 / 方向 / 行程 / 缩回位 / IO 点位绑定，中文校验、姿态解算、滑块预览与 JSON 导入导出（`8d5835d`、`b0e6df3`）。
- 3D 联调新增故障诊断规则与诊断面板（`e1e02c9`）。
- 成本统计闭环：价格簿与纯函数引擎（`a8c1e5f`）、成本面板与 A4 / CSV 报告（`6d70ae7`）、Agent 工具 `run_cost_report`（`a66b26e`）与 `export_cost_report`（`23cd284`）。
- 自然语言 Agent：离线规则路由、上下文裁剪、NDJSON 审计（`424711c`）、侧栏只读问答与审计面板（`b3b9aee`）、底板放置 `place_component` 与撤销联动（`1c356e9`）、离线多步规划与计划卡片执行（`e70ef77`）、46 条中文评估集（`cb3cc93`）。
- PLC 程序自动生成：预检、IO 变量表、五个基础 ST 块（`b36635b`）、自动序列 / 报警 / 安全 FC 与 11 文件汇总（`ccbd0fc`）、生成 UI / 文件树 / zip 导出 / 最近 10 次历史（`1f50bac`）、内置模拟器执行联调序列与 Agent 工具 `verify_plc_program`（`a6b0534`）。
- 参数化建模：选定 build123d 内核与 sidecar 契约（`5c2a8c3`、`371e6f0`）、主进程生命周期与 IPC（`9eda660`）、特征树 / 参数表单 / 防抖重建 / STEP+STL 导出（`8867853`）、多实体装配与 BOM / 成本联动（`449d060`）。
- CAD 大装配渲染批次层：实例化合批、视锥剔除、LOD 分级与 10 万面基准（`f6962b3`、`71c0e9b`）。
- 原型侧零件插入、约束建议与多步撤销（`7d98af5`）。
- 桌面端 14 张真实 Electron 截图与一键截图脚本（`e409ea8`）。
- 智慧工厂设计同步本地端到端脚本与验证记录（`ce11575`）。

### Changed

- 桌面版本号由 `0.2.0` 升至 `0.3.0`（`desktop/package.json`、`desktop/package-lock.json`；本次发版准备，未提交）。
- 3D 联调由写死零件改为机型配置驱动，并在有运动学标注时优先使用标注（`71b5e18`、`b0e6df3`）。
- Agent 工具注册表由 7 个扩展到 12 个，离线多步计划统一走同一工具注册表（`424711c`、`b3b9aee`、`1c356e9`、`e70ef77`、`a6b0534`）。
- 质量基线由 301 个单测提升到 674 个单测，并补充 PLC 生成、参数化装配、智能体规划等冒烟断言（`b36635b`、`ccbd0fc`、`1f50bac`、`a6b0534`、`8867853`、`449d060`、`e70ef77`）。
- 汇报材料由 18 页扩展到 19 页，补充 PLC 程序生成与参数化建模能力边界（本次发版准备，未提交）。

### Fixed

- 收紧智慧工厂同步字段契约，明确 `deviceId` / `createdAt` / `qty` 的校验口径（`68f5186`）。
- 参数化假内核脚本移出 `test/`，避免被 `node --test` 当作测试执行，并修正 smoke 版本判定（`18c353b`）。

## [0.2.0] - 2026-10-22

- 机械校核 / 导出 / PLC / 联调 / 智慧工厂同步基线版本；NSIS 安装包随 `v0.2.0` 发布（`552fd5a`）。
