# FeatureTree 读写契约（草案 v0.1）

- 状态：草案，待 Sean 确认后才算定稿；本文只定契约，不写代码、不改仓库。
- 日期：2026-10-28；依据：仓库现有 `desktop/src/parametric/features.ts`（FeatureDoc / AssemblyDoc 与校验）、`desktop/src/canvas/feature-tree*.ts`（特征树绑定、面板编辑校验、文档级操作）、`desktop/src/agent/tools.ts`（现有 MCP 工具清单）。
- 适用范围：机械侧 only；电气（IO、柜体、电气标签页）不在本契约内，不碰电气字段。
- 一句话：GUI 手动操作和 Agent MCP 调用，读写同一份 FeatureTree，走同一条写路径；谁都不许绕过校验和重建直接改文件或改内存副本。

## 0. 硬原则（违反即视为违约，不是“优化空间”）

1. **唯一数据源**：一份文档只有一个权威版本，由后端持有；Qt 客户端和 MCP 都是消费者，不持有可独立写回的副本。
2. **同一写路径**：所有写操作（手动、Agent、导入、脚本）都走第 3 节的操作 → 第 4 节校验 → 第 8 节重建 → 第 7 节通知。没有任何“快捷通道”。
3. **字段名不动**：现有类型名和字段名一个都不改（`box / holes / counterbore / slot / fillet / cylinder`、`length / width / height / diameter / cbDiameter / cbDepth / radius / positions` 等）。SolidWorks 术语只改界面叫法：拉伸（凸台）、孔、沉孔、槽、圆角/倒角。
4. **不可变写回**：每次写操作返回新文档，原文档不动；撤销 / 重做靠改前改后快照，不靠原地修改（现有 `feature-tree-doc.ts` 已是这个做法，契约把它固定下来）。
5. **原子性**：一次操作（含批量事务）要么整单生效并生成一个新版本，要么整单失败、文档停在原版本；不允许半棵树落地。
6. **单位**：长度、直径、深度、半径一律 mm；质量 kg；角度度；时间戳必须带时区（现有校验已要求，如 `2026-10-23T12:00:00+08:00`）。

## 1. 文档模型（复用现有模型，不另起一套）

### 1.1 零件文档 FeatureDoc（已存在，schemaVersion = 1）

```json
{
  "schemaVersion": 1,
  "sourceFile": "可选，来源文件路径",
  "features": [
    { "id": "f-body", "type": "box", "name": "90×90×12 板体",
      "params": { "length": 90, "width": 90, "height": 12, "centered": true } },
    { "id": "f-cb-in", "type": "counterbore", "name": "母件侧沉头孔",
      "params": { "diameter": 5.5, "cbDiameter": 8.5, "cbDepth": 5,
                  "depth": "through", "positions": [[-30, -30], [30, -30], [-30, 30], [30, 30]] } },
    { "id": "f-fillet", "type": "fillet", "name": "四角 R3",
      "params": { "radius": 3, "edges": "|Z" } }
  ],
  "updatedAt": "2026-10-28T00:00:00+08:00"
}
```

- `features` 数组顺序即建模顺序；拖拽排序 = 改数组顺序（现有 `reorderFeature`）。
- `suppressed: true` = 压缩：编译时跳过该特征，树上灰显；压缩不是删除，参数全部保留，解除压缩即恢复。
- `id` 一旦创建永不改变、永不复用；改名只改 `name`，不改 `id`。

### 1.2 装配文档 AssemblyDoc（已存在，schemaVersion = 2）

```json
{
  "schemaVersion": 2,
  "instances": [
    { "id": "p1", "name": "零件 1", "partId": "BASE-01",
      "transform": { "x": 0, "y": 0, "z": 0, "rz": 0 },
      "features": [ /* 同 1.1 的 FeatureNode 数组 */ ] }
  ],
  "updatedAt": "2026-10-28T00:00:00+08:00"
}
```

- 实体上限 50 个（现有 `MAX_ASSEMBLY_INSTANCES`）；`transform.rz` 可省略，省略按 0。
- 旧单件 FeatureDoc 可自动包成单实体 AssemblyDoc（现有 `toAssembly`），反向不自动拆包。

