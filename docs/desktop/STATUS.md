# 项目状态 · 2026-10-29（晚）

## 概览

- 仓库：`main` @ `edad92e`（GitHub `owlco001/automation-cad-prototype` 与 Gitee 双推，两侧 SHA 一致）。
- 版本：`desktop/package.json` → **0.5.0**，已打源码 tag `v0.5.0`；**安装包仍停在 v0.4.2**（Windows 本地构建、未签名），0.4.3 之后未出包。
- 质量门槛（2026-10-29 本机 Linux 实跑，`main@41dfd1c`）：`npx tsc --noEmit` 0 错误；`npm test` **2640 总计 / 2638 通过 / 0 失败 / 2 跳过**（跳过项为需真实 FreeCAD 的 E2E，未设 `AUTOMATIONCAD_FREECAD_REAL`）；`npm run build:ext` 通过；`npm run smoke` 收尾 `SMOKE_OK`。
- 平台：**Linux + Windows 双真机**。Linux 用 Qt 6.4.2 + g++（OCCT 头文件在 `/usr/local/include/opencascade`）；Windows 有两条链路——Qt 6.8.3 + MinGW 13.1（`D:\Qt`，`AUTOMATIONCAD_OCCT=OFF`，自绘 STL 视口）与 MSVC 2022 + Qt msvc2022_64 + OCCT 8.0.1（AIS 视口真实可用）。构建全过程见 `qt-client/README.md` 第 291 行起。
- 排布合规链（本轮新增）：干涉/间距 AABB 初筛 → 建议位移 → 批量解重叠 → 一键排布合规（交替求解）→
  工位级补救建议（内部/跨工位分流，跨工位还要过「推完是否撞」自检）→ 最大可行间距（二分，四工位 25 mm）
  → 合规戳写进方案文件 → 手工挪动后自动标「过期」→ 概览页一键重算。
  Qt 侧支持单件微调与整站挪（`Ctrl + 方向键`）、保存整机方案（`QSaveFile` 原子写）。
