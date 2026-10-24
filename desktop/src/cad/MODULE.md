# 模块：CAD 轻量化查看（src/cad/）

职责：把 CAD 文件解析成三角网格，在 three.js 里渲染、拾取、测量、降级。**只做查看与包围盒测量，不做 B-rep 建模。**

## 文件分工

| 文件 | 作用 |
|------|------|
| `step.ts` | 调 `occt-import-js` 解析 STEP / IGES / BREP，输出 `CadImportResult` |
| `importer.worker.ts` | 解析跑在 Worker，避免阻塞 UI；用 transferable 回传 TypedArray |
| `loaders.ts` | STL / OBJ / GLTF / GLB 走 three 自带 loader（异步，不占 Worker） |
| `viewer.ts` | three 场景、OrbitControls、fit、线框、拾取、包围盒尺寸、零件列表 |
| `webgl.ts` | `probeWebGL(canvasFactory)` 纯函数，判定能否创建 WebGL 上下文 |
| `kinematics.ts` | 运动学标注层：动件 → 轴/行程/方向/点位绑定，校验 + 姿态解算 + 机型配置交叉核对 |
| `kinematics-ui.ts` | 标注面板：网格多选合并动件、轴/行程/点位编辑、实时校验、滑块预览、按文件名本地保存/导入导出；「自动识别建议」区（高/低置信度分开，逐条采纳/忽略） |
| `kinematics-auto.ts` | 运动学自动识别：名称/型号 + 装配层级 + 几何（PCA 主轴、同轴、回转体）推测动件，输出轴类型/方向向量/行程/缩回位/置信度/中文理由与 IO 点位建议；只出建议，不写标注 |
| `cad.css` | 覆盖层样式（复用原型 token，不新增 UI 主色） |

## 数据结构

```ts
// shared/types.ts
interface CadMeshData {
  name: string;
  positions: Float32Array;   // xyz 交错
  normals: Float32Array | null;
  indices: Uint32Array | null;
  color?: [number, number, number];  // 来自 STEP 的 RGB
  path?: string[];   // 装配层级（根 → 父节点名），STEP/IGES 有层级时由 step.ts 从 occt root 填充
}
interface CadImportResult {
  meshes: CadMeshData[];
  stats: { meshCount: number; triangleCount: number; elapsedMs: number; format: string };
}

interface CadBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
  note?: string;
  partId?: string;
  category?: string;   // 机型方案：执行机构 / 传感器 / 电气
  source?: string;     // 机型方案固定为 machine-design
}
```

Worker 协议（`importer.worker.ts`）：

```
Request:  { id: number; kind: 'occt'; name: string; buffer: ArrayBuffer; wasmUrl?: string }
Response: { id, ok: true, result: CadImportResult } | { id, ok: false, error: string }
```
回传时 `positions/normals/indices` 的 buffer 走 transfer 列表，主线程零拷贝接收。

## 渲染约定

- 背景 `#2A2D31`，网格 `GridHelper`，`HemisphereLight + DirectionalLight`
- 单位按 STEP 源文件 mm 解释，**不做隐式缩放**；状态栏明示「300.000 × 300.000 × 300.000 mm」
- 选中/悬停走材质高亮，不重建 Mesh
- 自动 fit 用包围球 + 视角 FOV 计算相机距离
- `getBomRows()` = CAD 零件行 + `appendDraftBomRows()` 追加的机型 BOM 草稿行；草稿行不参与几何拾取，可按 `batchId` 整批移除，供 `apply_machine_design` / `undo_last` 联动。

## 运动学标注（kinematics.ts）

STEP/IGES 只给几何与装配名，不含轴、行程、方向、点位。本模块是**人工标注层**，不自动识别机构：
把零件名绑到一个运动轴，再绑 PLC 点位，最后由 `axisPose()` 按点位状态算出姿态。

```ts
interface KinematicsAxis {
  part: string;                 // STEP 网格名（动件）
  kind: 'linear' | 'rotary';
  axis: 'x' | 'y' | 'z';        // 直线：运动方向；旋转：绕哪个轴
  travelMm?: number;            // 直线行程，linear 必填
  retractedMm?: number;         // 缩回位置（默认 0，必须 < travelMm）
  rangeDeg?: number;            // 旋转角度量程，rotary 必填
  direction?: 1 | -1;           // 伸出方向，默认 +1
  bindings: { role: 'extend' | 'retract' | 'rotate'; point: string }[];
}
```

- `checkKinematics(doc, { partNames, knownPoints })` **不抛异常**：返回 `issues/errors/warnings`，错误中文可操作
  （动件不在 STEP、行程非正、缩回 ≥ 行程、直线轴填角度、点位不在 IO 表、同点位被两个动件占用等）；
  `assertKinematics()` 是严格包装，供命令行/智能体用。
