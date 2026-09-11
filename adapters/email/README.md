# The email adapter

One mailbox in, one mailbox out. It declares `inbound` and `outbound`, so
`carbon-stream check` runs sixteen of the seventeen conformance cases against
it; the seventeenth belongs to an import, and this adapter does not import.

```
node bin/carbon-stream check --adapter adapters/email --fixtures adapters/email/fixtures
```

## The contract

**Inputs.** The channel's declaration block; the IMAP and SMTP hosts, which are
also named in the agent declaration's `outbound_hosts`; and the credential file
named in the declaration's `secrets`.

**Standards, by pointer.** `carbon.message.v1` for the record;
`stream/adapter.md` for what an adapter is; the writing standard for anything
sent to a person; RFC 5322 for threading.

**Output checks.** The conformance cases. A reply carries `In-Reply-To` and
`References` taken from the inbound. Two deliveries of one `Message-ID` yield
one record. The outbound record exists on disk, `pending`, before the SMTP call.

**Invariants.**

1. `message_id` is the References root plus the message's own `Message-ID`, and
   the conversation is that References root — never the subject. The store
   namespaces a conversation by its account, so on disk the conversation reads
   `<account>:<references root>` and the record `<account>:<references
   root>:<Message-ID>`.
2. The mailbox that received is the mailbox that answers. An inbound that names
   no declared address of this agent in its recipients is captured, kept, and
   never answered: it lands with `disposition: policy-drop`, and `send` refuses
   any reply that names it.
3. The agent's own sent mail is `role: agent`. A person's mail out of the same
   mailbox is `role: operator` and sets the hold.
4. Release is `immediate` unless the declaration says otherwise; a hold outranks
   it.
5. Polling runs at `poll_interval_ms`, and never faster than the floor of 30
   seconds. A declaration below the floor is refused, not quietly raised.
6. The watermark is `(uidvalidity, uid)`. A UIDVALIDITY change re-scans the
   mailbox from the first uid, and the `Message-ID` dedup absorbs the re-read: a
   repeated write merges and changes no capture bytes.
7. The credential is never read by this code, never logged, and never placed on
   a command line.

## The declaration block

```json
{
  "kind": "email",
  "account": "agent-01@example.test",
  "addresses": ["billing@example.test"],
  "mailbox": "INBOX",
  "imap_host": "imap.example.test",
  "imap_port": 993,
  "smtp_host": "smtp.example.test",
  "smtp_port": 465,
  "netrc": "/srv/carbon/agent-01/secrets/mail.netrc",
  "poll_interval_ms": 60000,
  "max_attachment_bytes": 25000000,
  "max_part_bytes": 65536,
  "release": "immediate",
  "hold": { "release_after_ms": 3600000 }
}
```

`addresses` is every other address this mailbox owns; a message that names one
of them, or the account, is answerable, and one that names none is not.
`max_part_bytes` is the size past which a reply goes as a numbered series of
mails, each with its own `Message-ID`; those Message-IDs are the chunk ids the
store keeps.

## The secret

One netrc file, placed by the mailbox's owner, owned by the tools user and
readable by nobody else, at the path the declaration's `secrets` entry names. It
holds one line per host, and nothing else:

```
machine imap.example.test login agent-01@example.test password THE-MAILBOX-PASSWORD
machine smtp.example.test login agent-01@example.test password THE-MAILBOX-PASSWORD
```

```
chmod 0600 mail.netrc
```

Two lines, because curl matches the machine line to the host it is dialling, and
the IMAP host and the SMTP host are two hosts even when the password is one. The
adapter passes the path to curl as `--netrc-file` and never opens the file
itself, so the password does not pass through this process, does not reach a
command line another user can read in the process table, and does not reach a
log.

## How it works

**Reading.** `poll` reads the mailbox status, compares the UIDVALIDITY with the
one the watermark holds, searches from the watermark up, and fetches each
message whole. The watermark lives in the store's own cursor, under a
conversation id shaped like a mailbox, `<account>:mailbox:<mailbox>`, so there is
one place cursors live and one write order that moves them. `consume` is the
only thing that moves a cursor, and it moves two: the conversation's, and the
mailbox watermark.

