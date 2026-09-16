// The poll: the loop going to the channel rather than being handed its items.
//
// Nothing here touches a network. The adapters that fail on purpose are written
// in this file, and the one real adapter tested through the loop is the email
// adapter with CARBON_EMAIL_CURL pointing at the shim, which replays responses
// recorded from a real IMAP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.mjs';
import { ReleaseLoop } from '../runtime/loop.mjs';
import { run } from '../runtime/index.mjs';
import { resolveChannel } from '../runtime/channel.mjs';
import {
  POLL_FAILURES_BEFORE_HOLD, failuresBeforeHold, pollIntervalFor, pollState
} from '../runtime/poll.mjs';
import { readChannelState } from '../runtime/channel-state.mjs';
import { replyHandler } from '../runtime/reply-tool.mjs';
import { fakeHarness } from './fake-harness.mjs';
import * as fixture from '../adapters/fixture/index.mjs';
import * as email from '../adapters/email/index.mjs';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const HERE = import.meta.dirname;

process.env.CARBON_EMAIL_CURL = path.join(HERE, 'fixtures', 'curl-shim', 'curl');

const REPLY_LISTED = () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }];

function declaration(channel = {}) {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [
      { name: 'mailbox_netrc', path: '/nowhere/netrc', purpose: 'the mailbox credential' }
    ],
    tool_servers: [],
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'immediate', poll_interval_ms: 1000, ...channel }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

