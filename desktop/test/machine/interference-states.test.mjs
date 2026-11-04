// 状态化干涉检查的判定口径守卫（本次故障的直接回归）：
// 1) 同轴嵌套的执行机构零件（缸体×活塞杆）不得被当成设计干涉；
// 2) screen hit（只有 AABB 依据 / 位姿不可达）不得判 fail，只有解析式确认的实体重叠才 fail；
// 3) 真干净时仍然必须是 0（不许为了消警把数字抹平）；
// 4) 转向工位必须是「自下向上的顶升台」而不是压机：位姿三态都 valid，
//    不许再靠 direction-overridden 把「活塞杆整根推进缸体」这类建模假象降级掉；
// 5) 传感器支架按支架宽度排开、joints 只放行「支架×传感器本体」，支架互穿要报出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenInterference, exactOverlapMm3, mateReason } from '../../src/machine/interference.ts';
import { runInterferenceStates, resolveLiftAxis } from '../../src/machine/interference-states.ts';
import { declaredJoints } from '../../src/machine/joints.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';

const part = (id, center, size, extra = {}) => ({
  id,
  name: id,
  role: 'structure',
  shape: { type: 'box', size },
  center,
  rotationZDeg: 0,
  ...extra
});

const cylinder = (id, center, radius, length, extra = {}) => ({
  id,
  name: id,
  role: 'actuator',
  shape: { type: 'cylinder', radius, length, axis: 'z' },
  center,
  rotationZDeg: 0,
  ...extra
});

test('解析式确认：同轴圆柱的精确交集体积 < AABB 外接体积', () => {
  const body = cylinder('b-body', [0, 0, 0], 20, 130, { actuatorId: 'lift' });
  const rod = cylinder('b-rod', [0, 0, 20], 6, 95, { actuatorId: 'lift' });
  const screen = screenInterference({ parts: [body, rod] });
  const pair = screen.pairs[0];
  assert.ok(pair, '两根同轴圆柱必然被 AABB 筛出来');
  assert.equal(pair.confirmation, 'exact');
  // AABB 是 12×12×dz（外接盒），精确值是 π·6²·dz
  assert.ok(pair.exactOverlapMm3 < pair.overlapMm3, `exact=${pair.exactOverlapMm3} aabb=${pair.overlapMm3}`);
  const dz = 92.5; // 缸体 Z -65..65、杆 -27.5..67.5 → 重叠 92.5
  assert.ok(Math.abs(pair.exactOverlapMm3 - Math.PI * 36 * dz) < 0.5, `exact=${pair.exactOverlapMm3}`);
  // 同一执行机构的同轴嵌套 → mate，不算 suspect
  assert.equal(pair.classification, 'mate');
  assert.equal(pair.kind, 'suspect', '旧口径 kind 保持 suspect（layout/resolve 依赖它）');
  assert.match(pair.note ?? '', /同轴嵌套配合/);
  assert.equal(screen.suspects, 1, '旧口径 suspects 仍算非声明对');
  assert.equal(screen.confirmed, 0);
  assert.equal(screen.screen, 0);
  assert.equal(screen.mates, 1);
});

test('mate 只在同一执行机构内成立：跨执行机构同轴圆柱仍是 suspect', () => {
  const a = cylinder('a-body', [0, 0, 0], 20, 130, { actuatorId: 'lift-a' });
  const b = cylinder('b-rod', [0, 0, 20], 6, 95, { actuatorId: 'lift-b' });
  assert.equal(mateReason(a, b), null);
  const screen = screenInterference({ parts: [a, b] });
  assert.equal(screen.pairs[0].classification, 'suspect');
  assert.equal(screen.confirmed, 1, '同轴圆柱能解析求交，属确认重叠');
});

