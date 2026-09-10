// The history import, end to end through the command.
//
// What matters about an import is not that it writes records; it is what it does
// not do. It releases nothing. It changes nothing a live capture already wrote.
// It leaves the live adapter's cursors where they were. And run twice it changes
// no byte of any capture, so a person who is not sure whether the import ran can
// simply run it again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../stream/store.mjs';
import { learnPairs, writeConnectionState } from '../adapters/whatsapp/channel-state.mjs';
import { chatKeyFor, mimeOf } from '../import/carbon-capture-whatsapp.mjs';
import { buildExport, buildZip } from './zip-writer.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND = path.join(ROOT, 'bin', 'carbon-import');

const AGENT = 'agent-01';
const ACCOUNT = '15550009999@s.whatsapp.net';
const PHONE = '15550001111@s.whatsapp.net';
const LID = '189234567890123@lid';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-import-'));
  return { dir, storeDir: path.join(dir, 'store') };
}

function row(id, text, extra = {}) {
  return {
    chat_jid: extra.chat_jid ?? PHONE,
    chat_name: 'Ada',
    message_id: id,
    sender_jid: extra.from_me ? null : PHONE,
    sender_name: extra.from_me ? null : 'Ada',
    text,
    message_type: extra.message_type ?? 'chat',
    from_me: extra.from_me === true,
    timestamp: extra.timestamp ?? '2025-04-02T11:00:00.000Z',
    has_media: extra.has_media === true,
    ...(extra.media_filename ? { media_filename: extra.media_filename } : {})
  };
}