- 校验通过后 `doc` 已归一化：动件名对齐 STEP 原名、点位统一大写、默认值补齐。
- `axisPose(axis, values)` 解算当前位移/角度；伸展与缩回信号同时为真时 `conflict=true`（传感器/接线冲突）。
- `crossCheckMachineConfig(doc, config)` 与机型配置比对：行程不一致、气缸/夹爪 vs 旋转轴类型冲突、
  执行机构点位未绑定动件，全部给 warning，不阻塞。
- `serializeKinematics()` / `parseKinematicsJson()` 负责保存与读回；`upsertAxis`、`setBinding`、
  `removeBinding`、`removeAxis` 都是不可变编辑，供下一轮标注面板复用。
- 数据来源诚实性：`partNames` 必须来自真实导入结果（`CadImportResult.meshes[].name`），
  `knownPoints` 必须来自真实 IO 表；两者缺省时不做存在性校验，但也不会伪造零件或点位。
- `kinematics-ui.ts` 的纯函数（`draftFromMesh` / `applySlide` / `validateDraft` /
  `serializeAnnotation` / `deserializeAnnotation` / `createKinematicsStore`）不依赖 DOM，可直接单测。
  `MovingPart` 记录 `meshIds` 与合并包围盒中心；滑块 0% 为缩回位，100% 为行程终点。
- 本地保存键固定为 `automationcad.kinematics.v1`，内部按 `sourceFile` 分桶；导出 JSON 含
  `version`、`sourceFile`、`parts`。有错误时保存按钮禁用，顶部显示「N 项未通过，无法保存」。

## 运动学自动识别（kinematics-auto.ts）

STEP 不含运动学；本模块从**网格名、装配层级、几何**三类证据推测动件，产出**建议**，由用户在标注抽屉逐条「采纳」，
采纳后进入动件列表、走与人工标注完全相同的 `validateDraft` / `checkKinematics`，仍需「保存标注」才落 localStorage。

```ts
suggestKinematics(meshes: AutoKinMesh[], { pointOptions?, existingParts?, minConfidence = 0.6, minPointScore = 0.5 })
  → { suggestions /* 高置信度 */, lowConfidence /* 低置信度，UI 折叠单列 */, skipped, stats }
acceptSuggestions(parts, pool, ids, meshes, { pointOptions }) → { parts, accepted, missing, validation }  // 只处理显式 id
suggestionToMovingPart(suggestion, meshes) → MovingPart   // 复用 draftFromMeshes，schema 不变
```

- 每条建议：`category`（气缸/滑台/夹爪/旋转台/丝杆模组/直线导轨/伺服电机）、`kind`、真实 `directionVector` +
  最近主轴 `axis/direction/offAxisDeg`、`travelMm`（直线）/`rangeDeg`（旋转）、`retractedMm=0`（以模型当前位置为缩回位）、
  `strokeSource`（model-code / catalog / geometry / default / none）、`point/role/pointCandidates`、`confidence`、`reasons`（中文）。
- 名称规则：中文/英文关键词（气缸/cylinder、滑台/slide、夹爪/gripper、旋转/rotary、丝杆/ballscrew、导轨/rail、伺服/motor）+
  厂商型号（SMC CDJ2/CQ2/MGP/MXQ/MHZ2/MSQ/CRB、AirTAC TN/MAL/SDA、HIWIN MGN/HGR/HGH、SFU 丝杆）。
  夹爪/旋转/滑台规则先于通用气缸，避免「手指气缸」「旋转气缸」误判；件角色：活塞杆/缸体/台面/手指/滑块/导轨/丝杆/螺母。
- 行程：型号优先（`MGPM20-50`→50、`MXQ12-30`→30、`CRB1BW50-90S`→90°），样本表其次（MHZ2 单指 = 开闭总行程/2，MSQ 标准 180°），
  再次几何估算（气缸：活塞杆缸内长度 − 10% 缸体长 → 最近标准行程；导轨：导轨长 − 滑块长），都取不到时为 0，采纳后由现有校验要求用户填写。
- 归组：同型号/系列（导轨与滑块 `MGN12`/`MGN12H`、`HGR20`/`HGH20CA` 归同系列）→ 父装配名带类别时继承 → 同名主干；
  只有角色无类别的件（`finger_L`、`活塞杆`）按同组包围盒相接并入角色相容的机构。
