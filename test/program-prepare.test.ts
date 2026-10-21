import { test, afterEach, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop, sandboxDenyBody } from '../runtime/loop.ts';
import * as program from '../harness/program/index.ts';
import * as fixture from '../adapters/fixture/index.ts';
import type { Declaration, Channel } from '../runtime/types.ts';

const probe = spawnSync('setpriv', ['--no-new-privs', 'bwrap', '--die-with-parent', '--unshare-pid', '--unshare-net',
  '--dev-bind', '/', '/', '--proc', '/proc', '/bin/true'], { timeout: 5000, encoding: 'utf8' });
const skip = probe.status === 0 ? false
  : `runner cannot start bwrap with --unshare-pid --unshare-net: ${probe.error?.message ?? probe.stderr.trim()}`;
const sessions: { stop(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.stop())); });
const sandboxTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, { skip, timeout: 40000 }, fn);

const KEY = 'tsk_synthetic_key_0123456789abcdef';
const HANDLER = `import fs from 'node:fs';
let raw = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const env = JSON.parse(raw);
  const dir = env.work + '/prepared';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
  fs.appendFileSync(new URL('./turns.jsonl', import.meta.url), JSON.stringify({ files, key: process.env.CARBON_SECRET_TYPESAFE_API_KEY ?? null,
    bodies: files.map((n) => JSON.parse(fs.readFileSync(dir + '/' + n, 'utf8'))) }) + '\\n');
  process.stdout.write(JSON.stringify({ schema: 'carbon.program-result.v1', disposition: 'reply', observations: [], timings: [],
    replies: [{ conversation_id: env.conversation_id, request_id: env.release_id, text: 'answered' }] }));
});
`;
// Behaviour is chosen by the attachment filename.
const PREPARE = `import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import child_process from 'node:child_process';
let raw = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const env = JSON.parse(raw);
  fs.appendFileSync(new URL('./prepares.jsonl', import.meta.url), JSON.stringify({ n: env.messages.length }) + '\\n');
  const first = env.messages[0].attachments[0];
  const artifact = (body, over = {}) => ({ source_message_id: env.messages[0].source_message_id, revision: env.messages[0].revision, sha256: first.sha256, body, ...over });
  const emit = (artifacts) => process.stdout.write(JSON.stringify({ schema: 'carbon.program-prepare-result.v1', artifacts }));
  const name = first.filename;
  const read = (file) => { try { return 'ok:' + fs.readFileSync(file, 'utf8'); } catch (e) { return 'err:' + e.code; } };
  if (name === 'fail.png') { process.stderr.write('boom'); process.exit(3); }
  if (name === 'hang.png') {
    const mark = '47.' + Math.floor(Math.random() * 1e9);
    child_process.spawn('sleep', [mark], { stdio: 'ignore' });
    fs.writeFileSync(new URL('./kid.pid', import.meta.url), mark);
    setTimeout(() => {}, 60000); return;
  }
  const victim = () => fs.readFileSync(new URL('./victim', import.meta.url), 'utf8');
  if (name === 'link-dir.png') {
    fs.rmSync(env.work + '/prepared', { recursive: true, force: true });
    fs.symlinkSync(victim(), env.work + '/prepared');
    emit([artifact({ lines: ['planted'] })]); return;
  }
  if (name === 'link-files.png') {
    const dir = env.work + '/prepared'; fs.mkdirSync(dir, { recursive: true });
    const final = dir + '/' + env.messages[0].source_message_id + '.r' + env.messages[0].revision + '.' + first.sha256 + '.json';
    fs.symlinkSync(victim() + '/target.json', final);
    fs.symlinkSync(victim() + '/target.json', final + '.' + process.ppid + '.tmp');
    for (let i = 1; i < 8; i += 1) fs.symlinkSync(victim() + '/target.json', final + '.' + i + '.' + '0'.repeat(16) + '.tmp');
    const old = dir + '/old.r0.' + 'a'.repeat(64) + '.json';
    fs.symlinkSync(victim() + '/old-record.json', old);
    const past = new Date(Date.now() - 2 * 3600 * 1000); fs.lutimesSync(old, past, past);
    fs.writeFileSync(dir + '/unknown.txt', 'keep'); fs.utimesSync(dir + '/unknown.txt', past, past);
    fs.mkdirSync(dir + '/sub'); fs.writeFileSync(dir + '/sub/inner.json', 'keep');
    emit([artifact({ lines: ['real'] })]); return;
  }
  if (name === 'race.png') {
    const code = "const fs=require('fs');const [w,v]=process.argv.slice(1);for(;;){try{fs.rmSync(w+'/prepared',{recursive:true,force:true});fs.symlinkSync(v,w+'/prepared')}catch{}try{fs.unlinkSync(w+'/prepared');fs.mkdirSync(w+'/prepared')}catch{}}";
    child_process.spawn(process.execPath, ['-e', code, env.work, victim(), fs.readFileSync(new URL('./flipmark', import.meta.url), 'utf8')], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 60));
    emit([artifact({ lines: ['raced'] })]); return;
  }
  if (name === 'forge.png') { emit([artifact('forged', { sha256: 'f'.repeat(64) })]); return; }
  if (name === 'huge.png') { emit([artifact('x'.repeat(300 * 1024))]); return; }
  if (name === 'probe.png') {
    const port = Number(process.env.PROBE_PORT || fs.readFileSync(new URL('./port', import.meta.url), 'utf8'));
    const connected = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false)); setTimeout(() => resolve(false), 600);
    });
    const secrets = fs.readFileSync(new URL('./secretpaths', import.meta.url), 'utf8').split('\\n');
    emit([artifact({ connected, env: Object.keys(process.env).filter((k) => k.startsWith('CARBON_SECRET')),
      attachment: read(first.path), secrets: secrets.map(read), ifaces: Object.keys(os.networkInterfaces()) })]);
    return;
  }
  emit([artifact({ lines: ['ocr:' + first.sha256.slice(0, 8)] })]);
});
`;

