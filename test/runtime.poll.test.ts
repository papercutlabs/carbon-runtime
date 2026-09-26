import type { Fault } from '../stream/faults.ts';
type WrittenPoll = { consecutive_failures: unknown; holding: unknown; last_attempt_at: unknown; last_success_at: unknown; last_item_count: unknown; inbound_transport: unknown; last_fault: { code: string; problem: string } | null };
import type { RuntimeFault } from '../runtime/faults.ts';
import type { Channel, Context, Declaration } from '../runtime/types.ts';
import type { OnTurn } from './fake-harness.ts';
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

import { Store } from '../stream/store.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { run } from '../runtime/index.ts';
import { resolveChannel } from '../runtime/channel.ts';
import {
  POLL_FAILURES_BEFORE_HOLD, failuresBeforeHold, inboundTransportOf, pollIntervalFor, pollState
} from '../runtime/poll.ts';
import { readChannelState } from '../runtime/channel-state.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import * as fixture from '../adapters/fixture/index.ts';
import * as email from '../adapters/email/index.ts';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const HERE = import.meta.dirname;

process.env.CARBON_EMAIL_CURL = path.join(HERE, 'fixtures', 'curl-shim', 'curl');

const REPLY_LISTED = () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }];

function declaration(channel: Partial<Channel> = {}): Declaration & { channels: Channel[]; agent: { id: string; client: string } } {
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
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000, ...channel }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

