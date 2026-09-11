// The outbound import, against the three places built here.
//
// A synthetic capture file, a synthetic audit directory and a synthetic turns
// table stand in for a client's own: a send the capture recorded with the
// platform's id and a quote, a turn beside it that produced the same text, a
// turn no capture recorded, an audit row for a send and audit rows for things
// that are not sends, a line nothing can parse, and a chat keyed by phone
// number. What is checked is that every join says how it was made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

import { Store } from '../stream/store.mjs';
import {
  SOURCE, capabilities, locate, payload, recordFor, resolvedAnswers, writeBatch
} from '../import/carbon-ledger-outbound.mjs';
import { joinOutbound, millisOf } from '../import/outbound-link.mjs';
import {
  epochOf, itemFrom, outboundFaults, selects, toleranceMs, turnItem, turnRowFaults, valueAt
} from '../import/outbound-mapping.mjs';
import { emptyLineCounts, emptyTurnCounts, readDirectory, readLines, readTurns } from '../import/outbound-sources.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ACCOUNT = '15550009999@s.whatsapp.net';
const CHAT = '15550001111@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const SENT = 'What the agent sent back.';

function temp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carbon-outbound-${name}-`));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// The capture file a channel bridge appended: the message under a name of its
// own, the timestamp as the two-word integer a protobuf long becomes in JSON,
// and lines that are not the agent's sends beside the ones that are.
function buildEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  const line = (normalized) => JSON.stringify({ type: 'capture_event', normalized });
  const at = (seconds) => ({ low: seconds, high: 0, unsigned: true });
  const lines = [
    line({
      messageId: 'SENT_1', chatId: CHAT, chatName: 'Ada', senderId: ACCOUNT, senderName: null,
      body: SENT, fromMe: true, timestamp: at(1743591720), hasMedia: false, mediaUrls: [],
      quotedMessageId: 'LEDGER_1', mediaType: 'text', trace: 'kept'
    }),
    line({
      messageId: 'ARRIVED_1', chatId: CHAT, chatName: 'Ada', senderId: CHAT, senderName: 'Ada',
      body: 'The tap is leaking again.', fromMe: false, timestamp: at(1743591600), hasMedia: false,
      mediaUrls: [], quotedMessageId: null, mediaType: 'text'
    }),
    line({
      messageId: 'SENT_2', chatId: GROUP, chatName: 'Zone north', senderId: ACCOUNT, senderName: null,
      body: 'A send in a group.', fromMe: true, timestamp: at(1743595200), hasMedia: true,
      mediaUrls: ['gone.jpg'], quotedMessageId: null, mediaType: 'image'
    }),
    '{ this line is not JSON',
    ''
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// The audit a send authority appended, one directory of daily files: two rows
// per operation, and most operations are not sends.
function buildAudit(dir) {
  const at = path.join(dir, 'audit');
  fs.mkdirSync(at, { recursive: true });
  const row = (event, action, destination, stamp, extra = {}) =>
    JSON.stringify({ schema: 'audit.v1', event, action, destination, at: stamp, operationId: `op-${action}-${stamp}`, ...extra });
  fs.writeFileSync(path.join(at, 'audit-2025-04-02.jsonl'), [
    row('decision', 'send', CHAT, '2025-04-02T11:02:05.000Z', { allowed: true }),
    row('result', 'send', CHAT, '2025-04-02T11:02:05.000Z', { status: 'success' }),
    row('decision', 'typing', CHAT, '2025-04-02T11:01:00.000Z', { allowed: true }),
    row('result', 'typing', CHAT, '2025-04-02T11:01:00.000Z', { status: 'success' }),
    row('result', 'send', GROUP, '2025-04-05T09:00:00.000Z', { status: 'unknown' })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(at, 'not-a-source.txt'), 'nothing here is read\n');
  return at;
}

// The harness's turns table: the text the model produced, the ids it was
// answering, and no message id at all.
function buildTurns(dir) {
  const file = path.join(dir, 'turns.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE agent_turns (
    turn_ref TEXT PRIMARY KEY, chat TEXT, at REAL, envelope TEXT, answered TEXT, state TEXT, model TEXT);`);
  const insert = db.prepare('INSERT INTO agent_turns VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('TURN_1', CHAT, 1743591740, JSON.stringify({ final_response: SENT }),
    JSON.stringify(['LEDGER_1']), 'completed', 'a-model');
  insert.run('TURN_2', CHAT, 1743600000, JSON.stringify({ final_response: 'A turn no capture recorded.' }),
    JSON.stringify(['LEDGER_1', 'LEDGER_2']), 'completed', 'a-model');
  insert.run('TURN_3', GROUP, 1743595260, JSON.stringify({ final_response: 'Something else went out.' }),
    JSON.stringify([]), 'failed', 'a-model');
  db.close();
  return file;
}

