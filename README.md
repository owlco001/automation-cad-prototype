# AutomationCAD · 非标自动化整机设计软件（Windows 11 桌面版）

面向非标自动化整机的**机械 + 电气协同设计工作台**：机械域覆盖机构选型 → 标准件调用 → 装配 → 干涉校核 → 受力校核 → 出图 → BOM；电气域覆盖原理图 → IO 规划 → 柜体底板布置 → 合规校验 → 成本统计；桌面版在此基础上叠加 **CAD 轻量化查看与运动学标注、电气元件库、PLC 程序生成、PLC 通电联调、参数化建模、智慧工厂数据同步、智能体（JSON-RPC / MCP / 应用内对话）**，单机离线可用。

- 当前版本：**v0.5.0**（源码 tag；安装包仍停在 v0.4.2）（0.4.2 之后陆续落地：拖动交互与渲染指标修正、输送机工艺与真实几何、装配吸附、PLC 修正、电气出图引擎、整机设计五步向导；逐版变更见 [CHANGELOG.md](./CHANGELOG.md)。已发布安装包仍停在 **v0.4.2**（Windows 开发机本地构建，未走 CI），0.4.3 之后未出包）
- 运行环境：Windows 11 x64；Electron 45 + TypeScript + Vite
- 技术底座：渲染层直接复用仓库根目录的网页原型，桌面能力全部通过**注入扩展**叠加，原型文件（`index.html` / `app.js` / `styles.css` / `electrical.*`）**零改动**
- 质量基线：**1831 个单元测试全绿**，另有覆盖 CAD / 运动学（含自动识别建议） / 机核 / 导出 / PLC / PLC 代码生成（含 UI 与 zip 导出）/ 联调 / 同步 / 电气库 / 电气校验 / 底板布置 / 参数化装配与 BOM / 成本（引擎 + 面板 + 报告 + Agent）/ 智能体上下文、指代、多轮续跑、本地知识检索、上下文预算与成本可见性、执行效率（去重/并行/缓存）/ 机型方案合成与落盘、并行/流水线节拍模型、工艺模板、11 种整机形态库（工艺 × 布局 × 机型，含预览夹紧与四档选型优先级）、追问策略、统一功率/成本模型（额定功率、系数折算、断路器初选、缺价计数）、BOM/PLC 联动、参数化整机几何（多头龙门 / 混合线 / 单元矩阵 / STL/glTF/sidecar）/ 主视口可旋转 3D（降级路径）/ 工厂的 headless smoke

![AutomationCAD 主界面](docs/desktop/screenshots/01-home.png)

*主界面：左侧仍是原型的结构树 / 选型 / 标准件库 / 受力视图，顶栏右侧新增桌面入口——CAD 查看（STEP）、工厂、联调、数据包、电气元件、电气校验、底板布置、PLC 程序、成本、智慧工厂、智能体。桌面能力挂在原型之上，不改动原有布局与交互。*

## 界面一览

以下截图均来自 Electron 实跑（`capturePage` / CDP），不是设计稿。

| 截图 | 说明 |
|------|------|
| `01-home.png` | 主界面 |
| `02-cad-assembly.png` | CAD 查看 · STEP 装配体 |
| `03-interference.png` | 干涉检测 |
| `04-stress.png` | 受力分析 |
| `05-factory.png` | 智慧工厂 · demo 产线实时值 |
| `06-commission.png` | 通电联调 · 6 步全通过 |
| `07-packs.png` | 数据包管理 |
| `08-elec-library.png` | 电气元件库 |
| `09-agent.png` | 智能体面板 |
| `10-sync-settings.png` | 智慧工厂同步设置 |
| `11-plcgen.png` | PLC 程序生成 · 预检 + 11 文件树 |
| `12-parametric.png` | 参数化特征树 · 4 特征 + 参数表单 |
| `13-cost.png` | 成本估算 · 9 卡 + 6 行明细 |
| `14-enclosure.png` | 底板布置 · 3 元件 + 1 处重叠 |
| `15-machine-design-card.png` | 机型方案卡 · 6 工位 / 12 执行机构 / 31.75 件/分钟 / 2.18 kW / 3.7 A / 6A/3P / 成本分项 + 应用按钮 |
| `16-machine-3d.png` | 6 工位 3D 联调 · 12 个执行机构、运行若干 tick |
| `17-machine-bom.png` | BOM 面板 · SV660P / MHZ2-20D / D-M9B 等真实型号 |
| `18-machine-iomap.png` | PLC IO 点位 · 19 行，点位与机构对应 |

复现：`cd desktop && npm run screenshots`（xvfb + 真实 Electron，`capturePage` 抓 1600×1000；参数化面板由 `scripts/fake-parametric-sidecar.mjs` 驱动）。机型全流程截图单独复现：`cd desktop && npm run screenshots:machine`（本地脚本化离线桩，不依赖外部模型；脚本注入 brief → `design_machine` → 应用到工程 → 3D / BOM / IO，3D 使用 SwiftShader 真实 WebGL）。普通 headless 截图中 Chromium 若把 WebGL 列入 blocklist，CAD 3D 区域会显示解析统计降级面板；机型四张图的目标面板均为真实 Electron 渲染。

六工位锁螺丝机的完整解析、节拍、功率、BOM 与 IO 映射见 [MACHINE-DESIGN-DEMO.md](docs/desktop/MACHINE-DESIGN-DEMO.md)。

### CAD 查看：真实 STEP 装配体 + 运动学标注

![CAD 查看：STEP 装配体 18 个零件](docs/desktop/screenshots/02-cad-assembly.png)

*CAD 查看：载入真实 STEP 装配体（18 个零件、5,040 个三角面），左侧零件列表可点选定位，中间 three.js 视口支持旋转 / 缩放 / 平移，底部给出解析统计。*

### 参数化建模：特征树 + 参数表单 + 重建统计

![参数化抽屉：4 个特征、孔位参数与重建统计](docs/desktop/screenshots/12-parametric.png)

*参数化抽屉：装配实体「安装底板」下是 4 个特征（底板 / 安装孔 / 腰形槽 / 四角圆角），选中「安装孔」后参数表单给出孔径、深度与 4 个孔位坐标，底部固定显示 `就绪 · 重建 12 ms · 面 19 · 体积 71.5 cm³`。这张图证明特征树、参数表单、重建统计与 sidecar 状态在真实 Electron 中同屏可用；当前无 WebGL 的 headless 环境只在中间 3D 区显示降级统计，不影响抽屉本身。*

实跑时顶栏「参数化」按钮会在右侧打开与「运动学」二选一的抽屉：装配实体区可增删实体并编辑名称 / partId / X/Y/Z/RZ，特征树支持上移/下移/抑制/改名/删除，参数表单按特征类型渲染；底部提供重建、导出 STEP/STL、导出 BOM、送成本、保存/载入特征树。参数改动默认 300 ms 防抖自动重建。导入的 CAD 网格始终保留为只读参考体；参数化输出作为独立叠加体显示，不会替换或进入原模型的 BOM / 运动学 / 导出。当前不支持任意 STEP/B-rep 特征识别或直接编辑，特征树 JSON 只保存参数、不嵌入原始几何，需保留来源 CAD 文件。

STEP/IGES/BREP 本身不含运动学信息，因此右侧新增**运动学标注**抽屉：网格多选合并为一个动件 → 指定轴类型（直线 / 旋转）、方向、行程、缩回位、绑定 IO 点位 → 中文实时校验（动件不在 STEP、行程非正、缩回超行程、直轴填角度、点位不存在、同点位冲突）→ 行程滑块直接拖动 3D 中的动件预览。标注按文件名存 `localStorage`，可导出 / 导入 JSON；无标注时 3D 联调回退到机型配置驱动，并在面板顶部说明原因。

