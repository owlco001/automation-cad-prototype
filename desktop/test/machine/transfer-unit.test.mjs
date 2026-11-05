// 顶升移载（直角移载 / right-angle transfer）= 顶升 + 横向辊道 + 推板 + 下游对接段：
// 需求解析 → 参数化几何 → 两条运动轴 → 四个联锁信号 → 护栏 → 三态+push 干涉 的整链验收。
//
// 口径与 conveyor-turner.test.mjs 一致：这里断言「按尺寸能推出来的东西」，
// 干涉用 runInterferenceStates（AABB 初筛 + 解析式确认）在 four 个位姿上真跑，
// 真实 B-Rep 布尔仍由 build123d 内核在 E2E 里做。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  transferActionSeconds,
  transferLayout,
  transferPlateHalfWidth,
  transferPushSeconds,
  transferPushStrokeMm,
  transferSkipReason,
  transferStructuralGap
} from '../../src/machine/conveyor-assembly.ts';
import { detectTransfer, parseMachineBrief, detectTurner } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { precheck } from '../../src/plcgen/precheck.ts';
import { runInterferenceStates, shiftParts } from '../../src/machine/interference-states.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { validateFeatures } from '../../src/parametric/features.ts';

/** 主线：6000 × 1200，皮带面 850（与转向工位同一台线体的参数，方便横向对比） */
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
const BRIEF = '光伏板加工输送机：输送 1200×800mm 光伏板，线体长 6000mm、带宽 1200mm，'
  + '需要顶升移载沿 90° 方向把板子送到下游输送线，节拍 6 件/分钟';
const BELT_FACE = LINE.beltHeightMm; // 850
const BELT_BOTTOM = LINE.beltHeightMm - LINE.beltThicknessMm; // 846
const GUARD_TOP = LINE.beltHeightMm + 1 + 60; // 911
const PLATE_TOP_LIFT = 786; // 726 + 60

const layout = transferLayout(LINE);
const parts = buildConveyorParts(LINE);
// 关掉移载要同时清掉板宽：板宽 > 0 就是「要移载」（参数化生成器只吃数字参数，
// 用它当开关，见 model-builders.ts 的 transferPartWidthMm）
const plain = buildConveyorParts({ ...LINE, transferPresent: false, transferPartWidthMm: 0, transferPartLengthMm: 0 });
const byId = (id, list = parts) => list.find((part) => part.id === id);
const heightOf = (part) => Number(part.features[0].params.height);
const halfOf = (part) => heightOf(part) / 2;

/** 把移载工位做成 active 机型 config（与 synth.ts 同一套轴/点位），用于位姿化干涉 */
function transferConfig() {
  return {
    id: 'transfer-e2e',
    name: '顶升移载输送机',
    stations: ['工位1', '移载工位'],
    actuators: [
      {
        id: 'transfer-lift', name: '移载工位顶升台', kind: 'cylinder', station: '移载工位',
        travelMm: 60, durationMs: 2000, position: [0, 0, 0.05], point: 'ST-TRANSFER-LIFT'
      },
      {
        id: 'transfer-push', name: '移载工位移载台', kind: 'cylinder', station: '移载工位',
        travelMm: layout.pushStrokeMm, durationMs: Math.round(layout.pushSeconds * 1000),
        position: [0, 0.05, 0], point: 'ST-TRANSFER-PUSH'
      }
    ],
    sensors: [],
    formId: 'belt-line',
    conveyor: {
      lengthMm: LINE.lengthMm,
      widthMm: LINE.widthMm,
      transferPresent: true,
      transferPartLengthMm: LINE.transferPartLengthMm,
      transferPartWidthMm: LINE.transferPartWidthMm
    }
  };
}

test('需求解析：移载意图进结构化字段，且「移载 + 转向」同时出现时移载压掉转向', () => {
  assert.deepEqual(detectTransfer('需要顶升移载把板子送到下游输送线'), { present: true });
  assert.deepEqual(detectTransfer('顶升移载，直角转向'), { present: true });
  assert.deepEqual(detectTransfer('加一段移载机构'), { present: true });
  // 反向：普通输送线 / 只要旋转，不能凭空长出移载工位
  assert.equal(detectTransfer('皮带输送机 长 2000mm 宽 300mm 线速 0.2m/s'), null);
  assert.equal(detectTransfer('需要把光伏板旋转 90° 改变方向'), null);

  const brief = parseMachineBrief(BRIEF);
  assert.equal(brief.process, 'conveyor');
  assert.deepEqual(brief.transfer, { present: true });
  // 互斥：同一句话里既有「移载」又有「转向」，只能有一套机构，转向必须被压掉
  assert.equal(brief.turner, undefined, '移载与转向互斥，brief 里不该同时出现 turner');
  const both = parseMachineBrief('顶升移载，直角转向，把板子转 90 度送走');
  assert.deepEqual(both.transfer, { present: true });
  assert.equal(both.turner, undefined, '同时命中时移载优先（转向正则会命中「转向」两字）');
  assert.ok(detectTurner('需要把光伏板旋转 90° 改变方向'), '转向识别本身不能被改坏');
});