test('确认重叠（非配合）→ fail；只有 AABB 依据 → warn；干净 → pass', () => {
  const collision = runInterferenceStates({
    states: ['rest'],
    config: {},
    geometry: { parts: [part('a', [0, 0, 0], [100, 100, 100]), part('b', [50, 0, 0], [100, 100, 100])] }
  });
  assert.equal(collision.ok, true);
  assert.equal(collision.states.rest.confirmedHits, 1);
  assert.equal(collision.states.rest.screenHits, 0);
  assert.equal(collision.states.rest.reviewStatus, 'fail');
  assert.equal(collision.reviewStatus, 'fail');

  // 绕 Z 转 45° 的长条：AABB 放大，解析式算不了 → screen hit，只能 warn
  const screened = runInterferenceStates({
    states: ['rest'],
    config: {},
    geometry: {
      parts: [
        part('a', [0, 0, 0], [100, 100, 100]),
        part('b', [0, 0, 0], [200, 10, 10], { rotationZDeg: 45 })
      ]
    }
  });
  assert.equal(screened.ok, true);
  assert.equal(screened.states.rest.confirmedHits, 0, '旋转件只能给包围盒依据');
  assert.equal(screened.states.rest.screenHits, 1);
  assert.equal(screened.states.rest.reviewStatus, 'warn');
  assert.equal(screened.states.rest.items[0].confirmation, 'aabb');
  assert.match(screened.states.rest.items[0].note ?? '', /包围盒/);

  // 真干净：仍然必须是 0（不许抹平）
  const clean = runInterferenceStates({
    states: ['rest'],
    config: {},
    geometry: { parts: [part('a', [0, 0, 0], [100, 100, 100]), part('b', [500, 0, 0], [100, 100, 100])] }
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.states.rest.pairs, 0);
  assert.equal(clean.states.rest.hits, 0);
  assert.equal(clean.states.rest.screenHits, 0);
  assert.equal(clean.states.rest.confirmedHits, 0);
  assert.equal(clean.reviewStatus, 'pass');
});

test('光伏板转向输送机（装配 85 件 / 几何 87 刚体）', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const payload = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: design.config });
  assert.equal(payload.ok, true);

  // 统一几何源：输送类走 conveyor-assembly 的 85 件整机，不再算 48 件代理体。
  // 这一点是本次结构性问题（评审判 FAIL / B-Rep 判 PASS）的根，别退回去。
  assert.equal(payload.geometrySource, 'conveyor-assembly');
  // 85 件整机装配 + 2 根活塞杆：缸体与活塞杆是两个刚体（顶升时只动杆），几何件数 87，
  // 装配件数（BOM/STEP 口径）仍是 85。
  assert.equal(payload.assemblyPartCount, 85);
  assert.equal(payload.partCount, 87);
  assert.equal(payload.precision.geometry, 'conveyor-assembly');
  assert.equal(payload.precision.confirm, 'analytic-primitive');
  assert.ok(payload.precision.aabbOnly.length >= 1);
  assert.match(payload.note, /mate/);

  // rest：52 对重叠全部是装配连接（横撑插纵梁、地脚旋入支腿、皮带绕包滚筒、导柱穿台板过孔…），
  // 由 joints 显式声明并带中文原因；没有一对升级成 suspect。
  const rest = payload.states.rest;
  assert.equal(rest.confirmedHits, 0, '参数化整机不得有确认干涉');
  assert.equal(rest.screenHits, 0);
  assert.equal(rest.hits, 0);
  assert.equal(rest.pairs, 54, '52 对装配连接 + 2 对缸体×活塞杆配合面');
  assert.equal(rest.mm3Declared, 1209046.4, '声明放行的重叠体积（AABB 上界）要如实报出来');
  // 缸体×活塞杆是配合面：出现在 items 里给人看，但判 mate、不算 hits。
  assert.equal(rest.mates, 2, '两台顶升气缸的缸体×活塞杆都是配合面');
  assert.equal(rest.items.length, 2);
  for (const item of rest.items) {
    assert.equal(item.kind, 'mate');
    assert.match(`${item.a} ${item.b}`, /turner-lift-cyl-\d+(-rod)?/);
  }
  for (const state of Object.values(payload.states)) {
    for (const item of state.items) {
      if (!/turner-lift-cyl/.test(`${item.a} ${item.b}`)) continue;
      assert.equal(item.kind, 'mate', `气缸件只允许以配合面出现：${item.a} × ${item.b} 判成了 ${item.kind}`);
    }
  }

  // lift/sweep：位姿与几何建模的伸出方向同向（+Z），三态都 valid
  assert.equal(payload.lift.directionOverridden, false, '不再靠 config 反向覆盖');
  assert.deepEqual(payload.lift.geometryDirection, [0, 0, 1]);
  assert.deepEqual(payload.lift.direction, [0, 0, 1]);
  assert.equal(payload.lift.strokeMm, 60, '行程仍取 config 的 turner-lift.travelMm');
  // 顶升随动件：台板 / 回转支承 / 转台盘 / 9 只支撑指 + 2 根活塞杆
  assert.equal(payload.lift.partIds.length, 14);
  for (const name of ['rest', 'lift', 'sweep']) {
    const state = payload.states[name];
    assert.equal(state.confirmedHits, 0, `${name} 不得判确认干涉`);
    assert.equal(state.screenHits, 0, `${name} 不得有待复核项`);
    assert.equal(state.poseValidity, 'valid', `${name} 位姿必须可信`);
  }
  // 真实数字（本机实测）：rest 54 对 / 1264432 mm³（含 declared + 2 对配合面），
  // lift 到位时活塞杆脱出缸孔 → 52 对 / 1214032 mm³，sweep 按步累计 8595424 mm³
  assert.equal(payload.states.rest.mm3, 1264432);
  assert.equal(payload.states.lift.mm3, 1214032);
  assert.ok(payload.states.lift.pairs < payload.states.rest.pairs, 'lift 必须与 rest 不同（活塞杆脱出缸孔）');
  assert.equal(payload.states.sweep.mm3, 8595424);
  assert.equal(payload.states.sweep.steps.length, 7, '0..60 mm 按 10 mm 共 7 步');
  assert.equal(payload.reviewStatus, 'pass', '三态 confirmed/screen 全 0 命中时才允许 pass');
  assert.deepEqual(
    ['rest', 'lift', 'sweep'].map((name) => {
      const state = payload.states[name];
      return [state.confirmedHits, state.screenHits];
    }),
    [[0, 0], [0, 0], [0, 0]]
  );
});

