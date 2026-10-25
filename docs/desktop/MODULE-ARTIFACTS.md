# Core-only 与独立模块构建产物

## 现有构建入口

在 `desktop/` 目录执行：

- `npm run build:core-runtime`：类型检查并生成独立 Core Electron runtime。
- `npm run build:core`：生成独立 Core runtime，并生成旧的 Core registry renderer profile。
- `npm run build:modules`：按模块 ID 分别构建独立模块 ESM 与 `.acmodule.zip` 包。
- `npm run build:ext`：保留完整版应用构建，并额外生成独立 Core runtime、MCP 和模块制品。
- `node scripts/build-core-linux-dir.mjs --output-dir=release/<新目录名>`：将 Core runtime 打包成独立 Linux x64 unpacked app。输出目录必须是 `desktop/release/` 下尚不存在的新目录；脚本拒绝覆盖已有输出。
- `node scripts/build-core-linux-dir.mjs --verify-existing --output-dir=release/<现有目录名>`：只检查已经存在的 Core Linux 包。
- `npm run build:core:win-nsis`：从 `dist-core/` 单独构建 Windows x64 NSIS 安装器，输出到 `release/core-runtime-windows-nsis/`；脚本只接受 `desktop/release/` 下的新目录并拒绝覆盖。
- `node scripts/build-core-windows-nsis.mjs --check-only --output-dir=release/<新目录名>`：只校验 Core 输入、NSIS 白名单配置和新输出路径，不运行 electron-builder 或下载工具。
- `npm run smoke:core`：从 `dist-core/` 启动 Electron，验证 Core 界面、项目存储和模块目录未配置状态。
- 对隔离输出目录运行 `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a release/<目录名>/linux-unpacked/automationcad-core-runtime --core-runtime-smoke`：验证实际打包可执行文件。
- `npm run smoke`：运行完整版 Electron headless smoke。

`desktop/dist-core/` 与 `desktop/dist-profiles/` 是生成目录，不应提交。此前未含 CAD viewer 的 Core runtime 为 7 个文件；当前只读预览 runtime 为 9 个：主进程、preload、HTML/CSS、renderer、独立 `core-viewer.js`、Three.js MIT 声明、package metadata 和 profile。Core profile 列出项目存储、模块目录/下载暂存 API 与受限 CAD 预览；它不包含完整版 app 页面、renderer bundle、STEP 内核或可选模块代码。模块暂存实现被打入 Core 主进程 bundle，不会额外复制完整应用依赖。

Windows NSIS 使用独立配置 `desktop/electron-builder.core.nsis.json`，当前精确列入这 9 个 `dist-core/` 文件，不复用完整版的 `build`、`extraResources` 或 GitHub publish 设置。构建后脚本会检查 `win-unpacked/resources/app.asar` 的精确清单、每个文件的 profile SHA-256、`installable: false` 和可选模块禁用标记；NSIS 安装器输出到独立目录。配置明确不签名、不改写可执行文件资源，也不启用差分包；这不构成签名或发布验收。

前轮首次加入 Windows NSIS 配置与契约时只新增配置、构建脚本和本地测试，没有运行真正的 Windows 打包。当前 Linux 主机没有 Wine/`makensis`，也没有缓存 Windows Electron runtime 或 electron-builder 工具缓存；启动 Builder 会需要获取目标平台运行时/打包工具，而本机也不能执行生成的 Windows 安装器。因此没有产生 NSIS installer、没有记录 Windows 包体积，实际安装与 Windows runtime smoke 均未运行，Core 仍保持 `installable: false`。

## Core-only 与体积对照

Core 是独立 Electron app，不再复用完整版主进程或 renderer。其本地工作区目前只支持项目名称和备注的本机新建、列表、打开、原子保存。它不是完整 CAD 工作区，不提供 CAD 建模、PLC、Agent、同步或完整设计流程。

此前 v4 Core unpacked app 在同一 Linux x64、Electron 45.0.0 环境下为 **286,741,709 bytes（273.46 MiB）**，`app.asar` 为 **53,958 bytes**。已有同平台完整版 unpacked app 对照为 **456,857,771 bytes（435.69 MiB）**，其中 `app.asar` 为 **175,106,758 bytes**。该 v4 Core 包目录约小 **37.2%**；两者都包含 Electron/Chromium runtime，因此这不等于节省 37.2% 的安装体积承诺或完整功能等价。v4 的 `app.asar` 只含当时声明的 7 个文件；当前预览版清单与体积见下文续测记录。

