import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptSuggestions,
  analyzeMeshShape,
  axisAngleDeg,
  batchGate,
  classifyName,
  describeSuggestions,
  directionPenalty,
  GEOMETRY_CONFIDENCE_CAP,
  GEOMETRY_UNQUANTIFIED_CAP,
  RESIDUAL_PENALTY_CAP,
  scorePointOption,
  snapAxis,
  stationOf,
  suggestKinematics,
  suggestionToMovingPart
} from '../../src/cad/kinematics-auto.ts';
import {
  deserializeAnnotation,
  partToAxis,
  pointOptionsFromMachineConfig,
  serializeAnnotation,
  validateDraft
} from '../../src/cad/kinematics-ui.ts';
import { axisDirectionVector, axisPose, checkKinematics } from '../../src/cad/kinematics.ts';
import { meshPathsFromRoot, parseOcctBuffer } from '../../src/cad/step.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../fixtures/kinematics-assembly.stp');

// ---------------------------------------------------------------- 合成网格夹具

let serial = 0;

function finish(name, positions, extra = {}) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return {
    id: extra.id ?? serial++,
    name,
    ...(extra.path ? { path: extra.path } : {}),
    center: min.map((value, k) => (value + max[k]) / 2),
    size: min.map((value, k) => max[k] - value),
    triangles: 12,
    positions: new Float32Array(positions)
  };
}

function boxMesh(name, min, max, extra) {
  const out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return finish(name, out, extra);
}

/** 沿任意方向 dir 的 16 棱柱（顶点只在两端圆周上）。 */
function prismMesh(name, start, dir, length, radius, extra) {
  const d = normalizeVec(dir);
  const helper = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalizeVec(crossVec(d, helper));
  const w = crossVec(d, u);
  const out = [];
  for (const t of [0, length]) {
    for (let i = 0; i < 16; i += 1) {
      const a = (2 * Math.PI * i) / 16;
      for (let k = 0; k < 3; k += 1) {
        out.push(start[k] + d[k] * t + radius * (Math.cos(a) * u[k] + Math.sin(a) * w[k]));
      }
    }
  }
  return finish(name, out, extra);
}

