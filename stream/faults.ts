// The launcher's fault shape, used by every carbon command. Faults are collected
// and reported together, never one at a time, so one run of a command tells the
// caller everything that is wrong.

export type Fault = {
  code: string;
  subject: string;
  problem: string;
  fix: string;
};

type Output = { write(chunk: string): unknown };

export function fault(code: string, subject: string, problem: string, fix: string): Fault {
  return { code, subject, problem, fix };
}

export function report(faults: readonly Fault[], out: Output = process.stdout): void {
  for (const f of faults) out.write(JSON.stringify(f) + '\n');
}
