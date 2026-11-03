// 转向工位（光伏板 90° 旋转）= 顶升旋转单元：需求解析 → 几何 → 运动轴 → BOM 的整链验收。
//
// 口径：这里只断言「按尺寸能推出来的东西」——窄带并联布局、带缝与指宽、竖向叠层、
// 两条运动轴与四个到位信号、节拍、BOM 归并。真实 B-Rep 干涉（静止位 / 顶升到位 /
// 0..60 mm 全程扫掠）不在单测里跑（要 build123d 内核），由 lift-brep-check.py 单独出结论。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  DEFAULT_CONVEYOR,
  narrowBeltLayout,
  turnerActionSeconds,
  turnerLiftSeconds,
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
const BELT_FACE = LINE.beltHeightMm;
const BELT_BOTTOM = LINE.beltHeightMm - LINE.beltThicknessMm;

const parts = buildConveyorParts(LINE);
const baseline = buildConveyorParts({ ...LINE, turnerAngleDeg: 0 });
const byId = (id, list = parts) => list.find((part) => part.id === id);
const halfOf = (part) => Number(part.features[0].params.height) / 2;
const layout = turnerLayout(LINE);

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

test('几何：窄带并联 6×80、带缝 120、指宽 70 落在缝里、上行程整条连续', () => {
  const belts = narrowBeltLayout(LINE);
  assert.equal(belts.count, 6, '1200 宽 = 6 条 80 窄带');
  assert.equal(belts.widthMm, 80);
  assert.equal(belts.gapMm, 120, '等节距 200 → 带缝 120（100~120 的目标区间）');
  assert.deepEqual(belts.gaps, [-400, -200, 0, 200, 400]);
  assert.deepEqual(belts.centers, [-500, -300, -100, 100, 300, 500]);
  // 上行程：6 条各自整条，不因转向断开；回程只在单元处断开
  for (let index = 1; index <= 6; index += 1) {
    const top = byId(`belt-${index}`);
    assert.ok(top, `缺少 belt-${index}`);
    assert.equal(top.features[0].params.length, LINE.lengthMm - 40, '上行程必须是整条（不为转向断开）');
    assert.equal(top.features[0].params.width, 80);
    assert.equal(top.transform.x, 0);
    assert.equal(layout?.beltCenterYs[index - 1], top.transform.y);
  }
  assert.equal(byId('belt-top'), undefined, '窄带不再用 belt-top 命名');
  // 顶升指：指宽必须小于带缝，且指位在带缝中心
  assert.ok(layout);
  assert.ok(layout.fingerWidthMm < layout.beltGapMm, `指宽 ${layout.fingerWidthMm} 必须小于带缝 ${layout.beltGapMm}`);
  for (const [x, y] of layout.fingerCenters) {
    const halfFinger = layout.fingerWidthMm / 2;
    const gapCenters = [0, ...layout.beltCenterYs.map((c) => c + layout.beltPitchMm / 2)];
    assert.ok(
      gapCenters.some((gap) => Math.abs(gap - y) <= halfFinger || Math.abs(gap - x) <= halfFinger || (x === 0 && y === 0)),
      `指位 (${x}, ${y}) 必须落在带缝里`
    );
  }
  // 4 折对称：转 90° 后指位集合不变，否则回落时指会横跨带体
  const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  const fingerSet = new Set(layout.fingerCenters.map(([x, y]) => key(x, y)));
  for (const [x, y] of layout.fingerCenters) {
    assert.ok(fingerSet.has(key(-y, x)), `指位 (${x}, ${y}) 转 90° 后不在同一组位置，回落会撞带`);
  }
  assert.equal(layout.fingerCenters.length, 9, '中心 1 + 两轴各 4 = 9 只支撑指');
});

test('几何：台盘/回转支承/台板都在带面以下，顶升 60 后盘顶仍低于带底', () => {
  assert.ok(layout);
  assert.equal(layout.strokeMm, 60, '顶升行程 60（> 带厚 4 + 工件厚度一半）');
  assert.equal(layout.padTopZ, BELT_FACE - 5, '指垫顶比皮带面低 5 mm：静止时工件完全压在带上');
  assert.ok(layout.padTopZ < BELT_BOTTOM, '指垫顶必须在带底以下，否则会顶到工件');
  assert.equal(layout.padTopLiftZ, layout.padTopZ + layout.strokeMm);
  assert.ok(layout.padTopLiftZ - BELT_FACE >= 50, `顶升后指垫只比带面高 ${layout.padTopLiftZ - BELT_FACE} mm`);

  const table = byId('turner-table');
  assert.ok(table, '缺少 turner-table');
  const tableTopRest = table.transform.z + halfOf(table);
  assert.equal(tableTopRest, BELT_BOTTOM - 62, '台盘顶在带底以下 62 mm（844 − 60 行程后仍 2 mm 余量）');
  assert.ok(tableTopRest + layout.strokeMm < BELT_BOTTOM, '顶升到位时台盘顶也必须低于带底，否则会插进带面');
  assert.equal(Number(table.features[0].params.diameter), 880, '台盘直径留在单元占位（900）内');
  assert.equal(table.features[0].params.axis, 'z', '台盘是竖直轴圆柱（绕 Z 回转）');

  const ring = byId('turner-ring');
  assert.ok(ring);
  assert.ok(ring.transform.z + halfOf(ring) + layout.strokeMm < BELT_BOTTOM, '回转支承顶升到位也不许穿过带底');

  const plate = byId('turner-lift-plate');
  assert.ok(plate);
  assert.ok(plate.transform.z + halfOf(plate) + layout.strokeMm < BELT_BOTTOM + 100, '台板顶升后仍在带面附近');
});

