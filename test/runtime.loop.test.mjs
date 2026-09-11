import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.mjs';
import {
  ReleaseLoop, releaseIdFor, releaseDecision, unitIdFor, when, turnInput, replyInstruction,
  checkoutLine, toolCallsIn, MAX_INLINE_ATTACHMENT_BYTES
} from '../runtime/loop.mjs';
import { EXIT } from '../runtime/faults.mjs';
import { replyHandler } from '../runtime/reply-tool.mjs';
import { fakeHarness } from './fake-harness.mjs';
import * as fixture from '../adapters/fixture/index.mjs';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';

function declaration(overrides = {}) {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
    tool_servers: [],
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'immediate', poll_interval_ms: 1000 }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 },
    ...overrides
  };
}

// The reply tool is a tool server like any other, and the harness lists it. A
// test that forgets it is a test whose runtime refuses to start, which is the
// refusal being tested two tests further down.
const REPLY_LISTED = () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }];

function makeLoop({ decl = declaration(), onTurn = null, statuses = REPLY_LISTED } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const harness = fakeHarness({ onTurn: onTurn ? onTurn(store) : (() => 'completed'), statuses });
  const loop = new ReleaseLoop({
    declaration: decl,
    channel: decl.channels[0],
    store,
    storeDir: dir,
    adapter: fixture,
    harness,
    session: harness.session,
    agent: AGENT,
    checkout: path.join(dir, 'repo'),
    work: dir
  });
  return { loop, store, dir, harness };
}

function item(id, text, extra = {}) {
  return {
    conversation: 'c1',
    id: String(id),
    position: String(id).padStart(4, '0'),
    at: `2026-09-10T10:0${id}:00.000Z`,
    sender: 'contact-1',
    text,
    ...extra
  };
}

// The model answers by calling the reply tool, which is what the runtime hands
// it. Doing that here rather than pretending keeps the fence in the test.
function answering(store, { text = 'the answer', requestId = null, times = 1 } = {}) {
  const handle = replyHandler({ store, agent: AGENT });
  return (session, params) => {
    for (let i = 0; i < times; i++) {
      handle({
        conversation_id: `${ACCOUNT}:c1`,
        request_id: requestId ?? params.clientUserMessageId,
        text
      });
    }
    return 'completed';
  };
}

test('a pass captures, releases and delivers, in that order and in arrival order', async () => {
  const { loop, store } = makeLoop({ onTurn: (s) => answering(s) });

  const result = await loop.pass([item(1, 'first'), item(2, 'second')]);

  assert.equal(result.captured.length, 2);
  assert.deepEqual(result.released.map((r) => r.message_id), [
    `${ACCOUNT}:c1:1`, `${ACCOUNT}:c1:2`
  ]);
  assert.equal(result.delivered.length, 2);
  assert.ok(result.delivered.every((d) => d.status === 'sent'));

  const records = store.rebuild();
  const inbound = records.filter((r) => r.direction === 'inbound');
  assert.equal(inbound.length, 2);
  assert.ok(inbound.every((r) => r.release && r.release.completed_at), 'every release is completed');
  const outbound = records.filter((r) => r.direction === 'outbound');
  assert.equal(outbound.length, 2);
  assert.ok(outbound.every((r) => r.delivery.status === 'sent' && r.delivery.chunk_ids.length > 0));
});

test('the release is on the record before the turn is asked for', async () => {
  let seen = null;
  const { loop, store } = makeLoop({
    onTurn: (s) => () => {
      const record = s.rebuild().find((r) => r.direction === 'inbound');
      seen = JSON.parse(fs.readFileSync(s.paths(record).record, 'utf8'));
      return 'completed';
    }
  });
  loop.capture([item(1, 'first')]);
  const record = store.rebuild()[0];

  await loop.releasePass();
  assert.ok(seen.release, 'the turn ran with no release written');
  assert.equal(seen.release.thread_id, 'thread-1');
  assert.equal(seen.release.turn_id, releaseIdFor(record));
  assert.equal(seen.release.completed_at, undefined, 'the release was completed before the turn finished');
});

