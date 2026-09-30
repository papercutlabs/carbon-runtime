// PA-322: a stop is a drain. The backup capture stops the agent unit every four
// minutes, and `systemctl stop` sends the runtime SIGTERM. These tests send a real
// signal to a real runtime process (test/fixtures/drain-runner.ts): run(), its
// loop, the store, the reply tool and the locks are the real ones; the harness is
// the fake the other runtime tests use and the channel is the fixture adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { run } from '../runtime/index.ts';
import { EXIT } from '../runtime/faults.ts';
import { lockFile } from '../runtime/lock.ts';
import { Store } from '../stream/store.ts';
import { fakeHarness } from './fake-harness.ts';
import { ACCOUNT, ITEM, placed } from './fixtures/drain-runner.ts';

const RUNNER = path.join(import.meta.dirname, 'fixtures', 'drain-runner.ts');

type Line = Record<string, unknown>;

function tmp(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carbon-${name}-`));
}

// Starts the runner and reads its JSON lines as they come.
function start(dir: string, mode: 'idle' | 'turn') {
  const child = spawn(process.execPath, [RUNNER, dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: Line[] = [];
  let stderr = '';
  let buffered = '';
  const waiters: { test: (line: Line) => boolean; resolve: (line: Line) => void }[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      // The runner writes one JSON object per line and nothing else.
      const line = JSON.parse(buffered.slice(0, at)) as Line;
      buffered = buffered.slice(at + 1);
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (!waiter.test(line)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, at: performance.now() }));
  });
  // Resolves with the first matching line, or with null if the process exits first.
  const waitFor = (test: (line: Line) => boolean, ms = 15000) => {
    const seen = lines.find(test);
    if (seen) return Promise.resolve(seen);
    return Promise.race([
      new Promise<Line>((resolve) => waiters.push({ test, resolve })),
      exited.then(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref())
    ]);
  };
  const ended = async (ms = 15000) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    const exit = await exited;
    clearTimeout(timer);
    return exit;
  };
  return { child, lines, waitFor, ended, stderr: () => stderr };
}

const fixtureLine = (name: string) => (line: Line) => line.fixture === name;
const eventLine = (name: string) => (line: Line) => line.event === name;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} during the sleep between passes ends the run at once, cleanly, with 0`, async () => {
    const dir = tmp('drain-idle');
    const runner = start(dir, 'idle');
    assert.ok(await runner.waitFor(fixtureLine('items')), `the first pass never ran: ${runner.stderr()}`);
    // The empty pass takes a few milliseconds; after this the loop is in its 60 s sleep.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sentAt = performance.now();
    runner.child.kill(signal);
    const exit = await runner.ended();

    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: EXIT.OK, signal: null }, runner.stderr());
    assert.ok(exit.at - sentAt < 5000, `the sleep was not woken: exit took ${Math.round(exit.at - sentAt)} ms`);
    // stop() ran: it stopped the harness session and gave the lock back.
    assert.ok(runner.lines.some(fixtureLine('session.stopped')), 'stop() never stopped the harness session');
    assert.equal(fs.existsSync(lockFile(path.join(dir, 'store'), `fixture:${ACCOUNT}`)), false, 'the lock outlived the run');
    const signalled = runner.lines.findIndex(eventLine('drain.signal'));
    assert.equal(runner.lines[signalled]?.signal, signal);
    assert.equal(typeof runner.lines.find(eventLine('drain.completed'))?.elapsed_ms, 'number');
    // No pass started after the signal.
    assert.equal(runner.lines.slice(signalled).filter(fixtureLine('items')).length, 0, 'a pass started after the signal');
  });
}

test('SIGTERM while a turn runs lets the turn and its delivery finish, starts no pass after, exits 0, and a restart owes nothing', async () => {
  const dir = tmp('drain-turn');
  const runner = start(dir, 'turn');
  const started = await runner.waitFor(fixtureLine('turn.started'));
  assert.ok(started, `the turn never started: ${runner.stderr()}`);
  const releaseId = started.release_id;

  runner.child.kill('SIGTERM');
  // The signal is on the record while the turn is still waiting to answer.
  const signalled = await runner.waitFor(eventLine('drain.signal'), 5000);
  if (!signalled) assert.fail(`the process did not drain on SIGTERM; it exited ${JSON.stringify(await runner.ended())}`);
  // A second signal forces nothing.
  runner.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(runner.child.exitCode, null, 'the process exited before the turn finished');
  fs.writeFileSync(path.join(dir, 'go'), '');
  const exit = await runner.ended();

  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: EXIT.OK, signal: null }, runner.stderr());
  const at = (test: (line: Line) => boolean) => runner.lines.findIndex(test);
  assert.ok(at(fixtureLine('turn.answered')) > at(eventLine('drain.signal')), 'the turn answered before the signal, so it proves nothing');
  const delivered = runner.lines.find(eventLine('deliver'));
  assert.deepEqual({ request_id: delivered?.request_id, status: delivered?.status }, { request_id: releaseId, status: 'sent' });
  assert.ok(at(eventLine('deliver')) < at(fixtureLine('session.stopped')), 'delivery did not finish before stop()');
  assert.equal(runner.lines.slice(at(eventLine('drain.signal'))).filter(fixtureLine('items')).length, 0, 'a pass started after the signal');
  assert.equal(runner.lines.filter(eventLine('drain.signal')).length, 1, 'the second signal was acted on');

  // The store says the release is closed and the reply is sent.
  const storeDir = path.join(dir, 'store');
  const records = Store.open(storeDir).rebuild();
  const inbound = records.filter((r) => r.direction === 'inbound');
  const outbound = records.filter((r) => r.direction === 'outbound');
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].release?.turn_id, releaseId);
  assert.ok(inbound[0].release?.completed_at, 'the release was left open');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].delivery?.status, 'sent');
  assert.equal(fs.existsSync(lockFile(storeDir, `fixture:${ACCOUNT}`)), false, 'the lock outlived the run');

  // The restart, in this process: the same store, the same item handed again,
  // and no turn is taken and nothing is recovered.
  const listeners = { SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') };
  const harness = fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] });
  const log: Line[] = [];
  const code = await run({
    ...placed(dir, 10),
    replyPort: 20000 + Math.floor(Math.random() * 20000),
    harness,
    items: () => [ITEM],
    passes: 1,
    log: (line) => log.push(line)
  });
  assert.equal(code, EXIT.OK);
  assert.equal(harness.session.turns.length, 0, 'the restart re-issued the drained turn');
  assert.equal(log.filter(eventLine('recover')).length, 0, `the restart recovered something: ${JSON.stringify(log.find(eventLine('recover')))}`);
  assert.equal(Store.open(storeDir).rebuild().filter((r) => r.direction === 'outbound').length, 1);
  assert.deepEqual({ SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') }, listeners,
    'run() left its signal handlers behind');
});
