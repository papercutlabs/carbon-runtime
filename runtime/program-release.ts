// The release envelope the program handler reads. Paths come from the store,
// never from the rendered prompt. The loop submits replies through the existing
// reply gate; this module does not send them.

import type { MessageRecord } from '../stream/store.ts';
import type { Declaration, ProgramReleaseInput, ProgramResult } from './types.ts';
import { StreamFault } from '../stream/store.ts';
import { fault, RuntimeFault } from './faults.ts';
import { replyHandler, recordsReplyHandler } from './reply-tool.ts';

type AttachmentRow = {
  file?: string; mime?: string; bytes?: number; sha256?: string;
  download_failed?: boolean; filename?: string;
};

export function programReleaseInput(records: MessageRecord[], {
  releaseId, threadId, store, checkout, work
}: {
  releaseId: string; threadId: string;
  store: { under(...components: string[]): string };
  checkout: string; work: string;
}): ProgramReleaseInput {
  const first = records[0];
  return {
    schema: 'carbon.program-release.v1',
    release_id: releaseId,
    conversation_id: first.conversation_id,
    thread_id: threadId,
    client_user_message_id: releaseId,
    checkout,
    work,
    messages: records.map((record) => ({
      message_id: record.message_id,
      source_message_id: record.platform_message_id,
      revision: record.revision ?? 0,
      caption: record.body ?? '',
      sender_id: record.sender_id,
      sender_name: record.sender_name ?? null,
      received_at: record.received_at,
      attachments: ((record.attachments ?? []) as AttachmentRow[]).map((attachment) => ({
        filename: attachment.filename ?? null,
        mime: attachment.mime ?? null,
        bytes: attachment.bytes ?? null,
        sha256: attachment.sha256 ?? null,
        path: typeof attachment.file === 'string' ? store.under(attachment.file) : null,
        download_failed: attachment.download_failed === true
      }))
    }))
  };
}

type ReplyHost = {
  declaration: Declaration;
  store: {
    read(conversation_id: string, message_id: string, revision?: number): MessageRecord | null;
    parkFailed(record: MessageRecord, faults: unknown, options?: { reason?: string | null }): MessageRecord;
    recordsIn(id: string): MessageRecord[];
    releaseHeldReply?(id: string): unknown;
  };
  agent: string;
  work: string;
  recordsActionUrl?: string;
  log: (line: Record<string, unknown>) => unknown;
  hasOutbound(record: MessageRecord, releaseId: string): boolean;
  markReplyOutcome(records: MessageRecord[], outcome: string): void;
  heldReply(record: MessageRecord, releaseId: string): MessageRecord | null;
  recordedThisRelease(releaseId: string): boolean;
};

function gateFaults(error: unknown) {
  if (error instanceof StreamFault) return error.faults;
  const named = error as { name?: string; faults?: { code?: string }[] };
  if (named?.name === 'ToolFault' && Array.isArray(named.faults)) return named.faults;
  return null;
}

function replyArgs(reply: NonNullable<ProgramResult['replies']>[number]) {
  const args: Record<string, unknown> = {
    conversation_id: reply.conversation_id,
    request_id: reply.request_id,
    text: reply.text
  };
  if (reply.attachments !== undefined) args.attachments = reply.attachments;
  if (reply.about_job !== undefined) args.about_job = reply.about_job;
  if (reply.about_move !== undefined) args.about_move = reply.about_move;
  return args;
}

export async function applyProgramReply(host: ReplyHost, record: MessageRecord, records: MessageRecord[], releaseId: string, result: { program?: ProgramResult }) {
  if (host.hasOutbound(record, releaseId)) return { outcome: 'replied' };
  const program = result.program;
  if (!program || (program.disposition !== 'reply' && program.disposition !== 'no_reply' && program.disposition !== 'missing_case')) {
    throw new RuntimeFault(fault('PROGRAM_RESPONSE_INVALID', record.message_id,
      'the program turn completed without a reply, no_reply, or missing_case disposition',
      'return one carbon.program-result.v1 document'));
  }
  if (program.disposition === 'no_reply') {
    host.markReplyOutcome(records, 'no-reply-declared');
    host.log({ event: 'reply.none_due', message_id: record.message_id, release_id: releaseId, disposition: 'no_reply' });
    return { outcome: 'no-reply-declared' };
  }
  if (program.disposition === 'missing_case') {
    host.markReplyOutcome(records, 'missing-case');
    host.log({ event: 'reply.missing_case', message_id: record.message_id, release_id: releaseId });
    return { outcome: 'missing-case' };
  }
  const reply = program.replies?.[0];
  if (!reply) {
    throw new RuntimeFault(fault('PROGRAM_RESPONSE_INVALID', record.message_id,
      'disposition reply did not include its reply',
      'return exactly one reply object'));
  }
  const handler = host.declaration.records?.enabled === true
    ? recordsReplyHandler({
      store: host.store as never, agent: host.agent, declaration: host.declaration,
      work: host.work, actionUrl: host.recordsActionUrl
    })
    : replyHandler({ store: host.store as never, agent: host.agent, declaration: host.declaration, work: host.work });
  try {
    await handler(replyArgs(reply));
  } catch (error) {
    const faults = gateFaults(error);
    if (!faults) throw error;
    for (const one of records) {
      const onDisk = host.store.read(one.conversation_id, one.message_id, one.revision);
      if (onDisk) host.store.parkFailed(onDisk, faults, { reason: 'program-reply-gate' });
    }
    host.log({ event: 'reply.parked', message_id: record.message_id, release_id: releaseId, faults });
    return { outcome: 'parked-gate' };
  }
  return { outcome: 'replied' };
}

export function programTeachCheck(host: ReplyHost, record: MessageRecord, releaseId: string) {
  const held = host.heldReply(record, releaseId);
  if (held === null) return { outcome: 'not-held' };
  if (host.recordedThisRelease(releaseId)) {
    host.store.releaseHeldReply?.(releaseId);
    return { outcome: 'released' };
  }
  const cause = fault('TEACHING_UNRECORDED', record.message_id,
    'a program reply was held for a teaching check and nothing was recorded; a program harness does not take a follow-up turn',
    'record the teaching in the handler before the reply, or do not reply from the management conversation until it is recorded');
  const onDisk = host.store.read(held.conversation_id, held.message_id, held.revision);
  if (onDisk) host.store.parkFailed(onDisk, cause, { reason: 'unrecorded-teaching' });
  host.log({ event: 'teach_check.parked', message_id: record.message_id, release_id: releaseId });
  return { outcome: 'parked-unrecorded-teaching' };
}