test('a re-issued release produces one reply, because the request id is the fence', async () => {
  // The first turn is killed after the release is written and before any reply.
  const { loop, store } = makeLoop({ onTurn: () => () => 'interrupted' });
  loop.capture([item(1, 'first')]);
  const record = store.rebuild()[0];
  await loop.releasePass();
  assert.equal(store.rebuild().filter((r) => r.direction === 'outbound').length, 0);

  // The restart: the recovery says to re-issue, and this time the model answers.
  const recovered = loop.recover();
  assert.deepEqual(recovered.reissue, [record.message_id]);

  const second = fakeHarness({ onTurn: answering(store) });
  loop.harness = second;
  loop.session = second.session;
  loop.threads.clear();
  await loop.releasePass({ reissue: recovered.reissue });
  await loop.deliver();

  const outbound = store.rebuild().filter((r) => r.direction === 'outbound');
  assert.equal(outbound.length, 1, 'the re-issue produced a second reply');
  assert.equal(outbound[0].delivery.status, 'sent');
  assert.equal(second.session.turns[0].clientUserMessageId, releaseIdFor(record));
  assert.equal(outbound[0].reply_to, record.message_id);
});

test('a second reply under a sent request id returns the chunk ids and sends nothing', async () => {
  const { loop, store } = makeLoop({ onTurn: (s) => answering(s) });
  await loop.pass([item(1, 'first')]);

  const handle = replyHandler({ store, agent: AGENT });
  const requestId = releaseIdFor(store.rebuild().find((r) => r.direction === 'inbound'));
  const again = handle({ conversation_id: `${ACCOUNT}:c1`, request_id: requestId, text: 'the answer' });
  assert.equal(again.data.status, 'already_sent');
  assert.ok(again.data.chunk_ids.length > 0);
  assert.equal(store.rebuild().filter((r) => r.direction === 'outbound').length, 1);
});

test('a second reply under a pending request id is refused, and under a failed one is allowed', async () => {
  const { loop, store } = makeLoop();
  loop.capture([item(1, 'first')]);
  const handle = replyHandler({ store, agent: AGENT });
  handle({ conversation_id: `${ACCOUNT}:c1`, request_id: 'r-1', text: 'first try' });

  assert.throws(() => handle({ conversation_id: `${ACCOUNT}:c1`, request_id: 'r-1', text: 'second try' }),
    (error) => error.faults.some((f) => f.code === 'REQUEST_ALREADY_PENDING'));

  store.markFailed('r-1');
  const allowed = handle({ conversation_id: `${ACCOUNT}:c1`, request_id: 'r-1', text: 'after a known failure' });
  assert.equal(allowed.data.status, 'written');
});

test('an unknown send is never retried, whoever asks', async () => {
  const { loop, store } = makeLoop();
  loop.capture([item(1, 'first')]);
  const handle = replyHandler({ store, agent: AGENT });
  handle({ conversation_id: `${ACCOUNT}:c1`, request_id: 'r-2', text: 'the answer' });
  store.markUnknown('r-2');
  assert.throws(() => handle({ conversation_id: `${ACCOUNT}:c1`, request_id: 'r-2', text: 'the answer' }),
    (error) => error.faults.some((f) => f.code === 'DELIVERY_UNKNOWN_NEVER_RETRIED'));
});

test('an operator message holds the conversation and releases nothing', async () => {
  const { loop, harness } = makeLoop();
  const result = await loop.pass([
    item(1, 'first'),
    item(2, 'the operator is on it', {
      role: 'operator',
      // The hold is set now rather than at a fixed date: a hold expires, so a
      // date written into the file stops holding on the day it passes and the
      // test goes red for the calendar rather than for the code.
      hold: { reason: 'the operator answered in the conversation', set_at: new Date().toISOString(), release_after_ms: 3600000 }
    })
  ]);
  assert.deepEqual(result.released, []);
  assert.ok(result.held.includes(`${ACCOUNT}:c1:1`));
  assert.equal(harness.session.turns.length, 0);
});

