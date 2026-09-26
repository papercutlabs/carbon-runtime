// Fetch replacements implement only the response methods exercised below; the
// installation assertions retain these deliberately partial synthetic responses.
import type { Context, Channel, ArrivedItem, Item, Fields } from '../adapters/telegram/types.ts';
import type { MessageRecord } from '../stream/store.ts';
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

import { Store } from '../stream/store.ts';
import { arrivals, IDLE_MS } from '../adapters/telegram/live.ts';
import * as adapter from '../adapters/telegram/index.ts';

export const TOKEN = '7000001:AAH-this-is-not-a-real-token_0123456789';

export function tokenFile(body = TOKEN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-token-'));
  const file = path.join(dir, 'bot-token');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function update(update_id: number, message_id: number, text: string, chat = 887766554) {
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

export function photoUpdate(update_id: number, message_id: number, album: string | null = 'album-1', chat = 887766554) {
  const message: { message_id: number; from: { id: number; is_bot: boolean; first_name: string }; chat: { id: number; type: string; first_name: string }; date: number; photo: { file_id: string; file_unique_id: string; file_size: number }[]; media_group_id?: string } = {
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
export type SyntheticUpdate = ReturnType<typeof update> | ReturnType<typeof photoUpdate>;
export type Respond = (request: { call: number; offset: number | null }) => SyntheticUpdate[] | null | undefined;
export function scriptedServerOf({ respond, failCall = null, filtered = true, bytesOf = () => [1, 2, 3] }: { respond: Respond; failCall?: number | null; filtered?: boolean; bytesOf?: (id: string) => number[] }) {
  const asked: { call: number; offset: number | null; at: number; failed?: boolean; ids: number[]; timeout?: number }[] = [];
  const fetched = new Map<string, number>();
  const media: { stage: string; file_id: string; at: number }[] = [];
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/getUpdates')) {
      calls += 1;
      const params = JSON.parse(options.body as string);
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
      const { file_id } = JSON.parse(options.body as string);
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
  }) as unknown as typeof fetch;
  return { asked, fetched, media, restore: () => { globalThis.fetch = previous; } };
}

// A context the way a box hands one to the adapter: a store of its own, a token
// on disk, and a channel that answers immediately so a test is not waiting on a
// long poll.
export function liveContext(prefix: string, channel: Channel = {}) {
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
export function captureBatch(context: Context, items: Item[]) {
  const pending = adapter.listPending({ ...context, items });
  const { entries, parked } = adapter.payload({ ...context, items }, pending);
  for (const entry of entries) {
    const attachments = // The owned synthetic fixtures supply this attachment shape. The real
    // adapter's payload deliberately leaves provider metadata unvalidated.
    ((entry.attachments ?? []) as { bytes: unknown; mime?: string; filename?: string }[]).map((attachment) => (
      Buffer.isBuffer(attachment.bytes)
        ? context.store.putAttachment(entry.record as Pick<MessageRecord, 'conversation_id' | 'message_id'>, attachment.bytes, attachment)
        : attachment));
    // Store.capture performs the existing schema validation. This assertion
    // is restricted to that call; the adapter output retains unknown fields.
    context.store.capture({ ...entry.record, attachments } as MessageRecord, { raw: entry.raw, cursor: entry.cursor as { kind: 'message' | 'revision'; position: string } });
  }
  for (const item of parked) {
    // Parking uses the same existing store validator; no prevalidation is added.
    context.store.park(item.record as MessageRecord, item.reason, { raw: item.raw, cursor: item.cursor as { kind: 'message' | 'revision'; position: string } });
  }
  return pending;
}

export function idsOf(items: Item[]) {
  return items.map((one) => (one.update as Fields).update_id);
}

// Ask the way the loop asks, until the worker has something. A fault is thrown
// on unless the test is the one about faults.
export async function waitForBatch(context: Context, { acceptFault = false, attempts = 80 } = {}) {
  let items: ArrivedItem[] = [];
  let fault: unknown = null;
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
