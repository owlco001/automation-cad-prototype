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
 * 末段还打一行 `SWEEP_EVIDENCE {…}`（文本模式；`--json` 时在 `summary.sweepEvidence` 里）：
 * ① 去重对数 = 托板层数 × 每层几何命中族数（件表派生，2 层=4、16 层=60）；
 * ② 全部通道相关 suspect 对都含台面，x/y 重叠由件表几何独立复算一致；
 * ③ 台面外移后的变体：**通道对**归零、但 `feasible` 仍 false（**归零 ≠ 可行**）。
 * 405 是**步累计**、42 是**单步 pairs**，两个数都不等于「问题对数」—— 见 docs/desktop/R11-CHANNEL-SWEEP.md。
 *
 * **层数边界（实测，必须一起读）**：通道判据本身与层数无关（件表、行程、净跨、走廊全部派生），
 * 2..64 层跑同一套断言。唯一与层数有关的现象是**建造器几何**：基线建造器在 **17 层起**会让
 * `gearmotor` 与 `column-bl` 相交 1 对 —— 柱截面随塔高派生（`columnSection = ceil5(h/48)`）导致柱位外移，
 * `buffer-tower-assembly.ts` 里「塔架往里收一个柱位」的缓解只在 ≤16 层成立。这是**建造器问题，与板/通道无关**：
 * §5 把它单列为 `sweepEvidence.baselineGeometry`，**从通道证据里真的剔出去**（`splitChannelPairs`），
 * 并把它的步数从闭合计里显式扣掉（`channelStepSums + baselineGeometry === confirmedHits/screenHits`）——
 * 所以 17 层以上既不假装它不存在，也不会让通道自证变红。剔出去的对必须不含台面/托板家族，
 * 剩下的对必须含台面：这两条把「静默丢对」挡在自证之外。
 *
 * 退出码：0 = 诊断成功（含 feasible:false）/ 1 = 负向自证或数值断言失败 / 2 = 用法错误。
 */
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../src/machine/buffer-tower-assembly.ts';
import { resolveMachineGeometry } from '../src/machine/machine-geometry.ts';
import { runInterferenceStates, shiftParts } from '../src/machine/interference-states.ts';
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
const states = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config, collectChannelPairs: true });
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
 * 5) 通道证据（**正向**自证，不带 N 编号）：405 的单位、去重对数、「归零 ≠ 可行」
 *
 * 为什么单独一块：sweep 的 `items` 只留 10 条（`MAX_ITEMS`），于是「405 处」被反复读成
 * 「405 个问题」。这里用 `collectChannelPairs: true` 拿到**不截断**的逐对证据，
 * 把三个口径固定成可复算的关系：步累计 / 去重对数 / 外移后归零但不可行。
 * 所有数字一律从件表与几何派生（层数 × 每层命中族数、重叠量 AABB 复算、外移量 = 最大重叠 + 一个扫描步），
 * **不写死** 405 / 60 / 42 / 230 / 15。
 * ------------------------------------------------------------------ */
say('\n[5] 通道证据（正向自证：步累计 / 去重对数由件表派生 / 归零 ≠ 可行）');
if (!states.ok) {
  console.error(`verify:channel: 三态检查失败，通道证据无从谈起：${states.message}`);
  process.exit(1);
}
const sweepState = states.states.sweep;
/** 台面：升降轴上的运动件（从回执派生，不写死 'lift-platform'） */
const movingPartIds = states.lift?.partIds ?? [];
const rowOfPart = new Map(rows.map((row) => [row.id, row]));
/** 区间重叠（mm）：负值 = 分开 */
const overlapX = (left, right) => Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX);
const overlapY = (left, right) => Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY);
/** 证据①②填这里，最后进 summary.sweepEvidence */
const sweepFacts = {
  channelPairs: [],
  derivedPairs: 0,
  trayLayers: 0,
  perLayer: [],
  minXOverlapMm: 0,
  maxXOverlapMm: 0,
  trayBodyYOverlapMm: 0,
  baselinePairs: [],
  baselineConfirmed: 0,
  baselineScreen: 0,
  channelConfirmed: 0,
  channelScreen: 0,
  channelHitSteps: 0
};
let retractedVariant = null;