test('a historical record releases no turn', async () => {
  const { loop, harness } = makeLoop();
  const result = await loop.pass([item(1, 'from the export', { historical: true })]);
  assert.equal(result.captured.length, 1);
  assert.deepEqual(result.released, []);
  assert.equal(harness.session.turns.length, 0);
});

test('a required tool server that is down holds release, and its recovery lets it go', async () => {
  let state = 'starting';
  const decl = declaration({
    tool_servers: [{
      name: 'client-api', transport: 'http',
      command: '/srv/carbon/agent/current/repo/tools/client-api/server.mjs',
      url: 'http://127.0.0.1:8731/mcp', cwd: '/srv/carbon/agent', read_only: false, required: true, secret_refs: []
    }]
  });
  const { loop, harness, store } = makeLoop({
    decl,
    onTurn: (s) => answering(s),
    statuses: () => [
      { name: 'client-api', runtimeStatus: state === 'up' ? 'connected' : 'starting' },
      { name: 'carbon-reply', runtimeStatus: 'connected' }
    ]
  });

  const held = await loop.pass([item(1, 'first')]);
  assert.deepEqual(held.released, []);
  assert.deepEqual(held.holding, ['tool_servers.client-api'], 'the hold names the server');
  assert.deepEqual(held.held, [`${ACCOUNT}:c1:1`]);
  assert.equal(harness.session.turns.length, 0);

  // The server comes up, and the startup notification re-raises the read.
  state = 'up';
  for (const handler of harness.session.statusHandlers) handler({ kind: 'tool_server.status' });
  loop.toolStatusStale = true;
  const released = await loop.pass([]);
  assert.equal(released.released.length, 1);
  assert.equal(harness.session.turns.length, 1);
});

test('a tool server nobody declared is refused by name, and no turn is taken', async () => {
  const { loop } = makeLoop({
    statuses: () => [
      { name: 'carbon-reply', runtimeStatus: 'connected' },
      { name: 'codex_apps', runtimeStatus: 'connected' }
    ]
  });
  loop.capture([item(1, 'first')]);
  await assert.rejects(() => loop.releasePass(), (error) => {
    assert.ok(error.faults.some((f) => f.code === 'TOOL_SERVER_UNDECLARED' && f.subject === 'codex_apps'),
      JSON.stringify(error.faults));
    return true;
  });
});

test('a failed turn writes permanent-error, latches, and stops with the latch code', async () => {
  const { loop, store, dir } = makeLoop({
    onTurn: () => () => ({ status: 'failed', error: { message: 'the model refused this input' } })
  });
  loop.capture([item(1, 'first')]);

  await assert.rejects(() => loop.releasePass(), (error) => {
    assert.equal(error.exitCode, 78);
    assert.equal(error.faults[0].code, 'TURN_FAILED');
    return true;
  });
  const record = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(record.disposition, 'permanent-error');
  assert.ok(record.release.completed_at);
  assert.ok(fs.existsSync(path.join(dir, 'channels', ACCOUNT, 'fixture.latch.json')));
});

test('a completion time the harness gives in seconds is written as an ISO string', async () => {
  const { loop, store } = makeLoop({
    onTurn: (s) => {
      const answer = answering(s);
      return (session, params) => {
        answer(session, params);
        return { status: 'completed', completed_at: 1789034400 };
      };
    }
  });
  await loop.pass([item(1, 'first')]);
  const record = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(typeof record.release.completed_at, 'string');
  assert.equal(record.release.completed_at, '2026-09-10T10:00:00.000Z');
  assert.equal(when(1789034400), '2026-09-10T10:00:00.000Z');
  assert.equal(when(undefined), null);
});

