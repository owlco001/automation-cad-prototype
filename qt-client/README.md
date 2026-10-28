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

## 自检入口（CI 用）

```sh
# 写链路：读树 → 改 height+1 → 回读校验
QT_QPA_PLATFORM=offscreen ./build/automationcad-qt --selftest --base http://127.0.0.1:18080
# 自动刷新：读一次 → 外部改树 → 客户端 1.5s 轮询内刷到新 revision
node ../qt-client/tests/watch.mjs --binary build/automationcad-qt
```

## 下一步（按契约第 15 节未定项推进，不要擅自默认）

- OCCT AIS 视口接入（拾取、高亮、剖切）；
- 草图对象与 SolveSpace 求解器（契约只占了字段位，v1 提交 `sketch` 会被拒绝）；
- 拓扑命名稳定层（圆角/配合引用不断链）；
- 工程包磁盘文件布局、变更事件传输方式（SSE / 长轮询）的最终拍板。
