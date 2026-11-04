// 参数化整机的**布局约束**护栏：4 种代表性配置的干涉归零 + 参数不足时拒建。
//
// 为什么单独一个文件：几何源统一到 85 件参数化整机之后，评审/三态干涉第一次真能看到
// 整机结构，于是浮出一批**真干涉**（旧代理体里根本没有这些零件，所以以前看不见）。
// 每一条都对应一个已定量的实体重叠，断言里写清修复前的数字，防止回归：
//   驱动电机 × 缓存立柱      224000 mm³（140×40×40，exact）
//   皮带 × 升降导柱          5026.5 mm³ ×4（π·20²·4，exact）
//   皮带 × 升降链条          480 mm³ ×4（10×12×4，exact）
//   托条 × 层内传动辊        18000 mm³ ×8（50×9×40，aabb）
//   滚筒 × 侧挡边            360 mm³ ×4（30×3×4，aabb，挡边下沿比带面低 4 mm）
//   吊柱 × 升降台板          4800 mm³ ×4（20×20×12，exact）
//   纵梁 × 转台盘           352000 mm³ ×2（880×8×50，aabb，φ880 盘 > 纵梁内宽）
// 口径：不改干涉阈值、不放宽断言；参数组合做不到时由 turnerSkipReason 拒建并给数字理由。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConveyorParts,
  DEFAULT_CONVEYOR,
  narrowBeltLayout,
  TURNER_MIN_WIDTH_MM,
  TURNER_TABLE_DIAMETER_MM,
  TURNER_TABLE_SIDE_CLEARANCE_MM,
  turnerLayout,
  turnerSkipReason
} from '../../src/machine/conveyor-assembly.ts';
import { partWorldBounds, resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';
const BASE_CONFIG = synthMachine(parseMachineBrief(PV_BRIEF)).config;

/** 4 种代表性配置（几何参数 + 是否有可顶升轴用于 lift/sweep） */
const CONFIGS = [
  { label: '6000×1200 带转向', conveyor: { lengthMm: 6000, widthMm: 1200, turnerAngleDeg: 90 }, lift: true },
  { label: '3000×600×3 层缓存', conveyor: { lengthMm: 3000, widthMm: 600, layers: 3, layerPitchMm: 400 }, lift: false },
  { label: '2500×400 转向窄线', conveyor: { lengthMm: 2500, widthMm: 400, turnerAngleDeg: 90 }, lift: false },
  { label: '2000×300 普通线', conveyor: { lengthMm: 2000, widthMm: 300 }, lift: false }
];

const partsOf = (conveyor) => buildConveyorParts(conveyor);
const geometryOf = (conveyor) => resolveMachineGeometry({ ...BASE_CONFIG, conveyor }).geometry;
const staticScreenOf = (conveyor) => screenInterference(geometryOf(conveyor));
const findPart = (conveyor, id) => partsOf(conveyor).find((part) => part.id === id);

/** 两件的外形盒重叠体积（与 interference.ts 同口径：任一向 ≤ 0.5 mm 视为贴面，不算重叠） */
function overlapMm3(a, b) {
  let volume = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const span = Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]);
    if (span <= 0.5) return 0;
    volume *= span;
  }
  return volume;
}

function overlapsMatching(conveyor, patternA, patternB) {
  const list = partsOf(conveyor).map((part) => ({ id: part.id, box: partWorldBounds(part) }));
  const hits = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const matched = (patternA.test(a.id) && patternB.test(b.id)) || (patternA.test(b.id) && patternB.test(a.id));
      if (!matched) continue;
      const volume = overlapMm3(a.box, b.box);
      if (volume > 0.5) hits.push(`${a.id} × ${b.id} = ${Math.round(volume)} mm³`);
    }
  }
  return hits;
}

test('4 种代表性配置：静态干涉 confirmed=0 且 screen=0（目标口径）', () => {
  for (const { label, conveyor } of CONFIGS) {
    const screen = staticScreenOf(conveyor);
    assert.equal(screen.confirmed, 0, `${label} 仍有确认干涉：${screen.pairs.filter((p) => p.classification === 'suspect').map((p) => `${p.a}×${p.b}`).join(', ')}`);
    assert.equal(screen.screen, 0, `${label} 仍有待复核项：${screen.pairs.filter((p) => p.classification === 'suspect').map((p) => `${p.a}×${p.b}`).join(', ')}`);
  }
});

