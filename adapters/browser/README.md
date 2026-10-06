# Browser ticket conversations

A trusted companion server authenticates each consultant and supplies a
`browserPacket` after its ticket grant check. The browser does not own the sender,
account, ticket mapping, acceptance time or cursor. Canonical conversation identity
is `browserConversationId(account,ticketKey)`. One conversation is one Carbon unit.
Declare the channel as `browser`, its default room as `ops`, and the unit as
`conversation`. This lets consultants act as operators without a customer takeover
hold. Model records and teaching stay disabled. The read-only model policy and
closed network require browser-qualified host read-denials before client use.

`runtime/browser.ts` exports `createBrowserBridge({store,agent,account,authorize})`.
Its trusted synchronous authorizer checks the current ticket grant for every
submit/read/watch/operator operation. `submit(grant,packet)` returns the actual
Carbon record and duplicate disposition. Exact body, attributed sender and request
kind remain fixed for an accepted submission ID; a changed retry is refused.
`read(grant,ticketKey,{after,limit})` returns actual Carbon records with monotonic
cursors covering captures and durable state changes. A returned row's event is
capture or state; state updates retain the same message ID. Consumers merge that
identity and project changed submission state without inserting a second message. `watch` adds a bounded filesystem event wait, abort cleanup and
fresh grant check. `operatorRead` separately scopes thread, release and uncertainty
evidence. HTTP, CLI and MCP operations using this library must use the typed route
package at their external boundary. Do not put a second conversation table beside
these records.

Browser paging keeps a derived scalar cursor projection in memory for the actual
single-writer Store. A new Store or restart reads the existing global index once,
then reconstructs state cursors from the requested ticket's captures once. Durable
capture/state notifications update that projection; warm pages reread only their
requested full records. The projection contains no bodies and writes no files.
Cold reconstruction still scales with retained index and ticket history and must
be measured against the installed client's capacity. External writers or replacing
files underneath a live Store are unsupported; restore creates a fresh Store.

The bridge and runtime share one actual `Store` instance in one process. Pass it
as `run({store,storeDir,...})` or to the supported `ReleaseLoop`. Separate writer
processes are unsupported. New browser inbound captures notify the shared Store
and wake the runtime drain. The browser channel never schedules an empty periodic
poll; other channel schedules remain unchanged. Watchers cover reply/release/effect
record changes and close on timeout, abort or stop. Browser send releases the fenced stored reply to the
authenticated read surface; it performs no client-system send or mutation.

Bind `prepareBrowserTurn` to the granted source reader. On each actual turn start
it reads the ticket afresh. Carbon adds all retained messages of that conversation,
request kinds, authenticated sender and exact unit/submission/release identities to
the turn input. This includes repair turns and resumed/compacted threads. It never
creates visible context messages. The explicit envelope cap is 4 MiB; overflow is
refused without dropping history. This cap is a structural bound, not proof that a
particular model accepts the context; installed account/model capacity must be
qualified separately.

After potentially accepted model dispatch, absent reply is an uncertain effect.
Browser recovery never blindly starts another turn for that release or ticket.
It retains dispatch/native acceptance evidence, inspects supported thread/read on
the existing session where available, and exposes uncertainty to operator reads.
A native completed turn alone does not produce a consultant response. Settlement
requires the existing durable reply or an explicitly qualified supported recovery
path. No provider-execution-once claim follows from submission or reply fencing.

The local integration test uses the actual store, release loop, reply handler and
browser reads with a labelled scripted harness. It proves those component handoffs
and bad-case refusals. Actual Linux shell/SQL isolation, account authority, native
model consumption through compaction and acceptance-before-crash remain installed
host proofs. Do not label fixture evidence as those proofs.
