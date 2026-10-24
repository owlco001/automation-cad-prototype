# 模块：Agent 接口（src/agent/）

职责：让外部 Agent（Hermes / Codex / Claude Code）用同一套工具驱动软件，而不是只靠人点界面。

## 两个入口，一份注册表

```
tools.ts（AgentTools + 21 个 AgentTool；含只读 `suggest_kinematics`；含只读 `design_machine` 与写工具 `apply_machine_design`）
 ├─ kb/index.ts → 构建期分块 + kb.json（≤400 KB，标题 hash）
 ├─ kb/search.ts → 纯函数 BM25（中文 2-gram + 英文词，top 3 / ≤2 KB）
 ├─ rpc.ts        → HTTP JSON-RPC，127.0.0.1:7420，Bearer token
 ├─ mcp.ts        → MCP stdio server，工具定义直接复用
 ├─ mcp-proxy.ts  → stdio MCP → 桌面 RPC 写工具代理（10 秒超时）
 └─ commands.ts
      ├─ CommandBus        注册、执行、history、撤销栈
      └─ RendererBridge    BrowserWindow.webContents.executeJavaScript（10 秒超时）

应用内对话
 ├─ llm-config.ts  → userData/agent-llm.json（600，UI 只读掩码）
 ├─ llm.ts         → OpenAI 兼容 /chat/completions + tools
 ├─ session.ts     → 工具调用循环（最多 maxIterations，历史 20 条）+ 多轮状态注入
 ├─ dedupe.ts      → 同轮 (tool, canonicalArgs) 去重 / 写不合并 / 单轮 12 次上限
 ├─ parallel.ts    → 只读批并发（默认 3）/ 依赖降级串行 / 写屏障 / 保序结果
 ├─ cache.ts       → 会话内 30 s 结果缓存（BOM / 上下文 / 元件列表）
 ├─ thread.ts      → ThreadState / 工程指纹 / completedSteps / pendingConfirm / runPlan 续跑
 │    ├─ router.ts  → 离线规则意图路由（7 类 + 只读工具计划）
 │    ├─ planner.ts → 多步规划 plan() + 顺序执行 executePlan()（P7-C）
 │    ├─ recipes.ts → 5 个流程模板 + runRecipe 前置条件/跳过/逐次确认/失败报告（P7-I）
 │    ├─ repair.ts  → 模型脏输出纠错（围栏/解释/单引号/尾逗号/注释/类型转换/截断）（P7-J）
 │    ├─ retry.ts   → 失败重试提示与两条候选回落（P7-J）
 │    ├─ policy.ts  → 绕过确认意图识别 / 回复话术过滤 / 导出目标路径判定
 │    ├─ context.ts → 结构化上下文快照（≤1.5 KB）+ 历史工具清单文本块
 │    ├─ reference.ts → 选中/最近操作/几何三级指代消解（<0.6 不猜）
 │    ├─ memory.ts  → 最近 5 次工具调用摘要（仅内存）
 │    ├─ trim.ts    → 列表 20 条 / 文本 2 KB / 单结果 10 KB 裁剪
 │    ├─ audit.ts   → 每次工具调用一行 NDJSON（凭据脱敏 + 耗时）
 │    ├─ audit-store.ts → 审计落盘：按大小轮转 agent-audit.N.jsonl + 保留期清理 + 跨份读取（仅主进程）
 │    ├─ audit-view.ts → 审计筛选 / 时间倒序 / 200 条上限 / CSV
 │    ├─ feedback.ts → 进度事件 / 参数摘要 / 耗时 / 取消文案
 │    ├─ suggest.ts → 失败建议纯函数（六类错误码 + 未知码回落）
 │    ├─ advisor.ts → 主动建议纯函数（0–3 条 next-best-action + BOM 指纹）
 │    └─ preview.ts → 侧栏视图模型（计划预览 / 统一回执）
```

渲染层通过 `extension.ts` 暴露受控的 `window.__AgentBridge`，不暴露 DOM。主进程命令总线只允许调用白名单方法。

## 数据结构

```ts
interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  handler(args): Promise<unknown>;
}

interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface Bridge {
  call<T>(method: string, args?: unknown): Promise<T>;
}
```

| 工具 | 参数 | 命令 | 状态 |
|------|------|------|------|
| `list_components` | `q? / category? / packId?` | 无（直接读 registry） | ✅ 可用 |
| `search_components` | `q` | 无（直接读 registry） | ✅ 可用 |
| `search_docs` | `query / limit?` | 无（直接读内嵌 `kb.json`） | ✅ 只读：来源 + 标题 + 摘要 + 分数；无命中返回空 |
| `design_machine` | `brief / stationCount? / cyclePerMin?` | 无 | ✅ 只读：需求抽取 + 方案合成，不落盘、不改工程 |
| `apply_machine_design` | `brief? / design? / name? / overwrite? / withBom? / withPlc?` | `apply_machine_design` | ✅ 写：brief 与 design 二选一；校验后写 `machine/<id>.json` + `active.json`，默认追加 BOM，可选 PLC `io-map.csv`；需确认、可撤销、刷新 3D |
| `import_cad` | `path` | `import_cad` | ✅ 可用 |
| `get_bom` | 无 | `get_bom` | ✅ 简化 BOM |
| `get_project_context` | 无 | `get_project_context` | ✅ 只读：域/视图/选中/机型/底板/单位/最近操作，缺失为 null |
| `run_interference_check` | 无 | `run_interference` | ✅ 前 20 条 |
| `suggest_kinematics` | `includeLow? / limit?` | `suggest_kinematics` → 渲染桥 `suggestKinematics` | ✅ 只读：返回压缩后的高/低置信度建议，只刷新标注抽屉建议列表，`applied=false`，从不写标注 |
| `insert_component` | `partId / name?` | `insert_component` | ✅ 可撤销 |
| `place_component` | `partId / x / y / rotate? / railSnap?` | `place_component` | ✅ 底板放置，可撤销；越界/重叠只告警 |
| `update_component` | `partId? / ref? / model? / qty? / remark? / target?` | `update_component` | ✅ 改型号/数量/备注，可撤销；无尺寸返回 `NO_DIMENSIONS` 告警 |
| `remove_component` | `partId? / ref? / target?` | `remove_component` | ✅ 从底板或 BOM 移除，可撤销；不存在返回 `NOT_PLACED` |
| `run_electrical_check` | `wires / loads / circuits / options` | `run_electrical_check` | ✅ 只读，问题清单前 50 条 |
| `run_cost_report` | `bom? / pricebook? / placements? / plate? / plc? / options? / overrides? / wireSection? / now?` | `run_cost_report` | ✅ 只读，明细前 50 行、缺价/告警各 20 条 |
| `run_plc_generate` | `config? / target? / namePrefix? / sequenceTimeoutMs?` | `run_plc_generate` | ✅ 写：11 文件 + ZIP 落盘 `userData/exports/plc/`；预检失败不落盘 |
| `export_files` | `kind / fileName? / overwrite?` | `export_files` | ✅ 写：pdf/dxf/glb/bom(CSV)，与成本导出一套命名净化/冲突规则 |
| `export_cost_report` | `format / fileName? / overwrite?` + 同上成本参数 | `export_cost_report` | ✅ 写工具：PDF/CSV 落盘到 `userData/exports/`，需确认 |
| `verify_plc_program` | `config? / timeScale? / safetyTripAtStep? / sensorConflictAtStep?` | `verify_plc_program` | ✅ 只读：预检 + 生成 + 内置模拟器，返回步骤/报警/失败原因 |
| `undo_last` | 无 | 直接 `CommandBus.undoLast()` | ✅ 可用 |

`get_bom` 的 BOM 由「当前 CAD 零件 + 已插入占位件」生成：序号递增、名称/型号取零件名、数量 1、材料 `—`，并带 `note` 说明这是简化 BOM。没有模型时返回空数组。

