import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observeNativeEvidenceCompaction} from '../runtime/browser-evidence-native-case.ts';

test('public independent native observer scopes actual protocol events and new receipt files; trust failure refuses',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'carbon-observer-owned-'));
 const sentinel=path.join(root,'separate.json');fs.writeFileSync(sentinel,'unchanged');
 const receiptDir=path.join(root,'receipts');fs.mkdirSync(receiptDir);
 const hookConfig={hooksFile:path.join(root,'hooks.json'),command:'fixed fixture command',receiptDir},cwd=path.join(root,'analysis');
 const definitions=['sessionStart','preCompact','postCompact'].map(eventName=>({eventName,matcher:eventName==='sessionStart'?'^compact$':'^(manual|auto)$',sourcePath:hookConfig.hooksFile,handlerType:'command',command:hookConfig.command,currentHash:'observed-hash',enabled:true,trustStatus:'trusted'}));
 let listener:((event:unknown)=>void)|undefined,stops=0;
 const harness={async listHooks(_session:unknown,p:{cwds:string[]}){assert.deepEqual(p.cwds,[cwd]);return {data:[{cwd,errors:[],hooks:definitions}]};},subscribeEvents(_session:unknown,fn:(event:unknown)=>void){listener=fn;return ()=>{stops++;};}};
 try{
  fs.writeFileSync(path.join(receiptDir,'prior.json'),JSON.stringify({threadId:'thread',cwd}));
  const observation=await observeNativeEvidenceCompaction({session:{},harness,threadId:'thread',cwd,hookConfig});
  listener!({kind:'hook.completed',threadId:'other'});listener!({kind:'hook.completed',threadId:'thread',turnId:'turn'});
  for(const [name,threadId]of [['new','thread'],['foreign','other']])fs.writeFileSync(path.join(receiptDir,name+'.json'),JSON.stringify({threadId,cwd,eventName:'SessionStart',source:'compact'}));
  const result=observation.finish();assert.equal(stops,1);assert.equal(result.events.length,1);assert.equal(result.receipts.length,1);assert.match(result.proofBoundary,/Native observations only/);
  await assert.rejects(observeNativeEvidenceCompaction({session:{},harness:{...harness,listHooks:async()=>({data:[{cwd,errors:[],hooks:definitions.map(h=>({...h,trustStatus:'untrusted'}))}]})},threadId:'thread',cwd,hookConfig}),/BROWSER_HOOK_NOT_QUALIFIED/);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');
 }finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}
});
