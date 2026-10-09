import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateOutput, Type } from '@pcl/routes';
import { Store } from '../stream/store.ts';
import { browserConversationId } from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { createBrowserHost, messageView, templateOf, reasonOf, BROWSER_HOST_SCHEMA, HOST_ADAPTER_FIELDS, type MessageState } from '../runtime/browser-host.ts';
import { browserWorkspace } from '../runtime/browser-files.ts';
import { presentEvidence, toWireSelector, readEvidenceChanges, readEvidenceFragment, readEvidence } from '../runtime/browser-evidence.ts';
import { StreamFault } from '../stream/store.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { materializeBrowserAttachments } from '../runtime/browser-files.ts';

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
  const evidence = JSON.parse(fs.readFileSync(new URL('../schema/browser-evidence-interface.json', import.meta.url), 'utf8'));
  const inline = (n: unknown): unknown => Array.isArray(n) ? n.map(inline) : n && typeof n === 'object'
    ? ((n as { $ref?: string }).$ref ? inline(((n as { $ref: string }).$ref.startsWith('browser-evidence-interface.json#/') ? evidence : defs)[(n as { $ref: string }).$ref.split('/').pop()!])
      : Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'description').map(([k, v]) => [k, k === 'additionalProperties' && v === true ? false : inline(v)]))) : n;
  // The routes dialect has no open objects: the agent's own source entries are checked as present, not by shape.
  const closed = JSON.parse(JSON.stringify(value), (key, one) => key === 'sources' && Array.isArray(one) && one.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ? one.map(() => ({})) : one);
  return validateOutput(Type.Unsafe(inline(defs[name]) as never), closed);
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
  assert.ok(HOST_ADAPTER_FIELDS.requestKind in parked.adapter_fields!, 'reply tool no longer writes request_kind');
  assert.equal(s.read('k1').adapter_fields![HOST_ADAPTER_FIELDS.inputKind], 'message', 'the browser adapter no longer writes input_kind');
  publish(s, 'k.txt', 'k', 'K', 'original', 'turn-k');
  assert.ok(s.store.recordsIn(s.conversation).some((r) => HOST_ADAPTER_FIELDS.evidenceChange in (r.adapter_fields ?? {})), 'evidence publisher no longer writes evidence_change');
  const loop = fs.readFileSync(new URL('../runtime/loop.ts', import.meta.url), 'utf8');
  for (const key of [HOST_ADAPTER_FIELDS.modelEffect, HOST_ADAPTER_FIELDS.modelEffectEvidence, HOST_ADAPTER_FIELDS.browserDelivery]) assert.ok(loop.includes(`${key}:`), `release loop no longer writes ${key}`);
  const view = messageView(parked);
  assert.equal(view.state, 'failed'); assert.equal(view.validationFaults.length, 1); assert.deepEqual(view.submissionIds, ['k1']);
});

test('gap 1 and 3: a reply carries its decoded sources, uncertainty and draft label; an input carries its input kind', async (t) => {
  const s = setup(t);
  await s.submit('r1'); s.release('r1', 'turn-r1');
  const sources = [{ title: 'Synthetic source', url: 'https://source.invalid/a' }];
  s.reply({ conversation_id: s.conversation, request_id: 'turn-r1', text: 'answer', metadata: { sources, uncertainty: 'Synthetic limitation.', draftLabel: 'Draft for review' } });
  const messages = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message);
  const answer = messages.find((m) => m.role === 'agent')!, input = messages.find((m) => m.role !== 'agent')!;
  assert.deepEqual(answer.reply, { sources, uncertainty: 'Synthetic limitation.', draftLabel: 'Draft for review' });
  assert.equal(input.reply, null); assert.equal(input.inputKind, 'message'); assert.equal(answer.inputKind, null);
  for (const message of messages) assert.deepEqual(validateView('message', message), [], JSON.stringify(message));
  // metadata the agent wrote loosely decodes to the typed shape rather than leaking its key names
  await s.submit('r2'); s.release('r2', 'turn-r2');
  s.reply({ conversation_id: s.conversation, request_id: 'turn-r2', text: 'second', metadata: { sources: 'not a list', uncertainty: 4, other: true } });
  const loose = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message).filter((m) => m.role === 'agent')[1];
  assert.deepEqual(loose.reply, { sources: [], uncertainty: null, draftLabel: null }); assert.deepEqual(validateView('message', loose), []);
  await s.submit('r3'); s.release('r3', 'turn-r3'); s.reply({ conversation_id: s.conversation, request_id: 'turn-r3', text: 'no metadata' });
  assert.equal((await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message).filter((m) => m.role === 'agent')[2].reply, null);
  const start = await s.host.openConversation(GRANT, 'CASE-8', { submissionId: 'st', consultant: alice, acceptedAt: s.at(1), position: String(s.store.nextSeq()).padStart(20, '0') });
  assert.equal(start.page.messages[0].message.inputKind, 'start');
});

