import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateConveyorDrive, pitchForWidth, refineConveyor } from '../../src/machine/conveyor-synth.ts';
import { DEFAULT_CONVEYOR } from '../../src/machine/conveyor-assembly.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { buildSequencePlan } from '../../src/plcgen/sequence.ts';

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

test('输送线 config 里没有任何 rotary 轴：驱动滚筒是传动件，不进站轴/步序/IO', () => {
  const brief = parseMachineBrief('设计一台水平皮带输送机：总长 2000mm、带宽 300mm、工件 5kg、线速度 0.2m/s');
  const design = synthMachine(brief);
  // ① config.actuators 为空：没有那条「分度 90°」的幽灵旋转轴
  assert.deepEqual(design.config.actuators, [], '输送线不应有站轴');
  assert.equal(design.config.actuators.filter((a) => a.kind === 'rotary').length, 0);
  // ② 驱动滚筒仍然在：BOM 里有减速电机（role=drive，有额定功率可做电机选型）
  const motor = design.bomDraft.items.find((item) => /减速电机/.test(item.name));
  assert.ok(motor, '减速电机必须留在 BOM 里');
  assert.equal(motor.role, 'drive', '驱动电机按传动件标注，不能标成 rotary');
  assert.equal(motor.ratedW, 40, '电机选型给出额定功率');
  // ③ 驱动电机计入整机功率（不是站轴，但确实耗电）
  assert.ok(
    design.power.byGroup.some((group) => group.name === '驱动电机' && group.ratedW === 40),
    `功率分组里应有驱动电机：${design.power.byGroup.map((g) => `${g.name}@${g.ratedW}`).join(',')}`
  );
  // ④ io-map 只有进出料两个光电，没有 Q 区幽灵点位
  const ioMap = buildMachineIoMap(design.config);
  assert.equal(ioMap.rows.filter((row) => row.direction === '输出').length, 0, '输送线没有站轴输出');
  assert.equal(ioMap.rows.length, 2, ioMap.rows.map((row) => row.point).join(','));
  // ⑤ 也没有任何可推导的步序（线体连续运转，不是分度轴一步一步转）
  const plan = buildSequencePlan({ config: design.config });
  assert.equal(plan.steps.length, 0, JSON.stringify(plan.steps));
  assert.equal(plan.source, 'none');
  assert.ok(
    design.assumptions.some((line) => /驱动滚筒按传动件处理/.test(line)),
    '要在 assumptions 里说明驱动滚筒按传动件处理'
  );
});

test('目标节拍高于线速产能时给出提速建议', () => {
  const brief = parseMachineBrief('皮带输送机 长 2000mm 宽 300mm 线速 0.2m/s 节拍 60 件/分钟');
  const design = synthMachine(brief);
  assert.equal(design.cycle.meetsTarget, false);
  const warning = design.warnings.join('\n');
  assert.match(warning, /线速|产能不足/);
});
