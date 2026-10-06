import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import * as adapter from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { readBrowserActivity, writeBrowserActivity } from '../runtime/browser-activity.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import { RpcError } from '../harness/codex/protocol.ts';
import { classifySteerFailure } from '../harness/codex/turn.ts';
import type { Declaration } from '../runtime/types.ts';
function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-shared-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = Store.open(path.join(root, 'store'));
  const account = 'synthetic'; const key = 'CASE-101'; const conversation = adapter.browserConversationId(account, key);
  const bridge = createBrowserBridge({ store, agent: 'synthetic-agent', account, authorize: (grant) => grant === 'fixture' });
  const declaration: Declaration = { agent: { id: 'synthetic-agent' }, model: 'protocol-fixture', effort: 'low', provider: { name: 'openai', auth: 'chatgpt' },
    sandbox: { mode: 'workspace-write', network: false }, unit_of_work: { kind: 'conversation' }, records: { enabled: false }, teaching: { enabled: false }, tool_servers: [],
    channels: [{ kind: 'browser', account, release: 'quiet', quiet_ms: 0, poll_interval_ms: 60000, default_conversation_kind: 'ops' }] };
  const submit = (id: string, text: string, actor = 'mira', input_kind: 'start' | 'message' = 'message') => bridge.submit('fixture', {
    account, ticket_key: key, submission_id: id, consultant: { id: actor, name: actor }, input_kind, body: text,
    accepted_at: new Date().toISOString(), position: String(store.nextSeq()).padStart(20, '0') });
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  const writer = replyHandler({ store, agent: 'synthetic-agent', declaration, validateBrowserReply: () => [] });
  const loop = new ReleaseLoop({ declaration, channel: declaration.channels![0], store, storeDir: store.dir, adapter, harness,
    session: harness.session, agent: 'synthetic-agent', checkout: root, work: root, prepareBrowserTurn: async () => ({ data: { ticket: { key }, commentsPage: { complete: false, nextStartAt: 2 } } }),
    browserThreadOptions: () => ({ permissions: 'fixture-only-not-native-proof', config: {} }) });
  t.after(loop.listenBrowserInputs());
  return { root, store, bridge, conversation, declaration, submit, harness, writer, loop, key };
}

test('deliberate start and three ordinary busy inputs share one native fixture turn/final settlement', async (t) => {
  const { store, submit, harness, writer, loop, conversation } = setup(t);
  const initial = submit('start', '', 'mira', 'start');
  const steered: string[] = [];
  const h = harness as typeof harness & { steer: (s: unknown, p: { expectedTurnId: string; input: string }) => Promise<{ turnId: string }> };
  h.steer = async (_session, params) => { steered.push(params.input); return { turnId: params.expectedTurnId }; };
  harness.turn = async (_s, params) => {
    harness.session.turns.push(params);
    assert.equal(params.sandboxPolicy, undefined); assert.equal(params.permissions, 'fixture-only-not-native-proof');
    assert.ok(params.input.includes('commentsPage')); assert.ok(!params.input.includes(store.dir));
    params.onStarted!({ threadId: params.threadId, turnId: 'native-one' });
    submit('csv-observation', 'row is 47'); submit('second-observation', 'cutoff is 17:05'); submit('colleague', 'header changed', 'jon');
    await loop.browserDelivery;
    writer({ conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: 'fixture result using all three distinctive inputs', metadata: { draftLabel: 'Draft for review and copy' } });
    return { thread_id: params.threadId, status: 'completed', turn_id: 'native-one', client_user_message_id: params.clientUserMessageId, completed_at: new Date().toISOString(), error: null, items: [], agent_message: null, token_usage: null, events: [] }; 
  };
  const result = await loop.pass([]);
  assert.equal(result.released.length, 1); assert.equal(harness.session.turns.length, 1); assert.equal(steered.length, 3);
  for (const text of ['row is 47', 'cutoff is 17:05', 'header changed']) assert.ok(steered.some((input) => input.includes(text)));
  const all = store.recordsIn(conversation); const inputs = all.filter((r) => r.direction === 'inbound'); const answers = all.filter((r) => r.direction === 'outbound');
  assert.equal(inputs.length, 4); assert.equal(answers.length, 1);
  const release = store.read(conversation, initial.record.message_id)!.release!.turn_id;
  for (const record of inputs) { assert.equal(record.release!.turn_id, release); assert.ok(record.release!.completed_at); assert.equal((record.adapter_fields!.browser_delivery as {phase:string}).phase, 'completed'); }
  assert.deepEqual(new Set(answers[0].adapter_fields!.submission_ids as string[]), new Set(['start', 'csv-observation', 'second-observation', 'colleague']));
  assert.equal(readBrowserActivity(store, conversation).activity!.state, 'completed');
  assert.equal((await loop.pass([])).released.length, 0);
});

