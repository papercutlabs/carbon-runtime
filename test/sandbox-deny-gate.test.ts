// HC-14's deny file as the runtime's own gate (PA-259). The harness copies the file's
// deny_read list into a thread when the thread opens or resumes and says nothing when
// the file is absent, so the runtime refuses to start the harness, open or resume a
// thread, or take a turn unless the file is exactly bootstrap.sh's. A refusal ends the
// process rather than parking one record, and a correct file changes nothing.
import type { Declaration, Channel, Server } from '../runtime/types.ts';
import type { Store as StoreType } from '../stream/store.ts';
type TestDeclaration = Declaration & { schema: string; agent: { id: string; client: string }; channels: Channel[]; secrets: { name: string; path: string }[]; tool_servers: Server[]; unit_of_work: { kind: string; id_from: string; idle_close_ms?: number }; sandbox: { mode: string; network: boolean }; limits: { max_turn_ms: number } };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop, checkSandboxDeny, sandboxDenyBody, endsTheProcess, SANDBOX_DENY_FILE } from '../runtime/loop.ts';
import type { SandboxDenyGate } from '../runtime/loop.ts';
import { run } from '../runtime/index.ts';
import { RuntimeFault } from '../runtime/faults.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import * as fixture from '../adapters/fixture/index.ts';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const OWNER = process.getuid ? process.getuid() : 0;

function declaration(): TestDeclaration {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
    tool_servers: [],
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000, conversations: [], default_conversation_kind: 'customer' }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

// A deny file in the test's own directory, standing in for /etc/codex/requirements.toml.
function denyGate(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-deny-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'agent');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(dir, 'requirements.toml');
  const place = (body = sandboxDenyBody(root)) => { fs.writeFileSync(file, body); fs.chmodSync(file, 0o644); };
  place();
  const gate: SandboxDenyGate = { file, root, ownerUid: OWNER };
  return { dir, root, file, gate, place };
}

function refusal(fn: () => unknown) {
  try { fn(); } catch (error) { return error; }
  return null;
}

test('the runtime\'s gate names the real file, and bootstrap.sh\'s bytes are what it accepts', (t) => {
  assert.equal(SANDBOX_DENY_FILE, '/etc/codex/requirements.toml');
  const { root, gate } = denyGate(t);
  assert.equal(sandboxDenyBody(root),
    '# Placed by carbon bootstrap.sh for HC-14. The model\'s shell may not read the\n'
    + '# provider login or the secrets directory. Nothing else is set here.\n'
    + '[permissions.filesystem]\n'
    + `deny_read = ["${root}/codex-home/auth.json", "${root}/secrets"]\n`);
  assert.equal(refusal(() => checkSandboxDeny(gate, 'now')), null);
});

test('each way the file can be wrong is refused, and the refusal ends the process', (t) => {
  const { root, file, gate, place } = denyGate(t);
  const cases: [string, () => void, RegExp][] = [
    ['absent', () => {}, /it is absent/],
    ['another agent', () => place(sandboxDenyBody(root.replace('agent', 'another-agent'))), /content is not exactly/],
    ['a glob', () => place(sandboxDenyBody(path.join(path.dirname(root), '*'))), /content is not exactly/],
    ['an extra entry', () => place(`${sandboxDenyBody(root)}deny_read = []\n`), /content is not exactly/],
    ['mode 0666', () => { place(); fs.chmodSync(file, 0o666); }, /mode is 666, not 644/],
    ['a symlink', () => { const real = `${file}.real`; place(); fs.renameSync(file, real); fs.symlinkSync(real, file); }, /is a symlink/]
  ];
  for (const [name, spoil, said] of cases) {
    fs.rmSync(file, { force: true });
    spoil();
    const error = refusal(() => checkSandboxDeny(gate, 'before a turn'));
    assert.ok(error instanceof RuntimeFault, name);
    assert.equal((error as RuntimeFault).faults[0].code, 'SANDBOX_DENY_NOT_PLACED', name);
    assert.match((error as RuntimeFault).faults[0].problem, said, name);
    assert.equal(endsTheProcess(error), true, `${name}: the refusal would park one record and keep the agent running`);
  }
  place();
  const wrongOwner = refusal(() => checkSandboxDeny({ ...gate, ownerUid: OWNER + 1 }, 'before a turn'));
  assert.match((wrongOwner as RuntimeFault).faults[0].problem, /owned by uid/);
});

function loopWith(gate: SandboxDenyGate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-deny-loop-'));
  const store = Store.open(dir);
  const handle = replyHandler({ store, agent: AGENT });
  const harness = fakeHarness({
    onTurn: (_session, params) => {
      handle({ conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'the answer' });
      return 'completed';
    },
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }]
  });
  const decl = declaration();
  const loop = new ReleaseLoop({
    declaration: decl, channel: decl.channels[0], store, storeDir: dir, adapter: fixture,
    harness, session: harness.session, agent: AGENT, checkout: path.join(dir, 'repo'), work: dir, sandboxDeny: gate
  });
  return { loop, store, harness, dir };
}