function runImport(storeDir, zipPath, extra = []) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [
        COMMAND, 'whatsapp', '--agent', AGENT, '--export', zipPath, '--store', storeDir, ...extra
      ], { encoding: 'utf8' })
    };
  } catch (error) {
    return { code: error.status, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

function writeExport(dir, rows, media = {}) {
  const file = path.join(dir, 'wa-export.zip');
  fs.writeFileSync(file, buildExport(rows, media));
  return file;
}

// Every capture file with its digest, so "changed no byte" is a comparison and
// not a claim.
function captureDigests(storeDir) {
  const root = path.join(storeDir, 'captures');
  const found = {};
  const walk = (at) => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else found[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return found;
}

test('every row becomes one historical record, and nothing is released', () => {
  const { dir, storeDir } = scratch();
  const rows = [
    row('false_c_9001', 'We spoke about the August invoice last spring.'),
    row('true_c_9002', 'And I said I would send the usage report.', { from_me: true }),
    row('false_c_9003', 'The report never arrived.')
  ];
  const result = runImport(storeDir, writeExport(dir, rows), ['--account', ACCOUNT]);
  assert.equal(result.code, 0, result.out);

  const summary = JSON.parse(result.out);
  assert.equal(summary.rows, 3);
  assert.equal(summary.records_written, 3);
  assert.equal(summary.released, 0);

  const store = new Store(storeDir);
  const written = store.rebuild();
  assert.equal(written.length, rows.length, 'N records for an export of N rows');
  for (const record of written) {
    assert.equal(record.historical, true);
    assert.equal(record.source, 'import:carbon-capture');
    assert.equal(record.delivery, undefined);
    assert.equal(record.release, undefined);
    assert.throws(
      () => store.release(record, { released_at: 'now', thread_id: 't', turn_id: 'u' }),
      (error) => error.faults[0].code === 'HISTORICAL_NEVER_RELEASES'
    );
  }
  // And the live adapter's cursors were not moved, so it will not skip anything.
  assert.equal(fs.readdirSync(path.join(storeDir, 'cursors')).length, 0);
});

test('every field is a rename, and what the schema does not name is carried beside it', () => {
  const { dir, storeDir } = scratch();
  const rows = [row('false_c_9001', 'The invoice again.', { message_type: 'chat' })];
  assert.equal(runImport(storeDir, writeExport(dir, rows), ['--account', ACCOUNT]).code, 0);

  const [record] = new Store(storeDir).rebuild();
  assert.equal(record.conversation_id, `${ACCOUNT}:${PHONE}`);
  assert.equal(record.message_id, `${ACCOUNT}:${PHONE}:false_c_9001`);
  assert.equal(record.platform_message_id, 'false_c_9001');
  assert.equal(record.body, 'The invoice again.');
  assert.equal(record.sender_id, PHONE);
  assert.equal(record.sender_name, 'Ada');
  assert.equal(record.sent_at, '2025-04-02T11:00:00.000Z');
  assert.equal(record.received_at, '2025-04-02T11:00:00.000Z');
  assert.equal(record.conversation_kind, 'direct');
  assert.equal(record.direction, 'inbound');
  assert.equal(record.role, 'contact');
  assert.equal(record.adapter_fields.chat_name, 'Ada');
  assert.equal(record.adapter_fields.message_type, 'chat');
  // A history import sets no hold: an operator's message from last spring must
  // not stop the agent today.
  assert.equal(record.hold, undefined);
});

test('media in the archive lands beside its record, under its own digest', () => {
  const { dir, storeDir } = scratch();
  const picture = 'the bytes of a photograph';
  const rows = [row('false_c_9001', 'The damaged corner.', {
    has_media: true, media_filename: 'media/false_c_9001.jpg'
  })];
  assert.equal(runImport(storeDir, writeExport(dir, rows, { 'media/false_c_9001.jpg': picture }),
    ['--account', ACCOUNT]).code, 0);

  const store = new Store(storeDir);
  const [record] = store.rebuild();
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].mime, 'image/jpeg');
  assert.equal(record.attachments[0].sha256, crypto.createHash('sha256').update(picture).digest('hex'));
  assert.ok(store.attachmentIntact(record.attachments[0]));
  // The archive's own name for the file is not the name it is stored under.
  assert.equal(path.basename(record.attachments[0].file), record.attachments[0].sha256);
});

test('a row whose media the archive does not carry says so, and is written anyway', () => {
  const { dir, storeDir } = scratch();
  const rows = [row('false_c_9001', 'The scan.', { has_media: true, media_filename: 'media/gone.jpg' })];
  const result = runImport(storeDir, writeExport(dir, rows), ['--account', ACCOUNT]);
  assert.equal(result.code, 0, result.out);
  assert.equal(JSON.parse(result.out).media_the_export_did_not_carry, 1);
  const [record] = new Store(storeDir).rebuild();
  assert.deepEqual(record.attachments, []);
  assert.match(record.adapter_fields.media_missing, /media/);
});

test('a re-run changes no capture byte', () => {
  const { dir, storeDir } = scratch();
  const rows = [
    row('false_c_9001', 'One.'),
    row('false_c_9002', 'Two.', { has_media: true, media_filename: 'media/two.jpg' })
  ];
  const zip = writeExport(dir, rows, { 'media/two.jpg': 'a photograph' });
  assert.equal(runImport(storeDir, zip, ['--account', ACCOUNT]).code, 0);
  const before = captureDigests(storeDir);

  const second = runImport(storeDir, zip, ['--account', ACCOUNT]);
  assert.equal(second.code, 0, second.out);
  assert.equal(JSON.parse(second.out).records_merged_into_an_existing_capture, 2);
  assert.deepEqual(captureDigests(storeDir), before, 'a second run rewrote a capture');
  assert.equal(new Store(storeDir).rebuild().length, 2, 'a second run wrote the records again');
});

test('a phone-keyed export joins the conversations the live adapter keyed by linked id', () => {
  const { dir, storeDir } = scratch();
  const store = Store.open(storeDir);
  learnPairs(store, ACCOUNT, [{ phone: PHONE, lid: LID }]);

  assert.deepEqual(chatKeyFor({ chat_jid: PHONE }, { phone_to_lid: { [PHONE]: LID } }), { key: LID, note: null });

  const rows = [row('false_c_9001', 'From before the agent existed.')];
  assert.equal(runImport(storeDir, writeExport(dir, rows), ['--account', ACCOUNT]).code, 0);

  const [record] = store.rebuild();
  assert.equal(record.conversation_id, `${ACCOUNT}:${LID}`, 'the export did not join the live conversation');
  assert.equal(record.adapter_fields.chat_key_note, undefined);
});

test('a chat with no known linked-id form is kept under its phone key, and says so', () => {
  const { dir, storeDir } = scratch();
  const rows = [row('false_c_9001', 'A chat the agent has never seen live.')];
  assert.equal(runImport(storeDir, writeExport(dir, rows), ['--account', ACCOUNT]).code, 0);
  const [record] = new Store(storeDir).rebuild();
  assert.equal(record.conversation_id, `${ACCOUNT}:${PHONE}`);
  assert.match(record.adapter_fields.chat_key_note, /phone number/);
});

test('where a live capture already exists, it wins on every field and only gains attachments', () => {
  const { dir, storeDir } = scratch();
  const store = Store.open(storeDir);
  const conversation_id = `${ACCOUNT}:${LID}`;
  learnPairs(store, ACCOUNT, [{ phone: PHONE, lid: LID }]);

  const live = {
    schema: 'carbon.message.v1',
    agent: AGENT,
    source: 'whatsapp',
    account: ACCOUNT,
    conversation_id,
    conversation_kind: 'direct',
    message_id: `${conversation_id}:false_c_9001`,
    platform_message_id: 'false_c_9001',
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: LID,
    received_at: '2026-09-10T09:00:00.000Z',
    body: 'what the live adapter captured',
    attachments: [],
    historical: false,
    disposition: 'captured'
  };
  store.capture(live);

  const rows = [row('false_c_9001', 'what the export says instead', {
    has_media: true, media_filename: 'media/one.jpg'
  })];
  assert.equal(runImport(storeDir, writeExport(dir, rows, { 'media/one.jpg': 'a photograph' }),
    ['--account', ACCOUNT]).code, 0);

  const kept = store.read(conversation_id, live.message_id, 0);
  assert.equal(kept.body, 'what the live adapter captured', 'the import overwrote a live capture');
  assert.equal(kept.historical, false, 'the import made a live capture historical');
  assert.equal(kept.source, 'whatsapp');
  assert.equal(kept.attachments.length, 1, 'the import did not add its attachment');
  assert.equal(store.rebuild().length, 1);
});

test('the account is read from the store when the store names one, and asked for when it does not', () => {
  const { dir, storeDir } = scratch();
  const zip = writeExport(dir, [row('false_c_9001', 'One.')]);

  const refused = runImport(storeDir, zip);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /ACCOUNT_UNDETERMINED/);

  writeConnectionState(Store.open(storeDir), ACCOUNT, 'open');
  const found = runImport(storeDir, zip);
  assert.equal(found.code, 0, found.out);
  assert.equal(JSON.parse(found.out).account, ACCOUNT);
});

