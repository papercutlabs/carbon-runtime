import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import * as browser from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { ReleaseLoop, sandboxDenyBody, checkSandboxDeny } from '../runtime/loop.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import type { Declaration } from '../runtime/types.ts';

const account = 'test-account';
const agent = 'test-agent';
function owned(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-browser-owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: Store.open(path.join(root, 'store')) };
}
function packet(id: string, key = 'CASE-101', name = 'A', kind: browser.BrowserPacket['request_kind'] = 'investigate') {
  return browser.browserPacket({ account, ticket_key: key, submission_id: id, consultant: { id: name, name },
    request_kind: kind, body: `${name} distinctive request ${id}`, accepted_at: '2026-10-06T00:00:00Z', position: id.padStart(20, '0') });
}
function bridge(store: Store) {
  return createBrowserBridge({ store, account, agent, authorize: (grant, key, operation) => grant === 'operator'
    || (grant === 'A' || grant === 'B') && key === 'CASE-101' && operation !== 'operator' });
}
function declaration(): Declaration {
  return { agent: { id: agent }, model: 'fixture', effort: 'low', provider: { name: 'openai', auth: 'chatgpt' },
    sandbox: { mode: 'read-only', network: false }, unit_of_work: { kind: 'conversation' }, teaching: { enabled: false }, records: { enabled: false },
    tool_servers: [], channels: [{ kind: 'browser', account, release: 'quiet', quiet_ms: 0, default_conversation_kind: 'ops' }] };
}

test('authenticated bridge retains two consultants, exact retry, changed-payload refusal and separate ticket', (t) => {
  const { root, store } = owned(t);
  const b = bridge(store);
  const first = b.submit('A', packet('1'));
  assert.equal(first.duplicate, false);
  assert.equal(b.submit('A', packet('1')).duplicate, true);
  assert.throws(() => b.submit('A', { ...packet('1'), body: 'changed' }), /BROWSER_SUBMISSION_CONFLICT/);
  assert.throws(() => b.submit('A', packet('1', 'CASE-102')), /BROWSER_ACCESS_DENIED/);
  assert.throws(() => b.submit(null, packet('3')), /BROWSER_ACCESS_DENIED/);
  b.submit('B', packet('2', 'CASE-101', 'B', 'follow_up'));
  b.submit('operator', packet('4', 'CASE-102', 'B'));
  const reopened = bridge(Store.open(path.join(root, 'store')));
  const rows = reopened.read('A', 'CASE-101').records;
  assert.deepEqual(rows.map((row) => row.record.sender_id), ['A', 'B']);
  assert.equal(rows.length, 2);
  assert.equal(reopened.read('operator', 'CASE-102').records.length, 1);
  assert.throws(() => reopened.operatorRead('A', 'CASE-101'), /BROWSER_ACCESS_DENIED/);
  assert.equal(store.rebuild().length, 3);
});

test('bounded event wait observes real store capture and respects grant revocation and abort', async (t) => {
  const { store } = owned(t);
  const b = bridge(store);
  b.submit('A', packet('1'));
  const cursor = b.read('B', 'CASE-101').cursor;
  const waiting = b.watch('B', 'CASE-101', { after: cursor, timeoutMs: 1000 });
  b.submit('A', packet('2'));
  assert.equal((await waiting).records[0].record.platform_message_id, '2');
  const abort = new AbortController();
  const stopped = b.watch('B', 'CASE-101', { after: b.read('B', 'CASE-101').cursor, timeoutMs: 1000, signal: abort.signal });
  abort.abort();
  await assert.rejects(stopped, /BROWSER_WAIT_ABORTED/);
  let granted = true;
  const revocable = createBrowserBridge({ store, account, agent, authorize: () => granted });
  const revoked = revocable.watch('x', 'CASE-101', { after: b.read('B', 'CASE-101').cursor, timeoutMs: 10 });
  granted = false;
  await assert.rejects(revoked, /BROWSER_ACCESS_DENIED/);
});

