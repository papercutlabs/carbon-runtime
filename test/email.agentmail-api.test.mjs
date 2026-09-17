// AgentMail REST inbound, recorded at the fetch boundary. No test reaches a
// network or reads a real credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import { ingest } from '../conformance/cases.mjs';
import { ReleaseLoop } from '../runtime/loop.mjs';
import { pollState } from '../runtime/poll.mjs';
import { fakeHarness } from './fake-harness.mjs';
import * as adapter from '../adapters/email/index.mjs';
import { AgentMailFault, readNetrcPassword } from '../adapters/email/agentmail-api.mjs';

const ACCOUNT = 'agent-01@example.test';
const API_KEY = 'am_fixture_key';
const NETRC = path.join(import.meta.dirname, 'fixtures', 'agentmail.netrc');

function netrcFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-agentmail-key-'));
  const file = path.join(dir, 'netrc');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function context() {
  return {
    store: Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-agentmail-')), 'store')),
    adapter,
    agent: 'agent-01',
    account: ACCOUNT,
    channel: {
      kind: 'email',
      account: ACCOUNT,
      inbound: 'agentmail-api',
      inbox_id: 'inbox-fixture',
      netrc: NETRC,
      imap_host: 'imap.agentmail.to',
      api_host: 'api.agentmail.to',
      agentmail_list_limit: 1,
      mailbox: 'INBOX',
      addresses: [],
      smtp_host: 'smtp.example.test',
      smtp_port: 465,
      poll_interval_ms: 30000,
      poll_failures_before_hold: 2,
      max_attachment_bytes: 1000,
      max_part_bytes: 65536,
      release: 'quiet',
      quiet_ms: 0,
      hold: { release_after_ms: 3600000 }
    },
    now: Date.parse('2026-09-16T07:00:00.000Z')
  };
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Service Unavailable', json: async () => body };
}

function fullMessage({ internalId, messageId, timestamp, from, references = [], inReplyTo = null, text, attachments = [] }) {
  const headers = {
    'Message-ID': `<${messageId}>`,
    From: from,
    To: ACCOUNT,
    Subject: 'Packing request',
    Date: timestamp
  };
  if (references.length > 0) headers.References = references.map((id) => `<${id}>`).join(' ');
  if (inReplyTo !== null) headers['In-Reply-To'] = `<${inReplyTo}>`;
  return {
    inbox_id: 'inbox-fixture',
    thread_id: 'provider-thread-id-is-not-carbon-identity',
    message_id: internalId,
    timestamp,
    from,
    to: [ACCOUNT],
    subject: 'Packing request',
    text,
    attachments,
    references,
    in_reply_to: inReplyTo,
    headers
  };
}

