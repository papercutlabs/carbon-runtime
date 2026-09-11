// The runtime process: the one thing a unit starts.
//
// It spawns the pinned harness as its direct child and exits non-zero if that
// child exits, so systemd restarts the pair together in one cgroup. It starts the
// tool servers that run as the agent user, and waits for the ones that run under
// their own unit as the tools user. It hosts the adapters in this process, takes
// one lock per adapter, and runs the release loop. It serves
// the `reply` tool on loopback. It refuses to start when the store is latched, and
// it latches and stops when it meets an ending a restart cannot help.
//
// It has no daemon of its own beyond that, no database, no orchestration, and no
// reload path: a change to what the agent does is a commit and an install.

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import { fault, report, RuntimeFault, EXIT } from './faults.mjs';
import { refuseIfLatched } from './latch.mjs';
import { takeLock, releaseLock } from './lock.mjs';
import { loadAdapter } from './registry.mjs';
import { startToolServers, stopToolServers, awaitToolServers } from './tool-servers.mjs';
import { serveReplyTool, REPLY_PORT } from './reply-tool.mjs';
import { ReleaseLoop } from './loop.mjs';
import { pollIntervalFor } from './poll.mjs';
import { resolveChannel } from './channel.mjs';

// Where each thing lives under an agent directory. Install renders the left-hand
// side; the runtime reads it and guesses none of it.
//
// The checkout is `current/repo` and the thread's `cwd` is `work/`, and the two
// are deliberately different places. Under `workspace-write` everything below
// `cwd` is writable whatever `writableRoots` says, so a checkout under `cwd`
// would be the model's to edit; and the harness's Linux sandbox protects a
// writable root's `.git` by binding it over itself, which needs that mount point
// to be creatable. A checkout that is read-only and carries no `.git` — HC-16 is
// the line that forbids one on a client box — can be neither, and a turn that
// runs one local command dies in bubblewrap before the shell starts (PA-181).
// So `work/` is the `cwd`: agent-owned, writable, already the unit's log
// directory. The checkout stays at the stable path, read-only by ownership and
// mode (the tools user owns it at 0555 and 0444), the turn input names it, and
// the guidance the harness loads from `cwd` is linked into `work/` from it.
export function placesUnder(agentDir) {
  return {
    declaration: path.join(agentDir, 'current', 'carbon.agent.json'),
    store: path.join(agentDir, 'store'),
    codexHome: path.join(agentDir, 'codex-home'),
    checkout: path.join(agentDir, 'current', 'repo'),
    work: path.join(agentDir, 'work'),
    harnessRoot: path.join(agentDir, 'harness')
  };
}

// What the harness reads out of the thread's `cwd` and out of nowhere else:
// `AGENTS.md`, the agent's guidance, and `.agents/`, which holds its skills.
// Verified against the pinned binary on 11 September (carbon-runtime
// runtime/proofs/20260911-thread-cwd.md): with `cwd` set to a directory holding
// neither, the rendered prompt carries no guidance and lists no skill; with each
// one present as a symlink into the checkout, both come back.
export const GUIDANCE_NAMES = ['AGENTS.md', '.agents'];

// Links the checkout's guidance into the work directory, and returns the names it
// linked.
//
// A link rather than a copy, because the checkout stays the authority: the bytes
// live in the version directory install unpacked, `current` swings to the next
// one, and a copy would be a second answer that goes stale between installs. It
// is the runtime that places them rather than install, because the work directory
// is the agent user's own and the runtime is the thing that opens a thread on it;
// the on-box half of install is root-owned and changing it is a host-contract
// bump.
//
// A name that is already a symlink is replaced, so an install that changes what
// the checkout carries is followed. A name that is a real file or directory is
// refused: the harness would read it instead of the checkout's, and an agent
// whose guidance is something nobody installed is not the agent the declaration
// describes.
export function linkGuidance({ work, checkout, log = () => {} }) {
  if (!fs.existsSync(work)) {
    throw new RuntimeFault(fault('WORK_DIR_ABSENT', work,
      'the work directory is the directory a thread is opened on, and there is nothing at this path',
      'run carbon install, which places the work directory, or pass --work at a path that exists'));
  }
  const linked = [];
  for (const name of GUIDANCE_NAMES) {
    const at = path.join(work, name);
    const target = path.join(checkout, name);
    let existing = null;
    try { existing = fs.lstatSync(at); } catch { existing = null; }
    if (existing && !existing.isSymbolicLink()) {
      throw new RuntimeFault(fault('GUIDANCE_NAME_OCCUPIED', at,
        `${name} in the work directory is a real ${existing.isDirectory() ? 'directory' : 'file'}, and the harness would read it instead of the one in the checkout`,
        'remove it from the work directory; an agent\'s guidance is changed by a commit and an install, never by a file written beside it'));
    }
    if (!fs.existsSync(target)) {
      if (existing) fs.unlinkSync(at);
      continue;
    }
    if (existing && fs.readlinkSync(at) === target) {
      linked.push(name);
      continue;
    }
    if (existing) fs.unlinkSync(at);
    fs.symlinkSync(target, at);
    linked.push(name);
  }
  log({ event: 'guidance.linked', work, checkout, names: linked });
  return linked;
}

