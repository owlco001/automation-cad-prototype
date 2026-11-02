# B-Rep 面级运动副识别 · 可行性 spike

> 目标：判定「用 B-Rep 面分析做运动副自动识别」值不值得做，并用真实可跑的原型给出证据。
> 原型代码：`desktop/scripts/spike/`（新建）。产品代码零改动、无 npm install、无推送。
> 结论基于本机实测输出，跑不起来的部分在 §8 明确标为「未验证」。

---

## 1. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| 技术上可行吗 | **可行**。圆柱面轴线/半径/包角、平面法向、同轴关系都能精确取到，两条规则在合成解析件上 3/3 命中、0 误报 | §6.1 |
| 精度比现有网格 PCA 高多少 | 圆柱配合半径从「外轮廓估计」变成「精确值」（合成件误差 0.000mm vs 网格 15%~280%），同轴关系从「靠半径大小猜」变成「轴线间距 0.000mm 的硬判据」 | §3、§6.3 |
| 能替代现有方案吗 | **不能替代，只能互补**。B-Rep 给几何副（轴/位置/半径），名字+型号给行程/IO 点位/机构语义 | §3.4 |
| 建议做吗 | **建议做，但先做 13~17 人日的 MVP**，且必须先拿到 5~10 个真实客户 STEP 做标定，否则规则阈值是空中楼阁 | §7 |
| 最大风险 | 大装配 O(n²) 面配对（实测 106 件 3.2s，推算 400 件 50 面/件 ≈ 分钟级）+ 现有夹具无解析圆柱面，无法用仓库既有资产验收 | §7.3 |

一个必须先说清的事实：**仓库自带夹具 `desktop/test/fixtures/kinematics-assembly.stp` 是 FACETED_BREP，圆柱体是用 16 棱柱拼的**（`gen-kinematics-fixture.mjs` 头注释明说）。OCCT 读进来 `cylinderFaces = 0`，B-Rep 规则 1 在这份夹具上**完全失效**。所以本 spike 不得不用 OCCT 现场构造一份带真实解析曲面的合成件（§4.1），并把「在有解析面的件上能到什么精度」和「在既有夹具上退化到什么程度」两个结果分开报。

---

## 2. 环境探测（先探测，再选路）

```
python3 -c "import OCP"        → ModuleNotFoundError（无）
python3 -c "import build123d"  → ModuleNotFoundError（无）
python3 -c "import cadquery"   → ModuleNotFoundError（无）
which FreeCADCmd freecadcmd    → 无
which micromamba conda         → 无
```

但系统里**装了 OCCT 7.6.3 的 C++ 开发包**：

```
$ dpkg -l | grep -c occt
12
libocct-foundation-dev 7.6.3+dfsg1-7   libocct-modeling-data-dev 7.6.3+dfsg1-7
libocct-modeling-algorithms-dev ...    libocct-ocaf-dev ...
/usr/include/opencascade/TopoDS_Shape.hxx         存在
/usr/lib/x86_64-linux-gnu/libTKSTEP.so.7          存在
```

所以本机走的是 **C++ 直连 OCCT** 这条路（不装任何新东西）。两个已知别扭点，都在 `build.sh` 里解决了：

1. 7.6 的 dev 包**没有 XCAF/STEPCAFControl 头**（那些在 `libocct-data-exchange-dev`，未装），但 `/usr/local/include/opencascade/` 有一份 8.0 的头。配 `-I/usr/include/opencascade -I/usr/local/include/opencascade`，7.6 头优先、缺的（`NCollection_AliasedArray.hxx`、`XCAFDoc_*`）从 8.0 兜底，链接仍用 7.6 的 `.so`。实测 ABI 够用（读 STEP/名字/装配变换/布尔全正常），但这是**不干净的头库混搭**，生产不能这么干（§7.2）。
2. 8.0 头把 `ShapeTool_s` / `IsReference_s` / `GetShape_s` 系列改名为 `ShapeTool` / `IsReference` / `GetShape`，原型按 8.0 的名字写。

**真实客户 STEP 缺失**：本机唯一像客户数据的 `/srv/material-flow/data/design_packages/*/files/part-a.stp`（5MB）实际是随机字节，不是 STEP：

