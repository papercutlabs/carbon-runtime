import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop, sandboxDenyBody } from '../runtime/loop.ts';
import { turnInput } from '../runtime/loop.ts';
import * as program from '../harness/program/index.ts';
import * as fixture from '../adapters/fixture/index.ts';
import type { Declaration, Channel } from '../runtime/types.ts';

const KEY = 'tsk_synthetic_key_0123456789abcdef';
const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const HANDLER = `import fs from 'node:fs';
import child_process from 'node:child_process';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const env = JSON.parse(raw);
  fs.appendFileSync(new URL('./seen.jsonl', import.meta.url), JSON.stringify({
    thread_id: env.thread_id, release_id: env.release_id, conversation_id: env.conversation_id,
    caption: env.messages[0]?.caption ?? '', source_message_id: env.messages[0]?.source_message_id ?? null,
    attachment: env.messages[0]?.attachments?.[0] ?? null, spawn: process.argv
  }) + '\\n');
  const caption = env.messages[0]?.caption ?? '';
  const say = (text) => process.stdout.write(JSON.stringify({
    schema: 'carbon.program-result.v1', disposition: 'reply', observations: [], timings: [],
    replies: [{ conversation_id: env.conversation_id, request_id: env.release_id, text }]
  }));
  if (caption.startsWith('probe:')) {
    const out = [];
    for (const file of caption.slice(6).split(',')) {
      try { out.push(file + '=ok:' + fs.readFileSync(file, 'utf8')); } catch (error) { out.push(file + '=err:' + error.code); }
    }
    say(out.join('|')); return;
  }
  if (caption.startsWith('readattachment:')) {
    const read = (file) => { try { return 'ok:' + fs.readFileSync(file, 'utf8'); } catch (error) { return 'err:' + error.code; } };
    say('attachment=' + read(env.messages[0].attachments[0].path) + ' sibling=' + read(caption.slice(15))); return;
  }
  const KEY = process.env.CARBON_SECRET_TYPESAFE_API_KEY;
  if (caption === 'usekey') { say('keylen:' + (KEY ? KEY.length : 'none') + ' env:' + Object.keys(process.env).sort().join(',')); return; }
  if (caption === 'leakkey') { process.stderr.write('trace token=' + KEY + ' end'); process.exit(3); }
  if (caption === 'echokey') { say('here is ' + KEY); return; }
  if (caption === 'spawnsleep' || caption === 'spawnhuge') {
    const kid = child_process.spawn('sleep', ['47'], { stdio: 'ignore' });
    fs.writeFileSync(new URL('./kid.pid', import.meta.url), String(kid.pid));
    if (caption === 'spawnhuge') { process.stdout.write('x'.repeat(${1024 * 1024 + 8})); }
    setTimeout(() => {}, 30000); return;
  }
  if (caption === 'sleep') { setTimeout(() => {}, 5000); return; }
  if (caption === 'crash') { process.stderr.write('handler-boom'); process.exit(3); }
  if (caption === 'garbage') { process.stdout.write('nope'); return; }
  if (caption === 'huge') { process.stdout.write('x'.repeat(${1024 * 1024 + 8})); return; }
  const doc = (disposition, replies, observations = []) => JSON.stringify({
    schema: 'carbon.program-result.v1', disposition, replies, observations, timings: [{ name: 'handler', ms: 1 }]
  });
  if (caption === 'no') { process.stdout.write(doc('no_reply', [])); return; }
  if (caption === 'missing') { process.stdout.write(doc('missing_case', [])); return; }
  const attachment = env.messages[0]?.attachments?.[0];
  process.stdout.write(doc('reply', [{
    conversation_id: env.conversation_id, request_id: env.release_id, text: 'answered ' + caption
  }], attachment?.path ? [{ name: 'attachment', detail: String(attachment.path).slice(0, 500) }] : []));
});
`;