test('an archive carrying an entry outside media imports nothing at all', () => {
  const { dir, storeDir } = scratch();
  const file = path.join(dir, 'hostile.zip');
  // An ordinary export, with one extra entry that walks out of it.
  fs.writeFileSync(file, buildZip([
    { name: 'messages.json', data: JSON.stringify([row('false_c_9001', 'One.')]) },
    { name: '../../etc/passwd', data: 'not yours' }
  ]));

  const result = runImport(storeDir, file, ['--account', ACCOUNT]);
  assert.equal(result.code, 1);
  assert.match(result.out, /ZIP_ENTRY_OUTSIDE_MEDIA/);
  assert.equal(fs.existsSync(path.join(storeDir, 'captures')) ? new Store(storeDir).rebuild().length : 0, 0);
});

test('every argument is explicit, and the manual is the help', () => {
  const help = execFileSync(process.execPath, [COMMAND, '--help'], { encoding: 'utf8' });
  assert.match(help, /--agent <id>/);
  assert.match(help, /--export <zip>/);
  assert.match(help, /--store <dir>/);
  assert.match(help, /historical/);

  const missing = runImport('', '');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /MISSING_ARGUMENT|EXPORT_MISSING/);
});

test('the extension an export gives a file is what says what the bytes are', () => {
  assert.equal(mimeOf('media/one.jpg'), 'image/jpeg');
  assert.equal(mimeOf('media/one.pdf'), 'application/pdf');
  assert.equal(mimeOf('media/one.opus'), 'audio/opus');
  assert.equal(mimeOf('media/one.unheard-of'), 'application/octet-stream');
});
