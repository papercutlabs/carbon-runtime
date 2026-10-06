import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeBrowserHookConfig,qualifyBrowserHooks} from '../runtime/browser-evidence-hooks.ts';
test('fixed command reads only bound compact projection, bounded context and lifecycle receipts; discovery trust is not execution proof',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'carbon-evidence-hook-owned-')));try{
 const home=path.join(root,'model-home'),work=path.join(root,'work'),privateRoot=path.join(root,'runtime-private');for(const p of [home,work,privateRoot])fs.mkdirSync(p,{mode:0o700});
 const helperPath=path.resolve('runtime/browser-evidence-hook.mjs'),config=writeBrowserHookConfig({codexHome:home,work,privateRoot,nodeBinary:process.execPath,helperPath});
 assert.throws(()=>writeBrowserHookConfig({codexHome:home,work,privateRoot,nodeBinary:process.execPath,helperPath}),/Refuse/);
 const conversationId='cohort:ticket:SYN-101',digest=crypto.createHash('sha256').update(conversationId).digest('hex'),cwd=path.join(work,'browser-tickets',digest,'analysis');fs.mkdirSync(path.join(cwd,'.agents'),{recursive:true});
 const projection={schema:'carbon.evidence-current.v1',conversationId,revision:71,total:1,items:[{id:'distinctive-current-id',label:'Current selected original',origin:'original'}],hasMore:false,reader:'evidence_read/evidence_fragment_read/evidence_changes'};
 const target=path.join(cwd,'.agents/evidence-current.json');fs.writeFileSync(target,JSON.stringify(projection),{mode:0o400});
 const invoke=(input:unknown)=>spawnSync(process.execPath,[helperPath,'--binding-file',config.bindingFile],{input:JSON.stringify(input),encoding:'utf8',env:{PATH:path.dirname(process.execPath)},timeout:5000});
 const input={session_id:'actual-native-shape',turn_id:'turn-shape',cwd,source:'compact',hook_event_name:'SessionStart',transcript_path:'/unreadable/never-opened'};
 const result=invoke(input);assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.match(output.hookSpecificOutput.additionalContext,/distinctive-current-id/);assert.match(output.hookSpecificOutput.additionalContext,/revision\\?":71/);assert.equal(output.continue,undefined);
 for(const event of ['PreCompact','PostCompact']){const r=invoke({...input,source:undefined,trigger:'auto',hook_event_name:event});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});}
 assert.equal(fs.readdirSync(config.receiptDir).length,3);const receipts=fs.readdirSync(config.receiptDir).map(f=>JSON.parse(fs.readFileSync(path.join(config.receiptDir,f),'utf8')));assert.equal(receipts.every(r=>r.revision===71&&r.threadId==='actual-native-shape'),true);
 const headers=['sessionStart','preCompact','postCompact'].map(eventName=>({eventName,sourcePath:config.hooksFile,handlerType:'command',command:config.command,matcher:eventName==='sessionStart'?'^compact$':'^(manual|auto)$',currentHash:'native-current-hash',enabled:true,trustStatus:'trusted'}));
 assert.match(qualifyBrowserHooks({data:[{cwd,errors:[],warnings:[],hooks:headers}]},{cwd,...config}).qualification,/execution.*unproved/);
 assert.throws(()=>qualifyBrowserHooks({data:[{cwd,errors:[],hooks:headers.map(h=>({...h,trustStatus:'untrusted'}))}]},{cwd,...config}),/BROWSER_HOOK_NOT_QUALIFIED/);
 fs.unlinkSync(target);assert.match(JSON.parse(invoke(input).stdout).hookSpecificOutput.additionalContext,/unavailable/);assert.notEqual(invoke({...input,cwd:privateRoot}).status,0);assert.equal(fs.existsSync(path.join(root,'transcript')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}
});
