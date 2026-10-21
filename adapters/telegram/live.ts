import type { Fields, Context, Transport, ArrivedItem, Media, FetchedMedia } from './types.ts';
// The long poll, as the release loop sees it.
//
// index.ts holds every rule and no connection; api.ts holds the calls and no
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
//
// ## What the batch is
//
// The batch is everything this worker still remembers and the store has not
// confirmed, in update-id order. It is not the latest answer: one `getUpdates`
// answer is what the server chose to say this time, and it may carry part of an
// album, repeat the last answer, reorder it or carry nothing, none of which says
// anything about an update already seen. An answer that named one photograph of
// six the worker was holding is how an album became one turn and then five, so
// the retained set is the single authority for the waiting, the downloads, the
// handoff and the watermark that follows it.

import { fault } from '../../stream/faults.ts';
import { ALLOWED_UPDATES, DEFAULT_API_HOST, TelegramFault, call, download, readToken } from './api.ts';
import { albumOf, mediaOf, messageOf } from './content.ts';
import { nextOffset, positionOf } from './cursors.ts';

// How long the worker waits before looking again at whether the loop has
// consumed what it was handed. It is not a poll interval: nothing is asked of the
// server here, it is one read of a cursor file.
export const IDLE_MS = 250;

// An album arrives as several updates over a second or two. The declaration
// governs; this is the value used when it is absent.
export const ALBUM_QUIET_MS = 2000;

// How long the worker waits after a failed call before trying again, so a server
// that is refusing everything is asked twice a second rather than as fast as the
// event loop turns.
export const RETRY_MS = 5000;

// The wait after a failed call. The worker captures one when it starts. The
// ordinary caller passes none, so that capture is the production sleep of
// RETRY_MS, which stop aborts. A test can pass its own and hold it until the
// fault is visible. A later arrivals call does not replace what was captured.
export type RetryWait = {
  wait(signal: AbortSignal): Promise<void>;
};

const productionRetry: RetryWait = {
  wait(signal) { return sleep(RETRY_MS, signal); }
};

type PollEntry = {
  items: ArrivedItem[]; highest: number | null; worker: Promise<void> | null;
  stopped: boolean; ending: AbortController; fault: unknown; started_at: number | null;
  seen: Map<unknown, ArrivedItem>; media: Map<unknown, FetchedMedia | null>;
  inflight: Map<unknown, Promise<FetchedMedia | null>>; sighted: Map<unknown, number>;
  lanes: Lanes; ready: Set<() => void>; run_id: string;
  spec: Map<unknown, Speculative>; abandoned: Set<unknown>;
};
type Speculative = { reserved: number; since: number; ctl: AbortController };

// Download chains one account may have running at once. Fixed, not configuration.
export const DOWNLOAD_CHAINS = 4;

// Resource bound for speculative (eager, pre-settlement) downloads, in memory only:
//  - at most SPECULATIVE_MEMBERS members cached or in flight and not yet handed to
//    a settled batch (this also bounds the queue waiting for a lane);
//  - at most SPECULATIVE_CHAINS x max_attachment_bytes of speculative bytes, counted
//    as the provider's size (or the per-file limit if it gave none) until the body
//    arrives, then as the actual length; a body over the per-file limit is oversize;
//  - a speculative member older than SPECULATIVE_QUIET_FACTOR x album_quiet_ms that
//    has not been handed to a settled batch is abandoned: its fetch is aborted, its
//    buffer dropped, and it is never speculated again. The update itself stays
//    retained, so cursors and holds are untouched and a later settlement fetches it
//    normally. An over-budget body is dropped the same way, not cached as a failure.
export const SPECULATIVE_MEMBERS = 16;
export const SPECULATIVE_CHAINS = 4;
const SPECULATIVE_QUIET_FACTOR = 20;

