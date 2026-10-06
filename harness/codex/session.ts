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
import { redactNativeReason } from './reasons.ts';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fault } from '../../lib/faults.ts';
import { Connection, RpcError } from './protocol.ts';
import { EventStream } from './events.ts';
import type { HarnessEvent, NotificationParams } from './events.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Fault = { code: string; subject: string; problem: string; fix: string };
type ThreadReply = { thread?: { id?: unknown }; model?: unknown; reasoningEffort?: unknown; cwd?: unknown; approvalPolicy?: unknown; sandbox?: unknown; activePermissionProfile?: { id?: unknown } | null } | null;
export type ConnectOptions = {
  binary: string; codexHome: string; providerKeyPath?: string; providerKeyEnvName?: string;
  extraEnv?: Record<string, string>; credentialValues?: string[]; onEvent?: (event: HarnessEvent) => void;
  onStderr?: (chunk: string) => void; onDropped?: (line: string) => void;
  onWire?: (direction: string, line: string) => void;
  experimentalApi?: boolean;
  privateEndpoint?: string;
  attachPrivateEndpoint?: (details: PrivateEndpointDetails) => Promise<PrivateEndpointAttachment>;
};

export type PrivateEndpointDetails = { endpoint: string; pid: number; binary: string; codexHome: string };
export type PrivateEndpointAttachment = { close: () => Promise<void> | void; failed?: Promise<unknown> };

export type ThreadOpening = {
  cwd: string; model?: string; effort?: string; sandbox?: string; permissions?: string;
  unitId?: string; config?: Record<string, unknown>;
  developerInstructions?: string;
};

export const CLIENT_INFO = { name: 'carbon', version: 'increment-3' };

// The only variables the app-server child inherits from the runtime. Everything
// else it needs is named by the caller.
const INHERITED = ['PATH', 'HOME', 'LANG', 'TMPDIR'];

export class HarnessFault extends Error {
  fault: Fault;
  constructor(f: Fault, _faults?: Fault[]) {
    super(f.problem);
    this.name = 'HarnessFault';
    this.fault = f;
  }
}

function childEnv({ codexHome, providerKeyEnvName, providerKey, extraEnv }: Pick<ConnectOptions, 'codexHome' | 'providerKeyEnvName' | 'extraEnv'> & { providerKey?: string }) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CODEX_HOME = codexHome;
  for (const [name, value] of Object.entries(extraEnv ?? {})) env[name] = value;
  if (providerKeyEnvName) env[providerKeyEnvName] = providerKey;
  return env;
}

export class Session {
  child: ChildProcessWithoutNullStreams;
  connection: Connection;
  stream: EventStream;
  binary: string;
  codexHome: string;
  stderr: string[];
  credentialValues: string[] = [];
  threadId: unknown;
  thread: ThreadReply;
  initializeResult: unknown;
  experimentalApi = false;
  transportFailure: unknown = null;
  privateClose: (() => Promise<void>) | null = null;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor({ child, connection, stream, binary, codexHome, stderr }: {
    child: ChildProcessWithoutNullStreams; connection: Connection; stream: EventStream;
    binary: string; codexHome: string; stderr: string[];
  }) {
    this.child = child;
    this.connection = connection;
    this.stream = stream;
    this.binary = binary;
    this.codexHome = codexHome;
    this.stderr = stderr;
    this.threadId = null;
    this.thread = null;
    this.initializeResult = null;
    this.exit = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  }

  request(method: string, params: unknown) {
    return this.connection.request(method, params);
  }

  // A record of what was started, written to store/threads/<unit-id>.json by the
  // runtime before the first turn. The runtime half of increment 3 owns the write;
  // the harness owns the shape.
  threadRecord(unitId?: string) {
    return {
      unit_id: unitId,
      thread_id: this.threadId,
      model: this.thread?.model ?? null,
      effort: this.thread?.reasoningEffort ?? null,
      cwd: this.thread?.cwd ?? null,
      approval_policy: this.thread?.approvalPolicy ?? null,
      sandbox: this.thread?.sandbox ?? null,
      ...(this.thread?.activePermissionProfile ? { active_permission_profile: this.thread.activePermissionProfile } : {}),
      codex_home: this.codexHome,
      binary: this.binary,
      started_at: new Date().toISOString()
    };
  }

