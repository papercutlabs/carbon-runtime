import { fault, ToolFault } from './fault.ts';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const RECORDS_ACTION_URL = 'http://127.0.0.1:8733';
type ActionInput = { about_job: string; about_move: string; derived_job: string | null;
  derived_move: string | null; operation: string; source_id: string };
type Claimed = { kind: 'claimed'; job: string; step: string; action_id: string };
type Other = { kind: 'other' };

export function processGeneration(pid: number): string | null {
  try {
    const stat = `/proc/${pid}/stat`;
    if (fs.existsSync('/proc/self/stat')) {
      if (!fs.existsSync(stat)) {
        if (fs.existsSync(`/proc/${pid}`)) throw new ToolFault([fault('JOB_ACTION_OWNER_INSPECTION_FAILED', String(pid),
          'the process exists but its start time is unreadable', 'leave the claim pending until process inspection works')]);
        return null;
      }
      const line = fs.readFileSync(stat, 'utf8');
      const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (!fields[19]) throw new ToolFault([fault('JOB_ACTION_OWNER_INSPECTION_FAILED', String(pid),
        'the process stat has no start time', 'leave the claim pending until process inspection works')]);
      return `linux:${fields[19]}`;
    }
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    return started ? `ps:${started}` : null;
  } catch (error) {
    if (error instanceof ToolFault) throw error;
    if ((error as { status?: unknown }).status === 1) return null;
    throw new ToolFault([fault('JOB_ACTION_OWNER_INSPECTION_FAILED', String(pid),
      `the writer process generation could not be inspected: ${(error as Error).message}`,
      'leave the claim pending until process inspection works or an operator resolves it')]);
  }
}

function owner() {
  const generation = processGeneration(process.pid);
  if (!generation) throw new ToolFault([fault('JOB_ACTION_OWNER_UNKNOWN', String(process.pid),
    'the tool cannot read its own process generation', 'restore process inspection before acting')]);
  return { pid: process.pid, generation };
}

async function post(route: string, body: unknown, baseUrl: string, doFetch: typeof fetch): Promise<any> {
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    throw new ToolFault([fault('RECORDS_ACTION_UNAVAILABLE', baseUrl,
      `the records action service did not answer: ${(error as Error).message}`,
      'do not perform the external effect; restore the records service and try the action again')]);
  }
  const result = await response.json() as { faults?: unknown[]; [key: string]: unknown };
  if (!response.ok) throw new ToolFault(Array.isArray(result.faults) ? result.faults : [fault(
    'RECORDS_ACTION_REFUSED', route, 'the records action service refused the call',
    'read the job and correct the move before an external effect')]);
  return result;
}

// The client tool supplies derived_job and derived_move from its own target and
// operation map. The model's about_* arguments are compared with that result;
// they do not select which job or move the tool checks.
export async function beginMappedAction(input: ActionInput, {
  baseUrl = RECORDS_ACTION_URL, doFetch = fetch
}: { baseUrl?: string; doFetch?: typeof fetch } = {}): Promise<Claimed | Other> {
  if (input.derived_move === null) {
    if (input.about_move !== 'other' || (input.derived_job && input.about_job !== input.derived_job)) {
      throw new ToolFault([fault('JOB_ACTION_CONTEXT_MISMATCH', input.operation,
        'the supplied job or move contradicts the operation this tool performs',
        'pass the job bound to the target and about_move other for an operation with no SOP move')]);
    }
    const classified = await post('/classify', { job: input.derived_job,
      operation: input.operation }, baseUrl, doFetch);
    if (classified.kind !== 'other') {
      throw new ToolFault([fault('JOB_ACTION_CONTEXT_MISMATCH', input.operation,
        `the installed SOP maps this operation to ${JSON.stringify(classified.steps)}; about_move other cannot bypass it`,
        'use the mapped SOP move in this client tool before the external effect')]);
    }
    return { kind: 'other' };
  }
  if (!input.derived_job || input.about_job !== input.derived_job || input.about_move !== input.derived_move) {
    throw new ToolFault([fault('JOB_ACTION_CONTEXT_MISMATCH', input.operation,
      `the operation maps to ${input.derived_move} on ${input.derived_job ?? 'no job'}, so about_move other cannot bypass it`,
      'pass the exact job and SOP move this client tool derives from the target')]);
  }
  const claim = await post('/begin', { job: input.derived_job, step: input.derived_move,
    operation: input.operation, source_id: input.source_id, owner: owner() }, baseUrl, doFetch);
  return { kind: 'claimed', job: input.derived_job, step: input.derived_move, action_id: claim.action_id };
}

export async function beginBoundAction(input: { unit: string; operation: string;
  about_job: string; about_move: string; source_id: string }, {
  baseUrl = RECORDS_ACTION_URL, doFetch = fetch
}: { baseUrl?: string; doFetch?: typeof fetch } = {}): Promise<Claimed | Other> {
  const result = await post('/bound', { ...input, owner: owner() }, baseUrl, doFetch);
  return result.kind === 'other' ? { kind: 'other' }
    : { kind: 'claimed', job: result.job, step: result.step, action_id: result.action_id };
}

export async function finishMappedAction(claim: Claimed, sourceId: string, {
  baseUrl = RECORDS_ACTION_URL, doFetch = fetch
}: { baseUrl?: string; doFetch?: typeof fetch } = {}) {
  return post('/finish', { job: claim.job, step: claim.step,
    action_id: claim.action_id, source_id: sourceId }, baseUrl, doFetch);
}

// Only a client-system read that found no effect calls this. The records
// service checks the original claiming process generation before re-arming.
export async function reconcileAbsentAction(claim: Claimed, sourceId: string, {
  baseUrl = RECORDS_ACTION_URL, doFetch = fetch
}: { baseUrl?: string; doFetch?: typeof fetch } = {}) {
  return post('/reconcile-absent', { job: claim.job, step: claim.step,
    action_id: claim.action_id, source_id: sourceId }, baseUrl, doFetch);
}
