// The transport: curl speaking imaps and smtps, and nothing else.
//
// Two reasons this is curl and not a socket of ours. The first is that TLS, the
// IMAP literal, the SASL handshake and the SMTP dialogue are a decade of other
// people's bug fixes, and a mail dialogue written here would be a place for our
// own bugs to live. The second is the credential: curl reads it itself from a
// netrc file the box owner placed, through --netrc-file, so the password never
// passes through this process, never reaches a command line another user can
// read in the process table, and never reaches a log. Nothing in this file
// opens that file, and nothing in this file prints it.
//
// Every function returns what it read or a fault; none of them throws a raw
// child-process error at the caller.
//
// The curl exit codes are mapped once, here, because for a send the difference
// between "the server never saw it" and "we do not know" is the difference
// between a resend and a person's decision:
//
//   0                        the server accepted it            sent
//   6, 7, 51, 60, 67         it never reached the mail server  failed
//   anything else            the outcome is not knowable       unknown
//
// An unknown is never retried. That is the store's rule and this is where the
// verdict that triggers it is made.

import { spawnSync } from 'node:child_process';
import { fault } from '../../stream/faults.mjs';

export const NEVER_ARRIVED = new Set([6, 7, 51, 60, 67]);

export class TransportFault extends Error {
  constructor(faults) {
    super(faults.map((f) => `${f.code} ${f.subject}: ${f.problem}`).join('\n'));
    this.name = 'TransportFault';
    this.faults = faults;
  }
}

export function curlBinary() {
  return process.env.CARBON_EMAIL_CURL ?? 'curl';
}

// The wire is read as latin1 so that one character is one byte: the charset of a
// message is a fact of its own headers, decided by the MIME reader, not by
// however this process happened to decode the socket.
export function runCurl(args, { timeout_ms = 120000 } = {}) {
  const result = spawnSync(curlBinary(), args, { encoding: 'buffer', timeout: timeout_ms });
  if (result.error && result.error.code === 'ENOENT') {
    throw new TransportFault([fault('CURL_MISSING', curlBinary(),
      'the email adapter speaks imaps and smtps through curl, and there is no curl at this name',
      'install curl, or name one in CARBON_EMAIL_CURL')]);
  }
  return {
    code: result.status ?? -1,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString('latin1'),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('latin1').split('\n').slice(-4).join('\n').trim()
  };
}

function imapArgs({ netrc, host, port = 993, mailbox = null, request = null, uid = null }) {
  const at = mailbox === null ? '' : encodeURIComponent(mailbox);
  const url = `imaps://${host}:${port}/${at}${uid === null ? '' : `;UID=${uid}`}`;
  const args = ['--silent', '--show-error', '--netrc-file', netrc, '--url', url];
  if (request !== null) args.push('--request', request);
  return args;
}

function readOrThrow(args, subject, what) {
  const result = runCurl(args);
  if (result.code !== 0) {
    throw new TransportFault([fault('IMAP_READ_FAILED', subject,
      `curl exited ${result.code} while ${what}${result.stderr ? `: ${result.stderr}` : ''}`,
      'check the host, the port and the netrc file the declaration names; a login denial is exit 67')]);
  }
  return result.stdout;
}

// LIST "" "*" — what mailboxes this account has.
export function listMailboxes({ netrc, host, port = 993 }) {
  const out = readOrThrow(imapArgs({ netrc, host, port }), host, 'listing the mailboxes');
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\* LIST \([^)]*\) (?:"[^"]*"|NIL) (?:"([^"]*)"|(\S+))\s*$/);
    if (match) names.push(match[1] ?? match[2]);
  }
  return names;
}

// The watermark's first half. A mailbox that comes back with a different
// UIDVALIDITY has renumbered every message in it, so every uid we hold is void.
export function status({ netrc, host, port = 993, mailbox }) {
  const out = readOrThrow(
    imapArgs({ netrc, host, port, mailbox, request: `STATUS ${mailbox} (UIDVALIDITY UIDNEXT MESSAGES)` }),
    `${host} ${mailbox}`, 'reading the mailbox status');
  const uidvalidity = out.match(/UIDVALIDITY (\d+)/);
  const uidnext = out.match(/UIDNEXT (\d+)/);
  const messages = out.match(/MESSAGES (\d+)/);
  if (uidvalidity === null) {
    throw new TransportFault([fault('IMAP_STATUS_UNREADABLE', `${host} ${mailbox}`,
      'the STATUS response names no UIDVALIDITY, so there is no watermark to hold',
      'check that the mailbox exists under this name; the name is case-sensitive')]);
  }
  return {
    uidvalidity: Number(uidvalidity[1]),
    uidnext: uidnext === null ? null : Number(uidnext[1]),
    messages: messages === null ? null : Number(messages[1])
  };
}

