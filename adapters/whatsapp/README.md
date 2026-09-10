# The WhatsApp adapter

WhatsApp through an unofficial library that pairs as a linked device, the way the
desktop application does. The official business API is not used and will not be.

The adapter declares `inbound` and `outbound`, and passes the sixteen of the
seventeen conformance cases that apply to those two capabilities:

```
node bin/carbon-stream check --adapter adapters/whatsapp --fixtures adapters/whatsapp/fixtures
```

## What is here

| file | what it is |
|---|---|
| `index.mjs` | the adapter: the five operations, and every rule about what a message becomes |
| `jid.mjs` | chat keys: the canonical form, and the map from the phone form to it |
| `content.mjs` | reading one message: the envelopes, the kinds, the edit, the album, the second upload |
| `channel-state.mjs` | the connection state, the chat-key map and the latch, as files under the store |
| `latch.mjs` | the terminal latch: what stops the unit when the device is unlinked |
| `auth-state.mjs` | the authentication state, written transactionally |
| `socket.mjs` | the only file that loads the library, and the only one that opens a connection |
| `fixtures/` | recorded events: what the conformance check runs, and what the tests read |
| `../../bin/carbon-whatsapp` | `pair`, run once by a person |

`index.mjs` imports no library and opens no connection, so every rule below is
tested against recorded events with no network in the test.

## The library, and the version

`@whiskeysockets/baileys`, pinned exactly at **7.0.0-rc14** in `package.json` and
in `package-lock.json`.

Why that one. It is the current release of the library: the `latest` tag, and the
newest of the whole line. The 6.x line is tagged `legacy` and predates the linked
id rollout, which this adapter's whole key rule is about — on 6.x there is no
second identifier on an event to be canonical about. Within the 7 line, rc14 is
what the previous release's investigation on this programme concluded: compatible
with the bridge it was compared against, carrying a client-version bump that
repairs a fresh-handshake failure the older release had, and not a fix for the
revocation that investigation was about. That last point is the one to keep hold
of: **no version of this library prevents the server from unlinking a device.**
That is what the terminal latch is for, and it is why the version is pinned and
bumped deliberately rather than floated.

## The terminal latch

The failure this exists for happened. The server answered `401`, meaning the
device is no longer linked; the process treated it as a crash; the unit restarted
it; it asked again, several times a second, for as long as nobody was looking.

So a terminal authentication state is not a crash. On `401` or `403` the adapter

1. writes the reason to `channels/<account>/whatsapp.latch.json` under the store,
2. records the connection as closed on the channel,
3. leaves the authentication directory exactly as it found it, byte for byte, and
4. exits **78**, which is the code the unit is configured not to restart on
   (`RestartPreventExitStatus=78`).

A latched channel refuses to start again, so restarting the unit by hand stops
again with the same reason rather than resuming the loop. The latch is cleared by
the next `carbon install`, which is the moment a person has decided what happened
and re-paired.

Everything else — the connection closed, the connection was replaced, a restart
was required, a timeout — is an ordinary reconnection and is not latched.

## The authentication state

Written transactionally from the first day: every file goes to a temporary name
in the same directory, is flushed, is renamed over the target, and the directory
is flushed after the rename. A reader sees the old file or the new one.

This **reduces the risk that a stop at the wrong moment leaves a state file half
written**. It does **not** prevent a server revocation, and nothing on the box
can. The library's own guidance says its bundled multi-file helper is not for
production, and an upstream change proposing atomic credential writes was closed
without landing, which is why this is written here.

## Pairing

Once, by a person, by hand:

```
node bin/carbon-whatsapp pair --auth-dir <dir> --phone 15550000000
```

It asks the server for a pairing code and prints it; the person types that code
into the phone under linked devices. The directory is then a credential the box
owner owns, and nothing but the adapter reads it. A directory that already holds
a paired device is refused, so a second run cannot orphan a working pairing.

**This has not been run against a real number.** Everything else in this adapter
is proved by the conformance check and the tests; the pairing round trip is
proved the first time a person runs it with a test number.

