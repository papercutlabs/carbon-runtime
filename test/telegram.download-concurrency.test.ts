// PA-241: bounded eager attachment downloads during album settlement, through the
// real worker, real capture path and the default wiring (no switch exists). Delays
// come from a controlled fake Bot API: they prove ordering and overlap, they are
// SIMULATED fixture time and say nothing about Telegram speed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { arrivals, forget, stop, DOWNLOAD_CHAINS } from '../adapters/telegram/live.ts';
import { nextOffset } from '../adapters/telegram/cursors.ts';
import * as adapter from '../adapters/telegram/index.ts';
import { captureBatch, idsOf, liveContext, photoUpdate, scriptedServerOf, waitForBatch, sleep, TOKEN } from './telegram-fixtures.ts';

afterEach(() => { forget(); });

type Line = Record<string, unknown>;

// Per-file delays plus live and peak counts of chains in flight (getFile begun, body not yet returned).
function delayed(delays: Record<string, number>, failFiles: string[] = []) {
  const inner = globalThis.fetch;
  let live = 0; let peak = 0; let getFiles = 0;
  const bodyStarts: string[] = [];
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    const isFile = url.includes('/getFile');
    const isBody = url.includes('/file/bot');
    if (!isFile && !isBody) return inner(url, options);
    const id = isFile ? JSON.parse(options.body as string).file_id : /files\/(file-[^/]+)\.jpg/.exec(url)![1];
    if (isFile) { live++; getFiles++; peak = Math.max(peak, live); }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delays[id] ?? 5);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      if (isFile && failFiles.includes(id)) throw new Error('getFile refused');
      if (isBody) bodyStarts.push(id);
      return await inner(url, options);
    } finally { if (isBody || (isFile && failFiles.includes(id))) live--; }
  }) as typeof fetch;
  return { get peak() { return peak; }, get getFiles() { return getFiles; }, bodyStarts, restore: () => { globalThis.fetch = inner; } };
}

function setup(opts: { album: number; delays?: Record<string, number>; fail?: string[]; script?: (n: number) => ReturnType<typeof photoUpdate>[]; quiet?: number; base?: number }) {
  forget();
  const lines: Line[] = [];
  const base = opts.base ?? 930001;
  const context = { ...liveContext('carbon-telegram-dl-', { album_quiet_ms: opts.quiet ?? 150, max_attachment_bytes: 1000 }), log: (l: Line) => { lines.push(l); } };
  const album = Array.from({ length: opts.album }, (_, i) => photoUpdate(base + i, 401 + i, 'dl-album'));
  const server = scriptedServerOf({ respond: ({ call }) => (opts.script ? opts.script(call) : album) });
  const wrap = delayed(opts.delays ?? {}, opts.fail);
  return { context, album, server, wrap, lines, done: () => { wrap.restore(); server.restore(); } };
}
const latency = (lines: Line[], stage?: string) => lines.filter((l) => l.event === 'latency_experiment' && (stage === undefined || l.stage === stage));

test('default wiring: downloads overlap up to the bound, begin inside the album window, keep order, capture and cursor', async () => {
  const delays = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`file-${401 + i}`, 120 - i * 10]));
  const r = setup({ album: 8, delays, quiet: 300 });
  try {
    await arrivals(r.context);
    const { items } = await waitForBatch(r.context);
    assert.equal(DOWNLOAD_CHAINS, 4);
    assert.deepEqual(idsOf(items), r.album.map((u) => u.update_id));
    assert.equal(r.wrap.peak, 4, 'overlap should reach the bound and never pass it');
    assert.notDeepEqual(r.wrap.bodyStarts, r.album.map((_, i) => `file-${401 + i}`), 'completion order was not shuffled, so order proved nothing');
    assert.ok(items.every((i) => (i.attachments as { bytes: Buffer }[])[0].bytes.length === 3));
    const firstGetFile = Math.min(...r.server.media.map((m) => m.at));
    const lastAsk = r.server.asked.at(-1)!.at;
    assert.ok(firstGetFile < lastAsk, 'no download began before the last same-offset ask (not eager)');
    const pending = captureBatch(r.context, items);
    assert.equal(nextOffset(r.context.store, r.context.account), null);
    for (const item of pending) adapter.consume({ ...r.context, items }, item);
    assert.equal(nextOffset(r.context.store, r.context.account), 930009);
  } finally { r.done(); }
});

test('slow downloads do not hold the album window open: settlement is recorded before the fetches end', async () => {
  const r = setup({ album: 3, delays: { 'file-401': 700, 'file-402': 700, 'file-403': 700 }, quiet: 200 });
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    const [collection] = latency(r.lines, 'collection');
    const downloads = latency(r.lines, 'download');
    const window = (collection.ended_monotonic_ms as number) - (collection.started_monotonic_ms as number);
    assert.ok(window < 600, `collection took ${window} ms, fetches took 700`);
    assert.ok(downloads.every((d) => (d.ended_monotonic_ms as number) > (collection.ended_monotonic_ms as number)));
    assert.ok(downloads.every((d) => (d.started_monotonic_ms as number) < (collection.ended_monotonic_ms as number)), 'downloads were not eager');
  } finally { r.done(); }
});