// The model answers by calling the reply tool, because a turn that does not is a
// turn the runtime follows up on, and these tests are about the poll rather than
// about that rule.
function answering(store) {
  const handle = replyHandler({ store, agent: AGENT });
  return (session, params) => {
    handle({ conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer' });
    return 'completed';
  };
}

function makeLoop({ adapter = fixture, channel = {}, onTurn = null } = {}) {
  const decl = declaration(channel);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-poll-'));
  const store = Store.open(dir);
  const harness = fakeHarness({ onTurn: onTurn ?? answering(store), statuses: REPLY_LISTED });
  const lines = [];
  const loop = new ReleaseLoop({
    declaration: decl,
    channel: resolveChannel(decl, decl.channels[0]),
    store,
    storeDir: dir,
    adapter,
    harness,
    session: harness.session,
    agent: AGENT,
    checkout: path.join(dir, 'repo'),
    work: dir,
    log: (line) => lines.push(line)
  });
  return { loop, store, dir, harness, lines, declaration: decl };
}

function item(id, text) {
  return { conversation: 'c1', id: String(id), position: String(id).padStart(4, '0'), at: '2026-09-10T10:00:00.000Z', text, sender: 'someone@example.test' };
}

// An adapter that goes and looks. It is the fixture adapter with a poll bolted
// on, so what is being tested is the loop's handling of the poll and not a
// second copy of the fixture's rules.
function polling(behaviour) {
  return { ...fixture, poll: behaviour };
}

test('an adapter that goes and looks has its items captured and released', async () => {
  const { loop, harness } = makeLoop({ adapter: polling(() => ({ items: [item(1, 'from the mailbox')] })) });
  const result = await loop.pass();
  assert.equal(result.captured.length, 1);
  assert.equal(result.captured[0].body, 'from the mailbox');
  assert.equal(result.poll.polled, true);
  assert.equal(harness.session.turns.length, 1);
});

test('an adapter that does not go and look is handed its items, as before', async () => {
  const { loop } = makeLoop();
  const result = await loop.pass([item(1, 'handed in')]);
  assert.equal(result.poll.polled, false);
  assert.equal(result.captured.length, 1);
});

test('a poll that failed is a named fault in the log and a field on the channel', async () => {
  const { loop, store, lines } = makeLoop({
    adapter: polling(() => { throw new Error('the mail server refused the connection'); })
  });
  const result = await loop.pass();
  assert.equal(result.poll.holding, false, 'one failure held the channel');
  assert.equal(result.poll.failures, 1);

  const logged = lines.find((line) => line.event === 'poll.failed');
  assert.ok(logged, 'the failure was not logged');
  assert.equal(logged.fault.code, 'CHANNEL_POLL_FAILED');
  assert.equal(logged.fault.subject, `fixture:${ACCOUNT}`);
  assert.match(logged.fault.problem, /refused the connection/);

  const state = pollState(store, ACCOUNT, 'fixture');
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.holding, false);
  assert.equal(state.last_fault.code, 'CHANNEL_POLL_FAILED');
});

test('a failing poll does not stop the process, and what the store already holds still goes out', async () => {
  let first = true;
  const { loop, harness, store } = makeLoop({
    adapter: polling(() => {
      if (first) { first = false; return { items: [item(1, 'arrived before the outage')] }; }
      throw new Error('the mail server went away');
    })
  });
  const firstPass = await loop.pass();
  assert.equal(harness.session.turns.length, 1);
  assert.deepEqual(firstPass.delivered.map((d) => d.status), ['sent']);

  // A second reply is written on the same conversation and is still pending when
  // the next poll fails. That pass must deliver it anyway.
  replyHandler({ store, agent: AGENT })({
    conversation_id: `${ACCOUNT}:c1`,
    request_id: 'r-1',
    text: 'the answer'
  });
  const second = await loop.pass();
  assert.equal(second.poll.failures, 1);
  assert.deepEqual(second.delivered.map((d) => d.status), ['sent']);
});

test('failures past the declared count hold the channel, and the channel says so', async () => {
  const { loop, store, lines } = makeLoop({
    adapter: polling(() => { throw new Error('the mail server is still refusing'); }),
    channel: { poll_failures_before_hold: 2 }
  });
  const one = await loop.pass();
  assert.equal(one.poll.holding, false);
  const two = await loop.pass();
  assert.equal(two.poll.holding, true);
  assert.deepEqual(two.holding, [`fixture:${ACCOUNT}`]);
  assert.deepEqual(two.delivered, []);

  const held = lines.find((line) => line.event === 'poll.hold');
  assert.ok(held, 'the hold was not logged');
  assert.equal(held.fault.code, 'CHANNEL_POLL_HOLD');
  assert.match(held.fault.problem, /2 polls of this channel have failed in a row/);

  const state = pollState(store, ACCOUNT, 'fixture');
  assert.equal(state.holding, true);
  assert.equal(state.consecutive_failures, 2);
});

test('a held channel does no work at all until a poll works again', async () => {
  let up = false;
  const { loop, harness, store } = makeLoop({
    adapter: polling(() => {
      if (!up) throw new Error('down');
      return { items: [item(1, 'the mailbox came back')] };
    }),
    channel: { poll_failures_before_hold: 1 }
  });
  const down = await loop.pass();
  assert.equal(down.poll.holding, true);
  assert.equal(harness.session.turns.length, 0, 'a held channel released a turn');

  up = true;
  const back = await loop.pass();
  assert.equal(back.poll.holding, false);
  assert.equal(back.captured.length, 1);
  assert.equal(harness.session.turns.length, 1);
  assert.equal(pollState(store, ACCOUNT, 'fixture').holding, false);
  assert.equal(pollState(store, ACCOUNT, 'fixture').consecutive_failures, 0);
});

test('the count is on disk, so a restart does not start the channel over', async () => {
  const { loop, store, dir } = makeLoop({
    adapter: polling(() => { throw new Error('down'); }),
    channel: { poll_failures_before_hold: 2 }
  });
  await loop.pass();
  assert.equal(pollState(store, ACCOUNT, 'fixture').consecutive_failures, 1);

  // A second runtime over the same store, which is what a restart is.
  const reopened = Store.open(dir);
  assert.equal(pollState(reopened, ACCOUNT, 'fixture').consecutive_failures, 1);
  assert.equal(readChannelState(reopened, ACCOUNT, 'fixture').kind, 'fixture');
});

test('the channel state file is one file per channel, shared with whatever else writes it', async () => {
  const { loop, store } = makeLoop({ adapter: polling(() => ({ items: [] })) });
  await loop.pass();
  const state = readChannelState(store, ACCOUNT, 'fixture');
  assert.equal(state.account, ACCOUNT);
  assert.equal(state.poll.last_success_at !== null, true);
  assert.equal(state.poll.last_item_count, 0);
});

test('an interval below the adapter floor is refused by name, and never quietly raised', () => {
  const floored = { ...fixture, POLL_INTERVAL_FLOOR_MS: 30000 };
  const below = pollIntervalFor({ kind: 'fixture', account: ACCOUNT, poll_interval_ms: 5000 }, floored);
  assert.equal(below.interval_ms, null);
  assert.equal(below.fault.code, 'POLL_INTERVAL_BELOW_FLOOR');
  assert.match(below.fault.fix, /30000/);

  const at = pollIntervalFor({ kind: 'fixture', account: ACCOUNT, poll_interval_ms: 30000 }, floored);
  assert.equal(at.interval_ms, 30000);
  assert.equal(at.fault, null);

  const none = pollIntervalFor({ kind: 'fixture', account: ACCOUNT }, floored);
  assert.equal(none.fault.code, 'POLL_INTERVAL_MISSING');
});

test('the email adapter carries a floor and the declaration must honour it', () => {
  assert.equal(email.POLL_INTERVAL_FLOOR_MS, 30000);
  assert.equal(pollIntervalFor({ kind: 'email', account: ACCOUNT, poll_interval_ms: 29999 }, email).fault.code,
    'POLL_INTERVAL_BELOW_FLOOR');
  assert.equal(pollIntervalFor({ kind: 'email', account: ACCOUNT, poll_interval_ms: 30000 }, email).interval_ms, 30000);
});

test('the declared count is the channel\'s, and the runtime\'s constant when it is silent', () => {
  assert.equal(failuresBeforeHold({}), POLL_FAILURES_BEFORE_HOLD);
  assert.equal(failuresBeforeHold({ poll_failures_before_hold: 7 }), 7);
});

test('the runtime refuses to start a channel declared below its adapter\'s floor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-poll-run-'));
  const decl = declaration();
  decl.channels = [{ kind: 'email', account: 'someone@example.test', release: 'immediate', poll_interval_ms: 1000, hold: {}, max_attachment_bytes: 1000 }];
  await assert.rejects(() => run({
    declaration: decl,
    declarationPath: path.join(dir, 'carbon.agent.json'),
    storeDir: dir,
    codexHome: dir,
    checkout: dir,
    work: dir,
    harnessRoot: dir,
    binary: '/nowhere/codex',
    harness: fakeHarness({ statuses: REPLY_LISTED }),
    adapters: { email },
    passes: 1
  }), (error) => error.faults.some((f) => f.code === 'POLL_INTERVAL_BELOW_FLOOR'));
});