- 几何：顶点 PCA 主轴 + 投影长度（细长度/扁平度）、绕轴径向分布 + 角度覆盖判回转体；气缸要求活塞杆轴线过缸体中心
  （偏距 ≤ max(2, 20% 缸体截面)）且与缸体长轴夹角 ≤ 8°，伸出方向取活塞杆外露侧；旋转台转轴取台面最薄方向（法向）；
  导轨要求滑块骑在导轨上（包围盒相接、投影在导轨范围内），方向朝远端。
- 置信度：名称（型号 0.35 / 关键词 0.25）+ 几何（同轴 / 骑轨 / 两指连线等 0.2–0.3）+ 行程来源 + 层级 0.05；
  偏离主轴 > 3° 按偏角扣分，活塞杆外露 ≥ 行程 80% 扣分并提示「可能处于伸出状态」；伺服电机固定 0.35（只进低置信度）。
- IO 点位：只匹配同角色（直线 → extend、旋转 → rotate）且类型相容的点位；工位（ST1/工位1/station1）+ 编号（A1）+
  型号 + 名称相似度打分，≥ 0.5 才推荐；全局贪心分配，已被现有动件占用的点位不推荐，两条建议不抢同一点位。
- 数据来源：`CadViewer.getKinematicsGeometry()`（网格信息 + `path` + 顶点引用，占位件除外）；抽屉在 `setSource` 时自动识别一次，
  「识别动件」按钮可重跑。冒烟 `SMOKE_KINEMATICS_AUTO_OK high=4 low=1 accepted=1 autoApplied=0`。
- 测试夹具：`test/fixtures/kinematics-assembly.stp`（64 KB，由 `scripts/gen-kinematics-fixture.mjs` 生成：FACETED_BREP、
  16 棱柱近似圆柱、单位变换装配）。**occt-import-js 会把只含零件的子装配压平到上一级节点**，所以夹具叶子名自带型号，
  层级继承由合成网格单测覆盖。

## 坑点

1. **WebGL 不可用会直接抛 `THREE.WebGLRenderer: Error creating WebGL context`**：xvfb/无 GPU/RDP 常见。现在先用 `probeWebGL()` 探测，失败走降级面板（展示零件数/三角面/包围盒），不再崩溃。
2. **WASM 路径**：`occt-import-js.wasm` 必须由 Vite 复制到 `dist/`，并以 `locateFile` 指定；worker 里用 `?url` 导入，路径随 `assetsInlineLimit: 0` 保持独立文件。
3. **occt 返回的 `index` 是 Uint32**，转 `BufferAttribute` 时别用 Uint16，超过 65535 顶点会花屏。
4. **STEP 单位不一定是 mm**：当前按 mm 解释并在状态栏声明；后续要读 `OCCT` 的单位元数据（`cube-units` 测试文件可复现）。
5. **大模型主线程解析会假死**：必须留在 Worker；主线程只做 geometry 组装。
6. **三角形统计口径**：有 index 时 `index.length/3`，无 index 时 `positions.length/9`，两种都要覆盖（已单测）。

## 进度

- ✅ STEP/IGES/BREP 解析（实测 424 KB 装配 5040 面 / 559 ms）
- ✅ STL/OBJ/GLTF/GLB
- ✅ CAD 导入事务：先准备稳定身份候选，解析通过后才持久登记；解析阶段失败保留当前文档身份/对象映射和视图，首次导入失败显示空状态错误
- ✅ 零件树、三角面统计、包围盒测量、fit、线框、拖放导入
- ✅ WebGL 降级（3 条单测）
- ✅ 智能体占位件（20×20×20 mm 实体 + 线框）、按索引移除与重排、场景/选择/BOM 快照
- ✅ 运动学标注数据层（动件 → 轴/行程/方向/点位，校验 + 姿态解算 + 机型交叉核对，23 条单测）
- ✅ 运动学标注 UI（网格多选合并、实时中文校验、滑块预览、localStorage 分桶、JSON 导入导出，12 条单测）
- ✅ 运动学自动识别建议（名称/型号 + 层级 + 几何，置信度分级、IO 点位建议、逐条采纳，34 条单测 + STEP 夹具端到端 + 冒烟）
- ⏳ DXF 二维图纸（`dxf-parser`，未接）
- ⏳ 剖切面、爆炸视图、装配树层级（当前是平铺 mesh 列表）

## 待办

1. 引入 DXF：图纸视图（白纸 + 墨线）与三维视图分离。
2. 单位识别 + 英寸/毫米切换。
3. 十万面以上模型的分块加载与 LOD（当前一次性建 geometry）。
4. 当前 BOM 是查看器快照（零件名/数量 1/材料 `—`），后续接入原型真实装配 BOM。
