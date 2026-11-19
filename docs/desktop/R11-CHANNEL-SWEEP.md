# R11 · 升降通道 sweep 口径收口与归零路线决策书

**状态：`sweep` 仍 fail（判据一字未改）。本文件不是绿色回执，是把「405 / 42 对」这个沿用两轮的错口径钉死，并把两条归零路线写成需要拍板的设计决策。**

复现（本机，非 CI 读数）：

```bash
cd desktop
AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python npm run verify:channel -- --levels 2
AUTOMATIONCAD_PYTHON=/root/.venvs/b123d/bin/python npm run verify:channel -- --levels 16
```

两档都是 **30/30 自证通过（正向 16 / 负向 14）**、exit 0（诊断脚本；`feasible=false` 不是脚本失败）。

**层数**：脚本对 **2..64 层**跑同一套断言。17 层起建造器会让 `gearmotor × column-bl` 相交 1 对（柱截面随塔高派生、柱位外移），
这不是通道判据：§5 把它单列成 `sweepEvidence.baselineGeometry`，**从通道对里真的剔出去**并把它的步数从闭合计里显式扣掉
（`channelStepSums + baselineGeometry === confirmedHits/screenHits`）。所以 `--levels 17` 也是 30/30、exit 0 ——
上一版「filter 完再断言 filter 没改变任何东西」在这个层数上是必红的（R11 审查 P1-2 修的就是这个，原先 CI 只跑 2/16 看不见）。

---

## 1. 三个数各是什么（口径，先钉死）

| 数 | 是什么 | 16 层实测 | 与层数的关系 |
|---|---|---|---|
| **405** | `sweep.confirmedHits + screenHits`，**步累计** | 270 确认 + 135 待复核 | 15 层 × 每层 9 个命中步 = 135 个命中步；**每命中步 2 确认 + 1 待复核**（270 = 135×2、135 = 135×1），135 步 × 3 = 405 |
| **60** | **去重后的问题对数**（同一对在多个高度重复命中只算 1 对） | 60 = 15 层 × 4 | 线性：`(levels − 1) × 4`，2 层 = 4 |
| **42** | **单步 `pairs`**（该步所有重叠对，含 38 条已声明连接基线） | 42 = 38 + 4 | **与层数无关**：2 / 8 / 16 层都是 42 |

**分解式必须这么写（上一轮的错法记在这里）**：每层 9 个命中步里，托板本体命中 4 步、两条托条各命中 7 步、托辊命中 9 步
→ 每层 **18 确认**（4 + 7×2）+ **9 待复核**（托辊只有 AABB 依据）= 27 次命中，15 层 × 27 = **405**；
等价说法是「每命中步平均 2 确认 + 1 待复核」（`verify-channel.mjs` 的 `sumConfirmed/sumScreen` 断言就是从逐对步数合出这两个数）。
**绝不能写成「每步 3 确认 + 1 待复核」** —— 那是 4 次/步 × 135 = 540 ≠ 405，与脚本自己的闭合断言直接矛盾（R11 审查 P1-1）。
另：单步确认数并不恒等于 2（实测分布 0/1/2/3 次，均值 2），「2 + 1」是 135 步上的总量口径，不是每一步都恰好 3 次。

所以「16 层 42 对干涉」这句话两处都错：42 是**单步**的对数、其中 38 对是已声明的结构连接；真问题对是 60，而 405 是同一批对在 9 个高度上被重复计数 405 次。数字由 `verify:channel` 的 `SWEEP_EVIDENCE` 一行实时派生（脚本里没有 405/60/42/15 这些常量）：

```
SWEEP_EVIDENCE {"levels":16,"stepMm":10,"sweepSteps":271,"hitSteps":135,
 "confirmedHits":270,"screenHits":135,"reviewStatus":"fail",
 "dedupedPairs":60,"derivedDedupedPairs":60,"trayLayers":15,
 "xOverlapMm":{"min":50,"max":240},"trayBodyYOverlapMm":1080,
 "retractedVariant":{"retractMm":250,"confirmedHits":0,"screenHits":0,
  "reviewStatus":"pass","feasible":false,
  "blockers":["load-passes-shelf","stroke-shortfall"],"restClaim":"unsupported"},
 "feasible":false,"blockers":["load-passes-shelf","stroke-shortfall"]}
```

