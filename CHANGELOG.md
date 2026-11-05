# 更新日志

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [未发布]

### Fixed · 输送/移载机型里的幽灵 90° 旋转轴与直线轴命名

- **清掉幽灵轴**：`templates.ts` 的输送模板不再给每工位挂 `{ kind:'rotary', count:1 }`。驱动滚筒是**传动件**，按 `role:'drive'` 留在 BOM（带 `ratedW`，用于电机选型），但不落成 `config.actuators` 里的站轴——那条 `st1-rotary-1`（`rotationRangeDeg=90`、`point=ST1-ROT-A1`）几何里根本不存在，却会写进 `DB_IO`（`工位1_工位1旋转轴1_旋转`）并占据 PLC 步序第 1 步「工位1旋转轴1分度 90°」，与「输送/移载不改变板材方向」直接冲突。模块 `templates.ts` 新增 `optionalStationActuators`（只有 `conveyor` 为 true），`synthMachine` 据此**不再为没有动作的工位补假轴**；`validate.ts` 允许 `config.conveyor` 存在时 `actuators: []`（其余机型仍必须有执行机构）。转向机型的 `turner-rotary` 保留不变
- **直线轴不再叫「旋转」**：`plcgen/io.ts` 的 `actuator.point` 按 kind 取语义（`rotary` → 「旋转」，`cylinder/gripper` → 「动作」）。变量表由 `移载工位_移载工位顶升台_旋转` / `移载工位_移载工位移载台_旋转` 改为 `..._动作`，注释同步；`design/wizard-state.ts` 的点位重复报错文案同样按 kind 取词
- **驱动电机进功率**：新增功率角色 `drive`（`POWER_ROLE_LABEL.drive = '驱动电机'`，默认 90 W），`powerInputFromDesign` 读 BOM 里 `role='drive'` 的行；`synthMachine` 把 `applyConveyorRefinement` 提到 `estimatePower` 之前，否则线体减速电机（整机唯一大负载）永远不计入电气容量。输送机型功率因此变化（例：4000×600 皮带线 0.108 → 0.056 kW，光伏转向线 0.212 → 0.553 kW）
- **台阶**：非输送机型（锁螺丝/点胶/装配/检测/包装/转盘/流水线）的 config、io-map、变量表、PLC 十一个文件**逐字节不变**（sha256 对照见 `docs/desktop/AUDIT-transfer-2026-11-05.md` 的修复记录）；输送类机型 BOM 只改 `role`（`other` → `drive`），成本不变，PLC 步数与点位数变化
- 测试：`templates.test.mjs` 改为断言输送模板无站轴；`conveyor-synth.test.mjs` 新增「输送线 config 里没有任何 rotary 轴 + 驱动电机仍进 BOM/功率 + io-map 无幽灵点位 + 无可推导步序」；`nl-transfer-scenario.test.mjs` 的 tf01 从「剩下的 rotary 不在转向工位」升级为「一条旋转轴都没有」；`interference-states.test.mjs` / `machine-geometry.test.mjs` 的代理体件数 48 → 45（少了幽灵轴的 3 件）；`eval-tasks.mjs` t01/t13 与 `machine-e2e.mjs` 第 2/9/12 步新增硬断言（无 `st*-rotary-*`、移载机无旋转轴、步序第 1 步不得是「分度」）

### Added · 顶升移载（直角移载，板不转向）

- 需求解析：`顶升移载 / 直角移载 / 移载机构` → `brief.transfer`；与 `turner` 互斥（同一句话里同时出现时移载优先，两套机构抢线体中段同一段 X）；`detectTransfer` 只认明确词，普通输送线不长出移载工位
- 参数化几何 `conveyor-assembly.buildTransferParts()`（与 turner 并列，共 50 件）：安装板 + 4 吊柱 + 2 顶升气缸（缸体/活塞杆）+ 4 导柱 + 随动台板 + 5 根 φ50 移载辊（轴向 X）+ 10 根 φ30 轴承立柱 + 推板（+ 无杆气缸 / 2 横梁 / 2 立柱）+ 下游对接段（2 纵梁 / 5 输送辊 / 4 支腿 / 2 挡边 / 挡停 / 2 光电）
- 三条硬约束（都是算出来才落地的）：辊与立柱**全部落在带缝中心**（φ50/φ30 < 带缝 120），上行程一根带不断；随动台板顶升到位 786 < 带底 846；推板下沿 915 高过挡边顶 911。任何**沿 Y 延伸**的梁/滑车导轨在顶升过程中必然扫过带体所在的 846~850，所以移载件一律做成点状
- 移载行程 = 板宽 + 结构间隙（台板边 → 对接段起点）+ 120 余量，全部由参数推出（1200 带宽 / 800 板宽 → 1140 mm），并校验下限（板尾整块落料 ≥ 1060 mm）
- 运动轴：`transfer-lift`（Z，60 mm，与转向工位同口径）+ `transfer-push`（+Y，1140 mm）；本域只有 cylinder/gripper/rotary，`transfer-push` **借 cylinder 表达直线移载**，借用的口径写进 assumptions（行程/方向见 `travelMm` + `position`）
- 联锁：输出 `DO-TRANSFER-READY` / `DO-TRANSFER-DONE`（新增 `config.ioPoints` 扩展点位，io-map 里 direction=输出）+ 输入 `DI-DOWNSTREAM-ALLOW`（绑工位）/ `DI-TRANSFER-END`（绑 `transfer-push`），到位信号 `ST-TRANSFER-LIFT-UP/DOWN` 绑 `transfer-lift`；安全回路与转向工位一致（急停 + 安全门）
- 参数护栏（拒建就给数字理由，不静默退化成普通输送线）：带宽 < 1080、线体太短、板宽 > 带宽、移载行程超 2000、与转向/立体缓存互斥、皮带面太低
- 三态干涉新增 `push` 态（复合位姿：先按顶升轴抬到行程顶，再按移载轴沿 +Y 推到行程末端，行程读 config）；`run_interference_check(states)` 支持 `rest/lift/sweep/push`
- 3D：视口按**材质**着色（AL6063 / Q235 / STEEL45 / PVC 各一色），两台机器的机架/钢件/皮带一眼可分
- 机具/落盘：`design-conveyor-<n>st-transfer` 独立机型 id（否则与转向线撞 id，apply 报「机型方案已存在」）；`build_machine_model` 也认移载意图（否则一句话要移载工位，出来的还是普通输送线）

### Fixed · 移载需求的口语说法能被智能体入口接住

- 路由器新增「机型描述句」意图（`isMachineBriefRequest`）：没有「设计/做一台」动词的名词短语需求（「转向输送机，不改变板材方向，顶升后向 90° 方向输送板材，并给下游输送机一个信号」）此前落 `out_of_scope`，等于拒答一台完全可做的机器；现在判 `generate` + `design_machine`，问句/指代现有机器/成本干涉这类句子仍按原意图走
- `detectTransfer` 认「顶升 + 向/沿/往/朝 + 角度 + 输送动词」和「顶升 + 送到/平移 + 下游」两种**只描述动作、不点名机构**的说法（中文需求里 8 成不写「移载」二字）；「顶升旋转 90° 转向」没有方向介词，仍判转向工位
- `detectTurner` 认否定式（「不改变板材方向」「板不转」）：否则「转向输送机 + 不转板」会凭空长出回转机构
- 带宽只写了「带宽 800mm」也算输送线工艺（`process=conveyor`），否则移载意图拿不到带宽、拒建理由也不会出
- 移载机型未写带宽时按 1200 mm 常用档取（缺省 300 mm 根本放不下移载辊道，下限 1080 mm），并在 assumptions 里写明「带宽未写、按常用档取」；**用户写了的带宽原样保留**（800 mm 仍拒建给算式）

### Tests · 移载场景固化

- `docs/desktop/eval/cases.json` + 旧路径副本 `desktop/eval/agent-cases.json`：新增 `tf01`–`tf04`（127 → 131 条），`eval:agent` 另加**副本一致性硬校验**（此前副本已悄悄漂了 ml05/ml06/au01 三条）
- `desktop/test/machine/nl-transfer-scenario.test.mjs`：用真 `AgentSession` + 真 `AgentTools` + 真 `CommandBus`（组合与 `electron/ipc.ts` 的 `agentExecutor` 相同）跑四条句子，断言末态（移载工位 / transfer-lift Z / transfer-push +Y / 两个 DO / 两个 DI / 无 turner-* / 800 mm 拒建含 1080 算式）
- `scripts/eval-tasks.mjs` 新增 `t13-transfer-unit`（12 → 13 例）：parts=110、PLC 预检 blocked=0、io-map 四个握手信号、rest/lift/push 三态 confirmedHits=0

## [0.6.5] - 2026-11-04

### Added · 机型库远程目录与下载（用户自选加载/下载）

