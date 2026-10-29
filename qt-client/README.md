# AutomationCAD Qt 客户端（v0.1 壳子，开发中）

状态说明（写给接手的开发者，先读再动手）：

- 本目录是 Qt6 新客户端的起点，不是完成品。布局已按 SolidWorks 式五区搭好：
  左侧 FeatureManager 设计树、顶部菜单 + 特征工具栏、中间 3D 视口占位、
  右侧 PropertyManager 属性面板、底部状态栏。
- 视口目前是占位 QWidget，OCCT AIS Viewer **尚未接入**；不要宣称已实现 3D 拾取/渲染。
- 编译状态（2026-10-28 更新）：Linux + Qt **6.4.2**（`qt6-base-dev`）上已
  `cmake -S . -B build && cmake --build build` **编译通过**，并在 `QT_QPA_PLATFORM=offscreen`
  下启动不崩；CI 里有 `qt-client build` job 持续守着。**Windows 真机仍未编译**。
- 数据契约：见仓库 `docs/featuretree-contract.md`（草案 v0.1）。客户端不持有可独立写回的
  树副本；一切写操作走 `featuretree-service`（默认 `http://127.0.0.1:18080`），
  带 `expectedRevision`，409 冲突时提示重新读取，禁止自动覆盖。

## 本地跑法

1. 启动契约服务（与本客户端同仓的 `../featuretree-service`）：

   ```sh
   cd ../featuretree-service
   node tests.mjs           # 自己拉起服务（FT_PORT=0）跑 18 条验收后关闭
   # 或手工起服务看日志：
   node server.mjs          # 默认 127.0.0.1:18080，仅本地回环
   ```

   注意：服务是**内存态**，重启即回到种子树（revision 0），编辑不留存。

2. 构建客户端（需 Qt6）：

   ```sh
   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
   cmake --build build
   ./build/automationcad-qt
   ```

3. 在客户端里点特征、改属性面板数值，即走一次 `POST /v1/operations`；
   服务端版本 +1 后界面以返回的包络全文刷新。

## 真机界面（1280×800，xvfb + ffmpeg x11grab 抓的实图）

