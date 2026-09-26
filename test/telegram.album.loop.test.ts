import type { Channel } from '../runtime/types.ts';
// Assertions on fixture-only fault shapes and nonempty test results preserve
// the original failure assertions; they add no fallback for a missing result.
import type { Respond } from './telegram-fixtures.ts';
import type { MessageRecord, Attachment } from '../stream/store.ts';
// Fetch replacements implement only the response methods exercised below; the
// installation assertions retain these deliberately partial synthetic responses.
// The whole path an album takes, with nothing between the worker and the turn
// faked except the server and the model.
//
// The other Telegram tests prove what the long poll hands over, and the loop
// tests prove what the loop does with items it is handed. Between the two there
// is one join nobody was testing: the batch the real worker produces, captured
// by the real adapter and released by the real loop. The retained-membership
// failure lives exactly there — six photographs the worker remembered became
// one turn and then another — so the proof has to run the join rather than
// rebuild six records that skip it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop } from '../runtime/loop.ts';
import { resolveChannel } from '../runtime/channel.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import { fakeHarness } from './fake-harness.ts';
import { forget, IDLE_MS } from '../adapters/telegram/live.ts';
import * as telegram from '../adapters/telegram/index.ts';
import { photoUpdate, sleep, tokenFile } from './telegram-fixtures.ts';

const AGENT = 'test-agent';
const ACCOUNT = 'example_agent_bot';
const CHAT = 887766554;
const OTHER_CHAT = 998877665;

// The Bot API this loop talks to: answers to getUpdates are scripted per call,
// every photograph has bytes of its own so one attachment cannot be mistaken for
// another, and a reply is accepted and counted.
function botServerOf({ respond }: { respond: Respond }) {
  const asked: { call: number; offset: number | null; ids: number[] }[] = [];
  const sent: { chat_id: string; text: string }[] = [];
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.includes('/getUpdates')) {
      calls += 1;
      const params = JSON.parse(options.body as string); // The fixture supplies this text; the existing text assertion remains the runtime check.
      const offset = params.offset ?? null;
      const produced = respond({ call: calls, offset }) ?? [];
      const result = produced.filter((one) => offset === null || one.update_id >= offset);
      asked.push({ call: calls, offset, ids: result.map((one) => one.update_id) });
      if (result.length === 0) await sleep(10);
      return { status: 200, json: async () => ({ ok: true, result }) };
    }
    if (url.includes('/getFile')) {
      const { file_id } = JSON.parse(options.body as string); // The fixture supplies this text; the existing text assertion remains the runtime check.
      return { status: 200, json: async () => ({ ok: true, result: { file_path: `files/${file_id}.jpg` } }) };
    }
    if (url.includes('/file/bot')) {
      const fileId = /files\/file-(\d+)\.jpg/.exec(url)?.[1] ?? '0';
      // Bytes of its own, in the length as well as the values, so two photographs
      // cannot share a digest by accident.
      const bytes = Array.from({ length: (Number(fileId) % 10) + 1 }, () => Number(fileId) % 251);
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    }
    if (url.includes('/sendMessage')) {
      const params = JSON.parse(options.body as string); // The fixture supplies this text; the existing text assertion remains the runtime check.
      sent.push(params);
      return {
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 9000 + sent.length } })
      };
    }
    throw new Error(`unexpected fake request ${url}`);
  }) as unknown as typeof fetch; // This fixture creates the selected value before this access; retain the original failure if it is absent.
  return { asked, sent, restore: () => { globalThis.fetch = previous; } };
}

function declarationOf(bot_token: string) {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [{ name: 'telegram_bot_token', path: bot_token, purpose: 'the bot token' }],
    tool_servers: [],
    channels: [{
      kind: 'telegram',
      account: ACCOUNT,
      release: 'quiet',
      quiet_ms: 0,
      poll_interval_ms: 1000,
      conversations: [],
      default_conversation_kind: 'customer',
      transport: {
        bot_token_ref: 'telegram_bot_token',
        long_poll_timeout_s: 0,
        album_quiet_ms: 100,
        max_attachment_bytes: 1000,
        allowed_chat_ids: 'any'
      }
    }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

const REPLY_LISTED = () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }];

// The model answers the conversation the turn names, through the real reply
// tool, because a turn that answers nothing is a turn the runtime follows up on
// and that is not what is being tested here.
function answering(store: Store) {
  const handle = replyHandler({ store, agent: AGENT });
  return (session: unknown, params: { input: string; clientUserMessageId: string }) => {
    const conversation = /conversation_id: (\S+)/.exec(params.input)?.[1];
    handle({ conversation_id: conversation!, request_id: params.clientUserMessageId, text: 'the answer' }); // This fixture creates the selected value before this access; retain the original failure if it is absent.
    return 'completed';
  };
}

function makeLoop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-album-loop-'));
  const store = Store.open<MessageRecord<Attachment>>(dir);
  const declaration = declarationOf(tokenFile());
  // The unconverted helper infers zero-argument defaults, but its source calls
  // onTurn(session, params, n) and returns the listed statuses unchanged.
  const harness = (fakeHarness as unknown as (options: { // This fixture creates the selected value before this access; retain the original failure if it is absent.
    onTurn: ReturnType<typeof answering>; statuses: typeof REPLY_LISTED;
  }) => ReturnType<typeof fakeHarness>)({ onTurn: answering(store), statuses: REPLY_LISTED });
  const lines: { event: string }[] = [];
  const loop = new ReleaseLoop({
    declaration,
    channel: resolveChannel(declaration, declaration.channels[0]) as Channel, // The fixture supplies these channel fields; resolved transport overrides remain unvalidated in the runtime API.
    store,
    storeDir: dir,
    adapter: telegram,
    harness,
    session: harness.session,
    agent: AGENT,
    checkout: path.join(dir, 'repo'),
    work: dir,
    // ReleaseLoop's JavaScript default infers no argument; the implementation
    // supplies log events. Preserve that callback unchanged at this boundary.
    log: ((line: { event: string }) => lines.push(line)) as unknown as () => void // This fixture creates the selected value before this access; retain the original failure if it is absent.
  });
  return { loop, store, harness, lines };
}

