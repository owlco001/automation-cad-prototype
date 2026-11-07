// 工件（板 1200×800×35）纳入移载机几何 + 四态干涉的产品级验收。
//
// 背景：移载机的干涉检查曾经只比机构件之间的碰撞（上一版是推板/滑座/辊道/挡边），
// 「板能不能从出料口送出去」这件事在产品里根本看不见 —— 只能靠单测手工注入一个盒子，
// 上一轮的「板角扫切挡边 2520 mm³」就是这么发现的。注入只能证明「测试会算」，
// 证明不了「产品会查」。这一组用例全部走**产品几何**：
//   config → resolveMachineGeometry（含工件占位体）→ runInterferenceStates（四态）。
//
// 口径（本文件反复断言的那三句）：
//   1) 工件是普通件：参与全部碰撞对（含 sweep 逐步、push 逐点），不写专用判定；
//   2) 工件不进 BOM/成本/装配件数：parts/BOM 不变，只有几何刚体数 +1；
//   3) 位姿由两条移载轴给出：rest 贴 X 带面 850、lift 到 Y 带面 915（轴 90 − 拾取空行程 25）、
//      push 再沿 +Y 走 1180 落到接料段（带面同为 915）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TRANSFER_DEFAULT_PART_THICKNESS_MM,
  buildConveyorParts,
  conveyorBom,
  transferLayout,
  transferSkipReason
} from '../../src/machine/conveyor-assembly.ts';
import { WORKPIECE_PART_ID, resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { geometryComponentCounts } from '../../src/machine/geometry.ts';
import { poseForState, runInterferenceStates } from '../../src/machine/interference-states.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

/** 主线：3000 × 1200（这一版移载线的默认线长），带面 850，板 1200×800 */
const LINE = {
  lengthMm: 3000,
  widthMm: 1200,
  beltHeightMm: 850,
  pulleyDiameterMm: 50,
  beltThicknessMm: 4,
  frameSectionMm: 40,
  layers: 1,
  transferPresent: true,
  transferPartLengthMm: 1200,
  transferPartWidthMm: 800
};
const BELT_FACE = LINE.beltHeightMm; // 850
const GUARD_TOP = BELT_FACE + 1 + 60; // 911：+Y 挡边顶，板底必须高过它
const PLATE_BOTTOM_LIFT = 915; // Y 带面顶升到位 = 挡边顶 + 4
const layout = transferLayout(LINE);

/** 移载机型 config（两条轴与 synth.ts 同口径；conveyor 里带板参数） */
function transferConfig({ part = {}, conveyor = {}, liftStroke = layout.strokeMm } = {}) {
  return {
    id: 'transfer-workpiece',
    name: '顶升移载输送机',
    stations: ['工位1', '移载工位'],
    actuators: [
      {
        id: 'transfer-lift', name: '移载工位顶升台', kind: 'cylinder', station: '移载工位',
        travelMm: liftStroke, durationMs: 2600, position: [0, 0, 0.05], point: 'ST-TRANSFER-LIFT'
      },
      {
        id: 'transfer-push', name: '移载工位移载台', kind: 'cylinder', station: '移载工位',
        travelMm: layout.pushStrokeMm, durationMs: 4300, position: [0, 0.05, 0], point: 'ST-TRANSFER-PUSH'
      }
    ],
    sensors: [],
    formId: 'belt-line',
    conveyor: {
      lengthMm: LINE.lengthMm,
      widthMm: LINE.widthMm,
      transferPresent: true,
      transferPartLengthMm: LINE.transferPartLengthMm,
      transferPartWidthMm: LINE.transferPartWidthMm,
      ...part,
      ...conveyor
    }
  };
}

const workpieceOf = (geometry) => geometry.parts.find((part) => part.role === 'workpiece');
const byId = (geometry, id) => geometry.parts.find((part) => part.id === id);

/** 去掉工件（连同两轴的随动登记）：用来对照「旧口径」是不是真的看不见板 */
function withoutWorkpiece(geometry) {
  return {
    ...geometry,
    parts: geometry.parts.filter((part) => part.role !== 'workpiece'),
    moving: geometry.moving.map((axis) => ({
      ...axis,
      partIds: axis.partIds.filter((id) => id !== WORKPIECE_PART_ID),
      ...(axis.partPickupGapMm ? { partPickupGapMm: {} } : {})
    }))
  };
}

/** 把 +Y 侧挡边两段朝内挪 delta（模拟「出料口开窄了」） */
function narrowOutfeed(geometry, delta) {
  return {
    ...geometry,
    parts: geometry.parts.map((part) => (part.id === 'guard-right-in' || part.id === 'guard-right-out'
      ? { ...part, center: [part.center[0] + (part.center[0] < 0 ? delta : -delta), part.center[1], part.center[2]] }
      : part))
  };
}

/** 把指定零件沿 Z 平移（负向对照用） */
function shiftZ(geometry, ids, delta) {
  return {
    ...geometry,
    parts: geometry.parts.map((part) => (ids.includes(part.id)
      ? { ...part, center: [part.center[0], part.center[1], part.center[2] + delta] }
      : part))
  };
}

test('几何：移载机型建出工件占位体（1200×800×35，底面贴带面 850），非移载机型不建', () => {
  const resolved = resolveMachineGeometry(transferConfig());
  const plate = workpieceOf(resolved.geometry);
  assert.ok(plate, '移载机型的几何里必须有工件占位体');
  assert.equal(plate.id, WORKPIECE_PART_ID);
  assert.deepEqual(plate.shape, { type: 'box', size: [1200, 800, 35] });
  assert.equal(plate.center[2] - 17.5, BELT_FACE, 'rest 位板底 = X 带面 850（板压在带上，不悬空也不埋进带里）');
  assert.equal(plate.center[0], 0, '板在主线中心线上');
  assert.equal(plate.center[1], 0, '板静止在中段，起点 y = 0');
  assert.equal(TRANSFER_DEFAULT_PART_THICKNESS_MM, 35, '缺省板厚必须是 35（与真机一致）');
  // 静止位 Y 带面比带面低 25：板与 Y 带之间确实有 25 mm 净空
  assert.equal(BELT_FACE - layout.yBeltFaceRestZ, 25, '静止位 Y 带面 825，板底 850 → 25 mm 净空');

  // 不要移载就没有工件：转向机型、普通线都不该凭空长出一块料
  const plain = resolveMachineGeometry({
    ...transferConfig(),
    conveyor: { lengthMm: 3000, widthMm: 1200, transferPresent: false, transferPartLengthMm: 0, transferPartWidthMm: 0 }
  });
  assert.equal(workpieceOf(plain.geometry), undefined, '普通输送线不该有工件占位体');
  const both = buildConveyorParts({
    ...LINE, transferPresent: false, transferPartLengthMm: 0, transferPartWidthMm: 0
  });
  assert.equal(both.some((part) => part.id === WORKPIECE_PART_ID), false, '工件不属于 ConveyorPart 零件表');
});

test('位姿表：rest 底 850 / lift 底 915 / push +Y 1180，位移由两条移载轴给出', () => {
  const config = transferConfig();
  const resolved = resolveMachineGeometry(config);
  const geometry = resolved.geometry;
  const liftAxis = geometry.moving.find((axis) => axis.actuatorId === 'transfer-lift');
  const pushAxis = geometry.moving.find((axis) => axis.actuatorId === 'transfer-push');
  assert.ok(liftAxis && pushAxis);
  assert.ok(liftAxis.partIds.includes(WORKPIECE_PART_ID), '顶升轴必须带工件（否则 lift 位姿板不动）');
  assert.ok(pushAxis.partIds.includes(WORKPIECE_PART_ID), '移载轴必须带工件（否则 push 位姿板不动）');

  const result = runInterferenceStates({ states: ['rest', 'lift', 'push'], config });
  assert.equal(result.ok, true);
  assert.deepEqual(result.workpiece.sizeMm, [1200, 800, 35]);
  assert.equal(result.workpiece.bottomZ.rest, BELT_FACE, 'rest 板底 = 850');
  assert.equal(result.workpiece.bottomZ.lift, PLATE_BOTTOM_LIFT, 'lift 板底 = 915（= 顶升后的 Y 带面，不是 920）');
  assert.equal(result.workpiece.pushTravelMm, 1180, 'push 沿 +Y 走满行程 1180');

  // 逐态从几何读出来复核（不信 payload 的自述）
  const lift = result.lift;
  const push = result.push;
  const restPlate = byId(geometry, WORKPIECE_PART_ID);
  const liftedPlate = byId(poseForState({ geometry, state: 'lift', lift, push }), WORKPIECE_PART_ID);
  const pushedPlate = byId(poseForState({ geometry, state: 'push', lift, push }), WORKPIECE_PART_ID);
  assert.equal(liftedPlate.center[2] - restPlate.center[2], 65, '板升 65 = 轴 90 − 拾取空行程 25');
  assert.equal(pushedPlate.center[1] - liftedPlate.center[1], 1180, 'push 只沿 +Y 走 1180，Z 不变');
  assert.equal(pushedPlate.center[2], liftedPlate.center[2]);
  assert.equal(liftAxis.partPickupGapMm?.[WORKPIECE_PART_ID], 25,
    '拾取空行程 25 必须显式记在轴上：Y 带面静止位 825 比带面低 25，板要等带面贴上来才动');
  // 送出终点：板心落在接料段中心附近，板整块在接料段上
  assert.ok(pushedPlate.center[1] > layout.dockStartY, 'push 终点板心必须在接料段起点之外');
  assert.ok(pushedPlate.center[1] + LINE.transferPartWidthMm / 2 <= layout.dockStartY + layout.dockLengthMm,
    '板的整块（含板尾）必须落在接料段带面范围内');
});

test('四态闸门：rest / lift / sweep / push 全部 confirmed=0 且待复核=0，且每态都有「板在场」证据', () => {
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config: transferConfig() });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.reviewStatus, 'pass');
  assert.equal(result.workpiece.partId, WORKPIECE_PART_ID);
  for (const name of ['rest', 'lift', 'sweep', 'push']) {
    const entry = result.states[name];
    assert.ok(entry, `缺 ${name} 态`);
    assert.equal(entry.confirmedHits, 0, `${name} 态确认干涉：${JSON.stringify(entry.items.slice(0, 4))}`);
    assert.equal(entry.screenHits, 0, `${name} 态待复核：${JSON.stringify(entry.items.slice(0, 4))}`);
    assert.equal(entry.mm3Confirmed, 0);
    assert.equal(entry.reviewStatus, 'pass');
    // confirmed=0 只有在「板真的查了」时才有意义：板压在带上是贴面，计入 workpieceTouching
    assert.ok((entry.workpieceTouching ?? 0) > 0,
      `${name} 态一件东西都没碰到板：可能根本没把板放进位姿（workpieceTouching=${entry.workpieceTouching}）`);
  }
  // 贴面对数：rest 3 条 X 带（板宽 800 只压在 3 条带上）；lift 坐到 4 段 Y 短带上（+ 托它的其它件）
  assert.equal(result.states.rest.workpieceTouching, 3, 'rest 时应压在 3 条 X 窄带上');
  assert.ok(result.states.lift.workpieceTouching > result.states.rest.workpieceTouching,
    `lift 时板要落到 4 段 Y 带上（贴面对数应增加，实际 ${result.states.lift.workpieceTouching}）`);
});

