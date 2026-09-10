import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store, StreamFault, mergeRecords } from '../stream/store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'bin', 'carbon-stream');
const ACCOUNT = 'agent-01@examplecorp.test';
const CONVERSATION = `${ACCOUNT}:room-7`;

function open() {
  return Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-store-')), 'store'));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function inbound(overrides = {}) {
  return {
    schema: 'carbon.message.v1',
    agent: 'agent-01',
    source: 'email',
    account: ACCOUNT,
    conversation_id: CONVERSATION,
    conversation_kind: 'direct',
    message_id: `${CONVERSATION}:m-0001`,
    platform_message_id: 'm-0001',
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: 'ada@examplecorp.test',
    received_at: '2026-09-10T09:00:00.000Z',
    body: 'the first body',
    attachments: [],
    historical: false,
    disposition: 'captured',
    ...overrides
  };
}

function outbound(overrides = {}) {
  return inbound({
    message_id: `${CONVERSATION}:out-0001`,
    platform_message_id: 'out-0001',
    direction: 'outbound',
    role: 'agent',
    sender_id: ACCOUNT,
    body: 'the reply',
    delivery: { request_id: 'req-0001', status: 'pending', text_sha256: sha256('the reply') },
    ...overrides
  });
}

function faultCodes(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof StreamFault, `expected a StreamFault, got ${error}`);
    return error.faults.map((f) => f.code);
  }
  throw new assert.AssertionError({ message: 'nothing was refused' });
}

test('the store is 0700, a record is 0600 and an attachment carries no execute bit', () => {
  const store = open();
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  const record = inbound();
  const attachment = store.putAttachment(record, Buffer.from('a report'), { mime: 'text/plain' });
  const written = store.capture({ ...record, attachments: [attachment] }, { raw: 'raw payload' });
  assert.equal(fs.statSync(written.file).mode & 0o777, 0o600);
  const file = store.under(attachment.file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).mode & 0o111, 0);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('the request_id fence: sent returns the stored chunk ids, pending and unknown are refused', () => {
  const store = open();
  store.capture(inbound());

  const first = store.reply(outbound());
  assert.equal(first.record.delivery.status, 'pending');

  assert.deepEqual(faultCodes(() => store.reply(outbound())), ['REQUEST_ALREADY_PENDING']);

  store.markSent('req-0001', ['chunk-a', 'chunk-b']);
  const fenced = store.reply(outbound());
  assert.equal(fenced.fenced, 'sent');
  assert.deepEqual(fenced.chunk_ids, ['chunk-a', 'chunk-b']);
  assert.equal(store.rebuild().filter((r) => r.direction === 'outbound').length, 1);

  store.markUnknown('req-0001');
  assert.deepEqual(faultCodes(() => store.reply(outbound())), ['DELIVERY_UNKNOWN_NEVER_RETRIED']);
});

test('a record write that throws still advances the cursor and leaves the raw payload behind', () => {
  const store = open();
  const record = inbound();
  const places = store.paths(record);
  fs.mkdirSync(places.conversationDir, { recursive: true, mode: 0o700 });
  // A directory where the record file belongs: the record write cannot land.
  fs.mkdirSync(places.record, { mode: 0o700 });
  fs.writeFileSync(path.join(places.record, 'in the way'), 'x');

  assert.throws(() => store.capture(record, { raw: 'the payload', cursor: { kind: 'message', position: '0001' } }));
  assert.equal(store.cursors(CONVERSATION).message, '0001', 'the cursor did not advance');
  assert.ok(fs.existsSync(places.raw), 'the raw payload is not there to recover from');
  assert.equal(fs.readFileSync(places.raw, 'utf8'), 'the payload\n');
});

test('a repeated write merges: the first body wins and attachments union by sha256', () => {
  const first = inbound({ attachments: [{ file: 'a', mime: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) }] });
  const second = inbound({
    body: 'a later body',
    attachments: [{ file: 'b', mime: 'text/plain', bytes: 1, sha256: 'b'.repeat(64) }]
  });

  const forwards = open();
  forwards.capture(first);
  const merged = forwards.capture(second);
  assert.equal(merged.record.body, 'the first body');
  assert.deepEqual(merged.record.attachments.map((a) => a.sha256).sort(), ['a'.repeat(64), 'b'.repeat(64)]);

  const backwards = open();
  backwards.capture(second);
  const other = backwards.capture(first);
  assert.deepEqual(
    other.record.attachments.map((a) => a.sha256).sort(),
    merged.record.attachments.map((a) => a.sha256).sort(),
    'the attachment union depends on the order the writes arrived');

  // A third write of what is already there changes no bytes.
  const before = fs.readFileSync(merged.file, 'utf8');
  forwards.capture(second);
  assert.equal(fs.readFileSync(merged.file, 'utf8'), before);
  assert.deepEqual(mergeRecords(merged.record, merged.record).attachments, merged.record.attachments);
});

test('a live store passes the rebuild against the index through the command', () => {
  const store = open();
  store.capture(inbound(), { raw: 'one' });
  store.capture(inbound({ message_id: `${CONVERSATION}:m-0002`, platform_message_id: 'm-0002' }), { raw: 'two' });
  const out = execFileSync(process.execPath, [CHECK, 'check', '--store', store.dir], { encoding: 'utf8' });
  assert.match(out, /case 11  pass/);

  // A record written past the store library is a record the index does not name.
  const stray = store.paths(inbound({ message_id: `${CONVERSATION}:m-0003`, platform_message_id: 'm-0003' }));
  fs.writeFileSync(stray.record, JSON.stringify(inbound({
    message_id: `${CONVERSATION}:m-0003`, platform_message_id: 'm-0003'
  })));
  assert.throws(() => execFileSync(process.execPath, [CHECK, 'check', '--store', store.dir], { encoding: 'utf8' }));
});

test('a thread file is written per unit of work, named by the unit id', () => {
  const store = open();
  store.writeThread('case-4711', { thread_id: 'thread-1', started_at: '2026-09-10T09:00:00.000Z' });
  assert.equal(store.readThread('case-4711').thread_id, 'thread-1');
  assert.equal(store.readThread('case-4712'), null);
});

test('there is no delete path: the store library exposes none', () => {
  const store = open();
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
    assert.doesNotMatch(name, /delete|remove|expire|drop/i, `${name} is a way to lose a client's record`);
  }
});