test('6000×1200 带转向：rest / lift / sweep 三态 confirmed 与 screen 全 0', () => {
  const conveyor = CONFIGS[0].conveyor;
  const payload = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: { ...BASE_CONFIG, conveyor } });
  assert.equal(payload.ok, true);
  assert.equal(payload.geometrySource, 'conveyor-assembly');
  for (const name of ['rest', 'lift', 'sweep']) {
    const state = payload.states[name];
    assert.equal(state.confirmedHits, 0, `${name} 确认干涉必须为 0`);
    assert.equal(state.screenHits, 0, `${name} 待复核必须为 0`);
    assert.equal(state.poseValidity, 'valid', `${name} 位姿可信`);
  }
  assert.equal(payload.reviewStatus, 'pass');
});

test('缓存线：驱动电机让到立柱外侧（修复前 gearmotor × column-bl 224000 mm³）', () => {
  // 600 与 1200 两档都查：电机 Y 位按立柱反算，与带宽无关
  for (const widthMm of [600, 1200]) {
    const conveyor = { lengthMm: 3000, widthMm, layers: 3, layerPitchMm: 400 };
    assert.deepEqual(overlapsMatching(conveyor, /^gearmotor$/, /^column-/), [], `${widthMm} mm 宽：电机仍与缓存立柱重叠`);
    // 电机箱贴在立柱外侧 5 mm 安装面上，不是飞在外面
    const motor = partWorldBounds(findPart(conveyor, 'gearmotor'));
    const column = partWorldBounds(findPart(conveyor, 'column-bl'));
    const gap = Math.abs(motor.max[1]) - Math.abs(column.min[1]);
    assert.ok(gap >= 4.5 && gap <= 5.5, `${widthMm} mm 宽：电机与立柱的安装缝 ${gap} mm 应为 5 mm`);
  }
});

test('缓存线：升降导柱/链条完全在带面外侧（修复前皮带上行程/回程各 5026.5 + 480 mm³ ×2）', () => {
  const conveyor = { lengthMm: 3000, widthMm: 600, layers: 3, layerPitchMm: 400 };
  for (const pattern of [/^lift-post-/, /^lift-chain-/]) {
    assert.deepEqual(overlapsMatching(conveyor, pattern, /^belt-(top|return)/), [], `${pattern} 仍然穿带`);
    assert.deepEqual(overlapsMatching(conveyor, pattern, /^pulley-/), [], `${pattern} 仍然穿滚筒`);
  }
  // 导柱中心必须落在带宽之外（带宽 600 → ±300），否则整根柱必然穿带
  const post = findPart(conveyor, 'lift-post-left');
  assert.ok(Math.abs(post.transform.y) - 20 > 300, `导柱中心 y=${post.transform.y} 必须在带宽 ±300 之外`);
});

test('缓存线：层内传动辊落在两根托条之间（修复前 tray-rail × tray-roller 18000 mm³ ×8）', () => {
  const conveyor = { lengthMm: 3000, widthMm: 600, layers: 3, layerPitchMm: 400 };
  assert.deepEqual(overlapsMatching(conveyor, /^tray-rail-/, /^tray-roller-/), []);
  for (const layer of [2, 3]) {
    const rail = partWorldBounds(findPart(conveyor, `tray-rail-${layer}-left`));
    const roller = partWorldBounds(findPart(conveyor, `tray-roller-${layer}-in`));
    const gap = Math.abs(rail.min[1]) - roller.max[1];
    assert.ok(gap >= 4, `第 ${layer} 层：辊端到托条内侧只有 ${gap} mm，装配缝不足 4 mm`);
    // 辊面抬到托盘底面：托盘坐在辊上，辊不再从托条里穿过去
    const tray = partWorldBounds(findPart(conveyor, `tray-${layer}`));
    assert.ok(Math.abs(roller.max[2] - tray.min[2]) <= 0.51, `第 ${layer} 层：辊面 ${roller.max[2]} 应贴在托盘底面 ${tray.min[2]}`);
  }
});

