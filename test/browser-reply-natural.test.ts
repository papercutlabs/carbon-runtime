import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, type MessageRecord, type Attachment } from '../stream/store.ts';
import { replyHandler, createReplyServer, type BrowserReplyValidator } from '../runtime/reply-tool.ts';
import { browserWorkspace, readBrowserAttachment } from '../runtime/browser-files.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-natural-reply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = Store.open(path.join(root, 'store'));
  const work = path.join(root, 'work'); const checkout = path.join(root, 'client');
  fs.mkdirSync(work); fs.mkdirSync(checkout);
  const conversation = 'browser:account:CASE-1';
  for (const id of ['one', 'two', 'three']) {
    const record: MessageRecord = { schema: 'carbon.message.v1', agent: 'agent', source: 'browser', account: 'account', conversation_id: conversation,
      conversation_kind: 'group', message_id: `input-${id}`, platform_message_id: id, revision: 0, direction: 'inbound', role: 'contact',
      sender_id: id, received_at: `2026-10-06T00:00:0${id === 'one' ? 1 : id === 'two' ? 2 : 3}Z`, body: `distinct ${id}`, attachments: [], historical: false, disposition: 'captured',
      adapter_fields: { ticket_key: 'CASE-1' } };
    store.capture(record); store.release(record, { released_at: new Date().toISOString(), thread_id: 'thread', turn_id: 'release', hold_applies: false });
  }
  const workspace = browserWorkspace({ work, checkout, conversationId: conversation });
  store.activeBrowserReply = { conversation_id: conversation, release_id: 'release', output_root: workspace.output };
  const args = { conversation_id: conversation, request_id: 'release', text: 'A useful ordinary answer from all three inputs.' };
  return { root, store, work, workspace, conversation, args };
}
test('ordinary text and bounded metadata reach the canonical validator and all associated input IDs', (t) => {
  const { store, args } = fixture(t);
  const seen: Parameters<BrowserReplyValidator>[0][] = [];
  const metadata = { draftLabel: 'Draft for review and copy', sources: [], uncertainty: 'Synthetic limitation.' };
  replyHandler({ store, agent: 'agent', validateBrowserReply: (input) => { seen.push(input); return []; } })({ ...args, metadata });
  const outbound = store.recordsIn(args.conversation_id).find((record) => record.direction === 'outbound')!;
  assert.equal(outbound.body, args.text); assert.deepEqual(outbound.adapter_fields!.response_metadata, metadata);
  assert.deepEqual(outbound.adapter_fields!.submission_ids, ['one', 'two', 'three']);
  assert.equal(seen.length, 1); assert.equal(seen[0].requestKind, undefined); assert.equal(seen[0].text, args.text);
  assert.deepEqual(seen[0].metadata, metadata); assert.deepEqual(seen[0].attachments, []);
});
test('MCP accepts natural text with metadata and tool-owned files which download exact bytes after reopen', async (t) => {
  const { store, args, workspace } = fixture(t);
  const filename = path.join(workspace.output, 'result.csv'); const bytes = Buffer.from('out,value\nanswer,distinct-artifact\n');
  fs.writeFileSync(filename, bytes);
  const server = createReplyServer({ store, agent: 'agent', validateBrowserReply: ({ attachments }) => {
    assert.equal(attachments.length, 1); assert.match(attachments[0].attachment_id!, /^artifact-/);
    assert.equal(attachments[0].bytes, bytes.length); return []; } });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'reply', arguments: { ...args, metadata: { sources: [] }, attachments: [filename] } } });
  assert.match(JSON.stringify(response), /written/);
  const record = store.recordsIn(args.conversation_id).find((one) => one.direction === 'outbound')!;
  const attachment = record.attachments[0] as Attachment;
  const reopened = Store.open(store.dir);
  const download = readBrowserAttachment(reopened, { conversationId: args.conversation_id, attachmentId: attachment.attachment_id! });
  assert.deepEqual(download.bytes, bytes); assert.equal(download.metadata.state, 'available');
  assert.equal('file' in download.metadata, false); assert.equal(JSON.stringify(download.metadata).includes(store.dir), false);
  assert.throws(() => readBrowserAttachment(reopened, { conversationId: 'browser:account:CASE-2', attachmentId: attachment.attachment_id! }), /BROWSER_FILE_NOT_FOUND/);
  fs.unlinkSync(store.under(attachment.file));
  const missing = readBrowserAttachment(reopened, { conversationId: args.conversation_id, attachmentId: attachment.attachment_id! });
  assert.equal(missing.metadata.state, 'missing'); assert.equal(missing.metadata.filename, 'result.csv'); assert.equal(missing.bytes, null);
});
test('browser output rejects analysis/evidence/store paths, traversal and internal or external symlinks', (t) => {
  const { root, store, args, workspace } = fixture(t);
  const good = path.join(workspace.output, 'good.txt'); fs.writeFileSync(good, 'output');
  const analysis = path.join(workspace.analysis, 'analysis.txt'); fs.writeFileSync(analysis, 'private analysis');
  const evidence = path.join(workspace.evidence, 'evidence.txt'); fs.writeFileSync(evidence, 'evidence');
  const storeFile = path.join(store.dir, 'private.txt'); fs.writeFileSync(storeFile, 'private');
  const internalLink = path.join(workspace.output, 'internal.txt'); fs.symlinkSync(good, internalLink);
  const externalLink = path.join(workspace.output, 'external.txt'); fs.symlinkSync(storeFile, externalLink);
  const directoryLink = path.join(workspace.output, 'linked'); fs.symlinkSync(workspace.output, directoryLink);
  const writer = replyHandler({ store, agent: 'agent', work: root, validateBrowserReply: () => [] });
  for (const file of [analysis, evidence, storeFile, internalLink, externalLink, path.join(directoryLink, 'good.txt'), `${workspace.output}/../output/good.txt`]) {
    assert.throws(() => writer({ ...args, attachments: [file] }), /BROWSER_FILE_PATH_REFUSED|BROWSER_FILE_SYMLINK_REFUSED|ATTACHMENT_TRAVERSAL_REFUSED/);
    assert.equal(store.readRequest('release'), null);
  }
  store.activeBrowserReply!.output_root = undefined;
  assert.throws(() => writer({ ...args, attachments: [good] }), /WORK_DIR_ABSENT/);
});
test('malformed metadata and client refusal cannot claim final acceptance or publish downloadable rejected files', (t) => {
  const { store, args, workspace } = fixture(t);
  const writer = replyHandler({ store, agent: 'agent', validateBrowserReply: () => [] });
  for (const metadata of [null, [], { attachments: [] }, { text: 'override' }, { value: Infinity }, { big: 'x'.repeat(65537) }]) {
    assert.throws(() => writer({ ...args, metadata }), /BROWSER_REPLY_METADATA_INVALID/); assert.equal(store.readRequest('release'), null);
  }
  const file = path.join(workspace.output, 'rejected.txt'); fs.writeFileSync(file, 'rejected bytes');
  const refuse = replyHandler({ store, agent: 'agent', validateBrowserReply: () => [{ code: 'CLIENT_REFUSED', subject: 'metadata', problem: 'synthetic structural refusal', fix: 'repair' }] });
  assert.throws(() => refuse({ ...args, metadata: { invalid: true }, attachments: [file] }), /CLIENT_REFUSED/);
  const rejected = store.recordsIn(args.conversation_id).find((one) => one.direction === 'outbound')!;
  assert.equal(rejected.body, args.text); assert.equal(rejected.delivery!.status, 'failed'); assert.equal(store.readRequest('release'), null);
  assert.throws(() => readBrowserAttachment(store, { conversationId: args.conversation_id, attachmentId: (rejected.attachments[0] as Attachment).attachment_id! }), /BROWSER_FILE_NOT_FOUND/);
});
