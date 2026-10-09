import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import * as browser from '../adapters/browser/index.ts';
import { createBrowserBridge } from '../runtime/browser.ts';
import { createBrowserHost } from '../runtime/browser-host.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { fakeHarness } from './fake-harness.ts';
import type { Declaration } from '../runtime/types.ts';

const account = 'test-account', agent = 'test-agent', KEY = 'CASE-101', GRANT = 'g';
const alice = { id: 'alice', name: 'Alice' };
const declaration = (): Declaration => ({ agent: { id: agent }, model: 'fixture', effort: 'low', provider: { name: 'openai', auth: 'chatgpt' },
  sandbox: { mode: 'read-only', network: false }, unit_of_work: { kind: 'conversation' }, teaching: { enabled: false }, records: { enabled: false },
  tool_servers: [], channels: [{ kind: 'browser', account, release: 'quiet', quiet_ms: 0, default_conversation_kind: 'ops' }] });

// The same acceptance crash the release-loop tests drive, read through the host.
test('after a model acceptance and a crash the host shows the native turn and a native reason on the input and on the activity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-host-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = Store.open(path.join(root, 'store'));
  const bridge = createBrowserBridge({ store, account, agent, authorize: (grant) => grant === GRANT });
  const host = createBrowserHost({ store, bridge, account });
  const decl = declaration();
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  const crashing = { ...harness, async turn(_session: unknown, params: { threadId: string; onStarted?: (value: { threadId: string; turnId: string }) => void }) {
    params.onStarted?.({ threadId: params.threadId, turnId: 'native-accepted-17' });
    throw new Error('synthetic transport loss after native acceptance');
  }, async readThread() { return { thread: { id: 'thread-1', turns: [{ id: 'native-accepted-17', status: 'inProgress' }] } }; } };
  const make = () => new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, agent, adapter: browser,
    harness: crashing, session: harness.session, checkout: root, work: root, prepareBrowserTurn: async () => ({ data: { key: KEY } }) });
  const submitted = await host.submitMessage(GRANT, { ticketKey: KEY, submissionId: '1', consultant: alice, text: 'question', requestKind: 'investigate',
    acceptedAt: '2026-10-09T00:00:00Z', position: '1'.padStart(20, '0') });
  assert.equal(submitted.message.state, 'accepted'); assert.equal(submitted.message.nativeReason, null);
  await assert.rejects(make().pass([]), /synthetic transport loss/);

  const crashed = await host.readConversation(GRANT, KEY);
  const input = crashed.messages.map((m) => m.message).find((m) => m.submissionIds[0] === '1')!;
  assert.equal(input.state, 'uncertain');
  assert.match(input.nativeReason ?? '', /synthetic transport loss after native acceptance/);
  assert.equal(input.requestKind, 'investigate');
  assert.equal(crashed.activity!.state, 'uncertain'); assert.equal(crashed.activity!.nativeTurnId, 'native-accepted-17');
  assert.match(crashed.activity!.nativeReason ?? '', /synthetic transport loss after native acceptance/);

  // after a restart the loop inspects the thread; the reason is still the native failure, not lost
  const restart = make(); restart.recovering = restart.recover(); await restart.pass([]);
  const restarted = await host.readConversation(GRANT, KEY);
  assert.equal(restarted.messages.map((m) => m.message).find((m) => m.submissionIds[0] === '1')!.state, 'uncertain');
  assert.match(restarted.messages.map((m) => m.message).find((m) => m.submissionIds[0] === '1')!.nativeReason ?? '', /synthetic transport loss after native acceptance/);
  assert.equal(restarted.activity!.nativeTurnId, 'native-accepted-17');
});
