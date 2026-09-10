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
//
// The tarball carries `node_modules`, installed here rather than on the box. A
// box has no git, no registry credential and, under the host contract, no reason
// to reach a package registry at all; a runtime whose one dependency is missing
// is a WhatsApp channel that cannot start, which is exactly what an install of
// the first tarball produced.
//
// One tarball serves every architecture, and that is a fact about this
// dependency rather than a decision we are free to make. The only dependency is
// the WhatsApp library; the only piece of its tree that varies by architecture
// is `sharp`, which it names as a peer and which our adapters never call, since
// we send text and build no image thumbnails. Installed with `--os=linux` and no
// `--libc`, npm resolves `sharp` to its WebAssembly build, which carries no
// native binary and runs the same on aarch64 and on x86_64. Naming `--libc`
// would pull the native build and force one tarball per architecture for a
// package nothing in this repository imports.
//
// `--ignore-scripts` is not a convenience: a dependency's install script is code
// running on the machine that cuts the release, and nothing in this tree needs
// one to run.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fault, report } from '../stream/faults.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// What a box needs to run an agent, and nothing else.
const SHIPPED = [
  'package.json', 'package-lock.json', 'README.md',
  'schema', 'stream', 'adapters', 'import', 'conformance', 'bin',
  // The runtime process, the harness it spawns, and the two libraries they
  // import. `tools/lib` ships and the rest of `tools/` does not: the MCP
  // scaffold is code the reply tool runs, and the identifier scan and the
  // release builder are not.
  'runtime', 'harness', 'lib', 'tools/lib'
];

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`release — build the pinned tarball a box installs

Usage:
  node tools/release.mjs [--out <dir>]

  --out <dir>   where the tarball and its sha256 file land; the default is dist/

What ships: ${SHIPPED.join(', ')}, and node_modules as
'npm ci --omit=dev --ignore-scripts --os=linux' resolves it. What does not: the
tests, the workflow, the rest of tools/, and anything git leaves behind. The
tarball is built from what git has, so a dirty checkout is refused: a release
names a commit.

One tarball runs on every architecture. The one dependency is the WhatsApp
library; the only part of its tree that varies by architecture is a package our
adapters never call, and without --libc npm resolves it to its WebAssembly
build, which carries no native binary.`);
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

  // A staging directory, so the dependencies installed for a box never land in
  // the checkout a person is working in. `git archive` puts the tracked files
  // there, which is what makes a dirty checkout irrelevant to what ships even
  // though it is refused anyway.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-runtime-release-'));
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD', '--', ...SHIPPED],
      { cwd: ROOT, maxBuffer: 1024 * 1024 * 512 });
    execFileSync('tar', ['-xf', '-', '-C', staging], { input: tar });

    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--os=linux'],
      { cwd: staging, stdio: 'inherit' });

    execFileSync('tar', [
      '--format', 'ustar',
      '-czf', tarball,
      '-C', staging,
      ...SHIPPED, 'node_modules'
    ], { stdio: 'inherit' });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const checksum = `${tarball}.sha256`;
  fs.writeFileSync(checksum, `${digest}  ${name}\n`);
  console.log(tarball);
  console.log(checksum);
  return 0;
}

process.exitCode = main(process.argv);