test('actual loop consumes fresh ticket, all retained attribution, copy-draft on follow-up and thread resume', async (t) => {
  const { root, store } = owned(t);
  const b = bridge(store);
  const decl = declaration();
  let current = 'distinctive-ticket-before';
  let reads = 0;
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn: (_s, params) => {
    replyHandler({ store, agent, declaration: decl })({ conversation_id: browser.browserConversationId(account, 'CASE-101'),
      request_id: params.clientUserMessageId, text: 'synthetic stored answer' });
    return 'completed';
  } });
  const make = () => new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, agent, adapter: browser,
    harness, session: harness.session, checkout: root, work: root,
    prepareBrowserTurn: async ({ ticketKey }) => { reads++; return { data: { key: ticketKey, description: current }, provenance: { fetchedAt: new Date().toISOString() } }; } });
  b.submit('A', packet('1'));
  let loop = make();
  const result = await loop.pass([]);
  assert.equal(result.released.length, 1);
  assert.match(harness.session.turns[0].input, /distinctive-ticket-before/);
  assert.equal(b.read('B', 'CASE-101').records.at(-1)?.record.direction, 'outbound');
  b.submit('B', packet('2', 'CASE-101', 'B', 'copy_draft'));
  current = 'distinctive-ticket-after';
  loop = make(); // a fresh supported loop resumes the durable canonical unit
  loop.recovering = loop.recover();
  await loop.pass([]);
  const next = harness.session.turns[1];
  assert.match(next.input, /distinctive-ticket-after/);
  assert.match(next.input, /A distinctive request 1/);
  assert.match(next.input, /synthetic stored answer/);
  assert.match(next.input, /copy_draft/);
  assert.equal(reads, 2);
  assert.equal(harness.session.resumed?.length, 1);
  assert.deepEqual(next.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(store.rebuild().length, 4, 'context projection inserts no visible pseudo messages');
});

test('model acceptance then crash is visible uncertain and a competing follow-up never dispatches', async (t) => {
  const { root, store } = owned(t);
  const b = bridge(store);
  const decl = declaration();
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  let starts = 0;
  const crashing = { ...harness, async turn(_session: unknown, params: { threadId: string; onStarted?: (value: { threadId: string; turnId: string }) => void }) {
    starts++; params.onStarted?.({ threadId: params.threadId, turnId: 'native-accepted-17' });
    throw new Error('synthetic transport loss after native acceptance');
  }, async readThread() { return { thread: { id: 'thread-1', turns: [{ id: 'native-accepted-17', status: 'inProgress' }] } }; } };
  const make = () => new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, agent, adapter: browser,
    harness: crashing, session: harness.session, checkout: root, work: root, prepareBrowserTurn: async () => ({ data: { key: 'CASE-101' } }) });
  b.submit('A', packet('1'));
  await assert.rejects(make().pass([]), /synthetic transport loss/);
  b.submit('B', packet('2', 'CASE-101', 'B', 'follow_up'));
  const restart = make();
  restart.recovering = restart.recover();
  assert.deepEqual(restart.recovering.reissue, []);
  assert.equal(restart.recovering.unknown.length, 1);
  const resumed = await restart.pass([]);
  assert.equal(starts, 1, 'uncertain native acceptance must never be blindly reissued');
  assert.equal(resumed.held.length, 2);
  const evidence = b.operatorRead('operator', 'CASE-101');
  assert.equal(evidence.uncertain.length, 1);
  assert.deepEqual((evidence.uncertain[0].evidence as { native_turn_ids: string[] }).native_turn_ids, ['native-accepted-17']);
  assert.equal((evidence.uncertain[0].evidence as { dispatch_attempts: number }).dispatch_attempts, 1);
  assert.match(JSON.stringify(evidence), /native-accepted-17/);
});

