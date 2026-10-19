// Runs a pinned Node entrypoint through bwrap; no Codex or unsandboxed fallback.
// Stdin/stdout use carbon.program-release.v1 / carbon.program-result.v1.
// Parent loads declared CARBON_SECRET_<NAME> values; child cannot read secret files.
// HC-14 paths and store are hidden except this release’s own attachments.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fault } from '../../lib/faults.ts';

export const HARNESS_KIND = 'program';
export const PROGRAM_ENTRYPOINT_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|ts)$/;
export const OUTPUT_CAP = 1024 * 1024;
const STDERR_TAIL = 500;
const STDERR_WINDOW = 8192;
const INHERITED = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
const DISPOSITIONS = new Set(['reply', 'no_reply', 'missing_case']);

type FaultRow = ReturnType<typeof fault>;
type ProgramReply = {
  conversation_id: string; request_id: string; text: string;
  attachments?: string[]; about_job?: string; about_move?: string;
};
type ProgramBody = {
  disposition: 'reply' | 'no_reply' | 'missing_case';
  replies: ProgramReply[];
  observations: { name: string; detail: string }[];
  timings: { name: string; ms: number }[];
};

export class ProgramFault extends Error {
  fault: FaultRow;
  faults: FaultRow[];
  constructor(item: FaultRow) {
    super(String(item.problem));
    this.name = 'ProgramFault';
    this.fault = item;
    this.faults = [item];
  }
}

function refused(code: string, subject: string, problem: string, fix: string): never {
  throw new ProgramFault(fault(code, subject, problem, fix));
}

function entrypointRefused(entrypoint: unknown, problem: string): never {
  refused('PROGRAM_ENTRYPOINT_REFUSED', String(entrypoint), problem,
    'set harness.entrypoint to a relative .mjs or .ts file inside the pinned checkout');
}

function contained(checkoutReal: string, candidate: string) {
  const rel = path.relative(checkoutReal, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Realpath the checkout so an install symlink to the version directory is the
// pin. Reject absolute paths, `..`, a symlink at any component, and a realpath
// that leaves the checkout.
export function resolveEntrypoint(checkout: unknown, entrypoint: unknown) {
  if (typeof entrypoint !== 'string' || path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes('..')) {
    entrypointRefused(entrypoint, 'a program entrypoint is a relative path inside the pinned checkout and cannot climb out of it');
  }
  if (!PROGRAM_ENTRYPOINT_PATTERN.test(entrypoint)) {
    entrypointRefused(entrypoint, 'a program entrypoint is one relative .mjs or .ts path');
  }
  let checkoutReal: string;
  try {
    checkoutReal = fs.realpathSync(String(checkout));
  } catch {
    refused('PROGRAM_ENTRYPOINT_UNPINNED', String(checkout),
      'the checkout cannot be resolved, so the entrypoint has no pin to be inside',
      'install the pinned repository and pass that checkout');
  }
  let at = checkoutReal;
  for (const part of entrypoint.split('/')) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      refused('PROGRAM_ENTRYPOINT_MISSING', entrypoint,
        'the entrypoint is not a file in the pinned checkout',
        'commit the entrypoint at that path and reinstall');
    }
    if (stat.isSymbolicLink()) {
      refused('PROGRAM_ENTRYPOINT_SYMLINK', entrypoint,
        'the entrypoint path contains a symlink, and a symlink can leave the pinned checkout',
        'replace the symlink with the file it names inside the checkout');
    }
  }
  if (!fs.statSync(at).isFile() || !contained(checkoutReal, fs.realpathSync(at))) {
    refused('PROGRAM_ENTRYPOINT_ESCAPES', entrypoint,
      'the entrypoint does not resolve to a regular file inside the pinned checkout',
      'point harness.entrypoint at a file in the installed repository');
  }
  return at;
}

function childEnv(secrets: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...secrets };
}

function invalid(subject: string, problem: string): never {
  refused('PROGRAM_RESPONSE_INVALID', subject, problem,
    'print one carbon.program-result.v1 JSON document on stdout and exit 0');
}

function underWork(work: string, given: string) {
  const root = path.resolve(work);
  const resolved = path.resolve(given);
  return contained(root, resolved);
}