test('扫掠口径：sweep 每步都带板（0→90 共 10 步），push 逐点扫过 1180 且只回紧凑数字', () => {
  const result = runInterferenceStates({ states: ['sweep', 'push'], config: transferConfig() });
  const sweep = result.states.sweep;
  assert.equal(sweep.steps.length, 10, '90 / 10 = 9 步 + 起点 = 10 步');
  assert.equal(sweep.steps.at(-1).z, 90, 'sweep 必须扫到行程末端 90');
  const rising = sweep.steps.filter((step) => step.z > 25);
  assert.equal(rising.length, 7, 'z>25 的 7 步是板被 Y 带托起之后的行程（30..90）');
  for (const step of rising) {
    assert.ok((step.workpieceTouching ?? 0) > 0, `z=${step.z} 时板没跟着抬（workpieceTouching=0）`);
  }
  const push = result.states.push;
  assert.ok(push.samples >= 100, `push 只查了 ${push.samples} 点，端点采样不算扫掠`);
  assert.equal(push.samples, Math.round(layout.pushStrokeMm / 10) + 1, '每 10 mm 一点，含起点');
  assert.equal(push.hitSamples, 0, '全程 0 命中：板真的送得出去');
  assert.equal(push.hitRange, null);
  assert.equal(push.worst, null);
  assert.ok((push.workpieceTouchingSamples ?? 0) > 0, 'push 全程有板贴着 Y 带/接料段带，说明板在动');
  // 逐点明细不回给模型：四态结果必须能塞进 10 KB 的工具结果上限，否则会被裁成 preview
  assert.equal('steps' in push, false, 'push 不回逐步数组（会顶爆工具结果上限），只回 samples/hitSamples/hitRange/worst');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10 * 1024,
    `四态结果 ${Buffer.byteLength(JSON.stringify(result))} 字节，超过工具结果上限会被裁剪`);
});

