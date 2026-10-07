import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { serveActionHttp } from '../runtime/records-action-http.ts';
import { ToolFault, fault } from '../tools/lib/fault.ts';

type Call = { name: string; receiverIsActions: boolean; args: unknown[] };
type Actions = Parameters<typeof serveActionHttp>[0];

const JSON_HEADERS = { 'content-type': 'application/json', connection: 'close' };
const ROUTE_FIX = 'use an action route from a mapped tool';
const BODY_LARGE = {
  code: 'RECORDS_ACTION_BODY_LARGE', subject: 'request',
  problem: 'action request is over 16 KiB',
  fix: 'send only the job, step, operation and source ids'
};

const ownedServers = new Set<http.Server>();
const ownedRequests = new Set<http.ClientRequest>();
const createServer = http.createServer;
http.createServer = ((...args: Parameters<typeof http.createServer>) => {
  const server = createServer(...args);
  ownedServers.add(server);
  server.on('close', () => { ownedServers.delete(server); });
  return server;
}) as typeof http.createServer;

function trackRequest(req: http.ClientRequest) {
  ownedRequests.add(req);
  const done = () => { ownedRequests.delete(req); };
  req.on('close', done);
  req.on('error', done);
  return req;
}

function destroyOwnedRequests() {
  for (const req of [...ownedRequests]) req.destroy();
  ownedRequests.clear();
}

function forceCloseOwnedServers() {
  for (const server of [...ownedServers]) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }
}

function deadline(ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, clear() { if (timer) clearTimeout(timer); } };
}

function describeArg(arg: unknown) {
  if (arg instanceof AbortSignal) return { type: 'AbortSignal', aborted: arg.aborted };
  return arg;
}

function recordingActions(overrides: Partial<Actions> = {}) {
  const calls: Call[] = [];
  const actions = {
    action_turn_start(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'turn-start', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'turn-start' };
    },
    action_turn_end(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'turn-end', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'turn-end' };
    },
    action_collect(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'collect', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'collect' };
    },
    action_classify(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'classify', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'classify' };
    },
    action_begin(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'begin', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'begin' };
    },
    action_bound(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'bound', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'bound' };
    },
    action_finish(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'finish', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'finish' };
    },
    action_reconcile_ready(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'reconcile-ready', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'reconcile-ready' };
    },
    action_reconcile_absent(this: Actions, ...args: unknown[]) {
      calls.push({ name: 'reconcile-absent', receiverIsActions: this === actions, args: args.map(describeArg) });
      return { ok: 'reconcile-absent' };
    },
    ...overrides
  } as Actions;
  return { actions, calls };
}

async function withServer(actions: Actions, fn: (port: number) => Promise<void>) {
  const started = await serveActionHttp(actions, 0);
  try {
    await fn(started.port);
  } finally {
    destroyOwnedRequests();
    forceCloseOwnedServers();
    const closeWait = deadline(4000, 'server close timed out');
    try {
      await Promise.race([started.close(), closeWait.promise]);
    } finally {
      closeWait.clear();
      destroyOwnedRequests();
      forceCloseOwnedServers();
      for (const server of [...ownedServers]) server.unref();
    }
  }
  const pingWait = deadline(4000, 'closed-port health check timed out');
  try {
    await assert.rejects(() => Promise.race([
      new Promise((resolve, reject) => {
        const req = trackRequest(http.get({ host: '127.0.0.1', port: started.port, path: '/health' }, resolve));
        req.on('error', reject);
      }),
      pingWait.promise
    ]), (err: NodeJS.ErrnoException) => err.code === 'ECONNREFUSED');
  } finally {
    pingWait.clear();
    destroyOwnedRequests();
  }
}

