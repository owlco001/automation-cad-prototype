import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess, stopOwnedProcess } from '../../scripts/lib/owned-process.mjs';
const fixture = fileURLToPath(new URL('../../test-support/owned-process-fixture.mjs', import.meta.url));
const live = pid => {
  try { const text=readFileSync(`/proc/${pid}/stat`,'utf8'); return text.slice(text.lastIndexOf(')')+2).split(' ')[0] !== 'Z'; }
  catch {return false;}
};
async function launch(args=[]) {
  const child=spawnOwnedProcess(process.execPath,[fixture,...args],{stdio:['ignore','pipe','pipe']});
  let timer;
  try {
    const output=await Promise.race([once(child.stdout,'data'),once(child,'error').then(([e])=>{throw e;}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture readiness timeout')),3000);})]);
    return {child,...JSON.parse(String(output[0]).trim())};
  } catch (error) { await stopOwnedProcess(child); throw error; }
  finally { clearTimeout(timer); }
}

test('owned cleanup stops ordinary descendants and is idempotent',{skip:process.platform!=='linux'},async()=>{
  let run;
  try {
    run=await launch();assert.equal(live(run.worker),true);
    const first=await stopOwnedProcess(run.child);
    assert.deepEqual(first.remaining,[]);assert.equal(live(run.worker),false);
    assert.deepEqual(await stopOwnedProcess(run.child),first);
  } finally {if(run)await stopOwnedProcess(run.child);}
});

test('exited launcher does not hide detached stubborn worker or kill unrelated same-name instance',{skip:process.platform!=='linux'},async()=>{
  let unrelated,run;
  try {
    unrelated=await launch();
    run=await launch(['--exit-root','--detached-worker','--stubborn']);
    if(run.child.exitCode===null)await once(run.child,'exit');
    assert.equal(run.child.exitCode,0);assert.equal(live(run.worker),true);
    const result=await stopOwnedProcess(run.child,{graceMs:150,killMs:1500});
    assert.ok(result.escalated.includes(run.worker));
    assert.equal(live(run.worker),false);assert.equal(live(unrelated.worker),true);
  } finally {if(run)await stopOwnedProcess(run.child);if(unrelated)await stopOwnedProcess(unrelated.child);}
});

test('immediate cancellation waits for spawn registration before cleanup',{skip:process.platform!=='linux'},async()=>{
  const child=spawnOwnedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const pid=child.pid;
  const result=await stopOwnedProcess(child,{graceMs:500,killMs:500});
  assert.deepEqual(result.remaining,[]);assert.equal(live(pid),false);
});

test('cleanup refuses a foreign process handle',async()=>{
  await assert.rejects(stopOwnedProcess({pid:process.pid}),/unregistered/);
});

test('spawn failure still has a bounded clean terminal result',async()=>{
  const child=spawnOwnedProcess('/definitely/missing/automationcad-exe',[],{stdio:'ignore'});
  await once(child,'error');
  assert.deepEqual((await stopOwnedProcess(child)).remaining,[]);
});