function normalizeVec(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function crossVec(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function cylinderPair({ names = ['CDJ2B16-50_body', 'CDJ2B16-50_rod'], dir = [0, -1, 0], origin = [0, 0, 0], body = 90, rod = 120, path, ids = [100, 101] } = {}) {
  return [
    prismMesh(names[0], origin, dir, body, 10, { id: ids[0], ...(path ? { path } : {}) }),
    prismMesh(names[1], origin, dir, rod, 4, { id: ids[1], ...(path ? { path } : {}) })
  ];
}

const CONFIG = {
  id: 'auto-kin',
  name: '自动识别测试机',
  stations: ['ST1', 'ST2', 'ST3'],
  sensors: [],
  actuators: [
    { id: 'a1', name: 'ST1 压装气缸', kind: 'cylinder', station: 'ST1', extendPoint: 'ST1-EXT-A1', retractPoint: 'ST1-RET-A1', travelMm: 50 },
    { id: 'a2', name: 'ST2 推料气缸', kind: 'cylinder', station: 'ST2', extendPoint: 'ST2-EXT-A1', retractPoint: 'ST2-RET-A1' },
    { id: 'a3', name: 'ST2 旋转台', kind: 'rotary', station: 'ST2', point: 'ST2-ROT-A1' },
    { id: 'a4', name: 'ST2 夹爪', kind: 'gripper', station: 'ST2', gripPoint: 'ST2-GRIP-A2' },
    { id: 'a5', name: 'ST3 顶升气缸', kind: 'cylinder', station: 'ST3', extendPoint: 'ST3-EXT-A2', retractPoint: 'ST3-RET-A2' }
  ]
};
const POINTS = pointOptionsFromMachineConfig(CONFIG);

function allSuggestions(result) {
  return [...result.suggestions, ...result.lowConfidence];
}

// ---------------------------------------------------------------- 名称 / 型号

test('名称识别：气缸型号解析缸径与行程（CDJ2 / MGPM / CQ2 / TN）', () => {
  const cdj = classifyName('CDJ2B16-50_rod');
  assert.equal(cdj.category, 'cylinder');
  assert.equal(cdj.role, 'rod');
  assert.equal(cdj.modelCode, 'CDJ2B16-50');
  assert.equal(cdj.bore, 16);
  assert.equal(cdj.strokeMm, 50);
  assert.equal(cdj.strokeSource, 'model-code');
  assert.equal(classifyName('MGPM20-50Z').strokeMm, 50);
  assert.equal(classifyName('MGPM20-50Z').bore, 20);
  assert.equal(classifyName('CQ2B32-25D 薄型气缸').strokeMm, 25);
  assert.equal(classifyName('亚德客 TN16X50-S').strokeMm, 50);
});

test('名称识别：中文/英文关键词与件角色，无型号时行程为空', () => {
  const cn = classifyName('顶升气缸_活塞杆');
  assert.equal(cn.category, 'cylinder');
  assert.equal(cn.role, 'rod');
  assert.equal(cn.strokeMm, null);
  const en = classifyName('Lift Cylinder body');
  assert.equal(en.category, 'cylinder');
  assert.equal(en.role, 'body');
  assert.equal(classifyName('气缸1 行程75').strokeMm, 75);
  assert.equal(classifyName('支架').category, null);
});

test('名称识别：手指气缸/旋转气缸不会被误判为直线气缸', () => {
  assert.equal(classifyName('手指气缸 MHZ2-16D').category, 'gripper');
  assert.equal(classifyName('旋转气缸').category, 'rotary');
  assert.equal(classifyName('气动滑台 MXQ12-30').category, 'slide');
});

test('名称识别：滑台 MXQ 行程、夹爪 MHZ2 样本表单指行程', () => {
  const slide = classifyName('MXQ12-30_table');
  assert.equal(slide.category, 'slide');
  assert.equal(slide.role, 'table');
  assert.equal(slide.strokeMm, 30);
  const grip = classifyName('MHZ2-16D');
  assert.equal(grip.category, 'gripper');
  assert.equal(grip.modelCode, 'MHZ2-16D');
  assert.equal(grip.strokeMm, 3);
  assert.equal(grip.strokeSource, 'catalog');
  assert.equal(classifyName('MHZ2-25D2').strokeMm, 7);
  assert.equal(classifyName('Gripper').category, 'gripper');
  assert.equal(classifyName('finger_L').role, 'finger');
});

test('名称识别：旋转台 MSQ 按 180°、CRB 取型号角度', () => {
  const msq = classifyName('MSQB20A_table');
  assert.equal(msq.category, 'rotary');
  assert.equal(msq.rangeDeg, 180);
  assert.equal(msq.strokeSource, 'catalog');
  const crb = classifyName('CRB1BW50-90S');
  assert.equal(crb.category, 'rotary');
  assert.equal(crb.rangeDeg, 90);
  assert.equal(classifyName('分度转台 270度').rangeDeg, 270);
});

test('名称识别：导轨/滑块共用系列号，导轨长度取自 L 尾缀；丝杆、伺服电机', () => {
  const rail = classifyName('ST1_RAIL_MGN12_L300');
  const block = classifyName('ST1_CARRIAGE_MGN12H');
  assert.equal(rail.category, 'rail');
  assert.equal(rail.role, 'rail');
  assert.equal(rail.railLengthMm, 300);
  assert.equal(block.role, 'carriage');
  assert.equal(rail.seriesKey, block.seriesKey);
  assert.equal(classifyName('HGR20-L500 导轨').railLengthMm, 500);
  assert.equal(classifyName('滚珠丝杆 SFU1605').category, 'ballscrew');
  assert.equal(classifyName('SFU1605_nut').role, 'nut');
  assert.equal(classifyName('伺服电机_400W').category, 'motor');
  assert.equal(classifyName('Servo Motor').category, 'motor');
});

test('工位号：ST1 / 工位2 / station3', () => {
  assert.equal(stationOf('KIN / ST1_PRESS'), 'ST1');
  assert.equal(stationOf('工位 2 夹爪'), 'ST2');
  assert.equal(stationOf('Station-3 lift'), 'ST3');
  assert.equal(stationOf('BASE'), '');
});

// ---------------------------------------------------------------- 几何

test('几何：棱柱最长轴、细长度与回转体判断；长方体不是回转体', () => {
  const rod = prismMesh('rod', [0, 0, 0], [0, 0, 1], 100, 5);
  const shape = analyzeMeshShape(rod);
  assert.equal(shape.source, 'vertices');
  assert.ok(axisAngleDeg(shape.axes[0], [0, 0, 1]) < 0.5);
  assert.ok(shape.elongation > 9);
  assert.equal(shape.round, true);
  assert.ok(Math.abs(shape.radius - 5) < 0.01);
  const plate = analyzeMeshShape(boxMesh('plate', [0, 0, 0], [100, 40, 10]));
  assert.equal(plate.round, false);
  assert.ok(axisAngleDeg(plate.axes[0], [1, 0, 0]) < 0.5);
  assert.ok(axisAngleDeg(plate.axes[2], [0, 0, 1]) < 0.5);
});

test('几何：圆盘的最短轴为面法向；无顶点时退回包围盒', () => {
  const disk = analyzeMeshShape(prismMesh('disk', [0, 0, 0], [0, 1, 0], 6, 30));
  assert.ok(disk.flatness < 0.3);
  assert.ok(axisAngleDeg(disk.axes[2], [0, 1, 0]) < 0.5);
  assert.equal(disk.round, true);
  const bbox = analyzeMeshShape({ center: [0, 0, 0], size: [10, 200, 20], positions: null });
  assert.equal(bbox.source, 'bbox');
  assert.deepEqual(bbox.axes[0], [0, 1, 0]);
  assert.equal(bbox.extents[0], 200);
});

test('方向：最近主轴、正负号、偏角与水平偏角', () => {
  const straight = snapAxis([0, -1, 0]);
  assert.equal(straight.axis, 'y');
  assert.equal(straight.direction, -1);
  assert.equal(straight.offAxisDeg, 0);
  assert.equal(straight.yawDeg, 0);
  assert.equal(straight.residualDeg, 0);
  const tilted = snapAxis([Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0]);
  assert.equal(tilted.axis, 'x');
  assert.equal(tilted.direction, 1);
  assert.equal(tilted.offAxisDeg, 30);
  // 水平面内的 30° 可以精确标注：yaw 存 30，残余倾角 0
  assert.equal(tilted.yawDeg, 30);
  assert.equal(tilted.residualDeg, 0);
});

// ---------------------------------------------------------------- 机构启发式

test('气缸：活塞杆与缸体同轴 → 沿缸轴直线，伸出方向取外露侧，行程取型号', () => {
  const result = suggestKinematics(cylinderPair({ dir: [0, -1, 0] }));
  assert.equal(result.suggestions.length, 1);
  const s = result.suggestions[0];
  assert.equal(s.category, 'cylinder');
  assert.equal(s.kind, 'linear');
  assert.equal(s.axis, 'y');
  assert.equal(s.direction, -1);
  assert.deepEqual(s.directionVector, [0, -1, 0]);
  assert.equal(s.travelMm, 50);
  assert.equal(s.retractedMm, 0);
  assert.equal(s.strokeSource, 'model-code');
  assert.deepEqual(s.meshNames, ['CDJ2B16-50_rod']);
  assert.deepEqual(s.fixedMeshIds, [100]);
  assert.ok(s.confidence >= 0.8);
  assert.match(s.reason, /同轴/);
  assert.match(s.reason, /行程 50 mm 取自型号/);
});

test('气缸：无型号时按几何估算标准行程，并说明需核对', () => {
  const result = suggestKinematics(cylinderPair({ names: ['顶升气缸_缸体', '顶升气缸_活塞杆'], dir: [0, 0, 1], body: 80, rod: 100 }));
  const s = allSuggestions(result)[0];
  assert.equal(s.axis, 'z');
  assert.equal(s.direction, 1);
  assert.equal(s.strokeSource, 'geometry');
  // 缸内长度 80 − 0.1×80 = 72 → 最近标准行程 75
  assert.equal(s.travelMm, 75);
  assert.match(s.reason, /几何估算/);
});

test('气缸：活塞杆外露 ≥ 行程 80% 时提示模型可能处于伸出状态并降低置信度', () => {
  const normal = suggestKinematics(cylinderPair({ rod: 120 })).suggestions[0];
  const extended = allSuggestions(suggestKinematics(cylinderPair({ rod: 140 })))[0];
  assert.match(extended.reason, /可能处于伸出状态/);
  assert.ok(extended.confidence < normal.confidence);
});

test('气缸：活塞杆与缸体不同轴时降为低置信度', () => {
  const body = prismMesh('CDJ2B16-50_body', [0, 0, 0], [1, 0, 0], 90, 10, { id: 1 });
  const rod = prismMesh('CDJ2B16-50_rod', [0, 40, 0], [1, 0, 0], 120, 4, { id: 2 });
  const result = suggestKinematics([body, rod]);
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.lowConfidence.length, 1);
  assert.match(result.lowConfidence[0].reason, /不同轴/);
});

test('方向水平偏 30°：保留真实方向向量，并把偏角存成 yawDeg（不再压成单一主轴）', () => {
  const dir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
  const straight = suggestKinematics(cylinderPair({ dir: [1, 0, 0] })).suggestions[0];
  const tilted = allSuggestions(suggestKinematics(cylinderPair({ dir })))[0];
  assert.equal(tilted.axis, 'x');
  assert.equal(tilted.offAxisDeg, 30);
  // 水平面内的偏角是可标注的：写进 yawDeg，残余倾角 0 → 不再扣分
  assert.equal(tilted.yawDeg, 30);
  assert.equal(tilted.residualDeg, 0);
  assert.ok(Math.abs(tilted.directionVector[1] - 0.5) < 0.01);
  assert.match(tilted.reason, /yawDeg=30°/);
  assert.equal(tilted.confidence, straight.confidence);
});

test('方向偏出水平面 45°：yaw 救不了，按残余倾角扣分且不进高置信度', () => {
  // 45° 斜向：(1,0,1)/√2，绕 Z 的 yaw 无法表达，残差 45°
  const dir = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const tilted = allSuggestions(suggestKinematics(cylinderPair({ dir })))[0];
  assert.equal(tilted.yawDeg, 0);
  assert.equal(tilted.residualDeg, 45);
  assert.ok(tilted.confidence < 0.7, `45° 残差应被扣到 0.7 以下，实际 ${tilted.confidence}`);
  assert.match(tilted.reason, /残差|超出标注层/);
});

test('装配层级：通用件名 body/rod 继承父装配的类别、型号行程、工位与编号', () => {
  const path = ['MACHINE', 'ST3_LIFT_A2_MGPM20-50'];
  const result = suggestKinematics(cylinderPair({ names: ['body', 'rod'], dir: [0, 0, 1], path }), { pointOptions: POINTS });
  const s = result.suggestions[0];
  assert.equal(s.category, 'cylinder');
  assert.equal(s.travelMm, 50);
  assert.equal(s.station, 'ST3');
  assert.equal(s.point, 'ST3-EXT-A2');
  assert.match(s.reason, /父装配含型号 MGPM20-50/);
  assert.match(s.reason, /编号 A2 一致/);
});

test('导轨 + 滑块：沿导轨长轴直线运动，行程 = 导轨长 − 滑块长，方向朝远端', () => {
  const rail = boxMesh('HGR20_rail', [0, 0, 0], [20, 500, 18], { id: 1 });
  const block = boxMesh('HGH20CA_carriage', [-12, 440, 18], [32, 500, 30], { id: 2 });
  const result = suggestKinematics([rail, block]);
  const s = allSuggestions(result)[0];
  assert.equal(s.category, 'rail');
  assert.equal(s.axis, 'y');
  assert.equal(s.direction, -1);
  assert.equal(s.travelMm, 440);
  assert.deepEqual(s.meshIds, [2]);
  assert.deepEqual(s.fixedMeshIds, [1]);
  assert.match(s.reason, /骑在导轨上/);
});

test('导轨没有滑块：不出建议，进入跳过列表并说明原因', () => {
  const result = suggestKinematics([boxMesh('ST1_RAIL_MGN12_L300', [0, 0, 0], [12, 300, 8], { id: 1 })]);
  assert.equal(allSuggestions(result).length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /没有找到滑块/);
});

test('丝杆 + 螺母：沿丝杆轴线运动', () => {
  const screw = prismMesh('SFU1605_screw', [0, 0, 50], [1, 0, 0], 400, 8, { id: 1 });
  const nut = prismMesh('SFU1605_nut', [20, 0, 50], [1, 0, 0], 40, 14, { id: 2 });
  const s = allSuggestions(suggestKinematics([screw, nut]))[0];
  assert.equal(s.category, 'ballscrew');
  assert.equal(s.axis, 'x');
  assert.equal(s.direction, 1);
  assert.equal(s.travelMm, 340);
});

test('旋转台：转轴取台面法向，MSQ 角度 180°', () => {
  const body = boxMesh('MSQB20A_body', [0, 0, 0], [60, 60, 30], { id: 1 });
  const table = prismMesh('MSQB20A_table', [30, 30, 30], [0, 0, 1], 8, 25, { id: 2 });
  const s = suggestKinematics([body, table]).suggestions[0];
  assert.equal(s.kind, 'rotary');
  assert.equal(s.axis, 'z');
  assert.equal(s.direction, 1);
  assert.equal(s.rangeDeg, 180);
  assert.equal(s.travelMm, 0);
  assert.deepEqual(s.meshIds, [2]);
  assert.match(s.reason, /法向/);
});

test('滑台：台面沿本体长轴运动，行程取型号', () => {
  const body = boxMesh('MXQ12-30_body', [0, 0, 0], [80, 30, 20], { id: 1 });
  const table = boxMesh('MXQ12-30_table', [10, 0, 20], [60, 30, 28], { id: 2 });
  const s = allSuggestions(suggestKinematics([body, table]))[0];
  assert.equal(s.category, 'slide');
  assert.equal(s.axis, 'x');
  assert.equal(s.travelMm, 30);
  assert.deepEqual(s.meshIds, [2]);
});

test('夹爪：通用名手指按同组相邻归入夹爪，一指向另一指夹紧，单指行程取样本表', () => {
  const path = ['M', 'ST2_PICK'];
  const meshes = [
    boxMesh('MHZ2-16D_body', [500, 0, 0], [530, 20, 40], { id: 1, path }),
    boxMesh('finger_L', [502, 5, 40], [508, 15, 60], { id: 2, path }),
    boxMesh('finger_R', [522, 5, 40], [528, 15, 60], { id: 3, path })
  ];
  const s = suggestKinematics(meshes).suggestions[0];
  assert.equal(s.category, 'gripper');
  assert.deepEqual(s.meshNames, ['finger_L']);
  assert.equal(s.axis, 'x');
  assert.equal(s.direction, 1);
  assert.equal(s.travelMm, 3);
  assert.match(s.reason, /对侧手指「finger_R」需另行标注/);
});

test('夹爪只有一个网格：跳过并说明手指未拆分', () => {
  const result = suggestKinematics([boxMesh('夹爪 MHZ2-20D', [0, 0, 0], [30, 20, 50], { id: 1 })]);
  assert.equal(allSuggestions(result).length, 0);
  assert.match(result.skipped[0].reason, /手指未拆分/);
});

test('伺服电机：只出低置信度旋转建议，与高置信度分开', () => {
  const meshes = [...cylinderPair(), prismMesh('伺服电机_400W', [300, 0, 0], [0, 0, 1], 80, 20, { id: 7 })];
  const result = suggestKinematics(meshes);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.lowConfidence.length, 1);
  const motor = result.lowConfidence[0];
  assert.equal(motor.category, 'motor');
  assert.equal(motor.level, 'low');
  assert.equal(motor.kind, 'rotary');
  assert.equal(motor.axis, 'z');
  assert.match(motor.reason, /仅供参考/);
  // 提高阈值后气缸也进入低置信度
  const strict = suggestKinematics(meshes, { minConfidence: 0.95 });
  assert.equal(strict.suggestions.length, 0);
  assert.equal(strict.lowConfidence.length, 2);
});