### 干涉检测：28 处命中按严重度分组

![干涉检测：28 处命中、按严重度分组](docs/desktop/screenshots/03-interference.png)

*干涉检测：AABB 初筛一次跑出 28 处候选，按严重度分组并给出重叠尺寸与体积；点击结果可在 3D 视口定位到两个零件，「忽略」会把该零件对写入白名单。*

### 受力分析：公式与安全系数可见

![受力分析：气缸推力与安全系数](docs/desktop/screenshots/04-stress.png)

*受力分析：气缸推力按 `F = p·πD²/4·η` 计算，同时给出拉力（0.85 系数）、余量与安全系数；悬臂梁挠度 `δ ≤ L/500`、螺栓预紧 `F0 = 0.7σy·As` 同页，超限项直接标红并给出改法建议。*

### 智慧工厂：demo 产线实时值

![智慧工厂：demo 适配器连接后 2 工位 8 点位实时刷新](docs/desktop/screenshots/05-factory.png)

*智慧工厂：内置 demo 适配器连接后自动列出 2 个工位 × 4 个点位（运行 / 节拍 / 良品数 / 报警），每秒刷新；可写点位会弹出确认，OPC UA 与 MQTT 共用同一适配器接口。*

### 通电联调：上电序列 + 3D 联动 + 故障诊断

![通电联调：6 步上电全部通过](docs/desktop/screenshots/06-commission.png)

*通电联调：内置 PLC 仿真器连接成功，点位表就绪，6 步上电（主回路 → 24V → PLC RUN → 气源 → 回原点 → 就绪）全部通过并记录每步耗时，结果可导出 A3 PDF 联调章节。*

3D 联动已改为**机型配置驱动**：`MachineConfig` 描述工位、执行机构（气缸 / 夹爪 / 旋转轴）、行程与传感器点位，demo 配置为 4 工位 / 12 执行机构 / 16 传感器；把自然语言方案应用到工程后，3D 视图用新配置重建，换机型只换配置不改源码。诊断侧 7 条规则 + 兜底，按置信度给出原因与处置建议。

### 数据包：内置包、导入与启停

![数据包：内置包列表与检索](docs/desktop/screenshots/07-packs.png)

*数据包：内置包只读展示，支持 ZIP 导入、启停与型号 / 厂商 / 类别检索；启停即时影响标准件搜索结果，「插入」写入渲染层覆盖层而不修改原型代码。*

*内置 10 个包：`iec-cn` 377 条、`smc-cn` 8 条、`servo-cn` 25 条、`sensor-cn` 32 条、`pneumatic-cn` 44 条、`vision-cn` 32 条、`drive-cn` 33 条、`safety-cn` 33 条（28 实型号 + 5 alias）、`frame-cn` 33 条、`pricebook-cn` 价格簿；元器件合计 612 条可检索型号 / 612 个唯一型号。启动只读 manifest 索引；`listParts` 先按 `manifest.categories` / 包名预过滤，命中包才 `loadPack` 并缓存，`unloadPack` 可释放；跨包同 id 去重且内置优先，`getPartById` 懒建全局索引并解析 `aliasOf`。`npm run smoke` 输出 `SMOKE_PACKS_LAZY_OK packs=10 loaded=2 searchMs=…`、`SMOKE_PACKS_COUNT servo=… sensor=… pneumatic=… vision=… drive=… safety=… frame=…` 与 `SMOKE_PACKS_VALIDATE_OK packs=10 errors=0`；`npm run diagnose` 输出 `packMetrics` 与库统计摘要。每个包的 `manifest.partsSha256` 在加载时校验，不匹配抛 `PACK_INTEGRITY_FAILED`；`npm run packs:validate` / `npm run packs:stats` 分别做全包校验与统计报表（[PACK-STATS.md](docs/desktop/PACK-STATS.md)）。*

### 电气元件库：377 型号 / 26 分类 / 265 个可核实尺寸

![电气元件库：按需加载与放入图纸](docs/desktop/screenshots/08-elec-library.png)

*电气元件库：iec-cn 数据包按需加载，26 个分类共 377 个型号，其中 219 个带原理图符号、265 个录入了可核实的外形尺寸（`dims{w,h,d}`）与导轨 / 模数信息；其中 16 条为同系列同壳架推定并带 `dims.estimated` 标记。卡片标注符号位号，点「放入图纸」即插入原理图，点「放入底板」即进入布置画布。*

### 底板布置画布：真实毫米与重叠标红

![底板布置：3 个元件、1 处重叠标红](docs/desktop/screenshots/14-enclosure.png)

*底板布置：600×800 mm 画布、两条 35 mm DIN 导轨，放入 3 个带真实尺寸的元件；其中两个 1P 断路器故意错开 6 mm 叠放，重叠的一对同时显示红色描边与 `!` 角标，底部状态栏给出「已放置 3 · 利用率 1.5% · 冲突 1 处」。这张图证明画布用真实 `dims` 绘制并实时计算碰撞，不是静态示意。*

### PLC 程序生成：预检 + 文件树

![PLC 生成：预检通过、11 个文件树与 README 预览](docs/desktop/screenshots/11-plcgen.png)

*PLC 程序生成：电气域打开全屏面板，4 工位 / 12 执行机构 / 34 点位的机型预检为 0 错误 0 警告，生成 11 个文件；中间文件树列出路径、行数与字节数，右侧预览 `README.md`，底部统计「11 个文件 · 变量 34 · 步序 2 · 生成 22 ms」。这张图证明预检、生成、文件树/预览与生成历史在真实 Electron 中走通。*

### 硬件成本统计：9 张统计卡 + 明细表

![成本估算：9 张统计卡、6 行明细与缺价告警](docs/desktop/screenshots/13-cost.png)

*成本估算：载入内置/样例价格簿与 7 行 BOM 后算出 6 行可计价明细，顶部 9 张卡展示硬件、辅材、人工、小计、加成、税金、运费、合计与缺价；表格逐行给出物料号、数量、单价、小计与价格来源，缺价 1 项单列。这张图证明成本引擎、面板渲染与缺价口径在真实 Electron 中一致（合计 ¥1,398.64）。*

### 智能体：对话 / 工具 / 模型设置

![智能体面板：对话、工具、模型设置](docs/desktop/screenshots/09-agent.png)

*智能体面板：最上方是「建议」区（0–3 张 next-best-action 卡片，点击填入输入框或走单步计划确认，可本次会话忽略），其下是对话与工具调用区、执行进度/结果卡片、模型设置（OpenAI 兼容 baseUrl / model / apiKey，密钥只回显掩码）、本机服务信息（127.0.0.1:7420、25 个工具、token 文件路径）与可筛选/导出的审计面板。写操作执行前会弹出二次确认；执行中可取消。*

### 智慧工厂同步设置

![智慧工厂同步：baseUrl / 机台编号 / 项目 / API Key 掩码](docs/desktop/screenshots/10-sync-settings.png)

*智慧工厂同步设置：baseUrl、机台编号（device_no）、项目、API Key（保存后只回显掩码，配置文件权限 600）与启用开关；「测试连接 / 立即同步」均手动触发，没有后台自动同步。模块设置中的 `factory.plc-sync` 可单独关闭 PLC 源码与 IO mapping 扩展；普通 BOM/PDF/GLB/DXF 设计包仍可同步，PLC 实时联调连接不受影响。*

## 功能矩阵

