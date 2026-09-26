#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const testDirectory = path.join(root, 'test');
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile()
    && (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.ts')))
  .map((entry) => path.join('test', entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error('No Node test files found under test/ (.test.mjs or .test.ts).');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`Could not start the Node test runner: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