| 图 | 内容 |
| --- | --- |
| `docs/desktop/screenshots/qt-client-01-tree.png` | 启动即读契约服务：树是「文档根 → 零件 → 4 条特征」，状态栏「版本 r0 / 体积 94,166.8 mm³ · 质量 0.7392 kg · 90×90×12 mm」，撤销/重做此时都不可用 |
| `docs/desktop/screenshots/qt-client-02-selected.png` | 选中「90×90×12 板体」，右侧 PropertyManager 列出 length/width/height（白名单可改，其余只读） |
| `docs/desktop/screenshots/qt-client-03-refreshed.png` | 外部客户端把 height 改成 18 后 1.5s 内自动刷新成「版本 r1 / 体积 141,580.0 mm³ / 90×90×18 mm」 |
| `docs/desktop/screenshots/qt-client-04-undo.png` | Ctrl+Z（走服务端 `/v1/undo`）：撤销成功 → 版本 r2，体积回到 94,166.8 mm³、90×90×12，重做按钮变可用 |
| `docs/desktop/screenshots/qt-client-05-redo.png` | Ctrl+Shift+Z（`/v1/redo`）：重做成功 → 版本 r3，体积回到 141,580.0 mm³、90×90×18 |
| `docs/desktop/screenshots/qt-client-06-3d.png` | 真实 3D：视口把服务端 `/v1/geometry.stl`（build123d 导出，6,604 个三角面）画出来，不是占位图 |
| `docs/desktop/screenshots/qt-client-07-3d-rotated.png` | 左键拖动旋转（yaw/pitch），滚轮缩放；旋转后画面确实变了 |
| `docs/desktop/screenshots/qt-client-08-3d-thicker.png` | 外部把板厚改成 30：1.5s 内重下 STL 重绘，状态栏「版本 r1 · 体积 236,406.5 mm³ · 质量 1.8558 kg · 90×90×30」 |
| `docs/desktop/screenshots/qt-client-09-ctxmenu.png` | 特征右键菜单：「压缩 / 解除压缩」「删除特征（可撤销）」，都在服务端校验后执行 |
| `docs/desktop/screenshots/qt-client-16-iso.png` | 默认等轴测视角（视图菜单可选等轴测/正视/俯视/右视/适合视图） |
| `docs/desktop/screenshots/qt-client-17-top.png` | 俯视：8 个孔（4 沉头 + 4 通孔）和四角 R3 一眼可见——视口画的是服务端真几何，不是占位盒 |
| `docs/desktop/screenshots/qt-client-40-pick-nudge.png` | 3D 点选零件后方向键微调：状态栏「已挪 conveyor-frame (10,0,0) · 重叠 2 对」 |
| `docs/desktop/screenshots/qt-client-35-machine-3d.png` | 整机示意 3D：70 个占位体、包络 2140×740×1177（概念估算，不是制造几何） |
| `docs/desktop/screenshots/qt-client-34-brief-machine.png` | 一句话生成：四工位点胶机 → 4 工位 / 3.103 kW / 22,016.79（2 项无价格） |
| `docs/desktop/screenshots/qt-client-31-machine-overview.png` | 整机方案概览：6 工位 / 31.75 件每分 / 达标 / 4.65 kW / 成本 34,489.91（3 项无价格） |
| `docs/desktop/screenshots/qt-client-32-machine-bom.png` | 整机方案 BOM：12 项（含伺服驱动器 SV660P 750 W ×6） |
| `docs/desktop/screenshots/qt-client-33-machine-io.png` | 整机方案 IO：19 点（ST1-PRX-S1 → I0.0 输入 接近开关 工位1） |
| `docs/desktop/screenshots/qt-client-30-bom.png` | 装配清单（Ctrl+B / `--bom-selftest`）：钢 0.7392 kg×1 + 1.8558 kg×2 = 合计 3 件 4.4508 kg，与装配质量 4.4508 kg 对上 |
| `docs/desktop/screenshots/qt-client-29-measure.png` | 点选平面测面积：状态栏「选中平面 · 面积 7770.38 mm²（命中点 -3.27, -22.37, 12.00 mm）」，与手算一致 |
| `docs/desktop/screenshots/qt-client-28-edit-member.png` | 装配里双击成员 → 改 X/Y/Z 偏移与绕 Z 转角 → `PUT /v1/assemblies/{id}`，几何自动重新 fuse |
| `docs/desktop/screenshots/qt-client-27-interference.png` | 「评估 → 装配干涉检查」(Ctrl+I)：真实布尔交集，状态栏/弹窗给出「1 对成员存在实体干涉」与每对的重叠体积 |
| `docs/desktop/screenshots/qt-client-26-assembly.png` | 装配只读视图（文件→打开装配…）：树里 3 个成员带偏移，视口画服务端 fuse 后的合成 STL（19,812 面） |
| `docs/desktop/screenshots/qt-client-20-multidoc.png` | 多文档：工具栏「文档」下拉 + 「新建文档…」；切到 doc-qt-test 时树根显示「doc-qt-test · 版本 r1」，与默认文档互不影响 |
| `docs/desktop/screenshots/qt-client-21-default-doc.png` | 默认文档 demo-adapter（同一份服务、同一个进程） |
| `docs/desktop/screenshots/qt-client-15-new-feature.png` | 「插入 → 新建特征…」(Ctrl+N)：类型/特征 id/名称/参数按类型切换，确定后带 expectedRevision 提交，服务端校验后重建 |
| `docs/desktop/screenshots/qt-client-13-material-menu.png` | 「工具 → 材质」四条（钢/铝/不锈钢/黄铜，密度写在菜单里），当前材质带勾 |
| `docs/desktop/screenshots/qt-client-14-aluminum.png` | 切到铝：体积不变 94,166.8 mm³，质量 0.7392 → **0.2543 kg**（×2.70/7.85），状态栏材料名变「铝」 |
| `docs/desktop/screenshots/qt-client-11-sse.png` | 状态栏右侧「链路：SSE 已连接」——普通启动就走 `/v1/events` 订阅，10s 轮询只做兜底 |
| `docs/desktop/screenshots/qt-client-12-sse-pushed.png` | 外部改板厚 20 后 **138ms** 就推过来（自检实测延迟），版本 r1 / 体积 157,384.4 mm³ / 90×90×20 |
| `docs/desktop/screenshots/qt-client-10-suppressed.png` | 压缩「母件侧沉头孔」后：体积 94,166.8 → 95,966.9 mm³（刚好等于沉头特征去掉的 1,800.1），3D 重下成 2,556 个三角面 |

## 3D 视口说明（为什么不是 OCCT AIS）

