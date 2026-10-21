// PA-241 handoff experiment: an adapter's readiness hint wakes the runtime's own
// sweep. Real run(), real store, real Telegram adapter and worker; the Bot API and
// harness are controlled fakes, so every timing here is SIMULATED fixture time,
// not Telegram performance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../runtime/index.ts';
import { EXIT } from '../runtime/faults.ts';
import { Store } from '../stream/store.ts';
import { fakeHarness } from './fake-harness.ts';
import { answer, placed, telegramDeclarationFor } from './fixtures/drain-runner.ts';
import * as fixture from '../adapters/fixture/index.ts';
import * as telegram from '../adapters/telegram/index.ts';
import { forget } from '../adapters/telegram/live.ts';
import { TOKEN, sleep, update, photoUpdate } from './telegram-fixtures.ts';

const INTERVAL = 3000;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-ready-')); }
const stopRun = () => process.emit('SIGTERM', 'SIGTERM');

// Bot API that hands one text message out once, `after` ms from now, then nothing.
function botApi(after: number) {
  const previous = globalThis.fetch;
  const began = Date.now();
  const marks = { available: 0 };
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/sendChatAction')) return { status: 200, json: async () => ({ ok: true, result: true }) };
    if (url.includes('/sendMessage')) {
      const { chat_id, text } = JSON.parse(options.body as string);
      return { status: 200, json: async () => ({ ok: true, result: { message_id: 900, date: 1789034401, chat: { id: chat_id, type: 'private' }, text } }) };
    }
    if (!url.includes('/getUpdates')) throw new Error(`unexpected fake request ${url}`);
    const { offset } = JSON.parse(options.body as string);
    await sleep(15);
    const due = Date.now() - began >= after;
    const result = due && (offset === undefined || offset <= 700001) ? [update(700001, 11, 'hello')] : [];
    if (result.length && !marks.available) marks.available = Date.now();
    return { status: 200, json: async () => ({ ok: true, result }) };
  }) as unknown as typeof fetch;
  return { marks, restore: () => { globalThis.fetch = previous; } };
}

async function telegramRun(hinted: boolean) {
  forget();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'bot-token'), TOKEN, { mode: 0o600 });
  const api = botApi(400);
  const declared = telegramDeclarationFor(path.join(dir, 'bot-token'));
  const channel = declared.channels[0];
  const where = placed(dir, INTERVAL, {
    ...declared,
    channels: [{ ...channel, poll_interval_ms: INTERVAL, transport: { ...channel.transport, long_poll_timeout_s: 0 } }]
  } as never);
  const { subscribeReady, ...rest } = telegram as Record<string, unknown>;
  const adapter = hinted ? telegram : { ...rest };
  let started = 0;
  const harness = fakeHarness({
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }],
    onTurn: async (_s, params) => {
      started = Date.now();
      answer(where.storeDir, params.clientUserMessageId);
      return 'completed';
    }
  });
  const watcher = setInterval(() => { if (started) { clearInterval(watcher); setTimeout(stopRun, 200); } }, 20);
  try {
    const code = await run({ ...where, adapters: { fixture, telegram: adapter }, replyPort: 20000 + Math.floor(Math.random() * 20000), harness, log: () => {} });
    assert.equal(code, EXIT.OK);
    const records = Store.open(where.storeDir).rebuild();
    return { turns: harness.session.turns.length, latency: started - api.marks.available, outbound: records.filter((r) => r.direction === 'outbound').map((r) => r.delivery?.status), inbound: records.filter((r) => r.direction === 'inbound').length };
  } finally { api.restore(); forget(); }
}

test('SIMULATED: ready hint starts the ordinary Telegram message turn without waiting out the interval; fallback still gets there', async () => {
  const hinted = await telegramRun(true);
  const polled = await telegramRun(false);
  console.log(`SIMULATED timings (controlled fixture, interval ${INTERVAL} ms): message available -> turn start hinted ${hinted.latency} ms, polling fallback ${polled.latency} ms`);
  for (const r of [hinted, polled]) {
    assert.equal(r.turns, 1);
    assert.equal(r.inbound, 1);
    assert.deepEqual(r.outbound, ['sent']);
  }
  assert.ok(hinted.latency < 1500, `hinted latency ${hinted.latency}`);
  assert.ok(polled.latency > 1500, `fallback latency ${polled.latency}`);
});

// A fixture-channel adapter that counts passes and exposes the listener.
function probe() {
  const state = { polls: 0, running: 0, maxRunning: 0, listeners: new Set<() => void>(), subscribed: 0, unsubscribed: 0, onPoll: null as null | (() => void) };
  const adapter = {
    ...fixture,
    async poll() {
      state.polls += 1; state.running += 1; state.maxRunning = Math.max(state.maxRunning, state.running);
      state.onPoll?.();
      await sleep(30);
      state.running -= 1;
      return { items: [] };
    },
    subscribeReady(_context: unknown, listener: () => void) {
      state.subscribed += 1; state.listeners.add(listener);
      return () => { state.unsubscribed += 1; state.listeners.delete(listener); };
    }
  };
  return { state, adapter };
}

async function withProbe(body: (state: ReturnType<typeof probe>['state'], finish: () => Promise<number>) => Promise<void>) {
  const dir = tmp();
  const { state, adapter } = probe();
  const where = placed(dir, INTERVAL);
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  const running = run({ ...where, adapters: { fixture: adapter }, replyPort: 20000 + Math.floor(Math.random() * 20000), harness, log: () => {} });
  await body(state, async () => { stopRun(); return running; });
  return state;
}

