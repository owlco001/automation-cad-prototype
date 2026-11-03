# 架构 v0.1 — Win11 桌面版（Electron 外壳 + 原型渲染层）

日期：2026-10-22 · 状态：待老王确认（默认按此推进）

## 1. 技术选型与理由

| 决策 | 选择 | 理由 | 放弃的方案 |
|------|------|------|-----------|
| 桌面外壳 | **Electron 33+** + electron-builder（NSIS x64） | 渲染层已有 HTML/CSS/JS；主进程直接跑 node-opcua/mqtt/Agent SDK，无需 sidecar；Win11 WebView2 兼容性稳定 | Tauri：体积更小，但工厂协议与 Agent 需另起 Node/Rust 进程，跨编译到 Windows 复杂 |
| 渲染 | 现有原型（`index.html` + `app.js` + `electrical.*`）**加而不改** + 新增扩展模块 | 沿用「电气域」已验证的扩展模式，避免重写 5000 行 UI | React 重写：成本高、回归风险大 |
| CAD 内核 | **occt-import-js**（WASM）+ **three.js** r16x | 零授权成本、STEP/IGES/BREP 可读、纯前端；已验证 424KB 装配 559ms | OpenCascade 原生绑定（编译重）、CAD Exchanger（商业） |
| 桌面构建 | Vite（仅打包扩展 TS）+ electron-builder | 原型不用构建；扩展用 TS 保证可测 | 全量 webpack |
| 数据 | 数据包目录 + JSON（本期）；SQLite 索引 v0.2 | 包可人工编辑、易分发；万级条目再上 SQLite FTS | 一开始上 SQLite：导入流程复杂 |
| Agent | JSON-RPC + MCP(stdio)，共享工具注册表 | 兼容 Hermes/Codex/Claude；UI 与 Agent 同源 | 只做 OpenAI function calling：绑定单一模型 |

## 2. 目录结构

```
.
├── index.html / app.js / styles.css / electrical.*   # 原型（保持可双击运行）
├── desktop/
│   ├── package.json               # electron / electron-builder / vite / three / occt-import-js
│   ├── tsconfig.json
│   ├── vite.config.ts             # 打包 src → dist/extension.js（IIFE，注入页面）
│   ├── electron/
│   │   ├── main.ts                # 窗口、菜单、单实例、文件关联、IPC
│   │   ├── preload.ts             # contextBridge: window.desktop
│   │   └── ipc.ts                 # fs/对话框/包管理/工厂/Agent 的 IPC 路由
│   ├── src/
│   │   ├── extension.ts           # 渲染层入口：装载 CAD 视图、包管理页、工厂面板
│   │   ├── cad/                   # occt + three 导入与查看器
│   │   ├── packs/                 # manifest 校验、扫描、启停（主进程侧）
│   │   ├── agent/                 # 工具注册表、JSON-RPC server、MCP stdio
│   │   ├── factory/               # FactoryAdapter + demo/opcua/mqtt
│   │   └── shared/                # 类型、路径、日志
│   └── test/                      # node:test 单测 + 集成测试
├── packs/builtin/                 # 内置示例包（SMC 气缸 / HIWIN 导轨 / 传感器）
├── docs/desktop/                  # 本文件与需求
└── .github/workflows/windows.yml  # windows-latest 构建 NSIS 安装包
```

## 3. 进程与安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层只能通过 `window.desktop.*` 访问能力。
- 主进程负责：文件读写、包扫描、工厂连接、Agent server、最近文件。
- 渲染层负责：three.js 渲染、occt WASM 解析（Web Worker 中跑，避免卡 UI）、视图交互。
- Agent server 只绑 `127.0.0.1`，启动时生成随机 token 写 `%APPDATA%/AutomationCAD/agent-token`，请求需 `Authorization: Bearer`。

## 4. 关键接口（签名级）

```ts
// factory/adapter.ts
interface FactoryAdapter {
  readonly kind: 'demo' | 'opcua' | 'mqtt' | 'rest';
  connect(cfg: FactoryConfig): Promise<void>;
  disconnect(): Promise<void>;
  browse(nodeId?: string): Promise<TagNode[]>;
  readTags(ids: string[]): Promise<Record<string, TagValue>>;
  writeTag(id: string, value: unknown): Promise<void>;   // UI 二次确认后调用
  subscribe(ids: string[], cb: (v: TagValue) => void): () => void;
  status(): 'disconnected' | 'connecting' | 'connected' | 'error';
}

// packs/registry.ts
interface PackManifest { schemaVersion: 1; id: string; name: string; vendor: string; version: string; license?: string; description?: string }
interface ComponentPart { id: string; model: string; category: string; vendor?: string; specs: Record<string, string | number>; asset?: string; thumbnail?: string; price?: number }
class PackRegistry {
  scan(): Promise<PackInfo[]>;                 // 内置 + 用户目录
  importZip(zipPath: string): Promise<PackInfo>; // 校验 → 解压到用户目录
  setEnabled(id: string, on: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  listParts(filter?: { q?: string; category?: string; packId?: string }): ComponentPart[];
}

// agent/tools.ts
interface AgentTool { name: string; description: string; inputSchema: object; handler(args: any): Promise<any> }
```

## 5. 里程碑

- **M1 基础外壳 + CAD 查看**（本轮）：Electron 可启动；打开/拖入 STEP/IGES/STL/OBJ/GLTF；零件树与三角面统计；缩放到适合；最近文件。
- **M2 数据包**：内置包 + 导入 zip + 启停 + 标准件库联动。
- **M3 Agent 接口**：JSON-RPC + MCP，25 个工具（只读 12 / 写 13），token 鉴权，命令总线与渲染桥同源。
- **M4 智慧工厂**：demo 适配器全通；OPC UA 连接/浏览/订阅；MQTT 订阅；状态回显到装配树。
- **M5 打包**：GitHub Actions windows-latest 产出 NSIS `.exe`，签名留空但版本信息完整。

## 6. 验收（M1，可自动验证）

1. `npm ci && npm run build:ext` 通过，TS 无错误。
2. `npm test` 全绿：包校验（合法/缺字段/路径穿越）、STEP 解析（cube.stp 包围盒 300³）、Agent 工具注册表、JSON-RPC 鉴权。
3. Electron 以 `--headless-smoke` 启动，主窗口 `did-finish-load` 后退出码 0，日志含 `SMOKE_OK`。
4. GitHub Actions `windows.yml` 成功产出 `AutomationCAD-Setup-*.exe`（artifact 可下载）。
