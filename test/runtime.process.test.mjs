import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { run } from '../runtime/index.mjs';
import { EXIT } from '../runtime/faults.mjs';
import { takeLock, lockFile, commandLineOf } from '../runtime/lock.mjs';
import { latch, refuseIfLatched } from '../runtime/latch.mjs';
import { loadAdapter, registeredKinds } from '../runtime/registry.mjs';
import { environmentFor, commandFor, secretEnvName } from '../runtime/tool-servers.mjs';
import { serveReplyTool } from '../runtime/reply-tool.mjs';
import { Store } from '../stream/store.mjs';
import { fakeHarness } from './fake-harness.mjs';
import * as fixture from '../adapters/fixture/index.mjs';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carbon-${name}-`));
}

function declaration() {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    harness: { kind: 'codex-app-server', version: '0.153.4' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', api_key_ref: 'provider_api_key' },
    secrets: [{ name: 'provider_api_key', path: '/nowhere/key', purpose: 'the model provider key' }],
    tool_servers: [],
    channels: [{ kind: 'fixture', account: ACCOUNT, release: 'immediate', poll_interval_ms: 10 }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

function port() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function runOnce(options = {}) {
  const dir = options.dir ?? tmp('process');
  const declarationPath = path.join(dir, 'carbon.agent.json');
  const decl = options.declaration ?? declaration();
  fs.writeFileSync(declarationPath, JSON.stringify(decl, null, 2));
  const log = [];
  const code = await run({
    declaration: decl,
    declarationPath,
    storeDir: path.join(dir, 'store'),
    codexHome: path.join(dir, 'codex-home'),
    checkout: dir,
    harnessRoot: path.join(dir, 'harness'),
    binary: '/nowhere/codex',
    replyPort: port(),
    harness: options.harness ?? fakeHarness({ statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }] }),
    adapters: { fixture },
    items: () => options.items ?? [],
    passes: 1,
    log: (line) => log.push(line)
  });
  return { code, log, dir, storeDir: path.join(dir, 'store') };
}

test('a run takes one lock per adapter and gives it back', async () => {
  const { code, storeDir } = await runOnce();
  assert.equal(code, EXIT.OK);
  assert.equal(fs.existsSync(lockFile(storeDir, `fixture:${ACCOUNT}`)), false, 'the lock outlived the run');
});

test('a lock whose holder is gone is taken over, which is what a kill -9 leaves behind', async () => {
  const dir = tmp('lock');
  const storeDir = path.join(dir, 'store');
  Store.open(storeDir);
  const file = lockFile(storeDir, `fixture:${ACCOUNT}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A pid that is not running, with the command line the dead process had.
  fs.writeFileSync(file, JSON.stringify({
    channel: `fixture:${ACCOUNT}`, pid: 999999, command_line: 'node bin/carbon-runtime run', taken_at: '2026-09-10T00:00:00.000Z'
  }, null, 2));

  const { code, log } = await runOnce({ dir });
  assert.equal(code, EXIT.OK);
  const taken = log.find((l) => l.event === 'lock.taken_over');
  assert.ok(taken, 'the stale lock was obeyed rather than taken over');
  assert.equal(taken.previous.pid, 999999);
});

test('a lock a live process of the same command line holds is refused, and nothing starts', async () => {
  const dir = tmp('lock-held');
  const storeDir = path.join(dir, 'store');
  Store.open(storeDir);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    takeLock(storeDir, `fixture:${ACCOUNT}`, { pid: child.pid, commandLine: commandLineOf(child.pid) });
    await assert.rejects(() => runOnce({ dir }), (error) => {
      assert.equal(error.exitCode, EXIT.LOCK_HELD);
      assert.equal(error.faults[0].code, 'ADAPTER_LOCK_HELD');
      return true;
    });
  } finally {
    child.kill('SIGKILL');
  }
});

test('a latched store refuses to start, with the code the unit does not restart on', async () => {
  const dir = tmp('latched');
  const store = Store.open(path.join(dir, 'store'));
  latch(store, ACCOUNT, 'fixture', {
    code: 'CHANNEL_AUTH_REVOKED',
    subject: ACCOUNT,
    problem: 'the server reports this device as removed',
    fix: 'a person re-pairs the device'
  });
  assert.throws(() => refuseIfLatched(store), (error) => error.exitCode === EXIT.LATCHED);
  await assert.rejects(() => runOnce({ dir }), (error) => {
    assert.equal(error.exitCode, EXIT.LATCHED);
    assert.equal(error.faults[0].subject, `fixture:${ACCOUNT}`);
    return true;
  });
});

test('the latch file is where every adapter writes one, channels/<account>/<kind>.latch.json', () => {
  const dir = tmp('latch-path');
  const store = Store.open(dir);
  latch(store, ACCOUNT, 'whatsapp', { code: 'X', subject: ACCOUNT, problem: 'p', fix: 'f' });
  assert.ok(fs.existsSync(path.join(dir, 'channels', ACCOUNT, 'whatsapp.latch.json')));
});

