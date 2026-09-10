// The email adapter: one mailbox in, one mailbox out.
//
// It declares inbound and outbound, so the conformance check runs sixteen of
// the seventeen cases against it; the seventeenth belongs to an import and this
// adapter does not import.
//
// The five decisions that make this adapter what it is:
//
// 1. Identity is threading, never the subject. A message's conversation is the
//    root of its References chain, and its record is that root plus its own
//    Message-ID. Two people can write "Re: invoice" about different invoices on
//    the same day; the References root is the only thing in a mail that says
//    which exchange it belongs to.
// 2. The watermark is (uidvalidity, uid), held in the store's own cursor under
//    a mailbox-shaped conversation id. A mailbox that comes back with a
//    different UIDVALIDITY has renumbered everything in it, so the adapter
//    re-scans from the first uid and the Message-ID dedup absorbs the re-read:
//    a repeated write of a record merges and changes no capture bytes.
// 3. Polling has a floor. See POLL_INTERVAL_FLOOR_MS.
// 4. The mailbox that received is the mailbox that answers. A message that
//    names no declared address of ours in its recipients is captured, kept, and
//    never answered: it lands with disposition policy-drop and send() refuses
//    any reply that names it.
// 5. A human writing from the agent's own mailbox is the operator, and holds
//    the agent. The agent's own sent mail, which is the other thing that
//    arrives from that address, is told apart by the send stamp and by the
//    delivery record that names its Message-ID.
//
// The transport is curl, in ./curl.mjs; the MIME reading is ours, in
// ./mime.mjs. The credential is a netrc file the box owner placed, whose path
// the declaration names and which nothing here opens.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fault } from '../../stream/faults.mjs';
import { MimeUnreadable, decodeWords, header, headerRaw, headersAll, readMessage } from './mime.mjs';
import { TransportFault, fetchMessage, listMailboxes, restoreUnseen, searchUids, sendMessage, status, unseenUids } from './curl.mjs';

export const capabilities = ['inbound', 'outbound'];

// Thirty seconds, and never less. An IMAP login is expensive at the server and
// cheap at us, which is exactly the shape that earns a rate limit: a mailbox
// polled every second is 3,600 logins an hour from one address, and providers
// answer that with a lockout that lasts a day and takes a human to lift. Thirty
// seconds is 120 logins an hour, which no provider objects to, and a reply that
// is at worst half a minute later than it could have been is invisible in a
// medium where people answer in hours. A declaration asking for less is refused
// rather than quietly raised, because a number nobody honours is worse than a
// number nobody likes.
export const POLL_INTERVAL_FLOOR_MS = 30000;

export const DEFAULTS = {
  mailbox: 'INBOX',
  imap_port: 993,
  smtp_port: 465,
  poll_interval_ms: POLL_INTERVAL_FLOOR_MS,
  max_attachment_bytes: 25000000,
  max_part_bytes: 65536,
  release: 'immediate',
  hold: { release_after_ms: 3600000 },
  addresses: []
};

const SENT_STAMP = 'x-carbon-origin';

// ---- the declaration -------------------------------------------------------

// On a box the runtime passes the channel's declaration block as context.channel.
// The conformance check passes no declaration at all, so an adapter's own
// fixtures directory may carry channel.json and the check's fixture loading
// hands it here. Nothing else reads it.
export function channelOf(context) {
  const declared = context.channel ?? context.fixtures?.['channel.json'] ?? {};
  return {
    ...DEFAULTS,
    ...declared,
    hold: { ...DEFAULTS.hold, ...(declared.hold ?? {}) }
  };
}

