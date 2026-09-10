// The tool servers the runtime starts, which are exactly the ones that hold a
// secret.
//
// A stdio tool server is started by the harness, as the agent user, which is the
// user the model's own shell runs as; a secret that server can read is a secret a
// stranger's message can talk the model into reading. So a server holding a
// secret is `transport: http` on loopback and the runtime starts it as the tools
// user, which owns the secret files and which the agent user cannot become.
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

// The argument vector, as one list, so the same thing is used to start the server
// and to say in a log what was started.
export function commandFor(declaration, server, { declarationPath, toolsUser, node = process.execPath }) {
  const address = new URL(server.url);
  const args = [
    server.command,
    '--declaration', declarationPath,
    '--host', address.hostname,
    '--port', address.port
  ];
  if (!toolsUser) return { command: node, args };
  // sudo does not carry an environment, and it should not: the environment is
  // built here, from empty, and `env -i` is what says so on the command line.
  const env = environmentFor(declaration, server);
  const pairs = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  return { command: 'sudo', args: ['-u', toolsUser, 'env', '-i', ...pairs, node, ...args] };
}

export function serversToStart(declaration) {
  return (declaration.tool_servers ?? []).filter((s) => s.transport === 'http');
}

// Starts every http tool server and returns the handles. A server that exits is
// not restarted here: the harness reports it down through mcpServerStatus, and a
// required server that is down holds release, by name. Restarting a thing that
// just died is how a box hides a broken credential.
export function startToolServers(declaration, { declarationPath, toolsUser, spawnFn = spawn, onExit = () => {} }) {
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
    const { command, args } = commandFor(declaration, server, { declarationPath, toolsUser });
    const env = toolsUser ? {} : environmentFor(declaration, server);
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
