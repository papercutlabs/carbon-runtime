// The release loop: what turns records in the store into turns of the model, and
// turns of the model into messages on a channel.
//
// One pass over one channel does five things in this order, and the order is the
// point:
//
//   poll      ask the adapter what the channel has. An adapter that goes and
//             looks, a mailbox or a chat session, answers here; one whose items
//             are handed to it, the fixture, has nothing to do and says so.
//   recover   read the store, not the harness's files, and decide what a restart
//             owes: a reply written and never sent, a release opened and never
//             answered, a send whose fate nobody knows.
//   capture   list what is pending past the cursors, write it, move the cursors.
//   release   decide what may go to the model, write the release on the record
//             before the turn starts, run the turn, write the completion.
//   deliver   send the outbound records the reply tool wrote, write back every
//             chunk id.
//
// Nothing here knows what a channel is. The adapter is the channel and the
// declaration is the policy.

import { fault, RuntimeFault, EXIT } from './faults.mjs';
import { StreamFault } from '../stream/store.mjs';
import { latch } from './latch.mjs';
import { REPLY_SERVER_NAME } from './reply-tool.mjs';
import {
  failuresBeforeHold, holdFault, pollFault, pollState,
  recordPollFailure, recordPollSuccess
} from './poll.mjs';

// The unit of work a record belongs to. One harness thread per unit, named by the
// unit's id: a conversation, or a record in the client's own system when the
// client's system is where the unit lives.
export function unitIdFor(declaration, record) {
  const unit = declaration.unit_of_work ?? {};
  if (unit.kind === 'conversation') return record.conversation_id;
  if (unit.kind === 'client_record') {
    const path = String(unit.id_from ?? '').split('.').filter(Boolean);
    let at = record.adapter_fields ?? {};
    for (const step of path) at = at?.[step];
    if (typeof at === 'string' && at.length > 0) return at;
    throw new RuntimeFault(fault('UNIT_ID_ABSENT', record.message_id,
      `unit_of_work.id_from names ${JSON.stringify(unit.id_from)} and this record's adapter_fields carry no such value`,
      'have the adapter put the client record\'s id on the record, or declare unit_of_work.kind as conversation'));
  }
  throw new RuntimeFault(fault('UNIT_OF_WORK_UNKNOWN', String(unit.kind),
    'unit_of_work.kind is conversation or client_record',
    'correct unit_of_work.kind in the declaration'));
}

// Whether this record may go to the model now, and why not when it may not. The
// reasons are values rather than booleans because a person asking "why has the
// agent not answered" is asking exactly this question.
export function releaseDecision(declaration, channel, store, record, { now }) {
  if (record.direction !== 'inbound') return { release: false, reason: 'outbound' };
  if (record.historical === true) return { release: false, reason: 'historical' };
  if (record.disposition === 'parked') return { release: false, reason: 'parked' };
  if (record.release) return { release: false, reason: 'already-released' };
  if (record.role === 'operator') return { release: false, reason: 'operator-message' };
  if (store.isHeld(record.conversation_id, now)) return { release: false, reason: 'held' };

  const policy = channel.release;
  if (policy === 'immediate') return { release: true, reason: 'immediate' };
  if (policy === 'quiet') {
    const quiet = channel.quiet_ms;
    const newest = store.recordsIn(record.conversation_id)
      .filter((r) => r.direction === 'inbound')
      .map((r) => Date.parse(r.received_at))
      .filter((t) => !Number.isNaN(t))
      .reduce((a, b) => Math.max(a, b), 0);
    if (now - newest >= quiet) return { release: true, reason: 'quiet' };
    return { release: false, reason: 'not-yet-quiet' };
  }
  if (policy === 'mention') {
    return String(record.body ?? '').includes(String(channel.mention))
      ? { release: true, reason: 'mention' }
      : { release: false, reason: 'no-mention' };
  }
  throw new RuntimeFault(fault('RELEASE_POLICY_UNKNOWN', String(policy),
    'a channel releases immediate, quiet or mention',
    'correct the channel\'s release in the declaration'));
}

