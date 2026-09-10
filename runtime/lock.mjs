// One lock file per adapter, guarding the release loop.
//
// The rule is taken from the pattern this runtime is built on: the file is
// created exclusively, it holds the pid and the command line of the process that
// took it, and a lock whose pid is not a live process running that same command
// line is taken over rather than obeyed. Both halves matter. Without the command
// line, a pid the kernel has reused looks alive and a healthy box refuses to
// start forever. Without the takeover, `kill -9` leaves a file that stops the
// restart, and the restart after a `kill -9` is exactly what this runtime is
// built to survive.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fault, RuntimeFault, EXIT } from './faults.mjs';
import { encodeComponent } from '../stream/encode.mjs';

// What `ps` says about a pid, or null when there is no such process. Reading our
// own command line the same way is deliberate: the two strings are then produced
// by the same tool and compare without a guess about how an argument was quoted.
export function commandLineOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    const line = out.split('\n')[0].trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

export function lockFile(storeDir, channelKey) {
  return path.join(storeDir, 'locks', `${encodeComponent(channelKey)}.json`);
}

// Returns { file, taken_over, previous }. Throws a RuntimeFault with EXIT.LOCK_HELD
// when a live process of the same command line holds it.
export function takeLock(storeDir, channelKey, { pid = process.pid, commandLine = null } = {}) {
  const file = lockFile(storeDir, channelKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mine = {
    channel: channelKey,
    pid,
    command_line: commandLine ?? commandLineOf(pid) ?? process.argv.join(' '),
    taken_at: new Date().toISOString()
  };

  let previous = null;
  let takenOver = false;
  if (fs.existsSync(file)) {
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      previous = null;
    }
    const holder = previous && Number.isInteger(previous.pid) ? commandLineOf(previous.pid) : null;
    if (holder !== null && previous && holder === previous.command_line && previous.pid !== pid) {
      throw new RuntimeFault(fault('ADAPTER_LOCK_HELD', channelKey,
        `pid ${previous.pid} is alive, runs the same command line, and took this adapter's lock at ${previous.taken_at}`,
        'stop the other runtime before starting this one; one adapter has one release loop'), EXIT.LOCK_HELD);
    }
    fs.unlinkSync(file);
    takenOver = true;
  }

  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ ...mine, took_over: previous }, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { file, taken_over: takenOver, previous };
}

export function releaseLock(file) {
  try { fs.unlinkSync(file); } catch { /* a lock already gone is a lock released */ }
}
