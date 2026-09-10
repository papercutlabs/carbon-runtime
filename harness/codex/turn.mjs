// turn — the third of the six operations. One release becomes one turn/start, and
// the turn is finished when `turn/completed` arrives carrying this thread's id and
// this turn's id. A process exit is never a completion: the child dying mid-turn is
// a restart, and the store, not the harness, says what to do about it.
//
// sandboxPolicy is a per-turn field on this protocol version, not a thread field,
// so it is built and sent on every turn. Nothing here defaults it: a turn with no
// policy inherits whatever the last turn set, which is exactly the failure the
// explicit-arguments rule exists to prevent.

import { fault } from '../../lib/faults.mjs';
import { HarnessFault } from './session.mjs';

// The workspace-write policy the plan names: the work directory writable, the
// store writable, the network closed.
export function workspaceWritePolicy({ writableRoots, networkAccess }) {
  if (!Array.isArray(writableRoots)) {
    throw new HarnessFault(fault('HARNESS_WRITABLE_ROOTS_ABSENT', 'sandboxPolicy.writableRoots',
      'a workspace-write turn was asked for with no list of writable roots',
      'pass the roots explicitly; an empty list is a decision and is written as []'));
  }
  if (typeof networkAccess !== 'boolean') {
    throw new HarnessFault(fault('HARNESS_NETWORK_ACCESS_UNSTATED', 'sandboxPolicy.networkAccess',
      'a turn was asked for without saying whether the model may reach the network',
      'pass networkAccess explicitly; the declaration carries the answer'));
  }
  return { type: 'workspaceWrite', writableRoots, networkAccess, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
}

export function readOnlyPolicy({ networkAccess }) {
  if (typeof networkAccess !== 'boolean') {
    throw new HarnessFault(fault('HARNESS_NETWORK_ACCESS_UNSTATED', 'sandboxPolicy.networkAccess',
      'a turn was asked for without saying whether the model may reach the network',
      'pass networkAccess explicitly; the declaration carries the answer'));
  }
  return { type: 'readOnly', networkAccess };
}

export function policyFor(mode, { writableRoots, networkAccess }) {
  if (mode === 'workspace-write') return workspaceWritePolicy({ writableRoots, networkAccess });
  if (mode === 'read-only') return readOnlyPolicy({ networkAccess });
  throw new HarnessFault(fault('HARNESS_SANDBOX_MODE_REFUSED', mode,
    `carbon's Codex harness runs a turn under read-only or workspace-write, never ${JSON.stringify(mode)}`,
    'change sandbox.mode in the declaration; danger-full-access is the principal\'s to grant and this harness does not send it'));
}

// Waits for the completion of one turn, correlated by both ids. Resolves with the
// Turn record the app-server sent, whose `status` is recorded verbatim by the
// caller, `failed` included.
function awaitCompletion(session, threadId, turnId, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const already = session.stream.forTurn(threadId, turnId).find((e) => e.kind === 'turn.completed');
    if (already) return resolve(already.params.turn);

    const previous = session.stream.onEvent;
    let timer = null;
    const done = (fn, value) => {
      session.stream.onEvent = previous;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    session.stream.onEvent = (event) => {
      previous(event);
      if (event.kind === 'turn.completed' && event.threadId === threadId && event.params?.turn?.id === turnId) {
        done(resolve, event.params.turn);
      }
    };
    session.exit.then(({ code, signal }) => done(reject, new HarnessFault(
      fault('HARNESS_CHILD_EXITED_MID_TURN', `${threadId}:${turnId}`,
        `the app-server exited with code ${code} signal ${signal} before the turn completed`,
        'the store, not the harness, decides what to re-issue; restart and read the release record'))));
    if (timeoutMs) {
      timer = setTimeout(() => done(reject, new HarnessFault(
        fault('HARNESS_TURN_TIMED_OUT', `${threadId}:${turnId}`,
          `the turn did not complete within ${timeoutMs} ms`,
          'raise limits.max_turn_ms in the declaration, or read the events this run recorded'))), timeoutMs);
    }
  });
}

