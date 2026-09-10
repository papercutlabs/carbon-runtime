// The seventeen conformance cases. An adapter is a thing that passes its subset
// of them: the check runs a case only when the adapter declared a capability the
// case applies to.
//
// Each case gets its own store, so a case never depends on what another case
// left behind. A case fails by throwing; the runner reports the throw.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StreamFault } from '../stream/store.mjs';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function codes(error) {
  assert.ok(error instanceof StreamFault, `expected a StreamFault, got ${error}`);
  return error.faults.map((f) => f.code);
}

function throws(run, code) {
  try {
    run();
  } catch (error) {
    assert.ok(codes(error).includes(code),
      `expected the fault ${code}, got ${codes(error).join(', ')}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected the fault ${code} and nothing was refused` });
}

function tree(dir) {
  const found = [];
  const walk = (at) => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
}

// Put an adapter's batch through the store, exactly as the runtime does: the
// attachments first, so the record can name them, then capture, then whatever
// the adapter could not understand, parked where it landed.
export function ingest(context, items) {
  const { entries, parked } = context.adapter.payload(context, items);
  const written = [];
  for (const entry of entries) {
    let record = entry.record;
    const attachments = [];
    for (const wanted of entry.attachments ?? []) {
      if (wanted.download_failed === true) {
        attachments.push({
          file: wanted.file,
          mime: wanted.mime,
          bytes: wanted.bytes ?? 0,
          sha256: wanted.sha256,
          download_failed: true
        });
      } else {
        attachments.push(context.store.putAttachment(record, Buffer.from(wanted.bytes), wanted));
      }
    }
    record = { ...record, attachments };
    written.push(context.store.capture(record, {
      raw: entry.raw,
      cursor: entry.cursor,
      disposition: record.disposition
    }));
  }
  for (const item of parked) {
    written.push(context.store.park(item.record, item.reason, { raw: item.raw, cursor: item.cursor }));
  }
  return written;
}

function replyRecord(context, request, overrides = {}) {
  const conversation_id = overrides.conversation_id ?? `${context.account}:${request.conversation}`;
  return {
    schema: 'carbon.message.v1',
    agent: context.agent,
    source: 'email',
    account: overrides.account ?? context.account,
    conversation_id,
    conversation_kind: 'direct',
    message_id: `${conversation_id}:${request.id}`,
    platform_message_id: request.id,
    revision: 0,
    direction: 'outbound',
    role: 'agent',
    sender_id: context.account,
    received_at: request.at,
    body: request.text,
    attachments: [],
    historical: false,
    disposition: 'captured',
    delivery: {
      request_id: overrides.request_id ?? request.request_id,
      status: 'pending',
      text_sha256: sha256(request.text)
    }
  };
}

const RELEASE = { released_at: '2026-09-10T10:00:00.000Z', thread_id: 'unit-1', turn_id: 'turn-1' };