// ---------------------------------------------------------------- IO 点位

test('点位匹配：按工位/类型选 ST1-EXT-A1，不推荐 retract 角色与类型不符的点位', () => {
  const path = ['M', 'ST1_PRESS'];
  const s = suggestKinematics(cylinderPair({ path }), { pointOptions: POINTS }).suggestions[0];
  assert.equal(s.point, 'ST1-EXT-A1');
  assert.equal(s.role, 'extend');
  assert.ok(s.pointCandidates.every((candidate) => candidate.role === 'extend'));
  assert.ok(s.pointCandidates.every((candidate) => !/GRIP|ROT/.test(candidate.point)));
  assert.match(s.reason, /建议绑定点位 ST1-EXT-A1（类型一致、工位 ST1 一致/);
});

test('点位匹配：评分函数对工位不一致扣分、旋转只配 rotate 角色', () => {
  const ctx = { category: 'cylinder', kind: 'linear', station: 'ST1', index: '', text: 'ST1 气缸', modelCode: '' };
  const st1 = scorePointOption(ctx, POINTS.find((option) => option.point === 'ST1-EXT-A1'));
  const st2 = scorePointOption(ctx, POINTS.find((option) => option.point === 'ST2-EXT-A1'));
  assert.ok(st1.score > st2.score);
  assert.match(st2.reason, /工位不一致/);
  assert.equal(scorePointOption(ctx, POINTS.find((option) => option.point === 'ST2-ROT-A1')), null);
  const rot = { ...ctx, category: 'rotary', kind: 'rotary', station: 'ST2' };
  assert.equal(scorePointOption(rot, POINTS.find((option) => option.point === 'ST2-ROT-A1')).role, 'rotate');
});