function declaration(): Declaration {
  return {
    schema: 'carbon.agent-declaration.v1', agent: { id: 'a', client: 'X' }, model: 'm', effort: 'low',
    sandbox: { mode: 'workspace-write', network: false }, provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [{ name: 'typesafe_api_key', path: '' }], tool_servers: [],
    channels: [{ kind: 'fixture', account: 'acc', release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000, conversations: [], default_conversation_kind: 'customer' } as Channel],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id' }, limits: { max_turn_ms: 60000 },
    harness: { kind: 'program', version: '1', entrypoint: 'handler.mjs', prepare_entrypoint: 'prepare.mjs', secret_refs: ['typesafe_api_key'] }
  } as unknown as Declaration;
}

async function started(options: { withPrepare?: boolean } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-prepare-')));
  const checkout = path.join(dir, 'checkout'); const work = path.join(dir, 'work');
  fs.mkdirSync(checkout); fs.mkdirSync(work); fs.mkdirSync(path.join(dir, 'secrets')); fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.writeFileSync(path.join(checkout, 'handler.mjs'), HANDLER);
  fs.writeFileSync(path.join(checkout, 'prepare.mjs'), PREPARE);
  const decl = declaration();
  if (options.withPrepare === false) delete (decl.harness as Record<string, unknown>).prepare_entrypoint;
  (decl.secrets as { path: string }[])[0].path = path.join(dir, 'secrets', 'typesafe_api_key');
  fs.writeFileSync(path.join(dir, 'secrets', 'typesafe_api_key'), `${KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'secrets', 'telegram-bot-token'), 'bot-token-value');
  fs.writeFileSync(path.join(dir, 'deny.toml'), sandboxDenyBody(dir));
  const session = await program.connect({
    checkout, work, declaration: decl as never, binary: '/x', codexHome: path.join(dir, 'codex-home'),
    sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir }, storeDir: path.join(dir, 'store'), onEvent() {}, onStderr() {}
  });
  sessions.push(session);
  const store = Store.open(path.join(dir, 'store'));
  const logs: Record<string, unknown>[] = [];
  const loop = new ReleaseLoop({
    declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, adapter: fixture, harness: program as never,
    session: session as never, agent: 'a', checkout, work, log: (line: Record<string, unknown>) => { logs.push(line); }
  });
  return { dir, checkout, work, store, loop, session, logs };
}

const item = (id: string, filename: string | null, bytes = Buffer.from(`bytes-${id}-${filename}`)) => ({
  conversation: 'c1', id, position: id.padStart(4, '0'), at: '2026-09-10T10:00:00.000Z', sender: 'contact-1', text: 'hi',
  ...(filename ? { attachments: [{ bytes, mime: 'image/png', filename }] } : {})
});
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (mark: string) => spawnSync('pgrep', ['-f', `sleep ${mark}`]).status === 0;
async function gone(mark: string) { for (let i = 0; i < 60; i += 1) { if (!alive(mark)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; }
// Capture and start preparing, then let the child finish: a release only consumes preparation that is already ready.
async function prime(loop: ReleaseLoop, items: ReturnType<typeof item>[]) {
  const polled = loop.capture(items);
  loop.startPrepare(polled.captured as never);
  await Promise.all(polled.captured.map((r) => loop.prepareJobs.get(r.message_id)?.done));
  return polled;
}
async function artifactsOf(loop: ReleaseLoop, work: string, filename: string, id = '1') {
  const polled = loop.capture([item(id, filename)]);
  return { polled, dir: path.join(work, 'prepared') };
}

sandboxTest('prepared artifact is bound, handed to the turn, and removed after the release', async () => {
  const { loop, checkout, work, logs } = await started();
  await prime(loop, [item('1', 'ok.png')]);
  const result = await loop.pass([]);
  assert.equal(result.released[0].reply, 'replied');
  assert.equal((logs.find((l) => l.event === 'prepare.join') as { status: string }).status, 'ready');
  const turn = lines(path.join(checkout, 'turns.jsonl'))[0];
  assert.equal(turn.files.length, 1);
  const body = turn.bodies[0];
  assert.equal(body.schema, 'carbon.program-prepared.v1');
  assert.equal(body.source_message_id, '1');
  assert.equal(body.revision, 0);
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(body.body.lines, [`ocr:${body.sha256.slice(0, 8)}`]);
  assert.equal(turn.files[0], program.preparedName('1', 0, body.sha256));
  assert.deepEqual(fs.readdirSync(path.join(work, 'prepared')), []);
  assert.equal(lines(path.join(checkout, 'prepares.jsonl')).length, 1);
});

sandboxTest('prepare runs with no network, no secret, no sibling store and only its bound attachment', async (t) => {
  const { loop, checkout, dir, store, logs } = await started();
  const server = net.createServer((s) => { hits += 1; s.destroy(); });
  let hits = 0;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(checkout, 'port'), String((server.address() as net.AddressInfo).port));
  const sibling = path.join(store.dir, 'sibling.txt');
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(sibling, 'sibling');
  fs.writeFileSync(path.join(checkout, 'secretpaths'), [path.join(dir, 'secrets', 'telegram-bot-token'), path.join(dir, 'secrets', 'typesafe_api_key'), sibling].join('\n'));
  await prime(loop, [item('1', 'probe.png', Buffer.from('attachment-bytes'))]);
  await loop.pass([]);
  const turn = lines(path.join(checkout, 'turns.jsonl'))[0];
  const seen = turn.bodies[0]?.body;
  assert.ok(turn.bodies.length, JSON.stringify(logs.filter((l) => l.event === 'prepare')));
  assert.equal(seen.connected, false);
  assert.equal(hits, 0);
  assert.deepEqual(seen.env, []);
  assert.equal(seen.attachment, 'ok:attachment-bytes');
  assert.equal(seen.secrets.every((s: string) => s.startsWith('err:')), true, JSON.stringify(seen.secrets));
  assert.equal(turn.key, KEY, 'the full turn still receives its delivered secret');
});

sandboxTest('a failing prepare does not suppress the release and leaves no artifact', async () => {
  const { loop, checkout, logs } = await started();
  await prime(loop, [item('1', 'fail.png')]);
  const result = await loop.pass([]);
  assert.equal(result.released[0].reply, 'replied');
  assert.deepEqual(lines(path.join(checkout, 'turns.jsonl'))[0].files, []);
  assert.equal((logs.find((l) => l.event === 'prepare') as { status: string }).status, 'failed');
});

sandboxTest('forged, oversized and unbound artifacts are rejected', async () => {
  for (const name of ['forge.png', 'huge.png']) {
    const { loop, checkout } = await started();
    await prime(loop, [item('1', name)]);
    const result = await loop.pass([]);
    assert.equal(result.released[0].reply, 'replied');
    assert.deepEqual(lines(path.join(checkout, 'turns.jsonl'))[0].files, [], name);
  }
});

sandboxTest('a release never waits for a running prepare: it cancels it, kills descendants and reports abandoned', async () => {
  const { loop, checkout, logs } = await started();
  const polled = loop.capture([item('1', 'hang.png')]);
  loop.startPrepare(polled.captured as never);
  for (let i = 0; i < 200 && !fs.existsSync(path.join(checkout, 'kid.pid')); i += 1) await new Promise((r) => setTimeout(r, 50));
  const mark = fs.readFileSync(path.join(checkout, 'kid.pid'), 'utf8');
  assert.equal(alive(mark), true);
  const began = Date.now();
  const result = await loop.pass([]);
  assert.equal(result.released[0].reply, 'replied');
  assert.ok(Date.now() - began < 5000, 'the release must not wait out the prepare timeout');
  assert.deepEqual(lines(path.join(checkout, 'turns.jsonl'))[0].files, []);
  const join = logs.find((l) => l.event === 'prepare.join') as { status: string; join_ms: number; jobs: { status: string; prepare_ms: number }[] };
  assert.equal(join.status, 'abandoned');
  assert.ok(join.join_ms < 900, `join took ${join.join_ms}`);
  assert.equal(join.jobs[0].status, 'abandoned');
  assert.ok(join.jobs[0].prepare_ms > 0);
  assert.equal((logs.find((l) => l.event === 'prepare') as { status: string }).status, 'cancelled');
  assert.equal(await gone(mark), true, 'descendant survived');
});

sandboxTest('harness timeout and stop each kill the prepare process group', async () => {
  const one = await started();
  const sent = [{ source_message_id: '1', revision: 0, attachments: [{ sha256: 'a'.repeat(64), path: path.join(one.dir, 'x'), filename: 'hang.png' }] }];
  const outcome = await program.prepare(one.session as never, sent, { timeoutMs: 700 });
  assert.equal(outcome.status, 'timeout');
  assert.equal(await gone(fs.readFileSync(path.join(one.checkout, 'kid.pid'), 'utf8')), true);
  fs.rmSync(path.join(one.checkout, 'kid.pid'));
  const pending = program.prepare(one.session as never, sent, { timeoutMs: 20000 });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(one.checkout, 'kid.pid')); i += 1) await new Promise((r) => setTimeout(r, 50));
  const mark = fs.readFileSync(path.join(one.checkout, 'kid.pid'), 'utf8');
  assert.equal(alive(mark), true);
  await one.session.stop();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(await gone(mark), true);
  assert.equal((await program.prepare(one.session as never, sent)).status, 'cancelled');
});

sandboxTest('prepare is started once per captured record, never awaited by capture, and one child at a time', async () => {
  const { loop, checkout, work } = await started();
  const { polled } = await artifactsOf(loop, work, 'ok.png');
  const t0 = performance.now();
  loop.startPrepare(polled.captured as never);
  assert.ok(performance.now() - t0 < 200, 'startPrepare must not wait for the child');
  assert.equal(loop.prepareActive, true);
  loop.startPrepare(polled.captured as never);
  loop.startPrepare(polled.captured as never);
  await Promise.all(polled.captured.map((r) => loop.prepareJobs.get(r.message_id)?.done));
  loop.startPrepare(polled.captured as never);
  assert.equal(await loop.joinPrepare(polled.captured.map((r) => r.message_id)).then((files) => files.length), 1);
  assert.equal(lines(path.join(checkout, 'prepares.jsonl')).length, 1);
  const other = loop.capture([item('2', 'ok.png'), item('3', 'ok.png')]);
  loop.startPrepare(other.captured as never);
  loop.startPrepare(loop.capture([item('4', 'ok.png')]).captured as never);
  await Promise.all(other.captured.map((r) => loop.prepareJobs.get(r.message_id)?.done));
  assert.equal(lines(path.join(checkout, 'prepares.jsonl')).length, 2, 'a second set during an active child is skipped');
});

sandboxTest('without a declared prepare entrypoint or attachments nothing is spawned', async () => {
  const none = await started({ withPrepare: false });
  assert.equal((await none.loop.pass([item('1', 'ok.png')])).released[0].reply, 'replied');
  assert.equal(lines(path.join(none.checkout, 'prepares.jsonl')).length, 0);
  const plain = await started();
  assert.equal((await plain.loop.pass([item('1', null)])).released[0].reply, 'replied');
  assert.equal(lines(path.join(plain.checkout, 'prepares.jsonl')).length, 0);
});

test('prepare_entrypoint must resolve inside the checkout', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-prepare-pin-')));
  fs.mkdirSync(path.join(dir, 'checkout')); fs.writeFileSync(path.join(dir, 'checkout', 'handler.mjs'), '');
  fs.mkdirSync(path.join(dir, 'work')); fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'deny.toml'), sandboxDenyBody(dir));
  for (const bad of ['../x.mjs', '/etc/x.mjs', 'missing.mjs']) {
    const decl = declaration(); (decl.harness as Record<string, unknown>).prepare_entrypoint = bad;
    await assert.rejects(program.connect({ checkout: path.join(dir, 'checkout'), work: path.join(dir, 'work'), declaration: decl as never,
      sandboxDeny: { file: path.join(dir, 'deny.toml'), root: dir }, storeDir: path.join(dir, 'store') } as never), /entrypoint|PROGRAM/i, bad);
  }
});

function tree(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name); const st = fs.lstatSync(file);
      rows.push(`${path.relative(dir, file)}|${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'}|${st.ino}|${st.mode}|${st.mtimeMs}|${st.isFile() ? fs.readFileSync(file, 'utf8') : ''}`);
      if (st.isDirectory()) walk(file);
    }
  };
  walk(dir);
  return rows.join('\n');
}
async function victimIn(one: Awaited<ReturnType<typeof started>>) {
  const victim = path.join(one.store.dir, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'target.json'), 'target-original');
  fs.writeFileSync(path.join(victim, 'old-record.json'), 'old-original');
  const past = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(path.join(victim, 'old-record.json'), past, past);
  fs.writeFileSync(path.join(one.checkout, 'victim'), victim);
  fs.writeFileSync(path.join(one.checkout, 'flipmark'), `flip.${Math.floor(Math.random() * 1e9)}`);
  return { victim, before: tree(victim) };
}
const sendOf = (one: Awaited<ReturnType<typeof started>>, filename: string, id = '1') =>
  [{ source_message_id: id, revision: 0, attachments: [{ sha256: 'b'.repeat(64), path: path.join(one.dir, 'x'), filename }] }];

