import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.mjs';

const seed = () => ({schemaVersion:1,updatedAt:'2026-11-20T00:00:00Z',features:[{id:'b',type:'box',name:'initial',params:{length:20,width:20,height:10,centered:true}}]});
const renamed = name => {const doc=seed();doc.features[0].name=name;return doc;};
const nameOf = store => store.doc.features[0].name;
const edit = (s,name) => s.applyOperation({expectedRevision:s.revision,operation:'renameFeature',featureId:'b',name});
async function isolated(run){const root=await mkdtemp(join(tmpdir(),'ft-storage-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
function legacyArchive(){return {documentId:'part',revision:3,doc:renamed('first'),snapshots:[seed(),renamed('first'),renamed('second'),renamed('first')],history:[{revision:1,beforeRevision:0,operation:'renameFeature'},{revision:2,beforeRevision:1,operation:'renameFeature'},{revision:3,beforeRevision:2,operation:'undo',undoTarget:1}]};}

test('new archives keep edit checkpoints and audit without duplicate revision documents',async()=>isolated(async root=>{
  let s=new Store(seed(),{dataDir:root,documentId:'part'});
  await edit(s,'first');await edit(s,'second');await s.undo(s.revision);
  const archive=JSON.parse(await readFile(s.dataFile,'utf8'));
  assert.equal(archive.formatVersion,2);
  assert.equal(Object.hasOwn(archive,'snapshots'),false);
  assert.equal(Object.hasOwn(s,'snapshots'),false);
  assert.equal(archive.history.length,3);assert.equal(archive.undoStack.length,1);assert.equal(archive.redoStack.length,1);
  s=new Store(seed(),{dataDir:root,documentId:'part'});await s.restore();
  assert.equal(nameOf(s),'first');await s.redo(s.revision);assert.equal(nameOf(s),'second');
  await s.undo(s.revision);await s.undo(s.revision);assert.equal(nameOf(s),'initial');
}));

test('pre-checkpoint legacy archive migrates continuous undo/redo then saves compact format',async()=>isolated(async root=>{
  const old=legacyArchive();const file=join(root,'part.json');await writeFile(file,JSON.stringify(old));
  const s=new Store(seed(),{dataDir:root,documentId:'part'});assert.equal(await s.restore(),true);
  assert.equal(nameOf(s),'first');assert.equal(s.envelope().undoDepth,1);assert.equal(s.envelope().redoDepth,1);
  await s.redo(s.revision);assert.equal(nameOf(s),'second');
  await s.undo(s.revision);await s.undo(s.revision);assert.equal(nameOf(s),'initial');
  const current=JSON.parse(await readFile(file,'utf8'));
  assert.equal(current.formatVersion,2);assert.equal(Object.hasOwn(current,'snapshots'),false);
  assert.deepEqual(current.history.slice(0,3),old.history);
}));

test('previous checkpoint archive treats explicit stacks as authoritative',async()=>isolated(async root=>{
  const old={...legacyArchive(),undoStack:[seed()],redoStack:[renamed('second')]};
  await writeFile(join(root,'part.json'),JSON.stringify(old));
  const s=new Store(seed(),{dataDir:root,documentId:'part'});await s.restore();
  await s.redo(s.revision);assert.equal(nameOf(s),'second');
  await s.undo(s.revision);assert.equal(nameOf(s),'first');
  await s.undo(s.revision);assert.equal(nameOf(s),'initial');
}));

test('unsupported or damaged new archive never partially mutates live state or overwrites source',async()=>isolated(async root=>{
  const base={formatVersion:2,documentId:'part',revision:1,doc:renamed('saved'),history:[],undoStack:[seed()],redoStack:[]};
  for(const patch of [{formatVersion:3},{formatVersion:3,doc:null},{doc:null},{doc:{bad:true}},{undoStack:null},{redoStack:[{bad:true}]},{revision:-1},{documentId:'other'}]){
    const s=new Store(seed(),{dataDir:root,documentId:'part'});const before=s.envelope();
    const raw=JSON.stringify({...base,...patch});await writeFile(s.dataFile,raw);
    await assert.rejects(s.restore());assert.deepEqual(s.envelope(),before);
    assert.equal(await readFile(s.dataFile,'utf8'),raw);
  }
}));

test('failed compact save preserves archive, edit checkpoints, revision and notification count',async()=>isolated(async root=>{
  const s=new Store(seed(),{dataDir:root,documentId:'part'});await edit(s,'saved');
  const raw=await readFile(s.dataFile,'utf8');const before=s.envelope();let notices=0;s.onChange(()=>notices++);
  s.persist=async()=>{throw new Error('simulated disk failure');};
  await assert.rejects(edit(s,'lost'),/disk failure/);
  assert.deepEqual(s.envelope(),before);assert.equal(notices,0);assert.equal(await readFile(s.dataFile,'utf8'),raw);
}));
