# 智能体能力加强 · 实施计划

> **执行方式**：按任务顺序 TDD 逐条落地；每个任务单独提交，全部完成后跑「能力基线」对比。

**目标**：让软件内置智能体从「会调工具」变成「能自己把一台设备从需求做到可交付」——能查机型库、能自校验、能自修复、能自证结果，并且失败时给得出下一步。

**架构原则**：能力都长在同一份注册表上（`src/agent/tools.ts` 25 个工具 → 单一 `CommandBus`）；新增能力只加工具 + 命令 + 测试，不另起一套调用链。校验规则**收敛成单一源**，避免「同一个方案三处判不同结果」。

**技术栈**：TypeScript（ESM，`--experimental-strip-types`）、Node test runner、Qt/OCCT 侧不动。

---

## 一、当前状态（有证据）

| 事实 | 证据 |
|---|---|
| 已有 25 个工具（只读 12 / 写 13） | `desktop/src/agent/tools.ts:626-1290`；`test/agent/tool-count-doc.test.mjs:30` |
| 工具总数被哨兵测试**硬编码锁死** | 同文件 `assert.equal(tools.length, 25)`，另需同步 8 个测试文件 + 4 处文档 |
| 机型库只有纯函数，**没接智能体** | `src/machine/library.ts` 已交付（`063d0ea`），`tools.ts` 无对应工具 |
| PLC 预检失败**没有修复入口** | `repairPlcConfig` 仅被 `scripts/machine-design-cli.mjs:18` 引用，`tools.ts` 未暴露 |
| 智能体**看不到自己的产出** | `src/agent/` 内无任何截图/视觉通道（仅 kb 文档提到截图） |
| 方案合法性与 PLC 预检**两套判断** | `src/machine/store.ts:245`、`src/commission/machine-config.ts:213`、`src/plcgen/precheck.ts:185-215` |
| 工具调用上限 6 轮 | `src/agent/session.ts:317` |
| 列表/文本裁剪契约不统一 | `src/agent/trim.ts:5-14`（>20 条裁成 `{items,total}`，消费方仍按数组读） |

**由此确定的四个能力缺口**：

1. **库能力**：不能存、不能列、不能加载机型 → 每台设备都是一次性产物。
2. **闭环能力**：设计错了只能靠人看日志改；预检拒绝后没有修复动作。
3. **自证能力**：智能体无法确认「我做出来的东西长什么样、有没有干涉」。
4. **可度量性**：没有任何「智能体好不好」的基线，改动只能靠感觉。

---

## 二、任务分解

### 阶段 A：解除工具数哨兵（先做，否则后面每个工具都要改 8 个文件）

#### Task A1：哨兵改成「结构断言 + 文档数字自动核对」

**Objective**：新增工具时只需改注册表与文档，不再手改 8 处硬编码。

**Files**
- Modify: `desktop/test/agent/tool-count-doc.test.mjs:25-45`
- Verify against: `desktop/src/agent/tools.ts`、`router.ts`、`README.md`、`docs/desktop/NL-AGENT.md`、`desktop/src/agent/MODULE.md`

**Step 1：先写失败断言**

```js
test('工具数量不再硬编码：文档里的数字必须等于注册表真实数量', () => {
  const real = tools.length;
  const readOnly = READ_ONLY_TOOLS.length;
  const writeOnly = WRITE_TOOLS.length;
  assert.equal(readOnly + writeOnly, real);
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, new RegExp(`\\b${real}\\b\\s*(个)?\\s*(工具|tools)`), `${name} 里的工具总数应等于 ${real}`);
    assert.match(text, new RegExp(`只读\\s*${readOnly}`), `${name} 里的只读数应等于 ${readOnly}`);
    assert.match(text, new RegExp(`写\\s*${writeOnly}`), `${name} 里的写数应等于 ${writeOnly}`);
  }
});
```

**Step 2：跑测试，确认现在是「绿但靠硬编码」**（把 25/12/13 换成变量后仍绿，说明改造成功；若文档某处数字没同步会红）

