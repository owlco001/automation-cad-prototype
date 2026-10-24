# 迭代历史归档（BACKLOG-HISTORY）

从 [BACKLOG.md](BACKLOG.md) 移出的已完成迭代记录，原文保留、按时间倒序。本文件**不进入**智能体离线知识索引（`desktop/src/agent/kb/index.ts` 的 `KB_DOC_FILES`），需要时直接打开阅读。

## 可选模块、工程导入安全与应用更新（2026-10-24，本轮）

- 状态：✅ 本地实现完成；实现提交 `eb0c830`。最新 `main` 基线 `0d69dc0` 上 `TZ=UTC npm test` **1800/1800**、`npm run build:ext` 和 fake-sidecar Electron headless smoke 全绿（最终 `SMOKE_OK`）。
- 可选模块：增加版本化 registry、依赖/API/能力检查、本地设置与 renderer→主进程同步门控；接入 Agent `agent.resume` checkpoint、PLC 生成、成本、电气校验、联调 IO 测试、工厂 PLC 同步、参数化 CAD/历史、可移植工程档案和系统更新。停用入口在 UI、IPC、命令总线、Agent/RPC/MCP 和文件/网络副作用边界被拒绝；数据保留。模块开关不等于代码卸载，也不授予 PLC 安全互锁。
- CAD 与工程：导入采用身份事务，解析/候选模型应用失败时保留既有文档；参数化输出改用独立叠加体，原 CAD 保留为只读参考；运动学标注按稳定对象身份绑定。`.acproj` v2 采用稳定 project ID/source hash 和严格只读预览，不自动应用、覆盖或恢复工程状态。
- Agent/PLC：跨重启 checkpoint 仅保存哈希与有限步骤状态，不保存计划参数、结果、对话或凭据；写步骤副作用状态不确定时拒绝恢复。PLC 仿真初值/写入范围统一校验，空序列不再按成功处理；标准 IO 测试增加机型映射兼容检查。
- 更新与同步：实现 stable/beta 手动检查/下载/确认后非静默安装、NSIS blockmap 回退与发布产物签名/hash 预检；设计包可选附带 PLC 源码与 IO mapping，并执行路径、容量、哈希、版本和凭据检查，解析只产生需显式应用的候选。
- 本地验证：`npm run build:ext` 通过（含 TypeScript）；Electron smoke 通过，覆盖 `SMOKE_MODULE_UI_OK`、`SMOKE_MODULE_GATE_IPC_OK`、`SMOKE_AGENT_PLAN_CHECKPOINT_OK`、`SMOKE_COMMISSION_MODULE_BOUNDARY_OK`、`SMOKE_COST_MODULE_GATE_OK`、`SMOKE_PARAMETRIC_MODULE_GATE_OK`、`SMOKE_PARAMETRIC_HISTORY_GATE_OK`、`SMOKE_PACKS_VALIDATE_OK`。smoke 收尾有一次 fake sidecar 退出后的非致命 health retry `ECONNREFUSED`，但进程以 `SMOKE_OK` / 退出码 0 结束。
- 未完成验收：未配置真实 Authenticode 证书，未在 Windows VM 完成真实 stable/beta 升级、签名/哈希拒绝与差分回退；PLC 扩展未向外部服务端验证；工程档案尚无显式状态恢复/事务回滚；可选模块仍随应用整体打包。

## 前一轮：包生命周期与库统计（2026-10-24，已完成）

- 状态：✅ 完成；10 个包全部通过 `validatePackCatalog`，`errors=0`。
- 校验器：`desktop/src/packs/validate.ts` 的 `validatePack(dir)` 返回 `{ ok, errors, warnings, stats }`；覆盖 manifest 必填/semver、`partsCount`、包内与跨包 id 唯一、category 白名单、model 非空、数值有限、`partsSha256`、`requires` 依赖；坏 JSON 返回错误不抛异常。
- 完整性：9 个元器件包 manifest 增加 `partsSha256`；registry 加载时校验，不匹配抛 `PACK_INTEGRITY_FAILED`，不静默返回缓存。
- 迁移：`parts.schemaVersion: 1` 自动补 `specs: {}` 与条目 `schemaVersion: 2` 并记 `PACK_SCHEMA_MIGRATED`；数组与 v2 文档继续兼容。
- 统计：`scripts/pack-stats.mjs` 产出 `docs/desktop/PACK-STATS.md` + `pack-stats.json`；共 10 包 / 617 条（612 实型号 + 5 alias）/ 617 唯一 id / 612 唯一型号 / 55 分类；尺寸 342/612（55.9%）、价格 44/612（7.2%）、BOM 常见型号价格命中 8/11；跨包重复 0。
- 命令：`npm run packs:validate`、`npm run packs:stats`、`npm run packs:add -- <dir>`；新骨架为 manifest + 空 parts + README，可直接通过校验。
- smoke：新增 `SMOKE_PACKS_VALIDATE_OK packs=10 errors=0`；diagnose 增加 `packStats` 摘要与「包统计」文本行。
- 测试：`desktop/test/packs/lifecycle.test.mjs` 31 条，覆盖正/负例、迁移、依赖、registry 校验和、统计一致性、跨包重复、骨架与 diagnose 摘要。
- 验收：`tsc` 干净；`TZ=Asia/Shanghai npm test` **1655/1655**；`npm run packs:validate` = `packs=10 errors=0`；`npm run packs:stats` 产出 md + json。

## 上一轮：安全件 + 机架结构件扩包（2026-10-24）

- 状态：✅ 完成；`safety-cn` 33 条、`frame-cn` 33 条；10 个 manifest，可检索 612 条 / 612 唯一 id。
- 安全件：F3SG-SR/PG 4 档高度、西克 deTec4/microScan3、邦纳 LS 3 档；PNOZ s5、XPSAF、3SK1/2；AZM300/400、PSEN ml、D4NS/D4GS、XB5AS8445；PNOZmulti 2、S7-1200F 两条。字段齐全 `type/pl/category/responseTimeMs/channels/voltage/dims`。
- alias：PNOZ s3/s4、XPSAC5121、3SK1111-1AB30、NP2-BS542 已存在，`safety-cn` 仅 5 条 `aliasOf`；`listParts` 不显示 alias，`getPartById` 链式解析并防环。
- 结构件：APAS 槽 8/10 型材 40×40/40×80/45×45/45×90/80×80；角件/内置连接/T 螺母/端盖；网框/亚克力/铝塑板；福马轮/调节脚（100–1600 kg）；安全门铰链/门框/门锁；皮带/倍速链段。
- 数据：米重 `kg/m`、惯性矩 `cm⁴`、承载 `kg`；型材参数取自 APAS info-53/41/64/56/32，连接/脚轮取自 APAS/item24；缺失参数留空并标「未核实」，不录价格。
- 测试：`desktop/test/packs/safety-frame.test.mjs` 20 条，覆盖容量、字段/单位、10 包 id 与型号唯一、alias 解析/防环、无价格、体积、懒加载与分类聚合。
- 验收：`tsc` 干净；`TZ=Asia/Shanghai npm test` **1624/1624**（+20）；smoke `SMOKE_PACKS_LAZY_OK packs=10 loaded=2 searchMs=5.635 coldMs=6.2 parts=402`、`SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44 vision=32 drive=33 safety=28 frame=33`；diagnose `dataPack.count=10`；`eval:agent` 1.00。

## 历史已知问题原文（2026-10-24）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决；STEP 不含运动学，任意装配体仍需标注层。36-auto-kinematics 起可按名称/型号/层级/几何自动给出标注**建议**（需逐条确认），但识别是启发式：命名不规范或几何不典型的机构仍需人工标注，斜向运动只能取最近主轴，夹爪对侧手指、缩回位与无型号行程仍需人工确认。 迭代 34 起机型方案的 3D 改为参数化整机几何，但仍是标准件外形，不是结构设计。
2. **尺寸数据覆盖不全**：已补至 266/379（70.2%；16 条同系列推定，2026-10-24 第二批 22 条全部为官方尺寸），仍缺 113 条；缺失元件在底板画布上按「未标注尺寸」处理，需人工补（清单与来源见 DIMS-GAPS.md）。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：原型自身 3D 仍为固定等轴测投影（插入与撤销已真实化）。**桌面版已缓解（35-orbit-view + 收尾）**：有 WebGL 时主视口为可旋转 three.js，缸径/行程与桌面版尺寸/位置编辑沿叠放链重建几何；桌面版几何编辑已进撤销栈（与原型合成一条时间线）、内置零件覆盖持久化到工程存储，WebGL 模式支持 Shift+拖拽 / 「框选」模式多选。仍未解决：几何为参数化示意体（非 B-rep、无配合求解、缸径为原型示意比例）；插入件尺寸覆盖不持久化（原型不持久化插入件）；3D 存储为单键、不按机型分桶；撤销对账依赖原型状态栏文案（原型改文案需同步改 `parseProtoCounts`）；无 WebGL 时回到固定等轴测。
8. **真实模型拒绝/澄清类**：已从 4/6 修到 6/6（判定语义修正 + 两条系统提示）；但仍是单模型单轮结果，换模型或换措辞需重跑 `npm run agent:live`，不要把 30/30 当成通用结论。
9. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板最多显示最近 200 条（可筛选/导出），回执不含 token 用量（网关未回传 usage）。 **2026-10-24 更新（feat/agent-audit-router）**：① 审计已按大小轮转 + 保留期清理（默认 5 MB × 5 份 × 90 天，可配置），面板/报告读全部保留份数；被保留期删除的份数不可恢复，CSV 仍只导出面板当前列表（≤200 条）。② 路由已系统补同义/口语词并加非工程话题拦截（评估集 102 条）；仍是关键词规则：未收录的说法照旧判超纲，「撞」「会动」「规划」等单字/泛词可能把边缘句子拉进工程意图，非工程话题表是有限枚举。回执 token 用量问题未变。
10. **多轮评测证据仍是 5/6**：`docs/desktop/eval/agent-multiturn.json`（Fri 2026-10-23 8:28 PM CST (UTC+08:00)）中 MT04「拒绝后自动重试」两轮未过；会话层拒绝记忆已修复，但尚未有新的真实模型多轮 JSON，报告按现有证据展示，重跑 `npm run eval:agent:multiturn` 后再更新。 **2026-10-24 更新**：上述描述已过时——仓库内 `agent-multiturn.json` 已是修复后的真实模型结果（`cn:deepseek-v4.1-flash`，生成于 Fri 2026-10-23 10:08 PM CST (UTC+08:00)，6/6 场景、15/15 轮，MT04 通过），Agent 报告按此展示。本轮补了 `test/agent/multiturn-mt04.test.mjs` 会话层确定性回归（fake LLM 回放 MT04：原样重试与 `partId` 写法重试都被短路、不弹确认）。本机无 `AGENT_LIVE_BASE_URL/API_KEY/MODEL`，**真实模型重跑待有 key 时执行**（换模型/换措辞仍需重跑，单模型单次结果不是通用结论）。遗留边界：拒绝记忆按「工具 + 目标」匹配，模型若在「继续」后改用别的写工具动同一目标（如 `remove_component QF1`）仍会走确认框，真实评测会算违规。
11. **两条成本导出单测依赖本地时区**：`test/cost-export.test.ts` 的文件名断言按 Asia/Shanghai 本地时间（`…-20261023-1200`）；在 UTC 环境（如本轮沙箱）直接 `npm test` 会 1130/1132，需 `TZ=Asia/Shanghai npm test`。35-orbit-view 未改这两条断言，只记录。
12. **安全光栅型号与截图（已补录，2026-10-24）**：`iec-cn` 已补 8 条官方来源的 Type 4 安全光栅，六工位案例 BOM 初选 `F3SG-4SRA0640-14`；四张机型截图已在 xvfb + Electron 下重拍，17 号 BOM 图不再显示「待选型」。仍待：安全距离按 ISO 13855 用现场停机时间核算。
13. ✅ **已修复（提交号：accaf9d）——节拍模型未区分「并行同工序」与「流水线分工序」**（原问题记录，2026-10-24 发现）：`synthMachine` 原先只按流水线建模——产能由最慢工位决定，补并行工位只针对瓶颈工序。因此「六工位锁螺丝机、20 件/分钟」被判为不达标（3.18 s/件 > 3.00 s/件，建议 12 工位），但 6 个**同工序并行**工位的实际产能应为 `6 / 3.18 × 60 ≈ 113 件/分钟`。影响：机型方案卡与 `machine-case.json` 的节拍结论偏保守，`MACHINE-DESIGN-DEMO.md` 已如实标注「若坚持该估算模型需 12 工位」。修复：`MachineBrief` 增加 `layout` 与 `processes`，解析器按流水线关键词/多工序推断 `line`，单一工艺推断 `parallel`；`MachineCycleEstimate` 增加 `mode`、`stationSeconds`、`throughputPerMin`，并行按 `stations / stationSeconds × 60`、流水线按 `60 / 最慢工位` 计算；新增 `test/machine/cycle-mode.test.mjs` 19 条与 `SMOKE_MACHINE_CYCLE_OK`，六工位案例重算为 `113.21 件/分钟`、`meetsTarget=true`。

## 上一轮：视觉与传动扩包（2026-10-24）

