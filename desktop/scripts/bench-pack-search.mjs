import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PackRegistry } from '../src/packs/registry.ts';
const sandbox=mkdtempSync(join(tmpdir(),'pack-search-bench-'));
try {
 const registry=new PackRegistry({builtinDir:resolve('../packs/builtin'),userDir:join(sandbox,'packs'),stateFile:join(sandbox,'state.json')});
 const parts=registry.listParts();
 const queries=['伺服','ratedW','SMC','传感器','20 mm','F3SG'];
 const legacy=q=>parts.filter(part=>[
   part.id,part.model,part.category,part.vendor??'',part.packId??'',part.packName??'',...Object.values(part.specs).map(String)
 ].join(' ').toLocaleLowerCase('zh-CN').includes(q.toLocaleLowerCase('zh-CN')));
 for(const q of queries)assert.deepEqual(registry.listParts({q}).map(p=>p.id),legacy(q).map(p=>p.id),`query=${q}`);
 const measure=fn=>{
   for(let i=0;i<5;i++)for(const q of queries)fn(q);
   const samples=[];
   for(let round=0;round<30;round++){const start=performance.now();for(const q of queries)fn(q);samples.push(performance.now()-start);}
   samples.sort((a,b)=>a-b);return {p50Ms:+samples[15].toFixed(3),p95Ms:+samples[29].toFixed(3)};
 };
 const textChars=[...registry.loadedPacks.values()].reduce((sum,pack)=>sum+pack.searchText.reduce((n,text)=>n+text.length,0),0);
 console.log(JSON.stringify({node:process.version,parts:parts.length,queries,rounds:30,legacyRepeatedNormalization:measure(legacy),cachedRegistrySearch:measure(q=>registry.listParts({q})),cachedSearchChars:textChars,estimatedUtf16Bytes:textChars*2},null,2));
} finally {rmSync(sandbox,{recursive:true,force:true});}
