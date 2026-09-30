// A SOP defines one kind of work. A job is one run of a version of that SOP.
// The structural checks here are shared by offline validation and installation.
export type Position = {
  id: string; label: string; means: string; do_here: string; waiting_on: string;
  terminal?: boolean; deadline?: unknown; on_deadline?: string; renamed_from?: string;
};
export type Track = { id: string; label: string; initial: string; positions: Position[] };
export type Move = { track: string; from: string[]; to: string };
export type Step = {
  id: string; kind: 'intent' | 'observation'; mover: string; observed_via: string;
  moves: Move[]; requires?: [string, string][]; action?: unknown; retired?: boolean;
};
export type Sop = {
  sop: string; version: string; tracks: Track[]; events: Step[];
  collected_channels: Record<string, unknown>; [key: string]: unknown;
};

const ID = /^[a-z][a-z0-9_-]*$/;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSop(value: unknown, fileSop: string): string[] {
  const faults: string[] = [];
  if (!object(value)) return ['the SOP file must hold one JSON object'];
  if (value.sop !== fileSop) faults.push(`sop must match filename ${fileSop}`);
  if (!text(value.version)) faults.push('version must be a nonempty string');
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) faults.push('tracks must be a nonempty list');
  if (!Array.isArray(value.events)) faults.push('events must be a list');
  if (!object(value.collected_channels) || !Object.hasOwn(value.collected_channels, 'agent_action')) {
    faults.push('collected_channels must include agent_action');
  }
  if (faults.length) return faults;
  const sop = value as Sop;
  const tracks = new Map<string, Set<string>>();
  const retired = new Set<string>();
  for (const track of sop.tracks) {
    if (!object(track) || !text(track.id) || !ID.test(track.id)) { faults.push('a track has no valid id'); continue; }
    if (tracks.has(track.id)) faults.push(`duplicate track ${track.id}`);
    if (!text(track.label)) faults.push(`track ${track.id}: label is missing`);
    if (!Array.isArray(track.positions) || track.positions.length === 0) {
      faults.push(`track ${track.id}: positions must be a nonempty list`); continue;
    }
    const positions = new Set<string>();
    tracks.set(track.id, positions);
    for (const position of track.positions) {
      if (!object(position) || !text(position.id) || !ID.test(position.id)) {
        faults.push(`track ${track.id}: a position has no valid id`); continue;
      }
      if (positions.has(position.id)) faults.push(`track ${track.id}: duplicate position ${position.id}`);
      positions.add(position.id);
      for (const field of ['label', 'means', 'do_here', 'waiting_on'] as const) {
        if (!text(position[field])) faults.push(`track ${track.id}.${position.id}: ${field} is missing`);
      }
      if (typeof position.terminal !== 'boolean') faults.push(`track ${track.id}.${position.id}: terminal must be boolean`);
      if (position.deadline !== undefined && !text(position.on_deadline)) {
        faults.push(`track ${track.id}.${position.id}: deadline has no chasing step`);
      }
      if (position.renamed_from !== undefined && (!text(position.renamed_from) || !ID.test(position.renamed_from))) {
        faults.push(`track ${track.id}.${position.id}: renamed_from is not a position id`);
      }
    }
    if (!positions.has(track.initial)) faults.push(`track ${track.id}: initial ${track.initial} is not a position`);
  }
  const stepIds = new Set<string>();
  for (const step of sop.events) {
    if (!object(step) || !text(step.id) || !ID.test(step.id)) { faults.push('a step has no valid id'); continue; }
    if (stepIds.has(step.id)) faults.push(`duplicate step ${step.id}`);
    stepIds.add(step.id);
    if (step.retired === true) retired.add(step.id);
    if (step.kind !== 'intent' && step.kind !== 'observation') faults.push(`step ${step.id}: kind must be intent or observation`);
    if (!text(step.mover)) faults.push(`step ${step.id}: mover is missing`);
    if (!text(step.observed_via) || !Object.hasOwn(sop.collected_channels, step.observed_via)) {
      faults.push(`step ${step.id}: observed_via is not a collected channel`);
    }
    if (step.kind === 'intent' && step.observed_via !== 'agent_action') {
      faults.push(`step ${step.id}: intent needs the agent_action channel`);
    }
    if (step.kind === 'intent' && (step.action === undefined || step.action === null)) {
      faults.push(`step ${step.id}: intent has no action`);
    }
    if (!Array.isArray(step.moves)) { faults.push(`step ${step.id}: moves must be a list`); continue; }
    for (const move of step.moves) {
      if (!object(move) || !text(move.track) || !tracks.has(move.track)) {
        faults.push(`step ${step.id}: unknown track ${String(move?.track)}`); continue;
      }
      const positions = tracks.get(move.track)!;
      if (!Array.isArray(move.from) || move.from.length === 0) faults.push(`step ${step.id}: from must name a position`);
      else for (const from of move.from) if (!positions.has(from)) faults.push(`step ${step.id}: unknown from position ${from}`);
      if (!positions.has(move.to)) faults.push(`step ${step.id}: unknown to position ${move.to}`);
    }
    if (step.requires !== undefined) {
      if (!Array.isArray(step.requires)) faults.push(`step ${step.id}: requires must be a list`);
      else for (const required of step.requires) {
        if (!Array.isArray(required) || required.length !== 2 || !tracks.get(required[0])?.has(required[1])) {
          faults.push(`step ${step.id}: requires names an unknown position`);
        }
      }
    }
  }
  for (const track of sop.tracks) for (const position of track.positions) {
    if (position.on_deadline && (!stepIds.has(position.on_deadline) || retired.has(position.on_deadline))) {
      faults.push(`track ${track.id}.${position.id}: chasing step ${position.on_deadline} is absent or retired`);
    }
  }
  return faults;
}

