# 智能体文档历史（不进离线索引）

## 10. 分期

- A（1 周）：只读问答 + 4 个查询/计算工具接入 + 侧栏聊天 + 审计
- B（1 周）：单步写操作（放件、导出）+ 确认机制 + 撤销联动
- C（2 周）：✅ 多步规划（计划预览 / 顺序执行 / 失败停止 / 写步骤一次确认）+ 成本工具
- D（持续）：联调/同步类工具、语音、评估集扩容；主动建议已在 P7-H 落地

## 11. 验收（A 期）

- 10 条典型中文指令在无网络模型下（规则路由）也能正确调用只读工具 —— ✅ 11 条样例覆盖 7 类意图，`SMOKE_AGENT_NL_OK intents=7 tools=20 audit=3 ctx=595`；`SMOKE_AGENT_TOOLS_V2 tools=20`；`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=1`；`SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`；`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=5 undo=1`
- 断网时给出明确提示，不静默失败 —— ✅ 回复以「当前模型不可用，已切换为离线规则路由」开头；写指令仍抛原始网络错误，不执行命令
- 审计文件可查，凭据掩码正确 —— ✅ `<userData>/agent-audit.jsonl`（NDJSON）+ IPC `agent:audit:read`；`sk-live-*`、`Bearer`、`token` 字段在 smoke 中真实落盘后回读校验
- 单测覆盖：意图路由、参数校验、上下文裁剪、审计写入 —— ✅ 全套 1132/1132，其中机型落盘 26 条（`test/agent/apply-machine-design.test.mjs`）、模板 9 条、追问 9 条、PLC 模拟验证 21 条、放置类 21 条（`test/agent/place-component.test.mjs`）、工具扩展 v1 30 条（`test/agent/tools-v2.test.mjs`）
- 侧栏只读问答 UI —— ✅ P7-A-2：输入即出计划预览（只读标「可离线」、写操作标「需联网确认」并点名缺参）、在线/离线共用一张回执（通道·耗时·工具次数·失败数）、审计面板展示最近 8 条与汇总；`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`，预览前后场景零件数不变（当前全套 1132/1132）
- 评估集与回归 —— ✅ 74 条中文用例（20 工具全覆盖 + 6 类拒绝），`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（74/74 意图、74/74 工具、40/40 参数、5/5 超纲拒绝、5/5 多步）；真实模型 36 条评测 `matched=36/36`、`refusalRate=1.00`（见 9.1，含历史三轮迭代与本轮结果）
- 确认与路径策略 —— ✅ 策略层纯函数 + `executeTool` 硬确认 + 拒绝后短路 + 回复话术过滤；导出默认只接受纯文件名，绝对路径/盘符/UNC/`../` 返回 `TARGET_PATH_UNSUPPORTED`，`allowSanitize=true` 才净化落盘；`policy.test.mjs` 42 条，smoke `SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1`
- 底板放置与撤销 —— ✅ P7-B：`place_component` 走命令总线与真实 `window.__Enclosure`，越界/重叠返回 `OVERLAP`/`OUT_OF_BOUNDS` 告警；`undo_last` 回滚并返回 `removed`；smoke `SMOKE_AGENT_PLACE_OK placed=1 undo=1`
- 多步规划 —— ✅ P7-C：`planner.ts` 五类组合 + 通用拆句；未知工具过滤 + warning；置信度 < 0.6 拒绝；`executePlan` 顺序执行、写步骤一次确认、失败立即停止、可撤销写回提示 `undo_last`；侧栏计划卡片支持全部/逐步/取消与逐项打勾；smoke `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`
- 待补：写操作的逐步确认 UI（当前多步计划一次确认；单步模型工具调用仍是一次性弹窗）
- 可复用流程 —— ✅ P7-I：5 个纯数据模板、占位符、前置条件拦截、步骤可跳过、写工具逐次确认（默认）、失败停止保留已完成、Markdown 记录；`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`

## 8. 交互形态原文

1. **侧栏聊天**（主）：右侧抽屉，支持工具执行进度、结果卡片（表格/图片/文件）与取消
2. **命令面板**（快）：`Ctrl+K` 模糊搜索 + 自然语言混合，回车即执行只读命令
3. **@ 对象**：在画布/原理图上选中元件后 `@`，指令自动带上该对象
4. **语音**（后期）：本地 STT，仅对白名单指令生效
5. **主动建议**（P7-H）：侧栏顶部按工程状态给出 0–3 条 next-best-action，见 8.4

### 8.1 执行反馈（P7-F）

工具调用通过主进程 `agent:progress` 事件逐条推送到侧栏，在线模型与离线规则共用同一套字段：

| 阶段 | 侧栏表现 |
|---|---|
| 执行前 | 「正在执行 `tool` · 第 n/N 步」+ 参数摘要；参数按字段名与裸文本双重脱敏，长值截断 |
| 执行中 | 每 500 ms 刷新秒表；超过 10 s 追加「仍在执行，可取消」 |
| 完成 | 结果卡片：`✓` 成功 / `×` 失败 + 耗时 + 结果码；连续 3 步追加「连续 3 步汇总耗时」 |
| 取消 | 侧栏「取消执行」→ `agent:chat:cancel` / `agent:plan:cancel` → `AbortController.abort()`；会话与计划执行器都在步骤边界检查信号 |

取消文案不把未知状态说成安全：确认没有写步骤时输出「已取消，未写入任何更改」；已有写步骤完成时列出「第 n 步 tool（成功）」，并提示可撤销的装配写可用 `undo_last`；当前写工具被中断但结果未知时明确要求先核对装配体/文件。

### 8.2 失败建议（P7-F）

`src/agent/suggest.ts` 是纯函数 `{code, message, tool, args} → {advice, alternatives}`，失败卡片与多步计划都复用：

| 错误码 | 建议口径 |
|---|---|
| `PART_NOT_FOUND` | 先 `search_components`，给出型号关键词，并检查数据包是否启用 |
| `NO_DIMENSIONS` | 换带尺寸的同系列型号，或到元件库补录 `dims{w,h,d}` |
| `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` | 分别检查对应服务（如 Python sidecar）或启动桌面应用、7420 端口与 token 文件 |
| `PRECHECK_FAILED` | 引用结果里的第一条错误，并按点位/执行机构/传感器指向修复位置；强调未落盘 |
| `USER_DENIED` | 明确未执行、装配体与文件未改动，并说明重新发起与点「允许」的路径 |
| 未知码 | 只复述错误码与消息，明确「无法判断具体原因」，不编造原因 |

### 8.3 审计面板（P7-F）

- 列表列：时间、工具、参数摘要、结果码、耗时；按时间倒序。
- 按工具与结果（全部 / 仅成功 / 仅失败）筛选；导出当前筛选结果为 CSV，文件名走统一 `sanitizeFileName`，内容带 UTF-8 BOM。
- 单条展开显示完整 JSON；整条记录再次递归脱敏，历史记录里的裸密钥也不会重新出现在界面或导出文件。
- 最多展示最近 200 条；更早记录丢弃并在面板提示数量。
- 轮转与保留期（2026-10-24）：当前文件超过 `maxBytes`（默认 5 MB）时在行边界滚动为 `agent-audit.1.jsonl`，旧份顺延，最多保留 `maxFiles`（默认 5）份；按文件 mtime 整份清理超过 `retentionDays`（默认 90 天，0 = 不按时间清理）的份数。参数写在 `userData/agent-audit-retention.json`（`{maxBytes, maxFiles, retentionDays}`，非法值回落默认，`maxBytes` 下限 64 KB）。
- 面板读取当前文件 + 全部保留的轮转份数（最旧 → 最新拼接），汇总「共 N 条」覆盖全部份数，列表仍是最近 200 条；CSV 导出的是面板当前列表。已被保留期删除的份数不可恢复。轮转/清理失败不影响写入（继续追加到当前文件）。冒烟 `SMOKE_AGENT_AUDIT_ROTATED_OK rows=3 files=2`。

### 8.4 主动建议（next-best-action，P7-H）

`desktop/src/agent/advisor.ts` 是纯函数 `suggestNextActions(context, projectState, options?)`：输入 `AgentContext` + 项目状态摘要（BOM 行数、未放置件数、干涉检查命中数、缺尺寸件数、是否有 CAD、电气校验是否通过、成本是否过期、PLC 是否已生成、电气严重问题数），输出 0–3 条 `{id,title,why,action,weight}`。`why` 必须引用输入里的真实数字；排序按 `weight` 降序，同分保持规则表顺序；`options.ignored` 由调用方传入本次会话忽略的 id，引擎本身不保存状态。

| 顺序 | id | 触发条件 | 建议标题 | 动作 |
|---:|---|---|---|---|
| 1 | `overlap` | `context.plate.overlaps > 0` | 查看 N 处重叠 | `ask`「底板哪里重叠了」 |
| 2 | `elec-failed` | `elecCheckPassed === false` | 先修 N 处相序/线径问题 | `ask`「电气校验哪些地方没通过」 |
| 3 | `interference-hits` | 有 CAD 且 `conflicts > 0` | 处理 N 处干涉 | `ask`「CAD 哪里干涉了」 |
| 4 | `missing-dimensions` | `missingDimensions > 0` | 这 N 个件没有尺寸，底板画不了 | `ask`「哪些件缺少尺寸」 |
| 5 | `interference-unchecked` | 有 CAD 且 `conflicts === null` | 跑一次干涉检查 | `tool: run_interference_check` |
| 6 | `cost-stale` | 成本结果早于 BOM 变更 | 成本已过期，重算 | `tool: run_cost_report` |
| 7 | `plc-missing` | BOM > 0、未放置 0、缺尺寸 0、PLC 未生成 | 按当前选型生成 PLC | `tool: run_plc_generate` |
| 8 | `deliver-package` | BOM > 0、有 CAD、未放置 0、干涉 0、缺尺寸 0、电气通过、成本未过期、PLC 已生成 | 导出交付包（BOM+PDF+PLC） | `ask`「导出交付包：BOM、PDF 和 PLC」 |

权重依次为 `100 / 95 / 90 / 85 / 70 / 65 / 60 / 50`；默认最多 3 条，0–3 之间可配置，无命中返回空数组，不凑数。`conflicts: null` 表示「有 CAD 但还没跑过干涉检查」，因此不会把「检查结果 0 处」误判成「没检查」。

侧栏行为：
- 「建议」区固定在侧栏顶部，每张卡片显示标题、一句带数字的依据与动作类型；
- `ask` 卡片点击后把 prompt 填入输入框（不自动发送）；`tool` 卡片生成一张单步计划确认卡，用户点「全部执行」后才调用，写工具仍由 `executePlan` 再弹一次确认；
- 「忽略」只写入本次会话的内存 `Set<string>`，刷新建议时作为 `options.ignored` 传入，同一会话不再出现，重开应用后恢复；
- 每次工具执行结束（`agent:progress` 的 `end` 事件）、对话结束、计划执行结束都会刷新建议；刷新只更新建议列表 DOM，不重建对话、不清空输入框、不打断正在进行的会话。

冒烟：`SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`；单测 `test/agent/advisor.test.mjs` 21 条，覆盖每条规则命中/不命中、优先级、上限、空状态、忽略与刷新不复活、`why` 数字、BOM 指纹。

### 8.5 输出纠错与重试（P7-J）

真实模型在长任务里仍会出现代码围栏、前后解释、单引号、尾逗号、注释、单位字符串、字符串布尔/整数和截断。会话层不再直接 `JSON.parse`，而是统一走 `repairToolCall(raw, schema, ctx)`（纯函数，`desktop/src/agent/repair.ts`）。

修复顺序与边界：

| 现象 | 处理 | repairs 记录 |
|---|---|---|
| ```json 围栏 / 前后解释文字 | 先剥围栏，再逐字符扫描第一个平衡的 JSON 对象/数组（不靠贪婪正则） | `stripped code fence` / `stripped surrounding text` |
| 单引号、尾逗号、`//` 注释 | 只在字符串外修改，URL 里的 `//` 不动 | `converted single quotes to double quotes` / `removed trailing commas` / `removed // comments` |
| `"120mm"` 且 schema 为 number | 仅去掉明确单位（mm/cm/m/in/°/deg/%/毫米等） | `converted "120mm" to 120 (number)` |
| `"true"`/`"false"` 且 schema 为 boolean | 转布尔 | `converted "true" to true (boolean)` |
| 纯数字字符串 `"3"` 且 schema 为 integer | 转整数 | `converted "3" to 3 (integer)` |
| `"3 个"`、`"很多"` | **不猜**，按原值交给 schema 校验并拒绝 | 无 |
| 必填 `partId` 缺失且有选中对象 | 只从 `ctx.selection.id` 回填 | `filled from selection` |
| 未知字段且 `additionalProperties:false` | 删除并记录，不静默通过 | `removed unknown field <path>` |
| 结尾截断 | 最多补 3 层 `}`/`]`（字符串未闭合时先补引号） | `completed truncated JSON (n layers)` |