- 状态：✅ 完成；新增 `vision-cn`（32 条 / 6 分类）与 `drive-cn`（33 条 / 8 分类），内置 manifest 增至 8 个；元器件合计 551 条 / 551 个唯一 id。未 push、未提交。
- 视觉覆盖：海康 MV-CS/CE 500/1200 万（GigE/USB3）、大恒 MER2、Basler ace 2；Computar/海康 8/12/16/25 mm 定焦 + Computar 远心；海康/奥普特环形/条形/背光与 2 条光源控制器；海康 ID3000/ID5000 与基恩士 SR-1000；海康 VisionMaster MV-VC3000 与基恩士 CV-X100。
- 传动覆盖：HIWIN R16/R20/R25 C7 与 TBI SFU 1605/2005/2505/2510/3205；HIWIN HGH15/20/25/30CA；Neugart PLE、APEX AB、绿的谐波 LCS；KTR ROTEX 与 R+W BK2；Gates GT2/HTD 5M 带与米思米带轮；KHK 齿条；HIWIN KK60/KK86 模组。
- 数据口径：每条 `specs.数据来源` 记录官方样本/数据表与页码/链接；尺寸只录官方，查不到留空；Basler 3 条相机带官方 `dims` + `dims.source`；新包不录价格。
- 去重：跨 8 包按 id 与型号双重扫描均唯一。历史重复 `D-M9B` 保留在 `smc-cn`（BOM 演示引用），删除 `iec-cn` 副本；`SR-1000` 保留在 `vision-cn`，删除 `iec-cn` 旧副本。`iec-cn` 调整为 377 条。
- 验收：`tsc` 干净；`TZ=Asia/Shanghai npm test` **1604/1604**（+22）；`npm run smoke` 输出 `SMOKE_PACKS_LAZY_OK packs=8 loaded=2 searchMs=5.079 coldMs=5.7 parts=402`、`SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44 vision=32 drive=33`、`SMOKE_UI_OK ... packs=8 ...`、`SMOKE_ELEC_LIB_OK parts=377 categories=26 symbols=219`；`npm run diagnose` 的 `dataPack.count=8` 且列表含 8 个包；`npm run eval:agent` 1.00。
- 性能/体积：`vision-cn/parts.json` 17,386 B、`drive-cn/parts.json` 14,876 B，均 ≤400 KB；最大单包 `iec-cn` 162,897 B；8 包全量搜索由单测与 smoke 断言 ≤25 ms。
- 新增测试：`desktop/test/packs/vision-drive.test.mjs` 22 条（容量、类型字段、来源/尺寸、无价格、8 包 id/型号唯一、体积、manifest 版本与 partsCount、懒加载未命中不读 parts、packId 过滤、型号搜索、分类聚合、smoke 计数口径）。

## 上一轮：元器件库扩展与模块化按需加载（2026-10-24）

- 状态：✅ 完成；新增 `servo-cn`（25 条）、`sensor-cn`（32 条）、`pneumatic-cn`（44 条），内置元器件包增至 5 个 + `pricebook-cn` 价格簿（manifest 6 个）。未 push、未提交。
- 数据口径：型号/参数取自厂商公开样本/数据表；每条 `specs.数据来源`、有官方依据的 `dims.source` 记录出处。汇川 MS1H1/MS1H3 尺寸取自 SV660P 硬件手册尺寸表；雷赛 57CM 尺寸/转矩取自官方产品页；查不到官方尺寸的条目不写 `dims`。
- 懒加载：`scan()` 只读 manifest；`listParts` 按 `manifest.categories` / 包名/关键词预过滤，命中包才 `loadPack`；`unloadPack` 释放；同 id 跨包去重（内置优先）；`getPartById` 懒建全局 partId 索引；`metrics()` 暴露 `packLoadMs/loadedPacks/partsLoaded/searchMs/packCount/indexedParts`。
- 验收：`tsc` 干净；`TZ=Asia/Shanghai npm test` **1582/1582**（+32）；`npm run smoke` 输出 `SMOKE_PACKS_LAZY_OK packs=6 loaded=2 searchMs=5.267 coldMs=5.9 parts=404`、`SMOKE_PACKS_COUNT servo=25 sensor=32 pneumatic=44`；`npm run eval:agent` 1.00；`npm run diagnose` 含 `packMetrics`（loadedPacks=2 / partsLoaded=404 / packLoadMs≈4.6 / searchMs≈6.2）。
- 性能/体积：冷启动到可搜索 ≈5.3 ms（目标 ≤120 ms）；6 包全量命中搜索 ≈3.2–4.8 ms（目标 ≤25 ms）；最大单包 `iec-cn/parts.json` 160 KB（目标 ≤400 KB）。

## 价格数据回填与成本覆盖率（2026-10-24，本轮）

- 状态：✅ 完成；价格簿升级到 `schemaVersion: 2`，保留 v1 兼容；真实条目从 0 条提升到 **64 条**（另有 4 条 `EXAMPLE-*`，不参与统计/计价）。未 push、未提交。
- 来源：西域 EHSY 公开商品页 63 条 + 供应商网 1 条；每条均记录可点击 `source`、`sourceType=distributor`、`checkedAt=2026-10-24`、`model`、`category`。西域条目标注含税（页面同时列 13% 未税价）；PNOZ s3 页面未标注税额，`taxIncluded=null` 并在 `note` 说明。
- 案例覆盖：六工位 BOM 12 行中已计价 **9 行（75%）**，缺价从 9 行降到 **3 行**：`MS1H1-75B30CB`、`F3SG-4SRA0640-14`、`CP1E-N40DR-A`。`machine-case.json` 更新为材料 6654 / 电气 12283.91 / 人工 15552 / 合计 34489.91。
- 成本模型：新增 `priceMeta { coveragePct, pricedCount, totalCount, missing, stale, unknownSource }`；`checkedAt` 严格超过 180 天才标过期，v1 缺 `sourceType/checkedAt` 的条目照常计价但标「来源不明」。方案卡显示「已计价 N/M 行（覆盖率 X%）、缺价 K 项、过期 L 项」。
- 验收：`tsc` 干净、`TZ=Asia/Shanghai npm test` **1550/1550**、`npm run smoke` 输出 `SMOKE_PRICEBOOK_OK items=64 caseCoverage=9/12`、`demo-doc.test.mjs` 4/4；15/16 号机型截图已重拍，方案卡显示 9/12 与 ¥34,489.91。新增 v1/v2 兼容、URL/来源类型/日期/税额校验、示例隔离、180 天边界、tiers、来源不明、覆盖率与案例 9/12 等断言；详见 [`PRICING.md`](PRICING.md)。

## 修复形态选型「越界预览」（2026-10-24，上一轮）

- 状态：✅ 修复完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1529/1529**（较上轮 +20）、`npm run smoke` 更新为 `SMOKE_MACHINE_FORMS_OK forms=11 picked=dial-12 meets=1`；未 push、未打包。
- 缺陷：41 轮新增 8–12 工位形态后，`pickForm` 仍用**需求工位数**给所有候选算产能。`gantry-4`（4–4）被按 12 工位预演出 `109.09` 件/分钟，进入 `meeting` 池；`dial-12` 按真实 12 工位只有 `22.64` 件/分钟，最终按工位距离回退到越界的 `gantry-4`。
- 复现（修复前输出 `gantry-4` + 非标回退 warning）：

  ```bash
  cd desktop
  node --experimental-strip-types -e "import('./src/machine/spec.ts').then(async s=>{const f=await import('./src/machine/forms.ts');const b=s.parseMachineBrief('十二工位转盘检测机，节拍 60 件/分钟');const p=f.pickForm(b,{},{stationCount:b.stations,cyclePerMin:b.cyclePerMin});console.log(p.form.id,p.warning)})"
  ```

- 根因与修复：`Candidate` 新增 `clamped` / `previewStations`；`previewModel` 统一使用 `clamp(需求, stationRange)`；选型改为四档优先级「覆盖且达标 → 仅覆盖 → 仅达标（确无覆盖时）→ 全量按工位距离」。覆盖仍按需求工位数判定，warning 同时写支持范围、需求值与实际生成工位数；`synthMachine` 用 `formPick.stations` 生成配置，被夹紧时写入 `assumptions`。
- 回归：新增 `test/machine/form-clamp.test.mjs` 20 条，覆盖 12 工位检测/长线装配、14 工位超上限、6/8/10 工位矩阵、`config.stations.length <= form.maxStations`、夹紧后产能结论、缺价文案等。
- 功率/成本核对：`power.totalKw=2.176`、`cost.total=23172`、`missingCount=9` 与 `machine-case.json` 一致；9 个缺价件的 `partId` 与名称已列在 `MACHINE-DESIGN-DEMO.md`。内置价格簿只有 4 条示例价，真实型号均无价格，确认不是匹配 bug；方案卡缺价文案改为「9 项缺价，合计为不完全统计」。

## 功率与成本接入统一模型（2026-10-24，上一轮）

- 状态：✅ 完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1509/1509**（较上轮 +30）、`npm run smoke` 新增 `SMOKE_MACHINE_POWER_OK kw=1.092 a=1.844 breaker=6` 与 `SMOKE_MACHINE_COST_OK total=10614 missing=8`；未 commit、未 push、未打包。
- 功率：新增 `desktop/src/machine/power.ts` 纯函数，删除 `synth.ts` 中写死的 `POWER_VA` 表。优先读取元件库 `ratedW`（伺服/电源/安全光栅等），缺失时按类别默认值估算并逐条写 warning 与 assumption；支持 `Ks=0.7 / Kf=0.6 / η=0.9 / cosφ=0.9`、单相/三相/24V 电流、断路器取档（6–63 A）、24V 电源余量（>70% 告警）与已选总进线断路器交叉校验（超流/余量 >60% 可降档）。
- 成本：新增 `desktop/src/machine/cost-model.ts`，按机械件/电气件/人工分项；价格优先级为「企业价格簿 → 元件库参考价」，缺价行标 `missing` 且不计入合计；伺服按「驱动器 + 电机」成对补齐；人工按工位数 × 默认 18 h/工位 × 形态系数 × 120 元/h 估算。边界明确为方案阶段粗估，不替代 `cost/engine.ts` 正式报价。
- 参数：`<userData>/machine-pricing.json` 支持同时系数、负载率、效率、`cosφ`、工时单价与每工位工时；文件缺失/字段非法逐项回落默认值并写入 assumptions。
- 接入：`synthMachine` 返回 `power/cost`；`design_machine` 在 BOM 映射后复算功率与成本；方案卡显示 kW/A/断路器建议/24V 余量与材料/电气/人工/合计/缺价数，并合并展示设计、功率、成本 warnings；`apply_machine_design` 落盘同时校验新字段。
- 案例：`npm run build:machine-case` 重算六工位双轨案例为 `2.176 kW / 2417.79 VA / 3.673 A / 6 A 3P / 24V 余量 79.2%`；成本 `材料 5136 / 电气 2484 / 人工 15552 / 合计 23172 / 缺价 9`。人工明细 6 工位 × 18 h × 1.2 × 120 = 15552 元（129.6 h）。
- 测试：新增 `desktop/test/machine/power-cost.test.mjs`（29 条），覆盖单/三相电流公式、系数与效率影响、`cosφ`、断路器取档、24V 余量、缺额定功率、成本分项/缺价/伺服成对/工时随工位变化、参数文件缺失与非法回落、方案卡字段、两类交叉校验 warning，以及 `design_machine` 结果超过通用 10 KB 时仍完整保留给方案卡；`demo-doc.test.mjs` 增加功率/成本数字与案例 JSON 的一致性断言。
- 文档：`MACHINE-DESIGN.md` 新增「功率与成本模型」公式、默认系数、参数文件与适用范围/不适用场景；`MACHINE-DESIGN-DEMO.md` 功率/成本两节按新数字重写；根 `README.md`、`desktop/README.md` 同步测试数与 smoke 证据。

## 形态库扩展（一）：新增 5 种机架 + 几何生成（2026-10-24，本轮）

- 状态：✅ 完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1479/1479**、`npm run smoke` 更新 `SMOKE_MACHINE_FORMS_OK forms=11 picked=dual-lane meets=1`；未 push、未打包、未触发 CI。
- 形态：`forms.ts` 在原有 6 种上新增 `gantry-4`（parallel，4 独立龙门头）、`hybrid-dial-linear`（cell，4 转盘 + 2 直线）、`cell-4`（cell，2×2）、`linear-12`（linear，8–12）、`dial-12`（dial，8–12）；每种含 `suits / rationale / footprintScale / transferSeconds / indexSeconds / geometry`，占地系数在同布局内随工位数单调增长。
- 几何：`geometry.ts` 新增 `gantry` 多头矩阵、`hybrid`（转盘 + 沿 X 直线段拼接、转接滑台）、`cell`（rows×cols 矩阵）三类生成；三种新布局均有机架、工位底板/门架/治具与安全围栏。转盘直径按 `max(Ø560, n×140)` 随工位数增长，12 工位 Ø1680 > 4 工位 Ø560。`chooseLayout` 规则未改。
- 测试：新增 `desktop/test/machine/forms-expansion.test.mjs`（27 条），覆盖 11 种形态字段与 range、几何 kind、转盘直径单调、龙门 heads 排布、hybrid 拼接尺寸、cell 矩阵、占地系数单调和 8 条选型回归；同步更新原 `forms.test.mjs` / `form-priority.test.mjs` 的 6 → 11 断言。
- 文档：`MACHINE-DESIGN.md` 形态表补 5 行与几何示意说明；README / MODULES 能力数字与 smoke 口径同步。

## 选型优先级修正：产能优先 + 案例数字一致性（2026-10-24，本轮）

- 状态：✅ 修复完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1452/1452**、`npm run smoke` 更新 `SMOKE_MACHINE_FORMS_OK forms=6 picked=dual-lane meets=1`、`npm run eval:agent` **1.00**；未 push、未打包、未触发 CI。
- 缺陷：`pickForm` 先把候选按布局意图（单一工艺默认 `parallel`）过滤，导致覆盖 6 工位且可双轨达标的 `dual-lane`（`cell`）被排除，最后回退到不达标的 `dial-6`。复现命令（在 `desktop/` 下）：
  ```bash
  node --experimental-strip-types -e "import('./src/machine/spec.ts').then(async s=>{const y=await import('./src/machine/synth.ts');const d=y.synthMachine(s.parseMachineBrief('六工位锁螺丝机，节拍 20 件/分钟'));console.log(d.form.id, d.form.layout, d.cycle.throughputPerMin, d.cycle.meetsTarget)})"
  ```
  修复前：`dial-6 dial 14.29 false`（显式 12 执行机构案例为 `dial-6 dial 15.87 false`）；修复后：`dual-lane cell 28.57 true`（案例 JSON 为 `31.75 true`）。