```bash
cd desktop && node --test test/agent/tool-count-doc.test.mjs
```

**Step 3：改哨兵**，删除 `assert.equal(tools.length, 25)` 等三条硬编码，改为上面这种「注册表 ↔ 文档」互校。

**Step 4：验证**

```bash
cd desktop && npm test -- --test-name-pattern="工具数量"
```

**Step 5：提交**

```bash
git commit -m "test(agent): 工具数哨兵改为注册表自校，去掉 25/12/13 硬编码"
```

---

### 阶段 B：机型库进入智能体（让「用户选择加载」在对话里成立）

#### Task B1：`list_machine_library`（只读）

**Files**
- Modify: `desktop/src/agent/tools.ts`（新增 schema + handler，走 `this.execute('list_machine_library', args)`）
- Modify: `desktop/src/agent/commands.ts`（`registerMachineLibraryCommands`）
- Modify: `desktop/src/agent/router.ts`（加入 `READ_ONLY_TOOLS`）
- Test: `desktop/test/agent/machine-library-tools.test.mjs`（新建）

**Step 1：失败测试**

```js
test('list_machine_library 返回库里机型（空库返回空数组而不是报错）', async () => {
  const { tools } = createAgentTools({ userDataRoot: tmp });
  const out = await tools.list_machine_library.handler({});
  assert.ok(Array.isArray(out.data.items));
  assert.equal(out.data.items.length, 0);
});
```

**Step 2：跑失败**

```bash
cd desktop && node --test test/agent/machine-library-tools.test.mjs
```

**Step 3：实现**——`commands.ts` 内 `listLibrary(ctx.userDataRoot)`，输出裁剪到 `{items:[{id,name,version,sizeBytes,source,updatedAt}], total}`。

**Step 4：跑绿 + 全量回归**

```bash
cd desktop && node --test test/agent/machine-library-tools.test.mjs && npm test
```

**Step 5：提交** `feat(agent): 新增 list_machine_library（只读）`

#### Task B2：`save_machine_to_library`（写，需确认）

- 入参：`{ id?: string, name?: string, version?: string, overwrite?: boolean }`；缺省取当前 active 机型。
- 行为：`readActiveMachineDesign` → `saveToLibrary` → 返回 `{id, version, sizeBytes}`。
- 错误码直通：`LIBRARY_EXISTS` 时要提示「同名机型已存在，确认覆盖请显式传 overwrite: true」，**不自动覆盖**。

#### Task B3：`load_machine_from_library`（写，需确认）

- 行为：`loadFromLibrary` → `ctx.bridge.call('applyMachineConfig', machineScenePayload(...))` 刷 3D。
- 必须验证：加载后 `active.json` 指向新机型、3D 场景部件数与 config 一致。
- 已知缺口（本轮一并补）：`loadFromLibrary` 不重建 `bomDraft.items`；Task B4 修。

#### Task B4：加载时回填 BOM 草稿

**Files**：`desktop/src/machine/library.ts:1037`（`loadFromLibrary`）
- 从 `bom.csv` 解析回 `bomDraft.items`（列：序号/名称/规格/数量/单位/备注）。
- 测试：保存带 BOM 的机型 → 删除 → 导入 → 加载 → `readStoredMachineDesign(...).bomDraft.items.length === 原数量`。

#### Task B5：`export_machine_package`（只读产物，写文件需确认）

- 入参：`{ id, targetPath? }`；默认导出到 `userData/exports/machines/<id>.machine.zip`。
- 断言：导出后 `sha256` 与二次导出相同（复用 `shared/zip.ts` 的固定时间戳）。

**阶段 B 验收**：对话里能完成「列机型 → 加载 → 出 3D → 存为新机型 → 导出包」闭环，全程有确认；`npm run machine:e2e` 追加两步（library_save / library_load）也必须绿。

---

### 阶段 C：设计与校验闭环（把「人看日志改」变成「智能体自己改」）

