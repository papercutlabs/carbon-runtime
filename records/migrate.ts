import { checkRecords, type CheckedRecords } from './check.ts';
import { recordsDb } from './db.ts';
import type { Sop } from './sop-definition.ts';
import { refuse } from '../tools/lib/fault.ts';

type AnySql = any;
function migrationRefused(problem: string): never {
  return refuse('RECORDS_MIGRATION_REFUSED', 'records', problem,
    'correct the forward-only records files and install a new version');
}
const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) migrationRefused(`unsafe SQL identifier ${name}`);
  return `"${name}"`;
};
const jobTables = (sop: string) => {
  const suffix = sop.replaceAll('-', '_');
  return { jobs: `jobs_${suffix}`, events: `job_events_${suffix}` };
};

async function ensureCore(db: AnySql) {
  await db.begin(async (tx: AnySql) => {
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS carbon.migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
      install_digest text NOT NULL)`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS carbon.sop_definitions (
      sop text NOT NULL, version text NOT NULL, sha256 text NOT NULL,
      definition jsonb NOT NULL, installed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sop, version))`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS carbon.changes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_id bigint NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
      table_name text NOT NULL, operation text NOT NULL, old_row jsonb, new_row jsonb,
      source_message_id text NOT NULL, login text NOT NULL)`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS carbon.action_receipts (
      action_id uuid PRIMARY KEY, job_id uuid NOT NULL, sop text NOT NULL,
      step text NOT NULL, source_id text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now())`);
    await tx.unsafe(`CREATE OR REPLACE FUNCTION carbon.log_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
      DECLARE cause text;
      BEGIN
        cause := current_setting('carbon.source_message_id', true);
        IF cause IS NULL OR cause = '' THEN
          RAISE EXCEPTION 'Carbon change has no source_message_id' USING ERRCODE = '23502';
        END IF;
        INSERT INTO carbon.changes(transaction_id, table_name, operation, old_row, new_row, source_message_id, login)
        VALUES (txid_current(), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP,
                CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
                CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
                cause, session_user);
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $function$`);
    await tx.unsafe(`REVOKE ALL ON FUNCTION carbon.log_change() FROM PUBLIC`);
    await tx.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA carbon FROM PUBLIC`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public, carbon TO carbon_read, carbon_write`);
    await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA carbon TO carbon_read, carbon_write`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE carbon_owner IN SCHEMA carbon
      GRANT SELECT ON TABLES TO carbon_read, carbon_write`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE carbon_owner IN SCHEMA public
      GRANT SELECT ON TABLES TO carbon_read, carbon_write`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE carbon_owner IN SCHEMA public
      GRANT INSERT, UPDATE ON TABLES TO carbon_write`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE carbon_owner IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO carbon_write`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE carbon_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  });
}

async function catalogGuard(tx: AnySql, described: Set<string>) {
  const tables = await tx.unsafe(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  for (const table of tables) {
    if (!described.has(table.relname)) migrationRefused(`public.${table.relname} is not described in records/README.md`);
    if (table.relrowsecurity || table.relforcerowsecurity) {
      migrationRefused(`public.${table.relname} enables row-level security, so backup cannot read every row`);
    }
  }
  await tx.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, carbon FROM PUBLIC`);
  const callable = await tx.unsafe(`SELECT n.nspname, p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'carbon') AND p.prosecdef
      AND has_function_privilege('carbon_backup', p.oid, 'EXECUTE')`);
  if (callable.length) migrationRefused(`backup login can call owner-rights function ${callable[0].nspname}.${callable[0].proname}`);
}

async function attachChanges(tx: AnySql, table: string) {
  const trigger = `carbon_changes_${table}`;
  const existing = await tx`SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${table} AND t.tgname = ${trigger} AND NOT t.tgisinternal`;
  if (existing.length === 0) {
    await tx.unsafe(`CREATE TRIGGER ${identifier(trigger)} AFTER INSERT OR UPDATE OR DELETE
      ON public.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION carbon.log_change()`);
  }
}