test('尺寸变更：板长/板宽/板厚从参数进几何（1000×700×50），四态仍 0', () => {
  const config = transferConfig({ part: { transferPartLengthMm: 1000, transferPartWidthMm: 700, transferPartThicknessMm: 50 } });
  assert.equal(transferSkipReason({
    ...LINE, transferPartLengthMm: 1000, transferPartWidthMm: 700, transferPartThicknessMm: 50
  }), null, '1000×700×50 应可建');
  const geometry = resolveMachineGeometry(config).geometry;
  const plate = workpieceOf(geometry);
  assert.deepEqual(plate.shape, { type: 'box', size: [1000, 700, 50] }, '几何尺寸必须跟着参数走');
  assert.equal(plate.center[2] - 25, BELT_FACE, '底面仍在带面上（厚 50 只是顶面上移）');
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config });
  assert.deepEqual(result.workpiece.sizeMm, [1000, 700, 50]);
  for (const name of ['rest', 'lift', 'sweep', 'push']) {
    assert.equal(result.states[name].confirmedHits, 0, `${name} 态：${JSON.stringify(result.states[name].items.slice(0, 3))}`);
    assert.equal(result.states[name].screenHits, 0, `${name} 态：${JSON.stringify(result.states[name].items.slice(0, 3))}`);
  }
});