机型落盘的校验、文件读写与 BOM 行转换在 `src/machine/store.ts`；PLC 点位映射在 `src/machine/io-map.ts`，复用 `plcgen/io.ts` 与 `plcgen/tags.ts`，只输出 CSV、不复制完整 ST 生成逻辑。`apply_machine_design` 校验失败返回 `INVALID_ARGUMENT`，同名文件默认 `FILE_EXISTS`，写入失败返回 `WRITE_FAILED`；确认拒绝时不调用命令总线、不创建目录。

## 本地知识检索（kb/）

- `kb/index.ts`：构建期读取 `docs/desktop/` 的 13 份文档、`screenshots/` 文件名和 `packs/builtin/*/parts.json` 分类名；按 Markdown 标题切块（≤800 字符），`source` 为 `文件#标题路径`，附 `line`。`buildKnowledgeBase()` 输出 `{meta,chunks}`；`meta.sources[].headingHash` 是标题列表 SHA-256。
- `kb/search.ts`：启动只加载 `kb.json`，不扫盘、不联网。中文 2-gram、英文/数字按词切分；简化 BM25（k1=1.5、b=0.75）+ IDF；默认 top 3、`limit` 1–5；没有查询词命中返回 `[]`，不做模糊兜底。结果整体压到 2048 字节内。
- `scripts/build-kb.mjs` / `npm run kb:build`：重建并写回 `kb.json`；超过 400 KB 时只保留前 200 块并写 `truncated/droppedChunks`。
- 系统提示要求「怎么操作 / 限制 / 决策 / 为什么」先调 `search_docs`；命中引用 `source` 与 `heading`，无命中直说查不到。
- 测试 `test/agent/kb.test.mjs` 18 条：分块/source/line、800 字符、2-gram、导轨/干涉/D2、无命中、top3、1–5、2 KB、400 KB、截图/分类、标题 hash 同步与工具参数校验。

## 可复用流程模板（P7-I）

`recipes.ts` 与 `planner.ts` 一样是无 IO 的共享模块，渲染层用它做预览，主进程用它执行，单测用注入执行器验证。

```ts
RECIPES: Recipe[]  // 5 个：new-machine / plate-delivery / electrical-delivery / cost-review / full-package
// Recipe = { id, title, summary, steps[], preconditions[], estimatedSeconds }
// Step   = { id, title, tool, args, why }
// Precondition = { id, label, from, action, nonEmpty?, min? }

runRecipe(recipeId, ctx, executor): Promise<RecipeRunResult>
// executor = { execute(step,index), confirm?(request), skipSteps?, skipIndexes?,
//              isSkipped?, rememberSameKind?, signal?, now?, onProgress? }
// → { ok, code, results[], completed[], kept[], skipped[], failedStep?, failedAt?,
//     errorCode?, suggestion?, missing?, suggestions?, totalMs, summary, report, error? }
```

模板规则：

| id | 标题 | 步骤 |
|---|---|---|
| `new-machine` | 新机台快速起步 | `import_cad` → `get_bom` → `run_interference_check` → `run_electrical_check` → `run_cost_report` |
| `plate-delivery` | 底板布置交付 | `get_bom`（缺尺寸）→ `get_project_context`（未放置）→ `run_interference_check`（底板冲突）→ `export_files` |
| `electrical-delivery` | 电气交付 | `run_electrical_check` → `get_project_context` → `verify_plc_program` → `run_plc_generate` → `export_files(pdf)` |
| `cost-review` | 成本核对 | `get_bom` → `run_cost_report` → `export_cost_report(csv)` → `run_cost_report`（缺价件标注） |
| `full-package` | 整包交付 | 导入 CAD、BOM、干涉、电气、成本 → `export_files(bom)` → `export_files(pdf)` → `run_plc_generate` |

- **schema**：`validateRecipe` / `validateRecipes` 校验 id、标题、步骤 id/标题/工具/args/why、前置条件字段与 `estimatedSeconds`；工具名必须存在于 `DEFAULT_RECIPE_TOOL_NAMES`（或调用方传入的实时注册表名称）。
- **占位符**：`resolveRecipeArgs(args, ctx)` 递归解析 `{from:'context.machine.name'}`、`{from:'context.bom.0.partId'}`，支持 `default` / `optional`；缺失返回点路径数组，执行时转为 `MISSING_CONTEXT` 并停止。
- **前置条件**：`checkRecipePreconditions(recipe, ctx)` 支持字符串非空、数组非空与 `min`；失败返回 `code='PRECONDITION_FAILED'`，`missing` 是中文标签、`suggestions` 是建议动作，`results=[]` 且零工具调用。
- **跳过与确认**：`skipSteps` 接受步骤 id / 工具名 / 1 基序号，`skipIndexes` 是 0 基；跳过的步骤标 `skipped:true`。写工具默认每步调用 `confirm()`；`rememberSameKind:true` 才在首个同类写操作后免问（UI 默认关）。没有确认回调时返回 `CONFIRMATION_REQUIRED`，绝不静默执行。
- **失败与记录**：任一步 `ok:false` / 业务码 / 异常都会停止，`completed/kept` 保留成功步骤；`suggest` 生成中文建议，`report` 写明失败步骤、错误码、建议与已完成清单。每步 `elapsedMs`、总计 `totalMs` 由注入时钟记录。
- **Markdown**：`recipeRunToMarkdown(result)` 输出模板、状态、耗时、步骤表、失败详情、已完成 / 已跳过与参数摘要，侧栏「导出本次执行记录」直接写 `.md`。

IPC / UI：
- `agent:recipe:execute` 接收 `{recipeId, context?, skipSteps?, rememberSameKind?}`，主进程再次走 `runRecipe`，写步骤弹「流程写操作确认」，审计 `source='recipe'`，进度事件 `source='recipe'` 复用 `agent:progress`；`agent:recipe:cancel` 中断当前流程。
- 侧栏「流程」区：下拉 5 个模板、前置条件红/绿、步骤复选框、`开始` / `取消流程` / `导出本次执行记录`；执行中步骤 `…`，完成 `✓`，失败 `×`，跳过 `—`。
- 冒烟：`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`；`SMOKE_AGENT_RECIPE_UI_OK recipes=5 steps=5`。

## 离线路由 / 上下文 / 审计（P7-A）

断网或模型未配置时不能「什么都问不了」，也不能偷偷执行写操作，因此这三块独立成纯函数模块。

```ts
type IntentKind = 'query'|'compute'|'modify'|'generate'|'commission'|'sync'|'out_of_scope';

interface IntentMatch { intent: IntentKind; confidence: 'high'|'medium'|'low'; score: number; hits: string[]; reason: string }
interface ToolPlan { tool: string; args: Record<string,unknown>; readOnly: boolean; missing: string[]; why: string }

routeIntent(text): IntentMatch            // 关键词计分，写操作优先裁决
planTool(text): ToolPlan | null           // 中文指令 → 工具 + 参数
planReadOnly(text): ToolPlan | null       // 仅 readOnly 且在白名单内，离线通道只认这个
extractQuery(text): string                // 去客套话/动词/疑问词/类别词

buildAgentContext(input, limit = 2048): { text, bytes, truncated, toolCount, droppedTools, droppedRecent }
createAuditLog({ write, now?, onError? }): { record, entries }
maskSecrets(text): string                 // sk- / Bearer / token= / X-Design-Key
redactValue(value): unknown               // 按字段名脱敏，数组截 20 项，深度 4
parseAuditLines(text): AgentAuditEntry[]  // 坏行跳过
summarizeAudit(entries): { total, failed, tools, lastAt }

// audit-store.ts（唯一碰文件系统的审计层，只在主进程用）
DEFAULT_AUDIT_RETENTION = { maxBytes: 5 MB, maxFiles: 5, retentionDays: 90 }
loadAuditRetention(userDataDir)           // 读 userData/agent-audit-retention.json，缺失/损坏回落默认
normalizeAuditRetention(partial)          // 非法值回落默认；maxBytes ≥ 64 KB、maxFiles 1–50、retentionDays 0–3650（0 = 不按时间清理）
createAuditFileWriter(file, { retention?, now?, onError? }): (line) => void  // 写前超限先轮转，创建时先清理
rotateAuditFile / pruneAuditFiles / listRotatedIndexes / rotatedAuditPath
readAuditEntries(file, retention?): { entries, files }  // 最旧轮转 → 当前，坏行跳过
```

