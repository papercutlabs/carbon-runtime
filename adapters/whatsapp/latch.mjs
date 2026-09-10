// The terminal latch.
//
// This channel has one failure that a restart cannot help: the server decides
// the linked device is no longer linked and answers `401`, which the library
// reports as logged out. The device is gone. Every reconnection from that
// moment asks the same question and gets the same answer, and a unit configured
// to restart on failure will ask it several times a second, for days, until
// somebody notices. That has happened on this programme once already.
//
// So a terminal authentication state is not a crash to recover from. It is a
// stop. The adapter writes the reason to a latch file under the store, records
// the connection as closed, leaves the authentication directory exactly as it
// found it, and exits with a code the unit is configured not to restart on:
//
//   RestartPreventExitStatus=78
//
// 78 is chosen because it is outside the range a signal or an ordinary Node
// failure produces, so it cannot be reached by accident.
//
// Two things this file does not claim. It does not prevent a revocation: only
// the server decides that, and nothing written here changes what the server
// decides. And it does not diagnose one: the evidence a revocation leaves does
// not say whether a person unlinked the device, whether the server evicted it,
// or whether something the client did provoked it. What the latch gives is the
// state preserved and the retry loop stopped, so the question can still be
// asked afterwards.
//
// The latch is cleared by the next install, which is the moment a person has
// decided what happened and re-paired. Clearing it is `clearLatch`, and an
// installer that has no other reason to load this module can delete the file the
// path `latchFile` names.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic, StreamFault } from '../../stream/store.mjs';
import { fault } from '../../stream/faults.mjs';
import { componentFaults, encodeComponent } from '../../stream/encode.mjs';

export const EXIT_TERMINAL_AUTH = 78;

const DIR_MODE = 0o700;

// The disconnect codes that mean the device is gone. Every other code — the
// connection closed, the connection was replaced, a restart was required, the
// service was unavailable — is an ordinary reconnection and is not latched.
const TERMINAL_CODES = new Map([
  [401, 'the server reports this device as removed; the pairing is gone'],
  [403, 'the server reports this account as forbidden to this device']
]);

export function latchFile(store, account) {
  const faults = componentFaults('account', account);
  if (faults.length > 0) throw new StreamFault(faults);
  const dir = store.under('channels', encodeComponent(account));
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return path.join(dir, 'whatsapp.latch.json');
}

// What the disconnect means, read from the error the library raised. Returns
// null when the disconnect is an ordinary one, and `{ code, reason }` when it is
// terminal. The shape read here is the library's: a Boom error carrying
// `output.statusCode`, with the same number also reachable as `statusCode` and,
// on some paths, as `data.reason`.
export function terminalReason(error) {
  if (!error) return null;
  const code = Number(
    error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode ?? NaN
  );
  if (!TERMINAL_CODES.has(code)) return null;
  return { code, reason: TERMINAL_CODES.get(code) };
}

// Write the latch. The authentication directory is named and never touched: the
// path is recorded so a person knows which directory holds the state that must
// be preserved, and nothing in this module opens it.
export function writeLatch(store, account, { code, reason, auth_dir = null, at = new Date().toISOString() }) {
  const latched = {
    account,
    latched_at: at,
    code,
    reason,
    auth_dir,
    what_now: 'the device is unlinked; a person decides what happened, re-pairs, and the next install clears this latch'
  };
  writeAtomic(latchFile(store, account), JSON.stringify(latched, null, 2) + '\n');
  return latched;
}

export function readLatch(store, account) {
  const file = latchFile(store, account);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Cleared by install, once a person has re-paired.
export function clearLatch(store, account) {
  const file = latchFile(store, account);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// A latched channel does not start. This is what makes the latch a stop rather
// than a note: the process refuses before it opens a socket, so a unit that has
// been restarted by hand, or by a person who did not read the latch, stops again
// with the same exit code and the same reason.
export function latchFaults(store, account) {
  const latched = readLatch(store, account);
  if (!latched) return [];
  return [fault('CHANNEL_LATCHED', account,
    `${latched.reason}, latched at ${latched.latched_at}`,
    'a person decides what happened, re-pairs the device, and the next install clears the latch')];
}
