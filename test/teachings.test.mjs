// What the teachings half of the store library does that the conformance cases
// do not name: the shape of the id, the mode the directory and the records are
// written with, the containment refusal, the teacher copied from the capture
// rather than taken from the caller, and every fault of one bad call reported
// together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StreamFault } from '../stream/store.mjs';
import {
  forget, listTeachings, raiseChange, readTeachings, remember, teachingId, teachingsDir, writeTeaching
} from '../stream/teachings.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const AGENT = 'agent-01';
const ACCOUNT = 'agent-01@examplecorp.test';
const CONVERSATION = `${ACCOUNT}:room-7`;
const SOURCE = `${CONVERSATION}:m-0001`;
const NOW = '2026-09-11T10:15:00.000Z';
const CAPS = { max_active: 40, max_chars: 400 };
const TEXT = 'A workbook arriving in this chat is not permission to change records.';

function inbound(overrides = {}) {
  const record = {
    schema: 'carbon.message.v1',
    agent: AGENT,
    source: 'email',
    account: ACCOUNT,
    conversation_id: CONVERSATION,
    conversation_kind: 'direct',
    message_id: SOURCE,
    platform_message_id: 'm-0001',
    revision: 0,
    direction: 'inbound',
    role: 'operator',
    sender_id: 'ada@examplecorp.test',
    sender_name: 'Ada',
    received_at: '2026-09-10T09:00:00.000Z',
    body: 'a workbook is not permission to change anything',
    attachments: [],
    historical: false,
    disposition: 'captured',
    ...overrides
  };
  // The schema declares sender_name as a string; a capture that carries none
  // carries no key at all, which is what an adapter with no display name writes.
  if (record.sender_name === undefined) delete record.sender_name;
  return record;
}

// A store with one inbound capture in it, which is the thing a teaching cites.
function taught(overrides = {}) {
  const store = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-teach-')), 'store'));
  store.capture(inbound(overrides));
  return store;
}

function call(overrides = {}) {
  return {
    agent: AGENT, text: TEXT, conversation_id: CONVERSATION, source_message_id: SOURCE, now: NOW,
    ...CAPS, ...overrides
  };
}

function faultCodes(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof StreamFault, `expected a StreamFault, got ${error}`);
    for (const f of error.faults) assert.deepEqual(Object.keys(f).sort(), ['code', 'fix', 'problem', 'subject']);
    return error.faults.map((f) => f.code);
  }
  throw new assert.AssertionError({ message: 'nothing was refused' });
}

test('a remembered instruction is one record at the id its source and its time derive', () => {
  const store = taught();
  const written = remember(store, call());
  assert.equal(written.id, teachingId(SOURCE, NOW));
  assert.match(written.id, /^teach-20260911T101500Z-[0-9a-f]{8}$/);
  assert.equal(written.file, path.join(teachingsDir(store), `${written.id}.json`));
  assert.equal(written.active, 1);
  assert.equal(written.record.schema, 'carbon.teaching.v1');
  assert.equal(written.record.agent, AGENT);
  assert.equal(written.record.text, TEXT);
  assert.equal(written.record.conversation_id, CONVERSATION);
  assert.equal(written.record.source_message_id, SOURCE);
  assert.equal(written.record.taught_at, NOW);
});

