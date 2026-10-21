// PA-241 contract A: per-member sighting records in the existing adapter emit.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { arrivals, forget, ALBUM_QUIET_MS } from '../adapters/telegram/live.ts';
import { liveContext, photoUpdate, update, scriptedServerOf, waitForBatch, sleep } from './telegram-fixtures.ts';

afterEach(() => { forget(); });
type Line = Record<string, unknown>;

function run(script: (call: number) => unknown[]) {
  forget();
  const lines: Line[] = [];
  const context = { ...liveContext('carbon-telegram-sight-', { album_quiet_ms: 150, max_attachment_bytes: 1000 }), log: (l: Line) => { lines.push(l); } };
  const server = scriptedServerOf({ respond: ({ call }) => script(call) as never });
  return { context, lines, server };
}
const sighted = (lines: Line[]) => lines.filter((l) => l.event === 'latency_experiment' && l.stage === 'album-member-sighted');

test('the default album wait is unchanged', () => { assert.equal(ALBUM_QUIET_MS, 2000); });

test('one sighting record per newly remembered album update, with a gap from the first and no content', async () => {
  const a = [photoUpdate(940001, 601, 'secret-group-id'), photoUpdate(940002, 602, 'secret-group-id'), photoUpdate(940003, 603, 'secret-group-id')];
  const r = run((call) => (call === 1 ? [a[0]] : call === 2 ? [a[0], a[1]] : [a[0], a[1], a[2]]));
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    const s = sighted(r.lines);
    assert.deepEqual(s.map((l) => l.source_ids), [[940001], [940002], [940003]], 'repeats must not add records');
    assert.equal(s[0].gap_from_first_ms, 0);
    assert.ok((s[1].gap_from_first_ms as number) >= 0 && (s[2].gap_from_first_ms as number) >= (s[1].gap_from_first_ms as number));
    assert.equal(new Set(s.map((l) => l.album_ref)).size, 1);
    assert.match(s[0].album_ref as string, /^[0-9a-f]{16}$/);
    assert.ok(s.every((l) => l.status === 'ok' && l.schema === 'carbon.latency-experiment.v1' && l.source_count === 1));
    const text = JSON.stringify(s);
    assert.ok(!text.includes('secret-group-id') && !text.includes('file-'), 'the record carried content or the raw group id');
  } finally { r.server.restore(); }
});

test('non-album updates emit no sighting record', async () => {
  const r = run(() => [update(940101, 611, 'hello'), photoUpdate(940102, 612, null)]);
  try {
    await arrivals(r.context);
    await waitForBatch(r.context);
    await sleep(20);
    assert.equal(sighted(r.lines).length, 0);
  } finally { r.server.restore(); }
});

test('a throwing log does not fail the poll', async () => {
  forget();
  const context = { ...liveContext('carbon-telegram-sight-', { album_quiet_ms: 100 }), log: () => { throw new Error('log down'); } };
  const server = scriptedServerOf({ respond: () => [photoUpdate(940201, 621, 'g'), photoUpdate(940202, 622, 'g')] as never });
  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.equal(items.length, 2);
  } finally { server.restore(); }
});
