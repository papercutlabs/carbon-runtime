import fs from 'node:fs';
import path from 'node:path';
import { beginMappedAction, finishMappedAction } from '../../tools/lib/action-check.ts';
import { fault, ToolFault } from '../../tools/lib/fault.ts';

type Target = { job: string; status: 'open' | 'sent'; action_id?: string; writes: number };
type Call = { target_id: string; about_job: string; about_move: string; source_id: string };

// A client tool stand-in. Its target is a local client-system record, not a
// caller-supplied job id. The write counter makes an accidental second effect
// visible to the test. A real engagement replaces this adapter with its API.
export async function standinClientWrite(root: string, call: Call,
  { baseUrl, afterEffect }: { baseUrl: string; afterEffect?: () => void }) {
  if (!/^[a-z][a-z0-9-]*$/.test(call.target_id)) throw new Error('invalid stand-in client target');
  const file = path.join(root, `${call.target_id}.json`);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Target;
  const current = read();
  if (call.about_job !== current.job || call.about_move !== 'send') {
    throw new ToolFault([fault('JOB_ACTION_CONTEXT_MISMATCH', call.target_id,
      'the supplied job or move contradicts this client write',
      'use the job bound to this target and its mapped send move')]);
  }
  if (current.status === 'sent' && current.action_id) {
    await finishMappedAction({ kind: 'claimed', job: current.job,
      step: 'send', action_id: current.action_id },
      `standin-read:${call.target_id}:${current.action_id}`, { baseUrl });
    return read();
  }
  const claim = await beginMappedAction({ about_job: call.about_job, about_move: call.about_move,
    derived_job: current.job, derived_move: 'send', operation: 'send', source_id: call.source_id },
  { baseUrl });
  if (claim.kind !== 'claimed') throw new Error('the stand-in write requires an SOP claim');
  const temp = `${file}.tmp-${process.pid}-${claim.action_id}`;
  fs.writeFileSync(temp, JSON.stringify({ ...current, status: 'sent',
    action_id: claim.action_id, writes: current.writes + 1 }));
  fs.renameSync(temp, file);
  afterEffect?.();
  const observed = read();
  if (observed.status !== 'sent' || observed.action_id !== claim.action_id) {
    throw new Error('client readback did not confirm the claimed effect');
  }
  await finishMappedAction(claim, `standin-read:${call.target_id}:${claim.action_id}`, { baseUrl });
  return observed;
}
