// PA-241 contract B: release-group-to-release timing brackets. Real ReleaseLoop and Store,
// fake harness and a loopback records service; no credentials. Wall-clock figures
// printed here are SIMULATED fixture time, not live Telegram performance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../stream/store.ts';
import { ReleaseLoop, releaseTracer } from '../runtime/loop.ts';
import * as fixture from '../adapters/fixture/index.ts';
import { fakeHarness } from './fake-harness.ts';
import { replyHandler } from '../runtime/reply-tool.ts';
import type { Declaration } from '../runtime/types.ts';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';

function declaration(): Declaration {
  return {
    schema: 'carbon.agent-declaration.v1', agent: { id: AGENT, client: 'ExampleCorp' }, model: 'm', effort: 'low',
    sandbox: { mode: 'workspace-write', network: false }, provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [], tool_servers: [],
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: 1000, conversations: [], default_conversation_kind: 'customer' }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id' }, limits: { max_turn_ms: 60000 },
    harness: { kind: 'program', version: '1', entrypoint: 'handler.mjs' }, records: { enabled: true }
  } as unknown as Declaration;
}

function item(id: number, text = `body-${id}`) {
  return { conversation: 'c1', id: String(id), position: String(id).padStart(6, '0'), at: `2026-09-10T10:00:00.000Z`, sender: 'contact-1', text };
}

async function records() {
  const calls: string[] = [];
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) void _;
    calls.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'collected' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { calls, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function makeLoop(url: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-trace-'));
  const store = Store.open(path.join(dir, 'store'));
  const decl = declaration();
  const harness = fakeHarness({
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }, { name: 'carbon-records', runtimeStatus: 'connected' }],
    onTurn: () => {
      const handle = replyHandler({ store, agent: AGENT });
      return (_s: unknown, params: { clientUserMessageId: string }) => {
        handle({ conversation_id: `${ACCOUNT}:c1`, request_id: params.clientUserMessageId, text: 'ok' });
        return 'completed';
      };
    }
  } as never);
  const loop = new ReleaseLoop({ declaration: decl, channel: decl.channels![0], store, storeDir: store.dir, adapter: fixture,
    harness, session: harness.session, agent: AGENT, checkout: path.join(dir, 'repo'), work: dir, recordsActionUrl: url });
  return { loop, store, dir };
}

type Line = Record<string, unknown>;
const stages = (lines: Line[], releaseId: string) => lines.filter((l) => l.event === 'latency_experiment' && l.release_id === releaseId);

test('program path: first release is full-store records sync, the next is incremental, proxy is a named no-op, and the stages tile the interval', async () => {
  const service = await records();
  try {
    const { loop } = makeLoop(service.url);
    // The real program path needs a sandbox and entrypoint; this exercises the loop's program branch up to the input builder.
    const lines: Line[] = [];
    loop.log = (line) => lines.push(line);
    const first = [1, 2, 3, 4, 5].map((i) => item(i));
    // The loop gate releases through releaseOne; call the same path the pass uses.
    loop.capture(first);
    const outcome = await loop.releasePass().catch((error) => ({ error }));
    const releaseLine = lines.find((l) => l.event === 'release');
    const releaseIds = lines.filter((l) => l.event === 'latency_experiment' && l.stage === 'release-group-to-release').map((l) => l.release_id);
    assert.ok(releaseLine || (outcome as { error?: unknown }).error, 'a release or a program fault was reached');
    assert.equal(releaseIds.length, 1);
    const mine = stages(lines, releaseIds[0] as string);
    const names = mine.map((l) => l.stage);
    assert.ok(names.includes('records-sync') && names.includes('tool-status') && names.includes('typing-start') && names.includes('program-input'));
    assert.ok(names.at(-1) === 'release-group-to-release' || names.includes('release-group-to-release'));
    const sync = mine.find((l) => l.stage === 'records-sync')!;
    const total = mine.find((l) => l.stage === 'release-group-to-release')!;
    assert.deepEqual(total.records_sync, { mode: 'full-store', candidates: 5, posted: 5, rebuild_ms: (total.records_sync as { rebuild_ms: number }).rebuild_ms });
    assert.equal(total.proxy, 'no-api-key-via');
    assert.equal(service.calls.filter((c) => c === '/collect').length, 5);
    assert.equal(sync.status, 'ok');
    const duration = (l: Line) => (l.ended_monotonic_ms as number) - (l.started_monotonic_ms as number);
    const parts = mine.filter((l) => l.stage !== 'release-group-to-release').reduce((n, l) => n + duration(l), 0);
    assert.ok(Math.abs(duration(total) - parts - (total.unattributed_ms as number)) < 0.01);
    assert.ok(!mine.some((l) => 'update_id' in l || 'update_ids' in l));
  } finally { await service.close(); }
});

