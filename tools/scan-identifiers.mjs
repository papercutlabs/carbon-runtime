#!/usr/bin/env node
// This repository is public. Nothing in it names a client, a company, an
// internal system, a machine or a person. This scan is what makes that a
// refusal rather than a habit.
//
// The words it refuses are held beside it as sha256 hashes, in
// tools/denied-words.sha256, because writing them out here would put the very
// identifiers this scan exists to keep out into the public tree. The scan
// splits each line into words, hashes each word, and fails on a match, so
// "archive" is never a hit on a word inside it.
//
// Usage:
//   node tools/scan-identifiers.mjs <dir>
//
// A hit is one JSON line of {code, subject, problem, fix} and any hit exits
// non-zero. The hit names the file and line, and does not repeat the word: the
// person reading the failure has the line in front of them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault, report } from '../stream/faults.mjs';

const HERE = path.resolve(import.meta.dirname);
const WORDS = path.join(HERE, 'denied-words.sha256');

// One file is exempt, for a reason and nothing else: the vendored schema is
// byte-identical to the copy the schema authority holds, and its $id names the
// authority's own published domain. Changing it here would break that identity,
// which the byte-for-byte test in test/ is there to hold.
const EXEMPT = new Map([
  ['schema/carbon.message.v1.json', 'the vendored schema is byte-identical to its authority, whose $id names a published domain']
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const BINARY = /\.(png|jpg|jpeg|gif|pdf|gz|tgz|zip|woff2?)$/i;

function denied() {
  return new Set(fs.readFileSync(WORDS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#')));
}

function files(root) {
  const found = [];
  const walk = (at) => {
    for (const name of fs.readdirSync(at)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(at, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (!BINARY.test(name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function main(argv) {
  const root = argv[2];
  if (!root || root === '--help' || root === '-h') {
    console.log(`scan-identifiers — refuse a client, internal, machine or person name in a public tree

Usage:
  node tools/scan-identifiers.mjs <dir>

The words come from tools/denied-words.sha256, which holds them hashed rather
than written out. Each line of each file is split into words and each word is
hashed, so a match is a whole word and never a fragment. One file is exempt,
with its reason written beside it in this script.`);
    return root ? 0 : 1;
  }

  const words = denied();
  const faults = [];
  for (const file of files(root)) {
    const relative = path.relative(root, file);
    if (EXEMPT.has(relative) || path.resolve(file) === WORDS) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const word of line.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length === 0) continue;
        if (words.has(crypto.createHash('sha256').update(word).digest('hex'))) {
          faults.push(fault('IDENTIFIER_IN_A_PUBLIC_TREE', `${relative}:${i + 1}`,
            'the line names a client, an internal system, a machine or a person, and this repository is public',
            'say what the thing is without naming who it belongs to, or move the line to the private repository'));
          return;
        }
      }
    });
  }
  report(faults);
  return faults.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv);
