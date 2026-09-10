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
import { Store } from '../stream/store.mjs';
import {
  EXIT_TERMINAL_AUTH, clearLatch, latchFaults, latchFile, readLatch, terminalReason, writeLatch
} from '../adapters/whatsapp/latch.mjs';
import { readChannel, writeConnectionState } from '../adapters/whatsapp/channel-state.mjs';
import {
  isPaired, keyFileName, makeTransactionalAuthState, writeFileTransactionally
} from '../adapters/whatsapp/auth-state.mjs';

const ACCOUNT = '15550009999@s.whatsapp.net';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-latch-'));
  return { dir, store: Store.open(path.join(dir, 'store')) };
}

// A directory as it is, file by file: name, mode and content digest. Nothing
// this adapter does to an authentication directory may change any of it.
function fingerprint(dir) {
  const found = [];
  const walk = (at) => {
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

  const terminal = terminalReason({ output: { statusCode: 401 } });
  writeLatch(store, ACCOUNT, { ...terminal, auth_dir: authDir });
  writeConnectionState(store, ACCOUNT, 'close', { reason: terminal.reason });

  const latched = readLatch(store, ACCOUNT);
  assert.equal(latched.code, 401);
  assert.match(latched.reason, /device/);
  assert.equal(latched.auth_dir, authDir);
  assert.ok(latched.latched_at);

  assert.deepEqual(fingerprint(authDir), before, 'the latch changed the authentication directory');
  assert.equal(isPaired(authDir), true, 'the latch unpaired the device');
  assert.equal(readChannel(store, ACCOUNT).connection.state, 'close');
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
  assert.equal(readChannel(store, ACCOUNT).connection.state, 'unknown');
  writeConnectionState(store, ACCOUNT, 'connecting');
  writeConnectionState(store, ACCOUNT, 'open');
  const channel = readChannel(store, ACCOUNT);
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
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value) => ({ ...value, rebuilt: true }) } } }
  };

  const first = makeTransactionalAuthState(dir, library);
  assert.equal(first.state.creds.registered, false);
  first.state.creds.registered = true;
  first.saveCreds();
  first.state.keys.set({ 'pre-key': { 1: { private: 'one' }, 2: { private: 'two' } } });
  assert.deepEqual(first.state.keys.get('pre-key', ['1', '2']), { 1: { private: 'one' }, 2: { private: 'two' } });

  // A key the protocol has finished with goes; a client's records never do.
  first.state.keys.set({ 'pre-key': { 1: null } });
  assert.deepEqual(first.state.keys.get('pre-key', ['1', '2']), { 2: { private: 'two' } });

  // A second reader sees what the first wrote, because the write completed.
  const second = makeTransactionalAuthState(dir, library);
  assert.equal(second.state.creds.registered, true);
  assert.equal(isPaired(dir), true);

  // The protocol object the library rebuilds is rebuilt.
  first.state.keys.set({ 'app-state-sync-key': { AAAA: { keyData: 'x' } } });
  assert.equal(first.state.keys.get('app-state-sync-key', ['AAAA']).AAAA.rebuilt, true);
});
