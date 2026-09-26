import type { Store } from '../stream/store.ts';
import type { Channel } from './types.ts';
// The poll: how a channel's own messages reach the release loop.
//
// Until this file existed the loop's items came from its caller. That is what a
// test wants and what a box cannot use: a mailbox on a box has nobody to hand it
// items, so an installed agent captured nothing and answered nothing however
// well the rest of it worked. So the loop asks the adapter, and the adapter goes
// to the channel.
//
// Three rules, and each is here because getting it wrong costs a day:
//
// 1. The interval is the declaration's, and never below the adapter's floor. A
//    mailbox polled every second is 3,600 logins an hour from one address, which
//    providers answer with a lockout that lasts a day and takes a person to
//    lift. A declaration below the floor is refused at start, by name, rather
//    than quietly raised: a number nobody honours is worse than a number nobody
//    likes.
// 2. A poll that fails is a fault in the log and a field on the channel, never
//    the end of the process. A mail server refusing a connection for ninety
//    seconds is a Tuesday; a unit that exits on it turns ninety seconds into a
//    restart loop, and `Restart=on-failure` will do that faster than anyone can
//    read the log.
// 3. A poll that keeps failing is not a Tuesday. Past a declared count the
//    channel holds: the runtime stops capturing, releasing and delivering on it,
//    writes what is wrong on the channel, and waits. The hold is on the channel
//    state file, which is what a check from outside the box reads, so "the agent
//    has not seen its mailbox for an hour" is a thing doctor reports rather than
//    a thing somebody notices when a client asks why nobody replied.
//
// The hold covers delivery as well as capture on purpose. A channel whose reads
// are failing is usually a channel whose writes are failing, and a send that
// throws lands `unknown` and is never retried again by anyone; holding costs a
// delayed reply, and not holding costs a reply nobody can account for.

import { fault } from './faults.ts';
import { readChannelState, writeChannelState } from './channel-state.ts';

// How many polls in a row may fail before the channel holds, when the channel's
// declaration does not say. Three, because one failure is noise, two is a
// pattern, and at the email floor of thirty seconds three is ninety seconds of
// silence, which is short enough that the hold is news and long enough that a
// server restart does not raise one.
export const POLL_FAILURES_BEFORE_HOLD = 3;

// The interval this channel is polled at, or a fault. Both halves are refusals
// rather than corrections: an adapter that names a floor means it, and a channel
// with no interval is a channel nobody decided about.
export function pollIntervalFor(channel: Channel | null | undefined, adapter: { POLL_INTERVAL_FLOOR_MS?: number } | null | undefined) {
  const declared = channel?.poll_interval_ms;
  const floor = adapter?.POLL_INTERVAL_FLOOR_MS ?? 0;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
    return {
      interval_ms: null,
      fault: fault('POLL_INTERVAL_MISSING', `${channel?.kind}:${channel?.account}`,
        'the channel declares no poll_interval_ms, and the runtime guesses no interval for a channel it has to go and read',
        `declare poll_interval_ms on this channel, at or above this adapter's floor of ${floor} ms`)
    };
  }
  if (declared < floor) {
    return {
      interval_ms: null,
      fault: fault('POLL_INTERVAL_BELOW_FLOOR', `${channel!.kind}:${channel!.account}`, // A numeric declared interval above means the channel was present.
        `the channel asks to be polled every ${declared} ms and this adapter's floor is ${floor} ms, below which a provider answers with a rate limit that costs a day of the agent's work`,
        `raise poll_interval_ms to ${floor} or more`)
    };
  }
  return { interval_ms: declared, fault: null };
}

export function failuresBeforeHold(channel: Partial<Channel> | null | undefined) {
  const declared = channel?.poll_failures_before_hold;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 1) return Math.floor(declared);
  return POLL_FAILURES_BEFORE_HOLD;
}

// The declaration's explicit inbound choice, including the email adapter's
// compatible default. This is written by the system that already knows it; a
// persisted failure must say which transport produced it so a later declaration
// can tell current evidence from stale evidence after a transport change.
export function inboundTransportOf(channel: Partial<Channel> | null | undefined) {
  if (channel?.kind !== 'email') return null;
  return channel.inbound ?? 'imap';
}