function mappingFor() {
  return {
    ledger: 'client-ledger',
    outbound: {
      events: {
        record: 'normalized',
        select: { fromMe: true },
        timestamp: 'epoch_seconds',
        media_refs: 'json_array',
        fields: {
          platform_message_id: 'messageId', chat_key: 'chatId', chat_name: 'chatName',
          sender_id: 'senderId', sender_name: 'senderName', timestamp: 'timestamp',
          body: 'body', message_kind: 'mediaType', has_media: 'hasMedia',
          media_refs: 'mediaUrls', reply_to: 'quotedMessageId'
        },
        carry: ['trace']
      },
      audit: {
        select: { event: 'result', action: ['send', 'send-media'] },
        timestamp: 'iso8601',
        fields: {
          platform_message_id: 'operationId', chat_key: 'destination',
          timestamp: 'at', status: 'status'
        },
        carry: ['action']
      },
      turns: {
        timestamp: 'epoch_seconds',
        answers_refs: 'json_array',
        sql: `SELECT turn_ref AS platform_message_id, chat AS chat_key, at AS timestamp,
                     json_extract(envelope, '$.final_response') AS body,
                     answered AS answers_refs, state AS status, model AS model
              FROM agent_turns ORDER BY at ASC`
      },
      link: { tolerance_seconds: 120 }
    }
  };
}

function contextIn(dir, mapping) {
  return {
    store: Store.open(path.join(dir, 'store')),
    agent: 'agent-01',
    account: ACCOUNT,
    mapping,
    tolerance_ms: toleranceMs(mapping),
    lid_map: { phone_to_lid: {}, lid_to_phone: {} }
  };
}

function itemsFrom(dir, mapping) {
  const counts = { events: emptyLineCounts(), audit: emptyLineCounts(), turns: emptyTurnCounts() };
  const events = readLines(path.join(dir, 'events.jsonl'), 'event', mapping.outbound.events, null, counts.events);
  const audit = readDirectory(path.join(dir, 'audit'), 'audit', mapping.outbound.audit, null, counts.audit);
  const db = new DatabaseSync(path.join(dir, 'turns.db'), { readOnly: true });
  const turns = readTurns(db, mapping.outbound.turns, counts.turns);
  db.close();
  return { items: [...events, ...audit, ...turns], counts };
}

function build(dir) {
  buildEvents(dir);
  buildAudit(dir);
  buildTurns(dir);
}

