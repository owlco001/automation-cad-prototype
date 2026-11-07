# 自然语言设计机器（三）：工艺模板 + 追问策略 + 真实模型评测

状态：已完成（2026-10-24）。用户可以用一句中文描述机型需求，由纯函数解析并合成一份可确认的 `MachineConfig` 方案；缺执行机构描述时按五类工艺模板补全；信息不足时最多追问一次；确认后通过 `apply_machine_design` 写入工程，并联动刷新 3D 联调视图、BOM 草稿与可选 PLC 点位映射。迭代 34 起，方案会再经纯函数 `generateMachineGeometry` 生成**带真实毫米尺寸的参数化整机几何**（机架、工位底板、门架、气缸、夹爪、旋转台、传感器、安全光栅、输送线/分度转盘），3D 联调视图直接渲染它，并落盘 STL / glTF / sidecar 实体列表（见第 6 节）。

## 1. 能力边界

- **几何是「按规则摆放的标准件外形」，不是结构设计**：`generateMachineGeometry` 由 `MachineConfig` 生成真实 mm 尺寸与位置的装配（典型值：台面 850 mm、缸径 Ø32、M12 接近开关、50 方门架型材），运动件带轴向/行程/点位；但**不做**强度/刚度/挠度校核、零件间干涉求解、型号选型，不生成紧固件、钣金、气路/线缆、电柜，也不建模工位与输送线/转盘之间的上下料机构；输送线驱动与转盘分度没有接入点位。仍不会从 STEP 反推机构。
- **STEP 只能经 build123d sidecar 产出**：离线时只有 TS 三角网格（STL / glTF，圆柱为多边形近似）；sidecar 只有 box / 竖直 cylinder 与绕 Z 旋转，水平圆柱（接近开关、压力传感器、输送线电机）实体化时按**等截面积方棒近似**，并在 `approximated` 中逐个列出。
- **功率与成本是统一模型估算**：功率优先读取元件库额定功率，再按可配置的同时系数、负载率、效率与功率因数折算；成本按机械件、电气件、人工/调试分项。两者都是方案阶段粗估，不是实测功率、短路/电缆选型结论，也不是对外报价（详见 3.3）。
- **节拍是估算**：单工位动作时间 = 工艺固定余量 + 机构动作时间之和，再交给 `evaluateFlow` 按 `single / linear / dial / parallel / cell` 五种布局之一求值；均未计入上下料、通讯、人工干预、调试损失与真实加减速曲线。公式与边界见 3.1。
- **不做安全决策**：不提安全等级、不替代风险评估；安全光栅数量只按需求记录。
- **只读与写分离**：`design_machine` 只返回方案与摘要；`apply_machine_design` 才写文件、改 active 指针与联动视图，且必须经过用户确认、可用 `undo_last` 撤销。

## 2. 需求抽取 `desktop/src/machine/spec.ts`

```ts
parseMachineBrief(text: string): MachineBrief
```

返回字段：

```ts
{
  process: 'screw' | 'dispense' | 'assembly' | 'inspection' | 'packaging' | 'unknown',
  stations: number,            // 1–12，默认 2
  cyclePerMin: number | null,  // 件/分钟；也接受 秒/件、CT
  layout: 'single' | 'linear' | 'dial' | 'parallel' | 'cell' | 'line' | 'auto', // line 为 linear 兼容别名
  processes?: string[],        // 显式列出的工序名，如 ['上料','锁螺丝','检测','下料']
  actuators: { kind: 'cylinder' | 'gripper' | 'rotary'; count: number }[],
  sensors: { kind: 'proximity' | 'photoelectric' | 'safety' | 'pressure'; count: number }[],
  brand: string | null,
  voltage: '220VAC' | '380VAC' | '24VDC' | null,
  notes: string[]
}
```

可测规则：

- 工位：`三工位` / `四工位` / `六工位` / `12 工位`，支持中文数字与「两」；超过 12 截到 12 并记 note。
- 节拍：`分钟 20 件`、`20 件/分钟`、`3 秒一件`、`2 秒/件`、`CT 4.5s`、`节拍 6 秒`。
- 布局：出现「转盘 / 分度」→ `dial`；「单元式」→ `cell`；「并行 / 复制式」→ `parallel`；「流水线 / 线体 / 产线」或两个及以上不同工序 → `linear`；单一工艺 → `parallel`；工艺未知且多工位时兜底 `parallel` 并写 warning，提示可显式指定 `layout`。`processes` 按出现顺序记录识别到的工序名。
- 工艺：锁螺丝/锁付、点胶、装配/压装、检测/视觉、包装。
- 执行机构：气缸、夹爪/气爪、旋转轴/旋转台；`伺服`/`步进`带数量时按 `rotary` 建模，仅给 `750W 伺服` 这类驱动规格时写入 notes，不把 750 当数量。
- 传感器：接近、光电、安全光栅、压力。
- 品牌：汇川、台达、西门子、正泰、欧姆龙、施耐德、三菱、松下、基恩士、倍福、安川、罗克韦尔、ABB。
- 供电：220VAC / 380VAC / 24VDC。
- 缺省：工艺未知、工位数缺失、节拍缺失都会写 `notes` 缺省标记，不抛错。

## 3. 方案合成 `desktop/src/machine/synth.ts`

```ts
synthMachine(brief: MachineBrief, options?: {
  stationCount?: number;  // 1–12，覆盖 brief
  cyclePerMin?: number;   // >0，覆盖 brief
  name?: string;
  id?: string;
  parts?: readonly ComponentPart[];   // 元件库，用于读取额定功率与参考价
  pricebook?: Pricebook;              // 企业价格簿
  builtinPricebook?: Pricebook;       // 内置示例价格簿
  pricing?: MachinePricing;           // machine-pricing.json 解析结果
  pricingAssumptions?: readonly string[];
  voltage?: '220VAC' | '380VAC' | '24VDC';
}): MachineDesign
```

