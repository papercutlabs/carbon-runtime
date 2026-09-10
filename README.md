# carbon-runtime

This is the part of Carbon that runs on a box. An agent's box holds three
renderings and nothing else: the agent repository's commit, its rendered config,
and this runtime as a pinned, checksummed tarball. So what is here is only what
is meant to go around — the process a systemd unit starts, the store library,
the channel adapters and the reply tool — and it is public.

The one contract in this repository is the stream contract: **every adapter
writes one record shape into one store**. An email arriving, a chat message, a
history import, a nightly timer and the agent's own reply are the same record
with a different `source`. Nothing downstream knows the channel except as a
field. An adapter is a thing that passes its subset of seventeen conformance
cases, and `bin/carbon-stream check` is what says whether it does.

## What this is not

1. **Not the schema authority.** `schema/carbon.message.v1.json` is a vendored
   copy. The authority is a separate, private repository, and the copy here must
   stay byte-identical to it; `test/schema.test.mjs` compares the two when
   `CARBON_SCHEMA_AUTHORITY` points at a checkout of the authority, and says it
   skipped when nothing does.
2. **No install, and no doctor.** Putting an agent on a box, checking a box
   against its contract, and the receipt that says what was installed are the
   private half's work, run from outside the box.
3. **No skills, no references, no wisdom.** The machinery that produces
   opinionated agent scaffolding never lands on a client box. Only its output
   does.
4. **Nothing that takes a client's records away.** There is no path here that
   deletes, expires or ages out a record, and the workflow fails the build if one
   appears. A client agent keeps what arrived.

## Layout

| path | what it is |
|---|---|
| `runtime/` | the process a unit starts: the release loop, the reply tool, the tool-server launcher, the adapter registry, the per-adapter lock and the terminal latch |
| `bin/carbon-runtime` | `run --agent-dir <dir>` on a box; every path explicit off one |
| `harness/codex/` | a copy of the Codex harness the runtime spawns and drives; `harness/HARNESS-SOURCE` says where it came from and that nothing here edits it |
| `lib/faults.mjs`, `tools/lib/` | the fault shape and the MCP server scaffold, copied under the same rule |
| `schema/carbon.message.v1.json` | the vendored record shape; one JSON file per record |
| `stream/` | the store library: path derivation and containment, the write order, the two cursors, the merge, the arrivals index, the outbound records and the reply fence |
| `stream/adapter.md` | the adapter contract: the three capabilities, the five operations, the optional poll, the fixtures an adapter ships |
| `adapters/fixture/` | an adapter with no channel, so the conformance check has something to run |
| `adapters/email/` | the email adapter: IMAP and SMTP through `curl`, a MIME reader of ours, threading by `References`; its own README is the contract |
| `adapters/whatsapp/` | the WhatsApp adapter: chat keys, the hold, the terminal latch, the transactional authentication state |
| `import/` | the history import: a zip reader with no dependency, and the map from an export's rows to records |
| `conformance/cases.mjs` | the seventeen cases, by number and name |
| `bin/carbon-stream` | `check --adapter <path> --fixtures <dir>`, and `check --store <dir>` |
| `bin/carbon-email` | `smoke`, the live check of the email adapter against a real mailbox, run by hand |
| `bin/carbon-whatsapp` | `pair --auth-dir <dir> --phone <number>`, run once by a person; `send --auth-dir <dir> --to <number> --text <text>`, which drives a second paired device in a proof and records nothing |
| `bin/carbon-import` | `whatsapp --agent <id> --export <zip> --store <dir>` |
| `test/` | `node --test "test/*.test.mjs"` |
| `tools/` | the MCP scaffold the reply tool is served by, the identifier scan and the release build |

## The store

Under an agent's own directory, created 0700:

```
captures/<conversation>/<message>[.<revision>].json   the record
captures/<conversation>/<message>[.<revision>].raw    the payload as it arrived
captures/<conversation>/<message>[.<revision>].attachments/<sha256>
index.jsonl        one line per record first seen, appended and fsynced
cursors/<conversation>.json    the two capture cursors
threads/<unit-id>.json         one file per unit of work
outbound/requests/<request-id>.json    the reply fence
```

Six rules hold it together.

1. **Every path component is encoded**, and an identifier shaped like an escape
   is refused before anything is written. A sender chooses their own message id
   and a zip entry names its own file, so neither reaches the filesystem as it
   was written. The encoding is reversible; where an identifier is too long to
   encode it is hashed, and the record still carries the raw id.
2. **Every write is temp, fsync, rename, fsync the directory.** A record is
   whole or it is not there.
3. **The write order is the contract**: the raw payload appended and fsynced,
   the record written, the disposition written, the capture cursor advanced. A
   record write that throws still advances the cursor, so a payload nothing can
   parse is not read forever, and the raw file it left is the recovery record.
4. **Two cursors per conversation**, one over messages and one over their
   revisions, because a contact's correction of an old message sits below the
   message cursor and must still be captured and released.
