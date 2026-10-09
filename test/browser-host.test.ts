import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateInput, Type } from '@pcl/routes';
import { Store } from '../stream/store.ts';
import { browserConversationId } from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { createBrowserHost, messageView, templateOf, BROWSER_HOST_SCHEMA, HOST_ADAPTER_FIELDS, type MessageState } from '../runtime/browser-host.ts';
import { browserWorkspace } from '../runtime/browser-files.ts';
import { presentEvidence, toWireSelector, readEvidenceChanges, readEvidenceFragment, readEvidence } from '../runtime/browser-evidence.ts';
import { StreamFault } from '../stream/store.ts';
import { replyHandler } from '../runtime/reply-tool.ts';

const KEY = 'CASE-7';
const GRANT = 'fixture';
const alice = { id: 'alice', name: 'Alice' };

function setup(t: TestContext, validate: () => unknown[] = () => []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'work')); fs.mkdirSync(path.join(root, 'checkout'));
  const store = Store.open(path.join(root, 'store'));
  const account = 'synthetic', conversation = browserConversationId(account, KEY);
  const bridge = createBrowserBridge({ store, agent: 'synthetic-agent', account, authorize: (grant) => grant === GRANT });
  const host = createBrowserHost({ store, bridge, account });
  const workspace = browserWorkspace({ work: path.join(root, 'work'), conversationId: conversation, checkout: path.join(root, 'checkout') });
  const reply = replyHandler({ store, agent: 'synthetic-agent', validateBrowserReply: validate as never });
  let tick = 0;
  const at = (n: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, n)).toISOString();
  const submit = (id: string, text = 'question', extra: object = {}) => host.submitMessage(GRANT, { ticketKey: KEY, submissionId: id, consultant: alice, text,
    acceptedAt: at(++tick), position: String(store.nextSeq()).padStart(20, '0'), ...extra });
  const release = (id: string, turn: string) => {
    const record = store.read(conversation, `${conversation}:${id}`)!;
    store.release(record, { thread_id: 'thread', turn_id: turn, released_at: at(++tick), hold_applies: false });
    store.activeBrowserReply = { conversation_id: conversation, release_id: turn, native_turn_id: 'native', workspace };
    return record;
  };
  const read = (id: string) => store.read(conversation, id.includes(':') ? id : `${conversation}:${id}`)!;
  return { root, store, host, bridge, conversation, workspace, reply, submit, release, read, at, account };
}
const stateOf = async (s: ReturnType<typeof setup>, id: string): Promise<MessageState> => (await s.host.readMessage(GRANT, KEY, id.includes(':') ? id : `${s.conversation}:${id}`))!.state;

function validateView(name: string, value: unknown) {
  const defs = BROWSER_HOST_SCHEMA.$defs;
  const inline = (n: unknown): unknown => Array.isArray(n) ? n.map(inline) : n && typeof n === 'object'
    ? ((n as { $ref?: string }).$ref ? inline(defs[(n as { $ref: string }).$ref.split('/').pop()!])
      : Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'description').map(([k, v]) => [k, inline(v)]))) : n;
  return validateInput(Type.Unsafe(inline(defs[name]) as never), value);
}
function publish(s: ReturnType<typeof setup>, name: string, content: string, label: string, kind: 'original' | 'analysis', turn: string, template?: string) {
  const itemId = crypto.randomUUID(), changeId = crypto.randomUUID();
  const dir = kind === 'original' ? s.workspace.evidence : s.workspace.analysis, file = path.join(dir, name), bytes = Buffer.from(content);
  fs.writeFileSync(file, bytes, { mode: 0o400 });
  if (kind === 'original') fs.writeFileSync(file + '.provenance.json', JSON.stringify({ mediaType: 'text/plain', size: bytes.length,
    provenance: { url: 'https://source.invalid/page', fetchedAt: '2026-10-09T00:00:00Z' } }), { mode: 0o400 });
  s.store.activeBrowserReply = { conversation_id: s.conversation, release_id: turn, native_turn_id: 'native', workspace: s.workspace };
  presentEvidence(s.store, { agent: 'synthetic-agent', account: s.account, workspace: s.workspace, conversationId: s.conversation, releaseId: turn, turnId: 'native',
    delta: { changeId, add: [{ itemId, label, path: file, selector: toWireSelector(null), note: null, basis: [], assumptions: [], producerPath: null, ...(template === undefined ? {} : { template }) }], remove: [], note: null } });
  return itemId;
}

