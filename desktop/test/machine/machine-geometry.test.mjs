// 整机几何唯一入口 `resolveMachineGeometry` 的守卫。
//
// 结构性问题（本次要根掉的）：同一台输送机原来有两套几何 —— 48 件代理体（评审/三态干涉/3D）
// 与 85 件参数化整机（STEP/GLB/BOM）。两边验的不是同一台机器，才会出现「评审判 FAIL、
// B-Rep 判 PASS」。这里锁住四件事：
//   1. 判定：输送类且能推出线体长/带宽 → 参数化整机；其余形态（含缺参数）→ 原生成器；
//   2. 映射：件号/名称与整机装配一一对应，执行机构件带 actuatorId，配合面不产生假干涉；
//   3. 结果：同一 config 反复调用稳定，三态 confirmed 仍为 0；
//   4. 性能：统一后没有把生成变慢一个数量级（真实计时，宽松阈值防抖）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVEYOR_FORM_IDS,
  conveyorParamsFromConfig,
  isConveyorForm,
  resolveMachineGeometry
} from '../../src/machine/machine-geometry.ts';
import { buildConveyorParts } from '../../src/machine/conveyor-assembly.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { screenInterference, mateReason } from '../../src/machine/interference.ts';
import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';
const SCREW_BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟';

const pvDesign = () => synthMachine(parseMachineBrief(PV_BRIEF));
const screwDesign = () => synthMachine(parseMachineBrief(SCREW_BRIEF));

