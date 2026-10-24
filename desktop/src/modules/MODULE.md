# 模块注册与客户启停

## 当前切片

- `registry.ts` 定义应用内置模块目录、模块状态接口、API 兼容范围、依赖、能力要求与状态解析。未知模块、未实现模块、缺少依赖/能力或 API 不兼容均不能启用。
- `ui.ts` 提供始终可见的「模块设置」入口。客户可查看模块 ID、版本、API 兼容范围、依赖、能力、说明、状态和不可用原因。
- 设置存于 Electron 本机 `localStorage` 键 `automationcad.modules.v1`（版本化 JSON，只保存状态覆盖项）。缺少记录时采用模块默认状态；`plcgen`、`elec.validation`、`cost.estimation`、`factory.plc-sync`、`cad.parametric-import`、`parametric.history`、`agent.resume`、`project.portable` 与 `system.update` 默认启用以兼容当前工作流，`core` 固定启用。
- `elec.validation`（v1.0.0，API 1，依赖 `core`）要求 `elec.validation.rules`、`elec.validation.panel`、`agent.electrical-check` 与 `elec.validation.report.export`。它控制电气规则面板/报告及 `run_electrical_check` Agent、命令总线、JSON-RPC、离线执行和 MCP 入口；工具清单动态隐藏，旧工具名、命令直调及桌面不可达时的 MCP 本地回退均不能绕过门禁。renderer 状态须同步获主进程接受，主进程命令总线和 Agent/RPC 使用同一状态；状态不明时拒绝执行。关闭会隐藏并关闭校验面板，运行/PDF API 返回 `MODULE_DISABLED`，不删除电气原理图、元件库、底板布置、项目数据或 Agent 审计历史；重新启用后校验恢复。
- `cost.estimation`（v1.0.0，API 1，依赖 `core`）要求 `cost.estimation.calculate`、`cost.estimation.panel`、`cost.estimation.agent`、`cost.estimation.report.export` 与 `cost.estimation.pricebook.read`。它控制成本面板、成本专用 PDF/CSV、价格簿读取及 `run_cost_report` / `export_cost_report` 的 Agent、命令总线、JSON-RPC 与 MCP 入口；关闭时隐藏工具，直接调用 fail-closed 返回 `MODULE_DISABLED`，桌面/MCP 不可达时不进行本地成本回退。renderer 状态经可信同步 IPC 进入主进程，计算和报告落盘前多层复核。关闭不计算新成本、不写成本报告，也不清理既有价格簿、成本/Agent 历史、BOM 或项目数据；重开恢复。普通 BOM 读取、通用文件/报告导出、机械/电气设计和其他 Agent 工具不依赖此模块。
- `plcgen` 控制 PLC 程序面板及 Agent 的 `verify_plc_program`、`run_plc_generate`、本地 PLC 文件导出与生成历史写入。渲染端通过受限同步 IPC 镜像模块状态；Agent 工具清单按当前状态过滤，旧工具名调用与命令总线直调均在执行前返回 `MODULE_DISABLED`。JSON-RPC 列表/调用复用该门禁；MCP 代理实时读取桌面工具清单，桌面不可达时隐藏 PLC 工具且不回退本地执行。
- `factory.plc-sync` 独立控制设计同步包里的 PLC 源码和机型 IO mapping，依赖 `plcgen`，要求 `sync.design-package` 与 `machine.io-map` 能力。关闭时 renderer 不构造 PLC payload；主进程在上传入口、ZIP 构建前及网络上传前复核状态；下载端仍接受不含 PLC 扩展的普通设计包，但拒绝返回任何 PLC 候选。普通 BOM/PDF/GLB/DXF 同步不依赖此开关。依赖的 `plcgen` 关闭时该扩展自动标记不可用并拒绝启用/执行。
- `cad.parametric-import`（v1.0.0，API 1，依赖 `core`）控制参数化特征树编辑、sidecar 重建及 STEP/STL 导出；`core` 的 STEP/IGES/BREP/STL/OBJ/GLTF/GLB 只读查看和原始导入几何不受影响。关闭时隐藏参数化入口、收起面板并停止正在运行的内核；renderer、Electron IPC、sidecar manager 与 Agent `apply_machine_design.withSolids` 均在执行/写文件前检查模块状态。仅保存设置覆盖项，不改工程数据；关闭不会删除特征树、原 CAD 文件或叠加体，重新启用后可继续操作。未识别 STEP 特征不会自动变成可编辑特征。
- `parametric.history`（v1.0.0，API 1，依赖 `core` 与 `cad.parametric-import`，能力 `cad.parametric.undo-redo`）仅控制参数化特征树 undo/redo 控件及程序化入口，默认启用。关闭只隐藏/禁用 undo、redo，不改树、模型或当前会话栈；关闭期间的正常编辑仍记录历史，重新启用后同一会话可继续撤销/重做。父 `cad.parametric-import` 关闭时该模块始终 `unavailable`；它不拦截服务于其它编辑域的共享 Ctrl+Z/Ctrl+Y。
- `agent.resume`（v1.0.0，API 1，依赖 `core`，能力 `agent.plan.checkpoint` 与 `agent.plan.cross-restart-resume`）控制跨重启 Agent 计划 checkpoint 与恢复 UI，默认启用。关闭后主进程和 renderer 均不创建、读取、覆盖或删除 checkpoint；已保存记录保留但不可用。普通 Agent 计划、当前会话逐步执行和写操作原生确认不受影响；重新启用后仍须验证 schema、签名、强工程指纹、步骤游标及写副作用，并等待用户显式确认继续。
- `project.portable`（v2.0.0，API 1–2，依赖 `core`，要求 `project.identity.stable`、`project.archive.snapshot.export`、`project.archive.preview` 与 `project.archive.candidate-only`）默认启用。它以持久 project ID 和 CAD 原件 SHA-256 绑定 schema v2 `.acproj`，可收录当前可安全取得的特征树、带 stable objectId 的运动学 v2、CAD 视角快照和原始 CAD；导出时用户仍须选择 CAD 原件，且必须与活动来源文件名、SHA-256 和字节数匹配。稳定身份不可用时导出按钮禁用；不支持的字段会列出排除原因。档案导入严格校验后只展示摘要，不覆盖或应用当前工程；运动学跨机器 CAD 几何重验证、状态事务应用、PLC/工厂/Agent/围栏状态和生成网格缓存尚不支持。关闭会隐藏入口并由主进程拒绝档案读取/写入，既有状态与档案保留。
- 以上可选模块不删除其负责的数据、历史或导出文件；状态变化即时推送主进程，不需重载应用。参数化关闭会停止运行中的 sidecar，但不触碰已生成文件或叠加体。
- `system.update`（v1.0.0，API 1，依赖 `core`）控制 Windows NSIS 的 stable/beta 更新面板、检查、手动下载、渠道选择、状态事件及安装入口。下载完成后仍必须先点击安装，再通过主进程原生确认框；不静默安装或退出时自动安装。关闭会隐藏入口、关闭弹窗、退订 renderer 状态，并由主进程在每个更新 IPC 副作用前拒绝请求；重开后按原流程继续。Core 不随模块开关关闭：主进程仍检查固定 GitHub feed 和非空 Authenticode `publisherName`，缺失或不匹配时 fail-closed；electron-updater 保留 SHA-512 完整包校验与 NSIS blockmap 差分/完整包回退。真实 Windows 签名与升级尚未验收，细节见 [`desktop/docs/update-channel.md`](../../docs/update-channel.md)。