function exchange(port: number, opts: {
  method?: string; path: string; body?: string | Buffer; headers?: http.OutgoingHttpHeaders;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timed = deadline(4000, `request timed out ${opts.method ?? 'POST'} ${opts.path}`);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timed.clear();
      fn();
    };
    timed.promise.catch((err) => {
      req.destroy();
      finish(() => reject(err));
    });
    const req = trackRequest(http.request({
      host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path,
      headers: { ...JSON_HEADERS, ...opts.headers }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (raw.length) {
          try { json = JSON.parse(raw); }
          catch { json = { unparsed: raw }; }
        }
        finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json }));
      });
    }));
    req.on('error', (err) => finish(() => reject(err)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function streamExchange(port: number, opts: {
  path: string; headers: http.OutgoingHttpHeaders; timeoutMessage: string;
  write: (req: http.ClientRequest) => void; end: boolean;
}): Promise<{ status: number; json: unknown; requestEnded: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timed = deadline(4000, opts.timeoutMessage);
    const req = trackRequest(http.request({
      host: '127.0.0.1', port, method: 'POST', path: opts.path,
      headers: { 'content-type': 'application/json', connection: 'close', ...opts.headers }
    }));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timed.clear();
      fn();
    };
    timed.promise.catch((err) => {
      req.destroy();
      finish(() => reject(err));
    });
    req.on('error', (err) => finish(() => reject(err)));
    req.on('response', (incoming) => {
      const requestEnded = req.writableEnded;
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        finish(() => resolve({
          status: incoming.statusCode ?? 0,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          requestEnded
        }));
      });
    });
    opts.write(req);
    if (opts.end) req.end();
  });
}

async function reapChild(child: ChildProcess, timeoutMs: number, hungMessage: string) {
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => { out += chunk; });
  child.stderr?.on('data', (chunk) => { err += chunk; });
  const timed = deadline(timeoutMs, hungMessage);
  try {
    const code = await Promise.race([
      new Promise<number>((resolve) => child.once('close', (status) => resolve(status ?? 1))),
      timed.promise
    ]);
    return { code, out, err };
  } catch (error) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    } else {
      child.kill('SIGKILL');
    }
    throw error;
  } finally {
    timed.clear();
  }
}

function routeFault(subject: string) {
  return { faults: [{ code: 'RECORDS_ACTION_ROUTE', subject, problem: 'this route does not exist', fix: ROUTE_FIX }] };
}

function assertJsonHeaders(headers: http.IncomingHttpHeaders) {
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(headers['cache-control'], 'no-store');
}

function jsonOfSize(n: number) {
  const prefix = '{"pad":"';
  const suffix = '"}';
  return prefix + 'x'.repeat(n - prefix.length - suffix.length) + suffix;
}

const NINE_ROUTES: { path: string; body: unknown; name: string; args: unknown[] }[] = [
  {
    path: '/turn-start', name: 'turn-start',
    body: { releaseId: 'r', unit: 'u', sourceIds: ['a'], extra: true },
    args: [{ releaseId: 'r', unit: 'u', sourceIds: ['a'], extra: true }, { type: 'AbortSignal', aborted: false }]
  },
  { path: '/turn-end', name: 'turn-end', body: { releaseId: 'rel', extra: 1 }, args: ['rel'] },
  {
    path: '/collect', name: 'collect',
    body: { source_id: 's', channel: 'c', unit: 'u', extra: 1 },
    args: ['s', 'c', 'u']
  },
  { path: '/classify', name: 'classify', body: { job: null, operation: 'op', extra: 1 }, args: [null, 'op'] },
  {
    path: '/begin', name: 'begin',
    body: { job: 'j', step: 'st', source_id: 's', operation: 'op', owner: { pid: 1, generation: 'g' }, extra: 1 },
    args: ['j', 'st', 's', 'op', { pid: 1, generation: 'g' }]
  },
  {
    path: '/bound', name: 'bound',
    body: {
      unit: 'u', operation: 'op', about_job: 'aj', about_move: 'am', source_id: 's',
      owner: { pid: 2, generation: 'g2' }, extra: 1
    },
    args: ['u', 'op', 'aj', 'am', 's', { pid: 2, generation: 'g2' }]
  },
  {
    path: '/finish', name: 'finish',
    body: { job: 'j', step: 'st', source_id: 's', action_id: 'a', extra: 1 },
    args: ['j', 'st', 's', 'a']
  },
  {
    path: '/reconcile-ready', name: 'reconcile-ready',
    body: { job: 'j', step: 'st', action_id: 'a', extra: 1 },
    args: ['j', 'st', 'a']
  },
  {
    path: '/reconcile-absent', name: 'reconcile-absent',
    body: {
      job: 'j', step: 'st', source_id: 's', action_id: 'a',
      read_receipt: { effect: 'e', evidence_id: 'ev' }, extra: 1
    },
    args: ['j', 'st', 's', 'a', { effect: 'e', evidence_id: 'ev' }]
  }
];

