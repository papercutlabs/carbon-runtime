import type { Store } from '../stream/store.ts';
import type { Fields, CorrectionQuery, LedgerContext, MessageIndex } from './types.ts';
export type Correction = { correction_id: string | null; kind: string; at: string | null; message_refs: string[]; actor?: string; actor_kind?: string; action?: string; note?: string; chat_key?: string; subject?: { kind: string; id: string | null }; before?: unknown; after?: unknown; fields?: Fields };
type PlacedCorrection = Correction & { message_ids: string[] };
type Grouped = { byConversation: Map<string, PlacedCorrection[]>; unlinked: PlacedCorrection[] };
// The corrections a ledger holds, and where they land.
//
// A ledger sits inside a working system, and that system knows more than what
// was said: it knows where a person corrected the agent, where a nightly pass
// flagged something, where an escalation was raised. That is the material a
// case miner reads to learn what the client accepted as good, and it is not a
// property of any one message, so it is written beside the captures rather than
// on them.
//
// One file per conversation, `corrections/<encoded conversation id>.json`, in
// the `carbon.ledger-corrections.v1` shape documented at the top of
// `carbon-ledger-sqlite.ts`, plus `corrections/unlinked.json` for corrections
// that name no message the import wrote. The files carry no generation time, so
// a second run over an unchanged ledger writes the same bytes.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../stream/store.ts';
import { encodeComponent } from '../stream/encode.ts';
import { toIso } from './ledger-mapping.ts';

export const CORRECTIONS_SCHEMA = 'carbon.ledger-corrections.v1';

// The columns this module reads off a corrections query by name. Every other
// column the query selects is carried whole, because a mapping that selects
// something has a reason and this is not the place to decide it was wrong.
const NAMED = new Set([
  'correction_id', 'at', 'actor', 'actor_kind', 'action',
  'subject_kind', 'subject_id', 'before_json', 'after_json', 'note',
  'message_refs', 'chat_key'
]);

const CARRIED_TEXT: [string, 'actor' | 'actor_kind' | 'action' | 'note' | 'chat_key'][] = [['actor', 'actor'], ['actor_kind', 'actor_kind'],
  ['action', 'action'], ['note', 'note'], ['chat_key', 'chat_key']];

export function parseRefs(value: unknown, format = 'json_array') {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.map((one) => String(one)).filter(Boolean);
  if (format === 'none') return [];
  if (format === 'comma') return String(value).split(',').map((r) => r.trim()).filter(Boolean);
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return [String(value)];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((one) => one !== null).map((one) => String(one)).filter(Boolean);
}

function maybeJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return String(value);
  }
}

function subjectOf(row: Fields) {
  if (row.subject_kind === null || row.subject_kind === undefined) return undefined;
  return {
    kind: String(row.subject_kind),
    id: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id)
  };
}

function unnamedFields(row: Fields) {
  const fields: Fields = {};
  for (const [name, value] of Object.entries(row)) {
    if (NAMED.has(name)) continue;
    if (value === null || value === undefined || value === '') continue;
    fields[name] = value;
  }
  return fields;
}

// One row of a corrections query becomes one correction.
export function toCorrection(query: CorrectionQuery, row: Fields) {
  const correction: Correction = {
    correction_id: row.correction_id === null || row.correction_id === undefined
      ? null : String(row.correction_id),
    kind: query.kind,
    at: toIso(row.at, query.timestamp ?? 'epoch_seconds'),
    message_refs: parseRefs(row.message_refs, query.message_refs ?? 'json_array')
  };
  for (const [column, name] of CARRIED_TEXT) {
    const value = row[column];
    if (value === null || value === undefined || value === '') continue;
    correction[name] = String(value);
  }
  const subject = subjectOf(row);
  if (subject !== undefined) correction.subject = subject;
  const before = maybeJson(row.before_json);
  const after = maybeJson(row.after_json);
  if (before !== undefined) correction.before = before;
  if (after !== undefined) correction.after = after;
  const fields = unnamedFields(row);
  if (Object.keys(fields).length > 0) correction.fields = fields;
  return correction;
}

// Where a correction belongs: the conversations of the messages it names. A
// correction naming messages in two conversations is written into both, because
// the miner reads one conversation at a time and a correction it cannot see is a
// correction that did not happen.
function placementsOf(correction: Correction, index: MessageIndex, chatToConversation: Map<string | undefined, string>) {
  const placed = new Map<string, string[]>();
  for (const ref of correction.message_refs ?? []) {
    const found = index.get(String(ref));
    if (!found) continue;
    if (!placed.has(found.conversation_id)) placed.set(found.conversation_id, []);
    // The entry is inserted immediately above if it was missing.
    placed.get(found.conversation_id)!.push(found.message_id);
  }
  if (placed.size > 0) return placed;
  const named = chatToConversation.get(correction.chat_key);
  if (named !== undefined) placed.set(named, []);
  return placed;
}

export function groupCorrections(corrections: Correction[], index: MessageIndex, chatToConversation: Map<string | undefined, string> = new Map()): Grouped {
  const byConversation = new Map<string, PlacedCorrection[]>();
  const unlinked = [];
  for (const correction of corrections) {
    const placed = placementsOf(correction, index, chatToConversation);
    if (placed.size === 0) {
      unlinked.push({ ...correction, message_ids: [] });
      continue;
    }
    for (const [conversation_id, message_ids] of placed) {
      if (!byConversation.has(conversation_id)) byConversation.set(conversation_id, []);
      // The entry is inserted immediately above if it was missing.
      byConversation.get(conversation_id)!.push({ ...correction, message_ids });
    }
  }
  return { byConversation, unlinked };
}

function correctionsDir(store: Store) {
  return store.under('corrections');
}

export function sidecarFile(store: Store, conversation_id: string) {
  return path.join(correctionsDir(store), `${encodeComponent(conversation_id)}.json`);
}

function ordered(corrections: PlacedCorrection[]) {
  return [...corrections].sort((one, other) => {
    const byTime = String(one.at ?? '').localeCompare(String(other.at ?? ''));
    if (byTime !== 0) return byTime;
    return String(one.correction_id ?? '').localeCompare(String(other.correction_id ?? ''));
  });
}

// The sidecars, written whole and atomically. A file whose bytes would not
// change is not rewritten, so a second run over an unchanged ledger touches
// nothing.
export function writeSidecars(context: LedgerContext, grouped: Grouped) {
  const dir = correctionsDir(context.store);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const counts = { files: 0, written: 0, unchanged: 0 };

  const put = (file: string, body: unknown) => {
    const text = JSON.stringify(body, null, 2) + '\n';
    counts.files++;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) {
      counts.unchanged++;
      return;
    }
    writeAtomic(file, text);
    counts.written++;
  };

  const head: { schema: string; agent: string; account: string; ledger?: string } = { schema: CORRECTIONS_SCHEMA, agent: context.agent, account: context.account };
  const named = context.mapping?.ledger;
  if (typeof named === 'string' && named.length > 0) head.ledger = named;

  for (const [conversation_id, corrections] of [...grouped.byConversation].sort()) {
    put(sidecarFile(context.store, conversation_id),
      { ...head, conversation_id, corrections: ordered(corrections) });
  }
  if (grouped.unlinked.length > 0) {
    put(path.join(dir, 'unlinked.json'), {
      ...head,
      note: 'these corrections name no message this import wrote, so no conversation owns them',
      corrections: ordered(grouped.unlinked)
    });
  }
  return counts;
}
