# 模块索引与维护约定

本目录记录**每个模块的数据结构、坑点、进度、待办**。每个模块自己的文档放在该模块目录下的 `MODULE.md`，本页只做索引与跨模块关系。

## 索引

| 模块 | 文档 | 一句话职责 |
|------|------|-----------|
| 网页原型（根目录） | [PROTOTYPE.md](PROTOTYPE.md) | 视觉与交互基座，双击即开，桌面版直接加载 |
| Electron 主进程 | [desktop/electron/MODULE.md](../../desktop/electron/MODULE.md) | 窗口、菜单、IPC、Agent 启动、打包路径 |
| CAD 查看 | [desktop/src/cad/MODULE.md](../../desktop/src/cad/MODULE.md) | STEP/IGES/STL/OBJ/GLTF 解析与 three.js 渲染、运动学标注层与自动识别建议（名称/型号 + 层级 + 几何，需逐条确认） |
| CAD 参数化导入与重建 | [desktop/src/parametric/MODULE.md](../../desktop/src/parametric/MODULE.md) | 可选 `cad.parametric-import`（v1.0.0 / API 1）；控制参数化特征树编辑、sidecar 重建与 STEP/STL 导出；关闭不禁用 STEP/IGES/CAD 只读查看，不删除特征树、原 CAD 或叠加体 |
| FreeCAD 零件工程图 | [desktop/src/drawings/MODULE.md](../../desktop/src/drawings/MODULE.md) | 可选 `drawings.techdraw`（v1.0.0 / API 1，依赖参数化）；特征树逐件 STEP → 独立 freecadcmd TechDraw → PDF/DXF 落工程目录，指纹判过期可一键重出；FreeCAD 未装只禁用出图 |
| 客户可选模块注册与启停 | [desktop/src/modules/MODULE.md](../../desktop/src/modules/MODULE.md) | 内置模块 ID/API/依赖/能力目录、默认状态、持久化开关与跨 renderer/主进程门控边界 |
| Windows 应用内更新 | [desktop/docs/update-channel.md](../../desktop/docs/update-channel.md) | 可选 `system.update`（v1.0.0 / API 1）；稳定/测试渠道、显式下载与确认安装、NSIS blockmap 与签名/完整性发布门禁 |
| 可移植工程档案 | [desktop/src/project-archive/MODULE.md](../../desktop/src/project-archive/MODULE.md) | 可选 `project.portable` v2.0.0；stable project ID/source hash 绑定 schema-v2 状态+CAD 候选档案，strict read-only preview；事务恢复仍未实现 |
| Qt 客户端（新） | [qt-client/README.md](../../qt-client/README.md) | Qt6 壳子 v0.1：FeatureManager 设计树 / PropertyManager 属性面板 / 占位 3D 视口；写操作全部走契约服务，带 `expectedRevision`，409 冲突拒绝覆盖；Linux + Qt 6.4.2 已编译通过、`--selftest` 与 1.5s 自动刷新（`qt-client/tests/watch.mjs`）已验证，Windows 未编译 |
| FeatureTree 契约服务 | [docs/featuretree-contract.md](../featuretree-contract.md) | 只监听 127.0.0.1 的本地服务：字段层 + 整树层校验、乐观锁、原子事务、历史留痕、undo、SSE 变更事件；`tests.mjs` 31 条（含 undo/redo 分支语义）+ `mcp-tests.mjs` 11 条（MCP 双向）+ `build-tests.mjs` 8 条（build123d 真几何：体积/包围盒/质量/fail-closed）；§14 七条全部达成 |
| 主视口 3D | [desktop/src/orbit/MODULE.md](../../desktop/src/orbit/MODULE.md) | 原型装配/干涉视口换成可旋转 three.js：标准视图、透视/正交、适合、树↔3D 选择、属性编辑改几何、剖切与包围盒干涉叠加；WebGL 不可用退回原型等轴测 |
| 整机布局 3D 编辑 | [desktop/src/layout-editor/MODULE.md](../../desktop/src/layout-editor/MODULE.md) | 可选 `design.layout-editor`；向导第 4 步 3D 视口直接选/移/绕 Z 旋转工位、吸附、对齐分布、包络干涉与测量，写回 `MachineDesign.stationGeometryLayout`（v2 平移 / v3 含旋转），撤销并入主视口时间线 |
| 元器件数据包 | [desktop/src/packs/MODULE.md](../../desktop/src/packs/MODULE.md) | manifest-only 索引、`loadPack/unloadPack` 懒加载、跨包去重、partId 全局索引、检索与面板；`validatePack` 全包校验、`partsSha256` 完整性、schema 迁移、依赖与统计报表 |
| 内置包数据 | [packs/builtin/MODULE.md](../../packs/builtin/MODULE.md) | 10 个包：iec-cn 377 / smc-cn 8 / servo-cn 25 / sensor-cn 32 / pneumatic-cn 44 / vision-cn 32 / drive-cn 33 / safety-cn 33（28+5 alias）/ frame-cn 33 + pricebook-cn |
| Agent 接口 | [desktop/src/agent/MODULE.md](../../desktop/src/agent/MODULE.md) | 工具注册表、JSON-RPC、MCP stdio、离线规则路由、多步规划/执行、上下文快照与指代消解、会话记忆、多轮状态/工程指纹/续跑（thread）、本地知识检索（离线 RAG）、结果裁剪、执行进度/取消、失败建议、主动建议（next-best-action）、可复用流程模板（recipes）、模型输出纠错与重试（repair/retry）、确认与导出路径策略（policy）、审计筛选与导出、上下文预算与成本可见性（budget/pricing）、同轮去重（dedupe）、只读并行（parallel）、会话短缓存（cache）、侧栏问答/建议/计划/流程卡片 UI、能力报告与 SVG 一页图（agent-report.mjs） |
| 公共健壮性 / 诊断 / 性能 | [desktop/electron/MODULE.md](../../desktop/electron/MODULE.md)、[PERF.md](PERF.md) | 输入上限、显式资源计数、错误摘要与脱敏、崩溃落盘、性能基线 |
| 智慧工厂 | [desktop/src/factory/MODULE.md](../../desktop/src/factory/MODULE.md) | demo / OPC UA / MQTT 适配器与点位模型 |
| 智慧工厂同步 | [desktop/src/sync/MODULE.md](../../desktop/src/sync/MODULE.md) | 设计包 ZIP、manifest、上传/列表/diff；`factory.plc-sync` 独立控制 PLC 源码/IO mapping 扩展，依赖 `plcgen`，普通设计包不受影响 |
| PLC | [desktop/src/plc/MODULE.md](../../desktop/src/plc/MODULE.md) | sim / Modbus TCP 适配器、28 点位与 plc.json |
| PLC 代码生成 | [desktop/src/plcgen/MODULE.md](../../desktop/src/plcgen/MODULE.md) | 全量预检、IO 变量表 CSV、五个基础块 + 自动序列/报警/安全 FC、mapping、确定性 11 文件汇总、生成面板、zip 导出与历史、内置模拟器 `simulate` / `verifyGenerated` |
| 通电联调 / 可选 IO 测试 | [desktop/src/commission/MODULE.md](../../desktop/src/commission/MODULE.md) | `commission.io-test` 独立开关 6 步上电、3 条 IO 用例与诊断；PLC 实时连接、读写和监视保持独立 |
| 机型方案设计 | [MACHINE-DESIGN.md](MACHINE-DESIGN.md) | 中文需求抽取、`MachineConfig` 方案合成、整机形态库 `forms.ts`（11 种整机形态，含龙门四工位、转盘+直线混合、单元式四工位、8–12 工位长线体/转盘）、并行同工序 / 流水线分工序两套节拍模型、点位/功率/BOM 估算、只读 `design_machine` 与写工具 `apply_machine_design`；落盘、active 指针、3D/BOM/PLC 联动与撤销；`machine/geometry*.ts` 参数化整机几何（机架/底板/门架/气缸/夹爪/旋转台/传感器/光栅/输送线或转盘/多头龙门/混合线/单元矩阵/安全围栏，mm）、STL/glTF 导出与 build123d 实体列表 |
| 机型设计完整案例 | [MACHINE-DESIGN-DEMO.md](MACHINE-DESIGN-DEMO.md) | 六工位锁螺丝机真实解析/合成、节拍与功率计算、同一需求转盘/直线两种形态对比、真实元件包 BOM 映射、19 行 PLC IO 与四张全流程截图 |
| 机械校核 | [desktop/src/mech/MODULE.md](../../desktop/src/mech/MODULE.md) | 包围盒干涉初筛 + 气缸/悬臂梁/螺栓计算 |
| 电气校验 | [desktop/src/elec/MODULE.md](../../desktop/src/elec/MODULE.md) | 可选 `elec.validation`（v1.0.0 / API 1）；规则校验、面板/PDF 与 Agent/MCP；电气原理图、元件库和底板布置独立保留 |
| 成本估算 | [desktop/src/cost/MODULE.md](../../desktop/src/cost/MODULE.md) | 可选 `cost.estimation`（v1.0.0 / API 1）；面板、价格簿读取、A4 PDF/CSV 与 Agent `run_cost_report` / `export_cost_report`；关闭保留数据并不影响普通 BOM/通用导出 |
| 导出 | [desktop/src/export/MODULE.md](../../desktop/src/export/MODULE.md) | PDF 报告 / DXF / GLB / OBJ / BOM |
| 渲染层扩展与面板 | [desktop/src/ui/MODULE.md](../../desktop/src/ui/MODULE.md) | 注入方式、DOM 契约、三块面板 |
| 测试与构建 | [desktop/test/MODULE.md](../../desktop/test/MODULE.md) | 单测/smoke/打包链与证据口径 |

