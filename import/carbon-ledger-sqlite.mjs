// The ledger import: a client's own message history out of a SQLite ledger.
//
// Some clients have no chat export. What they have is a running system that
// already wrote every message it saw into a SQLite table of its own — a ledger —
// beside the case records that system keeps. That table is the same history an
// export would be, in somebody else's column names, so this is the same import
// as `carbon-capture-whatsapp.mjs` with one part moved outside: the names.
//
// Nothing here knows a client. The table, the columns, the roles, the media
// references and the corrections are read from a mapping file the caller passes
// (`ledger-mapping.mjs` reads it), so this converts "a ledger-shaped SQLite
// database" and the client-specific half is one JSON file that never has to live
// in a public repository.
//
// What is written is what the other import writes: one `carbon.message.v1`
// record per ledger row, `historical: true`, `source: import:ledger-sqlite`,
// through the same store library, passing the same conformance cases. A
// historical record releases no turn, so importing a year of a client's chats
// wakes nothing up.
//
// Beside the records, the corrections the ledger holds are written one file per
// conversation by `ledger-corrections.mjs`, because a case miner reads them next.
//
// ---- The mapping file ------------------------------------------------------
//
// One JSON object. Every name in it is a name in the client's database, and
// nothing in it is guessed:
//
// {
//   "ledger": "a name for this ledger, carried onto every record",
//   "agent": "optional; --agent overrides it",
//   "account": "optional; --account overrides it",
//   "messages": {
//     "table": "message_ledger",
//     "where": "in_scope = 1",                 optional SQL predicate
//     "order_by": "ts ASC, message_id ASC",    optional
//     "timestamp": "epoch_seconds",            epoch_seconds | epoch_millis | iso8601
//     "media_refs": "json_array",              json_array | comma | single | none
//     "media_ref_key": "path",                 the key a media object holds its path under
//     "columns": {
//       "platform_message_id": "source_ref",   required
//       "chat_key": "chat_jid",                required
//       "chat_name": "chat_name",
//       "sender_id": "sender_id",
//       "sender_name": null,
//       "from_me": "from_me",
//       "timestamp": "ts",                     required
//       "body": "text",
//       "message_kind": "message_kind",
//       "has_media": "has_media",
//       "media_refs": "media_refs",
//       "reply_to": "reply_to_source_ref"
//     },
//     "carry": ["job_type", "zone"]            extra columns, kept in adapter_fields
//   },
//   "roles": {
//     "from_me": "agent",                      the role of a message the account sent
//     "agent_senders": ["..."],                senders that are the agent, whatever from_me says
//     "operator_senders": ["..."],             senders that are a person on the agent's side
//     "default": "contact"
//   },
//   "media": { "root": "/where/the/files/are" },  optional; decides present or absent
//   "corrections": [
//     {
//       "kind": "reviewer_edit",
//       "timestamp": "epoch_seconds",
//       "message_refs": "json_array",
//       "sql": "select ... from ..."           a read; refused unless it starts SELECT or WITH
//     }
//   ]
// }
//
// A corrections query names its own output columns, and these are read by name:
// `correction_id`, `at`, `actor`, `actor_kind`, `action`, `subject_kind`,
// `subject_id`, `before_json`, `after_json`, `note`, `message_refs` and
// `chat_key`. Every other column it selects is carried whole under `fields`.
//
// ---- The corrections sidecar -----------------------------------------------
//
// `corrections/<encoded conversation id>.json` under the store, one file per
// conversation, plus `corrections/unlinked.json` for corrections that name no
// message this import wrote:
//
// {
//   "schema": "carbon.ledger-corrections.v1",
//   "agent": "...", "account": "...", "ledger": "...",
//   "conversation_id": "...",              absent in unlinked.json
//   "corrections": [
//     {
//       "correction_id": "stable, from the source row",
//       "kind": "reviewer_edit",
//       "at": "2026-03-04T09:00:00.000Z",
//       "actor": "...", "actor_kind": "human",
//       "action": "case.operator.edited",
//       "subject": { "kind": "case", "id": "4812" },
//       "message_ids": ["<carbon message ids, in this conversation>"],
//       "message_refs": ["<the ledger's own ids, as the query returned them>"],
//       "before": {...}, "after": {...},    parsed when the column held JSON
//       "note": "...",
//       "fields": { every other column the query selected }
//     }
//   ]
// }
//
// The file carries no generation time, so a second run over an unchanged ledger
// writes the same bytes and the import is idempotent in the sidecars as well as
// in the records.

import { conversationKind } from '../adapters/whatsapp/jid.mjs';
import { readLidMap } from '../adapters/whatsapp/channel-state.mjs';
import { chatKeyFor } from './carbon-capture-whatsapp.mjs';
import { roleFor } from './ledger-mapping.mjs';

export const capabilities = ['import'];

export const SOURCE = 'import:ledger-sqlite';

// The map the live adapter keeps of every phone-form and linked-id-form pair it
// has seen, which is how a ledger keyed by phone number joins the conversations
// the live adapter already keyed by linked id.
export function lidMapFor(context) {
  if (context.lid_map) return context.lid_map;
  try {
    return readLidMap(context.store, context.account);
  } catch {
    return { phone_to_lid: {}, lid_to_phone: {} };
  }
}

