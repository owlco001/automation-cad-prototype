// 顶升移载（Y 向短带式直角移载）的整链验收：
// 需求解析 → 参数化几何（3 条 X 窄带 + 4 段 Y 短带 + 升降架 + 下游接料输送机）→ 两条运动轴 →
// 四个联锁信号 → 护栏 → 四态（rest/lift/sweep/push）干涉。
//
// 构型口径（这一版与上一版的差别）：
//   上一版：6 条 80 窄带 + 带缝里的辊道 + 推板 + 无杆气缸，线长 6000；
//   这一版：3 条 100 窄带（节距 400、带缝 300）+ 每个带缝 2 段短 Y 带 + 顶升后 Y 带转动送料，
//           线长 3000（参数区间 2400~4000）。
// 干涉口径与 conveyor-turner.test.mjs 一致：AABB 初筛 + 解析式确认，在四个位姿上真跑；
// 真实 B-Rep 布尔由 build123d 内核在 E2E 里做。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIDE_GUARD_HEIGHT_MM,
  TRANSFER_BELT_COUNT,
  TRANSFER_LIFT_STROKE_MM,
  TRANSFER_MAX_LENGTH_MM,
  TRANSFER_MIN_LENGTH_MM,
  TRANSFER_MIN_WIDTH_MM,
  TRANSFER_PLATE_GUARD_CLEAR_MM,
  TRANSFER_Y_BELT_DROP_MM,
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  transferActionSeconds,
  transferBeltLayout,
  transferLayout,
  transferOutfeedOpenHalfXMm,
  transferPushSeconds,
  transferPushStrokeMm,
  transferSkipReason,
  transferYBeltLength
} from '../../src/machine/conveyor-assembly.ts';
import { detectTransfer, parseMachineBrief, detectTurner } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { precheck } from '../../src/plcgen/precheck.ts';
import {
  poseForState,
  runInterferenceStates,
  shiftParts
} from '../../src/machine/interference-states.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { validateFeatures } from '../../src/parametric/features.ts';

/** 主线：3000 × 1200（这一版构型的默认线长），皮带面 850，板 1200×800 */
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
const BRIEF = '光伏板加工输送机：输送 1200×800mm 光伏板，线体长 3000mm、带宽 1200mm，'
  + '需要顶升移载沿 90° 方向把板子送到下游输送线，节拍 6 件/分钟';
const BELT_FACE = LINE.beltHeightMm; // 850
const BELT_BOTTOM = LINE.beltHeightMm - LINE.beltThicknessMm; // 846
const GUARD_TOP = LINE.beltHeightMm + 1 + SIDE_GUARD_HEIGHT_MM; // 911（挡边下沿 = 带面+1，高 60）
/** 顶升行程：静止位 Y 带面比 X 带面低 25，板底要越过挡边顶 911 至少 4 → 25+1+60+4 = 90 */
const LIFT_STROKE = 90;
/** 顶升到位时的板底（= Y 带面顶升到位 = 挡边顶 + 4） */
const PLATE_BOTTOM_LIFT = 915;
/** 升降架横梁顶（静止位）：带底 846 − 净空 6 − 行程 90 */
const BEAM_TOP = 750;

const layout = transferLayout(LINE);
const parts = buildConveyorParts(LINE);
// 关掉移载要同时清掉板宽：板宽 > 0 就是「要移载」（参数化生成器只吃数字参数）
const plain = buildConveyorParts({ ...LINE, transferPresent: false, transferPartWidthMm: 0, transferPartLengthMm: 0 });
const byId = (id, list = parts) => list.find((part) => part.id === id);
const heightOf = (part) => Number(part.features[0].params.height);