- 意图规则：`query / compute / modify / generate / commission / sync`，全 0 命中判 `out_of_scope`；同分按 `modify > generate > sync > commission > compute > query`，保证「搜索并插入」不会被当成只读查询。
- `planTool` 先判写（导出成本报告、插入、撤销、导入），再按 `干涉 → 电气校验 → 成本 → BOM → 元件` 的具体到泛顺序；类别同义词（空开→断路器、热继→热继电器…）按长度倒序匹配，避免「继电器」吃掉「热继电器」。
- 同义/口语覆盖（迭代：审计轮转 + 路由同义词）：查询「有啥/有没有/看下/检索/罗列/调出/物料明细/用料清单」、计算「花多少/造价/价钱/核算/撞到/打架/线径/三相平衡/校核/哪些零件会动/可动件」、修改「新增/加装/去掉/拿掉/删了/撤回/回退/载入/加载/换为/调成/设为」、生成「输出/另存为/存成/做个…报价单/编一个 PLC 程序」、PLC「仿真/空跑/试运行」、机型「规划/搞一台」、文档「咋放/咋用/怎样用」。新增词同时落在意图关键词与对应工具触发正则上，两层保持一致。
- 非工程话题拦截：`isOffDomainTopic()` 对天气/电影/新闻/机票/外卖/股票/房贷/写作等话题直接判 `out_of_scope`（句子里同时有机台/元件/BOM/PLC 等工程锚词时不拦），防止扩充的口语动词把闲聊拉进查询/计算。
- 抽词顺序：`STOPWORDS` 中「库里/库中」先于「里」，`QUERY_VERBS` 中「检查一下/检查」先于「查一下」，避免残留单字进搜索词；「检查一下」计入计算意图，「检查一下有没有零件打架」不再被「查一下」抢成查询。
- 拒绝不回退：`FORBIDDEN_TARGET` 与 `guard.ts` 的 `dangerous_path` 改为匹配 `agent-audit(.N).jsonl`；`AUDIT_TAMPER` 动词补「去掉/拿掉/抹/擦除/移除/隐藏/撤销/撤回/回退/remove」，同义写动词不能绕过审计保护。
- 离线降级：`session.run()` 里 `llm.chat()` 抛错才触发 `runOffline()`；只执行 `planReadOnly`，写计划直接抛回原错误，由 UI 提示需要联网。
- 上下文：`buildAgentContext` 超限时按「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」降级，`truncated/droppedTools/droppedRecent` 如实回报。
- 审计：`session` 每次工具调用（含 `USER_DENIED`/参数非法/离线）回调 `audit`；`ipc.ts` 经 `createAuditFileWriter` 写 `userData/agent-audit.jsonl`，并暴露 `agent:audit:read`（最近 200 条 + 汇总）。写失败只回调 `onError`，不影响对话。
- 轮转与保留期：当前文件「大小 + 本行」超过 `maxBytes`（默认 5 MB）即轮转为 `agent-audit.1.jsonl`（旧的顺延为 .2…，超出 `maxFiles` 默认 5 份删除）；轮转只发生在行边界。保留期按文件 mtime（= 该份最后一条的写入时间）整份删除，默认 90 天，写入器创建时与每次轮转后各清理一次；编号大于 `maxFiles` 的残留一并清理。轮转/清理失败只回调 `onError` 并继续追加到当前文件（宁可超限也不丢审计）。参数可在 `userData/agent-audit-retention.json` 写 `{maxBytes,maxFiles,retentionDays}`。
- 读取：`agent:audit:read` 用 `readAuditEntries` 按「最旧轮转 → 当前」拼接全部保留份数，`total/summary` 覆盖全部份数，列表仍只回最近 200 条（`dropped` 如实回报）；CSV 导出的是面板当前列表（筛选后、≤200 条）。`npm run agent:report` 同样连同轮转份数统计。脱敏在写入前完成，轮转不改写内容；坏行沿用 `parseAuditLines` 跳过。

## 上下文快照 / 指代 / 记忆 / 结果裁剪（P7-E）

四个模块都是纯函数或纯内存类，无 DOM / fs / net 依赖。

```ts
interface AgentContext {
  domain: 'mech'|'elec'|null; view: string|null;
  selection: { kind:'component'|'mesh'|'placement'|'feature'; id:string; label:string } | null;
  machine: { name:string; stations:number; actuators:number; sensors:number } | null;
  plate: { width:number; height:number; placed:number; overlaps:number } | null;
  recentActions: Array<{ tool:string; summary:string; at:string }>;  // 最近 3 条
  units: 'mm';
  bomRows?: number; hasCadModel?: boolean;                  // 多轮工程指纹
  placements?: Array<{ id:string; label:string; x:number; y:number; w:number; h:number }>;
}

collectAgentContext(providers, now?): AgentContext          // 每字段独立容错，失败为 null
serializeAgentContext(ctx, limit=1536): { text, bytes, truncated, droppedRecent, context }
resolveReference(text, ctx): { target, confidence, reason }
trimListResult / trimLongText / trimToolResult / serializeToolResult
AgentMemory.record / entries / prompt / clear
```

- **采集**：`extension.ts` 的 `getProjectContext()` 依次读取底板选中 placement → 运动学选中网格 → 参数化选中特征 → CAD 选中零件，并返回机型、底板与 placement 列表；`commands.ts` 把命令历史摘要（带 `[target=kind:id:label]`）并入 `recentActions`。主进程 `AgentSession.contextProvider` 每轮调 `get_project_context`，失败返回 null 快照，不阻断对话。
- **序列化**：1.5 KB 上限；超限顺序为「删旧 recentActions → 压长字段 → UTF-8 码点边界硬截断」。`[工程上下文]` 中的 recent 摘要会剥掉 target 标记。
- **指代优先级**：选中对象 0.95 → 最近操作对象 0.72 → 几何 placement 0.78；没有候选返回 `NO_CANDIDATES`，对象信息不足返回 `LOW_CONFIDENCE`，低于 0.6 统一 `target:null`。几何排序：左边 x 升序、右边 x 降序、上面 y 升序、下面 y 降序，读序 y→x。
- **路由补全**：`planTool/planToolSequence/planReadOnly` 接收可选 `AgentContext`；命中后把对象填进 `partId` / `ref`，清掉对应 `missing`，并写 `resolvedFrom` / `resolvedLabel`。`preview.ts` 与侧栏步骤卡片据此显示「已使用选中对象：QF1」。
- **会话记忆**：`AgentSession` 每次工具调用后记录 `{tool, args, code}`（关键参数白名单，不含密钥），最多 5 条；系统提示顺序为 `SYSTEM_PROMPT → [上一轮会话] → 上下文快照 → [最近工具调用]`。`clear()` 同时清空记忆。
- **结果裁剪**：`serializeToolResult` 是模型上下文的唯一入口；列表字段 >20 条变成 `{items,total,truncated}`，字符串 >2 KB 截断并附原文字节数，最终 JSON >10 KB 时保留 `ok` 与 `preview` 兜底。

冒烟：`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`、`SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`。单测在 `test/agent/context-memory-trim.test.mjs`（28 条）。

## 上下文预算与成本可见性（P7-M）

`budget.ts` 是纯函数模块，不读文件、不碰 DOM：

```ts
estimateTokens(text): number              // 中文 1.6 字符/token，其他 4 字符/token
truncateToTokens(text, limit, suffix?)    // 完整码点边界内截断
pack(payload, options?): {
  text; used; dropped[{section, code, reason}]; sections; docsSources
}
```

装包档位与默认上限：`system 4000 / selection 1500 / memory 1200 / docs 2500 / toolResults 5000 / history 3000`，总量默认 `12000`，均可通过 `{total, caps, listHead, listTail}` 覆盖。

裁剪规则：

