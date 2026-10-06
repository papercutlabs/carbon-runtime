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
import { sandboxDenyBody, ReleaseLoop } from '../runtime/loop.ts';
import { EXIT, RuntimeFault, fault } from '../runtime/faults.ts';
import { resolveChannel } from '../runtime/channel.ts';
import { Store } from '../stream/store.ts';
import type { Declaration, Harness, Channel } from '../runtime/types.ts';
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
    else if (m.method === 'account/read' && process.env.STUB_SCENARIO === 'fail') send({ id: m.id, error: { code: -32603, message: 'account read failed: ' + process.env.CANARY, data: login } });
    else if (m.method === 'account/rateLimits/read' && process.env.STUB_SCENARIO === 'fail') send({ id: m.id, error: { code: -32001, message: 'failed to fetch codex rate limits: ' + process.env.CANARY } });
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

// The record is written by a queued writer after the fact, so a run that has
// returned may still have its last write under way. Waits for the record on disk
// to satisfy `check`, and fails with the last record seen when it never does.
async function eventually(file: string, check: (record: ProviderAccountRecord) => boolean, ms = 5000) {
  const until = Date.now() + ms;
  let last: ProviderAccountRecord | null = null;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      last = readRecord(file);
      if (check(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`the record never reached the expected state: ${JSON.stringify(last)}`);
}

const THREW = { method: 'readAccount', code: 'READ_ACCOUNT_THREW', summary: 'readAccount threw; its redacted original reason is retained when available', rpc_code: null, original_reason: 'the harness threw', original_reason_available: true };
const LIMITS_REJECTED = { method: 'account/rateLimits/read', code: 'RATE_LIMITS_READ_REJECTED', summary: 'account/rateLimits/read: the app-server answered with an error; its redacted original reason is retained when available', rpc_code: -32001, original_reason: 'failed to fetch codex rate limits: [REDACTED]', original_reason_available: true, native_code: -32001 };
const ACCOUNT_REJECTED = { method: 'account/read', code: 'ACCOUNT_READ_REJECTED', summary: 'account/read: the app-server answered with an error; its redacted original reason is retained when available', rpc_code: -32603, original_reason: 'account read failed: [REDACTED]', original_reason_available: true, native_code: -32603 };

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

async function stubSession(t: After, b: ReturnType<typeof box>, scenario = 'ok') {
  const script = path.join(b.dir, 'stub.cjs');
  fs.writeFileSync(script, STUB);
  const binary = path.join(b.dir, 'codex');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  const wireLog = path.join(b.dir, 'wire.jsonl');
  const session = await codex.connect({ binary, codexHome: b.codexHome, extraEnv: { STUB_LOG: wireLog, STUB_SCENARIO: scenario, CANARY } });
  t.after(() => session.stop());
  return { session, wireLog };
}

test('the real harness, on a stub app-server: refreshToken is false and no token or login-file byte reaches the record', async (t) => {
  const b = box(t, 'account-wire');
  const { session, wireLog } = await stubSession(t, b);

  // The login file is stat'ed and never opened; every open and read this process
  // makes while recording is watched for it.
  const touched: string[] = [];
  const openSync = fs.openSync;
  const readFileSync = fs.readFileSync;
  fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => { touched.push(String(file)); return (openSync as (...a: unknown[]) => number)(file, ...rest); }) as typeof fs.openSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => { touched.push(String(file)); return (readFileSync as (...a: unknown[]) => unknown)(file, ...rest); }) as typeof fs.readFileSync;
  // The codex harness supplies the recorder methods; this cast binds the stub session type.
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

  // The stub emits JSON-RPC wire lines; this view reads method and params from each parsed request.
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
    // The same account as the first read, so what is kept is that account's.
    if (n === 2) return okRead(2, { account: okRead(1).account, rate_limits: null, error: [LIMITS_REJECTED] });
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
  assert.equal(second.account?.email, 'synthetic-1@example.invalid');
  assert.equal(second.account_observed_at, '2026-09-27T02:00:00.000Z');
  assert.deepEqual(second.rate_limits, first.rate_limits, 'a failed rate-limit read cleared the last one');
  assert.equal(second.rate_limits_observed_at, '2026-09-27T01:00:00.000Z');
  assert.deepEqual(second.error?.reads.map((e) => e.method), ['account/rateLimits/read']);

  recorder.request('turn');
  await recorder.settled();
  const third = readRecord(b.recordFile);
  assert.equal(third.account?.email, 'synthetic-1@example.invalid');
  assert.equal(third.account_observed_at, '2026-09-27T02:00:00.000Z');
  assert.deepEqual(third.error?.reads, [THREW]);
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
  assert.deepEqual(record.error?.reads, [{ method: 'readAccount', code: 'READ_ACCOUNT_UNSETTLED', summary: 'readAccount did not return within the bound', rpc_code: null, original_reason: null, original_reason_available: false }]);
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
  await recorder.settled();
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

async function runWith(t: After, harness: ReturnType<typeof scripted>, onBox: (recordFile: string) => void = () => {}) {
  const b = box(t, 'account-run');
  onBox(b.recordFile);
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
  await eventually(recordFile, (record) => record.account?.email === `synthetic-${reads}@example.invalid`);
});