视口用 `QOpenGLWidget` + `#version 330 core` 直接画二进制 STL，几何**只在服务端**生成（build123d），
客户端不重算体积/质量/孔位。选这条路的原因是本机 Debian 12/13 混源：
`libocct-data-exchange-dev` / `libocct-visualization-dev` 被 `libfreetype-dev` 版本冲突卡住
（apt 报 held broken packages），运行时库在但拿不到头文件。
`StlViewport::ensureRevision(revision, url)` 这层接口与 OCCT 无关，等 dev 包装得上可以整体换成
`AIS_InteractiveContext`，上层不用改。

## OCCT AIS 视口（有头文件时默认启用）

默认视口是自绘 OpenGL + 服务端 STL；OCCT AIS 视口作为可选项已能编译并渲染。

**为什么之前装不上**：本机 Debian 12/13 混源，`libocct-data-exchange-dev` / `libocct-visualization-dev`
依赖 `libfreetype-dev` 的 12 版，而系统里是 13 版，apt 报 held broken packages。
解法（只取头文件，不动系统 freetype）：

```sh
cd /tmp && mkdir occt && cd occt
apt-get download libocct-visualization-dev libocct-data-exchange-dev
for f in *.deb; do dpkg -x "$f" root; done
cp -r root/usr/include/opencascade /usr/local/include/
cp -a root/usr/lib/x86_64-linux-gnu/*.so /usr/lib/x86_64-linux-gnu/ && ldconfig
cmake -S qt-client -B build-qt && cmake --build build-qt -j4   # 会打印「OCCT AIS 视口：启用」
```

CMake 里是**可选**的：找不到头文件就回退到 OpenGL 视口（CI 就是这条路径，已验证能编）。

已实现：`/v1/geometry.stl` → `StlAPI_Reader` → `TopoDS_Shape` → `AIS_Shape` 显示；旋转/滚轮缩放/FitAll；
低左角坐标三轴。踩到的坑：OCCT 的颜色是线性色，直接给 0.09 会被写进 sRGB 帧缓冲变成中灰（实测亮度 85），
必须用 `Quantity_TOC_sRGB`；默认灯光在浅色面上过曝，统一压到 0.85。

标准视角已用**像素比例**验过（关掉坐标三面后测投影包围盒）：
俯视 639×639（正方形，等于 90×90 板面）、正视 639×103、右视 639×103（≈90:16）、等轴测 639×455。
真机图：`qt-client-22-occt-iso.png` / `-23-occt-front.png` / `-24-occt-top.png` / `-25-occt-right.png`。

**选面与面积测量**：不用 AIS 的 `SelectDetected`（在 `Aspect_NeutralWindow` 下 `MoveTo` 实测会段错误），
改成 `V3d_View::ConvertWithProj` 取射线 + `IntCurvesFace_ShapeIntersector` 与 BRep 求交，取最近交点所在面。
由于 STL 读进来是「一个三角面 = 一个 Face」，再按「同法向 + 同平面距离」把三角形合并成平面区域算面积。

实测转接板俯视点一下：**7,770.38 mm²**，命中点 `(-3.27, -22.37, 12.00)`。
手算 90×90 − 4×Ø8.5 沉孔 227.0 − 4×Ø5.5 通孔 95.0 − 四角 R3 7.7 = **7,770.3**，差 0.08（三角化误差）。

**导出**：`文件 → 导出 STL…`（零件或装配都行，几何一律从服务端取，客户端不重算）；
`--export-selftest --out <path>` 是无人值守版本。实测零件 330,284 B / 6,604 三角面，
装配（3 个成员）990,684 B / 19,812 三角面 = 正好 3 倍。
装配清单对话框里还有「导出 CSV…」（带 UTF-8 BOM，Excel 打开中文不乱码）。

**一句话 → 整机方案**：`文件 → 从 brief 生成整机方案…` 调 `desktop/scripts/machine-design-cli.mjs`
（stdout 只给 JSON，日志走 stderr），跑完整机管线后直接弹方案窗口。管线脚本位置可用
`AUTOMATIONCAD_PIPELINE` 指定，否则按构建目录向上找 `desktop/scripts/machine-design-cli.mjs`。

实测新 brief（四工位点胶机 / 25 件每分 / 步进+气爪+到位检测）：
**4 工位 / BOM 11 项 / IO 12 点 / 3.103 kW / 71.01 件每分 / 22,016.79（2 项无价格）**。
`--brief-selftest "一句话"` 是无人值守版本（CI 里跑的就是它）。