// The floor, as a refusal. Returns the interval or throws.
export function pollIntervalMs(channel) {
  const declared = channel.poll_interval_ms;
  if (typeof declared !== 'number' || !Number.isFinite(declared)) {
    throw new TransportFault([fault('POLL_INTERVAL_MISSING', 'poll_interval_ms',
      'the channel declares no poll interval and this adapter guesses none',
      `declare poll_interval_ms, at or above the floor of ${POLL_INTERVAL_FLOOR_MS}`)]);
  }
  if (declared < POLL_INTERVAL_FLOOR_MS) {
    throw new TransportFault([fault('POLL_INTERVAL_BELOW_FLOOR', String(declared),
      `polling a mailbox faster than every ${POLL_INTERVAL_FLOOR_MS} ms earns a rate limit that costs a day of the agent's work`,
      `raise poll_interval_ms to ${POLL_INTERVAL_FLOOR_MS} or more`)]);
  }
  return declared;
}

export function declaredAddresses(context, channel) {
  return [context.account, ...(channel.addresses ?? [])]
    .filter(Boolean)
    .map((address) => address.toLowerCase());
}

// ---- identifiers -----------------------------------------------------------

const pad = (value) => String(value).padStart(10, '0');

export function positionOf(uidvalidity, uid) {
  return `${pad(uidvalidity)}:${pad(uid)}`;
}

export function watermarkConversation(account, mailbox) {
  return `${account}:mailbox:${mailbox}`;
}

export function idsIn(value = '') {
  return [...value.matchAll(/<([^<>]*)>/g)].map((match) => match[1].trim()).filter(Boolean);
}

export function addressesIn(value = '') {
  const found = [];
  for (const piece of value.split(',')) {
    const angled = piece.match(/<([^<>]+)>/);
    const address = (angled ? angled[1] : piece).trim();
    if (address.includes('@')) found.push(address.toLowerCase());
  }
  return found;
}

export function displayName(value = '') {
  const angled = value.indexOf('<');
  if (angled <= 0) return undefined;
  const name = decodeWords(value.slice(0, angled).trim().replace(/^"|"$/g, '')).trim();
  return name.length > 0 ? name : undefined;
}

// The conversation is the root of the References chain, and never the subject.
export function threadRoot(headers, ownId) {
  const references = idsIn(headerRaw(headers, 'references') ?? '');
  if (references.length > 0) return references[0];
  const parent = idsIn(headerRaw(headers, 'in-reply-to') ?? '');
  if (parent.length > 0) return parent[0];
  return ownId;
}

// ---- reading one item ------------------------------------------------------

// An item is what the poller produced and what a fixture holds:
//   { mailbox, uidvalidity, uid, position, rfc822: [line, ...] }
// This never throws: a message it cannot read comes back as parked, because a
// payload nothing can parse is kept where it landed, not dropped.
export function readItem(context, item) {
  const channel = channelOf(context);
  const account = context.account;
  const unreadable = (reason, headers = []) => {
    const ownId = idsIn(headerRaw(headers, 'message-id') ?? '')[0];
    const root = headers.length > 0 && ownId ? threadRoot(headers, ownId) : null;
    const conversation_id = root === null ? `${account}:unreadable` : `${account}:${root}`;
    const message_id = root === null
      ? `${conversation_id}:uid-${item.uidvalidity}-${item.uid}`
      : `${conversation_id}:${ownId}`;
    return {
      parked: true, reason, conversation_id, message_id,
      platform_message_id: ownId ?? `uid-${item.uidvalidity}-${item.uid}`,
      revision: 0, cursorKind: 'message', headers
    };
  };

  let headers = [];
  try {
    const message = readMessage(item.rfc822, { maxAttachmentBytes: channel.max_attachment_bytes });
    headers = message.headers;
    const ownId = idsIn(headerRaw(headers, 'message-id') ?? '')[0];
    if (ownId === undefined) {
      return unreadable('the message carries no Message-ID, so it has no identity to key a record on', headers);
    }
    const supersedes = idsIn(headerRaw(headers, 'supersedes') ?? '')[0];
    const root = threadRoot(headers, ownId);
    const conversation_id = `${account}:${root}`;

    // A correction is a revision of the record it supersedes, so it sits in the
    // same file family and never overwrites what it corrects. A correction of
    // something this store never saw is an ordinary message.
    let subject_id = ownId;
    let revision = 0;
    let cursorKind = 'message';
    if (supersedes !== undefined) {
      const existing = existingRevisions(context, conversation_id, `${conversation_id}:${supersedes}`);
      if (existing.length > 0) {
        subject_id = supersedes;
        revision = Math.max(...existing) + 1;
        cursorKind = 'revision';
      }
    }

    return {
      parked: false,
      headers,
      message,
      conversation_id,
      message_id: `${conversation_id}:${subject_id}`,
      platform_message_id: ownId,
      root,
      revision,
      cursorKind,
      supersedes
    };
  } catch (error) {
    if (error instanceof MimeUnreadable) return unreadable(error.message, headers);
    throw error;
  }
}

