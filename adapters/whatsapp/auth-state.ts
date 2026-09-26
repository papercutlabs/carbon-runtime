// The authentication state, written transactionally.
//
// Pairing produces a set of files: the device's own credentials, and a growing
// pile of signal keys the protocol needs to decrypt what arrives. The library
// ships a helper that keeps them as one file each and writes each with a plain
// write. A plain write is not one operation: a process that stops between the
// truncate and the flush leaves a file that is there, is the right length, and
// holds nothing. The library's own guidance says that helper is not for
// production, and an upstream change proposing atomic credential writes was
// closed without landing.
//
// So this adapter writes its own, from the first day rather than after the first
// incident: every file is written to a temporary name in the same directory,
// flushed, renamed over the target, and the directory flushed after the rename.
// A reader sees the old file or the new one.
//
// What this is and is not. It reduces the risk that a stop at the wrong moment
// leaves a state file half written. It does not prevent the server from
// revoking the device, and nothing written on this box can: that decision is
// made elsewhere, and the answer to it is the terminal latch, not this file.
//
// The library is not imported here. The three things this needs from it — how to
// make a fresh set of credentials, how to write a buffer into JSON and read it
// back, and how to rebuild one protocol object — are passed in, so the write
// order is testable with no library, no socket and no network in the test.

import fs from 'node:fs';
import path from 'node:path';

// These are operations supplied by the pinned provider, not a credential schema.
// JSON values and the protocol rebuild result stay unknown; either provider
// operation may reject malformed persisted data just as it did before typing.
export type AuthOperations = {
  initAuthCreds: () => unknown;
  BufferJSON: {
    replacer?: (key: string, value: unknown) => unknown;
    reviver?: (key: string, value: unknown) => unknown;
  };
  proto: { Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => unknown } } };
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let tempCounter = 0;

function fsyncDir(dir: string) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writeFileTransactionally(file: string, data: string | Uint8Array) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const temp = path.join(dir, `.temp-${process.pid}-${tempCounter++}`);
  const fd = fs.openSync(temp, 'wx', FILE_MODE);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fsyncDir(dir);
}

// A key file's name comes from an identifier the server chose, so it is not
// allowed to be a path. Every character outside the safe set becomes an
// underscore, and a name that would still be a dot segment is refused.
export function keyFileName(type: string, id: string) {
  const safe = `${type}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`${type}-${id} does not name a file`);
  }
  return `${safe}.json`;
}

// The library's own shape: `{ state: { creds, keys }, saveCreds }`.
//
// `initAuthCreds`, `BufferJSON` and `proto` are the library's; they are
// arguments so that this file loads without it.
export function makeTransactionalAuthState(dir: string, { initAuthCreds, BufferJSON, proto }: AuthOperations) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  const at = (name: string) => path.join(dir, name);

  const readData = (name: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(at(name), 'utf8'), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeData = (name: string, data: unknown) => {
    writeFileTransactionally(at(name), JSON.stringify(data, BufferJSON.replacer, 2));
  };

  // A signal key the protocol has finished with is removed. That is not a record
  // of a client's and it is not history: it is a one-time key whose whole
  // purpose was to be used once, and keeping it would make decryption wrong
  // rather than more complete.
  const removeData = (name: string) => {
    try { fs.rmSync(at(name)); } catch { /* it was already gone */ }
  };

  const creds = readData('creds.json') ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: (type: string, ids: string[]) => {
          const found: Record<string, unknown> = {};
          for (const id of ids) {
            let value = readData(keyFileName(type, id));
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== null && value !== undefined) found[id] = value;
          }
          return found;
        },
        set: (data: Record<string, Record<string, unknown>>) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const name = keyFileName(type, id);
              if (value) writeData(name, value);
              else removeData(name);
            }
          }
        }
      }
    },
    saveCreds: () => writeData('creds.json', creds)
  };
}

// Whether this directory already holds a paired device. Read without loading the
// credentials themselves: only the fact.
export function isPaired(dir: string) {
  try {
    const creds: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
    // Property access only: arbitrary parsed values are not credentials.
    return (creds as { registered?: unknown } | null)?.registered === true;
  } catch {
    return false;
  }
}
