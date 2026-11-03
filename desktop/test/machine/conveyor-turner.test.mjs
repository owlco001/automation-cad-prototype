// 转向工位（光伏板 90° 旋转）：需求解析 → 几何 → 运动轴 → BOM 的整链验收。
//
// 口径：这里只断言「按尺寸能推出来的东西」——旋转轴角度、零件位置、台面高度叠层、
// BOM 归并。真实 B-Rep 干涉不在单测里跑（要 build123d 内核），由
// scripts/boolean-recheck 一类的复核入口单独出结论。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  DEFAULT_CONVEYOR,
  turnerLayout,
  turnerSkipReason
} from '../../src/machine/conveyor-assembly.ts';
import { detectTurner, parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { validateFeatures } from '../../src/parametric/features.ts';

const LINE = {
  lengthMm: 6000,
  widthMm: 1200,
  beltHeightMm: 850,
  pulleyDiameterMm: 50,
  beltThicknessMm: 4,
  frameSectionMm: 40,
  layers: 1,
  turnerAngleDeg: 90
};
const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';

const parts = buildConveyorParts(LINE);
const baseline = buildConveyorParts({ ...LINE, turnerAngleDeg: 0 });
const byId = (id, list = parts) => list.find((part) => part.id === id);

test('需求解析：转向意图 + 角度（缺省 90，四种写法都认）', () => {
  assert.deepEqual(detectTurner('需要把光伏板旋转 90° 改变方向'), { present: true, angleDeg: 90 });
  assert.deepEqual(detectTurner('旋转90度'), { present: true, angleDeg: 90 });
  assert.deepEqual(detectTurner('旋转 90 ° 转向'), { present: true, angleDeg: 90 });
  assert.deepEqual(detectTurner('转 90 度'), { present: true, angleDeg: 90 });
  assert.deepEqual(detectTurner('90° 转向'), { present: true, angleDeg: 90 });
  assert.deepEqual(detectTurner('需要转向'), { present: true, angleDeg: 90 }, '只说转向，角度缺省 90');
  assert.deepEqual(detectTurner('旋转 45 度换向'), { present: true, angleDeg: 45 });
  assert.deepEqual(detectTurner('旋转 180 度调头'), { present: true, angleDeg: 180 });

  // 反向：没有转向需求的 brief 不能凭空长出转向工位
  assert.equal(detectTurner('点胶机 带旋转轴 4 个'), null, '「旋转轴 4 个」是轴数量，不是 4°');
  assert.equal(detectTurner('分度盘 90 度分度'), null, '分度盘的 90° 不是转向意图');
  assert.equal(detectTurner('皮带输送机 长 2000mm 宽 300mm 线速 0.2m/s'), null);
});

test('需求解析：brief.turner 进结构化字段，角度识别失败不污染其它字段', () => {
  const brief = parseMachineBrief(PV_BRIEF);
  assert.equal(brief.process, 'conveyor');
  assert.deepEqual(brief.turner, { present: true, angleDeg: 90 });
  assert.ok(brief.notes.some((note) => /转向工位.*90°/.test(note)));
  const plain = parseMachineBrief('皮带输送机 长 2000mm 宽 300mm 线速 0.2m/s');
  assert.equal(plain.turner, undefined);
});

test('几何：转台面在中段、直径托得住 1200 宽的板、台面顶与皮带面齐平', () => {
  const layout = turnerLayout(LINE);
  assert.ok(layout, '单层线体应该能建转向工位');
  assert.equal(layout.tableDiameterMm, 1400);
  assert.ok(layout.tableDiameterMm >= LINE.widthMm + 200, '台面直径必须 ≥ 带宽 + 200');
  assert.equal(layout.tableTopZ, LINE.beltHeightMm, '台面顶与皮带面齐平，光伏板才能平推上去');
  assert.equal(layout.ringHeightMm, 20, '垂直空间 = 滚筒直径 - 底板 - 台面');

  const table = byId('turner-table');
  assert.ok(table, '缺少 turner-table');
  assert.equal(table.transform.x, 0, '转向工位必须在线体中段');
  assert.equal(table.transform.y, 0);
  const body = table.features.find((node) => node.id === 'turner-table-body');
  assert.equal(body?.params.diameter, 1400);
  assert.equal(body?.params.axis, 'z', '台面是竖直轴圆柱（绕 Z 回转）');

  // 4 只台面滚轮：沿 Y 的横轴，轮顶比台面高 2 mm（进出料方向滚得动）
  const rollers = parts.filter((part) => /^turner-roller-\d$/.test(part.id));
  assert.equal(rollers.length, 4);
  for (const roller of rollers) {
    const body = roller.features[0];
    assert.equal(body?.params.axis, 'y', '滚轮必须是横轴（竖直轴滚轮托不住板面）');
    assert.equal(roller.transform.z + Number(body?.params.diameter) / 2, layout.tableTopZ + 2);
  }
});

test('几何：转向段皮带/挡边断开，转台装在断口里，不与皮带滚筒抢位置', () => {
  assert.equal(byId('belt-top'), undefined, '有转向工位时上行程必须断开');
  const segments = ['belt-top-in', 'belt-top-out', 'belt-return-in', 'belt-return-out'];
  for (const id of segments) assert.ok(byId(id), `缺少分段 ${id}`);
  for (const side of ['left', 'right']) {
    for (const seg of ['in', 'out']) assert.ok(byId(`guard-${side}-${seg}`), `缺少挡边分段 ${side}/${seg}`);
  }
  const layout = turnerLayout(LINE);
  for (const id of segments) {
    const part = byId(id);
    const half = Number(part.features[0].params.length) / 2;
    const inner = Math.abs(part.transform.x) - half;
    assert.ok(
      Math.abs(inner - layout.gapHalfMm) < 0.01,
      `${id} 断口应在 |x|=${layout.gapHalfMm}（转台半径 + 6 mm 间隙），实际 ${inner}`
    );
    assert.ok(layout.gapHalfMm > layout.tableDiameterMm / 2, '断口必须比台面半径大，否则皮带会插进台面');
  }
  // 没有转向需求时零件表保持原样（28 件、皮带整条）
  assert.equal(byId('belt-top', baseline)?.features[0].params.length, 5960);
  assert.equal(baseline.some((part) => part.id.startsWith('turner-')), false);
});

test('几何：转向件竖向叠层严格上下贴合（底板→回转支承→台面），不互穿', () => {
  const base = byId('turner-base');
  const ring = byId('turner-ring');
  const table = byId('turner-table');
  const half = (part) => Number(part.features[0].params.height) / 2;
  const baseTop = base.transform.z + half(base);
  const ringBottom = ring.transform.z - half(ring);
  const ringTop = ring.transform.z + half(ring);
  const tableBottom = table.transform.z - half(table);
  assert.equal(baseTop, ringBottom, '回转支承坐在底板上（面贴合，不互穿）');
  assert.equal(ringTop, tableBottom, '台面坐在回转支承上');
  // 底板坐在两侧纵梁上沿（纵梁顶 = 皮带面 - 滚筒直径）
  const railTop = LINE.beltHeightMm - LINE.pulleyDiameterMm;
  assert.equal(base.transform.z - half(base), railTop);
  const maxRailY = LINE.widthMm / 2 + LINE.frameSectionMm / 2 + 15 + LINE.frameSectionMm / 2;
  assert.equal(Number(base.features[0].params.width), maxRailY * 2, '底板要盖住两侧纵梁全宽');
});

test('几何：回转支承是薄壁环（中孔），不是实心饼', () => {
  const ring = byId('turner-ring');
  const bore = ring.features.find((node) => node.type === 'holes');
  assert.equal(bore?.params.diameter, 780);
  assert.equal(bore?.params.positions?.[0]?.[0], 0);
  // 环形体积 ≈ π/4 (D² - d²) h，用质量样本值兜住「90 kg 的饼」这种错法
  const bom = conveyorBom(parts, {});
  const row = bom.find((entry) => entry.name === '回转支承环');
  assert.ok(row && row.massKg !== null && row.massKg > 10 && row.massKg < 30, `回转支承质量 ${row?.massKg} kg 不像薄壁环`);
});

test('运动轴：rotary 轴 90°、工位「转向工位」、点位 ST-TURN-ROT 进 io-map', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  assert.deepEqual(design.config.stations, ['工位1', '转向工位']);
  const axis = design.config.actuators.find((actuator) => actuator.id === 'turner-rotary');
  assert.ok(axis, '缺少 turner-rotary 轴');
  assert.equal(axis.kind, 'rotary');
  assert.equal(axis.rotationRangeDeg, 90);
  assert.equal(axis.station, '转向工位');
  assert.equal(axis.point, 'ST-TURN-ROT');
  assert.equal(axis.durationMs, 1800, '90° 转向 1.8 s 要计入工位时间');
  assert.ok(design.points.includes('ST-TURN-ROT'));

  const io = buildMachineIoMap(design.config);
  const row = io.rows.find((entry) => entry.point === 'ST-TURN-ROT');
  assert.ok(row, 'PLC io-map 必须含转向轴点位');
  assert.equal(row.direction, '输出');
  assert.equal(row.station, '转向工位');
});

