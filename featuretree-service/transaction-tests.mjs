import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const seed = () => ({schemaVersion:1, updatedAt:new Date().toISOString(), features:[{id:'body',type:'box',name:'initial',params:{length:20,width:20,height:10,centered:true}}]});
const edit = (s, name, expectedRevision=s.revision) => s.applyOperation({operation:'renameFeature',featureId:'body',name,expectedRevision});
const nameOf = s => s.doc.features[0].name;

test('same-revision writes serialize and reject the stale draft', async () => {
  const s = new Store(seed());
  const results = await Promise.all([edit(s,'first',0),edit(s,'second',0)]);
  assert.equal(results.filter(x=>!x.error).length,1);
  assert.equal(results[1].error,'CONFLICT_STALE_REVISION');
  assert.equal(s.revision,1);
  assert.equal(nameOf(s),'first');
});

test('consecutive undo walks edit history while audit revisions remain monotonic', async () => {
  const s = new Store(seed());
  await edit(s,'first'); await edit(s,'second');
  await s.undo(s.revision); assert.equal(nameOf(s),'first');
  await s.undo(s.revision); assert.equal(nameOf(s),'initial');
  assert.equal(s.envelope().undoDepth,0);
  assert.equal((await s.undo(s.revision)).error,'NOT_FOUND');
  await s.redo(s.revision); assert.equal(nameOf(s),'first');
  await s.redo(s.revision); assert.equal(nameOf(s),'second');
  await s.undo(s.revision); assert.equal(nameOf(s),'first');
  await edit(s,'branch');
  assert.equal(s.envelope().redoDepth,0);
  await s.undo(s.revision); assert.equal(nameOf(s),'first');
  assert.equal(s.revision,9);
});

test('multi-step undo is one redo checkpoint and subsequent undo reaches earlier edit', async () => {
  const s = new Store(seed());
  for (const name of ['one','two','three']) await edit(s,name);
  await s.undo(s.revision,'manual',2); assert.equal(nameOf(s),'one');
  assert.equal(s.envelope().redoDepth,1);
  await s.undo(s.revision); assert.equal(nameOf(s),'initial');
  await s.redo(s.revision); assert.equal(nameOf(s),'one');
  await s.redo(s.revision); assert.equal(nameOf(s),'three');
});

test('invalid undo/redo steps are rejected without writes', async () => {
  const s = new Store(seed()); await edit(s,'first');
  for(const steps of [0,-1,1.5,'1',NaN,Infinity]) {
    assert.equal((await s.undo(s.revision,'manual',steps)).error,'VALIDATION_FAILED');
    assert.equal((await s.redo(s.revision,'manual',steps)).error,'VALIDATION_FAILED');
  }
  assert.equal(s.revision,1);
});

test('failed persistence does not publish state, history or notifications; queue recovers', async () => {
  const root = await mkdtemp(join(tmpdir(),'ft-atomic-'));
  try {
    const s = new Store(seed(),{dataDir:root,documentId:'part'});
    const notices=[];s.onChange(x=>notices.push(x));
    await mkdir(s.dataFile);
    const before=s.envelope();
    await assert.rejects(edit(s,'unsaved'));
    assert.deepEqual(s.envelope(),before);
    assert.deepEqual(notices,[]);
    await rm(s.dataFile,{recursive:true});
    await edit(s,'saved');
    assert.equal(nameOf(s),'saved');assert.equal(notices.length,1);
    const disk=JSON.parse(await readFile(s.dataFile,'utf8'));
    assert.equal(disk.revision,1);
    assert.equal(disk.doc.features[0].name,'saved');
    await mkdir(join(root,'blocked'));
    s.dataFile=join(root,'blocked');
    const saved=s.envelope();
    await assert.rejects(s.undo(s.revision));assert.deepEqual(s.envelope(),saved);
    s.dataFile=join(root,'part.json');await s.undo(s.revision);
    s.dataFile=join(root,'blocked');
    const undone=s.envelope();
    await assert.rejects(s.redo(s.revision));assert.deepEqual(s.envelope(),undone);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('undo and redo checkpoints survive restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ft-stacks-'));
  try{
    const options={dataDir:root,documentId:'part'};
    let s=new Store(seed(),options);
    await edit(s,'first');await edit(s,'second');await s.undo(s.revision);
    s=new Store(seed(),options);await s.restore();
    assert.equal(nameOf(s),'first');assert.equal(s.envelope().undoDepth,1);
    await s.redo(s.revision);assert.equal(nameOf(s),'second');
    await s.undo(s.revision);await s.undo(s.revision);assert.equal(nameOf(s),'initial');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy audit snapshots migrate to edit checkpoints',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ft-legacy-'));
  try{
    const options={dataDir:root,documentId:'part'};
    const original=new Store(seed(),options);
    await edit(original,'first');await edit(original,'second');
    const saved=JSON.parse(await readFile(original.dataFile,'utf8'));
    // Construct the historical disk layout explicitly; modern saves no longer
    // carry the obsolete audit-revision snapshot array.
    saved.snapshots=[...saved.undoStack,saved.doc];
    delete saved.formatVersion;delete saved.undoStack;delete saved.redoStack;
    await writeFile(original.dataFile,JSON.stringify(saved));
    const restored=new Store(seed(),options);await restored.restore();
    await restored.undo(restored.revision);assert.equal(nameOf(restored),'first');
    await restored.undo(restored.revision);assert.equal(nameOf(restored),'initial');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('throwing observer cannot turn a durable write into a reported failure',async()=>{
  const s=new Store(seed());let delivered=false;
  s.onChange(()=>{throw new Error('observer failed')});s.onChange(()=>{delivered=true});
  const result=await edit(s,'committed');
  assert.equal(result.revision,1);assert.equal(delivered,true);
});

test('private geometry is published only after persistence and discarded on failure',async()=>{
  const solids=new Map();
  const sidecar=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='DELETE'){
      solids.delete(url.searchParams.get('documentId'));res.end('{}');return;
    }
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);
    solids.set(body.documentId,body.ops);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,fingerprint:body.documentId,volumeMm3:4000,bboxMm:{x:20,y:20,z:10},massKg:0.0314}));
  });
  sidecar.listen(0,'127.0.0.1');await once(sidecar,'listening');
  const previous=process.env.FT_BUILD_URL;
  process.env.FT_BUILD_URL=`http://127.0.0.1:${sidecar.address().port}`;
  try{
    const s=new Store(seed(),{documentId:'part'});await s.init();
    assert.equal(solids.size,1);
    const original=s.geometryKey;
    let enter;const entered=new Promise(resolve=>{enter=resolve});
    let rejectPersist;
    s.persist=()=>{enter();return new Promise((_,reject)=>{rejectPersist=reject})};
    const result=edit(s,'uncommitted');
    await entered;
    assert.equal(s.geometryKey,original);assert.equal(s.revision,0);
    assert.equal(solids.size,2);
    rejectPersist(new Error('disk full'));await assert.rejects(result,/disk full/);
    assert.equal(s.geometryKey,original);assert.equal(solids.size,1);
    s.persist=async()=>{};await edit(s,'committed');
    assert.notEqual(s.geometryKey,original);
    assert.equal(solids.has(original),false);assert.equal(solids.has(s.geometryKey),true);
    assert.equal(solids.size,1);
  }finally{
    if(previous===undefined)delete process.env.FT_BUILD_URL;else process.env.FT_BUILD_URL=previous;
    await new Promise(resolve=>sidecar.close(resolve));
  }
});