/** 中位数（ms）：同一件事跑多次取中间值，避免 CI 抖动把性能断言判错。 */
function medianMs(run, times = 7) {
  const samples = [];
  for (let index = 0; index < times; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test('输送类 config → 参数化整机：source=conveyor-assembly，装配 85 件 / 几何 87 个刚体', () => {
  const design = pvDesign();
  assert.equal(design.form.geometry.kind, 'conveyor');
  assert.ok(CONVEYOR_FORM_IDS.has(design.form.id), `形态 id 应属于输送类：${design.form.id}`);
  assert.ok(isConveyorForm({ id: design.form.id, kind: design.form.geometry.kind }));

  const resolved = resolveMachineGeometry(design);
  assert.equal(resolved.source, 'conveyor-assembly');
  // 装配件数（BOM/STEP 口径）= 85；几何刚体数 = 87（85 + 2 根活塞杆，
  // 缸体与活塞杆在整机里是一件，顶升时必须只动活塞杆，所以按刚体拆开）。
  assert.equal(resolved.assemblyPartCount, 85);
  assert.equal(resolved.partCount, 87);
  assert.equal(resolved.geometry.parts.length, 87);
  assert.equal(resolved.geometry.assemblyPartCount, 85);
  assert.equal(resolved.geometry.geometrySource, 'conveyor-assembly');
  // 件表必须就是 STEP/GLB/BOM 用的那一份（同一 buildConveyorParts 结果）
  assert.equal(buildConveyorParts(conveyorParamsFromConfig(design.config)).length, 85);
  const assemblyIds = buildConveyorParts(conveyorParamsFromConfig(design.config)).map((part) => part.id);
  const mappedIds = resolved.geometry.parts.map((part) => part.id);
  assert.deepEqual(mappedIds.filter((id) => assemblyIds.includes(id)), assemblyIds, '装配件的件号必须逐一对应（不许改名/重排）');
  assert.deepEqual(mappedIds.filter((id) => !assemblyIds.includes(id)), ['turner-lift-cyl-1-rod', 'turner-lift-cyl-2-rod'], '只允许新增两根活塞杆');
  // 包络来自真实件（6000 mm 线体，不是 48 件代理体的 1120 mm）
  assert.ok(resolved.geometry.envelope[0] > 5900 && resolved.geometry.envelope[0] < 6100, `envelope=${resolved.geometry.envelope}`);
  assert.match(resolved.reason, /6000×1200/);
});

test('非输送形态 → 回落工位生成器，件数与直接调用生成器一致（10 种形态行为不变）', () => {
  const design = screwDesign();
  const resolved = resolveMachineGeometry(design);
  const direct = generateMachineGeometry(design);
  assert.equal(resolved.source, 'station-generator');
  assert.equal(resolved.geometry.geometrySource, 'station-generator');
  assert.equal(resolved.partCount, direct.parts.length);
  assert.deepEqual(resolved.geometry.parts.map((part) => part.id), direct.parts.map((part) => part.id));
  // 布局仍由生成器 + 形态 hint 决定（dial/linear 不能被入口吞掉）
  assert.equal(resolved.geometry.layout, direct.layout);
  assert.equal(resolved.geometry.layout, design.form.geometry.kind, '非输送类：布局跟随形态 hint');
});

test('映射后的件带 actuatorId：turner-lift 至少 2 件，且随动件打 moving', () => {
  const resolved = resolveMachineGeometry(pvDesign());
  const lift = resolved.geometry.parts.filter((part) => part.actuatorId === 'turner-lift');
  assert.ok(lift.length >= 2, `turner-lift 件数 ${lift.length}`);
  const cylinders = lift.filter((part) => /^turner-lift-cyl-\d+$/.test(part.id));
  assert.equal(cylinders.length, 2, '两台顶升气缸都带 turner-lift');
  const moving = resolved.geometry.parts.filter((part) => part.moving === true);
  assert.equal(moving.length, 14, '台板 + 回转支承 + 转台盘 + 9 只支撑指 + 2 根活塞杆');
  assert.deepEqual(
    moving.map((part) => part.id).sort(),
    ['turner-finger-1', 'turner-finger-2', 'turner-finger-3', 'turner-finger-4', 'turner-finger-5',
      'turner-finger-6', 'turner-finger-7', 'turner-finger-8', 'turner-finger-9',
      'turner-lift-cyl-1-rod', 'turner-lift-cyl-2-rod', 'turner-lift-plate', 'turner-ring', 'turner-table'].sort()
  );
  // 件的外形必须能对上真实尺寸（不是随手给的方块）
  const table = resolved.geometry.parts.find((part) => part.id === 'turner-table');
  assert.equal(table?.shape.type, 'cylinder');
  assert.equal(table?.shape.radius, 440, '转台盘 Ø880');
});

test('配合面仍被识别为 mate 而非 hits（缸体×活塞杆拆成两件后靠 actuatorId + 同轴判定）', () => {
  const resolved = resolveMachineGeometry(pvDesign());
  const screen = screenInterference(resolved.geometry);

  // 缸体与活塞杆在 BOM 里是一件，几何上必须是两个刚体（顶升时只动杆，见 mappedSolids）。
  const body = resolved.geometry.parts.find((part) => part.id === 'turner-lift-cyl-1');
  const rod = resolved.geometry.parts.find((part) => part.id === 'turner-lift-cyl-1-rod');
  assert.ok(body && rod, '缸体与活塞杆要各是一件');
  assert.equal(body.actuatorId, 'turner-lift');
  assert.equal(rod.actuatorId, 'turner-lift', '两件同属 turner-lift，mateReason 才认这一对');
  assert.equal(body.moving, undefined, '缸体是固定件');
  assert.equal(rod.moving, true, '活塞杆随台板顶升');
  assert.equal(body.shape.type, 'cylinder');
  assert.equal(body.shape.radius, 40, '缸体 Ø80');
  assert.equal(rod.shape.radius, 15, '活塞杆 Ø30');

  // 这一对被判 mate（配合面），不是 suspect / confirmed
  const mates = screen.pairs.filter((pair) => pair.classification === 'mate');
  assert.equal(mates.length, 2, '两台顶升气缸各一对配合面');
  for (const mate of mates) {
    assert.equal(mate.confirmation, 'exact', '同轴两圆柱能解析求交');
    assert.match(mate.note ?? '', /同轴嵌套配合/);
    assert.match(`${mate.a} ${mate.b}`, /turner-lift-cyl-\d+/);
  }
  assert.equal(screen.confirmed, 0, '配合面不得算确认干涉');
  assert.equal(screen.screen, 0, '配合面也不该落到待复核');
  assert.equal(screen.mates, 2);

  // mate 规则本身没被削掉：同执行机构的同轴两圆柱（不同直径）仍判 mate
  const fakeBody = { id: 'b', name: 'b', role: 'actuator', shape: { type: 'cylinder', radius: 20, length: 130, axis: 'z' }, center: [0, 0, 0], rotationZDeg: 0, actuatorId: 'lift' };
  const fakeRod = { id: 'r', name: 'r', role: 'actuator', shape: { type: 'cylinder', radius: 6, length: 95, axis: 'z' }, center: [0, 0, 20], rotationZDeg: 0, actuatorId: 'lift' };
  assert.match(String(mateReason(fakeBody, fakeRod)), /同轴嵌套配合/);
  assert.equal(screenInterference({ parts: [fakeBody, fakeRod] }).mates, 1);
});

test('三态干涉在统一模型上 confirmed=0（rest/lift/sweep 都不许因零件变多冒出新干涉）', () => {
  const design = pvDesign();
  const payload = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: design.config });
  assert.equal(payload.ok, true);
  assert.equal(payload.geometrySource, 'conveyor-assembly');
  assert.equal(payload.assemblyPartCount, 85);
  assert.equal(payload.partCount, 87);
  for (const name of ['rest', 'lift', 'sweep']) {
    const state = payload.states[name];
    assert.equal(state.confirmedHits, 0, `${name} 确认干涉必须为 0`);
    assert.equal(state.screenHits, 0, `${name} 待复核必须为 0（重叠对都有 joint 声明或属配合面）`);
    assert.equal(state.poseValidity, 'valid', `${name} 位姿可信`);
  }
  assert.equal(payload.reviewStatus, 'pass');
  // 重叠对全部落在 joints 里：没有一条是「没声明、需要人看」的
  const geometry = resolveMachineGeometry(design).geometry;
  const screen = screenInterference(geometry);
  assert.equal(screen.confirmed + screen.screen, 0, '没有一对需要人看（confirmed/screen 都是 0）');
  // 旧口径 suspects 含 mate（layout/resolve 依赖它），这里按新口径核对三者之和
  assert.equal(screen.count, screen.declared + screen.mates, '重叠对 = 声明连接 + 配合面，没有第三者');
  assert.ok(geometry.joints.length > 0, '整机必须有 joints 声明');
  for (const joint of geometry.joints) {
    assert.ok(typeof joint.reason === 'string' && joint.reason.length > 4, `${joint.a}×${joint.b} 缺中文放行理由`);
  }
});

