// Execution-review instrumentation. Actual provider effects are the caller's
// separately authorized lifecycle; this module neither obtains access nor runs
// a substitute thread, scripted answer or transcript parser.
import fs from 'node:fs';
import path from 'node:path';
import {qualifyBrowserHooks} from './browser-evidence-hooks.ts';
export async function observeNativeEvidenceCompaction({session,harness,threadId,cwd,hookConfig,record=()=>{}}:{session:unknown;harness:{listHooks(session:unknown,p:{cwds:string[]}):Promise<unknown>;subscribeEvents(session:unknown,fn:(e:unknown)=>void):()=>void};threadId:string;cwd:string;hookConfig:{hooksFile:string;command:string;receiptDir:string};record?:(e:unknown)=>void}){
 const discovery=await harness.listHooks(session,{cwds:[cwd]});const qualified=qualifyBrowserHooks(discovery,{cwd,...hookConfig});record({event:'native-hook-discovery',discovery,qualified});
 const prior=new Set(fs.readdirSync(hookConfig.receiptDir)),events:unknown[]=[];
 const stop=harness.subscribeEvents(session,(event)=>{const e=event as {kind?:unknown;threadId?:unknown;turnId?:unknown;params?:unknown};if(e.threadId===threadId&&['hook.started','hook.completed','item.started','item.completed','turn.completed','turn.token_usage'].includes(String(e.kind))){events.push(event);record({event:'native-compaction-observation',native:event});}});
 return {discovery,qualified,events,finish(){stop();const receipts=fs.readdirSync(hookConfig.receiptDir).filter(f=>!prior.has(f)&&f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(hookConfig.receiptDir,f),'utf8'))).filter(r=>r.threadId===threadId&&r.cwd===cwd);const result={threadId,cwd,events,receipts,proofBoundary:'Native observations only. SessionStart sourcecompact and Pre/PostCompact receipts, exact run correlation, fixed helper hash/profile and actual immediate continuation use must all be judged by the independent reviewer. Resume/new-turn-only is not caseD.'};record({event:'native-compaction-case-finished',...result});return result;}};
}