function item(id: number, text: string) {
  return { conversation: 'c1', id: String(id), position: String(id).padStart(4, '0'), at: `2026-09-10T10:0${id}:00.000Z`, sender: 'contact-1', text };
}

function dispositionOf(store: StoreType, id: number) {
  return store.read(`${ACCOUNT}:c1`, String(id), 0)?.disposition ?? null;
}

test('with the file exact, a new thread opens and the turn does its work', async (t) => {
  const { gate } = denyGate(t);
  const { loop, harness } = loopWith(gate);
  await loop.pass([item(1, 'hello')]);
  assert.equal(harness.session.turns.length, 1);
  assert.equal(harness.session.opens?.length, 1);
});

test('a wrong file stops a new thread before it opens: no thread, no turn, nothing parked', async (t) => {
  const { gate, place, root } = denyGate(t);
  place(sandboxDenyBody(root.replace('agent', 'another-agent')));
  const { loop, harness, store } = loopWith(gate);
  await assert.rejects(loop.pass([item(1, 'hello')]), (error) => (error as RuntimeFault).faults?.[0]?.code === 'SANDBOX_DENY_NOT_PLACED');
  assert.equal(harness.session.opens, undefined, 'a thread was opened under a wrong deny file');
  assert.equal(harness.session.turns.length, 0);
  assert.notEqual(dispositionOf(store, 1), 'parked');
});

test('a wrong file stops a resumed thread before it resumes', async (t) => {
  const { gate, file } = denyGate(t);
  const { loop, harness, store } = loopWith(gate);
  store.writeThread(`${ACCOUNT}:c1`, { unit_id: `${ACCOUNT}:c1`, thread_id: 'thread-earlier', completed_turns: 1, turns: [] });
  fs.rmSync(file);
  await assert.rejects(loop.pass([item(1, 'hello')]), (error) => (error as RuntimeFault).faults?.[0]?.code === 'SANDBOX_DENY_NOT_PLACED');
  assert.equal(harness.session.resumed, undefined, 'a thread was resumed with no deny file');
  assert.equal(harness.session.turns.length, 0);
  assert.notEqual(dispositionOf(store, 1), 'parked');
});

test('a file changed after a thread is open stops the next turn on that same thread', async (t) => {
  const { gate, place, root } = denyGate(t);
  const { loop, harness, store } = loopWith(gate);
  await loop.pass([item(1, 'hello')]);
  assert.equal(harness.session.turns.length, 1);
  place(sandboxDenyBody(root.replace('agent', 'another-agent')));
  await assert.rejects(loop.pass([item(2, 'again')]), (error) => (error as RuntimeFault).faults?.[0]?.code === 'SANDBOX_DENY_NOT_PLACED');
  assert.equal(harness.session.turns.length, 1, 'a turn ran on a cached thread after the deny file changed');
  assert.notEqual(dispositionOf(store, 2), 'parked');
});

test('run refuses to start the harness on a wrong file, and so refuses again on every restart', async (t) => {
  const { gate, file } = denyGate(t);
  fs.rmSync(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-deny-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  const decl = declaration();
  const declarationPath = path.join(dir, 'carbon.agent.json');
  fs.writeFileSync(declarationPath, JSON.stringify(decl, null, 2));
  const base = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  let connected = 0;
  const harness = { ...base, async connect() { connected += 1; return base.session; } };
  for (let restart = 0; restart < 2; restart++) {
    await assert.rejects(run({
      declaration: decl, declarationPath, storeDir: path.join(dir, 'store'), codexHome: path.join(dir, 'codex-home'),
      checkout: path.join(dir, 'repo'), work: path.join(dir, 'work'), harnessRoot: path.join(dir, 'harness'),
      binary: '/nowhere/codex', replyPort: 20000 + Math.floor(Math.random() * 20000), harness,
      adapters: { fixture }, items: () => [], passes: 1, sandboxDeny: gate
    }), (error) => (error as RuntimeFault).faults?.[0]?.code === 'SANDBOX_DENY_NOT_PLACED');
  }
  assert.equal(connected, 0, 'the harness was started with no deny file');
});

test('the bytes the runtime accepts are the bytes carbon-core\'s bootstrap.sh writes', (t) => {
  // The two copies must agree, or every box refuses to start. The core checkout is the
  // same one the schema copy is compared against.
  const authority = process.env.CARBON_SCHEMA_AUTHORITY;
  if (!authority) {
    t.skip('CARBON_SCHEMA_AUTHORITY is unset, so there is no core bootstrap.sh to compare with');
    return;
  }
  const source = fs.readFileSync(path.join(authority, 'host', 'bootstrap.sh'), 'utf8');
  const start = 'cat > "$TMP_REQ" <<EOF\n';
  const rest = source.slice(source.indexOf(start) + start.length);
  const written = rest.slice(0, rest.indexOf('\nEOF\n') + 1).replaceAll('$ROOT', '/srv/carbon/example-agent');
  assert.equal(sandboxDenyBody('/srv/carbon/example-agent'), written);
});
