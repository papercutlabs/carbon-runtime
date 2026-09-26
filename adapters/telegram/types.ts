// Provider fields have no validated schema here. Property views below leave each
// value unknown; the existing reads, comparisons and store validator decide its
// runtime meaning. They must never be used as a validated provider response.
import type { Store, MessageRecord, Attachment } from '../../stream/store.ts';

export type Fields = Record<string, unknown>;
export type Transport = { token: string; apiHost?: string };
export type Channel = {
  allowed_chat_ids?: unknown; operator_sender_ids?: unknown[];
  max_message_chars?: number; max_attachment_bytes?: number; mode?: string;
  long_poll_timeout_s?: number; album_quiet_ms?: number;
  bot_token?: string; bot_id?: unknown; api_host?: string;
  hold?: { release_after_ms?: number };
};
export type Item = {
  conversation?: string | null; position: string | null; received_at?: string;
  update: unknown; attachments?: unknown; extra?: Fields; raw?: string; wrong_type?: unknown;
};
export type ArrivedItem = Item & { received_at: string };
export type Context = {
  agent: string; account: string; store: Store; channel?: Channel;
  fixtures?: { 'channel.json'?: Channel }; items?: Item[]; now?: number;
  dry_run?: boolean; transport?: Transport;
};
export type Media = { file_id: unknown; bytes: unknown; mime: unknown; file_name: unknown; kind: string };
export type FetchedMedia = { bytes: Buffer; mime: unknown; filename: unknown };
// Candidate records have not passed Store.capture's schema validation. In
// particular sender_name, attachment metadata and fixture overrides are unknown.
export type Candidate = Fields & {
  conversation_id: string; message_id: string; platform_message_id: string;
  received_at: string; body: string; attachments: unknown[];
  sender_name?: unknown; sent_at?: string; reply_to?: string;
  hold?: { reason: string; set_at: string; release_after_ms: number };
  adapter_fields?: Fields;
};
export type Entry = { record: Fields; raw: string; cursor: { kind: 'message' | 'revision'; position: string | null }; attachments?: unknown[] };
export type Parked = Entry & { reason: string };
export type Reply = Pick<MessageRecord, 'conversation_id'> & {
  conversation_kind?: string; reply_to?: string; body?: string;
  delivery: { request_id: string }; attachments?: (Omit<Attachment, 'mime'> & { mime?: string })[];
};