1. 单档超限：长列表先保留首尾各 5 条 + `total`；仍超则按 token 截断。`system` 不参与。
2. 总量超限：先收敛 docs / toolResults 长列表，再按 `history → docs → toolResults → memory → selection` 丢弃。
3. `system` 永不裁剪；若自身超总量，只追加 `system_protected` 原因，`used` 可能高于 `total`。
4. `dropped` 每条都有 `section`、`code` 与中文 `reason`，可直接显示给用户。

成本口径：

- `llm.ts` 的 `LlmChatResponse.usage` 接收 `prompt_tokens / completion_tokens`；`session.ts` 缺失时用消息 + 工具 schema、回复 + tool_calls 估算，`estimated:true`。
- `session.usage()` 返回 `{model, turn, session, cost:{turn,session}, budget?}`；取消/失败也保留已发生用量。`clear()` 同时清零本会话累计。
- 价格表 `pricing.json`（`{currency, unit, models}`）经 `pricing.ts` 的 `normalizePricing` 读取；`budget.ts` 的 `estimateCostView` 做最长前缀匹配与格式化，未知模型 `display:'—'`。
- 审计 `AgentAuditRecord` 新增 `promptTokens / completionTokens / estimated / docsSources`；`search_docs` 结果里的 `hits` 数量会写入 `docsSources`。
- 侧栏 `ui.ts` 底部「上下文成本」渲染本轮/本会话 tokens、输入输出拆分与费用，并标注「估算」。

测试：`desktop/test/agent/budget.test.mjs` 21 条；冒烟 `SMOKE_AGENT_BUDGET_OK used=… dropped=… tokens=…`。

## 执行效率：去重 / 并行 / 缓存（P7-N）

三个模块都不碰 DOM；`dedupe.ts` / `parallel.ts` 是纯函数或纯状态，`cache.ts` 只有内存 Map：

```ts
canonicalArgs(args): string                    // 键排序 + 空白压缩 + 数字字符串归一
new TurnCallDeduper({maxCalls, isWrite}).plan(inputs)
  // → {action:'execute'|'reuse'|'overflow', duplicateOf?, result?, key}
planExecutionBatches(steps): ExecutionBatch[]  // read-only 并发 / write 屏障 / dependency 串行
runReadOnlyBatch(items, execute, {concurrency})
  // → {results 按原序, maxConcurrency, failed}
new ToolResultCache({ttlMs, now}).get/set/invalidateAfterWrite
```

- **去重键**：`canonicalArgs` 递归排序对象键、去首尾空白并压缩连续空白、纯数字字符串归一；`" 1.0 "` 与 `"1"` 等价，普通型号字符串保持原样。
- **账本生命周期**：`TurnCallDeduper` 在每次 `AgentSession.run()` 开始时清空；同轮跨模型迭代仍复用首次结果。写工具不进入账本，每次独立确认。
- **上限**：`toolCallLimit` 默认 12；第 13 次起走 `synthetic` 结果，错误码 `TOO_MANY_TOOL_CALLS`，审计与 UI 都保留本次调用记录。
- **并行边界**：只有 `READ_ONLY_TOOLS` 且参数无显式前序占位符时并发；写工具单独成批，同一响应内写后的只读步骤逐个串行。依赖占位符示例：`$0`、`${1}`、`{{0.data}}`、`{{step0...}}`。
- **失败语义**：`runReadOnlyBatch` 用固定 worker 取任务，单条失败只记录该条，其他已发出调用继续完成；`AgentSession` 按原调用下标回灌 tool 消息。
- **缓存**：`get_bom / get_project_context / list_components`，TTL 30 s，键含 `projectFingerprint`；只缓存成功结果，写工具前后均 `invalidateAfterWrite`。缓存实例属于 `AgentSession`，`clear()` 清空会话历史时也应清缓存（当前会话对象销毁即释放）。
- **审计 / UI**：命中复用走 `finish(..., {cacheHit:true})`，`AgentAuditRecord.cacheHit` 落 NDJSON；`AgentProgressEvent.cacheHit` 驱动进度卡与工具卡显示「已复用」。
- **验证**：`test/agent/efficiency.test.mjs` 29 条；smoke `SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`。本机桩延迟（100 ms/工具）：两次只读 211 ms → 102 ms；三次重复 303 ms → 102 ms；两轮 BOM 101+101 ms → 101+2 ms。

## 多轮状态与续跑（P7-L）

`thread.ts` 是无 IO 的纯状态层 + `runPlan` 包装器；`session.ts` 每轮开始读取、结束写入。

```ts
interface ThreadState {
  turnId: number;
  projectFingerprint: string;   // machine=…;bom=N;placed=N;cad=0|1
  intent: string;
  targets: string[];
  pendingConfirm?: { tool; args; stepIndex; reason:'timeout'|'cancelled'; message? };
  completedSteps: ThreadCompletedStep[];
  lastReplySummary: string;
}
```

- **写入/读取**：`AgentThread.read()/write()/finish()/clear()` 只做深拷贝与自增，不落盘；`AgentSession.clear()` 同时清线程状态。
- **注入**：`formatThreadContext(previous, currentContext)` 输出完成/失败/拒绝、工程指纹差异、未确认操作与跨轮指代目标；系统提示顺序为 `SYSTEM_PROMPT → [上一轮会话] → [工程上下文] → [最近工具调用]`。
- **指纹**：`projectFacts` 取机型名、BOM 行数、底板放置数、CAD 模型有/无；`fingerprintChanges` 返回可读差异。变化时固定文案「工程已变化，不要沿用旧结论」。
- **续跑**：`runPlan(plan, { resumeFrom, previous|thread, currentContext })`，指纹一致时从 `resumeFrom` 起跳过 `completedSteps` 中成功的下标；指纹不同返回 `{refused:true, stale:true, changed[]}` 且不调用 `execute`。`executePlan` 新增 `confirmOutcome: allowed|denied|timeout|aborted|unavailable|error`，区分拒绝与超时。
- **跨重启计划 checkpoint**：受可选内置模块 `agent.resume`（v1.0.0，模块 API 1，依赖 `core`，能力 `agent.plan.checkpoint` 与 `agent.plan.cross-restart-resume`）控制，默认启用以保持现有行为。checkpoint 独立写入 Electron `userData/agent-plan-checkpoint.json`，使用版本化 schema、原子替换、0600 权限及 SHA-256 完整性校验；只保存计划签名哈希、从 CAD 网格/BOM/机型/底板内容计算的工程摘要哈希、工具名和有限步骤状态，不保存计划输入、参数、结果、对话或凭据；含凭据字段的计划拒绝创建 checkpoint。主进程在每个工具调用前先落盘 `running`，写成功后将写后工程摘要与 `completed` 一并保存；已完成写步骤被保留并跳过，未开始写步骤需用户重新查看并走既有原生确认。崩溃时仍 `running` 或失败的写步骤视为副作用不确定，恢复被拒绝并要求重新规划；只读步骤可在用户点击后安全重试。摘要不可用、schema/签名/工程指纹/游标变化、记录损坏或无法落盘时均 fail-closed。恢复绝不自动续跑；只有旧计划全部完成时，新签名/新工程的独立计划才可替换旧 checkpoint。
- **恢复模块关闭边界**：模块状态通过可信 preload→主进程同步；主进程的 restore、clear、checkpoint 创建/读写均实时检查开关。关闭时不查询、不创建、不覆盖、不删除磁盘 checkpoint；恢复 UI 与显式跨重启 `resumeFrom` 入口停用，普通计划（包括当前会话内的逐步 `startAt`）、Agent 对话及原生写操作确认不变。重新开启不会执行工具；只能在用户再次输入计划后按原有 schema、签名、强工程指纹、游标和副作用校验展示恢复状态，再由用户显式点击继续。模块状态未知/同步失败按关闭处理。
- **确认中断**：确认等待被 abort → `pendingConfirm.reason='cancelled'`；确认回调抛超时 → `'timeout'`。用户主动拒绝记 `USER_DENIED`，不写 pending，提示层明确「不要自动重试」。
- **跨轮指代**：`augmentContextWithThreadReference` 把上一轮 `targetRefs` 合成 `[target=kind:id:label]` 最近操作，`resolveThreadReference` 复用现有三级指代解析；当前选中优先。
- **IPC**：`agent:plan:execute` 与 `AgentSession` 共享同一个 `AgentThread`；模块启用时 `resumeFrom` / `startAt>0` 进入 checkpoint 指纹/游标校验；模块关闭时 `startAt` 仅表达当前会话内逐步执行，不读写 checkpoint。计划中断后不自动调用后续工具。
- **验证**：`test/agent/thread.test.mjs` 28 条；smoke `SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`；多轮真实模型评测 `scripts/agent-multiturn.mjs` + `agent-multiturn-cases.json`（6 场景，阈值 0.8）。