/**
 * 基线几何的已知重叠（`BASELINE_REST_LIFT_PAIR`，levels≥17 才出现）**真的**剔除，并把它的步数单列。
 *
 * 上一版的写法是「先 filter 掉基线对，紧接着断言 filter 没改变任何东西」—— 那条断言一几何里真有
 * 基线对就**永假**：`--levels 17` 起整块 §5 变红，而通道判据本身与层数无关（CI 只跑 2/16，门禁看不见）。
 * 现在改成三件**层数无关**的事：
 *   ① 剔出去的对必须与板/通道**无关**（不含台面、也不含托板家族）—— 由件表/几何判定，不看名字像不像；
 *   ② 剔出去的步数从闭合计里**显式扣掉**：channelConfirmed + baselineConfirmed === sweep.confirmedHits；
 *   ③ 剩下的每一对必须含台面（否则「本该算通道问题的对」被静默当成基线丢掉）。
 * ≤16 层基线族为空，② 退化成恒等式、①③ 照旧生效 —— 所以 2…64 层跑的是同一套判据。
 */
const SPLIT_BASELINE_GEOMETRY = true; // 变异自证锚点：flip 成 false 会让证据①③ 立刻红（buffer-tower-channel.test.mjs 守着）
const splitChannelPairs = (pairs) => {
  const all = Array.isArray(pairs) ? pairs : [];
  const isBaseline = (pair) => SPLIT_BASELINE_GEOMETRY && BASELINE_REST_LIFT_PAIR.test(`${pair.a}|${pair.b}`);
  const baseline = all.filter(isBaseline);
  const channel = all.filter((pair) => !isBaseline(pair));
  return {
    all,
    baseline,
    channel,
    baselineConfirmed: baseline.reduce((sum, pair) => sum + pair.confirmedSteps, 0),
    baselineScreen: baseline.reduce((sum, pair) => sum + pair.screenSteps, 0)
  };
};
/**
 * 命中步里扣掉「只有基线对在命中」的那些步：残差 > 0 才算**通道**命中步（与层数无关）。
 * 不扣的话 levels≥17 的 `hitSteps` 会等于总步数（基线对每步都在命中），读起来像「通道全线命中」。
 */
const channelHitStepsOf = (sweep, split) => {
  const hitSteps = sweep.steps.filter((step) => step.confirmedHits + step.screenHits > 0);
  if (split.baseline.length === 0) return hitSteps.length;
  const baselineHitsAt = (zMm) =>
    split.baseline.filter((pair) => pair.zStepsMm.some((z) => Math.abs(z - zMm) <= 1e-6)).length;
  return hitSteps.filter((step) => step.confirmedHits + step.screenHits - baselineHitsAt(step.z) > 0).length;
};

