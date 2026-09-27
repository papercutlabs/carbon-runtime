import type { ThreadOpening, TurnParams, TurnResult, ChildExit, Status } from '../runtime/types.ts';
export type OnTurn = (session: FakeSession, params: TurnParams, turn: number) => string | TurnResult | Promise<string | TurnResult>;

// A harness that runs no model and opens no process, so the release loop can be
// tested for what it does rather than for what a model says. It carries the real
// `policyFor` and the real `holdsRelease` from the harness itself, because those
// two are the rules being tested and a second copy of a rule proves nothing.

import { policyFor, holdsRelease } from '../harness/codex/index.ts';

export class FakeSession {
  declare threads: Map<string, string>;
  declare turns: TurnParams[];
  declare opens?: (ThreadOpening | (ThreadOpening & { threadId: string }))[];
  declare resumed?: string[];
  declare statusHandlers: ((status?: unknown) => void)[];
  declare stopped: boolean;
  declare exit: Promise<ChildExit>;
  declare endChild: (value: ChildExit) => void;
  constructor() {
    this.threads = new Map();
    this.turns = [];
    this.statusHandlers = [];
    this.stopped = false;
    this.exit = new Promise((resolve) => { this.endChild = resolve; });
  }

  async stop() { this.stopped = true; }
}

// options:
//   onTurn(session, params, n)  what the model does in a turn; returns a status
//                               string or a whole result object
//   statuses()                  what mcpServerStatus/list reports
export function fakeHarness({ onTurn = () => 'completed', statuses = () => [] }: { onTurn?: OnTurn; statuses?: () => Status[] } = {}) {
  const session = new FakeSession();
  let opened = 0;
  let turns = 0;

  return {
    session,
    policyFor,
    holdsRelease,

    async connect() { return session; },

    async openThread(s: FakeSession, params: ThreadOpening) {
      const { unitId } = params;
      opened += 1;
      // What the thread was opened on, kept because the directory a thread opens
      // on is a rule of its own (PA-181) and a fake that dropped it could not test
      // that rule.
      s.opens = [...(s.opens ?? []), params];
      const thread_id = `thread-${opened}`;
      s.threads.set(unitId, thread_id);
      return { unit_id: unitId, thread_id, model: 'fake', effort: 'low', started_at: new Date().toISOString() };
    },

    async resumeThread(s: FakeSession, params: ThreadOpening & { threadId: string }) {
      const { threadId } = params;
      s.opens = [...(s.opens ?? []), params];
      s.resumed = [...(s.resumed ?? []), threadId];
      return { thread: { id: threadId }, status: { type: 'idle' } };
    },

    async turn(s: FakeSession, params: TurnParams) {
      turns += 1;
      s.turns.push(params);
      const produced = await onTurn(s, params, turns);
      const result: TurnResult = typeof produced === 'string' ? { status: produced } : produced;
      return {
        thread_id: params.threadId,
        turn_id: result.turn_id ?? `turn-${turns}`,
        client_user_message_id: params.clientUserMessageId ?? null,
        status: result.status,
        completed_at: result.completed_at ?? new Date().toISOString(),
        error: result.error ?? null,
        items: result.items ?? [],
        // What the model said, as the real harness reads it off the turn. A fake
        // that could not express this could not test the rule that reads it.
        agent_message: result.agent_message ?? null,
        token_usage: result.token_usage ?? null,
        events: []
      };
    },

    async listToolServerStatus() { return statuses(); },

    onToolServerStatus(s: FakeSession, handler: (status?: unknown) => void) {
      s.statusHandlers.push(handler);
      return () => { s.statusHandlers = s.statusHandlers.filter((h) => h !== handler); };
    }
  };
}
