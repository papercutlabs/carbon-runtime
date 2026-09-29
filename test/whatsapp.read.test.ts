// `carbon-whatsapp read`: one chat's messages, collected for a wait on a device
// somebody already paired, and a connection closed properly afterwards.
//
// Everything runs against the adapter's recorded fixtures and a fake socket.
// Nothing here opens a connection and the library is not loaded: the command
// line cases stop at argument checks, before the library would be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatJid, collect, describe, inChat, readChat } from '../adapters/whatsapp/read.ts';
import type { ReadSocket } from '../adapters/whatsapp/read.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'adapters', 'whatsapp', 'fixtures');
const PHONE = '15550001111';
const LID = '189234567890123@lid';

// The fixtures are the release loop's items; the read sees their raw events.
function events(name: string): unknown[] {
  return (JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as { event: unknown }[]).map((item) => item.event);
}

// A socket that records what the read does to it, in order, and lets the test
// say what the server does.
function fakeSocket() {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const socket: ReadSocket = {
    ev: { on: (event: string, handler: (update: { messages: unknown[] }) => void) => emitter.on(event, handler) } as ReadSocket['ev'],
    end: () => { calls.push('end'); }
  };
  return { socket, calls, emit: (event: string, value: unknown) => emitter.emit(event, value) };
}

// A sleep the test releases by hand, so the order of wait, settle and end is seen.
function manualSleep() {
  const pending: { ms: number; done: () => void }[] = [];
  return {
    pending,
    sleep: (ms: number) => new Promise<void>((done) => { pending.push({ ms, done }); }),
    async release() { const next = pending.shift()!; next.done(); await new Promise((tick) => setImmediate(tick)); return next.ms; }
  };
}

test('a chat is a number in international form or a jid, and nothing else', () => {
  assert.equal(chatJid(PHONE), `${PHONE}@s.whatsapp.net`);
  assert.equal(chatJid(`${PHONE}:12@s.whatsapp.net`), `${PHONE}@s.whatsapp.net`);
  assert.equal(chatJid(LID), LID);
  assert.equal(chatJid('120363000000000001@g.us'), '120363000000000001@g.us');
  assert.equal(chatJid('+1 555 000 1111'), null);
  assert.equal(chatJid('someone@example.com'), null);
});

test('the chat matches under either form the linked-id rollout gives it', () => {
  const [first] = events('inbound.json');
  assert.equal(inChat(first, `${PHONE}@s.whatsapp.net`), true);
  assert.equal(inChat(first, LID), true);
  assert.equal(inChat(first, '15559999999@s.whatsapp.net'), false);
});

test('messages are read through the adapter\'s content rules: text, one photograph not two, an edit, a group sender', () => {
  const inbound = collect(events('inbound.json'), `${PHONE}@s.whatsapp.net`);
  assert.deepEqual(inbound.map((row) => [row.id, row.kind, row.text]), [
    ['3EB0A0000001', 'text', 'The invoice for August has two lines we do not recognise.'],
    ['3EB0A0000002', 'text', 'Lines 14 and 15, to be exact.']
  ]);
  assert.equal(inbound[0].sender, LID);
  assert.equal(inbound[0].sender_name, 'Ada');
  assert.equal(inbound[0].at, '2026-09-10T10:00:00.000Z', 'the server stamp, not the moment it was read');

  const hd = collect(events('hd.json'), LID);
  assert.equal(hd.filter((row) => row.kind === 'image').length, hd.length, 'every kept message is the picture');
  assert.ok(hd.length < events('hd.json').length, 'the higher-definition second upload was kept as its own message');
  assert.deepEqual(hd[0].media, { mime: 'image/jpeg', bytes: 90000, file_name: null });
  assert.equal(hd[0].text, 'The damaged corner.');

  const [edit] = collect(events('edit.json'), LID);
  assert.deepEqual([edit.kind, edit.edit_of, edit.text], ['edit', '3EB0A0000001', 'The invoice for August has three lines we do not recognise.']);

  const [group] = collect(events('group.json'), '120363000000000001@g.us');
  assert.equal(group.sender, '198765432109876@lid');
});

test('an event with no id is not described, and the same event twice is one message', () => {
  assert.equal(describe({ key: { remoteJid: `${PHONE}@s.whatsapp.net` }, message: { conversation: 'x' } }), null);
  const twice = [...events('inbound.json'), ...events('inbound.json')];
  assert.equal(collect(twice, LID).length, 2);
});

test('read holds the connection open for the wait and the settle, then ends it, and keeps what arrived from the first event', async () => {
  const { socket, calls, emit } = fakeSocket();
  const clock = manualSleep();
  const outcome = readChat({ socket, jid: LID, waitMs: 30_000, settleMs: 3000, sleep: clock.sleep });
  const [first, second] = events('inbound.json');
  emit('messages.upsert', { messages: [first] });
  emit('connection.update', { connection: 'open' });
  emit('messages.upsert', { messages: [second, ...events('group.json')] });
  assert.deepEqual(calls, [], 'the socket was ended before the wait');
  assert.equal(await clock.release(), 30_000);
  assert.deepEqual(calls, [], 'the socket was ended with no settle after the wait');
  assert.equal(await clock.release(), 3000);
  assert.deepEqual(calls, ['end']);
  const result = await outcome;
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.messages.map((row) => row.id), ['3EB0A0000001', '3EB0A0000002']);
});

test('a 401 is the device gone: its own outcome with the server\'s code, and the socket is not ended again', async () => {
  const { socket, calls, emit } = fakeSocket();
  const outcome = readChat({ socket, jid: LID, waitMs: 1000, settleMs: 1000, sleep: manualSleep().sleep });
  emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  const result = await outcome;
  assert.deepEqual(result.ok ? null : [result.code, 'status' in result ? result.status : null], ['DEVICE_UNLINKED', 401]);
  assert.deepEqual(calls, []);
});

test('an ordinary close is a closed connection, not an unlinked device', async () => {
  const { socket, emit } = fakeSocket();
  const clock = manualSleep();
  const outcome = readChat({ socket, jid: LID, waitMs: 1000, settleMs: 1000, sleep: clock.sleep });
  emit('connection.update', { connection: 'open' });
  emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'Connection Closed', output: { statusCode: 428 } } } });
  const result = await outcome;
  assert.deepEqual(result.ok ? null : [result.code, result.reason], ['READ_CONNECTION_CLOSED', 'Connection Closed']);
});

test('carbon-whatsapp read refuses bad arguments and an unpaired directory before loading the library', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-read-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'carbon-whatsapp'), 'read', ...args], { encoding: 'utf8' });
  const refused = run('--auth-dir', empty, '--chat', '+1 555', '--wait', '0');
  assert.equal(refused.status, 1);
  const codes = refused.stdout.trim().split('\n').map((line) => (JSON.parse(line) as { code: string }).code);
  assert.deepEqual(codes.sort(), ['CHAT_NOT_RECOGNISED', 'NOT_PAIRED', 'WAIT_OUT_OF_RANGE']);
  const missing = run('--chat', PHONE);
  assert.deepEqual(missing.stdout.trim().split('\n').map((line) => (JSON.parse(line) as { subject: string }).subject).sort(), ['--auth-dir', '--wait']);

  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'carbon-whatsapp'), 'read', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--wait <seconds>/);
  assert.match(help.stdout, /DEVICE_UNLINKED/);
});
