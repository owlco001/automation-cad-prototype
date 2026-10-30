import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../../scripts/explain-pair.mjs', import.meta.url).pathname;

const writeCase = (parts, pairs = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-pair-'));
  const file = join(dir, 'case.json');
  writeFileSync(file, JSON.stringify({ geometry: { parts, interference: { pairs } } }));
  return file;
};

const run = (args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }));

test('explain-pair：不带旋转时，重叠量 = 建议位移 - 1 mm 间隙', () => {
  const file = writeCase([
    { id: 'a', shape: { type: 'box', size: [50, 50, 300] }, center: [0, 0, 150] },
    { id: 'b', shape: { type: 'box', size: [100, 100, 12] }, center: [0, 70, 294] }
  ]);
  const row = run([file, 'a', 'b']);
  assert.equal(row.minOverlapMm, 5);          // Y 向压进去 5 mm（x 50 / y 5 / z 12，取最小）
  assert.equal(row.axis, 'y');
  assert.equal(row.suggestedMoveMm, 6);       // 5 + 1 mm 间隙
  assert.equal(row.rotatedAabbInflated, false);
});

test('explain-pair：旋转 60° 的柱子包围盒被撑大，重叠量与建议位移都跟着变', () => {
  // 同一对零件，只把立柱绕 Z 转 60°：50×50 的轴对齐盒变成约 68.3 宽
  const straight = writeCase([
    { id: 'upright', shape: { type: 'box', size: [50, 50, 300] }, center: [0, 0, 150] },
    { id: 'table', shape: { type: 'cylinder', radius: 70, length: 12 }, center: [0, 90, 150] }
  ]);
  const rotated = writeCase([
    { id: 'upright', shape: { type: 'box', size: [50, 50, 300] }, center: [0, 0, 150], rotationZDeg: 60 },
    { id: 'table', shape: { type: 'cylinder', radius: 70, length: 12 }, center: [0, 90, 150], rotationZDeg: 60 }
  ]);
  const a = run([straight, 'upright', 'table']);
  const b = run([rotated, 'upright', 'table']);
  assert.ok(b.rotatedAabbInflated);
  // 圆柱自身包围盒不随 Z 旋转变化，撑大的只有柱子那一侧：
  // 50×50 转 60° 后半宽 25×(cos60+sin60)=34.15，Y 向重叠从 5 涨到 14.2
  assert.ok(b.overlaps[1] > a.overlaps[1], `Y 向重叠应变大：${a.overlaps[1]} -> ${b.overlaps[1]}`);
  assert.equal(b.overlaps[1], 14.2);
  assert.equal(a.overlaps[0], 50);
});

test('explain-pair：--all-suspects 只列 suspect，并带上方案里原有的建议位移', () => {
  const file = writeCase(
    [
      { id: 'a', shape: { type: 'box', size: [10, 10, 10] }, center: [0, 0, 5] },
      { id: 'b', shape: { type: 'box', size: [10, 10, 10] }, center: [0, 5, 5] },
      { id: 'c', shape: { type: 'box', size: [10, 10, 10] }, center: [500, 500, 5] }
    ],
    [
      { kind: 'suspect', a: 'a', b: 'b', suggestion: { partId: 'b', axis: 'y', delta: 6 } },
      { kind: 'declared', a: 'a', b: 'c', reason: '不相关' }
    ]
  );
  const out = run([file, '--all-suspects']);
  assert.equal(out.suspects, 1);
  assert.equal(out.rows[0].suggestedMoveMm, out.rows[0].reportedSuggestion.delta, '算出来的位移必须和管线报的一致');
});