/** 把移载工位做成 active 机型 config（与 synth.ts 同一套轴/点位），用于位姿化干涉 */
function transferConfig() {
  return {
    id: 'transfer-e2e',
    name: '顶升移载输送机',
    stations: ['工位1', '移载工位'],
    actuators: [
      {
        id: 'transfer-lift', name: '移载工位顶升台', kind: 'cylinder', station: '移载工位',
        travelMm: layout.strokeMm, durationMs: Math.round(layout.liftSeconds * 1000),
        position: [0, 0, 0.05], point: 'ST-TRANSFER-LIFT'
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
  assert.equal(brief.turner, undefined, '移载与转向互斥，brief 里不该同时出现 turner');
  const both = parseMachineBrief('顶升移载，直角转向，把板子转 90 度送走');
  assert.deepEqual(both.transfer, { present: true });
  assert.equal(both.turner, undefined, '同时命中时移载优先（转向正则会命中「转向」两字）');
  assert.ok(detectTurner('需要把光伏板旋转 90° 改变方向'), '转向识别本身不能被改坏');
});

test('构型①：X 向只 3 条窄带（100 / 节距 400 / 带缝 300），上行整条连续，回程在单元处让位', () => {
  assert.ok(layout);
  assert.equal(layout.beltCount, 3, '老王构型是 3 条窄带，不是上一版的 6 条');
  assert.equal(layout.beltWidthMm, 100, '1200 带宽 → 单条 100（节距/4）');
  assert.equal(layout.beltPitchMm, 400, '节距 = 带宽/3 = 400');
  assert.equal(layout.beltGapMm, 300, '带缝 = 节距 − 带宽 = 300');
  assert.deepEqual(layout.beltCenterYs, [-400, 0, 400]);
  assert.deepEqual(layout.beltGapCenterYs, [-200, 200]);
  // 带宽变化时按公式算，不写死
  assert.deepEqual(transferBeltLayout({ ...LINE, widthMm: 1080 }), {
    count: 3, widthMm: 90, pitchMm: 360, gapMm: 270, centers: [-360, 0, 360], gaps: [-180, 180]
  });
  assert.equal(TRANSFER_BELT_COUNT, 3);

  for (let index = 1; index <= 3; index += 1) {
    const top = byId(`belt-${index}`);
    assert.ok(top, `缺少 belt-${index}`);
    assert.equal(Number(top.features[0].params.length), LINE.lengthMm - 40, '上行程必须整条（不为移载断开）');
    assert.equal(top.transform.x, 0);
    // 三条带必须正好落在 layout 给的带中心上（节距 400）
    assert.equal(top.transform.y, layout.beltCenterYs[index - 1]);
  }
  assert.equal(byId('belt-top'), undefined, '移载走 3 条窄带，不再用单条宽带 belt-top');
  // 每带一套主动/从动滚筒
  for (let index = 1; index <= 3; index += 1) {
    assert.ok(byId(`pulley-drive-${index}`) && byId(`pulley-idle-${index}`), `第 ${index} 条带缺滚筒`);
  }
  // 回程：单元处让开 2×(620+10)
  const pieceLength = (LINE.lengthMm / 2 - 20) - (layout.unitHalfMm + 10);
  const ret = byId('belt-return-1-in');
  assert.ok(ret, '回程应拆成进出两段');
  assert.equal(Number(ret.features[0].params.length), pieceLength);
  assert.equal(byId('belt-return-1'), undefined, '回程不能在单元处整条横穿（升降架会顶穿它）');
});

test('构型②：带缝里 4 段短 Y 带（每缝 2 段），段长受带缝限制，静止位带面低 25 mm 不碰板', () => {
  assert.ok(layout);
  assert.equal(layout.yBeltCount, 4, '两个带缝 × 每缝 2 段 = 4 段');
  const perGap = layout.yModules.filter((module) => module.gapIndex === 0);
  assert.equal(perGap.length, 2, '每个带缝 2 段');
  assert.deepEqual(layout.yModules.map((module) => [module.xMm, module.yMm]),
    [[-200, -200], [200, -200], [-200, 200], [200, 200]], '两段分在带缝两侧（±节距/2），落在带缝中心');
  // 段长 = 带缝 − 2×10 让位；建议值 420 在 300 的带缝里放不下（会伸到 X 带下方，顶升必扫带）
  assert.equal(layout.yBeltLengthMm, 280);
  assert.equal(layout.yBeltLengthMm, transferYBeltLength(layout.beltGapMm));
  assert.equal(layout.yBeltLengthMm, layout.beltGapMm - 20);
  assert.equal(layout.yBeltClearanceMm, 10, '段端到带缝边缘各留 10 mm');
  assert.ok(layout.yBeltLengthMm <= layout.beltGapMm,
    `段长 ${layout.yBeltLengthMm} 必须 ≤ 带缝 ${layout.beltGapMm}：段一旦伸到 X 带下方，顶升 90 时必扫带`);
  // 带缝够宽时段长才吃满建议值 420
  assert.equal(transferYBeltLength(440), 420);
  assert.equal(transferYBeltLength(300), 280);

  // 静止位：Y 带面比 X 带面低 25（板完全压在 X 带上，Y 带不吃力）
  assert.equal(layout.yBeltFaceRestZ, BELT_FACE - TRANSFER_Y_BELT_DROP_MM);
  assert.equal(layout.yBeltFaceRestZ, 825);
  assert.equal(TRANSFER_Y_BELT_DROP_MM, 25);
  assert.equal(layout.yBeltDropMm, 25);

  // 4 段都在几何里，各段 X 宽 100、Y 长 280，且整段落在带缝里
  for (const module of layout.yModules) {
    const belt = byId(`transfer-y-belt-${module.index}`);
    assert.ok(belt, `缺少 transfer-y-belt-${module.index}`);
    assert.equal(Number(belt.features[0].params.length), layout.yBeltWidthMm, '短带 X 向宽 = 带缝里的带宽');
    assert.equal(Number(belt.features[0].params.width), layout.yBeltRunMm, '短带只画两端滚筒之间那段（280 − 2×20 = 240）');
    assert.equal(belt.transform.y, module.yMm);
    // 段的 Y 向包络必须留在带缝里：带缝中心 ±150，段 ±140
    const outer = Math.abs(module.yMm) + layout.yBeltLengthMm / 2;
    assert.ok(outer <= Math.abs(module.yMm) + layout.beltGapMm / 2,
      `段 ${module.index} 的 Y 包络 ${outer} 超出带缝`);
    // 每段两端各一只滚筒 + 底板 + 两侧颊 + 回程
    assert.ok(byId(`transfer-y-pulley-${module.index}-in`), `第 ${module.index} 段缺进料端滚筒`);
    assert.ok(byId(`transfer-y-pulley-${module.index}-out`), `第 ${module.index} 段缺出料端滚筒`);
    assert.ok(byId(`transfer-y-belt-return-${module.index}`), `第 ${module.index} 段缺回程`);
    assert.ok(byId(`transfer-y-base-${module.index}`), `第 ${module.index} 段缺底板`);
    assert.ok(byId(`transfer-y-cheek-${module.index}-left`) && byId(`transfer-y-cheek-${module.index}-right`),
      `第 ${module.index} 段缺侧颊`);
  }
  // 同一带缝的两段共一根同步轴（同速，否则板会歪）
  assert.equal(layout.ySyncShaftYs.length, 2);
  assert.deepEqual([...layout.ySyncShaftYs].sort((a, b) => a - b), [-330, 330], '两个带缝各一根，取外侧那只端滚筒（对称）');
  for (const [index, y] of layout.ySyncShaftYs.entries()) {
    const shaft = byId(`transfer-y-shaft-${index + 1}`);
    assert.ok(shaft, `缺同步轴 ${index + 1}`);
    assert.equal(shaft.features[0].params.axis, 'x', '同步轴沿 X 串起同一带缝的两段');
    assert.equal(shaft.transform.y, y);
  }
  // 四段都在同一个升降架上（随顶升轴一起动）
  assert.equal(layout.riserCenters.length, 4);
  for (const module of layout.yModules) {
    assert.equal(byId(`transfer-lift-riser-${module.index}`).transform.x, module.xMm);
    assert.equal(byId(`transfer-lift-riser-${module.index}`).transform.y, module.yMm);
  }
});

test('顶升③：行程 90 由挡边顶反推，升降架顶升到位仍低于带底，板底正好在挡边顶 + 4', () => {
  assert.ok(layout);
  // 算式逐项独立复算（不拿 layout 自证）
  assert.equal(LIFT_STROKE, TRANSFER_Y_BELT_DROP_MM + 1 + SIDE_GUARD_HEIGHT_MM + TRANSFER_PLATE_GUARD_CLEAR_MM);
  assert.equal(TRANSFER_LIFT_STROKE_MM, 90);
  assert.equal(layout.strokeMm, 90);
  assert.equal(layout.yBeltFaceLiftZ, layout.yBeltFaceRestZ + 90, 'Y 带面 825 + 90 = 915');
  assert.equal(layout.yBeltFaceLiftZ, PLATE_BOTTOM_LIFT);
  assert.equal(layout.partBottomLiftZ, PLATE_BOTTOM_LIFT, '板底 = Y 带面顶升到位（板由 Y 带托着）');
  assert.equal(layout.guardTopZ, GUARD_TOP);
  assert.equal(layout.plateBottomLiftZ, layout.guardTopZ + TRANSFER_PLATE_GUARD_CLEAR_MM);
  assert.equal(layout.plateGuardGapMm, 4);
  // 顶升后 Y 带面高于 X 带面（板真的离开了 X 带）
  assert.ok(layout.yBeltFaceLiftZ > BELT_FACE + 60,
    `顶升后 Y 带面 ${layout.yBeltFaceLiftZ} 必须明显高于 X 带面 ${BELT_FACE}（板脱开 X 带 65）`);
  assert.equal(layout.yBeltFaceLiftZ - BELT_FACE, 65, '板离开 X 带 65 = 行程 90 − 静止位低 25');
  // 升降架：横梁顶 = 带底 − 净空 6 − 行程 90 → 顶升到位仍低于带底 6 mm，全程不穿带
  assert.equal(layout.beamTopZ, BEAM_TOP);
  assert.equal(layout.beamTopZ, BELT_BOTTOM - 6 - 90);
  assert.ok(layout.beamTopZ + layout.strokeMm < BELT_BOTTOM,
    `横梁顶升到位 ${layout.beamTopZ + layout.strokeMm} 必须 < 带底 ${BELT_BOTTOM}`);
  assert.equal(layout.beamTopZ + layout.strokeMm, 840);
  // 导向柱顶不穿带面
  assert.ok(layout.guideTopZ < BELT_BOTTOM, `导向柱顶 ${layout.guideTopZ} 必须低于带底 ${BELT_BOTTOM}`);
  assert.equal(layout.guideTopZ, 845);
  // 台架自下而上：安装板 → 缸体 → 活塞杆 → 升降架
  assert.ok(layout.mountBottomZ >= 60, `安装板底 ${layout.mountBottomZ} 离地不足 60`);
  assert.equal(layout.mountTopZ, layout.cylBodyCenterZ - layout.cylBodyLengthMm / 2);
  assert.equal(layout.cylRodTopZ, layout.beamBottomZ, '活塞杆顶住升降架横梁底面（推力面）');
});

test('顶升④：四态真跑 —— Y 模块顶升全程不碰 X 带与机架（板块内 90 mm 全行程 0 命中）', () => {
  // 这一条是「构型②」的结构性前提的数值化验证：Y 段与升降架都落在带缝里，
  // 顶升 90 时它们扫过的空间里没有 X 带、没有纵梁、没有挡边。
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: transferConfig() });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  const sweep = result.states.sweep;
  assert.equal(sweep.steps.length, 10, '90 / 10 = 9 步 + 起点 = 10 步');
  assert.equal(sweep.steps.at(-1).z, 90, 'sweep 必须扫到行程末端 90');
  assert.equal(sweep.hitSamples ?? 0, 0, `顶升途中有命中位姿：${JSON.stringify(sweep.items.slice(0, 4))}`);
  for (const step of sweep.steps) {
    assert.equal(step.confirmedHits, 0, `z=${step.z} 有确认干涉：${JSON.stringify(sweep.items.slice(0, 3))}`);
    assert.equal(step.screenHits, 0, `z=${step.z} 有待复核对：${JSON.stringify(sweep.items.slice(0, 3))}`);
  }
  assert.equal(sweep.confirmedHits, 0);
  assert.equal(sweep.screenHits, 0);
  // 顶升到位时板底 = Y 带面，板不再压在 X 带上
  assert.equal(result.workpiece.bottomZ.lift, PLATE_BOTTOM_LIFT);
});

