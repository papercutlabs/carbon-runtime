// AgentMail's inbound REST transport. Outbound email remains SMTP.
//
// This file is the only part of the email adapter that speaks to AgentMail.
// The API key is read from the declared secret file at call time. It is never
// placed on the channel, written to disk, or included in a fault.

import fs from 'node:fs';
import { fault } from '../../stream/faults.mjs';
import { TransportFault } from './curl.mjs';

const DEFAULT_API_HOST = 'api.agentmail.to';
const DEFAULT_LIST_LIMIT = 100;
const CALL_TIMEOUT_MS = 60000;

export class AgentMailFault extends TransportFault {
  constructor(faults, transport = {}) {
    super(faults, transport);
    this.name = 'AgentMailFault';
  }
}

function readNetrc(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AgentMailFault([fault('AGENTMAIL_NETRC_PATH_ABSENT', 'transport.netrc_ref',
      'this AgentMail API transport names no declared netrc secret',
      'declare transport.netrc_ref as the existing mailbox netrc secret')]);
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new AgentMailFault([fault('AGENTMAIL_NETRC_UNREADABLE', file,
      error?.code === 'ENOENT' ? 'there is no file at this path' : `this account cannot read the file: ${error?.code ?? error?.message}`,
      'place the mailbox netrc through the existing secret grant, mode 0600, owned by the runtime account')]);
  }
}

function quotedToken(text, start, file) {
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"') return { value, next: i + 1 };
    if (char !== '\\') { value += char; continue; }
    const escaped = text[++i];
    const replacements = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' };
    if (escaped === undefined || replacements[escaped] === undefined) {
      throw new AgentMailFault([fault('AGENTMAIL_NETRC_MALFORMED', file,
        `the quoted netrc value carries an unsupported escape ${JSON.stringify(escaped ?? 'end of file')}`,
        'use curl netrc quoted strings with only escaped quote, backslash, n, r or t')]);
    }
    value += replacements[escaped];
  }
  throw new AgentMailFault([fault('AGENTMAIL_NETRC_MALFORMED', file,
    'a quoted netrc value reaches the end of the file without a closing quote',
    'close the quoted value before the end of the file')]);
}

function netrcTokens(text, file) {
  const tokens = [];
  let at = 0;
  while (at < text.length) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (at >= text.length) break;
    if (text[at] === '#') {
      throw new AgentMailFault([fault('AGENTMAIL_NETRC_SYNTAX_UNSUPPORTED', file,
        'the netrc carries a comment, which this REST reader does not interpret',
        'remove comments; keep only machine, login and password fields, using quoted strings where needed')]);
    }
    if (text[at] === '"') {
      const quoted = quotedToken(text, at, file);
      tokens.push(quoted.value);
      at = quoted.next;
      continue;
    }
    let end = at;
    while (end < text.length && !/\s/.test(text[end])) end++;
    tokens.push(text.slice(at, end));
    at = end;
  }
  return tokens;
}

function passwordIn(tokens, start, machine) {
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === 'machine' || tokens[i] === 'default' || tokens[i] === 'macdef') break;
    if (tokens[i] !== 'password') continue;
    if (typeof tokens[i + 1] === 'string' && tokens[i + 1].length > 0) return tokens[i + 1];
    break;
  }
  throw new AgentMailFault([fault('AGENTMAIL_NETRC_PASSWORD_ABSENT', machine,
    'the declared mailbox netrc entry carries no password, so there is no AgentMail Bearer token',
    `add the password to the machine ${machine} entry in mailbox_netrc`)]);
}

export function readNetrcPassword(file, machine) {
  if (typeof machine !== 'string' || machine.length === 0) {
    throw new AgentMailFault([fault('AGENTMAIL_NETRC_MACHINE_UNSTATED', 'transport.imap_host',
      'the AgentMail REST transport needs the IMAP machine name whose password is its API key',
      'declare transport.imap_host as the AgentMail IMAP host')]);
  }
  const tokens = netrcTokens(readNetrc(file), file);
  let at = -1;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'machine' && tokens[i + 1] === machine) { at = i + 2; break; }
  }
  if (at === -1) {
    throw new AgentMailFault([fault('AGENTMAIL_NETRC_MACHINE_ABSENT', machine,
      'the declared mailbox netrc carries no entry for this machine',
      `add the existing AgentMail credential as a machine ${machine} entry in mailbox_netrc`)]);
  }
  return passwordIn(tokens, at, machine);
}

