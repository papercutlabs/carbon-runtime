// Teachings: what a client taught their agent, and what the agent refused as a
// change for the people who build it.
//
// One JSON record per thing taught, under the agent's own store:
//
//   teachings/<id>.json   carbon.teaching.v1, mode 0600 under the 0700 store
//
// There is no second directory and no index file. The list is the directory,
// read by listing it, which is at most the declaration's teaching.max_active
// small files. The writes go through stream/store.mjs's own temp-fsync-rename
// path and its resolve-under-store refusal, so a teaching record is written by
// exactly the rule every other store write is written by.
//
// Three things this library refuses to be talked out of.
//
// 1. A record about a message refers to a message this store holds. A
//    source_message_id that is not an inbound capture here is refused before
//    anything is written. It is the one refusal with no other detector: an
//    instruction nobody actually gave looks exactly like an instruction the
//    client gave, once it is on disk.
// 2. `taught_by` is copied from that capture and is never an argument. A caller
//    cannot attribute an instruction to someone who did not send it.
// 3. Nothing here takes a record away. `forget` is a status change; a revoked
//    instruction keeps its bytes and gains the message that revoked it. There
//    is no expiry, no age-out and no sweep, here or anywhere below stream/.
//
// Every function reports all its faults at once, in the launcher's fault shape,
// by throwing one StreamFault.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault } from './faults.mjs';
import { validate } from './validate.mjs';
import { componentFaults } from './encode.mjs';
import { StreamFault, writeAtomic } from './store.mjs';

const SCHEMA = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'schema', 'carbon.teaching.v1.json'), 'utf8'));

const DIR = 'teachings';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const KINDS = ['instruction', 'change-request'];
const STATUSES = { instruction: ['active', 'forgotten'], 'change-request': ['open', 'closed'] };
const QUESTIONS = [1, 2, 3, 4, 'size'];

// teach-<utc compact>-<first 8 of the sha256 of source_message_id>.
export function teachingId(source_message_id, at) {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha256').update(source_message_id, 'utf8').digest('hex').slice(0, 8);
  return `teach-${stamp}-${digest}`;
}

export function teachingsDir(store) {
  return store.under(DIR);
}

function teachingFile(store, id) {
  return store.under(DIR, `${id}.json`);
}

function ensureDir(store) {
  const dir = teachingsDir(store);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

// Every record on disk, whole, with the files that could not be read named
// rather than skipped. A record is carried as it was written: a field this
// version does not know about is a field a newer or an older writer added, and
// dropping it on the way through would lose it on the next write.
export function readTeachings(store) {
  const dir = teachingsDir(store);
  const records = [];
  const unreadable = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { records, unreadable };
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      unreadable.push(fault('TEACHING_UNREADABLE', store.relative(file),
        `this file is in the teachings directory and is not a record that can be read: ${(error.message ?? String(error)).split('\n')[0]}`,
        'read the file by hand and restore it from the message it cites; the other records are returned regardless'));
      continue;
    }
    if (record?.id !== name.slice(0, -'.json'.length)) {
      unreadable.push(fault('TEACHING_MISPLACED', store.relative(file),
        `the record names the id ${JSON.stringify(record?.id)}, which derives a different file name`,
        'the record has been moved or renamed; restore it to the path its own id derives'));
      continue;
    }
    records.push(record);
  }
  return { records, unreadable };
}

// The four groups a reader outside the box prints, oldest first, and the files
// that could not be read. A caller that wants the records themselves reads `records`.
export function listTeachings(store) {
  const { records, unreadable } = readTeachings(store);
  const byTime = (a, b) => String(a.taught_at).localeCompare(String(b.taught_at)) || String(a.id).localeCompare(String(b.id));
  const of = (kind, status) => records.filter((r) => r.kind === kind && r.status === status).sort(byTime);
  return {
    records: [...records].sort(byTime),
    active: of('instruction', 'active'),
    forgotten: of('instruction', 'forgotten'),
    open: of('change-request', 'open'),
    closed: of('change-request', 'closed'),
    unreadable
  };
}

