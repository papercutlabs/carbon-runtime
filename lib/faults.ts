// The launcher's fault shape, used by every carbon command. Faults are collected
// and reported together, never one at a time, so one run of a command tells the
// caller everything that is wrong.

export function fault<C, S, P, F>(code: C, subject: S, problem: P, fix: F) {
  return { code, subject, problem, fix };
}

export function report(faults: Iterable<unknown>, out: { write(chunk: string): unknown } = process.stdout) {
  for (const f of faults) out.write(JSON.stringify(f) + '\n');
}