test('点位匹配：已被现有动件占用的点位不再推荐；两条建议不会抢同一点位', () => {
  const path = ['M', 'ST1_PRESS'];
  const existing = [{ id: 'mp-x', name: '已有', meshIds: [999], meshNames: [], center: [0, 0, 0], size: [0, 0, 0], kind: 'linear', axis: 'x', direction: 1, travelMm: 10, retractedMm: 0, rangeDeg: 0, retractedDeg: 0, point: 'ST1-EXT-A1', role: 'extend' }];
  const taken = suggestKinematics(cylinderPair({ path }), { pointOptions: POINTS, existingParts: existing }).suggestions[0];
  assert.notEqual(taken.point, 'ST1-EXT-A1');
  const two = suggestKinematics(
    [...cylinderPair({ path }), ...cylinderPair({ path, names: ['CQ2B32-25_body', 'CQ2B32-25_rod'], origin: [200, 0, 0], ids: [200, 201] })],
    { pointOptions: POINTS }
  );
  const points = allSuggestions(two).map((item) => item.point).filter(Boolean);
  assert.equal(new Set(points).size, points.length);
  assert.ok(points.includes('ST1-EXT-A1'));
});

test('没有 IO 表时不编造点位，理由里提示需加载机型配置', () => {
  const s = suggestKinematics(cylinderPair()).suggestions[0];
  assert.equal(s.point, '');
  assert.equal(s.role, '');
  assert.match(s.reason, /没有 IO 点位表/);
});

