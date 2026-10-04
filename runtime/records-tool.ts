import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../tools/lib/mcp.ts';
import { readManifest } from '../tools/lib/manifest.ts';
import { renderHelp } from '../tools/lib/help.ts';
import { fault, refuse, ToolFault } from '../tools/lib/fault.ts';
import { readStatement, recordsDb, writeStatement } from '../records/db.ts';
import { createJobTools, type TurnContext } from '../records/job-tools.ts';
import { processGeneration } from '../tools/lib/action-check.ts';
import { serveActionHttp } from './records-action-http.ts';

export const RECORDS_SERVER_NAME = 'carbon-records';
const RECORDS_PORT = 8732;
const ACTION_PORT = 8733;
const MANIFEST_DIR = path.join(import.meta.dirname, 'records-tool');
const MANIFEST = readManifest(MANIFEST_DIR);
type VerifyObservation = (sourceId: string, channel: string, jobId: string) => Promise<boolean>;
type ServerOptions = {
  database: string; agentId: string; agentDir: string;
  verifyObservation: VerifyObservation; host?: string; port?: number; actionPort?: number; socketDir?: string;
  startupWaitMs?: number;
};
const STARTUP_WAIT_MS = 60_000;
const STARTUP_RETRY_MS = 1_000;

function databaseStarting(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET'
    || code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT' || code === '57P03';
}

async function waitForDatabase(database: string, socketDir: string | undefined, waitMs: number) {
  const deadline = performance.now() + waitMs;
  while (true) {
    const probe = recordsDb(database, 'carbon_owner', 1, socketDir);
    try { await probe`SELECT 1 FROM carbon.sop_definitions LIMIT 1`; return; }
    catch (error) {
      if (!databaseStarting(error)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) refuse('RECORDS_DATABASE_NOT_READY', database,
        'PostgreSQL did not become available before the records startup deadline',
        'systemd will retry this records unit after PostgreSQL is available');
      await new Promise((resolve) => setTimeout(resolve, Math.min(STARTUP_RETRY_MS, remaining)));
    } finally { await probe.end({ timeout: 2 }); }
  }
}

function cap(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    refuse('RECORDS_MAX_ROWS_INVALID', String(value),
      'max_rows must be an integer from 1 to 1000', 'choose a cap in that range');
  }
  return value as number;
}
function statement(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) refuse('RECORDS_SQL_EMPTY', 'sql',
    'one SQL statement is required', 'pass a read or write SQL statement');
  return value as string;
}

function liveTurnOwner(owner: TurnContext['owner'] | undefined): boolean {
  return !!owner && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.generation === 'string'
    && processGeneration(owner.pid) === owner.generation;
}

function validateTurnContext(context: TurnContext, others: TurnContext[]) {
  if (typeof context.releaseId !== 'string' || !context.releaseId.trim()
    || typeof context.unit !== 'string' || !context.unit.trim()
    || !Array.isArray(context.sourceIds) || context.sourceIds.length === 0
    || context.sourceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    refuse('JOB_TURN_CONTEXT_INVALID', String(context.releaseId),
      'the runtime supplied an incomplete work unit or cause', 'supply the captured turn context');
  }
  if (others.some((turn) => turn.releaseId === context.releaseId)) refuse('JOB_TURN_ACTIVE',
    context.releaseId, 'this release already has an active or waiting records context',
    'finish that release before starting it again');
  if (others.some((turn) => context.sourceIds.some((id) => turn.sourceIds.includes(id)))) {
    refuse('JOB_TURN_CONTEXT_DUPLICATE', context.releaseId,
      'one event id cannot belong to two active turns',
      'finish the first release before starting a second for that event');
  }
  if (!liveTurnOwner(context.owner)) {
    refuse('JOB_TURN_OWNER_INVALID', context.releaseId,
      'the runtime process generation does not match a live process',
      'start the turn from its supported runtime unit');
  }
}

function turnContexts() {
  let active: TurnContext | null = null;
  let accepting = true;
  let ownerInspectionFailed = false;
  type Answer = { status: 'active'; release_id: string };
  const waiting: { context: TurnContext; resolve: (answer: Answer) => void;
    reject: (error: unknown) => void; detach?: () => void }[] = [];
  const advance = () => {
    const next = waiting.shift();
    active = next?.context ?? null;
    if (next) { next.detach?.(); next.resolve({ status: 'active', release_id: next.context.releaseId }); }
  };
  const monitor = setInterval(() => {
    if (!active) return;
    try {
      const generation = processGeneration(active.owner.pid);
      ownerInspectionFailed = false;
      if (generation !== active.owner.generation) advance();
    } catch { ownerInspectionFailed = true; }
  }, 1000);
  monitor.unref();
  return {
    current: () => active,
    inspectionFailed: () => ownerInspectionFailed,
    start(context: TurnContext, signal?: AbortSignal): Promise<Answer> | Answer {
      if (!accepting) refuse('JOB_TURN_STOPPING', context.releaseId,
        'the records service is draining', 'retry the turn after the records service restarts');
      validateTurnContext(context, active
        ? [active, ...waiting.map((turn) => turn.context)]
        : waiting.map((turn) => turn.context));
      if (active) return new Promise<Answer>((resolve, reject) => {
        const next = { context, resolve, reject, detach: undefined as (() => void) | undefined };
        const cancelled = () => {
          const index = waiting.indexOf(next);
          if (index >= 0) waiting.splice(index, 1);
          reject(new ToolFault([fault('JOB_TURN_CANCELLED', context.releaseId,
            'the waiting runtime turn disconnected', 'start a new turn after the active one ends')]));
        };
        if (signal?.aborted) { cancelled(); return; }
        signal?.addEventListener('abort', cancelled, { once: true });
        next.detach = () => signal?.removeEventListener('abort', cancelled);
        waiting.push(next);
      });
      active = context;
      return { status: 'active', release_id: context.releaseId };
    },
    end(releaseId: string) {
      if (!active || active.releaseId !== releaseId) refuse('JOB_TURN_CONTEXT_MISMATCH', releaseId,
        'the active records turn has a different release id',
        'end the release that started this records context');
      advance();
      return { status: 'ended', release_id: releaseId };
    },
    drain() {
      accepting = false;
      clearInterval(monitor);
      for (const next of waiting.splice(0)) {
        next.detach?.();
        next.reject(new ToolFault([fault('JOB_TURN_STOPPING', next.context.releaseId,
          'the records service is draining',
          'retry the turn after the records service restarts')]));
      }
    }
  };
}

