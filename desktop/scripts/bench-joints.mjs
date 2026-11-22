// Joint-rule precomputation benchmark and full-report equivalence check.
//
// The frozen pre-optimization implementation lives in
// `test-support/joints-baseline.ts`. To measure end-to-end interference and
// clearance (which import `machine/joints.ts` internally), this script copies
// `src/` to a temporary directory inside the workspace and mounts the frozen
// file as production `joints.ts`. The copy is removed in `finally` (and again
// on exit); no dependency symlink or Git metadata is touched.
//
// Usage: node --expose-gc scripts/bench-joints.mjs
// Output: one JSON document on stdout. Exit code 1 if any ordered result differs.

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { rmSync as rmSyncOnExit } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearanceFixture } from '../test-support/clearance-fixture.mjs';
import {
  REAL_MACHINE_BRIEFS,
  denseFixture,
  namedDenseJointFixture,
  namedJointFixture
} from '../test-support/joints-fixture.mjs';
import { parseMachineBrief } from '../src/machine/spec.ts';
import { synthMachine } from '../src/machine/synth.ts';
import { resolveMachineGeometry } from '../src/machine/machine-geometry.ts';

const ITERATIONS = Number(process.env.JOINTS_BENCH_ITERATIONS ?? 7);
if (!Number.isInteger(ITERATIONS) || ITERATIONS < 3 || ITERATIONS > 30) {
  throw new Error('JOINTS_BENCH_ITERATIONS must be an integer in 3..30');
}

const desktopRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(desktopRoot, 'src');
const baselinePath = join(desktopRoot, 'test-support', 'joints-baseline.ts');

// Instrumentation mirror of the production candidate filter. It is used only
// to report candidate scale; every result is also compared against the frozen
// implementation, so this cannot mask a matching regression.
const RULE_PATTERNS = [
  [/^frame-leg-\d+$/, /^frame-stringer-/],
  [/^frame-leg-\d+$/, /^frame-top$/],
  [/-upright-[lr]$/, /-plate$/],
  [/-beam$/, /-upright-[lr]$/],
  [/-mount$/, /-(body|base)$/],
  [/^conveyor-frame$/, /^conveyor-(belt|motor)$/]
];
function bracketStem(id) {
  const match = /^(sensor-.+)-bracket$/.exec(id);
  return match ? match[1] : null;
}
function bodyHasStem(id, stems) {
  return stems.has(id)
    || (id.endsWith('-tx') && stems.has(id.slice(0, -3)))
    || (id.endsWith('-rx') && stems.has(id.slice(0, -3)));
}
function candidateStats(parts) {
  const ids = parts.map((part) => String(part?.id ?? ''));
  const stems = new Set();
  for (const id of ids) {
    const stem = bracketStem(id);
    if (stem !== null) stems.add(stem);
  }
  let participants = 0;
  for (const id of ids) {
    const ruleParticipant = RULE_PATTERNS.some(([a, b]) => a.test(id) || b.test(id));
    const stem = bracketStem(id);
    const sensorBody = stem === null && id.startsWith('sensor-');
    if (ruleParticipant || stem !== null || (sensorBody && bodyHasStem(id, stems))) participants += 1;
  }
  const allPairs = ids.length * (ids.length - 1) / 2;
  const candidatePairs = participants * (participants - 1) / 2;
  return { parts: ids.length, participantParts: participants, allPairs, candidatePairs };
}

function summarize(times, result) {
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];
  return { p50Ms: +p50.toFixed(3), p95Ms: +p95.toFixed(3), result };
}

/**
 * Alternate baseline/current order each sample so CPU frequency drift or
 * one-off cache effects do not consistently favour either implementation.
 */
function samplePair(baselineFn, currentFn, samples) {
  baselineFn();
  currentFn();
  baselineFn();
  currentFn();
  const baselineTimes = [];
  const currentTimes = [];
  let baselineResult;
  let currentResult;
  for (let index = 0; index < samples; index += 1) {
    const currentFirst = index % 2 === 1;
    if (currentFirst) {
      global.gc?.();
      let start = performance.now();
      currentResult = currentFn();
      currentTimes.push(performance.now() - start);
      global.gc?.();
      start = performance.now();
      baselineResult = baselineFn();
      baselineTimes.push(performance.now() - start);
    } else {
      global.gc?.();
      let start = performance.now();
      baselineResult = baselineFn();
      baselineTimes.push(performance.now() - start);
      global.gc?.();
      start = performance.now();
      currentResult = currentFn();
      currentTimes.push(performance.now() - start);
    }
  }
  return {
    baseline: summarize(baselineTimes, baselineResult),
    current: summarize(currentTimes, currentResult)
  };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashJson = (value) => sha256(JSON.stringify(value));

function compareJoints(current, baseline) {
  const currentJson = JSON.stringify(current);
  const baselineJson = JSON.stringify(baseline);
  return {
    equal: currentJson === baselineJson,
    baselineSha256: sha256(baselineJson),
    currentSha256: sha256(currentJson),
    baselineCount: baseline.length,
    currentCount: current.length
  };
}

function compareReport(current, baseline) {
  const currentJson = JSON.stringify(current);
  const baselineJson = JSON.stringify(baseline);
  return {
    equal: currentJson === baselineJson,
    baselineSha256: sha256(baselineJson),
    currentSha256: sha256(currentJson),
    baselineCount: baseline.pairs.length,
    currentCount: current.pairs.length
  };
}

const scenarios = [
  ['sparse-500', clearanceFixture(500)],
  ['sparse-1000', clearanceFixture(1000)],
  ['dense-500', denseFixture(500)],
  ['dense-1000', denseFixture(1000)],
  ['named-sparse-500', namedJointFixture(500)],
  ['named-sparse-1000', namedJointFixture(1000)],
  ['named-dense-500', namedDenseJointFixture(500)],
  ['named-dense-1000', namedDenseJointFixture(1000)]
];
for (const brief of REAL_MACHINE_BRIEFS) {
  const geometry = resolveMachineGeometry(synthMachine(parseMachineBrief(brief))).geometry;
  scenarios.push([`real-${geometry.parts.length}`, geometry]);
}

const tempRoot = await mkdtemp(join(desktopRoot, '.bench-joints-'));
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await rm(tempRoot, { recursive: true, force: true });
};
process.once('exit', () => {
  if (!cleaned) {
    try { rmSyncOnExit(tempRoot, { recursive: true, force: true }); } catch {}
  }
});