test('负向对照①：顶升少 30 mm（板底 885）→ 板撞进接料段皮带，push 扫掠报 3840000 mm³', () => {
  const result = runInterferenceStates({
    states: ['lift', 'push'],
    config: transferConfig({ liftStroke: 60 })
  });
  assert.equal(result.ok, true);
  assert.equal(result.workpiece.bottomZ.lift, 885, '行程 60 时板底只能到 885（接料段带面 915，差 30 mm）');
  assert.equal(result.states.lift.confirmedHits, 0, 'lift 位板还没走到接料段上方（y 向没到）');
  const push = result.states.push;
  assert.ok(push.worst, 'push 扫掠必须报出来：板低 30 mm 时会被接料段皮带整块切开');
  assert.equal(push.worst.mm3Confirmed, 3840000,
    `板 1200×800 整块压在接料段皮带 4 mm 厚上 = 3840000 mm³，实际 ${push.worst.mm3Confirmed}`);
  assert.ok(push.hitSamples > 0 && push.hitRange, '命中位姿要给出范围（板一进接料段就撞）');
  assert.equal(push.hitRange[1], 1180, '一直撞到行程末端');
  const pairs = push.items.filter((item) => item.kind === 'suspect');
  assert.ok(pairs.length >= 2, JSON.stringify(push.items.slice(0, 4)));
  // 命中要落在接料段上（皮带整块切开 + 滚筒），并逐对给出 partId
  assert.ok(pairs.some((item) => /dock-(belt|pulley)/.test(`${item.a}${item.b}`)),
    `命中应落在接料段皮带/滚筒上：${JSON.stringify(pairs.map((item) => `${item.a}×${item.b}`))}`);
  assert.ok(pairs.every((item) => /workpiece-plate/.test(`${item.a}${item.b}`)), '每一对的另一侧都必须是工件');
  // 出料口挡边不在这条对照里：板顶升到位（915）是从挡边顶（911）上方 4 mm 过去的，
  // 挡边开口的宽度因此不再参与碰撞判定 —— 开口仍按板长 + 40 生成（见 transfer-unit ⑤）。
});

test('负向对照②：板下沉 40 mm 压进升降架，逐对 partId + mm³ 可读', () => {
  const geometry = resolveMachineGeometry(transferConfig()).geometry;
  const dropped = shiftZ(geometry, [WORKPIECE_PART_ID], -40);
  const result = runInterferenceStates({ states: ['lift'], config: transferConfig(), geometry: dropped });
  const lift = result.states.lift;
  assert.equal(result.workpiece.bottomZ.lift, 875, '把板沉 40 → lift 位板底 875（低于 Y 带面 915）');
  assert.ok(lift.confirmedHits > 0, '板沉进升降架必须被报出来');
  assert.ok(lift.mm3Confirmed > 1000, `实体重叠应 >1000 mm³，实际 ${lift.mm3Confirmed}`);
  assert.ok(lift.items.some((item) => /transfer-lift-riser|transfer-y-base|transfer-y-belt/.test(`${item.a}${item.b}`)),
    `命中应落在升降架/Y 短带上：${JSON.stringify(lift.items.slice(0, 3))}`);
  assert.ok(lift.items.some((item) => /workpiece-plate/.test(`${item.a}${item.b}`)), '命中必须是工件那一对');
});