## 侧栏只读问答 UI（P7-A-2）

`ui.ts` 只做渲染，判定逻辑全在 `preview.ts`（纯函数，可直接单测）。

```ts
buildPlanPreview(text): {
  tone: 'read'|'write'|'none'; title; detail; hint;
  intent; intentLabel; tool: string|null; args; readOnly; offlineAllowed; missing: string[]
}
summarizeTurn(messages): { toolCalls, failures }        // 只数 role==='tool'
buildReceipt({ mode:'online'|'offline', elapsedMs, toolCalls?, failures? }): { tone, modeLabel, text, note }
describeAuditEntry(entry): { tone, title, meta }
auditSummaryText(summary): string                        // 空审计 → 「暂无审计记录」
```

- 预览：输入框 `input` 事件即算，把结果写进 `#agentPlanPreview` 的 `data-tool / data-read-only / data-offline`，只展示不执行；写操作在提示里点名缺的参数（如 `partId`）。
- 回执：`agent:chat:send` 返回 `mode` 与 `elapsedMs`（`AgentSession.mode()` 记录本轮是否降级），UI 用同一套字段渲染，离线是告警色而非错误色。
- 审计面板：打开抽屉/发送后调 `window.desktop.agent.audit.read()`；P7-F 起为最近 200 条、时间倒序，支持工具/结果筛选、CSV 导出与单条完整 JSON 展开；读取失败给中文原因，不静默空白。
- 冒烟钉住三条：只读指令 `offline=1`、写指令 `offline=0` 且提示含 `partId`、预览前后场景零件数不变（预览不执行）。

## 执行反馈 / 取消 / 失败建议（P7-F）

```ts
interface AgentProgressEvent {
  runId: string; phase: 'start'|'end'; index: number; total: number;
  tool: string; argsSummary: string; startedAt: number; callId?: string;
  elapsedMs?: number; ok?: boolean; code?: string; message?: string;
  source?: 'chat'|'plan';
}
suggestFailure({ code, message, tool, args }): { advice: string; alternatives: string[] }
formatDuration / stepLabel / runningDurationText / aggregateDurationText / cancellationText
filterAuditEntries / auditToolNames / limitAuditEntries / auditCsv / auditEntryJson / auditExportFileName
```

- **进度通道**：`AgentSession.run(text, { signal, onProgress, runId })` 与 `executePlan(..., { signal, onProgress })` 在每步开始/结束发事件；`ipc.ts` 通过 `agent:progress` 推给渲染层，`preload.ts` 暴露 `agent.onProgress()`。
- **执行前**：`feedback.ts` 用 `redactValue` + `maskSecrets` 生成参数摘要，事件先于确认与命令执行发出；UI 显示「正在执行 `tool` · 第 n/N 步」。
- **执行中**：UI 500 ms 刷新秒表；`runningDurationText` 在 ≥10 s 时追加「仍在执行，可取消」。
- **完成**：结果卡片包含 `✓/×`、耗时、结果码；每 3 个完成步骤输出「连续 3 步汇总耗时」。
- **取消**：`agent:chat:cancel` / `agent:plan:cancel` 触发 `AbortController.abort()`；会话与计划都在步骤边界检查信号，并把当前工具的等待用 `withAbort` 中断。`AgentCancelledError.completedSteps` 只含已结束步骤。
- **取消文案**：无写步骤 → 「已取消，未写入任何更改」；已有写步骤 → 逐条列出并提示 `undo_last`；当前写工具中断但结果未知 → 明确要求核对，不谎称未写入。
- **失败建议**：`suggest.ts` 覆盖 `PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED`；`PRECHECK_FAILED` 取第一条错误并指向点位/执行机构/传感器修复位置；未知码只复述消息。
- **审计增强**：`AgentAuditRecord.elapsedMs` 由会话与计划写盘；`audit-view.ts` 负责筛选、倒序、200 条上限、CSV（UTF-8 BOM）与整条 JSON 脱敏。CSV 文件名复用 `sanitizeFileName`，导出仍经主进程 `export:saveFile` 校验扩展名与路径。

单测：`test/agent/ux.test.mjs` 21 条（六类错误码、未知码、耗时格式、参数掩码、取消状态、审计筛选/CSV/上限/JSON 脱敏）。冒烟：`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`。

## 多步规划与执行（P7-C）

`planner.ts` 与 `router.ts` 一样是无 IO 的纯函数模块，供侧栏预览（渲染层）与 IPC 执行（主进程）共用。

```ts
plan(input, context?): AgentPlan
// steps: { tool, args, why, readOnly, missing? }[]
// { confidence, refused?, reason?, suggestions?, warnings? }

executePlan(plan, deps): Promise<ExecutePlanResult>
// deps: { execute(step,index), confirmPlan?(request), now?, startAt?, maxSteps? }
// → { ok, confirmationRequired, confirmed, cancelled?, failedAt?, failedIndex?, results[], totalMs, summary, undoHint? }
```

五类规则组合：

| 场景 | 步骤 |
|---|---|
| 查件 → 放置 → 校验 | `search_components` → `place_component` → `run_electrical_check` |
| 查 BOM → 成本 → 导出 | `get_bom` → `run_cost_report` → `export_cost_report` |
| 导入 CAD → 干涉 | `import_cad` → `run_interference_check` |
| 生成 PLC → 模拟验证 | `verify_plc_program`（只读，一次完成生成/模拟） |
| 生成设计包 → 上传 | `sync_design_package`（需确认；当前未注册，默认过滤并拒绝） |

规则细节：
- 工具名默认取 `READ_ONLY_TOOLS + WRITE_TOOLS`（与 `tools.ts` 注册表一致）；UI/IPC 传入实时工具列表后逐条过滤，未注册工具写入 `warnings`，全部被过滤则 `refused:true`。**不允许硬编码不存在的工具执行。**
- 通用多步按 `splitInstructionSteps` 拆句，每句必须能由 `planTool` 接住；任一句落空整单不执行。
- 规则不命中 `confidence=0.2`；低于 `PLAN_CONFIDENCE_THRESHOLD=0.6`（或 `context.minConfidence`）时拒绝，并返回 5 条可执行建议。
- 执行器对写步骤按 `READ_ONLY_TOOLS` 判定（不信任步骤里的 `readOnly` 标记），一次汇总确认；拒绝返回 `cancelled:true` 且 `results` 为空。
- 失败停止：业务 `ok:false`、嵌套 `error.code`、抛异常都归一为结果码（异常 `TOOL_EXCEPTION`）；`failedAt` 为 1 基步骤号，`failedIndex` 为 0 基下标。
- `insert_component`/`place_component`/`update_component`/`remove_component` 成功过且有失败时返回 `undoHint`，提示可用 `undo_last` 回退。
- 逐步执行由 `deps.startAt / deps.maxSteps` 驱动，UI「全部执行」不传 `maxSteps`，「逐步执行」固定 `maxSteps=1`。

IPC 与 UI：
- `agent:plan:execute` 在主进程再次校验步骤结构与工具是否注册，确认弹窗只出现一次，审计 `source='plan'`。
- 侧栏输入多步指令时显示 `#agentPlanCard`：序号、工具、参数 JSON、原因、缺参、只读/写；按钮为「全部执行 / 逐步执行 / 取消」。执行中当前步 `…`、成功 `✓`、失败 `×` 并显示错误码与原因。
- 冒烟：`SMOKE_AGENT_PLAN_OK steps=3 confirm=1`；额外验证侧栏对两步只读计划点击「全部执行」后两项都变 `is-done`。

