import test from 'node:test';
import assert from 'node:assert/strict';
import {screenClearance} from '../../src/machine/clearance.ts';
import {screenClearance as baseline} from '../../test-support/clearance-baseline.ts';
import {clearanceFixture} from '../../test-support/clearance-fixture.mjs';

for(const seed of [1,42,12345])test(`cached clearance preserves ordered complete results seed=${seed}`,()=>{
  const geometry=clearanceFixture(80,seed);
  const before=structuredClone(geometry);
  for(const thresholdMm of [-1,0,0.5,5,20,50,Infinity,NaN])assert.deepEqual(screenClearance(geometry,{thresholdMm}),baseline(geometry,{thresholdMm}));
  assert.deepEqual(geometry,before);
});

test('clearance cache is per call and observes in-place movement, shape and ID edits',()=>{
  const geometry=clearanceFixture(40);
  screenClearance(geometry);
  geometry.parts[0].center[0]+=150;
  geometry.parts[1].shape={type:'box',size:[100,120,40]};
  geometry.parts[2].id='renamed-cross';
  assert.deepEqual(screenClearance(geometry),baseline(geometry));
});

test('declared connections, equal gaps and contact boundary retain original ordering',()=>{
  const box=(id,center,size)=>({id,name:id,role:'frame',shape:{type:'box',size},center,rotationZDeg:0});
  const geometry={parts:[box('frame-leg-1',[0,0,0],[60,60,800]),box('frame-stringer-front',[0,0,400],[400,40,40]),box('st1-base',[1000,0,0],[100,100,20]),box('st1-table',[1000,0,23],[100,100,20]),box('st2-base',[1110,0,0],[100,100,20]),box('st3-base',[1220,0,0],[100,100,20])]};
  for(const thresholdMm of [3,10,20])assert.deepEqual(screenClearance(geometry,{thresholdMm}),baseline(geometry,{thresholdMm}));
});