test('工位生成器（非输送类/回落路径）仍把缸体×活塞杆判成 mate，不因统一而退化', () => {
  // 直接打生成器：PV 的 config 现在走参数化整机，但非输送类形态与「输送类缺参数回落」
  // 依然产出这对同轴圆柱，mateReason 的口径必须还在。
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const geometry = generateMachineGeometry(design.config);
  assert.equal(geometry.parts.length, 48, '生成器代理体仍是 48 件');
  const screen = screenInterference(geometry);
  assert.equal(screen.suspects, 1, 'rest 只有缸体×活塞杆这一对非声明重叠');
  assert.equal(screen.confirmed, 0, '配合面不得算确认干涉');
  assert.equal(screen.screen, 0);
  assert.equal(screen.mates, 1);
  const pair = screen.pairs[0];
  assert.equal(pair.classification, 'mate');
  assert.equal(pair.confirmation, 'exact');
  // 精确值 = π·6²·60 = 6785.8 mm³：缩回位杆露出 25 mm，插在缸孔里的长度正好是行程 60
  assert.ok(Math.abs((pair.exactOverlapMm3 ?? 0) - 6785.8) < 0.5, `exact=${pair.exactOverlapMm3}`);
  assert.ok(pair.overlapMm3 > (pair.exactOverlapMm3 ?? 0));
  assert.equal((pair.exactOverlapMm3 ?? 0) < Math.PI * 36 * (60 + 25), true, '杆不是整根被推进缸体');
});

