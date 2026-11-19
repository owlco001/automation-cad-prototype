/**
 * 缓存塔「升降通道」接线守卫：M1 件表 + 真实塔件表 + 干涉回执的只读字段。
 *
 * 三件必须同时成立的事：
 * 1. **真实塔的件数语义**：146 装配件 + 板 = **147 几何刚体**；板是 `geometry.parts` 里的真实
 *    `GeomPart`（role=workpiece、moving=false），`workpiecePlaceholder` 由同一件投影出来；
 *    `inCollisionSet` 只由 parts 里有无同 id 成员派生（占位体自报的 flag 一律不信）。
 *    rest/lift 仍 0 命中、sweep 仍 fail **270+135 = 405**（板进碰撞集但静止）。
 * 2. **M1 件表（夹具 152 件）首层确实被托住**：rest/lift/sweep = 0/0/0，承托 rest 80.6% / carried 15.48%，
 *    两条承托断言都 supported。这只是「首层取放 20 mm」的绿。
 * 3. **满行程 2700 仍然红**（实测 512 处确认命中）：一层以上不可行，不许被首层的绿覆盖。
 *
 * 文档数值与本文件的实测差异（架构文档 §4 写 82.5 / 17.0）都在对应用例里复算了算式：
 * 2278×914/2278×1134 = 80.6%、2×2000×100/2278×1134 = 15.48%。**没有为了对上文档改阈值。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { partWorldBounds, resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import {
  buildBufferTowerParts,
  bufferTowerParamsFromConfig,
  bufferTowerSlots
} from '../../src/machine/buffer-tower-assembly.ts';
import { conveyorBom } from '../../src/machine/conveyor-assembly.ts';
import {
  PANEL_PART_ID,
  checkPanelChannel,
  liftAxisOfGeometry,
  panelSourceOfGeometry,
  resolveChannelFeasibility,
  resolvePanelSupport,
  supportRowsFromConveyorParts,
  supportRowsFromGeometryParts
} from '../../src/machine/panel-channel.ts';
import { m1ChannelFixture, m1TowerConfig, M1_PANEL } from '../../test-support/m1-channel-fixture.mjs';

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

test('真实塔几何：146 装配 + 板 = 147 刚体；板是真实碰撞件，占位体由同件投影', () => {
  const fixture = m1ChannelFixture();
  const resolved = resolveMachineGeometry(fixture.config);
  assert.equal(resolved.source, 'buffer-tower-assembly');
  assert.equal(resolved.partCount, 147, 'partCount = 装配件数 + 板');
  assert.equal(resolved.assemblyPartCount, 146, '装配件数不含板（板不进 ConveyorPart 表）');
  assert.equal(resolved.geometry.parts.length, 147);
  const plate = resolved.geometry.parts.find((part) => part.id === PANEL_PART_ID);
  assert.ok(plate, '板必须出现在碰撞件表里');
  assert.equal(plate?.role, 'workpiece');
  assert.equal(plate?.moving, false, '板不随升降轴移动');
  assert.equal(plate?.material, 'PV-GLASS');
  const placeholder = resolved.geometry.workpiecePlaceholder;
  assert.ok(placeholder, '塔分派必须给出占位体（由真实件投影）');
  assert.equal(placeholder?.id, PANEL_PART_ID);
  assert.equal(placeholder?.role, 'workpiece');
  assert.equal(placeholder?.material, 'PV-GLASS');
  assert.equal(placeholder?.inCollisionSet, true, '板在 parts 里 → 派生的 inCollisionSet=true');
  assert.equal(placeholder?.bottomZmm, 900);
  assert.deepEqual(placeholder?.sizeMm, [2278, 1134, 35]);
  assert.deepEqual(placeholder?.center, plate?.center, '占位体必须是同一件的投影（不许各写一套数）');
  assert.deepEqual(placeholder?.shape, plate?.shape);
  // 轴仍只随动台面：板没被挂进 2700 行程（挂进去 sweep 会变 1070，不是本轮）
  assert.deepEqual(resolved.geometry.moving[0]?.partIds, ['lift-platform']);
  assert.equal(resolved.geometry.moving[0]?.strokeMm, 2700);
  assert.equal(liftAxisOfGeometry(resolved.geometry, PANEL_PART_ID), null,
    '板不在轴的 partIds 里 → 不许把轴行程当板的位移');
});

test('2/8/16 层：几何件数按建造器实际件数 + 1 派生（48/90/146 → 49/91/147）', () => {
  const expectedBuilder = { 2: 48, 8: 90, 16: 146 };
  for (const levels of [2, 8, 16]) {
    const config = m1TowerConfig(levels);
    const params = bufferTowerParamsFromConfig(config);
    const builder = buildBufferTowerParts(params);
    const resolved = resolveMachineGeometry(config);
    assert.equal(builder.length, expectedBuilder[levels], `levels=${levels} 建造器件数基线`);
    assert.equal(resolved.assemblyPartCount, builder.length, `levels=${levels} 装配件数 = 建造器件数`);
    assert.equal(resolved.partCount, builder.length + 1, `levels=${levels} partCount = 建造器件数 + 1`);
    assert.equal(resolved.geometry.parts.length, builder.length + 1, `levels=${levels} 几何刚体数`);
    assert.equal(resolved.geometry.parts.filter((part) => part.role === 'workpiece').length, 1,
      `levels=${levels} 只有一件工件`);
  }
});

test('板进碰撞集但 BOM / 装配件数 / 货位不变（板不是采购件）', () => {
  const config = m1TowerConfig(16);
  const params = bufferTowerParamsFromConfig(config);
  const parts = buildBufferTowerParts(params);
  const resolved = resolveMachineGeometry(config);
  assert.equal(parts.some((part) => part.id === PANEL_PART_ID), false, '板不进 ConveyorPart 表');
  const bom = conveyorBom(parts);
  assert.equal(bom.length, 96, 'BOM 行数不变');
  assert.equal(bom.reduce((sum, row) => sum + row.qty, 0), 146, 'BOM qty 合计仍是装配件数');
  const slots = bufferTowerSlots(params, parts);
  assert.equal(slots.fromGeometry, 16);
  assert.equal(slots.aligned, true);
  assert.equal(slots.usableStorage, 15);
  assert.deepEqual(resolved.geometry.envelope.map((value) => Math.round(value)), [2430, 1790, 3840], '包络不变');
  // structureBom 也是从 parts 出的：不因为几何里多一块板就多一行
  assert.equal(resolved.geometry.structureBom.reduce((sum, row) => sum + row.qty, 0), 146);
});

test('真实塔三态：rest/lift 仍 pass 0、sweep 仍 fail 405（270 确认 + 135 待复核）', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: fixture.config });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.partCount, 147);
  assert.equal(result.assemblyPartCount, 146);
  // 板在碰撞集里 → workpiece 不再是 null；但板不随轴走 → lift 位为 null（不是 3600）
  assert.equal(result.workpiece?.partId, PANEL_PART_ID);
  assert.equal(result.workpiece?.bottomZ.rest, 900);
  assert.equal(result.workpiece?.bottomZ.lift, null);
  assert.equal(result.workpiece?.countedInAssemblyPartCount, false);
  assert.equal(result.workpiece?.inBom, false);
  assert.deepEqual(stateNumbers(result.states.rest), [38, 0, 0, 'pass']);
  assert.deepEqual(stateNumbers(result.states.lift), [38, 0, 0, 'pass']);
  assert.deepEqual(stateNumbers(result.states.sweep), [42, 270, 135, 'fail'],
    '板进碰撞集但静止：sweep 命中与现役逐项相等（405 = 270 + 135），不是 1070（那是板挂轴后的语义变更）');
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
  // 生产塔几何**含板** → verified；但 verified 只说明「行表来自几何 + 碰撞集里有这块板」，
  // 不是结构可行：rest 100%/1 带 → unsupported，carried 缺位移 → diagnostic-only。
  assert.equal(feasibility?.diagnosticOnly, false);
  assert.equal(feasibility?.panelSupport.rest.claim, 'unsupported');
  assert.equal(feasibility?.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(feasibility?.m1.carriedShiftSource, 'missing', '板不随塔轴移动 → 位移必须缺失，不许借 2700');
  assert.equal(feasibility?.m1.carriedShiftMm, 0);
  assert.equal(feasibility?.panelSupport.carried.panelBottomZmm, feasibility?.panelSupport.rest.panelBottomZmm,
    '没有位移证据时 carried 底面必须等于静止底面（不许编 910/3600）');
  // 现有件表没有叉指：首层 M1 段在它身上也不成立（carried 0%）
  assert.equal(feasibility?.m1.feasible, false);
  assert.match(feasibility?.m1.diagnosticError ?? '', /缺失/);
  // 自由上升 witness：由件表最低遮挡件派生（16 层 = 距板顶 98.5 / 距板底 133.5，首件第 2 层辊）
  const shelf = (feasibility?.blockers ?? []).find((blocker) => blocker.reason === 'load-passes-shelf');
  const witness = shelf?.witness;
  assert.ok(witness, 'load-passes-shelf 必须带 witness');
  assert.equal(witness?.caliber, 'geometry');
  assert.equal(witness?.measuredFreeRiseFromPanelTopMm, 98.5);
  assert.equal(witness?.measuredFreeRiseFromPanelBottomMm, 133.5);
  assert.deepEqual(witness?.firstObstructionPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
  assert.deepEqual(witness?.firstObstructionZBand, [1033.5, 1083.5]);
  assert.equal(witness?.measuredFreeRiseFromPanelBottomMm - witness?.measuredFreeRiseFromPanelTopMm, 35, '两个口径差一个板厚');
  assert.match(shelf?.detail ?? '', /距板顶 98\.5/);
  // 阈值一个字没动
  assert.deepEqual(feasibility?.thresholds, {
    minCoveredPct: 15,
    minBands: 2,
    minBandOverlapXmm: 1900,
    minContactOverlapXmm: 1500,
    contactToleranceMm: 1
  });
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

test('requirePanel：真实塔几何 → verified，但 rest unsupported / carried 诊断 / feasible=false', () => {
  const fixture = m1ChannelFixture();
  const result = runInterferenceStates({ states: ['rest', 'lift'], config: fixture.config, requirePanel: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.panelSupport);
  assert.equal(result.panelSupport?.rest.verdict, 'unsupported');
  assert.equal(result.panelSupport?.rest.claim, 'unsupported', '板在碰撞集 → verified 的 rest 判决；单条带仍判 unsupported');
  assert.equal(result.panelSupport?.carried.claim, 'diagnostic-only', '板不随塔轴移动 → carried 只能是诊断');
  assert.equal(result.panelSupport?.rest.thresholds.minBands, 2, '阈值随回执回显，不许调用点猜');
  assert.equal(result.panelFeasibility?.feasible, false);
  assert.equal(result.panelFeasibility?.diagnosticOnly, false, 'verified ≠ 可行；它只说明行表来自几何 + 板在碰撞集');
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

test('支撑面行表与 partWorldBounds 逐件一致（152 件，口径不许漂移）', () => {
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

test('占位体手写 inCollisionSet:true 但 parts 里没有板 → 仍 diagnostic-only（不认手写 flag）', () => {
  const config = m1TowerConfig(16);
  const resolved = resolveMachineGeometry(config);
  const forged = {
    ...resolved.geometry,
    parts: resolved.geometry.parts.filter((part) => part.id !== PANEL_PART_ID),
    workpiecePlaceholder: { ...resolved.geometry.workpiecePlaceholder, inCollisionSet: true }
  };
  const source = panelSourceOfGeometry(forged);
  assert.ok(source, '占位体还在 → 仍能定位板位姿');
  assert.equal(source?.inCollisionSet, false, 'parts 里没有同 id 件 → inCollisionSet 必须派生为 false');
  const outcome = checkPanelChannel({ config, geometry: forged });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, 'diagnostic-only');
  assert.equal(outcome.panelSource.inCollisionSet, false);
  assert.equal(outcome.panelSupport.rest.claim, 'diagnostic-only');
  assert.equal(outcome.panelSupport.carried.claim, 'diagnostic-only');
  assert.equal(outcome.feasibility.feasible, false);
  assert.equal(outcome.feasibility.m1.feasible, false);
  assert.match(outcome.note, /diagnosticOnly/);
});

test('自由上升 witness 随几何变：删掉/下移第 2 层第一处遮挡，值与首件必须跟着变', () => {
  const config = m1TowerConfig(16);
  const params = bufferTowerParamsFromConfig(config);
  const parts = buildBufferTowerParts(params);
  const pose = { bottomZmm: 900, centerXMm: 0, centerYMm: 0 };
  const witnessOf = (variant) => resolveChannelFeasibility({
    config,
    parts: variant,
    pose,
    supportSource: 'conveyor-parts'
  }).blockers.find((blocker) => blocker.reason === 'load-passes-shelf')?.witness;

  const base = witnessOf(parts);
  assert.deepEqual(
    [base?.measuredFreeRiseFromPanelTopMm, base?.measuredFreeRiseFromPanelBottomMm],
    [98.5, 133.5],
    '16 层实测：距板顶 98.5 / 距板底 133.5'
  );
  assert.deepEqual(base?.firstObstructionPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);

  // 删掉第 2 层辊：第一处遮挡变成托条（z 1040）→ 105 / 140
  const noRoller = witnessOf(parts.filter((part) => !/^tray-roller-2-/.test(part.id)));
  assert.deepEqual(
    [noRoller?.measuredFreeRiseFromPanelTopMm, noRoller?.measuredFreeRiseFromPanelBottomMm],
    [105, 140],
    '删掉第一处遮挡后自由上升必须变大（不许仍报 98.5）'
  );
  assert.deepEqual(noRoller?.firstObstructionPartIds, ['tray-rail-2-left', 'tray-rail-2-right']);

  // 辊下移 5 mm：仍是最低遮挡，但数值必须 −5（93.5 / 128.5）
  const lowered = witnessOf(parts.map((part) => (
    /^tray-roller-2-/.test(part.id)
      ? { ...part, transform: { ...part.transform, z: part.transform.z - 5 } }
      : part
  )));
  assert.deepEqual(
    [lowered?.measuredFreeRiseFromPanelTopMm, lowered?.measuredFreeRiseFromPanelBottomMm],
    [93.5, 128.5],
    '移动第一处遮挡后自由上升必须随几何变'
  );
  assert.deepEqual(lowered?.firstObstructionPartIds, ['tray-roller-2-in', 'tray-roller-2-out']);
});

/**
 * `npm run verify:channel` 是「同 id 伪板」这条负例的唯一执行点（纯函数测试再多，也管不到脚本里
 * 那条断言还在不在）。这里做三层门禁：
 *   0. 行为：直接把一条**真实接触行**的 `maxZ` 弄成 NaN —— 该行必须被剔除（不进 contacts）、
 *      数字等价于「删掉该行」、claim 只能是 diagnostic-only（这是 N13 判据本身，不靠脚本文字）；
 *      再把**生产几何**克隆一份、把一件承托面 GeomPart 的中心写成 NaN —— `load-passes-shelf`
 *      必须带 `diagnosticCode=invalid-shelf-geometry`、`witness=null`、`feasible=false`，
 *      而板身份与行表来源原样保留（这是 N14 判据本身，同样不靠脚本文字）；
 *   1. 静态：脚本里必须有 N12 同 id 伪板 + N13 非有限承托行 + N14 承托面几何 fail-closed 负例，
 *      以及 `FORGED_PANEL_MODE` / `invalid-shelf-geometry` 的断言锚点；
 *   2. 动态：把脚本复制到 scripts/ 内的临时文件，分别改坏 N12 / N13 / N14 的**输入或期望**再跑 ——
 *      坏负例必须让脚本 **exit 1 且失败项里有对应编号**；若仍退 0，说明那条负例是摆设（自证失败）。
 *      N12：`FORGED_PANEL_MODE` 改成 `'verified'`；
 *      N13：把注入 NaN 的那一行改成原值（`maxZ: row.maxZ`），坏行消失 → N13 的断言必须自己红；
 *      N14：去掉承托面中心的 NaN 注入（`index === axis ? Number.NaN : value` → `value`），
 *           坏件变干净 → N14 的断言必须自己红。
 * 用 2 层跑（0.5 s 量级），临时文件在 finally 里删除，不留在工作树。
 */