// One turn. `clientUserMessageId` is the release id, so the same release re-issued
// after a restart carries the same value; whether the app-server deduplicates on it
// is recorded in harness/codex/verifications.
export async function turn(session, {
  threadId, input, effort, sandboxPolicy, clientUserMessageId, model, timeoutMs
}) {
  if (!threadId) {
    throw new HarnessFault(fault('HARNESS_THREAD_ID_ABSENT', 'turn/start.threadId',
      'a turn was asked for with no thread', 'open or resume the unit\'s thread first'));
  }
  if (!sandboxPolicy) {
    throw new HarnessFault(fault('HARNESS_SANDBOX_POLICY_ABSENT', 'turn/start.sandboxPolicy',
      'a turn was asked for with no sandbox policy, and an omitted policy inherits the last one silently',
      'build the policy with policyFor() from the declaration and pass it on every turn'));
  }
  const params = { threadId, input: inputItems(input), sandboxPolicy, approvalPolicy: 'never' };
  if (effort) params.effort = effort;
  if (model) params.model = model;
  if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;

  const started = await session.request('turn/start', params);
  const turnId = started?.turn?.id ?? null;
  if (!turnId) {
    throw new HarnessFault(fault('HARNESS_TURN_ID_ABSENT', 'turn/start',
      'the reply carried no turn id, so completion cannot be correlated',
      'record the reply and stop; the pinned protocol moved'));
  }
  const completed = await awaitCompletion(session, threadId, turnId, { timeoutMs });
  const stream = session.stream.forTurn(threadId, turnId);
  return {
    thread_id: threadId,
    turn_id: turnId,
    client_user_message_id: clientUserMessageId ?? null,
    status: completed.status,
    started_at: completed.startedAt ?? null,
    completed_at: completed.completedAt ?? null,
    duration_ms: completed.durationMs ?? null,
    error: completed.error ?? null,
    items: completed.items ?? [],
    agent_message: agentMessageFrom(completed, stream),
    token_usage: tokenUsageFrom(stream),
    events: stream.map((e) => e.kind)
  };
}

// What the model actually said, as opposed to what it did. A turn that answers in
// text instead of calling the reply tool leaves nothing anywhere else, and the
// question a person asks about such a turn is "what did it say"; so the text is
// read off the turn and written on the thread record.
//
// Two places carry it, and the first that has it wins: the completed items the
// app-server sends whole, and the deltas it streamed. Neither is guaranteed by
// the pinned protocol, so both are read defensively and the absence of both is
// null rather than an invention.
export function agentMessageFrom(turnRecord, events = []) {
  const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
  const texts = items
    .map((item) => item?.item ?? item)
    .filter((item) => item?.type === 'agentMessage')
    .map((item) => (typeof item.text === 'string' ? item.text
      : (item.content ?? []).map((part) => part?.text ?? '').join('')))
    .filter((text) => typeof text === 'string' && text.length > 0);
  if (texts.length > 0) return texts.at(-1);

  const delta = events
    .filter((e) => e.kind === 'message.delta')
    .map((e) => e.params?.delta ?? e.params?.text ?? '')
    .join('');
  return delta.length > 0 ? delta : null;
}

// What the turn cost, read off the record the provider sent and never computed
// here. The last update of the turn is the one that counts; a turn nobody
// reported usage for is null rather than zero, because zero is a claim.
export function tokenUsageFrom(events = []) {
  const last = events.filter((e) => e.kind === 'turn.token_usage').at(-1);
  const total = last?.params?.tokenUsage?.total;
  if (!total || typeof total !== 'object') return null;
  return {
    input: total.inputTokens ?? null,
    cached: total.cachedInputTokens ?? null,
    output: total.outputTokens ?? null,
    reasoning: total.reasoningOutputTokens ?? null
  };
}

// Text in, protocol input items out. The protocol also carries images and skills;
// carbon sends text, because a channel record's body is text and an attachment is a
// file the model reads through its own tools.
export function inputItems(input) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) return input;
  throw new HarnessFault(fault('HARNESS_INPUT_UNSUPPORTED', 'turn/start.input',
    `input was ${typeof input}, and carbon sends text or a list of protocol input items`,
    'pass the record body as a string'));
}

// turn/steer delivers a message into the turn that is already running. Whether it
// works on the pinned binary is recorded in harness/codex/verifications; the runtime
// offers it as on_busy: steer only where that record says it does.
export async function steer(session, { threadId, expectedTurnId, input, clientUserMessageId }) {
  const params = { threadId, expectedTurnId, input: inputItems(input) };
  if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
  return session.request('turn/steer', params);
}

// The last resort, not a feature: the plan refuses a mid-turn interrupt of the
// agent, and this exists so a stuck turn can be ended by a person rather than by a
// kill of the process.
export function interrupt(session, { threadId, turnId }) {
  return session.request('turn/interrupt', { threadId, turnId });
}