管线实现只有一处（`desktop/src/machine/case.ts`），脚本与 CLI 共用；
`desktop/test/machine/cli.test.mjs` 守着「CLI 输出 == machine-case.json」，
重构后重新生成的案例文件字节完全一致（`CASE_JSON_IDENTICAL`）。

**整机示意 3D**：生成方案后直接把 `geometry.parts` 画进 OCCT 视口——每个占位体一个 AIS 对象、
用管线给的颜色，box/cylinder 两种形体，`center` 是形体中心、`rotationZDeg` 绕 Z。
状态栏写清「%1 个占位体 · 包络 X×Y×Z · 精度=概念估算」。

实测四工位点胶机：**70 个占位体 / 包络 2140×740×1177 mm / fidelity=conceptual-estimate**
（`--geometry-selftest "一句话"` 无人值守输出 `FT_QT_GEOMETRY_OK`）。

**整机干涉初筛（AABB）**：方案窗口多一页「干涉初筛」，把 `geometry.interference` 的两两重叠列出来。
口径写死：**AABB 初筛 ≠ 布尔交集**，结构件共位（立柱插横梁）是正常装配，页面会直接说明
「全部是结构件共位」还是「有非结构件参与，需人工确认」。

实测四工位点胶机：70 个零件两两初筛 → **2 对疑似**，都是 `frame-leg-2 × frame-stringer-front` 与
`frame-leg-5 × frame-stringer-back`，各 96,000 mm³（重叠盒 60×40×40），`structuralOnly=true`。
每对再判 `declared`（在 `desktop/src/machine/joints.ts` 里显式声明过的结构连接，带原因，如「立柱插横梁」）
或 `suspect`（没声明 → 需人工确认），**需确认的排在最前**，页面顶部写「N 对未声明 + M 对已声明连接」。

连接由**几何生成器自己产出**（`geometry.joints`，如「立柱接台面」「立柱插横梁」「立柱插下横梁」「下横梁交汇」），
不再靠命名规则猜；老数据没有 `joints` 字段时才退回 `joints.ts` 的规则表，界面会写明
「连接来源：几何生成器产出 / 命名规则回退」。

关键口径：**只放行声明过的连接**。早期版本按「都是结构件 → 算共位」放行，那真正的结构撞车会被一起放行；
现在没声明的结构重叠照样报 suspect。

口径守卫在 `desktop/test/machine/interference.test.mjs`（6 条：重叠体积/贴面不算/挪开后消失/
旋转 45° 外接盒/已声明连接带原因且未声明结构重叠仍报 suspect/执行机构撞台面必为 suspect）。

实测四工位点胶机：2 对重叠 → 全部 `declared`（立柱插横梁，各 96,000 mm³），`suspects=0`，
声明表共 138 对连接。

**3D 点选 + 方向键微调**：在整机示意里点一个零件 → 状态栏显示零件 id →
方向键 1 mm、Shift+方向键 10 mm、PgUp/PgDn 调 Z，Esc 取消选中；每按一次都重跑管线并刷新干涉页，
选中态会保留。

点选不用 AIS 选择（NeutralWindow 下 `MoveTo/SelectDetected` 实测段错误），改成逐件射线求交取最近命中的零件。
无窗口管理器的环境（xvfb）里键盘要先 `xdotool windowfocus <wid>`，否则按键不投递——这是环境问题，不是客户端问题。

实测：点中 `conveyor-frame` → 两次 Shift+Right → 状态栏「已挪 conveyor-frame (10,0,0) · 重叠 2 对（需确认 0）」，
日志 `FT_QT_PICK part= conveyor-frame` / `FT_QT_NUDGE part= conveyor-frame delta= 10 0 0 count= 2`。

**间距初筛（太近但没撞）**：干涉只抓「撞上了」，实际装配还有一类问题是「没撞但够不着」。
`desktop/src/machine/clearance.ts` 的 `screenClearance(geometry,{thresholdMm})` 报
`0.5 < 间隙 < 阈值` 的零件对：距离按 AABB 三个分离轴平方和开根算
（**不能取最小正间隙**——X 隔 10、Y 隔 50 实际是 51 mm 不是 10），
贴面 ≤0.5 mm 算接触不算间距不足，已声明连接用**同一份 `joints.ts` 白名单**排除。