```
$ head -c 32 part-a.stp | xxd
00000000: 6fd8 ab1c 44b1 44b0 b333 6547 e58d e396  o...D.D..3eG.....
$ file part-a.stp
part-a.stp: data
```

因此实测只有两套数据：仓库夹具（真实但多面体化）+ 合成解析件（标为合成件）。这是本 spike 最大的证据缺口，§8 已列。

---

## 3. 现状对比：网格 PCA vs B-Rep 面分析

### 3.1 现有实现的输入与算法

| 环节 | 位置 | 实际输入 |
|---|---|---|
| STEP → 三角网格 | `desktop/src/cad/step.ts:98-136`（occt-import-js） | 只有 `positions / indices / name / path` |
| 形状统计（主轴/伸长/回转体/半径） | `desktop/src/cad/kinematics-auto.ts:335` `analyzeMeshShape` | 顶点云 + 包围盒 |
| 同轴判断 | `desktop/src/cad/kinematics-auto.ts:833` | `lineDistance ≤ max(2, 0.2*bodyCross) && angle ≤ 8 && rod.radius < body.radius` |
| 名称/型号语义 | `kinematics-auto.ts` 的 `NameClass` / 型号正则 | 零件名 |

**网格路线拿到的只有顶点云**：面在哪、面是什么类型、有没有内孔，全部不可见。PCA 主轴是顶点二阶矩主轴，对理想回转体等于轴线；半径是「顶点到轴线的平均距离」，被棱角、法兰、键槽一起平均。

### 3.2 精度上限（实测，同一份合成件）

`node pca_mesh.mjs fixture/kinematics-analytic.stp`（顶点数、PCA 主轴、三向跨度、三个半径统计）：

```
name      verts  PCA-axis          spans(mm)              rMed   rP90   rMax      B-Rep 真值
Part3       110  0.00,0.00,1.00    80.0  51.8  51.8      10.34  36.59  36.97     孔 R=10.000
Part4        86  0.00,0.00,1.00    80.0  19.6  15.9       9.17  11.32  11.72     活塞 R=9.800
Part5       130  0.00,1.00,0.00    30.0  30.0  30.0       6.03  21.15  21.28     孔 R=6.000
Part6       530  0.00,1.00,0.00    38.0  18.0  17.9       6.02   9.10   9.13     轴 R=5.900 + 轴环 R9
```

三条硬结论：

1. **带内孔的零件，PCA 给出三个数量级的候选半径**（Part3：10.34 / 36.59 / 36.97）。哪个是配合面？顶点云里没有「面」这个概念，只能靠魔数阈值挑一个。B-Rep 直接给 `R=10.000`，还把 D 形孔拆成**包角 216.9° 与 36.9° 两个面片**（说明圆柱面会被裁剪成多片，后面规则必须按轴+半径归并）。
2. **带轴环/法兰的轴，PCA 半径被最大特征带偏**（Part6：rP90=9.10 来自 R9 轴环，真实配合半径 5.9）。这直接打穿现有同轴判据 `rod.radius < body.radius`（`kinematics-auto.ts:833`）：9.10 > 6.03 → 判「不同轴」→ 转动副漏检。**这是现有算法在真实零件上会系统性失效的具体机制**，不只是"精度差一点"。
3. **PCA 主轴在形状对称时反而正确**（Part3/Part4 都是 Z，0° 误差），所以现有方案在"轴方向"上不算差；它差在「半径」和「面的身份」。方向对、半径错，正好把「同轴」这个关键判据做成抛硬币。

### 3.3 现有方案的实测基线（跑仓库既有脚本，非本 spike 编造）

```
$ cd desktop && node scripts/kinematics-baseline.mjs
R1 通用件名 / 无子装配层级（7 套装配 · 352 个网格 · 真值 31 条）
  ≥0.0     74    31     31     0    43     0.0%    0.0%    0.0%   0.0%  80.6%   0.0% 100.0%  50.0%
  ≥0.6      8    31      5     0     3     0.0%    0.0%    0.0%   0.0% 100.0%   0.0% 100.0%  50.0%
  ≥0.8      0    31      0     0     0     —      —      0.0%   0.0%   —     —     —     —
R2 型号在零件名（真实型号）
  ≥0.6     28    31     25    25     3    89.3%  100.0%   80.6%  84.7% 100.0% 100.0%  88.0%  90.0%
```