export type Positions = Record<string, string>;

export function initialPositions(sop: Sop): Positions {
  return Object.fromEntries(sop.tracks.map((track) => [track.id, track.initial]));
}

export function stepOf(sop: Sop, id: string): Step {
  const step = sop.events.find((candidate) => candidate.id === id);
  if (!step || step.retired) throw new Error(`SOP ${sop.sop} has no active step ${id}`);
  return step;
}

export function legality(step: Step, positions: Positions) {
  const why: string[] = [];
  for (const [track, expected] of step.requires ?? []) {
    if (positions[track] !== expected) why.push(`${track} must be ${expected}; it is ${positions[track]}`);
  }
  const primary = step.moves[0]?.track;
  if (primary) {
    const from = step.moves.filter((move) => move.track === primary).flatMap((move) => move.from);
    if (!from.includes(positions[primary])) why.push(`${primary} is ${positions[primary]}, not ${from.join(' or ')}`);
  }
  return { legal: why.length === 0, why };
}

export function allowedIntents(sop: Sop, positions: Positions): string[] {
  return sop.events.filter((step) => step.kind === 'intent' && !step.retired
    && legality(step, positions).legal).map((step) => step.id);
}

export function applyObservation(step: Step, positions: Positions) {
  const next = { ...positions };
  const moved = new Set<string>();
  let offModel = (step.requires ?? []).some(([track, position]) => positions[track] !== position);
  for (const move of step.moves) {
    if (moved.has(move.track)) continue;
    if (move.from.includes(positions[move.track])) { next[move.track] = move.to; moved.add(move.track); }
  }
  const primary = step.moves[0]?.track;
  if (primary && !moved.has(primary)) {
    offModel = true;
    next[primary] = step.moves.filter((move) => move.track === primary).at(-1)!.to;
  }
  return { positions: next, offModel };
}

export function positionViews(sop: Sop, positions: Positions, since: Record<string, string> = {}) {
  return sop.tracks.map((track) => {
    const position = track.positions.find((candidate) => candidate.id === positions[track.id]);
    if (!position) throw new Error(`job has unknown ${track.id} position ${positions[track.id]}`);
    return { track: track.id, position: position.id, label: position.label, means: position.means,
      do_here: position.do_here, waiting_on: position.waiting_on,
      since: since[track.id] ?? null, deadline: position.deadline ?? null,
      on_deadline: position.on_deadline ?? null, terminal: position.terminal === true };
  });
}