  async stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      await this.exit;
    }
    await this.privateClose?.();
  }

  kill9() {
    this.child.kill('SIGKILL');
    return this.exit;
  }
}

function privateEndpointUrl(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint); } catch { url = new URL('http://invalid'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new HarnessFault(fault('HARNESS_PRIVATE_ENDPOINT_REFUSED', 'connect.privateEndpoint',
      'the private app-server endpoint must be an explicit loopback WebSocket address and port',
      'supply ws://127.0.0.1:<owned-port> or ws://[::1]:<owned-port>'));
  }
  return url.origin;
}

async function openPrivateSocket(child: ChildProcessWithoutNullStreams, endpoint: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const socket = new WebSocket(endpoint);
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { socket.close(); resolve(false); }, Math.max(1, deadline - Date.now()));
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
    if (opened) return socket;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new HarnessFault(fault('HARNESS_PRIVATE_ENDPOINT_UNAVAILABLE', 'connect.privateEndpoint',
    'the owned app-server did not open its private WebSocket endpoint within ten seconds',
    'read the retained native stderr and correct the selected endpoint or binary'));
}

async function privateTransport(child: ChildProcessWithoutNullStreams, endpoint: string, attach: NonNullable<ConnectOptions['attachPrivateEndpoint']>, binary: string, codexHome: string, startupExit: Promise<void>) {
  let socket: WebSocket | null = null;
  let attachment: PrivateEndpointAttachment | null = null;
  let input = child.stdout;
  let output = child.stdin;
  try {
    socket = await openPrivateSocket(child, endpoint);
    attachment = await attach({ endpoint, pid: child.pid!, binary, codexHome });
    if (!attachment || typeof attachment.close !== 'function') throw new Error('the private endpoint owner supplied no close hook');
    const incoming = new PassThrough();
    const openedSocket = socket;
    input = incoming;
    output = new Writable({ write(chunk, _encoding, callback) {
      try { openedSocket.send(String(chunk).trimEnd()); callback(); } catch (error) { callback(error as Error); }
    } });
    socket.addEventListener('message', (message) => {
      if (typeof message.data === 'string') incoming.write(message.data + '\n');
    });
    socket.addEventListener('close', () => { incoming.destroy(); child.kill('SIGTERM'); });
    output.on('error', () => { incoming.destroy(); child.kill('SIGTERM'); });
  } catch (error) {
    socket?.close();
    child.kill('SIGTERM');
    await startupExit;
    await attachment?.close();
    throw error;
  }
  return { socket, attachment, input, output };
}

function attachPrivateLifecycle(session: Session, socket: WebSocket, attachment: PrivateEndpointAttachment) {
  const connectedSocket = socket;
  const owner = attachment;
  let release: Promise<void> | null = null;
  session.privateClose = () => {
    if (!release) release = Promise.resolve().then(async () => { connectedSocket.close(); await owner.close(); });
    return release;
  };
  session.exit.then(() => { void session.privateClose!().catch(error => { session.transportFailure = error; }); });
  owner.failed?.then(reason => {
    session.transportFailure = reason;
    void session.stop().catch(error => { session.transportFailure = error; });
  }, reason => {
    session.transportFailure = reason;
    void session.stop().catch(error => { session.transportFailure = error; });
  });
}

function redactionValues(credentialValues: string[], providerKey: string | undefined, extraEnv?: Record<string, string>) {
  return [...credentialValues, ...(providerKey ? [providerKey] : []),
    ...Object.entries(extraEnv ?? {}).filter(([name]) => /TOKEN|SECRET|KEY|CREDENTIAL|PASSWORD|CANARY/.test(name)).map(([, value]) => value)];
}

