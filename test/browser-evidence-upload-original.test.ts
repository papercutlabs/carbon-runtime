import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, StreamFault } from '../stream/store.ts';
import { browserWorkspace, materializeBrowserAttachments } from '../runtime/browser-files.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { presentEvidence, readEvidence, readEvidenceFragment, downloadEvidence, validateEvidenceReferences, toWireSelector, publicEvidenceFragment } from '../runtime/browser-evidence.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
const csv = Buffer.from('id,name\n1,alpha\n2,beta\n3,gamma\n');
const log = Buffer.from('line one\nline two\nline three\n');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = 'DEMO-1', OTHER = 'DEMO-2';

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-upload-original-')));
  for (const d of ['work', 'checkout']) fs.mkdirSync(path.join(root, d));
  const store = Store.open(path.join(root, 'store'));
  const bridge = createBrowserBridge({ store, agent: 'fixture-agent', account: 'cohort', authorize: () => true });
  const conv = (key: string) => `cohort:ticket:${key}`;
  const workspace = (key: string) => browserWorkspace({ work: path.join(root, 'work'), conversationId: conv(key), checkout: path.join(root, 'checkout') });
  const consultant = { id: 'alice', name: 'Alice Example' };
  const stage = (key: string, name: string, mime: string, bytes: Buffer) =>
    bridge.stageAttachment({}, key, { actor: consultant, uploadId: crypto.randomUUID(), filename: name, mime, bytes, maxBytes: 1 << 20 }).attachment_id;
  const send = (key: string, ids: string[]) => bridge.submit({}, { account: 'cohort', ticket_key: key, submission_id: crypto.randomUUID(), consultant, input_kind: 'message',
    body: 'see attached', accepted_at: new Date().toISOString(), position: String(Date.now()).padStart(20, '0'), attachment_ids: ids } as never).record;
  const file = (key: string, id: string) => (store.readThread(conv(key)) as unknown as { browser_files: Record<string, unknown> }).browser_files[id] as never;
  const materialize = (key: string, id: string) => {
    const ws = workspace(key);
    return materializeBrowserAttachments(store, { conversationId: conv(key), attachments: [file(key, id)], workspace: ws })[0];
  };
  const present = (key: string, add: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    store.activeBrowserReply = { conversation_id: conv(key), release_id: 'release', native_turn_id: 'native', workspace: workspace(key) };
    return presentEvidence(store, { agent: 'fixture-agent', account: 'cohort', workspace: workspace(key), conversationId: conv(key), releaseId: 'release', turnId: 'native',
      delta: { changeId: crypto.randomUUID(), add, remove: [], note: null, ...extra } });
  };
  const addition = (p: string, selector: unknown, extra: Record<string, unknown> = {}) => ({ itemId: crypto.randomUUID(), label: 'Uploaded', path: p, selector, note: null, basis: [], assumptions: [], producerPath: null, ...extra });
  return { root, store, conv, workspace, stage, send, materialize, present, addition, file };
}
const refusedWith = (fn: () => unknown, code: string) => assert.throws(fn, (e) => e instanceof StreamFault && e.faults.some((f) => f.code === code), code);

