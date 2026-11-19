# AutomationCAD 下一会话交接

更新时间：2026-11-19（**R10 收口：4 笔已推 `94ec7e6`；CI 首跑暴露 adm-zip 环境前置遗漏，修复待重跑**）
仓库 `owlco001/automation-cad-prototype`；工作目录 `/tmp/automation-cad-prototype`

> 这是**短摘要**：只写「现在什么状态、下一步做什么」。
> 本轮完整报告 → `docs/desktop/R10-ITERATION.md`；可移交验收记录 → `docs/desktop/R10-ACCEPTANCE.md`；PV 侧软件口径 → `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`。
> 不要再往本文件堆历史（上一版 371 行已归档并压缩，原文仍在 `git show e480f57:HANDOFF-NEXT-SESSION.md`）。

## 现状（三句）

- **代码状态**：`HEAD = 94ec7e6`（`docs: record R10 acceptance and compact iteration handoff`）= `origin/main`；R10 的 **4 笔已全部推送**
  （`137a68d` CI 严格档 + 负向自证 → `0379e15` 豁免收窄到声明宿主 → `ba8020d` 启动计时 + 首跑历史 ENOENT 静音 → `94ec7e6` 文档收口）。
- **上轮远端 CI**：run **`44493445997`**（head `e480f57`）success 7/7 —— 只覆盖 `e480f57`，**不覆盖这 4 笔**。
- **本轮 CI 首跑未绿**：run **`44506016602`**（head `94ec7e6`）里 `featuretree-geometry` job（`135497734775`）**严格档失败**，但原因是**环境前置遗漏**：
  该 job 只装了 build123d、没跑 `npm ci`，`eval:tasks` import `desktop/src/shared/zip.ts` 时直接
  `ERR_MODULE_NOT_FOUND: Cannot find package 'adm-zip'` —— **一条断言都没跑到**（日志 `scratch/cad-r10-final/ci-ft-failure.log`）。
  修复（setup-node 24 + `npm ci` 放在评测前、job 90→100 min、守卫 +2 条对抗用例）已在本机工作区，**待重跑 CI**。
  **所以现在既不能说「CI 已绿」，也不能说「改动仍未提交」** —— 4 笔在远端，修复未提交。**没有安装包发版。**

## 本轮三包（一句话各自，细节见 R10 报告 §1）

| 包 | 改了什么 | 证据（跑过的） |
|---|---|---|
| **A 严格 CI + 负向自证** | `featuretree-geometry` job 的两条 `verify:step-tower` 与 `eval:tasks` 加 `--require-full`（SKIP 即 exit 1）；新增「受控缺内核」负向自证步骤（松档 exit 0 / 严格档 exit 1，钉死 `python=$MISSING_PY`、无 `kernel port=`）；job 预算 75→90→**100 min**（首跑后补 `npm ci` 这一步）；守卫 `test/meta/ci-strict-gates.test.mjs` 读**真** `ci.yml`，并新增 ⑦ 依赖前置（缺 `npm ci` / 装在评测之后都判红） | 守卫 **23/23**（首跑修复后实跑；首跑时是 21/21）；`eval:tasks --require-full` 本机 **13/13、skipped=0**（CI 上尚未跑通，见现状） |
| **B 逐件豁免精确化** | `verify-step-tower.mjs`：`OCCLUSION_DECLARED_HOSTS` 精确件号 → 唯一合法宿主（`hasOwnProperty`，不做前缀）；双向闭合（未声明 / 宿主不符 / 死条目都红）；`declaredPresence` 默认 `required`（fail-closed）；身份检查 5→6 项 | `verify-step-tower.test.mjs` **实跑 57/57**（静态 grep 只数得到 56 —— 有动态子测试，清单不能替代实跑）；真内核 **8 层 16/16 · 16 层 23/23** |
| **C 启动计时 + ENOENT 静音** | 新增 `electron/startup-metrics.ts`：零点 = **main 模块求值**，`atMs/totalMs/sincePreviousMs` 同口径，raw 判回退、舍入只在写出，`readyToShow` 可晚到；顺序水位 `Math.max`；`main.ts` 接线；新增 `src/shared/optional-json.ts` 只静音 `ENOENT`，`ipc.ts` 的 PLC 历史读取改用它 | `startup-metrics.test.mjs` **19/19**；rank 负例旧实现 **18 pass / 1 fail**、当前源码 **19/19**（真红真绿）；`optional-json` 8/8 |

## 终验实测（同一棵树、串行；日志 `/root/.hermes/cache/scratch/cad-r10-final/`）

| 项 | 结果 | 日志 |
|---|---|---|
| 全量 `npm test`（补齐 CI 前置后重跑） | **3719 tests / 3716 pass / 3 skip / 0 fail / 117,094.372255 ms** | `full-ci-fix.log` |
| focused | **415 / 415，13,094.827541 ms** | `focused-final.log` |
| `npx tsc --noEmit`（CI 修复后重跑） | **exit 0**，0 诊断 | `tsc-ci-fix.log` |
| `npm run build:ext` | **exit 0**：extension 2,946,350 B / gzip 921,963 B / wasm 7,604,031 B / total 10,550,381 B | `build-ext.log` |
| Electron smoke | **`SMOKE_OK`、exit 0、23.0 s、0 FAIL、4 个明确 SKIP** | `smoke.log` |
| `verify:step-tower --levels 8 --require-full` | **16 / 16**（9 内核 + 6 身份 + 1 条边界显式 N/A） | `step-tower-8.log` |
| `verify:step-tower --levels 16 --require-full` | **23 / 23**（9 + 6 + 8） | `step-tower-16.log` |
| `verify:channel --levels 2 / 16` | **27/27 · 27/27**（正向 13 / 负向 14，N1..N14），`TOWER_CHANNEL_RESULT ok` | `channel-2.log` / `channel-16.log` |
| `eval:tasks --require-full` | **13 / 13 pass、skipped=0、env_skipped=0、undeclared_skips=0、degraded=false** | `eval-tasks.log` |
| `regen:pv-buffer` | **`ok=true checks=61 failed=0`**，仍 8 层 90 件、`aligned=false` | `regen-pv-buffer.log` |
| `kb:build` | **13 docs / 454 chunks / 434,531 B**（三份交接文档不在 `KB_DOC_FILES`，统计不变） | `kb-final.log` |
| 四文件定向 `node --test` | **105 / 105**（19 + 8 + 21 + 57） | `node-test.log` |