test('转向工位几何：建的是顶升台板 + 导柱，不是「缸体朝下 + 压头 + 治具」的压机', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const geometry = generateMachineGeometry(design.config);
  const byId = (id) => geometry.parts.find((part) => part.id === id);

  // 顶升台该有的零件（修复前没有导柱和安装板，只有压机件）
  const mount = byId('turner-lift-mount');
  const body = byId('turner-lift-body');
  const rod = byId('turner-lift-rod');
  const plate = byId('turner-lift-tool');
  const guides = geometry.parts.filter((part) => /^turner-lift-guide-[lr]$/.test(part.id));
  assert.ok(mount && body && rod && plate, '缺顶升台零件');
  assert.equal(guides.length, 2, '顶升台必须有左右两根导柱');
  // 压机独有的治具（-nest）不许再出现
  assert.equal(byId('turner-lift-nest'), undefined, '顶升工位不该有压机治具');

  // 轴线方向：缸体在下、杆向上、台板在杆顶 → 伸出方向 +Z，与 config.position 同向
  assert.equal(body.center[2] < rod.center[2], true, '缸体必须在活塞杆下方');
  assert.equal(rod.center[2] < plate.center[2], true, '台板必须在活塞杆上方');
  const axis = geometry.moving.find((item) => item.actuatorId === 'turner-lift');
  assert.ok(axis);
  assert.deepEqual(axis.axis, [0, 0, 1], '几何伸出方向必须是 +Z（向上顶升）');
  assert.equal(axis.strokeMm, 60);
  assert.equal(rod.moving, true);
  assert.equal(plate.moving, true, '台板随顶升轴一起动');
  // 导柱画到台板底面为止：不在台板上制造「圆柱穿方板」的假互穿
  for (const guide of guides) {
    const guideTop = guide.center[2] + guide.shape.length / 2;
    const plateBottom = plate.center[2] - plate.shape.size[2] / 2;
    assert.ok(Math.abs(guideTop - plateBottom) < 1e-6, `${guide.id} 顶面 ${guideTop} 应贴台板底面 ${plateBottom}`);
    assert.equal(guide.moving, undefined, '导柱是固定件');
  }
});

test('resolveLiftAxis：几何伸出方向与 config 同向，不再触发「反向覆盖」', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const geometry = generateMachineGeometry(design.config);
  const axis = resolveLiftAxis(design.config, geometry);
  assert.ok(axis);
  assert.equal(axis.directionOverridden, false);
  assert.deepEqual(axis.geometryDirection, [0, 0, 1]);
  assert.deepEqual(axis.direction, [0, 0, 1]);
  assert.deepEqual(axis.partIds.sort(), ['turner-lift-rod', 'turner-lift-tool']);
});

test('反向覆盖的判定仍在：几何朝下、config 朝上时 directionOverridden=true（口径没被削掉）', () => {
  // 手工造一个「压机朝下」的轴，确认 resolveLiftAxis 仍能识别反向（不是把告警删掉了）
  const config = {
    actuators: [{ id: 'turner-lift', kind: 'cylinder', travelMm: 60, position: [0, 0, 1] }]
  };
  const geometry = {
    parts: [],
    moving: [{ actuatorId: 'turner-lift', axis: [0, 0, -1], strokeMm: 60, partIds: ['a-rod'] }]
  };
  const axis = resolveLiftAxis(config, geometry);
  assert.ok(axis);
  assert.equal(axis.directionOverridden, true);
  assert.deepEqual(axis.geometryDirection, [0, 0, -1]);
  assert.deepEqual(axis.direction, [0, 0, 1]);
});

test('sweep 的 items 按零件对去重（同一对在多个高度重叠只报一次）', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const payload = runInterferenceStates({ states: ['sweep'], config: design.config });
  assert.equal(payload.ok, true);
  const keys = payload.states.sweep.items.map((item) => `${item.a}|${item.b}`);
  assert.equal(new Set(keys).size, keys.length, `items 有重复：${keys.join(',')}`);
  assert.ok(payload.states.sweep.steps.length >= 7, '0..60 mm 按 10 mm 应至少 7 步');
  assert.equal(payload.states.sweep.hits, 0);
});

// ── 缺陷 B：传感器支架互穿（修复前 3 对 9100 + 7700 + 700 = 17500 mm³，被 joints 规则放行）──

