# 模块：PLC 代码生成（src/plcgen/）

职责：在电气设计定稿后做生成前预检，并产出 IO 变量表、IEC 61131-3 ST 基础块、自动序列/报警/安全 FC 与映射表；P8-3 起提供电气域生成面板、zip 导出与生成历史；P8-4 起用内置模拟器执行生成序列，做到「生成即验证」。核心生成与模拟逻辑均为可单测纯函数。

## 文件

| 文件 | 职责 |
|---|---|
| `precheck.ts` | `precheck(config, bom?)`：地址重复/越界、点位多机构占用、传感器绑定、安全件、步序点位、双线圈、BOM 点数容量；全量返回 `errors/warnings` |
| `tags.ts` | `buildTags(config)`：I/Q 顺序分配、32 字符变量名、UTF-8 BOM CSV |
| `st.ts` | `generateSt(input)`：五个 ST 文件 + `stats`，`inputHash` 取输入 JSON SHA-256 前 12 位 |
| `sequence.ts` | `generateSequence(input)`：联调步序 → `FC_AutoSequence.st` 的 CASE 状态机，含动作、AND/OR 条件、步超时与 Abort/SafeStop 复位 |
| `safety.ts` | `generateSafety(config)`：`FC_Safety.st`，急停/安全门/光栅常闭串联、SafeStop 锁存、Reset 上升沿解除、输出复位 |
| `alarms.ts` | `generateAlarms(config)`：`FC_Alarms.st`，超时/传感器矛盾/安全触发汇总到 `AlarmWord`，`FirstFault` 首故障锁存 |
| `generate.ts` | `generateProject(input)`：预检拦截 + 固定 11 文件顺序 + `mapping.json` / `README.md` / 每文件 SHA-256 |
| `simulate.ts` | `simulate({ project, config })`：读 `mapping.json`，按输出映射与执行机构行程时间模拟传感器，按生成 `timeoutMs` 判超时；`SafeStop` 中止、传感器矛盾报警、`timeScale` 加速；纯函数虚拟时钟 |
| `verify.ts` | `verifyGenerated(config/options)`：预检 → 生成 → 模拟；`summarizeVerification` 输出 Agent/UI 窄摘要，不落盘、不写 PLC |
| `hash.ts` | 同步纯 JS SHA-256（不依赖 `node:crypto`），生成器同时供主进程与渲染层使用 |
| `symbols.ts` | 点位 / 地址 / 变量名 ↔ `"DB_IO".<变量>` 的稳定映射 |
| `io.ts` | `X0/Y0` 与 `I0.0/Q0.0` 地址归一化、IO 收集与命名辅助 |
| `types.ts` | 安全点位、步序、BOM、变量表与生成结果类型 |
| `view-model.ts` | 面板纯数据层：文件树、200 行预览、按钮禁用、问题定位、统计文案、复制包 |
| `export.ts` | `planPlcExportDirectory`：`<机型>-<yyyyMMdd-HHmm>`、同名 `-2` 递增，复用 `src/shared/filename.ts` |
| `history.ts` | 最近 10 次历史：按 inputHash 去重、新→旧、解析/合并纯函数 |
| `ui.ts` | 电气域顶栏「PLC 程序」全屏面板；预检 / 生成 / 模拟验证 / 导出；`window.__PlcGenPanel` 供冒烟与命令式调用；作为首个 `plcgen` 可选模块，关闭时隐藏入口、关闭面板并拦截命令式调用 |
| `plcgen.css` | 面板样式（三栏：配置/预检、文件树、预览；底部历史与操作） |

## 关键约定

