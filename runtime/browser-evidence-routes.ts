import fs from 'node:fs';
import crypto from 'node:crypto';
import {Type,defineRoute,describeRoutes,httpHandler,fail,RouteFault} from '@pcl/routes';
import {Store} from '../stream/store.ts';
import {evidenceToolHandlers} from './browser-evidence-tools.ts';
const schemas=JSON.parse(fs.readFileSync(new URL('../schema/browser-evidence-interface.json',import.meta.url),'utf8'));
const obj=(properties:Record<string,unknown>)=>Type.Object(Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,Type.Unsafe(v as Record<string,unknown>)])),{additionalProperties:false});
const integer={type:'integer',minimum:0,description:'Explicit nonnegative retained ordinal or surrounding context count.'};
const limit={type:'integer',minimum:1,maximum:1000,description:'Explicit page/fragment resource limit.'};
function sameBearer(supplied:string,expected:string|undefined){
 if(!expected||Buffer.byteLength(supplied)>4096)return false;
 const actual=Buffer.from(supplied),wanted=Buffer.from(expected);
 return actual.length===wanted.length&&crypto.timingSafeEqual(actual,wanted);
}
function docs(s:Record<string,unknown>,name='value'){if(!s.description)s.description='Explicit retained '+name+'.';for(const [k,v]of Object.entries(s.properties??{}))docs(v as Record<string,unknown>,k);if(s.items)docs(s.items as Record<string,unknown>,name+' item');for(const v of s.anyOf as Record<string,unknown>[]??[])docs(v,name);return s;}
export function evidenceAgentRoutes(store:Store,agent:string,{apiToken}:{apiToken?:string}={}){
 const handlers=evidenceToolHandlers(store,agent),refusals=['EVIDENCE_TURN_REFUSED','EVIDENCE_SELECTOR_INVALID','EVIDENCE_REFERENCE_STALE','EVIDENCE_NOT_FOUND','EVIDENCE_BYTES_MISSING','EVIDENCE_CHANGE_CONFLICT','EVIDENCE_PATH_REFUSED','EVIDENCE_DELTA_EMPTY','EVIDENCE_REMOVE_INVALID','EVIDENCE_ITEM_CONFLICT','EVIDENCE_RESOURCE_LIMIT','EVIDENCE_PROVENANCE_INVALID','EVIDENCE_ORIGINAL_UNREGISTERED','EVIDENCE_TEMPLATE_REFUSED'].map(code=>({code,resolver:'agent' as const,description:code.toLowerCase().replaceAll('_',' ')+'.',fix:'Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.'}));
 const invoke=(id:keyof typeof handlers)=>(input:Record<string,unknown>)=>{try{return handlers[id](input).data.result;}catch(e){const errors=(e as {faults?:{code:string;subject:string;problem:string;fix:string}[]}).faults;if(errors?.length){const first=errors[0];throw new RouteFault(first.code,errors,400);}throw e;}};
 const routes=[
 defineRoute({id:'evidence_present',method:'POST',path:'/api/evidence/present',summary:'Publish one explicit evidence delta on the exact currently executing native turn; final reply fence is unchanged.',scope:'write',kind:'create',input:obj(docs(schemas.delta).properties as Record<string,unknown>),output:Type.Unsafe(docs(schemas.present)),refusals,run:invoke('evidence_present'),readback:(written)=>written}),
 defineRoute({id:'evidence_read',method:'GET',path:'/api/evidence',summary:'Read a compact current set or one immutable conversation anchor, then detail on demand.',scope:'read',kind:'read',input:obj({anchor:{type:['string','null'],description:'Exact anchor or null for current.'},cursor:integer,limit}),output:Type.Unsafe(schemas.page),refusals,run:invoke('evidence_read')}),
 defineRoute({id:'evidence_changes',method:'GET',path:'/api/evidence/changes',summary:'Read explicit retained evidence additions/removals and reasons.',scope:'read',kind:'read',input:obj({cursor:integer,limit}),output:Type.Unsafe(schemas.changes),refusals,run:invoke('evidence_changes')}),
 defineRoute({id:'evidence_fragment_read',method:'GET',path:'/api/evidence/fragment',summary:'Read exact selected source representation with explicit context and immutable original download identity.',scope:'read',kind:'read',input:obj({itemId:{type:'string',description:'Exact immutable item UUID.'},selector:docs(schemas.selector),contextBefore:integer,contextAfter:integer,limit}),output:Type.Unsafe(schemas.fragment),refusals,run:invoke('evidence_fragment_read')})
 ];
 return {routes,description:describeRoutes('carbon-browser-evidence',routes,'0.1.0'),handler:httpHandler(routes,async request=>{if(request.headers.get('origin')!==null)fail('EVIDENCE_TURN_REFUSED','origin','Browser origins cannot use native agent evidence operations.','Use the separately authenticated companion reader.',403);const supplied=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';if(!sameBearer(supplied,apiToken))fail('EVIDENCE_TURN_REFUSED','credential','No current reply-process generated API grant.','Use the owner-provided ephemeral native API grant; app credentials do not authorize publishing.',403);if(!store.activeBrowserReply?.native_turn_id)fail('EVIDENCE_TURN_REFUSED','turn','No exact executing native turn.','Use only its current reply-tool process.',403);return {client:agent,actor:agent,kind:'service',scopes:['read','write']};})};
}