// What the channel's poll block says now. `holding` is the only field anything
// downstream branches on; the rest is there so that a person who reads the file
// knows what happened without reading a log.
export function pollState(store: Store, account: string, kind: string): unknown {
  // This field access preserves throws on null state and passes every poll value through.
  return (readChannelState(store, account, kind) as { poll?: unknown }).poll ?? {
    last_attempt_at: null,
    last_success_at: null,
    last_item_count: null,
    consecutive_failures: 0,
    holding: false,
    last_fault: null
  };
}

export function recordPollSuccess(store: Store, account: string, kind: string, { at, items, inbound_transport = null }: { at: string; items: unknown; inbound_transport?: unknown }) {
  const poll = {
    // Spread follows JavaScript for every raw poll value; it establishes no schema.
    ...(pollState(store, account, kind) as object),
    ...(inbound_transport === null ? {} : { inbound_transport }),
    last_attempt_at: at,
    last_success_at: at,
    last_item_count: items,
    consecutive_failures: 0,
    holding: false,
    last_fault: null
  };
  writeChannelState(store, account, kind, { poll });
  return poll;
}

// A failure is written before it is reported, so a process that dies between the
// two still leaves the count on disk: the hold has to survive a restart, or a
// channel that fails on every poll and restarts on every failure never reaches
// the count that would stop it.
export function recordPollFailure(store: Store, account: string, kind: string, { at, cause, threshold, inbound_transport = null }: { at: string; cause: { code: unknown; subject: unknown; problem: unknown; fix: unknown }; threshold: number; inbound_transport?: unknown }): Record<string, unknown> & { holding: boolean; consecutive_failures: unknown } {
  // The historical operation reads fields, spreads the value, and uses JS +.
  // No numeric promise escapes: consecutive_failures is unknown in the result.
  const previous = pollState(store, account, kind) as { inbound_transport?: unknown; consecutive_failures?: number };
  const sameTransport = inbound_transport === null || previous.inbound_transport === inbound_transport;
  const consecutive = (sameTransport ? (previous.consecutive_failures ?? 0) : 0) + 1;
  const poll = {
    ...previous,
    ...(inbound_transport === null ? {} : { inbound_transport }),
    last_attempt_at: at,
    consecutive_failures: consecutive,
    holding: consecutive >= threshold,
    last_fault: { code: cause.code, subject: cause.subject, problem: cause.problem, fix: cause.fix, at }
  };
  writeChannelState(store, account, kind, { poll });
  return poll;
}

// The fault a held channel reports, in the shape doctor and the log both read.
export function holdFault(channel: Channel, poll: unknown) {
  // Field assertions describe only these interpolations, not validated poll state.
  return fault('CHANNEL_POLL_HOLD', `${channel.kind}:${channel.account}`,
    `${(poll as { consecutive_failures?: unknown }).consecutive_failures} polls of this channel have failed in a row; the last said: ${(poll as { last_fault?: { problem?: unknown } }).last_fault?.problem ?? 'no reason was recorded'}`,
    'fix what the channel is failing on; the next poll that works clears the hold by itself, and no restart is needed');
}

// The fault one failed poll reports. It is named after what the adapter threw
// where the adapter named it, because "IMAP refused the login" and "the host does
// not resolve" are different days' work.
export function pollFault(channel: Channel, error: unknown): { code: string; subject: string; problem: unknown; fix: unknown } {
  // Optional field reads preserve primitives, inherited fields and thrown null.
  const fields = error as { faults?: { code?: unknown; problem?: unknown; fix?: unknown }[]; fault?: { code?: unknown; problem?: unknown; fix?: unknown }; message?: unknown } | null | undefined;
  const named = fields?.faults?.[0] ?? fields?.fault ?? null;
  if (named) {
    // fault stores fix verbatim; this operation assertion does not narrow our return.
    return fault('CHANNEL_POLL_FAILED', `${channel.kind}:${channel.account}`,
      `${named.code}: ${named.problem}`,
      named.fix as string ?? 'read the adapter\'s fault above; the runtime keeps polling until the declared count is reached');
  }
  return fault('CHANNEL_POLL_FAILED', `${channel.kind}:${channel.account}`,
    fields?.message ?? String(error),
    'read the fault above; the runtime keeps polling until the declared count is reached');
}
