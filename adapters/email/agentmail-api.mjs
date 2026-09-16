// AgentMail's inbound REST transport. Outbound email remains SMTP.
//
// This file is the only part of the email adapter that speaks to AgentMail.
// The API key is read from the declared secret file at call time. It is never
// placed on the channel, written to disk, or included in a fault.

import fs from 'node:fs';
import { fault } from '../../stream/faults.mjs';
import { TransportFault } from './curl.mjs';

export const DEFAULT_API_HOST = 'api.agentmail.to';
export const DEFAULT_LIST_LIMIT = 100;
export const CALL_TIMEOUT_MS = 60000;

export class AgentMailFault extends TransportFault {
  constructor(faults, transport = {}) {
    super(faults, transport);
    this.name = 'AgentMailFault';
  }
}

export function readApiKey(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AgentMailFault([fault('AGENTMAIL_API_KEY_PATH_ABSENT', 'transport.api_key_ref',
      'this AgentMail API transport names no declared secret holding its API key',
      'declare transport.api_key_ref as the name of the AGENTMAIL_API_KEY secret')]);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new AgentMailFault([fault('AGENTMAIL_API_KEY_UNREADABLE', file,
      error?.code === 'ENOENT' ? 'there is no file at this path' : `this account cannot read the file: ${error?.code ?? error?.message}`,
      'place the API key through the existing secret grant, mode 0600, owned by the runtime account')]);
  }
  const key = text.trim();
  if (key.length === 0 || /\s/.test(key)) {
    throw new AgentMailFault([fault('AGENTMAIL_API_KEY_MALFORMED', file,
      'the secret file is empty or contains whitespace inside the key',
      'place the AgentMail API key alone on one line')]);
  }
  return key;
}

function transportOf(channel) {
  return {
    apiKey: readApiKey(channel.api_key),
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
        ? 'the API key is wrong or revoked; place AGENTMAIL_API_KEY again through the secret grant'
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

export async function listMessages(transport, inboxId, { after = null, limit = DEFAULT_LIST_LIMIT } = {}) {
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

export function getMessage(transport, inboxId, messageId) {
  return jsonFor(transport,
    `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
}

export async function getAttachment(transport, inboxId, messageId, attachment) {
  const pathname = `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachment.attachment_id)}`;
  try {
    const metadata = await jsonFor(transport, pathname);
    if (typeof metadata?.download_url !== 'string') throw new Error('the response carries no download_url');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const response = await fetch(metadata.download_url, { signal: controller.signal });
      if (!response.ok) throw new Error(`the attachment host answered ${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        bytes,
        mime: attachment.content_type ?? metadata.content_type ?? 'application/octet-stream',
        ...(attachment.filename ?? metadata.filename ? { filename: attachment.filename ?? metadata.filename } : {})
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return {
      file: `unavailable/${attachment.attachment_id}`,
      mime: attachment.content_type ?? 'application/octet-stream',
      bytes: Number.isInteger(attachment.size) ? attachment.size : 0,
      sha256: '0'.repeat(64),
      download_failed: true,
      ...(attachment.filename ? { filename: attachment.filename } : {})
    };
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

export function itemFor(message, attachments, mailbox = 'INBOX') {
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