## 命令总线与撤销

- `execute(name, args)` 始终返回 `CommandResult`，异常被转换成中文错误，不向调用方抛。
- 每次已注册命令执行都写入 `history`；面板只显示最近 5 条。
- `run_cost_report` 未显式给 `bom` 时先 `bridge.call('getBom')` 取场景 BOM；场景零件没有物料号，引擎按 `NO_PART_ID` 记缺价，不按 0 计价。
- `export_cost_report` 复用 `computeCostReport`：命令层取场景 BOM/项目名，`buildCostExport` 渲染 PDF（A4 纵向）或 CSV（UTF-8 BOM），再经渲染桥 `exportCostFile` → IPC `export:costFile` 写到固定 `userData/exports/`。命名/冲突/净化由 `src/cost/export.ts` 的 `planExportName` 统一处理。
- 导出 PDF 的字节由主进程 `renderCostPdf`（复用 `printToPDF`）生成，base64 过桥；渲染层不接触文件系统。
- 该命令通过构造参数 `createAgentCommandBus(registry, bridge, { loadBuiltinPricebook })` 拿到内置价格簿读取器（主进程读 `packs/builtin/pricebook-cn/pricebook.json`），与 `cost:pricebook` IPC 同源。
- `insert_component` 成功后将 `meshIndex` 作为 undo token 入栈；`undo_last` 调用 `removeComponent` 后索引会重排。
- `place_component` 先由 `placement.ts` 做型号解析（精确 id → 唯一模糊命中；多义返回 `AMBIGUOUS` + 候选），再由命令总线校验 `dims`，经渲染桥 `placeEnclosurePart` 调用真实 `window.__Enclosure.place`。放置 id 作为 undo token；`undo_last` 调 `removeEnclosurePart` 并返回 `{command:'place_component',removed:<placementId>}`。越界/重叠不拒绝，返回 `warnings[{code:'OUT_OF_BOUNDS'|'OVERLAP'}]`。
- `update_component` 先解析新型号；不在已启用数据包则 `PART_NOT_FOUND`。新件 `dims` 缺失只回 `NO_DIMENSIONS` 告警并保留原尺寸。底板目标以 placement 快照撤销，BOM 目标以行号/`partId` 定位后恢复。
- `remove_component` 底板目标用 placement 快照、BOM 目标用 `detachPart` 对象快照，二者都以 opaque token 交给 `undo_last` 恢复；不存在统一 `NOT_PLACED`。
- `run_plc_generate` 先 `generateProject` 预检；有任何 error 直接 `PRECHECK_FAILED`，不创建目录。成功后写 11 个文件 + ZIP，目录名 `<机型>-<yyyyMMdd-HHmm>`，冲突追加 `-2`。
- `export_files` 由渲染桥生成内容，主进程落盘；`kind=bom` 固定 `.csv`，PDF 走独立 A3 报告打印管线，GLB 以 base64 过桥。
- `PART_NOT_FOUND`、`NOT_PLACED`、`PRECHECK_FAILED`、`UNSUPPORTED_FORMAT`、`FILE_NOT_FOUND`、`RENDERER_TIMEOUT`、`RENDERER_UNAVAILABLE` 均为结构化错误码。

## MCP 写工具代理

- 独立 stdio MCP 启动时读取 `userData/agent-token`，调用 `POST http://127.0.0.1:7420/rpc` 的 `tools/call`，工具名和参数原样转发，默认 10 秒超时。
- 桌面可达时所有已知工具都转发，写操作走主进程 CommandBus 与渲染桥。
- 桌面不可达时：`list_components` / `search_components` 回退本地 registry；其余 13 个桌面工具（含 `place_component`、`update_component`、`run_plc_generate`、`export_files`）返回 `{ok:false,code:'DESKTOP_NOT_RUNNING',message:'请先启动 AutomationCAD 桌面应用，再调用该工具'}`。
- 代理错误不包含 token；401 单独返回鉴权错误，不降级成“桌面未运行”。

## 应用内智能体对话

- `agent-llm.json` 保存 `{baseUrl,apiKey,model,maxIterations}`，POSIX 权限 600。默认 `https://api.openai.com/v1`、`gpt-4o-mini`、6 轮。
- UI 读取时 apiKey 只返回掩码（如 `sk-****abcd`）；保存时掩码/空值保留原密钥。
- `llm.ts` 以 OpenAI 兼容格式发送 20 工具 JSON Schema，60 秒超时；非 2xx 返回含状态码的中文错误。
- `session.ts` 注入 `{llm,bus,confirmWrite}`：工具结果以 `role:'tool'` 回灌，先经 `serializeToolResult` 裁剪、再由 `guard.ts` 包成不可信数据块，失败不中断；历史只保留最近 20 条；超轮返回「已达到最大工具调用轮数（N），请缩小任务范围」。
- `import_cad`、`insert_component`、`place_component`、`update_component`、`remove_component`、`run_plc_generate`、`export_files`、`export_cost_report`、`undo_last` 执行前由主进程弹出确认；拒绝时回灌 `USER_DENIED`。
- 面板包含对话消息流/工具卡片、模型设置（apiKey 为 password）与测试连接（ping，`max_tokens=8`）。

## JSON-RPC 协议

```
GET  /health           → { ok, version, toolCount, tools, uptime }
POST /rpc              → { jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments } }
Authorization: Bearer <token>
```
- token 启动时 `randomBytes(32)` 生成，写 `%APPDATA%/AutomationCAD/agent-token`，权限 600
- 401 = 缺 token / 不匹配；-32601 = 方法或工具不存在；-32600 = 请求体非法或超过 2 MB
- 只绑 `127.0.0.1`，不对外暴露

## 渲染桥

```ts
window.__AgentBridge = {
  ready(), getScene(), getSelection(), getBom(), getPlcGenConfig(),
  insertComponent(part), removeComponent(meshIndex),
  placeEnclosurePart({ partId, x, y, rotate?, railSnap? }),
  removeEnclosurePart(placementId),
  getProjectContext(), getAdvisorState(), markPlcGenerated(),
  updateComponent(payload), removeProjectComponent(payload),
  restoreProjectComponent(token), exportArtifact({ kind }),
  runInterference(), importPath(path)
}
```

- `addPlaceholderPart(name)` 在 three 场景加入 20×20×20 mm 实体 + 线框占位盒，同时进入零件列表与干涉 `modelParts`。
- 占位件沿已有包围盒右侧排布，避免默认重叠。
- 未就绪时桥方法返回 `{ ok:false, message:'渲染层尚未就绪' }`，不抛异常。

## 主动建议（P7-H）

`advisor.ts` 是纯函数模块：`suggestNextActions(context, project, { ignored?, limit? })`，不读 DOM、不调工具、不写内存。输入 `AgentContext` 与 `AdvisorProjectState`：

```ts
interface AdvisorProjectState {
  bomRows: number;
  unplaced: number;
  conflicts: number | null;      // null = 有 CAD 但尚未跑干涉检查
  missingDimensions: number;
  hasCadModel: boolean;
  elecCheckPassed: boolean | null;
  elecIssueCount: number;
  costStale: boolean;
  plcGenerated: boolean;
}
```

规则按 weight 降序取前 3（完整表见 `docs/desktop/NL-AGENT.md` 8.4）：底板重叠 100、电气校验未通过 95、干涉命中 90、缺尺寸 85、有 CAD 未检查 70、成本过期 65、PLC 未生成 60、全部就绪 50。`why` 必须引用输入数字；无命中或全被忽略时返回空数组。

状态来源：
- `window.__AgentBridge.getAdvisorState()`：BOM 行数、未放置数、干涉命中/未检查、CAD 是否存在、电气校验结果、成本指纹是否变化、PLC 是否生成；
- `window.desktop.packs.listParts()`：渲染层按 BOM 的 `partId` 补齐 `dims.w/h`，得到缺尺寸件数；
- `window.__CostPanel.state()` 暴露最近一次计算的 BOM 指纹，`markPlcGenerated` 记录 Agent 生成 PLC 的事实；PLC 面板 `uiState().generated` 记录面板生成。

