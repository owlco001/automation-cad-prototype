# AutomationCAD 桌面版

Windows 11 桌面外壳（Electron）+ 原型渲染层扩展。根目录的 `index.html` / `app.js` / `styles.css` / `electrical.*` 保持原样，桌面能力全部由 `desktop/src/extension.ts` 注入。

> 模块划分、数据结构、坑点与待办见 [`docs/desktop/MODULES.md`](../docs/desktop/MODULES.md)（索引）；各模块目录下有 `MODULE.md`。

## 常用命令

```bash
cd desktop
npm ci
npm run build:ext   # tsc + Vite 扩展 + Electron main/preload + MCP 入口
npm test            # 1800 个单元/集成测试（node:test）
npm run smoke       # xvfb + Electron --headless-smoke，强制无 WebGL 路径
npm run check:orbit-webgl  # 手动：swiftshader 打开 WebGL，验证主视口 3D（需先 build:ext）
npm start           # 启动桌面应用
npm run mcp         # 启动 stdio MCP server（需先 build:ext）
```

模块设置采用版本化目录与功能门控（Core + 10 个可选模块），覆盖 UI、IPC、Agent/RPC/MCP 和受控副作用入口；关闭模块会保留工程数据，但不会卸载随应用打包的代码。可移植工程档案 v2 当前只做严格预览，尚未应用或恢复状态；Windows stable/beta 更新 MVP 也尚未完成真实签名/升级验收。详见 [开发计划](../docs/desktop/DEVELOPMENT-PLAN.md)、[当前状态](../docs/desktop/STATUS.md) 与 [更新通道说明](docs/update-channel.md)。

`npm run smoke` 会验证：

- CAD 解析统计（`cube.stp` → 1 个零件 / 12 个三角面）；
- 无 WebGL 时显示「当前环境不支持 WebGL，无法显示 3D 模型」降级面板，并展示解析统计；
- 主视口可旋转 3D：冒烟进程关闭 WebGL，验证装配/干涉视口保留原型等轴测 SVG（降级），同时扩展模型与原型逐字一致、3D↔结构树选择映射、原型缸径编辑与撤销驱动几何、桌面版几何参数沿叠放链联动与越界拒绝（`SMOKE_ORBIT_VIEW_OK mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`）；WebGL 路径另用 `npm run check:orbit-webgl`（swiftshader，手动）验证，输出 `ORBIT_WEBGL_OK`；
- 「工厂」面板连接内置仿真产线后出现 2 个工位 / 8 个点位；
- 「数据包」面板能列出 10 个内置 manifest、搜索元器件并写入 localStorage 覆盖层；启动只读 manifest，命中包才加载 `parts.json`；smoke 额外输出 `SMOKE_PACKS_LAZY_OK packs=10 loaded=2 searchMs=…` 与 `SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44 vision=32 drive=33 safety=28 frame=33`；
- 智能体注册表为 21 个工具（含只读 `design_machine` 与写工具 `apply_machine_design`）：`design_machine` 返回 config / cycle / power / cost / bomDraft，其中功率优先取元件库额定值并按同时系数、负载率、效率与 `cosφ` 折算，成本按材料/电气/人工分项并统计缺价；渲染桥能读取场景与 BOM，对话面板含 6 个字段与消息容器；流程区提供 5 个模板、步骤预览与执行记录导出，本地知识索引可检索文档（`SMOKE_AGENT_TOOLS_OK` / `SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=2 form=linear-4` / `SMOKE_MACHINE_POWER_OK kw=1.092 a=1.844 breaker=6` / `SMOKE_MACHINE_COST_OK total=17076.23 missing=2` / `SMOKE_MACHINE_CYCLE_OK mode=cell throughput=32 meets=1` / `SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1` / `SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=7 undo=1` / `SMOKE_MACHINE_GEOMETRY_OK layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56` / `SMOKE_AGENT_BRIDGE_OK` / `SMOKE_AGENT_CHAT_UI_OK` / `SMOKE_AGENT_KB_OK docs=13 chunks=354 query=D2 hits=1` / `SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`）。

## MCP（stdio）接入

MCP 入口直接复用 `src/agent/tools.ts` 的 21 个工具（只读 11 + 写 10）：`list_components`、`search_components`、`search_docs`、`suggest_kinematics`、`design_machine`、`apply_machine_design`、`import_cad`、`get_bom`、`get_project_context`、`run_interference_check`、`insert_component`、`place_component`、`update_component`、`remove_component`、`run_electrical_check`、`run_cost_report`、`run_plc_generate`、`export_files`、`export_cost_report`、`verify_plc_program`、`undo_last`。MCP 进程会读取桌面 token 并优先把工具调用转发到 `127.0.0.1:7420`；桌面未启动时，只读检索（含 `search_docs`）回退本地 registry，其余工具返回 `DESKTOP_NOT_RUNNING`，不会假装成功。

先构建：

```bash
cd desktop
npm run build:ext
```

### Claude Code

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "automation-cad": {
      "command": "node",
      "args": ["C:/path/to/automation-cad-prototype/desktop/dist-electron/mcp.cjs"]
    }
  }
}
```

或使用 CLI：

```bash
claude mcp add automation-cad -- node "C:/path/to/automation-cad-prototype/desktop/dist-electron/mcp.cjs"
```

### Codex

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.automation-cad]
command = "node"
args = ["C:\\path\\to\\automation-cad-prototype\\desktop\\dist-electron\\mcp.cjs"]
```

