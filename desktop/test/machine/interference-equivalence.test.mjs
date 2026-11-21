import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { screenInterference } from '../../src/machine/interference.ts';
import { clearanceFixture } from '../../test-support/clearance-fixture.mjs';

// Full ordered JSON captured before bounds reuse and the aggregation rewrite.
for (const [count, dense, expected] of [
  [100, false, 'b98114a21df0efafbf784b7d48e8bf24c471d9cd203157c1971430098808c6ed'],
  [500, false, '7e63d525667135d1616a8d8a829a2451aa1d41a48f5335cba857ac0fba65c580'],
  [200, true, '055d511992f3a26967e9c0331182f6394b217de9f4074ae73daf2aeee6e2eefd']
]) {
  test(`interference preserves the complete ordered result (${count} parts, dense=${dense})`, () => {
    const geometry = clearanceFixture(count);
    if (dense) for (const part of geometry.parts) part.center = part.center.map(value => value / 25);
    const before = structuredClone(geometry);
    const result = screenInterference(geometry);
    assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), expected);
    assert.deepEqual(geometry, before);
  });
}