- **4 个 SKIP 各自带显式原因**（不是静默跳过）：`SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`、`SMOKE_PARAMETRIC_SIDECAR_SKIP`、`SMOKE_PARAMETRIC_UI_SKIP`、`SMOKE_DRAWINGS_UI_SKIP`。
- **启动计时读数**：`STARTUP_METRICS totalMs=373.254`（ready 67.61 / window 131.226 / load 356.605 / readyToShow 372.3），零点 = **main 模块求值起点**，不含 Electron bootstrap 与 main 静态 import。**这是口径读数，不是性能提升宣称**（无跨版本对照实验）。
- 小修前的旧数字（focused 415、全量 3716/3713/3/0/126,150 ms）已保留在 R10 报告 §2 作演进记录，**不再当结论**。

## 结论限制（任何一轮都不许越过）

1. 真实塔 **`feasible=false`**（`load-passes-shelf` + `stroke-shortfall`）；`verify:channel` 是诊断脚本，不是结构/安全校验（27/27 是尺子自证）。
2. **`sweep` 405 命中仍 fail，本轮未复跑**（16 层 42 对 / 270 确认 + 135 待复核），不得改判。
3. **结构/安全/电气/PLC 未做**：`structure.accepted:false`、挠度/导向/防坠/安全回路未校核、IO 地址 `null`、`executable=false`。
4. **占位顶点 ≠ 实体认证**：STEP 门禁只到「每件包络内 ≥1 个 B-Rep 顶点」+ 名字级声明，不是逐面/逐实体身份，不是制造验收。

## 下一会话顺序

1. `git status --short` / `git log --oneline -5` → 确认 HEAD 仍是 `94ec7e6`、工作区只有 `ci.yml` + `ci-strict-gates.test.mjs` 两份修复改动（主会话统一提交）；**不要 `git checkout --`、不要重排已推送历史**。
2. 终验已完成；**只有再动源码/测试才需要整轮重跑**（同一次会话、同一棵树、串行），命令与预期值：
   ```bash
   cd /tmp/automation-cad-prototype/desktop
   node --test test/electron/startup-metrics.test.mjs test/electron/optional-json.test.mjs \
     test/meta/ci-strict-gates.test.mjs test/parametric/verify-step-tower.test.mjs   # 105/105
   npx tsc --noEmit                                                                   # exit 0
   npm run test:focused                                                               # 415/415
   timeout -k 15 900 npm test                                                         # 3717/3714/3/0
   npm run verify:step-tower -- --levels 8  --require-full                            # 16/16
   npm run verify:step-tower -- --levels 16 --require-full                            # 23/23
   node scripts/verify-channel.mjs --levels 2 / --levels 16                           # 27/27 各一次
   npm run eval:tasks -- --require-full                                               # 13/13 skipped=0
   npm run build:ext && npm run smoke                                                 # exit 0 / SMOKE_OK
   npm run regen:pv-buffer && npm run kb:build                                        # 61/61 / 13-454-434531
   git diff --check                                                                   # 无输出
   ```
3. 提交 + push 后另查新 run 的 `headSha`：`gh run list --limit 3` → `gh run watch <id>`；把「CI 已绿」只写到**那个 SHA** 上
   （`94ec7e6` 的 run `44506016602` 首跑未绿：adm-zip 环境前置遗漏，**不是断言失败**，修复待重跑）。
4. 之后才是老欠账：升降通道（`sweep` 405→0）、逐实体 STEP 身份、结构/安全/电气/PLC。

落库时只 add 本轮白名单文件：`.github/workflows/ci.yml`、`desktop/electron/{ipc,main,startup-metrics}.ts`、
`desktop/src/shared/optional-json.ts`、`desktop/scripts/verify-step-tower.mjs`、
`desktop/test/electron/{optional-json,startup-metrics}.test.mjs`、`desktop/test/meta/ci-strict-gates.test.mjs`、
`desktop/test/parametric/verify-step-tower.test.mjs`、`HANDOFF-NEXT-SESSION.md`、
`docs/desktop/{R10-ITERATION,R10-ACCEPTANCE,PV-BUFFER-ITERATION-HANDOFF}.md`。**`scratch/` 永不提交，`git add -A` 禁用。**

## 文档与 KB

- 本文件、`R10-ITERATION.md`、`R10-ACCEPTANCE.md`、`PV-BUFFER-ITERATION-HANDOFF.md` **都不在 `KB_DOC_FILES`**（`desktop/src/agent/kb/index.ts` 里 13 份）→ 改它们**不需要** `kb:build`，统计仍是 13/454/434,531（本轮已复跑确认）。
- 改那 13 份中的任何一份之后必须重建，否则 `test/agent/kb-freshness.test.mjs` 会红。

## 安全与数据

不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`；不要把其中任何密钥复制进仓库或文档。
IO 草案地址为 `null` 是有意设计，必须经电气与安全工程确认后才能分配真实地址。
