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

**还没做**：选面与测量。试过 `MoveTo + SelectDetected`，点击后 `HasSelectedShape()` 返回 false（没崩，但选不中），
所以没有把选中/测面积做进界面——不留假功能。需要自绘视口时 `AUTOMATIONCAD_QT_OCCT=0`。

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