test('unknown steering delivery survives final response and restart without blind replay', async (t) => {
  const { store, submit, harness, writer, loop, conversation } = setup(t);
  submit('start', '', 'mira', 'start');
  const h = harness as typeof harness & { steer: () => Promise<never> };
  h.steer = async () => { throw new Error('synthetic transport disappeared after send'); };
  harness.turn = async (_s, params) => {
    harness.session.turns.push(params); params.onStarted!({ threadId: params.threadId, turnId: 'native-one' });
    submit('unknown', 'distinct accepted maybe consumed'); await loop.browserDelivery;
    writer({ conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: 'fixture ending' });
    return { thread_id: params.threadId, status: 'completed', turn_id: 'native-one', client_user_message_id: params.clientUserMessageId, completed_at: new Date().toISOString(), error: null, items: [], agent_message: null, token_usage: null, events: [] }; 
  };
  await loop.pass([]);
  const unknown = store.recordsIn(conversation).find((r) => r.platform_message_id === 'unknown')!;
  assert.equal((unknown.adapter_fields!.browser_delivery as {phase:string}).phase, 'uncertain'); assert.equal(unknown.release!.completed_at, undefined);
  assert.equal(readBrowserActivity(store, conversation).activity!.state, 'uncertain');
  loop.recovering = loop.recover(); submit('later', 'do not race unknown delivery');
  await loop.pass([]); assert.equal(harness.session.turns.length, 1);
  assert.equal(store.read(conversation, unknown.message_id)!.release!.completed_at, undefined);
});

