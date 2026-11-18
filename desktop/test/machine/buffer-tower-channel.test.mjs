/**
 * 缓存塔「升降通道」接线守卫：M1 件表 + 真实塔件表 + 干涉回执的只读字段。
 *
 * 三件必须同时成立的事：
 * 1. **真实塔的语义一个字节都不能变**：146 件 / 146 装配件 / rest-lift pass / sweep 仍 fail 270+135；
 *    板占位体只挂在 `geometry.workpiecePlaceholder`（`inCollisionSet:false`），不进 parts。
 * 2. **M1 件表（夹具 152 件）首层确实被托住**：rest/lift/sweep = 0/0/0，承托 rest 80.6% / carried 15.48%，
 *    两条承托断言都 supported。这只是「首层取放 20 mm」的绿。
 * 3. **满行程 2700 仍然红**（实测 512 处确认命中）：一层以上不可行，不许被首层的绿覆盖。
 *
 * 文档数值与本文件的实测差异（架构文档 §4 写 82.5 / 17.0）都在对应用例里复算了算式：
 * 2278×914/2278×1134 = 80.6%、2×2000×100/2278×1134 = 15.48%。**没有为了对上文档改阈值。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { partWorldBounds, resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import {
  PANEL_PART_ID,
  checkPanelChannel,
  resolveChannelFeasibility,
  resolvePanelSupport,
  supportRowsFromConveyorParts,
  supportRowsFromGeometryParts
} from '../../src/machine/panel-channel.ts';
import { m1ChannelFixture, M1_PANEL } from '../../test-support/m1-channel-fixture.mjs';

const PANEL = {
  lengthMm: M1_PANEL.lengthMm,
  widthMm: M1_PANEL.widthMm,
  thicknessMm: M1_PANEL.thicknessMm,
  centerXMm: 0,
  centerYMm: 0
};

/** 夹具板位姿（从几何里的板件读，不写死 900/0） */
const poseOf = (fixture) => {
  const part = fixture.geometry.parts.find((candidate) => candidate.id === 'workpiece-plate');
  if (!part) throw new Error('夹具几何里没有 workpiece-plate');
  return {
    bottomZmm: part.center[2] - part.shape.size[2] / 2,
    centerXMm: part.center[0],
    centerYMm: part.center[1]
  };
};

/** 夹具声明的轴行程/拾取空行程（carried 结论必须与轴同源） */
const axisOf = (fixture) => ({
  strokeMm: fixture.axis.strokeMm,
  pickupGapMm: fixture.axis.partPickupGapMm['workpiece-plate']
});
const stateNumbers = (summary) => [
  Number(summary?.pairs),
  Number(summary?.confirmedHits),
  Number(summary?.screenHits),
  String(summary?.reviewStatus)
];

test('M1 件表：152 机台件 + 板 = 153 刚体、装配件 152、包络不变', () => {
  const fixture = m1ChannelFixture();
  assert.equal(fixture.parts.length, 152, '146 −1 台面 +2 叉指 +1 横梁 +4 分段带 = 152');
  assert.equal(fixture.geometry.parts.length, 153, '几何刚体数含板占位件 +1');
  assert.equal(fixture.geometry.assemblyPartCount, 152, '装配件数不含板（板是被加工对象）');
  assert.deepEqual(fixture.geometry.envelope.map((value) => Math.round(value)), [2430, 1790, 3840]);
});

test('M1 三态：rest / lift / sweep 全 0，板底面 900 → 910', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(stateNumbers(result.states.rest), [42, 0, 0, 'pass']);
  assert.deepEqual(stateNumbers(result.states.lift), [42, 0, 0, 'pass']);
  assert.equal(result.states.sweep.confirmedHits, 0);
  assert.equal(result.states.sweep.screenHits, 0);
  assert.equal(result.states.sweep.reviewStatus, 'pass');
  assert.equal(result.partCount, 153);
  assert.equal(result.assemblyPartCount, 152);
  assert.equal(result.workpiece?.bottomZ.rest, 900);
  assert.equal(result.workpiece?.bottomZ.lift, 910);
  assert.equal(result.workpiece?.countedInAssemblyPartCount, false);
});

