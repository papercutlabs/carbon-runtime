// Evidence is an append-only series of ordinary Carbon captures. The current set
// and its pages are derived; neither a browser draft nor a summary file is authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, StreamFault, type Attachment, type MessageRecord } from '../stream/store.ts';
import { fault, type Fault } from '../stream/faults.ts';
import { validateInput, Type } from '@pcl/routes';
const validateEvidence=(schema:Record<string,unknown>,value:unknown)=>validateInput(Type.Unsafe({type:'object',additionalProperties:false,required:['value'],properties:{value:schema}}),{value});
import { assertNoSymlinks, type BrowserWorkspace } from './browser-files.ts';
import { indexEvidenceRepresentation, resolveEvidenceFragment, type EvidenceSelector } from './browser-evidence-representation.ts';
export type EvidenceReference = { itemId:string; sourceId:string; representationId:string; representationVersion:string; sha256:string; selector:EvidenceSelector|null };
export type EvidenceItem = { id:string; label:string; origin:'original'|'analysis'; sourceId:string; representationId:string; representationVersion:string; digest:string; note:string|null; selector:EvidenceSelector|null; changeId:string };
type EvidenceSource = { id:string; attachment:Attachment; originalPath:string; origin:'original'|'analysis'; provenance:Record<string,unknown>|null; producer:EvidenceSource|null };
type Detail = { item:EvidenceItem; source:EvidenceSource; basis:EvidenceReference[]; assumptions:string[] };
export type EvidenceChange = { changeId:string; messageId:string; revision:number; createdAt:string; author:{id:string;displayName:string}; releaseId:string; turnId:string; added:EvidenceItem[]; removed:{itemId:string;reason:string}[]; note:string|null };
type Addition={itemId:string;label:string;path:string;selector:EvidenceSelector|null;note:string|null;basis:EvidenceReference[];assumptions:string[];producerPath:string|null};
export type EvidenceDelta={changeId:string;add:Addition[];remove:{itemId:string;reason:string}[];note:string|null};
const uuid={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
const str={type:'string',minLength:1,maxLength:4096};
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const nullable=(schema:unknown)=>({anyOf:[schema,{type:'null'}]});
const interfaceSchema=JSON.parse(fs.readFileSync(new URL('../schema/browser-evidence-interface.json',import.meta.url),'utf8'));
const selectorProperties={kind:{type:'string',enum:['lines','rows','field','region']},start:nullable({type:'integer',minimum:1}),end:nullable({type:'integer',minimum:1}),pointer:nullable({type:'string',maxLength:4096}),x:nullable({type:'number',minimum:0,maximum:1}),y:nullable({type:'number',minimum:0,maximum:1}),width:nullable({type:'number',exclusiveMinimum:0,maximum:1}),height:nullable({type:'number',exclusiveMinimum:0,maximum:1})};
export const EVIDENCE_SELECTOR_SCHEMA=interfaceSchema.selector;
export function toWireSelector(selector:EvidenceSelector|null){return selector===null?null:{start:null,end:null,pointer:null,x:null,y:null,width:null,height:null,...selector};}
export function fromWireSelector(value:unknown):EvidenceSelector|null {
 const faults=validateEvidence(EVIDENCE_SELECTOR_SCHEMA,value);if(faults.length)throw new StreamFault(faults);if(value===null)return null;
 const v=value as Record<string,unknown>,fields=({lines:['start','end'],rows:['start','end'],field:['pointer'],region:['x','y','width','height']} as Record<string,string[]>)[v.kind as string],problems=[];
 for(const key of Object.keys(selectorProperties).filter(k=>k!=='kind'))if(fields.includes(key)?v[key]===null:v[key]!==null)problems.push(fault('EVIDENCE_SELECTOR_INVALID','selector.'+key,fields.includes(key)?'selected kind requires this field':'irrelevant selector field must be explicitly null','supply only meaningful values for the declared selector kind'));
 if(problems.length)throw new StreamFault(problems);return Object.fromEntries(['kind',...fields].map(k=>[k,v[k]])) as EvidenceSelector;
}

export const EVIDENCE_REFERENCE_SCHEMA=interfaceSchema.reference;
export const EVIDENCE_DELTA_SCHEMA=interfaceSchema.delta;
function refuse(code:string,subject:string,problem:string):never {throw new StreamFault([fault(code,subject,problem,'read the exact retained evidence, repair every named input, and retry the same change identity only with its original payload')]);}
const hash=(s:Uint8Array|string)=>crypto.createHash('sha256').update(s).digest('hex');
const inside=(root:string,p:string)=>p.startsWith(root+path.sep);
function checkedBytes(root:string,given:string){
 if(!path.isAbsolute(given)||given.split(path.sep).includes('..')||!inside(root,given))refuse('EVIDENCE_PATH_REFUSED','path','file must be directly inside the active ticket workspace');
 assertNoSymlinks(root,given);const fd=fs.openSync(given,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {const stat=fs.fstatSync(fd);if(!stat.isFile())refuse('EVIDENCE_PATH_REFUSED','path','evidence must be a regular file');if(stat.size>64*1024*1024)refuse('EVIDENCE_RESOURCE_LIMIT','path','file exceeds the explicit 64 MiB custody resource limit');const bytes=fs.readFileSync(fd);assertNoSymlinks(root,given);const current=fs.statSync(given);if(stat.ino!==current.ino||stat.dev!==current.dev||bytes.length!==stat.size)refuse('EVIDENCE_CHANGED','path','file changed while accepting evidence');return bytes;}finally{fs.closeSync(fd);}
}
function mimeFor(p:string){return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.csv':'text/csv','.json':'application/json','.txt':'text/plain','.log':'text/plain','.md':'text/plain','.pdf':'application/pdf'} as Record<string,string>)[path.extname(p).toLowerCase()]??'application/octet-stream';}
function sourceFromPath(store:Store,conversation:string,workspace:BrowserWorkspace,given:string,producer=false):EvidenceSource{
 const original=inside(workspace.evidence,given),root=original?workspace.evidence:inside(workspace.analysis,given)?workspace.analysis:inside(workspace.output,given)?workspace.output:null;
 if(!root||producer&&original)refuse('EVIDENCE_PATH_REFUSED','path','only a protected received source or this ticket analysis/output file is accepted');
 const bytes=checkedBytes(root,given);let provenance:Record<string,unknown>|null=null,mime=mimeFor(given),filename=path.basename(given);
 if(original){let sidecar;try{sidecar=JSON.parse(checkedBytes(root,given+'.provenance.json').toString('utf8'));}catch{refuse('EVIDENCE_ORIGINAL_UNREGISTERED','path','original must have a tools-owned protected provenance receipt');}
 if(sidecar.size!==bytes.length||sidecar.sha256!==undefined&&sidecar.sha256!==hash(bytes)||typeof sidecar.mediaType!=='string'||!sidecar.provenance)refuse('EVIDENCE_PROVENANCE_INVALID','path','source receipt does not describe the exact received bytes');provenance=sidecar.provenance;mime=sidecar.mediaType.split(';')[0];filename=sidecar.filename??filename;if(!filename||/[\\/\x00-\x1f]/.test(filename))refuse('EVIDENCE_PROVENANCE_INVALID','filename','original filename must be a plain safe name');}
 const id='source-'+hash(JSON.stringify([conversation,given,hash(bytes),mime,provenance]));
 const attachment=store.putAttachment({conversation_id:conversation,message_id:id},bytes,{mime,filename});
 return {id,attachment,originalPath:given,origin:original?'original':'analysis',provenance,producer:null};
}
type State={version:number;changes:EvidenceChange[];details:Map<string,Detail>;current:Map<string,EvidenceItem>;revision:number};
const cache=new WeakMap<Store,Map<string,State>>();
function state(store:Store,conversation:string):State{
 let all=cache.get(store);if(!all){all=new Map();cache.set(store,all);}
 let found=all.get(conversation);if(found&&found.version===(store.browserEvidenceVersions.get(conversation)??0))return found;
 found={version:store.browserEvidenceVersions.get(conversation)??0,changes:[],details:new Map(),current:new Map(),revision:0};
 const records=store.recordsIn(conversation).filter(r=>r.adapter_fields?.evidence_change).sort((a,b)=>Number((a.adapter_fields!.evidence_change as EvidenceChange).revision)-Number((b.adapter_fields!.evidence_change as EvidenceChange).revision));
 for(const r of records){const c=r.adapter_fields!.evidence_change as EvidenceChange;found.changes.push(c);found.revision=c.revision;for(const d of r.adapter_fields!.evidence_details as Detail[]){found.details.set(d.item.id,d);found.current.set(d.item.id,d.item);}for(const removed of c.removed)found.current.delete(removed.itemId);}
 all.set(conversation,found);return found;
}
function intact(store:Store,source:EvidenceSource){const p=store.under(source.attachment.file);if(!fs.existsSync(p))refuse('EVIDENCE_BYTES_MISSING',source.id,'retained original bytes are unavailable; metadata cannot recreate them');const b=fs.readFileSync(p);if(b.length!==source.attachment.bytes||hash(b)!==source.attachment.sha256)refuse('EVIDENCE_BYTES_CHANGED',source.id,'retained bytes no longer match the accepted digest');return b;}
function detail(store:Store,conversation:string,itemId:string){const d=state(store,conversation).details.get(itemId);if(!d)refuse('EVIDENCE_NOT_FOUND','itemId','no immutable evidence with this identity belongs to the conversation');return d;}
function referenceOf(d:Detail,selector:EvidenceSelector|null):EvidenceReference{return {itemId:d.item.id,sourceId:d.source.id,representationId:d.item.representationId,representationVersion:d.item.representationVersion,sha256:d.item.digest,selector};}
export function validateEvidenceReferences(store:Store,conversation:string,refs:unknown):EvidenceReference[]{
 const faults=validateEvidence({type:'array',maxItems:100,items:EVIDENCE_REFERENCE_SCHEMA},Array.isArray(refs)?refs.map(r=>({...r,selector:toWireSelector(r.selector)})):refs);if(faults.length)throw new StreamFault(faults);
 const result=refs as EvidenceReference[];const problems=[];
 for(const ref of result){try{const d=detail(store,conversation,ref.itemId);const mismatches=[];for(const k of ['sourceId','representationId','representationVersion','sha256'] as const)if(ref[k]!==referenceOf(d,ref.selector)[k])mismatches.push(fault('EVIDENCE_REFERENCE_STALE',k,'reference does not match immutable source identity/version/digest','resolve the exact retained reference before submission'));if(mismatches.length)throw new StreamFault(mismatches);resolveEvidenceFragment(indexEvidenceRepresentation(intact(store,d.source),d.source.attachment.mime,d.source.attachment.filename??''),ref.selector,0,0,1000);}catch(e){if(e instanceof StreamFault)problems.push(...e.faults);else if((e as {faults?:unknown}).faults)problems.push(...(e as StreamFault).faults);else throw e;}}
 if(problems.length)throw new StreamFault(problems);return structuredClone(result);
}
export function presentEvidence(store:Store,{agent,account,workspace,conversationId,releaseId,turnId,delta,now=new Date().toISOString()}:{agent:string;account:string;workspace:BrowserWorkspace;conversationId:string;releaseId:string;turnId:string;delta:unknown;now?:string}){
 const faults=validateEvidence(EVIDENCE_DELTA_SCHEMA,delta);if(faults.length)throw new StreamFault(faults);const raw=delta as EvidenceDelta,selectorFaults:Fault[]=[];const normalize=(selector:unknown)=>{try{return fromWireSelector(selector);}catch(e){if((e as StreamFault).faults)selectorFaults.push(...(e as StreamFault).faults);else throw e;return null;}};const input={...raw,add:raw.add.map(a=>({...a,selector:normalize(a.selector),basis:a.basis.map(r=>({...r,selector:normalize(r.selector)}))}))};if(selectorFaults.length)throw new StreamFault(selectorFaults);
 const active=store.activeBrowserReply;if(!active||active.conversation_id!==conversationId||active.release_id!==releaseId||active.native_turn_id!==turnId)refuse('EVIDENCE_TURN_REFUSED','turn','only the exact currently executing browser turn can publish');
 const messageId=`${conversationId}:evidence:${input.changeId}`,prior=store.read(conversationId,messageId),identity=hash(JSON.stringify(input));
 if(prior){if(prior.adapter_fields?.evidence_identity!==identity)refuse('EVIDENCE_CHANGE_CONFLICT','changeId','identity already names a different explicit delta');return {...prior.adapter_fields!.evidence_change as EvidenceChange,duplicate:true};}
 if(!input.add.length&&!input.remove.length)refuse('EVIDENCE_DELTA_EMPTY','changeId','publication must explicitly add or remove an item');
 const s=state(store,conversationId),ready:Detail[]=[],removed=new Set<string>(),added=new Set<string>(),problems=[];
 for(const removal of input.remove){if(removed.has(removal.itemId)||!s.current.has(removal.itemId))problems.push(fault('EVIDENCE_REMOVE_INVALID',removal.itemId,'removal must name one currently presented item exactly once','read current evidence and give an explicit reason'));removed.add(removal.itemId);}
 for(const add of input.add){try{if(added.has(add.itemId)||s.details.has(add.itemId))refuse('EVIDENCE_ITEM_CONFLICT','itemId','item identities are immutable and cannot be reused');added.add(add.itemId);const source=sourceFromPath(store,conversationId,workspace,add.path);if(add.producerPath)source.producer=sourceFromPath(store,conversationId,workspace,add.producerPath,true);
 const representation=indexEvidenceRepresentation(intact(store,source),source.attachment.mime,source.attachment.filename??'');resolveEvidenceFragment(representation,add.selector,0,0,1000);
 const basis=validateEvidenceReferences(store,conversationId,add.basis);ready.push({item:{id:add.itemId,label:add.label,origin:source.origin,sourceId:source.id,representationId:representation.id,representationVersion:representation.version,digest:source.attachment.sha256,note:add.note,selector:add.selector,changeId:input.changeId},source,basis,assumptions:add.assumptions});}catch(e){if((e as StreamFault).faults)problems.push(...(e as StreamFault).faults);else problems.push(fault('EVIDENCE_FILE_UNAVAILABLE',add.itemId,String((e as Error).message),'finish writing the exact source file and retry'));}}
 if(problems.length)throw new StreamFault(problems);
 const change:EvidenceChange={changeId:input.changeId,messageId,revision:store.nextSeq(),createdAt:now,author:{id:agent,displayName:agent},releaseId,turnId,added:ready.map(d=>d.item),removed:input.remove,note:input.note};
 const record:MessageRecord={schema:'carbon.message.v1',agent,account,source:'browser',conversation_id:conversationId,conversation_kind:'thread',message_id:messageId,platform_message_id:input.changeId,revision:0,direction:'outbound',role:'agent',sender_id:agent,sender_name:agent,received_at:now,sent_at:now,body:input.note??'Evidence updated',attachments:[],historical:false,disposition:'captured',adapter_fields:{evidence_change:change,evidence_details:ready,evidence_identity:identity}};
 store.capture(record);return {...change,duplicate:false};
}
export function readEvidence(store:Store,conversation:string,{anchor=null,cursor=0,limit=50}:{anchor?:string|null;cursor?:number;limit?:number}={}){
 if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)refuse('EVIDENCE_PAGE_INVALID','cursor','expected a bounded integer cursor and limit');
 const s=state(store,conversation);let changes=s.changes;
 if(anchor!==null){const c=s.changes.find(c=>c.changeId===anchor||c.messageId===anchor);if(c)changes=s.changes.filter(c2=>c2.revision<=c.revision);else{const r=store.read(conversation,anchor);if(!r||r.direction!=='outbound')refuse('EVIDENCE_ANCHOR_INVALID','anchor','no publication or response owns this anchor');changes=s.changes.filter(c2=>c2.createdAt<=r.received_at);}}
 const current=new Map<string,EvidenceItem>();for(const c of changes){for(const item of c.added)current.set(item.id,item);for(const r of c.removed)current.delete(r.itemId);}
 const items=[...current.values()];const selected=items.slice(cursor,cursor+limit),end=cursor+selected.length;
 return {conversationId:conversation,revision:changes.at(-1)?.revision??0,anchor:anchor??changes.at(-1)?.messageId??null,items:selected,cursor:end,hasMore:end<items.length,total:items.length};
}
export function readEvidenceChanges(store:Store,conversation:string,cursor=0,limit=100){if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)refuse('EVIDENCE_PAGE_INVALID','cursor','invalid event cursor or page limit');const s=state(store,conversation),all=s.changes.filter(c=>c.revision>cursor),changes=all.slice(0,limit);return {conversationId:conversation,revision:s.revision,changes,cursor:changes.at(-1)?.revision??cursor,hasMore:changes.length<all.length};}
export function readEvidenceFragment(store:Store,conversation:string,itemId:string,selector:EvidenceSelector|null,contextBefore=0,contextAfter=0,limit=100){const d=detail(store,conversation,itemId),download={path:'/api/evidence/download',conversationId:conversation,sourceId:d.source.id};let content,status:'available'|'unavailable'='available';try{content=resolveEvidenceFragment(indexEvidenceRepresentation(intact(store,d.source),d.source.attachment.mime,d.source.attachment.filename??''),selector,contextBefore,contextAfter,limit);}catch(e){if((e as StreamFault).faults?.some(f=>f.code==='EVIDENCE_BYTES_MISSING')){status='unavailable';content={kind:'unavailable',reason:'Immutable source bytes are unavailable; retained metadata is not a substitute.'};}else throw e;}
 const provenance=d.source.provenance,href=provenance?.locator??provenance?.url;let upstreamHref=null;if(typeof href==='string'){try{const u=new URL(href);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)upstreamHref=u.href;}catch{}}return {conversationId:conversation,item:d.item,reference:referenceOf(d,selector),status,content,download,upstreamHref,provenance,basis:d.basis,assumptions:d.assumptions,producer:d.source.producer?{path:'/api/evidence/download',conversationId:conversation,sourceId:d.source.producer.id}:null};}