阈值不用改代码：干涉页那一行右侧有 `1–500 mm` 的输入框和「按此阈值重算…」，改完直接按新阈值重跑整机
（Qt 默认 20 mm，管线参数 `--clearance <mm>`）。实测 `FT_QT_THRESHOLD_OK at20=26 at40=37 spins=1 buttons=1`
——阈值放大到 40 之后问题数从 26 涨到 37，说明这个值真的进了筛查，不是界面摆设。

实测四工位（阈值 20）：`FT_QT_CLEARANCE_OK threshold=20 count=26 tightest=5.0`，
最紧一对是 `frame-top × conveyor-motor` 沿 Z 5 mm；Qt 干涉页顶部一行「间距 < 20 mm：26 处，最紧 5.0 mm」。
六工位阈值 30 时 29 处，主要是 `转台底座 × 治具` 12 mm 这类装配配合间隙。

**一键排布合规**：`resolveLayout(geometry,{clearanceMm})` 把两段交替跑——解重叠 → 推间距 → 复查，
不干净就再来一轮。**必须交替**：推间距会把件推到旁边撞出新的重叠，解重叠也可能把件推进别人的安全距离。
收敛判据只有一条：未声明重叠 = 0 **且** 间距不足 = 0；达不到就返回 `converged:false` + 原因。

实测四工位（阈值 20）：`FT_QT_LAYOUT_OK rounds=3 moves=58 suspects=0 clearance=0 converged=1`，
逐轮记录把这个来回写得很清楚：
- 第 1 轮：重叠 0 → 4（推间距推出 4 处新重叠）、间距 26 → 0
- 第 2 轮：重叠 4 → 4（解完又被推间距撞回去）、间距 0 → 0
- 第 3 轮：重叠 4 → 0、间距 0 → 0 → 合规

结果在方案窗口里能逐轮看：「排布合规（N 轮）」页签列出每轮的 进轮/出轮 重叠与间距数、两类位移条数，
「位移明细」页签列出每次挪动的类型（解重叠/推间距）、零件、轴、位移，并可导出 CSV
（`导出排布位移 CSV…` 或 `--layout-csv-selftest <case.json> --out x.csv`）。
实测 `FT_QT_LAYOUTCSV_OK rows=58`，CSV 60 行 × 10 列，末行 `3轮/58次`，两类位移都在。

**一键把间距推到阈值之上**：`resolveClearance(geometry,{thresholdMm})` 逐轮把最紧的那一对
沿间隙轴推开（推较小的那件），位移 = 阈值 − 当前间隙 + 1 mm 余量，然后整机重算。
实测四工位 `FT_QT_PUSH_OK before=26 after=0 moves=42 converged=1`——26 处清干净用了 **42 次微调**，
因为推开一件会挤到旁边的件；轮数上限默认 200（40 轮时卡在剩 4 处，如实报 `converged:false`）。

阈值不是越大越好：实测四工位 20 mm → 3 轮 58 次位移收敛；25 mm → 3 轮 66 次；**30 mm 与 40 mm 放不下**
（4 处间距不足始终清不掉），这时会**提前停**并说明「连续 2 轮没有进展……需要加宽工位或减少零件」，
不再空转到轮数用尽——修之前 30 mm 会跑 8 轮 1458 次位移还是原地不动。
判空转用的是「连续两轮没刷新最好成绩」，不是「这轮和上轮一样」：20 mm 的收敛过程正好是 4 → 4 → 0，
按后者会误杀。工位的间距阈值与排布合规共用同一个值（干涉页改完，两个按钮都按新值算）。

放不下时不只报「未收敛」，还给到工位级的补救建议：`advice[]` 按零件 id 前缀（`st1`/`frame`/`conveyor`）
汇总「还差多少 mm 才到阈值」，界面在未收敛的判定下面直接列「· st1 还差 37.0 mm（st1-plate × …）」。
实测 40 mm 时 `st1` / `st4` 各差 37 mm（阈值 40 − 实际 3 mm），按还差从大到小排。

合规结论会写进方案文件本身（顶层 `compliance` 戳：`clearanceMm / converged / suspects / clearance / rounds / moves`，
不含时间戳以免 golden 文件每次变化）。打开方案时概览页显示「排布合规：按 20 mm：已合规（3 轮 / 58 次位移）」；
若界面当前阈值与戳里的不同，会补一句「⚠ 界面当前阈值是 35 mm…需重新计算」——避免误以为这份方案是按现在的阈值查过的。
没有跑过合规的方案显示「未检查」，不假装合规。

