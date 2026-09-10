// The live connection, as the release loop sees it.
//
// index.mjs holds every rule and no connection; socket.mjs holds the connection
// and no rule. Between them there was nothing, so an installed agent with a
// whatsapp channel opened no socket, was handed no items and answered nothing,
// however well both halves worked on their own. This file is that missing
// middle, and it is deliberately thin: one connection per account, a buffer of
// what arrived on it, and a reconnection that is nothing more than opening again
// on the next poll.
//
// The buffer is what makes `poll` honest. WhatsApp pushes; the loop asks. So
// what arrives between two passes is held here and handed over on the next one,
// and it is not dropped when it is handed over: an album is held back by
// `listPending` until its quiet window has passed, so an item may be pending on
// one pass and released on the next, and an adapter that forgot it in between
// would lose the album. Items therefore stay in the buffer, oldest dropped past
// RETAINED, which is far more than any window keeps open.

import { fault } from '../../stream/faults.mjs';
import { StreamFault } from '../../stream/store.mjs';
import { openChannel } from './socket.mjs';

// How many arrivals are kept per account. An item this far back has been through
// the cursors long ago; keeping it costs memory and buys nothing.
export const RETAINED = 500;

const channels = new Map();

function keyOf(context) {
  return `${context.agent}:${context.account}`;
}

function entryFor(context) {
  const key = keyOf(context);
  let entry = channels.get(key);
  if (!entry) {
    entry = { items: [], socket: null, opening: null };
    channels.set(key, entry);
  }
  return entry;
}

// For a test, and for a process that stops one agent and starts another in the
// same process, which nothing does today.
export function forget() {
  channels.clear();
}

// The open connection for this account, opening it if it is not open. A close
// that is not terminal clears the socket and nothing else: the next poll opens
// again, which makes the channel's own interval the reconnection interval and
// leaves no timer in this process to lose on a restart. A terminal close is
// socket.mjs's business: it latches, and the process stops.
export async function connection(context) {
  const entry = entryFor(context);
  if (entry.socket) return entry;
  if (entry.opening) return entry.opening;

  const authDir = context.channel?.auth_dir;
  if (!authDir) {
    throw new StreamFault([fault('CHANNEL_AUTH_DIR_ABSENT', `whatsapp:${context.account}`,
      'this channel declares no transport.auth_dir, and the adapter guesses no path for a directory that is a credential',
      'declare transport.auth_dir as the absolute path of the directory carbon-whatsapp pair wrote')]);
  }

  entry.opening = openChannel({
    store: context.store,
    account: context.account,
    authDir,
    onItems: (items) => {
      entry.items.push(...items);
      if (entry.items.length > RETAINED) entry.items.splice(0, entry.items.length - RETAINED);
    }
  }).then((socket) => {
    entry.socket = socket;
    if (socket) {
      socket.ev.on('connection.update', ({ connection: state }) => {
        if (state === 'close') entry.socket = null;
      });
    }
    return entry;
  }).finally(() => { entry.opening = null; });

  return entry.opening;
}

// What has arrived on this account. A connection that could not be opened is a
// failed poll, which the runtime writes on the channel and holds on past the
// declared count; it is not this adapter's business to end the process.
export async function arrivals(context) {
  const entry = await connection(context);
  if (!entry.socket) {
    throw new StreamFault([fault('CHANNEL_NOT_CONNECTED', `whatsapp:${context.account}`,
      'the connection to WhatsApp is not open',
      'read channels/<account>/whatsapp.channel.json and whatsapp.latch.json under the store for what the connection last said')]);
  }
  return entry.items;
}

// The socket a send goes out on, when the caller did not hand one over.
export async function socketFor(context) {
  const entry = await connection(context);
  return entry.socket;
}