function transportOf(channel) {
  return {
    apiKey: readNetrcPassword(channel.netrc, channel.imap_host),
    apiHost: channel.api_host ?? DEFAULT_API_HOST
  };
}

async function responseFor(transport, pathname, search = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const url = new URL(`https://${transport.apiHost}${pathname}`);
  if (search !== null) url.search = search.toString();
  try {
    return await fetch(url, {
      headers: { authorization: `Bearer ${transport.apiKey}` },
      signal: controller.signal
    });
  } catch (error) {
    throw new AgentMailFault([fault('AGENTMAIL_API_UNREACHABLE', pathname,
      error?.message ?? String(error),
      `check that ${transport.apiHost} is reachable from this box and declared in outbound_hosts`)]);
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFor(transport, pathname, search = null) {
  const response = await responseFor(transport, pathname, search);
  if (!response.ok) {
    throw new AgentMailFault([fault('AGENTMAIL_API_REFUSED', pathname,
      `the AgentMail API answered ${response.status} ${response.statusText}`,
      response.status === 401
        ? 'the password in the declared AgentMail netrc entry is wrong or revoked; replace mailbox_netrc through its existing grant'
        : 'the whole poll cycle failed; the runtime records it and applies the declared channel hold')],
    { status: response.status });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new AgentMailFault([fault('AGENTMAIL_API_RESPONSE_UNREADABLE', pathname,
      error?.message ?? String(error),
      'the whole poll cycle failed because the API response was not JSON')]);
  }
}

async function listMessages(transport, inboxId, { after = null, limit = DEFAULT_LIST_LIMIT } = {}) {
  const messages = [];
  let pageToken = null;
  do {
    const query = new URLSearchParams({ ascending: 'true', limit: String(limit) });
    if (after !== null) query.set('after', after);
    if (pageToken !== null) query.set('page_token', pageToken);
    const page = await jsonFor(transport,
      `/v0/inboxes/${encodeURIComponent(inboxId)}/messages`, query);
    if (!Array.isArray(page?.messages)) {
      throw new AgentMailFault([fault('AGENTMAIL_MESSAGE_LIST_UNREADABLE', inboxId,
        'the list response carries no messages array',
        'the whole poll cycle failed because the provider response does not match its API contract')]);
    }
    messages.push(...page.messages);
    pageToken = typeof page.next_page_token === 'string' && page.next_page_token.length > 0
      ? page.next_page_token
      : null;
  } while (pageToken !== null);
  return messages;
}

function getMessage(transport, inboxId, messageId) {
  return jsonFor(transport,
    `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
}

async function getAttachment(transport, inboxId, messageId, attachment) {
  const pathname = `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachment.attachment_id)}`;
  const metadata = await jsonFor(transport, pathname);
  if (typeof metadata?.download_url !== 'string') {
    throw new AgentMailFault([fault('AGENTMAIL_ATTACHMENT_METADATA_UNREADABLE', attachment.attachment_id,
      'the attachment metadata carries no download_url',
      'the whole poll cycle failed before capture; check the provider response before allowing the cursor to move')]);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(metadata.download_url, { signal: controller.signal });
    if (!response.ok) {
      throw new AgentMailFault([fault('AGENTMAIL_ATTACHMENT_DOWNLOAD_REFUSED', attachment.attachment_id,
        `the attachment host answered ${response.status} ${response.statusText}`,
        'the whole poll cycle failed before capture; read the HTTP status and retry when the attachment service recovers')],
      { status: response.status });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mime: attachment.content_type ?? metadata.content_type ?? 'application/octet-stream',
      ...(attachment.filename ?? metadata.filename ? { filename: attachment.filename ?? metadata.filename } : {})
    };
  } catch (error) {
    if (error instanceof AgentMailFault) throw error;
    throw new AgentMailFault([fault('AGENTMAIL_ATTACHMENT_DOWNLOAD_FAILED', attachment.attachment_id,
      error?.message ?? String(error),
      'the whole poll cycle failed before capture; read the network error and restore access to the returned attachment URL')]);
  } finally {
    clearTimeout(timer);
  }
}

function headerLines(message) {
  const headers = [];
  const present = new Set();
  const skip = new Set(['content-type', 'content-transfer-encoding', 'content-disposition', 'mime-version']);
  for (const [name, carried] of Object.entries(message.headers ?? {})) {
    const lower = name.toLowerCase();
    if (skip.has(lower)) continue;
    present.add(lower);
    for (const value of Array.isArray(carried) ? carried : [carried]) {
      headers.push(`${name}: ${String(value).replace(/[\r\n]+/g, ' ')}`);
    }
  }
  const add = (name, value) => {
    if (value === undefined || value === null || value === '' || present.has(name.toLowerCase())) return;
    headers.push(`${name}: ${value}`);
    present.add(name.toLowerCase());
  };
  const id = (value) => {
    const text = String(value ?? '').trim();
    if (text === '') return undefined;
    return text.startsWith('<') ? text : `<${text}>`;
  };
  add('Message-ID', id(message.message_id));
  add('From', message.from);
  add('To', Array.isArray(message.to) ? message.to.join(', ') : message.to);
  add('Cc', Array.isArray(message.cc) ? message.cc.join(', ') : message.cc);
  add('Reply-To', Array.isArray(message.reply_to) ? message.reply_to.join(', ') : message.reply_to);
  add('Subject', message.subject);
  add('Date', message.timestamp);
  add('In-Reply-To', id(message.in_reply_to));
  add('References', Array.isArray(message.references) ? message.references.map(id).filter(Boolean).join(' ') : undefined);
  return headers;
}

function itemFor(message, attachments, mailbox = 'INBOX') {
  const timestamp = new Date(message.timestamp).toISOString();
  const text = message.text ?? message.extracted_text;
  const html = text === undefined || text === null ? (message.html ?? message.extracted_html) : null;
  const body = text ?? html ?? message.preview ?? '';
  const contentType = html === null ? 'text/plain' : 'text/html';
  const rfc822 = [
    ...headerLines(message),
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: 8bit',
    '',
    ...String(body).split('\n')
  ];
  return {
    mailbox,
    position: timestamp,
    mailbox_position: timestamp,
    conversation: message.thread_id ?? null,
    rfc822,
    agentmail_attachments: attachments,
    agentmail_message_id: message.message_id
  };
}

export async function pollAgentMail(context, { held = null } = {}) {
  const channel = context.channel;
  const inboxId = channel.inbox_id;
  if (typeof inboxId !== 'string' || inboxId.length === 0) {
    throw new AgentMailFault([fault('AGENTMAIL_INBOX_ID_MISSING', 'transport.inbox_id',
      'the AgentMail API endpoint requires an inbox id and this channel declares none',
      'declare transport.inbox_id for this AgentMail inbox')]);
  }
  const limit = channel.agentmail_list_limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentMailFault([fault('AGENTMAIL_LIST_LIMIT_INVALID', String(limit),
      'the AgentMail list limit must be a positive integer',
      'declare transport.agentmail_list_limit as a positive integer')]);
  }
  const transport = transportOf(channel);
  const previews = await listMessages(transport, inboxId, { after: held, limit });
  const items = [];
  for (const preview of previews) {
    const message = await getMessage(transport, inboxId, preview.message_id);
    const attachments = [];
    for (const attachment of message.attachments ?? []) {
      attachments.push(await getAttachment(transport, inboxId, message.message_id, attachment));
    }
    items.push(itemFor(message, attachments, channel.mailbox));
  }
  return { items, after: held, count: previews.length };
}
