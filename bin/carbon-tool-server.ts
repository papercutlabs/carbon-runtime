// carbon-tool-server — the process the tool unit starts, and the only thing that
// runs as the tools user.
//
// A tool server that holds a credential cannot be a child of the runtime: a child
// inherits its parent's Unix account, and the runtime's account is the agent's,
// which is the account the model's own shell runs as. So such a server runs under
// its own systemd unit, `carbon-tool@<agent id>-<server name>`, whose `User=` is
// the tools user. A unit file fixes `User=`, `WorkingDirectory=` and
// `ReadWritePaths=` at unit-file time and expands no environment variable in any of
// them, and a unit file is root's to write. That is why this program exists: the
// unit carries the three values that are per-box, and everything per-server — the
// module, its arguments and the directory it runs in — is read from the declaration
// here, so a change to a tool server stays a commit and an install rather than
// another round of root on the box.
//
// The environment it hands the server is built from empty. Nothing this process
// was started with is passed on: what the server gets is the paths of the secrets
// its declaration entry names and the non-secret overrides runtime.env names, and
// nothing else. A secret is a path, opened by the server at the moment it uses it;
// no value is read, printed or logged here.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fault, report, RuntimeFault, EXIT } from '../runtime/faults.ts';
import { readDeclaration, placesUnder } from '../runtime/index.ts';
import { toolsUserServer, commandFor, environmentFor, serverNameFromInstance, stdinSecretFor } from '../runtime/tool-servers.ts';
import type { Declaration } from '../runtime/types.ts';
import { RECORDS_SERVER_NAME, serveRecordsTool } from '../runtime/records-tool.ts';

const HELP = `carbon-tool-server — run one tool server as the tools user, under its own unit

Usage:
  carbon-tool-server --agent-dir <dir> --instance <agent id>-<server name>
  carbon-tool-server --declaration <file> --server <name>

On a box there is one form, and the unit uses it: --agent-dir is the agent's
directory and --instance is the systemd instance name, which is the agent id and
the server name joined by a hyphen. The server name is what is left when the agent
id and its hyphen are taken off the front, so the two cannot disagree.

Off a box the declaration and the server name are passed directly, because a local
run has no install behind it.

  --agent-dir <dir>     the agent's directory; the declaration is read from
                        <agent-dir>/current/carbon.agent.json
  --instance <name>     the systemd instance, <agent id>-<server name>
  --declaration <file>  the declaration to read the server from
  --server <name>       the tool server's name in that declaration

It refuses a server the declaration does not mark runs_as tools, and one that is
not transport http: a unit of its own exists for exactly one shape of server, and
starting anything else under this account would put a credential where it does not
belong.

The server is started with the declaration's own command, in the declaration's own
cwd, told to bind the host and port of the declaration's url, with an environment
built from empty. This process stays as the unit's main process, forwards SIGTERM
and SIGINT, and exits with whatever the server exited with, so the unit's
Restart=on-failure and RestartPreventExitStatus=78 mean on this unit what they mean
on the agent's.

Every fault is one JSON line of {code, subject, problem, fix}.`;

const FLAGS = ['agent-dir', 'instance', 'declaration', 'server'];

function parse(argv: string[]) {
  const args: Record<string, string> = {};
  const faults = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name && FLAGS.includes(name)) {
      const value = argv[++i];
      if (value === undefined) {
        faults.push(fault('ARGUMENT_WITHOUT_VALUE', argv[i - 1],
          'this argument was given with no value', 'give it a value'));
        continue;
      }
      args[name] = value;
      continue;
    }
    faults.push(fault('UNKNOWN_ARGUMENT', argv[i],
      'not an argument of carbon-tool-server', 'run carbon-tool-server --help'));
  }
  return { args, faults };
}

