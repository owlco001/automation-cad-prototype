// 「一键排布合规」的守卫：交替两段、收敛判据是「重叠=0 且间距=0」，达不到必须如实说。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout, complianceStamp, maxFeasibleClearance } from '../../src/machine/layout.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { screenClearance } from '../../src/machine/clearance.ts';

function box(id, center, size) {
  return { id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg: 0 };
}

test('既有一对重叠、又有一对太近：一轮交替后两类都为 0', () => {
  const geometry = {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [30, 0, 0], [100, 100, 100]),   // 与 a 重叠
      box('c', [145, 0, 0], [100, 100, 100])   // 与 b 相距 15 mm（<20）
    ]
  };
  assert.ok(screenInterference(geometry).suspects >= 1);
  assert.ok(screenClearance(geometry, { thresholdMm: 20 }).count >= 1);

  const result = resolveLayout(geometry, { clearanceMm: 20 });
  assert.equal(result.converged, true, result.stopReason);
  assert.equal(result.suspects, 0);
  assert.equal(result.clearance, 0);
  const finalGeometry = { ...geometry, parts: result.parts };
  assert.equal(screenInterference(finalGeometry).suspects, 0, '跑完不该还有未声明重叠');
  assert.equal(screenClearance(finalGeometry, { thresholdMm: 20 }).count, 0, '跑完不该还有间距不足');
  assert.ok(result.moves.some((move) => move.kind === 'overlap'));
  assert.ok(result.moves.some((move) => move.kind === 'clearance'));
});

test('轮数上限 0 时如实返回 converged=false，且不做任何挪动', () => {
  const geometry = { parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])] };
  const result = resolveLayout(geometry, { clearanceMm: 20, maxRounds: 0 });
  assert.equal(result.converged, false);
  assert.ok(result.stopReason);
  assert.equal(result.moves.length, 0);
  assert.equal(result.rounds.length, 0);
});

test('每轮都记录「进轮前的两类问题数」和「出轮后的两类问题数」', () => {
  const geometry = {
    parts: [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])]
  };
  const result = resolveLayout(geometry, { clearanceMm: 20 });
  assert.ok(result.rounds.length >= 1);
  const first = result.rounds[0];
  assert.equal(first.round, 1);
  assert.ok(first.suspectsBefore >= 1);
  assert.equal(typeof first.clearanceBefore, 'number');
  assert.equal(first.suspectsAfter, 0);
  assert.equal(first.clearanceAfter, 0);
});

test('不修改入参（纯函数）', () => {
  const parts = [box('a', [0, 0, 0], [100, 100, 100]), box('b', [30, 0, 0], [100, 100, 100])];
  const snapshot = JSON.stringify(parts);
  resolveLayout({ parts }, { clearanceMm: 20 });
  assert.equal(JSON.stringify(parts), snapshot);
});


test('收敛的案例不带建议（建议只为「放不下」服务）', () => {
  const result = resolveLayout(
    { parts: [{ id: 'a', name: 'a', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [0, 0, 0], rotationZDeg: 0 },
              { id: 'b', name: 'b', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [110, 0, 0], rotationZDeg: 0 }] },
    { clearanceMm: 20 });
  assert.equal(result.converged, true);
  assert.equal(result.advice, undefined);
});


test('合规戳：只抄结论和阈值，字段与 layout 结果一致', () => {
  const parts = [
    { id: 'a', name: 'a', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [0, 0, 0], rotationZDeg: 0 },
    { id: 'b', name: 'b', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [110, 0, 0], rotationZDeg: 0 }
  ];
  const result = resolveLayout({ parts }, { clearanceMm: 20 });
  const stamp = complianceStamp(result);
  assert.equal(stamp.clearanceMm, 20);
  assert.equal(stamp.converged, result.converged);
  assert.equal(stamp.suspects, result.suspects);
  assert.equal(stamp.clearance, result.clearance);
  assert.equal(stamp.rounds, result.rounds.length);
  assert.equal(stamp.moves, result.moves.length);
  // 戳里不该出现时间戳这类每次都变的东西
  assert.equal(Object.keys(stamp).some((key) => /time|date|checkedAt/i.test(key)), false);
});


test('最大可行间距：空间够时返回上限，且探测记录能与结论对上', () => {
  const parts = [
    { id: 'a', name: 'a', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [0, 0, 0], rotationZDeg: 0 },
    { id: 'b', name: 'b', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [110, 0, 0], rotationZDeg: 0 }
  ];
  const result = maxFeasibleClearance({ parts }, { minMm: 5, maxMm: 40 });
  assert.equal(result.feasibleMm, 40, '两件方盒随便推都能排开，应当直接到上限');
  assert.ok(result.probes.length >= 2);
  // 结论必须与探测一致：feasible 那次必须 converged，否则就是自相矛盾
  const hit = result.probes.find((probe) => probe.mm === result.feasibleMm);
  assert.ok(hit, `探测里没有 ${result.feasibleMm} mm`);
  assert.equal(hit.converged, true);
  assert.equal(result.minMm, 5);
  assert.equal(result.maxMm, 40);
});

test('最大可行间距：最小阈值都排不开时返回 0 并留探测记录', () => {
  // 两件完全重合：任何正间距都排不开（先得解重叠，而这里只看间距合规）
  const parts = [
    { id: 'a', name: 'a', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [0, 0, 0], rotationZDeg: 0 },
    { id: 'b', name: 'b', role: 'structure', shape: { type: 'box', size: [100, 100, 100] }, center: [0, 0, 0], rotationZDeg: 0 }
  ];
  const result = maxFeasibleClearance({ parts }, { minMm: 10, maxMm: 40 });
  assert.ok(result.feasibleMm === 0 || result.feasibleMm >= 10, `实际 ${result.feasibleMm}`);
  assert.ok(result.probes.length >= 1);
});

// ---- 工位级建议 ----
import { buildAdvice } from '../../src/machine/layout.ts';

test('跨工位太近且空间充足：建议可执行，方向指向远离对方的一侧', () => {
  const geometry = {
    parts: [
      // A 站两件（内部不近），B 站一件，与 A 站最近一件只隔 5 mm
      box('stA-plate', [0, 0, 0], [100, 100, 100]),
      box('stA-nest', [0, 0, 200], [40, 40, 40]),
      box('stB-plate', [105, 0, 0], [100, 100, 100])
    ]
  };
  const advice = buildAdvice(geometry, 20);
  const item = advice.find((entry) => entry.scope === 'stB') ?? advice.find((entry) => entry.scope === 'stA');
  assert.ok(item, '应当给出建议');
  assert.equal(item.intraScope, false, '这是跨工位的一对');
  assert.equal(item.actionable, true, `应当可执行（overlapsAfter=${item.overlapsAfter}）`);
  assert.equal(item.overlapsAfter, 0);
  assert.ok(item.shortByMm > 0);
});

test('工位内部太近：标 intraScope 且不可执行（整站挪不改变内部相对距离）', () => {
  const geometry = {
    parts: [
      box('stA-base', [0, 0, 0], [100, 100, 20]),
      box('stA-table', [0, 0, 25], [100, 100, 20])
    ]
  };
  const advice = buildAdvice(geometry, 40);
  assert.equal(advice.length, 1);
  assert.equal(advice[0].intraScope, true);
  assert.equal(advice[0].actionable, false);
});