function declaration(overrides: Record<string, unknown> = {}): Declaration {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    model: 'unused-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
    tool_servers: [],
    channels: [{
      kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000,
      conversations: [], default_conversation_kind: 'customer'
    } as Channel],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id' },
    limits: { max_turn_ms: 60000 },
    harness: { kind: 'program', version: '1', entrypoint: 'handler.mjs' },
    ...overrides
  } as Declaration;
}

function item(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    conversation: 'c1', id, position: id.padStart(4, '0'), at: '2026-09-10T10:00:00.000Z',
    sender: 'contact-1', text, ...extra
  };
}

async function started(overrides: Record<string, unknown> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-program-')));
  const checkout = path.join(dir, 'checkout');
  const work = path.join(dir, 'work');
  fs.mkdirSync(checkout);
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(checkout, 'handler.mjs'), HANDLER);
  const decl = declaration(overrides);
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.mkdirSync(path.join(dir, 'codex-home'));
  for (const secret of (decl.secrets ?? []) as { name: string; path: string }[]) {
    secret.path = path.join(dir, 'secrets', secret.name);
    fs.writeFileSync(secret.path, `${KEY}\n`, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(dir, 'deny.toml'), sandboxDenyBody(dir));
  const session = await program.connect({
    checkout, work, declaration: decl as never, binary: '/usr/bin/codex', codexHome: path.join(dir, 'codex-home'),
    sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir }, storeDir: path.join(dir, 'store'),
    onEvent() {}, onStderr() {}
  });
  const store = Store.open(path.join(dir, 'store'));
  const loop = new ReleaseLoop({
    declaration: decl, channel: decl.channels![0], store, storeDir: store.dir,
    adapter: fixture, harness: program as never, session: session as never,
    agent: AGENT, checkout, work
  });
  return { dir, checkout, work, store, loop, session, decl };
}

function firstParkCode(record: { adapter_fields?: Record<string, unknown> } | undefined) {
  const faults = record?.adapter_fields?.park_faults;
  return Array.isArray(faults) ? (faults[0] as { code?: string } | undefined)?.code : undefined;
}

function spawnOf(session: { lastSpawn: { command: string; args: string[] } | null }) {
  return session.lastSpawn;
}

function seen(checkout: string) {
  const file = path.join(checkout, 'seen.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('program startup spawns node on the entrypoint and never codex', async () => {
  const { loop, session, checkout } = await started();
  assert.equal(spawnOf(session), null);
  const result = await loop.pass([item('1', 'hello')]);
  assert.equal(result.released.length, 1);
  assert.equal(result.released[0].reply, 'replied');
  assert.match(spawnOf(session)?.command ?? '', /^(setpriv|bwrap)$/);
  assert.deepEqual(spawnOf(session)?.args.slice(-2), [process.execPath, path.join(checkout, 'handler.mjs')]);
  assert.equal(spawnOf(session)?.args.includes('--dev-bind'), true);
  assert.equal(JSON.stringify(session.lastSpawn).includes('/usr/bin/codex'), false);
  assert.equal(JSON.stringify(session.lastSpawn).includes('app-server'), false);
  const row = seen(checkout)[0];
  assert.equal(row.thread_id, `program:${ACCOUNT}:c1`);
  assert.equal(row.source_message_id, '1');
  assert.equal(row.caption, 'hello');
  const outbound = storeOutbound(loop);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].delivery?.status, 'sent');
  await session.stop();
});

function storeOutbound(loop: ReleaseLoop) {
  return loop.store.rebuild().filter((record) => record.direction === 'outbound');
}

test('the envelope carries the stored attachment path and digest', async () => {
  const { loop, checkout, session } = await started();
  const bytes = Buffer.from('png-bytes');
  await loop.pass([item('1', 'photo caption', {
    attachments: [{ bytes, mime: 'image/png', filename: 'page.png' }]
  })]);
  const row = seen(checkout)[0];
  assert.equal(row.attachment.sha256.length, 64);
  assert.equal(row.attachment.filename, 'page.png');
  assert.equal(fs.existsSync(row.attachment.path), true);
  assert.equal(fs.readFileSync(row.attachment.path).equals(bytes), true);
  const turns = loop.store.readThread(`${ACCOUNT}:c1`)?.turns;
  const observations = (turns as { program: { observations: { detail: string }[] } }[])[0].program.observations;
  assert.equal(observations[0].detail, row.attachment.path);
  await session.stop();
});