test('a mapping with no outbound section, an unusable path or a write is refused whole', () => {
  assert.deepEqual(outboundFaults({}).map((f) => f.code), ['MAPPING_WITHOUT_OUTBOUND']);
  assert.deepEqual(outboundFaults({ outbound: {} }).map((f) => f.code), ['MAPPING_WITHOUT_OUTBOUND']);

  const missing = outboundFaults({ outbound: { events: { fields: {} } } }).map((f) => f.code);
  assert.equal(missing.filter((c) => c === 'OUTBOUND_FIELD_UNNAMED').length, 3,
    'every required field is reported, not only the first');

  const escaped = outboundFaults({
    outbound: {
      events: {
        record: '../..',
        fields: { platform_message_id: 'a.b', chat_key: 'c', timestamp: 'd e' },
        carry: ['ok', '1bad']
      }
    }
  }).map((f) => f.code);
  assert.equal(escaped.filter((c) => c === 'OUTBOUND_PATH_UNUSABLE').length, 3, escaped.join(', '));

  const write = outboundFaults({ outbound: { turns: { sql: 'DELETE FROM agent_turns' } } }).map((f) => f.code);
  assert.deepEqual(write, ['OUTBOUND_TURNS_NOT_A_READ'],
    'a mapping could carry a write into the client database');

  const second = outboundFaults({ outbound: { turns: { sql: 'SELECT 1; DROP TABLE t' } } }).map((f) => f.code);
  assert.deepEqual(second, ['OUTBOUND_TURNS_NOT_A_READ'], 'a second statement rode in behind the select');

  const format = outboundFaults({ outbound: { turns: { sql: 'SELECT 1', timestamp: 'yesterday' } } }).map((f) => f.code);
  assert.ok(format.includes('FORMAT_UNKNOWN'));
});

test('a path reaches only where the mapping named, and a select is what the mapping said', () => {
  assert.equal(valueAt({ a: { b: 'c' } }, 'a.b'), 'c');
  assert.equal(valueAt({ a: 1 }, 'a.b'), undefined);
  assert.equal(valueAt({ a: { b: 'c' } }, null), undefined);

  const section = { select: { 'x.y': true, kind: ['one', 'two'] } };
  assert.equal(selects(section, { x: { y: true }, kind: 'two' }), true);
  assert.equal(selects(section, { x: { y: false }, kind: 'two' }), false);
  assert.equal(selects(section, { x: { y: true }, kind: 'three' }), false);
  assert.equal(selects({}, {}), true);

  assert.equal(epochOf({ low: 1743591600, high: 0, unsigned: true }), 1743591600);
  assert.equal(epochOf({ low: 0, high: 1 }), 4_294_967_296);
  assert.equal(epochOf(1743591600), 1743591600);
  assert.equal(epochOf(null), null);

  assert.equal(toleranceMs({}), 180_000);
  assert.equal(toleranceMs({ outbound: { link: { tolerance_seconds: 30 } } }), 30_000);
  assert.equal(toleranceMs({ outbound: { link: { tolerance_seconds: -1 } } }), 180_000);
});

test('only the lines the mapping selects are read, and an unreadable line is counted', () => {
  const dir = temp('read');
  build(dir);
  const mapping = mappingFor();
  const { items, counts } = itemsFrom(dir, mapping);

  assert.equal(counts.events.lines, 4);
  assert.equal(counts.events.unparseable, 1, 'a line nothing can parse stopped the read');
  assert.equal(counts.events.selected, 2, 'a message that arrived was read as a send');

  assert.equal(counts.audit.files, 1, 'a file that is not one of these lines was opened');
  assert.equal(counts.audit.selected, 2, 'a decision or a typing operation was read as a send');

  assert.equal(counts.turns.rows, 3);
  assert.equal(counts.turns.selected, 3);

  const event = items.find((one) => one.message_id === 'SENT_1');
  assert.equal(event.timestamp, '2025-04-02T11:02:00.000Z', 'the two-word integer was not read as a time');
  assert.equal(event.reply_to, 'LEDGER_1');
  assert.deepEqual(event.fields, { trace: 'kept' });

  const turn = items.find((one) => one.message_id === 'TURN_2');
  assert.deepEqual(turn.answers_refs, ['LEDGER_1', 'LEDGER_2']);
  assert.deepEqual(turn.fields, { model: 'a-model' }, 'a column nothing named was dropped instead of carried');
});

