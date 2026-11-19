# R10 终验验收记录（2026-11-19）

> 用途：**可移交的验收摘要**，供下一位接手者/复审者独立核对。不复述过程，不复制日志全文，不含 `userData` 内容与任何密钥。
> 完整迭代报告见 `docs/desktop/R10-ITERATION.md`；下一步动作见 `HANDOFF-NEXT-SESSION.md`。

## 1. 结论

- **本机终验 PASS**：A/B/C 三包的 12 项门禁当时全部 `exit 0`（唯一非 `exit 0` 是 rank 负例的**受控红**，跑在隔离副本）；包 D 之后 `tsc / 全量 / build:ext / verify:step / tower-16 / eval` 与包 D 两项定向已重跑，仍全 `exit 0`（§3 现行表）。
- **代码复审通过**：A/B/C 按整改口径落地；包 D 的**P1 复审通过**（launch 作用域、既有断言零改动、probe 复跑一致）。
- **CI 两次都未绿，原因不同**：
  ① run `44506016602`（head `94ec7e6`）：`featuretree-geometry` job 没跑 `npm ci`，`eval:tasks` import `desktop/src/shared/zip.ts` 即 `Cannot find package 'adm-zip'`，**一条断言都没跑到**（环境前置遗漏，已由 `9409f3e` 修）。
  ② run `44508941094`（head `9409f3e`，job `135507781027`）：依赖安装、装配、体积步骤**都过**，红在 `verify:step` —— sidecar 启动后**约 0.36 s 自行退出**（探测端口 7440/7435），旧实现误报成「健康检查在 3 秒内未通过」。**具体真因未证**（旧代码丢弃 stderr，没有 traceback）；**不是内核慢，也不是预算不足**（本机 `start=559 ms`，预算 90/120 s）。
  包 D（错误诊断 + 启动竞态）**已作为 `e1d1138` 推送**（随文档提交 `e2c3213` 进 `origin/main`）；其触发的**新 run `44516236961` 结论未出**（更新本文时状态 queued）。**该 run 出绿前，不得声称本轮 CI 已绿。** 上轮 run `44493445997` 只覆盖 `e480f57`。
- **无安装包发版**。本记录不构成制造验收或结构安全结论。

## 2. 受验对象

| 项 | 值 |
|---|---|
| 仓库 / 树 | `owlco001/automation-cad-prototype` @ `/tmp/automation-cad-prototype`，`HEAD = origin/main`（最新一笔为文档同步提交），**工作区干净**；R10 代码 6 笔全部已推，包 D 的 4 文件在 `e1d1138`（`electron/parametric.ts`、`scripts/fake-parametric-sidecar.mjs`、`scripts/verify-step-export.mjs`、`test/parametric-sidecar.test.ts`，+604/−32） |
| 工具链 | node v26.7.0 / npm 11.19.0 / tsc 5.9.3 / vite 7.3.7，cwd = `desktop/` |
| 环境 | 容器内 root，Electron 需 `--no-sandbox`；图形相关门禁在 xvfb 下跑 |
| 证据目录 | `/root/.hermes/cache/scratch/cad-r10-final/`（`results.json` / `results.ndjson` + 各门禁 `.log`）；**scratch 永不提交** |

## 3. 门禁结果

**现行（包 D 之后，本机实跑，`*final2.log`）**

| # | 门禁 | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | **exit 0**，0 诊断 |
| 2 | `npm test`（全量） | **3726 tests / 3723 pass / 3 skip / 0 fail**，120,598.912448 ms |
| 3 | `npm run build:ext` | **exit 0**：extension 2,946,350 B / gzip 921,963 B / wasm 7,604,031 B / total 10,550,381 B |
| 4 | `verify:step`（真内核） | **7 / 7**，`state=ready port=7449 wait=3212ms start=559ms` |
| 5 | `verify:step-tower --levels 16 --require-full` | **23 / 23**，`identity=PASS(144/144)`、`exempt=2/14`、`declared=2 undeclared=0 stale=0` |
| 6 | `npm run eval:tasks -- --require-full` | **13 / 13**，`skipped=0 env_skipped=0 undeclared_skips=0 degraded=false` |
| 7 | `parametric-sidecar.test.ts` / `ci-strict-gates.test.mjs` | **22 / 22** / **23 / 23** |

**上一轮同树实跑（包 D 之前，本轮未重跑；再改源码/测试须整轮重跑后才可引用）**