export function readDeclaration(file) {
  if (!fs.existsSync(file)) {
    throw new RuntimeFault(fault('DECLARATION_ABSENT', file,
      'there is no declaration at this path, and the runtime reads every value it uses from one',
      'run carbon install, which renders the declaration into the agent directory'));
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RuntimeFault(fault('DECLARATION_UNREADABLE', file, error.message,
      'the declaration is one JSON object; run carbon declaration check against it'));
  }
}

// How the agent authenticates to its model provider, as the declaration says.
//
// Ruled 10 September: a client agent runs on a ChatGPT login and never on an API
// key. Whose account that is depends on the engagement and is not this file's
// business. The login lives in the harness's own auth file under CODEX_HOME,
// written once by a
// device login run as the agent user on the box and refreshed by the harness
// itself. The runtime therefore passes nothing: it does not read that file, does
// not copy it, and does not put a credential in this process's environment.
//
// `auth: api_key` remains, because a client mandating their own API account is a
// thing that will happen and the carrier is one field. On that path the runtime
// reads the file `api_key_ref` names and passes it to the app-server child alone.
//
// The variable a key arrives under is the provider's own, which is why the mapping
// is here and not in the declaration: a client repository does not get to name an
// environment variable in this process.
const PROVIDER_KEY_ENV = { openai: 'OPENAI_API_KEY' };

export const PROVIDER_AUTH = ['chatgpt', 'api_key'];

// Returns the key file and the variable to pass it under, or null when the
// harness authenticates itself.
export function providerKey(declaration) {
  const provider = declaration.provider ?? {};
  if (provider.auth === 'chatgpt') return null;
  if (provider.auth !== 'api_key') {
    throw new RuntimeFault(fault('PROVIDER_AUTH_UNKNOWN', String(provider.auth),
      `a client agent authenticates by ${PROVIDER_AUTH.join(' or ')}, and this declaration says something else`,
      `declare provider.auth as ${PROVIDER_AUTH.join(' or ')}`));
  }
  const name = PROVIDER_KEY_ENV[provider.name];
  if (!name) {
    throw new RuntimeFault(fault('PROVIDER_UNKNOWN', String(provider.name),
      `this runtime knows how to pass a key to ${Object.keys(PROVIDER_KEY_ENV).join(', ')} and not to ${JSON.stringify(provider.name)}`,
      'name a provider this runtime carries, or add the provider to the runtime and pin a new release'));
  }
  const secret = (declaration.secrets ?? []).find((s) => s.name === provider.api_key_ref);
  if (!secret) {
    throw new RuntimeFault(fault('SECRET_REF_UNDECLARED', 'provider.api_key_ref',
      `no secret named ${JSON.stringify(provider.api_key_ref)} is declared`,
      'declare the provider key as a secret with its absolute path'));
  }
  return { path: secret.path, env: name };
}

