// SIMULATED album-window matrix (PA-241 contract A). Not part of the test suite:
// run `node test/album-window-matrix.sim.ts [out.json]`. The Bot API is a fake with
// scripted arrival times; the worker, adapter payload and store capture/consume are
// the real ones. It records what the code DOES, and asserts nothing about what
// would be nice: a split album is reported as a split.
import fs from 'node:fs';
import { arrivals, forget, IDLE_MS } from '../adapters/telegram/live.ts';
import { nextOffset } from '../adapters/telegram/cursors.ts';
import * as adapter from '../adapters/telegram/index.ts';
import { captureBatch, idsOf, liveContext, photoUpdate, scriptedServerOf, sleep } from './telegram-fixtures.ts';

type Due = { at: number; update: Record<string, unknown> & { update_id: number } };
type Scenario = { name: string; updates: (w: number) => Due[]; failFile?: string; oversizeMessage?: number; horizonExtra?: (w: number) => number };

const WAITS = [2000, 1500, 1000, 750, 500];
const album = (base: number, msg: number, n: number, group: string) =>
  Array.from({ length: n }, (_, i) => photoUpdate(base + i, msg + i, group) as unknown as Due['update']);
const edit = (id: number, msg: number, group: string) => {
  const p = photoUpdate(id, msg, group);
  return { update_id: id, edited_message: { ...p.message, edit_date: 1789034500, caption: 'edited' } } as unknown as Due['update'];
};

const A = (w: number) => album(1000, 101, 4, 'A');
const SCENARIOS: Scenario[] = [
  { name: 'baseline-4-one-answer', updates: (w) => A(w).map((u) => ({ at: 0, update: u })) },
  { name: 'split-2-answers', updates: (w) => A(w).map((u, i) => ({ at: i < 2 ? 0 : 0.3 * w, update: u })) },
  { name: 'split-3-answers', updates: (w) => A(w).slice(0, 3).map((u, i) => ({ at: i * 0.3 * w, update: u })) },
  ...[0.5, 0.9, 1.1, 2].map((k): Scenario => ({
    name: `late-member-${k}x`,
    updates: (w) => A(w).map((u, i) => ({ at: i < 3 ? 0 : k * w, update: u }))
  })),
  { name: 'reversed-order', updates: (w) => A(w).slice().reverse().map((u, i) => ({ at: i * 0.2 * w, update: u })) },
  { name: 'reversed-order-last-id-late-2x', updates: (w) => A(w).map((u, i) => ({ at: i === 0 ? 2 * w : 0, update: u })) },
  { name: 'edit-before-settle', updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), { at: 0.3 * w, update: edit(1010, 102, 'A') }] },
  { name: 'edit-after-release', updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), { at: 2.5 * w, update: edit(1010, 102, 'A') }] },
  { name: 'repeated-update-in-window', updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), { at: 0.5 * w, update: A(w)[1] }] },
  { name: 'repeated-update-after-release', updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), { at: 1.5 * w, update: A(w)[1] }] },
  {
    name: 'two-albums-B-at-0.4x',
    updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), ...album(2000, 201, 3, 'B').map((u) => ({ at: 0.4 * w, update: u }))]
  },
  {
    name: 'two-albums-B-at-0.9x',
    updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), ...album(2000, 201, 3, 'B').map((u) => ({ at: 0.9 * w, update: u }))]
  },
  {
    name: 'two-albums-B-at-1.5x',
    updates: (w) => [...A(w).map((u) => ({ at: 0, update: u })), ...album(2000, 201, 3, 'B').map((u) => ({ at: 1.5 * w, update: u }))]
  },
  { name: 'failed-download-one-member', updates: (w) => A(w).map((u) => ({ at: 0, update: u })), failFile: 'file-102' },
  { name: 'oversize-one-member', updates: (w) => A(w).map((u) => ({ at: 0, update: u })), oversizeMessage: 103 }
];