修复后必须通过 JSON Schema 校验；失败返回 `SCHEMA_INVALID` + 首个错误路径与中文消息，例如 `参数 qty 应为整数，收到 "3 个"`、`参数 bom[0].qty 应为整数...`。截断无法安全补全返回 `TRUNCATED_JSON`；没找到 JSON 对象返回 `NO_JSON`。

重试与回落（`desktop/src/agent/retry.ts`）：

- 参数修复/schema 校验首次失败 → 会话把无效输出作为普通 assistant 文本回灌，并追加 `上次输出错误：<原因>。只输出 JSON，不要代码围栏、解释文字或多余字段。`，重试 1 次；
- 重试成功 → 继续执行修复后的工具调用，写审计 `TOOL_CALL_RETRY_OK`（`retries:1`、`reason`）；
- 重试仍失败 → 不再空转，返回「没听懂…没有执行任何工具」+ 两条按用户原话匹配的候选指令（`候选 1/2：`），侧栏渲染为可点击按钮，点击只填入输入框、不自动发送；审计 `TOOL_CALL_INVALID` → `TOOL_CALL_FALLBACK`；
- 首次就修复成功（未重试）也会写 `TOOL_CALL_REPAIRED`，带 `repairs[]` 与 `retries:0`，避免「悄悄改参数」；审计字段新增 `retries / reason / repairs`，仍走 `maskSecrets` 脱敏。