test('later pass: thread cached, records sync incremental with only the new record posted', async () => {
  const service = await records();
  try {
    const { loop } = makeLoop(service.url);
    const lines: Line[] = [];
    loop.log = (line) => lines.push(line);
    loop.capture([item(1)]);
    await loop.releasePass().catch(() => {});
    const collects = () => service.calls.filter((c) => c === '/collect').length;
    const before = collects();
    lines.length = 0;
    loop.capture([item(2)]);
    await loop.releasePass().catch(() => {});
    const total = lines.find((l) => l.stage === 'release-group-to-release');
    assert.ok(total, 'second release traced');
    assert.equal((total!.records_sync as { mode: string }).mode, 'incremental');
    assert.equal(total!.thread, 'cached');
    assert.equal(collects() - before, 1);
  } finally { await service.close(); }
});

test('an operation that is not bracketed shows up as unattributed time', async () => {
  const lines: Line[] = [];
  const trace = releaseTracer((l) => lines.push(l as Line), 'fixture', 'r1', ['a']);
  trace.span('bracketed', () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  trace.finish();
  const total = lines.find((l) => l.stage === 'release-group-to-release')!;
  assert.ok((total.unattributed_ms as number) >= 25, `unattributed ${total.unattributed_ms}`);
  assert.equal(lines.filter((l) => l.stage === 'bracketed').length, 1);
});

test('SIMULATED scaling: store-rebuild and full records-sync at 328 and 3000 records, through the real store and sync paths', async () => {
  for (const count of [328, 3000]) {
    const service = await records();
    try {
      const { loop, store } = makeLoop(service.url);
      loop.capture(Array.from({ length: count }, (_, i) => item(i + 1)));
      const t0 = performance.now();
      const rebuilt = store.rebuild().length;
      const rebuildMs = performance.now() - t0;
      const t1 = performance.now();
      await loop.syncCollected([]);
      const syncMs = performance.now() - t1;
      assert.equal(rebuilt, count);
      assert.equal(service.calls.filter((c) => c === '/collect').length, count);
      console.log(`SIMULATED scaling records=${count} store-rebuild=${rebuildMs.toFixed(1)}ms full-records-sync=${syncMs.toFixed(1)}ms (rebuild inside sync ${loop.syncStats!.rebuild_ms}ms, posts ${loop.syncStats!.posted})`);
    } finally { await service.close(); }
  }
});

test('a throwing trace logger never fails the work or masks the original error', async () => {
  const boom = () => { throw new Error('logger down'); };
  const trace = releaseTracer(boom, 'fixture', 'r1', ['a']);
  assert.equal(trace.span('sync', () => 7), 7);
  assert.equal(await trace.span('async', async () => 8), 8);
  assert.throws(() => trace.span('sync-fail', () => { throw new Error('original-sync'); }), /original-sync/);
  await assert.rejects(trace.span('async-fail', async () => { throw new Error('original-async'); }), /original-async/);
  assert.doesNotThrow(() => trace.finish());
  assert.doesNotThrow(() => trace.finish('error'));
});

test('non-trace logging is unchanged when the trace emit is guarded', () => {
  const lines: Line[] = [];
  const trace = releaseTracer((l) => lines.push(l as Line), 'fixture', 'r1', ['a']);
  trace.finish('held');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'release-group-to-release');
  assert.equal(lines[0].status, 'held');
});

for (const [name, arm] of [
  ['tool hold fault', (loop: any) => { loop.harness.holdsRelease = () => [{ code: 'X', subject: 'tool' }]; }],
  ['provider proxy fault', (loop: any) => { loop.checkProviderProxy = async () => [{ code: 'PROXY' }]; }],
  ['records action hold', (loop: any) => { loop.syncCollectedOrHold = async () => false; }]
] as const) {
  test(`early hold (${name}) is status held, not released, and the hold behavior is unchanged`, async () => {
    const service = await records();
    try {
      const { loop, store } = makeLoop(service.url);
      const lines: Line[] = [];
      loop.log = (line) => lines.push(line);
      loop.capture([item(1)]);
      arm(loop);
      await loop.releasePass().catch(() => {});
      const total = lines.filter((l) => l.stage === 'release-group-to-release');
      assert.equal(total.length, 1);
      assert.equal(total[0].status, 'held');
      assert.ok(!lines.some((l) => l.event === 'release'), 'no release line');
      assert.ok(store.rebuild().every((r) => !r.release), 'record not released');
    } finally { await service.close(); }
  });
}