test('节拍：转向动作计入工位时间，产能取 min(线速, 60/转向时间)', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  assert.equal(design.cycle.throughputPerMin, 10, '0.2 m/s ÷ 1200 mm = 10 件/分');
  assert.equal(design.cycle.slowestActionSeconds, 1.8);
  assert.match(design.cycle.bottleneck, /转向工位每件 1\.8 s（90°）→ 33\.33 件\/分钟/);
  assert.ok(design.assumptions.some((text) => /回转轴 turner-rotary.*1\.8 s/.test(text)));

  // 皮带 40 件/分、转向 180° 只有 20 件/分 → 转向成为瓶颈并告警
  const slow = synthMachine(parseMachineBrief('皮带输送线 长 3000mm 宽 300mm 线速 0.2m/s 旋转 180 度转向 节拍 30 件/分钟'));
  assert.equal(slow.cycle.throughputPerMin, 20, '60 / 3 s = 20 件/分');
  assert.equal(slow.cycle.meetsTarget, false);
  assert.ok(slow.warnings.some((text) => /转向工位/.test(text)));
});

test('立体缓存 ≥2 层：不加转向工位，并在 warnings 里说明原因', () => {
  const brief = parseMachineBrief('光伏板缓存线 线体长 4000mm 带宽 1200mm 3 层立体缓存，需要把光伏板旋转 90° 改变方向');
  assert.equal(brief.conveyor?.layers, 3);
  const design = synthMachine(brief);
  assert.deepEqual(design.config.stations, ['工位1'], '不做转向工位就不该多出工位');
  assert.equal(design.config.actuators.some((actuator) => actuator.id === 'turner-rotary'), false);
  assert.equal(design.bomDraft.items.some((item) => /转向工位底板|回转支承环/.test(item.name)), false);
  assert.ok(design.warnings.some((text) => /立体缓存（3 层）不加转向工位/.test(text)));

  const layered = buildConveyorParts({ ...LINE, lengthMm: 4000, layers: 3 });
  assert.equal(layered.some((part) => part.id.startsWith('turner-')), false);
  assert.equal(layered.some((part) => part.id === 'belt-top'), true, '立体缓存仍是整条皮带');
  assert.match(String(turnerSkipReason({ ...LINE, layers: 3 })), /立体缓存/);
});

