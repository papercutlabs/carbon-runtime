// The fixture adapter. It has no channel: its items come from JSON files, so
// the conformance check has something to run that is not a network. It is the
// worked example of stream/adapter.md and it declares all three capabilities,
// so `carbon-stream check --adapter` against it runs all twenty-three cases.

import crypto from 'node:crypto';

export const capabilities = ['inbound', 'outbound', 'import'];

const SOURCE = 'email';
const CHUNK = 40;

function conversationId(context, item) {
  return `${context.account}:${item.conversation}`;
}

function messageId(context, item) {
  return `${conversationId(context, item)}:${item.id}`;
}

function kindOf(item) {
  return (item.revision ?? 0) === 0 ? 'message' : 'revision';
}

// 1. list what is pending past the cursors
export function listPending(context) {
  return (context.items ?? []).filter((item) => {
    const cursors = context.store.cursors(conversationId(context, item));
    const at = cursors[kindOf(item)];
    return at === null || String(item.position) > at;
  });
}

// 2. consume one item, after the runtime accepted it
export function consume(context, item) {
  context.store.advanceCursor(conversationId(context, item), kindOf(item), item.position);
}

// 3. turn a batch into the payload
export function payload(context, items) {
  const entries = [];
  const parked = [];
  for (const item of items) {
    const cursor = { kind: kindOf(item), position: item.position };
    const raw = item.raw ?? JSON.stringify(item);
    const base = {
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
export function matchesDelivery(context, item, delivery) {
  return crypto.createHash('sha256').update(item.text ?? '', 'utf8').digest('hex') === delivery.text_sha256;
}

// 5. send
export function send(context, record) {
  const chunks = [];
  for (let i = 0; i < record.body.length; i += CHUNK) chunks.push(record.body.slice(i, i + CHUNK));
  if (chunks.length === 0) chunks.push('');
  return {
    status: 'sent',
    chunk_ids: chunks.map((chunk, i) => `${record.delivery.request_id}-chunk-${i}-${crypto.createHash('sha256').update(chunk).digest('hex').slice(0, 8)}`)
  };
}