// The model answers by calling the reply tool, because a turn that does not is a
// turn the runtime follows up on, and these tests are about the poll rather than
// about that rule.
function answering(store: Store): OnTurn {
  const handle = replyHandler({ store, agent: AGENT });
  return (session, params) => {
    handle({ conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer' });
    return 'completed';
  };
}

function makeLoop({ adapter = fixture, channel = {}, onTurn = null }: { adapter?: object; channel?: Partial<Channel>; onTurn?: OnTurn | null } = {}) {
  const decl = declaration(channel);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-poll-'));
  const store = Store.open(dir);
  const harness = fakeHarness({ onTurn: onTurn ?? answering(store), statuses: REPLY_LISTED });
  const lines: Record<string, unknown>[] = [];
  const loop = new ReleaseLoop({
    declaration: decl,
    channel: resolveChannel(decl, decl.channels[0]) as Channel, // The fixture supplies these channel fields; resolved transport overrides remain unvalidated in the runtime API.
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

function item(id: number | string, text: string) {
  return { conversation: 'c1', id: String(id), position: String(id).padStart(4, '0'), at: '2026-09-10T10:00:00.000Z', text, sender: 'someone@example.test' };
}

// An adapter that goes and looks. It is the fixture adapter with a poll bolted
// on, so what is being tested is the loop's handling of the poll and not a
// second copy of the fixture's rules.
function polling(behaviour: (context: Context) => unknown) {
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
  assert.equal((logged.fault as Fault).code, 'CHANNEL_POLL_FAILED'); // This case selected the fault log entry and now checks its original fields.
  assert.equal((logged.fault as Fault).subject, `fixture:${ACCOUNT}`); // This case selected the fault log entry and now checks its original fields.
  assert.match((logged.fault as Fault).problem, /refused the connection/); // This case selected the fault log entry and now checks its original fields.

  const state = (pollState(store, ACCOUNT, 'fixture') as WrittenPoll); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.holding, false);
  assert.equal(state.last_fault!.code, 'CHANNEL_POLL_FAILED'); // This fixture creates the selected value before this access; retain the original failure if it is absent.
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
  assert.equal((held.fault as Fault).code, 'CHANNEL_POLL_HOLD'); // This case selected the fault log entry and now checks its original fields.
  assert.match((held.fault as Fault).problem, /2 polls of this channel have failed in a row/); // This case selected the fault log entry and now checks its original fields.

  const state = (pollState(store, ACCOUNT, 'fixture') as WrittenPoll); // This case wrote these synthetic poll fields; the production reader still returns unknown.
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
  assert.equal((pollState(store, ACCOUNT, 'fixture') as WrittenPoll).holding, false); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal((pollState(store, ACCOUNT, 'fixture') as WrittenPoll).consecutive_failures, 0); // This case wrote these synthetic poll fields; the production reader still returns unknown.
});

test('the count is on disk, so a restart does not start the channel over', async () => {
  const { loop, store, dir } = makeLoop({
    adapter: polling(() => { throw new Error('down'); }),
    channel: { poll_failures_before_hold: 2 }
  });
  await loop.pass();
  assert.equal((pollState(store, ACCOUNT, 'fixture') as WrittenPoll).consecutive_failures, 1); // This case wrote these synthetic poll fields; the production reader still returns unknown.

  // A second runtime over the same store, which is what a restart is.
  const reopened = Store.open(dir);
  assert.equal((pollState(reopened, ACCOUNT, 'fixture') as WrittenPoll).consecutive_failures, 1); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal((readChannelState(reopened, ACCOUNT, 'fixture') as { poll: WrittenPoll; kind: string; account: string }).kind, 'fixture'); // This fixture creates the selected value before this access; retain the original failure if it is absent.
});

test('the channel state file is one file per channel, shared with whatever else writes it', async () => {
  const { loop, store } = makeLoop({ adapter: polling(() => ({ items: [] })) });
  await loop.pass();
  const state = (readChannelState(store, ACCOUNT, 'fixture') as { poll: WrittenPoll; kind: string; account: string }); // This fixture creates the selected value before this access; retain the original failure if it is absent.
  assert.equal(state.account, ACCOUNT);
  assert.equal(state.poll.last_success_at !== null, true);
  assert.equal(state.poll.last_item_count, 0);
});

test('every email poll result records the inbound transport that produced it', async () => {
  let up = false;
  const { loop, store } = makeLoop({
    adapter: polling(() => {
      if (!up) throw new Error('the REST endpoint is down');
      return { items: [] };
    }),
    channel: { kind: 'email', inbound: 'agentmail-api' }
  });
  await loop.pass();
  assert.equal((pollState(store, ACCOUNT, 'email') as WrittenPoll).inbound_transport, 'agentmail-api'); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  up = true;
  await loop.pass();
  assert.equal((pollState(store, ACCOUNT, 'email') as WrittenPoll).inbound_transport, 'agentmail-api'); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal((pollState(store, ACCOUNT, 'email') as WrittenPoll).consecutive_failures, 0); // This case wrote these synthetic poll fields; the production reader still returns unknown.
});

test('an email declaration with no switch records the compatible IMAP transport name', () => {
  assert.equal(inboundTransportOf({ kind: 'email' }), 'imap');
  assert.equal(inboundTransportOf({ kind: 'email', inbound: 'agentmail-api' }), 'agentmail-api');
  assert.equal(inboundTransportOf({ kind: 'telegram' }), null);
});

test('a new inbound transport starts its own failure count instead of inheriting the old one', async () => {
  const first = makeLoop({
    adapter: polling(() => { throw new Error('IMAP is down'); }),
    channel: { kind: 'email', poll_failures_before_hold: 3 }
  });
  await first.loop.pass();
  await first.loop.pass();
  assert.equal((pollState(first.store, ACCOUNT, 'email') as WrittenPoll).consecutive_failures, 2); // This case wrote these synthetic poll fields; the production reader still returns unknown.

  const harness = fakeHarness({ statuses: REPLY_LISTED });
  const restLoop = new ReleaseLoop({
    declaration: first.declaration,
    channel: { ...first.declaration.channels[0], kind: 'email', inbound: 'agentmail-api' },
    store: first.store,
    storeDir: first.dir,
    adapter: polling(() => { throw new Error('REST is down'); }),
    harness,
    session: harness.session,
    agent: AGENT,
    checkout: path.join(first.dir, 'repo'),
    work: first.dir
  });
  await restLoop.pass();
  const state = (pollState(first.store, ACCOUNT, 'email') as WrittenPoll); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal(state.inbound_transport, 'agentmail-api');
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.holding, false);
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
  assert.equal(none.fault!.code, 'POLL_INTERVAL_MISSING'); // This fixture creates the selected value before this access; retain the original failure if it is absent.
});

test('the email adapter carries a floor and the declaration must honour it', () => {
  assert.equal(email.POLL_INTERVAL_FLOOR_MS, 30000);
  assert.equal(pollIntervalFor({ kind: 'email', account: ACCOUNT, poll_interval_ms: 29999 }, email).fault!.code, // This fixture creates the selected value before this access; retain the original failure if it is absent.
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
  decl.channels = [{ kind: 'email', account: 'someone@example.test', release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000, hold: {}, max_attachment_bytes: 1000 }];
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
  }), (error) => (error as RuntimeFault).faults.some((f) => f.code === 'POLL_INTERVAL_BELOW_FLOOR')); // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
});

