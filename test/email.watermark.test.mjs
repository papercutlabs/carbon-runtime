// The watermark, the re-scan a UIDVALIDITY change forces, and the poll floor.
//
// Nothing here touches a network: CARBON_EMAIL_CURL points at the shim in
// test/fixtures/curl-shim, which replays the responses in
// test/fixtures/imap-recorded, recorded from a real IMAP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import { ingest } from '../conformance/cases.mjs';
import * as adapter from '../adapters/email/index.mjs';

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

function context(recorded) {
  process.env.CARBON_EMAIL_RECORDED = recorded;
  const store = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-email-wm-')), 'store'));
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
      hold: { release_after_ms: 3600000 }
    },
    items: [],
    dry_run: true,
    now: Date.now()
  };
}

test('a position orders by uidvalidity first and then by uid, as a string', () => {
  assert.equal(adapter.positionOf(7, 12), '0000000007:0000000012');
  assert.ok(adapter.positionOf(7, 2) < adapter.positionOf(7, 10), 'uid 2 did not sort below uid 10');
  assert.ok(adapter.positionOf(7, 999) < adapter.positionOf(8, 1), 'a new uidvalidity did not sort above the old');
});

test('the poll reads from the watermark, and reads nothing twice', () => {
  const running = context(RECORDED);
  const first = adapter.poll(running);
  assert.equal(first.from_uid, 1);
  assert.equal(first.items.length, 2);
  assert.equal(first.rescanned, false);
  assert.deepEqual(first.faults, []);

  for (const one of first.items) {
    ingest(running, [one]);
    adapter.consume(running, one);
  }
  assert.equal(running.store.rebuild().length, 2);
  assert.equal(
    running.store.cursors(adapter.watermarkConversation(ACCOUNT, 'INBOX')).message,
    adapter.positionOf(1789032017, 2));

  const second = adapter.poll(running);
  assert.equal(second.from_uid, 3, 'the second poll did not start past the watermark');
  assert.equal(second.items.length, 0);
});

test('a UIDVALIDITY change re-scans, and the Message-ID dedup absorbs the re-read', () => {
  const running = context(RECORDED);
  for (const one of adapter.poll(running).items) {
    ingest(running, [one]);
    adapter.consume(running, one);
  }
  const before = running.store.rebuild().length;
  const bytes = running.store.rebuild().map((record) => JSON.stringify(record));

  process.env.CARBON_EMAIL_RECORDED = recordedAs({
    'status.txt': '* STATUS "INBOX" (UIDVALIDITY 1789032018 UIDNEXT 3 MESSAGES 2)\r\n'
  });
  const again = adapter.poll(running);
  assert.equal(again.rescanned, true, 'the renumbered mailbox was not re-scanned');
  assert.equal(again.from_uid, 1, 'the re-scan did not start at the first uid');
  assert.equal(again.items.length, 2);

  for (const one of again.items) {
    ingest(running, [one]);
    adapter.consume(running, one);
  }
  assert.equal(running.store.rebuild().length, before, 'the re-read wrote the messages a second time');
  assert.deepEqual(running.store.rebuild().map((record) => JSON.stringify(record)), bytes,
    'the re-read changed the capture bytes');
  assert.equal(
    running.store.cursors(adapter.watermarkConversation(ACCOUNT, 'INBOX')).message,
    adapter.positionOf(1789032018, 2));
});

test('a UIDVALIDITY below the one we hold is a person\'s decision, not a re-scan', () => {
  const running = context(RECORDED);
  for (const one of adapter.poll(running).items) {
    ingest(running, [one]);
    adapter.consume(running, one);
  }
  process.env.CARBON_EMAIL_RECORDED = recordedAs({
    'status.txt': '* STATUS "INBOX" (UIDVALIDITY 12 UIDNEXT 3 MESSAGES 2)\r\n'
  });
  assert.throws(() => adapter.poll(running), (error) => {
    assert.equal(error.faults[0].code, 'UIDVALIDITY_WENT_BACKWARDS');
    return true;
  });
});

test('the poll interval has a floor, and a declaration below it is refused', () => {
  assert.equal(adapter.pollIntervalMs({ poll_interval_ms: 30000 }), 30000);
  assert.equal(adapter.pollIntervalMs({ poll_interval_ms: 300000 }), 300000);
  assert.equal(adapter.POLL_INTERVAL_FLOOR_MS, 30000);
  assert.throws(() => adapter.pollIntervalMs({ poll_interval_ms: 5000 }),
    (error) => error.faults[0].code === 'POLL_INTERVAL_BELOW_FLOOR');
  assert.throws(() => adapter.pollIntervalMs({}),
    (error) => error.faults[0].code === 'POLL_INTERVAL_MISSING');
});
