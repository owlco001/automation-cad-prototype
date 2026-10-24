# 模块：测试与构建（test/、scripts/、build/）

职责：在没有真实 Windows 机器的前提下，用可自动化的证据证明「解析正确、接口可用、界面能起」。

## 测试分层

| 层 | 位置 | 跑法 | 说明 |
|----|------|------|------|
| 纯逻辑单测 | `test/**/*.test.mjs` | `npm test`（`node --test`） | 不依赖 Electron |
| CAD 解析 | `test/cad/step.test.mjs` | 同上 | 用 `test/fixtures/cube.stp`，断言 12 面 / 300³ mm |
| CAD 导入事务 | `test/cad/import-transaction.test.mjs` | 同上 | 解析失败不登记新工程身份；成功后才提交；身份存储故障不阻止只读解析；已有文档解析失败保留当前视图 |
| 运动学自动识别 | `test/cad/kinematics-auto.test.mjs` | 同上 | 34 条：名称/型号/层级/几何各启发式、置信度分级、IO 点位建议、不自动应用、schema 往返；`test/fixtures/kinematics-assembly.stp`（`scripts/gen-kinematics-fixture.mjs` 生成）端到端 |
| Agent RPC | `test/agent/rpc.test.mjs` | 同上 | 起真实 http server，验 401 / tools/list / -32601 / 600 权限 |
| 命令总线 | `test/agent/commands.test.mjs` | 同上 | 注册/重复注册/未知命令/失败历史/撤销、参数校验、桥超时 |
| 工具表 | `test/agent/tools.test.mjs` | 同上 | 21 工具、BOM 空数组、干涉截断、插入与撤销 |
| 工具扩展 v1 | `test/agent/tools-v2.test.mjs` | 同上 | 上下文 null 字段、元件修改/移除、PLC 预检拦截不落盘、导出白名单/净化/覆盖、确认拒绝 |
| 机型方案落盘 | `test/agent/apply-machine-design.test.mjs` | 同上 | brief/design 二选一、设计校验、id/点位冲突、overwrite、active 指针、BOM/PLC 联动、撤销、确认拒绝、路径净化、参数化模块写前拒绝（31 条） |
| 机型几何 | `test/machine/geometry*.test.mjs`、`test/agent/apply-machine-geometry.test.mjs` | 同上 | 尺寸、id 唯一、1–12 工位 × 6 工艺占地不重叠、运动轴元数据、BOM 对账、STL/glTF/sidecar 契约、three 动画、几何落盘/撤销/实体化回退（24 条） |
| 底板放置 | `test/agent/place-component.test.mjs` | 同上 | 参数校验、AMBIGUOUS、NO_DIMENSIONS、越界/重叠告警、旋转/吸附、撤销、确认拒绝 |
| MCP | `test/agent/mcp.test.mjs` | 同上 | `buildServer()` 后列 21 个工具 |
| 电气校验 | `test/elec/{check,report}.test.mjs`、`test/agent/elec-check.test.mjs` | 同上 | 线号/功率/截面规则、报告转义、命令入参校验、工具 schema |
| 参数化 CAD 模块边界 | `test/modules/{registry,settings}.test.mjs`、`test/parametric-sidecar.test.ts`、`test/parametric-import-safety.test.mjs`、`test/agent/apply-machine-design.test.mjs` | 同上 | 默认启用/设置持久化、依赖失败关闭；history 开关不清树/模型/会话 undo-redo 栈；关闭时 IPC/manager 与 Agent `withSolids` 拒绝、无 sidecar/写文件副作用、保留 CAD/特征树/叠加体 |
| Agent 跨重启恢复模块 | `test/modules/agent-resume-gate.test.mjs`、`test/agent/plan-checkpoint.test.mjs` | 同上 | 默认开启、API/依赖/能力、关停保留旧记录、状态异常 fail-closed；普通计划和写确认不受影响；checkpoint 签名/工程指纹/游标/副作用校验仍严格 |
| Windows 更新通道 | `test/update-channel.test.mjs`、`test/update-release-preflight.test.mjs` | 同上 | 默认/开关与 IPC gate、stable/beta/禁止降级、离线与签名配置 fail-closed、mock Authenticode 拒签、NSIS blockmap 差分失败后完整包回退、SHA-512/blockmap/publisherName 发行门禁；不连接真实更新源 |
| MCP 代理 | `test/agent/mcp-proxy.test.mjs` | 同上 | 写工具转发、无桌面时只读回退/写工具降级、超时不泄露 token |
| 模型配置 | `test/agent/llm-config.test.mjs` | 同上 | 默认值、apiKey 掩码、600 权限、掩码保存保留原密钥 |
| LLM 客户端 | `test/agent/llm.test.mjs` | 同上 | 本地假 HTTP：tool_calls、最终文本、401 中文错误、超时、ping max_tokens=8 |
| 会话循环 | `test/agent/session.test.mjs` | 同上 | 0/1/2 次工具调用、超轮、失败回灌、确认拒绝、20 条历史上限 |
| 执行体验 | `test/agent/ux.test.mjs` | 同上 | 六类错误码建议与未知码回落、耗时格式、参数掩码、进度事件、取消状态、审计筛选/CSV/200 条上限/完整 JSON 脱敏 |
| 主动建议 | `test/agent/advisor.test.mjs` | 同上 | 每条规则命中/不命中、优先级、上限 3、空状态、会话内忽略不复活、why 数字、BOM 指纹 |
| 主视口 3D | `test/orbit/*.test.mjs` | 同上 | 相机/标准视图数学、装配参数化与叠放链/校验、vm 执行原型 app.js 逐字比对轮廓与插入放置、树↔3D 映射、SVG 反算吸附、three 场景包围盒/高亮/拾取/干涉层（38 条） |
| 工厂 | `test/factory/*.test.mjs` | 同上 | demo 连接/读取/订阅；OPC UA/MQTT 只做参数校验（不连外网） |
| PLC | `test/plc/*.test.mjs` | 同上 | sim 表达式/自锁/定时器/force、Modbus 参数与中文错误、配置持久化 |
| PLC 代码生成 | `test/plcgen*.test.ts` | 同上 | 预检/变量表/ST/序列/安全/报警、生成 UI 与 zip 历史、mapping 模拟执行与 `verifyGenerated` |
| 联调 | `test/commission/*.test.mjs` | 同上 | 序列通过/超时/前置失败/异常；28 点位、6 步上电、3 用例；10 条诊断规则/排序/兜底 |
| 设计同步 | `test/sync/*.test.mjs` | 同上 | manifest/SHA、ZIP 路径、缺文件、配置脱敏、401/404/超时、幂等、diff |
| 数据包 | `test/packs/*.test.mjs` | 同上 | 包校验/导入、symbol 字段、iec-cn 数据契约、参考表生成、符号映射扫描 |
| 端到端冒烟 | `electron . --headless-smoke` | `npm run smoke` | xvfb 下加载页面、注入扩展、解析 fixture、断言 UI 结构与 system.update 开关/隐藏/IPC拒绝/开发态无网络 |