#### Task C1：单一校验源 `src/machine/validate.ts`

**Objective**：`store.ts` / `machine-config.ts` / `plcgen/precheck.ts` 共用一套规则，返回结构化结果。

```ts
export interface DesignIssue { code: string; path: string; message: string; hint?: string }
export function validateDesign(config: unknown): { ok: boolean; issues: DesignIssue[]; config?: MachineConfig };
```

**Step 1：失败测试**（三条现有规则逐条覆盖）

```js
test('安全传感器不绑工位也合法', () => {
  const r = validateDesign(withSafetySensor(design).config);
  assert.equal(r.ok, true);
});
test('传感器绑不存在的执行机构 → SENSOR_UNBOUND', () => {
  const r = validateDesign(brokenSensor(design).config);
  assert.equal(r.issues[0].code, 'SENSOR_UNBOUND');
  assert.ok(r.issues[0].hint.includes('绑定'));
});
```

**Step 2-4**：先让测试红 → 实现 facade（把现有三处逻辑搬进来，抛出改为收集 issue）→ 三处调用点改为包装 `validateDesign` 后 `throw new Error(issues[0].message)`，**保持外部行为不变**。

**Step 5**：`npm test` 必须 2879+ 全绿（现有 3 条规则的行为一个都不能变）。

#### Task C2：`validate_machine_design` 工具（只读）

- 入参：`{ config?: object }`（缺省取当前 active）；输出 `{ok, issues:[{code,path,message,hint}]}`。
- 价值：智能体在「应用到工程」之前就能自查，不用等报错。

#### Task C3：`repair_plc_config` 工具（写，需确认）

- 复用 `src/plcgen/machine-gaps.ts:111 repairPlcConfig`。
- 入参：`{ dryRun?: boolean }`；`dryRun` 返回将要补的点位（急停/安全门/到位信号），**默认 dryRun**，确认后才写。
- 测试：缺急停/安全门的 config → `planPlcGaps` 两条 → `repairPlcConfig` 补齐 → 预检 0 错。

#### Task C4：错误码 → 下一步（统一 hint）

- `tools.ts` 每个写工具的错误返回补 `hint`（一句话可执行动作）。
- 现有 `suggest.ts` 六类错误码扩展为映射表，新增 `LIBRARY_*`、`PLC_*`。

**阶段 C 验收**：给智能体一个「故意缺安全回路」的方案，它能自己 `validate → repair → 重新生成 PLC` 跑通，全程 ≤6 轮；`MACHINE_E2E blocked=0`。

---

### 阶段 D：自证能力（让智能体看得到结果）

#### Task D1：`capture_view` 工具（只读，返回文件路径）

- 入参：`{ view?: '3d'|'linkage'|'exports', width?, height? }`。
- 行为：复用现有 `machine-screenshots.ts` 通道，落到 `userData/agent-shots/<ts>.png`，返回 `{path, bytes, sha256, size:{w,h}}`。
- 不做视觉理解（应用内模型不一定多模态），先让「产出可追溯」成立；UI 在对话里内联显示该图。

#### Task D2：双态干涉自查（工具级）

- `run_interference_check` 增参 `{ states?: ('rest'|'lift'|'sweep')[] }`，默认全查。
- 断言：本项目的顶升单元在三种状态下都必须 `hits=0`（回归用 `docs/desktop/eval/` 里的基线数字）。

**阶段 D 验收**：对话里说「看看顶升的时候会不会撞」，智能体自己截图 + 跑三态干涉 + 给结论（附证据数字），不需要人点面板。

---

### 阶段 E：能力基线（可度量，才有「加强」）

#### Task E1：`desktop/test/agent/eval/` 评测集

- 12 条真实指令（含本次会话里出现过的：转向输送机、补安全回路、存机型、加载机型、改带速、查 BOM、导出 PLC…）。
- 每条定义：`brief`、`expect`（末态断言：config 字段 / 文件存在 / 工具序列包含）、`maxTurns`。
- 用 `llm.ts` 的 stub 模式跑（离线路由 + 固定模型输出），保证 CI 稳定可重复。

