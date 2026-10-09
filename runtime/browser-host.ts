// The one public entry for browser hosts. A host imports this module and nothing
// else from Carbon; it never reads a stored record or an adapter_fields key.
// Views are declared by schema/carbon.browser-host.v1.json. A breaking change to
// a view needs a new schema version. Internal module paths are not a contract.
import fs from 'node:fs';
import type { Store, MessageRecord, Attachment } from '../stream/store.ts';
import type { BrowserPacket } from '../adapters/browser/index.ts';
import type { EvidenceReference } from '../lib/browser-evidence.ts';
import { createBrowserBridge, type BrowserPage } from './browser.ts';
import { publicEvidenceFragment, fromWireSelector } from './browser-evidence.ts';
import { RuntimeFault, fault } from './faults.ts';

const BROWSER_HOST_VERSION = 'carbon.browser-host.v1';
export const BROWSER_HOST_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/carbon.browser-host.v1.json', import.meta.url), 'utf8'));
export type MessageState = 'accepted' | 'queued' | 'running' | 'answer' | 'evidence_update' | 'failed' | 'uncertain';
export type FileView = { fileId: string; filename: string; mediaType: string; bytes: number; sha256: string };
export type MessageView = { schema: typeof BROWSER_HOST_VERSION; messageId: string; conversationId: string; role: MessageRecord['role'];
  sender: { id: string; name: string | null }; text: string; createdAt: string; replyTo: string | null; turnId: string | null; submissionIds: string[];
  files: FileView[]; state: MessageState; validationFaults: { code: string; subject: string; problem: string }[]; nativeReason: string | null;
  requestKind: RequestKind | null; inputKind: 'start' | 'message' | null; reply: ReplyView | null };
export type RequestKind = 'investigate' | 'follow_up' | 'copy_draft';
// What the agent said about its own answer, decoded once. `sources` entries are the agent's JSON values, passed through.
export type ReplyView = { sources: unknown[]; uncertainty: string[]; draftLabel: string | null };
// One flat provenance for both kinds of original: a fetched source (`received`) and a consultant's upload; fields the kind lacks are null.
const PROVENANCE_TEXT = ['source', 'locator', 'fetchedAt', 'revision', 'sha256', 'completeness', 'conversion', 'actorId', 'actorName', 'attachmentId', 'mediaType', 'filename', 'boundAt'] as const;
export type ProvenanceView = { kind: 'received' | 'consultant_upload' } & Record<typeof PROVENANCE_TEXT[number], string | null> & { bytes: number | null };
function provenanceView(provenance: Record<string, unknown> | null): ProvenanceView | null {
  if (!provenance) return null;
  return { kind: provenance.kind === 'consultant_upload' ? 'consultant_upload' : 'received', ...Object.fromEntries(PROVENANCE_TEXT.map((key) => [key, text(provenance[key])])),
    bytes: Number.isInteger(provenance.bytes) ? provenance.bytes as number : null } as ProvenanceView;
}
export type CanvasItem = { itemId: string; template: string; label: string;
  source: { sourceId: string; sha256: string; selector: object | null; note: string | null; provenance: ProvenanceView | null };
  history: { changeId: string; revision: number; at: string; change: 'added' | 'removed'; reason: string | null }[] };

// The stored key names this module reads, in one place. A test drives the real
// producers and checks each name is still written, so a rename breaks Carbon's
// tests rather than a host.
export const HOST_ADAPTER_FIELDS = { evidenceChange: 'evidence_change', modelEffect: 'model_effect', modelEffectEvidence: 'model_effect_evidence',
  submissionIds: 'submission_ids', replyValidationFaults: 'reply_validation_faults', responseMetadata: 'response_metadata',
  browserDelivery: 'browser_delivery', requestKind: 'request_kind', inputKind: 'input_kind' } as const;
const F = HOST_ADAPTER_FIELDS;

const field = (record: MessageRecord, key: string) => record.adapter_fields?.[key];
const phaseOf = (record: MessageRecord) => (field(record, F.browserDelivery) as { phase?: string } | undefined)?.phase;
const text = (value: unknown) => typeof value === 'string' ? value : null;