// The capture this record is about. It must be an inbound record of this store,
// in the conversation the caller named, and it is where taught_by comes from.
function citedCapture(store, conversation_id, source_message_id) {
  const faults = [
    ...componentFaults('conversation_id', conversation_id),
    ...componentFaults('source_message_id', source_message_id)
  ];
  if (faults.length > 0) return { faults, capture: null };
  let held = [];
  try {
    held = store.recordsIn(conversation_id);
  } catch (error) {
    if (!(error instanceof StreamFault)) throw error;
    return { faults: error.faults, capture: null };
  }
  const captures = held
    .filter((r) => r.message_id === source_message_id && r.direction === 'inbound')
    .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
  if (captures.length === 0) {
    return {
      capture: null,
      faults: [fault('TEACHING_SOURCE_NOT_A_CAPTURE', source_message_id,
        `no inbound capture in this agent's own store on conversation ${JSON.stringify(conversation_id)} has this message_id, so there is no message that taught this and nothing to copy the teacher from`,
        'cite the message_id of the inbound record the client taught this in; a teaching whose source is not in the store is not written')]
    };
  }
  return { capture: captures[0], faults: [] };
}

function textFaults(text, max_chars) {
  const faults = [];
  if (typeof max_chars !== 'number' || !Number.isInteger(max_chars) || max_chars < 1) {
    faults.push(fault('TEACHING_MAX_CHARS_UNGIVEN', 'max_chars',
      'the length cap is the declaration\'s teaching.max_chars and is never guessed here',
      'pass max_chars from the agent\'s declaration'));
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    faults.push(fault('TEACHING_TEXT_EMPTY', 'text',
      'a teaching record with no text says nothing about what the agent will now do',
      'pass the instruction in plain words'));
  } else if (Number.isInteger(max_chars) && text.length > max_chars) {
    faults.push(fault('TEACHING_TEXT_TOO_LONG', 'text',
      `this text is ${text.length} characters and the cap this agent's declaration sets is ${max_chars}`,
      `say it in ${max_chars} characters or fewer; an instruction that does not fit is raised as a change request rather than remembered, and the cap itself moves only by a change to this agent's declaration`));
  }
  return faults;
}

// A record is written in the order the schema declares its fields, with anything
// the schema does not name after them. The order is nobody's convenience but the
// reader's: these files are read by a person looking at a client's own box, and
// a record whose fields land in the order the caller happened to build them in
// reads differently every time.
function inSchemaOrder(record) {
  const declared = Object.keys(SCHEMA.properties);
  const ordered = {};
  for (const key of declared) if (key in record) ordered[key] = record[key];
  for (const key of Object.keys(record)) if (!declared.includes(key)) ordered[key] = record[key];
  return ordered;
}

// The one door onto disk. It validates against the schema, refuses a kind and a
// status that do not go together, writes by the store's own temp-fsync-rename
// path, and reads the file back before returning: a write nobody read back is a
// claim, not a record.
export function writeTeaching(store, record) {
  const faults = [];
  if (!KINDS.includes(record?.kind)) {
    faults.push(fault('TEACHING_KIND_UNKNOWN', String(record?.kind),
      `a teaching record is one of ${KINDS.join(' or ')}, and this is neither`,
      `write kind as ${KINDS.join(' or ')}; there is no second schema for a change request`));
  } else if (!STATUSES[record.kind].includes(record?.status)) {
    faults.push(fault('TEACHING_STATUS_NOT_FOR_KIND', String(record?.status),
      `a record of kind ${record.kind} is ${STATUSES[record.kind].join(' or ')}, and this one says ${JSON.stringify(record?.status)}`,
      `write status as ${STATUSES[record.kind].join(' or ')}`));
  }
  faults.push(...validate(SCHEMA, record, '$', 'carbon.teaching.v1'));
  if (faults.length > 0) throw new StreamFault(faults);

  ensureDir(store);
  const file = teachingFile(store, record.id);
  writeAtomic(file, JSON.stringify(inSchemaOrder(record), null, 2) + '\n', FILE_MODE);
  fs.chmodSync(file, FILE_MODE);
  const on_disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (on_disk.id !== record.id) {
    throw new StreamFault([fault('TEACHING_READBACK_DISAGREES', store.relative(file),
      `the file read back names ${JSON.stringify(on_disk.id)} and the record written named ${JSON.stringify(record.id)}`,
      'the write did not land; the store is the thing to look at before anything is taught again')]);
  }
  return { id: record.id, file, record: on_disk };
}

