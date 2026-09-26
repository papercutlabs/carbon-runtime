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

// Property-access views below describe only the operations already performed.
// A primitive can still be boxed, a missing unguarded container can still throw,
// and every leaf copied to a payload stays unknown until the store validates it.
type Fields = Record<string, unknown>;
type Association = { associationType?: unknown; parentMessageKey?: { id?: unknown }; messageIndex?: unknown };
type Protocol = { type?: unknown; key?: { id?: unknown }; editedMessage?: unknown };
export type ReadContent = {
  kind: string | null; text: unknown;
  media: { field: string; mime: unknown; bytes: number; file_name: string | null } | null;
  reaction_to?: unknown; unknown?: string;
};

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
export function isChildEnvelope(message: unknown) {
  if (!message || typeof message !== 'object') return false;
  const content = Object.keys(message).filter((name) => name !== 'messageContextInfo');
  return content.length === 1 && content[0] === 'associatedChildMessage';
}

export function unwrap(message: unknown): unknown {
  let content = message;
  for (let depth = 0; depth < 5 && content && typeof content === 'object'; depth++) {
    // The wrapper read does not establish the type of the wrapped message.
    const wrapper = WRAPPERS.find((name) => ((content as Fields)[name] as { message?: unknown } | null)?.message);
    if (!wrapper) break;
    // The selected wrapper was truthy above; its message remains unvalidated.
    content = ((content as Fields)[wrapper] as { message: unknown }).message;
  }
  return content ?? {};
}

export function association(message: unknown): unknown {
  // Access views preserve optional chaining, without trusting the association leaves.
  return (unwrap(message) as { messageContextInfo?: { messageAssociation?: Association } } | null)?.messageContextInfo?.messageAssociation
    ?? (message as { messageContextInfo?: { messageAssociation?: Association } } | null)?.messageContextInfo?.messageAssociation
    ?? null;
}

// The second upload of one picture. Both the envelope form and the association
// form are read, because the sender's app may send either.
export function isHdChild(message: unknown) {
  if (isChildEnvelope(message)) return true;
  // Access view only; the returned association itself is arbitrary data.
  const type = (association(message) as Association | null)?.associationType;
  return type === ASSOCIATION_HD_IMAGE_CHILD || type === ASSOCIATION_HD_VIDEO_CHILD;
}

// The album this message belongs to, as the id of the album message the sender's
// app sent first, or null when the message is not part of one.
export function albumOf(message: unknown) {
  // Access view only; leaves remain unknown until the checks below.
  const found = association(message) as Association | null;
  if (!found || found.associationType !== ASSOCIATION_MEDIA_ALBUM) return null;
  const id = found.parentMessageKey?.id;
  return typeof id === 'string' && id.length > 0
    ? { album_id: id, index: found.messageIndex ?? null }
    : null;
}

// A message that replaces an earlier one. Returns the id of the message it
// replaces and the text it replaces it with.
export function editOf(message: unknown) {
  // Access view only; the existing comparisons below establish the usable id.
  const protocol = (unwrap(message) as { protocolMessage?: Protocol } | null)?.protocolMessage;
  if (!protocol || protocol.type !== PROTOCOL_MESSAGE_EDIT) return null;
  const replaces = protocol.key?.id;
  if (typeof replaces !== 'string' || replaces.length === 0) return null;
  return { replaces, message: protocol.editedMessage ?? {} };
}

export function revokeOf(message: unknown) {
  // Access view only; the existing comparisons below establish the usable id.
  const protocol = (unwrap(message) as { protocolMessage?: Protocol } | null)?.protocolMessage;
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
export function read(message: unknown): ReadContent {
  // Access view only: each copied leaf stays unknown, including text and MIME.
  const content = unwrap(message) as Fields | null;
  if (!content || typeof content !== 'object') {
    return { kind: null, text: '', media: null };
  }

  if (typeof content.conversation === 'string') {
    return { kind: 'text', text: content.conversation, media: null };
  }
  if (content.extendedTextMessage) {
    // Property access only; text is deliberately unknown.
    return { kind: 'text', text: (content.extendedTextMessage as { text?: unknown }).text ?? '', media: null };
  }
  for (const [field, kind] of MEDIA_KINDS) {
    if (content[field]) {
      // The truthy guard permits the same property reads; it validates no media schema.
      const media = content[field] as { caption?: unknown; mimetype?: unknown; fileLength?: unknown; fileName?: unknown };
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
    // Property access only; text and the target id remain unknown.
    return {
      kind: 'reaction',
      text: (content.reactionMessage as { text?: unknown }).text ?? '',
      media: null,
      reaction_to: (content.reactionMessage as { key?: { id?: unknown } }).key?.id ?? null
    };
  }
  if (content.locationMessage) {
    // Property access only; neither display field is validated.
    const at = content.locationMessage as { name?: unknown; address?: unknown };
    return { kind: 'location', text: at.name ?? at.address ?? '', media: null };
  }
  if (content.contactMessage) {
    // Property access only; displayName remains unknown.
    return { kind: 'contact', text: (content.contactMessage as { displayName?: unknown }).displayName ?? '', media: null };
  }
  if (content.albumMessage) {
    return { kind: 'album', text: '', media: null };
  }
  if (content.protocolMessage) {
    return { kind: 'protocol', text: '', media: null };
  }
  return { kind: null, text: '', media: null, unknown: Object.keys(content)[0] ?? 'an empty message' };
}