1. **预检不短停**：每条规则独立执行，最后一次性返回全部错误。
2. **地址口径**：I/Q 各 256 点；`X0` 等价 `I0.0`、`Y0` 等价 `Q0.0`；变量表不沿用源地址，而是按稳定自然序重新从 `I0.0/Q0.0` 顺序分配。
3. **确定性**：文件正文无时间戳，排序、换行、变量名后缀全部固定；输入 JSON 一致则输出逐字节一致。
4. **安全优先**：安全点位豁免“传感器未绑定机构”，但急停/安全门缺失仍为错误；BOM 未提供时不校验容量。
5. **汇总不短路**：`generateProject` 先跑完整预检；有 error 时只返回 `{ ok:false, errors }`，不产生半套文件。
6. **安全最后执行**：`OB1_Main` 调用顺序为序列 → 报警 → 安全，确保 `SafeStop` 同周期复位输出。
7. **无伪造点位**：安全点位缺失时只生成 `(* 未配置急停/安全门 *)` 与失效保护，不编造变量名。
8. **目标平台不污染 ST**：`target` / `namePrefix` 只写 README 与导出命名；计算 `inputHash` 前剥离，切换目标时除 README 外逐字节一致。
9. **导出路径只有一份规则**：文件名净化来自 `src/shared/filename.ts`（成本导出同样使用），ZIP 路径校验与写入集中在 `src/shared/zip.ts`。
10. **历史去重口径**：同一 `inputHash` 只保留最新一条；上限 10，存储于 `<userData>/plc-gen-history.json`。
11. **模拟器只认 mapping**：`simulate` 从 `mapping.json` 的 `points/sequence` 取点位映射与 `timeoutMs`，不解析任意 ST，也不产生真实 IO。
12. **模拟是纯函数**：使用虚拟时钟与 `timeScale`，不读墙钟；超时/`SafeStop` 后当前步失败、后续步记为跳过，重复调用结果一致。
13. **验证不落盘**：`verifyGenerated` / Agent 工具 `verify_plc_program` 只返回摘要，不写 zip、不写历史、不连接 PLC。
14. **模块关闭不清数据**：模块状态由 `src/modules/registry.ts` 管理，缺省开启以兼容旧体验；关闭不删除机型配置、PLC 项目数据、生成历史或已导出文件，不做热卸载。面板、Agent `verify_plc_program` / `run_plc_generate`（包括 JSON-RPC/MCP）、本地 PLC 文件生成/导出、`plcgen:recordHistory` 和 `plcgen:export` IPC 共用 `plcgen` 门禁；关闭后动态隐藏工具并在写入/生成前拒绝旧名称或底层直调。智慧工厂同步包中的 PLC 源码与 IO mapping 另受 `factory.plc-sync` 门禁，只有两个模块都启用时才生成和上传同步扩展；关闭同步扩展不影响本地 PLC 生成/导出。历史读取和打开已有导出目录保留，以便访问旧数据。

## 进度与验证

- ✅ P8-1：预检 + 变量表 + `FB_Cylinder` / `FB_Gripper` / `FB_RotaryAxis` / `DB_IO` / `OB1_Main`
- ✅ P8-2：`FC_AutoSequence` / `FC_Alarms` / `FC_Safety` + `mapping.json` + 11 文件汇总与逐文件 SHA-256
- ✅ P8-3：`ui.ts` 预检面板 + 问题定位 + 文件树/预览 + 导出 zip + 最近 10 次历史；`SMOKE_PLCGEN_UI_OK files=11 history=1`
- ✅ P8-4：`simulate.ts` + `verify.ts`；面板「模拟验证」与 Agent 只读工具 `verify_plc_program` 共用 `verifyGenerated`；`SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`
- ✅ 109 条 plcgen 单测（P8-1 35 + P8-2 32 + P8-3 21 + P8-4 21）；全套 619/619；`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`
- ⏳ P8-5（可选）：TIA Openness

## 待办

1. 按真实 PLC 模块样本扩充 BOM 点数解析规则（当前支持显式字段与 `16DI/16DO`、`N 点` 文本）。
2. 模拟器补充旋转轴角度/夹爪开合的多传感器与故障注入样例。
3. P8-5 可选：`io-tags.tia.xml` 与 TIA Openness 导出。
