// The provider proxy (PA-259), started the way the tool unit starts it: the real
// bin/carbon-tool-server against an agent directory, with a stand-in for the
// pinned harness release's codex-responses-api-proxy. What is real here is the
// launcher, the argument vector, the working directory, the environment built
// from empty, and the key reaching the child as its standard input. What is not
// here is the proxy itself, whose own behaviour was qualified separately, offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandFor, toolsUserServer, startToolServers, stdinSecretFor, PROVIDER_PROXY_BINARY, PROVIDER_PROXY_DIR } from '../runtime/tool-servers.ts';
import { RuntimeFault } from '../runtime/faults.ts';
import type { Declaration, Server } from '../runtime/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCHER = path.join(ROOT, 'bin', 'carbon-tool-server.ts');
const AGENT = 'test-agent';
const VERSION = '0.156.1';
const UPSTREAM = 'https://api.openai.com/v1/responses';

function proxyServer(overrides: Partial<Server> = {}): Server {
  return {
    name: 'provider-proxy', kind: 'provider_proxy', transport: 'http', runs_as: 'tools',
    url: 'http://127.0.0.1:8765', cwd: '/srv/carbon/test-agent', read_only: true, required: true,
    secret_refs: [], stdin_secret: 'openai_key', upstream_url: UPSTREAM, ...overrides
  };
}

function declarationWith(server: Server, keyPath = '/srv/carbon/test-agent/secrets/openai-key'): Declaration {
  return {
    agent: { id: AGENT, client: 'ExampleCorp' },
    harness: { kind: 'codex-app-server', version: VERSION },
    provider: { name: 'openai', auth: 'api_key', api_key_ref: 'openai_key', api_key_via: server.name },
    secrets: [{ name: 'openai_key', path: keyPath }],
    tool_servers: [server]
  };
}

function faultCodes(fn: () => unknown) {
  try { fn(); } catch (error) { return (error as RuntimeFault).faults.map((f) => f.code); }
  return [];
}

test('the proxy is started from the installed version, never from the agent user\'s harness directory, with exactly two flags', () => {
  const server = proxyServer();
  const { command, args } = commandFor(declarationWith(server), server, { declarationPath: '/x', currentDir: '/srv/carbon/test-agent/current' });
  assert.equal(command, `/srv/carbon/test-agent/current/${PROVIDER_PROXY_DIR}/${PROVIDER_PROXY_BINARY}`);
  assert.deepEqual(args, ['--port', '8765', '--upstream-url', UPSTREAM],
    'never --http-shutdown, --server-info or --dump-dir, and never the declaration or the node binary');
});

test('without an installed version the proxy is refused by name rather than guessed at', () => {
  const server = proxyServer();
  assert.deepEqual(faultCodes(() => commandFor(declarationWith(server), server, { declarationPath: '/x' })),
    ['PROVIDER_PROXY_NO_INSTALL']);
});

test('the tool unit refuses a proxy that is not on 127.0.0.1, or lacks its upstream or its key', () => {
  for (const change of [{ url: 'http://localhost:8765' }, { upstream_url: undefined }, { stdin_secret: undefined }]) {
    const server = proxyServer(change);
    assert.deepEqual(faultCodes(() => toolsUserServer(declarationWith(server), server.name)), ['PROVIDER_PROXY_MALFORMED'], JSON.stringify(change));
  }
});

test('the runtime never starts a proxy as its own child, which would run it as the agent user', () => {
  const server = proxyServer({ runs_as: 'agent' });
  assert.deepEqual(faultCodes(() => startToolServers(declarationWith(server), { declarationPath: '/x', spawnFn: () => { throw new Error('spawned'); } })),
    ['PROVIDER_PROXY_NOT_TOOLS']);
});

test('the only secret a server is handed on stdin is the one it names, and only if declared', () => {
  const server = proxyServer();
  assert.equal(stdinSecretFor(declarationWith(server), server), '/srv/carbon/test-agent/secrets/openai-key');
  assert.equal(stdinSecretFor(declarationWith(server), proxyServer({ stdin_secret: undefined })), null);
  assert.deepEqual(faultCodes(() => stdinSecretFor(declarationWith(server), proxyServer({ stdin_secret: 'missing' }))), ['SECRET_REF_UNDECLARED']);
});

test('the tool unit hands the proxy its key as stdin, from the file, and the launcher neither reads nor logs it', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-proxy-'));
  const work = path.join(agentDir, 'tools-work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(agentDir, 'secrets'));
  const keyPath = path.join(agentDir, 'secrets', 'openai-key');
  const key = `PA259CANARY_${Date.now().toString(16)}_stdin_only`;
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  // The stand-in records what it was given: its arguments, its environment, and
  // every byte of its standard input. It runs in the declared cwd.
  const binDir = path.join(agentDir, 'current', PROVIDER_PROXY_DIR);
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, PROVIDER_PROXY_BINARY);
  fs.writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > args.txt\nenv > env.txt\ncat > stdin.bin\n', { mode: 0o755 });
  const server = proxyServer({ cwd: work });
  fs.writeFileSync(path.join(agentDir, 'current', 'carbon.agent.json'), JSON.stringify(declarationWith(server, keyPath)));

  const ran = spawnSync(process.execPath, [LAUNCHER, '--agent-dir', agentDir, '--instance', `${AGENT}-provider-proxy`], { encoding: 'utf8', timeout: 20000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(fs.readFileSync(path.join(work, 'stdin.bin'), 'utf8'), key, 'the key arrives whole on stdin');
  assert.deepEqual(fs.readFileSync(path.join(work, 'args.txt'), 'utf8').trim().split('\n'), ['--port', '8765', '--upstream-url', UPSTREAM]);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'env.txt'), 'utf8'), /CARBON_SECRET_|PA259CANARY/, 'no secret path and no key in the environment');
  assert.doesNotMatch(ran.stdout + ran.stderr, /PA259CANARY/, 'the launcher says the path it opened and never what is in it');
  const starting = JSON.parse(ran.stdout.split('\n').find((l) => l.includes('tool_server.starting')) ?? '{}');
  assert.equal(starting.stdin, keyPath);
});

test('a key file the tools user cannot open ends the launch by name, and nothing is started', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-proxy-'));
  fs.mkdirSync(path.join(agentDir, 'current'));
  fs.mkdirSync(path.join(agentDir, 'current', PROVIDER_PROXY_DIR), { recursive: true });
  const marker = path.join(agentDir, 'started');
  fs.writeFileSync(path.join(agentDir, 'current', PROVIDER_PROXY_DIR, PROVIDER_PROXY_BINARY), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const server = proxyServer({ cwd: agentDir });
  fs.writeFileSync(path.join(agentDir, 'current', 'carbon.agent.json'), JSON.stringify(declarationWith(server, path.join(agentDir, 'secrets', 'absent'))));
  const ran = spawnSync(process.execPath, [LAUNCHER, '--agent-dir', agentDir, '--instance', `${AGENT}-provider-proxy`], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stdout + ran.stderr, /STDIN_SECRET_UNREADABLE/);
  assert.equal(fs.existsSync(marker), false, 'the proxy is never started without its key');
});