// Spawns the app-server and completes the handshake. Does not open a thread; that
// is `openThread` or `resumeThread`, so a caller that only wants tool status pays
// for nothing more.
export async function connect({ binary, codexHome, providerKeyPath, providerKeyEnvName, extraEnv, credentialValues = [], onEvent, onStderr, onDropped, onWire, experimentalApi = false, privateEndpoint, attachPrivateEndpoint }: ConnectOptions) {
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
        error instanceof Error ? error.message : String(error),
        'place the secret as a file readable by the agent user only, as the host contract requires'));
    }
    if (!providerKeyEnvName) {
      throw new HarnessFault(fault('HARNESS_PROVIDER_KEY_ENV_UNNAMED', providerKeyPath,
        'a provider key file was given with no environment variable name to pass it to the child under',
        'pass the name the provider expects, for example OPENAI_API_KEY'));
    }
  }

  const endpoint = privateEndpoint ? privateEndpointUrl(privateEndpoint) : null;
  if ((endpoint === null) !== (attachPrivateEndpoint === undefined)) {
    throw new HarnessFault(fault('HARNESS_PRIVATE_ENDPOINT_LIFECYCLE_ABSENT', 'connect.attachPrivateEndpoint',
      'a private endpoint and its owner lifecycle hook must be supplied together',
      'supply both options for the qualified private route, or omit both for stdio'));
  }
  const child = spawn(binary, ['app-server', ...(endpoint ? ['--listen', endpoint] : ['--stdio'])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv({ codexHome, providerKeyEnvName, providerKey, extraEnv })
  });
  const startupExit = new Promise<void>(resolve => child.once('exit', () => resolve()));

  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
    if (onStderr) onStderr(chunk);
  });

  const transport = endpoint ? await privateTransport(child, endpoint, attachPrivateEndpoint!, binary, codexHome, startupExit)
    : { input: child.stdout, output: child.stdin, socket: null, attachment: null };

  const stream = new EventStream(onEvent);
  const connection = new Connection({
    input: transport.input,
    output: transport.output,
    // The stream keeps raw optional notification fields; it does not treat this wire value as validated.
    onNotification: (method, params) => stream.accept(method, params as NotificationParams),
    onUnparsable: (line) => { if (onDropped) onDropped(line); },
    onWire
  });

  const session = new Session({ child, connection, stream, binary, codexHome, stderr });
  session.experimentalApi = experimentalApi;
  if (transport.socket && transport.attachment) attachPrivateLifecycle(session, transport.socket, transport.attachment);
  session.credentialValues = redactionValues(credentialValues, providerKey, extraEnv);
  try {
    session.initializeResult = await connection.request('initialize', { clientInfo: CLIENT_INFO,
      ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}) });
    connection.notify('initialized', {});
    return session;
  } catch (error) {
    await session.stop();
    throw error;
  }
}

// One thread per unit of work. `sandbox` is the thread's mode; the per-turn
// sandboxPolicy on turn/start is what actually fences a turn, and turn.mjs sends it
// every time.
function permissionSelection(session: Session, permissions?: string, sandbox?: string) {
  if (permissions && sandbox) throw new HarnessFault(fault('HARNESS_PERMISSION_POLICY_CONFLICT', 'thread.permissions',
    'permissions and sandbox cannot be combined; a legacy sandbox replaces the named profile read restrictions',
    'send the named permissions profile alone'));
  if (permissions && !session.experimentalApi) throw new HarnessFault(fault('HARNESS_PERMISSION_API_NOT_ENABLED', 'thread.permissions',
    'named thread permission profiles require the explicitly enabled experimental app-server API',
    'connect with experimentalApi true on the qualified binary and configured profile'));
}

function confirmPermissionProfile(reply: ThreadReply, permissions?: string) {
  if (permissions && reply?.activePermissionProfile?.id !== permissions) throw new HarnessFault(fault('HARNESS_PERMISSION_PROFILE_NOT_CONFIRMED', 'thread.activePermissionProfile',
    `the named permissions profile ${JSON.stringify(permissions)} was requested but the thread reports ${JSON.stringify(reply?.activePermissionProfile?.id ?? null)}`,
    'stop before a turn; qualify the selected binary and CODEX_HOME profile configuration'));
}