**「通用件名 / 无子装配层级」档（= 客户给 `Part1` / `Solid1` 的场景）：严格正确 0/31，recall 0%，precision 0%，73 条多余项。**

> 采数说明：该基线在 2026-11-02 15:14 与 15:21 各跑一次，两次输出逐字节相同（`diff` 空）。跑的时候工作树里另有他人未提交的改动（`src/cad/kinematics-auto.ts`、`kinematics-ui.ts` 等），复现前请以自己工作树的输出为准。 客户场景下现有方案不是"效果下降"，是"输出全废"。这条基线是本 spike 立项的最强理由，也给 B-Rep 路线定了对照系。

### 3.4 两条路线的能力边界

| 能力 | 网格 PCA | B-Rep 面分析 |
|---|---|---|
| 主轴 / 大致方向 | ✅ 准确（对称件 0° 误差） | ✅ 精确 |
| 圆柱配合半径 | ❌ 外轮廓估计，实测偏 15%~280% | ✅ 精确到 1e-3 mm |
| 轴线位置 | ⚠️ 顶点质心近似 | ✅ 曲面自带的 `gp_Ax1` |
| 面的身份（孔 vs 外圆） | ❌ 不可见 | ✅ 面类型 + 包角 + 面积 |
| 同轴/贴合关系 | ⚠️ 靠半径大小猜 | ✅ 轴线间距、法向反平行、重叠面积 |
| 行程 travel | ⚠️ bbox 估算 | ⚠️ 只能给几何上限，行程仍要型号/配置 |
| 机构语义（"这是压装气缸"） | ✅ 名称/型号 | ❌ 无 |
| IO 点位 / 节拍 | ✅ 名称+配置 | ❌ 无 |

结论：**B-Rep 补的是几何副这一层，不是替代名字。** 落地形态应是「B-Rep 出候选（轴+位置+型别+置信度）→ 名称/型号补行程与语义 → 合成为现有 `Suggestions`」。

---

## 4. 原型

### 4.1 合成夹具（因为仓库夹具没有解析曲面）

`desktop/scripts/spike/make_fixture.cpp` 用 OCCT 现场建模再写 STEP（`STEPCAFControl_Writer`，保留名字与装配变换）。**这是合成件，不是客户数据**：

| 零件 | 几何 | 名字 | 世界位置 |
|---|---|---|---|
| Part1 | 底座 200×120×15 | `Part1` | 原点 |
| Part2 | 滑块 80×40×20 | `Part2` | 底面贴合底座顶面 |
| Part3 | 缸体 50×50×80，中心 R10 通孔 + 铣扁平面（D 形孔） | `Part3` | 立在底座上 |
| Part4 | 活塞 R9.8，D 形截面，与孔留 0.2mm 间隙 | `Part4` | 与 Part3 同轴 |
| Part5 | 轴套 30×30×30，中心 R6 通孔（沿 Y） | `Part5` | 立在底座上 |
| Part6 | 轴 R5.9 沿 Y + 两端 R9 轴环（轴向定位） | `Part6` | 与 Part5 同轴 |

零件名刻意用 `Part1..Part6`——就是客户 `Part1`/`Solid1` 的场景，同时证明 B-Rep 路线不依赖名字。**每个零件在自身局部坐标系建模，再用 XCAF `AddComponent` 摆到世界坐标**，逼原型必须处理装配变换（否则一进真实装配就错位）。

真值（写在 `truth/kinematics-analytic.json`，夹具代码里不存）：

- J1 Part1↔Part2 移动副 +X（贴合 80×40 + 长条包围盒）
- J2 Part3↔Part4 移动副 +Z（同轴圆柱 + **法向⊥轴的铣扁平面防转**）
- J3 Part5↔Part6 转动副 +Y（同轴圆柱 + **法向∥轴的轴环端面止推**）

后两条是刻意设计的：**「同轴圆柱」本身分不出转动还是移动**，必须靠平面证据判别（§5）。这也是本 spike 最有价值的一条工程结论。

### 4.2 分析器数据流

`brep_joints.cpp`（764 行，含 JSON 输出与面清单）：

