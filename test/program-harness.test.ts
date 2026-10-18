import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { turnInput } from '../runtime/loop.ts';
import * as program from '../harness/program/index.ts';
import * as fixture from '../adapters/fixture/index.ts';
import type { Declaration, Channel } from '../runtime/types.ts';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const HANDLER = `import fs from 'node:fs';
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
  const session = await program.connect({
    checkout, work, declaration: decl as never, binary: '/usr/bin/codex', codexHome: dir,
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
  assert.equal(spawnOf(session)?.command, process.execPath);
  assert.deepEqual(spawnOf(session)?.args, [path.join(checkout, 'handler.mjs')]);
  assert.equal(JSON.stringify(session.lastSpawn).includes('codex'), false);
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
  assert.equal(JSON.stringify(session.lastSpawn).includes('codex'), false);
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
    checkout, work, declaration: decl as never, onEvent() {}, onStderr() {}
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
