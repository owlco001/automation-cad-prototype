# AutomationCAD 模块化开发计划与进度

> **基线**：2026-10-24，仓库 `main` 的 `3e36c4d`（`origin/main`）。本文件是开发计划，不代表功能已交付；现状以代码和现有测试为准，而不是把架构文档中的目标描述当作实现证明。
> **范围**：仅规划 Electron Windows 桌面端、模块选择/加载，以及此前审查提出的七项功能。最高优先级是软件更新通道。本文不修改应用代码。

## 一、当前基线：已实现、部分实现与未实现

| 项目 | 当前状态 | 代码证据与边界 |
|---|---|---|
| 1. 空 PLC 步序不能显示验证通过 | **未实现，且存在误报** | `desktop/src/plcgen/simulate.ts` 的成功条件允许空数组通过；`desktop/src/plcgen/verify.ts` 将模拟结果直接用作验证结果。`desktop/test/plcgen-p84.test.ts` 的空序列用例目前断言为通过。需要先反转该用例并修正行为。 |
| 2. 联调用例依当前机型 IO 映射动态生成或验证 | **部分实现** | `desktop/src/agent/commands.ts`、`desktop/src/plcgen/precheck.ts`、`desktop/src/plcgen/simulate.ts` 已能取当前机型配置并检查/模拟已配置的 PLC 步序与点位（相关用例见 `desktop/test/plcgen-p84.test.ts`、`p82`）。尚未证明它会为当前机型自动生成完整联调场景、覆盖所有相关 IO，或拒绝所有过期/不匹配映射。 |
| 3. 导入 CAD 几何可参数化编辑；不可识别部分保留只读参考体 | **部分实现** | `desktop/src/cad/step.ts` 解析导入几何为网格；`desktop/src/parametric/features.ts`、`desktop/src/parametric/ui.ts` 提供独立参数化建模；`desktop/src/cad/viewer.ts` 与参数化 UI 存在旧模型 ghost 参考显示。`desktop/src/cad/MODULE.md` 明确目前导入是网格查看，不是 B-rep 参数化特征识别；尚未见导入几何到特征树的转换与失败时逐体只读保留流程。 |
| 4. 可移植工程包包含特征树、运动学标注、视角和依赖模型 | **部分实现** | `desktop/src/sync/package.ts` 现有同步包固定包含 BOM、PDF、GLB、DXF 和 manifest；参数化树、运动学标注、视角分别有独立保存路径（`desktop/src/parametric/`、`desktop/src/cad/`、`desktop/src/orbit/persist.ts`），但没有覆盖这些状态并可导入恢复的完整工程档案。PLC 单独生成 ZIP 不等同于整机工程包。 |
| 5. 参数化特征树撤销/重做与失败恢复 | **部分实现** | `desktop/src/parametric/model.ts` 有增删、移动、抑制、改名和参数更新操作，`desktop/src/parametric/ui.ts` 在构建失败时保留旧结果并记录错误；未见特征树 undo/redo 历史栈、操作级恢复或对应测试。Agent 的 `undo_last` 是另一套操作，不等同于参数树历史。 |
| 6. Agent 计划重启后恢复，保留计划签名/工程指纹校验 | **部分实现** | `desktop/src/agent/thread.ts` 已有进程内计划状态、计划签名、工程指纹及续跑检查；模块说明指出状态不落盘。现有测试覆盖同进程续跑/校验，不覆盖重启恢复；工程指纹也不能替代持久化工程内容校验。 |
| 7. PLC 程序和 IO mapping 纳入工厂同步包 | **部分实现** | PLC 项目 ZIP 位于 `desktop/src/plcgen/`，机型 IO 表由 `desktop/src/machine/io-map.ts` 生成；工厂同步包 `desktop/src/sync/package.ts` 目前仅含 BOM/PDF/GLB/DXF/manifest。需要扩展包清单、上传/校验和往返同步测试。 |
| 软件更新通道 | **未实现** | `desktop/package.json` 已使用 `electron-builder ^26.0.12`，Windows 目标为 x64 NSIS；`.github/workflows/windows.yml` 可构建安装包并在 tag 发布时上传 exe/blockmap，但未发现 `electron-updater`、应用内更新检查、更新渠道或 feed 配置。已有安装包产物不等于软件具备自动更新。 |

### PR #6 边界（独立安全改动，不属于本计划已交付项）

PR #6 `fix/agent-ipc-transport-security`（提交 `c34a9ea`）基于上述 `main` 基线，独立处理 Agent 写操作门禁、可信 IPC/传输及 API key 传递等安全问题，改动集中在 `desktop/electron/`、`desktop/src/agent/`、`desktop/src/shared/`、`desktop/src/sync/client.ts` 与 `sync/config.ts` 及相关测试。它没有实现上述七项功能，也没有修改 `plcgen`、CAD 导入或完整同步包内容。本计划分支仅从最新 `main` 创建；不修改、不合并 PR #6。若 PR #6 后续独立合并，后续实施同步功能时再以其已合并 API 为依赖检查，不在此预先声称已交付。