test('verify:channel 收录 N12 伪板 + N13 非有限行 + N14 承托面几何负例，判据行为成立且各自改坏后脚本必须非零退出', () => {
  // 0) 判据行为（N13）：NaN 落在真实接触行上，旧实现会把它当贴面接触并顶高覆盖率
  const fixture = m1ChannelFixture();
  const panel = panelSourceOfGeometry(fixture.geometry);
  assert.ok(panel, 'M1 fixture 必须包含可定位板');
  const rows = supportRowsFromGeometryParts(fixture.geometry.parts, { excludeIds: [PANEL_PART_ID] });
  const supportOf = (input) => resolvePanelSupport({
    parts: input,
    panel: { ...PANEL, centerXMm: panel.centerXMm, centerYMm: panel.centerYMm },
    bottomZmm: panel.bottomZmm,
    pose: 'carried',
    supportSource: 'fixture'
  });
  const cleanSupport = supportOf(rows);
  assert.equal(cleanSupport.claim, 'supported', '干净行表是 supported —— 作为「NaN 行确实会改变结论」的对照');
  const contact = cleanSupport.contacts[0];
  assert.ok(contact, '需要一条真实接触件，否则测不到覆盖被顶高');
  const poisoned = supportOf(rows.map((row) => (
    row.id === contact.partId ? { ...row, maxZ: Number.NaN } : row
  )));
  assert.equal(poisoned.contacts.some((entry) => entry.partId === contact.partId), false,
    '坐标读不出的行不许当接触件（NaN 不等于「刚好贴面」）');
  assert.deepEqual(poisoned.invalidPartIds, [contact.partId], '坏行必须点名');
  assert.equal(poisoned.diagnosticCode, 'invalid-support-rows');
  assert.equal(poisoned.claim, 'diagnostic-only', '坏行在场 → claim 只能是诊断，不许 supported');
  const withoutRow = supportOf(rows.filter((row) => row.id !== contact.partId));
  assert.deepEqual(poisoned.contacts, withoutRow.contacts, 'NaN 行必须等价于「该行不存在」');
  assert.equal(poisoned.coveredPct, withoutRow.coveredPct, 'NaN 行不许顶高覆盖率');
  assert.equal(poisoned.bandsY.length, withoutRow.bandsY.length);
  assert.ok(poisoned.coveredPct < cleanSupport.coveredPct,
    `接触行弄坏后覆盖率必须下降（clean=${cleanSupport.coveredPct} / poisoned=${poisoned.coveredPct}）`);

  // 0b) 判据行为（N14）：克隆**生产几何**、把一件承托面 GeomPart 的中心写成 NaN
  const resolvedProd = resolveMachineGeometry(fixture.config);
  const shelfPart = resolvedProd.geometry.parts.find((candidate) => /^tray-\d+$/.test(candidate.id));
  assert.ok(shelfPart, '生产几何里必须有 tray-<n> 承托件，否则 N14 判据测不到');
  const poisonedGeometry = {
    ...resolvedProd.geometry,
    parts: resolvedProd.geometry.parts.map((candidate) => (candidate.id === shelfPart.id
      ? { ...candidate, center: [Number.NaN, candidate.center[1], candidate.center[2]] }
      : candidate))
  };
  const poisonedPlate = panelSourceOfGeometry(poisonedGeometry);
  assert.equal(poisonedPlate?.inCollisionSet, true, '污染承托件不许伤到板身份（板仍在 parts 里）');
  const shelfOutcome = checkPanelChannel({ config: fixture.config, geometry: poisonedGeometry });
  assert.equal(shelfOutcome.ok, true);
  if (!shelfOutcome.ok) return;
  assert.equal(shelfOutcome.rowsSource, 'geometry', '行表仍来自几何（坏的是承托件，不是来源）');
  assert.equal(shelfOutcome.mode, 'verified', '行表来自几何 + 板仍在碰撞集 → mode 不变');
  assert.equal(shelfOutcome.feasibility.feasible, false, '读不出承托面坐标 → 不许判可行');
  const shelfBlocker = shelfOutcome.feasibility.blockers
    .find((blocker) => blocker.reason === 'load-passes-shelf');
  assert.equal(shelfBlocker?.diagnosticCode, 'invalid-shelf-geometry');
  assert.deepEqual(shelfBlocker?.invalidShelfPartIds, [shelfPart.id], '坏件必须点名');
  assert.equal(shelfBlocker?.witness, null, 'witness 必须 null：不许拿其余可读件的最小值顶替');
  assert.match(shelfBlocker?.detail ?? '', /invalid-shelf-geometry/);
  assert.match(shelfBlocker?.detail ?? '', /无法量到遮挡件 minZ 底面/, 'detail 必须说明量不出来（歧义）');
  assert.match(shelfBlocker?.detail ?? '', /不拿其余件的数字顶替/);

  const scriptPath = fileURLToPath(new URL('../../scripts/verify-channel.mjs', import.meta.url));
  const source = readFileSync(scriptPath, 'utf8');
  // 1) 静态门禁：负例、覆盖清单与变异锚点都必须在
  assert.match(source, /const FORGED_PANEL_MODE = 'diagnostic-only';/,
    'verify-channel 必须保留可被变异自证的单行常量 FORGED_PANEL_MODE');
  assert.match(source, /const FORGED_PANEL_VARIANTS = \['tray-id', 'role', 'size', 'center', 'rotationZDeg'\];/,
    'N12 覆盖清单必须是单行常量（稳定输出与变异都靠它）');
  assert.match(source, /N12 同 id 伪造/, 'verify-channel 必须保留同 id 伪板负例（N12）');
  assert.match(source, /rotationZDeg=90°/, 'N12 必须覆盖朝向伪造（同 id/role/size/center 但转 90°）');
  assert.match(source, /size 缩小 1 mm/, 'N12 必须覆盖尺寸伪造');
  assert.match(source, /N13 承托行 maxZ=NaN/, 'verify-channel 必须保留非有限承托行 fail-closed 自证（N13）');
  assert.match(source, /invalid-support-rows/, 'N13 必须断言无效承托行诊断码');
  assert.match(source, /maxZ: Number\.NaN/, 'N13 必须真的把一条承托行的 maxZ 注入 NaN（变异锚点）');
  assert.match(source, /N14 生产几何里承托件 center\.x\/z=NaN/,
    'verify-channel 必须保留承托面几何 fail-closed 自证（N14，名字里点名生产几何 + x/z）');
  assert.match(source, /shelf\.diagnosticCode === 'invalid-shelf-geometry'/,
    'N14 必须断言 blocker 的 diagnosticCode=invalid-shelf-geometry（断言锚点，不是注释）');
  assert.match(source, /expect\(shelf\.witness === null/,
    'N14 必须断言 witness=null（不许拿其余可读承托面顶替）');
  assert.match(source, /index === axis \? Number\.NaN : value/,
    'N14 必须真的把一件承托面 GeomPart 的中心（x/z）注入 NaN（变异锚点）');
  assert.match(source, /id: 'tray-2'/, 'N12 必须真的把占位体 id 改成 parts 里存在的 tray-2');
  assert.match(source, /checkPanelChannel\(\{ config, geometry: resolved\.geometry \}\)/,
    '生产几何独立复核必须直接调 checkPanelChannel（不借件表/夹具）');

  const runScript = (path) => spawnSync(process.execPath, [path, '--levels', '2', '--json'], {
    encoding: 'utf8',
    cwd: dirname(path),
    timeout: 120_000
  });
  const summaryOf = (result) => JSON.parse(result.stdout.trim().split('\n').pop());
  const failedNamesOf = (result) => (summaryOf(result).checks ?? [])
    .filter((entry) => !entry.ok)
    .map((entry) => entry.name);

  const baseline = runScript(scriptPath);
  assert.equal(baseline.status, 0, `verify:channel 基线应退 0：${(baseline.stdout + baseline.stderr).slice(-1200)}`);
  const baseSummary = summaryOf(baseline);
  assert.equal(baseSummary.ok, true);
  // 编号口径必须准确：N1..N14，13 正 + 14 负 = 27（多一条/少一条都要在这里现形）
  assert.deepEqual(baseSummary.counts, { total: 27, positive: 13, negative: 14 });
  const negativeNames = (baseSummary.checks ?? [])
    .map((entry) => entry.name)
    .filter((name) => /^N\d/.test(name))
    .map((name) => name.match(/^N(\d+)/)[1]);
  assert.deepEqual(negativeNames, Array.from({ length: 14 }, (_, index) => String(index + 1)),
    '负向编号必须连续且正好 N1..N14');
  // N14 的 fail-closed 回执必须进稳定输出（真实跑出来的，不是脚本里写死的）
  assert.match(baseSummary.shelfFailClosed?.partId ?? '', /^tray-\d+$/,
    `shelfFailClosed.partId=${baseSummary.shelfFailClosed?.partId}`);
  assert.equal(baseSummary.shelfFailClosed?.diagnosticCode, 'invalid-shelf-geometry');
  assert.equal(baseSummary.shelfFailClosed?.witness, null);
  assert.equal(baseSummary.shelfFailClosed?.feasible, false);
  // 稳定输出必须点名 N12 的五个伪造维度（role/size/center/rotation + 同 id 托板）
  assert.deepEqual(baseSummary.forgedPanel, {
    mode: 'diagnostic-only',
    variants: ['tray-id', 'role', 'size', 'center', 'rotationZDeg']
  });
  // 生产几何独立复核的口径：verified 只代表「行表来自几何 + 板在碰撞集」，结论仍是红的
  assert.equal(baseSummary.production?.mode, 'verified');
  assert.equal(baseSummary.production?.rowsSource, 'geometry');
  assert.equal(baseSummary.production?.restClaim, 'unsupported');
  assert.equal(baseSummary.production?.carriedClaim, 'diagnostic-only');
  assert.equal(baseSummary.production?.feasible, false);
  assert.ok((baseSummary.production?.blockers ?? []).includes('load-passes-shelf'),
    `生产几何 blockers=${(baseSummary.production?.blockers ?? []).join('/')}`);

  const probePath = join(dirname(scriptPath), `.verify-channel-negative-probe-${process.pid}-${Date.now()}.mjs`);
  const mutations = [
    {
      label: 'N12（把伪板期望改成 verified）',
      pattern: 'const FORGED_PANEL_MODE = \'diagnostic-only\';',
      replacement: 'const FORGED_PANEL_MODE = \'verified\';',
      expect: /^N12/
    },
    {
      label: 'N13（移除注入的 NaN，坏行变干净）',
      pattern: '? { ...row, maxZ: Number.NaN }',
      replacement: '? { ...row, maxZ: row.maxZ }',
      expect: /^N13/
    },
    {
      label: 'N14（移除承托面中心的 NaN 注入，坏件变干净）',
      pattern: 'index === axis ? Number.NaN : value',
      replacement: 'value',
      expect: /^N14/
    }
  ];
  try {
    for (const mutation of mutations) {
      const mutated = source.replace(mutation.pattern, mutation.replacement);
      assert.notEqual(mutated, source, `${mutation.label}: 变异必须命中锚点（锚点漂了就先改这个测试）`);
      writeFileSync(probePath, mutated);
      const broken = runScript(probePath);
      assert.equal(broken.status, 1,
        `${mutation.label}: 改坏后 verify:channel 必须退 1（否则那条负例根本没在守）`);
      const failed = failedNamesOf(broken);
      assert.ok(failed.some((name) => mutation.expect.test(name)),
        `${mutation.label}: 失败项必须包含对应编号（实际 ${failed.join(' / ')}）`);
    }
  } finally {
    rmSync(probePath, { force: true });
  }
});