#### Task E2：`npm run agent:eval`

- 输出：`AGENT_EVAL pass=11/12 turns_avg=3.4 p95=5 max_steps=6`，失败项列出 `brief` 与末态差异。
- CI 门槛：`pass >= 10/12` 且无 `maxTurns` 超限；数字下降即红。

**阶段 E 验收**：改动前后各跑一次，给出「改前 X/12、改后 Y/12」的真实对比，而不是主观评价。

---

### 阶段 F：机型库面板（上一轮遗留，用户「选择加载」的界面入口）

#### Task F1：主进程 IPC 白名单

**Files**：`desktop/electron/main.ts`（新增 4 个 IPC：`library:list` / `library:import` / `library:remove` / `library:apply`）、`desktop/electron/preload.ts`、`desktop/src/agent/rpc.ts` 不动（面板走 IPC 不走 RPC）
- 硬要求：**渲染进程不能直接读文件**；导入只收 `{bytes}` 或文件路径字符串由主进程读；路径必须 `path.resolve` 后校验落在允许目录内。
- 测试：`test/electron/library-ipc.test.mjs`（新建）——非法 id（含 `..`、绝对路径）必须被拒。

#### Task F2：面板 UI

**Files**：`desktop/src/commission/ui.ts`（新增「机型库」抽屉，风格对齐现有联动抽屉）、`desktop/src/commission/style.css`（若存在）
- 交互：列表（名称/版本/大小/来源）→ 双击或「加载」→ 确认 → 刷 3D；「导入」选 `.machine.zip`；「导出」保存到 `userData/exports/machines/`；「删除」二次确认。
- 空库态：显示「还没有机型；可以用智能体生成后点『存为机型』」。
- 真实错误码 → 中文文案（`LIBRARY_EXISTS` 要提示是否覆盖，而不是静默失败）。

#### Task F3：截图为证

- 用现有 `npm run screenshots` 通道，新增一张 `24-machine-library.png`（真实打开面板、有 ≥1 个机型条目）。
- 断言：文件 > 200 KB、与既有图 sha256 互异。

**阶段 F 验收**：不碰命令行，鼠标点 4 下能完成「导入包 → 加载 → 3D 变化」；截图落盘。

---

### 阶段 G：上一轮 P0 契约缺陷（不修就会在机型库导入后爆）

#### Task G1：`assumptions > 20` 不再让写盘失败

**Files**：`desktop/src/agent/trim.ts:5-14`、`desktop/src/machine/store.ts`（写盘校验）
- 现状：`trim.ts` 把长度 > 20 的数组裁成 `{items,total}`，而 store 写盘要求 `string[]` → 「应用到工程」报错（本次实现被迫把 4 条合并成 1 条）。
- 目标：裁剪只发生在**给模型的返回**里；**落盘数据永不裁剪**。写盘侧接受 `{items:[...]}` 与 `string[]` 两种形状。
- 测试：构造 25 条 assumptions 的方案 → `apply_machine_design` 必须成功，且 `readStoredMachineDesign().config.assumptions.length === 25`。

#### Task G2：BOM 结果形状统一

- 现状：BOM 25 行被裁成 `{items,total}`，消费方 `Array.isArray` 拿到空数组（E2E 里真实踩到）。
- 目标：定义 `ListResult<T> = { items: T[]; total: number; truncated?: boolean }`，`get_bom` / `list_components` / `search_components` / `list_machine_library` 全部返回该形状；消费方统一按 `items` 读。
- 兼容：保留旧字段一个版本（`rows` 镜像 `items`），并在 `docs/desktop/NL-AGENT.md` 标注弃用。

#### Task G3：机型包导入即校验（防「过一处挂另一处」）

