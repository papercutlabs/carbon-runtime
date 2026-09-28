// Assertions on fixture-only fault shapes and nonempty test results preserve
// the original failure assertions; they add no fallback for a missing result.
// Fetch replacements implement only the response methods exercised below; the
// installation assertions retain these deliberately partial synthetic responses.
import type { ArrivedItem, Fields } from '../adapters/telegram/types.ts';
import type { SyntheticUpdate } from './telegram-fixtures.ts';
// The Bot API half: the token, what is said about a failure, and the one rule
// that makes a long poll durable.
//
// Nothing here reaches a network. `fetch` is replaced for the length of a test
// and put back after, which is what lets the offset discipline be proved rather
// than described: the worker is run against a server that records what it was
// asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import { botIdOf, call, readToken, scrub, TelegramFault } from '../adapters/telegram/api.ts';
import { ALBUM_QUIET_MS, arrivals, forget, IDLE_MS, transportFor } from '../adapters/telegram/live.ts';
import { nextOffset } from '../adapters/telegram/cursors.ts';
import * as adapter from '../adapters/telegram/index.ts';
import { photoUpdate, sleep, TOKEN, tokenFile, update, waitForBatch } from './telegram-fixtures.ts';

// ---- the token ---------------------------------------------------------------

test('a token is read from its file at the moment it is used, and trailing whitespace is not part of it', () => {
  const file = tokenFile(`${TOKEN}\n`);
  assert.equal(readToken(file), TOKEN);
  assert.equal(botIdOf(TOKEN), 7000001);
});

test('a file that is not a token is refused by name, before the first call', () => {
  assert.throws(() => readToken(tokenFile('bot_token: "7000001:AAH"\n')),
    // These token refusal paths emit TelegramFaults; the predicates inspect the first emitted fault.
    (error) => (error as TelegramFault).faults[0].code === 'BOT_TOKEN_MALFORMED');
  assert.throws(() => readToken('/no/such/token/file'),
    (error) => (error as TelegramFault).faults[0].code === 'CHANNEL_TOKEN_UNREADABLE');
  assert.throws(() => readToken(undefined),
    (error) => (error as TelegramFault).faults[0].code === 'CHANNEL_TOKEN_PATH_ABSENT');
});

