import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN = path.join(ROOT, 'tools', 'scan-identifiers.mjs');

function scan(dir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCAN, dir], { encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status, out: error.stdout ?? '' };
  }
}

test('this tree names no client, no internal system, no machine and no person', () => {
  const result = scan(ROOT);
  assert.equal(result.code, 0, result.out);
});

test('the scan matches a whole word and not a fragment of one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-scan-'));
  fs.writeFileSync(path.join(dir, 'innocent.md'), 'git archive builds the tarball, and the hivemind is elsewhere\n');
  assert.equal(scan(dir).code, 0, 'a word that merely contains a denied word was treated as a hit');

  // The denied word is built from pieces, so this test file does not itself
  // carry the word the scan refuses.
  const denied = 'stu' + 'dio';
  fs.writeFileSync(path.join(dir, 'guilty.md'), `this page was written on the ${denied}\n`);
  const guilty = scan(dir);
  assert.equal(guilty.code, 1);
  assert.match(guilty.out, /guilty\.md:1/);
  assert.doesNotMatch(guilty.out, new RegExp(denied), 'the fault repeated the word it refuses');
});

test('nothing in this tree can take a client\'s records away', () => {
  for (const dir of ['stream', 'adapters', 'conformance', 'bin']) {
    const walk = (at) => {
      for (const name of fs.readdirSync(at)) {
        const full = path.join(at, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /prune|retention/i, `${full} carries a path that drops records`);
      }
    };
    walk(path.join(ROOT, dir));
  }
});