其它文档：需求 `REQUIREMENTS.md`、架构 `ARCHITECTURE.md`、当前状态 `STATUS.md`、CI 启用 `CI.md`、插件格式 `PLUGIN-PACKS.md`、元器件资料 [`../reference/`](../reference/README.md)。项目总览与界面截图见根 [README.md](../../README.md)。

## 截图目录（docs/desktop/screenshots/）

Electron 实跑抓取（共 18 张：`01`–`10` 为 1440×873；`11`–`18` 为 1600×1000），不是设计稿。复现：`cd desktop && npm run screenshots`（xvfb + 真实 Electron + `capturePage`，参数化面板由 `scripts/fake-parametric-sidecar.mjs` 驱动）；机型全流程截图用 `cd desktop && npm run screenshots:machine`（本地脚本化离线桩 + 真实 Electron + SwiftShader WebGL，注入 brief → `design_machine` → 应用 → 3D/BOM/IO）。普通 headless 下 Chromium 把 WebGL 列入 blocklist 时，CAD 3D 区域显示解析统计降级面板；机型 3D 图走 SwiftShader 真实渲染。文件名与内容：

| 文件 | 内容 |
|------|------|
| `01-home.png` | 主界面：原型 8 视图 + 桌面入口（CAD 查看 / 工厂 / 联调 / 数据包 / 电气元件 / 智慧工厂 / 智能体） |
| `02-cad-assembly.png` | CAD 查看：STEP 装配体 18 零件 / 5,040 三角面、零件列表 |
| `03-interference.png` | 干涉检测：28 处候选、按严重度分组、点击定位 |
| `04-stress.png` | 受力分析：气缸推力公式、余量与安全系数 |
| `05-factory.png` | 智慧工厂：demo 适配器连接后 2 工位 × 4 点位实时值 |
| `06-commission.png` | 通电联调：sim 已连接、6 步上电全部通过 |
| `07-packs.png` | 数据包：内置包列表、导入/启停、检索 |
| `08-elec-library.png` | 电气元件库：44 型号 / 12 分类、符号标记与「放入图纸」 |
| `09-agent.png` | 智能体面板：对话、工具、模型设置、本机服务信息 |
| `10-sync-settings.png` | 智慧工厂同步设置：baseUrl / 机台编号 / 项目 / API Key 掩码 |
| `11-plcgen.png` | PLC 程序生成：预检 0 错误、11 文件树、README 预览、生成历史（1600×1000） |
| `12-parametric.png` | 参数化抽屉：4 特征树、孔位参数表单、`就绪 · 面 19 · 体积 71.5 cm³`（1600×1000，假 sidecar） |
| `13-cost.png` | 成本估算：9 张统计卡、6 行明细、缺价 1 项、合计 ¥1,398.64（1600×1000） |
| `14-enclosure.png` | 底板布置：3 个真实尺寸元件、1 处重叠红框/角标、利用率与冲突计数（1600×1000） |
| `15-machine-design-card.png` | 机型方案卡：6 工位、12 执行机构、7 传感器、当前案例 31.75 件/分钟、4628 VA、警告与「应用到工程」（1600×1000；截图为旧版数值） |
| `16-machine-3d.png` | 6 工位 3D 联调：12 个执行机构、7 个传感器，运行若干 tick（1600×1000，SwiftShader WebGL） |
| `17-machine-bom.png` | BOM 面板：12 行，含 SV660P 750 W / MHZ2-20D / D-M9B / SY5120-5LZD 与安全光栅行（1600×1000；截图为补录前版本，仍显示待选型，待有 GUI 时重拍） |
| `18-machine-iomap.png` | PLC IO 面板：19 行（7 输入 + 12 输出），点位与夹爪/旋转轴/传感器对应（1600×1000） |