- `sources.json`（`userData/machine-library/sources.json`，**默认空、不预置任何外网地址**）：`{schemaVersion:1, sources:[{id,name,url,enabled,priority?,allowFile?}]}`；坏配置报 `LIBRARY_SOURCE_INVALID`，不静默当「没有来源」
- 目录协议 `{schemaVersion:1, machines:[{id,name,version,sizeBytes,sha256,downloadUrl,minAppVersion?,tags?,allowCrossOrigin?}]}`：`schemaVersion≠1` 拒（`LIBRARY_UNSUPPORTED_SCHEMA`）；每条 64 位 hex SHA-256、尺寸 ≤50 MiB、`downloadUrl` 与目录同源（或该条显式 `allowCrossOrigin:true`）；总数 ≤500
- 安全线：只认公网 `https`（`file` 仅开发，需该来源 `allowFile:true`）；`http`、回环、`10./172.16-31./192.168./169.254.`、IPv6 ULA/链路本地、IP 直写一律 `LIBRARY_URL_REJECTED`；带账号密码的 URL 也拒
- 下载：流式累计、>50 MiB 立刻 destroy；边下边算 SHA-256 与目录比对（不符 `LIBRARY_HASH_MISMATCH`，**不重试**）；通过后交给现有 `importPackage`（唯一一套严格解包 + 原子落盘），失败不留半包
- 超时 5 s 建连 / 60 s 总时长，网络错误只重试 1 次；同名机型默认 `LIBRARY_EXISTS` + hint，**没有 overwrite 通道**
- 目录缓存 10 分钟，拉不到回退旧缓存并标 `stale:true`
- 工具 36 → 38（只读 19 / 写 19）：`list_machine_sources`（只读）、`download_machine_from_source`（写，需确认）
- 机型库抽屉新增「远程来源」区：来源状态（在线/离线/停用/缓存）+ 可下载机型 + 每行「下载」（二次确认）；不改现有视觉风格

### Added · 智能体能力（v0.6.4 之后）

- **自适应迭代预算**：只读 6 轮；出现写工具或计划 ≥4 步 / 联调意图 → 12 轮；到顶返回 `iteration_limit` + `pendingHint` + `nextStepIndex`，可断点续跑（`runPlan` / `runRecipe` 同一实现）
- **写后自动验证**：`apply_machine_design` / `repair_plc_config` / `run_plc_generate` 成功后自动校验，回执附 `verification{ok,issues,nextAction}`；验证失败不误判主操作
- **视觉自检**：`capture_view` 结果以 OpenAI 兼容 `image_url` 回灌；模型不支持时自动去图重试并**明说未看到图像**；区域截图 `region + scale`（先裁后缩，越界夹紧）
- **跨会话项目记忆**：`agent-memory.json` 按工程指纹存事实（≤20 条/≤64KB），首轮注入 3 条；`get_agent_memory` / `clear_agent_memory`
- **大结果外置**：超 10 KB 落 `agent-results/<sha16>.json`，回执给 `resultId` + 提示；`get_tool_result` 按字符边界分批回取
- **失败自查**：`get_recent_audit` 读最近审计（按工具/失败/时间过滤，args 仅白名单字段并脱敏）
- **收尾可继续**：`turnOutcome` 接到 IPC/UI，两种停止原因分开表述并可一键【继续】

### Fixed · 本轮修掉的真实缺陷

- 方案卡从裁剪后的列表里读 warnings/statistics（CI 机型截图红过两次）
- `exports` 视图截图长期是 `3d` 那一帧（sha256 完全相同）；视图切换不清理浮层；入口对隐藏节点直接 `click()` 绕过真实路径
- 区域截图坐标系写死 1600×1000：高 DPI 屏（`capturePage` 返回 3200×2000）上请求右侧/下侧区域会被常量夹回左上、根本截不到。现在 `region` 按**本次截图的真实像素尺寸**（读 PNG 头 `pngSize`）夹紧，`x=2000,y=1200,w=800,h=600` 在 3200×2000 上原样生效（`clamped:false`、`sourceSize=3200x2000`），可用范围以返回的 `sourceSize` 为准
- `runPlan` / `runRecipe` 不经过 `AgentSession`，预算与自动验证在那两条路径上未生效

### Fixed · 参数化整机的布局/尺寸约束（几何源统一后第一次真看到整机结构）

几何源统一到 85 件参数化整机之后，评审/三态干涉第一次能看到真实零件，于是浮出一批**真干涉**（旧代理体里根本没这些零件）。逐对定量后按布局重排修掉，没有靠 joints 声明掩盖、也没有动干涉阈值：

| 配置 | 零件对 | 修复前 | 修法 |
| --- | --- | --- | --- |
| 3000×600×3 层缓存 | `gearmotor` × `column-bl` | 224000 mm³（exact） | 电机让到缓存立柱**外侧**（留 5 mm 安装面），Y 位按立柱反算 |
| 同上 | `belt-top/return` × `lift-post-left/right` | 5026.5 mm³ ×4（exact） | 升降导柱移到缓存立柱外侧同一排（y = 立柱中心 + 型材 + 5），X 向与立柱错开 60 |
| 同上 | `belt-top/return` × `lift-chain-left/right` | 480 mm³ ×4（exact） | 链条随导柱一起外移；升降电机再让到导柱外侧 |
| 同上 | `tray-rail-*` × `tray-roller-*` | 18000 mm³ ×8（aabb，辊面低于托条顶 9 mm） | 层辊改到两根托条**之间**（辊长按托条内宽取），辊面抬到托盘底面 |
| 全部单层线 | `pulley-drive/tail` × `guard-left/right` | 360 mm³ ×4（aabb，挡边下沿比带面低 4 mm） | 挡边下沿 = 带面 + 1 |
| 2500×400 转向窄线 | `turner-hanger-1..4` × `turner-lift-plate` | 4800 mm³ ×4（exact） | 带宽护栏拒建（见下），吊柱 Y 位另有下界约束 |
| 同上 | `rail-left/right` × `turner-table` | 352000 mm³ ×2（aabb，φ880 盘 > 纵梁内宽 430） | 同上 |
| 980 mm 宽转向线（新增边界） | `turner-motor` × `belt-return-3-out` | 28800 mm³（exact，5 条窄带时带中心在轴线上） | 窄带条数一律取偶数；电机改落在最近的那条带缝里，箱体 Y 向 90 |
| 1100/1120/1160/1180 宽转向线（新增边界） | `turner-finger-*` × `turner-finger-*` | 244652 mm³ ×4（exact，非整数节距下同一指位被算两遍） | 指位去重键按最终坐标取整，一址一指 |

- `turnerSkipReason` 新增**带宽下限护栏**：顶升单元横向要占「台板 960 + 两侧吊柱各 20」，吊柱外侧面贴纵梁内侧面、与台板留 5 mm → 带宽 ≥ **980 mm**（`TURNER_MIN_WIDTH_MM`）；不足时拒建并给可执行理由（"带宽 400 mm < 转向工位所需最小 980 mm：… 请把线体加宽到 ≥ 980 mm，或改用台板 ≤ 380 mm 的窄型转台"）。转台盘 φ880 + 两侧 40 mm 侧隙只要 960，不是控制项
- 窄带条数取偶数（4 折对称指位要求轴线上是带缝）：1200 → 6 条不变，980 → 4 条，600 → 2 条
- 4 种代表性配置三态干涉全部 **confirmed=0 / screen=0**：6000×1200 带转向（rest/lift/sweep）、3000×600×3 层、2500×400（转向拒建后退化为普通线）、2000×300；边界 980 也能三态归零
- 几何事实变化（按新事实更新，不是放宽断言）：2500×400 转向线从 51 件退化为 29 件普通线（拒建）；600 宽缓存线层辊规格 `φ50 × 510` → `φ50 × 280`；转向电机箱 Y 向 110 → 90
- 新增 `test/machine/conveyor-layout-constraints.test.mjs`（13 条：4 配置归零、三态归零、电机×立柱、导柱/链条×皮带、托条×层辊、挡边×带面、拒建理由含数字、980/979 边界、盘×纵梁、吊柱×台板、指位 4 折闭合、一址一指、无顶升轴如实上报）；`test/agent/self-evidence-tools.test.mjs` 的转向样机带宽 600 → 1200（600 宽现在合法拒建）

### Release

未签名预览包 `AutomationCAD-Setup-0.6.5.exe`（154,246,911 B / 147.1 MB，sha256 `c4f1031f…`），
构建自 `main@227e4a0`（windows-build run 41858479958），以 **pre-release** 发布、只含 exe；
`latest.yml` / `.blockmap` 故意不带，避免未签名包进入自动更新通道。

### Changed · 质量口径

- 测试 3093 → 3143（新增布局约束 13 条、远程下载 24 条、STEP 门禁 11 条等）；工具 25 → 38（只读 19 / 写 19）
- `eval:tasks` 6 → 12 条末态断言（含结果外置、记忆、计划续跑、写后验证、STEP 真实性），已进 CI 门禁

## [0.6.4] - 2026-11-04

### Added · 转向工位改为顶升旋转单元（真机做法）

机台太长的问题落地：6 m 线体上不再用固定转台，改为「平时台面低于带面 → 到位顶升 60 mm → 旋转 90° → 回落」。

