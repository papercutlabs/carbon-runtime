import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as codex from '../harness/codex/index.ts';
import type { AccountRead } from '../harness/codex/index.ts';
import { ProviderAccountRecorder, PROVIDER_ACCOUNT_FILE, mergeSparse } from '../runtime/provider-account.ts';
import type { ProviderAccountRecord } from '../runtime/provider-account.ts';
import { run } from '../runtime/index.ts';
import { sandboxDenyBody } from '../runtime/loop.ts';
import { EXIT } from '../runtime/faults.ts';
import type { Declaration, Harness } from '../runtime/types.ts';
import { fakeHarness, FakeSession } from './fake-harness.ts';
import type { OnTurn } from './fake-harness.ts';
import * as fixture from '../adapters/fixture/index.ts';

// PA-259: the runtime records which provider account its harness runs on, in
// store/provider-account.json, from the session it already holds. Two kinds of
// harness are used and neither runs a model or reaches a network: the real
// harness's readAccount against a scripted app-server stub, for what goes over
// the wire and what reaches the record; and the fake harness with a scripted
// readAccount beside it, for what a read may never do to a turn.

const CANARY = 'PA259_CANARY_TOKEN_2b9d41';

const STUB = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const login = fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(m) + '\n');
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'carbon/0.153.4 (Linux; x86_64)', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' } });
    else if (m.method === 'account/read') send({ id: m.id, result: {
      account: { type: 'chatgpt', email: 'pa259-synthetic@example.invalid', planType: 'plus', accessToken: process.env.CANARY, login },
      requiresOpenaiAuth: true, idToken: process.env.CANARY } });
    else if (m.method === 'account/rateLimits/read') send({ id: m.id, result: {
      rateLimits: { limitId: 'codex', planType: 'plus', refreshToken: process.env.CANARY,
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 },
        secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1790500000 },
        credits: { hasCredits: true, unlimited: false, balance: '5', login } },
      accountId: 'acct-synthetic-1', rateLimitUpsell: { access_token: process.env.CANARY, login } } });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'stub does not answer ' + m.method } });
  }
});
`;

type After = { after(fn: () => unknown): void };

// The bounds are unref'd timers on purpose, so a read nobody answers never keeps
// a stopping process alive. A test waiting on one keeps its own loop alive.
function keepAlive(t: After) {
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
}

function tmp(t: After, name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `carbon-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A box's shape, as far as this record cares: a store, and a CODEX_HOME holding a
// login file whose contents are a canary.
function box(t: After, name: string) {
  const dir = tmp(t, name);
  const storeDir = path.join(dir, 'store');
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const loginFile = path.join(codexHome, 'auth.json');
  fs.writeFileSync(loginFile, JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `${CANARY}_refresh` } }), { mode: 0o600 });
  const written = new Date('2026-09-20T08:00:00.000Z');
  fs.utimesSync(loginFile, written, written);
  return { dir, storeDir, codexHome, loginFile, written, recordFile: path.join(storeDir, PROVIDER_ACCOUNT_FILE) };
}

function readRecord(file: string): ProviderAccountRecord {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function okRead(n: number, overrides: Partial<AccountRead> = {}): AccountRead {
  return {
    observed_at: `2026-09-27T0${n}:00:00.000Z`,
    codex_version: '0.153.4',
    account: { type: 'chatgpt', email: `synthetic-${n}@example.invalid`, plan_type: 'plus' },
    requires_openai_auth: true,
    rate_limits: {
      account_id: 'acct-synthetic-1', limit_id: 'codex', limit_name: null, plan_type: 'plus',
      primary: { used_percent: 10 * n, window_minutes: 300, resets_at: 1790000000 },
      secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1790500000 },
      credits: { has_credits: true, unlimited: false, balance: '5' },
      rate_limit_reached_type: null
    },
    error: null,
    ...overrides
  };
}

// The fake harness with a scripted account read beside it. The fake itself is
// used as it is; readAccount is what the real harness module adds.
function scripted(readAccount: (session: FakeSession, options: { timeoutMs: number }) => Promise<AccountRead>, onTurn?: OnTurn) {
  const fake = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }], onTurn });
  return { ...fake, readAccount, rateLimitsFrom: codex.rateLimitsFrom };
}