- 修复：`forms.ts` 候选排序改为硬约束顺序「工位覆盖 → 产能达标 → 工艺适配 → 布局偏好（仅 tie-breaker）→ 占地系数 → 推荐工位距离」；无覆盖达标形态时先取达标且工位最近，仍不达标才取工位最近，并输出「需要 X 件/分钟，最佳形态 Y 只能给 Z 件/分钟，差 W」。`flow.ts` 的 `cell` 增加 `lanes`，双轨节拍按 `(最慢工位 + transferSeconds) / lanes` 计算；`synth.ts` 把 `form.geometry.lanes` 传入 FlowModel。
- 案例与文档：`npm run build:machine-case` 重算为 `dual-lane / cell / 3.18 s / 2 轨 / 31.75 件/分钟 / meetsTarget=true / 余量 1.59× / 需 6 工位`；`MACHINE-DESIGN-DEMO.md` 的「整机形态选型」「节拍计算」「已知风险」「数字来源索引」全部改为 JSON 实际值，删除旧 `dial-6 / 15.87 / 113.21` 数字。
- 防漂移：新增 `test/machine/demo-doc.test.mjs`，校验文档中的形态 id/name、两位小数产能、`meetsTarget`、BOM 行数与 `machine-case.json` 一致；人为改错产能或删 BOM 行会失败并提示「先重跑 build:machine-case 再更新文档」。新增 `test/machine/form-priority.test.mjs` 覆盖 4/6/8 工位 × 10/20/40 件/分钟、布局 tie-breaker、工艺优先、fallback 顺序、双轨 cell 与无达标 warning。

## 整机形态选型一致性修复（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1426/1426**（较上轮 +18）、`npm run smoke` 更新 `SMOKE_MACHINE_FORMS_OK forms=6 picked=dial-6`、`npm run eval:agent` **1.00**；未 push。
- 缺陷：第 37 轮形态库把 `gantry-2` 的 `stationRange` 写成 1–6，选型器又让布局/得分压过工位数，导致双工位龙门承接 3/6 工位需求。复现命令（在 `desktop/` 下）：
  ```bash
  node --experimental-strip-types -e "import('./src/machine/spec.ts').then(async s=>{const y=await import('./src/machine/synth.ts'); for (const t of ['六工位锁螺丝机，节拍 20 件/分钟','三工位点胶机，节拍 15 件/分钟','四工位装配线，节拍 12 件/分钟']) {const d=y.synthMachine(s.parseMachineBrief(t)); console.log(t.slice(0,20), d.form.id, d.config.stations.length)}})"
  ```
  修复前输出：三工位、六工位均 `gantry-2`；修复后：`dial-6 / dial-6 / linear-4`。
- 修复：`forms.ts` 改为 `minStations + defaultStations + maxStations` 单一来源推导 `stationRange`，六个形态区间收敛为 `gantry-2 [1,2] / dial-6 [2,6] / dial-8 [6,8] / linear-4 [2,4] / linear-8 [5,8] / dual-lane [4,6]`；加载期 `assertMachineFormsConsistent()` 校验 `stationRange[0] <= defaultStations <= stationRange[1]`，越界直接抛错。
- 选型：`pickForm` 先按工位数硬筛，再按工艺适配 → 节拍达标 → 占地系数最小 → 推荐工位数最接近排序；布局意图只在覆盖工位数的候选内生效。无覆盖时取区间最接近形态并输出「该形态支持 X–Y 工位，需求 N 工位，已按 X/Y 生成，请确认是否需要非标设计」。
- 一致性：`design_machine.form` 增加 `stationRange/defaultStations`；`build-machine-case.mjs` 把 `design.form` 写入 `machine-case.json`；`apply_machine_design` 落盘的 machine json 保存 `form.id/stationRange/defaultStations`，`readStoredMachineDesign` 重载后可复现 `dial-6`。
- 后果说明：六工位案例因形态改为 `dial-6`，产能模型从 `parallel 113.21` 变为 `dial 15.87` 件/分钟；20 件/分钟目标不再达标，案例与文档保留真实缺口 warning，不硬凑达标。
- 文档：`MACHINE-DESIGN.md` 形态表补 `defaultStations/maxStations` 与选型优先级；`MACHINE-DESIGN-DEMO.md` 写明本案例选中 `dial-6` 的理由与重算结果。


## 软件整体优化（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1408/1408**（较上轮 +30）、`npm run smoke` 新增 `SMOKE_PERF_OK parts=1000 buildMs=22.4 tickMs=0.092` 与新 `SMOKE_DIAGNOSE_OK fields=app,webgl,userDataPath,dataPack,kb,audit,recentErrors errors=2`、`npm run eval:agent` **1.00**；未 commit、未 push、未打包。
- 实测：见 [PERF.md](PERF.md)，原始数据 [PERF-before.json](PERF-before.json) / [PERF-after.json](PERF-after.json)。3000 件场景构建 `184.63 → 42.34 ms`、tick `1.5007 → 0.6755 ms`、堆峰值 `60.72 → 38.52 MB`；1000 件场景构建 `73.69 → 15.09 ms`。

### 已优化项

1. **几何缓存**：`generateMachineGeometry` 增加 16 项 LRU（config + process + layout + form layout 为键），同内容克隆也命中；`bypassCache` 仅供诊断；3000 件热构建 8.96 → 0.85 ms。
2. **场景资源共享**：`buildThreeMachine` 按形状/材质键复用 BufferGeometry 与 MeshStandardMaterial；3000 件材质 3000 → 410，场景构建 -77.1%。
3. **静态矩阵冻结 + 增量变换**：非运动节点 `matrixAutoUpdate=false`；`applyAxisValue` 相同值跳过并返回 `false`，只写 mover/jaw；`Commission3DStats.transformUpdates` 可观测有效写入次数。
4. **运动/传感器降频**：`MachineMotion.advance` 只推进 active 执行机构；传感器只在状态变化时重绘。
5. **大输入保护**：BOM > 5,000 行、STEP > 200 MB、其它 CAD > 50 MB 在读取/追加前拒绝，错误码 `STEP_TOO_LARGE` / `FILE_TOO_LARGE` / `BOM_TOO_MANY_ROWS`，中文提示给出拆分/轻量化动作。
6. **幂等写盘**：`apply_machine_design` 用不含 `appliedAt` 的稳定内容 hash 判重；同参数重复执行返回 `idempotent:true`，不重写方案/active/BOM，BOM 批次 id 改内容 hash，重复追加返回 0。
7. **资源释放**：`disposeThreeMachine`、`CommissionScene3D.dispose`、`FactoryManager.dispose`、`PlcManager.dispose`、`disposeIpcRuntime` 与 `before-quit` 接通；PLC/工厂/Parametric 的 timer 走显式计数。
8. **catch 审计**：静默返回空值的 catch 补齐 `recordDiagnosticError` 或带 `site`/`code` 的 `console.warn/debug`；UI 分支保留中文可操作提示。源码中仅注释、无处理的 catch 清零。
9. **诊断**：`--diagnose` / `npm run diagnose` 输出环境、WebGL、userData、数据包版本、KB 条数、审计大小与最近 20 条错误；未捕获异常写 `userData/diagnostics/last-crash.json`，字段固定且脱敏。
10. **启动路径**：smoke 的 three.js 性能 workload 改为动态加载，普通桌面启动不再静态引入几何生成器与 three.js。

### 未优化项（及原因）

- **GPU / WebGL 帧率**：headless 无 GPU，本机 `--diagnose` 也显示 WebGL blocklisted；缺 Windows 实机数据，贸然改 draw call / instancing 无法用当前基线验证。
- **LRU 按条数不按字节**：实现简单、可预测；3000 件几何仍可能占数十 MB，等出现多机型频繁切换的真实用户样本后再做字节预算。
- **tick 仍遍历全部执行机构**：3000 件 P95 0.91 ms，已远低于 16.7 ms 帧预算；引入脏集合会增加状态同步复杂度，收益不足以覆盖风险。
- **BOM 5,000 行只覆盖渲染层追加与 BOM 导入**：CSV/XLSX 批量导入路径尚未统一接入同一限流函数，需先确认导入入口的现有分批策略。
- **审计文件损坏行只告警跳过**：保留 AI 可读性优先，未做自动隔离/上报；`last-crash.json` 也不做自动上传，避免未授权外传。
- **崩溃报告仅覆盖主进程未捕获异常/未处理拒绝/子进程退出**：渲染进程崩溃已记录，但 GPU 进程 OOM、原生扩展崩溃仍依赖 Electron 自身日志。

## 整机形态库（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1378/1378**（+28：`forms.test.mjs` 25 + apply 落盘 3）、smoke 新增 `SMOKE_MACHINE_FORMS_OK forms=6 picked=dial-6`、`npm run eval:agent` **1.00**（106 条，新增 4 条同工艺换布局用例）；未 push、未打包、未触发 CI。
- 数据：新增 `desktop/src/machine/forms.ts`，6 种形态 `dial-6 / dial-8 / linear-4 / linear-8 / gantry-2 / dual-lane`；纯数据字段含 `layout / stationRange / indexSeconds / transferSeconds / footprintScale / suits / rationale / geometry`，`validateMachineForms()` 校验布局与 flow 对齐、工位区间、几何映射与 id 唯一。
- 选型：`pickForm(brief, templates)` 先按布局意图 + 工艺适配筛候选，再用 `evaluateFlow` 在工位范围内预演；达标者优先、工位范围小者优先；无匹配时回退最近形态并给 warning（工位超出/产能缺口），不硬凑达标；固定返回 2 条备选，差异文案覆盖占地、成本、换型。
- 接入：`synthMachine` 先选形态，按 `form.layout` 与 `form.indexSeconds/transferSeconds` 构造 FlowModel；`design_machine` 返回 `design.form` 并在方案卡显示形态名/理由/备选；`generateMachineGeometry` 优先用 `form.geometry.kind`（dial/linear/gantry/dual），1 工位回退 single；`apply_machine_design` 把 `form.id` 与几何写进 machine json，3D 刷新同时传 layout。
- 文档：`MACHINE-DESIGN.md` 新增「整机形态库」表与选型规则；`MACHINE-DESIGN-DEMO.md` 增加「同一需求的两种形态对比」；README / MODULES 已同步 smoke 与测试数。

## 通用产能引擎（feat/flow-engine，2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1350/1350**（+34：`flow.test.mjs` 23 + `flow-archetypes.test.mjs` 6 + `flow-synth.test.mjs` 5）、smoke 新增 `SMOKE_FLOW_ENGINE_OK modes=5 archetypes=6`、`npm run eval:agent` 1.00、`build:machine-case` 重算六工位案例（`parallel` / 3.18 s / 113.21 件/分钟 / 需 2 工位）；未打包、未触发 CI、未发版、不 push。
- 数据模型：新增 `desktop/src/machine/flow.ts` 纯函数 `evaluateFlow`，统一支持 `single / linear / dial / parallel / cell`；公式、默认值（transfer=0、index=0.6、copies=stations）、`optional` 排除、目标反解与中文非法输入错误全部在引擎内，不为单一机型写特例。
- 对接：`synthMachine` 只把 brief/模板/工位映射为 `FlowModel`，`MachineCycleEstimate.mode` 改为 `MachineLayout`，旧字段保留；`chooseLayout` 与几何层共用 dial 工艺集合/上限，`cell` 仅显式指定；`layout:'auto'` 的推断写入 `assumptions`。
- 回归：6 个机型覆盖 5 种布局（六工位并行锁螺丝、转盘点胶、5 工位直线、单工位检测、2×2 单元、2 副本并行点胶），每个机型断言 mode/cycle/throughput/meetsTarget/requiredStations/瓶颈工位。
- 文档：`MACHINE-DESIGN.md` 新增五种布局公式表、字段、默认值与适用边界；`MACHINE-DESIGN-DEMO.md` 标注本案例为 `parallel` 实例；README 能力表与 KB 已同步。
- KB：为留出 ≥5% 余量，将上一轮「并行三条」及已完成 P8/P9/P10 记录原文移入 `BACKLOG-HISTORY.md`（不进入索引）。

## 并行三条：Agent 打磨 / 主视口 3D 收尾 / 元件库补录（integ/next，2026-10-24，本轮）

### Agent 打磨：审计轮转 + 路由同义词 + MT04 离线回归（feat/agent-audit-router，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` 全绿（集成后 **1297/1297**；本条 +22：路由同义词 7、审计轮转 11、MT04 4）、`build:ext`、smoke `SMOKE_OK`（新增 `SMOKE_AGENT_AUDIT_ROTATED_OK rows=3 files=2`）、`npm run eval:agent` **102/102**（+27 条 `sy01`–`sy27`，各指标 1.00）、`npm run agent:report` 已更新；未打包、未触发 CI、未发版、未 push。
- 审计（已知问题 9）：新增 `src/agent/audit-store.ts`，按大小轮转 `agent-audit.N.jsonl` + 保留期整份清理，默认 5 MB × 5 份 × 90 天，`userData/agent-audit-retention.json` 可调；面板/`agent:audit:read` 与 Agent 报告读取全部保留份数，脱敏与坏行跳过不变；轮转失败只回调、继续写入。
- 路由（已知问题 9）：查询/计算/修改/生成与各工具触发补同义/口语词（意图关键词与工具正则同步），新增非工程话题拦截 `isOffDomainTopic`；轮转后的审计文件名与新增同义写动词同样触发审计篡改/危险路径拒绝。
- MT04（已知问题 10）：本机无 `AGENT_LIVE_*` 环境变量、无 userData 模型配置，**未跑真实模型、未改 `agent-multiturn.json`**（现有 JSON 已是修复后 6/6，问题 10 原描述已过时并已标注）；只补会话层确定性单测证明拒绝记忆生效。

### 主视口 3D 收尾：编辑撤销/重做 + 工程持久化 + WebGL 框选（feat/orbit-undo，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1273/1273**（+25：合成时间线 14、存储 6、框选投影 4、多选选择集 1）、`build:ext`、smoke 全绿（新增 `SMOKE_ORBIT_UNDO_OK` / `SMOKE_ORBIT_MULTI_OK` / `SMOKE_ORBIT_PERSIST_OK`）；手动 `check:orbit-webgl` 新增 `ORBIT_WEBGL_MARQUEE_OK`（无 xvfb 可用 `--ozone-platform=headless` 跑）；原型文件零改动，未打包、未触发 CI、未发版、不 push。
- 撤销：原型 `pushHistory` 不导出，3D 编辑自建栈（覆盖表前后快照），与原型栈按发生顺序合成一条令牌时间线；Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 与状态栏按钮先过扩展，栈顶是 3D 就自己撤，是原型动作就放行。从状态栏「撤销 N / 重做 M」+ 按钮提示对账，Agent `undo_last` / `ProtoApi.undo()` 直接撤原型也能跟上。同字段 800 ms 合并、上限 50，与原型一致；任一侧新动作作废全部重做。
- 持久化：内置零件覆盖写 localStorage `automationcad.orbit.v1`（与底板画布同机制，userData 内），启动先恢复；坏数据整体丢弃并给原因。插入件覆盖不存（原型不持久化插入件）。
- 框选：WebGL 模式 Shift+左键拖拽 / 工具条「框选」粘滞模式；命中规则同原型（屏幕矩形相交），经合成拖拽写回原型 `state.multi`，高亮、「已选中 N 个对象」、点选替换、Esc 全部沿用原型；降级模式行为不变。
- 边界：见 `desktop/src/orbit/MODULE.md`「坑点」4–5 与「待办」。

