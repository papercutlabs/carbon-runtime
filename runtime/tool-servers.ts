import type { ChildProcess } from 'node:child_process';
import type { Declaration, Server, Log } from './types.ts';
// The tool servers, and which of them this process starts.
//
// A stdio tool server is started by the harness, as the agent user, which is the
// user the model's own shell runs as; a secret that server can read is a secret a
// stranger's message can talk the model into reading. So a server holding a secret
// is `transport: http` on loopback and runs as the tools user, which owns the
// secret files and which the agent user cannot become.
//
// How it gets that account is the thing that changed. A child of this process
// inherits this process's account, and this process is what the agent's unit
// starts, so no arrangement of children ever produced a tools-user server. It runs
// under its own systemd unit instead, `carbon-tool@<agent id>-<server name>`,
// installed and enabled by the box owner at bootstrap and bound to the agent's unit
// so the two start and restart together (HC-21). This process therefore does not
// start it: it waits for the loopback address the declaration names to answer, and
// a required server that never answers holds release by name, exactly as a server
// the app-server reports down does.
//
// What this process still starts is an `runs_as: agent` http server, as itself.
// Such a server may hold no secret; `carbon declaration check` refuses one that
// names a secret the tools user owns.
//
// Two rules are carried here and neither is a default:
//
// 1. The environment is built from empty. Nothing this process holds is
//    inherited: not the provider key, not PATH, not HOME. What a server gets is
//    the paths of the secrets its declaration entry names and the non-secret
//    overrides `runtime.env` names, and nothing else.
// 2. The declaration says how the server starts and where it listens. `command`
//    is the absolute path of the module; `url` is the loopback address the
//    harness connects to, and the host and port the server is told to bind are
//    read from that url, so the two cannot drift apart.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fault, RuntimeFault } from './faults.ts';