返回：

```ts
{
  config: MachineConfig,
  points: string[],       // ST1-EXT-A1 / ST1-RET-A1 / ST1-GRIP-A2 / ST1-ROT-A1 / ST1-PRX-S1 ...
  cycle: { mode, perMin, secondsPerPiece, stationSeconds, throughputPerMin,
           estimatedSecondsPerPiece, baseSeconds, slowestStation, slowestActionSeconds,
           requiredParallelStations, requiredTotalStations, meetsTarget, bottleneck },
  power: {
    va, totalVa, totalKw,
    byGroup: { name, count, ratedW, va }[],
    currentA,
    breakerSuggestion: { rating, poles: 1 | 2 | 3, margin },
    dc24: { loadW, supplyW, marginPct } | null,
    voltage, cosPhi, simultaneity, loadFactor, efficiency,
    assumptions: string[], warnings: string[]
  },
  cost: {
    material, electrical, labor, total, missingCount,
    byCategory: { category, subtotal, count, missing }[],
    assumptions: string[], warnings: string[],
    lines, laborDetail, boundary
  },
  bomDraft: { items: { kind, name, qty, role?, ratedW?, note? }[] },
  warnings: string[],
  assumptions: string[],
  form: { id, name, rationale, layout, geometry, score, alternatives, warning? }
}
```

合成规则：

- 工位均分机构与传感器；每个工位至少 1 个动作、至少 1 个到位检测。显式数量不足时补齐对应工位并写入 warning。
- 未给执行机构/传感器清单时，按 `templates.ts` 的工艺模板补全；assumptions 明确写「按 X 模板补全」。模板是纯数据，测试可直接读取 `TEMPLATES`。
- 缺工位时按模板默认 2 工位生成；缺节拍时按 10 件/分钟估算。两者都会同时写 warning 与 assumption。
- 点位按 `ST{工位}-{EXT|RET|GRIP|ROT|PRX|PHT|SAFE|PRS}-{A|S}{序号}` 生成，全部唯一。
- `synthMachine` 先调用 `pickForm` 选整机形态，再用形态的 `layout` 与 `indexSeconds` / `transferSeconds` 构造 `FlowModel`；`form` 随方案返回并用于几何与落盘。
- `secondsPerPiece = 60 / perMin`；`stationSeconds` = 工艺固定余量 + 该工位动作时间。所有布局统一由 `evaluateFlow` 求 `cycleSeconds`、`throughputPerMin`、`requiredStations` 与瓶颈；`MachineCycleEstimate.mode` 直接使用 `MachineLayout`（`single / linear / dial / parallel / cell`），旧字段保留。`parallel` 的 warning 以「并行同工序」开头，`linear` 以「流水线节拍瓶颈」开头，其余布局使用各自的 `mode` 标签。
- 功率由 `estimatePower(design, options)` 估算：优先使用 BOM/元件库中的单件 `ratedW`，缺失时按类别默认值并在 `warnings` 点名、在 `assumptions` 说明；检测到伺服/步进时，旋转轴按伺服组计入。
- 成本由 `estimateCost(design, options)` 估算：机械件、电气件按价格簿/元件库参考价 × 数量，伺服按驱动器 + 电机成对计价；人工/调试按工位数、形态系数与可配置工时单价估算；缺价行只计数、不猜价。
- BOM 草案按执行机构、传感器、电气分组；型号一律标「待定」，不编造品牌型号。
- 缺工艺/工位/节拍只记 warning，不阻断；每条缺省都在 `warnings` 里点名缺省值，并在 `assumptions` 说明假设。

### 3.1 通用产能模型 `desktop/src/machine/flow.ts`

产能不再写死在 `synthMachine` 里。`synthMachine` 只把 brief 的布局、工位组成与工艺模板映射成 `FlowModel`，统一调用纯函数：

```ts
evaluateFlow(model: FlowModel): FlowEvaluation

interface FlowModel {
  layout: 'single' | 'linear' | 'dial' | 'parallel' | 'cell';
  stations: number;
  copies?: number;           // parallel 副本数；缺省 = stations
  ops: FlowOp[];
  transferSeconds?: number;  // linear/cell 工位间转移，缺省 0
  indexSeconds?: number;     // dial 分度，缺省 0.6
  targetPerMin?: number;
}

interface FlowOp {
  id: string;
  name: string;
  seconds: number;           // 单件在该工序的作业时间
  station: number;           // 工位/单元组索引（0-based）
  optional?: boolean;        // 可选工序不计入关键路径，但计入成本
}
```

五种布局的公式：

| 布局 | `stationSeconds` | `cycleSeconds`（单件节拍） | 产能 | 达标所需工位/副本 |
|---|---|---|---|---|
| `single` | 全部工序求和，单元素数组 | `sum(ops.seconds)` | `60 / cycle` | 达标为 1；不可达为 `Infinity`（单工位无法靠加工位降节拍） |
| `linear` | `stationSeconds[i] = sum(第 i 站工序) + transferSeconds` | `max(stationSeconds)` | `60 / cycle` | `stations × ceil(max(工序和) / (目标节拍 - transfer))` |
| `dial` | `stationSeconds[i] = sum(第 i 站工序)`，不含分度 | `max(stationSeconds) + indexSeconds` | `60 / cycle` | `stations × ceil(max(stationSeconds) / (目标节拍 - index))` |
| `parallel` | 一套完整工序的时间和（各副本相同） | `stationSeconds / copies` | `copies × 60 / stationSeconds` | `ceil(stationSeconds / 目标节拍)` |
| `cell` | `stationSeconds[s] = sum(station=s 的工序)`，同一 `station` 为一组 | `max(stationSeconds) + transferSeconds` | `60 / cycle` | `stations × ceil(max(组时间) / (目标节拍 - transfer))` |