### 1.3 工程包络（新增的只是“壳”，不改特征字段）

每个工程文档在上述两种文档之外，再带一个包络，Qt 客户端和 MCP 都以包络里的版本为准：

```json
{
  "documentId": "工程唯一 id",
  "kind": "part | assembly",
  "revision": 42,
  "origin": "manual | agent",
  "doc": { /* 1.1 或 1.2 的文档本体 */ },
  "history": [ /* 第 6 节的版本记录，至少保留最近 N 条，N 待定 */ ]
}
```

- `revision` 是整型单调递增版本号，每次成功写操作 +1；它是并发控制的唯一依据（第 5 节）。
- 包络不进特征字段，不影响现有校验和编译。

## 2. 特征类型与参数（以现有校验为准，新增类型必须先补校验才能进契约）

| 类型 | 界面叫法 | 必填参数 | 补充规则 |
|---|---|---|---|
| `box` | 拉伸（凸台） | `length, width, height`（> 0） | `centered` 布尔，可省略 |
| `cylinder` | 拉伸（圆柱） | `diameter, height`（> 0） | `at` 若填必须是 3 个数字 |
| `holes` | 孔 | `diameter`（> 0），`positions`（非空 `[x, y]` 数组） | `depth` 为 `through` 或 > 0 的数；`thread` 若填须合规（M6、M8x1 形），底孔径须 < 公称直径，`threadDepth` 不得 > 孔深；`count` 是孔位派生值，**不可直接改** |
| `counterbore` | 沉孔 | `diameter, cbDiameter, cbDepth`（均 > 0），`positions` | 必须 `cbDiameter > diameter`；`cbDepth` 不得 ≥ 板厚；沉窝不得出板界、沉窝间距不得 < `cbDiameter` |
| `slot` | 槽 | `length, width`（> 0） | — |
| `fillet` | 圆角/倒角 | `radius`（> 0） | `edges` 只能是 `\|Z` 或 `all`；`radius` 不得 > 最小板厚的一半 |

- 未知类型、未知字段一律拒绝，不猜、不静默丢弃（现有面板编辑校验已是这个做法）。
- 孔位与板界、孔间距的整树校验（孔在板外、孔间距 < 孔径等）属于第 4 节整树校验，单字段校验通过不代表整树通过。

## 3. 写操作（全部操作，GUI 和 MCP 共用同一张表）

每个操作输入都带 `documentId` 和 `expectedRevision`（第 5 节）；输出都是新包络或错误（第 13 节），没有“部分成功”。

| 操作 | 输入（除 documentId / expectedRevision 外） | 语义 |
|---|---|---|
| `getTree`（读） | — | 返回当前包络全文 |
| `createFeature` | `instanceId?`（装配时必填）、`feature`（完整 FeatureNode，`id` 由调用方给、须全局唯一） | 追加到 `features` 末尾；位置由后续 `reorderFeature` 调整，不在创建时插队 |
| `updateFeatureParams` | `featureId`、`patch`（键值对，只含第 2 节允许的字段） | 按现有面板校验逐字段校验后写回；`count` 不可直接改 |
| `renameFeature` | `featureId`、`name`（非空字符串） | 只改名，不改 `id`、不改参数 |
| `reorderFeature` | `featureId`、`targetIndex` | 越界下标夹到合法范围；原文档不动 |
| `setSuppressed` | `featureId`、`suppressed`（布尔） | 压缩 / 解除压缩；不是删除 |
| `deleteFeature` | `featureId` | 真删除；被其他特征引用的 `featureId`（第 11 节）存在时拒绝，并返回引用方 |
| `updateInstanceTransform` | `instanceId`、`transform`（x / y / z 数字，rz 可省略） | 只用于装配实体位姿 |
| `applyTransaction` | `operations[]`（上表任意操作的数组） | 整单原子执行：任一子操作失败则整单回滚；成功只产生 **一个** 新 `revision` |
| `undo` | `steps`（默认 1） | 按历史逆向恢复到指定版本；历史本身不删除，undo 也产生新 `revision` |

