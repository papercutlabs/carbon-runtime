// Installed client guidance is copied by the existing runtime load contract.
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeFault, fault } from './faults.ts';
import type { Log } from './types.ts';
export const GUIDANCE_NAMES = ['AGENTS.md', '.agents'];
const MAX_GUIDANCE_DEPTH = 64;

function copyResolved(from: string, to: string, name: string, depth = 0) {
  if (depth > MAX_GUIDANCE_DEPTH) {
    throw new RuntimeFault(fault('GUIDANCE_TOO_DEEP', from,
      `${name} in the checkout nests more than ${MAX_GUIDANCE_DEPTH} directories deep, which is what a symlink pointing back at its own parent looks like`,
      'straighten the directory out in the client repository, and install again'));
  }
  const stat = fs.statSync(from);
  if (!stat.isDirectory()) {
    fs.copyFileSync(from, to);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    copyResolved(path.join(from, entry), path.join(to, entry), name, depth + 1);
  }
}

export function placeGuidance({ work, checkout, log = () => {} }: { work: string; checkout: string; log?: Log }) {
  if (!fs.existsSync(work)) {
    throw new RuntimeFault(fault('WORK_DIR_ABSENT', work,
      'the work directory is the directory a thread is opened on, and there is nothing at this path',
      'run carbon install, which places the work directory, or pass --work at a path that exists'));
  }
  const placed = [];
  for (const name of GUIDANCE_NAMES) {
    const at = path.join(work, name);
    const target = path.join(checkout, name);
    fs.rmSync(at, { recursive: true, force: true });
    if (!fs.existsSync(target)) continue;
    copyResolved(target, at, name);
    placed.push(name);
  }
  log({ event: 'guidance.placed', work, checkout, names: placed });
  return placed;
}