### 机械域（原型 5 视图 + 桌面校核）

| 能力 | 内容 | 状态 |
|------|------|------|
| 装配工作台 | 结构树 ↔ 3D 联动、属性即时编辑、框选、DOF 角标 | ✅ 原型 |
| 选型计算 | 8 项工况参数重算、缸径系列对比、推荐型号回写装配 | ✅ 原型 |
| 标准件库 | 品牌 / 品类筛选、7 列排序、规格预览 | ✅ 原型 |
| 干涉校核 | AABB 初筛：重叠量 / 体积 / 定位 / 严重度分级 / 忽略白名单 | ✅ 桌面 |
| 受力校核 | 气缸推力、悬臂梁挠度、螺栓预紧，带公式与安全系数 | ✅ 桌面 |
| 出图与 BOM | A3 PDF 报告、DXF、GLB、OBJ、BOM（CSV / XLSX） | ✅ 桌面 |

### 电气域（原型 3 视图 + 桌面增强）

| 能力 | 内容 | 状态 |
|------|------|------|
| 电气原理图 | A3 横向白纸、图框与标题栏、主回路 / 控制回路、符号拖放与交叉引用 | ✅ 原型 |
| IO 规划 | 点位表、建议 / 未分配 / 冲突编码、机械派生链追溯 | ✅ 原型 |
| 柜体布置（原型） | 柜门与侧视图、导轨吸附、温升 / 载流 / 空间余量重算 | ✅ 原型 |
| 电气元件库 | iec-cn 数据包：377 型号 / 26 分类 / 219 符号 / 265 尺寸（16 条推定），插件式加载 | ✅ 桌面 |
| **底板布置画布** | 毫米坐标 SVG、底板尺寸可设、1mm 吸附、两条 35mm 导轨、重叠标红、利用率统计、JSON 导出与刷新恢复 | ✅ 桌面 |
| **电气合规校验** | 线号（缺号 / 格式 / 同网重复 / 跨网重号 / 相线电位不符 / 跳号）、功率统计（kW / kVA / 分相电流 / 不平衡度 / 主断路器与进线截面建议 / 24V 余量）、导线截面 vs 载流量；A3 PDF 报告 | ✅ 桌面 |
| **参数化建模（P9-5）** | build123d sidecar + 右侧「参数化」抽屉：多实体装配（独立特征树 + X/Y/Z/RZ + partId，旧单件文档自动包装）、特征树增删/排序/抑制/改名、按类型参数表单（box/holes/slot/fillet/cylinder）、300 ms 防抖自动重建、导入 CAD 只读保留 + 参数化输出独立叠加、特征包围盒高亮、STEP/STL 导出；不支持任意 STEP/B-rep 特征自动识别或编辑，特征树 JSON 不嵌入来源几何；BOM 按相同 partId / 未映射名称合并，导出 UTF-8 BOM CSV 并一键送成本（未映射走 `NO_PART_ID`，不猜物料号） | ✅ 生命周期 + IPC + 装配/BOM 联动 |
| **硬件成本统计** | 价格簿（阶梯价 / 来源 / 更新日期 / 示例价自动排除）+ 纯函数引擎：BOM × 阶梯价 + 底板推算线缆 / 端子 / 导轨 / 线槽 + 人工 + 税 / 加成 / 运费；缺价单列「待询价」；成本面板（9 张统计卡 + 明细表 + 缺价告警）导出 A4 PDF 与 UTF-8 BOM 的 CSV；Agent 工具 `run_cost_report` 只读返回同一份报告摘要，`export_cost_report` 按一句话把 PDF/CSV 落到 `userData/exports/` | ✅ 引擎 + 面板 + 导出 + Agent 问答/落盘 |
| **PLC 程序自动生成** | 由机型配置与 IO 点位生成 IEC 61131-3 ST：全量预检（地址冲突 / 类型不符 / 互锁缺失）+ IO 变量表 + 五个基础块 + 自动序列 / 报警 / 安全 FC + `mapping.json`，固定 11 文件与逐文件 SHA-256；生成 UI、zip 导出、最近 10 次历史；内置模拟器执行生成序列（超时 / SafeStop / 传感器矛盾）。边界：通用 ST，不生成厂商专有工程文件；TIA Openness 仍为规划项 | ✅ P8-1～P8-4 |
| **客户可选模块与 Agent checkpoint** | 版本化模块目录、依赖/API/能力校验、持久化启停；模块状态门控覆盖 UI、IPC、Agent/RPC/MCP 与副作用入口；跨重启 checkpoint 仅在安全状态下恢复 | ✅ Core + 10 个可选模块；开关是功能门控，不卸载代码 |
| **可移植工程档案 v2** | 稳定工程 ID/source hash，严格校验来源 CAD 与特征树、稳定对象运动学和视角候选；导入只返回预览、不自动应用或覆盖当前工程 | ✅ 严格预览；状态恢复/事务回滚未实现 |
| **Windows 应用内更新** | stable/beta 手动检查/下载、显式确认后安装、NSIS blockmap 回退、签名与哈希发布预检 | ✅ MVP；真实 Windows Authenticode/升级尚未验收 |

### CAD 与数据

| 能力 | 内容 | 状态 |
|------|------|------|
| CAD 查看 | occt-import-js（STEP / IGES / BREP）+ three.js（STL / OBJ / GLTF / GLB） | ✅ |
| 大装配实测 | 424 KB 装配体 → 5,040 三角面，解析 559 ms | ✅ |
| 运动学标注 | 任意装配体：动件 → 轴 / 行程 / 方向 / 缩回位 / 点位；校验 + 姿态解算 + 滑块预览 | ✅ |
| 无 WebGL 降级 | 渲染不可用时退化为解析统计面板，不白屏；标注仍可编辑 | ✅ |
| 数据包 | 10 个内置 manifest + 用户 ZIP 导入、路径穿越防护、启停；manifest-only 启动、按需加载/卸载、跨包去重、alias 解析与全局索引；全包 schema/重复 id/依赖/`partsSha256` 校验、版本迁移与统计报表 | ✅ |
| 界面缩放 | 注入 CSS `zoom`，100% / 110% / 115% / 125% / 140% / 150%，默认 115%；立即生效并持久化到 `userData/appearance.json`，不改根样式文件 | ✅ 桌面 |
| 3D 渲染质量 | 流畅 / 标准 / 高清三档；拖动时临时降到 0.8 pixelRatio；大于 1500 零件的装配体自动降为流畅并标注原因 | ✅ 桌面 |
| 局域网联调（默认关闭） | 默认仅监听 `127.0.0.1`；按需开启 `0.0.0.0`，IPv4 CIDR / 单 IP 白名单、Bearer token、远程审计；CDP 经 `0.0.0.0:9222 → 127.0.0.1:9229` 白名单转发 | ✅ 桌面 |
| 渲染性能可观测 | `/health.render` 与只读 `get_render_stats` 返回渲染器、软件渲染、像素比、质量档、零件/三角形数与拖动帧时间；软件渲染自动 `flow` | ✅ 桌面 |

### PLC / 联调 / 工厂