test('the harness child exiting ends the process with its own code', async () => {
  const harness = fakeHarness({
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }],
    onTurn: (session) => {
      session.endChild({ code: 1, signal: null });
      const error = new Error('the app-server exited before the turn completed');
      error.fault = { code: 'HARNESS_CHILD_EXITED_MID_TURN', subject: 'thread-1:turn-1', problem: 'the app-server exited', fix: 'restart' };
      error.faults = [error.fault];
      throw error;
    }
  });
  const { code } = await runOnce({
    harness,
    items: [{ conversation: 'c1', id: '1', position: '0001', at: '2026-09-10T10:01:00.000Z', sender: 'contact-1', text: 'hello' }]
  });
  assert.equal(code, EXIT.HARNESS_EXITED);
});

test('a channel whose adapter this build does not carry is one named fault at start', async () => {
  const empty = tmp('registry');
  await assert.rejects(() => loadAdapter('email', { root: empty }), (error) => {
    assert.equal(error.faults[0].code, 'ADAPTER_MODULE_ABSENT');
    assert.equal(error.faults[0].subject, 'email');
    return true;
  });
  await assert.rejects(() => loadAdapter('sms'), (error) => {
    assert.equal(error.faults[0].code, 'CHANNEL_KIND_UNREGISTERED');
    return true;
  });
  assert.deepEqual(registeredKinds(), ['email', 'fixture', 'whatsapp']);
});

test('a tool server\'s environment is built from empty, and holds paths and never values', () => {
  const decl = declaration();
  decl.secrets.push({ name: 'client_api_credentials', path: '/srv/carbon/agent/secrets/client-api', purpose: 'the client API credential' });
  decl.runtime = { env: [{ name: 'CLIENT_TOOL_STATE_ROOT', value: '/srv/carbon/agent/work/tool-state' }] };
  const server = {
    name: 'client-api', transport: 'http',
    command: '/srv/carbon/agent/current/repo/tools/client-api/server.mjs',
    url: 'http://127.0.0.1:8731/mcp', cwd: '/srv/carbon/agent', read_only: false, required: true,
    secret_refs: ['client_api_credentials']
  };
  const env = environmentFor(decl, server);
  assert.deepEqual(env, {
    [secretEnvName('client_api_credentials')]: '/srv/carbon/agent/secrets/client-api',
    CLIENT_TOOL_STATE_ROOT: '/srv/carbon/agent/work/tool-state'
  });

  const asTools = commandFor(decl, server, { declarationPath: '/srv/carbon/agent/current/carbon.agent.json', toolsUser: 'carbon-tools' });
  assert.equal(asTools.command, 'sudo');
  assert.deepEqual(asTools.args.slice(0, 4), ['-u', 'carbon-tools', 'env', '-i']);
  assert.ok(asTools.args.includes('--port'));
  assert.equal(asTools.args[asTools.args.indexOf('--port') + 1], '8731');

  const local = commandFor(decl, server, { declarationPath: '/x/carbon.agent.json', toolsUser: null });
  assert.equal(local.command, process.execPath);
  assert.equal(local.args[0], server.command);
});

test('the reply tool answers over loopback and writes a pending record', async () => {
  const dir = tmp('reply-http');
  const store = Store.open(dir);
  store.capture({
    schema: 'carbon.message.v1', agent: AGENT, source: 'email', account: ACCOUNT,
    conversation_id: `${ACCOUNT}:c1`, conversation_kind: 'direct', message_id: `${ACCOUNT}:c1:1`,
    platform_message_id: '1', revision: 0, direction: 'inbound', role: 'contact', sender_id: 'contact-1',
    received_at: '2026-09-10T10:01:00.000Z', body: 'hello', attachments: [], historical: false, disposition: 'captured'
  });
  const served = await serveReplyTool({ store, agent: AGENT, port: port() });
  try {
    const call = async (body) => {
      const response = await fetch(served.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      return response.json();
    };
    const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(listed.result.tools.map((t) => t.name), ['reply']);
    assert.deepEqual(Object.keys(listed.result.tools[0].inputSchema.properties).sort(),
      ['conversation_id', 'request_id', 'text']);

    const called = await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'reply', arguments: { conversation_id: `${ACCOUNT}:c1`, request_id: 'r-1', text: 'the answer' } }
    });
    assert.equal(called.result.isError, false);
    assert.equal(called.result.structuredContent.status, 'written');
    const outbound = store.rebuild().find((r) => r.direction === 'outbound');
    assert.equal(outbound.delivery.status, 'pending');
    assert.equal(outbound.body, 'the answer');
  } finally {
    await served.close();
  }
});
