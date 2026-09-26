import type { Context, Fields, Item } from '../adapters/whatsapp/types.ts';
import type { MessageRecord } from '../stream/store.ts';
import type { StreamFault } from '../stream/store.ts';
// What this channel does that the twenty-four cases do not name.
//
// The conformance check proves the adapter writes the one record shape. These
// prove the decisions particular to WhatsApp: one key per chat under the linked
// id rollout, one record per photograph, one arrival per album, the operator's
// own phone holding the agent, and a reply that is too long going out in pieces
// whose ids come back.
//
// Every one of them runs against recorded events. Nothing here opens a socket,
// and the library is not loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.ts';
import * as adapter from '../adapters/whatsapp/index.ts';
import { canonicalChatKey, canonicalParticipant, normaliseJid, pairsIn } from '../adapters/whatsapp/jid.ts';
import { readLidMap } from '../adapters/whatsapp/channel-state.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'adapters', 'whatsapp', 'fixtures');

const PHONE = '15550001111@s.whatsapp.net';
const LID = '189234567890123@lid';

// These checked-in fixtures are test inputs; payload output remains untrusted.
function fixture<T = Item[]>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function context<T extends Partial<Context>>(overrides: T): Context & T;
function context(): Context;
function context(overrides: Partial<Context> = {}): Context {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-'));
  const { agent, account } = fixture<{ agent: string; account: string }>('context.json');
  return {
    store: Store.open(path.join(dir, 'store')),
    agent,
    account,
    items: [],
    dry_run: true,
    now: Date.parse('2026-09-10T11:00:00.000Z'),
    ...overrides
  };
}

// Write one record straight into the store, for the tests that need something
// already there.
function put(context: Context, record: Fields) {
  // Store.capture validates these untrusted candidates at the existing boundary.
  return context.store.capture(record as MessageRecord).record;
}

test('the canonical chat key is the linked-id form, whichever field the server put it in', () => {
  assert.equal(canonicalChatKey({ remoteJid: PHONE, remoteJidAlt: LID }), LID);
  assert.equal(canonicalChatKey({ remoteJid: LID, remoteJidAlt: PHONE }), LID);
  assert.equal(canonicalChatKey({ remoteJid: PHONE }), PHONE);
  assert.equal(canonicalChatKey({ remoteJid: LID }), LID);
  assert.equal(canonicalChatKey({}), null);
});

test('a group keeps its own key, because a group has no linked-id form', () => {
  const group = '120363000000000001@g.us';
  assert.equal(canonicalChatKey({ remoteJid: group, participant: PHONE, participantAlt: LID }), group);
});

test('the device a message came from is not part of who someone is', () => {
  assert.equal(normaliseJid('15550001111:12@s.whatsapp.net'), PHONE);
  assert.equal(normaliseJid('189234567890123:3@lid'), LID);
});

test('one chat is one conversation whichever form the server sends', () => {
  const running = context();
  const first = { conversation: LID, position: '000000000001', event: { key: { remoteJid: PHONE, remoteJidAlt: LID, id: 'a' }, message: { conversation: 'one' } } };
  const second = { conversation: LID, position: '000000000002', event: { key: { remoteJid: LID, remoteJidAlt: PHONE, id: 'b' }, message: { conversation: 'two' } } };
  const { entries } = adapter.payload(running, [first, second]);
  assert.equal(entries[0].record.conversation_id, entries[1].record.conversation_id);
  assert.equal(entries[0].record.conversation_id, `${running.account}:${LID}`);
});

test('the phone-to-linked-id map learns only from an event carrying both forms', () => {
  assert.deepEqual(pairsIn({ remoteJid: PHONE, remoteJidAlt: LID }), [{ phone: PHONE, lid: LID }]);
  assert.deepEqual(pairsIn({ remoteJid: PHONE }), []);

  const running = context();
  adapter.payload(running, fixture('inbound.json'));
  // This test just wrote the two maps through payload.
  const map = readLidMap(running.store, running.account) as { phone_to_lid: Fields; lid_to_phone: Fields };
  assert.equal(map.phone_to_lid[PHONE], LID);
  assert.equal(map.lid_to_phone[LID], PHONE);
});

test('a message identity is the canonical chat key and the event id', () => {
  const running = context();
  const [item] = fixture('inbound.json');
  const { entries } = adapter.payload(running, [item]);
  assert.equal(entries[0].record.message_id, `${running.account}:${LID}:3EB0A0000001`);
  assert.equal(entries[0].record.platform_message_id, '3EB0A0000001');
});

test('a group records the participant as the sender, not the group', () => {
  const running = context();
  const { entries } = adapter.payload(running, fixture('group.json'));
  assert.equal(entries[0].record.conversation_kind, 'group');
  assert.equal(entries[0].record.sender_id, '198765432109876@lid');
  assert.notEqual(entries[0].record.sender_id, entries[0].record.conversation_id);
});