function recordedServer({ metadataStatus = 200, downloadStatus = 200 } = {}) {
  const asked = [];
  let empty = false;
  const first = fullMessage({
    internalId: 'provider-message-1',
    messageId: 'root@example.test',
    timestamp: '2026-09-16T06:00:00.000Z',
    from: 'Customer <customer@example.test>',
    text: 'Please pack the order.',
    attachments: [{ attachment_id: 'attachment-1', size: 4, filename: 'order.txt', content_type: 'text/plain' }]
  });
  const second = fullMessage({
    internalId: 'provider-message-2',
    messageId: 'operator@example.test',
    timestamp: '2026-09-16T06:01:00.000Z',
    from: ACCOUNT,
    references: ['root@example.test'],
    inReplyTo: 'root@example.test',
    text: 'I am taking this thread.'
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    asked.push({ url, authorization: options.headers?.authorization });
    if (url.hostname === 'cdn.agentmail.to') {
      return {
        ok: downloadStatus >= 200 && downloadStatus < 300,
        status: downloadStatus,
        statusText: downloadStatus === 200 ? 'OK' : 'Service Unavailable',
        arrayBuffer: async () => Buffer.from('file')
      };
    }
    assert.equal(options.headers.authorization, `Bearer ${API_KEY}`);
    if (url.pathname.endsWith('/attachments/attachment-1')) {
      return json({ attachment_id: 'attachment-1', download_url: 'https://cdn.agentmail.to/object?signature=fixture' }, metadataStatus);
    }
    if (url.pathname.endsWith('/provider-message-1')) return json(first);
    if (url.pathname.endsWith('/provider-message-2')) return json(second);
    if (url.pathname.endsWith('/messages')) {
      if (empty) return json({ count: 0, messages: [], limit: 1 });
      if (url.searchParams.get('page_token') === 'page-2') {
        return json({ count: 1, messages: [{ message_id: second.message_id, timestamp: second.timestamp }], limit: 1 });
      }
      return json({
        count: 1,
        messages: [{ message_id: first.message_id, timestamp: first.timestamp }],
        limit: 1,
        next_page_token: 'page-2'
      });
    }
    throw new Error(`unexpected fixture request to ${url.pathname}`);
  };
  return { asked, makeEmpty: () => { empty = true; }, restore: () => { globalThis.fetch = previous; } };
}

test('the Bearer token is the password from the declared AgentMail netrc machine', () => {
  assert.equal(readNetrcPassword(NETRC, 'imap.agentmail.to'), API_KEY);
  assert.equal(readNetrcPassword(netrcFile('machine imap.agentmail.to login "agent one" password "am key"\n'),
    'imap.agentmail.to'), 'am key');
  assert.throws(() => readNetrcPassword('/no/such/netrc', 'imap.agentmail.to'),
    (error) => error.faults[0].code === 'AGENTMAIL_NETRC_UNREADABLE');
  assert.throws(() => readNetrcPassword(netrcFile('machine smtp.agentmail.to login agent password smtp\n'), 'imap.agentmail.to'),
    (error) => error.faults[0].code === 'AGENTMAIL_NETRC_MACHINE_ABSENT');
  assert.throws(() => readNetrcPassword(netrcFile('machine imap.agentmail.to login agent\n'), 'imap.agentmail.to'),
    (error) => error.faults[0].code === 'AGENTMAIL_NETRC_PASSWORD_ABSENT');
  assert.throws(() => readNetrcPassword(netrcFile('# machine imap.agentmail.to password wrong\n'), 'imap.agentmail.to'),
    (error) => error.faults[0].code === 'AGENTMAIL_NETRC_SYNTAX_UNSUPPORTED');
  assert.throws(() => readNetrcPassword(netrcFile('machine imap.agentmail.to password "unterminated\n'), 'imap.agentmail.to'),
    (error) => error.faults[0].code === 'AGENTMAIL_NETRC_MALFORMED');
});

test('list pagination and full fetch produce the existing email capture and hold semantics', async () => {
  const running = context();
  const server = recordedServer();
  try {
    const first = await adapter.poll(running);
    assert.equal(running.channel.api_key, undefined, 'the channel carried the Bearer token as a value');
    assert.equal(first.items.length, 2);
    assert.equal(server.asked.filter((call) => call.url.pathname.endsWith('/messages')).length, 2,
      'the second list page was not read');
    assert.equal(server.asked.filter((call) => /provider-message-[12]$/.test(call.url.pathname)).length, 2,
      'the preview rows were not followed by full-message fetches');

    const written = ingest(running, adapter.listPending({ ...running, items: first.items }));
    for (const item of first.items) adapter.consume(running, item);
    assert.equal(written.length, 2);

    const contact = written[0].record;
    assert.equal(contact.body, 'Please pack the order.');
    assert.equal(contact.conversation_id, `${ACCOUNT}:root@example.test`);
    assert.notEqual(contact.conversation_id, `${ACCOUNT}:provider-thread-id-is-not-carbon-identity`);
    assert.equal(contact.attachments.length, 1);
    assert.equal(fs.readFileSync(running.store.under(contact.attachments[0].file), 'utf8'), 'file');

    const operator = written[1].record;
    assert.equal(operator.role, 'operator');
    assert.equal(operator.reply_to, 'root@example.test');
    assert.equal(operator.conversation_id, contact.conversation_id);
    assert.equal(operator.hold.release_after_ms, 3600000);
    assert.equal(running.store.isHeld(contact.conversation_id, Date.parse(operator.hold.set_at) + 1), true);

    server.makeEmpty();
    const again = await adapter.poll(running);
    assert.equal(again.items.length, 0);
    const lastList = server.asked.filter((call) => call.url.pathname.endsWith('/messages')).at(-1).url;
    assert.equal(lastList.searchParams.get('after'), '2026-09-16T06:01:00.000Z');
    assert.equal(lastList.searchParams.get('ascending'), 'true');
    assert.equal(lastList.searchParams.get('limit'), '1');
  } finally {
    server.restore();
  }
});

test('an AgentMail 5xx is one failed runtime poll cycle and reaches the existing hold counter', async () => {
  const running = context();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => json({ code: 'temporary' }, 503);
  try {
    await assert.rejects(() => adapter.poll(running), (error) => {
      assert.ok(error instanceof AgentMailFault);
      assert.equal(error.faults[0].code, 'AGENTMAIL_API_REFUSED');
      return true;
    });

    const harness = fakeHarness({ statuses: () => [] });
    const loop = new ReleaseLoop({
      declaration: { agent: { id: running.agent }, channels: [running.channel] },
      channel: running.channel,
      store: running.store,
      storeDir: running.store.dir,
      adapter,
      harness,
      session: harness.session,
      agent: running.agent,
      checkout: '/nowhere/repo',
      work: '/nowhere/work'
    });
    const result = await loop.poll();
    assert.equal(result.failures, 1);
    assert.equal(result.holding, false);
    assert.equal(pollState(running.store, ACCOUNT, 'email').consecutive_failures, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

async function rejectedAttachmentCycle(serverOptions, code) {
  const running = context();
  const server = recordedServer(serverOptions);
  try {
    const harness = fakeHarness({ statuses: () => [] });
    const loop = new ReleaseLoop({
      declaration: { agent: { id: running.agent }, channels: [running.channel] },
      channel: running.channel,
      store: running.store,
      storeDir: running.store.dir,
      adapter,
      harness,
      session: harness.session,
      agent: running.agent,
      checkout: '/nowhere/repo',
      work: '/nowhere/work'
    });
    const result = await loop.poll();
    assert.equal(result.failures, 1);
    assert.equal(result.holding, false);
    assert.equal(result.items.length, 0);
    assert.match(result.fault.problem, new RegExp(`^${code}:`));
    assert.equal(pollState(running.store, ACCOUNT, 'email').consecutive_failures, 1);
    assert.equal(pollState(running.store, ACCOUNT, 'email').holding, false);
    assert.equal(running.store.rebuild().length, 0, 'the failed poll created a capture');
    assert.equal(
      running.store.cursors(adapter.pollWatermarkConversation(running, 'INBOX')).message,
      null,
      'the failed poll advanced the AgentMail watermark'
    );
  } finally {
    server.restore();
  }
}

test('an attachment metadata 5xx fails the poll before capture or cursor movement', async () => {
  await rejectedAttachmentCycle({ metadataStatus: 503 }, 'AGENTMAIL_API_REFUSED');
});

test('a failed CDN download fails the poll before capture or cursor movement', async () => {
  await rejectedAttachmentCycle({ downloadStatus: 503 }, 'AGENTMAIL_ATTACHMENT_DOWNLOAD_REFUSED');
});