export const CASES = [
  {
    number: 1,
    name: 'the same inbound twice writes one record',
    capabilities: ['inbound'],
    run(context) {
      const items = context.fixtures['inbound.json'].slice(0, 1);
      ingest(context, items);
      ingest(context, items);
      assert.equal(context.store.rebuild().length, 1);
      assert.equal(context.store.indexEntries().length, 1);
    }
  },
  {
    number: 2,
    name: 'an edit writes a revision file and never overwrites',
    capabilities: ['inbound'],
    run(context) {
      const [first] = ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      const before = fs.readFileSync(first.file, 'utf8');
      const [edit] = ingest(context, context.fixtures['edit.json']);
      assert.notEqual(edit.file, first.file);
      assert.equal(fs.readFileSync(first.file, 'utf8'), before, 'revision 0 was overwritten');
      assert.equal(edit.record.revision, 1);
      assert.equal(context.store.rebuild().length, 2);
    }
  },
  {
    number: 3,
    name: 'filename, conversation and content agree or the read throws',
    capabilities: ['inbound'],
    run(context) {
      const [first] = ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      assert.ok(context.store.readAt(first.file));
      const moved = path.join(path.dirname(first.file), 'someone-elses-name.json');
      fs.copyFileSync(first.file, moved);
      throws(() => context.store.readAt(moved), 'RECORD_MISPLACED');
    }
  },
  {
    number: 4,
    name: 'every attachment is at its sha256, or the record says the download failed and still releases',
    capabilities: ['inbound'],
    run(context) {
      const [intact, failed] = ingest(context, context.fixtures['attachment.json']);
      const kept = intact.record.attachments[0];
      assert.ok(context.store.attachmentIntact(kept), 'the attachment is not at its sha256');
      assert.equal(fs.statSync(context.store.under(kept.file)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(context.store.under(kept.file)).mode & 0o111, 0, 'an attachment carries an execute bit');
      assert.equal(failed.record.attachments[0].download_failed, true);
      assert.ok(context.store.release(failed.record, RELEASE).release, 'a failed download blocked the release');
    }
  },
  {
    number: 5,
    name: 'the raw payload and the capture are on disk before any release decision',
    capabilities: ['inbound'],
    run(context) {
      const [first] = ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      assert.ok(fs.existsSync(first.file), 'the capture is not on disk');
      assert.ok(fs.existsSync(context.store.under(first.record.raw)), 'the raw payload is not on disk');
      assert.equal(first.record.release, undefined, 'a release was written during capture');
      const uncaptured = { ...first.record, message_id: `${first.record.message_id}-never-written` };
      throws(() => context.store.release(uncaptured, RELEASE), 'CAPTURE_BEFORE_RELEASE');
    }
  },
  {
    number: 6,
    name: 'a historical record releases no turn',
    capabilities: ['import'],
    run(context) {
      const [past] = ingest(context, context.fixtures['historical.json']);
      assert.equal(past.record.historical, true);
      assert.equal(past.record.delivery, undefined);
      throws(() => context.store.release(past.record, RELEASE), 'HISTORICAL_NEVER_RELEASES');
    }
  },
  {
    number: 7,
    name: 'an outbound record exists pending before the transport is called',
    capabilities: ['outbound'],
    run(context) {
      ingest(context, context.fixtures['inbound.json']);
      const [request] = context.fixtures['outbound.json'];
      const written = context.store.reply(replyRecord(context, request));
      const on_disk = context.store.read(written.record.conversation_id, written.record.message_id, 0);
      assert.equal(on_disk.delivery.status, 'pending');
      assert.equal(on_disk.direction, 'outbound');
      const sent = context.adapter.send({ ...context, dry_run: true }, on_disk);
      assert.equal(sent.status, 'sent');
    }
  },
  {
    number: 8,
    name: 'every chunk id of a split reply is written back',
    capabilities: ['outbound'],
    run(context) {
      ingest(context, context.fixtures['inbound.json']);
      const [request] = context.fixtures['outbound.json'];
      const written = context.store.reply(replyRecord(context, request));
      const sent = context.adapter.send({ ...context, dry_run: true }, written.record);
      assert.ok(sent.chunk_ids.length >= 2, 'the fixture reply was not split, so nothing proves the chunk ids');
      const settled = context.store.markSent(request.request_id, sent.chunk_ids);
      assert.deepEqual(settled.delivery.chunk_ids, sent.chunk_ids);
      const on_disk = context.store.read(settled.conversation_id, settled.message_id, 0);
      assert.deepEqual(on_disk.delivery.chunk_ids, sent.chunk_ids);
      assert.equal(on_disk.delivery.status, 'sent');
    }
  },
  {
    number: 9,
    name: 'a send whose acceptance is unknown lands unknown and is never retried',
    capabilities: ['outbound'],
    run(context) {
      ingest(context, context.fixtures['inbound.json']);
      const [request] = context.fixtures['outbound.json'];
      context.store.reply(replyRecord(context, request));
      const settled = context.store.markUnknown(request.request_id);
      assert.equal(settled.delivery.status, 'unknown');
      throws(() => context.store.reply(replyRecord(context, request)), 'DELIVERY_UNKNOWN_NEVER_RETRIED');
      assert.equal(context.store.rebuild().filter((r) => r.direction === 'outbound').length, 1);
    }
  },
  {
    number: 10,
    name: 'an operator message sets a hold that releases only per the declaration',
    capabilities: ['inbound'],
    run(context) {
      const [first] = ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      const [operator] = ingest(context, context.fixtures['operator.json']);
      assert.equal(operator.record.role, 'operator');
      const set_at = Date.parse(operator.record.hold.set_at);
      const window = operator.record.hold.release_after_ms;
      assert.ok(context.store.isHeld(first.record.conversation_id, set_at + 1), 'the operator message set no hold');
      throws(() => context.store.release(first.record, { ...RELEASE, now: set_at + 1 }), 'CONVERSATION_HELD');
      assert.equal(context.store.isHeld(first.record.conversation_id, set_at + window + 1), false,
        'the hold outlived what the declaration allows');
      assert.ok(context.store.release(first.record, { ...RELEASE, now: set_at + window + 1 }).release);
    }
  },
  {
    number: 11,
    name: 'the set of records rebuilt from the files equals the set the index names',
    capabilities: ['inbound', 'import'],
    run(context) {
      ingest(context, context.fixtures['inbound.json']);
      ingest(context, context.fixtures['edit.json']);
      assert.deepEqual(rebuildAgainstIndex(context.store), { missing: [], unnamed: [] });
    }
  },
  {
    number: 12,
    name: 'two live adapters cannot write one message_id; the import merges',
    capabilities: ['inbound'],
    run(context) {
      const [first] = ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      const other = { ...first.record, source: first.record.source === 'email' ? 'whatsapp' : 'email' };
      throws(() => context.store.capture(other), 'MESSAGE_ID_CLAIMED');
      const importing = {
        ...first.record,
        source: 'import:carbon-capture',
        body: 'the export says something else',
        attachments: [{ file: 'captures/elsewhere/one', mime: 'text/plain', bytes: 3, sha256: 'a'.repeat(64) }]
      };
      const merged = context.store.capture(importing);
      assert.equal(merged.merged, true);
      assert.equal(merged.record.body, first.record.body, 'the merge did not keep the first body');
      assert.equal(merged.record.attachments.length, 1, 'the merge did not add the import\'s attachment');
      assert.equal(context.store.rebuild().length, 1);
    }
  },
  {
    number: 13,
    name: 'a malformed inbound is parked in place, never deleted, never delivered',
    capabilities: ['inbound'],
    run(context) {
      const [parked] = ingest(context, context.fixtures['malformed.json']);
      assert.equal(parked.record.disposition, 'parked');
      assert.ok(fs.existsSync(parked.file), 'the parked record was not kept');
      assert.ok(fs.existsSync(context.store.under(parked.record.raw)), 'the raw payload of a parked record was not kept');
      throws(() => context.store.release(parked.record, RELEASE), 'PARKED_NEVER_RELEASES');
    }
  },
  {
    number: 14,
    name: 'an undeclared field is stored and released; a declared field of the wrong type is refused',
    capabilities: ['inbound'],
    run(context) {
      const [extended, wrong] = context.fixtures['extension.json'];
      const [written] = ingest(context, [extended]);
      assert.deepEqual(written.record.adapter_fields, extended.extra);
      assert.ok(context.store.release(written.record, RELEASE).release, 'an undeclared field blocked the release');
      throws(() => ingest(context, [wrong]), 'TYPE_WRONG');
    }
  },
  {
    number: 15,
    name: 'the reply goes out on the account the inbound arrived on, and a foreign conversation is refused',
    capabilities: ['outbound'],
    run(context) {
      ingest(context, context.fixtures['inbound.json']);
      const [request] = context.fixtures['outbound.json'];
      assert.ok(context.store.reply(replyRecord(context, request)).record);
      throws(() => context.store.reply(replyRecord(context, request, {
        account: 'agent-02@examplecorp.test', request_id: 'req-other-account'
      })), 'REPLY_ACCOUNT_MISMATCH');
      throws(() => context.store.reply(replyRecord(context, request, {
        conversation_id: `${context.account}:room-nobody-has-written-on`, request_id: 'req-other-conversation'
      })), 'CONVERSATION_NOT_OWNED');
    }
  },
  {
    number: 16,
    name: 'an identifier carrying a separator, a dot segment or a control byte is refused before any write',
    capabilities: ['inbound', 'import'],
    run(context) {
      ingest(context, context.fixtures['inbound.json'].slice(0, 1));
      const before = tree(context.store.dir);
      const expected = ['IDENTIFIER_HAS_DOT_SEGMENT', 'IDENTIFIER_HAS_SEPARATOR', 'IDENTIFIER_HAS_CONTROL_BYTE'];
      context.fixtures['hostile.json'].forEach((item, i) => {
        throws(() => ingest(context, [item]), expected[i]);
      });
      assert.deepEqual(tree(context.store.dir), before, 'a hostile identifier changed the store');
    }
  },
  {
    number: 17,
    name: 'a revision arriving below the message cursor still releases',
    capabilities: ['inbound'],
    run(context) {
      const inbound = context.fixtures['inbound.json'];
      const edit = context.fixtures['edit.json'];
      context.items = inbound;
      for (const item of context.adapter.listPending(context)) {
        ingest(context, [item]);
        context.adapter.consume(context, item);
      }
      assert.deepEqual(context.adapter.listPending(context), [], 'the cursors did not advance');

      context.items = [...inbound, ...edit];
      const pending = context.adapter.listPending(context);
      assert.equal(pending.length, 1, 'the revision below the message cursor was not listed');
      const conversation = `${context.account}:${edit[0].conversation}`;
      const cursors = context.store.cursors(conversation);
      assert.ok(String(edit[0].position) <= cursors.message,
        'the fixture revision does not sit below the message cursor, so nothing is proved');
      const [written] = ingest(context, pending);
      assert.ok(context.store.release(written.record, RELEASE).release, 'the revision did not release');
    }
  }
];

// Case 11 as a function, so `carbon-stream check --store` can run it against a
// live store the runtime filled.
export function rebuildAgainstIndex(store) {
  const key = (r) => `${r.conversation_id}${r.message_id}${r.revision}`;
  const onDisk = new Set(store.rebuild().map(key));
  const named = new Set(store.indexEntries().map(key));
  return {
    missing: [...named].filter((k) => !onDisk.has(k)).map((k) => k.split('').join(' ')),
    unnamed: [...onDisk].filter((k) => !named.has(k)).map((k) => k.split('').join(' '))
  };
}

export function casesFor(capabilities) {
  return CASES.filter((testCase) => testCase.capabilities.some((c) => capabilities.includes(c)));
}
