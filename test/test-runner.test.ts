import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';

const RUNNER = path.resolve(import.meta.dirname, '../tools/test-runner.ts');

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-test-runner-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: { test: `node "${RUNNER}"` }
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProbe(root: string, name: string, description: string, markerName: string) {
  const marker = path.join(root, markerName);
  fs.writeFileSync(path.join(root, 'test', name),
    `import fs from 'node:fs';\nimport { test } from 'node:test';\n` +
    `test(${JSON.stringify(description)}, () => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`);
}

function run(root: string) {
  const env = { ...process.env };
  // Exercise an ordinary npm invocation rather than inheriting node:test's child-process mode.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', env });
}

test('the normal test runner refuses an empty set', (t) => {
  const root = fixture(t);
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No Node test files found/);
});

test('the normal test runner discovers TypeScript-only and mixed test sets', (t) => {
  const root = fixture(t);
  writeProbe(root, 'probe.test.ts', 'TypeScript probe', 'typescript-ran');
  const typescriptOnly = run(root);
  assert.equal(typescriptOnly.status, 0, typescriptOnly.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'typescript-ran'), 'utf8'), 'ran');

  writeProbe(root, 'legacy.test.mjs', 'JavaScript probe', 'javascript-ran');
  const mixed = run(root);
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'typescript-ran'), 'utf8'), 'ran');
  assert.equal(fs.readFileSync(path.join(root, 'javascript-ran'), 'utf8'), 'ran');
});