test('browser pages rebuild once, read only requested warm rows, refresh real state and survive Store replacement', (t) => {
  const { store } = owned(t);
  const b = bridge(store);
  for (let i = 1; i <= 30; i++) {
    b.submit('A', { ...packet(String(i)), body: 'x'.repeat(10000) });
    b.submit('operator', { ...packet(String(i), 'CASE-202', 'B'), body: 'y'.repeat(10000) });
  }
  const nativeRead = fs.readFileSync;
  let files = 0;
  let bytes = 0;
  t.mock.method(fs, 'readFileSync', (...args: unknown[]) => {
    const value = Reflect.apply(nativeRead, fs, args);
    files++; bytes += Buffer.byteLength(value);
    return value;
  });
  const first = b.read('A', 'CASE-101', { limit: 3 });
  const cold = { files, bytes };
  files = 0; bytes = 0;
  for (let reader = 0; reader < 3; reader++) b.read('A', 'CASE-101', { after: first.cursor, limit: 3 });
  const warm = { files, bytes };
  assert.equal(warm.files, 9, 'three readers each reread exactly three requested full records, with no global index reread');
  console.log('browser-projection-cost', JSON.stringify({ retained_records: 60, ticket_records: 30, page_size: 3, readers: 3, cold, warm }));
  const changed = first.records[0].record;
  store.annotate(changed, { model_effect: 'uncertain', model_effect_evidence: { native_turn_id: 'projection-state' } });
  const update = b.read('A', 'CASE-101', { after: b.read('A', 'CASE-101', { limit: 100 }).records.filter((row) => row.record.message_id !== changed.message_id).at(-1)!.cursor });
  assert.equal(update.records[0].record.message_id, changed.message_id);
  assert.equal(update.records[0].event, 'state');
  assert.match(JSON.stringify(update), /projection-state/);
  const fresh = b.submit('B', packet('31', 'CASE-101', 'B'));
  assert.equal(b.read('A', 'CASE-101', { after: update.cursor }).records[0].record.message_id, fresh.record.message_id);
  const replaced = new Store(store.dir);
  const rebuilt = bridge(replaced).read('A', 'CASE-101', { limit: 100 });
  assert.equal(rebuilt.records.length, 31);
  assert.equal(rebuilt.cursor, b.read('A', 'CASE-101', { limit: 100 }).cursor);
  assert.match(JSON.stringify(rebuilt), /projection-state/);
});

test('browser sandbox gate refuses legacy paths; authoritative stores never appear in writable roots', (t) => {
  const { root } = owned(t);
  const file = path.join(root, 'requirements.toml');
  fs.writeFileSync(file, sandboxDenyBody(root), { mode: 0o644 });
  const gate = { file, root, ownerUid: process.getuid!(), browser: true };
  assert.throws(() => checkSandboxDeny(gate, 'test'), /SANDBOX_DENY_NOT_PLACED/);
  fs.writeFileSync(file, sandboxDenyBody(root, true));
  checkSandboxDeny(gate, 'test');
  for (const denied of ['store', 'codex-home', 'companion-private', 'secrets']) assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`${root}/${denied}`));
});


test('uncertain no-answer state wakes a browser waiter with a durable advanced cursor and no new message', async (t) => {
  const { store } = owned(t);
  const b = bridge(store);
  const accepted = b.submit('A', packet('1')).record;
  const before = b.read('A', 'CASE-101').cursor;
  const waiting = b.watch('A', 'CASE-101', { after: before, timeoutMs: 1000 });
  store.annotate(accepted, { model_effect: 'uncertain', model_effect_evidence: { native_turn_id: 'native-no-answer' } });
  const changed = await waiting;
  assert.equal(changed.records.length, 1);
  assert.equal(changed.records[0].event, 'state');
  assert.equal(changed.records[0].record.message_id, accepted.message_id);
  assert.equal(changed.records[0].record.adapter_fields?.model_effect, 'uncertain');
  assert.ok(changed.cursor > before);
  assert.equal(store.rebuild().length, 1, 'effect evidence cannot fabricate a visible message');
  const idle = await b.watch('A', 'CASE-101', { after: changed.cursor, timeoutMs: 10 });
  assert.deepEqual(idle.records, []);
  assert.equal(idle.cursor, changed.cursor, 'an unchanged state cannot hotspin an event cursor');
});

test('browser reply tool refuses another ticket and an inactive/stale release', (t) => {
  const { store } = owned(t);
  const b = bridge(store);
  b.submit('A', packet('1'));
  b.submit('operator', packet('2', 'CASE-102'));
  const writer = replyHandler({ store, agent });
  store.activeBrowserReply = { conversation_id: browser.browserConversationId(account, 'CASE-101'), release_id: 'active-release' };
  assert.throws(() => writer({ conversation_id: browser.browserConversationId(account, 'CASE-102'), request_id: 'active-release', text: 'wrong ticket' }), /BROWSER_REPLY_SCOPE_REFUSED/);
  assert.throws(() => writer({ conversation_id: browser.browserConversationId(account, 'CASE-101'), request_id: 'stale-release', text: 'wrong release' }), /BROWSER_REPLY_SCOPE_REFUSED/);
  store.activeBrowserReply = null;
  assert.throws(() => writer({ conversation_id: browser.browserConversationId(account, 'CASE-101'), request_id: 'active-release', text: 'inactive' }), /BROWSER_REPLY_SCOPE_REFUSED/);
  assert.equal(store.rebuild().filter((record) => record.direction === 'outbound').length, 0);
});

