import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMotionEnvelope } from '../../src/machine/motion-envelope.ts';
import { poseAt, buildLinkage } from '../../src/machine/linkage.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

// Frozen pre-optimization source snapshot; only TypeScript annotations removed.
// Keep this independent of the production helpers so deep equality detects drift.
const halfExtents = (part, extraRotDeg) => {
  const shape = part.shape ?? {};
  const rot = ((Number(part.rotationZDeg) || 0) + extraRotDeg) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  if (shape.type === 'cylinder') {
    const r = Number(shape.radius) || 0;
    const length = Number(shape.length) || 0;
    if (String(shape.axis ?? 'z') === 'z') return [r, r, length / 2];
    if (String(shape.axis) === 'x') return [length / 2, r, r];
    return [r, length / 2, r];
  }
  const size = Array.isArray(shape.size) ? shape.size : [0, 0, 0];
  const hx = (Number(size[0]) || 0) / 2;
  const hy = (Number(size[1]) || 0) / 2;
  const hz = (Number(size[2]) || 0) / 2;
  return [hx * cos + hy * sin, hx * sin + hy * cos, hz];
};
const boxOf = (part, pose) => {
  const id = String(part.id);
  const offset = pose.offsets[id] ?? [0, 0, 0];
  const rotZ = pose.rotZDeg[id] ?? 0;
  const [hx, hy, hz] = halfExtents(part, rotZ);
  const center = Array.isArray(part.center) ? part.center : [0, 0, 0];
  const cx = (Number(center[0]) || 0) + offset[0];
  const cy = (Number(center[1]) || 0) + offset[1];
  const cz = (Number(center[2]) || 0) + offset[2];
  return { id, stationId: String(part.stationId ?? ''), actuatorId: String(part.actuatorId ?? ''),
    min: [cx - hx, cy - hy, cz - hz], max: [cx + hx, cy + hy, cz + hz] };
};
const overlap = (a, b) => {
  const depths = [
    { axis: 'x', depth: Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) },
    { axis: 'y', depth: Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]) },
    { axis: 'z', depth: Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]) }
  ];
  if (depths.some((item) => item.depth <= 0)) return null;
  return depths.reduce((worst, item) => (item.depth < worst.depth ? item : worst));
};
const scopeOf = (a, b) => {
  if (a.actuatorId && a.actuatorId === b.actuatorId) return 'intra-station';
  const sa = a.stationId;
  const sb = b.stationId;
  if (sa && sb && sa === sb) return 'intra-station';
  if (!sa || !sb) return 'frame';
  return 'cross-station';
};
export function referenceMotionEnvelope(geometry, linkage, options = {}) {
  const parts = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const frameCount = Math.max(8, Math.min(240, options.frameCount ?? 60));
  const minDepth = options.minDepthMm ?? 1;
  const movedParts = new Set();
  for (const axis of linkage.axes) for (const partId of axis.partIds) movedParts.add(partId);
  const seen = new Map();
  let intraStation = 0;
  let maxDepthMm = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const tMs = Math.round((linkage.cycleMs * frame) / frameCount);
    const pose = poseAt(linkage, tMs);
    const boxes = parts.map((part) => boxOf(part, pose));
    for (let i = 0; i < boxes.length; i += 1) {
      const a = boxes[i];
      if (!a) continue;
      const aMoving = movedParts.has(a.id);
      for (let j = i + 1; j < boxes.length; j += 1) {
        const b = boxes[j];
        if (!b) continue;
        if (!aMoving && !movedParts.has(b.id)) continue;
        const hit = overlap(a, b);
        if (!hit || hit.depth < minDepth) continue;
        const scope = scopeOf(a, b);
        if (scope === 'intra-station' && a.actuatorId && a.actuatorId === b.actuatorId) continue;
        const key = `${a.id}|${b.id}`;
        const previous = seen.get(key);
        if (previous && previous.depthMm >= hit.depth) continue;
        seen.set(key, { tMs, a: a.id, b: b.id, axis: hit.axis, depthMm: Math.round(hit.depth * 10) / 10, scope });
        if (scope === 'intra-station') intraStation += 1;
        maxDepthMm = Math.max(maxDepthMm, hit.depth);
      }
    }
  }
  const all = [...seen.values()].sort((left, right) => right.depthMm - left.depthMm);
  const suspects = all.filter((item) => item.scope !== 'intra-station');
  return { frames: frameCount, parts: parts.length, pairs: all.length, suspects,
    intraStation: all.length - suspects.length, maxDepthMm: Math.round(maxDepthMm * 10) / 10,
    note: 'AABB 扫掠初筛：只说明「疑似」，要确认必须做真实布尔；不含加减速与超程。' };
}

export function generatedFixture(stationCount) {
  const design = synthMachine(parseMachineBrief('锁螺丝机，节拍 20 件/分钟，每工位 1 个 SMC 气爪'), { stationCount });
  const geometry = generateMachineGeometry(design);
  return { geometry, linkage: buildLinkage(geometry, { cycleMs: 3000 }) };
}