// ---------------------------------------------------------------- 确认与复用

test('不自动应用：识别不修改入参，已标注网格跳过；采纳只处理显式 id', () => {
  const meshes = cylinderPair({ path: ['M', 'ST1_PRESS'] });
  const before = JSON.stringify(meshes.map(({ positions, ...rest }) => rest));
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  assert.equal(JSON.stringify(meshes.map(({ positions, ...rest }) => rest)), before);
  const none = acceptSuggestions([], result.suggestions, [], meshes, { pointOptions: POINTS });
  assert.equal(none.parts.length, 0);
  const missing = acceptSuggestions([], result.suggestions, ['sg-404'], meshes, { pointOptions: POINTS });
  assert.deepEqual(missing.missing, ['sg-404']);
  assert.equal(missing.parts.length, 0);
  const accepted = acceptSuggestions([], result.suggestions, [result.suggestions[0].id], meshes, { pointOptions: POINTS });
  assert.equal(accepted.parts.length, 1);
  assert.equal(accepted.validation.ok, true);
  const again = suggestKinematics(meshes, { pointOptions: POINTS, existingParts: accepted.parts });
  assert.equal(allSuggestions(again).length, 0);
  assert.match(again.skipped[0].reason, /已在现有动件中/);
});

test('复用标注 schema：建议 → MovingPart 经 validateDraft / checkKinematics / JSON 往返一致', () => {
  const meshes = cylinderPair({ path: ['M', 'ST1_PRESS'] });
  const s = suggestKinematics(meshes, { pointOptions: POINTS }).suggestions[0];
  const part = suggestionToMovingPart(s, meshes);
  assert.deepEqual(part.meshIds, [101]);
  assert.equal(part.axis, 'y');
  assert.equal(part.direction, -1);
  assert.equal(part.travelMm, 50);
  assert.equal(part.point, 'ST1-EXT-A1');
  assert.equal(part.role, 'extend');
  const validation = validateDraft([part], { pointOptions: POINTS, meshes });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const check = checkKinematics({ schemaVersion: 1, units: 'mm', axes: [partToAxis(part)] }, { knownPoints: POINTS.map((p) => p.point) });
  assert.equal(check.ok, true);
  const round = deserializeAnnotation(serializeAnnotation({ version: 1, sourceFile: 'a.stp', parts: [part] }));
  assert.equal(round.ok, true);
  assert.deepEqual(round.annotation.parts[0].meshIds, [101]);
});

test('未匹配点位或行程待填的建议采纳后由现有校验拦截（不放宽规则）', () => {
  const meshes = [
    boxMesh('MHZ2-16D_body', [0, 0, 0], [30, 20, 40], { id: 1 }),
    boxMesh('jaw_A', [2, 5, 40], [8, 15, 60], { id: 2 }),
    boxMesh('jaw_B', [22, 5, 40], [28, 15, 60], { id: 3 })
  ];
  const result = suggestKinematics(meshes);
  const accepted = acceptSuggestions([], allSuggestions(result), allSuggestions(result).map((item) => item.id), meshes, { pointOptions: POINTS });
  assert.equal(accepted.validation.ok, false);
  assert.ok(accepted.validation.errors.some((issue) => issue.code === 'axis.bindings.empty'));
});

test('确定性：同一输入两次识别结果完全一致；概要中文', () => {
  const meshes = cylinderPair({ path: ['M', 'ST1_PRESS'] });
  const a = suggestKinematics(meshes, { pointOptions: POINTS });
  const b = suggestKinematics(meshes, { pointOptions: POINTS });
  assert.deepEqual(a, b);
  assert.match(describeSuggestions(a), /1 条高置信度.*需逐条确认/);
  assert.match(describeSuggestions(suggestKinematics([])), /未识别到动件/);
});

test('装配路径：occt 树 → 每个网格的父节点路径（跳过空名与同名叶子）', () => {
  const root = {
    name: '',
    meshes: [],
    children: [
      {
        name: 'MACHINE',
        meshes: [],
        children: [
          { name: 'ST1_PRESS', meshes: [0, 1], children: [] },
          { name: 'BASE', meshes: [2], children: [] }
        ]
      }
    ]
  };
  const paths = meshPathsFromRoot(root, ['body', 'rod', 'BASE', 'orphan']);
  assert.deepEqual(paths[0], ['MACHINE', 'ST1_PRESS']);
  assert.deepEqual(paths[2], ['MACHINE']);
  assert.equal(paths[3], undefined);
  assert.deepEqual(meshPathsFromRoot(undefined, ['a']), [undefined]);
});

