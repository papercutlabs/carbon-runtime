// The outbound half of a ledger mapping: the names of the places an agent's own
// sends were recorded.
//
// A client's ledger is what the agent saw. What the agent said is somewhere
// else, and usually in more than one place at once: a capture file the channel
// bridge appended, an audit directory the send authority appended, a table the
// harness wrote its turns into. None of them is the other's copy — one has the
// platform's message id, one has the text the model produced, one has whether
// the send was permitted and whether it left — so the import reads all three and
// joins them.
//
// This module is the half that knows a client's names. Like `ledger-mapping.mjs`
// it reads them out of one JSON file and refuses the file whole before a line is
// read, and every name it accepts is a plain identifier or a dotted path of
// plain identifiers, so a mapping cannot carry a second statement or a path
// escape into the client's box.
//
// ---- the outbound section of the mapping file ------------------------------
//
// {
//   "outbound": {
//     "events": {                     a JSON-lines file the channel appended
//       "record": "normalized",       optional: the object in each line that
//                                     holds the message; omitted means the line
//       "select": { "fromMe": true }, optional: only records whose paths match
//       "timestamp": "epoch_seconds",
//       "media_refs": "json_array",
//       "fields": {
//         "platform_message_id": "messageId",   required
//         "chat_key": "chatId",                 required
//         "timestamp": "timestamp",             required
//         "chat_name": "chatName",
//         "sender_id": "senderId",
//         "sender_name": "senderName",
//         "body": "body",
//         "message_kind": "mediaType",
//         "has_media": "hasMedia",
//         "media_refs": "mediaUrls",
//         "reply_to": "quotedMessageId",
//         "answers_refs": null,
//         "status": null
//       },
//       "carry": ["botIds"]           kept whole under adapter_fields
//     },
//     "audit": { ... the same shape, read over every .jsonl in a directory },
//     "turns": {                      a SQLite table, read as one SELECT
//       "timestamp": "epoch_seconds",
//       "answers_refs": "json_array",
//       "sql": "SELECT ... AS platform_message_id, ... AS chat_key,
//               ... AS timestamp, ... AS body, ... AS answers_refs FROM ..."
//     },
//     "link": { "tolerance_seconds": 180 }
//   }
// }
//
// A turns query names its own output columns and they are read by name:
// `platform_message_id`, `chat_key`, `timestamp`, `body`, `answers_refs`,
// `sender_id`, `sender_name`, `reply_to`, `status`. Every other column it
// selects is carried whole, because a mapping that selects something had a
// reason and this is not the place to decide it was wrong.

import { fault } from '../stream/faults.mjs';
import { describeMedia, isRead, mediaRefsOf, toIso } from './ledger-mapping.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMESTAMP_FORMATS = ['epoch_seconds', 'epoch_millis', 'iso8601'];
const REQUIRED_FIELDS = ['platform_message_id', 'chat_key', 'timestamp'];

// The names a turns query is read by. Anything else it selects is carried.
const TURN_FIELDS = ['platform_message_id', 'chat_key', 'timestamp', 'body',
  'answers_refs', 'sender_id', 'sender_name', 'reply_to', 'status'];

const FILE_KINDS = ['events', 'audit'];

// ---- paths ------------------------------------------------------------------

// A path is dotted plain identifiers and nothing else: no index, no wildcard, no
// empty segment. That is what keeps a mapping from reaching out of the object it
// was handed.
function pathFaults(where, given) {
  if (typeof given !== 'string' || given.length === 0) {
    return [fault('OUTBOUND_PATH_UNUSABLE', `${where} -> ${String(given)}`,
      'a name here is a dotted path of plain identifiers, and nothing else is accepted',
      'name the field the line holds, for example normalized.messageId')];
  }
  const bad = given.split('.').some((part) => !IDENTIFIER.test(part));
  if (!bad) return [];
  return [fault('OUTBOUND_PATH_UNUSABLE', `${where} -> ${given}`,
    'a name here is a dotted path of plain identifiers, and nothing else is accepted',
    'name the field the line holds, for example normalized.messageId')];
}

export function valueAt(object, path) {
  if (path === null || path === undefined) return undefined;
  let at = object;
  for (const part of String(path).split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[part];
  }
  return at;
}

// ---- refusing the section ---------------------------------------------------

function fieldFaults(where, fields) {
  const faults = [];
  for (const name of REQUIRED_FIELDS) {
    const path = fields[name];
    if (typeof path === 'string' && path.length > 0) continue;
    faults.push(fault('OUTBOUND_FIELD_UNNAMED', `${where}.fields.${name}`,
      'this field has no default and is not guessed',
      `name the path that holds ${name}`));
  }
  for (const [name, path] of Object.entries(fields)) {
    if (path === null) continue;
    faults.push(...pathFaults(`${where}.fields.${name}`, path));
  }
  return faults;
}

function formatFaults(where, section) {
  const faults = [];
  const stamp = section.timestamp;
  if (stamp !== undefined && !TIMESTAMP_FORMATS.includes(stamp)) {
    faults.push(fault('FORMAT_UNKNOWN', `${where}.timestamp -> ${String(stamp)}`,
      `this is read as one of ${TIMESTAMP_FORMATS.join(', ')}`,
      'name the format the source writes'));
  }
  return faults;
}

function fileKindFaults(where, section) {
  const faults = [...formatFaults(where, section)];
  if (section.record !== undefined && section.record !== null) {
    faults.push(...pathFaults(`${where}.record`, section.record));
  }
  faults.push(...fieldFaults(where, section.fields ?? {}));
  for (const path of section.carry ?? []) faults.push(...pathFaults(`${where}.carry`, path));
  for (const path of Object.keys(section.select ?? {})) {
    faults.push(...pathFaults(`${where}.select`, path));
  }
  return faults;
}