## 二、模块边界与客户选择方式

- **Core（始终存在的最小平台）**：Electron 主进程及安全 IPC、统一项目/模块 manifest、模块 API 与生命周期管理、权限/能力声明、版本兼容检查、日志与诊断、升级引导和完整性验证。业务模块不可绕过 Core 直接访问文件、网络、PLC 或任意 IPC。
- **系统更新模块（`system.update`）**：作为默认启用的系统模块提供检查、渠道选择、下载进度和安装提示；Core 保留最小更新/完整性引导能力，避免用户误删更新基础设施。客户可选择稳定/测试渠道，以及是否自动下载、何时提示重启；管理策略与离线部署策略待产品确认。
- **可选业务模块**：PLC 校验、联调 IO 测试、CAD 参数化导入、完整工程包、参数树历史、Agent 计划恢复、工厂同步 PLC/IO 等按 manifest 注册；未启用时不加载其 UI、引擎和外部连接器，工程内已有数据不因禁用而删除。
- **模块 manifest 与兼容性**：至少声明模块 ID/版本、支持的 Core API SemVer 范围、依赖模块及版本范围、操作系统/架构、数据 schema/migration 版本、所需能力权限、发行渠道、完整性摘要和发布签名。拒绝不兼容版本、依赖冲突、签名/摘要不匹配的模块；更新模块与更新应用分别版本化。第一阶段可采用随应用安装、用户显式启用的内置模块；验证签名分发后再开放在线按需下载。首发可要求重启后加载，只有生命周期可安全卸载的模块才承诺热加载。
- **用户操作**：安装向导或“设置 → 功能模块”展示模块说明、依赖、权限和版本；用户可启用/禁用、检查兼容性、查看变更记录、选择更新渠道。禁用需提示可能隐藏对应 UI，但保留工程数据；加载失败可回退到上一个兼容模块版本。未经签名/验证的任意第三方可执行扩展不进入 MVP。
- **授权边界**：模块是否收费、免费试用、席位/组织限制、离线激活、维护期、升级资格、模块在工程交换时的授权行为均为**待定**。本计划只定义技术 manifest 与授权检查接口，不替客户制定商业规则。

| 模块 | 首要职责 | 依赖 / 现有基础 | 客户选择 |
|---|---|---|---|
| `system.update` | 桌面程序安全更新、渠道/进度/提示 | Core、现有 NSIS 构建与 Windows Release workflow | 默认启用；由客户选择渠道及自动下载/安装提示偏好 |
| `plc.validation` | 步序/映射验证，拒绝空程序 | `plcgen`、机型配置和 IO schema | 按需启用；建议默认安装 |
| `commission.io-tests` | 根据当前机型映射生成/校验联调场景 | `plc.validation`、`commission`、机型 IO schema | 按需启用 |
| `cad.parametric-import` | 支持几何转换与只读参考体降级 | `cad`、`parametric`、几何内核及导入格式适配器 | 按需启用 |
| `project.portable` | 可移植工程档案导入/导出 | Core project schema、已启用模块序列化器 | 按需启用；导入时检查必需模块 |
| `parametric.history` | 特征树撤销/重做、崩溃恢复 | `parametric`、事务/持久化接口 | 按需启用 |
| `agent.resume` | Agent 计划持久化与安全续跑 | Agent、Core project fingerprint、系统安全存储 | 按需启用；恢复前允许用户审阅 |
| `factory.plc-sync` | 工厂包内 PLC 程序与 IO mapping 同步 | `sync`、`plcgen`、`machine.io-map` | 按需启用；同步权限单独授权 |

## 三、更新通道方案（最高优先级 P0）

### 建议实现