async function main(argv: string[]) {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP);
    return rest.length === 0 ? 1 : 0;
  }
  const { args, faults } = parse(rest);

  const byAgentDir = Boolean(args['agent-dir']);
  if (byAgentDir && (args.declaration || args.server)) {
    faults.push(fault('ARGUMENTS_CONFLICT', '--agent-dir',
      '--agent-dir says where the declaration is and which instance this is, so a second answer to either is two answers to one question',
      'pass --agent-dir with --instance, or --declaration with --server'));
  }
  if (byAgentDir && !args.instance) {
    faults.push(fault('MISSING_ARGUMENT', '--instance',
      'a run from an agent directory is one systemd instance and this one does not say which',
      'pass --instance <agent id>-<server name>'));
  }
  if (!byAgentDir) {
    for (const name of ['declaration', 'server']) {
      if (!args[name]) {
        faults.push(fault('MISSING_ARGUMENT', `--${name}`,
          'a run without --agent-dir names the declaration and the server itself, and this one is missing',
          'pass --agent-dir <dir> --instance <name>, or --declaration <file> --server <name>'));
      }
    }
  }
  if (faults.length > 0) {
    report(faults);
    return EXIT.FAULT;
  }

  const declarationPath = byAgentDir
    ? placesUnder(path.resolve(args['agent-dir'])).declaration
    : path.resolve(args.declaration);
  // JSON from disk stays unknown until the launcher reads the fields it already uses.
  const declaration = readDeclaration(declarationPath) as Declaration;
  const name = byAgentDir
    ? serverNameFromInstance(args.instance, String(declaration.agent?.id ?? ''))
    : args.server;
  if (name === RECORDS_SERVER_NAME) {
    if (!byAgentDir) {
      report([fault('RECORDS_AGENT_DIR_REQUIRED', name,
        'the Carbon records server needs the installed agent directory and its tools-work receipt place',
        'start its systemd instance with --agent-dir and --instance')]);
      return EXIT.FAULT;
    }
    if (declaration.records?.enabled !== true) {
      process.stdout.write(JSON.stringify({ event: 'records.disabled', agent_id: declaration.agent?.id }) + '\n');
      return EXIT.OK;
    }
    const agentId = String(declaration.agent?.id ?? '');
    const agentDir = path.resolve(args['agent-dir']);
    const served = await serveRecordsTool({ database: agentId.replaceAll('-', '_'), agentId, agentDir,
      // A source is never accepted solely because the model named it. The
      // collector route is wired separately from this launcher.
      verifyObservation: async () => false });
    process.stdout.write(JSON.stringify({ event: 'records.listening', url: served.url,
      agent_id: agentId, invocation_id: served.health().invocationId }) + '\n');
    return new Promise<number>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        const ceiling = setTimeout(() => {
          report([fault('RECORDS_DRAIN_TIMEOUT', agentId,
            'the records server did not finish active calls and close its database sessions within 60 seconds',
            'fail this backup capture; inspect the active transaction before another attempt')]);
          process.exit(1);
        }, 60000);
        served.stop().then(() => { clearTimeout(ceiling); resolve(EXIT.OK); })
          .catch((error: Error) => { clearTimeout(ceiling); report([fault('RECORDS_DRAIN_FAILED', agentId,
            error.message, 'fail this backup capture and inspect the records server')]); resolve(EXIT.FAULT); });
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  }
  const server = toolsUserServer(declaration, name);

  const currentDir = byAgentDir ? path.join(path.resolve(args['agent-dir']), 'current') : null;
  const { command, args: argv2 } = commandFor(declaration, server, { declarationPath, currentDir });
  const env = environmentFor(declaration, server);
  // The provider proxy's key (PA-259). The file is opened here, as the tools user
  // that owns it, and the descriptor becomes the child's standard input. Nothing in
  // this process reads it: the proxy reads it once into locked memory itself.
  const stdinPath = stdinSecretFor(declaration, server);
  // toolsUserServer already refused a server without a command path; argv entries are those strings.
  const childArgs = argv2 as string[];

  // What was started, before it starts. The values here are paths and never
  // contents: a secret in the declaration is a path, and this line is what lets a
  // person reading the box say which file the server was told to open.
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(),
    event: 'tool_server.starting',
    name: server.name,
    url: server.url,
    cwd: server.cwd,
    command,
    args: childArgs,
    environment: Object.keys(env).sort(),
    stdin: stdinPath
  }) + '\n');

  // cwd is the declaration's own path string when present; spawn keeps its native refusal otherwise.
  let stdinFd: number | null = null;
  if (stdinPath) {
    try {
      stdinFd = fs.openSync(stdinPath, 'r');
    } catch (error) {
      // The open failure is used only for its message in the existing fault text.
      report([fault('STDIN_SECRET_UNREADABLE', stdinPath, (error as Error).message,
        'place the secret as the tools user, mode 0600: carbon secret place --owner tools')]);
      return EXIT.FAULT;
    }
  }
  const child = spawn(command, childArgs, { stdio: [stdinFd ?? 'ignore', 'inherit', 'inherit'], env, cwd: server.cwd as string | undefined });
  if (stdinFd !== null) fs.closeSync(stdinFd);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
  }
  return new Promise<number>((resolve) => {
    child.on('error', (error: Error) => {
      // Subject is the declaration's optional command field, as in the original JS
      // (may be undefined). Do not fall back to the Node binary path.
      report([fault('TOOL_SERVER_DID_NOT_START', server.command as string, error.message,
        'check the path in the declaration and that the checkout this box carries holds it')]);
      resolve(EXIT.FAULT);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        report([fault('TOOL_SERVER_SIGNALLED', server.name,
          `the server was ended by ${signal}`,
          'the unit restarts it; a repeated signal is the kernel or a person, and the journal says which')]);
        resolve(EXIT.FAULT);
        return;
      }
      resolve(code ?? EXIT.FAULT);
    });
  });
}

main(process.argv).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  if (error instanceof RuntimeFault) {
    report(error.faults);
    process.exitCode = error.exitCode;
    return;
  }
  // Optional access preserved: a null/undefined rejection must still report
  // TOOL_SERVER_LAUNCHER_THREW rather than throw inside this catch.
  const err = error as { message?: string; stack?: string } | null | undefined;
  report([fault('TOOL_SERVER_LAUNCHER_THREW', 'carbon-tool-server', err?.message ?? String(error),
    'this is a fault the launcher does not name; the stack is on stderr')]);
  process.stderr.write(`${err?.stack ?? error}\n`);
  process.exitCode = EXIT.FAULT;
});
