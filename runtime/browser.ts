import { readEvidence, readEvidenceChanges, readEvidenceFragment, downloadEvidence, validateEvidenceReferences } from './browser-evidence.ts';
// Public browser store bridge. External HTTP/CLI/MCP callers belong to the
// companion's typed route boundary; this is the trusted shared library.
import fs from 'node:fs';
import { Store, type MessageRecord } from '../stream/store.ts';
import { encodeComponent } from '../stream/encode.ts';
import { browserPacket, browserConversationId, payload, type BrowserPacket } from '../adapters/browser/index.ts';
import { RuntimeFault, fault } from './faults.ts';
import { readBrowserActivity, type BrowserActivity } from './browser-activity.ts';
import { stageBrowserAttachment, readBrowserAttachment, resolveBrowserAttachments, bindBrowserAttachments, type BrowserWorkspace, createBrowserEvidenceWriter } from './browser-files.ts';
import { browserPageRows } from './browser-projection.ts';
export type BrowserAuthorization = (grant: unknown, ticketKey: string, operation: 'submit' | 'read' | 'watch' | 'operator') => boolean;
export type BrowserPreparation = (input: { ticketKey: string; conversationId: string; unitId: string; submissionIds: string[]; releaseId: string; records: MessageRecord[]; workspace?: BrowserWorkspace; writeEvidence?: ReturnType<typeof createBrowserEvidenceWriter> }) => Promise<unknown>;
export type BrowserPage = { conversation_id: string; records: { cursor: number; record: MessageRecord; event: 'capture' | 'state' }[]; cursor: number; has_more: boolean; activity: BrowserActivity | null; activity_cursor: number };
function refuse(code: string, subject: string, problem: string): never {
  throw new RuntimeFault(fault(code, subject, problem, 'repair the server grant or exact submitted value before retrying'));
}
export function browserHistory(store: Store, conversationId: string) {
  const records = store.recordsIn(conversationId);
  const indexed = store.indexEntries() as { conversation_id: string; message_id: string; revision: number; seq: number }[];
  const order = new Map(indexed.filter((r) => r.conversation_id === conversationId).map((r) => [`${r.message_id}:${r.revision}`, r.seq]));
  return records.sort((a, b) => (order.get(`${a.message_id}:${a.revision}`) ?? Infinity) - (order.get(`${b.message_id}:${b.revision}`) ?? Infinity));
}
type BrowserWatchOptions = { after?: number; activityAfter?: number; limit?: number; timeoutMs: number; signal?: AbortSignal };
type BrowserCheck = (grant: unknown, key: string, operation: Parameters<BrowserAuthorization>[2]) => string;
type BrowserRead = (grant: unknown, key: string, options?: { after?: number; activityAfter?: number; limit?: number }) => BrowserPage;

function sameBrowserSubmission(prior: MessageRecord, record: MessageRecord, packet: BrowserPacket) {
  return prior.body === record.body && prior.sender_id === record.sender_id && prior.sender_name === record.sender_name
    && prior.adapter_fields?.request_kind === packet.request_kind && prior.adapter_fields?.input_kind === packet.input_kind
    && JSON.stringify(prior.adapter_fields?.attachment_ids ?? []) === JSON.stringify(packet.attachment_ids ?? [])
    && JSON.stringify(prior.adapter_fields?.references ?? []) === JSON.stringify(packet.references ?? []);
}

