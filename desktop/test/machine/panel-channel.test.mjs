/**
 * M1「首层承托取放」纯函数守卫：承托接触断言 + 通道可行性判定。
 *
 * 这一组测试要钉死的东西（都是上一轮实测里最容易糊掉的四处）：
 * 1. **覆盖率不等于被托住**：A2 侧叉 sweep 全绿而承托 0%，只有承托断言能抓住；
 * 2. **阈值是四条独立条件**，覆盖率/接触带/带 x 重叠/接触 x 重叠不许相互替代（任一不满足就 unsupported）；
 * 3. **接触口径**是「顶面贴板底 ±1 mm」：穿透件不算承托，1.5 mm 间隙也不算；
 * 4. **不可行判定要带数字**：行程 2700 vs 2716.5、净跨 2000 vs 2278、走廊 135 vs 567，
 *    并且 `feasible=false` 必须带 blockers —— 首层 M1 绿不得被读成多层可行。
 *
 * 夹具说明：仓库现成的塔件表是「整块托板 + 320 台面」，不是 M1 机构，因此这里的
 * **件表夹具**（`m1-channel-fixture.mjs`）与纯函数行表都按架构文档 §3 的实测尺寸构造。
 * 实测覆盖率与文档口径的差异（文档 82.5/17 vs 实测 80.6/15.48）在下面的用例里逐条复算，
 * **不改阈值去凑数**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  M1_PICK_PLACE,
  PANEL_SUPPORT_THRESHOLDS,
  PANEL_PART_ID,
  PanelChannelError,
  TOWER_CHANNEL_STROKE,
  checkPanelChannel,
  panelSourceOfGeometry,
  resolveChannelFeasibility,
  resolvePanelSupport,
  supportRowsFromConveyorParts,
  supportRowsFromConveyorPartsDetailed,
  supportRowsFromGeometryParts
} from '../../src/machine/panel-channel.ts';
import { m1ChannelFixture, m1TowerConfig, M1_PANEL } from '../../test-support/m1-channel-fixture.mjs';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../../src/machine/buffer-tower-assembly.ts';

/** 板规格：中心**显式**给（0,0 也算显式；缺省会被拒，见「板位姿必须显式」用例） */
const PANEL = {
  lengthMm: M1_PANEL.lengthMm,
  widthMm: M1_PANEL.widthMm,
  thicknessMm: M1_PANEL.thicknessMm,
  centerXMm: 0,
  centerYMm: 0
};
const panelArea = PANEL.lengthMm * PANEL.widthMm; // 2,583,252 mm²

/**
 * 夹具的板位姿：**从夹具几何里的板件读**（底面 = center[2] − 半厚），不写死 900/0。
 * 这是 P1-1 的修法口径：位姿只能有一个来源，而且必须是显式的。
 */
const poseOf = (fixture) => {
  const part = fixture.geometry.parts.find((candidate) => candidate.id === 'workpiece-plate');
  if (!part) throw new Error('夹具几何里没有 workpiece-plate');
  return {
    bottomZmm: part.center[2] - part.shape.size[2] / 2,
    centerXMm: part.center[0],
    centerYMm: part.center[1]
  };
};

/** 夹具**声明的**轴行程与拾取空行程（carried 位移必须与它同源） */
const axisOf = (fixture) => ({
  strokeMm: fixture.axis.strokeMm,
  pickupGapMm: fixture.axis.partPickupGapMm['workpiece-plate']
});

/** 夹具的 resolveChannelFeasibility 入参：位姿 + 轴全部显式 */
const channelOf = (fixture, extra = {}) => resolveChannelFeasibility({
  config: fixture.config,
  parts: fixture.parts,
  pose: poseOf(fixture),
  axis: axisOf(fixture),
  supportSource: 'fixture',
  ...extra
});

/** 一条承托面行：给顶面 z 与 x-y 范围 */
const row = (id, { x = [-1139, 1139], y = [0, 0], topZ }) => ({
  id,
  minX: x[0],
  maxX: x[1],
  minY: y[0],
  maxY: y[1],
  minZ: topZ - 4,
  maxZ: topZ
});

/** M1 静止位姿的三条分段带（y[-600,-485] / [-375,375] / [485,600]，顶面 900，x 全长 2278） */
const segmentedBelts = () => [
  row('belt-top-l', { y: [-600, -485], topZ: 900 }),
  row('belt-top-m', { y: [-375, 375], topZ: 900 }),
  row('belt-top-r', { y: [485, 600], topZ: 900 })
];

/** M1 抬起位姿的两根叉指（2000×100，y=±430，顶面缺省 910） */
const forkFingers = (fingerWidthMm = 100, topZ = 910, xShiftMm = 0) => [
  row('lift-finger-left', {
    x: [-1000 + xShiftMm, 1000 + xShiftMm],
    y: [-430 - fingerWidthMm / 2, -430 + fingerWidthMm / 2],
    topZ
  }),
  row('lift-finger-right', {
    x: [-1000 + xShiftMm, 1000 + xShiftMm],
    y: [430 - fingerWidthMm / 2, 430 + fingerWidthMm / 2],
    topZ
  })
];