侧栏：
- `renderShell()` 顶部固定「建议」区，`renderAdvisor()` 只更新 `#agentAdvisorList`，不重建对话 DOM；
- `ask` 卡片填入输入框并触发 `input` 预览；`tool` 卡片生成 `fromSuggestion` 的单步 `AgentPlan`，点「全部执行」后走 `executePlan`，写工具仍二次确认；
- `ignoredAdvisorIds` 是模块内存 Set，只影响本次会话；`refreshAdvisor()` 在 `agent:progress` end、对话/计划结束与面板刷新时调用，用递增序号丢弃过期响应。

单测 `test/agent/advisor.test.mjs` 21 条；冒烟 `SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`。

## 输出纠错与重试（P7-J）

`repair.ts` 与 `retry.ts` 都是纯函数，无 DOM / fs / net 依赖；`session.ts` 是唯一调用方，外部 RPC / MCP 不经过模型输出，因此不受影响。

```ts
repairToolCall(raw: string, schema: unknown, ctx?: { selection?: { id?: string|null }|null; maxClosures?: number }): {
  ok: boolean;
  call?: { name?: string; args: Record<string, unknown> };
  repairs: string[];
  error?: { code: 'NO_JSON'|'INVALID_JSON'|'TRUNCATED_JSON'|'SCHEMA_INVALID'; message: string; path?: string };
}
validateToolArguments(value, schema): { ok: true } | { ok: false; path?: string; message: string }
buildRetryPrompt(reason): string
buildFallbackReply(reason, userInput?): string
fallbackCandidates(userInput?): [string, string]
parseFallbackCandidates(text): string[]
```

修复管线：
1. `stripFence` 剥离开/闭代码围栏；`extractFirstJson` 逐字符扫描第一个平衡的对象/数组，识别双/单引号、转义与 `//` 注释，不靠贪婪正则。
2. 文本级修正（每项只在真的改变文本时记录）：删 `//` 注释 → 删尾逗号 → 单引号转双引号。字符串里的 URL 与花括号不受影响。
3. 解析失败且结尾不平衡时补引号和 `}`/`]`，最多 3 层；超限或补完仍不合法返回 `TRUNCATED_JSON`。
4. 解包 `{name, arguments}` 信封；数组形式的多工具只取第一个并记录。
5. schema 修正：number 只接受带明确单位的字符串（`"120mm"` → 120，`"120"` 拒绝）；integer 只接受纯数字字符串（`"3"` → 3，`"3 个"` 拒绝）；boolean 只接受 `"true"/"false"`；必填 `partId` 只从 `ctx.selection.id` 回填；`additionalProperties:false` 的未知字段删除并记录。
6. 修复后必须通过 `validateToolArguments`；首个错误带路径与中文消息（`参数 qty 应为整数，收到 "3 个"`）。**非法值绝不猜成看似合理的值。**

`AgentSession` 的接入点：
- 构造参数新增 `toolSchemas`（`Record<string, schema>` 或按工具名取 schema 的函数）；IPC 从 `tools.summaries()` 传入，live 脚本同样传入。
- `prepareToolCalls` 先 repair 再执行；修复成功但未重试时写审计 `TOOL_CALL_REPAIRED`（`retries:0`、`repairs[]`）。
- 首次修复/校验失败：写 `TOOL_CALL_INVALID`，把无效输出作为普通 assistant 文本 + `buildRetryPrompt(reason)` 追加到临时上下文，重试 1 次（不计入会话历史）；成功写 `TOOL_CALL_RETRY_OK`（`retries:1`、`reason`），仍失败写 `TOOL_CALL_FALLBACK` 并返回两条候选。
- 重试只允许 1 次/用户轮次；失败后立即返回，不继续消耗 `maxIterations`。
- 审计新增 `retries?: number` / `reason?: string` / `repairs?: string[]`，仍经过 `maskSecrets`。

`llm.ts` 在有工具时默认附带 `response_format:{type:'json_object'}`。若端点返回 400/404/422/500 且错误文本提到 `response_format`/unsupported/unknown parameter，客户端去掉该字段并重试一次；`responseFormat:false` 可显式关闭。

测试：`test/agent/repair.test.mjs` 39 条；`test/agent/llm.test.mjs` 新增 3 条。冒烟：`SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`。

## 确认与路径策略（policy.ts）

`policy.ts` 是纯函数策略层，不读文件、不调工具；权限边界落在 `session.ts` 与导出命令入口。

- `detectBypassIntent(text)`：命中「别问了 / 不用确认 / 不需要确认 / 直接覆盖 / 跳过确认 / 我授权 / 别让我点」等，返回 `{bypass:true, phrase}`。
- `sanitizeConfirmationClaims(text)`：把回复里的「无需确认 / 已自动确认」替换为「已按规则请求确认」；替换发生在写入会话历史与返回 UI 之前。
- `checkExportTargetPath(fileName, allowSanitize)`：默认只接受纯文件名；Windows 盘符、UNC、POSIX 绝对路径、`../`、相对子目录与系统目录返回 `TARGET_PATH_UNSUPPORTED`，消息附 `userData/exports/`。

`AgentSession.executeTool` 的写工具分支：

1. 缺少 `confirmWrite`、确认返回值不是明确 `true`、或本轮已拒绝过同名写工具 → 不执行命令；
2. 命中绕过意图时仍调用 `confirmWrite(name,args,{bypass:true,phrase,notice})`，并写审计 `BYPASS_ATTEMPT`（`phrase` 字段）；
3. 拒绝后把工具名加入本轮 `deniedWriteTools`，后续同名写工具直接 `USER_DENIED`，不再弹窗。

导出层：`commands.ts` 的 `export_files` / `export_cost_report` 与 `cost/export.ts::buildCostExport` 共用 `checkExportTargetPath`；`allowSanitize:true` 时才允许净化路径，并在结果中返回 `sanitized:true`。工具 schema 同步声明该参数。

测试：`test/agent/policy.test.mjs` 42 条（意图正负例、话术替换、盘符/UNC/`../`/纯文件名/allowSanitize、直接调用 `executeTool`、拒绝短路、审计字段）。冒烟：`SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1`。

## 坑点

