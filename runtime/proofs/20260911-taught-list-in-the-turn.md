# What a client taught in one turn, in front of the model on the next one

**Question.** A client teaches their agent something on their own channel. Does
the agent have it on the next turn of that unit, with nothing committed, nothing
installed and nothing in the checkout changed — and does a declaration that turns
teaching off leave the turn exactly as it was?

**Answer.** Yes to both, on the fixture channel, run on 11 September 2026.

## What was substituted, and what was real

No model runs in this repository's test seam, so the model's own judgment is the
one thing the fixture harness cannot produce. Everything the runtime does around
it is real:

1. The tool call is real. Turn one calls `remember` on a real `carbon-teach`
   server, served by `runtime/teach-tool.mjs` over loopback and spoken to over
   HTTP with a `tools/call` request, not through the store library.
2. The store is real, opened by `stream/store.mjs`, and the record is written by
   `stream/teachings.mjs` through the tool server's own handler.
3. The loop is the real `ReleaseLoop`: it captures the message, writes the
   release, composes the input, and resumes the unit's thread for turn two.
4. What is substituted is the model: `test/fake-harness.mjs` takes the turn,
   makes the tool call the model would make, and answers through the reply tool.
   The input it is given is the input a model would be given, recorded verbatim
   below.

The two cases are in `test/runtime.loop.test.mjs` as tests, so they stay true
rather than being true on one afternoon.

## Turn two, with `teaching.enabled` true

The whole input, as the runtime composed it:

```
Reply by calling the reply tool once, with conversation_id "account-1:c1" and request_id "release-account-1:c1:2-0". Nothing you write outside that tool call reaches anyone.
Your agent repository is at <scratch>/repo. It is read-only; its guidance and skills are already loaded, and anything else in it you read there by absolute path.

What ExampleCorp has taught you (1 standing instruction, most recent last).
These change how you use what you already have; none of them grants you anything new. Where one of them conflicts with your guidance, your guidance wins, say so, and call raise_change.
1. When a workbook lands here I will not change any records off it. (taught by Ada, 2026-09-11)

A message arrived on conversation account-1:c1.
from: Ada
received_at: 2026-09-11T10:02:00.000Z
conversation_id: account-1:c1
request_id: release-account-1:c1:2-0

What is the position on the two cases from yesterday?

Reply by calling the reply tool once, with conversation_id "account-1:c1" and request_id "release-account-1:c1:2-0". Nothing you write outside that tool call reaches anyone.
```

What turn one's `remember` call answered, over loopback:

```
{"id":"teach-20260911T082639Z-b7ce7ed8","active":1}
```

And what was on disk afterwards. The thread was resumed rather than opened again,
so this is the first turn after a resume; the record is in the store and the
checkout is byte-for-byte what it was committed as, with no install between the
two turns:

```
thread resumed before turn two: ["thread-1"]
records in store/teachings:     ["teach-20260911T082639Z-b7ce7ed8.json"]
git status --porcelain:         ""
find <checkout> -name '*teach*': ""
```

## Turn two, with `teaching.enabled` false

The same two turns against the same code, with the declaration's `teaching.enabled`
false: no block is rendered, and the harness lists no teaching server, because the
runtime starts none.

```
"has taught you" in either turn: false
mcpServerStatus/list:            ["carbon-reply"]
```

The input the model was given is the input it was given before any of this
existed: the reply instruction, the checkout line, the message, the reply
instruction.