**注意一个反直觉点**：不能断言「每条位移的 gapAfter 都 ≥ 阈值」。单轴推开只增加一个轴的距离，
而距离是三轴平方和，后续 move 还会改变这一对（实测某条当时 19.6 mm，再经过后续微调才过 20）。
能守住的是「整轮跑完 count=0」。

**批量解开未声明的重叠**：干涉页「批量解开未声明的重叠…」→ 管线带 `--resolve` 跑
`resolveConflicts`：**只动 suspect**（declared 是设计上该相接的，动它等于改设计），
每轮只应用位移最小的那一条再整机重算（一次挪多个会互相影响，必须逐轮验证），
有轮数上限与「没进展就停」两条保险，收敛不了返回 `converged:false` 并说明原因。

结果可导出调整清单 CSV（`导出调整清单 CSV…` 或 `--resolve-csv-selftest <case.json> --out x.csv`）：
列是 零件/轴/位移/原中心 XYZ/新中心 XYZ/解后剩余，**给的是坐标不是只给增量**——工程师照着改模型要落点。
实测 8 行 + 表头 + 合计 = 10 行 10 列，`csv.reader` 解析每行 10 列，合计写 `8→0`。

实测六工位（8 处未声明）：`FT_QT_RESOLVE_OK before=8 after=0 moves=8 converged=1`，
逐轮剩 `7→6→5→4→3→2…`，挪的是治具 5 mm、转台 −9.9 mm 这类小幅位移。
四工位没有未声明重叠时 `before=0 after=0 moves=0`——不会为了「有动作」去动已声明连接。

**干涉对给「建议位移」并一键应用**：每对算「往哪挪、挪多少才能分开」——逐轴比较「+ / −」两个方向的
最小所需位移取全局最小（**不能直接拿重叠量当位移**：移动件一旦越过对方边界，所需位移会比重叠量更大，
实测 40 mm 重叠要挪 51 mm 才真的分开），谁动取体积较小的一件。表里显示「挪 frame-stringer-front Y +51 mm」，
「按建议挪这一对…」会把它应用到管线并重开方案窗口（循环，不丢上下文）。

实测：`FT_QT_APPLY_HINT_OK part=frame-stringer-front axis=y delta=51.0 before=2 after=1`。

**干涉对点选即在 3D 点亮**：干涉初筛表里点一行，那一对零件在视口里同时变暖色（其余恢复原始配色），
状态栏写「干涉对：A × B」。`AUTOMATIONCAD_PAIR_AUTO=1` 会在打开时自动选第一行（无人值守验收用）。

实测日志：`FT_QT_PAIR_HIGHLIGHT frame-leg-2,frame-stringer-front`。

**试摆位（改完立刻重算干涉）**：`评估 → 试摆位（移动零件重算干涉）…`，选零件 + 三轴位移 →
带 `--move <id>:<dx>,<dy>,<dz>` 重跑管线 → 3D 与干涉页一起刷新。位移是**增量叠加**的，
只改中心点不改尺寸/旋转；`--tune-selftest "brief" --move ...` 是无人值守版本。

实测四工位：`before count=2 suspects=0 declared=2 | after count=0 suspects=0 declared=0`
（把两根下横梁各下移 1000 mm）。

**导出整机 BOM CSV**：方案窗口底部按钮（或 `--machine-bom-selftest <case.json> --out x.csv`）。
实测 `machine-case.json` → 12 行 + 表头 + 合计 = 14 行 5 列，来源文案里有逗号所以加了引号转义，
`csv.reader` 解析回来每行都是 5 列；合计 `34489.91` 固定两位小数（默认流输出会印成 `34489.9`）。

**导出整机示意 STL**：`文件 → 导出整机示意 STL…`（或 `--geometry-selftest "..." --out x.stl`）。
实测四工位：**113,284 B / 2,264 三角面**，用 STL 二进制头部的三角面数反算长度 `84+50×2264` 与文件字节完全一致；
三角面顶点反算出的包围盒 **1820×740×1177** 与管线给的 envelope 一字不差——说明摆位（中心点/绕 Z 转角）没有错位。