test('the unit of work is the conversation, or the client record the declaration names', () => {
  const record = { conversation_id: 'c-9', adapter_fields: { tracker: { master_job: { id: 'JOB-4' } } } };
  assert.equal(unitIdFor(declaration(), record), 'c-9');
  assert.equal(unitIdFor(declaration({ unit_of_work: { kind: 'client_record', id_from: 'tracker.master_job.id' } }), record), 'JOB-4');
});

test('a quiet channel waits for the quiet window, and a mention channel waits for the mention', () => {
  const store = { isHeld: () => false, recordsIn: () => [{ direction: 'inbound', received_at: '2026-09-10T10:00:00.000Z' }] };
  const record = { direction: 'inbound', conversation_id: 'c1', received_at: '2026-09-10T10:00:00.000Z', body: 'no name here' };
  const at = Date.parse('2026-09-10T10:00:30.000Z');
  const quiet = { kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 60000 };
  assert.equal(releaseDecision(declaration(), quiet, store, record, { now: at }).release, false);
  assert.equal(releaseDecision(declaration(), quiet, store, record, { now: at + 60000 }).release, true);

  const mention = { kind: 'fixture', account: ACCOUNT, release: 'mention', mention: '@agent' };
  assert.equal(releaseDecision(declaration(), mention, store, record, { now: at }).release, false);
  assert.equal(releaseDecision(declaration(), mention, store, { ...record, body: 'hello @agent' }, { now: at }).release, true);
});

// ---- a record the runtime cannot release ---------------------------------

// The first real message on a box crashed the runtime here: the declaration
// keyed the unit of work on a field an emailed message does not carry, the
// release threw, the process exited, systemd restarted it onto the same record
// and reached the start limit. One record must never do that.
const CLIENT_RECORD = () => declaration({
  unit_of_work: { kind: 'client_record', id_from: 'tracker.master_job.id' }
});

test('a record whose release faults is parked, and the channel keeps working', async () => {
  const { loop, store } = makeLoop({ decl: CLIENT_RECORD(), onTurn: (s) => answering(s) });

  const result = await loop.pass([
    item(1, 'no job id on this one'),
    item(2, 'this one names its job', { extra: { tracker: { master_job: { id: 'JOB-4' } } } })
  ]);

  assert.deepEqual(result.parked, [`${ACCOUNT}:c1:1`]);
  assert.deepEqual(result.released.map((r) => r.message_id), [`${ACCOUNT}:c1:2`]);

  const parked = store.rebuild().find((r) => r.message_id === `${ACCOUNT}:c1:1`);
  assert.equal(parked.disposition, 'parked');
  assert.equal(parked.adapter_fields.park_faults[0].code, 'UNIT_ID_ABSENT');
  assert.match(parked.adapter_fields.park_reason, /UNIT_ID_ABSENT/);
  assert.ok(!parked.release, 'a record that never reached a turn carries no release');
});

test('a parked record is not tried again on the next pass', async () => {
  let turns = 0;
  const { loop } = makeLoop({
    decl: CLIENT_RECORD(),
    onTurn: (s) => (session, params) => { turns += 1; return answering(s)(session, params); }
  });

  await loop.pass([item(1, 'no job id on this one')]);
  const second = await loop.pass([]);

  assert.deepEqual(second.parked, []);
  assert.deepEqual(second.released, []);
  assert.equal(turns, 0, 'the parked record was released after all');
});

test('the terminal latch still ends the process rather than parking a record', async () => {
  const { loop } = makeLoop({ onTurn: () => () => 'failed' });

  await assert.rejects(
    () => loop.pass([item(1, 'the model refuses this permanently')]),
    (error) => error.exitCode === EXIT.LATCHED && error.faults[0].code === 'TURN_FAILED'
  );
});