- 输送面 1200 宽单带换成 **6 条窄带并联**（单条 80、带缝 120、节距 200），上行程整条连续，工件全程不离开输送面；回程只在单元处让位 920
- 顶升单元：底座框架 + 下沉吊柱 + 顶升气缸 + 导向柱 + 升降台板 + 回转支承 + φ880 转台盘 + 9 只支撑指 + 转向电机（整机 85 件）
- 穿缝原理：指宽 70 < 带缝 120，指位取带缝中心 0/±200/±400 且 4 折对称，转 90° 后落点仍是同一组带缝
- 两条轴 `turner-lift`（Z 60 mm / 2000 ms）+ `turner-rotary`（90° / 1800 ms），节拍 3.8 s；四个到位信号分别绑到对应执行机构
- 真实 B-Rep 验证（build123d + OCCT）：静止 / 顶升到位 / z=0..60 扫掠三态全部零干涉；负向自检（故意偏 60 mm）能报出 12 处
- 带转向工位的机型补最小安全回路（急停 + 安全门），PLC 预检从 blocked=2 到 blocked=0，11 个文件与 ZIP 真正落盘

### Added · 机型库（机型是数据，不是代码）

- `.machine.zip` 包格式（schemaVersion 1）：manifest 逐文件 sha256 + config + 可选 geometry/bom/plc/shots；限额与固定错误码
- 本地库 `userData/machine-library/<id>/` + catalog（与磁盘对账，索引坏了按 manifest 重建）
- 导入原子性：先解 `.tmp-<uuid>` 全量校验再 rename；拒绝路径穿越（含 adm-zip 会归一化的 `../`）、篡改、超限、版本不符
- 导出字节稳定（固定 ZIP 条目时间戳），同一机型重复导出 sha256 相同
- 面板：工具 → 模块 → 机型库，列表 / 加载 / 导入 / 导出 / 删除；文件选择全在主进程，渲染层拿不到 fs

### Added · 智能体能力（自查、自修、自证、可度量）

- 机型库四工具：`list_machine_library` / `save_machine_to_library` / `load_machine_from_library` / `export_machine_package`
- `validate_machine_design`（只读自查，返回 code/path/hint）、`repair_plc_config`（默认 dryRun）
- `capture_view`：真截图落盘并返回 sha256；停在首页时返回 `VIEW_NOT_READY`，不拿首页冒充
- `capture_view` 区域截图：`region:{x,y,w,h}`（原图像素，`w,h>=32`）+ `scale`（0.5–3）。**先裁后缩**（裁在原像素上做，再放大），越界只夹紧并在返回里给 `{region,clamped:true,scale,sourceSize}`，`w/h<32` 返回 `INVALID_ARGUMENT`；回灌仍压到长边 ≤1024 / ≤400 KB，提示词写明「这是 <view> 的局部（x,y,w×h）」。不传 region 且 scale=1 时落盘字节与旧版逐字节相同
- `run_interference_check` 支持 `rest / lift / sweep` 多态，行程从机型 config 读
- `npm run eval:tasks`：10 个任务级末态断言（轴/零件数/PLC 预检/库往返/三态/截图真伪），变异自检会红；已接进 CI 门禁

### Fixed · 三处校验器收敛为单一源

`store.ts` / `commission/machine-config.ts` / `plcgen/precheck.ts` 原来各判一套，导致安全传感器被判非法、`conveyor` 白名单漂移。现在统一到 `src/machine/validate.ts`（`DesignIssue{code,path,hint}`），并显式区分两种模式：方案走严格绑定，现场 IO 映射导入走宽松（与历史行为一致）。

### Fixed · 列表结果形状不一致（25 行 BOM 被当空 BOM）

`trim.ts` 原来在 >20 条时把数组裁成 `{items,total}`，消费方仍按数组读，成本流程因此把 25 行 BOM 当空 BOM 拦下。现在统一 `ListResult{items,total,truncated}`，**条目一条不删**，只截条目内长字符串；形状不认识直接抛错而不是静默变空。

### Release

未签名预览包 `AutomationCAD-Setup-0.6.4.exe`（154,345,807 B / 147.2 MB，sha256 `fd3cf2fc…`），
构建自 `main@0978d81`（windows-build run 41743790161），以 **pre-release** 发布、只含 exe；
`latest.yml` / `.blockmap` 故意不带，避免未签名包进入自动更新通道。

### Changed · 工具与测试口径

- 工具 25 → 32（只读 15 / 写 17），工具数哨兵改为注册表自校，加工具不再需要改 8 个测试文件
- 测试 2866 → 2954（0 fail）；`eval:agent` 120/120；`eval:tasks` 6/6

## [0.6.3] - 2026-11-02

### Added · 运动学标注：批量采纳 + 水平偏角

- **一键采纳高置信 / 按机构归组批量采纳**：门槛为置信度 ≥0.8、行程来源 ∈ {型号码, 样本表}、偏主轴 ≤5°；100% 置信的几何估算照样拒绝。批量各落 1 条审计，支持整批撤销（采纳前深拷贝快照，被手改过则拒绝），批量若新增校验错误则整批回滚。此前抽屉里没有任何 undo。
- **水平偏角 `yawDeg`**：标注层原来只有 ±X/±Y/±Z，`axisPose` 只写单个 offset 分量——30° 的斜装在**存储时**就丢了信息。现在 `yawDeg` 可选（缺省 0，旧标注逐位不变），位移按 `unit(axis,yaw,direction)×行程` 写 x/y 两个分量；Z 向轴绕 Z 直接报错。
- 偏角扣分改为只扣**残余倾角**：≤3° 不扣，之后每度 0.01、封顶 0.6。旧公式 `min(0.3, off/100)` 在 30°–54.7° 恒为 0.3，45° 与 30° 同分。

### Fixed · 旋转台批量门槛

角度来源为 `catalog`（型号未写角度、按样本表标准值预填，如 MSQ 一律 180°）的旋转台不再允许批量采纳。实测角度方差样本上，**42/56 条角度错的建议原本能通过门槛**，点一下「采纳全部高置信」就会静默写错角度，连带把干涉行程与联动时间线带错。现在 rotary 只认 `model-code`（型号码里写了角度，如 `CRB1BW50-90S`）；单条采纳不受限。

### Changed · 识别精度（有真实基线）

新增 `desktop/scripts/kinematics-baseline.mjs`（21 套装配 / 93 条真值，真值来自生成器的 `movingAxes`，非人工编标），并支持 `--stored-axis` 按**实际写进标注的轴**打分——旧的按真值向量打分会把存储轴差的建议算成正确。

| 场景 | 改前 | 改后 |
|---|---|---|
| 有型号码（R2/R3）≥0.6 | 25/31（80.6%） | **31/31（100%）** |
| 通用件名（R1）≥0.6 | 0/31 → 11/31 | **17/31（54.8%）** |
| ≥0.6 precision | 100% | **100%**（两口径分歧 18 条 → 0） |

未解决且已记录：通用件名的**旋转角度推不出来**——角度方差样本（90/120/180/270 各 14 条）上机构级 recall 100%，但角度级只有 25%，常数先验 90/120/180/270 全是 25%。R4（角度写在型号后缀）能到 100%，但那说明的是「有角度就能读对」，不代表现实拿得到。

### Added · B-Rep 运动副识别可行性（spike，未进产品）

`docs/desktop/kinematics-brep-spike.md`：C++ 直连系统 OCCT 7.6 的原型，同轴圆柱对 → 转动/移动副、共面贴合 → 移动副。合成件 3/3 命中（轴误差 0°），仓库 STEP 夹具 3/5（圆柱被三角化成 16 棱柱时解析圆柱面为 0）；106 件 4.8 秒、O(n²)。结论：MVP 13~17 人日，落地应做进现有 Python+OCP sidecar。

## [0.6.2] - 2026-11-02

### Fixed · 3D 联动真正生效（`SMOKE_LINKAGE_POSE_SKIP` → `OK`）

CI 里的联动冒烟长期打印 `SMOKE_LINKAGE_POSE_SKIP reason=empty_scene`——它一直在 SKIP 里假装通过。三处根因：

- `buildMachineBody()` 全仓**零调用点**，且实现把 mm 乘 `annotationScale`、挂在 scene 根而非 `machine.root` 下，即使被调用也摆不到零件上；
- `buildThreeMachine()` 建的零件 mesh 矩阵被冻结（`matrixAutoUpdate=false`），联动帧没有 id→mesh 索引可写，`debugPositions()` 恒为 `{}`；
- `abortLinkagePlayback()` 只停循环不复位位姿，关闭抽屉/切卡片后零件悬在半空插值态。

现在 `buildMachineBody()` 把零件 id 索引到**整机真实网格**（只有「几何里有、场景里没有」才补 mm 占位盒），幂等键为 `machine.root.uuid + 零件集合`，重复调用返回 0；位姿写 mesh 局部坐标（mm、Z 向上），缩放与 Z→Y 由 `machine.root` 统一负责；`abort` 时**先 abort 再 reset**，排队中的 tick 被 `aborted` 吞掉。冒烟从 SKIP 改为**硬失败**，并新增复位断言。

本地实测（xvfb + SwiftShader）：

