import fs from 'node:fs';
import path from 'node:path';
import type { Harness, Log } from './types.ts';
import type { AccountRead, AccountIdentity, AccountReadError, RateLimitsRecord } from '../harness/codex/index.ts';

// Which provider account this box runs on, recorded where doctor can read it
// without anybody opening the login (PA-259).
//
// The harness's own app-server is asked, through the session this process already
// holds, `account/read` with refreshToken false and `account/rateLimits/read`. No
// second process is started on the login: a freshly started app-server refreshes
// an expired login before it answers anything, and would be a second writer of
// that file. The login file itself is only ever stat'ed, for the time it was last
// written, by a device login or by the harness's own refresh. That time is a dated
// diagnostic, not a warning before expiry.
//
// A read is asked for after the harness connects, after every turn that completed
// and on every `account/updated`. Asking returns at once; the read starts on a
// later tick, is bounded, and one runs at a time. It ends in the record whatever
// happens: a read that failed writes `error` and keeps the values it had, each
// dated by its own observed_at, so an old answer is never mistaken for a fresh
// one. An error is a fixed code and summary, never text the provider wrote.
//
// The rate limits belong to the account they were read with. When a read that
// succeeded names another account, or none, the limits held are cleared with
// their times, and only limits read beside that account are taken again.
//
// Timing. The connection's event callback does no more than merge a rate-limit
// update into the record in memory and mark the record for writing, which is
// microseconds and touches no disk. The write is queued: it starts on a later
// tick, runs its file work on the thread pool rather than the event loop, and a
// burst of changes while one write is under way becomes one more write after it.
// So neither a read nor a slow disk is ever on a turn's path, and nothing here
// throws into the caller.

export const PROVIDER_ACCOUNT_FILE = 'provider-account.json';
const LOGIN_FILE = 'auth.json';
const FILE_MODE = 0o600;

// On the pinned binary an unreachable backend took twenty seconds to fail the
// rate-limit read. This is the most a read waits for either answer.
const ACCOUNT_READ_TIMEOUT_MS = 15_000;

// The harness bounds each request by the timeout. This process bounds the whole
// read by the timeout and this margin as well, so a harness that never settles is
// recorded as a failed read rather than holding every later read behind it.
const ACCOUNT_READ_GRACE_MS = 1_000;

// What this process records of a read that went wrong outside the harness's two
// requests. Fixed text, like the harness's own.
const RECORDER_FAILURES = {
  THREW: { method: 'readAccount', code: 'READ_ACCOUNT_THREW', summary: 'readAccount threw; its text is not kept', rpc_code: null },
  UNSETTLED: { method: 'readAccount', code: 'READ_ACCOUNT_UNSETTLED', summary: 'readAccount did not return within the bound', rpc_code: null },
  UNCONFIRMED: {
    method: 'account/rateLimits/read', code: 'RATE_LIMITS_READ_UNCONFIRMED', rpc_code: null,
    summary: 'the rate limits were answered but the account was not, so they could not be bound to an account and were not kept'
  }
} satisfies Record<string, AccountReadError>;

export type ProviderAccountRecord = {
  observed_at: string;
  codex_version: string | null;
  account: AccountIdentity | null;
  requires_openai_auth: boolean | null;
  account_observed_at: string | null;
  rate_limits: RateLimitsRecord | null;
  rate_limits_observed_at: string | null;
  rate_limits_updated_at: string | null;
  login_file_modified_at: string | null;
  error: { observed_at: string; reads: AccountReadError[] } | null;
};

type RecorderOptions<S> = {
  storeDir: string; codexHome: string; harness: Harness<S>; codexVersion?: string | null;
  log?: Log; now?: () => number; timeoutMs?: number;
};

type Update = { rate_limits: RateLimitsRecord; at: string };

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The schema describes the rolling rate-limit update as sparse: what it lacks is
// unknown, not gone. So a null or an absent value never replaces one the record
// already holds, at any depth.
export function mergeSparse<T>(previous: T, update: unknown): T {
  if (update === null || update === undefined) return previous;
  if (isPlain(previous) && isPlain(update)) {
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(update)) merged[key] = mergeSparse(previous[key], value);
    return merged as T;
  }
  return update as T;
}

