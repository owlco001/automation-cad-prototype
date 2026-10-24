# 模块：Electron 主进程（electron/）

职责：窗口生命周期、菜单、文件对话框、IPC 路由、Agent 服务启动、打包后的路径解析。渲染层不直接碰 Node。

## 入口关系

```
main.ts  ──创建→ BrowserWindow（加载仓库根 index.html）
   │            └─ did-finish-load 后注入 dist/extension.js
   ├─ registerIpcHandlers() → ipc.ts（PackRegistry / FactoryManager / Agent 信息）
   └─ startAgent() → ../src/agent/rpc.ts（127.0.0.1:7420）
preload.ts → contextBridge 暴露 window.desktop（只转 IPC，无业务逻辑）
```

## 关键数据结构

`ipc.ts` 的 `IpcContext`：

| 字段 | 含义 |
|------|------|
| `builtinDir` | 内置包目录。开发态 `../packs/builtin`，打包后 `process.resourcesPath/packs/builtin` |
| `userDir` | `%APPDATA%/AutomationCAD/packs` |
| `stateFile` | `%APPDATA%/AutomationCAD/packs-state.json` |
| `version` | `app.getVersion()`，供 `/health` 与「关于」使用 |
| `trustedUiPath` / `getWindow` | 应用入口 HTML 与当前主窗口；IPC 调用校验页面路径及主 frame 来源 |
| `getAgentInfo` | 返回 `{url,port,toolCount}` 或 `{error}`，不抛异常 |

`preload.ts` 暴露的命名空间：`desktop.version / openCadDialog / readFileBuffer / packs.* / agent.info / factory.* / plc.* / sync.* / onOpenCad / onImportPack / onSetDomain`。

## 路径解析（打包 vs 开发）

| 资源 | 开发态 | 打包后 |
|------|--------|--------|
| 页面 | `<repo>/index.html` | `resources/web/index.html` |
| 内置包 | `<repo>/packs/builtin` | `resources/packs/builtin` |
| 扩展脚本 | `<desktop>/dist/extension.js` | `app.asar/dist/extension.js` |
| preload | `dist-electron/preload.cjs` | 同左（asar 内） |

## 坑点（都踩过）

1. **单实例锁**：`app.requestSingleInstanceLock()` 失败时必须 `app.quit()` 且不再执行 `bootstrap()`，否则 xvfb 下会同时起两个窗口，CDP 连到旧进程。
2. **`--headless-smoke` 不能在 `show:true` 下跑**：CI/容器无 GPU，`app.disableHardwareAcceleration()` + `show:false` 才稳定；否则 WebGL 初始化直接抛错。
3. **注入扩展脚本用 `executeJavaScript` 追加 `<script>`，不要用 preload 里的 import**：扩展是 IIFE bundle，需要页面 `file://` 源，preload 的模块作用域注入拿不到 DOM。
4. **打包后 `__dirname` 是 `app.asar/dist-electron`**，`desktopRoot()` 不能用于 resources 路径；凡是打包资源一律走 `process.resourcesPath`。
5. **Linux root 运行必须加 `--no-sandbox`**（main.ts 已按 uid 自动加），否则 Electron 起不来。
6. **主窗口只能停留在应用入口 HTML**：导航/重定向到其他页面都会拦截，弹出窗口一律拒绝。
7. **IPC 入口统一验证来源**：所有 invoke 通道只接受当前主窗口主 frame，且该 frame 必须仍是应用入口 HTML；无窗口、已销毁窗口或其他来源均失败关闭。

## 进度

- ✅ 单实例、菜单（打开 CAD / 导入数据包 / 域切换 / 关于）、拖放转发、最近文件（v0.1 未做）
- ✅ headless smoke：`SMOKE_OK`，含 CAD 统计与 UI 结构断言
- ✅ PLC 配置 `plc.json`、`plc:*` IPC 与状态/值广播；联调 PDF 走同一 `export:report` 通道
- ✅ 设计同步 `sync:getConfig/saveConfig/test/upload/list/diff`：密钥脱敏、PDF 生成、ZIP 打包与上传均在主进程
- ✅ IPC 白名单式封装（渲染层无 fs / net 权限）
- ⏳ 窗口图标（`build/icon.ico` 已用于 exe，窗口图标待接）
- ⏳ 自动更新、崩溃上报