test('a turns query that names none of the columns is refused before a record is written', () => {
  assert.deepEqual(turnRowFaults({}).map((f) => f.code),
    ['OUTBOUND_TURN_COLUMN_UNNAMED', 'OUTBOUND_TURN_COLUMN_UNNAMED', 'OUTBOUND_TURN_COLUMN_UNNAMED']);
  assert.deepEqual(turnRowFaults({ platform_message_id: 'a', chat_key: 'b', timestamp: 1 }), []);

  const dir = temp('turn-columns');
  build(dir);
  const db = new DatabaseSync(path.join(dir, 'turns.db'), { readOnly: true });
  assert.throws(
    () => readTurns(db, { sql: 'SELECT turn_ref, chat FROM agent_turns' }, emptyTurnCounts()),
    (error) => error.faults.every((f) => f.code === 'OUTBOUND_TURN_COLUMN_UNNAMED'));
  db.close();
});

test('a mark is joined to the send it belongs to, or it says it joined to nothing', () => {
  const item = (kind, message_id, timestamp) => ({
    kind, message_id, timestamp, conversation_id: 'a:chat', chat_key: 'chat', fields: {}, answers_refs: []
  });
  const { sends, counts } = joinOutbound([
    item('event', 'E1', '2025-04-02T11:00:00.000Z'),
    item('event', 'E2', '2025-04-02T11:00:30.000Z'),
    item('turn', 'T1', '2025-04-02T11:00:20.000Z'),
    item('turn', 'T2', '2025-04-02T18:00:00.000Z'),
    item('turn', 'T3', '2025-04-02T18:00:10.000Z'),
    item('audit', 'A1', '2025-04-02T11:00:05.000Z')
  ], 60_000);

  assert.equal(counts.joined.turn, 1);
  assert.equal(counts.alone.turn, 2, 'the far turn joined a send an hour away');
  assert.equal(sends.length, 4,
    'two turns ten seconds apart became one send, and one of them lost its text');
  assert.equal(sends.find((send) => send.item.message_id === 'T3').attached.turn, undefined,
    'a turn joined to another turn');

  const near = sends.find((send) => send.item.message_id === 'E2');
  assert.equal(near.attached.turn.message_id, 'T1', 'the nearer send did not win the turn');
  assert.equal(near.links.turn.method, 'conversation and time');
  assert.equal(near.links.turn.delta_ms, 10_000);
  assert.equal(near.links.turn.tolerance_ms, 60_000);
  assert.equal(near.links.turn.candidates, 2);

  const alone = sends.find((send) => send.item.message_id === 'T2');
  assert.match(alone.links.turn.method, /^none:/);
  assert.equal(alone.attached.turn, undefined);

  const first = sends.find((send) => send.item.message_id === 'E1');
  assert.equal(first.attached.audit.message_id, 'A1');
  assert.equal(millisOf({ timestamp: 'not a time' }), null);
});

