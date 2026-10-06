// Shared activity is a projection of the existing thread's retained evidence.
import type { Store } from '../stream/store.ts';
export type BrowserActivity = {
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain' | null;
  release_id: string | null; native_turn_id: string | null; submission_ids: string[];
  update: { item_id: string; text: string; observed_at: string } | null;
  reason: unknown;
};
export function readBrowserActivity(store: Store, conversationId: string) {
  const thread = store.readThread(conversationId);
  return { activity: (thread?.browser_activity ?? null) as BrowserActivity | null,
    activity_cursor: Number(thread?.browser_activity_cursor ?? 0) };
}
export function writeBrowserActivity(store: Store, conversationId: string, activity: BrowserActivity) {
  const thread = store.readThread(conversationId) ?? {};
  store.writeThread(conversationId, { ...thread, browser_activity: activity, browser_activity_cursor: store.nextSeq() });
  return readBrowserActivity(store, conversationId);
}
