// The mapping: the half of a ledger import that knows a client.
//
// A ledger is somebody else's table under somebody else's column names, so the
// names are not in the code. They are in one JSON file the caller passes, and
// this module is what reads it: what a mapping must say, how a mapping becomes
// one SQL statement, and how a row of that statement becomes the item the
// adapter writes. The mapping file's shape is documented at the top of
// `carbon-ledger-sqlite.mjs`.
//
// Two rules hold everything here together. A mapping is refused whole, before a
// row is read, because a converter that half-reads a client's history and then
// stops has written a store nobody can reason about. And every name a mapping
// gives is a plain SQL identifier or it is refused, so a mapping cannot carry a
// second statement into a client's database on the back of a column name.

import fs from 'node:fs';
import path from 'node:path';
import { fault } from '../stream/faults.mjs';
import { StreamFault } from '../stream/store.mjs';

const TIMESTAMP_FORMATS = ['epoch_seconds', 'epoch_millis', 'iso8601'];
const MEDIA_REF_FORMATS = ['json_array', 'comma', 'single', 'none'];

const REQUIRED_COLUMNS = ['platform_message_id', 'chat_key', 'timestamp'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF_KEYS = ['path', 'file', 'ref', 'media_ref', 'url', 'sha256'];

// ---- refusing a mapping -----------------------------------------------------

function identifierFault(code, subject, what) {
  return fault(code, subject,
    'a name is a plain SQL identifier here, and nothing else is accepted',
    `name ${what}`);
}

function formatFault(subject, given, allowed) {
  if (given === undefined) return null;
  if (allowed.includes(given)) return null;
  return fault('FORMAT_UNKNOWN', `${subject} -> ${String(given)}`,
    `this is read as one of ${allowed.join(', ')}`,
    'name the format the ledger writes');
}

function columnFaults(columns) {
  const faults = [];
  for (const name of REQUIRED_COLUMNS) {
    const column = columns[name];
    if (typeof column === 'string' && column.length > 0) continue;
    faults.push(fault('COLUMN_UNNAMED', name,
      'this column has no default and is not guessed',
      `name the ledger column that holds ${name} under messages.columns`));
  }
  for (const [name, column] of Object.entries(columns)) {
    if (column === null) continue;
    if (typeof column === 'string' && IDENTIFIER.test(column)) continue;
    faults.push(identifierFault('COLUMN_NAME_UNUSABLE', `${name} -> ${String(column)}`,
      'a column of the ledger table'));
  }
  return faults;
}

function messagesFaults(messages) {
  const faults = [];
  if (typeof messages.table !== 'string' || !IDENTIFIER.test(messages.table)) {
    faults.push(identifierFault('TABLE_NAME_UNUSABLE', String(messages.table),
      'the ledger table, for example message_ledger'));
  }
  faults.push(...columnFaults(messages.columns ?? {}));
  for (const column of messages.carry ?? []) {
    if (typeof column === 'string' && IDENTIFIER.test(column)) continue;
    faults.push(identifierFault('CARRIED_COLUMN_UNUSABLE', String(column),
      'a column of the ledger table'));
  }
  const formats = [
    formatFault('messages.timestamp', messages.timestamp, TIMESTAMP_FORMATS),
    formatFault('messages.media_refs', messages.media_refs, MEDIA_REF_FORMATS)
  ];
  faults.push(...formats.filter(Boolean));
  return faults;
}

// A correction query is one read. Nothing here runs a statement a mapping wrote
// unless it starts with SELECT or WITH and carries no second statement, so a
// mapping file is never a way to write to the system it is reading.
export function isRead(sql) {
  const text = String(sql).replace(/^\s*(--[^\n]*\n|\s)*/, '');
  return /^(select|with)\b/i.test(text) && !text.includes(';');
}

function correctionFaults(corrections) {
  if (!Array.isArray(corrections)) {
    return [fault('CORRECTIONS_NOT_A_LIST', 'corrections',
      'corrections is a list of queries, each with a kind and a select',
      'make corrections a list, or leave it out')];
  }
  const faults = [];
  corrections.forEach((query, at) => {
    const where = `corrections[${at}]`;
    if (typeof query?.kind !== 'string' || query.kind.length === 0) {
      faults.push(fault('CORRECTION_KIND_UNNAMED', where,
        'a correction query says what kind of correction it reads, and it is not guessed',
        'give the query a kind, for example reviewer_edit'));
    }
    if (typeof query?.sql !== 'string' || !isRead(query.sql)) {
      faults.push(fault('CORRECTION_NOT_A_READ', where,
        'a correction query is a read: it starts with SELECT or WITH and nothing else is run',
        'write the query as a select'));
    }
    const format = formatFault(`${where}.timestamp`, query?.timestamp, TIMESTAMP_FORMATS);
    if (format) faults.push(format);
  });
  return faults;
}

export function mappingFaults(mapping, subject = 'the mapping') {
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return [fault('MAPPING_NOT_AN_OBJECT', subject,
      'a mapping is one JSON object naming the ledger\'s tables and columns',
      'see the mapping file shape in import/carbon-ledger-sqlite.mjs')];
  }
  const messages = mapping.messages;
  if (messages === null || typeof messages !== 'object' || Array.isArray(messages)) {
    return [fault('MAPPING_WITHOUT_MESSAGES', subject,
      'the mapping names no messages table, so there is nothing to import',
      'give the mapping a messages object with a table and columns')];
  }
  return [...messagesFaults(messages), ...correctionFaults(mapping.corrections ?? [])];
}