test('下游接料⑤：+Y 侧短输送机，带面 = Y 带出料面（915），接口与挡边开口都从参数算', () => {
  assert.ok(layout);
  const railOuterY = LINE.widthMm / 2 + LINE.frameSectionMm + 15; // 655
  assert.equal(layout.dockStartY, railOuterY + 5, '接料段起点 = 主线纵梁外侧面 + 5 mm 结构间隙');
  assert.ok(layout.dockStartY > LINE.widthMm / 2, '接料段必须在主线外侧');
  // 带面同高：落料无落差（这是「板从 Y 带出料面直接滑到接料段」的唯一前提）
  assert.equal(layout.dockBeltFaceZ, layout.yBeltFaceLiftZ, '接料段带面必须 = Y 带出料面');
  assert.equal(layout.dockBeltFaceZ, PLATE_BOTTOM_LIFT);
  assert.equal(layout.dockPulleyCenterZ + layout.dockPulleyDiameterMm / 2, layout.dockBeltFaceZ);
  const beltTop = byId('dock-belt-top');
  assert.ok(beltTop);
  assert.equal(beltTop.transform.z + Number(beltTop.features[0].params.height) / 2, layout.dockBeltFaceZ);
  assert.equal(Number(beltTop.features[0].params.width), layout.dockBeltLengthMm);
  // 宽度按板长给（板是横着过去的），长度要盖住板 + 缓冲
  assert.equal(layout.dockWidthMm, LINE.transferPartLengthMm + 200);
  assert.ok(layout.dockLengthMm >= LINE.transferPartWidthMm + 200);
  assert.ok(layout.dockLengthMm > layout.pushStrokeMm - layout.dockStartY + LINE.transferPartWidthMm / 2,
    '接料段要长到板能整块落上去');
  assert.ok(byId('dock-rail-left') && byId('dock-rail-right'), '缺接料段纵梁');
  assert.equal(parts.filter((part) => /^dock-leg-\d+$/.test(part.id)).length, 4, '接料段 4 条支腿');
  assert.ok(byId('dock-guard-left') && byId('dock-guard-right'), '缺接料段挡边（板会掉下去）');
  assert.ok(byId('dock-stop'), '缺挡停板（板会冲出接料段）');
  assert.ok(byId('dock-sensor-inlet') && byId('dock-sensor-outlet'), '缺到位光电支架');
  assert.equal(layout.dockPulleyYs.length, 2);
  // 出料口（+Y 挡边开口）宽度从板长推
  assert.equal(layout.outfeedOpenHalfXMm, transferOutfeedOpenHalfXMm(LINE.transferPartLengthMm, layout.unitHalfMm));
  assert.equal(layout.outfeedOpenHalfXMm, LINE.transferPartLengthMm / 2 + 20);
  assert.ok(layout.outfeedOpenHalfXMm * 2 >= LINE.transferPartLengthMm + 40,
    `开口总宽 ${layout.outfeedOpenHalfXMm * 2} 必须 ≥ 板长 ${LINE.transferPartLengthMm} + 40`);
  const right = byId('guard-right');
  assert.equal(right, undefined, '+Y 挡边必须在单元处断开：板要从这条边整块出去');
  assert.ok(byId('guard-right-in') && byId('guard-right-out'), '出料侧挡边应拆成进出两段');
  const seg = byId('guard-right-in');
  const segLen = Number(seg.features[0].params.length);
  assert.equal(Math.abs(seg.transform.x) - segLen / 2, layout.outfeedOpenHalfXMm, '挡边段近侧起点 = 开口边界');
  assert.ok(byId('guard-left'), '−Y 侧挡边不该断（板不从这边出去）');
  // 移载行程：板心 → 接料段带面起点 + 余量；下限 = 板尾整块落到接料段
  assert.equal(layout.pushStrokeMm, transferPushStrokeMm(LINE.transferPartWidthMm, layout.dockStartY));
  assert.equal(layout.pushStrokeMm, 400 + 660 + 120);
  assert.equal(layout.minPushStrokeMm, 1060);
  assert.ok(layout.pushStrokeMm >= layout.minPushStrokeMm);
  assert.equal(layout.structuralGapMm, layout.dockStartY);
});

