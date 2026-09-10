import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StreamFault } from '../stream/store.mjs';
import { componentFaults, encodeComponent, decodeComponent, resolveUnderStore } from '../stream/encode.mjs';

const ACCOUNT = 'agent-01@examplecorp.test';

function open() {
  return Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-store-')), 'store'));
}

function record(overrides) {
  return {
    schema: 'carbon.message.v1',
    agent: 'agent-01',
    source: 'email',
    account: ACCOUNT,
    conversation_id: `${ACCOUNT}:room-7`,
    conversation_kind: 'direct',
    message_id: `${ACCOUNT}:room-7:m-0001`,
    platform_message_id: 'm-0001',
    revision: 0,
    direction: 'inbound',
    role: 'contact',
    sender_id: 'stranger@examplecorp.test',
    received_at: '2026-09-10T09:00:00.000Z',
    body: 'a body',
    attachments: [],
    historical: false,
    disposition: 'captured',
    ...overrides
  };
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

const HOSTILE = [
  ['a message id walking up out of the store', { message_id: '../../../../etc/passwd' }, ['IDENTIFIER_HAS_SEPARATOR', 'IDENTIFIER_HAS_DOT_SEGMENT']],
  ['a zip entry pointing outside media', { message_id: 'media/../../../home/somebody/.ssh/authorized_keys' }, ['IDENTIFIER_HAS_SEPARATOR', 'IDENTIFIER_HAS_DOT_SEGMENT']],
  ['a conversation that is a dot segment', { conversation_id: '..' }, ['IDENTIFIER_HAS_DOT_SEGMENT']],
  ['an identifier carrying a NUL', { message_id: 'm-0001\u0000.json' }, ['IDENTIFIER_HAS_CONTROL_BYTE']],
  ['an identifier carrying a newline', { conversation_id: 'room\n7' }, ['IDENTIFIER_HAS_CONTROL_BYTE']]
];

for (const [name, overrides, expected] of HOSTILE) {
  test(`${name} is refused before any write`, () => {
    const store = open();
    store.capture(record());
    const before = tree(store.dir);
    let refused = null;
    try {
      store.capture(record(overrides));
    } catch (error) {
      refused = error;
    }
    assert.ok(refused instanceof StreamFault, 'the hostile identifier was not refused');
    const codes = refused.faults.map((f) => f.code);
    for (const code of expected) assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(', ')}`);
    assert.deepEqual(tree(store.dir), before, 'the refusal happened after something was written');
  });
}

test('the encoding is reversible for anything short enough to encode', () => {
  const identifiers = [
    'plain-id',
    `${ACCOUNT}:room-7:m-0001`,
    '<20260910.4711@mail.examplecorp.test>',
    'a b\tc',
    'unicode: ✉ 日本語',
    '~already~encoded~7E',
    'dots.and.more.dots'
  ];
  for (const raw of identifiers) {
    const encoded = encodeComponent(raw);
    assert.doesNotMatch(encoded, /[/\\]/, `${encoded} carries a separator`);
    assert.doesNotMatch(encoded, /\./, `${encoded} carries a dot, so it could be a dot segment or a suffix`);
    assert.equal(decodeComponent(encoded), raw);
  }
});

test('an identifier too long to encode is hashed, and the record still carries the raw id', () => {
  const long = 'm-' + 'x'.repeat(500);
  const encoded = encodeComponent(long);
  assert.ok(encoded.startsWith('~h'));
  assert.equal(encoded.length, 2 + 64);
  assert.throws(() => decodeComponent(encoded), /read the raw id from the record/);

  const store = open();
  const conversation = `${ACCOUNT}:room-7`;
  const written = store.capture(record({ message_id: `${conversation}:${long}`, conversation_id: conversation }));
  assert.equal(store.readAt(written.file).message_id, `${conversation}:${long}`);
});

test('resolving a component outside the store is refused even when the encoding is skipped', () => {
  const store = open();
  assert.throws(() => resolveUnderStore(store.dir, '..', '..', 'etc', 'passwd'), /falls outside the store/);
  assert.equal(resolveUnderStore(store.dir, 'captures', 'room'), path.join(store.dir, 'captures', 'room'));
});

test('an empty identifier is refused with the rest of the faults, not on its own', () => {
  assert.deepEqual(componentFaults('message_id', '').map((f) => f.code), ['IDENTIFIER_EMPTY']);
  const both = componentFaults('message_id', 'a/b/../c');
  assert.deepEqual(both.map((f) => f.code).sort(), ['IDENTIFIER_HAS_DOT_SEGMENT', 'IDENTIFIER_HAS_SEPARATOR']);
});