1. **不要把 token 写进日志**：`startAgent` 只打印 token 文件路径。
2. **stdio MCP 不需要 token**（父进程即信任边界），但不要把它暴露成 TCP。
3. **写操作只能走命令总线**：否则撤销栈会错乱。独立 stdio 进程没有渲染桥时返回 `AGENT_UNAVAILABLE`。
4. **`timingSafeEqual` 长度不等会抛异常**，先比长度再比内容。
5. **Codex/Claude 的 MCP 配置**要写绝对路径（`npm run mcp` 的输出目录），见 `desktop/README.md`。
6. **不要把大对象直接 JSON.stringify 回传**：网格数据会撑爆 body 上限（2 MB），工具只回摘要。
7. **渲染桥参数必须走 JSON 白名单**：不允许任意表达式拼接，避免 Agent 代码进入渲染进程。
8. **意图关键词不要把单字塞进去**：`查` 会被「检查」误命中、`列` 会被「列举/列出」重复计分；用 `查一下/列一下/搜一下` 这类最短完整词，并让类别词按长度倒序剔除，否则「继电器」会把「热继电器」拆成「热」。
9. **离线通道只能用 `planReadOnly`**：直接调 `planTool` 会把 `export_cost_report` 这类写工具在断网时执行掉；`READ_ONLY_TOOLS`/`WRITE_TOOLS` 两个集合之和必须等于工具总数（现有单测钉住）。
10. **预览绝不能顺手执行**：`buildPlanPreview` 只允许读 `router.ts` 的纯函数，不要为了「省一次点击」在预览里调命令总线——冒烟已钉住预览前后场景零件数不变。
11. **回执的通道要由主进程给**：`mode` 从 `AgentSession.mode()` 取，别在渲染层用「回复文案里有没有『离线』」猜，否则离线失败回包会被误标成在线。
12. **审计数据先脱敏再写**：`maskSecrets` 只处理文本，结构化参数必须走 `redactValue`（按字段名），否则 `{apiKey}` 会原样落盘；写文件失败要吞掉，不能让审计把对话打断。
13. **放置告警要在钳制前判断**：`placementWarnings` 的 `intended` 是吸附后、`clampToPlate` 前的矩形；用钳制后的坐标判越界会永远没有 `OUT_OF_BOUNDS`。旋转必须先交换宽高，再算导轨吸附与碰撞。
14. **指代优先级不能反**：有选中对象时「刚才那个」也先用选中对象；几何指代（左边第二个）必须优先于「这个」，否则会拿错 placement。没有候选或置信度 <0.6 时宁可追问，不能回退成搜索关键词。
15. **上下文裁剪要按 UTF-8 码点落刀**：`slice(0,-1)` 会把汉字或 emoji 代理对切成 U+FFFD；统一用 `truncateUtf8`。工具结果进模型前必须走 `serializeToolResult` + `guardToolResult`，不能在别处直接 `JSON.stringify` 大对象；guard 只标记不可信数据，不能改变工具选择。
16. **命令历史摘要只放白名单参数**：`recentActions` 会进系统提示，`summarizeCommandResult` 不得拼接 `apiKey/token/password` 等字段；对象标记 `[target=...]` 仅用于回退解析，展示前要剥离。
17. **纠错只修结构，不猜语义**：`qty:"很多"`、`"3 个"` 必须留在 schema 校验里拒绝；只有纯数字字符串、带明确单位的 number 字符串、`true/false` 才能转换。否则会把用户的真实意图改错。
18. **截断补全必须限层**：最多补 3 个 `}`/`]`（未闭合字符串先补引号），超限返回 `TRUNCATED_JSON`；不要为了「救回来」无限补括号。
19. **重试不能吞掉审计**：首次失败与重试结果都要写 `TOOL_CALL_INVALID` / `TOOL_CALL_RETRY_OK` / `TOOL_CALL_FALLBACK`，并带 `retries/reason/repairs`；否则用户看到参数被改却查不到原因。
20. **绕过意图只收紧权限，不授予权限**：`detectBypassIntent` 命中后仍必须确认；不要在 `executeTool` 之外另开“已授权”分支，也不要让工具结果或模型回复出现“无需确认”。路径拒绝必须发生在生成内容/建目录之前，`allowSanitize` 只能由用户显式意图触发。

## 进度

- ✅ 注册表 + 21 工具（只读 11 / 写 10）+ 鉴权 + 结构化错误码
- ✅ MCP stdio（真实握手 `tools/list` 返回 21 个）
- ✅ 命令总线：注册/执行/历史/失败记录/撤销
- ✅ 渲染桥：场景、选择、BOM、插入、移除、底板放置/撤销、干涉、导入
- ✅ MCP 写工具本机 RPC 代理（转发/降级/超时）
- ✅ 应用内智能体对话（LLM 客户端、会话循环、设置与确认）
- ✅ 离线规则路由（7 类意图）+ 历史工具清单上下文裁剪 + NDJSON 审计与凭据脱敏（P7-A）
- ✅ P7-L 多轮状态与续跑：`thread.ts` 记录上一轮意图/目标/完成步骤/未确认操作，工程指纹变化拒续跑，确认超时进 pendingConfirm；28 条单测 + `SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`；多轮评测脚本 6 场景阈值 0.8
- ✅ P7-N 执行效率：`dedupe.ts` 同轮去重 + 写不合并 + 单轮 12 次上限；`parallel.ts` 只读 3 路并发 + 依赖降级 + 写屏障 + 保序失败；`cache.ts` 三工具按工程指纹缓存 30 s + 写后失效 + `cacheHit` 审计/UI；33 条单测 + `SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`
- ✅ P7-M 上下文预算与成本可见性：`budget.ts` 六档装包（默认 12k）+ 长列表首尾 5/total + history 优先丢弃 + system 永不裁；usage 真实值/估算回落；`pricing.json` 费用与侧栏展示；审计 tokens/docsSources；21 条单测 + `SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`
- ✅ P7-E 上下文快照（选中/机型/底板/最近 3 条，≤1.5 KB）+ 三级指代消解 + 最近 5 次工具记忆 + 列表/文本/10 KB 结果裁剪
- ✅ 侧栏只读问答 UI：计划预览（只读可离线 / 写操作需联网）+ 在线离线统一回执 + 审计面板（P7-A-2）
- ✅ P7-C 多步规划：五类离线组合 + 通用拆句、未知工具过滤、置信度拒绝；`executePlan` 写步骤一次确认、失败立即停止、可撤销写回提示；侧栏计划卡片全部/逐步/取消
- ✅ 单测：全套 1110/1110（新增 `machine/spec.test.mjs` 14 条、`machine/synth.test.mjs` 16 条、`design-machine.test.mjs` 10 条、`apply-machine-design.test.mjs` 26 条；`policy.test.mjs` 42 条；`kb.test.mjs` 18 条；P7-J `repair.test.mjs` 39 条；P7-I `recipes.test.mjs` 29 条；P7-H `advisor.test.mjs` 21 条；P7-G `guard.test.mjs` 14 条；`context-memory-trim.test.mjs` 28 条；P7-L `thread.test.mjs` 30 条；P7-F `ux.test.mjs` 21 条）；smoke：`SMOKE_AGENT_TOOLS_OK tools=20 implemented=20`、`SMOKE_AGENT_TOOLS_V2 tools=20`、`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1`、`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=6 undo=1`、`SMOKE_AGENT_KB_OK docs=13 chunks=347 query=D2 hits=1`、`SMOKE_AGENT_BRIDGE_OK scene=1 bom=1`、`SMOKE_AGENT_PLACE_OK placed=1 undo=1`、`SMOKE_AGENT_CHAT_UI_OK fields=6 log=1`、`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2`、`SMOKE_AGENT_PLAN_OK steps=3 confirm=1`、`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`、`SMOKE_AGENT_NL_OK intents=7 tools=20 audit=3 ctx=595`、`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`、`SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`、`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`、`SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`、`SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1`、`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`
- ✅ P7-A-3 + P7-B：46 条中文评估集（`desktop/eval/agent-cases.json`）+ 离线回归 `npm run eval:agent`（结果写 `docs/desktop/eval/latest.json`）；当前基线 100% 意图 / 100% 工具 / 100% 超纲拒绝
- ✅ P7-G：`scripts/agent-live.mjs` 真实模型 12 指令冒烟（本机 deepseek-v4.1-flash 12/12）+ `guard.ts` 工具结果数据块与提示注入检测；评估集扩至 68 条，覆盖 20 工具与 6 类拒绝
- ✅ P7-H 主动建议：`advisor.ts` 纯函数 + 侧栏建议卡片（ask 填入输入框 / tool 单步计划确认）+ 会话内忽略 + 工具执行后非阻塞刷新
- ✅ P7-I 可复用流程：`recipes.ts` 5 个纯数据模板 + `runRecipe` 前置条件/跳过/逐次确认/失败报告/Markdown；侧栏流程下拉与执行记录导出
- ✅ P7-J 工具调用纠错：`repair.ts` 脏 JSON 修复 + schema 中文路径 + 截断限 3 层 + `partId` 选中回填；`retry.ts` 一次重试与两条候选回落；审计 `retries/reason/repairs`；LLM `response_format` 自动降级
- ✅ 会话安全策略：`policy.ts` 绕过意图识别 + 回复话术过滤 + 导出路径判定；`session.ts` 写工具硬确认、拒绝后短路、`BYPASS_ATTEMPT` 审计；`export_files` / `export_cost_report` 默认拒绝任意路径，`allowSanitize=true` 才净化落盘
- ⏳ MCP resources、单步模型工具调用的逐步确认、其余属性编辑（几何参数/装配层级）；联调/诊断/同步工具注册后补充真实工具用例

## 待办

1. 为 MCP 增加 `resources`（当前装配树、数据包清单），让 Agent 能先读后写。
2. 把剩余属性编辑（几何参数 / 装配层级）接入命令总线与撤销栈；元件型号/数量/备注与移除已完成。