- 删除、改名、排序、压缩都不改变其他特征的 `id`。
- 批量导入、脚本生成一律拆成 `applyTransaction`，不许直接写文件。

## 4. 校验（两层，缺一层都不算通过）

- **字段层**（写回前拦住，失败不改原对象）：长度类、孔径、沉窝直径/深度、圆角半径、板厚 > 0；孔距 ≥ 0；端口孔数 ≥ 1 的整数；定位销孔直径 ≥ 0（0 = 不设）；材料非空字符串；沉头布尔值；沉窝直径 > 孔径；未知字段拒绝。
- **整树层**（现有 `validateFeatures` 的全部规则，写操作提交时整树重跑）：`features` 非空数组；`id` 不重复、不为空；类型在白名单内；孔位非空且在板界内、孔间距 ≥ 孔径；沉窝规则（第 2 节）；圆角半径规则；螺纹规则；装配实体数、实体 `id` / `name` / `transform` 规则；`updatedAt` 带时区且可解析。
- 校验失败返回全部错误信息（不是只报第一条），调用方按原样展示，不许把校验错误改写成“已保存”。

## 5. 版本与并发（乐观锁，禁止“后写覆盖”）

- 每次写操作必须带 `expectedRevision`（调用方上次读到的版本）。
- `expectedRevision == 当前 revision` 才能写；写成功后 `revision + 1`，`updatedAt` 更新。
- 不相等时返回 `CONFLICT_STALE_REVISION`，并附带当前包络全文；调用方必须重新读、重新确认后再提交，**不许自动重试覆盖**。
- 同一文档的并发写由后端串行化；Qt 客户端本地不做“先改本地树、后台再同步”的乐观 UI，UI 只在收到新版本后刷新。

## 6. 历史与留痕（AI 修改和手动修改没有区别对待）

- 每次成功写操作产生一条历史记录：`revision`、`timestamp`（带时区）、`actor`（`manual` 或 `agent:<工具/模型标识>`）、`operation`、`featureIds`（受影响特征）、`beforeRevision`。
- 历史记录不可编辑、不可删除；`undo` 是新增一条逆向版本，不是抹掉历史。
- AI 生成的特征在树里和手动特征完全一样：可看、可编辑、可压缩、可删除；界面上可用来源标记区分，但来源标记不影响任何操作权限。
- 审计日志与历史记录是同一事实的两种呈现，不许出现“日志有、历史无”或反过来。

## 7. 通知与刷新（双向同步的落地点）

- 每次版本变更，后端必须发出一次变更事件：`{ documentId, revision, changedFeatureIds, actor }`，并附带可拉取的新包络。
- Qt 客户端和 MCP 订阅方收到事件后，**以新包络全文刷新本地树**，不许在旧树上打补丁式合并；刷新失败时显示“版本已过期，请重新读取”，不许继续在旧版本上编辑。
- 本契约不规定传输细节以外的 UI 行为，但规定：没有收到新版本确认前，界面不得把“已保存”展示给用户。

## 8. 重建与几何（校验通过 ≠ 几何成功）

> v0.1 实现：`featuretree-service/rebuild-sidecar.py`（build123d/OCCT）负责真建实体，
> 服务通过 `FT_BUILD_URL` 接上它，把算子的 `{volumeMm3, bboxMm, massKg, densityGPerCm3, kernel}`
> 写进包络与每条历史（可追溯）。密度是**输入**（默认钢 7.85 g/cm³，`FT_DENSITY` 可改），不是猜出来的。
> 没接 sidecar 时服务只做「编译 + 指纹」并返回 `geometry:null`；接了但连不上时 `REBUILD_FAILED`（fail-closed）。
> 客户端渲染用 `GET /v1/geometry.stl`（sidecar 导出的二进制 STL 透传，`model/stl`）；没接 sidecar 时明确 404，
> 不返回空文件让客户端画出空白。几何只有一个来源：服务端 sidecar，客户端不重算。