function inboundState(record: MessageRecord): MessageState {
  if (field(record, F.modelEffect) === 'uncertain' || phaseOf(record) === 'uncertain') return 'uncertain';
  if (phaseOf(record) === 'failed') return 'failed';
  if (phaseOf(record) === 'completed' || record.release?.completed_at) return 'answer';
  if (record.release) return 'running';
  return record.hold || phaseOf(record) === 'next_turn' ? 'queued' : 'accepted';
}
function outboundState(record: MessageRecord): MessageState {
  if (field(record, F.evidenceChange)) return 'evidence_update';
  const faults = field(record, F.replyValidationFaults);
  if (record.delivery?.status === 'failed' || record.disposition === 'parked' || (Array.isArray(faults) && faults.length > 0)) return 'failed';
  if (record.delivery?.status === 'unknown' || field(record, F.modelEffect) === 'uncertain') return 'uncertain';
  return 'answer';
}
// An input's state is the progress of the response it asked for; it is `answer`
// once answered. Only an outbound message in state `answer` is an answer to count.
function messageState(record: MessageRecord): MessageState {
  return record.direction === 'outbound' ? outboundState(record) : inboundState(record);
}
// A reason is plain text, or a record carrying one: a fault (problem), native failure evidence (original_reason), an error (message).
export function reasonOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length ? value : null;
  if (Array.isArray(value)) { for (const one of value) { const found = reasonOf(one); if (found) return found; } return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['problem', 'original_reason', 'message', 'reason']) { const found = reasonOf(record[key]); if (found) return found; }
  if ('original_reason' in record || !Object.keys(record).length) return null;
  return JSON.stringify(value);
}
// Delivery reason first, then what the loop retained about the model effect: the native failure text, an explicit
// loop reason, the thread inspection's disposition.
function reasonText(record: MessageRecord): string | null {
  const delivery = field(record, F.browserDelivery) as { reason?: unknown } | undefined;
  const evidence = field(record, F.modelEffectEvidence) as { reason?: unknown; original_reason?: unknown; native_read?: unknown } | undefined;
  const read = evidence?.native_read as { original_reason?: unknown; disposition?: unknown } | undefined;
  for (const reason of [delivery?.reason, evidence?.original_reason, evidence?.reason, read?.original_reason, read?.disposition]) {
    const found = reasonOf(reason);
    if (found) return found;
  }
  return null;
}
function replyView(record: MessageRecord): ReplyView | null {
  const metadata = field(record, F.responseMetadata);
  if (record.direction !== 'outbound' || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const given = metadata as Record<string, unknown>;
  return { sources: Array.isArray(given.sources) ? given.sources.filter((one) => one && typeof one === 'object' && !Array.isArray(one)) : [], uncertainty: typeof given.uncertainty === 'string' ? [given.uncertainty] : Array.isArray(given.uncertainty) ? given.uncertainty.filter((one): one is string => typeof one === 'string') : [], draftLabel: text(given.draftLabel) };
}
const REQUEST_KINDS: readonly unknown[] = ['investigate', 'follow_up', 'copy_draft'];
function faultViews(record: MessageRecord) {
  const faults = field(record, F.replyValidationFaults);
  return (Array.isArray(faults) ? faults : []).map((one: Record<string, unknown>) => ({ code: String(one.code), subject: String(one.subject ?? ''), problem: String(one.problem ?? '') }));
}
export function messageView(record: MessageRecord): MessageView {
  const submissions = field(record, F.submissionIds);
  return { schema: BROWSER_HOST_VERSION, messageId: record.message_id, conversationId: record.conversation_id, role: record.role,
    sender: { id: record.sender_id, name: record.sender_name ?? null }, text: record.body, createdAt: record.received_at, replyTo: record.reply_to ?? null,
    turnId: record.release?.turn_id ?? record.delivery?.request_id ?? null,
    submissionIds: record.direction === 'inbound' ? [record.platform_message_id] : Array.isArray(submissions) ? submissions.map(String) : [],
    files: (record.attachments as Attachment[]).filter((one) => one.attachment_id).map((one) => ({ fileId: one.attachment_id!, filename: one.filename ?? 'attachment',
      mediaType: one.mime, bytes: one.bytes, sha256: one.sha256 })),
    state: messageState(record), validationFaults: faultViews(record), nativeReason: reasonText(record),
    requestKind: REQUEST_KINDS.includes(field(record, F.requestKind)) ? field(record, F.requestKind) as RequestKind : null,
    inputKind: field(record, F.inputKind) === 'start' || field(record, F.inputKind) === 'message' ? field(record, F.inputKind) as 'start' | 'message' : null,
    reply: replyView(record) };
}

// Carbon fixes one template, `original`. Every other template string is the agent package's and opaque here.
const KNOWN_ORIGINS: readonly string[] = ['original', 'analysis'];
export function templateOf(item: { origin: string; template: string }): string {
  if (!KNOWN_ORIGINS.includes(item.origin)) throw new RuntimeFault(fault('BROWSER_HOST_ORIGIN_UNKNOWN', 'origin', `evidence origin ${item.origin} is unknown`, 'publish evidence with origin original or analysis'));
  return item.template;
}

type Bridge = ReturnType<typeof createBrowserBridge>;
type Consultant = { id: string; name: string };
// `requestKind` is the legacy request form; it replaces `inputKind`, and giving both is refused.
export type HostSubmission = { ticketKey: string; submissionId: string; consultant: Consultant; text: string; inputKind?: 'start' | 'message'; requestKind?: RequestKind;
  fileIds?: string[]; references?: EvidenceReference[]; acceptedAt?: string; position?: string };
type PageOptions = { after?: number; activityAfter?: number; limit?: number };

function pageView(page: BrowserPage) {
  const activity = page.activity;
  return { schema: BROWSER_HOST_VERSION, conversationId: page.conversation_id,
    messages: page.records.map((one) => ({ cursor: one.cursor, event: one.event, message: messageView(one.record) })),
    cursor: page.cursor, hasMore: page.has_more, activityCursor: page.activity_cursor,
    activity: activity === null ? null : { state: (activity.state === 'completed' ? 'answer' : activity.state) as MessageState | null, turnId: activity.release_id,
      nativeTurnId: activity.native_turn_id ?? null, nativeReason: reasonOf(activity.reason),
      submissionIds: activity.submission_ids, update: activity.update === null ? null : { itemId: activity.update.item_id, text: activity.update.text, observedAt: activity.update.observed_at } } };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
function answerLatency(answer: MessageRecord, inputs: Map<string, MessageRecord>) {
  const asked = (answer.adapter_fields?.[F.submissionIds] as string[] | undefined ?? []).map((id) => inputs.get(id)).filter((one): one is MessageRecord => !!one);
  if (!asked.length) return null;
  return Math.max(0, Date.parse(answer.received_at) - Math.min(...asked.map((one) => Date.parse(one.received_at))));
}
function summarize(records: MessageRecord[], from: string, to: string, ticketKeys: string[]) {
  const inPeriod = (record: MessageRecord) => record.received_at >= from && record.received_at < to;
  const inputs = new Map(records.filter((one) => one.direction === 'inbound').map((one) => [one.platform_message_id, one]));
  const answers = records.filter((one) => one.direction === 'outbound' && inPeriod(one) && messageState(one) === 'answer');
  const perAnswer = answers.map((one) => ({ messageId: one.message_id, ms: answerLatency(one, inputs) }));
  return { schema: BROWSER_HOST_VERSION, from, to, ticketKeys,
    inputs: [...inputs.values()].filter(inPeriod).length, answers: answers.length,
    evidenceUpdates: records.filter((one) => one.direction === 'outbound' && inPeriod(one) && messageState(one) === 'evidence_update').length,
    unmarkedAnswers: answers.filter((one) => !field(one, F.responseMetadata)).length,
    latency: { perAnswer, medianMs: median(perAnswer.flatMap((one) => one.ms === null ? [] : [one.ms])) } };
}

export function createBrowserHost({ store, bridge, account }: { store: Store; bridge: Bridge; account: string }) {
  async function submit(grant: unknown, input: HostSubmission) {
    const packet: BrowserPacket = { account, ticket_key: input.ticketKey, submission_id: input.submissionId, consultant: input.consultant,
      ...(input.requestKind === undefined ? { input_kind: input.inputKind ?? 'message' } : { request_kind: input.requestKind, ...(input.inputKind === undefined ? {} : { input_kind: input.inputKind }) }), body: input.text, attachment_ids: input.fileIds ?? [], references: input.references ?? [],
      accepted_at: input.acceptedAt ?? new Date().toISOString(), position: input.position ?? String(store.nextSeq()).padStart(20, '0') };
    const { record, duplicate } = bridge.submit(grant, packet);
    return { message: messageView(record), duplicate };
  }
  async function readConversation(grant: unknown, ticketKey: string, options: PageOptions = {}) {
    return pageView(bridge.read(grant, ticketKey, options));
  }
  return {
    // Attach to the ticket's conversation; with `start`, begin it when it has no messages yet.
    async openConversation(grant: unknown, ticketKey: string, start?: Omit<HostSubmission, 'ticketKey' | 'inputKind' | 'text'>) {
      const page = pageView(bridge.read(grant, ticketKey, { limit: 1 }));
      if (page.messages.length || !start) return { conversationId: page.conversationId, created: false, page };
      await submit(grant, { ...start, ticketKey, text: '', inputKind: 'start' });
      return { conversationId: page.conversationId, created: true, page: await readConversation(grant, ticketKey, { limit: 1 }) };
    },
    submitMessage: submit,
    async stageFile(grant: unknown, ticketKey: string, input: Parameters<Bridge['stageAttachment']>[2]) {
      const staged = bridge.stageAttachment(grant, ticketKey, input);
      return { fileId: staged.attachment_id, filename: staged.filename, mediaType: staged.mime, bytes: staged.bytes, sha256: staged.sha256, duplicate: staged.duplicate };
    },
    readConversation,
    // Messages after a cursor, waiting up to timeoutMs (0 returns at once).
    async readChanges(grant: unknown, ticketKey: string, options: PageOptions & { timeoutMs?: number; signal?: AbortSignal } = {}) {
      return pageView(await bridge.watch(grant, ticketKey, { ...options, timeoutMs: options.timeoutMs ?? 0 }));
    },
    async readMessage(grant: unknown, ticketKey: string, messageId: string) {
      const record = bridge.readMessage(grant, ticketKey, messageId);
      return record ? messageView(record) : null;
    },
    async readFiles(grant: unknown, ticketKey: string, fileIds: string[], { includeBytes = false }: { includeBytes?: boolean } = {}) {
      return fileIds.map((fileId) => {
        const { metadata, bytes } = bridge.readAttachment(grant, ticketKey, fileId, { includeBytes });
        return { fileId: metadata.attachment_id, filename: metadata.filename, mediaType: metadata.mime, bytes: metadata.bytes, sha256: metadata.sha256, content: bytes };
      });
    },
    async readCanvas(grant: unknown, ticketKey: string, { cursor = 0, limit = 50, anchor = null }: { cursor?: number; limit?: number; anchor?: string | null } = {}) {
      const page = bridge.evidenceRead(grant, ticketKey, { cursor, limit, anchor });
      const changes = (await bridge.evidenceChanges(grant, ticketKey, { limit: 1000 })).changes;
      const items: CanvasItem[] = page.items.map((item) => {
        const fragment = publicEvidenceFragment(bridge.evidenceFragment(grant, ticketKey, item.id, item.selector, 0, 0, 1));
        return { itemId: item.id, template: templateOf(item), label: item.label,
          source: { sourceId: item.sourceId, sha256: item.digest, selector: item.selector, note: item.note, provenance: provenanceView(fragment.provenance as Record<string, unknown> | null) },
          history: changes.flatMap((change) => [
            ...change.added.filter((one) => one.id === item.id).map(() => ({ changeId: change.changeId, revision: change.revision, at: change.createdAt, change: 'added' as const, reason: change.note })),
            ...change.removed.filter((one) => one.itemId === item.id).map((one) => ({ changeId: change.changeId, revision: change.revision, at: change.createdAt, change: 'removed' as const, reason: one.reason })) ]) };
      });
      return { schema: BROWSER_HOST_VERSION, conversationId: page.conversationId, revision: page.revision, items, cursor: page.cursor, hasMore: page.hasMore, total: page.total };
    },
    // The evidence routes' views, for a companion that publishes them: exactly the wire shapes the templated
    // read operations return (schema/browser-evidence-interface.json), so they carry no `schema` marker. A wire selector is checked here.
    async readEvidencePage(grant: unknown, ticketKey: string, { cursor = 0, limit = 50, anchor = null }: { cursor?: number; limit?: number; anchor?: string | null } = {}) {
      return bridge.evidenceRead(grant, ticketKey, { cursor, limit, anchor });
    },
    // Retained changes after a wire cursor (a revision), waiting up to waitMs for one.
    async readEvidenceChanges(grant: unknown, ticketKey: string, { cursor = 0, limit = 100, waitMs = 0, signal }: { cursor?: number; limit?: number; waitMs?: number; signal?: AbortSignal } = {}) {
      return bridge.evidenceChanges(grant, ticketKey, { cursor, limit, waitMs, signal });
    },
    async readEvidenceFragment(grant: unknown, ticketKey: string, itemId: string, { selector = null, contextBefore = 0, contextAfter = 0, limit = 100 }: { selector?: unknown; contextBefore?: number; contextAfter?: number; limit?: number } = {}) {
      return publicEvidenceFragment(bridge.evidenceFragment(grant, ticketKey, itemId, fromWireSelector(selector), contextBefore, contextAfter, limit));
    },
    // The retained bytes of a source named by a fragment's download identity.
    async downloadEvidence(grant: unknown, ticketKey: string, sourceId: string) {
      const one = bridge.evidenceDownload(grant, ticketKey, sourceId);
      return { schema: BROWSER_HOST_VERSION, sourceId, filename: one.filename, mediaType: one.mediaType, bytes: one.bytes.length, sha256: one.sha256, content: one.bytes };
    },
    // Counts for [from, to) over the named tickets; only `answer` messages are answers.
    async readPeriodSummary(grant: unknown, ticketKeys: string[], { from, to }: { from: string; to: string }) {
      const records = ticketKeys.flatMap((key) => bridge.readHistory(grant, key).records);
      return summarize(records, from, to, ticketKeys);
    }
  };
}
export type BrowserHost = ReturnType<typeof createBrowserHost>;