test('阈值常量：四条判据 + 1 mm 接触容差，原样回显在报告里', () => {
  assert.deepEqual(PANEL_SUPPORT_THRESHOLDS, {
    minCoveredPct: 15,
    minBands: 2,
    minBandOverlapXmm: 1900,
    minContactOverlapXmm: 1500,
    contactToleranceMm: 1
  });
  const report = resolvePanelSupport({ parts: segmentedBelts(), panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  assert.deepEqual(report.thresholds, PANEL_SUPPORT_THRESHOLDS, '报告里的阈值必须是同一份常量（不许调用点改写）');
  assert.equal(report.toleranceMm, 1);
  // 高度链常量也回显：890 + 10 = 900（带面），再 +10 = 910（抬起）
  assert.deepEqual(M1_PICK_PLACE, { pickMm: 10, transferMm: 10, segmentMm: 20 });
  assert.deepEqual(TOWER_CHANNEL_STROKE, { trayTopOffsetMm: 6.5, forkHomeClearanceMm: 10 });
});

test('M1 静止：板压在三条分段带上 → 80.6%、3 条带、supported', () => {
  const report = resolvePanelSupport({ parts: segmentedBelts(), panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  // 2278 × (82+750+82) / (2278 × 1134) = 914/1134 = 80.6%（文档写 82.5，按它自己的件宽复算不出 82.5）
  assert.equal(report.coveredPct, 80.6);
  assert.equal(report.coveredAreaMm2, 2278 * 914);
  assert.equal(report.bandsY.length, 3);
  assert.deepEqual(report.bandsY.map((band) => band.widthMm), [82, 750, 82]);
  assert.equal(report.contacts.length, 3);
  assert.deepEqual(report.contacts.map((contact) => contact.partId), ['belt-top-l', 'belt-top-m', 'belt-top-r']);
  assert.equal(report.verdict, 'supported');
  assert.match(report.reasons.join(' '), /覆盖率 80\.6%（阈值 ≥15%）→ 满足/);
});

test('M1 抬起：板在两根 2000×100 叉指上 → 15.48%、2 条带、supported（贴着阈值）', () => {
  const report = resolvePanelSupport({
    parts: forkFingers(),
    panel: PANEL,
    bottomZmm: 910,
    pose: 'carried',
    poseShiftMm: 20
  });
  // 2 × 2000 × 100 / 2583252 = 15.48%（文档写 17.0，与它自己的「2000×100 接触」不符）
  assert.equal(report.coveredPct, 15.48);
  assert.equal(report.coveredAreaMm2, 400000);
  assert.equal(report.bandsY.length, 2);
  assert.deepEqual(report.bandsY.map((band) => band.overlapXmm), [2000, 2000]);
  assert.equal(report.verdict, 'supported');
  assert.equal(report.pose, 'carried');
  assert.equal(report.poseShiftMm, 20);
  // 余量只有 0.48 个百分点：这条阈值抬到 16% 就会把真方案判死
  assert.ok(report.coveredPct - PANEL_SUPPORT_THRESHOLDS.minCoveredPct < 0.5);
});

test('A2 负例：叉指移到板外（y=±622）→ 覆盖 0、contacts 空、unsupported', () => {
  const outside = [
    row('lift-finger-left', { y: [577, 667], topZ: 890 }),
    row('lift-finger-right', { y: [-667, -577], topZ: 890 })
  ];
  const report = resolvePanelSupport({ parts: outside, panel: PANEL, bottomZmm: 890, pose: 'carried', poseShiftMm: 10 });
  assert.equal(report.coveredPct, 0);
  assert.equal(report.coveredAreaMm2, 0);
  assert.deepEqual(report.contacts, []);
  assert.deepEqual(report.bandsY, []);
  assert.equal(report.verdict, 'unsupported');
  assert.match(report.reasons[0] ?? '', /没有任何件的顶面贴在板底 890 ±1 mm 内/);
});

test('单条整带：覆盖 100% 但只有 1 条接触带 → unsupported（覆盖率不能替代支点数）', () => {
  const singleBelt = [row('belt-top', { x: [-1180, 1180], y: [-600, 600], topZ: 900 })];
  const report = resolvePanelSupport({ parts: singleBelt, panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  assert.equal(report.coveredPct, 100);
  assert.equal(report.contacts.length, 1);
  assert.equal(report.bandsY.length, 1);
  assert.equal(report.verdict, 'unsupported');
  assert.match(report.reasons.join(' '), /接触带 1 条（阈值 ≥2）→ 不满足/);
});

test('带 x 重叠不足：两条 1800×140 的承托 → 覆盖 19.51% 仍 unsupported（≥1900 这条要单独判）', () => {
  const shortX = [
    row('fork-left', { x: [-900, 900], y: [-500, -360], topZ: 910 }),
    row('fork-right', { x: [-900, 900], y: [360, 500], topZ: 910 })
  ];
  const report = resolvePanelSupport({ parts: shortX, panel: PANEL, bottomZmm: 910, pose: 'carried' });
  assert.equal(report.coveredPct, 19.51);
  assert.equal(report.bandsY.length, 2);
  assert.deepEqual(report.bandsY.map((band) => band.overlapXmm), [1800, 1800]);
  assert.equal(report.verdict, 'unsupported');
  assert.match(report.reasons.join(' '), /每条带 x 重叠 1800\/1800（阈值 ≥1900）\s*→ 不满足/);
});

test('每条 contact x 不足 1500：一条带由两段 1200 拼成 → 带 2278 过、单件不过 → unsupported', () => {
  const split = [
    row('belt-a', { x: [-1139, -1139 + 1200], y: [-200, 200], topZ: 900 }),
    row('belt-b', { x: [1139 - 1200, 1139], y: [-200, 200], topZ: 900 }),
    // 第二条带，让 ≥2 带这条先过，把判决压到「单件 x」这一条上
    row('belt-c', { x: [-1139, 1139], y: [300, 500], topZ: 900 })
  ];
  const report = resolvePanelSupport({ parts: split, panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  assert.equal(report.bandsY.length, 2, 'y[-200,200] 合成一条带 + y[300,500] 一条带');
  const firstBand = report.bandsY[0];
  assert.equal(firstBand?.overlapXmm, 2278, '同一条带内两段 1200 的 x 并集是 2278');
  assert.equal(report.verdict, 'unsupported');
  assert.match(report.reasons.join(' '), /每个接触 x 重叠/);
  assert.match(report.reasons.join(' '), /不满足/);
});

test('接触容差 ±1 mm：低 0.9 mm 算接触、低 1.5 mm 不算', () => {
  const near = resolvePanelSupport({
    parts: [row('belt-top-m', { y: [-375, 375], topZ: 899.1 })],
    panel: PANEL,
    bottomZmm: 900,
    pose: 'rest-on-level'
  });
  assert.equal(near.contacts.length, 1, '0.9 mm 在 ±1 mm 内');
  const far = resolvePanelSupport({
    parts: [row('belt-top-m', { y: [-375, 375], topZ: 898.5 })],
    panel: PANEL,
    bottomZmm: 900,
    pose: 'rest-on-level'
  });
  assert.equal(far.contacts.length, 0, '1.5 mm 超出 ±1 mm：不许当接触');
  // 穿透同样不算承托：顶面高于板底 2 mm 是「插进板里」，不是托住
  const through = resolvePanelSupport({
    parts: [row('boom', { y: [-375, 375], topZ: 902 })],
    panel: PANEL,
    bottomZmm: 900,
    pose: 'rest-on-level'
  });
  assert.equal(through.contacts.length, 0);
  assert.equal(through.verdict, 'unsupported');
});

test('覆盖率按矩形并集解析计算：重叠接触不重复计面积', () => {
  const doubled = [
    row('belt-a', { y: [-200, 200], topZ: 900 }),
    row('belt-b', { y: [-200, 200], topZ: 900 })
  ];
  const report = resolvePanelSupport({ parts: doubled, panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  assert.equal(report.coveredAreaMm2, 2278 * 400);
  assert.equal(report.coveredPct, 35.27, '两条同位置 2278×400 的并集仍是 2278×400');
  assert.equal(report.contacts.length, 2, 'contacts 逐件列出，但面积不重复计');
});

test('filter 可以按件族排除承托面：排除分段带后板变成无支撑', () => {
  const report = resolvePanelSupport({
    parts: segmentedBelts(),
    panel: PANEL,
    bottomZmm: 900,
    pose: 'rest-on-level',
    filter: (id) => !/^belt-/.test(id)
  });
  assert.equal(report.coveredPct, 0);
  assert.equal(report.verdict, 'unsupported');
  assert.equal(report.supportPartCount, 0);
});

test('空件表不抛错：判 unsupported（0%）而不是「没问题」', () => {
  const report = resolvePanelSupport({ parts: [], panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  assert.equal(report.verdict, 'unsupported');
  assert.equal(report.coveredPct, 0);
  assert.match(report.reasons[0] ?? '', /参与判定 0 件/);
});

test('板缺失/参数不成立一律拒绝（不夹紧、不猜默认值）', () => {
  const bad = (input, pattern) => assert.throws(
    () => resolvePanelSupport(input),
    (error) => error instanceof PanelChannelError
      && error.code === 'INVALID_ARGUMENT'
      && pattern.test(error.message)
  );
  bad({ parts: [], panel: { lengthMm: 0, widthMm: 1134, thicknessMm: 35 }, bottomZmm: 900, pose: 'rest-on-level' }, /panel\.lengthMm 必须大于 0/);
  bad({ parts: [], panel: PANEL, bottomZmm: Number.NaN, pose: 'rest-on-level' }, /bottomZmm 必须是有限数字/);
  bad({ parts: [], panel: {}, bottomZmm: 900, pose: 'rest-on-level' }, /panel\.lengthMm 必须是有限数字/);
  bad({ parts: [{ id: 1 }], panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' }, /每一行都必须有 string 类型的 id/);
});

test('行程不变量：声明 2700 vs 需要 2716.5，缺口 16.5（公式带两个偏置）', () => {
  const feasibility = channelOf(m1ChannelFixture());
  assert.equal(feasibility.stroke.declaredMm, 2700);
  assert.equal(feasibility.stroke.requiredMm, 2716.5);
  assert.equal(feasibility.stroke.shortfallMm, 16.5);
  assert.match(feasibility.stroke.formula, /trayTopOffset\(6\.5\)/);
  assert.match(feasibility.stroke.formula, /forkHomeClearance\(10\)/);
  assert.match(feasibility.stroke.formula, /= 2716\.5/);
  // 口径必须写明是 M1 叉指停位，否则会被读成「现轴缺 16.5」
  assert.match(feasibility.stroke.caliber, /M1 叉指停位/);
  assert.match(feasibility.stroke.caliber, /890/);
  const stroke = feasibility.blockers.find((blocker) => blocker.reason === 'stroke-shortfall');
  assert.match(stroke?.detail ?? '', /M1 叉指停位/);
  assert.match(stroke?.detail ?? '', /不得读成现轴缺陷/);
});

test('跨距与走廊：数值照算，但只进 designNotes，不进 blockers（y 向实测不重叠）', () => {
  const feasibility = channelOf(m1ChannelFixture());
  const { clearSpan, corridor } = feasibility;
  assert.equal(clearSpan.xClearMm, 2000, '外侧面口径（架构文档口径）');
  assert.equal(clearSpan.requiredMm, 2278);
  assert.equal(clearSpan.shortfallMm, 278);
  assert.equal(clearSpan.xClearInnerMm, 1840, '真正的净跨（立柱内侧面之间）');
  assert.equal(clearSpan.shortfallInnerMm, 438);
  assert.equal(corridor.corridorMm, 135);
  assert.equal(corridor.halfWidthMm, 567);
  assert.equal(corridor.shortfallMm, 432);
  // 关键：这两条**不是** blocker（审查实测板与柱 AABB 不相交）
  const blockerReasons = feasibility.blockers.map((blocker) => blocker.reason);
  assert.equal(blockerReasons.includes('clear-span'), false);
  assert.equal(blockerReasons.includes('corridor-too-narrow'), false);
  assert.deepEqual(feasibility.designNotes.map((note) => note.reason), ['clear-span-conservative', 'corridor-conservative']);
  const clearNote = feasibility.designNotes[0];
  assert.equal(clearNote?.measuredMm, 2000);
  assert.equal(clearNote?.marginMm, -278);
  assert.match(clearNote?.detail ?? '', /保守设计余量/);
  assert.match(clearNote?.detail ?? '', /AABB 没有证明板与柱体相交/);
  assert.doesNotMatch(clearNote?.detail ?? '', /任何整板(都)?过不去/);
});

test('立柱与板体 AABB 实测不相交：y 向重叠 0、行程内 0 件相交', () => {
  const feasibility = channelOf(m1ChannelFixture());
  assert.deepEqual(feasibility.columnSweep.columnPartIds, ['column-fl', 'column-fr', 'column-bl', 'column-br']);
  assert.equal(feasibility.columnSweep.yOverlapMm, 0, '板 y 半宽 567 < 柱内侧面 675');
  assert.equal(feasibility.columnSweep.xOverlapMm, 80, 'x 向只有柱截面宽度重叠');
  assert.deepEqual(feasibility.columnSweep.intersectingPartIds, [], '板从两排立柱之间通过');
  assert.match(feasibility.columnSweep.note, /不是已证明的阻塞/);
  // 回执文案里不许再出现「任何整板都过不去」
  assert.doesNotMatch(feasibility.note, /任何整板(都)?过不去/);
  assert.match(feasibility.note, /需结构确认/);
});

test('通道判定：feasible=false 且两条可复算 blockers；首层 M1 段单独为真', () => {
  const feasibility = channelOf(m1ChannelFixture());
  assert.equal(feasibility.ok, true);
  assert.equal(feasibility.diagnosticOnly, false);
  assert.equal(feasibility.feasible, false);
  assert.deepEqual(feasibility.blockers.map((blocker) => blocker.reason), ['load-passes-shelf', 'stroke-shortfall']);
  const shelf = feasibility.blockers[0];
  assert.equal(shelf?.level, 2, '第一处挡路的是第 2 层承托面');
  assert.ok((shelf?.partIds.length ?? 0) > 0 && (shelf?.partIds.length ?? 0) <= 6);
  assert.match(shelf?.detail ?? '', /必穿过它/);
  // 件数从件表派生，不许写死「2 层 26 处」这类快照
  assert.doesNotMatch(shelf?.detail ?? '', /26 处/);
  assert.match(shelf?.detail ?? '', /本件表在板投影内、板顶以上的承托面共 \d+ 件/);
  // 首层 M1 段（夹具件表）是绿的，但它是**独立**结论，且带来源标注
  assert.equal(feasibility.m1.feasible, true);
  assert.equal(feasibility.m1.restSupported, true);
  assert.equal(feasibility.m1.carriedSupported, true);
  assert.equal(feasibility.m1.carriedShiftSource, 'axis', '位移来自几何轴，不是常量 20');
  assert.equal(feasibility.m1.pickupGapSource, 'axis');
  assert.equal(feasibility.m1.boardLiftMm, 10);
  assert.equal(feasibility.m1.diagnosticError, null);
  assert.equal(feasibility.panelSupport.rest.claim, 'supported');
  assert.equal(feasibility.panelSupport.rest.supportSource, 'fixture');
  assert.equal(feasibility.panelSupport.carried.claim, 'supported');
  assert.match(feasibility.note, /不得读成「多层可行」/);
});

test('2 层塔同样不可行：行程缺口仍是 16.5、blockers 仍有 load-passes-shelf', () => {
  const fixture = m1ChannelFixture({ levels: 2 });
  const feasibility = channelOf(fixture);
  assert.equal(feasibility.stroke.declaredMm, 180);
  assert.equal(feasibility.stroke.requiredMm, 196.5);
  assert.equal(feasibility.stroke.shortfallMm, 16.5);
  assert.equal(feasibility.feasible, false);
  assert.ok(feasibility.blockers.some((blocker) => blocker.reason === 'load-passes-shelf'),
    '连「从第 1 层抬到第 2 层」这一步都要穿过第 2 层托板');
});

test('非塔机型拒绝：通道判定不从 formId/conveyor 猜', () => {
  assert.throws(
    () => resolveChannelFeasibility({
      config: { conveyor: { lengthMm: 2400, widthMm: 1200 } },
      pose: { bottomZmm: 900, centerXMm: 0, centerYMm: 0 }
    }),
    (error) => error instanceof PanelChannelError && error.code === 'NOT_A_TOWER' && /kind 不是 tower/.test(error.message)
  );
});

test('板位姿必须显式：缺 pose / 缺板中心 → INVALID_ARGUMENT（不默认 900、不默认 (0,0)）', () => {
  const fixture = m1ChannelFixture();
  // 缺 pose 整体
  assert.throws(
    () => resolveChannelFeasibility({ config: fixture.config, parts: fixture.parts }),
    (error) => error instanceof PanelChannelError && error.code === 'INVALID_ARGUMENT' && /pose 必填/.test(error.message)
  );
  // pose 缺 bottomZmm
  assert.throws(
    () => resolveChannelFeasibility({
      config: fixture.config, parts: fixture.parts, pose: { centerXMm: 0, centerYMm: 0 }
    }),
    (error) => error instanceof PanelChannelError && /pose\.bottomZmm 必须是有限数字/.test(error.message)
  );
  // pose 缺中心
  assert.throws(
    () => resolveChannelFeasibility({ config: fixture.config, parts: fixture.parts, pose: { bottomZmm: 900 } }),
    (error) => error instanceof PanelChannelError && /pose\.centerXMm 必须是有限数字/.test(error.message)
  );
  // panel 自带中心与 pose 冲突 → 拒绝（不许静默择优）
  assert.throws(
    () => resolveChannelFeasibility({
      config: fixture.config,
      parts: fixture.parts,
      panel: { ...PANEL, centerXMm: 500 },
      pose: { bottomZmm: 900, centerXMm: 0, centerYMm: 0 }
    }),
    (error) => error instanceof PanelChannelError && /冲突/.test(error.message)
  );
  // resolvePanelSupport 同样不许「中心缺省 0」
  assert.throws(
    () => resolvePanelSupport({
      parts: segmentedBelts(),
      panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35 },
      bottomZmm: 900,
      pose: 'rest-on-level'
    }),
    (error) => error instanceof PanelChannelError && /panel\.centerXMm/.test(error.message)
  );
});

test('P1-1 反例：占位体底面 1000（板悬空 100）→ 不 supported；板中心偏移 → 覆盖率跟着变', () => {
  // 板悬空 100 mm：没有任何件顶面在 1000±1，旧实现会照样回 80.6% supported
  const lifted = channelOf(m1ChannelFixture(), { pose: { bottomZmm: 1000, centerXMm: 0, centerYMm: 0 } });
  assert.equal(lifted.panelSupport.rest.coveredPct, 0);
  assert.equal(lifted.panelSupport.rest.verdict, 'unsupported');
  assert.equal(lifted.m1.feasible, false);
  assert.equal(lifted.panelSupport.rest.panelBottomZmm, 1000, '位姿原样回显，不许被 900 顶替');

  // 中心偏移必须改变覆盖率（旧实现里 centerXMm 形同虚设，覆盖率一字不变）
  const centered = resolvePanelSupport({ parts: segmentedBelts(), panel: PANEL, bottomZmm: 900, pose: 'rest-on-level' });
  const offCenter = resolvePanelSupport({
    parts: segmentedBelts(),
    panel: { ...PANEL, centerXMm: 300 },
    bottomZmm: 900,
    pose: 'rest-on-level'
  });
  assert.equal(offCenter.panelCenterMm.xMm, 300, '中心必须原样回显');
  // 板 x[300±1139]=[-839,1439]，带 x[-1139,1139] → 交 1978；1978×914/2583252 = 69.99%
  assert.equal(offCenter.coveredAreaMm2, 1978 * 914);
  assert.equal(offCenter.coveredPct, 69.99);
  assert.equal(centered.coveredPct, 80.6);
  assert.notEqual(offCenter.coveredPct, centered.coveredPct, '中心偏移必须改变覆盖率');
  // 夹具件表同样跟着变（80.6 → 72.22；端部滚筒顶面也在 900，因此带会并成一条）
  const fixtureCentered = channelOf(m1ChannelFixture());
  const fixtureShifted = channelOf(m1ChannelFixture(), { pose: { bottomZmm: 900, centerXMm: 300, centerYMm: 0 } });
  assert.equal(fixtureShifted.pose.centerXMm, 300);
  assert.notEqual(fixtureShifted.panelSupport.rest.coveredPct, fixtureCentered.panelSupport.rest.coveredPct);
});

test('P1-2 反例：轴位移 5 mm < 空行程 10 → carried 底面仍是 900、不可判 supported、m1.feasible=false', () => {
  const fixture = m1ChannelFixture();
  const feasibility = channelOf(fixture, { carriedShiftMm: 5, pickupGapMm: 10 });
  assert.equal(feasibility.m1.carriedShiftMm, 5, '报告里必须是 5，不是常量 20');
  assert.equal(feasibility.m1.carriedShiftSource, 'input');
  assert.equal(feasibility.m1.boardLiftMm, 0, '5 − 10 → 板没离地');
  assert.equal(feasibility.panelSupport.carried.panelBottomZmm, 900, 'carried 底面不许仍是 910');
  assert.equal(feasibility.panelSupport.carried.claim, 'diagnostic-only', '位移不足时这一态不是承托证据');
  assert.equal(feasibility.m1.carriedSupported, false);
  assert.equal(feasibility.m1.feasible, false);
  assert.match(feasibility.m1.diagnosticError ?? '', /不大于拾取空行程/);
  // 与 interference-states 的口径一致：位移 5 时板底仍 900（先走空行程）
  assert.equal(feasibility.pickPlace.panelBottomZmm.lifted, 900);
});

test('P1-2：缺位移（无 input/无轴）→ 不伪造 supported；有轴时按轴行程算', () => {
  const fixture = m1ChannelFixture();
  const noShift = resolveChannelFeasibility({
    config: fixture.config, parts: fixture.parts, pose: poseOf(fixture)
  });
  assert.equal(noShift.m1.carriedShiftSource, 'missing');
  assert.equal(noShift.m1.carriedShiftMm, 0);
  assert.equal(noShift.m1.feasible, false);
  assert.equal(noShift.panelSupport.carried.claim, 'diagnostic-only');
  assert.match(noShift.m1.diagnosticError ?? '', /缺失/);
  // 给了轴就按轴：20 → 板抬 10
  assert.equal(noShift.pickPlace.panelBottomZmm.rest, 900);
});

test('checkPanelChannel：几何里没有板 → INVALID_ARGUMENT（不做「空输入绿」）', () => {
  const fixture = m1ChannelFixture({ withPanel: false });
  const outcome = checkPanelChannel({ config: fixture.config, geometry: fixture.geometry });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'INVALID_ARGUMENT');
  assert.match(outcome.message, /没有板的位姿/);
  assert.match(outcome.hint ?? '', /几何里没有可识别的板占位体/);
  // 同一份几何的机构件三态是干净的 —— 这正是「绿」不能替代承托断言的理由
  assert.equal(panelSourceOfGeometry(fixture.geometry), null);
});

test('checkPanelChannel：M1 几何 → verified，承托带来源 + 多层不可行同时回执', () => {
  const fixture = m1ChannelFixture();
  const outcome = checkPanelChannel({ config: fixture.config, geometry: fixture.geometry });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, 'verified');
  assert.equal(outcome.rowsSource, 'geometry');
  assert.equal(outcome.panelSource.id, PANEL_PART_ID);
  assert.equal(outcome.panelSource.inCollisionSet, true, 'M1 夹具的板在碰撞件表里（sweep 真的扫它）');
  // 位姿从几何读，不回落到 beltHeight
  assert.deepEqual(
    { z: outcome.pose.bottomZmm, x: outcome.pose.centerXMm, y: outcome.pose.centerYMm },
    { z: 900, x: 0, y: 0 }
  );
  assert.match(outcome.pose.source, /geometry\.parts/);
  assert.equal(outcome.panelSupport.rest.verdict, 'supported');
  assert.equal(outcome.panelSupport.rest.claim, 'supported');
  assert.equal(outcome.panelSupport.rest.supportSource, 'geometry');
  assert.equal(outcome.panelSupport.rest.coveredPct, 80.6);
  assert.equal(outcome.panelSupport.carried.verdict, 'supported');
  assert.equal(outcome.panelSupport.carried.coveredPct, 15.48);
  assert.equal(outcome.feasibility.m1.feasible, true);
  assert.equal(outcome.feasibility.m1.carriedShiftSource, 'axis', '位移来自几何轴（20）');
  assert.equal(outcome.feasibility.feasible, false);
});

test('checkPanelChannel：生产塔（板已在 parts）→ verified，但 rest unsupported、carried 诊断', () => {
  const fixture = m1ChannelFixture();
  const resolved = resolveMachineGeometry(fixture.config);
  const outcome = checkPanelChannel({ config: fixture.config, geometry: resolved.geometry });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // 生产塔：板是 geometry.parts 里的真实碰撞件 → verified 只说明「几何行表 + 板在碰撞集」
  assert.equal(outcome.panelSource.inCollisionSet, true);
  assert.equal(outcome.mode, 'verified');
  assert.equal(outcome.rowsSource, 'geometry');
  assert.match(outcome.pose.source, /workpiecePlaceholder/);
  assert.equal(outcome.panelSupport.rest.claim, 'unsupported', '覆盖 100% 但只有 1 条带 → 不许声称 supported');
  assert.equal(outcome.panelSupport.carried.claim, 'diagnostic-only', '板不随塔轴移动 → 位移缺失，carried 只能是诊断');
  assert.equal(outcome.feasibility.diagnosticOnly, false);
  assert.equal(outcome.feasibility.feasible, false, 'verified 不等于可行：load-passes-shelf + stroke-shortfall 仍在');
  assert.equal(outcome.feasibility.m1.feasible, false, '板没挂轴、也没有叉指 → 首层 M1 段不成立');
  assert.equal(outcome.feasibility.m1.carriedShiftSource, 'missing', '不许把塔轴 2700 当成板的位移');
  assert.match(outcome.feasibility.m1.diagnosticError ?? '', /缺失/);
  assert.match(outcome.note, /verified/);
  assert.match(outcome.note, /不是结构可行/);
  // 夹具的 M1 绿不许被读成生产塔可行：这条回执里没有任何 supported claim
  assert.equal(outcome.feasibility.panelSupport.rest.claim === 'supported', false);
  assert.equal(outcome.feasibility.panelSupport.carried.claim === 'supported', false);
});

test('checkPanelChannel：caller rows 一律 diagnostic-only，连 pose 也不许把它升级', () => {
  const fixture = m1ChannelFixture();
  const resolved = resolveMachineGeometry(fixture.config);
  const rows = supportRowsFromConveyorParts(fixture.parts);
  const outcome = checkPanelChannel({
    config: fixture.config,
    geometry: resolved.geometry,
    rows,
    pose: poseOf(fixture)
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // P1-R2：行表来源不是几何 → held-out 承托面证明不了属于本机，哪怕给了 pose 也只能是诊断
  assert.equal(outcome.mode, 'diagnostic-only');
  assert.equal(outcome.rowsSource, 'caller');
  // 板确实在碰撞集里（生产几何），但行表不是几何给的 → 仍 diagnostic-only：两条证据缺一不可
  assert.equal(outcome.panelSource.inCollisionSet, true);
  assert.equal(outcome.panelSupport.rest.claim, 'diagnostic-only');
  assert.equal(outcome.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(outcome.feasibility.diagnosticOnly, true);
  assert.equal(outcome.feasibility.feasible, false);
  assert.equal(outcome.feasibility.m1.feasible, false, 'm1 不许基于 caller rows 成立');
  assert.match(outcome.note, /caller-rows/);
  // 同一份夹具几何（板**在**碰撞件表里）走 geometry 行表才是 verified —— 差别只在行表来源
  const verified = checkPanelChannel({ config: fixture.config, geometry: fixture.geometry });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.mode, 'verified');
  assert.equal(verified.rowsSource, 'geometry');
  assert.equal(verified.panelSupport.rest.claim, 'supported');
  // 但夹具几何 + caller rows 同样退回诊断：verified 只认几何行表
  const callerOnFixture = checkPanelChannel({
    config: fixture.config,
    geometry: fixture.geometry,
    rows,
    pose: poseOf(fixture)
  });
  assert.equal(callerOnFixture.ok, true);
  if (!callerOnFixture.ok) return;
  assert.equal(callerOnFixture.mode, 'diagnostic-only');
  assert.equal(callerOnFixture.panelSupport.rest.claim, 'diagnostic-only');
});

test('shift fail-closed：显式位移超出轴自述行程 → INVALID_ARGUMENT（不再照收 100）', () => {
  const fixture = m1ChannelFixture();
  const rejects = (shift) => assert.throws(
    () => channelOf(fixture, { carriedShiftMm: shift }),
    (error) => error instanceof PanelChannelError
      && error.code === 'INVALID_ARGUMENT'
      && /超出轴自述行程/.test(error.message)
  );
  // P1-R1 的原始反例：轴声明 20、调用方给 100 → 旧实现报 carried.supported + m1.feasible=true
  rejects(100);
  // 边界也要拦：21 只超 1 mm，不许「差一点就放过」
  rejects(21);
  // 负值不是位移证据
  assert.throws(
    () => channelOf(fixture, { carriedShiftMm: -5 }),
    (error) => error instanceof PanelChannelError && /为负/.test(error.message)
  );
  // 行程内的位移照常算（20 − 10 = 板抬 10）
  assert.equal(channelOf(fixture, { carriedShiftMm: 20 }).m1.boardLiftMm, 10);
});

test('shift fail-closed：几何里没有 axis.strokeMm 时，显式位移只作诊断', () => {
  const fixture = m1ChannelFixture();
  const feasibility = resolveChannelFeasibility({
    config: fixture.config,
    parts: fixture.parts,
    pose: poseOf(fixture),
    carriedShiftMm: 20,
    pickupGapMm: 10,
    supportSource: 'fixture'
  });
  assert.equal(feasibility.m1.carriedShiftSource, 'input');
  assert.equal(feasibility.m1.carriedShiftMm, 20);
  assert.equal(feasibility.panelSupport.carried.claim, 'diagnostic-only', '没有轴的位移声明 → 不是证据');
  assert.equal(feasibility.m1.carriedSupported, false);
  assert.equal(feasibility.m1.feasible, false);
  assert.match(feasibility.m1.diagnosticError ?? '', /没有 strokeMm/);
  // rest 这一态仍可成立（本条只否掉 carried 的证据资格）
  assert.equal(feasibility.panelSupport.rest.claim, 'supported');
});

test('shift fail-closed：空行程只能靠 M1 缺省值时，显式位移同样只作诊断', () => {
  const fixture = m1ChannelFixture();
  const feasibility = resolveChannelFeasibility({
    config: fixture.config,
    parts: fixture.parts,
    pose: poseOf(fixture),
    axis: { strokeMm: 20 }, // 有行程，但没有 partPickupGapMm
    carriedShiftMm: 20,
    supportSource: 'fixture'
  });
  assert.equal(feasibility.m1.pickupGapSource, 'm1-default');
  assert.equal(feasibility.m1.boardLiftMm, 10, '板抬量仍在（但不能当证据）');
  assert.equal(feasibility.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(feasibility.m1.carriedSupported, false);
  assert.equal(feasibility.m1.feasible, false);
  assert.match(feasibility.m1.diagnosticError ?? '', /M1 缺省值/);
});

test('panelSourceOfGeometry：占位体中心缺失 → 不认这块板（不拿 0 顶替）', () => {
  const base = {
    id: PANEL_PART_ID,
    name: '占位',
    role: 'workpiece',
    sizeMm: [2278, 1134, 35],
    bottomZmm: 900,
    inCollisionSet: false
  };
  assert.equal(panelSourceOfGeometry({ parts: [], workpiecePlaceholder: base }), null);
  const source = panelSourceOfGeometry({
    parts: [],
    workpiecePlaceholder: { ...base, center: [0, 0, 917.5] }
  });
  assert.equal(source?.inCollisionSet, false);
  assert.equal(source?.bottomZmm, 900);
  assert.equal(source?.centerXMm, 0);
  assert.deepEqual(source?.panel, { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, centerXMm: 0, centerYMm: 0 });
  assert.match(source?.poseSource ?? '', /workpiecePlaceholder/);
});

test('panelSourceOfGeometry：inCollisionSet 只按 parts 里「同一块板」派生（手写 true 不算）', () => {
  const base = {
    id: PANEL_PART_ID,
    name: '占位',
    role: 'workpiece',
    sizeMm: [2278, 1134, 35],
    bottomZmm: 900,
    center: [0, 0, 917.5],
    inCollisionSet: true
  };
  // 只有占位体（哪怕自己写 true）→ parts 里没有同 id 件 → false
  assert.equal(panelSourceOfGeometry({ parts: [], workpiecePlaceholder: base })?.inCollisionSet, false);
  const plate = {
    id: PANEL_PART_ID,
    role: 'workpiece',
    shape: { type: 'box', size: [2278, 1134, 35] },
    center: [0, 0, 917.5],
    rotationZDeg: 0
  };
  // parts 里有同一块板（同 id + role=workpiece + 尺寸/中心一致）→ true
  const withPart = panelSourceOfGeometry({ parts: [plate], workpiecePlaceholder: base });
  assert.equal(withPart?.inCollisionSet, true);
  assert.equal(withPart?.id, PANEL_PART_ID);
  // 别的工件（不同 id）不能把占位体「顶」成 true
  assert.equal(
    panelSourceOfGeometry({ parts: [{ ...plate, id: 'workpiece-other' }], workpiecePlaceholder: base })?.inCollisionSet,
    false,
    'inCollisionSet 只认同 id 成员，不许被别的 role=workpiece 件顶成 true'
  );
});

test('P2-1 回归：同 id 但不是这块板（role/尺寸/中心不符）→ inCollisionSet=false', () => {
  const placeholder = {
    id: PANEL_PART_ID,
    name: '占位',
    role: 'workpiece',
    sizeMm: [2278, 1134, 35],
    bottomZmm: 900,
    center: [0, 0, 917.5],
    inCollisionSet: true
  };
  // 生产塔里的第 2 层托板：同 id 场景下它就是「同 id 非板件」
  const tray = {
    id: 'tray-2',
    role: 'structure',
    shape: { type: 'box', size: [1200, 900, 20] },
    center: [0, 0, 1060],
    rotationZDeg: 0
  };
  // ① 占位体 id 被写成 tray-2，parts 里真有同 id 托板 → false（旧实现只比 id，会回 true）
  const forged = { ...placeholder, id: 'tray-2' };
  const forgedSource = panelSourceOfGeometry({ parts: [tray], workpiecePlaceholder: forged });
  assert.equal(forgedSource?.inCollisionSet, false, '同 id 托板不是这块板，flag 不许被顶成 true');
  // 位姿仍来自板占位体（占位体没变）—— 所以 flag 一旦假 true，「位姿是板、碰撞集判定靠托板」
  assert.equal(forgedSource?.bottomZmm, 900);
  assert.equal(forgedSource?.panel.lengthMm, 2278);
  // ② 同 id、同尺寸，但 role 不是 workpiece（结构件/夹具件）→ false
  const correctSizeWrongRole = { ...tray, id: PANEL_PART_ID, shape: { type: 'box', size: [2278, 1134, 35] }, center: [0, 0, 917.5] };
  assert.equal(
    panelSourceOfGeometry({ parts: [correctSizeWrongRole], workpiecePlaceholder: placeholder })?.inCollisionSet,
    false,
    'role 不是 workpiece 的同 id 件不算板'
  );
  // ③ role/ id 都对但尺寸不符（这块托板 1200×900×20）→ false
  const correctRoleWrongSize = { ...correctSizeWrongRole, role: 'workpiece', shape: { type: 'box', size: [1200, 900, 20] } };
  assert.equal(
    panelSourceOfGeometry({ parts: [correctRoleWrongSize], workpiecePlaceholder: placeholder })?.inCollisionSet,
    false,
    '尺寸与占位体不一致 → 不是这块板'
  );
  // ④ 尺寸对但中心偏 200 mm → false
  const correctRoleWrongCenter = { ...correctSizeWrongRole, role: 'workpiece', center: [200, 0, 917.5] };
  assert.equal(
    panelSourceOfGeometry({ parts: [correctRoleWrongCenter], workpiecePlaceholder: placeholder })?.inCollisionSet,
    false,
    '中心与占位体不一致 → 不是这块板'
  );
  // ⑤ shape 不是 box（圆柱/无 shape）→ false
  assert.equal(
    panelSourceOfGeometry({
      parts: [{ ...correctSizeWrongRole, role: 'workpiece', shape: { type: 'cylinder', radius: 500, length: 35, axis: 'z' } }],
      workpiecePlaceholder: placeholder
    })?.inCollisionSet,
    false
  );
  // ⑥ 四条全对 → true（这条同时保证上面的 false 不是「一律 false」）
  const exact = { ...correctSizeWrongRole, role: 'workpiece' };
  assert.equal(panelSourceOfGeometry({ parts: [exact], workpiecePlaceholder: placeholder })?.inCollisionSet, true);
});

test('P2-1 回归（生产几何）：占位体 id 指向真实托板 → diagnostic-only，不升 verified', () => {
  const config = m1TowerConfig(16);
  const resolved = resolveMachineGeometry(config);
  // 让占位体自称是 tray-2（parts 里确实有 tray-2），位姿仍是板占位体的
  const forged = {
    ...resolved.geometry,
    workpiecePlaceholder: { ...resolved.geometry.workpiecePlaceholder, id: 'tray-2' }
  };
  const source = panelSourceOfGeometry(forged);
  assert.equal(source?.id, 'tray-2');
  assert.equal(source?.inCollisionSet, false, '同 id 的托板不是板：inCollisionSet 必须 false');
  const outcome = checkPanelChannel({ config, geometry: forged });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, 'diagnostic-only');
  assert.equal(outcome.panelSource.inCollisionSet, false);
  assert.equal(outcome.feasibility.diagnosticOnly, true);
  assert.equal(outcome.feasibility.feasible, false);
  // 同一份几何、占位体 id 正确时仍是 verified —— 差别只在这块板是否真的在碰撞件表里
  const genuine = checkPanelChannel({ config, geometry: resolved.geometry });
  assert.equal(genuine.ok, true);
  if (!genuine.ok) return;
  assert.equal(genuine.mode, 'verified');
  assert.equal(genuine.panelSource.inCollisionSet, true);
});

test('P3-1 回归：同 id/role/尺寸/中心都对但朝向不对（转 90°）→ inCollisionSet=false', () => {
  // 占位体是**同一件板的投影**：它声明的 rotationZDeg 就是这块板应有的朝向（生产塔 0°）
  const placeholder = {
    id: PANEL_PART_ID,
    name: '占位',
    role: 'workpiece',
    rotationZDeg: 0,
    sizeMm: [2278, 1134, 35],
    bottomZmm: 900,
    center: [0, 0, 917.5],
    inCollisionSet: true
  };
  const plate = {
    id: PANEL_PART_ID,
    role: 'workpiece',
    shape: { type: 'box', size: [2278, 1134, 35] },
    center: [0, 0, 917.5],
    rotationZDeg: 0
  };
  const inSet = (parts, holder = placeholder) => panelSourceOfGeometry({ parts, workpiecePlaceholder: holder })?.inCollisionSet;

  // ⓪ 精确副本（含 0°）→ true：保证下面那些 false 不是「一律 false」
  assert.equal(inSet([plate]), true, '同 id + role + 尺寸/中心 + 0° 的精确副本才是这块板');

  // ① 同中心、同尺寸、绕 Z 转 90°：局部 size 逐项相等（旧四条判据全过），但实际占位 x/y 互换
  //    （2278×1134 → 1134×2278），是另一个刚体位姿 —— 不许冒充 collisionset 里的板
  for (const rotationZDeg of [90, -90, 180, 45, 0.5]) {
    assert.equal(
      inSet([{ ...plate, rotationZDeg }]),
      false,
      `rotationZDeg=${rotationZDeg}° 的件不是这块板（同中心同尺寸也不行）`
    );
  }

  // ② 转角必须是**有限数字**：缺字段 / NaN / Infinity / 字符串 / null 都不算（不拿 0 顶替，
  //    否则 `Number(null) === 0` 会把「没声明朝向」读成 0° 并放行）
  for (const rotationZDeg of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '0', null]) {
    assert.equal(
      inSet([{ ...plate, rotationZDeg }]),
      false,
      `rotationZDeg=${String(rotationZDeg)} 不是有限数 → 无法核对朝向，不是这块板`
    );
  }

  // ③ 周期量等价：绕 Z 的 360° ≡ 0°、−360° ≡ 0°，不许因为原始数值不同把真板判掉
  assert.equal(inSet([{ ...plate, rotationZDeg: 360 }]), true, '360° 与 0° 同向');
  assert.equal(inSet([{ ...plate, rotationZDeg: -360 }]), true, '-360° 与 0° 同向');

  // ④ 比对对象是**占位体声明的朝向**，不是写死的 0：占位体声明 90° 时，90° 的件才是这块板
  const turned = { ...placeholder, rotationZDeg: 90 };
  assert.equal(inSet([{ ...plate, rotationZDeg: 90 }], turned), true, '占位体声明 90° + 件也 90° → true');
  assert.equal(inSet([plate], turned), false, '占位体声明 90° + 件仍 0° → false');

  // ⑤ 占位体自己的 rotationZDeg 不是有限数 → 没有可核对的板朝向，不认这块板（返回 null，不猜 0°）
  for (const rotationZDeg of [Number.NaN, Number.POSITIVE_INFINITY, '0', null]) {
    assert.equal(
      panelSourceOfGeometry({ parts: [plate], workpiecePlaceholder: { ...placeholder, rotationZDeg } }),
      null,
      `占位体 rotationZDeg=${String(rotationZDeg)} 不是有限数 → 不认这块板`
    );
  }
});

test('P3-1 回归（生产几何）：同中心同尺寸但转 90° 的板件 → inCollisionSet=false、diagnostic-only', () => {
  const config = m1TowerConfig(16);
  const resolved = resolveMachineGeometry(config);
  // 生产塔的板就是 0°（`towerWorkpiecePart`）：这条钉住「生产板要求 0°」，不是随便什么朝向
  assert.equal(resolved.geometry.workpiecePlaceholder?.rotationZDeg, 0, '生产占位体显式投影 rotationZDeg=0');
  const genuinePart = resolved.geometry.parts.find((part) => part.id === PANEL_PART_ID);
  assert.equal(genuinePart?.rotationZDeg, 0, '生产板件本身也是 0°');

  const rotated = {
    ...resolved.geometry,
    parts: resolved.geometry.parts.map((part) => (
      part.id === PANEL_PART_ID ? { ...part, rotationZDeg: 90 } : part
    ))
  };
  const source = panelSourceOfGeometry(rotated);
  assert.equal(source?.inCollisionSet, false, '同中心同尺寸但绕 Z 转 90° 的件不是这块板');
  // 位姿仍从占位体读（占位体没被改），所以这里正是「位姿是板、碰撞集判定被别的朝向顶掉」的形状
  assert.equal(source?.bottomZmm, 900);
  assert.equal(source?.panel.lengthMm, 2278);

  const outcome = checkPanelChannel({ config, geometry: rotated });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, 'diagnostic-only');
  assert.equal(outcome.feasibility.diagnosticOnly, true);
  assert.equal(outcome.feasibility.feasible, false);

  // 对照：同一份几何，板件朝向 0°（不改）→ 仍 verified
  const genuine = checkPanelChannel({ config, geometry: resolved.geometry });
  assert.equal(genuine.ok, true);
  if (!genuine.ok) return;
  assert.equal(genuine.mode, 'verified');
  assert.equal(genuine.panelSource.inCollisionSet, true);
});

test('panelSourceOfGeometry：center/size 里的 null、空串、数字字符串一律不认（不拿 0 顶替）', () => {
  const base = {
    id: PANEL_PART_ID,
    name: '占位',
    role: 'workpiece',
    sizeMm: [2278, 1134, 35],
    bottomZmm: 900,
    inCollisionSet: false
  };
  for (const center of [[null, null, 917.5], [0, '', 917.5], ['0', '0', 917.5], [0, Number.NaN, 917.5]]) {
    assert.equal(
      panelSourceOfGeometry({ parts: [], workpiecePlaceholder: { ...base, center } }),
      null,
      `center=${JSON.stringify(center)} 不是三个数 → 不认这块板（更不许读成 (0,0)）`
    );
  }
  assert.equal(
    panelSourceOfGeometry({ parts: [], workpiecePlaceholder: { ...base, center: [0, 0, 917.5], sizeMm: [2278, 1134, '35'] } }),
    null,
    'size 里的字符串不是数字'
  );
  assert.equal(
    panelSourceOfGeometry({ parts: [], workpiecePlaceholder: { ...base, center: [0, 0, 917.5], bottomZmm: '900' } }),
    null,
    'bottomZmm 必须是数字（字符串 900 不认）'
  );
  // 严格数字照常认：底面 = center[2] − 半厚
  const ok = panelSourceOfGeometry({ parts: [], workpiecePlaceholder: { ...base, bottomZmm: undefined, center: [0, 0, 917.5] } });
  assert.equal(ok?.bottomZmm, 900);
  assert.equal(ok?.centerXMm, 0);
});

test('支撑面适配器：GeomPart 行表与 ConveyorPart 行表对同一件表给出同一组盒', () => {
  const fixture = m1ChannelFixture();
  const fromParts = supportRowsFromConveyorParts(fixture.parts);
  const fromGeometry = supportRowsFromGeometryParts(fixture.geometry.parts.filter((part) => part.id !== PANEL_PART_ID));
  const byId = new Map(fromGeometry.map((entry) => [entry.id, entry]));
  assert.equal(fromParts.length, fromGeometry.length);
  for (const entry of fromParts) {
    const other = byId.get(entry.id);
    assert.ok(other, `几何里缺件 ${entry.id}`);
    for (const key of ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ']) {
      assert.ok(Math.abs((other?.[key] ?? 0) - (entry[key] ?? 0)) < 0.02, `${entry.id}.${key}: ${entry[key]} vs ${other?.[key]}`);
    }
  }
  assert.ok(Math.abs(panelArea - 2583252) < 1);
});

/* ------------------------------------------------------------------ *
 * witness：口径来源（P2-2）、量到遮挡件 minZ（P2-4）、非有限坐标 fail-closed（P2-3）
 * ------------------------------------------------------------------ */

/** 16 层真实塔件表（witness 的 98.5 / 133.5 就出自它） */
const towerParts16 = () => buildBufferTowerParts(bufferTowerParamsFromConfig(m1TowerConfig(16)));
const TOWER_POSE = { bottomZmm: 900, centerXMm: 0, centerYMm: 0 };

/** 从塔件表算 load-passes-shelf（可换行表来源 / 替换 parts） */
const shelfBlockerOf = (extra = {}) => resolveChannelFeasibility({
  config: m1TowerConfig(16),
  parts: towerParts16(),
  pose: TOWER_POSE,
  supportSource: 'conveyor-parts',
  ...extra
}).blockers.find((blocker) => blocker.reason === 'load-passes-shelf');

test('P2-2 回归：witness.caliber 跟行表来源走 —— caller-rows 不许标「几何口径」', () => {
  const fromParts = shelfBlockerOf();
  assert.equal(fromParts?.witness?.caliber, 'geometry', '行表由几何/件表派生 → geometry');
  assert.match(fromParts?.detail ?? '', /几何解析口径/);

  // 同一份数字、行表声明成调用方的：数值可以一样，标签必须换成 caller-rows
  const callerRows = shelfBlockerOf({ supportSource: 'caller-rows' });
  assert.equal(callerRows?.witness?.caliber, 'caller-rows', 'caller-rows 的行表不是本机几何，口径标签必须跟着来源');
  assert.match(callerRows?.detail ?? '', /调用方行表口径/);
  assert.doesNotMatch(callerRows?.detail ?? '', /几何解析口径/);
  assert.equal(callerRows?.witness?.measuredFreeRiseFromPanelTopMm, 98.5, '口径标注不影响可复算的数字');
  // 方向仍不假绿：caller-rows 一律 diagnostic-only / feasible=false
  const callerFeasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts: towerParts16(),
    pose: TOWER_POSE,
    supportSource: 'caller-rows'
  });
  assert.equal(callerFeasibility.diagnosticOnly, true);
  assert.equal(callerFeasibility.feasible, false);
  assert.equal(callerFeasibility.m1.feasible, false);

  // 生产入口的 caller rows 路径同样透出 caller-rows
  const fixture = m1ChannelFixture();
  const outcome = checkPanelChannel({
    config: fixture.config,
    geometry: fixture.geometry,
    rows: supportRowsFromConveyorParts(fixture.parts),
    pose: poseOf(fixture)
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const witness = outcome.feasibility.blockers
    .find((blocker) => blocker.reason === 'load-passes-shelf')?.witness;
  assert.equal(witness?.caliber, 'caller-rows');
});

test('P2-4 回归：detail 明写 witness 量到遮挡件 minZ（底面），不让人按承托面顶面验算', () => {
  const shelf = shelfBlockerOf();
  const detail = shelf?.detail ?? '';
  assert.match(detail, /距板顶 98\.5/);
  assert.match(detail, /距板底 133\.5/);
  // 量到哪儿必须点名：minZ / 底面；并且区分「承托面顶面 1080」
  assert.match(detail, /minZ 底面/);
  assert.match(detail, /不是量到第 2 层承托面顶面 1080/);
  assert.match(detail, /板厚/);
  assert.deepEqual(shelf?.witness?.firstObstructionZBand, [1033.5, 1083.5]);
  // witness.note 同一个口径（不是写死一句「几何解析」）
  assert.match(shelf?.witness?.note ?? '', /minZ（底面）/);
  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts: towerParts16(),
    pose: TOWER_POSE,
    supportSource: 'conveyor-parts'
  });
  assert.match(feasibility.note, /均量到遮挡件 minZ 底面/);
});

test('P2-3 回归：承托面候选 NaN 落在 x / y / z → witness=null + invalid-shelf-geometry（不许 fail-open）', () => {
  const rows = supportRowsFromConveyorParts(towerParts16());
  for (const axis of ['x', 'y', 'z']) {
    // 第 2 层两根辊是最低遮挡（minZ 1033.5）：旧实现把 NaN 当「不重叠」丢掉 → witness 变成 105（偏大）
    const poisoned = rows.map((entry) => (/^tray-roller-2-/.test(entry.id)
      ? {
        ...entry,
        ...(axis === 'x' ? { minX: Number.NaN, maxX: Number.NaN } : {}),
        ...(axis === 'y' ? { minY: Number.NaN, maxY: Number.NaN } : {}),
        ...(axis === 'z' ? { minZ: Number.NaN } : {})
      }
      : entry));
    const feasibility = resolveChannelFeasibility({
      config: m1TowerConfig(16),
      rows: poisoned,
      pose: TOWER_POSE,
      supportSource: 'geometry'
    });
    const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
    assert.ok(shelf, `NaN ${axis}：load-passes-shelf 必须仍在（不许静默消失）`);
    assert.equal(shelf?.witness, null, `NaN ${axis}：读不出坐标的候选在场时 witness 必须 null，不许拿其余件的 105 顶替`);
    assert.equal(shelf?.diagnosticCode, 'invalid-shelf-geometry', `NaN ${axis}：必须显式标记`);
    assert.deepEqual(shelf?.invalidShelfPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
    assert.match(shelf?.detail ?? '', /invalid-shelf-geometry/);
    assert.match(shelf?.detail ?? '', /非有限值/);
    assert.match(shelf?.detail ?? '', /不拿其余件的数字顶替/);
    // 方向：不是假绿
    assert.equal(feasibility.feasible, false);
    assert.deepEqual(feasibility.blockers.map((blocker) => blocker.reason), ['load-passes-shelf', 'stroke-shortfall']);
    assert.match(feasibility.note, /invalid-shelf-geometry/);
  }
});

test('P2-3 回归：NaN 来自真实件表变换（x=NaN）同样 fail-closed', () => {
  // 端到端：不是手写行表，而是件表 transform.x 坏掉 → supportRowsFromConveyorParts 出 NaN
  const brokenParts = towerParts16().map((part) => (/^tray-roller-2-/.test(part.id)
    ? { ...part, transform: { ...part.transform, x: Number.NaN } }
    : part));
  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts: brokenParts,
    pose: TOWER_POSE,
    supportSource: 'conveyor-parts'
  });
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(shelf?.witness, null);
  assert.equal(shelf?.diagnosticCode, 'invalid-shelf-geometry');
  assert.deepEqual(shelf?.invalidShelfPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
  assert.equal(feasibility.feasible, false);
});

test('P2-3 回归：所有承托面候选都读不出坐标 → 不许退成 no-support，也不许报可行', () => {
  const rows = supportRowsFromConveyorParts(towerParts16()).map((entry) => (
    /^(tray-\d+|tray-rail-|stop-|tray-roller-|layer-sensor-)/.test(entry.id)
      ? { ...entry, minZ: Number.NaN }
      : entry
  ));
  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    rows,
    pose: TOWER_POSE,
    supportSource: 'geometry'
  });
  const reasons = feasibility.blockers.map((blocker) => blocker.reason);
  assert.ok(reasons.includes('load-passes-shelf'), '承托面候选读不出坐标时不许声明 no-support');
  assert.equal(reasons.includes('no-support'), false);
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(shelf?.witness, null);
  assert.equal(shelf?.diagnosticCode, 'invalid-shelf-geometry');
  assert.ok((shelf?.partIds.length ?? 0) > 0, 'partIds 必须点名那些读不出坐标的候选');
  assert.match(shelf?.detail ?? '', /不可排除挡路/);
  assert.equal(feasibility.feasible, false);
});

test('P2-3 对照：件表干净时 witness 照旧 98.5 / 133.5（不用 NaN 兜底把正常读数压掉）', () => {
  const shelf = shelfBlockerOf();
  assert.equal(shelf?.diagnosticCode, undefined, '干净件表不许带 invalid-shelf-geometry');
  assert.equal(shelf?.invalidShelfPartIds, undefined);
  assert.equal(shelf?.witness?.measuredFreeRiseFromPanelTopMm, 98.5);
  assert.equal(shelf?.witness?.measuredFreeRiseFromPanelBottomMm, 133.5);
  assert.deepEqual(shelf?.witness?.firstObstructionPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
});

/* ------------------------------------------------------------------ *
 * P2-2（最终复审）fail-closed：件的实体特征参数坏 → 行表不再静默丢件
 *
 * 旧实现 `supportRowsFromConveyorParts` 把「特征参数读不出」和「本来没有实体外形」都当成
 * `solids === 0` 跳过 → 行表里没有这件，`invalid-shelf-geometry` 看不见它，witness 偏大且无诊断码。
 * 现在适配器把前者记进 `droppedPartIds`，判据一侧并进同一份「无法判定是否挡路」清单。
 * ------------------------------------------------------------------ */

/** 16 层真实塔件表：把指定件的 cylinder 特征参数（直径/长度）改成 NaN（辊筒只有一条 cylinder 特征） */
const poisonCylinderParams = (parts, pattern) => parts.map((part) => (pattern.test(part.id)
  ? {
    ...part,
    features: part.features.map((node) => (node.type === 'cylinder'
      ? { ...node, params: { ...node.params, diameter: Number.NaN, height: Number.NaN } }
      : node))
  }
  : part));

test('P2-2 回归：真实塔件表里 tray-roller-2-in/out 辊筒参数 NaN → droppedPartIds 记账 + witness=null + invalid-shelf-geometry', () => {
  const poisoned = poisonCylinderParams(towerParts16(), /^tray-roller-2-(in|out)$/);

  // ① 适配器必须把「量不出盒」的件交出来，不许当「件表里没有这件」
  const detailed = supportRowsFromConveyorPartsDetailed(poisoned);
  assert.deepEqual(detailed.droppedPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
  assert.equal(
    detailed.rows.some((entry) => /^tray-roller-2-/.test(entry.id)),
    false,
    '量不出包围盒的件本来就不许有行（不拿 0 或几何均值编一个盒）'
  );

  // ② 旧口径（只看行表）就是这个 P2 的样子：行没了、最低遮挡换人、自由上升变大、且没有诊断码
  const rowsOnly = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    rows: supportRowsFromConveyorParts(poisoned),
    pose: TOWER_POSE,
    supportSource: 'geometry'
  });
  const stale = rowsOnly.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(stale?.diagnosticCode, undefined, '对照：只看行表时诊断码是空的（复现 P2-2）');
  assert.deepEqual(stale?.witness?.firstObstructionPartIds, ['tray-rail-2-left', 'tray-rail-2-right']);
  assert.equal(stale?.witness?.measuredFreeRiseFromPanelTopMm, 105);
  assert.ok(
    (stale?.witness?.measuredFreeRiseFromPanelTopMm ?? 0) > 98.5,
    '偏大 6.5 mm 正是 fail-open 读数（98.5 → 105）'
  );

  // ③ 判据路径（件表）必须 fail-closed：数字不顶替、件号点名、方向不假绿
  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts: poisoned,
    pose: TOWER_POSE,
    supportSource: 'conveyor-parts'
  });
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.ok(shelf, 'load-passes-shelf 不许因为两件量不出盒就消失');
  assert.equal(shelf?.witness, null, '读不出包围盒的件在场时 witness 必须 null（不许拿其余的 105 / 98.5 顶替）');
  assert.equal(shelf?.diagnosticCode, 'invalid-shelf-geometry');
  assert.deepEqual(shelf?.invalidShelfPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
  assert.match(shelf?.detail ?? '', /invalid-shelf-geometry/);
  assert.match(shelf?.detail ?? '', /特征参数非有限值/, 'detail 必须说清是「参数坏」而不是「坐标坏」');
  assert.match(shelf?.detail ?? '', /无法量到遮挡件 minZ 底面/);
  assert.match(shelf?.detail ?? '', /不拿其余件的数字顶替/);
  assert.match(feasibility.note, /invalid-shelf-geometry/);
  assert.equal(feasibility.feasible, false);
  assert.deepEqual(feasibility.blockers.map((blocker) => blocker.reason), ['load-passes-shelf', 'stroke-shortfall']);
});

test('P2-2 回归：只坏一根辊（tray-roller-2-in）也要点名 —— 旧实现首件会静默换成 -out', () => {
  const poisoned = poisonCylinderParams(towerParts16(), /^tray-roller-2-in$/);
  const detailed = supportRowsFromConveyorPartsDetailed(poisoned);
  assert.deepEqual(detailed.droppedPartIds, ['tray-roller-2-in']);

  // 对照：只看行表时数字仍是 98.5，但「首件」从 -in/out 两根变成只剩 -out —— 无告警的错答案
  const rowsOnly = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    rows: supportRowsFromConveyorParts(poisoned),
    pose: TOWER_POSE,
    supportSource: 'geometry'
  });
  const stale = rowsOnly.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(stale?.diagnosticCode, undefined);
  assert.deepEqual(stale?.witness?.firstObstructionPartIds, ['tray-roller-2-out']);

  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts: poisoned,
    pose: TOWER_POSE,
    supportSource: 'conveyor-parts'
  });
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(shelf?.witness, null);
  assert.equal(shelf?.diagnosticCode, 'invalid-shelf-geometry');
  assert.deepEqual(shelf?.invalidShelfPartIds, ['tray-roller-2-in']);
  assert.equal(feasibility.feasible, false);
});

test('P2-2 对照：合法「无实体外形」的件照旧不成行 —— 不记 dropped、不加诊断码、witness 仍 98.5', () => {
  // 只有减材料特征（holes）的件：本来就没有外形可量 → 政策是跳过，不是坏输入
  const subtractOnly = {
    id: 'tray-99',
    name: '只钻孔的占位件',
    transform: { x: 0, y: 0, z: 1200, rz: 0 },
    features: [{ id: 'tray-99-hole', type: 'holes', name: '孔', params: { diameter: 10, depth: 5, positions: [[0, 0]] } }]
  };
  const baselineRows = supportRowsFromConveyorParts(towerParts16());
  const parts = [...towerParts16(), subtractOnly];

  const detailed = supportRowsFromConveyorPartsDetailed(parts);
  assert.deepEqual(detailed.droppedPartIds, [], '无实体外形 ≠ 参数坏：不许进 droppedPartIds');
  assert.deepEqual(detailed.rows, baselineRows, '行表必须与不含该件时逐项相等');

  const feasibility = resolveChannelFeasibility({
    config: m1TowerConfig(16),
    parts,
    pose: TOWER_POSE,
    supportSource: 'conveyor-parts'
  });
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(shelf?.diagnosticCode, undefined, '干净件表（含无外形件）不许带 invalid-shelf-geometry');
  assert.equal(shelf?.invalidShelfPartIds, undefined);
  assert.equal(shelf?.witness?.measuredFreeRiseFromPanelTopMm, 98.5);
  assert.deepEqual(shelf?.witness?.firstObstructionPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
});

/* ------------------------------------------------------------------ *
 * P2（最终复审）fail-closed：承托行含非有限 min/max x/y/z → 不得给 supported claim
 * ------------------------------------------------------------------ */

/** 两条真合格的叉指带（2000×100，y=±430 内侧，顶面 910）：单独算就是 supported（15.48% / 2 带） */
const forkBands = () => [
  row('lift-finger-left', { x: [-1000, 1000], y: [-480, -380], topZ: 910 }),
  row('lift-finger-right', { x: [-1000, 1000], y: [380, 480], topZ: 910 })
];

/** 同类承托件的第三条：坐标读得出时它一定落在板投影正中、且顶面贴板底（必然是接触件） */
const forkCenter = () => row('lift-finger-center', { x: [-1000, 1000], y: [-100, 0], topZ: 910 });

/** 抬起位姿的入参（板底 910 = 叉指顶面） */
const FORK_POSE = { panel: PANEL, bottomZmm: 910, pose: 'carried', poseShiftMm: 20 };

test('P2 回归（对照）：两条真带 + 第三条真接触件 → supported，新判据不误伤干净输入', () => {
  const report = resolvePanelSupport({ ...FORK_POSE, parts: [...forkBands(), forkCenter()] });
  assert.equal(report.verdict, 'supported');
  assert.equal(report.claim, 'supported', '干净行表不许被压成诊断');
  assert.equal(report.diagnosticOnly, false);
  assert.deepEqual(report.invalidPartIds, []);
  assert.equal(report.diagnosticCode, undefined, '干净行表不许带 invalid-support-rows');
  assert.equal(report.coveredPct, 23.23);
  assert.equal(report.bandsY.length, 3);
  assert.equal(report.supportPartCount, 3);
});

test('P2 回归：任一承托行 min/max x/y/z 非有限 → 该行剔除 + claim=diagnostic-only（即便几何 verdict=supported）', () => {
  // 旧实现为什么会被这条顶高：NaN 参与的大小比较恒 false —— `|NaN − 910| > 1` 是 false，
  // 于是「z 读不出来」被当成「顶面正好贴在板底」，而它的 x/y 重叠与面积都是有限正数。
  assert.equal(Math.abs(Number.NaN - 910) > 1, false);

  const baseline = resolvePanelSupport({ ...FORK_POSE, parts: forkBands() });
  assert.equal(baseline.claim, 'supported', '前提：两条真带自身就是 supported');
  assert.equal(baseline.coveredPct, 15.48);

  const cases = [
    ['x', { minX: Number.NaN, maxX: Number.NaN }],
    ['y', { minY: Number.NaN, maxY: Number.NaN }],
    ['minZ', { minZ: Number.NaN }],
    ['maxZ', { maxZ: Number.NaN }] // 旧实现正是在这条上 fail-open（当成接触件计入）
  ];
  for (const [axis, patch] of cases) {
    const report = resolvePanelSupport({
      ...FORK_POSE,
      parts: [...forkBands(), { ...forkCenter(), ...patch }]
    });
    assert.equal(report.verdict, 'supported', `${axis}：其余两行的几何判决仍是 supported —— 压住 claim 的不是「算不出来」`);
    assert.equal(report.claim, 'diagnostic-only', `${axis}：不得给 supported claim`);
    assert.equal(report.diagnosticOnly, true, `${axis}：必须显式标成诊断`);
    assert.equal(report.diagnosticCode, 'invalid-support-rows', `${axis}：必须带稳定诊断码`);
    assert.deepEqual(report.invalidPartIds, ['lift-finger-center'], `${axis}：坏行必须点名`);
    // 数字与对照完全一致：坏行既不许顶高覆盖率/带数，也不许被静默当成「确认不接触」
    assert.deepEqual(report.contacts.map((contact) => contact.partId), ['lift-finger-left', 'lift-finger-right']);
    assert.equal(report.bandsY.length, 2);
    assert.equal(report.coveredPct, baseline.coveredPct, `${axis}：覆盖率不许被坏行改变`);
    assert.equal(report.supportPartCount, 2, `${axis}：坏行不算「参与判定」`);
    // reason 必须点名根因，且不许被读成「托不住」
    assert.match(report.reasons[0] ?? '', /invalid-support-rows/, `${axis}：根因放在第一条 reason`);
    const joined = report.reasons.join(' ');
    assert.match(joined, /lift-finger-center/);
    assert.match(joined, /claim 只能是 diagnostic-only/);
    assert.match(joined, /不得当「能托住板」的证据/);
    assert.doesNotMatch(joined, /diagnosticOnly：板不在碰撞件集/, `${axis}：根因不是「板不在碰撞件集」，不许套错模板`);
  }
});

test('P2 回归（端到端）：夹具件表里一条承托行 maxZ=NaN → rest claim 诊断、m1 不绿、feasible=false', () => {
  const fixture = m1ChannelFixture();
  const clean = channelOf(fixture);
  assert.equal(clean.panelSupport.rest.claim, 'supported', '前提：干净夹具的 rest 是 supported');
  assert.equal(clean.m1.restSupported, true);

  const rows = supportRowsFromConveyorParts(fixture.parts).map((entry) => (
    entry.id === 'lift-finger-left' ? { ...entry, maxZ: Number.NaN } : entry
  ));
  const poisoned = channelOf(fixture, { rows });
  assert.equal(poisoned.panelSupport.rest.claim, 'diagnostic-only');
  assert.equal(poisoned.panelSupport.rest.verdict, 'supported', '几何判决本身仍算得出来 —— 被压住的是可引用性');
  assert.deepEqual(poisoned.panelSupport.rest.invalidPartIds, ['lift-finger-left']);
  assert.equal(poisoned.m1.restSupported, false, '诊断结论不许进 m1 首层绿');
  assert.equal(poisoned.m1.feasible, false);
  assert.equal(poisoned.feasible, false, 'claim 与可行判定同源：诊断态不许 feasible=true');
  assert.match(poisoned.note, /invalid-support-rows/);
  assert.equal(poisoned.panelSupport.carried.claim, 'diagnostic-only', '同一行随轴走，仍读不出顶面');
});

test('P2 回归（生产入口）：几何件表里承托件中心坏掉 → mode 仍 verified，但 rest claim 降为 diagnostic-only', () => {
  const fixture = m1ChannelFixture();
  const geometry = {
    ...fixture.geometry,
    // 行表（supportRowsFromGeometryParts）读的是 world center：这里就是「几何件表投影出 NaN 行」的入口
    parts: fixture.geometry.parts.map((part) => (
      part.id === 'lift-finger-left'
        ? { ...part, center: [Number.NaN, part.center[1], part.center[2]] }
        : part
    ))
  };
  const outcome = checkPanelChannel({ config: fixture.config, geometry });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.rowsSource, 'geometry', '行表仍来自几何，不是拿 caller rows 兜');
  // mode 的口径不变（只覆盖「行表来自几何 + 板在碰撞件集」），可引用性由 claim 管
  assert.equal(outcome.mode, 'verified');
  assert.equal(outcome.panelSupport.rest.claim, 'diagnostic-only', '有非有限坐标行 → 不得给 supported claim');
  assert.ok(outcome.panelSupport.rest.invalidPartIds.includes('lift-finger-left'));
  assert.equal(outcome.feasibility.feasible, false);
  assert.match(outcome.note, /invalid-support-rows/);
  assert.match(outcome.note, /读不全/, 'note 必须说清「读不全 ≠ 托不住」');
});
