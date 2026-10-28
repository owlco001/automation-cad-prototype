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
# 特征操作：压缩 → 删除被引用基体必须 409 → 解除压缩（要 sidecar 真几何）
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --feature-ops-selftest --base http://127.0.0.1:18080
```

## 下一步（按契约第 15 节未定项推进，不要擅自默认）

- OCCT AIS 视口接入（拾取、高亮、剖切）；
- 草图对象与 SolveSpace 求解器（契约只占了字段位，v1 提交 `sketch` 会被拒绝）；
- 拓扑命名稳定层（圆角/配合引用不断链）；
- 工程包磁盘文件布局、变更事件传输方式（SSE / 长轮询）的最终拍板。
