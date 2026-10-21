// PA-241: resource bounds of speculative (pre-settlement) downloads, the Lanes
// invariant after stop, and a ready hint for a batch that is already waiting.
// Timings are SIMULATED fixture time.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { arrivals, forget, stop, onReady, speculativeState, Lanes, DOWNLOAD_CHAINS, SPECULATIVE_MEMBERS, SPECULATIVE_CHAINS } from '../adapters/telegram/live.ts';
import { nextOffset } from '../adapters/telegram/cursors.ts';
import { idsOf, liveContext, photoUpdate, scriptedServerOf, waitForBatch, sleep } from './telegram-fixtures.ts';

afterEach(() => { forget(); });
type Line = Record<string, unknown>;
const LIMIT = 1000;

// An album that gains one member every `every` ms until `total` have arrived.
function growing(base: number, total: number, every: number, claim?: number) {
  const all = Array.from({ length: total }, (_, i) => {
    const u = photoUpdate(base + i, 701 + i, 'grow');
    if (claim !== undefined) (u.message.photo[0] as { file_size: number }).file_size = claim;
    return u;
  });
  const start = Date.now();
  return { all, respond: () => all.slice(0, Math.min(total, 1 + Math.floor((Date.now() - start) / every))) };
}
function rig(quiet: number, respond: () => ReturnType<typeof photoUpdate>[], bytesOf?: (id: string) => number[]) {
  forget();
  const lines: Line[] = [];
  const context = { ...liveContext('carbon-telegram-spec-', { album_quiet_ms: quiet, max_attachment_bytes: LIMIT }), log: (l: Line) => { lines.push(l); } };
  const server = scriptedServerOf({ respond, bytesOf });
  return { context, lines, server, done: () => server.restore() };
}

test('endless album: speculative members stay within the bound, then are abandoned and not restarted; nothing confirmed', async () => {
  const g = growing(940001, 400, 5);
  const r = rig(50, g.respond);
  try {
    await arrivals(r.context);
    let peak = 0;
    for (let i = 0; i < 25; i++) { await sleep(20); peak = Math.max(peak, speculativeState(r.context).members); }
    assert.ok(peak > 0 && peak <= SPECULATIVE_MEMBERS, `peak ${peak}`);
    assert.ok(r.server.fetched.size <= SPECULATIVE_MEMBERS + SPECULATIVE_CHAINS * 0, 'more members started than the bound');
    await sleep(1100); // past 20 x 50 ms, album still growing
    const now = speculativeState(r.context);
    assert.ok(now.members <= SPECULATIVE_MEMBERS && now.bytes <= SPECULATIVE_CHAINS * LIMIT);
    assert.ok(r.lines.some((l) => l.stage === 'download' && l.status === 'cancelled') || r.server.fetched.size > SPECULATIVE_MEMBERS, 'nothing was abandoned');
    assert.ok(Math.max(...r.server.fetched.values()) <= 1, 'an abandoned member was speculated again');
    assert.equal(nextOffset(r.context.store, r.context.account), null);
  } finally { await stop(r.context); r.done(); }
});

test('late settle after abandonment: every member hydrates once more, in order, none lost', async () => {
  const g = growing(941001, 50, 60);
  const r = rig(100, g.respond);
  try {
    await arrivals(r.context);
    const { items } = await waitForBatch(r.context, { attempts: 400 });
    assert.deepEqual(idsOf(items), g.all.map((u) => u.update_id));
    assert.ok(items.every((i) => (i.attachments as unknown[]).length === 1));
    assert.ok(r.lines.some((l) => l.stage === 'download' && l.status === 'cancelled') || [...r.server.fetched.values()].some((n) => n > 1), 'nothing was ever abandoned');
    assert.equal(nextOffset(r.context.store, r.context.account), null);
  } finally { r.done(); }
});

test('actual oversize bytes: a body over the limit is not attached and not refetched, neighbours are', async () => {
  const album = [photoUpdate(942001, 801, 'o'), photoUpdate(942002, 802, 'o'), photoUpdate(942003, 803, 'o')];
  const r = rig(100, () => album, (id) => new Array(id === 'file-802' ? 2000 : 3).fill(7));
  try {
    await arrivals(r.context);
    const { items } = await waitForBatch(r.context);
    assert.deepEqual(items.map((i) => i.attachments !== undefined), [true, false, true]);
    for (let i = 0; i < 3; i++) await arrivals(r.context);
    assert.equal(r.server.fetched.get('file-802'), 1);
    assert.ok(r.lines.some((l) => l.stage === 'download' && l.status === 'oversize'));
  } finally { r.done(); }
});

