// One subscription, mapped to a small Carbon vocabulary. Everything the runtime
// upstream of the harness reacts to is one of these eight kinds; every other
// app-server notification is logged by its method name and dropped, so a Codex
// version that adds forty notifications adds nothing to reason about here.
//
// Correlation is by thread id and turn id, never by arrival order: the app-server
// interleaves two threads on one connection and a turn's completion can arrive
// after the next turn's start.

export const VOCABULARY = [
  'thread.started',
  'thread.named',
  'turn.started',
  'turn.completed',
  'message.delta',
  'item.started',
  'item.completed',
  'tool_server.status',
  'harness.error'
];

// method -> the Carbon kind it becomes. A method absent from this map is dropped.
const MAP = new Map([
  ['thread/started', 'thread.started'],
  ['thread/name/updated', 'thread.named'],
  ['turn/started', 'turn.started'],
  ['turn/completed', 'turn.completed'],
  ['item/agentMessage/delta', 'message.delta'],
  ['item/started', 'item.started'],
  ['item/completed', 'item.completed'],
  ['mcpServer/startupStatus/updated', 'tool_server.status'],
  ['error', 'harness.error']
]);

// The app-server puts the ids in different places per notification, so reading
// them is one function rather than a field name repeated nine times.
function correlate(method, params) {
  const threadId = params?.threadId ?? params?.thread?.id ?? null;
  let turnId = params?.turnId ?? params?.turn?.id ?? null;
  if (turnId === null && method.startsWith('item/')) turnId = params?.item?.turnId ?? null;
  return { threadId, turnId };
}

// Returns the Carbon event, or null when the method is not in the vocabulary. The
// raw params are carried whole: the runtime records `turn/completed`'s TurnStatus
// verbatim and never re-spells it.
export function mapNotification(method, params) {
  const kind = MAP.get(method);
  if (!kind) return null;
  const { threadId, turnId } = correlate(method, params);
  const event = { kind, method, threadId, turnId, params };
  if (kind === 'turn.completed') event.status = params?.turn?.status ?? null;
  if (kind === 'tool_server.status') {
    event.server = params?.name ?? null;
    event.status = params?.status ?? null;
  }
  return event;
}

// The subscription itself. Holds the dropped method names by count so a version
// bump shows up as a list rather than as silence.
export class EventStream {
  constructor(onEvent) {
    this.onEvent = onEvent ?? (() => {});
    this.dropped = new Map();
    this.events = [];
  }

  accept(method, params) {
    const event = mapNotification(method, params);
    if (!event) {
      this.dropped.set(method, (this.dropped.get(method) ?? 0) + 1);
      return null;
    }
    this.events.push(event);
    this.onEvent(event);
    return event;
  }

  // Every event carbon recorded for one turn, in arrival order, selected by the two
  // ids rather than by position in the stream.
  forTurn(threadId, turnId) {
    return this.events.filter((e) => e.threadId === threadId && e.turnId === turnId);
  }

  droppedMethods() {
    return [...this.dropped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([method, count]) => ({ method, count }));
  }
}
