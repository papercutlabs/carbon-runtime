import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { migrateRecords } from '../records/migrate.ts';
import { readStatement, recordsDb, oneStatement, writeStatement } from '../records/db.ts';
import { createJobTools } from '../records/job-tools.ts';
import { serveRecordsTool } from '../runtime/records-tool.ts';
import { installedJob, installedSop, renderCard, renderDiagram, viewParity } from '../records/views.ts';
import { beginMappedAction, beginBoundAction, finishMappedAction } from '../tools/lib/action-check.ts';
import { Store } from '../stream/store.ts';
import { recordsReplyHandler, recordSentAction } from '../runtime/reply-tool.ts';

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

const PG17_BIN = fs.existsSync('/opt/homebrew/opt/postgresql@17/bin/pg_config')
  ? '/opt/homebrew/opt/postgresql@17/bin' : '/usr/lib/postgresql/17/bin';
const pg = (name: string) => path.join(PG17_BIN, name);

test('real PostgreSQL applies each migration once, protects generated tables and refuses two statements', async () => {
  const help = command(process.execPath, [path.resolve(import.meta.dirname, '../bin/carbon-records'), '--help']);
  for (const verb of ['diagram', 'card', 'parity']) assert.match(help, new RegExp(`carbon-records ${verb}`));
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
  const sop = { sop: 'demo', version: '1', collected_channels: { agent_action: 'receipt', external_read: 'client check' },
    tracks: [{ id: 'work', label: 'Work', initial: 'open', positions: [
      { id: 'open', label: 'Open', means: 'Unsent', do_here: 'Send', waiting_on: 'agent', terminal: false },
      { id: 'sent', label: 'Sent', means: 'Sent', do_here: 'Wait', waiting_on: 'client', terminal: false }
    ] }],
    events: [{ id: 'send', kind: 'intent', mover: 'agent', observed_via: 'agent_action',
      action: { tool: 'carbon-send', operation: 'send' },
      moves: [{ track: 'work', from: ['open'], to: 'sent' }] },
    { id: 'check', kind: 'observation', mover: 'client', observed_via: 'external_read',
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
    const jobs = createJobTools('carbon_test', async (source, channel) =>
      source === 'client-check-1' && channel === 'external_read', socket);
    try {
      await assert.rejects(() => jobs.job_open('demo', 'thread-1', [], ''), /JOB_OPEN_CAUSE_INVALID/);
      const opened = await jobs.job_open('demo', 'thread-1', ['reference-1'], 'message-1');
      assert.equal(opened.sop_version, '1');
      const installed = await installedSop('carbon_test', 'demo', socket);
      const viewed = await installedJob('carbon_test', opened.job, socket);
      assert.match(renderDiagram(installed), /\| work \| open \| Open \| Unsent \|/);
      assert.match(renderCard(viewed.job, viewed.sop), /work: waiting on agent since/);
      assert.deepEqual(viewParity(viewed.job, viewed.sop), { ok: true, faults: [], positions_checked: 1 });
      assert.equal((await jobs.job_find('reference-1')).jobs[0].job_id, opened.job);
      assert.deepEqual(await readStatement('carbon_test', 'SELECT positions FROM jobs_demo', socket),
        [{ positions: { work: 'open' } }]);
      assert.equal((await jobs.job_check(opened.job, 'send')).allowed, true,
        JSON.stringify(await jobs.job_read(opened.job)));
      const intent = await jobs.job_record(opened.job, 'send', 'intent', 'message-1');
      assert.equal(intent.status, 'pending');
      assert.ok(intent.pending);
      assert.equal((await jobs.job_record(opened.job, 'send', 'intent', 'message-1')).status, 'already_recorded');
      await assert.rejects(() => jobs.job_record(opened.job, 'send', 'observation', 'receipt-1'), /JOB_ACTION_RECEIPT_ABSENT/);
      psql('carbon_test', `INSERT INTO carbon.action_receipts(action_id, job_id, sop, step, source_id)
        VALUES ('${intent.pending.action_id}', '${opened.job}', 'demo', 'send', 'receipt-1')`);
      const observed = await jobs.job_record(opened.job, 'send', 'observation', 'receipt-1');
      assert.equal(observed.status, 'recorded');
      assert.ok(observed.positions);
      assert.equal(observed.positions.work, 'sent');
      assert.equal((await jobs.job_read(opened.job)).pending.work, undefined);
      assert.equal((await jobs.job_record(opened.job, 'send', 'observation', 'receipt-1')).status, 'already_recorded');
      const offModel = await jobs.job_record(opened.job, 'check', 'observation', 'client-check-1');
      assert.equal(offModel.off_model, true);
      const mappedJob = await jobs.job_open('demo', 'thread-mapped', [], 'message-mapped');
      await assert.rejects(() => jobs.action_begin(mappedJob.job, 'send', 'message-mapped', 'another-operation'),
        /JOB_ACTION_UNMAPPED/);
      const claim = await jobs.action_begin(mappedJob.job, 'send', 'message-mapped', 'send');
      assert.equal(claim.status, 'claimed');
      await assert.rejects(() => jobs.action_begin(mappedJob.job, 'send', 'message-racer', 'send'),
        /JOB_ACTION_PENDING/);
      const finished = await jobs.action_finish(mappedJob.job, 'send', 'tool-receipt-mapped', claim.action_id);
      assert.equal(finished.status, 'recorded');
      assert.equal((await jobs.job_read(mappedJob.job)).positions[0].position, 'sent');
      const secondJob = await jobs.job_open('demo', 'thread-2', [], 'message-2');
      const peer = createJobTools('carbon_test', async () => false, socket);
      try {
        const contenders = await Promise.allSettled([
          jobs.job_record(secondJob.job, 'send', 'intent', 'message-2'),
          peer.job_record(secondJob.job, 'send', 'intent', 'message-3')
        ]);
        assert.equal(contenders.filter((answer) => answer.status === 'fulfilled').length, 1);
        assert.equal(contenders.filter((answer) => answer.status === 'rejected').length, 1);
        assert.match(String((contenders.find((answer) => answer.status === 'rejected') as PromiseRejectedResult).reason),
          /JOB_ACTION_PENDING/);
      } finally { await peer.close(); }
    } finally { await jobs.close(); }
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(agentDir, 'tools-work'), { recursive: true });
    const served = await serveRecordsTool({ database: 'carbon_test', agentId: 'carbon-test', agentDir,
      socketDir: socket, port: 0, actionPort: 0, verifyObservation: async () => false });
    const port = (served.http.address() as AddressInfo).port;
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as Record<string, unknown>;
    assert.equal(health.status, 'ready');
    assert.equal(health.agent_id, 'carbon-test');
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return response.json() as Promise<any>;
    };
    const listed = await rpc('tools/list', {});
    assert.equal(listed.result.tools.length, 7);
    const queried = await rpc('tools/call', { name: 'records_query',
      arguments: { sql: 'SELECT count(*)::int AS n FROM notes', max_rows: 10 } });
    assert.equal(queried.result.structuredContent.rows[0].n, 1);
    const actionJob = await rpc('tools/call', { name: 'job_open', arguments: {
      sop: 'demo', unit: 'thread-action-http', references: [], source_message_id: 'message-action-http' } });
    const actionJobId = actionJob.result.structuredContent.job;
    const actionCall = async (route: string, body: unknown) => {
      const result = await fetch(`http://127.0.0.1:${served.actionPort}${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const unmapped = await actionCall('/begin', { job: actionJobId, step: 'send',
      source_id: 'message-action-http', operation: 'other' });
    assert.equal(unmapped.status, 409);
    assert.equal(unmapped.body.faults[0].code, 'JOB_ACTION_UNMAPPED');
    const baseUrl = `http://127.0.0.1:${served.actionPort}`;
    const mapped = { about_job: actionJobId, derived_job: actionJobId,
      derived_move: 'send', operation: 'send', source_id: 'message-action-http' };
    await assert.rejects(() => beginMappedAction({ ...mapped, about_move: 'other' }, { baseUrl }),
      /JOB_ACTION_CONTEXT_MISMATCH/);
    const claim = await beginMappedAction({ ...mapped, about_move: 'send' }, { baseUrl });
    assert.equal(claim.kind, 'claimed');
    await assert.rejects(() => beginMappedAction({ ...mapped, about_move: 'send',
      source_id: 'message-racer-http' }, { baseUrl }), /JOB_ACTION_PENDING/);
    if (claim.kind !== 'claimed') throw new Error('the mapped action did not claim');
    const complete = await finishMappedAction(claim, 'receipt-action-http', { baseUrl });
    assert.equal(complete.status, 'recorded');
    const boundJob = await rpc('tools/call', { name: 'job_open', arguments: {
      sop: 'demo', unit: 'thread-bound-http', references: [], source_message_id: 'message-bound-http' } });
    const boundJobId = boundJob.result.structuredContent.job;
    assert.deepEqual(await beginBoundAction({ unit: 'thread-bound-http', operation: 'reply',
      about_job: boundJobId, about_move: 'other', source_id: 'reply-1' }, { baseUrl }), { kind: 'other' });
    await assert.rejects(() => beginBoundAction({ unit: 'thread-bound-http', operation: 'reply',
      about_job: 'unbound-job', about_move: 'other', source_id: 'reply-1' }, { baseUrl }),
      /JOB_ACTION_CONTEXT_MISMATCH/);
    await assert.rejects(() => beginBoundAction({ unit: 'thread-bound-http', operation: 'send',
      about_job: boundJobId, about_move: 'other', source_id: 'reply-2' }, { baseUrl }),
      /JOB_ACTION_CONTEXT_MISMATCH/);
    const bound = await beginBoundAction({ unit: 'thread-bound-http', operation: 'send',
      about_job: boundJobId, about_move: 'send', source_id: 'reply-2' }, { baseUrl });
    assert.equal(bound.kind, 'claimed');
    const replyJob = await rpc('tools/call', { name: 'job_open', arguments: {
      sop: 'demo', unit: 'reply-conversation', references: [], source_message_id: 'reply-inbound' } });
    const replyJobId = replyJob.result.structuredContent.job;
    const replyStore = Store.open(path.join(tmp, 'reply-store'));
    replyStore.capture({ schema: 'carbon.message.v1', agent: 'carbon-test', source: 'telegram',
      account: 'test', conversation_id: 'reply-conversation', conversation_kind: 'direct',
      message_id: 'reply-inbound', platform_message_id: 'inbound', revision: 0,
      direction: 'inbound', role: 'contact', sender_id: 'contact',
      received_at: new Date().toISOString(), body: 'Send it', attachments: [],
      historical: false, disposition: 'captured' });
    const reply = recordsReplyHandler({ store: replyStore, agent: 'carbon-test',
      declaration: { records: { enabled: true } }, actionUrl: baseUrl });
    const replyArgs = { conversation_id: 'reply-conversation', request_id: 'reply-request',
      text: 'Sent', about_job: replyJobId, about_move: 'other' };
    await assert.rejects(() => reply(replyArgs), /JOB_ACTION_CONTEXT_MISMATCH/);
    assert.equal(replyStore.rebuild().filter((r) => r.direction === 'outbound').length, 0);
    const written = await reply({ ...replyArgs, about_move: 'send' });
    assert.equal(written.data.status, 'written');
    const pendingReply = replyStore.rebuild().find((r) => r.direction === 'outbound')!;
    assert.ok(pendingReply.delivery?.action_claim);
    const sentReply = replyStore.markSent('reply-request', ['channel-id']);
    await recordSentAction(replyStore, sentReply, { actionUrl: baseUrl });
    // Recovery can repeat the receipt after a crash before its file annotation.
    await recordSentAction(replyStore, sentReply, { actionUrl: baseUrl });
    assert.equal((await installedJob('carbon_test', replyJobId, socket)).job.positions.work, 'sent');
    assert.ok(replyStore.rebuild().find((r) => r.direction === 'outbound')?.adapter_fields?.action_recorded_at);
    await served.stop();
    const receipt = JSON.parse(fs.readFileSync(path.join(agentDir, 'tools-work', 'carbon-records-drain.json'), 'utf8'));
    assert.equal(receipt.database_sessions_closed, true);
    assert.equal(receipt.active_requests, 0);
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
    const hiddenDisable = path.join(repo, 'records', 'migrations', '0002-disable-change-trigger.sql');
    fs.writeFileSync(hiddenDisable,
      "DO $$BEGIN EXECUTE 'ALTER TABLE notes DISABLE TRIGGER carbon_changes_notes'; END$$;");
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-3b', socket), /no enabled Carbon change trigger/);
    assert.match(psql('carbon_test', "SELECT tgenabled FROM pg_trigger WHERE tgname = 'carbon_changes_notes'"), /\bO\b/);
    fs.rmSync(hiddenDisable);
    fs.writeFileSync(path.join(repo, 'records', 'migrations', '0000-too-late.sql'), 'SELECT 1;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-4', socket), /precedes an applied migration/);
  } finally {
    if (started) command(pg('pg_ctl'), ['-D', data, '-m', 'fast', 'stop']);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
