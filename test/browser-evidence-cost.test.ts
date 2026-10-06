import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Store,StreamFault} from '../stream/store.ts';
import {browserWorkspace} from '../runtime/browser-files.ts';
import {presentEvidence,readEvidence,readEvidenceFragment,writeEvidenceSummary,evidenceSummary,validateEvidenceReferences,modelEvidenceReferences,downloadEvidence,toWireSelector} from '../runtime/browser-evidence.ts';

test('warm publication, selected fragments and references reuse verified digest indexes; cold history and real missing/changed bytes remain explicit',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'carbon-evidence-cost-'))),other=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'carbon-evidence-sentinel-')));
 const sentinel=path.join(other,'unchanged');fs.writeFileSync(sentinel,'UNCHANGED-SEPARATE-RESOURCE');
 const receipt:{[key:string]:unknown}={source:'actual Store/durable delta/fragment/reference calls; no model/provider',cleanup:{}};
 const originalRead=fs.readFileSync,originalOpen=fs.openSync,originalClose=fs.closeSync,originalDecode=TextDecoder.prototype.decode;
 const descriptors=new Map<number,string>();let fullReads=0,fullBytes=0,indexDecodes=0,historyRows=0,historyCalls=0,stop=()=>{};
 const bytes=Buffer.from(Array.from({length:40000},(_,i)=>`${i+1} | synthetic bounded cost input ${'x'.repeat(60)}`).join('\n'));
 receipt.sourceBytes=bytes.length;
 const measure=()=>({fullReads,fullBytes,indexDecodes,historyRows,historyCalls});
 const delta=(before:ReturnType<typeof measure>)=>Object.fromEntries(Object.entries(measure()).map(([k,v])=>[k,v-before[k as keyof typeof before]]));
 const watchHistory=(store:Store)=>{const records=store.recordsIn.bind(store);store.recordsIn=(key)=>{const rows=records(key);historyCalls++;historyRows+=rows.length;return rows;};};
 try{
  for(const d of ['work','checkout'])fs.mkdirSync(path.join(root,d));const store=Store.open(path.join(root,'store')),conversationId='synthetic-cost:ticket:SYN-101',workspace=browserWorkspace({work:path.join(root,'work'),checkout:path.join(root,'checkout'),conversationId});
  store.activeBrowserReply={conversation_id:conversationId,release_id:'release',native_turn_id:'native',workspace};
  const file=path.join(workspace.analysis,'long.log');fs.writeFileSync(file,bytes);watchHistory(store);
  fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{const fd=originalOpen(...args);descriptors.set(fd,String(args[0]));return fd;}) as typeof fs.openSync;
  fs.closeSync=(fd)=>{descriptors.delete(fd);return originalClose(fd);};
  fs.readFileSync=((p:unknown,...args:unknown[])=>{const b=(originalRead as (...args:unknown[])=>Buffer|string)(p,...args);const filename=typeof p==='number'?descriptors.get(p):String(p);if(filename?.startsWith(root+path.sep)&&Buffer.isBuffer(b)&&b.length===bytes.length){fullReads++;fullBytes+=b.length;}return b;}) as typeof fs.readFileSync;
  TextDecoder.prototype.decode=function(...args:Parameters<typeof originalDecode>){if(args[0]?.byteLength===bytes.length)indexDecodes++;return originalDecode.apply(this,args);};
  let observed=0;stop=store.subscribeBrowserChanges(event=>{if(event.kind==='capture'){observed++;assert.equal(readEvidence(store,conversationId,{limit:20}).total,observed,'synchronous consumer sees the newly durable incremental state');}});
  const ids:string[]=[],anchors:string[]=[];const start=performance.now(),beforePublish=measure();
  for(let i=0;i<100;i++){const itemId=crypto.randomUUID();ids.push(itemId);const change=presentEvidence(store,{agent:'synthetic-cost',account:'synthetic-cost',workspace,conversationId,releaseId:'release',turnId:'native',delta:{changeId:crypto.randomUUID(),add:[{itemId,label:'Bounded cost '+i,path:file,selector:toWireSelector({kind:'lines',start:1,end:1}),note:null,basis:[],assumptions:[],producerPath:null}],remove:[],note:null}});anchors.push(change.messageId);writeEvidenceSummary(store,conversationId,workspace);}
  stop();stop=()=>{};receipt.publication={changes:100,elapsedMs:performance.now()-start,...delta(beforePublish),promptSummaryBytes:Buffer.byteLength(JSON.stringify(evidenceSummary(store,conversationId)))};
  assert.equal(historyRows,0,'warm publication must not replay captured history');assert.equal(indexDecodes,1,'same digest/version/media policy is decoded/indexed once');
  const beforeFragments=measure();let selected=readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:1,end:1},0,0,100);
  for(let i=0;i<10;i++){const f=readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:20000,end:20000},0,0,100);assert.ok('lines' in f.content);assert.equal(f.content.lines?.[0].text,'20000 | synthetic bounded cost input '+ 'x'.repeat(60));}
  receipt.warmTenFragments=delta(beforeFragments);assert.equal(fullReads-beforeFragments.fullReads,0);assert.equal(indexDecodes-beforeFragments.indexDecodes,0);
  const beforeValidation=measure();for(let i=0;i<10;i++)validateEvidenceReferences(store,conversationId,[selected.reference]);receipt.warmTenReferenceValidations=delta(beforeValidation);assert.equal(fullReads-beforeValidation.fullReads,0);
  const beforeMaterialize=measure();modelEvidenceReferences(store,conversationId,[selected.reference],workspace);receipt.firstNativeReferenceMaterialization=delta(beforeMaterialize);
  const beforeModel=measure();for(let i=0;i<10;i++)modelEvidenceReferences(store,conversationId,[selected.reference],workspace);receipt.warmTenNativeReferences=delta(beforeModel);assert.equal(fullReads-beforeModel.fullReads,0);assert.equal(indexDecodes-beforeModel.indexDecodes,0);
  assert.equal(readEvidence(store,conversationId,{anchor:anchors[49],limit:20}).total,50,'anchored history remains exact');
  const beforeCold=measure(),reopened=Store.open(store.dir);watchHistory(reopened);assert.equal(readEvidence(reopened,conversationId,{limit:20}).total,100);readEvidenceFragment(reopened,conversationId,ids[0],{kind:'lines',start:1,end:1},0,0,100);receipt.coldReopenedCurrentAndFragment=delta(beforeCold);assert.equal(historyRows-beforeCold.historyRows,100);assert.equal(indexDecodes-beforeCold.indexDecodes,1);
  const beforeCurrent=measure();for(let i=0;i<10;i++)readEvidence(reopened,conversationId,{cursor:50,limit:20});receipt.warmCurrentPages=delta(beforeCurrent);assert.equal(historyRows-beforeCurrent.historyRows,0);
  const metadata=store.recordsIn(conversationId)[0].adapter_fields?.evidence_details as {source:{attachment:{file:string}}}[];const retained=store.under(metadata[0].source.attachment.file),originalTime=fs.statSync(retained);
  const changed=Buffer.from(bytes);changed[0]=changed[0]===49?50:49;fs.writeFileSync(retained,changed);fs.utimesSync(retained,originalTime.atime,originalTime.mtime);
  const changedRefusal=(fn:()=>unknown)=>assert.throws(fn,(e:unknown)=>e instanceof StreamFault&&e.faults.some(f=>f.code==='EVIDENCE_BYTES_CHANGED'));
  changedRefusal(()=>readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:1,end:1},0,0,100));changedRefusal(()=>validateEvidenceReferences(store,conversationId,[selected.reference]));changedRefusal(()=>modelEvidenceReferences(store,conversationId,[selected.reference],workspace));changedRefusal(()=>downloadEvidence(store,conversationId,selected.reference.sourceId));
  fs.writeFileSync(retained,bytes);assert.equal(readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:1,end:1}).status,'available');
  const download=downloadEvidence(store,conversationId,selected.reference.sourceId);download.bytes[0]=0;assert.equal(downloadEvidence(store,conversationId,selected.reference.sourceId).bytes[0],bytes[0],'download cannot mutate cached custody');
  fs.unlinkSync(retained);assert.equal(readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:1,end:1}).status,'unavailable');assert.throws(()=>validateEvidenceReferences(store,conversationId,[selected.reference]),(e:unknown)=>e instanceof StreamFault&&e.faults.some(f=>f.code==='EVIDENCE_BYTES_MISSING'));
  fs.symlinkSync(sentinel,retained);changedRefusal(()=>readEvidenceFragment(store,conversationId,ids[0],{kind:'lines',start:1,end:1}));assert.equal(fs.readFileSync(sentinel,'utf8'),'UNCHANGED-SEPARATE-RESOURCE');
  receipt.integrityNegatives=['same-size changed bytes with restored mtime refuse fragments/references/native materialization/download','restored exact bytes verified again','download byte mutation cannot poison derived cache','removed retained bytes remain unavailable/refused','symlink replacement refused without reading separate sentinel'];
  receipt.cacheBoundary='Weak Store-owned derived caches check nanosecond device/inode/size/mtime/ctime/mode on each use. Full exact bytes/hash and representation indexing occur on cold/new/changed identities; private custody remains authority. Anchored history reconstructs explicitly; missing notification gaps reconstruct captures. Cache memory scales with consulted originals/indexes until Store collection; no timer/retention policy.';
 }finally{
  stop();fs.readFileSync=originalRead;fs.openSync=originalOpen;fs.closeSync=originalClose;TextDecoder.prototype.decode=originalDecode;
  assert.equal(fs.readFileSync(sentinel,'utf8'),'UNCHANGED-SEPARATE-RESOURCE');fs.rmSync(root,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true});receipt.cleanup={ownedRoot:root,removed:!fs.existsSync(root),separateSentinelUnchanged:true,separateOwnedFixtureRemoved:!fs.existsSync(other)};
  const out=process.env.EVIDENCE_COST_RECEIPT;if(out){assert.equal(path.isAbsolute(out),true);fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');}console.log('evidence-cost',JSON.stringify(receipt));
 }
});