check('通道证据①：去重对数 = 托板层数 × 每层几何命中族数（件表派生，步数之和 = 步累计计数）', () => {
  const split = splitChannelPairs(sweepState.channelPairs);
  expect(split.all.length > 0, 'sweep 没有 channelPairs（runInterferenceStates 的 collectChannelPairs 没打开？）');
  const channelPairs = split.channel;
  const movingSet = new Set(movingPartIds);
  const inTrayFamily = (id) => /^tray-\d+$/.test(id) || /^tray-(rail|roller)-\d+-/.test(id);
  // ① 剔出去的对必须与板/通道无关：不含台面、也不含托板家族（不是「名字像基线」就算）
  for (const pair of split.baseline) {
    expect(!movingSet.has(pair.a) && !movingSet.has(pair.b),
      `基线对 ${pair.a}|${pair.b} 含台面 —— 这是通道问题，不许当基线剔掉`);
    expect(!inTrayFamily(pair.a) && !inTrayFamily(pair.b),
      `基线对 ${pair.a}|${pair.b} 含托板家族件 —— 这是通道问题，不许当基线剔掉`);
  }
  // ② 剩下的每一对都必须含台面：挡住「把通道对静默丢进基线」
  for (const pair of channelPairs) {
    expect(movingSet.has(pair.a) !== movingSet.has(pair.b),
      `${pair.a}|${pair.b} 不含台面：不是通道对，不该留在通道证据里`);
  }
  const trayLayers = rows.filter((row) => /^tray-\d+$/.test(row.id));
  expect(trayLayers.length > 0, '件表里没有 tray-<n> 托板，去重对数无从派生');
  // 台面必须有**件表行**：几何里的台面与件表是同一份零件，重叠量只能从件表复算
  const movingRows = rows.filter((row) => movingPartIds.includes(row.id));
  expect(movingRows.length === 1, `升降轴上的运动件在件表里应有且只有 1 件，实测 ${movingRows.map((row) => row.id).join(',') || '无'}`);
  const moving = movingRows[0];
  // 每层托板家族（托板本体 + 两侧托条 + 两个辊）里，与台面投影双向相交的件 —— 这就是该层会被扫到的件数
  let derived = 0;
  const perLayer = [];
  for (const tray of trayLayers) {
    const layer = tray.id.slice('tray-'.length);
    const family = rows.filter((row) => row.id === tray.id
      || row.id.startsWith(`tray-rail-${layer}-`)
      || row.id.startsWith(`tray-roller-${layer}-`));
    const hits = family.filter((row) => overlapX(moving, row) > 0 && overlapY(moving, row) > 0);
    derived += hits.length;
    perLayer.push(`${tray.id}:${hits.length}`);
  }
  expect(channelPairs.length === derived,
    `去重对数 ${channelPairs.length} ≠ 件表派生 ${derived}（${trayLayers.length} 层：${perLayer.join(' ')}）`);
  // 405 的单位：逐对命中步数之和就是 sweep 的步累计计数（通道对 + 基线对两半各自闭合）
  const sumConfirmed = channelPairs.reduce((sum, pair) => sum + pair.confirmedSteps, 0);
  const sumScreen = channelPairs.reduce((sum, pair) => sum + pair.screenSteps, 0);
  expect(sumConfirmed + split.baselineConfirmed === sweepState.confirmedHits,
    `逐对确认步数之和 ${sumConfirmed} + 基线对 ${split.baselineConfirmed} ≠ sweep 确认 ${sweepState.confirmedHits}（步累计口径不闭合）`);
  expect(sumScreen + split.baselineScreen === sweepState.screenHits,
    `逐对待复核步数之和 ${sumScreen} + 基线对 ${split.baselineScreen} ≠ sweep 待复核 ${sweepState.screenHits}（步累计口径不闭合）`);
  for (const pair of channelPairs) {
    expect(pair.steps === pair.zStepsMm.length && pair.steps === pair.confirmedSteps + pair.screenSteps,
      `${pair.a}|${pair.b} 步数不自洽：steps=${pair.steps} zSteps=${pair.zStepsMm.length} confirmed=${pair.confirmedSteps} screen=${pair.screenSteps}`);
    expect(pair.zBandMm[0] === pair.zStepsMm[0] && pair.zBandMm[1] === pair.zStepsMm[pair.zStepsMm.length - 1],
      `${pair.a}|${pair.b} z 带 ${pair.zBandMm.join('..')} 与命中高度不一致`);
  }
  const perLayerCounts = [...new Set(perLayer.map((entry) => Number(entry.split(':')[1])))];
  sweepFacts.channelPairs = channelPairs;
  sweepFacts.derivedPairs = derived;
  sweepFacts.trayLayers = trayLayers.length;
  sweepFacts.perLayer = perLayer;
  sweepFacts.baselinePairs = split.baseline.map((pair) => `${pair.a}|${pair.b}`);
  sweepFacts.baselineConfirmed = split.baselineConfirmed;
  sweepFacts.baselineScreen = split.baselineScreen;
  sweepFacts.channelConfirmed = sumConfirmed;
  sweepFacts.channelScreen = sumScreen;
  sweepFacts.channelHitSteps = channelHitStepsOf(sweepState, split);
  const baselineNote = split.baseline.length === 0
    ? ''
    : `；基线几何对单列 ${split.baseline.length} 对（${split.baselineConfirmed}+${split.baselineScreen} 步，不计入通道证据）`;
  return `${channelPairs.length} 对 = ${trayLayers.length} 层 × ${perLayerCounts.join('/')} 件（派生值 ${derived}）`
    + `；逐对步数之和 ${sumConfirmed}+${sumScreen}`
    + ` + 基线 ${split.baselineConfirmed}+${split.baselineScreen} = sweep 步累计 ${sweepState.confirmedHits}+${sweepState.screenHits}`
    + `（同一步里重复命中的同一对不再算成多对）`
    + baselineNote;
});

