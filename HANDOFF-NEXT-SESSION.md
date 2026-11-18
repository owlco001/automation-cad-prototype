# AutomationCAD 下一会话交接

更新时间：2026-11-18（本轮：缓存控制层复审 N1–N6 整改 + 全链路验收）
项目：`owlco001/automation-cad-prototype`
工作目录：`/tmp/automation-cad-prototype`

## 开始前必做

```bash
cd /tmp/automation-cad-prototype
git status --short
git log -5 --oneline
```

当前改动仍未提交（本地 15 个 M + 18 个 ??）。不要覆盖、回滚或删除已有本地修改；提交或推送前先审查完整 diff 和测试结果。

## 当前远端状态

最后已推送提交：

- `a2fc5c8`：性能与体积优化
- `a85dc92`：工程恢复、工作区 UI、管线/联动修复

## 本轮（2026-11-18）真实结果

全部串行执行，原始日志在 `/root/.hermes/cache/scratch/cad-delivery-*.log`：

| 步骤 | 命令 | exit | 结果 |
|---|---|---:|---|
| focused | `npm run test:focused` | 0 | tests 181 / pass 181 / fail 0 / skipped 0，4.4 s |
| 类型检查 | `npx tsc --noEmit` | 0 | 0 条诊断（日志 0 字节） |
| 生产构建 + 体积门禁 | `npm run build:ext` | 0 | tsc + vite + build-electron + build-mcp + check-bundle-size 全过（extension 2 912 087 B / gzip 909 446 B / wasm 7 604 031 B） |
| 全量测试 | `timeout -k 15 600 npm test` | 0 | tests 3417 / pass 3414 / fail 0 / skipped 3，197 s（未触发 600 s 超时） |
| 新构建重生成 PV 工程 | `npm run regen:pv-buffer` | 0 | `PV_REGEN_RESULT ok=true checks=58 failed=0`，真实 Electron + 真 B-Rep |
| 工程会话冒烟 | `PROJECT_SESSION_SMOKE_CAD=…/cube-mm.step node scripts/project-session-smoke.mjs` | 0 | `PROJECT_SESSION_SMOKE_CAD_PASS parts=1` + `PROJECT_SESSION_SMOKE_PASS` |

说明：全量套件此前曾因 CLI 子测试长耗时被人工停止，本轮在 600 s 上限内跑完；仍建议保持 `timeout -k 15 600` 这种有界跑法，不要把无界等待当成通过。

## 缓存控制层 API 边界（本轮收紧，勿读宽）

`desktop/src/machine/buffer-control.ts` 有两个入口，能力不同，不能互相替代：

- `evaluateBufferControl(input)`：**单帧电平映射**，纯只读、无记忆、**不仲裁**（两侧许可可同时为真）。只用于兼容旧契约。
- `stepBufferControl(memory, input)`：一次调用 = 一个扫描周期，带记忆的事件序列状态机。以下是本轮定稿的边界：

1. **完成计数严格 +1**（`consumeSeq`）。`seq === seen + 1` 才接受并销账；`seq <= seen` 记 `TRANSFER_DONE_IGNORED`；`seq > seen + 1` 记 `TRANSFER_SEQ_GAP` 并**拒绝**——不销账、不推进计数。旧行为是“接受跳号 + 记事件”，那会让一件没有真实完成的料被静默少算一件，已废止。
2. **重基只允许下抬**（`transferSeqRebase <= transferSeqSeen`）。上抬一律 `TRANSFER_SEQ_REBASE_BLOCKED`。前置条件：无锁存故障、无在途转移、`transferDone` 为低，且**现场已确认** PLC 计数已归零、上一轮完成脉冲已排空。这条前提是人工/上位机责任，本层无法自证。
3. **复位/对账/重基当拍不启动转移**（`state.arbitrationHeld=true`）。同一报文里给“对账 + 复位 + 下游就绪”不会在同一扫描周期就重新发起出料；至少空一个监督拍。进料仍按正常规则判定（不吞来料），冻结拍内不产生争用事件。
4. **对账只有显式 `reconcile:'confirmed'|'aborted'`** 能清未知件。`confirmed` 只出队被打断的那一件；`aborted` 留队。有未对账件时复位被 `RECONCILE_REQUIRED` 拒绝。
5. **对账消费序号与正常完成同口径**（走同一个 `consumeSeq`），跳号在对账路径上同样被拒绝并记 `TRANSFER_SEQ_GAP`。
6. **完成信号语义必须显式声明**：缺省 `edge`（上升沿），`transferDoneMode:'level'` 为电平常高握手，每个在途转移只接受一次。`level` 是对现场握手的断言，不是默认放宽。

