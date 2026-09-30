import type { Store, MessageRecord, Attachment } from '../stream/store.ts';
import type { Declaration } from './types.ts';
type ReplyArgs = { conversation_id: string; request_id: string; text: string; attachments?: unknown[] | null;
  about_job?: string; about_move?: string };
type ReplyOptions = { store: Store; agent: string; declaration?: Declaration | null; work?: string | null };
// The `reply` tool: the one door out of a turn.
//
// It writes an outbound record as `pending` and returns. It does not send. The
// adapter, which is already polling, sends what it finds pending and writes the
// chunk ids back, so a reply that was written survives the process dying between
// the write and the send.
//
// `request_id` is the fence, and on this harness it is the only one. The
// app-server does not deduplicate on `clientUserMessageId` — two turns carrying
// one id both ran — so nothing upstream stops a re-issued release from producing
// a second reply. The runtime tells the model the request_id to use, the id is
// the release id and is the same on a re-issue, and the store refuses or answers
// accordingly:
//
//   already sent      the stored chunk ids come back and nothing is sent again
//   already pending   refused; one reply is in flight
//   already unknown   refused; an uncertain send is never retried blindly
//   already failed    allowed; a failure is a known non-delivery
//
// Four arguments, all explicit, none guessed: which conversation, which request,
// what text, and optionally which files this turn created to send with it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../tools/lib/mcp.ts';
import { StreamFault } from '../stream/store.ts';
import { fault } from '../stream/faults.ts';
import { managementConversationOf } from './channel.ts';
import { beginBoundAction, finishMappedAction } from '../tools/lib/action-check.ts';

export const REPLY_SERVER_NAME = 'carbon-reply';
// The reply tool listens here unless a caller names another port. It is a
// constant and not a guess: install renders the same number into the config.toml
// the harness reads, and the two have to agree before the process starts.
export const REPLY_PORT = 8730;

export const MANIFEST = {
  schema: 'carbon.tool-server.v1',
  name: REPLY_SERVER_NAME,
  version: '1',
  entry: 'runtime/reply-tool.ts',
  transport: 'http',
  secrets: [],
  tools: [
    {
      name: 'reply',
      description: 'Send one reply on the conversation this turn is about. Call it exactly once per turn, with the request_id this turn was given.',
      readOnlyHint: false,
      // It writes to a channel, not to the client's system of record, so it is
      // not a write the declaration's write gate stands in front of.
      writes: false,
      arguments: {
        type: 'object',
        additionalProperties: false,
        required: ['conversation_id', 'request_id', 'text'],
        properties: {
          conversation_id: { type: 'string', minLength: 1, description: 'the conversation the message arrived on, exactly as this turn stated it' },
          request_id: { type: 'string', minLength: 1, description: 'the request_id this turn was given; a second call with the same one never sends twice' },
          text: { type: 'string', minLength: 1, description: 'what to say' },
          attachments: {
            type: 'array',
            description: 'absolute paths of files this turn created under the work directory, for example ["/srv/carbon/mtu-agent/work/bor.pdf"]; omit or pass [] when there is no file'
          },
          about_job: { type: 'string', description: 'job id for a mapped SOP action; use an empty string for an ordinary reply' },
          about_move: { type: 'string', description: 'SOP move for a mapped action; use other only when no installed SOP maps this send' }
        }
      },
      returns: {
        what: 'what happened to the reply.',
        fields: [
          { name: 'status', what: 'written when the reply is now queued to send, held when it is written and goes out at the end of this turn, already_sent when this request_id was already delivered' },
          { name: 'request_id', what: 'the fence this reply was written under' },
          { name: 'chunk_ids', what: 'the channel ids of an already delivered reply, empty for one just written' }
        ]
      }
    }
  ]
};

// The open release on a conversation, which is what a reply is a reply to: a
// record released to the model and not yet completed. The link is written on the
// outbound record as reply_to so a transport can hang its reply under the newest
// message. A restart matches delivery.request_id against release.turn_id.
export function openReleaseIn(store: Store, conversation_id: string) {
  return store.recordsIn(conversation_id)
    .filter((r) => r.direction === 'inbound' && r.release && !r.release.completed_at)
    .sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    .at(-1) ?? null;
}

function resolveWorkRoot(work: unknown) {
  if (typeof work !== 'string' || work.length === 0) {
    throw new StreamFault([fault('WORK_DIR_ABSENT', String(work ?? ''),
      'the reply tool sends only files from the turn workspace, and no workspace was given',
      'start the reply server with the agent work directory')]);
  }
  try {
    return fs.realpathSync(work);
  } catch {
    throw new StreamFault([fault('WORK_DIR_ABSENT', work,
      'the work directory does not exist',
      'run carbon install, which places the work directory')]);
  }
}

