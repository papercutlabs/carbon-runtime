import type { MessageRecord } from '../stream/store.ts';
import type { Fault } from '../stream/faults.ts';
import type { NamedOutbound, OutboundMapping, OutboundItem, OutboundContext, ImportFields } from './types.ts';
import type { LineCounts, TurnCounts } from './outbound-sources.ts';
import type { joinOutbound } from './outbound-link.ts';
type ReadCounts = { events?: LineCounts; audit?: LineCounts; turns?: TurnCounts };
type CountState = { store: Store; counts: ReturnType<typeof emptyCounts>; conversations: Set<string>; earliest: string | null; latest: string | null };
// `carbon-import ledger-outbound` — the command around the outbound import.
//
// It is here rather than in `bin/` because it is the same size as the import it
// drives and `bin/carbon-import` is already one file a person reads in a
// sitting. What is in `bin/` is the argument parsing and the dispatch; what is
// here is the reading, the writing and the counting.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fault, report } from '../stream/faults.ts';
import { Store, StreamFault } from '../stream/store.ts';
import { SOURCE, payload, resolvedAnswers, writeEntries } from './carbon-ledger-outbound.ts';
import { outboundFaults, toleranceMs } from './outbound-mapping.ts';
import {
  emptyLineCounts, emptyTurnCounts, readDirectory, readLines, readTurns, sourceFaults
} from './outbound-sources.ts';
import { resolveAccount } from './store-account.ts';

export const OUTBOUND_HELP = `carbon-import ledger-outbound — import what a client's agent itself sent

Usage:
  carbon-import ledger-outbound --agent <id> --mapping <file> --store <dir>
                                [--events <file>] [--audit <dir>] [--turns <file>]
                                [--account <jid>]

  --agent <id>       the agent whose store this history belongs to
  --mapping <file>   the JSON mapping. Its outbound section names the three
                     places the agent's sends were recorded and the names
                     inside them; its shape is documented at the top of
                     import/outbound-mapping.ts.
  --store <dir>      the agent's store directory
  --events <file>    a JSON-lines file the channel appended, one line per event
  --audit <dir>      a directory of JSON-lines files a send authority appended
  --turns <file>     a SQLite database holding the harness's turns table,
                     opened read-only, read through the mapping's own select
  --account <jid>    the account this history belongs to. Read from the store
                     when it names exactly one WhatsApp channel, or from the
                     mapping when it names one, and never guessed.

At least one of --events, --audit and --turns is passed, and a source the
mapping does not describe is refused rather than read.

What it does, and what it refuses to do.

One send leaves a different mark in each place, and no two marks carry the same
identity: the capture has the platform's message id and the text that went out,
the turns table has the text the model produced and the ids it was answering,
the audit has the chat and whether the send was permitted. The marks are joined
into one send each, and every record says how its join was made — the method,
the distance in milliseconds, the tolerance and how many other marks were inside
the window — so a reader can tell an observed link from an inferred one. A mark
that joined to nothing becomes a record of its own, keyed by the id its own row
carries, and says that it joined to nothing.

Every send becomes one carbon.message.v1 record with historical true, direction
outbound and source import:ledger-outbound, written through the store library
and merged by message id into what is already there. Nothing is released: a
historical record wakes no turn, and the store refuses to release one.

The mapping is read whole and refused whole before a line is read. A name that
is not a plain identifier or a dotted path of plain identifiers is refused, and
a turns query that is not a single SELECT or WITH is refused, so a mapping
cannot carry a write into a client's database.

Running this twice changes no capture byte.

Every argument is explicit and nothing is guessed. Every fault is one JSON line
of {code, subject, problem, fix}, all faults from one run are reported together,
and any fault exits non-zero.`;

function loadMapping(file: string) {
  let mapping: unknown;
  try {
    mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { mapping: null, faults: [fault('MAPPING_UNREADABLE', file,
      // Preserve the existing error-message read and fallback.
      ((error as { message?: string }).message ?? String(error)).split('\n')[0],
      'pass the path of a JSON mapping file')] };
  }
  const faults = outboundFaults(mapping, file);
  // The existing validator checked source descriptions; optional field behavior
  // remains with the original consumers instead of new validation here.
  return { mapping: faults.length > 0 ? null : mapping as OutboundMapping, faults };
}

function openTurns(file: string) {
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), faults: [] };
  } catch (error) {
    return { db: null, faults: [fault('TURNS_UNREADABLE', file,
      // Preserve the existing error-message read and fallback.
      ((error as { message?: string }).message ?? String(error)).split('\n')[0],
      'pass a SQLite database this user can read')] };
  }
}

// Every source the caller named, read into one list of items. The sources are
// read before anything is written, because the join that decides what a record
// says needs all three in hand.
function readSources(named: NamedOutbound, mapping: OutboundMapping, read: ReadCounts) {
  const outbound = mapping.outbound;
  const media = mapping.media ?? null;
  const items: OutboundItem[] = [];
  if (named['--events'] !== null) {
    read.events = emptyLineCounts();
    read.events.files = 1;
    // sourceFaults has required a matching section for this named source.
    items.push(...readLines(named['--events'], 'event', outbound.events!, media, read.events));
  }
  if (named['--audit'] !== null) {
    read.audit = emptyLineCounts();
    // sourceFaults has required a matching section for this named source.
    items.push(...readDirectory(named['--audit'], 'audit', outbound.audit!, media, read.audit));
  }
  if (named['--turns'] === null) return items;
  const opened = openTurns(named['--turns']);
  if (opened.faults.length > 0) throw new StreamFault(opened.faults);
  read.turns = emptyTurnCounts();
  try {
    // An empty open fault list means db exists; sourceFaults checked the section.
    items.push(...readTurns(opened.db!, outbound.turns!, read.turns));
  } finally {
    // The successful open above owns this database through the finally block.
    opened.db!.close();
  }
  return items;
}

