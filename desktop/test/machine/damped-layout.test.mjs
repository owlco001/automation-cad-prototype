import assert from 'node:assert/strict';
import test from 'node:test';

const { solveDampedLayout } = await import('../../src/machine/damped-layout.ts');

const cluster = (id, x, opts = {}) => ({
  id,
  pos: [x, 0, 0],
  half: [10, 10, 10],
  ...opts
});

test('重叠两簇：推开到最小净距并收敛', () => {
  const result = solveDampedLayout(
    [cluster('a', 0, { pinned: true }), cluster('b', 8)],
    [{ a: 'a', b: 'b', axis: 0, minClearanceMm: 5 }]
  );
  assert.equal(result.converged, true);
  assert.ok(result.maxViolationMm <= 0.05, `剩余违规 ${result.maxViolationMm} mm`);
});

test('固定机架 + 活动工位：只动活动那个，机架不动', () => {
  const result = solveDampedLayout(
    [cluster('frame', 0, { pinned: true }), cluster('st', 12)],
    [{ a: 'frame', b: 'st', axis: 0, minClearanceMm: 30 }]
  );
  assert.equal(result.converged, true);
  assert.equal(result.travel.frame, 0, '机架必须钉死');
  assert.ok(result.travel.st > 0, '工位必须真的挪了');
});

test('空间根本不够（不可行）：必须如实报不收敛，不许假装成功', () => {
  // 两端钉死在 0 和 40，中间塞一个 20 宽的件，却要求每边净距 15 → 需要 50，实际只有 20
  const result = solveDampedLayout(
    [cluster('left', 0, { pinned: true }), cluster('mid', 20), cluster('right', 40, { pinned: true })],
    [
      { a: 'left', b: 'mid', axis: 0, minClearanceMm: 15 },
      { a: 'mid', b: 'right', axis: 0, minClearanceMm: 15 }
    ],
    { maxIterations: 40 }
  );
  assert.equal(result.converged, false, '不可行场景不得报收敛');
  assert.ok(result.maxViolationMm > 0, '必须给出剩余违规量');
});

test('可行但夹在中间的件：阻尼版收敛，且不比无阻尼挪得更多', () => {
  const clusters = () => [
    cluster('left', 0, { pinned: true }),
    cluster('mid', 18),
    cluster('right', 80, { pinned: true })
  ];
  const constraints = [
    { a: 'left', b: 'mid', axis: 0, minClearanceMm: 20, targetGapMm: 20 },
    { a: 'mid', b: 'right', axis: 0, minClearanceMm: 20 }
  ];
  const damped = solveDampedLayout(clusters(), constraints, { maxIterations: 60 });
  const raw = solveDampedLayout(clusters(), constraints, { maxIterations: 60, flipDamping: false });

  assert.equal(damped.converged, true, `阻尼版应收敛，实际 history=${damped.history.join(',')}`);
  assert.equal(raw.converged, true, '无阻尼在可行场景也应能收敛（对照）');
  assert.ok(
    damped.travel.mid <= raw.travel.mid + 0.001,
    `阻尼版位移 ${damped.travel.mid} 不应超过无阻尼 ${raw.travel.mid}`
  );
});

test('朝向相反的两条软约束不会把硬约束顶回去（非对称权重）', () => {
  // mid 被左边拉近（软），但右边有硬净距要求；硬约束优先
  const result = solveDampedLayout(
    // 两端 0 / 80，件半宽 10 + 半宽 10，要求每边净距 20 → 正好需要 80，属于「刚好可行」
    [cluster('left', 0, { pinned: true }), cluster('mid', 26), cluster('right', 80, { pinned: true })],
    [
      { a: 'left', b: 'mid', axis: 0, minClearanceMm: 20, targetGapMm: 20 },
      { a: 'mid', b: 'right', axis: 0, minClearanceMm: 20, targetGapMm: 20 }
    ]
  );
  assert.equal(result.converged, true);
  assert.ok(result.maxViolationMm <= 0.05);
});

test('每轮违规量写进 history，便于排查震荡', () => {
  const result = solveDampedLayout(
    [cluster('a', 0, { pinned: true }), cluster('b', 6)],
    [{ a: 'a', b: 'b', axis: 1, minClearanceMm: 4 }],
    { maxIterations: 10 }
  );
  assert.ok(result.history.length > 0);
  assert.ok(result.history.every((value) => value >= 0));
});
