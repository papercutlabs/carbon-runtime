import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import * as browser from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { ReleaseLoop, sandboxDenyBody } from '../runtime/loop.ts';
import { replyHandler, createReplyServer, type BrowserReplyValidator } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import type { Declaration } from '../runtime/types.ts';
import { RpcError } from '../harness/codex/protocol.ts';
import { EXIT } from '../runtime/faults.ts';
const account = 'test-account';
const agent = 'test-agent';
const key = 'CASE-101';
const conversation = browser.browserConversationId(account, key);
function owned(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-browser-correction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = Store.open(path.join(root, 'store'));
  const bridge = createBrowserBridge({ store, agent, account, authorize: () => true });
  const submit = (id: string, requestKind: browser.BrowserPacket['request_kind']) => bridge.submit('synthetic-grant', {
    account, ticket_key: key, submission_id: id, consultant: { id, name: id }, request_kind: requestKind,
    body: `distinct ${requestKind} ${id}`, accepted_at: '2026-10-06T00:00:00Z', position: String(store.nextSeq()).padStart(20, '0') });
  const declaration: Declaration = { agent: { id: agent }, model: 'fixture', effort: 'low', provider: { name: 'openai', auth: 'chatgpt' },
    sandbox: { mode: 'read-only', network: false }, unit_of_work: { kind: 'conversation' }, records: { enabled: false }, teaching: { enabled: false }, tool_servers: [],
    channels: [{ kind: 'browser', account, release: 'quiet', quiet_ms: 0, poll_interval_ms: 60000, default_conversation_kind: 'ops' }] };
  const loop = (harness: ReturnType<typeof fakeHarness>) => new ReleaseLoop({ declaration, channel: declaration.channels![0], store,
    storeDir: store.dir, agent, adapter: browser, harness, session: harness.session, checkout: root, work: root,
    prepareBrowserTurn: async () => ({ data: { key } }) });
  return { root, store, bridge, submit, declaration, loop };
}

test('queued browser follow-up and copy draft keep distinct serial releases, replies and event identities', async (t) => {
  const { store, bridge, submit, declaration, loop } = owned(t);
  const accepted = [submit('first', 'follow_up').record, submit('second', 'copy_draft').record];
  const seen: Parameters<BrowserReplyValidator>[0][] = [];
  const writer = replyHandler({ store, agent, declaration, validateBrowserReply: (input) => { seen.push(input); return []; } });
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn: (_session, params) => {
    const release = store.activeBrowserReply!.release_id;
    const inbound = store.recordsIn(conversation).find((record) => record.direction === 'inbound' && record.release?.turn_id === release)!;
    writer({ conversation_id: conversation, request_id: release, text: `qualified ${inbound.adapter_fields!.request_kind}` });
    assert.equal(params.clientUserMessageId, release);
    return 'completed';
  } });
  const result = await loop(harness).pass([]);
  assert.equal(result.released.length, 2);
  assert.equal(harness.session.turns.length, 2);
  const sources = accepted.map((record) => store.read(conversation, record.message_id)!);
  assert.notEqual(sources[0].release!.turn_id, sources[1].release!.turn_id);
  assert.deepEqual(seen.map((input) => [input.submissionId, input.requestKind]), [['first', 'follow_up'], ['second', 'copy_draft']]);
  const outbound = bridge.read('synthetic-grant', key).records.filter((row) => row.record.direction === 'outbound');
  assert.equal(outbound.length, 2);
  assert.equal(new Set(outbound.map((row) => row.cursor)).size, 2);
  assert.deepEqual(outbound.map((row) => [row.record.adapter_fields!.submission_id, row.record.body]), [['first', 'qualified follow_up'], ['second', 'qualified copy_draft']]);
  assert.deepEqual(outbound.map((row) => row.record.reply_to), accepted.map((record) => record.message_id));
  for (const row of outbound) {
    assert.equal(row.record.delivery!.status, 'sent');
    assert.equal('draft_label' in row.record.adapter_fields!, false);
  }
});

test('uncertain first queued release holds the second before dispatch in that same pass', async (t) => {
  const { store, submit, loop } = owned(t);
  submit('first', 'follow_up');
  const second = submit('second', 'copy_draft').record;
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn: () => 'interrupted' });
  const result = await loop(harness).pass([]);
  assert.equal(harness.session.turns.length, 1);
  assert.ok(result.held.includes(second.message_id));
  assert.equal(store.read(conversation, second.message_id)!.release, undefined);
});