test('几何：窄带并联整条连续（上行不断开），回程在移载单元处让位', () => {
  assert.ok(layout);
  assert.equal(layout.beltCount, 6, '1200 宽 = 6 条 80 窄带（与转向工位同一布局函数）');
  assert.equal(layout.beltGapMm, 120);
  assert.equal(layout.unitHalfMm, 520);
  for (let index = 1; index <= 6; index += 1) {
    const top = byId(`belt-${index}`);
    assert.ok(top, `缺少 belt-${index}`);
    assert.equal(Number(top.features[0].params.length), LINE.lengthMm - 40, '上行程必须整条（不为移载断开）');
    assert.equal(top.transform.x, 0);
  }
  assert.equal(byId('belt-top'), undefined, '移载也走窄带并联，不再用 belt-top');
  // 回程：单元处让开 2×(520+10)
  const pieceLength = (LINE.lengthMm / 2 - 20) - (layout.unitHalfMm + 10);
  const ret = byId('belt-return-1-in');
  assert.ok(ret, '回程应拆成进出两段');
  assert.equal(Number(ret.features[0].params.length), pieceLength);
  assert.equal(byId('belt-return-1'), undefined, '回程不能在单元处整条横穿（顶升台板会顶穿它）');
});

test('几何：竖向叠层严格自下而上（安装板→缸体→活塞杆→随动台板），台板顶升后仍低于带底', () => {
  assert.ok(layout);
  const mount = byId('transfer-mount-plate');
  const cyl = byId('transfer-lift-cyl-1');
  const plate = byId('transfer-lift-plate');
  assert.ok(mount && cyl && plate);
  const bottom = (part) => part.transform.z - halfOf(part);
  const top = (part) => part.transform.z + halfOf(part);

  assert.equal(top(mount), bottom(cyl), '气缸法兰坐在安装板上（面贴合）');
  assert.equal(bottom(plate), top(cyl) + 24, '活塞杆露出 24 mm 顶住台板底面');
  assert.equal(top(plate), 726);
  assert.equal(layout.plateTopLiftZ, PLATE_TOP_LIFT);
  assert.ok(layout.plateTopLiftZ < BELT_BOTTOM,
    `顶升到位台板顶 ${layout.plateTopLiftZ} 必须低于带底 ${BELT_BOTTOM}：整块板升到带面里会顶穿每一条带`);
  // 导柱：从安装板顶到台板顶，台板开过孔，杆顶不脱出导向
  assert.equal(layout.guideBottomZ, layout.mountTopZ);
  assert.equal(layout.guideTopZ, layout.plateTopLiftZ, '导柱顶端 = 台板顶升到位的顶面（仍有整段配合）');
  const holes = plate.features.find((node) => node.type === 'holes');
  assert.equal(holes?.params.positions.length, 4);
  const holeSet = new Set(holes.params.positions.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of layout.guideCenters) {
    assert.ok(holeSet.has(`${x},${y}`), `导向柱 (${x},${y}) 没有对应过孔`);
  }
});

