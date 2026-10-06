import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RuntimeFault, fault } from './faults.ts';
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function writeBrowserHookConfig({codexHome,work,privateRoot,nodeBinary,helperPath}:{codexHome:string;work:string;privateRoot:string;nodeBinary:string;helperPath:string}){
 for(const p of [codexHome,work,privateRoot,nodeBinary,helperPath])if(!path.isAbsolute(p))throw Error('Explicit owned absolute lifecycle paths required');
 for(const p of [codexHome,work,privateRoot])if(fs.realpathSync(p)!==p)throw Error('Lifecycle roots must be real canonical directories');
 const hooksFile=path.join(codexHome,'hooks.json'),bindingFile=path.join(privateRoot,'evidence-hook-binding.json'),receiptDir=path.join(privateRoot,'evidence-hook-receipts');
 if(fs.existsSync(hooksFile)||fs.existsSync(bindingFile)||fs.existsSync(receiptDir))throw Error('Refuse replacing any existing lifecycle configuration');
 fs.mkdirSync(receiptDir,{mode:0o700});fs.writeFileSync(bindingFile,JSON.stringify({schema:'carbon.evidence-hook-binding.v1',workRoot:work,receiptDir})+'\n',{flag:'wx',mode:0o600});
 const command=[nodeBinary,helperPath,'--binding-file',bindingFile].map(quote).join(' ');
 const handler={type:'command',command,timeout:5};const hooks={description:'Current browser evidence after actual compaction; fixed bounded projection, no transcript.',hooks:{SessionStart:[{matcher:'^compact$',hooks:[{...handler,additionalContextLimit:2500}]}],PreCompact:[{matcher:'^(manual|auto)$',hooks:[handler]}],PostCompact:[{matcher:'^(manual|auto)$',hooks:[handler]}]}};
 fs.writeFileSync(hooksFile,JSON.stringify(hooks,null,2)+'\n',{flag:'wx',mode:0o600});return {hooksFile,bindingFile,receiptDir,command,helperSha256:hash(fs.readFileSync(helperPath,'utf8')),hooksSha256:hash(fs.readFileSync(hooksFile,'utf8'))};
}
// A native readback of enabled, exact-hash trusted definitions is a prerequisite,
// not the proof of execution or model-visible post-compaction context.
type HookDiscovery = {data?:{cwd?:unknown;errors?:unknown[];warnings?:unknown[];hooks?:{eventName?:unknown;matcher?:unknown;sourcePath?:unknown;currentHash?:unknown;enabled?:unknown;trustStatus?:unknown;handlerType?:unknown;command?:unknown}[]}[]}|null;
type HookDefinition = NonNullable<NonNullable<NonNullable<HookDiscovery>['data']>[number]['hooks']>[number];
function qualifiedDefinition(found:HookDefinition|undefined){return found?.enabled===true&&['trusted','managed'].includes(String(found.trustStatus))&&typeof found.currentHash==='string'&&found.currentHash.length>0;}
export function qualifyBrowserHooks(response:unknown,{cwd,hooksFile,command}:{cwd:string;hooksFile:string;command:string}){
 const result=response as HookDiscovery;
 const entry=result?.data?.find(e=>e.cwd===cwd);if(!entry||entry.errors?.length)throw new RuntimeFault(fault('BROWSER_HOOK_DISCOVERY_FAILED',cwd,'actual hooks/list did not read this exact working directory without errors','repair the fixed hook configuration and retain native discovery before dispatch'));
 const hooks=entry.hooks??[];const accepted=[];
 for(const eventName of ['sessionStart','preCompact','postCompact']){const found=hooks.find(h=>h.eventName===eventName&&h.sourcePath===hooksFile&&h.handlerType==='command'&&h.command===command&&(eventName!=='sessionStart'||h.matcher==='^compact$'));
  if(!qualifiedDefinition(found))throw new RuntimeFault(fault('BROWSER_HOOK_NOT_QUALIFIED',eventName,'exact configured lifecycle command is absent, disabled, untrusted, modified or lacks its current native hash','the operator must review/trust the exact fixed hook definition; do not bypass trust or fabricate execution proof'));
  accepted.push(found);
 }
 return {cwd,hooks:accepted,warnings:entry.warnings??[],qualification:'native-discovery-only; execution and immediate model continuation remain unproved'};
}