test('侧挡边下沿不低于带面（修复前 pulley-drive/tail × guard-left/right 360 mm³ ×4）', () => {
  for (const { label, conveyor } of CONFIGS) {
    for (const id of ['guard-left', 'guard-right']) {
      const guard = partWorldBounds(findPart(conveyor, id));
      const beltFace = conveyor.beltHeightMm ?? DEFAULT_CONVEYOR.beltHeightMm;
      assert.ok(guard.min[2] >= beltFace + 1, `${label}：${id} 下沿 ${guard.min[2]} 必须 ≥ 带面 ${beltFace} + 1`);
    }
    assert.deepEqual(overlapsMatching(conveyor, /^guard-/, /^pulley-/), [], `${label}：挡边仍与滚筒重叠`);
    assert.deepEqual(overlapsMatching(conveyor, /^guard-/, /^belt-/), [], `${label}：挡边仍与皮带重叠`);
  }
});

test('带宽不足拒建转向工位：理由含数字且可执行（400 mm 宽）', () => {
  const conveyor = { lengthMm: 2500, widthMm: 400, turnerAngleDeg: 90 };
  const reason = turnerSkipReason(conveyor);
  assert.ok(reason, '400 mm 宽必须拒建转向工位');
  assert.match(reason, /带宽 400 mm/);
  assert.match(reason, new RegExp(`最小 ${TURNER_MIN_WIDTH_MM} mm`));
  assert.match(reason, /请把线体加宽到/);
  // 拒建 = 不建单元件，也不建窄带并联
  assert.equal(turnerLayout(conveyor), null);
  const parts = partsOf(conveyor);
  assert.equal(parts.some((part) => part.id.startsWith('turner-') || /^belt-\d+$/.test(part.id)), false, '拒建之后不许留半套转向件');
  // 拒建后的普通线体本身零干涉
  const screen = staticScreenOf(conveyor);
  assert.equal(screen.confirmed + screen.screen, 0);
});

test('最小带宽是硬边界：980 建、979 拒（差 1 mm 也不许悄悄出图）', () => {
  assert.equal(TURNER_MIN_WIDTH_MM, 980);
  const ok = { lengthMm: 2500, widthMm: 980, turnerAngleDeg: 90 };
  const denied = { ...ok, widthMm: 979 };
  assert.equal(turnerSkipReason(ok), null);
  const layout = turnerLayout(ok);
  assert.ok(layout, '980 mm 宽必须能建转向工位');
  assert.equal(layout.beltCount % 2, 0, '窄带条数必须偶数（4 折对称指位要求轴线上是带缝）');
  const reason = turnerSkipReason(denied);
  assert.ok(reason);
  assert.match(reason, /带宽 979 mm/);
  assert.match(reason, /980/);
  // 正好在边界上：三态也必须干净（尤其 lift —— 抬起来会横向扫过纵梁）
  const payload = runInterferenceStates({ states: ['rest', 'lift', 'sweep'], config: { ...BASE_CONFIG, conveyor: ok } });
  assert.equal(payload.ok, true);
  for (const name of ['rest', 'lift', 'sweep']) {
    assert.equal(payload.states[name].confirmedHits, 0, `${name} 在最小带宽上仍撞`);
    assert.equal(payload.states[name].screenHits, 0, `${name} 在最小带宽上仍有待复核项`);
  }
});

test('转台盘与纵梁留侧隙（修复前 rail-left/right × turner-table 352000 mm³ ×2）', () => {
  for (const widthMm of [980, 1200]) {
    const conveyor = { lengthMm: 6000, widthMm, turnerAngleDeg: 90 };
    const railInnerY = widthMm / 2 + 15;
    assert.ok(TURNER_TABLE_DIAMETER_MM / 2 + TURNER_TABLE_SIDE_CLEARANCE_MM <= railInnerY,
      `${widthMm} mm 宽：盘半径 + 侧隙 ${TURNER_TABLE_DIAMETER_MM / 2 + TURNER_TABLE_SIDE_CLEARANCE_MM} > 纵梁内侧面 ${railInnerY}`);
    assert.deepEqual(overlapsMatching(conveyor, /^rail-(left|right)$/, /^turner-(table|lift-plate)$/), []);
  }
});

