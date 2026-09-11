// The Telegram adapter: one bot in, one bot out.
//
// It declares inbound and outbound, so the conformance check runs sixteen of the
// seventeen cases against it; the seventeenth belongs to an import and this
// adapter imports nothing.
//
// This file is the adapter contract and nothing else. It opens no connection,
// reads no file and imports nothing that does: api.mjs is the only file here
// that touches a network, live.mjs is the only one that keeps state between
// passes, and every rule below is therefore tested against recorded updates with
// no network in the test.
//
// The six decisions that make this adapter what it is:
//
// 1. **The offset is the watermark, and it moves only after a capture is on
//    disk.** The Bot API deletes an update when the next `getUpdates` asks for a
//    higher offset, so an offset advanced before the record is written is a
//    message the server will never send again and this box never wrote. The
//    offset therefore lives in the store's own cursor, under a conversation id
//    shaped like the account's update stream, and `consume` is the only thing
//    that moves it — the same place, and the same write order, as every other
//    cursor here.
// 2. **A message's position is its chat-local id, not its update id.** Telegram
//    numbers messages in a chat in order, and an edit arrives carrying the
//    *edited* message's id, which is how a correction of something read long ago
//    sits below the message cursor and above the revision cursor, which is what
//    case 17 is about. The update id orders the stream; the message id orders the
//    conversation, and the two are different things.
// 3. **A bot is reachable by anyone who knows its name.** That is not true of a
//    mailbox or a paired phone, and it is the fact this adapter is shaped around:
//    the declaration names the chats the agent answers, a message from any other
//    chat is captured and never answered, and `send` refuses a reply to one.
// 4. **Every item of an album is its own record.** See content.mjs for why, and
//    for what the other chat adapter here does instead.
// 5. **The operator is a sender id the declaration names.** Telegram gives no
//    "this came from my own device" the way a paired phone does, because the bot
//    and the person are two accounts. So who the operator is, is a declared fact;
//    a message from one holds the agent per the channel's hold block.
// 6. **A reply is chunked at the limit and every chunk id is written back.** The
//    Bot API refuses a message over 4096 characters outright, so a long answer is
//    several messages, and a person reading the store can find each of them in
//    the chat.
//
// The whole list of edge cases this adapter was built against is README.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fault } from '../../stream/faults.mjs';
import { StreamFault } from '../../stream/store.mjs';
import { albumOf, bodyOf, conversationKind, mediaOf, messageOf, readable, senderOf, serviceKindOf } from './content.mjs';
import { TelegramFault, call, readToken } from './api.mjs';
import { nextOffset, offsetPositionOf, positionOf, updatesConversation } from './cursors.mjs';
import { arrivals, stop, transportFor } from './live.mjs';

export const capabilities = ['inbound', 'outbound'];

export const SOURCE = 'telegram';

// The Bot API refuses a `text` longer than this outright, with a 400 and no
// partial send. The declaration governs; this is what the adapter uses when it is
// run without one, as the conformance check runs it.
export const MAX_MESSAGE_CHARS = 4096;

// How long the agent stops when the operator writes in a chat. The declaration
// governs; this is the value used without one, and it is a day because that is
// how long it took an earlier platform to learn that a shorter one puts the agent
// back into a conversation a person is still handling.
export const HOLD_MS = 24 * 60 * 60 * 1000;

// This channel is drained, not fetched: a background long poll sits at the
// server and what it has already collected is handed over when the loop asks, so
// there is no request rate here to limit and no floor to declare. The interval is
// still the declaration's, because it decides how long a message waits before the
// loop looks at it.
export const POLL_INTERVAL_FLOOR_MS = 0;

export const DEFAULTS = {
  allowed_chat_ids: 'any',
  operator_sender_ids: [],
  max_message_chars: MAX_MESSAGE_CHARS,
  max_attachment_bytes: 20000000,
  mode: 'polling',
  long_poll_timeout_s: 25,
  hold: { release_after_ms: HOLD_MS }
};

// ---- the declaration --------------------------------------------------------