```
SMOKE_LINKAGE_POSE_OK id=frame-top parts=61 dx=100.0000 resetDx=0.000000
```

### Changed · 安装包继续瘦身

解开已发布的 v0.6.1（196 文件 / 595 MiB 解包体积）逐项统计：`app.asar` 里 `.map` 37.89 MB（3337 个）、`.ts` 11.21 MB、`occt-import-js.wasm` 同一份存了 3 处各 7.6 MB、serialport 增量构建中间件 2.17 MB；`resources/qt` 的 `dxcompiler.dll`+`dxil.dll` 15.77 MB **没有任何 DLL 静态导入**（`Qt6Gui.dll` 24 条导入只有 d3d11/d3d12/dxgi，qt-client 无 Quick/RHI）。

- `build.files` 增加 12 条排除（map / ts / tsbuildinfo / test 目录 / iobj / ipdb / tlog / exp / lib / 重复 wasm）；
- `ci.yml` 的 Qt 打包段新增两条守卫：符号与导入库清理（**残留即 throw**）、dx 编译器**条件剔除**（先 `dumpbin` 扫静态导入，真有导入就 `QTC_DX_KEPT` 原样保留）。

按 `7z -mx=5` 实测压缩率折算预计 **168.85 MB → 约 155.9 MB（−7.7%）**；真实数字以 `windows.yml` 出包为准。

顺带否掉文档里「剔除 52 个语言包可再省 30 MB」的说法：`electronLanguages` 自 `b60840c` 起就生效，包内只有 `zh-CN`/`en-US` 两个 `.pak` 共 1.19 MB；Qt 目录 `.pdb/.ilk/.exp` 实测 0 个。

## [0.6.1] - 2026-11-02

### Fixed · 安装包体积（238.7 MB → 预计 ~167 MB）

拆开已发布的 `AutomationCAD-Setup-0.6.0.exe` 核对包内实际内容，发现 `resources/qt` 里混进了 CI 的副产物：

- `automationcad-qt-windows-x64-occt.zip`（**61 MB**）—— `ci.yml` 上传 artifact 用的那个 zip，解压后原件仍留在目录里；
- `vc_redist.x64.exe`（**18 MB**）—— `windeployqt` 放的运行库安装器，而 CRT DLL 已经直接带进包，客户机不需要再装；
- `version.out.txt` / `clip.log` 等启动自检日志。

`vendor-qt.mjs` 改为白名单搬运（`automationcad-qt.exe` + `*.dll`，插件子目录保留），跳过项逐个打印
`VENDOR_QT_SKIP <名字> <体积>`；新增用例钉住「zip / vc_redist / 日志不进包」。

## [0.6.0] - 2026-11-02

### Added · 双端整合：一个安装包内含 Electron 工作台与 Qt 原生 OCCT 视口

- Electron 主程序随包携带 Qt 原生工作台（`resources/qt/`，26 个 OCCT 库 + STEP/STL + tbb/freetype/zlib/libpng16/FreeImage + VC++ CRT 三件），DLL 整目录隔离，避免与 Electron 自带 `vcruntime140/msvcp140` 互相污染。
- 菜单「工具 → 打开 Qt 工作台（OCCT 视口）」与顶栏「Qt 工作台」按钮双入口；启动失败时给出可操作提示（`0xC0000135` → 明确提示缺运行库/DLL），退出应用时收尾子进程。
- 整机管线打成单文件（`resources/pipeline/machine-design-cli.cjs`，esbuild），Electron 与 Qt 共用同一份产物，不再依赖源码目录。
- Qt 侧新增运行时解析：`AUTOMATIONCAD_NODE` → 同目录 `AutomationCAD.exe`（注入 `ELECTRON_RUN_AS_NODE=1`）→ PATH 上的 `node`；客户机不再需要预装 Node。管线定位同理（`AUTOMATIONCAD_PIPELINE` → `../pipeline` → 开发态源码兜底）。
- `windows-build` 改为出**一个**同时含两端的包：自动取本 commit 已通过验证的 `automationcad-qt-windows-x64-occt` 产物，产物自证 `DUAL_PACKAGE_OK qt_files=N setup_bytes=M pipeline=1`，并额外产出便携 zip。

### Fixed · 版本号单一来源

- `desktop/package.json` / `qt-client/CMakeLists.txt` / `ci.yml` 自检 / `README` 四处版本统一为 0.6.0，新增 `test/meta/version-parity.test.mjs` 防止再次漂移（此前 CMake 的 0.5.0 与 package.json 的 0.5.1 已不一致，且被 GUI stdout 为空跳过断言掩盖）。

### Verified · 0.6.0 出包实测（CI run 41371789524）

```
ASSERT_1_QT_OK files=80
ASSERT_1B_CLOSURE_OK
QT_VERSION exit=0 out=[FT_QT_VERSION_OK version=0.6.0]   # 已把 conda 从 PATH 摘掉，模拟纯净客户机
ASSERT_3_VERSION_OK version=0.6.0
ASSERT_4_SIZE_OK setup=AutomationCAD-Setup-0.6.0.exe bytes=250253889 mb=238.7
DUAL_PACKAGE_OK qt_files=80 setup_bytes=250253889 pipeline=1
```

打包链路现在会在「依赖闭包不完整」时直接失败：dumpbin 扫 exe 与包内所有 DLL 的导入表，
缺的从 conda 候选目录补拷并迭代到不动点；补不到就 throw。这条门禁是为修掉「conda PATH 兜住缺库，
CI 启动自检假绿」而加的 —— 实测它先后抓出 11 个缺失 DLL 与 OpenMP 运行库 vcomp140。

## [0.5.1] - 2026-11-01

### Fixed · 联动调试（3D 步序播放）

- 播放改为单例控制器：切机型卡片、重绘消息区、关闭抽屉（× 按钮 / Esc / 再点工具栏入口）都会先取消上一轮播放，不再出现「面板已经关了、3D 里的机器还在动」而按钮整段 disabled、用户无从停止的情况。
- 相邻帧之间按 `min(300ms, 帧间隔)` 做线性插值（`offsets` 与 `rotZDeg` 同步），末帧精确落在目标位姿；短步长不再瞬移。
- 播放回调抛错不再把单例卡死（停止播放并释放单例，可立即重新开播），错误经 `onError` 上报，不吞。

### Fixed · 布尔复核（B-Rep 复核链路）

- Sidecar 的错误信息统一脱敏：token 原文、base64/base64url 变体、≥6 字符前缀、`Authorization` 头名与长随机串都会被抹掉。此前 `payload.message` 没过脱敏，sidecar 回显请求头时 token 会原样进入 CI 日志、`case.json` 与 Qt 弹窗。
- 401/403 文案点名 `FT_BUILD_TOKEN` 并给出「核对 sidecar `--token`」的可操作提示；非 JSON 响应报出「含 HTTP 状态 + 脱敏摘要」的可读错误，不再是裸 `SyntaxError`；JSON 合法但不是对象时文案改为「响应不是预期的 JSON 对象」。
- 中途失败不再丢弃已完成的对：`available:false` 也按已完成结果计数，CLI 以 `BOOLEAN_RECHECK_PARTIAL` 打印已完成明细后再以退出码 1 结束（退出码语义不变）。

### Fixed · Windows Qt 打包（CI）

