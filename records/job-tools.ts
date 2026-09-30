import crypto from 'node:crypto';
import { refuse } from '../tools/lib/fault.ts';
import { recordsDb, oneStatement } from './db.ts';
import { allowedIntents, applyObservation, initialPositions, legality, positionViews, stepOf,
  type Positions, type Sop } from './sop-definition.ts';

type VerifyObservation = (sourceId: string, channel: string, jobId: string) => Promise<boolean>;
type Pending = Record<string, { step: string; action_id: string; source_id: string; state: 'reserved' | 'claimed'; since: string }>;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,510}[^\s\x00-\x1f\x7f]$|^[^\s\x00-\x1f\x7f]$/;
const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) refuse('RECORDS_IDENTIFIER_INVALID', name,
    `unsafe SQL identifier ${name}`, 'use the generated table name from the installed SOP');
  return `"${name}"`;
};
const tables = (sop: string) => {
  if (!/^[a-z][a-z0-9_-]*$/.test(sop)) refuse('SOP_ID_INVALID', sop,
    'the SOP id is not a declared name', 'use the id from records/sops/<sop>.json');
  const suffix = sop.replaceAll('-', '_');
  return { jobs: `jobs_${suffix}`, events: `job_events_${suffix}` };
};
function sourceId(value: unknown, field = 'source_id'): string {
  if (typeof value !== 'string' || !SOURCE_ID.test(value) || value.trim() !== value) {
    refuse(field === 'source_message_id' ? 'JOB_OPEN_CAUSE_INVALID' : 'JOB_SOURCE_ID_INVALID', field,
      'the cause id must be one nonempty printable identifier of at most 512 characters',
      'pass the current message id or stable timer event id exactly as the turn received it');
  }
  return value as string;
}
function jobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) refuse('JOB_ID_INVALID', String(value),
    'job must be the UUID returned by job_open or job_find', 'read the job id from the record');
  return value as string;
}