test('a read that fails or never returns neither fails nor holds a turn', async (t) => {
  const failing = scripted(async () => { throw new Error('synthetic read failure'); }, slowTurn);
  const failed = await runWith(t, failing);
  assert.equal(failed.code, EXIT.OK);
  assert.ok(failing.session.turns.length >= 1, 'no turn was taken');
  await eventually(failed.recordFile, (record) => JSON.stringify(record.error?.reads) === JSON.stringify([{ ...THREW, original_reason: 'synthetic read failure' }]));

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

// ---- the review's corrections -------------------------------------------------

test('redacted native error reasons reach the record while credentials stay out of records and logs', async (t) => {
  // Both JSON-RPC errors from the stub quote the canary, and the account one the
  // login file: what a provider puts in an error is not carbon's to keep.
  const b = box(t, 'account-error-text');
  const { session } = await stubSession(t, b, 'fail');
  const lines: Record<string, unknown>[] = [];
  // The codex harness supplies the recorder methods; this cast binds the stub session type.
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness: codex as unknown as Harness<typeof session>, timeoutMs: 5000, log: (line) => lines.push(line) });
  recorder.attach(session);
  recorder.request('connect');
  await recorder.settled();
  const text = fs.readFileSync(b.recordFile, 'utf8');
  assert.deepEqual(readRecord(b.recordFile).error?.reads, [ACCOUNT_REJECTED, LIMITS_REJECTED]);
  assert.ok(!text.includes(CANARY), 'error text from the wire reached the record');
  assert.ok(!text.includes(fs.readFileSync(b.loginFile, 'utf8').slice(0, 20)), 'login-file bytes reached the record');

  // A harness that throws with a secret in its message is recorded by a fixed code.
  const throwing = scripted(async () => { throw new Error(`${CANARY} in a thrown message`); });
  throwing.session.credentialValues = [CANARY];
  const other = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness: throwing, timeoutMs: 1000, log: (line) => lines.push(line) });
  other.attach(throwing.session);
  other.request('turn');
  await other.settled();
  assert.deepEqual(readRecord(b.recordFile).error?.reads, [{ ...THREW, original_reason: '[REDACTED] in a thrown message' }]);
  assert.ok(!fs.readFileSync(b.recordFile, 'utf8').includes(CANARY));
  assert.ok(!JSON.stringify(lines).includes(CANARY), 'error text reached the log');
});

test('an account switch with a failed rate-limit read clears the last account\'s limits until a fresh read of the new one', async (t) => {
  const b = box(t, 'account-switch');
  const a = okRead(1, { account: { type: 'chatgpt', email: 'A@example.invalid', plan_type: 'plus' } });
  const reads: AccountRead[] = [
    a,
    okRead(2, { account: { type: 'chatgpt', email: 'B@example.invalid', plan_type: 'pro' }, rate_limits: null, error: [LIMITS_REJECTED] }),
    okRead(3, { account: { type: 'chatgpt', email: 'B@example.invalid', plan_type: 'pro' } })
  ];
  const harness = scripted(async () => reads.shift()!);
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000 });
  recorder.attach(harness.session);
  recorder.request('connect');
  await recorder.settled();
  recorder.accept({ kind: 'account.rate_limits', params: { rateLimits: { primary: { usedPercent: 77 } } } });
  await recorder.settled();
  assert.equal(readRecord(b.recordFile).rate_limits?.primary?.used_percent, 77);

  recorder.request('turn');
  await recorder.settled();
  const switched = readRecord(b.recordFile);
  assert.equal(switched.account?.email, 'B@example.invalid');
  assert.equal(switched.rate_limits, null, 'account A\'s limits were kept beside account B');
  assert.equal(switched.rate_limits_observed_at, null);
  assert.equal(switched.rate_limits_updated_at, null);
  assert.deepEqual(switched.error?.reads, [LIMITS_REJECTED]);

  recorder.request('turn');
  await recorder.settled();
  const fresh = readRecord(b.recordFile);
  assert.equal(fresh.rate_limits?.primary?.used_percent, 30);
  assert.equal(fresh.rate_limits_observed_at, '2026-09-27T03:00:00.000Z');
});

