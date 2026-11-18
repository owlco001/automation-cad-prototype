import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeBufferCapacity } from '../../src/machine/buffer-capacity.ts';

const base = {
  upstreamCycleSec: 12,
  downstreamCycleSec: 15,
  downstreamStopSec: 120,
  initialOccupancy: 2,
  inTransit: 1,
  reserveSlots: 2
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('12s/15s/120s: ten stop arrivals do not solve sustained imbalance', () => {
  const result = analyzeBufferCapacity({ ...base, capacity: 15 });
  assert.equal(result.worstStopArrivals, 10);
  assert.equal(result.requiredSlots, 15);
  assert.equal(result.occupancyAfterStop, 13);
  close(result.arrivalRatePerSec, 1 / 12);
  close(result.departureRatePerSec, 1 / 15);
  close(result.arrivalRatePerMin, 5);
  close(result.departureRatePerMin, 4);
  close(result.netAccumulationPerMin, 1);
  close(result.sustainedAccumulationPerMin, 1);
  assert.equal(result.sustainedBalance, false);
  assert.equal(result.normalFlow, 'accumulating');
  assert.equal(result.capacitySufficient, true);
  assert.equal(result.capacityShortfall, 0);
  close(result.normalFillTimeSec, 600);
  assert.equal(result.canDrainWhileUpstreamRuns, false);
  assert.equal(result.downstreamCatchupTimeSec, null);
  assert.ok(result.warnings.some(warning => warning.includes('任何有限缓存')));
});

test('faster downstream drains physical occupancy, excluding reserve slots', () => {
  const result = analyzeBufferCapacity({ ...base, downstreamCycleSec: 10, capacity: 20 });
  assert.equal(result.sustainedBalance, true);
  assert.equal(result.normalFlow, 'draining');
  close(result.netAccumulationPerMin, -1);
  assert.equal(result.sustainedAccumulationPerMin, 0);
  assert.equal(result.canDrainWhileUpstreamRuns, true);
  close(result.downstreamCatchupTimeSec, 780);
  assert.equal(result.normalFillTimeSec, null);
});

test('equal cycles avoid sustained growth but cannot recover existing backlog', () => {
  const result = analyzeBufferCapacity({ ...base, downstreamCycleSec: 12 });
  assert.equal(result.normalFlow, 'balanced');
  assert.equal(result.sustainedBalance, true);
  assert.equal(result.netAccumulationPerMin, 0);
  assert.equal(result.canDrainWhileUpstreamRuns, false);
  assert.equal(result.downstreamCatchupTimeSec, null);
  assert.equal(result.normalFillTimeSec, null);
  assert.ok(result.warnings.some(warning => warning.includes('无法排空')));
});

test('unknown capacity stays unknown and does not invent a production horizon', () => {
  const result = analyzeBufferCapacity(base);
  assert.equal(result.capacity, null);
  assert.equal(result.capacitySufficient, null);
  assert.equal(result.capacityShortfall, null);
  assert.equal(result.normalFillTimeSec, null);
  assert.equal(result.requiredSlots, 15);
  assert.ok(result.assumptions.some(value => value.includes('未假定正常生产的有限时长')));
});

test('conservative discrete arrivals respect exact and fractional stop boundaries', () => {
  for (const [downstreamStopSec, expected] of [[0, 0], [0.01, 1], [11.99, 1], [12, 1], [12.01, 2], [120, 10], [120.01, 11]]) {
    assert.equal(analyzeBufferCapacity({ ...base, downstreamStopSec }).worstStopArrivals, expected);
  }
});

test('capacity threshold includes initial occupancy, in transit and reserve exactly once', () => {
  for (const [capacity, sufficient, shortfall] of [[14, false, 1], [15, true, 0], [16, true, 0]]) {
    const result = analyzeBufferCapacity({ ...base, capacity });
    assert.equal(result.capacitySufficient, sufficient);
    assert.equal(result.capacityShortfall, shortfall);
  }
  assert.equal(analyzeBufferCapacity({ ...base, capacity: 4 }).normalFillTimeSec, 0);
  assert.equal(analyzeBufferCapacity({ ...base, capacity: 5 }).normalFillTimeSec, 0);
});

test('zero occupancy, zero stop and zero capacity are valid', () => {
  const result = analyzeBufferCapacity({ ...base, downstreamStopSec: 0, initialOccupancy: 0, inTransit: 0, reserveSlots: 0, capacity: 0 });
  assert.equal(result.requiredSlots, 0);
  assert.equal(result.capacitySufficient, true);
  assert.equal(result.normalFillTimeSec, 0);
  assert.equal(result.downstreamCatchupTimeSec, 0);
  assert.equal(result.canDrainWhileUpstreamRuns, false);
});

test('cycles must be explicit finite positive numbers', () => {
  for (const key of ['upstreamCycleSec', 'downstreamCycleSec']) {
    for (const value of [undefined, null, '12', 0, -1, NaN, Infinity, -Infinity]) {
      assert.throws(() => analyzeBufferCapacity({ ...base, [key]: value }), RangeError);
    }
  }
  assert.throws(() => analyzeBufferCapacity(null), RangeError);
});

test('stop time is explicit finite nonnegative; counts are nonnegative safe integers', () => {
  for (const value of [undefined, null, '120', -1, NaN, Infinity]) {
    assert.throws(() => analyzeBufferCapacity({ ...base, downstreamStopSec: value }), RangeError);
  }
  for (const key of ['initialOccupancy', 'inTransit', 'reserveSlots', 'capacity']) {
    for (const value of [null, '2', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => analyzeBufferCapacity({ ...base, [key]: value }), RangeError);
    }
    if (key !== 'capacity') assert.throws(() => analyzeBufferCapacity({ ...base, [key]: undefined }), RangeError);
  }
});

test('rejects unrepresentable counts and rates instead of returning bogus sufficiency', () => {
  assert.throws(() => analyzeBufferCapacity({ ...base, initialOccupancy: Number.MAX_SAFE_INTEGER }), RangeError);
  assert.throws(() => analyzeBufferCapacity({ ...base, upstreamCycleSec: Number.MIN_VALUE }), RangeError);
  assert.throws(() => analyzeBufferCapacity({ ...base, downstreamStopSec: Number.MAX_VALUE }), RangeError);
});

test('pure repeatable analysis leaves caller inputs untouched', () => {
  const input = Object.freeze({ ...base, capacity: 15 });
  const first = analyzeBufferCapacity(input);
  const second = analyzeBufferCapacity(input);
  assert.deepEqual(first, second);
  first.warnings.push('caller mutation');
  assert.ok(!second.warnings.includes('caller mutation'));
  assert.deepEqual(input, { ...base, capacity: 15 });
});