---

# The edge-case checklist, signed

The list is the one the earlier platform's findings recorded after eight months
of running this channel in production. Every item is signed here: what this
adapter does about it, or why it does not apply.

## What it hit

**1. A uniform message id, `<chat>:<message>`, across every platform.**
Taken, and it is the store contract, not this adapter's choice: `message_id` is
`<conversation_id>:<platform_message_id>`, where `conversation_id` is the
canonical chat key namespaced by the account. So the identity of a message here
is the canonical chat key and the event's own id, and it is the dedup key
everywhere. Case 1 proves the same event twice writes one record.

**2. Slack message ids must use `ts`, not the client-generated id.**
Not applicable: a different channel. The rule behind it — key on the identifier
the server assigned, never on one the sending client chose — is honoured:
`key.id` is the server's.

**3. Telegram chat ids must be namespaced by bot.**
Applied in the form that matters here: every `conversation_id` is namespaced by
the account, so two agents on two numbers cannot collide on one chat key, and the
store's own rule that a reply goes out on the account the inbound arrived on has
something to compare.

**4. Multi-device: the chat key is `remoteJidAlt || remoteJid`, and the handler
and the channel disagreed about which to use, so one chat could be keyed two
ways.**
This is the item the plan singles out, and the answer is not the one the earlier
platform used. **The canonical chat key is the linked-id form** wherever the
event offers one, in whichever field it arrived, and the phone form otherwise;
groups and broadcasts keep their own jid, having no linked-id form. One rule, one
function, `jid.mjs`, used by the adapter and by the import, so nothing can
disagree with anything else. The device suffix a jid may carry is dropped. The
phone form is not discarded: every event carrying both forms teaches a map under
the store, which exists for one caller, the history import.

**5. Higher-definition image variants arrive as a second child message and are
skipped, or every photograph doubles.**
Skipped, by both shapes the protocol uses: a message whose only content is the
`associatedChildMessage` envelope, and a message whose association type is the
higher-definition image or video child. The parent, which carries the picture and
the pointer to its larger version, is the one recorded, and it carries
`hd_variant_skipped` so a reader knows a larger version existed.

**6. Albums arrive as several messages and are regrouped by the parent key.**
Regrouped by the album's parent message id, read from the protocol's own message
association. And more than regrouped: an album **settles**. `listPending` holds
every member back until the album has been quiet for the declared window
(`album_quiet_ms`, two seconds without a declaration), then releases the whole set
at once, so six photographs are one arrival and not six turns. Each record carries
`album_id` and `album_index`.

**7. Batching: a two-second debounce keyed on chat, whose timers were in process,
so a restart mid-window lost the batch.**
Half applied, deliberately. The album window above is the part that is this
adapter's business, and it is not held in a timer: pendingness is recomputed from
the items and the cursors on every pass, so a restart mid-window loses nothing —
the album is simply still unsettled next time. General release batching across a
burst of unrelated messages is not this adapter's decision at all: it is the
declaration's `release` policy, which the runtime applies, and it is deliberately
not reimplemented per channel.

**8. Pacing: per-channel conversational config merged from three levels.**
Not applied, and not planned. Typing delays and per-character pacing are a
product decision nobody has asked for here. What is applied is the part with a
consequence: a reply longer than the channel accepts is split at
`max_message_chars` (4096 without a declaration), and **every chunk id is written
back** to the outbound record, which case 8 proves. That is the piece that makes
a contact's reply to any one chunk resolvable to the one reply that produced it.

**9. The operator's own messages are ingested as an operator role, and any such
message blocks the agent, released after a day.**
Applied. A `fromMe` message is `role: operator` and writes a hold on the record,
with `release_after_ms` from the declaration and a day without one. The store
refuses to release a held conversation, which case 10 proves.
One thing the earlier platform did not have to solve, because it sent through a
third-party service: the agent's own reply comes back down this socket as a
`fromMe` message too. Recording that as an operator message would make the agent
hold itself every time it answered. So an event whose id is one of the chunk ids
a delivery wrote back, or whose text is the text of an outbound record on that
conversation, is the agent's own send and is not captured again. The residual gap
is the moment between the send and the chunk ids landing, where a split reply's
echo can still be read as an operator: the effect is a hold that expires, not a
lost message, and the ids are written immediately after the send.