function turnFaults(where, section) {
  const faults = [...formatFaults(where, section)];
  if (typeof section.sql !== 'string' || !isRead(section.sql)) {
    faults.push(fault('OUTBOUND_TURNS_NOT_A_READ', where,
      'a turns query is a read: it starts with SELECT or WITH and nothing else is run',
      'write the query as a select naming platform_message_id, chat_key and timestamp'));
  }
  return faults;
}

export function outboundFaults(mapping, subject = 'the mapping') {
  const outbound = mapping?.outbound;
  if (outbound === null || outbound === undefined) {
    return [fault('MAPPING_WITHOUT_OUTBOUND', subject,
      'the mapping names no outbound sources, so there is nothing for this import to read',
      'give the mapping an outbound object with an events, audit or turns section')];
  }
  if (typeof outbound !== 'object' || Array.isArray(outbound)) {
    return [fault('MAPPING_WITHOUT_OUTBOUND', subject,
      'outbound is one JSON object naming the places the agent\'s own sends were recorded',
      'make outbound an object')];
  }
  const faults = [];
  for (const kind of FILE_KINDS) {
    if (outbound[kind] === undefined) continue;
    faults.push(...fileKindFaults(`outbound.${kind}`, outbound[kind] ?? {}));
  }
  if (outbound.turns !== undefined) faults.push(...turnFaults('outbound.turns', outbound.turns ?? {}));
  if (FILE_KINDS.every((kind) => outbound[kind] === undefined) && outbound.turns === undefined) {
    faults.push(fault('MAPPING_WITHOUT_OUTBOUND', subject,
      'outbound names none of events, audit or turns, so there is nothing to read',
      'name at least one outbound source'));
  }
  return faults;
}

// How far apart in time a turn or an audit row may be from the send it is joined
// to. It is the mapping's to say, because it is a fact about the client's own
// system, and three minutes is only what a mapping that says nothing gets.
export function toleranceMs(mapping) {
  const given = mapping?.outbound?.link?.tolerance_seconds;
  if (typeof given !== 'number' || !Number.isFinite(given) || given < 0) return 180_000;
  return Math.round(given * 1000);
}

// ---- a line or a row becomes an item ----------------------------------------

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

function text(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function orNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return text(value);
}

// A timestamp a client's system wrote as a two-word integer, which is what a
// protobuf long looks like once it has been through JSON. It is read as the
// number it is, so a mapping does not have to describe the encoding of a library
// the client happened to use.
export function epochOf(value) {
  if (value !== null && typeof value === 'object' && typeof value.low === 'number') {
    const high = typeof value.high === 'number' ? value.high : 0;
    return high * 4_294_967_296 + (value.low >>> 0);
  }
  return value;
}

export function selects(section, holder) {
  for (const [path, wanted] of Object.entries(section.select ?? {})) {
    const found = valueAt(holder, path);
    const allowed = Array.isArray(wanted) ? wanted : [wanted];
    if (!allowed.some((one) => one === found)) return false;
  }
  return true;
}

function carried(section, holder) {
  const fields = {};
  for (const path of section.carry ?? []) {
    const value = valueAt(holder, path);
    if (value === null || value === undefined || value === '') continue;
    fields[String(path).split('.').pop()] = value;
  }
  return fields;
}

function refsOf(value, format) {
  if (Array.isArray(value)) return value.map((one) => text(one)).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return mediaRefsOf(value, format ?? 'json_array', null);
}

// The item every outbound source is read into, whatever it was written as. The
// `kind` is which source it came from, and it is the only thing downstream needs
// to know about the client's own shapes.
export function itemFrom(kind, section, holder, media = null) {
  const at = (name) => valueAt(holder, (section.fields ?? {})[name]);
  const refs = refsOf(at('media_refs'), section.media_refs);
  return {
    kind,
    message_id: text(at('platform_message_id')),
    chat_jid: text(at('chat_key')),
    chat_name: text(at('chat_name')),
    sender_jid: orNull(at('sender_id')),
    sender_name: orNull(at('sender_name')),
    timestamp: toIso(epochOf(at('timestamp')), section.timestamp ?? 'epoch_seconds'),
    text: text(at('body')),
    message_type: text(at('message_kind')),
    reply_to: orNull(at('reply_to')),
    status: orNull(at('status')),
    answers_refs: refsOf(at('answers_refs'), section.answers_refs),
    has_media: truthy(at('has_media')) || refs.length > 0,
    media: refs.map((ref) => describeMedia(ref, media)),
    fields: carried(section, holder)
  };
}

// A turns query names its own output columns, so the row is already under the
// names this reads. It is turned into the same item by the same rule, with the
// columns nothing named carried whole.
export function turnItem(section, row) {
  const holder = {};
  const fields = {};
  const extra = {};
  for (const [name, value] of Object.entries(row)) {
    if (TURN_FIELDS.includes(name)) {
      holder[name] = value;
      fields[name] = name;
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    extra[name] = value;
  }
  const item = itemFrom('turn', { ...section, fields }, holder);
  item.fields = extra;
  return item;
}

// The column names a turns query must have produced. It is read off the first
// row, so a query that named none of them is refused before a record is written
// rather than after a client's history is half in the store.
export function turnRowFaults(row) {
  const faults = [];
  for (const name of REQUIRED_FIELDS) {
    if (row !== null && row !== undefined && row[name] !== undefined) continue;
    faults.push(fault('OUTBOUND_TURN_COLUMN_UNNAMED', `outbound.turns.sql -> ${name}`,
      'the query returns no column under this name, and it is not guessed',
      `alias a column to ${name} in the query`));
  }
  return faults;
}
