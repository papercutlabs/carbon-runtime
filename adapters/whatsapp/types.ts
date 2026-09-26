// Adapter-owned context is configuration from the runtime; provider and fixture
// message leaves are untrusted. No type here promises a stored message schema.
import type { Store } from '../../stream/store.ts';

export type Fields = Record<string, unknown>;
export type Item = {
  position?: string;
  received_at?: unknown;
  event?: unknown;
  raw?: unknown;
  extra?: unknown;
  wrong_type?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
};
export type SendSocket = {
  sendMessage?: (chat: string, content: { text: string }) => Promise<unknown>;
  sendPresenceUpdate?: (state: 'composing' | 'paused', chat: string) => Promise<unknown>;
};
export type Context = {
  store: Store; account: string; agent: string; items?: Item[]; now?: number;
  channel?: { auth_dir?: string; album_quiet_ms?: number; max_message_chars?: number; hold?: { release_after_ms?: number } };
  dry_run?: boolean; socket?: SendSocket;
};
export type Outbound = { conversation_id: string; body?: string | null; delivery: { request_id: string } };
export type SendResult = { status: string; chunk_ids: unknown[] };
export type Entry = {
  // wrong_type is assigned without validation, so even constructed fields can change.
  record: Fields; raw: unknown; cursor: { kind: 'message' | 'revision'; position: string | undefined };
  attachments: unknown[];
};
export type Parked = Omit<Entry, 'attachments'> & { reason: string };