5. **A repeated write merges rather than clobbers**: the first body and the
   first times win, attachments are a union by sha256. Re-running an import
   changes no capture bytes.
6. **A send is fenced by its request id.** The outbound record exists as
   `pending` before any transport is called. A second reply under a request id
   already `sent` gets the stored chunk ids back and sends nothing; one already
   `pending` is refused; one whose acceptance is `unknown` is never retried,
   because an uncertain send is a person's decision.

## The one process

A box runs one unit per agent and the unit starts one process:

```
carbon-runtime run --agent-dir /srv/carbon/<agent id>
```

It reads the declaration install rendered, spawns the pinned harness as its
direct child and exits non-zero if that child exits, so the unit restarts the
pair together. It starts the tool servers that hold secrets as the tools user,
with an environment built from empty. It hosts the adapters in this process,
takes one lock per adapter and takes over a lock whose holder is not alive. It
serves the `reply` tool on loopback. Then, on every pass: poll the channel,
recover what the last run owed, capture what is pending past the cursors, release
what the channel's policy allows, and deliver what the model replied.

Seven rules are worth stating on their own.

1. **The release is written on the record before the turn starts.** A restart
   reads the store, not the harness's files: a release with a sent reply is
   done, a release with a pending reply needs the send, a release with no reply
   is re-issued, and an unknown one is left for a person.
2. **The request id is the only fence.** The harness does not deduplicate on the
   id a turn carries, so the runtime tells the model which `request_id` to use,
   that id is the release id and is the same on a re-issue, and the store
   answers a repeat rather than sending twice.
3. **A completed turn is not an answered message.** The reply tool is the one
   door out of a turn, and a model that writes its answer into its own message
   has delivered nothing. So the instruction is the first line and the last line
   of the turn text, and when a turn completes with no outbound record for its
   release the runtime takes exactly one follow-up turn on the same thread: call
   the tool now, or answer exactly `NO_REPLY`. `NO_REPLY` closes the release with
   that reason on the record. Anything else parks the record with reason
   `no-reply`, and what the model said is kept on the thread record so a person
   can read why it thought it had answered.
4. **A required tool server that is down holds release, by name.** The status is
   read after the unit's thread is open, because that is the only way the
   harness reports it, and a startup notification re-raises the hold. A server
   the harness lists that no declaration names refuses the start outright.
5. **A channel is polled on its own interval, and a channel that cannot be read
   holds.** An adapter that has to go and look exports `poll`; the interval is
   the declaration's and is refused at start if it is below the adapter's floor,
   because a mailbox polled too fast earns a lockout that lasts a day. A poll
   that fails is a named fault in the log and a field on
   `channels/<account>/<kind>.channel.json`, never the end of the process; past
   the channel's `poll_failures_before_hold` the channel holds, does no capture,
   no release and no delivery, and a check from outside the box reads the hold
   off that file.
6. **A record the runtime cannot release is parked, not fatal.** A message with
   no unit id, or anything else raised while one record is being released, is
   written on that record as a fault, the record's disposition becomes `parked`,
   and the loop takes the next one. Exiting instead would put the unit in a
   restart loop that meets the same record every time and reaches the start
   limit; a check from outside the box reads the parked list. Four endings still
   end the process: the harness child exiting, the latch, the lock, and an
   app-server listing a tool server no declaration names.
7. **A latch is a stop, not a note.** `channels/<account>/<kind>.latch.json`
   stops the process with exit code 78, which the unit does not restart on, and
   only the next install clears it.

`runtime/proofs/` holds what has been run for real against the pinned harness.

## Running the check

```
node bin/carbon-stream check --adapter adapters/fixture --fixtures adapters/fixture/fixtures
node bin/carbon-stream check --adapter adapters/whatsapp --fixtures adapters/whatsapp/fixtures
node bin/carbon-stream check --adapter import/carbon-capture-whatsapp --fixtures import/fixtures
node bin/carbon-stream check --store /path/to/an/agent/store
node bin/carbon-stream check --help
```

Every command takes each argument explicitly with no default that guesses, every
fault is one JSON line of `{code, subject, problem, fix}` with all faults from
one run reported together, and any fault exits non-zero.

## Releases

A box installs a pinned tarball, verified by its sha256, never a clone.
`npm run release` builds `carbon-runtime-<version>.tar.gz` and its `.sha256`
from a clean checkout, holding what runs on a box and nothing else: no tests, no
workflow, no tools. It publishes nothing.

## The one dependency

Node 22, ES modules, and exactly one dependency: `@whiskeysockets/baileys`,
pinned to an exact version in `package.json` and `package-lock.json`, because
WhatsApp has no other way in that this programme will use. Nothing else here
loads it — the store library, the conformance check and the import have none —
and the workflow fails if a second dependency appears or the pin grows a range.
Why that version, and what it does not fix, is in `adapters/whatsapp/README.md`.
