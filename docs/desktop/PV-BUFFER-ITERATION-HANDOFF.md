# PV 缓存机迭代交接（软件侧）

本轮：2026-11-18，复审 N1–N6 整改 + 全链路验收。仓库 `/tmp/automation-cad-prototype`（`main`，HEAD `a2fc5c8`，改动未提交）。

## 本轮做了什么（只写真实发生的）

1. 落实独立复审（`cad-rereview.md`）的 6 条新发现 N1–N6，改动集中在 `buffer-control.ts` / `pv-buffer-regenerate.mjs` 及其两条测试，未重写、未改已通过的行为。
2. 串行跑完 focused → tsc → build:ext → 全量 test → regen → project-session-smoke，全部 exit 0。
3. 更新交接文档并重建知识索引（`npm run kb:build`）。

### 实测结果

| 步骤 | 命令 | exit | 关键数字 |
|---|---|---:|---|
| focused | `npm run test:focused` | 0 | 181/181 pass，0 fail，4.4 s |
| 类型检查 | `npx tsc --noEmit` | 0 | 0 诊断 |
| 构建 + 体积门禁 | `npm run build:ext` | 0 | extension 2 912 087 B，gzip 909 446 B，wasm 7 604 031 B |
| 全量 | `timeout -k 15 600 npm test` | 0 | 3417 tests / 3414 pass / 0 fail / 3 skipped，197 s |
| 重生成 | `npm run regen:pv-buffer` | 0 | `PV_REGEN_RESULT ok=true checks=58 failed=0`，90 件真几何 |
| 会话冒烟 | `project-session-smoke.mjs` | 0 | `PROJECT_SESSION_SMOKE_CAD_PASS parts=1` + `PROJECT_SESSION_SMOKE_PASS` |

原始日志：`/root/.hermes/cache/scratch/cad-delivery-{focused,tsc,build-ext,test,regen-pv-buffer,project-session-smoke}.log`。

## N1–N6 处置

| ID | 处置 | 现在的行为 |
|---|---|---|
| N1 | 修复 | 复位/对账/重基当拍**不启动转移**（`state.arbitrationHeld=true`），至少隔一个监督拍；进料不吞，冻结拍不产生争用事件 |
| N2 | 修复 | 完成计数严格 +1：跳号（`seq > seen+1`）记 `TRANSFER_SEQ_GAP` 并**拒绝**，不销账、不推进。重基后被重新打开的旧序号不再能销掉一件没完成的料 |
| N3 | 修复 | 重基只允许**下抬**（`<= seen`），上抬一律 `TRANSFER_SEQ_REBASE_BLOCKED`；被写成超大值的记忆可用下抬恢复 |
| N4 | 修复 | `findOwnedLeftovers` / `terminateOwned` 对非空绝对路径以外的 `userData` **抛错**（fail-closed），不再静默返回 `[]` 让上层记成“清理干净” |
| N5 | 收窄 | `tree` 证据也受 `sinceTicks` 约束；注释讲清“防 PID/组 id 复用”只对 token/tree 成立，组证据靠 pid 未被复用 |
| N6 | 修复 | `reconcile` 消费序号改走同一个 `consumeSeq`，跳号同样记 `TRANSFER_SEQ_GAP` |

回归用例：`test/machine/buffer-control.test.mjs` 新增 5 条（N1×2、N2、N3、N6），`test/machine/pv-buffer-regenerate.test.mjs` 新增 1 条（N4）并在 ownership 矩阵里加了 `tree` 启动时刻反例（N5）。

## API 边界（不要读宽）

`evaluateBufferControl`：单帧电平映射，纯只读、无记忆、**不仲裁**（两侧许可可同时为真），仅兼容旧契约。

`stepBufferControl`：一次调用 = 一个扫描周期，带记忆的事件序列状态机。

- 完成计数严格 +1；`<= seen` 忽略，`> seen+1` 拒绝并记 `TRANSFER_SEQ_GAP`。
- 重基只下抬；前置条件 = 无锁存故障 + 无在途 + `transferDone` 低 + **现场确认 PLC 计数已归零且完成脉冲已排空**。最后一条是人/上位机责任，本层无法自证。
- 复位/对账/重基当拍冻结出料一拍。
- 未知件只能显式 `reconcile:'confirmed'|'aborted'` 清除；`confirmed` 只出队那一件。
- `transferDoneMode:'level'` 必须显式声明（电平常高握手），缺省 `edge`。
- 本层纯数据：不写 IO、不连设备、不是 PLC 程序、不是安全回路。

### 仍未实现

- 计数器“同步/对齐到现值”的操作（因为重基不许上抬）：现场计数器不从 0 起时必须先把 PLC 计数零化。
- 锁存故障期间 `incomingItemId` 不产生任何事件，调用方拿不到拒绝理由。
- 任何真实设备闭环、伺服、传感器、PLC 程序。

## 8 层 ≠ 16 位

`layers:8` 的几何只有 **8 个储位**（第 1 层是底层输送线）；`16` 只存在于 `bufferTower` 纯数据槽位模型。regen 固定输出 `slotsFromGeometry=8 claimedSlots=16 aligned=false`，报告里也这么写。

## sceneIntegrity 现状与剩余风险

现状：计数等式门禁。两个计数必须是非负整数，模型件数 == 场景件数（可再要求等于期望件数），否则 `complete=false`（`assertSceneIntegrity` 抛错）。UI 页脚显示 `场景完整性：90/90 件`。

剩余风险：

- 只证明件数一致，**不证明几何正确**：错形状、错位置、错层高、错朝向都能 90/90 通过。
- 不证明 180 mm 层距下的 lift/sweep/push 动态干涉、结构强度、挠度、防坠。
- 计数来自 viewer 诊断聚合，历史上出现过实例重复计数（已修）；新增实例化路径必须重跑 `test/cad/scene-integrity.test.mjs` 与 regen 的 90/90 断言。
- `complete=true` 不是“可以交付制造”的结论。

## 不要宣称的东西

- 不要说“缓存机已实现”：现有的是纯数据状态机 + 逻辑 IO 草案（地址 `null`，`executable=false`）。
- 不要说“16 位几何已完成”：只有 8 层 8 储位的几何，16 位是容量模型结论。
- 不要说“动态干涉/强度已校核”：静态 AABB 命中不等于制造碰撞结论，动态干涉与结构校核未做。
- 不要用 focused 的子集结果替代全量结论，也不要把旧迭代的 250 mm 产物当成 180 mm 结果。

## 下一步建议

1. 接现场前：补计数器同步入口 + 故障期来料拒绝事件。
2. `npm run kb:build` 只索引 `KB_DOC_FILES` 里那 13 份文档（本文件不在其中）；改了那 13 份要重建，否则 `test/agent/kb-freshness.test.mjs` 失败。
3. 始终保持有界跑法：`timeout -k 15 600 npm test`；不要把无界等待当通过。