test('every send becomes one outbound record that says how it was joined', () => {
  const dir = temp('records');
  const mapping = mappingFor();
  build(dir);
  const context = contextIn(dir, mapping);
  const { items } = itemsFrom(dir, mapping);
  const { entries, counts } = payload(context, items);

  assert.equal(counts.event, 2);
  assert.equal(counts.turn, 3);
  assert.equal(counts.joined.turn, 2);
  assert.equal(counts.alone.turn, 1);
  assert.equal(counts.audit, 2);
  assert.equal(counts.joined.audit, 1);
  assert.equal(counts.alone.audit, 1);
  assert.equal(entries.length, 4, 'a mark with no capture beside it was dropped instead of kept');

  const byId = new Map(entries.map((entry) => [entry.record.platform_message_id, entry.record]));
  const sent = byId.get('SENT_1');
  assert.equal(sent.source, SOURCE);
  assert.equal(sent.direction, 'outbound');
  assert.equal(sent.role, 'agent');
  assert.equal(sent.historical, true);
  assert.equal(sent.disposition, 'captured');
  assert.equal(sent.delivery, undefined, 'a send on somebody else\'s box was written as a delivery from here');
  assert.equal(sent.hold, undefined);
  assert.equal(sent.body, SENT);
  assert.equal(sent.reply_to, `${ACCOUNT}:${CHAT}:LEDGER_1`);
  assert.deepEqual(sent.adapter_fields.outbound_sources, ['event', 'turn', 'audit']);
  assert.equal(sent.adapter_fields.ledger, 'client-ledger');
  assert.equal(sent.adapter_fields.trace, 'kept');
  assert.equal(sent.adapter_fields.turn.id, 'TURN_1');
  assert.equal(sent.adapter_fields.turn.model, 'a-model');
  assert.equal(sent.adapter_fields.turn.text_sha256, sha256(SENT));
  assert.equal(sent.adapter_fields.turn.text_is_what_went_out, true);
  assert.equal(sent.adapter_fields.send_audit.status, 'success');
  assert.equal(sent.adapter_fields.link.turn.method, 'conversation and time');
  assert.equal(sent.adapter_fields.link.turn.delta_ms, 20_000);

  const group = byId.get('SENT_2');
  assert.equal(group.conversation_kind, 'group');
  assert.deepEqual(group.adapter_fields.outbound_sources, ['event', 'turn']);
  assert.equal(group.adapter_fields.turn.text_is_what_went_out, false,
    'the text the model produced was taken for the text that went out');
  assert.deepEqual(group.adapter_fields.media, [{ ref: 'gone.jpg', present: null }],
    'an attachment was copied instead of referenced, or its presence was invented');
  assert.equal(group.adapter_fields.media_missing, undefined,
    'a file nothing said where to look for was called missing');

  const alone = byId.get('TURN_2');
  assert.deepEqual(alone.adapter_fields.outbound_sources, ['turn']);
  assert.match(alone.adapter_fields.identified_by, /the id the turn row carries/);
  assert.match(alone.adapter_fields.link.turn.method, /^none:/);
  assert.equal(alone.reply_to, undefined, 'two answered messages became one reply link');
  assert.deepEqual(alone.adapter_fields.answers,
    [`${ACCOUNT}:${CHAT}:LEDGER_1`, `${ACCOUNT}:${CHAT}:LEDGER_2`]);
  assert.equal(alone.sender_id, ACCOUNT);
});

test('a reply link counts as resolved only when the record it names is in the store', () => {
  const dir = temp('resolve');
  const mapping = mappingFor();
  build(dir);
  const context = contextIn(dir, mapping);
  const { items } = itemsFrom(dir, mapping);

  const before = payload(context, items).entries
    .reduce((total, entry) => total + resolvedAnswers(context.store, entry.record), 0);
  assert.equal(before, 0, 'a reply to a message nothing imported was counted as resolved');

  context.store.capture({
    schema: 'carbon.message.v1', agent: 'agent-01', source: 'import:ledger-sqlite', account: ACCOUNT,
    conversation_id: `${ACCOUNT}:${CHAT}`, conversation_kind: 'direct',
    message_id: `${ACCOUNT}:${CHAT}:LEDGER_1`, platform_message_id: 'LEDGER_1', revision: 0,
    direction: 'inbound', role: 'contact', sender_id: CHAT, received_at: '2025-04-02T11:00:00.000Z',
    body: 'The tap is leaking again.', attachments: [], historical: true, disposition: 'captured'
  });

  const after = payload(context, items).entries
    .reduce((total, entry) => total + resolvedAnswers(context.store, entry.record), 0);
  assert.equal(after, 2, 'the two sends answering the imported message did not resolve');
});