function countMedia(counts: ReturnType<typeof emptyCounts>, record: MessageRecord) {
  // Preserve the existing assumed media shape on merged outbound records.
  for (const one of (record.adapter_fields?.media as ImportFields['media']) ?? []) {
    counts.attachments_referenced++;
    if (one.present === true) counts.attachments_present++;
    else if (one.present === false) counts.attachments_absent++;
    else counts.attachments_unchecked++;
  }
}

function emptyCounts() {
  return {
    records_written: 0,
    records_merged_into_an_existing_capture: 0,
    sends_whose_message_id_an_earlier_import_already_wrote: 0,
    // These initially empty dictionaries count source, role and identification strings.
    by_earlier_source: {} as Record<string, number>,
    // String-keyed role counter populated by countRecord.
    by_role: {} as Record<string, number>,
    // String-keyed identification counter populated by countRecord.
    by_identified_by: {} as Record<string, number>,
    reply_links: 0,
    answers_named: 0,
    answers_resolving_to_a_record_in_the_store: 0,
    attachments_referenced: 0,
    attachments_present: 0,
    attachments_absent: 0,
    attachments_unchecked: 0
  };
}

function countRecord(state: CountState, result: { record: MessageRecord; merged: boolean }) {
  const record = result.record;
  const counts = state.counts;
  counts.records_written++;
  if (result.merged) counts.records_merged_into_an_existing_capture++;
  state.conversations.add(record.conversation_id);
  // A message id an earlier import already wrote keeps what that import wrote:
  // the store has no overwrite and never will. So this send did not land, and
  // what is counted here is that, by name, rather than a count of records that
  // quietly describes somebody else's.
  if (record.source !== SOURCE) {
    counts.sends_whose_message_id_an_earlier_import_already_wrote++;
    counts.by_earlier_source[record.source] = (counts.by_earlier_source[record.source] ?? 0) + 1;
    return;
  }
  counts.by_role[record.role] = (counts.by_role[record.role] ?? 0) + 1;
  // Existing outbound fields are read after store merging without coercion.
  const how = (record.adapter_fields?.identified_by as string | undefined) ?? 'unknown';
  counts.by_identified_by[how] = (counts.by_identified_by[how] ?? 0) + 1;
  if (record.reply_to) counts.reply_links++;
  // Preserve the original array consumption of retained outbound fields.
  counts.answers_named += ((record.adapter_fields?.answers as string[] | undefined) ?? []).length;
  counts.answers_resolving_to_a_record_in_the_store += resolvedAnswers(state.store, record);
  const at = record.sent_at ?? record.received_at;
  if (at) {
    if (state.earliest === null || at < state.earliest) state.earliest = at;
    if (state.latest === null || at > state.latest) state.latest = at;
  }
  countMedia(counts, record);
}

function summary(context: OutboundContext & { mapping: OutboundMapping }, state: CountState, read: ReadCounts, joined: ReturnType<typeof joinOutbound>['counts'], started: number) {
  return {
    agent: context.agent,
    account: context.account,
    ledger: context.mapping.ledger ?? null,
    tolerance_ms: context.tolerance_ms,
    read,
    marks: joined,
    sends: joined.event + joined.alone.turn + joined.alone.audit,
    conversations: state.conversations.size,
    ...state.counts,
    earliest_send: state.earliest,
    latest_send: state.latest,
    elapsed_ms: Date.now() - started,
    released: 0
  };
}

function outboundMain(named: NamedOutbound) {
  const read = loadMapping(named['--mapping']);
  if (read.faults.length > 0) return { faults: read.faults, summary: null };
  // loadMapping returns a mapping whenever its fault list is empty.
  const mapping = read.mapping!;

  const agent = named['--agent'] ?? (typeof mapping.agent === 'string' ? mapping.agent : null);
  if (agent === null) {
    return { faults: [fault('MISSING_ARGUMENT', '--agent',
      'neither the command nor the mapping names the agent this history belongs to',
      'pass --agent <id>')], summary: null };
  }
  const described = sourceFaults(named, mapping);
  if (described.length > 0) return { faults: described, summary: null };

  const store = Store.open(named['--store']);
  const resolved = resolveAccount(store,
    named['--account'] ?? (typeof mapping.account === 'string' ? mapping.account : null));
  if (resolved.faults.length > 0) return { faults: resolved.faults, summary: null };

  const context = { store, agent, // resolveAccount returns an account whenever its fault list is empty.
    account: resolved.account!, mapping, tolerance_ms: toleranceMs(mapping) };
  const started = Date.now();
  const sources = {};
  const items = readSources(named, mapping, sources);
  const { entries, counts: joined } = payload(context, items);
  const state: CountState = { store, counts: emptyCounts(), conversations: new Set(), earliest: null, latest: null };
  for (const result of writeEntries(context, entries)) countRecord(state, result);
  return { faults: [], summary: summary(context, state, sources, joined, started) };
}

export function runOutbound(named: NamedOutbound) {
  let result;
  try {
    result = outboundMain(named);
  } catch (error) {
    report(error instanceof StreamFault ? error.faults : [fault('IMPORT_FAILED', named['--mapping'],
      // Preserve the existing error-message read and fallback.
      ((error as { message?: string }).message ?? String(error)).split('\n')[0],
      'read the fault above; nothing after this point was written')]);
    return 1;
  }
  if (result.faults.length > 0) {
    report(result.faults);
    return 1;
  }
  console.log(JSON.stringify(result.summary, null, 2));
  return 0;
}
