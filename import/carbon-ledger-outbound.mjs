// The outbound import: what a client's agent itself said, out of the places the
// client's own system wrote it down.
//
// `carbon-ledger-sqlite.mjs` imports a client's ledger, and a ledger is usually
// only half a history: it is what arrived. What the agent sent is written
// somewhere else, and in more than one place, because the send passed through
// more than one component on its way out. This import reads those places, joins
// them into one send each (`outbound-link.mjs` holds that rule), and writes the
// same `carbon.message.v1` record into the same store, so a replay can put what
// the agent said beside what the client asked for and read the two together.
//
// Nothing here knows a client. The three places and the names inside them are
// read from the same mapping file the ledger import takes, in its `outbound`
// section, which `outbound-mapping.mjs` reads and refuses whole.
//
// What is written is one record per send, `historical: true`, `direction:
// outbound`, `source: import:ledger-outbound`, merged into the store by the
// platform's message id where there is one. A historical record releases no
// turn, so importing a year of an agent's sends wakes nothing up.
//
// ---- what a record says about how it was joined -----------------------------
//
// A send that the capture file recorded carries the platform's own message id
// and is identified by it. A turn or an audit row joined to it says so on the
// record, under `adapter_fields.link`, with the method, the distance in
// milliseconds, the tolerance and how many other marks were inside the window.
// A turn or an audit row that joined to nothing becomes a record of its own,
// keyed by the id its own row carries, and its link says `none` rather than
// letting a reader take a guessed join for an observed one.
//
// `adapter_fields.answers` names the records this send answered: the quoted
// message id when the capture carried one, the message ids the turn row carried
// otherwise, as record identities the miner can look up.

import crypto from 'node:crypto';
import { conversationKind } from '../adapters/whatsapp/jid.mjs';
import { chatKeyFor } from './carbon-capture-whatsapp.mjs';
import { lidMapFor } from './carbon-ledger-sqlite.mjs';
import { roleFor } from './ledger-mapping.mjs';
import { joinOutbound } from './outbound-link.mjs';

export const capabilities = ['import'];

export const SOURCE = 'import:ledger-outbound';

const QUOTED = 'the quoted message id the capture carries';
const CARRIED = 'the message ids the turn row carries';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---- 1. where an item landed -------------------------------------------------

// The same chat-key rule the ledger import uses, so a send lands in the
// conversation the client's arriving messages were already imported into and
// the two sides of a chat are one conversation.
export function locate(context, items) {
  const lidMap = lidMapFor(context);
  return items.map((item) => {
    const { key, note } = chatKeyFor(item, lidMap);
    return { ...item, chat_key: key, chat_key_note: note, conversation_id: `${context.account}:${key}` };
  });
}

// ---- 2. one joined send becomes one record ----------------------------------

function partsOf(send) {
  return {
    event: send.item.kind === 'event' ? send.item : null,
    turn: send.attached.turn ?? (send.item.kind === 'turn' ? send.item : null),
    audit: send.attached.audit ?? (send.item.kind === 'audit' ? send.item : null)
  };
}

// What went out, and where it was read. The capture is preferred because it is
// the text the channel actually carried; the turn's text is what the model
// produced, which is the same thing only when nothing between them changed it.
function bodyOf(parts) {
  if (parts.event !== null && parts.event.text.length > 0) return { body: parts.event.text, from: 'the capture' };
  if (parts.turn !== null && parts.turn.text.length > 0) return { body: parts.turn.text, from: 'the turn' };
  return { body: '', from: 'nothing: no source recorded the text of this send' };
}

// The messages this send answered, as record identities. A quote is what the
// platform itself recorded; the ids a turn row carries are what the harness was
// handed. Both are ids somebody wrote down, neither is inferred.
function answersOf(send, parts) {
  const refs = [];
  if (parts.event !== null && parts.event.reply_to) refs.push(parts.event.reply_to);
  for (const ref of parts.turn?.answers_refs ?? []) if (!refs.includes(ref)) refs.push(ref);
  if (refs.length === 0) return { refs: [], ids: [], link: 'none: no source named a message this answered' };
  const link = parts.event !== null && parts.event.reply_to ? QUOTED : CARRIED;
  return { refs, ids: refs.map((ref) => `${send.item.conversation_id}:${ref}`), link };
}

function mediaFieldsOf(parts, fields) {
  const media = parts.event?.media ?? [];
  if (media.length > 0) fields.media = media;
  if (media.length > 0 && media.every((one) => one.present === false)) {
    fields.media_missing = 'the capture records media for this send and no file is at the path it recorded';
  }
  if (media.length === 0 && parts.event?.has_media === true) {
    fields.media_missing = 'the capture records media for this send and names no file for it';
  }
}