try {
  const tempSrc = join(tempRoot, 'src');
  await cp(sourceRoot, tempSrc, { recursive: true, dereference: false });
  const baselineSource = await readFile(baselinePath, 'utf8');
  await cp(baselinePath, join(tempSrc, 'machine', 'joints.ts'));

  const currentJoints = await import(pathToFileURL(join(sourceRoot, 'machine', 'joints.ts')).href);
  const currentInterference = await import(pathToFileURL(join(sourceRoot, 'machine', 'interference.ts')).href);
  const currentClearance = await import(pathToFileURL(join(sourceRoot, 'machine', 'clearance.ts')).href);
  const baselineJoints = await import(pathToFileURL(join(tempSrc, 'machine', 'joints.ts')).href);
  const baselineInterference = await import(pathToFileURL(join(tempSrc, 'machine', 'interference.ts')).href);
  const baselineClearance = await import(pathToFileURL(join(tempSrc, 'machine', 'clearance.ts')).href);

  if (baselineSource.toUpperCase().includes('PRE-OPTIMIZATION')) {
    process.stderr.write('using frozen pre-optimization joints baseline\n');
  }

  const results = [];
  for (const [label, geometry] of scenarios) {
    process.stderr.write(`scenario ${label}\n`);
    const stats = candidateStats(geometry.parts);
    const jointSamples = samplePair(
      () => baselineJoints.declaredJoints(geometry.parts),
      () => currentJoints.declaredJoints(geometry.parts),
      ITERATIONS
    );
    const baselineJointSample = jointSamples.baseline;
    const currentJointSample = jointSamples.current;
    const jointCompare = compareJoints(currentJointSample.result, baselineJointSample.result);

    const interferenceSamples = samplePair(
      () => baselineInterference.screenInterference(geometry),
      () => currentInterference.screenInterference(geometry),
      ITERATIONS
    );
    const baselineInterferenceSample = interferenceSamples.baseline;
    const currentInterferenceSample = interferenceSamples.current;
    const interferenceCompare = compareReport(
      currentInterferenceSample.result, baselineInterferenceSample.result
    );

    const clearanceSamples = samplePair(
      () => baselineClearance.screenClearance(geometry),
      () => currentClearance.screenClearance(geometry),
      ITERATIONS
    );
    const baselineClearanceSample = clearanceSamples.baseline;
    const currentClearanceSample = clearanceSamples.current;
    const clearanceCompare = compareReport(
      currentClearanceSample.result, baselineClearanceSample.result
    );

    results.push({
      label,
      ...stats,
      joints: {
        baseline: { p50Ms: baselineJointSample.p50Ms, p95Ms: baselineJointSample.p95Ms },
        current: { p50Ms: currentJointSample.p50Ms, p95Ms: currentJointSample.p95Ms },
        speedup: +(baselineJointSample.p50Ms / currentJointSample.p50Ms).toFixed(2),
        ...jointCompare
      },
      interference: {
        baseline: {
          p50Ms: baselineInterferenceSample.p50Ms,
          p95Ms: baselineInterferenceSample.p95Ms,
          pairs: baselineInterferenceSample.result.pairs.length
        },
        current: {
          p50Ms: currentInterferenceSample.p50Ms,
          p95Ms: currentInterferenceSample.p95Ms,
          pairs: currentInterferenceSample.result.pairs.length
        },
        speedup: +(baselineInterferenceSample.p50Ms / currentInterferenceSample.p50Ms).toFixed(2),
        ...interferenceCompare
      },
      clearance: {
        baseline: {
          p50Ms: baselineClearanceSample.p50Ms,
          p95Ms: baselineClearanceSample.p95Ms,
          pairs: baselineClearanceSample.result.pairs.length
        },
        current: {
          p50Ms: currentClearanceSample.p50Ms,
          p95Ms: currentClearanceSample.p95Ms,
          pairs: currentClearanceSample.result.pairs.length
        },
        speedup: +(baselineClearanceSample.p50Ms / currentClearanceSample.p50Ms).toFixed(2),
        ...clearanceCompare
      },
      equivalent: jointCompare.equal && interferenceCompare.equal && clearanceCompare.equal
    });
  }

  const output = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    iterations: ITERATIONS,
    gcExposed: typeof global.gc === 'function',
    baseline: 'desktop/test-support/joints-baseline.ts',
    scenarios: results,
    allEquivalent: results.every((row) => row.equivalent)
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.allEquivalent) process.exitCode = 1;
} finally {
  await cleanup();
}
