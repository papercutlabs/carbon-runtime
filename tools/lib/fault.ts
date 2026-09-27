// One fault shape for every client tool server: {code, subject, problem, fix},
// the same four fields the launcher and `bin/carbon` use. A tool server carries
// its own copy of this library, because carbon-core never reaches a client box,
// so nothing here imports from outside `tools/lib/`.
//
// A fault is not an exception the caller has to guess at. It says what is wrong
// (problem) about what (subject) and what to do next (fix), and a call reports
// every fault it can already see, never the first one only.

export type Fault = { code: string; subject: string; problem: string; fix: string };

export function fault(code: unknown, subject: unknown, problem: unknown, fix: unknown): Fault {
  if (typeof code !== 'string' || code === '') throw new Error('fault needs a code');
  if (typeof subject !== 'string') throw new Error('fault needs a subject');
  if (typeof problem !== 'string') throw new Error('fault needs a problem');
  if (typeof fix !== 'string') throw new Error('fault needs a fix');
  return { code, subject, problem, fix };
}

// Thrown by a tool when it refuses or fails. `faults` is always a list, so one
// throw carries everything the tool already knows is wrong.
export class ToolFault extends Error {
  faults: Fault[];
  constructor(faults: Fault | Fault[]) {
    const list = Array.isArray(faults) ? faults : [faults];
    super(list.map((f) => `${f.code}: ${f.subject}: ${f.problem}`).join('; '));
    this.name = 'ToolFault';
    this.faults = list;
  }
}

export function refuse(code: unknown, subject: unknown, problem: unknown, fix: unknown): never {
  throw new ToolFault([fault(code, subject, problem, fix)]);
}

export function refuseAll(faults: Fault[]): void {
  if (faults.length > 0) throw new ToolFault(faults);
}

// The text a fault list becomes inside an MCP result. The JSON copy travels
// beside it, so the model reads the sentence and a program reads the fields.
export function faultText(faults: Fault[]): string {
  return faults
    .map((f) => `${f.code}\n  subject: ${f.subject}\n  problem: ${f.problem}\n  fix: ${f.fix}`)
    .join('\n\n');
}

// An error that is not a ToolFault is still reported in the one shape, never as
// a bare stack and never swallowed.
export function asFaults(error: unknown): Fault[] {
  if (error instanceof ToolFault) return error.faults;
  // A caught value may be a primitive. These optional fields model the same
  // property reads JavaScript already performs without claiming an Error shape.
  const details = error as { code?: unknown; subject?: unknown; message?: unknown } | null;
  return [fault(
    details && typeof details.code === 'string' ? details.code : 'TOOL_FAILED',
    details && details.subject ? String(details.subject) : 'the tool',
    details && details.message ? String(details.message) : String(error),
    'read the message; if it names nothing you can act on, the tool owes you a fault with a fix'
  )];
}