| # | 门禁 | 结果 |
|---|---|---|
| 8 | `npm run test:focused` | **415 / 415**，13,094.827541 ms |
| 9 | `verify:step-tower --levels 8 --require-full` | **16 / 16**（9 内核 + 6 身份 + 1 条边界显式 N/A） |
| 10 | `verify:channel --levels 2` / `--levels 16` | **27 / 27** · **27 / 27**，`TOWER_CHANNEL_RESULT ok` |
| 11 | Electron smoke | **`SMOKE_OK`、exit 0、23.0 s、0 FAIL、4 个明确 SKIP** |
| 12 | `npm run regen:pv-buffer` / `kb:build` | **61/61**（8 层 90 件、`aligned=false`）/ **13 docs · 454 chunks · 434,531 B** |
| — | 四文件定向 `node --test` | **105 / 105**（19 + 8 + 21 + **57**） |

- **`verify-step-tower.test.mjs` 实跑 57 条**；静态 `grep` 只得 56（有动态生成子测试）。上一版「56 条 / 差 1 未复核」作废 —— 以实跑 57 为准。
- **4 个 SKIP 都是有原因的显式跳过**：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。
- **rank 水位负例自证**：隔离副本把 `Math.max(lastRank, rank)` 改回 `lastRank = rank` → `18 pass / 1 fail`；当前源码 `19 / 19`。真源码 grep 复核仍为 `Math.max`。
- **演进记录（只作历史，不当结论）**：全量 3719/3716/117,094 ms → 3717/3714/119,708.889571 ms → 现行 3726/3723/120,598.912448 ms；3716/3713/126,150 ms 更早。
- **包 D 的专项证据**：新增 6 例修复前 `0/6` 全红、修复后定向 22/22 绿；「stop 后立刻重启」旧实现 spawns=3/`crashed` 必红、新实现 spawns=2/`unavailable` 绿；脱敏 fuzz 3000 轮 `leaks=0`；`verify:step` 失败路径（假 python exit 2）仍 `exit 1` 且带 `code/elapsed/stderrClass`。

## 4. 启动计时（口径读数，非性能结论；包 C 轮读数，包 D 未改动该模块）

`STARTUP_METRICS totalMs=373.254`，phases：ready 67.61 / window 131.226 / load 356.605 / readyToShow 372.3 / extension 373.254（`Σ sincePreviousMs ≈ totalMs`）。

- **零点 = main 模块求值起点**（`createStartupRecorder()` 求值点），不含 Electron bootstrap、不含 main 的静态 import。
- `readyToShow` = renderer 首帧信号（不是合成器呈现）；`load` = `did-finish-load`（DOM + 资源），不是绘制。
- **不做性能提升宣称**：没有跨版本对照实验；这个数只用于同口径回归时可比较。

## 5. 这份验收**不**证明什么

1. 真实塔仍 `feasible=false`（`load-passes-shelf` + `stroke-shortfall`）；`verify:channel` 是诊断脚本，27/27 是「尺子自证」，**不是结构/安全校验**。
2. `sweep` 405 命中（270 确认 + 135 待复核）**仍 fail，本轮未复跑**，不得改判为通过。
3. 结构/安全/电气/PLC 全未做：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO 地址 `null`、`executable=false`。
4. STEP 门禁只到「每件包络内 ≥1 个 B-Rep 顶点」+ **名字级**精确件号/宿主/声明件存在；**不是逐面或逐实体身份，不是制造验收**。占位顶点 ≠ 实体认证。
5. 全量 3 个 skip 是仓库既有跳过，不代表被覆盖；**CI 两次红都不是门禁断言红，也都不是绿** —— 首跑缺 `npm ci`（adm-zip），第二跑 sidecar 早退（真因未证）。**新 run `44516236961` 出结论前，本记录不提供 CI 证据。**

## 6. 移交动作

1. **已推送**：包 D 的 4 文件在 `e1d1138`，随文档提交 `e2c3213` 进入 `origin/main`（`git log --oneline -6` 复核）。不再有未提交内容；后续若改文档，只 add 白名单 4 份。
2. `gh run list --limit 3` 取 `headSha = $(git rev-parse HEAD)` 的 run（首个 `44516236961`）→ `gh run watch <id>`；**CI 结论只挂这个 SHA 的 run**（`44506016602` 缺依赖、`44508941094` sidecar 早退，只作已知问题证据）。**结论未出前写「未出」，不要写绿。** 若再红，先看 `verify:step` 打出的 `code/stderrClass/stderr 尾`——本轮修复就是为这条。
3. 未完成项按危害排序：升降通道（`sweep` 405→0）→ 结构/安全/电气/PLC → STEP 逐实体身份。