test('去掉工件即回到旧口径：pairs 不变、workpiece=null、负向对照归零', () => {
  const config = transferConfig();
  const geometry = resolveMachineGeometry(config).geometry;
  const stripped = withoutWorkpiece(geometry);
  const withPlate = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config });
  const without = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config, geometry: stripped });
  assert.equal(without.workpiece, null, '去掉工件后不该再声称查了板');
  assert.equal(without.partCount, withPlate.partCount - 1, '几何刚体数正好少 1 件（就是工件）');
  // 干净设计下「加板」不改变对数（板只贴面不互穿），这正说明闸门没有被新增件污染
  for (const name of ['rest', 'lift', 'sweep']) {
    assert.equal(withPlate.states[name].pairs, without.states[name].pairs,
      `${name} 态：加板不该改变重叠对数`);
    assert.equal(without.states[name].confirmedHits, 0);
    assert.equal(without.states[name].screenHits, 0);
  }
  // 移载轴的动件只有工件本身：把工件摘掉，这条轴就没有可动的件 —— 该态如实不产出（不拿 lift 冒充）
  assert.equal(without.states.push, undefined, '没有工件的几何里不该产出 push 态');
  assert.match(String(without.unavailable?.push ?? ''), /没有可移载的轴/);
  // 而错误一旦存在，只有「带板」的检查看得见：
  const brokenGeometry = shiftZ(geometry, [WORKPIECE_PART_ID], -40);
  assert.ok(runInterferenceStates({ states: ['lift'], config }).states.lift.confirmedHits === 0);
  assert.ok(runInterferenceStates({ states: ['lift'], config, geometry: brokenGeometry }).states.lift.confirmedHits > 0);
  const brokenStripped = runInterferenceStates(
    { states: ['lift'], config, geometry: withoutWorkpiece(brokenGeometry) }
  );
  assert.equal(brokenStripped.states.lift.confirmedHits, 0, '没有工件时同一个错误看不见板 — 这就是新增的意义');
});

test('口径：工件不进 BOM / 成本 / 零件计数（几何刚体数 +1，装配件数不变）', () => {
  const config = transferConfig();
  const parts = buildConveyorParts(LINE);
  const resolved = resolveMachineGeometry(config);
  // BOM：ConveyorPart 零件表里没有工件，BOM 行里也就没有
  assert.equal(parts.some((part) => part.id === WORKPIECE_PART_ID), false);
  assert.equal(conveyorBom(parts).some((row) => /工件|光伏板/.test(row.name)), false, 'BOM 不能出现工件行');
  assert.equal(resolved.geometry.structureBom.some((row) => /工件|光伏板/.test(row.name)), false, '结构 BOM 也不能出现工件行');
  // 计数：装配件数（BOM/STEP 口径）= ConveyorPart 件数，不含工件
  assert.equal(resolved.assemblyPartCount, parts.length, `装配件数必须还是 ${parts.length} 件（不含工件）`);
  assert.equal(resolved.partCount, parts.length + 2 + 1,
    `几何刚体数 = ${parts.length} 装配件 + 2 根活塞杆 + 1 个工件 = ${parts.length + 3}（工件只在这里 +1）`);
  // 组件计数（执行机构/传感器/结构件）与去掉工件时完全一致
  assert.deepEqual(geometryComponentCounts(resolved.geometry), geometryComponentCounts(withoutWorkpiece(resolved.geometry)));
  assert.equal(resolved.geometry.parts.filter((part) => part.role === 'workpiece').length, 1);
});

test('不影响旧机型：转向机型仍然没有工件，rest/lift/sweep 数字与原口径一致', () => {
  const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，'
    + '需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';
  const design = synthMachine(parseMachineBrief(PV_BRIEF));
  const resolved = resolveMachineGeometry(design.config);
  assert.equal(workpieceOf(resolved.geometry), undefined, '转向机型不该有工件占位体');
  assert.equal(resolved.geometry.parts.some((part) => part.role === 'workpiece'), false);
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: design.config });
  assert.equal(result.ok, true);
  assert.equal(result.workpiece, null, '转向机型的 payload 里 workpiece 必须是 null');
  for (const name of ['rest', 'lift', 'sweep']) {
    assert.equal(result.states[name].confirmedHits, 0, `${name} 态：${JSON.stringify(result.states[name].items.slice(0, 3))}`);
    assert.equal(result.states[name].screenHits, 0);
    assert.equal(result.states[name].workpiecePairs, undefined, '没有工件时不该报工件字段');
  }
  // 旧口径的三态对数没变（54/52/54），说明这一轮只给移载机型加了料
  assert.equal(result.states.rest.pairs, 54);
  assert.equal(result.states.lift.pairs, 52);
  assert.equal(result.states.sweep.pairs, 54);
  // 装配件数与刚体数的差值仍然只是「活塞杆拆件」：85 件 + 2 根杆 = 87
  assert.equal(result.partCount, result.assemblyPartCount + 2);
  assert.equal(GUARD_TOP, 911, '挡边顶仍是 911（本文件其它断言都基于它）');
});