test('几何：竖向叠层严格上下贴合（底盘→气缸→台板→回转支承→台盘→支撑指）', () => {
  assert.ok(layout);
  const bottom = (part) => part.transform.z - halfOf(part);
  const top = (part) => part.transform.z + halfOf(part);
  const frame = byId('turner-lift-frame');
  const cyl = byId('turner-lift-cyl-1');
  const plate = byId('turner-lift-plate');
  const ring = byId('turner-ring');
  const table = byId('turner-table');
  assert.ok(frame && cyl && plate && ring && table);

  assert.equal(bottom(cyl), top(frame), '气缸坐在底盘上（面贴合）');
  assert.equal(bottom(plate), top(cyl) + 24, '活塞杆露出 24 mm 顶住台板底面');
  assert.equal(top(plate), bottom(ring), '回转支承坐在台板上');
  assert.equal(top(ring), bottom(table), '台盘坐在回转支承上');
  // 底座框架坐在两侧纵梁上沿（纵梁顶 = 皮带面 − 滚筒直径）
  const base = byId('turner-base-left');
  assert.equal(bottom(base), LINE.beltHeightMm - LINE.pulleyDiameterMm, '底座框架坐在纵梁顶');
  assert.equal(Number(base.features[0].params.length), 2 * layout.unitHalfMm, '底座框架 X 向 = 单元占位 900');

  // 支撑指：指垫顶 = 845，柱底 = 台盘顶
  const finger = byId('turner-finger-1');
  assert.ok(finger);
  const pad = finger.features.find((node) => node.id === 'turner-finger-1-pad');
  assert.equal(finger.transform.z + Number(pad.params.height) / 2, layout.padTopZ);
  const post = finger.features.find((node) => node.id === 'turner-finger-1-post');
  const postCenterZ = finger.transform.z + Number(post.params.at[2]);
  assert.equal(postCenterZ - Number(post.params.height) / 2, top(table), '指柱落在台盘顶面上');
});

test('几何：回转支承是薄壁环（中孔），不是实心饼', () => {
  const ring = byId('turner-ring');
  assert.ok(ring);
  const bore = ring.features.find((node) => node.type === 'holes');
  assert.equal(bore?.params.diameter, 280);
  assert.equal(bore?.params.positions?.[0]?.[0], 0);
  // 环形体积 ≈ π/4 (D² − d²) h，用质量样本值兜住「90 kg 的饼」这种错法
  const bom = conveyorBom(parts, {});
  const row = bom.find((entry) => entry.name === '回转支承环');
  assert.ok(row && row.massKg !== null && row.massKg > 1 && row.massKg < 30, `回转支承质量 ${row?.massKg} kg 不像薄壁环`);
});

