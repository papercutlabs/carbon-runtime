import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDORED = path.join(ROOT, 'schema', 'carbon.message.v1.json');
const TEACHING = path.join(ROOT, 'schema', 'carbon.teaching.v1.json');

test('the vendored schema is the record shape this store writes', () => {
  const schema = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));
  assert.equal(schema.title, 'carbon.message.v1');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.adapter_fields, 'there is nowhere to carry an adapter\'s own fields');
  assert.equal(schema.properties.adapter_fields.additionalProperties, true);
  for (const field of ['delivery', 'release', 'hold', 'disposition', 'historical', 'revision']) {
    assert.ok(schema.properties[field], `the schema does not name ${field}`);
  }
  assert.deepEqual(schema.properties.delivery.properties.status.enum, ['pending', 'sent', 'unknown', 'failed']);
});

// This repository is not the schema authority: it vendors a copy of the file
// the authority holds, and the two must be byte-identical. The authority is a
// separate checkout, which this repository's own workflow cannot see, so the
// comparison runs only where someone has both and says where the other one is.
test('the vendored schema is byte-identical to the authority when it is reachable', (t) => {
  const authority = process.env.CARBON_SCHEMA_AUTHORITY;
  if (!authority) {
    t.skip('CARBON_SCHEMA_AUTHORITY is unset, so there is no second copy to compare with');
    return;
  }
  const file = path.join(authority, 'schema', 'carbon.message.v1.json');
  if (!fs.existsSync(file)) {
    t.skip(`${file} is not there, so there is no second copy to compare with`);
    return;
  }
  assert.deepEqual(fs.readFileSync(VENDORED), fs.readFileSync(file),
    'the vendored schema has drifted from the authority; copy the authority\'s file over it');
});

test('the vendored teaching schema is the record shape the teachings library writes', () => {
  const schema = JSON.parse(fs.readFileSync(TEACHING, 'utf8'));
  assert.equal(schema.title, 'carbon.teaching.v1');
  // The one schema here that carries an unknown field wherever it sits. This
  // record is written by one copy of the store library and read by another, and
  // a strict key check would park a client's own instruction the first time the
  // two versions differed.
  assert.equal(schema.additionalProperties, true);
  assert.deepEqual(schema.properties.kind.enum, ['instruction', 'change-request']);
  assert.deepEqual(schema.properties.status.enum, ['active', 'forgotten', 'open', 'closed']);
  assert.deepEqual(schema.properties.failed_question.enum, [1, 2, 3, 4, 'size']);
  assert.equal(schema.properties.taught_by.additionalProperties, false);
  for (const field of ['id', 'kind', 'agent', 'text', 'conversation_id', 'source_message_id', 'taught_by', 'taught_at', 'status']) {
    assert.ok(schema.required.includes(field), `the schema does not require ${field}`);
  }
});

test('the vendored teaching schema is byte-identical to the authority when it is reachable', (t) => {
  const authority = process.env.CARBON_SCHEMA_AUTHORITY;
  if (!authority) {
    t.skip('CARBON_SCHEMA_AUTHORITY is unset, so there is no second copy to compare with');
    return;
  }
  const file = path.join(authority, 'schema', 'carbon.teaching.v1.json');
  if (!fs.existsSync(file)) {
    t.skip(`${file} is not there, so there is no second copy to compare with`);
    return;
  }
  assert.deepEqual(fs.readFileSync(TEACHING), fs.readFileSync(file),
    'the vendored schema has drifted from the authority; copy the authority\'s file over it');
});
