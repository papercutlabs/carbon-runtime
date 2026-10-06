// Scalar read projection for a single-writer Store. Persisted captures/index
// remain authoritative; this cache is discarded with that Store on replacement.
import { Store } from '../stream/store.ts';
type Row = { conversation_id: string; message_id: string; revision: number; seq: number; cursor: number };
const projections = new WeakMap<Store, BrowserProjection>();
function identity(row: Pick<Row, 'message_id' | 'revision'>) { return JSON.stringify([row.message_id, row.revision]); }
class BrowserProjection {
  rows = new Map<string, Map<string, Row>>();
  initialized = new Set<string>();
  version = -1;
  declare store: Store;
  constructor(store: Store) {
    this.store = store;
    for (const indexed of store.indexEntries() as Omit<Row, 'cursor'>[]) this.put({ ...indexed, cursor: indexed.seq });
  }
  put(row: Row) {
    let conversation = this.rows.get(row.conversation_id);
    if (!conversation) { conversation = new Map(); this.rows.set(row.conversation_id, conversation); }
    const prior = conversation.get(identity(row));
    conversation.set(identity(row), { ...row, seq: row.seq || prior?.seq || 0, cursor: Math.max(row.cursor, prior?.cursor ?? 0) });
  }
  page(conversationId: string, after: number, limit: number) {
    if (this.version !== this.store.browserProjectionVersion) {
      for (const changed of this.store.browserProjectionUpdates.values()) this.put(changed);
      this.version = this.store.browserProjectionVersion;
    }
    const rows = this.rows.get(conversationId) ?? new Map<string, Row>();
    if (!this.initialized.has(conversationId)) {
      // State cursors live in actual captures. Pay this ticket's reconstruction
      // cost once, then reread full records only after slicing a requested page.
      for (const row of rows.values()) {
        const record = this.store.read(conversationId, row.message_id, row.revision)!;
        row.cursor = Math.max(row.cursor, Number(record.adapter_fields?.browser_event_seq ?? 0));
      }
      this.initialized.add(conversationId);
    }
    const matching = [...rows.values()].filter((row) => row.cursor > after).sort((a, b) => a.cursor - b.cursor);
    return { rows: matching.slice(0, limit), has_more: matching.length > limit };
  }
}
export function browserPageRows(store: Store, conversationId: string, after: number, limit: number) {
  let projection = projections.get(store);
  if (!projection) { projection = new BrowserProjection(store); projections.set(store, projection); }
  return projection.page(conversationId, after, limit);
}
