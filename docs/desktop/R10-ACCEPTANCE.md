# R10 终验验收记录（2026-11-19）

> 用途：**可移交的验收摘要**，供下一位接手者/复审者独立核对。不复述过程，不复制日志全文，不含 `userData` 内容与任何密钥。
> 完整迭代报告见 `docs/desktop/R10-ITERATION.md`；下一步动作见 `HANDOFF-NEXT-SESSION.md`。

## 1. 结论

- **本轮终验 PASS**：12 项门禁全部 `exit 0`，唯一非 `exit 0` 的期望结果是 rank 负例的**受控红**（隔离副本，真源码未动）。
- **代码复审通过**（本轮三包 A/B/C 均按整改口径落地）。
- **CI 首跑未绿（原因不在断言）**：4 笔已推 `94ec7e6`，run `44506016602` 的 `featuretree-geometry` job（`135497734775`）
  在严格档 `eval:tasks --require-full` 上失败，但失败是**环境前置遗漏** —— 该 job 只装了 build123d、没跑 `npm ci`，
  `desktop/src/shared/zip.ts` 一 import 就 `Cannot find package 'adm-zip'`，**一条断言都没跑到**。
  补 `setup-node 24 + npm ci`（放在评测之前）、job 90→100 min、守卫新增 ⑦ 依赖前置 + 2 条对抗用例已写好本机，**待重跑**。
  在这条重跑出绿之前，**不得声称本轮 CI 已绿**；上轮 run `44493445997` 只覆盖 `e480f57`。
- **无安装包发版**。本记录不构成制造验收或结构安全结论。

## 2. 受验对象

| 项 | 值 |
|---|---|
| 仓库 / 树 | `owlco001/automation-cad-prototype` @ `/tmp/automation-cad-prototype`，`HEAD = 94ec7e6` = `origin/main`（R10 的 4 笔已推）；**工作区脏**仅剩 CI 修复两文件（`ci.yml`、`ci-strict-gates.test.mjs`） |
| 工具链 | node v26.7.0 / npm 11.19.0 / tsc 5.9.3 / vite 7.3.7，cwd = `desktop/` |
| 环境 | 容器内 root，Electron 需 `--no-sandbox`；图形相关门禁在 xvfb 下跑 |
| 证据目录 | `/root/.hermes/cache/scratch/cad-r10-final/`（`results.json` / `results.ndjson` + 各门禁 `.log`）；**scratch 永不提交** |

## 3. 门禁结果

| # | 门禁 | 结果 |
|---|---|---|
| 1 | 定向 4 文件 `node --test`（startup-metrics / optional-json / ci-strict-gates / verify-step-tower） | **105 / 105** |
| 2 | `npx tsc --noEmit` | **exit 0**，0 诊断 |
| 3 | `npm run test:focused` | **415 / 415**，13,094.827541 ms |
| 4 | `npm test`（全量，CI 前置修复后重跑） | **3719 tests / 3716 pass / 3 skip / 0 fail**，117,094.372255 ms；`full-ci-fix.log` |
| 5 | `verify:step-tower --levels 8 --require-full` | **16 / 16**（9 内核 + 6 身份 + 1 条边界显式 N/A） |
| 6 | `verify:step-tower --levels 16 --require-full` | **23 / 23**（9 + 6 + 8） |
| 7 | `verify:channel --levels 2` | **27 / 27**，`TOWER_CHANNEL_RESULT ok` |
| 8 | `verify:channel --levels 16` | **27 / 27**，同上 |
| 9 | `npm run eval:tasks -- --require-full` | **13 / 13**，`skipped=0 env_skipped=0 undeclared_skips=0 degraded=false` |
| 10 | `npm run build:ext` | **exit 0**：extension 2,946,350 B / gzip 921,963 B / wasm 7,604,031 B / total 10,550,381 B |
| 11 | Electron smoke（`npm run smoke`） | **`SMOKE_OK`、exit 0、23.0 s、0 FAIL、4 个明确 SKIP** |
| 12 | `npm run regen:pv-buffer` / `kb:build` | **61/61**（8 层 90 件、`aligned=false`）/ **13 docs · 454 chunks · 434,531 B** |

- **`verify-step-tower.test.mjs` 实跑 57 条**；静态 `grep` 只得 56（有动态生成子测试）。上一版「56 条 / 57 差 1 未复核」的说法已作废——**以本次实跑 57 为准**。
- **4 个 SKIP 都是有原因的显式跳过**：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。
- **rank 水位负例自证**：隔离副本把 `Math.max(lastRank, rank)` 改回 `lastRank = rank` → `18 pass / 1 fail`（失败正是「非法 load 没抛」）；当前源码同一条用例 `19 / 19`。真源码 grep 复核仍为 `Math.max`。

## 4. 启动计时（口径读数，非性能结论）

`STARTUP_METRICS totalMs=373.254`，phases：ready 67.61 / window 131.226 / load 356.605 / readyToShow 372.3 / extension 373.254（`Σ sincePreviousMs ≈ totalMs`）。

- **零点 = main 模块求值起点**（`createStartupRecorder()` 求值点），不含 Electron bootstrap、不含 main 的静态 import。
- `readyToShow` = renderer 首帧信号（不是合成器呈现）；`load` = `did-finish-load`（DOM + 资源），不是绘制。
- **不做性能提升宣称**：没有跨版本对照实验；这个数只用于同口径回归时可比较。

## 5. 这份验收**不**证明什么

1. 真实塔仍 `feasible=false`（`load-passes-shelf` + `stroke-shortfall`）；`verify:channel` 是诊断脚本，27/27 是「尺子自证」，**不是结构/安全校验**。
2. `sweep` 405 命中（270 确认 + 135 待复核）**仍 fail，本轮未复跑**，不得改判为通过。
3. 结构/安全/电气/PLC 全未做：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO 地址 `null`、`executable=false`。
4. STEP 门禁只到「每件包络内 ≥1 个 B-Rep 顶点」+ **名字级**精确件号/宿主/声明件存在；**不是逐面或逐实体身份，不是制造验收**。占位顶点 ≠ 实体认证。
5. 全量 3 个 skip 是仓库既有跳过，不代表被覆盖；**CI 首跑是环境前置红的（缺 `npm ci` → adm-zip），不是断言红，也不是绿** —— 修复重跑之前本轮没有 CI 证据。

## 6. 移交动作

1. 提交并推送 `ci.yml` + `ci-strict-gates.test.mjs` 这份修复（其余 4 笔已在 `94ec7e6`）→ 记 `git rev-parse HEAD`。
2. `gh run list --limit 3` 确认新 run 的 `headSha` 等于该 SHA → `gh run watch <id>`；**CI 结论只挂这个 SHA**（`44506016602` 是红的，只作「首跑已知问题」的证据）。
3. 未完成项按危害排序：升降通道（`sweep` 405→0）→ 结构/安全/电气/PLC → STEP 逐实体身份。