export function readMapping(file) {
  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new StreamFault([fault('MAPPING_UNREADABLE', file,
      (error.message ?? String(error)).split('\n')[0],
      'pass the path of a JSON mapping file')]);
  }
  const faults = mappingFaults(mapping, file);
  if (faults.length > 0) throw new StreamFault(faults);
  return mapping;
}

// ---- the query --------------------------------------------------------------

function clause(keyword, given) {
  if (typeof given !== 'string' || given.length === 0) return '';
  return ` ${keyword} ${given}`;
}

// One statement, built out of names the mapping already had to pass. Every
// column is aliased to the name this import reads, so nothing past this line
// ever sees a client's column name again.
export function messageQuery(mapping) {
  const messages = mapping.messages;
  const selected = [];
  for (const [name, column] of Object.entries(messages.columns ?? {})) {
    if (typeof column !== 'string' || column.length === 0) continue;
    selected.push(`"${column}" AS "${name}"`);
  }
  for (const column of messages.carry ?? []) selected.push(`"${column}" AS "carry__${column}"`);
  return `SELECT ${selected.join(', ')} FROM "${messages.table}"`
    + clause('WHERE', messages.where) + clause('ORDER BY', messages.order_by);
}

export function countQuery(mapping) {
  return `SELECT count(*) AS n FROM "${mapping.messages.table}"`
    + clause('WHERE', mapping.messages.where);
}

// ---- what a column holds ----------------------------------------------------

export function toIso(value, format = 'epoch_seconds') {
  if (value === null || value === undefined || value === '') return null;
  if (format === 'iso8601') {
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const at = new Date(format === 'epoch_millis' ? number : number * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// A media reference is whatever the ledger wrote: a path, or an object with the
// path under a name of its own. The mapping may say which name; otherwise the
// usual ones are tried, and a reference nothing recognises is carried as the
// text it is rather than dropped.
export function refString(ref, key = null) {
  if (typeof ref === 'string') return ref;
  if (ref === null || typeof ref !== 'object') return String(ref ?? '');
  for (const name of [key, ...REF_KEYS]) {
    if (name === null) continue;
    if (typeof ref[name] === 'string' && ref[name].length > 0) return ref[name];
  }
  return '';
}

export function mediaRefsOf(value, format = 'json_array', key = null) {
  if (format === 'none' || value === null || value === undefined || value === '') return [];
  if (format === 'single') return [String(value)];
  if (format === 'comma') return String(value).split(',').map((r) => r.trim()).filter(Boolean);
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return [String(value)];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((one) => refString(one, key)).filter((ref) => ref.length > 0);
}

// An attachment is referenced, never copied. The ledger recorded where the file
// was; whether that file is there now is a fact about the box, so it is recorded
// as a fact, and left unknown when nothing said where to look.
export function describeMedia(ref, media) {
  const root = typeof media?.root === 'string' && media.root.length > 0 ? media.root : null;
  if (root === null) return { ref, present: null };
  const file = path.isAbsolute(ref) ? ref : path.join(root, ref);
  return { ref, path: file, present: fs.existsSync(file) };
}

// ---- a row becomes an item --------------------------------------------------

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

function carried(row) {
  const fields = {};
  for (const [name, value] of Object.entries(row)) {
    if (!name.startsWith('carry__')) continue;
    if (value === null || value === undefined || value === '') continue;
    fields[name.slice('carry__'.length)] = value;
  }
  return fields;
}

// The row the query returned becomes the item the adapter writes. `chat_jid` is
// the name the WhatsApp chat-key rule already reads, so a ledger keyed by phone
// number joins the conversations a live adapter keyed by linked id through the
// same map, and that rule is not written twice.
export function normaliseRow(mapping, row, media = null) {
  const messages = mapping.messages;
  const refs = mediaRefsOf(row.media_refs, messages.media_refs ?? 'json_array',
    messages.media_ref_key ?? null);
  return {
    chat_jid: text(row.chat_key),
    chat_name: text(row.chat_name),
    message_id: text(row.platform_message_id),
    sender_jid: orNull(row.sender_id),
    sender_name: orNull(row.sender_name),
    from_me: truthy(row.from_me),
    timestamp: toIso(row.timestamp, messages.timestamp ?? 'epoch_seconds'),
    text: text(row.body),
    message_type: text(row.message_kind),
    reply_to: orNull(row.reply_to),
    has_media: truthy(row.has_media) || refs.length > 0,
    media: refs.map((ref) => describeMedia(ref, media ?? mapping.media ?? null)),
    fields: carried(row)
  };
}

// contact, operator or agent, decided by the sender the ledger recorded and the
// lists the mapping holds. A ledger that says only from_me still answers the
// question, because a message the account sent has a role of its own.
export function roleFor(mapping, item) {
  const roles = mapping.roles ?? {};
  const sender = item.sender_jid ?? null;
  if (sender !== null && (roles.agent_senders ?? []).includes(sender)) return 'agent';
  if (sender !== null && (roles.operator_senders ?? []).includes(sender)) return 'operator';
  if (item.from_me === true) return roles.from_me ?? 'agent';
  return roles.default ?? 'contact';
}
