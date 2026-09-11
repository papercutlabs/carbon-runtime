import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { PROVIDER_AUTH, providerKey, run, placesUnder, placeGuidance, GUIDANCE_NAMES } from '../runtime/index.mjs';
import { EXIT } from '../runtime/faults.mjs';
import { takeLock, lockFile, commandLineOf } from '../runtime/lock.mjs';
import { latch, refuseIfLatched } from '../runtime/latch.mjs';
import { loadAdapter, registeredKinds } from '../runtime/registry.mjs';
import {
  environmentFor, commandFor, secretEnvName, serversToStart, serversToAwait,
  awaitToolServers, toolsUserServer, serverNameFromInstance
} from '../runtime/tool-servers.mjs';
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
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
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
  // The work directory is the thread's own and the runtime links the checkout's
  // guidance into it, so it has to exist before a run the way install makes it.
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  const log = [];
  const code = await run({
    declaration: decl,
    declarationPath,
    storeDir: path.join(dir, 'store'),
    codexHome: path.join(dir, 'codex-home'),
    checkout: path.join(dir, 'repo'),
    work: path.join(dir, 'work'),
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
  assert.deepEqual(registeredKinds(), ['email', 'fixture', 'telegram', 'whatsapp']);
});

test('a tool server\'s environment is built from empty, and holds paths and never values', () => {
  const decl = declaration();
  decl.secrets.push({ name: 'client_api_credentials', path: '/srv/carbon/agent/secrets/client-api', purpose: 'the client API credential' });
  decl.runtime = { env: [{ name: 'CLIENT_TOOL_STATE_ROOT', value: '/srv/carbon/agent/work/tool-state' }] };
  const server = {
    name: 'client-api', transport: 'http', runs_as: 'tools',
    command: '/srv/carbon/agent/current/repo/tools/client-api/server.mjs',
    url: 'http://127.0.0.1:8731/mcp', cwd: '/srv/carbon/agent/current/repo/tools/client-api',
    read_only: false, required: true,
    secret_refs: ['client_api_credentials']
  };
  const env = environmentFor(decl, server);
  assert.deepEqual(env, {
    [secretEnvName('client_api_credentials')]: '/srv/carbon/agent/secrets/client-api',
    CLIENT_TOOL_STATE_ROOT: '/srv/carbon/agent/work/tool-state'
  });

  // The account is the unit's, not an argument here: there is no sudo on this
  // path any more, because a tools-user server is never a child of this process.
  const line = commandFor(decl, server, { declarationPath: '/srv/carbon/agent/current/carbon.agent.json' });
  assert.equal(line.command, process.execPath);
  assert.equal(line.args[0], server.command);
  assert.ok(line.args.includes('--port'));
  assert.equal(line.args[line.args.indexOf('--port') + 1], '8731');
  assert.equal(line.args[line.args.indexOf('--host') + 1], '127.0.0.1');
});

