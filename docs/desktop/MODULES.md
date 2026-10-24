# 模块索引与维护约定

本目录记录**每个模块的数据结构、坑点、进度、待办**。每个模块自己的文档放在该模块目录下的 `MODULE.md`，本页只做索引与跨模块关系。

## 索引

| 模块 | 文档 | 一句话职责 |
|------|------|-----------|
| 网页原型（根目录） | [PROTOTYPE.md](PROTOTYPE.md) | 视觉与交互基座，双击即开，桌面版直接加载 |
| Electron 主进程 | [desktop/electron/MODULE.md](../../desktop/electron/MODULE.md) | 窗口、菜单、IPC、Agent 启动、打包路径 |
| CAD 查看 | [desktop/src/cad/MODULE.md](../../desktop/src/cad/MODULE.md) | STEP/IGES/STL/OBJ/GLTF 解析与 three.js 渲染、运动学标注层与自动识别建议（名称/型号 + 层级 + 几何，需逐条确认） |
| CAD 参数化导入与重建 | [desktop/src/parametric/MODULE.md](../../desktop/src/parametric/MODULE.md) | 可选 `cad.parametric-import`（v1.0.0 / API 1）；控制参数化特征树编辑、sidecar 重建与 STEP/STL 导出；关闭不禁用 STEP/IGES/CAD 只读查看，不删除特征树、原 CAD 或叠加体 |
| 客户可选模块注册与启停 | [desktop/src/modules/MODULE.md](../../desktop/src/modules/MODULE.md) | 内置模块 ID/API/依赖/能力目录、默认状态、持久化开关与跨 renderer/主进程门控边界 |
| Windows 应用内更新 | [desktop/docs/update-channel.md](../../desktop/docs/update-channel.md) | 可选 `system.update`（v1.0.0 / API 1）；稳定/测试渠道、显式下载与确认安装、NSIS blockmap 与签名/完整性发布门禁 |
| 可移植工程档案 | [desktop/src/project-archive/MODULE.md](../../desktop/src/project-archive/MODULE.md) | 可选 `project.portable` v2.0.0；stable project ID/source hash 绑定 schema-v2 状态+CAD 候选档案，strict read-only preview；事务恢复仍未实现 |
| 主视口 3D | [desktop/src/orbit/MODULE.md](../../desktop/src/orbit/MODULE.md) | 原型装配/干涉视口换成可旋转 three.js：标准视图、透视/正交、适合、树↔3D 选择、属性编辑改几何、剖切与包围盒干涉叠加；WebGL 不可用退回原型等轴测 |
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

## 当前总体进度（2026-10-24）