function validateAttachments(value: unknown, work: string) {
  if (!Array.isArray(value) || value.length > 100) invalid('replies[0].attachments', 'attachments is a list of at most 100 absolute work paths');
  for (const given of value) {
    if (typeof given !== 'string' || !path.isAbsolute(given) || !underWork(work, given)) {
      invalid('replies[0].attachments', 'each attachment is an absolute path inside the work directory');
    }
  }
  return value as string[];
}

function optionalString(item: Record<string, unknown>, key: 'about_job' | 'about_move') {
  const value = item[key];
  if (value !== undefined && typeof value !== 'string') invalid(`replies[0].${key}`, `${key} is a string when the handler sends one`);
  return value as string | undefined;
}

function validateReply(reply: unknown, envelope: { conversation_id?: unknown; release_id?: unknown }, work: string): ProgramReply {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) invalid('replies[0]', 'a reply is one object');
  const item = reply as Record<string, unknown>;
  if (item.conversation_id !== envelope.conversation_id) {
    invalid('replies[0].conversation_id', 'conversation_id must be the conversation on this release');
  }
  if (item.request_id !== envelope.release_id) {
    invalid('replies[0].request_id', 'request_id must be the release id the runtime fenced');
  }
  if (typeof item.text !== 'string' || item.text.length < 1 || item.text.length > 10000) {
    invalid('replies[0].text', 'reply text is a string of 1 to 10000 characters');
  }
  const ready: ProgramReply = {
    conversation_id: item.conversation_id as string,
    request_id: item.request_id as string,
    text: item.text
  };
  if (item.attachments !== undefined) ready.attachments = validateAttachments(item.attachments, work);
  const aboutJob = optionalString(item, 'about_job');
  if (aboutJob !== undefined) ready.about_job = aboutJob;
  const aboutMove = optionalString(item, 'about_move');
  if (aboutMove !== undefined) ready.about_move = aboutMove;
  return ready;
}

function validateObservations(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) invalid('observations', 'observations is a list of at most 32 {name, detail} records');
  return value.map((item) => {
    if (!item || typeof item !== 'object') invalid('observations', 'each observation is an object');
    const row = item as { name?: unknown; detail?: unknown };
    if (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 64) invalid('observations.name', 'an observation name is 1 to 64 characters');
    if (typeof row.detail !== 'string' || row.detail.length > 500) invalid('observations.detail', 'an observation detail is at most 500 characters');
    return { name: row.name, detail: row.detail };
  });
}

function validateTimings(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) invalid('timings', 'timings is a list of at most 32 {name, ms} records');
  return value.map((item) => {
    if (!item || typeof item !== 'object') invalid('timings', 'each timing is an object');
    const row = item as { name?: unknown; ms?: unknown };
    if (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 64) invalid('timings.name', 'a timing name is 1 to 64 characters');
    if (typeof row.ms !== 'number' || !Number.isFinite(row.ms) || row.ms < 0) invalid('timings.ms', 'a timing ms is a finite number of zero or more');
    return { name: row.name, ms: row.ms };
  });
}

export function parseProgramResult(text: string, envelope: { conversation_id?: unknown; release_id?: unknown }, work: string): ProgramBody {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    invalid('stdout', 'the handler stdout is not one JSON document');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('stdout', 'the handler result is not one object');
  const doc = body as { schema?: unknown; disposition?: unknown; replies?: unknown; observations?: unknown; timings?: unknown };
  if (doc.schema !== 'carbon.program-result.v1') invalid('schema', 'schema must be carbon.program-result.v1');
  if (typeof doc.disposition !== 'string' || !DISPOSITIONS.has(doc.disposition)) {
    invalid('disposition', 'disposition is reply, no_reply, or missing_case');
  }
  if (!Array.isArray(doc.replies)) invalid('replies', 'replies is an array');
  const disposition = doc.disposition as ProgramBody['disposition'];
  if (disposition === 'reply' ? doc.replies.length !== 1 : doc.replies.length !== 0) {
    invalid('replies', 'disposition reply carries exactly one reply and the other dispositions carry none');
  }
  return {
    disposition,
    replies: disposition === 'reply' ? [validateReply(doc.replies[0], envelope, work)] : [],
    observations: validateObservations(doc.observations ?? []),
    timings: validateTimings(doc.timings ?? [])
  };
}