引用约定：README 与文档一律用**相对仓库根**的路径（如 `docs/desktop/screenshots/01-home.png`），保证 GitHub 上可直接渲染；补拍或替换截图时保持同名覆盖，避免文档批量改链接。

## 跨模块数据流

```
用户操作 ─┬─ 菜单/拖放 ──→ electron/main.ts ──IPC──→ renderer
          ├─ CAD 文件 ──→ readFileBuffer → Worker(occt WASM) → CadImportResult → three 渲染
          ├─ 数据包   ──→ packs/registry（主进程）→ listParts → 面板 / Agent
          ├─ 工厂     ──→ factory/manager → adapters → TagValue → 面板
          └─ 设计同步 ──→ sync/client（主进程）→ /api/v1/design-sync/* → 面板

外部 Agent ──→ agent/rpc.ts 或 mcp.ts ──→ agent/tools.ts ──→ packs/registry（只读）
```

**边界原则**：渲染层无 fs/net 权限；主进程不做几何计算；Agent 与 UI 共用同一份工具/命令注册表。

## 当前总体进度（2026-10-28）

> 逐轮验证数字见 [STATUS.md](./STATUS.md)；历史迭代明细已移入 [BACKLOG-HISTORY.md](./BACKLOG-HISTORY.md)，本处只留能力目录。