// Passes until the channel has handed something over, the way the runtime's own
// interval does, and then one more caller-controlled pass.
async function passUntilCaptured(loop: ReleaseLoop, attempts = 40) {
  let result = null;
  for (let i = 0; i < attempts; i++) {
    result = await loop.pass();
    if (result.captured.length > 0) return result;
    await sleep(IDLE_MS);
  }
  return result;
}

test('six photographs the worker retained across shrinking answers are one release and one turn', async () => {
  forget();
  const { loop, store, harness, lines } = makeLoop();
  const album = Array.from({ length: 6 }, (_, index) =>
    photoUpdate(980001 + index, 501 + index, 'loop-album'));
  // The failure this is here for: no answer after the first names the whole
  // album, and the last names one photograph the worker already had.
  const script = [album.slice(0, 1), album.slice(1, 3), album.slice(3, 6), [album[0]]];
  const server = botServerOf({ respond: ({ call }) => script[call - 1] ?? [] });

  try {
    // The default forty attempts always run a pass; null only describes zero attempts.
    const result = (await passUntilCaptured(loop))!; // This fixture creates the selected value before this access; retain the original failure if it is absent.

    assert.equal(result.captured.length, 6, 'the album did not reach the loop whole');
    assert.equal(new Set(result.captured.map((one: MessageRecord) => one.message_id)).size, 6,
      'six photographs did not become six records');
    assert.equal(result.released.length, 1, 'the album was released more than once');
    assert.equal(result.released[0].message_ids.length, 6);
    assert.equal(harness.session.turns.length, 1, 'the album became more than one turn');

    // Every photograph's own bytes reached the turn, named by the digest the
    // capture wrote.
    const inbound = store.rebuild().filter((one) => one.direction === 'inbound');
    assert.equal(inbound.length, 6);
    const digests = inbound.map((one) => one.attachments[0].sha256);
    assert.equal(new Set(digests).size, 6, 'two photographs were stored as the same bytes');
    for (const digest of digests) {
      assert.ok(harness.session.turns[0].input.includes(digest),
        'a stored photograph did not reach the turn input');
    }
    assert.equal(new Set(inbound.map((one) => one.release!.turn_id)).size, 1); // This case wrote a release before inspecting it; direct access must still fail if it is absent.
    assert.ok(inbound.every((one) => one.release!.completed_at), 'a record was left in an open release'); // This case wrote a release before inspecting it; direct access must still fail if it is absent.

    // At most one logical reply: one outbound record, whatever number of chunks
    // the server was asked to carry it in.
    assert.deepEqual(result.delivered.map((one) => one.status), ['sent']);
    const outbound = store.rebuild().filter((one) => one.direction === 'outbound');
    assert.equal(outbound.length, 1, 'the album was answered more than once');
    assert.equal(outbound[0].delivery!.status, 'sent'); // The reply in this case carries delivery state; direct access must still fail if it is absent.
    assert.equal(lines.filter((line) => line.event === 'release').length, 1);
    assert.equal(lines.filter((line) => line.event === 'turn').length, 1);

    // And a later pass does not release any of it again.
    const again = await loop.pass();
    assert.equal(again.captured.length, 0);
    assert.equal(again.released.length, 0);
    assert.equal(harness.session.turns.length, 1);
    assert.equal(store.rebuild().filter((one) => one.direction === 'outbound').length, 1);
  } finally {
    server.restore();
    forget();
  }
});

test('two chats in one retained batch stay two releases and two turns', async () => {
  forget();
  const { loop, store, harness } = makeLoop();
  const here = [photoUpdate(981001, 511, 'here-album'), photoUpdate(981003, 513, 'here-album')];
  const there = [
    photoUpdate(981002, 512, 'there-album', OTHER_CHAT),
    photoUpdate(981004, 514, 'there-album', OTHER_CHAT)
  ];
  // Interleaved across chats, and split over answers that each carry part of it.
  const script = [[here[0], there[0]], [here[1]], [there[1]], [here[0]]];
  const server = botServerOf({ respond: ({ call }) => script[call - 1] ?? [] });

  try {
    // The default forty attempts always run a pass; null only describes zero attempts.
    const result = (await passUntilCaptured(loop))!; // This fixture creates the selected value before this access; retain the original failure if it is absent.

    assert.equal(result.captured.length, 4, 'a retained update was lost between the chats');
    assert.equal(result.released.length, 2, 'the two chats were gathered into one release');
    assert.equal(harness.session.turns.length, 2);
    const byConversation = new Map<string, string[]>(result.released.map((one: { message_ids: string[] }) => [
      one.message_ids[0].split(':').slice(0, 2).join(':'), one.message_ids
    ]));
    assert.deepEqual([...byConversation.keys()].sort(),
      [`${ACCOUNT}:${CHAT}`, `${ACCOUNT}:${OTHER_CHAT}`].sort());
    for (const [conversation, ids] of byConversation) {
      assert.equal(ids.length, 2);
      assert.ok(ids.every((id) => id.startsWith(`${conversation}:`)),
        'a release carried a record from the other chat');
    }
    const outbound = store.rebuild().filter((one) => one.direction === 'outbound');
    assert.equal(outbound.length, 2, 'a chat was answered more than once');
    assert.equal(new Set(outbound.map((one) => one.conversation_id)).size, 2);
  } finally {
    server.restore();
    forget();
  }
});
