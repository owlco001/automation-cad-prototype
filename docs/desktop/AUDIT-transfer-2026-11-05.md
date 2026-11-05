# 独立审计：顶升移载工位（commit `bb02b36`）

审计对象：`feat(machine): 顶升移载工位（不转板，90° 平移出料）+ 材质着色`
审计方式：只读仓库，不改源码/测试。所有数字用 Node 26 直接 import 仓库 `.ts` 现算（脚本在
`/root/.hermes/cache/scratch/{audit1,audit2,audit3,cmp,neg,neg2,plc,plc2}.ts`），
不引用作者日志里的任何数字。

**行号口径**：一律按 `HEAD = bb02b36` 计。审计期间工作区被另一会话改动（`spec.ts` / `synth.ts` /
`router.ts` / `conveyor-assembly.ts` 有未提交 diff），本报告不采信那些改动，也未修改任何源码或测试；
行号偏 2~30 行时以 `git show HEAD:<file>` 为准。

基准参数（与 `desktop/test/machine/transfer-unit.test.mjs:32` 一致，也是 E2E 用的那台）：
线体 6000×1200，皮带面 850，带厚 4，型材 40，板 1200×800，需求句
「光伏板加工输送机：输送 1200×800mm 光伏板，线体长 6000mm、带宽 1200mm，需要顶升移载沿 90° 方向把板子送到下游输送线，节拍 6 件/分钟」。

复现：

```
cd desktop
node /root/.hermes/cache/scratch/audit1.ts   # 轴集 / 带面 / 行程落点
node /root/.hermes/cache/scratch/audit2.ts   # 三态干涉 / 负向对照 / PLC / 材质
node /root/.hermes/cache/scratch/neg2.ts     # 偏移扫描（负向对照选点）
node /root/.hermes/cache/scratch/cmp.ts      # 移载 vs 转向 轴集对比
```

---

## 结论表

| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 1 | 板不转向（无旋转轴、姿态不变） | **部分成立** | 几何/运动轴确实只有平移：`geometry.moving` 两条 `linear`——`transfer-lift` `axis=[0,0,1]` / 60 mm、`transfer-push` `axis=[0,1,0]` / 1140 mm，`rangeDeg` 均 0（`machine-geometry.ts:324-360`）；112 个刚体里 `rotationZDeg≠0` 的 0 个；联动时间线 2 步 6200 ms，`poseAt` 在 0/1500/2600/4000/6000/6200 ms 六个时刻 `rotZDeg` 全空。**但 config 里有一条 90° 旋转轴**：`st1-rotary-1, kind=rotary, rotationRangeDeg=90, point=ST1-ROT-A1`（`templates.ts:66` 输送模板把驱动滚筒当旋转轴 + `synth.ts:954` 生成），它进了 io-map（Q0.2 输出、I0.2/I0.3 两个到位）和 PLC `DB_IO`。另外**工件（板）根本不在几何里**（`conveyor-assembly.ts` 只出机构，112 件全是机构），所以"板姿态不变"没有任何位姿矩阵可查。 |
| 2 | 上行窄带一根不断 | **成立** | 6 条，y 中心 −500/−300/−100/100/300/500，宽 80，节距 200，带缝 120；每条 `x∈[−2980,2980]`、长 5960（`conveyor-assembly.ts:1674-1681`，`narrowBeltLayout` :256-276）。每一条自身无断口；断口只出现在"带与带之间"（5 条 120 缝 + 两端各 60），这是设计使然。回程在单元处让开 2×(520+10)（:1670、:1695-1704）。 |
| 3 | 顶升后沿 +Y 平移 1140 到下游、落点在对接段带面 | **部分成立** | 轴/行程/终点算得对：`transfer-push` cylinder、`travelMm=1140`、`position=[0,0.05,0]`（`synth.ts:1080-1088`），几何轴 `[0,1,0]`、`pivot=[0,−430,945]`；推板静 y=−430 → 末 710（`conveyor-assembly.ts:1073-1074`）。板被推 1140−15（接触间隙）=1125，终点板 y 725..1525、中心 1125，对接段带面 660..2050、5 辊 760/1057.5/1355/1652.5/1950 → 板尾进 65 mm、板头距末端 525 mm、距挡停 495 mm，**落点在范围内**。**但板推不出去**：+Y 出料口只开到 ±530（`innerX = unitHalfMm + 10`，`conveyor-assembly.ts:1748`），板长 1200 → 每侧超 70 mm；挡边 z 851..911（:1733），顶升后板底 905（`rollerTopLiftZ`，:1124），比挡边顶低 **6 mm**。板过 y≈603 时两侧各扫 70×3×6 = 1260 mm³，合计 **2520 mm³**。 |
| 4 | 三态干涉 confirmed 为 0 | **成立**（数字真跑出来是 0），但解释力有限 | `runInterferenceStates(['rest','lift','push'])`：pairs 54/52/52，confirmedHits **0/0/0**，mm3Confirmed **0**，reviewStatus pass；mates 2（缸体×活塞杆 19792 mm³/对）。负向对照证明检查器能报错：`gearmotor` 沿 +Y 偏 40 mm → confirmed 3 对 / **260600 mm³** / fail（rail-left×gearmotor 224000）；`dock-stop` +X 40 → 1 对 1800 / fail；`cross-2` +Z 40 → 6 对 76800 / fail。 |
| 5 | 四个联锁信号真进了 PLC（DONE←TRANSFER-END、启动←DOWNSTREAM-ALLOW） | **不成立** | 点确实有地址（`io-tags.csv`：Q0.0 DONE、Q0.1 READY、I0.0 DOWNSTREAM-ALLOW、I0.1 TRANSFER-END；`DB_IO.st` 同名声明），但**没有任何逻辑引用**：`generateProject` 的 stats `steps=0, sequenceEmpty=true`（config 无 `sequence`，`synth.ts` 从不写；`sequence.ts:175-179` 只回落到空骨架）。`FC_AutoSequence.st` 全文只有 `STEP_IDLE`/`STEP_ERROR`，每扫描把 5 个输出写 FALSE，**没有任何转移条件引用 I0.0/I0.1，DO-TRANSFER-DONE 从未被置 TRUE**；`DI-DOWNSTREAM-ALLOW` 在 11 个文件里被读 0 次；`FC_Safety` 只读急停/安全门；`FC_Alarms` 只读顶升两个到位做"同时为 1"报警。判定：**信号未参与控制**。 |
| 6 | 四种材质颜色取值不同且 GLB/3D 同源 | **成立** | `MATERIAL_COLORS = { AL6063:'#b9c4cc', Q235:'#6d7784', PVC:'#2f7d4f', STEEL45:'#e3eaf0' }`（`machine-geometry.ts:253-258`）；上色在 `:733` 按 `parentId → material` 查表写进 `part.color`；GLB 直接用 `part.color` 建 material（`geometry-export.ts:196-204`），**同一来源**。实测 112 件里四种材质都在（23/35/36/18），每种只映射到一个色值；`geometryToGltf` 产出正好 4 个 material，`name` 就是这四个 hex。 |