stdio 本身是受信任的本机通道；MCP 进程只在代理写工具时读取 userData 下的 Agent token，且不会打印 token。MCP 进程会读取：

- 内置包：仓库 `packs/builtin`，或环境变量 `AUTOMATIONCAD_BUILTIN_PACKS` 指定的目录；
- 用户包：`%APPDATA%/AutomationCAD/packs`（Linux 为 `~/.config/AutomationCAD/packs`）；
- 包启停状态：同目录下 `packs-state.json`。

## JSON-RPC 接口

桌面主进程启动后会监听 `127.0.0.1:7420`，并生成 token 文件：

- Windows：`%APPDATA%/AutomationCAD/agent-token`
- Linux：`~/.config/AutomationCAD/agent-token`

顶栏「智能体」面板提供对话、工具调用卡片、5 个可复用流程模板和模型设置（OpenAI 兼容 `baseUrl` / `model` / `apiKey` / 最大轮数），并显示服务地址、工具数与最近命令；不显示 token。模型配置保存在 `%APPDATA%/AutomationCAD/agent-llm.json`（权限 600），apiKey 在 UI 只回显掩码。写工具执行前会请求确认。

请求必须带 `Authorization: Bearer <token>`。示例：

```bash
TOKEN=$(cat ~/.config/AutomationCAD/agent-token)
curl -s http://127.0.0.1:7420/health -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:7420/rpc \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 智慧工厂

- 适配器：`demo`（内置仿真产线）、`opcua`（node-opcua，起步 `securityPolicy=None`）、`mqtt`（mqtt.js，按配置的 topic→点位映射订阅）。
- 配置持久化：`%APPDATA%/AutomationCAD/factory.json`，写入时权限 `0600`，密码不会通过状态接口回传。
- 主进程 `FactoryManager` 统一做 10 秒超时，并通过 EventEmitter 广播 `status` / `values`。
- 渲染层只能通过 preload 的 `window.desktop.factory.*` 访问；写点位前必须经过 `window.confirm` 二次确认。
- 连接失败、参数错误、超时都会以中文 `{ ok: false, code, message }` 返回，不向主进程抛未捕获异常。

### 设计包同步（P2-C）

- 顶栏「智慧工厂」打开同步设置：`baseUrl` / `deviceId` / `projectId` / `apiKey`（密码框、保存后只回显掩码）/ 启用开关。
- 「测试连接」走 `GET /api/v1/devices/{deviceId}/drawings`（Bearer）；「立即同步」生成 PDF / GLB / DXF / BOM，主进程打 ZIP 后上传。
- 上传请求带 `X-Design-Key` 与 `Idempotency-Key=<zip sha256>`；服务端返回 `200 + duplicated` 时 UI 明确提示命中幂等。
- 配置存 `%APPDATA%/AutomationCAD/sync.json`（权限 600）；网络与文件操作只在主进程，且仅由 UI 点击触发，没有后台自动同步。
- 真实后端 0.22.0 已提供 `/api/v1/design-sync/*`；单测仍只连本地 mock，真实链路用 `npm run sync:e2e`（临时 DB，不访问生产）。

实现细节见 [`src/sync/MODULE.md`](src/sync/MODULE.md)。

## PLC 与通电联调

- 顶栏「联调」打开 PLC 连接、28 点位表、6 步上电、3 条用例和点位监视。
- 适配器：`sim`（内置表达式/自锁/定时器逻辑，开箱即用）与 `modbus`（Modbus TCP，FC01/02/03/04/05/06）。
- 配置持久化：`%APPDATA%/AutomationCAD/plc.json`；所有读写由主进程统一 10 秒超时，连接超时 5 秒。
- 联调抽屉内置 3D 联动（底板/滑台/气缸/活塞杆/夹爪/传感器灯，可开关）与故障诊断卡片；失败时同时给出证据、排查步骤、置信度和故障点位描红。
- 强制写入需二次确认；仿真强制值不会被规则覆盖。完成后可导出含联调章节的 A3 横向 PDF。

## 数据包 UI

- 内置包只读：`iec-cn`、`smc-cn`、`servo-cn`、`sensor-cn`、`pneumatic-cn`、`vision-cn`、`drive-cn`、`safety-cn`、`frame-cn`、`pricebook-cn`；用户包导入 ZIP 后落到 `%APPDATA%/AutomationCAD/packs/<id>/`。
- 启动只读 manifest；`listParts` 按 `manifest.categories` / 包名预过滤，命中包才读取 `parts.json` 并缓存，`unloadPack(id)` 释放；`metrics()` 暴露 `packLoadMs / loadedPacks / partsLoaded / searchMs`。
- 导入校验包含 manifest 必填字段、ID 冲突、ZIP 路径穿越；错误原因会原样显示在面板状态区。
- 启用/禁用即时影响标准件搜索结果。
- 「插入」写入 `localStorage` 键 `automationcad.parts.overlay.v1`，并派发 `automationcad:parts-overlay-changed` 事件；不修改 `app.js`。