test('GET /health is ready and does not call actions', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const res = await exchange(port, { method: 'GET', path: '/health' });
    assert.equal(res.status, 200);
    assertJsonHeaders(res.headers);
    assert.deepEqual(res.json, { schema: 'carbon.records-action-health.v1', status: 'ready' });
    assert.deepEqual(calls, []);
  });
});

test('method, exact-query and prototype-name paths refuse before calling actions', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const cases: { method?: string; path: string; subject: string }[] = [
      { method: 'GET', path: '/health?x=1', subject: '/health?x=1' },
      { method: 'POST', path: '/health', subject: '/health' },
      { method: 'HEAD', path: '/health', subject: '/health' },
      { method: 'PUT', path: '/collect', subject: '/collect' },
      { method: 'GET', path: '/collect', subject: '/collect' },
      { path: '/collect?x=1', subject: '/collect?x=1' },
      { path: '/collect/', subject: '/collect/' },
      { path: '/nope', subject: '/nope' },
      { path: '/constructor', subject: '/constructor' },
      { path: '/toString', subject: '/toString' },
      { path: '/__proto__', subject: '/__proto__' },
      { path: '/hasOwnProperty', subject: '/hasOwnProperty' },
      { path: '/valueOf', subject: '/valueOf' }
    ];
    for (const spec of cases) {
      calls.length = 0;
      const res = await exchange(port, { method: spec.method, path: spec.path, body: '{}' });
      assert.equal(res.status, 404, spec.path);
      if (spec.method !== 'HEAD') {
        assertJsonHeaders(res.headers);
        assert.deepEqual(res.json, routeFault(spec.subject));
      }
      assert.deepEqual(calls, []);
    }
  });
});

test('all nine POST routes extract the original argument maps on the actions receiver', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    for (const spec of NINE_ROUTES) {
      calls.length = 0;
      const res = await exchange(port, { path: spec.path, body: JSON.stringify(spec.body) });
      assert.equal(res.status, 200, spec.path);
      assertJsonHeaders(res.headers);
      assert.deepEqual(res.json, { ok: spec.name });
      assert.equal(calls.length, 1, spec.path);
      assert.equal(calls[0].name, spec.name);
      assert.equal(calls[0].receiverIsActions, true, spec.path);
      assert.deepEqual(calls[0].args, spec.args);
    }
  });
});

test('empty, malformed and null bodies become 409 asFaults without calling actions', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const empty = await exchange(port, { path: '/collect', body: '' });
    assert.equal(empty.status, 409);
    assertJsonHeaders(empty.headers);
    assert.deepEqual(empty.json, {
      faults: [fault('TOOL_FAILED', 'the tool', 'Unexpected end of JSON input',
        'read the message; if it names nothing you can act on, the tool owes you a fault with a fix')]
    });
    const malformed = await exchange(port, { path: '/collect', body: '{bad' });
    assert.equal(malformed.status, 409);
    const malformedProblem = (malformed.json as { faults: { problem: string }[] }).faults[0].problem;
    assert.match(malformedProblem, /JSON/);
    const nullBody = await exchange(port, { path: '/collect', body: 'null' });
    assert.equal(nullBody.status, 409);
    assert.deepEqual(nullBody.json, {
      faults: [fault('TOOL_FAILED', 'the tool', "Cannot read properties of null (reading 'source_id')",
        'read the message; if it names nothing you can act on, the tool owes you a fault with a fix')]
    });
    assert.deepEqual(calls, []);
  });
});

test('16 KiB body is accepted and one extra byte is 413', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const allowed = jsonOfSize(16384);
    assert.equal(allowed.length, 16384);
    const ok = await exchange(port, { path: '/turn-end', body: allowed });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: 'turn-end' });
    calls.length = 0;
    const denied = jsonOfSize(16385);
    const res = await exchange(port, { path: '/turn-end', body: denied });
    assert.equal(res.status, 413);
    assertJsonHeaders(res.headers);
    assert.deepEqual(res.json, { faults: [BODY_LARGE] });
    assert.deepEqual(calls, []);
  });
});

