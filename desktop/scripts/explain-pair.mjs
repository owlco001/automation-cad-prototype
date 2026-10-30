#!/usr/bin/env node
// 对账工具：为什么这两件被判干涉？
//
// 起因：六工位报出 8 对 `upright × rotary-table / nest`，建议位移 9.9 / 5.0 mm。
// 我一开始把「建议位移」当成了穿模深度，去核对包围盒却算出负重叠（根本不重叠）——
// 因为漏了 `rotationZDeg`：工位整体绕 Z 转了 60°，薄柱子的轴对齐包围盒会被撑大。
//
// 这个脚本把一对应有的三个数一次算清：
//   - 每轴重叠多少（含旋转后的包围盒）
//   - 最小重叠轴 = 判干涉用的那根轴
//   - 建议位移 = 最小重叠 + GAP，不是穿模深度
//
// 用法：
//   node scripts/explain-pair.mjs <case.json> <partA> <partB>
//   node scripts/explain-pair.mjs <case.json> --all-suspects

import { readFileSync } from 'node:fs';

const GAP = 1.0;  // 与 interference.ts 的 GAP 一致：分开后还要留 1 mm

const halfExtents = (part) => {
  const shape = part.shape ?? {};
  if (shape.type === 'box') {
    const [x, y, z] = shape.size;
    return [x / 2, y / 2, z / 2];
  }
  const radius = Number(shape.radius) || 0;
  const length = Number(shape.length) || 0;
  if (shape.axis === 'x') return [length / 2, radius, radius];
  if (shape.axis === 'y') return [radius, length / 2, radius];
  return [radius, radius, length / 2];
};

const bounds = (part) => {
  const [hx, hy, hz] = halfExtents(part);
  const rad = ((Number(part.rotationZDeg) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const isCylinder = part?.shape?.type === 'cylinder';
  // 圆柱绕自身 Z 轴转不改变包围盒；方块要按旋转后的 AABB 算
  const ex = isCylinder ? hx : hx * cos + hy * sin;
  const ey = isCylinder ? hy : hx * sin + hy * cos;
  const [cx, cy, cz] = part.center;
  return { min: [cx - ex, cy - ey, cz - hz], max: [cx + ex, cy + ey, cz + hz] };
};

const axes = ['x', 'y', 'z'];

const explain = (a, b) => {
  const ba = bounds(a);
  const bb = bounds(b);
  const overlaps = axes.map((_, i) => Math.min(ba.max[i], bb.max[i]) - Math.max(ba.min[i], bb.min[i]));
  const minOverlap = Math.min(...overlaps);
  const axisIndex = overlaps.indexOf(minOverlap);
  const rotated = [a, b].some((part) => Number(part.rotationZDeg) || 0);
  return {
    a: a.id,
    b: b.id,
    aRot: Number(a.rotationZDeg) || 0,
    bRot: Number(b.rotationZDeg) || 0,
    aSize: halfExtents(a).map((v) => v * 2),
    bSize: halfExtents(b).map((v) => v * 2),
    overlaps: overlaps.map((v) => Math.round(v * 10) / 10),
    minOverlapMm: Math.round(minOverlap * 10) / 10,
    axis: axes[axisIndex],
    // 建议位移 = 最小重叠 + GAP。把它当穿模深度是错的，这里直接写清楚。
    suggestedMoveMm: Math.round((minOverlap + GAP) * 10) / 10,
    rotatedAabbInflated: rotated
  };
};

const [file, argA, argB] = process.argv.slice(2);
if (!file || !argA) {
  console.error('用法：node scripts/explain-pair.mjs <case.json> <partA> <partB> | --all-suspects');
  process.exit(2);
}

const document = JSON.parse(readFileSync(file, 'utf8'));
const geometry = document.geometry ?? document;
const parts = new Map((geometry.parts ?? []).map((part) => [part.id, part]));

if (argA === '--all-suspects') {
  const suspects = (geometry.interference?.pairs ?? []).filter((pair) => pair.kind === 'suspect');
  if (suspects.length === 0) {
    console.log(JSON.stringify({ suspects: 0, note: '这份方案没有疑似干涉对' }, null, 2));
    process.exit(0);
  }
  const rows = suspects.map((pair) => {
    const a = parts.get(pair.a);
    const b = parts.get(pair.b);
    if (!a || !b) return { a: pair.a, b: pair.b, error: '零件不在 geometry.parts 里' };
    return { ...explain(a, b), reportedSuggestion: pair.suggestion };
  });
  console.log(JSON.stringify({ suspects: rows.length, rows }, null, 2));
  process.exit(0);
}

const a = parts.get(argA);
const b = parts.get(argB);
if (!a || !b) {
  console.error(`找不到零件：${!a ? argA : ''} ${!b ? argB : ''}`);
  process.exit(2);
}
console.log(JSON.stringify(explain(a, b), null, 2));