- `targetPerMin` 缺省时 `meetsTarget=null`、`requiredStations=0`；提供了目标才反解所需工位数并向上取整。
- `optional` 工序不进入关键路径与瓶颈，但仍保留在 `ops` 中计入成本；只有可选工序时关键路径按 0 秒处理并写 note。
- `notes` 记录所有默认值：`linear/cell` 的 `transferSeconds=0`、`dial` 的 `indexSeconds=0.6`、`parallel` 的 `copies=stations`，以及可选工序被排除等。
- 非法输入直接抛中文错误：工位不是正整数、`ops` 为空、工序时间 ≤ 0、工位索引越界、目标节拍/转移/分度时间非法。

布局选择 `chooseLayout(process, stations)` 与几何层共用 `dial` 工艺集合与工位上限（锁螺丝/装配、≤8 工位）；1 工位为 `single`，明确同工序复制时传 `sameProcess` 得到 `parallel`，其余为 `linear`。`cell` 只在显式指定时使用。解析器识别「转盘/分度」「单元式」「并行/复制式」等关键词；`layout:'auto'` 仍可解析，推断结论写入 `assumptions`。

边界：这是**静态产能估算**，不包含故障、换型、人工节拍、缓存区、上下料波动与真实加减速曲线；`transferSeconds` / `indexSeconds` 是固定分摊，不是运动仿真。仍不能替代节拍分析或现场测量。

### 3.2 整机形态库 `desktop/src/machine/forms.ts`

同一工艺可以落在不同机架上。`pickForm(brief, templates, options?)` 的候选池按四档优先级收敛：

1. **覆盖且达标**：`stationRange` 覆盖需求，且夹紧后的 `evaluateFlow(...).meetsTarget === true`。存在这类形态时只在这一档内按工艺适配 → 布局偏好 → 占地系数 → 推荐工位距离排序。
2. **仅覆盖**：没有覆盖且达标的形态时，只在覆盖形态中选，按「达标缺口最小 → 工艺适配 → 布局偏好 → 占地系数」排序。此时不把未达标硬标成达标，`warning` 写清目标、所选形态产能与缺口。
3. **仅达标（无覆盖时兜底）**：只有确实没有任何形态覆盖需求工位数时才允许进入这一档，取达标且工位距离最近的形态，并强制输出「无形态覆盖 N 工位」warning。
4. **全量按工位距离**：既不覆盖也不达标时，才在全部形态中按工位距离由近到远选择，并保留正式的非标工位 warning。

**预览夹紧**：预览前先把需求工位数夹紧到形态能力区间，即 `previewStations = clamp(需求, stationRange)`。`Candidate` 记录 `clamped` 与 `previewStations`，`evaluateFlow` 只使用夹紧后的工位数，避免「4 工位的 gantry-4 按 12 工位计算」造成产能虚高。`FormPick.stations` 返回实际预演工位数；`synthMachine` 用它生成 `config.stations`，因此 `config.stations.length` 不会超过所选形态的 `maxStations`。若被夹紧，`assumptions` 会写明需求值、支持范围与实际生成工位数。

覆盖判定仍用需求工位数，不用夹紧后的值：`noCoverage = !chosen.inRange`。无覆盖 warning 必须同时给出「支持范围 + 需求工位数 + 实际生成工位数」，例如「无形态覆盖 14 工位：已选 十二工位转盘机 支持 8–12 工位，需求 14 工位，实际按 12 工位预演/生成」。

典型回归：`十二工位转盘检测机，节拍 60 件/分钟` 现在只按 `dial-12` 的 12 工位预演，产能 `22.64` 件/分钟、`meetsTarget=false`，并给出 `37.36` 件/分钟缺口；不会再把 `gantry-4` 按 12 工位虚高成 `109.09` 件/分钟。

```ts
pickForm(brief, templates, { stationCount?, cyclePerMin? }): {
  form: MachineForm;
  score: number;
  alternatives: { form, score, difference }[]; // 固定 2 条，差异含占地/成本/换型
  warning?: string;
  evaluation: FlowEvaluation;
  stations: number;
}
```

| 形态 id | 名称 | 布局 | `stationRange` | `defaultStations` | `maxStations` | 适配工艺 | 占地系数 | 几何 |
|---|---|---|---:|---:|---:|---|---:|---|
| `dial-6` | 六工位转盘机 | `dial` | 2–6 | 6 | 6 | 锁螺丝 / 点胶 / 装配 / 包装 | 0.78 | `dial` |
| `dial-8` | 八工位转盘机 | `dial` | 6–8 | 8 | 8 | 检测 / 锁螺丝 / 装配 / 点胶 / 包装 | 0.95 | `dial` |
| `linear-4` | 四工位直线机 | `linear` | 2–4 | 4 | 4 | 五类工艺 | 1.00 | `linear` |
| `linear-8` | 八工位直线线体 | `linear` | 5–8 | 8 | 8 | 装配 / 检测 / 包装 / 锁螺丝 / 点胶 | 1.55 | `linear` |
| `gantry-2` | 双工位龙门机 | `parallel` | 1–2 | 2 | 2 | 点胶 / 锁螺丝 / 装配 / 检测 / 包装 | 0.90 | `gantry` |
| `dual-lane` | 双轨并行线 | `cell` | 4–6 | 6 | 6 | 检测 / 包装 / 装配 / 锁螺丝 / 点胶 | 1.35 | `dual` |
| `gantry-4` | 龙门四工位 | `parallel` | 4–4 | 4 | 4 | 点胶 / 锁螺丝 / 装配 / 检测 | 1.70 | `gantry`（4 头） |
| `hybrid-dial-linear` | 转盘+直线混合线 | `cell` | 6–6 | 6 | 6 | 装配 / 检测 / 包装 | 1.30 | `hybrid`（4 转盘 + 2 直线） |
| `cell-4` | 单元式四工位 | `cell` | 4–4 | 4 | 4 | 装配 / 检测 / 包装 | 1.20 | `cell`（2×2） |
| `linear-12` | 十二工位长线体 | `linear` | 8–12 | 10 | 12 | 装配 / 检测 / 包装 / 锁螺丝 / 点胶 | 2.20 | `linear` |
| `dial-12` | 十二工位转盘机 | `dial` | 8–12 | 10 | 12 | 检测 / 锁螺丝 / 装配 / 包装 | 1.35 | `dial` |