- 写操作流程固定为：校验（第 4 节）→ 编译算子（`suppressed` 跳过，现有 `compileOps` / `compileAssembly` 的白名单算子）→ build123d / OCP 重建 BRep → 缓存 BRep 并生成 STEP（如需）→ 发布新版本并通知（第 7 节）。
- 重建失败时整单回滚：文档停在原 `revision`，错误按 `REBUILD_FAILED` 返回并附带重建方原始错误信息；**不许出现“树已更新、模型还是旧的”这种中间态**。
- 几何缓存以 `revision` 为键；`revision` 不变则缓存不变，不重复重建。

## 9. 撤销、重做与 MCP/Qt 映射（现有工具不直写，全部收敛到第 3 节）

> v0.1 实现：`POST /v1/undo` 与 `POST /v1/redo` 都走乐观锁（`expectedRevision`）→ 校验 → 重建 → 版本 +1，
> 历史只追加不删除（`operation: undo | redo`）。撤销前的那一版压进 redo 栈（上限 50），
> 一旦发生新的写操作 redo 栈清空（分支历史不合并，避免重做出一棵不相干的树）。
> redo 栈空时返回 `409 REDO_EMPTY`，不假装成功。包络里带 `undoDepth` / `redoDepth`，UI 据此启停按钮，
> 不用客户端自己猜。

> v0.1 实现：`featuretree-service/mcp.mjs`（stdio JSON-RPC）把契约服务暴露成六个 MCP 工具
> `ft_get_tree` / `ft_update_params` / `ft_set_suppressed` / `ft_delete_feature` / `ft_undo` / `ft_list_revisions`
> 与一个只读资源 `featuretree://current/tree`。MCP 这一层不复制校验与乐观锁，全部转发给契约服务；
> 写工具必须带 `expectedRevision`，冲突原样回 `CONFLICT_STALE_REVISION` 并提示先重读。
> 双向验收：`node featuretree-service/mcp-tests.mjs`（11 条断言）。

| 调用方 | 现有入口 / 界面动作 | 收敛到的契约操作 |
|---|---|---|
| MCP `update_component` | 改零部件参数 | `updateFeatureParams` / `updateInstanceTransform` |
| MCP `insert_component` / `place_component` | 插入零部件 | `createFeature`（零件）或装配实例创建（走同一事务） |
| MCP `remove_component` | 删除零部件 | `deleteFeature`（引用检查按第 3 节） |
| MCP `build_canvas_assembly` / `apply_machine_design` | 生成整机方案 | `applyTransaction`（整单原子） |
| MCP `save_scene_as_project` | 存为工程 | 持久化当前包络（含 `revision` 与历史），不是另存一份散文件 |
| MCP `undo_last` | 撤销 | `undo` |
| Qt 特征树拖拽 / 右键 / 压缩 / 删除 | 树操作 | `reorderFeature` / `setSuppressed` / `deleteFeature` / `renameFeature` |
| Qt 属性面板编辑 | 改参数 | `updateFeatureParams` |
| Qt 草图 / 装配（未来） | 草图、配合 | 走第 10、11 节预留字段，**不许自造旁路字段** |

- 现有 MCP 工具里凡是直接改画布图、改内存图的实现，在契约落地时必须改成调契约操作；契约不要求一次性改完所有工具，但要求：**新写路径上线后，旧直写路径下线，同一时间只存在一条写路径**。

## 10. 草图预留（字段先占位，求解器后到，不许提前宣称已实现）

- 预留特征类型 `sketch`（不在第 2 节白名单内，v1 契约下提交 `sketch` 特征应被校验拒绝，直到求解器落地并补齐校验后才放行）。
- 预留草图对象字段（v1 只定形状，不定求解语义）：
  `plane`（基准面引用）、`elements[]`（直线、矩形、圆、圆弧、样条、点）、`constraints[]`（重合、平行、垂直、相等、共线、同心、对称、固定）、`dimensions[]`（智能尺寸）、`status`（`under | fully | over`，对应欠定义蓝色、完全定义黑色、过定义红色）。
- 草图求解器（文档里拟用 SolveSpace）落地前，任何草图都不参与重建；界面不得把未求解草图渲染成“已定义”。

## 11. 拓扑引用预留（v1 只给格式，不承诺不断链）

- 未来圆角、倒角、配合引用的边 / 面，必须用引用对象表示，不许只存“第 N 条边”这种序号：
  `{ "featureId": "引用来源特征", "kind": "edge | face", "stableKey": "稳定键（命名层生成）", "geometrySignature": "几何指纹（兜底比对用）" }`。