## smoke 的断言输出

```
SMOKE_CAD_OK triangles=12 meshes=1
SMOKE_WEBGL_FALLBACK_OK meshes=1 triangles=12 bounds=300.000 × 300.000 × 300.000 mm
SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25
SMOKE_KINEMATICS_AUTO_OK high=4 low=1 accepted=1 autoApplied=0
SMOKE_UI_OK stations=2 tags=8 packs=2 parts=9 overlay=1
SMOKE_ELEC_LIB_OK parts=44 categories=12 symbols=34
SMOKE_SYNC_UI_OK fields=8 apiKey=password enabled=checkbox
SMOKE_SYNC_PACKAGE_OK files=4 sha=1
SMOKE_PLCGEN_OK files=5 tags=32
SMOKE_PLCGEN_SEQ_OK files=11 steps=2
SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0
SMOKE_PLCGEN_UI_OK files=11 history=1
SMOKE_PLC_OK points=28
SMOKE_COMMISSION_OK steps=6 passed=6
SMOKE_COMMISSION_UI_OK cases=3 monitor=28 results=18
SMOKE_COMMISSION_PDF_OK path=.../report.pdf
SMOKE_COMMISSION_3D_OK ticks=... parts=16
SMOKE_COMMISSION_3D_SCALE_OK stations=4 actuators=12 sensors=16 parts=16 ticks=...
SMOKE_DIAGNOSE_OK codes=1
SMOKE_COMMISSION_MODULE_BOUNDARY_OK tests=MODULE_DISABLED livePlc=connected
SMOKE_PARAMETRIC_MODULE_GATE_OK ipc=blocked ui=hidden-restored cad=readable tree=preserved history=dependency-gated sidecar=stopped
SMOKE_PARAMETRIC_HISTORY_GATE_OK controls=hidden api=blocked tree=preserved same-session=restored editing=available
SMOKE_AGENT_TOOLS_OK tools=20 implemented=20
SMOKE_AGENT_TOOLS_V2 tools=20
SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=0
SMOKE_MACHINE_CYCLE_OK mode=cell throughput=32 meets=1
SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=6 undo=1
SMOKE_MACHINE_GEOMETRY_OK layout=gantry parts=57 axes=6 envelope=1610x420x1625 chunks=2 scene=57
SMOKE_AGENT_KB_OK docs=13 chunks=364 query=D2 hits=1
SMOKE_AGENT_BRIDGE_OK scene=1 bom=1
SMOKE_ORBIT_VIEW_OK mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1
SMOKE_AGENT_PLACE_OK placed=1 undo=1
SMOKE_AGENT_CHAT_UI_OK fields=6 log=1
SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0
SMOKE_AGENT_NL_OK intents=7 tools=20 audit=3 ctx=595
SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1
SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap
SMOKE_AGENT_REPAIR_OK cases=10 repaired=7
SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1
SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized
SMOKE_OK
```
任一断言失败 → 退出码 1，并打印 `SMOKE_FAIL <原因>`。

## 构建链

