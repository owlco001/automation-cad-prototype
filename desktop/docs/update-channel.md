# Windows 应用内更新 MVP

## 用户侧行为

Windows NSIS 安装版可从工具栏“软件更新”入口选择稳定版 `stable` 或测试版 `beta`，手动检查并查看当前/可用版本。发现更新后必须点击“下载更新”；下载进度会显示在面板中。下载完成不等于安装：用户点击“安装并重启”后，主进程还会弹出 Windows/Electron 原生确认框；只有确认才以非静默方式启动 NSIS 安装器。应用退出不会自动安装。

`system.update` 是默认启用的可选模块，依赖 `core`。关闭模块会立即隐藏入口、关闭更新对话框并退订 UI 状态事件；主进程对状态、渠道、检查、下载、安装各 IPC 逐一检查状态，关闭期间直接调用 API 也会被拒绝。重新启用后会从主进程读取现有状态，继续相同的手动流程。

开发态、非 Windows 运行态、更新源不匹配或嵌入的 `publisherName` 缺失/为空时，更新检查会关闭并给出状态说明。这个 Core 门禁始终执行，不受可选模块开关影响：electron-updater 6.8.11 的 Windows NSIS 实现会在缺少 `publisherName` 时跳过发布者签名检查，因此此 MVP 在发出网络请求前拒绝这种安装包。

## 渠道与发布

- 稳定版使用单调递增的 `X.Y.Z` 版本、GitHub Release 正式版与 `latest.yml`。
- 测试版使用 `X.Y.Z-beta.N` 版本、GitHub Release prerelease 与 `beta.yml`。
- Windows workflow 的 tag 发行入口要求 tag 与 `desktop/package.json` 版本完全一致；只接受以上两种格式。
- workflow 为 electron-builder 指定 `--publish never`，因此打包阶段不会创建 GitHub Release。只有 tag workflow 后续的显式 GitHub Release 步骤上传安装包、`.blockmap` 和 `.yml` 清单。当前任务未运行 tag workflow、未创建 Release。
- 发行环境必须配置 `CSC_LINK`（PFX/P12 文件或受支持的签名凭据引用）和 `CSC_KEY_PASSWORD`。生产 tag 构建还会启用 `forceCodeSigning`，并在 Release 步骤前验证 `win-unpacked/resources/app-update.yml` 有真实 `publisherName`、清单含版本/SHA-512、安装包和 blockmap 都存在。没有签名凭据时流程失败，不会发布未签名更新。
- 更新源固定为 HTTPS GitHub Releases：`owlco001/automation-cad-prototype`。发布凭据不写入客户端。

用户切回稳定版时不允许降级。electron-updater 在设置 channel 时会自动打开 `allowDowngrade`，所以服务每次设置渠道后都显式重设为 `false`。

## 差分与完整包

electron-builder 26.x 的 NSIS 配置显式启用 `differentialPackage`，electron-updater 保持差分下载开启。NSIS `.exe.blockmap` 随版本上传；在 Windows 上缺少/差分下载失败时，electron-updater 会回退到完整安装包下载。完整包仍按更新清单 SHA-512 校验，下载的安装器仍由 electron-updater 按嵌入的发布者名做 Authenticode 校验。差分不是签名或完整性校验的替代品。

本地 mock 测试覆盖差分失败时走完整包下载分支；这不等同于真实 Windows 的网络、签名、安装或回滚验证。

## 上线前仍需完成

1. 配置并保护 Windows 代码签名证书/签名服务，核对其 Authenticode Subject；确认发布者身份稳定且与受信任的历史版本一致。当前未申请或注入签名凭据。
2. 在隔离 Windows 虚拟机完成 stable 与 beta 的真实 GitHub Release 升级验证，包括错误/缺失签名、清单/hash 损坏拒绝、差分失败完整包回退、断网/磁盘空间不足和安装恢复。
3. 量测相邻 NSIS 版本的实际差分字节量；配置证书和完成这些测试前，不得把本地 mock 测试或 Linux smoke 描述成已验证真实发布。

## 官方实现依据

- [electron-builder v26 Auto Update](https://www.electron.build/v26/features/auto-update/)：Windows NSIS 支持、手动 updater 事件与更新状态。
- [electron-builder v26 Windows 配置](https://www.electron.build/v26/win/)：`verifyUpdateCodeSignature` 默认启用，并按 publisher name 校验。
- [electron-builder v26 NSIS 配置](https://www.electron.build/v26/nsis/)：NSIS `differentialPackage`/blockmap 支持。
- [electron-updater v6.8.11 NSIS updater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/NsisUpdater.ts)：完整包 SHA-512 传输与安装器签名验证；Windows 差分失败会退回完整包。
