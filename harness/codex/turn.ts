// turn — the third of the six operations. One release becomes one turn/start, and
// the turn is finished when `turn/completed` arrives carrying this thread's id and
// this turn's id. A process exit is never a completion: the child dying mid-turn is
// a restart, and the store, not the harness, says what to do about it.
//
// sandboxPolicy is a per-turn field on this protocol version, not a thread field,
// so it is built and sent on every turn. Nothing here defaults it: a turn with no
// policy inherits whatever the last turn set, which is exactly the failure the
// explicit-arguments rule exists to prevent.

import { fault } from '../../lib/faults.ts';
import { HarnessFault } from './session.ts';

// Untrusted turn records, notifications and policy inputs. The indexer is not a validator.
function fields(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

type StreamEvent = { kind?: unknown; threadId?: unknown; turnId?: unknown; params?: unknown; [key: string]: unknown };

type TurnSession = {
  stream: {
    onEvent: (event: StreamEvent) => unknown;
    forTurn(threadId: unknown, turnId: unknown): StreamEvent[];
  };
  exit: Promise<{ code?: unknown; signal?: unknown }>;
  request(method: string, params?: unknown): Promise<unknown>;
};

// The workspace-write policy the plan names: the work directory writable, the
// store writable, the network closed. `/tmp` stays writable because LibreOffice
// creates its IPC socket only under `/tmp` or `/var/tmp` and ignores TMPDIR for
// that path (PA-246 live turn: `ERROR: no valid pipe path found`). `$TMPDIR`
// outside the declared roots stays closed.
export function workspaceWritePolicy({ writableRoots, networkAccess }: { writableRoots?: unknown; networkAccess?: unknown }) {
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
  return { type: 'workspaceWrite', writableRoots, networkAccess, excludeSlashTmp: false, excludeTmpdirEnvVar: true };
}

export function readOnlyPolicy({ networkAccess }: { networkAccess?: unknown }) {
  if (typeof networkAccess !== 'boolean') {
    throw new HarnessFault(fault('HARNESS_NETWORK_ACCESS_UNSTATED', 'sandboxPolicy.networkAccess',
      'a turn was asked for without saying whether the model may reach the network',
      'pass networkAccess explicitly; the declaration carries the answer'));
  }
  return { type: 'readOnly', networkAccess };
}

export function policyFor(mode: unknown, { writableRoots, networkAccess }: { writableRoots?: unknown; networkAccess?: unknown }) {
  if (mode === 'workspace-write') return workspaceWritePolicy({ writableRoots, networkAccess });
  if (mode === 'read-only') return readOnlyPolicy({ networkAccess });
  throw new HarnessFault(fault('HARNESS_SANDBOX_MODE_REFUSED', mode,
    `carbon's Codex harness runs a turn under read-only or workspace-write, never ${JSON.stringify(mode)}`,
    'change sandbox.mode in the declaration; danger-full-access is the principal\'s to grant and this harness does not send it'));
}

// Waits for the completion of one turn, correlated by both ids. Resolves with the
// Turn record the app-server sent, whose `status` is recorded verbatim by the
// caller, `failed` included.
function awaitCompletion(session: TurnSession, threadId: unknown, turnId: unknown, { timeoutMs }: { timeoutMs?: unknown }) {
  return new Promise((resolve, reject) => {
    const already = session.stream.forTurn(threadId, turnId).find((e) => e.kind === 'turn.completed');
    if (already) return resolve((already.params as { turn?: unknown }).turn);

    const previous = session.stream.onEvent;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (fn: (value: unknown) => void, value: unknown) => {
      session.stream.onEvent = previous;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    session.stream.onEvent = (event) => {
      previous(event);
      if (event.kind === 'turn.completed' && event.threadId === threadId && fields(fields(event.params)?.turn)?.id === turnId) {
        done(resolve, fields(event.params)?.turn);
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
          'raise limits.max_turn_ms in the declaration, or read the events this run recorded'))), timeoutMs as number);
    }
  });
}

export type TurnArgs = {
  threadId?: unknown;
  input?: unknown;
  effort?: unknown;
  sandboxPolicy?: unknown;
  clientUserMessageId?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
};

// One turn. `clientUserMessageId` is the release id, so the same release re-issued
// after a restart carries the same value; whether the app-server deduplicates on it
// is recorded in harness/codex/verifications.
export async function turn(session: unknown, {
  threadId, input, effort, sandboxPolicy, clientUserMessageId, model, timeoutMs
}: TurnArgs) {
  const current = session as TurnSession;
  if (!threadId) {
    throw new HarnessFault(fault('HARNESS_THREAD_ID_ABSENT', 'turn/start.threadId',
      'a turn was asked for with no thread', 'open or resume the unit\'s thread first'));
  }
  if (!sandboxPolicy) {
    throw new HarnessFault(fault('HARNESS_SANDBOX_POLICY_ABSENT', 'turn/start.sandboxPolicy',
      'a turn was asked for with no sandbox policy, and an omitted policy inherits the last one silently',
      'build the policy with policyFor() from the declaration and pass it on every turn'));
  }
  const params: Record<string, unknown> = { threadId, input: inputItems(input), sandboxPolicy, approvalPolicy: 'never' };
  if (effort) params.effort = effort;
  if (model) params.model = model;
  if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;

  const started = await current.request('turn/start', params);
  const turnId = fields(fields(started)?.turn)?.id ?? null;
  if (!turnId) {
    throw new HarnessFault(fault('HARNESS_TURN_ID_ABSENT', 'turn/start',
      'the reply carried no turn id, so completion cannot be correlated',
      'record the reply and stop; the pinned protocol moved'));
  }
  const completed = await awaitCompletion(current, threadId, turnId, { timeoutMs });
  const stream = current.stream.forTurn(threadId, turnId);
  const { items, items_detail } = itemsFrom(completed, stream);
  // Completion JSON is untrusted; the property reads are not a validation.
  const rec = completed as Record<string, unknown>;

  return {
    thread_id: threadId,
    turn_id: turnId,
    client_user_message_id: clientUserMessageId ?? null,
    status: rec.status,
    started_at: rec.startedAt ?? null,
    completed_at: rec.completedAt ?? null,
    duration_ms: rec.durationMs ?? null,
    error: rec.error ?? null,
    items,
    items_view: rec.itemsView ?? null,
    items_detail,
    agent_message: agentMessageFrom(completed, stream),
    token_usage: tokenUsageFrom(stream),
    events: stream.map((e) => e.kind)
  };
}