export function harnessBinary(declaration, { harnessRoot, binary }) {
  if (binary) return binary;
  const version = declaration.harness?.version;
  const at = path.join(harnessRoot, String(version), 'codex');
  if (!fs.existsSync(at)) {
    throw new RuntimeFault(fault('HARNESS_BINARY_ABSENT', at,
      `the declaration pins harness version ${JSON.stringify(version)} and no binary is unpacked at that path`,
      'run carbon install, which fetches, verifies and unpacks the pinned release'));
  }
  return at;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The child dying mid-turn arrives as this fault rather than as a completion,
// which is the harness's rule: a process exit is never a turn's completion.
function isChildExit(error) {
  return error?.fault?.code === 'HARNESS_CHILD_EXITED_MID_TURN'
    || error?.faults?.some?.((f) => f.code === 'HARNESS_CHILD_EXITED_MID_TURN');
}

// Runs the agent. Returns an exit code; it does not call process.exit, so a test
// can run it and read the answer.
export async function run(options) {
  const {
    declaration, declarationPath, storeDir, codexHome, checkout, work, harnessRoot,
    binary = null, replyPort = REPLY_PORT,
    harness, adapters = null, items = () => [],
    passes = Infinity, log = () => {}, now = () => Date.now()
  } = options;

  const store = Store.open(storeDir);
  refuseIfLatched(store);

  const channels = declaration.channels ?? [];
  if (channels.length === 0) {
    throw new RuntimeFault(fault('NO_CHANNEL_DECLARED', declaration.agent?.id ?? 'agent',
      'the declaration names no channel, so nothing would ever reach this agent',
      'declare the channel the agent works on, or do not start a runtime for it'));
  }

  const loaded = [];
  const intervalFaults = [];
  for (const declaredChannel of channels) {
    const channel = resolveChannel(declaration, declaredChannel);
    const adapter = adapters?.[channel.kind] ?? await loadAdapter(channel.kind);
    // The interval every channel is polled at, decided once, at start, against
    // the adapter's own floor. It is a refusal rather than a correction, and it
    // happens before a socket is opened: a declaration that would earn a day's
    // rate limit must not run for a minute first.
    const { interval_ms, fault: named } = pollIntervalFor(channel, adapter);
    if (named) intervalFaults.push(named);
    loaded.push({ channel, adapter, interval_ms });
  }
  if (intervalFaults.length > 0) throw new RuntimeFault(intervalFaults);

  const locks = [];
  const toolServers = [];
  let reply = null;
  let session = null;
  const stop = async () => {
    if (reply) await reply.close();
    stopToolServers(toolServers);
    for (const lock of locks) releaseLock(lock.file);
    if (session && typeof session.stop === 'function') await session.stop();
  };

  try {
    for (const { channel } of loaded) {
      const lock = takeLock(storeDir, `${channel.kind}:${channel.account}`);
      locks.push(lock);
      if (lock.taken_over) {
        log({ event: 'lock.taken_over', channel: channel.kind, account: channel.account, previous: lock.previous });
      }
    }

    // Before the harness is started, because the guidance it loads is read when a
    // thread is opened on the work directory and there is no second chance at it.
    linkGuidance({ work, checkout, log });

    toolServers.push(...startToolServers(declaration, { declarationPath }));
    for (const server of toolServers) log({ event: 'tool_server.started', name: server.name, url: server.url });

    // The servers this process does not start. They run under their own units as
    // the tools user, so what there is to do here is wait for the address the
    // declaration names to answer before the first turn asks the harness to
    // connect to it. One that never answers is reported and the process carries
    // on: the agent still has to read its mailbox, and a required server that is
    // not connected holds release by name.
    await awaitToolServers(declaration, { log });

    reply = await serveReplyTool({ store, agent: declaration.agent?.id, port: replyPort });
    log({ event: 'reply_tool.listening', url: reply.url });

    // Nothing is passed on the ChatGPT path. The harness reads its own auth file
    // out of CODEX_HOME and refreshes it there, which is why that directory is
    // writable by the agent user and why install checks the file's presence and
    // never its contents.
    const key = providerKey(declaration);
    session = await harness.connect({
      binary: harnessBinary(declaration, { harnessRoot, binary }),
      codexHome,
      providerKeyPath: key?.path,
      providerKeyEnvName: key?.env,
      onEvent: (event) => log({ event: 'harness', kind: event.kind, thread_id: event.threadId, turn_id: event.turnId }),
      onStderr: () => {}
    });

    // The child dying is the end of this process. The pair is one unit; systemd
    // restarts both, and the store says what the restart owes.
    let childExit = null;
    session.exit.then((exit) => { childExit = exit; });

    const loops = loaded.map(({ channel, adapter, interval_ms }) => {
      const loop = new ReleaseLoop({
        declaration, channel, store, storeDir, adapter, harness, session,
        agent: declaration.agent?.id, checkout, work, log, now
      });
      loop.intervalMs = interval_ms;
      if (harness.onToolServerStatus) {
        harness.onToolServerStatus(session, () => { loop.toolStatusStale = true; });
      }
      return loop;
    });

    for (const loop of loops) loop.recovering = loop.recover();

    // Each channel keeps its own next-due time, because two channels on one agent
    // are two different providers with two different floors and one sleep across
    // both would poll the slower one too often or the faster one too rarely.
    // Every channel is due at the first sweep; after that, a channel is polled
    // when its own interval has passed and the process sleeps until whichever is
    // due first.
    const dueAt = new Map(loops.map((loop) => [loop, 0]));
    let done = 0;
    while (done < passes) {
      if (childExit) break;
      for (const loop of loops) {
        if (dueAt.get(loop) > now()) continue;
        try {
          await loop.pass(items(loop.channel));
        } catch (error) {
          if (!isChildExit(error)) throw error;
          childExit = childExit ?? { code: null, signal: 'unknown' };
          break;
        }
        dueAt.set(loop, now() + loop.intervalMs);
        if (childExit) break;
      }
      done += 1;
      if (done < passes && !childExit) {
        await sleep(Math.max(0, Math.min(...loops.map((loop) => dueAt.get(loop))) - now()));
      }
    }

    if (childExit) {
      report([fault('HARNESS_CHILD_EXITED', String(declaration.harness?.version),
        `the app-server exited with code ${childExit.code} signal ${childExit.signal}`,
        'the unit restarts the pair; the store says what the restart owes')]);
      return EXIT.HARNESS_EXITED;
    }
    return EXIT.OK;
  } finally {
    await stop();
  }
}