// Which account a record's values belong to. The plan is left out: it changes on
// the same account.
function identityOf(account: AccountIdentity | null) {
  return account ? JSON.stringify([account.type, account.email]) : null;
}

export class ProviderAccountRecorder<S> {
  file: string;
  loginFile: string;
  harness: Harness<S>;
  codexVersion: string | null;
  log: Log;
  now: () => number;
  timeoutMs: number;
  session: S | null;
  record: ProviderAccountRecord;
  running: Promise<void> | null;
  again: string | null;
  closed: boolean;
  // Rate-limit updates received while a read is running, in receipt order; null
  // when no read is running.
  sinceRead: Update[] | null;
  writing: Promise<void> | null;
  dirty: boolean;

  constructor({ storeDir, codexHome, harness, codexVersion = null, log = () => {}, now = () => Date.now(), timeoutMs = ACCOUNT_READ_TIMEOUT_MS }: RecorderOptions<S>) {
    this.file = path.join(storeDir, PROVIDER_ACCOUNT_FILE);
    this.loginFile = path.join(codexHome, LOGIN_FILE);
    this.harness = harness;
    this.codexVersion = codexVersion;
    this.log = log;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.record = {
      observed_at: this.#at(),
      codex_version: codexVersion,
      account: null,
      requires_openai_auth: null,
      account_observed_at: null,
      rate_limits: null,
      rate_limits_observed_at: null,
      rate_limits_updated_at: null,
      login_file_modified_at: null,
      error: null
    };
    this.running = null;
    this.again = null;
    this.closed = false;
    this.sinceRead = null;
    this.writing = null;
    this.dirty = false;
  }

  attach(session: S) {
    this.session = session;
  }

  close() {
    this.closed = true;
  }

  // Starts a read and returns at once. A read asked for while one is running is
  // folded into one more read after it, so a burst of turns is one read behind
  // at most and never a queue. Returns the running read, for a test to await.
  request(reason: string): Promise<void> | null {
    try {
      if (this.closed || !this.session || typeof this.harness.readAccount !== 'function') return null;
      if (this.running) {
        this.again = reason;
        return this.running;
      }
      this.running = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.#readAndRecord(reason))
        .catch((error) => { this.#note({ event: 'provider_account.failed', reason, problem: kindOf(error) }); })
        .finally(() => {
          this.running = null;
          const folded = this.again;
          this.again = null;
          if (folded) this.request(folded);
        });
      return this.running;
    } catch (error) {
      this.#note({ event: 'provider_account.failed', reason, problem: kindOf(error) });
      return null;
    }
  }

  // Resolves when no read is running, none is folded in behind one, and the last
  // record is on disk.
  async settled() {
    while (this.running || this.writing) {
      await this.running;
      await this.writing;
    }
  }

  // The connection's event callback. `account/rateLimits/updated` is merged into
  // the record in memory and queued for writing; `account/updated` asks for a
  // fresh read and changes nothing itself, because only a read says whether the
  // account changed. Nothing here waits for a disk or a read.
  accept(event: { kind?: unknown; params?: unknown }) {
    try {
      if (this.closed) return;
      if (event.kind === 'account.updated') {
        this.request('account_updated');
        return;
      }
      if (event.kind !== 'account.rate_limits' || typeof this.harness.rateLimitsFrom !== 'function') return;
      const params = isPlain(event.params) ? event.params : {};
      const update = this.harness.rateLimitsFrom(params.rateLimits);
      if (!update) return;
      const at = this.#at();
      this.sinceRead?.push({ rate_limits: update, at });
      this.#set({ ...this.record, rate_limits: mergeSparse(this.record.rate_limits, update), rate_limits_updated_at: at });
    } catch (error) {
      this.#note({ event: 'provider_account.update_failed', problem: kindOf(error) });
    }
  }

  async #readAndRecord(reason: string) {
    if (this.closed) return;
    this.sinceRead = [];
    let read: AccountRead | null = null;
    let thrown: AccountReadError | null = null;
    try {
      read = await bounded(this.harness.readAccount!(this.session!, { timeoutMs: this.timeoutMs }), this.timeoutMs + ACCOUNT_READ_GRACE_MS); // request() checked both before starting.
    } catch (error) {
      thrown = error instanceof Unsettled ? RECORDER_FAILURES.UNSETTLED : RECORDER_FAILURES.THREW;
    }
    const updates = this.sinceRead;
    this.sinceRead = null;
    if (this.closed) return;
    const reads = thrown ? [thrown] : [...(read?.error ?? [])];
    const next = read ? this.#merged(read, updates, reads) : { ...this.record };
    const at = this.#at();
    next.observed_at = at;
    next.codex_version = read?.codex_version ?? next.codex_version ?? this.codexVersion;
    next.login_file_modified_at = this.#loginModifiedAt();
    next.error = reads.length > 0 ? { observed_at: at, reads } : null;
    this.#set(next);
    this.#note({ event: 'provider_account.recorded', reason, error: next.error ? reads.map((e) => e.code) : null });
  }

  // The record with one read's answers in it. Rate-limit updates that arrived
  // while the read was out are newer than its snapshot, so they are merged back
  // over it in the order they came. Pushes onto `reads` what it declined to keep.
  #merged(read: AccountRead, updates: Update[], reads: AccountReadError[]): ProviderAccountRecord {
    const next = { ...this.record };
    const failed = new Set((read.error ?? []).map((e) => e.method));
    const accountAnswered = !failed.has('account/read');
    if (accountAnswered && next.account_observed_at !== null && identityOf(read.account) !== identityOf(next.account)) {
      // Another account than the one a read last confirmed, or none: what is held
      // of the last one's allowance is not this one's, and neither are the updates
      // that came while this read was out.
      next.rate_limits = null;
      next.rate_limits_observed_at = null;
      next.rate_limits_updated_at = null;
      updates = [];
    }
    if (accountAnswered) {
      next.account = read.account;
      next.requires_openai_auth = read.requires_openai_auth;
      next.account_observed_at = read.observed_at;
    }
    if (!failed.has('account/rateLimits/read')) {
      if (accountAnswered) {
        next.rate_limits = read.rate_limits;
        next.rate_limits_observed_at = read.observed_at;
        next.rate_limits_updated_at = null;
        for (const update of updates) {
          next.rate_limits = mergeSparse(next.rate_limits, update.rate_limits);
          next.rate_limits_updated_at = update.at;
        }
      } else {
        reads.push(RECORDER_FAILURES.UNCONFIRMED);
      }
    }
    return next;
  }