test('传感器支架按支架真实宽度排开：支架×支架重叠归零', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const geometry = generateMachineGeometry(design.config);
  const brackets = geometry.parts.filter((part) => /^sensor-.+-bracket$/.test(part.id));
  assert.ok(brackets.length >= 6, `支架只有 ${brackets.length} 个，PV 机应有 6 个普通传感器支架`);

  // 同一排（同 y、同 z）的支架中心距必须 ≥ 支架宽度（30 mm）——修复前是 17/19/29 mm
  let sameRowPairs = 0;
  for (let i = 0; i < brackets.length; i += 1) {
    for (let j = i + 1; j < brackets.length; j += 1) {
      const a = brackets[i];
      const b = brackets[j];
      if (Math.abs(a.center[1] - b.center[1]) > 1e-6 || Math.abs(a.center[2] - b.center[2]) > 1e-6) continue;
      sameRowPairs += 1;
      const width = a.shape.size[0];
      const gap = Math.abs(a.center[0] - b.center[0]);
      assert.ok(gap >= width, `${a.id} 与 ${b.id} 中心距 ${gap} < 支架宽 ${width}`);
      assert.ok(gap > width, `${a.id} 与 ${b.id} 只有贴边、没有净空（${gap}）`);
    }
  }
  assert.ok(sameRowPairs >= 3, '这台机至少有 3 对同排支架，才能覆盖修复前的互插场景');

  const screen = screenInterference(geometry);
  const bracketPairs = screen.pairs.filter((pair) => /-bracket$/.test(String(pair.a)) && /-bracket$/.test(String(pair.b)));
  assert.equal(bracketPairs.length, 0, `仍有支架互插：${bracketPairs.map((p) => `${p.a}x${p.b}`).join(',')}`);
  assert.equal(screen.declaredMm3, 0, '不得再有「已声明」放行的实体互穿（修复前 17500 mm³）');
  const rest = runInterferenceStates({ states: ['rest'], config: design.config });
  assert.equal(rest.states.rest.mm3Confirmed, 0);
  assert.equal(rest.states.rest.mm3Screen, 0);
  assert.equal(rest.states.rest.reviewStatus, 'pass');
});

test('joints：支架只与传感器本体成对，支架×支架不再被当成「传感器接支架」', () => {
  const joints = declaredJoints([
    { id: 'sensor-st1-a-bracket' },
    { id: 'sensor-st1-b-bracket' },
    { id: 'sensor-st1-a' },
    { id: 'sensor-st1-b' }
  ]);
  const keys = joints.map((joint) => `${joint.a}|${joint.b}`);
  assert.equal(keys.includes('sensor-st1-a-bracket|sensor-st1-b-bracket'), false, '支架×支架不是连接');
  // 排序键：'sensor-st1-a' < 'sensor-st1-a-bracket'
  assert.ok(keys.includes('sensor-st1-a|sensor-st1-a-bracket'), `缺支架×本体：${keys.join(',')}`);
  assert.ok(keys.includes('sensor-st1-b|sensor-st1-b-bracket'), `缺支架×本体：${keys.join(',')}`);
  assert.equal(joints.length, 2, `只应有 2 对「支架×本体」：${keys.join(',')}`);
});

test('支架真互穿时必须报 suspect，不能靠 joints 规则放行', () => {
  const geometry = {
    parts: [
      part('sensor-a-bracket', [0, 0, 0], [30, 10, 70]),
      part('sensor-b-bracket', [20, 0, 0], [30, 10, 70]),
      part('sensor-a', [0, 40, 0], [18, 32, 40]),
      part('sensor-b', [30, 40, 0], [18, 32, 40])
    ]
  };
  const screen = screenInterference(geometry);
  const pair = screen.pairs.find(
    (item) => item.a === 'sensor-a-bracket' && item.b === 'sensor-b-bracket'
  );
  assert.ok(pair, '互插的两只支架必须被筛出来');
  assert.equal(pair.classification, 'suspect', '支架互插不是已声明连接');
  assert.equal(pair.confirmation, 'exact');
  assert.equal(pair.exactOverlapMm3, 10 * 10 * 70, '精确交集体积 = 10×10×70 = 7000 mm³');
  const rest = runInterferenceStates({ states: ['rest'], config: {}, geometry });
  assert.equal(rest.states.rest.confirmedHits, 1);
  assert.equal(rest.states.rest.reviewStatus, 'fail', '真互穿必须判 fail');
});