// Two records written in the same second, citing the same message, would derive
// one id. The format is fixed, so the way out is the next free second: the id
// stays readable, no record is overwritten, and taught_at keeps the real time.
function freeId(store, source_message_id, at) {
  let seconds = Date.parse(at);
  for (let tries = 0; tries < 120; tries++) {
    const id = teachingId(source_message_id, new Date(seconds).toISOString());
    if (!fs.existsSync(teachingFile(store, id))) return id;
    seconds += 1000;
  }
  throw new StreamFault([fault('TEACHING_ID_UNAVAILABLE', source_message_id,
    'every id this message derives in the next two minutes is already a record on disk',
    'read the teachings directory; something is writing records in a loop')]);
}

function base(store, { agent, text, conversation_id, source_message_id, capture, now, release_id }) {
  const record = {
    schema: 'carbon.teaching.v1',
    id: freeId(store, source_message_id, now),
    agent,
    text,
    conversation_id,
    source_message_id,
    taught_by: taughtBy(capture),
    taught_at: now
  };
  // The release the turn was taking, when whoever started the teaching server
  // knew it. It is written here and nowhere else, so a caller that knows no
  // release simply writes a record without one rather than inventing a value.
  if (typeof release_id === 'string' && release_id.length > 0) record.release_id = release_id;
  return record;
}

// Every record written under one release of one turn. It is what the release
// loop asks at the end of a turn in the management conversation: did this turn
// record anything at all, or did the agent only say it would. A record with no
// release_id was written by a server no release loop told, and belongs to no
// release here.
export function teachingsUnderRelease(store, release_id) {
  if (typeof release_id !== 'string' || release_id.length === 0) return [];
  return listTeachings(store).records.filter((r) => r.release_id === release_id);
}

// Copied from the capture, never from the caller. sender_name is written only
// when the capture carries one, because the schema names it and an empty string
// is not a name.
function taughtBy(capture) {
  const teacher = { sender_id: capture.sender_id, role: capture.role };
  if (typeof capture.sender_name === 'string' && capture.sender_name.length > 0) {
    teacher.sender_name = capture.sender_name;
  }
  return teacher;
}

function agentFaults(agent, capture) {
  if (typeof agent !== 'string' || agent.length === 0) {
    return [fault('TEACHING_AGENT_UNGIVEN', 'agent',
      'a teaching record says which agent was taught, as the declaration names it',
      'pass the agent id')];
  }
  if (capture && capture.agent !== agent) {
    return [fault('TEACHING_AGENT_MISMATCH', agent,
      `the cited capture belongs to ${JSON.stringify(capture.agent)} and this record says ${JSON.stringify(agent)}`,
      'teach the agent whose store this is')];
  }
  return [];
}

