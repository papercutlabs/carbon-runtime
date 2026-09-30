import postgres from 'postgres';
import { refuse } from '../tools/lib/fault.ts';

export type RecordRole = 'carbon_read' | 'carbon_write' | 'carbon_owner';

// Explicit socket and role arguments prevent a process environment from moving
// a records call to a TCP server or another login. PostgreSQL peer authentication
// still checks the Unix account behind the socket.
export function recordsDb(database: string, role: RecordRole, max = 4, socketDir = '/var/run/postgresql') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) refuse('RECORDS_DATABASE_INVALID', database,
    'invalid Carbon database name', 'use the database derived from the declared agent id');
  return postgres({
    path: `${socketDir}/.s.PGSQL.5432`, database, user: role, password: '', ssl: false,
    max, connect_timeout: 3, idle_timeout: 10, onnotice: () => {}
  });
}

// Passing an empty parameter list to postgres.js is not sufficient: its unsafe
// query path uses the simple protocol for that case, which accepts several SQL
// statements. Force the extended protocol explicitly on model-supplied SQL.
export const oneStatement = { simple: false, prepare: false } as { prepare?: boolean };

export async function readStatement(database: string, statement: string, socketDir?: string) {
  const db = recordsDb(database, 'carbon_read', 1, socketDir);
  try {
    return await db.begin('read only', async (tx) => {
      const rows = await tx.unsafe(statement, [], oneStatement);
      return [...rows];
    });
  } finally {
    await db.end({ timeout: 2 });
  }
}

export async function writeStatement(database: string, statement: string,
  sourceMessageId: string, maxRows: number, socketDir?: string) {
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim()) refuse('RECORDS_SOURCE_ID_INVALID', 'source_message_id',
    'source_message_id is required', 'pass the current message or timer event id');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000) {
    refuse('RECORDS_MAX_ROWS_INVALID', 'max_rows',
      'max_rows must be an integer from 1 to 1000', 'choose a cap in that range');
  }
  const db = recordsDb(database, 'carbon_write', 1, socketDir);
  try {
    return await db.begin(async (tx) => {
      await tx`SELECT set_config('carbon.source_message_id', ${sourceMessageId}, true)`;
      await tx.unsafe(statement, [], oneStatement);
      const changes = await tx`SELECT id, transaction_id, at, table_name, operation,
        old_row, new_row, source_message_id, login FROM carbon.changes
        WHERE transaction_id = txid_current() ORDER BY id`;
      if (changes.length > maxRows) refuse('RECORDS_ROW_LIMIT', 'max_rows',
        `records_write changed ${changes.length} rows, over max_rows ${maxRows}`, 'increase the cap or make a narrower write');
      if (changes.some((row) => row.source_message_id !== sourceMessageId)) {
        refuse('RECORDS_CAUSE_CHANGED', 'source_message_id',
          'records_write changed its source_message_id inside the SQL statement', 'remove the SQL change to the transaction cause');
      }
      return [...changes];
    });
  } finally {
    await db.end({ timeout: 2 });
  }
}
