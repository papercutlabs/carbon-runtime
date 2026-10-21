// PA-241: byte limits enforced while a body streams, expiry at settlement, stop and
// forget draining eager fetches, and permanent oversize leaving the budget.
// Timings are SIMULATED fixture time.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { arrivals, forget, stop, speculativeState } from '../adapters/telegram/live.ts';
import { download, TelegramFault } from '../adapters/telegram/api.ts';
import { liveContext, photoUpdate, waitForBatch, sleep } from './telegram-fixtures.ts';

afterEach(() => { forget(); });
type Line = Record<string, unknown>;

// A server whose bodies are streams that honour abort, so what stop() waits for is observable.
function server(opts: { respond: () => ReturnType<typeof photoUpdate>[]; chunks?: number; chunkBytes?: number; chunkDelay?: number; fileSize?: (id: string) => number | undefined; contentLength?: number; pollDelay?: (call: number) => number; ignoreAbort?: boolean }) {
  const previous = globalThis.fetch;
  let polls = 0;
  const st = { started: 0, settled: 0, aborted: 0, pulled: 0, cancelled: 0, bodies: new Map<string, number>() };
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/getUpdates')) { await sleep(opts.pollDelay?.(++polls) ?? 5); return { status: 200, json: async () => ({ ok: true, result: opts.respond() }) }; }
    if (url.includes('/getFile')) {
      const { file_id } = JSON.parse(options.body as string);
      return { status: 200, json: async () => ({ ok: true, result: { file_path: `files/${file_id}.jpg`, file_size: opts.fileSize?.(file_id) } }) };
    }
    const id = /files\/(file-[^/]+)\.jpg/.exec(url)?.[1] ?? '?';
    st.started++; st.bodies.set(id, (st.bodies.get(id) ?? 0) + 1);
    const signal = options.signal as AbortSignal;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal.aborted && !opts.ignoreAbort) { st.aborted++; st.settled++; controller.error(new Error('aborted')); return; }
        if (sent >= (opts.chunks ?? 1)) { st.settled++; controller.close(); return; }
        await sleep(opts.chunkDelay ?? 0);
        if (signal.aborted && !opts.ignoreAbort) { st.aborted++; st.settled++; controller.error(new Error('aborted')); return; }
        sent++; st.pulled++;
        controller.enqueue(new Uint8Array(opts.chunkBytes ?? 3));
      },
      cancel() { st.cancelled++; st.settled++; }
    }, { highWaterMark: 0 });
    return { ok: true, status: 200, headers: new Headers(opts.contentLength === undefined ? {} : { 'content-length': String(opts.contentLength) }), body };
  }) as unknown as typeof fetch;
  return { st, restore: () => { globalThis.fetch = previous; } };
}
const transport = { token: '123:abc', apiHost: 'example.test' };
function respondWith(fake: (url: string, o: RequestInit) => unknown) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, o: RequestInit = {}) => fake(url, o)) as unknown as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

test('download: Content-Length over the limit is refused before the body is read', async () => {
  let pulled = 0;
  const restore = respondWith(() => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '5000' }),
    body: new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); } }, { highWaterMark: 0 }) }));
  try {
    await assert.rejects(download(transport, 'f', { maxBytes: 1000 }), (e) => e instanceof TelegramFault && e.faults[0].code === 'ATTACHMENT_TOO_LARGE');
    assert.equal(pulled, 0);
  } finally { restore(); }
});

test('download: a stream with no or understated length is cancelled once the running count passes the limit', async () => {
  let pulled = 0; let cancelled = false;
  const restore = respondWith(() => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '10' }),
    body: new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(400)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }) }));
  try {
    await assert.rejects(download(transport, 'f', { maxBytes: 1000 }), (e) => e instanceof TelegramFault && e.faults[0].code === 'ATTACHMENT_TOO_LARGE');
    assert.equal(cancelled, true);
    assert.ok(pulled <= 4, `pulled ${pulled} chunks of an endless body`);
  } finally { restore(); }
});

test('download: a body within the limit is returned whole', async () => {
  const restore = respondWith(() => ({ ok: true, status: 200, headers: new Headers(),
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }) }));
  try { assert.deepEqual([...await download(transport, 'f', { maxBytes: 3 })], [1, 2, 3]); } finally { restore(); }
});

test('live: understated metadata with an endless body is cut at the limit, not buffered; the member is not attached', async () => {
  const album = Array.from({ length: 8 }, (_, i) => { const u = photoUpdate(950001 + i, 1001 + i, 'm'); (u.message.photo[0] as { file_size: number }).file_size = 10; return u; });
  const s = server({ respond: () => album, chunks: 1000, chunkBytes: 400 });
  const context = liveContext('carbon-telegram-limit-', { album_quiet_ms: 60, max_attachment_bytes: 1000 });
  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.ok(items.every((i) => i.attachments === undefined));
    assert.ok(s.st.cancelled >= 8, `cancelled ${s.st.cancelled}`);
    assert.ok(s.st.pulled <= 8 * 4, `pulled ${s.st.pulled} chunks`);
  } finally { await stop(context); s.restore(); }
});

test('live: getFile size over the limit never requests a body, and is not asked again', async () => {
  const album = [photoUpdate(951001, 1101, 'g'), photoUpdate(951002, 1102, 'g')];
  const s = server({ respond: () => album, fileSize: (id) => (id === 'file-1102' ? 5000 : 3) });
  const context = liveContext('carbon-telegram-limit-', { album_quiet_ms: 60, max_attachment_bytes: 1000 });
  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(items.map((i) => i.attachments !== undefined), [true, false]);
    assert.equal(s.st.bodies.get('file-1102'), undefined);
  } finally { await stop(context); s.restore(); }
});