test('split, shrinking and late members: each fetched once, album whole, never more than four in flight', async () => {
  const album = Array.from({ length: 6 }, (_, i) => photoUpdate(932001 + i, 421 + i, 'split'));
  const script = [album.slice(0, 2), album.slice(2, 4), [album[5], album[4]], [album[1]]];
  const r = setup({ album: 6, script: (n) => script[n - 1] ?? [], delays: Object.fromEntries(album.map((_, i) => [`file-${421 + i}`, 80])) });
  try {
    await arrivals(r.context);
    const { items } = await waitForBatch(r.context);
    assert.deepEqual(idsOf(items), album.map((u) => u.update_id));
    assert.deepEqual([...new Set(r.server.fetched.values())], [1]);
    assert.equal(r.server.fetched.size, 6);
    assert.ok(r.wrap.peak <= 4);
    assert.ok(items.every((i) => (i.attachments as unknown[]).length === 1));
  } finally { r.done(); }
});

test('failed and oversize media degrade per item; neighbours unaffected; oversize never fetched', async () => {
  const r = setup({ album: 4, fail: ['file-402'] });
  (r.album[2].message.photo[0] as { file_size: number }).file_size = 5000;
  try {
    await arrivals(r.context);
    const { items } = await waitForBatch(r.context);
    assert.deepEqual(items.map((i) => i.attachments !== undefined), [true, false, false, true]);
    assert.equal(r.server.fetched.has('file-403'), false);
    const downloads = latency(r.lines, 'download');
    assert.deepEqual(downloads.map((l) => l.status).sort(), ['failed', 'ok', 'ok']);
  } finally { r.done(); }
});

test('repeated updates and later polls reuse the cache: one fetch each, no repeated timing lines', async () => {
  const r = setup({ album: 3 });
  try {
    await arrivals(r.context);
    const first = await waitForBatch(r.context);
    const before = r.lines.length;
    for (let i = 0; i < 5; i++) assert.deepEqual(idsOf(await arrivals(r.context)), idsOf(first.items));
    await sleep(100);
    assert.equal(r.lines.length, before, 'cached polls logged');
    assert.deepEqual([...new Set(r.server.fetched.values())], [1]);
  } finally { r.done(); }
});

test('timing records are readable log lines: schema, stages, monotonic order, bounded ids, nothing sensitive', async () => {
  const r = setup({ album: 12, quiet: 150 });
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    const stages = new Set(latency(r.lines).map((l) => l.stage));
    assert.deepEqual([...stages].sort(), ['album-member-sighted', 'batch-ready', 'collection', 'download']);
    for (const l of latency(r.lines)) {
      assert.equal(l.schema, 'carbon.latency-experiment.v1');
      assert.ok((l.ended_monotonic_ms as number) >= (l.started_monotonic_ms as number));
      assert.ok((l.source_ids as unknown[]).length <= 8);
      assert.ok(['ok', 'failed', 'cancelled'].includes(l.status as string));
    }
    assert.equal(latency(r.lines, 'collection').length, 1);
    assert.equal(latency(r.lines, 'collection')[0].source_count, 12);
    assert.equal(latency(r.lines, 'download').length, 12);
    assert.equal(latency(r.lines, 'album-member-sighted').length, 12);
    const text = JSON.stringify(r.lines);
    assert.ok(!text.includes(TOKEN) && !text.includes('files/') && !text.includes('/file/bot'));
  } finally { r.done(); }
});

test('stop during fetch: queued downloads never start, stop returns promptly', async () => {
  const r = setup({ album: 8, delays: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`file-${401 + i}`, 400])), quiet: 100 });
  try {
    await arrivals(r.context);
    await sleep(250);
    assert.equal(r.wrap.getFiles, 4);
    const began = Date.now();
    await stop(r.context);
    assert.ok(Date.now() - began < 300, 'stop waited out the fetches');
    await sleep(600);
    assert.equal(r.wrap.getFiles, 4, 'a queued download started after stop');
    assert.ok(latency(r.lines, 'download').every((l) => l.status === 'cancelled'));
  } finally { r.done(); }
});

test('restart with unconsumed inputs: the same whole batch is rebuilt, cursor untouched', async () => {
  const r = setup({ album: 3 });
  try {
    await arrivals(r.context);
    const first = await waitForBatch(r.context);
    forget();
    assert.equal(nextOffset(r.context.store, r.context.account), null);
    await arrivals(r.context);
    const again = await waitForBatch(r.context);
    assert.deepEqual(idsOf(again.items), idsOf(first.items));
    assert.ok(again.items.every((i) => i.attachments !== undefined));
  } finally { r.done(); }
});

test('guard: the bound is real (a wider burst than four would fail the peak check)', async () => {
  const r = setup({ album: 10, delays: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`file-${401 + i}`, 60])) });
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    assert.equal(r.wrap.peak, DOWNLOAD_CHAINS);
  } finally { r.done(); }
});