```
STEPCAFControl_Reader → XCAF 文档
  ↓ walk(): 自由形状 → 装配递归 → 叶子零件（形状 + TopLoc_Location）
  ↓ 每个 Solid→Face: BRepAdaptor_Surface
      plane    → 法向（含 face orientation 修正）、面积
      cylinder → 轴线 gp_Ax1、半径、包角(U 参数跨度)、轴向跨度(V 参数/bbox 投影)、面积
  ↓ 规则 R1（同轴圆柱对） / R2（平面贴合 + 长条包围盒）
  ↓ 候选：零件对、型别、轴、半径、重叠/接触面积、置信度、证据串
```

关键实测数字（合成件）：6 零件 / 44 面（平面 34、圆柱 10），读 STEP 50~53ms，分析 86~91ms。

### 4.3 四个把原型卡住的坑（都是真坑，产品化会再撞一遍）

1. **面法向必须结合 `face.Orientation()`**。`BRepAdaptor_Surface::Plane()` 返回的是底层曲面的法向，`MakeBox` 造出来的六个面可能共用同一朝向的平面——实测底座顶面与滑块底面**原始法向点积 = +1**，看起来"同向"而不是"贴合"。必须 `TopAbs_REVERSED` 取反后才是外法向。漏这一步，所有平面接触恒为 0，规则 R2 直接死。
2. **两个共面 face 做布尔交是退化二维运算**，OCCT 返回空或碎片（面积恒 0）。改成：先把 B 沿法向平移 gap 落到 A 所在平面，再把两个面各挤出 1mm 薄棱柱做 3D 布尔，`体积/1mm` 即贴合面积。这一步之后 3200mm² 的贴合面积一次算准。
3. **`BRepPrimAPI_MakePrism(face)` 返回的不一定是 SOLID**（可能是 SHELL/COMPOUND），拿 SHELL 算体积恒 0。需要按 `ShapeType()` 兜住并 `BRepBuilderAPI_MakeSolid`。
4. **装配层级有两条**：`IsReference(label)` 为真但被引用的是**子装配**时，不能用 `GetShape(ref)` 一把抓（那样整个子装配会被当成一个零件——我第一版就是这样，22 个零件的夹具只解析出 4 个"零件"）。必须继续递归 `GetComponents`。另外装配实例名常为空或是合成名 `=>[0:1:1:2]`，要回落到引用件的 `TDataStd_Name`。

第 4 条正是任务里担心的「装配层级丢失」——它真实存在、可修，但**修法是显式的**，不是自动就好。

### 4.4 复现命令

```bash
cd desktop/scripts/spike
./build.sh                      # g++ + OCCT 7.6 系统库，无网络、无新包
./run_spike.sh                  # 全流程 13s：编译→造夹具→两条规则→真值对照→PCA→规模
```

单步：

```bash
./make_fixture fixture/kinematics-analytic.stp        # 合成装配（真实解析面）
./brep_joints fixture/kinematics-analytic.stp         # 人读：零件面清单 + 候选
./brep_joints fixture/kinematics-analytic.stp --json  # 机读
python3 eval.py truth/kinematics-analytic.json        # 真值 vs 估测
python3 eval.py truth/repo-fixture.json               # 仓库夹具（多面体化）
node pca_mesh.mjs fixture/kinematics-analytic.stp     # 网格 PCA 对照
SPIKE_DEBUG_PLANES=1 ./brep_joints <file>             # 打印每个平面配对的 gap/面积
```

---

## 5. 判定规则原型

### 5.1 参数表（`brep_joints.cpp` 顶部常量）

| 常量 | 值 | 含义 |
|---|---|---|
| `kTolAngleDeg` | 1.0° | 轴/法向平行判据 |
| `kTolAxisDist` | 0.30 mm | 同轴判据（两轴线间距） |
| `kTolRadiusDiff` | 0.50 mm | 配合半径差上限（间隙+公差） |
| `kTolPlaneGap` | 0.50 mm | 平面贴合间隙上限 |
| `kMinContactArea` | 20 mm² | 有效接触面积下限（滤掉点接触/棱接触） |
| `kMinOverlapLen` | 1.0 mm | 同轴圆柱的轴向重叠下限 |
| `kPrismT` | 1.0 mm | 贴合面积计算的挤出厚度 |

