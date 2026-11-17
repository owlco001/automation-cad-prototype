import assert from 'node:assert/strict';
import {execFileSync}from'node:child_process';
import {createHash}from'node:crypto';
import test from'node:test';
import{screenInterference}from'../../src/machine/interference.ts';
import{buildLinkage}from'../../src/machine/linkage.ts';
import{checkMotionEnvelope}from'../../src/machine/motion-envelope.ts';
test('combined geometry edits bind linkage and motion checks to final geometry',()=>{
 const d=JSON.parse(execFileSync(process.execPath,['scripts/machine-design-cli.mjs','--brief','三工位点胶机，节拍 25 件/分钟','--with-geometry','--resolve-clearance','10','--layout-compliance','15','--linkage','--motion-check'],{encoding:'utf8',maxBuffer:64*1024*1024}));
 const revision=createHash('sha256').update(JSON.stringify({parts:d.geometry.parts,moving:d.geometry.moving})).digest('hex');
 assert.equal(d.geometry.revision,revision);
 assert.equal(d.linkage.geometryRevision,revision);
 assert.equal(d.motionCheck.geometryRevision,revision);
 assert.deepEqual(d.geometry.interference,screenInterference(d.geometry));
 const expected=checkMotionEnvelope(d.geometry,buildLinkage(d.geometry,{cycleMs:d.linkage.cycleMs}));
 assert.deepEqual(d.linkage.motion,expected);
 assert.deepEqual(d.motionCheck,{geometryRevision:revision,cycleMs:d.linkage.cycleMs,...expected});
 assert.ok(d.linkage.frames.every(f=>Array.isArray(f.activeStepNos)));
});