test('the real harness, on a stub app-server: refreshToken is false and no token or login-file byte reaches the record', async (t) => {
  const b = box(t, 'account-wire');
  const script = path.join(b.dir, 'stub.cjs');
  fs.writeFileSync(script, STUB);
  const binary = path.join(b.dir, 'codex');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  const wireLog = path.join(b.dir, 'wire.jsonl');
  const session = await codex.connect({ binary, codexHome: b.codexHome, extraEnv: { STUB_LOG: wireLog, CANARY } });
  t.after(() => session.stop());

  // The login file is stat'ed and never opened; every open and read this process
  // makes while recording is watched for it.
  const touched: string[] = [];
  const openSync = fs.openSync;
  const readFileSync = fs.readFileSync;
  fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => { touched.push(String(file)); return (openSync as (...a: unknown[]) => number)(file, ...rest); }) as typeof fs.openSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => { touched.push(String(file)); return (readFileSync as (...a: unknown[]) => unknown)(file, ...rest); }) as typeof fs.readFileSync;
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness: codex as unknown as Harness<typeof session>, timeoutMs: 5000 });
  try {
    recorder.attach(session);
    recorder.request('connect');
    await recorder.settled();
    recorder.request('turn');
    await recorder.settled();
  } finally {
    fs.openSync = openSync;
    fs.readFileSync = readFileSync;
  }
  assert.ok(!touched.includes(b.loginFile), `the login file was opened: ${touched.join(', ')}`);

  const sent = fs.readFileSync(wireLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: unknown });
  const accountReads = sent.filter((m) => m.method === 'account/read');
  assert.equal(accountReads.length, 2);
  for (const m of accountReads) assert.deepEqual(m.params, { refreshToken: false });

  const text = fs.readFileSync(b.recordFile, 'utf8');
  assert.ok(!text.includes(CANARY), 'a token reached the record');
  assert.ok(!text.includes(fs.readFileSync(b.loginFile, 'utf8').slice(0, 20)), 'login-file bytes reached the record');
  const record = readRecord(b.recordFile);
  assert.deepEqual(record.account, { type: 'chatgpt', email: 'pa259-synthetic@example.invalid', plan_type: 'plus' });
  assert.equal(record.requires_openai_auth, true);
  assert.equal(record.rate_limits?.account_id, 'acct-synthetic-1');
  assert.deepEqual(record.rate_limits?.primary, { used_percent: 42, window_minutes: 300, resets_at: 1790000000 });
  assert.equal(record.codex_version, '0.153.4');
  assert.equal(record.login_file_modified_at, b.written.toISOString());
  assert.equal(record.error, null);
  assert.ok(record.observed_at && record.account_observed_at && record.rate_limits_observed_at);
});

test('a failed read writes error and keeps the last values, each dated by its own observed_at', async (t) => {
  const b = box(t, 'account-failed');
  let n = 0;
  const harness = scripted(async () => {
    n += 1;
    if (n === 1) return okRead(1);
    if (n === 2) return okRead(2, { rate_limits: null, error: [{ method: 'account/rateLimits/read', message: 'failed to fetch codex rate limits: synthetic' }] });
    throw new Error('the harness threw');
  });
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000 });
  recorder.attach(harness.session);

  recorder.request('connect');
  await recorder.settled();
  const first = readRecord(b.recordFile);
  assert.equal(first.error, null);

  recorder.request('turn');
  await recorder.settled();
  const second = readRecord(b.recordFile);
  assert.equal(second.account?.email, 'synthetic-2@example.invalid');
  assert.equal(second.account_observed_at, '2026-09-27T02:00:00.000Z');
  assert.deepEqual(second.rate_limits, first.rate_limits, 'a failed rate-limit read cleared the last one');
  assert.equal(second.rate_limits_observed_at, '2026-09-27T01:00:00.000Z');
  assert.deepEqual(second.error?.reads.map((e) => e.method), ['account/rateLimits/read']);

  recorder.request('turn');
  await recorder.settled();
  const third = readRecord(b.recordFile);
  assert.equal(third.account?.email, 'synthetic-2@example.invalid');
  assert.equal(third.account_observed_at, '2026-09-27T02:00:00.000Z');
  assert.deepEqual(third.error?.reads, [{ method: 'readAccount', message: 'the harness threw' }]);
});

test('a read that never returns is bounded, and recorded as error', async (t) => {
  const b = box(t, 'account-hung');
  keepAlive(t);
  const harness = scripted(() => new Promise<AccountRead>(() => {}));
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 20 });
  recorder.attach(harness.session);
  const started = Date.now();
  recorder.request('connect');
  await recorder.settled();
  assert.ok(Date.now() - started < 5000);
  const record = readRecord(b.recordFile);
  assert.match(record.error?.reads[0].message ?? '', /did not return within 1020 ms/);
  assert.equal(record.account, null);
  assert.equal(record.login_file_modified_at, b.written.toISOString());
});

test('a sparse rate-limit update merges into the last read and a null never clears a value', async (t) => {
  const b = box(t, 'account-sparse');
  const harness = scripted(async () => okRead(1));
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000, now: () => Date.parse('2026-09-27T05:00:00.000Z') });
  recorder.attach(harness.session);
  recorder.request('connect');
  await recorder.settled();

  recorder.accept({ kind: 'account.rate_limits', params: { rateLimits: {
    limitId: null, planType: null, secondary: null, credits: null,
    primary: { usedPercent: 55, windowDurationMins: null, resetsAt: null }
  } } });
  const record = readRecord(b.recordFile);
  assert.deepEqual(record.rate_limits, {
    account_id: 'acct-synthetic-1', limit_id: 'codex', limit_name: null, plan_type: 'plus',
    primary: { used_percent: 55, window_minutes: 300, resets_at: 1790000000 },
    secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1790500000 },
    credits: { has_credits: true, unlimited: false, balance: '5' },
    rate_limit_reached_type: null
  });
  assert.equal(record.rate_limits_observed_at, '2026-09-27T01:00:00.000Z');
  assert.equal(record.rate_limits_updated_at, '2026-09-27T05:00:00.000Z');
  assert.deepEqual(mergeSparse({ a: 1, b: { c: 2 } }, { a: null, b: { c: undefined, d: 3 } }), { a: 1, b: { c: 2, d: 3 } });
});