- ✅ v0.2.0 已发布：GitHub Actions `windows-latest` 产出 NSIS 安装包（手动触发 `workflow_dispatch`）
- ✅ 最新 `main` 基线上 `TZ=UTC npm test` 1800/1800、`npm run build:ext` 及 fake-sidecar Electron headless smoke 全部通过（最终 `SMOKE_OK`）；本轮详细记录见 [STATUS.md](./STATUS.md)。
- ✅ CAD 轻量化查看（STEP 实测 18 零件 / 5,040 面 / 559 ms）、WebGL 降级
- ✅ 数据包机制 + 面板 + Agent 检索；iec-cn 电气元件库（377 型号 / 26 分类 / 219 带符号）；内置包扩至 10 个：servo-cn / sensor-cn / pneumatic-cn / vision-cn（32）/ drive-cn（33）/ safety-cn（33，28 实型号 + 5 alias）/ frame-cn（33），启动只读 manifest，命中包才加载 `parts.json`；`SMOKE_PACKS_LAZY_OK packs=10 loaded=2`、`SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44 vision=32 drive=33 safety=28 frame=33`、`SMOKE_PACKS_VALIDATE_OK packs=10 errors=0`；`npm run packs:stats` 产出 `PACK-STATS.md` / `pack-stats.json`（617 条 / 612 实型号 / 612 唯一型号 / 55 分类，尺寸 55.9%、价格 7.2%）
- ✅ 机械校核（干涉 AABB + 气缸/悬臂梁/螺栓）与五种导出（PDF / DXF / GLB / OBJ / BOM）
- ✅ 可选 `elec.validation` 与 `cost.estimation` 默认启用；成本模块关闭时面板/Agent/RPC/MCP/专用 PDF/CSV fail-closed、无报告落盘，既有数据/历史保留；普通 BOM、通用导出、机械/电气设计和机型方案估价不受影响
- ✅ 成本 Agent 工具 `run_cost_report`（只读，与面板共用同一份 `CostReport`，明细/缺价窄输出）及 `export_cost_report`（PDF/CSV）；均受 `cost.estimation` 开关控制
- ✅ PLC 抽象 + 仿真/Modbus TCP + 通电联调（6 步 + 3 用例）
- ✅ 可选模块迭代：`commission.io-test` 独立控制上电与标准 IO 用例；`factory.plc-sync` 独立控制同步包 PLC 源码/IO mapping，依赖 `plcgen`；`cad.parametric-import` 独立控制特征树编辑、sidecar 重建和 STEP/STL 导出，关闭保留 CAD 只读查看及现存数据；`project.portable` v2 使用 stable project ID/source SHA 打包可支持的 feature tree、stable-object 运动学、CAD 视角候选与原件，严格预览但不应用/覆盖当前工程；关闭隐藏入口且主进程拒绝文件副作用；事务恢复、异机 CAD 几何复核及 PLC/工厂/Agent 模块数据仍不支持；普通 BOM/PDF/GLB/DXF 包不受影响；PLC 实时连接、读写、监视与强制写入保持独立
- ✅ `system.update` 更新通道 MVP 已接入：stable/beta、手动检查/下载、进度、原生确认后非静默安装；关闭模块会隐藏 UI 并由主进程拒绝所有更新 IPC；GitHub Releases/NSIS blockmap 与缺签名 fail-closed 发布门禁已配置。真实 Windows Authenticode 签名、升级、hash 与差分回退尚未实测；见 [update-channel.md](../../desktop/docs/update-channel.md)
- ✅ PLC 代码生成 P8-1～P8-4：预检 + IO 变量表 + 五个基础块 + 自动序列/报警/安全 FC + mapping + 生成面板 + zip 导出 + 最近 10 次历史；内置模拟器按行程时间执行生成序列，超时/SafeStop/传感器矛盾可验证（11 文件；`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`）
- ✅ 智慧工厂三适配器 + 设计包同步客户端 + 设置页（真实服务端待实现）
- ✅ Agent 写操作（导入/插入/底板放置/修改/移除/撤销/BOM/干涉/PLC 落盘/通用导出）+ MCP 本机代理 + 应用内对话面板
- ✅ Agent 离线规则路由（7 类意图）+ NDJSON 审计（凭据脱敏）；`SMOKE_AGENT_NL_OK intents=7 tools=21 audit=3 ctx=616`、`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=2 form=linear-4`、`SMOKE_MACHINE_CYCLE_OK mode=cell throughput=32 meets=1`、`SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`
- ✅ 侧栏只读问答 UI：计划预览（只读标可离线 / 写操作标需联网并点名缺参）+ 在线离线统一回执 + 审计面板；`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2`
- ✅ 数据包懒加载：`scan()` 只读 manifest；`listParts` 按分类/包名预过滤后 `loadPack`；`unloadPack` 释放；同 id 跨包去重（内置优先）；`getPartById` 懒建全局索引并解析 `aliasOf`；`metrics()` 暴露 `packLoadMs/loadedPacks/partsLoaded/searchMs`，`diagnose` 输出 `packMetrics`。目标实测：冷启动 ≈5 ms、10 包全量搜索 ≤25 ms、单包最大 159.1 KB。
- ✅ P7-B 底板放置：`place_component`（坐标/旋转/导轨吸附、越界与重叠告警）+ 撤销回滚；`SMOKE_AGENT_PLACE_OK placed=1 undo=1`
- ✅ P7-C 多步规划与执行：`planner.ts` 五类离线组合 + 通用拆句、未知工具过滤/拒绝、`executePlan` 写步骤一次确认与失败停止；侧栏计划卡片支持全部/逐步/取消；`SMOKE_AGENT_PLAN_OK steps=3 confirm=1`
- ✅ P7-D Agent 工具扩展 v1：注册表 12 → 17；新增 `get_project_context`（只读、缺失返回 null）、`update_component` / `remove_component`（可撤销）、`run_plc_generate`（预检失败不落盘）、`export_files`（pdf/dxf/glb/bom 共用净化与冲突规则）；MCP/RPC/UI 共用同一注册表，新增 30 条单测
- ✅ P7-E Agent 上下文与指代：结构化快照 ≤1.5 KB、选中/最近操作/几何三级指代（<0.6 不猜）、最近 5 次工具会话记忆、列表 20 条/文本 2 KB/结果 10 KB 裁剪；`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`
- ✅ P7-F Agent 交互体验：工具执行前 n/N + 脱敏参数、500 ms 秒表、10 s 可取消提示、结果卡片与连续 3 步耗时；`AbortController` 取消对话/计划并区分「未写入」与已完成写步骤；`suggest.ts` 六类错误码建议 + 未知码回落；审计按工具/结果筛选、CSV 导出、单条完整 JSON、最近 200 条上限；`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- ✅ P7-H Agent 主动建议：`advisor.ts` 纯函数输入 `AgentContext` + 项目状态摘要，输出 0–3 条 `{id,title,why,action,weight}`；覆盖底板重叠、电气校验未通过、干涉命中/未检查、缺尺寸、成本过期、PLC 未生成、全部就绪交付；侧栏顶部卡片支持 ask 填入输入框、tool 走单步计划确认、本次会话忽略，工具执行后非阻塞刷新；`SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`，单测 21 条
- ✅ P7-I Agent 可复用流程：`recipes.ts` 内置 5 个纯数据模板（新机台快速起步 / 底板布置交付 / 电气交付 / 成本核对 / 整包交付），步骤全部引用注册表内工具，参数支持 `{from:'context.machine.name'}` 点路径占位符；`runRecipe` 前置条件拦截、步骤可跳过、写工具逐次确认（可选同类免问，默认关）、失败停止并保留已完成、总/分步耗时、Markdown 执行记录；侧栏「流程」下拉预览 + 分步进度 + 导出；`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`，单测 29 条
- ✅ P7-J Agent 工具调用纠错：`repair.ts` 纯函数剥离围栏/解释文字、修单引号/尾逗号/注释、单位数字与字符串布尔/整数、截断补全（限 3 层）、未知字段删除、`partId` 从选中对象回填；修复后必须过 schema，首个错误给中文路径（如「参数 qty 应为整数，收到 "3 个"」），非法值不猜。`retry.ts` 首次失败带原因重试 1 次，仍失败回落两条可点击候选；审计新增 `retries/reason/repairs`；LLM 客户端默认 `response_format=json_object` 并在端点不支持时自动降级。`SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`
- ✅ 会话安全策略：`policy.ts` 的 `detectBypassIntent` / `sanitizeConfirmationClaims` / `checkExportTargetPath`；`AgentSession.executeTool` 对写工具强制确认、拒绝后同名写工具本轮短路并审计 `BYPASS_ATTEMPT`；导出只接受纯文件名，绝对路径/盘符/UNC/`../` 返回 `TARGET_PATH_UNSUPPORTED`，`allowSanitize=true` 才净化落盘并标记 `sanitized:true`；`SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1`
- ✅ 多轮与续跑（P7-L）：`src/agent/thread.ts` 维护 turn/意图/目标/已完成步骤/未确认操作；工程指纹（机型+BOM 行数+底板放置数+CAD）变化时提示「工程已变化，不要沿用旧结论」；`runPlan({resumeFrom})` 跳过已完成步骤，指纹变化拒绝续跑并列出差异；确认超时/取消进 `pendingConfirm`，用户拒绝不自动重试；`SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`
- ✅ 执行效率（P7-N）：`dedupe.ts` 同轮 `(tool, canonicalArgs)` 合并、写工具永不合并、单轮 12 次上限返回 `TOO_MANY_TOOL_CALLS`；`parallel.ts` 无依赖只读默认 3 路并发、写工具屏障、参数依赖降级串行、失败不吞且结果按原顺序；`cache.ts` 对 `get_bom` / `get_project_context` / `list_components` 按工程指纹缓存 30 秒，写后清空，命中审计 `cacheHit:true` 且 UI 显示「已复用」；新增 33 条单测，`SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`
- ✅ 上下文预算与成本（P7-M）：`src/agent/budget.ts` 纯函数估算中英文字符（1.6 / 4）、按六档装包，默认 12k tokens，超限先保留长列表首尾各 5 条 + total、再丢最旧 history，system 永不裁剪；`session.ts` 记录端点 usage 或回落估算，累计本轮/本会话 tokens；`pricing.json` 提供元/千 tokens 单价，未知模型显示 `—`；审计新增 `promptTokens/completionTokens/estimated/docsSources`；侧栏底部显示本轮/本会话 tokens 与费用；`SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`
- ✅ 本地知识检索（离线 RAG）：`src/agent/kb/index.ts` 在构建期按标题切分 13 份文档（≤800 字符/块）、附截图索引与元件分类，输出 `kb.json`（≤400 KB，超限保留前 200 块并记录；BACKLOG 只留最近一轮，历史移入不入索引的 BACKLOG-HISTORY.md，单测守 5% 余量）；`search.ts` 用中文 2-gram + 英文词与简化 BM25/IDF 检索，top 3、无命中返回空、注入 ≤2 KB；工具 `search_docs` 与机型方案 `design_machine` 均为只读，加写工具后总数 21（只读 11 + 写 10，含运动件识别 `suggest_kinematics`），MCP/RPC/UI 共用注册表；`npm run kb:build` 重建，单测比对标题 hash 防止文档改动未重建；`SMOKE_AGENT_KB_OK docs=13 chunks=354 query=D2 hits=1`
- ✅ 机型方案落盘与联动：`apply_machine_design` 支持 `brief` / 完整 `design` 二选一，校验后写 `userData/machine/<id>.json` 与 `active.json`；默认追加 BOM 行（来源 `machine-design`、缺型号写「模型待定」），可选生成 `exports/plc/<id>/io-map.csv`；渲染层重建 3D 配置，`undo_last` 恢复上一 active 方案、BOM 批次与 PLC 文件；`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=5 undo=1`
- ✅ 整机形态库：`forms.ts` 定义 `dial-6` / `dial-8` / `linear-4` / `linear-8` / `gantry-2` / `dual-lane` / `gantry-4` / `hybrid-dial-linear` / `cell-4` / `linear-12` / `dial-12` 十一种形态，`pickForm` 先把需求夹紧到形态能力再预演，按「覆盖且达标 → 仅覆盖 → 仅达标（确无覆盖时）→ 全量按工位距离」四档选型，返回两条备选与产能缺口 warning；`synthMachine` 用形态 layout/分度/转移/lanes 参数建 FlowModel，按夹紧后的工位数生成配置，几何按 `form.geometry` 生成 dial/linear/gantry/dual/hybrid/cell，落盘写 `form.id`；`SMOKE_MACHINE_FORMS_OK forms=11 picked=dial-12 meets=1`
- ✅ 迭代 34 机型参数化几何：纯函数 `generateMachineGeometry` 由 `MachineConfig` / `MachineDesign` 生成带 mm 尺寸的整机（分度转盘 / 直线输送 / 龙门 / 双轨 / 单工位），运动件带轴向/行程/点位元数据；3D 联调改为渲染该几何并按 `MachineMotion` 驱动；`apply_machine_design` 默认落盘 geometry.json / model.stl / model.gltf / sidecar-assembly.json，`withSolids` 在 build123d 内核就绪时实体化为 STEP、否则回退 TS 网格；`SMOKE_MACHINE_GEOMETRY_OK layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56`
- ✅ 主视口可旋转 3D（35-orbit-view）：`src/orbit/` 注入扩展替换原型装配/干涉视口的固定等轴测（原型零改动）；轨道/缩放/平移、前/顶/右/等轴测、透视↔正交、适合（F）、树↔3D 选择同步、属性编辑（原型缸径/行程 + 桌面版尺寸/位置）沿叠放链改几何、干涉视图问题件高亮 + 剖切裁剪 + 包围盒初筛叠加；WebGL 不可用保留原型 SVG。38 条单测；`SMOKE_ORBIT_VIEW_OK mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`；WebGL 路径 `npm run check:orbit-webgl` → `ORBIT_WEBGL_OK`
- ✅ 机型设计完整案例：六工位锁螺丝机真实解析出 6 工位 / 12 执行机构 / 7 传感器 / 19 点位；按 `dual-lane` 双轨 `cell` 模型，单轨 3.18 秒/件 + 0.60 秒转移、两轨并行后 31.75 件/分钟，满足 20 件/分钟（余量 1.59 倍）；BOM 映射 12 行真实型号（安全光栅初选 F3SG-4SRA0640-14），电气余量均 ≥1.25 倍；新增 CAD 侧栏 BOM / IO 点位页签与 `npm run screenshots:machine` 全流程截图
- ⏳ 真实 PLC 联调、代码签名、设计同步服务端接口

## 参数化建模（P9）

- `desktop/electron/parametric.ts`：sidecar 生命周期（随机端口/令牌、健康检查、30 s 构建超时、10 min 空闲退出、崩溃重启一次、进程树清理）；装配时发送 `{ops, instances}`，单件仍发送 `{ops}`
- `desktop/src/parametric/features.ts`：特征树 `FeatureDoc` + 装配 `AssemblyDoc/PartInstance`、旧文档自动包装、中文全量校验（含实体 id/transform/50 上限）、`compileOps`（单件返回算子数组，装配返回 `{ops,instances}`）、`summarize`
- `desktop/src/parametric/bom.ts`：`toBom`（partId / 未映射名称合并）、UTF-8 BOM CSV、`toCostInput`（未映射行不带 partId，走 `NO_PART_ID`）
- `desktop/src/parametric/model.ts`：特征与实体编辑（新建/删除/上移/下移/抑制/改名/参数/transform）、300 ms 防抖计划、`localStorage` 按 `sourceFile` 分桶、JSON 序列化往返（兼容单件与装配）、特征包围盒与状态文案
- `desktop/src/parametric/ui.ts`：右侧「参数化」抽屉（与运动学二选一）、装配实体区与 BOM 预览、按类型参数表单、逐条校验、重建/STEP/STL/BOM 导出、送成本、保存/载入特征树
- `desktop/src/cad/viewer.ts`：参数化重建后的 STL 载入、旧模型半透明幽灵层（可开关）、特征包围盒高亮
- `spike/build123d/app.py`：Python sidecar（`/health`、`/build`，算子白名单 box/cylinder/holes/slot/fillet；可选 `instances` 多实体独立建模后按 transform 合并）
- 内核选型与分期见 [PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；实测见 [PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)

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

## 维护约定

1. **改模块先改文档**：新增字段/接口时同步更新该模块 `MODULE.md` 的「数据结构」。
2. **坑点只记真实踩过的**，写清现象与解法；不要写泛泛的「注意异常处理」。
3. **进度用 ✅ / ⏳ 标记**，不要写完成日期以外的猜测。
4. **待办按可验证性排序**，每条要能被测试或人工步骤验收。
5. 跨模块的决策写进 `ARCHITECTURE.md`，不要散落在各模块文档里。