1. **沿用现有 NSIS，不替换安装器。** 为 `desktop` 增加并锁定兼容版本的 `electron-updater`；在 Electron 主进程统一管理检查/下载/安装事件，由受控 IPC 暴露状态，不让渲染进程直接控制更新器。按需扩展现有 `.github/workflows/windows.yml`，在通过构建、测试与签名后生成并发布更新元数据及文件。
2. **更新源先做候选、部署前确认。** 首个试点可使用 GitHub Releases（仓库 workflow 已有 tag 发布路径），但必须同时发布与版本匹配的 `latest.yml`/渠道清单、安装包与 `.blockmap`。若客户需要私有发布、企业内网或对 GitHub 可用性有要求，再选受控 HTTPS generic feed / S3 兼容源；更新源、可见性、可用地区和运维责任列为上线前决策，不将发布写权限 token 嵌入客户端。
3. **版本与渠道。** 使用单调递增 SemVer；初始建议 `stable` 与可选 `beta`，只有有持续维护需要时再增加 `nightly`。渠道分别产生清单、更新说明和发布审批；用户可切换渠道，切回稳定渠道时不得静默降级。已发布坏版本通过暂停该渠道/分阶段发布并发布更高的修复版本处理，不复用相同版本号。
4. **传输与签名安全。** 更新 feed 仅用 HTTPS；Windows 安装包与应用二进制使用受信任的 Authenticode 代码签名。发布 CI 只有受保护环境可调用签名凭据，缺少签名时生产 release 必须失败；客户端保持 `electron-updater` 的 Windows 发布者签名校验开启，拒绝未知/不匹配发布者。校验清单记录的 SHA-512/文件大小，保护 Release 权限与 workflow；不在客户端保存发布凭据。代码签名证书/云签服务与成本尚待产品/运维决策。
5. **增量更新。** electron-builder 26 的 Windows NSIS 目标支持基于 blockmap 的差分下载（`differentialPackage`）；CI/Release 必须保留正确版本的 `.blockmap` 与清单。差分下载是节省流量的优化，不是安全机制；无旧 blockmap、差分失败或校验不通过时退回完整安装包。先对真实安装版本做差分字节量、断网续传/重试和完整包回退测量，再决定是否启用默认差分策略。不要承诺所有版本组合都能达到固定缩减比例。
6. **失败恢复与回滚。** 采用小范围试点/分阶段 rollout（例如内部测试 → 少量用户 → 全量，百分比待运营决定）；保留上一稳定安装包及清单，可暂停渠道并定位问题。下载、hash、签名或安装校验失败不得继续执行未知更新；差分失败转完整包；应用数据放在安装目录外，工程 schema migration 需可备份、可恢复。上游文档指出坏版本应以更高版本号修复，因此不依赖静默降级；提供可验证的修复安装/人工恢复路径。更新系统是否具备自动应用级回滚需经真实 NSIS 安装测试后再承诺。

### P0 验收与进度

- [ ] 依赖锁定、Core 更新服务与安全 IPC 完成；开发态和打包安装态的测试路径分离。
- [ ] stable/beta 至少各完成一次端到端发布验证，渠道选错/旧版本/无更新均有明确用户提示。
- [ ] 在 Windows 干净虚拟机安装旧版并升级；有效签名可更新，缺失/错误签名、错误 hash、损坏清单一律拒绝。
- [ ] 阻断网络、断点、磁盘空间不足、安装器退出/重启等场景后，当前版本和用户工程仍可恢复使用；诊断日志不包含 token/密钥。
- [ ] 从相邻版本下载并记录 blockmap 差分字节量；差分不可用时验证完整安装包回退，不损坏现有安装。
- [ ] 验证暂停 rollout、发布更高修复版本、恢复到上一已知可用渠道的操作手册；数据 migration 有备份/恢复验收。
- [ ] 确定更新源、证书方案、签名责任、渠道审批人和客户端自动下载默认策略后，才开放面向客户的生产发布。

## 四、分阶段路线图

| 阶段 | 优先级 / 当前状态 | 依赖 | 验收标准 |
|---|---|---|---|
| **0. Windows 更新通道** | **P0 / 纯规划，当前未实现** | 现有 `electron-builder` NSIS；发布源与签名方案需决策 | 完成上节 P0 全部验收；失败时不会安装未验证更新，发布过程可暂停和恢复。 |
| **1. Core 模块注册与 PLC 安全校验** | **P1 / 模块框架待建；PLC 校验部分已有** | 阶段 0 的可信分发基础；Core API/manifest；`plcgen` 与 machine IO schema | 模块可显式启停、依赖/版本/权限校验；空/缺失步序必须失败且 UI 不显示绿色通过；当前机型映射变化后旧用例提示失配；测试覆盖每个动作引用和 IO 覆盖/排除项。 |
| **2. 联调 IO 用例与 CAD 导入参数化** | **P1–P2 / 部分基础已有，集成流程未实现** | 阶段 1；`commission`、`cad.parametric-import` 模块；稳定 project schema | 用当前机型 IO 自动生成或验证场景；缺点/重名/类型错配都可定位；CAD 可识别的导入特征转换后可编辑，未识别几何完整保留为只读参考体；导入、保存、重开前后无几何丢失。 |
| **3. 可移植工程档案与参数树历史** | **P2 / 分散存储已有，完整工程包和 undo/redo 未实现** | Core project schema、模块序列化接口、依赖模型清单；`project.portable` 与 `parametric.history` | `.acproj`（扩展名待定）manifest 包含 schema/core/module 版本、特征树、运动学标注、视角、依赖模型、哈希；在另一干净配置导入后可继续编辑；撤销/重做可跨连续操作并在特征构建失败/应用重启后恢复到最近有效模型。 |
| **4. Agent 计划重启恢复** | **P2 / 校验逻辑部分已有，跨重启未实现** | 项目持久化/指纹服务、Core 安全存储、Agent 计划状态版本化 | 每个安全边界持久化计划、游标、待确认项、计划签名、工程指纹；重启恢复时不重复已完成写操作；工程或计划签名改变则阻止自动续跑并要求用户审阅/重新规划；旧 schema 有迁移或拒绝策略。 |
| **5. 工厂同步包加入 PLC/IO** | **P2 / 现有包与独立 PLC 导出部分已有** | 同步 manifest/权限模型、`plcgen` 与 machine IO schema；如 PR #6 后续合并则依赖其实际 API | 包含 PLC 源代码/生成版本、IO mapping、机型/PLC 目标、版本和 SHA-256；同步导出/导入往返一致；缺文件、哈希错、IO 与当前机型不一致可明确拒绝或提示；禁止打包 API key、通信口令等秘密。 |
| **6. 模块目录与按需分发** | **P3 / 仅有数据包注册能力，尚无可执行功能模块分发** | 阶段 0–5 的模块 API、签名发布、兼容性矩阵；授权政策待定 | 客户能查看/选择/启停模块，模块及依赖的 Core/API 版本严格校验；禁用不删工程数据；升级失败可恢复上一兼容模块；无签名/越权模块无法加载。商业授权只接入待定策略，不硬编码臆测规则。 |