test('no_reply and missing_case close without a follow-up turn', async () => {
  const { loop, checkout, session } = await started();
  const silent = await loop.pass([item('1', 'no')]);
  assert.equal(silent.released[0].reply, 'no-reply-declared');
  assert.equal(seen(checkout).length, 1);
  assert.equal(storeOutbound(loop).length, 0);
  const missing = await loop.pass([item('2', 'missing')]);
  assert.equal(missing.released[0].reply, 'missing-case');
  assert.equal(seen(checkout).length, 2);
  assert.equal(storeOutbound(loop).length, 0);
  const record = loop.store.rebuild().find((one) => one.platform_message_id === '2');
  assert.equal(record?.adapter_fields?.reply_outcome, 'missing-case');
  await session.stop();
});

test('a sent reply is not sent again and an unknown send is not retried', async () => {
  let sends = 0;
  let explode = false;
  const { dir, checkout, work, store, decl } = await started();
  const session = await program.connect({
    checkout, work, declaration: decl as never, binary: '/usr/bin/codex', codexHome: dir,
    sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir }, storeDir: path.join(dir, 'store'),
    onEvent() {}, onStderr() {}
  });
  const adapter = {
    ...fixture,
    send(context: never, record: never) {
      sends += 1;
      if (explode) throw new Error('transport lost');
      return fixture.send(context, record);
    }
  };
  const loop = new ReleaseLoop({
    declaration: decl, channel: decl.channels![0], store, storeDir: store.dir,
    adapter, harness: program as never, session: session as never, agent: AGENT, checkout, work
  });
  await loop.pass([item('1', 'hello')]);
  assert.equal(sends, 1);
  await loop.pass([]);
  assert.equal(sends, 1);
  explode = true;
  await loop.pass([item('2', 'again')]);
  assert.equal(sends, 2);
  const unknown = store.rebuild().find((record) => record.direction === 'outbound' && record.body.includes('again'));
  assert.equal(unknown?.delivery?.status, 'unknown');
  await loop.pass([]);
  assert.equal(sends, 2);
  await session.stop();
});

test('the same thread id is resumed for the same unit', async () => {
  const { loop, checkout, session } = await started();
  await loop.pass([item('1', 'hello')]);
  await loop.pass([item('2', 'next')]);
  const rows = seen(checkout);
  assert.equal(rows[0].thread_id, rows[1].thread_id);
  assert.equal(rows[0].thread_id, `program:${ACCOUNT}:c1`);
  await session.stop();
});

test('a foreign thread id is refused and the release is not retried as Codex', async () => {
  const { loop, store, session, decl, checkout, work } = await started();
  await loop.pass([item('1', 'hello')]);
  store.writeThread(`${ACCOUNT}:c1`, { thread_id: 'codex-thread', completed_turns: 1, turns: [] });
  const restarted = new ReleaseLoop({
    declaration: decl, channel: decl.channels![0], store, storeDir: store.dir,
    adapter: fixture, harness: program as never, session: session as never,
    agent: AGENT, checkout, work
  });
  const spawnsBefore = JSON.stringify(session.lastSpawn);
  const again = await restarted.pass([item('2', 'next')]);
  assert.equal(again.parked.length, 1);
  const parked = store.rebuild().find((record) => record.platform_message_id === '2');
  assert.equal(parked?.disposition, 'parked');
  assert.equal(firstParkCode(parked), 'PROGRAM_THREAD_IDENTITY');
  assert.equal(JSON.stringify(session.lastSpawn), spawnsBefore);
  assert.equal(JSON.stringify(session.lastSpawn).includes('/usr/bin/codex'), false);
  await session.stop();
});