export function createBrowserBridge({ store, agent, account, authorize }: { store: Store; agent: string; account: string; authorize: BrowserAuthorization }) {
  if (typeof authorize !== 'function') refuse('BROWSER_AUTHORIZER_ABSENT', account, 'browser operations require a current server grant');
  function check(grant: unknown, key: string, operation: Parameters<BrowserAuthorization>[2]) {
    const conversation = browserConversationId(account, key);
    if (authorize(grant, key, operation) !== true) refuse('BROWSER_ACCESS_DENIED', key, 'current grant does not permit this operation');
    return conversation;
  }
  function read(grant: unknown, key: string, { after = 0, activityAfter = 0, limit = 100 }: { after?: number; activityAfter?: number; limit?: number } = {}): BrowserPage {
    const conversation_id = check(grant, key, 'read');
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(activityAfter) || activityAfter < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) refuse('BROWSER_READ_INVALID', key, 'cursor or page limit is invalid');
    const page = browserPageRows(store, conversation_id, after, limit);
    const records = page.rows.map((row) => ({ cursor: row.cursor,
      record: store.read(conversation_id, row.message_id, row.revision)!, event: row.cursor > row.seq ? 'state' as const : 'capture' as const }));
    return { conversation_id, records, cursor: records.at(-1)?.cursor ?? after, has_more: page.has_more, ...readBrowserActivity(store, conversation_id) };
  }
  return {
    submit(grant: unknown, candidate: BrowserPacket) {
      const packet = browserPacket(candidate);
      const conversationId = check(grant, packet.ticket_key, 'submit');
      if (packet.account !== account) refuse('BROWSER_ACCESS_DENIED', packet.account, 'packet account differs from configured account');
      const { record, raw, cursor } = payload({ store, agent, account }, [packet]).entries[0];
      const prior = store.read(conversationId, record.message_id);
      if (prior) {
        const same = sameBrowserSubmission(prior, record, packet);
        if (!same) refuse('BROWSER_SUBMISSION_CONFLICT', packet.submission_id, 'accepted identity was reused with changed body, actor or request kind');
        bindBrowserAttachments(store, { conversationId, actorId: packet.consultant.id, attachmentIds: packet.attachment_ids ?? [], messageId: prior.message_id });
        return { record: prior, duplicate: true };
      }
      validateEvidenceReferences(store, conversationId, packet.references ?? []);
      record.attachments = resolveBrowserAttachments(store, { conversationId, actorId: packet.consultant.id, attachmentIds: packet.attachment_ids ?? [] });
      const accepted = store.capture(record, { raw, cursor }).record;
      bindBrowserAttachments(store, { conversationId, actorId: packet.consultant.id, attachmentIds: packet.attachment_ids ?? [], messageId: record.message_id });
      return { record: accepted, duplicate: false };
    },
    stageAttachment(grant: unknown, key: string, input: Omit<Parameters<typeof stageBrowserAttachment>[1], 'conversationId'>) {
      const conversationId = check(grant, key, 'submit');
      return stageBrowserAttachment(store, { ...input, conversationId });
    },
    readAttachment(grant: unknown, key: string, attachmentId: string, { includeBytes = true }: { includeBytes?: boolean } = {}) {
      const conversationId = check(grant, key, 'read');
      const result = readBrowserAttachment(store, { conversationId, attachmentId, includeBytes });
      const actor = (grant as { consultant?: { id?: string } } | null)?.consultant?.id;
      if (result.metadata.bound_message_id === null && result.metadata.actor_id !== null && result.metadata.actor_id !== actor)
        refuse('BROWSER_FILE_ACTOR_REFUSED', attachmentId, 'unsubmitted bytes belong only to their authenticated staging actor');
      return result;
    },
    read,
    watch(grant: unknown, key: string, options: BrowserWatchOptions): Promise<BrowserPage> {
      const conversationId = check(grant, key, 'watch');
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 30000) refuse('BROWSER_WAIT_INVALID', key, 'wait must be between zero and 30000 ms');
      return watchBrowserChanges(store, conversationId, grant, key, options, check, read);
    },
    evidenceRead(grant:unknown,key:string,options:Parameters<typeof readEvidence>[2]) { return readEvidence(store,check(grant,key,'read'),options); },
    evidenceChanges(grant:unknown,key:string,{cursor=0,limit=100,waitMs=0,signal}:{cursor?:number;limit?:number;waitMs?:number;signal?:AbortSignal}={}) {
      const conversation=check(grant,key,'watch');
      return watchEvidenceChanges(store,conversation,()=>{check(grant,key,'watch');return readEvidenceChanges(store,conversation,cursor,limit);},waitMs,signal);
    },
    evidenceFragment(grant:unknown,key:string,itemId:string,selector:Parameters<typeof readEvidenceFragment>[3],before:number,after:number,limit:number){return readEvidenceFragment(store,check(grant,key,'read'),itemId,selector,before,after,limit);},
    evidenceDownload(grant:unknown,key:string,sourceId:string){return downloadEvidence(store,check(grant,key,'read'),sourceId);},
    operatorRead(grant: unknown, key: string) {
      const conversation_id = check(grant, key, 'operator');
      const records = browserHistory(store, conversation_id);
      return { conversation_id, thread: store.readThread(conversation_id), records, ...readBrowserActivity(store, conversation_id),
        uncertain: records.filter((record) => record.adapter_fields?.model_effect === 'uncertain').map((record) => ({ message_id: record.message_id, release: record.release, evidence: record.adapter_fields?.model_effect_evidence })) };
    }
  };
}