test('同一 config 连续调用两次结果稳定（不抖；缓存与不缓存同一份件表）', () => {
  const design = pvDesign();
  const first = resolveMachineGeometry(design);
  const second = resolveMachineGeometry(design);
  assert.deepEqual(second.geometry, first.geometry);
  assert.deepEqual(second.geometry.parts.map((part) => `${part.id}:${part.center.join(',')}`),
    first.geometry.parts.map((part) => `${part.id}:${part.center.join(',')}`));
  // 换了 config 实例但内容相同，也必须同结果（不能靠对象引用）
  const clone = JSON.parse(JSON.stringify(design));
  assert.deepEqual(resolveMachineGeometry(clone).geometry, first.geometry);
});

test('缺少线体长/带宽时回落生成器而不是报错', () => {
  const design = pvDesign();
  // ① 形态是输送类，但 config 里没有 conveyor 参数（老方案/手写 config）
  const withoutParams = { ...design.config };
  delete withoutParams.conveyor;
  const fallback = resolveMachineGeometry(withoutParams);
  assert.equal(fallback.source, 'station-generator');
  assert.equal(fallback.partCount, 48);
  assert.ok(fallback.geometry.assumptions.some((line) => /无法参数化整机/.test(line)), '要写清为什么回落');

  // ② 参数在但缺带宽
  const halfParams = resolveMachineGeometry({ ...design.config, conveyor: { lengthMm: 6000, widthMm: 0 } });
  assert.equal(halfParams.source, 'station-generator');

  // ③ 参数在但缺线体长
  const noLength = resolveMachineGeometry({ ...design.config, conveyor: { lengthMm: 0, widthMm: 1200 } });
  assert.equal(noLength.source, 'station-generator');

  // ④ 形态明确是非输送类时，config 里即便带了 conveyor 参数也不改道（脏数据不是输送线）
  const screw = screwDesign();
  const confused = resolveMachineGeometry({ ...screw.config, conveyor: { lengthMm: 2000, widthMm: 300 } });
  assert.equal(confused.source, 'station-generator');
  assert.equal(confused.partCount, generateMachineGeometry(screw.config).parts.length);

  // ⑤ 老方案没写 formId，但有 conveyor 参数 → 按参数认作输送类（否则老机型永远回落代理体）
  const legacy = { ...design.config };
  delete legacy.formId;
  const restored = resolveMachineGeometry(legacy);
  assert.equal(restored.source, 'conveyor-assembly');
  assert.equal(restored.assemblyPartCount, 85);

  // ⑥ 老方案既没 formId 也没参数 → 回落，不报错
  const bare = { ...design.config };
  delete bare.formId;
  delete bare.conveyor;
  assert.equal(resolveMachineGeometry(bare).source, 'station-generator');
});

test('性能：统一后的生成耗时不得高于统一前 3 倍（真实计时，宽松阈值）', () => {
  const design = pvDesign();
  const before = medianMs(() => generateMachineGeometry(design.config, { bypassCache: true }));
  const after = medianMs(() => resolveMachineGeometry(design, { bypassCache: true }));
  const ratio = after / Math.max(before, 0.5);
  console.log(`[perf] generateMachineGeometry=${before.toFixed(2)} ms  resolveMachineGeometry=${after.toFixed(2)} ms  ratio=${ratio.toFixed(2)}x`);
  assert.ok(after < 50, `统一入口生成耗时 ${after.toFixed(2)} ms，超过 50 ms 说明出了大问题`);
  assert.ok(ratio <= 3, `统一后 ${after.toFixed(2)} ms > 统一前 ${before.toFixed(2)} ms 的 3 倍（${ratio.toFixed(2)}x）`);
});