test('a chat keyed by phone number lands where the ledger import put it, and says so', () => {
  const dir = temp('chat-key');
  const mapping = mappingFor();
  build(dir);
  const context = contextIn(dir, mapping);
  const { items } = itemsFrom(dir, mapping);

  const placed = locate(context, items).find((one) => one.message_id === 'SENT_1');
  assert.equal(placed.conversation_id, `${ACCOUNT}:${CHAT}`);
  const record = recordFor({ ...context }, { item: placed, attached: {}, links: {} });
  assert.match(record.adapter_fields.chat_key_note, /keyed by phone number/);

  const known = { ...context, lid_map: { phone_to_lid: { [CHAT]: '99001@lid' }, lid_to_phone: {} } };
  const joined = locate(known, items).find((one) => one.message_id === 'SENT_1');
  assert.equal(joined.conversation_id, `${ACCOUNT}:99001@lid`);
  assert.equal(joined.chat_key_note, null);
});

test('the command imports the three sources, reports counts and is idempotent', () => {
  const dir = temp('command');
  build(dir);
  const mappingFile = path.join(dir, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify(mappingFor(), null, 2));
  const store = path.join(dir, 'store');

  const run = () => JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'bin', 'carbon-import'), 'ledger-outbound',
    '--agent', 'agent-01', '--mapping', mappingFile, '--store', store, '--account', ACCOUNT,
    '--events', path.join(dir, 'events.jsonl'),
    '--audit', path.join(dir, 'audit'),
    '--turns', path.join(dir, 'turns.db')
  ], { encoding: 'utf8' }));

  const first = run();
  assert.equal(first.agent, 'agent-01');
  assert.equal(first.account, ACCOUNT);
  assert.equal(first.tolerance_ms, 120_000);
  assert.equal(first.read.events.selected, 2);
  assert.equal(first.read.audit.selected, 2);
  assert.equal(first.read.turns.selected, 3);
  assert.equal(first.marks.joined.turn, 2);
  assert.equal(first.marks.alone.turn, 1);
  assert.equal(first.marks.alone.audit, 1);
  assert.equal(first.sends, 4);
  assert.equal(first.records_written, 4);
  assert.equal(first.records_merged_into_an_existing_capture, 0);
  assert.equal(first.conversations, 2);
  assert.deepEqual(first.by_role, { agent: 4 });
  assert.equal(first.reply_links, 1);
  assert.equal(first.answers_named, 3);
  assert.equal(first.answers_resolving_to_a_record_in_the_store, 0);
  assert.equal(first.sends_whose_message_id_an_earlier_import_already_wrote, 0);
  assert.equal(first.attachments_referenced, 1);
  assert.equal(first.attachments_unchecked, 1);
  assert.equal(first.earliest_send, '2025-04-02T11:02:00.000Z');
  assert.equal(first.latest_send, '2025-04-05T09:00:00.000Z');
  assert.equal(first.released, 0);

  const second = run();
  assert.equal(second.records_written, 4);
  assert.equal(second.records_merged_into_an_existing_capture, 4,
    'a second run wrote records instead of merging into the first');

  const check = execFileSync(process.execPath,
    [path.join(ROOT, 'bin', 'carbon-stream'), 'check', '--store', store], { encoding: 'utf8' });
  assert.match(check, /case 11\s+pass/);
});

test('a send whose id an earlier import already wrote is counted, never silently lost', () => {
  const dir = temp('claimed');
  build(dir);
  const mappingFile = path.join(dir, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify(mappingFor(), null, 2));
  const store = path.join(dir, 'store');

  // The ledger import got this message's from_me wrong and wrote it as one that
  // arrived. The store has no overwrite, so the outbound record cannot land.
  Store.open(store).capture({
    schema: 'carbon.message.v1', agent: 'agent-01', source: 'import:ledger-sqlite', account: ACCOUNT,
    conversation_id: `${ACCOUNT}:${CHAT}`, conversation_kind: 'direct',
    message_id: `${ACCOUNT}:${CHAT}:SENT_1`, platform_message_id: 'SENT_1', revision: 0,
    direction: 'inbound', role: 'contact', sender_id: CHAT, received_at: '2025-04-02T11:02:00.000Z',
    body: SENT, attachments: [], historical: true, disposition: 'captured'
  });

  const summary = JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'bin', 'carbon-import'), 'ledger-outbound',
    '--agent', 'agent-01', '--mapping', mappingFile, '--store', store, '--account', ACCOUNT,
    '--events', path.join(dir, 'events.jsonl'),
    '--turns', path.join(dir, 'turns.db')
  ], { encoding: 'utf8' }));

  assert.equal(summary.sends_whose_message_id_an_earlier_import_already_wrote, 1);
  assert.deepEqual(summary.by_earlier_source, { 'import:ledger-sqlite': 1 });
  assert.equal(summary.by_role.contact, undefined,
    'a record another import owns was counted as one this import wrote');
});

