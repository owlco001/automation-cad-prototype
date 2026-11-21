import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRpcServer, createAgentToken } from '../../src/agent/rpc.ts';
import { WriteOperations } from '../../src/agent/write-operations.ts';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
async function post(url, token, method, params) {
  const response=await fetch(`${url}/rpc`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return response.json();
}
function fakeTools(run) {
  const summary={name:'insert_component',description:'test',inputSchema:{type:'object',properties:{}}};
  return {has:name=>name===summary.name,list:()=>[summary],summaries:()=>[summary],call:run};
}

test('audit failure preserves known successful write receipt and does not execute replay',async()=>{
  let calls=0;const token=createAgentToken();
  const server=new AgentRpcServer({tools:fakeTools(async()=>{calls++;return {ok:true,createdId:'part-1'};}),token,version:'test',port:0,confirmWrite:async()=>true,audit:()=>{throw new Error('audit disk unavailable');}});
  const {url}=await server.start();const operationId='audit-failure-operation-01';
  try{
    const params={name:'insert_component',arguments:{},operationId};
    const first=await post(url,token,'tools/call',params);
    assert.equal(first.result.structuredContent.ok,true);
    const status=await post(url,token,'operations/status',{operationId});
    assert.equal(status.result.state,'finished');assert.equal(status.result.result.createdId,'part-1');
    await post(url,token,'tools/call',params);assert.equal(calls,1);
  }finally{await server.stop();}
});

test('token rotation aborts old pending approval immediately and leaves new requests usable',async()=>{
  const entered=deferred();let calls=0;let cancelled=false;let requests=0;
  const token=createAgentToken();
  const server=new AgentRpcServer({tools:fakeTools(async()=>{calls++;return {ok:true};}),token,version:'test',port:0,
    confirmWrite:async(_name,_args,signal)=>{
      if(++requests>1)return true;
      entered.resolve();
      return new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve(false);},{once:true}));
    }});
  const {url}=await server.start();
  try{
    const pending=post(url,token,'tools/call',{name:'insert_component',arguments:{},operationId:'pending-old-token-operation'});
    await entered.promise;
    const next=createAgentToken();server.setToken(next);
    const outcome=await pending;
    assert.equal(cancelled,true);assert.equal(outcome.result.structuredContent.code,'WRITE_CANCELLED');assert.equal(calls,0);
    const fresh=await post(url,next,'tools/call',{name:'insert_component',arguments:{},operationId:'fresh-new-token-operation'});
    assert.equal(fresh.result.structuredContent.ok,true);assert.equal(calls,1);
  }finally{await server.stop();}
});

test('large terminal receipts retain bounded success and failure summaries on status and replay',async()=>{
  for(const ok of [true,false]){
    const store=new WriteOperations();let calls=0;const id=ok?'large-success-operation':'large-failure-operation';
    const execute=async()=>{calls++;return {state:'finished',result:{ok,code:ok?'CREATED':'REJECTED',message:'m'.repeat(2000),payload:'x'.repeat(100000)}};};
    await store.run('local',id,'insert_component',{},execute);
    const status=store.status('local',id);
    assert.equal(status.state,'finished');assert.equal(status.result.ok,ok);assert.equal(status.result.resultOmitted,true);
    assert.equal(status.result.code,ok?'CREATED':'REJECTED');assert.ok(status.result.message.length<=1024);
    assert.ok(Buffer.byteLength(JSON.stringify(status))<4096);
    const replay=await store.run('local',id,'insert_component',{},execute);
    assert.deepEqual(replay,status.result);assert.equal(calls,1);
  }
});