async function requireChangeTriggers(tx: AnySql) {
  const tables = await tx.unsafe(`SELECT c.relname, t.tgname, t.tgenabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = 'carbon_changes_' || c.relname
      AND NOT t.tgisinternal
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  for (const table of tables) {
    if (table.tgname !== `carbon_changes_${table.relname}` || !['O', 'A'].includes(table.tgenabled)) {
      migrationRefused(`public.${table.relname} has no enabled Carbon change trigger`);
    }
  }
}

function forwardOnly(previous: Sop, next: Sop): { track: string; from: string; to: string }[] {
  const renames: { track: string; from: string; to: string }[] = [];
  const nextTracks = new Map(next.tracks.map((track) => [track.id, track]));
  for (const oldTrack of previous.tracks) {
    const track = nextTracks.get(oldTrack.id);
    if (!track) migrationRefused(`SOP ${next.sop}: track ${oldTrack.id} cannot be removed`);
    for (const oldPosition of oldTrack.positions) {
      if (track.positions.some((position) => position.id === oldPosition.id)) continue;
      const renamed = track.positions.filter((position) => position.renamed_from === oldPosition.id);
      if (renamed.length !== 1) migrationRefused(`SOP ${next.sop}: position ${oldTrack.id}.${oldPosition.id} needs one renamed_from`);
      renames.push({ track: oldTrack.id, from: oldPosition.id, to: renamed[0].id });
    }
  }
  const nextSteps = new Map(next.events.map((step) => [step.id, step]));
  for (const oldStep of previous.events) {
    const step = nextSteps.get(oldStep.id);
    if (!step) migrationRefused(`SOP ${next.sop}: step ${oldStep.id} cannot be removed; mark it retired`);
    if (oldStep.retired && !step.retired) migrationRefused(`SOP ${next.sop}: retired step ${oldStep.id} cannot reopen`);
  }
  return renames;
}

async function installSops(db: AnySql, checked: CheckedRecords, digest: string) {
  const installed: { sop: string; version: string }[] = [];
  await db.begin(async (tx: AnySql) => {
    await tx`SELECT set_config('carbon.source_message_id', ${`install:${digest}`}, true)`;
    for (const candidate of checked.sops) {
      const { sop, definition, sha256 } = candidate;
      const { jobs, events } = jobTables(sop);
      const old = await tx`SELECT version, sha256, definition FROM carbon.sop_definitions
        WHERE sop = ${sop} ORDER BY installed_at DESC, version DESC LIMIT 1`;
      const same = await tx`SELECT sha256 FROM carbon.sop_definitions WHERE sop = ${sop} AND version = ${definition.version}`;
      if (same.length && same[0].sha256 !== sha256) migrationRefused(`SOP ${sop}@${definition.version} changed after install`);
      if (!same.length && old.length && old[0].version === definition.version) {
        migrationRefused(`SOP ${sop} version ${definition.version} changed without a new version`);
      }
      let renames: ReturnType<typeof forwardOnly> = [];
      if (!same.length && old.length) renames = forwardOnly(old[0].definition as Sop, definition);
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS public.${identifier(jobs)} (
        job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), unit_id text NOT NULL,
        "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
        sop text NOT NULL, sop_version text NOT NULL,
        positions jsonb NOT NULL, pending jsonb NOT NULL DEFAULT '{}'::jsonb,
        since jsonb NOT NULL DEFAULT '{}'::jsonb)`);
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS public.${identifier(events)} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES public.${identifier(jobs)}(job_id),
        event text NOT NULL, kind text NOT NULL, source_id text NOT NULL,
        at timestamptz NOT NULL DEFAULT clock_timestamp(), off_model boolean NOT NULL DEFAULT false,
        UNIQUE (job_id, source_id, event, kind))`);
      await tx.unsafe(`GRANT SELECT ON public.${identifier(jobs)}, public.${identifier(events)} TO carbon_read, carbon_write`);
      await tx.unsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.${identifier(jobs)}, public.${identifier(events)} FROM carbon_read, carbon_write`);
      await attachChanges(tx, jobs);
      await attachChanges(tx, events);
      if (!same.length) {
        for (const rename of renames) {
          const rows = await tx.unsafe(`SELECT job_id, positions, pending, since FROM public.${identifier(jobs)} FOR UPDATE`);
          for (const row of rows) {
            const positions = { ...row.positions };
            const pending = { ...row.pending };
            const since = { ...row.since };
            if (positions[rename.track] === rename.from) positions[rename.track] = rename.to;
            if (pending[rename.track] === rename.from) pending[rename.track] = rename.to;
            if (since[rename.from] !== undefined) { since[rename.to] = since[rename.from]; delete since[rename.from]; }
            await tx.unsafe(`UPDATE public.${identifier(jobs)} SET positions = $1, pending = $2, since = $3 WHERE job_id = $4`,
              [tx.json(positions), tx.json(pending), tx.json(since), row.job_id], { simple: false });
          }
        }
        await tx.unsafe(`UPDATE public.${identifier(jobs)} SET sop_version = $1 WHERE sop = $2`,
          [definition.version, sop], { simple: false });
        await tx`INSERT INTO carbon.sop_definitions(sop, version, sha256, definition)
          VALUES (${sop}, ${definition.version}, ${sha256}, ${tx.json(definition)})`;
        installed.push({ sop, version: definition.version });
      }
    }
    await catalogGuard(tx, new Set(checked.tables));
    await requireChangeTriggers(tx);
  });
  return installed;
}