test('missing, escaping, and symlink entrypoints are refused before any spawn', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-program-pin-')));
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(path.join(checkout, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'nested', 'handler.mjs'), HANDLER);
  const decl = declaration();
  await assert.rejects(() => program.connect({
    checkout, work: dir, declaration: { ...decl, harness: { kind: 'program', version: '1', entrypoint: 'missing.mjs' } } as never,
    onEvent() {}, onStderr() {}
  }), (error: { fault?: { code?: string } }) => error.fault?.code === 'PROGRAM_ENTRYPOINT_MISSING');
  await assert.rejects(() => program.connect({
    checkout, work: dir, declaration: { ...decl, harness: { kind: 'program', version: '1', entrypoint: '../handler.mjs' } } as never,
    onEvent() {}, onStderr() {}
  }), (error: { fault?: { code?: string } }) => error.fault?.code === 'PROGRAM_ENTRYPOINT_REFUSED');
  fs.symlinkSync(path.join(checkout, 'nested', 'handler.mjs'), path.join(checkout, 'link.mjs'));
  await assert.rejects(() => program.connect({
    checkout, work: dir, declaration: { ...decl, harness: { kind: 'program', version: '1', entrypoint: 'link.mjs' } } as never,
    onEvent() {}, onStderr() {}
  }), (error: { fault?: { code?: string } }) => error.fault?.code === 'PROGRAM_ENTRYPOINT_SYMLINK');
});

test('timeout, oversized stdout, nonzero exit, and invalid JSON park and do not spawn codex', async () => {
  const cases = [
    ['sleep', 'PROGRAM_TURN_TIMED_OUT', { limits: { max_turn_ms: 1000 } }],
    ['huge', 'PROGRAM_OUTPUT_TOO_LARGE', {}],
    ['crash', 'PROGRAM_HANDLER_EXITED', {}],
    ['garbage', 'PROGRAM_RESPONSE_INVALID', {}]
  ] as const;
  for (const [caption, code, overrides] of cases) {
    const { loop, session } = await started(overrides);
    const result = await loop.pass([item('1', caption)]);
    assert.equal(result.parked.length, 1, caption);
    const parked = loop.store.rebuild().find((record) => record.direction === 'inbound');
    assert.equal(firstParkCode(parked), code, caption);
    assert.equal(parked?.release?.completed_at == null, false, caption);
    assert.equal(JSON.stringify(session.lastSpawn).includes('app-server'), false);
    await session.stop();
  }
});

test('records-enabled reply without about_job is refused by the existing gate and not sent', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ kind: 'other' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const { dir, checkout, work, decl } = await started({ records: { enabled: true } });
  const session = await program.connect({
    checkout, work, declaration: decl as never, onEvent() {}, onStderr() {},
    sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir }, storeDir: path.join(dir, 'store-records')
  });
  const store = Store.open(path.join(dir, 'store-records'));
  const loop = new ReleaseLoop({
    declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, adapter: fixture,
    harness: program as never, session: session as never, agent: AGENT, checkout, work,
    recordsActionUrl: `http://127.0.0.1:${port}`
  });
  const result = await loop.pass([item('1', 'hello')]);
  assert.equal(result.released[0].reply, 'parked-gate');
  const inbound = store.rebuild().find((record) => record.direction === 'inbound');
  assert.equal(firstParkCode(inbound), 'JOB_ACTION_CONTEXT_REQUIRED');
  assert.equal(store.rebuild().some((record) => record.direction === 'outbound'), false);
  await session.stop();
  await new Promise((resolve) => server.close(resolve));
});

test('a rendered Codex turn input is unchanged by the program envelope path', () => {
  const text = turnInput({
    conversation_id: 'account-1:c1', message_id: 'account-1:c1:1', sender_id: 'contact-1',
    received_at: '2026-09-10T10:00:00.000Z', body: 'hello'
  }, 'release-account-1:c1:1-0');
  assert.equal(text.includes('request_id: release-account-1:c1:1-0'), true);
  assert.equal(text.includes('hello'), true);
  assert.equal(text.includes('carbon.program-release.v1'), false);
  assert.equal(typeof text, 'string');
});