```
npm run build:ext
 ├─ tsc --noEmit                     # 类型门禁
 ├─ vite build                       # src/extension.ts → dist/extension.js（IIFE）
 └─ node scripts/build-electron.mjs  # electron/ + src/{packs,agent} → dist-electron/*.cjs
```
打包：`electron-builder --win zip --x64`（免 wine）或 `--win nsis`（需 wine32 / Windows runner）。

## 坑点

1. **`node --test test` 在 Node 26 会把目录当模块报 `MODULE_NOT_FOUND`**，用 `node --test`（自动发现 `*.test.mjs`）。
2. **root 下 Electron 必须 `--no-sandbox`**，smoke 脚本内置 `ELECTRON_DISABLE_SANDBOX=1`。
3. **smoke 的单实例锁**：上一次测试残留进程会让新实例直接退出，表现为端口不通；跑前 `pkill -x electron`。
4. **smoke 会把 `app.setPath('userData')` 指到 `mkdtemp` 的临时目录**（日志里的 `automationcad-smoke-*`），避免污染 `%APPDATA%/AutomationCAD`；真实运行仍是后者。
5. **不要把「构建成功」当测试证据**：`vite build` 成功不代表 WASM 路径对，必须跑 `step.test` + smoke。
6. **fixture 版权**：`cube.stp` 来自 occt-import-js 测试集，只用于测试，不要打进产品包。

## 进度

- ✅ 1720 个单测全绿（含 MCP 代理、LLM 客户端、会话循环、执行进度/取消/失败建议/审计筛选、命令总线、底板放置/撤销、元件修改/移除、机型方案校验/落盘/BOM/PLC 联动、离线意图路由、上下文裁剪、审计脱敏、计划预览与统一回执、数据包、同步、联调诊断与配置驱动 3D、更新通道及发行 preflight mock、CAD 导入事务）
- ✅ smoke 含智能体 21 工具/机型方案合成与落盘/场景/BOM/对话面板/只读问答 UI（计划预览 + 审计面板）/离线路由与审计/底板放置与撤销/PLC 落盘与通用导出/本地知识检索、电气元件面板、PLC 生成/模拟验证、PLC 点位、6 步上电、3 用例、联调 PDF、3D 联动和参数化、system.update 模块关停/重开与 IPC 拒绝断言
- ⏳ CI（GitHub Actions）因 token 缺 `workflow` scope 未启用，见 `docs/desktop/CI.md`
- ⏳ 性能基准（10 万面模型解析耗时）未建立

## 待办

1. 补损坏 CAD 文件、超大文件的真实渲染层导入异常用例。
2. 增加 Windows 端的 smoke（GitHub Actions windows-latest 上跑 `--headless-smoke`）。
3. 把 10 万面 STEP 纳入基准，设阈值（如 <5s）防回归。
4. ✅ 已用本地 `material-flow-backend` 临时库完成 `design-sync` 端到端验证（`cd desktop && npm run sync:e2e`）；生产联调仍待 D2。

## 模块启停切片

`test/modules/*.test.mjs` 覆盖模块目录元数据、API/能力/依赖失败关闭、默认启用兼容、设置持久化往返、未知模块拒绝、关闭不清 PLC/CAD 数据以及写入失败不提交。`npm run smoke` 验证模块设置 UI、PLC 模块关停边界与数据保留（`SMOKE_MODULE_UI_OK`）；参数化模块关闭时 renderer 入口隐藏、preload→主进程 IPC 被拒绝、CAD fixture 仍可只读导入、重新启用恢复入口且 sidecar 保持 stopped；history 父依赖不可绕过，独立关闭时控件隐藏、DOM/API 调用失败关闭、tree 与会话栈不变、重新启用后 redo/undo 恢复且基础编辑仍可用（分别记录 `SMOKE_PARAMETRIC_MODULE_GATE_OK`、`SMOKE_PARAMETRIC_HISTORY_GATE_OK`）；`commission.io-test` 关停时测试区隐藏、旧运行 API 被拒绝，但已有 PLC 连接、点位读取、断开和重连仍可用（`SMOKE_COMMISSION_MODULE_BOUNDARY_OK`）。

`agent.resume` 关闭时 renderer 不做 checkpoint 预检，主进程 restore/clear/计划执行路径均检查模块状态；Electron smoke 断言旧文件字节不变、恢复被拒绝、普通只读计划仍执行、写计划仍触发确认回调，重新启用后损坏记录仍被校验并阻断（`SMOKE_AGENT_RESUME_MODULE_OK`）。

`system.update` 默认启用并有独立 `core` 依赖；mock tests 使用 electron-updater 的真实 NSIS 分支与假 blockmap/HTTP/signature verifier，确保差分失败后的完整包回退仍执行 SHA-512/Authenticode 校验流程；模块关闭的 Electron smoke 通过 preload API 直接请求状态并断言主进程以 `MODULE_DISABLED` 拒绝。开发态 runtime availability 为 disabled，因此 smoke 不会连接 GitHub。真实 Windows 证书、签名者、升级、断网恢复与 blockmap 字节量尚未验收，见 [`../docs/update-channel.md`](../docs/update-channel.md)。