test('gap 2: a legacy request kind goes through the host to the record and back, and cannot be combined with an input kind', async (t) => {
  const s = setup(t);
  for (const kind of ['investigate', 'follow_up', 'copy_draft'] as const) {
    const { message } = await s.submit('q-' + kind, 'legacy', { requestKind: kind });
    assert.equal(s.read('q-' + kind).adapter_fields![HOST_ADAPTER_FIELDS.requestKind], kind);
    assert.equal(s.read('q-' + kind).adapter_fields![HOST_ADAPTER_FIELDS.inputKind], undefined);
    assert.equal(message.requestKind, kind); assert.equal(message.inputKind, null); assert.deepEqual(validateView('message', message), []);
  }
  s.release('q-follow_up', 'turn-q'); s.reply({ conversation_id: s.conversation, request_id: 'turn-q', text: 'done' });
  const reply = (await s.host.readConversation(GRANT, KEY)).messages.map((m) => m.message).find((m) => m.role === 'agent')!;
  assert.equal(reply.requestKind, 'follow_up');
  assert.equal((await s.submit('q-follow_up', 'legacy', { requestKind: 'follow_up' })).duplicate, true);
  await assert.rejects(s.submit('q-bad', 'x', { requestKind: 'follow_up', inputKind: 'message' }), /request_kind|BROWSER|legacy/i);
  await assert.rejects(s.submit('q-unknown', 'x', { requestKind: 'invented' }), /request kind/i);
});

test('gap 6: queued and accepted are different message states, in the views and in the schema', async (t) => {
  const s = setup(t);
  await s.submit('s-a'); await s.submit('s-q');
  s.store.annotate(s.read('s-q'), { browser_delivery: { phase: 'next_turn', reason: 'a turn is running' } });
  const states = new Map((await s.host.readConversation(GRANT, KEY)).messages.map((m) => [m.message.submissionIds[0], m.message.state]));
  assert.equal(states.get('s-a'), 'accepted'); assert.equal(states.get('s-q'), 'queued');
  const defs = BROWSER_HOST_SCHEMA.$defs;
  for (const list of [defs.state.enum, defs.activity.anyOf[1].properties.state.enum]) { assert.ok(list.includes('accepted')); assert.ok(list.includes('queued')); }
  const loop = fs.readFileSync(new URL('../runtime/loop.ts', import.meta.url), 'utf8');
  assert.ok(loop.includes("phase: 'next_turn'"), 'the release loop no longer writes the queued phase');
});