// ---- the channel a secret reference resolves to ----------------------------

test('a channel names a secret and gets its path, never its value', () => {
  const decl = declaration({
    kind: 'email',
    transport: { imap_host: 'imap.example.test', netrc_ref: 'mailbox_netrc' }
  });
  const resolved = resolveChannel(decl, decl.channels[0]) as Channel; // The fixture supplies these channel fields; resolved transport overrides remain unvalidated in the runtime API.
  assert.equal(resolved.netrc, '/nowhere/netrc');
  assert.equal(resolved.imap_host, 'imap.example.test');
  assert.equal(resolved.transport, undefined);
  assert.equal(resolved.netrc_ref, undefined);
});

test('a channel naming a secret nobody declared is refused by name at start', () => {
  const decl = declaration({ kind: 'email', transport: { netrc_ref: 'not_declared' } });
  assert.throws(() => resolveChannel(decl, decl.channels[0]),
    (error) => (error as RuntimeFault).faults.some((f) => f.code === 'CHANNEL_SECRET_UNDECLARED')); // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
});

test('immediate is refused at start with the quiet zero rewrite', () => {
  const decl = declaration({ release: 'immediate' });
  assert.throws(() => resolveChannel(decl, decl.channels[0]), (error) => {
    const refusal = (error as RuntimeFault).faults.find((f) => f.code === 'RELEASE_POLICY_UNKNOWN'); // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
    assert.ok(refusal, JSON.stringify((error as RuntimeFault).faults)); // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
    assert.equal(refusal.subject, `channels.fixture:${ACCOUNT}.release`);
    assert.match(refusal.fix, /release: quiet and quiet_ms: 0/);
    return true;
  });
});

test('quiet without a non-negative integer quiet_ms is refused at start, while zero is accepted', () => {
  for (const quiet_ms of [undefined, -1, 0.5, Number.NaN]) {
    const decl = declaration({ quiet_ms });
    assert.throws(() => resolveChannel(decl, decl.channels[0]),
      (error) => (error as RuntimeFault).faults.some((f) => f.code === 'RELEASE_QUIET_MS_ABSENT' // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
        && f.subject === `channels.fixture:${ACCOUNT}.quiet_ms`));
  }
  const decl = declaration({ quiet_ms: 0 });
  assert.equal(resolveChannel(decl, decl.channels[0]).quiet_ms, 0);
});

test('release-policy refusal happens before the runtime opens a thread', async () => {
  for (const channel of [{ release: 'immediate' }, { release: 'quiet', quiet_ms: undefined }]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-release-start-'));
    const decl = declaration(channel);
    const harness = fakeHarness({ statuses: REPLY_LISTED });
    await assert.rejects(() => run({
      declaration: decl,
      declarationPath: path.join(dir, 'carbon.agent.json'),
      storeDir: dir,
      codexHome: dir,
      checkout: dir,
      work: dir,
      harnessRoot: dir,
      binary: '/nowhere/codex',
      harness,
      adapters: { fixture },
      passes: 1
    }), (error) => (error as RuntimeFault).faults.some((f) => f.code === (channel.release === 'immediate' // This case exercises a RuntimeFault refusal; its existing assertions inspect that fault.
      ? 'RELEASE_POLICY_UNKNOWN' : 'RELEASE_QUIET_MS_ABSENT')));
    assert.deepEqual(harness.session.opens, undefined);
  }
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
    release: 'quiet',
    quiet_ms: 0,
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
    channel: resolveChannel(decl, decl.channels[0]) as Channel, // The fixture supplies these channel fields; resolved transport overrides remain unvalidated in the runtime API.
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
  assert.equal((pollState(store, account, 'email') as WrittenPoll).consecutive_failures, 0); // This case wrote these synthetic poll fields; the production reader still returns unknown.
  assert.equal((pollState(store, account, 'email') as WrittenPoll).last_item_count, 2); // This case wrote these synthetic poll fields; the production reader still returns unknown.

  // A second pass reads past the watermark and finds nothing new, which is the
  // whole point of the cursor: one message is captured once.
  const again = await loop.pass();
  assert.equal(again.captured.length, 0);
});
