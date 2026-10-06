# runtime

The process a systemd unit starts: the release loop, the reply tool, the teaching tools, the tool-server launcher, the adapter registry, the per-adapter lock and the terminal latch.

An email channel's persisted poll block carries `inbound_transport`. The value
is `imap` for the compatible default or the declaration's explicit inbound
transport. Doctor and install use that provenance to distinguish current poll
evidence from state left by a transport the declaration no longer uses.

Ordinary browser chat uses `createBrowserThreadOptions` from `browser-policy.ts`.
The owning launcher supplies real `work`, declared agent-package `checkout`,
explicit readable roots and every private authority root (Store, model home,
runtime grant/config, source credentials/work and database socket directories).
The optional `sourceConfig({conversationId,workspace})` supplies immutable
per-thread MCP URLs; it cannot override permissions. The profile denies other
browser workspaces, reads current evidence, writes current analysis/output and
protects copied guidance. Actual stock-native read-denial qualification is still
required on the installed binary/platform.

`run` takes that callback as `browserThreadOptions`, fresh source reads as
`prepareBrowserTurn` and the canonical owning response validator as
`validateBrowserReply`. The same validator is mandatory at reply acceptance;
Carbon owns no client response schema. `reply` accepts ordinary `text`, optional
`metadata` and output file paths. Metadata cannot supply `text` or attachments.
Rejected replies/files never acquire the accepted final-response fence.

A unit's actual working directory is its hashed `work/browser-tickets/<id>/analysis`,
with read-only `evidence` and writable `output` siblings. The runtime copies
`AGENTS.md` and `.agents` from the declared agent-package checkout into analysis
using `placeGuidance`; it does not load engagement repository instructions.
Current ticket, comment coverage, attributed shared history and actual file paths
are explicit turn input. Source preparation failures retain structural evidence
and do not start a model turn.

The public harness retains stdio by default. An owning client may select its
loopback `privateEndpoint` and `attachPrivateEndpoint` lifecycle through
`harness/codex/index.ts` connect. The hook returns `close` and optional `failed`;
connection refusal, child exit and stop close owned access once. Account custody
is supplied by that client, never by Carbon or a copied default model home.
Rendered installed configuration already disables implicit connected apps with
`[features] apps = false`; temporary launchers must preserve that setting and
check the native listed tool servers before useful work.