function configurationWithEffort(config?: Record<string, unknown>, effort?: string) {
  return config || effort ? { ...config, ...(effort ? { model_reasoning_effort: effort } : {}) } : undefined;
}

export async function openThread(session: Session, { cwd, model, effort, sandbox, permissions, unitId, config, developerInstructions }: ThreadOpening) {
  permissionSelection(session, permissions, sandbox);
  const params: { cwd: string; model?: string; sandbox?: string; permissions?: string; approvalPolicy: string; ephemeral: boolean; config?: Record<string, unknown>; developerInstructions?: string } = {
    cwd,
    model,
    approvalPolicy: 'never',
    ephemeral: false
  };
  if (sandbox) params.sandbox = sandbox;
  if (permissions) params.permissions = permissions;
  if (developerInstructions !== undefined) params.developerInstructions = developerInstructions;
  const configuration = configurationWithEffort(config, effort);
  if (configuration) params.config = configuration;
  // Optional wire fields are inspected below; missing or mismatched values still fault.
  const started = await session.request('thread/start', params) as ThreadReply;
  session.thread = started;
  session.threadId = started?.thread?.id ?? null;
  confirmPermissionProfile(started, permissions);

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
export async function resumeThread(session: Session, { threadId, cwd, model, effort, sandbox, permissions, config, developerInstructions }: {
  threadId: string; cwd?: string; model?: string; effort?: string; sandbox?: string; permissions?: string; config?: Record<string, unknown>; developerInstructions?: string;
}) {
  permissionSelection(session, permissions, sandbox);
  const params: { threadId: string; cwd?: string; model?: string; sandbox?: string; permissions?: string; config?: Record<string, unknown>; developerInstructions?: string } = { threadId };
  if (cwd) params.cwd = cwd;
  if (model) params.model = model;
  if (sandbox) params.sandbox = sandbox;
  if (permissions) params.permissions = permissions;
  if (developerInstructions !== undefined) params.developerInstructions = developerInstructions;
  const configuration = configurationWithEffort(config, effort);
  if (configuration) params.config = configuration;
  // The returned record remains wire data; callers receive it whole after the existing id fallback.
  const resumed = await session.request('thread/resume', params) as ThreadReply;
  confirmPermissionProfile(resumed, permissions);
  session.thread = resumed;
  session.threadId = resumed?.thread?.id ?? threadId;
  return resumed;
}

// ---- the account the harness is signed in to --------------------------------

// Which provider account this app-server runs on, and how much of its allowance
// is left, asked of the session that is already open. Two rules are carried here.
// `account/read` is sent with refreshToken false and never true: a refresh asked
// for by a reader makes the reader a writer of the login. And no second process is
// started for it, because a freshly started app-server refreshes an expired login
// before `initialize` returns and would be a second writer of that file.
//
// Each request is bounded by `timeoutMs`, because on the pinned binary
// `account/rateLimits/read` goes to the provider's backend and an unreachable one
// took twenty seconds to fail. A request that fails, times out, throws as it is
// sent or is skipped is returned as an entry in `error`, never thrown, and the
// other request's answer is kept.
//
// A bound ends the wait, not the request: the connection keeps a request it sent
// until the app-server answers it or closes. So a session has at most one of each
// account request outstanding. While one is, a new read does not send another; it
// records that method as still pending, so a server that never answers holds two
// entries in the connection, not one per turn.
//
// What comes back is read field by field into a record that has no place for
// anything else: account type, email and plan; whether the provider requires a
// login; the rate-limit windows, credits and the account id when the backend
// supplies one. Nothing else in either answer is carried, so a token the wire
// happens to hold has nowhere to go. An error is carried the same way: a fixed
// code, a fixed summary and the native code. The redacted original reporter
// reason is captured once, without passing credential values or raw error data.

export type AccountIdentity = { type: string | null; email: string | null; plan_type: string | null };
export type RateLimitWindowRecord = { used_percent: number | null; window_minutes: number | null; resets_at: number | null };
export type RateLimitsRecord = {
  account_id: string | null; limit_id: string | null; limit_name: string | null; plan_type: string | null;
  primary: RateLimitWindowRecord | null; secondary: RateLimitWindowRecord | null;
  credits: { has_credits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  rate_limit_reached_type: string | null;
};
export type AccountReadError = { method: string; code: string; summary: string; rpc_code: number | null; original_reason?: string | null; original_reason_available?: boolean; native_code?: string | number | null };
export type AccountRead = {
  observed_at: string;
  codex_version: string | null;
  account: AccountIdentity | null;
  requires_openai_auth: boolean | null;
  rate_limits: RateLimitsRecord | null;
  error: AccountReadError[] | null;
};

// Why a request failed, by kind. Fixed summaries accompany the redacted original
// reason; unavailable reporter reasons remain explicitly unavailable.
const FAILURES = {
  REJECTED: 'the app-server answered with an error; its redacted original reason is retained when available',
  TIMED_OUT: 'the app-server did not answer within the bound',
  NOT_SENT: 'the request failed as it was sent',
  STILL_PENDING: 'the last request of this kind is still unanswered, so none was sent'
};
type FailureKind = keyof typeof FAILURES;

// The code names the method as well as the kind, so a record read on its own says
// which of the two answers is missing.
const CODE_PREFIX: Record<string, string> = { 'account/read': 'ACCOUNT_READ', 'account/rateLimits/read': 'RATE_LIMITS_READ' };

class AccountRequestFailure extends Error {
  kind: FailureKind;
  original: unknown;
  constructor(kind: FailureKind, original: unknown = null) {
    super(FAILURES[kind]);
    this.kind = kind;
    this.original = original;
  }
}

function field(value: unknown, key: string): unknown {
  // The object test permits this named read; the returned field remains untrusted.
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
function text(value: unknown) { return typeof value === 'string' ? value : null; }
function count(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function flag(value: unknown) { return typeof value === 'boolean' ? value : null; }

function windowFrom(value: unknown): RateLimitWindowRecord | null {
  if (value === null || typeof value !== 'object') return null;
  // resetsAt is carried as the protocol gives it, a Unix timestamp, unconverted.
  return { used_percent: count(field(value, 'usedPercent')), window_minutes: count(field(value, 'windowDurationMins')), resets_at: count(field(value, 'resetsAt')) };
}

// One RateLimitSnapshot, from `account/rateLimits/read` or from the sparse
// `account/rateLimits/updated`, read into the record. An absent value is null
// here; it is the merging caller's rule that a null never clears a value it had.
export function rateLimitsFrom(snapshot: unknown, accountId: unknown = null): RateLimitsRecord | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const credits = field(snapshot, 'credits');
  return {
    account_id: text(accountId),
    limit_id: text(field(snapshot, 'limitId')),
    limit_name: text(field(snapshot, 'limitName')),
    plan_type: text(field(snapshot, 'planType')),
    primary: windowFrom(field(snapshot, 'primary')),
    secondary: windowFrom(field(snapshot, 'secondary')),
    credits: credits !== null && typeof credits === 'object'
      ? { has_credits: flag(field(credits, 'hasCredits')), unlimited: flag(field(credits, 'unlimited')), balance: text(field(credits, 'balance')) }
      : null,
    rate_limit_reached_type: text(field(snapshot, 'rateLimitReachedType'))
  };
}

function accountFrom(value: unknown): AccountIdentity | null {
  if (value === null || typeof value !== 'object') return null;
  return { type: text(field(value, 'type')), email: text(field(value, 'email')), plan_type: text(field(value, 'planType')) };
}

// The version the app-server says it is, off the user agent `initialize` answered
// with, which leads with `<originator>/<version>`. Null when it says nothing
// recognisable, rather than a guess.
function versionFrom(initializeResult: unknown) {
  const agent = text(field(initializeResult, 'userAgent'));
  const match = agent?.match(/\/(\d+\.\d+\.\d+[^\s;()]*)/);
  return match ? match[1] : null;
}

function bounded(request: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AccountRequestFailure('TIMED_OUT')), timeoutMs);
    // A read nobody answered must not be what keeps a stopping process alive.
    timer.unref?.();
  });
  return Promise.race([request, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// The account requests each session has sent and not yet had answered, by method.
const outstanding = new WeakMap<object, Set<string>>();

// One account request: skipped while the last of its method is unanswered, sent
// inside a try so a request that throws as it is sent is a rejection like any
// other, and bounded. The method is marked outstanding until the request itself
// settles, not until the bound ends the wait for it.
function ask(session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  let busy = outstanding.get(session);
  if (!busy) outstanding.set(session, busy = new Set());
  if (busy.has(method)) return Promise.reject(new AccountRequestFailure('STILL_PENDING'));
  let request: Promise<unknown>;
  try {
    request = Promise.resolve(session.request(method, params));
  } catch (error) {
    return Promise.reject(new AccountRequestFailure('NOT_SENT', error));
  }
  const held = busy;
  held.add(method);
  const release = () => { held.delete(method); };
  request.then(release, release);
  return bounded(request, timeoutMs);
}

// What a failed request is recorded as: its method, a code and summary fixed by
// the kind of failure, and the JSON-RPC error number when the app-server gave one.
// Original reporter wording is redacted here before reaching operator records.
function failure(method: string, reason: unknown, credentialValues: readonly string[] = []): AccountReadError {
  const kind: FailureKind = reason instanceof AccountRequestFailure ? reason.kind : 'REJECTED';
  const number = reason instanceof RpcError ? field(reason.rpcError, 'code') : null;
  const original = redactNativeReason(reason instanceof AccountRequestFailure ? reason.original : reason instanceof RpcError ? reason.rpcError : reason, credentialValues);
  return {
    method,
    code: `${CODE_PREFIX[method]}_${kind}`,
    summary: `${method}: ${FAILURES[kind]}`,
    rpc_code: typeof number === 'number' && Number.isSafeInteger(number) ? number : null,
    original_reason: original, original_reason_available: original !== null,
    native_code: typeof number === 'number' || typeof number === 'string' ? number : null
  };
}

export async function readAccount(session: Session, { timeoutMs }: { timeoutMs: number }): Promise<AccountRead> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new HarnessFault(fault('HARNESS_ACCOUNT_READ_UNBOUNDED', 'readAccount.timeoutMs',
      'an account read was asked for with no bound on how long it may wait, and one of its two requests goes to the provider',
      'pass timeoutMs; a read that never answers must not hold anything that waits on it'));
  }
  const observedAt = new Date().toISOString();
  const [account, limits] = await Promise.allSettled([
    ask(session, 'account/read', { refreshToken: false }, timeoutMs),
    ask(session, 'account/rateLimits/read', undefined, timeoutMs)
  ]);
  const errors: AccountReadError[] = [];
  const read: AccountRead = {
    observed_at: observedAt,
    codex_version: versionFrom(session.initializeResult),
    account: null,
    requires_openai_auth: null,
    rate_limits: null,
    error: null
  };
  if (account.status === 'fulfilled') {
    read.account = accountFrom(field(account.value, 'account'));
    read.requires_openai_auth = flag(field(account.value, 'requiresOpenaiAuth'));
  } else {
    errors.push(failure('account/read', account.reason, session.credentialValues));
  }
  if (limits.status === 'fulfilled') {
    read.rate_limits = rateLimitsFrom(field(limits.value, 'rateLimits'), field(limits.value, 'accountId'));
  } else {
    errors.push(failure('account/rateLimits/read', limits.reason, session.credentialValues));
  }
  if (errors.length > 0) read.error = errors;
  return read;
}

// Structural recovery reads use this same session; callers decide whether evidence
// settles an effect. No new turn is started by a read.
export function readThread(session: Session, { threadId, includeTurns }: { threadId: string; includeTurns: boolean }) {
  return bounded(Promise.resolve(session.request('thread/read', { threadId, includeTurns })), 15000);
}