function insideWork(root: string, resolved: string) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

function readAttachments(paths: unknown[] | null | undefined, work: unknown) {
  const list = paths ?? [];
  if (list.length === 0) return [];
  const root = resolveWorkRoot(work);
  const faults = [];
  const ready = [];
  for (const given of list) {
    if (typeof given !== 'string' || !given.startsWith('/')) {
      faults.push(fault('PATH_NOT_ABSOLUTE', String(given),
        'a reply attachment is an absolute workspace path',
        'pass the absolute path of a file this turn created'));
      continue;
    }
    let resolved;
    try {
      resolved = fs.realpathSync(given);
    } catch {
      faults.push(fault('ATTACHMENT_MISSING', given,
        'no file exists at this path',
        'write the file first, then pass its absolute path'));
      continue;
    }
    if (!insideWork(root, resolved)) {
      faults.push(fault('ATTACHMENT_OUTSIDE_WORK', given,
        'a reply attachment must resolve inside the turn workspace',
        'pass a file this turn created under the work directory'));
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      faults.push(fault('ATTACHMENT_MISSING', given,
        'no file exists at this path',
        'write the file first, then pass its absolute path'));
      continue;
    }
    if (!stat.isFile()) {
      faults.push(fault('ATTACHMENT_NOT_A_FILE', given,
        'this path is not a file',
        'pass the absolute path of a file this turn created'));
      continue;
    }
    const bytes = fs.readFileSync(resolved);
    const mime = bytes.slice(0, 5).toString() === '%PDF-' || resolved.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'application/octet-stream';
    ready.push({ bytes, mime, filename: path.basename(resolved) });
  }
  if (faults.length > 0) throw new StreamFault(faults);
  return ready;
}

function attachmentsFromPaths(store: Store, record: MessageRecord, paths: unknown[] | null | undefined, work: unknown) {
  const ready = readAttachments(paths, work);
  return ready.map((one) => store.putAttachment(record, one.bytes, {
    mime: one.mime,
    filename: one.filename
  }));
}

export function outboundRecord(store: Store, { agent, conversation_id, request_id, text, attachments = [], work = null, now = new Date() }: ReplyArgs & { agent: string; work?: string | null; now?: Date }) {
  const inbound = store.recordsIn(conversation_id).filter((r) => r.direction === 'inbound');
  if (inbound.length === 0) {
    throw new StreamFault([{
      code: 'CONVERSATION_NOT_OWNED',
      subject: conversation_id,
      problem: 'this agent has captured nothing on this conversation, so it does not answer on it',
      fix: 'reply on a conversation this agent owns'
    }]);
  }
  // inbound is nonempty after the refusal above.
  const newest = inbound.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at))).at(-1)!;
  const open = openReleaseIn(store, conversation_id);
  const record: MessageRecord<Attachment> = {
    schema: 'carbon.message.v1',
    agent,
    source: newest.source,
    account: newest.account,
    conversation_id,
    conversation_kind: newest.conversation_kind,
    message_id: `${conversation_id}:reply-${request_id}`,
    platform_message_id: `reply-${request_id}`,
    revision: 0,
    direction: 'outbound',
    role: 'agent',
    sender_id: agent,
    sent_at: now.toISOString(),
    received_at: now.toISOString(),
    body: text,
    attachments: [],
    historical: false,
    disposition: 'captured',
    delivery: {
      request_id,
      status: 'pending',
      text_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    }
  };
  if (open) record.reply_to = open.message_id;
  record.attachments = attachmentsFromPaths(store, record, attachments, work);
  return record;
}

// Which conversation's replies are held until the turn that wrote them has been
// asked about what it recorded, or null when none are. It is the management
// conversation, and only when the declaration turns teaching on: that is the one
// room where a message can be a standing instruction, so it is the one room where
// a reply that claims a memory can be a reply about a memory that does not exist.
// A customer or an ops conversation is untouched by any of this and its replies go
// out exactly as they did before.
export function teachCheckConversation(declaration: Declaration | null | undefined) {
  if (declaration?.teaching?.enabled !== true) return null;
  return managementConversationOf(declaration);
}

