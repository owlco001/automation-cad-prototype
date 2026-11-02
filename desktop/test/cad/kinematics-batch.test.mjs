// 批量采纳（L1 一键高置信 + L2 按机构归组）与审计/撤销的纯函数单测。
// UI 层（kinematics-ui.ts）只做 DOM 接线，门槛/归组/回滚/撤销全部落在 tests 覆盖的函数上。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBatchAccept,
  batchGate,
  BATCH_MAX_OFF_AXIS_DEG,
  BATCH_MIN_CONFIDENCE,
  groupSuggestionsByMechanism,
  mechanismGroupKey,
  selectBatchEligible,
  suggestKinematics,
  undoBatchAccept
} from '../../src/cad/kinematics-auto.ts';
import { batchAcceptButtonLabel, pointOptionsFromMachineConfig, renderSuggestionGroupSection } from '../../src/cad/kinematics-ui.ts';

const CONFIG = {
  id: 'batch-kin',
  name: '批量采纳测试机',
  stations: ['ST1', 'ST2', 'ST3'],
  sensors: [],
  actuators: [
    { id: 'a1', name: 'ST1 压装气缸 A1', kind: 'cylinder', station: 'ST1', extendPoint: 'ST1-EXT-A1', retractPoint: 'ST1-RET-A1', travelMm: 50 },
    { id: 'a2', name: 'ST1 顶升气缸 A2', kind: 'cylinder', station: 'ST1', extendPoint: 'ST1-EXT-A2', retractPoint: 'ST1-RET-A2', travelMm: 50 },
    { id: 'a3', name: 'ST2 旋转台', kind: 'rotary', station: 'ST2', point: 'ST2-ROT-A1' },
    { id: 'a4', name: 'ST2 夹爪', kind: 'gripper', station: 'ST2', gripPoint: 'ST2-GRIP-A2' }
  ]
};
const POINTS = pointOptionsFromMachineConfig(CONFIG);
const AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------- 合成网格

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
    id: extra.id,
    name,
    ...(extra.path ? { path: extra.path } : {}),
    center: min.map((value, k) => (value + max[k]) / 2),
    size: min.map((value, k) => max[k] - value),
    triangles: 12,
    positions: new Float32Array(positions)
  };
}

function box(name, min, max, extra) {
  const out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return finish(name, out, extra);
}