test('the token never reaches a fault, whatever the server or the network said about it', async () => {
  const previous = globalThis.fetch;
  // The fetch stub throws for every request to exercise the unreachable Bot API fault.
  globalThis.fetch = (async (url: string) => { throw new Error(`connect ECONNREFUSED at ${url}`); }) as typeof fetch;
  try {
    await assert.rejects(() => call({ token: TOKEN }, 'getMe'), (error) => {
      const said = JSON.stringify((error as TelegramFault).faults);
      assert.ok(!said.includes(TOKEN), 'the token is in the fault');
      assert.ok(said.includes('<bot token>'), 'the url was not scrubbed');
      return (error as TelegramFault).faults[0].code === 'BOT_API_UNREACHABLE';
    });
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(scrub(`https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN),
    'https://api.telegram.org/bot<bot token>/getMe');
});

test('a refusal carries the server\'s own code, so a revoked token is not read as a busy server', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 401,
    json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' })
  // This scripted fetch supplies only the response fields read by the Bot API call.
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(() => call({ token: TOKEN }, 'getMe'), (error) => {
      assert.ok(error instanceof TelegramFault);
      assert.equal(error.errorCode, 401);
      assert.equal((error as TelegramFault).faults[0].code, 'BOT_API_REFUSED');
      return true;
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test('the transport is built from the channel, and the token is not a field on it', () => {
  const file = tokenFile();
  const transport = transportFor({ channel: { bot_token: file } });
  assert.equal(transport.token, TOKEN);
  assert.equal(transport.apiHost, 'api.telegram.org');
  assert.equal(transportFor({ channel: { bot_token: file, api_host: 'bot-api.example.test' } }).apiHost,
    'bot-api.example.test');
});

// ---- the offset discipline ----------------------------------------------------

// The Bot API deletes an update when the next getUpdates asks past it, and there
// is no second delivery. So the worker must not ask for a higher offset until the
// record is on disk and consumed. This runs the worker against a recording
// server and reads back what it asked for.
function serverOf(batches: SyntheticUpdate[][]) {
  const asked: (number | null)[] = [];
  let at = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    // The fetch stub receives the Bot API JSON request body generated by this adapter.
    const params = JSON.parse(options.body as string);
    asked.push(params.offset ?? null);
    const batch = at < batches.length ? batches[at++] : [];
    return { status: 200, json: async () => ({ ok: true, result: batch }) };
  }) as unknown as typeof fetch;
  return { asked, restore: () => { globalThis.fetch = previous; } };
}

function albumServerOf({ failAt = null }: { failAt?: number | null } = {}) {
  const updates = [photoUpdate(900001, 101), photoUpdate(900002, 102), photoUpdate(900003, 103)];
  const asked: { offset: number | null; timeout: number }[] = [];
  const fetched = new Map<string, number>();
  const previous = globalThis.fetch;
  let updateCalls = 0;
  let thirdCallAt: number | null = null;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/getUpdates')) {
      updateCalls += 1;
      // The scripted getUpdates request has a JSON body read by this fetch stub.
      const params = JSON.parse(options.body as string);
      asked.push({ offset: params.offset ?? null, timeout: params.timeout });
      if (updateCalls === 3) thirdCallAt = Date.now();
      if (updateCalls === failAt) throw new Error('the fake server dropped the repeat ask');
      const arrived = updateCalls === 1 ? updates.slice(0, 2) : updates;
      const result = arrived.filter((one) => params.offset === undefined || one.update_id >= params.offset);
      if (result.length === 0) await sleep(10);
      return {
        status: 200,
        json: async () => ({ ok: true, result })
      };
    }
    if (url.includes('/getFile')) {
      // The scripted getFile request has a JSON body read by this fetch stub.
      const { file_id } = JSON.parse(options.body as string);
      fetched.set(file_id, (fetched.get(file_id) ?? 0) + 1);
      return { status: 200, json: async () => ({ ok: true, result: { file_path: `files/${file_id}.jpg` } }) };
    }
    if (url.includes('/file/bot')) {
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    }
    throw new Error(`unexpected fake request ${url}`);
  // This fetch replacement implements only requests exercised by the album tests.
  }) as unknown as typeof fetch;
  return {
    asked,
    fetched,
    thirdCallAt: () => thirdCallAt,
    restore: () => { globalThis.fetch = previous; }
  };
}

function timedAlbumServerOf({
  tailAfterMs, firstGetFileDelayMs = 0, firstBodyDelayMs = 0, count = 6
}: { tailAfterMs: number; firstGetFileDelayMs?: number; firstBodyDelayMs?: number; count?: number }) {
  const updates = Array.from({ length: count }, (_, index) =>
    photoUpdate(910001 + index, 201 + index, 'timed-album'));
  const asked: { at_ms: number; offset: number | null; count: number }[] = [];
  const fetched = new Map<string, number>();
  const media: { stage: string; file_id: string; began_ms: number; ended_ms: number }[] = [];
  const started = Date.now();
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/getUpdates')) {
      // The scripted getUpdates request has a JSON body read by this fetch stub.
      const params = JSON.parse(options.body as string);
      const elapsed = Date.now() - started;
      const arrived = elapsed < tailAfterMs ? updates.slice(0, 1) : updates;
      const result = arrived.filter((one) => params.offset === undefined || one.update_id >= params.offset);
      asked.push({ at_ms: elapsed, offset: params.offset ?? null, count: result.length });
      if (result.length === 0) await sleep(10);
      return { status: 200, json: async () => ({ ok: true, result }) };
    }
    if (url.includes('/getFile')) {
      // The scripted getFile request has a JSON body read by this fetch stub.
      const { file_id } = JSON.parse(options.body as string);
      const began = Date.now() - started;
      if (file_id === 'file-201' && firstGetFileDelayMs > 0) await sleep(firstGetFileDelayMs);
      media.push({ stage: 'getFile', file_id, began_ms: began, ended_ms: Date.now() - started });
      fetched.set(file_id, (fetched.get(file_id) ?? 0) + 1);
      return { status: 200, json: async () => ({ ok: true, result: { file_path: `files/${file_id}.jpg` } }) };
    }
    if (url.includes('/file/bot')) {
      const file_id = /files\/(file-\d+)\.jpg/.exec(url)?.[1] ?? 'unknown';
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const began = Date.now() - started;
          if (file_id === 'file-201' && firstBodyDelayMs > 0) await sleep(firstBodyDelayMs);
          media.push({ stage: 'body', file_id, began_ms: began, ended_ms: Date.now() - started });
          return Uint8Array.from([1, 2, 3]).buffer;
        }
      };
    }
    throw new Error(`unexpected fake request ${url}`);
  // This fetch replacement implements only requests exercised by the timed album tests.
  }) as unknown as typeof fetch;
  return {
    asked,
    fetched,
    media,
    restore: () => { globalThis.fetch = previous; }
  };
}

test('the long poll does not confirm an update until the record it wrote has been consumed', async () => {
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-poll-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: { bot_token: tokenFile(), long_poll_timeout_s: 0, max_attachment_bytes: 0 },
    now: Date.now()
  };
  const server = serverOf([
    [update(900001, 101, 'first'), update(900002, 102, 'second')],
    [update(900003, 103, 'third')]
  ]);

  try {
    // The first pass starts the worker; the first batch reaches the buffer a
    // moment later, the way it does on a box.
    await arrivals(context);
    let items: ArrivedItem[] = [];
    for (let i = 0; i < 40 && items.length === 0; i++) {
      await sleep(IDLE_MS);
      items = await arrivals(context);
    }
    assert.equal(items.length, 2, 'the first batch never reached the buffer');
    assert.deepEqual(server.asked.slice(0, 1), [null],
      'the first call asked for an offset before anything had been written');

    // Nothing is consumed yet, so the worker waits and the store's offset stays
    // where it was.
    await sleep(IDLE_MS * 4);
    assert.equal(nextOffset(context.store, context.account), null);
    assert.deepEqual([...new Set(server.asked)], [null],
      'the worker asked for a higher offset while a batch was still unconsumed');

    // The loop captures and consumes; only now may the offset move.
    for (const item of items) adapter.consume({ ...context, items }, item);
    assert.equal(nextOffset(context.store, context.account), 900003);

    let second: ArrivedItem[] = [];
    for (let i = 0; i < 40 && second.length === 0; i++) {
      await sleep(IDLE_MS);
      second = await arrivals(context);
    }
    assert.equal(second.length, 1);
    // The fixture update contains the id read after the loop consumes it.
    assert.equal((second[0].update as Fields).update_id, 900003);
    assert.ok(server.asked.includes(900003),
      `the second call did not confirm the first batch: ${server.asked.join(', ')}`);
  } finally {
    server.restore();
    forget();
  }
});

test('an album is settled across repeat asks at one offset and every photo is fetched once', async () => {
  forget();
  assert.equal(ALBUM_QUIET_MS, 2000);
  assert.equal(adapter.DEFAULTS.album_quiet_ms, ALBUM_QUIET_MS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-album-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: {
      bot_token: tokenFile(), long_poll_timeout_s: 0,
      album_quiet_ms: 100, max_attachment_bytes: 1000
    },
    now: Date.now()
  };
  const server = albumServerOf();

  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.equal(items.length, 3, 'the worker handed over a partial album');
    assert.ok(server.asked.length >= 2);
    assert.deepEqual([...new Set(server.asked.slice(0, 2).map((one) => one.offset))], [null]);
    assert.equal(server.asked[1].timeout, 0);
    assert.deepEqual([...server.fetched.values()], [1, 1, 1]);

    for (const item of items) adapter.consume({ ...context, items }, item);
    await sleep(IDLE_MS * 2);
    assert.ok(server.asked.some((one) => one.offset === 900004),
      `the next ask did not confirm the whole album: ${JSON.stringify(server.asked)}`);
  } finally {
    server.restore();
    forget();
  }
});

test('album membership settles before a slow first photo fetch begins', async (t) => {
  for (const [name, delay] of [
    ['getFile response', { firstGetFileDelayMs: 150 }],
    ['file response body', { firstBodyDelayMs: 150 }]
  ] as const) {
    await t.test(name, async () => {
      forget();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-album-media-delay-'));
      const context = {
        store: Store.open(path.join(dir, 'store')),
        adapter,
        agent: 'agent-01',
        account: 'example_agent_bot',
        channel: {
          bot_token: tokenFile(), long_poll_timeout_s: 0,
          album_quiet_ms: 100, max_attachment_bytes: 1000
        },
        now: Date.now()
      };
      // The first answer has one photo. The other five become visible while the
      // old implementation was fetching that photo, still inside the window.
      const server = timedAlbumServerOf({ tailAfterMs: 20, ...delay });

      try {
        await arrivals(context);
        const { items } = await waitForBatch(context);
        assert.equal(items.length, 6, 'media work expired the membership window');
        assert.ok(server.asked.length >= 3);
        assert.deepEqual([...new Set(server.asked.slice(0, 3).map((one) => one.offset))], [null]);
        const firstMediaAt = Math.min(...server.media.map((one) => one.began_ms));
        assert.ok(server.asked.some((one) => one.count === 6 && one.at_ms < firstMediaAt),
          'the full raw album was not observed before media fetching began');
        assert.deepEqual([...server.fetched.values()], [1, 1, 1, 1, 1, 1]);
      } finally {
        server.restore();
        forget();
      }
    });
  }
});

test('an album tail first visible after the quiet window remains a later batch', async () => {
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-late-album-tail-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: {
      bot_token: tokenFile(), long_poll_timeout_s: 0,
      album_quiet_ms: 100, max_attachment_bytes: 1000
    },
    now: Date.now()
  };
  const server = timedAlbumServerOf({ tailAfterMs: 1000 });

  try {
    await arrivals(context);
    const { items: first } = await waitForBatch(context);
    // These scripted update objects carry the ids checked after polling.
    assert.deepEqual(first.map((one) => (one.update as Fields).update_id), [910001]);
    for (const item of first) adapter.consume({ ...context, items: first }, item);

    const { items: second } = await waitForBatch(context);
    assert.deepEqual(second.map((one) => (one.update as Fields).update_id),
      [910002, 910003, 910004, 910005, 910006]);
    assert.deepEqual([...server.fetched.values()], [1, 1, 1, 1, 1, 1]);
  } finally {
    server.restore();
    forget();
  }
});

test('an album keeps first-sight timestamps and fetches each photo once across a failed repeat ask', async () => {
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-album-retry-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: {
      bot_token: tokenFile(), long_poll_timeout_s: 0,
      album_quiet_ms: 100, max_attachment_bytes: 1000
    },
    now: Date.now()
  };
  const server = albumServerOf({ failAt: 2 });

  try {
    await arrivals(context);
    const { items, fault } = await waitForBatch(context, { acceptFault: true });
    assert.ok(fault instanceof TelegramFault, 'the failed repeat ask was not exposed as a channel fault');
    assert.equal(items.length, 3);
    assert.deepEqual([...server.fetched.values()], [1, 1, 1]);
    assert.ok(Date.parse(items[0].received_at) < server.thirdCallAt()!,
      'the first photo was rebuilt with the retry time');
  } finally {
    server.restore();
    forget();
  }
});

test('a poll that cannot reach the server is a fault the runtime can hold on, not a stopped process', async () => {
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-poll-fail-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: { bot_token: tokenFile(), long_poll_timeout_s: 0 },
    now: Date.now()
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    await arrivals(context);
    let thrown: unknown = null;
    for (let i = 0; i < 40 && thrown === null; i++) {
      await sleep(IDLE_MS);
      try { await arrivals(context); } catch (error) { thrown = error; }
    }
    assert.ok(thrown instanceof TelegramFault, 'the failed poll was not reported as a named fault');
    assert.equal(thrown.faults[0].code, 'BOT_API_UNREACHABLE');
  } finally {
    globalThis.fetch = previous;
    forget();
  }
});

test('a malformed thrown poll message remains unvalidated on the Telegram fault', async () => {
  forget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-malformed-fault-'));
  const context = {
    store: Store.open(path.join(dir, 'store')),
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: { bot_token: tokenFile(), long_poll_timeout_s: 0 }
  };
  const problem = { provider_detail: 17 };
  const previous = globalThis.fetch;
  // The malformed response fails while the poll iterates it. No network is used.
  globalThis.fetch = (async () => ({
    status: 200,
    json: async () => ({ ok: true, result: {
      [Symbol.iterator]() { throw { message: problem }; }
    } })
  // This fetch replacement returns the malformed response needed for the refusal test.
  })) as unknown as typeof fetch;
  try {
    await arrivals(context);
    await sleep(IDLE_MS);
    await assert.rejects(() => arrivals(context), (error: unknown) => {
      assert.ok(error instanceof TelegramFault);
      assert.equal(error.faults[0].code, 'BOT_API_POLL_FAILED');
      assert.equal(error.faults[0].problem, problem);
      return true;
    });
  } finally {
    forget();
    globalThis.fetch = previous;
  }
});
