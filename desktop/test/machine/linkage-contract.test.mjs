import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLinkage, poseAt } from '../../src/machine/linkage.ts';
const geometry = (patch={}) => ({stations:[{id:'s'}],parts:[{id:'rod',center:[0,0,0]}],moving:[{actuatorId:'c',stationId:'s',kind:'cylinder',partIds:['rod'],strokeMm:100,rangeDeg:0,home:'retracted',durationMs:1000,axis:[0,0,1],points:{extend:'DO1',retract:'DO2'},...patch}]});
test('dual coil direction phases drive only one output and move continuously',()=>{
 const l=buildLinkage(geometry(),{cycleMs:1000});
 assert.deepEqual(l.steps.map(s=>[s.direction,s.io]),[['extend',['DO1']],['retract',['DO2']]]);
 assert.deepEqual(poseAt(l,250).activeIO,['DO1']);
 assert.deepEqual(poseAt(l,750).activeIO,['DO2']);
 assert.equal(poseAt(l,250).offsets.rod[2],50);
 assert.equal(poseAt(l,500).offsets.rod[2],100);
 assert.equal(poseAt(l,750).offsets.rod[2],50);
 assert.deepEqual(poseAt(l,1000).offsets,{});
});
test('infeasible cycles and invalid durations reject instead of silently truncating',()=>{
 assert.throws(()=>buildLinkage(geometry(),{cycleMs:200}),/短于/);
 for(const durationMs of [-1,0,Infinity,NaN]) assert.throws(()=>buildLinkage(geometry({durationMs})),/正有限/);
 assert.deepEqual(poseAt(buildLinkage({moving:[]}),0).offsets,{});
});
