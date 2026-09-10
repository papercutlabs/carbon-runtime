// What this adapter knows that is not a message.
//
// Three small files sit under the store, one directory per account:
//
//   channels/<account>/whatsapp.channel.json     connection state
//   channels/<account>/whatsapp.lid-map.json     phone form to linked-id form
//   channels/<account>/whatsapp.latch.json       the terminal authentication latch
//
// They are under the store because they are the agent's own operating state on
// the agent's own box, they must survive a restart, and a person reading the
// store to work out what happened needs them beside the captures. They are
// written by `writeAtomic` from the store library, so a state file is whole or
// it is not there. None of them holds a credential: the authentication material
// lives in its own directory, owned by the box owner, and nothing here reads it.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic, StreamFault } from '../../stream/store.mjs';
import { componentFaults, encodeComponent } from '../../stream/encode.mjs';

const DIR_MODE = 0o700;

export const CONNECTION_STATES = ['open', 'close', 'connecting', 'unknown'];

function accountDir(store, account) {
  const faults = componentFaults('account', account);
  if (faults.length > 0) throw new StreamFault(faults);
  const dir = store.under('channels', encodeComponent(account));
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---- connection state -------------------------------------------------------

// The connection is a stored field on the channel, not something the process
// holds in memory and loses. A check from outside the box reads this file to
// tell a channel that is connected from one that is merely running, which is
// the whole point: "the process is up" is never the answer.
export function channelFile(store, account) {
  return path.join(accountDir(store, account), 'whatsapp.channel.json');
}

export function readChannel(store, account) {
  return readJson(channelFile(store, account)) ?? {
    account,
    connection: { state: 'unknown', at: null, reason: null }
  };
}

export function writeConnectionState(store, account, state, { at = new Date().toISOString(), reason = null } = {}) {
  if (!CONNECTION_STATES.includes(state)) {
    throw new Error(`${state} is not one of ${CONNECTION_STATES.join(', ')}`);
  }
  const channel = { ...readChannel(store, account), account, connection: { state, at, reason } };
  writeAtomic(channelFile(store, account), JSON.stringify(channel, null, 2) + '\n');
  return channel;
}

// ---- the chat-key map -------------------------------------------------------

// Both directions of every phone-form to linked-id-form pair the live adapter
// has seen. It is written by the live adapter and read by one caller only, the
// history import, which needs it to put an export's phone-keyed chats onto the
// conversations the live adapter keyed by linked id. Nothing else consults it:
// the canonical key of a live message comes from that message's own event.
export function lidMapFile(store, account) {
  return path.join(accountDir(store, account), 'whatsapp.lid-map.json');
}

export function readLidMap(store, account) {
  return readJson(lidMapFile(store, account)) ?? { phone_to_lid: {}, lid_to_phone: {}, updated_at: null };
}

export function learnPairs(store, account, pairs) {
  if (pairs.length === 0) return readLidMap(store, account);
  const map = readLidMap(store, account);
  let changed = false;
  for (const { phone, lid } of pairs) {
    if (map.phone_to_lid[phone] !== lid) { map.phone_to_lid[phone] = lid; changed = true; }
    if (map.lid_to_phone[lid] !== phone) { map.lid_to_phone[lid] = phone; changed = true; }
  }
  if (!changed) return map;
  map.updated_at = new Date().toISOString();
  writeAtomic(lidMapFile(store, account), JSON.stringify(map, null, 2) + '\n');
  return map;
}

export function lidFor(store, account, phoneJid) {
  return readLidMap(store, account).phone_to_lid[phoneJid] ?? null;
}