已知能力缺口（不是本轮 bug，是设计边界）：

- 计数器必须**从 0 起、按 +1 递增**。若现场 PLC 计数器不从 0 开始或已跑偏，本层无法直接“同步到现值”（重基不许上抬），只能把 PLC 计数零化后再 `transferSeqRebase:0`；**“带独立确认的同步/对齐操作”本轮未实现**。
- 锁存故障期间给 `incomingItemId` 不产生任何事件（上游来料在故障期被丢弃时调用方拿不到拒绝理由）。
- 本层是纯数据状态机：不写 IO、不连设备、不代表已实现 PLC 程序或安全回路。

## 8 层 = 8 储位，不等于 16 位

- `layers: 8` 的几何只对应 **8 个储位**（第 1 层是底层输送线）。
- `16` 位只存在于 `bufferTower` 纯数据槽位模型（容量分析的结论），**没有**对应的 8 层几何实现。
- regen 报告固定输出 `slotsFromGeometry=8 claimedSlots=16 aligned=false`，任何“16 层/16 位几何”的说法都是误读。

## sceneIntegrity 现状与剩余风险

现状：`desktop/src/cad/scene-integrity.ts` 是**计数等式门禁**——两个计数必须是非负整数，模型件数 == 场景件数（可选再等于期望件数），否则 `complete=false` / `assertSceneIntegrity` 抛错。UI 页脚显示 `场景完整性：90/90 件`，隐藏件数单独提示。

剩余风险（必须一起说）：

- 只证明**件数一致**，不证明几何正确：错形状、错位置、错层级、错朝向都能 90/90 通过。
- 不证明 180 mm 层距下的 lift/sweep/push 动态干涉、结构强度、挠度、防坠。
- 计数来自 viewer 诊断聚合，历史上有过“实例重复计数”缺陷（已修）；任何新增实例化路径都要重新验证计数口径。
- 隐藏/批量实例的计数口径依赖 `viewer.ts` 的聚合实现，改渲染层时要同步跑 `test/cad/scene-integrity.test.mjs` 与 regen 的 90/90 断言。

## 真实光伏缓存机设计结果（历史，未变）

独立测试 userData：`/tmp/automationcad-pv-buffer-live`（不纳入仓库，不复制密钥，不推送）

- 工程名：`PV缓存单塔8位概念验证-180`；光伏组件 2278×1134×35 mm，单件 32 kg
- 上游 12 s/件（5 件/分钟），下游 15 s/件（4 件/分钟），下游停机 120 s
- 初始库存 2、在途 1、预留 2 → 停机新增 `ceil(120/12)=10`，占用 13，需求 15 → 16 位可覆盖该窗口；正常净积料 1 件/分钟
- 有限缓存不能解决长期产能差：必须背压、上游减速或下游提速
- 当前严格 180 mm 八层产物：90 件 / 47 实体 / 包络 2430×1690×2400 mm / `model.step` 约 782 KB / `model.stl` 约 1.02 MB / 质量约 827 kg
- 旧 `/tmp/automationcad-pv-buffer-iter` 里的历史产物是 250 mm 层的旧结果，不能改参数后声称几何已更新

## 当前工作区重点文件

既有修改（M）：

- `desktop/electron/write-confirm.ts`、`desktop/package.json`、`desktop/scripts/machine-e2e.mjs`
- `desktop/src/agent/confirm-card.ts`、`desktop/src/agent/tools.ts`
- `desktop/src/cad/viewer.ts`、`desktop/src/canvas/canvas.css`、`desktop/src/desktop-api.d.ts`
- `desktop/src/extension.ts`、`desktop/src/machine/conveyor-assembly.ts`、`desktop/src/machine/model-builders.ts`
- `desktop/src/ui/workspace.css`
- `desktop/test/agent/design-machine.test.mjs`、`desktop/test/machine/cli.test.mjs`、`desktop/test/machine/conveyor-assembly.test.mjs`