test('memory accounting: reserved bytes never exceed the cap; understated metadata is corrected by actual bytes', async () => {
  const cap = SPECULATIVE_CHAINS * LIMIT;
  // metadata claims 900: only four fit.
  const a = growing(943001, 12, 20, 900);
  const ra = rig(60, a.respond, () => new Array(900).fill(1));
  try {
    await arrivals(ra.context);
    for (let i = 0; i < 20; i++) { await sleep(10); assert.ok(speculativeState(ra.context).bytes <= cap); }
    assert.ok(speculativeState(ra.context).members <= 4);
  } finally { await stop(ra.context); ra.done(); }
  // metadata claims 10 but bodies are 900: actual bytes must be what is counted.
  const b = growing(944001, 12, 20, 10);
  const rb = rig(60, b.respond, () => new Array(900).fill(1));
  try {
    await arrivals(rb.context);
    let peak = 0;
    for (let i = 0; i < 40; i++) { await sleep(10); peak = Math.max(peak, speculativeState(rb.context).bytes); }
    assert.ok(peak <= cap, `held ${peak} > ${cap}`);
    const { items } = await waitForBatch(rb.context, { attempts: 400 });
    assert.ok(items.every((i) => i.attachments !== undefined), 'dropped speculative bodies were not hydrated later');
    assert.ok(rb.lines.some((l) => l.stage === 'download' && l.status === 'dropped'), 'guard: the byte budget never bit');
  } finally { rb.done(); }
});

test('cancellation: stop mid-album leaves no speculative state and starts nothing', async () => {
  const g = growing(945001, 400, 5);
  const r = rig(50, g.respond);
  try {
    await arrivals(r.context);
    await sleep(150);
    await stop(r.context);
    assert.deepEqual(speculativeState(r.context), { members: 0, bytes: 0 });
    const n = r.server.media.length;
    await sleep(300);
    assert.equal(r.server.media.length, n);
  } finally { r.done(); }
});

test('Lanes invariant: aborted queued waiters after release create no phantom lanes', async () => {
  const lanes = new Lanes();
  const live = new AbortController();
  for (let i = 0; i < DOWNLOAD_CHAINS; i++) assert.equal(await lanes.take(live.signal), true);
  const queued = [lanes.take(live.signal), lanes.take(live.signal), lanes.take(live.signal)];
  assert.equal(lanes.queued, 3);
  live.abort();
  lanes.release();
  assert.deepEqual(await Promise.all(queued), [false, false, false]);
  assert.equal(lanes.free, 0);
  assert.equal(lanes.queued, 0);
  for (let i = 0; i < DOWNLOAD_CHAINS; i++) lanes.give();
  assert.equal(lanes.free, DOWNLOAD_CHAINS);
  // release alone (signal not yet aborted) must not mint lanes either
  const held = new AbortController();
  for (let i = 0; i < DOWNLOAD_CHAINS; i++) await lanes.take(held.signal);
  const waiting = [lanes.take(held.signal), lanes.take(held.signal)];
  lanes.release();
  assert.deepEqual(await Promise.all(waiting), [false, false]);
  assert.equal(lanes.free, 0);
  for (let i = 0; i < DOWNLOAD_CHAINS; i++) lanes.give();
  assert.equal(lanes.free, DOWNLOAD_CHAINS);
  // a waiter aborted alone leaves the queue and never inherits a lane
  const other = new AbortController();
  const fresh = new AbortController();
  for (let i = 0; i < DOWNLOAD_CHAINS; i++) await lanes.take(fresh.signal);
  const gone = lanes.take(other.signal);
  const next = lanes.take(fresh.signal);
  other.abort();
  assert.equal(await gone, false);
  lanes.give();
  assert.equal(await next, true);
  assert.equal(lanes.free, 0);
});

test('subscribeReady: a batch already waiting is hinted once; unsubscribe and stop suppress it', async () => {
  const album = [photoUpdate(946001, 901, 'r'), photoUpdate(946002, 902, 'r')];
  const r = rig(60, () => album);
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    let hits = 0;
    const off = onReady({ ...r.context, channel: r.context.channel }, () => { hits++; });
    await sleep(0); await sleep(0);
    assert.equal(hits, 1);
    off();
    let gone = 0;
    onReady(r.context, () => { gone++; })();
    await sleep(5);
    assert.equal(gone, 0);
    let late = 0;
    onReady(r.context, () => { late++; });
    await stop(r.context);
    await sleep(5);
    assert.equal(late, 0);
  } finally { r.done(); }
});
