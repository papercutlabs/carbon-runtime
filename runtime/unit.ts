import type { Declaration } from './types.ts';
import { fault, RuntimeFault } from './faults.ts';

// A conversation or client record is the unit whose SOP jobs a reply acts on.
export function unitIdFor(declaration: Declaration, record: { conversation_id: string;
  message_id?: string; adapter_fields?: Record<string, unknown> }) {
  const unit = declaration.unit_of_work ?? {};
  if (unit.kind === 'conversation') return record.conversation_id;
  if (unit.kind === 'client_record') {
    const path = String(unit.id_from ?? '').split('.').filter(Boolean);
    let at: unknown = record.adapter_fields ?? {};
    for (const step of path) at = (at as Record<string, unknown> | null | undefined)?.[step];
    if (typeof at === 'string' && at.length > 0) return at;
    throw new RuntimeFault(fault('UNIT_ID_ABSENT', record.message_id!,
      `unit_of_work.id_from names ${JSON.stringify(unit.id_from)} and this record's adapter_fields carry no such value`,
      'have the adapter put the client record\'s id on the record, or declare unit_of_work.kind as conversation'));
  }
  throw new RuntimeFault(fault('UNIT_OF_WORK_UNKNOWN', String(unit.kind),
    'unit_of_work.kind is conversation or client_record',
    'correct unit_of_work.kind in the declaration'));
}
