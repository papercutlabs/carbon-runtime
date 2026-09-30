import { refuse } from '../tools/lib/fault.ts';
import { recordsDb, oneStatement } from './db.ts';
import { positionViews, type Positions, type Sop } from './sop-definition.ts';

type JobRow = { job_id: string; sop: string; sop_version: string; unit_id: string;
  positions: Positions; since: Record<string, string>; pending: Record<string, unknown> };
const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const node = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_');
const label = (value: string) => JSON.stringify(value.replaceAll('\n', ' '));

export function renderDiagram(sop: Sop): string {
  const lines = [`# ${sop.sop} — SOP version ${sop.version}`, '', '```mermaid', 'flowchart LR'];
  for (const track of sop.tracks) {
    lines.push(`  subgraph ${node(track.id)}[${label(track.label)}]`);
    for (const position of track.positions) {
      lines.push(`    ${node(`${track.id}_${position.id}`)}[${label(position.label)}]`);
    }
    lines.push('  end');
  }
  for (const event of sop.events) {
    for (const move of event.moves) {
      for (const from of move.from) {
        lines.push(`  ${node(`${move.track}_${from}`)} -->|${cell(event.id)}| ${node(`${move.track}_${move.to}`)}`);
      }
    }
  }
  lines.push('```', '', '| Track | Position | Label | Meaning |', '| --- | --- | --- | --- |');
  for (const track of sop.tracks) for (const position of track.positions) {
    lines.push(`| ${cell(track.id)} | ${cell(position.id)} | ${cell(position.label)} | ${cell(position.means)} |`);
  }
  return lines.join('\n') + '\n';
}

export function renderCard(job: JobRow, sop: Sop): string {
  const current = positionViews(sop, job.positions, job.since);
  const lines = [`# Job ${job.job_id}`, '', `SOP: ${sop.sop}@${sop.version}`, `Unit: ${cell(job.unit_id)}`, '',
    '| Track | Position | Label | Meaning |', '| --- | --- | --- | --- |'];
  for (const view of current) {
    lines.push(`| ${cell(view.track)} | ${cell(view.position)} | ${cell(view.label)} | ${cell(view.means)} |`);
  }
  lines.push('', '## Next work');
  for (const view of current) lines.push(`${view.track}: ${view.do_here}`);
  lines.push('', '## Waits');
  const waits = current.filter((view) => view.waiting_on !== 'none' && !view.terminal);
  if (waits.length === 0) lines.push('None.');
  for (const view of waits) {
    lines.push(`${view.track}: waiting on ${view.waiting_on} since ${view.since ?? 'unknown'}`
      + `${view.on_deadline ? `; chase with ${view.on_deadline}` : ''}`);
  }
  if (Object.keys(job.pending).length > 0) lines.push('', `Pending actions: ${Object.keys(job.pending).join(', ')}`);
  return lines.join('\n') + '\n';
}

export function viewParity(job: JobRow, sop: Sop) {
  const diagram = renderDiagram(sop);
  const card = renderCard(job, sop);
  const views = positionViews(sop, job.positions, job.since);
  const faults: string[] = [];
  for (const view of views) {
    const row = `| ${cell(view.track)} | ${cell(view.position)} | ${cell(view.label)} | ${cell(view.means)} |`;
    if (!diagram.includes(row)) faults.push(`diagram misses ${view.track}.${view.position}`);
    if (!card.includes(row)) faults.push(`card misses ${view.track}.${view.position}`);
    if (view.waiting_on !== 'none' && !view.terminal && !card.includes(`waiting on ${view.waiting_on} since ${view.since ?? 'unknown'}`)) {
      faults.push(`card misses ${view.track} wait`);
    }
  }
  return { ok: faults.length === 0, faults, positions_checked: views.length };
}

export async function installedSop(database: string, sop: string, socketDir?: string): Promise<Sop> {
  const db = recordsDb(database, 'carbon_read', 1, socketDir);
  try {
    const rows = await db`SELECT definition FROM carbon.sop_definitions
      WHERE sop = ${sop} ORDER BY installed_at DESC, version DESC LIMIT 1`;
    if (rows.length === 0) refuse('SOP_NOT_INSTALLED', sop,
      'this database has no installed version of that SOP', 'install the client records definition first');
    return rows[0].definition as Sop;
  } finally { await db.end({ timeout: 2 }); }
}

export async function installedJob(database: string, job: string, socketDir?: string): Promise<{ job: JobRow; sop: Sop }> {
  if (!/^[0-9a-f-]{36}$/i.test(job)) refuse('JOB_ID_INVALID', job,
    'card needs the UUID of one job', 'pass the id returned by job_open or job_find');
  const db = recordsDb(database, 'carbon_read', 1, socketDir);
  try {
    const names = await db`SELECT DISTINCT sop FROM carbon.sop_definitions ORDER BY sop`;
    for (const candidate of names) {
      if (typeof candidate.sop !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(candidate.sop)) continue;
      const table = `jobs_${candidate.sop.replaceAll('-', '_')}`;
      const rows = await db.unsafe(`SELECT * FROM public."${table}" WHERE job_id = $1`, [job], oneStatement);
      if (rows.length === 0) continue;
      const found = rows[0] as unknown as JobRow;
      const version = await db`SELECT definition FROM carbon.sop_definitions
        WHERE sop = ${found.sop} AND version = ${found.sop_version}`;
      if (version.length === 0) refuse('SOP_VERSION_NOT_INSTALLED', `${found.sop}@${found.sop_version}`,
        'the job names a SOP version this database does not hold', 'restore its definition');
      return { job: found, sop: version[0].definition as Sop };
    }
    refuse('JOB_NOT_FOUND', job, 'no installed SOP table holds this job', 'read the job id from job_find');
  } finally { await db.end({ timeout: 2 }); }
}
