# A `kill -9` mid-turn, and the reply that arrived exactly once

**Question.** The process is killed in the middle of a turn, after the release was
written and before the model answered. It starts again. Does the client get one
correct reply, does the store show neither a gap nor a duplicate, and does the
restart take back the lock the dead process left?

**Answer.** Yes to all three, run for real against `codex-cli 0.153.4` on 10
September 2026, model `gpt-5.6-sol` at effort `low`. The re-issued release
produced one reply and one only; the message that arrived while the agent was
down was answered in the same pass; `carbon-stream check --store` passed; and the
lock left behind by the killed process was taken over by name and pid.

The run used a private `CODEX_HOME` under a scratchpad with only `auth.json`
copied in for the run and deleted after, and the fixture adapter, so no network
and no client was involved. Paths and identifiers below are the run's own,
redacted where they name this machine.

## What was run

Two invocations of the same command, the second after the first was killed:

```
node bin/carbon-runtime run \
  --declaration <agent dir>/current/carbon.agent.json \
  --store <agent dir>/store \
  --codex-home <private CODEX_HOME> \
  --checkout <agent dir>/work \
  --binary <codex 0.153.4> \
  --reply-port 8730 \
  --items <items file> \
  --passes 1 --no-provider-key
```

The first `--items` file held one message: "First run the shell command
`sleep 45`. Only after it finishes, reply with exactly one word: ONE." The second
held that message and a second one, "Reply with exactly one word: TWO.", which is
the message that arrived while the agent was down.

The `config.toml` the harness read was rendered by
`carbon-harness tools render`, plus two lines this machine needs and a box does
not: `[features] apps = false`, because a personal login injects a tool server
carbon did not declare and an API key does not, and the `carbon-reply` server
entry that install renders from the runtime's own constant.

## The kill

Twenty-two seconds in, with the turn running, the store already held the release
and no reply:

```
release before the kill: {"released_at":"2026-09-10T10:03:34.838Z",
  "thread_id":"01a08ac5-ce2a-7a43-b39a-d06621228c93",
  "turn_id":"release-proof-account:proof-1:m1-0"}
outbound records: 0
```

`kill -9` was sent to the runtime and to its app-server child, which is what a
unit's cgroup does for real; the runtime does not orphan its child, but a kill of
the parent alone would, so both were killed here.

## The restart

```
{"event":"lock.taken_over","channel":"fixture","account":"proof-account",
 "previous":{"pid":91178,"taken_at":"2026-09-10T10:03:34.081Z"}}
{"event":"recover","resend":[],"reissue":["proof-account:proof-1:m1"],"unknown":[],"done":[]}
{"event":"thread.opened","unit_id":"proof-account:proof-1","thread_id":"01a08ac6-3959-7030-84a9-430463847909"}
{"event":"release","message_id":"proof-account:proof-1:m1",
 "release_id":"release-proof-account:proof-1:m1-0",
 "thread_id":"01a08ac6-3959-7030-84a9-430463847909","reissue":true}
{"event":"release","message_id":"proof-account:proof-1:m2",
 "release_id":"release-proof-account:proof-1:m2-0",
 "thread_id":"01a08ac6-3959-7030-84a9-430463847909","reissue":false}
{"event":"deliver","request_id":"release-proof-account:proof-1:m1-0","status":"sent"}
{"event":"deliver","request_id":"release-proof-account:proof-1:m2-0","status":"sent"}
```

Four things in that sequence are the design working:

1. The lock was **taken over**, not obeyed. The file named a pid that is no
   longer a process running that command line.
2. The recovery read the **store**, not the harness's files: a release with no
   reply record is one to re-issue.
3. The re-issued turn carried the **same release id** as `clientUserMessageId`
   and as the `request_id` the model was told to reply under. The harness
   deduplicates nothing on that id, so the fence is the store's.
4. A **fresh thread** was opened rather than the killed one resumed, because the
   unit's thread record showed no completed turn and a thread that never took one
   has no rollout to resume.

## What the store holds afterwards

```
inbound  proof-account:proof-1:m1
  release  {"released_at":"2026-09-10T10:03:34.838Z","thread_id":"01a08ac5-…","turn_id":"release-…:m1-0",
            "completed_at":"2026-09-10T10:05:10.000Z"}
inbound  proof-account:proof-1:m2
  release  {"released_at":"2026-09-10T10:05:10.187Z","thread_id":"01a08ac6-…","turn_id":"release-…:m2-0",
            "completed_at":"2026-09-10T10:05:19.000Z"}
outbound proof-account:proof-1:reply-release-proof-account:proof-1:m1-0   body "ONE"
  delivery {"request_id":"release-…:m1-0","status":"sent","text_sha256":"2192e895…",
            "chunk_ids":["release-…:m1-0-chunk-0-2192e895"],"completed_at":"2026-09-10T10:05:19.941Z"}
outbound proof-account:proof-1:reply-release-proof-account:proof-1:m2-0   body "TWO"
  delivery {"request_id":"release-…:m2-0","status":"sent","text_sha256":"a1a8a8cb…",
            "chunk_ids":["release-…:m2-0-chunk-0-a1a8a8cb"],"completed_at":"2026-09-10T10:05:20.004Z"}
```

Two inbound records, two outbound records, four lines in the arrivals index, one
thread file naming two completed turns. One reply per release and no second one.
The `release.thread_id` on `m1` still names the thread the killed run opened,
which is the point of writing the release before the turn: the record says what
was asked and of whom, even when the process that asked it is gone.

```
node bin/carbon-stream check --store <agent dir>/store
case 11  pass  the set of records rebuilt from the files equals the set the index names
```

Exit 0: no record the index names is missing, and no record on disk is unnamed.

## Two things this run corrected in the code

1. **A turn's completion time is in seconds.** The protocol's `Turn.completedAt`
   is documented as "Unix timestamp (in seconds)" while everything else in the
   same record is milliseconds. Read as milliseconds it wrote 1970 onto the
   release. `runtime/loop.mjs`'s `when()` now converts once, and says why.
2. **A startup-status notification no longer stops the pass.** The first version
   broke out of the release loop when a tool server's status changed during a
   turn, which left the next message waiting for the following pass. It now reads
   the status again and stops only if a required server is actually down.

## What this run does not prove

1. Nothing here was a real channel. The fixture adapter's `send` invents chunk
   ids; the email and WhatsApp adapters have their own proofs.
2. The kill was of the process and its child by hand. On a box the unit's cgroup
   does that, and `systemctl show` against the template is increment 4's proof.
3. The machine authenticated with a personal login, so the run needed
   `[features] apps = false` to keep an undeclared tool server out. A box bills
   on an API key. The refusal that fires when an undeclared server is listed is
   covered by a test rather than by this run.