test('M1 承托：rest 80.6%/3 带、carried 15.48%/2 带，两条都 supported', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.panelSupport, '几何里有板占位件 → 承托断言必须产出');
  const { rest, carried } = result.panelSupport;
  // 2278 × (82+750+82) / 2583252 = 80.61%（文档 82.5 与它自己的件宽不符）
  assert.equal(rest.coveredPct, 80.6);
  assert.equal(rest.bandsY.length, 3);
  assert.equal(rest.verdict, 'supported');
  // 2 × 2000 × 100 / 2583252 = 15.48%（文档 17.0 与它自己的接触尺寸不符）
  assert.equal(carried.coveredPct, 15.48);
  assert.equal(carried.bandsY.length, 2);
  assert.equal(carried.verdict, 'supported');
  assert.deepEqual(carried.bandsY.map((band) => band.overlapXmm), [2000, 2000]);
  assert.match(result.panelChannelNote, /rest supported/);
  assert.match(result.panelChannelNote, /多层通道 feasible=false/);
});

test('真实塔几何：146 件语义不变，板占位体只读（不进 parts）', () => {
  const fixture = m1ChannelFixture();
  const resolved = resolveMachineGeometry(fixture.config);
  assert.equal(resolved.source, 'buffer-tower-assembly');
  assert.equal(resolved.partCount, 146, 'partCount 仍是 146（板进 parts 才会变 147）');
  assert.equal(resolved.assemblyPartCount, 146);
  assert.equal(resolved.geometry.parts.length, 146);
  assert.equal(resolved.geometry.parts.some((part) => part.id === PANEL_PART_ID), false, '板不许出现在碰撞件表里');
  const placeholder = resolved.geometry.workpiecePlaceholder;
  assert.ok(placeholder, '塔分派必须给出只读板件占位体');
  assert.equal(placeholder?.id, PANEL_PART_ID);
  assert.equal(placeholder?.role, 'workpiece');
  assert.equal(placeholder?.material, 'PV-GLASS');
  assert.equal(placeholder?.inCollisionSet, false);
  assert.equal(placeholder?.bottomZmm, 900);
  assert.deepEqual(placeholder?.sizeMm, [2278, 1134, 35]);
  // 轴仍只随动台面：板没被挂进 2700 行程（挂进去就不再是只读诊断）
  assert.deepEqual(resolved.geometry.moving[0]?.partIds, ['lift-platform']);
  assert.equal(resolved.geometry.moving[0]?.strokeMm, 2700);
});

test('真实塔三态：rest/lift 仍 pass 0、sweep 仍 fail（判据一个字没放宽）', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: fixture.config });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.partCount, 146);
  assert.equal(result.assemblyPartCount, 146);
  assert.equal(result.workpiece, null, '板不在碰撞件表：老口径 workpiece 仍 null（不许假装查了板）');
  assert.deepEqual(stateNumbers(result.states.rest), [38, 0, 0, 'pass']);
  assert.deepEqual(stateNumbers(result.states.lift), [38, 0, 0, 'pass']);
  assert.deepEqual(stateNumbers(result.states.sweep), [42, 270, 135, 'fail']);
});

test('真实塔承托：整条 1200 宽带上覆盖 100% 但只有 1 条带 → unsupported；carried 不可声称证据', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest'], config: fixture.config });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { rest, carried } = result.panelSupport ?? {};
  assert.ok(rest && carried);
  assert.equal(rest?.coveredPct, 100, '板（1134 宽）整块落在 1200 宽的带上');
  assert.equal(rest?.bandsY.length, 1, '单件整带只有一个支点');
  assert.equal(rest?.verdict, 'unsupported', '覆盖率高不等于被托住：≥2 条接触带这条独立判');
  assert.match(rest?.reasons.join(' ') ?? '', /接触带 1 条（阈值 ≥2）→ 不满足/);
  // 生产塔没把板挂进升降轴：位移缺失 → carried 底面**等于**静止底面（旧实现编过 910）
  assert.equal(carried?.panelBottomZmm, rest?.panelBottomZmm);
  assert.equal(carried?.claim, 'diagnostic-only', '没有位移证据的一态不许当承托证据');
  assert.equal(carried?.verdict, 'unsupported');
});

