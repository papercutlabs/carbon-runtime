import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, type Attachment, type MessageRecord } from '../stream/store.ts';
import { stageBrowserAttachment, readBrowserAttachment, resolveBrowserAttachments, bindBrowserAttachments,
  browserWorkspace, materializeBrowserAttachments, createBrowserEvidenceWriter } from '../runtime/browser-files.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-files-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = Store.open(path.join(root, 'store'));
  const work = path.join(root, 'work'); const checkout = path.join(root, 'client');
  fs.mkdirSync(work); fs.mkdirSync(checkout);
  const input = { conversationId: 'browser:account:CASE-1', actor: { id: 'one', name: 'One' }, uploadId: 'upload-one',
    filename: 'evidence.csv', mime: 'text/csv', bytes: Buffer.from('item,value\na,distinct-123\n'), maxBytes: 2048 };
  return { root, store, work, checkout, input };
}
export function inbound(conversation: string, attachments: Attachment[], message = 'input-one'): MessageRecord<Attachment> {
  return { schema: 'carbon.message.v1', agent: 'agent', source: 'browser', account: 'account', conversation_id: conversation,
    conversation_kind: 'group', message_id: message, platform_message_id: message, revision: 0, direction: 'inbound', role: 'contact',
    sender_id: 'one', received_at: '2026-10-06T00:00:00Z', body: 'inspect these exact bytes', attachments, historical: false, disposition: 'captured',
    adapter_fields: { ticket_key: 'CASE-1' } };
}
test('staging is durable without visible input, merges thread fields and refuses upload identity changes', (t) => {
  const { store, input } = fixture(t);
  store.writeThread(input.conversationId, { thread_id: 'native-thread', browser_activity: { phase: 'running' } });
  const first = stageBrowserAttachment(store, input);
  assert.equal(first.duplicate, false); assert.equal(first.actor_id, 'one'); assert.equal(first.bound_message_id, null);
  assert.equal(store.recordsIn(input.conversationId).length, 0);
  assert.equal(store.readThread(input.conversationId)!.thread_id, 'native-thread');
  const reopened = Store.open(store.dir);
  assert.deepEqual(stageBrowserAttachment(reopened, input), { ...first, duplicate: true });
  assert.deepEqual(readBrowserAttachment(reopened, { conversationId: input.conversationId, attachmentId: first.attachment_id }).bytes, input.bytes);
  assert.equal(JSON.stringify(first).includes(store.dir), false); assert.equal('file' in first, false);
  for (const change of [{ bytes: Buffer.from('different') }, { filename: 'other.csv' }, { mime: 'text/plain' },
    { actor: { id: 'two', name: 'Two' } }, { actor: { id: 'one', name: 'Changed' } }]) {
    assert.throws(() => stageBrowserAttachment(store, { ...input, ...change }), /BROWSER_UPLOAD_ID_CONFLICT/);
  }
});
test('sender and conversation scope refuse misuse; durable input repairs interrupted binding after reopen', (t) => {
  const { store, input } = fixture(t);
  const file = stageBrowserAttachment(store, input);
  assert.throws(() => readBrowserAttachment(store, { conversationId: 'browser:account:CASE-2', attachmentId: file.attachment_id }), /BROWSER_FILE_NOT_FOUND/);
  assert.throws(() => resolveBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'two', attachmentIds: [file.attachment_id] }), /BROWSER_FILE_ACTOR_REFUSED/);
  assert.throws(() => bindBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [file.attachment_id], messageId: 'missing' }), /BROWSER_FILE_BINDING_REFUSED/);
  const attachments = resolveBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [file.attachment_id] });
  store.capture(inbound(input.conversationId, attachments));
  const reopened = Store.open(store.dir);
  assert.equal(readBrowserAttachment(reopened, { conversationId: input.conversationId, attachmentId: file.attachment_id }).metadata.bound_message_id, 'input-one');
  assert.equal(stageBrowserAttachment(reopened, input).bound_message_id, 'input-one');
  bindBrowserAttachments(store, { conversationId: 'empty-conversation', actorId: 'one', attachmentIds: [], messageId: 'nothing' });
  assert.equal(store.readThread('empty-conversation'), null);
});
test('malformed uploads and modified stored bytes refuse before accepted readback', (t) => {
  const { store, input } = fixture(t);
  for (const filename of ['../private', '/secret', 'a\\b', 'bad\nname']) assert.throws(() => stageBrowserAttachment(store, { ...input, filename }), /BROWSER_FILE_NAME_INVALID/);
  assert.throws(() => stageBrowserAttachment(store, { ...input, uploadId: '../escape' }), /IDENTIFIER_HAS/);
  assert.throws(() => stageBrowserAttachment(store, { ...input, maxBytes: 1 }), /BROWSER_FILE_SIZE_REFUSED/);
  assert.throws(() => stageBrowserAttachment(store, { ...input, mime: 'text/plain\r\nX: bad' }), /BROWSER_FILE_MIME_INVALID/);
  const file = stageBrowserAttachment(store, input);
  const attachment = resolveBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [file.attachment_id] })[0];
  fs.writeFileSync(store.under(attachment.file), 'corrupt');
  assert.throws(() => readBrowserAttachment(store, { conversationId: input.conversationId, attachmentId: file.attachment_id }), /BROWSER_FILE_INTEGRITY_FAILED/);
});
test('metadata-only read avoids loading raw bytes and missing bytes retain their exact staged identity', (t) => {
  const { store, input } = fixture(t);
  const file = stageBrowserAttachment(store, input);
  const attachment = resolveBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [file.attachment_id] })[0];
  const ready = readBrowserAttachment(store, { conversationId: input.conversationId, attachmentId: file.attachment_id, includeBytes: false });
  assert.equal(ready.metadata.state, 'available'); assert.equal(ready.metadata.kind, 'input'); assert.equal(ready.bytes, null);
  store.capture(inbound(input.conversationId, [attachment]));
  fs.unlinkSync(store.under(attachment.file));
  const reopened = Store.open(store.dir);
  const missing = readBrowserAttachment(reopened, { conversationId: input.conversationId, attachmentId: file.attachment_id, includeBytes: false });
  assert.equal(missing.metadata.state, 'missing'); assert.equal(missing.bytes, null);
  assert.equal(missing.metadata.bound_message_id, 'input-one'); assert.equal(missing.metadata.sha256, file.sha256);
  assert.throws(() => resolveBrowserAttachments(reopened, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [file.attachment_id] }), /BROWSER_FILE_MISSING/);
});
test('ticket workspaces materialize exact read-only evidence and source files, with separate analysis/output', (t) => {
  const { store, input, work, checkout } = fixture(t);
  const staged = stageBrowserAttachment(store, input);
  const attachments = resolveBrowserAttachments(store, { conversationId: input.conversationId, actorId: 'one', attachmentIds: [staged.attachment_id] });
  const workspace = browserWorkspace({ work, checkout, conversationId: input.conversationId });
  assert.notEqual(workspace.root, browserWorkspace({ work, checkout, conversationId: 'browser:account:CASE-2' }).root);
  const paths = materializeBrowserAttachments(store, { conversationId: input.conversationId, attachments, workspace });
  assert.deepEqual(fs.readFileSync(paths[0]), input.bytes); assert.equal(fs.statSync(paths[0]).mode & 0o777, 0o400);
  assert.equal(paths[0].includes(store.dir), false);
  fs.writeFileSync(path.join(workspace.analysis, 'analysis.txt'), 'computed');
  fs.writeFileSync(path.join(workspace.output, 'answer.txt'), 'artifact');
  const writer = createBrowserEvidenceWriter(store, { conversationId: input.conversationId, workspace });
  const source = writer({ identity: 'jira:source-raw', filename: 'raw.png', mime: 'image/png', bytes: Buffer.from('exact synthetic raw') });
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'exact synthetic raw');
  assert.equal(fs.statSync(source.path).mode & 0o777, 0o400);
  assert.throws(() => writer({ identity: 'jira:bad', filename: '../escape', mime: 'text/plain', bytes: Buffer.from('bad') }), /BROWSER_FILE_NAME_INVALID/);
  assert.throws(() => materializeBrowserAttachments(store, { conversationId: 'browser:account:CASE-2', attachments, workspace }), /BROWSER_WORKSPACE_SCOPE_REFUSED/);
});
test('workspace and evidence symlinks refuse even when they point within the owned work tree', (t) => {
  const { store, input, work, checkout } = fixture(t);
  const workspace = browserWorkspace({ work, checkout, conversationId: input.conversationId });
  fs.rmdirSync(workspace.evidence); fs.symlinkSync(workspace.analysis, workspace.evidence);
  assert.throws(() => createBrowserEvidenceWriter(store, { conversationId: input.conversationId, workspace }), /BROWSER_FILE_SYMLINK_REFUSED/);
  fs.unlinkSync(workspace.evidence); fs.mkdirSync(workspace.evidence);
  const writer = createBrowserEvidenceWriter(store, { conversationId: input.conversationId, workspace });
  fs.rmdirSync(workspace.evidence); fs.symlinkSync(workspace.analysis, workspace.evidence);
  assert.throws(() => writer({ identity: 'raw', filename: 'raw.txt', mime: 'text/plain', bytes: Buffer.from('raw') }), /BROWSER_FILE_SYMLINK_REFUSED/);
  assert.throws(() => browserWorkspace({ work, checkout, conversationId: input.conversationId }), /BROWSER_FILE_SYMLINK_REFUSED/);
});
test('the authenticated bridge binds staged files on actual input capture and permits shared reads only after binding', async (t) => {
  const { store, input } = fixture(t);
  const { createBrowserBridge } = await import('../runtime/browser.ts');
  const bridge = createBrowserBridge({ store, agent: 'agent', account: 'account', authorize: (grant, key) => !!grant && key === 'CASE-1' });
  const grant = { consultant: { id: 'one' } }; const colleague = { consultant: { id: 'two' } };
  const staged = bridge.stageAttachment(grant, 'CASE-1', input);
  assert.throws(() => bridge.readAttachment(colleague, 'CASE-1', staged.attachment_id), /BROWSER_FILE_ACTOR_REFUSED/);
  assert.throws(() => bridge.readAttachment(null, 'CASE-1', staged.attachment_id), /BROWSER_ACCESS_DENIED/);
  const packet = { account: 'account', ticket_key: 'CASE-1', submission_id: 'actual-one', consultant: input.actor,
    input_kind: 'message' as const, attachment_ids: [staged.attachment_id], body: 'Use this exact evidence', accepted_at: '2026-10-06T00:00:00Z', position: '00000000000000000001' };
  const accepted = bridge.submit(grant, packet);
  assert.equal(accepted.record.attachments.length, 1); assert.equal(accepted.duplicate, false);
  assert.equal(bridge.submit(grant, packet).duplicate, true);
  const shared = bridge.readAttachment(colleague, 'CASE-1', staged.attachment_id);
  assert.deepEqual(shared.bytes, input.bytes); assert.equal(shared.metadata.bound_message_id, accepted.record.message_id);
  assert.throws(() => bridge.readAttachment(grant, 'CASE-2', staged.attachment_id), /BROWSER_ACCESS_DENIED/);
});