**10. Formatting normalised centrally, converted per platform.**
Not applied. There is no normalised markup here: the agent writes what it writes
and the adapter sends it. A markup layer is a thing to add when a client's
messages need it, and inventing one before then is how a formatter becomes
something nobody may change.

**11. Connection state is a first-class channel field, persisted, and alerted on
disconnect.**
Applied as the field: `channels/<account>/whatsapp.channel.json` holds
`open | close | connecting | unknown` with the moment and the reason, written on
every connection update, so a check from outside the box can tell a channel that
is connected from a process that is merely running. The alerting is not here: who
is told, and how, belongs to the observation machinery, and a channel that
alerted on its own would be the second monitoring system.

**12. Channel teardown as a queued job holding a config snapshot.**
Not applicable. There is one agent per box and one channel per agent, and taking
a channel down is uninstalling the agent, which is the private half's work.
Nothing here deletes a channel, and nothing here deletes a record.

## What it did not handle, and knew

**Message edits: dropped, because dedup saw the same id.**
Handled. An edit arrives as a protocol message of type 14 naming the message it
replaces; it is written as a **revision** file beside the original, never over it,
which case 2 proves. Its position is the position of the message it replaces, so
it sits below the message cursor by design, and case 17 proves it still releases.
Because a revision cursor alone cannot tell whether an edit of an older message is
new, an edit already written is recognised by its own event id.

**Revokes: ignored entirely.**
Recorded, not obeyed. A revoke is captured as a record naming the message it
revokes. Nothing is deleted: this store has no delete path, and a client asking
later what was said gets the answer, including that the sender withdrew it.

**Mentions and bot-mention filtering: nothing existed.**
Not this adapter's decision. `release: mention` is a declaration policy the
runtime applies to the stream; the adapter's job is to capture everything that
arrives, which is what it does.

**Group versus direct in the live path: groups collapsed every participant onto
the group jid, so all senders looked identical.**
Handled. `conversation_kind` is `group` for a group chat, and `sender_id` is the
participant, canonicalised by the same linked-id rule as the chat. The group is
the conversation; the participant is who spoke.

**Rate limits and 429 handling: absent.**
Not handled here, and named as not handled. This library talks the device
protocol rather than an HTTP API, so there is no 429 to read; what there is
instead is the server closing a connection, which is recorded as an ordinary
disconnect and reconnected. If sending volume ever earns a limiter it belongs in
the runtime's release loop, above this adapter, not per channel.

**Read receipts: absent.**
Not applied. Marking a client's messages read from a linked device changes what
the client sees on their own phone, and nobody has asked for that.

**Outbound length caps: splitting happened only where the agent wrote a
delimiter, so an over-long message failed at the API.**
Handled, and it is item 8 above: the split is on length at a declared maximum, at
a paragraph, then a sentence, then a word boundary, and every chunk id comes back.

**A hardcoded timezone in the prompt builder.**
Not applicable: this adapter builds no prompt. Times are recorded as they arrived,
as instants.

## Two more, from this programme rather than that list

**An uncertain send.** A send whose acceptance the channel did not confirm lands
`unknown` and is never retried; only a send the channel plainly refused before
anything went out is `failed`, which may be retried. Doubt resolves to `unknown`,
because claiming a send failed when nobody knows is how a contact gets the same
message twice. Once one chunk of a split reply has gone out, nothing about the
rest is known, so the whole send is `unknown`.

**A hostile identifier.** Every identifier on this channel — a chat key, an event
id, a key name in the authentication directory — is chosen by somebody else. None
of them reaches the filesystem as it was written: the store refuses and encodes,
which case 16 proves, and the authentication state has its own refusal for the
key names the server chooses.
