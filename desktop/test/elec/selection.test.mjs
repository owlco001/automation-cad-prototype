/**
 * 断路器—导线配合选型：锁住「先定断路器、再按断路器额定选截面」的关系。
 *
 * 这组测试的用意不是重复算一遍表，而是防止以后有人把 1.5mm² 或 6A 写死回去：
 *   ① 选型结果对任意合理电流都满足 ampacity ≥ breakerA；出图产物同样是这个不等式；
 *   ② 检查器规则没被放软——故意不自洽的回路仍然判 error；
 *   ③ 大电流超过单根常用上限时走 warning（提示分回路/并联），不静默选超粗线；
 *   ④ 同一机型电气复跑不再出现 BREAKER_OVERSIZE。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATRIX } from './matrix.mjs';
import {
  AMPACITY_TABLE,
  BREAKER_RATINGS,
  ampacityOf,
  checkWireSections,
  runElectricalCheck
} from '../../src/elec/check.ts';
import {
  SINGLE_CABLE_MAX_MM2,
  breakerFor,
  breakerRatingFromModel,
  selectCableForBreaker,
  selectCableProtection
} from '../../src/elec/selection.ts';
import { renderElecDrawing } from '../../src/elec/drawing.ts';
import { estimatePower } from '../../src/machine/power.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { elecDesignFromMachine } from '../../src/elec/adapters.ts';

const BRIEF_PV =
  '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';

/** 逐条断言一个 {currentA, breakerA, sectionMm2, ampacityA} 选型结果自洽。 */
function assertCoherent(currentA, selection, { requireMargin = true } = {}) {
  assert.ok(BREAKER_RATINGS.includes(selection.breakerA), `${currentA}A: 断路器 ${selection.breakerA}A 不是标准档`);
  assert.ok(selection.breakerA >= currentA, `${currentA}A: 断路器 ${selection.breakerA}A 小于负载电流`);
  if (requireMargin) {
    assert.ok(
      selection.breakerA >= currentA * 1.25 || selection.breakerA === BREAKER_RATINGS[BREAKER_RATINGS.length - 1],
      `${currentA}A: 断路器 ${selection.breakerA}A 没有 1.25 倍余量`
    );
  }
  if (selection.sectionMm2 === null) {
    // 只有超出单根表范围才允许没有截面，而且必须给出告警
    assert.equal(selection.ampacityA, null);
    assert.ok(selection.warnings.length > 0, `${currentA}A: 无截面却没有告警`);
    return;
  }
  const amp = ampacityOf(selection.sectionMm2);
  assert.equal(amp, selection.ampacityA, `${currentA}A: 载流量与表不一致`);
  assert.ok(amp !== null && amp >= selection.breakerA, `${currentA}A: ${selection.sectionMm2}mm² 载流量 ${amp}A < 断路器 ${selection.breakerA}A`);
  assert.ok(amp >= currentA, `${currentA}A: 载流量 ${amp}A 小于回路电流`);
}

test('① 选型：任意合理电流都满足 ampacity ≥ breakerA，断路器向上取标准档', () => {
  const currents = [0.1, 0.5, 1, 2, 3, 5, 8, 10, 16, 20, 25, 30, 32, 40, 50, 63, 80, 100, 125, 160, 200, 240];
  for (const currentA of currents) {
    const selection = selectCableProtection(currentA, { label: '测试回路' });
    assertCoherent(currentA, selection);
  }
});

test('① 选型：断路器型号能读出额定电流，读不出时按电流回退', () => {
  assert.equal(breakerRatingFromModel('iC65N 3P C6'), 6);
  assert.equal(breakerRatingFromModel('iC65N 1P+N C32'), 32);
  assert.equal(breakerRatingFromModel('NXB-63 3P C16'), 16);
  assert.equal(breakerRatingFromModel('NSX160F 3P 100A'), 100);
  assert.equal(breakerRatingFromModel('GV2ME08'), null);
  const fallback = selectCableForBreaker(breakerFor(4), { label: '回退' });
  assert.ok(fallback.ampacityA !== null && fallback.ampacityA >= breakerFor(4));
});

test('① 生成器：机型功率估算回传的 {breakerA, sectionMm2, ampacityA} 自洽', () => {
  const design = synthMachine(parseMachineBrief(BRIEF_PV));
  const power = design.power;
  assert.ok(power.mainProtection.breakerA > 0);
  assert.ok(power.mainProtection.ampacityA !== null);
  assert.equal(power.mainProtection.breakerA, power.breakerSuggestion.rating);
  assert.ok(power.mainProtection.ampacityA >= power.mainProtection.breakerA);
  assert.ok(power.mainProtection.ampacityA >= power.currentA);
});

test('① 生成器：出图文档里每条回路的载流量都不小于断路器', () => {
  const drawing = renderElecDrawing(elecDesignFromMachine(synthMachine(parseMachineBrief(BRIEF_PV)), { date: '2026-11-04' }));
  const circuits = drawing.document.circuits ?? [];
  assert.ok(circuits.length > 0, '出图文档必须带回路校验数据');
  for (const circuit of circuits) {
    const amp = ampacityOf(circuit.sectionMm2);
    assert.ok(amp !== null, `线号 ${circuit.wireNo}: 截面 ${circuit.sectionMm2} 不在载流量表内`);
    assert.ok(amp >= circuit.breakerA, `线号 ${circuit.wireNo}: 载流量 ${amp}A < 断路器 ${circuit.breakerA}A`);
    assert.ok(amp >= circuit.currentA, `线号 ${circuit.wireNo}: 载流量 ${amp}A < 电流 ${circuit.currentA}A`);
  }
});

