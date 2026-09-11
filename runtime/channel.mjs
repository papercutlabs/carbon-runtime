// What an adapter is handed as its channel.
//
// The declaration's channel block holds two kinds of thing. Some of it is policy
// every channel has: how often to poll, when to release, when an operator's
// message holds the agent. The rest is how to reach this particular channel, and
// that is the channel kind's own business: a mailbox has an IMAP host and an SMTP
// host, a chat session has neither. The declaration keeps the second kind under
// `transport`, so the shared block stays readable and a new channel kind adds no
// field to it.
//
// This module is the one place the two are put back together, and it is also
// where a secret reference becomes a path. A channel never carries a credential:
// it names a secret the declaration declares, the declaration gives that secret's
// absolute path, and the file itself is placed by its owner and read by the
// adapter at the moment it is used. A reference to a secret nobody declared is
// refused here by name, at start, rather than at the first poll.

import { fault, RuntimeFault } from './faults.mjs';

// Every transport key whose value is the name of a declared secret rather than a
// value. The resolved path is written on the channel under the key with `_ref`
// removed, which is the name the adapter reads.
const SECRET_REFS = ['netrc_ref', 'bot_token_ref'];

export function resolveChannel(declaration, channel) {
  const faults = [];
  const declared = new Map((declaration?.secrets ?? []).map((s) => [s.name, s.path]));
  const transport = { ...(channel?.transport ?? {}) };
  const resolved = {};

  for (const key of SECRET_REFS) {
    if (transport[key] === undefined) continue;
    const name = transport[key];
    delete transport[key];
    const path = declared.get(name);
    if (path === undefined) {
      faults.push(fault('CHANNEL_SECRET_UNDECLARED', `channels.${channel.kind}:${channel.account}.transport.${key}`,
        `the channel names the secret ${JSON.stringify(name)} and the declaration declares no secret by that name`,
        'declare the secret with its absolute path, or correct the reference'));
      continue;
    }
    resolved[key.slice(0, -'_ref'.length)] = path;
  }

  if (faults.length > 0) throw new RuntimeFault(faults);
  const merged = { ...channel, ...transport, ...resolved };
  delete merged.transport;
  return merged;
}

// ---- what kind of room this conversation is ---------------------------------
//
// An agent sits in three kinds of room and behaves differently in each, and the
// declaration is where a room says which it is. The difference that matters to
// the release loop is the operator hold.
//
// A customer conversation holds the business's own customer. A staff member
// writing there is taking the conversation over, so the channel's hold applies
// and the agent stops until it expires.
//
// An ops conversation is staff and contractors working beside the agent. A human
// message there is not a takeover, and the hold would silence the agent for an
// hour at a time in the room it is there to work in.
//
// The management conversation is where the client's people talk to the agent
// about how it works. No hold, the agent answers, every member is a teacher, and
// what is taught there is taught to the agent everywhere. There is one per agent
// and `carbon declaration check` refuses teaching that is enabled without
// exactly one.
export function conversationKindOf(channel, conversation_id) {
  const named = (channel?.conversations ?? []).find((c) => c?.id === conversation_id);
  if (named?.kind) return named.kind;
  // The declared default, and no default of this file's. A channel with no
  // default is a declaration `carbon declaration check` refuses; treating one as
  // customer here would be this file quietly deciding whether a staff message
  // stops the agent, which is the one thing about a room that cannot be guessed.
  return channel?.default_conversation_kind ?? null;
}

// The one conversation this agent is taught in, across every channel, or null
// when no channel declares one. The teach tools refuse a source message from
// anywhere else, so this is what they refuse against.
export function managementConversationOf(declaration) {
  const found = (declaration?.channels ?? [])
    .flatMap((channel) => channel?.conversations ?? [])
    .filter((conversation) => conversation?.kind === 'management');
  return found.length === 1 ? String(found[0].id) : null;
}