- 形态声明 `minStations / defaultStations / maxStations`，`stationRange` 由最小工位与 `maxStations` 推导，避免区间、推荐值与上限三处各写一份。
- 加载期执行 `assertMachineFormsConsistent()`：任一形态违反 `stationRange[0] <= defaultStations <= stationRange[1]`、`maxStations === stationRange[1]`（或区间倒置）时直接抛错；`validateMachineForms()` 仍负责收集全部可读错误（id 唯一、布局对齐、工艺/几何兼容等）。
- 形态参数进入产能模型：转盘 `indexSeconds`（dial-6 0.6 s、dial-8 0.45 s、dial-12 0.45 s）、直线/单元 `transferSeconds`（linear-8 0.8 s、linear-12 0.9 s、dual-lane 0.6 s、cell-4 0.5 s、hybrid 0.75 s）；`cell` 的 `geometry.lanes=2`（dual-lane、cell-4）同时进入 `FlowModel.lanes`，节拍 = `(最慢工位 + transferSeconds) / lanes`。
- 几何层优先使用 `form.geometry.kind`：`dial` / `linear` / `gantry` / `dual` / `hybrid` / `cell` 分别生成转盘、直线输送、独立龙门头、双轨、转盘+直线拼接、矩阵单元；1 工位仍回退单工位几何。
- 几何示意与工艺适配：
  - `gantry-4`：4 个独立龙门头按 2×2 排布，每头只覆盖 1 个工位，立柱/横梁/三轴滑台独立；大件点胶、锁螺丝不需要跨工位搬运。占地系数 1.70，明显高于双工位龙门 0.90。
  - `hybrid-dial-linear`：前 4 工位沿转盘均布，后 2 工位沿 +X 直线延伸，中间只保留 1 个转接滑台；适合「装配→检测」两段工艺，占地 1.30，比 2×3 双轨 1.35 更紧凑。
  - `cell-4`：2×2 矩阵，行/组间距 120 mm，组内串行、组间并行并可独立停线；适合多品种小件装配，占地 1.20。
  - `linear-12`：8–12 工位沿 X 拉成长线，链板输送、0.9 s 转移；适合多工序批量装配，占地 2.20，是库内最长形态。
  - `dial-12`：8–12 工位转盘，转盘直径按工位数增长（`max(Ø560, n×70×2)`），12 工位直径大于 4 工位；适合小件高速检测/装配。
- 落盘 `machine/<id>.json` 同时写 `form.id`、`form.geometry` 与两条备选，之后可复现同一形态。

边界：形态只在典型范围与静态节拍上选型，不包含占地 CAD 校核、换型时间、报价与真实结构干涉；warning 是提醒换型/扩产，不是自动改图。

### 3.3 功率与成本模型 `desktop/src/machine/power.ts` / `cost-model.ts`

#### 功率

```ts
estimatePower(input: PowerInput, options?): PowerResult
estimatePower(design: MachineDesign, options?): PowerResult
```

纯函数。`PowerInput.items[]` 每项包含 `role`（`servo / cylinder / gripper / rotary / sensor / safety / plc / psu / valve / other`）、`qty`、可选 `partId` 与单件 `ratedW`。计算顺序：

```text
P_eff = Σ(P_rated,i × qty_i) × Ks × Kf
P_in  = P_eff / η
S     = P_in / cosφ
I_单相 = P_in / (220 × cosφ)
I_三相 = P_in / (√3 × 380 × cosφ)
I_24V = P_in / 24
```

- 默认系数：同时系数 `Ks=0.7`、负载率 `Kf=0.6`、效率 `η=0.9`、功率因数 `cosφ=0.9`（24 VDC 主回路按 `1.0`）；每一项都会写进 `assumptions`。
- 断路器：`I × 1.25` 向上取 `6 / 10 / 16 / 20 / 25 / 32 / 40 / 50 / 63 A`；`380VAC → 3P`，`220VAC → 1P`（需要零线保护时可选 2P），`24VDC → 1P`。超过 63 A 时不硬凑，告警提示分回路或更大壳架。
- 额定功率来源：优先元件库中的「额定功率 / 功率 / 输出功率」等字段；安全光栅可从样本「消耗电流」按 24 V 折算。**只有缺失时才使用类别默认值**：伺服 750 W、气缸 5 W、夹爪 15 W、旋转轴 200 W、传感器 3 W、安全光栅 20 W、PLC 25 W、24 V 电源 350 W、电磁阀 4 W、其他 10 W。默认值会逐条写入 `assumptions`，缺失项同时进入 `warnings`。
- 24 VDC 回路单独统计传感器、安全光栅、PLC、电磁阀等负载；电源容量取 BOM 中 `psu.ratedW`，按 `(supply - load) / supply` 给出余量，负载超过电源额定 70% 时告警。
- 已选断路器交叉校验：BOM 中「总进线断路器」的额定电流传入后，`计算电流 > 已选额定` 告警必须放大或分回路；`已选额定 / 计算电流 > 1.6`（余量超过 60%）提示可评估降档。

#### 成本

```ts
estimateCost(design: MachineDesign, options?): MachineCostEstimate
```