// A bounded set of lanes. A waiter whose signal has ended leaves the queue and
// never starts; a lane is handed straight to the next live waiter, so free +
// held always equals DOWNLOAD_CHAINS.
class Lanes {
  #free = DOWNLOAD_CHAINS;
  #queue: ((granted: boolean) => void)[] = [];
  get free() { return this.#free; }
  get queued() { return this.#queue.length; }
  take(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#free > 0) { this.#free -= 1; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const waiter = (granted: boolean) => { signal.removeEventListener('abort', onAbort); resolve(granted); };
      const onAbort = () => {
        const at = this.#queue.indexOf(waiter);
        if (at >= 0) this.#queue.splice(at, 1);
        resolve(false);
      };
      this.#queue.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  give() {
    const next = this.#queue.shift();
    if (next) next(true); else this.#free = Math.min(DOWNLOAD_CHAINS, this.#free + 1);
  }
  release() { for (const next of this.#queue.splice(0)) next(false); }
}
export { Lanes };

const LATENCY_SCHEMA = 'carbon.latency-experiment.v1';
// Source ids named on one record; the count says how many there were.
const SOURCE_ID_CAP = 8;

// One record in the runtime log under its own event name. Ids are Telegram
// update ids only: no text, bytes, token or file path. Both clocks are this
// process's performance.now(), so a duration is one clock's difference.
function emit(entry: PollEntry, context: Context, stage: string, ids: unknown[], started: number, status: string) {
  try {
    context.log?.({
      event: 'latency_experiment', schema: LATENCY_SCHEMA, run_id: entry.run_id, variant: 'default', stage,
      source_ids: ids.filter((id) => Number.isSafeInteger(id)).slice(0, SOURCE_ID_CAP), source_count: ids.length,
      started_monotonic_ms: Math.round(started * 1000) / 1000, ended_monotonic_ms: Math.round(performance.now() * 1000) / 1000, status
    });
  } catch { return; /* a log fault must not fail the poll */ }
}
const channels = new Map<string, PollEntry>();

function keyOf(context: Pick<Context, 'agent' | 'account'>) {
  return `${context.agent}:${context.account}`;
}

// Stop this account's long poll. The worker is a task with no end of its own — it
// is meant to run as long as the unit does — and a task with no end keeps the
// process alive, so a run that has done its work and returned would sit there
// until somebody killed it. The runtime calls this when it stops, which is the
// only thing that ends it.
//
// It aborts the getUpdates in flight rather than waiting it out (PA-322): a long
// poll holds at the server for its whole timeout when nothing arrives, and a
// drain that waited for it took ten seconds on a box. Aborting loses nothing.
// The server forgets an update only when a call asks for an offset past it, and
// the call in flight asked for the offset on disk, one past the last update the
// store has written; what its answer would have carried is still the server's,
// and the next start asks for the same offset again.
export async function stop(context: Pick<Context, 'agent' | 'account'>) {
  const key = keyOf(context);
  const entry = channels.get(key);
  if (!entry) return;
  entry.stopped = true;
  entry.ending.abort();
  entry.lanes.release();
  channels.delete(key);
  if (entry.worker) await entry.worker;
}

// For a test, and for a process that stops one agent and starts another in the
// same process, which nothing does today.
export function forget() {
  for (const entry of channels.values()) { entry.stopped = true; entry.ending.abort(); entry.lanes.release(); }
  channels.clear();
}

// How this account reaches the Bot API. The token is read from its file at the
// moment it is used and is not kept on the channel, not put in this process's
// environment and not written anywhere.
export function transportFor(context: Pick<Context, 'channel'>) {
  return {
    token: readToken(context.channel?.bot_token),
    apiHost: context.channel?.api_host ?? DEFAULT_API_HOST
  };
}

function entryFor(context: Context) {
  const key = keyOf(context);
  let entry = channels.get(key);
  if (!entry) {
    entry = {
      items: [], highest: null, worker: null, stopped: false, ending: new AbortController(), fault: null,
      started_at: null, seen: new Map(), media: new Map(),
      inflight: new Map(), sighted: new Map(), lanes: new Lanes(), ready: new Set(), spec: new Map(), abandoned: new Set(),
      run_id: `${key}:${Date.now().toString(36)}`
    };
    channels.set(key, entry);
  }
  return entry;
}

// What has arrived on this account. A worker that has not managed a call yet, and
// has nothing to hand over, is a failed poll: the runtime writes it on the channel
// and holds past the declared count. It is not this adapter's business to end the
// process.
export async function arrivals(context: Context, retryWait: RetryWait = productionRetry) {
  const entry = entryFor(context);
  if (entry.worker === null) {
    entry.started_at = Date.now();
    const captured = retryWait;
    entry.worker = work(entry, context, captured).catch((error) => { entry.fault = error; });
  }
  if (entry.items.length === 0 && entry.fault !== null) {
    const carried = entry.fault;
    entry.fault = null;
    throw carried;
  }
  return entry.items.slice();
}

// Tell the runtime a settled, non-empty batch is waiting, so it need not sleep out
// its interval. Only a hint: the batch is still handed over by `arrivals`, the
// offset still moves only on consume, and a missed hint costs one interval.
export function speculativeState(context: Pick<Context, 'agent' | 'account'>) {
  const entry = channels.get(keyOf(context));
  let bytes = 0;
  for (const member of entry?.spec.values() ?? []) bytes += member.reserved;
  return { members: entry?.spec.size ?? 0, bytes };
}

// A listener's fault is its own: it must not fail the poll, and the batch is
// still handed over by `arrivals`. Returns whether the hint was delivered.
function hint(listener: () => void) {
  try { listener(); return true; } catch { return false; }
}

export function onReady(context: Context, listener: () => void) {
  const entry = entryFor(context);
  entry.ready.add(listener);
  // A batch already waiting when the listener arrives gets its hint now, unless
  // the listener left or the channel stopped first.
  if (entry.items.length > 0) {
    queueMicrotask(() => {
      if (entry.stopped || !entry.ready.has(listener)) return;
      hint(listener);
    });
  }
  return () => { entry.ready.delete(listener); };
}

// The worker. One long poll at a time, and never one that would confirm an update
// the store has not written.
async function work(entry: PollEntry, context: Context, retryWait: RetryWait) {
  const { store, account, channel } = context;
  const timeout = Math.min(50, Math.max(0, channel?.long_poll_timeout_s ?? 25));
  const albumQuiet = channel?.album_quiet_ms ?? ALBUM_QUIET_MS;

  while (!entry.stopped) {
    const offset = nextOffset(store, account);

    // What was handed over last time and has not been consumed yet. Asking for a
    // higher offset now would tell the server to forget it.
    if (entry.highest !== null && (offset === null || offset <= entry.highest)) {
      await sleep(IDLE_MS, entry.ending.signal);
      continue;
    }

    dropConfirmed(entry, offset);

    try {
      const transport = transportFor(context);
      const { items } = await settledBatch(entry, transport, context, {
        offset, timeout, albumQuiet
      });
      if (entry.stopped) break;
      entry.items = items;
      // The handed set is the only authority for the watermark. Reading it off
      // the last response instead would confirm updates this batch does not
      // carry, which is exactly how a shrinking response loses an album.
      entry.highest = items.length === 0
        ? entry.highest
        : // Math.max performs the original coercion; this numeric view is
        // limited to its argument and does not type any provider field.
        Math.max(...items.map((item) => (item.update as Fields).update_id as number));
      entry.fault = null;
      if (items.length > 0) for (const listener of [...entry.ready]) hint(listener);
    } catch (error) {
      entry.fault = error instanceof TelegramFault
        ? error
        // A failed poll may throw any value; retain its optional message in the fault.
        : new TelegramFault([fault('BOT_API_POLL_FAILED', 'getUpdates',
          (error as Fields | null | undefined)?.message ?? String(error),
          'the runtime keeps polling until the channel\'s declared failure count is reached')]);
      await retryWait.wait(entry.ending.signal);
    }
  }
}

// Comparison views preserve the original JavaScript coercion of unvalidated
// keys. Keys themselves remain unknown in both maps and on every returned item.
function dropConfirmed(entry: PollEntry, offset: number | null) {
  if (offset === null) return;
  for (const updateId of entry.seen.keys()) {
    if ((updateId as number) < offset) entry.seen.delete(updateId);
  }
  for (const updateId of entry.media.keys()) {
    if ((updateId as number) < offset) entry.media.delete(updateId);
  }
  for (const updateId of [...entry.spec.keys()]) if ((updateId as number) < offset) entry.spec.delete(updateId);
  for (const updateId of [...entry.abandoned]) if ((updateId as number) < offset) entry.abandoned.delete(updateId);
  for (const updateId of entry.sighted.keys()) {
    if ((updateId as number) < offset) entry.sighted.delete(updateId);
  }
}

// Everything this worker still remembers and the store has not confirmed, in the
// order the stream numbers it. This — not the latest response — is the batch: a
// server answer that omits an update the worker has already seen says nothing
// about that update, and an album whose members are spread over several answers
// is only ever whole here.
function retained(entry: PollEntry, offset: number | null) {
  return [...entry.seen.keys()]
    .filter((updateId) => offset === null || (updateId as number) >= offset)
    .sort((left, right) => (left as number) - (right as number))
    // These keys come from this map, with no mutation during the synchronous chain.
    .map((updateId) => entry.seen.get(updateId)!);
}

function albumWait(items: ArrivedItem[], albumQuiet: number) {
  const youngest = items
    .filter((item) => albumOf(messageOf(item.update).message) !== null)
    .map((item) => Date.parse(item.received_at))
    .filter((at) => !Number.isNaN(at))
    .reduce((latest, at) => Math.max(latest, at), 0);
  if (youngest === 0) return 0;
  return Math.max(0, albumQuiet - (Date.now() - youngest));
}

async function settledBatch(entry: PollEntry, transport: Transport, context: Context, { offset, timeout, albumQuiet }: { offset: number | null; timeout: number; albumQuiet: number }) {
  let requestTimeout = timeout;
  while (!entry.stopped) {
    const updates = await call(transport, 'getUpdates', {
      offset: offset ?? undefined,
      timeout: requestTimeout,
      allowed_updates: ALLOWED_UPDATES
    }, { timeoutMs: (requestTimeout + 20) * 1000, signal: entry.ending.signal });
    remember(entry, updates);
    const items = retained(entry, offset);
    // Downloads start as members are first seen, inside the album window, and are
    // never awaited here: this loop must make its next same-offset ask on time.
    startEager(entry, transport, context, items);
    const remaining = albumWait(items, albumQuiet);
    if (remaining === 0) {
      const settled = performance.now();
      const ids = items.map(idOf);
      const first = Math.min(...items.map((item) => entry.sighted.get((item.update as Fields).update_id) ?? settled));
      if (items.length > 0) emit(entry, context, 'collection', ids, first, 'ok');
      const hydrated = await withAttachments(entry, transport, context, items);
      if (items.length > 0) emit(entry, context, 'batch-ready', ids, settled, entry.stopped ? 'cancelled' : 'ok');
      return { items: hydrated };
    }
    await sleep(Math.min(IDLE_MS, remaining), entry.ending.signal);
    requestTimeout = 0;
  }
  return { items: [] };
}

// Add what this response showed for the first time. An update already remembered
// keeps the item and the moment it was first seen, however many answers repeat
// it: the first sighting is what the album window is measured from, and a repeat
// that reset it would hold an album open for as long as the server kept
// repeating it.
function remember(entry: PollEntry, updates: unknown) {
  // Iterate the provider value unchanged: a non-iterable still throws here.
  // This assertion describes the attempted operation, not a validated result.
  for (const update of updates as Iterable<unknown>) {
    if (entry.seen.has((update as Fields).update_id)) continue;
    entry.sighted.set((update as Fields).update_id, performance.now());
    const { message } = messageOf(update);
    entry.seen.set((update as Fields).update_id, {
      conversation: ((message as Fields | null)?.chat as Fields | null)?.id === undefined ? null : String(((message as Fields).chat as Fields).id),
      position: (message as Fields | null)?.message_id === undefined ? null : positionOf((message as Fields).message_id),
      received_at: new Date().toISOString(),
      update
    });
  }
}

// Fetch attachments only after the update membership has settled. A getFile call
// or response body can take longer than the album window; putting either inside
// the window can expire it before the worker has made its next same-offset ask.
// The download still happens here and not in index.ts, so that every rule in
// index.ts stays testable against recorded updates with no network.
//
// An attachment bigger than the channel allows is not fetched at all: the record
// says the download failed, names its size and digest, and is released anyway,
// because the words of a message with a file on it are usually the part that
// matters and a stalled disk is a worse outcome than a missing picture.
async function withAttachments(entry: PollEntry, transport: Transport, context: Context, items: ArrivedItem[]) {
  // Every fetch is already running or cached; awaiting by index keeps source order.
  return Promise.all(items.map(async (item) => {
    const complete = { ...item };
    const media = wanted(context, item);
    if (media !== null) {
      const fetched = await mediaFor(entry, transport, context, (item.update as Fields).update_id, media, false);
      if (fetched !== null) complete.attachments = [fetched];
    }
    return complete;
  }));
}

const idOf = (item: ArrivedItem) => (item.update as Fields).update_id;

// The media of an item that is to be fetched at all: one over the channel limit
// is not.
function wanted(context: Context, item: ArrivedItem) {
  const limit = context.channel?.max_attachment_bytes ?? 0;
  const { message } = messageOf(item.update);
  const media = message === null ? null : mediaOf(message);
  // The comparison keeps JavaScript coercion; the media bytes field stays unknown.
  return media !== null && ((media.bytes ?? 0) as number) <= limit ? media : null;
}

function startEager(entry: PollEntry, transport: Transport, context: Context, items: ArrivedItem[]) {
  const limit = (context.channel?.max_attachment_bytes ?? 0) as number;
  const quiet = (context.channel?.album_quiet_ms ?? ALBUM_QUIET_MS) as number;
  const now = performance.now();
  for (const [id, member] of [...entry.spec]) {
    if (now - member.since <= quiet * SPECULATIVE_QUIET_FACTOR) continue;
    entry.spec.delete(id);
    entry.abandoned.add(id);
    entry.media.delete(id);
    entry.inflight.delete(id);
    member.ctl.abort();
  }
  const cap = SPECULATIVE_CHAINS * limit;
  let held = 0;
  for (const member of entry.spec.values()) held += member.reserved;
  for (const item of items) {
    const media = wanted(context, item);
    const id = idOf(item);
    if (media === null || entry.media.has(id) || entry.inflight.has(id) || entry.abandoned.has(id)) continue;
    const size = Number(media.bytes ?? limit);
    const reserved = Number.isFinite(size) ? size : limit;
    if (entry.spec.size >= SPECULATIVE_MEMBERS || held + reserved > cap) continue;
    held += reserved;
    void mediaFor(entry, transport, context, id, media, true, reserved);
  }
}

// What was fetched for an update this worker still remembers, fetched once. A
// retained update can settle into more than one batch, and a fetch started
// early is the same fetch the settled batch awaits (which also takes it out of
// the speculative budget); the bytes are dropped with the update itself when the
// store confirms it. A failure is cached as null. Only a fetch that actually
// ran emits a record, so cached polls stay quiet.
function mediaFor(entry: PollEntry, transport: Transport, context: Context, updateId: unknown, media: Media, speculative: boolean, reserved = 0): Promise<FetchedMedia | null> {
  if (!speculative) entry.spec.delete(updateId);
  // has/get are adjacent with no mutation; null is retained as a cached failure.
  if (entry.media.has(updateId)) return Promise.resolve(entry.media.get(updateId)!);
  const running = entry.inflight.get(updateId);
  if (running !== undefined) return running;
  const ctl = new AbortController();
  if (speculative) entry.spec.set(updateId, { reserved, since: performance.now(), ctl });
  const signal = AbortSignal.any([entry.ending.signal, ctl.signal]);
  const limit = (context.channel?.max_attachment_bytes ?? 0) as number;
  let chain!: Promise<FetchedMedia | null>;
  chain = (async () => {
    const queued = performance.now();
    try {
      if (!await entry.lanes.take(signal)) return null;
      try {
        const got = await fetchMedia(transport, media, signal);
        const outcome = judge(entry, updateId, got, limit, signal.aborted, ctl.signal.aborted);
        const { fetched, status, keep } = outcome;
        if (keep) entry.media.set(updateId, fetched);
        emit(entry, context, 'download', [updateId], queued, !keep && status !== 'dropped' ? 'cancelled' : status);
        return fetched;
      } finally {
        entry.lanes.give();
      }
    } finally {
      if (entry.inflight.get(updateId) === chain) entry.inflight.delete(updateId);
    }
  })();
  entry.inflight.set(updateId, chain);
  return chain;
}

// Size and budget verdict for a finished fetch: oversize is a failure, an
// over-budget speculative body is dropped (never cached), a cancelled fetch is
// not kept.
function judge(entry: PollEntry, updateId: unknown, got: FetchedMedia | null, limit: number, ended: boolean, cancelled: boolean) {
  let fetched = got;
  let status = fetched === null ? 'failed' : 'ok';
  let keep = !(ended && fetched === null) && !cancelled;
  if (fetched !== null && fetched.bytes.length > limit) { fetched = null; status = 'oversize'; }
  const member = entry.spec.get(updateId);
  if (keep && fetched !== null && member !== undefined) {
    member.reserved = fetched.bytes.length;
    let held = 0;
    for (const other of entry.spec.values()) held += other.reserved;
    if (held > SPECULATIVE_CHAINS * limit) {
      entry.spec.delete(updateId); entry.abandoned.add(updateId);
      fetched = null; keep = false; status = 'dropped';
    }
  }
  return { fetched, status, keep };
}

async function fetchMedia(transport: Transport, media: Media, signal: AbortSignal) {
  try {
    const file = await call(transport, 'getFile', { file_id: media.file_id }, { signal });
    // getFile returns provider JSON; this read checks only the file path before downloading.
    if (typeof (file as Fields | null)?.file_path !== 'string') return null;
    // The preceding typeof check establishes this file path, not the rest of the response.
    const bytes = await download(transport, (file as Fields).file_path as string, { signal });
    return { bytes, mime: media.mime, filename: media.file_name };
  } catch {
    // A download that failed is not a failed poll: the message itself arrived and
    // is worth capturing. index.ts writes the attachment as download_failed.
    return null;
  }
}

// A wait that a stop ends at once, so the worker never outlives stop() by a
// retry interval.
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
