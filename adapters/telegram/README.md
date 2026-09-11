# The Telegram adapter

One bot in, one bot out, over the Bot API's long poll. It declares `inbound` and
`outbound`, so sixteen of the seventeen conformance cases apply to it and it
passes all sixteen:

```
node bin/carbon-stream check --adapter adapters/telegram --fixtures adapters/telegram/fixtures
```

## The files, and what each one may do

| file | what it is | what it may not do |
|---|---|---|
| `index.mjs` | the adapter contract: the five operations, the rules | open a connection, read a file, hold state between passes |
| `content.mjs` | what is inside one update: the message, the words, the media, the album | anything with an input or an output |
| `cursors.mjs` | the two positions this channel counts in | anything else |
| `api.mjs` | the Bot API calls | hold a rule, or let the token reach a log or a fault |
| `live.mjs` | the long poll, the buffer, and the offset discipline | decide what a record says |

The split is what makes the rules testable: every rule in `index.mjs` is proved
against recorded updates, and no test here reaches a network or reads a token.

## There is no library, and that is the reason

The Bot API is JSON over HTTPS with no handshake, no session and no streaming. A
call is one POST to `https://api.telegram.org/bot<token>/<method>` and an answer
is `{ok: true, result}` or `{ok: false, error_code, description}`. Node 22 has
`fetch`, so `api.mjs` is under two hundred lines including its comments, and a
client library would be a dependency and a version to pin in exchange for
nothing this adapter needs. This repository has exactly one dependency, for a
channel that genuinely has no other way in; this channel is not that.

## The token

The declaration names a secret; it never holds one. `transport.bot_token_ref` is
the name of a declared secret, the declaration gives that secret's absolute path,
the box owner places the file through `carbon-apply secret place` at mode 0600
owned by the account that reads it, and `api.mjs` reads it at the moment it is
used. It is not kept on the channel, not put in this process's environment, and
not written anywhere.

The token is in the path of every URL this adapter builds, so every string that
could carry a URL — an error from `fetch`, a description from the server, a
message from the URL parser — goes through `scrub` before it reaches a fault. A
token in the unit's journal is readable by anyone who can read the box, and a bot
token is the whole credential: there is no second factor and no per-device
pairing to unlink.

## The offset is the watermark, and it moves only after a capture

This is the one rule that makes the channel durable, and it is worth stating
plainly because the Bot API's own shape hides it.

`getUpdates` has no acknowledgement. An update is deleted at the server when the
*next* call asks for an offset past it, and it is then gone: there is no second
delivery and no way to ask for it again. So an offset advanced before the record
is on disk is a message the server will never send again and this box never
wrote.

The offset therefore lives in the store's own cursor, under the conversation id
`<account>:updates`, and `consume` is the only thing that moves it — the same
place, and the same write order, as every other cursor here. The long poll runs
behind the release loop and will not ask for a higher offset until the loop has
consumed what it was handed. A restart in the middle loses nothing: the offset on
disk is the last thing captured, and the server still holds everything after it.

`test/telegram.api.test.mjs` proves this against a recording server: the worker
is watched asking, and it asks for the higher offset only after `consume` has
run.

The cost is that a batch waits one pass in the buffer. The alternative — fetch
ahead and keep what is not consumed in memory — buys a little latency and pays
for it with every message in flight when the process dies, which is not a trade
this programme makes with a client's messages.

## Two positions, and why they are different numbers

| position | what it orders | where it is used |
|---|---|---|
| the chat-local `message_id` | one conversation | the message and revision cursors |
| the `update_id` | the account's whole update stream | the getUpdates offset |

Telegram numbers a chat's messages in order, and an edit arrives carrying the id
of the message it corrects rather than an id of its own. So a correction of
something read long ago sits below the message cursor and above the revision
cursor, which is exactly what case 17 is about, and it works only because a
conversation is ordered by the message id. The update id could not do it: an edit
gets a fresh, higher one.

For a revision the cursor is the fast path and the store is the answer, because
an edit of an older message than the last edited one sits below the revision
cursor too. An edit already written carries `adapter_fields.edit_date`; one that
is not there is pending however the positions fall.

## The edge cases, and what this adapter does about each

1. **A bot is reachable by anyone who knows its name.** That is not true of a
   mailbox or a paired phone, and it is the fact the adapter is shaped around.
   `transport.allowed_chat_ids` names the chats the agent answers, or is the word
   `any`. A message from any other chat is captured with `disposition:
   policy-drop` and `send` refuses a reply to it by name. The record is kept: it
   happened, and a client agent keeps what arrived.