test('every state is derived from the stored records and validates against the published schema', async (t) => {
  let failing = false;
  const s = setup(t, () => failing ? [{ code: 'SHAPE', subject: 'body', problem: 'not the agreed shape', fix: 'x' }] : []);
  // accepted -> queued -> running -> answered
  await s.submit('a1');
  assert.equal(await stateOf(s, 'a1'), 'accepted');
  s.store.annotate(s.read('a1'), { browser_delivery: { phase: 'next_turn', reason: 'no steering' } });
  assert.equal(await stateOf(s, 'a1'), 'queued');
  s.release('a1', 'turn-1');
  assert.equal(await stateOf(s, 'a1'), 'running');
  s.reply({ conversation_id: s.conversation, request_id: 'turn-1', text: 'the answer', metadata: { draftLabel: 'Draft' } });
  const answer = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message).find((m) => m.role === 'agent')!;
  assert.equal(answer.state, 'answer'); assert.deepEqual(answer.submissionIds, ['a1']); assert.equal(answer.replyTo, `${s.conversation}:a1`); assert.equal(answer.turnId, 'turn-1');
  s.store.completeRelease(s.read('a1'), s.at(50));
  assert.equal(await stateOf(s, 'a1'), 'answer');
  // failed: reply validation parks the reply and the faults travel on the view
  await s.submit('a2'); s.release('a2', 'turn-2'); failing = true;
  assert.throws(() => s.reply({ conversation_id: s.conversation, request_id: 'turn-2', text: 'bad answer' }));
  const failed = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message).find((m) => m.state === 'failed')!;
  assert.equal(failed.validationFaults[0].code, 'SHAPE'); assert.equal(failed.validationFaults[0].problem, 'not the agreed shape');
  // uncertain and failed inputs
  await s.submit('a3'); s.store.annotate(s.read('a3'), { model_effect: 'uncertain', browser_delivery: { phase: 'uncertain', reason: 'native outcome unknown' } });
  assert.equal(await stateOf(s, 'a3'), 'uncertain'); assert.equal((await s.host.readMessage(GRANT, KEY, `${s.conversation}:a3`))!.nativeReason, 'native outcome unknown');
  await s.submit('a4'); s.store.annotate(s.read('a4'), { browser_delivery: { phase: 'failed' } });
  assert.equal(await stateOf(s, 'a4'), 'failed');
  // evidence_update
  publish(s, 'page.txt', 'original text', 'Page', 'original', 'turn-2');
  const all = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message);
  assert.ok(all.some((m) => m.state === 'evidence_update'));
  const seen = new Set(all.map((m) => m.state));
  for (const state of ['accepted', 'queued', 'running', 'answer', 'evidence_update', 'failed', 'uncertain']) assert.ok(seen.has(state as MessageState) || state === 'accepted' || state === 'queued' || state === 'running', state);
  for (const message of all) assert.deepEqual(validateView('message', message), [], JSON.stringify(message));
  assert.deepEqual(validateView('page', await s.host.readConversation(GRANT, KEY)), []);
});

