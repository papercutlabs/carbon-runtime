// Trusted server input for an attributed ticket conversation. The companion
// authenticates the consultant; this adapter never treats a browser claim as a grant.
import crypto from 'node:crypto';
import type { Store, MessageRecord, Delivery } from '../../stream/store.ts';
import { fault } from '../../stream/faults.ts';
import { StreamFault } from '../../stream/store.ts';

export type BrowserPacket = {
  account: string; ticket_key: string; submission_id: string;
  consultant: { id: string; name: string };
  request_kind?: 'investigate' | 'follow_up' | 'copy_draft';
  input_kind?: 'start' | 'message'; attachment_ids?: string[];
  body: string; accepted_at: string; position: string;
};
type Context = { store: Store; agent: string; account: string; items?: BrowserPacket[] };
export const capabilities = ['inbound', 'outbound'];
function refuse(subject: string, problem: string): never {
  throw new StreamFault([fault('BROWSER_PACKET_INVALID', subject, problem,
    'supply a validated server-attributed browser packet; see adapters/browser/README.md')]);
}
function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[/\\\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') refuse(name, 'identifier is absent or unsafe');
}
export function browserConversationId(account: string, ticketKey: string) {
  identifier(account, 'account');
  if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(ticketKey)) refuse('ticket_key', 'ticket key is not canonical');
  return `${account}:ticket:${ticketKey}`;
}
export function browserMessageId(account: string, ticketKey: string, submissionId: string) {
  identifier(submissionId, 'submission_id');
  return `${browserConversationId(account, ticketKey)}:${submissionId}`;
}
function validateBrowserContent(packet: BrowserPacket) {
  if (packet.input_kind === undefined && !['investigate', 'follow_up', 'copy_draft'].includes(packet.request_kind ?? '')) refuse('request_kind', 'unknown request kind');
  if (packet.input_kind !== undefined && !['start', 'message'].includes(packet.input_kind)) refuse('input_kind', 'unknown input kind');
  if (packet.input_kind !== undefined && packet.request_kind !== undefined) refuse('request_kind', 'ordinary chat must not carry a legacy request kind');
  validateBrowserFileIds(packet);
  if (typeof packet.body !== 'string' || (packet.body.trim().length === 0 && packet.input_kind !== 'start' && !(packet.attachment_ids?.length)) || Buffer.byteLength(packet.body) > 128 * 1024) refuse('body', 'message is empty or exceeds 128 KiB');
}
function validateBrowserFileIds(packet: BrowserPacket) {
  if (packet.attachment_ids !== undefined && (!Array.isArray(packet.attachment_ids) || packet.attachment_ids.length > 100 || new Set(packet.attachment_ids).size !== packet.attachment_ids.length)) refuse('attachment_ids', 'attachment identities are malformed or duplicated');
  for (const id of packet.attachment_ids ?? []) identifier(id, 'attachment_ids');
}
export function browserPacket(packet: BrowserPacket): BrowserPacket {
  browserMessageId(packet.account, packet.ticket_key, packet.submission_id);
  identifier(packet.consultant?.id, 'consultant.id');
  if (typeof packet.consultant?.name !== 'string' || packet.consultant.name.length === 0 || packet.consultant.name.length > 256) refuse('consultant.name', 'authenticated display name is absent or too long');
  validateBrowserContent(packet);
  if (typeof packet.accepted_at !== 'string' || !Number.isFinite(Date.parse(packet.accepted_at))) refuse('accepted_at', 'server acceptance time is invalid');
  if (typeof packet.position !== 'string' || !/^[0-9]{20}$/.test(packet.position)) refuse('position', 'server cursor must be a twenty-digit ordinal');
  // Copy only declared fields; callers cannot smuggle overrides or credentials.
  return { account: packet.account, ticket_key: packet.ticket_key, submission_id: packet.submission_id,
    consultant: { id: packet.consultant.id, name: packet.consultant.name },
    ...(packet.request_kind === undefined ? {} : { request_kind: packet.request_kind }),
    ...(packet.input_kind === undefined ? {} : { input_kind: packet.input_kind }),
    ...(packet.attachment_ids === undefined ? {} : { attachment_ids: [...packet.attachment_ids] }),
    body: packet.body, accepted_at: packet.accepted_at, position: packet.position };
}
export function listPending(context: Context) {
  return (context.items ?? []).filter((candidate) => {
    const packet = browserPacket(candidate);
    if (packet.account !== context.account) refuse('account', 'packet belongs to another configured account');
    const at = context.store.cursors(browserConversationId(packet.account, packet.ticket_key)).message;
    return at === null || packet.position > at;
  });
}
export function consume(context: Context, packet: BrowserPacket) {
  context.store.advanceCursor(browserConversationId(context.account, packet.ticket_key), 'message', packet.position);
}
export function payload(context: Context, packets: BrowserPacket[]) {
  const entries = packets.map((candidate) => {
    const packet = browserPacket(candidate);
    if (packet.account !== context.account) refuse('account', 'packet belongs to another configured account');
    const record: MessageRecord = {
      schema: 'carbon.message.v1', agent: context.agent, source: 'browser', account: context.account,
      conversation_id: browserConversationId(context.account, packet.ticket_key), conversation_kind: 'thread',
      message_id: browserMessageId(context.account, packet.ticket_key, packet.submission_id),
      platform_message_id: packet.submission_id, revision: 0, direction: 'inbound', role: 'operator',
      sender_id: packet.consultant.id, sender_name: packet.consultant.name, received_at: packet.accepted_at,
      body: packet.body, attachments: [], historical: false, disposition: 'captured',
      adapter_fields: { ticket_key: packet.ticket_key, submission_id: packet.submission_id, ...(packet.request_kind === undefined ? {} : { request_kind: packet.request_kind }),
        ...(packet.input_kind === undefined ? {} : { input_kind: packet.input_kind }), attachment_ids: packet.attachment_ids ?? [] }
    };
    return { record, raw: JSON.stringify(packet), cursor: { kind: 'message' as const, position: packet.position }, attachments: [] };
  });
  return { entries, parked: [] };
}
export function matchesDelivery(_context: Context, packet: BrowserPacket, delivery: Pick<Delivery, 'text_sha256'>) {
  return crypto.createHash('sha256').update(packet.body).digest('hex') === delivery.text_sha256;
}
// Release is the stored reply becoming visible through the authenticated read.
// There is no external client send or mutable third-party message endpoint.
export function send(_context: Context, record: MessageRecord & { delivery: Delivery }) {
  return { status: 'sent' as const, chunk_ids: [record.message_id] };
}
