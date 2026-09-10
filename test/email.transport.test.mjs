// The transport, and the three outcomes a send can have.
//
// Nothing here touches a network either: the same shim replays the recorded
// responses, and a recorded exit code is how a timeout or a refused login is
// put in front of the adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StreamFault } from '../stream/store.mjs';
import { ingest } from '../conformance/cases.mjs';
import * as adapter from '../adapters/email/index.mjs';
import { listMailboxes } from '../adapters/email/curl.mjs';

const HERE = import.meta.dirname;
const SHIM = path.join(HERE, 'fixtures', 'curl-shim', 'curl');
const RECORDED = path.join(HERE, 'fixtures', 'imap-recorded');
const ACCOUNT = 'agent-01@example.test';

process.env.CARBON_EMAIL_CURL = SHIM;

function recordedAs(changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-email-recorded-'));
  for (const name of fs.readdirSync(RECORDED)) fs.copyFileSync(path.join(RECORDED, name), path.join(dir, name));
  for (const [name, content] of Object.entries(changes)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

function context(recorded = RECORDED, channel = {}) {
  process.env.CARBON_EMAIL_RECORDED = recorded;
  const store = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-email-tx-')), 'store'));
  return {
    store, adapter,
    agent: 'agent-01',
    account: ACCOUNT,
    channel: {
      mailbox: 'INBOX',
      imap_host: 'imap.example.test',
      imap_port: 993,
      smtp_host: 'smtp.example.test',
      smtp_port: 465,
      netrc: '/nowhere/netrc',
      poll_interval_ms: 30000,
      max_attachment_bytes: 1000,
      max_part_bytes: 65536,
      hold: { release_after_ms: 3600000 },
      ...channel
    },
    items: [],
    dry_run: false,
    now: Date.now()
  };
}

// Capture the recorded probe, which is the inbound this conversation is
// answered on, and return the reply the store fenced.
function pending(running, { request_id = 'req-1', text = 'an answer' } = {}) {
  const item = adapter.poll(running).items[0];
  const [inbound] = ingest(running, [item]);
  adapter.consume(running, item);
  const conversation_id = inbound.record.conversation_id;
  return {
    inbound: inbound.record,
    written: running.store.reply({
      schema: 'carbon.message.v1',
      agent: 'agent-01',
      source: 'email',
      account: ACCOUNT,
      conversation_id,
      conversation_kind: 'thread',
      message_id: `${conversation_id}:${request_id}`,
      platform_message_id: request_id,
      revision: 0,
      direction: 'outbound',
      role: 'agent',
      sender_id: ACCOUNT,
      received_at: new Date().toISOString(),
      body: text,
      attachments: [],
      historical: false,
      disposition: 'captured',
      delivery: {
        request_id,
        status: 'pending',
        text_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
      }
    })
  };
}

test('the mailboxes come back as names', () => {
  process.env.CARBON_EMAIL_RECORDED = RECORDED;
  assert.deepEqual(
    listMailboxes({ netrc: '/nowhere/netrc', host: 'imap.example.test' }),
    ['INBOX', 'Sent', 'Drafts', 'Archive', 'Trash', 'Spam']);
});

test('the outbound record is on disk as pending before the transport is called', () => {
  const running = context();
  const { written } = pending(running);
  const onDisk = running.store.read(written.record.conversation_id, written.record.message_id, 0);
  assert.equal(onDisk.delivery.status, 'pending');
  assert.equal(onDisk.delivery.chunk_ids, undefined);

  const sent = adapter.send(running, onDisk);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.chunk_ids.length, 1);
  const settled = running.store.markSent('req-1', sent.chunk_ids);
  assert.deepEqual(settled.delivery.chunk_ids, sent.chunk_ids);
});

test('a reply past the part size goes as a series, and every Message-ID is a chunk id', () => {
  const running = context(RECORDED, { max_part_bytes: 120 });
  const text = Array.from({ length: 8 }, (_, i) => `line ${i} of a reply that is longer than one part`).join('\n');
  const { written } = pending(running, { text });
  const sent = adapter.send(running, written.record);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.chunk_ids.length >= 3, `expected a split reply, got ${sent.chunk_ids.length} part`);
  assert.equal(new Set(sent.chunk_ids).size, sent.chunk_ids.length, 'two parts share a Message-ID');
});

test('a send whose acceptance the server did not confirm lands unknown and is never retried', () => {
  const running = context(recordedAs({ 'send.exit': '28\n' }));
  const { written } = pending(running);
  const sent = adapter.send(running, written.record);
  assert.equal(sent.status, 'unknown');
  assert.deepEqual(sent.chunk_ids, []);

  running.store.markUnknown('req-1');
  assert.throws(() => running.store.reply(written.record), (error) => {
    assert.ok(error instanceof StreamFault);
    assert.equal(error.faults[0].code, 'DELIVERY_UNKNOWN_NEVER_RETRIED');
    return true;
  });
});

test('a send that never reached the server is failed, which is a different thing', () => {
  const running = context(recordedAs({ 'send.exit': '7\n' }));
  const { written } = pending(running);
  const sent = adapter.send(running, written.record);
  assert.equal(sent.status, 'failed');
  const settled = running.store.markFailed('req-1');
  assert.equal(settled.delivery.status, 'failed');
});

test('a dry run touches no transport at all', () => {
  const running = context();
  const { written } = pending(running);
  const previous = process.env.CARBON_EMAIL_CURL;
  process.env.CARBON_EMAIL_CURL = path.join(HERE, 'fixtures', 'curl-shim', 'no-such-curl');
  try {
    const sent = adapter.send({ ...running, dry_run: true }, written.record);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.chunk_ids.length, 1);
  } finally {
    process.env.CARBON_EMAIL_CURL = previous;
  }
});

test('an item is matched to the delivery record that names its Message-ID', () => {
  const running = context();
  const items = adapter.poll(running).items;
  const read = adapter.readItem(running, items[0]);
  assert.equal(adapter.matchesDelivery(running, items[0], { chunk_ids: [read.platform_message_id] }), true);
  assert.equal(adapter.matchesDelivery(running, items[0], { chunk_ids: ['someone-elses@example.test'] }), false);
});