test('运动轴⑥：两条轴（顶升 90 / 移载 1180），零旋转轴，移载轴只搬料不动机构', () => {
  const design = synthMachine(parseMachineBrief(BRIEF));
  assert.deepEqual(design.config.stations, ['工位1', '移载工位']);
  const lift = design.config.actuators.find((actuator) => actuator.id === 'transfer-lift');
  const push = design.config.actuators.find((actuator) => actuator.id === 'transfer-push');
  assert.ok(lift, '缺少 transfer-lift 顶升轴');
  assert.ok(push, '缺少 transfer-push 移载轴');
  assert.equal(lift.travelMm, LIFT_STROKE, '顶升 90：板底 915 要越过挡边顶 911 至少 4 mm');
  assert.equal(lift.travelMm, layout.strokeMm, 'config 的 travelMm 必须就是几何用的那个行程');
  assert.equal(lift.durationMs, 2600, '举升 + 回落两趟共 2.6 s（0.4 + 90/100，再×2）');
  assert.deepEqual(lift.position, [0, 0, 0.05], '顶升是 Z 向（向上）');
  assert.equal(push.travelMm, 1180, '移载行程 = 板宽/2 400 + 板心到接料段 660 + 余量 120');
  assert.ok((push.position?.[1] ?? 0) > 0, '移载是 +Y 向');
  assert.equal(push.position?.[0], 0);
  assert.equal(push.kind, 'cylinder', '本域只有 cylinder/gripper/rotary，直线移载借 cylinder 表达');
  // 「板不转」的硬约束：整台机器一条旋转轴都不能有
  assert.equal(design.config.actuators.filter((actuator) => actuator.kind === 'rotary').length, 0);
  // 几何里两条轴的动件：顶升带整组升降架 + 4 段短带；移载只带工件（带的转动不改机构位姿）
  const resolved = resolveMachineGeometry(design.config);
  const axes = resolved.geometry.moving.filter((axis) => /^transfer-/.test(axis.actuatorId));
  const liftAxis = axes.find((axis) => axis.actuatorId === 'transfer-lift');
  const pushAxis = axes.find((axis) => axis.actuatorId === 'transfer-push');
  assert.ok(liftAxis && pushAxis, `移载两条轴都要进 moving：${axes.map((a) => a.actuatorId).join(',')}`);
  assert.equal(liftAxis.strokeMm, LIFT_STROKE);
  for (const module of layout.yModules) {
    assert.ok(liftAxis.partIds.includes(`transfer-y-belt-${module.index}`), `第 ${module.index} 段短带必须随顶升走`);
    assert.ok(liftAxis.partIds.includes(`transfer-y-base-${module.index}`));
  }
  assert.ok(liftAxis.partIds.includes('transfer-lift-beam-x1'), '升降架随顶升走');
  assert.equal(liftAxis.partPickupGapMm?.['workpiece-plate'], 25,
    '拾取空行程 25：Y 带面静止位 825 比带面低 25，板要等带面贴上来才动');
  assert.deepEqual(pushAxis.axis, [0, 1, 0]);
  assert.equal(pushAxis.strokeMm, layout.pushStrokeMm);
  // 这一版移载没有平移机构：轴上只有工件（Y 短带转动搬料）
  assert.deepEqual(pushAxis.partIds, ['workpiece-plate'],
    `移载轴不该再带动任何机构件（上一版是推板 + 滑座）：${pushAxis.partIds.join(',')}`);
});