check('通道证据②：全部通道相关 suspect 对都含台面，x/y 重叠由件表几何复算一致（托板本体 y 向无走廊）', () => {
  const channelPairs = sweepFacts.channelPairs;
  expect(channelPairs.length > 0, '证据①未产出通道对，这条无从谈起');
  const movingSet = new Set(movingPartIds);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = 0;
  for (const pair of channelPairs) {
    const aMoving = movingSet.has(pair.a);
    const bMoving = movingSet.has(pair.b);
    expect(aMoving !== bMoving, `${pair.a}|${pair.b} 不是「台面 × 固定件」对（一侧是台面才说明这是升降通道问题）`);
    const movingRow = rowOfPart.get(aMoving ? pair.a : pair.b);
    const otherRow = rowOfPart.get(aMoving ? pair.b : pair.a);
    expect(Boolean(movingRow) && Boolean(otherRow), `${pair.a}|${pair.b} 在件表里找不到，重叠量无法独立复算`);
    if (!movingRow || !otherRow) throw new Error(`${pair.a}|${pair.b} 缺件表行`);
    const x = overlapX(movingRow, otherRow);
    const y = overlapY(movingRow, otherRow);
    expect(near(pair.xOverlapMm, x, 0.05), `${pair.a}|${pair.b} 回执 x 重叠 ${pair.xOverlapMm} ≠ 件表复算 ${show(x)}`);
    expect(near(pair.yOverlapMm, y, 0.05), `${pair.a}|${pair.b} 回执 y 重叠 ${pair.yOverlapMm} ≠ 件表复算 ${show(y)}`);
    expect(x > 0 && y > 0, `${pair.a}|${pair.b} 复算无重叠（x=${show(x)} y=${show(y)}），不该出现在通道对里`);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  // 「y 向没有走廊」只能在托板本体上说：它 y 宽与台面等宽 → 重叠 = 较窄件的全宽（不是一条窄带）
  const trayBody = channelPairs.filter((pair) => /^tray-\d+$/.test(pair.a) || /^tray-\d+$/.test(pair.b));
  expect(trayBody.length > 0, '没有「台面 × 托板本体」对，y 向有没有走廊无从判断');
  const trayBodyY = trayBody.map((pair) => {
    const rowsIn = [rowOfPart.get(pair.a), rowOfPart.get(pair.b)].filter(Boolean);
    const narrower = Math.min(...rowsIn.map((row) => row.maxY - row.minY));
    return { pair, narrower, y: overlapY(rowsIn[0], rowsIn[1]) };
  });
  for (const entry of trayBodyY) {
    expect(near(entry.y, entry.narrower, 0.05),
      `${entry.pair.a}|${entry.pair.b} y 重叠 ${show(entry.y)} ≠ 较窄件全宽 ${show(entry.narrower)}（y 向还有走廊可绕）`);
  }
  const yFull = Math.min(...trayBodyY.map((entry) => entry.narrower));
  // 托条/辊的更窄（它们本身就是 40/610 宽的小件），所以「无走廊」这句只对托板本体成立 —— 逐族列出来
  const byFamily = new Map();
  for (const pair of channelPairs) {
    const other = movingSet.has(pair.a) ? pair.b : pair.a;
    const family = other.replace(/-\d+-(left|right|in|out)$/, '').replace(/^tray-\d+$/, 'tray');
    const entry = byFamily.get(family) ?? { n: 0, x: new Set(), y: new Set() };
    entry.n += 1;
    entry.x.add(pair.xOverlapMm);
    entry.y.add(pair.yOverlapMm);
    byFamily.set(family, entry);
  }
  sweepFacts.minXOverlapMm = minX;
  sweepFacts.maxXOverlapMm = maxX;
  sweepFacts.trayBodyYOverlapMm = yFull;
  return `全部含台面（${movingPartIds.join('/')}）；x 重叠 ${show(minX)}..${show(maxX)}、托板本体 y 重叠 ${show(yFull)} = 板全宽（y 向无走廊）`
    + `；逐族 ${[...byFamily].map(([family, entry]) => `${family}×${entry.n}(x=${[...entry.x].join('/')},y=${[...entry.y].join('/')})`).join('、')}`;
});

check('通道证据③：台面外移（= 最大 x 重叠 + 一个扫掠步）→ sweep 归零，但 feasible 仍 false（归零 ≠ 可行）', () => {
  const channelPairs = sweepFacts.channelPairs;
  expect(channelPairs.length > 0, '证据①未产出通道对，外移量无从派生');
  // 外移量派生：把最深的 x 重叠整个退出去，再加一个扫描步（正好卡在贴面上不算「让开」）
  const retractMm = Math.max(...channelPairs.map((pair) => pair.xOverlapMm)) + sweepState.step;
  // 台面在托板（x 中心 0）的负侧 → 往 −x 退，退出托板端部
  const retracted = shiftParts(resolved.geometry, movingPartIds, [-1, 0, 0], retractMm);
  const retractedPanel = panelSourceOfGeometry(retracted);
  expect(retractedPanel?.inCollisionSet === true, '外移台面不许伤到板身份（板仍须在碰撞集里）');
  // 收集逐对证据：归零要在**通道对**上判，不能在整态步累计上判 —— levels≥17 时基线几何对
  // （gearmotor×column-*）与台面外移无关、照样每步命中，整态数字永远不会是 0。
  const variant = runInterferenceStates({ states: ['sweep'], config, geometry: retracted, collectChannelPairs: true });
  expect(variant.ok === true, variant.ok ? '' : `${variant.code} ${variant.message}`);
  if (!variant.ok) throw new Error(`${variant.code} ${variant.message}`);
  const variantSplit = splitChannelPairs(variant.states.sweep.channelPairs);
  expect(variantSplit.channel.length === 0,
    `外移后仍有 ${variantSplit.channel.length} 个通道对：${variantSplit.channel.map((pair) => `${pair.a}|${pair.b}`).join(',')}`);
  const variantChannelConfirmed = variantSplit.channel.reduce((sum, pair) => sum + pair.confirmedSteps, 0);
  const variantChannelScreen = variantSplit.channel.reduce((sum, pair) => sum + pair.screenSteps, 0);
  expect(variantChannelConfirmed === 0 && variantChannelScreen === 0,
    `外移后通道步累计未归零：${variantChannelConfirmed}+${variantChannelScreen}`);
  const variantBaseline = variantSplit.baselineConfirmed + variantSplit.baselineScreen;
  if (variantBaseline === 0) {
    // 没有基线对（≤16 层）：整态也必须逐字段归零，结论才不只是「通道那部分」
    expect(variant.states.sweep.confirmedHits === 0 && variant.states.sweep.screenHits === 0,
      `外移后 sweep 未归零：${variant.states.sweep.confirmedHits}+${variant.states.sweep.screenHits}`);
    expect(variant.states.sweep.reviewStatus !== 'fail', `外移后 sweep 仍 ${variant.states.sweep.reviewStatus}`);
  } else {
    // 有基线对：整态仍是 fail/warn 只能来自基线族本身，通道部分必须是 0（上面已断言）
    expect(variantSplit.channel.length === 0, '基线对不为空时，通道对必须一个不剩');
  }
  const variantFeasibility = checkPanelChannel({ config, geometry: retracted });
  expect(variantFeasibility.ok === true, variantFeasibility.ok ? '' : `${variantFeasibility.code} ${variantFeasibility.message}`);
  if (!variantFeasibility.ok) throw new Error(`${variantFeasibility.code} ${variantFeasibility.message}`);
  expect(variantFeasibility.feasibility.feasible === false,
    'sweep 归零被读成 feasible=true —— 这正是本轮要防的假绿：通道通了不等于板托得住');
  const variantBlockers = variantFeasibility.feasibility.blockers.map((blocker) => blocker.reason);
  for (const reason of ['load-passes-shelf', 'stroke-shortfall']) {
    expect(variantBlockers.includes(reason), `外移后缺 blocker ${reason}（实际 ${variantBlockers.join('/')}）`);
  }
  expect(variantFeasibility.panelSupport.rest.claim !== 'supported',
    `外移后 rest claim=${variantFeasibility.panelSupport.rest.claim}（单条整带不许算托住）`);
  retractedVariant = {
    retractMm: show(retractMm),
    confirmedHits: variantChannelConfirmed,
    screenHits: variantChannelScreen,
    sweepConfirmedHits: variant.states.sweep.confirmedHits,
    sweepScreenHits: variant.states.sweep.screenHits,
    baselineConfirmedHits: variantSplit.baselineConfirmed,
    reviewStatus: variant.states.sweep.reviewStatus,
    feasible: variantFeasibility.feasibility.feasible,
    blockers: variantBlockers,
    restClaim: variantFeasibility.panelSupport.rest.claim
  };
  return `外移 ${show(retractMm)} mm → 通道 ${variantChannelConfirmed}+${variantChannelScreen}（整态 ${variant.states.sweep.confirmedHits}+${variant.states.sweep.screenHits}，基线对 ${variantBaseline} 步不计）`
    + `，但 feasible=${variantFeasibility.feasibility.feasible}（${variantBlockers.join('/')}）、rest=${variantFeasibility.panelSupport.rest.claim}`
    + ' —— 归零只说明台面不再穿托板，承托/行程仍不成立';
});

/** 一行机器可读的证据回执（文本模式打在末段；`--json` 时在 summary.sweepEvidence 里） */
const sweepEvidence = {
  levels,
  stepMm: sweepState.step,
  sweepSteps: sweepState.steps.length,
  hitSteps: sweepState.steps.filter((step) => step.confirmedHits + step.screenHits > 0).length,
  /** 扣掉「只有基线几何对在命中」的步之后才是**通道**命中步（levels≥17 时两者不相等） */
  channelHitSteps: sweepFacts.channelHitSteps,
  confirmedHits: sweepState.confirmedHits,
  screenHits: sweepState.screenHits,
  /** 通道对逐对之和（= 整态步累计 − 基线几何对步数，由证据①实时派生） */
  channelStepSums: { confirmedHits: sweepFacts.channelConfirmed, screenHits: sweepFacts.channelScreen },
  /** 基线几何对（gearmotor×column-*，levels≥17 才出现）：单列、不计入通道判据 */
  baselineGeometry: {
    pairs: sweepFacts.baselinePairs,
    confirmedHits: sweepFacts.baselineConfirmed,
    screenHits: sweepFacts.baselineScreen
  },
  reviewStatus: sweepState.reviewStatus,
  caliber: 'confirmedHits/screenHits 是**步累计**（同一对在多个高度重复计数）；dedupedPairs 才是问题对数',
  dedupedPairs: sweepFacts.channelPairs.length,
  derivedDedupedPairs: sweepFacts.derivedPairs,
  trayLayers: sweepFacts.trayLayers,
  perLayer: sweepFacts.perLayer,
  platformPartIds: movingPartIds,
  xOverlapMm: { min: show(sweepFacts.minXOverlapMm), max: show(sweepFacts.maxXOverlapMm) },
  trayBodyYOverlapMm: show(sweepFacts.trayBodyYOverlapMm),
  retractedVariant,
  feasible: feasibility.feasible,
  blockers: feasibility.blockers.map((blocker) => blocker.reason)
};

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
  /** 通道证据（正向自证 ①去重对数 ②含台面/重叠复算 ③外移归零但不feasible）的机器可读回执 */
  sweepEvidence,
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
  // 末段一行机器可读证据（`--json` 时同一份在 summary.sweepEvidence 里）
  say(`SWEEP_EVIDENCE ${JSON.stringify(sweepEvidence)}`);
}

process.exit(failed.length === 0 ? 0 : 1);
