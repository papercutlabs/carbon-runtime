// The fixture adapter. It has no channel: its items come from JSON files, so
// the conformance check has something to run that is not a network. It is the
// worked example of stream/adapter.md and it declares all three capabilities,
// so `carbon-stream check --adapter` against it runs all twenty-three cases.

import crypto from 'node:crypto';
import type { Delivery, MessageRecord, Store } from '../../stream/store.ts';

type FixtureAttachment =
  | { bytes: string | Uint8Array | number[]; mime: string }
  | { file: string; sha256: string; mime: string; download_failed: true };
type FixtureItem = {
  id: string;
  conversation: string;
  position: string;
  at: string;
  revision?: number;
  conversation_kind?: MessageRecord['conversation_kind'];
  role?: MessageRecord['role'];
  sender?: string;
  sender_name?: string;
  sent_at?: string;
  text?: string;
  raw?: string;
  historical?: boolean;
  hold?: MessageRecord['hold'];
  extra?: MessageRecord['adapter_fields'];
  wrong_type?: Record<string, unknown>;
  malformed?: boolean;
  reason?: string;
  attachments?: FixtureAttachment[];
};
type FixtureContext = {
  store: Pick<Store, 'cursors' | 'advanceCursor'>;
  agent: string;
  account: string;
  items?: FixtureItem[];
};
type Cursor = { kind: 'message' | 'revision'; position: string };
// wrong_type deliberately overwrites declared fields with invalid values. The
// returned record is unvalidated until the store checks it, including when parked.
type FixtureRecord = { [Field in keyof MessageRecord]: unknown };
type FixtureEntry = {
  record: FixtureRecord;
  raw: string;
  cursor: Cursor;
  attachments: FixtureAttachment[];
};
type ParkedEntry = {
  record: FixtureRecord;
  raw: string;
  cursor: Cursor;
  reason: string;
};
type TypingCall = {
  conversation_id: string;
  state: 'composing' | 'paused';
};
type OutboundRecord = Pick<MessageRecord, 'body'> & {
  delivery: Pick<Delivery, 'request_id'>;
};

export const capabilities = ['inbound', 'outbound', 'import'];

const SOURCE = 'email';
const CHUNK = 40;

function conversationId(context: FixtureContext, item: FixtureItem): string {
  return `${context.account}:${item.conversation}`;
}

function messageId(context: FixtureContext, item: FixtureItem): string {
  return `${conversationId(context, item)}:${item.id}`;
}

function kindOf(item: FixtureItem): Cursor['kind'] {
  return (item.revision ?? 0) === 0 ? 'message' : 'revision';
}

// 1. list what is pending past the cursors
export function listPending(context: FixtureContext): FixtureItem[] {
  return (context.items ?? []).filter((item) => {
    const cursors = context.store.cursors(conversationId(context, item));
    const at = cursors[kindOf(item)];
    return at === null || String(item.position) > at;
  });
}

// 2. consume one item, after the runtime accepted it
export function consume(context: FixtureContext, item: FixtureItem): void {
  context.store.advanceCursor(conversationId(context, item), kindOf(item), item.position);
}

// 3. turn a batch into the payload
export function payload(context: FixtureContext, items: FixtureItem[]): { entries: FixtureEntry[]; parked: ParkedEntry[] } {
  const entries: FixtureEntry[] = [];
  const parked: ParkedEntry[] = [];
  for (const item of items) {
    const cursor = { kind: kindOf(item), position: item.position };
    const raw = item.raw ?? JSON.stringify(item);
    const base: MessageRecord = {
      schema: 'carbon.message.v1',
      agent: context.agent,
      source: item.historical === true ? 'import:carbon-capture' : SOURCE,
      account: context.account,
      conversation_id: conversationId(context, item),
      conversation_kind: item.conversation_kind ?? 'direct',
      message_id: messageId(context, item),
      platform_message_id: item.id,
      revision: item.revision ?? 0,
      direction: 'inbound',
      role: item.role ?? 'contact',
      sender_id: item.sender ?? 'unknown',
      received_at: item.at,
      body: item.text ?? '',
      attachments: [],
      historical: item.historical === true,
      disposition: 'captured'
    };
    if (item.sender_name !== undefined) base.sender_name = item.sender_name;
    if (item.sent_at !== undefined) base.sent_at = item.sent_at;
    if (item.hold !== undefined) base.hold = item.hold;
    if (item.extra !== undefined) base.adapter_fields = item.extra;
    if (item.wrong_type !== undefined) Object.assign(base, item.wrong_type);

    if (item.malformed === true) {
      parked.push({ record: { ...base, body: '' }, raw, cursor, reason: item.reason ?? 'the payload has no body this adapter understands' });
      continue;
    }
    entries.push({ record: base, raw, cursor, attachments: item.attachments ?? [] });
  }
  return { entries, parked };
}

// 4. say whether an item is the one a delivery record names
export function matchesDelivery(context: FixtureContext, item: FixtureItem, delivery: Pick<Delivery, 'text_sha256'>): boolean {
  return crypto.createHash('sha256').update(item.text ?? '', 'utf8').digest('hex') === delivery.text_sha256;
}

// 5. send
export function send(context: FixtureContext, record: OutboundRecord): { status: 'sent'; chunk_ids: string[] } {
  const chunks = [];
  for (let i = 0; i < record.body.length; i += CHUNK) chunks.push(record.body.slice(i, i + CHUNK));
  if (chunks.length === 0) chunks.push('');
  return {
    status: 'sent',
    chunk_ids: chunks.map((chunk, i) => `${record.delivery.request_id}-chunk-${i}-${crypto.createHash('sha256').update(chunk).digest('hex').slice(0, 8)}`)
  };
}

// The eighth operation, optional: the signal that a turn is running. This
// adapter has no channel to send it on, so it records what it was asked, which
// is what makes the release loop's start and stop provable with no provider in
// the test. The recorder and its reset are the same module-level-state-with-a-
// reset pattern the two live channel files use.
const typingCalls: TypingCall[] = [];

export function typing(context: FixtureContext, record: Pick<MessageRecord, 'conversation_id'>, state: TypingCall['state']): void {
  typingCalls.push({ conversation_id: record.conversation_id, state });
}

export function typingRecorded(): TypingCall[] {
  return typingCalls.map((call) => ({ ...call }));
}

export function forgetTyping(): void {
  typingCalls.length = 0;
}
