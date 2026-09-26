// The store: the one place a record lands, whichever adapter wrote it.
//
// Everything an agent knows about what arrived and what it sent is files under
// one directory, and those files are the client's data on the client's box.
// There is no delete path here and there never will be one: a client agent
// keeps what arrived.
//
// Layout, under the store directory (created 0700):
//
//   captures/<C>/<M>.json                 the record, revision 0
//   captures/<C>/<M>.<n>.json             the record, revision n; never an overwrite
//   captures/<C>/<M>[.<n>].raw            the raw payload, appended and fsynced first
//   captures/<C>/<M>[.<n>].attachments/<sha256>   one file per attachment, 0600
//   index.jsonl                           one line per record first seen, appended
//   cursors/<C>.json                      the two capture cursors for a conversation
//   threads/<U>.json                      one file per unit of work
//   outbound/requests/<R>.json            the reply fence, one file per request id
//   teachings/<id>.json                   one thing the client taught this agent
//   seq                                   the store's monotonic ordinal
//
// <C>, <M>, <U> and <R> are encoded by stream/encode.ts, which also refuses an
// identifier shaped like an escape before anything is written.
//
// The write order is the contract: the raw payload is appended and fsynced, the
// record is written, the disposition is written, and then the capture cursor is
// advanced. A record write that throws still advances the cursor, so a payload
// nothing can parse is not read forever; the raw file it left behind is the
// recovery record.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault, type Fault } from './faults.ts';
import { validate, type JsonSchema } from './validate.ts';
import { componentFaults, encodeComponent, resolveUnderStore } from './encode.ts';

export type MessageDisposition = 'captured' | 'held' | 'parked' | 'policy-drop' | 'unsupported' | 'permanent-error';
export type MessageRole = 'contact' | 'operator' | 'agent' | 'system';
export type Delivery = {
  request_id: string;
  status: string;
  text_sha256?: string;
  chunk_ids?: string[];
  completed_at?: string;
  [key: string]: unknown;
};
export type MessageRecord<TAttachment = unknown> = {
  [key: string]: unknown;
  schema: string;
  agent: string;
  source: string;
  account: string;
  conversation_id: string;
  conversation_kind: string;
  message_id: string;
  platform_message_id: string;
  revision: number;
  direction: 'inbound' | 'outbound';
  role: MessageRole;
  sender_id: string;
  sender_name?: string;
  received_at: string;
  sent_at?: string;
  body: string;
  attachments: TAttachment[];
  historical: boolean;
  disposition: MessageDisposition;
  hold?: { reason: string; set_at: string; release_after_ms?: number };
  release?: { released_at: string; thread_id: string; turn_id: string; completed_at?: string };
  delivery?: Delivery;
  adapter_fields?: Record<string, unknown>;
  raw?: string;
  reply_to?: string;
};
export type Attachment = {
  file: string;
  mime: string;
  bytes: number;
  sha256: string;
  download_failed?: boolean;
  filename?: string;
};
type MessageIdentity = Pick<MessageRecord, 'conversation_id' | 'message_id'> & { revision?: number };
type RecordPaths = { conversationDir: string; record: string; raw: string; attachments: string };
type CaptureOptions<T extends MessageRecord> = {
  raw?: string;
  cursor?: { kind: 'message' | 'revision'; position: string };
  disposition?: T['disposition'];
};
// Parking replaces disposition and adapter fields, while retaining named extension
// fields. The disposition stays broad: a merge or options may keep another state.
type ParkedRecord<T extends MessageRecord> = {
  [K in keyof T as K extends 'disposition' | 'adapter_fields' ? never : K]: T[K];
} & MessageRecord<T['attachments'][number]>;

type CaptureResult<T extends MessageRecord> = { file: string; seq: number; merged: boolean; record: T };
type CursorState = { message: string | null; revision: string | null };
type ReplyRequest = {
  request_id: string;
  status: string;
  conversation_id: string;
  message_id: string;
  revision?: number;
  chunk_ids?: string[];
};
type ThreadRecord = { unit_id: string; [key: string]: unknown };
type ReplyOutcome<T extends MessageRecord> =
  | { fenced: 'sent'; chunk_ids: string[]; message_id: string }
  | { fenced: null; record: T & { delivery: Delivery }; file: string };

