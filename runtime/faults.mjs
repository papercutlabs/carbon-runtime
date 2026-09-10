// The runtime's fault shape and its exit codes.
//
// The fault shape is the store library's, which is the launcher's: one JSON line
// of {code, subject, problem, fix} per fault, every fault of one run reported
// together. The exit codes are the runtime's own, because systemd and a person
// reading `systemctl status` both need to tell four endings apart: a refusal
// before anything started, the harness child dying, another runtime already
// holding the lock, and the terminal latch.

import { fault, report } from '../stream/faults.mjs';

export { fault, report };

export const EXIT = {
  OK: 0,
  // A refusal: bad arguments, a declaration the runtime cannot start from, a
  // tool server the app-server lists that nobody declared. Nothing ran.
  FAULT: 1,
  // The app-server exited. The pair is one cgroup and systemd restarts both,
  // which is the whole reason the runtime exits rather than respawning it.
  HARNESS_EXITED: 70,
  // Another runtime is alive and holds this adapter's lock. Restarting will not
  // help and the unit should not spin.
  LOCK_HELD: 75,
  // The terminal latch. An adapter reached a state no restart fixes, a
  // revoked credential or a turn the model failed permanently. Cleared by the
  // next install and by nothing else, so `Restart=on-failure` does not sit in a
  // loop retrying a thing that cannot work.
  LATCHED: 78
};

export class RuntimeFault extends Error {
  constructor(faults, exitCode = EXIT.FAULT) {
    const all = Array.isArray(faults) ? faults : [faults];
    super(all.map((f) => `${f.code} ${f.subject}: ${f.problem}`).join('\n'));
    this.name = 'RuntimeFault';
    this.faults = all;
    this.exitCode = exitCode;
  }
}
