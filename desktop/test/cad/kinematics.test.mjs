import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertKinematics,
  axisPose,
  checkKinematics,
  crossCheckMachineConfig,
  emptyKinematicsDoc,
  kinematicsStats,
  parseKinematicsJson,
  removeAxis,
  removeBinding,
  serializeKinematics,
  setBinding,
  upsertAxis
} from '../../src/cad/kinematics.ts';

const PARTS = ['底座', 'station-1-cylinder', '旋转台动件'];
const POINTS = ['Y0', 'Y4', 'Y8', 'X0'];

function linearAxis(overrides = {}) {
  return {
    part: 'station-1-cylinder',
    kind: 'linear',
    axis: 'y',
    travelMm: 50,
    bindings: [
      { role: 'extend', point: 'Y0' },
      { role: 'retract', point: 'Y4' }
    ],
    ...overrides
  };
}

function docOf(...axes) {
  return { schemaVersion: 1, units: 'mm', axes };
}

test('运动学标注：合法直线轴补全默认值并统计', () => {
  const check = checkKinematics(docOf(linearAxis()), { partNames: PARTS, knownPoints: POINTS });
  assert.equal(check.ok, true, JSON.stringify(check.issues));
  assert.equal(check.doc.axes.length, 1);
  const axis = check.doc.axes[0];
  assert.equal(axis?.retractedMm, 0);
  assert.equal(axis?.direction, undefined);
  assert.deepEqual(check.stats, { axes: 1, linear: 1, rotary: 0, boundPoints: 2, totalTravelMm: 50 });
});

test('运动学标注：旋转轴按角度标注并统计', () => {
  const check = checkKinematics(
    docOf({
      part: '旋转台动件',
      kind: 'rotary',
      axis: 'z',
      rangeDeg: 90,
      bindings: [{ role: 'rotate', point: 'Y8' }]
    }),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(check.ok, true, JSON.stringify(check.issues));
  assert.equal(check.stats.rotary, 1);
  assert.equal(check.stats.totalTravelMm, 0);
  assert.equal(check.doc.axes[0]?.rangeDeg, 90);
});

test('运动学标注：动件不在 STEP 零件表中报错并指出名称', () => {
  const check = checkKinematics(docOf(linearAxis({ part: '不存在的动件' })), {
    partNames: PARTS,
    knownPoints: POINTS
  });
  assert.equal(check.ok, false);
  assert.match(check.errors[0].message, /不在当前导入的零件中/);
  assert.match(check.errors[0].message, /不存在的动件/);
  assert.equal(check.doc.axes.length, 0);
});

test('运动学标注：动件名忽略大小写与首尾空格并归一化为原零件名', () => {
  const check = checkKinematics(docOf(linearAxis({ part: '  STATION-1-Cylinder ' })), {
    partNames: PARTS,
    knownPoints: POINTS
  });
  assert.equal(check.ok, true, JSON.stringify(check.issues));
  assert.equal(check.doc.axes[0]?.part, 'station-1-cylinder');
});

test('运动学标注：同一动件重复标注报错', () => {
  const check = checkKinematics(docOf(linearAxis(), linearAxis({ axis: 'x' })), {
    partNames: PARTS,
    knownPoints: POINTS
  });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((issue) => issue.code === 'axis.part.duplicate'));
  assert.equal(check.doc.axes.length, 1);
});

test('运动学标注：直线轴缺行程或行程非法时报错', () => {
  const missing = checkKinematics(docOf(linearAxis({ travelMm: undefined })), { partNames: PARTS });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /travelMm 必须是大于 0 的数字/);
  assert.equal(missing.doc.axes.length, 0);

  for (const bad of [0, -5, Number.NaN, '40']) {
    const check = checkKinematics(docOf(linearAxis({ travelMm: bad })), { partNames: PARTS });
    assert.equal(check.ok, false, `travelMm=${String(bad)} 应被拒绝`);
  }
});

