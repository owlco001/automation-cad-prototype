#!/usr/bin/env node
/**
 * M1「首层承托取放」升降通道诊断：`npm run verify:channel`。
 *
 * 它量的是**概念验证**这一层，不启动 Electron、不进内核、不读受保护的 userData：
 * 全部输入都来自 `buildBufferTowerParts()` / `resolveMachineGeometry()` 现构造的件表与
 * `panel-channel.ts` 的纯函数。
 *
 * **本脚本不写死数字**（P1 审查的教训）：
 * - 件数、层相关量一律从 `parts` / `params` 派生，不写 146、不写「16 层」、不写「≥400 处」；
 * - 行程/净跨/走廊只校验**关系**（`required = (levels−1)·pitch + 6.5 + 10`、`xClear = 2×|柱外侧|`、
 *   `shortfall = 需求 − 实测`），不把某一层数的结果当常量；
 * - 板位姿**显式传入**：真实塔用几何里的 `workpiecePlaceholder`，M1 夹具用几何里的板件
 *   （`center[0..1]` + `center[2]−半厚`）。缺位姿就抛错，本脚本不兜 900/0。
 *
 * 为什么「不可行」也要 exit 0：这个脚本是**诊断**，不是发布门禁。多层通道不可行是
 * 本轮的真实结论（feasible:false + blockers），把它当失败退出会让调用方以为「诊断跑挂了」。
 * 只有**负向自证失败**（该红的没红、该拒的没拒）才非零退出 —— 那才说明尺子本身坏了。
 *
 * 用法：
 *   npm run verify:channel                 # 缺省 16 层，人类可读
 *   npm run verify:channel -- --levels N   # 2..64 层都跑同一组关系断言（件数/行程/净跨/走廊全派生）
 *   npm run verify:channel -- --json       # 末尾多一行 JSON 摘要
 *
 * **层数边界（实测，必须一起读）**：通道判据本身与层数无关（件表、行程、净跨、走廊全部派生），
 * 但基线建造器在 **17 层起**会让 `gearmotor` 与 `column-bl` 相交 1 对 —— 柱截面随塔高派生
 * （`columnSection = ceil5(h/48)`）导致柱位外移，`buffer-tower-assembly.ts` 里「塔架往里收一个柱位」
 * 的缓解只在 ≤16 层成立。这是**建造器几何问题，与板/通道无关**：脚本把它单列为 `baselineNotes`，
 * 不计入通道自证（也不假装 rest/lift 全 0）；除这一对之外的任何 rest/lift 命中仍然判失败。
 *
 * 退出码：0 = 诊断成功（含 feasible:false）/ 1 = 负向自证或数值断言失败 / 2 = 用法错误。
 */
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../src/machine/buffer-tower-assembly.ts';
import { resolveMachineGeometry } from '../src/machine/machine-geometry.ts';
import { runInterferenceStates } from '../src/machine/interference-states.ts';
import {
  M1_PICK_PLACE,
  PANEL_PART_ID,
  PanelChannelError,
  TOWER_CHANNEL_STROKE,
  checkPanelChannel,
  liftAxisOfGeometry,
  panelSourceOfGeometry,
  resolveChannelFeasibility,
  resolvePanelSupport,
  supportRowsFromConveyorParts,
  supportRowsFromGeometryParts
} from '../src/machine/panel-channel.ts';
import { M1_PANEL, m1ChannelFixture, m1TowerConfig } from '../test-support/m1-channel-fixture.mjs';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const levelsArg = args.indexOf('--levels');
const levels = levelsArg >= 0 ? Number(args[levelsArg + 1]) : 16;
if (!Number.isSafeInteger(levels) || levels < 2 || levels > 64) {
  console.error(`verify:channel: --levels 必须是 2..64 的整数（收到 ${args[levelsArg + 1]}）`);
  process.exit(2);
}

