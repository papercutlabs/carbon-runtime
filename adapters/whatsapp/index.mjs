// The WhatsApp adapter.
//
// It speaks to WhatsApp through an unofficial library that pairs as a linked
// device, the way the desktop app does. That is a deliberate choice and not a
// stopgap: the official business API is not used on this programme.
//
// This file is the adapter contract and nothing else. It holds no socket, opens
// no connection and imports no library: it turns recorded events into records
// and turns a reply into chunks. The socket lives in socket.mjs, which is the
// only file here that loads the library, so every rule below is testable against
// recorded events with no network in the test.
//
// The five operations are stream/adapter.md's. What is particular to this
// channel is written where it applies, and the whole list of edge cases this
// adapter was built against, with what it does about each, is README.md.

import crypto from 'node:crypto';
import { fault } from '../../stream/faults.mjs';
import { StreamFault } from '../../stream/store.mjs';
import {
  canonicalChatKey, canonicalParticipant, conversationKind, pairsIn
} from './jid.mjs';
import { albumOf, editOf, isHdChild, read, revokeOf } from './content.mjs';
import { learnPairs } from './channel-state.mjs';

export const capabilities = ['inbound', 'outbound'];

export const SOURCE = 'whatsapp';

// WhatsApp refuses a text body beyond roughly four thousand characters, so a
// long reply is split. The declaration governs; this is what the adapter uses
// when it is run without one, as the conformance check runs it.
export const MAX_MESSAGE_CHARS = 4096;

// An album arrives as several messages over a second or two. The adapter waits
// for the album to go quiet before it releases any of it, so the agent sees one
// set of pictures and not five arrivals. The declaration governs; this is the
// value used without one.
export const ALBUM_QUIET_MS = 2000;

// A message the operator sent from their own phone holds the agent. How long
// the hold lasts is the declaration's business; this is the value used without
// one, and it is a day because that is how long it took the earlier platform to
// learn that a shorter one puts the agent back into a conversation a person is
// still handling.
export const HOLD_MS = 24 * 60 * 60 * 1000;

// ---- identity ---------------------------------------------------------------

function keyOf(item) {
  return item?.event?.key ?? {};
}

function messageOf(item) {
  return item?.event?.message ?? {};
}

export function chatKeyOf(item) {
  const chat = canonicalChatKey(keyOf(item));
  if (!chat) {
    throw new StreamFault([fault('CHAT_KEY_ABSENT', item?.position ?? 'an event',
      'the event names no chat, so there is no conversation to write it under',
      'drop the event at the socket, or record the chat the server sent it for')]);
  }
  return chat;
}

export function conversationIdOf(context, item) {
  return `${context.account}:${chatKeyOf(item)}`;
}