function existingRevisions(context, conversation_id, message_id) {
  try {
    return context.store.recordsIn(conversation_id)
      .filter((record) => record.message_id === message_id)
      .map((record) => record.revision ?? 0);
  } catch {
    return [];
  }
}

function ownSentIds(context, conversation_id) {
  try {
    const ids = new Set();
    for (const record of context.store.recordsIn(conversation_id)) {
      for (const chunk of record.delivery?.chunk_ids ?? []) ids.add(chunk);
    }
    return ids;
  } catch {
    return new Set();
  }
}

// ---- the five operations ---------------------------------------------------

// 1. list what is pending past the cursors
export function listPending(context) {
  return (context.items ?? []).filter((item) => {
    const read = readItem(context, item);
    let at = null;
    try {
      at = context.store.cursors(read.conversation_id)[read.cursorKind];
    } catch {
      at = null; // an identifier the store will refuse; let it refuse at capture
    }
    return at === null || String(item.position) > at;
  });
}

// 2. consume one item, after the runtime accepted it. This is the only place a
//    cursor moves, and it moves two: the conversation's, and the mailbox
//    watermark that says how far the poller has read.
export function consume(context, item) {
  const read = readItem(context, item);
  context.store.advanceCursor(read.conversation_id, read.cursorKind, item.position);
  context.store.advanceCursor(
    watermarkConversation(context.account, item.mailbox ?? channelOf(context).mailbox),
    'message', item.position);
}