// Record a standing instruction. Returns { id, file, record, active }, where
// active is the count after the write.
//
// Two calls quoting the same source message and the same text are one thing
// taught once: the second returns the first record and writes nothing. A client
// repeating themselves, and a turn re-issued after a restart, are both that.
export function remember(store, { agent, text, conversation_id, source_message_id, max_active, max_chars, release_id = null, now = new Date().toISOString() } = {}) {
  const { capture, faults: sourceFaults } = citedCapture(store, conversation_id, source_message_id);
  const faults = [...sourceFaults, ...textFaults(text, max_chars), ...agentFaults(agent, capture)];

  const { active } = listTeachings(store);
  if (typeof max_active !== 'number' || !Number.isInteger(max_active) || max_active < 1) {
    faults.push(fault('TEACHING_MAX_ACTIVE_UNGIVEN', 'max_active',
      'the count cap is the declaration\'s teaching.max_active and is never guessed here',
      'pass max_active from the agent\'s declaration'));
  }

  const same = active.find((r) => r.source_message_id === source_message_id && r.text === text);
  if (same && faults.length === 0) {
    return { id: same.id, file: teachingFile(store, same.id), record: same, active: active.length, already: true };
  }

  if (Number.isInteger(max_active) && !same && active.length >= max_active) {
    faults.push(fault('TEACHING_AT_CAP', String(max_active),
      `this agent already holds ${active.length} active instructions and its declaration's cap is ${max_active}`,
      `forget one of the instructions it is already following, or raise this as a change request: a full list is a sign a workflow has been taught one sentence at a time, and the cap moves only by a change to this agent's declaration`));
  }
  if (faults.length > 0) throw new StreamFault(faults);

  const written = writeTeaching(store, {
    ...base(store, { agent, text, conversation_id, source_message_id, capture, now, release_id }),
    kind: 'instruction',
    status: 'active'
  });
  return { ...written, active: active.length + 1, already: false };
}

// Record an instruction the agent refused as a change for the people who build
// it, with which boundary question was answered yes. The same shape and the same directory:
// one record set, one writer, one reader.
export function raiseChange(store, { agent, text, conversation_id, source_message_id, failed_question, max_chars, release_id = null, now = new Date().toISOString() } = {}) {
  const { capture, faults: sourceFaults } = citedCapture(store, conversation_id, source_message_id);
  const faults = [...sourceFaults, ...textFaults(text, max_chars), ...agentFaults(agent, capture)];
  if (!QUESTIONS.includes(failed_question)) {
    faults.push(fault('TEACHING_QUESTION_UNKNOWN', String(failed_question),
      `a change request names which boundary question was answered yes, one of ${QUESTIONS.join(', ')}, and this names ${JSON.stringify(failed_question)}`,
      'pass 1 for a tool the agent does not have, 2 for a system, channel or person it does not reach, 3 for a permission it was not given, 4 for a change to what was agreed to be done for this client, or size for an instruction that does not fit'));
  }

  const { open } = listTeachings(store);
  const same = open.find((r) => r.source_message_id === source_message_id && r.text === text);
  if (same && faults.length === 0) {
    return { id: same.id, file: teachingFile(store, same.id), record: same, already: true };
  }
  if (faults.length > 0) throw new StreamFault(faults);

  return {
    ...writeTeaching(store, {
      ...base(store, { agent, text, conversation_id, source_message_id, capture, now, release_id }),
      kind: 'change-request',
      status: 'open',
      failed_question
    }),
    already: false
  };
}

// A client revoked an instruction. The record keeps its bytes and gains the
// revocation: the status becomes forgotten and the message the client revoked it
// in is written beside it, so the revocation is as traceable as the instruction.
// Returns { id, file, record, active }.
export function forget(store, { id, conversation_id, source_message_id, now = new Date().toISOString() } = {}) {
  // The revoking message is a capture of this store too: a revocation nobody
  // sent is the same failure as an instruction nobody gave.
  const { faults: sourceFaults } = citedCapture(store, conversation_id, source_message_id);
  const faults = [...sourceFaults];
  const { active, records } = listTeachings(store);
  const held = active.find((r) => r.id === id);
  if (!held) {
    const known = records.find((r) => r.id === id);
    faults.push(fault('TEACHING_NOT_ACTIVE', String(id),
      known
        ? `this agent holds that record as ${known.kind} ${known.status}, and only an active instruction is forgotten`
        : 'this agent holds no record with that id, so there is no instruction to stop following',
      'read the active list and name one of its ids'));
  }
  if (faults.length > 0) throw new StreamFault(faults);

  const written = writeTeaching(store, {
    ...held,
    status: 'forgotten',
    forgotten: { at: now, source_message_id }
  });
  return { ...written, active: active.length - 1 };
}