**Threading.** A message's conversation is the first id in its `References`
chain; with no `References`, the id in `In-Reply-To`; with neither, its own
`Message-ID`, because it starts a thread. A message carrying `Supersedes` is
written as a revision of the record it supersedes, so a correction never
overwrites what it corrects; a correction of something this store never saw is
an ordinary message.

**Reading a message.** `mime.mjs` is ours: unfolded headers with RFC 2047
encoded words decoded, the first `text/plain` part as the body, a stripped
`text/html` part when there is no plain one, and attachments written beside the
record at 0600 with no execute bit. An attachment past
`max_attachment_bytes` is recorded with its true size and digest and
`download_failed: true`, and the record still releases: the bytes arrived with
the message and are in the raw payload, and what the cap refuses is a second
copy of them as a file of its own. A message with no `Message-ID`, or in a
content transfer encoding this reader does not decode, is parked where it landed
and never delivered. The name the part gave itself is kept on the record as
`filename`, because the file on disk is named by its digest and the message's own
text talks about the sender's name for it. What the turn is then told about an
attachment is the release loop's, not this adapter's: every attachment is named,
sized and located, and a `text/plain`, `text/csv` or `text/markdown` attachment
of 64 KB or less also travels in the turn as text.

**Sending.** The reply goes to the `Reply-To` of the message being answered, or
its `From`. It carries `In-Reply-To` and `References` from that message, and the
subject is read back from the raw payload the capture kept, because the record
carries what the contract names and no more. The outbound record is written
`pending` by the store before any part of the send touches the network, and the
sent Message-IDs are written back as the chunk ids.

**A send's three outcomes.** curl exiting 0 is `sent`. curl exiting 6, 7, 51, 60
or 67 means the message never reached the mail server, which is `failed` and can
be sent again. Anything else is `unknown`, which is never retried: a person
decides what happened to it.

## What a real provider did to this, and what it means

Verified against a live IMAP and SMTP server on 10 September 2026.

1. **curl's custom request drops the message.** `--request 'UID FETCH n
   (BODY.PEEK[])'` writes only the untagged response line to stdout and silently
   drops the literal that holds the message: 31 bytes instead of 803. The URL
   form, `imaps://host/INBOX;UID=n`, hands over the bytes, so that is what the
   transport uses.
2. **Fetching marks a message read.** The URL form fetches `BODY[]`, which sets
   `\Seen`. In a mailbox a person also reads, that would quietly take a message
   off their unread list, so the poll reads the unseen set first and puts the
   flag back afterwards; a failure to put it back is reported and never costs
   the capture.
3. **A provider may replace the Message-ID it was given.** This one did, on
   every send. So the chunk id recorded is the id this adapter asked for, which
   is what the store can prove it sent, and the agent's own sent mail is
   recognised on its way back by the `X-Carbon-Origin` stamp rather than by that
   id. The stamp survived the rewrite; the id did not.
4. **A mail addressed to its own mailbox may never come back to INBOX.** It
   landed in `Sent` and nowhere else. That is a fact about self-addressed mail,
   not about the adapter, and it is why the live smoke names the mailbox it
   reads.

## The fixtures

`fixtures/` holds the channel items the conformance check feeds the adapter, one
JSON file per group, in the adapter's own item shape:

```json
{ "mailbox": "INBOX", "uidvalidity": 4272, "uid": 3,
  "position": "0000004272:0000000003",
  "conversation": "aug-invoice-001@example.test",
  "rfc822": ["From: ...", "", "the body"] }
```

`rfc822` is the message as lines, which is what both an IMAP fetch and a fixture
give. `position` is what the cursors compare and `conversation` is the
References root, both as the poller derived them: the check reads them there,
and the adapter derives them from the message itself.

`fixtures/channel.json` is the declaration block the check runs under. The check
passes no declaration of its own, so the adapter reads one from its fixtures
directory when it is there and from `context.channel` on a box. Its
`max_attachment_bytes` and `max_part_bytes` are small on purpose, so a fixture
can be past them without being large.

`test/fixtures/imap-recorded/` holds responses recorded from that live server,
with the host and the account replaced by `example.test` names, and
`test/fixtures/curl-shim/curl` replays them, so the tests reach no network.

## The live smoke

`bin/carbon-email smoke` is the other half of the proof: the same code against a
real mailbox, run by hand. `--help` is its manual.
