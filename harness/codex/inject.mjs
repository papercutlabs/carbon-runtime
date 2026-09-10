// inject — the fourth of the six operations, and the one that refuses. The plan
// defers mid-turn injection: a message that arrives while a turn is running is
// captured by the adapter, held in the store, and carried into the next turn. The
// agent is not interrupted.
//
// This is a stub on purpose rather than an absent function. The six operations are
// the whole boundary a second harness has to meet, so the operation exists, records
// what was asked, and refuses by name. A caller that reaches for it gets a fault
// that says where the message actually goes, not a missing-export error at three in
// the morning.
//
// Two doors out of this refusal are already named. `turn/steer` exists on the
// pinned protocol and is verified against the pinned binary in
// harness/codex/verifications; when that record says it delivers, the runtime may
// offer it per channel as on_busy: steer, and this operation is what changes.
// `thread/inject_items` is not one of the doors: its payload is unconstrained and
// the pinned schema digest cannot protect it.

import { fault } from '../../lib/faults.mjs';

export const INJECT_FAULT_CODE = 'HARNESS_MID_TURN_INJECTION_REFUSED';

// Every refused request, in order, for the run that is going on. The runtime writes
// nothing from here: the store is the record, and this list exists so a caller can
// see in one place that it is reaching for a door that is shut.
export function createInjectLog() {
  return [];
}

// Records the request and returns the refusal. It does not throw: a message
// arriving mid-turn is normal, and the caller's answer is to hold it in the store,
// not to fail the run.
export function inject(log, { threadId, turnId, messageId, body, arrivedAt }) {
  const request = {
    thread_id: threadId ?? null,
    turn_id: turnId ?? null,
    message_id: messageId ?? null,
    body_length: typeof body === 'string' ? body.length : null,
    arrived_at: arrivedAt ?? new Date().toISOString()
  };
  if (Array.isArray(log)) log.push(request);
  return {
    accepted: false,
    request,
    fault: fault(INJECT_FAULT_CODE, messageId ? `message ${messageId}` : 'a message',
      'the message arrived while a turn was running, and carbon does not interrupt a running turn',
      'hold the record in the store and carry it into the next turn; a mid-turn delivery becomes possible only where harness/codex/verifications records turn/steer as working and the channel declares on_busy: steer')
  };
}
