// The long poll, as the release loop sees it.
//
// index.mjs holds every rule and no connection; api.mjs holds the calls and no
// rule. This is the middle: one long poll per account, a buffer of what it
// collected, and the one thing that decides when the next call may ask for a
// higher offset.
//
// ## Why the poll runs behind the loop and not inside it
//
// `getUpdates` is a long poll: it sits at the server for up to fifty seconds and
// answers the moment something arrives. Calling it from inside the loop's pass
// would block every other channel on this agent for as long as it waits, so it
// runs as its own task, and `poll` hands over whatever it has collected since the
// last pass. That is the same shape the other chat channel here has, for the same
// reason, and it means the channel's `poll_interval_ms` decides how long a
// message waits before the agent looks at it, not how often the server is asked.
//
// ## The one rule that makes this durable
//
// The Bot API has no acknowledgement of its own. An update is deleted when the
// *next* `getUpdates` asks for an offset past it, and it is then gone: there is
// no second delivery and no way to ask for it again. So the offset is only ever
// advanced past a record that is on disk. The worker reads the offset out of the
// store's own cursor, which `consume` moves after the capture is written, and it
// will not ask again until the loop has consumed what it was handed. A restart in
// the middle therefore loses nothing: the offset on disk is the last thing
// captured, and the server still holds everything after it.
//
// The cost of that rule is that a batch sits in the buffer until the loop drains
// it, which is one pass. The alternative — fetch ahead and keep what is not
// consumed in memory — buys a little latency and pays for it with every message
// in flight when the process dies, which is exactly the trade this programme does
// not make with a client's messages.

import { fault } from '../../stream/faults.mjs';
import { ALLOWED_UPDATES, DEFAULT_API_HOST, TelegramFault, call, download, readToken } from './api.mjs';
import { mediaOf, messageOf } from './content.mjs';
import { nextOffset, positionOf } from './cursors.mjs';

// How long the worker waits before looking again at whether the loop has
// consumed what it was handed. It is not a poll interval: nothing is asked of the
// server here, it is one read of a cursor file.
export const IDLE_MS = 250;

// How long the worker waits after a failed call before trying again, so a server
// that is refusing everything is asked twice a second rather than as fast as the
// event loop turns.
export const RETRY_MS = 5000;

const channels = new Map();

function keyOf(context) {
  return `${context.agent}:${context.account}`;
}

// Stop this account's long poll. The worker is a task with no end of its own — it
// is meant to run as long as the unit does — and a task with no end keeps the
// process alive, so a run that has done its work and returned would sit there
// until somebody killed it. The runtime calls this when it stops, which is the
// only thing that ends it.
export async function stop(context) {
  const key = keyOf(context);
  const entry = channels.get(key);
  if (!entry) return;
  entry.stopped = true;
  channels.delete(key);
  if (entry.worker) await entry.worker;
}

// For a test, and for a process that stops one agent and starts another in the
// same process, which nothing does today.
export function forget() {
  for (const entry of channels.values()) entry.stopped = true;
  channels.clear();
}

// How this account reaches the Bot API. The token is read from its file at the
// moment it is used and is not kept on the channel, not put in this process's
// environment and not written anywhere.
export function transportFor(context) {
  return {
    token: readToken(context.channel?.bot_token),
    apiHost: context.channel?.api_host ?? DEFAULT_API_HOST
  };
}

function entryFor(context) {
  const key = keyOf(context);
  let entry = channels.get(key);
  if (!entry) {
    entry = { items: [], highest: null, worker: null, stopped: false, fault: null, started_at: null };
    channels.set(key, entry);
  }
  return entry;
}

// What has arrived on this account. A worker that has not managed a call yet, and
// has nothing to hand over, is a failed poll: the runtime writes it on the channel
// and holds past the declared count. It is not this adapter's business to end the
// process.
export async function arrivals(context) {
  const entry = entryFor(context);
  if (entry.worker === null) {
    entry.started_at = Date.now();
    entry.worker = work(entry, context).catch((error) => { entry.fault = error; });
  }
  if (entry.items.length === 0 && entry.fault !== null) {
    const carried = entry.fault;
    entry.fault = null;
    throw carried;
  }
  return entry.items.slice();
}

// The worker. One long poll at a time, and never one that would confirm an update
// the store has not written.
async function work(entry, context) {
  const { store, account, channel } = context;
  const timeout = Math.min(50, Math.max(0, channel?.long_poll_timeout_s ?? 25));

  while (!entry.stopped) {
    const offset = nextOffset(store, account);

    // What was handed over last time and has not been consumed yet. Asking for a
    // higher offset now would tell the server to forget it.
    if (entry.highest !== null && (offset === null || offset <= entry.highest)) {
      await sleep(IDLE_MS);
      continue;
    }

    let updates;
    try {
      const transport = transportFor(context);
      updates = await call(transport, 'getUpdates', {
        offset: offset ?? undefined,
        timeout,
        allowed_updates: ALLOWED_UPDATES
      }, { timeoutMs: (timeout + 20) * 1000 });
      entry.items = await withAttachments(transport, context, updates);
      entry.highest = updates.length === 0
        ? entry.highest
        : Math.max(...updates.map((update) => update.update_id));
      entry.fault = null;
    } catch (error) {
      entry.fault = error instanceof TelegramFault
        ? error
        : new TelegramFault([fault('BOT_API_POLL_FAILED', 'getUpdates',
          error?.message ?? String(error),
          'the runtime keeps polling until the channel\'s declared failure count is reached')]);
      await sleep(RETRY_MS);
    }
  }
}

// Turn the server's updates into this adapter's items, fetching what is attached
// to them. The download happens here and not in index.mjs, so that every rule in
// index.mjs stays testable against recorded updates with no network.
//
// An attachment bigger than the channel allows is not fetched at all: the record
// says the download failed, names its size and digest, and is released anyway,
// because the words of a message with a file on it are usually the part that
// matters and a stalled disk is a worse outcome than a missing picture.
async function withAttachments(transport, context, updates) {
  const limit = context.channel?.max_attachment_bytes ?? 0;
  const items = [];
  for (const update of updates) {
    const { message } = messageOf(update);
    const item = {
      conversation: message?.chat?.id === undefined ? null : String(message.chat.id),
      position: message?.message_id === undefined ? null : positionOf(message.message_id),
      received_at: new Date().toISOString(),
      update
    };
    const media = message === null ? null : mediaOf(message);
    if (media !== null && (media.bytes ?? 0) <= limit) {
      const fetched = await fetchMedia(transport, media);
      if (fetched !== null) item.attachments = [fetched];
    }
    items.push(item);
  }
  return items;
}

async function fetchMedia(transport, media) {
  try {
    const file = await call(transport, 'getFile', { file_id: media.file_id });
    if (typeof file?.file_path !== 'string') return null;
    const bytes = await download(transport, file.file_path);
    return { bytes, mime: media.mime, filename: media.file_name };
  } catch {
    // A download that failed is not a failed poll: the message itself arrived and
    // is worth capturing. index.mjs writes the attachment as download_failed.
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