export function randomFixture(seed, count = 36) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const value = () => pick([0, -0, 0.049, 0.05, 0.951, 1, 1.049, 1.05, 10, 20, -2, '12', null, undefined]);
  const parts = Array.from({ length: count }, (_, i) => ({
    id: i > 2 && i % 13 === 0 ? 'p0' : `p${i}`,
    stationId: pick(['', 's0', 's1', 's2', null]), actuatorId: pick(['', 'shared', 'a', null]),
    center: [pick([0, 1, -1, 10, 19.95, 20, 20.001]), random() * 15 - 7.5, random() * 10 - 5],
    rotationZDeg: pick([0, 45, 90, -90, 180, 359.95, '30']),
    shape: random() < 0.3 ? { type: 'cylinder', radius: value(), length: value(), axis: pick(['x', 'y', 'z', 'other', undefined]) }
      : { type: 'box', size: [value(), value(), value()] }
  }));
  const axes = Array.from({ length: 4 }, (_, i) => ({
    actuatorId: `axis${i}`, stationId: `s${i % 3}`, kind: pick(['linear', 'rotary', 'gripper']),
    partIds: parts.filter((_, j) => j % 7 === i).map((part) => part.id),
    strokeMm: pick([0, 0.1, 2.05, 20, -10]), rangeDeg: pick([0, 45, 90, 270, -137.5]),
    durationMs: 500, home: 'zero', pivot: [1, -2, 0], axis: [1, 0.5, -1],
    // p6 is deliberately posed without belonging to partIds.
    jaws: [{ partId: 'p6', sign: 1 }, { partId: `p${i}`, sign: -1 }]
  }));
  const geometry = { parts, moving: axes };
  return { geometry, linkage: buildLinkage(geometry, { cycleMs: 1600 }) };
}

export function assertEquivalent(fixture, options = {}, label = '') {
  assert.deepStrictEqual(checkMotionEnvelope(fixture.geometry, fixture.linkage, options),
    referenceMotionEnvelope(fixture.geometry, fixture.linkage, options), label);
}

// Benchmark imports the frozen oracle and fixtures without registering unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const stations of [2, 6, 12]) test(`exact reference equality: generated ${stations} stations`, () => {
    const fixture = generatedFixture(stations);
    for (const frameCount of [8, 60, 240]) assertEquivalent(fixture, { frameCount });
  });

  test('deterministic randomized adversarial geometry matches frozen source', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const fixture = randomFixture(seed);
      assertEquivalent(fixture, { frameCount: seed % 3 === 0 ? 17.5 : 8 + seed % 53,
        minDepthMm: [0, 0.05, 1, 1.05, -1, NaN][seed % 6] }, `seed ${seed}`);
    }
  });

  test('ties, original orientation, same-actuator skip, touching and rounding', () => {
    const parts = ['static-first', 'moving', 'equal', 'same-actuator', 'touching'].map((id, i) => ({
      id, center: [i === 4 ? 20 : 0, 0, 0], stationId: `s${i}`,
      actuatorId: i === 1 || i === 3 ? 'shared' : '', shape: { type: 'box', size: [20, 20, 20] }
    }));
    const geometry = { parts, moving: [{ actuatorId: 'axis', stationId: 's1', kind: 'linear', partIds: ['moving'],
      strokeMm: 0, rangeDeg: 0, durationMs: 500 }] };
    const fixture = { geometry, linkage: buildLinkage(geometry) };
    assertEquivalent(fixture, { minDepthMm: 0 });
    const result = checkMotionEnvelope(geometry, fixture.linkage, { minDepthMm: 0 });
    assert.deepEqual(result.suspects.map(({ a, b, axis }) => [a, b, axis]),
      [['static-first', 'moving', 'x'], ['moving', 'equal', 'x']]);
    for (const shift of [18.951, 18.95, 18.949, 19.001, 19, 20, 20.001]) {
      parts[0].center[0] = shift;
      assertEquivalent(fixture, { frameCount: 17, minDepthMm: 1 });
    }
  });

  test('raw depth is compared against previous rounded depth before replacement', () => {
    for (const [depth, expectedTime] of [[1.049, 875], [1.051, 0]]) {
      const geometry = { parts: [
        { id: 'a', stationId: 's1', center: [0, 0, 0], shape: { type: 'box', size: [20, 20, 20] } },
        { id: 'b', stationId: 's2', center: [20 - depth, 0, 0], shape: { type: 'box', size: [20, 20, 20] } }
      ], moving: [{ actuatorId: 'axis', stationId: 's1', kind: 'linear', partIds: ['a'],
        strokeMm: 0, rangeDeg: 0, durationMs: 500 }] };
      const fixture = { geometry, linkage: buildLinkage(geometry, { cycleMs: 1000 }) };
      assertEquivalent(fixture, { frameCount: 8 });
      assert.equal(checkMotionEnvelope(geometry, fixture.linkage, { frameCount: 8 }).suspects[0].tMs, expectedTime);
    }
  });

  test('non-finite extents and duplicate IDs retain baseline comparison semantics', () => {
    const fixture = randomFixture(0xdecafbad);
    fixture.geometry.parts[0].shape = { type: 'box', size: [Infinity, 20, 20] };
    fixture.geometry.parts[1].rotationZDeg = Infinity;
    fixture.geometry.parts[2].center[1] = Infinity;
    for (const frameCount of [NaN, 8, 240.5]) assertEquivalent(fixture, { frameCount, minDepthMm: NaN });
  });

  test('empty, static-only and sparse inputs retain results', () => {
    for (const geometry of [null, {}, { parts: [] }, { parts: new Array(5) },
      { parts: [{ id: 'static', shape: {}, center: [] }] }]) {
      assertEquivalent({ geometry, linkage: buildLinkage({}) });
    }
  });
}