function normalizeVec(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function crossVec(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function prism(name, start, dir, length, radius, extra) {
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

function cylinderPair({ dir = [0, -1, 0], origin = [0, 0, 0], path, ids } = {}) {
  return [
    prism('CDJ2B16-50_body', origin, dir, 90, 10, { id: ids[0], path }),
    prism('CDJ2B16-50_rod', origin, dir, 120, 4, { id: ids[1], path })
  ];
}

/** 一台混装样机：ST1 气缸 + 导轨，ST2 旋转台 + 夹爪，ST3 伺服电机。 */
function mixedMeshes() {
  return [
    ...cylinderPair({ path: ['M', 'ST1_PRESS'], ids: [100, 101] }),
    box('HGR20_rail', [200, 0, 0], [220, 500, 18], { id: 2, path: ['M', 'ST1_PRESS'] }),
    box('HGH20CA_carriage', [188, 440, 18], [232, 500, 30], { id: 3, path: ['M', 'ST1_PRESS'] }),
    box('MSQB20A_body', [400, 0, 0], [460, 60, 30], { id: 4, path: ['M', 'ST2_ROT'] }),
    prism('MSQB20A_table', [430, 30, 30], [0, 0, 1], 8, 25, { id: 5, path: ['M', 'ST2_ROT'] }),
    box('MHZ2-16D_body', [500, 0, 0], [530, 20, 40], { id: 6, path: ['M', 'ST2_GRIP'] }),
    box('finger_L', [502, 5, 40], [508, 15, 60], { id: 7, path: ['M', 'ST2_GRIP'] }),
    box('finger_R', [522, 5, 40], [528, 15, 60], { id: 8, path: ['M', 'ST2_GRIP'] }),
    prism('伺服电机_400W', [600, 0, 0], [0, 0, 1], 80, 20, { id: 9, path: ['M', 'ST3_MOTOR'] })
  ];
}

/** 同一工位两台同型号气缸，分属不同子装配（各自成一个 cluster）。 */
function twinCylinderMeshes() {
  return [
    ...cylinderPair({ path: ['M', 'ST1_A1'], ids: [110, 111] }),
    ...cylinderPair({ origin: [300, 0, 0], path: ['M', 'ST1_A2'], ids: [112, 113] })
  ];
}

/** ST2 旋转台（与 mixedMeshes 不共用网格 id，便于组合夹具）。 */
function rotaryPair(ids = [200, 201]) {
  return [
    box('MSQB20A_body', [400, 0, 0], [460, 60, 30], { id: ids[0], path: ['M', 'ST2_ROT'] }),
    prism('MSQB20A_table', [430, 30, 30], [0, 0, 1], 8, 25, { id: ids[1], path: ['M', 'ST2_ROT'] })
  ];
}

function allSuggestions(result) {
  return [...result.suggestions, ...result.lowConfidence];
}

function byId(result, id) {
  return allSuggestions(result).find((item) => item.id === id);
}

/** 合成一条建议，只用来单独验证某一道门槛（不动几何）。 */
function makeSuggestion(overrides = {}) {
  return {
    id: 'sg-x',
    category: 'cylinder',
    name: '合成建议',
    meshIds: [1],
    meshNames: ['mesh'],
    fixedMeshIds: [],
    kind: 'linear',
    directionVector: [1, 0, 0],
    axis: 'x',
    direction: 1,
    offAxisDeg: 0,
    travelMm: 50,
    retractedMm: 0,
    rangeDeg: 0,
    strokeSource: 'model-code',
    modelCode: 'CDJ2B16-50',
    station: 'ST1',
    groupKey: 'ST1@linear',
    point: 'ST1-EXT-A1',
    role: 'extend',
    pointCandidates: [],
    confidence: 0.9,
    level: 'high',
    reasons: [],
    reason: '',
    ...overrides
  };
}

// ---------------------------------------------------------------- 门槛

test('批量门槛：置信度 / 行程来源 / 偏角三条互相独立，任一不满足都拒绝并给中文原因', () => {
  assert.equal(BATCH_MIN_CONFIDENCE, 0.8);
  assert.equal(BATCH_MAX_OFF_AXIS_DEG, 5);
  assert.deepEqual(batchGate(makeSuggestion()), { ok: true, reason: '' });

  const lowConfidence = batchGate(makeSuggestion({ confidence: 0.79, level: 'low' }));
  assert.equal(lowConfidence.ok, false);
  assert.match(lowConfidence.reason, /置信度 79% 低于批量门槛 80%/);

  // 100% 置信也救不回几何估算的行程
  const geometry = batchGate(makeSuggestion({ confidence: 1, strokeSource: 'geometry' }));
  assert.equal(geometry.ok, false);
  assert.match(geometry.reason, /几何估算/);

  const fallbackAngle = batchGate(makeSuggestion({ category: 'rotary', kind: 'rotary', rangeDeg: 90, travelMm: 0, strokeSource: 'default' }));
  assert.equal(fallbackAngle.ok, false);
  assert.match(fallbackAngle.reason, /默认预填值/);

  const tilted = batchGate(makeSuggestion({ confidence: 0.95, offAxisDeg: 10 }));
  assert.equal(tilted.ok, false);
  assert.match(tilted.reason, /方向偏离主轴 10°/);

  const zeroTravel = batchGate(makeSuggestion({ travelMm: 0 }));
  assert.equal(zeroTravel.ok, false);
  assert.match(zeroTravel.reason, /行程为 0/);

  const motor = batchGate(makeSuggestion({ category: 'motor' }));
  assert.equal(motor.ok, false);
  assert.match(motor.reason, /伺服电机/);
});

test('高置信批量只挑三条件全过的项：导轨（几何行程）与电机留在列表里，低置信池不动', () => {
  const meshes = mixedMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const selection = selectBatchEligible(result.suggestions);

  assert.equal(selection.ids.length, 3);
  assert.deepEqual(
    selection.ids.map((id) => byId(result, id).category).sort(),
    ['cylinder', 'gripper', 'rotary']
  );
  // 导轨是高置信度（0.7）但行程只能几何估算/低于 0.8，必须挡下且说明原因
  const rail = result.suggestions.find((item) => item.category === 'rail');
  assert.ok(rail);
  assert.ok(!selection.ids.includes(rail.id));
  assert.match(selection.skipped.find((item) => item.id === rail.id).reason, /置信度 70% 低于批量门槛 80%/);

  // 低置信度建议一条都不应该进批量
  assert.deepEqual(selectBatchEligible(result.lowConfidence).ids, []);
  assert.equal(result.lowConfidence.length, 1);

  const outcome = applyBatchAccept([], allSuggestions(result), selection.ids, meshes, {
    pointOptions: POINTS,
    scope: 'high-confidence',
    label: '全部高置信 3 条',
    at: AT
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.parts.length, 3);
  assert.deepEqual(outcome.acceptedIds, selection.ids);
  assert.deepEqual(outcome.parts.map((part) => part.name).sort(), [
    'ST1 气缸 CDJ2B16-50',
    'ST2 夹爪 MHZ2-16D',
    'ST2 旋转台 MSQB20A'
  ]);
  // 逐件核对字段确实来自各自的建议，而不是默认值
  const cylinderPart = outcome.parts.find((part) => part.name.includes('CDJ2B16-50'));
  assert.deepEqual([cylinderPart.axis, cylinderPart.direction, cylinderPart.travelMm, cylinderPart.point], ['y', -1, 50, 'ST1-EXT-A1']);
  const rotaryPart = outcome.parts.find((part) => part.name.includes('MSQB20A'));
  assert.deepEqual([rotaryPart.kind, rotaryPart.axis, rotaryPart.rangeDeg, rotaryPart.point], ['rotary', 'z', 180, 'ST2-ROT-A1']);
  const gripperPart = outcome.parts.find((part) => part.name.includes('MHZ2'));
  assert.deepEqual([gripperPart.axis, gripperPart.direction, gripperPart.travelMm, gripperPart.point], ['x', 1, 3, 'ST2-GRIP-A2']);
  // 电机（低置信）没有被塞进动件
  assert.ok(!outcome.parts.some((part) => part.meshIds.includes(9)));

  // 审计记录：条数、id、前后数量、快照
  assert.equal(outcome.audit.recordId, `ba-high-confidence-${AT}`);
  assert.equal(outcome.audit.scope, 'high-confidence');
  assert.deepEqual(outcome.audit.suggestionIds, selection.ids);
  assert.equal(outcome.audit.addedPartIds.length, 3);
  assert.deepEqual([outcome.audit.beforeCount, outcome.audit.afterCount], [0, 3]);
  assert.deepEqual(outcome.audit.before, []);
});

test('方向回落：引擎给出 0.8 且型号行程，但偏主轴 10° → 仍不进批量（偏角是独立条件）', () => {
  const tilted = [Math.cos(Math.PI / 18), Math.sin(Math.PI / 18), 0]; // 10°
  const meshes = cylinderPair({ dir: tilted, path: ['M', 'ST1_PRESS'], ids: [100, 101] });
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.level, 'high');
  assert.equal(suggestion.confidence, 0.8);
  assert.equal(suggestion.strokeSource, 'model-code');
  assert.equal(suggestion.offAxisDeg, 10);
  const gate = batchGate(suggestion);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /方向偏离主轴 10°/);
  assert.deepEqual(selectBatchEligible(result.suggestions).ids, []);
});

// ---------------------------------------------------------------- 归组

test('按机构归组：同工位同族合成一组（气缸+导轨），组键稳定且跨工位不同', () => {
  const meshes = mixedMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const groups = groupSuggestionsByMechanism(result.suggestions);

  assert.deepEqual(groups.map((group) => group.key), ['ST1@linear', 'ST2@gripper', 'ST2@rotary']);
  const linear = groups.find((group) => group.key === 'ST1@linear');
  assert.equal(linear.label, 'ST1 直线驱动');
  assert.equal(linear.suggestions.length, 2, '气缸与导轨同属 ST1 直线链，一次点完');
  assert.deepEqual(linear.eligibleIds, [result.suggestions.find((item) => item.category === 'cylinder').id]);
  assert.equal(linear.skipped.length, 1);
  assert.match(linear.skipped[0].reason, /低于批量门槛/);
  assert.equal(linear.fixedMeshIds.length >= 1, true, '组内固定件（缸体/导轨）应带出来给 UI 展示');

  // 组键不是按建议顺序生成的 id：两次识别完全一致，且工位不同必然不同键
  const again = suggestKinematics(meshes, { pointOptions: POINTS });
  assert.deepEqual(again, result);
  assert.notEqual(mechanismGroupKey({ station: 'ST1', category: 'cylinder' }), mechanismGroupKey({ station: 'ST2', category: 'cylinder' }));
  assert.equal(mechanismGroupKey({ station: '', category: 'cylinder', group: 'M / ST7_PRESS' }), 'M / ST7_PRESS@linear');
  assert.deepEqual(groupSuggestionsByMechanism([]), []);
});

test('归组批量一次采纳：同一机构两台同型号气缸 → 一次调用进 2 条动件、1 条审计记录', () => {
  const meshes = twinCylinderMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  assert.equal(result.suggestions.length, 2);
  const groups = groupSuggestionsByMechanism(result.suggestions);
  assert.equal(groups.length, 1, '两台气缸同属 ST1 直线组');
  assert.equal(groups[0].key, 'ST1@linear');
  assert.deepEqual(groups[0].eligibleIds, result.suggestions.map((item) => item.id));

  const outcome = applyBatchAccept([], allSuggestions(result), groups[0].eligibleIds, meshes, {
    pointOptions: POINTS,
    scope: 'mechanism',
    label: `${groups[0].label} 2 条`,
    at: AT
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.parts.length, 2, '一次点击 = 两个动件');
  assert.equal(outcome.audit.addedPartIds.length, 2);
  assert.equal(outcome.audit.scope, 'mechanism');
  assert.equal(outcome.audit.label, 'ST1 直线驱动 2 条');
  assert.equal(outcome.validation.ok, true, JSON.stringify(outcome.validation.errors));
  // 两台气缸各自绑到自己的指令点位，没有串位
  assert.deepEqual(outcome.parts.map((part) => part.point).sort(), ['ST1-EXT-A1', 'ST1-EXT-A2']);
  assert.deepEqual(
    outcome.parts.map((part) => [part.kind, part.axis, part.direction, part.travelMm]).sort(),
    [
      ['linear', 'y', -1, 50],
      ['linear', 'y', -1, 50]
    ]
  );
});

// ---------------------------------------------------------------- 撤销

test('撤销批量采纳：快照精确回到采纳前（总数 + 每件字段逐一比对），且不能重复撤销', () => {
  const meshes = [...twinCylinderMeshes(), ...rotaryPair()];
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const rotary = result.suggestions.find((item) => item.category === 'rotary');
  const twins = result.suggestions.filter((item) => item.category === 'cylinder');
  assert.equal(twins.length, 2);

  // 采纳前已有 1 个动件（走单条采纳路径），撤销必须保留它而不是清空
  const base = applyBatchAccept([], result.suggestions, [rotary.id], meshes, {
    pointOptions: POINTS,
    scope: 'high-confidence',
    label: '旋转台 1 条',
    at: AT
  });
  assert.equal(base.ok, true, base.error);
  const before = base.parts;
  assert.equal(before.length, 1);

  const batch = applyBatchAccept(before, result.suggestions, twins.map((item) => item.id), meshes, {
    pointOptions: POINTS,
    scope: 'mechanism',
    label: 'ST1 直线驱动 2 条',
    at: AT
  });
  assert.equal(batch.ok, true, batch.error);
  assert.equal(batch.parts.length, 3);
  assert.equal(batch.audit.before.length, 1);
  assert.equal(batch.audit.beforeCount, 1);

  const undo = undoBatchAccept(batch.parts, batch.audit);
  assert.equal(undo.ok, true, undo.reason);
  assert.equal(undo.parts.length, 1, '总数回到采纳前');
  assert.deepEqual(undo.parts, before, '每件字段与采纳前逐一相同');
  assert.deepEqual(undo.removedIds, batch.audit.addedPartIds);
  // 撤销前的 parts 没有被就地改写
  assert.equal(batch.parts.length, 3);

  // 同一条记录不能撤销两次：动件已不在，拒绝并说明
  const again = undoBatchAccept(undo.parts, batch.audit);
  assert.equal(again.ok, false);
  assert.match(again.reason, /已被删除或替换/);
  assert.deepEqual(again.parts, before);

  // 批量后用户手动删了一条 → 拒绝精确撤销，不猜用户意图
  const tampered = batch.parts.filter((part) => part.id !== batch.audit.addedPartIds[0]);
  const refused = undoBatchAccept(tampered, batch.audit);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, new RegExp(batch.audit.addedPartIds[0]));
  assert.deepEqual(refused.parts, tampered);
});

// ---------------------------------------------------------------- 边界与回滚

test('空列表 / 全低置信 / 不存在的 id：不抛异常、parts 原样、错误信息可读', () => {
  const empty = applyBatchAccept([], [], [], [], { scope: 'high-confidence', label: '空', at: AT });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有传入要批量采纳的建议/);
  assert.deepEqual(empty.parts, []);
  assert.equal(empty.audit, null);
  assert.deepEqual(selectBatchEligible([]), { ids: [], skipped: [] });

  const motorOnly = suggestKinematics([prism('伺服电机_400W', [0, 0, 0], [0, 0, 1], 80, 20, { id: 1 })]);
  assert.equal(motorOnly.suggestions.length, 0);
  const allLow = applyBatchAccept([], allSuggestions(motorOnly), allSuggestions(motorOnly).map((item) => item.id), [], {
    scope: 'high-confidence',
    label: '全低置信',
    at: AT
  });
  assert.equal(allLow.ok, false);
  assert.match(allLow.error, /没有满足批量条件的建议/);
  assert.deepEqual(allLow.parts, []);

  const meshes = mixedMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const missing = applyBatchAccept([], result.suggestions, ['sg-404'], meshes, { pointOptions: POINTS, scope: 'high-confidence', label: '缺 id', at: AT });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingIds, ['sg-404']);
  assert.equal(missing.parts.length, 0);

  // 全低置信 + 真实网格：仍不报错，也不写动件
  const onlyMotor = applyBatchAccept([], allSuggestions(result), [result.lowConfidence[0].id], meshes, {
    pointOptions: POINTS,
    scope: 'high-confidence',
    label: '电机',
    at: AT
  });
  assert.equal(onlyMotor.ok, false);
  assert.match(onlyMotor.error, /没有满足批量条件的建议/);
  assert.deepEqual(onlyMotor.parts, []);
  assert.match(onlyMotor.skipped[0].reason, /伺服电机/);
});

