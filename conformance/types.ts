import type { Store, MessageRecord } from '../stream/store.ts';

// Adapter candidates and attachment metadata are unvalidated. Ingest passes
// them unchanged to the existing store and Buffer operations.
export type Payload = {
  entries: { record: unknown; attachments?: unknown; raw?: unknown; cursor?: unknown }[];
  parked: { record: unknown; reason: unknown; raw?: unknown; cursor?: unknown }[];
};
export type CaseContext = {
  agent: string;
  account: string;
  store: Store;
  fixtures: Record<string, unknown[]>;
  items: unknown[];
  dry_run: boolean;
  now: number;
  adapter: {
    payload(context: CaseContext, items: unknown[]): Payload;
    listPending(context: CaseContext): unknown[];
    consume(context: CaseContext, item: unknown): unknown;
    send(context: CaseContext, record: MessageRecord): unknown;
  };
};
export type ConformanceCase = {
  number: number;
  name: string;
  capabilities: string[];
  run(context: CaseContext): void;
};

export type IngestContext<C, I> = C & {
  store: Pick<Store, 'putAttachment' | 'capture' | 'park'>;
  adapter: { payload: (context: C, items: I[]) => Payload };
};
