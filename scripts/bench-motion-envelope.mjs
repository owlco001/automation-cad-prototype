#!/usr/bin/env node
// Run from any directory with Node's TypeScript support:
// node scripts/bench-motion-envelope.mjs [samples=30] [warmups=8]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { checkMotionEnvelope } from '../desktop/src/machine/motion-envelope.ts';
import { referenceMotionEnvelope, generatedFixture, randomFixture, assertEquivalent }
  from '../desktop/test/machine/motion-envelope-performance.test.mjs';

const integerArgument = (index, fallback) => {
  const value = Number(process.argv[index] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error('samples and warmups must be positive integers');
  return value;
};
const samples = integerArgument(2, 30);
const warmups = integerArgument(3, 8);
const options = { frameCount: 60 };
const fixtures = [2, 6, 12].map((stations) => ({ name: `${stations} stations`, ...generatedFixture(stations) }));
fixtures.push({ name: 'adversarial seed 0xdecafbad', ...randomFixture(0xdecafbad, 160) });
// Extra static detail highlights the avoided static-static pair work.
const staticHeavy = generatedFixture(12);
staticHeavy.geometry = { ...staticHeavy.geometry, parts: [...staticHeavy.geometry.parts,
  ...Array.from({ length: 800 }, (_, i) => ({ id: `detail-${i}`, stationId: '',
    center: [i * 3, -2000, 0], shape: { type: 'box', size: [2, 2, 2] } }))] };
fixtures.push({ name: '12 stations + 800 static details', ...staticHeavy });

const percentile = (values, fraction) => values[Math.ceil(values.length * fraction) - 1];
const measure = (fn, fixture) => {
  const start = performance.now();
  const result = fn(fixture.geometry, fixture.linkage, options);
  const elapsed = performance.now() - start;
  assert.equal(result.frames, 60); // Consume the result; no timing assertion.
  return elapsed;
};
console.log(`Motion envelope: ${warmups} warmups, ${samples} samples per implementation; 60 frames`);
console.log(`Node ${process.version}; ${process.platform}/${process.arch}; timings include per-call cache construction`);
const rows = [];
for (const fixture of fixtures) {
  assertEquivalent(fixture, options, fixture.name);
  for (let i = 0; i < warmups; i += 1) {
    measure(referenceMotionEnvelope, fixture);
    measure(checkMotionEnvelope, fixture);
  }
  const baseline = [];
  const optimized = [];
  // Alternate order to reduce systematic order/GC bias.
  for (let i = 0; i < samples; i += 1) {
    if (i % 2 === 0) {
      baseline.push(measure(referenceMotionEnvelope, fixture));
      optimized.push(measure(checkMotionEnvelope, fixture));
    } else {
      optimized.push(measure(checkMotionEnvelope, fixture));
      baseline.push(measure(referenceMotionEnvelope, fixture));
    }
  }
  baseline.sort((a, b) => a - b);
  optimized.sort((a, b) => a - b);
  const baseP50 = percentile(baseline, 0.5);
  const optP50 = percentile(optimized, 0.5);
  rows.push({ fixture: fixture.name, parts: fixture.geometry.parts.length,
    'baseline p50 ms': baseP50.toFixed(3), 'baseline p95 ms': percentile(baseline, 0.95).toFixed(3),
    'optimized p50 ms': optP50.toFixed(3), 'optimized p95 ms': percentile(optimized, 0.95).toFixed(3),
    'p50 speedup': `${(baseP50 / optP50).toFixed(2)}x` });
}
console.table(rows);
console.log('All benchmark fixtures are deeply equal to the frozen pre-optimization reference.');