### 元件库补录安全光栅 + 缺尺寸（feat/lib-safety-dims，2026-10-24）

- 安全光栅：`iec-cn` 新增 8 条 Type 4 安全光栅（欧姆龙 F3SG-SR 14/25 mm、西克 deTec4 Core 14/30 mm 发送器/接收器、邦纳 EZ-SCREEN SLS 14/30 mm），每条 `specs.数据来源` 记官方样本/数据表 URL，`dims.source` 记外形图出处；无官方价，未填价格。另给已有 F3SG-4SRA0400-14 与 C4C 450 mm 一对补响应时间与官方尺寸。manifest 1.2.0（379 条/36 家）。
- 六工位案例（P10-4）：`bom-map` 安全光栅初选 `F3SG-4SRA0640-14`（14 mm / 640 mm / PL e，OSSD 接 PNOZ s3），BOM 12 行全部为真实型号；新增 `notices` 提示按 ISO 13855 核算安全距离；元件包缺该型号时仍退回「待选型」并写原因。`machine-case.json` 已按脚本重生成；4 张机型截图沙箱无 xvfb 未重拍（文档已注明），`screenshots:machine` 校验改为要求 BOM 含该型号且无「待选型」。
- 缺尺寸：第二批 22 条全部取厂商官方逐型号尺寸（无推定）：安全光栅 11 条（新增 8 + 既有 3）+ `backfill-dims.mjs` 的 `FILL_BATCH2` 11 条（倍加福/西克/图尔克/西门子/台达/菲尼克斯，`dims.source` 含 URL）。覆盖 244/371 → **266/379（70.2%）**，剩余 113 条；DIMS-GAPS.md 统计与清单已更新（标题未改以免触发 kb 重建）。
- 验证：`tsc` 干净、`TZ=Asia/Shanghai npm test` **1250/1250**（+2）、`build:ext`、smoke `SMOKE_OK`；不 push、不打包。

### P8 设计完成后自动生成 PLC 程序
- 状态：🔄 P8-1 / P8-2 / P8-3 / P8-4 ✅ 已完成；P8-5 可选
- 范围：预检（地址重复/越界/双线圈/安全缺失）→ IO 变量表 + ST 程序块（OB1/气缸 FB/夹爪/轴/自动状态机/报警/安全）→ 导出 zip 与映射表
- 分期：P8-1 预检+变量表+FB → P8-2 序列/报警/安全 → P8-3 UI 与导出 → P8-4 模拟器自检 → P8-5 TIA Openness（可选）
- 验收：demo 机型（补齐安全件）11 文件、预检 0 错、重复生成 sha256 一致；内置模拟器 6 步跑通、0 报警
- 已完成（P8-1）：`src/plcgen/precheck.ts`（预检各规则全量返回）、`tags.ts`（I/Q 顺序分配 + UTF-8 BOM CSV）、`st.ts`（`FB_Cylinder/FB_Gripper/FB_RotaryAxis/DB_IO/OB1_Main` 五文件 + `inputHash`）；无 UI
- 实测（P8-1）：`npm test` **505/505**（新增 35 条 plcgen 用例）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`
- P8-1 边界：首期五文件；自动序列/报警/安全 FC 留给 P8-2，生成 UI/zip 留给 P8-3，模拟器联调自检留给 P8-4；demo 配置本身未带安全点位，预检演示需补 `safety.emergencyStop/safetyDoor`
- 已完成（P8-2）：`sequence.ts`（步序 → `FC_AutoSequence` CASE 状态机、AND/OR 条件、5 s 缺省超时、超时报警、Abort/SafeStop 回 Step0）、`safety.ts`（急停/安全门常闭串联、SafeStop 锁存与 Reset 上升沿复位、缺点位只写注释）、`alarms.ts`（超时/传感器矛盾/安全触发统一 `AlarmWord` + `FirstFault` 首故障锁存）、`generate.ts`（预检拦截 + 固定 11 文件 + `mapping.json` + README + 逐文件 SHA-256）、`symbols.ts`（点位/地址/变量名映射）
- 实测（P8-2）：`npm test` **556/556**（新增 `plcgen-p82.test.ts` 32 条）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_OK`；同输入两次生成 11 文件 sha256 全一致
- P8-2 边界：生成 UI、zip 导出、历史记录留给 P8-3；模拟器加载生成程序跑联调序列留给 P8-4；仍不生成厂商专有工程文件
- 已完成（P8-3）：`src/plcgen/ui.ts` 电气域顶栏「PLC 程序」全屏面板（机型规模、目标平台/命名前缀、错误/警告预检表与机构定位、文件树 + 前 200 行预览、导出 zip/复制全部/打开目录）；`view-model.ts` 纯函数（文件树/预览/按钮禁用/问题定位）；`history.ts` 最近 10 次按 inputHash 去重并可回看文件清单；`export.ts` 目录命名；`src/shared/{filename,zip}.ts` 复用文件名净化与 adm-zip 写入；IPC `plcgen:history|recordHistory|export|openExportDir`
- 实测（P8-3）：`npm test` **577/577**（新增 `plcgen-p83.test.ts` 21 条：纯 JS SHA-256、文件树、预览截断、历史去重/上限、目录命名、ZIP 结构与 CRC + `unzip -t`、路径穿越、预检禁用、目标平台不影响 ST）；`npm run smoke` → `SMOKE_PLCGEN_UI_OK files=11 history=1`
- P8-3 边界：历史只保存文件清单不保存正文；仍不生成厂商专有工程文件
- 已完成（P8-4）：`simulate.ts`（mapping 输出映射、执行机构行程时间、生成 timeoutMs、SafeStop、传感器矛盾、虚拟时钟与 timeScale）、`verify.ts`（预检 → 生成 → 模拟，`summarizeVerification` 窄摘要）、Agent 只读工具 `verify_plc_program`、面板「模拟验证」入口
- 实测（P8-4）：`npm test` **619/619**（新增 `plcgen-p84.test.ts` 21 条）；`npm run smoke` → `SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`、`SMOKE_AGENT_TOOLS_OK tools=12 implemented=12`
- P8-4 边界：模拟器只执行生成程序的动作/等待/超时/安全/传感器语义，不解析任意 ST；仍不生成厂商专有工程文件

### P9 参数化建模（build123d 内核）
- 状态：🔄 P9-1 / P9-2 / P9-3 / P9-5 已完成；P9-4 草图约束前置调研完成，实施待排期
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 ✅ sidecar+契约（`spike/build123d/app.py`）→ P9-2 ✅ 主进程生命周期/IPC（`9eda660`，388/388、`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`）→ P9-3 ✅ 特征树 UI / 参数编辑 / 防抖重建 / STEP+STL 导出 → P9-4 ⏳ 草图约束（前置调研完成）→ P9-5 ✅ 多实体装配 + BOM/成本联动
- 已完成（P9-3）：`src/parametric/model.ts`（编辑/防抖/分桶/序列化/包围盒，18 条单测）、`src/parametric/ui.ts`（与运动学二选一的抽屉、按类型参数表单、校验失败禁重建）、`cad/viewer.ts`（STL 载入 + 旧模型幽灵层 + 特征包围盒高亮）、`extension.ts` 挂载与 `AutomationCadParametric` 调试入口；`localStorage: automationcad.parametric.v1` 按 `sourceFile` 分桶（无来源 `untitled`）；JSON 保存走 `desktop.exportFile`
- 实测（P9-3）：`npm test` **524/524**；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 坑：假内核脚本不能放 `test/` 下（`node --test` 会把 `test/fixtures/*.mjs` 也当测试跑，挂 276 s），已移到 `desktop/scripts/fake-parametric-sidecar.mjs`
- 验收：P9-2 `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`；P9-3 `SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 已完成（P9-5）：`features.ts` 增加 `PartInstance/AssemblyDoc`、旧文档自动包装、实体级校验与 `compileOps` 双形态；`bom.ts` 合并 partId/未映射名称并生成 UTF-8 BOM CSV 与成本入参；`ui.ts` 装配实体区、BOM 预览、导出 BOM/送成本；`app.py` 可选 `instances`，独立建模后按 X/Y/Z/RZ 放置并合并，返回 `stats.solids` 与每实体体积；假内核支持两实体 smoke
- 实测（P9-5）：`npm test` **647/647**（新增 `parametric-assembly.test.ts` 25 条 + sidecar 装配 3 条）；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`
- P9-5 边界：BOM 只按实体汇总、不拆特征明细；`partId` 需人工填写；装配为静态多实体合并，不做配合约束/自由度求解（P9-4）
- P9-4 前置调研（2026-10-23）：推荐 `@salusoft89/planegcs@1.3.0`（LGPL-2.1、WASM、Node 可跑）；矩形 + 水平/竖直 + 宽 120 / 高 80 实测 `Success`、`dof=0`、残差 0，热求解中位数 0.30 ms，安装增量 878 KiB；jsketcher 因自定义许可要求修改回授且无 npm 包不推荐；顶点 → build123d `Polyline` → `extrude` 实跑体积 76,800 mm³。详见 [SKETCH-SPIKE.md](SKETCH-SPIKE.md)。本轮不接入产品代码

### P10 产品截图更新（2026-10-23）
- 状态：✅ 已完成
- 内容：新增 `--headless-screenshots` 分支与 `npm run screenshots`（`desktop/scripts/capture-screenshots.mjs`）：xvfb 启真实 Electron，`BrowserWindow.setContentSize(1600,1000)` 后用 `webContents.capturePage()` 抓图；参数化面板由 `AUTOMATIONCAD_PARAMETRIC_CMD=desktop/scripts/fake-parametric-sidecar.mjs` 驱动。
- 新增截图（均为真实 Electron 实跑，非设计稿）：`11-plcgen` / `12-parametric` / `13-cost` / `14-enclosure`.png，内容说明见 `MODULES.md` 截图目录。
- 验图：四张均为 1600×1000，PIL 统计颜色数 3,192–6,508、RGB stddev 均 > 14，非单色/空白。
- 说明：xvfb 下 Chromium 把 WebGL 列入 blocklist，CAD 3D 视口显示解析统计降级面板；参数化抽屉与 PLC/成本/底板面板均为真实 DOM/SVG 渲染并已截图，无跳过项。
- 验收：`npm test`、`npm run smoke` 全绿；README 界面一览与图注、`docs/desktop/MODULES.md` 截图索引已同步。


## 知识库容量治理 + Agent 工具 `suggest_kinematics`（integ/3d-all，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1248/1248**（+10：工具 9 + KB 余量守卫 1；+1：STEP 旧分块清理与近似件透出）、`build:ext`、smoke 全绿（新增 `SMOKE_AGENT_KINEMATICS_OK high=4 low=1 written=0`）、`npm run eval:agent` 75/75；未打包、未触发 CI、未发版。
- KB：根因是 BACKLOG 迭代记录持续增长、整份进索引。改为本文件只留最近一轮，早于本轮的 20 节原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不在 `KB_DOC_FILES`）；`kb.json` 从约 408 KB 降到约 363 KB，未截断、上限不变。`kb.test.mjs` 新增守卫：归档不入索引、索引须留 ≥5% 余量（约 20 KB），超了提示继续归档。
- 工具：只读 `suggest_kinematics`（命令 `suggest_kinematics` → 渲染桥 `suggestKinematics` → 标注抽屉 `suggest()`），参数 `includeLow? / limit?(1–30)`，返回压缩后的高/低置信度建议（轴向 ±X/Y/Z、行程或角度、行程来源、型号、工位、点位、置信度、中文理由），`applied=false`；**从不写入标注**，采纳仍由用户在抽屉逐条确认并保存。已接入路由（「识别/找出…运动件」）、MCP/RPC（21 个工具）、评估集 `kin01`、Agent 报告。
- 边界：未导入模型时返回提示先 `import_cad`；建议本身的识别边界同迭代 36。
- 合并前复查修正（`192983e`）：① `solids/` 里上一次遗留的 `part-N.step` 现在先入撤销快照再清掉，避免旧分块混进本次整机（撤销可恢复）；② STEP 实体化把水平圆柱按等截面方棒近似时，写中文 warning 点名零件并在 `geometry.approximatedIds` 透出 id 列表，不再只给数量；③ `apply-machine-geometry.test.mjs` 新增 1 条覆盖这两条。

## 集成：34/35/36 三条 3D 分支合并 + 同步 main（P10-4 六工位案例）（integ/3d-all，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1237/1237**、`build:ext`、`smoke` 全绿（含 `SMOKE_MACHINE_GEOMETRY_OK` / `SMOKE_ORBIT_VIEW_OK` / `SMOKE_KINEMATICS_AUTO_OK`，各分支冒烟块全部保留）；不 push。
- 互不干扰：主视口 3D 只挂原型 `#stageAssembly/#scene3d`、`#stageCheck/#sceneCheck` 与 `window.AutomationCadOrbit`；联调 3D 在联调抽屉内自建 `commission-3d-canvas`，入口 `__Commission3D`；运动学建议走 `AutomationCadKinematics`。
- KB：合并后超 400 KB 上限；先精简本文件冗余记录过渡，本轮已改为历史归档根治。

## 六工位锁螺丝机完整案例 + 全流程真实截图（P10-4，2026-10-24）

- 状态：✅ 完成；新增 9 条案例断言，`npm run screenshots:machine` 4 张图（15–18）像素校验通过；不 push。
- 内容：真实解析/合成六工位案例（6 工位 / 12 执行机构 / 7 传感器 / 19 点位）、真实型号 BOM（11 行真实 + 1 行待选型）、离线桩驱动的全流程截图；细节与复现见 [MACHINE-DESIGN-DEMO.md](MACHINE-DESIGN-DEMO.md)。
- 边界：节拍估算 3.18 秒/件未达 3.00 目标（需约 12 总工位）；安全光栅无库内型号；3D 为配置驱动示意。