test('the record is replaced by a rename, never rewritten in place, and leaves no temporary file', async (t) => {
  const b = box(t, 'account-atomic');
  let n = 0;
  const harness = scripted(async () => okRead(++n));
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000 });
  recorder.attach(harness.session);
  recorder.request('connect');
  await recorder.settled();
  const before = fs.statSync(b.recordFile).ino;
  const held = fs.readFileSync(b.recordFile, 'utf8');
  recorder.request('turn');
  await recorder.settled();
  assert.notEqual(fs.statSync(b.recordFile).ino, before, 'the record was rewritten in place');
  assert.notEqual(fs.readFileSync(b.recordFile, 'utf8'), held);
  assert.deepEqual(fs.readdirSync(b.storeDir), [PROVIDER_ACCOUNT_FILE]);
});

// ---- inside the runtime ------------------------------------------------------

function declaration(): Declaration {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: 'test-agent', client: 'ExampleCorp' },
    harness: { kind: 'codex-app-server', version: '0.153.4' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
    tool_servers: [],
    channels: [{ kind: 'fixture', account: 'account-1', release: 'quiet', quiet_ms: 0, poll_interval_ms: 10 }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

async function runWith(t: After, harness: ReturnType<typeof scripted>) {
  const b = box(t, 'account-run');
  const decl = declaration();
  const declarationPath = path.join(b.dir, 'carbon.agent.json');
  fs.writeFileSync(declarationPath, JSON.stringify(decl));
  fs.mkdirSync(path.join(b.dir, 'work'));
  const denyFile = path.join(b.dir, 'requirements.toml');
  fs.writeFileSync(denyFile, sandboxDenyBody(b.dir));
  fs.chmodSync(denyFile, 0o644);
  const log: Record<string, unknown>[] = [];
  const started = Date.now();
  const code = await run({
    declaration: decl, declarationPath, storeDir: b.storeDir, codexHome: b.codexHome,
    checkout: path.join(b.dir, 'repo'), work: path.join(b.dir, 'work'), harnessRoot: path.join(b.dir, 'harness'),
    binary: '/nowhere/codex', replyPort: 20000 + Math.floor(Math.random() * 20000),
    harness, adapters: { fixture },
    items: () => [{ conversation: 'c1', id: '1', position: '0001', at: '2026-09-10T10:01:00.000Z', sender: 'contact-1', text: 'hello' }],
    passes: 1, log: (line) => log.push(line),
    sandboxDeny: { file: denyFile, root: b.dir, ownerUid: process.getuid ? process.getuid() : 0 }
  });
  return { code, log, elapsed: Date.now() - started, ...b };
}

// A turn that waits a little, so the read the connect started has room to land
// before the turn does and the record can be read back at the end.
const slowTurn = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return 'completed'; };

test('the runtime reads the account after connect and after each completed turn', async (t) => {
  let reads = 0;
  const harness = scripted(async () => okRead(++reads), slowTurn);
  const { code, recordFile, log } = await runWith(t, harness);
  assert.equal(code, EXIT.OK);
  assert.ok(harness.session.turns.length >= 1);
  const recorded = log.filter((l) => l.event === 'provider_account.recorded').map((l) => l.reason);
  assert.equal(recorded[0], 'connect', `the first read was not the one after connect: ${JSON.stringify(recorded)}`);
  assert.ok(recorded.slice(1).includes('turn'), `no read followed a turn: ${JSON.stringify(recorded)}`);
  assert.equal(readRecord(recordFile).account?.email, `synthetic-${reads}@example.invalid`);
});

test('a read that fails or never returns neither fails nor holds a turn', async (t) => {
  const failing = scripted(async () => { throw new Error('synthetic read failure'); }, slowTurn);
  const failed = await runWith(t, failing);
  assert.equal(failed.code, EXIT.OK);
  assert.ok(failing.session.turns.length >= 1, 'no turn was taken');
  assert.deepEqual(readRecord(failed.recordFile).error?.reads, [{ method: 'readAccount', message: 'synthetic read failure' }]);

  keepAlive(t);
  let asked = 0;
  const hung = scripted(() => { asked += 1; return new Promise<AccountRead>(() => {}); }, slowTurn);
  const held = await runWith(t, hung);
  assert.equal(held.code, EXIT.OK);
  assert.ok(asked >= 1, 'the read was never asked');
  assert.ok(hung.session.turns.length >= 1, 'no turn was taken');
  const thread = JSON.parse(fs.readFileSync(path.join(held.storeDir, 'threads', fs.readdirSync(path.join(held.storeDir, 'threads'))[0]), 'utf8'));
  assert.ok(thread.completed_turns >= 1, 'the turn did not complete while the read was held');
  assert.ok(held.elapsed < 10_000, `the run waited ${held.elapsed} ms on a read that never returns`);
});
