import assert from 'node:assert/strict';
import {screenClearance} from '../src/machine/clearance.ts';
import {screenClearance as baseline} from '../test-support/clearance-baseline.ts';
import {clearanceFixture} from '../test-support/clearance-fixture.mjs';
const iterations=Number(process.argv[2]??7);
if(!Number.isInteger(iterations)||iterations<3||iterations>100)throw new Error('iterations must be 3..100');
const results=[];
for(const count of [100,500,1000]){
  const geometry=clearanceFixture(count);
  assert.deepEqual(screenClearance(geometry),baseline(geometry));
  const sample=fn=>{
    for(let i=0;i<2;i++)fn(geometry);
    const times=[];for(let i=0;i<iterations;i++){const start=performance.now();fn(geometry);times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);
    return {p50Ms:+times[Math.floor(times.length/2)].toFixed(3),p95Ms:+times[Math.min(times.length-1,Math.ceil(times.length*.95)-1)].toFixed(3)};
  };
  const before=sample(baseline),after=sample(screenClearance);
  results.push({parts:count,pairs:count*(count-1)/2,before,after,p50Speedup:+(before.p50Ms/after.p50Ms).toFixed(2)});
}
console.log(JSON.stringify({node:process.version,platform:process.platform,iterations,includesCacheConstruction:true,results},null,2));