- CI：`.github/workflows/ci.yml` 在 push `main` 与 `pull_request` 上跑 **四个** 并行 job——`unit`（tsc / 单测 / 包校验 / `eval:agent` / 契约服务 35 条 / MCP 11 条 / 落盘 10 条）、`smoke`（xvfb + 真实 Electron：降级 smoke、SwiftShader WebGL、机型截图 + artifact、MCP 冒烟）、`Qt client build`（Qt6 编译 + `--selftest` / `--history-selftest` / `--feature-ops-selftest` / `--sse-selftest` / 自动刷新）、`FeatureTree real geometry`（pip 装 build123d，跑体积/质量/STL/材料）。Windows 打包仍是手动 `workflow_dispatch`。
- 评估：`npm run eval:agent` **111/111**，`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；工具注册表 **25 个（只读 12 / 写 13）**。
- 数据包：`npm run packs:validate` → **10 包 / 617 条 / 612 唯一型号 / 0 错误 0 警告**。
- 离线知识索引：`npm run kb:build` → `docs=13 chunks=361`，约 378 KB（≈94.5%，余量约 22 KB，未截断；实测 385,723 B）——字节数会随文档重建变动，这里只给近似值，精确值由 `npm run kb:build` 输出。
- 最近发布：`v0.4.0` NSIS `AutomationCAD-Setup-0.4.0.exe`（约 130 MB，未签名），更新通道未做真实签名与跨版本升级验收。


## 夜间迭代（2026-10-28 夜）

合并 8 个 PR（#26–#33）：特征右键菜单、SSE 推送、可选落盘、MCP 6 工具、材料与质量、新建特征、视图菜单、Store 单元验收；
逐项数字与真机证据见 [STATUS-HISTORY.md](STATUS-HISTORY.md#夜间迭代5-个-pr)。

## 验证记录（逐条为本机真实输出）

| 命令 | 结果 |
|------|------|
| `npx tsc --noEmit` | 0 错误 |
| `npm test` | 2589 总计 / 2587 通过 / 2 跳过 / 0 失败 |
| `npm run build:ext` | 通过（tsc + Vite + Electron main/preload + MCP） |
| `npm run smoke` | 退出码 0，收尾 `SMOKE_OK`（降级渲染路径，覆盖画布/向导/机型/Agent/干涉面板） |
| `npm run smoke:design:webgl` | `SMOKE_DESIGN_WEBGL_OK renderer=ANGLE (… SwiftShader …) scene=61 partPaths=61 tree=61 placements=13`；`SMOKE_PLACEHOLDER_DIMS_OK w=18 h=85 d=78.5 y=0` |
| `npm run screenshots:machine` | `MACHINE_SHOTS_DONE captured=4 failed=0`，四张 PNG 互不相同（sha256 去重守卫）；CI 侧同时上传 artifact `machine-screenshots` |
| `npm run smoke:mcp` | `MCP_SMOKE_DONE`：401 未授权 → 渲染层就绪 → `tools/list` 25 → 3 个 resources → `file:///etc/passwd` 返回 `-32602` → 未知方法 `-32601` → `tools/call get_bom` 成功 |
| `npm run eval:agent` | 111/111；`accuracy=1.00 tools=1.00 refused=1.00` |
| `npm run packs:validate` | `PACKS_VALIDATE_OK packs=10 errors=0 warnings=0 parts=617 models=612` |
| `node featuretree-service/tests.mjs` | 全部通过：**35 条**（契约校验/乐观锁/undo-redo/材料/413/引用检查） |
| `node featuretree-service/mcp-tests.mjs` | `MCP_FEATURETREE_OK`，**16 条 PASS**（双向读写、6 工具、引用拒绝、资源） |
| `node featuretree-service/store-tests.mjs` | `STORE_OK`，**16 条 PASS**（乐观锁/undo steps/redo 栈/越界/重复 id/材料/孤儿基体/白名单） |
| `node featuretree-service/persistence-tests.mjs` | `FT_PERSISTENCE_OK`，**10 条 PASS**（默认不写盘 / 落盘 / 重启恢复 / 快照可 undo） |
| `node featuretree-service/build-tests.mjs` | `FT_BUILD_OK`，**18 条 PASS**（体积 94,166.8 与手算一致、STL 6,604 面、铝 0.2543 kg、fail-closed） |
| `qt-client --selftest` / `--history-selftest` / `--feature-ops-selftest` / `--sse-selftest` | 全过；SSE 实测 **138ms**，压缩孔阵列 +1,140.4 mm³ 与手算一致 |
| `git diff --check` | 通过（提交前复核） |

## Smoke 断言

