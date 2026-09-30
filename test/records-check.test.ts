import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRecords } from '../records/check.ts';

const SOP = {
  sop: 'dispatch', version: '1',
  collected_channels: { agent_action: 'receipt', external_read: 'client system' },
  tracks: [{ id: 'work', label: 'Work', initial: 'new', positions: [
    { id: 'new', label: 'New', means: 'Unstarted', do_here: 'Send request', waiting_on: 'agent', terminal: false },
    { id: 'sent', label: 'Sent', means: 'Request sent', do_here: 'Wait for reply', waiting_on: 'client', terminal: false,
      deadline: { kind: 'working_hours', n: 2 }, on_deadline: 'chase' }
  ] }],
  events: [
    { id: 'send', kind: 'intent', mover: 'agent', observed_via: 'agent_action', action: 'send_request',
      moves: [{ track: 'work', from: ['new'], to: 'sent' }] },
    { id: 'chase', kind: 'observation', mover: 'timer', observed_via: 'external_read', moves: [] }
  ]
};

function fixture(sql = 'CREATE TABLE dispatch_notes (id bigint primary key, note text);', sop: unknown = SOP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-records-check-'));
  fs.mkdirSync(path.join(dir, 'records', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'records', 'sops'));
  fs.writeFileSync(path.join(dir, 'records', 'migrations', '0001-notes.sql'), sql);
  fs.writeFileSync(path.join(dir, 'records', 'sops', 'dispatch.json'), JSON.stringify(sop));
  fs.writeFileSync(path.join(dir, 'records', 'README.md'),
    'dispatch_notes keeps notes for each request. The agent writes it and reads it.\n'
    + 'jobs_dispatch records a dispatch job. The job tools write and read it.\n'
    + 'job_events_dispatch keeps its history. The job tools write and read it.\n');
  return dir;
}

test('records check accepts a described SOP and extra table', () => {
  const repo = fixture();
  try {
    const result = checkRecords(repo);
    assert.deepEqual(result.faults, []);
    assert.deepEqual(result.records?.tables, ['dispatch_notes', 'job_events_dispatch', 'jobs_dispatch']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('records check refuses destructive SQL, protected schema, RLS and duplicate migration numbers', () => {
  const repo = fixture(`CREATE TABLE dispatch_notes (id bigint);\nDELETE FROM dispatch_notes;\nALTER TABLE dispatch_notes ENABLE ROW LEVEL SECURITY;\nUPDATE carbon.changes SET login = 'other';`);
  try {
    fs.writeFileSync(path.join(repo, 'records', 'migrations', '0001-again.sql'), 'SELECT 1;');
    const faults = checkRecords(repo).faults.join('\n');
    for (const fragment of ['duplicate migration number', 'DROP, TRUNCATE and DELETE', 'carbon schema', 'row-level security']) {
      assert.match(faults, new RegExp(fragment));
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('records check refuses destructive SQL hidden in an executable DO block', () => {
  const repo = fixture("CREATE TABLE dispatch_notes (id bigint); DO $$BEGIN EXECUTE 'TRUNCATE dispatch_notes'; END$$;");
  try { assert.match(checkRecords(repo).faults.join('\n'), /executable DO, CALL and routine definitions are forbidden/); }
  finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('records check refuses a DELETE inside a data-changing CTE', () => {
  const repo = fixture('CREATE TABLE dispatch_notes (id bigint); WITH gone AS (DELETE FROM dispatch_notes RETURNING id) SELECT count(*) FROM gone;');
  try { assert.match(checkRecords(repo).faults.join('\n'), /DROP, TRUNCATE and DELETE are forbidden/); }
  finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('records check refuses an uncollected step and a deadline without a chase', () => {
  const changed = structuredClone(SOP);
  changed.events[0].observed_via = 'unknown';
  delete (changed.tracks[0].positions[1] as { on_deadline?: string }).on_deadline;
  const repo = fixture(undefined, changed);
  try {
    const faults = checkRecords(repo).faults.join('\n');
    assert.match(faults, /not a collected channel/);
    assert.match(faults, /intent needs the agent_action channel/);
    assert.match(faults, /deadline has no chasing step/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('records check refuses a table missing from README', () => {
  const repo = fixture('CREATE TABLE unlisted (id bigint);');
  try { assert.match(checkRecords(repo).faults.join('\n'), /README.md does not name table unlisted/); }
  finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
