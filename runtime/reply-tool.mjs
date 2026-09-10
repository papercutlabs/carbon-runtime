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
// Three arguments, all explicit, none guessed: which conversation, which request,
// what text.

import crypto from 'node:crypto';
import { createServer } from '../tools/lib/mcp.mjs';
import { StreamFault } from '../stream/store.mjs';

export const REPLY_SERVER_NAME = 'carbon-reply';
// The reply tool listens here unless a caller names another port. It is a
// constant and not a guess: install renders the same number into the config.toml
// the harness reads, and the two have to agree before the process starts.
export const REPLY_PORT = 8730;

export const MANIFEST = {
  schema: 'carbon.tool-server.v1',
  name: REPLY_SERVER_NAME,
  version: '1',
  entry: 'runtime/reply-tool.mjs',
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
          text: { type: 'string', minLength: 1, description: 'what to say' }
        }
      },
      returns: {
        what: 'what happened to the reply.',
        fields: [
          { name: 'status', what: 'written when the reply is now queued to send, already_sent when this request_id was already delivered' },
          { name: 'request_id', what: 'the fence this reply was written under' },
          { name: 'chunk_ids', what: 'the channel ids of an already delivered reply, empty for one just written' }
        ]
      }
    }
  ]
};

// The open release on a conversation, which is what a reply is a reply to: a
// record released to the model and not yet completed. The link is written on the
// outbound record as reply_to, and a restart reads it to tell a release that was
// answered from one that was not.
export function openReleaseIn(store, conversation_id) {
  return store.recordsIn(conversation_id)
    .filter((r) => r.direction === 'inbound' && r.release && !r.release.completed_at)
    .sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    .at(-1) ?? null;
}

export function outboundRecord(store, { agent, conversation_id, request_id, text, now = new Date() }) {
  const inbound = store.recordsIn(conversation_id).filter((r) => r.direction === 'inbound');
  if (inbound.length === 0) {
    throw new StreamFault([{
      code: 'CONVERSATION_NOT_OWNED',
      subject: conversation_id,
      problem: 'this agent has captured nothing on this conversation, so it does not answer on it',
      fix: 'reply on a conversation this agent owns'
    }]);
  }
  const newest = inbound.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at))).at(-1);
  const open = openReleaseIn(store, conversation_id);
  const record = {
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
  return record;
}

// The handler, separated from the server so the fence can be tested without a
// socket.
export function replyHandler({ store, agent, now = () => new Date() }) {
  return (args) => {
    const record = outboundRecord(store, {
      agent,
      conversation_id: args.conversation_id,
      request_id: args.request_id,
      text: args.text,
      now: now()
    });
    const written = store.reply(record);
    if (written.fenced === 'sent') {
      return {
        data: { status: 'already_sent', request_id: args.request_id, chunk_ids: written.chunk_ids },
        text: 'This reply was already delivered under this request_id. Nothing was sent again.'
      };
    }
    return {
      data: { status: 'written', request_id: args.request_id, chunk_ids: [] },
      text: 'The reply is written and will be sent on this channel.'
    };
  };
}

export function createReplyServer({ store, agent }) {
  return createServer({
    manifest: MANIFEST,
    handlers: { reply: replyHandler({ store, agent }) }
  });
}

export async function serveReplyTool({ store, agent, host = '127.0.0.1', port = REPLY_PORT }) {
  const server = createReplyServer({ store, agent });
  const { server: http, url } = await server.serveHttp({ host, port });
  return { http, url, close: () => new Promise((resolve) => http.close(resolve)) };
}
