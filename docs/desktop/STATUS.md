# 项目状态 · 2026-10-24

## 概览

- 基线：远端 `main` 为 `0d69dc0`；本轮实现提交 `eb0c830`，位于独立分支 `feat/desktop-module-safety-update`，PR 待审且未合并。PR #6、#7 与原 PR #8 分支均保持不变。
- 版本：`desktop/package.json` → **0.3.0**；本轮未打包、未触发 Windows workflow、未打 tag 或创建 Release。
- 测试：最新 main 基线上 `TZ=UTC npm test` **1800/1800 通过，0 失败、0 跳过**。
- 构建与冒烟：`npm run build:ext` 通过（含 TypeScript 检查）；fake parametric sidecar 下 Electron headless smoke 最终输出 `SMOKE_OK`。覆盖模块门控、Agent checkpoint、CAD 只读导入/参数化、PLC/sync 和 10 个元器件包校验。
- 评估：最近一次既有记录 `npm run eval:agent` 为 `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；本轮未重跑离线或真实模型评估。
- 最近发布：`v0.3.0` NSIS `AutomationCAD-Setup-0.3.0.exe`（129 MB，未签名；上一版 `v0.2.0`）。本轮更新通道只有 mock/本机代码路径验证，未做真实签名或升级验收。

## 验证记录（本轮真实执行）

| 命令 | 结果 |
|------|------|
| `TZ=UTC npm test` | 1800 pass / 0 fail / 0 skipped |
| `npm run build:ext` | 通过（`tsc --noEmit`、Vite 扩展、Electron main/preload、MCP） |
| `AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` | 通过；新增模块 gate/checkpoint/CAD/sync/包校验断言，最终 `SMOKE_OK`；退出码 0 |
| `git diff --check` | 通过（提交前复核） |
| `npm run screenshots:machine` / `npm run eval:agent` | 本轮未重跑；不作为本轮验收声明 |

Smoke 日志在 fake sidecar 退出收尾时记录一次非致命 `ECONNREFUSED 127.0.0.1:7440` health retry；所有断言通过且命令以 `SMOKE_OK` / 退出码 0 结束。

## Smoke 断言清单

以下断言名均从 `desktop/electron/main.ts` 实际 grep 得到（另含 `SMOKE_OK`、`SMOKE_FAIL`、`SMOKE_SHOTS_FAIL` 三个控制标记，未计入断言）；参数为最近一次实跑输出（路径类断言只校验文件存在与非空）。无 fake sidecar 时参数化 3 个 `_OK` 不出现、2 个分支输出 `_SKIP`。

| 断言 | 本轮实测 / 含义 |
|------|-----------------|
| `SMOKE_CAD_OK` | `triangles=12 meshes=1`，`cube.stp` 解析统计 |
| `SMOKE_WEBGL_FALLBACK_OK` | `meshes=1 triangles=12 bounds=300×300×300 mm`，无 WebGL 降级面板 |
| `SMOKE_KINEMATICS_UI_OK` | `parts=2 errors=1 slide=25`，标注校验与滑块预览 |
| `SMOKE_KINEMATICS_AUTO_OK` | `high=4 low=1 accepted=1 autoApplied=0`，STEP 动件自动识别只出建议 |
| `SMOKE_AGENT_KINEMATICS_OK` | `high=4 low=1 written=0`，Agent 工具 `suggest_kinematics` 经命令总线拿到建议且不改动件列表 |
| `SMOKE_ORBIT_UNDO_OK` / `SMOKE_ORBIT_MULTI_OK` / `SMOKE_ORBIT_PERSIST_OK` | 主视口 3D 编辑与原型合成一条撤销时间线、多选、`automationcad.orbit.v1` 重开恢复 |
| `SMOKE_AGENT_AUDIT_ROTATED_OK` | `rows=3 files=2`，审计日志轮转后面板/报告读全部保留文件 |
| `SMOKE_MECH_OK` | `hits=1`，干涉 AABB 初筛 |
| `SMOKE_MECH_UI_OK` | `rootTab=1 calculators=3 inspector=1` |
| `SMOKE_EXPORT_OK` | `csv=1 dxf=1`，BOM/DXF 写出 |
| `SMOKE_EXPORT_ASSETS_OK` | `xlsx=16577 glb=1772 obj=903`，XLSX/GLB/OBJ 字节数 |
| `SMOKE_PDF_OK` | A3 报告 PDF 已写出 |
| `SMOKE_PLC_OK` | `points=28`，PLC 仿真点位表 |
| `SMOKE_COMMISSION_OK` | `steps=6 passed=6`，6 步上电 |
| `SMOKE_COMMISSION_UI_OK` | `cases=3 monitor=28 results=18` |
| `SMOKE_COMMISSION_PDF_OK` | 联调章节 PDF 已写出 |
| `SMOKE_COMMISSION_3D_OK` | `ticks=57 parts=16` |
| `SMOKE_COMMISSION_3D_SCALE_OK` | `stations=4 actuators=12 sensors=16 parts=16 ticks=57` |
| `SMOKE_DIAGNOSE_OK` | `codes=2`，故障诊断卡片 |
| `SMOKE_UI_OK` | `stations=2 tags=8 packs=8 parts=55 overlay=1`，工厂/数据包/覆盖层 |
| `SMOKE_PLCGEN_OK` | `files=5 tags=32`，基础 ST 五文件 |
| `SMOKE_PLCGEN_SEQ_OK` | `files=11 steps=2`，11 文件与自动序列 |
| `SMOKE_PLCGEN_SIM_OK` | `steps=6 ok=1 alarms=0`，内置模拟器 |
| `SMOKE_PLCGEN_UI_OK` | `files=11 history=1`，面板预检/生成/历史 |
| `SMOKE_PLCGEN_UI_SKIP` | 无机型配置时的条件跳过分支 |
| `SMOKE_PARAMETRIC_SIDECAR_OK` | `status=ready fake=1`（设置 `AUTOMATIONCAD_PARAMETRIC_CMD` 时） |
| `SMOKE_PARAMETRIC_UI_OK` | `features=2 status=ready`（假 sidecar） |
| `SMOKE_PARAMETRIC_ASSEMBLY_OK` | `solids=2 bomRows=3`（假 sidecar 多实体） |
| `SMOKE_PARAMETRIC_SIDECAR_SKIP` | 未设置 fake sidecar 时的条件跳过分支 |
| `SMOKE_PARAMETRIC_UI_SKIP` | 未设置 fake sidecar 时的条件跳过分支 |
| `SMOKE_ELEC_LIB_OK` | `parts=377 categories=26 symbols=219` |
| `SMOKE_ENCLOSURE_CANVAS_OK` | `placed=2 overlap=1 ratio>0` |
| `SMOKE_ELEC_CHECK_OK` | `findings=4 errors=3`，线号/功率/截面规则 |
| `SMOKE_ELEC_CHECK_UI_OK` | `rows=4 cards=9 pdf=true` |
| `SMOKE_COST_OK` | `lines=6 missing=1 grand=1398.64` |
| `SMOKE_COST_AGENT_OK` | `bomSource=argument lines=6 missing=1 grand=1398.64` |
| `SMOKE_COST_AGENT_EXPORT_OK` | `format=csv bytes=737 name=sanitized` |
| `SMOKE_COST_UI_OK` | `rows=6 cards=9 grand=1398.64 book=6 pdf=1` |
| `SMOKE_AGENT_TOOLS_OK` | `tools=20 implemented=20` |
| `SMOKE_AGENT_TOOLS_V2` | `tools=20`，新增工具全部注册 |
| `SMOKE_MACHINE_DESIGN_OK` | `stations=3 actuators=6 sensors=3 warnings=2 form=linear-4`，覆盖 3 工位、按 18.87 件/分钟给出缺口 |
| `SMOKE_MACHINE_CYCLE_OK` | `mode=cell throughput=32 meets=1`，六工位双轨 `(3.18 + 0.60) / 2` 秒/件 |
| `SMOKE_MACHINE_TEMPLATES_OK` | `templates=5 clarify=1 multi=1`，五类工艺模板与追问上限 |
| `SMOKE_MACHINE_GEOMETRY_OK` | `layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56`，参数化整机几何 |
| `SMOKE_MACHINE_APPLY_OK` | `machine=design-screw-3st stations=3 bom=5 undo=1`，方案落盘、3D/BOM/PLC 联动与撤销 |
| `SMOKE_AGENT_KB_OK` | `docs=13 chunks=354 query=D2 hits=1`，离线知识索引可检索 |
| `SMOKE_AGENT_BRIDGE_OK` | `scene=1 bom=1`，渲染桥读取 |
| `SMOKE_ORBIT_VIEW_OK` | `mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`，主视口 3D 降级路径 |
| `SMOKE_AGENT_CHAT_UI_OK` | `fields=6 log=1` |
| `SMOKE_AGENT_READONLY_UI_OK` | `preview=2 offline=1 rows=2 summary=ok scene=0` |
| `SMOKE_AGENT_NL_OK` | `intents=7 tools=20 audit=3 ctx=595` |
| `SMOKE_AGENT_PLACE_OK` | `placed=1 undo=1` |
| `SMOKE_AGENT_PLAN_OK` | `steps=3 confirm=1` |
| `SMOKE_PROTO_INSERT_OK` | `parts=7→8 dof=+2` |
| `SMOKE_PROTO_UNDO_OK` | `parts=8→7` |
| `SMOKE_PROTO_REDO_OK` | `parts=7→8` |
| `SMOKE_SYNC_PACKAGE_OK` | `files=4 sha=1`，设计包固定产物与指纹 |
| `SMOKE_SYNC_UI_OK` | `fields=8 apiKey=password enabled=checkbox` |
| `SMOKE_OK` | 全部 smoke 分支完成后输出 |

## 模块状态（P1–P9）

图例：✅ 完成；🔄 主体完成、仍有明确待办；⏸ 暂停/未启动。

| 阶段 | 状态 | 范围 | 提交号 | 备注 |
|------|------|------|--------|------|
| P1 电气智能辅助 | ✅ | 线号合规、功率统计、导线截面/断路器校验、面板与 PDF、Agent 工具 | `5352832`、`652e031` | 规则与面板闭环 |
| P2 电箱底板画布 | ✅ | 真实尺寸布局、拖放、导轨吸附、碰撞、利用率 | `df8f1a2` | 尺寸覆盖 244/371（16 条同系列推定） |
| P3 联调 3D 通用化 | ✅ | 配置驱动 4 工位 / 12 执行机构 / 16 传感器；运动学标注与滑块预览 | `8d5835d`、`b0e6df3`、`71b5e18` | STEP 无运动学时需人工标注 |
| P4 大模型性能 | ✅ | 渲染规划（合批/视锥/LOD）与视图器接入、10 万面基准 | `f6962b3`、`71c0e9b` | 纯函数规划 + 批次层 |
| P5 智慧工厂服务端 | 🔄 | 设计包 ZIP/manifest/幂等/上传/列表/diff/下载；本地端到端 | `0a1733e`、`ce11575` | 生产实例不可达，待 D2 |
| P6 硬件成本统计 | 🔄 | 价格簿、引擎、面板、A4/CSV 导出、Agent 工具与落盘 | `a8c1e5f`、`6d70ae7`、`a66b26e`、`23cd284` | P6-5 采购价对接待 D2 |
| P7 自然语言交互 Agent | ✅ | 离线路由、上下文裁剪、审计、只读问答、底板放置、多步规划、工具扩展、本地知识检索、机型方案合成与落盘联动 | `424711c`、`b3b9aee`、`1c356e9`、`e70ef77` | 21 工具（只读 11 / 写 10）；真实模型仅按 OpenAI 兼容协议验证 |
| P8 PLC 程序生成 | 🔄 | 预检、变量表、五个基础块、自动序列/报警/安全、11 文件、UI/zip/历史、模拟器 | `b36635b`、`ccbd0fc`、`1f50bac`、`a6b0534` | P8-5 厂商工程文件未做 |
| P9 参数化建模 | 🔄 | build123d sidecar、特征树、防抖重建、STEP/STL、多实体装配与 BOM/成本联动 | `5c2a8c3`、`9eda660`、`8867853`、`449d060` | P9-4 草图约束未做；依赖 Python |

补充：P10 产品截图更新已完成（`e409ea8`）；机型全流程截图新增 15–18，共 18 张 Electron 实跑截图位于 `docs/desktop/screenshots/`。六工位案例见 [MACHINE-DESIGN-DEMO.md](MACHINE-DESIGN-DEMO.md)。

## 已知限制

1. **参数化内核依赖 Python**：build123d sidecar 需要本机 Python 与 `spike/build123d/app.py`；安装包只带脚本，不内置解释器。未设置 `AUTOMATIONCAD_PYTHON` 或 PATH 不可用时，参数化面板返回不可用状态。
2. **价格簿为示例价**：内置价格簿条目标注「示例，需替换」，引擎自动排除示例价；正式报价前必须导入企业价格表（D1）。
3. **运动学需人工标注**：STEP/IGES/BREP 不含动件、轴、行程与 IO 绑定；未标注时 3D 联调回退到机型配置，不能从几何自动推导。
4. **生产环境不可达**：设计同步后端 0.22.0 已实现并通过 30 项测试，本地临时 DB 端到端通过；生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署/HTTPS/真实网络未验证（D2）。
5. **生产安装包未签名/更新未验收**：更新通道 MVP 已接入，但本地没有真实 Windows Authenticode 凭据；tag 发布会因缺少 `CSC_LINK` / `CSC_KEY_PASSWORD` 安全阻断。尚未在 Windows 上完成签名者、SHA-512、stable/beta、NSIS blockmap 差分与完整包回退的真实升级验收；详见 [update-channel.md](../../desktop/docs/update-channel.md)。
6. **工业协议未接真机**：OPC UA 仅 `SecurityPolicy=None`；MQTT 未连真实 broker；Modbus TCP 未连真机（仿真器已实测）。
7. **干涉为 AABB 初筛**：不是精确布尔求交；贴合面、螺纹啮合可能误报，需要白名单收口。
8. **智能体真实模型兼容性有限**：只按 OpenAI 兼容协议、用本地假服务验证；不同服务商差异需逐个补测。离线路由是关键词规则，不是语义理解。
9. **审计不轮转**：`agent-audit.jsonl` 只追加，未做轮转与保留期清理；审计面板只列最近 8 条，无筛选/导出，回执不含 token 用量。
10. **CI 仅手动触发**：`gh workflow run windows-build --ref main`；未配置 push/PR 自动构建。
11. **便携包偏大**：Electron 45 + node-opcua，解压后数百 MB；可考虑按需懒加载或 sidecar。
12. **原型固有投影限制（桌面版已部分缓解，35-orbit-view）**：有 WebGL 时主视口为可旋转 three.js，属性编辑沿叠放链改几何；仍是参数化示意体而非 B-rep，插入件为示意占位体；无 WebGL 时回到固定等轴测。
13. **无 WebGL 的 headless 截图**：xvfb 下 Chromium 将 WebGL 列入 blocklist，CAD 3D 区域显示解析统计降级面板；参数化/PLC/成本/底板面板仍为真实 DOM/SVG 渲染。

## 待决策索引（D1–D8）

完整选项、影响与建议见 [BACKLOG.md](BACKLOG.md) 的「待决策」表。

| # | 待决策 | 状态 |
|---|--------|------|
| D1 | 价格簿真实单价来源 | 待定 |
| D2 | 智慧工厂生产环境由谁部署 0.22.0 | 待定 |
| D3 | PLC 程序生成首期目标平台 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | 待定 |
| D5 | 缺失尺寸能否用同系列壳体推定 | 待定 |
| D6 | 参数化建模首期范围 | 待定 |
| D7 | 成本面板的 CAD 零件名 → 物料号映射口径 | 待定 |
| D8 | Agent 是否允许落盘导出成本报告 | 已定 B，已实现（`23cd284`） |

BACKLOG 另含 D9（离线规则是否在模型可用时前置）与 D10（评估集跑基线的通道），本轮未改变其状态。

## 验证命令速查

```bash
cd desktop
npx tsc --noEmit                    # 类型检查
npm test                            # 1800 条单测/集成测试
npm run build:ext                   # tsc + Vite + Electron main/preload + MCP
npm run smoke                       # xvfb + Electron headless（无 WebGL）
AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
npm run eval:agent                  # 74 条中文 Agent 评估集
npm run sync:e2e                    # 本地临时 DB 的设计同步端到端
npm run screenshots                 # 真实 Electron 截图（14 张）
npm run screenshots:machine         # 机型全流程截图（15–18，离线桩 + 真实 Electron）
```

本轮加固的逐项代码改动与原因见 [HARDENING.md](HARDENING.md)。
