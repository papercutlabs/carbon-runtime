import { Store, StreamFault } from '../stream/store.ts';
import { fault } from '../stream/faults.ts';
import { presentEvidence, readEvidence, readEvidenceChanges, readEvidenceFragment, writeEvidenceSummary, EVIDENCE_DELTA_SCHEMA, EVIDENCE_SELECTOR_SCHEMA, fromWireSelector } from './browser-evidence.ts';
import type { EvidenceSelector } from './browser-evidence-representation.ts';
const returns={what:'Exact retained evidence result; named faults refuse invalid input without changing membership.',fields:[{name:'result',what:'Retained evidence publication/page/fragment with original identity and version.'}]};
const tool=(name:string,description:string,properties:Record<string,unknown>,readOnlyHint:boolean)=>({name,description,readOnlyHint,writes:false,arguments:{type:'object',additionalProperties:false,required:Object.keys(properties),properties},returns});
const cursor={type:'integer',minimum:0,description:'Retained evidence ordinal; 0 begins retained history.'};
const limit={type:'integer',minimum:1,maximum:1000,description:'Explicit resource page/fragment bound, 1 through 1000.'};
export const EVIDENCE_TOOLS=[
 tool('evidence_present','Explicitly add or remove evidence in the current conversation. Received originals retain their protected source receipt; analysis is labelled as derived. This public change is not a final reply.',Object.fromEntries(Object.entries(EVIDENCE_DELTA_SCHEMA.properties).map(([k,v])=>[k,{...(v as object),description:({changeId:'Stable UUID for exact retry of this explicit delta.',add:'Items to add with stable UUID, label, absolute source/analysis path, selector, note, basis, assumptions and optional producerPath.',remove:'Current item identities to remove, each with a reason.',note:'Optional concise public explanation; null when absent.'} as Record<string,string>)[k],type:k==='changeId'?'string':k==='note'?['string','null']:'array'}])),false),
 tool('evidence_read','Read compact current evidence or one immutable publication/response anchor. Use fragments on demand instead of reading all sources.',{anchor:{type:['string','null'],description:'Exact publication/response message identity or null for current.'},cursor,limit},true),
 tool('evidence_changes','Read immutable explicit additions/removals with reasons in the current conversation.',{cursor,limit},true),
 tool('evidence_fragment_read','Read selected evidence with explicit surrounding context. JSON uses exact pointers; text/table use one-based bounds; images use normalized full-original region.',{itemId:{type:'string',description:'Exact retained evidence item UUID.'},selector:{...EVIDENCE_SELECTOR_SCHEMA,type:['object','null'],description:'Exact lines/rows/field/region selector or null for first/full view.'},contextBefore:{type:'integer',minimum:0,maximum:1000,description:'Explicit preceding context count.'},contextAfter:{type:'integer',minimum:0,maximum:1000,description:'Explicit following context count.'},limit},true)
];
export function evidenceToolHandlers(store:Store,agent:string){
 function active(){const a=store.activeBrowserReply;if(!a?.workspace||!a.native_turn_id)throw new StreamFault([fault('EVIDENCE_TURN_REFUSED','turn','no exact current native browser turn is executing','call only from the active browser investigation')]);return a;}
 return {
 evidence_present:(args:Record<string,unknown>)=>{const a=active(),inbound=store.recordsIn(a.conversation_id).find(r=>r.direction==='inbound'&&r.release?.turn_id===a.release_id);if(!inbound)throw Error('Active browser release lacks retained input');const result=presentEvidence(store,{agent,account:inbound.account,conversationId:a.conversation_id,releaseId:a.release_id,turnId:a.native_turn_id!,workspace:a.workspace!,delta:args});writeEvidenceSummary(store,a.conversation_id,a.workspace!);return {data:{result},text:'Evidence change retained; the final reply fence is unchanged.'};},
 evidence_read:(args:Record<string,unknown>)=>({data:{result:readEvidence(store,active().conversation_id,args as {anchor:string|null;cursor:number;limit:number})}}),
 evidence_changes:(args:Record<string,unknown>)=>({data:{result:readEvidenceChanges(store,active().conversation_id,args.cursor as number,args.limit as number)}}),
 evidence_fragment_read:(args:Record<string,unknown>)=>({data:{result:readEvidenceFragment(store,active().conversation_id,args.itemId as string,fromWireSelector(args.selector),args.contextBefore as number,args.contextAfter as number,args.limit as number)}})
 };
}