export async function migrateRecords(repo: string, database: string, installDigest: string, socketDir?: string) {
  const checked = checkRecords(repo);
  if (checked.faults.length || !checked.records) migrationRefused(checked.faults.join('; '));
  const db = recordsDb(database, 'carbon_owner', 1, socketDir);
  const applied: string[] = [];
  try {
    await ensureCore(db);
    const previous = await db`SELECT name, sha256 FROM carbon.migrations ORDER BY name`;
    const prior = new Map(previous.map((row) => [row.name, row.sha256]));
    const highest = Math.max(-1, ...previous.map((row) => Number(String(row.name).slice(0, 4))));
    for (const migration of checked.records.migrations) {
      if (prior.has(migration.name)) {
        if (prior.get(migration.name) !== migration.sha256) migrationRefused(`applied migration ${migration.name} changed`);
        continue;
      }
      if (migration.number < highest) migrationRefused(`new migration ${migration.name} precedes an applied migration`);
      await db.begin(async (tx: AnySql) => {
        await tx`SELECT set_config('carbon.source_message_id', ${`install:${installDigest}`}, true)`;
        await tx.unsafe(migration.sql, [], { simple: true });
        await catalogGuard(tx, new Set(checked.records!.tables));
        const generated = new Set(checked.records!.sops.flatMap((candidate) =>
          Object.values(jobTables(candidate.sop))));
        const tables = await tx.unsafe(`SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'`);
        for (const table of tables) {
          await tx.unsafe(`GRANT SELECT ON public.${identifier(table.relname)} TO carbon_read, carbon_write`);
          if (generated.has(table.relname)) {
            await tx.unsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.${identifier(table.relname)} FROM carbon_read, carbon_write`);
          } else {
            await tx.unsafe(`GRANT INSERT, UPDATE ON public.${identifier(table.relname)} TO carbon_write`);
            await attachChanges(tx, table.relname);
          }
        }
        await tx.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO carbon_write`);
        await requireChangeTriggers(tx);
        await tx`INSERT INTO carbon.migrations(name, sha256, install_digest)
          VALUES (${migration.name}, ${migration.sha256}, ${installDigest})`;
      });
      applied.push(migration.name);
    }
    const installed = await installSops(db, checked.records, installDigest);
    return { schema: 'carbon.records-migrate.v1', applied, installed,
      unchanged: applied.length === 0 && installed.length === 0 };
  } finally {
    await db.end({ timeout: 2 });
  }
}