test('运动轴：顶升（Z 向、行程 60）+ 旋转（90°）两条轴，四个到位信号都绑对执行机构', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  assert.deepEqual(design.config.stations, ['工位1', '转向工位']);
  const lift = design.config.actuators.find((actuator) => actuator.id === 'turner-lift');
  const rotary = design.config.actuators.find((actuator) => actuator.id === 'turner-rotary');
  assert.ok(lift, '缺少 turner-lift 顶升轴');
  assert.ok(rotary, '缺少 turner-rotary 旋转轴');
  assert.equal(lift.station, '转向工位');
  assert.equal(lift.travelMm, 60, '顶升行程 60 mm');
  assert.equal(lift.durationMs, 2000, '举升 + 回落两趟共 2.0 s 计入工位时间');
  assert.deepEqual(lift.position, [0, 0, 0.05], '顶升是 Z 向（向上）');
  assert.equal(rotary.kind, 'rotary');
  assert.equal(rotary.rotationRangeDeg, 90);
  assert.equal(rotary.durationMs, 1800, '90° 分度 1.8 s');
  assert.equal(rotary.point, 'ST-TURN-ROT');

  // 四个点位：台面在下 / 顶升到位 → turner-lift；旋转原点 / 旋转到位 → turner-rotary
  const bound = (point) => design.config.sensors.find((sensor) => sensor.point === point)?.part;
  assert.equal(bound('ST-TURN-LIFT-HOME'), 'turner-lift');
  assert.equal(bound('ST-TURN-LIFT-POS'), 'turner-lift');
  assert.equal(bound('ST-TURN-ROT-HOME'), 'turner-rotary');
  assert.equal(bound('ST-TURN-ROT-POS'), 'turner-rotary');
  for (const point of ['ST-TURN-LIFT', 'ST-TURN-ROT', 'ST-TURN-LIFT-HOME', 'ST-TURN-LIFT-POS', 'ST-TURN-ROT-HOME', 'ST-TURN-ROT-POS']) {
    assert.ok(design.points.includes(point), `点位 ${point} 没进设计点位表`);
  }

  const io = buildMachineIoMap(design.config);
  const row = io.rows.find((entry) => entry.point === 'ST-TURN-ROT');
  assert.ok(row, 'PLC io-map 必须含转向轴点位');
  assert.equal(row.direction, '输出');
  assert.equal(row.station, '转向工位');
  assert.ok(io.rows.some((entry) => entry.point === 'ST-TURN-LIFT'), 'io-map 必须含顶升轴点位');
  assert.ok(io.rows.some((entry) => entry.point === 'ST-TURN-LIFT-POS'), 'io-map 必须含顶升到位输入');
});

test('节拍：顶升 + 旋转 + 回落三段之和计入工位时间', () => {
  assert.equal(turnerLiftSeconds(60), 2, '60 mm 单趟 1.0 s，举升 + 回落 = 2.0 s');
  assert.equal(turnerActionSeconds(90), 3.8, '2.0 顶升回落 + 1.8 旋转');
  assert.equal(turnerActionSeconds(180), 5, '2.0 + 3.0');
  assert.equal(turnerActionSeconds(45), 3.2, '2.0 + 1.2');

  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  assert.equal(design.cycle.throughputPerMin, 10, '0.2 m/s ÷ 1200 mm = 10 件/分');
  assert.equal(design.cycle.slowestActionSeconds, 3.8);
  assert.match(design.cycle.bottleneck, /转向工位每件 3\.8 s（顶升\+旋转 90°\+回落）→ 15\.79 件\/分钟/);
  assert.ok(design.assumptions.some((text) => /合计 3\.8 s\/件/.test(text)));

  // 线速更快时转向成为瓶颈：0.4 m/s ÷ 600 mm = 40 件/分，180° 只有 12 件/分
  const slow = synthMachine(
    parseMachineBrief('光伏板输送线 长 6000mm 带宽 1200mm 输送 600mm 板 线速 0.4m/s 旋转 180 度转向 节拍 30 件/分钟')
  );
  assert.equal(slow.cycle.throughputPerMin, 12, '60 / 5 s = 12 件/分');
  assert.equal(slow.cycle.meetsTarget, false);
  assert.ok(slow.warnings.some((text) => /转向工位/.test(text)));
});

test('立体缓存 ≥2 层：不加转向工位，并在 warnings 里说明原因', () => {
  const brief = parseMachineBrief('光伏板缓存线 线体长 4000mm 带宽 1200mm 3 层立体缓存，需要把光伏板旋转 90° 改变方向');
  assert.equal(brief.conveyor?.layers, 3);
  const design = synthMachine(brief);
  assert.deepEqual(design.config.stations, ['工位1'], '不做转向工位就不该多出工位');
  assert.equal(design.config.actuators.some((actuator) => actuator.id === 'turner-rotary'), false);
  assert.equal(design.bomDraft.items.some((item) => /转向工位底座框架|回转支承环/.test(item.name)), false);
  assert.ok(design.warnings.some((text) => /立体缓存（3 层）不加转向工位/.test(text)));

  const layered = buildConveyorParts({ ...LINE, lengthMm: 4000, layers: 3 });
  assert.equal(layered.some((part) => part.id.startsWith('turner-')), false);
  assert.equal(layered.some((part) => part.id === 'belt-top'), true, '立体缓存仍是整条宽带');
  assert.match(String(turnerSkipReason({ ...LINE, layers: 3 })), /立体缓存/);
});