### 近期实施顺序建议

1. [ ] 先完成 P0 更新源、签名责任与 Windows 安装测试决策；在签名和恢复验收前，不面向客户启用静默自动安装。
2. [ ] 修正 PLC 空步序误报并增补回归测试；同时建立模块 manifest/Core API 草案。
3. [ ] 将 PLC 校验、联调 IO 场景作为第一个可选业务模块，验证模块启停与依赖兼容。
4. [ ] 统一项目 schema 后做 CAD 导入降级和 `.acproj`，避免多个独立存档格式继续分叉。
5. [ ] 在版本化数据模型稳定后补参数化操作历史、Agent 跨重启恢复、工厂 PLC/IO 同步。

## 五、实施时要引用的代码入口

- **打包与更新**：`desktop/package.json`、`desktop/package-lock.json`、`desktop/electron/main.ts`、`desktop/electron/ipc.ts`、`desktop/electron/preload.ts`、`.github/workflows/windows.yml`。
- **PLC / 联调**：`desktop/src/plcgen/{simulate.ts,verify.ts,precheck.ts}`、`desktop/src/agent/commands.ts`、`desktop/src/machine/io-map.ts`、`desktop/src/commission/`、`desktop/test/plcgen-p84.test.ts`。
- **CAD / 参数化**：`desktop/src/cad/{step.ts,viewer.ts,kinematics-ui.ts}`、`desktop/src/parametric/{features.ts,model.ts,ui.ts}`、`desktop/electron/parametric.ts`。
- **工程包 / 工厂同步**：`desktop/src/sync/package.ts`、`desktop/electron/ipc.ts`、`desktop/src/plcgen/`、`desktop/src/machine/io-map.ts`。
- **Agent 恢复**：`desktop/src/agent/thread.ts` 及 `desktop/test/agent/thread.test.mjs`。
- **当前静态 UI 集成边界**：`desktop/src/extension.ts` 是静态导入并统一初始化的入口；`desktop/src/packs/registry.ts` 管理的是元器件数据包，不应误认为已存在可启停的业务代码模块系统。

## 六、更新方案参考资料

- [electron-builder v26：Auto Update](https://www.electron.build/v26/features/auto-update) — Windows NSIS 更新器、electron-updater 集成、签名校验差异、分阶段发布与坏版本处理。
- [electron-builder v26：NSIS](https://www.electron.build/v26/nsis) — `differentialPackage` 与 blockmap 差分更新配置/限制。
- [electron-builder v26：Windows](https://www.electron.build/v26/win) — Windows 代码签名选项，以及 `verifyUpdateCodeSignature` 默认校验行为。
- [electron-builder v26：Publish](https://www.electron.build/v26/publish) — GitHub Releases、Generic HTTPS 等发布源和发布渠道配置。
- [Electron：autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater) — Electron 内置更新器支持的 Windows 包装形式与平台限制；仓库用 NSIS，因此本计划选择 electron-updater 路线，而不是直接采用内置 updater 的 Squirrel.Windows 路径。
- [Electron：Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) — Windows 构建签名与证书/签名服务说明。

> **进度记录规则**：只有有代码、测试或可复现发布记录的验收项才勾选；计划文本本身不代表功能已完成。当前审计是只读核对，未运行全量测试。