两个自己踩的坑记一下：
- 构造后立刻渲染时视口 `width/height` 还是 0，`FitAll` 算不出比例 → 画面全空。修法是渲染前 `MustBeResized()`，
  并且 UI 路径用 `QTimer::singleShot` 等窗口真正显示。
- 70 个零件合成一个 `TopoDS_Compound` 会变成一坨同色实体，看不出结构 → 改为逐件 `AIS_Shape` + 各自颜色。

CI 只装 Qt、没有 OCCT 头文件，所以这条路径必须能在「没有视口」时编过：
`-DAUTOMATIONCAD_OCCT=OFF` 可以在本机复现该构建（这次 CI 红就是因为本地没跑这条）。

已知未解决：无窗口管理器环境下 `windowclose` 不生效（关窗退出未验证）；外部 SIGTERM 强杀进程时
OCCT 清理偶发段错误（正常关窗路径没复现到）。

**整机方案（只读）**：`文件 → 打开整机方案…` 读 desktop 管线导出的 `machine-case` JSON
（`schemaVersion=1`、`kind=machine-case`，校验不过会明确报「不是整机方案文件 / 不支持的版本」），
弹窗分三页：概览（工位数/节拍/功率/成本）、BOM、IO。数字全部原样来自 JSON，客户端不重算、不补默认值。

实测 `docs/desktop/eval/machine-case.json`：**6 工位 / BOM 12 项 / IO 19 点 / 4.650 kW / 31.75 件每分 / 达标 /
成本 34,489.91（3 项无价格）**。`--machine-case <path>` 打印摘要，`--machine-case-ui <path>` 直接开窗口（截图用）。

边界写在弹窗底部：方案级结果，没有 3D 几何、没有工程图、没有公差；节拍是估算，无价格项计 0 并单独计数。

需要自绘视口时 `AUTOMATIONCAD_QT_OCCT=0`。

## 自检入口（CI 用）

```sh
# 写链路：读树 → 改 height+1 → 回读校验
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --selftest --base http://127.0.0.1:18080
# 自动刷新（轮询路径）：读一次 → 外部改树 → 客户端 1.5s 轮询内刷到新 revision
node ../qt-client/tests/watch.mjs --binary build/automationcad-qt
# SSE 推送路径：轮询被调成 30s，改树后 2s 内必须刷到（实测 138ms）
node ../qt-client/tests/sse.mjs --binary build/automationcad-qt
# 撤销/重做：改 → 撤销 → 重做（要服务端）
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --history-selftest --base http://127.0.0.1:18080
# 新建特征：加 Ø4 通孔 → 体积按 πr²t 减少 → 删掉复原（要 sidecar 真几何）
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --create-feature-selftest --base http://127.0.0.1:18080
# 特征操作：压缩 → 删除被引用基体必须 409 → 解除压缩（要 sidecar 真几何）
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --feature-ops-selftest --base http://127.0.0.1:18080
```

## 下一步（按契约第 15 节未定项推进，不要擅自默认）

- OCCT AIS 视口接入（拾取、高亮、剖切）；
- 草图对象与 SolveSpace 求解器（契约只占了字段位，v1 提交 `sketch` 会被拒绝）；
- 拓扑命名稳定层（圆角/配合引用不断链）；
- 工程包磁盘文件布局、变更事件传输方式（SSE / 长轮询）的最终拍板。

## Windows 真机构建（2026-10-29 实测通过）

本机把工具链装在 D 盘，全部走 MinGW，不需要 Visual Studio：

| 组件 | 路径 | 版本 |
|---|---|---|
| Qt | `D:\Qt\6.8.3\mingw_64` | 6.8.3（qtbase：Widgets / Network / OpenGLWidgets） |
| MinGW | `D:\Qt\Tools\mingw1310_64` | g++ 13.1.0 |
| CMake | `D:\Qt\Tools\CMake_64\bin` | 3.30.5 |
| Ninja | `D:\Qt\Tools\Ninja` | 1.12.1 |

装法（`aqtinstall`，装到 `D:\Tools\aqt-venv`）：

```bash
uv venv D:/Tools/aqt-venv --python 3.12
uv pip install --python D:/Tools/aqt-venv/Scripts/python.exe aqtinstall
D:/Tools/aqt-venv/Scripts/python.exe -m aqt install-qt windows desktop 6.8.3 win64_mingw -O D:/Qt --archives qtbase
D:/Tools/aqt-venv/Scripts/python.exe -m aqt install-tool windows desktop tools_mingw1310 -O D:/Qt
D:/Tools/aqt-venv/Scripts/python.exe -m aqt install-tool windows desktop tools_ninja -O D:/Qt
D:/Tools/aqt-venv/Scripts/python.exe -m aqt install-tool windows desktop tools_cmake -O D:/Qt
```