| 能力 | 内容 | 状态 |
|------|------|------|
| PLC 适配器 | 仿真器（表达式 / 自锁 / 定时器）+ Modbus TCP（FC01–06） | ✅ |
| 点位模型 | 读写在主进程统一超时 | ✅ |
| 通电联调 | 上电序列 + 用例，逐步 / 一键执行，导出 PDF 章节 | ✅ 仿真验证 |
| 3D 联动 | 机型配置驱动（4 工位 / 12 执行机构 / 16 传感器）+ 运动学标注优先 | ✅ |
| 故障诊断 | 7 条规则 + 兜底，按置信度排序给出原因与处置 | ✅ |
| PLC 程序生成 | P8-1～P8-4：全量预检 + IO 变量表 CSV + 五个基础块 + 自动序列/报警/安全 FC + `mapping.json`，固定 11 文件与逐文件 SHA-256；电气域「PLC 程序」面板（问题定位、文件树、200 行预览）、目标平台/命名前缀、导出 zip（含 CRC）与最近 10 次生成历史；内置模拟器按 `mapping.json` 执行联调序列（行程时间 / `timeScale` / `TimeoutTime` / SafeStop / 传感器矛盾），面板「模拟验证」与 Agent 只读工具 `verify_plc_program` 共用 `verifyGenerated` | ✅ 桌面（生成 + 模拟验证） |
| 智慧工厂 | demo（2 工位 / 8 点位）、OPC UA、MQTT 三适配器 + 实时值面板 | ✅ demo 实测 |
| 设计包同步 | manifest / SHA-256 幂等、`X-Design-Key`、版本 diff、手动上传、失败阶段可区分 | ✅ 本地端到端（后端 0.22.0） |

### 智能体

| 能力 | 内容 | 状态 |
|------|------|------|
| 工具集 | `list_components` / `search_components` / `search_docs` / `design_machine` / `apply_machine_design` / `import_cad` / `build_machine_model` / `build_canvas_assembly` / `save_scene_as_project` / `get_bom` / `get_render_stats` / `get_project_context` / `run_interference_check` / `suggest_kinematics` / `insert_component` / `place_component` / `update_component` / `remove_component` / `run_electrical_check` / `run_cost_report` / `verify_plc_program` / `run_plc_generate` / `export_files` / `export_cost_report` / `undo_last`（25 个：只读 12 + 写 13；写操作走二次确认） | ✅ |
| JSON-RPC | 默认 `127.0.0.1:7420`；可选局域网监听 `0.0.0.0` + CIDR 白名单（默认关闭）。Bearer token 位于 userData 下 `agent-token`，远程来源写审计 | ✅ |
| MCP stdio | 复用同一工具注册表；写工具经桌面 RPC 代理，桌面未启动时明确返回 `DESKTOP_NOT_RUNNING` | ✅ |
| 应用内对话 | OpenAI 兼容接口、工具调用循环、写操作二次确认、密钥仅本机进程 | ✅ |
| 离线规则路由 | 无模型/断网时按关键词规则判 7 类意图并只执行只读工具（写操作明确拒绝） | ✅ |
| 本地知识检索 | `search_docs` 检索 13 份项目文档、截图索引与元件库分类；构建期生成 `desktop/src/agent/kb/kb.json`（≤400 KB），运行时不扫盘、不联网；中文 2-gram + 英文词 BM25，默认 top 3、单次注入 ≤2 KB；无命中返回空数组 | ✅ |
| 上下文快照 | `collectAgentContext()` 采集域 / 视图 / 选中对象（零件、网格、placement、特征）/ 机型 / 底板 / 最近 3 次操作 / 单位；序列化 ≤1.5 KB，采集失败字段为 null 不抛错 | ✅ P7-E |
| 指代消解 | 选中对象优先（0.95）→ 最近操作对象（0.72）→ 底板几何排序（0.78）；低于 0.6 返回 null 并追问一次，不猜 | ✅ P7-E |
| 会话记忆 | 最近 5 次工具调用摘要（工具名 / 关键参数 / 结果码）追加到系统提示末尾，滚动丢弃，不落盘、不上传 | ✅ P7-E |
| 结果裁剪 | 列表 >20 条保留前 20 + `total` + `truncated:true`；长文本按 2 KB 截断；单个工具结果进入模型前硬上限 10 KB | ✅ P7-E |
| 上下文预算 | `budget.ts` 纯函数按 system / selection / memory / docs / toolResults / history 六档装包，默认总量 12k tokens 可配；超限先保留列表首尾各 5 条 + total，再丢最旧 history，最后才动 docs / toolResults；system 策略段永不裁剪，`dropped` 带可读原因 | ✅ P7-M |
| 执行效率 | 同轮相同 `(tool, canonicalArgs)` 只执行一次并标 `reused:true`；写工具永不合并；单轮上限 12 次，超出 `TOO_MANY_TOOL_CALLS`。一次响应内的无依赖只读工具默认 3 路并发，写工具作为屏障；参数引用前序结果时自动降级串行，失败不吞、结果按原顺序回灌 | ✅ P7-N |
| 结果缓存 | `get_bom` / `get_project_context` / `list_components` 按工程指纹缓存 30 秒；任何写工具执行后清空；命中审计写 `cacheHit:true`，进度与审计显示「已复用」；仅会话内存，不落盘、不跨会话 | ✅ P7-N |
| Token 与费用 | 端点回传 usage 时记录真实 `promptTokens / completionTokens`，缺失时按中文 1.6 字符、英文 4 字符估算并标 `estimated:true`；侧栏底部显示本轮 / 本会话 tokens 与费用（`pricing.json`，元/千 tokens，未知模型 `—`）；审计行带 tokens 与 `docsSources` | ✅ P7-M |
| 审计 | 每次工具调用一行 NDJSON 写 `<userData>/agent-audit.jsonl`，记录结果码与耗时，`sk-`/`Bearer`/`token` 等凭据脱敏；`agent:audit:read` 只读接口 | ✅ |
| 计划预览 | 侧栏输入时实时显示「只读 · 可离线」或「写操作 · 需联网确认」，写操作缺参数直接点名（如 `partId`）；预览只展示、不执行 | ✅ |
| 多步规划 | `planner.ts` 离线规则：查件→放置→校验、BOM→成本→导出、导入→干涉、PLC 生成→模拟验证、设计包→上传；未知工具过滤 + warning，规则不命中/置信度 < 0.6 明确拒绝并给建议 | ✅ P7-C |
| 多步执行 | 侧栏计划卡片（序号/工具/参数/原因）+「全部执行/逐步执行/取消」；只读直接跑，写步骤一次确认，任一步失败立即停止，逐项打勾/标红，写操作可提示 `undo_last` | ✅ P7-C |
| 流程模板 | `recipes.ts` 内置 5 个纯数据模板（新机台快速起步 / 底板布置交付 / 电气交付 / 成本核对 / 整包交付）；占位符 `{from:'context.machine.name'}`、前置条件拦截、步骤可取消勾选、失败停止并保留已完成、总/分步耗时、Markdown 执行记录；写工具逐次确认，可选「本流程内同类操作不再询问」（默认关） | ✅ P7-I |
| 统一回执 | 在线模型与离线规则共用一张回执：通道 / 耗时 / 工具次数 / 失败数，离线额外注明只跑只读工具 | ✅ |
| 执行反馈 | 工具执行前显示「正在执行 `tool` · 第 n/N 步」与脱敏参数；执行中 500 ms 秒表、超过 10 s 提示可取消；完成后显示成功/失败、耗时与结果码，连续 3 步汇总耗时 | ✅ P7-F |
| 取消执行 | 侧栏「取消执行」经 `AbortController` 中断当前工具；无写入时提示「已取消，未写入任何更改」，已有写步骤时逐条列出并提示 `undo_last` | ✅ P7-F |
| 失败建议 | `suggest.ts` 按 `PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED` 给中文建议与替代方案；未知码只复述消息，不编造原因 | ✅ P7-F |
| 主动建议 | `advisor.ts` 纯函数按底板重叠 / 干涉 / 缺尺寸 / 电气校验 / 成本过期 / PLC 未生成等真实状态给出 0–3 条 next-best-action；侧栏顶部卡片可直接填入输入框或走单步计划确认，支持本次会话忽略与工具执行后刷新 | ✅ P7-H |
| 审计面板 | 最近 200 条，按时间倒序；列为时间/工具/参数摘要/结果码/耗时，可按工具与结果筛选、导出当前 CSV、单条展开完整脱敏 JSON；超出上限提示丢弃数量 | ✅ P7-F |
| 离线评估 | `docs/desktop/eval/cases.json` 111 条中文用例（25 个工具全覆盖 + 6 类拒绝场景 + 5 类工艺模板/信息不足）；在 `desktop/` 下运行 `npm run eval:agent`，只跑离线规则、不调模型，结果写 `docs/desktop/eval/latest.json` | ✅ 100% 意图 / 100% 工具 / 100% 超纲拒绝（[NL-AGENT.md](docs/desktop/NL-AGENT.md)） |
| **Agent 能力报告** | 在 `desktop/` 下运行 `npm run agent:report`，读取单轮 / 多轮 / 离线评测 JSON 与本机 `<userData>/agent-audit.jsonl`，生成 `docs/desktop/AGENT-REPORT.md`、`docs/desktop/agent-report.json` 和深色一页图 `docs/desktop/agent-report.svg`；每个数字标注来源文件与生成时间，缺源文件写「缺失：<文件>」并打印 WARN（退出码 0） | ✅ |
| 底板放置 | `place_component`：坐标 / 旋转 / 导轨吸附；越界与重叠以 `warnings` 返回；成功后进入撤销栈，`undo_last` 返回 `removed` id | ✅ P7-B |
| 通用产能引擎 | `desktop/src/machine/flow.ts` 的 `evaluateFlow` 按 `single / linear / dial / parallel / cell` 五种布局，由任意工位组成、工序时间、转移/分度时间与目标节拍统一求 cycle、产能、瓶颈和所需工位数；`synthMachine` 只做 `FlowModel` 映射。6 个机型回归（6 工位并行锁螺丝 ≈113 件/分钟、转盘点胶、5 工位直线、单工位检测、2×2 单元、2 副本并行点胶），见 [MACHINE-DESIGN.md](docs/desktop/MACHINE-DESIGN.md) | ✅ |
| 自然语言完整方案 | 25 个已实现工具（另 3 个规划：联调 / 故障诊断 / 设计包同步）、上下文快照与指代消解、会话记忆、结果裁剪、意图路由、离线多步规划、执行进度/取消、失败建议、主动建议、可复用流程模板、本地知识检索、审计筛选与导出、111 条中文评估集、真实模型 36 条评测（36/36，拒绝/澄清 6/6）、工具结果抗注入；自然语言机型方案可确认写入工程，缺执行机构时按 5 类工艺模板补全，并把「工艺 × 布局」选到 11 种整机形态（转盘/直线/龙门/双轨/转盘+直线混合/单元矩阵），联动 3D / BOM / PLC 点位映射，见 [MACHINE-DESIGN.md](docs/desktop/MACHINE-DESIGN.md) | ✅ P7-A～P7-J 与机型落盘、工艺模板/追问已落地（[NL-AGENT.md](docs/desktop/NL-AGENT.md)） |