test('streamed body over 16 KiB is 413 before the request ends', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const res = await streamExchange(port, {
      path: '/collect',
      headers: { 'transfer-encoding': 'chunked' },
      timeoutMessage: 'streamed 413 timed out',
      end: false,
      write(req) {
        req.write('{"pad":"');
        req.write('x'.repeat(20000));
      }
    });
    assert.equal(res.status, 413);
    assert.equal(res.requestEnded, false);
    assert.deepEqual(res.json, { faults: [BODY_LARGE] });
    assert.deepEqual(calls, []);
  });
});

test('unknown route fails before body consumption so an oversized body is still 404', { timeout: 8000 }, async () => {
  const { actions, calls } = recordingActions();
  await withServer(actions, async (port) => {
    const res = await streamExchange(port, {
      path: '/nope',
      headers: { 'content-length': '20000' },
      timeoutMessage: 'unknown oversized timed out',
      end: true,
      write(req) { req.write('x'.repeat(20000)); }
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, routeFault('/nope'));
    assert.deepEqual(calls, []);
  });
});

test('ToolFault and ordinary thrown actions, sync and async, use asFaults', { timeout: 8000 }, async () => {
  const actions = recordingActions({
    action_collect() { throw new ToolFault([fault('X', 'subj', 'prob', 'fix')]); },
    action_classify() { throw new Error('sync-err'); },
    action_begin() { return Promise.reject(new Error('async-err')); },
    action_bound() { return Promise.reject(new ToolFault([fault('Y', 's', 'p', 'f')])); }
  }).actions;
  await withServer(actions, async (port) => {
    const toolSync = await exchange(port, { path: '/collect', body: '{}' });
    assert.equal(toolSync.status, 409);
    assert.deepEqual(toolSync.json, { faults: [fault('X', 'subj', 'prob', 'fix')] });
    const ordinarySync = await exchange(port, { path: '/classify', body: '{}' });
    assert.equal(ordinarySync.status, 409);
    assert.deepEqual(ordinarySync.json, {
      faults: [fault('TOOL_FAILED', 'the tool', 'sync-err',
        'read the message; if it names nothing you can act on, the tool owes you a fault with a fix')]
    });
    const ordinaryAsync = await exchange(port, { path: '/begin', body: '{}' });
    assert.equal(ordinaryAsync.status, 409);
    assert.deepEqual(ordinaryAsync.json, {
      faults: [fault('TOOL_FAILED', 'the tool', 'async-err',
        'read the message; if it names nothing you can act on, the tool owes you a fault with a fix')]
    });
    const toolAsync = await exchange(port, { path: '/bound', body: '{}' });
    assert.equal(toolAsync.status, 409);
    assert.deepEqual(toolAsync.json, { faults: [fault('Y', 's', 'p', 'f')] });
  });
});

test('action methods are looked up at call time on the same receiver', { timeout: 8000 }, async () => {
  const { actions } = recordingActions();
  await withServer(actions, async (port) => {
    const first = await exchange(port, {
      path: '/collect', body: JSON.stringify({ source_id: 's', channel: 'c', unit: 'u' })
    });
    assert.deepEqual(first.json, { ok: 'collect' });
    (actions as { action_collect: (...args: unknown[]) => unknown }).action_collect = function (this: unknown) {
      return { replaced: true, receiverIsActions: this === actions };
    };
    const second = await exchange(port, {
      path: '/collect', body: JSON.stringify({ source_id: 's', channel: 'c', unit: 'u' })
    });
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { replaced: true, receiverIsActions: true });
  });
});