test('真实塔通道判定：2700/2716.5/16.5、2000/2278/278、135/567；净跨与走廊只进 designNotes', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest'], config: fixture.config });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const feasibility = result.panelFeasibility;
  assert.ok(feasibility);
  assert.equal(feasibility?.feasible, false);
  assert.equal(feasibility?.stroke.declaredMm, 2700);
  assert.equal(feasibility?.stroke.requiredMm, 2716.5);
  assert.equal(feasibility?.stroke.shortfallMm, 16.5);
  assert.equal(feasibility?.clearSpan.xClearMm, 2000);
  assert.equal(feasibility?.clearSpan.shortfallMm, 278);
  assert.equal(feasibility?.corridor.corridorMm, 135);
  assert.equal(feasibility?.corridor.halfWidthMm, 567);
  const reasons = (feasibility?.blockers ?? []).map((blocker) => blocker.reason);
  for (const reason of ['load-passes-shelf', 'stroke-shortfall']) {
    assert.ok(reasons.includes(reason), `缺 blocker ${reason}（实际 ${reasons.join('/')}）`);
  }
  // 审查实测：柱与板 y 向投影不重叠 → 净跨/走廊不是阻塞，只是保守设计 notes
  assert.equal(reasons.includes('clear-span'), false);
  assert.equal(reasons.includes('corridor-too-narrow'), false);
  assert.deepEqual((feasibility?.designNotes ?? []).map((note) => note.reason), ['clear-span-conservative', 'corridor-conservative']);
  assert.equal(feasibility?.columnSweep.yOverlapMm, 0);
  assert.deepEqual(feasibility?.columnSweep.intersectingPartIds, []);
  // 生产塔（无 M1 承托路径）走诊断口径，不许出 supported/可行
  assert.equal(feasibility?.diagnosticOnly, true);
  assert.equal(feasibility?.panelSupport.rest.claim, 'diagnostic-only');
  // 现有件表没有叉指：首层 M1 段在它身上也不成立（carried 0%）
  assert.equal(feasibility?.m1.feasible, false);
  assert.match(feasibility?.m1.diagnosticError ?? '', /缺失/);
});

