// One fault shape for every client tool server: {code, subject, problem, fix},
// the same four fields the launcher and `bin/carbon` use. A tool server carries
// its own copy of this library, because carbon-core never reaches a client box,
// so nothing here imports from outside `tools/lib/`.
//
// A fault is not an exception the caller has to guess at. It says what is wrong
// (problem) about what (subject) and what to do next (fix), and a call reports
// every fault it can already see, never the first one only.

// Fields a fault-shaped object is read by. Presence is not a validation result.
type FaultFields = { code?: unknown; subject?: unknown; problem?: unknown; fix?: unknown; message?: unknown };

export function fault(code: string, subject: string, problem: string, fix: string) {
  if (typeof code !== 'string' || code === '') throw new Error('fault needs a code');
  if (typeof subject !== 'string') throw new Error('fault needs a subject');
  if (typeof problem !== 'string') throw new Error('fault needs a problem');
  if (typeof fix !== 'string') throw new Error('fault needs a fix');
  return { code, subject, problem, fix };
}

// Thrown by a tool when it refuses or fails. `faults` is always a list, so one
// throw carries everything the tool already knows is wrong.
export class ToolFault extends Error {
  faults: unknown[];
  constructor(faults: unknown) {
    const list = Array.isArray(faults) ? faults : [faults];
    // List entries are untrusted; the message interpolates the same three fields as before.
    super(list.map((f) => `${(f as FaultFields).code}: ${(f as FaultFields).subject}: ${(f as FaultFields).problem}`).join('; '));
    this.name = 'ToolFault';
    this.faults = list;
  }
}

export function refuse(code: string, subject: string, problem: string, fix: string) {
  throw new ToolFault([fault(code, subject, problem, fix)]);
}

export function refuseAll(faults: { length: number }) {
  if (faults.length > 0) throw new ToolFault(faults);
}

// The text a fault list becomes inside an MCP result. The JSON copy travels
// beside it, so the model reads the sentence and a program reads the fields.
export function faultText(faults: unknown[]) {
  return faults
    .map((f) => `${(f as FaultFields).code}\n  subject: ${(f as FaultFields).subject}\n  problem: ${(f as FaultFields).problem}\n  fix: ${(f as FaultFields).fix}`)
    .join('\n\n');
}

// An error that is not a ToolFault is still reported in the one shape, never as
// a bare stack and never swallowed.
export function asFaults(error: unknown) {
  if (error instanceof ToolFault) return error.faults;
  // Untrusted throw: original short-circuit field reads, typed as optional properties.
  const thrown = error as FaultFields | null | undefined;
  return [fault(
    thrown && typeof thrown.code === 'string' ? thrown.code : 'TOOL_FAILED',
    thrown && thrown.subject ? String(thrown.subject) : 'the tool',
    thrown && thrown.message ? String(thrown.message) : String(error),
    'read the message; if it names nothing you can act on, the tool owes you a fault with a fix'
  )];
}
