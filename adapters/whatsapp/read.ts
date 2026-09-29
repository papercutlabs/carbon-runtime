// Reading one chat on a device somebody already paired.
//
// `carbon-whatsapp send` drives a tester device in a proof; this is the other
// half, so the proof can see the answer as well as the question. It connects,
// stays connected for a stated number of seconds, keeps every message that
// arrives for one chat in that time, and closes properly. It is not a history
// query: what it returns is what the server delivered while the device was
// connected, which includes anything the server had queued for the device while
// it was away. It writes nothing to any store and marks nothing read.
//
// Two rules from the README govern the shape.
//
// 1. A device that connects and vanishes in the same second is a device the
//    server has been seen to unlink. So the connection is held open for the wait
//    and then for a settle period, and is closed with `end`, never dropped.
// 2. A `401` or `403` is the device gone, not a disconnect. It is reported as
//    its own fault with the server's code, the authentication directory is left
//    exactly as it was, and nothing reconnects.
//
// What a message means is `content.ts`'s decision and a chat key is `jid.ts`'s,
// so this file only picks the chat's messages out and describes each one.

import { editOf, isHdChild, read, revokeOf } from './content.ts';
import { canonicalChatKey, canonicalParticipant, isGroup, normaliseJid } from './jid.ts';
import { terminalReason } from './latch.ts';
import { stampOf } from './socket.ts';

type Key = { remoteJid?: unknown; remoteJidAlt?: unknown; participant?: unknown; participantAlt?: unknown; id?: unknown; fromMe?: unknown };
type Event = { key?: Key; message?: unknown; messageTimestamp?: unknown; pushName?: unknown };

export type ReadMessage = {
  id: string;
  from_me: boolean;
  sender: string | null;
  sender_name: string | null;
  at: string;
  kind: string | null;
  text: string;
  media: { mime: string; bytes: number; file_name: string | null } | null;
  edit_of?: string;
  revoke_of?: string;
  reaction_to?: string;
};

export type ReadSocket = {
  ev: {
    on(event: 'connection.update', handler: (update: { connection?: unknown; lastDisconnect?: { error?: unknown } }) => void): unknown;
    on(event: 'messages.upsert', handler: (update: { messages: unknown[] }) => void): unknown;
  };
  end(reason?: undefined): void;
};

export type ReadOutcome =
  | { ok: true; chat: string; messages: ReadMessage[] }
  | { ok: false; code: 'DEVICE_UNLINKED'; status: number; reason: string }
  | { ok: false; code: 'READ_CONNECTION_CLOSED'; reason: string };

// The chat as the caller wrote it: a number in international form, digits only,
// or a jid. A number is a direct chat on the phone server.
export function chatJid(chat: string): string | null {
  if (/^[1-9][0-9]{7,14}$/.test(chat)) return `${chat}@s.whatsapp.net`;
  if (/^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/.test(chat)) return normaliseJid(chat);
  return null;
}

// Whether an event belongs to the chat. Under the linked-id rollout one chat can
// arrive under either form, so both of the event's forms are compared.
export function inChat(event: unknown, jid: string): boolean {
  const key = (event as Event | null)?.key;
  if (!key) return false;
  return [key.remoteJid, key.remoteJidAlt]
    .some((candidate) => typeof candidate === 'string' && normaliseJid(candidate) === jid);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Who spoke: the participant in a group, the chat itself in a direct chat, and
// nobody named when the message is this device's own.
function senderOf(key: Key): string | null {
  if (key.fromMe === true) return null;
  const jid = canonicalParticipant(key as Record<string, unknown>) ?? (isGroup(key.remoteJid) ? null : canonicalChatKey(key as Record<string, unknown>));
  return typeof jid === 'string' ? jid : null;
}

// One message as the reader is told about it. The second, higher-definition
// upload of a picture is dropped here as it is everywhere in this adapter, so
// one photograph is one message.
export function describe(event: unknown): ReadMessage | null {
  const found = event as Event | null;
  const id = idOf(found?.key?.id);
  if (!found || !id || isHdChild(found.message)) return null;
  const content = read(found.message ?? {});
  const edit = editOf(found.message);
  const revoke = revokeOf(found.message);
  const described: ReadMessage = {
    id,
    from_me: found.key?.fromMe === true,
    sender: senderOf(found.key ?? {}),
    sender_name: typeof found.pushName === 'string' ? found.pushName : null,
    at: new Date(stampOf(found) * 1000).toISOString(),
    kind: edit ? 'edit' : revoke ? 'revoke' : content.kind,
    text: edit ? text(read(edit.message).text) : text(content.text),
    media: content.media
      ? { mime: text(content.media.mime) || 'application/octet-stream', bytes: content.media.bytes, file_name: content.media.file_name }
      : null
  };
  if (edit) described.edit_of = edit.replaces;
  if (revoke) described.revoke_of = revoke.revoked;
  const reactionTo = idOf(content.reaction_to);
  if (reactionTo) described.reaction_to = reactionTo;
  return described;
}

// The chat's messages among everything that arrived, once each, oldest first.
export function collect(events: readonly unknown[], jid: string): ReadMessage[] {
  const seen = new Map<string, ReadMessage>();
  for (const event of events) {
    if (!inChat(event, jid)) continue;
    const described = describe(event);
    if (described && !seen.has(described.id)) seen.set(described.id, described);
  }
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
}

function closeReason(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message.split('\n')[0] : 'the connection closed';
}

// Drive one read on a socket the caller opened. Messages are buffered from the
// first event, so what the server delivers the moment the connection opens is
// not missed. The wait starts when the connection opens; after it, the socket is
// held for `settleMs` more, then ended.
export function readChat({ socket, jid, waitMs, settleMs, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }: {
  socket: ReadSocket; jid: string; waitMs: number; settleMs: number; sleep?: (ms: number) => Promise<unknown>;
}): Promise<ReadOutcome> {
  const arrived: unknown[] = [];
  socket.ev.on('messages.upsert', ({ messages }) => { arrived.push(...messages); });
  return new Promise<ReadOutcome>((resolve) => {
    let opened = false;
    let finished = false;
    const finish = (outcome: ReadOutcome) => {
      if (finished) return;
      finished = true;
      resolve(outcome);
    };
    socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open' && !opened) {
        opened = true;
        void sleep(waitMs).then(() => sleep(settleMs)).then(() => {
          if (finished) return;
          socket.end(undefined);
          finish({ ok: true, chat: jid, messages: collect(arrived, jid) });
        });
        return;
      }
      if (connection !== 'close') return;
      const terminal = terminalReason(lastDisconnect?.error);
      if (terminal) {
        finish({ ok: false, code: 'DEVICE_UNLINKED', status: terminal.code, reason: String(terminal.reason) });
        return;
      }
      finish({ ok: false, code: 'READ_CONNECTION_CLOSED', reason: closeReason(lastDisconnect?.error) });
    });
  });
}