test('requirePanel：几何里没有板 → INVALID_ARGUMENT（不返回绿）', () => {
  const fixture = m1ChannelFixture({ withPanel: false });
  const result = runInterferenceStates({
    states: ['rest'],
    config: fixture.config,
    geometry: fixture.geometry,
    requirePanel: true
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'INVALID_ARGUMENT');
  assert.match(result.message, /没有板占位体/);
});

test('requirePanel：非塔机型 → INVALID_ARGUMENT（没有升降通道这条轴）', () => {
  const result = runInterferenceStates({
    states: ['rest'],
    config: { id: 'belt', conveyor: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 1 } },
    requirePanel: true
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('requirePanel：真实塔几何 → ok，承托与通道一起回执（但只是 diagnostic-only）', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest', 'lift'], config: fixture.config, requirePanel: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.panelSupport);
  assert.equal(result.panelSupport?.rest.verdict, 'unsupported');
  assert.equal(result.panelSupport?.rest.claim, 'diagnostic-only', '生产塔 placeholder 路径不许声称 supported');
  assert.equal(result.panelSupport?.rest.thresholds.minBands, 2, '阈值随回执回显，不许调用点猜');
  assert.equal(result.panelFeasibility?.feasible, false);
  assert.equal(result.panelFeasibility?.diagnosticOnly, true);
});

test('A2 负例：叉指移到板外 → carried 覆盖 0、unsupported（sweep 不能替代承托）', () => {
  const fixture = m1ChannelFixture({ fingerYMm: 622, fingerWidthMm: 90, fingerTopZmm: 880, travelMm: 10 });
  const rows = supportRowsFromGeometryParts(fixture.geometry.parts, { shiftMm: 10, excludeIds: [PANEL_PART_ID] });
  const carried = resolvePanelSupport({ parts: rows, panel: PANEL, bottomZmm: 890, pose: 'carried', poseShiftMm: 10 });
  assert.equal(carried.coveredPct, 0);
  assert.deepEqual(carried.contacts, []);
  assert.equal(carried.verdict, 'unsupported');
  // 自证：这台机器的机构件并未全绿（叉臂 y 577..667 撞回程带），所以承托断言不是 sweep 的复读机
  const states = runInterferenceStates({ states: ['rest', 'sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(states.ok, true);
  if (!states.ok) return;
  assert.ok((states.states.rest.confirmedHits ?? 0) > 0, 'A2 侧叉自身与回程带重叠 → 现形于干涉');
  // A2 的轴行程 10 = 拾取空行程：板没离地，这一态只能算诊断；且叉臂在板外不贡献任何接触
  assert.equal(states.panelSupport?.carried.claim, 'diagnostic-only');
  assert.equal(
    (states.panelSupport?.carried.contacts ?? []).some((contact) => /lift-finger/.test(contact.partId)),
    false,
    'A2 叉臂在板外（y=±622 > 板半宽 567），不许贡献任何接触'
  );
});

test('负例：叉指 120 宽 > 缝 110 → sweep 8 对确认命中', () => {
  const fixture = m1ChannelFixture({ fingerWidthMm: 120 });
  const result = runInterferenceStates({ states: ['sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.states.sweep.reviewStatus, 'fail');
  assert.equal(result.states.sweep.confirmedHits, 8);
  assert.ok(result.states.sweep.items.some((item) => /lift-finger/.test(item.b)) || result.states.sweep.items.some((item) => /lift-finger/.test(item.a)));
});

test('负例：超行程 40（20 就要到顶）→ 横梁进带上行程带，3 对确认命中', () => {
  const fixture = m1ChannelFixture({ travelMm: 40 });
  const result = runInterferenceStates({ states: ['sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.states.sweep.reviewStatus, 'fail');
  assert.equal(result.states.sweep.confirmedHits, 3);
  const blamed = result.states.sweep.items.map((item) => `${item.a}|${item.b}`);
  assert.ok(blamed.includes('belt-top-m|lift-carriage'), `实测 blamed=${blamed.join(', ')}`);
});

test('满行程 2700：16 层 sweep 仍 fail（≥400 处确认命中），首层绿不许当多层可行', () => {
  const fixture = m1ChannelFixture({ travelMm: 2700 });
  const result = runInterferenceStates({ states: ['sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.states.sweep.reviewStatus, 'fail');
  assert.ok(result.states.sweep.confirmedHits >= 400, `confirmedHits=${result.states.sweep.confirmedHits}`);
  const blamed = result.states.sweep.items.map((item) => `${item.a}|${item.b}`);
  assert.ok(blamed.some((pair) => /workpiece-plate|tray-/.test(pair)), `blamed=${blamed.join(', ')}`);
});

test('支撑面行表与 partWorldBounds 逐件一致（146 件，口径不许漂移）', () => {
  const fixture = m1ChannelFixture();
  const rows = supportRowsFromConveyorParts(fixture.parts);
  const byId = new Map(rows.map((entry) => [entry.id, entry]));
  assert.equal(rows.length, fixture.parts.length);
  for (const part of fixture.parts) {
    const bounds = partWorldBounds(part);
    const row = byId.get(part.id);
    assert.ok(row, `缺行 ${part.id}`);
    assert.ok(Math.abs((row?.minX ?? 0) - bounds.min[0]) < 0.02, `${part.id}.minX`);
    assert.ok(Math.abs((row?.maxX ?? 0) - bounds.max[0]) < 0.02, `${part.id}.maxX`);
    assert.ok(Math.abs((row?.minY ?? 0) - bounds.min[1]) < 0.02, `${part.id}.minY`);
    assert.ok(Math.abs((row?.maxY ?? 0) - bounds.max[1]) < 0.02, `${part.id}.maxY`);
    assert.ok(Math.abs((row?.maxZ ?? 0) - bounds.max[2]) < 0.02, `${part.id}.maxZ`);
  }
});

test('去掉板占位件：三态全绿但 checkPanelChannel 必须拒绝（绿 ≠ 承托）', () => {
  const fixture = m1ChannelFixture({ withPanel: false });
  const states = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: fixture.config, geometry: fixture.geometry });
  assert.equal(states.ok, true);
  if (!states.ok) return;
  assert.equal(states.states.sweep.confirmedHits, 0);
  assert.equal(states.states.sweep.reviewStatus, 'pass');
  assert.equal(states.panelSupport, null, '没有板就没有承托断言（null，不是绿）');
  assert.match(states.panelChannelNote, /没有板占位体/);
  const check = checkPanelChannel({ config: fixture.config, geometry: fixture.geometry });
  assert.equal(check.ok, false);
});

test('口径不依赖件表：真实塔件表与 M1 夹具的 stroke/clearSpan/corridor 完全一致', () => {
  const fixture = m1ChannelFixture();
  const fromFixture = resolveChannelFeasibility({
    config: fixture.config,
    parts: fixture.parts,
    pose: poseOf(fixture),
    axis: axisOf(fixture),
    supportSource: 'fixture'
  });
  const fromReal = resolveChannelFeasibility({
    config: fixture.config,
    pose: poseOf(fixture),
    axis: axisOf(fixture),
    supportSource: 'conveyor-parts'
  });
  for (const key of ['declaredMm', 'requiredMm', 'shortfallMm']) {
    assert.equal(fromFixture.stroke[key], fromReal.stroke[key], `stroke.${key}`);
  }
  for (const key of ['xClearMm', 'xClearInnerMm', 'shortfallMm', 'shortfallInnerMm']) {
    assert.equal(fromFixture.clearSpan[key], fromReal.clearSpan[key], `clearSpan.${key}`);
  }
  assert.deepEqual(fromFixture.corridor, fromReal.corridor);
  // 但承托结论必须不同：夹具件表首层能托住（fixture 来源），真实件表（无叉指）托不住
  assert.equal(fromFixture.m1.feasible, true);
  assert.equal(fromFixture.panelSupport.rest.supportSource, 'fixture');
  assert.equal(fromReal.m1.feasible, false);
  assert.equal(fromReal.panelSupport.rest.supportSource, 'conveyor-parts');
});