- **机械件**：BOM 机械类按企业价格簿单价 × 数量；价格簿未命中时回退元件库参考价；仍无价格则标 `missing`，不计入合计并累加 `missingCount`。
- **电气件**：元件库 + 价格簿；伺服按「驱动器 + 电机」成对计价，方案只列其中一件时按同数量补齐另一件并标注。缺价同样只计数、不猜价。
- **人工/调试**：`工位数 × (机械工时 + 电气工时 + 调试工时) × 形态系数 × 工时单价`。默认每工位机械 8 h、电气 6 h、调试 4 h，工时单价 120 元/h；形态系数 `single=1.0 / parallel=1.05 / linear=1.1 / dial=1.15 / cell=1.2`。全部默认值写入 `assumptions`。
- **参数文件**：`<userData>/machine-pricing.json`，缺失或字段非法时逐项回落默认值，并把来源/回退原因写进 `assumptions`：

```json
{
  "power": { "simultaneity": 0.7, "loadFactor": 0.6, "efficiency": 0.9, "cosPhi": 0.9 },
  "labor": {
    "ratePerHour": 120,
    "mechanicalHoursPerStation": 8,
    "electricalHoursPerStation": 6,
    "debugHoursPerStation": 4
  }
}
```

**与 `cost/engine.ts` 的分工**：这里是刚合成方案的**方案阶段粗估**，允许型号待定与缺价，输出用于方案比较和预算区间；不含报价加成、税率、运费、线缆/线槽长度、端子接线工时与阶梯价导出。正式报价仍走 `cost/engine.ts` 的价格簿、缺价清单和导出流程，`total` 不能直接对外报价。

**适用范围**：方案阶段的容量粗估、断路器初选、24 V 电源余量、机械/电气/人工预算区间。**不适用**：短路电流与保护配合计算、电缆/线槽选型与压降校核、启动电流/谐波/无功补偿、电柜母排与温升、现场实测功率，以及任何对外报价或合同价格。定型前必须用驱动器、电机、电源、断路器与安全回路的最新样本复核。

## 4. Agent 工具 `design_machine`（只读）

只读工具，不需要二次确认；加入写工具 `apply_machine_design` 后，工具总数为 21（只读 11 + 写 10）。

```json
{
  "brief": "设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服",
  "stationCount": 3,
  "cyclePerMin": 20
}
```

`brief` 必填；`stationCount` 为 1–12 的整数；`cyclePerMin` 必须大于 0。返回：

```ts
{ ok: true, design: { config, cycle, power, cost, bomDraft, warnings, assumptions, form }, summary, geometry, needs: [], question: null }
```

`summary` 为中文摘要，≤600 字，包含工位、执行机构、传感器、节拍、功率与风险。`needs` / `question` 来自 `buildClarify(brief)`，供会话层决定是否先追问；完整需求返回空数组与 `null`。空 brief、超范围工位数、非正节拍返回 `INVALID_ARGUMENT`，不抛未捕获异常。

示例（标准输入）输出 `3` 工位、`6` 执行机构、`3` 传感器、目标 `20` 件/分钟；功率约 `1.09 kW / 1.84 A`，建议 `6 A / 3P` 断路器，24 V 余量约 `87%`；成本粗估 `¥10,938`（材料 `¥2,568` / 电气 `¥1,242` / 人工 `¥7,128`，缺价 `8` 行）。覆盖 3 工位的形态是 `linear-4`（2–4 工位），按 `linear` 模型估算 `18.87` 件/分钟，`meetsTarget=false`，warning 会说明缺口 `1.13` 件/分钟；把 `gantry-4` 的 4–4 工位放宽到需求 3 工位不合法，所以不会为达标而越界选择它。原始 BOM 草案 7 行（夹爪、旋转轴、接近开关、伺服驱动器、PLC、24 V 电源、电气控制辅材），映射到真实元件包后 11 行。

### 4.1 工艺模板 `desktop/src/machine/templates.ts`

| 工艺 | 缺省工位 | 每工位执行机构 | 每工位传感器 | 参考节拍（件/分钟） | 依据 |
|---|---:|---|---|---:|---|
| `screw` 锁螺丝 | 2 | 1 旋转轴 + 1 夹爪 | 1 接近开关 | 12–30 | 旋转轴拧紧、夹爪固定、接近确认到位 |
| `dispense` 点胶 | 2 | 1 旋转轴（三轴模组占位） | 1 压力传感器 | 10–24 | 三轴模组按旋转轴表达，压力确认胶路 |
| `assembly` 装配 | 2 | 1 压装气缸 + 1 夹爪 | 2 接近开关 | 8–20 | 双接近分别确认压装前后位置 |
| `inspection` 检测 | 2 | 1 旋转轴（相机位占位） | 1 光电 + 1 安全光栅 | 20–60 | 光电触发拍照，光栅隔离人工区 |
| `packaging` 包装 | 2 | 1 推料气缸 + 1 吸盘（夹爪） | 1 光电 | 12–30 | 推料入盒、吸盘取放、光电确认物料 |

未知工艺使用内部 `GENERIC_TEMPLATE`（每工位 1 气缸 + 1 接近开关），不计入导出的 5 类 `TEMPLATES`。模板的 `cycleRange` 只作参考，不硬性拦截用户目标节拍。

### 4.2 追问策略 `desktop/src/machine/clarify.ts`

```ts
buildClarify(brief: MachineBrief): { needs: ('process'|'stations'|'cycle')[]; question: string | null }
```

- 只看会显著改变方案的 3 项：工艺类型、工位数、节拍；执行机构/传感器缺失由模板补全，不追问。
- 最多返回 2 项 `needs`；多项合并成一个 `question`，由会话层只追问一次。
- 有默认值就不追问：例如「锁螺丝机」直接识别工艺；「两工位」「20 件/分钟」直接采用。
- 问题具体且带默认值：如「这台机器做几个工位？默认按 2 工位生成。」「目标节拍是多少（件/分钟）？默认按 10 件/分钟生成。」
- 用户不回答或明确要求按默认继续时，使用 `synthMachine` 的默认结果继续，并在 `assumptions` 中说明缺省项；同一方案不重复追问。

