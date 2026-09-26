// The terminal latch, and the authentication state under it.
//
// The failure these are about happened: the server unlinked a device, the unit
// restarted the process, the process asked again, and that went on until a
// person noticed. What is proved here is that a terminal answer stops the unit,
// that everything else does not, and that the state the next person needs is
// still on disk byte for byte afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import {
  EXIT_TERMINAL_AUTH, clearLatch, latchFaults, latchFile, readLatch, terminalReason, writeLatch
} from '../adapters/whatsapp/latch.ts';
import { readChannel, writeConnectionState } from '../adapters/whatsapp/channel-state.ts';
import {
  isPaired, keyFileName, makeTransactionalAuthState, writeFileTransactionally
} from '../adapters/whatsapp/auth-state.ts';

const ACCOUNT = '15550009999@s.whatsapp.net';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-latch-'));
  return { dir, store: Store.open(path.join(dir, 'store')) };
}

// A directory as it is, file by file: name, mode and content digest. Nothing
// this adapter does to an authentication directory may change any of it.
function fingerprint(dir: string) {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else {
        found.push([
          path.relative(dir, full),
          stat.mode & 0o777,
          crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        ].join(' '));
      }
    }
  };
  walk(dir);
  return found;
}

function pairedAuthDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-auth-'));
  writeFileTransactionally(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: ACCOUNT } }));
  writeFileTransactionally(path.join(dir, 'pre-key-1.json'), JSON.stringify({ private: 'not a real key' }));
  return dir;
}

test('the server saying the device is gone is terminal; everything else is not', () => {
  assert.deepEqual(terminalReason({ output: { statusCode: 401 } })?.code, 401);
  assert.deepEqual(terminalReason({ statusCode: 403 })?.code, 403);
  assert.equal(terminalReason({ output: { statusCode: 428 } }), null, 'a closed connection was treated as terminal');
  assert.equal(terminalReason({ output: { statusCode: 440 } }), null, 'a replaced connection was treated as terminal');
  assert.equal(terminalReason({ output: { statusCode: 515 } }), null, 'a required restart was treated as terminal');
  assert.equal(terminalReason({ output: { statusCode: 408 } }), null, 'a timeout was treated as terminal');
  assert.equal(terminalReason(undefined), null);
});

test('a terminal disconnect writes the reason and leaves the authentication directory alone', () => {
  const { store } = scratch();
  const authDir = pairedAuthDir();
  const before = fingerprint(authDir);

  // The preceding terminal-code test establishes this fixture's non-null result.
  const terminal = terminalReason({ output: { statusCode: 401 } })!;
  writeLatch(store, ACCOUNT, { ...terminal, auth_dir: authDir });
  writeConnectionState(store, ACCOUNT, 'close', { reason: terminal.reason });

  // This test just wrote these exact fields; readLatch makes no schema promise.
  const latched = readLatch(store, ACCOUNT) as { code: unknown; reason: string; auth_dir: unknown; latched_at: unknown };
  assert.equal(latched.code, 401);
  assert.match(latched.reason, /device/);
  assert.equal(latched.auth_dir, authDir);
  assert.ok(latched.latched_at);

  assert.deepEqual(fingerprint(authDir), before, 'the latch changed the authentication directory');
  assert.equal(isPaired(authDir), true, 'the latch unpaired the device');
  assert.equal(// The default and the write above establish this synthetic channel shape.
    (readChannel(store, ACCOUNT) as { connection: { state: unknown } }).connection.state, 'close');
});

test('a latched channel refuses to start, and the exit code is the one the unit does not restart on', () => {
  const { store } = scratch();
  assert.deepEqual(latchFaults(store, ACCOUNT), []);
  writeLatch(store, ACCOUNT, { code: 401, reason: 'the pairing is gone', auth_dir: '/somewhere' });
  const faults = latchFaults(store, ACCOUNT);
  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, 'CHANNEL_LATCHED');
  assert.equal(EXIT_TERMINAL_AUTH, 78);
});

