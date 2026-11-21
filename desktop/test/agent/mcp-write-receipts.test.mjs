import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../src/agent/mcp.ts';
import { DesktopRpcProxy } from '../../src/agent/mcp-proxy.ts';
import { AgentRpcServer, createAgentToken } from '../../src/agent/rpc.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {resolve,promise}};
async function connect(tools,proxy){
  const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
  const server=buildMcpServer(tools,{name:'receipt-test',version:'1'},{proxy});
  const client=new Client({name:'receipt-client',version:'1'});
  await server.connect(serverSide);await client.connect(clientSide);
  return {client,close:async()=>{await client.close();await server.close();}};
}
const summary={name:'insert_component',description:'test',inputSchema:{type:'object',properties:{partId:{type:'string'}},required:['partId']}};
function tools(call){return {has:name=>name==='insert_component',list:()=>[summary],summaries:()=>[summary],call};}

test('MCP requires a known operation ID before forwarding a write',async()=>{
  let forwarded=0;
  const proxy={listTools:async()=>[summary],callTool:async()=>{forwarded++;return {isError:false,structuredContent:{ok:true}}}};
  const link=await connect(tools(()=>{}),proxy);
  try{
    const listing=await link.client.listTools();
    assert.deepEqual(listing.tools.find(x=>x.name==='insert_component').inputSchema.required,['partId','operationId']);
    const missing=await link.client.callTool({name:'insert_component',arguments:{partId:'p'}});
    assert.equal(missing.structuredContent.code,'WRITE_OPERATION_ID_REQUIRED');
    assert.equal(missing.isError,true);assert.equal(forwarded,0);
    assert.match(missing.structuredContent.operationId,/^[A-Za-z0-9_-]{16,128}$/);
    const retry=await link.client.callTool({name:'insert_component',arguments:{partId:'p',operationId:missing.structuredContent.operationId}});
    assert.equal(retry.structuredContent.ok,true);assert.equal(forwarded,1);
  }finally{await link.close();}
});

test('SDK cancellation after a write starts still permits independent receipt lookup with caller ID',async()=>{
  const root=mkdtempSync(join(tmpdir(),'mcp-cancel-receipt-'));
  const token=createAgentToken();writeFileSync(join(root,'agent-token'),token);
  const started=deferred(),finish=deferred(),completed=deferred();let calls=0;
  const registry=tools(async()=>{calls++;started.resolve();await finish.promise;completed.resolve();return {ok:true,createdId:'created-after-cancel'};});
  const rpc=new AgentRpcServer({tools:registry,token,version:'test',port:0,confirmWrite:async()=>true});
  const info=await rpc.start();const port=new URL(info.url).port;
  const proxy=new DesktopRpcProxy({userDataDir:root,port:Number(port)});
  const link=await connect(registry,proxy);const operationId='caller-known-cancel-operation';
  const controller=new AbortController();
  try{
    const pending=link.client.callTool({name:'insert_component',arguments:{partId:'p',operationId}},undefined,{signal:controller.signal});
    const rejected=assert.rejects(pending);
    await started.promise;controller.abort();await rejected;
    finish.resolve();await completed.promise;
    // A new request is independent of the cancelled SDK request and uses the
    // identifier the caller saved before dispatch.
    let receipt;
    for(let attempt=0;attempt<10;attempt++){
      receipt=await link.client.callTool({name:'get_write_operation',arguments:{operationId}});
      if(receipt.structuredContent.state==='finished')break;
    }
    assert.equal(receipt.structuredContent.state,'finished');
    assert.equal(receipt.structuredContent.result.createdId,'created-after-cancel');
    const replay=await link.client.callTool({name:'insert_component',arguments:{partId:'p',operationId}});
    assert.equal(replay.structuredContent.createdId,'created-after-cancel');assert.equal(calls,1);
  }finally{finish.resolve();await link.close();await rpc.stop();rmSync(root,{recursive:true,force:true});}
});