// The release id: stable across a restart, because it is derived from the record
// and from nothing about this process. It is the clientUserMessageId of the turn
// and the request_id the reply tool fences on, which is what makes a re-issued
// release produce one reply rather than two.
// A time, as a record carries one: an ISO string, or nothing.
//
// The protocol's Turn carries `startedAt` and `completedAt` as "Unix timestamp
// (in seconds)", and everything else in it that is a time is milliseconds. A
// number here is therefore seconds, and reading it as milliseconds writes 1970
// onto the record, which is what happened the first time this was run.
export function when(seconds) {
  if (typeof seconds === 'number' && Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  if (typeof seconds === 'string' && seconds.length > 0) return seconds;
  return null;
}

export function releaseIdFor(record) {
  return `release-${record.message_id}-${record.revision ?? 0}`;
}

// What the model is given. The envelope is small on purpose: the body, who it is
// from, and the two identifiers a reply needs. The request_id is in the text
// because the fence only works if the model uses the id the runtime chose.
//
// The instruction is the first line and the last line, because a model that
// answers in its own message rather than through the tool has read the body and
// forgotten the frame, and the two positions a long input is read at are its
// start and its end. The first real message on a box was answered exactly that
// way: a completed turn, a good answer, and nothing that ever left the machine.
export function replyInstruction(record, releaseId) {
  return `Reply by calling the reply tool once, with conversation_id ${JSON.stringify(record.conversation_id)} and request_id ${JSON.stringify(releaseId)}. Nothing you write outside that tool call reaches anyone.`;
}

export function turnInput(record, releaseId) {
  const instruction = replyInstruction(record, releaseId);
  return [
    instruction,
    '',
    `A message arrived on conversation ${record.conversation_id}.`,
    `from: ${record.sender_name ?? record.sender_id}`,
    `received_at: ${record.received_at}`,
    `conversation_id: ${record.conversation_id}`,
    `request_id: ${releaseId}`,
    '',
    record.body ?? '',
    '',
    instruction
  ].join('\n');
}

// The one follow-up. A turn that completed and delivered nothing gets asked once,
// on its own thread, in words that leave the model two ways out and no third: call
// the tool, or say that no reply is due.
export const NO_REPLY = 'NO_REPLY';

// How much of the model's own message is kept on the thread record. Enough to
// read what it said and why it thought that was an answer; not the whole turn,
// because a store is not a transcript.
export const AGENT_MESSAGE_KEPT = 300;

export function followUpInput(record, releaseId) {
  return [
    'Your last message was not delivered: nothing reaches the contact except a call to the reply tool.',
    `Call reply now with conversation_id ${JSON.stringify(record.conversation_id)} and request_id ${JSON.stringify(releaseId)}, or answer exactly ${NO_REPLY} if no reply is due.`
  ].join('\n');
}

export function saidNoReply(text) {
  return typeof text === 'string' && text.trim() === NO_REPLY;
}

// Which faults end the process, and which one record's release.
//
// A record the runtime cannot release is one record: a message with no unit id,
// a body the turn builder refuses, anything else raised while this record is
// being released. Exiting on it puts systemd in a restart loop that meets the
// same record every time and reaches the start limit, which is what happened the
// first time a real message landed on a box. So the record is parked with the
// fault written on it, doctor names it, and the channel keeps working.
//
// Three endings are not about a record and still end the process: the harness
// child exiting mid-turn (EXIT.HARNESS_EXITED), the terminal latch
// (EXIT.LATCHED), and the lock (EXIT.LOCK_HELD), each of which carries its own
// exit code on the fault. One more is a refusal about the whole agent rather
// than one message: an app-server listing tool servers nobody declared is an
// agent that is not the agent the declaration describes, and parking messages
// under it would answer with tools nobody granted.
const ENDS_THE_PROCESS = new Set([
  'HARNESS_CHILD_EXITED_MID_TURN',
  'TOOL_SERVER_UNDECLARED',
  'TOOL_SERVER_NOT_LISTED'
]);

export function endsTheProcess(error) {
  if (!(error instanceof RuntimeFault)) return true;
  if (error.exitCode !== EXIT.FAULT) return true;
  return (error.faults ?? []).some((f) => ENDS_THE_PROCESS.has(f.code));
}

export class ReleaseLoop {
  constructor({
    declaration, channel, store, storeDir, adapter, harness, session,
    agent, checkout, log = () => {}, now = () => Date.now()
  }) {
    this.declaration = declaration;
    this.channel = channel;
    this.store = store;
    this.storeDir = storeDir;
    this.adapter = adapter;
    this.harness = harness;
    this.session = session;
    this.agent = agent;
    this.checkout = checkout;
    this.log = log;
    this.now = now;
    this.threads = new Map();
    this.toolStatusRead = false;
    this.toolStatusStale = true;
    this.holdFaults = [];
    this.items = () => [];
  }

  context(items = []) {
    return {
      store: this.store,
      agent: this.agent,
      account: this.channel.account,
      channel: this.channel,
      declaration: this.declaration,
      items,
      dry_run: false,
      now: this.now()
    };
  }

  // ---- the harness thread -------------------------------------------------

  // One thread per unit. A unit whose thread record shows no completed turn gets
  // a fresh thread: a thread that has never taken a turn has no rollout on disk
  // and cannot be resumed, so resuming it is an error where starting again is
  // free.
  async threadFor(unitId) {
    if (this.threads.has(unitId)) return this.threads.get(unitId);
    const existing = this.store.readThread(unitId);
    const opening = {
      cwd: this.checkout,
      model: this.declaration.model,
      effort: this.declaration.effort,
      sandbox: this.declaration.sandbox?.mode,
      unitId
    };
    let threadId;
    if (existing && existing.thread_id && existing.completed_turns > 0) {
      await this.harness.resumeThread(this.session, { ...opening, threadId: existing.thread_id });
      threadId = existing.thread_id;
      this.log({ event: 'thread.resumed', unit_id: unitId, thread_id: threadId });
    } else {
      const record = await this.harness.openThread(this.session, opening);
      threadId = record.thread_id;
      this.store.writeThread(unitId, { ...record, completed_turns: 0, turns: [] });
      this.log({ event: 'thread.opened', unit_id: unitId, thread_id: threadId });
    }
    this.threads.set(unitId, threadId);
    await this.readToolServerStatus(threadId);
    return threadId;
  }

  // ---- tool servers -------------------------------------------------------

  // Read after the thread is open, never before: on the pinned binary every
  // server reads runtimeStatus null until the list is read with the id of a
  // thread this connection has loaded, and null means "not known", not "down".
  async readToolServerStatus(threadId) {
    const statuses = await this.harness.listToolServerStatus(this.session, { threadId });
    if (!this.toolStatusRead) {
      this.refuseUndeclaredServers(statuses);
      this.toolStatusRead = true;
    }
    this.holdFaults = this.harness.holdsRelease(this.declaration, statuses);
    this.toolStatusStale = false;
    if (this.holdFaults.length > 0) this.log({ event: 'tool_server.hold', faults: this.holdFaults });
    return statuses;
  }

  // The set the app-server lists must equal the set the declaration names plus
  // the reply tool. A ChatGPT login injects a connected-apps server nobody
  // declared, carrying mail tools; an agent with tools nobody declared is not the
  // agent the declaration describes, so the runtime refuses to run rather than
  // reporting it later.
  refuseUndeclaredServers(statuses) {
    const declared = new Set([
      ...(this.declaration.tool_servers ?? []).map((s) => s.name),
      REPLY_SERVER_NAME
    ]);
    const listed = new Set(statuses.map((s) => s.name));
    const faults = [];
    for (const name of [...listed].filter((n) => !declared.has(n)).sort()) {
      faults.push(fault('TOOL_SERVER_UNDECLARED', name,
        `the harness lists a tool server named ${JSON.stringify(name)} that no declaration names; it was not put there by carbon`,
        'bill the provider on an API key rather than a personal login, and remove the server from the harness configuration'));
    }
    for (const name of [...declared].filter((n) => !listed.has(n)).sort()) {
      faults.push(fault('TOOL_SERVER_NOT_LISTED', name,
        'the declaration names this tool server and the harness does not list it at all',
        'check that install rendered it into config.toml, and that the name matches'));
    }
    if (faults.length > 0) throw new RuntimeFault(faults);
  }

  // ---- poll ---------------------------------------------------------------

  // Ask the adapter what the channel has. An adapter that exports `poll` goes to
  // the channel; one that does not takes what the caller hands it, which is what
  // the fixture adapter and the conformance check do.
  //
  // Nothing here throws. A poll that failed is a fault written on the channel and
  // logged, and the pass that follows it works on what the store already holds,
  // because a mail server that is down for a minute must not take the agent's
  // unanswered messages down with it.
  async poll(handed = []) {
    if (typeof this.adapter.poll !== 'function') {
      return { polled: false, items: handed, holding: false, failures: 0 };
    }
    const at = new Date(this.now()).toISOString();
    const threshold = failuresBeforeHold(this.channel);
    let result;
    try {
      result = await this.adapter.poll(this.context());
    } catch (error) {
      const cause = pollFault(this.channel, error);
      const state = recordPollFailure(this.store, this.channel.account, this.channel.kind,
        { at, cause, threshold });
      this.log({ event: 'poll.failed', channel: this.channel.kind, account: this.channel.account,
        consecutive_failures: state.consecutive_failures, holding: state.holding, fault: cause });
      if (state.holding) this.log({ event: 'poll.hold', fault: holdFault(this.channel, state) });
      return { polled: true, items: [], holding: state.holding, failures: state.consecutive_failures, fault: cause };
    }
    const items = result?.items ?? [];
    const before = pollState(this.store, this.channel.account, this.channel.kind);
    recordPollSuccess(this.store, this.channel.account, this.channel.kind, { at, items: items.length });
    if (before.holding) {
      this.log({ event: 'poll.hold_cleared', channel: this.channel.kind, account: this.channel.account });
    }
    // A poll that read nothing is the ordinary case and says nothing; a poll that
    // found something says how much, so a log answers "when did the agent last
    // see anything" without a store walk.
    if (items.length > 0) {
      this.log({ event: 'poll', channel: this.channel.kind, account: this.channel.account, items: items.length });
    }
    return { polled: true, items, holding: false, failures: 0 };
  }

  // ---- recover ------------------------------------------------------------

  // What a restart owes, read from the store and from nothing else. The harness's
  // own files say a turn was interrupted; only the store says whether the client
  // got an answer.
  recover() {
    const summary = { resend: [], reissue: [], unknown: [], done: [] };
    for (const record of this.store.rebuild()) {
      if (record.direction === 'outbound') {
        if (record.delivery?.status === 'pending') summary.resend.push(record.delivery.request_id);
        if (record.delivery?.status === 'unknown') summary.unknown.push(record.delivery.request_id);
        continue;
      }
      if (!record.release || record.release.completed_at) continue;
      const replies = this.store.recordsIn(record.conversation_id)
        .filter((r) => r.direction === 'outbound' && r.reply_to === record.message_id);
      if (replies.some((r) => r.delivery?.status === 'sent')) {
        this.store.completeRelease(record, new Date(this.now()).toISOString());
        summary.done.push(record.message_id);
        continue;
      }
      if (replies.some((r) => r.delivery?.status === 'unknown')) {
        summary.unknown.push(record.message_id);
        continue;
      }
      if (replies.some((r) => r.delivery?.status === 'pending')) {
        // The reply is written and the transport was never called. The deliver
        // pass sends it; the release completes when the send lands.
        summary.resend.push(record.message_id);
        continue;
      }
      summary.reissue.push(record.message_id);
    }
    if (summary.resend.length + summary.reissue.length + summary.unknown.length > 0) {
      this.log({ event: 'recover', ...summary });
    }
    return summary;
  }

  // ---- capture ------------------------------------------------------------

  capture(items) {
    const pending = this.adapter.listPending(this.context(items));
    if (pending.length === 0) return { captured: [], parked: [] };
    const context = this.context(items);
    const { entries, parked } = this.adapter.payload(context, pending);
    const captured = [];
    for (const entry of entries) {
      const attachments = [];
      for (const attachment of entry.attachments ?? []) {
        attachments.push(attachment.bytes !== undefined
          ? this.store.putAttachment(entry.record, Buffer.from(attachment.bytes), attachment)
          : attachment);
      }
      const record = { ...entry.record, attachments };
      try {
        const written = this.store.capture(record, { raw: entry.raw, cursor: entry.cursor });
        captured.push(written.record);
      } catch (error) {
        if (!(error instanceof StreamFault)) throw error;
        this.log({ event: 'capture.refused', message_id: record.message_id, faults: error.faults });
      }
    }
    for (const item of parked) {
      this.store.park(item.record, item.reason, { raw: item.raw, cursor: item.cursor });
    }
    for (const item of pending) this.adapter.consume(this.context(items), item);
    return { captured, parked: parked.map((p) => p.record.message_id) };
  }

  // ---- release ------------------------------------------------------------

  async releasePass({ reissue = [] } = {}) {
    if (this.toolStatusStale && this.threads.size > 0) {
      await this.readToolServerStatus([...this.threads.values()][0]);
    }
    const holding = this.holdFaults.map((f) => f.subject);
    if (this.holdFaults.length > 0) {
      const waiting = this.store.rebuild()
        .filter((r) => r.direction === 'inbound' && !r.release && r.historical !== true)
        .map((r) => r.message_id);
      return { released: [], held: waiting, parked: [], holding };
    }

    const now = this.now();
    const released = [];
    const held = [];
    const parked = [];
    const reissued = new Set(reissue);
    const records = this.store.rebuild()
      .filter((r) => r.direction === 'inbound')
      .sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));

    for (const record of records) {
      const again = reissued.has(record.message_id);
      if (!again) {
        const decision = releaseDecision(this.declaration, this.channel, this.store, record, { now });
        if (!decision.release) {
          if (decision.reason === 'held' || decision.reason === 'not-yet-quiet') held.push(record.message_id);
          continue;
        }
      }
      let outcome;
      try {
        outcome = await this.releaseOne(record, { reissue: again });
      } catch (error) {
        if (endsTheProcess(error)) throw error;
        const faults = error.faults;
        this.store.parkFailed(this.store.read(record.conversation_id, record.message_id, record.revision), faults);
        this.log({ event: 'release.parked', message_id: record.message_id, faults });
        parked.push(record.message_id);
        continue;
      }
      // The status of the tool servers can only be read once a thread is open,
      // so the first candidate of a run opens the thread and then finds out
      // whether it may go. A hold discovered there holds this record too.
      if (outcome === null) {
        held.push(record.message_id);
        continue;
      }
      released.push(outcome);
      // A server whose startup status changed during the turn is read again
      // before the next release, so a required server that died at hour three
      // holds what is left rather than being noticed a pass later.
      if (this.toolStatusStale) {
        await this.readToolServerStatus([...this.threads.values()][0]);
        if (this.holdFaults.length > 0) break;
      }
    }
    return { released, held, parked, holding: this.holdFaults.map((f) => f.subject) };
  }

  async releaseOne(record, { reissue = false } = {}) {
    const unitId = unitIdFor(this.declaration, record);
    const threadId = await this.threadFor(unitId);
    if (this.holdFaults.length > 0) return null;
    const releaseId = releaseIdFor(record);

    // Written before the turn, always. A restart reads this and knows the model
    // was asked; the record's own turn_id is the release id, because that is the
    // only identifier that exists before turn/start and it is the one the reply
    // is fenced on. The harness's turn id is written on the thread record, where
    // the transcript is.
    if (!reissue) {
      this.store.release(record, {
        released_at: new Date(this.now()).toISOString(),
        thread_id: threadId,
        turn_id: releaseId,
        now: this.now()
      });
    }
    this.log({ event: 'release', message_id: record.message_id, release_id: releaseId, thread_id: threadId, reissue });

    const { result, completedAt } = await this.takeTurn({
      unitId, threadId, releaseId,
      input: turnInput(record, releaseId),
      clientUserMessageId: releaseId
    });

    // The status is recorded verbatim. `failed` is the model's own permanent
    // refusal of this input, so it closes the release, marks the record and takes
    // the terminal-latch path; `interrupted` is the box going away and is left
    // open for the next start to re-issue.
    if (result.status === 'failed') {
      this.store.setDisposition(this.store.read(record.conversation_id, record.message_id, record.revision), 'permanent-error');
      this.store.completeRelease(record, completedAt);
      throw latch(this.store, this.channel.account, this.channel.kind, fault('TURN_FAILED', record.message_id,
        `the model reported the turn failed: ${JSON.stringify(result.error ?? null)}`,
        'read the turn on the thread this record names, fix the cause, and run carbon install to clear the latch.'));
    }
    // What the turn cost, in the log rather than only on the thread record: the
    // thread record lives in the store, which a check from outside the box cannot
    // read, and "what did that answer cost" is a question asked from outside.
    this.log({
      event: 'turn', message_id: record.message_id, release_id: releaseId,
      thread_id: threadId, turn_id: result.turn_id, status: result.status,
      token_usage: result.token_usage ?? null
    });

    if (result.status !== 'completed') {
      return { message_id: record.message_id, release_id: releaseId, status: result.status, turn_id: result.turn_id };
    }

    // A completed turn is not an answered message. The one door out of a turn is
    // the reply tool, and a model that wrote a good answer into its own message
    // has delivered nothing at all. So the runtime asks once, on the same thread,
    // and then decides rather than hoping.
    const reply = await this.ensureReply(record, {
      unitId, threadId, releaseId, result, completedAt
    });
    this.store.completeRelease(record, completedAt);
    return {
      message_id: record.message_id, release_id: releaseId,
      status: result.status, turn_id: result.turn_id, reply: reply.outcome
    };
  }

  // One turn, and the thread record it writes. The record carries what the turn
  // cost and the first of what the model said, because the question asked about a
  // turn that delivered nothing is "what did it say", and nothing else keeps it.
  async takeTurn({ unitId, threadId, releaseId, input, clientUserMessageId }) {
    const result = await this.harness.turn(this.session, {
      threadId,
      input,
      effort: this.declaration.effort,
      model: this.declaration.model,
      sandboxPolicy: this.harness.policyFor(this.declaration.sandbox?.mode, {
        writableRoots: [this.storeDir],
        networkAccess: this.declaration.sandbox?.network === true
      }),
      clientUserMessageId,
      timeoutMs: this.declaration.limits?.max_turn_ms
    });

    // The harness reports a completion time the way the protocol gives it, which
    // on this one is epoch milliseconds. A record carries times as strings, so
    // the conversion happens once, here, rather than in four places downstream.
    const completedAt = when(result.completed_at) ?? new Date(this.now()).toISOString();

    const thread = this.store.readThread(unitId) ?? {};
    this.store.writeThread(unitId, {
      ...thread,
      completed_turns: (thread.completed_turns ?? 0) + (result.status === 'completed' ? 1 : 0),
      turns: [...(thread.turns ?? []), {
        release_id: releaseId,
        turn_id: result.turn_id,
        status: result.status,
        completed_at: completedAt,
        token_usage: result.token_usage ?? null,
        agent_message: typeof result.agent_message === 'string'
          ? result.agent_message.slice(0, AGENT_MESSAGE_KEPT)
          : null
      }]
    });
    return { result, completedAt };
  }

  // Whether this release produced anything for the contact. The reply tool writes
  // the outbound record under the release id it was fenced on, so that record is
  // the whole answer and the model's own message is not evidence of anything.
  hasOutbound(record, releaseId) {
    return this.store.recordsIn(record.conversation_id)
      .some((r) => r.direction === 'outbound' && r.delivery?.request_id === releaseId);
  }

  // The one follow-up, and the three ways it can end.
  async ensureReply(record, { unitId, threadId, releaseId, result, completedAt }) {
    if (this.hasOutbound(record, releaseId)) return { outcome: 'replied' };

    this.log({
      event: 'reply.absent', message_id: record.message_id, release_id: releaseId,
      said: typeof result.agent_message === 'string' ? result.agent_message.slice(0, AGENT_MESSAGE_KEPT) : null
    });

    const followUp = await this.takeTurn({
      unitId, threadId, releaseId,
      input: followUpInput(record, releaseId),
      // The protocol's id, not the reply tool's: the follow-up is a second turn
      // and carries its own, while the reply the model is being asked for is
      // still fenced on the release id it was given the first time.
      clientUserMessageId: `${releaseId}-follow-up`
    });

    if (this.hasOutbound(record, releaseId)) {
      this.log({ event: 'reply.after_follow_up', message_id: record.message_id, release_id: releaseId });
      return { outcome: 'replied-after-follow-up' };
    }

    // Said so, plainly: no reply is due. That closes the release with the reason
    // on the record, and is not a failure of anything.
    if (saidNoReply(followUp.result.agent_message)) {
      this.markReplyOutcome(record, 'no-reply-declared');
      this.log({ event: 'reply.none_due', message_id: record.message_id, release_id: releaseId });
      return { outcome: 'no-reply-declared' };
    }

    // Asked once, told plainly, and still nothing left the machine. The record is
    // parked so that a person is the next thing that happens to it.
    const cause = fault('REPLY_ABSENT', record.message_id,
      'the turn completed and the follow-up completed, and neither wrote a reply nor answered NO_REPLY, so nothing reached the contact',
      `read the thread record's agent_message for this release; the model must call the reply tool or answer ${NO_REPLY}`);
    this.store.parkFailed(
      this.store.read(record.conversation_id, record.message_id, record.revision),
      cause, { reason: 'no-reply' }
    );
    this.log({
      event: 'reply.parked', message_id: record.message_id, release_id: releaseId,
      said: typeof followUp.result.agent_message === 'string'
        ? followUp.result.agent_message.slice(0, AGENT_MESSAGE_KEPT) : null
    });
    return { outcome: 'parked-no-reply' };
  }

  // The reason a release closed with no message, written where the record is
  // rather than only in a log a restart rotates away.
  markReplyOutcome(record, outcome) {
    const on_disk = this.store.read(record.conversation_id, record.message_id, record.revision);
    this.store.annotate(on_disk, { reply_outcome: outcome });
  }

  // ---- deliver ------------------------------------------------------------

  // Every outbound record the reply tool wrote and the channel has not taken. The
  // record exists before the transport is called, so a process that dies during a
  // send leaves a pending row rather than a message nobody can account for.
  // Async because a live send is: the dry run answers directly and a real one
  // returns a promise, and awaiting the direct answer is also correct, so one
  // caller works for both. Not awaiting it is what the first live WhatsApp reply
  // cost: the promise was read for a `status` it did not have yet, the send was
  // written down as failed, and the message never left the box while the store
  // said the turn was answered.
  async deliver() {
    const sent = [];
    for (const record of this.store.rebuild()) {
      if (record.direction !== 'outbound') continue;
      if (record.delivery?.status !== 'pending') continue;
      let outcome;
      try {
        outcome = await this.adapter.send(this.context(), record);
      } catch (error) {
        // A transport that threw did not tell us whether the message arrived.
        // That is `unknown`, and an unknown send is never retried.
        this.store.markUnknown(record.delivery.request_id);
        this.log({ event: 'deliver.unknown', request_id: record.delivery.request_id, problem: error.message });
        sent.push({ request_id: record.delivery.request_id, status: 'unknown' });
        continue;
      }
      if (outcome.status === 'sent') this.store.markSent(record.delivery.request_id, outcome.chunk_ids ?? []);
      else if (outcome.status === 'unknown') this.store.markUnknown(record.delivery.request_id);
      else this.store.markFailed(record.delivery.request_id);
      this.log({ event: 'deliver', request_id: record.delivery.request_id, status: outcome.status });
      sent.push({ request_id: record.delivery.request_id, status: outcome.status });

      if (outcome.status === 'sent' && record.reply_to) {
        const answered = this.store.recordsIn(record.conversation_id)
          .find((r) => r.message_id === record.reply_to);
        if (answered && answered.release && !answered.release.completed_at) {
          this.store.completeRelease(answered, new Date(this.now()).toISOString());
        }
      }
    }
    return sent;
  }

  // ---- one pass -----------------------------------------------------------

  async pass(handed = []) {
    const polled = await this.poll(handed);
    // A held channel does no work at all this pass: not capture, which has
    // nothing new to write; not release, because the agent would answer into a
    // channel it cannot read; and not delivery, because a send on a channel whose
    // reads are failing is the send that lands `unknown` and is never retried.
    // What was recovered stays recovered and is re-issued on the pass after the
    // channel comes back.
    if (polled.holding) {
      return {
        captured: [], parked: [], released: [], held: [], holding: [`${this.channel.kind}:${this.channel.account}`],
        delivered: [], poll: polled
      };
    }
    const captured = this.capture(polled.items);
    const recovered = this.recovering ?? { reissue: [] };
    this.recovering = null;
    const released = await this.releasePass({ reissue: recovered.reissue });
    const delivered = await this.deliver();
    // Two things park a record: a payload the adapter could not read, and a
    // release that faulted. One pass can do both, so the lists are joined rather
    // than one spreading over the other.
    const parked = [...captured.parked, ...released.parked];
    return { ...captured, ...released, parked, delivered, poll: polled };
  }
}
