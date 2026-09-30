import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { migrateRecords } from '../records/migrate.ts';
import { readStatement, recordsDb, oneStatement, writeStatement } from '../records/db.ts';
import { createJobTools } from '../records/job-tools.ts';
import { serveRecordsTool } from '../runtime/records-tool.ts';
import { installedJob, installedSop, renderCard, renderDiagram, viewParity } from '../records/views.ts';
import { beginMappedAction, beginBoundAction, finishMappedAction,
  processGeneration, reconcileAbsentAction } from '../tools/lib/action-check.ts';
import { recordCollectedEvent } from '../tools/lib/action-check.ts';
import { Store } from '../stream/store.ts';
import { recordsReplyHandler, recordSentAction } from '../runtime/reply-tool.ts';
import { standinClientWrite } from './support/records-client-tool.ts';

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
  const sop = { sop: 'demo', version: '1', collected_channels: {
    agent_action: 'receipt', external_read: 'client check', telegram: 'captured Telegram event' },
    tracks: [{ id: 'work', label: 'Work', initial: 'open', positions: [
      { id: 'open', label: 'Open', means: 'Unsent', do_here: 'Send', waiting_on: 'agent', terminal: false },
      { id: 'sent', label: 'Sent', means: 'Sent', do_here: 'Wait', waiting_on: 'client', terminal: false }
    ] }],
    events: [{ id: 'send', kind: 'intent', mover: 'agent', observed_via: 'agent_action',
      action: { tool: 'carbon-send', operation: 'send' },
      moves: [{ track: 'work', from: ['open'], to: 'sent' }] },
    { id: 'check', kind: 'observation', mover: 'client', observed_via: 'external_read',
      moves: [{ track: 'work', from: ['open'], to: 'sent' }] },
    { id: 'arrive', kind: 'observation', mover: 'client', observed_via: 'telegram',
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
    const activeOwner = { pid: process.pid, generation: processGeneration(process.pid)! };
    let directContext: { releaseId: string; unit: string; sourceIds: string[];
      owner: typeof activeOwner } | null = null;
    const jobs = createJobTools('carbon_test', async (source, channel) =>
      source === 'client-check-1' && channel === 'external_read', socket, () => directContext);
    const openDirect = (sopId: string, unit: string, references: string[], cause: string) => {
      directContext = { releaseId: `direct-${unit}`, unit, sourceIds: [cause], owner: activeOwner };
      return jobs.job_open(sopId, unit, references, cause);
    };
    try {
      await assert.rejects(() => openDirect('demo', 'thread-1', [], ''), /JOB_OPEN_CAUSE_INVALID/);
      const opened = await openDirect('demo', 'thread-1', ['reference-1'], 'message-1');
      await assert.rejects(() => jobs.job_open('demo', 'decoy-thread', [], 'message-1'), /JOB_OPEN_UNIT_MISMATCH/);
      await assert.rejects(() => jobs.job_open('demo', 'thread-1', [], 'made-up-message'), /JOB_OPEN_CAUSE_MISMATCH/);
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
      const mappedJob = await openDirect('demo', 'thread-mapped', [], 'message-mapped');
      await assert.rejects(() => jobs.action_begin(mappedJob.job, 'send', 'message-mapped', 'another-operation', activeOwner),
        /JOB_ACTION_UNMAPPED/);
      const claim = await jobs.action_begin(mappedJob.job, 'send', 'message-mapped', 'send', activeOwner);
      assert.equal(claim.status, 'claimed');
      await assert.rejects(() => jobs.action_begin(mappedJob.job, 'send', 'message-racer', 'send', activeOwner),
        /JOB_ACTION_PENDING/);
      const finished = await jobs.action_finish(mappedJob.job, 'send', 'tool-receipt-mapped', claim.action_id);
      assert.equal(finished.status, 'recorded');
      assert.equal((await jobs.job_read(mappedJob.job)).positions[0].position, 'sent');
      const secondJob = await openDirect('demo', 'thread-2', [], 'message-2');
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
    const openServer = async (args: { sop: string; unit: string; references: string[]; source_message_id: string },
      contextUnit = args.unit, contextCause = args.source_message_id) => {
      const releaseId = `test-${args.source_message_id}`;
      const start = await fetch(`http://127.0.0.1:${served.actionPort}/turn-start`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ releaseId, unit: contextUnit, sourceIds: [contextCause],
          owner: activeOwner }) });
      assert.equal(start.status, 200);
      try { return await rpc('tools/call', { name: 'job_open', arguments: args }); }
      finally {
        const end = await fetch(`http://127.0.0.1:${served.actionPort}/turn-end`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseId }) });
        assert.equal(end.status, 200);
      }
    };
    const listed = await rpc('tools/list', {});
    assert.equal(listed.result.tools.length, 7);
    const queried = await rpc('tools/call', { name: 'records_query',
      arguments: { sql: 'SELECT count(*)::int AS n FROM notes', max_rows: 10 } });
    assert.equal(queried.result.structuredContent.rows[0].n, 1);
    const actionJob = await openServer({
      sop: 'demo', unit: 'thread-action-http', references: [], source_message_id: 'message-action-http' });
    const actionJobId = actionJob.result.structuredContent.job;
    const decoy = await openServer({ sop: 'demo', unit: 'decoy-thread', references: [],
      source_message_id: 'message-decoy' }, 'real-thread');
    assert.equal(decoy.result.isError, true);
    assert.equal(decoy.result.structuredContent.faults[0].code, 'JOB_OPEN_UNIT_MISMATCH');
    const falseCause = await openServer({ sop: 'demo', unit: 'real-thread', references: [],
      source_message_id: 'message-false' }, 'real-thread', 'message-current');
    assert.equal(falseCause.result.isError, true);
    assert.equal(falseCause.result.structuredContent.faults[0].code, 'JOB_OPEN_CAUSE_MISMATCH');
    const firstTurn = { releaseId: 'test-concurrent-a', unit: 'concurrent-a',
      sourceIds: ['message-concurrent-a'], owner: activeOwner };
    const secondTurn = { releaseId: 'test-concurrent-b', unit: 'concurrent-b',
      sourceIds: ['message-concurrent-b'], owner: activeOwner };
    const turnUrl = `http://127.0.0.1:${served.actionPort}`;
    const turnCall = (route: string, body: unknown) => fetch(`${turnUrl}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await turnCall('/turn-start', firstTurn)).status, 200);
    const secondStarted = turnCall('/turn-start', secondTurn);
    const cancelledTurn = { releaseId: 'test-concurrent-cancelled', unit: 'cancelled',
      sourceIds: ['message-cancelled'], owner: activeOwner };
    const cancellation = new AbortController();
    const thirdStarted = fetch(`${turnUrl}/turn-start`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(cancelledTurn),
      signal: cancellation.signal });
    const waited = await Promise.race([secondStarted.then(() => 'started'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 50))]);
    assert.equal(waited, 'waiting', 'a second channel turn waits for the first turn context');
    const wrongTurn = await rpc('tools/call', { name: 'job_open', arguments: {
      sop: 'demo', unit: secondTurn.unit, references: [], source_message_id: secondTurn.sourceIds[0] } });
    assert.equal(wrongTurn.result.structuredContent.faults[0].code, 'JOB_OPEN_CAUSE_MISMATCH');
    cancellation.abort();
    await assert.rejects(thirdStarted, /AbortError/);
    assert.equal((await turnCall('/turn-end', { releaseId: firstTurn.releaseId })).status, 200);
    assert.equal((await secondStarted).status, 200);
    const correctTurn = await rpc('tools/call', { name: 'job_open', arguments: {
      sop: 'demo', unit: secondTurn.unit, references: [], source_message_id: secondTurn.sourceIds[0] } });
    assert.equal(correctTurn.result.isError, false);
    assert.equal((await turnCall('/turn-end', { releaseId: secondTurn.releaseId })).status, 200);
    const afterCancellation = await Promise.race([
      turnCall('/turn-start', { releaseId: 'test-after-cancelled', unit: 'after-cancelled',
        sourceIds: ['message-after-cancelled'], owner: activeOwner }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000))
    ]);
    assert.notEqual(afterCancellation, 'timeout', 'a cancelled waiter cannot take the next turn');
    assert.equal((afterCancellation as Response).status, 200);
    assert.equal((await turnCall('/turn-end', { releaseId: 'test-after-cancelled' })).status, 200);
    const turnOwner = spawn(process.execPath,
      ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    await once(turnOwner, 'spawn');
    try {
      const generation = processGeneration(turnOwner.pid!);
      assert.ok(generation);
      assert.equal((await turnCall('/turn-start', { releaseId: 'test-crashed-turn',
        unit: 'crashed', sourceIds: ['message-crashed'], owner: {
          pid: turnOwner.pid, generation } })).status, 200);
      const afterCrash = turnCall('/turn-start', { releaseId: 'test-after-crash',
        unit: 'after-crash', sourceIds: ['message-after-crash'], owner: activeOwner });
      const beforeExit = await Promise.race([afterCrash.then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 50))]);
      assert.equal(beforeExit, 'waiting');
      const exited = once(turnOwner, 'exit');
      turnOwner.stdin.end();
      await exited;
      const resumed = await Promise.race([afterCrash,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))]);
      assert.notEqual(resumed, 'timeout', 'a dead runtime generation releases its turn context');
      assert.equal((resumed as Response).status, 200);
      assert.equal((await turnCall('/turn-end', { releaseId: 'test-after-crash' })).status, 200);
    } finally {
      if (turnOwner.exitCode === null) turnOwner.stdin.end();
    }
    const actionCall = async (route: string, body: unknown) => {
      const result = await fetch(`http://127.0.0.1:${served.actionPort}${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const unmapped = await actionCall('/begin', { job: actionJobId, step: 'send',
      source_id: 'message-action-http', operation: 'other', owner: activeOwner });
    assert.equal(unmapped.status, 409);
    assert.equal(unmapped.body.faults[0].code, 'JOB_ACTION_UNMAPPED');
    const baseUrl = `http://127.0.0.1:${served.actionPort}`;
    const collectedJob = await openServer({
      sop: 'demo', unit: 'telegram-unit', references: [], source_message_id: 'message-collected' });
    const collectedJobId = collectedJob.result.structuredContent.job;
    const uncollected = await rpc('tools/call', { name: 'job_record', arguments: {
      job: collectedJobId, step: 'arrive', kind: 'observation', source_id: 'telegram-event-1' } });
    assert.equal(uncollected.result.isError, true);
    assert.match(JSON.stringify(uncollected), /JOB_SOURCE_UNVERIFIED/);
    assert.equal((await recordCollectedEvent({ source_id: 'telegram-event-1', channel: 'telegram',
      unit: 'telegram-unit' }, { baseUrl })).status, 'collected');
    const wrongUnitJob = await openServer({
      sop: 'demo', unit: 'other-unit', references: [], source_message_id: 'message-other-unit' });
    const wrongUnitObservation = await rpc('tools/call', { name: 'job_record', arguments: {
      job: wrongUnitJob.result.structuredContent.job, step: 'arrive', kind: 'observation',
      source_id: 'telegram-event-1' } });
    assert.equal(wrongUnitObservation.result.isError, true);
    assert.match(JSON.stringify(wrongUnitObservation), /JOB_SOURCE_UNVERIFIED/);
    const collected = await rpc('tools/call', { name: 'job_record', arguments: {
      job: collectedJobId, step: 'arrive', kind: 'observation', source_id: 'telegram-event-1' } });
    assert.equal(collected.result.isError, false);
    assert.equal((await installedJob('carbon_test', collectedJobId, socket)).job.positions.work, 'sent');
    const mapped = { about_job: actionJobId, derived_job: actionJobId,
      derived_move: 'send', operation: 'send', source_id: 'message-action-http' };
    await assert.rejects(() => beginMappedAction({ ...mapped, derived_move: null,
      about_move: 'other' }, { baseUrl }), /JOB_ACTION_CONTEXT_MISMATCH/);
    assert.deepEqual(await beginMappedAction({ ...mapped, derived_move: null,
      operation: 'unmapped', about_move: 'other' }, { baseUrl }), { kind: 'other' });
    await assert.rejects(() => beginMappedAction({ ...mapped, about_move: 'other' }, { baseUrl }),
      /JOB_ACTION_CONTEXT_MISMATCH/);
    const claim = await beginMappedAction({ ...mapped, about_move: 'send' }, { baseUrl });
    assert.equal(claim.kind, 'claimed');
    await assert.rejects(() => beginMappedAction({ ...mapped, about_move: 'send',
      source_id: 'message-racer-http' }, { baseUrl }), /JOB_ACTION_PENDING/);
    if (claim.kind !== 'claimed') throw new Error('the mapped action did not claim');
    const complete = await finishMappedAction(claim, 'receipt-action-http', { baseUrl });
    assert.equal(complete.status, 'recorded');
    const boundJob = await openServer({
      sop: 'demo', unit: 'thread-bound-http', references: [], source_message_id: 'message-bound-http' });
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
    const toolJob = await openServer({
      sop: 'demo', unit: 'thread-client-tool', references: [], source_message_id: 'message-tool' });
    const toolJobId = toolJob.result.structuredContent.job;
    const toolTarget = path.join(tmp, 'client-tool.json');
    fs.writeFileSync(toolTarget, JSON.stringify({ job: toolJobId, status: 'open', writes: 0 }));
    const toolCall = { target_id: 'client-tool', about_job: toolJobId,
      about_move: 'send', source_id: 'message-tool' };
    await assert.rejects(() => standinClientWrite(tmp, { ...toolCall, about_move: 'other' }, { baseUrl }),
      /JOB_ACTION_CONTEXT_MISMATCH/);
    assert.equal(JSON.parse(fs.readFileSync(toolTarget, 'utf8')).writes, 0);
    await assert.rejects(() => standinClientWrite(tmp, toolCall, {
      baseUrl, afterEffect: () => { throw new Error('simulated tool crash after client effect'); }
    }), /simulated tool crash/);
    assert.equal(JSON.parse(fs.readFileSync(toolTarget, 'utf8')).writes, 1);
    const recovered = await standinClientWrite(tmp, toolCall, { baseUrl });
    assert.equal(recovered.writes, 1, 'a repeated call reads the client effect before making another');
    assert.equal((await installedJob('carbon_test', toolJobId, socket)).job.positions.work, 'sent');
    const raceJob = await openServer({
      sop: 'demo', unit: 'thread-client-race', references: [], source_message_id: 'message-race' });
    const raceJobId = raceJob.result.structuredContent.job;
    const raceTarget = path.join(tmp, 'client-race.json');
    fs.writeFileSync(raceTarget, JSON.stringify({ job: raceJobId, status: 'open', writes: 0 }));
    const race = await Promise.allSettled([
      standinClientWrite(tmp, { target_id: 'client-race', about_job: raceJobId,
        about_move: 'send', source_id: 'race-1' }, { baseUrl }),
      standinClientWrite(tmp, { target_id: 'client-race', about_job: raceJobId,
        about_move: 'send', source_id: 'race-2' }, { baseUrl })
    ]);
    assert.ok(race.some((result) => result.status === 'fulfilled'));
    assert.equal(JSON.parse(fs.readFileSync(raceTarget, 'utf8')).writes, 1,
      'two concurrent client tools cause one external effect');
    const crashJob = await openServer({
      sop: 'demo', unit: 'thread-crash', references: [], source_message_id: 'message-crash' });
    const crashJobId = crashJob.result.structuredContent.job;
    const target = path.join(tmp, 'standin-client-record.json');
    fs.writeFileSync(target, JSON.stringify({ job: crashJobId, status: 'open' }));
    const claimant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(claimant, 'spawn');
    let claimantGeneration: string | null = null;
    try {
      const claimantPid = claimant.pid!;
      claimantGeneration = processGeneration(claimantPid);
      assert.ok(claimantGeneration);
      const claimed = await actionCall('/begin', { job: crashJobId, step: 'send',
        source_id: 'message-crash', operation: 'send',
        owner: { pid: claimantPid, generation: claimantGeneration } });
      assert.equal(claimed.status, 200);
      const crashClaim = { kind: 'claimed' as const, job: crashJobId, step: 'send',
        action_id: claimed.body.action_id as string };
      const readCrashTarget = async () => ({
        effect: JSON.parse(fs.readFileSync(target, 'utf8')).status === 'sent'
          ? 'present' as const : 'absent' as const,
        evidence_id: 'client-read-absent'
      });
      await assert.rejects(() => reconcileAbsentAction(crashClaim, 'client-read-still-live',
        readCrashTarget, { baseUrl }),
        /JOB_ACTION_OWNER_ACTIVE/);
      assert.equal(processGeneration(claimantPid), claimantGeneration,
        'the test signals only the exact process generation it started');
      const exited = once(claimant, 'exit');
      assert.equal(claimant.kill('SIGTERM'), true);
      await exited;
      const noReceipt = await actionCall('/reconcile-absent', { job: crashJobId, step: 'send',
        action_id: crashClaim.action_id, source_id: 'no-client-read' });
      assert.equal(noReceipt.status, 409);
      assert.equal(noReceipt.body.faults[0].code, 'JOB_ACTION_READ_ABSENT');
      const reconciled = await reconcileAbsentAction(crashClaim, 'client-read-absent',
        readCrashTarget, { baseUrl });
      assert.equal(reconciled.status, 'reconciled_absent');
      const retry = await beginMappedAction({ about_job: crashJobId, about_move: 'send',
        derived_job: crashJobId, derived_move: 'send', operation: 'send',
        source_id: 'message-crash-retry' }, { baseUrl });
      assert.equal(retry.kind, 'claimed');
      if (retry.kind !== 'claimed') throw new Error('the reconciled action did not re-arm');
      fs.writeFileSync(target, JSON.stringify({ job: crashJobId, status: 'sent', action_id: retry.action_id }));
      await finishMappedAction(retry, 'client-read-sent', { baseUrl });
    } finally {
      if (claimant.exitCode === null && claimant.pid && claimantGeneration
        && processGeneration(claimant.pid) === claimantGeneration) {
        const exited = once(claimant, 'exit');
        claimant.kill('SIGTERM');
        await exited;
      }
    }
    const replyJob = await openServer({
      sop: 'demo', unit: 'reply-conversation', references: [], source_message_id: 'reply-inbound' });
    const replyJobId = replyJob.result.structuredContent.job;
    const replyStore = Store.open(path.join(tmp, 'reply-store'));
    replyStore.capture({ schema: 'carbon.message.v1', agent: 'carbon-test', source: 'telegram',
      account: 'test', conversation_id: 'reply-conversation', conversation_kind: 'direct',
      message_id: 'reply-inbound', platform_message_id: 'inbound', revision: 0,
      direction: 'inbound', role: 'contact', sender_id: 'contact',
      received_at: new Date().toISOString(), body: 'Send it', attachments: [],
      historical: false, disposition: 'captured' });
    const reply = recordsReplyHandler({ store: replyStore, agent: 'carbon-test',
      declaration: { records: { enabled: true }, unit_of_work: { kind: 'conversation' } }, actionUrl: baseUrl });
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
    assert.equal((await turnCall('/turn-start', { releaseId: 'test-stop-active',
      unit: 'stop-active', sourceIds: ['message-stop-active'], owner: activeOwner })).status, 200);
    const stoppedWaiter = turnCall('/turn-start', { releaseId: 'test-stop-waiting',
      unit: 'stop-waiting', sourceIds: ['message-stop-waiting'], owner: activeOwner });
    assert.equal(await Promise.race([stoppedWaiter.then(() => 'started'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 50))]), 'waiting');
    const slow = rpc('tools/call', { name: 'records_query',
      arguments: { sql: 'SELECT pg_sleep(1)', max_rows: 1 } });
    let active = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const activity = command(pg('psql'), ['-X', '-At', '-h', socket, '-d', 'carbon_test',
        '-c', "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(1)%' AND state = 'active'"]);
      if (Number(activity.trim()) > 0) { active = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(active, true, 'the records server must be inside its read transaction');
    let stopped = false;
    const stopping = served.stop().then(() => { stopped = true; });
    const refusedWaiter = await stoppedWaiter;
    assert.equal(refusedWaiter.status, 409);
    assert.equal((await refusedWaiter.json() as any).faults[0].code, 'JOB_TURN_STOPPING');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(stopped, false, 'supported stop waits for an active call');
    assert.equal(fs.existsSync(path.join(agentDir, 'tools-work', 'carbon-records-drain.json')), false);
    await slow;
    await stopping;
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
    const asRole = (role: string, sql: string) => spawnSync(pg('psql'),
      ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', role, '-d', 'carbon_test', '-c', sql],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(asRole('carbon_backup', 'SELECT count(*) FROM notes').status, 0);
    assert.equal(asRole('carbon_backup', 'SELECT last_value FROM notes_id_seq').status, 0);
    for (const sql of ["INSERT INTO notes(body) VALUES ('forbidden')",
      "UPDATE notes SET body = 'forbidden'", 'DELETE FROM notes', 'TRUNCATE notes',
      'CREATE TABLE forbidden(id int)', "SELECT setval('notes_id_seq', 9)"]) {
      const result = asRole('carbon_backup', sql);
      assert.notEqual(result.status, 0, `${sql} must be refused for backup`);
      assert.match(result.stderr, /permission denied|must be owner/);
    }
    for (const sql of ['DELETE FROM notes', 'TRUNCATE notes',
      'UPDATE carbon.changes SET login = \'forbidden\'']) {
      const result = asRole('carbon_write', sql);
      assert.notEqual(result.status, 0, `${sql} must be refused for write login`);
      assert.match(result.stderr, /permission denied/);
    }
    const readMutation = asRole('carbon_read', "INSERT INTO notes(body) VALUES ('forbidden')");
    assert.notEqual(readMutation.status, 0);
    assert.match(readMutation.stderr, /permission denied/);
    const changed = path.join(repo, 'records', 'migrations', '0001-notes.sql');
    fs.appendFileSync(changed, '\nALTER TABLE notes ADD COLUMN later text;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-2', socket), /changed/);
    fs.writeFileSync(changed, 'CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);');
    const hiddenRls = path.join(repo, 'records', 'migrations', '0002-hidden-rls.sql');
    fs.writeFileSync(hiddenRls,
      "DO $$BEGIN EXECUTE 'ALTER TABLE notes ENABLE ROW LEVEL SECURITY'; END$$;");
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-3', socket), /executable DO/);
    const rls = psql('carbon_test', "SELECT relrowsecurity FROM pg_class WHERE relname = 'notes'");
    assert.match(rls, /\bf\b/);
    fs.rmSync(hiddenRls);
    const hiddenFunction = path.join(repo, 'records', 'migrations', '0002-hidden-function.sql');
    fs.writeFileSync(hiddenFunction,
      "CREATE SCHEMA client_internal; "
      + "CREATE FUNCTION client_internal.mutate() RETURNS void LANGUAGE sql SECURITY DEFINER "
      + "AS $$ UPDATE public.notes SET body = 'changed'; $$; "
      + 'GRANT USAGE ON SCHEMA client_internal TO carbon_backup; '
      + 'GRANT EXECUTE ON FUNCTION client_internal.mutate() TO carbon_backup;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-3a', socket),
      /routine definitions are forbidden/);
    assert.doesNotMatch(psql('carbon_test', "SELECT nspname FROM pg_namespace WHERE nspname = 'client_internal'"),
      /client_internal/);
    fs.rmSync(hiddenFunction);
    const hiddenDisable = path.join(repo, 'records', 'migrations', '0002-disable-change-trigger.sql');
    fs.writeFileSync(hiddenDisable,
      "DO $$BEGIN EXECUTE 'ALTER TABLE notes DISABLE TRIGGER carbon_changes_notes'; END$$;");
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-3b', socket), /executable DO/);
    assert.match(psql('carbon_test', "SELECT tgenabled FROM pg_trigger WHERE tgname = 'carbon_changes_notes'"), /\bO\b/);
    fs.rmSync(hiddenDisable);
    fs.writeFileSync(path.join(repo, 'records', 'migrations', '0000-too-late.sql'), 'SELECT 1;');
    await assert.rejects(() => migrateRecords(repo, 'carbon_test', 'test-release-4', socket), /precedes an applied migration/);
  } finally {
    if (started) command(pg('pg_ctl'), ['-D', data, '-m', 'fast', 'stop']);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
