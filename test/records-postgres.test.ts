import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateRecords } from '../records/migrate.ts';
import { readStatement, recordsDb, oneStatement, writeStatement } from '../records/db.ts';

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

const PG17_BIN = fs.existsSync('/opt/homebrew/opt/postgresql@17/bin/pg_config')
  ? '/opt/homebrew/opt/postgresql@17/bin' : '/usr/lib/postgresql/17/bin';
const pg = (name: string) => path.join(PG17_BIN, name);

test('real PostgreSQL applies each migration once, protects generated tables and refuses two statements', async () => {
  const version = command(pg('pg_config'), ['--version']);
  assert.match(version, /^PostgreSQL 17\./, 'the integration test requires PostgreSQL 17');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-pg17-'));
  const data = path.join(tmp, 'data');
  const socket = path.join(tmp, 'socket');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(socket);
  fs.mkdirSync(path.join(repo, 'records', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'records', 'sops'));
  fs.writeFileSync(path.join(repo, 'records', 'README.md'),
    'notes tracks the message. The agent writes and reads it.\n'
    + 'jobs_demo stores each job. The job tools write and read it.\n'
    + 'job_events_demo stores steps. The job tools write and read it.\n');
  fs.writeFileSync(path.join(repo, 'records', 'migrations', '0001-notes.sql'),
    'CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);');
  const sop = { sop: 'demo', version: '1', collected_channels: { agent_action: 'receipt' },
    tracks: [{ id: 'work', label: 'Work', initial: 'open', positions: [
      { id: 'open', label: 'Open', means: 'Unsent', do_here: 'Send', waiting_on: 'agent', terminal: false },
      { id: 'sent', label: 'Sent', means: 'Sent', do_here: 'Wait', waiting_on: 'client', terminal: false }
    ] }],
    events: [{ id: 'send', kind: 'intent', mover: 'agent', observed_via: 'agent_action', action: 'send',
      moves: [{ track: 'work', from: ['open'], to: 'sent' }] }] };
  fs.writeFileSync(path.join(repo, 'records', 'sops', 'demo.json'), JSON.stringify(sop));
  command(pg('initdb'), ['-D', data, '--no-instructions', '--auth-local=trust', '--auth-host=reject']);
  let started = false;
  try {
    command(pg('pg_ctl'), ['-D', data, '-l', path.join(tmp, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=`, 'start']);
    started = true;
    const psql = (db: string, statement: string) => command(pg('psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-d', db, '-c', statement]);
    psql('postgres', 'CREATE ROLE carbon_owner LOGIN; CREATE ROLE carbon_read LOGIN; CREATE ROLE carbon_write LOGIN; CREATE ROLE carbon_backup LOGIN; GRANT pg_read_all_data TO carbon_backup;');
    psql('postgres', 'CREATE DATABASE carbon_test OWNER carbon_owner;');
    psql('carbon_test', 'CREATE SCHEMA carbon AUTHORIZATION carbon_owner; GRANT CONNECT ON DATABASE carbon_test TO carbon_read, carbon_write, carbon_backup;');
    const first = await migrateRecords(repo, 'carbon_test', 'test-release', socket);
    assert.deepEqual(first.applied, ['0001-notes.sql']);
    assert.deepEqual(first.installed, [{ sop: 'demo', version: '1' }]);
    const second = await migrateRecords(repo, 'carbon_test', 'test-release', socket);
    assert.equal(second.unchanged, true);
    const read = await readStatement('carbon_test', 'SELECT sop, sop_version FROM jobs_demo', socket);
    assert.deepEqual(read, []);
    const changes = await writeStatement('carbon_test', "INSERT INTO notes(body) VALUES ('first')", 'message-1', 1, socket);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].source_message_id, 'message-1');
    assert.equal(changes[0].new_row.body, 'first');
    await assert.rejects(() => writeStatement('carbon_test',
      "WITH input(body) AS (VALUES ('second'), ('third')) INSERT INTO notes(body) SELECT body FROM input",
      'message-2', 1, socket), /over max_rows/);
    assert.equal((await readStatement('carbon_test', 'SELECT count(*)::int AS n FROM notes', socket))[0].n, 1);
    const db = recordsDb('carbon_test', 'carbon_write', 1, socket);
    try {
      await assert.rejects(() => db.unsafe('INSERT INTO jobs_demo(unit_id, sop, sop_version, positions) VALUES ($1,$2,$3,$4)',
        ['u', 'demo', '1', '{}'], oneStatement), /permission denied/);
      await assert.rejects(() => db.unsafe('SELECT 1; SELECT 2', [], oneStatement), /multiple commands/);
      await assert.rejects(() => writeStatement('carbon_test',
        'COMMIT; UPDATE notes SET body = \'escaped\'', 'message-3', 1, socket), /multiple commands/);
    } finally { await db.end({ timeout: 2 }); }
    const changed = path.join(repo, 'records', 'migrations', '0001-notes.sql');
    fs.appendFileSync(changed, '\nALTER TABLE notes ADD COLUMN later text;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-2', socket), /changed/);
    fs.writeFileSync(changed, 'CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);');
    const hiddenRls = path.join(repo, 'records', 'migrations', '0002-hidden-rls.sql');
    fs.writeFileSync(hiddenRls,
      "DO $$BEGIN EXECUTE 'ALTER TABLE notes ENABLE ROW LEVEL SECURITY'; END$$;");
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-3', socket), /row-level security/);
    const rls = psql('carbon_test', "SELECT relrowsecurity FROM pg_class WHERE relname = 'notes'");
    assert.match(rls, /\bf\b/);
    fs.rmSync(hiddenRls);
    fs.writeFileSync(path.join(repo, 'records', 'migrations', '0000-too-late.sql'), 'SELECT 1;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-4', socket), /precedes an applied migration/);
  } finally {
    if (started) command(pg('pg_ctl'), ['-D', data, '-m', 'fast', 'stop']);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