test('structural commentary alone persists activity without final reply/fence or private reasoning', async (t) => {
  const { store, submit, harness, writer, loop, conversation, bridge, key } = setup(t);
  submit('start', '', 'mira', 'start');
  harness.turn = async (_s, params) => {
    params.onStarted!({ threadId: params.threadId, turnId: 'native-one' });
    const e = (kind: string, payload: object) => loop.acceptBrowserEvent({ kind, threadId: params.threadId, turnId: 'native-one', params: payload });
    e('message.delta', { itemId: 'unphased', delta: 'secret unknown phase' });
    e('item.completed', { item: { id: 'reasoning', type: 'reasoning', text: 'private thought' } });
    e('item.completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'not progress' } });
    assert.equal(readBrowserActivity(store, conversation).activity!.update, null);
    const prior = bridge.read('fixture', key); const wait = bridge.watch('fixture', key, { after: prior.cursor, activityAfter: prior.activity_cursor, timeoutMs: 1000 });
    e('message.delta', { itemId: 'public', delta: 'Checking the two cutoff values.' });
    e('item.completed', { item: { id: 'public', type: 'agentMessage', phase: 'commentary', text: 'Checking the two cutoff values.' } });
    const update = await wait; assert.ok(update.activity_cursor > prior.activity_cursor); assert.equal(update.activity!.update!.item_id, 'public');
    assert.equal(store.readRequest(store.activeBrowserReply!.release_id), null); assert.equal(store.recordsIn(conversation).filter((r) => r.direction === 'outbound').length, 0);
    writer({ conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: 'fixture ending' });
    return { thread_id: params.threadId, status: 'completed', turn_id: 'native-one', client_user_message_id: params.clientUserMessageId, completed_at: new Date().toISOString(), error: null, items: [], agent_message: null, token_usage: null, events: [] }; 
  };
  await loop.pass([]);
  const reopened = createBrowserBridge({ store: Store.open(store.dir), agent: 'synthetic-agent', account: 'synthetic', authorize: () => true }).read('fixture', key);
  assert.equal(reopened.activity!.state, 'completed'); assert.equal(reopened.activity!.update!.text, 'Checking the two cutoff values.');
  const text = JSON.stringify(reopened.activity); assert.ok(!text.includes('private thought')); assert.ok(!text.includes('secret unknown phase')); assert.ok(!text.includes('not progress'));
});

test('unchanged record and activity cursors wait boundedly instead of hot spinning', async (t) => {
  const { store, bridge, conversation, key } = setup(t);
  writeBrowserActivity(store, conversation, { state: 'accepted', release_id: null, native_turn_id: null, submission_ids: [], update: null, reason: null });
  const page = bridge.read('fixture', key); const started = performance.now();
  const same = await bridge.watch('fixture', key, { after: page.cursor, activityAfter: page.activity_cursor, timeoutMs: 45 });
  assert.ok(performance.now() - started >= 35); assert.equal(same.activity_cursor, page.activity_cursor);
});


test('completed native turns with no accepted reply retain failed release activity after the single follow-up', async (t) => {
  const { store, submit, harness, loop, conversation } = setup(t);
  submit('start', '', 'mira', 'start');
  harness.turn = async (_s, params) => {
    harness.session.turns.push(params); params.onStarted!({ threadId: params.threadId, turnId: `native-${harness.session.turns.length}` });
    return { thread_id: params.threadId, status: 'completed', turn_id: `native-${harness.session.turns.length}`, client_user_message_id: params.clientUserMessageId, completed_at: new Date().toISOString(), error: null, items: [], agent_message: 'No reply tool was available in this fixture.', token_usage: null, events: [] };
  };
  await loop.pass([]);
  assert.equal(harness.session.turns.length, 2);
  assert.equal(store.recordsIn(conversation).filter((r) => r.direction === 'outbound').length, 0);
  const record = store.recordsIn(conversation)[0];
  assert.equal(record.disposition, 'parked');
  assert.equal((record.adapter_fields!.browser_delivery as {phase:string}).phase, 'failed');
  assert.equal(readBrowserActivity(store, conversation).activity!.state, 'failed');
  assert.equal((await loop.pass([])).released.length, 0);
});


test('structural ended-turn rejection retains input for the next same-conversation turn', async (t) => {
  const { store, submit, harness, writer, loop, conversation } = setup(t);
  submit('start', '', 'mira', 'start');
  const extended = harness as typeof harness & { steer: () => Promise<never>; classifySteerFailure: typeof classifySteerFailure; readThread: () => Promise<unknown> };
  extended.steer = async () => { throw new RpcError('turn/steer', { code: -32600, message: 'synthetic native rejection' }); };
  extended.classifySteerFailure = classifySteerFailure;
  extended.readThread = async () => ({ thread: { id: 'thread-1', turns: [{ id: 'native-one', status: 'completed' }] } });
  harness.turn = async (_s, params) => {
    harness.session.turns.push(params); const first = harness.session.turns.length === 1;
    params.onStarted!({ threadId: params.threadId, turnId: first ? 'native-one' : 'native-two' });
    if (first) { submit('after-end', 'a distinctive continuation'); await loop.browserDelivery; }
    writer({ conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: first ? 'first ending' : 'continuation ending' });
    return { thread_id: params.threadId, status: 'completed', turn_id: first ? 'native-one' : 'native-two', client_user_message_id: params.clientUserMessageId, completed_at: new Date().toISOString(), error: null, items: [], agent_message: null, token_usage: null, events: [] };
  };
  await loop.pass([]);
  const continuation = store.recordsIn(conversation).find((r) => r.platform_message_id === 'after-end')!;
  assert.equal((continuation.adapter_fields!.browser_delivery as {phase:string}).phase, 'next_turn'); assert.equal(continuation.release, undefined);
  await loop.pass([]);
  assert.equal(harness.session.turns.length, 2);
  assert.ok(store.read(conversation, continuation.message_id)!.release!.completed_at);
  assert.equal(store.recordsIn(conversation).filter((r) => r.direction === 'outbound').length, 2);
});

test('restart after durable steering intent holds the exact input and visibly projects uncertainty', async (t) => {
  const { store, submit, harness, loop, conversation } = setup(t);
  const pending = submit('lost-intent', 'retained exact input');
  store.annotate(pending.record, { browser_delivery: { attempt_id: 'retained-attempt', phase: 'dispatching', native_turn_id: 'ended-native' } });
  loop.recovering = loop.recover();
  await loop.pass([]);
  assert.equal(harness.session.turns.length, 0);
  const read = store.read(conversation, pending.record.message_id)!;
  assert.equal(read.body, 'retained exact input');assert.equal((read.adapter_fields!.browser_delivery as {phase:string}).phase, 'uncertain');
  assert.equal(readBrowserActivity(store, conversation).activity!.state, 'uncertain');
});
