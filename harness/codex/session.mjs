// start — the second of the six operations. Spawns the pinned `codex app-server`
// as a direct child on stdio, initializes, opens one thread per unit of work and
// names it after the unit.
//
// Three rules from the plan are carried here and are easy to lose. The child is a
// direct child on pipes the caller already owns, so no socket is listening and no
// socket's mode has to be right. The child's environment is built from an explicit
// list and not inherited, so a key in this process does not leak into a tool the
// model spawns. And the model and the effort are read back out of the thread/start
// reply rather than assumed, because a model name the provider silently reroutes
// is a thing that happens.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fault } from '../../lib/faults.mjs';
import { Connection } from './protocol.mjs';
import { EventStream } from './events.mjs';

export const CLIENT_INFO = { name: 'carbon', version: 'increment-3' };

// The only variables the app-server child inherits from the runtime. Everything
// else it needs is named by the caller.
const INHERITED = ['PATH', 'HOME', 'LANG', 'TMPDIR'];

export class HarnessFault extends Error {
  constructor(f) {
    super(f.problem);
    this.name = 'HarnessFault';
    this.fault = f;
  }
}

function childEnv({ codexHome, providerKeyEnvName, providerKey, extraEnv }) {
  const env = {};
  for (const name of INHERITED) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CODEX_HOME = codexHome;
  for (const [name, value] of Object.entries(extraEnv ?? {})) env[name] = value;
  if (providerKeyEnvName) env[providerKeyEnvName] = providerKey;
  return env;
}

export class Session {
  constructor({ child, connection, stream, binary, codexHome, stderr }) {
    this.child = child;
    this.connection = connection;
    this.stream = stream;
    this.binary = binary;
    this.codexHome = codexHome;
    this.stderr = stderr;
    this.threadId = null;
    this.thread = null;
    this.initializeResult = null;
    this.exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  }

  request(method, params) {
    return this.connection.request(method, params);
  }

  // A record of what was started, written to store/threads/<unit-id>.json by the
  // runtime before the first turn. The runtime half of increment 3 owns the write;
  // the harness owns the shape.
  threadRecord(unitId) {
    return {
      unit_id: unitId,
      thread_id: this.threadId,
      model: this.thread?.model ?? null,
      effort: this.thread?.reasoningEffort ?? null,
      cwd: this.thread?.cwd ?? null,
      approval_policy: this.thread?.approvalPolicy ?? null,
      sandbox: this.thread?.sandbox ?? null,
      codex_home: this.codexHome,
      binary: this.binary,
      started_at: new Date().toISOString()
    };
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await this.exit;
  }

  kill9() {
    this.child.kill('SIGKILL');
    return this.exit;
  }
}

// Spawns the app-server and completes the handshake. Does not open a thread; that
// is `openThread` or `resumeThread`, so a caller that only wants tool status pays
// for nothing more.
export async function connect({ binary, codexHome, providerKeyPath, providerKeyEnvName, extraEnv, onEvent, onStderr, onDropped, onWire }) {
  if (!fs.existsSync(codexHome)) {
    throw new HarnessFault(fault('HARNESS_CODEX_HOME_ABSENT', codexHome,
      'the CODEX_HOME directory does not exist, and the harness never creates it',
      'create the directory as the agent user, or point --codex-home at the one install rendered'));
  }
  let providerKey;
  if (providerKeyPath) {
    try {
      providerKey = fs.readFileSync(providerKeyPath, 'utf8').trim();
    } catch (error) {
      throw new HarnessFault(fault('HARNESS_PROVIDER_KEY_UNREADABLE', providerKeyPath,
        error.message,
        'place the secret as a file readable by the agent user only, as the host contract requires'));
    }
    if (!providerKeyEnvName) {
      throw new HarnessFault(fault('HARNESS_PROVIDER_KEY_ENV_UNNAMED', providerKeyPath,
        'a provider key file was given with no environment variable name to pass it to the child under',
        'pass the name the provider expects, for example OPENAI_API_KEY'));
    }
  }

  const child = spawn(binary, ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv({ codexHome, providerKeyEnvName, providerKey, extraEnv })
  });

  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
    if (onStderr) onStderr(chunk);
  });

  const stream = new EventStream(onEvent);
  const connection = new Connection({
    input: child.stdout,
    output: child.stdin,
    onNotification: (method, params) => stream.accept(method, params),
    onUnparsable: (line) => { if (onDropped) onDropped(line); },
    onWire
  });

  const session = new Session({ child, connection, stream, binary, codexHome, stderr });
  session.initializeResult = await connection.request('initialize', { clientInfo: CLIENT_INFO });
  connection.notify('initialized', {});
  return session;
}

// One thread per unit of work. `sandbox` is the thread's mode; the per-turn
// sandboxPolicy on turn/start is what actually fences a turn, and turn.mjs sends it
// every time.
export async function openThread(session, { cwd, model, effort, sandbox, unitId }) {
  const params = {
    cwd,
    model,
    sandbox,
    approvalPolicy: 'never',
    ephemeral: false
  };
  if (effort) params.config = { model_reasoning_effort: effort };
  const started = await session.request('thread/start', params);
  session.thread = started;
  session.threadId = started?.thread?.id ?? null;

  const faults = [];
  if (!session.threadId) {
    faults.push(fault('HARNESS_THREAD_ID_ABSENT', 'thread/start',
      'the reply carried no thread id, so no turn can be correlated',
      'record the reply and stop; the pinned protocol moved'));
  }
  if (model && started?.model !== model) {
    faults.push(fault('HARNESS_MODEL_NOT_CONFIRMED', 'thread/start.model',
      `the declaration asks for ${model} and the thread reports ${JSON.stringify(started?.model)}`,
      'stop the agent; a rerouted model is a different agent'));
  }
  if (effort && started?.reasoningEffort !== effort) {
    faults.push(fault('HARNESS_EFFORT_NOT_CONFIRMED', 'thread/start.reasoningEffort',
      `the declaration asks for effort ${effort} and the thread reports ${JSON.stringify(started?.reasoningEffort)}`,
      'stop the agent; effort is a cost and a quality decision, not a hint'));
  }
  if (started?.approvalPolicy !== 'never') {
    faults.push(fault('HARNESS_APPROVAL_POLICY_NOT_NEVER', 'thread/start.approvalPolicy',
      `the thread reports ${JSON.stringify(started?.approvalPolicy)}, and an agent with nobody at the keyboard must never be asked`,
      'stop the agent; a turn that waits for an approval never completes'));
  }
  if (faults.length) throw new HarnessFault(faults[0], faults);

  if (unitId) await session.request('thread/name/set', { threadId: session.threadId, name: unitId });
  return session.threadRecord(unitId);
}

// Rejoins a thread the app-server already has on disk, which is what the runtime
// does after a restart. The thread state the reply reports is returned whole,
// because "what does the thread say it is" is the question a restart asks.
export async function resumeThread(session, { threadId, cwd, model, effort, sandbox }) {
  const params = { threadId };
  if (cwd) params.cwd = cwd;
  if (model) params.model = model;
  if (sandbox) params.sandbox = sandbox;
  if (effort) params.config = { model_reasoning_effort: effort };
  const resumed = await session.request('thread/resume', params);
  session.thread = resumed;
  session.threadId = resumed?.thread?.id ?? threadId;
  return resumed;
}