- ✅ 基线（`3d5ee07`）：`npx tsc --noEmit` 0 错误、`npm test` 2589（2587 通过 / 2 跳过）、`npm run build:ext` + xvfb smoke 收尾 `SMOKE_OK`、`npm run eval:agent` 111/111（accuracy/tools/refused 全 1.00）；CI 在 push/PR 上自动跑 unit + Electron smoke 两个 job。
- ✅ 设计域：五步向导（`src/design/`：需求 → 3 候选对比 → 工位与元件 → 毫米布局 → 校核/保存工程）；机型方案合成与落盘、11 种整机形态库、参数化整机几何、通用实体建模 `build_machine_model`、标准件拖拽吸附。详见 [DESIGN-WIZARD.md](./DESIGN-WIZARD.md) / [MACHINE-DESIGN.md](./MACHINE-DESIGN.md)。
- ✅ 几何与视口：STEP/IGES/STL/GLTF 解析（STEP 实测 18 零件 / 5,040 面 / 559 ms）、可旋转/正交/剖切视口、运动学标注、参数化特征树（build123d sidecar）、WebGL 降级。
- ✅ 电气与电柜：按工程 BOM 出原理图（电路模型 + ERC + 拓扑布局 + A3 渲染，不可交付时图上直接列问题）、线号/功率/截面/断路器校验、底板毫米画布与导轨碰撞、利用率。
- ✅ 控制：PLC 生成 P8-1～P8-4（预检 / IO 变量表 / 序列·报警·安全 FC / zip / 历史）+ 内置模拟验证；仿真、Modbus TCP、通电联调；OPC UA / MQTT 适配器（仅 SecurityPolicy=None）。
- ✅ 数据与成本：10 个内置包（启动只读 manifest、按需 `loadPack`、跨包去重）+ 用户 ZIP 导入；价格簿数据包 + 纯函数成本引擎（缺价如实报、示例价自动排除）；五种导出（PDF / DXF / GLB / OBJ / BOM）。
- ✅ Agent：离线规则路由 7 类意图 + 多步规划 + 写操作确认/撤销 + NDJSON 审计 + 上下文指代 + 离线知识检索（`kb.json`）；工具清单与数量以 `desktop/src/agent/tools.ts` 注册表为准，MCP / RPC / UI 共用。
- ✅ 可选模块门控（`elec.validation` / `cost.estimation` / `commission.io-test` / `factory.plc-sync` / `cad.parametric-import` / `project.portable` / `system.update` 等）默认启用，关闭时 UI、IPC、Agent、副作用入口一并 fail-closed。
- ⏳ 未完成/未实测：真实 PLC 联调、Windows Authenticode 签名、设计同步服务端部署（生产 221 未确认）、FreeCAD 真实出图（本机无 `freecadcmd`）。

