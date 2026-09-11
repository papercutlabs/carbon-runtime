// What is inside one update, and nothing about where it came from.
//
// An update is an envelope with exactly one of a handful of message fields on
// it, and the message inside it is the same shape whichever field carried it.
// This file answers four questions about one update and does no input or output
// of its own, which is what keeps every rule in index.mjs testable against
// recorded updates with no network in the test:
//
//   which message is this, and is it a correction of one already seen
//   what did the sender write
//   what did the sender attach, and which file id fetches it
//   is this an item of an album, and which album
//
// The types that are read are the four the adapter asks the server for: a
// message and a channel post, each in its plain and its edited form. Anything
// else the server sends is a kind this file returns null for, and index.mjs
// parks it where it landed rather than dropping it.

// The envelope field this update arrived on, and the message under it. `edited`
// says the message is a correction of one the store may already hold.
export function messageOf(update) {
  if (update?.message) return { message: update.message, edited: false, channel_post: false };
  if (update?.edited_message) return { message: update.edited_message, edited: true, channel_post: false };
  if (update?.channel_post) return { message: update.channel_post, edited: false, channel_post: true };
  if (update?.edited_channel_post) return { message: update.edited_channel_post, edited: true, channel_post: true };
  return { message: null, edited: false, channel_post: false, unknown: unknownKindOf(update) };
}

// What the server sent that this adapter has no reading for, named so the parked
// record says which it was rather than "something".
function unknownKindOf(update) {
  const names = Object.keys(update ?? {}).filter((name) => name !== 'update_id');
  return names.length > 0 ? names.join(', ') : 'an update with nothing on it';
}

// A chat's kind, as the stream contract names it. Telegram has four; a private
// chat is direct and the other three are a group, because what the distinction
// decides downstream is whether the sender and the conversation are the same
// person.
export function conversationKind(chat) {
  return chat?.type === 'private' ? 'direct' : 'group';
}

// What the sender wrote. Telegram puts a plain message's words in `text` and a
// message with media in `caption`, which is the same thing said about a
// different payload, so both are the body.
export function bodyOf(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.caption === 'string') return message.caption;
  return '';
}

// Every kind of media the Bot API names, in the order it is read. A message
// carries at most one of them.
//
// A photo is the odd one: it arrives as a list of sizes of the same picture, and
// the last is the largest, which is the one worth keeping. Keeping any other
// would be keeping a thumbnail and calling it the attachment.
export function mediaOf(message) {
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a));
    return {
      file_id: largest.file_id,
      bytes: largest.file_size ?? 0,
      mime: 'image/jpeg',
      file_name: `photo-${largest.file_unique_id}.jpg`,
      kind: 'photo'
    };
  }
  for (const kind of ['document', 'video', 'audio', 'voice', 'video_note', 'animation', 'sticker']) {
    const media = message?.[kind];
    if (!media || typeof media.file_id !== 'string') continue;
    return {
      file_id: media.file_id,
      bytes: media.file_size ?? 0,
      mime: media.mime_type ?? DEFAULT_MIME[kind],
      file_name: media.file_name ?? `${kind}-${media.file_unique_id}${EXTENSION[kind] ?? ''}`,
      kind
    };
  }
  return null;
}

// What a file of this kind is, when the server says nothing. A voice note is
// always ogg and a sticker is always webp; the rest are only guessable, so they
// are the bytes and nothing more.
const DEFAULT_MIME = {
  document: 'application/octet-stream',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  voice: 'audio/ogg',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  sticker: 'image/webp'
};

const EXTENSION = {
  video: '.mp4', audio: '.mp3', voice: '.ogg', video_note: '.mp4', animation: '.mp4', sticker: '.webp'
};

// An album, which Telegram calls a media group. It arrives as several ordinary
// messages a moment apart, each carrying the same `media_group_id` and one
// picture, and only the first usually carries the caption.
//
// Every item gets its own record, carrying the group id. It is worth saying why,
// because the other chat adapter in this repository settles an album into one
// arrival and this one does not. An album collapsed into one record is an album
// whose later items exist only inside that record, and PA-147 is the gap that
// makes: a set of pictures went in and the ones after the first came out
// nowhere. One record per item cannot lose an item, and the group id on each is
// what lets a reader, and the agent, see that the six belong together. The cost
// is that the agent may see the first before the sixth has arrived, which is
// what the channel's release policy is for: a channel that sends albums declares
// `quiet` and the loop waits for the chat to settle.
export function albumOf(message) {
  const id = message?.media_group_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// Whether this message is one this adapter can write a record for. A message
// with neither words nor media is a service message — somebody joined, the title
// changed, a pinned message — and it is parked, not dropped: it is a thing that
// happened in the client's chat and the store keeps what arrived.
export function readable(message) {
  return bodyOf(message).length > 0 || mediaOf(message) !== null;
}

export function serviceKindOf(message) {
  const names = Object.keys(message ?? {})
    .filter((name) => !['message_id', 'from', 'chat', 'date', 'edit_date', 'message_thread_id'].includes(name));
  return names.length > 0 ? names.join(', ') : 'a message with neither words nor media';
}

// Who sent it. A channel post has no `from` at all, because a channel speaks as
// itself; its sender is the chat.
export function senderOf(message) {
  const from = message?.from;
  if (from && from.id !== undefined) {
    return {
      id: String(from.id),
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || undefined,
      is_bot: from.is_bot === true
    };
  }
  const chat = message?.chat;
  return {
    id: chat?.id === undefined ? 'unknown' : String(chat.id),
    name: chat?.title ?? undefined,
    is_bot: false
  };
}