test('the second, higher-definition upload of a picture is skipped', () => {
  const running = context();
  const items = fixture('hd.json');
  const { entries } = adapter.payload(running, items);
  assert.equal(entries.length, 1, 'the photograph was recorded twice');
  assert.equal(entries[0].record.platform_message_id, '3EB0H0000001');
  assert.equal(// The fixture includes the HD flag; this assertion reads that specific output.
    (entries[0].record.adapter_fields as Fields).hd_variant_skipped, true);
  assert.equal(entries[0].record.body, 'The damaged corner.');
});

test('an album settles for its quiet window and then arrives as one set', () => {
  const items = fixture('album.json');
  const last = Date.parse('2026-09-10T10:30:02.000Z');

  const settling = context({ items, now: last + 500 });
  assert.deepEqual(adapter.listPending(settling), [], 'a picture was released while the album was still arriving');

  const settled = context({ items, now: last + adapter.ALBUM_QUIET_MS + 1 });
  assert.equal(adapter.listPending(settled).length, 3);

  const declared = context({ items, now: last + 500, channel: { album_quiet_ms: 100 } });
  assert.equal(adapter.listPending(declared).length, 3, 'the declaration did not govern the window');

  const { entries } = adapter.payload(settled, items);
  assert.equal(entries.length, 3);
  // These album fixtures carry adapter fields; no wrong_type override is present.
  assert.equal(new Set(entries.map((e) => (e.record.adapter_fields as Fields).album_id)).size, 1);
  assert.deepEqual(entries.map((e) => (e.record.adapter_fields as Fields).album_index), [0, 1, 2]);
});

test('a message from this device is the operator, and it holds the agent', () => {
  const running = context();
  const { entries } = adapter.payload(running, fixture('operator.json'));
  // This operator fixture constructs a hold; no wrong_type override is present.
  const record = entries[0].record as MessageRecord & { hold: NonNullable<MessageRecord['hold']> };
  assert.equal(record.role, 'operator');
  assert.equal(record.hold.release_after_ms, adapter.HOLD_MS);

  const declared = context({ channel: { hold: { release_after_ms: 60_000 } } });
  // The same operator fixture is used with a declared hold duration.
  const held = adapter.payload(declared, fixture('operator.json')).entries[0].record as MessageRecord & { hold: NonNullable<MessageRecord['hold']> };
  assert.equal(held.hold.release_after_ms, 60_000);

  // And the hold is real: the store refuses to release the conversation.
  const [first] = adapter.payload(running, fixture('inbound.json')).entries;
  put(running, first.record);
  put(running, record);
  const set_at = Date.parse(record.hold.set_at);
  assert.equal(running.store.isHeld(record.conversation_id, set_at + 1), true);
  assert.equal(running.store.isHeld(record.conversation_id, set_at + adapter.HOLD_MS + 1), false);
});

test("the agent's own reply coming back down the socket is not an operator", () => {
  const running = context();
  const [inbound] = adapter.payload(running, fixture('inbound.json')).entries;
  put(running, inbound.record);
  put(running, {
    ...inbound.record,
    message_id: `${inbound.record.conversation_id}:out-0001`,
    platform_message_id: 'out-0001',
    direction: 'outbound',
    role: 'agent',
    body: 'Lines 14 and 15 are the storage overage for August.',
    delivery: {
      request_id: 'req-0001',
      status: 'sent',
      text_sha256: '0'.repeat(64),
      chunk_ids: ['3EB0S0000001']
    }
  });

  const echo = {
    conversation: LID,
    position: '000000000009',
    event: {
      key: { remoteJid: PHONE, remoteJidAlt: LID, id: '3EB0S0000001', fromMe: true },
      messageTimestamp: 1789040000,
      message: { conversation: 'Lines 14 and 15 are the storage overage for August.' }
    }
  };
  const { entries } = adapter.payload(running, [echo]);
  assert.deepEqual(entries, [], 'the agent held itself with its own reply');
});

test('a reply longer than the channel accepts goes out in pieces, and every piece is named', () => {
  const running = context();
  const [request] = fixture<{ text: string; request_id: string }[]>('outbound.json');
  const record = {
    conversation_id: `${running.account}:${LID}`,
    body: request.text,
    delivery: { request_id: request.request_id }
  };

  const sent = adapter.send({ ...running, dry_run: true }, record);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.chunk_ids.length >= 2, 'a reply beyond the channel limit was not split');
  assert.equal(new Set(sent.chunk_ids).size, sent.chunk_ids.length, 'two pieces share an id');

  const chunks = adapter.splitBody(request.text);
  assert.equal(chunks.length, sent.chunk_ids.length);
  for (const chunk of chunks) assert.ok(chunk.length <= adapter.MAX_MESSAGE_CHARS);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), request.text.replace(/\s+/g, ' ').trim());

  const declared = adapter.send({ ...running, dry_run: true, channel: { max_message_chars: 500 } }, record);
  assert.ok(declared.chunk_ids.length > sent.chunk_ids.length, 'the declaration did not govern the split');
});