2. **An album loses its later items if it is collapsed.** Telegram sends an album
   as several ordinary messages a moment apart, each carrying the same
   `media_group_id` and one picture, usually with the caption on the first. Every
   item gets its own record, carrying the group id. PA-147 is the gap the other
   shape makes: a set of pictures went in and everything after the first came out
   nowhere. One record per item cannot lose an item. The cost is that the agent
   may see the first before the sixth has arrived, which is what the channel's
   release policy is for: a channel that receives albums declares `quiet`.
3. **A photograph arrives as a list of sizes of one picture.** The largest is
   kept. Keeping any other is keeping a thumbnail and calling it the attachment.
4. **The words of a message with a file on it are in `caption`, not `text`.**
   Both are the body.
5. **There is no "from my own device".** The bot and the person are two accounts,
   so Telegram gives nothing like a paired phone's `fromMe`. Who the operator is
   is therefore a declared fact: `transport.operator_sender_ids`. A message from
   one is `role: operator` and holds the agent per the channel's `hold` block.
6. **The bot's own message can come back** when it administers the chat it posted
   in. It is `role: agent`, `direction: outbound`, and it sets no hold: it is
   already in the store as the outbound record that produced it, and it is
   emphatically not a person speaking.
7. **A service message has neither words nor media.** Somebody joined, the title
   changed, a message was pinned. It is parked where it landed, never delivered
   and never dropped.
8. **An update type this adapter has no reading for** is parked with its type
   named, and its offset still moves — otherwise the poll meets the same update
   forever. The adapter asks the server for four types by name, so this is the
   path for a type Telegram adds rather than for a reaction on a message.
9. **A reply over 4096 characters is refused outright** by the server, with a 400
   and no partial send. A long answer goes out as several messages, cut at a
   paragraph, then a sentence, then a word, and only at a character when one word
   is longer than a whole message. Every chunk's id is written back.
10. **A reply in a group hangs under the message it answers.** In a private chat
    everything is already one thread and the quoted block is noise, so only the
    first chunk of a group reply carries `reply_parameters`.
11. **A refusal and a silence are different outcomes.** A `{ok: false}` body is
    the server's own answer, which means the request arrived and was refused, so
    nothing went out and the send `failed`. A timeout, a reset or a DNS failure
    happened where nobody can see whether the server acted, and is `unknown`,
    which is never retried. So is a refusal that arrives after some chunks are
    already in the chat.
12. **Privacy mode is on by default.** A bot in a group sees only the messages
    that name it until privacy mode is turned off in BotFather. It is the single
    most common reason an agent in a group answers nothing, so `carbon-telegram
    probe` reports it.
13. **A chat cannot be opened by the bot.** A bot may only write to a chat
    somebody has written to it from, or a group it has been added to. So there is
    no path here that starts a conversation, and the chat ids in the declaration
    are ids of chats that already exist.

## What the declaration says

```json
{
  "kind": "telegram",
  "account": "<the bot's username>",
  "poll_interval_ms": 15000,
  "release": "immediate",
  "hold": { "on_operator_message": true, "release_after_ms": 3600000 },
  "max_attachment_bytes": 20971520,
  "transport": {
    "bot_token_ref": "<the name of a declared secret>",
    "allowed_chat_ids": [123456789],
    "operator_sender_ids": [987654321],
    "mode": "polling",
    "long_poll_timeout_s": 25
  }
}
```

`outbound_hosts` must carry `api.telegram.org` on port 443, which is what the box
owner builds the egress policy from and what HC-18 proves reachable. `carbon
declaration check` refuses a declaration that does not.

`poll_interval_ms` is how often the release loop drains what the long poll has
collected, not how often the server is asked; the long poll is already sitting at
the server. It is therefore what decides how long a message waits before the
agent looks at it. `mode` is `polling` and only `polling`: a webhook needs an
inbound port, and HC-19 says a box serves ssh to the network and nothing else.

## Running it by hand

```
carbon-telegram probe --token-file <file>
carbon-telegram send  --token-file <file> --chat <id> --text <text>
```

`probe` calls `getMe` and is the one call that answers "is this token the bot I
think it is" without sending anything to anybody. `send` puts one message in a
chat and prints the id the server accepted, which is what a proof compares
against. Neither writes to a store.

`proof.md` is what has been run for real.