模型端第一道保险：`OpenAiCompatibleClient` 默认在有工具时发送 `response_format:{type:'json_object'}`；若端点以 400/404/422/500 明确表示不支持 `response_format`，自动去掉该字段并重试一次，不把兼容性错误暴露给用户。`response_format:false` 可关闭。

测试与冒烟：`desktop/test/agent/repair.test.mjs` 39 条覆盖围栏/废话/单引号/尾逗号/注释/单位/布尔/整数/多工具串/截断成功与失败/schema 中文路径/禁止猜测/selection 回填/未知字段/重试成功/重试回落/审计；LLM 三条覆盖 response_format 与降级。冒烟新增 `SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`。

### 8.6 上下文预算与成本（P7-M）

目标：不让 25 个工具 schema、长工具结果与多轮历史无限堆积；同时把每轮真实/估算 token 与费用直接展示给用户。

**预算模型**（`desktop/src/agent/budget.ts`，纯函数）

- `estimateTokens(text)`：CJK 字符按 **1 token ≈ 1.6 字符**，其他字符按 **4 字符 ≈ 1 token**，向上取整；用于预算与回落估算，端点回传 usage 时以真实值为准。
- 档位：`system / selection / memory / docs / toolResults / history`。默认总量 **12k tokens**，单档默认 `4000 / 1500 / 1200 / 2500 / 5000 / 3000`，都可通过 `BudgetOptions` 配置。
- `pack(payload, options)` 返回 `{text, used, dropped, sections, docsSources}`。裁剪优先级：**history < docs < toolResults**；`system` 策略段**永不裁剪**，即使自身超过总量也只追加 `system_protected` 原因。
- 超限顺序：先收敛长列表（保留**首尾各 5 条 + total**，插入「已省略 N 条，共 M 条」），再丢最旧的 history，最后才移除 docs 与 toolResults；每条 `dropped` 都带 `section + code + 可读中文原因`。
- 会话接入：`session.ts` 每轮把 `SYSTEM_PROMPT + 工程上下文 + thread + memory` 装包为系统段；历史消息按「用户轮次」成组裁剪，避免拆散 assistant/tool 协议对；`trim.ts` 仍负责单条工具结果的首轮 10 KB 收敛。