## 5. Agent 工具 `apply_machine_design`（写）

需要用户确认，成功后进入撤销栈；`undo_last` 恢复上一个 active 配置。入参二选一：

```json
{
  "brief": "设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服",
  "design": { "config": {}, "cycle": {}, "power": {}, "cost": {}, "bomDraft": {} },
  "name": "三工位锁螺丝机",
  "overwrite": false,
  "withBom": true,
  "withPlc": false
}
```

- `brief`：内部先跑 `parseMachineBrief` + `synthMachine`，再进入同一套校验。
- `design`：直接使用上一轮 `design_machine` 返回的完整方案，避免重复合成。
- `name`：可选，覆盖 `config.name`；`overwrite` 默认 `false`，同名文件存在返回 `FILE_EXISTS`。
- `withBom` 默认 `true`；`withPlc` 默认 `false`。

校验顺序：`validateMachineConfig` → 工位 / 执行机构 / 传感器 id 唯一 → 传感器 `part` 引用存在 → `design.points` 与配置点位一致。任一失败返回 `INVALID_ARGUMENT`，不写任何文件。

返回：

```ts
{
  ok: true,
  machineId, name,
  stations, actuators, sensors,
  warnings: string[],
  activePath, designPath,
  bomPath?, bom?: { count, added, source: 'machine-design' },
  plcPath?, plc?: { points },
  sceneRefreshed
}
```

### 5.1 文件布局

```
<userData>/machine/
  active.json                  # 当前工程指向：machineId / name / file / appliedAt
  <machineId>.json             # 完整方案：config + points + cycle + power + cost + bomDraft + warnings
  <machineId>/bom-draft.csv    # withBom=true 时写出的 BOM 草稿
<userData>/exports/plc/<machineId>/io-map.csv   # withPlc=true 时写出的点位映射
```

`machineId` 来自 `config.id`，落盘前净化：路径分隔符、控制字符、连续点与 Windows 保留名都会被替换；任何 `../` 或绝对路径都不能逃出 `machine/`。同名文件只有在 `overwrite=true` 时才覆盖，撤销时会恢复旧文件内容。

### 5.2 3D / BOM / PLC 联动

- **3D**：渲染层 `applyMachineConfig` 调用联调面板的 `setMachineConfig`，销毁旧 `createScene3D` 实例并用新 `MachineConfig` 重建。启动时 `machine:active` 读取 active 指针恢复上次方案；没有指针时保持内置 4 工位样机。
- **BOM**：`bomDraft.items` 转为 BOM 行，`kind` 映射为「执行机构 / 传感器 / 电气」，缺少型号统一写「模型待定」，来源标记 `machine-design`；行追加到当前 BOM 草稿并写 `bom-draft.csv`。
- **PLC**：`withPlc=true` 时复用 `plcgen/io.ts` 的点位收集与 `plcgen/tags.ts` 的地址分配，只输出 `io-map.csv`（点位 / 地址 / 方向 / 归属 / 类型 / 工位 / 说明），不生成完整 ST、序列或报警程序。

### 5.3 侧栏方案卡

`design_machine` 工具结果在侧栏渲染「机型方案卡」：工位数、执行机构、传感器、节拍、kW、电流、断路器建议、24V 余量，材料/电气/人工/合计与缺价件数，以及设计/功率/成本全部 warnings（黄色条，不折叠）与「应用到工程」按钮。按钮走计划确认；确认后执行 `apply_machine_design`，3D 视图切到新机型，并在卡片和反馈区显示「已应用：<名称>」。

### 5.4 参数化几何落盘

新增开关（工具数仍为 20）：`withGeometry`（默认 `true`）写 `machine/<id>/geometry.json`、`model.stl`（二进制，mm，Z 向上）、`model.gltf`（glTF 2.0，内嵌缓冲，extras 带零件与运动轴）、`sidecar-assembly.json`（≤50 实体/块的 `AssemblyDoc`），结果返回 `geometry` 摘要与路径；`withSolids`（默认 `false`）仅在 build123d 内核已就绪时逐块 `POST /build`（不隐式拉起 Python），全部成功才写 `solids/part-N.step`，否则整体回退 TS 网格并写 warning。几何文件进入撤销快照（base64）。`design_machine` 额外返回只读 `geometry` 摘要。

## 6. 参数化整机几何 `desktop/src/machine/geometry*.ts`

`generateMachineGeometry(config | design, { process?, layout? })`：纯函数、确定性；Z 向上、mm，X 为物料流向，-Y 为操作侧。典型值集中在 `GEOMETRY_DIMENSIONS`。

