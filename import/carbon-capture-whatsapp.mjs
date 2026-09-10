// The history import.
//
// A client's own WhatsApp history is another producer into the same store. It is
// not a second store, a second shape or a second code path: an imported message
// is a `carbon.message.v1` record like every other, written through `stream/`,
// passing the same conformance check, with two fields that say what it is —
// `historical: true` and `source: import:carbon-capture` — and one consequence
// that follows from them: it releases no turn. The client's past is context the
// agent can read. It is not five thousand messages arriving at once.
//
// The export is the one the capture extension produces: a flat array of rows in
// `messages.json`, with media beside it under `media/`. The map from a row to a
// record is a rename and nothing more. Where a row and a live capture claim the
// same identity, the live capture wins on every field and the import may only
// add an attachment, so running the import a second time changes no capture
// byte.
//
// This module is both the adapter the conformance check runs and the library
// `bin/carbon-import` uses, so what the check proves is what the command does.

import { conversationKind, isPhoneJid, normaliseJid } from '../adapters/whatsapp/jid.mjs';
import { readLidMap } from '../adapters/whatsapp/channel-state.mjs';

export const capabilities = ['import'];

export const SOURCE = 'import:carbon-capture';

// The export names a file by extension, so the extension is what says what the
// bytes are. Anything not named here is carried as an unnamed stream of bytes,
// which is honest: the store keeps the file and its sha256 either way.
const MIME_BY_EXTENSION = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['mp4', 'video/mp4'], ['3gp', 'video/3gpp'], ['mov', 'video/quicktime'],
  ['ogg', 'audio/ogg'], ['mp3', 'audio/mpeg'], ['opus', 'audio/opus'],
  ['pdf', 'application/pdf'], ['txt', 'text/plain']
]);

export function mimeOf(filename) {
  const extension = String(filename ?? '').split('.').pop()?.toLowerCase();
  return MIME_BY_EXTENSION.get(extension) ?? 'application/octet-stream';
}

// The chat this row belongs to, as the live adapter would key it.
//
// An export is keyed by whatever the browser showed, which is the phone form.
// The live adapter keys a chat by its linked-id form wherever the server offers
// one, and it writes every pair it has seen into a map under the store. So a
// phone-keyed chat is looked up in that map: found, the row joins the
// conversation the live adapter already writes; not found, the row is stored
// under the phone key with a note saying so, because inventing a linked id would
// be worse than two conversations a person can still join later.
export function chatKeyFor(row, lidMap) {
  const jid = normaliseJid(String(row.chat_jid ?? ''));
  if (!isPhoneJid(jid)) return { key: jid, note: null };
  const lid = lidMap?.phone_to_lid?.[jid] ?? null;
  if (lid) return { key: lid, note: null };
  return {
    key: jid,
    note: 'this chat is keyed by phone number: no linked-id form for it was known when the history was imported'
  };
}

function lidMapFor(context) {
  if (context.lid_map) return context.lid_map;
  try {
    return readLidMap(context.store, context.account);
  } catch {
    return { phone_to_lid: {}, lid_to_phone: {} };
  }
}

// ---- 1. list what is pending -------------------------------------------------

// An import is a one-shot producer: it reads an export the caller handed it, in
// the order the export holds. It advances no cursor, because the cursors belong
// to the live adapter and moving them would make the live adapter skip messages
// it has not read.
export function listPending(context) {
  return context.items ?? [];
}

// ---- 2. consume --------------------------------------------------------------

export function consume() {}

// ---- 3. turn a batch into the payload ----------------------------------------

export function payload(context, items) {
  const lidMap = lidMapFor(context);
  const entries = [];

  for (const row of items) {
    const { key: chat, note } = chatKeyFor(row, lidMap);
    const conversation_id = `${context.account}:${chat}`;
    const platform_message_id = String(row.message_id ?? '');
    const at = String(row.timestamp ?? '');
    const from_me = row.from_me === true;

    const record = {
      schema: 'carbon.message.v1',
      agent: context.agent,
      source: SOURCE,
      account: context.account,
      conversation_id,
      conversation_kind: conversationKind(chat),
      message_id: `${conversation_id}:${platform_message_id}`,
      platform_message_id,
      revision: 0,
      // Direction is what the record says about who spoke, and the export says
      // it plainly: a row the account sent is outbound, and every other row
      // arrived. There is no delivery on either, because nothing here was sent
      // by this agent and no send outcome exists to record.
      direction: from_me ? 'outbound' : 'inbound',
      role: from_me ? 'operator' : 'contact',
      sender_id: from_me ? context.account : normaliseJid(String(row.sender_jid ?? chat)),
      received_at: at,
      body: row.text ?? '',
      attachments: [],
      historical: true,
      disposition: 'captured'
    };
    if (at.length > 0) record.sent_at = at;
    if (typeof row.sender_name === 'string' && row.sender_name.length > 0) {
      record.sender_name = row.sender_name;
    }

    // A history import sets no hold. A hold stops the agent while a person is
    // handling a conversation now; an operator's message from last spring is not
    // that, and writing one would hold every conversation the client ever
    // answered.
    const fields = {};
    if (typeof row.chat_name === 'string' && row.chat_name.length > 0) fields.chat_name = row.chat_name;
    if (typeof row.message_type === 'string' && row.message_type.length > 0) fields.message_type = row.message_type;
    if (note) fields.chat_key_note = note;
    if (row.has_media === true && !Array.isArray(row.attachments)) {
      fields.media_missing = 'the export records media for this message and the archive carries none for it';
    }
    if (Object.keys(fields).length > 0) record.adapter_fields = fields;

    // No cursor: see listPending.
    entries.push({ record, raw: JSON.stringify(row), attachments: row.attachments ?? [] });
  }

  return { entries, parked: [] };
}

// ---- writing -----------------------------------------------------------------

// What `bin/carbon-import` does with a batch: the attachments first, so the
// record can name them, then the record. This is the same order the conformance
// check writes in, and the same store library, so an imported record is written
// exactly as a live one is.
export function writeBatch(context, rows) {
  const { entries } = payload(context, rows);
  const written = [];
  for (const entry of entries) {
    let record = entry.record;
    const attachments = [];
    for (const wanted of entry.attachments ?? []) {
      attachments.push(context.store.putAttachment(record, Buffer.from(wanted.bytes), wanted));
    }
    record = { ...record, attachments };

    // The raw payload is written the first time this row is seen and never
    // again. The store appends a raw line for every capture, which is right for
    // a live channel, where a second arrival of one message is a second thing
    // that happened; it is wrong for an import, where a second run is the same
    // export read again. Without this, running the import twice would leave
    // every raw payload written twice, and "a re-run changes no capture byte"
    // would be false.
    const options = { disposition: record.disposition };
    if (!alreadyCaptured(context.store, record)) options.raw = entry.raw;

    written.push(context.store.capture(record, options));
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
