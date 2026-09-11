// Which account a history belongs to.
//
// An import writes into a store an agent is already using, and every record it
// writes is namespaced by the account the history came from. Getting that wrong
// puts a client's past into a conversation that is not theirs, so it is read
// from the store when the store answers it and asked for when it does not. It
// is never guessed.
//
// It lives here rather than in the command because more than one import needs
// it, and one rule with two homes is one rule that will be fixed in one of them.

import fs from 'node:fs';
import path from 'node:path';
import { fault } from '../stream/faults.mjs';

// The WhatsApp accounts this store already knows about, read from the channel
// state the live adapter writes. One account is an answer; none or several is a
// question for the caller, who passes --account.
function accountsIn(store) {
  const dir = store.under('channels');
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'whatsapp.channel.json');
    if (!fs.existsSync(file)) continue;
    try {
      const account = JSON.parse(fs.readFileSync(file, 'utf8')).account;
      if (typeof account === 'string' && account.length > 0) found.push(account);
    } catch {
      // A channel file nothing can read names no account.
      continue;
    }
  }
  return found;
}

export function resolveAccount(store, given) {
  if (given !== null) return { account: given, faults: [] };
  const known = accountsIn(store);
  if (known.length === 1) return { account: known[0], faults: [] };
  return {
    account: null,
    faults: [fault('ACCOUNT_UNDETERMINED', '--account',
      known.length === 0
        ? 'the store names no WhatsApp channel, so the account this history was exported from is not known here'
        : `the store names ${known.length} WhatsApp channels, so which one this history belongs to is not known here`,
      'pass --account <jid>')]
  };
}
