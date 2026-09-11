// Reading the three places an agent's own sends were recorded.
//
// Two of them are JSON lines a running process appended — one line per thing
// that happened, and a line that nothing can parse is counted rather than
// thrown, because a truncated last line is what an append-only file looks like
// while the process that owns it is still running. The third is a SQLite table,
// read through one SELECT the mapping wrote and nothing else.
//
// Every file here is opened read-only and never written, and the names of what
// is inside come from `outbound-mapping.mjs`, so nothing in this module knows a
// client either.

import fs from 'node:fs';
import path from 'node:path';
import { fault } from '../stream/faults.mjs';
import { StreamFault } from '../stream/store.mjs';
import { itemFrom, selects, turnItem, turnRowFaults, valueAt } from './outbound-mapping.mjs';

const LINE_SUFFIX = '.jsonl';
const CHUNK = 1 << 20;

// A JSON-lines file read a megabyte at a time, so a capture file of any size is
// read without holding it. It is read synchronously because the command around
// it is: one import is one thing happening, and an await here would make every
// caller of it asynchronous for no gain.
function eachLine(file, take) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let rest = '';
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      const lines = (rest + buffer.toString('utf8', 0, read)).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) take(line);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (rest.length > 0) take(rest);
}

// One line becomes an item, or it becomes a count of why it did not. A line
// nothing can parse is counted rather than thrown: a half-written last line is
// what an append-only file looks like while the process that owns it is running.
function takeLine(line, kind, section, media, counts, items) {
  if (line.trim().length === 0) return;
  counts.lines++;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    counts.unparseable++;
    return;
  }
  const holder = section.record ? valueAt(parsed, section.record) : parsed;
  if (holder === null || typeof holder !== 'object') { counts.without_the_named_record++; return; }
  if (!selects(section, holder)) return;
  const item = itemFrom(kind, section, holder, media);
  if (item.message_id.length === 0 || item.chat_jid.length === 0) { counts.without_an_id_or_a_chat++; return; }
  counts.selected++;
  items.push(item);
}

export function readLines(file, kind, section, media, counts) {
  const items = [];
  eachLine(file, (line) => takeLine(line, kind, section, media, counts, items));
  return items;
}

export function emptyLineCounts() {
  return { files: 0, lines: 0, unparseable: 0, without_the_named_record: 0, without_an_id_or_a_chat: 0, selected: 0 };
}

// A directory of daily files is one source. They are read in name order so two
// runs read them in the same order, and a file that is not one of these lines is
// not opened at all.
export function readDirectory(dir, kind, section, media, counts) {
  const items = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(LINE_SUFFIX)) continue;
    counts.files++;
    items.push(...readLines(path.join(dir, name), kind, section, media, counts));
  }
  return items;
}

// The turns table, through the mapping's own SELECT. The first row is checked
// against the names the query had to produce, so a query that named none of them
// is refused before a record is written rather than after half a history is in
// the store.
export function readTurns(db, section, counts) {
  const items = [];
  let checked = false;
  for (const row of db.prepare(section.sql).iterate()) {
    counts.rows++;
    if (!checked) {
      const faults = turnRowFaults(row);
      if (faults.length > 0) throw new StreamFault(faults);
      checked = true;
    }
    const item = turnItem(section, row);
    if (item.message_id.length === 0 || item.chat_jid.length === 0) { counts.without_an_id_or_a_chat++; continue; }
    counts.selected++;
    items.push(item);
  }
  return items;
}

export function emptyTurnCounts() {
  return { rows: 0, without_an_id_or_a_chat: 0, selected: 0 };
}

// A source named on the command line that is not there is a fault, and a source
// the mapping does not describe is a fault too: an import that quietly read two
// of the three places would report a history with a hole in it.
export function sourceFaults(named, mapping) {
  const outbound = mapping?.outbound ?? {};
  const faults = [];
  const wanted = [['--events', 'events', 'file'], ['--audit', 'audit', 'directory'], ['--turns', 'turns', 'file']];
  for (const [argument, section, kind] of wanted) {
    const given = named[argument];
    if (given === null) continue;
    if (outbound[section] === undefined) {
      faults.push(fault('OUTBOUND_SOURCE_UNDESCRIBED', argument,
        `the mapping has no outbound.${section} section, so nothing says what is inside this source`,
        `describe outbound.${section} in the mapping, or do not pass ${argument}`));
    }
    if (!fs.existsSync(given)) {
      faults.push(fault('OUTBOUND_SOURCE_MISSING', given,
        `there is no ${kind} at this path`,
        `pass an existing ${kind} to ${argument}`));
    }
  }
  if (wanted.every(([argument]) => named[argument] === null)) {
    faults.push(fault('MISSING_ARGUMENT', '--events, --audit or --turns',
      'this import reads the places the agent\'s own sends were recorded, and none was named',
      'pass at least one of --events, --audit and --turns'));
  }
  return faults;
}