function watchBrowserChanges(store: Store, conversationId: string, grant: unknown, key: string, options: BrowserWatchOptions, check: BrowserCheck, read: BrowserRead): Promise<BrowserPage> {
  return new Promise((resolve, reject) => {
    const watchers: fs.FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const cleanup = () => { for (const watcher of watchers) watcher.close(); if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const finish = (force = false) => {
      if (settled) return;
      try {
        check(grant, key, 'watch');
        const page = read(grant, key, options);
        if (!force && !page.records.length && page.activity_cursor <= (options.activityAfter ?? 0)) return;
        settled = true; cleanup(); resolve(page);
      } catch (error) { settled = true; cleanup(); reject(error); }
    };
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(new RuntimeFault(fault('BROWSER_WAIT_ABORTED', key, 'consumer closed its event wait', 'open a new wait with the retained cursor'))); };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    // Install watchers before the second read to close read/watch races.
    try {
    for (const dir of [store.under('captures'), store.under('threads')]) {
      watchers.push(fs.watch(dir, (_event, filename) => { if (filename && (String(filename) === encodeComponent(conversationId) || String(filename) === `${encodeComponent(conversationId)}.json`)) finish(); }));
    }
    const ticketDir = store.under('captures', encodeComponent(conversationId));
    if (fs.existsSync(ticketDir)) watchers.push(fs.watch(ticketDir, () => finish()));
    } catch (error) { settled = true; cleanup(); reject(error); return; }
    const page = read(grant, key, options);
    if (page.records.length > 0 || page.activity_cursor > (options.activityAfter ?? 0)) { finish(); return; }
    timer = setTimeout(() => finish(true), options.timeoutMs);
  });
}

function watchEvidenceChanges(store:Store,conversation:string,read:()=>ReturnType<typeof readEvidenceChanges>,waitMs:number,signal?:AbortSignal){
      if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>30000)refuse('EVIDENCE_WAIT_INVALID','waitMs','expected explicit bounded wait');
      const initial=read();if(initial.changes.length||waitMs===0)return Promise.resolve(initial);
      return new Promise<ReturnType<typeof readEvidenceChanges>>((resolve,reject)=>{let stop=()=>{},timer:ReturnType<typeof setTimeout>|undefined,done=false;
        const cleanup=()=>{stop();if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);};
        const finish=(force=false)=>{if(done)return;try{const page=read();if(!force&&!page.changes.length)return;done=true;cleanup();resolve(page);}catch(e){done=true;cleanup();reject(e);}};
        const abort=()=>{if(done)return;done=true;cleanup();reject(new Error('Evidence wait aborted'));};
        stop=store.subscribeBrowserChanges(e=>{if(e.conversation_id===conversation)finish();});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}timer=setTimeout(()=>finish(true),waitMs);finish();
      });
}
