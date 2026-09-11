// What this channel does that the twenty-four cases do not name.
//
// The conformance check proves the adapter writes the one record shape. These
// prove the decisions particular to Telegram: the offset that only moves after a
// capture, the chat-local id that orders a conversation, one record per item of
// an album, the declared chats the agent answers and the ones it does not, the
// declared operator, the bot's own message, and a reply that is too long going
// out in pieces whose ids come back.
//
// Every one of them runs against recorded updates. Nothing here opens a
// connection and nothing here reads a token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import * as adapter from '../adapters/telegram/index.mjs';
import { ingest } from '../conformance/cases.mjs';
import { mediaOf, senderOf } from '../adapters/telegram/content.mjs';

const FIXTURES = path.join(import.meta.dirname, '..', 'adapters', 'telegram', 'fixtures');

const CHAT = '887766554';
const GROUP = '-1001234567890';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function context(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-telegram-'));
  const { agent, account } = fixture('context.json');
  return {
    store: Store.open(path.join(dir, 'store')),
    adapter,
    agent,
    account,
    channel: fixture('channel.json'),
    items: [],
    dry_run: true,
    now: Date.parse('2026-09-10T11:00:00.000Z'),
    ...overrides
  };
}

// ---- identity and the two positions -----------------------------------------

test('a conversation is the account and the chat, and a message is that plus the chat-local id', () => {
  const c = context();
  const [first] = ingest(c, fixture('inbound.json').slice(0, 1));
  assert.equal(first.record.conversation_id, `${c.account}:${CHAT}`);
  assert.equal(first.record.message_id, `${c.account}:${CHAT}:101`);
  assert.equal(first.record.platform_message_id, '101');
  assert.equal(first.record.source, 'telegram');
  assert.equal(first.record.conversation_kind, 'direct');
});

test('a group chat is a group, and the participant is the sender rather than the chat', () => {
  const c = context();
  const [written] = ingest(c, fixture('group.json'));
  assert.equal(written.record.conversation_id, `${c.account}:${GROUP}`);
  assert.equal(written.record.conversation_kind, 'group');
  assert.equal(written.record.sender_id, '4455667');
  assert.equal(written.record.sender_name, 'Ada Byron');
});

test('a channel post speaks as the channel, because it carries no sender of its own', () => {
  const post = { message_id: 5, chat: { id: -100999, type: 'channel', title: 'Notices' }, date: 1789039400, text: 'Posted.' };
  assert.deepEqual(senderOf(post), { id: '-100999', name: 'Notices', is_bot: false });
});

test('the update offset is a cursor of its own, and consume is the only thing that moves it', () => {
  const c = context();
  const items = fixture('inbound.json');
  assert.equal(adapter.nextOffset(c.store, c.account), null);

  ingest(c, items.slice(0, 1));
  assert.equal(adapter.nextOffset(c.store, c.account), null,
    'the offset moved on a capture alone, which would confirm an update before the record was consumed');

  adapter.consume(c, items[0]);
  assert.equal(adapter.nextOffset(c.store, c.account), 900002);

  ingest(c, items.slice(1));
  adapter.consume(c, items[1]);
  assert.equal(adapter.nextOffset(c.store, c.account), 900003);
});

test('an update the adapter cannot read still moves the offset, or the poll meets it forever', () => {
  const c = context();
  const item = {
    conversation: null,
    position: null,
    received_at: '2026-09-10T09:56:00.000Z',
    update: { update_id: 900020, message_reaction: { chat: { id: 1 } } }
  };
  const { entries, parked } = adapter.payload(c, [item]);
  assert.equal(entries.length, 0);
  assert.equal(parked.length, 1);
  assert.match(parked[0].reason, /message_reaction/);
  adapter.consume(c, item);
  assert.equal(adapter.nextOffset(c.store, c.account), 900021);
});

// ---- albums ------------------------------------------------------------------

test('every item of an album is its own record, and each carries the group id', () => {
  const c = context();
  const items = fixture('album.json');
  const written = ingest(c, items);
  assert.equal(written.length, 3, 'an album lost an item, which is the gap PA-147 names');
  const ids = written.map((one) => one.record.message_id);
  assert.equal(new Set(ids).size, 3);
  for (const one of written) {
    assert.equal(one.record.adapter_fields.media_group_id, '13500000000000001');
  }
  assert.equal(written[0].record.body, 'The three pages of the signed order.');
  assert.equal(written[1].record.body, '', 'only the first item of an album carries the caption');
  assert.equal(c.store.rebuild().length, 3);
});

// ---- attachments --------------------------------------------------------------

test('the largest size of a photograph is the one kept, and a thumbnail is not the attachment', () => {
  const [, photo] = fixture('attachment.json');
  const media = mediaOf(photo.update.message);
  assert.equal(media.file_id, 'AgACth0002');
  assert.equal(media.bytes, 184320);
  assert.equal(media.mime, 'image/jpeg');
});

