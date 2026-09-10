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
import { fault, RuntimeFault } from './faults.mjs';

// The name of a secret becomes the environment variable that carries its path.
// A tool that wants a different name says so in runtime.env, which is a path and
// not a value, so nothing secret is written into an environment either way.
export function secretEnvName(secretName) {
  return `CARBON_SECRET_${secretName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function environmentFor(declaration, server) {
  const byName = new Map((declaration.secrets ?? []).map((s) => [s.name, s]));
  const env = {};
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
export function commandFor(declaration, server, { declarationPath, node = process.execPath }) {
  const address = new URL(server.url);
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
export function serverNameFromInstance(instance, agentId) {
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
export function toolsUserServer(declaration, name) {
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
  return server;
}

// Which servers this process starts as its own children: the http ones that run as
// the agent user. A tools-user server has its own unit and is never here.
export function serversToStart(declaration) {
  return (declaration.tool_servers ?? [])
    .filter((s) => s.transport === 'http' && s.runs_as !== 'tools');
}

// Which servers this process waits for rather than starts.
export function serversToAwait(declaration) {
  return (declaration.tool_servers ?? [])
    .filter((s) => s.transport === 'http' && s.runs_as === 'tools');
}

// Does something answer on this address? A tcp connect and nothing more: the
// question is whether the unit that owns this port is up, and an MCP handshake
// would be a second question with its own failure modes.
export function answers(url, { timeoutMs = 2000, connect = net.connect } = {}) {
  const address = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: address.hostname, port: Number(address.port) });
    const done = (value) => { socket.destroy(); resolve(value); };
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
export async function awaitToolServers(declaration, {
  timeoutMs = 30000, intervalMs = 250, log = () => {}, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), probe = answers
} = {}) {
  const waiting = serversToAwait(declaration);
  const results = [];
  const deadline = now() + timeoutMs;
  for (const server of waiting) {
    let up = false;
    for (;;) {
      up = await probe(server.url);
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
export function startToolServers(declaration, { declarationPath, spawnFn = spawn, onExit = () => {} }) {
  const started = [];
  const faults = [];
  for (const server of serversToStart(declaration)) {
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
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: server.cwd });
    child.on('exit', (code, signal) => onExit(server.name, code, signal));
    started.push({ name: server.name, url: server.url, child, command, args });
  }
  if (faults.length > 0) {
    for (const s of started) s.child.kill('SIGTERM');
    throw new RuntimeFault(faults);
  }
  return started;
}

export function stopToolServers(started) {
  for (const server of started ?? []) {
    try { server.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