test('the runtime starts the agent-user servers and waits for the tools-user ones', async () => {
  const decl = declaration();
  decl.secrets.push({ name: 'client_api_credentials', path: '/srv/carbon/agent/secrets/client-api', purpose: 'x' });
  decl.tool_servers = [
    {
      name: 'client-api', transport: 'http', runs_as: 'tools',
      command: '/srv/carbon/agent/current/repo/tools/client-api/server.mjs',
      url: 'http://127.0.0.1:8731/mcp', cwd: '/srv/carbon/agent/current/repo/tools/client-api',
      read_only: false, required: true, secret_refs: ['client_api_credentials']
    },
    {
      name: 'client-read', transport: 'http', runs_as: 'agent',
      command: '/srv/carbon/agent/current/repo/tools/client-read/server.mjs',
      url: 'http://127.0.0.1:8732/mcp', cwd: '/srv/carbon/agent/current/repo/tools/client-read',
      read_only: true, required: false, secret_refs: []
    },
    {
      name: 'client-stdio', transport: 'stdio', runs_as: 'agent',
      command: '/srv/carbon/agent/current/repo/tools/client-stdio/server.mjs',
      cwd: '/srv/carbon/agent/current/repo', read_only: true, required: false, secret_refs: []
    }
  ];
  // The server with a unit of its own is never started here, and it is the only
  // one waited for. Getting this backwards is the whole failure: a credential
  // held by a child of this process is a credential the model's shell can reach.
  assert.deepEqual(serversToStart(decl).map((s) => s.name), ['client-read']);
  assert.deepEqual(serversToAwait(decl).map((s) => s.name), ['client-api']);

  // A required server that never answers is reported and does not stop the
  // process: the agent still has to read its mailbox, and release is held by
  // name while it is down.
  const lines = [];
  const silent = await awaitToolServers(decl, {
    timeoutMs: 10, intervalMs: 1, now: (() => { let t = 0; return () => (t += 6); })(),
    sleep: async () => {}, probe: async () => false, log: (line) => lines.push(line)
  });
  assert.deepEqual(silent, [{ name: 'client-api', url: 'http://127.0.0.1:8731/mcp', answered: false, required: true }]);
  assert.equal(lines[0].event, 'tool_server.silent');
  assert.equal(lines[0].fault.code, 'TOOL_SERVER_UNIT_SILENT');

  const up = await awaitToolServers(decl, { probe: async () => true, log: (line) => lines.push(line) });
  assert.deepEqual(up.map((s) => s.answered), [true]);
  assert.equal(lines[1].event, 'tool_server.answered');
});