export function downloadEvidence(store:Store,conversation:string,sourceId:string){for(const d of state(store,conversation).details.values()){for(const s of [d.source,d.source.producer])if(s?.id===sourceId)return {bytes:intact(store,s),filename:s.attachment.filename??'source',mediaType:s.attachment.mime,sha256:s.attachment.sha256};}refuse('EVIDENCE_NOT_FOUND','sourceId','source identity is not retained in this conversation');}
export function evidenceSummary(store:Store,conversation:string){const page=readEvidence(store,conversation,{limit:20});return {schema:'carbon.evidence-current.v1',conversationId:conversation,revision:page.revision,total:page.total,items:page.items.map(i=>({id:i.id,label:i.label.slice(0,100),origin:i.origin})),hasMore:page.hasMore,reader:'evidence_read/evidence_fragment_read; immutable history via evidence_changes'};}
export function writeEvidenceSummary(store:Store,conversation:string,workspace:BrowserWorkspace){const dir=path.join(workspace.analysis,'.agents');assertNoSymlinks(workspace.analysis,dir);fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,'evidence-current.json'),temp=target+'.tmp-'+crypto.randomUUID();fs.writeFileSync(temp,JSON.stringify(evidenceSummary(store,conversation)),{flag:'wx',mode:0o400});fs.renameSync(temp,target);return target;}
export function modelEvidenceReferences(store:Store,conversation:string,references:EvidenceReference[],workspace:BrowserWorkspace){
 validateEvidenceReferences(store,conversation,references);
 const inputs:{type:'localImage';path:string}[]=[],resolved=[];
 for(const reference of references){const d=detail(store,conversation,reference.itemId),bytes=intact(store,d.source),dir=path.join(workspace.evidence,'references',d.source.attachment.sha256);assertNoSymlinks(workspace.evidence,dir);fs.mkdirSync(dir,{recursive:true,mode:0o700});const filename=path.join(dir,d.source.attachment.filename??'source');if(!fs.existsSync(filename))fs.writeFileSync(filename,bytes,{mode:0o400,flag:'wx'});else if(hash(fs.readFileSync(filename))!==d.source.attachment.sha256)refuse('EVIDENCE_BYTES_CHANGED',d.source.id,'materialized reference bytes differ from retained custody');
 const rep=indexEvidenceRepresentation(bytes,d.source.attachment.mime,d.source.attachment.filename??''),content=resolveEvidenceFragment(rep,reference.selector,2,2,1000);resolved.push({reference,label:d.item.label,origin:d.source.origin,provenance:d.source.provenance,path:filename,content});if(rep.kind==='image')inputs.push({type:'localImage',path:filename});
 }
 return {references:resolved,inputs};
}

export function publicEvidenceFragment(result:ReturnType<typeof readEvidenceFragment>){const content={...result.content};if('value' in content)delete content.value;const provenance=result.provenance?Object.fromEntries(['source','locator','fetchedAt','revision','sha256','completeness','conversion'].map(k=>[k,typeof result.provenance![k]==='string'?result.provenance![k]:null])):null;return {...result,content,provenance};}