type ProgramSession = {
  kind: 'program';
  entrypoint: string;
  work: string;
  timeoutMs: number;
  declaration: ProgramDeclaration;
  sandbox: Sandbox;
  active: Set<ChildProcess>;
  lastSpawn: { command: string; args: string[] } | null;
  stop(): Promise<unknown>;
  exit: Promise<{ code: number | null; signal: string | null }>;
};

type ProgramDeclaration = {
  harness?: { entrypoint?: unknown; secret_refs?: unknown };
  secrets?: { name?: string; path?: string }[];
  channels?: { transport?: { netrc_ref?: unknown; bot_token_ref?: unknown } }[];
  limits?: { max_turn_ms?: unknown };
  teaching?: { enabled?: unknown };
  records?: { enabled?: unknown };
  tool_servers?: { name?: string; kind?: string; required?: boolean }[];
  provider?: { api_key_via?: string; api_key_ref?: unknown };
};

type Sandbox = { launcher: string[]; storeRoots: string[]; protectedRoots: string[]; secretsDir: string };
type SandboxGate = { file: string; root: string };
const SECRET_REF_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const SECRET_ENV_PREFIX = 'CARBON_SECRET_';

export function secretEnvName(ref: string) {
  return `${SECRET_ENV_PREFIX}${ref.toUpperCase()}`;
}

function sandboxRefused(subject: string, problem: string): never {
  refused('PROGRAM_SANDBOX_UNAVAILABLE', subject, problem,
    'a program turn runs only inside bwrap with the HC-14 deny paths; fix the box (bootstrap.sh) and restart, there is no unsandboxed run');
}