test('吊柱在台板外轮廓之外（修复前 turner-hanger × turner-lift-plate 4800 mm³ ×4）', () => {
  for (const widthMm of [980, 1200]) {
    const conveyor = { lengthMm: 6000, widthMm, turnerAngleDeg: 90 };
    const layout = turnerLayout(conveyor);
    assert.ok(layout);
    assert.ok(layout.hangerCenterY - 10 >= layout.plateWidthMm / 2 + 4,
      `${widthMm} mm 宽：吊柱内侧面 ${layout.hangerCenterY - 10} 压进台板 ${layout.plateWidthMm / 2} 里`);
    assert.deepEqual(overlapsMatching(conveyor, /^turner-hanger-/, /^turner-(lift-plate|table)$/), []);
  }
});

test('顶升指全落在带缝里且 4 折对称（奇数条窄带会压住中间那条带）', () => {
  for (const widthMm of [980, 1200]) {
    const conveyor = { lengthMm: 6000, widthMm, turnerAngleDeg: 90 };
    const layout = turnerLayout(conveyor);
    const belts = narrowBeltLayout(conveyor);
    const halfFinger = layout.fingerWidthMm / 2;
    // 4 折闭合：任一指位转 90° 后仍在指位集合里，否则回落时必撞带
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const fingerSet = new Set(layout.fingerCenters.map(([x, y]) => key(x, y)));
    for (const [x, y] of layout.fingerCenters) {
      assert.ok(fingerSet.has(key(-y, x)), `${widthMm} mm 宽：指位 (${x}, ${y}) 转 90° 后不在集合里`);
      // 指垫不容许压在任何一条窄带的 y 区间上
      for (const center of belts.centers) {
        const beltLow = center - belts.widthMm / 2 - 0.5;
        const beltHigh = center + belts.widthMm / 2 + 0.5;
        assert.ok(y + halfFinger <= beltLow || y - halfFinger >= beltHigh,
          `${widthMm} mm 宽：指位 (${x}, ${y}) 压住了 y=${center} 的窄带`);
      }
    }
    assert.ok(layout.fingerCenters.length >= 5, `指位只有 ${layout.fingerCenters.length} 个，托不住板件`);
  }
});

test('不同带宽都建出「一址一指」：非整数节距不许叠出重复指位（修复前 244652 mm³ ×4）', () => {
  // 1100 mm 宽 6 条窄带 → 节距 183.333…，从两侧反算同一只指会差 1e-13；
  // 不去重就变成两只指压在一起（整台多出一倍的指垫，台板也装不下）。
  for (let widthMm = 980; widthMm <= 1200; widthMm += 20) {
    const conveyor = { lengthMm: 2000, widthMm, turnerAngleDeg: 90 };
    const layout = turnerLayout(conveyor);
    const keys = layout.fingerCenters.map(([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`);
    assert.equal(new Set(keys).size, keys.length, `${widthMm} mm 宽：出现重复指位 ${keys.join(' ')}`);
    assert.deepEqual(overlapsMatching(conveyor, /^turner-finger-/, /^turner-finger-/), [], `${widthMm} mm 宽：指与指自身重叠`);
    const screen = staticScreenOf(conveyor);
    assert.equal(screen.confirmed + screen.screen, 0, `${widthMm} mm 宽：仍有干涉`);
  }
});

test('没有可顶升轴的机型如实报 STATE_UNAVAILABLE（不拿静态位姿冒充 lift）', () => {
  for (const { label, conveyor, lift } of CONFIGS.filter((item) => !item.lift)) {
    const payload = runInterferenceStates({ states: ['rest', 'lift'], config: { ...BASE_CONFIG, conveyor } });
    assert.equal(payload.ok, false, `${label} 不该有可顶升轴`);
    assert.equal(payload.code, 'STATE_UNAVAILABLE');
    // rest 单独查仍然要过
    const rest = runInterferenceStates({ states: ['rest'], config: { ...BASE_CONFIG, conveyor } });
    assert.equal(rest.ok, true);
    assert.equal(rest.states.rest.confirmedHits, 0, `${label} rest 仍有确认干涉`);
  }
});