test('an app-server listing a tool server nobody declared still ends the process', async () => {
  const { loop } = makeLoop({
    onTurn: (s) => answering(s),
    statuses: () => [
      { name: 'carbon-reply', runtimeStatus: 'connected' },
      { name: 'connected-apps', runtimeStatus: 'connected' }
    ]
  });

  await assert.rejects(
    () => loop.pass([item(1, 'anything')]),
    (error) => error.faults.some((f) => f.code === 'TOOL_SERVER_UNDECLARED')
  );
});

// ---- a completed turn is not an answered message -------------------------

// The first real message on a box was answered well and delivered nothing: the
// model wrote its answer into its own message and never called the reply tool.
// The runtime asks once, and then decides.
function said(text) {
  return () => (session, params, n) => ({ status: 'completed', agent_message: `${text} (turn ${n})` });
}

test('a turn that delivers nothing is followed up once, and the follow-up reply is delivered', async () => {
  const { loop, store, dir } = makeLoop({
    onTurn: (s) => {
      const handle = replyHandler({ store: s, agent: AGENT });
      return (session, params, n) => {
        // The first turn answers in its own message; the follow-up calls the tool
        // with the request id it was given the first time.
        if (n === 1) return { status: 'completed', agent_message: 'Sure, here is the answer.' };
        handle({ conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId.replace(/-follow-up$/, ''), text: 'the answer' });
        return { status: 'completed', agent_message: 'Sent.' };
      };
    }
  });

  const result = await loop.pass([item(1, 'a question')]);

  assert.equal(result.released[0].reply, 'replied-after-follow-up');
  assert.deepEqual(result.delivered.map((d) => d.status), ['sent']);
  assert.deepEqual(result.parked, []);

  const thread = JSON.parse(fs.readFileSync(path.join(dir, 'threads', `${ACCOUNT}~3Ac1.json`), 'utf8'));
  assert.equal(thread.turns.length, 2, 'exactly one follow-up');
  assert.equal(thread.turns[0].agent_message, 'Sure, here is the answer.');
  assert.equal(store.rebuild().find((r) => r.direction === 'inbound').disposition, 'captured');
});

test('a turn that answers NO_REPLY closes the release with that reason and delivers nothing', async () => {
  const { loop, store } = makeLoop({ onTurn: () => (session, params, n) => ({
    status: 'completed',
    agent_message: n === 1 ? 'Nothing to do here.' : '  NO_REPLY\n'
  }) });

  const result = await loop.pass([item(1, 'an automated bounce')]);

  assert.equal(result.released[0].reply, 'no-reply-declared');
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.parked, []);

  const record = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(record.disposition, 'captured');
  assert.equal(record.adapter_fields.reply_outcome, 'no-reply-declared');
  assert.ok(record.release.completed_at, 'the release stays open');
});

test('a follow-up that neither replies nor says NO_REPLY parks the record with reason no-reply', async () => {
  const { loop, store } = makeLoop({ onTurn: said('I have already answered above.') });

  const result = await loop.pass([item(1, 'a question')]);

  assert.equal(result.released[0].reply, 'parked-no-reply');
  assert.deepEqual(result.delivered, []);

  const record = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(record.disposition, 'parked');
  assert.equal(record.adapter_fields.park_reason, 'no-reply');
  assert.equal(record.adapter_fields.park_faults[0].code, 'REPLY_ABSENT');
});

test('a turn that calls the reply tool is never followed up', async () => {
  const { loop, harness } = makeLoop({ onTurn: (s) => answering(s) });

  const result = await loop.pass([item(1, 'a question')]);

  assert.equal(harness.session.turns.length, 1, 'a reply was followed up anyway');
  assert.equal(result.released[0].reply, 'replied');
});