三条**正向**自证（不带 N 编号，`counts = {total:30, positive:16, negative:14}`）：

1. **去重对数由件表派生**：逐层取托板家族（本体 + 两侧托条 + 两个辊）里与台面投影双向相交的件 → 每层 4 件、合计 60，与 `channelPairs.length` 逐值相等；且逐对命中步数之和 = `270 + 135`（步累计口径闭合）。
2. **全部 suspect 对都是「台面 × 固定件」**，x/y 重叠由件表几何独立复算一致（容差 0.05，与脚本里 `near(…, 0.05)` 一致）。逐族：托板本体 x=230 / y=1080（= 板全宽，**y 向没有走廊**）、托条 x=240 / y=40、进料辊 x=50 / y=610（AABB 待复核）。
3. **归零 ≠ 可行**：台面外移（最大 x 重叠 + 一个 10 mm 扫掠步 = 250 mm）后 `sweep` 归零（0+0、pass），但 `feasible` 仍 `false`、blockers 仍 `load-passes-shelf / stroke-shortfall`、rest 仍 `unsupported`。

## 2. 为什么这轮不能把 sweep 修成 0

命中的几何（件表实测，16 层）：

| 件 | x | y | z | 与台面的 x 重叠 |
|---|---|---|---|---|
| `lift-platform`（moving） | −1120 … −800（320 宽） | −540 … 540 | 970 … 1010 | — |
| `tray-N` 托板本体 | −1030 … 1030 | −540 … 540 | 3 mm 厚 | **230** |
| `tray-rail-N-left/right` 托条 | −1040 … 1040 | 40 宽（±350 侧） | 1040 … 1080 | **240** |
| `tray-roller-N-in` 进料辊 | −1005 … −955 | 610 宽 | 1033.5 … 1083.5 | **50** |

台面在托板投影内、y 向与板等宽（重叠 1080 = 板全宽），**塔身不存在任何一条能让台面从托板旁边过去的通道**。这不是判据缺陷、也不是求解器问题：`interference-states.ts` 与 `buffer-tower-assembly.ts` 早已把这次命中写成设计代价。三条「归零」路里，放宽判据/加豁免是造假（与源码明文冲突），侧叉挪到板外会让承托掉到 0（已有负例守着）。

## 3. 两条真解 = 机构变更（需拍板）

### 路线 ①：台面缩回（x 向退 240 mm）

- 需要台面 maxX ≤ 托条 minX（−1040）才不撞 → **退 ≥ 240 mm**；台面 320 宽 → 若整体退，净可用宽度只剩 ≤80 mm（或改成偏置/单侧叉，等价于重新设计台面）。
- 代价：台面本来承担 carried 承托（板被抬起的接触面），宽度砍到 80 mm 会直接改变 carried 的接触面积与抗倾覆；现有 carried 判据（`minBands: 2`）本来就没通过（`diagnostic-only`），改完仍然是红。
- 校核前提：台面缩窄后的承载/挠度、板在窄台上的抗倾覆、导轨与升降架刚度。

### 路线 ②：每层托板左侧开 240 宽缺口（梳齿/避让）

- 缺口 ≥240 才能让台面通过；残余托板从 x≈−790 起，板（2278 长，x −1139…1139）**左端约 349 mm 悬空**。
- 代价：残余托板只剩单侧支撑带宽，板的悬臂/扭转完全没算；缺口处托条与辊要断成两段，局部刚度与辊道连续性都变了。
- 校核前提：悬臂挠度与扭转（板自重 + 载荷）、缺口两侧托条的连接刚度、断辊后的输送可靠性、以及每层缺口的可制造性/成本。

### 为什么「两条路都不许本轮实施」