test('几何：移载辊道全部落在带缝中心，静止位低于带面、顶升后托起板件', () => {
  assert.ok(layout);
  assert.equal(layout.rollerYs.length, layout.beltCount - 1, '每条带缝一根辊，条数 = 带数 − 1');
  assert.deepEqual(layout.rollerYs, [-400, -200, 0, 200, 400]);
  assert.equal(layout.rollerDiameterMm, 50);
  assert.ok(layout.rollerDiameterMm < layout.beltGapMm, `辊径 ${layout.rollerDiameterMm} 必须小于带缝 ${layout.beltGapMm}，否则穿不上来`);
  assert.equal(layout.rollerTopRestZ, BELT_FACE - 5, '静止位辊面比带面低 5 mm（板完全压在带上）');
  assert.equal(layout.rollerTopLiftZ, BELT_FACE + 55, '顶升 60 后辊面 905（板底离开带面 55）');
  assert.ok(layout.rollerTopLiftZ > BELT_FACE, '顶升后辊面必须在带面之上，否则推不动板');
  // 每根辊两端各一根轴承立柱，立柱同样落在带缝中心
  assert.equal(layout.postCenters.length, layout.rollerYs.length * 2);
  assert.ok(layout.postDiameterMm < layout.beltGapMm, '轴承立柱 φ30 也必须塞进带缝');
  for (const [, y] of layout.postCenters) {
    assert.ok(layout.rollerYs.includes(y), `立柱 y=${y} 必须在带缝中心`);
  }
  const roller = byId('transfer-roller-1');
  assert.ok(roller);
  assert.equal(roller.features[0].params.axis, 'x', '辊轴沿 X（物料沿 +Y 走，轴线必须垂直于行走方向）');
  assert.equal(Number(roller.features[0].params.diameter), 50);
});

test('几何：推板在下料侧、下沿高过挡边顶，静止位停在板外', () => {
  assert.ok(layout);
  const push = byId('transfer-push-plate');
  assert.ok(push);
  const bottomZ = push.transform.z - halfOf(push);
  const topZ = push.transform.z + halfOf(push);
  assert.equal(bottomZ, layout.rollerTopRestZ + 60 + 10, '推板下沿 = 顶升后辊面 905 + 10 = 915');
  assert.ok(bottomZ > GUARD_TOP, `推板下沿 ${bottomZ} 必须高过挡边顶 ${GUARD_TOP}，否则推出时会撞挡边`);
  assert.ok(topZ > bottomZ);
  // 静止位：停在板外，板进站（板顶 885）从推板下面过
  const boardEdge = LINE.transferPartWidthMm / 2;
  assert.ok(layout.pushPlateRestY < -boardEdge, `推板静止位 ${layout.pushPlateRestY} 必须在板边 −${boardEdge} 之外`);
  assert.equal(layout.pushPlateEndY, layout.pushPlateRestY + layout.pushStrokeMm);
  // 行程下限：板尾要整块落到对接段
  assert.ok(layout.pushStrokeMm >= layout.minPushStrokeMm,
    `行程 ${layout.pushStrokeMm} 必须 ≥ 板尾离移所需 ${layout.minPushStrokeMm}`);
  assert.equal(layout.pushStrokeMm, transferPushStrokeMm(layout.partWidthMm, layout.structuralGapMm));
  assert.equal(layout.pushStrokeMm, 800 + 220 + 120, '行程 = 板宽 + 结构间隙 + 余量 = 1140');
});

test('几何：下游对接段在 +Y 侧，起点贴纵梁外侧，宽度按板长给', () => {
  assert.ok(layout);
  const railOuterY = LINE.widthMm / 2 + LINE.frameSectionMm + 15; // 655
  assert.equal(layout.dockStartY, railOuterY + 5, '对接段起点 = 主线纵梁外侧面 + 5 mm 结构间隙');
  assert.ok(layout.dockStartY > LINE.widthMm / 2, '对接段必须在主线外侧');
  assert.equal(layout.dockWidthMm, LINE.transferPartLengthMm + 200, '对接段宽度按板长 + 200（板是横着落上去的）');
  assert.ok(layout.dockWidthMm > LINE.widthMm, '对接段比主线宽（板长 1200 > 带宽 1200 时靠这条保证落料）');
  assert.ok(layout.dockLengthMm > layout.pushStrokeMm, '对接段要比行程长，留出缓冲');
  for (const [label] of [['left'], ['right']]) {
    assert.ok(byId(`dock-rail-${label}`), `缺少 dock-rail-${label}`);
    assert.ok(byId(`dock-guard-${label}`), `缺少 dock-guard-${label}`);
  }
  assert.ok(byId('dock-stop'), '缺挡停板（板会冲出对接段）');
  assert.ok(byId('dock-sensor-inlet') && byId('dock-sensor-outlet'), '缺传感器支架');
  assert.equal(parts.filter((part) => /^dock-roller-\d+$/.test(part.id)).length, layout.dockRollerYs.length);
  // 对接段带面与主线同高（否则落差处会卡板）
  assert.equal(layout.dockRollerCenterZ + 25, BELT_FACE);
});

