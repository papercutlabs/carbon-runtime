# What an adapter is

An adapter is anything that writes records into an agent's store: a mailbox, a
chat session, a poller against a ticket system, a nightly timer, a form, an
operator's note, a one-off import of a history export. Nothing downstream knows
the channel except as a field on the record.

An adapter is a thing that passes its subset of the seventeen conformance cases.
`bin/carbon-stream check --adapter <path> --fixtures <dir>` runs them.

## What an adapter declares

An adapter is one ES module. It exports `capabilities`, a list holding any
combination of:

| capability | what it means |
|---|---|
| `inbound` | it produces records that arrive from outside and may release a turn |
| `outbound` | it sends what the agent replies and writes the outcome back |
| `import` | it produces historical records from an export; these release nothing |

The check runs only the cases that apply to what the adapter declared. A source
that only produces, such as a nightly timer, declares `inbound`, passes the
inbound cases and is never asked about replies.

## The five operations

Every adapter implements the operations its capabilities need, and no more.

```js
export const capabilities = ['inbound', 'outbound'];

// 1. List what is pending past the cursors.
//    The store keeps two capture cursors per conversation, one over messages and
//    one over their revisions. An adapter reads them with
//    context.store.cursors(conversation_id) and returns only what sits past
//    them. A correction to an old message sits below the message cursor and
//    above the revision cursor, and must be returned.
export function listPending(context) { /* -> [item] */ }

// 2. Consume one item, after the runtime accepted it.
//    This is the only place a cursor moves. An adapter advances the message
//    cursor for a message and the revision cursor for a revision, with
//    context.store.advanceCursor(conversation_id, kind, position).
export function consume(context, item) { }

// 3. Turn a batch into the payload the store writes.
//    Returns { entries, parked }. An entry is
//      { record, raw, cursor: { kind, position }, attachments }
//    where record is a carbon.message.v1 record, raw is the payload exactly as
//    the channel gave it, and attachments is a list of
//      { bytes, mime } or { file, sha256, mime, download_failed: true }.
//    An item the adapter cannot understand goes in parked, as
//      { record, raw, cursor, reason }
//    with the smallest record that still names the conversation and the message.
//    A parked item is kept where it landed and never delivered.
export function payload(context, items) { /* -> { entries, parked } */ }

// 4. Say whether an item is the one a delivery record names.
//    Used after a restart, to tell a reply that reached the channel from one
//    that did not.
export function matchesDelivery(context, item, delivery) { /* -> boolean */ }

// 5. Send.
//    Returns { status: 'sent' | 'unknown' | 'failed', chunk_ids }. A send whose
//    acceptance the channel did not confirm is 'unknown' and is never retried.
//    When context.dry_run is true, which is how the conformance check calls it,
//    send touches no network and returns invented chunk ids.
export function send(context, record) { /* -> { status, chunk_ids } */ }
```

## The context

The check, and the runtime, pass one object:

| field | what it is |
|---|---|
| `store` | the open `Store` |
| `agent` | the agent id |
| `account` | the account this adapter is bound to |
| `items` | the channel's items, as the check's fixtures give them |
| `dry_run` | true when `send` must not touch a network |
| `now` | the moment the caller is working at, in milliseconds |

## Cursor positions

A cursor position is an opaque string the adapter mints. The store orders
positions lexicographically and never moves a cursor backwards, so an adapter
mints positions that sort in channel order: zero-padded ordinals, or a
zero-padded `(uidvalidity, uid)` pair for a mailbox.

## The fixtures directory

`--fixtures <dir>` holds one JSON file per group of channel items, in the
adapter's own item shape. The check reads these files by name, so an adapter
ships a fixtures directory that carries all of them:

| file | what it holds |
|---|---|
| `inbound.json` | two or more ordinary inbound items in one conversation |
| `edit.json` | one item that is a revision of the first `inbound.json` item |
| `attachment.json` | one item with an attachment, one whose download failed |
| `operator.json` | one item from the operator, carrying a hold |
| `historical.json` | one item as an import produces it |
| `malformed.json` | one item the adapter cannot parse |
| `hostile.json` | items whose identifiers carry a separator, a dot segment and a control byte |
| `extension.json` | one item with a field the schema does not name, one whose declared field has the wrong type |
| `outbound.json` | one reply long enough that the adapter splits it |

An adapter that declares only `inbound` ships only the files the inbound cases
read.