test('client body refusal retains original failed bytes and repairs through the existing release before acceptance', async (t) => {
  const { store, bridge, submit, declaration, loop } = owned(t);
  const accepted = submit('first', 'copy_draft').record;
  let validations = 0;
  const writer = replyHandler({ store, agent, declaration, validateBrowserReply: ({ text, requestKind, submissionId }) => {
    validations++;
    assert.equal(requestKind, 'copy_draft'); assert.equal(submissionId, 'first');
    return text === 'qualified original bytes' ? [] : [{ code: 'CLIENT_BODY_REFUSED', subject: 'response', problem: 'synthetic client validator refused the original bytes', fix: 'return qualified bytes' }];
  } });
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn: (_session, _params, turn) => {
    const args = { conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: turn === 1 ? '{malformed original' : 'qualified original bytes' };
    if (turn === 1) {
      assert.throws(() => writer(args), /CLIENT_BODY_REFUSED/);
      assert.equal(store.readRequest(args.request_id), null, 'refusal precedes pending/sent fence acceptance');
    } else writer(args);
    return 'completed';
  } });
  await loop(harness).pass([]);
  const responses = bridge.operatorRead('synthetic-grant', key).records.filter((record) => record.direction === 'outbound');
  assert.equal(validations, 2); assert.equal(harness.session.turns.length, 2);
  assert.deepEqual(responses.map((record) => [record.revision, record.delivery!.status, record.body]), [[0, 'failed', '{malformed original'], [1, 'sent', 'qualified original bytes']]);
  assert.match(JSON.stringify(responses[0].adapter_fields!.reply_validation_faults), /CLIENT_BODY_REFUSED/);
  const release = store.read(conversation, accepted.message_id)!.release!.turn_id;
  assert.ok(responses.every((record) => record.delivery!.request_id === release));
  assert.equal(store.readRequest(release)!.revision, 1);
});

test('missing browser validator refuses acceptance and retains failed output without a fence', (t) => {
  const { store, submit } = owned(t);
  const inbound = submit('first', 'follow_up').record;
  store.release(inbound, { released_at: new Date().toISOString(), thread_id: 'fixture-thread', turn_id: 'fixture-release', now: Date.now(), hold_applies: false });
  store.activeBrowserReply = { conversation_id: conversation, release_id: 'fixture-release' };
  assert.throws(() => replyHandler({ store, agent })({ conversation_id: conversation, request_id: 'fixture-release', text: 'unqualified bytes' }), /BROWSER_REPLY_VALIDATOR_ABSENT/);
  assert.equal(store.readRequest('fixture-release'), null);
  assert.equal(store.recordsIn(conversation).find((record) => record.direction === 'outbound')!.delivery!.status, 'failed');
  store.activeBrowserReply = null;
});

test('throwing or asynchronous client validator never silently accepts browser output', (t) => {
  const { store, submit } = owned(t);
  const inbound = submit('first', 'investigate').record;
  store.release(inbound, { released_at: new Date().toISOString(), thread_id: 'fixture-thread', turn_id: 'fixture-release', hold_applies: false });
  store.activeBrowserReply = { conversation_id: conversation, release_id: 'fixture-release' };
  const callbacks: unknown[] = [() => { throw new Error('synthetic malformed JSON'); }, async () => []];
  for (const callback of callbacks) {
    assert.throws(() => replyHandler({ store, agent, validateBrowserReply: callback as BrowserReplyValidator })(
      { conversation_id: conversation, request_id: 'fixture-release', text: 'retained original bytes' }), /BROWSER_REPLY_VALIDATOR_FAILED/);
    assert.equal(store.readRequest('fixture-release'), null);
  }
  assert.equal(store.recordsIn(conversation).filter((record) => record.direction === 'outbound' && record.delivery!.status === 'failed').length, 2);
  store.activeBrowserReply = null;
});

