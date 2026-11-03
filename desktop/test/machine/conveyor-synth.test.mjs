import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateConveyorDrive, pitchForWidth, refineConveyor } from '../../src/machine/conveyor-synth.ts';
import { DEFAULT_CONVEYOR } from '../../src/machine/conveyor-assembly.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

test('输送需求解析：工艺/单工位/尺寸四件套', () => {
  const brief = parseMachineBrief('设计一台水平皮带输送机：总长 2000mm、带宽 300mm、工件 5kg、线速度 0.2m/s');
  assert.equal(brief.process, 'conveyor');
  assert.equal(brief.stations, 1, '输送线不存在多工位');
  // layers：单层线体没有层数线索时为 null（有转向工位时合成器据此判断 ≥2 层不做转向）
  assert.deepEqual(brief.conveyor, { lengthMm: 2000, widthMm: 300, speedMps: 0.2, loadKg: 5, layers: null });
});

test('米/m 单位换算成 mm，mm/s 换算成 m/s', () => {
  const brief = parseMachineBrief('皮带线 长 2m 宽 400mm 速度 250mm/s');
  assert.equal(brief.conveyor?.lengthMm, 2000);
  assert.equal(brief.conveyor?.widthMm, 400);
  assert.equal(brief.conveyor?.speedMps, 0.25);
});

test('驱动估算：5 kg 工件 + 0.2 m/s → 阻力与功率在合理量级', () => {
  const est = estimateConveyorDrive(DEFAULT_CONVEYOR, { speedMps: 0.2, loadKg: 5 });
  assert.ok(est.beltMassKg > 3 && est.beltMassKg < 12, `皮带质量 ${est.beltMassKg} kg`);
  assert.ok(est.forceN > 20 && est.forceN < 80, `牵引力 ${est.forceN} N`);
  assert.ok(est.powerW > 5 && est.powerW < 40, `功率 ${est.powerW} W`);
  assert.equal(est.motorW, 40, '按 2 倍余量应选 40 W 档');
  assert.ok(est.torqueNm > 0.5 && est.torqueNm < 3);
});

test('产能由线速与间距决定：0.2 m/s、间距 300 mm → 40 件/分', () => {
  const est = estimateConveyorDrive(DEFAULT_CONVEYOR, { speedMps: 0.2, loadKg: 5 });
  assert.equal(est.pitchMm, pitchForWidth(300));
  assert.equal(est.throughputPerMin, 40);
});

test('refineConveyor 把公式写进 assumptions', () => {
  const refined = refineConveyor({ conveyor: { lengthMm: 2000, widthMm: 300, speedMps: 0.2, loadKg: 5 }, cyclePerMin: null });
  const text = refined.assumptions.join('\n');
  assert.match(text, /产能由线速决定/);
  assert.match(text, /摩擦 μ=0\.3/);
  assert.match(text, /P = F·v \/ η/);
  assert.match(refined.summary, /40 W/);
});

test('整机合成：输送机形态、无旋转轴 BOM、结构件齐全', () => {
  const brief = parseMachineBrief('设计一台水平皮带输送机：总长 2000mm、带宽 300mm、工件 5kg、线速度 0.2m/s');
  const design = synthMachine(brief);
  assert.equal(design.form.id, 'belt-line');
  assert.equal(design.config.stations.length, 1);
  assert.equal(design.cycle.throughputPerMin, 40);
  assert.equal(design.cycle.meetsTarget, true);
  const names = design.bomDraft.items.map((item) => item.name).join('|');
  assert.doesNotMatch(names, /旋转轴/, 'BOM 不应再有旋转轴占位');
  assert.match(names, /皮带输送线体/);
  assert.match(names, /减速电机 40 W/);
  assert.match(names, /张紧滑座/);
});

test('目标节拍高于线速产能时给出提速建议', () => {
  const brief = parseMachineBrief('皮带输送机 长 2000mm 宽 300mm 线速 0.2m/s 节拍 60 件/分钟');
  const design = synthMachine(brief);
  assert.equal(design.cycle.meetsTarget, false);
  const warning = design.warnings.join('\n');
  assert.match(warning, /线速|产能不足/);
});
