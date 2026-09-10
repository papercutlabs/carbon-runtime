// Reading one WhatsApp message.
//
// A message on this channel is a protocol object with one populated field out of
// about ninety, sometimes wrapped in two or three envelopes that mean "this
// disappears", "this may be viewed once" or "this replaces something". This file
// is the whole of what the adapter understands about that object: the envelopes
// it unwraps, the kinds it can turn into a record, the kinds it deliberately
// drops, and the kinds it does not know, which are parked rather than guessed
// at.
//
// The numbers below are the protocol's own, read from the pinned library's
// WAProto: a protocol message of type 14 replaces an earlier message and of type
// 0 revokes one; a message association of type 1 is an album member, and of type
// 5 or 10 is the second, higher-definition upload of a picture or a video that
// the sender's app made alongside the first.

export const PROTOCOL_MESSAGE_EDIT = 14;
export const PROTOCOL_REVOKE = 0;

export const ASSOCIATION_MEDIA_ALBUM = 1;
export const ASSOCIATION_HD_VIDEO_CHILD = 5;
export const ASSOCIATION_HD_IMAGE_CHILD = 10;

// The envelopes, in the order the library itself unwraps them.
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'groupStatusMessage',
  'groupStatusMessageV2'
];

// `associatedChildMessage` is deliberately not in that list. It is the envelope
// the higher-definition upload arrives in, and unwrapping it would turn the
// child into a message of its own, which is exactly the doubling this adapter
// exists to avoid.
//
// The same field appears in two places and means two different things. On a
// message that also carries a picture, it is the parent saying "there is a
// larger version of this", and that message is the one to record. On a message
// that carries nothing else, it is the larger version arriving on its own, and
// that message is the one to drop.
export function isChildEnvelope(message) {
  if (!message || typeof message !== 'object') return false;
  const content = Object.keys(message).filter((name) => name !== 'messageContextInfo');
  return content.length === 1 && content[0] === 'associatedChildMessage';
}

export function unwrap(message) {
  let content = message;
  for (let depth = 0; depth < 5 && content && typeof content === 'object'; depth++) {
    const wrapper = WRAPPERS.find((name) => content[name]?.message);
    if (!wrapper) break;
    content = content[wrapper].message;
  }
  return content ?? {};
}

export function association(message) {
  return unwrap(message)?.messageContextInfo?.messageAssociation
    ?? message?.messageContextInfo?.messageAssociation
    ?? null;
}

// The second upload of one picture. Both the envelope form and the association
// form are read, because the sender's app may send either.
export function isHdChild(message) {
  if (isChildEnvelope(message)) return true;
  const type = association(message)?.associationType;
  return type === ASSOCIATION_HD_IMAGE_CHILD || type === ASSOCIATION_HD_VIDEO_CHILD;
}

// The album this message belongs to, as the id of the album message the sender's
// app sent first, or null when the message is not part of one.
export function albumOf(message) {
  const found = association(message);
  if (!found || found.associationType !== ASSOCIATION_MEDIA_ALBUM) return null;
  const id = found.parentMessageKey?.id;
  return typeof id === 'string' && id.length > 0
    ? { album_id: id, index: found.messageIndex ?? null }
    : null;
}

// A message that replaces an earlier one. Returns the id of the message it
// replaces and the text it replaces it with.
export function editOf(message) {
  const protocol = unwrap(message)?.protocolMessage;
  if (!protocol || protocol.type !== PROTOCOL_MESSAGE_EDIT) return null;
  const replaces = protocol.key?.id;
  if (typeof replaces !== 'string' || replaces.length === 0) return null;
  return { replaces, message: protocol.editedMessage ?? {} };
}

export function revokeOf(message) {
  const protocol = unwrap(message)?.protocolMessage;
  if (!protocol || protocol.type !== PROTOCOL_REVOKE) return null;
  const revoked = protocol.key?.id;
  return typeof revoked === 'string' && revoked.length > 0 ? { revoked } : null;
}

const MEDIA_KINDS = new Map([
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
  ['ptvMessage', 'video']
]);

// The kinds this adapter turns into a record, and the text it takes from each.
// Anything not named here is not understood, and a message the adapter does not
// understand is parked where it landed rather than delivered as an empty one.
export function read(message) {
  const content = unwrap(message);
  if (!content || typeof content !== 'object') {
    return { kind: null, text: '', media: null };
  }

  if (typeof content.conversation === 'string') {
    return { kind: 'text', text: content.conversation, media: null };
  }
  if (content.extendedTextMessage) {
    return { kind: 'text', text: content.extendedTextMessage.text ?? '', media: null };
  }
  for (const [field, kind] of MEDIA_KINDS) {
    if (content[field]) {
      const media = content[field];
      return {
        kind,
        text: media.caption ?? '',
        media: {
          field,
          mime: media.mimetype ?? 'application/octet-stream',
          bytes: Number(media.fileLength ?? 0) || 0,
          file_name: typeof media.fileName === 'string' ? media.fileName : null
        }
      };
    }
  }
  if (content.reactionMessage) {
    return {
      kind: 'reaction',
      text: content.reactionMessage.text ?? '',
      media: null,
      reaction_to: content.reactionMessage.key?.id ?? null
    };
  }
  if (content.locationMessage) {
    const at = content.locationMessage;
    return { kind: 'location', text: at.name ?? at.address ?? '', media: null };
  }
  if (content.contactMessage) {
    return { kind: 'contact', text: content.contactMessage.displayName ?? '', media: null };
  }
  if (content.albumMessage) {
    return { kind: 'album', text: '', media: null };
  }
  if (content.protocolMessage) {
    return { kind: 'protocol', text: '', media: null };
  }
  return { kind: null, text: '', media: null, unknown: Object.keys(content)[0] ?? 'an empty message' };
}