// The handler, separated from the server so the fence can be tested without a
// socket.
//
// The declaration is what says whether this reply is held. Without one — which is
// every caller that is not the runtime — nothing is held and the reply is written
// as it always was.
function replyWriter({ store, agent, declaration = null, work = null, now = () => new Date() }: ReplyOptions & { now?: () => Date }) {
  const heldIn = teachCheckConversation(declaration);
  // createServer calls this with parseArguments leftovers (Record<string, unknown>)
  // and unknown context. Named fields are the original reads, not a new check.
  return (args: Record<string, unknown>, actionClaim?: { kind: 'claimed'; job: string; step: string; action_id: string }) => {
    const record = outboundRecord(store, {
      agent,
      conversation_id: args.conversation_id as string,
      request_id: args.request_id as string,
      text: args.text as string,
      attachments: args.attachments as ReplyArgs['attachments'],
      work,
      now: now()
    });
    if (actionClaim) record.delivery!.action_claim = actionClaim;
    const held = heldIn !== null && args.conversation_id === heldIn;
    const written = store.reply(record, { status: held ? 'pending-teach-check' : 'pending' });
    if (written.fenced === 'sent') {
      return {
        data: { status: 'already_sent', request_id: args.request_id, chunk_ids: written.chunk_ids },
        text: 'This reply was already delivered under this request_id. Nothing was sent again.'
      };
    }
    return {
      data: { status: held ? 'held' : 'written', request_id: args.request_id, chunk_ids: [] },
      text: held
        ? 'The reply is written and goes out when this turn ends. If this client just told you how to operate, record it now with remember or raise_change; what you say you will do and what is on record have to be the same thing.'
        : 'The reply is written and will be sent on this channel.'
    };
  };
}

export function replyHandler(options: ReplyOptions & { now?: () => Date }) {
  const write = replyWriter(options);
  return (args: Record<string, unknown>) => write(args);
}

export function recordsReplyHandler({ store, agent, declaration = null, work = null,
  now = () => new Date(), actionUrl }: ReplyOptions & { now?: () => Date; actionUrl?: string }) {
  const write = replyWriter({ store, agent, declaration, work, now });
  return async (args: Record<string, unknown>) => {
    // Validate ownership and attachments before reserving a job action. This
    // preflight does not write attachment blobs if the action is refused.
    const conversation = args.conversation_id as string;
    if (!store.recordsIn(conversation).some((record) => record.direction === 'inbound')) {
      throw new StreamFault([fault('CONVERSATION_NOT_OWNED', conversation,
        'this agent has captured nothing on this conversation, so it does not answer on it',
        'reply on a conversation this agent owns')]);
    }
    readAttachments(args.attachments as ReplyArgs['attachments'], work);
    const existing = store.readRequest(args.request_id as string);
    if (existing && existing.status !== 'failed') return write(args);
    if (typeof args.about_job !== 'string' || typeof args.about_move !== 'string') {
      throw new StreamFault([fault('JOB_ACTION_CONTEXT_REQUIRED', String(args.request_id),
        'records-enabled replies must say which job and move this send is about',
        'pass about_job and about_move, using an empty job and other for an ordinary reply')]);
    }
    const claim = await beginBoundAction({ unit: args.conversation_id as string,
      operation: 'carbon-send', about_job: args.about_job, about_move: args.about_move,
      source_id: args.request_id as string }, { baseUrl: actionUrl });
    return write(args, claim.kind === 'claimed' ? claim : undefined);
  };
}

export async function recordSentAction(store: Store, record: MessageRecord,
  { actionUrl, now = () => new Date() }: { actionUrl?: string; now?: () => Date } = {}) {
  const claim = record.delivery?.action_claim as { job?: unknown; step?: unknown; action_id?: unknown } | undefined;
  if (!claim || typeof claim.job !== 'string' || typeof claim.step !== 'string'
    || typeof claim.action_id !== 'string') {
    throw new StreamFault([fault('JOB_ACTION_CLAIM_INVALID', record.message_id,
      'the sent reply has no usable job action claim', 'repair the outbound record before reconciling its SOP move')]);
  }
  const proof = crypto.createHash('sha256').update(JSON.stringify({
    message_id: record.message_id, chunk_ids: record.delivery?.chunk_ids ?? []
  })).digest('hex');
  await finishMappedAction({ kind: 'claimed', job: claim.job, step: claim.step, action_id: claim.action_id },
    `carbon-send:${proof}`, { baseUrl: actionUrl });
  store.annotate(record, { action_recorded_at: now().toISOString() });
}

export function createReplyServer({ store, agent, declaration = null, work = null }: ReplyOptions) {
  return createServer({
    manifest: MANIFEST,
    handlers: { reply: declaration?.records?.enabled === true
      ? recordsReplyHandler({ store, agent, declaration, work })
      : replyHandler({ store, agent, declaration, work }) }
  });
}

export async function serveReplyTool({ store, agent, declaration = null, work = null, host = '127.0.0.1', port = REPLY_PORT }: ReplyOptions & { host?: string; port?: number }) {
  const server = createReplyServer({ store, agent, declaration, work });
  const { server: http, url } = await server.serveHttp({ host, port });
  return { http, url, close: () => new Promise<unknown>((resolve) => http.close(resolve)) };
}
