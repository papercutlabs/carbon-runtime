import fs from 'node:fs';
import { checkRecords } from '../records/check.ts';
import { readStatement } from '../records/db.ts';
import { migrateRecords } from '../records/migrate.ts';

const HELP = `carbon-records — validate and use one agent's records

Usage:
  carbon-records check <client repository>
  carbon-records migrate --repo <client repository> --database <agent database> --install-digest <digest>
  carbon-records read --database <agent database>  (one SQL statement on stdin)

The check runs offline and names every structural refusal. The read connects over
the local PostgreSQL socket as carbon_read, runs one statement in a read-only
transaction, and prints one JSON row per line. The Unix account must be mapped to
carbon_read by the host contract. It reads no credential file.`;

async function main(args: string[]): Promise<number> {
  // shape: justified this one CLI dispatch keeps check, read and migrate on the same installed entrypoint; each branch delegates its records operation
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return args.length === 0 ? 1 : 0;
  }
  if (args[0] === 'check' && args.length === 2) {
    const result = checkRecords(args[1]);
    if (result.faults.length > 0) {
      for (const error of result.faults) console.error(JSON.stringify({ code: 'RECORDS_CHECK_REFUSED', problem: error }));
      return 1;
    }
    console.log(JSON.stringify({ schema: 'carbon.records-check.v1', ok: true,
      migrations: result.records!.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
      sops: result.records!.sops.map((s) => ({ sop: s.sop, version: s.definition.version, sha256: s.sha256 })),
      tables: result.records!.tables }));
    return 0;
  }
  if (args[0] === 'read' && args[1] === '--database' && args.length === 3) {
    const statement = fs.readFileSync(0, 'utf8');
    if (!statement.trim()) { console.error(JSON.stringify({ code: 'RECORDS_SQL_EMPTY' })); return 1; }
    const rows = await readStatement(args[2], statement);
    for (const row of rows) console.log(JSON.stringify(row));
    return 0;
  }
  if (args[0] === 'migrate' && args[1] === '--repo' && args[3] === '--database'
    && args[5] === '--install-digest' && args.length === 7) {
    console.log(JSON.stringify(await migrateRecords(args[2], args[4], args[6])));
    return 0;
  }
  console.error(JSON.stringify({ code: 'RECORDS_ARGUMENTS', problem: 'run carbon-records --help' }));
  return 1;
} // shape: justified one CLI entry dispatches its three named records operations and delegates each to its own module

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(JSON.stringify({ code: 'RECORDS_FAILED', problem: error?.message ?? String(error) }));
  process.exitCode = 1;
});
