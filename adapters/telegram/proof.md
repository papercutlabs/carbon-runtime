# The first live Telegram message, answered and delivered

**Question.** A person writes to a bot an agent is configured with. Does the
runtime capture it, release it, take a turn on it and put the reply back in that
chat, with the store saying so? Does a photograph arrive as bytes on disk at its
digest? Does a message from a declared operator hold the agent?

**Answer.** Yes, run for real on 11 September 2026 from a workstation, against
`codex-cli 0.153.4`, model `gpt-5.6-sol` at effort `low`. A test bot was created
for this and is used for nothing else; its token was placed in a directory
outside every repository, mode 0700 with the file at 0600, and it is not in this
file. The run found one defect, findable only by running it, and it is fixed in
this release.

## What was run

The runtime off a box, every path passed explicitly:

```
node bin/carbon-runtime run \
  --declaration <scratch>/carbon.agent.json \
  --store <scratch>/store \
  --codex-home <scratch CODEX_HOME> \
  --checkout <scratch repository> \
  --work <scratch>/work \
  --binary <codex 0.153.4> \
  --reply-port 8730 \
  --passes 3
```

The declaration was an invented agent's, with one `telegram` channel, `release:
immediate`, `poll_interval_ms` 15000, `long_poll_timeout_s` 10, one chat in
`allowed_chat_ids`, and `transport.bot_token_ref` naming a secret whose path is
the token file. It declared no tool servers: they live on a box at paths this
machine does not have, and a declared server the harness does not list ends the
process by design. `config.toml` was rendered by the private repository's own
renderer with the tool servers dropped and the work directory trusted, and an
`auth.json` was copied into a scratch `CODEX_HOME` for the run.

The messages were sent from a person's own Telegram account with the
organisation's user CLI. The bot's own transport was exercised separately with
`carbon-telegram probe`, which called `getMe` and reported the bot the token
belongs to, its name, and that privacy mode was on — the setting that decides
whether a bot in a group sees anything but the messages naming it.

## What the store says

| fact | value |
|---|---|
| conversation | the account, then the chat id: `<bot username>:<chat id>` |
| inbound `message_id` | `<conversation>:<the chat-local message id>` |
| role | `contact`, `historical: false`, `disposition: captured` |
| releases | three, one turn each, all `completed` |
| turns per release | exactly one; no follow-up was needed, the model called the reply tool inside its first turn |
| outbound | three records, each `status: sent`, each one chunk id |
| token usage, third turn | input 114,447, of which 94,848 cached; output 707; reasoning 151 |
| the update offset | `0000000125968202` on the account's own cursor after the first two, advanced only by `consume` |
| `carbon-stream check --store` | case 11 passes: the records on disk are the records the index names |

**The chunk id is the message's position in the chat.** Telegram numbers a
private chat's messages in one sequence shared by both sides, and the run's
sequence interleaves:

| message id | who | what |
|---|---|---|
| 1 | the contact | the first message |
| 2 | the contact | the question |
| 3 | the agent | the reply, written back as the chunk id of release 1 |
| 4 | the agent | the reply, written back as the chunk id of release 2 |
| 5 | the contact | the photograph |
| 6 | the agent | the reply, written back as the chunk id of release 5 |

The contact's next message being 5 is the proof that 3 and 4 are messages in that
chat and not numbers this box invented: the chat counted them.

## The photograph

Sent as an ordinary picture, which arrives as a list of sizes of one image. The
adapter took the largest, called `getFile` for it and downloaded the bytes.

| fact | value |
|---|---|
| record | one, `attachments` of length 1, released and answered |
| body | the caption, which is where the words of a message with a file on it are |
| file on disk | named by its sha256 under the capture's own attachments directory |
| bytes | 1,109, mode 0600, no execute bit |
| digest | `sha256sum` of the file equals the `sha256` on the record |
| name | the server's `file_unique_id` with a `.jpg` suffix, kept on the record as `filename` |

## The operator hold

The declaration was changed to name the sender in `operator_sender_ids` and the
runtime was run again. The message that arrived next was recorded:

```
role          operator
hold.reason   an operator this channel names wrote in this chat
hold.set_at   the moment the message was sent
hold          release_after_ms 3600000, which is the declaration's
release        (absent)
```

No turn was taken. Read back off the live store, `isHeld` on that conversation is
`true` now and `false` one hour and one millisecond after `set_at`, which is the
window the declaration asked for and not a window this adapter chose.

One half of the hold is not proved live here and is proved by conformance case 10
instead: that a *contact's* message in a held conversation does not release. It
needs two people in one chat, and this run had one person and one bot. Telegram
gives a bot no messages from another bot, so a second bot cannot stand in for the
second person; a group with two human accounts is what would close it, and that
is the shape to use when there is a second account to hand.

## The defect

**The process would not exit.** The long poll is a task that outlives a pass, and
a task with no end keeps Node's event loop alive, so a run that had done its work
and returned sat there until it was killed. On a box that is invisible, because
the unit runs until systemd stops it; off one it is a command that never comes
back, which is how it was found — the first run of this proof had to be killed by
hand.

The fix is a seventh, optional operation in the adapter contract: `stop`. An
adapter that keeps something running between passes has an ending, the runtime
calls it when it stops, and an adapter whose work is entirely inside its five
operations exports none of it. The second run of this proof exited 0 on its own.
`stream/adapter.md` carries it.

## What this run did not touch

No client's bot, no client's chat, no client's store. The bot was created for
this proof with the organisation's own account and is used for nothing else. The
token is in a directory outside every repository and is in no file here.
