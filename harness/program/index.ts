// A program harness runs one pinned entrypoint inside the installed checkout.
// Node is the process. There is no Codex binary and no fallback to one.
// The child receives one carbon.program-release.v1 document on stdin and
// writes one carbon.program-result.v1 document on stdout. Credentials are not
// loaded here; the child inherits only PATH, HOME, LANG and TMPDIR.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fault } from '../../lib/faults.ts';

export const HARNESS_KIND = 'program';
export const PROGRAM_ENTRYPOINT_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|ts)$/;
export const OUTPUT_CAP = 1024 * 1024;
const STDERR_TAIL = 500;
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

function childEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
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
  if (item.attachments !== undefined) {
    if (!Array.isArray(item.attachments) || item.attachments.length > 100) invalid('replies[0].attachments', 'attachments is a list of at most 100 absolute work paths');
    for (const given of item.attachments) {
      if (typeof given !== 'string' || !path.isAbsolute(given) || !underWork(work, given)) {
        invalid('replies[0].attachments', 'each attachment is an absolute path inside the work directory');
      }
    }
    ready.attachments = item.attachments as string[];
  }
  if (item.about_job !== undefined) {
    if (typeof item.about_job !== 'string') invalid('replies[0].about_job', 'about_job is a string when the handler sends one');
    ready.about_job = item.about_job;
  }
  if (item.about_move !== undefined) {
    if (typeof item.about_move !== 'string') invalid('replies[0].about_move', 'about_move is a string when the handler sends one');
    ready.about_move = item.about_move;
  }
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
  lastSpawn: { command: string; args: string[] } | null;
  stop(): Promise<unknown>;
  exit: Promise<{ code: number | null; signal: string | null }>;
};

type ProgramDeclaration = {
  harness?: { entrypoint?: unknown };
  limits?: { max_turn_ms?: unknown };
  teaching?: { enabled?: unknown };
  records?: { enabled?: unknown };
  tool_servers?: { name?: string; kind?: string; required?: boolean }[];
  provider?: { api_key_via?: string };
};

function assertTimeout(timeoutMs: unknown, subject: string) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    refused('PROGRAM_TURN_TIMEOUT_ABSENT', subject,
      'a program turn needs limits.max_turn_ms of at least 1000 and does not invent a default',
      'set limits.max_turn_ms on the declaration');
  }
}

function runHandler(session: ProgramSession, envelope: unknown, timeoutMs: number) {
  assertTimeout(timeoutMs, 'turn.timeoutMs');
  const command = process.execPath;
  const args = [session.entrypoint];
  session.lastSpawn = { command, args: [...args] };
  return new Promise<ProgramBody>((resolve, reject) => {
    const child = spawn(command, args, { cwd: session.work, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const fail = (error: ProgramFault) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
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
      stderr = Buffer.concat([stderr, chunk]).subarray(-4096);
    });
    child.stdin.on('error', () => {
      // The handler may exit before the document is consumed. The close path reports that exit.
    });
    child.on('error', (error) => fail(new ProgramFault(fault('PROGRAM_HANDLER_EXITED', session.entrypoint,
      error.message, 'the entrypoint must be runnable by node'))));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.toString('utf8').slice(-STDERR_TAIL);
        reject(new ProgramFault(fault('PROGRAM_HANDLER_EXITED', session.entrypoint,
          `the handler exited ${code}${tail ? `: ${tail}` : ''}`,
          'fix the entrypoint; a program turn does not fall back to Codex')));
        return;
      }
      try {
        resolve(parseProgramResult(stdout.toString('utf8'), envelope as { conversation_id?: unknown; release_id?: unknown }, session.work));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

export async function connect(options: {
  checkout?: string; work?: string; declaration?: ProgramDeclaration;
  binary?: string; codexHome?: string; onEvent?: (event: unknown) => unknown; onStderr?: () => void;
}) {
  const declaration = options.declaration ?? {};
  assertTimeout(declaration.limits?.max_turn_ms, 'limits.max_turn_ms');
  const entrypoint = resolveEntrypoint(options.checkout, declaration.harness?.entrypoint);
  let resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => {};
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
  const session: ProgramSession = {
    kind: 'program',
    entrypoint,
    work: path.resolve(String(options.work ?? '')),
    timeoutMs: declaration.limits?.max_turn_ms as number,
    declaration,
    lastSpawn: null,
    stop() {
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
    completed_at: Date.now(),
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
