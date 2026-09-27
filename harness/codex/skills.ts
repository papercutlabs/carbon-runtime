// skills/list — what the harness itself found in the working directories it was
// given. This is a read, and it is the only thing carbon asks about a client's
// behaviour: not what the files say, only which names the harness loaded and from
// where.
//
// It sits in its own file rather than in tools.mjs because it is a different
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
import { HarnessFault, type Session, asRecord } from './session.ts';

// Returns { skills: [{name, path, cwd}], errors: [...] }. `cwds` is explicit: the
// protocol defaults an empty list to the session's own working directory, and a
// default that guesses is exactly what this repository does not do.
export async function listSkills(session: Session, { cwds }: { cwds: unknown }): Promise<{
  skills: Array<{ name: unknown; path: unknown; cwd: unknown }>;
  errors: Array<{ cwd: unknown; error: unknown }>;
}> {
  if (!Array.isArray(cwds) || cwds.length === 0) {
    throw new HarnessFault(fault('HARNESS_SKILLS_CWDS_ABSENT', 'skills/list.cwds',
      'skills were asked for with no working directory to look in, and the protocol would silently substitute its own',
      'pass the directories explicitly; for one unit of work that is the checkout the thread was opened on'));
  }
  const response = await session.request('skills/list', { cwds });
  return skillsFromResponse(response);
}

function skillsFromResponse(response: unknown): {
  skills: Array<{ name: unknown; path: unknown; cwd: unknown }>;
  errors: Array<{ cwd: unknown; error: unknown }>;
} {
  const entriesValue = asRecord(response)?.data ?? [];
  const entries: unknown[] = Array.isArray(entriesValue) ? entriesValue : [];
  const skills = [];
  const errors = [];
  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const foundSkillsValue = entryRecord?.skills ?? [];
    const foundSkills: unknown[] = Array.isArray(foundSkillsValue) ? foundSkillsValue : [];
    for (const skill of foundSkills) {
      const skillRecord = asRecord(skill);
      skills.push({ name: skillRecord?.name ?? null, path: skillRecord?.path ?? null, cwd: entryRecord?.cwd ?? null });
    }
    const errorsValue = entryRecord?.errors ?? [];
    const foundErrors: unknown[] = Array.isArray(errorsValue) ? errorsValue : [];
    for (const error of foundErrors) errors.push({ cwd: entryRecord?.cwd ?? null, error });
  }
  return { skills, errors };
}