## 注册约定

每个模块必须声明稳定 ID、版本、支持的模块 API 版本区间、依赖模块 ID、所需能力和面向客户的说明。核心模块不可关闭。可选模块的启用请求经过 API 兼容、能力和依赖校验；状态 API 对未知 ID 返回 `unavailable`，写接口拒绝未知 ID。只有随应用内置的模块能进入注册表；本切片不提供单独在线安装、授权或付费状态，也不声称关闭即卸载代码。

`window.__ModuleRegistry` 暴露 `list()`、`getStatus(id)` 和受验证的 `setEnabled(id, enabled)`。扩展内部模块状态保存在单一 manager；各模块的 UI、工具及主进程实际读写边界应共同复核模块状态，避免仅隐藏入口而允许调用脚本接口。

## 尚未迁移

目前已注册 `core`、`plcgen`、`elec.validation`、`cost.estimation`、`factory.plc-sync`、`commission.io-test`、`cad.parametric-import`、`parametric.history`、`agent.resume`、`project.portable` 与实际接入的 `system.update`。Agent 普通对话/执行、CAD 只读查看、运动学编辑、机型设计、通电联调、电气原理图与元件库、数据包、工厂、通用同步、底板与主视口仍使用各自独立入口；关闭 `cost.estimation` 只封锁成本面板与成本报告工具，不封锁普通 BOM 和一般导出。机型方案内嵌估价属于机型设计，仍可保存其项目数据；PLC 实时连接、读写/强制 IO 仍由 commission 子系统管理，不受 `factory.plc-sync` 影响。
