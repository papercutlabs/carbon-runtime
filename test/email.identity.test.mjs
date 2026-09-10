// Identity, threading, roles and the two refusals that decide who gets answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StreamFault } from '../stream/store.mjs';
import { ingest } from '../conformance/cases.mjs';
import * as adapter from '../adapters/email/index.mjs';
import { TransportFault } from '../adapters/email/curl.mjs';

const ACCOUNT = 'agent-01@example.test';

function context(overrides = {}) {
  const store = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-email-id-')), 'store'));
  return {
    store, adapter,
    agent: 'agent-01',
    account: ACCOUNT,
    channel: {
      mailbox: 'INBOX',
      imap_host: 'imap.example.test',
      smtp_host: 'smtp.example.test',
      netrc: '/nowhere/netrc',
      addresses: ['billing@example.test'],
      poll_interval_ms: 30000,
      max_attachment_bytes: 1000,
      max_part_bytes: 65536,
      hold: { release_after_ms: 3600000 },
      ...(overrides.channel ?? {})
    },
    items: [],
    dry_run: true,
    now: Date.parse('2026-09-10T10:00:00.000Z'),
    ...overrides
  };
}

let uid = 0;
function item({ id, subject = 'August invoice', from = 'Ada Vance <ada@example.test>', to = ACCOUNT, references, inReplyTo, supersedes, origin, body = 'a body' }) {
  uid += 1;
  const lines = [`Delivered-To: ${to}`, `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}>`];
  if (references) lines.push(`References: ${references.map((r) => `<${r}>`).join(' ')}`);
  if (inReplyTo) lines.push(`In-Reply-To: <${inReplyTo}>`);
  if (supersedes) lines.push(`Supersedes: <${supersedes}>`);
  if (origin) lines.push(`X-Carbon-Origin: ${origin}`);
  lines.push('Date: Thu, 10 Sep 2026 09:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body);
  return { mailbox: 'INBOX', uidvalidity: 7, uid, position: adapter.positionOf(7, uid), rfc822: lines };
}

test('the conversation is the References root, and never the subject', () => {
  const running = context();
  const [first] = ingest(running, [item({ id: 'root-a@example.test' })]);
  const [second] = ingest(running, [item({
    id: 'reply-a@example.test', subject: 'Re: August invoice', references: ['root-a@example.test']
  })]);
  assert.equal(first.record.conversation_id, `${ACCOUNT}:root-a@example.test`);
  assert.equal(second.record.conversation_id, first.record.conversation_id);
  assert.equal(second.record.message_id, `${ACCOUNT}:root-a@example.test:reply-a@example.test`);

  // The same subject, a different exchange: one subject, two conversations.
  const [stranger] = ingest(running, [item({ id: 'root-b@example.test', subject: 'August invoice' })]);
  assert.notEqual(stranger.record.conversation_id, first.record.conversation_id);
});

test('a message that starts a thread is its own root', () => {
  const running = context();
  const [first] = ingest(running, [item({ id: 'alone@example.test' })]);
  assert.equal(first.record.conversation_id, `${ACCOUNT}:alone@example.test`);
  assert.equal(first.record.message_id, `${ACCOUNT}:alone@example.test:alone@example.test`);
  assert.equal(first.record.platform_message_id, 'alone@example.test');
});

test('a stranger is a contact, a person at our own mailbox is the operator and holds the agent', () => {
  const running = context();
  const [contact] = ingest(running, [item({ id: 'root-c@example.test' })]);
  assert.equal(contact.record.role, 'contact');
  assert.equal(contact.record.hold, undefined);

  const [operator] = ingest(running, [item({
    id: 'op-c@example.test', from: ACCOUNT, to: 'ada@example.test',
    references: ['root-c@example.test']
  })]);
  assert.equal(operator.record.role, 'operator');
  assert.equal(operator.record.direction, 'inbound');
  assert.equal(operator.record.hold.release_after_ms, 3600000);
  assert.equal(running.store.isHeld(contact.record.conversation_id, Date.parse(operator.record.hold.set_at) + 1), true);
});

test('the agent\'s own sent mail, coming back, is the agent and holds nothing', () => {
  const running = context();
  ingest(running, [item({ id: 'root-d@example.test' })]);
  const [own] = ingest(running, [item({
    id: 'ours-d@example.test', from: ACCOUNT, to: 'ada@example.test',
    references: ['root-d@example.test'], origin: 'agent'
  })]);
  assert.equal(own.record.role, 'agent');
  assert.equal(own.record.direction, 'outbound');
  assert.equal(own.record.hold, undefined);
});

test('an inbound to an address this agent does not declare is captured and never answered', () => {
  const running = context();
  const [stray] = ingest(running, [item({
    id: 'stray@example.test', to: 'someone-else@example.test'
  })]);
  assert.equal(stray.record.disposition, 'policy-drop');
  assert.ok(fs.existsSync(stray.file), 'the message was not kept');

  const reply = {
    ...replyShape(stray.record),
    reply_to: 'stray@example.test'
  };
  const written = running.store.reply(reply);
  assert.throws(() => adapter.send(running, written.record), (error) => {
    assert.ok(error instanceof TransportFault);
    assert.equal(error.faults[0].code, 'INBOUND_TO_UNDECLARED_ADDRESS');
    return true;
  });

  // A declared second address of the same mailbox is answered.
  const [declared] = ingest(running, [item({ id: 'billing@example.test', to: 'billing@example.test' })]);
  assert.equal(declared.record.disposition, 'captured');
});

test('a reply on a conversation this agent never captured is refused by name', () => {
  const running = context();
  ingest(running, [item({ id: 'root-e@example.test' })]);
  const foreign = replyShape({ conversation_id: `${ACCOUNT}:nobody-wrote-here@example.test`, account: ACCOUNT });
  assert.throws(() => running.store.reply(foreign), (error) => {
    assert.ok(error instanceof StreamFault);
    assert.equal(error.faults[0].code, 'CONVERSATION_NOT_OWNED');
    return true;
  });
});

test('a reply carries In-Reply-To and References from the inbound, not from the subject', () => {
  const running = context();
  ingest(running, [item({ id: 'root-f@example.test' })]);
  const [second] = ingest(running, [item({
    id: 'reply-f@example.test', subject: 'Re: August invoice', references: ['root-f@example.test']
  })]);
  const references = adapter.referencesFor(second.record);
  assert.deepEqual(references, ['root-f@example.test', 'reply-f@example.test']);
  const built = adapter.buildMessage({
    from: ACCOUNT, to: ['ada@example.test'], subject: 'Re: August invoice',
    messageId: 'ours@example.test', inReplyTo: second.record.platform_message_id,
    references, date: new Date(0), body: 'answered', origin: 'agent'
  });
  assert.match(built, /\r\nIn-Reply-To: <reply-f@example\.test>\r\n/);
  assert.match(built, /\r\nReferences: <root-f@example\.test> <reply-f@example\.test>\r\n/);
  assert.match(built, /\r\nX-Carbon-Origin: agent\r\n/);
});

test('a message this adapter builds says who sent it, and guesses nothing', () => {
  assert.throws(() => adapter.buildMessage({
    from: ACCOUNT, to: ['ada@example.test'], subject: 'x', messageId: 'y@example.test',
    date: new Date(0), body: 'z'
  }), (error) => error.faults[0].code === 'SEND_ORIGIN_MISSING');
});

test('a supersede is a revision of what it corrects, and never an overwrite', () => {
  const running = context();
  const [first] = ingest(running, [item({ id: 'root-g@example.test', body: 'two lines' })]);
  const before = fs.readFileSync(first.file, 'utf8');
  const [correction] = ingest(running, [item({
    id: 'fix-g@example.test', references: ['root-g@example.test'],
    supersedes: 'root-g@example.test', body: 'three lines'
  })]);
  assert.equal(correction.record.revision, 1);
  assert.equal(correction.record.message_id, first.record.message_id);
  assert.equal(fs.readFileSync(first.file, 'utf8'), before);
  assert.equal(running.store.rebuild().length, 2);
});

function replyShape(inbound) {
  return {
    schema: 'carbon.message.v1',
    agent: 'agent-01',
    source: 'email',
    account: inbound.account,
    conversation_id: inbound.conversation_id,
    conversation_kind: 'thread',
    message_id: `${inbound.conversation_id}:req-1`,
    platform_message_id: 'req-1',
    revision: 0,
    direction: 'outbound',
    role: 'agent',
    sender_id: ACCOUNT,
    received_at: '2026-09-10T10:00:00.000Z',
    body: 'an answer',
    attachments: [],
    historical: false,
    disposition: 'captured',
    delivery: { request_id: 'req-1', status: 'pending', text_sha256: 'a'.repeat(64) }
  };
}