const CANARY = 'CANARY-SECRET-FILE-7f3a91';
const KEY_HARNESS = { kind: 'program', version: '1', entrypoint: 'handler.mjs', secret_refs: ['typesafe_api_key'] };

function startedWithKey() {
  return started({ secrets: [{ name: 'typesafe_api_key', path: '' }], harness: KEY_HARNESS });
}

function outboundText(loop: ReleaseLoop) {
  return String((storeOutbound(loop)[0] as unknown as { body?: string }).body ?? '');
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid: number) {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('the sandboxed child cannot read secrets, codex-home or the store, and sees only release attachments', async () => {
  const { dir, loop, session } = await started();
  fs.writeFileSync(path.join(dir, 'secrets', 'telegram-bot-token'), CANARY, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'codex-home', 'auth.json'), CANARY);
  fs.writeFileSync(path.join(dir, 'store', 'other-conversation.json'), CANARY);
  const targets = [path.join(dir, 'secrets', 'telegram-bot-token'), path.join(dir, 'codex-home', 'auth.json'),
    path.join(dir, 'store', 'other-conversation.json')];
  await loop.pass([item('1', `probe:${targets.join(',')}`, {
    attachments: [{ bytes: Buffer.from('page-bytes'), mime: 'image/png', filename: 'page.png' }]
  })]);
  const text = outboundText(loop);
  assert.equal(text.includes(CANARY), false);
  assert.equal((text.match(/=err:/g) ?? []).length, 3, text);
  await loop.pass([item('2', `readattachment:${targets[2]}`, {
    attachments: [{ bytes: Buffer.from('page-bytes'), mime: 'image/png', filename: 'page.png' }]
  })]);
  const reads = storeOutbound(loop).map((record) => String((record as unknown as { body?: string }).body)).join('\n');
  assert.match(reads, /attachment=ok:page-bytes sibling=err:/);
  await session.stop();
});

test('only attachment files of this release are bound back through the hidden store', async () => {
  const { dir, loop, session, checkout } = await started();
  await loop.pass([item('1', 'photo', { attachments: [{ bytes: Buffer.from('page-bytes'), mime: 'image/png', filename: 'page.png' }] })]);
  const attachmentPath = seen(checkout)[0].attachment.path as string;
  const sibling = path.join(dir, 'store', 'sibling.bin');
  fs.writeFileSync(sibling, 'sibling');
  const envelope = { messages: [{ attachments: [{ path: attachmentPath }] }] };
  const argv = program.sandboxedSpawn((session as unknown as { sandbox: never }).sandbox, 'node', ['x'], envelope).args;
  assert.equal(argv.filter((arg) => arg === attachmentPath).length, 2);
  assert.equal(argv.includes(sibling), false);
  await session.stop();
});

test('a delivered key reaches the child environment only and appears nowhere else', async () => {
  const { dir, loop, session, checkout } = await startedWithKey();
  await loop.pass([item('1', 'usekey')]);
  const said = outboundText(loop);
  assert.match(said, new RegExp(`keylen:${KEY.length} `));
  assert.match(said, /CARBON_SECRET_TYPESAFE_API_KEY/);
  assert.equal(said.includes(KEY), false);
  assert.equal(JSON.stringify(session.lastSpawn).includes(KEY), false);
  const row = seen(checkout)[0];
  assert.equal(JSON.stringify(row).includes(KEY), false);
  await loop.pass([item('2', 'probe:' + path.join(dir, 'secrets', 'typesafe_api_key'))]);
  assert.match(storeOutbound(loop).map((r) => (r as unknown as { body?: string }).body).join('\n'), /typesafe_api_key=err:/);
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  for (const file of files) {
    const full = path.join(file.parentPath, file.name);
    if (full.endsWith(path.join('secrets', 'typesafe_api_key'))) continue;
    assert.equal(fs.readFileSync(full, 'utf8').includes(KEY), false, full);
  }
  await session.stop();
});

