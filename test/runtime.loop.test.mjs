import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.mjs';
import { ReleaseLoop, releaseIdFor, releaseDecision, unitIdFor, when } from '../runtime/loop.mjs';
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
    provider: { name: 'openai', api_key_ref: 'provider_api_key' },
    secrets: [{ name: 'provider_api_key', path: '/nowhere/key', purpose: 'the model provider key' }],
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
    checkout: dir
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
  loop.deliver();

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
      hold: { reason: 'the operator answered in the conversation', set_at: '2026-09-10T10:02:00.000Z', release_after_ms: 3600000 }
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