const lines = [];
const checks = [];
const say = (text) => {
  lines.push(text);
  if (!jsonMode) console.log(text);
};
/** 一条自证：失败只记账，最后统一决定退出码 */
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail ?? '' });
    if (!jsonMode) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    if (!jsonMode) console.log(`  ✖ ${name} — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, tolerance = 0.02) => Math.abs(Number(actual) - expected) <= tolerance;
const show = (value) => Math.round(Number(value) * 100) / 100;
/**
 * 基线几何的**已知** rest/lift 重叠（不是通道判据）：柱截面随塔高派生 → 柱位外移，
 * `gearmotor` 与后排柱在 levels≥17 相交 1 对（≤16 层为 0）。单列、不计入通道自证；
 * 除这一族之外的任何 rest/lift 命中仍然判失败。
 */
const BASELINE_REST_LIFT_PAIR = /^gearmotor\|column-/;
const baselineNotes = [];
/** 把一态上的命中对拆成「基线几何（gearmotor×column-*）」与「与板/通道相关」两类 */
const classifyRestLift = (summary) => {
  const pairs = (summary?.items ?? []).map((item) => `${item.a}|${item.b}`);
  return {
    pairs,
    baseline: pairs.filter((pair) => BASELINE_REST_LIFT_PAIR.test(pair)),
    channelRelated: pairs.filter((pair) => !BASELINE_REST_LIFT_PAIR.test(pair))
  };
};

say(`M1 升降通道诊断（纯数据：${levels} 层、板 ${M1_PANEL.lengthMm}×${M1_PANEL.widthMm}×${M1_PANEL.thicknessMm}）`);
say('不启动 Electron、不进 build123d 内核、不读 userData；只驱动件表与纯函数');

/* ------------------------------------------------------------------ *
 * 0) 真实塔件表 + 几何：位姿只从几何取，件数只从建造器取
 * ------------------------------------------------------------------ */
const config = m1TowerConfig(levels);
const params = bufferTowerParamsFromConfig(config);
const parts = buildBufferTowerParts(params);
const resolved = resolveMachineGeometry(config);
const towerPlaceholder = panelSourceOfGeometry(resolved.geometry);
if (!towerPlaceholder) {
  console.error('verify:channel: 真实塔几何里没有板占位体，本诊断无法定位板位姿');
  process.exit(1);
}
/** 真实塔的板位姿：来自 geometry.workpiecePlaceholder（不写死 900/0） */
const towerPose = {
  bottomZmm: towerPlaceholder.bottomZmm,
  centerXMm: towerPlaceholder.centerXMm,
  centerYMm: towerPlaceholder.centerYMm
};
const towerAxis = liftAxisOfGeometry(resolved.geometry, PANEL_PART_ID);
say(`\n[0] 真实塔：${parts.length} 件（levels=${levels}）· 板位姿来自 ${towerPlaceholder.poseSource}`
  + `（底 ${show(towerPose.bottomZmm)}、中心 ${show(towerPose.centerXMm)},${show(towerPose.centerYMm)}）`);

/* ------------------------------------------------------------------ *
 * 1) 真实塔件表：行程 / 净跨 / 走廊 / blockers
 * ------------------------------------------------------------------ */
const feasibility = resolveChannelFeasibility({
  config,
  parts,
  pose: towerPose,
  poseSource: 'geometry.workpiecePlaceholder',
  supportSource: 'conveyor-parts'
});
const rows = supportRowsFromConveyorParts(parts);
say(`\n[1] 真实塔件表（buildBufferTowerParts 现构造）：${parts.length} 件`);
say(`    行程：声明 ${feasibility.stroke.declaredMm} / 需要 ${feasibility.stroke.requiredMm} / 缺 ${feasibility.stroke.shortfallMm}`);
say(`    净跨：${feasibility.clearSpan.xClearMm}（内侧面 ${feasibility.clearSpan.xClearInnerMm}）/ 板长 ${feasibility.clearSpan.requiredMm}`);
say(`    走廊：${feasibility.corridor.corridorMm} / 板半宽 ${feasibility.corridor.halfWidthMm}`);
say(`    承托：rest ${feasibility.panelSupport.rest.coveredPct}%（${feasibility.panelSupport.rest.bandsY.length} 带）`
  + `${feasibility.panelSupport.rest.claim} / carried ${feasibility.panelSupport.carried.coveredPct}%`
  + `（${feasibility.panelSupport.carried.bandsY.length} 带）${feasibility.panelSupport.carried.claim}`);
say(`    通道 feasible=${feasibility.feasible}，blockers=${feasibility.blockers.map((blocker) => blocker.reason).join('/')}`
  + `，designNotes=${feasibility.designNotes.map((note) => note.reason).join('/')}`);

check('行程不变量 = (levels−1)·pitch + trayTopOffset + forkHomeClearance（任何层数都成立）', () => {
  const required = (levels - 1) * params.layerPitchMm
    + TOWER_CHANNEL_STROKE.trayTopOffsetMm + TOWER_CHANNEL_STROKE.forkHomeClearanceMm;
  const declared = (levels - 1) * params.layerPitchMm;
  expect(near(feasibility.stroke.requiredMm, required), `required=${feasibility.stroke.requiredMm} 预期 ${required}`);
  expect(near(feasibility.stroke.declaredMm, declared), `declared=${feasibility.stroke.declaredMm} 预期 ${declared}`);
  expect(near(feasibility.stroke.shortfallMm, required - declared), `shortfall=${feasibility.stroke.shortfallMm}`);
  expect(feasibility.stroke.caliber.includes('M1 叉指停位'), '行程缺口必须标注 M1 叉指口径');
  return `缺 ${feasibility.stroke.shortfallMm} mm（levels=${levels}）`;
});
check('净跨只校验关系：xClear = 2×|柱外侧|，且不当作已证明的阻塞', () => {
  const columns = rows.filter((row) => /^column-/.test(row.id));
  expect(columns.length > 0, '件表里没有 column-* 件，净跨无从谈起');
  const xClear = 2 * Math.max(...columns.map((row) => Math.abs(row.minX)));
  expect(near(feasibility.clearSpan.xClearMm, xClear), `xClear=${feasibility.clearSpan.xClearMm} 预期 ${xClear}`);
  const blockerReasons = feasibility.blockers.map((blocker) => blocker.reason);
  expect(!blockerReasons.includes('clear-span'), `净跨不许进 blockers（实际 ${blockerReasons.join('/')}）`);
  if (feasibility.panel.lengthMm > feasibility.clearSpan.xClearMm) {
    const note = feasibility.designNotes.find((entry) => entry.reason === 'clear-span-conservative');
    expect(Boolean(note), '板长 > 净跨时必须有一条保守设计 note');
    expect(note.detail.includes('保守设计余量'), 'note 必须写「保守设计余量」而不是「过不去」');
    expect(!/任何整板(都)?过不去/.test(note.detail), 'note 不许写「任何整板过不去」');
  }
  return `净跨 ${feasibility.clearSpan.xClearMm} / 板长 ${feasibility.panel.lengthMm}（${feasibility.designNotes.length} 条设计 note）`;
});
check('走廊只校验关系：corridor = 柱内侧 − 托板半宽，同样不是 blocker', () => {
  const columns = rows.filter((row) => /^column-/.test(row.id));
  const trayRows = rows.filter((row) => /^tray-\d+$/.test(row.id));
  expect(trayRows.length > 0, '件表里没有 tray-* 件');
  const columnInnerY = Math.min(...columns.map((row) => Math.abs(row.maxY)));
  const trayHalf = Math.max(...trayRows.map((row) => Math.abs(row.maxY)));
  expect(near(feasibility.corridor.corridorMm, columnInnerY - trayHalf),
    `corridor=${feasibility.corridor.corridorMm} 预期 ${columnInnerY - trayHalf}`);
  expect(near(feasibility.corridor.halfWidthMm, feasibility.panel.widthMm / 2), 'halfWidth 必须 = 板宽/2');
  const blockerReasons = feasibility.blockers.map((blocker) => blocker.reason);
  expect(!blockerReasons.includes('corridor-too-narrow'), '走廊不许进 blockers');
  return `走廊 ${feasibility.corridor.corridorMm} / 板半宽 ${feasibility.corridor.halfWidthMm}`;
});
check('柱与板体 AABB 实测不相交 → 净跨/走廊不得当阻塞证据', () => {
  const sweep = feasibility.columnSweep;
  expect(sweep.columnPartIds.length > 0, '没有柱件');
  expect(sweep.intersectingPartIds.length === 0, `实测相交件 ${sweep.intersectingPartIds.join(',')}`);
  expect(sweep.yOverlapMm === 0, `y 向重叠 ${sweep.yOverlapMm} ≠ 0`);
  expect(sweep.note.includes('不是已证明的阻塞'), 'note 必须写明这不是已证明的阻塞');
  return `y 向重叠 0、${sweep.columnPartIds.length} 根柱全不相交`;
});
check('多层不可行：feasible=false，blockers 只收可复算事实（含 load-passes-shelf）', () => {
  const reasons = feasibility.blockers.map((blocker) => blocker.reason);
  expect(feasibility.feasible === false, 'feasible 必须为 false');
  expect(reasons.includes('load-passes-shelf'), `缺 load-passes-shelf（实际 ${reasons.join('/')}）`);
  const allowed = new Set(['load-passes-shelf', 'no-support', 'stroke-shortfall']);
  for (const reason of reasons) expect(allowed.has(reason), `blocker ${reason} 不在允许集合内`);
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  expect((shelf?.zBand[0] ?? 0) > towerPose.bottomZmm, '挡路承托面必须在板底之上');
  expect((shelf?.diagnosticCode ?? '') === 'invalid-shelf-geometry' || !shelf?.diagnosticCode,
    `diagnosticCode=${shelf?.diagnosticCode}`);
  expect(!/26 处|446 处/.test(shelf?.detail ?? ''), 'blocker detail 不许写死旧版实测件数');
  return reasons.join('/');
});
check('自由上升 witness：由件表最低遮挡件派生（板顶/板底两个口径），且不写死', () => {
  const shelf = feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  expect(Boolean(shelf), '缺 load-passes-shelf');
  const witness = shelf?.witness;
  expect(Boolean(witness), 'witness 必须存在（算不出时应为 null 并由 detail 说明，不许假绿）');
  if (!witness) throw new Error('witness=null');
  // 独立重算：承托件族 ∩ 板投影内 ∩ 板顶以上 ∩ 顶层以下，取最低 minZ
  const panelTop = towerPose.bottomZmm + M1_PANEL.thicknessMm;
  const reRows = rows.filter((row) => /^(tray-\d+|tray-rail-|stop-|tray-roller-|layer-sensor-)/.test(row.id)
    && row.maxZ > panelTop + 0.02
    && row.maxZ <= params.topLayerZMm + TOWER_CHANNEL_STROKE.trayTopOffsetMm + 0.02
    && Math.max(row.minX, -M1_PANEL.lengthMm / 2) < Math.min(row.maxX, M1_PANEL.lengthMm / 2)
    && Math.max(row.minY, -M1_PANEL.widthMm / 2) < Math.min(row.maxY, M1_PANEL.widthMm / 2));
  const lowest = Math.min(...reRows.map((row) => row.minZ));
  expect(near(witness.measuredFreeRiseFromPanelTopMm, lowest - panelTop, 0.02),
    `距板顶 ${witness.measuredFreeRiseFromPanelTopMm} 预期 ${lowest - panelTop}`);
  expect(near(witness.measuredFreeRiseFromPanelBottomMm, lowest - towerPose.bottomZmm, 0.02),
    `距板底 ${witness.measuredFreeRiseFromPanelBottomMm} 预期 ${lowest - towerPose.bottomZmm}`);
  expect(near(witness.measuredFreeRiseFromPanelBottomMm - witness.measuredFreeRiseFromPanelTopMm,
    M1_PANEL.thicknessMm, 0.02), '两个口径必须正好差一个板厚');
  const lowestRows = reRows.filter((row) => Math.abs(row.minZ - lowest) < 0.02).map((row) => row.id).sort();
  expect(JSON.stringify(witness.firstObstructionPartIds) === JSON.stringify(lowestRows),
    `首件 ${witness.firstObstructionPartIds.join(',')} 预期 ${lowestRows.join(',')}`);
  expect(witness.measuredFreeRiseFromPanelTopMm < params.layerPitchMm, '自由上升必须小于层距（否则不构成 load-passes-shelf）');
  return `距板顶 ${witness.measuredFreeRiseFromPanelTopMm} / 距板底 ${witness.measuredFreeRiseFromPanelBottomMm}，首件 ${witness.firstObstructionPartIds.join('/')}`;
});
check('单条 1200 整带 → claim 降级 diagnostic-only（覆盖 100% 不等于被托住）', () => {
  const { rest, carried } = feasibility.panelSupport;
  // 真实塔的静止态：整块板落在 1 条 1200 宽带上 → 覆盖率 100%，但 minBands=2 这条独立判死。
  // 这是**阈值关系**（单点/单条没有抗倾覆），不是「几何上托不住」的实测结论。
  expect(rest.bandsY.length === 1, `contact bands=${rest.bandsY.length}（真实塔应是 1 条整带）`);
  expect(rest.verdict === 'unsupported', `rest verdict=${rest.verdict}`);
  expect(rest.reasons.some((reason) => /接触带 1 条（阈值 ≥\d+）/.test(reason)),
    'reasons 必须写明「接触带条数 < 阈值」，不许写成几何上看不出承托');
  expect(carried.claim !== 'supported', `carried claim=${carried.claim}`);
  expect(carried.panelBottomZmm === rest.panelBottomZmm,
    '没有位移证据时 carried 底面必须等于静止底面（不许编 910）');
  expect(feasibility.m1.feasible === false, 'm1.feasible 必须是 false');
  expect(Boolean(feasibility.m1.diagnosticError), '必须给出诊断错误原因');
  return `${rest.coveredPct}% / ${rest.bandsY.length} 带 → ${rest.claim}；${feasibility.m1.diagnosticError}`;
});

/* ------------------------------------------------------------------ *
 * 2) 真实塔几何：件数语义 + 只读占位体 + 三态（件数从建造器派生）
 * ------------------------------------------------------------------ */
say('\n[2] 真实塔几何 / 三态（判据未改）');
const states = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config });
check('几何件数 = 建造器件数 + 1（板）、装配件数 = 建造器件数、板是真实碰撞件', () => {
  expect(resolved.assemblyPartCount === parts.length, `assemblyPartCount=${resolved.assemblyPartCount} vs 件表 ${parts.length}`);
  expect(resolved.partCount === parts.length + 1, `partCount=${resolved.partCount} vs 件表 ${parts.length}+1`);
  expect(resolved.geometry.parts.length === parts.length + 1, `几何刚体 ${resolved.geometry.parts.length}`);
  const plate = resolved.geometry.parts.find((part) => part.id === PANEL_PART_ID);
  expect(Boolean(plate), '板必须在 parts 里（真实碰撞件）');
  expect(plate?.role === 'workpiece' && plate?.moving === false, '板 role=workpiece、moving=false（不随轴走）');
  const placeholder = resolved.geometry.workpiecePlaceholder;
  expect(Boolean(placeholder), '缺 workpiecePlaceholder');
  expect(placeholder?.material === 'PV-GLASS' && placeholder?.role === 'workpiece', '占位体材质/角色不对');
  // 占位体是同一件的投影：中心/尺寸与 parts 里那件逐字段一致
  expect(JSON.stringify(placeholder?.center) === JSON.stringify(plate?.center), '占位体 center 必须由 parts 里那件派生');
  expect(JSON.stringify(placeholder?.sizeMm) === JSON.stringify(plate?.shape?.size), '占位体 sizeMm 必须由 parts 里那件派生');
  expect(placeholder?.inCollisionSet === true, '板在 parts 里 → 派生的 inCollisionSet 必须是 true');
  return `${parts.length} 装配 + 板 = ${resolved.partCount} 刚体；板 ${placeholder?.sizeMm.join('×')}@${placeholder?.bottomZmm}`;
});
check('rest/lift：通道相关命中 0（基线 gearmotor×column-* 单列，不计入通道自证）', () => {
  expect(states.ok === true, '三态检查必须能跑');
  if (!states.ok) throw new Error(states.message);
  const { sweep } = states.states;
  // 逐对读 items（不只看计数）：计数为 0 与「计数有 1 但对是基线」是两种不同事实，回执不许糊在一起
  const restLift = ['rest', 'lift'].map((key) => classifyRestLift(states.states[key]));
  const baseline = restLift.flatMap((entry) => entry.baseline);
  const channelRelated = restLift.flatMap((entry) => entry.channelRelated);
  expect(channelRelated.length === 0, `rest/lift 出现与板/通道相关的命中：${channelRelated.join(',')}`);
  if (levels <= 16) {
    expect(baseline.length === 0, `levels=${levels}（≤16）时 rest/lift 必须全 0，实测基线命中 ${baseline.join(',')}`);
  }
  for (const pair of new Set(baseline)) baselineNotes.push(`真实塔 rest/lift ${pair} ×${baseline.filter((entry) => entry === pair).length}`);
  expect(sweep.reviewStatus === 'fail', `sweep=${sweep.reviewStatus}（levels=${levels} 应仍 fail）`);
  expect(sweep.confirmedHits > 0, `sweep confirmedHits=${sweep.confirmedHits}`);
  return baseline.length === 0
    ? `rest/lift 0 命中；sweep fail ${sweep.confirmedHits}+${sweep.screenHits}`
    : `rest/lift 通道相关 0 命中（基线 ${baseline.length} 对 gearmotor×column-*，建造器问题，见 baselineNotes）`
      + `；sweep fail ${sweep.confirmedHits}+${sweep.screenHits}`;
});

/* 生产几何独立复核：**不借**件表（ConveyorPart）那条路、也不借 M1 夹具，直接让 checkPanelChannel
 * 从 geometry.parts 读行表。这里必须同时钉住两件事：
 *   1. 生产几何够格 `verified`（行表来自几何 + 碰撞集里有这块板）—— 否则夹具的绿不覆盖生产几何；
 *   2. `verified` **不是** supported/feasible：生产塔 rest 仍 unsupported（单条 1200 整带）、
 *      carried 仍 diagnostic-only（板不挂轴）、feasible=false（load-passes-shelf + stroke-shortfall）。
 * 只判第 1 条会把「几何里有板」读成「承托成立/通道可行」，这一条就是防它。 */
const production = checkPanelChannel({ config, geometry: resolved.geometry });
check('生产几何独立复核：checkPanelChannel(geometry) = verified/几何行表，但 rest unsupported、carried 诊断、feasible=false', () => {
  expect(production.ok === true, production.ok ? '' : `${production.code} ${production.message}`);
  if (!production.ok) throw new Error(`${production.code} ${production.message}`);
  // 第 1 条：够格 verified —— 行表与位姿都必须来自几何，而不是调用方给的
  expect(production.mode === 'verified', `mode=${production.mode}（板在碰撞集 → 应为 verified）`);
  expect(production.rowsSource === 'geometry', `rowsSource=${production.rowsSource}`);
  expect(production.panelSupport.rest.supportSource === 'geometry',
    `rest.supportSource=${production.panelSupport.rest.supportSource}`);
  expect(production.panelSource.inCollisionSet === true, '板必须在碰撞件集里（verified 的另一半证据）');
  expect(production.pose.source.includes('geometry'), `pose.source=${production.pose.source}`);
  // 独立复核用的行表是几何件表（147 件里除板 146 行），必须与件表口径给同一组承托数字
  expect(production.panelSupport.rest.bandsY.length === feasibility.panelSupport.rest.bandsY.length,
    `几何行表接触带 ${production.panelSupport.rest.bandsY.length} ≠ 件表 ${feasibility.panelSupport.rest.bandsY.length}`);
  expect(near(production.panelSupport.rest.coveredPct, feasibility.panelSupport.rest.coveredPct, 0.05),
    `几何行表覆盖 ${production.panelSupport.rest.coveredPct}% ≠ 件表 ${feasibility.panelSupport.rest.coveredPct}%`);
  // 第 2 条：verified ≠ supported/feasible —— 生产结论必须仍是红的
  expect(production.panelSupport.rest.claim === 'unsupported',
    `生产 rest claim=${production.panelSupport.rest.claim}（单条 1200 整带不许算 supported）`);
  expect(production.panelSupport.rest.bandsY.length === 1, `生产 rest 接触带=${production.panelSupport.rest.bandsY.length}（应 1 条整带）`);
  expect(production.panelSupport.carried.claim === 'diagnostic-only',
    `生产 carried claim=${production.panelSupport.carried.claim}（板不随塔轴移动）`);
  expect(production.feasibility.feasible === false, 'verified 不许把多层通道判成可行');
  const productionBlockers = production.feasibility.blockers.map((blocker) => blocker.reason);
  expect(productionBlockers.length > 0, 'feasible=false 必须带 blockers');
  for (const reason of ['load-passes-shelf', 'stroke-shortfall']) {
    expect(productionBlockers.includes(reason), `缺 blocker ${reason}（实际 ${productionBlockers.join('/')}）`);
  }
  expect(production.feasibility.m1.feasible === false, '生产几何没有叉指 → m1.feasible 必须 false');
  return `mode=${production.mode}/rows=${production.rowsSource}，但 rest=${production.panelSupport.rest.claim}、`
    + `carried=${production.panelSupport.carried.claim}、feasible=false（${productionBlockers.join('/')}）`;
});
say('    ↑ verified 只说明「行表来自几何 + 碰撞集里有这块板」：不等于 supported、也不等于通道可行');

/* ------------------------------------------------------------------ *
 * 3) M1 概念件表：首层承托取放（这才是 M1 的绿）
 * ------------------------------------------------------------------ */
say('\n[3] M1 概念件表（夹具 + 板，20 mm 取放段）');
const m1 = m1ChannelFixture({ levels });
const m1Outcome = checkPanelChannel({ config: m1.config, geometry: m1.geometry });
if (!m1Outcome.ok) {
  console.error(`verify:channel: M1 夹具检查失败 ${m1Outcome.code} ${m1Outcome.message}`);
  process.exit(1);
}
const m1Feasibility = m1Outcome.feasibility;
const m1States = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: m1.config, geometry: m1.geometry });
say(`    件数：机台 ${m1.parts.length} / 几何刚体 ${m1.geometry.parts.length} / 装配 ${m1.geometry.assemblyPartCount}；包络 ${m1.geometry.envelope.map((value) => Math.round(value)).join('×')}`);
say(`    承托：rest ${m1Feasibility.panelSupport.rest.coveredPct}%（${m1Feasibility.panelSupport.rest.bandsY.length} 带）`
  + ` / carried ${m1Feasibility.panelSupport.carried.coveredPct}%（${m1Feasibility.panelSupport.carried.bandsY.length} 带）`
  + `，来源 ${m1Feasibility.panelSupport.rest.supportSource}@${m1Feasibility.pose.source}`);
check('M1 三态：通道相关命中 0（20 mm 段内板与机构无重叠；基线 gearmotor×column-* 单列）', () => {
  expect(m1States.ok === true, 'M1 三态检查必须能跑');
  if (!m1States.ok) throw new Error(m1States.message);
  const baseline = [];
  for (const key of ['rest', 'lift', 'sweep']) {
    const { baseline: base, channelRelated } = classifyRestLift(m1States.states[key]);
    expect(channelRelated.length === 0, `${key} 出现与板/通道相关的命中：${channelRelated.join(',')}`);
    baseline.push(...base);
  }
  for (const pair of new Set(baseline)) baselineNotes.push(`M1 夹具 ${pair} ×${baseline.filter((entry) => entry === pair).length}`);
  return baseline.length === 0
    ? 'rest/lift/sweep 全 0'
    : `通道相关 0；基线 ${baseline.length} 条 gearmotor×column-*（建造器问题，与板/通道无关）`;
});
check('M1 承托 rest/carried 都 supported，且带来源与位姿出处', () => {
  const { rest, carried } = m1Feasibility.panelSupport;
  expect(rest.verdict === 'supported' && rest.claim === 'supported', `rest=${rest.verdict}/${rest.claim}`);
  expect(carried.verdict === 'supported' && carried.claim === 'supported', `carried=${carried.verdict}/${carried.claim}`);
  // 2278×914/2583252 = 80.6%、2×2000×100/2583252 = 15.48%（文档 82.5/17 复算不符，不改阈值）
  expect(near(rest.coveredPct, 80.6, 0.05), `rest=${rest.coveredPct}`);
  expect(near(carried.coveredPct, 15.48, 0.05), `carried=${carried.coveredPct}`);
  expect(rest.supportSource === 'geometry', `supportSource=${rest.supportSource}`);
  expect(rest.poseSource.includes('geometry'), `poseSource=${rest.poseSource}`);
  expect(m1Feasibility.m1.carriedShiftSource === 'axis', `位移来源 ${m1Feasibility.m1.carriedShiftSource}`);
  return `rest ${rest.coveredPct}% / carried ${carried.coveredPct}%（阈值 ${rest.thresholds.minCoveredPct}%）`;
});
check('M1 件表的多层判定仍是 false（局部绿不覆盖全局）', () => {
  expect(m1Feasibility.feasible === false, 'M1 件表也应因 load-passes-shelf 判不可行');
  expect(m1Feasibility.m1.feasible === true, '首层 M1 段应为 true');
  return `m1.feasible=true, feasible=false, blockers=${m1Feasibility.blockers.map((blocker) => blocker.reason).join('/')}`;
});

/* ------------------------------------------------------------------ *
 * 4) 负向自证：该红的必须红、该拒的必须拒
 * ------------------------------------------------------------------ */
say('\n[4] 负向自证（不红 = 尺子坏了）');
/**
 * 同 id 伪造负例的期望口径。**单独成行**是为了让 `buffer-tower-channel.test.mjs` 跑变异体：
 * 把这一行改成 `'verified'` 后 `verify:channel` 必须非零退出（否则这条负例形同虚设）。
 */
const FORGED_PANEL_MODE = 'diagnostic-only';
/**
 * N12 覆盖的伪造维度。稳定输出按这份清单点名（`summary.forgedPanel.variants`），
 * 且脚本里断言「实际变体 == 这份清单」，防止 check 名自述的覆盖面再次夸大。
 * `tray-id` = 占位体 id 换成 parts 里真实存在的 `tray-2`（同 id 但身份不同）；
 * 其余四项 = 同 id 同 role 的板件分别在 role / size / center / rotationZDeg 上偏离。
 */
const FORGED_PANEL_VARIANTS = ['tray-id', 'role', 'size', 'center', 'rotationZDeg'];
check('N1 叉指在板外（y=±622）→ 承托 0%、unsupported', () => {
  const a2 = m1ChannelFixture({ levels, fingerYMm: 622, fingerWidthMm: 90, fingerTopZmm: 880, travelMm: 10 });
  const a2Rows = supportRowsFromGeometryParts(a2.geometry.parts, { shiftMm: 10, excludeIds: [PANEL_PART_ID] });
  const report = resolvePanelSupport({
    parts: a2Rows,
    panel: { ...M1_PANEL, centerXMm: 0, centerYMm: 0 },
    bottomZmm: 890,
    pose: 'carried',
    poseShiftMm: 10,
    supportSource: 'fixture'
  });
  expect(report.coveredPct === 0, `covered=${report.coveredPct}`);
  expect(report.contacts.length === 0, 'contacts 应为空');
  expect(report.verdict === 'unsupported', `verdict=${report.verdict}`);
  return '0% / contacts []';
});
check('N2 几何里没有板 → checkPanelChannel 必须 INVALID_ARGUMENT', () => {
  const noPanel = m1ChannelFixture({ levels, withPanel: false });
  const outcome = checkPanelChannel({ config: noPanel.config, geometry: noPanel.geometry });
  expect(outcome.ok === false, '没有板却返回 ok');
  expect(outcome.code === 'INVALID_ARGUMENT', `code=${outcome.code}`);
  return '拒绝而不是绿';
});
check('N3 叉指 120 宽 > 缝 110 → sweep 必须红且 blamed 指到叉指', () => {
  const wide = m1ChannelFixture({ levels, fingerWidthMm: 120 });
  const result = runInterferenceStates({ states: ['sweep'], config: wide.config, geometry: wide.geometry });
  expect(result.ok === true, '应能跑');
  if (!result.ok) throw new Error(result.message);
  expect(result.states.sweep.reviewStatus === 'fail', `status=${result.states.sweep.reviewStatus}`);
  expect(result.states.sweep.confirmedHits > 0, 'confirmedHits=0');
  const blamed = result.states.sweep.items.map((item) => `${item.a}|${item.b}`).join(',');
  expect(/lift-finger/.test(blamed), `blamed=${blamed}`);
  return `${result.states.sweep.confirmedHits} 对确认命中`;
});
check('N4 超行程 40 → 横梁进带上行程带（blamed 指到 lift-carriage）', () => {
  const over = m1ChannelFixture({ levels, travelMm: 40 });
  const result = runInterferenceStates({ states: ['sweep'], config: over.config, geometry: over.geometry });
  expect(result.ok === true, '应能跑');
  if (!result.ok) throw new Error(result.message);
  expect(result.states.sweep.confirmedHits > 0, 'confirmedHits=0');
  const blamed = result.states.sweep.items.map((item) => `${item.a}|${item.b}`).join(',');
  expect(/lift-carriage/.test(blamed) && /belt-top/.test(blamed), `blamed=${blamed}`);
  return `${result.states.sweep.confirmedHits} 对确认命中`;
});
check('N5 满行程 → sweep 必须红，且板/托板在 blamed 里（命中数从回执读，不写死）', () => {
  const full = m1ChannelFixture({ levels, travelMm: params.liftTravelMm });
  const result = runInterferenceStates({ states: ['sweep'], config: full.config, geometry: full.geometry });
  expect(result.ok === true, '应能跑');
  if (!result.ok) throw new Error(result.message);
  expect(result.states.sweep.reviewStatus === 'fail', `status=${result.states.sweep.reviewStatus}`);
  expect(result.states.sweep.confirmedHits > 0, `confirmedHits=${result.states.sweep.confirmedHits}`);
  const blamed = result.states.sweep.items.map((item) => `${item.a}|${item.b}`).join(',');
  expect(/workpiece-plate|tray-/.test(blamed), `blamed=${blamed}`);
  return `${result.states.sweep.confirmedHits} 处确认命中（levels=${levels}）`;
});
check('N6 非塔机型 → resolveChannelFeasibility 抛 NOT_A_TOWER', () => {
  try {
    resolveChannelFeasibility({
      config: { conveyor: { lengthMm: 2400, widthMm: 1200 } },
      pose: { bottomZmm: 900, centerXMm: 0, centerYMm: 0 }
    });
  } catch (error) {
    expect(error instanceof PanelChannelError && error.code === 'NOT_A_TOWER', '错误类型/编码不对');
    return '拒绝猜机型';
  }
  throw new Error('非塔机型竟然算出了通道可行性');
});
check('N7 板中心偏移 300 mm → 覆盖率必须变（旧实现 centerXMm 形同虚设）', () => {
  const base = m1Feasibility.panelSupport.rest;
  const shifted = checkPanelChannel({
    config: m1.config,
    geometry: m1.geometry,
    pose: { ...towerPose, bottomZmm: m1Outcome.pose.bottomZmm, centerXMm: 300, centerYMm: 0 }
  });
  expect(shifted.ok === true, '偏移位姿应能判');
  if (!shifted.ok) throw new Error(shifted.message);
  expect(shifted.pose.centerXMm === 300, `回显中心 ${shifted.pose.centerXMm}`);
  expect(shifted.panelSupport.rest.coveredPct !== base.coveredPct,
    `覆盖率没变（${shifted.panelSupport.rest.coveredPct} = ${base.coveredPct}）`);
  return `${base.coveredPct}% → ${shifted.panelSupport.rest.coveredPct}%`;
});
check('N8 轴位移 5 mm < 空行程 10 → 报告 5、carried 底面不变、m1.feasible=false', () => {
  const five = checkPanelChannel({ config: m1.config, geometry: m1.geometry, carriedShiftMm: 5 });
  expect(five.ok === true, '应能判');
  if (!five.ok) throw new Error(five.message);
  expect(five.feasibility.m1.carriedShiftMm === 5, `carriedShiftMm=${five.feasibility.m1.carriedShiftMm}（不许回 20）`);
  expect(five.feasibility.m1.boardLiftMm === 0, `boardLift=${five.feasibility.m1.boardLiftMm}`);
  expect(five.feasibility.panelSupport.carried.panelBottomZmm === five.feasibility.panelSupport.rest.panelBottomZmm,
    `carried 底面 ${five.feasibility.panelSupport.carried.panelBottomZmm} 必须等于静止底面`);
  expect(five.feasibility.panelSupport.carried.claim === 'diagnostic-only', 'carried 不许声称 supported');
  expect(five.feasibility.m1.feasible === false, 'm1.feasible 必须 false');
  expect(Boolean(five.feasibility.m1.diagnosticError), '必须给出诊断错误');
  return five.feasibility.m1.diagnosticError;
});
check('N9 合成旧几何（板移出 parts、placeholder 保留且伪 inCollisionSet:true）→ diagnostic-only', () => {
  // 生产几何现在**含板**（mode=verified）；门禁不能因此丢掉「板缺失必须 fail-closed」这条。
  // 构造旧几何：把板从 parts 移除、保留占位体并**故意**写 inCollisionSet:true —— 消费方必须按
  // parts 里有无同 id 件判定，不许信手写 flag。
  const oldGeometry = {
    ...resolved.geometry,
    parts: resolved.geometry.parts.filter((part) => part.id !== PANEL_PART_ID),
    workpiecePlaceholder: { ...resolved.geometry.workpiecePlaceholder, inCollisionSet: true }
  };
  const source = panelSourceOfGeometry(oldGeometry);
  expect(source?.inCollisionSet === false, 'parts 里没有板时，inCollisionSet 必须派生为 false（伪 true 不算）');
  const outcome = checkPanelChannel({ config, geometry: oldGeometry });
  expect(outcome.ok === true, '应能判');
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.mode === 'diagnostic-only', `mode=${outcome.mode}`);
  expect(outcome.panelSupport.rest.claim === 'diagnostic-only', `rest claim=${outcome.panelSupport.rest.claim}`);
  expect(outcome.panelSupport.carried.claim === 'diagnostic-only', `carried claim=${outcome.panelSupport.carried.claim}`);
  expect(outcome.feasibility.feasible === false, 'placeholder 路径不许 feasible=true');
  expect(outcome.feasibility.m1.feasible === false, 'placeholder 路径不许 m1.feasible=true');
  expect(outcome.note.includes('diagnosticOnly'), 'note 必须自报 diagnosticOnly');
  return `mode=${outcome.mode}（伪 inCollisionSet:true 被拒），夹具的 M1 绿不得写成生产塔可行`;
});
check('N10 缺板位姿 → resolveChannelFeasibility 必须 INVALID_ARGUMENT（不默认 900/0）', () => {
  try {
    resolveChannelFeasibility({ config, parts });
  } catch (error) {
    expect(error instanceof PanelChannelError && error.code === 'INVALID_ARGUMENT', '错误类型/编码不对');
    expect(/pose 必填/.test(error.message), `message=${error.message}`);
    return '拒绝缺位姿';
  }
  throw new Error('缺位姿竟然算出了承托结论');
});
check('N11 缺轴位移且无几何轴 → 不伪造 supported', () => {
  const noShift = resolveChannelFeasibility({
    config: m1.config,
    parts: m1.parts,
    pose: { ...towerPose, bottomZmm: m1Outcome.pose.bottomZmm },
    supportSource: 'fixture'
  });
  expect(noShift.m1.carriedShiftSource === 'missing', `位移来源 ${noShift.m1.carriedShiftSource}`);
  expect(noShift.m1.feasible === false, 'm1.feasible 必须 false');
  expect(noShift.panelSupport.carried.claim === 'diagnostic-only', 'carried 不许声称 supported');
  expect(Boolean(noShift.m1.diagnosticError), '必须给出诊断错误');
  return noShift.m1.diagnosticError;
});
check('N12 同 id 伪造：placeholder id→tray-2，以及同 id 板件的 role / size / center / rotationZDeg=90° 各伪造一次 → 全部 diagnostic-only', () => {
  const realPlate = resolved.geometry.parts.find((part) => part.id === PANEL_PART_ID);
  const placeholder = resolved.geometry.workpiecePlaceholder;
  expect(Boolean(realPlate) && Boolean(placeholder), '生产几何里必须有板件与占位体，否则伪造无从谈起');
  // 伪造 A（审查点名的那条）：占位体 id 写成 parts 里真实存在的 `tray-2`，尺寸/中心/底高**原样保留**。
  // 旧判据「同 id 就算在碰撞集」会在这里把 inCollisionSet 顶成 true —— 承托数字是板的、行表却来自托板。
  const sameId = {
    ...resolved.geometry,
    workpiecePlaceholder: { ...placeholder, id: 'tray-2', name: '伪造：同 id 的托板' }
  };
  const sameIdSource = panelSourceOfGeometry(sameId);
  expect(Boolean(sameIdSource), '伪造后仍能定位板位姿（位姿来自占位体，不该改用托盘）');
  expect(sameIdSource.inCollisionSet === false,
    'parts 里的 tray-2 不是这块板（role 不是 workpiece）→ inCollisionSet 必须派生为 false');
  expect(JSON.stringify(sameIdSource.panel) === JSON.stringify(production.panelSource.panel),
    '伪造 id 不得改板尺寸/中心：身份判据不认「换个 id 就换件」');
  expect(sameIdSource.bottomZmm === production.panelSource.bottomZmm, '伪造 id 不得改板底位姿');
  const variants = [
    { field: 'role', label: '同 id 但 role 改成 structure', geometry: {
      ...resolved.geometry,
      parts: resolved.geometry.parts.map((part) => (part.id === PANEL_PART_ID ? { ...part, role: 'structure' } : part))
    } },
    { field: 'size', label: '同 id/role/center 但 size 缩小 1 mm', geometry: {
      ...resolved.geometry,
      parts: resolved.geometry.parts.map((part) => (part.id === PANEL_PART_ID
        ? { ...part, shape: { ...part.shape, size: [part.shape.size[0] - 1, part.shape.size[1], part.shape.size[2]] } }
        : part))
    } },
    { field: 'center', label: '同 id/role 但 center 平移 50 mm', geometry: {
      ...resolved.geometry,
      parts: resolved.geometry.parts.map((part) => (part.id === PANEL_PART_ID
        ? { ...part, center: [part.center[0] + 50, part.center[1], part.center[2]] }
        : part))
    } },
    { field: 'rotationZDeg', label: '同 id/role/size/center 但 rotationZDeg=90°', geometry: {
      ...resolved.geometry,
      parts: resolved.geometry.parts.map((part) => (part.id === PANEL_PART_ID
        ? { ...part, rotationZDeg: 90 }
        : part))
    } }
  ];
  // 自述覆盖面必须与实际变体一一对应（上一版 check 名写了 size/rotation、实际只跑 role/center）
  const covered = ['tray-id', ...variants.map((variant) => variant.field)];
  expect(JSON.stringify(covered) === JSON.stringify(FORGED_PANEL_VARIANTS),
    `实际覆盖 ${covered.join('/')} ≠ 自述 ${FORGED_PANEL_VARIANTS.join('/')}`);
  const cases = [
    { field: 'tray-id', label: '1. 同 id 伪造 tray-2（占位体 id 指向 parts 里已有的托板）', geometry: sameId },
    ...variants.map((variant, index) => ({ ...variant, label: `${index + 2}. ${variant.label}` }))
  ];
  for (const { field, label, geometry } of cases) {
    expect(cases.filter((entry) => entry.field === field).length === 1, `${label}: 变体 id 必须唯一`);
    const source = panelSourceOfGeometry(geometry);
    expect(Boolean(source), `${label}: 必须仍能定位板位姿`);
    expect(source.inCollisionSet === false, `${label}: inCollisionSet 必须为 false`);
    const outcome = checkPanelChannel({ config, geometry });
    expect(outcome.ok === true, `${label}: 应能判（拒绝位姿缺失是另一条，不是这条）`);
    if (!outcome.ok) throw new Error(`${label}: ${outcome.code} ${outcome.message}`);
    expect(outcome.mode === FORGED_PANEL_MODE, `${label}: mode=${outcome.mode} 预期 ${FORGED_PANEL_MODE}`);
    expect(outcome.rowsSource === 'geometry', `${label}: rowsSource=${outcome.rowsSource}`);
    expect(outcome.panelSupport.rest.claim === 'diagnostic-only', `${label}: rest claim=${outcome.panelSupport.rest.claim}`);
    expect(outcome.panelSupport.carried.claim === 'diagnostic-only', `${label}: carried claim=${outcome.panelSupport.carried.claim}`);
    expect(outcome.feasibility.feasible === false, `${label}: 伪造件不许把通道判成可行`);
    expect(outcome.feasibility.m1.feasible === false, `${label}: 伪造件不许 m1.feasible=true`);
    expect(outcome.note.includes('diagnosticOnly'), `${label}: note 必须自报 diagnosticOnly`);
  }
  return `5 个变体（tray-id / role / size / center / rotationZDeg=90°）全部 mode=${FORGED_PANEL_MODE}（verified 只给同一工件身份）`;
});
/**
 * N13：`panel-channel.ts` 的 `hasFiniteBox` 必须在**接触判定之前**截住非有限行。
 * 这里刻意把 NaN 放在一条**真的在接触**的行上：旧实现 `abs(NaN − 900) > 1 === false` 会把该行
 * 当成贴面接触，覆盖率/接触带被顶高、回执却看不出异常。因此本负例必须证明三件事：
 *   ① 坏行被剔除（不在 contacts，supportPartCount 少 1）；
 *   ② 数字与「把该行删掉」逐项一致（NaN 不贡献面积、不被当接触）；
 *   ③ claim 只能是 diagnostic-only + diagnosticCode=invalid-support-rows。
 * `maxZ: Number.NaN` 那一行同时是 `buffer-tower-channel.test.mjs` 的变异锚点。
 */
check('N13 承托行 maxZ=NaN（落在真实接触行）→ 该行剔除、覆盖率不得被顶高、claim=diagnostic-only', () => {
  const fixture = m1ChannelFixture({ levels });
  const panel = panelSourceOfGeometry(fixture.geometry);
  expect(Boolean(panel), 'M1 fixture 必须包含可定位板');
  if (!panel) throw new Error('no panel');
  const supportRows = supportRowsFromGeometryParts(fixture.geometry.parts, { excludeIds: [PANEL_PART_ID] });
  const report = (rowsIn) => resolvePanelSupport({
    parts: rowsIn,
    panel: { ...M1_PANEL, centerXMm: panel.centerXMm, centerYMm: panel.centerYMm },
    bottomZmm: panel.bottomZmm,
    pose: 'carried',
    supportSource: 'fixture'
  });
  const clean = report(supportRows);
  expect(clean.claim === 'supported', `干净行表应 supported（否则对照失效，实际 ${clean.claim}）`);
  const target = supportRows.find((row) => clean.contacts.some((contact) => contact.partId === row.id));
  expect(Boolean(target), '干净行表里必须有接触件，否则测不到「覆盖被顶高」');
  if (!target) throw new Error('no contact row');
  const badRows = supportRows.map((row) => row.id === target.id ? { ...row, maxZ: Number.NaN } : row);
  const poisoned = report(badRows);
  expect(!poisoned.contacts.some((contact) => contact.partId === target.id),
    '坏行不许当接触件：NaN 不是「顶面刚好贴板底」');
  expect(poisoned.invalidPartIds.includes(target.id), `invalidPartIds=${poisoned.invalidPartIds.join('/')}`);
  expect(poisoned.diagnosticCode === 'invalid-support-rows', `diagnosticCode=${poisoned.diagnosticCode}`);
  expect(poisoned.claim === 'diagnostic-only', `坏坐标时 claim=${poisoned.claim}`);
  const removed = report(supportRows.filter((row) => row.id !== target.id));
  expect(JSON.stringify(poisoned.contacts) === JSON.stringify(removed.contacts),
    'NaN 行必须等价于「该行不存在」（不许贡献任何接触面积）');
  expect(near(poisoned.coveredPct, removed.coveredPct, 0.05) && poisoned.bandsY.length === removed.bandsY.length,
    `覆盖率/接触带被顶高：${poisoned.coveredPct}%/${poisoned.bandsY.length} 带`
      + ` vs 删行 ${removed.coveredPct}%/${removed.bandsY.length} 带`);
  expect(poisoned.supportPartCount === removed.supportPartCount,
    `参与判定件数 ${poisoned.supportPartCount} ≠ 删行 ${removed.supportPartCount}`);
  expect((poisoned.reasons[0] ?? '').includes('invalid-support-rows'), '根因必须放在第一条 reason');
  return `坏行 ${target.id} 剔除后 ${clean.coveredPct}%→${poisoned.coveredPct}%、`
    + `claim supported→diagnostic-only、contacts ${clean.contacts.length}→${poisoned.contacts.length}`;
});

/**
 * N14：生产几何里**一件承托面（shelf）GeomPart 的中心坐标读不出来**时，`load-passes-shelf`
 * 必须 fail-closed —— 这条走的是 `checkPanelChannel(geometry)` 的真实入口（几何行表 +
 * 碰撞集里的板），不是夹具、也不是调用方自带行表。
 *
 * 判据（`panel-channel.ts` 的 `hasFiniteBox` + `invalid-shelf-geometry`）要求四件事同时成立：
 *   ① 板身份与行表来源不受污染影响（`mode=verified`、`rowsSource=geometry`）——
 *      坏的是承托件，不是这块板，不许顺手把整份几何判成「没有板」；
 *   ② `feasible=false`：读不出坐标 = 不可排除挡路，既不声明可行、也不声明 no-support；
 *   ③ blocker 仍是 `load-passes-shelf`，带 `diagnosticCode=invalid-shelf-geometry` 并点名该件；
 *   ④ `witness=null`，detail 写明「无法量到遮挡件 minZ 底面 / 不拿其余件顶替」——
 *      其余读得出的承托面再多，也不许拿它们的最小值冒充（那是 fail-open）。
 * 只克隆生产几何、只改一件中心（x 与 z 各一次）；`center.map` 那一行同时是
 * `buffer-tower-channel.test.mjs` 的 N14 变异锚点（去掉 NaN 注入 → N14 必须自己红）。
 */
let shelfFailClosed = null;
check('N14 生产几何里承托件 center.x/z=NaN → load-passes-shelf 带 invalid-shelf-geometry、witness=null', () => {
  const shelfPart = resolved.geometry.parts.find((part) => /^tray-\d+$/.test(part.id));
  expect(Boolean(shelfPart), '生产几何里必须有 tray-<n> 承托件，否则这条负例测不到');
  if (!shelfPart) throw new Error('no shelf part');
  // 对照：同一份几何不污染时 witness 有值、没有诊断码 —— 后面的红必须由 NaN 引起
  const clean = checkPanelChannel({ config, geometry: resolved.geometry });
  expect(clean.ok === true, '干净生产几何应能判');
  if (!clean.ok) throw new Error(clean.message);
  const cleanShelf = clean.feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
  expect(Boolean(cleanShelf?.witness), '干净生产几何必须量出自由上升 witness（否则对照失效）');
  expect(cleanShelf?.diagnosticCode === undefined, `干净几何不该有 diagnosticCode（实际 ${cleanShelf?.diagnosticCode}）`);
  for (const axis of [0, 2]) {
    const axisName = axis === 0 ? 'x' : 'z';
    const poisonedGeometry = {
      ...resolved.geometry,
      parts: resolved.geometry.parts.map((part) => (part.id === shelfPart.id
        ? { ...part, center: part.center.map((value, index) => (index === axis ? Number.NaN : value)) }
        : part))
    };
    // ① 板身份 / 行表来源必须仍在：污染的是承托件，不是板
    const source = panelSourceOfGeometry(poisonedGeometry);
    expect(Boolean(source), `center.${axisName}=NaN: 仍必须能定位板位姿`);
    expect(source?.id === PANEL_PART_ID && source?.inCollisionSet === true,
      `center.${axisName}=NaN: 板身份必须原样保留（id=${source?.id}、inCollisionSet=${source?.inCollisionSet}）`);
    const outcome = checkPanelChannel({ config, geometry: poisonedGeometry });
    expect(outcome.ok === true, `center.${axisName}=NaN: 应能判（坏的是承托件，不是入参）`);
    if (!outcome.ok) throw new Error(`${axisName}: ${outcome.code} ${outcome.message}`);
    expect(outcome.rowsSource === 'geometry', `center.${axisName}=NaN: rowsSource=${outcome.rowsSource}`);
    expect(outcome.mode === 'verified', `center.${axisName}=NaN: mode=${outcome.mode}（行表仍来自几何 + 板仍在碰撞集）`);
    // ② 读不出坐标不许判可行
    expect(outcome.feasibility.feasible === false, `center.${axisName}=NaN: 通道不许判成可行`);
    // ③ blocker 仍在，且把「读不出」写成诊断码 + 件号
    const shelf = outcome.feasibility.blockers.find((blocker) => blocker.reason === 'load-passes-shelf');
    expect(Boolean(shelf), `center.${axisName}=NaN: 缺 load-passes-shelf（不可排除挡路必须仍是 blocker）`);
    if (!shelf) throw new Error(`${axisName}: no shelf blocker`);
    expect(shelf.diagnosticCode === 'invalid-shelf-geometry',
      `center.${axisName}=NaN: diagnosticCode=${shelf.diagnosticCode}`);
    expect(JSON.stringify(shelf.invalidShelfPartIds) === JSON.stringify([shelfPart.id]),
      `center.${axisName}=NaN: invalidShelfPartIds=${(shelf.invalidShelfPartIds ?? []).join('/')} 预期 ${shelfPart.id}`);
    // ④ 不许拿其余可读承托面顶替
    expect(shelf.witness === null, `center.${axisName}=NaN: witness 必须 null（不许拿其余件的最小值冒充）`);
    expect(/invalid-shelf-geometry/.test(shelf.detail), `center.${axisName}=NaN: detail 必须点名诊断码`);
    expect(/无法量到遮挡件 minZ 底面/.test(shelf.detail), `center.${axisName}=NaN: detail 必须说明量不出来（歧义）`);
    expect(/不拿其余件的数字顶替/.test(shelf.detail) && /不当作可行依据/.test(shelf.detail),
      `center.${axisName}=NaN: detail 必须写清不顶替、不当可行依据`);
    shelfFailClosed = {
      partId: shelfPart.id,
      axis: 'x/z',
      diagnosticCode: shelf.diagnosticCode,
      witness: shelf.witness,
      feasible: outcome.feasibility.feasible
    };
  }
  return `${shelfPart.id}.center.x/z=NaN → witness=null、diagnosticCode=invalid-shelf-geometry、`
    + `invalid=[${shelfPart.id}]、feasible=false（板仍在碰撞集、行表仍来自几何）`;
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const failed = checks.filter((entry) => !entry.ok);
const negativeCount = checks.filter((entry) => /^N\d/.test(entry.name)).length;
const summary = {
  ok: failed.length === 0,
  levels,
  parts: parts.length,
  feasible: feasibility.feasible,
  diagnosticOnly: feasibility.diagnosticOnly,
  blockers: feasibility.blockers.map((blocker) => blocker.reason),
  designNotes: feasibility.designNotes.map((note) => note.reason),
  stroke: feasibility.stroke,
  clearSpan: feasibility.clearSpan,
  corridor: feasibility.corridor,
  columnSweep: feasibility.columnSweep,
  /** 基线几何的已知重叠（非通道判据，不进退出码；空数组 = 没有） */
  baselineNotes,
  /** N12 门禁覆盖的伪板维度（稳定输出点名；与 check 名逐项一致） */
  forgedPanel: {
    mode: FORGED_PANEL_MODE,
    variants: FORGED_PANEL_VARIANTS
  },
  /** N14 门禁：克隆生产几何、把一件承托面中心写成 NaN 后的 fail-closed 回执（由 N14 实跑填入） */
  shelfFailClosed: shelfFailClosed ?? { ok: false },
  panelSupport: {
    rest: { coveredPct: feasibility.panelSupport.rest.coveredPct, bands: feasibility.panelSupport.rest.bandsY.length, claim: feasibility.panelSupport.rest.claim },
    carried: { coveredPct: feasibility.panelSupport.carried.coveredPct, bands: feasibility.panelSupport.carried.bandsY.length, claim: feasibility.panelSupport.carried.claim }
  },
  /** 生产几何独立复核（checkPanelChannel 直接读 geometry.parts）：verified 只代表行表来自几何 + 板在碰撞集 */
  production: production.ok ? {
    mode: production.mode,
    rowsSource: production.rowsSource,
    restClaim: production.panelSupport.rest.claim,
    carriedClaim: production.panelSupport.carried.claim,
    feasible: production.feasibility.feasible,
    blockers: production.feasibility.blockers.map((blocker) => blocker.reason),
    m1Feasible: production.feasibility.m1.feasible
  } : { ok: false, code: production.code },
  m1: {
    parts: m1.parts.length,
    bodies: m1.geometry.parts.length,
    mode: m1Outcome.mode,
    pose: m1Outcome.pose,
    sweep: m1States.ok ? {
      confirmedHits: m1States.states.sweep.confirmedHits,
      screenHits: m1States.states.sweep.screenHits,
      reviewStatus: m1States.states.sweep.reviewStatus
    } : null,
    panelSupport: {
      rest: { coveredPct: m1Feasibility.panelSupport.rest.coveredPct, bands: m1Feasibility.panelSupport.rest.bandsY.length, claim: m1Feasibility.panelSupport.rest.claim },
      carried: { coveredPct: m1Feasibility.panelSupport.carried.coveredPct, bands: m1Feasibility.panelSupport.carried.bandsY.length, claim: m1Feasibility.panelSupport.carried.claim }
    },
    shift: { mm: m1Feasibility.m1.carriedShiftMm, source: m1Feasibility.m1.carriedShiftSource, boardLiftMm: m1Feasibility.m1.boardLiftMm },
    feasible: m1Feasibility.m1.feasible
  },
  checks: checks.map(({ name, ok }) => ({ name, ok })),
  counts: {
    total: checks.length,
    positive: checks.length - negativeCount,
    negative: negativeCount
  },
  note: 'feasible=false 是多层结论（诊断成功，exit 0）；净跨/走廊只作保守设计 notes；M1 只证明首层承托取放'
};

if (jsonMode) {
  console.log(JSON.stringify(summary));
} else {
  say('');
  say(`TOWER_CHANNEL_RESULT ${summary.ok ? 'ok' : 'fail'}`);
  say(`  feasible=${summary.feasible}  blockers=${summary.blockers.join('/')}  designNotes=${summary.designNotes.join('/')}`);
  say(`  stroke ${summary.stroke.declaredMm} → ${summary.stroke.requiredMm}（缺 ${summary.stroke.shortfallMm}，${summary.stroke.caliber.slice(0, 18)}…）`);
  say(`  clearSpan ${summary.clearSpan.xClearMm} vs 板长 ${summary.clearSpan.requiredMm}（保守口径，非阻塞；柱与板 y 重叠 ${summary.columnSweep.yOverlapMm}）`);
  say(`  corridor ${summary.corridor.corridorMm} vs 板半宽 ${summary.corridor.halfWidthMm}（保守口径，非阻塞）`);
  say(`  真实件表承托：rest ${summary.panelSupport.rest.coveredPct}%/${summary.panelSupport.rest.bands} 带 ${summary.panelSupport.rest.claim}`
    + ` · carried ${summary.panelSupport.carried.coveredPct}%/${summary.panelSupport.carried.bands} 带 ${summary.panelSupport.carried.claim}`);
  say(`  生产几何独立复核（geometry.parts 行表）：mode=${summary.production.mode ?? 'n/a'}`
    + ` · rest ${summary.production.restClaim ?? 'n/a'} · carried ${summary.production.carriedClaim ?? 'n/a'}`
    + ` · feasible=${summary.production.feasible ?? 'n/a'}（verified ≠ supported/可行）`);
  say(`  M1 夹具：${summary.m1.parts} 件 / ${summary.m1.bodies} 刚体 · ${summary.m1.mode} · sweep ${summary.m1.sweep.confirmedHits}/${summary.m1.sweep.screenHits} ${summary.m1.sweep.reviewStatus}`
    + ` · 承托 rest ${summary.m1.panelSupport.rest.coveredPct}% / carried ${summary.m1.panelSupport.carried.coveredPct}%`
    + ` · 位移 ${summary.m1.shift.mm}（${summary.m1.shift.source}）→ 板抬 ${summary.m1.shift.boardLiftMm}`);
  say(`  自证 ${checks.filter((entry) => entry.ok).length}/${checks.length} 通过`
    + `（正向 ${checks.length - negativeCount} / 负向 ${negativeCount}，N1..N${negativeCount}）`);
  say(`  N12 伪板门禁：mode=${summary.forgedPanel.mode}，覆盖 ${summary.forgedPanel.variants.join('/')}`
    + '（同 id 托板 + 身份四字段各伪造一次）');
  say(`  N14 承托面 fail-closed：${summary.shelfFailClosed.partId ?? 'n/a'}.center.${summary.shelfFailClosed.axis ?? 'x/z'}=NaN`
    + ` → witness=${summary.shelfFailClosed.witness === null ? 'null' : summary.shelfFailClosed.witness ? '有值' : 'n/a'}`
    + `、diagnosticCode=${summary.shelfFailClosed.diagnosticCode ?? 'n/a'}`
    + `、feasible=${summary.shelfFailClosed.feasible ?? 'n/a'}（板身份与几何行表原样保留）`);
  if (baselineNotes.length > 0) {
    say(`  基线几何提示（**非通道判据**，不计入退出码）：${[...new Set(baselineNotes)].join('；')}`
      + ' —— 柱截面随塔高派生导致柱位外移（建造器问题，与板/通道无关）');
  }
  say('  遗留：板挠度/导向/防坠/安全/PLC 未验；STEP 未跑；真实塔 sweep 仍 fail；净跨/走廊需结构确认');
}

process.exit(failed.length === 0 ? 0 : 1);