export function createJobTools(database: string, verifyObservation: VerifyObservation,
  socketDir?: string) {
  // shape: justified the five tool handlers share one owner-role connection and the same locked job-read helpers; splitting the closure would duplicate that authority path
  const db = recordsDb(database, 'carbon_owner', 4, socketDir);
  async function latestSop(tx: any, sop: string): Promise<Sop> {
    const rows = await tx`SELECT definition FROM carbon.sop_definitions
      WHERE sop = ${sop} ORDER BY installed_at DESC, version DESC LIMIT 1`;
    if (!rows.length) refuse('SOP_NOT_INSTALLED', sop,
      'this records service holds no installed version of that SOP',
      'use a SOP declared in records/sops/ and installed on this box');
    return rows[0].definition as Sop;
  }
  async function readJob(tx: any, id: string, lock = false) {
    const all = await tx`SELECT DISTINCT sop FROM carbon.sop_definitions ORDER BY sop`;
    for (const candidate of all) {
      const { jobs } = tables(candidate.sop);
      const rows = await tx.unsafe(`SELECT * FROM public.${identifier(jobs)} WHERE job_id = $1${lock ? ' FOR UPDATE' : ''}`,
        [id], oneStatement);
      if (rows.length) return rows[0];
    }
    refuse('JOB_NOT_FOUND', id, 'no installed SOP table holds this job', 'use job_find or open a job first');
  }
  async function definitionFor(tx: any, job: any): Promise<Sop> {
    const rows = await tx`SELECT definition FROM carbon.sop_definitions
      WHERE sop = ${job.sop} AND version = ${job.sop_version}`;
    if (!rows.length) refuse('SOP_VERSION_NOT_INSTALLED', `${job.sop}@${job.sop_version}`,
      'the job names a SOP version this database does not hold', 'restore the matching SOP definition');
    return rows[0].definition as Sop;
  }
  async function readView(tx: any, job: any) {
    const sop = await definitionFor(tx, job);
    const positions = job.positions as Positions;
    const views = positionViews(sop, positions, job.since);
    return { job: job.job_id, sop: job.sop, sop_version: job.sop_version,
      unit: job.unit_id, references: job.references, positions: views,
      waits: views.filter((view) => view.waiting_on !== 'none' && !view.terminal),
      pending: job.pending, allowed_now: allowedIntents(sop, positions) };
  }
  return {
    async close() { await db.end({ timeout: 2 }); },
    async job_open(sop: string, unit: string, references: string[], source_message_id: string) {
      const cause = sourceId(source_message_id, 'source_message_id');
      if (typeof unit !== 'string' || !unit.trim()) refuse('JOB_UNIT_INVALID', 'unit',
        'a job needs the conversation or work unit it belongs to', 'pass a nonempty unit id');
      if (!Array.isArray(references) || references.some((value) => typeof value !== 'string' || !value.trim())) {
        refuse('JOB_REFERENCES_INVALID', 'references',
          'references must be a list of nonempty client reference strings', 'pass [] or the known client references');
      }
      return db.begin(async (tx) => {
        const definition = await latestSop(tx, sop);
        const { jobs } = tables(sop);
        const positions = initialPositions(definition);
        const since = Object.fromEntries(Object.keys(positions).map((track) => [track, new Date().toISOString()]));
        await tx`SELECT set_config('carbon.source_message_id', ${cause}, true)`;
        const inserted = await tx.unsafe(`INSERT INTO public.${identifier(jobs)}
          (unit_id, "references", sop, sop_version, positions, since)
          VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb) RETURNING job_id`,
          [unit, tx.json(references), sop, definition.version,
            tx.json(positions), tx.json(since)], oneStatement);
        return readView(tx, { job_id: inserted[0].job_id, unit_id: unit, references,
          sop, sop_version: definition.version, positions, since, pending: {} });
      });
    },
    async job_find(reference: string) {
      if (typeof reference !== 'string' || !reference.trim()) refuse('JOB_REFERENCE_INVALID', 'reference',
        'a reference is one nonempty client identifier', 'pass the reference exactly as the client system names it');
      const all = await db`SELECT DISTINCT sop FROM carbon.sop_definitions ORDER BY sop`;
      const found = [];
      for (const candidate of all) {
        const { jobs } = tables(candidate.sop);
        const rows = await db.unsafe(`SELECT job_id, sop, sop_version, unit_id, "references" FROM public.${identifier(jobs)}
          WHERE "references" @> $1::jsonb`, [db.json([reference])], oneStatement);
        found.push(...rows);
      }
      return { reference, jobs: found };
    },
    async job_read(job: string) {
      const id = jobId(job);
      return readView(db, await readJob(db, id));
    },
    async job_check(job: string, step: string) {
      const id = jobId(job);
      const row = await readJob(db, id);
      const sop = await definitionFor(db, row);
      const event = stepOf(sop, step);
      const verdict = event.kind === 'intent' ? legality(event, row.positions) : { legal: true, why: [] };
      return { job: id, step, allowed: verdict.legal, why: verdict.why,
        allowed_now: allowedIntents(sop, row.positions) };
    },
    async job_record(job: string, step: string, kind: 'intent' | 'observation', source_id: string) {
      const id = jobId(job);
      const cause = sourceId(source_id);
      if (kind !== 'intent' && kind !== 'observation') refuse('JOB_KIND_INVALID', String(kind),
        'kind is intent or observation', 'choose the kind of the step being recorded');
      return db.begin(async (tx) => {
        const row = await readJob(tx, id, true);
        const sop = await definitionFor(tx, row);
        const event = stepOf(sop, step);
        const { jobs, events } = tables(row.sop);
        const duplicate = await tx.unsafe(`SELECT 1 FROM public.${identifier(events)}
          WHERE job_id = $1 AND event = $2 AND kind = $3 AND source_id = $4`,
          [id, step, kind, cause], oneStatement);
        if (duplicate.length) return { job: id, step, kind, status: 'already_recorded' };
        await tx`SELECT set_config('carbon.source_message_id', ${cause}, true)`;
        if (kind === 'intent') {
          if (event.kind !== 'intent') refuse('JOB_STEP_NOT_INTENT', step,
            'this SOP step is a collected observation, not an agent intent', 'record its source as an observation');
          const verdict = legality(event, row.positions);
          if (!verdict.legal) refuse('JOB_MOVE_REFUSED', step,
            `the SOP refuses this move: ${verdict.why.join('; ')}; allowed now: ${allowedIntents(sop, row.positions).join(', ') || 'none'}`,
            'read the job and use an allowed step, or take the client staff escalation route');
          const primary = event.moves[0]?.track ?? step;
          const pending = { ...(row.pending as Pending) };
          if (pending[primary]) refuse('JOB_ACTION_PENDING', step,
            'an action on this track is already pending; an earlier process may still act',
            'read the client system and reconcile the pending action before retrying');
          pending[primary] = { step, action_id: crypto.randomUUID(), source_id: cause,
            state: 'reserved', since: new Date().toISOString() };
          await tx.unsafe(`UPDATE public.${identifier(jobs)} SET pending = $1::jsonb WHERE job_id = $2`,
            [tx.json(pending), id], oneStatement);
          await tx.unsafe(`INSERT INTO public.${identifier(events)} (job_id, event, kind, source_id)
            VALUES ($1,$2,'intent',$3)`, [id, step, cause], oneStatement);
          return { job: id, step, kind, status: 'pending', pending: pending[primary] };
        }
        if (event.observed_via === 'agent_action') {
          const pending = Object.values(row.pending as Pending).find((item) => item.step === step);
          const trusted = pending && await tx`SELECT 1 FROM carbon.action_receipts
            WHERE action_id = ${pending.action_id} AND job_id = ${id}
              AND sop = ${row.sop} AND step = ${step} AND source_id = ${cause}`;
          if (!trusted || trusted.length === 0) refuse('JOB_ACTION_RECEIPT_ABSENT', step,
            'the agent supplied an action observation without a matching trusted tool receipt',
            'read the pending action and reconcile the client system through its action tool');
        } else if (!await verifyObservation(cause, event.observed_via, id)) {
          refuse('JOB_SOURCE_UNVERIFIED', cause,
            'this source is not a collected event from the SOP channel',
            'collect the client fact through its declared channel, then record that event id');
        }
        const applied = applyObservation(event, row.positions);
        const pending = { ...(row.pending as Pending) };
        const since = { ...(row.since as Record<string, string>) };
        for (const [track, position] of Object.entries(applied.positions)) {
          if (row.positions[track] !== position) { since[track] = new Date().toISOString(); delete pending[track]; }
        }
        await tx.unsafe(`UPDATE public.${identifier(jobs)}
          SET positions = $1::jsonb, pending = $2::jsonb, since = $3::jsonb WHERE job_id = $4`,
          [tx.json(applied.positions), tx.json(pending), tx.json(since), id], oneStatement);
        await tx.unsafe(`INSERT INTO public.${identifier(events)} (job_id, event, kind, source_id, off_model)
          VALUES ($1,$2,'observation',$3,$4)`, [id, step, cause, applied.offModel], oneStatement);
        return { job: id, step, kind, status: 'recorded', off_model: applied.offModel,
          positions: applied.positions };
      });
    }
  };
} // shape: justified the five handlers share one owner-role connection and locked job-read helpers instead of duplicating the authority path