test('the tool unit launcher takes only a tools-user http server, and reads its name off the instance', () => {
  const decl = declaration();
  decl.agent = { id: 'example-agent', client: 'Example' };
  decl.secrets.push({ name: 'client_api_credentials', path: '/srv/carbon/agent/secrets/client-api', purpose: 'x' });
  decl.tool_servers = [
    {
      name: 'client-api', transport: 'http', runs_as: 'tools',
      command: '/x/server.mjs', url: 'http://127.0.0.1:8731/mcp', cwd: '/x',
      read_only: false, required: true, secret_refs: ['client_api_credentials']
    },
    {
      name: 'client-read', transport: 'http', runs_as: 'agent',
      command: '/y/server.mjs', url: 'http://127.0.0.1:8732/mcp', cwd: '/y',
      read_only: true, required: false, secret_refs: []
    }
  ];
  // Both halves of an instance name may hold a hyphen, so the split is against
  // the agent id and never against the first hyphen.
  assert.equal(serverNameFromInstance('example-agent-client-api', 'example-agent'), 'client-api');
  assert.throws(() => serverNameFromInstance('other-agent-client-api', 'example-agent'),
    (error) => error.faults[0].code === 'TOOL_UNIT_INSTANCE_UNREADABLE');

  assert.equal(toolsUserServer(decl, 'client-api').name, 'client-api');
  assert.throws(() => toolsUserServer(decl, 'client-read'),
    (error) => error.faults[0].code === 'TOOL_SERVER_NOT_A_TOOLS_SERVER');
  assert.throws(() => toolsUserServer(decl, 'nobody'),
    (error) => error.faults[0].code === 'TOOL_SERVER_UNDECLARED');
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

// How a client agent authenticates, as the declaration says rather than as a flag.
// Ruled 10 September: a client agent runs on a ChatGPT login and never on an API
// key, and that login is the harness's own auth file under CODEX_HOME. So the
// runtime passes nothing on that path, reads no file, and puts no credential in
// this process's environment.
test('a chatgpt login is the harness\'s own business, and the runtime passes nothing', () => {
  assert.equal(providerKey({ provider: { name: 'openai', auth: 'chatgpt' } }), null);
});

test('an api key is read from the file the declaration names, and passed under the provider\'s own name', () => {
  const key = providerKey({
    provider: { name: 'openai', auth: 'api_key', api_key_ref: 'provider_api_key' },
    secrets: [{ name: 'provider_api_key', path: '/srv/carbon/example/secrets/key', purpose: 'the key' }]
  });
  assert.deepEqual(key, { path: '/srv/carbon/example/secrets/key', env: 'OPENAI_API_KEY' });
});

test('a declaration that names neither way of authenticating is refused by name', () => {
  assert.throws(() => providerKey({ provider: { name: 'openai' } }),
    (error) => error.faults.some((f) => f.code === 'PROVIDER_AUTH_UNKNOWN'));
  assert.deepEqual(PROVIDER_AUTH, ['chatgpt', 'api_key']);
});

// ---- the directory a thread opens on (PA-181) --------------------------------

test('the work directory is one of the places under an agent directory', () => {
  const under = placesUnder('/srv/carbon/examplecorp-agent');
  assert.equal(under.work, '/srv/carbon/examplecorp-agent/work');
  assert.equal(under.checkout, '/srv/carbon/examplecorp-agent/current/repo');
});

// The harness reads AGENTS.md and .agents out of the thread's working directory
// and out of nowhere else (verified against the pinned binary, 11 September), so
// moving the thread off the checkout would lose the agent's guidance and its
// skills. They are copied and not linked: the sandbox binds them read-only inside
// the turn, and bubblewrap cannot bind through a symlink into a read-only tree.
test('the checkout\'s guidance is placed in the work directory, as real files', () => {
  const dir = tmp('guidance');
  const checkout = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(checkout, '.agents', 'skills', 'one'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.agents', 'skills', 'one', 'SKILL.md'), 'the skill\n');
  fs.writeFileSync(path.join(checkout, 'AGENTS.md'), 'the guidance\n');
  fs.mkdirSync(work, { recursive: true });

  assert.deepEqual(placeGuidance({ work, checkout }), GUIDANCE_NAMES);
  for (const name of GUIDANCE_NAMES) {
    assert.equal(fs.lstatSync(path.join(work, name)).isSymbolicLink(), false, `${name} is a symlink`);
  }
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), 'the guidance\n');
  assert.equal(fs.readFileSync(path.join(work, '.agents', 'skills', 'one', 'SKILL.md'), 'utf8'), 'the skill\n');
});

// Including a symlink the client repository carries itself: the wall is the
// sandbox's, not ours, and it does not care who made the link.
test('nothing placed in the work directory is a symlink, wherever the checkout keeps one', () => {
  const dir = tmp('guidance');
  const checkout = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(checkout, '.agents', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'elsewhere', 'one'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'elsewhere', 'one', 'SKILL.md'), 'the skill\n');
  fs.symlinkSync(path.join(checkout, 'elsewhere', 'one'), path.join(checkout, '.agents', 'skills', 'one'));
  fs.mkdirSync(work, { recursive: true });

  placeGuidance({ work, checkout });
  assert.equal(fs.lstatSync(path.join(work, '.agents', 'skills', 'one')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(work, '.agents', 'skills', 'one', 'SKILL.md'), 'utf8'), 'the skill\n');
});

// The two names belong to the runtime. What the checkout stopped carrying goes,
// and what a turn wrote over them does not outlive the restart, so the installed
// checkout is the only thing that decides what the agent is carrying.
test('what stands at those two names is written again from the checkout at every start', () => {
  const dir = tmp('guidance');
  const checkout = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(path.join(work, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'AGENTS.md'), 'the guidance\n');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'something a turn wrote\n');

  assert.deepEqual(placeGuidance({ work, checkout }), ['AGENTS.md']);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), 'the guidance\n');
  assert.equal(fs.existsSync(path.join(work, '.agents')), false);
});

test('a run with no work directory on the box is refused rather than opened somewhere else', () => {
  const dir = tmp('guidance');
  assert.throws(() => placeGuidance({ work: path.join(dir, 'work'), checkout: dir }),
    (error) => error.faults.some((f) => f.code === 'WORK_DIR_ABSENT'));
});