// On a box the runtime passes the channel's declaration block as context.channel,
// with `transport` merged in and every secret reference resolved to a path. The
// conformance check passes no declaration at all, so an adapter's fixtures
// directory may carry channel.json and the check's fixture loading hands it here.
// Nothing else reads it.
export function channelOf(context) {
  const declared = context.channel ?? context.fixtures?.['channel.json'] ?? {};
  return {
    ...DEFAULTS,
    ...declared,
    hold: { ...DEFAULTS.hold, ...(declared.hold ?? {}) }
  };
}

// Whether this agent answers in this chat. "any" is a deliberate word and not an
// empty list: a bot answers whoever writes to it only where somebody has written
// that down.
export function answersIn(channel, chatId) {
  const allowed = channel.allowed_chat_ids;
  if (allowed === 'any') return true;
  if (!Array.isArray(allowed)) return false;
  return allowed.map(String).includes(String(chatId));
}

export function isOperator(channel, senderId) {
  return (channel.operator_sender_ids ?? []).map(String).includes(String(senderId));
}

// ---- identifiers ------------------------------------------------------------

// The two positions this channel counts in are cursors.mjs's, and they are there
// rather than here because the poll needs them too and neither file should have
// to import the other to get them.
export { positionOf, offsetPositionOf, updatesConversation, nextOffset };