test('联锁⑦：四个信号存在且绑定正确，DO 是扩展点位，PLC 预检 blocked=0', () => {
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

test('护栏⑧：带宽 / 线长（2400~4000）/ 两端输送段 / 行程 / 互斥 都拒建并给数', () => {
  // 带宽不够：< 600 塞不下 3 条窄带 + 带缝
  assert.match(String(transferSkipReason({ ...LINE, widthMm: 500 })), /带宽 500 mm < 顶升移载所需最小 600 mm/);
  assert.equal(TRANSFER_MIN_WIDTH_MM, 600);
  assert.equal(transferLayout({ ...LINE, widthMm: 500 }), null);
  // 1200 宽是合法的
  assert.equal(transferSkipReason(LINE), null);
  // 线长区间：这一版构型把机台缩到 3000，区间 2400~4000
  assert.equal(TRANSFER_MIN_LENGTH_MM, 2400);
  assert.equal(TRANSFER_MAX_LENGTH_MM, 4000);
  assert.match(String(transferSkipReason({ ...LINE, lengthMm: 6000 })), /超出移载线参数区间 2400~4000 mm/);
  assert.match(String(transferSkipReason({ ...LINE, lengthMm: 6000 })), /这一版构型把机台从 6000 缩到 3000/);
  assert.match(String(transferSkipReason({ ...LINE, lengthMm: 2000 })), /超出移载线参数区间/);
  assert.equal(transferLayout({ ...LINE, lengthMm: 6000 }), null);
  // 区间内两端都合法
  assert.equal(transferSkipReason({ ...LINE, lengthMm: 2400 }), null);
  assert.equal(transferSkipReason({ ...LINE, lengthMm: 4000 }), null);
  // 两端输送段：单元 2×620 + 两端各 ≥300 → 最短 1840（先于区间报出来的是更具体的那条）
  const tooShort = { ...LINE, lengthMm: 1200 };
  assert.match(String(transferSkipReason(tooShort)), /放不下移载单元 \+ 两端输送段/);
  assert.match(String(transferSkipReason(tooShort)), /两端各剩 -20 mm < 300 mm/);
  assert.equal(transferLayout(tooShort), null);
  // 板宽超过带宽 → 压不住（先于其它护栏）
  assert.match(String(transferSkipReason({ ...LINE, transferPartWidthMm: 1300 })), /大于带宽/);
  // 板太小盖不住 Y 段 → 顶升后板会翘
  assert.match(String(transferSkipReason({ ...LINE, transferPartWidthMm: 300 })), /投影盖不住 Y 段/);
  assert.match(String(transferSkipReason({ ...LINE, transferPartLengthMm: 500 })), /投影盖不住 Y 段/);
  // 与转向互斥 / 立体缓存不加移载
  assert.match(String(transferSkipReason({ ...LINE, turnerAngleDeg: 90 })), /与顶升移载互斥/);
  assert.match(String(transferSkipReason({ ...LINE, layers: 3 })), /立体缓存/);
  // 没要求就没有理由；只给板宽（参数化生成器那条路）也算要移载
  const off = { ...LINE, transferPresent: false, transferPartWidthMm: 0, transferPartLengthMm: 0 };
  assert.equal(transferSkipReason(off), null);
  assert.equal(transferLayout(off), null);
  assert.equal(buildConveyorParts(off).some((part) => part.id.startsWith('transfer-')), false);
  assert.ok(transferLayout({ ...LINE, transferPresent: false, transferPartWidthMm: 800 }));

  // 拒建时 warning 必须带算式，不能静默退化成普通输送线
  const design = synthMachine({
    ...parseMachineBrief(BRIEF),
    conveyor: { lengthMm: 6000, widthMm: 1200, speedMps: null, layers: null, loadKg: null, turner: null }
  });
  assert.equal(design.config.stations.includes('移载工位'), false);
  assert.ok(design.warnings.some((text) => /需求要求顶升移载，但本方案不做：线体长 6000 mm 超出移载线参数区间/.test(text)),
    `拒建必须给数字理由，实际 warnings=${JSON.stringify(design.warnings)}`);
});

test('四态⑨：rest / lift / sweep / push 全部 confirmed=0 且待复核=0', () => {
  const result = runInterferenceStates({ states: ['rest', 'lift', 'sweep', 'push'], config: transferConfig() });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.geometrySource, 'conveyor-assembly');
  assert.equal(result.reviewStatus, 'pass');
  assert.equal(result.lift?.actuatorId, 'transfer-lift');
  assert.equal(result.lift?.strokeMm, LIFT_STROKE, 'lift 态按 config travelMm 平移（90）');
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
  // push 是**复合位姿 + 沿 +Y 扫掠**（先顶升、再逐点送出），不是「又顶了一次」
  const geometry = resolveMachineGeometry(transferConfig()).geometry;
  const liftPose = poseForState({ geometry, state: 'lift', lift: result.lift, push: result.push });
  assert.equal(result.states.lift.pairs, screenInterference(liftPose).count, 'lift 态应等于「只顶升」的位姿');
  assert.ok(result.states.push.samples >= 100, `push 必须逐点扫过 1180 行程（实际 ${result.states.push.samples} 点）`);
  assert.equal(result.states.push.samples, Math.round(layout.pushStrokeMm / 10) + 1);
  assert.equal(result.states.push.hitSamples, 0);
  assert.equal(result.states.push.worst, null);
  // 敏感性对照：把 Y 短带模块按 +Y 推出，必须撞到接料段 —— 证明 push 真的在动，不是复制位姿
  const wrongPose = shiftParts(liftPose, ['transfer-y-belt-1'], [0, 1, 0], result.push.strokeMm);
  const wrongHits = screenInterference(wrongPose).pairs.filter((pair) => pair.classification === 'suspect');
  assert.ok(wrongHits.length > 0,
    '把 Y 短带按 +Y 推出 1180 必须撞到接料段；撞不到说明 push 态根本没在平移');
});

test('多组参数⑩：不同带宽/板尺寸都过四态（不是只对 1200/800 这一组调出来的）', () => {
  const cases = [
    { lengthMm: 3000, widthMm: 1200, partLengthMm: 1200, partWidthMm: 800 },
    { lengthMm: 2400, widthMm: 1200, partLengthMm: 1200, partWidthMm: 800 },
    { lengthMm: 4000, widthMm: 1200, partLengthMm: 1200, partWidthMm: 800 },
    { lengthMm: 3000, widthMm: 1200, partLengthMm: 1500, partWidthMm: 900 },
    { lengthMm: 3000, widthMm: 1100, partLengthMm: 1100, partWidthMm: 700 },
    { lengthMm: 3000, widthMm: 1080, partLengthMm: 1000, partWidthMm: 700 }
  ];
  for (const item of cases) {
    const params = { ...LINE, ...item, transferPartLengthMm: item.partLengthMm, transferPartWidthMm: item.partWidthMm };
    assert.equal(transferSkipReason(params), null, `${item.widthMm}/${item.partWidthMm} 应可建`);
    const plan = transferLayout(params);
    assert.ok(plan, `${item.widthMm}/${item.partWidthMm} 缺 layout`);
    // 3 条带 + 4 段短带是常量，带宽只改变尺寸
    assert.equal(plan.beltCount, 3);
    assert.equal(plan.yBeltCount, 4);
    assert.ok(plan.yBeltLengthMm <= plan.beltGapMm);
    const config = {
      ...transferConfig(),
      conveyor: {
        lengthMm: item.lengthMm, widthMm: item.widthMm, transferPresent: true,
        transferPartLengthMm: item.partLengthMm, transferPartWidthMm: item.partWidthMm
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

test('BOM⑪：移载/接料关键件各自成行，数量按几何算，材质齐全', () => {
  const bom = conveyorBom(parts, {});
  const row = (name) => bom.find((entry) => entry.name === name);
  assert.ok(row('移载单元安装板'), '缺安装板行');
  assert.equal(row('移载顶升气缸')?.qty, 2);
  assert.equal(row('移载导向柱')?.qty, 4);
  assert.ok(row('移载升降架横梁'), '缺升降架横梁行');
  assert.equal(row('移载 Y 向短带上行程')?.qty, 4, '4 段短带归并成一行');
  assert.equal(row('移载 Y 向短带上行程')?.qty, layout.yBeltCount);
  assert.equal(row('移载 Y 向短带滚筒')?.qty, 8, '每段两端各一只');
  assert.equal(row('移载 Y 向短带同步轴')?.qty, 2);
  assert.equal(row('移载 Y 向短带驱动电机')?.qty, 2);
  assert.equal(row('接料段皮带')?.qty, 2, '接料段上行程 + 回程归并成一行（qty 2）');
  assert.equal(row('接料段挡边')?.qty, 2, '接料段两侧挡边');
  assert.equal(row('接料段纵梁')?.qty, 2);
  // 上一版的零件不能再出现在 BOM 里（构型换了，不是改名）
  for (const gone of ['移载辊道辊筒', '移载辊道轴承立柱', '移载推板', '移载无杆气缸', '移载随动台板']) {
    assert.equal(row(gone), undefined, `${gone} 属于上一版辊道+推板构型，这一版不该再有`);
  }
  // 每件都带 material 与 actuatorId（BOM/排错要能顺着件号找到机构）
  const unitIds = parts.filter((part) => part.id.startsWith('transfer-') || part.id.startsWith('dock-'));
  for (const part of unitIds) {
    assert.ok(['AL6063', 'Q235', 'PVC', 'STEEL45'].includes(part.material), `${part.id} 材质缺失：${part.material}`);
    assert.match(String(part.actuatorId), /^transfer-(lift|push|dock)$/, `${part.id} 缺 actuatorId`);
  }

  const design = synthMachine(parseMachineBrief(BRIEF));
  const names = design.bomDraft.items.map((item) => item.name).join('|');
  assert.match(names, /移载单元安装板/);
  assert.match(names, /移载顶升气缸 φ80×56（行程 90）/);
  assert.match(names, /移载 Y 向短带 280×100（4 段，PVC）/);
  assert.match(names, /下游接料段 1400×1020（带面 915）/);
  assert.match(names, /DO-TRANSFER-READY/);
});

test('零件数⑫：移载单元件数只随带宽/板尺寸变，线体加长只加横撑', () => {
  const unitIds = parts.filter((part) => part.id.startsWith('transfer-') || part.id.startsWith('dock-'));
  assert.equal(unitIds.length, 67, `移载单元 + 接料段件数应为 67，实际 ${unitIds.length}`);
  assert.equal(layout.yBeltCount * 7, 28, '4 段 × 7 件（带/回程/2 滚筒/底板/2 侧颊）');
  // 线体加长（区间内）：单元件数不变
  const longer = buildConveyorParts({ ...LINE, lengthMm: 4000 });
  const longerIds = longer.filter((part) => part.id.startsWith('transfer-') || part.id.startsWith('dock-'));
  assert.equal(longerIds.length, unitIds.length, '移载单元件数不该随线体长度变化');
  assert.ok(longer.length > parts.length, '线体加长只增加横撑');
  assert.ok(parts.length > plain.length, '移载机型零件数必须多于普通线');
  // 特征树合法（交给 build123d 内核前必须过）
  assert.deepEqual(validateFeatures(conveyorAssembly(parts)), []);
  // 包络：长度不变、+Y 侧多出接料段
  const [len, width, height] = conveyorEnvelope(parts);
  assert.equal(len, LINE.lengthMm, '移载单元在中段，不把线体拉长');
  assert.equal(len, conveyorEnvelope(plain)[0]);
  assert.ok(width > conveyorEnvelope(plain)[1] + 1000, `包络宽度 ${width} 应包含 +Y 接料段`);
  assert.ok(height >= 1000, `包络高度 ${height} 应覆盖接料段挡边/挡停（1036）`);
});

test('3D⑬：不同材质不同颜色（视口里能分出铝件 / Q235 / 45# 钢 / PVC）', () => {
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
});

test('动作时间⑭：顶升 2.6 s + 送料 4.3 s，节拍按工位封顶而不是按线速', () => {
  assert.equal(transferActionSeconds(60, 1180), 6.3, '纯函数口径不变：给 60 就按 60 算（2.0 + 4.3）');
  assert.equal(transferPushSeconds(1180), 4.3, '0.4 起停 + 1180/300');
  assert.equal(layout.liftSeconds, 2.6);
  assert.equal(layout.pushSeconds, 4.3);
  assert.equal(layout.actionSeconds, 6.9);
  const design = synthMachine(parseMachineBrief(BRIEF));
  assert.equal(design.cycle.slowestActionSeconds, 6.9);
  // 线速 0.2 m/s ÷ 间距 1200 = 10 件/分；移载 60/6.9 = 8.7 件/分 → 取小值
  assert.equal(design.cycle.throughputPerMin, 8.7);
  assert.match(design.cycle.bottleneck, /移载工位每件 6\.9 s/);
  assert.ok(design.assumptions.length <= 20, `assumptions ${design.assumptions.length} 条超过 20，方案卡会被裁`);
  assert.ok(design.assumptions.some((text) => /行程 1180 mm = 板宽\/2 400/.test(text)), '行程算式要写进 assumptions');
  assert.ok(design.assumptions.some((text) => /Y 短带/.test(text)), '构型要写进 assumptions');
});


// ——————————————————————————————————————————————————————————————
// 工件（板 1200×800×35）随动：板是**产品几何**的一部分，
// 四个位姿都由 runInterferenceStates 真跑，不靠测试注入盒子。
// ——————————————————————————————————————————————————————————————
const WORKPIECE = 'workpiece-plate';

test('工件随动⑮：板沿 +Y 全行程扫掠 0 命中，且每个位姿都「板在场」', () => {
  const result = runInterferenceStates({ states: ['push'], config: transferConfig() });
  assert.equal(result.ok, true);
  const push = result.states.push;
  assert.ok(push.samples >= 100, `push 只查了 ${push.samples} 点，扫不过全程`);
  assert.equal(push.confirmedHits, 0, `板在送出途中撞了：${JSON.stringify(push.items.slice(0, 4))}`);
  assert.equal(push.mm3Confirmed, 0);
  assert.equal(push.hitSamples, 0, `有命中的位姿 ${push.hitSamples} 个（${JSON.stringify(push.hitRange)}）`);
  assert.equal(push.worst, null);
  assert.equal(push.workpieceTouchingSamples, push.samples,
    `push 全程 ${push.samples} 个位姿里应有同样多的「板与机构贴面」（实际 ${push.workpieceTouchingSamples}）：板坐在 Y 带/接料段带上`);
  assert.equal(result.workpiece.pushTravelMm, 1180);
  // 负向对照：把 Y 短带模块整体抬高 40（模拟「静止位没让开」）→ rest 位板压在 Y 带上，必须报出来
  const geometry = resolveMachineGeometry(transferConfig()).geometry;
  const lifted = {
    ...geometry,
    parts: geometry.parts.map((part) => (part.id.startsWith('transfer-y-') && !part.id.startsWith('transfer-y-motor')
      ? { ...part, center: [part.center[0], part.center[1], part.center[2] + 40] }
      : part))
  };
  const broken = runInterferenceStates({ states: ['rest'], config: transferConfig(), geometry: lifted });
  assert.ok(broken.states.rest.confirmedHits > 0,
    'Y 带面抬到 865（高于带面 850）时板必须被判成压在 Y 带上 —— 这说明「静止位低 25」是被检查的，不是注释');
  assert.ok(broken.states.rest.mm3Confirmed > 1000,
    `实体重叠应 > 1000 mm³，实际 ${broken.states.rest.mm3Confirmed}`);
  assert.ok(broken.states.rest.items.some((item) => /workpiece-plate/.test(`${item.a}${item.b}`)),
    `命中必须落在工件上：${JSON.stringify(broken.states.rest.items.slice(0, 3))}`);
});
