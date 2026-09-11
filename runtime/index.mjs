// The runtime process: the one thing a unit starts.
//
// It spawns the pinned harness as its direct child and exits non-zero if that
// child exits, so systemd restarts the pair together in one cgroup. It starts the
// tool servers that run as the agent user, and waits for the ones that run under
// their own unit as the tools user. It hosts the adapters in this process, takes
// one lock per adapter, and runs the release loop. It serves
// the `reply` tool on loopback, and the `teach` tools beside it when the
// declaration turns the teaching path on. It refuses to start when the store is latched, and
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
import { serveTeachTool, TEACH_PORT } from './teach-tool.mjs';
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
// Verified against the pinned binary on 11 September (runtime/proofs/
// 20260911-thread-cwd.md): with `cwd` set to a directory holding neither, the
// rendered prompt carries no guidance and lists no skill.
export const GUIDANCE_NAMES = ['AGENTS.md', '.agents'];

// Places the checkout's guidance in the work directory, and returns the names it
// placed.
//
// A copy and not a symlink, which was the first shape and does not survive the
// sandbox. The harness's Linux sandbox binds the guidance read-only inside the
// turn's namespace, and bubblewrap cannot bind a path that is a symlink into a
// read-only tree: it resolves the source outside the namespace and then fails to
// find the destination inside it, with `Can't bind mount <checkout>/.agents on
// <work>/.agents: Unable to mount source on destination: No such file or
// directory`, and the shell dies before it runs anything — the same class of
// failure as PA-181 itself, one step along. What stands in the work directory has
// to be real.
//
// The checkout stays the authority all the same. These two names belong to the
// runtime: it deletes whatever is at them and writes them again from the checkout
// at every start, and an install always restarts the unit, so the copy cannot
// drift from what was installed and nothing a turn writes there outlives the run.
// The runtime places them rather than install because the work directory is the
// agent user's own and the on-box half of install is root-owned.
// A copy that follows every symlink it meets, at any depth, because a symlink
// anywhere inside is the same wall the sandbox hits. `fs.cpSync` with
// `dereference` follows only the path it was given, so this walks it by hand. The
// depth cap is what a symlink pointing at its own parent would otherwise do to
// this process.
const MAX_GUIDANCE_DEPTH = 64;

function copyResolved(from, to, name, depth = 0) {
  if (depth > MAX_GUIDANCE_DEPTH) {
    throw new RuntimeFault(fault('GUIDANCE_TOO_DEEP', from,
      `${name} in the checkout nests more than ${MAX_GUIDANCE_DEPTH} directories deep, which is what a symlink pointing back at its own parent looks like`,
      'straighten the directory out in the client repository, and install again'));
  }
  const stat = fs.statSync(from);
  if (!stat.isDirectory()) {
    fs.copyFileSync(from, to);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    copyResolved(path.join(from, entry), path.join(to, entry), name, depth + 1);
  }
}

export function placeGuidance({ work, checkout, log = () => {} }) {
  if (!fs.existsSync(work)) {
    throw new RuntimeFault(fault('WORK_DIR_ABSENT', work,
      'the work directory is the directory a thread is opened on, and there is nothing at this path',
      'run carbon install, which places the work directory, or pass --work at a path that exists'));
  }
  const placed = [];
  for (const name of GUIDANCE_NAMES) {
    const at = path.join(work, name);
    const target = path.join(checkout, name);
    fs.rmSync(at, { recursive: true, force: true });
    if (!fs.existsSync(target)) continue;
    copyResolved(target, at, name);
    placed.push(name);
  }
  log({ event: 'guidance.placed', work, checkout, names: placed });
  return placed;
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
    binary = null, replyPort = REPLY_PORT, teachPort = TEACH_PORT,
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
  let teach = null;
  let session = null;
  const stop = async () => {
    if (reply) await reply.close();
    if (teach) await teach.close();
    stopToolServers(toolServers);
    // An adapter that keeps something running between passes — a long poll, a
    // connection — has an ending, and this is where it is called. Without it a
    // run that has done its work and returned does not exit, because a pending
    // call keeps the process alive; on a box that is invisible, and off one it is
    // a command that never comes back.
    for (const { channel, adapter } of loaded) {
      if (typeof adapter.stop !== 'function') continue;
      try {
        await adapter.stop({ store, agent: declaration.agent?.id, account: channel.account, channel });
      } catch (error) {
        log({ event: 'adapter.stop_failed', channel: channel.kind, account: channel.account,
          problem: error?.message ?? String(error) });
      }
    }
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
    placeGuidance({ work, checkout, log });

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

    // The teaching tools, on the declaration's word and on nothing else. With
    // teaching.enabled false, or the block absent, no server is started, the
    // harness is told about none, and nothing else about this process changes.
    if (declaration.teaching?.enabled === true) {
      teach = await serveTeachTool({
        store, agent: declaration.agent?.id, declaration, port: teachPort
      });
      log({ event: 'teach_tool.listening', url: teach.url });
    }

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
