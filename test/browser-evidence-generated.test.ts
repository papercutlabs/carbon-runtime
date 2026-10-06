import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {Store} from '../stream/store.ts';
import {serveReplyTool} from '../runtime/reply-tool.ts';
import {browserWorkspace} from '../runtime/browser-files.ts';
import {payload} from '../adapters/browser/index.ts';
import {readEvidence,toWireSelector} from '../runtime/browser-evidence.ts';
import {evidenceAgentRoutes} from '../runtime/browser-evidence-routes.ts';
import {checkGenerated} from '@pcl/routes/generate';
test('generated agent CLI uses actual current-turn HTTP publisher, closed readback and same MCP contract; inactive/browser caller refused',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'carbon-evidence-generated-')));let service:Awaited<ReturnType<typeof serveReplyTool>>|undefined;
 try{for(const dir of ['work','checkout'])fs.mkdirSync(path.join(root,dir));const store=Store.open(path.join(root,'store')),conversationId='cohort:ticket:SYN-101',workspace=browserWorkspace({work:path.join(root,'work'),checkout:path.join(root,'checkout'),conversationId});
 const r=payload({store,agent:'fixture',account:'cohort'},[{account:'cohort',ticket_key:'SYN-101',submission_id:crypto.randomUUID(),consultant:{id:'alice',name:'Alice'},input_kind:'start',body:'',accepted_at:new Date().toISOString(),position:'00000000000000000001'}]).entries[0].record;store.capture(r);store.release(r,{turn_id:'release',thread_id:'thread',released_at:new Date().toISOString(),hold_applies:false});store.activeBrowserReply={conversation_id:conversationId,release_id:'release',native_turn_id:'native',workspace};
 const file=path.join(workspace.analysis,'derived.txt');fs.writeFileSync(file,'calculated fixture output\nsecond row');const itemId=crypto.randomUUID(),changeId=crypto.randomUUID(),add=[{itemId,label:'Derived fixture',path:file,selector:toWireSelector({kind:'lines',start:1,end:1}),note:null,basis:[],assumptions:['Synthetic only'],producerPath:null}];
 const {description}=evidenceAgentRoutes(store,'fixture');assert.deepEqual(await checkGenerated(description,'generated/browser-evidence'),[]);service=await serveReplyTool({store,agent:'fixture',port:0});const base=service.url.replace(/\/mcp$/,'');
 const output=await new Promise<Record<string,unknown>>((resolve,reject)=>{const child=spawn(process.execPath,['generated/browser-evidence/cli.mjs','evidence-present','--change-id',changeId,'--add',JSON.stringify(add),'--remove','[]','--note','null','--json'],{env:{PATH:process.env.PATH,PCL_API_URL:base,PCL_API_SCOPES:'read,write',PCL_API_TOKEN:service!.evidenceApiToken},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.once('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));});assert.equal((output.result as {changeId:string}).changeId,changeId);assert.equal(readEvidence(store,conversationId).items[0].origin,'analysis');assert.equal(store.readRequest('release'),null);
 const wire=await fetch(service.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'evidence_read',arguments:{anchor:null,cursor:0,limit:50}}})});assert.equal((await wire.json()).result.structuredContent.result.items[0].id,itemId);
 const origin=await fetch(base+'/api/evidence?anchor=null&cursor=0&limit=50',{headers:{Origin:'http://localhost:9999'}});assert.equal(origin.status,403);store.activeBrowserReply=null;assert.equal((await fetch(base+'/api/evidence?anchor=null&cursor=0&limit=50')).status,403);
 }finally{await service?.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}
});
