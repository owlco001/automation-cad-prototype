# 电气校验模块（desktop/src/elec/）

电气域的设计初筛：线号合规、功率统计、导线截面与断路器配合。三层结构，数据只往下流：

```
ElecDocument ──runElectricalCheck()──→ ElecCheckResult
                                        ├─ ui.ts        面板：统计卡 + 问题表 + 导出
                                        └─ report.ts    A3 横向 HTML（printToPDF）
```

## 文件

| 文件 | 职责 |
|------|------|
| `check.ts` | 纯函数规则引擎（不依赖 DOM/IPC），含 `AMPACITY_TABLE`、`BREAKER_RATINGS` |
| `report.ts` | `renderElecCheckHtml(project, result)` 生成可打印报告，全部字段做 HTML 转义 |
| `ui.ts` | 「电气校验」抽屉面板：入口按钮 `elecCheckEntryButton`、抽屉 `elecCheckDrawer`、脚本 API `window.__ElecCheckPanel` |

## 可选模块 `elec.validation`

- v1.0.0 / Module API 1，默认启用以兼容既有安装，依赖 `core`。能力声明：`elec.validation.rules`、`elec.validation.panel`、`agent.electrical-check`、`elec.validation.report.export`。
- 控制校验面板、PDF 导出及 Agent `run_electrical_check` 命令/工具、JSON-RPC 与 MCP。关闭后面板入口隐藏并收起，脚本运行/PDF 导出、旧工具名与命令直调均在执行前失败关闭并返回 `MODULE_DISABLED`；renderer 状态同步获主进程接受后才开启，主进程工具列表与 MCP 代理使用同一状态。桌面状态不可达时 MCP 隐藏该工具且不回退本地执行。
- 重新启用后规则、结果和报告恢复。开关只保存模块状态，不改电气原理图/项目数据、元件库、底板布置或 Agent 审计历史；这些设计与数据入口不归本模块管理。

## 数据契约

- `ElecDocument = { wires?, loads?, circuits?, options? }`；`ElecCheckResult = { findings, summary, counts }`。
- 面板本身不造数据：从 `window.__ElecDocProvider()` 取文档，未注入时只提示「尚未接入电气数据源」。
- Agent 侧同一套判定：命令 `run_electrical_check`（`src/agent/commands.ts` 里做入参解析与中文报错）+ 工具 `run_electrical_check`（`src/agent/tools.ts`，返回 `counts/summary/findings`，超过 50 条标 `truncated`）。

## 规则口径

- 线号：`L1/L2/L3/N/PE`、`24V/0V`、3~4 位数字；缺号 → 警告，格式不合规 → 警告，同一网络重复 → 警告，跨网络同号 → 严重，相线线号与电位不一致 → 严重，数字段跳号 → 一条汇总警告。
- 功率：3P 按 `√3·U·cosφ·η`，单相按 `U·cosφ·η`，DC24 按 `P/U`；全部乘需要系数（默认 0.8）；最大相电流 × 1.25 就近选标准壳架，再按载流量表反推进线截面。
- 截面：按铜芯 30℃ 穿管表；`breakerA > 载流量` 判为导线失去保护（严重）。
- **注意**：只要登记了负载，`MAIN_BREAKER_SUGGEST` 一定是 `info` 级 finding，所以「零问题」只可能出现在无负载文档里；写测试别断言 `findings.length === 0`。

## 坑

- `tsconfig` 开了 `exactOptionalPropertyTypes`，构造可选字段（如统计卡 `tone`）要条件展开，不能写 `tone: undefined`。
- 报告里的位置串是 `from→to`（无空格）多段用 `、` 连接，断言要按实际拼接结果写。
- 新增 Agent 工具会同时打破 3 处计数断言（`test/agent/{tools,mcp,rpc}.test.mjs`）与 smoke 的 `SMOKE_AGENT_TOOLS_OK`，必须一起改，且直接改成新数字而不是放宽。
- 面板 PDF 走 `window.desktop.exportReport({html, projectName})`（A3 横向、输出名固定 `report.pdf`），不是浏览器 `window.print()`。

## 验证

`npm test`（`test/elec/*`、`test/agent/elec-check.test.mjs`）；`npm run smoke` 打印
`SMOKE_ELEC_CHECK_OK`（规则引擎）与 `SMOKE_ELEC_CHECK_UI_OK rows=… cards=9 pdf=true`（面板 + PDF）。