关键几条：`SMOKE_OK`、`SMOKE_DESIGN_WEBGL_OK`（SwiftShader）、`MACHINE_SHOTS_DONE captured=4 failed=0`、`MCP_SMOKE_DONE`。完整断言矩阵见 [STATUS-HISTORY.md](STATUS-HISTORY.md#smoke-断言清单)。

## 模块状态（P1–P9 + 后续落地）

图例：✅ 完成；🔄 主体完成、仍有明确待办；⏸ 暂停/未启动。

| 阶段 | 状态 | 范围 | 备注 |
|------|------|------|------|
| P1 电气智能辅助 | ✅ | 线号合规、功率统计、导线截面/断路器校验、面板与 PDF、Agent 工具 | 规则与面板闭环 |
| P2 电箱底板画布 | ✅ | 真实尺寸布局、拖放、导轨吸附、碰撞、利用率 | 尺寸覆盖 244/371（16 条同系列推定，带 `dims.source`） |
| P3 联调 3D 通用化 | ✅ | 配置驱动 4 工位 / 12 执行机构 / 多传感器；运动学标注与滑块预览 | STEP 无运动学时需人工标注 |
| P4 大模型性能 | ✅ | 渲染规划（合批/视锥/LOD）、10 万面基准、软件渲染降级提示 | `bench:render` 500 件 20 drawCall；3000 件 tick p95 2.34ms |
| P5 智慧工厂服务端 | 🔄 | 设计包 ZIP/manifest/幂等/上传/列表/diff/下载；本地端到端已通过 | 生产实例部署待 D2 |
| P6 硬件成本统计 | 🔄 | 价格簿、引擎、面板、A4/CSV 导出、Agent 工具与落盘 | 真实采购价对接待 D1 |
| P7 自然语言交互 Agent | ✅ | 离线路由、上下文/指代、多步规划与执行、工具扩展、本地知识检索、写确认卡片、MCP resources、外部客户端契约冒烟 | 25 工具（只读 12 / 写 13）；真实模型只按 OpenAI 兼容协议验证 |
| P8 PLC 程序生成 | 🔄 | 预检、变量表、五个基础块、自动序列/报警/安全、11 文件、UI/zip/历史、模拟器 | 厂商工程文件未做 |
| P9 参数化建模 | 🔄 | build123d sidecar、特征树、防抖重建、STEP/STL、多实体装配与 BOM/成本联动 | 草图约束未做；依赖本机 Python |
| 画布工作台 | ✅ | 拓扑/2D 正交/多画板、草稿持久化、真实价格与手工询价、模组库、PiP 3D、方案库、摘要、DXF、撤销重做、特征树与属性面板（PR #20） | 3D 仅为占位盒/概念预览 |
| 机型设计 | ✅ | brief → 方案卡 → 落盘 → 3D/BOM/IO 联动；立体缓存变体（`layers≥2`）、brief 直接建机、场景质量随工程保存 | 几何仍为示意件，非型号 CAD |

补充：18 张 Electron 实跑截图位于 `docs/desktop/screenshots/`（`11–14` 由 `npm run screenshots`、`15–18` 由 `npm run screenshots:machine` 生成，后者在 CI 里也跑并做 sha256 去重）。

## Qt 客户端现状（真机验证）

- 特征树：文档根（含版本）→ 零件 → 特征，带关键尺寸与「（已压缩）」；右键压缩/解除压缩/删除。属性面板只放行白名单字段，其余只读。
- 视口：OCCT AIS（默认）或自绘 OpenGL 渲染服务端 STL，旋转/缩放/四标准视角/随版本重载；链路走 SSE（断线 3s 重连 + 10s 轮询兜底）；材质四选一，几何不变质量重算。
- 新建特征：插入→新建特征（Ctrl+N），类型/参数按类型切换，服务端校验后重建。
- OCCT AIS 视口（有头文件时默认）：STL → TopoDS → AIS_Shape 渲染/旋转/四标准视角（像素比例已验证：俯视正方形、正视与右视 639×103）；Qt 也能画整机示意 3D（70 个占位体 / 2140×740×1177 / concept-estimate）。Qt 也能读整机方案（只读）：`文件 → 打开整机方案…`，实测 6 工位 / 12 BOM / 19 IO / 4.65 kW / 31.75 件每分 / 34,489.91。导出：文件 → 导出 STL…（零件 330,284 B / 6,604 面；装配 990,684 B / 19,812 面）。选面/测量已实现：射线求交 + 同平面三角形合并，实测俯视顶面 7,770.38 mm²（手算 7,770.3）。
- **仍未做**：OCCT 选择面/测量/剖切（本机 Debian 12/13 混源，`libocct-{data-exchange,visualization}-dev` 被 `libfreetype-dev` 版本冲突卡住）、Windows 上编译 Qt、选择面/测量/剖切、新建特征对话框。

## 已知限制

1. **参数化内核依赖 Python**：build123d sidecar 需要本机 Python 与 `spike/build123d/app.py`；安装包只带脚本，不内置解释器。
2. **价格簿为示例价**：内置价格簿条目标注「示例，需替换」，引擎自动排除示例价；正式报价前必须导入企业价格表（D1）。
3. **运动学需人工标注**：STEP/IGES/BREP 不含动件、轴、行程与 IO 绑定；未标注时 3D 联调回退到机型配置。
4. **生产环境不可达**：设计同步后端 0.22.0 已实现，本地临时 DB 端到端通过（`SYNC_E2E_OK`）；生产实例部署/HTTPS/真实网络未验证（D2）。
5. **生产安装包未签名/更新未验收**：tag 发布会因缺 `CSC_LINK` / `CSC_KEY_PASSWORD` 安全阻断；Windows 上的签名者、SHA-512、stable/beta、blockmap 回退均未验收。
6. **工业协议未接真机**：OPC UA 仅 `SecurityPolicy=None`；MQTT 未连真实 broker；Modbus TCP 未连真机。
7. **干涉是两级口径**：面板默认 AABB 初筛（只写「疑似」），需要真数字时走「精确干涉」B-Rep 布尔（交集体积 >1mm³ 且占较小件 >0.05%）；贴合面、螺纹啮合在 B-Rep 里是真交集，由人判断。
8. **智能体真实模型兼容性有限**：只按 OpenAI 兼容协议验证；离线路由是关键词规则，不是语义理解。
9. **外部 MCP 客户端启动瞬间工具不全**：`cost/elec/plc` 三组 5 个工具受模块开关门控，开关要等渲染层读完设置才回填，启动瞬间 `tools/list` 只有 20 个；客户端应等 `resources/read …/summary` 返回 `ok:true` 再取列表。
10. **Windows 打包仍手动**：CI 自动跑测试与 Linux 侧渲染冒烟，`windows.yml` 仍需 `gh workflow run windows-build --ref main`；签名证书未配置。
11. **便携包偏大**：Electron 45 + node-opcua，解压后数百 MB。
12. **无 WebGL 的 headless 渲染**：xvfb 下降级路径显示解析统计面板；需要真 WebGL 的断言放在 `smoke:design:webgl`（SwiftShader）。
13. **示意几何边界**：机型/画布产出的 3D 是占位盒或示意装配，无孔系/焊缝/公差，质量记 `null` 写「未称重」，不能当供应商结构图或下料图。

## 待决策索引（D1–D10）

完整选项、影响与建议见 [BACKLOG.md](BACKLOG.md) 的「待决策」表。

| # | 待决策 | 状态 |
|---|--------|------|
| D1 | 价格簿真实单价来源 | 待定 |
| D2 | 智慧工厂生产环境由谁部署 0.22.0 | 待定 |
| D3 | PLC 程序生成首期目标平台 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | 待定 |
| D5 | 缺失尺寸能否用同系列壳体推定 | ✅ 已定 A：244/371，推定项带标记 |
| D6 | 参数化建模首期范围 | 待定 |
| D7 | 成本面板的 CAD 零件名 → 物料号映射口径 | 待定 |
| D8 | Agent 是否允许落盘导出成本报告 | ✅ 已定 B，已实现 |
| D9 | 离线规则是否在模型可用时前置 | 待定（现状：仅模型失败时降级） |
| D10 | 中文评估集基线通道 | ✅ 已定 B：离线 111 条 + 真实模型 36 条 |

## 验证命令速查

```bash
cd desktop
npx tsc --noEmit                    # 类型检查
npm test                            # 2589 条单测/集成测试（2 条需真实 FreeCAD，默认跳过）
npm run build:ext                   # tsc + Vite + Electron main/preload + MCP
npm run smoke                       # xvfb + Electron headless（无 WebGL 降级路径）
npm run smoke:design:webgl          # SwiftShader 真 WebGL 路径（占位盒尺寸等断言）
npm run smoke:mcp                   # 外部客户端契约（--headless-service + JSON-RPC）
npm run screenshots                 # 真实 Electron 截图 11–14
npm run screenshots:machine         # 机型全流程截图 15–18（四张必须互异）
npm run eval:agent                  # 111 条中文 Agent 评估集
npm run sync:e2e                    # 本地临时 DB 的设计同步端到端（需 /root/mf-main 后端）
npm run perf:baseline               # 200/1000/3000 件渲染基线
npm run bench:render                # 500 件 / 10 万面渲染规划基准
```

CI 结论查看：

```bash
gh run list --workflow=ci.yml --limit 3
gh run watch $(gh run list --workflow=ci.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

历史加固的逐项代码改动与原因见 [HARDENING.md](HARDENING.md)。