  #at() {
    return new Date(this.now()).toISOString();
  }

  // The login file's modification time, by stat. The file is never opened.
  #loginModifiedAt() {
    try {
      return fs.statSync(this.loginFile).mtime.toISOString();
    } catch {
      return null;
    }
  }

  // The record in memory changes at once; the file follows on the queued writer.
  #set(record: ProviderAccountRecord) {
    this.record = record;
    this.dirty = true;
    if (!this.writing) this.writing = this.#drain();
  }

  // Writes the latest record until no change is left unwritten, one write at a
  // time. It yields before its first write, so the caller that queued it has
  // returned before the disk is touched. A write that fails is logged and the
  // record in memory is kept for the next one.
  async #drain() {
    await new Promise((resolve) => setImmediate(resolve));
    while (this.dirty) {
      this.dirty = false;
      try {
        await replaceAtomically(this.file, JSON.stringify(this.record, null, 2) + '\n');
      } catch (error) {
        this.#note({ event: 'provider_account.write_failed', file: this.file, problem: kindOf(error) });
      }
    }
    this.writing = null;
  }

  #note(line: Record<string, unknown>) {
    try {
      this.log(line);
      return true;
    } catch {
      // A log that throws must not end a read; the record on disk is what counts.
      return false;
    }
  }
}

let tempCounter = 0;

// The store's write order, on the thread pool: a temporary file beside the
// record, written and fsynced, renamed over it, then the directory fsynced. A
// reader sees the whole of the last record or the whole of this one.
async function replaceAtomically(file: string, data: string) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.temp-${process.pid}-account-${tempCounter++}`);
  try {
    const handle = await fs.promises.open(temp, 'wx', FILE_MODE);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  const directory = await fs.promises.open(dir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

class Unsettled extends Error {}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Unsettled()), ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// What is logged of an error: its code or its name, never its message, which can
// quote what a provider sent.
function kindOf(error: unknown) {
  const code = isPlain(error) ? error.code : undefined;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : typeof error;
}