test('几何：出料侧挡边在单元处断开（物料出口），进料侧整条不断', () => {
  const right = byId('guard-right');
  assert.equal(right, undefined, '+Y 挡边必须在单元处断开：板顶到 905，比挡边顶 911 只低 6 mm，整条挡边会挡住板');
  assert.ok(byId('guard-right-in') && byId('guard-right-out'), '出料侧挡边应拆成进出两段');
  const left = byId('guard-left');
  assert.ok(left, '−Y 侧挡边不该断（板不从这边出去）');
  assert.equal(Number(left.features[0].params.length), LINE.lengthMm - 60, '−Y 挡边整条');
});

test('运动轴：顶升 Z 60 mm + 移载 +Y 1140 mm，行程/方向都从参数推出来', () => {
  const design = synthMachine(parseMachineBrief(BRIEF));
  assert.deepEqual(design.config.stations, ['工位1', '移载工位']);
  const lift = design.config.actuators.find((actuator) => actuator.id === 'transfer-lift');
  const push = design.config.actuators.find((actuator) => actuator.id === 'transfer-push');
  assert.ok(lift, '缺少 transfer-lift 顶升轴');
  assert.ok(push, '缺少 transfer-push 移载轴');
  assert.equal(lift.station, '移载工位');
  assert.equal(push.station, '移载工位');
  assert.equal(lift.travelMm, 60, '顶升行程 60（与转向工位同口径）');
  assert.equal(lift.durationMs, 2000, '举升 + 回落两趟共 2.0 s');
  assert.deepEqual(lift.position, [0, 0, 0.05], '顶升是 Z 向（向上）');
  assert.equal(push.travelMm, 1140, '移载行程 = 板宽 800 + 结构间隙 220 + 余量 120');
  assert.ok((push.position?.[1] ?? 0) > 0, '移载是 +Y 向');
  assert.equal(push.position?.[0], 0);
  assert.equal(push.kind, 'cylinder', '本域只有 cylinder/gripper/rotary，直线移载借 cylinder 表达');
  assert.equal(push.durationMs, Math.round(transferPushSeconds(1140) * 1000));
  // config 里必须带上移载参数，否则整机几何只能回落到普通输送线
  assert.equal(design.config.conveyor?.transferPresent, true);
  assert.equal(design.config.conveyor?.transferPartWidthMm, 800);
  assert.ok(design.assumptions.some((text) => /借用 cylinder 表达直线移载/.test(text)),
    '借 cylinder 表达直线移载必须在 assumptions 里写明（行程/方向见 travelMm+position）');
  assert.ok(design.assumptions.some((text) => /移载行程 1140 mm = 板宽 800/.test(text)), '行程算式要写进 assumptions');
  assert.ok(design.assumptions.length <= 20, `assumptions ${design.assumptions.length} 条超过 20，方案卡会被裁成对象`);
});

test('联锁信号：四个信号存在且绑定正确，DO 是扩展点位，PLC 预检 blocked=0', () => {
  const design = synthMachine(parseMachineBrief(BRIEF));
  const bound = (point) => design.config.sensors.find((sensor) => sensor.point === point)?.part;
  assert.equal(bound('DI-TRANSFER-END'), 'transfer-push', '移载到位必须绑 transfer-push');
  assert.equal(bound('ST-TRANSFER-LIFT-UP'), 'transfer-lift');
  assert.equal(bound('ST-TRANSFER-LIFT-DOWN'), 'transfer-lift');
  assert.equal(bound('DI-DOWNSTREAM-ALLOW'), '移载工位', '下游允许接收绑工位（不属于任何一条轴）');
  for (const point of ['ST-TRANSFER-LIFT', 'ST-TRANSFER-PUSH', 'DI-TRANSFER-END', 'DI-DOWNSTREAM-ALLOW',
    'ST-TRANSFER-LIFT-UP', 'ST-TRANSFER-LIFT-DOWN', 'DO-TRANSFER-READY', 'DO-TRANSFER-DONE']) {
    assert.ok(design.points.includes(point), `点位 ${point} 没进设计点位表`);
  }
  const ioPoints = design.config.ioPoints ?? [];
  assert.deepEqual(ioPoints.map((item) => item.point).sort(), ['DO-TRANSFER-DONE', 'DO-TRANSFER-READY']);
  assert.ok(ioPoints.every((item) => item.area === 'output'), '两条握手信号都是输出');

  const io = buildMachineIoMap(design.config);
  const row = (point) => io.rows.find((entry) => entry.point === point);
  assert.ok(row('DO-TRANSFER-READY'), 'io-map 必须含 DO-TRANSFER-READY');
  assert.equal(row('DO-TRANSFER-READY')?.direction, '输出');
  assert.equal(row('DO-TRANSFER-READY')?.station, '移载工位');
  assert.ok(row('DO-TRANSFER-DONE') && row('DO-TRANSFER-DONE')?.direction === '输出');
  assert.equal(row('DI-DOWNSTREAM-ALLOW')?.direction, '输入');
  assert.equal(row('DI-TRANSFER-END')?.direction, '输入');
  assert.equal(row('ST-TRANSFER-PUSH')?.direction, '输出');
  // 安全回路：最小安全集（急停 + 安全门）
  assert.ok(design.config.sensors.some((sensor) => sensor.point === 'ST-TRANSFER-ESTOP'));
  assert.ok(design.config.sensors.some((sensor) => sensor.point === 'ST-TRANSFER-DOOR'));
  const pre = precheck(design.config);
  assert.deepEqual(pre.errors, [], `PLC 预检必须 0 错，实际：${JSON.stringify(pre.errors)}`);
});