- v1 现状：圆角 `edges` 仍只支持 `|Z` / `all`（现有校验），这不属于稳定命名；完整拓扑命名层是独立跟进项，契约只预留字段，**不承诺 v1 就不断链**。
- 引用目标被删除或重建后无法解析时，写操作按第 3 节 `deleteFeature` 的引用检查拒绝，或把受影响特征标记为“引用失效”并阻止重建发布，不许静默丢引用。

## 12. 传输（v0.1 已实现子集：`featuretree-service/`）

- 本地 HTTP 服务，默认只监听回环地址；远程访问、局域网访问不在 v1 范围内（后续如需开放，另行定鉴权）。
- 拟议端点：

| 方法与路径 | 用途 |
|---|---|
| `GET /v1/tree?documentId=…` | 读当前包络 |
| `POST /v1/operations` | 提交单个操作或 `applyTransaction`（请求体含 `expectedRevision`） |
| `GET /v1/revisions?documentId=…` | 读历史记录 |
| `POST /v1/undo` | 撤销指定步数 |
| `GET /v1/events?documentId=…` | 订阅变更事件（SSE 或长轮询，二选一，待定） |

- 传输选型（HTTP 还是 gRPC）如后续改动，必须保持第 3、5、7 节语义不变；换传输不等于换契约。
- **v0.1 实现现状（2026-10-28）**：`featuretree-service/` 已实现上表 5 个端点，`node featuretree-service/tests.mjs` 跑 18 条验收（自起服务、FT_PORT=0）。
  已知边界，调用方必须知道：
  - **单文档**：`documentId` 目前被忽略（硬编码 `demo-adapter`），传别的 id 不会 404，也不会读到别的文档；多文档留到文件布局定案后（§15.1）。
  - **内存态**：无持久化，进程重启回到种子树（revision 0），历史清空。
  - **无鉴权**：只监听 `127.0.0.1`；同机任意进程都能改树，开放局域网前必须补 token（§15.5）。
  - 错误码 → HTTP：`CONFLICT_STALE_REVISION` / `REFERENCE_IN_USE` → 409，`NOT_FOUND` → 404，超 1MB 请求体 → 413 `PAYLOAD_TOO_LARGE`，其余校验类 → 422。

## 13. 错误码（调用方按码处理，不按文案猜）

| 错误码 | 含义 | 调用方动作 |
|---|---|---|
| `VALIDATION_FAILED` | 字段层或整树层校验失败，附全部错误信息 | 展示错误，不保存 |
| `NOT_FOUND` | 文档 / 特征 / 实体不存在 | 重新读取树 |
| `DUPLICATE_ID` | `id` 重复 | 换 `id` 再提交 |
| `UNKNOWN_FIELD` | 未知字段或未知特征类型 | 拒绝提交，不静默丢弃 |
| `CONFLICT_STALE_REVISION` | `expectedRevision` 过期，附当前包络 | 重新读取并确认后再提交 |
| `REFERENCE_IN_USE` | 删除目标仍被引用 | 先处理引用方，或放弃删除 |
| `REBUILD_FAILED` | 校验通过但几何重建失败，附原始错误 | 文档停在原版本，展示重建错误 |

## 14. 验收标准（契约算落地，必须全部跑通，不是“文档写完”）