// The name of a secret becomes the environment variable that carries its path.
// A tool that wants a different name says so in runtime.env, which is a path and
// not a value, so nothing secret is written into an environment either way.
export function secretEnvName(secretName: string) {
  return `CARBON_SECRET_${secretName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function environmentFor(declaration: Declaration, server: Server) {
  const byName = new Map((declaration.secrets ?? []).map((s) => [s.name, s]));
  const env: NodeJS.ProcessEnv = {};
  for (const ref of server.secret_refs ?? []) {
    const secret = byName.get(ref);
    if (!secret) {
      throw new RuntimeFault(fault('SECRET_REF_UNDECLARED', `${server.name}.secret_refs`,
        `the server names the secret ${JSON.stringify(ref)} and the declaration declares no such secret`,
        'declare the secret with its absolute path, or drop the reference'));
    }
    env[secretEnvName(secret.name)] = secret.path;
  }
  for (const entry of declaration.runtime?.env ?? []) env[entry.name] = entry.value;
  return env;
}

// The argument vector, as one list, so the same thing is used to start the server,
// to say in a log what was started, and to recognise the process in a check from
// outside the box.
// The provider proxy (PA-259). The provider key is a tools-owned file, and the
// process that holds it is Codex's own standalone Responses proxy from the pinned
// harness release, run under this same tool unit and fed the key on stdin. The
// app-server then talks to it on loopback with no key of its own. It is not an MCP
// server: it answers POST /v1/responses and refuses everything else, so nothing
// that renders, admits or evaluates MCP servers may treat it as one.
export const PROVIDER_PROXY = 'provider_proxy';
export const PROVIDER_PROXY_BINARY = 'codex-responses-api-proxy';
// Where install places it: inside the installed version, which the tools user owns
// and makes read-only, and never under harness/, which the agent user owns. A key
// holder that ran a binary the agent user could replace would hand the key to it.
export const PROVIDER_PROXY_DIR = 'provider-proxy';

export function isProviderProxy(server: Server | undefined | null) {
  return server?.kind === PROVIDER_PROXY;
}

// The one secret handed to a server as its standard input, or null. Only the
// provider proxy has one. The launcher opens this path and passes the descriptor;
// the bytes are never read into any process of ours.
export function stdinSecretFor(declaration: Declaration, server: Server) {
  if (!server.stdin_secret) return null;
  const secret = (declaration.secrets ?? []).find((s) => s.name === server.stdin_secret);
  if (!secret) {
    throw new RuntimeFault(fault('SECRET_REF_UNDECLARED', `${server.name}.stdin_secret`,
      `the server names ${JSON.stringify(server.stdin_secret)} as its standard input and the declaration declares no such secret`,
      'declare the secret with its absolute path, or correct stdin_secret'));
  }
  return secret.path;
}

export function commandFor(declaration: Declaration, server: Server, { declarationPath, currentDir = null, node = process.execPath }: { declarationPath: string; currentDir?: string | null; node?: string }) {
  // The declaration caller supplies the URL; URL retains its native refusal otherwise.
  const address = new URL(server.url!);
  if (isProviderProxy(server)) {
    if (!currentDir) {
      throw new RuntimeFault(fault('PROVIDER_PROXY_NO_INSTALL', `tool_servers.${server.name}`,
        'the provider proxy is the standalone binary install places in the installed version, and this run was given no installed version to find it in',
        'run it from an agent directory (--agent-dir), where install placed it'));
    }
    // Exactly two flags. Never --http-shutdown (any local caller could stop it),
    // --server-info or --dump-dir (a file this unit would write). The proxy binds
    // 127.0.0.1 itself; the port is the declaration's url.
    return {
      command: path.join(currentDir, PROVIDER_PROXY_DIR, PROVIDER_PROXY_BINARY),
      args: ['--port', address.port, '--upstream-url', String(server.upstream_url)]
    };
  }
  return {
    command: node,
    args: [
      server.command,
      '--declaration', declarationPath,
      '--host', address.hostname,
      '--port', address.port
    ]
  };
}

// The server's name, out of the systemd instance name and the agent id the
// declaration carries. Splitting on the hyphen alone would be a guess: both halves
// may hold one.
export function serverNameFromInstance(instance: string, agentId: string) {
  const prefix = `${agentId}-`;
  if (!instance.startsWith(prefix) || instance.length === prefix.length) {
    throw new RuntimeFault(fault('TOOL_UNIT_INSTANCE_UNREADABLE', instance,
      `a tool unit instance is the agent id and the server name joined by a hyphen, and this one does not begin with ${JSON.stringify(prefix)}`,
      `name the instance ${agentId}-<server name>, as bootstrap.sh does`));
  }
  return instance.slice(prefix.length);
}

// The server the declaration names, found by name and checked to be the shape the
// tool unit's launcher can start.
export function toolsUserServer(declaration: Declaration, name: string) {
  const server = (declaration.tool_servers ?? []).find((s) => s.name === name);
  if (!server) {
    throw new RuntimeFault(fault('TOOL_SERVER_UNDECLARED', name,
      `the declaration on this box names no tool server called ${JSON.stringify(name)}`,
      'check the unit instance name against the declaration; the instance is <agent id>-<server name>'));
  }
  if (server.runs_as !== 'tools') {
    throw new RuntimeFault(fault('TOOL_SERVER_NOT_A_TOOLS_SERVER', name,
      `the declaration marks this server runs_as ${JSON.stringify(server.runs_as)}, and a unit of its own exists only for a server that runs as the tools user`,
      'declare runs_as as tools, or stop the unit; an agent-user server is started by the runtime'));
  }
  if (server.transport !== 'http') {
    throw new RuntimeFault(fault('TOOL_SERVER_NOT_HTTP', name,
      `the declaration marks this server transport ${JSON.stringify(server.transport)}, and the harness reaches a tools-user server over loopback`,
      'declare transport as http with the loopback url the unit serves it on'));
  }
  if (isProviderProxy(server)) {
    let host = null;
    try { host = new URL(String(server.url)).hostname; } catch { host = null; }
    if (host !== '127.0.0.1' || !server.upstream_url || !server.stdin_secret) {
      throw new RuntimeFault(fault('PROVIDER_PROXY_MALFORMED', name,
        'a provider proxy listens on 127.0.0.1, forwards to one upstream_url and takes its key as stdin_secret, and this entry is missing one of the three',
        'run carbon declaration check; it names the field'));
    }
  }
  return server;
}

// Which servers this process starts as its own children: the http ones that run as
// the agent user. A tools-user server has its own unit and is never here.
export function serversToStart(declaration: Declaration) {
  return (declaration.tool_servers ?? [])
    .filter((s) => s.transport === 'http' && s.runs_as !== 'tools');
}

// Which servers this process waits for rather than starts.
export function serversToAwait(declaration: Declaration) {
  return (declaration.tool_servers ?? [])
    .filter((s) => s.transport === 'http' && s.runs_as === 'tools');
}

// Does something answer on this address? A tcp connect and nothing more: the
// question is whether the unit that owns this port is up, and an MCP handshake
// would be a second question with its own failure modes.
export function answers(url: string, { timeoutMs = 2000, connect = net.connect } = {}): Promise<boolean> {
  const address = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: address.hostname, port: Number(address.port) });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

// Waits for every tools-user server's address to answer, up to one window across
// all of them. A required server that never answers is reported and the process
// carries on: the agent still has to read its mailbox, and release is held by name
// while the server is down, which is the same thing that happens today when a
// server this process started dies at hour three.
export async function awaitToolServers(declaration: Declaration, {
  timeoutMs = 30000, intervalMs = 250, log = () => {}, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), probe = answers
}: { timeoutMs?: number; intervalMs?: number; log?: Log; now?: () => number; sleep?: (ms: number) => Promise<unknown>; probe?: (url: string) => Promise<boolean> } = {}) {
  const waiting = serversToAwait(declaration);
  const results = [];
  const deadline = now() + timeoutMs;
  for (const server of waiting) {
    let up = false;
    for (;;) {
      up = await probe(server.url!); // The declaration supplies the URL; the existing URL constructor retains its native refusal for malformed input.
      if (up || now() >= deadline) break;
      await sleep(intervalMs);
    }
    results.push({ name: server.name, url: server.url, answered: up, required: server.required === true });
    if (up) {
      log({ event: 'tool_server.answered', name: server.name, url: server.url, unit: 'carbon-tool' });
    } else {
      log({
        event: 'tool_server.silent',
        name: server.name,
        url: server.url,
        required: server.required === true,
        fault: fault('TOOL_SERVER_UNIT_SILENT', `tool_servers.${server.name}`,
          `this server runs under its own unit as the tools user and nothing answered on ${server.url} within ${timeoutMs} ms`,
          `read the unit: systemctl restart carbon-tool@${declaration.agent?.id}-${server.name}. While it is down, release is held on this agent and doctor names it from outside the box.`)
      });
    }
  }
  return results;
}

// Starts every agent-user http tool server and returns the handles. A server that
// exits is not restarted here: the harness reports it down through
// mcpServerStatus, and a required server that is down holds release, by name.
// Restarting a thing that just died is how a box hides a broken credential.
export function startToolServers(declaration: Declaration, { declarationPath, spawnFn = spawn, onExit = () => {} }: { declarationPath: string; spawnFn?: typeof spawn; onExit?: (name: string, code: number | null, signal: NodeJS.Signals | null) => void }) {
  const started = [];
  const faults = [];
  for (const server of serversToStart(declaration)) {
    if (isProviderProxy(server)) {
      faults.push(fault('PROVIDER_PROXY_NOT_TOOLS', `tool_servers.${server.name}`,
        'the provider proxy holds the provider key, and a server this process starts runs as the agent user, which is the account the model\'s own shell runs as',
        'declare runs_as as tools, so it runs under its own unit'));
      continue;
    }
    if (!server.command) {
      faults.push(fault('TOOL_SERVER_COMMAND_ABSENT', `tool_servers.${server.name}`,
        'an http tool server is started by the runtime and this one does not say what to start',
        'give command as the absolute path of the server module'));
      continue;
    }
    if (!fs.existsSync(server.command)) {
      faults.push(fault('TOOL_SERVER_COMMAND_NOT_THERE', `tool_servers.${server.name}`,
        `${server.command} is not a file on this box`,
        'install the agent repository commit the declaration names, and check the path'));
      continue;
    }
    const { command, args } = commandFor(declaration, server, { declarationPath });
    const env = environmentFor(declaration, server);
    // Command presence was checked above; preserve the commandFor result
    // as raw values publicly and narrow only this existing spawn operation.
    const child = spawnFn(command, args as string[], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: server.cwd });
    child.on('exit', (code, signal) => onExit(server.name, code, signal));
    started.push({ name: server.name, url: server.url, child, command, args });
  }
  if (faults.length > 0) {
    for (const s of started) s.child.kill('SIGTERM');
    throw new RuntimeFault(faults);
  }
  return started;
}

export function stopToolServers(started: { child: Pick<ChildProcess, 'kill'> }[] | null | undefined) {
  for (const server of started ?? []) {
    try { server.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