### 5.2 R1：同轴圆柱对 → 转动/移动/圆柱副

```
for 零件对 (A,B):
  for A 的圆柱面 a, B 的圆柱面 b:
      轴夹角 ≤ 1° 且 轴线间距 ≤ 0.3mm 且 |Ra-Rb| ≤ 0.5mm 且 轴向重叠 ≥ 1mm
      → 记一次同轴命中（同一零件对取轴向重叠最大的一次做代表）
  命中后判别型别（看这对零件之间的平面接触，法向与轴的关系）：
      有法向 ∥ 轴、面积 ≥ 20mm² 的贴合面   → revolute   (轴向被限位，conf 0.90)
      有法向 ⊥ 轴、面积 ≥ 20mm² 的贴合面   → prismatic  (平面防转，  conf 0.88)
      都没有                              → cylindrical (2 DOF，轴确定、转/移未定，conf 0.55)
```

判别逻辑的物理依据：同轴圆柱接触本身只约束 4 个自由度，剩「绕轴转 + 沿轴移」两个；再加一个法向∥轴的平面就把沿轴移锁死（转动副），加法向⊥轴的平面就把绕轴转锁死（移动副）。**这是自由度层面站得住的判据，不是经验凑的。**

### 5.3 R2：平面贴合 + 长条包围盒 → 移动副

```
for 零件对 (A,B)（没有同轴命中的）:
  找共面贴合：法向反平行(点积≤-0.999) 且 间隙 ≤0.5mm 且 重叠面积 ≥20mm²
  取重叠面积最大的一条，方向 = 贴合面内、动件 bbox 最长的世界轴
  长宽比 = 面内长边 / 面内次长边，要求 ≥ 1.5
  confidence = 0.60 + 0.25*min(1,(aspect-1.5)/2) + 0.05*面积比 (+0.03 若承导件明显大于动件)，封顶 0.95
```

### 5.4 去重与输出

同一零件对只保留置信度最高的候选（按 unordered pair 去重）。输出 `{a, b, type, axis, origin, radius, radiusDiff, overlap, contactArea, confidence, evidence[]}`，`evidence` 是给 UI 讲理由用的（例：`coaxial: R=10.00 dR=0.20 axisDist=0.000 overlap=70.0mm arc=217/216deg`）。

---

## 6. 实测

### 6.1 合成解析件：3/3，零误报

```
$ python3 eval.py truth/kinematics-analytic.json
零件 6 · 面 44（平面 34 / 圆柱 10） · 读 STEP 50ms · 分析 85ms   ← 逐次运行有 ±8ms 抖动

真值零件对              真值型别      估测型别     轴误差   置信度  结论
Part1 ↔ Part2          prismatic   prismatic    0.0°   0.71   命中
Part3 ↔ Part4          prismatic   prismatic    0.0°   0.88   命中（防转平面 711mm²）
Part5 ↔ Part6          revolute    revolute     0.0°   0.90   命中（轴环止推面 85mm²）

命中 3/3（型别对 3，轴对 3）· 候选 3 条，误报 0 条 · precision 100% · recall 100%
严格正确（型别 + 轴 ≤15°）：3/3
```

零件面清单（证明"面级信息"确实取到了）：

```
[2] Part3  faces=13  cyl=2  plane=11
      cyl R=10.000 axis=(0,0,1) arc=217° h=80.0      ← D 形孔被裁成两片
      cyl R=10.000 axis=(0,0,1) arc=37°  h=80.0
[3] Part4  faces=5   cyl=2  plane=3
      cyl R=9.800  axis=(0,0,1) arc=219° h=80.0
[4] Part5  faces=7   cyl=1  plane=6
      cyl R=6.000  axis=(0,1,0) arc=360° h=30.0
[5] Part6  faces=11  cyl=5  plane=6
      cyl R=9.000  axis=(0,1,0) h=2.0（轴环）+ R=5.900 h=30.4（轴身）
```

### 6.2 仓库夹具（FACETED_BREP）：召回掉到 3/5，轴只对 1/5