| # | 标准 | v0.1 状态（2026-10-28） |
|---|---|---|
| 1 | 转接板示例树（90×90×12、Ø5.5 通孔、Ø8.5×5 沉窝、R3 四角）能完整写入、读出、重建，且体积、质量与手算一致 | ✅ 已达成（2026-10-28）：`rebuild-sidecar.py`（build123d 0.13.0）真建实体，种子树体积 **94,166.8 mm³** 与手算一致（板 97,200 − 4 通孔 1,140.4 − 4 沉头 1,800.1 − 4 圆角 92.7），包围盒 90×90×12，质量按密度 7.85 g/cm³ = **0.7392 kg**；改板厚 13 后体积按手算变化（`build-tests.mjs` 8 条断言）。**未接 sidecar 时只做编译+指纹，`geometry:null`，不会假装算过**；sidecar 连不上时 fail-closed 返回 `REBUILD_FAILED` |
| 2 | 手动改 → 版本 +1 → MCP 读到；MCP 改 → 版本 +1 → Qt 树自动刷新，双向 | ✅ 双向已通（2026-10-28）：`featuretree-service/mcp.mjs` 暴露 `ft_get_tree/ft_update_params/ft_undo/ft_list_revisions`，`mcp-tests.mjs` 11 条断言验「MCP 写→HTTP 读得到」「HTTP 写→MCP 读得到」「旧 revision 经 MCP 也被 409」；Qt 侧 `--selftest` 读→写→回读（`FT_QT_SELFTEST_OK revision=1 height=13`）。Qt 侧自动刷新已接：`--watch-selftest` 用 1.5s 轮询 `/v1/tree`，外部改树后实测在轮询周期内刷到新 revision（`qt-client/tests/watch.mjs` 4 条断言）。SSE 端点可用但客户端未订阅 |
| 3 | 旧版本提交被 `CONFLICT_STALE_REVISION` 拒绝，文档不变 | ✅ `tests.mjs` 第 4/5 条 |
| 4 | 批量事务任一子操作失败整单回滚，版本不变 | ✅ `tests.mjs` 第 10/11 条 |
| 5 | 重建失败时版本不变，界面不显示“已保存” | ✅ 已实现：`rebuild()` 在算子为空（全部压缩/无实体特征）时返回失败，服务回 422 `REBUILD_FAILED` 且版本与特征树完全不变（`tests.mjs` 第 19/20 条）；Qt 侧收到错误只弹提示并重读，不会显示“已保存”。注意：真实 OCCT 重建仍缺，这一条验的是失败路径而不是几何成功 |
| 6 | 压缩不参与编译、解除即恢复；删除被引用特征被拒绝并指明引用方 | ✅ 压缩/解除在第 12/13 条；删除引用在第 16 条（返回 `REFERENCE_IN_USE` 并点名引用方） |
| 7 | 未知字段、重复 id、沉窝直径 ≤ 孔径、圆角超厚一半等按第 13 节错误码返回 | ✅ 第 8/9 条（`UNKNOWN_FIELD` / `VALIDATION_FAILED`），其余规则见 `validate.mjs` |

**结论（2026-10-28 更新）：§14 七条全部达成**（1 真实几何+体积/质量、2 MCP↔Qt 双向、3 乐观锁、4 事务回滚、5 重建失败路径、6 压缩/删除引用、7 错误码）。
仍属「v0 边界」而非未达成：无持久化（重启回种子树）、单文档、无鉴权（仅回环）、SSE 未接客户端（Qt 用 1.5s 轮询）、QPaint/Qt 只在 Linux 编译验证。

## 15. 未定项（本文故意不定，需要 Sean 拍板，不许实现时擅自默认）

1. 工程包的磁盘文件布局（单文件 JSON + 缓存 BRep，还是目录包）——本文只定了内存包络，没定文件格式。
2. 草图对象的完整 schema 与 SolveSpace 接入方式（进程内库还是独立服务）。
3. 拓扑命名层的稳定键生成规则（几何指纹算法、重命名策略）。
4. 配合求解器的范围（先做重合 / 同轴 / 距离，还是再加平行 / 垂直 / 角度）。
5. 变更事件的传输方式（SSE 还是长轮询）与局域网访问是否开放。——**v0.1 的实际状态：Qt 客户端已改为 SSE 订阅（`GET /v1/events`）为主、10s 轮询兜底、断线 3s 重连；实测外部改树 → 客户端 138ms 刷新（自检把轮询调到 30s 以排除轮询功劳）**。局域网访问仍未开放（只监听回环）。**「SSE 还是长轮询」这条到此可以算选了 SSE，但局域网/鉴权仍是未决策项。**
6. 历史记录的保留条数 / 归档策略。
7. Qt 客户端在仓库里的确切目录名与构建系统（CMake 还是 qmake），以及 Qt + OCCT 在 Windows 真机上的工具链验证方式。