**成本可见性**

- `llm.ts` 解析端点 `usage.prompt_tokens / completion_tokens`；缺失时 `session.ts` 按消息 + 工具 schema / 回复 + tool_calls 估算，并在快照中标记 `estimated:true`。
- 会话维护本轮与本会话累计：`promptTokens / completionTokens / totalTokens / requests / estimated`；取消或失败也返回已发生的用量。
- 价格唯一来源 `desktop/src/agent/pricing.json`：`currency`、`unit`（默认 1000，即元/千 tokens）与 `models.{name}.{input,output}`；支持最长前缀匹配（`gpt-4o-mini-2026-01`）。已知模型按输入/输出分别计价，默认零价显示 `¥0.0000`；**未知模型显示 `—`**，不猜价格。
- 侧栏底部「上下文成本」显示本轮 / 本会话 tokens、输入输出拆分与估算费用；端点缺 usage 时明确标「估算」。
- 审计行新增 `promptTokens / completionTokens / estimated / docsSources`；`search_docs` 命中时 `docsSources` 记录实际来源数，便于回答「这句结论引用了哪些文档」。
- 冒烟：`SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`；单测 `desktop/test/agent/budget.test.mjs` 21 条，覆盖估算误差、优先级、system 保留、首尾截断、usage 回落、费用格式化、未知模型与审计字段。

