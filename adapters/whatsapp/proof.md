# The first live WhatsApp message, answered and delivered

**Question.** A person's phone sends a message to the number an agent is paired
to. Does the runtime capture it, release it, take a turn on it and put the reply
back in that chat, on the same connection, with the store saying so?

**Answer.** Yes, run for real on 10 September 2026 from a workstation, against
`codex-cli 0.153.4`, model `gpt-5.6-sol` at effort `low`, with a real client
agent's own declaration and checkout. Two phones were used, both a person's own: one the
agent is paired to, one a tester device that a proof can drive. Numbers are not
recorded here. The run found three defects, all of them only findable by running
it, and all three are fixed in this release.

## What was run

The runtime off a box, every path passed explicitly:

```
node bin/carbon-runtime run \
  --declaration <scratch>/carbon.agent.json \
  --store <scratch>/store \
  --codex-home <private CODEX_HOME> \
  --checkout <the client repository> \
  --binary <codex 0.153.4> \
  --reply-port 8730
```

The declaration was the client's own with one `whatsapp` channel in place of the
mail one, `release: immediate`, a hold on an operator message, and
`transport.auth_dir` naming the paired directory. Its tool servers were dropped:
they live on a box at paths this machine does not have, and a declared server the
harness does not list ends the process by design. `config.toml` was rendered by
the private repository's own renderer with the tool servers dropped and the
checkout trusted, and `auth.json` was copied into a private `CODEX_HOME` for the
run and deleted after.

The tester device sent `Hello, what do you do?` with `carbon-whatsapp send`.

## What the store says

| fact | value |
|---|---|
| conversation | the account, then the sender's linked-id form: `<account>:<nnn>@lid` |
| inbound `message_id` | `<conversation>:<the server's own id>`, a 22-character hex id |
| role | `contact`, `historical: false`, `disposition: captured` |
| release | one release, one turn, `completed` |
| turns for that release | exactly one; no follow-up turn was needed, the model called the reply tool inside its first turn |
| outbound | one record, `status: sent`, one chunk id |
| token usage | input 29,961, of which 28,800 cached; output 185; reasoning 17 |
| the chunk id | the same id the receiving device saw on the incoming message |

The last line is the proof that the reply left the box: the id the store wrote
back after the send is the id the other phone received.

The chat key is the linked-id form on both sides, which is what the adapter's key
rule is for: the agent keyed the tester by the tester's `@lid`, and the tester's
own device saw the reply arriving from the agent's `@lid`, with the phone form as
the alternative field on the same key.

## The three defects

1. **The reply was written down as failed and never sent.** The release loop
   called the adapter's `send` without awaiting it, read `status` off a promise,
   found nothing, and marked the send failed. The store said the turn was
   answered and the contact had nothing. `deliver` is async now and awaits the
   send, which is what `stream/adapter.md` always said the runtime does.
2. **Every message after a restart was polled forever and never captured.** The
   arrival position was a counter that started at one in each process, so after a
   restart every new message sat below the cursor the previous run had left. The
   position is now the server's own timestamp for the event with a counter after
   it, which is the same number after a restart. One message was lost to this
   during the run, and it is the only message this run lost.
3. **The runtime could not host this adapter at all.** There was no `poll`, no
   connection for a send to go out on, and no path from the declaration to the
   authentication directory: an installed agent with a whatsapp channel opened no
   socket and answered nothing. `live.mjs` is that missing middle.

A fourth thing was learned rather than fixed: the tester device was unlinked by
the server after a run that connected, sent and ended the process in the same
second. `send` now holds the connection for a moment and closes it properly. The
device that stayed connected throughout, the agent's own, was never unlinked.