function denyPaths(gate: SandboxGate) {
  let body: string;
  try {
    body = fs.readFileSync(gate.file, 'utf8');
  } catch {
    return sandboxRefused(gate.file, 'the HC-14 deny file cannot be read, so the program child has no deny list to run under');
  }
  const listed = body.match(/^deny_read = \[(.*)\]$/m)?.[1];
  if (listed === undefined) sandboxRefused(gate.file, 'the HC-14 deny file has no deny_read list');
  const paths = [...listed.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (paths.length === 0 || paths.some((one) => !path.isAbsolute(one))) {
    sandboxRefused(gate.file, 'the HC-14 deny file deny_read is empty or names a relative path');
  }
  return paths;
}

function launcherArgv() {
  let setpriv = true;
  try { execFileSync('sh', ['-c', 'command -v setpriv'], { stdio: 'ignore' }); } catch { setpriv = false; }
  return setpriv ? ['setpriv', '--no-new-privs', 'bwrap'] : ['bwrap'];
}

// The sandbox this harness refuses to run without. The probe is the shape the
// child runs in, so a box where bwrap answers --version and cannot start fails here.
export function buildSandbox(options: { gate?: SandboxGate; storeDir?: string; work: string; checkout: string }): Sandbox {
  if (!options.gate) sandboxRefused('sandboxDeny', 'no HC-14 deny gate was passed to the program harness');
  const root = path.resolve(options.gate.root);
  const storeRoots = [path.resolve(options.storeDir ?? path.join(root, 'store')), path.join(root, 'store')];
  const protectedRoots = [...new Set([
    ...denyPaths(options.gate), path.join(root, 'codex-home'), path.join(root, 'secrets'), ...storeRoots
  ].map((one) => path.resolve(one)))];
  for (const own of [options.work, options.checkout].map((one) => path.resolve(one))) {
    if (protectedRoots.some((one) => contained(one, own))) {
      sandboxRefused(own, 'the work directory or checkout is inside a path the deny list hides, so the child could not run');
    }
  }
  const launcher = launcherArgv();
  try {
    execFileSync(launcher[0], [...launcher.slice(1), '--die-with-parent', '--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc', '/bin/true'],
      { stdio: 'ignore', timeout: 30000 });
  } catch {
    sandboxRefused('bwrap', 'bwrap is absent or the sandbox does not start on this box');
  }
  return { launcher, storeRoots, protectedRoots, secretsDir: path.join(root, 'secrets') };
}

function existingMasks(sandbox: Sandbox) {
  return sandbox.protectedRoots.filter((one) => fs.existsSync(one));
}

function maskArgs(masks: string[]) {
  return masks.flatMap((mask) => (fs.statSync(mask).isDirectory() ? ['--tmpfs', mask] : ['--ro-bind', '/dev/null', mask]));
}

// Only the release's own attachment files come back through the hidden store.
function attachmentArgs(sandbox: Sandbox, masks: string[], envelope: unknown) {
  const messages = (envelope as { messages?: { attachments?: { path?: unknown }[] }[] })?.messages ?? [];
  const args: string[] = [];
  const seen = new Set<string>();
  for (const attachment of messages.flatMap((message) => message.attachments ?? [])) {
    const given = attachment.path;
    if (typeof given !== 'string' || !path.isAbsolute(given) || seen.has(given)) continue;
    seen.add(given);
    let real: string;
    try {
      real = fs.realpathSync(given);
      if (!fs.statSync(real).isFile()) continue;
    } catch { continue; }
    if (real !== path.resolve(given) || !sandbox.storeRoots.some((one) => contained(one, real))) continue;
    if (!masks.some((mask) => contained(mask, real))) continue;
    args.push('--ro-bind', real, real);
  }
  return args;
}

export function sandboxedSpawn(sandbox: Sandbox, command: string, args: string[], envelope: unknown) {
  const masks = existingMasks(sandbox);
  return {
    command: sandbox.launcher[0],
    args: [...sandbox.launcher.slice(1), '--die-with-parent', '--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc',
      ...maskArgs(masks), ...attachmentArgs(sandbox, masks, envelope), command, ...args]
  };
}

// Read here, as the agent user, at turn time. The values go to the child's
// environment only; they are never in argv, the envelope, a log or a fault.
const BACKUP_SECRET_FILE_NAMES = ['r2-backup-box.json', 'restic-password'];

// Secrets another consumer holds are never handed to a network-enabled child.
function otherConsumerSecretNames(declaration: ProgramDeclaration) {
  const names = new Set<unknown>();
  for (const channel of declaration.channels ?? []) {
    names.add(channel?.transport?.netrc_ref);
    names.add(channel?.transport?.bot_token_ref);
  }
  names.add(declaration.provider?.api_key_ref);
  for (const secret of declaration.secrets ?? []) {
    if (typeof secret.path === 'string' && BACKUP_SECRET_FILE_NAMES.includes(path.basename(secret.path))) names.add(secret.name);
  }
  names.delete(undefined);
  const secrets = (declaration.secrets ?? []);
  const heldPaths = new Set(secrets.flatMap((s) => names.has(s.name) && typeof s.path === 'string' ? [path.normalize(s.path)] : []));
  for (const secret of secrets) {
    if (typeof secret.path === 'string' && heldPaths.has(path.normalize(secret.path))) names.add(secret.name);
  }
  return names;
}

function readSecretFile(file: string, ref: string) {
  let value: string;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('symlink');
    value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    refused('PROGRAM_SECRET_UNREADABLE', `harness.secret_refs.${ref}`,
      'the secret file cannot be read by the agent user as a regular file',
      'place the secret with carbon-apply secret place; program secrets are agent-owned');
  }
  if (value.length === 0) {
    refused('PROGRAM_SECRET_UNREADABLE', `harness.secret_refs.${ref}`, 'the secret file is empty', 'place the secret');
  }
  return value;
}

function loadSecrets(declaration: ProgramDeclaration, secretsDir: string) {
  const refs = declaration.harness?.secret_refs;
  const env: Record<string, string> = {};
  const values: string[] = [];
  if (refs === undefined) return { env, values };
  if (!Array.isArray(refs)) refused('PROGRAM_SECRET_REFUSED', 'harness.secret_refs', 'secret_refs is a list of declared secret names', 'list secret names');
  const held = otherConsumerSecretNames(declaration);
  for (const ref of refs) {
    if (held.has(ref)) {
      refused('PROGRAM_SECRET_CHANNEL_REFUSED', `harness.secret_refs.${String(ref)}`,
        'a channel transport, provider or backup secret is never delivered to the program child, which has network access',
        'give the program its own secret');
    }
    const secret = (declaration.secrets ?? []).find((one) => one.name === ref);
    if (typeof ref !== 'string' || !SECRET_REF_PATTERN.test(ref) || !secret || typeof secret.path !== 'string' || !path.isAbsolute(secret.path)) {
      refused('PROGRAM_SECRET_REFUSED', `harness.secret_refs.${String(ref)}`,
        'a program secret ref is a lowercase name of a secret the declaration lists with an absolute path',
        'declare the secret under secrets and name it in harness.secret_refs');
    }
    if (!contained(secretsDir, path.resolve(secret.path)) || path.resolve(secret.path) === secretsDir) {
      refused('PROGRAM_SECRET_REFUSED', `harness.secret_refs.${ref}`,
        'a program secret lives inside the agent secrets directory',
        'declare the secret at <agentDir>/secrets/<file>');
    }
    const value = readSecretFile(secret.path, ref);
    env[secretEnvName(ref)] = value;
    values.push(value);
  }
  return { env, values };
}

