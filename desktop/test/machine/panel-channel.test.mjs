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
  supportRowsFromGeometryParts
} from '../../src/machine/panel-channel.ts';
import { m1ChannelFixture, M1_PANEL } from '../../test-support/m1-channel-fixture.mjs';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';

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
  // 件数从件表派生，不许写死「2 层 26 处 / 16 层 446 处」这类快照
  assert.doesNotMatch(shelf?.detail ?? '', /26 处|446 处/);
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
  assert.match(outcome.hint ?? '', /M1 件表要在几何里给出 workpiece-plate 占位件/);
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

test('checkPanelChannel：生产塔 placeholder → diagnostic-only、不可声称 supported', () => {
  const fixture = m1ChannelFixture();
  const resolved = resolveMachineGeometry(fixture.config);
  const outcome = checkPanelChannel({ config: fixture.config, geometry: resolved.geometry });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // 生产塔：板只挂 workpiecePlaceholder、inCollisionSet=false，件表里没有 channel 承托路径
  assert.equal(outcome.panelSource.inCollisionSet, false);
  assert.equal(outcome.mode, 'diagnostic-only');
  assert.match(outcome.pose.source, /workpiecePlaceholder/);
  assert.equal(outcome.panelSupport.rest.claim, 'diagnostic-only');
  assert.equal(outcome.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(outcome.feasibility.diagnosticOnly, true);
  assert.equal(outcome.feasibility.feasible, false, 'placeholder 路径不许出 feasible=true');
  assert.equal(outcome.feasibility.m1.feasible, false, '没有承托路径也没有轴位移 → 首层也不成立');
  assert.match(outcome.feasibility.m1.diagnosticError ?? '', /缺失/);
  assert.match(outcome.note, /diagnosticOnly/);
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
  assert.equal(outcome.panelSource.inCollisionSet, false);
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
