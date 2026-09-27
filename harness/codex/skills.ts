// skills/list — what the harness itself found in the working directories it was
// given. This is a read, and it is the only thing carbon asks about a client's
// behaviour: not what the files say, only which names the harness loaded and from
// where.
//
// It sits in its own file rather than in tools.ts because it is a different
// question from the tool servers. `tools` renders what the declaration declares
// and reads its status back; this renders nothing, declares nothing and changes
// nothing. Carbon has no loader: the harness discovers these by its own fixed
// conventions, and if the answer is empty that is a fact about the repository,
// never something carbon fixes by pointing at a path.
//
// The reply is a SkillsListResponse: `data` is one entry per working directory,
// each carrying that directory, the skills found under it, and the errors reading
// it. Carbon flattens the skills and keeps the errors, because a directory that
// failed to read is not a directory with no skills.

import { fault } from '../../lib/faults.ts';
import { HarnessFault } from './session.ts';

// Untrusted skills/list JSON. The indexer is not a validator.
function fields(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

// Returns { skills: [{name, path, cwd}], errors: [...] }. `cwds` is explicit: the
// protocol defaults an empty list to the session's own working directory, and a
// default that guesses is exactly what this repository does not do.
export async function listSkills(session: unknown, { cwds }: { cwds?: unknown }) {
  if (!Array.isArray(cwds) || cwds.length === 0) {
    throw new HarnessFault(fault('HARNESS_SKILLS_CWDS_ABSENT', 'skills/list.cwds',
      'skills were asked for with no working directory to look in, and the protocol would silently substitute its own',
      'pass the directories explicitly; for one unit of work that is the checkout the thread was opened on'));
  }
  const response = await (session as { request: (method: string, params?: unknown) => Promise<unknown> }).request('skills/list', { cwds });
  const entries = fields(response)?.data ?? [];
  const skills = [];
  const errors = [];
  for (const entry of entries as unknown[]) {
    const rec = fields(entry);
    for (const skill of (rec?.skills ?? []) as unknown[]) {
      const s = fields(skill);
      skills.push({ name: s?.name ?? null, path: s?.path ?? null, cwd: rec?.cwd ?? null });
    }
    for (const error of (rec?.errors ?? []) as unknown[]) errors.push({ cwd: rec?.cwd ?? null, error });
  }
  return { skills, errors };
}
