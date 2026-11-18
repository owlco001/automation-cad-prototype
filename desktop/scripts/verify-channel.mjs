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
  expect(!/26 处|446 处/.test(shelf?.detail ?? ''), 'blocker detail 不许写死实测件数');
  return reasons.join('/');
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
check('几何件数 = 建造器件数、装配件数同值、板占位体只读', () => {
  expect(resolved.partCount === parts.length, `partCount=${resolved.partCount} vs 件表 ${parts.length}`);
  expect(resolved.assemblyPartCount === parts.length, `assemblyPartCount=${resolved.assemblyPartCount}`);
  expect(resolved.geometry.parts.length === parts.length, `几何刚体 ${resolved.geometry.parts.length}`);
  expect(resolved.geometry.parts.some((part) => part.id === PANEL_PART_ID) === false, '板不许进 parts');
  const placeholder = resolved.geometry.workpiecePlaceholder;
  expect(Boolean(placeholder), '缺 workpiecePlaceholder');
  expect(placeholder?.material === 'PV-GLASS' && placeholder?.role === 'workpiece', '占位体材质/角色不对');
  expect(placeholder?.inCollisionSet === false, 'inCollisionSet 必须是 false');
  return `${parts.length} 件 + 只读板 ${placeholder?.sizeMm.join('×')}@${placeholder?.bottomZmm}`;
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
check('N9 生产塔 placeholder → diagnostic-only、无任何 supported claim', () => {
  const outcome = checkPanelChannel({ config, geometry: resolved.geometry });
  expect(outcome.ok === true, '应能判');
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.mode === 'diagnostic-only', `mode=${outcome.mode}`);
  expect(outcome.panelSupport.rest.claim === 'diagnostic-only', `rest claim=${outcome.panelSupport.rest.claim}`);
  expect(outcome.panelSupport.carried.claim === 'diagnostic-only', `carried claim=${outcome.panelSupport.carried.claim}`);
  expect(outcome.feasibility.feasible === false, 'placeholder 路径不许 feasible=true');
  expect(outcome.feasibility.m1.feasible === false, 'placeholder 路径不许 m1.feasible=true');
  expect(outcome.note.includes('diagnosticOnly'), 'note 必须自报 diagnosticOnly');
  return `mode=${outcome.mode}，夹具的 M1 绿不得写成生产塔可行`;
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
  panelSupport: {
    rest: { coveredPct: feasibility.panelSupport.rest.coveredPct, bands: feasibility.panelSupport.rest.bandsY.length, claim: feasibility.panelSupport.rest.claim },
    carried: { coveredPct: feasibility.panelSupport.carried.coveredPct, bands: feasibility.panelSupport.carried.bandsY.length, claim: feasibility.panelSupport.carried.claim }
  },
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
  say(`  M1 夹具：${summary.m1.parts} 件 / ${summary.m1.bodies} 刚体 · ${summary.m1.mode} · sweep ${summary.m1.sweep.confirmedHits}/${summary.m1.sweep.screenHits} ${summary.m1.sweep.reviewStatus}`
    + ` · 承托 rest ${summary.m1.panelSupport.rest.coveredPct}% / carried ${summary.m1.panelSupport.carried.coveredPct}%`
    + ` · 位移 ${summary.m1.shift.mm}（${summary.m1.shift.source}）→ 板抬 ${summary.m1.shift.boardLiftMm}`);
  say(`  自证 ${checks.filter((entry) => entry.ok).length}/${checks.length} 通过`
    + `（正向 ${checks.length - negativeCount} / 负向 ${negativeCount}）`);
  if (baselineNotes.length > 0) {
    say(`  基线几何提示（**非通道判据**，不计入退出码）：${[...new Set(baselineNotes)].join('；')}`
      + ' —— 柱截面随塔高派生导致柱位外移（建造器问题，与板/通道无关）');
  }
  say('  遗留：板挠度/导向/防坠/安全/PLC 未验；STEP 未跑；真实塔 sweep 仍 fail；净跨/走廊需结构确认');
}

process.exit(failed.length === 0 ? 0 : 1);