// UID SEARCH from the watermark up. The uids come back in one untagged line.
export function searchUids({ netrc, host, port = 993, mailbox, fromUid }) {
  const out = readOrThrow(
    imapArgs({ netrc, host, port, mailbox, request: `UID SEARCH UID ${fromUid}:*` }),
    `${host} ${mailbox}`, 'searching for new messages');
  const uids = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\*\s+SEARCH\b(.*)$/i);
    if (!match) continue;
    for (const number of match[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(number)) uids.push(Number(number));
    }
  }
  // "UID n:*" always returns at least the highest message, even when its uid is
  // below n, because that is what the range means to a server. The caller holds
  // the watermark, so anything at or below it is dropped here.
  return uids.filter((uid) => uid >= fromUid).sort((a, b) => a - b);
}

// Which messages the mailbox still counts as unread, before we read any of
// them. See restoreUnseen.
export function unseenUids({ netrc, host, port = 993, mailbox }) {
  const out = readOrThrow(
    imapArgs({ netrc, host, port, mailbox, request: 'UID SEARCH UNSEEN' }),
    `${host} ${mailbox}`, 'reading which messages are unread');
  const uids = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\*\s+SEARCH\b(.*)$/i);
    if (!match) continue;
    for (const number of match[1].trim().split(/\s+/)) if (/^\d+$/.test(number)) uids.push(Number(number));
  }
  return uids;
}

// Fetch one message, whole, as it arrived.
//
// This is the URL form, `;UID=n`, and not a custom UID FETCH request, because
// curl writes only the untagged response line to stdout for a custom request
// and silently drops the literal that holds the message; the URL form is the
// one that hands over the bytes. Verified against a live server on 10 September
// 2026: the custom request returned 31 bytes of response line and the URL form
// returned the whole 803-byte message.
//
// The URL form fetches BODY[], which marks the message read. In a mailbox a
// person also reads, that would quietly take a message off their unread list,
// so the caller reads the unseen set first and puts the flag back afterwards.
export function fetchMessage({ netrc, host, port = 993, mailbox, uid }) {
  const out = readOrThrow(
    imapArgs({ netrc, host, port, mailbox, uid }),
    `${host} ${mailbox} uid ${uid}`, `fetching uid ${uid}`);
  return out.split('\n').map((line) => line.replace(/\r$/, ''));
}

// Put \Seen back on the messages that did not have it before we read them. A
// failure here is reported and is not a reason to lose the capture, so it comes
// back as a fault list rather than a throw.
export function restoreUnseen({ netrc, host, port = 993, mailbox, uids }) {
  if (uids.length === 0) return [];
  const result = runCurl(imapArgs({
    netrc, host, port, mailbox,
    request: `UID STORE ${uids.join(',')} -FLAGS (\\Seen)`
  }));
  if (result.code === 0) return [];
  return [fault('UNREAD_FLAG_NOT_RESTORED', `${mailbox} ${uids.join(',')}`,
    `reading these messages marked them read and curl exited ${result.code} putting the flag back`,
    'a person reading this mailbox will see them as read; nothing was lost from the store')];
}

// How the connection to the submission port is encrypted. `implicit` is TLS from
// the first byte, which is smtps and port 465; `starttls` is a plain connection
// upgraded by the STARTTLS command, which is port 587. Both are named because
// neither is guessable from the port alone and because the choice is not ours: a
// box may be unable to open 465 at all. Hetzner blocks 25 and 465 outbound by
// default and leaves 587 open, which is how this came up, and no reply could
// leave the first box until it did.
//
// There is no third value. A plain, unencrypted submission is not offered, so
// `--ssl-reqd` is always passed on the starttls path: a server that cannot
// upgrade gets no credential.
export const SMTP_SECURITY = ['implicit', 'starttls'];

// The send. The message is handed to curl as a file, so no part of it and no
// part of the credential sits on a command line.
export function sendMessage({ netrc, host, port = 465, security = 'implicit', from, to, file, timeout_ms = 120000 }) {
  if (!SMTP_SECURITY.includes(security)) {
    throw new TransportFault([fault('SMTP_SECURITY_UNKNOWN', String(security),
      `a submission connection is ${SMTP_SECURITY.join(' or ')}, and this channel asks for something else`,
      `declare smtp_security as ${SMTP_SECURITY.join(' or ')} on the channel's transport`)]);
  }
  const args = [
    '--silent', '--show-error',
    '--netrc-file', netrc,
    '--url', security === 'implicit' ? `smtps://${host}:${port}` : `smtp://${host}:${port}`,
    ...(security === 'starttls' ? ['--ssl-reqd'] : []),
    '--mail-from', from
  ];
  for (const recipient of to) args.push('--mail-rcpt', recipient);
  args.push('--upload-file', file);
  const result = runCurl(args, { timeout_ms });
  if (result.code === 0) return { status: 'sent', exit: 0, detail: '' };
  return {
    status: NEVER_ARRIVED.has(result.code) ? 'failed' : 'unknown',
    exit: result.code,
    detail: result.stderr
  };
}