---

## 发现的真问题（按严重度）

**1｜严重：板过不了出料侧挡边，"顶升后推出"在几何上不成立**
`conveyor-assembly.ts:1734-1748` 只在 `|x| ≤ unitHalfMm+10 = 530` 处断开 +Y 挡边，而板长 1200；
`:1733` 挡边底 = 带面+1 = 851、高 60 → 顶 911，`:1124` 顶升到位辊面（= 板底）= 845+60 = 905。
板底 905 < 挡边顶 911，**板厚多少都一样**：板底在挡边顶以下 6 mm。板横跨 y=603 时两侧各
70 mm（530..600）× 3 mm（挡边厚）× 6 mm = 1260 mm³，合计 2520 mm³。
注释 `:1728` 写的"板被顶到 905，比挡边顶 911 只低 6 mm"把**板底**当成了板顶：若 905 是板顶，
板底 870，比挡边顶低 41 mm，更过不去。
最小修法：顶升行程 60 → ≥67（台板顶 786+7=793 仍 < 带底 846，导柱 793 也仍在带缝里），
且出料口宽度从 1060 改到 ≥ 板长 1200 + 余量。

**2｜严重：四个联锁信号没进控制逻辑，但提交信息与方案卡写成"真进了 PLC"**
`generateProject` 生成 `FC_AutoSequence.st` 是空壳（`steps=0`，`SEQUENCE_EMPTY` 只是 warning，
预检不拦）。后果：DO-TRANSFER-DONE / DO-TRANSFER-READY 在 IDLE 与 ERROR 两个分支里被反复写
FALSE，永远不可能为 TRUE；DI-DOWNSTREAM-ALLOW 无人读。"互锁存在"这句话没有任何代码支撑。
仓库里其实有现成实现 `plcgen/linkage-program.ts:49 buildSequenceFromLinkage`，但**全仓库零调用**
（grep 只有定义与文档），而且它按"轴 → 传感器"生成 wait，`DI-DOWNSTREAM-ALLOW` 绑的是**工位**、
`DO-*` 也不是步序输出，直接接上也覆盖不到这两条互锁。

**3｜中：config 里仍带一条 90° 旋转轴，"无旋转轴"不成立**
`templates.ts:66` 给输送模板固定 `{ kind:'rotary', count:1 }`（把驱动滚筒当旋转轴），
`synth.ts:947-969` 把它落成 `st1-rotary-1`（90°、点位 ST1-ROT-A1）。移载机型没有清掉它，
于是 io-map 有 Q0.2 输出、I0.2/I0.3 两个到位，PLC `DB_IO` 里也有一行"工位1_工位1旋转轴1_旋转"。
几何里没有对应零件（moving 只有 2 条线性轴），所以 3D 看起来不转，但电气交付物里有一台 90° 转台。

