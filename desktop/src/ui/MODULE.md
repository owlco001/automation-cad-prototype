# 模块：渲染层扩展与面板（src/extension.ts、src/ui/、src/cad.css）

职责：在**不改动原型**（index.html / app.js / styles.css / electrical.*）的前提下，把桌面能力挂到现有界面：顶栏入口、CAD 覆盖层、工厂 / 数据包 / 智慧工厂同步侧滑面板。

## 注入方式

```
main.ts did-finish-load
  └─ <script src="file://.../dist/extension.js">（IIFE）
       └─ init()
            ├─ injectStyles()      # cad.css + panels.css 插到 <head>
            ├─ buildEntryButton() # 顶栏追加「CAD 查看」「工厂」「数据包」「智慧工厂」「电气元件」「联调」「智能体」
            ├─ initModuleSettingsUi() # 始终可见的内置模块状态/启停入口
            ├─ moduleManager         # Core + 按需初始化的 plcgen + system.update 占位
            │    ├─ plcgen enabled → 动态导入随应用打包的面板
            │    └─ plcgen disabled → 不创建入口；状态变更时关闭并隐藏已加载面板
            ├─ buildOverlay()     # #automationCadOverlay
            └─ bindWindowEvents() # 拖放、Esc、菜单事件
```

## 关键 DOM 契约

| id / class | 用途 |
|------------|------|
| `#automationCadOverlay` | CAD 全屏覆盖层根节点 |
| `.cad-entry-btn` | 顶栏入口按钮 |
| `[data-cad-action="open\|fit\|wire\|close"]` | 覆盖层工具条 |
| `#cadNotice` | 加载/错误提示条 |
| `window.AutomationCadViewer` | `{ open, close, importPath, inspectPath }`，smoke 测试用 |
| `window.__AgentBridge` | 受控工具桥：场景/选择/BOM/插入/移除/干涉/导入；不暴露 DOM |
| `window.__AUTOMATION_CAD_EXTENSION_READY__` | 注入完成标志，smoke 等待它 |

工厂面板与数据包面板分别由 `initFactoryPanel()` / `initPackPanel()` 在 `src/extension.ts` 里初始化，样式在 `src/ui/panels.css`。
模块设置由 `src/modules/registry.ts` / `src/modules/ui.ts` 实现；PLC 生成面板是首个可启停模块，默认启用。关闭只停用 UI 与命令入口，不删除 PLC 数据或做热卸载；其他面板尚未迁移。
智慧工厂同步面板由 `initSyncPanel()` 初始化，导出物由 `buildSyncPayload()` 复用 `export/` 生成后交给主进程。
智能体面板由 `src/agent/ui.ts` 的 `initAgentPanel()` 初始化，只展示服务地址/端口、工具数、token 文件路径、7 个工具与最近 5 条命令历史，不接 LLM。

## 数据流

- 打开 CAD：菜单/按钮/拖放 → `desktop.readFileBuffer(path)` → Worker 解析 → viewer 渲染
- 工厂：面板 → `window.desktop.factory.*` → 主进程 Manager → 适配器 → `onValues` 事件回推 UI
- 数据包：面板 → `desktop.packs.*`；「插入」写 `localStorage` 覆盖层，不改原型数据
- 智能体：外部 Agent → 主进程命令总线 → `window.__AgentBridge` → `CadViewer`；写操作统一进撤销栈

## 坑点

1. **原型没有模块系统**：扩展只能以 IIFE 注入，不能用 `import` 直接改原型作用域；需要读原型状态时走 DOM 与 `window.ElecDomain` / `window.AutomationCadViewer`。
2. **CSS 变量沿用原型 token**（`--bg`、`--line`、`--accent` 等），新增颜色会被视觉评审打回；图纸与 3D 的描边体系不能混。
3. **覆盖层 z-index 要高于原型工具栏与命令面板**，且打开时锁 `body` 滚动（原型的弹层用 `position:fixed`）。
4. **Esc 必须只关最上层**：捕获阶段监听并 `stopPropagation`，否则原型的命令面板会一起关。
5. **拖放要 `preventDefault` 两次**（dragover + drop），否则 Electron 会尝试导航到文件。
6. **入口按钮要插在顶栏右侧分隔符之前**，硬编码 `appendChild` 会跑到窗口控制区外。

## 进度

- ✅ 顶栏 3 个入口（CAD 查看 / 工厂 / 数据包）
- ✅ CAD 覆盖层（工具条、零件树、统计、空白态、降级态）
- ✅ 工厂面板（状态灯、连接表单、工位树、实时值、写入确认）
- ✅ 数据包面板（列表、开关、导入、删除、搜索、插入）
- ✅ 智慧工厂同步面板（设置、密钥掩码、测试连接、立即同步、最近结果/包列表）
- ✅ 智能体面板（服务状态、7 工具、最近 5 条命令历史、刷新）
- ✅ `window.__AgentBridge`（只读/受控，未就绪返回中文结构化错误）
- ⏳ 面板宽度/折叠记忆、键盘可达性（焦点环）
- ⏳ 与原型「标准件库」视图的深度联动（当前是 localStorage 覆盖层）

## 待办

1. 把「插入」从 localStorage 覆盖层升级为原型的真实库数据源（需要原型侧提供 API，或改为重渲染库视图）。
2. 面板状态持久化（`userData/ui-state.json`）。
3. 统一 toast/状态条，避免三个模块各自提示风格不一致。