test('a stderr trace carrying the key is redacted from the parked fault and a stdout echo is refused', async () => {
  const { dir, loop, session } = await startedWithKey();
  await loop.pass([item('1', 'leakkey')]);
  await loop.pass([item('2', 'echokey')]);
  const records = loop.store.rebuild();
  const codes = records.filter((r) => r.direction === 'inbound').map(firstParkCode);
  assert.deepEqual(codes, ['PROGRAM_HANDLER_EXITED', 'PROGRAM_RESPONSE_INVALID']);
  for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
    const full = path.join(file.parentPath, file.name);
    if (full.endsWith(path.join('secrets', 'typesafe_api_key'))) continue;
    assert.equal(fs.readFileSync(full, 'utf8').includes(KEY), false, full);
  }
  assert.equal(JSON.stringify(records).includes('[redacted]'), true);
  await session.stop();
});

test('redactSecrets removes raw and JSON-escaped values', () => {
  assert.equal(program.redactSecrets('a K"1 b K"1', ['K"1']), 'a [redacted] b [redacted]');
  assert.equal(program.redactSecrets('{"x":"K\\"1"}', ['K"1']), '{"x":"[redacted]"}');
});

test('no sandbox gate, no bwrap, or an unreadable deny file refuse to connect', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-program-nosb-')));
  const checkout = path.join(dir, 'checkout');
  const work = path.join(dir, 'work');
  fs.mkdirSync(checkout);
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(checkout, 'handler.mjs'), HANDLER);
  const base = { checkout, work, declaration: declaration() as never, onEvent() {}, onStderr() {} };
  const refuses = async (options: Record<string, unknown>) => {
    await assert.rejects(program.connect({ ...base, ...options } as never),
      (error: { fault?: { code?: string } }) => error.fault?.code === 'PROGRAM_SANDBOX_UNAVAILABLE');
  };
  await refuses({});
  await refuses({ sandboxDeny: { file: path.join(dir, 'absent.toml'), root: dir } });
  fs.writeFileSync(path.join(dir, 'deny.toml'), sandboxDenyBody(dir));
  const oldPath = process.env.PATH;
  process.env.PATH = path.join(dir, 'nowhere');
  try {
    await refuses({ sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir } });
  } finally {
    process.env.PATH = oldPath;
  }
  await refuses({ sandboxDeny: { file: path.join(dir, 'deny.toml'), root: path.dirname(work) }, work: path.join(dir, 'store', 'w'), storeDir: path.join(dir, 'store') });
});

test('an undeclared or missing key file parks the turn without a spawn', async () => {
  const { loop, session } = await started({ harness: { kind: 'program', version: '1', entrypoint: 'handler.mjs', secret_refs: ['typesafe_api_key'] } });
  const result = await loop.pass([item('1', 'usekey')]);
  assert.equal(result.parked.length, 1);
  assert.equal(firstParkCode(loop.store.rebuild().find((r) => r.direction === 'inbound')), 'PROGRAM_SECRET_REFUSED');
  assert.equal(session.lastSpawn, null);
  await session.stop();
});

test('a timeout, an overflow and stop kill the handler process group', async () => {
  for (const [caption, overrides, code] of [
    ['spawnsleep', { limits: { max_turn_ms: 1000 } }, 'PROGRAM_TURN_TIMED_OUT'],
    ['spawnhuge', {}, 'PROGRAM_OUTPUT_TOO_LARGE']
  ] as const) {
    const { loop, session, checkout } = await started(overrides);
    await loop.pass([item('1', caption)]);
    assert.equal(firstParkCode(loop.store.rebuild().find((r) => r.direction === 'inbound')), code);
    const pid = Number(fs.readFileSync(path.join(checkout, 'kid.pid'), 'utf8'));
    assert.equal(await gone(pid), true, `${caption} child ${pid} survived`);
    await session.stop();
  }
  const { loop, session, checkout } = await started();
  const pass = loop.pass([item('1', 'spawnsleep')]);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(checkout, 'kid.pid')); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(path.join(checkout, 'kid.pid'), 'utf8'));
  assert.equal(alive(pid), true);
  await session.stop();
  assert.equal(await gone(pid), true);
  await pass.catch(() => {});
});