test('护栏：带宽不够 / 线体太短 / 行程超限 / 与转向互斥 都拒建并给出数字理由', () => {
  // 带宽 1000：台板半宽 400 < 440（辊长 800 → 轴承立柱中心 ±420 + 柱半径 15 + 余量 5）
  const narrow = { ...LINE, widthMm: 1000 };
  const narrowReason = String(transferSkipReason(narrow));
  assert.match(narrowReason, /带宽 1000 mm < 顶升移载所需最小 1080 mm/);
  assert.match(narrowReason, /台板半宽 = min\(440, 带宽\/2 − 窄带 80 − 20\) = 400 mm/);
  assert.match(narrowReason, /台板半宽必须 ≥ 440 mm/);
  assert.equal(transferLayout(narrow), null);
  // 1200 宽是合法的（台板半宽 440 = 上限，正好托住立柱）
  assert.equal(transferSkipReason(LINE), null);
  // 300 宽连窄带并联都放不下
  assert.match(String(transferSkipReason({ ...LINE, widthMm: 300 })), /放不下窄带并联/);

  // 线体太短：单元占 X 向 1040，两端各留 300
  assert.match(String(transferSkipReason({ ...LINE, lengthMm: 1200 })), /放不下移载单元/);
  assert.equal(transferLayout({ ...LINE, lengthMm: 1200 }), null);

  // 行程上限：板宽 1180（带宽 1200 能压住）→ 1180 + 220 + 120 = 1520，仍合法
  assert.equal(transferPushStrokeMm(1180, transferStructuralGap(LINE)), 1520);
  assert.equal(transferSkipReason({ ...LINE, transferPartWidthMm: 1180 }), null);
  // 更宽的板（1700）在 1200 带宽上本来就压不住 → 先被「板宽 > 带宽」拦下
  assert.match(String(transferSkipReason({ ...LINE, transferPartWidthMm: 1700 })), /大于带宽/);
  // 行程护栏是「带宽上限放宽以后」的兜底：当前带宽夹紧在 ≤1200，板宽 ≤1200 →
  // 行程 ≤ 1200 + 220 + 120 = 1540 < 2000，所以这一条现在打不到；但公式必须能自证边界。
  assert.equal(transferPushStrokeMm(1200, transferStructuralGap(LINE)), 1540);
  assert.ok(1540 < 2000, '现有参数范围内行程不会越过直线轴上限');
  // 1150 的板在 1200 带宽上仍是合法的（行程 1490），护栏不该误伤
  assert.equal(transferSkipReason({ ...LINE, transferPartWidthMm: 1150 }), null);

  // 与转向互斥
  const both = { ...LINE, turnerAngleDeg: 90 };
  assert.match(String(transferSkipReason(both)), /与顶升移载互斥/);
  assert.equal(transferLayout(both), null);
  // 立体缓存不加移载
  assert.match(String(transferSkipReason({ ...LINE, layers: 3 })), /立体缓存/);
  // 没要求就没有理由（两种开法都认：transferPresent=true 或 板宽>0，见 normalizeParams）
  const off = { ...LINE, transferPresent: false, transferPartWidthMm: 0, transferPartLengthMm: 0 };
  assert.equal(transferSkipReason(off), null);
  assert.equal(transferLayout(off), null);
  assert.equal(buildConveyorParts(off).some((part) => part.id.startsWith('transfer-')), false);
  // 只给板宽（参数化生成器那条路）也算要移载
  assert.ok(transferLayout({ ...LINE, transferPresent: false, transferPartWidthMm: 800 }));
  // 拒建时警告里必须带算式，不能静默退化成普通输送线
  const design = synthMachine({
    ...parseMachineBrief(BRIEF),
    conveyor: { lengthMm: 6000, widthMm: 1000, speedMps: null, layers: null, loadKg: null, turner: null }
  });
  assert.equal(design.config.stations.includes('移载工位'), false);
  assert.ok(design.warnings.some((text) => /需求要求顶升移载，但本方案不做：带宽 1000 mm/.test(text)),
    `拒建必须给数字理由，实际 warnings=${JSON.stringify(design.warnings)}`);
});

