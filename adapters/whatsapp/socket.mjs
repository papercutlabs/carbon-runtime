// The connection. This is the only file in this adapter that loads the library,
// and it is deliberately thin: it opens a socket, turns what arrives into the
// items index.mjs already knows how to read, keeps the channel's connection
// state on disk, and stops the unit when the device is unlinked.
//
// Nothing here decides what a message means. Every rule about records, keys,
// holds, albums and splitting is in index.mjs, where it can be tested against
// recorded events with no network.

import { createRequire } from 'node:module';
import { writeConnectionState } from './channel-state.mjs';
import { EXIT_TERMINAL_AUTH, latchFaults, terminalReason, writeLatch } from './latch.mjs';
import { isPaired, makeTransactionalAuthState } from './auth-state.mjs';
import { read } from './content.mjs';
import { report } from '../../stream/faults.mjs';

const LIBRARY = '@whiskeysockets/baileys';

// The library is loaded when a connection is actually wanted, so every other
// file here — and every test — runs without it installed.
export async function library() {
  const loaded = await import(LIBRARY);
  const makeWASocket = loaded.makeWASocket ?? loaded.default?.makeWASocket ?? loaded.default;
  return { ...loaded, makeWASocket };
}

export function pinnedVersion() {
  const require = createRequire(import.meta.url);
  return require(`${LIBRARY}/package.json`).version;
}

export async function authState(dir) {
  const { initAuthCreds, BufferJSON, proto } = await library();
  return makeTransactionalAuthState(dir, { initAuthCreds, BufferJSON, proto });
}

// The position the store orders and the cursors compare, and it has to survive a
// restart. A per-process counter does not: the first proof of this channel
// restarted the runtime and every message that arrived afterwards was numbered 1
// again, sat below the cursor the previous run had left, and was polled forever
// and never captured. So the position is the server's own timestamp for the
// event, which is the channel's ordering and is the same number after a restart,
// with a counter after it to separate two events in one second.
export function position(ordinal, at = Date.now()) {
  const seconds = Math.floor(Number(at) || 0);
  return `${String(seconds).padStart(12, '0')}-${String(ordinal).padStart(6, '0')}`;
}

// The moment the server put on the event, in seconds. The library hands it back
// as a number or as a long, and an event without one is placed at the moment it
// was read, which is the only other time this process knows about.
export function stampOf(event, now = Date.now()) {
  const stamp = event?.messageTimestamp;
  const seconds = typeof stamp === 'object' && stamp !== null
    ? Number(stamp.low ?? stamp.toNumber?.() ?? NaN)
    : Number(stamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : Math.floor(now / 1000);
}

// Open the channel.
//
// `onItems` is called with the items index.mjs reads. `stop` is called with an
// exit code when the connection reaches a state a reconnection cannot help; the
// caller is the process, and the code it exits with is what the unit is
// configured not to restart on.
export async function openChannel({
  store, account, authDir, onItems, stop = (code) => { process.exitCode = code; }
}) {
  const latched = latchFaults(store, account);
  if (latched.length > 0) {
    report(latched);
    stop(EXIT_TERMINAL_AUTH);
    return null;
  }
  if (!isPaired(authDir)) {
    report([{
      code: 'CHANNEL_NOT_PAIRED',
      subject: authDir,
      problem: 'this directory holds no paired device',
      fix: 'pair the device once with carbon-whatsapp pair, then install'
    }]);
    stop(EXIT_TERMINAL_AUTH);
    return null;
  }

  const { makeWASocket, fetchLatestBaileysVersion, downloadMediaMessage } = await library();
  const { state, saveCreds } = await authState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  writeConnectionState(store, account, 'connecting', { reason: `client version ${version.join('.')}` });

  const socket = makeWASocket({ auth: state, version });
  let ordinal = 0;

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      writeConnectionState(store, account, 'open');
      return;
    }
    if (connection === 'connecting') {
      writeConnectionState(store, account, 'connecting');
      return;
    }
    if (connection !== 'close') return;

    const terminal = terminalReason(lastDisconnect?.error);
    if (!terminal) {
      writeConnectionState(store, account, 'close', {
        reason: lastDisconnect?.error?.message ?? 'the connection closed'
      });
      return;
    }

    // The device is gone. Record why, leave the authentication directory
    // exactly as it is, and stop: a reconnection asks the same question and
    // gets the same answer, several times a second, for as long as the unit
    // keeps restarting it.
    writeLatch(store, account, { ...terminal, auth_dir: authDir });
    writeConnectionState(store, account, 'close', { reason: terminal.reason });
    stop(EXIT_TERMINAL_AUTH);
  });

  // Media is fetched here, before the batch is handed over, so the adapter's
  // own operations do no input or output and stay testable against recorded
  // events. A download that fails is not an error: the item goes on without it
  // and the record says so.
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const items = [];
    for (const event of messages) {
      const item = {
        position: position(++ordinal, stampOf(event)),
        received_at: new Date().toISOString(),
        event
      };
      if (read(event.message ?? {}).media) {
        try {
          const bytes = await downloadMediaMessage(event, 'buffer', {}, {
            reuploadRequest: socket.updateMediaMessage
          });
          if (bytes) item.attachments = [{ bytes, mime: read(event.message).media.mime }];
        } catch { /* the record will say the download failed */ }
      }
      items.push(item);
    }
    onItems(items, { socket });
  });

  return socket;
}