function sha256(text) {
  return crypto.createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

// ---- reading one item -------------------------------------------------------

// An item is what the poller produced and what a fixture holds:
//   { conversation, position, received_at, update, attachments?, extra? }
// where `update` is the Bot API's own Update object, unchanged.
function chatOf(item) {
  const { message } = messageOf(item?.update);
  const chat = message?.chat;
  if (chat === null || chat === undefined || chat.id === undefined) {
    throw new StreamFault([fault('CHAT_ABSENT', String(item?.update?.update_id ?? 'an update'),
      'the update names no chat, so there is no conversation to write it under',
      'ask the server only for the update types this adapter reads; anything else is dropped at the poll')]);
  }
  return chat;
}

export function conversationIdOf(context, item) {
  return `${context.account}:${chatOf(item).id}`;
}

export function kindOf(item) {
  return messageOf(item?.update).edited ? 'revision' : 'message';
}

// ---- 1. list what is pending past the cursors --------------------------------

export function listPending(context) {
  return (context.items ?? []).filter((item) => pastCursors(context, item));
}

function pastCursors(context, item) {
  let conversation;
  try {
    conversation = conversationIdOf(context, item);
  } catch {
    return true; // an update the store will refuse; let it refuse at capture
  }
  let cursors;
  try {
    cursors = context.store.cursors(conversation);
  } catch {
    return true;
  }
  const kind = kindOf(item);
  const at = cursors[kind];
  if (at === null || String(item.position) > at) return true;

  // A revision sits below the message cursor by design: its position is the
  // position of the message it corrects, which is what makes "below the message
  // cursor" mean anything. The revision cursor cannot decide on its own either,
  // because an edit of an older message than the last edited one sits below it.
  // So for a revision the cursor is the fast path and the store is the answer: an
  // edit already written carries the moment it was made, and one that is not
  // there is pending however the positions fall.
  if (kind !== 'revision') return false;
  const editedAt = messageOf(item.update).message?.edit_date;
  return !context.store.recordsIn(conversation)
    .some((record) => record.adapter_fields?.edit_date === editedAt);
}

// ---- 2. consume one item -----------------------------------------------------

// The only place a cursor moves, and it moves two: the conversation's, and the
// account's update offset, which is what the next getUpdates asks past. Both
// move after the capture is on disk, which is the whole durability of this
// channel: an offset the server has seen is a message the server will not send
// again.
export function consume(context, item) {
  let conversation = null;
  try {
    conversation = conversationIdOf(context, item);
  } catch { /* an update with no chat still has to move the offset, or it is met forever */ }
  if (conversation !== null) {
    context.store.advanceCursor(conversation, kindOf(item), item.position);
  }
  const updateId = item?.update?.update_id;
  if (updateId !== undefined) {
    context.store.advanceCursor(updatesConversation(context.account), 'message', offsetPositionOf(updateId));
  }
}

// ---- 3. turn a batch into the payload ----------------------------------------

export function payload(context, items) {
  const channel = channelOf(context);
  const entries = [];
  const parked = [];
  const revisions = new Map();

  for (const item of items) {
    const cursor = { kind: kindOf(item), position: item.position };
    const raw = item.raw ?? JSON.stringify(item.update ?? item);
    const read = messageOf(item.update);

    // An update type the server sent that this adapter has no reading for. It is
    // parked where it landed, never dropped: it happened in the client's chat.
    if (read.message === null) {
      parked.push({
        record: smallestRecord(context, item, `${context.account}:unreadable`,
          `${context.account}:unreadable:update-${item.update?.update_id ?? 'unknown'}`,
          String(item.update?.update_id ?? 'unknown')),
        raw,
        cursor,
        reason: `the update is a ${read.unknown} this adapter does not read`
      });
      continue;
    }

    const message = read.message;
    const chat = chatOf(item);
    const conversation_id = `${context.account}:${chat.id}`;
    const platform_message_id = String(message.message_id);
    const sender = senderOf(message);
    const album = albumOf(message);
    const media = mediaOf(message);

    // The bot's own message, coming back because it is an administrator of the
    // chat it posted in. It is already in the store as the outbound record that
    // produced it, and it is emphatically not a person speaking, so it is
    // recorded as the agent's and the release loop leaves an outbound record
    // alone.
    const isOwn = sender.is_bot && channel.bot_id !== undefined && String(sender.id) === String(channel.bot_id);
    const operator = !isOwn && isOperator(channel, sender.id);

    let revision = 0;
    if (read.edited) {
      const counted = revisions.get(platform_message_id)
        ?? countRevisions(context, conversation_id, platform_message_id);
      revision = counted;
      revisions.set(platform_message_id, counted + 1);
    }

    const record = {
      schema: 'carbon.message.v1',
      agent: context.agent,
      source: SOURCE,
      account: context.account,
      conversation_id,
      conversation_kind: conversationKind(chat),
      message_id: `${conversation_id}:${platform_message_id}`,
      platform_message_id,
      revision,
      direction: isOwn ? 'outbound' : 'inbound',
      role: isOwn ? 'agent' : (operator ? 'operator' : 'contact'),
      sender_id: sender.id,
      received_at: item.received_at ?? new Date(context.now ?? Date.now()).toISOString(),
      body: bodyOf(message),
      attachments: [],
      historical: false,
      // A chat the declaration does not name is captured and never answered, the
      // way a mail to an undeclared address is: a bot's name is public, so a
      // stranger writing to it is an ordinary event and not an incident.
      disposition: answersIn(channel, chat.id) ? 'captured' : 'policy-drop'
    };

    const sentAt = typeof message.date === 'number' ? new Date(message.date * 1000).toISOString() : null;
    if (sentAt) record.sent_at = sentAt;
    if (sender.name !== undefined) record.sender_name = sender.name;
    if (message.reply_to_message?.message_id !== undefined) {
      record.reply_to = String(message.reply_to_message.message_id);
    }

    // A person answering in the chat is signal, not noise: the agent stops while
    // somebody is handling the conversation.
    if (operator) {
      record.hold = {
        reason: 'an operator this channel names wrote in this chat',
        set_at: sentAt ?? record.received_at,
        release_after_ms: channel.hold?.release_after_ms ?? HOLD_MS
      };
    }

    // Only what is exceptional is carried, so a field a newer adapter puts on an
    // item reaches the record untouched.
    const fields = { ...(item.extra ?? {}) };
    if (album) fields.media_group_id = album;
    if (read.edited && message.edit_date !== undefined) fields.edit_date = message.edit_date;
    if (read.channel_post) fields.channel_post = true;
    if (message.message_thread_id !== undefined) fields.message_thread_id = message.message_thread_id;
    if (media?.file_name) fields.file_name = media.file_name;
    if (message.forward_origin !== undefined) fields.forwarded = true;
    if (Object.keys(fields).length > 0) record.adapter_fields = fields;

    // The one fixture-shaped field this adapter honours: a channel cannot produce
    // a declared field of the wrong type, and case 14 must see one refused.
    // Nothing on a box sets it.
    if (item.wrong_type !== undefined) Object.assign(record, item.wrong_type);

    // A message with neither words nor media is a service message: somebody
    // joined, the title changed, a message was pinned. It is parked, not dropped.
    if (!readable(message)) {
      parked.push({
        record: { ...record, body: '', disposition: 'parked' },
        raw,
        cursor,
        reason: `the message carries ${serviceKindOf(message)}, which this adapter does not read`
      });
      continue;
    }

    entries.push({ record, raw, cursor, attachments: attachmentsFor(item, media) });
  }

  return { entries, parked };
}

// The smallest record that still names the conversation and the message.
function smallestRecord(context, item, conversation_id, message_id, platform_message_id) {
  return {
    schema: 'carbon.message.v1',
    agent: context.agent,
    source: SOURCE,
    account: context.account,
    conversation_id,
    conversation_kind: 'direct',
    message_id,
    platform_message_id,
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: 'unknown',
    received_at: item.received_at ?? new Date(context.now ?? Date.now()).toISOString(),
    body: '',
    attachments: [],
    historical: false,
    disposition: 'parked'
  };
}

function countRevisions(context, conversation_id, platform_message_id) {
  try {
    return context.store.recordsIn(conversation_id)
      .filter((record) => record.platform_message_id === String(platform_message_id)).length;
  } catch {
    return 0;
  }
}

// Media arrives on the item, already fetched: the poll downloads it before it
// hands the batch over, and a fixture carries what was recorded. This operation
// does no input or output of its own, which is what keeps every rule above
// testable with no network. Where the message carries media and the item carries
// none, the record says the download failed and is released anyway, because the
// words of a message with a picture are usually the part that matters.
function attachmentsFor(item, media) {
  if (Array.isArray(item.attachments)) return item.attachments;
  if (!media) return [];
  return [{
    file: `unavailable/${media.file_id}`,
    filename: media.file_name,
    mime: media.mime,
    bytes: media.bytes,
    sha256: '0'.repeat(64),
    download_failed: true
  }];
}

// ---- 4. say whether an item is the one a delivery record names ---------------

export function matchesDelivery(context, item, delivery) {
  const { message } = messageOf(item?.update);
  if (message === null) return false;
  if ((delivery?.chunk_ids ?? []).includes(String(message.message_id))) return true;
  return sha256(bodyOf(message)) === delivery?.text_sha256;
}

// ---- 5. send -----------------------------------------------------------------

// A reply longer than the channel accepts is split, and every chunk's id is
// written back, so a person reading the store can find each piece in the chat.
// The cut is at a paragraph, then a sentence, then a word, and only at a
// character when a single word is longer than a whole message.
export function splitBody(body, max = MAX_MESSAGE_CHARS) {
  const text = body ?? '';
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('. ');
    if (cut > 0 && cut < max / 2) cut = -1;
    if (cut < 0) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// The inbound this reply answers, which is what gives a reply in a group
// something to hang under. The record names it when the model did; otherwise it
// is the newest thing captured in the conversation, which is what a person
// replying in a chat would be answering.
export function replyTarget(context, record) {
  const inbound = context.store.recordsIn(record.conversation_id)
    .filter((held) => held.direction === 'inbound' && held.disposition !== 'parked');
  if (inbound.length === 0) return null;
  if (record.reply_to !== undefined) {
    const named = inbound.find((held) => held.platform_message_id === String(record.reply_to));
    if (named !== undefined) return named;
  }
  return inbound
    .sort((a, b) => String(a.sent_at ?? a.received_at).localeCompare(String(b.sent_at ?? b.received_at)))
    .at(-1);
}

export function chatIdOf(context, record) {
  return record.conversation_id.slice(String(context.account).length + 1);
}

// The check calls send with dry_run and reads the result directly, so the dry run
// answers synchronously. A live send cannot: it returns a promise, and the
// runtime awaits it. Awaiting the synchronous answer is also correct, so one
// caller works for both.
export function send(context, record) {
  const channel = channelOf(context);
  const chat = chatIdOf(context, record);
  if (!answersIn(channel, chat)) {
    throw new TelegramFault([fault('CHAT_NOT_DECLARED', record.conversation_id,
      'this chat is not one the declaration names, so it is captured and never answered',
      'add the chat id to transport.allowed_chat_ids if the agent works this chat, or leave the message unanswered')]);
  }
  const chunks = splitBody(record.body, channel.max_message_chars ?? MAX_MESSAGE_CHARS);

  if (context.dry_run) {
    return {
      status: 'sent',
      chunk_ids: chunks.map((chunk, i) => `dry-run-${record.delivery.request_id}-${i}-${sha256(chunk).slice(0, 8)}`)
    };
  }
  return sendLive(context, record, channel, chat, chunks);
}

async function sendLive(context, record, channel, chat, chunks) {
  const transport = context.transport ?? transportFor(context);
  const chunk_ids = [];

  // Threading: in a group a bare message is one of many and a reply hangs under
  // the message it answers, which is how a person reading the chat can tell what
  // the agent was answering. In a private chat everything is already in one
  // thread and the quoted block is noise, so only the first chunk of a group
  // reply carries it.
  const target = record.conversation_kind === 'direct' ? null : replyTarget(context, record);
  const replyTo = target === null ? null : Number(target.platform_message_id);

  for (const [index, chunk] of chunks.entries()) {
    const params = { chat_id: chat, text: chunk };
    if (index === 0 && replyTo !== null && Number.isFinite(replyTo)) {
      params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    }
    let sent;
    try {
      sent = await call(transport, 'sendMessage', params);
    } catch (error) {
      return { status: outcomeOf(error, chunk_ids.length), chunk_ids };
    }
    chunk_ids.push(String(sent?.message_id ?? ''));
  }

  // An attachment the model put on the reply. It goes as a document rather than
  // as a photo whatever it is, because a photo sent as a photo is recompressed
  // by the server and a document is the bytes the store holds.
  for (const attachment of record.attachments ?? []) {
    if (attachment.download_failed === true) continue;
    let sent;
    try {
      sent = await sendAttachment(context, transport, chat, attachment);
    } catch (error) {
      return { status: outcomeOf(error, chunk_ids.length), chunk_ids };
    }
    chunk_ids.push(String(sent?.message_id ?? ''));
  }

  return { status: 'sent', chunk_ids };
}

async function sendAttachment(context, transport, chat, attachment) {
  const bytes = fs.readFileSync(context.store.under(attachment.file));
  const form = new FormData();
  form.append('chat_id', String(chat));
  form.append('document', new Blob([bytes], { type: attachment.mime ?? 'application/octet-stream' }),
    attachment.file.split('/').pop());
  return callForm(transport, 'sendDocument', form);
}

// The one method that is not JSON. A document is multipart, because the Bot API
// takes the bytes in the request rather than a url it would have to fetch from
// this box, which the host contract gives it no way to do.
async function callForm(transport, method, form) {
  const { token, apiHost = 'api.telegram.org' } = transport;
  const response = await fetch(`https://${apiHost}/bot${token}/${method}`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null);
  if (body?.ok !== true) {
    throw new TelegramFault([fault('BOT_API_REFUSED', method,
      `the Bot API answered ${body?.error_code ?? response.status}`,
      'read the record\'s attachment; the reply text went out and the file did not')],
    { errorCode: body?.error_code ?? response.status });
  }
  return body.result;
}

// What a failed send means. Doubt resolves to unknown and never to failed,
// because a failed send may be retried and an unknown one may not: claiming a
// send failed when nobody knows is how a contact gets the same message twice.
//
// The Bot API is unusually clear here and the clarity is worth using. A `{ok:
// false}` body is the server's own answer, which means the request arrived and
// was refused, so nothing went out and the send failed. Anything else — a
// timeout, a reset, a DNS failure — happened where nobody can see whether the
// server acted, and is unknown.
export function outcomeOf(error, sentSoFar = 0) {
  if (sentSoFar > 0) return 'unknown';
  if (error instanceof TelegramFault && error.faults?.[0]?.code === 'BOT_API_REFUSED') return 'failed';
  return 'unknown';
}

// ---- 6. go to the channel ----------------------------------------------------

// The long poll is opened on the first pass and kept, and what arrives on it is
// held until the loop asks. Everything about that is live.mjs's; this file still
// opens nothing itself.
export async function poll(context) {
  return { items: await arrivals({ ...context, channel: channelOf(context) }) };
}

// ---- 7. stop -----------------------------------------------------------------

// The long poll is a task that outlives a pass, so this channel has an ending and
// most do not. Without it a runtime that has finished its work and returned would
// not exit, because a pending call keeps the process alive.
export { stop };

export { readToken };