test('the latch is a file under the store, and install clears it', () => {
  const { store } = scratch();
  writeLatch(store, ACCOUNT, { code: 401, reason: 'the pairing is gone' });
  const file = latchFile(store, ACCOUNT);
  assert.ok(fs.existsSync(file));
  assert.ok(path.resolve(file).startsWith(path.resolve(store.dir) + path.sep), 'the latch is not under the store');
  assert.equal(clearLatch(store, ACCOUNT), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(latchFaults(store, ACCOUNT), []);
  assert.equal(clearLatch(store, ACCOUNT), false);
});

test('the connection is a stored field on the channel, not something a restart forgets', () => {
  const { store } = scratch();
  assert.equal(// The default and the write above establish this synthetic channel shape.
    (readChannel(store, ACCOUNT) as { connection: { state: unknown } }).connection.state, 'unknown');
  writeConnectionState(store, ACCOUNT, 'connecting');
  writeConnectionState(store, ACCOUNT, 'open');
  // This test just wrote the connection state.
  const channel = readChannel(store, ACCOUNT) as { connection: { state: unknown }; account: unknown };
  assert.equal(channel.connection.state, 'open');
  assert.equal(channel.account, ACCOUNT);
  assert.throws(() => writeConnectionState(store, ACCOUNT, 'nearly'));
});

test('every authentication file is written whole or not at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-auth-'));
  const file = path.join(dir, 'creds.json');

  writeFileTransactionally(file, 'first');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The rename is what makes it one operation, and the proof is that the
  // replacement is a different inode arriving over the name, not a truncation
  // of the one that is there.
  const before = fs.statSync(file).ino;
  writeFileTransactionally(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.notEqual(fs.statSync(file).ino, before, 'the file was written in place rather than renamed over');

  // And nothing temporary is left behind.
  assert.deepEqual(fs.readdirSync(dir), ['creds.json']);
});

test('a key the server named cannot become a path', () => {
  assert.equal(keyFileName('pre-key', '1'), 'pre-key-1.json');
  assert.equal(keyFileName('session', '15550001111@s.whatsapp.net.0'), 'session-15550001111_s_whatsapp_net_0.json');
  assert.equal(keyFileName('session', '../../etc/passwd'), 'session-______etc_passwd.json');
  assert.doesNotMatch(keyFileName('session', 'a/b'), /\//);
});

test('the authentication state round-trips through the transactional writer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-auth-'));
  // The three things the library would supply, standing in for it, so this runs
  // with no library loaded and no socket opened.
  const library = {
    initAuthCreds: () => ({ registered: false, noiseKey: 'k' }),
    BufferJSON: { replacer: undefined, reviver: undefined },
    // The mock performs the same object spread on unknown input; it promises no schema.
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => ({ ...value as object, rebuilt: true }) } } }
  };

  // The synthetic factory above provides registered; persisted creds stay unknown.
  const first = makeTransactionalAuthState(dir, library);
  assert.equal((first.state.creds as { registered: boolean }).registered, false);
  (first.state.creds as { registered: boolean }).registered = true;
  first.saveCreds();
  first.state.keys.set({ 'pre-key': { 1: { private: 'one' }, 2: { private: 'two' } } });
  assert.deepEqual(first.state.keys.get('pre-key', ['1', '2']), { 1: { private: 'one' }, 2: { private: 'two' } });

  // A key the protocol has finished with goes; a client's records never do.
  first.state.keys.set({ 'pre-key': { 1: null } });
  assert.deepEqual(first.state.keys.get('pre-key', ['1', '2']), { 2: { private: 'two' } });

  // A second reader sees what the first wrote, because the write completed.
  // The first writer just saved registered:true in this owned directory.
  const second = makeTransactionalAuthState(dir, library);
  assert.equal((second.state.creds as { registered: boolean }).registered, true);
  assert.equal(isPaired(dir), true);

  // The protocol object the library rebuilds is rebuilt.
  first.state.keys.set({ 'app-state-sync-key': { AAAA: { keyData: 'x' } } });
  assert.equal(// This test provider adds rebuilt; the production boundary returns unknown.
    (first.state.keys.get('app-state-sync-key', ['AAAA']).AAAA as { rebuilt: unknown }).rebuilt, true);
});

