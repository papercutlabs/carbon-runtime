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
| `schema/carbon.message.v1.json` | the vendored record shape; one JSON file per record |
| `stream/` | the store library: path derivation and containment, the write order, the two cursors, the merge, the arrivals index, the outbound records and the reply fence |
| `stream/adapter.md` | the adapter contract: the three capabilities, the five operations, the fixtures an adapter ships |
| `adapters/fixture/` | an adapter with no channel, so the conformance check has something to run |
| `adapters/whatsapp/` | the WhatsApp adapter: chat keys, the hold, the terminal latch, the transactional authentication state |
| `import/` | the history import: a zip reader with no dependency, and the map from an export's rows to records |
| `conformance/cases.mjs` | the seventeen cases, by number and name |
| `bin/carbon-stream` | `check --adapter <path> --fixtures <dir>`, and `check --store <dir>` |
| `bin/carbon-whatsapp` | `pair --auth-dir <dir> --phone <number>`, run once by a person |
| `bin/carbon-import` | `whatsapp --agent <id> --export <zip> --store <dir>` |
| `test/` | `node --test "test/*.test.mjs"` |
| `tools/` | the identifier scan and the release build |

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
