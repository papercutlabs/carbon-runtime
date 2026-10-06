// shape: justified this existing runtime composition point coordinates store, harness, channels, tools and the typed browser turn preparation contract
import type { BrowserPreparation } from './browser.ts';
import type { Declaration, Channel, Log, Harness, Session, ChildExit } from './types.ts';
type RunOptions<S extends Session> = { declaration: Declaration; declarationPath: string; storeDir: string; codexHome: string; checkout: string; work: string; harnessRoot: string; binary?: string | null; replyPort?: number; teachPort?: number; harness: Harness<S>; adapters?: Record<string, object> | null; items?: (channel: Channel) => unknown; passes?: number; log?: Log; now?: () => number; sandboxDeny?: SandboxDenyGate; store?: Store; prepareBrowserTurn?: BrowserPreparation };

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
import { Store } from '../stream/store.ts';
import { fault, report, RuntimeFault, EXIT } from './faults.ts';
import { refuseIfLatched } from './latch.ts';
import { takeLock, releaseLock } from './lock.ts';
import { loadAdapter } from './registry.ts';
import { startToolServers, stopToolServers, awaitToolServers, answers } from './tool-servers.ts';
import { serveReplyTool, REPLY_PORT } from './reply-tool.ts';
import { serveTeachTool, TEACH_PORT } from './teach-tool.ts';
import { ReleaseLoop, SANDBOX_DENY_FILE, checkSandboxDeny, ProviderAccountRecorder } from './loop.ts';
import type { SandboxDenyGate } from './loop.ts';
import { pollIntervalFor } from './poll.ts';
import { resolveChannel } from './channel.ts';

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
export function placesUnder(agentDir: string) {
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

function copyResolved(from: string, to: string, name: string, depth = 0) {
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

export function placeGuidance({ work, checkout, log = () => {} }: { work: string; checkout: string; log?: Log }) {
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

export function readDeclaration(file: string): unknown {
  if (!fs.existsSync(file)) {
    throw new RuntimeFault(fault('DECLARATION_ABSENT', file,
      'there is no declaration at this path, and the runtime reads every value it uses from one',
      'run carbon install, which renders the declaration into the agent directory'));
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RuntimeFault(fault('DECLARATION_UNREADABLE', file, (error as { message?: unknown }).message, // Read the thrown message field verbatim; no string guarantee is made.
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
const PROVIDER_KEY_ENV: Record<string, string> = { openai: 'OPENAI_API_KEY' };

export const PROVIDER_AUTH = ['chatgpt', 'api_key'];

// Returns the key file and the variable to pass it under, or null when the
// harness authenticates itself.
export function providerKey(declaration: Declaration) {
  const provider = declaration.provider ?? {};
  if (provider.auth === 'chatgpt') return null;
  // The key reaches the provider through the tools-user proxy (PA-259). The
  // app-server is configured with a keyless provider on the proxy's loopback port,
  // and this process never opens the key file, which the agent user cannot read.
  if (provider.auth === 'api_key' && provider.api_key_via) return null;
  if (provider.auth !== 'api_key') {
    throw new RuntimeFault(fault('PROVIDER_AUTH_UNKNOWN', String(provider.auth),
      `a client agent authenticates by ${PROVIDER_AUTH.join(' or ')}, and this declaration says something else`,
      `declare provider.auth as ${PROVIDER_AUTH.join(' or ')}`));
  }
// Preserve lookup of absent or inherited keys; no provider normalization occurs.
  const name = PROVIDER_KEY_ENV[provider.name!];
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

export function harnessBinary(declaration: Declaration, { harnessRoot, binary }: { harnessRoot: string; binary?: string | null }) {
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

// A sleep the stop signal can cut short. `wake` is handed the way to end it
// early, and is handed null again once it has ended either way.
function sleep(ms: number, wake: (end: (() => void) | null) => void) {
  return new Promise<void>((resolve) => {
    let ended = false;
    const end = () => { if (ended) return; ended = true; if (timer) clearTimeout(timer); wake(null); resolve(); };
    const timer = Number.isFinite(ms) ? setTimeout(end, ms) : null;
    wake(end);
  });
}

// The child dying mid-turn arrives as this fault rather than as a completion,
// which is the harness's rule: a process exit is never a turn's completion.
function isChildExit(error: unknown) {
  // Only the existing optional reads are assumed for arbitrary thrown values.
  const fields = error as { fault?: { code?: unknown }; faults?: { some?: (test: (fault: { code?: unknown }) => boolean) => boolean } } | null | undefined;
  return fields?.fault?.code === 'HARNESS_CHILD_EXITED_MID_TURN'
    || fields?.faults?.some?.((f) => f.code === 'HARNESS_CHILD_EXITED_MID_TURN');
}

// Runs the agent. Returns an exit code; it does not call process.exit, so a test
// can run it and read the answer.
export async function run<S extends Session>(options: RunOptions<S>) {
  const {
    declaration, declarationPath, storeDir, codexHome, checkout, work, harnessRoot,
    binary = null, replyPort = REPLY_PORT, teachPort = TEACH_PORT,
    harness, adapters = null, items = () => [],
    passes = Infinity, log = () => {}, now = () => Date.now(),
    // On a box the agent directory is the parent of codex-home, and the file is root's.
    sandboxDeny = { file: SANDBOX_DENY_FILE, root: path.dirname(path.resolve(codexHome)), ownerUid: 0 }
  } = options;

  const store = options.store ?? Store.open(storeDir);
  if (store.dir !== path.resolve(storeDir)) throw new RuntimeFault(fault('BROWSER_STORE_MISMATCH', storeDir, 'injected Store does not name the declared store directory', 'pass the same owned Store to runtime and browser bridge'));
  if (declaration.channels?.some((channel) => channel.kind === 'browser')) sandboxDeny.browser = true;
  refuseIfLatched(store);

  const channels = declaration.channels ?? [];
  if (channels.length === 0) {
    throw new RuntimeFault(fault('NO_CHANNEL_DECLARED', declaration.agent?.id ?? 'agent',
      'the declaration names no channel, so nothing would ever reach this agent',
      'declare the channel the agent works on, or do not start a runtime for it'));
  }

  const loaded: { channel: Channel; adapter: object; interval_ms: number | null }[] = [];
  const intervalFaults = [];
  for (const declaredChannel of channels) {
    // Resolution keeps raw transport overrides; this is the existing runtime operation contract.
    const channel = resolveChannel(declaration, declaredChannel) as Channel;
    const adapter = adapters?.[channel.kind] ?? await loadAdapter(channel.kind);
    // The interval every channel is polled at, decided once, at start, against
    // the adapter's own floor. It is a refusal rather than a correction, and it
    // happens before a socket is opened: a declaration that would earn a day's
    // rate limit must not run for a minute first.
    // Loaded adapters are dynamic; only the optional floor property is read here,
    // and pollIntervalFor keeps its existing behavior for a malformed floor.
    const { interval_ms, fault: named } = pollIntervalFor(channel, adapter as { POLL_INTERVAL_FLOOR_MS?: number });
    if (named) intervalFaults.push(named);
    loaded.push({ channel, adapter, interval_ms });
  }
  if (intervalFaults.length > 0) throw new RuntimeFault(intervalFaults);

  let unsubscribeBrowser: (() => void) | null = null;
  const locks: ReturnType<typeof takeLock>[] = [];
  const toolServers: ReturnType<typeof startToolServers> = [];
  let reply: Awaited<ReturnType<typeof serveReplyTool>> | null = null;
  let teach: Awaited<ReturnType<typeof serveTeachTool>> | null = null;
  let session: S | null = null;
  // PA-259: which provider account the harness runs on, recorded to the store
  // from this session and never from a second process on the login.
  const version = declaration.harness?.version;
  const providerAccount = new ProviderAccountRecorder<S>({
    storeDir, codexHome, harness, codexVersion: version === undefined || version === null ? null : String(version), log, now
  });
  const stop = async () => {
    unsubscribeBrowser?.();
    providerAccount.close();
    if (reply) await reply.close();
    if (teach) await teach.close();
    stopToolServers(toolServers);
    // An adapter that keeps something running between passes — a long poll, a
    // connection — has an ending, and this is where it is called. Without it a
    // run that has done its work and returned does not exit, because a pending
    // call keeps the process alive; on a box that is invisible, and off one it is
    // a command that never comes back.
    for (const { channel, adapter } of loaded) {
      // Optional adapter stop is used only after the existing callable check.
      const operation = adapter as { stop?: (context: { store: Store; agent?: string; account: string; channel: Channel }) => unknown };
      if (typeof operation.stop !== 'function') continue;
      try {
        await operation.stop({ store, agent: declaration.agent?.id, account: channel.account, channel });
      } catch (error) {
        log({ event: 'adapter.stop_failed', channel: channel.kind, account: channel.account,
          problem: (error as { message?: unknown } | null)?.message ?? String(error) }); // Read the thrown message field verbatim; no string guarantee is made.
      }
    }
    for (const lock of locks) releaseLock(lock.file);
    if (session && typeof session.stop === 'function') await session.stop();
  };

  // PA-322: a stop is a drain. On SIGTERM, which is what `systemctl stop` sends
  // this process alone under KillMode=mixed, or on SIGINT, no new pass or
  // release starts, the release in progress finishes with its turns, and the
  // pass delivers what it has before it ends. A conversation the pass had not
  // yet released stays captured and is released after the restart. The sleep
  // between passes ends at once, and the run returns through the `finally` like
  // any other ending, so stop() closes what it always closes and the exit is 0.
  // Without a handler Node dies on the signal: the `finally` never runs, the turn
  // in flight is re-issued on the next start, and a claimed send can be left
  // `unknown`. A second signal changes nothing; systemd's TimeoutStopSec is the
  // ceiling, and past it the unit is killed. The handlers are registered before
  // the harness starts, so a stop during start-up is a drain too, and removed
  // when run() returns, so a caller that runs it twice does not collect them.
  const draining: { signal: NodeJS.Signals | null; since: number; wake: (() => void) | null } = {
    signal: null, since: 0, wake: null
  };
  const onStopSignal = (signal: NodeJS.Signals) => {
    if (draining.signal) return;
    draining.signal = signal;
    draining.since = performance.now();
    log({ event: 'drain.signal', signal });
    draining.wake?.();
  };
  process.on('SIGTERM', onStopSignal);
  process.on('SIGINT', onStopSignal);

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

    // The declaration goes to the reply tool because one room's replies are held:
    // a reply written in the management conversation waits where it is until the
    // runtime has asked the turn what it recorded. Every other conversation is
    // untouched by it.
    // Core checks installed declarations for agent.id; this launch path forwards
    // the declared value without validating it again.
    reply = await serveReplyTool({ store, agent: declaration.agent?.id!, declaration, work, port: replyPort });
    log({ event: 'reply_tool.listening', url: reply.url });

    // The teaching tools, on the declaration's word and on nothing else. With
    // teaching.enabled false, or the block absent, no server is started, the
    // harness is told about none, and nothing else about this process changes.
    if (declaration.teaching?.enabled === true) {
      teach = await serveTeachTool({
        store, agent: declaration.agent?.id!, declaration, port: teachPort
      });
      log({ event: 'teach_tool.listening', url: teach.url });
    }

    // Nothing is passed on the ChatGPT path. The harness reads its own auth file
    // out of CODEX_HOME and refreshes it there, which is why that directory is
    // writable by the agent user and why install checks the file's presence and
    // never its contents.
    const key = providerKey(declaration);
    // HC-14 (PA-259): no harness starts on a box whose deny file is not exactly placed.
    checkSandboxDeny(sandboxDeny, 'before the harness started');
    session = await harness.connect({
      binary: harnessBinary(declaration, { harnessRoot, binary }),
      codexHome,
      providerKeyPath: key?.path,
      providerKeyEnvName: key?.env,
      onEvent: (event) => {
        log({ event: 'harness', kind: event.kind, thread_id: event.threadId, turn_id: event.turnId });
        providerAccount.accept(event);
      },
      onStderr: () => {}
    });

    // The child dying is the end of this process. The pair is one unit; systemd
    // restarts both, and the store says what the restart owes.
    let childExit: ChildExit | null = null;
    session.exit.then((exit) => { childExit = exit; });

    // Read once the harness is up. Asking returns at once, the read starts on a
    // later tick, and nothing waits for it.
    providerAccount.attach(session);
    providerAccount.request('connect');

    let wakeBrowserDrain: ((loop: ReleaseLoop<S>) => void) | null = null;
    const loops = loaded.map(({ channel, adapter, interval_ms }) => {
      const loop = new ReleaseLoop({
        declaration, channel, store, storeDir, adapter, harness, session: session!, sandboxDeny,  // connect completed before this callback captures the session; closure narrowing cannot establish that ordering.
        agent: declaration.agent?.id!, checkout, work, teach, log, now, // The caller supplies the declared id; the existing Store boundary retains responsibility for rejecting invalid values.
        afterTurn: () => { providerAccount.request('turn'); },
        prepareBrowserTurn: options.prepareBrowserTurn,
        // A drain finishes the release in progress and starts no other.
        stopping: () => draining.signal !== null,
        // The provider proxy's port probe (PA-259). Without one the loop holds release.
        probe: answers
      });
      // Interval faults were refused before any loop was created.
      loop.intervalMs = interval_ms!;
      if (harness.onToolServerStatus) {
        // The harness connection assigned session before this status callback is registered.
        harness.onToolServerStatus(session!, () => {
          loop.toolStatusStale = true;
          if (loop.channel.kind === 'browser') wakeBrowserDrain?.(loop);
        });
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
    const browserGeneration = new Map(loops.map((loop) => [loop, 0]));
    wakeBrowserDrain = (loop) => {
      browserGeneration.set(loop, browserGeneration.get(loop)! + 1);
      dueAt.set(loop, 0);
      draining.wake?.();
    };
    // Browser input is already captured through the shared Store. New inbound
    // capture wakes this drain; it never runs an empty periodic channel poll.
    unsubscribeBrowser = store.subscribeBrowserChanges((event) => {
      if (event.kind !== 'capture' || event.direction !== 'inbound') return;
      for (const loop of loops) {
        if (loop.channel.kind !== 'browser') continue;
        if (!event.conversation_id.startsWith(`${loop.channel.account}:ticket:`)) continue;
        browserGeneration.set(loop, browserGeneration.get(loop)! + 1);
        dueAt.set(loop, 0);
      }
      draining.wake?.();
    });
    let done = 0;
    while (done < passes) {
      if (childExit || draining.signal) break;
      for (const loop of loops) {
        if (draining.signal) break;
        if (dueAt.get(loop)! > now()) continue; // dueAt contains every loop and entries are never removed.
        const generation = browserGeneration.get(loop)!;
        try {
          await loop.pass(items(loop.channel));
        } catch (error) {
          if (!isChildExit(error)) throw error;
          childExit = childExit ?? { code: null, signal: 'unknown' };
          break;
        }
        dueAt.set(loop, loop.channel.kind === 'browser'
          ? browserGeneration.get(loop)! === generation ? Infinity : 0
          : now() + loop.intervalMs!); // Every scheduled loop received its checked interval before this sweep.
        if (childExit) break;
      }
      done += 1;
      if (done < passes && !childExit && !draining.signal) {
        await sleep(Math.max(0, Math.min(...loops.map((loop) => dueAt.get(loop)!)) - now()), (end) => { draining.wake = end; }); // dueAt was initialized for every loop above and entries are never removed.
      }
    }

    if (childExit) {
      report([fault('HARNESS_CHILD_EXITED', String(declaration.harness?.version),
        `the app-server exited with code ${(childExit as ChildExit).code} signal ${(childExit as ChildExit).signal}`, // Only the exit callback or caught child-exit path assigns this value; preserve the original event fields.
        'the unit restarts the pair; the store says what the restart owes')]);
      return EXIT.HARNESS_EXITED;
    }
    return EXIT.OK;
  } finally {
    try {
      await stop();
    } finally {
      process.off('SIGTERM', onStopSignal);
      process.off('SIGINT', onStopSignal);
      if (draining.signal) {
        log({ event: 'drain.completed', signal: draining.signal, elapsed_ms: Math.round(performance.now() - draining.since) });
      }
    }
  }
}