// PA-181. The sandbox makes `cwd` a writable root and binds `cwd/.git` over
// itself, and the checkout is read-only with no `.git` in it, so a thread opened
// on the checkout is a thread whose shell dies in bubblewrap before it runs
// anything. The work directory is the agent user's own and is where a thread
// opens.
test('a thread is opened on the work directory and never on the checkout', async () => {
  const { loop, harness, dir } = makeLoop();
  await loop.pass([item(1, 'a question')]);
  assert.equal(harness.session.opens.length, 1);
  assert.equal(harness.session.opens[0].cwd, dir);
  assert.notEqual(harness.session.opens[0].cwd, loop.checkout);
});

test('a loop with no work directory is refused rather than opened on the checkout', () => {
  assert.throws(() => new ReleaseLoop({
    declaration: declaration(), channel: declaration().channels[0], store: null, storeDir: '/tmp',
    adapter: fixture, harness: null, session: null, agent: AGENT, checkout: '/tmp/repo'
  }), (error) => error.faults.some((f) => f.code === 'WORK_DIR_UNNAMED'));
});

// The thread no longer opens on the checkout, so the turn says where it is: the
// guidance and the skills are linked into the working directory and load by
// themselves, and everything else in the repository is read by absolute path.
test('the turn input names the checkout, because the thread is not opened on it', () => {
  const record = { conversation_id: 'c-9', sender_id: 'someone', received_at: '2026-09-10T10:00:00.000Z', body: 'hello' };
  const input = turnInput(record, 'release-1', { checkout: '/srv/carbon/a/current/repo' });
  assert.ok(input.includes(checkoutLine('/srv/carbon/a/current/repo')), input);
  assert.ok(!turnInput(record, 'release-1').includes('/srv/carbon/a/current/repo'));
});

test('the reply instruction is the first line and the last line of the turn', () => {
  const record = { conversation_id: 'c-9', sender_id: 'someone', received_at: '2026-09-10T10:00:00.000Z', body: 'hello' };
  const lines = turnInput(record, 'release-1').split('\n');
  const instruction = replyInstruction(record, 'release-1');
  assert.equal(lines[0], instruction);
  assert.equal(lines.at(-1), instruction);
});

test('what a turn cost is in the log, because the store is not readable from outside the box', async () => {
  const lines = [];
  const { loop } = makeLoop({
    onTurn: (s) => (session, params) => {
      replyHandler({ store: s, agent: AGENT })({
        conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer'
      });
      return { status: 'completed', token_usage: { input: 100, cached: 40, output: 7, reasoning: 3 } };
    }
  });
  loop.log = (line) => lines.push(line);

  await loop.pass([item(1, 'a question')]);

  const turn = lines.find((l) => l.event === 'turn');
  assert.ok(turn, `no turn line in ${JSON.stringify(lines.map((l) => l.event))}`);
  assert.equal(turn.status, 'completed');
  assert.deepEqual(turn.token_usage, { input: 100, cached: 40, output: 7, reasoning: 3 });
});

// The defect this test exists for cost the first live WhatsApp reply: the loop
// called an adapter whose send is asynchronous, read a status off the promise it
// got back, found none, and wrote the send down as failed. The store said the
// message was answered and the contact had nothing.
test('an adapter whose send is a promise is awaited, not read for a status it has not got', async () => {
  const { loop, store } = makeLoop({ onTurn: (s) => answering(s) });
  const sent = [];
  loop.adapter = {
    ...fixture,
    send: async (context, record) => {
      await new Promise((settled) => setTimeout(settled, 5));
      sent.push(record.delivery.request_id);
      return { status: 'sent', chunk_ids: ['chunk-1'] };
    }
  };

  const result = await loop.pass([item(1, 'first')]);

  assert.equal(sent.length, 1, 'the adapter was not asked to send');
  assert.deepEqual(result.delivered.map((d) => d.status), ['sent']);
  const outbound = store.rebuild().filter((r) => r.direction === 'outbound');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].delivery.status, 'sent');
  assert.deepEqual(outbound[0].delivery.chunk_ids, ['chunk-1']);
});