test('运动学标注：直线轴填角度或旋转轴填行程都被拒绝', () => {
  const linearWithRange = checkKinematics(docOf(linearAxis({ rangeDeg: 90 })), { partNames: PARTS });
  assert.equal(linearWithRange.ok, false);
  assert.ok(linearWithRange.errors.some((issue) => issue.code === 'axis.range.unexpected'));

  const rotaryWithTravel = checkKinematics(
    docOf({
      part: '旋转台动件',
      kind: 'rotary',
      axis: 'z',
      rangeDeg: 90,
      travelMm: 50,
      bindings: [{ role: 'rotate', point: 'Y8' }]
    }),
    { partNames: PARTS }
  );
  assert.equal(rotaryWithTravel.ok, false);
  assert.ok(rotaryWithTravel.errors.some((issue) => issue.code === 'axis.travel.unexpected'));
});

test('运动学标注：旋转轴缺 rangeDeg 报错', () => {
  const check = checkKinematics(
    docOf({ part: '旋转台动件', kind: 'rotary', axis: 'z', bindings: [{ role: 'rotate', point: 'Y8' }] }),
    { partNames: PARTS }
  );
  assert.equal(check.ok, false);
  assert.match(check.errors[0].message, /rangeDeg/);
});

test('运动学标注：缩回位置必须小于行程', () => {
  const bad = checkKinematics(docOf(linearAxis({ retractedMm: 50 })), { partNames: PARTS });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((issue) => issue.code === 'axis.retracted.range'));

  const good = checkKinematics(docOf(linearAxis({ retractedMm: 5 })), { partNames: PARTS });
  assert.equal(good.ok, true);
  assert.equal(good.doc.axes[0]?.retractedMm, 5);
});

test('运动学标注：非法轴名与方向被拒绝', () => {
  const badAxis = checkKinematics(docOf(linearAxis({ axis: 'w' })), { partNames: PARTS });
  assert.equal(badAxis.ok, false);
  assert.match(badAxis.errors[0].message, /轴必须是 X、Y 或 Z/);

  const badDirection = checkKinematics(docOf(linearAxis({ direction: 0 })), { partNames: PARTS });
  assert.equal(badDirection.ok, false);
  assert.ok(badDirection.errors.some((issue) => issue.code === 'axis.direction'));
});

