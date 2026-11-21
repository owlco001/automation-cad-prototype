import { createHash } from 'node:crypto';
import { screenInterference } from '../src/machine/interference.ts';
import { clearanceFixture } from '../test-support/clearance-fixture.mjs';

for (const [count, dense] of [[100, false], [500, false], [200, true]]) {
  const geometry = clearanceFixture(count);
  if (dense) for (const part of geometry.parts) part.center = part.center.map(value => value / 25);
  for (let i = 0; i < 3; i++) screenInterference(geometry);
  const times = [];
  let result;
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    result = screenInterference(geometry);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ count, dense, hits: result.count, p50Ms: +times[4].toFixed(3), sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') }));
}