async function cell(scn: Scenario, w: number) {
  forget();
  const context = liveContext('carbon-album-matrix-', { album_quiet_ms: w, max_attachment_bytes: 1000 });
  const lines: Record<string, unknown>[] = [];
  const ctx = { ...context, log: (l: Record<string, unknown>) => { lines.push(l); } };
  const dues = scn.updates(w);
  if (scn.oversizeMessage !== undefined) {
    for (const d of dues) {
      const photo = (d.update.message as { message_id: number; photo: { file_size: number }[] } | undefined);
      if (photo?.message_id === scn.oversizeMessage) photo.photo[0].file_size = 5000;
    }
  }
  const delivered = new Set<number>();
  const t0 = Date.now();
  const server = scriptedServerOf({
    respond: ({ call: _call }) => {
      const now = Date.now() - t0;
      return dues.filter((d) => d.at <= now).map((d) => d.update) as never;
    },
    filtered: true
  });
  const inner = globalThis.fetch;
  if (scn.failFile) {
    globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
      if (url.includes('/getFile') && JSON.parse(options.body as string).file_id === scn.failFile) throw new Error('getFile refused');
      return inner(url, options);
    }) as typeof fetch;
  }
  const allIds = [...new Set(dues.map((d) => d.update.update_id))];
  const lastDue = Math.max(...dues.map((d) => d.at));
  const horizon = lastDue + 2 * w + 1000;
  const batches: { at_ms: number; update_ids: number[]; attachments: boolean[]; offset_after: number | null }[] = [];
  const cursorViolations: string[] = [];
  try {
    while (Date.now() - t0 < horizon) {
      const seen = await Promise.race([arrivals(ctx), sleep(IDLE_MS).then(() => [])]);
      // The worker re-hands a set until its next tick sees the confirmed offset; an
      // already-consumed update is not a new turn.
      const items = seen.filter((i) => !delivered.has((i.update as { update_id: number }).update_id));
      if (items.length === 0) { await sleep(25); continue; }
      const pending = captureBatch(ctx, items);
      for (const item of pending) adapter.consume({ ...ctx, items }, item);
      for (const id of idsOf(items)) delivered.add(id as number);
      const offset = nextOffset(ctx.store, ctx.account);
      batches.push({
        at_ms: Date.now() - t0, update_ids: idsOf(items) as number[],
        attachments: items.map((i) => i.attachments !== undefined), offset_after: offset
      });
      // The cursor may not pass an update that was due, delivered by the server and not written.
      for (const d of dues) {
        const id = d.update.update_id;
        if (d.at <= Date.now() - t0 && offset !== null && id < offset && !delivered.has(id)) cursorViolations.push(`update ${id} below offset ${offset} but never written`);
      }
    }
  } finally { globalThis.fetch = inner; server.restore(); }
  const inbound = ctx.store.rebuild().filter((r) => r.direction === 'inbound');
  const sightings = lines.filter((l) => l.stage === 'album-member-sighted');
  const dup = idsOf(batches.flatMap((b) => b.update_ids.map((id) => ({ update: { update_id: id } }) as never)));
  const written = new Set(batches.flatMap((b) => b.update_ids));
  const result = {
    SIMULATED: true, case: scn.name, wait_ms: w,
    turns: batches.length,
    members_per_batch: batches.map((b) => b.update_ids),
    batch_times_ms: batches.map((b) => b.at_ms),
    attachments_present_per_batch: batches.map((b) => b.attachments),
    lost_updates: allIds.filter((id) => !written.has(id)),
    duplicate_members_across_batches: dup.length - new Set(dup).size,
    records: inbound.map((r) => `${r.platform_message_id}@r${r.revision}`).sort(),
    cursor_violations: [...new Set(cursorViolations)],
    sighting_records: sightings.length,
    sighting_max_gap_ms: sightings.length ? Math.max(...sightings.map((s) => s.gap_from_first_ms as number)) : null
  };
  forget();
  return result;
}

const only = process.env.ONLY_WAIT ? [Number(process.env.ONLY_WAIT)] : WAITS;
const out: unknown[] = [];
for (const w of only) for (const scn of SCENARIOS) {
  const r = await cell(scn, w);
  out.push(r);
  console.log(`${w} ${scn.name}: turns=${r.turns} batches=${JSON.stringify(r.members_per_batch)} lost=${JSON.stringify(r.lost_updates)} dup=${r.duplicate_members_across_batches} viol=${r.cursor_violations.length}`);
}
const path = process.argv[2];
if (path) fs.writeFileSync(path, JSON.stringify(out, null, 1));
process.exit(0);