// ---- the channel a secret reference resolves to ----------------------------

test('a channel names a secret and gets its path, never its value', () => {
  const decl = declaration({
    kind: 'email',
    transport: { imap_host: 'imap.example.test', netrc_ref: 'mailbox_netrc' }
  });
  const resolved = resolveChannel(decl, decl.channels[0]);
  assert.equal(resolved.netrc, '/nowhere/netrc');
  assert.equal(resolved.imap_host, 'imap.example.test');
  assert.equal(resolved.transport, undefined);
  assert.equal(resolved.netrc_ref, undefined);
});

test('a channel naming a secret nobody declared is refused by name at start', () => {
  const decl = declaration({ kind: 'email', transport: { netrc_ref: 'not_declared' } });
  assert.throws(() => resolveChannel(decl, decl.channels[0]),
    (error) => error.faults.some((f) => f.code === 'CHANNEL_SECRET_UNDECLARED'));
});

// ---- the email adapter, polled through the loop -----------------------------

test('the loop polls the email adapter and captures what the mailbox held', async () => {
  const recorded = path.join(HERE, 'fixtures', 'imap-recorded');
  process.env.CARBON_EMAIL_RECORDED = recorded;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-poll-email-'));
  const store = Store.open(dir);
  const account = 'agent-01@example.test';
  const decl = declaration();
  decl.channels = [{
    kind: 'email',
    account,
    release: 'immediate',
    poll_interval_ms: 30000,
    hold: { on_operator_message: true, release_after_ms: 3600000 },
    max_attachment_bytes: 1000000,
    transport: {
      mailbox: 'INBOX',
      imap_host: 'imap.example.test',
      imap_port: 993,
      smtp_host: 'smtp.example.test',
      smtp_port: 465,
      netrc_ref: 'mailbox_netrc'
    }
  }];
  const harness = fakeHarness({ onTurn: () => 'completed', statuses: REPLY_LISTED });
  const loop = new ReleaseLoop({
    declaration: decl,
    channel: resolveChannel(decl, decl.channels[0]),
    store,
    storeDir: dir,
    adapter: email,
    harness,
    session: harness.session,
    agent: AGENT,
    checkout: path.join(dir, 'repo'),
    work: dir
  });

  const result = await loop.pass();
  assert.equal(result.poll.polled, true);
  assert.equal(result.captured.length, 2, 'the two recorded messages were not captured');
  assert.equal(pollState(store, account, 'email').consecutive_failures, 0);
  assert.equal(pollState(store, account, 'email').last_item_count, 2);

  // A second pass reads past the watermark and finds nothing new, which is the
  // whole point of the cursor: one message is captured once.
  const again = await loop.pass();
  assert.equal(again.captured.length, 0);
});