function createRecordsServer(database: string, verifyObservation: VerifyObservation, socketDir?: string) {
  const turn = turnContexts();
  const jobs = createJobTools(database, verifyObservation, socketDir, turn.current);
  const server = createServer({
    manifest: MANIFEST,
    handlers: {
      records_query: async (args) => {
        const max = cap(args.max_rows);
        const rows = await readStatement(database, statement(args.sql), socketDir);
        return { rows: rows.slice(0, max), count: Math.min(rows.length, max), truncated: rows.length > max };
      },
      records_write: async (args) => {
        const max = cap(args.max_rows);
        const changes = await writeStatement(database, statement(args.sql), args.source_message_id as string, max, socketDir);
        return { changes, count: changes.length };
      },
      job_open: (args) => jobs.job_open(args.sop as string, args.unit as string,
        args.references as string[], args.source_message_id as string),
      job_find: (args) => jobs.job_find(args.reference as string),
      job_read: (args) => jobs.job_read(args.job as string),
      job_check: (args) => jobs.job_check(args.job as string, args.step as string),
      job_record: (args) => jobs.job_record(args.job as string, args.step as string,
        args.kind as 'intent' | 'observation', args.source_id as string)
    }
  });
  return { server, jobs, turn };
}

function drainReceipt(file: string, invocationId: string | null, agentId: string) {
  const receipt = JSON.stringify({ schema: 'carbon.records-drain.v1', agent_id: agentId,
    invocation_id: invocationId, pid: process.pid, stopped_at: new Date().toISOString(),
    active_requests: 0, database_sessions_closed: true }) + '\n';
  const temp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, receipt); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function serveRecordsTool({ database, agentId, agentDir, verifyObservation,
  host = '127.0.0.1', port = RECORDS_PORT, actionPort = ACTION_PORT, socketDir,
  startupWaitMs = STARTUP_WAIT_MS }: ServerOptions) {
  if (database !== agentId.replaceAll('-', '_')) refuse('RECORDS_DATABASE_MISMATCH', database,
    'records database does not match agent id', 'start this tool with the installed agent database');
  await waitForDatabase(database, socketDir, startupWaitMs);
  const receiptFile = path.join(agentDir, 'tools-work', 'carbon-records-drain.json');
  fs.rmSync(receiptFile, { force: true });
  const { server, jobs, turn } = createRecordsServer(database, verifyObservation, socketDir);
  let status: 'ready' | 'draining' | 'stopped' = 'ready';
  const invocationId = process.env.INVOCATION_ID ?? null;
  const { server: http, url } = await server.serveHttp({ host, port,
    health: () => ({ schema: 'carbon.records-health.v1', status, agent_id: agentId,
      invocation_id: invocationId, turn_owner_inspection_failed: turn.inspectionFailed() }) });
  let actionHttp: Awaited<ReturnType<typeof serveActionHttp>>;
  try { actionHttp = await serveActionHttp({ ...jobs,
    action_turn_start: (context, signal) => turn.start(context, signal),
    action_turn_end: (releaseId) => turn.end(releaseId)
  }, actionPort); }
  catch (error) { await new Promise<void>((resolve) => http.close(() => resolve())); await jobs.close(); throw error; }
  let stopPromise: Promise<void> | null = null;
  function stop() {
    if (stopPromise) return stopPromise;
    status = 'draining';
    turn.drain();
    stopPromise = (async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
        actionHttp.close()
      ]);
      await jobs.close();
      status = 'stopped';
      drainReceipt(receiptFile, invocationId, agentId);
    })();
    return stopPromise;
  }
  return { url, actionPort: actionHttp.port, stop, health: () => ({
    status, agentId, invocationId, turnOwnerInspectionFailed: turn.inspectionFailed()
  }), http };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length > 2 && !process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.error('carbon-records is served by carbon-tool-server; run --help for its tools');
    process.exitCode = 1;
  } else {
    console.log(renderHelp(MANIFEST, { serverUsage: [
      'carbon-tool-server --agent-dir <dir> --instance <agent id>-carbon-records',
      'node runtime/records-tool.ts --help'
    ] }));
  }
}