- `windeployqt` 不再剔除 VC++ 运行时，并在打包后校验 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` 真的落地，缺一个直接失败。
- 第三方运行库 `tbb12` / `tbbmalloc` / `freetype` / `zlib` / `libpng16` 真实 `Copy-Item` 进产物目录并回验（原来只 `Write-Host` 打印，纯净 Windows 机启动会 `0xc0000135`）；`freetype` / `libpng16` / `zlib` 缺失直接失败。
- OCCT 8.0 的 STEP 库名改为兼容 `TKXDESTEP` / `TKDESTEP` / `TKDE` 与 7.x 的 `TKSTEP*`，且一个都没命中就失败（原来按 7.7 旧名匹配 + `Test-Path` 静默跳过，打出的包可能没有 STEP 读写库）。
- 核心 OCCT 白名单缺任一库即失败；补上 `qt-client` 显式链接的 `TKSTL` / `TKDESTL`。

### Changed · 排布求解器

- 阻尼求解器接线尝试经审查后回滚，未合入：该版采纳判据把「未声明重叠」按 1:1 折成间距缺口，收益全部来自拿重叠换间距（改回硬约束后六工位 5 个阈值输出逐位退回原位），活锁只是换了个零件。阈值口径与重启门槛已写入 `docs/desktop/BACKLOG.md`。

## [0.5.0] - 2026-10-27

### Added · 缓存机台与 Qt 原生客户端（2026-10-29）

- `build_machine_model` 增加 `brief` 参数：一句中文需求（"立体缓存机台：3 层缓存、每层 4 个储位，线体长 3000mm、带宽 1200mm、层间距 400mm"）直接出整机。`detectBufferLayers()` 用负向后顾读层数，避免"12 层"被读成 2 层。
- 立体缓存机型：`layers ≥ 2` 时按层生成托条/托板/传动辊/挡停/到位光电，外加一套升降机构，不再把缓存机台画成单层输送线。
- 工程自动入库：`build_machine_model` 成功后写 `userData/projects/<id>/`（`project.json` + `model.step` + `model.stl` + 逐件 `parts/NN-*.stl`），CAD 顶栏下拉可直接重开。
- Qt 原生客户端接上 OCCT AIS 视口（MSVC 2022 + Qt 6.8.3 + OCCT 7.9.3），README 补了 Windows 安装/构建/运行全过程，含 `occt --no-deps` 与运行时 DLL 两个坑。

### Fixed · 缓存机台整机

- 装配实体上限 50 → 200，单次布尔仍按 50 分块（`MAX_ASSEMBLY_CHUNK`），3 层 56 件不再被拦。
- 内核建模超时 30s → 180s，渲染桥对 `buildMachineModel` 单独给 240s 预算（原来 10s 直接判 `RENDERER_TIMEOUT`）。
- 参数脏值（`11-128` 这类）只保留有限数字；存工程时带上场景可信质量；内核冷启动健康检查 3s → 90s；STL 导出用 mkstemp 避免 Windows 返回 0 字节。

### Fixed · Qt 客户端

- 加载几何崩溃 `0xC0000005`：`loadFromUrl` 的 lambda 读成员 `m_pending` 而不是连接时的 reply，两次请求交错时拿到未结束的新 reply，旧 reply 成了野指针。改为捕获 reply + 同 URL 去重、换 URL 排队（顺带解决 `abort()` 同步发信号导致的挂死）。
- 视口纯黑：Windows 上 `Aspect_NeutralWindow` 建不出 GL 上下文，改用 `WNT_Window`；Qt 侧让出绘制权（`WA_PaintOnScreen` + `paintEngine()` 返回 `nullptr`），否则 backing store 会盖掉 GL 画面。
- 自检/CI 挂死：offscreen 平台没有 HWND，改走 STL 视口；`watch.mjs` / `sse.mjs` 在 Windows 上不再强制 offscreen。


### Added · CI 与文档守卫

- 新增 `.github/workflows/ci.yml`（push main + pull_request）：`npm ci` → `tsc --noEmit` → `npm test` → `packs:validate` → `eval:agent` → `agent:report`。此前只有一个手动触发的 windows-build，PR 合并前没有自动验证。
- 新增 `test/agent/tool-count-doc.test.mjs`：工具注册表必须与 READ_ONLY/WRITE 分类一一对应，且 README / NL-AGENT / MODULE.md / router 注释里的工具数量、README 工具清单必须一致。
- 新增 `test/agent/kb-freshness.test.mjs`：现场重建知识索引并与提交版逐块比对，改文档忘记 `npm run kb:build` 会直接失败。

### Fixed · 离线规则路由

- `build_canvas_assembly` / `save_scene_as_project` 之前既没有离线规则也没有评估用例，`npm run eval:agent` 一直是红的。补规则（必须写在意图门与 `build_machine_model` 之前）+ generate 意图词 + 2 条用例，评估集 109 → 111 条，`accuracy/tools/refused` 全 1.00。

### Fixed · 机型四张截图其实是同一张首页

- 症状：15/16/17/18 字节完全相同，而 DOM 断言全过。真因是流程从首页开始、始终没离开首页（在首页遮罩下操作）。
- 修法：流程开头先点 `.home-link` 离开首页；抓图改走 `ffmpeg -f x11grab` 抓 X 服务器像素（`capture-machine-screenshots.mjs` 提供 `/shot` 旁路，主进程传窗口矩形与 `XAUTHORITY`）；保留 sha256 去重守卫。
- 结果：四张图各不相同（344,689 / 377,971 / 135,247 / 125,528 字节，色数 6,893 / 12,036 / 2,871 / 3,032）。

### Fixed · 工程视图只保留一套零件列表

- CAD 覆盖层打开时隐藏经典结构树（`body.cad-overlay-open`），关闭后恢复，避免两处搜索来回切。

### Fixed · 文档数字与真实注册表对齐

- 工具数 22/21 → **25（只读 12 + 写 13）**；README 工具集补上漏掉的 3 个工具；kb chunks 354 → 348。


### Added · 整机设计五步向导（`desktop/src/design/`）

需求解析 → 3 套候选方案对比 → 工位与元件 → 毫米级布局 → 选型/干涉校核并保存工程；顶栏「整机设计」与文件菜单「新建设计」入口，草稿可续（`userData/design-draft.json`）。smoke：`SMOKE_DESIGN_ENTRY_OK` / `_WIZARD_OK` / `_CANDIDATES_OK` / `_LAYOUT_OK` / `_SAVE_OK`。

### Fixed · 降级渲染路径的零件计数

`CadViewer.getSceneParts()` 在无 three 网格（软件渲染/WebGL 降级）时回退 `modelParts`，修「保存工程后 `__AgentBridge.getScene().parts` 为 0」——Agent 的 `get_bom` / `get_project_context` 不再把已打开工程当空；smoke 不再打 `SMOKE_DESIGN_SCENE_BRIDGE_WARN`。

### Fixed · 评估集覆盖与知识索引

- `docs/desktop/eval/cases.json` 补 `build_machine_model` 用例（bm01/bm02），评估集 102 → 109 条，`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- `MODULES.md` 迭代明细压成能力目录后重建 `kb.json`（390185 → 383228 B，恢复 5% 余量），修 `kb.json 与源文件标题 hash 同步` 用例。

## [0.4.9] - 2026-10-25

### Added · 电气出图引擎（模型 → ERC → 拓扑布局 → 渲染）

不再为某台机器手写绘图函数，也不再"画完再肉眼检查"：

- `elec/circuit.ts`：电路模型（元件 + 引脚 + 网络）与 **ERC** 规则——引脚悬空/多网、相间短接、电机无热继、热继常闭不在线圈回路、线圈无驱动/无停止、24V 无熔断、传感器三线缺相、PLC 的 L+/M 未供电。线圈驱动用**网络回溯**判定（从 +24V 走到线圈 A1，路径上是否真有常开/常闭），不按位号猜。
- `elec/machine-circuit.ts`：机型描述 → 电路，机型无关（电机 + 传感 + 起停 + PLC IO）；换机器只换参数。
- `elec/layout.ts`：**拓扑驱动的梯形布局**——从 +24V 沿网络走，同一网络多条支路通向同一后继网络就画成并联（上下两行），其余串联；行宽超限自动换行；最后两两重叠检测 + 图框越界检测。
- `elec/sheet.ts`：渲染 A3 单页（图框、三相主回路、控制梯形、PLC/传感器/指示灯接线、元件表、标题栏）；**ERC 有 error 或布局有重叠时，图上直接打出问题清单，`deliverable=false`**，不再输出一张"看起来完整"的图。
- CAD 视图点「电气」→ 引擎出图 → `ElecDomain.setSchematic()` 注入；不可交付时同时弹提示。
- 删除了上一版只服务输送机的 `conveyorControlSVG`/`applyMachine` 分支，shell 只负责显示。
- 测试 +7（`elec/engine.test.mjs`：三相不短接、ERC 能抓漏驱动/漏热继/传感器缺电、布局零重叠、元件变多自动换行、deliverable 判定、转义）。

### Fixed · 电气图按 EL-001 的绘制函数参数化（此前自绘方框图不合理）

第一版电气图是我自己拼的 SVG（方框代符号、导线直连），审查后确认不合规，改为**复用 EL-001 的绘制代码**、只把数据参数化：

- `MACHINE` 参数对象：QF1/KM1/FR1 型号、电机功率、工程名、图号、页码、元件表行；`ElecDomain.applyMachine()` 换数据后重绘同一套符号。
- 主回路按 EL-001 原样：三极断路器带机械联动虚线 + 端子号 1/2·3/4·5/6，接触器主触头、热继双金属符号、电机圆内星点（不再用横跨三相的母线，那是三相短接）。
- 控制回路改成正确的起保停：`+24V → FU1 → SB1(NC) → SB3(NC) → [SB2(NO) ∥ KM1 辅助 13/14] → FR1 95/96 → KM1 线圈 → 0V`；自锁改用 KM1 自身辅助触点（原来的 KA1 只有触点没有线圈，逻辑不成立），FR1 的 95/96 已串入线圈回路（原来过载切不断）。
- 补齐此前缺的：FU1 熔断器符号、PLC 的 L+ 与 M 供电、光电三线制（棕 +24V / 蓝 0V / 黑 DI）、HL1 灯符号与 Q0.0 接线、PLC 型号改为 CPU 1214C。
- 热继选型加 0.1–0.16 A 等小电流档，整定值夹到所选档范围内（原来 0.04 kW 会选 0.63–1 A 档却标 0.1 A 整定，自相矛盾）。
- 元件明细表行数自适应压缩，不再把最后一行裁掉（FU1 曾因此在表里消失）。
- 测试：`elec/protection.test.mjs` 8 条（含整定值落在档位区间、取消 KA1、保留 FU1）。

### Added · 电气原理图由工程 BOM 生成（不再固定示例柜）