完整项目重新验证：`TZ=UTC npm test` 为 **1821/1821 通过**；`npm run build:ext` 通过 TypeScript、Vite、完整 Electron main/preload、Core runtime、MCP 和 10 个独立模块包构建；完整版 Electron smoke 最终输出 `SMOKE_OK`。独立 Core runtime smoke 和本轮新建隔离目录里的实际 Linux unpacked Core 包 smoke 均通过。Smoke 中未配置参数化 sidecar 的分支仍按既有预期跳过；完整版日志中的既有缺文件/损坏审计行、模块关闭拒绝日志和 sidecar 未运行重试日志不影响最终 `SMOKE_OK`。

本轮最终 Core 包输出至 `desktop/release/core-runtime-linux-unpacked-module-staging-v4/`，因为默认 Core 包目录已存在，构建脚本按保护规则拒绝覆盖；旧目录和其他 release 产物均未清理或覆盖。该 Linux unpacked 产物只用于验证，不是 Windows 安装器或公开发行包。

2026-10-25 本地续测：为保留原有 `dist-core/`、`dist-profiles/` 与 release 产物，完整工作树复制到独立临时构建目录后完成 Core runtime 类型检查、Core profile 与 10 个模块制品构建，以及 Linux x64 unpacked Core 打包。全量测试 `TZ=UTC npm test` 为 **1825/1825 通过**；最终目录中的 10 个 ZIP 均按 manifest、文件列表、大小和 SHA-256 复核，Core app.asar 精确包含 7 个白名单文件，并从最终落盘的 Electron 可执行文件运行 `--core-runtime-smoke` 通过。产物位于 `desktop/release/core-runtime-linux-unpacked-p1-20261025/`（274 MiB）与 `desktop/release/module-artifacts-p1-20261025/`（10 个 ZIP 合计 129,709 bytes）。Core 明确保持 `installable: false`，离线能力仅为 `project-store-local-only`；模块未签名且保持阻止激活。此为 Linux 验证构建，不是 Windows 安装器、签名或发布验收。

## Core 只读 CAD 预览续测（2026-10-25）

- 新增限制式 `.stl`（ASCII/二进制）与 `.glb` 2.0 静态三角网格读取和独立 three.js 视口；不支持 STEP/STP。Core 主进程原生文件对话框校验普通文件、扩展、稳定读取与 32 MiB 大小上限；parser 最多 500,000 个三角形、1,000,000 个顶点。GLB 外部 buffer/resource、扩展、纹理、动画、骨骼和稀疏 accessor 均拒绝。不写/保存 CAD、不应用档案、不执行模块、不访问 PLC；renderer CSP 的 `connect-src 'none'` 阻断网络。
- 打包文件白名单只由 9 项组成：`core-main.cjs`、`core-preload.cjs`、`core.css`、`core.html`、`core-viewer.js`、`package.json`、`profile.json`、`renderer.js`、`THREE-LICENSE.txt`。独立 runtime 位于 `desktop/dist-core-p2-preview-20261025/`；Linux 验证包为 `desktop/release/core-runtime-linux-cad-preview-p2-20261025/`，`app.asar` 为 **647,647 bytes**，unpacked app 为 **287,335,398 bytes（274.02 MiB）**。与此前 286,741,709-byte Core 比增加 **593,689 bytes（0.57 MiB，0.21%）**；与 456,857,771-byte 完整版相比目录仍小约 **37.1%**，但未宣称安装包节省或工作区等价。
- 实际打包 Electron smoke 用合成三角形 STL 和 GLB 均创建 WebGL canvas；对各自再选畸形 GLB 与不支持 `.stp`，均报错且保留原预览，外部 resource 请求为 0。现有 Core 项目存储 smoke 通过，17 项 Core 预览/契约测试通过，`tsc --noEmit` 与 Windows 九文件 NSIS `--check-only` 预检通过。Windows installer 未构建或运行；Core 仍 `installable: false`，包未签名，信任策略、生产模块源和激活仍待验收。