## 运动学自动识别建议（36-auto-kinematics，2026-10-24）

- 状态：✅ 完成；新增 34 条测试（`test/cad/kinematics-auto.test.mjs`，含合成 STEP 夹具端到端），smoke 新增 `SMOKE_KINEMATICS_AUTO_OK high=4 low=1 accepted=1 autoApplied=0`。
- 内容：`desktop/src/cad/kinematics-auto.ts` 按名称/型号、装配层级、几何（PCA 主轴、同轴、回转体、骑轨）推测动件的轴向/行程/置信度/中文理由与 IO 建议；标注抽屉逐条「采纳 / 忽略」，**从不自动写入**，schema 未改。细节见 `desktop/src/cad/MODULE.md`。
- 边界：纯启发式，命名不规范且几何不典型识别不到；子装配压平会丢型号；只支持 ±X/±Y/±Z；夹爪只给一根手指；Agent 工具 `suggest_kinematics` 已在本轮补上。

## 主视口可旋转 3D：轨道视图 + 属性编辑改几何（35-orbit-view，2026-10-24）

- 状态：✅ 完成；新增 38 条测试（`test/orbit/`），smoke 新增 `SMOKE_ORBIT_VIEW_OK mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`；WebGL 路径用 `npm run check:orbit-webgl`（swiftshader，手动）验证。
- 内容：注入扩展 `desktop/src/orbit/` 把原型装配/干涉视口换成可旋转 three.js（原型三文件零改动）：轨道/缩放/平移、标准视向、透视↔正交、适合、剖切、树↔3D 双向选择、缸径/行程与桌面版几何参数实时改几何、干涉 AABB 初筛；无 WebGL 回退原型 SVG。细节见 `desktop/src/orbit/MODULE.md`。
- 边界：示意体非 1:1、无 B-rep/配合求解；桌面版几何参数不进撤销栈、不持久化；WebGL 模式无框选；真实显卡帧率未实测。

## 迭代 34：机型方案生成真实三维几何（34-machine-geometry，2026-10-24）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1156/1156**（1132 + 24；沙箱默认 UTC 需 `TZ=Asia/Shanghai`，否则 `cost-export.test.ts` 两条既有时间断言失败，与本轮无关）、`npm run smoke`（xvfb-run）新增 `SMOKE_MACHINE_GEOMETRY_OK layout=dial parts=58 axes=6 envelope=1490x1300x1177 chunks=2 scene=58`、`SMOKE_OK`；`SMOKE_PARAMETRIC_SIDECAR_SKIP`（无 Python）；不 push。
- 内容：纯函数 `machine/geometry.ts` 生成 mm 级整机（机架、底板 + 门架、气缸缩回位、夹爪张开位、旋转台、传感器、光栅、输送线/分度转盘）与运动轴元数据；`geometry-export.ts` 出 STL / glTF / build123d `AssemblyDoc` 分块与实体化回退；`geometry-three.ts` 接入 `createScene3D` 替换占位方块；`apply_machine_design` 新增 `withGeometry`（默认 true）/ `withSolids`，`design_machine` 返回几何摘要；单测 24 条；文档同步，`kb:build` 重建。
- 边界：标准件外形，不做强度/干涉/选型，无紧固件/钣金/气路/电柜与上下料机构；转盘分度、输送线驱动未接点位；STEP 只经 sidecar，水平圆柱为等截面方棒；xvfb 下 WebGL 被 blocklist，冒烟只证场景构建与零件数一致，需 Windows 实机目测。

## 自然语言设计机器（三）：工艺模板 + 追问策略 + 真实模型评测（P10-3，2026-10-24）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1132/1132**（1110 + 新增 22）、`npm run smoke` 新增 `SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`、`npm run eval:agent` **74/74（1.00）**、`npm run agent:live` **36/36**；不 push。
- A. 工艺模板：新增 `desktop/src/machine/templates.ts`，导出可直接读取的 `TEMPLATES`（5 类）。锁螺丝每工位 1 旋转轴 + 1 夹爪 + 1 接近；点胶 1 旋转轴（三轴模组占位）+ 1 压力；装配 1 压装气缸 + 1 夹爪 + 2 接近；检测 1 旋转轴（相机位占位）+ 1 光电 + 1 安全光栅；包装 1 推料气缸 + 1 吸盘（夹爪）+ 1 光电。每类含 `stations / actuators / sensors / cycleRange / rationale`，未知工艺使用内部通用模板。
- B. 合成器接入：`synthMachine` 缺执行机构/传感器时按模板补全，assumptions 写「按 X 模板补全」；缺工位默认 2、缺节拍默认 10 件/分钟，同时写 warning 与 assumption。
- C. 追问策略：新增 `desktop/src/machine/clarify.ts` 纯函数 `buildClarify(brief)`，只看工艺/工位/节拍，最多 2 项、合并成一个具体问题；有默认值不追问；`design_machine` 返回 `needs` 与 `question`，会话系统提示要求最多追问一次，不答则用默认并说明。
- D. 离线评测：`docs/desktop/eval/cases.json` 新增 6 条（5 类工艺 + 1 条信息不足），74/74，意图/工具/参数/拒绝均 1.00。
- E. 真实评测（报告生成器新增「机型」分组）：`desktop/scripts/agent-live-cases.json` 新增 `machine` 分组 6 条（三工位锁螺丝、两工位点胶 3 秒/件、四工位装配含汇川+安全光栅、信息不足检测机、多轮改 4 工位、直接应用需确认），总数 30 → 36；评测器支持 `history` 多轮前置、`allowClarify`、`hasKey`、`containsAll` 参数检查，并只评判本轮工具调用，阈值不变。本机 `deepseek-v4.1-flash` 最终轮 36/36、confirm/clarify/refusal 均 1.00，p50 7.9 s / p95 31.3 s；机型分组 6/6，p50 23.9 s / p95 37.8 s。两轮复跑中的首轮出现 `O04 [operation/missing-arg]`，第二轮恢复；失败分类保留，未删用例、未降阈值。
- 边界：模板是代码内常量，不是用户可编辑库；追问只保证一次，不持久化未答状态；真实评测仍是单模型结果，换模型需重跑。

## 自然语言设计机器（二）：落盘写工具 + 3D/BOM/PLC 联动（P10-2，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1110/1110**（1084 + 新增 26）、`npm run smoke` 新增 `SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=6 undo=1`、`npm run eval:agent` **68/68（1.00）**；不 push。
- A. 写工具：新增 `apply_machine_design`（工具数 19 → 20，只读 10 + 写 10），schema `{brief?, design?, name?, overwrite?, withBom?, withPlc?}`；`brief` / 完整 `design` 二选一，内部统一走 `validateMachineConfig`；补校验工位/执行机构/传感器 id 唯一、传感器 `part` 引用存在、`design.points` 与配置点位一致；写 `userData/machine/<id>.json` 与 `active.json`，默认同名返回 `FILE_EXISTS`，`overwrite:true` 才覆盖；成功刷新 3D 并进入撤销栈，`undo_last` 恢复上一 active 方案。
- B. BOM/PLC 联动：`withBom` 默认 `true`，把 `bomDraft` 转为 BOM 行（`kind` → 执行机构/传感器/电气，缺型号写「模型待定」，来源 `machine-design`），追加到 BOM 草稿并写 `machine/<id>/bom-draft.csv`；`withPlc` 默认 `false`，复用 `plcgen/io.ts` + `plcgen/tags.ts` 只生成 `exports/plc/<id>/io-map.csv`，不生成完整 ST；两者都在结果返回实际路径。
- C. UI：`design_machine` 结果新增「机型方案卡」（工位数/执行机构/传感器/节拍/功率/全部警告 + 「应用到工程」按钮），警告黄色条不折叠；按钮走计划确认，成功后 3D 切到新机型并显示「已应用：<名称>」；启动时按 `machine:active` 恢复上次方案。
- D. 测试：新增 `desktop/test/agent/apply-machine-design.test.mjs` 26 条，覆盖 brief/design 二选一、缺参、design 校验失败、执行机构 id 重复、点位重复/引用缺失、overwrite 语义、active 指针、撤销恢复、BOM 追加行数与来源、PLC 点位齐全、确认拒绝不落盘、`../` 路径净化；同步更新工具数、MCP/RPC、离线路由与报告断言。
- E. 评测：`docs/desktop/eval/cases.json` 新增 d05/d06/d07 三条机型落盘用例（应用上一轮方案、生成 BOM、生成 PLC 点位映射），离线 68/68，意图/工具/参数/拒绝均为 1.00；`desktop/eval/agent-cases.json` 保持同内容兼容副本。
- 边界：3D 仍是配置驱动示意，不生成真实几何；BOM 型号缺省不猜；PLC 只输出点位映射，不生成厂商工程文件；applied 方案的 active 指针损坏时启动回退内置 4 工位样机。

## 自然语言机型方案合成（P10-1，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1084/1084**（1044 + 新增 40）、`npm run smoke` 新增 `SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1`、`npm run eval:agent` **65/65（1.00）**；不 push。
- A. 需求抽取：新增 `desktop/src/machine/spec.ts` 纯函数 `parseMachineBrief`，支持中文数字工位、`分钟 20 件` / `20 件/分钟` / `3 秒一件` / `CT` 三类节拍、五类工艺、气缸/夹爪/旋转轴/伺服/步进、接近/光电/安全光栅/压力、品牌与 220VAC/380VAC/24VDC；缺省项写 `notes` 标记，不抛错。
- B. 方案合成：新增 `desktop/src/machine/synth.ts` 纯函数 `synthMachine`，输出可直接喂给 `createScene3D` 的 `MachineConfig`、唯一点位（`ST1-EXT-A1` 等）、节拍瓶颈与并行工位建议、固定表功率估算、BOM 草案、warnings 与 assumptions；伺服/步进按旋转轴建模并按 750 VA/轴计功率，不重复计 200 VA 旋转轴。
- C. 工具：新增只读 `design_machine`（工具数 18 → 19，只读 10 + 写 9），schema `{brief, stationCount?, cyclePerMin?}`；空 brief、工位越界/非整数、非正节拍返回 `INVALID_ARGUMENT`；不写文件、不改工程，摘要 ≤600 字。
- D. 路由与评测：`isMachineDesignRequest` 将机型设计识别为 `generate` 并映射到 `design_machine`；`docs/desktop/eval/cases.json` 增加 4 条（锁螺丝/点胶/装配/检测），离线评测 65/65 全绿。
- E. 测试：新增 `test/machine/spec.test.mjs`（14）、`synth.test.mjs`（15）、`test/agent/design-machine.test.mjs`（10），共 39 条；覆盖中文数字、三种节拍写法、品牌、缺省 warning、工位均分、点位唯一、瓶颈、功率求和、BOM、schema、越界、空 brief 与摘要数字。
- 边界：几何仍为配置驱动，功率为固定表估算，节拍未计入上下料/通讯/调试损失；本轮不落盘，写工具与 UI 方案卡留给下一轮。

## Agent 运行报告与可视化（P7-O，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1044/1044**（1034 + 新增 10）、`npm run smoke` 全绿（`SMOKE_OK`）、`npm run agent:report` 产出 md/json/svg 三个非空文件；不 push。
- A. 报告生成：新增 `desktop/scripts/agent-report.mjs` + `npm run agent:report`。读取 `agent-live.json` / `agent-multiturn.json` / `latest.json`，审计取 `<userData>/agent-audit.jsonl`（可用 `AGENT_REPORT_AUDIT_FILE` / `AGENT_REPORT_USER_DATA` 覆盖）；缺源文件写「缺失：<文件>」、打印 WARN、退出码 0。
- B. 输出：`docs/desktop/AGENT-REPORT.md`（总览、查询/操作/流程/拒绝分组、离线指标、多轮场景、能力清单、已知缺口、审计摘要）、`docs/desktop/agent-report.json`（每个指标带 `source` 与 `generatedAt`）、`docs/desktop/agent-report.svg`（纯代码生成，深色底、4 组横向条形图 + 工具/测试/单轮/多轮 KPI）。
- C. 一致性：写盘后立即读回 `agent-report.json` 并与内存对象逐字段比对；`verifyReport` 再逐项核对总览、分组、离线指标是否等于源 JSON。缺源时只降级为「缺失」，不编造数字。
- D. 能力清单：18 个工具 + 13 项平台能力，逐条给出模块文件、验证方式（单测 / smoke / eval）与状态；多轮状态按真实 JSON 显示 `⚠️ 5/6（MT04）`，未把阈值通过写成全绿。
- E. 测试：新增 `desktop/test/agent/report.test.mjs` 10 条，覆盖真实源数字、源变更传导、篡改拦截、缺源降级、Markdown 来源/时间、SVG 数据驱动、BACKLOG 缺口摘取、md/json/svg 文件产出。

## Agent 执行效率：去重 / 并行 / 缓存（P7-N，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1034/1034**（1001 + 新增 33）、`npm run smoke` 新增 `SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`、`npm run eval:agent` 100%（61/61）；`npm run agent:live` 因无凭据 `AGENT_LIVE_SKIP`，未伪造端到端 p50/p95；不 push。
- A. 同轮去重：新增 `desktop/src/agent/dedupe.ts`（纯函数 + 小状态）——`canonicalArgs` 键排序、空白压缩、数字字符串归一；`TurnCallDeduper` 按 `(tool, canonicalArgs)` 复用同轮结果并标 `reused:true`；写工具永不合并；单轮上限默认 12，超出返回 `TOO_MANY_TOOL_CALLS` 并提示拆轮。
- B. 只读并行：新增 `desktop/src/agent/parallel.ts`——`planExecutionBatches` 把连续无依赖只读批并发（默认 3，可配），写工具单独成批形成屏障；`$0` / `${1}` / `{{0.data}}` 等占位符触发依赖降级串行；`runReadOnlyBatch` 固定 worker 池，失败不取消已发出调用，结果按原序返回。
- C. 会话缓存：新增 `desktop/src/agent/cache.ts`——`get_bom` / `get_project_context` / `list_components` 按 `(tool, 规范化参数, projectFingerprint)` 缓存 30 s；只缓存成功结果；写工具执行前后清空；指纹变化删旧条目；不跨会话、不落盘。
- D. 审计 / UI：`AgentAuditRecord.cacheHit` 落 NDJSON；`AgentProgressEvent.cacheHit` 进入进度卡，工具卡与审计行显示「已复用」。
- E. 实测：本机合成桩延迟 100 ms/工具——两次只读分两轮 211 ms → 同响应 102 ms（并发 2）；三次同关键词 303 ms → 102 ms（执行 1 + 复用 2）；两轮 `get_bom` 101+101 ms → 101+2 ms（缓存命中）。真实模型基线仍为 p50 7.6 s / p95 21.3 s，待有凭据后重跑 `agent:live` 更新。
- F. 测试：新增 `desktop/test/agent/efficiency.test.mjs` 31 条，覆盖参数规范化、重复合并、参数差异不合并、写不合并、12 次上限、保序、并发度、依赖降级、写屏障、失败不吞、缓存命中/失效/TTL、指纹变化、跨会话隔离、审计 `cacheHit`。