test('做不了的情形要如实拒绝：线体太短 / 滚筒直径太小', () => {
  assert.match(String(turnerSkipReason({ ...LINE, lengthMm: 900 })), /放不下转向段/);
  assert.equal(turnerLayout({ ...LINE, lengthMm: 900 }), null);
  assert.match(String(turnerSkipReason({ ...LINE, pulleyDiameterMm: 30 })), /垂直空间不够/);
  assert.equal(turnerLayout({ ...LINE, pulleyDiameterMm: 30 }), null);
  // 没要求转向就没理由
  assert.equal(turnerSkipReason({ ...LINE, turnerAngleDeg: 0 }), null);
  assert.equal(turnerLayout({ ...LINE, turnerAngleDeg: 0 }), null);
});

test('包络：转向件不把整机撑大（长度不变，宽度只多电机外挂那点）', () => {
  const [tl, tw, th] = conveyorEnvelope(parts);
  const [bl, bw, bh] = conveyorEnvelope(baseline);
  assert.equal(tl, bl, '长度不变（转台在中段，不向外伸）');
  assert.ok(tw - bw < 120, `宽度只该多出外挂电机：${bw} → ${tw}`);
  assert.equal(th, bh, '高度不变（台面与皮带面齐平）');
  assert.ok(tl <= LINE.lengthMm * 1.01 && tw <= LINE.widthMm * 1.5);
});

test('BOM：转向工位按 conveyorBom 口径归并（滚轮 4 只一行，成品件/加工件分行）', () => {
  const bom = conveyorBom(parts, {});
  const row = (name) => bom.find((entry) => entry.name === name);
  assert.ok(row('转向工位底板'), '缺少底板行');
  assert.ok(row('回转支承环'), '缺少回转支承行');
  assert.ok(row('转向转台面'), '缺少台面行');
  assert.equal(row('台面滚轮')?.qty, 4, '4 只台面滚轮必须归并成一行 qty=4');
  assert.equal(bom.filter((entry) => entry.name === '台面滚轮').length, 1);
  assert.ok(row('转向减速电机'), '缺少转向电机行');
  // 皮带断开后仍按「同名同规格」归并成 2 件
  assert.equal(row('皮带上行程')?.qty, 2);
  assert.equal(row('侧挡边')?.qty, 4);

  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const names = design.bomDraft.items.map((item) => item.name).join('|');
  assert.match(names, /转向工位底板/);
  assert.match(names, /回转支承环/);
  assert.match(names, /转向转台面/);
  assert.match(names, /台面滚轮 φ30×40/);
  assert.match(names, /转向减速电机 0\.75 kW/);
  assert.doesNotMatch(names, /^旋转轴\$/);
});

test('特征树合法性：转向件都是可交给内核的合法参数化特征', () => {
  assert.deepEqual(validateFeatures(conveyorAssembly(parts)), []);
  for (const id of ['turner-base', 'turner-ring', 'turner-table', 'turner-roller-1', 'turner-motor']) {
    const part = byId(id);
    assert.ok(part, `缺少 ${id}`);
    for (const node of part.features) {
      if (node.type !== 'box' && node.type !== 'cylinder') continue; // holes 是切除，只有直径没有长度
      const size = node.type === 'cylinder' ? Number(node.params.diameter) : Number(node.params.length);
      const height = Number(node.params.height);
      assert.ok(Number.isFinite(size) && size > 0, `${id} 出现非正截面`);
      assert.ok(Number.isFinite(height) && height > 0, `${id} 出现非正高度`);
    }
  }
});