test('the store is 0700 and a teaching record is 0600, like everything else under it', () => {
  const store = taught();
  const written = remember(store, call());
  assert.equal(fs.statSync(teachingsDir(store)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(written.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(written.file).mode & 0o111, 0, 'a teaching record carries an execute bit');
});

// The one field the caller may not supply. A model that could pass taught_by
// could attribute an instruction to somebody who never sent one.
test('the teacher is copied from the cited capture and never taken from the caller', () => {
  const store = taught();
  const written = remember(store, {
    ...call(),
    taught_by: { sender_id: 'someone-else@examplecorp.test', role: 'operator' }
  });
  assert.deepEqual(written.record.taught_by, {
    sender_id: 'ada@examplecorp.test', role: 'operator', sender_name: 'Ada'
  });
});

test('a capture with no sender name writes no empty name', () => {
  const store = taught({ sender_name: undefined });
  const written = remember(store, call());
  assert.deepEqual(written.record.taught_by, { sender_id: 'ada@examplecorp.test', role: 'operator' });
});

// The store's own rule: a record about a message refers to a message the store
// holds. An outbound record is not a message anyone taught anything in.
test('only an inbound capture of this store teaches anything', () => {
  const store = taught();
  store.capture(inbound({
    message_id: `${CONVERSATION}:out-0001`, platform_message_id: 'out-0001',
    direction: 'outbound', role: 'agent', sender_id: ACCOUNT, body: 'the reply'
  }));
  assert.deepEqual(
    faultCodes(() => remember(store, call({ source_message_id: `${CONVERSATION}:out-0001` }))),
    ['TEACHING_SOURCE_NOT_A_CAPTURE']
  );
  assert.deepEqual(
    faultCodes(() => remember(store, call({ conversation_id: `${ACCOUNT}:room-nobody-writes-in` }))),
    ['TEACHING_SOURCE_NOT_A_CAPTURE']
  );
});

test('an identifier shaped like an escape is refused before any write', () => {
  const store = taught();
  const before = fs.readdirSync(teachingsDir(store));
  assert.ok(faultCodes(() => remember(store, call({ conversation_id: '../../etc' })))
    .includes('IDENTIFIER_HAS_DOT_SEGMENT'));
  assert.ok(faultCodes(() => remember(store, call({ source_message_id: 'a/b' })))
    .includes('IDENTIFIER_HAS_SEPARATOR'));
  assert.deepEqual(fs.readdirSync(teachingsDir(store)), before, 'a hostile identifier changed the store');
});

// One run of one call says everything that is wrong with it, in the launcher's
// fault shape, the way every other carbon command does.
test('every fault of one bad call is reported together', () => {
  const store = taught();
  const codes = faultCodes(() => remember(store, {
    text: '', conversation_id: CONVERSATION, source_message_id: `${CONVERSATION}:never-arrived`, now: NOW
  }));
  assert.deepEqual(codes.sort(), [
    'TEACHING_AGENT_UNGIVEN', 'TEACHING_MAX_ACTIVE_UNGIVEN', 'TEACHING_MAX_CHARS_UNGIVEN',
    'TEACHING_SOURCE_NOT_A_CAPTURE', 'TEACHING_TEXT_EMPTY'
  ]);
});

test('the caps are the declaration\'s and are never guessed here', () => {
  const store = taught();
  assert.ok(faultCodes(() => remember(store, call({ max_chars: undefined }))).includes('TEACHING_MAX_CHARS_UNGIVEN'));
  assert.ok(faultCodes(() => remember(store, call({ max_active: undefined }))).includes('TEACHING_MAX_ACTIVE_UNGIVEN'));
});

test('an agent is not taught through another agent\'s store', () => {
  const store = taught();
  assert.ok(faultCodes(() => remember(store, call({ agent: 'agent-02' }))).includes('TEACHING_AGENT_MISMATCH'));
});

test('a second instruction from the same message in the same second gets its own record', () => {
  const store = taught();
  const first = remember(store, call());
  const second = remember(store, call({ text: 'Send the weekly summary on a Friday.' }));
  assert.notEqual(second.id, first.id);
  assert.equal(second.record.taught_at, NOW, 'the record\'s own time was moved to free the id');
  assert.equal(listTeachings(store).active.length, 2);
  assert.equal(readTeachings(store).records.length, 2);
});

test('a change request and an instruction are one shape in one directory', () => {
  const store = taught();
  remember(store, call());
  const raised = raiseChange(store, call({
    text: 'Take the reviewed workbook and apply its rows to the records.',
    failed_question: 3,
    now: '2026-09-11T10:20:00.000Z'
  }));
  const list = listTeachings(store);
  assert.equal(list.active.length, 1);
  assert.equal(list.open.length, 1);
  assert.equal(list.open[0].id, raised.id);
  assert.equal(list.records.length, 2);
  assert.equal(fs.readdirSync(teachingsDir(store)).filter((n) => n.endsWith('.json')).length, 2);
});

test('the four groups come back oldest first', () => {
  const store = taught();
  const second = remember(store, call({ text: 'Second.', now: '2026-09-11T12:00:00.000Z' }));
  const first = remember(store, call({ text: 'First.', now: '2026-09-11T10:00:00.000Z' }));
  assert.deepEqual(listTeachings(store).active.map((r) => r.id), [first.id, second.id]);
});

test('a status that does not belong to the kind is refused', () => {
  const store = taught();
  const written = remember(store, call());
  assert.ok(faultCodes(() => writeTeaching(store, { ...written.record, status: 'open' }))
    .includes('TEACHING_STATUS_NOT_FOR_KIND'));
  assert.ok(faultCodes(() => writeTeaching(store, { ...written.record, kind: 'change-request', status: 'active' }))
    .includes('TEACHING_STATUS_NOT_FOR_KIND'));
});

test('a revocation cites a message this store holds, like the instruction did', () => {
  const store = taught();
  const written = remember(store, call());
  assert.deepEqual(
    faultCodes(() => forget(store, {
      id: written.id, conversation_id: CONVERSATION, source_message_id: `${CONVERSATION}:never-arrived`
    })),
    ['TEACHING_SOURCE_NOT_A_CAPTURE']
  );
  assert.equal(listTeachings(store).active.length, 1, 'the instruction was forgotten on a refused call');
});

test('a record moved to a file its id does not derive is reported, not read', () => {
  const store = taught();
  const written = remember(store, call());
  fs.renameSync(written.file, path.join(teachingsDir(store), 'teach-20260911T101500Z-00000000.json'));
  const list = listTeachings(store);
  assert.deepEqual(list.active, []);
  assert.equal(list.unreadable.length, 1);
  assert.equal(list.unreadable[0].code, 'TEACHING_MISPLACED');
});

// A client agent keeps what it was told. There is no expiry here, no age-out and
// no sweep, and this is what keeps it that way.
test('nothing in the teachings library takes a record away', () => {
  const source = fs.readFileSync(path.join(ROOT, 'stream', 'teachings.mjs'), 'utf8');
  assert.doesNotMatch(source, /prune|retention/i);
  assert.doesNotMatch(source, /\bunlinkSync\b|\brmSync\b|\brmdirSync\b/);
});