test('the schema refuses a view with an unknown state, a missing field or an extra field', async (t) => {
  const s = setup(t); await s.submit('v1');
  const view = (await s.host.readMessage(GRANT, KEY, `${s.conversation}:v1`))!;
  assert.deepEqual(validateView('message', view), []);
  assert.notDeepEqual(validateView('message', { ...view, state: 'completed' }), []);
  const { nativeReason: _dropped, ...missing } = view; assert.notDeepEqual(validateView('message', missing), []);
  assert.notDeepEqual(validateView('message', { ...view, adapter_fields: {} }), []);
  assert.equal(BROWSER_HOST_SCHEMA.title, 'carbon.browser-host.v1'); assert.equal(view.schema, 'carbon.browser-host.v1');
});

test('an evidence publication is never an answer and the period summary counts it apart', async (t) => {
  const s = setup(t);
  await s.submit('p1', 'first'); await s.submit('p2', 'second');
  s.release('p1', 'turn-a'); s.release('p2', 'turn-b');
  publish(s, 'a.txt', 'one', 'A', 'original', 'turn-a'); publish(s, 'b.txt', 'two', 'B', 'analysis', 'turn-a');
  const evidence = s.store.recordsIn(s.conversation).filter((r) => r.adapter_fields?.[HOST_ADAPTER_FIELDS.evidenceChange]);
  assert.equal(evidence.length, 2);
  for (const record of evidence) { assert.equal(record.direction, 'outbound'); assert.equal(record.role, 'agent'); assert.equal(messageView(record).state, 'evidence_update'); }
  const to = new Date(Date.now() + 60000).toISOString();
  let summary = await s.host.readPeriodSummary(GRANT, [KEY], { from: s.at(0), to });
  assert.equal(summary.answers, 0); assert.equal(summary.evidenceUpdates, 2); assert.equal(summary.inputs, 2); assert.equal(summary.latency.medianMs, null);
  const active = (turn: string) => { s.store.activeBrowserReply = { conversation_id: s.conversation, release_id: turn, native_turn_id: 'native', workspace: s.workspace }; };
  active('turn-a');
  s.reply({ conversation_id: s.conversation, request_id: 'turn-a', text: 'answer with a label', metadata: { draftLabel: 'Draft' } });
  active('turn-b');
  s.reply({ conversation_id: s.conversation, request_id: 'turn-b', text: 'answer without one' });
  summary = await s.host.readPeriodSummary(GRANT, [KEY], { from: s.at(0), to: new Date(Date.now() + 60000).toISOString() });
  assert.equal(summary.answers, 2); assert.equal(summary.evidenceUpdates, 2); assert.equal(summary.unmarkedAnswers, 1); assert.equal(summary.inputs, 2);
  assert.equal(summary.latency.perAnswer.length, 2); assert.ok(summary.latency.perAnswer.every((one) => typeof one.ms === 'number' && one.ms >= 0));
  assert.deepEqual(validateView('periodSummary', summary), []);
  const empty = await s.host.readPeriodSummary(GRANT, [KEY], { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' });
  assert.deepEqual([empty.inputs, empty.answers, empty.evidenceUpdates], [0, 0, 0]);
});

test('the canvas exposes current evidence as templated items with provenance and history', async (t) => {
  const s = setup(t);
  await s.submit('c1'); s.release('c1', 'turn-c');
  const original = publish(s, 'src.txt', 'received text', 'Received source', 'original', 'turn-c');
  const analysis = publish(s, 'note.txt', 'derived text', 'Derived note', 'analysis', 'turn-c');
  const canvas = await s.host.readCanvas(GRANT, KEY);
  assert.deepEqual(validateView('canvas', canvas), []);
  assert.equal(canvas.total, 2);
  const byId = new Map(canvas.items.map((item) => [item.itemId, item]));
  assert.equal(byId.get(original)!.template, 'original'); assert.equal(byId.get(analysis)!.template, 'analysis');
  assert.equal((byId.get(original)!.source.provenance as { fetchedAt?: string }).fetchedAt, '2026-10-09T00:00:00Z');
  assert.equal(byId.get(analysis)!.source.provenance, null);
  assert.deepEqual(byId.get(original)!.history.map((h) => h.change), ['added']);
  s.store.activeBrowserReply = { conversation_id: s.conversation, release_id: 'turn-c', native_turn_id: 'native', workspace: s.workspace };
  presentEvidence(s.store, { agent: 'synthetic-agent', account: s.account, workspace: s.workspace, conversationId: s.conversation, releaseId: 'turn-c', turnId: 'native',
    delta: { changeId: crypto.randomUUID(), add: [], remove: [{ itemId: analysis, reason: 'superseded' }], note: null } });
  const after = await s.host.readCanvas(GRANT, KEY);
  assert.deepEqual(after.items.map((i) => i.itemId), [original]);
  const anchored = await s.host.readCanvas(GRANT, KEY, { anchor: canvas.items.length ? (await s.bridge.evidenceChanges(GRANT, KEY, {})).changes[1].changeId : null });
  assert.equal(anchored.total, 2);
  assert.equal(templateOf({ origin: 'original', template: 'original' }), 'original');
  assert.throws(() => templateOf({ origin: 'invented', template: 'x' }));
  assert.equal(templateOf({ origin: 'analysis', template: 'anything-the-package-says' }), 'anything-the-package-says');
});

test('an agent-supplied template round-trips through publication, reads, history and the canvas; the default is analysis', async (t) => {
  const s = setup(t);
  await s.submit('c1'); s.release('c1', 'turn-t');
  const custom = publish(s, 'a.txt', 'one', 'Custom', 'analysis', 'turn-t', 'cost-breakdown.v2');
  const plain = publish(s, 'b.txt', 'two', 'Plain', 'analysis', 'turn-t');
  const original = publish(s, 'c.txt', 'three', 'Source', 'original', 'turn-t', 'original');
  const canvas = await s.host.readCanvas(GRANT, KEY);
  assert.deepEqual(validateView('canvas', canvas), []);
  const byId = new Map(canvas.items.map((item) => [item.itemId, item.template]));
  assert.deepEqual([byId.get(custom), byId.get(plain), byId.get(original)], ['cost-breakdown.v2', 'analysis', 'original']);
  const current = readEvidence(s.store, s.conversation);
  assert.equal(current.items.find((i) => i.id === custom)!.template, 'cost-breakdown.v2');
  assert.equal(readEvidenceFragment(s.store, s.conversation, custom, null).item.template, 'cost-breakdown.v2');
  const history = readEvidenceChanges(s.store, s.conversation).changes.flatMap((c) => c.added);
  assert.deepEqual(history.map((i) => i.template), ['cost-breakdown.v2', 'analysis', 'original']);
});

test('templates are refused when they are malformed, reserved on analysis, or foreign to an original', async (t) => {
  const s = setup(t);
  await s.submit('c1'); s.release('c1', 'turn-r');
  const refused = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof StreamFault && e.faults.length > 0);
  refused(() => publish(s, 'a.txt', 'x', 'A', 'analysis', 'turn-r', 'original'));
  refused(() => publish(s, 'b.txt', 'x', 'B', 'original', 'turn-r', 'cost-breakdown'));
  for (const [n, bad] of ['Upper', '1lead', '', 'has space', 'x'.repeat(65)].entries()) refused(() => publish(s, `m${n}.txt`, 'x', 'C', 'analysis', 'turn-r', bad));
  assert.throws(() => publish(s, 'e.txt', 'x', 'D', 'analysis', 'turn-r', 'original'), (e) => e instanceof StreamFault && e.faults.some((f) => f.code === 'EVIDENCE_TEMPLATE_REFUSED'));
  assert.equal(readEvidence(s.store, s.conversation).total, 0);
});

test('open, submit, page, changes, message and files go through the bridge grant', async (t) => {
  const s = setup(t);
  await assert.rejects(s.host.openConversation('wrong', KEY));
  const empty = await s.host.openConversation(GRANT, KEY);
  assert.equal(empty.created, false); assert.equal(empty.page.messages.length, 0);
  const started = await s.host.openConversation(GRANT, KEY, { submissionId: 's0', consultant: alice, acceptedAt: s.at(1), position: String(s.store.nextSeq()).padStart(20, '0') });
  assert.equal(started.created, true); assert.equal(started.page.messages[0].message.text, '');
  assert.equal((await s.host.openConversation(GRANT, KEY)).created, false);
  const staged = await s.host.stageFile(GRANT, KEY, { actor: alice, uploadId: 'u1', filename: 'rows.csv', mime: 'text/csv', bytes: Buffer.from('a,b\n1,2\n'), maxBytes: 1024 });
  const sent = await s.submit('s1', 'with a file', { fileIds: [staged.fileId] });
  assert.equal(sent.duplicate, false); assert.deepEqual(sent.message.files.map((f) => f.fileId), [staged.fileId]); assert.equal(sent.message.files[0].filename, 'rows.csv');
  assert.equal((await s.submit('s1', 'with a file', { fileIds: [staged.fileId] })).duplicate, true);
  const page = await s.host.readConversation(GRANT, KEY, { limit: 1 });
  assert.equal(page.messages.length, 1); assert.equal(page.hasMore, true);
  const next = await s.host.readChanges(GRANT, KEY, { after: page.cursor });
  assert.equal(next.messages.length, 1); assert.equal(next.messages[0].message.messageId, `${s.conversation}:s1`);
  assert.equal((await s.host.readChanges(GRANT, KEY, { after: next.cursor })).messages.length, 0);
  assert.equal(await s.host.readMessage(GRANT, KEY, 'nope'), null);
  const [file] = await s.host.readFiles(GRANT, KEY, [staged.fileId], { includeBytes: true });
  assert.equal(Buffer.from(file.content!).toString(), 'a,b\n1,2\n'); assert.equal(file.sha256, staged.sha256);
  assert.equal((await s.host.readFiles(GRANT, KEY, [staged.fileId]))[0].content, null);
  await assert.rejects(s.host.readMessage('wrong', KEY, 's1')); await assert.rejects(s.host.readCanvas('wrong', KEY)); await assert.rejects(s.host.readPeriodSummary('wrong', [KEY], { from: '', to: '' }));
});

// Each stored key the host reads is written by a real producer: the reply tool,
// the evidence publisher and the release loop. Renaming a key there fails here.
test('a renamed adapter_fields key breaks this test, not a host', async (t) => {
  const s = setup(t, () => [{ code: 'X', subject: 's', problem: 'p', fix: 'f' }]);
  await s.submit('k1'); s.release('k1', 'turn-k');
  assert.throws(() => s.reply({ conversation_id: s.conversation, request_id: 'turn-k', text: 'bad', metadata: { draftLabel: 'D' } }));
  const parked = s.store.recordsIn(s.conversation).find((r) => r.direction === 'outbound')!;
  for (const key of [HOST_ADAPTER_FIELDS.submissionIds, HOST_ADAPTER_FIELDS.replyValidationFaults, HOST_ADAPTER_FIELDS.responseMetadata]) assert.ok(key in parked.adapter_fields!, `reply tool no longer writes ${key}`);
  publish(s, 'k.txt', 'k', 'K', 'original', 'turn-k');
  assert.ok(s.store.recordsIn(s.conversation).some((r) => HOST_ADAPTER_FIELDS.evidenceChange in (r.adapter_fields ?? {})), 'evidence publisher no longer writes evidence_change');
  const loop = fs.readFileSync(new URL('../runtime/loop.ts', import.meta.url), 'utf8');
  for (const key of [HOST_ADAPTER_FIELDS.modelEffect, HOST_ADAPTER_FIELDS.modelEffectEvidence, HOST_ADAPTER_FIELDS.browserDelivery]) assert.ok(loop.includes(`${key}:`), `release loop no longer writes ${key}`);
  const view = messageView(parked);
  assert.equal(view.state, 'failed'); assert.equal(view.validationFaults.length, 1); assert.deepEqual(view.submissionIds, ['k1']);
});