test('the command refuses a source the mapping does not describe, and a run with no source', () => {
  const dir = temp('refuse');
  build(dir);
  const mapping = mappingFor();
  delete mapping.outbound.audit;
  const mappingFile = path.join(dir, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));

  const run = (args) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'bin', 'carbon-import'), 'ledger-outbound',
        '--agent', 'agent-01', '--mapping', mappingFile, '--store', path.join(dir, 'store'),
        '--account', ACCOUNT, ...args], { encoding: 'utf8' });
      return { code: 0, out: '' };
    } catch (error) {
      return { code: error.status, out: (error.stdout ?? '') + (error.stderr ?? '') };
    }
  };

  const undescribed = run(['--audit', path.join(dir, 'audit')]);
  assert.equal(undescribed.code, 1);
  assert.match(undescribed.out, /OUTBOUND_SOURCE_UNDESCRIBED/);

  const nothing = run([]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.out, /MISSING_ARGUMENT/);

  const gone = run(['--events', path.join(dir, 'not-there.jsonl')]);
  assert.equal(gone.code, 1);
  assert.match(gone.out, /OUTBOUND_SOURCE_MISSING/);

  for (const line of nothing.out.split('\n').filter(Boolean)) {
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['code', 'fix', 'problem', 'subject']);
  }
});

test('the turns table is opened read-only, so an import cannot write to a client database', () => {
  const dir = temp('readonly');
  build(dir);
  const db = new DatabaseSync(path.join(dir, 'turns.db'), { readOnly: true });
  assert.throws(() => db.exec('DELETE FROM agent_turns'), /readonly|read-only/i);
  db.close();
});

test('an item read straight from a mapping is the same item the sources produce', () => {
  const section = mappingFor().outbound.events;
  const item = itemFrom('event', section, {
    messageId: 'X1', chatId: CHAT, chatName: 'Ada', senderId: ACCOUNT, senderName: null,
    body: 'a line', fromMe: true, timestamp: 1743591600, hasMedia: false, mediaUrls: [],
    quotedMessageId: null, mediaType: 'text', trace: 'kept'
  });
  assert.equal(item.kind, 'event');
  assert.equal(item.timestamp, '2025-04-02T11:00:00.000Z');
  assert.equal(item.reply_to, null);
  assert.deepEqual(item.media, []);

  const turn = turnItem({ timestamp: 'epoch_seconds', answers_refs: 'json_array' },
    { platform_message_id: 'T9', chat_key: CHAT, timestamp: 1743591600, body: 'said', answers_refs: '["A"]', extra: 7 });
  assert.equal(turn.kind, 'turn');
  assert.equal(turn.text, 'said');
  assert.deepEqual(turn.answers_refs, ['A']);
  assert.deepEqual(turn.fields, { extra: 7 });
});

test('writing a batch straight through the adapter writes one record per send', () => {
  const dir = temp('batch');
  const mapping = mappingFor();
  build(dir);
  const context = contextIn(dir, mapping);
  const { items } = itemsFrom(dir, mapping);
  assert.deepEqual(capabilities, ['import'],
    'the conformance check runs the cases the adapter declares a capability for');
  const written = writeBatch(context, items);
  assert.equal(written.length, 4);
  for (const result of written) {
    assert.equal(result.record.direction, 'outbound');
    assert.equal(result.record.historical, true);
    assert.equal(result.record.release, undefined, 'a historical record was released');
  }
});