## Agent 上下文预算与成本可见性（P7-M，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **983/983**（962 + 21）、`npm run smoke` 新增 `SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`、`npm run eval:agent` 通过；不 push。
- A. 预算模型：新增 `desktop/src/agent/budget.ts`（纯函数）——`estimateTokens`（中文 1.6 字符 / token、其他 4 字符 / token，向上取整）、六档 `system / selection / memory / docs / toolResults / history`（默认总量 12k，可配单档上限）、`pack(payload, options)` 返回 `{text, used, dropped, sections, docsSources}`。
- B. 裁剪顺序：单档超限先保留长列表首尾各 5 条 + `total`；总量超限先收敛 docs / toolResults 长列表，再按 `history → docs → toolResults → memory → selection` 丢弃；`system` 永不裁剪（超总量只记 `system_protected`），每条 `dropped` 带中文原因。`session.ts` 用六档装包系统上下文，并按用户轮次成组裁剪模型历史，避免拆散 assistant/tool 协议对。
- C. 成本可见性：`llm.ts` 解析端点 `usage.prompt_tokens / completion_tokens`；缺失时会话按消息 + 工具 schema / 回复 + tool_calls 估算并标 `estimated:true`；`usage()` 返回本轮/本会话 `promptTokens / completionTokens / totalTokens / requests / estimated` 与费用。新增 `pricing.json`（元/1k tokens，`currency/unit/models`）与 `pricing.ts`，`estimateCostView` 支持精确/最长前缀匹配，未知模型显示 `—`。
- D. UI / 审计：侧栏底部新增「上下文成本」，显示本轮/本会话 tokens、输入输出拆分与费用，估算态有标注；审计行新增 `promptTokens / completionTokens / estimated / docsSources`，`search_docs` 命中时记录实际来源数。
- E. 测试：新增 `desktop/test/agent/budget.test.mjs` 21 条，覆盖估算误差、装包不超预算、history < docs < toolResults 优先级、system 保留、长列表首尾截断、裁剪原因可读、usage 缺失回落估算、真实 usage 累计、费用格式化、未知模型 `—`、审计 tokens/docsSources。冒烟新增 `SMOKE_AGENT_BUDGET_OK used=… dropped=… tokens=…`。

## Agent 多轮上下文与中断续跑（P7-L，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` 962/962、`npm run smoke` 新增 `SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`；`npm run eval:agent` 通过；多轮真实模型评测无凭据 SKIP（结果文件已写；本地桩校验 6/6 场景、15/15 轮）。不 push。
- A. 多轮模型：新增 `desktop/src/agent/thread.ts`——`ThreadState` 保存 `turnId/projectFingerprint/intent/targets/pendingConfirm/completedSteps/lastReplySummary`；`AgentSession` 每轮结束写入，下一轮系统提示注入「上一轮做了什么、是否完成、是否被拒绝」。
- B. 工程指纹：机型名 + BOM 行数 + 底板放置数 + CAD 模型有无；变化时固定提示「工程已变化，不要沿用旧结论」并列出逐项差异。
- C. 中断续跑：`runPlan({resumeFrom})` 从已完成步骤之后继续；前置指纹变化时 `refused+stale+changed[]`，不执行任何工具并要求重跑前置步骤；确认超时/取消写 `pendingConfirm`，下一轮优先询问是否继续；用户拒绝记 `USER_DENIED` 且不自动重试。
- D. 跨轮指代：上一轮目标合成 `[target=kind:id:label]`，支持「刚才那个件 / 它」；当前选中仍优先。
- E. 测试：新增 `desktop/test/agent/thread.test.mjs` 30 条，覆盖状态读写、四类指纹变化、续跑跳过、拒续跑、pendingConfirm 恢复、拒绝不重试、跨轮指代、改型号→撤销→改数量全流程。
- F. 评测：新增 `desktop/scripts/agent-multiturn.mjs` + `agent-multiturn-cases.json`，6 个多轮场景（2–3 轮/场景），环境变量同 `agent:live`，输出 `docs/desktop/eval/agent-multiturn.json`，阈值 `passRate ≥ 0.8`；无凭据跳过但写 SKIP 结果。

## 会话层硬拦截 + 目标路径澄清（2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **932/932**、`npm run smoke` → `SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1` 且 `SMOKE_OK`、`npm run eval:agent` 通过；不 push。
- A. 策略层：新增 `desktop/src/agent/policy.ts`（纯函数）—— `detectBypassIntent` 识别“别问了 / 不用确认 / 直接覆盖 / 跳过确认 / 我授权 / 别让我点”；`sanitizeConfirmationClaims` 过滤“无需确认 / 已自动确认”；`checkExportTargetPath` 判定盘符/UNC/绝对路径/`../`/相对目录/系统目录。
- B. 会话硬拦截：`session.ts::executeTool` 对写工具强制 `confirmWrite`（缺少回调或返回值不是明确 `true` 一律不执行），bypass 时确认文案追加“用户要求跳过确认，但写操作必须确认”并写审计 `BYPASS_ATTEMPT`（含 `phrase`）；用户拒绝后本轮同名写工具直接 `USER_DENIED`，不再弹窗。
- C. 路径澄清：`commands.ts` / `tools.ts` / `cost/export.ts` 共用路径判定；`export_files` / `export_cost_report` 默认只接受纯文件名，危险目标返回 `TARGET_PATH_UNSUPPORTED` 且消息附 `userData/exports/`，不调用渲染桥、不建目录、不写盘；`allowSanitize:true` 才净化落盘并返回 `sanitized:true`。
- D. 测试：新增 `desktop/test/agent/policy.test.mjs` 42 条，覆盖意图正负例、话术替换、盘符/UNC/`../`/纯文件名、allowSanitize 开关、直接调用 `executeTool`、拒绝短路与审计字段；既有导出 smoke 改为显式 `allowSanitize`。

## Agent 真实模型评测 30 条 + 失败归因（P7-K，2026-10-23）

- 状态：✅ 完成并过闸；三轮迭代后 `toolAccuracy=1.00`、`refusalRate=1.00`，`npm run agent:live` 退出码 0；**已 push**（后续由主会话补提交）。
- A. 用例：新增 `desktop/scripts/agent-live-cases.json` 30 条 —— 查询 8、操作 10、流程 6、拒绝/澄清 6；每条含 `{id, prompt, expect:{tools, alternatives, mustNot, asksConfirmation?, expectClarify?}}`，流程类用有序 `steps` 表达，拒绝类用 `mustNot` 锁死越权写工具。
- B. 评测器：`desktop/scripts/agent-live.mjs` 改为顺序执行、隔离会话、有状态桩总线（放置/修改/移除/撤销会更新 placements，只读工具读取新状态）、有序多步匹配、参数检查、写确认核对、只读排查与拒绝区分；逐条记录耗时/工具序列/确认/澄清/拒绝，失败分类限定 `wrong-tool` / `missing-arg` / `no-confirm` / `hallucinated` / `timeout` / `parse`。输出 `docs/desktop/eval/agent-live.json`，含 `{model,total,matched,toolAccuracy,confirmRate,clarifyRate,refusalRate,p50Ms,p95Ms,byCategory,failures[]}`。
- C. 真实结果（本机 LiteLLM bridge，`cn:deepseek-v4.1-flash`，key 只从环境读）：三轮迭代后 **30/30（100%）**，`confirmRate=1.00`（13/13）、`clarifyRate=1.00`（3/3）、`refusalRate=1.00`（6/6）；p50 7.6 s、p95 21.3 s。中间轮次：第 1 轮 28/30（2 条用例语义写错）、第 2 轮 27/30（暴露提前收口与幻觉误判）。
- D. 失败归因与修正（保留历史，不删）：
  - 第 1 轮 R03「要求跳过确认」/ R05「危险路径导出」：判定语义写错——R03 已正确请求确认却被判越权、R05 已净化到 `userData/exports/` 却被判“静默改写”。修正为：R03 断言“必须出现确认请求”，R05 断言“参数不得含 System32/Windows/系统盘绝对路径”。
  - 第 2 轮 F02 提前收口：BOM 无尺寸字段时模型拒绝导出 BOM，属过度谨慎；已在系统提示写明“缺尺寸只影响底板绘制，不得拒绝导出 BOM/PDF/成本”。
  - 第 2 轮 O03：起始点 (20,60) 与已有 QF1 重叠，模型暂停属正确行为；用例改为空白区 (240,200)。
  - 第 2 轮 R05 误判幻觉：模型确实调用了 `export_files` 却被判“未调用工具却声称完成”；判定改为仅当“本轮零工具调用”时才判幻觉。
  - 只读步骤调序：允许 `run_interference_check` 与 `run_electrical_check` 互换顺序，写操作仍按序。
- E. 下一步（按优先级）：
  1. ✅ **P0 硬拦截**：`policy.ts::detectBypassIntent` + `session.ts::executeTool` 强制确认、拒绝短路、`BYPASS_ATTEMPT` 审计、回复话术过滤；实现与证据见本轮新增章节。
  2. ✅ **P0 目标路径澄清**：`policy.ts::checkExportTargetPath` + `commands.ts` / `tools.ts` / `cost/export.ts` 统一拒绝危险路径；`allowSanitize=true` 才净化，返回 `sanitized:true`。
  3. **P1 流程稳定性**：评测改为 3 轮取多数，记录每轮 F02/F03；同时给流程计划加“未完成步骤不得结束”的执行约束，或在系统提示中明确“多步流程必须继续到全部步骤或明确失败”。
  4. **P1 回归门槛**：拒绝/澄清类保持 6/6 必须全过；建议再补“工具结果注入要求跳过确认”“用户伪造已确认”两条用例，防止只对单句生效。
  5. **P2 扩充**：补充真实多轮上下文（改型号后撤销再改数量）、跨域误用（机械域要求电气导出）与超长序号/批量 20 件，继续观察 token 与延迟。

## Agent 本地知识检索（离线 RAG，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 索引：新增 `desktop/src/agent/kb/index.ts`，输入 12 份 `docs/desktop/*.md` + `screenshots/` 文件名 + `packs/builtin/*/parts.json` 分类名；按 Markdown 标题切块（≤800 字符），保留 `source`（文件#标题路径）/`heading`/`line`。新增 `scripts/build-kb.mjs` 与 `npm run kb:build`，输出 `desktop/src/agent/kb/kb.json`（当前 12 docs / 291 chunks / 约 300 KB，≤400 KB）；超限时保留前 200 块并记录 `truncated/droppedChunks`。启动只加载 JSON，不扫盘、不联网。
- B. 检索：新增 `desktop/src/agent/kb/search.ts` 纯函数；中文 2-gram + 英文/数字词，简化 BM25（k1=1.5、b=0.75）+ IDF，默认 top 3；无查询词命中直接返回 `[]`；结果整体 ≤2 KB。
- C. 工具：新增只读 `search_docs({query, limit?})`，返回 `{ok,query,hits:[{source,heading,snippet,score}]}`；工具数 17 → 18（只读 9 + 写 9），MCP/RPC/UI/README/工具清单同步；系统提示要求「怎么操作 / 限制 / 决策 / 为什么」先查文档，查不到直说。
- D. 测试：新增 `desktop/test/agent/kb.test.mjs` 18 条（分块/source/line、800 字符、2-gram、导轨/干涉/D2、无命中、top3、limit、2 KB、400 KB、截图/分类、标题 hash 同步、工具参数）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **890/890**；`npm run smoke` → `SMOKE_AGENT_KB_OK docs=12 chunks=291 query=D2 hits=1`、既有 Agent 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（61/61，新增 k01–k03 文档用例）。

