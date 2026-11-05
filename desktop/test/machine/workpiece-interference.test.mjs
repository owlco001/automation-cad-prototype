// 工件（板 1200×800×35）纳入移载机几何 + 四态干涉的产品级验收。
//
// 背景：移载机的干涉检查以前只比机构件之间的碰撞（推板/滑座/辊道/挡边），
// 「板能不能从出料口推出去」这件事在产品里根本看不见 —— 只能靠单测手工注入一个盒子，
// 上一轮的「板角扫切挡边 2520 mm³」就是这么发现的。注入只能证明「测试会算」，
// 证明不了「产品会查」。这一组用例全部走**产品几何**：
//   config → resolveMachineGeometry（含工件占位体）→ runInterferenceStates（四态）。
//
// 口径（本文件反复断言的那三句）：
//   1) 工件是普通件：参与全部碰撞对（含 sweep 逐步、push 逐点），不写专用判定；
//   2) 工件不进 BOM/成本/装配件数：parts/BOM 不变，只有几何刚体数 +1；
//   3) 位姿由两条移载轴给出：rest 贴带面 850、lift 到辊面 915（轴 70 − 拾取空行程 5）、push 再 +Y 1140。
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

/** 主线：6000 × 1200，带面 850，板 1200×800（与真机同一组参数） */
const LINE = {
  lengthMm: 6000,
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
        travelMm: liftStroke, durationMs: 2200, position: [0, 0, 0.05], point: 'ST-TRANSFER-LIFT'
      },
      {
        id: 'transfer-push', name: '移载工位移载台', kind: 'cylinder', station: '移载工位',
        travelMm: layout.pushStrokeMm, durationMs: 4200, position: [0, 0.05, 0], point: 'ST-TRANSFER-PUSH'
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

test('几何：移载机型建出工件占位体（1200×800×35，底面贴带面 850），非移载机型不建', () => {
  const resolved = resolveMachineGeometry(transferConfig());
  const plate = workpieceOf(resolved.geometry);
  assert.ok(plate, '移载机型的几何里必须有工件占位体');
  assert.equal(plate.id, WORKPIECE_PART_ID);
  assert.deepEqual(plate.shape, { type: 'box', size: [1200, 800, 35] });
  assert.equal(plate.center[2] - 17.5, BELT_FACE, 'rest 位板底 = 带面 850（板压在带上，不悬空也不埋进带里）');
  assert.equal(plate.center[0], 0, '板在主线中心线上');
  assert.equal(plate.center[1], 0, '板静止在中段，起点 y = 0');
  assert.equal(TRANSFER_DEFAULT_PART_THICKNESS_MM, 35, '缺省板厚必须是 35（与真机一致）');

  // 不要移载就没有工件：转向机型、普通线都不该凭空长出一块料
  const plain = resolveMachineGeometry({
    ...transferConfig(),
    conveyor: { lengthMm: 6000, widthMm: 1200, transferPresent: false, transferPartLengthMm: 0, transferPartWidthMm: 0 }
  });
  assert.equal(workpieceOf(plain.geometry), undefined, '普通输送线不该有工件占位体');
  const both = buildConveyorParts({
    ...LINE, transferPresent: false, transferPartLengthMm: 0, transferPartWidthMm: 0
  });
  assert.equal(both.some((part) => part.id === WORKPIECE_PART_ID), false, '工件不属于 ConveyorPart 零件表');
});

test('位姿表：rest 底 850 / lift 底 915 / push +Y 1140，位移由两条移载轴给出', () => {
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
  assert.equal(result.workpiece.bottomZ.lift, 915, 'lift 板底 = 915（= 顶升后的辊面，不是 920）');
  assert.equal(result.workpiece.pushTravelMm, 1140, 'push 沿 +Y 走满行程 1140');

  // 逐态从几何读出来复核（不信 payload 的自述）
  const lift = resolveAxisInfo(result, 'lift');
  const push = resolveAxisInfo(result, 'push');
  const restPlate = byId(geometry, WORKPIECE_PART_ID);
  const liftedPlate = byId(poseForState({ geometry, state: 'lift', lift, push }), WORKPIECE_PART_ID);
  const pushedPlate = byId(poseForState({ geometry, state: 'push', lift, push }), WORKPIECE_PART_ID);
  assert.equal(liftedPlate.center[2] - restPlate.center[2], 65, '板升 65 = 轴 70 − 拾取空行程 5');
  assert.equal(pushedPlate.center[1] - liftedPlate.center[1], 1140, 'push 只沿 +Y 走 1140，Z 不变');
  assert.equal(pushedPlate.center[2], liftedPlate.center[2]);
  assert.equal(liftAxis.partPickupGapMm?.[WORKPIECE_PART_ID], 5,
    '拾取空行程 5 mm 必须显式记在轴上：辊面静止位 845 比带面低 5，板要等台板贴上来才动');
});

/** 从 payload 取出某个态的轴信息（runInterferenceStates 的 lift/push 字段） */
function resolveAxisInfo(result, state) {
  return state === 'push' ? result.push : result.lift;
}

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
    // confirmed=0 只有在「板真的查了」时才有意义：板压在带/辊上是贴面，计入 workpieceTouching
    assert.ok((entry.workpieceTouching ?? 0) > 0,
      `${name} 态一件东西都没碰到板：可能根本没把板放进位姿（workpieceTouching=${entry.workpieceTouching}）`);
  }
  // 贴面对数：rest 4 条带（板宽 800 只压在 ±100/±300 四条带上）、lift 5 根辊（板底 915 = 辊面）
  assert.equal(result.states.rest.workpieceTouching, 4, 'rest 时应压在 4 条窄带上');
  assert.equal(result.states.lift.workpieceTouching, 5, 'lift 时应坐在 5 根移载辊上');
});