```
零件 11 · 面 114（平面 114 / 圆柱 0） · 读 STEP 58.4ms · 分析 113.2ms

CDJ2B16-50_body ↔ CDJ2B16-50_rod   prismatic  —           漏检（无解析圆柱面）
ST1_RAIL ↔ ST1_CARRIAGE_MGN12H     prismatic  prismatic  0.0°  命中（conf 0.67）
MSQB20A_body ↔ MSQB20A_table       revolute   —           漏检（无解析圆柱面）
MHZ2-16D_body ↔ finger_L           prismatic  prismatic 90.0°  型别对、轴错
MHZ2-16D_body ↔ finger_R           prismatic  prismatic 90.0°  型别对、轴错

命中 3/5 · precision 100% · recall 60% · 严格正确 1/5
```

两个漏检是**数据问题不是算法问题**：夹具里圆柱是 16 棱柱，`cylinderFaces=0`，R1 无从下手。两个轴错暴露 R2 的真实弱点：

> R2 的方向取自「动件 bbox 在贴合面内的最长边」。夹爪手指 6×10×20 立在缸体顶面上，面内长边是 10（Y），而实际开合方向是 X（6mm 那一边）。**单个零件的包围盒无法区分「长边」与「运动方向」**——需要导轨/槽/配对件约束。这条要产品化必须补「配对件双侧约束」或「滑动副候选按接触面法向族投票」。

### 6.3 耗时、代码量、依赖

| 项 | 实测（多次运行，波动 ±10%） |
|---|---|
| 读 STEP（6 件解析件 / 11 件夹具 / 106 件） | 50ms / 58ms / 669ms |
| 分析（含全部零件对布尔） | 86ms / 113ms / 3220ms |
| 代码量 | `brep_joints.cpp` 764 行 · `make_fixture.cpp` 146 · `eval.py` 201 · `pca_mesh.mjs` 159 · `build.sh` 11 |
| 依赖 | g++ 12、OCCT 7.6.3 系统库（`libocct-*-dev`）、python3（仅 stdlib）、node + 已有 `occt-import-js` |
| 新增第三方包 | 0 |

### 6.4 规模测试（爆炸风险的真实数据）

```
grid=0    parts=6   faces=44  pairs=15    analyze=86ms
grid=20   parts=26  faces=164 pairs=325   analyze=252ms
grid=40   parts=46  faces=284 pairs=1035  analyze=648ms
grid=100  parts=106 faces=644 pairs=5565  analyze=3147~3220ms
```

零件对数是 `n(n-1)/2`，时间随零件对数近似线性 → **对零件数是 O(n²)**。106 件的 3.2s 是在「每件只有 6 个面」的前提下：面数涨到 40~50（真实机加件常态），每对的平面配对从 36 涨到 ~2000（约 55 倍），同规模推算 100~200 件就要**分钟级**。已加 `--max-parts`（默认 400，口径与 `spike/brep-interference/brep_interference.py` 一致）超限直接拒绝：

```
$ ./brep_joints /tmp/grid100.stp --max-parts 50
{"ok": false, "code": "TOO_MANY_PARTS", "parts": 106, "maxParts": 50}
```

106 件时**误报 0 条**（100 个填充块互不接触，没有贴合面）——说明 R2 的贴合门槛在稀疏装配上不虚报；但反过来，若这 100 块都贴在同一底板上且是长条形，就会每条一个候选（去重只按零件对做，没有全局约束求解）。**精度随装配密度下降是结构性的，未做量化。**

---

## 7. 结论

### 7.1 值不值得做

**值得，但要把期望放对。**

- 能拿到的是：几何副的**轴、位置、配合半径、型别候选、置信度、可解释证据**。这一层现有网格方案原理上就做不到（§3.2 第 2 条是同轴判据被半径带偏的具体机制）。
- 拿不到的是：行程、IO 点位、机构语义、节拍——这些仍靠名字/型号/配置。**所以它是 `kinematics-auto` 的新证据源，不是替代品。**
- 现有方案在客户无名件场景是 **0/31 严格正确**（§3.3）；B-Rep 在合成解析件上是 **3/3**（§6.1）。差距足够大，值得投入。但 3/3 是在 6 件合成件上，统计意义弱，不能当承诺。

### 7.2 落地形态（重要）

不要学这个 spike 写 C++ 二进制。产品里**已经有 Python + OCP 的 sidecar**：