// What the turn did, as records rather than as prose: the turn's own items.
//
// `items` is a required field on the Turn record and `itemsView` is what says how
// much of it was loaded, not whether the field happens to be non-empty. On a real
// turn the completion arrived with `itemsView: "summary"` carrying one item, the
// final message, while the turn had also run a command; a caller that reads the
// completion because it is not empty reports a turn that called nothing, which is
// the worst shape this could take. So the streamed `item/completed` notifications,
// already correlated to this turn by both ids, are the record unless the
// completion says outright that it carried the full view — a non-empty summary is
// never read as the action record, whatever the stream held.
//
// When neither source has anything — no item notifications streamed, and the
// completion did not say `itemsView: "full"` — the record is empty on purpose, and
// `items_detail` names why rather than leaving the caller to guess at a silent [].
export function itemsFrom(turnRecord: unknown, events: StreamEvent[] = []) {
  const streamed = events
    .filter((event) => event.kind === 'item.completed')
    .map((event) => fields(event.params)?.item)
    .filter(Boolean);
  const carried = ((Array.isArray(fields(turnRecord)?.items) ? fields(turnRecord)?.items : []) as unknown[])
    .map((item) => fields(item)?.item ?? item);

  if (fields(turnRecord)?.itemsView === 'full') {
    return { items: carried, items_detail: null };
  }
  if (streamed.length > 0) {
    return { items: streamed, items_detail: null };
  }
  return {
    items: [],
    items_detail: `no item/completed notifications were streamed for this turn and the completion's itemsView was ${JSON.stringify(fields(turnRecord)?.itemsView ?? null)}, not "full", so no action record exists for it`
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
export function agentMessageFrom(turnRecord: unknown, events: StreamEvent[] = []) {
  const items = Array.isArray(fields(turnRecord)?.items) ? fields(turnRecord)?.items as unknown[] : [];
  const texts = items
    .map((item) => fields(item)?.item ?? item)
    .filter((item) => fields(item)?.type === 'agentMessage')
    .map((item) => {
      const rec = fields(item) ?? {};
      return (typeof rec.text === 'string' ? rec.text
        : ((rec.content ?? []) as { text?: unknown }[]).map((part) => part?.text ?? '').join(''));
    })
    .filter((text) => typeof text === 'string' && text.length > 0);
  if (texts.length > 0) return texts.at(-1);

  const delta = events
    .filter((e) => e.kind === 'message.delta')
    .map((e) => fields(e.params)?.delta ?? fields(e.params)?.text ?? '')
    .join('');
  return delta.length > 0 ? delta : null;
}

// What the turn cost, read off the record the provider sent and never computed
// here. The last update of the turn is the one that counts; a turn nobody
// reported usage for is null rather than zero, because zero is a claim.
export function tokenUsageFrom(events: StreamEvent[] = []) {
  const last = events.filter((e) => e.kind === 'turn.token_usage').at(-1);
  const total = fields(fields(last?.params)?.tokenUsage)?.total;
  if (!total || typeof total !== 'object') return null;
  const rec = total as Record<string, unknown>;
  return {
    input: rec.inputTokens ?? null,
    cached: rec.cachedInputTokens ?? null,
    output: rec.outputTokens ?? null,
    reasoning: rec.reasoningOutputTokens ?? null
  };
}

// Text in, protocol input items out. The protocol also carries images and skills;
// carbon sends text, because a channel record's body is text and an attachment is a
// file the model reads through its own tools.
export function inputItems(input: unknown) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) return input;
  throw new HarnessFault(fault('HARNESS_INPUT_UNSUPPORTED', 'turn/start.input',
    `input was ${typeof input}, and carbon sends text or a list of protocol input items`,
    'pass the record body as a string'));
}

// turn/steer delivers a message into the turn that is already running. Whether it
// works on the pinned binary is recorded in harness/codex/verifications; the runtime
// offers it as on_busy: steer only where that record says it does.
export async function steer(session: unknown, { threadId, expectedTurnId, input, clientUserMessageId }: {
  threadId?: unknown;
  expectedTurnId?: unknown;
  input?: unknown;
  clientUserMessageId?: unknown;
}) {
  const params: Record<string, unknown> = { threadId, expectedTurnId, input: inputItems(input) };
  if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
  return (session as TurnSession).request('turn/steer', params);
}

// The last resort, not a feature: the plan refuses a mid-turn interrupt of the
// agent, and this exists so a stuck turn can be ended by a person rather than by a
// kill of the process.
export function interrupt(session: unknown, { threadId, turnId }: { threadId?: unknown; turnId?: unknown }) {
  return (session as TurnSession).request('turn/interrupt', { threadId, turnId });
}
