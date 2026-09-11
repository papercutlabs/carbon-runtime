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
import { Store } from '../stream/store.mjs';
import * as adapter from '../adapters/whatsapp/index.mjs';
import { canonicalChatKey, canonicalParticipant, normaliseJid, pairsIn } from '../adapters/whatsapp/jid.mjs';
import { readLidMap } from '../adapters/whatsapp/channel-state.mjs';

const FIXTURES = path.join(import.meta.dirname, '..', 'adapters', 'whatsapp', 'fixtures');

const PHONE = '15550001111@s.whatsapp.net';
const LID = '189234567890123@lid';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function context(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-whatsapp-'));
  const { agent, account } = fixture('context.json');
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
function put(context, record) {
  return context.store.capture(record).record;
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
  const map = readLidMap(running.store, running.account);
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
  assert.equal(entries[0].record.adapter_fields.hd_variant_skipped, true);
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
  assert.equal(new Set(entries.map((e) => e.record.adapter_fields.album_id)).size, 1);
  assert.deepEqual(entries.map((e) => e.record.adapter_fields.album_index), [0, 1, 2]);
});

test('a message from this device is the operator, and it holds the agent', () => {
  const running = context();
  const { entries } = adapter.payload(running, fixture('operator.json'));
  const record = entries[0].record;
  assert.equal(record.role, 'operator');
  assert.equal(record.hold.release_after_ms, adapter.HOLD_MS);

  const declared = context({ channel: { hold: { release_after_ms: 60_000 } } });
  const held = adapter.payload(declared, fixture('operator.json')).entries[0].record;
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
  const [request] = fixture('outbound.json');
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

// A send with no socket handed over now asks live.mjs for the connection the
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
    (error) => error.faults[0].code === 'CHANNEL_AUTH_DIR_ABSENT'
  );
});

test('a live send stops at the first refusal and keeps the pieces that went out', async () => {
  const running = context({ dry_run: false });
  const outbox = [];
  const socket = {
    sendMessage: async (chat, { text }) => {
      outbox.push(text);
      if (outbox.length === 2) throw Object.assign(new Error('timed out'), { output: { statusCode: 408 } });
      return { key: { id: `3EB0X${outbox.length}` } };
    }
  };
  const [request] = fixture('outbound.json');
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
    (error) => error.faults[0].code === 'CHAT_KEY_ABSENT'
  );
});

test('the participant of a group message keeps the linked-id rule', () => {
  assert.equal(canonicalParticipant({ participant: PHONE, participantAlt: LID }), LID);
  assert.equal(canonicalParticipant({ participant: PHONE }), PHONE);
  assert.equal(canonicalParticipant({}), null);
});