- `desktop/electron/parametric.ts:666` `brepInterference()` → 调 `spike/brep-interference/brep_interference.py`（OCP 布尔、XCAF 遍历、`--max-parts/--max-candidates` 上限、结构化失败码 `PYTHON_NOT_FOUND`/`SCRIPT_MISSING`/`SPAWN_FAILED`、默认 600s 超时）。
- 那份脚本的 `collect_shapes()` 已经解决了我踩过的坑 #4（装配递归 + 实例位置 + 同名件按序号区分），**可以直接复用**。
- 代价：`parametric.ts:84` 记录冷启动 3s（Linux）/35s（Windows），且要求用户装了 Python+OCP。所以 `analyzeJoints` 必须异步、可缓存（按文件 hash+大小）、失败可降级（无 OCP 时静默退回现有启发式）。

### 7.3 工作量估算（人日）

| 工作项 | 人日 | 说明 |
|---|---|---|
| 面级特征提取 + XCAF 装配遍历 + 单位/变换 + 结果缓存 | 3~4 | 可复用 `brep_interference.py` 的遍历骨架 |
| R1/R2 移植到 Python/OCP + 阈值标定 | 4~5 | 本 spike 的 764 行 C++ 是算法已跑通的证明，Python 版更短 |
| 与 `kinematics-auto` 融合（证据源 + 置信度合成 + UI 展示理由） | 4~5 | 现有 `acceptSuggestions`/`validateDraft` 不动，只加"证据"字段 |
| 回归测试（真值表 + 夹具扩展：给仓库夹具补一份解析曲面版） | 2~3 | 现在只有 1 个多面体夹具，必须先造解析版夹具进 CI |
| **MVP 小计** | **13~17** | 只做 R1/R2，在 1 个解析夹具 + 1 个客户件上验收 |
| 更多副类型（导轨+滑块、丝杠螺母、锥/球面、齿轮齿条耦合） | 6~8 | 齿轮齿条需要齿形/节圆推理，属于另一个量级 |
| 性能优化（AABB 空间索引、面配对剪枝、并行） | 3~4 | 不做就撑不住 100+ 件 |
| 真实数据标定（5~10 个客户 STEP 逐个人工标注） | 5~8 | **外部依赖，不是纯工时** |
| **完整可用小计** | **27~37** | |

### 7.4 风险（按严重度）

1. **大装配面数爆炸（高）**：O(n²) 零件对 + 每对平面配对布尔。实测 106 件 3.2s、面数假定 6/件；真实件 40~50 面/件推算分钟级。缓解：AABB 邻接剪枝（只对 bbox 相交/相距 <2mm 的零件对做规则）、圆柱按 (轴, 半径) 哈希分桶再做同轴配对（把圆柱配对从 O(Ca·Cb) 降到近似 O(n)）、贴合面积计算换 2D 多边形裁剪替代薄棱柱布尔。
2. **数据不可得（高，且不是代码能解决的）**：仓库夹具是多面体、本机无真实客户 STEP。没有 5~10 个带人工标注的真实装配，"阈值标定"和"精度承诺"都无从谈起。**建议先花 1~2 人日拿数据，再开工。**
3. **装配层级/实例复用（中）**：子装配引用必须递归（已修，§4.3-4）；同一 `TShape` 多实例目前逐实例重复算面（未按 TShape 去重，大装配里同一标准件出现 50 次就是 50 倍浪费）；实例名可能是空或 `=>[...]` 合成名。
4. **圆柱误判（中）**：圆柱面会被裁剪成多片（实测 D 形孔拆成 217°+37°），必须按 (轴, 半径) 归并才能算包角/重叠；轴向重叠用面 bbox 投影，对锥面/斜切会失真；螺纹孔、倒角圆环会产出大量小圆柱 → 需要最小半径/最小轴向长度/最小包角过滤（当前只过滤 R<0.5mm，实测未加）。
5. **型别只能给到"候选"（中）**：无平面证据时降级 `cylindrical`（2 DOF，conf 0.55）——这是诚实的降级，不是失败；但 UI 必须能表达"轴已知、转/移未定"。
6. **索引对齐（中，未验证）**：B-Rep 侧的零件顺序取 XCAF，UI 侧的 `KinematicsMeshInfo.id` 取 occt-import-js 的 mesh 顺序。实测这份夹具两者 **11/11 逐位同名**（`diff` 空），但这是实现细节不是契约；产品化必须用「名字 + bbox」做一次对齐校验，对不上就降级。