// ---------------------------------------------------------------- 几何推断（无型号 / 通用件名）
//
// R1 场景：零件名只有通用词（「工位1气缸1 缸体」「工位1夹爪2 夹指左」）或干脆是 Part1 / Solid1，
// 没有型号、没有子装配层级。旧实现按名称主干分组，同一支气缸的缸体与活塞杆被拆成两条单件聚类，
// 全部报「气缸只有一个网格」→ 基线 ≥0.6 档严格正确 0/31。下面覆盖几何归组与置信度封顶。

test('几何归组：通用件名（缸体 / 活塞杆 / 压头 名字各异）仍归成同一支气缸，缸体保持固定', () => {
  const path = ['MACHINE', 'ST1'];
  const meshes = [
    prismMesh('工位1气缸1 缸体 Ø32×40', [0, 0, 0], [0, 0, 1], 110, 20, { id: 1, path }),
    prismMesh('工位1气缸1 活塞杆', [0, 0, -25], [0, 0, 1], 75, 6, { id: 2, path }),
    boxMesh('工位1气缸1 压头', [-16, -16, -39], [16, 16, -25], { id: 3, path }),
    // 治具离活塞杆很远（贴着工件），不能被算成随动件
    boxMesh('工位1气缸1 治具', [-35, -35, -190], [35, 35, -160], { id: 4, path })
  ];
  const result = suggestKinematics(meshes);
  const cylinders = allSuggestions(result).filter((item) => item.category === 'cylinder');
  assert.equal(cylinders.length, 1, '缸体与活塞杆应合成一条建议，而不是各出一条');
  const s = cylinders[0];
  assert.equal(s.inferredBy, 'geometry');
  assert.deepEqual([s.axis, s.direction], ['z', -1]);
  assert.equal(s.strokeSource, 'geometry');
  assert.equal(s.travelMm, 40);
  assert.deepEqual([...s.meshIds].sort(), [2, 3], '随动件 = 活塞杆 + 压头');
  assert.deepEqual(s.fixedMeshIds, [1], '缸体是固定件，不能被写成动件');
  assert.ok(!s.meshIds.includes(4), '治具不在杆端，不能随杆动');
  assert.ok(s.confidence <= GEOMETRY_CONFIDENCE_CAP);
  assert.match(s.reason, /同轴/);
  assert.match(s.reason, /贴在活塞杆端部/);
});

test('只有几何信息（Part1 / Solid1，无任何名称）也能认出气缸，并标注为几何来源', () => {
  const meshes = [
    prismMesh('Part1', [0, 0, 0], [0, 0, 1], 110, 20, { id: 1 }),
    prismMesh('Solid2', [0, 0, -25], [0, 0, 1], 75, 6, { id: 2 })
  ];
  const s = allSuggestions(suggestKinematics(meshes))[0];
  assert.ok(s, '纯几何条件下应至少出一条建议');
  assert.equal(s.category, 'cylinder');
  assert.equal(s.inferredBy, 'geometry');
  assert.equal(s.travelMm, 40);
  assert.match(s.reason, /无任何名称信息/);
});

test('几何推断不抢型号场景：带型号的气缸仍走型号档，行程与置信度都不降', () => {
  const result = suggestKinematics(cylinderPair({ names: ['CDJ2B16-50_body', 'CDJ2B16-50_rod'] }));
  assert.equal(result.suggestions.length, 1);
  const s = result.suggestions[0];
  assert.equal(s.inferredBy, 'model');
  assert.equal(s.travelMm, 50);
  assert.equal(s.strokeSource, 'model-code');
  assert.ok(s.confidence >= 0.8);
  assert.equal(batchGate(s).ok, true, batchGate(s).reason);
});

test('几何推断的置信度必须低于型号档，且过不了批量采纳门槛', () => {
  const model = suggestKinematics(cylinderPair({ names: ['CDJ2B16-50_body', 'CDJ2B16-50_rod'] })).suggestions[0];
  const geo = allSuggestions(suggestKinematics(cylinderPair({ names: ['Part1', 'Solid2'] })))[0];
  assert.equal(geo.inferredBy, 'geometry');
  assert.ok(geo.confidence <= GEOMETRY_CONFIDENCE_CAP, `几何上限 ${GEOMETRY_CONFIDENCE_CAP}，实际 ${geo.confidence}`);
  assert.ok(geo.confidence < model.confidence);
  const gate = batchGate(geo);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /低于批量门槛/);
});

test('夹爪：名字只写「夹爪」时按镜像两指归组，名称里的「行程 6」折半为单指 3 mm', () => {
  const path = ['MACHINE', 'ST2'];
  const meshes = [
    boxMesh('工位2夹爪2 本体（行程 6）', [23, 500, 1126], [87, 540, 1182], { id: 1, path }),
    boxMesh('工位2夹爪2 左块', [30, 508, 1086], [42, 532, 1126], { id: 2, path }),
    boxMesh('工位2夹爪2 右块', [68, 508, 1086], [80, 532, 1126], { id: 3, path }),
    boxMesh('工位2夹爪2 安装块', [20, 495, 1182], [90, 545, 1202], { id: 4, path })
  ];
  const s = allSuggestions(suggestKinematics(meshes)).find((item) => item.category === 'gripper');
  assert.ok(s, '应识别出夹爪');
  assert.equal(s.inferredBy, 'geometry');
  assert.equal(s.axis, 'x');
  assert.equal(s.travelMm, 3, '开闭总行程 6 mm → 单指 3 mm');
  assert.match(s.reason, /折半/);
  assert.match(s.reason, /镜像对称/);
  assert.deepEqual(s.fixedMeshIds, [1], '本体固定，只有一根手指被写成动件');
});