test('stop(): resolves only after every eager fetch has settled, and nothing is cached after it', async () => {
  const album = Array.from({ length: 10 }, (_, i) => photoUpdate(952001 + i, 1201 + i, 's'));
  const s = server({ respond: () => album, chunks: 50, chunkDelay: 20 });
  const lines: Line[] = [];
  const context = { ...liveContext('carbon-telegram-limit-', { album_quiet_ms: 400, max_attachment_bytes: 1000 }), log: (l: Line) => { lines.push(l); } };
  try {
    await arrivals(context);
    await sleep(120);
    assert.ok(s.st.started >= 4 && s.st.started > s.st.settled, 'guard: bodies are in flight');
    await stop(context);
    assert.equal(s.st.settled, s.st.started, 'stop resolved with a fetch still running');
    assert.ok(s.st.aborted + s.st.cancelled > 0, 'guard: the fetches were aborted, not finished');
    const n = lines.length; const started = s.st.started;
    await sleep(100);
    assert.equal(s.st.started, started);
    assert.equal(lines.length, n);
    assert.ok(lines.filter((l) => l.stage !== 'album-member-sighted').every((l) => l.status !== 'ok'), 'a body completed and was recorded after the abort');
  } finally { s.restore(); }
});

test('forget(): stays synchronous and the aborted fetches still drain on their own', async () => {
  const album = Array.from({ length: 6 }, (_, i) => photoUpdate(953001 + i, 1301 + i, 'f'));
  const s = server({ respond: () => album, chunks: 50, chunkDelay: 20 });
  const context = liveContext('carbon-telegram-limit-', { album_quiet_ms: 400, max_attachment_bytes: 1000 });
  try {
    await arrivals(context);
    await sleep(100);
    assert.ok(s.st.started > s.st.settled, 'guard: bodies are in flight');
    assert.equal(forget(), undefined);
    await sleep(150);
    assert.equal(s.st.settled, s.st.started);
  } finally { s.restore(); }
});

test('expiry does not discard a good member on the iteration that settles the album', async () => {
  // quiet 30 ms: expiry is 600 ms. The second ask takes 700 ms, so the member is past
  // expiry exactly when the album settles.
  const album = [photoUpdate(954001, 1401, 'e'), photoUpdate(954002, 1402, 'e')];
  const s = server({ respond: () => album, chunks: 2, chunkDelay: 5, pollDelay: (n) => (n === 2 ? 700 : 5) });
  const context = liveContext('carbon-telegram-limit-', { album_quiet_ms: 30, max_attachment_bytes: 1000 });
  try {
    await arrivals(context);
    const { items } = await waitForBatch(context, { attempts: 600 });
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.attachments !== undefined));
    assert.deepEqual([s.st.bodies.get('file-1401'), s.st.bodies.get('file-1402')], [1, 1], 'a member was fetched again');
  } finally { await stop(context); s.restore(); }
});

test('permanent oversize leaves the budget at once and is not fetched again at expiry', async () => {
  const album = [photoUpdate(955001, 1501, 'x')];
  const s = server({ respond: () => album, chunks: 100, chunkBytes: 200 });
  const lines: Line[] = [];
  const context = { ...liveContext('carbon-telegram-limit-', { album_quiet_ms: 5, max_attachment_bytes: 1000 }), log: (l: Line) => { lines.push(l); } };
  try {
    await arrivals(context);
    await sleep(60);
    await arrivals(context);
    await sleep(300); // well past 20 x quiet
    for (let i = 0; i < 3; i++) await arrivals(context);
    assert.equal(s.st.bodies.get('file-1501'), 1, 'an oversize member was downloaded again');
    assert.ok(lines.some((l) => l.stage === 'download' && l.status === 'oversize'));
  } finally { await stop(context); s.restore(); }
});

test('a body that finishes after stop() is recorded as cancelled, not kept', async () => {
  const album = [photoUpdate(956001, 1601, 'z'), photoUpdate(956002, 1602, 'z')];
  const s = server({ respond: () => album, chunks: 10, chunkDelay: 20, ignoreAbort: true });
  const lines: Line[] = [];
  const context = { ...liveContext('carbon-telegram-limit-', { album_quiet_ms: 400, max_attachment_bytes: 1000 }), log: (l: Line) => { lines.push(l); } };
  try {
    await arrivals(context);
    await sleep(80);
    assert.ok(s.st.started > s.st.settled, 'guard: bodies are in flight');
    await stop(context);
    assert.equal(s.st.settled, s.st.started);
    const downloads = lines.filter((l) => l.stage === 'download');
    assert.ok(downloads.length > 0 && downloads.every((l) => l.status === 'cancelled'), JSON.stringify(downloads.map((l) => l.status)));
  } finally { s.restore(); }
});

test('oversize before settlement releases its reserved budget at once', async () => {
  const album = [photoUpdate(957001, 1701, 'q')];
  const s = server({ respond: () => album, chunks: 100, chunkBytes: 200 });
  const context = liveContext('carbon-telegram-limit-', { album_quiet_ms: 2000, max_attachment_bytes: 1000 });
  try {
    await arrivals(context);
    await sleep(150);
    assert.equal(s.st.bodies.get('file-1701'), 1, 'guard: the body was fetched');
    assert.deepEqual(speculativeState(context), { members: 0, bytes: 0 });
  } finally { await stop(context); s.restore(); }
});