// ---- 1. list what is pending -------------------------------------------------

// An import is a one-shot producer: it reads the rows the caller handed it and
// advances no cursor, because the cursors belong to the live adapter and moving
// them would make it skip messages it has not read.
export function listPending(context) {
  return context.items ?? [];
}

// ---- 2. consume --------------------------------------------------------------

export function consume() {}

// ---- 3. turn a batch into the payload ----------------------------------------

// Where an item landed, and under which key. A phone-keyed chat with no known
// linked-id form is stored under its phone key with a note saying so, because
// inventing a linked id would be worse than two conversations a person can
// still join later.
function placeOf(context, item, lidMap) {
  const { key, note } = chatKeyFor(item, lidMap);
  const conversation_id = `${context.account}:${key}`;
  return { key, note, conversation_id };
}

// A history import sets no hold. A hold stops the agent while a person is
// handling a conversation now; an operator's message from last spring is not
// that, and writing one would hold every conversation the client ever answered.
function fieldsFor(context, item, place) {
  const fields = { ...(item.fields ?? {}) };
  const named = context.mapping?.ledger;
  if (typeof named === 'string' && named.length > 0) fields.ledger = named;
  if (item.chat_name) fields.chat_name = item.chat_name;
  if (item.message_type) fields.message_type = item.message_type;
  if (place.note) fields.chat_key_note = place.note;
  if (item.reply_to) fields.reply_to_platform_id = item.reply_to;
  const media = item.media ?? [];
  if (media.length > 0) fields.media = media;
  if (media.length > 0 && media.every((one) => one.present === false)) {
    fields.media_missing = 'the ledger records media for this message and no file is at the path it recorded';
  }
  if (media.length === 0 && item.has_media === true) {
    fields.media_missing = 'the ledger records media for this message and names no file for it';
  }
  return fields;
}

function recordFor(context, item) {
  const place = placeOf(context, item, lidMapFor(context));
  const platform_message_id = String(item.message_id ?? '');
  const at = item.timestamp ?? '';
  const from_me = item.from_me === true;
  const record = {
    schema: 'carbon.message.v1',
    agent: context.agent,
    source: SOURCE,
    account: context.account,
    conversation_id: place.conversation_id,
    conversation_kind: conversationKind(place.key),
    message_id: `${place.conversation_id}:${platform_message_id}`,
    platform_message_id,
    revision: 0,
    // The ledger says who spoke and this says nothing more: a row the account
    // sent went out, every other row arrived. No delivery is written, because
    // nothing here was sent by this agent on this box and no send outcome
    // exists to record.
    direction: from_me ? 'outbound' : 'inbound',
    role: roleFor(context.mapping ?? {}, item),
    sender_id: item.sender_jid ?? (from_me ? context.account : place.key),
    received_at: at,
    body: item.text ?? '',
    attachments: [],
    historical: true,
    disposition: 'captured'
  };
  if (at.length > 0) record.sent_at = at;
  if (item.sender_name) record.sender_name = item.sender_name;
  // The link a reply carries. The ledger names the message that was replied to
  // by its own id, and a quoted reply is in the conversation it quotes, so the
  // link is written as the record identity the miner can look up, with the
  // ledger's own id kept beside it in the fields.
  if (item.reply_to) record.reply_to = `${place.conversation_id}:${item.reply_to}`;
  const fields = fieldsFor(context, item, place);
  if (Object.keys(fields).length > 0) record.adapter_fields = fields;
  return record;
}

export function payload(context, items) {
  const entries = items.map((item) => ({
    record: recordFor(context, item),
    raw: JSON.stringify(item),
    attachments: []
  }));
  return { entries, parked: [] };
}

// ---- 4. writing --------------------------------------------------------------

export function writeBatch(context, items) {
  const { entries } = payload(context, items);
  const written = [];
  for (const entry of entries) {
    // The raw payload is written the first time a row is seen and never again.
    // The store appends a raw line for every capture, which is right for a live
    // channel, where a second arrival is a second thing that happened; it is
    // wrong for an import, where a second run is the same ledger read again.
    const options = { disposition: entry.record.disposition };
    if (!alreadyCaptured(context.store, entry.record)) options.raw = entry.raw;
    written.push(context.store.capture(entry.record, options));
  }
  return written;
}

function alreadyCaptured(store, record) {
  try {
    return store.read(record.conversation_id, record.message_id, record.revision) !== null;
  } catch {
    // An identifier the store will refuse anyway; capture reports it properly.
    return false;
  }
}

// The index the corrections are keyed by: every ledger id this import wrote, and
// the conversation and record identity it became.
export function messageIndexOf(context, items) {
  const lidMap = lidMapFor(context);
  const index = new Map();
  for (const item of items) {
    const place = placeOf(context, item, lidMap);
    index.set(String(item.message_id), {
      conversation_id: place.conversation_id,
      message_id: `${place.conversation_id}:${item.message_id}`
    });
  }
  return index;
}