- 布局：`chooseLayout` 保持原规则（1 工位 `single`；锁螺丝/装配 2–8 工位 `dial`；其余 `linear`），形态可用 `form.geometry.kind` 覆盖为 `dial / linear / gantry / dual / hybrid / cell`。`dial` 为分度器 + 转盘，工位 -Y 朝向圆心，半径逐步加大到相邻占地不重叠再留 30 mm；`linear` 为工位间距 60 mm、操作侧输送线 + 电机；`gantry` 的 `heads>2` 时按 2×2 网格布置独立龙门头（每头两根立柱 + 横梁 + 滑台）；`hybrid` 把前 `dialStations` 个工位放在转盘上、其余工位沿 +X 接直线输送；`cell` 按 `rows × cols` 矩阵摆放，并加立柱 + 上下横杆安全围栏。工艺缺省从 `config.id` 推断。
- 机架：台面 20 mm、顶面 850 mm；60 方立腿 830 mm，跨距 >1200 mm 加中腿；4 根下横梁。
- 工位：底板 深 300 × 厚 15，宽 = 槽位之和（气缸 110 / 夹爪 130 / 旋转台 170）+ 100，最小 320；门架横梁高度按最长气缸反算，保证伸出不撞治具。
- 气缸：竖直下压，缸体 Ø40×(行程+70) + 活塞杆 Ø12 + 压头，缩回位露杆 25；轴 `linear` [0,0,-1]，`strokeMm = travelMm`。夹爪：本体 64×40×56 + 双指，张开位，轴 `gripper` 每指半行程。旋转台：底座 Ø110 + 台面 Ø140 + 偏心治具，轴 `rotary` 绕 Z 0→90°。
- **顶升/转向工位（`id=turner-lift` 或名称含「顶升 / lift」的直线轴）不建压机**：建自下向上的顶升台 —— 安装板 80×70×20、缸体 Ø40×(行程+70)、活塞杆 Ø12、左右两根 φ16 导柱、台板 100×90×12（随动），轴 `linear` **[0,0,+1]**、`strokeMm = travelMm`，与 config 的 `position` 同向。导柱画到台板底面为止（过孔/导套不建模），避免「圆柱穿方板」被解析式求交算成假互穿。这样 lift/sweep 的位姿就是几何里真有的位姿，不靠 `direction-overridden` 反向平移占位（旧做法会把活塞杆整根推进缸体）。
- 传感器：接近 M12、光电、压力靠近所测执行机构；同一排支架按支架宽 30 + 净空 6（节距 36）重排，不允许两只支架互插；超出底板可用宽度时告警而不是静默重叠。安全光栅为两根 35×35×600 立柱，共用材质一起亮灭。
- 输出：`parts[]`（唯一 `[a-z0-9-]` id、形状、中心、绕 Z 角、材质、`bomGroup`、归属、`moving`）、`moving[]`（`axis / pivot / strokeMm / rangeDeg / home / points / jaws`）、`stations[]`（含旋转矩形 `footprint`，`footprintsOverlap` 用分离轴判定）、`envelope / bounds`、`structureBom`（结构件，与 `bomDraft` 分开）。`geometryComponentCounts` 与 `bomDraft` 逐项对账。
- 导出：`geometry-export.ts` 网格 → STL / glTF；`geometryToSidecarAssemblies` 盒体 → `box`，竖直圆柱 → 内接种子方块 + `cylinder`（精确），水平圆柱 → 等截面方棒（列入 `approximated`）；`buildMachineSolids` 逐块实体化、任一块失败整体回退。
- 渲染：`geometry-three.ts` 与导出共用网格；`createScene3D` 不再画占位方块，`stats()` 增加 `geometryParts / envelopeMm / layout`，`parts` 口径与标注驱动优先级不变。

### 6.1 材质标识色：两条渲染链 + 像素闸门

整机 3D 有两条互不相干的渲染链，改颜色时不能只改一条：

1. **联调 3D / 设计向导**：`buildThreeMachine(geometry)`（`geometry-three.ts:72`）直接读 `GeomPart.color`，材质在内存里就是四色。
2. **CAD 视口**（`#cadEntryButton` 打开的那个，`docs/desktop/screenshots/23-pv-0*.png` 截的就是它）：`build_machine_model` 把参数化内核逐件导出的 **STL** 装配进 `CadViewer`（`extension.ts:2513` → `parseStandardCadBuffers` → `load-candidate.ts:27`）。STL 没有颜色通道，**颜色必须在导入边界按「件 → 材质」补**（`cad/machine-colors.ts`：`MATERIAL_COLORS` 作单一色源 → 线性 RGB；`loaders.ts:96` 的 `color` 参数），否则 `stageCadLoad` 只能退回 `DEFAULT_COLORS` 的六个低饱和灰，屏幕上一片灰——「几何里有四色、截图全灰」就是这么来的。

同一份色值还写进工程的 `partsList[].color`（`electron/projects.ts`），重新打开工程时按它还原，避免「刚建完有色、关了再开变灰」。GLB 导出（`viewer.getExportRoot()` → `GLTFExporter`）复用的就是视口这批材质，所以「视口有色」与「GLB 有 ≥4 个 material」是同一条链路的两端；GLTFExporter 对纯白会**省略** `baseColorFactor`，因此「无 baseColorFactor」本身就是「这件没上色」的硬证据。

灯光也按「看得出色相」定标（`viewer.ts:150`）：环境 0.75 + 主光 1.9 + 补光 0.45。旧的 hemi 1.35 + 2.1 + 0.65 把受光面直接推到过曝，`#7fb2e5` 洗成 `#c8d8d8`。

闸门（像素级，不读内存材质）：

- `machine:e2e` 第 14 步截完 `23-pv-04-transfer-3d.png` **立即**统计 3D 画布矩形内四种色相的像素（CIE76 ΔE < 25）；任一材质低于门槛、或四色合计 < 25000 px，该步失败（`scripts/lib/material-gate.mjs`）。
- 第 6 步导出 GLB 后立即查 material 数与 `baseColorFactor`（`scripts/lib/glb-inspect.mjs`），单白色材质会红。
- 同一实现可单独跑：`npm run gate:materials -- ../docs/desktop/screenshots/23-pv-04-transfer-3d.png [--rect x,y,w,h] [--min N]`；CI 的 Electron job 也跑这一步。