test('三态 + push 干涉：rest / lift / sweep / push 全部 confirmed=0', () => {
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config: transferConfig() });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.geometrySource, 'conveyor-assembly');
  assert.equal(result.lift?.actuatorId, 'transfer-lift');
  assert.equal(result.lift?.strokeMm, 60);
  assert.equal(result.push?.actuatorId, 'transfer-push', 'push 态必须认移载轴，不能退化成顶升轴');
  assert.equal(result.push?.strokeMm, layout.pushStrokeMm);
  assert.deepEqual(result.push?.direction, [0, 1, 0]);
  for (const name of ['rest', 'lift', 'sweep', 'push']) {
    const entry = result.states[name];
    assert.ok(entry, `缺少 ${name} 态`);
    assert.equal(entry.confirmedHits, 0, `${name} 态有确认干涉：${JSON.stringify(entry.items.slice(0, 4))}`);
    assert.equal(entry.mm3Confirmed, 0);
    assert.equal(entry.screenHits, 0, `${name} 态有待复核对：${JSON.stringify(entry.items.slice(0, 4))}`);
    assert.equal(entry.reviewStatus, 'pass', `${name} 态判定应为 pass`);
  }
  // push 必须是**复合位姿**（先顶升、再沿 +Y 移出），不能是「又顶了一次」也不能等于 lift。
  // 这里自己按 lift+push 复算一遍，与工具给的数字逐项对齐。
  const geometry = resolveMachineGeometry(transferConfig()).geometry;
  const liftPose = shiftParts(geometry, result.lift.partIds, result.lift.direction, result.lift.strokeMm);
  assert.equal(result.states.lift.pairs, screenInterference(liftPose).count, 'lift 态应等于「只顶升」的位姿');
  const pushPose = shiftParts(liftPose, result.push.partIds, result.push.direction, result.push.strokeMm);
  assert.equal(result.states.push.pairs, screenInterference(pushPose).count, 'push 态应等于「顶升 + 沿 +Y 移出」的位姿');
  assert.ok(result.push.partIds.includes('transfer-push-plate'), 'push 轴必须包含推板');
  assert.ok(result.states.sweep.steps.length >= 6, 'sweep 应按 10 mm 逐步扫描 0..60');
  // 敏感性对照：push 与 lift 的零件对数相同（推板全程都碰不到东西，这正是设计目标），
  // 所以必须证明「这套检查确实会因 +Y 平移而报警」，否则 confirmed=0 可能只是「什么都没动」。
  // 拿一根轴承立柱按同样的 +Y 行程推过去：它会撞进对接段（实测 post × dock-roller）。
  const wrongPose = shiftParts(liftPose, ['transfer-roller-post-1'], [0, 1, 0], result.push.strokeMm);
  const wrongHits = screenInterference(wrongPose).pairs.filter((pair) => pair.classification === 'suspect');
  assert.ok(wrongHits.length > 0,
    '把轴承立柱按 +Y 推出 1140 必须撞到对接段；撞不到说明 push 态根本没在平移（检查退化成复制位姿）');
  assert.ok(wrongHits.some((pair) => /^dock-/.test(String(pair.a)) || /^dock-/.test(String(pair.b))),
    `对照组的命中应落在对接段上：${JSON.stringify(wrongHits.slice(0, 3))}`);
});