test('shared Store capture wakes the real runtime drain without a periodic browser poll', async (t) => {
  const { root, store } = owned(t);
  const b = bridge(store);
  const decl = declaration();
  decl.channels![0].poll_interval_ms = 60000;
  const { run } = await import('../runtime/index.ts');
  const gate = { file: path.join(root, 'requirements.toml'), root, ownerUid: process.getuid!(), browser: true };
  fs.writeFileSync(gate.file, sandboxDenyBody(root, true), { mode: 0o644 });
  const work = path.join(root, 'work');
  const repo = path.join(root, 'repo');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [work, repo, codexHome]) fs.mkdirSync(dir);
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn: (_session, params) => {
    replyHandler({ store, agent, declaration: decl })({ conversation_id: browser.browserConversationId(account, 'CASE-101'), request_id: params.clientUserMessageId, text: 'event-woken fixture answer' });
    return 'completed';
  } });
  let passes = 0;
  const running = run({ declaration: decl, declarationPath: path.join(root, 'carbon.agent.json'), store, storeDir: store.dir,
    codexHome, checkout: repo, work, harnessRoot: root, binary: '/synthetic/never-spawned', replyPort: 0, harness,
    passes: 2, sandboxDeny: gate, items: () => { passes++; return []; }, prepareBrowserTurn: async () => ({ data: { key: 'CASE-101' } }) });
  const deadline = setTimeout(() => { process.emit('SIGTERM', 'SIGTERM'); }, 1500);
  const submitted = setTimeout(() => { b.submit('A', packet('1')); }, 30);
  t.after(() => { clearTimeout(deadline); clearTimeout(submitted); });
  const started = performance.now();
  const code = await running;
  clearTimeout(deadline);
  assert.equal(code, 0);
  assert.equal(passes, 2);
  assert.equal(harness.session.turns.length, 1);
  assert.ok(performance.now() - started < 1400, 'capture waited for the sixty-second legacy poll instead of waking the runtime');
  assert.equal(b.read('B', 'CASE-101').records.filter((row) => row.record.direction === 'outbound').length, 1);
  assert.equal(store.browserListeners.size, 0, 'runtime cleanup must remove its wake subscriber');
});

test('wrong current-ticket identity and oversized full context refuse before model dispatch', async (t) => {
  for (const snapshot of [{ data: { key: 'CASE-102' } }, { data: { key: 'CASE-101', description: 'x'.repeat(4 * 1024 * 1024) } }]) {
    const { root, store } = owned(t);
    const b = bridge(store);
    const decl = declaration();
    const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
    const accepted = b.submit('A', packet('1'));
    const loop = new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, agent,
      adapter: browser, harness, session: harness.session, checkout: root, work: root, prepareBrowserTurn: async () => snapshot });
    const result = await loop.pass([]);
    assert.equal(harness.session.turns.length, 0);
    assert.equal(result.parked.length, 1);
    const persisted = store.read(accepted.record.conversation_id, accepted.record.message_id)!;
    assert.equal(persisted.body, accepted.record.body, 'capacity refusal must retain accepted history');
    assert.match(JSON.stringify(persisted.adapter_fields?.park_faults), /BROWSER_TICKET_IDENTITY_MISMATCH|BROWSER_CONTEXT_CAPACITY/);
  }
});

test('qualified browser thread refuses leftover other-ticket workspace material before model open', async (t) => {
  const { root, store } = owned(t);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'other-ticket.txt'), 'distinctive-other-ticket-value');
  const gate = { file: path.join(root, 'requirements.toml'), root, ownerUid: process.getuid!(), browser: true };
  fs.writeFileSync(gate.file, sandboxDenyBody(root, true), { mode: 0o644 });
  const decl = declaration();
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  bridge(store).submit('A', packet('1'));
  const loop = new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, agent,
    adapter: browser, harness, session: harness.session, checkout: root, work, sandboxDeny: gate, prepareBrowserTurn: async () => ({ data: { key: 'CASE-101' } }) });
  await assert.rejects(loop.pass([]), /BROWSER_WORKSPACE_NOT_ISOLATED/);
  assert.equal(harness.session.opens?.length ?? 0, 0);
  assert.equal(harness.session.turns.length, 0);
});
