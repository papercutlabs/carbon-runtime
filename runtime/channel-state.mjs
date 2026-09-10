// What a channel knows that is not a message.
//
// One file per account and channel kind under the store,
// `channels/<account>/<kind>.channel.json`, holding whatever the runtime and that
// channel's adapter have learned about the channel itself: whether the last poll
// worked, how many have failed in a row, whether a connection is open. It is
// under the store because it is the agent's own operating state on the agent's
// own box, it must survive a restart, and a person reading the store to work out
// why the agent went quiet needs it beside the captures.
//
// The file's name is the one adapters/whatsapp/channel-state.mjs already writes,
// and every writer here merges rather than replaces, so the runtime's poll block
// and that adapter's connection block live in one file and neither erases the
// other. That matters more than it looks: a check from outside the box asks one
// question, "what does this channel say about itself", and one file per channel
// is the answer rather than a list of files to know about.
//
// Nothing here holds a credential. Authentication material lives in its own
// directory, owned by the box owner, and nothing in this module reads it.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic, StreamFault } from '../stream/store.mjs';
import { componentFaults, encodeComponent, decodeComponent } from '../stream/encode.mjs';

const DIR_MODE = 0o700;

export function channelStateFile(store, account, kind) {
  const faults = [...componentFaults('account', account), ...componentFaults('channel kind', kind)];
  if (faults.length > 0) throw new StreamFault(faults);
  const dir = store.under('channels', encodeComponent(account));
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return path.join(dir, `${encodeComponent(kind)}.channel.json`);
}

export function readChannelState(store, account, kind) {
  try {
    return JSON.parse(fs.readFileSync(channelStateFile(store, account, kind), 'utf8'));
  } catch {
    return { account, kind, poll: null };
  }
}

// Merge at the top level only. A caller owns a block and writes the whole block,
// so a shallow merge is enough and a deep one would silently keep a field the
// caller meant to drop.
export function writeChannelState(store, account, kind, patch) {
  const state = { ...readChannelState(store, account, kind), account, kind, ...patch };
  writeAtomic(channelStateFile(store, account, kind), JSON.stringify(state, null, 2) + '\n');
  return state;
}

// Every channel state file under the store, whoever wrote it. This is what a
// check from outside the box reads, and what the runtime reads at start to know
// whether it is resuming into a channel that was already failing.
export function channelStatesUnder(store) {
  const dir = store.under('channels');
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const account of fs.readdirSync(dir).sort()) {
    const at = path.join(dir, account);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const name of fs.readdirSync(at).sort()) {
      if (!name.endsWith('.channel.json')) continue;
      let content = null;
      try { content = JSON.parse(fs.readFileSync(path.join(at, name), 'utf8')); } catch { content = null; }
      found.push({
        account: decodeComponent(account),
        kind: decodeComponent(name.slice(0, -'.channel.json'.length)),
        file: path.join(at, name),
        state: content
      });
    }
  }
  return found;
}
