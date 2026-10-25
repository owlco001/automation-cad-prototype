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

## P1 决策草案：机型安全 IO 映射持久化（2026-10-25）

**状态：提议，待确认；未实现。** 本节是后续实现边界，不代表当前应用已持久化安全映射、已通过 PLC 验收或可连接真实 PLC。

### 审计结论（当前实现）

- 机型方案确实存于既有 `userData/machine/<sanitized-id>.json`，active 指针位于 `machine/active.json`；读取器仍会把解析出的结构归一为 v1，未严格拒绝缺失/未知外层 schema/kind，也未交叉核验 profile 的 `id`、`config.id` 与请求的 machine ID 或 pointer 的 `machineId` 与 `file`。仓库 writer 历史上一直生成 v1 元数据，但仓库没有固定的历史 profile/pointer 字节 fixture；当前往返测试由同一 writer 动态生成，不能证明真实旧档案格式。故本轮不启用严格拒绝，待有经验证的历史字节 fixture 后再加校验，以免误拒绝旧文件。`writeText` 当前是直接写入，不是原子替换。
- `MachineConfig` 仅包含 `id/name/stations/actuators/sensors`。`validateMachineConfig` 重新构造这几个字段，因此不会持久化或保留 PLC 扩展的 `safety`、`ioPoints`、传感器 `role/address/ioAddress` 等字段；`validateMachineDesign` 使用该 validator。当前机型档案中没有带机型身份、schema 版本和来源配置版本校验的安全点位/地址绑定。
- `buildMachineIoMap` 从当前基础配置调用 `collectIoRefs` / `buildTags` 现场派生 CSV，不读取持久化映射。PLC 生成 UI 的 `localStorage` 持久化项是生成历史；同步上传也从联调面板当前 `MachineConfig` 重建 PLC 内容。模块开关和包内 machine ID/hash 校验不是安全映射持久化或用户确认。
- 因此：本地存在机型方案档案和可重算的通用 IO 表，但不存在可证明安全的、逐机型持久化的 safety IO mapping。新增候选审阅导出不读取、生成、保存或导出该安全映射，也不改变既有 PLC 连接/模块门控。

### 本地 PLC 候选审阅导出的安全边界（2026-10-25）

下载包仍由主进程解析；只有成功解析后的含 PLC 候选才可由用户显式导出。候选只保存在主进程内存中，按 package ID 关联，15 分钟失效，并在新下载时替换。渲染层 IPC 不接受文件系统路径或候选内容；主进程核对应用主窗口的可信主 frame 后自行打开原生父目录选择器，并且只使用该次已校验的缓存候选。

输出路径固定为 8 个 ST、`io-tags.csv` 和 `mapping.json`；机型 `plc/machine-io-map.csv` 与 manifest/README 均不输出。写出前再次执行 exact allowlist、相对路径与大小写唯一性、扩展类型、manifest 哈希、凭据特征和 1 MiB/8 MiB 上限校验。输出以 0600 独占创建到 0700 私有同级临时目录，成功后才原子改名为带 package ID 安全标签和随机后缀的新目录；目标存在拒绝，异常清理临时目录。此副本不安装、不应用、不执行 ST，不触碰当前工程/机型配置，不上传或连接 PLC。解析与审阅副本不等于 PLC 语法、安全性或硬件验收。

### 建议的单一存储与最小 schema（待确认）

不要新增 localStorage、sidecar 文件或第二份 machine registry。确认采用后，将映射嵌入现有 machine profile 文件，并升级外层 profile schema；最小示意：

```json
{
  "schemaVersion": 2,
  "kind": "machine-design",
  "id": "machine-01",
  "config": { "id": "machine-01", "name": "示例机型" },
  "plcIoMapping": {
    "schemaVersion": 1,
    "machineId": "machine-01",
    "sourceConfigSha256": "<规范化 MachineConfig 的 SHA-256>",
    "safety": [
      { "role": "emergencyStop", "point": "X8", "address": "I1.0" },
      { "role": "safetyDoor", "point": "X9", "address": "I1.1" }
    ]
  }
}
```

校验需核对支持的外层/映射 schema、profile 与映射的 `machineId` 一致、`sourceConfigSha256` 匹配规范化当前配置；每个安全点必须存在于该机型、方向为输入、地址合法且无重复/冲突，角色只能是显式枚举（急停/安全门/复位）。不得依据名称、`part` 文本或自动分配结果猜测安全角色；人工确认前映射未完成。PLC 同步的后续接入必须只消费该已验证映射。

### 迁移与失败策略（待确认）

- 旧 v1 档案可继续用于既有非 PLC 机型显示/编辑，但一律视为“无已确认安全映射”；不静默生成、不按名称迁移。只有用户显式复核并确认后，才写入带当前 machine ID 和配置摘要的 v2 档案。
- 未知 schema、machine ID 不符、配置摘要过期、点位缺失/重复、地址非法或角色不合法时，保留原档案字节，不自动降级或部分套用；对要求安全映射的未来 PLC 生成/同步入口整体拒绝，不回退到 demo、启发式映射或自动地址表。非 PLC 工作流不因缺少映射而中断。
- 映射变更须在临时文件中完成完整校验后原子替换，失败时原档案保持不变；读取不得触发迁移写入。实现前还需确定人工确认 UI、schema bump 与回滚验收测试。

## 5. 里程碑

- **M1 基础外壳 + CAD 查看**（本轮）：Electron 可启动；打开/拖入 STEP/IGES/STL/OBJ/GLTF；零件树与三角面统计；缩放到适合；最近文件。
- **M2 数据包**：内置包 + 导入 zip + 启停 + 标准件库联动。
- **M3 Agent 接口**：JSON-RPC + MCP，20 个工具，token 鉴权，命令总线与渲染桥同源。
- **M4 智慧工厂**：demo 适配器全通；OPC UA 连接/浏览/订阅；MQTT 订阅；状态回显到装配树。
- **M5 打包**：GitHub Actions windows-latest 产出 NSIS `.exe`，签名留空但版本信息完整。

## 6. 验收（M1，可自动验证）

1. `npm ci && npm run build:ext` 通过，TS 无错误。
2. `npm test` 全绿：包校验（合法/缺字段/路径穿越）、STEP 解析（cube.stp 包围盒 300³）、Agent 工具注册表、JSON-RPC 鉴权。
3. Electron 以 `--headless-smoke` 启动，主窗口 `did-finish-load` 后退出码 0，日志含 `SMOKE_OK`。
4. GitHub Actions `windows.yml` 成功产出 `AutomationCAD-Setup-*.exe`（artifact 可下载）。
输出路径固定为 8 个 ST、`io-tags.csv` 和 `mapping.json`；机型 `plc/machine-io-map.csv` 与 manifest/README 均不输出。写出前再次执行 exact allowlist、相对路径与大小写唯一性、扩展类型、manifest 哈希、凭据特征和 1 MiB/8 MiB 上限校验。输出以 0600 独占创建到 0700 私有同级临时目录，成功后才原子改名为带 package ID 短 SHA-256 标签和随机后缀的新目录；不写出原始 ID，目标存在即拒绝，异常清理临时目录。此副本不安装、不应用、不执行 ST，不触碰当前工程/机型配置，不上传或连接 PLC。解析与审阅副本不等于 PLC 语法、安全性或硬件验收。