新增（??）：

- `desktop/src/machine/buffer-control.ts`、`buffer-io.ts`、`buffer-io-map.ts`、`buffer-tower.ts`、`buffer-capacity.ts`
- `desktop/src/cad/scene-integrity.ts`
- `desktop/scripts/pv-buffer-regenerate.mjs`
- 对应测试（`test/machine/buffer-*.test.mjs`、`test/cad/scene-integrity.test.mjs`、`test/machine/pv-buffer-regenerate.test.mjs`）
- 文档：`docs/desktop/PV-BUFFER-LIVE-DESIGN.md`、`PV-BUFFER-SOFTWARE-IMPROVEMENTS.md`、`PV-BUFFER-ITERATION-HANDOFF.md`、本文件

## 尚未完成的关键工作

### 设计/控制

- 双塔真实结构和镜像几何；托盘几何、空托盘回流、真实升降台、伸缩叉、丝杠、导轨、抱闸、防坠
- 缓存塔专用 `MachineConfig` 与真实几何生成入口
- 纯数据 FIFO 尚未接入真实设备状态，无伺服/传感器闭环
- PLC 程序与真实硬件联调；计数器同步/对齐操作（见上）

### 电气/安全

- 完整 IO（16 位到位检测、升降/叉原点与限位）；IO 草案地址仍为 `null`，`executable=false`
- 双通道急停、安全门、光幕、安全继电器/安全控制器——普通 DI 不能替代
- 现有 90 件 BOM 不等于完整电气 BOM

### 校核

- 正确缓存塔 config 下的 lift/sweep/push 动态干涉
- 结构强度、挠度、防坠、链条/丝杠载荷
- 双塔同时进出、汇流争用、空托盘回流后的真实吞吐
- 静态 AABB 命中必须拆分 mates/confirmedHits，不能直接当制造碰撞结论

### 软件一致性

- P3-1：CLI 静态守卫**只统计 `execFileSync(`**，`spawnSync`/`execSync` 一行即可绕过（守卫本身已加，见下）
  - 已改（`test/machine/cli.test.mjs`，非「未改」）：所有 CLI 调用收进 `runCli()`（`execFileSync` 带 `timeout` + `killSignal:'SIGKILL'`，runner 的 `{timeout}` 管不住占死事件循环的同步子进程）；新增「子进程到点被硬杀」用例，以及剥注释后必须只剩 1 处 `execFileSync(` 的静态守卫。
  - 仍剩：静态守卫的匹配式只有 `execFileSync(`，改成 `spawnSync`/`execSync` 一行就能绕过。
- P3-4：CLI catch-all 仍把内部异常报成 `INVALID_ARGUMENT`
- `sceneIntegrity` 仍是计数门禁，可继续纳入更多正式交付门禁，但不要当成几何正确性证据

## 下一会话建议顺序

1. 读本文件 + `docs/desktop/PV-BUFFER-ITERATION-HANDOFF.md`、`git status`、`git log`，确认不丢本地修改。
2. 若接现场 PLC：先补“计数器同步/对齐”入口与“故障期来料拒绝事件”，再谈接线。
3. 审查当前全部 diff，特别是 `desktop/src/agent/tools.ts` 的只读诊断返回形状。
4. `npm run kb:build` 只索引 `desktop/src/agent/kb/index.ts` 里 `KB_DOC_FILES` 那 13 份文档（不含 `PV-BUFFER-*.md`）；改那 13 份中的任何一份后必须重建，否则 `test/agent/kb-freshness.test.mjs` 会失败。
5. 最后：`npm run test:focused` → `npx tsc --noEmit` → `npm run build:ext` → `timeout -k 15 600 npm test` → `npm run regen:pv-buffer` → project-session-smoke。

## 安全与数据注意事项

不要删除或覆盖 `/tmp/automationcad-pv-buffer-live`、`/tmp/automationcad-pv-buffer-iter`，其中有真实智能体设计工程和模型结果；不要把其中任何密钥复制到仓库或文档。IO 草案地址为 `null` 是有意设计，必须经电气与安全工程确认后才能分配真实地址。
