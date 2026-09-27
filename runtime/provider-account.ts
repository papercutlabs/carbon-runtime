import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../stream/store.ts';
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
// The record is written after the harness connects and after every turn that
// completed, and never on a turn's path. A read runs after the caller has moved
// on, is bounded, and ends in the record whatever happens: a read that failed
// writes `error` and keeps the values it had, each dated by its own observed_at,
// so an old answer is never mistaken for a fresh one. Nothing here throws into
// the caller, and nothing here is awaited by a turn.

export const PROVIDER_ACCOUNT_FILE = 'provider-account.json';
export const LOGIN_FILE = 'auth.json';

// On the pinned binary an unreachable backend took twenty seconds to fail the
// rate-limit read. This is the most a read waits for either answer.
export const ACCOUNT_READ_TIMEOUT_MS = 15_000;

// The harness bounds each request by the timeout. This process bounds the whole
// read by the timeout and this margin as well, so a harness that never settles is
// recorded as a failed read rather than holding every later read behind it.
export const ACCOUNT_READ_GRACE_MS = 1_000;

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

export class ProviderAccountRecorder<S> {
  file: string;
  loginFile: string;
  harness: Harness<S>;
  codexVersion: string | null;
  log: Log;
  now: () => number;
  timeoutMs: number;
  session: S | null;
  record: ProviderAccountRecord | null;
  running: Promise<void> | null;
  again: string | null;
  closed: boolean;

  constructor({ storeDir, codexHome, harness, codexVersion = null, log = () => {}, now = () => Date.now(), timeoutMs = ACCOUNT_READ_TIMEOUT_MS }: RecorderOptions<S>) {
    this.file = path.join(storeDir, PROVIDER_ACCOUNT_FILE);
    this.loginFile = path.join(codexHome, LOGIN_FILE);
    this.harness = harness;
    this.codexVersion = codexVersion;
    this.log = log;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.record = null;
    this.running = null;
    this.again = null;
    this.closed = false;
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
    if (this.closed || !this.session || typeof this.harness.readAccount !== 'function') return null;
    if (this.running) {
      this.again = reason;
      return this.running;
    }
    this.running = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.#readAndWrite(reason))
      .catch((error) => { this.#note({ event: 'provider_account.failed', reason, problem: messageOf(error) }); })
      .finally(() => {
        this.running = null;
        const folded = this.again;
        this.again = null;
        if (folded) this.request(folded);
      });
    return this.running;
  }

  // Resolves when no read is running and none is folded in behind one.
  async settled() {
    while (this.running) await this.running;
  }

  // `account/rateLimits/updated`, merged into the last read. `account/updated`
  // carries the plan when it changed; it is merged the same way.
  accept(event: { kind?: unknown; params?: unknown }) {
    try {
      if (this.closed) return;
      const params = isPlain(event.params) ? event.params : {};
      const at = new Date(this.now()).toISOString();
      if (event.kind === 'account.rate_limits' && typeof this.harness.rateLimitsFrom === 'function') {
        const update = this.harness.rateLimitsFrom(params.rateLimits);
        if (!update) return;
        const current = this.#current();
        this.#write({ ...current, rate_limits: mergeSparse(current.rate_limits, update), rate_limits_updated_at: at });
      } else if (event.kind === 'account.updated' && typeof params.planType === 'string') {
        const current = this.#current();
        if (!current.account) return;
        this.#write({ ...current, account: { ...current.account, plan_type: params.planType } });
      }
    } catch (error) {
      this.#note({ event: 'provider_account.update_failed', problem: messageOf(error) });
    }
  }

  async #readAndWrite(reason: string) {
    if (this.closed) return;
    let read: AccountRead | null = null;
    let thrown: AccountReadError | null = null;
    try {
      read = await bounded(this.harness.readAccount!(this.session!, { timeoutMs: this.timeoutMs }), this.timeoutMs + ACCOUNT_READ_GRACE_MS); // request() checked both before starting.
    } catch (error) {
      thrown = { method: 'readAccount', message: messageOf(error).slice(0, 300) };
    }
    if (this.closed) return;
    const at = new Date(this.now()).toISOString();
    const current = this.#current();
    const next: ProviderAccountRecord = {
      ...current,
      observed_at: at,
      codex_version: read?.codex_version ?? current.codex_version ?? this.codexVersion,
      login_file_modified_at: this.#loginModifiedAt(),
      error: null
    };
    const failed = new Set((read?.error ?? []).map((e) => e.method));
    if (read && !failed.has('account/read')) {
      next.account = read.account;
      next.requires_openai_auth = read.requires_openai_auth;
      next.account_observed_at = read.observed_at;
    }
    if (read && !failed.has('account/rateLimits/read')) {
      next.rate_limits = read.rate_limits;
      next.rate_limits_observed_at = read.observed_at;
    }
    const reads = thrown ? [thrown] : (read?.error ?? []);
    if (reads.length > 0) next.error = { observed_at: at, reads };
    this.#write(next);
    this.#note({ event: 'provider_account.recorded', reason, error: next.error ? reads.map((e) => e.method) : null });
  }

  #current(): ProviderAccountRecord {
    return this.record ?? {
      observed_at: new Date(this.now()).toISOString(),
      codex_version: this.codexVersion,
      account: null,
      requires_openai_auth: null,
      account_observed_at: null,
      rate_limits: null,
      rate_limits_observed_at: null,
      rate_limits_updated_at: null,
      login_file_modified_at: null,
      error: null
    };
  }

  // The login file's modification time, by stat. The file is never opened.
  #loginModifiedAt() {
    try {
      return fs.statSync(this.loginFile).mtime.toISOString();
    } catch {
      return null;
    }
  }

  // A temporary file, then a rename, by the store's one write order; a reader
  // sees the whole of the last record or the whole of this one. A write that
  // fails is logged and the record in memory is kept for the next one.
  #write(record: ProviderAccountRecord) {
    this.record = record;
    try {
      writeAtomic(this.file, JSON.stringify(record, null, 2) + '\n');
    } catch (error) {
      this.#note({ event: 'provider_account.write_failed', file: this.file, problem: messageOf(error) });
    }
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

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the account read did not return within ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