test('扫掠口径：sweep 每步都带板（0→70 共 8 步），push 逐点扫过 1140 且只回紧凑数字', () => {
  const result = runInterferenceStates({ states: ['sweep', 'push'], config: transferConfig() });
  const sweep = result.states.sweep;
  assert.equal(sweep.steps.length, 8, '70 / 10 = 8 步');
  const rising = sweep.steps.filter((step) => step.z > 5);
  assert.equal(rising.length, 7, 'z>5 的 7 步是板被托起之后的行程');
  for (const step of rising) {
    assert.ok((step.workpieceTouching ?? 0) > 0, `z=${step.z} 时板没跟着抬（workpieceTouching=0）`);
  }
  const push = result.states.push;
  assert.ok(push.samples >= 100, `push 只查了 ${push.samples} 点，端点采样不算扫掠`);
  assert.equal(push.samples, Math.round(layout.pushStrokeMm / 10) + 1, '每 10 mm 一点，含起点');
  assert.equal(push.hitSamples, 0, '全程 0 命中：板真的推得出去');
  assert.equal(push.hitRange, null);
  assert.equal(push.worst, null);
  assert.ok((push.workpieceTouchingSamples ?? 0) > 0, 'push 全程有板贴着辊道，说明板在动');
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
  }
});

test('负向对照①：板厚 35→120 顶穿推板无杆气缸，报出逐对 partId + mm³', () => {
  const result = runInterferenceStates({
    states: ['rest', 'lift', 'sweep', 'push'],
    config: transferConfig({ part: { transferPartThicknessMm: 120 } })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.workpiece.sizeMm, [1200, 800, 120]);
  const lift = result.states.lift;
  assert.ok(lift.confirmedHits > 0, '板厚 120 必须被报出来（板顶 1035 顶进推板气缸 1005..1068）');
  const pair = lift.items.find((item) => item.kind === 'suspect');
  assert.ok(pair, JSON.stringify(lift.items.slice(0, 3)));
  assert.equal(`${pair.a}|${pair.b}`.includes(WORKPIECE_PART_ID), true, '命中的必须是工件那一对');
  assert.equal(pair.exactOverlapMm3, 1512000,
    `解析式体积应为 63（气缸 X）× 800（板宽）× 30（Z 向互穿） = 1512000 mm³，实际 ${pair.exactOverlapMm3}`);
  assert.equal(lift.reviewStatus, 'fail');
  assert.equal(result.reviewStatus, 'fail');
  assert.equal(result.states.rest.confirmedHits, 0, 'rest 位板顶 970，仍低于气缸底 1005：只有抬起来才撞');
  // 扫掠与 push 都要报（不是只在 lift 那一点）
  assert.ok(result.states.sweep.confirmedHits > 0, 'sweep 全程也必须报（板在抬起过程中一直顶气缸）');
  assert.ok(result.states.push.confirmedHits > 0, 'push 全程也必须报');
});

test('负向对照②：出料口收窄到 ±530 + 行程 60（板底 905）→ push 单步 2520 mm³，逐对可读', () => {
  const geometry = resolveMachineGeometry(transferConfig()).geometry;
  const result = runInterferenceStates({
    states: ['lift', 'push'],
    config: transferConfig({ liftStroke: 60 }),
    geometry: narrowOutfeed(geometry, 90)
  });
  assert.equal(result.ok, true);
  assert.equal(result.workpiece.bottomZ.lift, 905, '行程 60 时板底只能到 905（挡边顶 911，差 6 mm）');
  assert.equal(result.states.lift.confirmedHits, 0, 'lift 位板还没到挡边跟前（y 向没到）');
  const push = result.states.push;
  assert.ok(push.worst, 'push 扫掠必须报出来：开口窄了只在横穿挡边时撞');
  assert.equal(push.worst.mm3Confirmed, 2520,
    `应为 2×(530..600)=70 × 3（挡边厚）× 6（911−905） = 2520 mm³，实际 ${push.worst.mm3Confirmed}`);
  assert.ok(push.hitSamples > 0 && push.hitRange, '命中位姿要给出范围（从某个 y 起一直撞到板尾离开挡边）');
  assert.equal(push.hitRange[1] > push.hitRange[0], true, '板是横穿挡边，命中必然跨一段行程');
  const pairs = push.items.filter((item) => item.kind === 'suspect');
  assert.equal(pairs.length, 2, `两侧挡边各一对，实际 ${JSON.stringify(pairs)}`);
  for (const item of pairs) {
    assert.match(`${item.a}×${item.b}`, /guard-right-(in|out)×workpiece-plate/);
    assert.equal(item.exactOverlapMm3, 1260, '每侧 1260 mm³（70×3×6）');
  }
});

test('去掉工件即回到旧口径：pairs 与旧基线一致、workpiece=null、负向对照归零', () => {
  const config = transferConfig();
  const geometry = resolveMachineGeometry(config).geometry;
  const stripped = withoutWorkpiece(geometry);
  const withPlate = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config });
  const without = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config, geometry: stripped });
  assert.equal(without.workpiece, null, '去掉工件后不该再声称查了板');
  // 旧基线（AUDIT-transfer-2026-11-05）：pairs 54/52/52（rest/lift/push）
  assert.equal(without.states.rest.pairs, 54);
  assert.equal(without.states.lift.pairs, 52);
  assert.equal(without.states.push.pairs, 52);
  assert.equal(without.partCount, withPlate.partCount - 1, '几何刚体数正好少 1 件（就是工件）');
  // 干净设计下「加板」不改变对数（板只贴面不互穿），这正说明闸门没有被新增件污染
  assert.equal(withPlate.states.rest.pairs, without.states.rest.pairs);
  assert.equal(withPlate.states.lift.pairs, without.states.lift.pairs);
  // 而错误一旦存在，只有「带板」的检查看得见：
  const broken = transferConfig({ part: { transferPartThicknessMm: 120 } });
  const brokenGeometry = resolveMachineGeometry(broken).geometry;
  assert.ok(runInterferenceStates({ states: ['lift'], config: broken }).states.lift.confirmedHits > 0);
  const brokenStripped = runInterferenceStates(
    { states: ['lift'], config: broken, geometry: withoutWorkpiece(brokenGeometry) }
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
  assert.equal(resolved.assemblyPartCount, parts.length, '装配件数必须还是 110 件（不含工件）');
  assert.equal(resolved.partCount, parts.length + 2 + 1,
    '几何刚体数 = 110 装配件 + 2 根活塞杆 + 1 个工件 = 113（工件只在这里 +1）');
  // 组件计数（执行机构/传感器/结构件）与去掉工件时完全一致
  assert.deepEqual(geometryComponentCounts(resolved.geometry), geometryComponentCounts(withoutWorkpiece(resolved.geometry)));
  // 干涉结果里的口径三连也必须自证
  assert.equal(resolved.partCount, parts.length + 3);
  assert.equal(resolved.assemblyPartCount, parts.length);
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