// 3. turn a batch into the payload the store writes
export function payload(context, items) {
  const channel = channelOf(context);
  const declared = declaredAddresses(context, channel);
  const entries = [];
  const parked = [];

  for (const item of items) {
    const read = readItem(context, item);
    const raw = item.rfc822.join('\n');
    const cursor = { kind: read.cursorKind, position: item.position };

    if (read.parked) {
      parked.push({
        record: smallestRecord(context, read, item),
        raw, cursor, reason: read.reason
      });
      continue;
    }

    const { headers, message } = read;
    const from = addressesIn(headerRaw(headers, 'from') ?? '')[0] ?? 'unknown';
    const recipients = new Set([
      ...addressesIn(headerRaw(headers, 'to') ?? ''),
      ...addressesIn(headerRaw(headers, 'cc') ?? ''),
      ...headersAll(headers, 'delivered-to').flatMap(addressesIn),
      ...headersAll(headers, 'x-delivered-to').flatMap(addressesIn),
      ...headersAll(headers, 'envelope-to').flatMap(addressesIn),
      ...headersAll(headers, 'x-original-to').flatMap(addressesIn)
    ]);
    const answerable = declared.some((address) => recipients.has(address));

    const fromUs = declared.includes(from);
    const stamped = (header(headers, SENT_STAMP) ?? '').toLowerCase() === 'agent';
    const ourOwn = fromUs && (stamped || ownSentIds(context, read.conversation_id).has(read.platform_message_id));
    const role = ourOwn ? 'agent' : (fromUs ? 'operator' : 'contact');

    const record = {
      schema: 'carbon.message.v1',
      agent: context.agent,
      source: 'email',
      account: context.account,
      conversation_id: read.conversation_id,
      conversation_kind: 'thread',
      message_id: read.message_id,
      platform_message_id: read.platform_message_id,
      revision: read.revision,
      direction: ourOwn ? 'outbound' : 'inbound',
      role,
      sender_id: from,
      received_at: new Date(context.now ?? Date.now()).toISOString(),
      body: message.body,
      attachments: [],
      historical: false,
      disposition: answerable ? 'captured' : 'policy-drop'
    };

    const name = displayName(headerRaw(headers, 'from') ?? '');
    if (name !== undefined) record.sender_name = name;
    const date = header(headers, 'date');
    if (date !== undefined) record.sent_at = new Date(date).toString() === 'Invalid Date'
      ? date
      : new Date(date).toISOString();
    const parent = idsIn(headerRaw(headers, 'in-reply-to') ?? '')[0];
    if (parent !== undefined) record.reply_to = parent;

    // An operator writing from the agent's own mailbox holds the agent. When it
    // releases is the declaration's business, carried here as release_after_ms.
    if (role === 'operator') {
      record.hold = {
        reason: 'a person wrote from the agent\'s own mailbox',
        set_at: record.sent_at ?? record.received_at,
        ...(channel.hold.release_after_ms === undefined ? {} : { release_after_ms: channel.hold.release_after_ms })
      };
    }

    const extra = adapterFields(headers);
    if (extra !== undefined) record.adapter_fields = extra;
    // The one fixture-shaped field this adapter honours: a channel cannot
    // produce a declared field of the wrong type, and case 14 must see one
    // refused. Nothing on a box sets it.
    if (item.wrong_type !== undefined) Object.assign(record, item.wrong_type);

    entries.push({ record, raw, cursor, attachments: message.attachments });
  }

  return { entries, parked };
}

// The smallest record that still names the conversation and the message.
function smallestRecord(context, read, item) {
  return {
    schema: 'carbon.message.v1',
    agent: context.agent,
    source: 'email',
    account: context.account,
    conversation_id: read.conversation_id,
    conversation_kind: 'thread',
    message_id: read.message_id,
    platform_message_id: read.platform_message_id,
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: addressesIn(headerRaw(read.headers, 'from') ?? '')[0] ?? 'unknown',
    received_at: new Date(context.now ?? Date.now()).toISOString(),
    body: '',
    attachments: [],
    historical: false,
    disposition: 'parked'
  };
}