test('the log says which tools a turn called, by name and never by argument', () => {
  // The names, and nothing beside them. An argument carries the client's own
  // content, and this line is read by anyone who can read the unit's log.
  const items = [
    { type: 'agentMessage', text: 'thinking out loud' },
    { type: 'mcpToolCall', server: 'client-api', tool: 'lookup_record', status: 'completed', arguments: { reference: 'a private value' } },
    { type: 'dynamicToolCall', namespace: 'client-api', tool: 'read_record', status: 'completed', arguments: { id: 'another' } },
    { type: 'commandExecution', command: 'ls' }
  ];
  const calls = toolCallsIn(items);
  assert.deepEqual(calls, [
    { server: 'client-api', tool: 'lookup_record', status: 'completed' },
    { server: 'client-api', tool: 'read_record', status: 'completed' }
  ]);
  assert.ok(!JSON.stringify(calls).includes('a private value'));
  // A turn that called nothing says so, because "it called no tool" is the answer
  // the first real box needed and an absent field is not one.
  assert.deepEqual(toolCallsIn([]), []);
  assert.deepEqual(toolCallsIn(undefined), []);
});

// ---- attachments in the turn input -----------------------------------------
// A message whose answer is in an attached file was answered on a box with "I
// could not access the attachment": the file had been captured, and the turn
// input said nothing about it. The model's own shell is not a way round that —
// on the first client box it does not run at all — so a small text attachment
// travels in the turn itself.

function withAttachment(store, meta, bytes) {
  const base = {
    schema: 'carbon.message.v1', agent: AGENT, source: 'fixture', account: ACCOUNT,
    conversation_id: `${ACCOUNT}:c1`, conversation_kind: 'direct',
    message_id: `${ACCOUNT}:c1:m1`, platform_message_id: 'm1', revision: 0,
    direction: 'inbound', role: 'contact', sender_id: 'contact-1', sender_name: 'Contact',
    sent_at: '2026-09-10T10:00:00.000Z', received_at: '2026-09-10T10:00:00.000Z',
    body: 'the reference is in the attached note', historical: false, disposition: 'captured'
  };
  const attachment = bytes === null ? meta : store.putAttachment(base, bytes, meta);
  return { ...base, attachments: [attachment] };
}

test('a small text attachment travels in the turn input, under its own name and its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const record = withAttachment(store,
    { mime: 'text/plain', filename: 'booking-note.txt' },
    Buffer.from('Carrier booking reference: ALLD-UAT-778812\n'));

  const input = turnInput(record, 'release-1', { store });

  assert.match(input, /attachments: 1/);
  assert.match(input, /- booking-note\.txt \(text\/plain, 43 bytes, sha256 [0-9a-f]{64}\)/);
  assert.match(input, new RegExp(store.under(record.attachments[0].file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(input, /ALLD-UAT-778812/, 'the text the sender attached never reached the model');
  assert.match(input, /-----BEGIN ATTACHMENT [0-9a-f]{64}-----/);
  assert.match(input, /-----END ATTACHMENT [0-9a-f]{64}-----/);
});

test('the reply instruction is still the first line and the last line when an attachment is inlined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const record = withAttachment(store,
    { mime: 'text/plain', filename: 'note.txt' }, Buffer.from('a line\n'));

  const lines = turnInput(record, 'release-1', { store }).split('\n');

  assert.equal(lines[0], replyInstruction(record, 'release-1'));
  assert.equal(lines.at(-1), replyInstruction(record, 'release-1'));
});

test('an attachment that is not text is named and located and never inlined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const record = withAttachment(store,
    { mime: 'application/pdf', filename: 'packing-list.pdf' }, Buffer.from('%PDF-1.4 not really\n'));

  const input = turnInput(record, 'release-1', { store });

  assert.match(input, /- packing-list\.pdf \(application\/pdf, 20 bytes/);
  assert.doesNotMatch(input, /BEGIN ATTACHMENT/);
});