test('rate limits answered without the account are not bound to the account held', async (t) => {
  const b = box(t, 'account-unconfirmed');
  const reads: AccountRead[] = [
    okRead(1),
    okRead(2, { account: null, requires_openai_auth: null, error: [ACCOUNT_REJECTED] })
  ];
  const harness = scripted(async () => reads.shift()!);
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000 });
  recorder.attach(harness.session);
  recorder.request('connect');
  await recorder.settled();
  recorder.request('turn');
  await recorder.settled();
  const record = readRecord(b.recordFile);
  assert.equal(record.account?.email, 'synthetic-1@example.invalid');
  assert.equal(record.rate_limits?.primary?.used_percent, 10, 'limits of an unconfirmed account replaced the held ones');
  assert.equal(record.rate_limits_observed_at, '2026-09-27T01:00:00.000Z');
  assert.deepEqual(record.error?.reads.map((e) => e.code), ['ACCOUNT_READ_REJECTED', 'RATE_LIMITS_READ_UNCONFIRMED']);
});

test('a sparse update that arrives while a read is out is not overwritten by that read', async (t) => {
  const b = box(t, 'account-order');
  let release: (read: AccountRead) => void = () => {};
  let asked = 0;
  const harness = scripted(() => { asked += 1; return new Promise<AccountRead>((resolve) => { release = resolve; }); });
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 5000, now: () => Date.parse('2026-09-27T06:00:00.000Z') });
  recorder.attach(harness.session);
  recorder.request('connect');
  while (asked === 0) await new Promise((resolve) => setImmediate(resolve));
  recorder.accept({ kind: 'account.rate_limits', params: { rateLimits: { primary: { usedPercent: 90 } } } });
  release(okRead(1));
  await recorder.settled();
  const record = readRecord(b.recordFile);
  assert.equal(record.rate_limits?.primary?.used_percent, 90, 'the older read overwrote the newer update');
  assert.equal(record.rate_limits?.primary?.window_minutes, 300, 'the read did not fill what the update lacked');
  assert.equal(record.rate_limits_observed_at, '2026-09-27T01:00:00.000Z');
  assert.equal(record.rate_limits_updated_at, '2026-09-27T06:00:00.000Z');
});

test('every account/updated asks for a fresh read, and only a read that succeeds clears the account', async (t) => {
  const b = box(t, 'account-updated');
  const reads: AccountRead[] = [
    okRead(1),
    okRead(2, { account: null, requires_openai_auth: null, rate_limits: null, error: [ACCOUNT_REJECTED, LIMITS_REJECTED] }),
    okRead(3, { account: null, requires_openai_auth: true, rate_limits: null, error: [LIMITS_REJECTED] })
  ];
  let asked = 0;
  const harness = scripted(async () => { asked += 1; return reads.shift()!; });
  const recorder = new ProviderAccountRecorder({ storeDir: b.storeDir, codexHome: b.codexHome, harness, timeoutMs: 1000 });
  recorder.attach(harness.session);
  recorder.request('connect');
  await recorder.settled();

  // A nullable update and no turn after it: the read it asks for fails, so the
  // account and limits held stand.
  recorder.accept({ kind: 'account.updated', params: { authMode: null, planType: null } });
  await recorder.settled();
  assert.equal(asked, 2, 'account/updated asked for no read');
  const kept = readRecord(b.recordFile);
  assert.equal(kept.account?.email, 'synthetic-1@example.invalid');
  assert.equal(kept.rate_limits?.primary?.used_percent, 10);

  // The next one's read succeeds and says there is no account: both go.
  recorder.accept({ kind: 'account.updated', params: { authMode: null, planType: null } });
  await recorder.settled();
  assert.equal(asked, 3);
  const gone = readRecord(b.recordFile);
  assert.equal(gone.account, null);
  assert.equal(gone.account_observed_at, '2026-09-27T03:00:00.000Z');
  assert.equal(gone.rate_limits, null);
  assert.equal(gone.rate_limits_observed_at, null);
});

