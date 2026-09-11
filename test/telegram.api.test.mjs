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
import { Store } from '../stream/store.mjs';
import { botIdOf, call, readToken, scrub, TelegramFault } from '../adapters/telegram/api.mjs';
import { arrivals, forget, IDLE_MS, transportFor } from '../adapters/telegram/live.mjs';
import { nextOffset } from '../adapters/telegram/cursors.mjs';
import * as adapter from '../adapters/telegram/index.mjs';

const TOKEN = '7000001:AAH-this-is-not-a-real-token_0123456789';

function tokenFile(body = TOKEN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-token-'));
  const file = path.join(dir, 'bot-token');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- the token ---------------------------------------------------------------

test('a token is read from its file at the moment it is used, and trailing whitespace is not part of it', () => {
  const file = tokenFile(`${TOKEN}\n`);
  assert.equal(readToken(file), TOKEN);
  assert.equal(botIdOf(TOKEN), 7000001);
});

test('a file that is not a token is refused by name, before the first call', () => {
  assert.throws(() => readToken(tokenFile('bot_token: "7000001:AAH"\n')),
    (error) => error.faults[0].code === 'BOT_TOKEN_MALFORMED');
  assert.throws(() => readToken('/no/such/token/file'),
    (error) => error.faults[0].code === 'CHANNEL_TOKEN_UNREADABLE');
  assert.throws(() => readToken(undefined),
    (error) => error.faults[0].code === 'CHANNEL_TOKEN_PATH_ABSENT');
});

test('the token never reaches a fault, whatever the server or the network said about it', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`connect ECONNREFUSED at ${url}`); };
  try {
    await assert.rejects(() => call({ token: TOKEN }, 'getMe'), (error) => {
      const said = JSON.stringify(error.faults);
      assert.ok(!said.includes(TOKEN), 'the token is in the fault');
      assert.ok(said.includes('<bot token>'), 'the url was not scrubbed');
      return error.faults[0].code === 'BOT_API_UNREACHABLE';
    });
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(scrub(`https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN),
    'https://api.telegram.org/bot<bot token>/getMe');
});

test('a refusal carries the server\'s own code, so a revoked token is not read as a busy server', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 401,
    json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' })
  });
  try {
    await assert.rejects(() => call({ token: TOKEN }, 'getMe'), (error) => {
      assert.ok(error instanceof TelegramFault);
      assert.equal(error.errorCode, 401);
      assert.equal(error.faults[0].code, 'BOT_API_REFUSED');
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
function serverOf(batches) {
  const asked = [];
  let at = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const params = JSON.parse(options.body);
    asked.push(params.offset ?? null);
    const batch = at < batches.length ? batches[at++] : [];
    return { status: 200, json: async () => ({ ok: true, result: batch }) };
  };
  return { asked, restore: () => { globalThis.fetch = previous; } };
}

function update(update_id, message_id, text) {
  return {
    update_id,
    message: {
      message_id,
      from: { id: 4455667, is_bot: false, first_name: 'Ada' },
      chat: { id: 887766554, type: 'private', first_name: 'Ada' },
      date: 1789034400,
      text
    }
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
    let items = [];
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

    let second = [];
    for (let i = 0; i < 40 && second.length === 0; i++) {
      await sleep(IDLE_MS);
      second = await arrivals(context);
    }
    assert.equal(second.length, 1);
    assert.equal(second[0].update.update_id, 900003);
    assert.ok(server.asked.includes(900003),
      `the second call did not confirm the first batch: ${server.asked.join(', ')}`);
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
    let thrown = null;
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