test('a text attachment past the inline cap is named and located and never inlined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const big = Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1, 'x');
  const record = withAttachment(store, { mime: 'text/plain', filename: 'ledger.txt' }, big);

  const input = turnInput(record, 'release-1', { store });

  assert.match(input, /- ledger\.txt \(text\/plain, 65537 bytes/);
  assert.doesNotMatch(input, /BEGIN ATTACHMENT/);
});

test('an attachment too large to capture says its bytes are not on this box', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-'));
  const store = Store.open(dir);
  const record = withAttachment(store, {
    file: 'unwritten/' + 'a'.repeat(64), mime: 'text/plain', bytes: 40000000,
    sha256: 'a'.repeat(64), download_failed: true, filename: 'archive.txt'
  }, null);

  const input = turnInput(record, 'release-1', { store });

  assert.match(input, /- archive\.txt \(text\/plain, 40000000 bytes, sha256 a{64}\): too large to capture/);
  assert.doesNotMatch(input, /BEGIN ATTACHMENT/);
});

test('a message with no attachment carries no attachment block', () => {
  const record = { conversation_id: 'c-9', sender_id: 'someone', received_at: '2026-09-10T10:00:00.000Z', body: 'hello' };
  assert.doesNotMatch(turnInput(record, 'release-1'), /attachments:/);
});

test('the turn the loop runs carries the attachment, not only the body', async () => {
  const inputs = [];
  const { loop, store } = makeLoop({
    onTurn: (s) => (session, params) => {
      inputs.push(params.input ?? params.text ?? null);
      replyHandler({ store: s, agent: AGENT })({
        conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer'
      });
      return { status: 'completed' };
    }
  });
  // What an adapter hands the loop: the decoded bytes and what the part called
  // itself. The loop writes them to the store and the record names the file.
  const collected = { bytes: Buffer.from('Carrier booking reference: ALLD-UAT-778812\n'), mime: 'text/plain', filename: 'booking-note.txt' };

  await loop.pass([item(1, 'the reference is attached', { attachments: [collected] })]);

  const captured = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(captured.attachments[0].filename, 'booking-note.txt');

  assert.equal(inputs.length, 1);
  assert.match(String(inputs[0]), /booking-note\.txt/);
  assert.match(String(inputs[0]), /ALLD-UAT-778812/);
});

// PA-180: an attachment past the adapter's cap carries `bytes` as its size, an
// integer, not a Buffer — the shape adapters/email/mime.mjs writes for one that
// crossed max_attachment_bytes. Capture must not mistake that integer for bytes
// to write; the record parks nothing, ends nothing, and still releases.
test('an oversize attachment parks nothing, ends nothing, and the message still releases', async () => {
  const inputs = [];
  const { loop, store } = makeLoop({
    onTurn: (s) => (session, params) => {
      inputs.push(params.input ?? params.text ?? null);
      replyHandler({ store: s, agent: AGENT })({
        conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer'
      });
      return { status: 'completed' };
    }
  });
  const oversize = {
    file: 'unwritten/' + 'b'.repeat(64),
    mime: 'application/pdf',
    bytes: 40000000,
    sha256: 'b'.repeat(64),
    download_failed: true,
    filename: 'archive.pdf'
  };

  const outcome = await loop.pass([item(1, 'the scan is attached', { attachments: [oversize] })]);

  assert.deepEqual(outcome.parked, [], 'an oversize attachment parked a record');

  const captured = store.rebuild().find((r) => r.direction === 'inbound');
  assert.equal(captured.attachments[0].download_failed, true);
  assert.equal(captured.attachments[0].bytes, 40000000);
  assert.equal(captured.release.thread_id !== undefined, true, 'the message did not release');

  assert.equal(inputs.length, 1, 'the turn the model saw never ran');
  assert.match(String(inputs[0]), /archive\.pdf \(application\/pdf, 40000000 bytes, sha256 b{64}\): too large to capture, so its bytes are not on this box\./);
});