test('② 检查器没放软：不自洽回路仍判 BREAKER_OVERSIZE error', () => {
  const findings = checkWireSections([
    { wireNo: '101', currentA: 8, sectionMm2: 1.5, breakerA: 16 },
    { wireNo: '102', currentA: 20, sectionMm2: 4, breakerA: 32 }
  ]);
  const oversized = findings.filter((item) => item.code === 'BREAKER_OVERSIZE');
  assert.equal(oversized.length, 2, '两条不自洽回路都必须报');
  for (const finding of oversized) {
    assert.equal(finding.severity, 'error', `${finding.location}: 规则被放软成了 ${finding.severity}`);
  }
  // 汇总入口同样保持 error 计数
  const result = runElectricalCheck({
    circuits: [{ wireNo: '101', currentA: 8, sectionMm2: 1.5, breakerA: 16 }]
  });
  assert.ok(result.counts.error >= 1);
  assert.ok(result.findings.some((item) => item.code === 'BREAKER_OVERSIZE' && item.severity === 'error'));
  // 自洽的一对不误报
  const ok = checkWireSections([{ wireNo: '103', currentA: 5, sectionMm2: 1.5, breakerA: 6 }]);
  assert.deepEqual(ok.filter((item) => item.code === 'BREAKER_OVERSIZE'), []);
});

test('③ 大电流超过单根常用上限：给 warning 并提示分回路/并联', () => {
  const large = selectCableProtection(40, { label: '大电流回路' });
  assert.ok(large.sectionMm2 !== null && large.sectionMm2 > SINGLE_CABLE_MAX_MM2);
  assert.ok(large.ampacityA !== null && large.ampacityA >= large.breakerA);
  assert.ok(large.warnings.some((line) => /分回路|并联/.test(line)), large.warnings.join('; '));
  assert.ok(large.warnings.some((line) => /超过单根常用上限/.test(line)));

  // 超出整张载流量表：不返回超粗线，只告警
  const beyond = selectCableProtection(300, { label: '超大电流回路' });
  assert.equal(beyond.sectionMm2, null);
  assert.equal(beyond.ampacityA, null);
  assert.ok(beyond.warnings.some((line) => /分回路|并联/.test(line)));

  // 功率估算同样把大电流告警写进 warnings，截面不超过常用单根范围时不告警
  const big = estimatePower({
    items: [{ role: 'other', qty: 1, ratedW: 30000 }],
    voltage: '380VAC',
    simultaneity: 1,
    loadFactor: 1,
    efficiency: 1,
    cosPhi: 0.9
  });
  assert.ok(big.mainProtection.sectionMm2 !== null && big.mainProtection.sectionMm2 > SINGLE_CABLE_MAX_MM2);
  assert.ok(big.warnings.some((line) => /分回路|并联/.test(line)));
  const small = estimatePower({
    items: [{ role: 'other', qty: 1, ratedW: 1000 }],
    voltage: '380VAC',
    simultaneity: 1,
    loadFactor: 1,
    efficiency: 1,
    cosPhi: 0.9
  });
  assert.equal(small.warnings.some((line) => /分回路|并联/.test(line)), false);
});

test('④ 同一机型电气复跑无 BREAKER_OVERSIZE，矩阵全部机型都不越级', () => {
  const design = elecDesignFromMachine(synthMachine(parseMachineBrief(BRIEF_PV)), { date: '2026-11-04' });
  for (let run = 1; run <= 2; run += 1) {
    const drawing = renderElecDrawing(design, { date: '2026-11-04' });
    const findings = runElectricalCheck(drawing.document).findings;
    assert.deepEqual(
      findings.filter((item) => item.code === 'BREAKER_OVERSIZE'),
      [],
      `第 ${run} 次出图出现 BREAKER_OVERSIZE`
    );
    assert.equal(runElectricalCheck(drawing.document).counts.error, 0, `第 ${run} 次出图有 error`);
  }
  for (const [name, factory] of Object.entries(MATRIX)) {
    const drawing = renderElecDrawing(factory(), { date: '2026-11-04' });
    const findings = runElectricalCheck(drawing.document).findings;
    assert.deepEqual(
      findings.filter((item) => item.code === 'BREAKER_OVERSIZE'),
      [],
      `${name}: BREAKER_OVERSIZE`
    );
    for (const circuit of drawing.document.circuits ?? []) {
      const amp = ampacityOf(circuit.sectionMm2);
      assert.ok(amp !== null && amp >= circuit.breakerA, `${name}: 线号 ${circuit.wireNo} 载流量 ${amp}A < 断路器 ${circuit.breakerA}A`);
    }
  }
});

test('选型表与检查器共用同一张载流量表（防止两套数字漂移）', () => {
  for (const row of AMPACITY_TABLE) {
    const selection = selectCableForBreaker(row.amp, { label: `${row.mm2}mm²` });
    assert.ok(selection.sectionMm2 !== null);
    assert.ok(selection.ampacityA !== null && selection.ampacityA >= row.amp);
  }
});