test('idle: no hint means no extra passes; hints are lost-wakeup safe, duplicate-safe, never overlap, and stop unsubscribes', async () => {
  const state = await withProbe(async (s, finish) => {
    await sleep(300);
    assert.equal(s.polls, 1, 'idle runtime polled again before its interval');
    assert.equal(s.subscribed, 1);

    // Lost wakeup: the hint arrives while a pass is running.
    s.onPoll = () => { s.onPoll = null; setTimeout(() => [...s.listeners].forEach((l) => l()), 5); };
    [...s.listeners].forEach((l) => l());
    await sleep(300);
    // one pass for the first hint, one more because a hint landed during it
    assert.equal(s.polls, 3, `polls ${s.polls}`);

    // Duplicates: a burst yields bounded passes and never two at once.
    const before = s.polls;
    for (let i = 0; i < 20; i++) [...s.listeners].forEach((l) => l());
    await sleep(300);
    assert.ok(s.polls - before >= 1 && s.polls - before <= 2, `burst made ${s.polls - before} passes`);
    assert.equal(s.maxRunning, 1);

    // Back to idle afterwards.
    const settled = s.polls;
    await sleep(300);
    assert.equal(s.polls, settled);

    const code = await finish();
    assert.equal(code, EXIT.OK);
  });
  assert.equal(state.unsubscribed, 1);
  assert.equal(state.listeners.size, 0);
  assert.doesNotThrow(() => [...state.listeners].forEach((l) => l()));
});

test('a hint that arrives after stop starts no pass', async () => {
  let late: (() => void) | null = null;
  const state = await withProbe(async (s, finish) => {
    await sleep(100);
    late = [...s.listeners][0];
    await finish();
  });
  const polls = state.polls;
  late!();
  await sleep(150);
  assert.equal(state.polls, polls);
});

// Real run(), real Telegram adapter, album of three photos with SIMULATED 80 ms
// downloads: eager downloads and the readiness hint together, one release.
test('SIMULATED: album with eager downloads and ready hint releases once, in order, and logs timing records', async () => {
  forget();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'bot-token'), TOKEN, { mode: 0o600 });
  const previous = globalThis.fetch;
  const album = [0, 1, 2].map((i) => photoUpdate(710001 + i, 21 + i, 'grp'));
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    const ok = (result: unknown) => ({ status: 200, ok: true, json: async () => ({ ok: true, result }), arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
    if (url.includes('/sendChatAction')) return ok(true);
    if (url.includes('/sendMessage')) {
      const { chat_id, text } = JSON.parse(options.body as string);
      return ok({ message_id: 900, date: 1789034401, chat: { id: chat_id, type: 'private' }, text });
    }
    if (url.includes('/getFile')) { await sleep(80); return ok({ file_path: `files/${JSON.parse(options.body as string).file_id}.jpg` }); }
    if (url.includes('/file/bot')) { await sleep(80); return ok(null); }
    if (!url.includes('/getUpdates')) throw new Error(`unexpected fake request ${url}`);
    await sleep(15);
    const { offset } = JSON.parse(options.body as string);
    return ok(album.filter((u) => offset === undefined || u.update_id >= offset));
  }) as unknown as typeof fetch;
  const declared = telegramDeclarationFor(path.join(dir, 'bot-token'));
  const channel = declared.channels[0];
  const where = placed(dir, INTERVAL, {
    ...declared,
    channels: [{ ...channel, poll_interval_ms: INTERVAL, album_quiet_ms: 200, max_attachment_bytes: 1000, transport: { ...channel.transport, long_poll_timeout_s: 0 } }]
  } as never);
  let started = 0;
  const lines: Record<string, unknown>[] = [];
  const harness = fakeHarness({
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }],
    onTurn: async (_s, params) => { started = Date.now(); answer(where.storeDir, params.clientUserMessageId); return 'completed'; }
  });
  const watcher = setInterval(() => { if (started) { clearInterval(watcher); setTimeout(stopRun, 200); } }, 20);
  try {
    const code = await run({ ...where, adapters: { fixture, telegram }, replyPort: 20000 + Math.floor(Math.random() * 20000), harness, log: (l) => { lines.push(l); } });
    assert.equal(code, EXIT.OK);
    const records = Store.open(where.storeDir).rebuild();
    const inbound = records.filter((r) => r.direction === 'inbound');
    assert.equal(harness.session.turns.length, 1);
    assert.deepEqual(inbound.map((r) => r.platform_message_id ?? r.message_id).length, 3);
    assert.deepEqual(records.filter((r) => r.direction === 'outbound').map((r) => r.delivery?.status), ['sent']);
    const mine = lines.filter((l) => l.event === 'latency_experiment');
    assert.deepEqual([...new Set(mine.map((l) => l.stage))].sort(), ['album-member-sighted', 'batch-ready', 'capture-admission', 'collection', 'download']);
    assert.equal(mine.filter((l) => l.stage === 'download').length, 3);
    assert.ok(started > 0 && Date.now() - started < INTERVAL);
    // hint woke the sweep: the turn began well inside the 3000 ms interval of a single poll
  } finally { globalThis.fetch = previous; forget(); }
});