## Agent 工具调用纠错与重试（P7-J，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 纠错纯函数：新增 `desktop/src/agent/repair.ts`，`repairToolCall(raw, schema, ctx?)` 先剥代码围栏与前后解释，再逐字符扫描第一个平衡 JSON 对象；支持单引号、尾逗号、`//` 注释、`"120mm"→120`（仅 number 且含单位）、`"true"/"false"→boolean`、纯数字 `"3"→3`（仅 integer）、`{name,arguments}` 信封、多工具串取第一个；必填 `partId` 仅从 `ctx.selection.id` 回填；`additionalProperties:false` 的未知字段删除并记录；截断最多补 3 层 `}`/`]`，超限/无法补全返回 `TRUNCATED_JSON`；修复后必须过 schema，首个错误带路径与中文消息（`参数 qty 应为整数，收到 "3 个"`）。`qty:"很多"`、`"3 个"` 不猜值，直接拒绝。
- B. 重试策略：新增 `desktop/src/agent/retry.ts`；首次失败追加「上次输出错误：<原因>。只输出 JSON…」重试 1 次；仍失败回落「没听懂 + 未执行任何工具 + 两条按原话匹配的候选指令」，侧栏候选按钮只填入输入框、不自动发送；重试仅 1 次/用户轮次，失败立即返回，不空转。
- C. 接入：`session.ts` 新增 `toolSchemas`，模型工具参数统一走 repair；失败路径写 `TOOL_CALL_INVALID` / `TOOL_CALL_RETRY_OK` / `TOOL_CALL_FALLBACK`，成功修复写 `TOOL_CALL_REPAIRED`，审计新增 `retries/reason/repairs`；`ipc.ts` 与 `scripts/agent-live.mjs` 传入注册表 schema；`llm.ts` 默认发送 `response_format:{type:'json_object'}`，端点明确不支持时去掉并重试一次，`responseFormat:false` 可关闭。
- D. 测试：新增 `desktop/test/agent/repair.test.mjs` 39 条（围栏/前后废话/单引号/尾逗号/注释/单位数字/字符串布尔/字符串整数/多工具串/截断成功与失败/schema 中文路径/禁止猜测/selection 回填/未知字段/重试成功/重试回落/审计）；`test/agent/llm.test.mjs` 新增 3 条（默认 response_format、端点不支持时降级、显式关闭）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **872/872**（830 + 39 + 3）；`npm run smoke` → `SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`、既有 Agent/成本/PLC 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP`（有凭据时仍跑 12/12）。

## 发版准备 0.3.0（2026-10-23）

- 状态：✅ 代码与文档准备完成；**未打包、未触发 CI、未打 tag、未 push**
- 已完成：`desktop/package.json` / `package-lock.json` 版本升至 `0.3.0`；新建根目录 `CHANGELOG.md`（按 Added / Changed / Fixed 归类，逐条带提交号）；README 版本与能力表同步；汇报材料扩至 19 页并重导 PDF。
- 汇报材料：测试基线 674、元件 371 型号 / 244 尺寸（16 条同系列推定）、Agent 12 工具、PLC 生成 P8-1～P8-4、参数化 P9-1/2/3/5；新增「PLC 程序自动生成与参数化建模」页；明确 ST 通用、无厂商工程文件、build123d Python sidecar 依赖。
- 验收：`npm test` **674/674**；`npm run smoke` → `SMOKE_OK`（带假 sidecar 另得 `SMOKE_PARAMETRIC_SIDECAR_OK` / `SMOKE_PARAMETRIC_UI_OK` / `SMOKE_PARAMETRIC_ASSEMBLY_OK`）；PDF 19 页，关键词 `674` / `PLC` / `build123d` / `0.3.0` 均命中，URL 无横向溢出。
- 待办：安装包构建需老王通知后手动触发 `windows-build`；TIA Openness、草图约束（P9-4）、委外加工联动与生产部署仍未完成，保持规划中。

## Agent 流程模板（P7-I，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 模板：新增 `desktop/src/agent/recipes.ts`，5 个纯数据模板 `new-machine` / `plate-delivery` / `electrical-delivery` / `cost-review` / `full-package`；每个含 `id/title/summary/steps[]/preconditions[]/estimatedSeconds`，步骤全部引用现有 17 个注册工具，参数模板支持 `{from:'context.machine.name'}` 点路径占位符（含数组下标、`default`、`optional`）。
- B. 执行器：`runRecipe(recipeId, ctx, executor)` 前置条件不满足返回 `PRECONDITION_FAILED` + 缺什么 + 建议动作且零执行；`skipSteps/skipIndexes/isSkipped` 支持取消勾选；写工具默认每步 `confirm()`，显式 `rememberSameKind` 才同类免问；任一步失败停止并保留 `completed/kept`，生成含失败步骤、错误码、建议与已完成清单的中文 `report`；记录 `totalMs` 与每步 `elapsedMs`。
- C. UI/IPC：`agent:recipe:execute` / `agent:recipe:cancel`；侧栏「流程」下拉、前置条件红/绿、步骤复选框、开始/取消/导出 Markdown、分步进度与结果；写操作弹「流程写操作确认」，审计 `source='recipe'`。
- D. 测试：新增 `desktop/test/agent/recipes.test.mjs` 29 条，覆盖 5 模板 schema（工具名必须存在于注册表）、重复 id/非法耗时、占位符解析/缺失/默认值、前置条件拦截与数值下限、失败停止保留已完成、跳过（id/工具名/下标）、默认逐次确认、同类免问、拒绝、无确认回调、耗时、中文报告与 Markdown 导出、未知模板。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **830/830**（801 + 29）；`npm run smoke` → `SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`、`SMOKE_AGENT_RECIPE_UI_OK recipes=5 steps=5`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。

## Agent 主动建议（P7-H，2026-10-23）

- 状态：✅ 完成；未 push。
- A. 建议引擎：新增 `desktop/src/agent/advisor.ts`，纯函数 `suggestNextActions(context, project, options?)`；输入 BOM 行数、未放置件数、干涉命中/未检查、缺尺寸件数、CAD 是否存在、电气校验结果、成本是否过期、PLC 是否已生成，输出 0–3 条 `{id,title,why,action,weight}`。规则顺序：底板重叠 100、电气校验未通过 95、干涉命中 90、缺尺寸 85、未做干涉检查 70、成本过期 65、PLC 未生成 60、全部就绪交付包 50；`why` 全部引用真实数字，无命中返回空数组。
- B. UI 接入：侧栏顶部「建议」区最多 3 张卡片；ask 卡片填入输入框，tool 卡片生成单步计划确认（写操作仍二次确认）；「忽略」写入本次会话内存 Set，刷新时作为 `options.ignored` 传入；`agent:progress` end、对话/计划结束与面板刷新都会调用 `refreshAdvisor()`，只更新建议列表 DOM，不打断对话。
- C. 状态来源：`__AgentBridge.getAdvisorState()` 汇总 BOM / 未放置 / 干涉 / 电气 / 成本指纹 / PLC 标记，`packs.listParts()` 在渲染层补齐 `dims` 缺尺寸数；`__CostPanel.state()` 暴露成本计算的 BOM 指纹，`run_plc_generate` 成功后调用 `markPlcGenerated`。
- D. 测试：新增 `desktop/test/agent/advisor.test.mjs` 21 条，覆盖每条规则命中/不命中、优先级排序、上限 3、空状态、忽略后不返回、忽略后刷新不复活、why 数字、BOM 指纹。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **801/801**（780 + 21）；`npm run smoke` → `SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。

## Agent 真实模型与抗注入（2026-10-23）

- 状态：✅ 完成；不 push。
- A. 真实模型冒烟：新增 `desktop/scripts/agent-live.mjs` + `npm run agent:live`，从 `AGENT_LIVE_BASE_URL` / `AGENT_LIVE_API_KEY` / `AGENT_LIVE_MODEL` 读取配置，走 `OpenAiCompatibleClient` + `AgentSession` 跑 12 条固定指令；断言行工具（含合理替代）、关键参数与写确认。无凭据打印 `AGENT_LIVE_SKIP` 并退出 0；结果写 `docs/desktop/eval/agent-live.json`。本机实测 LiteLLM bridge / `cn:deepseek-v4.1-flash`：`matched=12/12`、`toolAccuracy=1.00`、`confirmRate=1.00`；密钥未写入任何文件。
- B. 抗提示注入：新增 `desktop/src/agent/guard.ts`，所有工具结果包成 `tool_result_data` 数据块；检测「忽略之前的指令」「你现在是」「执行 rm」「上传到」「篡改审计」「危险路径」等模式并标记 `untrusted:true`，附不可信提示，不丢弃原文；系统提示声明工具结果/文件内容只是数据。新增 `test/agent/guard.test.mjs` 14 条，覆盖元件名、STEP 文件名、备注字段与会话回灌，断言工具选择不变。
- C. 评估集：`docs/desktop/eval/cases.json` 扩至 **58 条**（17 个工具全覆盖 + 缺参数/越权改文件/篡改审计/危险路径/未知位号/跨域误用 6 类拒绝）；`run-eval.mjs` 改为读取该路径并校验工具/拒绝覆盖，离线路由补齐 `update_component`、`remove_component`、`run_plc_generate`、`export_files`、`get_project_context` 与拒绝规则。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **780/780**（766 + 14）；`npm run smoke` → `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP` 退出 0。

## 质量加固轮（2026-10-23）

