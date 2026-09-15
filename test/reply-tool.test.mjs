import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StreamFault } from '../stream/store.mjs';
import { replyHandler } from '../runtime/reply-tool.mjs';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const CONVERSATION = `${ACCOUNT}:c1`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-reply-'));
  const store = Store.open(path.join(dir, 'store'));
  store.capture({
    schema: 'carbon.message.v1',
    agent: AGENT,
    source: 'telegram',
    account: ACCOUNT,
    conversation_id: CONVERSATION,
    conversation_kind: 'group',
    message_id: `${CONVERSATION}:1`,
    platform_message_id: '1',
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: '276672685',
    received_at: '2026-09-15T10:00:00.000Z',
    body: 'packet',
    attachments: [],
    historical: false,
    disposition: 'captured'
  });
  return { dir, store, handle: replyHandler({ store, agent: AGENT }) };
}

function pdfBytes() {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
}

test('a reply with a PDF attachment writes a pending record the adapter would send', () => {
  const { dir, store, handle } = setup();
  const file = path.join(dir, 'bor.pdf');
  fs.writeFileSync(file, pdfBytes());
  const result = handle({
    conversation_id: CONVERSATION,
    request_id: 'r-pdf',
    text: 'BOR attached.',
    attachments: [file]
  });
  assert.equal(result.data.status, 'written');
  const outbound = store.rebuild().find((r) => r.direction === 'outbound');
  assert.equal(outbound.delivery.status, 'pending');
  assert.equal(outbound.body, 'BOR attached.');
  assert.equal(outbound.attachments.length, 1);
  assert.equal(outbound.attachments[0].mime, 'application/pdf');
  assert.equal(outbound.attachments[0].filename, 'bor.pdf');
  const onDisk = store.under(outbound.attachments[0].file);
  assert.equal(fs.existsSync(onDisk), true);
  assert.equal(fs.readFileSync(onDisk).slice(0, 5).toString(), '%PDF-');
});

test('a reply without attachments still writes text only', () => {
  const { store, handle } = setup();
  handle({
    conversation_id: CONVERSATION,
    request_id: 'r-text',
    text: 'missing page 10'
  });
  const outbound = store.rebuild().find((r) => r.direction === 'outbound');
  assert.equal(outbound.delivery.status, 'pending');
  assert.deepEqual(outbound.attachments, []);
  assert.equal(outbound.body, 'missing page 10');
});

test('a missing attachment file is a fault with a fix', () => {
  const { handle } = setup();
  try {
    handle({
      conversation_id: CONVERSATION,
      request_id: 'r-missing',
      text: 'BOR attached.',
      attachments: ['/tmp/carbon-reply-does-not-exist.pdf']
    });
  } catch (error) {
    assert.ok(error instanceof StreamFault);
    assert.equal(error.faults[0].code, 'ATTACHMENT_MISSING');
    assert.ok(error.faults[0].fix);
    return;
  }
  throw new assert.AssertionError({ message: 'missing file was not refused' });
});