test('失败回滚：批量会让校验新增错误（点位被占用）时整批不生效，审计记录为空', () => {
  const meshes = twinCylinderMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const first = result.suggestions[0];
  const base = applyBatchAccept([], result.suggestions, [first.id], meshes, {
    pointOptions: POINTS,
    scope: 'high-confidence',
    label: '第一条',
    at: AT
  });
  assert.equal(base.ok, true, base.error);
  const before = base.parts;

  // 再批第一条：同一点位 ST1-EXT-A1 被两个动件占用 → 校验多 1 条错误 → 整批回滚
  const conflict = applyBatchAccept(before, result.suggestions, [first.id], meshes, {
    pointOptions: POINTS,
    scope: 'mechanism',
    label: '重复采纳',
    at: AT
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /批量采纳会让校验错误从 0 增至 1/);
  assert.match(conflict.error, /整批回滚/);
  assert.equal(conflict.audit, null);
  assert.deepEqual(conflict.parts, before, '失败时回到采纳前状态，不留半成品');
  assert.deepEqual(conflict.acceptedIds, []);

  // 关掉守卫时确实会写进去，证明回滚判定是这道守卫生效而不是偶然
  const unguarded = applyBatchAccept(before, result.suggestions, [first.id], meshes, {
    pointOptions: POINTS,
    scope: 'mechanism',
    label: '无守卫',
    rejectNewErrors: false,
    at: AT
  });
  assert.equal(unguarded.ok, true, unguarded.error);
  assert.equal(unguarded.validation.ok, false);
  assert.equal(unguarded.parts.length, 2);
});

// ---------------------------------------------------------------- UI 渲染（纯函数）

test('UI 文案与组头 HTML：按钮条数随门槛变化，0 条时置灰，组键/组名转义', () => {
  assert.equal(batchAcceptButtonLabel(0), '采纳全部高置信(0)');
  assert.equal(batchAcceptButtonLabel(3), '采纳全部高置信(3)');
  assert.equal(batchAcceptButtonLabel(-2), '采纳全部高置信(0)');

  const meshes = twinCylinderMeshes();
  const result = suggestKinematics(meshes, { pointOptions: POINTS });
  const [group] = groupSuggestionsByMechanism(result.suggestions);
  const html = renderSuggestionGroupSection(group, (item) => `<i>${item.id}</i>`);
  assert.match(html, /data-kin-group="ST1@linear"/);
  assert.match(html, /ST1 直线驱动 · 2 条/);
  assert.match(html, /data-kin-accept-group="ST1@linear"/);
  assert.match(html, /采纳本机构\(2\)/);
  assert.ok(html.includes('<i>sg-1</i>') && html.includes('<i>sg-2</i>'), '卡片由调用方渲染并原样拼入');

  // 没有可批量条目的组：按钮 disabled，但组与建议仍展示（用户还能逐条点）
  const blocked = { ...group, eligibleIds: [], skipped: [{ id: 'sg-1', name: 'x', reason: '行程为几何估算' }] };
  const blockedHtml = renderSuggestionGroupSection(blocked, (item) => `<i>${item.id}</i>`);
  assert.match(blockedHtml, /data-kin-accept-group="ST1@linear" disabled/);
  assert.match(blockedHtml, /采纳本机构\(0\)/);

  // 组键可能来自装配路径，含引号/尖括号时必须转义，不能提前闭合属性
  const tricky = { ...group, key: 'M / ST1\"><script>' };
  const escaped = renderSuggestionGroupSection(tricky, () => '');
  assert.ok(escaped.includes('data-kin-group="M / ST1&quot;&gt;&lt;script&gt;"'));
  assert.ok(!escaped.includes('<script>'));
});