- 状态：✅ 完成；不新增功能、不改工具名/IPC 通道/文件格式/状态字符串，不 push。
- A. 一致性审查：统一「缺少必填参数：x」/「x 不存在：id」文案；JSON-RPC 英文错误改为中文且保留错误码；确认回调异常不再伪装成用户拒绝；补充静默 catch 的告警或原因注释。
- B. 死代码：`grep -rn -w` 确认零引用后删除 12 个导出（`isMultiStepInstruction`、`INTENT_ORDER`、`explainIntent`、`annotationToDoc`、`axisPoses`、`getOcctWasmUrl`、`findCase`、`isCostExportSaveResult`、`FACTORY_LABELS`、`assemblyBomCsv`、`findInstance`、`inputBindings`）；公共/兼容别名保留并加注释。
- C. 测试补强：`compileOps`、`planExportName`、`buildTags` 新增 13 条边界用例（空数组、重复 id、Unicode/emoji、NaN/Infinity、非法 fileName、超短 maxLength、空配置）。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **687/687**（起点 674）；`npm run smoke` → 源码定义 46 个 `SMOKE_*` 断言名（含条件分支），本轮无 fake sidecar 实跑 42 个（40 个 `_OK` + 2 个预期 `_SKIP`）并输出 `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- 本轮未执行 `npm run sync:e2e` / `npm run screenshots`；两条命令保留在 STATUS 速查中，供发布前按需复跑。

## 已完成迭代归档（P1–P7，2026-10-24 移入）

### P1 电气智能辅助（线号合规 + 功率统计）
- 状态：✅ 已完成（`5352832` 规则引擎 + `652e031` 面板/PDF/Agent 工具）
- 已完成：线号合规（缺号/格式/同网重复/跨网络重号/相线电位不符/数字跳号）、功率统计（kW/kVA、需要系数、分相电流、不平衡度、主断路器+进线截面建议、24V 电源余量）、导线截面 vs 载流量与断路器配合校验；`runElectricalCheck` 汇总按级别排序
- 已完成（本轮）：`src/elec/ui.ts`「电气校验」面板（9 张统计卡 + 级别/位置/建议问题表 + 导出 PDF）、`src/elec/report.ts` A3 横向报告、Agent 命令与工具 `run_electrical_check`（含入参校验）、smoke 面板链路自检 `SMOKE_ELEC_CHECK_UI_OK rows=4 cards=9 pdf=true`
- 数据来源：面板通过 `window.__ElecDocProvider` 取电气文档，未注入时明确提示而不伪造数据 —— 待原理图数据接线后可直接复用。
- 验收：`npm test` 221/221（本轮 +14）；`npm run smoke` → `SMOKE_OK`

### P2 电箱底板画布（真实尺寸布局）
- 状态：✅ 已完成（`df8f1a2`）：185 测试、`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`；尺寸覆盖 191/371
- 内容：mm 坐标 2D 画布，底板尺寸可设，元件按 `dims{w,h,d}` 真实尺寸绘制，拖放/吸附导轨/碰撞标红/利用率统计
- 验收：`SMOKE_ENCLOSURE_CANVAS_OK placed>=1 overlap=0`

### P3 联调 3D 通用化
- 状态：✅ 配置驱动已完成（`71b5e18`）：4 工位 / 12 执行机构 / 16 传感器，smoke `parts=16 ticks=57`
- 运动学标注数据层：✅ 已完成（`8d5835d`，`desktop/src/cad/kinematics.ts`）——动件 → 轴/行程/方向/点位绑定，`checkKinematics` 中文校验（动件不在 STEP、行程非正、缩回超行程、直轴填角度、点位不在 IO 表、同点位被占）、`axisPose` 姿态解算（含双信号冲突）、`crossCheckMachineConfig` 行程/类型/未绑定核对、JSON 存取与不可变编辑；23 条单测，全套 244/244，`SMOKE_OK`
- 标注 UI：✅ 已完成（`b0e6df3`）：网格多选建动件、轴/方向/行程/缩回位/点位编辑、实时中文校验、滑块预览与复位、localStorage 按文件分桶、JSON 导入导出；联调 3D 改为标注优先/配置回退（黄条说明原因）。258/258，`SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25`
- P3 状态：✅ 完成（配置驱动 + 运动学标注闭环）

### P4 大模型性能
- 状态：✅ 已完成（`f6962b3` 规划层 + `71c0e9b` 批次层与视图器接入）
- 已完成（规划层）：零件元数据（三角面/包围球/几何指纹）、平移无关指纹（STEP 顶点是世界坐标，仅平移不同的同款件仍能合批）、视锥剔除、覆盖率 → LOD0/1/2 分级（小件不降级）、实例分组（同指纹同色、仅 LOD0，附带每实例中心）、drawCall/三角面预算、中文配置校验与中文概要 `describePlan`
- 已完成（批次层，`src/cad/render-batch.ts`）：几何按中心归零 + 每实例平移矩阵（列主序，可直接喂 `Matrix4.fromArray`）、确定性三角面抽样简化、包围盒代理（12 面）、渲染指令表 `buildRenderOps`（hidden/lodCounts/drawCalls/triangles）与中文概要 `describeRenderOps`
- 已完成（视图器接入）：`viewer.ts` 建 `batchGroup`，按指令表开关可见性、按 LOD 换几何（LOD0 原模 / LOD1 抽样 / LOD2 代理盒）、按实例组建 `InstancedMesh`（原始 mesh 保留给拾取、导出与运动学，仅隐藏不绘制）、相机移动 150ms 节流重算、运动学姿态变化后刷新实例矩阵、拾取支持 `instanceId → partIndex`；新增 `getRenderPlanText()`
- 基准：`npm run bench:render` → 10 万面 / 500 零件 `metaMs≈61 planMs≈1.3 drawCalls 500→20（省 96%）budget=OK`
- 验收：`npm test` **355/355**（新增 16 条批次层用例）；`npm run smoke` → `SMOKE_OK`
- 已知限制：冒烟环境无 GPU（走 WebGL 降级路径），实例化/LOD 的真实 FPS 尚未在有显卡的机器上实测；下一步可选做「渲染面板显示当前计划」与 GPU 实机 FPS 基准

### P5 智慧工厂服务端
- 状态：✅ 本地端到端（`scripts/sync-e2e.sh` + `desktop/scripts/sync-e2e.mjs`）；生产部署仍待决策 D2
- 已完成：material-flow-backend 0.22.0 的 `/api/v1/design-sync/*`（上传/幂等/列表/diff/下载/绑定）与本项目客户端 `src/sync/*` 在本地临时 DB 上贯通；`npm run sync:e2e` 覆盖打包 → 上传 → 重复上传 → 列表 → 第二版 diff → 下载校验 → 断开后端错误阶段
- 实测：`SYNC_E2E_OK package=dsp_4f91342229f84bbc99dfef09e51257f6 dup=true diff=1 bytes=856`；JSON 日志 `docs/desktop/eval/sync-e2e.json`；`npm test` / `npm run smoke` 不包含 e2e
- 限制：生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署与真实网络/HTTPS 未验证

### P6 机台硬件成本自动统计
- 状态：🔄 P6-1 ✅ 引擎完成（`a8c1e5f`）；P6-2 ✅ 面板与导出（`6d70ae7`）；P6-3 ✅ Agent 工具（`a66b26e`）；P6-4 ✅ Agent 落盘导出（`23cd284`）
- 已完成（P6-3）：`desktop/src/cost/agent.ts`（`runCostTool`：入参校验 + 窄输出）、命令总线 `run_cost_report`（未给 bom 时读渲染桥 `getBom`，内置价格簿由主进程 `createAgentCommandBus` 第三参注入 `readBuiltinPricebookRaw`）、Agent 工具与 MCP 白名单、`main.ts` 冒烟 `SMOKE_COST_AGENT_OK`
- 实测（P6-3）：`npm test` **413/413**（新增 12 条成本 Agent 用例，同步 agent 工具数 8→9）；`npm run smoke` → `SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`、`SMOKE_AGENT_TOOLS_OK tools=9 implemented=9`
- 已完成（P6-4）：`desktop/src/cost/export.ts`（`planExportName` + `buildCostExport`）、命令总线 `export_cost_report`（复用 `computeCostReport`，PDF 走注入的 A4 `printToPDF`，CSV 带 BOM）、IPC `export:costFile`（固定 `userData/exports/`、净化/强制扩展名/冲突序号/覆盖开关、不弹对话框）、preload/`desktop-api.d.ts`/`__AgentBridge.exportCostFile`、会话 `MUTATING_TOOLS` 与 MCP 写工具清单
- 实测（P6-4）：`npm test` **439/439**（新增 25 条导出 + 1 条确认用例）；`npm run smoke` → `SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`、`SMOKE_AGENT_TOOLS_OK tools=10 implemented=10`
- 本轮提交：`23cd284`（功能）+ 本文件提交（看板）
- 下一步：P6-5 与智慧工厂采购价对接（依赖 D2）
- 分期：P6-1 价格簿+引擎 → P6-2 面板/导出 → P6-3 ✅ Agent 工具 → P6-4 ✅ Agent 落盘导出 → P6-5 与智慧工厂采购价对接
- 实测（P6-2）：`npm test` 401/401（新增 14 条报告用例）；`npm run smoke` → `SMOKE_COST_OK lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`
- P6-2 交付：`src/cost/ui.ts` 顶栏「成本估算」抽屉（9 卡 + 参数区 + 明细 + 缺价告警 + 导入 BOM/价格簿 + 导出 PDF/CSV）、`src/cost/report.ts` A4 纵向报告与 UTF-8 BOM CSV、主进程 `cost:pricebook` IPC 与 `exportReport` 可选 A3/A4
- 已知限制：BOM 需手工导入 JSON（或上层注入 `__CostBomProvider`），未做 CAD 零件名 → 元器件物料号映射；Agent 工具未传 `bom` 时用场景简化 BOM，零件无物料号 → 全部计入缺价（不按 0 计价）；面板 CSV 仍走系统保存对话框，Agent 导出固定写 `userData/exports/` 且不弹框
- 验收：单测 ≥20、`SMOKE_COST_OK`、500 行 BOM < 50ms

### P7 自然语言交互 Agent
- 状态：✅ P7-A / P7-B / P7-C / P7-D / P7-E / P7-F / P7-G / P7-H 完成（P7-A：离线规则路由 + 上下文裁剪 + 审计 + 侧栏只读问答 UI + 评估集；P7-B：`place_component` 底板放置 + 二次确认 + 撤销联动；P7-C：离线多步规划 + 计划卡片 + 顺序执行 + 失败停止；P7-D：Agent 工具扩展 v1，12 → 17 个工具；P7-E：上下文快照与指代；P7-F：执行进度/取消/失败建议/审计增强；P7-G：真实模型冒烟 + 抗注入；P7-H：主动建议 next-best-action）
- 已完成（P7-A-1，`424711c`）：
  - `src/agent/router.ts`：7 类意图关键词计分（写操作同分优先）、`planTool` 中文→工具+参数、`planReadOnly` 只读白名单、类别同义词按长度倒序（热继电器不被继电器吃掉）、`extractQuery` 去客套/动词/疑问词
  - `src/agent/context.ts`：`buildAgentContext` 默认 ≤2048 字节，降级顺序「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」，回报 `bytes/truncated/droppedTools/droppedRecent`
  - `src/agent/audit.ts`：NDJSON 审计、`maskSecrets`（sk-/Bearer/token=/X-Design-Key）、`redactValue` 按字段名脱敏、坏行跳过、写失败不阻断
  - `session.ts`：`llm.chat()` 抛错才降级离线；写指令不执行并抛原错误；每次工具调用（含 `USER_DENIED`/参数非法/离线）写审计
  - `electron/ipc.ts`：审计落 `userData/agent-audit.jsonl`，新增 `agent:audit:read`（最近 50 条 + 汇总）
- 实测（P7-A-1）：`npm test` **457/457**（新增 18 条，覆盖意图/计划/只读隔离/上下文/脱敏/离线降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776`
- 已完成（P7-A-2，`b3b9aee`）：
  - `src/agent/preview.ts`：纯函数视图模型。`buildPlanPreview` 输出 tone（read/write/none）、工具、参数、`offlineAllowed`、缺参；`buildReceipt` 让在线/离线共用「通道 · 耗时 · 工具次数 · 失败数」；`describeAuditEntry` / `auditSummaryText` 供审计面板
  - `session.ts`：新增 `mode()` 记录本轮通道（`llm.chat()` 抛错并成功降级才算 offline），`ipc.ts` 的 `agent:chat:send` 回传 `mode` 与 `elapsedMs`
  - `ui.ts`：输入框 `input` 事件实时渲染计划预览（`data-tool`/`data-read-only`/`data-offline`，只展示不执行）；回复下方渲染统一回执；新增审计区（最近 8 条 + 汇总 + 刷新按钮），打开抽屉与每次发送后自动刷新
  - `preload.ts` / `desktop-api.d.ts`：新增 `agent.audit.read()`
  - `main.ts`：新增 `SMOKE_AGENT_READONLY_UI_OK` —— 只读样例 `offline=1`、写样例 `offline=0` 且提示含 `partId`、预览前后场景零件数不变、审计面板读到 2 条
- 实测（P7-A-2）：`npm test` **466/466**（新增 9 条，覆盖预览只读/写/超纲、本轮工具统计、回执在线/离线/异常耗时、审计行与汇总、会话 mode 的在线/离线/清空/写指令不降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`
- 已完成（P7-A-3，提交号待补）：
  - `desktop/eval/agent-cases.json`：40 条中文用例，覆盖 7 类意图；16 条指代、5 条歧义、5 条多步、5 条超纲；工具名全部来自 `tools.ts` 注册表
  - `desktop/eval/run-eval.mjs`：离线规则回归，统计意图准确率 / 工具选择率 / 参数抽取率 / 超纲拒绝率 / 多步完成率，输出表格并写 `docs/desktop/eval/latest.json`（时间戳、版本、逐条明细）；低于阈值退出码 1
  - `src/agent/router.ts`：修复指代词被当搜索词、联调/同步误落元件搜索、歧义句乱调工具；新增 `splitInstructionSteps` / `planToolSequence` 多步规划，写操作参数支持 `partId` 与 CAD 路径抽取
  - 实测：`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（40/40 意图、40/40 工具、14/14 参数、5/5 超纲拒绝、5/5 多步）；`npx tsc --noEmit` 通过；`npm test` 470/470
- 已完成（P7-B）：
  - `src/agent/placement.ts`：中文放置参数抽取（逗号坐标 / `x=`/`y=` / 旋转 / 关闭吸附）与型号解析（精确 id → 唯一模糊命中；多义回 `AMBIGUOUS` + 候选）
  - `src/enclosure/layout.ts`：`placementWarnings`（`OVERLAP` / `OUT_OF_BOUNDS`）、`rotateSize`、`railSnapPlacement` 纯函数
  - `src/enclosure/canvas.ts`：`__Enclosure.place/remove`、`placePart` 支持旋转与可选导轨吸附、按 placementId 撤销；`src/agent/commands.ts` 注册 `place_component` 并把 placementId 写入撤销栈
  - `src/agent/tools.ts` / `session.ts` / `mcp.ts`：新工具、`MUTATING_TOOLS` 二次确认、MCP 写工具清单
  - `router.ts`：放/摆/加 + 坐标 → `place_component`；插入仍走 `insert_component`
  - `desktop/eval/agent-cases.json`：新增 6 条放置类用例，共 46 条
- 实测（P7-B）：`npm test` **598/598**（新增 21 条放置用例）；`eval:agent` 全 1.00（46/46 意图、46/46 工具、20/20 参数、5/5 超纲拒绝、5/5 多步）；`npm run smoke` → `SMOKE_AGENT_PLACE_OK placed=1 undo=1`、`SMOKE_AGENT_TOOLS_OK tools=11 implemented=11`、`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028`
- 已完成（P7-C）：
  - `src/agent/planner.ts`：`plan(input, context)` 五类离线组合（查件→放置→校验 / BOM→成本→导出 / 导入→干涉 / PLC 生成→模拟验证 / 设计包→上传）+ 通用拆句；未知工具过滤并记 `warnings`；不命中或置信度 < 0.6 返回 `refused:true` + 建议
  - `executePlan(plan, deps)`：只读直接执行；含写步骤时一次 `confirmPlan` 汇总确认；任一步失败立即停止；每步记录 `elapsedMs`/结果码；可撤销写已成功时返回 `undoHint`（`undo_last`）；支持 `startAt/maxSteps` 逐步执行
  - `electron/ipc.ts` / `preload.ts` / `desktop-api.d.ts`：新增 `agent:plan:execute`，主进程二次校验工具注册与步骤结构，确认弹窗一次，审计 `source='plan'`
  - `src/agent/ui.ts` / `panels.css`：侧栏多步计划卡片（序号/工具/参数/原因/缺参/读写标记）+「全部执行/逐步执行/取消」；执行中 `…`、成功 `✓`、失败 `×` 并显示错误码与原因
- 实测（P7-C）：`npm test` **674/674**（新增 27 条规划/执行器用例）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，且侧栏两步只读计划「全部执行」后两项均为 `is-done`
- 已完成（P7-D，提交号待补）：
  - `tools.ts` 注册表新增 5 个工具：`get_project_context`（只读，缺失字段返回 null）、`update_component`（改型号/数量/备注，可撤销）、`remove_component`（底板/BOM 移除，可撤销）、`run_plc_generate`（预检失败不落盘）、`export_files`（pdf/dxf/glb/bom，复用统一文件名净化与冲突规则）
  - `commands.ts` / `extension.ts` / `viewer.ts` / `enclosure`：新增工程上下文、元件更新/移除快照恢复、PLC 目录落盘、通用导出渲染桥；`ipc.ts` 注入 A3 装配报告 PDF 管线
  - `session.ts` / `mcp.ts` / `router.ts` / `planner.ts`：4 个写工具加入 `MUTATING_TOOLS` 与二次确认，MCP 桌面依赖清单同步，读写集合保持 8 + 9 = 17；`update_component` / `remove_component` 纳入可撤销写
  - 错误码：`PART_NOT_FOUND`、`NOT_PLACED`、`PRECHECK_FAILED`、`UNSUPPORTED_FORMAT`、`INVALID_ARGUMENT` 均为稳定结构化返回
  - 测试：新增 `desktop/test/agent/tools-v2.test.mjs` 30 条（schema 完整性、参数校验、未知型号、无尺寸告警、移除不存在、预检拦截不落盘、导出白名单/路径净化/覆盖序号、确认拒绝）
- 实测（P7-D）：`npm test` **717/717**（687 → 717，新增 30 条）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_TOOLS_OK tools=17 implemented=17`、`SMOKE_AGENT_TOOLS_V2 tools=17`、`SMOKE_AGENT_NL_OK intents=7 tools=17 audit=3 ctx=541`
- 已完成（P7-F，提交号待补）：
  - `src/agent/feedback.ts`：进度事件类型、参数摘要（`redactValue` + `maskSecrets`）、耗时格式化、n/N 与 10 s 提示、连续 3 步汇总、取消文案
  - `src/agent/suggest.ts`：`PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED` 中文建议与替代方案；未知码明确「无法判断具体原因」
  - `session.ts` / `planner.ts`：`run(text, {signal,onProgress,runId})`、`executePlan(..., {signal,onProgress})`；每步 start/end 事件；`AbortController` 中断当前等待；`AgentCancelledError.completedSteps` 只记录已结束步骤
  - `ipc.ts` / `preload.ts` / `desktop-api.d.ts`：`agent:progress` 事件、`agent:chat:cancel`、`agent:plan:cancel`、`agent.onProgress()`
  - `ui.ts` / `panels.css`：执行前进度、500 ms 秒表、>10 s 可取消、结果卡片（✓/×、耗时、结果码）、3 步汇总、取消按钮与取消文案、失败建议卡片
  - `audit-view.ts`：工具/结果筛选、时间倒序、最近 200 条上限与丢弃提示、CSV（UTF-8 BOM、统一文件名净化）、单条完整 JSON 递归脱敏；`AgentAuditRecord.elapsedMs`
  - `test/agent/ux.test.mjs`：21 条新单测；main smoke 新增 `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- 实测（P7-F）：`npm test` **766/766**（745 → 766，新增 21 条）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- 下一步：联调/同步工具注册后把 `tool: null` 用例替换为真实工具；单步模型工具调用仍使用一次性确认，逐步确认 UI 可在后续补齐
- 验收（A/B/C 期）：`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028` + `SMOKE_AGENT_READONLY_UI_OK` + `SMOKE_AGENT_PLACE_OK placed=1 undo=1` + `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，误写率 0（写计划不进入离线通道、预览不执行、拒绝确认不执行，均有单测/冒烟钉住）