// A header this schema does not name is carried, never dropped and never
// interpreted: the channel's own X- headers, minus the stamp this adapter puts
// on its own sent mail, which is ours and not the channel's.
export function adapterFields(headers) {
  const fields = {};
  for (const entry of headers) {
    if (!entry.name.startsWith('x-')) continue;
    if (entry.name.startsWith('x-carbon-')) continue;
    if (fields[entry.name] === undefined) fields[entry.name] = entry.value;
    else if (Array.isArray(fields[entry.name])) fields[entry.name].push(entry.value);
    else fields[entry.name] = [fields[entry.name], entry.value];
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

// 4. say whether an item is the one a delivery record names
export function matchesDelivery(context, item, delivery) {
  const read = readItem(context, item);
  return (delivery.chunk_ids ?? []).includes(read.platform_message_id);
}

// 5. send
export function send(context, record) {
  const channel = channelOf(context);
  const target = replyTarget(context, record);
  if (target.disposition === 'policy-drop') {
    throw new TransportFault([fault('INBOUND_TO_UNDECLARED_ADDRESS', target.message_id,
      'this message named no declared address of this agent in its recipients, so it is captured and never answered',
      'declare the address in the channel block if the agent owns this mailbox, or leave the message unanswered')]);
  }

  const inbound = inboundHeaders(context, target);
  const recipients = context.recipients ?? replyRecipients(target, inbound);
  if (recipients.length === 0) {
    throw new TransportFault([fault('REPLY_HAS_NO_RECIPIENT', target.message_id,
      'the message being answered carries no address to answer to',
      'answer a message whose From or Reply-To names an address')]);
  }

  const domain = context.account.split('@')[1] ?? 'localhost';
  const parts = splitBody(record.body, channel.max_part_bytes);
  const chunk_ids = [];
  let outcome = 'sent';

  for (let index = 0; index < parts.length; index++) {
    const messageId = `carbon.${record.delivery.request_id}.${index + 1}.${crypto.randomBytes(6).toString('hex')}@${domain}`;
    const mime = buildMessage({
      from: context.account,
      to: recipients,
      subject: partSubject(subjectOf(inbound), index, parts.length),
      messageId,
      inReplyTo: target.platform_message_id,
      references: referencesFor(target),
      date: new Date(context.now ?? Date.now()),
      body: parts[index],
      origin: 'agent'
    });

    if (context.dry_run === true) {
      chunk_ids.push(messageId);
      continue;
    }

    const file = writeTemp(mime);
    try {
      const result = sendMessage({
        netrc: channel.netrc,
        host: channel.smtp_host,
        port: channel.smtp_port,
        from: context.account,
        to: recipients,
        file
      });
      if (result.status === 'sent') chunk_ids.push(messageId);
      else { outcome = result.status; break; }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // A part that went and a part whose fate is unknown is an unknown send: the
  // store never retries it, and a person decides what happened.
  if (outcome !== 'sent' && chunk_ids.length > 0) outcome = 'unknown';
  return { status: outcome, chunk_ids };
}

// ---- the reply's shape -----------------------------------------------------

export function replyTarget(context, record) {
  const inbound = context.store.recordsIn(record.conversation_id)
    .filter((held) => held.direction === 'inbound');
  if (inbound.length === 0) {
    throw new TransportFault([fault('REPLY_TARGET_MISSING', record.conversation_id,
      'there is no captured message in this conversation to answer',
      'answer a conversation this agent has captured something on')]);
  }
  if (record.reply_to !== undefined) {
    const named = inbound.find((held) => held.platform_message_id === record.reply_to);
    if (named !== undefined) return named;
  }
  return inbound.sort((a, b) => String(a.sent_at ?? a.received_at).localeCompare(String(b.sent_at ?? b.received_at))).at(-1);
}

// The record carries what the contract names and no more, so the subject and
// the address to answer to are read back from the raw payload the capture kept
// beside it. That file is the message as it arrived, which is exactly the thing
// a reply must agree with.
export function inboundHeaders(context, target) {
  try {
    const raw = fs.readFileSync(context.store.under(target.raw), 'latin1').split('\n');
    return readMessage(raw, { maxAttachmentBytes: 0 }).headers;
  } catch {
    return [];
  }
}

function replyRecipients(target, headers) {
  const replyTo = addressesIn(headerRaw(headers, 'reply-to') ?? '');
  if (replyTo.length > 0) return replyTo;
  return target.sender_id === 'unknown' ? [] : [target.sender_id];
}

function subjectOf(headers) {
  return header(headers, 'subject') ?? 'Re:';
}

function partSubject(subject, index, total) {
  const base = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  return total === 1 ? base : `${base} (part ${index + 1} of ${total})`;
}

// In-Reply-To is the message being answered; References is the chain, root
// first, with that message last. Both come from the inbound, never from a
// subject line.
export function referencesFor(target) {
  const root = target.conversation_id.slice(target.account.length + 1);
  const chain = [root];
  if (target.platform_message_id !== root) chain.push(target.platform_message_id);
  return chain;
}

// A reply longer than the channel's part size goes as a numbered series, split
// at a line boundary where there is one, and each part is a message of its own
// with its own Message-ID. The Message-IDs are the chunk ids the store keeps.
export function splitBody(body, maxPartBytes) {
  const text = body ?? '';
  if (Buffer.byteLength(text, 'utf8') <= maxPartBytes) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (Buffer.byteLength(candidate, 'utf8') > maxPartBytes && current !== '') {
      parts.push(current);
      current = line;
    } else if (Buffer.byteLength(candidate, 'utf8') > maxPartBytes) {
      // One line longer than a whole part: cut it on a byte boundary.
      let rest = Buffer.from(candidate, 'utf8');
      while (rest.length > maxPartBytes) {
        parts.push(rest.subarray(0, maxPartBytes).toString('utf8'));
        rest = rest.subarray(maxPartBytes);
      }
      current = rest.toString('utf8');
    } else {
      current = candidate;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

export function encodeHeaderWord(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// `origin` is the value of the X-Carbon-Origin header, and it is explicit
// because it is the thing that tells the agent's own sent mail from a person's
// mail out of the same mailbox when either comes back. A send by the agent is
// 'agent'. Anything else a command sends is not.
export function buildMessage({ from, to, subject, messageId, inReplyTo, references, date, body, origin }) {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new TransportFault([fault('SEND_ORIGIN_MISSING', messageId,
      'a message this adapter builds says who sent it, and nothing here guesses',
      "pass origin: 'agent' for the agent's own send")]);
  }
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `X-Carbon-Origin: ${origin}`
  ];
  if (inReplyTo !== undefined) lines.push(`In-Reply-To: <${inReplyTo}>`);
  if (references !== undefined && references.length > 0) {
    lines.push(`References: ${references.map((id) => `<${id}>`).join(' ')}`);
  }
  const encoded = Buffer.from(body ?? '', 'utf8').toString('base64').match(/.{1,76}/g) ?? [''];
  return [...lines, '', ...encoded, ''].join('\r\n');
}

function writeTemp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-email-'));
  const file = path.join(dir, 'message.eml');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// ---- the poll --------------------------------------------------------------

// Read the mailbox from the watermark up and return items. The watermark is
// (uidvalidity, uid), kept in the store's own cursor under a conversation id
// shaped like a mailbox, so there is one place cursors live and one write order
// that moves them.
export function poll(context) {
  const channel = channelOf(context);
  const mailbox = channel.mailbox;
  const held = context.store.cursors(watermarkConversation(context.account, mailbox)).message;
  const live = status({ netrc: channel.netrc, host: channel.imap_host, port: channel.imap_port, mailbox });

  let fromUid = 1;
  let rescanned = false;
  if (held !== null && held !== undefined) {
    const [validity, uid] = held.split(':').map(Number);
    if (validity === live.uidvalidity) {
      fromUid = uid + 1;
    } else if (live.uidvalidity < validity) {
      throw new TransportFault([fault('UIDVALIDITY_WENT_BACKWARDS', `${mailbox} ${live.uidvalidity}`,
        `the mailbox reports a UIDVALIDITY below the one the watermark holds (${validity}), which a server never does by itself`,
        'this is a different mailbox behind the same name, or a restored backup; a person decides before the agent reads it')]);
    } else {
      rescanned = true;
    }
  }

  const where = { netrc: channel.netrc, host: channel.imap_host, port: channel.imap_port, mailbox };
  const uids = searchUids({ ...where, fromUid });
  // Read the unread set before reading anything, so the flag can go back: a
  // fetch marks a message read, and this mailbox may be one a person also reads.
  const unseen = new Set(uids.length === 0 ? [] : unseenUids(where));
  const items = uids.map((uid) => ({
    mailbox,
    uidvalidity: live.uidvalidity,
    uid,
    position: positionOf(live.uidvalidity, uid),
    conversation: null,
    rfc822: fetchMessage({ ...where, uid })
  }));
  for (const item of items) {
    const read = readItem(context, item);
    item.conversation = read.parked ? null : read.root;
  }
  const faults = restoreUnseen({ ...where, uids: uids.filter((uid) => unseen.has(uid)) });
  return { items, uidvalidity: live.uidvalidity, rescanned, from_uid: fromUid, faults };
}

export { listMailboxes };