构建（OCCT 头文件在 Windows 上没有，走 OpenGL STL 视口回退）：

```bash
export PATH="/d/Qt/Tools/mingw1310_64/bin:/d/Qt/Tools/Ninja:/d/Qt/Tools/CMake_64/bin:$PATH"
cmake -S qt-client -B D:/build/qt-client -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=D:/Qt/6.8.3/mingw_64 \
  -DCMAKE_CXX_COMPILER=D:/Qt/Tools/mingw1310_64/bin/g++.exe -DAUTOMATIONCAD_OCCT=OFF
cmake --build D:/build/qt-client --parallel
```

跑起来要把 Qt 与 MinGW 的 bin 都放进 PATH（缺 MinGW 运行库会 0xC0000135 直接退出），
无人值守自检加 `QT_QPA_PLATFORM=offscreen`：

```bash
export PATH="D:/Qt/6.8.3/mingw_64/bin:D:/Qt/Tools/mingw1310_64/bin:$PATH"
QT_QPA_PLATFORM=offscreen node qt-client/tests/watch.mjs --binary D:/build/qt-client/automationcad-qt.exe
QT_QPA_PLATFORM=offscreen node qt-client/tests/sse.mjs   --binary D:/build/qt-client/automationcad-qt.exe
```

两个 e2e 在 Windows 上已通过：`QT_WATCH_OK`、`QT_SSE_OK`（SSE 延迟 357 ms）。

## Windows + OCCT AIS 视口（2026-10-29 实测通过）

AIS 视口要和 OCCT 的 C++ ABI 一致，不能用 MinGW 链 conda/官方那些 MSVC 编的库，
所以这条链路改用 **MSVC 2022（本机已装 Community）+ Qt msvc2022_64 + OCCT 8.0.1**：

| 组件 | 路径 | 说明 |
|---|---|---|
| MSVC | `C:\Program Files\Microsoft Visual Studio\2022\Community` | cl 14.44，vcvars64 |
| Qt | `D:\Qt\6.8.3\msvc2022_64` | aqt 安装，qtbase |
| OCCT | `D:\o\Library` | conda-forge `occt --no-deps` + 运行时依赖 |

OCCT 装法（注意三件事：短路径、`--no-deps`、运行时依赖单独补）：

```bash
# 1) 只装 OCCT 本体（带 vtk 的全量依赖会拉 qt6-main/viskores，且长路径超 260 会解压失败）
export MAMBA_ROOT_PREFIX=D:/m
D:/Tools/micromamba/Library/bin/micromamba.exe create -y -p D:/o -c conda-forge occt --no-deps
# 2) 补 AIS 需要的运行时 DLL（不做这步启动瞬间 0xC0000135）
D:/Tools/micromamba/Library/bin/micromamba.exe install -y -p D:/o -c conda-forge \
    freetype fontconfig tbb libexpat freeimage
```

构建：

```bat
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=D:\Qt\6.8.3\msvc2022_64\bin;D:\Qt\Tools\Ninja;D:\Qt\Tools\CMake_64\bin;%PATH%
cmake -S qt-client -B D:/build/qt-occt -G Ninja -DCMAKE_BUILD_TYPE=Release ^
      -DCMAKE_PREFIX_PATH=D:/Qt/6.8.3/msvc2022_64 -DOCCT_ROOT=D:/o/Library
cmake --build D:/build/qt-occt --parallel
```

配置阶段会打印 `OCCT AIS 视口：启用（D:/o/Library/include/opencascade; ...）`。

运行要同时带上 Qt 与 OCCT 的 bin：

```bat
set PATH=D:\Qt\6.8.3\msvc2022_64\bin;D:\o\Library\bin;%PATH%
D:\build\qt-occt\automationcad-qt.exe
```

OCCT 8.0 把 STL 从 `TKSTL` 拆成了 `TKDESTL`，CMakeLists 里按存在的库名挑，
7.x/8.x 都能配；`--selftest` / `--export-selftest` 两个自检在 MSVC + OCCT 构建下同样通过
（`QT_WATCH_OK`）。