test('多组板宽/带宽都过三态+push：不是只对 1200/800 这一组调出来的', () => {
  // 这组参数是踩出来的：1200 宽 / 1200 板（≈板宽=带宽，也是「没给板宽」时的缺省）会把
  // 推板立柱送进纵梁带 y∈(−655,−615)，立柱×纵梁 2 对确认干涉。修法是把立柱让到纵梁外侧。
  const cases = [
    { widthMm: 1200, partLengthMm: 1200, partWidthMm: 800 },
    { widthMm: 1200, partLengthMm: 2000, partWidthMm: 1100 },
    { widthMm: 1200, partLengthMm: 0, partWidthMm: 0 }, // 缺省：板宽=带宽=1200
    { widthMm: 1100, partLengthMm: 1100, partWidthMm: 700 },
    { widthMm: 1080, partLengthMm: 1000, partWidthMm: 600 }
  ];
  for (const item of cases) {
    const params = {
      lengthMm: 6000,
      widthMm: item.widthMm,
      beltHeightMm: 850,
      pulleyDiameterMm: 50,
      beltThicknessMm: 4,
      frameSectionMm: 40,
      layers: 1,
      transferPresent: true,
      transferPartLengthMm: item.partLengthMm,
      transferPartWidthMm: item.partWidthMm
    };
    assert.equal(transferSkipReason(params), null, `${item.widthMm}/${item.partWidthMm} 应可建`);
    const plan = transferLayout(params);
    assert.ok(plan, `${item.widthMm}/${item.partWidthMm} 缺 layout`);
    // 立柱不能落进纵梁带（会让立柱从地面穿到 1006 直接穿纵梁）
    const railInner = item.widthMm / 2 + 15;
    const railOuter = railInner + 40;
    const gantryY = plan.pushColumnY;
    const inRailBand = gantryY < -railInner && gantryY > -railOuter;
    assert.equal(inRailBand, false, `${item.widthMm}/${item.partWidthMm} 立柱 y=${gantryY} 落进纵梁带 (${-railOuter}, ${-railInner})`);
    const config = {
      ...transferConfig(),
      conveyor: {
        lengthMm: 6000,
        widthMm: item.widthMm,
        transferPresent: true,
        transferPartLengthMm: item.partLengthMm,
        transferPartWidthMm: item.partWidthMm
      },
      actuators: transferConfig().actuators.map((actuator) => (
        actuator.id === 'transfer-push' ? { ...actuator, travelMm: plan.pushStrokeMm } : actuator
      ))
    };
    const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config });
    assert.equal(result.ok, true, `${item.widthMm}/${item.partWidthMm} 状态化检查失败`);
    for (const name of ['rest', 'lift', 'sweep', 'push']) {
      assert.equal(result.states[name].confirmedHits, 0,
        `${item.widthMm}/${item.partWidthMm} ${name} 态确认干涉：${JSON.stringify(result.states[name].items.slice(0, 3))}`);
      assert.equal(result.states[name].screenHits, 0,
        `${item.widthMm}/${item.partWidthMm} ${name} 态待复核：${JSON.stringify(result.states[name].items.slice(0, 3))}`);
    }
  }
});

test('BOM：移载关键件各自成行，数量按几何算', () => {
  const bom = conveyorBom(parts, {});
  const row = (name) => bom.find((entry) => entry.name === name);
  assert.ok(row('移载单元安装板'), '缺安装板行');
  assert.equal(row('移载顶升气缸')?.qty, 2);
  assert.equal(row('移载导向柱')?.qty, 4);
  assert.ok(row('移载随动台板'));
  assert.equal(row('移载辊道辊筒')?.qty, layout.rollerYs.length, '5 根辊归并成一行');
  assert.equal(row('移载辊道轴承立柱')?.qty, layout.postCenters.length, '10 根立柱归并成一行');
  assert.ok(row('移载推板'));
  assert.ok(row('移载无杆气缸'));
  assert.ok(row('对接段输送辊'));
  assert.ok(row('对接段挡边') || row('对接段挡边（左）'), '缺对接段挡边行');
  assert.equal(row('移载单元吊柱')?.qty, 4);

  const design = synthMachine(parseMachineBrief(BRIEF));
  const names = design.bomDraft.items.map((item) => item.name).join('|');
  assert.match(names, /移载单元安装板/);
  assert.match(names, /移载顶升气缸 φ80×56（行程 60）/);
  assert.match(names, /移载辊道 φ50×800/);
  assert.match(names, /移载无杆气缸 φ63×1380（行程 1140）/);
  assert.match(names, /下游对接段辊道 1400×1390/);
  assert.match(names, /DO-TRANSFER-READY/);
});