test('旋转台：薄台面贴底座识别为转轴、台面治具随动；角度只能预填时压到低置信度', () => {
  const path = ['MACHINE', 'ST1'];
  const meshes = [
    prismMesh('工位1旋转轴1 底座', [0, 0, 0], [0, 0, 1], 40, 55, { id: 1, path }),
    prismMesh('工位1旋转轴1 台面 Ø140', [0, 0, 40], [0, 0, 1], 12, 70, { id: 2, path }),
    boxMesh('工位1旋转轴1 治具', [10, -15, 52], [70, 15, 82], { id: 3, path })
  ];
  const s = allSuggestions(suggestKinematics(meshes)).find((item) => item.category === 'rotary');
  assert.ok(s, '应识别出旋转台');
  assert.equal(s.axis, 'z');
  assert.deepEqual([...s.meshIds].sort(), [2, 3], '台面 + 台面上的治具一起转');
  assert.deepEqual(s.fixedMeshIds, [1], '底座是固定件');
  assert.equal(s.inferredBy, 'geometry');
  assert.equal(s.confidence, GEOMETRY_UNQUANTIFIED_CAP);
  assert.equal(s.level, 'low');
});

test('转盘没有贴合底座时，不把 100 mm 外的机架台面写进动件', () => {
  const path = ['MACHINE', 'ST0'];
  const meshes = [
    boxMesh('机架台面 680×1460×20', [-340, -730, -20], [340, 730, 0], { id: 1, path }),
    prismMesh('分度转盘 Ø560×20', [0, 0, 113], [0, 0, 1], 20, 280, { id: 2 }),
    boxMesh('转盘治具 1', [-35, -35, 133], [35, 35, 163], { id: 3 })
  ];
  const result = suggestKinematics(meshes);
  const touchingFrame = allSuggestions(result).filter((item) => item.meshIds.includes(1));
  assert.equal(touchingFrame.length, 0, '机架台面不能被当成转盘本体或随动件');
  const dial = allSuggestions(result).filter((item) => item.meshIds.includes(2));
  assert.ok(dial.length > 0, '转盘本身仍应出现在建议/跳过里，不能静默丢弃');
  assert.ok(dial.every((item) => item.level === 'low'), '定不出本体与转轴，只能是低置信度');
  assert.ok(dial.some((item) => /转轴无法确定/.test(item.reason)), dial.map((item) => item.reason).join('｜'));
});

test('空装配 / 单件装配：不抛错、不出建议', () => {
  const cases = [
    [],
    [prismMesh('Part1', [0, 0, 0], [0, 0, 1], 100, 8, { id: 1 })],
    [boxMesh('Solid1', [0, 0, 0], [10, 10, 10], { id: 2 })]
  ];
  for (const meshes of cases) {
    const result = suggestKinematics(meshes);
    assert.equal(result.suggestions.length, 0);
    assert.equal(result.lowConfidence.length, 0);
    assert.equal(result.stats.meshes, meshes.length);
  }
});

// ---------------------------------------------------------------- 端到端：STEP 夹具

async function loadFixtureMeshes() {
  const data = readFileSync(FIXTURE);
  const result = await parseOcctBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), 'kinematics-assembly.stp');
  return result.meshes.map((mesh, id) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], mesh.positions[i + k]);
        max[k] = Math.max(max[k], mesh.positions[i + k]);
      }
    }
    return {
      id,
      name: mesh.name,
      ...(mesh.path ? { path: mesh.path } : {}),
      center: min.map((value, k) => (value + max[k]) / 2),
      size: min.map((value, k) => max[k] - value),
      triangles: mesh.indices ? mesh.indices.length / 3 : 0,
      positions: mesh.positions
    };
  });
}

test('端到端：合成 STEP 装配体 → 4 条高置信度 + 1 条低置信度，确认采纳后通过现有校验', async () => {
  const meshes = await loadFixtureMeshes();
  assert.equal(meshes.length, 11);
  assert.deepEqual(meshes[0].path, ['KIN_DEMO_MACHINE', 'ST1_PRESS']);
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const byCategory = Object.fromEntries(result.suggestions.map((item) => [item.category, item]));
  assert.deepEqual(Object.keys(byCategory).sort(), ['cylinder', 'gripper', 'rail', 'rotary']);
  assert.equal(result.lowConfidence.length, 1);
  assert.equal(result.lowConfidence[0].category, 'motor');
  assert.ok(result.skipped.some((item) => item.name === 'BASE_PLATE'));

  const cyl = byCategory.cylinder;
  assert.deepEqual([cyl.axis, cyl.direction, cyl.travelMm, cyl.point], ['x', 1, 50, 'ST1-EXT-A1']);
  assert.deepEqual(cyl.meshNames, ['CDJ2B16-50_rod']);
  const rail = byCategory.rail;
  assert.deepEqual([rail.axis, rail.direction, rail.travelMm, rail.point], ['y', 1, 250, '']);
  const rot = byCategory.rotary;
  assert.deepEqual([rot.kind, rot.axis, rot.rangeDeg, rot.point], ['rotary', 'z', 180, 'ST2-ROT-A1']);
  const grip = byCategory.gripper;
  assert.deepEqual([grip.axis, grip.direction, grip.travelMm, grip.point], ['x', 1, 3, 'ST2-GRIP-A2']);
  for (const item of result.suggestions) {
    assert.ok(item.confidence >= 0.6 && item.confidence <= 0.99);
    assert.match(item.reason, /[\u4e00-\u9fa5]/);
  }

  // 只采纳有点位的三条：校验通过、可序列化
  const ids = result.suggestions.filter((item) => item.point).map((item) => item.id);
  const accepted = acceptSuggestions([], result.suggestions, ids, meshes, { pointOptions: POINTS });
  assert.equal(accepted.parts.length, 3);
  assert.equal(accepted.validation.ok, true, JSON.stringify(accepted.validation.errors));
  // 再采纳无点位的导轨：现有校验报「至少需要绑定一个点位」
  const withRail = acceptSuggestions(accepted.parts, result.suggestions, [rail.id], meshes, { pointOptions: POINTS });
  assert.equal(withRail.validation.ok, false);
  assert.ok(withRail.validation.errors.some((issue) => issue.code === 'axis.bindings.empty' && issue.part === rail.name));
});