// This test loads only the pinned media function's source. Its download
// operation is replaced before evaluation; it cannot reach a provider network.
test('the socket preserves media success, the pinned retry failure, reconnect buffering and terminal state', async () => {
  const { registerHooks } = await import('node:module');
  const { arrivals, forget, RETAINED } = await import('../adapters/whatsapp/live.ts');
  const { openChannel, stampOf, position } = await import('../adapters/whatsapp/socket.ts');
  const root = path.resolve(import.meta.dirname, '..');
  const source = fs.readFileSync(path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Utils/messages.js'), 'utf8');
  const start = source.indexOf('export const downloadMediaMessage =');
  const end = source.indexOf('\n/** Checks whether', start);
  assert.ok(start >= 0 && end > start, 'the pinned media function could not be located');
  const mediaFunction = source.slice(start, end).replace('export const downloadMediaMessage', 'const upstreamDownload');
  const mockSource = `
    export const control = { handlers: {}, opens: 0, mediaStatus: 0, contexts: [], lastError: null, reuploads: 0 };
    export const initAuthCreds = () => ({ registered: false });
    export const BufferJSON = {};
    export const proto = { Message: { AppStateSyncKeyData: { fromObject: value => value } } };
    export const fetchLatestBaileysVersion = async () => ({ version: [2, 3, 4] });
    export const makeWASocket = options => {
      control.opens++; control.auth = options.auth;
      control.handlers = {};
      return {
        ev: { on: (event, fn) => { (control.handlers[event] ??= []).push(fn); } },
        updateMediaMessage: async value => { control.reuploads++; return value; }
      };
    };
    export const emit = async (event, value) => {
      for (const handler of control.handlers[event] ?? []) await handler(value);
    };
    const REUPLOAD_REQUIRED_STATUS = [410, 404];
    const extractMessageContent = value => value;
    const getContentType = value => Object.keys(value)[0];
    const Boom = Error;
    const downloadContentFromMessage = async () => {
      if (control.mediaStatus) throw { status: control.mediaStatus };
      return [Buffer.from('synthetic media')];
    };
    ${mediaFunction}
    export const downloadMediaMessage = async (...args) => {
      control.contexts.push(args[3]);
      try { return await upstreamDownload(...args); }
      catch (error) { control.lastError = error.message; throw error; }
    };
  `;
  const url = `data:text/javascript,${encodeURIComponent(mockSource)}`;
  // This assertion describes the synthetic module built immediately above.
  const mock = await import(url) as {
    control: { opens: number; mediaStatus: number; contexts: object[]; lastError: string | null; reuploads: number };
    emit: (event: string, value: unknown) => Promise<void>;
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === '@whiskeysockets/baileys' ? { url, shortCircuit: true } : next(specifier, context);
  } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-socket-boundary-'));
  const untouched = path.join(dir, 'unrelated');
  fs.mkdirSync(untouched);
  fs.writeFileSync(path.join(untouched, 'sentinel'), 'unchanged');
  const before = fingerprint(untouched);
  const store = Store.open(path.join(dir, 'store'));
  const authDir = path.join(dir, 'synthetic-auth');
  writeFileTransactionally(path.join(authDir, 'creds.json'), JSON.stringify({ registered: true }));
  const running = { store, agent: 'agent-01', account: ACCOUNT, channel: { auth_dir: authDir } };
  try {
    forget();
    const items = await arrivals(running);
    assert.equal(mock.control.opens, 1);
    const event = { key: { remoteJid: ACCOUNT, id: 'one' }, messageTimestamp: 42,
      message: { imageMessage: { url: 'unused', mimetype: 17 } } };
    await mock.emit('messages.upsert', { messages: [event] });
    // These properties are asserted against our controlled byte provider.
    assert.deepEqual(items[0].attachments, [{ bytes: Buffer.from('synthetic media'), mime: 17 }]);
    assert.equal(items[0].position, position(1, 42));
    for (const status of [404, 410]) {
      mock.control.mediaStatus = status;
      await mock.emit('messages.upsert', { messages: [event] });
      assert.equal(items.at(-1)?.attachments, undefined);
      assert.match(mock.control.lastError ?? '', /info/);
      assert.equal(mock.control.reuploads, 0, 'the missing logger no longer stopped reupload');
    }
    assert.ok(mock.control.contexts.every(value => !('logger' in value)));
    mock.control.mediaStatus = 0;
    await mock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 19 } } });
    assert.deepEqual((readChannel(store, ACCOUNT) as { connection: { reason: unknown } }).connection.reason, 19);
    await arrivals(running);
    assert.equal(mock.control.opens, 2);
    assert.equal(items.length, 3, 'ordinary reconnect lost buffered arrivals');
    await mock.emit('messages.upsert', { messages: Array.from({ length: RETAINED + 2 }, (_, i) => ({
      key: { id: String(i) }, messageTimestamp: 50, message: { conversation: 'text' }
    })) });
    assert.equal(items.length, RETAINED);
    assert.equal((items[0].event as { key: { id: string } }).key.id, '2');
    const stopped: number[] = [];
    await openChannel({ store, account: 'terminal', authDir, onItems: () => {}, stop: code => { stopped.push(code); } });
    const authBefore = fingerprint(authDir);
    await mock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.deepEqual(stopped, [EXIT_TERMINAL_AUTH]);
    assert.deepEqual(fingerprint(authDir), authBefore);
    assert.equal(latchFaults(store, 'terminal')[0].code, 'CHANNEL_LATCHED');
    assert.equal(stampOf({ messageTimestamp: { low: '45' } }), 45);
    assert.throws(() => stampOf({ messageTimestamp: { toNumber: 7 } }), TypeError);
    assert.deepEqual(fingerprint(untouched), before);
  } finally {
    hooks.deregister();
    forget();
    assert.deepEqual(fingerprint(untouched), before, 'cleanup touched the unrelated resource');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persisted authentication values stay unchanged and retain the existing fallbacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-state-boundary-'));
  const operations = { initAuthCreds: () => ({ fresh: true }), BufferJSON: {},
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => value } } } };
  try {
    for (const value of [7, false, 'plain', { registered: 'yes' }]) {
      writeFileTransactionally(path.join(dir, 'creds.json'), JSON.stringify(value));
      const auth = makeTransactionalAuthState(dir, operations);
      assert.deepEqual(auth.state.creds, value);
      auth.saveCreds();
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')), value);
      assert.equal(isPaired(dir), false);
    }
    writeFileTransactionally(path.join(dir, 'creds.json'), 'null');
    assert.deepEqual(makeTransactionalAuthState(dir, operations).state.creds, { fresh: true });
    writeFileTransactionally(path.join(dir, 'creds.json'), '{broken');
    assert.deepEqual(makeTransactionalAuthState(dir, operations).state.creds, { fresh: true });
    const auth = makeTransactionalAuthState(dir, operations);
    auth.state.keys.set({ 'app-state-sync-key': { numeric: 7, zero: 0 } });
    assert.deepEqual(auth.state.keys.get('app-state-sync-key', ['numeric', 'zero']), { numeric: 7 });
    assert.equal(fs.statSync(path.join(dir, 'app-state-sync-key-numeric.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
