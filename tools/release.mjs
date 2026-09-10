#!/usr/bin/env node
// Build the release tarball, from a clean checkout, with its sha256 beside it.
//
// A box gets this repository as a pinned, checksummed tarball and never as a
// clone: the private half verifies the checksum the way it verifies the harness
// binary. So the tarball holds what runs on a box and nothing else — no tests,
// no fixtures, no workflow, no tools.
//
// Usage:
//   node tools/release.mjs [--out <dir>]
//
// It writes carbon-runtime-<version>.tar.gz and carbon-runtime-<version>.tar.gz.sha256
// and prints both paths. It publishes nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fault, report } from '../stream/faults.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// What a box needs to run an agent, and nothing else.
const SHIPPED = [
  'package.json', 'package-lock.json', 'README.md',
  'schema', 'stream', 'adapters', 'import', 'conformance', 'bin'
];

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`release — build the pinned tarball a box installs

Usage:
  node tools/release.mjs [--out <dir>]

  --out <dir>   where the tarball and its sha256 file land; the default is dist/

What ships: ${SHIPPED.join(', ')}. What does not: the tests, the workflow, the
tools, and anything git leaves behind. The tarball is built from what git has,
so a dirty checkout is refused: a release names a commit.`);
    return 0;
  }
  let out = path.join(ROOT, 'dist');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = path.resolve(args[++i] ?? '');
    else {
      report([fault('UNKNOWN_ARGUMENT', args[i], 'not an argument of release', 'run node tools/release.mjs --help')]);
      return 1;
    }
  }

  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty.length > 0) {
    report([fault('CHECKOUT_NOT_CLEAN', 'git status',
      'the checkout carries changes that no commit names',
      'commit or stash everything, then build the release')]);
    return 1;
  }

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.mkdirSync(out, { recursive: true });
  const name = `carbon-runtime-${version}.tar.gz`;
  const tarball = path.join(out, name);

  execFileSync('tar', [
    '--format', 'ustar',
    '-czf', tarball,
    '-C', ROOT,
    ...SHIPPED
  ], { stdio: 'inherit' });

  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const checksum = `${tarball}.sha256`;
  fs.writeFileSync(checksum, `${digest}  ${name}\n`);
  console.log(tarball);
  console.log(checksum);
  return 0;
}

process.exitCode = main(process.argv);