**4｜中：PLC 变量表把两条直线轴命名为"旋转"**
`plcgen/io.ts:364` 对任何 `actuator.point` 一律给 purpose `'旋转'`，`plcgen/tags.ts:50` 用
`${station}_${owner}_${purpose}` 拼变量名 → `移载工位_移载工位顶升台_旋转 AT %Q0.3`、
`移载工位_移载工位移载台_旋转 AT %Q0.4`，注释也是"旋转"。提交里修的只是 io-map 的 `type` 字段
（`machine/io-map.ts:66-67` → `气缸·直线动作`）。现场按变量表接线时这两个点仍是"旋转"。

**5｜中：板件不在几何里，"板被移载/板不转向/落点"三件事都没有模型可验**
`conveyor-assembly.ts` 只生成机构件，`transfer-push` 轴的 partIds 只有推板+滑座
（`machine-geometry.ts:312-314`），push 态只把这两件推 1140。3D 联动 `buildLinkage` 两步
（顶升 2000 ms + 推 4200 ms），推的时候动的也只有推板——**画面上看不到板被送走**。
"板姿态不变""板落在对接段"全部只存在于文字和算式里，不参与任何检查。

**6｜中：`confirmed=0` 的解释力比看上去弱**
- declared 关节是"整对白名单"：`machine-geometry.ts:531` 声明 dock 纵梁×支腿"贴合"，把
  `dock-leg-1` 抬 80 mm 插进纵梁 40×40×40 = 64000 mm³，pairs 从 54 变 55，但被判 `declared`，
  `confirmedHits` 仍是 0、`reviewStatus` 仍 pass。
- 圆柱类配对永远升不到 exact：`transfer-roller-1` 撞立柱 40 mm、`transfer-roller-1` 撞推板 80 mm，
  都只有 `confirmation:'aabb'` 的 1 条 screenHit（warn），`exactOverlapMm3=null`。
  移载单元里辊/立柱/导柱全是圆柱，正好落在"只能 AABB"的那一类。

**7｜轻：6 条窄带里 2 条永远不承载**
板宽 800（y ±400），两条最外带在 y=±500（跨 ±460..±540）——板边正好落在 ±400 的带缝中心。
实际承载的是 4 条带（±340..±260、±140..±60），接触宽 320 mm。不是断带，但"1200 宽 6 条带 +
800 宽板"这个组合的选带逻辑值得复核（换 1000 宽板会只剩 3 条）。

---

## 作者结论里哪些证据不足

1. **"板不转向"用"没有旋转轴"来证** —— config 里恰好有一条 90° 旋转轴（问题 3），而且板不在
   几何里，姿态矩阵无从谈起。真正能证的只有"几何运动轴是两条 linear、rangeDeg=0"。
2. **"板沿 +Y 平移 1140 到下游"只算了行程与落点，没算通道** —— 落点数字（板 725..1525 在
   660..2050 内）是对的，但通道被 +Y 挡边挡住（问题 1）。作者的注释把板底 905 当成板顶，
   这个符号错误正好掩盖了 6 mm 的干涉。
3. **"干涉 confirmed=0/0/0"被当成"没有干涉"** —— 没有负向对照，也没说明 push 态里板根本不在
   模型里；对 declared 白名单和圆柱 AABB 的局限一字未提。
4. **"PLC blocked=0、四个信号 Q0.0/Q0.1/I0.0/I0.1"被当成"信号进了控制"** —— 预检只查点位
   存在与绑定（`precheck` 在没有 sequence 时只产生 `SEQUENCE_EMPTY` warning，`blocked=0` 是
   必然），不查逻辑引用。要证互锁，得贴出引用 I0.0/I0.1 的那几行 ST —— 现在没有这样的行。
5. **"材质着色两边同源"这条结论对，但证据用错了** —— 截图像素计数（PVC 2801 / AL 43878 /
   STEEL45 22477 / Q235 10585）是渲染、光照、抗锯齿后的像素，只能说明"图上有四种色"，
   证明不了"取值不同"；取值证据是 `machine-geometry.ts:253-258` 的四个 hex 和
   `geometry-export.ts:196-204` 的同一 `part.color`。另外像素数差 4 倍是件数差（23/35/36/18），
   不是色差。
6. **"上行 6 条带一根不断"的断言只覆盖了"长度=5960"** —— 没有覆盖"板宽与带位的关系"和
   "出料口宽度 vs 板长"，而后者才是这条机构真正的边界条件。