两条都是**机构变更 + 结构校核**，不是判据/脚本能决定的事。更关键的是：**现有承托判据与「归零」目标在这条边界上直接冲突**（数字可复算）：

- 让 `sweep` 归零：缺口必须 ≥ 240（托条绑定）；
- 让现有 `minBandOverlapXmm = 1900` 判据仍绿：残余托板跨度 `2060 − 缺口` 必须 ≥1900 → 缺口 ≤ **160**。

240 vs 160 → **冲突窗 80 mm**。也就是说：缺口做够 240 时，现有承托判据会自己红（残余跨度 1820 < 1900）；缺口做窄到 160 时，台面仍插进托条 80 mm，`sweep` 仍 fail。任何「两边都绿」的方案都必须先动阈值或改支撑布置 —— 那已经是设计变更，不是收口。

## 4. 诚实结论：现有承托判据看得见什么、看不见什么

- **看得见**：覆盖率、接触带条数（≥2）、每条带沿板长的 x 跨度（≥1900）。缺口 240 会把每带 x 跨度压到 1820 → 判据会红。所以「承托损失完全看不见」这句话不准确，本文件更正为下面这条。
- **看不见**：这是**接触几何阈值**，不是结构判据 —— 没有悬臂长度、没有板自重/载荷下的挠度与扭转、没有缺口处的局部刚度与断辊影响，也没有偏心支撑下的抗倾覆计算。它无法回答「349 mm 悬臂能不能托住板」；也无法在有人放宽 1900 或改支撑布置后阻止假绿。
- 因此：**「改完 sweep 绿」不能证明托得住**；反过来，`sweep` 归零后 `feasible` 仍 `false`（第 1 节自证 ③ 已实测），承托结论不变（rest `unsupported`、carried `diagnostic-only`）。

## 5. 本轮实际交付（只收口证据，不改判）

| 项 | 内容 |
|---|---|
| `interference-states.ts` | 新增 **opt-in** `collectChannelPairs?: boolean`（默认 `false`，与 `requirePanel` 同形）：`true` 时 `states.sweep.channelPairs` 给出**不截断**的 suspect 对（a/b/confirmation/confirmedSteps/screenSteps/zStepsMm/zBandMm/maxOverlapMm3/xOverlapMm/yOverlapMm）。默认关闭是硬约束：六十对量级会把 MCP/agent 的 10 KB 工具结果顶爆，四态 summary 被裁成 preview。 |
| `verify-channel.mjs` | 末段一行 `SWEEP_EVIDENCE`（`--json` 时在 `summary.sweepEvidence`）+ 3 条正向自证（上表 ①②③），所有量从件表/几何派生。 |
| `buffer-tower-channel.test.mjs` | `counts` 严格改为 `{total:30, positive:16, negative:14}`（`deepEqual`，不放宽），负向仍恰好 N1..N14；新增断言：证据 3 条且不带 N 编号、`dedupedPairs === derivedDedupedPairs`、`reviewStatus === 'fail'`、外移变体 `confirmedHits === 0` 且 `feasible === false`。 |
| 本文件 | 口径 + 两条归零路线的设计决策请求（缩回 240 vs 开缺口 240）+ 结构校核前提 + 承托判据的可见/不可见边界。 |

## 6. 不许越过的结论（后续轮次照抄，不许改写）

1. **升降通道未通**：`sweep` 仍 fail；405 = 270 确认 + 135 待复核是**步累计**，去重 **60 对**（台面 × 托板族），`feasible=false`。
2. **归零路径未实施**：缩回 240 mm / 开 240 缺口都是设计变更 + 结构校核，本轮只出决策书。
3. **承托结论不变**：rest 单条整带 → `unsupported`；carried → `diagnostic-only`。27→30 条自证是**尺子自证**，不是结构验收。
4. **「sweep 归零」与「托得住」是两件事**：外移变体归零但 `feasible` 仍 false，已有实测与测试双守。
5. 本机数字不是 CI 读数；本轮未改任何判据、未豁免任何对、未动 blockers。