test('零件数稳定：移载单元件数只随带宽变化，线体加长只加横撑', () => {
  const transferIds = parts.filter((part) => part.id.startsWith('transfer-') || part.id.startsWith('dock-'));
  assert.equal(transferIds.length, 50, `移载单元件数应为 50，实际 ${transferIds.length}`);
  // 每件都带 material 与 actuatorId（BOM/排错要能顺着件号找到机构）
  for (const part of transferIds) {
    assert.ok(['AL6063', 'Q235', 'PVC', 'STEEL45'].includes(part.material), `${part.id} 材质缺失：${part.material}`);
    assert.match(String(part.actuatorId), /^transfer-(lift|push|dock)$/, `${part.id} 缺 actuatorId`);
  }
  // 线体加长：只影响横撑/皮带/挡边，移载单元件数不变
  const longer = buildConveyorParts({ ...LINE, lengthMm: 8000 });
  const longerIds = longer.filter((part) => part.id.startsWith('transfer-') || part.id.startsWith('dock-'));
  assert.equal(longerIds.length, transferIds.length, '移载单元件数不该随线体长度变化');
  assert.ok(parts.length > plain.length, '移载机型零件数必须多于普通线');
  // 特征树合法（交给 build123d 内核前必须过）
  assert.deepEqual(validateFeatures(conveyorAssembly(parts)), []);
  // 包络：长度不变、+Y 侧多出对接段
  const [len, width, height] = conveyorEnvelope(parts);
  assert.equal(len, conveyorEnvelope(plain)[0], '移载单元在中段，不把线体拉长');
  assert.ok(width > conveyorEnvelope(plain)[1] + 1000, `包络宽度 ${width} 应包含 +Y 对接段`);
  assert.ok(height >= 1058, `包络高度 ${height} 应覆盖推板机架（1058）`);
});

test('3D：不同材质不同颜色（视口里能分出铝件 / Q235 / 45# 钢 / PVC）', () => {
  const resolved = resolveMachineGeometry(transferConfig());
  assert.equal(resolved.source, 'conveyor-assembly');
  assert.equal(resolved.assemblyPartCount, parts.length);
  const byMaterial = new Map();
  for (const part of resolved.geometry.parts) {
    const key = String(part.material);
    if (!byMaterial.has(key)) byMaterial.set(key, new Set());
    byMaterial.get(key).add(String(part.color));
  }
  assert.ok(byMaterial.size >= 3, `视口里应出现 ≥3 种材质，实际 ${[...byMaterial.keys()].join(',')}`);
  for (const [material, colors] of byMaterial) {
    assert.equal(colors.size, 1, `材质 ${material} 出现了 ${colors.size} 种颜色：${[...colors].join(',')}`);
  }
  const allColors = [...byMaterial.values()].map((set) => [...set][0]);
  assert.equal(new Set(allColors).size, allColors.length, '不同材质必须给不同颜色');
  // 移载两条轴都进了 moving（3D 联动才能动）
  const axes = resolved.geometry.moving.filter((axis) => /^transfer-/.test(axis.actuatorId));
  const liftAxis = axes.find((axis) => axis.actuatorId === 'transfer-lift');
  const pushAxis = axes.find((axis) => axis.actuatorId === 'transfer-push');
  assert.ok(liftAxis && pushAxis, `移载两条轴都要进 moving：${axes.map((a) => a.actuatorId).join(',')}`);
  assert.deepEqual(pushAxis.axis, [0, 1, 0]);
  assert.equal(pushAxis.strokeMm, layout.pushStrokeMm);
  assert.ok(pushAxis.partIds.includes('transfer-push-plate'));
  assert.ok(liftAxis.partIds.includes('transfer-lift-plate'));
  assert.ok(liftAxis.partIds.some((id) => /^transfer-roller-\d+$/.test(id)), '辊道随台板升降');
});

test('动作时间：顶升 2.0 s + 移载 4.2 s，节拍按工位封顶而不是按线速', () => {
  assert.equal(transferActionSeconds(60, 1140), 6.2);
  assert.equal(transferPushSeconds(1140), 4.2, '0.4 起停 + 1140/300');
  const design = synthMachine(parseMachineBrief(BRIEF));
  assert.equal(design.cycle.slowestActionSeconds, 6.2);
  // 线速 0.2 m/s ÷ 间距 1200 = 10 件/分；移载 60/6.2 = 9.68 件/分 → 取小值
  assert.equal(design.cycle.throughputPerMin, 9.68);
  assert.match(design.cycle.bottleneck, /移载工位每件 6\.2 s.*9\.68 件\/分钟（移载为瓶颈）|移载工位每件 6\.2 s/);
});