// ---------------------------------------------------------------- 水平偏角 yaw 与置信度口径

test('偏角扣分：3° 不扣，30° 与 45° 按实际夹角扣，且 30–54.7° 不再是平台', () => {
  assert.equal(directionPenalty(0), 0);
  assert.equal(directionPenalty(3), 0, '3° 以内视为几何噪声');
  assert.equal(directionPenalty(3.1).toFixed(2), '0.00');
  assert.equal(directionPenalty(30).toFixed(2), '0.27');
  assert.equal(directionPenalty(45).toFixed(2), '0.42');
  assert.equal(directionPenalty(54.7) > directionPenalty(45), true, '30–54.7° 必须单调，不能像旧 min() 一样恒等');
  assert.equal(directionPenalty(90), RESIDUAL_PENALTY_CAP);
  // 逐度检查不再有平台区（旧口径这一段全部等于 0.3）
  for (let deg = 30; deg <= 50; deg += 1) {
    assert.ok(directionPenalty(deg + 1) > directionPenalty(deg), `${deg}° → ${deg + 1}° 必须严格变大`);
  }
});

test('水平面内的 30°/45°/60° 都可精确标注：yaw 拿到角度、残差 0，不扣分', () => {
  const cases = [
    { deg: 30, axis: 'x', yaw: 30 },
    { deg: 45, axis: 'x', yaw: 45 },
    // 60° 的最近主轴已经换成 Y（|sin| > |cos|），偏角从 Y 往 X 量 = -30°
    { deg: 60, axis: 'y', yaw: -30 }
  ];
  for (const entry of cases) {
    const rad = (entry.deg * Math.PI) / 180;
    const vector = [Math.cos(rad), Math.sin(rad), 0];
    const snapped = snapAxis(vector);
    assert.equal(snapped.axis, entry.axis, `${entry.deg}°`);
    assert.equal(snapped.yawDeg, entry.yaw, `${entry.deg}°`);
    assert.equal(snapped.residualDeg, 0, `${entry.deg}° 应能精确表达`);
    // offAxisDeg 是与最近主轴的夹角：60° 的最近主轴是 Y，所以是 30°
    assert.equal(snapped.offAxisDeg, Math.min(entry.deg, 90 - entry.deg), `${entry.deg}° offAxisDeg`);
    assert.equal(directionPenalty(snapped.residualDeg), 0);
    // direction × (axis 绕 Z 偏 yaw) 必须还原出原向量
    const rebuilt = axisDirectionVector(snapped.axis, snapped.yawDeg, snapped.direction);
    assert.ok(Math.abs(rebuilt[0] - vector[0]) < 1e-6 && Math.abs(rebuilt[1] - vector[1]) < 1e-6, `${entry.deg}° 还原`);
  }
});

test('偏出水平面的 3°/30°/45°：置信度按残余倾角分别处理', () => {
  const make = (dir) => allSuggestions(suggestKinematics(cylinderPair({ dir })))[0];
  const straight = make([1, 0, 0]);
  const rad = (deg) => (deg * Math.PI) / 180;
  const three = make([Math.cos(rad(3)), 0, Math.sin(rad(3))]);
  const thirty = make([Math.cos(rad(30)), 0, Math.sin(rad(30))]);
  const fortyFive = make([Math.SQRT1_2, 0, Math.SQRT1_2]);

  assert.equal(three.residualDeg, 3);
  assert.equal(three.confidence, straight.confidence, '3° 以内不扣分');
  assert.equal(thirty.residualDeg, 30);
  assert.ok(thirty.confidence < three.confidence, '30° 残差要扣');
  assert.ok(Math.abs(three.confidence - thirty.confidence - 0.27) < 0.011);
  assert.equal(fortyFive.residualDeg, 45);
  assert.ok(Math.abs(thirty.confidence - fortyFive.confidence - 0.15) < 0.011);
  assert.ok(fortyFive.confidence < 0.6, `45° 不得进高置信档，实际 ${fortyFive.confidence}`);
});

test('采纳链路：建议的 yawDeg 会原样进 MovingPart / KinematicsAxis（不能只存主轴名）', () => {
  const meshes = cylinderPair({ dir: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0], path: ['M', 'ST1_PRESS'] });
  const suggestion = suggestKinematics(meshes, { pointOptions: POINTS }).suggestions[0];
  assert.equal(suggestion.yawDeg, 30);
  const part = suggestionToMovingPart(suggestion, meshes);
  assert.equal(part.yawDeg, 30);
  assert.equal(part.axis, 'x');
  const axis = partToAxis(part);
  assert.equal(axis.yawDeg, 30);
  // 存进标注的位移方向 = 真实方向（行程沿 30°），而不是只走 X
  const pose = axisPose(axis, { [part.point]: true });
  const expected = axisDirectionVector(axis.axis, axis.yawDeg, axis.direction).map((value) => value * part.travelMm);
  assert.ok(Math.abs(pose.offset[0] - expected[0]) < 1e-9);
  assert.ok(Math.abs(pose.offset[1] - expected[1]) < 1e-9);
  assert.ok(Math.abs(pose.offset[1]) > 1, '横向分量必须非 0，否则又退化成单轴');
});