test('a slow disk is not on a turn\'s path: the event callback returns at once and the turn completes while the write waits', async (t) => {
  // Every fsync the queued writer asks of the thread pool takes a second here.
  const probe = path.join(tmp(t, 'account-probe'), 'probe');
  fs.writeFileSync(probe, '');
  const handle = await fs.promises.open(probe, 'r');
  const proto = Object.getPrototypeOf(handle) as { sync(): Promise<void> };
  await handle.close();
  const sync = proto.sync;
  proto.sync = async function (this: unknown) { await new Promise((resolve) => setTimeout(resolve, 1000)); return sync.call(this); };
  t.after(() => { proto.sync = sync; });

  let onEvent: ((event: { kind?: unknown; params?: unknown }) => unknown) | null = null;
  let callbackMs = -1;
  let landedBeforeTurnEnded = true;
  let recordFile = '';
  // The reads after the first answer the account and fail the limits, so the
  // update the turn carries is what the record keeps.
  let n = 0;
  const harness = scripted(async () => (n++ === 0 ? okRead(1) : okRead(1, { rate_limits: null, error: [LIMITS_REJECTED] })), async () => {
    const started = performance.now();
    onEvent!({ kind: 'account.rate_limits', params: { rateLimits: { primary: { usedPercent: 91 } } } });
    callbackMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    landedBeforeTurnEnded = fs.existsSync(recordFile) && readRecord(recordFile).rate_limits?.primary?.used_percent === 91;
    return 'completed';
  });
  // The fake's connect ignores its options; this one keeps the runtime's event
  // callback, so the turn can deliver a notification through it.
  const connect = harness.connect;
  (harness as { connect: unknown }).connect = async (options: { onEvent?: (event: { kind?: unknown; params?: unknown }) => unknown }) => { onEvent = options.onEvent ?? null; return connect(); };
  const result = runWith(t, harness, (file) => { recordFile = file; });
  const held = await result;
  assert.equal(held.code, EXIT.OK);
  assert.ok(callbackMs >= 0 && callbackMs < 50, `the event callback took ${callbackMs} ms`);
  assert.equal(landedBeforeTurnEnded, false, 'the update was written before the turn ended; the write was on its path');
  const thread = JSON.parse(fs.readFileSync(path.join(held.storeDir, 'threads', fs.readdirSync(path.join(held.storeDir, 'threads'))[0]), 'utf8'));
  assert.ok(thread.completed_turns >= 1, 'the turn did not complete while the write was held');
  // And the queued write does land, whole, by rename.
  await eventually(held.recordFile, (record) => record.rate_limits?.primary?.used_percent === 91, 10_000);
  assert.deepEqual(fs.readdirSync(held.storeDir).filter((name) => name.startsWith('.temp-')), []);
});

// ---- the after-turn hook -----------------------------------------------------

function loopWith(t: After, afterTurn: () => void) {
  const dir = tmp(t, 'account-after-turn');
  const decl = declaration();
  const store = Store.open(dir);
  const harness = fakeHarness();
  const lines: Record<string, unknown>[] = [];
  const loop = new ReleaseLoop({
    // resolveChannel returns the fixture channel used by this loop; the loop reads that channel shape.
    declaration: decl, channel: resolveChannel(decl, decl.channels![0]) as Channel, store, storeDir: dir,
    adapter: fixture, harness, session: harness.session, agent: 'test-agent',
    checkout: path.join(dir, 'repo'), work: dir, log: (line) => lines.push(line), afterTurn
  });
  return { loop, lines };
}

test('the after-turn hook rethrows a fault that ends the process and logs anything else', async (t) => {
  const terminal = new RuntimeFault(fault('HARNESS_CHILD_EXITED_MID_TURN', 'synthetic', 'a synthetic terminal fault', 'none'));
  const ending = loopWith(t, () => { throw terminal; });
  await assert.rejects(() => ending.loop.takeTurn({ unitId: 'u1', threadId: 'thread-1', releaseId: 'r1', input: 'hello', clientUserMessageId: 'm1' }),
    (error: unknown) => error === terminal);

  const ordinary = loopWith(t, () => { throw new RuntimeFault(fault('SOMETHING_ORDINARY', 'synthetic', 'an ordinary fault', 'none')); });
  const taken = await ordinary.loop.takeTurn({ unitId: 'u1', threadId: 'thread-1', releaseId: 'r1', input: 'hello', clientUserMessageId: 'm1' });
  assert.equal(taken.result.status, 'completed');
  assert.ok(ordinary.lines.some((l) => l.event === 'after_turn.failed'), 'the ordinary fault was not logged');
});
