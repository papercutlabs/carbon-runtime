// `carbon-import ledger-outbound` — the command around the outbound import.
//
// It is here rather than in `bin/` because it is the same size as the import it
// drives and `bin/carbon-import` is already one file a person reads in a
// sitting. What is in `bin/` is the argument parsing and the dispatch; what is
// here is the reading, the writing and the counting.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fault, report } from '../stream/faults.mjs';
import { Store, StreamFault } from '../stream/store.mjs';
import { SOURCE, payload, resolvedAnswers, writeEntries } from './carbon-ledger-outbound.mjs';
import { outboundFaults, toleranceMs } from './outbound-mapping.mjs';
import {
  emptyLineCounts, emptyTurnCounts, readDirectory, readLines, readTurns, sourceFaults
} from './outbound-sources.mjs';
import { resolveAccount } from './store-account.mjs';

export const OUTBOUND_HELP = `carbon-import ledger-outbound — import what a client's agent itself sent

Usage:
  carbon-import ledger-outbound --agent <id> --mapping <file> --store <dir>
                                [--events <file>] [--audit <dir>] [--turns <file>]
                                [--account <jid>]

  --agent <id>       the agent whose store this history belongs to
  --mapping <file>   the JSON mapping. Its outbound section names the three
                     places the agent's sends were recorded and the names
                     inside them; its shape is documented at the top of
                     import/outbound-mapping.mjs.
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

function loadMapping(file) {
  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { mapping: null, faults: [fault('MAPPING_UNREADABLE', file,
      (error.message ?? String(error)).split('\n')[0],
      'pass the path of a JSON mapping file')] };
  }
  const faults = outboundFaults(mapping, file);
  return { mapping: faults.length > 0 ? null : mapping, faults };
}

function openTurns(file) {
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), faults: [] };
  } catch (error) {
    return { db: null, faults: [fault('TURNS_UNREADABLE', file,
      (error.message ?? String(error)).split('\n')[0],
      'pass a SQLite database this user can read')] };
  }
}

// Every source the caller named, read into one list of items. The sources are
// read before anything is written, because the join that decides what a record
// says needs all three in hand.
function readSources(named, mapping, read) {
  const outbound = mapping.outbound;
  const media = mapping.media ?? null;
  const items = [];
  if (named['--events'] !== null) {
    read.events = emptyLineCounts();
    read.events.files = 1;
    items.push(...readLines(named['--events'], 'event', outbound.events, media, read.events));
  }
  if (named['--audit'] !== null) {
    read.audit = emptyLineCounts();
    items.push(...readDirectory(named['--audit'], 'audit', outbound.audit, media, read.audit));
  }
  if (named['--turns'] === null) return items;
  const opened = openTurns(named['--turns']);
  if (opened.faults.length > 0) throw new StreamFault(opened.faults);
  read.turns = emptyTurnCounts();
  try {
    items.push(...readTurns(opened.db, outbound.turns, read.turns));
  } finally {
    opened.db.close();
  }
  return items;
}

function countMedia(counts, record) {
  for (const one of record.adapter_fields?.media ?? []) {
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
    by_earlier_source: {},
    by_role: {},
    by_identified_by: {},
    reply_links: 0,
    answers_named: 0,
    answers_resolving_to_a_record_in_the_store: 0,
    attachments_referenced: 0,
    attachments_present: 0,
    attachments_absent: 0,
    attachments_unchecked: 0
  };
}

function countRecord(state, result) {
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
  const how = record.adapter_fields?.identified_by ?? 'unknown';
  counts.by_identified_by[how] = (counts.by_identified_by[how] ?? 0) + 1;
  if (record.reply_to) counts.reply_links++;
  counts.answers_named += (record.adapter_fields?.answers ?? []).length;
  counts.answers_resolving_to_a_record_in_the_store += resolvedAnswers(state.store, record);
  const at = record.sent_at ?? record.received_at;
  if (at) {
    if (state.earliest === null || at < state.earliest) state.earliest = at;
    if (state.latest === null || at > state.latest) state.latest = at;
  }
  countMedia(counts, record);
}

function summary(context, state, read, joined, started) {
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

function outboundMain(named) {
  const read = loadMapping(named['--mapping']);
  if (read.faults.length > 0) return { faults: read.faults, summary: null };
  const mapping = read.mapping;

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

  const context = { store, agent, account: resolved.account, mapping, tolerance_ms: toleranceMs(mapping) };
  const started = Date.now();
  const sources = {};
  const items = readSources(named, mapping, sources);
  const { entries, counts: joined } = payload(context, items);
  const state = { store, counts: emptyCounts(), conversations: new Set(), earliest: null, latest: null };
  for (const result of writeEntries(context, entries)) countRecord(state, result);
  return { faults: [], summary: summary(context, state, sources, joined, started) };
}

export function runOutbound(named) {
  let result;
  try {
    result = outboundMain(named);
  } catch (error) {
    report(error instanceof StreamFault ? error.faults : [fault('IMPORT_FAILED', named['--mapping'],
      (error.message ?? String(error)).split('\n')[0],
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
