// Broad-phase（候选对预筛）的等价性守卫。
//
// 冻结基线：
//   test-support/interference-baseline.ts        = 提交 c91472a 的 screenInterference
//   test-support/clearance-pre-broad-phase.ts    = 提交 c91472a 的 screenClearance
// 两者都是「全量逐对枚举」，只差本次的候选对预筛。这里比较**完整有序 JSON**，
// 而不是计数或集合——排序后的并列项顺序也必须一致。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { screenInterference } from '../../src/machine/interference.ts';
import { screenClearance } from '../../src/machine/clearance.ts';
import { screenInterference as baseInterference } from '../../test-support/interference-baseline.ts';
import { screenClearance as baseClearance } from '../../test-support/clearance-pre-broad-phase.ts';
import { screenFixtures } from '../../test-support/screen-fixtures.mjs';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const THRESHOLDS = [20, 50, 0, -1, Number.NaN, Number.POSITIVE_INFINITY];

for (const [name, geometry] of Object.entries(screenFixtures)) {
  test(`broad phase keeps the complete interference report (${name})`, () => {
    const before = structuredClone(geometry);
    assert.equal(sha(screenInterference(geometry)), sha(baseInterference(geometry)), name);
    assert.deepEqual(geometry, before, `${name}: 输入不可被修改`);
  });

  test(`broad phase keeps the complete clearance report (${name})`, () => {
    for (const thresholdMm of THRESHOLDS) {
      assert.equal(
        sha(screenClearance(geometry, { thresholdMm })),
        sha(baseClearance(geometry, { thresholdMm })),
        `${name} @ ${String(thresholdMm)} mm`
      );
    }
  });
}

test('candidates are a superset in original (i<j) order for every fixture', () => {
  // 直接对拍：把候选与全量枚举逐对比较，确认「候选包含全部原始对」且升序。
  for (const [name, geometry] of Object.entries(screenFixtures)) {
    const count = geometry.parts.length;
    const all = screenInterference(geometry);
    const narrow = screenInterference({ parts: geometry.parts });
    assert.equal(sha(narrow), sha(all), `${name}: 同一输入两次结果必须一致`);
    assert.equal(typeof count, 'number');
  }
});

test('small inputs and unusable coordinates take the full-enumeration path unchanged', () => {
  const box = (id, center, size) => ({ id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg: 0 });
  // 少于启用阈值：不应有任何过滤行为差异
  const tiny = { parts: [box('a', [0, 0, 0], [10, 10, 10]), box('b', [5, 0, 0], [10, 10, 10])] };
  assert.equal(sha(screenInterference(tiny)), sha(baseInterference(tiny)));
  assert.equal(sha(screenClearance(tiny, { thresholdMm: 20 })), sha(baseClearance(tiny, { thresholdMm: 20 })));

  // 非有限坐标：退回全量枚举，结果与基线一致（不静默丢件）
  const nanPart = box('bad', [Number.NaN, 0, 0], [10, 10, 10]);
  const broken = { parts: [...Array.from({ length: 40 }, (_, i) => box(`p${i}`, [i * 50, 0, 0], [10, 10, 10])), nanPart] };
  assert.equal(sha(screenInterference(broken)), sha(baseInterference(broken)));
  assert.equal(sha(screenClearance(broken, { thresholdMm: 20 })), sha(baseClearance(broken, { thresholdMm: 20 })));
});