test('turn-start abort signal fires on early disconnect; other routes do not receive it', { timeout: 8000 }, async () => {
  let turnSignal: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  const { actions, calls } = recordingActions({
    action_turn_start(_context, signal) {
      turnSignal = signal;
      started.resolve();
      return new Promise((resolve) => {
        const done = () => resolve({ aborted: true });
        if (signal?.aborted) done();
        else signal?.addEventListener('abort', done, { once: true });
      });
    }
  });
  await withServer(actions, async (port) => {
    const collect = await exchange(port, {
      path: '/collect', body: JSON.stringify({ source_id: 's', channel: 'c', unit: 'u' })
    });
    assert.equal(collect.status, 200);
    assert.equal(calls[0].args.length, 3);
    assert.equal(calls[0].args.some((arg) => arg && typeof arg === 'object' && (arg as { type?: string }).type === 'AbortSignal'), false);

    const req = trackRequest(http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/turn-start',
      headers: { ...JSON_HEADERS, 'content-length': '2' }
    }));
    req.on('error', () => {});
    req.write('{}');
    req.end();
    const enteredWait = deadline(4000, 'turn-start was not entered');
    try {
      await Promise.race([started.promise, enteredWait.promise]);
    } finally {
      enteredWait.clear();
    }
    assert.equal(turnSignal?.aborted, false);
    req.destroy();
    const abortWait = deadline(4000, 'signal did not abort');
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const done = () => resolve();
          if (turnSignal?.aborted) done();
          else turnSignal?.addEventListener('abort', done, { once: true });
        }),
        abortWait.promise
      ]);
    } finally {
      abortWait.clear();
    }
    assert.equal(turnSignal?.aborted, true);
  });
  let completedSignal: AbortSignal | undefined;
  await withServer(recordingActions({
    action_turn_start(_context, signal) {
      completedSignal = signal;
      return { ok: true };
    }
  }).actions, async (port) => {
    const res = await exchange(port, { path: '/turn-start', body: '{}' });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(completedSignal?.aborted, false);
  });
});

test('premature upload abort stays outside the 409 catch and does not hang the server', { timeout: 8000 }, async () => {
  const handlerPath = new URL('../runtime/records-action-http.ts', import.meta.url).pathname;
  const script = `
    import http from 'node:http';
    const received = Promise.withResolvers();
    let serverReceivedBytes = 0;
    let requests = 0;
    const create = http.createServer;
    http.createServer = function (listener) {
      return create.call(http, (req, res) => {
        requests += 1;
        req.on('data', (chunk) => {
          serverReceivedBytes += chunk.length;
          received.resolve();
        });
        return listener(req, res);
      });
    };
    const { serveActionHttp } = await import(${JSON.stringify(handlerPath)});
    const unhandled = [];
    process.on('unhandledRejection', (error) => {
      unhandled.push({
        message: String(error),
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
      });
    });
    let actions = 0;
    const record = () => { actions += 1; return 1; };
    const actionTable = {
      action_turn_start: record, action_turn_end: record,
      action_collect: record, action_classify: record,
      action_begin: record, action_bound: record,
      action_finish: record, action_reconcile_ready: record,
      action_reconcile_absent: record
    };
    const started = await serveActionHttp(actionTable, 0);
    const req = http.request({
      host: '127.0.0.1', port: started.port, method: 'POST', path: '/collect',
      headers: { 'content-type': 'application/json', 'content-length': '20', connection: 'close' }
    });
    req.on('error', () => {});
    req.write('{');
    const receiptWait = setTimeout(() => {
      req.destroy();
      throw new Error('server did not receive a body byte');
    }, 4000);
    await received.promise;
    clearTimeout(receiptWait);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await new Promise((resolve, reject) => {
      const ping = http.get({ host: '127.0.0.1', port: started.port, path: '/health' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      ping.on('error', reject);
    });
    await started.close();
    process.stdout.write(JSON.stringify({ unhandled, health, actions, serverReceivedBytes, requests }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  const { code, out, err } = await reapChild(child, 6000, 'iterator child hung');
  assert.equal(code, 0, err);
  const report = JSON.parse(out);
  assert.equal(report.health, 200);
  assert.equal(report.actions, 0);
  assert.ok(report.serverReceivedBytes >= 1, 'server must receive a body byte before abort');
  assert.equal(report.unhandled.length, 1);
  assert.equal(report.unhandled[0].code, 'ECONNRESET');
  assert.match(String(report.unhandled[0].message), /aborted|ECONNRESET/);
});