sandboxTest('a child that links work/prepared or its entries cannot make the parent write or delete outside it', async () => {
  const one = await started();
  const { victim, before } = await victimIn(one);
  const prepared = path.join(one.work, 'prepared');
  fs.mkdirSync(prepared);
  const stale = path.join(prepared, `stale.r0.${'c'.repeat(64)}.json`);
  fs.writeFileSync(stale, 'stale');
  const past = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(stale, past, past);

  // entry links: the artifact still lands, as a regular file that replaced the planted link
  const linked = await program.prepare(one.session as never, sendOf(one, 'link-files.png'));
  assert.equal(linked.status, 'ready', linked.detail);
  const final = path.join(prepared, program.preparedName('1', 0, 'b'.repeat(64)));
  assert.equal(fs.lstatSync(final).isFile(), true);
  assert.match(fs.readFileSync(final, 'utf8'), /"lines":\["real"\]/);
  assert.equal(tree(victim), before, 'entry links must not reach the masked root');
  // the next prepare sweeps: our stale file goes, planted links, unknown files and a directory stay
  assert.equal((await program.prepare(one.session as never, sendOf(one, 'ok.png', '2'))).status, 'ready');
  assert.equal(fs.existsSync(stale), false, 'sweep still removes its own hour-old file');
  assert.equal(fs.lstatSync(path.join(prepared, `old.r0.${'a'.repeat(64)}.json`)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(prepared, 'unknown.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(prepared, 'sub', 'inner.json'), 'utf8'), 'keep');
  assert.equal(tree(victim), before, 'sweep must not delete through a link');
  assert.deepEqual(fs.readdirSync(victim).sort(), ['old-record.json', 'target.json']);
  program.discardPrepared(one.session as never, [final, path.join(prepared, 'unknown.txt'), path.join(prepared, `old.r0.${'a'.repeat(64)}.json`)]);
  assert.equal(fs.existsSync(final), false);
  assert.equal(fs.existsSync(path.join(prepared, 'unknown.txt')), true, 'discard removes only artifacts it names');
  assert.equal(fs.lstatSync(path.join(prepared, `old.r0.${'a'.repeat(64)}.json`)).isSymbolicLink(), true);
  assert.equal(tree(victim), before);
});

sandboxTest('a work/prepared symlink fails the prepare closed and the release falls back', async () => {
  const one = await started();
  const { victim, before } = await victimIn(one);
  const old = path.join(victim, 'old-record.json');
  await prime(one.loop, [item('1', 'link-dir.png')]);
  const result = await one.loop.pass([]);
  assert.equal(result.released[0].reply, 'replied');
  const prepare = one.logs.find((l) => l.event === 'prepare') as { status: string; detail: string };
  assert.equal(prepare.status, 'failed');
  assert.match(prepare.detail, /not a real directory/);
  assert.equal(lines(path.join(one.checkout, 'turns.jsonl'))[0].files.length, 0);
  assert.equal(fs.lstatSync(path.join(one.work, 'prepared')).isSymbolicLink(), true, 'the planted link is left alone');
  for (const name of ['ok.png', 'link-dir.png']) assert.equal((await program.prepare(one.session as never, sendOf(one, name, '9'))).status, 'failed');
  program.discardPrepared(one.session as never, [path.join(one.work, 'prepared', `1.r0.${'b'.repeat(64)}.json`)]);
  assert.equal(tree(victim), before);
  assert.equal(fs.readFileSync(old, 'utf8'), 'old-original');
});

sandboxTest('a background descendant flipping work/prepared during the parent write cannot redirect it', async () => {
  const one = await started();
  const { victim, before } = await victimIn(one);
  const mark = fs.readFileSync(path.join(one.checkout, 'flipmark'), 'utf8');
  const statuses: string[] = [];
  try {
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await program.prepare(one.session as never, sendOf(one, 'race.png', String(i)))).status);
      assert.equal(tree(victim), before, `run ${i} reached the masked root`);
    }
  } finally { spawnSync('pkill', ['-9', '-f', mark]); }
  assert.ok(statuses.every((status) => status === 'ready' || status === 'failed'), statuses.join());
});