test('a send whose acceptance nobody knows is unknown, and only a refused one failed', () => {
  assert.equal(adapter.outcomeOf(new Error('timed out'), 0), 'unknown');
  assert.equal(adapter.outcomeOf({ output: { statusCode: 428 } }, 0), 'failed');
  assert.equal(adapter.outcomeOf({ output: { statusCode: 440 } }, 0), 'failed');
  // Once a piece has gone out, nothing about the rest is known.
  assert.equal(adapter.outcomeOf({ output: { statusCode: 428 } }, 2), 'unknown');
});

// A send with no socket handed over now asks live.ts for the connection the
// poll opened, so the refusal names what is actually missing: this channel
// declares no authentication directory, and without one there is no connection
// to open and nothing to send on.
test('a live send is refused when there is nothing to send on', async () => {
  const running = context({ dry_run: false });
  await assert.rejects(
    () => adapter.send(running, {
      conversation_id: `${running.account}:${LID}`,
      body: 'short',
      delivery: { request_id: 'req-0002' }
    }),
    // The refusal under test is StreamFault; retain the original property assertion.
    (error: unknown) => (error as StreamFault).faults[0].code === 'CHANNEL_AUTH_DIR_ABSENT'
  );
});

test('a live send stops at the first refusal and keeps the pieces that went out', async () => {
  const running = context({ dry_run: false });
  const outbox: string[] = [];
  const socket = {
    sendMessage: async (chat: string, { text }: { text: string }) => {
      outbox.push(text);
      if (outbox.length === 2) throw Object.assign(new Error('timed out'), { output: { statusCode: 408 } });
      return { key: { id: `3EB0X${outbox.length}` } };
    }
  };
  const [request] = fixture<{ text: string; request_id: string }[]>('outbound.json');
  const result = await adapter.send({ ...running, socket, channel: { max_message_chars: 500 } }, {
    conversation_id: `${running.account}:${LID}`,
    body: request.text,
    delivery: { request_id: 'req-0003' }
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.chunk_ids, ['3EB0X1']);
  assert.equal(outbox[0], adapter.splitBody(request.text, 500)[0]);
});

test('an item is matched to the delivery it belongs to by its id, and by its text', () => {
  const running = context();
  const item = {
    event: { key: { id: '3EB0S0000001' }, message: { conversation: 'the reply' } }
  };
  assert.equal(adapter.matchesDelivery(running, item, { chunk_ids: ['3EB0S0000001'] }), true);
  assert.equal(adapter.matchesDelivery(running, item, {
    chunk_ids: [],
    text_sha256: '89d1a4c1e94e1ec06a08c56d21a66e2f9e79cd1e2d7c3aa93fd9b8d17dcb1ad9'
  }), false);
});

test('a message with no chat is refused rather than written somewhere', () => {
  const running = context();
  assert.throws(
    () => adapter.payload(running, [{ position: '1', event: { key: { id: 'x' }, message: { conversation: 'hello' } } }]),
    // The refusal under test is StreamFault; retain the original property assertion.
    (error: unknown) => (error as StreamFault).faults[0].code === 'CHAT_KEY_ABSENT'
  );
});

test('the participant of a group message keeps the linked-id rule', () => {
  assert.equal(canonicalParticipant({ participant: PHONE, participantAlt: LID }), LID);
  assert.equal(canonicalParticipant({ participant: PHONE }), PHONE);
  assert.equal(canonicalParticipant({}), null);
});

// ---- the signal that a turn is running ---------------------------------------

test('the signal is the presence update the library already has, and nothing when there is no connection', async () => {
  const running = context({ dry_run: false });
  const presence: { state: string; jid: string }[] = [];
  const socket = { sendPresenceUpdate: async (state: string, jid: string) => { presence.push({ state, jid }); } };
  const record = { conversation_id: `${running.account}:${LID}` };

  await adapter.typing({ ...running, socket }, record, 'composing');
  await adapter.typing({ ...running, socket }, record, 'paused');
  assert.deepEqual(presence, [
    { state: 'composing', jid: LID },
    { state: 'paused', jid: LID }
  ]);

  // No open connection, and a presence update never opens one: no call, and no
  // throw, because a signal about a reply may never cost the reply.
  await adapter.typing(running, record, 'composing');
  assert.equal(presence.length, 2);
});

test('malformed message leaves remain unvalidated until capture and send ids stay untrusted', async () => {
  const { read, association, albumOf } = await import('../adapters/whatsapp/content.ts');
  const message = { extendedTextMessage: { text: 7 } };
  assert.equal(read(message).text, 7);
  assert.equal(association({ messageContextInfo: { messageAssociation: 7 } }), 7);
  assert.deepEqual(albumOf({ messageContextInfo: { messageAssociation: {
    associationType: 1, parentMessageKey: { id: 'album' }, messageIndex: { raw: 2 }
  } } }), { album_id: 'album', index: { raw: 2 } });
  const running = context();
  const item = { position: '1', event: { key: { remoteJid: PHONE, id: 'bad' }, message } };
  const candidate = adapter.payload(running, [item]).entries[0].record;
  assert.equal(candidate.body, 7);
  assert.throws(() => put(running, candidate), /TYPE_WRONG/);
  const override = adapter.payload(running, [{ ...item, wrong_type: { conversation_id: 7 } }]).entries[0].record;
  assert.equal(override.conversation_id, 7);
  assert.throws(() => adapter.matchesDelivery(running, item, { chunk_ids: [] }), TypeError);
  const media = read({ imageMessage: { caption: false, mimetype: 9, fileLength: '12' } });
  assert.equal(media.text, false);
  assert.deepEqual(media.media, { field: 'imageMessage', mime: 9, bytes: 12, file_name: null });
  const result = await adapter.send({ ...running, dry_run: false, socket: {
    sendMessage: async () => ({ key: { id: 19 } })
  } }, { conversation_id: `${running.account}:${LID}`, body: 'short', delivery: { request_id: 'numeric-id' } });
  assert.deepEqual(result, { status: 'sent', chunk_ids: [19] });
});

test('unvalidated WhatsApp and import outputs cannot promise strings or provider credential schemas', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-type-boundary-'));
  const probe = path.join(dir, 'probe.ts');
  const config = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { typeRoots: [path.join(root, 'node_modules', '@types')] }, files: [probe], include: [] }));
  const lines = [
    `import * as content from ${JSON.stringify(path.join(root, 'adapters/whatsapp/content.ts'))};`,
    `import * as adapter from ${JSON.stringify(path.join(root, 'adapters/whatsapp/index.ts'))};`,
    `import { makeTransactionalAuthState } from ${JSON.stringify(path.join(root, 'adapters/whatsapp/auth-state.ts'))};`,
    `import { readLidMap } from ${JSON.stringify(path.join(root, 'adapters/whatsapp/channel-state.ts'))};`,
    `import { chatKeyFor } from ${JSON.stringify(path.join(root, 'import/carbon-capture-whatsapp.ts'))};`,
    `import * as ledger from ${JSON.stringify(path.join(root, 'import/carbon-ledger-sqlite.ts'))};`,
    `import type { Context } from ${JSON.stringify(path.join(root, 'adapters/whatsapp/types.ts'))};`,
    'declare const context: Context;'
  ];
  // These source strings are checked, never executed; the casts select exported
  // return types so the compiler must reject an unjustified downstream operation.
  const unsafe = [
    'content.read({}).text.toUpperCase();',
    'content.read({}).media?.mime.toUpperCase();',
    'content.association({}).associationType.toFixed();',
    'adapter.payload(context, []).entries[0].record.body.toUpperCase();',
    'adapter.payload(context, []).entries[0].record.conversation_id.toUpperCase();',
    "({} as ReturnType<typeof makeTransactionalAuthState>).state.creds.registered = true;",
    'readLidMap(context.store, context.account).phone_to_lid.x.toUpperCase();',
    'chatKeyFor({}).key.toUpperCase();',
    "({} as ReturnType<typeof ledger.payload>).entries[0].record.sender_id.toUpperCase();",
    'adapter.send({ ...context, dry_run: true }, { conversation_id: "x", delivery: { request_id: "y" } }).chunk_ids[0].toUpperCase();'
  ];
  const check = (body: string[]) => {
    fs.writeFileSync(probe, [...lines, ...body].join('\n'));
    return spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', config, '--pretty', 'false'], { encoding: 'utf8' });
  };
  try {
    const bad = check(unsafe);
    assert.notEqual(bad.status, 0);
    for (let i = 0; i < unsafe.length; i++) {
      assert.match(bad.stdout, new RegExp(`probe\\.ts\\(${lines.length + i + 1},\\d+\\): error TS(?:2339|2571|18046):`), unsafe[i] + '\n' + bad.stdout);
    }
    const good = check(['const text: unknown = content.read({}).text;', 'const key: unknown = chatKeyFor({}).key;']);
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