- 现状：`store.ts` / `machine-config.ts` / `plcgen/precheck.ts` 三套规则。
- 目标：C1 的 `validateDesign` 作为唯一入口；机型包导入（`library.ts:readMachinePackage`）额外跑一次 `validateDesign`，把 issues 写进 `LIBRARY_INVALID_CONFIG` 的 details。
- 测试：构造一个「传感器绑不存在执行机构」的包 → 导入必须被拒，且错误信息带 `path` 与 `hint`（不是一句「非法」）。

## 三、优先级与工作量

| 阶段 | 内容 | 预估 | 价值 |
|---|---|---|---|
| A | 解除哨兵 | 0.5 天 | 后面每个工具省 8 个文件改动 |
| B | 机型库工具 4 个 + BOM 回填 | 1.5 天 | 「用户选择加载」真正可用 |
| C | 单源校验 + 2 工具 + hint | 2 天 | 智能体能自修复，不再靠人 |
| D | 截图 + 双态干涉 | 1 天 | 产出可追溯、可自证 |
| E | 评测集 + CI 门槛 | 1.5 天 | 能力可度量 |
| F | 机型库面板（IPC + UI + 截图） | 1 天 | 不用命令行也能选机型 |
| G | P0 契约缺陷（裁剪/形状/导入校验） | 1 天 | 导入外部包后不炸 |

**夜间队列（含智能体加强全部任务 + 上一轮遗留；状态随时更新）**

- [~] A1 哨兵去硬编码（运行中）
- [~] C1 单一校验源 `validate.ts`（运行中，与 A 并行）
- [ ] B1 `list_machine_library`　B2 `save_machine_to_library`　B3 `load_machine_from_library`　B4 BOM 回填　B5 `export_machine_package`
- [ ] C2 `validate_machine_design`　C3 `repair_plc_config`（默认 dryRun）　C4 错误码→hint
- [ ] G1 assumptions 落盘不裁剪　G2 `ListResult` 统一　G3 导入即校验
- [ ] F1 IPC 白名单　F2 机型库面板　F3 截图取证
- [ ] D1 `capture_view`　D2 三态干涉自查
- [ ] E1 12 条评测集　E2 `npm run agent:eval` + CI 门槛

**夜间执行顺序**（总管派工，每阶段独立验收后再进下一阶段）：
`A`（阻塞项，必须先） → `B ∥ C1`（文件基本不重叠） → `G`（依赖 C1） → `F`（UI，独立） → `D` → `E`
每阶段完成即：`tsc` + 全量 `npm test` + 相关 E2E 真跑 → 通过才提交；**不通过不提交**，把失败原文留给下一轮。

---

## 四、风险与取舍

- **哨兵改造可能放宽保护**：改成「注册表自校」后，仍要保留「只读/写分类齐全、无幽灵工具」两条断言，只去掉硬编码数字。
- **单一校验源是行为迁移**：三处现有错误文案会被统一，`store.ts` 的既有测试若断言具体文案会红——**只允许改文案断言，不允许放宽校验条件**（本次已因安全传感器踩过一次）。
- **工具数增加会影响提示词长度**：加 6 个工具后 system prompt 变长，弱模型可能选错。评测集（E）必须先于「继续加工具」。
- **截图工具不解决理解**：应用内若用非多模态模型，`capture_view` 只能证明「有产物」，不能证明「产物对」。真要闭环得接视觉模型，属另一条线。
- **机型库加载不重建电气联动**：`machineElecDesign(null)` 目前是占位，B4 只补 BOM，电气联动留待机型包带 `elec.json`（下一阶段）。

## 五、开放问题（需拍板）

1. 机型库「下载」走哪个源？（HTTP 目录 / Git LFS / 内部对象存储）——目前只支持本地 + 手工导入 zip。
2. 机型包是否要带**截图**作为展示图？（现在 `shots/**` 可选，UI 卡片需要它）
3. 评测集用「固定模型输出」还是「真模型跑 N 次取通过率」？前者稳、后者真，建议 CI 用前者、发版前用后者。

---

**Plan saved**: `.hermes/plans/2026-11-03_2220-agent-capability-upgrade.md`
