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

import { fault } from './faults.mjs';
import { readChannelState, writeChannelState } from './channel-state.mjs';

// How many polls in a row may fail before the channel holds, when the channel's
// declaration does not say. Three, because one failure is noise, two is a
// pattern, and at the email floor of thirty seconds three is ninety seconds of
// silence, which is short enough that the hold is news and long enough that a
// server restart does not raise one.
export const POLL_FAILURES_BEFORE_HOLD = 3;

// The interval this channel is polled at, or a fault. Both halves are refusals
// rather than corrections: an adapter that names a floor means it, and a channel
// with no interval is a channel nobody decided about.
export function pollIntervalFor(channel, adapter) {
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
      fault: fault('POLL_INTERVAL_BELOW_FLOOR', `${channel.kind}:${channel.account}`,
        `the channel asks to be polled every ${declared} ms and this adapter's floor is ${floor} ms, below which a provider answers with a rate limit that costs a day of the agent's work`,
        `raise poll_interval_ms to ${floor} or more`)
    };
  }
  return { interval_ms: declared, fault: null };
}

export function failuresBeforeHold(channel) {
  const declared = channel?.poll_failures_before_hold;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 1) return Math.floor(declared);
  return POLL_FAILURES_BEFORE_HOLD;
}

// What the channel's poll block says now. `holding` is the only field anything
// downstream branches on; the rest is there so that a person who reads the file
// knows what happened without reading a log.
export function pollState(store, account, kind) {
  return readChannelState(store, account, kind).poll ?? {
    last_attempt_at: null,
    last_success_at: null,
    last_item_count: null,
    consecutive_failures: 0,
    holding: false,
    last_fault: null
  };
}

export function recordPollSuccess(store, account, kind, { at, items }) {
  const poll = {
    ...pollState(store, account, kind),
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
export function recordPollFailure(store, account, kind, { at, cause, threshold }) {
  const previous = pollState(store, account, kind);
  const consecutive = (previous.consecutive_failures ?? 0) + 1;
  const poll = {
    ...previous,
    last_attempt_at: at,
    consecutive_failures: consecutive,
    holding: consecutive >= threshold,
    last_fault: { code: cause.code, subject: cause.subject, problem: cause.problem, fix: cause.fix, at }
  };
  writeChannelState(store, account, kind, { poll });
  return poll;
}

// The fault a held channel reports, in the shape doctor and the log both read.
export function holdFault(channel, poll) {
  return fault('CHANNEL_POLL_HOLD', `${channel.kind}:${channel.account}`,
    `${poll.consecutive_failures} polls of this channel have failed in a row; the last said: ${poll.last_fault?.problem ?? 'no reason was recorded'}`,
    'fix what the channel is failing on; the next poll that works clears the hold by itself, and no restart is needed');
}

// The fault one failed poll reports. It is named after what the adapter threw
// where the adapter named it, because "IMAP refused the login" and "the host does
// not resolve" are different days' work.
export function pollFault(channel, error) {
  const named = error?.faults?.[0] ?? error?.fault ?? null;
  if (named) {
    return fault('CHANNEL_POLL_FAILED', `${channel.kind}:${channel.account}`,
      `${named.code}: ${named.problem}`,
      named.fix ?? 'read the adapter\'s fault above; the runtime keeps polling until the declared count is reached');
  }
  return fault('CHANNEL_POLL_FAILED', `${channel.kind}:${channel.account}`,
    error?.message ?? String(error),
    'read the fault above; the runtime keeps polling until the declared count is reached');
}