### 7.5 接口建议

```ts
/** 运动副候选（几何事实，不含行程/语义）。 */
export interface JointCandidate {
  /** 稳定 id：`${nameA}::${nameB}::${type}`，用于 UI 采纳时去重。 */
  id: string;
  parts: [PartRef, PartRef];              // { name, path, meshId? } —— meshId 需按名字+bbox 对齐后回填
  type: 'revolute' | 'prismatic' | 'cylindrical';
  axis: { origin: [number, number, number]; dir: [number, number, number] };  // 世界坐标，单位 mm，dir 单位向量
  radiusMm?: number;                      // 圆柱配合半径（revolute/prismatic 都有）
  engagementMm?: number;                  // 轴向重叠长度（几何上限，不是行程）
  contactAreaMm2?: number;                // 平面判别证据面积 / 贴合面积
  confidence: number;                     // 0..1
  evidence: Array<{ kind: 'coaxial' | 'planar-axial-stop' | 'planar-anti-rotation' | 'planar-contact' | 'elongated-bbox'; detail: string; value?: number }>;
  warnings?: string[];                    // '同轴无平面证据，转/移未定' / '圆柱面被裁成多片，已按同轴归并'
}

export interface AnalyzeJointsResult {
  ok: boolean;
  code?: 'PYTHON_NOT_FOUND' | 'SCRIPT_MISSING' | 'PARSE_FAILED' | 'TOO_MANY_PARTS' | 'TIMEOUT';
  message?: string;
  candidates: JointCandidate[];
  stats: { parts: number; faces: number; cylinderFaces: number; pairChecks: number; readMs: number; analyzeMs: number };
}

/** 与 brepInterference 同形：同一个 Python/OCP sidecar，同一套失败码与超时口径。 */
export function analyzeJoints(
  stepPath: string,
  options?: { maxParts?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<AnalyzeJointsResult>;
```

要点：

- **只出候选，不改标注**——与现有 `acceptSuggestions` 的边界一致（用户逐条采纳）。
- `type` 里保留 `cylindrical`，别硬塞成 revolute/prismatic；把不确定性交给 `confidence` + `warnings`，比猜错更可信。
- `evidence` 必须透传到 UI：客户看"轴线间距 0.000mm、包角 360°、端面止推 85mm²"比看"置信度 0.90"更愿意点采纳。
- 缓存键：`stepPath + size + mtime + maxParts`，B-Rep 结果与模型文件同生命周期。

---

## 8. 未验证 / 已知缺陷（照实列）

1. **没有在真实客户 STEP 上跑过**。本机 `part-a.stp` 是随机字节，仓库夹具是多面体。所有精度数字都来自 6 件合成件 + 11 件多面体夹具，**统计意义不足**，不能外推成"客户件 90% 命中"。
2. **齿轮/齿条、丝杠螺母、锥面、球面、花键副全部未实现**。只做了平面与圆柱两条规则。
3. **行程（travel）未做**。`engagementMm` 只是几何重叠，不等于可用行程。
4. **同实例复用未去重**：同一 `TShape` 在装配里出现多次时，面分析会被重复执行（正确性不受影响，性能受影响）。
5. **深层嵌套装配未验证**：变换累积按 `parentLoc * childLoc` 写，只在单层 + 两层夹具上验证过；三层以上未测。
6. **平面贴合面积的阈值未标定**：20mm² 是拍的；薄棱柱厚度 1mm、间隙上限 0.5mm 也没做敏感度分析。
7. **圆柱配对是 O(Ca·Cb) 暴力**：没做哈希/索引，这是 §6.4 规模曲线的主因之一。
8. **头库混搭**：`/usr/include/opencascade`(7.6) + `/usr/local/include/opencascade`(8.0) 混用编译。原型能跑通（读/写/布尔/名字/变换全对），但**这不是可发布形态**；产品侧应走已有的 Python+OCP sidecar（§7.2），那里没有这个问题。
9. **`--grid` 合成件的 100 个填充块互不接触**，所以"大装配误报率"没有被真正测到；密集贴合装配（底板 + 大量长条固定件）的误报率未量化。