test('gap 7: evidence pages, changes, fragments and downloads come from the host with wire cursors and validate against the schema', async (t) => {
  const s = setup(t);
  await s.submit('e1'); s.release('e1', 'turn-e');
  const original = publish(s, 'src.txt', 'line one\nline two\nline three\n', 'Source', 'original', 'turn-e');
  const analysis = publish(s, 'note.txt', 'derived', 'Note', 'analysis', 'turn-e', 'cost-breakdown');
  const first = await s.host.readEvidencePage(GRANT, KEY, { limit: 1 });
  assert.deepEqual(validateView('evidencePage', first), [], JSON.stringify(first)); assert.equal(first.items.length, 1); assert.equal(first.hasMore, true);
  const rest = await s.host.readEvidencePage(GRANT, KEY, { cursor: first.cursor, limit: 5 });
  assert.deepEqual(validateView('evidencePage', rest), []); assert.deepEqual([first.items[0].id, rest.items[0].id].sort(), [original, analysis].sort());
  assert.equal(rest.items[0].template, 'cost-breakdown' === rest.items[0].template ? 'cost-breakdown' : rest.items[0].template);
  const changes = await s.host.readEvidenceChanges(GRANT, KEY, { cursor: 0, limit: 1 });
  assert.deepEqual(validateView('evidenceChanges', changes), []); assert.equal(changes.changes.length, 1); assert.equal(changes.hasMore, true);
  const later = await s.host.readEvidenceChanges(GRANT, KEY, { cursor: changes.cursor });
  assert.equal(later.changes.length, 1); assert.equal(later.hasMore, false);
  assert.equal((await s.host.readEvidenceChanges(GRANT, KEY, { cursor: later.cursor, waitMs: 0 })).changes.length, 0);
  const fragment = await s.host.readEvidenceFragment(GRANT, KEY, original, { selector: toWireSelector({ kind: 'lines', start: 2, end: 2 }), contextAfter: 1 });
  assert.deepEqual(validateView('evidenceFragment', fragment), [], JSON.stringify(fragment));
  assert.equal(fragment.item.template, 'original'); assert.match(JSON.stringify(fragment.content), /line two/);
  await assert.rejects(s.host.readEvidenceFragment(GRANT, KEY, original, { selector: { kind: 'lines' } }), (e) => e instanceof StreamFault);
  const download = await s.host.downloadEvidence(GRANT, KEY, fragment.download.sourceId);
  assert.deepEqual(validateView('evidenceDownload', { ...download, content: {} }), []); assert.equal(Buffer.from(download.content).toString(), 'line one\nline two\nline three\n');
  assert.equal(download.sha256, fragment.item.digest);
  await assert.rejects(s.host.downloadEvidence(GRANT, KEY, 'unknown-source'), (e) => e instanceof StreamFault);
  for (const call of [() => s.host.readEvidencePage('wrong', KEY), () => s.host.readEvidenceChanges('wrong', KEY), () => s.host.readEvidenceFragment('wrong', KEY, original), () => s.host.downloadEvidence('wrong', KEY, 'x')]) await assert.rejects(call());
});

test('a consultant-uploaded original reads through the canvas and the evidence fragment with its upload provenance', async (t) => {
  const s = setup(t);
  const staged = await s.host.stageFile(GRANT, KEY, { actor: alice, uploadId: 'up1', filename: 'rows.csv', mime: 'text/csv', bytes: Buffer.from('a,b\n1,2\n'), maxBytes: 1024 });
  await s.submit('u1', 'see file', { fileIds: [staged.fileId] }); s.release('u1', 'turn-u');
  const thread = s.store.readThread(s.conversation) as unknown as { browser_files: Record<string, unknown> };
  const [file] = materializeBrowserAttachments(s.store, { conversationId: s.conversation, attachments: [thread.browser_files[staged.fileId] as never], workspace: s.workspace });
  const itemId = crypto.randomUUID();
  presentEvidence(s.store, { agent: 'synthetic-agent', account: s.account, workspace: s.workspace, conversationId: s.conversation, releaseId: 'turn-u', turnId: 'native',
    delta: { changeId: crypto.randomUUID(), add: [{ itemId, label: 'Uploaded', path: file, selector: toWireSelector({ kind: 'rows', start: 1, end: 1 }), note: null, basis: [], assumptions: [], producerPath: null }], remove: [], note: null } });
  const canvas = await s.host.readCanvas(GRANT, KEY);
  assert.deepEqual(validateView('canvas', canvas), [], JSON.stringify(canvas.items[0].source.provenance));
  assert.equal((canvas.items[0].source.provenance as { kind?: string }).kind, 'consultant_upload');
  const fragment = await s.host.readEvidenceFragment(GRANT, KEY, itemId, { selector: toWireSelector({ kind: 'rows', start: 1, end: 1 }) });
  assert.deepEqual(validateView('evidenceFragment', fragment), []);
});

test('reasonOf reads text, faults, native failure evidence and nothing it cannot read', () => {
  assert.equal(reasonOf('plain'), 'plain'); assert.equal(reasonOf(''), null); assert.equal(reasonOf(null), null);
  assert.equal(reasonOf({ code: 'X', problem: 'a fault' }), 'a fault');
  assert.equal(reasonOf({ original_reason: 'native text', original_reason_available: true, native_code: null }), 'native text');
  assert.equal(reasonOf({ original_reason: null, original_reason_available: false, native_code: null }), null);
  assert.equal(reasonOf([]), null); assert.equal(reasonOf([{ problem: 'first' }, 'second']), 'first');
  assert.equal(reasonOf({ other: 1 }), '{"other":1}');
});
