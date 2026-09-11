import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'bin', 'carbon-stream');
const FIXTURE_ADAPTER = path.join(ROOT, 'adapters', 'fixture');
const FIXTURES = path.join(FIXTURE_ADAPTER, 'fixtures');
const BROKEN = path.join(ROOT, 'test', 'fixtures', 'broken-adapter');

function check(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

test('the fixture adapter passes all twenty-three cases', () => {
  const result = check(['check', '--adapter', FIXTURE_ADAPTER, '--fixtures', FIXTURES]);
  assert.equal(result.code, 0, result.out);
  const passes = result.out.split('\n').filter((line) => / pass /.test(line));
  assert.equal(passes.length, 23, result.out);
  for (let number = 1; number <= 23; number++) {
    assert.match(result.out, new RegExp(`case\\s+${number}\\s+pass`), `case ${number} did not pass`);
  }
});

test('a deliberately broken adapter fails the case its break belongs to', () => {
  const result = check(['check', '--adapter', BROKEN, '--fixtures', FIXTURES]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /case\s+1\s+FAIL\s+the same inbound twice writes one record/);
  // It declares inbound alone, so the outbound and import cases never run.
  assert.doesNotMatch(result.out, /case\s+7\s/);
  assert.doesNotMatch(result.out, /case\s+6\s/);
});

test('the check runs only the cases the adapter declared a capability for', () => {
  const result = check(['check', '--adapter', BROKEN, '--fixtures', FIXTURES]);
  assert.match(result.out, /of 23 cases apply to \[inbound\]/);
});

test('every command carries its manual and refuses a guess', () => {
  const help = check(['check', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--adapter/);
  assert.match(help.out, /The twenty-three cases:/);

  const missing = check(['check', '--adapter', FIXTURE_ADAPTER]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /MISSING_ARGUMENT/);
  for (const line of missing.out.split('\n').filter(Boolean)) {
    const fault = JSON.parse(line);
    assert.deepEqual(Object.keys(fault).sort(), ['code', 'fix', 'problem', 'subject']);
  }
});

test('--store runs the rebuild against the index on a live store', () => {
  const result = check(['check', '--store', path.join(ROOT, 'test', 'fixtures', 'store-that-is-not-there')]);
  assert.equal(result.code, 1);
  assert.match(result.out, /STORE_MISSING/);
});
