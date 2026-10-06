import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBrowserThreadOptions } from '../runtime/browser-policy.ts';
import { browserWorkspace } from '../runtime/browser-files.ts';
import { Store } from '../stream/store.ts';
import * as browser from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import type { Declaration } from '../runtime/types.ts';

test('owning browser launcher factory loads ticket permissions and scoped source config through the shared loop', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-profile-contract-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), checkout = path.join(root, 'agent-package');
  fs.mkdirSync(work); fs.mkdirSync(checkout); fs.writeFileSync(path.join(checkout, 'AGENTS.md'), 'Invented client-package guidance.');
  const store = Store.open(path.join(root, 'store')), conversation = browser.browserConversationId('fixture', 'CASE-101');
  const sourceUrls: string[] = [];
  const options = createBrowserThreadOptions({ work, checkout, readRoots: [checkout], privateRoots: [store.dir],
    sourceConfig: ({ workspace }) => { const url = 'http://127.0.0.1:12345/mcp/' + path.basename(workspace.root); sourceUrls.push(url);
      return { config: { mcp_servers: { 'fixture-source': { url } } } }; } });
  const declaration: Declaration = { agent: { id: 'fixture-agent' }, provider: { name: 'openai', auth: 'chatgpt' }, model: 'fixture', effort: 'low',
    sandbox: { mode: 'workspace-write', network: false }, unit_of_work: { kind: 'conversation' }, records: { enabled: false }, teaching: { enabled: false },
    tool_servers: [{ name: 'fixture-source', url: 'http://127.0.0.1:12345/mcp' }],
    channels: [{ kind: 'browser', account: 'fixture', default_conversation_kind: 'ops', release: 'quiet', quiet_ms: 0, poll_interval_ms: 60000 }] };
  const writer = replyHandler({ store, agent: 'fixture-agent', validateBrowserReply: () => [] });
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }, { name: 'fixture-source', runtimeStatus: 'connected' }],
    onTurn: (_s, params) => { assert.ok(params.permissions); assert.equal(params.sandboxPolicy, undefined);
      writer({ conversation_id: conversation, request_id: store.activeBrowserReply!.release_id, text: 'Configuration fixture; no model ran.' }); return 'completed'; } });
  const bridge = createBrowserBridge({ store, agent: 'fixture-agent', account: 'fixture', authorize: () => true });
  bridge.submit('fixture', { account: 'fixture', ticket_key: 'CASE-101', submission_id: 'start', consultant: { id: 'actor', name: 'Invented actor' }, input_kind: 'start', body: '', accepted_at: new Date().toISOString(), position: '00000000000000000001' });
  const loop = new ReleaseLoop({ declaration, channel: declaration.channels![0], store, storeDir: store.dir, adapter: browser, harness, session: harness.session,
    agent: 'fixture-agent', checkout, work, browserThreadOptions: options, prepareBrowserTurn: async () => ({ data: { ticket: { key: 'CASE-101' } } }) });
  await loop.pass([]);
  const opened = harness.session.opens![0], config = opened.config as { permissions: Record<string, { filesystem: Record<string, string>; network: { enabled: boolean } }>; mcp_servers: Record<string, { url: string }> };
  const workspace = browserWorkspace({ work, checkout, conversationId: conversation }), rules = config.permissions[opened.permissions!];
  assert.equal(opened.cwd, workspace.analysis); assert.equal(opened.sandbox, undefined);
  assert.equal(fs.readFileSync(path.join(opened.cwd, 'AGENTS.md'), 'utf8'), 'Invented client-package guidance.');
  assert.equal(rules.filesystem[store.dir], 'deny'); assert.equal(rules.filesystem[path.join(work, 'browser-tickets')], 'deny');
  assert.equal(rules.filesystem[workspace.evidence], 'read'); assert.equal(rules.filesystem[workspace.analysis], 'write'); assert.equal(rules.filesystem[workspace.output], 'write');
  assert.equal(rules.filesystem[path.join(workspace.analysis, 'AGENTS.md')], 'read'); assert.equal(rules.network.enabled, false);
  assert.equal(config.mcp_servers['fixture-source'].url, sourceUrls[0]);
  const other = options({ conversationId: 'fixture:ticket:CASE-102', workspace: browserWorkspace({ work, checkout, conversationId: 'fixture:ticket:CASE-102' }) });
  assert.notEqual(other.permissions, opened.permissions); assert.notEqual((other.config!.mcp_servers as Record<string, {url:string}>)['fixture-source'].url, sourceUrls[0]);
});

test('owning browser launcher refuses missing private roots and source attempts to override the permission boundary', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-profile-refusal-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => createBrowserThreadOptions({ work: root, checkout: root, readRoots: [], privateRoots: [] }), /private authority paths/);
  assert.throws(() => createBrowserThreadOptions({ work: root, checkout: root, readRoots: [], privateRoots: ['relative'] }), /absolute launcher paths/);
  const options = createBrowserThreadOptions({ work: root, checkout: root, readRoots: [], privateRoots: [path.join(root, 'private')], sourceConfig: () => ({ config: { permissions: {} } }) });
  assert.throws(() => options({ conversationId: 'fixture:ticket:CASE-101', workspace: browserWorkspace({ work: root, checkout: root, conversationId: 'fixture:ticket:CASE-101' }) }), /cannot override/);
});