export function redactSecrets(text: string, values: string[]) {
  let out = text;
  for (const value of values) {
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) out = out.split(form).join('[redacted]');
  }
  return out;
}

function killGroup(child: ChildProcess) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function assertTimeout(timeoutMs: unknown, subject: string) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    refused('PROGRAM_TURN_TIMEOUT_ABSENT', subject,
      'a program turn needs limits.max_turn_ms of at least 1000 and does not invent a default',
      'set limits.max_turn_ms on the declaration');
  }
}

function runHandler(session: ProgramSession, envelope: unknown, timeoutMs: number) {
  assertTimeout(timeoutMs, 'turn.timeoutMs');
  const secrets = loadSecrets(session.declaration, session.sandbox.secretsDir);
  const spawned = sandboxedSpawn(session.sandbox, process.execPath, [session.entrypoint], envelope);
  session.lastSpawn = { command: spawned.command, args: [...spawned.args] };
  const clean = (text: string) => redactSecrets(text, secrets.values);
  return new Promise<ProgramBody>((resolve, reject) => {
    const child = spawn(spawned.command, spawned.args, { cwd: session.work, env: childEnv(secrets.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    session.active.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stderrCut = false;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      session.active.delete(child);
    };
    const fail = (error: ProgramFault) => {
      if (settled) return;
      finish();
      reject(error);
    };
    const timer = setTimeout(() => fail(new ProgramFault(fault('PROGRAM_TURN_TIMED_OUT', session.entrypoint,
      `the program handler exceeded ${timeoutMs} ms and was killed`,
      'make the handler finish within limits.max_turn_ms, or raise that limit'))), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > OUTPUT_CAP) {
        fail(new ProgramFault(fault('PROGRAM_OUTPUT_TOO_LARGE', session.entrypoint,
          `the handler wrote more than ${OUTPUT_CAP} bytes on stdout`,
          'write one result document and nothing else')));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const joined = Buffer.concat([stderr, chunk]);
      stderrCut = stderrCut || joined.length > STDERR_WINDOW;
      stderr = joined.subarray(-STDERR_WINDOW);
    });
    child.stdin.on('error', () => {
      // The handler may exit before the document is consumed. The close path reports that exit.
    });
    child.on('error', (error) => fail(new ProgramFault(fault('PROGRAM_HANDLER_EXITED', session.entrypoint,
      clean(error.message), 'the entrypoint must be runnable by node'))));
    child.on('close', (code) => {
      if (settled) return;
      finish();
      if (code !== 0) {
        // A window cut may leave a secret's tail at the front, so a cut buffer loses its first longest-secret bytes.
        const drop = stderrCut ? Math.max(0, ...secrets.values.map((value) => Buffer.byteLength(value))) : 0;
        const tail = clean(stderr.subarray(drop).toString('utf8')).slice(-STDERR_TAIL);
        reject(new ProgramFault(fault('PROGRAM_HANDLER_EXITED', session.entrypoint,
          `the handler exited ${code}${tail ? `: ${tail}` : ''}`,
          'fix the entrypoint; a program turn does not fall back to Codex')));
        return;
      }
      try {
        const text = stdout.toString('utf8');
        if (clean(text) !== text) invalid('stdout', 'the handler result carries a delivered secret value');
        resolve(parseProgramResult(text, envelope as { conversation_id?: unknown; release_id?: unknown }, session.work));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

export async function connect(options: {
  checkout?: string; work?: string; declaration?: ProgramDeclaration;
  binary?: string; codexHome?: string; sandboxDeny?: SandboxGate; storeDir?: string; onEvent?: (event: unknown) => unknown; onStderr?: () => void;
}) {
  const declaration = options.declaration ?? {};
  assertTimeout(declaration.limits?.max_turn_ms, 'limits.max_turn_ms');
  const entrypoint = resolveEntrypoint(options.checkout, declaration.harness?.entrypoint);
  const work = path.resolve(String(options.work ?? ''));
  const sandbox = buildSandbox({ gate: options.sandboxDeny, storeDir: options.storeDir, work, checkout: String(options.checkout) });
  let resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => {};
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
  const session: ProgramSession = {
    kind: 'program',
    entrypoint,
    work,
    timeoutMs: declaration.limits?.max_turn_ms as number,
    declaration,
    sandbox,
    active: new Set(),
    lastSpawn: null,
    stop() {
      for (const child of session.active) killGroup(child);
      resolveExit({ code: 0, signal: null });
      return Promise.resolve();
    },
    exit
  };
  return session;
}

export function openThread(_session: ProgramSession, opening: { unitId: string }) {
  return Promise.resolve({ thread_id: `program:${opening.unitId}` });
}

export async function resumeThread(_session: ProgramSession, opening: { unitId: string; threadId: string }) {
  const expected = `program:${opening.unitId}`;
  if (opening.threadId !== expected) {
    refused('PROGRAM_THREAD_IDENTITY', opening.threadId,
      `this unit's program thread is ${expected} and the store holds a different id`,
      'keep the thread id the program harness opened; do not substitute a Codex thread');
  }
  return { thread_id: opening.threadId };
}

export async function turn(session: ProgramSession, params: {
  threadId: string; input: unknown; clientUserMessageId: string; timeoutMs?: number;
  onStarted?: (evidence: { threadId: string; turnId: string }) => void;
}) {
  if (typeof params.input === 'string' || Array.isArray(params.input)) {
    refused('PROGRAM_INPUT_REFUSED', params.threadId,
      'a program turn takes the release envelope and refuses a rendered prompt',
      'pass the carbon.program-release.v1 object built from the store');
  }
  const timeoutMs = params.timeoutMs ?? session.timeoutMs;
  const turnId = `program:${params.clientUserMessageId}`;
  params.onStarted?.({ threadId: params.threadId, turnId });
  const program = await runHandler(session, params.input, timeoutMs);
  return {
    thread_id: params.threadId,
    turn_id: turnId,
    status: 'completed',
    // The turn contract's completed_at is Unix seconds, as Codex reports it and as
    // lib/runner-harness-result.ts reads it; milliseconds read back as year 58768 (PA-241).
    completed_at: Math.floor(Date.now() / 1000),
    agent_message: null,
    token_usage: null,
    error: null,
    items: [],
    program
  };
}

const REPLY_NAME = 'carbon-reply';
const TEACH_NAME = 'carbon-teach';
const RECORDS_NAME = 'carbon-records';

export function listToolServerStatus(session: ProgramSession) {
  const declaration = session.declaration ?? {};
  const statuses: { name: string; runtimeStatus: string | null }[] = [{ name: REPLY_NAME, runtimeStatus: 'connected' }];
  if (declaration.teaching?.enabled === true) statuses.push({ name: TEACH_NAME, runtimeStatus: 'connected' });
  if (declaration.records?.enabled === true) statuses.push({ name: RECORDS_NAME, runtimeStatus: null });
  for (const server of declaration.tool_servers ?? []) {
    if (server.kind === 'provider_proxy' || server.name === declaration.provider?.api_key_via) continue;
    if (server.name) statuses.push({ name: server.name, runtimeStatus: null });
  }
  return Promise.resolve(statuses);
}

// carbon-records is named so the declared set matches, and it is not treated as
// connected. A required external server with no runtime state holds release.
export function holdsRelease(declaration: ProgramDeclaration, statuses: { name: string; runtimeStatus?: string | null }[]) {
  const required = new Set((declaration.tool_servers ?? [])
    .filter((server) => server.required && server.kind !== 'provider_proxy' && server.name)
    .map((server) => server.name as string));
  const byName = new Map(statuses.map((status) => [status.name, status]));
  const faults = [];
  for (const name of [...required].sort()) {
    const status = byName.get(name);
    if (!status || (status.runtimeStatus ?? null) !== 'connected') {
      faults.push(fault('TOOL_SERVER_STATE_UNAVAILABLE', `tool_servers.${name}`,
        'a program harness does not connect declared MCP servers, so a required one holds release',
        'drop required, or run this agent on the Codex harness that lists the server connected'));
    }
  }
  return faults;
}

export function policyFor(mode: string | undefined) {
  return { type: 'program', mode: mode ?? null };
}