- 新增 `src/elec/schematic.ts`：按驱动功率与传感器清单生成 A3 单页原理图——主回路（L1/L2/L3 → QF1 → KM1 → FR1 → M1 + PE）、控制回路（24V/0V、急停/启动/停止、KA1 自锁、KM1 线圈、传感输入）、IO 点位表、元件表、标题栏；断路器/接触器/热继按电流档位选型，估算项在元件表里打 `*`。
- 从 CAD 视图点「电气」时先出图再切域：驱动用 `estimateConveyorDrive`（阻力/功率/扭矩同一套公式），转速按 `n = 60v/(πD)`，传感器从零件清单里的光电支架推。
- 电气域 `ElecDomain.setSchematic()` 替换 `#elSheet` 并把页浏览器、页属性（图号 EL-CV-001 / 来源=工程名）同步过来；示例的 12 页目录不再冒充。
- 修 SVG 可见性：图框/器件框原先误用 `.if`（实心填充），整张纸被刷黑；改为描边。
- 测试 +6（选型档位、图纸含位号不含示例、IO 地址唯一、元件表完整性、无急停机型、注入转义）。

### Fixed · 选工程后应直接进 CAD 视图，且 CAD 视图能回到电气侧

- 选工程成功后强制把 CAD 覆盖层推到前台（`AutomationCadProjects.show()`），不再停在外壳的演示画布。
- 外壳的演示 3D（示例滑台气缸）被工程卡片替换：工程名 / 零件数 / 总质量 / 包络 / 保存时间 + 「在 CAD 视图中打开」；左侧结构树换成该工程的 29 件零件清单，避免"选了输送机还是气缸"。
- 覆盖层顶栏新增「机械 / 电气」域切换：原先是全屏覆盖层，电气的入口被挡死。点「电气」→ 关闭覆盖层 → `ElecDomain.setDomain('elec')` → 派发 `automation-cad-domain` 事件把当前工程带过去（外壳状态栏显示「已切到电气域 · 上下文：…」）。
- 已知未打通：电气侧原理图仍是示例柜（滑台气缸控制柜），没有按输送机 BOM/IO 重新生成——下一步要做 BOM→IO→原理图的联动，而不是只切工作区。

### Added · 工程库：顶栏「文件」下拉列出已保存整机，生成即可重开

- 主进程新增 `electron/projects.ts`：一个工程 = `userData/projects/<id>/`（`project.json` + `model.step` + `model.stl` + `parts/NN-*.stl`），同名覆盖不堆副本，名字里的路径字符会被清理，损坏的 `project.json` 不会冒充工程。
- IPC 与 preload 暴露 `projects.list/save/open/remove`（4 个未签名接口不进智能体工具面）。
- **`build_machine_model` 生成后自动存成工程**：整机出现在外壳顶栏文件名右侧的下拉里（`已保存工程 · N`，带零件数/质量/包络/时间），点一下就用逐件 STL 重新装配回视口，零件树与干涉检查照旧可用。
- 外壳 `app.js` 的 `#fileBtn` 原本只弹一句 `toast('文件：新建 / 打开 / 另存为 / 导出')`，现在接成真实菜单；CAD 覆盖层顶栏也加了同一个下拉。
- 测试 +8（工程库：保存/覆盖/清理残留/重新打开/名字逃逸/损坏文件/倒序/删除），全量 1930/1926/0/4。

### Added · 通用整机建模工具 `build_machine_model` + `MODEL_BUILDERS` 注册表

- **工具与机型解耦**：智能体只有一个 `build_machine_model`，机型由 `machine/model-builders.ts` 的注册表分派；新增链板线/滚筒线/转盘机只加一条映射，不新增工具。
- **内核逐件导出**：`/build` 新增 `perPart`，装配体按件导出 STL 并回传每件体积、包围盒（体积/质量来自内核，不估算）。2.4 m 输送线实测 29 件、STEP 917 KB、STL 747 KB。
- **零件树**：逐件 STL 经 `parseStandardCadBuffers` 合并成一个导入结果，视口里是 29 个独立零件（可选中、可做干涉检查、可标运动学），而不是一个合并网格。
- 参数校验：未知键回传、越界夹紧并写 `warnings`、非数字直接拒绝；没有参数化构建器的工艺显式返回 `NO_PARAMETRIC_BUILDER` 并指路 `apply_machine_design`，不伪造模型。
- `describeScene()` 增加 `batches`（实例化批次）与 `hiddenParts`：零件被合并进 InstancedMesh 时原始 mesh 会隐藏，避免再次误判成"模型不见了"。
- **干涉检查在真实零件上跑通**，并据此修掉四处布局碰撞（都有回归测试）：横撑插端板 153600 mm³、横撑穿回程皮带 64000 mm³、滚筒埋端板 47985 mm³、电机箱压纵梁 128000 mm³；剩 30 条是"横撑进纵梁""滑座跨纵梁"这类结构连接处的包围盒假阳性，需要实体级检测才能进一步区分。
- 实测（2.4 m×400 mm）：29 件 / 5 个实体 / 包络 2450×670×930 / 85.41 kg / BOM 15 行。

### Fixed · 3D 视口「模型看不见 / 只剩线框」

- **视锥平面提取错误**：`viewer.ts` 的 Gribb–Hartmann 提取把近、左平面都直接写成 `row3`，远平面写成 `-row2`，没有做行加减，得到一个畸形的视锥；结果整机被判为「视锥外」，被 `applyRenderOps` 设成 `visible=false`，屏幕上只剩包围盒的青色边线，看起来就是"线框模型"。改为标准公式（left=row3+row0 … far=row3−row2），并抽成纯函数 `frustumPlanesFromClipElements` + 6 条单测（相机背后、near/far 之外、横向偏出、大球相交、平面归一化与互异）。
- 修复后同一台 2 m 皮带输送机：覆盖率 0.729、LOD0、14,904 三角面全部进入渲染计划，实体正常着色显示。
- **新增渲染诊断** `window.AutomationCadViewer.describeScene()`：返回线框开关、材质（color/opacity/金属度/法向）、光照、相机、以及**最近一帧渲染计划**（哪些零件被剔除、覆盖率、LOD、包围球），以后这类"看不见"的问题不用再靠截图猜。同时暴露 `toggleWireframe()`。

## [0.4.8] - 2026-10-25

### Added · 输送机（工艺 + 真实几何）

- **工艺与形态**：`MachineProcess` 新增 `conveyor`；需求解析认「输送机/输送线/皮带线/传送带」，并抽取总长/带宽/线速/工件重量（支持 2m、250mm/s 等单位）；新增形态 `belt-line`（单线体、1 工位）与工艺模板（驱动滚筒按旋转轴 + 进出料光电×2）。
- **节拍与功率按输送线算**：产能 = 线速 ÷ 工件间距（0.2 m/s、间距 300 mm → 40 件/分），驱动功率 = (摩擦 + 加速) × 线速 ÷ 效率，按 2 倍余量选标准档（5 kg 工件、0.2 m/s → 40 W，扭矩 1 N·m）；公式写进 assumptions，目标节拍高于线速时给出提速建议。
- **BOM 结构件**：把通用模型的「旋转轴」占位替换为输送线体、减速电机、张紧滑座、可调地脚；左右件合并成一行。
- **真实几何走内核**：新增 `conveyor-assembly.ts` 生成 28 个零件（纵梁/横撑/支腿/地脚/端板/滚筒/皮带/挡边/减速电机/张紧/光电）的参数化装配，交给 build123d 布尔求并，导出 STEP/STL 并载入视口。2 m × 300 mm 实测：28 件 → 5 实体、14,904 面、STEP 882 KB、整机 71.1 kg。

### Fixed · 参数化内核

- **横轴圆柱**：`cylinder` 操作支持 `axis: x|y|z`（滚筒、螺杆这类横轴零件原来只能竖着建）。
- **回转体起手**：`cylinder` 可作为零件的第一个操作（原来必须先有实体，销轴/滚筒无法单独建）。
- **解释器选择**：打包版只认 PATH 上的 python，而 build123d 常装在 venv 里 → 内核报 `No module named 'build123d'`。现在会扫描 PATH 与常见 venv，并且**实际 import 一次**验证（有个 venv 装了 build123d 但 Pillow 坏了，只看目录会选错）。

## [0.4.7] - 2026-10-25

### Added · 装配 / 图纸

- **标准件可视化装配**：顶部「装配」入口，从 617 件库里拖标准件进 3D，松手贴合命中面并沿法向对齐；代理体尺寸由 `specs` 解析（导轨/丝杠/气缸/减速机/型材…），解析不到的字段标「估」并染橙色。`window.AutomationCadAssembly` 暴露 state/placeAt/remove/clear。
- **DXF / DWG 图纸**：顶部「图纸」入口，DXF 直读（LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE/ELLIPSE/SPLINE/INSERT 递归展开），DWG 经 LibreDWG WASM 转 DXF 后同样渲染成 Z=0 线框底图；相机 near/far 按图纸尺度放宽（默认 far=100m，公里级图纸会被裁掉）。打开对话框、拖放、agent `importPath` 三条入口都已路由。
- **DWG 转换器随包分发**：`resources/dwg/libredwg-web`（GPL-3.0），见 `THIRD-PARTY-NOTICES.md`；没有转换器时给出 ODA / dwg2dxf / 另存 DXF 三条可执行路径。