## 参数化建模（P9）

- `desktop/electron/parametric.ts`：sidecar 生命周期（随机端口/令牌、健康检查、30 s 构建超时、10 min 空闲退出、崩溃重启一次、进程树清理）；装配时发送 `{ops, instances}`，单件仍发送 `{ops}`
- `desktop/src/parametric/features.ts`：特征树 `FeatureDoc` + 装配 `AssemblyDoc/PartInstance`、旧文档自动包装、中文全量校验（含实体 id/transform/50 上限）、`compileOps`（单件返回算子数组，装配返回 `{ops,instances}`）、`summarize`
- `desktop/src/parametric/bom.ts`：`toBom`（partId / 未映射名称合并）、UTF-8 BOM CSV、`toCostInput`（未映射行不带 partId，走 `NO_PART_ID`）
- `desktop/src/parametric/model.ts`：特征与实体编辑（新建/删除/上移/下移/抑制/改名/参数/transform）、300 ms 防抖计划、`localStorage` 按 `sourceFile` 分桶、JSON 序列化往返（兼容单件与装配）、特征包围盒与状态文案
- `desktop/src/parametric/ui.ts`：右侧「参数化」抽屉（与运动学二选一）、装配实体区与 BOM 预览、按类型参数表单、逐条校验、重建/STEP/STL/BOM 导出、送成本、保存/载入特征树
- `desktop/src/cad/viewer.ts`：参数化重建后的 STL 载入、旧模型半透明幽灵层（可开关）、特征包围盒高亮
- `spike/build123d/app.py`：Python sidecar（`/health`、`/build`，算子白名单 box/cylinder/holes/slot/fillet；可选 `instances` 多实体独立建模后按 transform 合并）
- 内核选型与分期见 [PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；实测见 [PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)

## FreeCAD 后台任务（工程图第 1 步）

- 分工：build123d sidecar 负责参数化零件/实体化；FreeCAD 1.x 无界面独立进程（`freecadcmd`，LGPL，可选安装）负责 TechDraw 工程图，之后接钣金展开 DXF 与 FEM。两份 OCCT 不进同一 Python 进程，只用 STEP 文件中转；特征树 JSON 是唯一主数据，STEP/PDF/DXF 都是产物。
- `desktop/electron/freecad.ts`：探测（设置路径 → `AUTOMATIONCAD_FREECAD_CMD` → `C:\Program Files\FreeCAD 1.x\bin\freecadcmd.exe` 等 → PATH）、`--version` ≥ 1.0、串行作业队列（超时/取消/进程树清理/stderr 尾部/临时目录必清）。
- `desktop/electron/drawings-service.ts` + `drawings-ipc.ts`：逐件 STEP、工程目录 `drawings/manifest.json`（指纹 + STEP SHA-256）、受信 IPC（renderer 不传路径）。
- `spike/freecad/techdraw_job.py`：A4/A3 自动、GB 比例系列、第一角投影主/俯/左 + 轴测、外形总尺寸、国标标题栏；PDF（Qt）/DXF（TechDraw + 图框标题栏）/SVG。协议与过期判定见 `desktop/src/drawings/`，细节见 [FREECAD-DRAWINGS.md](FREECAD-DRAWINGS.md)。

## Agent 能力报告（汇报）

- 脚本：`desktop/scripts/agent-report.mjs`；命令：`cd desktop && npm run agent:report`。
- 输入：`docs/desktop/eval/agent-live.json`（真实模型单轮 36 条）、`docs/desktop/eval/agent-multiturn.json`（6 个场景）、`docs/desktop/eval/latest.json`（离线 74 条）、`docs/desktop/BACKLOG.md`（已知限制/问题）、`desktop/src/agent/tools.ts`（工具注册表），以及本机 `<userData>/agent-audit.jsonl`（存在才统计）。
- 输出：`docs/desktop/AGENT-REPORT.md`、`docs/desktop/agent-report.json`、`docs/desktop/agent-report.svg`。SVG 为纯代码生成，不截图；深色底、5 组横向条形图 + 工具/测试/单轮/多轮 KPI。
- 一致性：报告 JSON 写出后立即读回比对；`verifyReport` 还会逐项核对总览、分组与离线指标是否等于源 JSON。缺失源文件写「缺失：<文件>」、打印 WARN，退出码 0。
- 测试：`desktop/test/agent/report.test.mjs`（10 条），覆盖真实源数字、源变更传导、篡改拦截、缺源降级、Markdown 来源/时间、SVG 数据驱动、BACKLOG 缺口摘取、md/json/svg 文件产出。
- 审计路径：优先 `AGENT_REPORT_AUDIT_FILE`，其次 `AGENT_REPORT_USER_DATA`，否则按平台默认 `userData/AutomationCAD/agent-audit.jsonl`；目录不可达或文件不存在时跳过并说明。

## 共享健壮性、诊断与性能（2026-10-24）

| 模块 | 职责 | 关键约束 |
|------|------|----------|
| `desktop/src/shared/input-limits.ts` | BOM / STEP / 其它 CAD 文件的硬上限 | BOM 5,000 行、STEP 200 MB、其它 CAD 50 MB；读文件前先 `stat`，超限抛带 `code` 的中文可操作错误，不进入解析器 |
| `desktop/src/shared/diagnostics.ts` | 错误环形缓冲、脱敏、诊断报告与崩溃报告纯函数 | 最近 100 条、输出最多 20 条；`apiKey/token/password/authorization` 等字段与 `sk-…`/`Bearer …` 文本递归脱敏；不保存用户正文 |
| `desktop/src/shared/resources.ts` | 显式 timer 计数 | 测试不依赖 `process._getActiveHandles`；`trackedSetTimeout/trackedSetInterval` 与清理函数成对使用 |
| `desktop/electron/diagnostics.ts` | `--diagnose` 采集 | 版本、WebGL、userData、内置包版本/数量、KB 统计、审计大小、最近 20 条错误；隐藏窗口探测后立即销毁 |
| `desktop/electron/crash-report.ts` | `userData/diagnostics/last-crash.json` | 原子写（tmp + rename）、权限 600、只含堆栈/版本/操作类型，不含用户输入 |
| `desktop/electron/perf-smoke.ts` | headless smoke 性能 workload | 仅在 `--headless-smoke` 动态加载，普通启动不静态引入 three.js |
| `desktop/scripts/perf-baseline.mjs` | 200/1000/3000 件性能基线 | 冷/热构建、场景构建、300 tick、堆峰值；结果写 JSON，分析见 [PERF.md](PERF.md) |

## 界面缩放

- 配置：`desktop/src/shared/appearance.ts` 的 `AppearanceConfig.uiScale` 只接受 `1.0 / 1.1 / 1.15 / 1.25 / 1.4 / 1.5`，缺失或非法值回落 **1.15**；持久化到 `userData/appearance.json`，临时文件 + `rename` 原子写、0600。
- 注入：不改根 `styles.css`；扩展在 `desktop/src/cad.css` 注入 `html { zoom: var(--acad-ui-scale, 1.15) }`，配置经 `appearance:get` / `appearance:set` 下发。
- 入口：智能体面板「界面与渲染」下拉（100%–150%）。变更立即应用并持久化，重启后恢复。
- 布局：`desktop/src/ui/appearance.ts` 写 CSS 变量后调用 `AutomationCadOrbit.resize()` 并派发原型 `resize`，下一帧补一次。

## 3D 渲染质量

- 档位：`desktop/src/orbit/quality.ts` 定义 `flow | standard | high`。`flow` 像素比上限 1.0 且关闭 MSAA；`standard`（默认）上限 1.5；`high` 上限 2.0；后两者开启 MSAA。
- 构造边界：`antialias` 只能在构造 `WebGLRenderer` 时决定。`view.ts` 跨 MSAA 边界时重建 renderer，保留 scene/相机/装配体；同侧仅 `setPixelRatio`。renderer 使用 `powerPreference:'high-performance'`。
- 拖动降级：OrbitControls `start` 把 pixelRatio 设为 **0.8**，`end` 后 200 ms 恢复并重绘；保留 `down` hover raycast 保护。
- 大装配体：零件数 **> 1500** 自动改用 `flow`，诊断返回 `autoDowngraded:true`。
- 配置：`renderQuality` 与 `uiScale` 共用 `appearance.json`；面板显示当前档位、像素比、拖动像素比、抗锯齿与降级原因。
- 指标口径：`glRenderer` 合并 masked/unmasked（取不到用 capabilities），按 `SwiftShader|llvmpipe|Software` 判软件渲染；`dragFrames`/平均/最大帧时间来自 controls `start→end` 相邻渲染帧，`lastDragAt` 为结束时间。拖动结束强制、平时每 5 秒节流上报；主进程快照供 `/health.render` 与 `get_render_stats`，软件渲染自动 `flow` + 可关闭提示。

## 局域网联调

- 入口：智能体面板「局域网联调」。默认关闭，仅监听 `127.0.0.1:7420`；开启后监听 `0.0.0.0:7420`，保存后热重启并显示结果。
- 白名单：`desktop/src/shared/lan-access.ts` 支持 IPv4 CIDR（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、单 IP（`192.168.2.117`）与 `::1`，逗号/换行分隔。回环永远放行；非白名单返回 `403 { ok:false, error:'LAN_NOT_ALLOWED' }` 并审计。非法 CIDR 中文报错且不落盘。
- 配置：默认 `{ enabled:false, allowlist:['192.168.0.0/16'], cdpEnabled:false }`，写入 `userData/lan-access.json`（0600、原子）。token 在 `<userData>/agent-token`：启动时合法 48 位 `[A-Za-z0-9]` 直接复用，缺失/损坏才原子重建（0600）；面板「重新生成 token」经 `lan:rotate-token` 强制轮换并重启服务，旧 token 立即 401。
- 审计：`agent-audit.jsonl` 增加 `remoteAddress` 与 `origin`（`local | lan`）。写工具仍须桌面本机确认，远程不能静默写。
- 健康检查：`GET /health` 返回 `{ ok, version, toolCount, host, port, lanEnabled, allowlist, cdpPort, render }`，不含 token；`render` 与 `get_render_stats` 同口径。端口冲突返回中文错误。
- CDP 转发：Electron 调试器只监听 `127.0.0.1:9229`；`cdpEnabled && enabled` 时 `cdp-forwarder` 在 `0.0.0.0:9222` 双向 pipe 到 9229，关闭即停，保存配置热启停。来源复用 `isAddressAllowed` / `normalizeRemoteAddress`，拒绝立即销毁并审计 `cdp_access_check` / `LAN_NOT_ALLOWED`；端口占用返回中文错误且不影响主窗口。`cdpActive` = 转发器在跑且 9229 可连，面板显示 `<局域网IP>:9222`。
- 探测脚本：`desktop/scripts/lan-debug-probe.mjs`，`--token-file` 优先于 `--token`：

```bash
cd desktop
node scripts/lan-debug-probe.mjs \
  --url http://192.168.2.10:7420 \
  --token-file "$HOME/.config/AutomationCAD/agent-token"
```

脚本请求 `/health`、`tools/list` 与只读 `list_components`（`limit:3`），成功输出 `LAN_DEBUG_OK`；失败中文报错并返回非 0。集成测试会启动临时服务真实执行。

## 维护约定

1. **改模块先改文档**：新增字段/接口时同步更新该模块 `MODULE.md` 的「数据结构」。
2. **坑点只记真实踩过的**，写清现象与解法；不要写泛泛的「注意异常处理」。
3. **进度用 ✅ / ⏳ 标记**，不要写完成日期以外的猜测。
4. **待办按可验证性排序**，每条要能被测试或人工步骤验收。
5. 跨模块的决策写进 `ARCHITECTURE.md`，不要散落在各模块文档里。
