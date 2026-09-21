// What the Telegram tests are run against: a token on disk, updates shaped the
// way the Bot API shapes them, a recording server whose answers are scripted,
// and the capture half of a release pass.
//
// It is a module rather than a copy in each test file because two test files
// need the same server — one for what the long poll hands over and one for what
// the loop then does with it — and a second copy of a fixture is a second thing
// to keep true.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.mjs';
import { arrivals, IDLE_MS } from '../adapters/telegram/live.mjs';
import * as adapter from '../adapters/telegram/index.mjs';

export const TOKEN = '7000001:AAH-this-is-not-a-real-token_0123456789';

export function tokenFile(body = TOKEN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-token-'));
  const file = path.join(dir, 'bot-token');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function update(update_id, message_id, text, chat = 887766554) {
  return {
    update_id,
    message: {
      message_id,
      from: { id: 4455667, is_bot: false, first_name: 'Ada' },
      chat: { id: chat, type: 'private', first_name: 'Ada' },
      date: 1789034400,
      text
    }
  };
}

export function photoUpdate(update_id, message_id, album = 'album-1', chat = 887766554) {
  const message = {
    message_id,
    from: { id: 4455667, is_bot: false, first_name: 'Ada' },
    chat: { id: chat, type: 'private', first_name: 'Ada' },
    date: 1789034400,
    photo: [{ file_id: `file-${message_id}`, file_unique_id: `unique-${message_id}`, file_size: 3 }]
  };
  // A photograph sent on its own carries no group id at all, and an album's
  // members carry the same one. Both are ordinary here.
  if (album !== null) message.media_group_id = album;
  return { update_id, message };
}

// A recording Bot API. Its answers are a function of which call this is and what
// offset was asked for, so a shrinking, reordered, repeated or empty answer is a
// fixture and not a race, and every call is recorded with the moment it was
// answered so the order of events can be asserted without asserting how fast
// this machine is.
//
// `filtered: false` lets a test replay updates the store has already confirmed,
// which a real server would not do and which is the only way to show that the
// worker drops them itself.
export function scriptedServerOf({ respond, failCall = null, filtered = true, bytesOf = () => [1, 2, 3] }) {
  const asked = [];
  const fetched = new Map();
  const media = [];
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/getUpdates')) {
      calls += 1;
      const params = JSON.parse(options.body);
      const offset = params.offset ?? null;
      if (calls === failCall) {
        asked.push({ call: calls, offset, at: Date.now(), failed: true, ids: [] });
        throw new Error('the fake server dropped the repeat ask');
      }
      const produced = respond({ call: calls, offset }) ?? [];
      const result = filtered
        ? produced.filter((one) => offset === null || one.update_id >= offset)
        : produced;
      asked.push({
        call: calls, offset, timeout: params.timeout, at: Date.now(),
        ids: result.map((one) => one.update_id)
      });
      if (result.length === 0) await sleep(10);
      return { status: 200, json: async () => ({ ok: true, result }) };
    }
    if (url.includes('/getFile')) {
      const { file_id } = JSON.parse(options.body);
      fetched.set(file_id, (fetched.get(file_id) ?? 0) + 1);
      media.push({ stage: 'getFile', file_id, at: Date.now() });
      return { status: 200, json: async () => ({ ok: true, result: { file_path: `files/${file_id}.jpg` } }) };
    }
    if (url.includes('/file/bot')) {
      const file_id = /files\/(file-[^/]+)\.jpg/.exec(url)?.[1] ?? 'unknown';
      media.push({ stage: 'body', file_id, at: Date.now() });
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(bytesOf(file_id)).buffer };
    }
    throw new Error(`unexpected fake request ${url}`);
  };
  return { asked, fetched, media, restore: () => { globalThis.fetch = previous; } };
}

// A context the way a box hands one to the adapter: a store of its own, a token
// on disk, and a channel that answers immediately so a test is not waiting on a
// long poll.
export function liveContext(prefix, channel = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent: 'agent-01',
    account: 'example_agent_bot',
    channel: {
      bot_token: tokenFile(), long_poll_timeout_s: 0,
      album_quiet_ms: 100, max_attachment_bytes: 1000, ...channel
    },
    dir,
    now: Date.now()
  };
}

// Capture the way the release loop captures, and stop there: the records and
// their attachments are on disk and no cursor has moved. Consumption is the
// caller's, because the boundary between the two is what is being tested.
export function captureBatch(context, items) {
  const pending = adapter.listPending({ ...context, items });
  const { entries, parked } = adapter.payload({ ...context, items }, pending);
  for (const entry of entries) {
    const attachments = (entry.attachments ?? []).map((attachment) => (
      Buffer.isBuffer(attachment.bytes)
        ? context.store.putAttachment(entry.record, attachment.bytes, attachment)
        : attachment));
    context.store.capture({ ...entry.record, attachments }, { raw: entry.raw, cursor: entry.cursor });
  }
  for (const item of parked) {
    context.store.park(item.record, item.reason, { raw: item.raw, cursor: item.cursor });
  }
  return pending;
}

export function idsOf(items) {
  return items.map((one) => one.update.update_id);
}

// Ask the way the loop asks, until the worker has something. A fault is thrown
// on unless the test is the one about faults.
export async function waitForBatch(context, { acceptFault = false, attempts = 80 } = {}) {
  let items = [];
  let fault = null;
  for (let i = 0; i < attempts && items.length === 0; i++) {
    await sleep(IDLE_MS);
    try {
      items = await arrivals(context);
    } catch (error) {
      if (!acceptFault) throw error;
      fault = error;
    }
  }
  return { items, fault };
}
