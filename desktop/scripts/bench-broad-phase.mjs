// Broad-phase (candidate pair) benchmark and full-report equivalence check.
//
// Compares the current screening against frozen pre-broad-phase oracles in
// `test-support/`: `interference-baseline.ts` and `clearance-pre-broad-phase.ts`.
// Every scenario asserts complete ordered JSON equality before reporting timings.
//
// Usage (from desktop): node --expose-gc scripts/bench-broad-phase.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { screenInterference } from '../src/machine/interference.ts';
import { screenClearance } from '../src/machine/clearance.ts';
import { screenInterference as baselineInterference } from '../test-support/interference-baseline.ts';
import { screenClearance as baselineClearance } from '../test-support/clearance-pre-broad-phase.ts';
import { screenFixtures } from '../test-support/screen-fixtures.mjs';

const ITERATIONS = Number(process.env.BROAD_PHASE_ITERATIONS ?? 7);
if (!Number.isInteger(ITERATIONS) || ITERATIONS < 3 || ITERATIONS > 30) {
  throw new Error('BROAD_PHASE_ITERATIONS must be an integer in 3..30');
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function time(fn, argument) {
  for (let warm = 0; warm < 2; warm++) fn(argument);
  const samples = [];
  for (let index = 0; index < ITERATIONS; index++) {
    const start = performance.now();
    fn(argument);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(3));
}

const scenarios = [
  { label: 'far apart 200', key: 'farApart' },
  { label: 'far apart 1000', key: 'farApartLarge' },
  { label: 'near touch 120', key: 'nearTouch' },
  { label: 'dense cluster 60', key: 'denseCluster' },
  { label: 'mixed 12', key: 'mixed' },
  { label: 'non-finite 3', key: 'withNaN' }
];

const results = [];
for (const { label, key } of scenarios) {
  const geometry = screenFixtures[key];
  const interferenceBefore = baselineInterference(geometry);
  const interferenceAfter = screenInterference(geometry);
  assert.equal(sha(interferenceAfter), sha(interferenceBefore), `${label}: interference report changed`);
  const clearanceRows = [];
  for (const thresholdMm of [20, 50]) {
    const before = baselineClearance(geometry, { thresholdMm });
    const after = screenClearance(geometry, { thresholdMm });
    assert.equal(sha(after), sha(before), `${label}: clearance (${thresholdMm} mm) report changed`);
    clearanceRows.push({
      thresholdMm,
      beforeMs: time(baselineClearance, geometry),
      afterMs: time(screenClearance, geometry)
    });
  }
  results.push({
    label,
    parts: geometry.parts.length,
    pairs: geometry.parts.length * (geometry.parts.length - 1) / 2,
    interferenceHits: interferenceAfter.count,
    interference: {
      beforeMs: time(baselineInterference, geometry),
      afterMs: time(screenInterference, geometry)
    },
    clearance: clearanceRows
  });
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, iterations: ITERATIONS, results }, null, 2));
