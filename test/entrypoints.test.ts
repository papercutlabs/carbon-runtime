import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ENTRYPOINTS,
  EntrypointFault,
  assertPresent,
  checkEntrypoints,
} from '../tools/check-entrypoints.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function ownedCopy(mutate?: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-entrypoints-'));
  // Minimal package shape so the sync API resolves typescript and @types/node.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const rel of ENTRYPOINTS) {
    const base = path.basename(rel);
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
    fs.copyFileSync(path.join(ROOT, `${rel}.ts`), path.join(dir, `${rel}.ts`));
    // Bodies import from the repository; keep those relative paths working by
    // linking the directories the starters' adjacent modules resolve through.
  }
  // Link the source trees the thin starters import so typecheck can resolve them.
  for (const name of ['adapters', 'conformance', 'harness', 'import', 'runtime', 'stream', 'tools', 'lib']) {
    const at = path.join(ROOT, name);
    if (fs.existsSync(at)) fs.symlinkSync(at, path.join(dir, name));
  }
  if (mutate) mutate(dir);
  return dir;
}

test('every named starter is present and non-empty on this checkout', () => {
  const faults = assertPresent(ROOT);
  assert.deepEqual(faults, []);
  for (const rel of ENTRYPOINTS) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(source, /^#!\/usr\/bin\/env node\n/);
    assert.match(source, /@ts-check/);
    assert.match(source, new RegExp(`import '\\./${path.basename(rel)}\\.ts';`));
  }
});

test('the repository starters typecheck as virtual .mjs compiler roots', () => {
  const result = checkEntrypoints(ROOT);
  assert.equal(result.diagnostics.length, 0, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.roots.length, ENTRYPOINTS.length);
  for (const rel of ENTRYPOINTS) {
    const want = path.join(ROOT, `bin/${path.basename(rel)}.mjs`);
    assert.ok(result.roots.includes(want), `missing root ${want}`);
  }
});

test('a missing starter is refused', () => {
  const dir = ownedCopy((d) => {
    fs.rmSync(path.join(d, 'bin/carbon-stream'));
  });
  try {
    const faults = assertPresent(dir);
    assert.equal(faults.length, 1);
    assert.equal(faults[0].code, 'ENTRYPOINT_MISSING');
    assert.equal(faults[0].subject, 'bin/carbon-stream');
    assert.throws(() => checkEntrypoints(dir), (error: unknown) => {
      assert.ok(error instanceof EntrypointFault);
      assert.equal(error.faults[0].code, 'ENTRYPOINT_MISSING');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty starter is refused', () => {
  const dir = ownedCopy((d) => {
    fs.writeFileSync(path.join(d, 'bin/carbon-stream'), '');
  });
  try {
    const faults = assertPresent(dir);
    assert.equal(faults.length, 1);
    assert.equal(faults[0].code, 'ENTRYPOINT_EMPTY');
    assert.equal(faults[0].subject, 'bin/carbon-stream');
    assert.throws(() => checkEntrypoints(dir), (error: unknown) => {
      assert.ok(error instanceof EntrypointFault);
      assert.equal(error.faults[0].code, 'ENTRYPOINT_EMPTY');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a deliberate wrong JSDoc type in a starter fails the entrypoints check', () => {
  const dir = ownedCopy((d) => {
    fs.writeFileSync(path.join(d, 'bin/carbon-stream'), `#!/usr/bin/env node
// @ts-check
/** @type {number} */
const __bad = "nope";
import './carbon-stream.ts';
`);
  });
  try {
    const result = checkEntrypoints(dir);
    assert.ok(result.diagnostics.length > 0, 'expected a type error in the bad starter');
    assert.ok(result.diagnostics.some((d) => d.code === 2322), JSON.stringify(result.diagnostics, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run typecheck fails when a starter carries a wrong JSDoc type', () => {
  // Probe through the check-entrypoints CLI on an owned copy, which is what the
  // typecheck script runs after tsc. The repository itself stays untouched.
  const dir = ownedCopy((d) => {
    fs.writeFileSync(path.join(d, 'bin/carbon-email'), `#!/usr/bin/env node
// @ts-check
/** @type {number} */
const __bad = "nope";
import './carbon-email.ts';
`);
  });
  try {
    const probe = spawnSync(process.execPath, [path.join(ROOT, 'tools/check-entrypoints.ts'), dir], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: undefined, NODE_NO_WARNINGS: '1' },
    });
    assert.notEqual(probe.status, 0, probe.stdout + probe.stderr);
    assert.match(probe.stderr, /error TS2322/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
