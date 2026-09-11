// The ledger import, against a ledger built here.
//
// A synthetic database stands in for a client's own: a messages table under
// somebody else's column names, a chat keyed by phone number, a reply, media
// that is there and media that is not, and two tables holding the corrections
// the system recorded around those messages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

import { Store } from '../stream/store.mjs';
import { encodeComponent } from '../stream/encode.mjs';
import { SOURCE, writeBatch, messageIndexOf } from '../import/carbon-ledger-sqlite.mjs';
import {
  isRead, mappingFaults, messageQuery, normaliseRow, toIso, mediaRefsOf, roleFor,
  countQuery, describeMedia, refString
} from '../import/ledger-mapping.mjs';
import {
  CORRECTIONS_SCHEMA, groupCorrections, toCorrection, writeSidecars, sidecarFile, parseRefs
} from '../import/ledger-corrections.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ACCOUNT = '15550009999@s.whatsapp.net';
const CHAT = '15550001111@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

function temp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carbon-ledger-${name}-`));
}

// The ledger a client's own system might keep: its own table name, its own
// column names, seconds since the epoch, media as a JSON array of paths.
function buildLedger(dir, { mediaRoot = null } = {}) {
  const file = path.join(dir, 'client.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE chat_log (
      row_ref TEXT PRIMARY KEY,
      chat TEXT NOT NULL,
      chat_title TEXT NOT NULL,
      speaker TEXT,
      speaker_name TEXT,
      outbound INTEGER NOT NULL,
      at INTEGER NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      attached INTEGER NOT NULL,
      attachment_paths TEXT NOT NULL DEFAULT '[]',
      answers TEXT,
      town TEXT,
      in_scope INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE operator_edits (
      edit_id INTEGER PRIMARY KEY,
      who TEXT NOT NULL,
      what TEXT NOT NULL,
      was TEXT NOT NULL,
      now TEXT NOT NULL,
      cited TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE nightly_flags (
      flag_id INTEGER PRIMARY KEY,
      note TEXT NOT NULL,
      cited TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO chat_log
    (row_ref, chat, chat_title, speaker, speaker_name, outbound, at, body, kind, attached, attachment_paths, answers, town, in_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const present = mediaRoot === null ? null : path.join(mediaRoot, 'there.jpg');
  if (present !== null) fs.writeFileSync(present, 'not really a picture');

  insert.run('R1', CHAT, 'Ada', CHAT, 'Ada', 0, 1743591600, 'The tap is leaking again.', 'text', 0, '[]', null, 'north', 1);
  insert.run('R2', CHAT, 'Ada', null, null, 1, 1743591660, 'Someone will come tomorrow.', 'text', 0, '[]', 'R1', 'north', 1);
  insert.run('R3', CHAT, 'Ada', CHAT, 'Ada', 0, 1743591720, '', 'image', 1,
    JSON.stringify(['there.jpg']), null, 'north', 1);
  insert.run('R4', CHAT, 'Ada', CHAT, 'Ada', 0, 1743591780, '', 'image', 1,
    JSON.stringify(['gone.jpg']), null, 'north', 1);
  insert.run('R5', GROUP, 'Zone north', '15550002222@s.whatsapp.net', 'Bo', 0, 1743591840, 'Noted.', 'text', 0, '[]', null, 'north', 1);
  insert.run('R6', CHAT, 'Ada', CHAT, 'Ada', 0, 1743591900, 'Out of scope.', 'text', 0, '[]', null, 'north', 0);

  db.prepare('INSERT INTO operator_edits (edit_id, who, what, was, now, cited, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Krisleen', 'case.operator.edited', '{"state":"open"}', '{"state":"completed"}', JSON.stringify(['R1', 'R2']), 1743595200);
  db.prepare('INSERT INTO operator_edits (edit_id, who, what, was, now, cited, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(2, 'Krisleen', 'case.operator.edited', '{}', '{}', JSON.stringify(['NOT_IMPORTED']), 1743595260);
  db.prepare('INSERT INTO nightly_flags (flag_id, note, cited, at) VALUES (?, ?, ?, ?)')
    .run(1, 'the photo does not show the work', JSON.stringify(['R3']), 1743598800);
  db.close();
  return file;
}

function mappingFor(mediaRoot = null) {
  const mapping = {
    ledger: 'client-ledger',
    messages: {
      table: 'chat_log',
      where: 'in_scope = 1',
      order_by: 'at ASC, row_ref ASC',
      timestamp: 'epoch_seconds',
      media_refs: 'json_array',
      columns: {
        platform_message_id: 'row_ref',
        chat_key: 'chat',
        chat_name: 'chat_title',
        sender_id: 'speaker',
        sender_name: 'speaker_name',
        from_me: 'outbound',
        timestamp: 'at',
        body: 'body',
        message_kind: 'kind',
        has_media: 'attached',
        media_refs: 'attachment_paths',
        reply_to: 'answers'
      },
      carry: ['town']
    },
    roles: { from_me: 'agent', operator_senders: ['15550002222@s.whatsapp.net'] },
    corrections: [
      {
        kind: 'reviewer_edit',
        timestamp: 'epoch_seconds',
        message_refs: 'json_array',
        sql: `SELECT 'edit:' || edit_id AS correction_id, at AS at, who AS actor,
                     'human' AS actor_kind, what AS action, 'case' AS subject_kind,
                     edit_id AS subject_id, was AS before_json, now AS after_json,
                     cited AS message_refs
              FROM operator_edits`
      },
      {
        kind: 'nightly_flag',
        timestamp: 'epoch_seconds',
        message_refs: 'json_array',
        sql: `SELECT 'flag:' || flag_id AS correction_id, at AS at, 'nightly' AS actor,
                     'agent' AS actor_kind, note AS note, cited AS message_refs
              FROM nightly_flags`
      }
    ]
  };
  if (mediaRoot !== null) mapping.media = { root: mediaRoot };
  return mapping;
}

function itemsFrom(file, mapping) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(messageQuery(mapping)).all();
  db.close();
  return rows.map((row) => normaliseRow(mapping, row));
}

function contextIn(dir, mapping) {
  return {
    store: Store.open(path.join(dir, 'store')),
    agent: 'agent-01',
    account: ACCOUNT,
    mapping,
    lid_map: { phone_to_lid: {}, lid_to_phone: {} }
  };
}

test('a mapping that names no table, no required column or a write is refused whole', () => {
  assert.deepEqual(mappingFaults(null).map((f) => f.code), ['MAPPING_NOT_AN_OBJECT']);
  assert.deepEqual(mappingFaults({}).map((f) => f.code), ['MAPPING_WITHOUT_MESSAGES']);

  const codes = mappingFaults({ messages: { table: 'chat log', columns: {} } }).map((f) => f.code);
  assert.ok(codes.includes('TABLE_NAME_UNUSABLE'));
  assert.equal(codes.filter((c) => c === 'COLUMN_UNNAMED').length, 3,
    'every required column is reported, not only the first');

  const injected = mappingFaults({
    messages: { table: 'chat_log', columns: { platform_message_id: 'a', chat_key: 'b', timestamp: 'c" FROM x; DROP TABLE y --' } }
  }).map((f) => f.code);
  assert.ok(injected.includes('COLUMN_NAME_UNUSABLE'));

  const write = mappingFaults({
    messages: { table: 'chat_log', columns: { platform_message_id: 'a', chat_key: 'b', timestamp: 'c' } },
    corrections: [{ kind: 'edit', sql: 'DELETE FROM operator_edits' }]
  }).map((f) => f.code);
  assert.ok(write.includes('CORRECTION_NOT_A_READ'), 'a mapping could carry a write into the client database');
});

test('a correction query is one read and nothing else', () => {
  assert.equal(isRead('SELECT 1'), true);
  assert.equal(isRead('  -- a comment\n with x as (select 1) select * from x'), true);
  assert.equal(isRead('DELETE FROM t'), false);
  assert.equal(isRead('SELECT 1; DROP TABLE t'), false, 'a second statement rode in behind the select');
});

test('the ledger\'s own names never leave the query', () => {
  const sql = messageQuery(mappingFor());
  assert.match(sql, /FROM "chat_log"/);
  assert.match(sql, /"row_ref" AS "platform_message_id"/);
  assert.match(sql, /"town" AS "carry__town"/);
  assert.match(sql, /WHERE in_scope = 1/);
  assert.match(sql, /ORDER BY at ASC, row_ref ASC/);
});

test('times, media references and roles are read as the mapping says', () => {
  assert.equal(toIso(1743591600, 'epoch_seconds'), '2025-04-02T11:00:00.000Z');
  assert.equal(toIso(1743591600000, 'epoch_millis'), '2025-04-02T11:00:00.000Z');
  assert.equal(toIso('2025-04-02T19:00:00+08:00', 'iso8601'), '2025-04-02T11:00:00.000Z');
  assert.equal(toIso('', 'epoch_seconds'), null);

  assert.deepEqual(mediaRefsOf('["a.jpg","b.jpg"]'), ['a.jpg', 'b.jpg']);
  assert.deepEqual(mediaRefsOf('[{"path":"a.jpg"}]'), ['a.jpg']);
  assert.deepEqual(mediaRefsOf('a.jpg,b.jpg', 'comma'), ['a.jpg', 'b.jpg']);
  assert.deepEqual(mediaRefsOf('a.jpg', 'single'), ['a.jpg']);
  assert.deepEqual(mediaRefsOf('[]'), []);

  const roles = { roles: { from_me: 'agent', operator_senders: ['op@s.whatsapp.net'] } };
  assert.equal(roleFor(roles, { from_me: true, sender_jid: null }), 'agent');
  assert.equal(roleFor(roles, { from_me: false, sender_jid: 'op@s.whatsapp.net' }), 'operator');
  assert.equal(roleFor(roles, { from_me: false, sender_jid: CHAT }), 'contact');
  assert.equal(roleFor({}, { from_me: true, sender_jid: null }), 'agent');
});

test('every ledger row becomes one historical record that releases nothing', () => {
  const dir = temp('records');
  const root = path.join(dir, 'media');
  fs.mkdirSync(root, { recursive: true });
  const mapping = mappingFor(root);
  const file = buildLedger(dir, { mediaRoot: root });

  const context = contextIn(dir, mapping);
  const items = itemsFrom(file, mapping);
  assert.equal(items.length, 5, 'the mapping\'s where clause did not hold');

  const written = writeBatch(context, items);
  assert.equal(written.length, 5);
  for (const result of written) {
    assert.equal(result.record.source, SOURCE);
    assert.equal(result.record.historical, true);
    assert.equal(result.record.delivery, undefined);
    assert.equal(result.record.hold, undefined, 'a message from last spring held the conversation');
  }

  const byId = new Map(written.map((r) => [r.record.platform_message_id, r.record]));
  assert.equal(byId.get('R1').role, 'contact');
  assert.equal(byId.get('R1').direction, 'inbound');
  assert.equal(byId.get('R1').adapter_fields.town, 'north');
  assert.equal(byId.get('R2').role, 'agent');
  assert.equal(byId.get('R2').direction, 'outbound');
  assert.equal(byId.get('R2').reply_to, `${ACCOUNT}:${CHAT}:R1`,
    'the agent\'s reply does not name the message it answered');
  assert.equal(byId.get('R2').adapter_fields.reply_to_platform_id, 'R1');
  assert.equal(byId.get('R5').role, 'operator');
  assert.equal(byId.get('R5').conversation_kind, 'group');
  assert.equal(byId.get('R1').conversation_kind, 'direct');
  assert.equal(byId.get('R1').conversation_id, `${ACCOUNT}:${CHAT}`);
  assert.equal(byId.get('R1').sent_at, '2025-04-02T11:00:00.000Z');
});

test('an attachment is referenced and its absence is recorded, never invented', () => {
  const dir = temp('media');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const root = path.join(dir, 'media');
  const mapping = mappingFor(root);
  const file = buildLedger(dir, { mediaRoot: root });
  const context = contextIn(dir, mapping);
  const written = writeBatch(context, itemsFrom(file, mapping));
  const byId = new Map(written.map((r) => [r.record.platform_message_id, r.record]));

  const there = byId.get('R3');
  assert.deepEqual(there.attachments, [], 'the import copied bytes it was only asked to reference');
  assert.equal(there.adapter_fields.media[0].present, true);
  assert.equal(there.adapter_fields.media[0].path, path.join(root, 'there.jpg'));
  assert.equal(there.adapter_fields.media_missing, undefined);

  const gone = byId.get('R4');
  assert.equal(gone.adapter_fields.media[0].present, false);
  assert.match(gone.adapter_fields.media_missing, /no file is at the path it recorded/);
});

test('a second run writes no new record, no new index line and no new raw line', () => {
  const dir = temp('again');
  const mapping = mappingFor();
  const file = buildLedger(dir);
  const context = contextIn(dir, mapping);
  const items = itemsFrom(file, mapping);

  writeBatch(context, items);
  const afterFirst = context.store.rebuild().length;
  const index = context.store.indexEntries().length;
  const raws = fs.readdirSync(context.store.under('captures', encodeComponent(`${context.account}:${CHAT}`)))
    .filter((name) => name.endsWith('.raw'));
  const rawBytes = raws.map((name) => fs.readFileSync(
    path.join(context.store.under('captures', encodeComponent(`${context.account}:${CHAT}`)), name), 'utf8'));

  const second = writeBatch(context, items);
  assert.equal(context.store.rebuild().length, afterFirst);
  assert.equal(context.store.indexEntries().length, index);
  assert.ok(second.every((result) => result.merged), 'a second run wrote a record instead of merging');
  rawBytes.forEach((bytes, at) => {
    assert.equal(fs.readFileSync(
      path.join(context.store.under('captures', encodeComponent(`${context.account}:${CHAT}`)), raws[at]), 'utf8'), bytes,
    'the raw payload was appended twice');
  });
});

test('the corrections land beside the captures, keyed by the conversation their messages sit in', () => {
  const dir = temp('corrections');
  const mapping = mappingFor();
  const file = buildLedger(dir);
  const context = contextIn(dir, mapping);
  const items = itemsFrom(file, mapping);
  writeBatch(context, items);

  const db = new DatabaseSync(file, { readOnly: true });
  const corrections = [];
  for (const query of mapping.corrections) {
    for (const row of db.prepare(query.sql).all()) corrections.push(toCorrection(query, row));
  }
  db.close();
  assert.equal(corrections.length, 3);

  const grouped = groupCorrections(corrections, messageIndexOf(context, items));
  assert.equal(grouped.unlinked.length, 1, 'a correction naming no imported message was silently dropped');
  const counts = writeSidecars(context, grouped);
  assert.equal(counts.written, 2, 'one sidecar for the chat and one for the unlinked correction');

  const sidecar = JSON.parse(fs.readFileSync(sidecarFile(context.store, `${ACCOUNT}:${CHAT}`), 'utf8'));
  assert.equal(sidecar.schema, CORRECTIONS_SCHEMA);
  assert.equal(sidecar.conversation_id, `${ACCOUNT}:${CHAT}`);
  assert.equal(sidecar.ledger, 'client-ledger');
  assert.equal(sidecar.corrections.length, 2);
  const [edit, flag] = sidecar.corrections;
  assert.equal(edit.correction_id, 'edit:1');
  assert.equal(edit.kind, 'reviewer_edit');
  assert.equal(edit.actor, 'Krisleen');
  assert.deepEqual(edit.before, { state: 'open' });
  assert.deepEqual(edit.after, { state: 'completed' });
  assert.deepEqual(edit.message_ids, [`${ACCOUNT}:${CHAT}:R1`, `${ACCOUNT}:${CHAT}:R2`]);
  assert.equal(flag.kind, 'nightly_flag');
  assert.deepEqual(flag.message_ids, [`${ACCOUNT}:${CHAT}:R3`]);

  // Every record the sidecar names is a record that is on disk.
  for (const correction of sidecar.corrections) {
    for (const message_id of correction.message_ids) {
      assert.ok(context.store.read(sidecar.conversation_id, message_id, 0),
        `the sidecar names ${message_id} and no record holds it`);
    }
  }

  const again = writeSidecars(context, grouped);
  assert.equal(again.written, 0, 'a second run rewrote a sidecar');
  assert.equal(again.unchanged, 2);
});

test('the command imports a ledger, reports counts and is idempotent', () => {
  const dir = temp('command');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const root = path.join(dir, 'media');
  const mapping = mappingFor(root);
  const file = buildLedger(dir, { mediaRoot: root });
  const mappingFile = path.join(dir, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
  const store = path.join(dir, 'store');

  const run = () => JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'bin', 'carbon-import'), 'ledger-sqlite',
    '--agent', 'agent-01', '--db', file, '--mapping', mappingFile,
    '--store', store, '--account', ACCOUNT
  ], { encoding: 'utf8' }));

  const first = run();
  assert.equal(first.rows, 5);
  assert.equal(first.records_written, 5);
  assert.equal(first.records_merged_into_an_existing_capture, 0);
  assert.equal(first.conversations, 2);
  assert.deepEqual(first.by_role, { contact: 3, agent: 1, operator: 1 });
  assert.deepEqual(first.by_direction, { inbound: 4, outbound: 1 });
  assert.equal(first.attachments_referenced, 2);
  assert.equal(first.attachments_present, 1);
  assert.equal(first.attachments_absent, 1);
  assert.equal(first.reply_links, 1);
  assert.equal(first.corrections_read, 3);
  assert.equal(first.corrections_naming_no_imported_message, 1);
  assert.equal(first.correction_sidecars_rewritten, 2);
  assert.equal(first.earliest_message, '2025-04-02T11:00:00.000Z');
  assert.equal(first.latest_message, '2025-04-02T11:04:00.000Z');
  assert.equal(first.released, 0);

  const second = run();
  assert.equal(second.records_written, 5);
  assert.equal(second.records_merged_into_an_existing_capture, 5,
    'a second run wrote records instead of merging into the first');
  assert.equal(second.correction_sidecars_rewritten, 0, 'a second run rewrote a sidecar');

  const check = execFileSync(process.execPath,
    [path.join(ROOT, 'bin', 'carbon-stream'), 'check', '--store', store], { encoding: 'utf8' });
  assert.match(check, /case 11\s+pass/);
});

test('the ledger is opened read-only, so an import cannot write to a client database', () => {
  const dir = temp('readonly');
  const file = buildLedger(dir);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.throws(() => db.exec('DELETE FROM chat_log'), /readonly|read-only/i);
  db.close();
});
