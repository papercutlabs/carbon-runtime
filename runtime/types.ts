import type { Store, MessageRecord } from '../stream/store.ts';
import type { Fault } from '../stream/faults.ts';
import type { AccountRead, RateLimitsRecord } from '../harness/codex/index.ts';

// Caller contracts describe the operations this runtime performs, not a schema
// validator. Values read from disk and providers remain unknown at those edges.
export type Log = (line: Record<string, unknown>) => unknown;
export type Channel = {
  [key: string]: unknown;
  kind: string;
  account: string;
  release?: string;
  quiet_ms?: number;
  mention?: unknown;
  poll_interval_ms?: unknown;
  poll_failures_before_hold?: unknown;
  inbound?: unknown;
  transport?: Record<string, unknown>;
  conversations?: { id: unknown; kind?: unknown }[];
  default_conversation_kind?: unknown;
};
export type Teaching = { [key: string]: unknown; enabled?: unknown; max_active?: number; max_chars?: number };
export type Server = {
  [key: string]: unknown;
  name: string;
  transport?: string;
  runs_as?: string;
  secret_refs?: string[];
  required?: boolean;
  url?: string;
  command?: string;
  cwd?: string;
  // `mcp` when absent. `provider_proxy` is the tools-user Responses proxy that
  // holds the provider key (PA-259): it is started from the pinned harness release,
  // fed the key on stdin, and is never an MCP server.
  kind?: string;
  stdin_secret?: string;
  upstream_url?: string;
};
export type Declaration = {
  [key: string]: unknown;
  agent?: { id?: string; client?: unknown };
  channels?: Channel[];
  secrets?: { name: string; path: string; purpose?: string }[];
  provider?: { name?: string; auth?: string; api_key_ref?: string; api_key_via?: string };
  harness?: { kind?: string; version?: unknown; entrypoint?: unknown; prepare_entrypoint?: unknown; secret_refs?: unknown };
  model?: string;
  effort?: string;
  sandbox?: { mode?: string; network?: boolean };
  tool_servers?: Server[];
  runtime?: { env?: { name: string; value: string }[] };
  teaching?: Teaching;
  records?: { enabled?: boolean };
  unit_of_work?: { kind?: string; id_from?: unknown; idle_close_ms?: number };
  limits?: { max_turn_ms?: number };
};
export type Context = {
  store: Store; agent: string; account: string; channel: Channel;
  declaration: Declaration; items: unknown; dry_run: boolean; now: number; log?: Log;
};
export type Status = { name: string; runtimeStatus?: string | null };
export type ThreadOpening = {
  cwd: string; model?: string; effort?: string; sandbox?: string; unitId: string; permissions?: string; config?: Record<string, unknown>;
};
export type CodexInput = string | unknown[];
export type ProgramReply = { conversation_id?: string; request_id?: string; text?: string; attachments?: string[]; about_job?: string; about_move?: string };
export type ProgramResult = { disposition?: string; replies?: ProgramReply[]; observations?: unknown; timings?: unknown };
export type ProgramReleaseInput = {
  schema: 'carbon.program-release.v1'; release_id: string; conversation_id: string; thread_id: string;
  client_user_message_id: string; checkout: string; work: string;
  messages: {
    message_id: string; source_message_id: string; revision: number; caption: string;
    sender_id: string; sender_name: string | null; received_at: string;
    attachments: { filename: string | null; mime: string | null; bytes: number | null; sha256: string | null; path: string | null; download_failed: boolean }[];
  }[];
};
export type TurnInput = CodexInput | ProgramReleaseInput;
export type TurnParams<I = CodexInput> = {
  threadId: string; input: I; text?: string; effort?: string; model?: string;
  sandboxPolicy?: unknown; permissions?: string; clientUserMessageId: string; timeoutMs?: number; onStarted?: (evidence: { threadId: string; turnId: string }) => void;
};
export type TurnResult = {
  thread_id?: unknown; turn_id?: unknown; status?: unknown;
  completed_at?: unknown; agent_message?: unknown; token_usage?: unknown;
  error?: unknown; items?: unknown;
  program?: ProgramResult;
};
export type ChildExit = { code: number | null; signal: string | null };
export type Session = { stop?(): Promise<unknown>; exit: Promise<ChildExit> };
export type Harness<S = Session, I = CodexInput> = {
  listHooks?(session:S,options:{cwds:string[]}):Promise<unknown>;
  connect(options: {
    binary: string; codexHome: string; providerKeyPath?: string;
    providerKeyEnvName?: string; experimentalApi?: boolean; checkout?: string; work?: string; declaration?: Declaration;
    sandboxDeny?: { file: string; root: string }; storeDir?: string;
    onEvent(event: { kind?: unknown; threadId?: unknown; turnId?: unknown; params?: unknown }): unknown;
    onStderr(): void;
  }): Promise<S>;
  openThread(session: S, options: ThreadOpening): Promise<{ thread_id: string; [key: string]: unknown }>;
  resumeThread(session: S, options: ThreadOpening & { threadId: string }): Promise<unknown>;
  turn(session: S, options: TurnParams<I>): Promise<TurnResult>;
  steer?(session: S, options: { threadId: string; expectedTurnId: string; input: unknown; clientUserMessageId: string }): Promise<unknown>;
  classifySteerFailure?(error: unknown, context: { threadId: string; expectedTurnId: string; threadRead?: unknown; events?: unknown[] }): { delivery: 'definitely_not_delivered' | 'uncertain'; [key: string]: unknown };
  readThread?(session: S, options: { threadId: string; includeTurns: boolean }): Promise<unknown>;
  listToolServerStatus(session: S, options: { threadId: string }): Promise<Status[]>;
  onToolServerStatus?(session: S, handler: () => void): unknown;
  holdsRelease(declaration: Declaration, statuses: Status[]): Fault[];
  policyFor(mode: string | undefined, options: { writableRoots: string[]; networkAccess: boolean }): unknown;
  // The provider account the session is signed in to (PA-259). Optional, so a
  // harness without it records nothing and runs as before.
  readAccount?(session: S, options: { timeoutMs: number }): Promise<AccountRead>;
  rateLimitsFrom?(snapshot: unknown): RateLimitsRecord | null;
  prepare?(session: S, messages: unknown[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ status: string; artifacts: string[]; ms: number; detail?: string }>;
  discardPrepared?(session: S, files: string[]): void;
};
export type TeachHandle = { setRelease(id: string | null): void };
export type TurnOptions = { store?: Store | null; checkout?: string | null; declaration?: Declaration | null };
export type RecordOrRecords = MessageRecord | MessageRecord[];
export type RenderRecord = { source?: string; adapter_fields?: Record<string, unknown>; conversation_id?: unknown; message_id?: unknown; revision?: unknown; received_at?: unknown; sender_name?: unknown; sender_id?: unknown; body?: string; attachments?: unknown[] };
export type RenderRecords = RenderRecord | RenderRecord[];