test('a real release is status ok and a failure before release is status error', async () => {
  const service = await records();
  try {
    const { loop } = makeLoop(service.url);
    const lines: Line[] = [];
    loop.log = (line) => lines.push(line);
    loop.capture([item(1)]);
    await loop.releasePass().catch(() => {});
    assert.ok(lines.some((l) => l.event === 'release'));
    assert.equal(lines.find((l) => l.stage === 'release-group-to-release')!.status, 'ok');
    lines.length = 0;
    loop.capture([item(2)]);
    (loop as any).syncCollectedOrHold = async () => { throw new Error('sync broke'); };
    await loop.releasePass().catch(() => {});
    assert.equal(lines.find((l) => l.stage === 'release-group-to-release')!.status, 'error');
  } finally { await service.close(); }
});

test('full-store candidate count is reported separately from actual inbound POSTs', async () => {
  const service = await records();
  try {
    const { loop } = makeLoop(service.url);
    const lines: Line[] = [];
    loop.log = (line) => lines.push(line);
    loop.capture([item(1)]);
    await loop.releasePass().catch(() => {});
    const base = loop.store.rebuild()[0];
    const { release: _release, ...rest } = base as Record<string, unknown>;
    loop.store.capture({ ...rest, message_id: `${base.conversation_id}:out-0001`, platform_message_id: 'out-0001', direction: 'outbound',
      role: 'agent', sender_id: ACCOUNT, body: 'the reply'} as never);
    const outbound = loop.store.rebuild().filter((r) => r.direction === 'outbound').length;
    assert.equal(outbound, 1);
    loop.collectedSynced = false;
    lines.length = 0;
    const before = service.calls.filter((c) => c === '/collect').length;
    loop.capture([item(2)]);
    await loop.releasePass().catch(() => {});
    const sync = lines.find((l) => l.stage === 'release-group-to-release')!.records_sync as { mode: string; candidates: number; posted: number };
    const posts = service.calls.filter((c) => c === '/collect').length - before;
    assert.equal(sync.mode, 'full-store');
    assert.equal(sync.candidates, 2 + outbound);
    assert.equal(sync.posted, 2);
    assert.equal(posts, sync.posted);
    assert.ok(sync.candidates > sync.posted);
  } finally { await service.close(); }
});

test('only a program harness emits release-trace lines; another harness releases with none', async () => {
  const service = await records();
  try {
    const { loop } = makeLoop(service.url);
    (loop.declaration.harness as { kind: string }).kind = 'codex-app-server';
    const lines: Line[] = [];
    loop.log = (line) => lines.push(line);
    loop.capture([item(1)]);
    await loop.releasePass().catch(() => {});
    assert.ok(lines.some((l) => l.event === 'release'), 'the release itself still happens');
    assert.equal(lines.filter((l) => l.event === 'latency_experiment' && l.run_id === 'fixture:release').length, 0);
  } finally { await service.close(); }
});

test('the proxy note names the branch actually taken', async () => {
  for (const [probe, server, want] of [[true, 'http://127.0.0.1:1', 'probed-up'], [false, 'http://127.0.0.1:1', 'probed-down']] as const) {
    const service = await records();
    try {
      const { loop } = makeLoop(service.url);
      const decl = loop.declaration as unknown as Record<string, unknown>;
      decl.provider = { name: 'openai', auth: 'chatgpt', api_key_via: 'proxy' };
      decl.tool_servers = [{ name: 'proxy', ...(server ? { url: server } : {}) }];
      loop.probe = async () => probe;
      const lines: Line[] = [];
      loop.log = (line) => lines.push(line);
      loop.capture([item(1)]);
      await loop.releasePass().catch(() => {});
      const total = lines.find((l) => l.stage === 'release-group-to-release');
      if (want === 'probed-down') {
        assert.equal(total, undefined, 'the pass holds on a down proxy before any release is bracketed');
        assert.ok(lines.some((l) => l.event === 'provider_proxy.hold'));
      } else {
        assert.equal(total!.proxy, want);
      }
    } finally { await service.close(); }
  }
});