test('a caption is the body of a message that carries a file', () => {
  const c = context();
  const [document] = ingest(c, fixture('attachment.json').slice(0, 1));
  assert.equal(document.record.body, 'The invoice is attached.');
  assert.equal(document.record.attachments[0].filename, 'august-invoice.txt');
  assert.equal(document.record.adapter_fields.file_name, 'august-invoice.txt');
});

// ---- who is who --------------------------------------------------------------

test('a sender the declaration names as an operator holds the agent, and nobody else does', () => {
  const c = context();
  const [operator] = ingest(c, fixture('operator.json'));
  assert.equal(operator.record.role, 'operator');
  assert.equal(operator.record.hold.release_after_ms, 3600000);

  const [contact] = ingest(c, fixture('inbound.json').slice(0, 1));
  assert.equal(contact.record.role, 'contact');
  assert.equal(contact.record.hold, undefined);
});

test('the bot\'s own message is the agent\'s, outbound, and never an operator', () => {
  const c = context();
  const [own] = ingest(c, fixture('own.json'));
  assert.equal(own.record.role, 'agent');
  assert.equal(own.record.direction, 'outbound');
  assert.equal(own.record.hold, undefined);
});

test('a chat the declaration does not name is captured and never answered', () => {
  const c = context();
  const [stranger] = ingest(c, fixture('stranger.json'));
  assert.equal(stranger.record.disposition, 'policy-drop');
  assert.equal(stranger.record.body, 'Hello, is this thing on?');
  assert.throws(() => adapter.send(c, {
    ...stranger.record,
    conversation_id: `${c.account}:123123123`,
    delivery: { request_id: 'req-stranger', status: 'pending' }
  }), (error) => error.faults[0].code === 'CHAT_NOT_DECLARED');
});

test('the word any answers whoever writes, and a list answers only the chats it names', () => {
  assert.equal(adapter.answersIn({ allowed_chat_ids: 'any' }, 999), true);
  assert.equal(adapter.answersIn({ allowed_chat_ids: [1, 2] }, 2), true);
  assert.equal(adapter.answersIn({ allowed_chat_ids: [1, 2] }, 3), false);
  assert.equal(adapter.answersIn({ allowed_chat_ids: undefined }, 3), false,
    'a channel that says nothing about its chats answers none of them');
});

// ---- the reply ----------------------------------------------------------------

test('a reply at the limit goes in one piece and a reply past it is cut at a paragraph', () => {
  assert.deepEqual(adapter.splitBody('x'.repeat(4096)), ['x'.repeat(4096)]);
  const body = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
  const chunks = adapter.splitBody(body);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'a'.repeat(3000));
  assert.equal(chunks[1], 'b'.repeat(3000));
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
});

test('one word longer than a whole message is still cut, because the server refuses the message otherwise', () => {
  const chunks = adapter.splitBody('z'.repeat(9000));
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  assert.equal(chunks.join(''), 'z'.repeat(9000));
});

test('a reply in a group hangs under the message it answers, and a private one does not', () => {
  const c = context();
  ingest(c, fixture('group.json'));
  const record = {
    conversation_id: `${c.account}:${GROUP}`,
    conversation_kind: 'group',
    reply_to: '117'
  };
  assert.equal(adapter.replyTarget(c, record).platform_message_id, '117');
  assert.equal(adapter.chatIdOf(c, record), GROUP);
});

test('the newest captured message is what a reply answers when the model named none', () => {
  const c = context();
  ingest(c, fixture('inbound.json'));
  const target = adapter.replyTarget(c, { conversation_id: `${c.account}:${CHAT}` });
  assert.equal(target.platform_message_id, '102');
});

test('an item is matched to the delivery it belongs to by its id, and by its text', () => {
  const c = context();
  const [item] = fixture('inbound.json');
  assert.equal(adapter.matchesDelivery(c, item, { chunk_ids: ['101'] }), true);
  assert.equal(adapter.matchesDelivery(c, item, { chunk_ids: ['999'] }), false);
  assert.equal(adapter.matchesDelivery(c, item, {
    chunk_ids: [],
    text_sha256: '1e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }), false);
});

// ---- what a failed send means --------------------------------------------------

test('the server refusing is a failed send, and everything else is unknown', async () => {
  const { TelegramFault } = await import('../adapters/telegram/api.mjs');
  const refused = new TelegramFault([{ code: 'BOT_API_REFUSED', subject: 'sendMessage', problem: '', fix: '' }]);
  const unreachable = new TelegramFault([{ code: 'BOT_API_UNREACHABLE', subject: 'sendMessage', problem: '', fix: '' }]);
  assert.equal(adapter.outcomeOf(refused, 0), 'failed');
  assert.equal(adapter.outcomeOf(unreachable, 0), 'unknown');
  assert.equal(adapter.outcomeOf(refused, 2), 'unknown',
    'a refusal after some chunks went out is unknown, because part of the reply is in the chat');
});