function arrivalMs(item) {
  if (typeof item.received_at === 'string') {
    const parsed = Date.parse(item.received_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const stamp = Number(item?.event?.messageTimestamp ?? 0);
  return Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : 0;
}

function sentAt(item) {
  const at = arrivalMs(item);
  return at > 0 ? new Date(at).toISOString() : null;
}

function kindOf(item) {
  return editOf(messageOf(item)) ? 'revision' : 'message';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

// ---- 1. list what is pending past the cursors --------------------------------

// Two things sit between an event and the agent. The cursors, which say what has
// already been read; and the album window, which holds a picture back until the
// rest of its album has arrived, so a set of six photographs is one arrival and
// not six.
export function listPending(context) {
  const items = context.items ?? [];
  const quiet = context.channel?.album_quiet_ms ?? ALBUM_QUIET_MS;
  const now = context.now ?? Date.now();

  const lastOfAlbum = new Map();
  for (const item of items) {
    const album = albumOf(messageOf(item));
    if (!album) continue;
    lastOfAlbum.set(album.album_id, Math.max(lastOfAlbum.get(album.album_id) ?? 0, arrivalMs(item)));
  }

  return items.filter((item) => {
    if (!pastCursors(context, item)) return false;
    const album = albumOf(messageOf(item));
    if (album && now - (lastOfAlbum.get(album.album_id) ?? 0) < quiet) return false;
    return true;
  });
}

function pastCursors(context, item) {
  const conversation = conversationIdOf(context, item);
  const cursors = context.store.cursors(conversation);
  const kind = kindOf(item);
  const at = cursors[kind];
  if (at === null || String(item.position) > at) return true;

  // A revision sits below the message cursor by design: it names a message that
  // was read long ago, and its position is that message's position, which is
  // what makes "below the message cursor" mean anything. That also means the
  // revision cursor cannot decide on its own whether an edit is new, because an
  // edit of an older message than the last edited one sits below it. So for a
  // revision the cursor is the fast path and the store is the answer: an edit
  // already written carries its own event id, and one that is not there is
  // pending however the positions fall.
  if (kind !== 'revision') return false;
  const editKeyId = keyOf(item).id;
  return !context.store.recordsIn(conversation)
    .some((record) => record.adapter_fields?.edit_key_id === editKeyId);
}

// ---- 2. consume one item -----------------------------------------------------

export function consume(context, item) {
  context.store.advanceCursor(conversationIdOf(context, item), kindOf(item), item.position);
}

// ---- 3. turn a batch into the payload ----------------------------------------

export function payload(context, items) {
  const entries = [];
  const parked = [];
  const revisions = new Map();
  const own = new Map();

  for (const item of items) {
    const key = keyOf(item);
    const message = messageOf(item);

    // The second, higher-definition upload of a picture the sender's app already
    // sent. Recording it would put every photograph in the store twice.
    if (isHdChild(message)) continue;

    const conversation_id = conversationIdOf(context, item);
    const chat = chatKeyOf(item);
    const cursor = { kind: kindOf(item), position: item.position };
    const raw = item.raw ?? JSON.stringify(item.event ?? item);

    // The agent's own reply comes back down the socket as a message from this
    // device. It is already in the store as the outbound record that produced
    // it, so it is not captured a second time, and it is emphatically not an
    // operator speaking.
    if (key.fromMe === true && isOwnSend(context, own, conversation_id, item)) continue;

    const edit = editOf(message);
    const platform_message_id = edit ? edit.replaces : key.id;
    const content = read(edit ? edit.message : message);
    const revoke = revokeOf(message);
    const album = albumOf(message);

    let revision = 0;
    if (edit) {
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
      platform_message_id: String(platform_message_id ?? ''),
      revision,
      direction: 'inbound',
      role: key.fromMe === true ? 'operator' : 'contact',
      sender_id: senderOf(context, item, chat),
      received_at: item.received_at ?? new Date(context.now ?? Date.now()).toISOString(),
      body: content.text ?? '',
      attachments: [],
      historical: false,
      disposition: 'captured'
    };

    const sent_at = sentAt(item);
    if (sent_at) record.sent_at = sent_at;
    if (typeof item.event?.pushName === 'string' && item.event.pushName.length > 0) {
      record.sender_name = item.event.pushName;
    }

    // An operator answering from their own phone is signal, not noise: the
    // agent stops while a person is handling the conversation.
    if (key.fromMe === true) {
      record.hold = {
        reason: 'the operator answered in this chat from their own device',
        set_at: sent_at ?? record.received_at,
        release_after_ms: context.channel?.hold?.release_after_ms ?? HOLD_MS
      };
    }

    // Only what is exceptional is carried here. A plain message from a contact
    // adds nothing, so a field a newer adapter puts on an item arrives at the
    // record untouched.
    const fields = { ...(item.extra ?? {}) };
    if (edit) fields.edit_key_id = key.id;
    if (revoke) fields.revoked_message_id = revoke.revoked;
    if (album) { fields.album_id = album.album_id; fields.album_index = album.index; }
    if (content.reaction_to) fields.reaction_to = content.reaction_to;
    if (message?.associatedChildMessage) fields.hd_variant_skipped = true;
    if (content.media?.file_name) fields.file_name = content.media.file_name;
    if (Object.keys(fields).length > 0) record.adapter_fields = fields;

    if (item.wrong_type !== undefined) Object.assign(record, item.wrong_type);

    // The map exists for one caller, the history import, and it learns only
    // from events that carry both forms of one identity side by side. An event
    // that carries one form alone teaches it nothing, which is why a hostile
    // identifier cannot reach it.
    learnPairs(context.store, context.account, pairsIn(key));

    if (content.kind === null) {
      parked.push({
        record: { ...record, body: '' },
        raw,
        cursor,
        reason: `the message is a ${content.unknown ?? 'kind'} this adapter does not read`
      });
      continue;
    }

    entries.push({ record, raw, cursor, attachments: attachmentsFor(context, item, content) });
  }

  return { entries, parked };
}

function senderOf(context, item, chat) {
  const key = keyOf(item);
  if (key.fromMe === true) return context.account;
  // In a group every message is one participant's, and collapsing them onto the
  // group makes every sender look the same. The participant is the sender.
  const participant = canonicalParticipant(key);
  if (participant) return participant;
  return chat;
}

function countRevisions(context, conversation_id, platform_message_id) {
  try {
    return context.store.recordsIn(conversation_id)
      .filter((record) => record.platform_message_id === String(platform_message_id)).length;
  } catch {
    return 0;
  }
}

// The agent's own send, coming back as a message from this device. Two ways to
// know it: the event's id is one of the chunk ids a delivery wrote back, which
// is exact; or the text is the text an outbound record on this conversation
// carries, which catches the echo that arrives in the moment between the send
// and the chunk ids being written.
function isOwnSend(context, cache, conversation_id, item) {
  if (!cache.has(conversation_id)) {
    let ids = new Set();
    let texts = new Set();
    try {
      for (const record of context.store.recordsIn(conversation_id)) {
        if (record.direction !== 'outbound' || !record.delivery) continue;
        for (const id of record.delivery.chunk_ids ?? []) ids.add(id);
        if (record.delivery.text_sha256) texts.add(record.delivery.text_sha256);
      }
    } catch { ids = new Set(); texts = new Set(); }
    cache.set(conversation_id, { ids, texts });
  }
  const { ids, texts } = cache.get(conversation_id);
  if (ids.has(keyOf(item).id)) return true;
  return texts.has(sha256(read(messageOf(item)).text ?? ''));
}

// Media arrives on the item, already fetched: the socket downloads it before it
// hands the batch over, and a fixture carries what was recorded. This operation
// does no input or output of its own, which is what keeps every rule above
// testable with no network. Where the message carries media and the item carries
// none, the record says the download failed and is released anyway, because the
// text of a message with a picture is usually the part that matters.
function attachmentsFor(context, item, content) {
  if (Array.isArray(item.attachments)) return item.attachments;
  if (!content.media) return [];
  return [{
    file: `unavailable/${keyOf(item).id}`,
    mime: content.media.mime,
    bytes: content.media.bytes,
    sha256: '0'.repeat(64),
    download_failed: true
  }];
}

// ---- 4. say whether an item is the one a delivery record names ---------------

export function matchesDelivery(context, item, delivery) {
  if ((delivery?.chunk_ids ?? []).includes(keyOf(item).id)) return true;
  return sha256(read(messageOf(item)).text ?? '') === delivery?.text_sha256;
}

// ---- 5. send -----------------------------------------------------------------

// A reply longer than the channel accepts is split, and every chunk's id is
// written back, so a person reading the store can find each piece in the chat
// and a contact replying to any one of them resolves to the reply that produced
// it.
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

// The check calls send with dry_run and reads the result directly, so the dry
// run answers synchronously. A live send cannot: it returns a promise, and the
// runtime awaits it. Awaiting the synchronous answer is also correct, so one
// caller works for both.
export function send(context, record) {
  const max = context.channel?.max_message_chars ?? MAX_MESSAGE_CHARS;
  const chunks = splitBody(record.body, max);

  if (context.dry_run) {
    return {
      status: 'sent',
      chunk_ids: chunks.map((chunk, i) => `dry-run-${record.delivery.request_id}-${i}-${sha256(chunk).slice(0, 8)}`)
    };
  }
  return sendLive(context, record, chunks);
}

async function sendLive(context, record, chunks) {
  if (!context.socket || typeof context.socket.sendMessage !== 'function') {
    throw new StreamFault([fault('TRANSPORT_ABSENT', record.delivery.request_id,
      'the adapter was asked to send with no connection to send on',
      'start the channel before the reply loop, or run the send with dry_run')]);
  }
  const chat = record.conversation_id.slice(context.account.length + 1);
  const chunk_ids = [];
  for (const chunk of chunks) {
    let result;
    try {
      result = await context.socket.sendMessage(chat, { text: chunk });
    } catch (error) {
      return { status: outcomeOf(error, chunk_ids.length), chunk_ids };
    }
    chunk_ids.push(result?.key?.id ?? null);
  }
  return { status: 'sent', chunk_ids };
}

// What a failed send means. Doubt resolves to unknown and never to failed,
// because a failed send may be retried and an unknown one may not: claiming a
// send failed when nobody knows is how a contact gets the same message twice.
export function outcomeOf(error, sentSoFar = 0) {
  if (sentSoFar > 0) return 'unknown';
  const code = Number(error?.output?.statusCode ?? error?.statusCode ?? NaN);
  // The connection was closed before anything went out; nothing was sent.
  if (code === 428 || code === 440) return 'failed';
  return 'unknown';
}