### Changed · 智能体

- **单轮工具调用上限可配置**：原先硬编码 12 次，设计类任务（查库 → 核算 → BOM → 成本 → 导出）在关键步骤前就被 `TOO_MANY_TOOL_CALLS` 掐断，模型只能交半成品。现在 `agent-llm.json` 支持 `maxToolCalls`（1~200，默认 24），实测 30 次时一轮跑满 15 次调用无拒绝，只读工具去重仍生效。

### Fixed · PLC

- **只读点位可写**：`manager.write` 原先不校验点位，写输入区（discrete/input）会被仿真器接受、被 Modbus 从站忽略，调用方却以为写成功。现在返回 `READ_ONLY_POINT` / `POINT_NOT_FOUND`；`force` 仍允许强制输入区（现场调试），但点位必须存在。
- 新增 3 条 manager 测试（只读区、不存在点位、强制输入区）。

## [0.4.6] - 2026-10-25

### Fixed · 3D 视口交互（真机连续反馈）

- **点击选中失效**：0.4.3 引入的 window 级 `pointerup` 兜底在捕获阶段先清掉了按下状态，画布自身的抬起处理拿不到，点击判定直接 return（悬停高亮走 `pointermove`，所以只有点击坏）。改为只清理画布外的残留状态。
- **点击后滚轮失效 / 不按键也跟动**：OrbitControls 把"正在拖动"记在私有 state，`onMouseWheel` 与 `onPointerDown` 遇到 `state !== NONE` 都直接 return。一旦漏掉一次 `pointerup`，滚轮缩放与新的按下全部失效、移动鼠标却继续旋转。现在在每轮抬起事件派发结束后检查：若仍处于拖动中即判定漏事件，结束拖动并重建控制器（相机与 target 保持不变）；窗口失焦、指针在画布外移动时同样自愈。
- **3D 画布不再被外部框选抢指针**：原型的框选绑定会在父元素 `#stageAssembly` 上 `setPointerCapture`，与画布上的 OrbitControls 争抢同一个指针；现在 3D 画布及其内部元素一律不接管。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1849 总计 / 1845 通过 / 0 失败 / 4 跳过**。
- 点击选中在 dev 实例经 CDP 实测：点击不同位置分别选中 `CYL-032-050` / `CAR-32` / `BASE-01`。

## [0.4.3] - 2026-10-25

### Fixed · 拖动交互"不跟手"（真机反馈）

- **拖动状态永久卡死**：`endDrag()` 把 `dragging = false` 放在 200 ms 定时器里，pointerup 一旦没落到当前 canvas（拖动中重建渲染器就会换掉 canvas），状态永不落地 —— 表现为**按住拖动没反应、松手后画面才跟着走**，且像素比永久停在 0.8 拖动档（实测 `drawingBuffer/CSS = 0.799` 长期不变）。现在 `endDrag()` 同步落下状态，定时器只负责质量回升。
- **指针抬起兜底**：新增 window 级 `pointerup` / `pointercancel` / `blur` 监听与 `setPointerCapture`，画布外抬起、系统取消、窗口失焦都能正常结束拖动；`beginDrag()` 遇到上一次未收敛的状态先自愈。
- **拖动中不再重建渲染器**：`rebuildRenderer()` 在拖动期间直接返回，避免换 canvas 丢掉 OrbitControls 的指针状态。
- **渲染队列看门狗**：页面被遮挡/最小化时 rAF 不触发，`renderQueued` 会永久为 true，之后所有渲染请求被丢弃（画面像卡住）。超过 500 ms 视为失效帧，允许后续请求重新排队。

### Fixed · 渲染指标可信度

- 拖动帧统计只在**窗口可见且间隔 ≤250 ms** 时计入，遮挡/最小化/系统挂起造成的数秒空档单独记 `dragDroppedFrames`；`<5` 帧时明确输出「样本不足，不下帧率结论」。此前会把正常画面报成「平均 7813.9 ms/帧，拖动会明显不跟手」。

### Fixed · 顶部入口抽屉

- 工厂 / 联调 / 数据包 / 成本估算 / 模块设置等入口原先**可同时打开并全部叠在同一位置**（实测 4 个同时可见，且点同一入口不会关闭）。现在抽屉互斥打开，同一入口再点一次收起。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1847 总计 / 1843 通过 / 0 失败 / 4 跳过**（`0600` 权限断言，Windows 无 POSIX 位）。
- 抽屉行为在 dev 实例经 CDP 实测：连续切换 8 次，每次都只保留 1 个抽屉。
- `npm run smoke:win`：`SMOKE_OK`，退出码 0。

## [0.4.2] - 2026-10-25

### Fixed · 联机调试与渲染可观测性

- **CDP 内网可达**：Electron 会忽略 `--remote-debugging-address=0.0.0.0`，实际只绑回环。改为普通启动常驻 `127.0.0.1:9229`，白名单开关命中来源后再由 `cdp-forwarder` 转发到 `0.0.0.0:9222`；未命中来源返回拒绝并写审计 `cdp_access_check`。支持运行中热启停，不必重启进程。
- **token 生命周期**：启动复用已有 token（原实现每次启动重写，重启一次就得重新取 token）；文件损坏时重建；面板提供显式「重新生成」，旧 token 立即失效。
- **渲染指标**：新增 `get_render_stats` 只读工具（工具数 21 → 22），暴露渲染器字符串、是否软件渲染、像素比、质量档、零件/三角面数与拖动帧时间（均值/峰值/时间戳），同一份数据进 `/health.render`；检测到 SwiftShader 等软件渲染时自动降到 `flow` 档。

### Added · 跨平台验证

- `npm run smoke:win` / `npm run diagnose:win`：Windows 本地 headless 入口（关闭 GPU 走 SwiftShader），使「无 WebGL 降级面板」这条断言在 Windows 开发机上也能被真实覆盖；README 补对应说明。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1842 总计 / 1838 通过 / 0 失败 / 4 跳过**（4 条是 `0600` 文件权限断言，Windows 无 POSIX 位；Linux 上为 1842/1842）；`build:ext` 通过。
- Windows 实跑 `npm run smoke:win`：**85 条 `SMOKE_*_OK` + `SMOKE_OK`**，退出码 0；`SMOKE_RENDER_STATS_OK gl="ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" parts=11 triangles=4832 quality=flow`，拖动平均 42 ms/帧。

## [0.4.1] - 2026-10-25

### Added · 桌面可用性

- **界面缩放**：智能体面板新增 6 档缩放（100%–150%），默认 **115%**（原 UI 偏小）；注入式 `html { zoom }` 实现，不改根目录原型样式；切换即生效并联动 3D 视口 resize；持久化 `userData/appearance.json`。
- **3D 渲染质量**：`flow / standard / high` 三档（像素比上限 1.0 / 1.5 / 2.0）；拖动旋转期间固定降采样到 0.8、松手 200 ms 恢复；启用 `powerPreference: high-performance`；零件数 > 1500 自动降级为 flow。
- **局域网联调（默认关闭）**：开关打开后 Agent JSON-RPC 绑 `0.0.0.0:7420`，来源必须先过 CIDR/单 IP 白名单再看 Bearer token，未命中返回 403 `LAN_NOT_ALLOWED` 并写审计；远程写操作仍弹本机确认框；`/health` 不返回 token。
- **远程调试 CDP（默认关闭）**：开关打开后下次启动监听 `0.0.0.0:9222`，面板显示端口、需重启状态与高风险警告。
- **联调探测脚本** `desktop/scripts/lan-debug-probe.mjs`：依次校验 `/health`、`tools/list` 与只读 `list_components`，成功输出 `LAN_DEBUG_OK`。

### Verification

- `npx tsc --noEmit` 0 错误；`npm test` **1831/1831**；`build:ext` 通过；`SMOKE_OK`（含 `SMOKE_UI_SCALE_OK` / `SMOKE_RENDER_QUALITY_OK` / `SMOKE_LAN_SWITCH_OK` / `SMOKE_LAN_ALLOWLIST_OK`）；`EVAL_AGENT_OK 1.00`。

## [0.4.0] - 2026-10-25

> 已发布：GitHub Release `v0.4.0`，Windows 安装包 `AutomationCAD-Setup-0.4.0.exe`（NSIS，未签名，约 130 MB），由 `windows-build` 在 `windows-latest` 上构建（1810 单测 / 0 失败）。

### Added · 可选模块门控与工程安全（PR #9）

- **模块 registry + 运行时启停**：8 个可选模块（`cost.estimation`、`elec.validation`、`plcgen`、`parametric.import`、`factory.plc-sync`、`agent.resume`、`project.portable`、`system.update`）统一注册，默认全启用；门控只隐藏/禁用对应入口与 Agent 工具，不卸载代码。`ipcMain.on('modules:sync-*')` 同步通道在 `createWindow()` 之前注册。
- **工程档案（project archive）**：`.acproj` v2 打包/预览/导入，导入走临时目录 + 校验 + 原子替换。
- **CAD 导入事务回滚**：导入失败回滚到导入前状态，不留半成品装配体。
- **更新通道**：`update-service` 支持 `latest.yml` + blockmap 的检查/下载/安装路径（未做真实签名与跨版本升级验收）。
- **PLC 校验补强**：数值范围与空序列校验，空序列不再生成空程序。
- 107 个文件、+11693/−442。