## 待办

1. 最近文件列表持久化到 `userData/recent.json`，菜单动态生成。
2. 单实例二次启动时把文件参数转给已存在窗口（`second-instance` 目前只聚焦）。
3. 打包体积治理：`node-opcua` 懒加载或改为可选 sidecar（当前便携包 472 MB 解压）。

## 诊断、崩溃与性能（2026-10-24）

- `diagnostics.ts`：`collectDiagnosis()` 采集应用/Electron/Node/Chrome 版本、平台、userData、WebGL 探测结果、内置包 `id@version` 与数量、KB 文档/分段/字节、审计文件大小、最近 20 条 `recordDiagnosticError` 摘要。`probeWebGL()` 用隐藏窗口执行一次 canvas 探测，`finally` 中销毁；`--diagnose` 模式下 `window-all-closed` 不退出进程，避免探测窗口关闭把主进程提前带走。
- `crash-report.ts`：`writeLastCrash()` 原子写 `<userData>/diagnostics/last-crash.json`（临时文件 + rename，POSIX 权限 600）。字段固定为 `schemaVersion/kind/at/operation/code/message/stack/appVersion/electronVersion/nodeVersion/platform`，消息与堆栈先脱敏截断，绝不写工具参数或用户正文。
- `perf-smoke.ts`：`runPerfSmoke(1000)` 生成 1000 件线性装配、构建 three.js 场景并跑 300 tick；由 `main.ts` 在 headless smoke 分支动态 `import()`，末尾 `disposeThreeMachine()`。
- 退出释放：`before-quit` 调 `disposeIpcRuntime()`，释放 `FactoryManager` / `PlcManager` 的适配器、订阅与 timer；PLC 仿真与工厂 demo 的周期任务使用 `src/shared/resources.ts` 的显式计数，测试断言连接/断开归零。
- 测试：`desktop/test/robustness/` 下 30 条，覆盖缓存命中、共享资源一次性释放、增量变换、输入上限、幂等 apply、资源计数、诊断字段/脱敏与崩溃文件。

`npm run diagnose` 输出 `DIAGNOSE_OK fields=... errors=N` 后跟 JSON；`npm run smoke` 额外断言 `SMOKE_PERF_OK parts=1000 buildMs=… tickMs=…` 与 `SMOKE_DIAGNOSE_OK fields=... errors=…`。

## parametric.ts

职责：管理 build123d sidecar 的完整生命周期，是渲染层与 Python 内核之间唯一的网络代理。

- `resolvePython()`：`AUTOMATIONCAD_PYTHON` → 打包资源 `resources/parametric/python[/python.exe]` → PATH 中 `python3` / `python`；找不到返回 `null`。
- `resolveScript()`：开发态 `spike/build123d/app.py`，打包态 `resources/parametric/app.py`。
- `start()`：在 7430–7449 随机探测空闲端口与随机 token，`detached` 启动，`/health` 每 300 ms 探测、最多 3 s。
- `status()`：`stopped | starting | ready | unavailable | crashed`，附中文提示；不暴露端口与 token。
- `build(doc)`：先跑 `validateFeatures` / `compileOps`，再以 Bearer 调 `POST /build`，30 s 超时；返回结构化 stats/files 或中文失败码。
- `stop()`：POSIX 杀进程组，Windows `taskkill /T /F`；空闲 10 分钟自动停止。
- 崩溃恢复：ready 后意外退出自动重启一次，再失败进入 `crashed`；显式 stop 不触发重启。
- 测试注入：`AUTOMATIONCAD_PARAMETRIC_CMD` 可指向 Node 假 sidecar（smoke 用），管理器选项可缩短 `idleMs` 与端口范围。

安全边界：token 只存在于主进程内存；子进程 stdout 丢弃；IPC 的 `parametric:start` 在返回前剥离 `port` / `token`；`ipc.ts` 只广播状态，构建结果由主进程代发。

## 自检（参数化 sidecar）

```bash
cd desktop
AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke   # 期望 SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1
```

假内核版本号以 `-fake` 结尾，smoke 用它区分真实内核；不设该变量时输出 `SMOKE_PARAMETRIC_SIDECAR_SKIP`。
