# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。
历史归档：只保留最近一轮的迭代记录；更早的完整记录按原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不进入离线知识索引，避免挤占 400 KB 上限）。

## 模块门控、工程安全与更新通道（2026-10-24，本轮）

- 状态：✅ 本地实现与验证完成；实现提交 `eb0c830`；`TZ=UTC npm test` **1800/1800**、`npm run build:ext`、fake-sidecar Electron smoke（`SMOKE_OK`）通过。
- 范围：内置可选模块注册/依赖/能力检查和多入口门控；Agent 跨重启 checkpoint；CAD 导入/候选加载事务；可移植工程档案严格预览；PLC 值范围/空序列校验、联调兼容检查与 PLC 设计包扩展；stable/beta 手动应用更新和签名发布预检。
- 边界：关闭模块是功能门控，不是代码卸载；工程档案尚不应用/恢复状态；PLC 扩展尚未接入外部服务端验收；更新通道尚未做真实 Windows 签名/安装验收。
- 详情与验证边界见 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md) 本轮归档、[STATUS.md](STATUS.md) 和 [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md)。

## 待办（按优先级）

- **P0：Windows 更新真实验收**：维护者配置并保护代码签名证书/密码、核对 Authenticode Subject；在隔离 Windows 环境验证 stable/beta 升级、签名与 SHA-512 拒绝、blockmap 失败回退、断网/磁盘不足及安装恢复。当前本地 mock/Linux smoke 不替代此项，未通过前不发布。
- **P1：PLC 同步扩展外部联调**：本地目标 PLC 平台选择已实现并测试（默认 `generic`，支持目标写入 `manifest.plc`）；新增的下载候选能力仅允许用户显式导出受限的本地审阅副本，不是安装或应用。服务端兼容性与真实上传/下载联调、经所有者确认的显式工程应用流程及机型安全 IO mapping 持久化口径仍待完成。
-  - 2026-10-25 本地审计：既有 machine profile 仅保存基础 `MachineConfig`，PLC safety 扩展会被 validator 丢弃；IO 表由当前配置派生，未发现带 machine ID/schema/配置摘要校验的持久安全映射。持久化 schema、旧档案迁移和失败关闭草案见 [ARCHITECTURE.md](ARCHITECTURE.md#p1-决策草案机型安全-io-映射持久化2026-10-25)。本轮只增加经过可信主 frame IPC 的显式本地审阅导出；未改变安全映射、同步门控或 PLC 连接行为。待决策/实现事项仍未完成。
- **P1：可移植工程档案恢复**：在只读严格预览后设计用户确认的显式应用、备份与事务回滚；补跨机器 CAD 几何复核，并继续定义尚未纳入的 PLC/工厂/Agent 数据迁移。
  - 2026-10-25 本地安全审计：当前无可证明的跨机器几何重绑定或 viewer/参数化/运动学/视角/持久状态整体事务；未启用部分恢复，继续只读预览。事务设计与故障注入验收条件见 [PROJECT-ARCHIVE-RESTORE-BOUNDARY.md](PROJECT-ARCHIVE-RESTORE-BOUNDARY.md)。本项仍为未完成待办。
- **P2：Core-only 最小化安装与可选模块独立分发（部分原型已实现，尚未验收）**：提供仅含 Core 的安装方式，将可选模块拆分为独立构建产物，并支持用户安装后按需选择下载模块；继续迁移尚未门控的机械、CAD 只读/运动学、工厂、同步和通用导出能力。完整版仍把功能代码编入同一个 renderer IIFE；独立制品和 Core 原型尚未形成生产安装/激活渠道。
  - 验收条件：不含可选模块时 Core 可离线工作；模块可分别选择、下载、更新和卸载；安装/更新前校验兼容性与声明权限；模块数据在卸载及更新时得到保留；模块安装或更新失败不会破坏 Core。
  - 本轮局部进展（不代表 P2 完成）：独立 Core 已支持本机项目列表、新建、打开和保存；Core 页面增加固定来源目录浏览、多选及下载到应用数据目录暂存区的原型，并校验 schema/ID/版本/兼容性/大小/hash。生产目录源仍未配置；loopback mock 仅用于测试，包未签名且不解压、不执行、不激活。Core 仍为 `installable: false`，不含完整 CAD 工作区。详见 [CORE-LOCAL-PROJECTS.md](CORE-LOCAL-PROJECTS.md) 与 [MODULE-ARTIFACTS.md](MODULE-ARTIFACTS.md)。
  - 新增 Windows x64 NSIS 专用白名单配置、构建/包内容检查脚本及契约测试；本轮因 Linux 主机无 Windows Electron/NSIS 缓存且不会为此下载大型目标工具链，未运行实际 installer 构建或 Windows 安装/smoke。没有安装包可交付；Core 仍不是完整 CAD 工作区，`installable` 保持 `false`。
  - 2026-10-25 本地续测（不代表 P2 完成）：在隔离临时副本中按当前工作树完成 Core runtime + Core profile + 10 个独立模块包构建，并生成 Linux x64 unpacked Core 验证包；全量测试 1825/1825、最终目录模块 ZIP/清单校验及实际 Electron 包 smoke 通过。输出位于 `desktop/release/core-runtime-linux-unpacked-p1-20261025/` 和 `desktop/release/module-artifacts-p1-20261025/`。产物未签名，Core 保持 `installable: false`，模块仍阻止激活；未构建 Windows installer、未签名/发布或连接外部服务。Windows 安装验收仍待完成。
  - 本轮局部进展（不代表 P2 完成）：用户现可按已暂存包的模块 ID/版本清理单个已下载 ZIP 缓存包以释放暂存空间；它只是 cache cleanup，不是模块卸载，不删除/迁移/修改项目数据或其他包，也不解压、安装、更新、执行或激活模块。staging 未显式启用或目录不安全时会拒绝操作；清理不依赖目录源且不发网络请求。生产目录源仍未配置，unsigned 包仍不可信且激活被阻止；Windows installer、生产 feed、签名信任、完整安装/更新/卸载，以及数据保留/回滚仍未完成。
  - 2026-10-25 Core CAD 预览续测（仍不代表 P2 完成）：独立 Core runtime 增加只读 STL（二进制/ASCII）和受限 GLB 2.0 静态三角网格预览，原生主进程文件对话框仅接受 `.stl`/`.glb`；单文件上限 32 MiB，三角形上限 500,000、顶点上限 1,000,000。GLB 外部资源、扩展、纹理、动画和骨骼均拒绝；不含 STEP/STP 支持，不编辑/保存 CAD、不应用档案、不执行模块、不访问 PLC，CSP 禁止网络。Core `app.asar` 仅增列独立 viewer bundle 和 Three.js MIT 声明，合计 9 个白名单文件。新 Linux x64 unpacked 目录 287,335,398 B（274.02 MiB），相较此前同机 Core 286,741,709 B 增 593,689 B（0.57 MiB，0.21%）；仍比完整版 456,857,771 B 小 37.1%，但不是安装包或完整 CAD 工作区。实际打包 Electron 使用合成 STL/GLB 验证渲染、坏 GLB 与 `.stp` 拒绝且失败不替换现有预览，外部请求为 0；Core 本机项目 smoke、TypeScript、17 项专项测试、Windows 九文件 allowlist 预检和全量 `TZ=UTC npm test`（1844/1844）通过。未构建 Windows installer；`installable: false`、签名信任与可选模块激活策略保持不变。
  - 2026-10-25 Core 项目附件续测（不代表 P2 完成）：在原项目元数据 schema v1 之外新增独立附件索引 v1；仅允许主进程解析通过的 STL/有限 GLB（每文件最多 32 MiB），按 UUID + SHA-256 存为不可覆盖的只读对象，索引原子更新。必须先明确打开/新建项目，可从附件列表重开；源文件不变，失败不改变项目元数据或已登记附件。不支持 STEP/STP/IGES、任意路径、外部资源、PLC 或模块执行。解析、复制、索引写失败、并发去重、不安全 ID/hash 与 symlink 故障注入 **29/29 专项测试通过**；最终 fresh-output Linux Core packaged smoke 验证 STL/GLB 预览、添加并重开、畸形 GLB 拒绝且项目状态/源文件保持、外部请求 0。最终 unpacked 包 287,374,989 B，较此前 Core 预览包增加 38,647 B（0.01345%）。全量测试与 KB 同步结果见本轮状态记录。Core 仍 `installable: false`，生产 feed、签名信任和激活继续阻止。

## 待决策（需要老王拍板，不阻塞其他开发）

| # | 问题 | 选项 | 影响 | 建议 | 状态 |
|---|------|------|------|------|------|
| D1 | 价格簿的真实单价从哪来 | A 采购/财务给正式价目表；B 用公开目录价并标注来源；C 先空着只做结构 | 成本报告能否用于报价 | B 先跑通，正式报价前换 A | 待定 |
| D2 | 智慧工厂生产环境谁来部署 0.22.0 | A 对方运维；B 我们远程部署；C 只在测试环境验证 | 端到端联调能否做 | A，我们提供验收清单 | 待定 |
| D3 | PLC 程序生成首期目标平台 | A 通用 ST 优先；B 西门子 S7 优先；C 汇川/三菱优先 | 模板与变量表格式 | A，其次按现场实际 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | A 立项并定义接口；B 先只做数据导出；C 暂缓 | 路线图与汇报口径 | B 过渡，接口按 A 设计 | 待定 |
| D5 | 元件库缺失尺寸（180/371）能否用「同系列壳体推定」 | A 允许并标注推定；B 只用实测/官方值，缺的留空 | 底板布置覆盖率 | A + 标注，人工复核 | ✅ 已按 A 执行：244/371（65.8%），官方 37 + 推定 16；剩余 127 条留空，清单见 `docs/desktop/DIMS-GAPS.md` |
| D6 | 参数化建模首期范围 | A 只做单件结构件；B 单件+多体装配；C 直接上草图约束 | 工期（A≈3 周，B≈6 周） | A 先交付，B/C 分期 | 待定 |
| D7 | 成本面板如何拿到 BOM（CAD 零件名 → 元器件物料号映射口径） | A 由底板画布/电气元件库直接给 partId，成本面板只读；B 允许「零件名规则匹配 + 人工确认」自动填 partId；C 保持手工导入 BOM JSON | 影响成本能否一键算；B 需要命名规范（如 `QF1:LC1D09`），否则匹配率低 | A 长期方向，短期用 C + 预留 B | 待定 |
| D8 | Agent 的 `run_cost_report` 是否允许落盘导出报告 | A 保持只读，只回摘要；B 增加写工具 `export_cost_report`（PDF/CSV，走现有二次确认）；C 由面板导出，Agent 只给「点哪里」 | 影响「一句话出报价单」的体验；B 需要确认文件名/目录规则与覆盖策略 | B：`export_cost_report` 固定写 `userData/exports/`，默认不覆盖、冲突追加序号 | 已定 B，已实现（`23cd284`） |
| D9 | 离线规则路由是否要在「模型可用时」也前置生效 | A 仅在模型失败时降级（现状）；B 高置信度只读指令直接走规则，省一次模型调用；C 全走模型 | B 更快更省 token，但规则误判时用户得不到语义纠正，且两套路径要长期保持一致 | A 先稳定；若要 B，先攒 40 条评估集对比准确率再开 | 待定 |
| D10 | 中文评估集用哪条通道跑基线 | A 只用离线规则路由（零成本、可离线、但只覆盖规则能判的句式）；B 规则 + 真实模型双跑（能测语义理解，按 token 付费）；C 只跑模型 | 决定评估结论代表「规则上限」还是「产品上限」；B 需要一把可用的付费/自建模型 key 与预算口径 | A 先立基线并进 CI 友好（无网络），B 作为发布前手动回归；已落地离线 61 条 + 真实模型 30 条（`agent:live`，30/30；拒绝/澄清 6/6） | ✅ 已按 B 执行 |

## 已知问题（记录，不阻塞）

1. **运动学标注是启发式**：STEP 不含运动学，名称/型号/层级/几何只给建议，斜向运动、夹爪对侧手指与缩回位仍需人工确认。
2. **尺寸覆盖不全**：已补 342/612 实型号（55.9%，含同系列推定），其余在底板画布按「未标注尺寸」处理；清单见 [DIMS-GAPS.md](DIMS-GAPS.md)。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256。
4. **安装包未签名**：Win11 SmartScreen 会拦一次。CI 仍手动触发。
5. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准；价格簿 example 条目不参与计价。
6. **离线意图路由是关键词规则**：审计已轮转（5 MB × 5 份 × 90 天），CSV 只导当前列表；回执无 token 用量。
7. **真实模型拒绝/澄清类**：仓库内 6/6 已过 MT04，但仍是单模型；换措辞需重跑 `npm run eval:agent:multiturn`。
8. **时区**：成本导出文件名断言按 Asia/Shanghai，测试请用 `TZ=Asia/Shanghai npm test`。
9. **安全光栅**：已补 8 条官方来源型号与六工位 BOM 初选，安全距离仍需按 ISO 13855 现场核算。

> 历史问题原文见 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md#历史已知问题原文2026-10-24)。


## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败

## 仓库双推约定（GitHub + Gitee，2026-10-24 起）

- 主仓库：`origin` = GitHub `owlco001/automation-cad-prototype`；镜像：`gitee` = Gitee 同名仓库（公开）
- `origin` 配置了两个 push URL（GitHub 在前、Gitee 在后），因此 `git push origin main` 会自动双推；任一远端失败则整体失败，**不允许只推成功一边**
- 推 tag 必须用 `git bothpush`（等价于 `git push origin main && git push origin --tags`），普通 push 不带 tag
- 新增 tag 后必须核对：`git ls-remote origin refs/tags/<tag>` 与 `git ls-remote gitee refs/tags/<tag>` 都存在且指向同一提交
- 发版/合并后复核三方 HEAD 一致：
  `git rev-parse HEAD`、`git ls-remote origin refs/heads/main`、`git ls-remote gitee refs/heads/main`
- Gitee 偶发 5xx 或超时：重试一次即可，不要改成只推 GitHub 了事；连续失败要在本文件记录时间与错误码
- 凭据只存在 `~/.git-credentials`，禁止写进仓库、提交信息或日志