## 模块制品与信任边界

目前有 10 个独立 unsigned 模块 ZIP 构建产物。`.acmodule.zip` 只含 `module.json` 和 `module.mjs`；清单包含模块 ID、版本、Core API 兼容范围、依赖、能力声明、入口大小与 SHA-256。包和清单明确标记 `authenticity: unsigned`、`activation: blocked-until-trust-policy`。SHA-256 可发现传输或存储损坏，但不证明发布者身份。

Core 页面新增了可选模块目录与多选下载暂存 UI。目录项严格校验 schema、ID、版本、Core API、依赖与声明能力、包大小（最多 50 MiB）、整体 SHA-256、未签名和 blocked 状态；依赖/能力必须和 ZIP 内 manifest 完全一致，并拒绝重复 ID/版本、任意 URL 字段、不兼容项和越界值。下载地址由主进程根据固定来源及目录中的 ID/版本派生；renderer 不能传 URL、文件路径或任意 IPC。主进程拒绝重定向、非 identity 编码、超限或长度不完整的响应，并只把原始 ZIP 原子写入应用数据目录的 `module-staging/`。每包最多 50 MiB、缓存最多 100 包和 250 MiB，目录最多 1024 项；并发下载会串行处理。包只在内存中有界地读取 ZIP 条目以检查精确文件清单、内部 manifest、ID/版本、兼容范围和 `module.mjs` 大小/SHA-256；不会把文件解压到磁盘，也不会导入、执行、安装、更新、卸载模块或激活模块。暂存目录仅保存 `.acmodule.zip`。

**生产目录源仍未配置**：当前 Core 构建显式使用 `null` 来源，启动模块面板不会发出网络请求，也不会显示或伪造生产模块列表、feed URL、release tag 或可用性。页面不接受用户自定义地址。目录和包下载测试使用只绑定 `127.0.0.1` 的回环 mock；生产源只有在固定 HTTPS 来源、发布者信任根、签名与维护策略审核完成后，才可由应用配置。没有这些信任策略前，unsigned 包必须继续显示为不可信并保持不可激活。

现已加入按已暂存包的模块 ID/版本清理单个已下载 ZIP 缓存包的操作，以释放暂存缓存空间。该操作仅在 staging 明确启用且本地目录安全时工作；重新校验所选包并只删除精确的一个缓存 ZIP，不依赖目录源、不发网络请求。它不是模块卸载，不删除、迁移或修改项目数据或其他包；不解压、安装、更新、执行或激活模块。包仍未签名且不可信，激活仍被阻止；生产目录源仍未配置。

新增 `test/core-module-staging.test.mjs` 覆盖：生产源未配置、默认拒绝非回环 HTTP、固定目录 schema/重复项与 URL 字段拒绝、回环目录下载、包与清单 ID/版本/hash/size 校验、重定向拒绝、ZIP 条目限制、原子暂存缓存及无磁盘解包；并验证只清理所选包、路径遍历/符号链接/未知包/禁用 staging 均拒绝且不影响其他数据、删除时无网络请求。测试使用 loopback mock，不连接真实 PLC、服务器或公网模块 feed。

## 尚未验收与待办

- P2 仍未完成：尚无 Core Windows installer、发布渠道、依赖 allowlist、生产模块 feed、签名信任根、授权/权限审查、模块安装/更新/卸载、模块数据保留或事务回滚。下载暂存原型不是可供生产使用的模块商店，也不允许执行模块。
- Core 仍不是完整 CAD 工作区。后续若要发布最小安装，仍需确定目标系统上的 installer/更新签名与依赖边界，并验证实际离线工程工作流；不能用隐藏 UI 或修改完整包 glob 冒充代码拆分。
- P1 PLC 同步目前只由本机 mock 合同测试覆盖；仓库没有智慧工厂 PLC 服务端。本轮没有真实服务器、生产 PLC 或设备连接授权，也不据 mock 宣称服务端兼容。
- 便携工程档案恢复仍是候选只读预览；跨机器 CAD 几何安全重绑定、viewer/特征树/运动学状态原子替换及事务回滚未就绪，不能开启档案恢复。