// JSON.parse has no schema type; this checked-in JSON Schema is consumed by the validator below.
const SCHEMA: JsonSchema = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'schema', 'carbon.message.v1.json'), 'utf8'));

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// An import merges into what a live adapter already captured; a live adapter
// never merges into another's record. There is more than one import — an export
// and a client's own SQLite ledger are both the client's past — and what makes
// one of them a merging source is that it is an import, not which import it is.
const MERGING_PREFIX = 'import:';

function merges(source: unknown): boolean {
  return typeof source === 'string' && source.startsWith(MERGING_PREFIX);
}

let tempCounter = 0;

export class StreamFault extends Error {
  declare readonly faults: Fault[];

  constructor(faults: Fault[]) {
    super(faults.map((f) => `${f.code} ${f.subject}: ${f.problem}`).join('\n'));
    this.name = 'StreamFault';
    this.faults = faults;
  }
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Exported because an adapter keeps state of its own beside the captures — a
// channel's connection state, a chat-key map, a terminal latch — and that state
// is written by the same rule as a record: temp, fsync, rename, fsync the
// directory. There is one write order in this library and no adapter invents a
// second one.
export function writeAtomic(file: string, data: string | Uint8Array, mode = FILE_MODE): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.temp-${process.pid}-${tempCounter++}`);
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fsyncDir(dir);
}

function appendFsync(file: string, data: string | Uint8Array, mode = FILE_MODE): void {
  const existed = fs.existsSync(file);
  const fd = fs.openSync(file, 'a', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fsyncDir(path.dirname(file));
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

function sha256(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function millis(stamp: string): number | null {
  const value = Date.parse(stamp);
  return Number.isNaN(value) ? null : value;
}

export function recordFileName(encodedMessageId: string, revision: number): string {
  return revision === 0 ? `${encodedMessageId}.json` : `${encodedMessageId}.${revision}.json`;
}

export class Store<TRecord extends MessageRecord = MessageRecord> {
  declare dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  // Open a store, creating the tree if it is not there. The store directory is
  // 0700 because everything under it is the client's.
  static open<TRecord extends MessageRecord = MessageRecord>(dir: string): Store<TRecord> {
    const store = new Store<TRecord>(dir);
    mkdirp(store.dir);
    fs.chmodSync(store.dir, DIR_MODE);
    for (const sub of ['captures', 'cursors', 'threads', 'teachings', path.join('outbound', 'requests')]) {
      mkdirp(path.join(store.dir, sub));
    }
    return store;
  }

  under(...components: string[]): string {
    return resolveUnderStore(this.dir, ...components);
  }

  relative(file: string): string {
    return path.relative(this.dir, file);
  }

  // ---- ordinals -----------------------------------------------------------

  nextSeq(): number {
    const file = this.under('seq');
    let value = 0;
    try { value = Number(fs.readFileSync(file, 'utf8').trim()) || 0; } catch { value = 0; }
    const next = value + 1;
    writeAtomic(file, `${next}\n`);
    return next;
  }

  // ---- paths --------------------------------------------------------------

  // Every path the store derives goes through here, so the refusal and the
  // encoding cannot be skipped by a caller that builds a path itself.
  paths(record: MessageIdentity): RecordPaths {
    const faults = [
      ...componentFaults('conversation_id', record.conversation_id),
      ...componentFaults('message_id', record.message_id)
    ];
    if (faults.length > 0) throw new StreamFault(faults);
    const revision = record.revision ?? 0;
    const conversation = encodeComponent(record.conversation_id);
    const message = encodeComponent(record.message_id);
    const dir = this.under('captures', conversation);
    const stem = revision === 0 ? message : `${message}.${revision}`;
    return {
      conversationDir: dir,
      record: path.join(dir, `${stem}.json`),
      raw: path.join(dir, `${stem}.raw`),
      attachments: path.join(dir, `${stem}.attachments`)
    };
  }

  // ---- capture ------------------------------------------------------------

  // Write one record. Returns { file, seq, merged }.
  //
  // options.raw       the raw payload, appended and fsynced before the record
  // options.cursor    { kind: 'message' | 'revision', position } advanced last,
  //                   and advanced even when the record write throws
  // options.disposition  written as its own step after the record
  capture<T extends TRecord | ParkedRecord<TRecord>>(record: T, options: CaptureOptions<T> = {}): CaptureResult<T> {
    const faults = validate(SCHEMA, record, '$', 'carbon.message.v1');
    if (faults.length > 0) throw new StreamFault(faults);

    const places = this.paths(record);
    const seq = this.nextSeq();
    try {
      mkdirp(places.conversationDir);
      if (options.raw !== undefined) {
        appendFsync(places.raw, options.raw.endsWith('\n') ? options.raw : options.raw + '\n');
        record = { ...record, raw: this.relative(places.raw) };
      }

      let merged = false;
      let written: T = record;
      if (fs.existsSync(places.record)) {
        // Store records were schema-validated when captured; JSON.parse itself carries no record type.
        const existing: T = JSON.parse(fs.readFileSync(places.record, 'utf8'));
        if (existing.source !== record.source && !merges(record.source)) {
          throw new StreamFault([fault('MESSAGE_ID_CLAIMED', record.message_id,
            `this message_id is already written by the adapter whose source is ${existing.source}`,
            'two live adapters cannot write one message_id; give the record its own conversation-scoped id')]);
        }
        written = mergeRecords(existing, record);
        merged = true;
        if (JSON.stringify(written) !== JSON.stringify(existing)) {
          writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
        }
      } else {
        writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
        this.appendIndex(written, seq, places.record);
      }

      if (options.disposition !== undefined && options.disposition !== written.disposition) {
        written = this.setDisposition(written, options.disposition);
      }
      return { file: places.record, seq, merged, record: written };
    } finally {
      if (options.cursor) {
        this.advanceCursor(record.conversation_id, options.cursor.kind, options.cursor.position);
      }
    }
  }

  // A payload nothing can parse is kept where it landed and never delivered.
  park(record: TRecord, reason: string, options: CaptureOptions<TRecord> = {}): CaptureResult<ParkedRecord<TRecord>> {
    const parked = {
      ...record,
      disposition: 'parked',
      adapter_fields: { ...(record.adapter_fields ?? {}), park_reason: reason }
    };
    return this.capture<ParkedRecord<TRecord>>(parked, options);
  }

  // A record that was captured and then could not be released. Parking it is
  // what keeps one record the runtime cannot handle from stopping the channel:
  // the fault is written on the record where the next reader looks for it, the
  // record is never released again, and the loop moves to the next one.
  parkFailed(record: TRecord, faults: Fault | Fault[], { reason = null }: { reason?: string | null } = {}): MessageRecord {
    const all: Fault[] = Array.isArray(faults) ? faults : [faults];
    const places = this.paths(record);
    // Store records were schema-validated when captured; JSON.parse itself carries no record type.
    const on_disk: MessageRecord = JSON.parse(fs.readFileSync(places.record, 'utf8'));
    const written: MessageRecord = {
      ...on_disk,
      disposition: 'parked',
      adapter_fields: {
        ...(on_disk.adapter_fields ?? {}),
        park_reason: reason ?? all.map((f) => `${f.code} ${f.subject}: ${f.problem}`).join('; '),
        park_faults: all
      }
    };
    writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
    return written;
  }

  // Fields carbon itself puts on a record after it was captured. They go under
  // adapter_fields, which is the one place the message schema carries keys it
  // does not name, and they never touch what the adapter wrote.
  annotate(record: TRecord, fields: Record<string, unknown>): MessageRecord {
    const places = this.paths(record);
    // Store records were schema-validated when captured; JSON.parse itself carries no record type.
    const on_disk: MessageRecord = JSON.parse(fs.readFileSync(places.record, 'utf8'));
    const written = { ...on_disk, adapter_fields: { ...(on_disk.adapter_fields ?? {}), ...fields } };
    writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
    return written;
  }

  setDisposition<T extends TRecord | ParkedRecord<TRecord>>(record: T, disposition: T['disposition']): T {
    const places = this.paths(record);
    // Store records were schema-validated when captured; JSON.parse itself carries no record type.
    const on_disk: T = JSON.parse(fs.readFileSync(places.record, 'utf8'));
    const written: T = { ...on_disk, disposition };
    writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
    return written;
  }

  // ---- attachments --------------------------------------------------------

  // Attachments sit beside their record, named by their own sha256, written
  // 0600 with no execute bit. Content addressing is what makes the merge of a
  // repeated write converge: a union by sha256 is a union of file names.
  putAttachment(record: MessageIdentity, bytes: Uint8Array, meta: { mime?: string; filename?: string } = {}): Attachment {
    const places = this.paths(record);
    mkdirp(places.attachments);
    const digest = sha256(bytes);
    const file = path.join(places.attachments, digest);
    if (!fs.existsSync(file)) writeAtomic(file, bytes);
    fs.chmodSync(file, FILE_MODE);
    // The name the sender gave the part is kept. The file on disk is named by
    // its digest, which is what makes a repeated write converge, so the sender's
    // name has nowhere else to live; without it the turn input can say a file
    // arrived but not which file the message's own text is talking about.
    const written: Attachment = {
      file: this.relative(file),
      mime: meta.mime ?? 'application/octet-stream',
      bytes: bytes.length,
      sha256: digest
    };
    if (typeof meta.filename === 'string' && meta.filename.length > 0) written.filename = meta.filename;
    return written;
  }

  attachmentIntact(attachment: Attachment): boolean {
    if (attachment.download_failed === true) return true;
    const file = this.under(attachment.file);
    if (!fs.existsSync(file)) return false;
    return sha256(fs.readFileSync(file)) === attachment.sha256;
  }

  // ---- index --------------------------------------------------------------

  appendIndex(record: MessageRecord, seq: number, file: string): void {
    const line = {
      seq,
      message_id: record.message_id,
      revision: record.revision,
      conversation_id: record.conversation_id,
      source: record.source,
      direction: record.direction,
      historical: record.historical,
      first_seen_at: new Date().toISOString(),
      file: this.relative(file)
    };
    appendFsync(this.under('index.jsonl'), JSON.stringify(line) + '\n');
  }

  indexEntries(): unknown[] {
    try {
      return fs.readFileSync(this.under('index.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // ---- reads --------------------------------------------------------------

  // Read one record file and refuse it if the file name, the conversation
  // directory and the content disagree, because a record that has been moved is
  // a record whose identity is no longer the one the store derived.
  readAt(file: string): TRecord {
    // Store records were schema-validated when captured; JSON.parse itself carries no record type.
    const record: TRecord = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = this.paths(record).record;
    if (path.resolve(file) !== expected) {
      throw new StreamFault([fault('RECORD_MISPLACED', this.relative(file),
        `the record names conversation ${record.conversation_id} and message ${record.message_id}, which derive ${this.relative(expected)}`,
        'the record has been moved or renamed; restore it to the path its own identity derives')]);
    }
    return record;
  }

  read(conversation_id: string, message_id: string, revision = 0): TRecord | null {
    const places = this.paths({ conversation_id, message_id, revision });
    if (!fs.existsSync(places.record)) return null;
    return this.readAt(places.record);
  }

  conversations(): string[] {
    const dir = this.under('captures');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
  }

  // Every record rebuilt from the files themselves. Case 11 compares this with
  // the index.
  rebuild(): TRecord[] {
    const records: TRecord[] = [];
    for (const conversation of this.conversations()) {
      const dir = this.under('captures', conversation);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        records.push(this.readAt(path.join(dir, name)));
      }
    }
    return records;
  }

  recordsIn(conversation_id: string): TRecord[] {
    const faults = componentFaults('conversation_id', conversation_id);
    if (faults.length > 0) throw new StreamFault(faults);
    const dir = this.under('captures', encodeComponent(conversation_id));
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => this.readAt(path.join(dir, name)));
  }

  // ---- cursors ------------------------------------------------------------

  // Two capture cursors per conversation. The message cursor says how far the
  // adapter has read the conversation's messages; the revision cursor says how
  // far it has read their edits. They are separate because a contact's
  // correction of an old message sits below the message cursor and must still
  // be captured and released.
  //
  // A cursor position is an opaque string the adapter mints. The store orders
  // positions lexicographically and never moves a cursor backwards, so an
  // adapter must mint positions that sort in channel order: zero-padded
  // integers, or a zero-padded (uidvalidity, uid) pair for a mailbox.
  cursorFile(conversation_id: string): string {
    const faults = componentFaults('conversation_id', conversation_id);
    if (faults.length > 0) throw new StreamFault(faults);
    return this.under('cursors', `${encodeComponent(conversation_id)}.json`);
  }

  cursors(conversation_id: string): CursorState {
    const file = this.cursorFile(conversation_id);
    if (!fs.existsSync(file)) return { message: null, revision: null };
    // Cursor files are written by advanceCursor; JSON.parse itself carries no cursor type.
    const cursors: CursorState = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cursors;
  }

  advanceCursor(conversation_id: string, kind: string, position: string): CursorState {
    if (kind !== 'message' && kind !== 'revision') {
      throw new StreamFault([fault('CURSOR_KIND_UNKNOWN', String(kind),
        'a conversation has exactly two cursors, message and revision',
        'pass message or revision')]);
    }
    const current = this.cursors(conversation_id);
    if (current[kind] !== null && String(position) <= current[kind]) return current;
    const next = { ...current, [kind]: String(position) };
    writeAtomic(this.cursorFile(conversation_id), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  // ---- holds and release --------------------------------------------------

  // An operator's own message in a conversation holds the agent. The hold sits
  // on the operator's record; when it releases is the declaration's business,
  // carried here as release_after_ms. A hold with no release_after_ms does not
  // expire on time and is lifted by whatever the declaration names.
  heldUntil(conversation_id: string): number | null {
    let until = null;
    for (const record of this.recordsIn(conversation_id)) {
      if (!record.hold) continue;
      const set_at = millis(record.hold.set_at);
      if (set_at === null) continue;
      if (record.hold.release_after_ms === undefined) return Infinity;
      until = Math.max(until ?? 0, set_at + record.hold.release_after_ms);
    }
    return until;
  }

  isHeld(conversation_id: string, now = Date.now()): boolean {
    const until = this.heldUntil(conversation_id);
    return until !== null && now < until;
  }

  // A record is released to the agent by writing the release on it before the
  // turn starts, so a restart mid-turn can tell an open release from a finished
  // one. A historical record never releases; a held or parked one does not
  // release yet.
  release(record: TRecord, { released_at, thread_id, turn_id, now = Date.now(), hold_applies = true }: {
    released_at: string; thread_id: string; turn_id: string; now?: number; hold_applies?: boolean;
  }): MessageRecord {
    const faults: Fault[] = [];
    if (record.historical === true) {
      faults.push(fault('HISTORICAL_NEVER_RELEASES', record.message_id,
        'a historical record is the client\'s own past and releases no turn',
        'import history with historical true and release nothing from it'));
    }
    if (record.disposition === 'parked') {
      faults.push(fault('PARKED_NEVER_RELEASES', record.message_id,
        'a parked record was never understood and is not delivered',
        'fix the adapter and capture the payload again; the parked record stays where it is'));
    }
    // `hold_applies` is the caller saying whether the hold on this conversation
    // is one that governs it. It does in a customer conversation and it does not
    // in an ops or the management conversation, which is the declaration's
    // business and not this library's: the store knows what a hold is and the
    // release loop knows which rooms it is right in.
    if (hold_applies && this.isHeld(record.conversation_id, now)) {
      faults.push(fault('CONVERSATION_HELD', record.conversation_id,
        'an operator message holds this conversation',
        'release after the hold expires, per the declaration'));
    }
    const places = this.paths(record);
    if (!fs.existsSync(places.record)) {
      faults.push(fault('CAPTURE_BEFORE_RELEASE', record.message_id,
        'the capture is not on disk, so there is nothing to release',
        'capture the record before deciding to release it'));
    }
    if (faults.length > 0) throw new StreamFault(faults);

    const on_disk = this.readAt(places.record);
    const written = { ...on_disk, release: { released_at, thread_id, turn_id } };
    writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
    return written;
  }

  completeRelease(record: TRecord, completed_at: string): MessageRecord {
    const places = this.paths(record);
    const on_disk = this.readAt(places.record);
    const written = { ...on_disk, release: { ...on_disk.release, completed_at } };
    writeAtomic(places.record, JSON.stringify(written, null, 2) + '\n');
    return written;
  }

  // ---- outbound -----------------------------------------------------------

  requestFile(request_id: string): string {
    const faults = componentFaults('request_id', request_id);
    if (faults.length > 0) throw new StreamFault(faults);
    return this.under('outbound', 'requests', `${encodeComponent(request_id)}.json`);
  }

  readRequest(request_id: string): ReplyRequest | null {
    const file = this.requestFile(request_id);
    if (!fs.existsSync(file)) return null;
    // Request files are written by reply() and settleDelivery(); JSON.parse itself carries no request type.
    const request: ReplyRequest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return request;
  }

  // The reply tool's one door. The outbound record exists as pending before any
  // transport is called, and the request id is the fence:
  //
  //   already sent     the stored chunk ids come back and nothing is sent again
  //   already pending  refused; one reply is in flight and a second is a second reply
  //   already unknown  refused; an uncertain send is never retried blindly
  //   already failed   allowed; a failure is a known non-delivery, so a new
  //                    request under the same id is a retry of something that
  //                    demonstrably did not arrive
  //
  // `status` is the status the reply is written at, and there are two. `pending`
  // is a reply the deliver pass sends on the next sweep. `pending-teach-check` is
  // a reply written in the management conversation and held where it is until its
  // own turn completes and the runtime has asked whether what the client taught
  // was recorded; the deliver pass sends `pending` and nothing else, so a held
  // reply cannot leave the box by any path, including a restart that recovers a
  // written reply. Which of the two a reply is written at is the caller's, not
  // this library's: the store knows what a held reply is and the runtime knows
  // which room holds one.
  reply(record: TRecord, { status = 'pending' }: { status?: string } = {}): ReplyOutcome<TRecord> {
    const faults: Fault[] = [];
    if (status !== 'pending' && status !== 'pending-teach-check') {
      faults.push(fault('REPLY_STATUS_UNWRITABLE', String(status),
        'a reply is written pending, or pending-teach-check when it is held until its turn completes, and never at any other status',
        'write the reply at pending, or at pending-teach-check to hold it; a sent, unknown or failed status is settled later and never written here'));
    }
    if (record.direction !== 'outbound') {
      faults.push(fault('REPLY_NOT_OUTBOUND', record.message_id,
        'a reply is an outbound record',
        'set direction to outbound'));
    }
    if (!record.delivery || !record.delivery.request_id) {
      faults.push(fault('REPLY_WITHOUT_REQUEST_ID', record.message_id,
        'a reply carries a delivery with a request_id, which is the fence against sending twice',
        'give the reply a request_id'));
    }
    const owned = this.recordsIn(record.conversation_id).filter((r) => r.direction === 'inbound');
    if (owned.length === 0) {
      faults.push(fault('CONVERSATION_NOT_OWNED', record.conversation_id,
        'this agent has captured nothing on this conversation, so it does not answer on it',
        'reply on a conversation this agent owns'));
    } else if (!owned.some((r) => r.account === record.account)) {
      faults.push(fault('REPLY_ACCOUNT_MISMATCH', record.account,
        `the conversation arrived on ${owned[0].account} and the reply goes out on ${record.account}`,
        'answer on the account the inbound arrived on'));
    }
    if (faults.length > 0) throw new StreamFault(faults);

    // The earlier validation refusal guarantees this delivery exists; this assertion is type-only.
    const delivery = record.delivery!;
    const existing = this.readRequest(delivery.request_id);
    if (existing && existing.status === 'sent') {
      return { fenced: 'sent', chunk_ids: existing.chunk_ids ?? [], message_id: existing.message_id };
    }
    // A held reply is a written reply, so it fences the same way: one request id
    // is one reply, whether it is waiting for the transport or for the check.
    if (existing && (existing.status === 'pending' || existing.status === 'pending-teach-check')) {
      throw new StreamFault([fault('REQUEST_ALREADY_PENDING', delivery.request_id,
        existing.status === 'pending-teach-check'
          ? 'a reply with this request_id is already written and is held until this turn completes'
          : 'a reply with this request_id is already written and not yet sent',
        'wait for the send to finish; do not write a second reply under one request id')]);
    }
    if (existing && existing.status === 'unknown') {
      throw new StreamFault([fault('DELIVERY_UNKNOWN_NEVER_RETRIED', delivery.request_id,
        'this reply\'s acceptance is unknown, and an uncertain send is never retried blindly',
        'a person decides what happened to this send')]);
    }

    const pending: TRecord & { delivery: Delivery } = {
      ...record,
      delivery: { ...delivery, status }
    };
    const result = this.capture(pending);
    writeAtomic(this.requestFile(delivery.request_id), JSON.stringify({
      request_id: delivery.request_id,
      status,
      conversation_id: record.conversation_id,
      message_id: record.message_id,
      revision: record.revision,
      chunk_ids: []
    }, null, 2) + '\n');
    return { fenced: null, record: result.record, file: result.file };
  }

  settleDelivery(request_id: string, status: string, extra: { chunk_ids?: string[]; completed_at?: string } = {}): TRecord {
    const request = this.readRequest(request_id);
    if (!request) {
      throw new StreamFault([fault('REQUEST_UNKNOWN', request_id,
        'no reply was written under this request id',
        'write the reply before settling its delivery')]);
    }
    // A written request names its captured record; keep the original null-dereference failure if that link is broken.
    const record = this.read(request.conversation_id, request.message_id, request.revision ?? 0)!;
    const delivery = { ...record.delivery, status, ...extra };
    const places = this.paths(record);
    writeAtomic(places.record, JSON.stringify({ ...record, delivery }, null, 2) + '\n');
    writeAtomic(this.requestFile(request_id), JSON.stringify({
      ...request, status, chunk_ids: extra.chunk_ids ?? request.chunk_ids ?? []
    }, null, 2) + '\n');
    return { ...record, delivery };
  }

  // A held reply, let go. It becomes an ordinary pending reply and the next
  // deliver pass sends it; its text is not touched, because the runtime never
  // rewrites what the model said, and the record is the one the reply tool wrote.
  releaseHeldReply(request_id: string): TRecord {
    const request = this.readRequest(request_id);
    if (!request || request.status !== 'pending-teach-check') {
      throw new StreamFault([fault('REPLY_NOT_HELD', request_id,
        request
          ? `the reply under this request id is ${request.status} and only a reply held at pending-teach-check is let go`
          : 'no reply was written under this request id, so there is nothing held',
        'let go only a reply this runtime held for the teach check')]);
    }
    return this.settleDelivery(request_id, 'pending');
  }

  // Every chunk id a split reply produced is written back, so a person reading
  // the store can find each piece on the channel.
  markSent(request_id: string, chunk_ids: string[], completed_at = new Date().toISOString()): TRecord {
    return this.settleDelivery(request_id, 'sent', { chunk_ids, completed_at });
  }

  markUnknown(request_id: string, completed_at = new Date().toISOString()): TRecord {
    return this.settleDelivery(request_id, 'unknown', { completed_at });
  }

  markFailed(request_id: string, completed_at = new Date().toISOString()): TRecord {
    return this.settleDelivery(request_id, 'failed', { completed_at });
  }

  // ---- threads ------------------------------------------------------------

  threadFile(unit_id: string): string {
    const faults = componentFaults('unit_id', unit_id);
    if (faults.length > 0) throw new StreamFault(faults);
    return this.under('threads', `${encodeComponent(unit_id)}.json`);
  }

  writeThread(unit_id: string, data: Record<string, unknown>): void {
    writeAtomic(this.threadFile(unit_id), JSON.stringify({ unit_id, ...data }, null, 2) + '\n');
  }

  readThread(unit_id: string): ThreadRecord | null {
    const file = this.threadFile(unit_id);
    if (!fs.existsSync(file)) return null;
    // Thread files are written by writeThread(); JSON.parse itself carries no thread type.
    const thread: ThreadRecord = JSON.parse(fs.readFileSync(file, 'utf8'));
    return thread;
  }
}

// A repeated write of one record merges rather than clobbers. The first body
// and the first times win, so a re-run of an import changes no capture bytes;
// attachments are a union by sha256, so a second write that carries a file the
// first did not adds it and nothing else.
function attachmentSha256(value: unknown): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading 'sha256')`);
  }
  // Reflect.get preserves the original property's getter/proxy behavior; its untyped result stays unknown here.
  const digest: unknown = Reflect.get(Object(value), 'sha256');
  return digest;
}

export function mergeRecords<TAttachment, T extends MessageRecord<TAttachment>>(
  existing: T,
  incoming: T
): T {
  const attachments = [...(existing.attachments ?? [])];
  const seen = new Set(attachments.map(attachmentSha256));
  for (const attachment of incoming.attachments ?? []) {
    const digest = attachmentSha256(attachment);
    if (!seen.has(digest)) {
      seen.add(digest);
      attachments.push(attachment);
    }
  }
  return { ...existing, attachments };
}