test('运动学标注：角色非法或与运动类型不匹配时报错', () => {
  const badRole = checkKinematics(
    docOf(linearAxis({ bindings: [{ role: 'grip', point: 'Y0' }] })),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(badRole.ok, false);
  assert.ok(badRole.errors.some((issue) => issue.code === 'binding.role'));

  const rotaryRole = checkKinematics(
    docOf(linearAxis({ bindings: [{ role: 'rotate', point: 'Y0' }] })),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(rotaryRole.ok, false);
  assert.ok(rotaryRole.errors.some((issue) => issue.code === 'binding.roleMismatch'));
});

test('运动学标注：同一角色重复绑定报错', () => {
  const check = checkKinematics(
    docOf(
      linearAxis({
        bindings: [
          { role: 'extend', point: 'Y0' },
          { role: 'extend', point: 'Y4' }
        ]
      })
    ),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((issue) => issue.code === 'binding.roleDuplicate'));
});

test('运动学标注：同一点位被两个动件占用报错', () => {
  const check = checkKinematics(
    docOf(
      linearAxis(),
      {
        part: '旋转台动件',
        kind: 'rotary',
        axis: 'z',
        rangeDeg: 90,
        bindings: [{ role: 'rotate', point: 'y0' }]
      }
    ),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(check.ok, false);
  const issue = check.errors.find((item) => item.code === 'binding.pointDuplicate');
  assert.ok(issue);
  assert.match(issue.message, /Y0/);
});

test('运动学标注：点位不在 IO 表时给出可操作错误', () => {
  const check = checkKinematics(
    docOf(linearAxis({ bindings: [{ role: 'extend', point: 'Y99' }] })),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((issue) => issue.code === 'binding.pointUnknown'));
  assert.ok(check.errors.some((issue) => /Y99/.test(issue.message)));
});

test('运动学标注：缺 extend 阻塞、缺 retract 仅警告', () => {
  const noExtend = checkKinematics(
    docOf(linearAxis({ bindings: [{ role: 'retract', point: 'Y4' }] })),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(noExtend.ok, false);

  const noRetract = checkKinematics(
    docOf(linearAxis({ bindings: [{ role: 'extend', point: 'Y0' }] })),
    { partNames: PARTS, knownPoints: POINTS }
  );
  assert.equal(noRetract.ok, true, JSON.stringify(noRetract.issues));
  assert.equal(noRetract.warnings[0]?.code, 'binding.retractMissing');
});

test('运动学标注：绑定为空数组报错', () => {
  const check = checkKinematics(docOf(linearAxis({ bindings: [] })), { partNames: PARTS });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((issue) => issue.code === 'axis.bindings.empty'));
});

test('姿态解算：伸出、缩回、空闲、方向与双信号冲突', () => {
  const axis = {
    part: 'station-1-cylinder',
    kind: 'linear',
    axis: 'y',
    travelMm: 50,
    retractedMm: 5,
    direction: -1,
    bindings: [
      { role: 'extend', point: 'Y0' },
      { role: 'retract', point: 'Y4' }
    ]
  };
  const extended = axisPose(axis, { Y0: true });
  assert.equal(extended.amount, 50);
  assert.equal(extended.source, 'extend');
  assert.deepEqual(extended.offset, [0, -50, 0]);
  assert.equal(extended.conflict, false);

  const retracted = axisPose(axis, { y4: true });
  assert.equal(retracted.amount, 5);
  assert.equal(retracted.source, 'retract');
  assert.deepEqual(retracted.offset, [0, -5, 0]);

  const idle = axisPose(axis, {});
  assert.equal(idle.amount, 5);
  assert.equal(idle.source, 'idle');

  const conflict = axisPose(axis, { Y0: true, Y4: true });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.source, 'extend');
});

test('姿态解算：旋转轴按 rotate 点位在 0 与量程间切换', () => {
  const axis = {
    part: '旋转台动件',
    kind: 'rotary',
    axis: 'z',
    rangeDeg: 90,
    bindings: [{ role: 'rotate', point: 'Y8' }]
  };
  const on = axisPose(axis, { Y8: true });
  assert.equal(on.amount, 90);
  assert.equal(on.unit, 'deg');
  assert.ok(Math.abs(on.rotationRad - Math.PI / 2) < 1e-9);
  assert.equal(on.source, 'rotate');

  const off = axisPose(axis, { Y8: false });
  assert.equal(off.amount, 0);
  assert.equal(off.rotationRad, 0);
  assert.equal(off.source, 'idle');
});

test('标注编辑：upsert/remove/setBinding 均为不可变操作', () => {
  const base = docOf(linearAxis());
  const added = upsertAxis(base, {
    part: '旋转台动件',
    kind: 'rotary',
    axis: 'z',
    rangeDeg: 90,
    bindings: [{ role: 'rotate', point: 'Y8' }]
  });
  assert.equal(base.axes.length, 1);
  assert.equal(added.axes.length, 2);

  const replaced = upsertAxis(added, { ...linearAxis(), travelMm: 80 });
  assert.equal(replaced.axes.length, 2);
  assert.equal(replaced.axes.find((axis) => axis.part === 'station-1-cylinder')?.travelMm, 80);

  const bound = setBinding(replaced, 'station-1-cylinder', { role: 'extend', point: 'X0' });
  const target = bound.axes.find((axis) => axis.part === 'station-1-cylinder');
  assert.equal(target?.bindings.length, 2);
  assert.equal(target?.bindings.find((binding) => binding.role === 'extend')?.point, 'X0');

  const unbound = removeBinding(bound, 'station-1-cylinder', 'retract');
  assert.equal(unbound.axes.find((axis) => axis.part === 'station-1-cylinder')?.bindings.length, 1);

  const removed = removeAxis(unbound, '旋转台动件');
  assert.equal(removed.axes.length, 1);
  assert.equal(unbound.axes.length, 2);

  assert.throws(() => setBinding(base, '不存在', { role: 'extend', point: 'X0' }), /尚未标注/);
});

test('机型配置交叉核对：行程不一致、类型冲突、未绑定执行机构', () => {
  const check = checkKinematics(
    docOf(linearAxis({ travelMm: 50 }), {
      part: '旋转台动件',
      kind: 'rotary',
      axis: 'z',
      rangeDeg: 90,
      bindings: [{ role: 'rotate', point: 'Y8' }]
    }),
    { partNames: PARTS, knownPoints: POINTS }
  );
  const issues = crossCheckMachineConfig(check.doc, {
    actuators: [
      { id: 'a1', name: '上料气缸', kind: 'cylinder', travelMm: 40, extendPoint: 'Y0', retractPoint: 'Y4' },
      { id: 'a2', name: '旋转台', kind: 'rotary', point: 'Y8' },
      { id: 'a3', name: '夹爪', kind: 'gripper', gripPoint: 'X0' }
    ]
  });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('config.travelMismatch'));
  assert.ok(codes.includes('config.unboundActuator'));
  assert.ok(issues.every((issue) => issue.level === 'warning'));
  assert.ok(issues.some((issue) => /上料气缸/.test(issue.message) && /40 mm/.test(issue.message)));

  const mismatch = crossCheckMachineConfig(check.doc, {
    actuators: [{ id: 'a2', name: '夹爪', kind: 'gripper', gripPoint: 'Y8' }]
  });
  assert.ok(mismatch.some((issue) => issue.code === 'config.kindMismatch'));
});

test('严格模式：assertKinematics 抛中文错误并汇总错误数', () => {
  assert.throws(
    () => assertKinematics(docOf(linearAxis(), linearAxis({ axis: 'x' })), { partNames: PARTS }),
    /运动学标注校验失败：.*重复标注/
  );
  assert.throws(
    () =>
      assertKinematics(
        docOf(linearAxis({ travelMm: 0 }), { part: '旋转台动件', kind: 'rotary', axis: 'z', bindings: [] }),
        { partNames: PARTS }
      ),
    /共 \d+ 项错误/
  );
  const doc = assertKinematics(docOf(linearAxis()), { partNames: PARTS, knownPoints: POINTS });
  assert.equal(doc.axes.length, 1);
});

test('序列化：写出的 JSON 可原样读回，非法 JSON 给中文提示', () => {
  const check = checkKinematics(docOf(linearAxis()), { partNames: PARTS, knownPoints: POINTS });
  const text = serializeKinematics(check.doc);
  assert.match(text, /"schemaVersion": 1/);
  const back = parseKinematicsJson(text, { partNames: PARTS, knownPoints: POINTS });
  assert.equal(back.ok, true, JSON.stringify(back.issues));
  assert.deepEqual(back.doc, check.doc);

  const broken = parseKinematicsJson('{ 不是 json', {});
  assert.equal(broken.ok, false);
  assert.equal(broken.errors[0]?.message, '运动学标注不是合法 JSON');
});

test('空标注文档：合法但统计为 0，不伪造内容', () => {
  const check = checkKinematics(emptyKinematicsDoc());
  assert.equal(check.ok, true);
  assert.deepEqual(kinematicsStats(check.doc), {
    axes: 0,
    linear: 0,
    rotary: 0,
    boundPoints: 0,
    totalTravelMm: 0
  });
});

// ---------------------------------------------------------------- 水平偏角 yawDeg

test('水平偏角：直线位移按 yaw 旋转后写 x/y 两个分量（不再只写一个主轴分量）', () => {
  const axis = linearAxis({ axis: 'x', travelMm: 40, yawDeg: 30, bindings: [{ role: 'extend', point: 'X0' }] });
  const extended = axisPose(axis, { X0: true });
  assert.equal(extended.yawDeg, 30);
  // 40 × (cos30, sin30, 0) = (34.641, 20, 0)：横向 20 mm 不再被销毁
  assert.ok(Math.abs(extended.offset[0] - 40 * Math.cos(Math.PI / 6)) < 1e-9);
  assert.ok(Math.abs(extended.offset[1] - 20) < 1e-9);
  assert.ok(Math.abs(extended.offset[2]) < 1e-12);
  // 旧实现只会写 [40,0,0]；这个断言的差值就是过去的横向误差
  assert.ok(Math.abs(extended.offset[0] - 40) > 5);

  // y 轴 + 负方向 + yaw=60：(-sin60, cos60, 0) × 40 × -1 = (34.641, -20, 0)
  const yAxis = linearAxis({ axis: 'y', travelMm: 50, yawDeg: 60, direction: -1, bindings: [{ role: 'extend', point: 'Y0' }] });
  const yPose = axisPose(yAxis, { Y0: true });
  assert.ok(Math.abs(yPose.offset[0] - 50 * Math.sin(Math.PI / 3)) < 1e-9);
  assert.ok(Math.abs(yPose.offset[1] + 25) < 1e-9);
});

test('水平偏角缺省 0：行为与加 yaw 之前逐位相同（含 -0 归一）', () => {
  const cases = [
    { axis: 'x', direction: 1, expected: [50, 0, 0] },
    { axis: 'x', direction: -1, expected: [-50, 0, 0] },
    { axis: 'y', direction: 1, expected: [0, 50, 0] },
    { axis: 'y', direction: -1, expected: [0, -50, 0] },
    { axis: 'z', direction: 1, expected: [0, 0, 50] },
    { axis: 'z', direction: -1, expected: [0, 0, -50] }
  ];
  for (const entry of cases) {
    const axis = linearAxis({ axis: entry.axis, direction: entry.direction });
    const pose = axisPose(axis, { Y0: true });
    assert.deepEqual(pose.offset, entry.expected, `${entry.axis}${entry.direction > 0 ? '+' : '-'}`);
    assert.equal(pose.yawDeg, 0);
    assert.equal(Object.hasOwn(pose, 'yawDeg'), true);
  }
  // 对象里没有 yawDeg 字段的旧数据同样走 yaw=0 分支
  const legacy = { part: 'station-1-cylinder', kind: 'linear', axis: 'y', travelMm: 50, bindings: [{ role: 'extend', point: 'Y0' }] };
  assert.deepEqual(axisPose(legacy, { Y0: true }).offset, [0, 50, 0]);
});

test('水平偏角非法：范围外 / 非数字 / Z 轴非 0 都给中文错误码，不抛英文', () => {
  for (const bad of [180.1, -180, 1000, '30', Number.NaN]) {
    const check = checkKinematics(docOf(linearAxis({ axis: 'x', yawDeg: bad })), { partNames: PARTS, knownPoints: POINTS });
    assert.equal(check.ok, false, `yawDeg=${String(bad)} 应当被拒`);
    const issue = check.errors.find((entry) => entry.code === 'axis.yaw.range');
    assert.ok(issue, `缺少 axis.yaw.range：${JSON.stringify(check.errors)}`);
    assert.match(issue.message, /水平偏角/);
    assert.match(issue.message, /-180°/);
  }
  // Z 向轴绕 Z 旋转不改变方向：静默忽略会丢信息，所以显式报错
  const zAxis = checkKinematics(docOf(linearAxis({ axis: 'z', yawDeg: 30 })), { partNames: PARTS, knownPoints: POINTS });
  assert.equal(zAxis.ok, false);
  assert.equal(zAxis.errors[0]?.code, 'axis.yaw.zAxis');
  assert.match(zAxis.errors[0]?.message ?? '', /只能为 0/);
  // 边界值本身合法：180 与 -179.9 都收
  assert.equal(checkKinematics(docOf(linearAxis({ axis: 'x', yawDeg: 180 })), { partNames: PARTS, knownPoints: POINTS }).ok, true);
  assert.equal(checkKinematics(docOf(linearAxis({ axis: 'x', yawDeg: -179.9 })), { partNames: PARTS, knownPoints: POINTS }).ok, true);
  // 严格模式抛的是中文提示，不是英文 TypeError
  assert.throws(
    () => assertKinematics(docOf(linearAxis({ axis: 'x', yawDeg: 999 })), { partNames: PARTS, knownPoints: POINTS }),
    /运动学标注校验失败：.*水平偏角/
  );
});

test('水平偏角：旧标注（无 yawDeg）原样流通，序列化不多出字段', () => {
  const check = checkKinematics(docOf(linearAxis()), { partNames: PARTS, knownPoints: POINTS });
  assert.equal(check.ok, true);
  assert.equal(Object.hasOwn(check.doc.axes[0], 'yawDeg'), false);
  assert.equal(/"yawDeg"/.test(serializeKinematics(check.doc)), false);

  const withYaw = checkKinematics(docOf(linearAxis({ axis: 'x', yawDeg: 30 })), { partNames: PARTS, knownPoints: POINTS });
  const text = serializeKinematics(withYaw.doc);
  assert.match(text, /"yawDeg": 30/);
  const back = parseKinematicsJson(text, { partNames: PARTS, knownPoints: POINTS });
  assert.equal(back.ok, true);
  assert.equal(back.doc.axes[0]?.yawDeg, 30);
  assert.deepEqual(axisPose(back.doc.axes[0], { Y0: true }), axisPose(withYaw.doc.axes[0], { Y0: true }));
});
