import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Store,type MessageRecord} from '../stream/store.ts';
import {browserWorkspace} from '../runtime/browser-files.ts';
import {presentEvidence,readEvidence,toWireSelector} from '../runtime/browser-evidence.ts';

test('a missed evidence notification gap reconstructs durable captures and preserves historical/current removal independently',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'carbon-evidence-gap-')));
 try{
  for(const dir of ['work','checkout'])fs.mkdirSync(path.join(root,dir));const store=Store.open(path.join(root,'store')),conversationId='synthetic:ticket:SYN-101',workspace=browserWorkspace({work:path.join(root,'work'),checkout:path.join(root,'checkout'),conversationId});
  store.activeBrowserReply={conversation_id:conversationId,release_id:'release',native_turn_id:'native',workspace};const file=path.join(workspace.analysis,'source.txt');fs.writeFileSync(file,'actual retained content');
  const firstId=crypto.randomUUID(),first=presentEvidence(store,{agent:'synthetic',account:'synthetic',workspace,conversationId,releaseId:'release',turnId:'native',delta:{changeId:crypto.randomUUID(),add:[{itemId:firstId,label:'First',path:file,selector:toWireSelector({kind:'lines',start:1,end:1}),note:null,basis:[],assumptions:[],producerPath:null}],remove:[],note:null}});assert.equal(readEvidence(store,conversationId).total,1);
  const original=store.read(conversationId,first.messageId)!;
  for(let i=0;i<2;i++){const record=structuredClone(original),change=record.adapter_fields!.evidence_change as {changeId:string;messageId:string;revision:number;added:{id:string;changeId:string}[]},changeId=crypto.randomUUID();record.message_id=conversationId+':evidence:'+changeId;record.platform_message_id=changeId;change.changeId=changeId;change.messageId=record.message_id;change.revision=store.nextSeq();const itemId=crypto.randomUUID();change.added[0].id=itemId;change.added[0].changeId=changeId;const details=record.adapter_fields!.evidence_details as {item:{id:string;changeId:string}}[];details[0].item.id=itemId;details[0].item.changeId=changeId;store.capture(record as MessageRecord);}
  let scanned=0;const records=store.recordsIn.bind(store);store.recordsIn=key=>{const rows=records(key);scanned+=rows.length;return rows;};assert.equal(readEvidence(store,conversationId).total,3);assert.equal(scanned,3,'notification gap must reconstruct actual captures');assert.equal(readEvidence(store,conversationId,{anchor:first.messageId}).total,1);
  presentEvidence(store,{agent:'synthetic',account:'synthetic',workspace,conversationId,releaseId:'release',turnId:'native',delta:{changeId:crypto.randomUUID(),add:[],remove:[{itemId:firstId,reason:'No longer current'}],note:null}});assert.equal(readEvidence(store,conversationId).total,2);assert.equal(readEvidence(store,conversationId,{anchor:first.messageId}).items[0].id,firstId);assert.equal(scanned,3,'following single capture updates the maintained map without a second reconstruction');assert.equal(store.browserListeners.size,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}
});