sandboxTest('a preparer that throws synchronously never stops the release', async () => {
  const one = await started();
  one.loop.prepareSeen = { has() { throw new Error('seen exploded'); }, add() {}, clear() {}, size: 0 } as never;
  const result = await one.loop.pass([item('1', 'ok.png')]);
  assert.equal(result.released[0].reply, 'replied');
  const at = (pred: (l: Record<string, unknown>) => boolean) => one.logs.findIndex(pred);
  const failed = at((l) => l.event === 'prepare' && l.status === 'failed');
  assert.ok(failed >= 0 && /seen exploded/.test(String(one.logs[failed].detail)));
  assert.ok(at((l) => l.stage === 'capture-admission') >= 0 && at((l) => l.stage === 'capture-admission') < failed, 'preparation starts after the capture timing record');
  assert.equal(lines(path.join(one.checkout, 'turns.jsonl')).length, 1);
});

sandboxTest('without a declared prepare entrypoint the envelope is not even built', async () => {
  const one = await started({ withPrepare: false });
  one.loop.prepareSeen = { has() { throw new Error('must not be consulted'); }, add() {}, clear() {}, size: 0 } as never;
  assert.equal((await one.loop.pass([item('1', 'ok.png')])).released[0].reply, 'replied');
  assert.equal(one.logs.some((l) => l.event === 'prepare'), false);
});
