// Import-side structures describe the fields each stage reads. External values
// remain unknown until a conversion or the store's schema validator handles them.
import type { Store, MessageRecord, MessageRole, Attachment } from '../stream/store.ts';

export type Fields = Record<string, unknown>;
export type LidMap = { phone_to_lid: Record<string, string>; lid_to_phone?: Record<string, string> };
export type MediaRoot = { root?: unknown };
export type MediaRef = { ref: string; path?: string; present: boolean | null };
export type WantedAttachment = { bytes: Uint8Array; mime?: string; filename?: string };
export type CaptureRow = {
  chat_jid?: unknown; chat_name?: unknown; message_id?: unknown; timestamp?: unknown;
  from_me?: unknown; sender_jid?: unknown; sender_name?: unknown; text?: unknown;
  message_type?: unknown; has_media?: unknown; attachments?: WantedAttachment[];
};
export type RoleMapping = { roles?: { agent_senders?: string[]; operator_senders?: string[]; from_me?: MessageRole; default?: MessageRole } };
export type CorrectionQuery = { kind: string; sql: string; timestamp?: string; message_refs?: string };
export type MessageMapping = {
  table: string; columns?: Record<string, string | null>; carry?: string[];
  timestamp?: string; media_refs?: string; media_ref_key?: string; where?: unknown; order_by?: unknown;
};
export type LedgerMapping = RoleMapping & {
  ledger?: unknown; agent?: unknown; account?: unknown; messages: MessageMapping;
  media?: MediaRoot; corrections?: CorrectionQuery[];
};
export type SourceSection = {
  record?: string | null; select?: Fields; timestamp?: string; media_refs?: string;
  answers_refs?: string; fields?: Record<string, string | null>; carry?: string[];
};
export type TurnSection = SourceSection & { sql: string };
export type OutboundMapping = RoleMapping & {
  ledger?: unknown; agent?: unknown; account?: unknown; media?: MediaRoot;
  outbound: { events?: SourceSection; audit?: SourceSection; turns?: TurnSection; link?: { tolerance_seconds?: unknown } };
};
export type LedgerItem = {
  chat_jid: string; chat_name: string; message_id: string; sender_jid: string | null;
  sender_name: string | null; from_me?: boolean; timestamp: string | null; text: string;
  message_type: string; reply_to: string | null; has_media: boolean; media: MediaRef[]; fields: Fields;
};
export type SourceKind = 'event' | 'turn' | 'audit';
export type OutboundItem = LedgerItem & { kind: SourceKind; status: string | null; answers_refs: string[] };
export type LocatedItem = OutboundItem & { chat_key: string; chat_key_note: string | null; conversation_id: string };
export type ImportContext<TItem = CaptureRow, TMapping = RoleMapping & { ledger?: unknown }> = {
  store: Store; agent: string; account: string; lid_map?: LidMap; items?: TItem[];
  mapping?: TMapping; tolerance_ms?: number;
};
export type LedgerContext = ImportContext<LedgerItem, LedgerMapping>;
export type OutboundContext = ImportContext<OutboundItem, OutboundMapping>;
export type ImportFields = Fields & {
  media?: MediaRef[]; media_missing?: string; answers?: string[]; identified_by?: string;
};
export type ImportRecord = MessageRecord<Attachment> & { adapter_fields?: ImportFields };
export type ImportEntry = { record: ImportRecord; raw: string; attachments: WantedAttachment[] };
export type CaptureOptions = { disposition: MessageRecord['disposition']; raw?: string };
export type MessageIndex = Map<string, { conversation_id: string; message_id: string }>;
export type NamedSources = { '--events': string | null; '--audit': string | null; '--turns': string | null };
export type NamedOutbound = NamedSources & { '--mapping': string; '--store': string; '--agent': string | null; '--account': string | null };
