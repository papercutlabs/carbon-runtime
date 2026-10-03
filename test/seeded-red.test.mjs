import test from 'node:test';
import assert from 'node:assert/strict';

test('seeded red: this failure must be named in the check log', () => {
  assert.equal(1 + 1, 3, 'seeded red on purpose, removed by the next commit');
});