test('MCP reply acceptance invokes the exact shared client callback before writing the fence', async (t) => {
  const { store, submit, declaration } = owned(t);
  const inbound = submit('first', 'copy_draft').record;
  store.release(inbound, { released_at: new Date().toISOString(), thread_id: 'fixture-thread', turn_id: 'fixture-release', hold_applies: false });
  store.activeBrowserReply = { conversation_id: conversation, release_id: 'fixture-release' };
  const calls: string[] = [];
  const server = createReplyServer({ store, agent, declaration, validateBrowserReply: (input) => {
    assert.equal(input.submissionId, 'first'); assert.equal(input.requestKind, 'copy_draft');
    calls.push(input.text);
    return input.text === 'qualified exact bytes' ? [] : [{ code: 'CLIENT_BODY_REFUSED', subject: 'response', problem: 'synthetic body refusal', fix: 'return qualified exact bytes' }];
  } });
  const call = (id: number, text: string) => server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'reply', arguments: { conversation_id: conversation, request_id: 'fixture-release', text } } });
  const invalid = await call(1, 'malformed exact bytes');
  assert.match(JSON.stringify(invalid), /CLIENT_BODY_REFUSED/);
  assert.equal(store.readRequest('fixture-release'), null);
  const qualified = await call(2, 'qualified exact bytes');
  assert.match(JSON.stringify(qualified), /written/);
  assert.equal(store.readRequest('fixture-release')!.revision, 1);
  assert.deepEqual(calls, ['malformed exact bytes', 'qualified exact bytes']);
  store.activeBrowserReply = null;
});

test('native child settlement wakes the existing idle browser drain and returns its exit code', async (t) => {
  const { root, store, declaration } = owned(t);
  const { run } = await import('../runtime/index.ts');
  const work = path.join(root, 'work');
  const checkout = path.join(root, 'repo');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [work, checkout, codexHome]) fs.mkdirSync(dir);
  const gate = { file: path.join(root, 'requirements.toml'), root, ownerUid: process.getuid!(), browser: true };
  fs.writeFileSync(gate.file, sandboxDenyBody(root, true), { mode: 0o644 });
  const harness = fakeHarness();
  let passes = 0;
  const running = run({ declaration, declarationPath: path.join(root, 'carbon.agent.json'), store, storeDir: store.dir,
    codexHome, checkout, work, harnessRoot: root, binary: '/synthetic/never-spawned', replyPort: 0, harness,
    sandboxDeny: gate, items: () => { passes++; return []; }, validateBrowserReply: () => [], prepareBrowserTurn: async () => ({ data: { key } }) });
  const exit = setTimeout(() => harness.session.endChild({ code: 17, signal: null }), 250);
  const ceiling = setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 1000);
  t.after(() => { clearTimeout(exit); clearTimeout(ceiling); });
  const result = await running;
  clearTimeout(ceiling);
  assert.equal(result, EXIT.HARNESS_EXITED, 'idle Infinity wait must preserve the existing harness-exit status rather than settle from the timeout drain');
  assert.equal(passes, 1, 'the idle browser path must not poll while waiting');
  assert.equal(harness.session.stopped, true);
  assert.equal(store.browserListeners.size, 0);
});

test('turn and supported read catches preserve distinct redacted original/native code from captured native refusals', async (t) => {
  const { store, bridge, submit, loop } = owned(t);
  const captured = JSON.parse(fs.readFileSync(new URL('fixtures/native-invalid-reads.json', import.meta.url), 'utf8'));
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  harness.session.credentialValues = ['synthetic-private-token'];
  const failing = { ...harness,
    async turn(_session: unknown, params: { threadId: string; onStarted?: (value: { threadId: string; turnId: string }) => void }) {
      params.onStarted?.({ threadId: params.threadId, turnId: 'native-accepted-fixture' });
      throw new RpcError('turn/start', { code: captured.refusals[0].nativeCode, message: captured.refusals[0].originalReason + ' credential=synthetic-private-token' });
    },
    async readThread() { throw new RpcError('thread/read', { code: captured.refusals[1].nativeCode, message: captured.refusals[1].originalReason }); }
  };
  submit('first', 'investigate');
  await assert.rejects(loop(failing).pass([]), /Invalid request/);
  const restarted = loop(failing);
  restarted.recovering = restarted.recover();
  await restarted.pass([]);
  const evidence = bridge.operatorRead('synthetic-grant', key).uncertain[0].evidence as Record<string, unknown>;
  assert.equal(evidence.original_reason, captured.refusals[0].originalReason + ' credential=[REDACTED]');
  assert.equal(evidence.original_reason_available, true); assert.equal(evidence.native_code, -32600);
  const read = evidence.native_read as Record<string, unknown>;
  assert.equal(read.original_reason, captured.refusals[1].originalReason);
  assert.equal(read.original_reason_available, true); assert.equal(read.native_code, -32600);
  assert.deepEqual(evidence.native_turn_ids, ['native-accepted-fixture']);
  assert.equal(JSON.stringify(evidence).includes('synthetic-private-token'), false);
  assert.equal(store.activeBrowserReply, null);
});