// What the turn adds to a send the capture already recorded: which turn it was,
// how it ended, and whether the text the model produced is the text that went
// out. The turn's own text is not written a second time; its digest says whether
// the two agree, which is the question a replay asks.
function turnFieldsOf(parts, body) {
  const turn = parts.turn;
  const fields = { id: turn.message_id, ...turn.fields };
  if (turn.status !== null) fields.status = turn.status;
  if (turn.text.length > 0) {
    fields.text_sha256 = sha256(turn.text);
    fields.text_is_what_went_out = sha256(body) === fields.text_sha256;
  }
  return fields;
}

function fieldsFor(context, send, parts, body, answers) {
  const fields = { ...(send.item.fields ?? {}) };
  const named = context.mapping?.ledger;
  if (typeof named === 'string' && named.length > 0) fields.ledger = named;
  if (send.item.chat_name) fields.chat_name = send.item.chat_name;
  if (parts.event?.message_type) fields.message_type = parts.event.message_type;
  if (send.item.chat_key_note) fields.chat_key_note = send.item.chat_key_note;
  fields.outbound_sources = ['event', 'turn', 'audit'].filter((kind) => parts[kind] !== null);
  fields.identified_by = send.item.kind === 'event'
    ? 'the platform message id the capture carries'
    : `the id the ${send.item.kind} row carries, because no capture of this send was found`;
  fields.body_read_from = body.from;
  fields.link = send.links;
  if (answers.refs.length > 0) {
    fields.answers = answers.ids;
    fields.answers_refs = answers.refs;
  }
  fields.answers_link = answers.link;
  if (parts.turn !== null) fields.turn = turnFieldsOf(parts, body.body);
  if (parts.audit !== null) {
    fields.send_audit = { id: parts.audit.message_id, ...parts.audit.fields };
    if (parts.audit.status !== null) fields.send_audit.status = parts.audit.status;
  }
  mediaFieldsOf(parts, fields);
  return fields;
}

export function recordFor(context, send) {
  const parts = partsOf(send);
  const body = bodyOf(parts);
  const answers = answersOf(send, parts);
  const at = send.item.timestamp ?? '';
  const record = {
    schema: 'carbon.message.v1',
    agent: context.agent,
    source: SOURCE,
    account: context.account,
    conversation_id: send.item.conversation_id,
    conversation_kind: conversationKind(send.item.chat_key),
    message_id: `${send.item.conversation_id}:${send.item.message_id}`,
    platform_message_id: String(send.item.message_id),
    revision: 0,
    // Every record this import writes went out. No delivery is written: what the
    // audit recorded is an outcome on somebody else's box, not a send this agent
    // made from here, and writing it as a delivery would claim a fence that
    // never existed.
    direction: 'outbound',
    role: roleFor(context.mapping ?? {}, { ...send.item, from_me: true }),
    sender_id: send.item.sender_jid ?? context.account,
    received_at: at,
    body: body.body,
    attachments: [],
    historical: true,
    disposition: 'captured'
  };
  if (at.length > 0) record.sent_at = at;
  if (send.item.sender_name) record.sender_name = send.item.sender_name;
  if (answers.ids.length === 1) record.reply_to = answers.ids[0];
  record.adapter_fields = fieldsFor(context, send, parts, body, answers);
  return record;
}

// ---- 3. the whole import -----------------------------------------------------

export function payload(context, items) {
  const { sends, counts } = joinOutbound(locate(context, items), context.tolerance_ms ?? 180_000);
  const entries = sends.map((send) => ({
    record: recordFor(context, send),
    raw: JSON.stringify({ item: send.item, attached: send.attached }),
    attachments: []
  }));
  return { entries, parked: [], counts };
}

export function writeBatch(context, items) {
  return writeEntries(context, payload(context, items).entries);
}

export function writeEntries(context, entries) {
  const written = [];
  for (const entry of entries) {
    // The raw payload is written the first time a send is seen and never again:
    // a second run is the same sources read again, not a second thing that
    // happened.
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

// Whether the record a send answers is in the store already. A reply link to a
// message nothing imported is still written, because the ledger it names is the
// client's and the message may arrive in a later import; the count of the ones
// that resolve today is what the import reports.
export function resolvedAnswers(store, record) {
  let resolved = 0;
  for (const id of record.adapter_fields?.answers ?? []) {
    let found = null;
    try {
      found = store.read(record.conversation_id, id, 0);
    } catch {
      // An identifier the store refuses is not a message it holds.
      found = null;
    }
    if (found !== null) resolved++;
  }
  return resolved;
}