### 8.7 执行效率：去重/并行/缓存（P7-N）

目标：不让模型在同一轮里重复查同一件事，也不让互不依赖的只读检查排队串行。三块能力都只作用于 `AgentSession` 的工具调用循环，不改工具注册表、不绕过写确认。

**A. 同轮去重（`dedupe.ts`）**

- 键为 `(tool, canonicalArgs)`：对象键排序、字符串去首尾空白并压缩连续空白、数字与纯数字字符串统一为最短数值文本；`{"x":" 1.0 "}`、`{"x":"1"}` 与 `{"x":1}` 命中同一键。
- 同一轮（可能跨多次模型迭代）内第二次及以后只复用首次结果，工具结果带 `reused:true` 与 `reuseSource:'dedupe'`。
- 写工具永不合并：即使参数完全相同，每次都独立确认、独立执行；写工具不进入去重账本。
- 单轮最多 12 次工具调用（含重复调用）。第 13 次起返回 `TOO_MANY_TOOL_CALLS`，消息明确要求拆分为多轮。

**B. 只读并行（`parallel.ts`）**

- 一次模型响应里的连续只读调用按批并发，默认并发度 3（`parallelConcurrency` 可配）。
- 参数中出现 `$0`、`${1}`、`{{0.data}}`、`{{step0...}}` 一类前序结果占位符时，该步自动降级为串行，不猜依赖。
- 写工具单独成批并形成屏障：写前的只读批先结束；同一响应内写后的只读步骤全部逐个串行，避免读到旧状态。
- 任一调用失败不取消已发出的其他调用；结果按原调用顺序回灌，失败码与消息原样保留。

**C. 会话短缓存（`cache.ts`）**

- 仅缓存 `get_bom` / `get_project_context` / `list_components`，键为 `(tool, 规范化参数, projectFingerprint)`，TTL 默认 30 秒。
- 只缓存成功结果；任何写工具执行前后都会立即清空缓存（BOM / 底板 / 成本派生数据一起失效）。
- 指纹变化视为未命中并删除旧条目；缓存只存在于当前 `AgentSession` 内存，不落盘、不跨会话。
- 命中时结果带 `reused:true` / `cacheHit:true`，审计行写 `cacheHit:true`，进度卡与审计行显示「已复用」。

**实测延迟对比（本机，2026-10-23）**

真实 `agent:live` 本轮没有可用凭据（`AGENT_LIVE_SKIP`），因此没有伪造改造后的模型端到端 p50/p95。下表是用同一套 `AgentSession` + 固定 100 ms/工具的本机桩延迟实测，验证执行路径本身：

| 场景 | 改造前路径 | 改造后实测 | 说明 |
|---|---:|---:|---|
| 两次只读查询，分两次模型迭代 | 211 ms | 102 ms | 同一响应内并发，最大并发 2 |
| 同一关键词调用 3 次 | 约 303 ms | 102 ms | 实际执行 1 次，2 次 `reused:true` |
| 连续两轮 `get_bom` | 101 + 101 ms | 101 + 2 ms | 第二轮会话缓存命中 |

当前真实评测基线为 36 条用例的 **p50 7.9 s / p95 31.3 s**（`deepseek-v4.1-flash`，详见 9.1）。配置 `AGENT_LIVE_BASE_URL / AGENT_LIVE_API_KEY / AGENT_LIVE_MODEL` 后应重跑 `npm run agent:live`；当前不把桩延迟与模型延迟混为一谈。

**验证**：新增 `desktop/test/agent/efficiency.test.mjs` 33 条（含写后不复用写前结果）；`tsc` 干净、`npm test` 1034/1034、`SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`、`npm run eval:agent` 65/65。

**限制**

- 并行仅限「无依赖的只读工具」；写工具、依赖前序结果的步骤、未知工具都按串行处理。
- 依赖识别只认显式占位符，不做自然语言推理；模型若把依赖值直接写死，仍会按独立调用处理。
- 缓存只在本会话内存、只覆盖 3 个查询工具、只保留 30 秒；不跨会话、不落盘，也不缓存失败结果。
- 单轮 12 次上限按模型请求的调用数计算，重复调用也计数；超出后必须拆分为多轮。