门槛：AL6063 / Q235 / PVC 各 ≥ 3000 px；**STEEL45 ≥ 1200 px**。理由是本机型 45# 件（滚筒 / 移载导向柱 / 同步轴）全装在机架内部：在 889×908 的 3D 画布上扫 12 个机位（方位 ±600px、俯仰 ±240px、缩放 ±700），STEEL45 命中像素最高 2209、默认机位 1660——要 3000 只能把镜头怼进移载单元，那就不再是「整机 3D」。若以后几何把 45# 件露出来，把门槛与 `test/scripts/material-gate.test.mjs` 一起抬回 3000。
- **工位身份与几何平移持久化**：设计向导在 `MachineDesign.stationIdentities` 中按 `config.stations` 同序保存每站不可变 ID；`stationGeometryLayout` v2 以 `{ stationIdentity, stationName, xMm, yMm }` 存偏移，`stationName` 仅用于追溯，不参与匹配。手动排序只改变当前几何的 `stN`，偏移仍跟随同一 ID；改名会更新追溯名称；删站只清掉该 ID 的偏移，新站零偏移。候选切换/需求重算产生新身份，不跨方案猜测迁移。
- **旧数据兼容**：没有偏移的旧 `MachineDesign` 仍可读，并为当前快照建立身份；旧 `stationGeometryLayout` v1 只存 `stationId/index/name`，无法证明实体连续性，因此不导入这些偏移、按零偏移读取并附 `stationGeometryWarning`。草稿重开若身份映射无法与工位列表一一对应，也保留工位编辑、清掉不可信偏移并在向导中告警；不会用名称或序号猜配。v2 中已删除/失效 ID 只丢弃对应孤儿偏移，其余仍有效的身份偏移保留。
- **校核联动**：稳定身份映射和偏移都纳入 review source signature；几何或身份映射改变后旧校核不再有效。生成器几何、运动轴、工位原点/工作点、bounds/envelope、Three.js 与保存工程/逐件 STL 使用同一套偏移；尺寸、形状与运动行程不被偏移修改。
- 概念运动提醒基于偏移后的几何：linear/gripper 用单位轴向量及全/半行程；rotary 仅有效枢轴/范围且严格世界 Z 才覆盖。图层绘 XY AABB，候选告警再核对 Z；错误映射/不支持变换标未覆盖。只供人工复核，不改 review pass/errors，也不代表无干涉或校核通过；线缆、夹具与真实机构未建模。

## 7. 验证

- 几何（迭代 34 + 形态扩展）：`test/machine/geometry.test.mjs`（10）、`geometry-export.test.mjs`（6）、`geometry-three.test.mjs`（3）、`test/agent/apply-machine-geometry.test.mjs`（5）、`forms-expansion.test.mjs`（27），覆盖尺寸、id 唯一、1–12 工位 × 6 工艺占地不重叠、运动轴、BOM 对账、STL/glTF/sidecar、动画、落盘/撤销/回退，以及 gantry 多头排布、hybrid 转盘+直线拼接、cell 矩阵、转盘直径随工位数增长。当前冒烟 `SMOKE_MACHINE_GEOMETRY_OK layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56`。
- 产能引擎：`test/machine/flow.test.mjs` 覆盖五种布局公式、默认值、可选工序、目标反解与非法输入；`test/machine/flow-archetypes.test.mjs` 覆盖六工位同工序并行、转盘点胶 dial、五工位直线 linear、单工位检测 single、2×2 单元 cell、2 副本并行点胶；`test/machine/cycle-mode.test.mjs` 与 `flow-synth.test.mjs` 覆盖布局推断、auto 推断与 synth 对接。六工位案例为 `form=dual-lane`、`mode=cell`、`stationSeconds=3.18`、`lanes=2`、`throughputPerMin=31.75`、`meetsTarget=true`（20 件/分钟目标下余量 1.59 倍）。
- 单元测试：`desktop/test/machine/spec.test.mjs`、`synth.test.mjs`、`cycle-mode.test.mjs`、`templates.test.mjs`、`clarify.test.mjs`、`desktop/test/agent/design-machine.test.mjs`、`apply-machine-design.test.mjs`，覆盖模板数量/字段/回填、追问上限与默认值、brief/design 二选一、校验失败、id 重复、点位缺失、overwrite、active 指针、3D/BOM/PLC 联动、路径净化、确认拒绝、撤销恢复。
- 功率与成本：`test/machine/power-cost.test.mjs`（29 条）覆盖单相/三相电流、同时系数、负载率、效率、`cosφ`、断路器取档、24 V 余量、缺额定功率、机械/电气/人工分项、缺价计数、伺服成对计价、工时随工位数变化、参数文件缺失/非法回落、方案卡字段完整与两类断路器交叉校验。
- 全量测试：`TZ=Asia/Shanghai npm test` **2088/2088**；另通过 `tsc`、`build:ext`、标准 smoke 与设计向导 WebGL smoke。
- 冒烟：`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=7 undo=1`、`SMOKE_MACHINE_GEOMETRY_OK`、`SMOKE_DESIGN_SAVE_OK`、`SMOKE_DESIGN_WEBGL_OK`，最终 `SMOKE_OK`。
- 离线评测：`npm run eval:agent` 102/102，意图 / 工具 / 参数 / 拒绝均为 1.00。

真实模型评测（2026-10-24）36/36；分组、断言、延迟与复跑细节已归档于 `BACKLOG-HISTORY.md`，该结果不代表其他模型或措辞。

## 8. 后续

- 几何：sidecar 加水平圆柱/通用旋转算子后可去掉方棒近似；转盘分度与输送线驱动接入点位后可进联调动画；上下料机构、气路/线缆、电柜与紧固件尚未建模；xvfb 下 WebGL 被 blocklist，冒烟只验证场景构建与零件数，真实 GPU 渲染需在 Windows 实机目测。
- 模板目前是代码内常量，后续可抽成用户可编辑的模板库；新增模板必须同步 `TEMPLATES`、默认参数、假设文案与测试。
- 追问目前由工具返回 `needs/question`、会话层按提示最多追问一次；若要跨轮 durable 状态，可把未答项的默认值写入 thread 指纹。
- 真实评测仍是单模型、单轮为主（机型含 2 个多轮前置场景）；换模型或换措辞应重跑 `npm run agent:live`，不要把 36/36 当通用结论。