test('做不了的情形要如实拒绝：线体太短 / 带宽太窄 / 滚筒太大', () => {
  assert.match(String(turnerSkipReason({ ...LINE, lengthMm: 900 })), /放不下顶升单元/);
  assert.equal(turnerLayout({ ...LINE, lengthMm: 900 }), null);
  assert.match(String(turnerSkipReason({ ...LINE, widthMm: 300 })), /放不下窄带并联/);
  assert.equal(turnerLayout({ ...LINE, widthMm: 300 }), null);
  assert.match(String(turnerSkipReason({ ...LINE, pulleyDiameterMm: 190 })), /滚筒 φ190 mm 太大/);
  assert.equal(turnerLayout({ ...LINE, pulleyDiameterMm: 190 }), null);
  // 没要求转向就没理由
  assert.equal(turnerSkipReason({ ...LINE, turnerAngleDeg: 0 }), null);
  assert.equal(turnerLayout({ ...LINE, turnerAngleDeg: 0 }), null);
});

test('包络：单元不把整机撑大（长度不变、宽度只多外挂电机、高度仍在带面上下）', () => {
  const [tl, tw, th] = conveyorEnvelope(parts);
  const [bl, bw, bh] = conveyorEnvelope(baseline);
  assert.equal(tl, bl, '长度不变（单元在中段，不向外伸）');
  assert.equal(tw, bw, '宽度不变（顶升件全在纵梁之间，电机也不外挂到挡边之外）');
  assert.equal(th, bh, '高度不变（所有顶升件都在带面以下）');
  assert.ok(tl <= LINE.lengthMm * 1.01 && tw <= LINE.widthMm * 1.5);
});

test('BOM：顶升单元按 conveyorBom 口径归并（9 指一行、6 条窄带一行）', () => {
  const bom = conveyorBom(parts, {});
  const row = (name) => bom.find((entry) => entry.name === name);
  assert.ok(row('转向工位底座框架'), '缺少底座框架行');
  assert.equal(row('转向工位底座框架')?.qty, 2, '左右两根底座梁归并成一行');
  assert.ok(row('顶升下沉框架底盘'), '缺少下沉框架行');
  assert.equal(row('下沉框架吊柱')?.qty, 4);
  assert.equal(row('顶升气缸')?.qty, 2);
  assert.equal(row('升降导向柱')?.qty, 4);
  assert.ok(row('升降台板'), '缺少升降台板行');
  assert.ok(row('回转支承环'), '缺少回转支承行');
  assert.ok(row('转向转台盘'), '缺少转台盘行');
  assert.equal(row('转向支撑指')?.qty, 9, '9 只支撑指必须归并成一行 qty=9');
  assert.ok(row('转向减速电机'), '缺少转向电机行');
  // 窄带并联：6 条上行程 + 6 条回程，各归并一行
  assert.equal(row('皮带上行程')?.qty, 6);
  assert.equal(row('皮带回程')?.qty, 12, '回程在单元处断开成 12 段');
  assert.equal(row('主动滚筒')?.qty, 6);
  assert.equal(row('从动滚筒')?.qty, 6);
  assert.equal(row('侧挡边')?.qty, 2, '挡边整条不断（单元件都在 y ≤ 带宽/2 以内）');

  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const names = design.bomDraft.items.map((item) => item.name).join('|');
  assert.match(names, /转向工位底座框架/);
  assert.match(names, /顶升气缸 φ80×56/);
  assert.match(names, /回转支承环 φ400\/φ280×18/);
  assert.match(names, /转向转台盘 φ880×10/);
  assert.match(names, /转向支撑指 70×70 \+ φ20×55/);
  assert.match(names, /窄带并联 6 × 80 mm/);
  assert.match(names, /转向减速电机 0\.75 kW/);
  assert.doesNotMatch(names, /^旋转轴\$/);
});

test('特征树合法性：转向件都是可交给内核的合法参数化特征', () => {
  assert.deepEqual(validateFeatures(conveyorAssembly(parts)), []);
  const ids = [
    'turner-base-left',
    'turner-lift-frame',
    'turner-lift-cyl-1',
    'turner-guide-post-1',
    'turner-lift-plate',
    'turner-ring',
    'turner-table',
    'turner-finger-1',
    'turner-motor'
  ];
  for (const id of ids) {
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
  // 台板的导向过孔必须与导向柱同位，否则台板会被柱子顶穿
  const plate = byId('turner-lift-plate');
  const holes = plate.features.find((node) => node.type === 'holes');
  assert.equal(holes?.params.positions.length, 4);
  const posts = parts.filter((part) => part.id.startsWith('turner-guide-post-'));
  const holeSet = new Set(holes.params.positions.map(([x, y]) => `${x},${y}`));
  for (const post of posts) {
    assert.ok(holeSet.has(`${post.transform.x},${post.transform.y}`), `导向柱 ${post.id} 没有对应过孔`);
  }
  // 底座框架/下调框架不吃 DEFAULT_CONVEYOR 的默认值
  assert.equal(buildConveyorParts(DEFAULT_CONVEYOR).some((part) => part.id.startsWith('turner-')), false);
});