## 快速开始

### 方式一：网页原型（零依赖，双击即开）

仓库根的 `index.html` 就是完整原型，不需要 Node、不需要构建：

```bash
# Windows
start index.html
# macOS
open index.html
# Linux
xdg-open index.html
```

如遇浏览器对 `file://` 的限制，可起一个静态服务器：`python3 -m http.server 8099`，访问 `http://localhost:8099`。建议 1920×1080 视口。

### 方式二：桌面版（Windows 11）

**安装包**：从 [Releases · v0.2.0](https://github.com/owlco001/automation-cad-prototype/releases/tag/v0.2.0) 下载 `AutomationCAD-Setup-0.2.0.exe`，双击安装。未做代码签名，SmartScreen 会拦一次，选「更多信息 → 仍要运行」。

> v0.4.0 已提供 Windows NSIS 安装包；后续重打由 `windows-build` 手动触发（`gh workflow run windows-build --ref <ref>`）。

**从源码运行**（需 Node 22+）：

```powershell
git clone https://github.com/owlco001/automation-cad-prototype.git
cd automation-cad-prototype\desktop
npm ci
npm run kb:build     # 文档变更后重建本地知识索引（生成 src/agent/kb/kb.json）
npm run build:ext   # 首次必需：dist/ 与 dist-electron/ 不入库
npm start
```

构建过一次之后，日常只需 `cd desktop` + `npm start`。Linux 开发机可用 `npm run smoke`（xvfb + `--headless-smoke`）验证主流程；Windows 开发机用 `npm run smoke:win`（关 GPU 后走 SwiftShader，同样覆盖无 WebGL 降级面板）。

本地验证设计同步全链路（需 `/root/mf-main/material-flow-backend` 的 `.venv`）：`cd desktop && npm run sync:e2e`。脚本会起临时后端，跑通打包 → 上传 → 幂等 → 列表 → diff → 下载 → 断连错误，日志写 `docs/desktop/eval/sync-e2e.json`。

可选真实模型评测（36 条，用例见 `desktop/scripts/agent-live-cases.json`）：`cd desktop && AGENT_LIVE_BASE_URL=... AGENT_LIVE_API_KEY=... AGENT_LIVE_MODEL=... npm run agent:live`；未配置凭据时打印 `AGENT_LIVE_SKIP` 并以 0 退出，结果写 `docs/desktop/eval/agent-live.json`。2026-10-24 本机 bridge / `deepseek-v4.1-flash`：36/36（100%），p50 7.9 s / p95 31.3 s；拒绝/澄清类 6/6，`refusalRate=1.00`，脚本按阈值退出 0。首轮复跑曾出现 1 条既有 `O04` 参数形状失败，第二轮恢复通过，未删用例或降阈值。

多轮真实模型评测（6 个场景 × 2–3 轮，环境变量同 `agent:live`）：`cd desktop && AGENT_LIVE_BASE_URL=... AGENT_LIVE_API_KEY=... AGENT_LIVE_MODEL=... npm run eval:agent:multiturn`；未配置凭据时打印 `AGENT_MULTITURN_SKIP` 并以 0 退出，结果写 `docs/desktop/eval/agent-multiturn.json`，通过阈值 `passRate ≥ 0.8`。

生成给管理层汇报的一页报告：`cd desktop && npm run agent:report`。输出 `docs/desktop/AGENT-REPORT.md`（总览 / 分组 / 能力清单 / 已知缺口 / 审计摘要）、`docs/desktop/agent-report.json`（可机读，含每个指标的来源与生成时间）和 `docs/desktop/agent-report.svg`（5 组准确率横向条形图 + KPI 行）。缺评测 JSON 或 `userData` 审计文件时报告写「缺失：<文件>」，打印 WARN，退出码仍为 0。

### 方式三：把桌面能力接给外部 Agent

桌面启动后即开放 JSON-RPC；MCP（stdio）入口在 `desktop/dist-electron/mcp.cjs`。Claude Code / Codex 的配置样例、token 位置、curl 示例见 [desktop/README.md](desktop/README.md)。

## 目录结构
| `qt-client/` | Qt6 新客户端壳子 v0.1（FeatureManager / PropertyManager / 占位视口；写操作全部走 `featuretree-service`，带 `expectedRevision`，409 冲突拒绝覆盖） |
| `featuretree-service/` | FeatureTree 读写契约服务（Node 标准库，只监听 127.0.0.1）：字段层 + 整树层校验、乐观锁、原子事务、历史留痕、undo/redo、SSE 变更事件；另有 `mcp.mjs` 把服务暴露成 MCP 工具（`ft_get_tree` / `ft_update_params` / `ft_undo` / `ft_list_revisions`）与只读资源；`rebuild-sidecar.py`（build123d）提供真实体积/包围盒/质量，验收 `tests.mjs`(20) / `mcp-tests.mjs`(11) / `build-tests.mjs`(8)；契约见 `docs/featuretree-contract.md` |

```
.
├── index.html / app.js / styles.css          # 网页原型：外壳、交互与计算、设计 token
├── electrical.js / electrical.css            # 电气域三视图（原型扩展）
├── desktop/                                  # Electron 桌面版
│   ├── electron/                             # 主进程、preload、IPC 路由
│   ├── src/
│   │   ├── extension.ts                      # 渲染层注入入口（原型零改动）
│   │   ├── cad/                              # STEP 解析、three.js 查看器、运动学标注与 UI
│   │   ├── parametric/                       # 特征树模型/编辑、参数表单、重建与导出 UI
│   │   ├── mech/                             # 干涉初筛 + 气缸/悬臂梁/螺栓校核
│   │   ├── elec/                             # 线号合规、功率统计、校验面板与 PDF
│   │   ├── enclosure/                        # 底板布置几何层 + SVG 画布
│   │   ├── cost/                             # 价格簿校验 + 硬件成本引擎 + 成本面板/报告 + Agent 工具
│   │   ├── export/                           # PDF / DXF / GLB / OBJ / BOM
│   │   ├── packs/                            # 数据包注册表、面板、电气元件库
│   │   ├── plc/                              # 仿真器 + Modbus TCP
│   │   ├── commission/                       # 机型配置、3D 联动、诊断、联调报告
│   │   ├── machine/                          # 机型方案校验、落盘、BOM 草稿、PLC 点位映射、参数化整机几何与 STL/glTF/sidecar 导出
│   │   ├── factory/                          # demo / OPC UA / MQTT 适配器与面板
│   │   ├── sync/                             # 智慧工厂设计包同步客户端
│   │   ├── agent/                            # JSON-RPC、MCP、应用内对话
│   │   ├── ui/                               # 注入方式与面板壳
│   │   └── shared/                           # 共享类型
│   ├── test/                                 # node:test 单测与集成测试（1831 个）
│   ├── build/                                # 应用图标
│   ├── scripts/                              # esbuild 打包 main / preload / MCP
│   └── release/                              # 本地产物（不入库）
├── packs/builtin/                            # 9 个元器件包（iec-cn 377 / smc-cn 8 / servo-cn 25 / sensor-cn 32 / pneumatic-cn 44 / vision-cn 32 / drive-cn 33 / safety-cn 33 / frame-cn 33）+ pricebook-cn 价格簿
├── docs/
│   ├── desktop/                              # 需求、架构、看板、二期方案、工厂对接
│   ├── desktop/screenshots/                  # 桌面版真实截图（18 张）
│   ├── report/                               # 领导汇报材料（HTML/PDF）
│   ├── reference/                            # 电气元件参考表
│   └── screenshots/                          # 网页原型截图
├── tasks/                                    # 开发任务拆解
└── .github/workflows/windows.yml             # windows-latest 构建 NSIS（手动触发）
```

## 架构要点

- **加而不改**：渲染层就是原型页面，`desktop/src/extension.ts` 在其上挂载 CAD 视图与各面板。原型仍可单独双击运行，桌面版升级不会分叉出第二套 UI。
- **进程边界**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层只有 `window.desktop.*`，没有 fs / net 权限。文件、数据包、协议连接、Agent server 全在主进程。
- **重活不堵 UI**：occt WASM 解析在 Web Worker 中执行；three.js 渲染在渲染层。
- **计算与界面分离**：几何（`enclosure/layout.ts`）、成本（`cost/engine.ts`）、电气规则（`elec/`）、运动学（`cad/kinematics.ts`）、参数化编辑/防抖/分桶（`parametric/model.ts`）都是纯函数，可单测、可被 Agent 复用。
- **同一份工具注册表**：UI 按钮、JSON-RPC、MCP 共用 `src/agent/tools.ts`，能力不会三处漂移。
- **失败要说清楚**：WebGL 不可用退化为统计面板；桌面未启动时 MCP 返回 `DESKTOP_NOT_RUNNING`；工厂 / PLC 连接失败返回中文 `{ ok:false, code, message }`，不抛未捕获异常。

## 测试与构建

```bash
cd desktop
npm test          # 1831 个单测（node:test）
npm run diagnose  # 输出环境/WebGL/userData/数据包（加载指标+统计摘要）/KB/审计/最近 20 条错误（不含密钥）
npm run packs:validate # 校验全部内置包（manifest/parts/重复 id/依赖/partsSha256）
npm run packs:stats    # 生成 docs/desktop/PACK-STATS.md 与 pack-stats.json
npm run packs:add -- ../packs/builtin/my-pack # 生成新包骨架（manifest + 空 parts + README）
npm run perf:baseline # 200/1000/3000 件场景构建、tick 与堆峰值基线
npm run agent:report # 生成 Agent 汇报报告（md / json / svg）
npm run smoke     # xvfb + Electron headless；含 SMOKE_PERF_OK 与 SMOKE_DIAGNOSE_OK
npm run smoke:win # Windows 本地 headless smoke（--disable-gpu 走 SwiftShader，覆盖无 WebGL 降级面板）
npm run sync:e2e  # 本地起 material-flow 后端，跑设计同步端到端（不进单测）
npm run kb:build  # 从 docs/desktop/*.md + 截图 + 元件分类重建 kb.json
npm run build:ext # tsc --noEmit + Vite 扩展 + esbuild main/preload/MCP
```

smoke 覆盖并断言：

- CAD 解析统计（`cube.stp` → 1 零件 / 12 三角面）与无 WebGL 降级面板；
- 运动学标注（`SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25`）；
- 干涉、受力、导出的计算与文件写出；
- PLC 点位、上电序列、用例；
- PLC 代码生成（`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`）：五个基础块、11 文件汇总、自动序列/安全/报警 FC 与确定性校验；内置模拟器按 mapping 跑 6 步联调（0 报警）；UI 从电气域入口打开、预检、生成、模拟验证、历史与 zip 落盘全链路；
- 参数化 sidecar、特征树 UI 与多实体 BOM（假内核，`AUTOMATIONCAD_PARAMETRIC_CMD` 指向 `desktop/scripts/fake-parametric-sidecar.mjs`）：`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`、`SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`；不设环境变量时输出 `SMOKE_PARAMETRIC_UI_SKIP`；
- 3D 联动机型规模（`SMOKE_COMMISSION_3D_SCALE_OK stations=4 actuators=12 sensors=16 parts=16`）与故障诊断；
- 智慧工厂 demo 连接与设计包同步（manifest / ZIP / 幂等）；
- 电气元件库、底板布置（`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`）、电气校验（`SMOKE_ELEC_CHECK_OK findings=4 errors=3`）、成本引擎（`SMOKE_COST_OK lines=6 missing=1 grand=1398.64`）、成本 Agent 工具（`SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`，与引擎合计一致）、成本 Agent 导出（`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes>0 name=sanitized`，假桥接直接调命令、不弹窗）与成本面板（`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`：打开面板 → 载入价格簿 → 计算 → 渲染 9 卡 6 行 → 导出 A4 PDF）；
- 智能体工具注册、渲染桥读写、对话面板字段；机型方案合成（`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=2 form=linear-4`：三工位锁螺丝机示例、选覆盖 3 工位的 linear-4 并给出缺口 warning、模板补全；`SMOKE_MACHINE_POWER_OK kw=1.092 a=1.844 breaker=6` 与 `SMOKE_MACHINE_COST_OK total=17076.23 missing=2`：统一功率模型给出 kW/A/断路器，成本按材料/电气/人工分项并统计缺价）；节拍模型（`SMOKE_MACHINE_CYCLE_OK mode=cell throughput=32 meets=1`：六工位锁螺丝机按双轨 (3.18 + 0.60) / 2 秒/件估算 31.75 件/分钟）；工艺模板与追问（`SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`：5 类模板、多缺项合并为一次追问）；整机形态库（`SMOKE_MACHINE_FORMS_OK forms=11 picked=dial-12 meets=1`：11 种形态字段合法、十二工位转盘检测按覆盖优先选中 dial-12，龙门多头/混合线/单元矩阵几何可生成）；机型方案落盘与联动（`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=7 undo=1`：写方案与 active 指针、3D 切到 3 工位、7 行 BOM 与 PLC `io-map.csv` 落盘，撤销后回到 4 工位样机）；参数化整机几何（`SMOKE_MACHINE_GEOMETRY_OK layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56`：三工位锁螺丝机按 form.geometry 生成直线机架 56 个 mm 级零件与 6 条运动轴，落盘 geometry.json / STL / glTF / sidecar 实体列表，3D 场景零件数一致，撤销后删除）；上下文预算（`SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`：长列表首尾收敛、history 先丢、system 保留且最终不超预算）；只读问答 UI（`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2`：只读指令标可离线、写指令标需联网并点名缺 `partId`、预览不改变场景、审计面板读到 2 条）；离线规则路由（`SMOKE_AGENT_NL_OK intents=7 tools=21 audit=3 ctx=616`：7 类意图全覆盖、写计划不进入离线通道、审计 3 条且密钥不落原文）；上下文与指代（`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`：选中对象优先、最近 3 条操作、几何排序、列表裁剪与 1.5 KB 上限）；底板放置与撤销（`SMOKE_AGENT_PLACE_OK placed=1 undo=1`：真实 `__Enclosure` 放置 1 件、吸附导轨、撤销后归零）；Agent 工具扩展（`SMOKE_AGENT_TOOLS_V2 tools=21`：机型设计/落盘、上下文、元件修改/移除、PLC 落盘、通用导出、本地知识检索全部注册）；知识检索（`SMOKE_AGENT_KB_OK docs=13 chunks=353 query=D2 hits=1`：13 份文档 + 截图/分类索引，D2 命中 1 条）；执行体验（`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`：3 步进度 start/end、3 条含耗时审计、取消后「未写入任何更改」）。流程模板（`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`：5 个模板、5 步流程第 3 步注入失败后停止并保留前 2 步；`SMOKE_AGENT_RECIPE_UI_OK` 校验下拉、步骤与导出按钮）。

输出形如 `SMOKE_UI_OK`、`SMOKE_PLC_OK`、`SMOKE_AGENT_TOOLS_OK`、`SMOKE_AGENT_KB_OK docs=13 chunks=353 query=D2 hits=1`、`SMOKE_PERF_OK parts=1000 buildMs=… tickMs=…`、`SMOKE_PACKS_LAZY_OK packs=10 loaded=2 searchMs=…`、`SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44 vision=32 drive=33 safety=28 frame=33`、`SMOKE_PACKS_VALIDATE_OK packs=10 errors=0`、`SMOKE_DIAGNOSE_OK fields=app,webgl,userDataPath,dataPack,packMetrics,packStats,kb,audit,recentErrors errors=…`，最后 `SMOKE_OK`。

诊断与崩溃现场：

- `npm run diagnose` 打印应用/Electron/Node 版本、WebGL 可用性、userData、内置数据包版本与数量、包加载指标（`packLoadMs / loadedPacks / partsLoaded / searchMs / packCount`）、库统计摘要（包数/条数/唯一型号/分类/错误/警告）、KB 文档/分段/字节、审计文件大小、最近 20 条错误摘要；输出经过密钥脱敏。脚本在 Linux 下用 `xvfb-run`，Windows 桌面可直接 `npx electron . --diagnose`。
- 未捕获异常与未处理 Promise 拒绝会写 `<userData>/diagnostics/last-crash.json`，只含堆栈、版本、平台与操作类型，不保存用户输入正文。

**仓库镜像**：主仓库 GitHub `owlco001/automation-cad-prototype`，镜像 Gitee 同名仓库（公开）。`origin` 已配置双 push 地址，`git push origin main` 会同时推两边；推 tag 用 `git bothpush`（等价 `git push origin main && git push origin --tags`）。任一远端失败即整体失败，不要只推一边；详见 `docs/desktop/BACKLOG.md`「仓库双推约定」。

**CI**：`.github/workflows/windows.yml` 在 `windows-latest` 上跑 `npm ci → build:ext → test → electron-builder --win nsis --x64`，产物为 `AutomationCAD-Setup-*.exe` + blockmap。当前**仅手动触发**：`gh workflow run windows-build --ref main`；推 `v*` tag 时额外发布到 GitHub Release。本地只想出免安装包可用 `npx electron-builder --win zip --x64`。

## 已知限制

- **安装包未签名**：无代码签名证书，Win11 SmartScreen 首次会提示。
- **本轮模块/更新边界**：模块开关只门控功能，不卸载应用代码；`.acproj` v2 目前只做严格预览，不恢复工程状态；更新通道尚未在真实 Windows 签名环境验收，PLC 同步扩展也未向外部服务端验证。
- **OPC UA 只支持 SecurityPolicy=None**，未接真实 PLC；MQTT 未连真实 broker；Modbus 未连真机（仿真器已实测）。
- **价格簿尚无真实报价**：内置价格簿只含明确标注「示例，需替换」的条目，引擎会自动排除示例价；真实成本需导入企业价格表后才能用于报价。机型方案卡的 `cost` 是方案阶段粗估（机械/电气/人工，缺价行不计入合计），不替代 `cost/engine.ts` 的正式报价流程。
- **成本面板的 BOM 需手工导入**：面板接受 BOM JSON（或由上层注入 `__CostBomProvider`），尚未把 CAD 模型零件名自动映射到元器件物料号（映射口径待定，见 BACKLOG D7）；Agent 工具 `run_cost_report` 未传 `bom` 时回落到当前场景 BOM，场景零件没有物料号，会全部计入「缺物料号」而不会按 0 计价。Agent 导出工具 `export_cost_report` 固定写 `<userData>/exports/`（Windows 通常为 `%APPDATA%/AutomationCAD/exports/`），不接受任意绝对路径、不弹系统保存对话框；面板里的 CSV 仍走系统保存对话框。
- **运动学标注需人工指定**：STEP 不含运动学，动件 / 轴 / 行程 / 点位由人标注；未标注时联调回退到机型配置。
- **参数化建模已完成 P9-5 多实体与 BOM 联动**：右侧抽屉可维护多个实体（独立 box / holes / slot / fillet / cylinder 特征与 X/Y/Z/RZ），自动重建后载入 sidecar 返回的 STL 并叠加旧模型；BOM 按 partId 合并、未映射件显式标黄，可导出 UTF-8 BOM CSV 并送成本面板，未映射件按 `NO_PART_ID` 缺价（[PARAMETRIC-CAD.md](docs/desktop/PARAMETRIC-CAD.md)）。仍需 Python sidecar 运行时；草图约束（P9-4）未做。
- **PLC 程序自动生成完成 P8-1～P8-4**：预检、IO 变量表、五个基础块、自动序列/报警/安全 FC、`mapping.json`、生成 UI、zip 导出、最近 10 次历史，以及内置模拟器执行联调序列（超时/SafeStop/传感器矛盾）已落地（[PLC-CODEGEN.md](docs/desktop/PLC-CODEGEN.md)）；仍不生成厂商专有工程文件。
- **委外加工数据智能系统为规划项**：仅在设计方案与汇报材料中描述，未开发。
- **便携包偏大**（Electron 45 + node-opcua，解压后数百 MB），后续可按需懒加载 node-opcua 或改 sidecar。
- **干涉为 AABB 初筛**，不是精确布尔求交；贴合面、螺纹啮合可能被误报，需要白名单收口。
- **智能体对话的真实模型兼容性**目前只对 OpenAI 兼容协议和本机 bridge / `deepseek-v4.1-flash` 做 36 条实测（36/36；拒绝/澄清 6/6，确认绕过与危险路径导出已有硬拦截）；其他服务商差异需逐一验证。单元测试仍使用本地假服务，不访问外网模型。
- **离线意图路由是关键词规则，不是语义理解**：只覆盖 7 类意图与元件/成本/BOM/干涉/电气校验等有限句式，同义表达未收录会判为「超纲」；离线通道只执行只读工具，写操作一律要求联网确认。审计文件 `agent-audit.jsonl` 目前只追加、未做轮转与保留期清理；面板最多展示最近 200 条，回执不含 token 用量（网关未回传 usage）。
- **生产环境未验证**：`/api/v1/design-sync/*` 后端 0.22.0 已实现并通过 30 项测试，本地临时 DB 端到端已通过（`npm run sync:e2e`）；生产实例 `221.231.106.194:5556` 当前从开发机不可达，线上部署仍待 D2 决策。
- **原型侧的固有限制部分缓解**：桌面版在有 WebGL 时把装配/干涉视口换成可旋转 three.js（标准视图、透视/正交、适合、树↔3D 选择），缸径/行程与桌面版尺寸/位置参数会沿「底板→导轨→滑台→气缸」叠放链重建几何；但它仍是参数化示意体（长方体/圆柱、缸径沿用原型示意比例），不是 B-rep 几何求解，插入件仍为 20 mm 占位体；WebGL 不可用时回到原型固定等轴测。桌面版的 CAD 查看是独立视图，不替代原型建模。

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/desktop/STATUS.md](docs/desktop/STATUS.md) | 当前进度、验证记录、未完成项与风险 |
| [docs/desktop/BACKLOG.md](docs/desktop/BACKLOG.md) | 夜间迭代看板：待办优先级、已完成提交号、已知问题 |
| [docs/desktop/MODULES.md](docs/desktop/MODULES.md) | 模块索引、跨模块数据流、维护约定 |
| [docs/desktop/ARCHITECTURE.md](docs/desktop/ARCHITECTURE.md) | 技术选型、进程与安全边界、关键接口 |
| [docs/desktop/REQUIREMENTS.md](docs/desktop/REQUIREMENTS.md) | 需求来源与验收口径 |
| [docs/desktop/PHASE2.md](docs/desktop/PHASE2.md) | 二期需求拆分（干涉/受力/PLC/联调/导出/同步） |
| [docs/desktop/COSTING.md](docs/desktop/COSTING.md) | 硬件成本统计：价格簿格式、计算口径、验收 |
| [docs/desktop/MACHINE-DESIGN.md](docs/desktop/MACHINE-DESIGN.md) | 自然语言机型方案：需求抽取、方案合成、整机形态库（工艺 × 布局）、统一功率/成本模型（公式、默认系数、`machine-pricing.json`、边界）、`design_machine` / `apply_machine_design` 与 3D/BOM/PLC 联动、参数化整机几何（mm 尺寸、运动轴、STL/glTF/build123d 实体列表） |
| [docs/desktop/MACHINE-DESIGN-DEMO.md](docs/desktop/MACHINE-DESIGN-DEMO.md) | 六工位锁螺丝机完整案例：真实解析/合成、节拍、统一功率与成本粗估、同一需求转盘/直线两种形态对比、真实 BOM、19 行 PLC IO 与四张全流程截图 |
| [docs/desktop/NL-AGENT.md](docs/desktop/NL-AGENT.md) | 自然语言 Agent：架构、25 个已实现工具、机型方案设计与落盘、本地知识检索、写操作分级、安全、评估集 |
| [docs/desktop/PARAMETRIC-CAD.md](docs/desktop/PARAMETRIC-CAD.md) | 参数化建模：build123d 选型、sidecar 契约、特征树与分期 |
| [docs/desktop/PARAMETRIC-CAD-SPIKE.md](docs/desktop/PARAMETRIC-CAD-SPIKE.md) | CadQuery / build123d / replicad 三方案实测对比 |
| [docs/desktop/SKETCH-SPIKE.md](docs/desktop/SKETCH-SPIKE.md) | P9-4 草图约束前置验证：planegcs 实测、build123d 衔接与分期 |
| [docs/desktop/PLC-CODEGEN.md](docs/desktop/PLC-CODEGEN.md) | 设计完成后自动生成 PLC 程序（ST + IO 表 + 预检） |
| [docs/desktop/SMART-FACTORY-INTEGRATION.md](docs/desktop/SMART-FACTORY-INTEGRATION.md) | 智慧工厂接口契约与联调口径 |
| [docs/desktop/PLUGIN-PACKS.md](docs/desktop/PLUGIN-PACKS.md) | 数据包格式与加载规则 |
| [docs/desktop/CI.md](docs/desktop/CI.md) | Windows 安装包构建与手动触发方式 |
| [docs/report/PROJECT-INTRO.html](docs/report/PROJECT-INTRO.html) | 领导汇报用项目简介（19 页，可打印 A4） |
| [docs/reference/electrical-components.md](docs/reference/electrical-components.md) | 电气元件参数参考 |
| [desktop/README.md](desktop/README.md) | 桌面版命令、MCP 接入、JSON-RPC 与各面板细节 |

> `packs/builtin` 中的元器件参数与价格仅用于选型 / 成本演示，定型与报价前请以厂商最新样本、铭牌与正式报价为准。

## 许可证 / License

本项目源码以 [GNU General Public License v3.0](LICENSE) 发布。随安装包分发的第三方组件
各有其许可证，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；其中 LibreDWG WASM
为 GPL-3.0，这也是本项目选择 GPL-3.0 的原因之一。

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Only official Windows releases built from this public repository by the GitHub Actions
`windows-build` workflow are submitted for signing. Each signing request is approved
manually before the signed installer is published to GitHub Releases. Binaries built
on personal machines are never signed.

### Team roles

- Committers and reviewers: [owlco001](https://github.com/owlco001) — trusted to modify
  the source code; every change proposed by non-committers is reviewed by the maintainer.
- Approvers: [owlco001](https://github.com/owlco001) — approves each code signing request.

All team members use multi-factor authentication for both GitHub and SignPath.

### Privacy policy

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.
User-triggered exceptions, all off or manual by default: checking for application
updates, synchronizing design packages with a user-configured Smart Factory server,
and the in-app agent calling a user-configured LLM endpoint. Third-party components
bundled with the installer are listed in THIRD-PARTY-NOTICES.md.
