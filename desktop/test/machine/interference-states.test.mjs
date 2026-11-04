// 状态化干涉检查的判定口径守卫（本次故障的直接回归）：
// 1) 同轴嵌套的执行机构零件（缸体×活塞杆）不得被当成设计干涉；
// 2) screen hit（只有 AABB 依据 / 位姿不可达）不得判 fail，只有解析式确认的实体重叠才 fail；
// 3) 真干净时仍然必须是 0（不许为了消警把数字抹平）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenInterference, exactOverlapMm3, mateReason } from '../../src/machine/interference.ts';
import { runInterferenceStates, resolveLiftAxis } from '../../src/machine/interference-states.ts';
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

test('光伏板转向输送机：评审不再判 FAIL，但把「为什么不是干涉」写进结果', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const payload = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: design.config });
  assert.equal(payload.ok, true);

  // rest：唯一的重叠对是缸体×活塞杆（配合面），不是设计干涉
  const rest = payload.states.rest;
  assert.equal(rest.confirmedHits, 0, '配合面不得算确认干涉');
  assert.equal(rest.screenHits, 0);
  assert.equal(rest.mates, 1);
  const mate = rest.items.find((item) => item.a === 'turner-lift-body' && item.b === 'turner-lift-rod');
  assert.ok(mate, '缸体×活塞杆要出现在 items 里（不能静默丢掉）');
  assert.equal(mate.kind, 'mate');
  assert.equal(mate.confirmation, 'exact');
  // 精确值 = π·6²·70 = 7916.8 mm³（OCCT 布尔复核同值），AABB 上界是 10080
  assert.ok(Math.abs(mate.exactOverlapMm3 - 7916.8) < 0.5, `exact=${mate.exactOverlapMm3}`);
  assert.ok(mate.overlapMm3 > mate.exactOverlapMm3);

  // lift/sweep：位移方向与几何建模的伸出方向相反，位姿不可达 → 只能 warn
  assert.equal(payload.lift.directionOverridden, true);
  assert.deepEqual(payload.lift.geometryDirection, [0, 0, -1]);
  assert.deepEqual(payload.lift.direction, [0, 0, 1]);
  for (const name of ['lift', 'sweep']) {
    const state = payload.states[name];
    assert.equal(state.confirmedHits, 0, `${name} 不得判确认干涉`);
    assert.equal(state.poseValidity, 'direction-overridden');
    assert.equal(state.reviewStatus, 'warn');
  }
  assert.equal(payload.reviewStatus, 'warn', '整机不能判 fail');

  // 精度与适用范围必须随结果返回（否则下游会把 screen hit 当确认）
  assert.equal(payload.precision.geometry, 'config-generator');
  assert.equal(payload.precision.confirm, 'analytic-primitive');
  assert.ok(payload.precision.aabbOnly.length >= 1);
  assert.match(payload.note, /mate/);
});

test('resolveLiftAxis 记录「方向被 config 覆盖」，不再静默翻向', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const geometry = generateMachineGeometry(design.config);
  const axis = resolveLiftAxis(design.config, geometry);
  assert.ok(axis);
  assert.equal(axis.directionOverridden, true);
  assert.deepEqual(axis.geometryDirection, [0, 0, -1]);
  assert.deepEqual(axis.direction, [0, 0, 1]);
  assert.deepEqual(axis.partIds.sort(), ['turner-lift-rod', 'turner-lift-tool']);
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