test('a bound consultant upload is published as an original with Carbon-derived provenance, selectable, referenceable and byte-exact', () => {
  const t = setup();
  try {
    const files = [
      { name: 'shot.png', mime: 'image/png', bytes: png, selector: { kind: 'region', x: 0, y: 0, width: 1, height: 1 }, kindOf: 'image' },
      { name: 'rows.csv', mime: 'text/csv', bytes: csv, selector: { kind: 'rows', start: 2, end: 3 }, kindOf: 'table' },
      { name: 'run.log', mime: 'text/plain', bytes: log, selector: { kind: 'lines', start: 2, end: 3 }, kindOf: 'text' }
    ];
    const ids = files.map((f) => t.stage(KEY, f.name, f.mime, f.bytes));
    const sent = t.send(KEY, ids);
    const items = files.map((f, i) => ({ f, id: ids[i], itemId: crypto.randomUUID(), p: t.materialize(KEY, ids[i]) }));
    t.present(KEY, items.map((i) => t.addition(i.p, toWireSelector(i.f.selector as never), { itemId: i.itemId })));
    const page = readEvidence(t.store, t.conv(KEY));
    assert.equal(page.items.length, 3);
    for (const i of items) {
      const item = page.items.find((x) => x.id === i.itemId)!;
      assert.equal(item.template, 'original');
      assert.equal(item.origin, 'original');
      const frag = readEvidenceFragment(t.store, t.conv(KEY), i.itemId, i.f.selector as never, 0, 0, 100);
      assert.equal(frag.content.kind, i.f.kindOf === 'image' ? 'image' : frag.content.kind);
      assert.deepEqual(frag.provenance, { kind: 'consultant_upload', actorId: 'alice', actorName: 'Alice Example', attachmentId: i.id, sha256: sha(i.f.bytes),
        bytes: i.f.bytes.length, mediaType: i.f.mime, filename: i.f.name, boundAt: sent.received_at });
      assert.equal(validateEvidenceReferences(t.store, t.conv(KEY), [frag.reference]).length, 1);
      assert.deepEqual(downloadEvidence(t.store, t.conv(KEY), item.sourceId).bytes, i.f.bytes);
      assert.equal(downloadEvidence(t.store, t.conv(KEY), item.sourceId).sha256, sha(i.f.bytes));
      assert.equal(publicEvidenceFragment(frag).provenance!.kind, 'consultant_upload');
    }
    const rows = readEvidenceFragment(t.store, t.conv(KEY), items[1].itemId, { kind: 'rows', start: 2, end: 3 } as never, 0, 0, 100).content as unknown as Record<string, unknown>;
    assert.match(JSON.stringify(rows), /beta/);
    assert.doesNotMatch(JSON.stringify(rows), /alpha/);
    const lines = readEvidenceFragment(t.store, t.conv(KEY), items[2].itemId, { kind: 'lines', start: 2, end: 3 } as never, 0, 0, 100).content;
    assert.match(JSON.stringify(lines), /line two/);
    assert.doesNotMatch(JSON.stringify(lines), /line one/);
    assert.throws(() => readEvidenceFragment(t.store, t.conv(KEY), items[2].itemId, { kind: 'lines', start: 9, end: 10 } as never, 0, 0, 100), /EVIDENCE_SELECTOR_INVALID/);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('unbound, foreign, agent-made and altered-custody files are refused as originals', () => {
  const t = setup();
  try {
    const sel = toWireSelector({ kind: 'lines', start: 1, end: 1 });
    const refused = (p: string) => t.present(KEY, [t.addition(p, sel)]);
    const id = t.stage(KEY, 'run.log', 'text/plain', log);
    const staged = t.materialize(KEY, id);
    refusedWith(() => refused(staged), 'EVIDENCE_ORIGINAL_UNREGISTERED');

    const foreignId = t.stage(OTHER, 'run.log', 'text/plain', log);
    t.send(OTHER, [foreignId]);
    refusedWith(() => refused(staged), 'EVIDENCE_ORIGINAL_UNREGISTERED');
    assert.equal(readEvidence(t.store, t.conv(KEY)).total, 0);
    const foreignOnly = t.stage(OTHER, 'other.log', 'text/plain', Buffer.from('foreign\n'));
    t.send(OTHER, [foreignOnly]);
    const foreignPath = t.materialize(OTHER, foreignOnly);
    const copy = path.join(t.workspace(KEY).evidence, sha(Buffer.from('foreign\n')), 'other.log');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, fs.readFileSync(foreignPath), { mode: 0o400 });
    refusedWith(() => refused(copy), 'EVIDENCE_ORIGINAL_UNREGISTERED');

    const analysis = path.join(t.workspace(KEY).analysis, 'transcribed.log');
    fs.writeFileSync(analysis, log);
    t.present(KEY, [t.addition(analysis, sel, { itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })]);
    assert.equal(readEvidence(t.store, t.conv(KEY)).items[0].origin, 'analysis');
    const mimic = path.join(t.workspace(KEY).evidence, sha(Buffer.from('mimic\n')), 'mimic.log');
    fs.mkdirSync(path.dirname(mimic), { recursive: true });
    fs.writeFileSync(mimic, 'mimic\n', { mode: 0o400 });
    refusedWith(() => refused(mimic), 'EVIDENCE_ORIGINAL_UNREGISTERED');

    t.send(KEY, [id]);
    const bound = t.present(KEY, [t.addition(staged, sel)]);
    assert.equal(bound.added[0].origin, 'original');
    const id2 = t.stage(KEY, 'later.log', 'text/plain', Buffer.from('later\n'));
    const p2 = t.materialize(KEY, id2);
    t.send(KEY, [id2]);
    const custody = t.store.under((t.file(KEY, id2) as { file: string }).file);
    fs.chmodSync(custody, 0o600);
    fs.writeFileSync(custody, 'tampered');
    refusedWith(() => refused(p2), 'BROWSER_FILE_INTEGRITY_FAILED');
    assert.equal(readEvidence(t.store, t.conv(KEY)).items.filter((i) => i.origin === 'original').length, 1);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('model arguments cannot supply or alter upload provenance', () => {
  const t = setup();
  try {
    const id = t.stage(KEY, 'run.log', 'text/plain', log);
    t.send(KEY, [id]);
    const p = t.materialize(KEY, id), sel = toWireSelector({ kind: 'lines', start: 1, end: 1 });
    const fake = { kind: 'consultant_upload', actorId: 'mallory', actorName: 'Mallory', sha256: '0'.repeat(64) };
    assert.throws(() => t.present(KEY, [t.addition(p, sel, { provenance: fake })]), StreamFault);
    assert.throws(() => t.present(KEY, [t.addition(p, sel)], { provenance: fake }), StreamFault);
    assert.equal(readEvidence(t.store, t.conv(KEY)).total, 0);
    const change = t.present(KEY, [t.addition(p, sel, { label: 'Mallory says: from Jira' })]);
    const frag = readEvidenceFragment(t.store, t.conv(KEY), change.added[0].id, { kind: "lines", start: 1, end: 1 });
    assert.equal(frag.provenance!.actorId, 'alice');
    assert.equal(frag.provenance!.sha256, sha(log));
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});