### Security

- **Agent IPC 传输安全（PR #6）**：所有 `ipcMain.handle` 走可信 sender 校验（`isTrustedIpcSender`），渲染层 URL 白名单（`isTrustedUiUrl`），MCP/RPC 写操作统一授权（`authorizeAgentToolCall`），API Key 传输策略 `assertSafeApiKeyUrl` 泛内网段放行 HTTP（10/8、172.16/12、192.168/16、169.254、IPv6 ULA/链路本地），仅公网强制 HTTPS。
- 设计包同步限制单包体积（`MAX_DESIGN_PACKAGE_BYTES`），`.acproj` 导入做路径穿越与大小校验。

### Added · 机型设计与元件库（迭代 37–48）

- 整机形态库扩到 **11 种**（工艺 × 布局 × 机型），选型优先级为「工位覆盖 → 产能达标 → 工艺适配 → 布局偏好（仅同分）→ 占地」，候选产能夹紧到自身工位范围，禁止越界形态凭虚高吞吐入选。
- 统一功率/成本模型：按实际选型额定功率 × 同时系数 0.7 / 负载率 0.6 / 效率 0.9 / cosφ 0.9 计算 kW、VA、计算电流、断路器建议与 24V 余量；成本分项与缺价计数进入方案卡。
- 元件库扩到 **9 个内置包 / 617 型号**（新增 `vision-cn`、`drive-cn`、`safety-cn`、`frame-cn`），保留按需懒加载：启动只读 manifest，命中包才读 `parts.json`，`partsSha256` 校验完整性。
- 价格簿扩到真实分销价条目，案例 BOM 覆盖率提升；缺价项照实计入「待询价」，示例价自动排除。

### Fixed

- **Windows CRLF 检出不误判 integrity**：Windows runner 的 `core.autocrlf=true` 会把 `packs/builtin/*/parts.json` 检出为 CRLF，而 `manifest.partsSha256` 按 LF 计算，导致 `PACK_INTEGRITY_FAILED` 使全部内置包加载失败（CI 18 个用例红）。`assertPartsIntegrity` 与 `scripts/pack-stats.mjs` 统一 `CRLF→LF` 后再取 SHA-256，并新增根目录 `.gitattributes` 对文本文件强制 `eol=lf`；新增回归用例覆盖 CRLF 字符串与 Buffer（`ba5787a`）。

## [0.3.0] - 2026-10-23

> 已发布：GitHub Release `v0.3.0`，Windows 安装包 `AutomationCAD-Setup-0.3.0.exe`（NSIS，未签名，129 MB），由 `windows-build` 手动触发在 `windows-latest` 上构建（1248 单测 / 0 失败）。

> 说明：能力条目均附真实提交号；本次发版追加的整机 3D 能力见下方「Added · 整机 3D」。

### Added · 整机 3D（迭代 34–36，PR #4）

- 机型方案生成参数化整机几何：`machine/geometry.ts` 由 `MachineConfig` 生成 mm 级整机（机架、工位、气缸、夹爪、转台、传感器、光栅、输送线）与运动轴元数据，导出 STL / glTF / build123d sidecar 清单，STEP 由内核实体化（`bd5adc1`）。
- 主视图可旋转 three.js 3D：`src/orbit/` 注入扩展提供旋转/缩放/平移、六向标准视图、透视↔正交、剖切、树↔3D 双向选择与属性实时改几何，无 WebGL 时回退原型 SVG，原型 `index.html` / `app.js` / `styles.css` 零改动（`5fb16f9`）。
- STEP 装配体运动件自动识别：按零件名/型号、装配层级与几何推断轴向、行程、置信度与中文理由，只出建议、逐条采纳才写标注（`bcef010`）。
- Agent 只读工具 `suggest_kinematics`（工具数 20 → 21），命令 → 渲染桥 → 标注抽屉，`applied=false` 从不写标注（`310f164`）。
- KB 容量治理：BACKLOG 历史归档不入索引，`kb.json` 约 408 KB → 363 KB，新增「索引留 ≥5% 余量」守卫（`310f164`）。

### Fixed · 合并前复查

- STEP 实体化把水平圆柱按等截面方棒近似时写中文 warning 点名零件并透出 `approximatedIds`；`solids/` 上一次遗留的 `part-N.step` 先入撤销快照再清理（`192983e`）。
- Windows CI 上 4 条平台脆弱断言（文件名时间戳写死 `+08:00`、`/tmp` 路径、sidecar 脚本分隔符正则）改为时区/分隔符无关（`823caf4`）。

### Added

- 电气元件库扩展至 371 型号 / 26 分类，并补充 191 个可核实的真实外形尺寸与导轨 / 模数信息（`e6f354f`、`31530ac`、`acca35a`、`9e9cabd`、`d8e12c5`、`d5713b6`、`337559b`、`7cc1e86`、`cb9c5d3`、`8729688`）。
- 电箱底板真实尺寸画布：毫米坐标、1 mm 吸附、35 mm 导轨、重叠标红、利用率统计、JSON 导出（`df8f1a2`、`b4bf1a1`）。
- 电气合规校验：线号合规、功率统计、导线截面与断路器配合校验，配套 9 卡面板、A3 PDF 报告与 Agent 工具 `run_electrical_check`（`5352832`、`652e031`）。
- STEP 运动学标注：动件 / 轴类型 / 方向 / 行程 / 缩回位 / IO 点位绑定，中文校验、姿态解算、滑块预览与 JSON 导入导出（`8d5835d`、`b0e6df3`）。
- 3D 联调新增故障诊断规则与诊断面板（`e1e02c9`）。
- 成本统计闭环：价格簿与纯函数引擎（`a8c1e5f`）、成本面板与 A4 / CSV 报告（`6d70ae7`）、Agent 工具 `run_cost_report`（`a66b26e`）与 `export_cost_report`（`23cd284`）。
- 自然语言 Agent：离线规则路由、上下文裁剪、NDJSON 审计（`424711c`）、侧栏只读问答与审计面板（`b3b9aee`）、底板放置 `place_component` 与撤销联动（`1c356e9`）、离线多步规划与计划卡片执行（`e70ef77`）、46 条中文评估集（`cb3cc93`）。
- PLC 程序自动生成：预检、IO 变量表、五个基础 ST 块（`b36635b`）、自动序列 / 报警 / 安全 FC 与 11 文件汇总（`ccbd0fc`）、生成 UI / 文件树 / zip 导出 / 最近 10 次历史（`1f50bac`）、内置模拟器执行联调序列与 Agent 工具 `verify_plc_program`（`a6b0534`）。
- 参数化建模：选定 build123d 内核与 sidecar 契约（`5c2a8c3`、`371e6f0`）、主进程生命周期与 IPC（`9eda660`）、特征树 / 参数表单 / 防抖重建 / STEP+STL 导出（`8867853`）、多实体装配与 BOM / 成本联动（`449d060`）。
- CAD 大装配渲染批次层：实例化合批、视锥剔除、LOD 分级与 10 万面基准（`f6962b3`、`71c0e9b`）。
- 原型侧零件插入、约束建议与多步撤销（`7d98af5`）。
- 桌面端 14 张真实 Electron 截图与一键截图脚本（`e409ea8`）。
- 智慧工厂设计同步本地端到端脚本与验证记录（`ce11575`）。

### Changed

- 桌面版本号由 `0.2.0` 升至 `0.3.0`（`desktop/package.json`、`desktop/package-lock.json`；本次发版准备，未提交）。
- 3D 联调由写死零件改为机型配置驱动，并在有运动学标注时优先使用标注（`71b5e18`、`b0e6df3`）。
- Agent 工具注册表由 7 个扩展到 12 个，离线多步计划统一走同一工具注册表（`424711c`、`b3b9aee`、`1c356e9`、`e70ef77`、`a6b0534`）。
- 质量基线由 301 个单测提升到 674 个单测，并补充 PLC 生成、参数化装配、智能体规划等冒烟断言（`b36635b`、`ccbd0fc`、`1f50bac`、`a6b0534`、`8867853`、`449d060`、`e70ef77`）。
- 汇报材料由 18 页扩展到 19 页，补充 PLC 程序生成与参数化建模能力边界（本次发版准备，未提交）。

### Fixed

- 收紧智慧工厂同步字段契约，明确 `deviceId` / `createdAt` / `qty` 的校验口径（`68f5186`）。
- 参数化假内核脚本移出 `test/`，避免被 `node --test` 当作测试执行，并修正 smoke 版本判定（`18c353b`）。

## [0.2.0] - 2026-10-22

- 机械校核 / 导出 / PLC / 联调 / 智慧工厂同步基线版本；NSIS 安装包随 `v0.2.0` 发布（`552fd5a`）。
